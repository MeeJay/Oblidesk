/**
 * routes/index.ts — the API map. Everything under `/api` is mounted here.
 *
 * ── The two tiers ───────────────────────────────────────────────────────────
 * GLOBAL routers run without a tenant: signing in, the SSO callback, the
 * platform configuration a master admin edits, the system page, the
 * server-to-server ingests, and the requester portal. They authorise
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

// ── Self-authorising: a provider webhook, and the requester portal ──────────
import mailRoutes from './mail.routes';
import portalRoutes from './portal.routes';

// ── Tenant-scoped ───────────────────────────────────────────────────────────
import usersRoutes from './users.routes';
import teamsRoutes from './teams.routes';
import permissionSetsRoutes from './permissionSets.routes';
import profileRoutes from './profile.routes';
import organizationsRoutes from './organizations.routes';
import portalAdminRoutes from './portalAdmin.routes';
import settingsRoutes from './settings.routes';
import auditRoutes from './audit.routes';
import ticketsRoutes from './tickets.routes';
import problemsRoutes from './problems.routes';
import journalRoutes from './journal.routes';
import attachmentsRoutes from './attachments.routes';
import ciRoutes from './ci.routes';
import ciLiveRoutes from './ciLive.routes';
import configObjectsRoutes from './configObjects.routes';
import viewsRoutes from './views.routes';
import dashboardRoutes from './dashboard.routes';
import metricsRoutes from './metrics.routes';
import slaRoutes from './sla.routes';
import rulesRoutes from './rules.routes';
import escalationRoutes from './escalation.routes';
import approvalsRoutes from './approvals.routes';

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

// The mail channel. It is NOT in the session tier, and `mail.routes.ts` says so
// in its own header: `POST /api/mail/webhook` is called server-to-server by a
// provider that has no session and no tenant, exactly like the alert ingest, so
// `requireTenant` in front of it would break intake. Every OTHER route in that
// file therefore carries `requireAuth` + `requireTenant` + a capability of its
// own, applied per route rather than with a `router.use()` at the top.
//
// The ingest bucket is scoped to the webhook PATH rather than to the whole
// mount, which is the one place this differs from `/alerts`. `ingestLimiter` is
// looser than the anonymous default, and `apiLimiter` skips a request that has
// a session — so putting it on `/mail` would quietly make it the only limiter
// on the signed-in mailbox-administration routes.
router.use('/mail/webhook', ingestLimiter);
router.use('/mail', mailRoutes);

// The requester portal. Also outside the session tier, for the reason set out
// at the top of `portal.routes.ts`: a portal contact is not an Oblidesk user.
// They never set `req.session.userId` (so `requireAuth` would 401 every route
// here) and they have no membership row (so `requireTenant` would have nothing
// to resolve a tenant from). The guard is `requirePortalSession` inside the
// router, which pins the tenant from the burned magic link instead.
router.use('/portal', portalRoutes);

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

// The customer directory and the requesters in it — the AGENT side of the
// portal, and the mirror image of `/api/portal` in the global tier above.
//
// The two are one hyphen apart on purpose, because they administer the same
// two tables, and they share nothing else: `/api/portal` guards itself with
// `requirePortalSession` and serves a principal that has no `users` row, while
// these two sit in the tenant tier behind `requireAuth` + `requireTenant` and
// require `portal_admin` on every route, reads included. A portal session
// reaching either of these is impossible — `requireAuth` reads
// `req.session.userId`, which a portal session never sets.
tenantRouter.use('/organizations', organizationsRoutes);
tenantRouter.use('/portal-admin', portalAdminRoutes);

// Tenant settings and the audit trail.
tenantRouter.use('/settings', settingsRoutes);
tenantRouter.use('/audit', auditRoutes);

// The desk itself.
tenantRouter.use('/tickets', ticketsRoutes);

// Problem management: the record behind a run of incidents, its root-cause
// analyses, its known errors, and the detector's candidate cards. A problem IS
// a ticket — `/problems/:ticketId` is a ticket id — but the module is mounted
// beside `/tickets` rather than under it, because half of it is not about one
// ticket at all: `/promote`, `/known-errors/suggest` and `/candidates` are
// collection-level, and nesting them would have made every URL carry a ticket
// id that the route had no use for.
tenantRouter.use('/problems', problemsRoutes);

tenantRouter.use('/journal', journalRoutes);
tenantRouter.use('/attachments', attachmentsRoutes);
tenantRouter.use('/ci', ciRoutes);
tenantRouter.use('/ci', ciLiveRoutes); // /ci/:id/live/:app — the read-through half

// The clock and the engines that act on it. All four are ordinary tenant
// routers: their handlers read `req.tenantId` and never name a tenant.
//
// Mounting `/rules` also INSTALLS the rules engine as a side effect — the
// bottom of `rule.service.ts` calls `installRulesEngine()` at module scope,
// which registers it against `ticket.service`'s hook points. That is not the
// only path to it (`index.ts` imports the module directly for the scheduled
// sweep), and it is not relied on: it is noted here so nobody removes this
// mount and wonders why automation went quiet.
tenantRouter.use('/sla', slaRoutes);
tenantRouter.use('/rules', rulesRoutes);
tenantRouter.use('/escalations', escalationRoutes);
tenantRouter.use('/approvals', approvalsRoutes);

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
