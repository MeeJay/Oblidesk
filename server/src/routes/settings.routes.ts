/**
 * settings.routes.ts — `/api/settings`
 *
 * The two-level inheritance store: hard-coded default → platform row → tenant
 * override. Every response carries WHICH level supplied the value, because a
 * settings screen showing "30" without saying whether that is the built-in
 * default, installation policy, or something this tenant chose is a screen that
 * gets edited by mistake.
 *
 * ── Gates ─────────────────────────────────────────────────────────────────
 *   read              any authenticated tenant member — the client needs
 *                     resolved values (page size, portal switches, at-risk
 *                     threshold) to render correctly.
 *   tenant override   CONFIG_ADMIN. This is desk configuration, so it belongs
 *                     to a capability rather than to a role.
 *   platform default  requireRole('admin'). It changes behaviour for every
 *                     tenant that has not overridden the key, which is not a
 *                     decision one customer's admin gets to make.
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth, currentUserId } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireRole, requireCapability } from '../middleware/rbac';
import { settingsService } from '../services/settings.service';
import { CAPABILITIES } from '@oblidesk/shared';
import { logger } from '../utils/logger';

const router = Router();

interface ActorContext {
  tenantId: number;
  actorId: number;
  ip: string | null;
  userAgent: string | null;
}

/** See users.routes.ts — `currentUserId()` throws rather than yielding a null actor. */
function actorContext(req: Request): ActorContext {
  return {
    tenantId: req.tenantId,
    actorId: currentUserId(req),
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ success: false, error });
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * A validation failure and an unknown key are both the caller's fault (400/404);
 * anything else is ours (500). Distinguishing them matters because the service
 * throws messages an admin can act on ("must be at least 15"), and burying
 * those in a 500 turns a self-service fix into a support ticket.
 */
function statusForSettingError(error: unknown): number {
  const message = error instanceof Error ? error.message : '';
  if (/^Unknown setting key/.test(message)) return 404;
  if (/expects|must be|cannot be overridden|platform-wide/.test(message)) return 400;
  return 500;
}

router.use(requireAuth);
router.use(requireTenant);

// ═════════════════════════════════════════════════════════════════════════════
// Reads
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/settings — every setting resolved for the current tenant, with the
 * value held at each level so the UI can render "inherited from platform" and
 * offer a one-click revert.
 */
router.get('/', async (req, res) => {
  try {
    const { tenantId } = actorContext(req);
    const resolved = await settingsService.resolveAll(tenantId);
    res.json({ success: true, data: resolved });
  } catch (error) {
    logger.error({ err: error }, 'settings: resolve failed');
    fail(res, 500, 'Failed to load settings');
  }
});

/** GET /api/settings/definitions — the catalog, grouped as the screen lays it out. */
router.get('/definitions', async (_req, res) => {
  try {
    res.json({
      success: true,
      data: {
        definitions: settingsService.getDefinitions(),
        groups: settingsService.getDefinitionsByGroup(),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'settings: definitions failed');
    fail(res, 500, 'Failed to load setting definitions');
  }
});

/** GET /api/settings/global — the platform rows. Platform admin. */
router.get('/global', requireRole('admin'), async (_req, res) => {
  try {
    const rows = await settingsService.listGlobal();
    res.json({ success: true, data: rows });
  } catch (error) {
    logger.error({ err: error }, 'settings: global list failed');
    fail(res, 500, 'Failed to load platform settings');
  }
});

/**
 * GET /api/settings/:key — one resolved setting.
 * Declared after the literal paths so `/definitions` and `/global` are not
 * swallowed by the parameter.
 */
router.get('/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const { tenantId } = actorContext(req);
    const resolved = await settingsService.resolveAll(tenantId);
    const entry = resolved[key];
    if (!entry) return fail(res, 404, `Unknown setting key "${key}"`);
    res.json({ success: true, data: entry });
  } catch (error) {
    logger.error({ err: error }, 'settings: get failed');
    fail(res, statusForSettingError(error), messageOf(error, 'Failed to load setting'));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Writes — tenant overrides
// ═════════════════════════════════════════════════════════════════════════════

/**
 * PUT /api/settings — apply several overrides atomically.
 *
 * Bulk, and in one transaction, because a settings form is one decision: a
 * per-key loop that fails on the fourth of seven values leaves the tenant
 * half-configured and the screen disagreeing with the database.
 */
router.put('/', requireCapability(CAPABILITIES.CONFIG_ADMIN), async (req, res) => {
  const body = req.body as { entries?: Array<{ key: string; value: unknown }> };
  if (!Array.isArray(body.entries)) {
    return fail(res, 400, 'entries must be an array of { key, value }');
  }

  try {
    const ctx = actorContext(req);
    const resolved = await settingsService.setTenantBulk(ctx.tenantId, body.entries, ctx);
    res.json({ success: true, data: resolved });
  } catch (error) {
    logger.error({ err: error }, 'settings: bulk set failed');
    fail(res, statusForSettingError(error), messageOf(error, 'Failed to save settings'));
  }
});

/** PUT /api/settings/:key — one tenant override. */
router.put('/:key', requireCapability(CAPABILITIES.CONFIG_ADMIN), async (req, res) => {
  const key = req.params.key;
  const body = req.body as { value?: unknown };

  if (!('value' in body)) return fail(res, 400, 'A value is required');

  try {
    const ctx = actorContext(req);
    const entry = await settingsService.setTenant(ctx.tenantId, key, body.value, ctx);
    res.json({ success: true, data: entry });
  } catch (error) {
    logger.error({ err: error }, 'settings: set failed');
    fail(res, statusForSettingError(error), messageOf(error, 'Failed to save setting'));
  }
});

/**
 * DELETE /api/settings/:key — revert to inherited.
 *
 * Deliberately different from writing the inherited value: writing it would PIN
 * the current default, so a later change to installation policy would never
 * reach this tenant. Deleting the row restores the inheritance.
 */
router.delete('/:key', requireCapability(CAPABILITIES.CONFIG_ADMIN), async (req, res) => {
  const key = req.params.key;
  try {
    const ctx = actorContext(req);
    const entry = await settingsService.clearTenant(ctx.tenantId, key, ctx);
    res.json({ success: true, data: entry });
  } catch (error) {
    logger.error({ err: error }, 'settings: clear failed');
    fail(res, statusForSettingError(error), messageOf(error, 'Failed to clear setting'));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Writes — platform defaults
// ═════════════════════════════════════════════════════════════════════════════

/**
 * PUT /api/settings/global/:key — the installation-wide default.
 *
 * The audit row lands in the chain of the tenant the admin was acting in — the
 * ledger is per-tenant by construction — with `scope: 'global'` stamped in the
 * payload so it reads unambiguously later.
 */
router.put('/global/:key', requireRole('admin'), async (req, res) => {
  const key = req.params.key;
  const body = req.body as { value?: unknown };

  if (!('value' in body)) return fail(res, 400, 'A value is required');

  try {
    const ctx = actorContext(req);
    const value = await settingsService.setGlobal(key, body.value, ctx.tenantId, ctx);
    res.json({ success: true, data: { key, value, scope: 'global' } });
  } catch (error) {
    logger.error({ err: error }, 'settings: global set failed');
    fail(res, statusForSettingError(error), messageOf(error, 'Failed to save platform setting'));
  }
});

export { router as settingsRouter };
export default router;
