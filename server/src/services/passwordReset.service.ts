/**
 * passwordReset.service.ts — "forgot password", by e-mailed one-time link.
 *
 * The link carries 32 random bytes; only their SHA-256 digest is stored
 * (`password_reset_tokens.token`), so a dump of that table cannot be replayed
 * into anyone's account. A token is single use (`used_at`), expires after an
 * hour, and issuing a new one invalidates every pending token for that user.
 *
 * `requestReset` ALWAYS resolves, and always in about the same time, whether
 * the address is known, unknown, or belongs to an SSO-only account. A
 * different answer for a known address turns this endpoint into a user
 * directory, which is exactly the reconnaissance a password reset flow is
 * usually asked to leak.
 *
 * The password write goes through `userService.setPassword`, which bumps
 * `enrollment_version` in the same transaction — that is what actually logs
 * the old sessions out. Writing `password_hash` here directly would leave
 * whoever stole the account happily signed in with the OLD password's session.
 */

import { db } from '../db';
import { config } from '../config';
import { generateToken, hashPassword, sha256Hex } from '../utils/crypto';
import { logger } from '../utils/logger';
import { authService } from './auth.service';
import { authMailer, NoSmtpConfiguredError } from './twoFactor.service';
import { userService } from './user.service';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

interface ResetContext {
  ip?: string | null;
  userAgent?: string | null;
  /** Absolute origin of the request, so the link points at the host used. */
  origin?: string | null;
}

function tokenDigest(rawToken: string): string {
  return sha256Hex(rawToken);
}

export const passwordResetService = {
  /**
   * Issue a token and mail it. Silent (but logged) when the address is
   * unknown, when the account authenticates through Obligate — there is no
   * local password to reset — or when no SMTP server is configured.
   */
  async requestReset(email: string, ctx: ResetContext = {}): Promise<void> {
    const user = (await db('users')
      .where({ email })
      .first('id', 'email', 'auth_source', 'password_hash', 'is_active')) as
      | {
          id: number;
          email: string | null;
          auth_source: string;
          password_hash: string | null;
          is_active: boolean;
        }
      | undefined;

    if (!user || !user.email || !user.is_active) {
      logger.info('password reset: requested for an address with no active local account');
      return;
    }

    if (!user.password_hash && user.auth_source !== 'local') {
      // An SSO-only account has no local password; a reset link would lead to
      // a page that cannot help. The operator sees why in the log.
      logger.info({ userId: user.id, authSource: user.auth_source },
        'password reset: refused for an SSO-managed account');
      return;
    }

    // One live token per user: issuing a new link must invalidate the old one,
    // or a link forwarded to the wrong person stays usable after the fix.
    await db('password_reset_tokens').where({ user_id: user.id }).whereNull('used_at').del();

    const rawToken = generateToken(32);
    await db('password_reset_tokens').insert({
      user_id: user.id,
      token: tokenDigest(rawToken),
      expires_at: new Date(Date.now() + TOKEN_TTL_MS),
    });

    const base = (ctx.origin || config.appUrl).replace(/\/+$/, '');
    const resetUrl = `${base}/reset-password?token=${rawToken}`;
    const appName = config.appName;

    try {
      await authMailer.send({
        to: user.email,
        subject: `${appName} — reinitialisation du mot de passe`,
        text:
          `Une reinitialisation de mot de passe a ete demandee pour votre compte ${appName}.\n\n` +
          `Ouvrez ce lien (valable 1 heure) :\n${resetUrl}\n\n` +
          `Si vous n'etes pas a l'origine de cette demande, ignorez ce message.\n\n` +
          `A password reset was requested for your ${appName} account. The link above is valid for one hour.`,
        html: `
          <h2 style="font-family:sans-serif">${appName}</h2>
          <p style="font-family:sans-serif">Une reinitialisation de mot de passe a ete demandee pour votre compte.</p>
          <p style="margin:24px 0">
            <a href="${resetUrl}" style="background:#22b8f5;color:#04202b;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-family:sans-serif">
              Reinitialiser le mot de passe
            </a>
          </p>
          <p style="color:#889;font-size:12px;font-family:sans-serif">
            Ce lien expire dans 1 heure. Si vous n'etes pas a l'origine de cette demande, ignorez ce message.<br />
            This link expires in one hour. If you did not request it, ignore this email.
          </p>
        `,
      });
      logger.info({ userId: user.id }, 'password reset: link sent');
    } catch (err) {
      if (err instanceof NoSmtpConfiguredError) {
        logger.warn('password reset: no SMTP server is configured — the link could not be sent');
        return;
      }
      logger.error({ err, userId: user.id }, 'password reset: the link could not be sent');
    }
  },

  /** The user id a live token belongs to, or null. */
  async validateToken(rawToken: string): Promise<number | null> {
    const row = (await db('password_reset_tokens')
      .where({ token: tokenDigest(rawToken) })
      .whereNull('used_at')
      .where('expires_at', '>', new Date())
      .first('user_id')) as { user_id: number } | undefined;
    return row?.user_id ?? null;
  },

  /**
   * Consume a token and set the new password.
   *
   * The token is claimed with a conditional UPDATE ... RETURNING before the
   * password is touched: two clicks on the same link race, and the loser must
   * get "expired", not a second password change.
   */
  async resetPassword(rawToken: string, newPassword: string, ctx: ResetContext = {}): Promise<boolean> {
    const claimed = (await db('password_reset_tokens')
      .where({ token: tokenDigest(rawToken) })
      .whereNull('used_at')
      .where('expires_at', '>', new Date())
      .update({ used_at: new Date() })
      .returning(['id', 'user_id'])) as Array<{ id: number; user_id: number }>;

    if (claimed.length === 0) return false;
    const userId = claimed[0].user_id;

    // `setPassword` bumps enrollment_version (logging the old sessions out)
    // and writes the audit row inside its own transaction. `actorId === userId`
    // is what distinguishes a self-service reset from an admin-forced one.
    const tenantId = await authService.auditTenantFor(userId);
    if (tenantId !== null) {
      await userService.setPassword(userId, newPassword, {
        tenantId,
        actorId: userId,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      });
    } else {
      // An account that belongs to no tenant at all: still reset the password,
      // but say plainly that the change could not be audited.
      logger.warn({ userId }, 'password reset: no tenant to file the audit row against');
      await db('users').where({ id: userId }).update({
        password_hash: await hashPassword(newPassword),
        enrollment_version: db.raw('enrollment_version + 1'),
        updated_at: new Date(),
      });
    }

    logger.info({ userId }, 'password reset: completed');
    return true;
  },

  /** Housekeeping: drop spent and expired tokens. Safe to run on a timer. */
  async purgeExpired(): Promise<number> {
    return db('password_reset_tokens')
      .where((builder) => builder.where('expires_at', '<', new Date()).orWhereNotNull('used_at'))
      .del();
  },
};

export default passwordResetService;
