/**
 * permissionSets.routes.ts — `/api/permission-sets`
 *
 * Named capability bundles, plus the capability CATALOG the editor renders.
 *
 * ── The catalog is readable by anyone signed in ───────────────────────────
 * `GET /catalog` is behind `requireAuth` and nothing more. The client needs the
 * capability labels and the `implies` edges to render its own permission checks
 * and to explain why a button is disabled; the catalog is a static description
 * of the app's vocabulary, not a secret. Editing sets, on the other hand, is
 * admin-only — for the same reason user administration is: a capability that
 * let you edit capabilities would be a privilege-escalation loop.
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth, currentUserId } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { permissionSetService } from '../services/permissionSet.service';
import type { Capability } from '@oblidesk/shared';
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

function parseId(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

router.use(requireAuth);
router.use(requireTenant);

// ═════════════════════════════════════════════════════════════════════════════
// Catalog
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/permission-sets/catalog
 *
 * Grouped capabilities with labels, i18n keys, `implies` edges and the
 * sensitivity flag, plus the shipped presets. The `implies` edges are what let
 * the editor warn "granting Manage configuration also grants six others" BEFORE
 * the admin saves, rather than leaving them to discover it from a support
 * ticket.
 *
 * Declared before `/:id` so the literal path is not swallowed by the parameter.
 */
router.get('/catalog', async (_req, res) => {
  try {
    res.json({ success: true, data: permissionSetService.getCatalog() });
  } catch (error) {
    logger.error({ err: error }, 'permission sets: catalog failed');
    fail(res, 500, 'Failed to load the capability catalog');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Sets
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/permission-sets — with assignee counts and expanded capabilities. */
router.get('/', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { tenantId } = actorContext(req);
    const sets = await permissionSetService.list(tenantId);
    res.json({ success: true, data: sets });
  } catch (error) {
    logger.error({ err: error }, 'permission sets: list failed');
    fail(res, 500, 'Failed to list permission sets');
  }
});

/** GET /api/permission-sets/:id */
router.get('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid permission set id');

  try {
    const { tenantId } = actorContext(req);
    const set = await permissionSetService.getById(tenantId, id);
    if (!set) return fail(res, 404, 'Permission set not found');
    res.json({
      success: true,
      data: { ...set, effectiveCapabilities: permissionSetService.expand(set.capabilities) },
    });
  } catch (error) {
    logger.error({ err: error }, 'permission sets: get failed');
    fail(res, 500, 'Failed to load permission set');
  }
});

/** GET /api/permission-sets/:id/assignees — user ids holding this set. */
router.get('/:id/assignees', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid permission set id');

  try {
    const { tenantId } = actorContext(req);
    const assignees = await permissionSetService.getAssignees(tenantId, id);
    res.json({ success: true, data: assignees });
  } catch (error) {
    logger.error({ err: error }, 'permission sets: assignees failed');
    fail(res, 500, 'Failed to load assignees');
  }
});

/** POST /api/permission-sets */
router.post('/', requireRole('admin'), async (req, res) => {
  const body = req.body as {
    name?: string;
    description?: string | null;
    capabilities?: Capability[];
  };

  if (!body.name || body.name.trim().length === 0) return fail(res, 400, 'name is required');
  if (!Array.isArray(body.capabilities)) return fail(res, 400, 'capabilities must be an array');

  try {
    const ctx = actorContext(req);
    const set = await permissionSetService.create(
      ctx.tenantId,
      {
        name: body.name.trim(),
        description: body.description ?? null,
        capabilities: body.capabilities,
      },
      ctx,
    );
    res.status(201).json({ success: true, data: set });
  } catch (error) {
    logger.error({ err: error }, 'permission sets: create failed');
    const status = (error as { code?: string })?.code === '23505' ? 409 : 500;
    fail(
      res,
      status,
      status === 409
        ? 'A permission set with that name already exists'
        : 'Failed to create permission set',
    );
  }
});

/**
 * PUT /api/permission-sets/:id
 *
 * System sets ARE editable — an admin who wants "Agent" to include ticket
 * deletion should be able to say so. Only deletion is blocked, because other
 * objects reference a set by name.
 */
router.put('/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid permission set id');

  try {
    const ctx = actorContext(req);
    const body = req.body as {
      name?: string;
      description?: string | null;
      capabilities?: Capability[];
    };

    const set = await permissionSetService.update(ctx.tenantId, id, body, ctx);
    if (!set) return fail(res, 404, 'Permission set not found');
    res.json({ success: true, data: set });
  } catch (error) {
    logger.error({ err: error }, 'permission sets: update failed');
    const status = (error as { code?: string })?.code === '23505' ? 409 : 500;
    fail(res, status, messageOf(error, 'Failed to update permission set'));
  }
});

/** POST /api/permission-sets/:id/clone — the answer to "delete a system set". */
router.post('/:id/clone', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid permission set id');

  const { name } = req.body as { name?: string };
  if (!name || name.trim().length === 0) return fail(res, 400, 'name is required');

  try {
    const ctx = actorContext(req);
    const set = await permissionSetService.clone(ctx.tenantId, id, name.trim(), ctx);
    if (!set) return fail(res, 404, 'Permission set not found');
    res.status(201).json({ success: true, data: set });
  } catch (error) {
    logger.error({ err: error }, 'permission sets: clone failed');
    const status = (error as { code?: string })?.code === '23505' ? 409 : 500;
    fail(res, status, messageOf(error, 'Failed to clone permission set'));
  }
});

/** DELETE /api/permission-sets/:id — refused for system sets, with the reason. */
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid permission set id');

  try {
    const ctx = actorContext(req);
    const deleted = await permissionSetService.delete(ctx.tenantId, id, ctx);
    if (!deleted) return fail(res, 404, 'Permission set not found');
    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    logger.error({ err: error }, 'permission sets: delete failed');
    // The service throws an actionable message for system sets; a 400 carrying
    // that message beats a 500 that says "internal error" for a rule we chose.
    fail(res, 400, messageOf(error, 'Failed to delete permission set'));
  }
});

export { router as permissionSetsRouter };
export default router;
