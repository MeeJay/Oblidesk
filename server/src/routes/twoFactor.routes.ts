/**
 * twoFactor.routes.ts — second-factor enrolment and login verification.
 * Mounted at `/api/profile/2fa` (see routes/index.ts).
 *
 * Two families share one router because they share one state machine:
 *
 *   enrolment    (a full session)                /status, /totp/*, /email/*
 *   login step 2 (a half-authenticated session)  /verify, /resend
 *
 * `requireAuth` refuses a half-authenticated session and `requirePendingMfa`
 * refuses a full one, so neither family can be reached through the other's
 * door.
 *
 * Nothing enrols a factor without a code round-tripping first:
 *   • TOTP — the candidate secret is stored with `totp_enabled = false`, and
 *     only `/totp/enable` flips the flag. Every login path reads the flag, so
 *     a candidate secret is inert.
 *   • E-mail — the session holds `sha256(address:code)`, never the code, and
 *     `/email/enable` re-sends the address so the code cannot be replayed to
 *     enrol a different inbox.
 */

import { Router } from 'express';
import type { Request } from 'express';
import { authController } from '../controllers/auth.controller';
import { requireAuth, requirePendingMfa, currentUserId } from '../middleware/auth';
import { AppError, badRequest, unauthorized } from '../middleware/errorHandler';
import { mfaLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { logger } from '../utils/logger';
import { auditService } from '../services/audit.service';
import { appConfigService } from '../services/appConfig.service';
import { authService, clientIp, clientUserAgent, saveSession } from '../services/auth.service';
import { twoFactorService, EMAIL_OTP_TTL_MS, NoSmtpConfiguredError } from '../services/twoFactor.service';
import { userService } from '../services/user.service';
import {
  emailOtpEnableSchema,
  emailOtpSetupSchema,
  mfaVerifySchema,
  totpEnableSchema,
} from '../validators/auth.validators';
import type {
  EmailOtpEnableInput,
  EmailOtpSetupInput,
  MfaVerifyInput,
  TotpEnableInput,
} from '../validators/auth.validators';

const router = Router();

/** 2FA changes are security events: they belong in the ledger. */
async function auditFactor(
  req: Request,
  userId: number,
  action: 'auth.2fa_enable' | 'auth.2fa_disable',
  after: Record<string, unknown>,
): Promise<void> {
  const tenantId = req.session.currentTenantId ?? (await authService.auditTenantFor(userId));
  if (tenantId === null) return;
  await auditService.recordSafe({
    tenantId,
    actorId: userId,
    actorType: 'user',
    action,
    entityType: 'user',
    entityId: userId,
    before: null,
    after,
    ip: clientIp(req),
    userAgent: clientUserAgent(req),
  });
}

/** Enrolment is refused outright when the operator has 2FA switched off. */
async function assert2faAllowed(): Promise<void> {
  if (!(await appConfigService.is2faAllowed())) {
    throw new AppError(403, 'Two-factor authentication is disabled on this installation', {
      code: 'forbidden',
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Enrolment — a full session
// ═════════════════════════════════════════════════════════════════════════════

router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const [status, allowed, forced] = await Promise.all([
      twoFactorService.getStatus(userId),
      appConfigService.is2faAllowed(),
      appConfigService.is2faForced(),
    ]);
    res.json({ success: true, data: { ...status, allowed, forced } });
  } catch (err) {
    next(err);
  }
});

/** Step 1 — mint a candidate secret and return the QR for it. */
router.post('/totp/setup', requireAuth, async (req, res, next) => {
  try {
    await assert2faAllowed();
    const userId = currentUserId(req);
    const user = await userService.getById(userId);
    if (!user) throw unauthorized('User not found');

    const enrolment = await twoFactorService.beginTotpEnrolment(userId, user.username);
    res.json({ success: true, data: enrolment });
  } catch (err) {
    next(err);
  }
});

/** Step 2 — a code from the authenticator arms the factor. */
router.post('/totp/enable', requireAuth, mfaLimiter, validate(totpEnableSchema), async (req, res, next) => {
  try {
    await assert2faAllowed();
    const userId = currentUserId(req);
    const { code } = req.body as TotpEnableInput;

    if (!(await twoFactorService.confirmTotpEnrolment(userId, code))) {
      throw badRequest('That code is not valid — check your device clock, or start the setup again');
    }

    await auditFactor(req, userId, 'auth.2fa_enable', { method: 'totp' });
    res.json({ success: true, data: { totpEnabled: true } });
  } catch (err) {
    next(err);
  }
});

router.delete('/totp', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    await twoFactorService.disableTotp(userId);
    await auditFactor(req, userId, 'auth.2fa_disable', { method: 'totp' });
    res.json({ success: true, data: { totpEnabled: false } });
  } catch (err) {
    next(err);
  }
});

/** Step 1 — mail a code to the address being enrolled. */
router.post(
  '/email/setup',
  requireAuth,
  mfaLimiter,
  validate(emailOtpSetupSchema),
  async (req, res, next) => {
    try {
      await assert2faAllowed();
      const { email } = req.body as EmailOtpSetupInput;

      // Nothing is written to the user here — the candidate address lives only
      // inside the session hash until `/email/enable` proves the inbox.
      const code = twoFactorService.generateEmailOtp();
      req.session.pendingEmailOtpHash = twoFactorService.hashEmailOtp(email, code);
      req.session.pendingMfaExpiresAt = Date.now() + EMAIL_OTP_TTL_MS;
      await saveSession(req);

      try {
        await twoFactorService.sendEmailOtp(email, code);
      } catch (err) {
        if (err instanceof NoSmtpConfiguredError) {
          throw new AppError(
            503,
            'No SMTP server is configured for one-time codes — ask your administrator',
            { code: 'internal_error' },
          );
        }
        throw err;
      }

      res.json({ success: true, data: { sent: true, email, expiresAt: req.session.pendingMfaExpiresAt } });
    } catch (err) {
      next(err);
    }
  },
);

/** Step 2 — the code proves the inbox, and only then does the address move. */
router.post(
  '/email/enable',
  requireAuth,
  mfaLimiter,
  validate(emailOtpEnableSchema),
  async (req, res, next) => {
    try {
      await assert2faAllowed();
      const userId = currentUserId(req);
      const { email, code } = req.body as EmailOtpEnableInput;

      const ok = twoFactorService.verifyEmailOtp(
        req.session.pendingEmailOtpHash,
        req.session.pendingMfaExpiresAt,
        email,
        code,
      );
      if (!ok) throw badRequest('That code is not valid or has expired');

      await twoFactorService.enableEmailOtp(userId, email);

      delete req.session.pendingEmailOtpHash;
      delete req.session.pendingMfaExpiresAt;
      await saveSession(req);

      await auditFactor(req, userId, 'auth.2fa_enable', { method: 'email_otp', email });
      res.json({ success: true, data: { emailOtpEnabled: true } });
    } catch (err) {
      next(err);
    }
  },
);

router.delete('/email', requireAuth, async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    await twoFactorService.disableEmailOtp(userId);
    await auditFactor(req, userId, 'auth.2fa_disable', { method: 'email_otp' });
    res.json({ success: true, data: { emailOtpEnabled: false } });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Login step 2 — a half-authenticated session
// ═════════════════════════════════════════════════════════════════════════════

router.post('/verify', mfaLimiter, requirePendingMfa, validate(mfaVerifySchema), async (req, res, next) => {
  try {
    const pendingUserId = req.session.pendingUserId;
    if (!pendingUserId) throw unauthorized('No sign-in is waiting for a code');

    const { method, code } = req.body as MfaVerifyInput;
    const user = await userService.getById(pendingUserId);

    if (!user || !user.isActive) {
      delete req.session.pendingUserId;
      throw unauthorized('User not found');
    }

    let valid = false;
    if (method === 'totp' && user.totpEnabled) {
      const secret = await twoFactorService.getTotpSecret(pendingUserId);
      if (!secret) {
        logger.warn({ userId: pendingUserId }, '2fa: totp_enabled is set but no secret is stored');
      } else {
        valid = twoFactorService.verifyTotp(secret, code);
      }
    } else if (method === 'email' && user.emailOtpEnabled && user.email) {
      valid = twoFactorService.verifyEmailOtp(
        req.session.pendingEmailOtpHash,
        req.session.pendingMfaExpiresAt,
        user.email,
        code,
      );
    }

    if (!valid) throw unauthorized('That code is not valid');

    const tenantSlug = req.session.requestedTenantSlug;
    // `completeLogin` clears every pending field as it promotes the session,
    // so the half-authenticated state cannot survive alongside the real one.
    await authController.completeLogin(req, res, user, tenantSlug);
  } catch (err) {
    next(err);
  }
});

router.post('/resend', mfaLimiter, requirePendingMfa, async (req, res, next) => {
  try {
    const pendingUserId = req.session.pendingUserId;
    if (!pendingUserId) throw unauthorized('No sign-in is waiting for a code');

    const status = await twoFactorService.getStatus(pendingUserId);
    if (!status.emailOtpEnabled || !status.email) {
      throw badRequest('E-mail codes are not enabled for this account');
    }

    const code = twoFactorService.generateEmailOtp();
    req.session.pendingEmailOtpHash = twoFactorService.hashEmailOtp(status.email, code);
    req.session.pendingMfaExpiresAt = Date.now() + EMAIL_OTP_TTL_MS;
    await saveSession(req);

    try {
      await twoFactorService.sendEmailOtp(status.email, code);
    } catch (err) {
      if (err instanceof NoSmtpConfiguredError) {
        throw new AppError(503, 'The code could not be sent — no SMTP server is configured', {
          code: 'internal_error',
        });
      }
      throw err;
    }

    res.json({ success: true, data: { sent: true, expiresAt: req.session.pendingMfaExpiresAt } });
  } catch (err) {
    next(err);
  }
});

export default router;
