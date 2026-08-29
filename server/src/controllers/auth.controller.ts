/**
 * auth.controller.ts — local sign-in, sign-out, the session context and the
 * password-reset endpoints.
 *
 * Failures are thrown as `AppError` and formatted by `errorHandler`, so the
 * envelope and the machine-readable `code` are produced in exactly one place.
 * The codes matter: the login page branches on them (`forbidden` + `ssoOnly`
 * → offer the SSO button rather than "wrong password", which would be a lie).
 *
 * The two-step sign-in is a state machine on the session, and the invariant is
 * worth stating once: a session that has passed the password check but not the
 * second factor carries `pendingUserId` and NEVER `userId`. `requireAuth`
 * refuses it, so "half authenticated" cannot be mistaken for authenticated by
 * any route, present or future. `completeLogin` is the ONLY promotion path,
 * shared with the second-factor route.
 *
 * ObliTools: the desktop shell runs in a WebView2 that cannot keep our cookie,
 * so a successful response also carries `authToken` — the session id, replayed
 * in `X-Auth-Token` (AUTH_TOKEN_HEADER in @oblidesk/shared). The token IS the
 * session: destroying the session revokes it, and there is no second
 * credential to leak or expire separately.
 */

import type { NextFunction, Request, Response } from 'express';
import { AppError, badRequest, forbidden, unauthorized } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { SESSION_COOKIE_NAME } from '../utils/crypto';
import { auditService } from '../services/audit.service';
import { appConfigService } from '../services/appConfig.service';
import {
  authService,
  clientIp,
  clientUserAgent,
  saveSession,
  SsoOnlyError,
} from '../services/auth.service';
import { obligateService } from '../services/obligate.service';
import { passwordResetService } from '../services/passwordReset.service';
import { twoFactorService, EMAIL_OTP_TTL_MS, NoSmtpConfiguredError } from '../services/twoFactor.service';
import { userService } from '../services/user.service';
import { db } from '../db';
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  ResetPasswordInput,
  ResetTokenInput,
} from '../validators/auth.validators';
import type { User } from '@oblidesk/shared';

/** The request's absolute origin, honouring a TLS-terminating proxy. */
function requestOrigin(req: Request): string | null {
  const protocol = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
  return host ? `${protocol}://${host}` : null;
}

/**
 * File an auth event. `audit_log.tenant_id` is NOT NULL, so an event that
 * happened outside a tenant still names one (the user's default).
 */
async function recordAuth(
  req: Request,
  tenantId: number | null,
  entry: {
    actorId: number | null;
    action: string;
    entityId: string | number | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
): Promise<void> {
  if (tenantId === null) return;
  // `recordSafe` never throws: an audit failure must not turn a successful
  // sign-in into a 500 for the user standing at the login screen.
  await auditService.recordSafe({
    tenantId,
    actorId: entry.actorId,
    actorType: 'user',
    action: entry.action,
    entityType: 'user',
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: clientIp(req),
    userAgent: clientUserAgent(req),
  });
}

/** Force-2FA only bites when 2FA is allowed at all and the user has no factor. */
async function needs2faSetup(user: Pick<User, 'totpEnabled' | 'emailOtpEnabled'>): Promise<boolean> {
  if (user.totpEnabled || user.emailOtpEnabled) return false;
  const [allowed, forced] = await Promise.all([
    appConfigService.is2faAllowed(),
    appConfigService.is2faForced(),
  ]);
  return allowed && forced;
}

export const authController = {
  /**
   * POST /api/auth/login
   *
   * One factor → the session is issued here. Two factors → the session is
   * parked as `pendingUserId` and the answer says which method to prompt for;
   * `POST /api/profile/2fa/verify` finishes it.
   */
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username, password, tenantSlug } = req.body as LoginInput;

      let user: User | null;
      try {
        user = await authService.authenticate(username, password);
      } catch (err) {
        if (err instanceof SsoOnlyError) {
          throw new AppError(
            401,
            'Ce compte utilise la connexion SSO / This account signs in through SSO',
            { code: 'forbidden', payload: { ssoOnly: true, authSource: err.authSource } },
          );
        }
        throw err;
      }

      if (!user) {
        logger.info({ username, ip: clientIp(req) }, 'login: rejected');
        throw unauthorized('Invalid username or password');
      }

      if (!user.totpEnabled && !user.emailOtpEnabled) {
        await authController.completeLogin(req, res, user, tenantSlug);
        return;
      }

      // ── Second factor required ──────────────────────────────────────────
      // Deliberately NOT `req.session.userId`: see the invariant at the top.
      req.session.pendingUserId = user.id;
      req.session.pendingMfa = user.totpEnabled ? 'totp' : 'email_otp';
      req.session.pendingMfaExpiresAt = Date.now() + EMAIL_OTP_TTL_MS;
      delete req.session.pendingEmailOtpHash;
      if (tenantSlug) req.session.requestedTenantSlug = tenantSlug;

      // A user with both factors gets the e-mail as well as the authenticator,
      // so a lost phone does not become a lost account.
      let emailSent = false;
      if (user.emailOtpEnabled && user.email) {
        const code = twoFactorService.generateEmailOtp();
        req.session.pendingEmailOtpHash = twoFactorService.hashEmailOtp(user.email, code);
        try {
          await twoFactorService.sendEmailOtp(user.email, code);
          emailSent = true;
        } catch (err) {
          if (err instanceof NoSmtpConfiguredError) {
            logger.error({ userId: user.id }, 'login: e-mail OTP is enabled but no SMTP server is configured');
          } else {
            logger.error({ err, userId: user.id }, 'login: the e-mail code could not be sent');
          }
        }
      }

      await saveSession(req);

      res.json({
        success: true,
        data: {
          mfaRequired: req.session.pendingMfa,
          /** For the cookie-less ObliTools shell — the pending session's id. */
          mfaToken: req.sessionID,
          methods: { totp: user.totpEnabled, email: user.emailOtpEnabled },
          emailSent,
          expiresAt: req.session.pendingMfaExpiresAt,
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * The tail every successful authentication runs through — password-only, or
   * after a second factor. One definition of what an established session looks
   * like, and one place that audits it.
   */
  async completeLogin(req: Request, res: Response, user: User, tenantSlug?: string): Promise<void> {
    const requestedTenantId = tenantSlug
      ? await authService.resolveTenantSlugForUser(user.id, tenantSlug)
      : null;

    if (tenantSlug) {
      logger.info(
        { userId: user.id, tenantSlug, matched: requestedTenantId !== null },
        'login: cross-app tenant handoff',
      );
    }

    const tenantId = await authService.establishSession(req, user, requestedTenantId);
    delete req.session.requestedTenantSlug;
    await saveSession(req);

    const context = await authService.buildSessionContext(user.id, tenantId);
    if (!context) {
      // Authenticated, but a member of nothing. Saying so is the only useful
      // answer; silently landing them on tenant 1 would be a data leak.
      throw forbidden('This account has no tenant access yet — ask an administrator to add you to a tenant');
    }

    await recordAuth(req, context.tenant.id, {
      actorId: user.id,
      action: 'auth.login',
      entityId: user.id,
      after: { method: user.authSource, tenantSlug: context.tenant.slug },
    });

    res.json({
      success: true,
      data: {
        session: context,
        authToken: req.sessionID,
        requires2faSetup: await needs2faSetup(context.user),
      },
    });
  },

  /** POST /api/auth/logout */
  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId ?? null;
      const tenantId = req.session.currentTenantId ?? null;

      if (userId !== null) {
        await recordAuth(req, tenantId, {
          actorId: userId,
          action: 'auth.logout',
          entityId: userId,
        });
      }

      req.session.destroy((err) => {
        if (err) {
          next(new AppError(500, 'Failed to sign out', { code: 'internal_error', cause: err }));
          return;
        }
        res.clearCookie(SESSION_COOKIE_NAME);
        res.json({ success: true, data: { loggedOut: true } });
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/auth/me — the resolved SessionContext: the user, the active
   * tenant, every tenant they can switch to, their expanded capabilities and
   * their teams.
   */
  async me(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId;
      if (!userId) throw unauthorized();

      // SSO accounts: pull theme / language / avatar from Obligate first, so
      // a theme picked in a sibling app is already applied on this response.
      // The service throttles itself to once a minute and never throws.
      const row = (await db('users')
        .where({ id: userId })
        .first('auth_source', 'obligate_user_id')) as
        | { auth_source: string; obligate_user_id: number | null }
        | undefined;
      if (row?.auth_source === 'obligate' && row.obligate_user_id) {
        await obligateService.syncUserPreferences(userId, row.obligate_user_id);
      }

      const context = await authService.buildSessionContext(userId, req.session.currentTenantId ?? null);
      if (!context) throw forbidden('This account has no tenant access');

      // Repair a session pointing at a tenant the user has since lost.
      if (req.session.currentTenantId !== context.tenant.id) {
        req.session.currentTenantId = context.tenant.id;
        await saveSession(req);
      }

      res.json({
        success: true,
        data: {
          ...context,
          authToken: req.sessionID,
          requires2faSetup: await needs2faSetup(context.user),
        },
      });
    } catch (err) {
      next(err);
    }
  },

  // Switching the ACTIVE tenant is not here on purpose: `routes/index.ts`
  // gives that to `tenants.routes.ts`, next to the rest of tenant CRUD. Two
  // endpoints writing `session.currentTenantId` would be two behaviours to
  // keep in step. What this module owns is the tenant a session STARTS on —
  // `authService.resolveTenantSlugForUser` + the `?tenant=` handoff.

  /** POST /api/auth/change-password — local accounts only. */
  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId;
      if (!userId) throw unauthorized();

      const { currentPassword, newPassword } = req.body as ChangePasswordInput;

      const user = await userService.getById(userId);
      if (!user) throw unauthorized('User not found');
      if (user.authSource !== 'local') {
        throw badRequest('This account is managed by Obligate — change the password there');
      }

      // Re-authenticate with the CURRENT password: a stolen session must not be
      // enough to change the credential that would let it be taken back.
      if (!(await userService.verifyPassword(user.username, currentPassword))) {
        throw unauthorized('The current password is incorrect');
      }

      const tenantId = req.session.currentTenantId ?? (await authService.auditTenantFor(userId));
      if (tenantId === null) throw forbidden('This account has no tenant access');

      // `setPassword` bumps enrollment_version — every OTHER session dies. The
      // caller's own cookie keeps working because the session store row is
      // untouched; that is deliberate, so a user is not logged out by their own
      // password change.
      await userService.setPassword(userId, newPassword, {
        tenantId,
        actorId: userId,
        ip: clientIp(req),
        userAgent: clientUserAgent(req),
      });

      res.json({ success: true, data: { changed: true } });
    } catch (err) {
      next(err);
    }
  },

  // ── Password reset (public) ───────────────────────────────────────────────

  /**
   * POST /api/auth/forgot-password
   * Always answers 200. A different answer for a known address would make this
   * a user directory.
   */
  async forgotPassword(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      await passwordResetService.requestReset((req.body as ForgotPasswordInput).email, {
        ip: clientIp(req),
        userAgent: clientUserAgent(req),
        origin: requestOrigin(req),
      });
    } catch (err) {
      // Even an internal failure answers 200: this response must not vary with
      // anything the caller could learn from, including our own bugs.
      logger.error({ err }, 'forgot-password failed');
    }
    res.json({ success: true, data: { sent: true } });
  },

  /** POST /api/auth/reset-password/validate — is this link still live? */
  async validateResetToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token } = req.body as ResetTokenInput;
      const userId = await passwordResetService.validateToken(token);
      res.json({ success: true, data: { valid: userId !== null } });
    } catch (err) {
      next(err);
    }
  },

  /** POST /api/auth/reset-password */
  async resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token, password } = req.body as ResetPasswordInput;
      const ok = await passwordResetService.resetPassword(token, password, {
        ip: clientIp(req),
        userAgent: clientUserAgent(req),
      });

      if (!ok) throw badRequest('This reset link is invalid or has expired');

      res.json({ success: true, data: { reset: true } });
    } catch (err) {
      next(err);
    }
  },
};

export default authController;
