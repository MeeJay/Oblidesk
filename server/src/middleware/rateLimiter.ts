/**
 * rateLimiter.ts — protection for the endpoints an anonymous caller can reach.
 *
 * ── Why authenticated requests are skipped ──────────────────────────────────
 * Behind a reverse proxy every user shares one apparent IP. A global limit
 * would therefore be shared by the whole support team, and a busy Monday
 * morning would look exactly like an attack: agents refreshing queues would
 * lock each other out. Authenticated requests are already gated by the session
 * cookie and by RBAC, so the limiter adds no security there — it only adds
 * outages. Unauthenticated paths (login, SSO callback, the portal, alert
 * ingest) keep their limits, because those are the ones an attacker can
 * actually reach.
 *
 * ORDER MATTERS: `apiLimiter` is mounted AFTER express-session in app.ts, so
 * `req.session.userId` is populated by the time `skip()` runs. Move it before
 * the session middleware and every request looks anonymous.
 */
import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';

const FIVE_MINUTES = 5 * 60 * 1000;

const failure = (error: string): { success: false; error: string; code: 'rate_limited' } => ({
  success: false,
  error,
  code: 'rate_limited',
});

/** Paths that must never be limited, whatever the caller's state. */
function isExemptPath(path: string): boolean {
  return (
    // Polled by the login screen to show the server version.
    path === '/health' ||
    // Returns 401 for anonymous callers and leaks nothing; the client polls it
    // on every page load to decide whether to show the login form.
    path === '/api/auth/me' ||
    // Socket.io's HTTP handshake and long-polling fallback.
    path.startsWith('/socket.io/')
  );
}

/**
 * Global limiter for anonymous traffic.
 * 500 requests / 5 minutes / IP — generous enough that a portal user browsing
 * their tickets never sees it, tight enough to make enumeration expensive.
 */
export const apiLimiter = rateLimit({
  windowMs: FIVE_MINUTES,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => Boolean(req.session?.userId) || isExemptPath(req.path),
  message: failure('Too many requests, please try again later'),
});

/**
 * Login limiter — stricter, and keyed on IP **plus** username.
 *
 *   a) a shared proxy IP does not put every user in one bucket, so user A
 *      fat-fingering their password cannot lock out user B;
 *   b) an attacker still cannot brute-force one account faster than the limit;
 *   c) `skipSuccessfulRequests` means a user who eventually types the right
 *      password is not punished for the typos that preceded it.
 *
 * `req.body` is readable here because this limiter is applied per-route in
 * auth.routes, after `express.json()` has run globally.
 */
export const authLimiter = rateLimit({
  windowMs: FIVE_MINUTES,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const ip = req.ip ?? 'unknown';
    const username = (req.body as { username?: string } | undefined)?.username
      ?.toLowerCase()
      ?.trim();
    return `${ip}:${username ?? ''}`;
  },
  message: failure('Too many sign-in attempts, please try again in 5 minutes'),
});

/**
 * Second-factor and password-reset limiter. Tighter than login: a 6-digit TOTP
 * has a million possibilities and a 30-second window, so 10 attempts per 5
 * minutes leaves an attacker needing centuries while a real user with a clock
 * drift gets several tries.
 */
export const mfaLimiter = rateLimit({
  windowMs: FIVE_MINUTES,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `${req.ip ?? 'unknown'}:${req.session?.pendingUserId ?? ''}`,
  message: failure('Too many verification attempts, please try again shortly'),
});

/**
 * Alert ingest from the sibling apps (Obliguard bans, Obliview outages…).
 * Machine-to-machine and API-key authenticated, so it gets its own generous
 * bucket rather than sharing the anonymous one — an outage storm legitimately
 * fires hundreds of alerts in a minute, and dropping those on the floor is
 * exactly when the desk is most needed.
 */
export const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: failure('Alert ingest rate exceeded'),
});

/**
 * Public portal (an unauthenticated requester filing or reading a ticket).
 * Sits between the anonymous default and the login limiter.
 */
export const portalLimiter = rateLimit({
  windowMs: FIVE_MINUTES,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: failure('Too many requests, please slow down'),
});

/**
 * Attachment uploads — bounded by count here and by
 * `LIMITS.attachmentMaxBytes` in the multer config. Both matter: one stops a
 * thousand small files, the other stops one enormous one.
 */
export const uploadLimiter = rateLimit({
  windowMs: FIVE_MINUTES,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  // Keyed per user, not per IP: one agent bulk-attaching evidence to an
  // incident must not throttle the colleague sitting behind the same proxy.
  keyGenerator: (req: Request) => `${req.session?.userId ?? req.ip ?? 'unknown'}`,
  message: failure('Too many uploads, please try again shortly'),
});

/**
 * AI assists cost money per call. The budget ledger (`ai_usage_ledger`) is the
 * real control; this is the cheap first line that stops a stuck client from
 * spending it in a loop.
 */
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `${req.session?.userId ?? req.ip ?? 'unknown'}`,
  message: failure('AI assist rate exceeded, please wait a moment'),
});

/** Build a one-off limiter for a route that needs its own bucket. */
export function createLimiter(options: Partial<Options>) {
  return rateLimit({
    windowMs: FIVE_MINUTES,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: failure('Too many requests, please try again later'),
    ...options,
  });
}
