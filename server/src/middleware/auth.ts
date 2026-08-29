/**
 * auth.ts — "is there a fully authenticated session behind this request?"
 *
 * Deliberately thin. It answers one question and attaches nothing beyond what
 * express-session already put there; tenancy is `tenant.ts`'s job and
 * capabilities are `rbac.ts`'s.
 *
 * The session-shape declaration lives in `src/types/express.d.ts` so there is
 * exactly one of it.
 *
 * NOTE on `pendingUserId`: a session that has passed the password check but not
 * yet the second factor carries `pendingUserId`, never `userId`. `requireAuth`
 * therefore refuses it — half-authenticated is not authenticated, and this is
 * the single line that keeps a 2FA prompt from being a suggestion.
 */
import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from './errorHandler';

/** Reject anything without a completed session. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    next(unauthorized());
    return;
  }
  next();
}

/**
 * Allow the request through either way, but leave `req.session.userId` in place
 * when present. For endpoints that answer differently to an anonymous caller
 * (the portal, `/api/auth/me`) rather than refusing them.
 */
export function optionalAuth(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

/**
 * Guard for the second-factor endpoints: there must be a half-authenticated
 * session, and it must not have expired while the user hunted for their phone.
 */
export function requirePendingMfa(req: Request, _res: Response, next: NextFunction): void {
  const pendingId = req.session?.pendingUserId;
  const expiresAt = req.session?.pendingMfaExpiresAt ?? 0;

  if (!pendingId) {
    next(unauthorized('No pending sign-in'));
    return;
  }
  if (expiresAt > 0 && Date.now() > expiresAt) {
    delete req.session.pendingUserId;
    delete req.session.pendingMfa;
    delete req.session.pendingMfaExpiresAt;
    delete req.session.pendingEmailOtpHash;
    next(unauthorized('Sign-in timed out, start again'));
    return;
  }
  next();
}

/**
 * The authenticated user id, for handlers that have already run `requireAuth`.
 * Throws rather than returning `undefined`, so a missing guard surfaces as a
 * 500 in development instead of a query silently scoped to `user_id = NaN`.
 */
export function currentUserId(req: Request): number {
  const userId = req.session?.userId;
  if (typeof userId !== 'number') {
    throw new Error(
      'currentUserId() called on a request with no session — is requireAuth missing from this route?',
    );
  }
  return userId;
}
