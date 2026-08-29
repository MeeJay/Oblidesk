/**
 * delegation.service.ts — borrowing the ACTING USER's authority, for 120 seconds.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  What this replaces, and why it had to be replaced
 * ─────────────────────────────────────────────────────────────────────────────
 * A cross-app read used to travel on ONE static API key per app, issued by
 * Obligate. When Oblidesk read a device out of Obliance it therefore read it
 * with OBLIDESK's authority, not the authority of the technician looking at the
 * screen: an agent could see, in the desk's context rail, a machine they could
 * not see if they logged into Obliance themselves. That is a permission bypass,
 * and this module is what removes it.
 *
 *   Oblidesk --"token for user 42, audience obliance, tenant acme"--> Obligate
 *                        (authenticated with Oblidesk's static app key)
 *   Obligate --short-lived signed token--> Oblidesk
 *   Oblidesk --direct call + token--> Obliance
 *
 * DATA NEVER TRANSITS OBLIGATE. Only the token does. Routing sibling data
 * through the SSO provider would make it a single point of failure for every
 * context rail in the suite, and would force it to model each app's per-object
 * permissions, which is exactly the duplication this design exists to avoid.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  The boundary that matters most
 * ─────────────────────────────────────────────────────────────────────────────
 * Obligate authorises IDENTITY, AUDIENCE and TENANT. It never decides whether
 * user 42 may read device 123 — that lives in the audience app, and only there.
 *
 * The token therefore says WHO, never WHAT THEY MAY DO. It carries no
 * permission, role, team, capability or scope LIST claim. `scp` is a single
 * coarse word ('read') kept for logging, and it is not authorisation. The
 * audience app re-derives every right from its own model. A permission list
 * copied into a token is a second permission model, and a duplicated permission
 * model drifts, and it drifts OPEN.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Why this module holds no key material
 * ─────────────────────────────────────────────────────────────────────────────
 * The signature is Ed25519 and ASYMMETRIC on purpose: with a shared secret,
 * every app able to VERIFY a token would also be able to MINT one, which is the
 * same bypass with extra steps. Obligate holds the private key; Oblidesk holds
 * neither half. Oblidesk cannot forge a token for a user, and this file
 * therefore does no cryptography at all — it asks, caches and hands over.
 *
 * The one signature-adjacent thing it does do is read the token's own claims
 * back (WITHOUT verifying them) and refuse to use a token whose `sub`, `aud` or
 * `ost` is not the one it asked for. That is not authorisation, it is a
 * mis-delivery guard: attaching a token minted for someone else to an outgoing
 * request would be precisely the bypass this module removes, so it is checked
 * rather than assumed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  There is no fallback, deliberately
 * ─────────────────────────────────────────────────────────────────────────────
 * When a token cannot be minted, every entry point here returns a refusal and
 * the caller degrades. It never retries with Oblidesk's static app key. A second
 * authorisation path is, by construction, the least exercised and the most
 * permissive one in the system, and it would silently restore the exact bypass
 * that justified writing this file.
 */

import { db } from '../db';
import { logger } from '../utils/logger';
import { appConfigService } from './appConfig.service';
import { auditService } from './audit.service';

// ═════════════════════════════════════════════════════════════════════════════
// Constants
// ═════════════════════════════════════════════════════════════════════════════

/**
 * This app's own app type, as registered in Obligate. Hardcoded rather than
 * configurable: it is the value the provider refuses as `audience_is_self`, and
 * a deployment that could rename it could aim a delegation at itself.
 */
const SELF_APP_TYPE = 'oblidesk';

/** The only scope the provider allowlists. A logging hint, never authorisation. */
const SCOPE = 'read';

/**
 * Shapes fixed by Obligate's typing contract, re-checked here so a malformed
 * value never reaches the wire, a cache key, or an audit row.
 */
const AUDIENCE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const TENANT_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

/**
 * Kept short on purpose. The mint sits INSIDE the caller's own budget (the
 * context rail allows itself 3.75 s upstream in total), so a slow Obligate must
 * not eat the whole allowance and leave nothing for the read the token is for.
 * The cache below means the common request pays none of this.
 *
 * This, and not a caller-supplied AbortSignal, is what bounds a mint. One mint
 * can be shared by several waiting callers (see `inFlight`), and letting one
 * caller's deadline abort a call another caller is waiting on would turn a
 * background tab timing out into a failed rail in the tab the human is reading.
 */
const MINT_TIMEOUT_MS = 1500;

/**
 * Hand a cached token back only while more than a quarter of its life remains.
 *
 * Obligate mints for 120 s, so this refreshes at 90 s: one mint every 90 s per
 * (user, audience, tenant) instead of one per request, and a token handed to a
 * caller always has at least ~30 s left. Expiring AT `exp` would routinely put
 * a token with 40 ms of life onto the wire and lose the race to the sibling.
 */
const REFRESH_AT_FRACTION = 0.75;

/**
 * A token whose remaining life exceeds this is not trusted to be cached for
 * that long: the value would then be resting on Obligate's clock rather than
 * ours, and a badly skewed pair of clocks must degrade to "mint more often",
 * never to "hold a token past its life".
 */
const MAX_CACHE_LIFETIME_MS = 10 * 60 * 1000;

/**
 * A hard refusal ("this user is not entitled to that app") is remembered
 * briefly so five rail sections and a page refresh do not become five mints.
 * Bounded to 30 s so an operator granting access sees it take effect within
 * half a minute — a "no" is cached, but never for long enough to matter.
 */
const REFUSAL_CACHE_MS = 30_000;

/** Ceiling on the cache, so a large fleet of agents cannot grow it unbounded. */
const MAX_CACHE_ENTRIES = 1000;

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

export interface DelegationTokenInput {
  /**
   * The LOCAL Oblidesk user id of the human on whose behalf the read is made.
   * Resolved here to their Obligate id; callers never handle the Obligate id,
   * so a caller cannot ask for a token for an identity it did not authenticate.
   */
  userId: number;
  /** The ONE target app type. Never an array, never a wildcard. */
  audience: string;
  /** Cross-app tenant identity is the SLUG, never a numeric id (HARD RULE 13). */
  tenantSlug: string;
  /**
   * The local tenant id, used ONLY to place the audit row in the right ledger.
   * Deliberately not part of the cache key: the slug is the cross-app identity
   * and adding a second, redundant local id to the key would let the same
   * (user, audience, tenant) mint twice for no reason.
   */
  tenantId: number;
  ip?: string | null;
  userAgent?: string | null;
}

export interface DelegationToken {
  /** Compact JWS. NEVER logged, never audited, never persisted. */
  token: string;
  /** ISO 8601 UTC, as returned by Obligate (iat + 120 s). */
  expiresAt: string;
  /** RFC 7638 thumbprint of the signing key, also carried in the header. */
  kid: string;
  /** Replay-detection / audit-correlation id. Safe to log; it is not a secret. */
  jti: string;
  /** The Obligate user id this token speaks for, as a string (the `sub` claim). */
  subject: string;
  /** The one audience it is valid for. Re-read from the token, not assumed. */
  audience: string;
}

/**
 * Why no token is available. The caller needs the distinction: "you may not"
 * and "we could not ask" are different sentences to put in front of a human,
 * and only one of them is worth retrying.
 */
export type DelegationRefusal =
  /** Obligate is not configured here, or refused Oblidesk's own app key. */
  | 'not_configured'
  /** This local account is not linked to an Obligate identity (or is disabled). */
  | 'no_obligate_identity'
  /** Obligate answered, and the answer was no. */
  | 'refused'
  /** Obligate could not be reached, timed out, rate limited, or errored. */
  | 'unreachable'
  /** Obligate answered with something that is not the token we asked for. */
  | 'malformed_token';

export type DelegationOutcome =
  | { ok: true; token: DelegationToken; cached: boolean }
  | { ok: false; refusal: DelegationRefusal; detail: string | null };

// ═════════════════════════════════════════════════════════════════════════════
// The cache
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE cache key. Exported so a test can state the property in one line rather
 * than infer it: a cache that can hand user A's token to user B is the same
 * bypass this module removes, so the user id is the FIRST component and it is
 * never optional.
 *
 * The separator is NUL, which cannot occur in an audience or a tenant slug
 * (both are matched against the patterns above before a key is ever built).
 * With a printable separator, ('a', 'b-c') and ('a-b', 'c') would collide, and
 * a collision here means one tenant's token answering for another's.
 */
export function delegationCacheKey(
  userId: number,
  audience: string,
  tenantSlug: string,
): string {
  return `${userId}\u0000${audience}\u0000${tenantSlug}`;
}

type CacheEntry =
  | { kind: 'token'; token: DelegationToken; refreshAt: number }
  | { kind: 'refusal'; refusal: DelegationRefusal; detail: string | null; until: number };

const cache = new Map<string, CacheEntry>();

/** One in-flight mint per key: a rail opening five sections must not mint five times. */
const inFlight = new Map<string, Promise<DelegationOutcome>>();

function entryLivesUntil(entry: CacheEntry): number {
  return entry.kind === 'token' ? entry.refreshAt : entry.until;
}

function pruneCache(now: number): void {
  if (cache.size < MAX_CACHE_ENTRIES) return;
  for (const [key, entry] of cache) {
    if (entryLivesUntil(entry) <= now) cache.delete(key);
  }
  // Still full of live entries: drop the lot rather than grow without bound.
  // The cost is a burst of mints, never a wrong token.
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
}

/**
 * Forget every cached token and refusal. For tests, and for the operator action
 * that must follow revoking someone's access: a cached token stays usable for
 * up to 90 s otherwise, and that is a wait an operator should not have to guess at.
 */
export function resetDelegationCache(): void {
  cache.clear();
  inFlight.clear();
}

// ═════════════════════════════════════════════════════════════════════════════
// Reading a token back, WITHOUT verifying it
// ═════════════════════════════════════════════════════════════════════════════

interface PeekedClaims {
  aud: unknown;
  sub: unknown;
  ost: unknown;
  jti: unknown;
}

/**
 * Decode segment 2 of the compact JWS. This is NOT verification and must never
 * be mistaken for it: Oblidesk holds no key and could not verify if it wanted
 * to. It exists so that a token which is not the one we asked for is dropped
 * here rather than attached to an outgoing request.
 */
function peekClaims(token: string): PeekedClaims | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  // Compact serialisation is base64url, three non-empty segments, nothing else.
  if (segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) return null;

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(segments[1], 'base64url').toString('utf8'),
    );
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    const record = decoded as Record<string, unknown>;
    return { aud: record.aud, sub: record.sub, ost: record.ost, jti: record.jti };
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Identity resolution
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The local user id to the Obligate user id. `users` is a GLOBAL table here
 * (see db/index.ts), so `db()` rather than `scoped()` is correct: there is no
 * tenant_id on it to scope by, and the tenant half of the question is answered
 * by the slug travelling in the request, which Obligate itself validates.
 *
 * A local-only account has no identity at Obligate and therefore no authority
 * to borrow. It gets no token. That is the honest answer: minting on its behalf
 * would mean inventing an identity, and falling back to the app key would mean
 * handing it Oblidesk's.
 */
async function obligateUserIdFor(localUserId: number): Promise<number | null> {
  const row = (await db('users')
    .where({ id: localUserId })
    .first('obligate_user_id', 'is_active')) as
    | { obligate_user_id: number | null; is_active: boolean }
    | undefined;

  if (!row || row.is_active !== true) return null;
  const id = row.obligate_user_id;
  // `auth_source` is deliberately NOT part of this test: it records how the
  // account last signed in, whereas `obligate_user_id` is the link itself, and
  // it is the link that decides whether an Obligate identity exists to borrow.
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// The mint call
// ═════════════════════════════════════════════════════════════════════════════

interface MintResponse {
  status: number;
  body: unknown;
}

/**
 * POST the mint request, bounded by {@link MINT_TIMEOUT_MS} alone. Returns null
 * for every network-level failure: unreachable, refused connection, timeout.
 */
async function postMint(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<MintResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/api/delegation/token`, {
      method: 'POST',
      // A 30x here would bounce Oblidesk's static app key to a host of the
      // redirect's choosing. This key is the one credential that can mint for
      // ANY user, so it never follows a redirect.
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function refusalReasonOf(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const reason = (body as Record<string, unknown>).reason;
  return typeof reason === 'string' ? reason : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// The service
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One mint, one audit row, no caching decisions. Everything around it is in
 * {@link getTokenOutcome}.
 */
async function mint(input: DelegationTokenInput): Promise<DelegationOutcome> {
  const startedAt = Date.now();

  const audit = async (
    outcome: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    // Every mint leaves a row, refusals included, and it is AWAITED: a row
    // written after the response is a row a crash loses. `recordSafe` swallows
    // and logs its own failure, so auditing can never turn a working read into
    // an error. The token itself is never in here — only its `jti` and `kid`,
    // which are correlation ids and not credentials.
    await auditService.recordSafe({
      tenantId: input.tenantId,
      actorId: input.userId,
      actorType: 'user',
      action: 'delegation.token.mint',
      entityType: 'delegation_token',
      entityId: typeof extra.jti === 'string' ? extra.jti : null,
      after: {
        outcome,
        audience: input.audience,
        // The tenant is named by SLUG on both sides of the wire (HARD RULE 13).
        tenantSlug: input.tenantSlug,
        scope: SCOPE,
        azp: SELF_APP_TYPE,
        durationMs: Date.now() - startedAt,
        ...extra,
      },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  };

  const subjectUserId = await obligateUserIdFor(input.userId);
  if (subjectUserId === null) {
    await audit('no_obligate_identity');
    return { ok: false, refusal: 'no_obligate_identity', detail: null };
  }

  const raw = await appConfigService.getObligateRaw();
  if (!raw.url || !raw.apiKey) {
    await audit('not_configured');
    return { ok: false, refusal: 'not_configured', detail: null };
  }

  const response = await postMint(raw.url, raw.apiKey, {
    audience: input.audience,
    subjectUserId,
    tenantSlug: input.tenantSlug,
    scope: SCOPE,
  });

  if (!response) {
    await audit('unreachable', { subject: String(subjectUserId) });
    return { ok: false, refusal: 'unreachable', detail: null };
  }

  // 401 is about OBLIDESK's own app key, not about the user. Blaming the user
  // for it would send a technician hunting for a permission that is not the
  // problem, so it degrades to "not configured" and is logged loudly.
  if (response.status === 401) {
    logger.error(
      { status: response.status },
      'delegation: Obligate rejected this app key, no user-scoped read is possible',
    );
    await audit('app_key_rejected', { subject: String(subjectUserId) });
    return { ok: false, refusal: 'not_configured', detail: null };
  }

  if (response.status === 400 || response.status === 403) {
    const reason = refusalReasonOf(response.body);
    await audit('refused', { subject: String(subjectUserId), providerReason: reason });
    return { ok: false, refusal: 'refused', detail: reason };
  }

  if (response.status !== 200) {
    // 429 and 5xx: Obligate is there but cannot answer right now. Transient, so
    // it is never cached as a "no" and the next request tries again.
    await audit('unreachable', { subject: String(subjectUserId), status: response.status });
    return { ok: false, refusal: 'unreachable', detail: String(response.status) };
  }

  const envelope = response.body as { success?: unknown; data?: unknown } | null;
  const data = envelope && typeof envelope === 'object' ? envelope.data : null;
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const token = typeof record?.token === 'string' ? record.token : null;
  const expiresAt = typeof record?.expiresAt === 'string' ? record.expiresAt : null;
  const kid = typeof record?.kid === 'string' ? record.kid : null;

  if (envelope?.success !== true || !token || !expiresAt || !kid) {
    await audit('malformed_token', { subject: String(subjectUserId), fault: 'envelope' });
    return { ok: false, refusal: 'malformed_token', detail: null };
  }

  const claims = peekClaims(token);
  if (!claims || typeof claims.jti !== 'string') {
    await audit('malformed_token', { subject: String(subjectUserId), fault: 'shape' });
    return { ok: false, refusal: 'malformed_token', detail: null };
  }

  // THE mis-delivery guard. A token whose subject, audience or tenant is not
  // the one asked for is dropped, loudly: attaching it would be exactly the
  // cross-user, cross-tenant bypass this module exists to remove, and a caching
  // defect on either side is the likeliest way to produce one. `ost` is compared
  // byte-exactly, case included, because the audience joins tenants on it.
  if (
    claims.aud !== input.audience ||
    claims.sub !== String(subjectUserId) ||
    claims.ost !== input.tenantSlug
  ) {
    logger.error(
      {
        askedAudience: input.audience,
        askedTenantSlug: input.tenantSlug,
        askedSubject: String(subjectUserId),
        gotAudience: typeof claims.aud === 'string' ? claims.aud : null,
        gotTenantSlug: typeof claims.ost === 'string' ? claims.ost : null,
        gotSubject: typeof claims.sub === 'string' ? claims.sub : null,
      },
      'delegation: Obligate returned a token for a different subject, audience or tenant',
    );
    await audit('malformed_token', { subject: String(subjectUserId), fault: 'mismatch', jti: claims.jti });
    return { ok: false, refusal: 'malformed_token', detail: null };
  }

  await audit('ok', { subject: String(subjectUserId), jti: claims.jti, kid, expiresAt });

  return {
    ok: true,
    cached: false,
    token: {
      token,
      expiresAt,
      kid,
      jti: claims.jti,
      subject: String(subjectUserId),
      audience: input.audience,
    },
  };
}

export const delegationService = {
  /**
   * A delegated token for one (user, audience, tenant), from the cache when one
   * is comfortably alive and from Obligate otherwise.
   *
   * Returns the refusal alongside, because "you may not read that app" and
   * "Obligate did not answer" are different sentences to show a technician and
   * only one of them is worth a retry. {@link getToken} is the same call for
   * callers that only need the token.
   */
  async getTokenOutcome(input: DelegationTokenInput): Promise<DelegationOutcome> {
    // Shape checks before anything else, so a malformed value never reaches the
    // wire, a cache key or an audit row. These MIRROR Obligate's contract; they
    // do not replace it, and the provider stays the authority on every answer.
    if (!AUDIENCE_PATTERN.test(input.audience)) {
      return { ok: false, refusal: 'refused', detail: 'audience_invalid' };
    }
    if (input.audience === SELF_APP_TYPE) {
      // Obligate refuses this as `audience_is_self`; refusing it here too keeps
      // a self-aimed delegation from ever being a round trip away from working.
      return { ok: false, refusal: 'refused', detail: 'audience_is_self' };
    }
    if (!TENANT_SLUG_PATTERN.test(input.tenantSlug)) {
      return { ok: false, refusal: 'refused', detail: 'tenant_slug_invalid' };
    }
    if (/^\d+$/.test(input.tenantSlug)) {
      // An all-digits slug is how a numeric tenant id gets smuggled into a field
      // that is supposed to carry a human slug (HARD RULE 3 and 13). Refused on
      // both sides.
      return { ok: false, refusal: 'refused', detail: 'tenant_slug_numeric' };
    }
    if (!Number.isInteger(input.userId) || input.userId <= 0) {
      return { ok: false, refusal: 'no_obligate_identity', detail: null };
    }

    const key = delegationCacheKey(input.userId, input.audience, input.tenantSlug);
    const now = Date.now();

    const entry = cache.get(key);
    if (entry && entryLivesUntil(entry) > now) {
      if (entry.kind === 'token') return { ok: true, token: entry.token, cached: true };
      return { ok: false, refusal: entry.refusal, detail: entry.detail };
    }
    if (entry) cache.delete(key);

    // Join an identical mint already on the wire. Safe to share because the key
    // pins the three things the token is ABOUT (user, audience, tenant); what
    // differs between two joined callers is only ip/userAgent on the mint's
    // audit row, and the per-request `ci.live.read` row records the real ones.
    const pending = inFlight.get(key);
    if (pending) return pending;

    const work = mint(input)
      .then((outcome) => {
        const at = Date.now();
        pruneCache(at);

        if (outcome.ok) {
          const expiresAtMs = Date.parse(outcome.token.expiresAt);
          const lifetime = Number.isNaN(expiresAtMs) ? 0 : expiresAtMs - at;
          if (lifetime > 0) {
            cache.set(key, {
              kind: 'token',
              token: outcome.token,
              // Never cached on Obligate's clock alone: an implausibly long life
              // is clamped, so badly skewed clocks cost extra mints rather than
              // letting a dead token sit in the cache.
              refreshAt: at + Math.min(lifetime, MAX_CACHE_LIFETIME_MS) * REFRESH_AT_FRACTION,
            });
          } else {
            // Already expired by our clock. Still handed to the caller (the
            // audience decides, not us), but never stored.
            logger.warn(
              { audience: input.audience, expiresAt: outcome.token.expiresAt },
              'delegation: token arrived already expired by this clock, check clock skew',
            );
          }
          return outcome;
        }

        // Only a hard "no" is remembered, and only briefly. `unreachable`,
        // `not_configured` and `malformed_token` are conditions that can clear
        // on their own, and caching them would keep the rail dark long after
        // the cause was fixed.
        if (outcome.refusal === 'refused' || outcome.refusal === 'no_obligate_identity') {
          cache.set(key, {
            kind: 'refusal',
            refusal: outcome.refusal,
            detail: outcome.detail,
            until: at + REFUSAL_CACHE_MS,
          });
        }
        return outcome;
      })
      .catch((error: unknown) => {
        // This module must never throw at a caller: a rail section that cannot
        // get a token has to render a reason, not a stack trace.
        logger.error(
          { err: (error as Error).message, audience: input.audience },
          'delegation: mint failed unexpectedly',
        );
        return { ok: false, refusal: 'unreachable', detail: null } as DelegationOutcome;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, work);
    return work;
  },

  /**
   * The token, or null. On any failure the caller degrades and shows a reason;
   * it does NOT retry with Oblidesk's static app key, and there is deliberately
   * no code path here that would let it.
   */
  async getToken(input: DelegationTokenInput): Promise<DelegationToken | null> {
    // Named rather than `this.`, so a destructured `const { getToken } = ...`
    // still works. A helper that breaks when it is imported the other way is a
    // helper someone will replace with the app key.
    const outcome = await delegationService.getTokenOutcome(input);
    return outcome.ok ? outcome.token : null;
  },

  /** For tests and for the "forget every token" operator action. */
  reset: resetDelegationCache,
};

export default delegationService;
