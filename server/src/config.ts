/**
 * config.ts — the ONE typed view of the environment.
 *
 * Nothing else in the server reads `process.env` directly. Two reasons:
 *   1. a typo in `proces.env.SESSION_SECERT` is `undefined`, and `undefined`
 *      silently becomes a dev default at the call site — here it becomes a
 *      startup failure instead;
 *   2. every knob is documented in one place, next to its default, so
 *      `.env.example` and the code cannot drift apart unnoticed.
 *
 * Ordering: `./env` (dotenv) must already have run. It is imported first by
 * `src/index.ts` and by `knexfile.ts`; importing it here as well is harmless
 * (dotenv never overwrites an already-set variable) and makes this module safe
 * to import from a script that forgot.
 *
 * PRODUCTION FAIL-FAST: `assertProductionConfig()` is called from
 * `createApp()` and refuses to start when a secret is still the shipped
 * placeholder. An open-source repo means the defaults are public; a session
 * signed with `dev-secret-change-me` is forgeable by anyone who can read
 * GitHub.
 */
import './env';
import path from 'path';
import { existsSync } from 'fs';
import { APP_NAME, DEFAULT_TICKET_PREFIX } from '@oblidesk/shared';

// ── Small readers ────────────────────────────────────────────────────────────

function str(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function optionalStr(key: string): string | null {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? null : raw.trim();
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * `int` with bounds, for the knobs where a plausible typo is worse than a
 * missing value: `SLA_VERIFY_HOUR=25` never runs the verifier at all, and a
 * scheduler interval of `0` is a spin loop. An out-of-range value falls back to
 * the shipped default, exactly as an unparseable one already does — the reader
 * cannot log (the logger reads this module), so the contract is "a bad value is
 * the default", never "a bad value is honoured".
 */
function intInRange(key: string, fallback: number, min: number, max: number): number {
  const value = int(key, fallback);
  return value >= min && value <= max ? value : fallback;
}

function bool(key: string, fallback = false): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * CLIENT_ORIGIN may be a single origin or a comma-separated list — a desk that
 * is reached both as `https://desk.acme.tld` and through the ObliTools shell
 * needs both, and `cors({ origin: [...] })` takes an array happily.
 */
function originList(key: string, fallback: string): string[] {
  return str(key, fallback)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

// ── Environment ──────────────────────────────────────────────────────────────

const nodeEnv = str('NODE_ENV', 'development');
const isProd = nodeEnv === 'production';
const isDev = !isProd;
const isTest = nodeEnv === 'test';

/** The shipped placeholders. Any of these in production is a hard stop. */
const PLACEHOLDER_SECRETS = new Set([
  'dev-secret',
  'dev-secret-change-me',
  'change-this-secret',
  'change-this-in-production',
  'change-this-to-a-random-secret',
  'changeme',
]);

const sessionSecret = str('SESSION_SECRET', 'dev-secret-change-me');
const encryptionKey = optionalStr('ENCRYPTION_KEY');

export const config = {
  // ── Runtime ───────────────────────────────────────────────────────────────
  nodeEnv,
  isDev,
  isProd,
  isTest,

  /** Fixed by the suite's port map: Oblidesk's API is 3001, the client 3004. */
  port: int('PORT', 3001),

  // ── Database ──────────────────────────────────────────────────────────────
  databaseUrl: str(
    'DATABASE_URL',
    'postgres://oblidesk:changeme@localhost:5432/oblidesk',
  ),

  // ── Session ───────────────────────────────────────────────────────────────
  sessionSecret,
  /** Seven days — matches the rest of the suite so a shared ObliTools shell
   *  does not log the operator out of one app while another stays alive. */
  sessionMaxAge: int('SESSION_MAX_AGE_MS', 7 * 24 * 60 * 60 * 1000),
  /** connect-pg-simple table. Created by migration 001, never by the store. */
  sessionTable: 'session',

  // ── CORS / links ──────────────────────────────────────────────────────────
  clientOrigin: originList('CLIENT_ORIGIN', 'http://localhost:5177'),
  /** Absolute base used in e-mailed links (password reset, portal replies). */
  appUrl: str('APP_URL', str('CLIENT_ORIGIN', 'http://localhost:5177').split(',')[0].trim()),
  /** Set when a TLS-terminating proxy sits in front; forces `secure` cookies. */
  forceHttps: bool('FORCE_HTTPS'),

  // ── Identity ──────────────────────────────────────────────────────────────
  appName: str('APP_NAME', APP_NAME),
  /** Default human ticket-number prefix for a tenant that has not chosen one. */
  defaultTicketPrefix: str('DEFAULT_TICKET_PREFIX', DEFAULT_TICKET_PREFIX),

  // ── Bootstrap admin (seeded on an empty database) ─────────────────────────
  defaultAdminUsername: str('DEFAULT_ADMIN_USERNAME', 'admin'),
  defaultAdminPassword: str('DEFAULT_ADMIN_PASSWORD', 'admin123'),
  defaultAdminEmail: optionalStr('DEFAULT_ADMIN_EMAIL'),

  // ── Secrets at rest ───────────────────────────────────────────────────────
  /**
   * AES-256-GCM key as 64 hex characters. Encrypts IMAP/SMTP passwords, OAuth
   * refresh tokens and webhook signing keys. NULL in development, where
   * `utils/crypto` falls back to a key derived from SESSION_SECRET — losing
   * either makes the stored ciphertext unreadable, which is why production
   * refuses to start without an explicit one.
   */
  encryptionKey,

  // ── Blob store (HARD RULE 9) ──────────────────────────────────────────────
  /**
   * Attachment bytes live under
   * `<customDir>/attachments/<tenant>/<yyyy>/<mm>/<sha256[0:2]>/<sha256>`.
   *
   * The default keys off CONTAINER, not off NODE_ENV. Both compose files bind
   * a host directory to `/custom` inside the container and neither sets
   * CUSTOM_DIR in the server's environment — so a `NODE_ENV=development`
   * container (which is exactly what `npm run dev` starts) would otherwise
   * write blobs to `/app/server/custom` and leave the mounted volume empty,
   * losing every attachment on the next rebuild.
   */
  customDir: path.resolve(
    str('CUSTOM_DIR', existsSync('/.dockerenv') ? '/custom' : path.join(process.cwd(), 'custom')),
  ),

  // ── Background workers ────────────────────────────────────────────────────
  /** SLA sweep cadence. One minute is the contract the UI countdown assumes. */
  slaTickIntervalMs: int('SLA_TICK_INTERVAL_MS', 60_000),
  /** Notification outbox drain cadence. */
  outboxIntervalMs: int('OUTBOX_INTERVAL_MS', 5_000),
  /**
   * How often the scheduled-rule sweep looks for `trigger: schedule` rules that
   * have come due. This is the SWEEP cadence, not a rule's own cadence — a rule
   * that asks for "every 5 minutes" still fires every 5 minutes; this only
   * bounds how late it can be. Named for the variable `rule.service.ts` already
   * reads so the two cannot disagree.
   */
  ruleScheduleIntervalMs: intInRange('RULES_SCHEDULE_INTERVAL_MS', 60_000, 1_000, 60 * 60_000),
  /** How often a non-leader replica retries the boot advisory lock. */
  leaderRetryIntervalMs: int('LEADER_RETRY_INTERVAL_MS', 30_000),
  /** Set to `true` on a replica that must never run the tickers. */
  disableBackgroundWorkers: bool('DISABLE_BACKGROUND_WORKERS'),

  // ── SLA engine tuning ─────────────────────────────────────────────────────
  // These four were module constants in `sla.service.ts`. They are here because
  // each of them is a POLICY an operator may legitimately disagree with, and
  // "edit the source and rebuild" is not a way to disagree with a policy.
  /**
   * Local hour on the SERVER clock at which the nightly ledger verifier runs.
   * It reads every live instance, so it wants the quiet hour of the install's
   * own timezone — which is not 03:00 everywhere.
   */
  slaVerifyHour: intInRange('SLA_VERIFY_HOUR', 3, 0, 23),
  /**
   * A ticket the alert spine opened and auto-closed inside this window produced
   * no human work, so it produces no SLA outcome. Raise it on a desk with a
   * flappier monitor; lower it on one where a two-minute incident is real.
   */
  slaAlertAutoResolveGraceMs: intInRange('SLA_ALERT_AUTO_RESOLVE_GRACE_MS', 120_000, 0, 3_600_000),
  /**
   * A CI liveness reading older than this is not evidence, and the engine
   * refuses to pause on `device_offline` rather than counting silently. It
   * tracks the polling interval of whatever feeds `ci_state_cache`.
   */
  slaCiStateStaleAfterMs: intInRange('SLA_CI_STATE_STALE_AFTER_MS', 900_000, 60_000, 86_400_000),
  /** Verifier drift beyond this is reported. Below it is float noise. */
  slaDriftToleranceMs: intInRange('SLA_DRIFT_TOLERANCE_MS', 1_000, 0, 60_000),

  // ── Logging ───────────────────────────────────────────────────────────────
  logLevel: str('LOG_LEVEL', isDev ? 'debug' : 'info'),
} as const;

export type AppConfigView = typeof config;

/**
 * Refuse to boot a production install that is still wearing the demo's
 * clothes. Called once from `createApp()`; throws with a message an operator
 * can act on rather than a stack trace they cannot.
 */
export function assertProductionConfig(): void {
  if (!config.isProd) return;

  const problems: string[] = [];

  if (
    !config.sessionSecret ||
    PLACEHOLDER_SECRETS.has(config.sessionSecret) ||
    config.sessionSecret.length < 32
  ) {
    problems.push(
      'SESSION_SECRET must be a random value of at least 32 characters ' +
        '(generate one with: openssl rand -hex 32).',
    );
  }

  if (!config.encryptionKey) {
    problems.push(
      'ENCRYPTION_KEY is required in production — it encrypts mailbox and SMTP ' +
        'credentials at rest (generate one with: openssl rand -hex 32).',
    );
  } else if (!/^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) {
    problems.push('ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).');
  }

  if (!process.env.DATABASE_URL) {
    problems.push('DATABASE_URL must be set explicitly in production.');
  }

  if (config.defaultAdminPassword === 'admin123') {
    problems.push(
      'DEFAULT_ADMIN_PASSWORD is still the shipped default — set it before the ' +
        'first boot creates the bootstrap admin.',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start Oblidesk in production with an unsafe configuration:\n  - ${problems.join(
        '\n  - ',
      )}`,
    );
  }
}
