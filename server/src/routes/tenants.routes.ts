/**
 * tenants.routes.ts — `/api/tenants`
 *
 * Tenant CRUD and the tenant selector's data.
 *
 * ── Two different audiences, two different gates ──────────────────────────
 * `GET /mine` answers "which tenants may I switch to?" and is available to
 * anyone signed in — it is the tenant selector, and it returns only the
 * tenants the caller can actually reach.
 *
 * Everything else — listing all tenants, creating, editing, deleting — is a
 * PLATFORM administration surface and is gated on `requireRole('admin')`. A
 * tenant admin administers their tenant's contents, not the set of tenants.
 *
 * ── Mounted WITHOUT requireTenant ─────────────────────────────────────────
 * These routes deliberately do not require a selected tenant: a user who has
 * just signed in and has not chosen one yet still needs `GET /mine` to work,
 * and requiring a tenant to ask which tenants exist is a chicken-and-egg the
 * login flow cannot solve.
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth, currentUserId } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { tenantService, normalizeSlug, isValidSlug } from '../services/tenant.service';
import { permissionService } from '../services/permission.service';
import { authService, saveSession } from '../services/auth.service';
import type { TenantSettings } from '@oblidesk/shared';
import { logger } from '../utils/logger';

const router = Router();

interface ActorContext {
  actorId: number;
  ip: string | null;
  userAgent: string | null;
}

/**
 * The acting user. `requireAuth` runs on every route in this file (but NOT
 * `requireTenant` — see the header), so `currentUserId()` is safe and throws
 * loudly rather than yielding a null actor into an audit row.
 */
function actorContext(req: Request): ActorContext {
  return {
    actorId: currentUserId(req),
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ success: false, error });
}

function parseId(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

router.use(requireAuth);

// ═════════════════════════════════════════════════════════════════════════════
// The tenant selector
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/tenants/mine — the tenants this user may act in, with the role and
 * capabilities they hold in each. Declared before `/:id` so the literal path
 * wins over the parameter.
 */
router.get('/mine', async (req, res) => {
  try {
    const userId = currentUserId(req);
    const memberships = await permissionService.getTenantMemberships(userId);
    res.json({ success: true, data: memberships });
  } catch (error) {
    logger.error({ err: error }, 'tenants: memberships failed');
    fail(res, 500, 'Failed to load tenants');
  }
});

/**
 * POST /api/tenants/switch — move the SESSION onto another tenant.
 *
 * The session is the right home for this: it survives a reload and a socket
 * reconnect, and `requireTenant` reads it before anything else. The
 * `X-Tenant-Id` header is a per-request override for a platform admin, not a
 * substitute — a client that falls back to it is snapped back to the session's
 * tenant the moment the session context is adopted again, which reads to the
 * user as the switch silently refusing.
 *
 * Access is checked HERE with `hasTenantAccess`, deliberately the SAME
 * predicate `buildSessionContext` uses. That agreement is the point: the
 * builder silently falls back to the user's default tenant when one is out of
 * reach, which is right for repairing a stale cookie and wrong for an explicit
 * request. Authorising on a WIDER rule than the builder's would leave the
 * session pointing at one tenant and the returned context at another.
 *
 * Declared before `/:id` so the literal path wins over the parameter.
 */
router.post('/switch', async (req, res) => {
  try {
    const userId = currentUserId(req);
    const body = req.body as { tenantId?: unknown } | undefined;
    const tenantId = parseId(String(body?.tenantId ?? ''));
    if (tenantId === null) return fail(res, 400, 'A numeric tenantId is required');

    if (!(await permissionService.hasTenantAccess(userId, tenantId))) {
      // Same answer whether the tenant is unreachable or absent: a switcher
      // must not become a way to enumerate the tenants of an install.
      return fail(res, 403, 'You do not have access to that tenant');
    }

    req.session.currentTenantId = tenantId;
    await saveSession(req);

    const context = await authService.buildSessionContext(userId, tenantId);
    if (!context) return fail(res, 403, 'This account has no tenant access');

    logger.info({ userId, tenantId }, 'tenants: session switched');
    res.json({ success: true, data: context });
  } catch (error) {
    logger.error({ err: error }, 'tenants: switch failed');
    fail(res, 500, 'Failed to switch tenant');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Platform administration
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/tenants — every tenant. Platform admin. */
router.get('/', requireRole('admin'), async (_req, res) => {
  try {
    const tenants = await tenantService.list();
    res.json({ success: true, data: tenants });
  } catch (error) {
    logger.error({ err: error }, 'tenants: list failed');
    fail(res, 500, 'Failed to list tenants');
  }
});

/** GET /api/tenants/:id */
router.get('/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid tenant id');

  try {
    const tenant = await tenantService.getById(id);
    if (!tenant) return fail(res, 404, 'Tenant not found');
    res.json({ success: true, data: tenant });
  } catch (error) {
    logger.error({ err: error }, 'tenants: get failed');
    fail(res, 500, 'Failed to load tenant');
  }
});

/** GET /api/tenants/:id/stats — the counts on the MSP console's tenant card. */
router.get('/:id/stats', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid tenant id');

  try {
    const stats = await tenantService.getStats(id);
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error({ err: error }, 'tenants: stats failed');
    fail(res, 500, 'Failed to load tenant statistics');
  }
});

/** GET /api/tenants/:id/members */
router.get('/:id/members', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid tenant id');

  try {
    const members = await tenantService.getMembers(id);
    res.json({ success: true, data: members });
  } catch (error) {
    logger.error({ err: error }, 'tenants: members failed');
    fail(res, 500, 'Failed to load members');
  }
});

/**
 * POST /api/tenants
 *
 * The slug is normalised server-side and validated before anything is written:
 * it becomes this tenant's identity in every OTHER app in the suite (HARD RULE
 * 13), so a slug with a space or a slash in it breaks a URL in an application
 * that has no idea this one created it.
 */
router.post('/', requireRole('admin'), async (req, res) => {
  const body = req.body as {
    slug?: string;
    name?: string;
    isMaster?: boolean;
    settings?: TenantSettings;
    ownerUserId?: number;
  };

  if (!body.name || body.name.trim().length === 0) return fail(res, 400, 'name is required');
  if (!body.slug) return fail(res, 400, 'slug is required');

  const slug = normalizeSlug(body.slug);
  if (!isValidSlug(slug)) {
    return fail(res, 400, 'slug must be 2-63 lowercase letters, digits and single hyphens');
  }

  try {
    const ctx = actorContext(req);
    const tenant = await tenantService.create(
      {
        slug,
        name: body.name.trim(),
        isMaster: body.isMaster ?? false,
        settings: body.settings,
        // Default the owner to whoever created it, so a new tenant is never
        // born with nobody who can administer it.
        ownerUserId: body.ownerUserId ?? ctx.actorId,
      },
      ctx,
    );
    res.status(201).json({ success: true, data: tenant });
  } catch (error) {
    logger.error({ err: error }, 'tenants: create failed');
    const status = (error as { code?: string })?.code === '23505' ? 409 : 400;
    fail(
      res,
      status,
      status === 409 ? `A tenant with slug "${slug}" already exists` : messageOf(error, 'Failed to create tenant'),
    );
  }
});

/**
 * PUT /api/tenants/:id
 *
 * The SLUG IS NOT UPDATABLE and is ignored if sent: every sibling app stores
 * this tenant by slug, so renaming it here would orphan their CI projections,
 * alert bindings and SSO mappings without any of them noticing.
 */
router.put('/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid tenant id');

  const body = req.body as { name?: string; isMaster?: boolean; settings?: TenantSettings };

  try {
    const ctx = actorContext(req);
    const tenant = await tenantService.update(
      id,
      { name: body.name, isMaster: body.isMaster, settings: body.settings },
      ctx,
    );
    if (!tenant) return fail(res, 404, 'Tenant not found');
    res.json({ success: true, data: tenant });
  } catch (error) {
    logger.error({ err: error }, 'tenants: update failed');
    fail(res, 500, messageOf(error, 'Failed to update tenant'));
  }
});

/**
 * DELETE /api/tenants/:id
 *
 * Requires `?confirmSlug=<slug>`. Every tenant-scoped FK is ON DELETE CASCADE,
 * so this removes tickets, journal, mail, SLA history, the audit chain and the
 * decision log. There is no undo. Re-typing the slug is the same guard GitHub
 * uses before deleting a repository, and for the same reason: an id is easy to
 * fat-finger and impossible to recognise.
 */
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid tenant id');

  const confirmSlug = typeof req.query.confirmSlug === 'string' ? req.query.confirmSlug : '';
  if (!confirmSlug) {
    return fail(res, 400, 'confirmSlug is required — re-type the tenant slug to confirm');
  }

  try {
    const ctx = actorContext(req);
    const deleted = await tenantService.delete(id, confirmSlug, ctx);
    if (!deleted) return fail(res, 404, 'Tenant not found');
    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    logger.error({ err: error }, 'tenants: delete failed');
    fail(res, 400, messageOf(error, 'Failed to delete tenant'));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Membership
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/tenants/by-slug/:slug — the cross-app lookup (HARD RULE 13). */
router.get('/by-slug/:slug', requireRole('admin'), async (req, res) => {
  const slug = req.params.slug;
  if (!slug) return fail(res, 400, 'slug is required');

  try {
    const tenant = await tenantService.getBySlug(slug);
    if (!tenant) return fail(res, 404, 'Tenant not found');
    res.json({ success: true, data: tenant });
  } catch (error) {
    logger.error({ err: error }, 'tenants: by-slug failed');
    fail(res, 500, 'Failed to load tenant');
  }
});

export { router as tenantsRouter };
export default router;
