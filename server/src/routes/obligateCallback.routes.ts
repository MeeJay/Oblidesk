/**
 * obligateCallback.routes.ts — the Obligate SSO round trip, both directions.
 *
 * MOUNTED TWICE, on purpose:
 *   app.use('/auth', obligateCallbackRoutes)     ← browser-facing. Obligate
 *                                                  redirects here and the
 *                                                  client Nginx proxies
 *                                                  `/auth/` to the server.
 *   router.use('/auth', obligateCallbackRoutes)  ← inside `/api`, so the SPA
 *                                                  calls /api/auth/sso-config
 *                                                  and /api/auth/connected-apps.
 * Every handler derives its own absolute URL from `req.baseUrl + req.path`, so
 * both mounts produce a consistent `redirect_uri` and neither needs to know
 * where it was mounted.
 *
 *   outbound (we call Obligate)   /authorize, token exchange, report-provision,
 *                                 connected apps, preferences
 *   inbound  (Obligate calls us)  /app-info, /dashboard-stats, /sso-user-sync,
 *                                 authenticated by the app API key as a Bearer
 *                                 token — the same key we hold for outbound
 *
 * Tenant mapping is BY SLUG, never by a numeric id (HARD RULE 13): tenant 4
 * here and tenant 4 in Obliguard are unrelated rows in unrelated databases.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { db, insertScoped, scoped } from '../db';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { generateToken } from '../utils/crypto';
import { auditService } from '../services/audit.service';
import { appConfigService } from '../services/appConfig.service';
import { obligateService } from '../services/obligate.service';
import type { ObligateUserAssertion } from '../services/obligate.service';
import { permissionService } from '../services/permission.service';
import { tenantService } from '../services/tenant.service';
import { userService } from '../services/user.service';
import {
  authService,
  clientIp,
  clientUserAgent,
  saveSession,
  toUserRole,
} from '../services/auth.service';
import { OPEN_STATUS_CATEGORIES, sanitizeCapabilities } from '@oblidesk/shared';
import { tenantSlugSchema } from '../validators/auth.validators';

const router = Router();

/** The username prefix every Obligate-provisioned account carries. */
const FOREIGN_USERNAME_PREFIX = 'og_';

/**
 * SSO accounts enrol in Obligate, not here, so they are stamped past the local
 * enrolment gate. The sentinel matches the rest of the suite.
 */
const SSO_ENROLLMENT_VERSION = 999;

// ── URL helpers ──────────────────────────────────────────────────────────────

/** This server's public origin, honouring the reverse-proxy headers. */
function selfOrigin(req: Request): string {
  const protocol = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
  return `${protocol}://${host}`;
}

/**
 * The absolute URL of a route on THIS router, whichever prefix it was mounted
 * under. Used for `redirect_uri`, which Obligate claims the code against — a
 * value that differs by one character from the one sent to /authorize is
 * indistinguishable from a replay.
 */
function selfUrlOf(req: Request, path: string): string {
  return `${selfOrigin(req)}${req.baseUrl}${path}`;
}

/** The SPA route the browser lands on when the handshake cannot continue. */
function loginRedirect(error?: string): string {
  return error ? `/login?error=${encodeURIComponent(error)}` : '/login';
}

/**
 * Finish with an HTML meta refresh rather than a 302.
 *
 * The browser must fully process `Set-Cookie` before it navigates; a 302 races
 * that, and the race is lost often enough on Safari and in the ObliTools
 * WebView2 to produce the classic "signed in, then bounced back to /login".
 */
function redirectThroughHtml(res: Response, target: string, label: string): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
      `<meta http-equiv="refresh" content="0;url=${target}">` +
      `<title>${label}</title><style>` +
      `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
      `background:#0b1116;color:#8fa3ad;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}` +
      `.s{text-align:center}.d{width:28px;height:28px;border:2.5px solid #1b2831;border-top-color:#22b8f5;` +
      `border-radius:50%;animation:r .6s linear infinite;margin:0 auto 14px}` +
      `@keyframes r{to{transform:rotate(360deg)}}</style></head>` +
      `<body><div class="s"><div class="d"></div><div>${label}</div></div></body></html>`,
  );
}

/** Obligate → us. The Bearer token must be the app API key we hold for it. */
async function requireObligateBearer(req: Request, res: Response): Promise<boolean> {
  if (await obligateService.verifyInboundBearer(req.headers.authorization)) return true;
  res.status(401).json({
    success: false,
    error: 'Invalid or missing app credentials',
    code: 'unauthenticated',
  });
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Provisioning
// ═══════════════════════════════════════════════════════════════════════════

interface ProvisionResult {
  localUserId: number;
  created: boolean;
  tenantId: number | null;
}

/** Pick a free local username for a freshly provisioned Obligate account. */
async function allocateUsername(assertion: ObligateUserAssertion): Promise<string> {
  const base = `${FOREIGN_USERNAME_PREFIX}${assertion.username}`.slice(0, 64);
  // `users.username` is citext, so this collides case-insensitively — which is
  // exactly what the unique index will do at insert time.
  const taken = await db('users').where({ username: base }).first('id');
  if (!taken) return base;
  // A local account already owns the prefixed name (a renamed user, an Obligate
  // account re-created). Disambiguate with the stable Obligate id.
  return `${base}_${assertion.obligateUserId}`.slice(0, 64);
}

/**
 * Find, update or create the local user behind an Obligate assertion, then
 * mirror the tenant bindings, team memberships, capabilities and preferences.
 *
 * Obligate owns identity AND the platform role: an "All tenants" admin mapping
 * there is a platform admin here. Everything per-tenant is re-mirrored on
 * EVERY login rather than only at provisioning, because a permission removed
 * in Obligate has to take effect at the user's next sign-in — not whenever
 * somebody notices.
 */
async function provisionFromAssertion(
  req: Request,
  assertion: ObligateUserAssertion,
): Promise<ProvisionResult> {
  const platformRole = toUserRole(assertion.role, 'user');
  let localUserId = 0;
  let created = false;

  // ── 1. Resolve the local account ────────────────────────────────────────
  if (assertion.linkedLocalUserId) {
    const existing = (await db('users').where({ id: assertion.linkedLocalUserId }).first('id')) as
      | { id: number }
      | undefined;
    if (existing) {
      localUserId = existing.id;
    } else {
      logger.warn(
        { linkedLocalUserId: assertion.linkedLocalUserId },
        'obligate: the linked local user no longer exists — clearing the link and re-provisioning',
      );
      void obligateService.reportProvision(assertion.obligateUserId, 0);
    }
  }

  if (localUserId === 0) {
    const linked = (await db('users')
      .where({ obligate_user_id: assertion.obligateUserId })
      .first('id')) as { id: number } | undefined;
    if (linked) localUserId = linked.id;
  }

  if (localUserId === 0) {
    const [row] = (await db('users')
      .insert({
        username: await allocateUsername(assertion),
        display_name: assertion.displayName || assertion.username,
        email: assertion.email,
        role: platformRole,
        is_active: true,
        auth_source: 'obligate',
        obligate_user_id: assertion.obligateUserId,
        enrollment_version: SSO_ENROLLMENT_VERSION,
        preferred_language: assertion.preferences?.preferredLanguage || 'en',
        preferences: JSON.stringify({}),
      })
      .returning('id')) as Array<{ id: number }>;
    localUserId = row.id;
    created = true;

    void obligateService.reportProvision(assertion.obligateUserId, localUserId);
    logger.info(
      { localUserId, obligateUserId: assertion.obligateUserId, username: assertion.username },
      'obligate: provisioned a new local user',
    );
  } else {
    await db('users').where({ id: localUserId }).update({
      display_name: assertion.displayName || assertion.username,
      email: assertion.email,
      role: platformRole,
      is_active: true,
      auth_source: 'obligate',
      obligate_user_id: assertion.obligateUserId,
      updated_at: new Date(),
    });
  }

  // ── 2. Tenants, teams and capabilities — all keyed by SLUG ──────────────
  for (const binding of assertion.tenants ?? []) {
    if (typeof binding?.slug !== 'string') continue;

    const tenant = await tenantService.getBySlug(binding.slug);
    if (!tenant) {
      logger.info(
        { slug: binding.slug, localUserId },
        'obligate: the assertion names a tenant that does not exist here — skipped',
      );
      continue;
    }

    const role = toUserRole(binding.role, 'user');

    // `user_tenants.capabilities` is the SSO override lane. It is written ONLY
    // when Obligate actually asserted capabilities, so a binding that carries
    // none leaves a locally-curated override alone instead of erasing it — the
    // mistake a sibling app made and had to undo.
    const assertedCapabilities = Array.isArray(binding.capabilities)
      ? sanitizeCapabilities(binding.capabilities)
      : null;

    if (assertedCapabilities !== null && binding.capabilities!.length !== assertedCapabilities.length) {
      logger.warn(
        { slug: binding.slug, dropped: binding.capabilities!.length - assertedCapabilities.length },
        'obligate: the assertion carried capabilities this app does not define — dropped',
      );
    }

    const row: Record<string, unknown> = { user_id: localUserId, role };
    if (assertedCapabilities !== null) row.capabilities = JSON.stringify(assertedCapabilities);

    await insertScoped('user_tenants', tenant.id, row)
      .onConflict(['user_id', 'tenant_id'])
      .merge(
        assertedCapabilities !== null
          ? { role, capabilities: JSON.stringify(assertedCapabilities) }
          : { role },
      );

    // Teams are matched BY NAME inside this tenant. `assertion.teams` is a flat
    // list of names across every tenant the user belongs to, so the tenant
    // scope is what stops a same-named team elsewhere from granting access
    // here. Additive only: a membership granted locally is never revoked by an
    // SSO login.
    if (assertion.teams?.length) {
      const teamIds = (await scoped('teams', tenant.id)
        .whereIn('name', assertion.teams)
        .pluck('id')) as number[];

      if (teamIds.length > 0) {
        // `team_memberships` has no tenant_id of its own (PARENT_SCOPED); the
        // ids above are already tenant-scoped, and that IS the isolation.
        await db('team_memberships')
          .insert(teamIds.map((team_id) => ({ team_id, user_id: localUserId })))
          .onConflict(['team_id', 'user_id'])
          .ignore();
      } else {
        logger.info(
          { slug: binding.slug, asserted: assertion.teams },
          'obligate: no local team matched the asserted team names',
        );
      }
    }
  }

  // A platform admin reaches every tenant implicitly but still needs somewhere
  // to land, so give them the master tenant. Without it, tenant resolution for
  // an SSO admin depends on whatever tenant happens to have the lowest id.
  if (platformRole === 'admin') {
    const master = await tenantService.getMaster();
    if (master) {
      await insertScoped('user_tenants', master.id, { user_id: localUserId, role: 'admin' })
        .onConflict(['user_id', 'tenant_id'])
        .merge({ role: 'admin' });
    }
  }

  // The permission resolver caches for ten seconds. Without this the session
  // context built two lines below would be resolved from the bindings as they
  // were BEFORE this login — the user would sign in and see yesterday's rights.
  permissionService.invalidate(localUserId);

  // ── 3. Preferences: theme, language, avatar, toasts ─────────────────────
  if (assertion.preferences) {
    try {
      await obligateService.applyPreferences(localUserId, assertion.preferences);
    } catch (err) {
      logger.warn({ err, localUserId }, 'obligate: preference sync failed');
    }
  }

  // ── 4. Session ──────────────────────────────────────────────────────────
  const user = await userService.getById(localUserId);
  if (!user) throw new AppError(500, 'The provisioned user disappeared mid-sign-in');

  const requestedSlug = req.session.requestedTenantSlug;
  // Always cleared: a slug left over from a cross-app pill click must not leak
  // into a later, unrelated sign-in.
  delete req.session.requestedTenantSlug;

  const requestedTenantId = requestedSlug
    ? await authService.resolveTenantSlugForUser(localUserId, requestedSlug)
    : null;

  if (requestedSlug) {
    logger.info(
      { localUserId, slug: requestedSlug, matched: requestedTenantId !== null },
      'obligate: cross-app tenant handoff',
    );
  }

  const tenantId = await authService.establishSession(req, user, requestedTenantId);

  return { localUserId, created, tenantId };
}

// ═══════════════════════════════════════════════════════════════════════════
// Browser flow
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /auth/sso-redirect[?tenant=<slug>]
 *
 * Server-side entry into the flow — the client never sees the API key. The
 * optional `tenant` slug is the cross-app handoff: the topbar switcher in a
 * sibling app appends it so the user lands on the same tenant here.
 */
router.get('/sso-redirect', async (req, res) => {
  try {
    const requested = req.query.tenant;
    if (typeof requested === 'string') {
      const parsed = tenantSlugSchema.safeParse(requested);
      if (parsed.success) {
        req.session.requestedTenantSlug = parsed.data;
      } else {
        logger.info({ requested }, 'sso-redirect: ignoring a malformed tenant slug');
      }
    }

    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey || !raw.enabled) {
      res.redirect(loginRedirect());
      return;
    }

    // Never redirect to ourselves. A mis-typed `obligate_url` pointing at this
    // app produces an infinite bounce with no error anywhere; catching it here
    // turns a mystery into a message.
    const origin = selfOrigin(req);
    if (raw.url.replace(/\/+$/, '') === origin.replace(/\/+$/, '')) {
      logger.error({ obligateUrl: raw.url, origin }, 'sso-redirect: obligate_url points at this app — refusing');
      res.redirect(loginRedirect('sso_misconfigured'));
      return;
    }

    // Check Obligate is up BEFORE bouncing the browser, so a dead gateway shows
    // an error on OUR login page instead of a browser-level failure page.
    const health = await obligateService.getSsoConfig();
    if (!health.obligateReachable) {
      res.redirect(loginRedirect('sso_unreachable'));
      return;
    }

    // RFC 6749 §10.12 — the state token that makes login CSRF detectable.
    const state = generateToken(32);
    req.session.oauthState = state;

    const redirectUri = selfUrlOf(req, '/callback');
    const authorizeUrl =
      `${raw.url}/authorize?client_id=${encodeURIComponent(raw.apiKey)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    // The state must be persisted before the browser leaves, or the callback
    // has nothing to compare against and every sign-in looks like a CSRF.
    await saveSession(req);
    logger.info({ redirectUri }, 'sso-redirect: handing off to Obligate');
    res.redirect(authorizeUrl);
  } catch (err) {
    logger.error({ err }, 'sso-redirect failed');
    res.redirect(loginRedirect('sso_failed'));
  }
});

/**
 * GET /auth/callback?code&state   (alias: /auth/foreign)
 *
 * Obligate sends the browser back here with a one-time code; we exchange it
 * server-to-server, provision, and establish the session.
 */
async function handleCallback(req: Request, res: Response): Promise<void> {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code) {
      res.redirect(loginRedirect('sso_failed'));
      return;
    }

    const expectedState = req.session.oauthState;
    delete req.session.oauthState;

    if (!expectedState || !state || state !== expectedState) {
      logger.warn(
        { hasExpected: Boolean(expectedState), ip: clientIp(req) },
        'obligate callback: state mismatch — possible login CSRF',
      );
      res.redirect(loginRedirect('sso_failed'));
      return;
    }

    // Byte-identical to what was sent to /authorize — see selfUrlOf.
    const redirectUri = selfUrlOf(req, req.path);
    const assertion = await obligateService.exchangeCode(code, redirectUri);
    if (!assertion) {
      logger.warn({ redirectUri }, 'obligate callback: the exchange returned nothing');
      res.redirect(loginRedirect('sso_failed'));
      return;
    }

    const result = await provisionFromAssertion(req, assertion);
    await saveSession(req);

    if (result.tenantId !== null) {
      if (result.created) {
        await auditService.recordSafe({
          tenantId: result.tenantId,
          actorId: result.localUserId,
          actorType: 'system',
          action: 'user.provision',
          entityType: 'user',
          entityId: result.localUserId,
          before: null,
          after: {
            source: 'obligate',
            obligateUserId: assertion.obligateUserId,
            username: assertion.username,
          },
          ip: clientIp(req),
          userAgent: clientUserAgent(req),
        });
      }
      await auditService.recordSafe({
        tenantId: result.tenantId,
        actorId: result.localUserId,
        actorType: 'user',
        action: 'auth.login',
        entityType: 'user',
        entityId: result.localUserId,
        before: null,
        after: { method: 'obligate_sso', obligateUserId: assertion.obligateUserId },
        ip: clientIp(req),
        userAgent: clientUserAgent(req),
      });
    }

    logger.info(
      {
        localUserId: result.localUserId,
        obligateUserId: assertion.obligateUserId,
        tenantId: result.tenantId,
      },
      'obligate: SSO sign-in established',
    );

    redirectThroughHtml(res, '/', 'Signing in...');
  } catch (err) {
    logger.error({ err }, 'obligate callback failed');
    res.redirect(loginRedirect('sso_failed'));
  }
}

router.get('/callback', handleCallback);
/** Alias, so an Obligate registration pointing at `/auth/foreign` also works. */
router.get('/foreign', handleCallback);

// ═══════════════════════════════════════════════════════════════════════════
// Client-facing helpers (reached under /api/auth)
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/auth/sso-config — public: drives the SSO button on the login page. */
router.get('/sso-config', async (_req, res) => {
  try {
    res.json({ success: true, data: await obligateService.getSsoConfig() });
  } catch (err) {
    logger.warn({ err }, 'sso-config failed — reporting SSO as unavailable');
    res.json({
      success: true,
      data: { obligateUrl: null, obligateReachable: false, obligateEnabled: false },
    });
  }
});

/** GET /api/auth/sso-logout-url — where to bounce so the Obligate session dies too. */
router.get('/sso-logout-url', async (req, res) => {
  try {
    res.json({ success: true, data: await obligateService.getLogoutUrl(`${selfOrigin(req)}/login`) });
  } catch {
    res.json({ success: true, data: null });
  }
});

/**
 * GET /api/auth/connected-apps — the app switcher.
 *
 * Scoped to the caller's Obligate entitlements: a local account has no
 * Obligate id and gets the unfiltered list, while an SSO account gets only the
 * apps it can actually open. Never fails the request — a missing switcher is a
 * cosmetic problem, a 500 on every page load is not.
 */
router.get('/connected-apps', requireAuth, async (req, res) => {
  try {
    const row = (await db('users')
      .where({ id: req.session.userId })
      .first('auth_source', 'obligate_user_id')) as
      | { auth_source: string; obligate_user_id: number | null }
      | undefined;

    const obligateUserId =
      row?.auth_source === 'obligate' && row.obligate_user_id ? row.obligate_user_id : null;

    res.json({ success: true, data: await obligateService.getConnectedApps(obligateUserId) });
  } catch (err) {
    logger.warn({ err }, 'connected-apps failed — returning an empty switcher');
    res.json({ success: true, data: [] });
  }
});

/** GET /api/auth/device-links?uuid= — sibling apps installed on this machine. */
router.get('/device-links', requireAuth, async (req, res) => {
  const uuid = typeof req.query.uuid === 'string' ? req.query.uuid : '';
  if (!uuid) {
    res.json({ success: true, data: [] });
    return;
  }
  res.json({ success: true, data: await obligateService.getDeviceLinks(uuid) });
});

// ═══════════════════════════════════════════════════════════════════════════
// Inbound — Obligate calls us (Bearer = the app API key)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/auth/app-info
 * Feeds Obligate's mapping UI: the roles, tenants and teams that exist here,
 * so an operator maps a permission group onto real Oblidesk objects instead of
 * typing strings and hoping.
 */
router.get('/app-info', async (req, res) => {
  if (!(await requireObligateBearer(req, res))) return;

  try {
    const tenants = await tenantService.list();

    // `teams` is tenant-scoped, so this walks the tenants and reads each one
    // through `scoped()`. A single cross-tenant SELECT would be shorter and
    // would also be a bare `db('teams')` — banned by HARD RULE 1 even on an
    // admin-only endpoint, because "just this once" is how isolation rots.
    const teams: Array<{ id: number; name: string; tenantSlug: string; tenantName: string }> = [];
    for (const tenant of tenants) {
      const rows = (await scoped('teams', tenant.id)
        .select('id', 'name')
        .orderBy('name')) as Array<{ id: number; name: string }>;
      for (const row of rows) {
        teams.push({ id: row.id, name: row.name, tenantSlug: tenant.slug, tenantName: tenant.name });
      }
    }

    res.json({
      success: true,
      data: {
        appType: 'oblidesk',
        roles: ['admin', 'manager', 'agent', 'user'],
        tenants: tenants.map((tenant) => ({
          slug: tenant.slug,
          name: tenant.name,
          isMaster: tenant.isMaster,
        })),
        teams,
      },
    });
  } catch (err) {
    logger.error({ err }, 'app-info failed');
    res.status(500).json({ success: false, error: 'Failed to read app info', code: 'internal_error' });
  }
});

/** GET /api/auth/dashboard-stats — the tiles Obligate shows for this app. */
router.get('/dashboard-stats', async (req, res) => {
  if (!(await requireObligateBearer(req, res))) return;

  try {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    const count = (row: unknown): number => Number((row as { c?: string | number } | undefined)?.c ?? 0);

    // Aggregated across every tenant, one tenant at a time: `tickets` and
    // `sla_instances` are tenant-scoped (HARD RULE 1). The tenant count is
    // small and this is a stats tile, not a hot path.
    const tenants = await tenantService.list();
    let open = 0;
    let breached = 0;
    let today = 0;

    for (const tenant of tenants) {
      const [openRow, breachedRow, todayRow] = await Promise.all([
        scoped('tickets', tenant.id)
          .whereIn('status_category', [...OPEN_STATUS_CATEGORIES])
          .count('id as c')
          .first(),
        scoped('sla_instances', tenant.id).where('status', 'breached').count('id as c').first(),
        scoped('tickets', tenant.id).where('created_at', '>=', midnight).count('id as c').first(),
      ]);
      open += count(openRow);
      breached += count(breachedRow);
      today += count(todayRow);
    }

    res.json({
      success: true,
      data: {
        stats: [
          { label: 'Open tickets', value: open, color: '#22b8f5' },
          { label: 'Breached SLAs', value: breached, color: '#f2555a' },
          { label: 'Opened today', value: today, color: '#f0b429' },
        ],
      },
    });
  } catch (err) {
    logger.warn({ err }, 'dashboard-stats failed');
    res.json({ success: true, data: null });
  }
});

/**
 * POST /api/auth/sso-user-sync
 * Obligate pushes lifecycle changes — deactivated, reactivated, deleted,
 * re-roled — so they take effect without waiting for the user's next login.
 *
 * A `delete` DEACTIVATES rather than removing the row. Tickets, journal
 * entries and audit rows point at this user; deleting the actor would rewrite
 * history that has to stay readable, and "who closed this ticket?" must not
 * become unanswerable because an account was tidied up in another app.
 */
router.post('/sso-user-sync', async (req, res) => {
  if (!(await requireObligateBearer(req, res))) return;

  try {
    const { obligateUserId, remoteUserId, action, role } = req.body as {
      obligateUserId?: number;
      remoteUserId?: number;
      action?: 'deactivate' | 'reactivate' | 'delete' | 'update-role';
      role?: string;
    };

    if (!action) {
      res.status(400).json({ success: false, error: 'Missing action', code: 'validation_failed' });
      return;
    }

    let user: { id: number; role: string; is_active: boolean } | undefined;
    if (remoteUserId) {
      user = (await db('users').where({ id: remoteUserId }).first('id', 'role', 'is_active')) as
        | { id: number; role: string; is_active: boolean }
        | undefined;
    }
    if (!user && obligateUserId) {
      user = (await db('users')
        .where({ obligate_user_id: obligateUserId })
        .first('id', 'role', 'is_active')) as
        | { id: number; role: string; is_active: boolean }
        | undefined;
    }

    // An unknown user answers 200: Obligate must not retry forever over an
    // account this app was never asked to provision.
    if (!user) {
      res.json({ success: true, data: { applied: false } });
      return;
    }

    switch (action) {
      case 'deactivate':
      case 'delete':
        await db('users').where({ id: user.id }).update({ is_active: false, updated_at: new Date() });
        logger.info({ userId: user.id, action }, 'obligate: SSO user deactivated');
        break;
      case 'reactivate':
        await db('users').where({ id: user.id }).update({ is_active: true, updated_at: new Date() });
        logger.info({ userId: user.id }, 'obligate: SSO user reactivated');
        break;
      case 'update-role':
        await db('users')
          .where({ id: user.id })
          .update({ role: toUserRole(role, 'user'), updated_at: new Date() });
        logger.info({ userId: user.id, role }, 'obligate: SSO user role updated');
        break;
      default:
        res.status(400).json({ success: false, error: 'Unknown action', code: 'validation_failed' });
        return;
    }

    permissionService.invalidate(user.id);

    const tenantId = await authService.auditTenantFor(user.id);
    if (tenantId !== null) {
      await auditService.recordSafe({
        tenantId,
        actorId: null,
        actorType: 'system',
        action: `user.sso_${action.replace('-', '_')}`,
        entityType: 'user',
        entityId: user.id,
        before: { role: user.role, isActive: user.is_active },
        after: { action, role: role ?? user.role },
        ip: clientIp(req),
        userAgent: clientUserAgent(req),
      });
    }

    res.json({ success: true, data: { applied: true } });
  } catch (err) {
    logger.error({ err }, 'sso-user-sync failed');
    res.status(500).json({ success: false, error: 'Sync failed', code: 'internal_error' });
  }
});

export default router;
