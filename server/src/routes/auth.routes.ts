/**
 * auth.routes.ts — the local authentication surface, mounted at `/api/auth`.
 *
 * The Obligate SSO endpoints live in `obligateCallback.routes.ts`, which is
 * mounted on this same prefix AND a second time at `/auth` (outside `/api`)
 * for the browser round trip.
 *
 * Every credential-bearing route is rate limited. `authLimiter` keys on IP +
 * username, so one user fat-fingering their password behind a shared NAT
 * cannot lock out the rest of the office; `mfaLimiter` is tighter, because a
 * six-digit code is a much smaller space than a password.
 */

import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';
import { authLimiter, mfaLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  resetTokenSchema,
} from '../validators/auth.validators';

const router = Router();

// ── Session lifecycle ────────────────────────────────────────────────────────
router.post('/login', authLimiter, validate(loginSchema), authController.login);
router.post('/logout', requireAuth, authController.logout);
router.get('/me', requireAuth, authController.me);

// ── Passwords ────────────────────────────────────────────────────────────────
router.post(
  '/change-password',
  requireAuth,
  authLimiter,
  validate(changePasswordSchema),
  authController.changePassword,
);
router.post('/forgot-password', mfaLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
router.post(
  '/reset-password/validate',
  mfaLimiter,
  validate(resetTokenSchema),
  authController.validateResetToken,
);
router.post('/reset-password', mfaLimiter, validate(resetPasswordSchema), authController.resetPassword);

export default router;
