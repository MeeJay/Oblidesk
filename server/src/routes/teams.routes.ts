/**
 * teams.routes.ts — `/api/teams`
 *
 * Teams are the human grouping and the capability bundle their members
 * inherit. They are NOT assignment groups — a ticket is routed to an
 * `assignment_group`. See the header of team.service.ts for why the two are
 * deliberately separate.
 *
 * Everything here is tenant-scoped and admin-gated: editing a team's
 * capabilities changes what every member may do, which is an account-
 * administration decision rather than a desk-configuration one.
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth, currentUserId } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { teamService } from '../services/team.service';
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
// Teams
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/teams — every team in this tenant, with member counts. */
router.get('/', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { tenantId } = actorContext(req);
    const teams = await teamService.list(tenantId);
    res.json({ success: true, data: teams });
  } catch (error) {
    logger.error({ err: error }, 'teams: list failed');
    fail(res, 500, 'Failed to list teams');
  }
});

/** GET /api/teams/:id */
router.get('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid team id');

  try {
    const { tenantId } = actorContext(req);
    const team = await teamService.getById(tenantId, id);
    if (!team) return fail(res, 404, 'Team not found');
    res.json({ success: true, data: team });
  } catch (error) {
    logger.error({ err: error }, 'teams: get failed');
    fail(res, 500, 'Failed to load team');
  }
});

/** POST /api/teams */
router.post('/', requireRole('admin'), async (req, res) => {
  const body = req.body as {
    name?: string;
    description?: string | null;
    capabilities?: Capability[];
  };

  if (!body.name || body.name.trim().length === 0) {
    return fail(res, 400, 'name is required');
  }

  try {
    const ctx = actorContext(req);
    const team = await teamService.create(
      ctx.tenantId,
      {
        name: body.name.trim(),
        description: body.description ?? null,
        capabilities: body.capabilities ?? [],
      },
      ctx,
    );
    res.status(201).json({ success: true, data: team });
  } catch (error) {
    logger.error({ err: error }, 'teams: create failed');
    // uq_teams_tenant_name — a duplicate name inside one tenant.
    const status = (error as { code?: string })?.code === '23505' ? 409 : 500;
    fail(
      res,
      status,
      status === 409 ? 'A team with that name already exists' : 'Failed to create team',
    );
  }
});

/** PUT /api/teams/:id */
router.put('/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid team id');

  try {
    const ctx = actorContext(req);
    const body = req.body as {
      name?: string;
      description?: string | null;
      capabilities?: Capability[];
    };

    const team = await teamService.update(ctx.tenantId, id, body, ctx);
    if (!team) return fail(res, 404, 'Team not found');
    res.json({ success: true, data: team });
  } catch (error) {
    logger.error({ err: error }, 'teams: update failed');
    const status = (error as { code?: string })?.code === '23505' ? 409 : 500;
    fail(
      res,
      status,
      status === 409 ? 'A team with that name already exists' : 'Failed to update team',
    );
  }
});

/** DELETE /api/teams/:id — memberships cascade with the team. */
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid team id');

  try {
    const ctx = actorContext(req);
    const deleted = await teamService.delete(ctx.tenantId, id, ctx);
    if (!deleted) return fail(res, 404, 'Team not found');
    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    logger.error({ err: error }, 'teams: delete failed');
    fail(res, 500, 'Failed to delete team');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Members
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/teams/:id/members */
router.get('/:id/members', requireRole('admin', 'manager'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid team id');

  try {
    const { tenantId } = actorContext(req);
    const team = await teamService.getById(tenantId, id);
    if (!team) return fail(res, 404, 'Team not found');
    const members = await teamService.getMembers(tenantId, id);
    res.json({ success: true, data: members });
  } catch (error) {
    logger.error({ err: error }, 'teams: members failed');
    fail(res, 500, 'Failed to load members');
  }
});

/**
 * PUT /api/teams/:id/members — full replace.
 *
 * The service refuses ids that are not already members of this tenant, so a
 * crafted body cannot pull a user out of another customer's tenant and hand
 * them this team's capabilities. That refusal is a 400, not a silent filter:
 * quietly dropping ids would leave the admin's screen disagreeing with reality.
 */
router.put('/:id/members', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid team id');

  const { userIds } = req.body as { userIds?: number[] };
  if (!Array.isArray(userIds)) return fail(res, 400, 'userIds must be an array');

  try {
    const ctx = actorContext(req);
    const members = await teamService.setMembers(ctx.tenantId, id, userIds, ctx);
    if (members === null) return fail(res, 404, 'Team not found');
    res.json({ success: true, data: members });
  } catch (error) {
    logger.error({ err: error }, 'teams: set members failed');
    fail(res, 400, messageOf(error, 'Failed to set members'));
  }
});

/** POST /api/teams/:id/members — add one. */
router.post('/:id/members', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid team id');

  const { userId } = req.body as { userId?: number };
  if (!userId) return fail(res, 400, 'userId is required');

  try {
    const ctx = actorContext(req);
    const added = await teamService.addMember(ctx.tenantId, id, userId, ctx);
    if (!added) return fail(res, 404, 'Team not found');
    res.json({ success: true, data: { added: true } });
  } catch (error) {
    logger.error({ err: error }, 'teams: add member failed');
    fail(res, 400, messageOf(error, 'Failed to add member'));
  }
});

/** DELETE /api/teams/:id/members/:userId */
router.delete('/:id/members/:userId', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  const userId = parseId(req.params.userId);
  if (!id || !userId) return fail(res, 400, 'Invalid team or user id');

  try {
    const ctx = actorContext(req);
    const removed = await teamService.removeMember(ctx.tenantId, id, userId, ctx);
    if (!removed) return fail(res, 404, 'Membership not found');
    res.json({ success: true, data: { removed: true } });
  } catch (error) {
    logger.error({ err: error }, 'teams: remove member failed');
    fail(res, 500, 'Failed to remove member');
  }
});

export { router as teamsRouter };
export default router;
