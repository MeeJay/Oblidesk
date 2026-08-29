/**
 * twoFactor.service.ts — TOTP (otpauth + qrcode) and e-mail OTP.
 *
 * Two decisions worth knowing before reading:
 *
 *  1. THE CANDIDATE TOTP SECRET LIVES IN THE DATABASE, NOT THE SESSION.
 *     `beginTotpEnrolment` writes `users.totp_secret` while `totp_enabled`
 *     stays false. Nothing is half-enabled — `totp_enabled` is the only gate
 *     any login path reads — and the enrolment survives the QR being scanned
 *     on a phone while the desktop session is replaced (the ObliTools shell
 *     re-authenticates with `X-Auth-Token`, which is a different session id).
 *     The alternative, a secret parked in the session store, silently loses
 *     the enrolment in exactly that case.
 *
 *  2. AN E-MAILED CODE IS NEVER STORED IN CLEAR, AND IS BOUND TO ITS ADDRESS.
 *     The session keeps `sha256(address:code)` (`pendingEmailOtpHash`), so the
 *     session table — an ordinary Postgres table — never holds a live code,
 *     and a code mailed to one address cannot be used to enrol another. The
 *     comparison is constant-time.
 *
 * The mail path goes through `smtpServerService`, which owns SMTP credentials
 * and their decryption; this module only picks WHICH server sends auth mail.
 */

import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import nodemailer from 'nodemailer';
import { db } from '../db';
import { config } from '../config';
import { generateNumericCode, safeEqual, sha256Hex } from '../utils/crypto';
import { logger } from '../utils/logger';
import { appConfigService } from './appConfig.service';
import { smtpServerService } from './smtpServer.service';
import type { SmtpTransportConfig } from './smtpServer.service';

/** How long a mailed one-time code stays valid. */
export const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;

/** Raised when auth mail is requested on an installation with no SMTP server. */
export class NoSmtpConfiguredError extends Error {
  constructor() {
    super('NO_SMTP_CONFIGURED');
    this.name = 'NoSmtpConfiguredError';
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Auth mail
// ═════════════════════════════════════════════════════════════════════════════

export const authMailer = {
  /**
   * The SMTP server that sends authentication mail.
   *
   * Auth mail is sent BEFORE a tenant is resolved — a login code goes out
   * while the session still has none — so this uses the configured OTP server
   * and falls back to the platform default. Tenant-owned servers are for
   * ticket notifications, where a tenant is always in hand.
   */
  async resolve(): Promise<SmtpTransportConfig | null> {
    const configured = await appConfigService.getOtpSmtpServerId();
    if (configured !== null) {
      const transport = await smtpServerService.getTransportConfig(configured);
      if (transport) return transport;
      logger.warn({ smtpServerId: configured }, 'auth mail: configured OTP server is gone — falling back');
    }

    const platform = await smtpServerService.listPlatform();
    if (platform.length === 0) return null;
    const chosen = platform.find((server) => server.isDefault) ?? platform[0];
    return smtpServerService.getTransportConfig(chosen.id);
  },

  async send(message: { to: string; subject: string; text: string; html: string }): Promise<void> {
    const smtp = await this.resolve();
    if (!smtp) throw new NoSmtpConfiguredError();

    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.username ? { user: smtp.username, pass: smtp.password ?? '' } : undefined,
    });

    await transport.sendMail({
      from: smtp.fromName ? `"${smtp.fromName}" <${smtp.fromAddress}>` : smtp.fromAddress,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Service
// ═════════════════════════════════════════════════════════════════════════════

export const twoFactorService = {
  // ── TOTP ──────────────────────────────────────────────────────────────────

  generateTotpSecret(username: string): { secret: string; uri: string } {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: config.appName,
      label: username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
    return { secret: secret.base32, uri: totp.toString() };
  },

  async generateTotpQr(uri: string): Promise<string> {
    return QRCode.toDataURL(uri);
  },

  /**
   * `window: 2` accepts ±60 s of clock drift — the suite-wide setting. A phone
   * whose clock is a minute out is the single most common support ticket 2FA
   * generates, and it is not an attack.
   */
  verifyTotp(secret: string, code: string): boolean {
    try {
      const totp = new OTPAuth.TOTP({
        issuer: config.appName,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret.trim()),
      });
      return totp.validate({ token: code.trim(), window: 2 }) !== null;
    } catch (err) {
      logger.warn({ err }, '2fa: TOTP verification threw — the stored secret may be malformed');
      return false;
    }
  },

  /**
   * Step 1 of enrolment: mint a secret, store it as a CANDIDATE (enabled stays
   * false) and hand back the QR. Re-running it replaces the candidate, which
   * is what a user who lost the QR expects.
   */
  async beginTotpEnrolment(
    userId: number,
    username: string,
  ): Promise<{ secret: string; uri: string; qrDataUrl: string }> {
    const { secret, uri } = this.generateTotpSecret(username);
    await db('users').where({ id: userId }).update({
      totp_secret: secret,
      totp_enabled: false,
      updated_at: new Date(),
    });
    return { secret, uri, qrDataUrl: await this.generateTotpQr(uri) };
  },

  /** Step 2: prove the authenticator works, then arm the factor. */
  async confirmTotpEnrolment(userId: number, code: string): Promise<boolean> {
    const secret = await this.getTotpSecret(userId);
    if (!secret) return false;
    if (!this.verifyTotp(secret, code)) return false;

    await db('users').where({ id: userId }).update({
      totp_enabled: true,
      updated_at: new Date(),
    });
    return true;
  },

  async disableTotp(userId: number): Promise<void> {
    await db('users').where({ id: userId }).update({
      totp_secret: null,
      totp_enabled: false,
      updated_at: new Date(),
    });
  },

  /** The stored secret. Only the verification paths may call this. */
  async getTotpSecret(userId: number): Promise<string | null> {
    const row = (await db('users').where({ id: userId }).first('totp_secret')) as
      | { totp_secret: string | null }
      | undefined;
    return row?.totp_secret ?? null;
  },

  // ── E-mail OTP ────────────────────────────────────────────────────────────

  /** Six digits from a CSPRNG — an OTP from `Math.random` is not a factor. */
  generateEmailOtp(): string {
    return generateNumericCode(6);
  },

  /**
   * The value parked in `session.pendingEmailOtpHash`. Binding the address in
   * means a code mailed to one inbox cannot be replayed to enrol another.
   */
  hashEmailOtp(email: string, code: string): string {
    return sha256Hex(`${email.trim().toLowerCase()}:${String(code).trim()}`);
  },

  /** Constant-time check of a code against the hash held in the session. */
  verifyEmailOtp(
    pendingHash: string | undefined,
    expiresAt: number | undefined,
    email: string,
    code: string,
  ): boolean {
    if (!pendingHash) return false;
    if (expiresAt !== undefined && expiresAt > 0 && Date.now() > expiresAt) return false;
    return safeEqual(pendingHash, this.hashEmailOtp(email, code));
  },

  /**
   * Mail a one-time code. Throws {@link NoSmtpConfiguredError} when the
   * installation has no SMTP server, so the caller can say so instead of
   * showing a code field no code will ever arrive for.
   */
  async sendEmailOtp(toEmail: string, code: string): Promise<void> {
    const appName = config.appName;

    await authMailer.send({
      to: toEmail,
      subject: `${appName} — code de verification`,
      text:
        `Votre code de verification est : ${code}\n` +
        `Il expire dans 10 minutes.\n\n` +
        `Your verification code is: ${code}\n` +
        `It expires in 10 minutes. If you did not request it, ignore this message.`,
      html: `
        <h2 style="font-family:sans-serif">${appName}</h2>
        <p style="font-family:sans-serif">Votre code de verification / your verification code:</p>
        <p style="letter-spacing:10px;font-family:monospace;font-size:32px;font-weight:600">${code}</p>
        <p style="color:#889;font-size:12px;font-family:sans-serif">
          Ce code expire dans 10 minutes. Si vous n'etes pas a l'origine de cette demande, ignorez ce message.<br />
          This code expires in 10 minutes. If you did not request it, ignore this email.
        </p>
      `,
    });

    logger.info({ to: toEmail }, '2fa: one-time code sent');
  },

  async enableEmailOtp(userId: number, email: string): Promise<void> {
    await db('users').where({ id: userId }).update({
      email,
      email_otp_enabled: true,
      updated_at: new Date(),
    });
  },

  async disableEmailOtp(userId: number): Promise<void> {
    await db('users').where({ id: userId }).update({
      email_otp_enabled: false,
      updated_at: new Date(),
    });
  },

  // ── State ─────────────────────────────────────────────────────────────────

  async getStatus(
    userId: number,
  ): Promise<{ totpEnabled: boolean; emailOtpEnabled: boolean; email: string | null }> {
    const row = (await db('users')
      .where({ id: userId })
      .first('totp_enabled', 'email_otp_enabled', 'email')) as
      | { totp_enabled: boolean; email_otp_enabled: boolean; email: string | null }
      | undefined;

    return {
      totpEnabled: row?.totp_enabled ?? false,
      emailOtpEnabled: row?.email_otp_enabled ?? false,
      email: row?.email ?? null,
    };
  },
};

export default twoFactorService;
