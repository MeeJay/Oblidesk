/**
 * crypto.ts — password hashing, random tokens, symmetric encryption of stored
 * secrets, and the content hashes the attachment store and the audit chain
 * depend on.
 *
 * Everything here is deliberately small and dependency-free apart from bcrypt:
 * cryptography that is easy to read is cryptography whose misuse is visible in
 * review.
 */
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { config } from '../config';

/** 12 rounds — the suite-wide setting; matches what the seeds hashed with. */
const SALT_ROUNDS = 12;

// ═════════════════════════════════════════════════════════════════════════════
// Passwords
// ═════════════════════════════════════════════════════════════════════════════

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false (never throws) when `hash` is null — an SSO-only account has no
 * local password, and a thrown error there would leak "this account exists but
 * has no password" through a different response shape.
 */
export async function comparePassword(
  password: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (!hash) {
    // Burn a comparable amount of time so "no local password" and "wrong
    // password" cannot be told apart by response latency.
    await bcrypt.compare(password, '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    return false;
  }
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Random values
// ═════════════════════════════════════════════════════════════════════════════

/** Cryptographically random hex string of `length` BYTES (2×length chars). */
export function generateToken(length = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/** URL-safe random token — for links that end up in an e-mail. */
export function generateUrlToken(length = 32): string {
  return crypto.randomBytes(length).toString('base64url');
}

/** Numeric one-time code, zero-padded, uniform (no modulo bias worth caring about). */
export function generateNumericCode(digits = 6): string {
  const max = 10 ** digits;
  const value = crypto.randomInt(0, max);
  return value.toString().padStart(digits, '0');
}

/**
 * Timing-safe string comparison. Use it for anything an attacker can submit
 * repeatedly: OTP codes, reset tokens, webhook signatures.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) {
    // Still do a comparison so the early return does not itself leak length.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ═════════════════════════════════════════════════════════════════════════════
// Content hashes
// ═════════════════════════════════════════════════════════════════════════════

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Deterministic JSON: object keys sorted at every depth, so two structurally
 * equal bodies always hash to the same value regardless of insertion order.
 * This is what makes `config_objects.checksum` a usable "did it change?" test
 * and what the audit hash chain canonicalises with.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

/** sha256 of the canonical JSON — used for config checksums and audit rows. */
export function checksumOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** HMAC-SHA256, base64 with the padding stripped. */
export function hmacSha256Base64(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '');
}

// ═════════════════════════════════════════════════════════════════════════════
// Session cookie signing — the ObliTools X-Auth-Token bridge
// ═════════════════════════════════════════════════════════════════════════════

/** The cookie name express-session uses by default. */
export const SESSION_COOKIE_NAME = 'connect.sid';

/**
 * Reproduce the exact value express-session would have put in the cookie for a
 * given session id: `s:<sid>.<hmac-sha256 base64, unpadded>`, URL-encoded.
 *
 * WHY this exists: ObliTools embeds the app in a cross-site WebView2 where
 * Chrome refuses to send cookies at all. The client therefore stores the
 * session id it was handed at login and sends it back as `X-Auth-Token`. Rather
 * than growing a second authentication path — which would drift from the first
 * and double the attack surface — the header is folded back into a cookie and
 * the ordinary session middleware validates it. The token by itself proves
 * nothing: the signature is recomputed here from SESSION_SECRET, and the
 * session store still has the final say on whether that id exists and is live.
 *
 * This is `cookie-signature`'s algorithm, reimplemented in four lines rather
 * than reached for through express-session's transitive dependency tree, where
 * a major bump could change it without this file noticing.
 */
export function signSessionCookie(sessionId: string): string {
  const signature = hmacSha256Base64(sessionId, config.sessionSecret);
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(`s:${sessionId}.${signature}`)}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Secrets at rest — AES-256-GCM
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The 32-byte key.
 *
 * ENCRYPTION_KEY is 64 hex characters and is REQUIRED in production
 * (`assertProductionConfig` refuses to boot without it). In development it may
 * be absent, and we derive a key from SESSION_SECRET so the mail settings page
 * still works — that derived key is not a security control, it is a
 * convenience, which is exactly why production will not accept it.
 */
export class MissingEncryptionKeyError extends Error {
  readonly status = 503;
  constructor() {
    super(
      'ENCRYPTION_KEY is not configured, so credentials cannot be stored. ' +
        'Set it (openssl rand -hex 32) and restart the server. Note that changing ' +
        'it later makes anything already encrypted unreadable.',
    );
    this.name = 'MissingEncryptionKeyError';
  }
}

function encryptionKey(): Buffer {
  if (config.encryptionKey && /^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) {
    return Buffer.from(config.encryptionKey, 'hex');
  }
  // In production, refuse rather than derive. Deriving from SESSION_SECRET
  // would "work" — right up until the operator rotates the session secret,
  // which is a routine, encouraged action, and every stored mailbox password
  // becomes undecryptable at once with no warning and no way back. Failing the
  // one request that wanted to store a secret is a far smaller problem than
  // silently coupling credential storage to a key meant to be rotated.
  if (config.isProd) throw new MissingEncryptionKeyError();
  return crypto.createHash('sha256').update(config.sessionSecret).digest();
}

/** Encrypt plaintext. Returns `iv:tag:ciphertext`, all hex. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

/** Decrypt a value produced by {@link encryptSecret}. Throws if tampered with. */
export function decryptSecret(encrypted: string): string {
  const [ivHex, tagHex, encHex] = encrypted.split(':');
  if (!ivHex || !tagHex || !encHex) throw new Error('Invalid encrypted value format');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final(),
  ]).toString('utf-8');
}

/**
 * Decrypt without throwing — for a display path that must survive a key
 * rotation gone wrong rather than 500 the whole settings page.
 */
export function tryDecryptSecret(encrypted: string | null | undefined): string | null {
  if (!encrypted) return null;
  try {
    return decryptSecret(encrypted);
  } catch {
    return null;
  }
}
