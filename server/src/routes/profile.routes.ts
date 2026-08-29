/**
 * profile.routes.ts — `/api/profile`
 *
 * The signed-in user acting on their OWN account. Every handler operates on
 * `req.session.userId` and never on an id from the URL or the body — that is
 * the whole security model of this file, and it is why these endpoints need no
 * role check beyond `requireAuth`.
 *
 * The service layer enforces the same thing from the other side:
 * `userService.updateOwnProfile()` accepts only the fields a person may change
 * about themselves, so a request body carrying `role: 'admin'` changes nothing
 * rather than being politely ignored somewhere further down.
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth, currentUserId } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { userService } from '../services/user.service';
import { permissionService } from '../services/permission.service';
import { tenantService } from '../services/tenant.service';
import type { UserPreferences } from '@oblidesk/shared';
import { SUPPORTED_LOCALES } from '@oblidesk/shared';
import { logger } from '../utils/logger';

const router = Router();

interface ActorContext {
  tenantId: number;
  userId: number;
  ip: string | null;
  userAgent: string | null;
}

/**
 * The signed-in user and their active tenant. `requireAuth` + `requireTenant`
 * run on every route here, so `currentUserId()` cannot fail — and if a guard is
 * ever removed it throws rather than returning a null that would let a handler
 * act on nobody's behalf.
 */
function actorContext(req: Request): ActorContext {
  return {
    tenantId: req.tenantId,
    userId: currentUserId(req),
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ success: false, error });
}

router.use(requireAuth);
router.use(requireTenant);

// ═════════════════════════════════════════════════════════════════════════════
// Read
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/profile
 *
 * Returns the account PLUS the resolved session context for the active tenant:
 * capabilities (already expanded through the `implies` graph), teams, and the
 * tenants the user can switch to. One round trip, because the client needs all
 * of it before it can render anything and three requests would mean three
 * chances to render a half-authorised UI.
 */
router.get('/', async (req, res) => {
  const ctx = actorContext(req);

  try {
    const [user, resolved, tenant, memberships] = await Promise.all([
      userService.getById(ctx.userId),
      permissionService.resolve(ctx.userId, ctx.tenantId),
      tenantService.getById(ctx.tenantId),
      permissionService.getTenantMemberships(ctx.userId),
    ]);

    if (!user) return fail(res, 404, 'User not found');

    res.json({
      success: true,
      data: {
        user,
        tenant,
        tenants: memberships,
        role: resolved.tenantRole,
        capabilities: resolved.capabilities,
        teams: resolved.teams,
        isAdmin: resolved.isPlatformAdmin || resolved.isTenantAdmin,
        isMasterTenant: resolved.isMasterTenant,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'profile: load failed');
    fail(res, 500, 'Failed to load profile');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Write
// ═════════════════════════════════════════════════════════════════════════════

/** PUT /api/profile — display name, e-mail, language, avatar. */
router.put('/', async (req, res) => {
  const ctx = actorContext(req);

  const body = req.body as {
    displayName?: string | null;
    email?: string | null;
    preferredLanguage?: string;
    avatar?: string | null;
  };

  if (
    body.preferredLanguage !== undefined &&
    !(SUPPORTED_LOCALES as readonly string[]).includes(body.preferredLanguage)
  ) {
    return fail(res, 400, `Unsupported language "${body.preferredLanguage}"`);
  }

  try {
    const user = await userService.updateOwnProfile(
      ctx.userId,
      {
        displayName: body.displayName,
        email: body.email,
        preferredLanguage: body.preferredLanguage,
        avatar: body.avatar,
      },
      { tenantId: ctx.tenantId, actorId: ctx.userId, ip: ctx.ip, userAgent: ctx.userAgent },
    );
    if (!user) return fail(res, 404, 'User not found');
    res.json({ success: true, data: user });
  } catch (error) {
    logger.error({ err: error }, 'profile: update failed');
    const status = (error as { code?: string })?.code === '23505' ? 409 : 500;
    fail(res, status, status === 409 ? 'That e-mail address is already in use' : 'Failed to update profile');
  }
});

/**
 * PUT /api/profile/preferences
 *
 * The autosave behind every UI toggle: density, collapsed sidebar, default
 * view, column widths. Deliberately NOT audited — a hundred audit rows a day
 * per user recording "they collapsed the sidebar" would bury the events the
 * ledger exists to preserve.
 */
router.put('/preferences', async (req, res) => {
  const ctx = actorContext(req);

  const preferences = req.body as UserPreferences;
  if (!preferences || typeof preferences !== 'object') {
    return fail(res, 400, 'A preferences object is required');
  }

  try {
    const saved = await userService.setPreferences(ctx.userId, preferences);
    res.json({ success: true, data: saved });
  } catch (error) {
    logger.error({ err: error }, 'profile: preferences failed');
    fail(res, 500, 'Failed to save preferences');
  }
});

/**
 * PUT /api/profile/password
 *
 * Verifies the current password first, then bumps `enrollment_version`, which
 * every live session carries — so changing a password really does sign the
 * other devices out instead of leaving them authenticated.
 */
router.put('/password', async (req, res) => {
  const ctx = actorContext(req);

  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
  };

  if (!currentPassword || !newPassword) {
    return fail(res, 400, 'currentPassword and newPassword are required');
  }
  if (newPassword.length < 8) {
    return fail(res, 400, 'The new password must be at least 8 characters');
  }

  try {
    const outcome = await userService.changeOwnPassword(
      ctx.userId,
      currentPassword,
      newPassword,
      { tenantId: ctx.tenantId, actorId: ctx.userId, ip: ctx.ip, userAgent: ctx.userAgent },
    );

    if (outcome === 'not_found') return fail(res, 404, 'User not found');
    // One message for both "wrong password" and "this account has no local
    // password": distinguishing them would tell an attacker which accounts are
    // SSO-only, which is a free hint about where to aim.
    if (outcome === 'wrong_password') return fail(res, 400, 'The current password is incorrect');

    res.json({ success: true, data: { changed: true } });
  } catch (error) {
    logger.error({ err: error }, 'profile: password change failed');
    fail(res, 500, 'Failed to change password');
  }
});

/** GET /api/profile/capabilities — just the expanded capability list. */
router.get('/capabilities', async (req, res) => {
  const ctx = actorContext(req);

  try {
    const resolved = await permissionService.resolve(ctx.userId, ctx.tenantId);
    res.json({
      success: true,
      data: {
        capabilities: resolved.capabilities,
        role: resolved.tenantRole,
        isAdmin: resolved.isPlatformAdmin || resolved.isTenantAdmin,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'profile: capabilities failed');
    fail(res, 500, 'Failed to load capabilities');
  }
});

export { router as profileRouter };
export default router;
