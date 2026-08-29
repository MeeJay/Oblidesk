/**
 * routes/index.ts — the API map. Everything under `/api` is mounted here.
 *
 * ── The two tiers ───────────────────────────────────────────────────────────
 * GLOBAL routers run without a tenant: signing in, the SSO callback, the
 * platform configuration a master admin edits, the system page. They authorise
 * themselves.
 *
 * TENANT routers run behind `requireAuth` + `requireTenant`, which means by the
 * time any of their handlers execute, `req.tenantId` is resolved, membership is
 * proven, and `req.scoped(table)` is bound to that tenant. A handler in this
 * tier cannot name a tenant id, and therefore cannot name the wrong one
 * (HARD RULE 1). Mounting a tenant-data router in the global tier is a defect,
 * not a shortcut — `req.scoped` would be undefined and every query would throw.
 *
 * ── The contract with the other route modules ───────────────────────────────
 * Every `*.routes.ts` file in this directory exports its router as the DEFAULT
 * export (`export default router`) and mounts its paths relative to the prefix
 * given below — `tickets.routes.ts` defines `/` and `/:id`, not `/tickets` and
 * `/tickets/:id`. Order inside a tier matters where prefixes nest: the more
 * specific mount comes first, which is why `/profile/2fa` precedes `/profile`.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { apiNotFound } from '../middleware/errorHandler';
import { ingestLimiter } from '../middleware/rateLimiter';

// ── Identity, session and platform administration ───────────────────────────
import authRoutes from './auth.routes';
import obligateCallbackRoutes from './obligateCallback.routes';
import twoFactorRoutes from './twoFactor.routes';
import appConfigRoutes from './appConfig.routes';
import systemRoutes from './system.routes';
import tenantsRoutes from './tenants.routes';

// ── Machine-to-machine ──────────────────────────────────────────────────────
import alertsRoutes from './alerts.routes';

// ── Tenant-scoped ───────────────────────────────────────────────────────────
import usersRoutes from './users.routes';
import teamsRoutes from './teams.routes';
import permissionSetsRoutes from './permissionSets.routes';
import profileRoutes from './profile.routes';
import settingsRoutes from './settings.routes';
import auditRoutes from './audit.routes';
import ticketsRoutes from './tickets.routes';
import journalRoutes from './journal.routes';
import attachmentsRoutes from './attachments.routes';
import configObjectsRoutes from './configObjects.routes';
import viewsRoutes from './views.routes';
import dashboardRoutes from './dashboard.routes';
import metricsRoutes from './metrics.routes';

const router = Router();

// ═════════════════════════════════════════════════════════════════════════════
// Tier 1 — global (no tenant required)
// ═════════════════════════════════════════════════════════════════════════════

// Local sign-in, sign-out, /me, password reset.
router.use('/auth', authRoutes);
// Obligate SSO: the token exchange, sso-config and connected-apps endpoints.
// (The browser-facing redirect target is mounted at /auth in app.ts, OUTSIDE
// /api, because Obligate redirects the user agent straight to it.)
router.use('/auth', obligateCallbackRoutes);

// TOTP / e-mail OTP enrolment and verification. Mounted BEFORE /profile so the
// more specific prefix wins.
router.use('/profile/2fa', twoFactorRoutes);

// Platform configuration (Obligate gateway, AI provider, 2FA policy) — the
// `app_config` table. Admin-gated inside the router.
router.use('/admin/config', appConfigRoutes);

// Version, health and host diagnostics.
router.use('/system', systemRoutes);

// Tenant CRUD and the tenant switcher. Authorises per action: listing your own
// memberships needs only a session, creating a tenant needs a master admin.
// Both spellings are mounted because the client uses the plural for the
// collection and the singular for "the one I am in".
router.use('/tenants', tenantsRoutes);
router.use('/tenant', tenantsRoutes);

// Alert intake from the sibling apps (Obliguard bans, Obliview outages…).
// Server-to-server, bearer-token authenticated inside the router — there is no
// user behind an alert, so it sits outside both the session and the tenant
// tier. It gets the ingest limiter rather than the anonymous one: an outage
// storm legitimately fires hundreds of alerts a minute, and dropping those is
// exactly when the desk is most needed.
router.use('/alerts', ingestLimiter, alertsRoutes);

// ═════════════════════════════════════════════════════════════════════════════
// Tier 2 — tenant-scoped (requireAuth + requireTenant)
// ═════════════════════════════════════════════════════════════════════════════

const tenantRouter = Router();
tenantRouter.use(requireAuth);
tenantRouter.use(requireTenant);

// Identity and access inside the tenant.
tenantRouter.use('/users', usersRoutes);
tenantRouter.use('/teams', teamsRoutes);
tenantRouter.use('/permission-sets', permissionSetsRoutes);
tenantRouter.use('/profile', profileRoutes);

// Tenant settings and the audit trail.
tenantRouter.use('/settings', settingsRoutes);
tenantRouter.use('/audit', auditRoutes);

// The desk itself.
tenantRouter.use('/tickets', ticketsRoutes);
tenantRouter.use('/journal', journalRoutes);
tenantRouter.use('/attachments', attachmentsRoutes);

// Configuration store and saved views.
//
// Both spellings of the configuration store are mounted, for the same reason
// the tenant router is: the client reaches it under two names. `config.api.ts`
// drives the admin screens through `/config-objects`, while the command
// palette and the composer read published objects straight from
// `/config/:kind` (`/config/statuses`, `/config/priorities`, `/config/macros`).
// One router serves both — `configObjects.routes.ts` defines `/:kind` and
// `/:kind/:slug`, so the prefix is the only thing that differs.
tenantRouter.use('/config-objects', configObjectsRoutes);
tenantRouter.use('/config', configObjectsRoutes);
tenantRouter.use('/views', viewsRoutes);

// Analytics.
tenantRouter.use('/dashboards', dashboardRoutes);
tenantRouter.use('/metrics', metricsRoutes);

router.use('/', tenantRouter);

// Anything still unmatched under /api is a 404 in the API envelope — never the
// SPA's index.html, which would reach the client's axios layer as an
// unparseable "Unexpected token <".
router.use(apiNotFound);

export { router as routes };
export default router;
