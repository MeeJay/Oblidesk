/**
 * logger.ts — the single pino instance.
 *
 * Pretty-printed in development, newline-delimited JSON in production (which is
 * what `docker compose logs` and any log shipper actually want).
 *
 * Redaction is not optional: a request log that includes `authorization` or a
 * body with `password` turns the log file into a credential store. The paths
 * below cover every shape a secret arrives in on this server — session cookies,
 * SMTP/IMAP passwords, the AES key, TOTP secrets and Obligate API keys.
 */
import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.logLevel,
  base: { app: 'oblidesk' },
  redact: {
    paths: [
      'password',
      'passwordHash',
      'password_hash',
      'passwordEnc',
      'password_enc',
      'totpSecret',
      'totp_secret',
      'apiKey',
      'api_key',
      'encryptionKey',
      'sessionSecret',
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-auth-token"]',
      'req.headers["x-api-key"]',
      'headers.cookie',
      'headers.authorization',
      'body.password',
      'body.newPassword',
      'body.currentPassword',
      'body.totpCode',
      'body.mfaToken',
      '*.password',
      '*.password_enc',
      '*.totp_secret',
    ],
    censor: '[redacted]',
  },
  transport: config.isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
    : undefined,
});

/**
 * A child logger tagged with a subsystem name, so a grep for
 * `"subsystem":"sla"` returns exactly one engine's trail.
 */
export function subsystemLogger(subsystem: string): pino.Logger {
  return logger.child({ subsystem });
}
