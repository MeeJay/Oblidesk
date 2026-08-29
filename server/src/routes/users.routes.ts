/**
 * users.routes.ts — `/api/users`
 *
 * Tenant-scoped user administration. Mounted behind `requireAuth` +
 * `requireTenant`, so `req.tenantId` is the tenant the admin is acting in.
 *
 * ── Why `requireRole('admin')` and not a capability ───────────────────────
 * The capability catalog in @oblidesk/shared deliberately has no
 * "manage users" entry: capabilities describe what someone may do WITH THE
 * DESK (work tickets, publish KB, admin SLAs), not who may create accounts.
 * Account administration is a role question, and gating it on a capability
 * would let a permission set grant the ability to grant permission sets —
 * a privilege-escalation loop dressed up as configuration.
 *
 * ── Listing is tenant-scoped even though `users` is global ────────────────
 * `GET /` returns the members of THIS tenant. The full installation-wide list
 * lives behind `GET /all` and is platform-admin only; showing every account on
 * a multi-tenant box to one customer's admin is a data leak, not a convenience.
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth, currentUserId } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { userService } from '../services/user.service';
import { teamService } from '../services/team.service';
import { permissionSetService } from '../services/permissionSet.service';
import { permissionService } from '../services/permission.service';
import type { UserRole } from '@oblidesk/shared';
import { logger } from '../utils/logger';

const router = Router();

interface ActorContext {
  tenantId: number;
  actorId: number;
  ip: string | null;
  userAgent: string | null;
}

/**
 * The acting user and tenant.
 *
 * `requireAuth` and `requireTenant` run on every route in this file, so both
 * are guaranteed. `currentUserId()` THROWS rather than returning undefined if a
 * guard is ever removed, and that is the behaviour we want here: these handlers
 * feed `actorId` straight into the audit ledger, and an audited action recorded
 * with a null actor is a worse outcome than a 500.
 */
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

/** Postgres unique-violation → 409, FK violation → 400, everything else → 500. */
function statusForError(error: unknown): number {
  const code = (error as { code?: string })?.code;
  if (code === '23505') return 409;
  if (code === '23503') return 400;
  return 500;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

router.use(requireAuth);
router.use(requireTenant);

// ═════════════════════════════════════════════════════════════════════════════
// Reads
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/users — members of the current tenant. */
router.get('/', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { tenantId } = actorContext(req);
    const result = await userService.listForTenant(tenantId, {
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      role: typeof req.query.role === 'string' ? (req.query.role as UserRole) : undefined,
      isActive: req.query.isActive === undefined ? undefined : req.query.isActive === 'true',
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });

    res.json({
      success: true,
      data: result.users,
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  } catch (error) {
    logger.error({ err: error }, 'users: list failed');
    fail(res, 500, 'Failed to list users');
  }
});

/**
 * GET /api/users/all — every account on the installation.
 * Platform admin only: this crosses tenant boundaries by design.
 */
router.get('/all', requireRole('admin'), async (req, res) => {
  try {
    const result = await userService.listAll({
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({
      success: true,
      data: result.users,
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  } catch (error) {
    logger.error({ err: error }, 'users: listAll failed');
    fail(res, 500, 'Failed to list users');
  }
});

/** GET /api/users/:id */
router.get('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid user id');

  try {
    const { tenantId } = actorContext(req);
    const user = await userService.getById(id);
    if (!user) return fail(res, 404, 'User not found');

    // Confirm the user actually belongs to this tenant before returning them:
    // `users` is global, so a valid id from another tenant would otherwise
    // resolve happily. 404 rather than 403 — probing ids should leak nothing.
    const resolved = await permissionService.resolve(id, tenantId);
    if (!resolved.isMember && !resolved.isPlatformAdmin) {
      return fail(res, 404, 'User not found');
    }

    res.json({
      success: true,
      data: {
        ...user,
        tenantRole: resolved.tenantRole,
        capabilities: resolved.capabilities,
        teams: resolved.teams,
        permissionSets: resolved.permissionSets,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'users: get failed');
    fail(res, 500, 'Failed to load user');
  }
});

/** GET /api/users/:id/teams — the teams this user is in, in this tenant. */
router.get('/:id/teams', requireRole('admin', 'manager'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid user id');

  try {
    const { tenantId } = actorContext(req);
    const teams = await teamService.getTeamsForUser(tenantId, id);
    res.json({ success: true, data: teams });
  } catch (error) {
    logger.error({ err: error }, 'users: teams failed');
    fail(res, 500, 'Failed to load teams');
  }
});

/** GET /api/users/:id/permission-sets */
router.get('/:id/permission-sets', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid user id');

  try {
    const { tenantId } = actorContext(req);
    const sets = await permissionSetService.getForUser(tenantId, id);
    res.json({ success: true, data: sets });
  } catch (error) {
    logger.error({ err: error }, 'users: permission sets failed');
    fail(res, 500, 'Failed to load permission sets');
  }
});

/** GET /api/users/:id/tenants — every tenant this user can reach. */
router.get('/:id/tenants', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid user id');

  try {
    const memberships = await permissionService.getTenantMemberships(id);
    res.json({ success: true, data: memberships });
  } catch (error) {
    logger.error({ err: error }, 'users: tenants failed');
    fail(res, 500, 'Failed to load tenant assignments');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Writes
// ═════════════════════════════════════════════════════════════════════════════

/** POST /api/users — create an account and add it to this tenant. */
router.post('/', requireRole('admin'), async (req, res) => {
  const body = req.body as {
    username?: string;
    password?: string;
    displayName?: string | null;
    email?: string | null;
    role?: UserRole;
    tenantRole?: UserRole;
    isActive?: boolean;
    preferredLanguage?: string;
  };

  if (!body.username || body.username.trim().length === 0) {
    return fail(res, 400, 'username is required');
  }

  try {
    const ctx = actorContext(req);
    const user = await userService.create(
      {
        username: body.username.trim(),
        password: body.password,
        displayName: body.displayName ?? null,
        email: body.email ?? null,
        role: body.role ?? 'user',
        tenantRole: body.tenantRole ?? 'agent',
        isActive: body.isActive ?? true,
        preferredLanguage: body.preferredLanguage,
      },
      ctx,
    );
    res.status(201).json({ success: true, data: user });
  } catch (error) {
    logger.error({ err: error }, 'users: create failed');
    const status = statusForError(error);
    fail(
      res,
      status,
      status === 409 ? 'That username is already taken' : messageOf(error, 'Failed to create user'),
    );
  }
});

/** PUT /api/users/:id */
router.put('/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid user id');

  try {
    const ctx = actorContext(req);
    const body = req.body as Record<string, unknown>;

    const user = await userService.update(
      id,
      {
        displayName: body.displayName as string | null | undefined,
        email: body.email as string | null | undefined,
        role: body.role as UserRole | undefined,
        isActive: body.isActive as boolean | undefined,
        preferredLanguage: body.preferredLanguage as string | undefined,
        avatar: body.avatar as string | null | undefined,
      },
      ctx,
    );
    if (!user) return fail(res, 404, 'User not found');
    res.json({ success: true, data: user });
  } catch (error) {
    logger.error({ err: error }, 'users: update failed');
    fail(res, statusForError(error), messageOf(error, 'Failed to update user'));
  }
});

/** PUT /api/users/:id/password — admin reset. Invalidates every live session. */
router.put('/:id/password', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid user id');

  const { password } = req.body as { password?: string };
  if (!password || password.length < 8) {
    return fail(res, 400, 'Password must be at least 8 characters');
  }

  try {
    const ctx = actorContext(req);
    const ok = await userService.setPassword(id, password, ctx);
    if (!ok) return fail(res, 404, 'User not found');
    res.json({ success: true, data: { changed: true } });
  } catch (error) {
    logger.error({ err: error }, 'users: password reset failed');
    fail(res, 500, 'Failed to change password');
  }
});

/** PUT /api/users/:id/tenant-role — the role this user holds HERE. */
router.put('/:id/tenant-role', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid user id');

  const { role } = req.body as { role?: UserRole };
  if (!role) return fail(res, 400, 'role is required');

  try {
    const ctx = actorContext(req);
    await userService.setTenantMembership(id, ctx.tenantId, role, ctx);
    res.json({ success: true, data: { userId: id, tenantId: ctx.tenantId, role } });
  } catch (error) {
    logger.error({ err: error }, 'users: tenant role change failed');
    fail(res, 500, 'Failed to change tenant role');
  }
});

/** PUT /api/users/:id/permission-sets — replace this user's sets in this tenant. */
router.put('/:id/permission-sets', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid user id');

  const { permissionSetIds } = req.body as { permissionSetIds?: number[] };
  if (!Array.isArray(permissionSetIds)) {
    return fail(res, 400, 'permissionSetIds must be an array');
  }

  try {
    const ctx = actorContext(req);
    const sets = await permissionSetService.setForUser(ctx.tenantId, id, permissionSetIds, ctx);
    res.json({ success: true, data: sets });
  } catch (error) {
    logger.error({ err: error }, 'users: permission set assignment failed');
    fail(res, 400, messageOf(error, 'Failed to assign permission sets'));
  }
});

/** PUT /api/users/:id/tenants — replace every tenant assignment. Platform admin. */
router.put('/:id/tenants', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid user id');

  const { assignments } = req.body as {
    assignments?: Array<{ tenantId: number; role: UserRole }>;
  };
  if (!Array.isArray(assignments)) return fail(res, 400, 'assignments must be an array');

  try {
    const ctx = actorContext(req);
    await userService.setTenantAssignments(id, assignments, ctx);
    const memberships = await permissionService.getTenantMemberships(id);
    res.json({ success: true, data: memberships });
  } catch (error) {
    logger.error({ err: error }, 'users: tenant assignment failed');
    fail(res, 500, 'Failed to set tenant assignments');
  }
});

/**
 * DELETE /api/users/:id — remove from THIS tenant by default.
 *
 * `?purge=true` hard-deletes the account across the installation. The default
 * is the safe one because "remove this person from my tenant" is what an admin
 * nearly always means, and the destructive reading of the same button is not
 * recoverable.
 */
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid user id');

  try {
    const ctx = actorContext(req);

    if (ctx.actorId === id) {
      return fail(res, 400, 'You cannot remove your own account');
    }

    if (req.query.purge === 'true') {
      const deleted = await userService.delete(id, ctx);
      if (!deleted) return fail(res, 404, 'User not found');
      return res.json({ success: true, data: { purged: true } });
    }

    const removed = await userService.removeTenantMembership(id, ctx.tenantId, ctx);
    if (!removed) return fail(res, 404, 'User is not a member of this tenant');
    res.json({ success: true, data: { removedFromTenant: true } });
  } catch (error) {
    logger.error({ err: error }, 'users: delete failed');
    fail(res, 500, 'Failed to remove user');
  }
});

export { router as usersRouter };
export default router;
