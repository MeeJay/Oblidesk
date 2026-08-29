/**
 * ciLive.service.ts — the READ-THROUGH half of the context rail.
 *
 * Oblidesk stores identity (`cis.hardware_uuid`) and desk-owned fields. It does
 * NOT store hardware, software, patches, uptime or threats. Those are read from
 * the app that owns them, at render time, and shown with a visible "last read"
 * timestamp. `ci_source_links.payload` is a CACHE, never a source of truth: if
 * an attribute is wrong, the fix is in Obliance, never here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHOSE EYES ARE THESE? READ THIS BEFORE CHANGING ANYTHING BELOW.
 * ─────────────────────────────────────────────────────────────────────────────
 * Every cross-app read this file makes carries the DELEGATED AUTHORITY OF THE
 * TECHNICIAN WHO OPENED THE TICKET, never Oblidesk's own. Before a section
 * fetches anything, `delegation.service` asks Obligate for a short-lived signed
 * token (120 s, Ed25519, `sub` = the acting user, `aud` = the ONE target app,
 * `ost` = the tenant SLUG), and that token is the only credential on the wire.
 * Oblidesk's static app key now does exactly one job: proving to Obligate that
 * it is Oblidesk asking. It never reaches a sibling app.
 *
 * The token says WHO, never WHAT THEY MAY DO. It carries no permission, role,
 * team or capability claim, on purpose: the audience app re-derives every right
 * from its own model (in Obliance, `permissionService.getVisibleDeviceIds`). A
 * permission list copied into a token is a second permission model, and a
 * duplicated permission model drifts, and it drifts OPEN.
 *
 * So an agent who cannot see a device in Obliance cannot see it in this rail
 * either, and the reason that holds is not the same rule written twice: it is
 * the same check, run once, in the app that owns the data.
 *
 * Four conditions govern this path, and every one of them is mandatory:
 *
 *   1. OBLIDESK AUTHORISES FIRST, IN ITS OWN MODEL. The route runs
 *      requireAuth + requireTenant + requireCapability(CI_READ), and this
 *      service re-checks that the CI belongs to the caller's tenant by loading
 *      it through `scoped('cis', tenantId)`. There is no "master tenant sees
 *      all" shortcut here: a CI outside the caller's tenant is a 404. The
 *      delegated token is the SECOND gate, not a replacement for this one.
 *   2. THE TARGET IS RESOLVED SERVER-SIDE. The client sends a ci_id and an app
 *      slug from a CLOSED list (`CI_SOURCE_APPS`). It never sends a host, a
 *      URL, a path or an external id — with a live credential on the wire, that
 *      would be a server-side request forgery with credentials attached. Base
 *      URLs come from Obligate's connected-app registry, object ids from
 *      `ci_source_links` (or Obligate's device-link registry), and external ids
 *      are re-validated as plain integers before they touch a path.
 *   3. EVERY CROSS-APP READ IS AUDITED. One `audit_log` row per call: actor,
 *      CI, app, outcome, whether the answer came from the source or the cache,
 *      and the `jti` and `kid` of the token it carried, so a row here joins to
 *      the mint row Obligate wrote for the same token.
 *   4. THERE IS NO FALLBACK. When no token can be minted the section answers
 *      `not_authorised` (Obligate said no) or `obligate_unreachable` (Obligate
 *      could not be asked) and reads NOTHING. It never retries with the static
 *      app key: a second authorisation path is by construction the least
 *      exercised and the most permissive one, and it would quietly restore the
 *      bypass this design removed.
 *
 * One rule the cache inherits from all of the above: `ci_source_links.payload`
 * was read under SOME user's delegated authority, so it is served only to a
 * caller whose own authority has just been established (a token was minted for
 * them and the SOURCE, not the permission model, is what failed). If the mint
 * failed, or the source refused this user, the cache stays shut — see
 * `AUTHORITY_DENIED` below, which is where that rule is enforced.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Honesty rules the rail depends on
 * ─────────────────────────────────────────────────────────────────────────────
 * A rail that silently hides a dead source teaches technicians to distrust all
 * of it, so:
 *   • This service NEVER throws to the caller. Every failure becomes a reason.
 *   • On success the payload is written to `ci_source_links.payload`,
 *     `last_fetched_at` is stamped, and that timestamp is returned.
 *   • On failure the CACHED payload is returned with its REAL `last_fetched_at`
 *     and `stale: true`, so the rail can render "dernière lecture il y a 14 min"
 *     instead of a spinner or a fresh-looking lie.
 *   • Nothing to show is `{}` (the rail says "aucune donnée"); a source that
 *     could not be read is a reason, never an empty success.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Why there is no decision_log row here
 * ─────────────────────────────────────────────────────────────────────────────
 * HARD RULE 2 covers what an ENGINE decides about a ticket. A read-through is
 * not an engine: it changes nothing, and `DecisionSubsystem` has no entry for
 * it. Inventing one would put rows the Why drawer cannot explain into the
 * ledger. The audit row above is the trail for this path.
 */

import { CI_SOURCE_APPS } from '@oblidesk/shared';
import type { CiSourceApp } from '@oblidesk/shared';
import { scoped, insertScoped } from '../db';
import { logger } from '../utils/logger';
import { appConfigService } from './appConfig.service';
import { auditService } from './audit.service';
import { delegationService, type DelegationToken } from './delegation.service';
import { obligateService } from './obligate.service';

// ═════════════════════════════════════════════════════════════════════════════
// Budgets and breaker settings
// ═════════════════════════════════════════════════════════════════════════════

/** Matches SECTION_TIMEOUT_MS in client/src/api/ci.api.ts. */
export const CI_LIVE_TIMEOUT_MS = 4000;

/**
 * What the upstream reads actually get. Deliberately shorter than the client's
 * own budget: the browser starts its 4 s before this request is even routed, so
 * spending the whole 4 s upstream guarantees the client aborts first and throws
 * away the cached payload we were one millisecond from sending it.
 */
const UPSTREAM_BUDGET_MS = CI_LIVE_TIMEOUT_MS - 250;

/** Consecutive failures of one (app, tenant) before we stop asking. */
const BREAKER_THRESHOLD = 3;
/** How long the breaker stays open before letting one probe through. */
const BREAKER_COOLDOWN_MS = 60_000;

/** Obligate's registries change rarely; five sections must not ask five times. */
const REGISTRY_MEMO_TTL_MS = 60_000;

/** Cap on the memo maps, so a big fleet cannot grow them without bound. */
const MEMO_MAX_ENTRIES = 500;

/** Ceiling on one sibling response. A rail section is a summary, not a dump. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// ═════════════════════════════════════════════════════════════════════════════
// Result shape
// ═════════════════════════════════════════════════════════════════════════════

export type CiLiveStatus = 'ok' | 'empty' | 'stale' | 'unavailable';

/**
 * Machine-readable reasons. The route turns these into an HTTP status the
 * client's `probe()` already knows how to render, and the French sentence
 * alongside is what the rail actually shows.
 */
export type CiLiveReason =
  | 'no_ci'
  | 'not_linked'
  | 'not_configured'
  | 'not_authorised'
  /**
   * Obligate could not be asked for the acting user's token. Produced BEFORE
   * any sibling is contacted, so it never travels as a `SourceUnavailable` and
   * can never open a sibling's circuit breaker: the sibling did nothing wrong.
   */
  | 'obligate_unreachable'
  | 'not_found'
  | 'timeout'
  | 'unreachable'
  | 'source_error'
  | 'circuit_open';

export interface CiLiveResult {
  app: CiSourceApp;
  status: CiLiveStatus;
  /** The flat record the rail renders. `{}` when there is nothing to show. */
  data: Record<string, unknown> | null;
  /** Deep link into the owning app, so the rail can offer "ouvrir dans …". */
  url: string | null;
  /** ISO instant of the read that produced `data`. The rail ages this. */
  lastFetchedAt: string | null;
  /** True when `data` is the cache rather than a fresh read. */
  stale: boolean;
  reason: CiLiveReason | null;
  /** French, user-visible. No em dashes (owner's rule). */
  reasonText: string | null;
  /** What the route should answer with. */
  httpStatus: number;
}

const REASON_TEXT: Record<CiLiveReason, string> = {
  no_ci: "Cet equipement n'existe pas dans cet espace de travail.",
  not_linked: "Cette application ne connait pas cette machine.",
  not_configured: "La passerelle Obligate n'est pas configuree, aucune lecture inter-applications n'est possible.",
  not_authorised: "Cette application refuse cette lecture pour votre compte. Vos droits y sont peut-etre plus restreints qu'ici.",
  obligate_unreachable: "Impossible d'obtenir un jeton pour votre compte aupres d'Obligate, la lecture n'a pas ete tentee.",
  not_found: "Cette application ne trouve plus cet objet.",
  timeout: `Pas de reponse en ${Math.round(UPSTREAM_BUDGET_MS / 1000)} s.`,
  unreachable: 'Source injoignable.',
  source_error: 'La source a repondu par une erreur.',
  circuit_open: 'Source injoignable a plusieurs reprises, les appels sont suspendus une minute.',
};

/** Reasons that say something permanent, not that the source is flaky. */
const PERMANENT_REASONS: ReadonlySet<CiLiveReason> = new Set<CiLiveReason>([
  'no_ci',
  'not_linked',
  'not_configured',
  'not_authorised',
  'not_found',
]);

function httpStatusFor(reason: CiLiveReason): number {
  switch (reason) {
    case 'no_ci':
      return 404;
    case 'not_authorised':
      return 403;
    case 'timeout':
      return 504;
    default:
      return 503;
  }
}

/** A source that could not answer. Never reaches the caller as a throw. */
class SourceUnavailable extends Error {
  constructor(readonly reason: CiLiveReason) {
    super(reason);
    this.name = 'SourceUnavailable';
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The closed list
// ═════════════════════════════════════════════════════════════════════════════

const SOURCE_APPS: ReadonlySet<string> = new Set(CI_SOURCE_APPS);

/**
 * THE gate on `:app`. Nothing that fails this reaches a fetch — it is the first
 * half of the SSRF boundary (the second half is that the URL itself is never
 * built from anything the client sent).
 */
export function isCiSourceApp(value: unknown): value is CiSourceApp {
  return typeof value === 'string' && SOURCE_APPS.has(value);
}

// ═════════════════════════════════════════════════════════════════════════════
// Circuit breaker, per (app, tenant)
// ═════════════════════════════════════════════════════════════════════════════

interface BreakerState {
  failures: number;
  openedAt: number;
}

const breakers = new Map<string, BreakerState>();

function breakerKey(app: CiSourceApp, tenantId: number): string {
  return `${app}:${tenantId}`;
}

function breakerIsOpen(key: string): boolean {
  const state = breakers.get(key);
  if (!state || state.failures < BREAKER_THRESHOLD) return false;
  if (Date.now() - state.openedAt < BREAKER_COOLDOWN_MS) return true;
  // Half-open: one probe goes through and its outcome decides.
  state.failures = BREAKER_THRESHOLD - 1;
  return false;
}

function breakerSucceeded(key: string): void {
  breakers.delete(key);
}

function breakerFailed(key: string): void {
  const state = breakers.get(key) ?? { failures: 0, openedAt: 0 };
  state.failures += 1;
  if (state.failures >= BREAKER_THRESHOLD) state.openedAt = Date.now();
  breakers.set(key, state);
}

/** For tests and for an operator "retry everything" action. */
export function resetCiLiveBreakers(): void {
  breakers.clear();
}

// ═════════════════════════════════════════════════════════════════════════════
// Obligate registries, memoised
// ═════════════════════════════════════════════════════════════════════════════

interface ConnectedAppLite {
  appType: string;
  name: string;
  baseUrl: string;
}

interface DeviceLinkLite {
  appType: string;
  name: string;
  url: string;
}

interface Memo<T> {
  at: number;
  value: Promise<T>;
}

let connectedAppsMemo: Memo<ConnectedAppLite[]> | null = null;
const deviceLinksMemo = new Map<string, Memo<DeviceLinkLite[]>>();

function memoFresh(memo: Memo<unknown> | undefined | null): boolean {
  return Boolean(memo) && Date.now() - (memo as Memo<unknown>).at < REGISTRY_MEMO_TTL_MS;
}

/**
 * The app switcher's registry, reused as a base-URL directory. Called without a
 * user id on purpose: this is not "which apps may the caller open", it is
 * "where does Obliance live", and the entitlement question was already answered
 * by requireCapability(CI_READ) on the Oblidesk side.
 */
function connectedApps(): Promise<ConnectedAppLite[]> {
  if (memoFresh(connectedAppsMemo)) return (connectedAppsMemo as Memo<ConnectedAppLite[]>).value;
  const value = obligateService.getConnectedApps().catch(() => [] as ConnectedAppLite[]);
  connectedAppsMemo = { at: Date.now(), value };
  return value;
}

/**
 * THE way to find which sibling app holds a machine. Keyed by tenant as well as
 * uuid so two workspaces can never read each other's memo entry, even though
 * the registry answer does not depend on the tenant.
 */
function deviceLinks(tenantId: number, uuid: string): Promise<DeviceLinkLite[]> {
  const key = `${tenantId}:${uuid.toLowerCase()}`;
  const existing = deviceLinksMemo.get(key);
  if (memoFresh(existing)) return (existing as Memo<DeviceLinkLite[]>).value;

  if (deviceLinksMemo.size >= MEMO_MAX_ENTRIES) deviceLinksMemo.clear();
  const value = obligateService.getDeviceLinks(uuid).catch(() => [] as DeviceLinkLite[]);
  deviceLinksMemo.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Stop waiting when the section's budget runs out, without leaving the caller
 * with a rejected promise. `getDeviceLinks` carries Obligate's own 10 s timeout,
 * which is more than a rail section is worth.
 */
function withDeadline<T>(promise: Promise<T>, signal: AbortSignal, fallback: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    let settled = false;
    const done = (value: T): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => done(fallback);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(done, () => done(fallback));
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Reading a sibling app
// ═════════════════════════════════════════════════════════════════════════════

interface FetchContext {
  /**
   * The ACTING USER's delegated token, minted for this one audience and alive
   * for about two minutes. Not Oblidesk's static app key, which never leaves
   * the conversation with Obligate. Nothing in this file may substitute one for
   * the other: see condition 4 in the header.
   */
  token: string;
  tenantSlug: string;
  signal: AbortSignal;
  /** Obligate's own origin, vetted once per read. */
  obligateBase: string | null;
}

/**
 * Normalise and vet a base URL before anything is appended to it. The value
 * comes from Obligate's registry or from a link row we wrote ourselves, never
 * from the request, but a scheme check is cheap and this is the one place a
 * privileged key could be pointed somewhere it should not go.
 */
function safeBase(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function suiteUrl(
  base: string,
  path: string,
  query: Record<string, string | number | undefined> = {},
): string {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * One guarded GET against a sibling app.
 *
 * `redirect: 'manual'` is not decoration: following a 30x would let a
 * misconfigured (or compromised) sibling bounce the caller's Bearer token to a
 * host of its choosing, which is exactly the forgery the closed app list and
 * the server-side URL resolution exist to prevent. The token is short-lived and
 * single-audience, which shrinks the damage of a leak; it does not excuse one.
 */
async function readJson(url: string, ctx: FetchContext): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ctx.signal,
      headers: {
        Accept: 'application/json',
        // The delegated, user-scoped token. The sibling verifies its signature
        // against Obligate's JWKS, resolves `sub` to ITS OWN user, and then runs
        // ITS OWN permission checks as that user. Nothing here asks it to trust
        // a claim about what the user may do, because the token makes none.
        Authorization: `Bearer ${ctx.token}`,
        // Identifies the reader, and names the tenant BY SLUG (HARD RULE 13):
        // the sibling's numeric tenant ids mean nothing here. Both are a
        // convenience for the sibling's logs; the token's `azp` and `ost` are
        // the authoritative copies, because those are signed and these are not.
        'X-Obli-App': 'oblidesk',
        'X-Obli-Tenant-Slug': ctx.tenantSlug,
      },
    });
  } catch {
    throw new SourceUnavailable(ctx.signal.aborted ? 'timeout' : 'unreachable');
  }

  if (response.status === 401 || response.status === 403) throw new SourceUnavailable('not_authorised');
  if (response.status === 404) throw new SourceUnavailable('not_found');
  if (!response.ok) throw new SourceUnavailable('source_error');

  // A rail section is a summary. An app that answers with a fleet-sized body
  // (a misrouted collection endpoint, a paging default gone wrong) must not be
  // able to spend the desk's memory on it.
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new SourceUnavailable('source_error');
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new SourceUnavailable('source_error');
  }
}

/** Same read, but a failure is "we did not get this bit" rather than a dead section. */
async function tryRead(url: string, ctx: FetchContext): Promise<unknown> {
  try {
    return await readJson(url, ctx);
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Shape helpers — every sibling body is `unknown` until proven otherwise
// ═════════════════════════════════════════════════════════════════════════════

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Unwrap `{ success, data }`, `{ data }`, `{ items }`, `{ site }` and friends. */
function unwrap(body: unknown, ...keys: string[]): unknown {
  const record = asObject(body);
  if (!record) return body;
  for (const key of keys.length > 0 ? keys : ['data']) {
    if (key in record) return record[key];
  }
  return body;
}

/** jsonb comes back parsed by `pg`, but a string sneaks through some drivers. */
function parseJsonColumn(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asObject(value);
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * External ids reach a URL path, so they are re-validated here even though they
 * came from our own tables. Every sibling addresses its objects by a plain
 * integer; anything else is refused rather than escaped.
 */
function numericId(value: string | null): string | null {
  return value !== null && /^\d{1,12}$/.test(value) ? value : null;
}

/** `/devices/42` → `42`. Used to recover an id from a registry deep link. */
function idFromPath(path: string | null): string | null {
  if (!path) return null;
  const segments = path.split('?')[0].split('#')[0].split('/').filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (/^\d{1,12}$/.test(segments[index])) return segments[index];
  }
  return null;
}

function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.startsWith('/') ? url : null;
  }
}

/** The /24 an IPv4 address sits in. Derived, and labelled as such by the rail. */
function subnetOf(ip: string | null): string | null {
  if (!ip) return null;
  const parts = ip.trim().split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return null;
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Link resolution — where each app keeps this machine
// ═════════════════════════════════════════════════════════════════════════════

interface SourceLink {
  app: CiSourceApp;
  /** Row id in `ci_source_links`, when one exists. */
  rowId: number | null;
  externalId: string | null;
  externalPath: string | null;
  /** Deep link into the owning app's UI. */
  url: string | null;
  /** API origin, resolved server-side. */
  base: string | null;
  cachedPayload: Record<string, unknown> | null;
  lastFetchedAt: string | null;
}

interface CiRow {
  id: number;
  display_name: string;
  hardware_uuid: string | null;
}

interface LinkRow {
  id: number;
  app_type: string;
  external_id: string | null;
  external_path: string | null;
  url: string | null;
  last_fetched_at: Date | string | null;
  payload: unknown;
}

type LinkMap = Partial<Record<CiSourceApp, SourceLink>>;

/**
 * Build the link table for one CI: our own rows first, Obligate's device-link
 * registry as the fallback, and the connected-app registry for base URLs.
 *
 * NOTHING here reads the request. That is the point.
 */
async function resolveLinks(
  tenantId: number,
  ci: CiRow,
  signal: AbortSignal,
): Promise<LinkMap> {
  const rows = (await scoped('ci_source_links', tenantId)
    .where('ci_source_links.ci_id', ci.id)
    .select(
      'id',
      'app_type',
      'external_id',
      'external_path',
      'url',
      'last_fetched_at',
      'payload',
    )) as LinkRow[];

  const byApp = new Map<string, LinkRow>();
  for (const row of rows) {
    // One row per app is what the rail reads; a second row for the same app
    // (different external id) is older data, so the newest wins.
    const previous = byApp.get(row.app_type);
    if (!previous || (toIso(row.last_fetched_at) ?? '') > (toIso(previous.last_fetched_at) ?? '')) {
      byApp.set(row.app_type, row);
    }
  }

  const [registry, apps] = await Promise.all([
    ci.hardware_uuid
      ? withDeadline(deviceLinks(tenantId, ci.hardware_uuid), signal, [] as DeviceLinkLite[])
      : Promise.resolve([] as DeviceLinkLite[]),
    withDeadline(connectedApps(), signal, [] as ConnectedAppLite[]),
  ]);

  const registryByApp = new Map(registry.map((link) => [link.appType, link]));
  const baseByApp = new Map(apps.map((app) => [app.appType, app.baseUrl]));

  const links: LinkMap = {};
  for (const app of CI_SOURCE_APPS) {
    const row = byApp.get(app);
    const fromRegistry = registryByApp.get(app);
    const url = row?.url ?? fromRegistry?.url ?? null;
    const externalPath = row?.external_path ?? pathOf(fromRegistry?.url ?? null);
    const base = safeBase(baseByApp.get(app)) ?? safeBase(url);

    if (!row && !fromRegistry && !base) continue;

    links[app] = {
      app,
      rowId: row?.id ?? null,
      externalId: row?.external_id ?? idFromPath(externalPath),
      externalPath,
      url: url ?? (base && externalPath ? `${base}${externalPath}` : base),
      base,
      cachedPayload: parseJsonColumn(row?.payload),
      lastFetchedAt: toIso(row?.last_fetched_at ?? null),
    };
  }

  return links;
}

/**
 * Persist the read as a CACHE. `payload` is never promoted to a desk-owned
 * attribute: it is what the source said, when it said it, and `last_fetched_at`
 * is what the rail renders next to it.
 */
async function rememberPayload(
  tenantId: number,
  ciId: number,
  link: SourceLink,
  uuid: string | null,
  payload: Record<string, unknown>,
  fetchedAt: Date,
): Promise<void> {
  const externalId = link.externalId ?? uuid ?? String(ciId);

  // Only the columns we actually resolved are written. A deep link we could not
  // rebuild this time (the registry was slow, the connected-app row moved) must
  // not overwrite the good one already stored with a NULL, which would cost the
  // rail its "ouvrir dans Obliance" button for a reason unrelated to the read.
  const row: Record<string, unknown> = {
    external_id: externalId,
    payload: JSON.stringify(payload),
    last_fetched_at: fetchedAt,
  };
  if (link.externalPath !== null) row.external_path = link.externalPath;
  if (link.url !== null) row.url = link.url;

  try {
    if (link.rowId !== null) {
      await scoped('ci_source_links', tenantId)
        .where('ci_source_links.id', link.rowId)
        .update(row);
      return;
    }
    await insertScoped('ci_source_links', tenantId, {
      ci_id: ciId,
      app_type: link.app,
      ...row,
    })
      .onConflict(['ci_id', 'app_type', 'external_id'])
      .merge(Object.keys(row).filter((column) => column !== 'external_id'));
  } catch (error) {
    // The read succeeded; failing to cache it must not fail the section. The
    // rail simply shows this read's own timestamp and asks again next time.
    logger.warn(
      { err: (error as Error).message, tenantId, ciId, app: link.app },
      'ci live: could not cache the source payload',
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Per-app plans
//
// Each returns a FLAT record the rail can render, or null for "this app has
// nothing about this machine". Only the first call of a plan is load bearing:
// the extras are best effort, so one missing endpoint degrades a field rather
// than the whole section.
// ═════════════════════════════════════════════════════════════════════════════

interface PlanContext {
  tenantId: number;
  ci: CiRow;
  link: SourceLink;
  links: LinkMap;
  fetch: FetchContext;
}

type Plan = (ctx: PlanContext) => Promise<Record<string, unknown> | null>;

const OPTICAL_FSTYPES: ReadonlySet<string> = new Set(['iso9660', 'udf', 'cdfs']);

/** The fullest fixed volume. Optical and removable media are full by nature. */
function worstDisk(disks: unknown[]): Record<string, unknown> | null {
  let worst: Record<string, unknown> | null = null;
  let worstPercent = -1;

  for (const entry of disks) {
    const disk = asObject(entry);
    if (!disk) continue;
    if (bool(disk.removable) === true) continue;
    const fstype = str(disk.fstype);
    if (fstype && OPTICAL_FSTYPES.has(fstype.toLowerCase())) continue;

    const percent = num(disk.percent);
    if (percent === null || percent <= worstPercent) continue;
    worstPercent = percent;
    worst = {
      mount: str(disk.mount),
      percent,
      usedGb: num(disk.usedGb),
      totalGb: num(disk.totalGb),
    };
  }

  return worst;
}

/**
 * obliance — the machine itself: identity, OS, agent, disk pressure, pending
 * updates, and the 48 h change-event SUMMARY (counts per kind). The summary is
 * the Blame Ribbon's headline, deliberately not the full timeline: "17 changes
 * in the last two days, 12 of them software" is what a technician reads before
 * touching anything, and the list is one click away in Obliance.
 */
const obliancePlan: Plan = async ({ link, fetch: ctx }) => {
  const base = link.base;
  const deviceId = numericId(link.externalId);
  if (!base || !deviceId) return null;

  const device = asObject(unwrap(await readJson(suiteUrl(base, `/api/devices/${deviceId}`), ctx)));
  if (!device) return null;

  const to = new Date();
  const from = new Date(to.getTime() - 48 * 60 * 60 * 1000);

  const [updatesBody, changesBody] = await Promise.all([
    tryRead(suiteUrl(base, '/api/updates', { deviceId, status: 'pending' }), ctx),
    tryRead(
      suiteUrl(base, `/api/devices/${deviceId}/change-events/summary`, {
        from: from.toISOString(),
        to: to.toISOString(),
      }),
      ctx,
    ),
  ]);

  const updates = asObject(unwrap(updatesBody));
  const pendingUpdates = updates ? num(updates.total) ?? asArray(updates.items).length : null;

  const changes = asObject(unwrap(changesBody));
  const metrics = asObject(device.latestMetrics) ?? {};
  const cpu = asObject(metrics.cpu);
  const memory = asObject(metrics.memory);

  return {
    deviceId: num(device.id),
    hostname: str(device.hostname),
    displayName: str(device.displayName),
    osType: str(device.osType),
    os: [str(device.osName), str(device.osVersion)].filter(Boolean).join(' ') || null,
    osBuild: str(device.osBuild),
    agentVersion: str(device.agentVersion),
    agentUpdateAvailable: bool(device.updateAvailable),
    status: str(device.status),
    approvalStatus: str(device.approvalStatus),
    lastSeenAt: toIso(device.lastSeenAt),
    ipLocal: str(device.ipLocal),
    ipPublic: str(device.ipPublic),
    macAddress: str(device.macAddress),
    cpuPercent: cpu ? num(cpu.percent) : null,
    ramPercent: memory ? num(memory.percent) : null,
    disk: worstDisk(asArray(metrics.disks)),
    rebootPending: bool(device.rebootPending),
    lastRebootAt: toIso(device.lastRebootAt),
    lastLoggedInUser: str(device.lastLoggedInUser),
    pendingUpdates,
    changes48h: changes
      ? {
          from: toIso(changes.from) ?? from.toISOString(),
          to: toIso(changes.to) ?? to.toISOString(),
          total: num(changes.total) ?? 0,
          counts: asObject(changes.counts) ?? {},
        }
      : null,
  };
};

/**
 * obliview — the monitors watching this device, their current status and their
 * 24 h uptime. Obliview keys a monitor to a machine by `agentDeviceId` (an
 * Obliance device id), so the join runs through the obliance link rather than
 * through anything the desk invented.
 */
const obliviewPlan: Plan = async ({ link, links, fetch: ctx }) => {
  const base = link.base;
  if (!base) return null;

  const oblianceId = num(numericId(links.obliance?.externalId ?? null));
  const monitorId = num(numericId(link.externalId));
  if (oblianceId === null && monitorId === null) return null;

  const monitors = asArray(unwrap(await readJson(suiteUrl(base, '/api/monitors'), ctx)));
  const mine = monitors
    .map(asObject)
    .filter((monitor): monitor is Record<string, unknown> => {
      if (!monitor) return false;
      if (monitorId !== null && num(monitor.id) === monitorId) return true;
      return oblianceId !== null && num(monitor.agentDeviceId) === oblianceId;
    });

  if (mine.length === 0) return null;

  // Five is what the rail can show. More than that and the answer is "open
  // Obliview", not a longer list in a side panel.
  const shown = mine.slice(0, 5);
  const stats = await Promise.all(
    shown.map((monitor) => {
      const id = num(monitor.id);
      const safeId = id === null ? null : numericId(String(id));
      return safeId
        ? tryRead(suiteUrl(base, `/api/monitors/${safeId}/stats`, { period: '24h' }), ctx)
        : Promise.resolve(null);
    }),
  );

  let down = 0;
  const rendered = shown.map((monitor, index) => {
    const status = str(monitor.status);
    if (status === 'down') down += 1;
    const stat = asObject(unwrap(stats[index]));
    return {
      id: num(monitor.id),
      name: str(monitor.name),
      type: str(monitor.type),
      status,
      active: bool(monitor.isActive),
      inMaintenance: bool(monitor.inMaintenance),
      target: str(monitor.url) ?? str(monitor.hostname),
      uptime24h: stat ? num(stat.uptimePct) : null,
      avgResponseMs: stat ? num(stat.avgResponseTime) : null,
    };
  });

  return {
    monitorCount: mine.length,
    shownCount: rendered.length,
    downCount: down,
    monitors: rendered,
  };
};

/**
 * obliguard — active bans and recent attack volume TOUCHING THIS DEVICE.
 *
 * Obliguard indexes by IP, and the desk does not store IPs (they are Obliance's
 * attribute, not ours), so the addresses come from the obliance cache. No known
 * address means no honest answer: the section is empty rather than showing the
 * tenant's bans at large, which would read as "this machine is under attack".
 */
const obliguardPlan: Plan = async ({ link, links, fetch: ctx }) => {
  const base = link.base;
  if (!base) return null;

  const obliance = links.obliance?.cachedPayload ?? null;
  const ips = [str(obliance?.ipLocal), str(obliance?.ipPublic)].filter(
    (ip): ip is string => ip !== null,
  );
  if (ips.length === 0) return null;

  let activeBans = 0;
  const bans: Array<Record<string, unknown>> = [];
  let attackEvents = 0;
  let lastEventAt: string | null = null;

  for (const [index, ip] of ips.entries()) {
    // The first address is load bearing: if Obliguard cannot answer for it the
    // section says so. The second is a bonus.
    const body =
      index === 0
        ? await readJson(suiteUrl(base, '/api/bans', { search: ip, active: 'true', pageSize: 5 }), ctx)
        : await tryRead(suiteUrl(base, '/api/bans', { search: ip, active: 'true', pageSize: 5 }), ctx);

    const envelope = asObject(body);
    activeBans += num(envelope?.total) ?? 0;
    for (const entry of asArray(unwrap(body))) {
      const ban = asObject(entry);
      if (!ban || bans.length >= 5) continue;
      bans.push({
        ip: str(ban.ip),
        reason: str(ban.reason),
        service: str(ban.service),
        bannedAt: toIso(ban.createdAt ?? ban.created_at),
        expiresAt: toIso(ban.expiresAt ?? ban.expires_at),
      });
    }

    const events = asArray(
      unwrap(await tryRead(suiteUrl(base, `/api/ip-events/${encodeURIComponent(ip)}`), ctx), 'data', 'events', 'items'),
    );
    const since = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of events) {
      const event = asObject(entry);
      const at = toIso(event?.timestamp ?? event?.created_at);
      if (!at) continue;
      if (!lastEventAt || at > lastEventAt) lastEventAt = at;
      if (new Date(at).getTime() >= since) attackEvents += 1;
    }
  }

  return {
    addresses: ips,
    activeBans,
    bans,
    attacks24h: attackEvents,
    lastEventAt,
  };
};

/**
 * oblimap — where the machine sits on the network: its site, the /24 it is on,
 * and its neighbours. The subnet is DERIVED from the item's address (Oblimap
 * stores items, not prefixes), which is why the record labels it that way.
 */
const oblimapPlan: Plan = async ({ link, links, fetch: ctx }) => {
  const base = link.base;
  const siteId = numericId(link.externalId);
  if (!base || !siteId) return null;

  const site = asObject(unwrap(await readJson(suiteUrl(base, `/api/sites/${siteId}`), ctx), 'site', 'data'));
  if (!site) return null;

  const items = asArray(
    unwrap(await tryRead(suiteUrl(base, `/api/sites/${siteId}/items`), ctx), 'items', 'data'),
  ).map(asObject);

  const obliance = links.obliance?.cachedPayload ?? null;
  const mac = str(obliance?.macAddress)?.toLowerCase() ?? null;
  const ip = str(obliance?.ipLocal);
  const hostname = str(obliance?.hostname)?.toLowerCase() ?? null;

  const self = items.find((item) => {
    if (!item) return false;
    if (mac && str(item.mac)?.toLowerCase() === mac) return true;
    if (ip && str(item.ip) === ip) return true;
    return Boolean(hostname && str(item.hostname)?.toLowerCase() === hostname);
  });

  const selfIp = str(self?.ip) ?? ip;
  const subnet = subnetOf(selfIp);

  const neighbours = items.filter(
    (item): item is Record<string, unknown> =>
      item !== null && item !== self && subnetOf(str(item.ip)) === subnet && subnet !== null,
  );

  return {
    siteId: num(site.id) ?? Number(siteId),
    siteName: str(site.name),
    itemCount: num(site.itemCount) ?? items.length,
    address: selfIp,
    subnet,
    subnetDerived: subnet !== null,
    neighbourCount: neighbours.length,
    neighbours: neighbours.slice(0, 8).map((item) => ({
      ip: str(item.ip),
      mac: str(item.mac),
      hostname: str(item.hostname) ?? str(item.customName),
      deviceType: str(item.deviceType),
      online: bool(item.isOnline) ?? bool(item.online),
    })),
  };
};

/**
 * obligate — the identity behind the machine.
 *
 * Two things Obligate genuinely knows: which apps hold this UUID (the device
 * link registry), and who the last interactive user maps to in the directory.
 * The owner is resolved from Obliance's `lastLoggedInUser`, so the record says
 * where the claim came from: "dernier utilisateur connecte" is evidence, not a
 * declaration of ownership, and the rail must not present it as one.
 *
 * This section is delegated like every other one: the roster read below carries
 * the acting user's token with `aud: 'obligate'`, NOT Oblidesk's app key. Yes,
 * that means asking the issuer for a token to spend back at the issuer, and yes
 * it means this section goes dark if Obligate does not register itself as an
 * audience. Both are preferable to the alternative, which is one app in the
 * closed list keeping a second, app-scoped credential path alive: that path
 * would be the least exercised one in the suite and the most permissive, and it
 * is the thing this whole change removed.
 */
const obligatePlan: Plan = async ({ tenantId, ci, links, fetch: ctx }) => {
  const base = ctx.obligateBase;
  if (!base) throw new SourceUnavailable('not_configured');
  if (!ci.hardware_uuid) return null;

  const registry = await withDeadline(
    deviceLinks(tenantId, ci.hardware_uuid),
    ctx.signal,
    [] as DeviceLinkLite[],
  );

  const candidate = str(links.obliance?.cachedPayload?.lastLoggedInUser);
  // DOMAIN\user and user@domain both reduce to the account name Obligate holds.
  const account = candidate
    ? candidate.split('\\').pop()?.split('@')[0]?.trim().toLowerCase() ?? null
    : null;

  let owner: Record<string, unknown> | null = null;
  if (account) {
    const roster = asArray(unwrap(await tryRead(suiteUrl(base, '/api/apps/users'), ctx)));
    for (const entry of roster) {
      const user = asObject(entry);
      if (!user) continue;
      const username = str(user.username)?.toLowerCase() ?? null;
      const email = str(user.email)?.toLowerCase() ?? null;
      if (username === account || (email && email.split('@')[0] === account)) {
        owner = {
          obligateUserId: num(user.obligateUserId),
          username: str(user.username),
          displayName: str(user.displayName),
          email: str(user.email),
          role: str(user.role),
          // Tenant bindings are carried by SLUG (HARD RULE 13).
          tenantSlugs: asArray(user.tenants)
            .map((binding) => str(asObject(binding)?.slug))
            .filter((slug): slug is string => slug !== null),
        };
        break;
      }
    }
  }

  if (registry.length === 0 && !owner) return null;

  return {
    hardwareUuid: ci.hardware_uuid,
    linkedApps: registry.map((entry) => ({
      appType: entry.appType,
      name: entry.name,
      url: entry.url,
    })),
    owner,
    ownerEvidence: owner ? 'last_logged_in_user' : null,
    lastLoggedInUser: candidate,
  };
};

const PLANS: Record<CiSourceApp, Plan> = {
  obliance: obliancePlan,
  obliview: obliviewPlan,
  obliguard: obliguardPlan,
  oblimap: oblimapPlan,
  obligate: obligatePlan,
};

// ═════════════════════════════════════════════════════════════════════════════
// The service
// ═════════════════════════════════════════════════════════════════════════════

export interface CiLiveReadInput {
  tenantId: number;
  /** Cross-app identity is the SLUG, never a numeric id (HARD RULE 13). */
  tenantSlug: string;
  ciId: number;
  app: CiSourceApp;
  /**
   * The acting human, passed EXPLICITLY from the route (`currentUserId(req)`).
   *
   * This is both the audit actor and the identity the delegated token is minted
   * for, which is why it is no longer nullable: a read with no acting user has
   * no authority to borrow, and there is nothing to fall back to. It is also
   * why it is a parameter and not a module-level "current user" — an implicit
   * ambient identity inside a proxy is how the wrong token gets attached to
   * someone else's request.
   */
  actorId: number;
  ip?: string | null;
  userAgent?: string | null;
}

function result(app: CiSourceApp, patch: Partial<CiLiveResult> = {}): CiLiveResult {
  return {
    app,
    status: 'ok',
    data: null,
    url: null,
    lastFetchedAt: null,
    stale: false,
    reason: null,
    reasonText: null,
    httpStatus: 200,
    ...patch,
  };
}

function unavailable(app: CiSourceApp, reason: CiLiveReason, patch: Partial<CiLiveResult> = {}): CiLiveResult {
  return result(app, {
    status: 'unavailable',
    reason,
    reasonText: REASON_TEXT[reason],
    httpStatus: httpStatusFor(reason),
    ...patch,
  });
}

/**
 * The honesty fields travel INSIDE the record, not beside it.
 *
 * The client unwraps `{ success, data }` and renders `data`, so anything left
 * in the envelope is dropped before a human could read it. `stale` and
 * `lastFetchedAt` are the two values that stop the rail lying about the age of
 * what it shows, which makes their position load bearing rather than cosmetic.
 */
function withMeta(
  payload: Record<string, unknown>,
  link: SourceLink,
  meta: { stale: boolean; lastFetchedAt: string | null; reason: CiLiveReason | null },
): Record<string, unknown> {
  return {
    ...payload,
    url: link.url,
    stale: meta.stale,
    lastFetchedAt: meta.lastFetchedAt,
    reason: meta.reason,
    reasonText: meta.reason ? REASON_TEXT[meta.reason] : null,
  };
}

/**
 * Reasons where the cache MUST stay shut, enforced in `staleFrom` so that no
 * path can forget it.
 *
 * `ci_source_links.payload` is a per-tenant cache of reads made under some
 * user's delegated authority. Serving it back is honest degradation only while
 * the caller's OWN authority has been established and it is the SOURCE that
 * failed (a timeout, a 5xx, an open breaker). These three reasons are the cases
 * where that is not true:
 *
 *   not_authorised       the source looked at this user and said no. Answering
 *                        from the cache would hand them exactly the data the
 *                        source just refused them, which is the bypass this
 *                        whole module exists to remove.
 *   obligate_unreachable no token, so no idea what this user may see. Unknown
 *                        is not a reason to show something.
 *   not_configured       same, permanently: without Obligate there is no
 *                        user-scoped authority to establish at all.
 */
const AUTHORITY_DENIED: ReadonlySet<CiLiveReason> = new Set<CiLiveReason>([
  'not_authorised',
  'obligate_unreachable',
  'not_configured',
]);

/** The cache, dressed as what it is: old data with the age it really has. */
function staleFrom(link: SourceLink, reason: CiLiveReason): CiLiveResult | null {
  if (AUTHORITY_DENIED.has(reason)) return null;
  if (!link.cachedPayload) return null;
  return result(link.app, {
    status: 'stale',
    data: withMeta(link.cachedPayload, link, {
      stale: true,
      lastFetchedAt: link.lastFetchedAt,
      reason,
    }),
    url: link.url,
    lastFetchedAt: link.lastFetchedAt,
    stale: true,
    reason,
    reasonText: REASON_TEXT[reason],
  });
}

export const ciLiveService = {
  isSourceApp: isCiSourceApp,

  /**
   * One sibling app's live view of one CI. NEVER throws: every failure comes
   * back as a reason the rail can render and a human can act on.
   */
  async read(input: CiLiveReadInput): Promise<CiLiveResult> {
    const { tenantId, ciId, app } = input;
    const startedAt = Date.now();

    /**
     * The credential this read actually carried, filled in once minted. Every
     * audit row below names it, so the ledger can distinguish "read with user
     * 42's delegated token, jti abc" from "never got that far" without the
     * reader having to infer it from the outcome.
     */
    let credential: DelegationToken | null = null;

    const audit = async (outcome: string, extra: Record<string, unknown> = {}): Promise<void> => {
      // Awaited, not fired and forgotten: condition 3 of the header says every
      // cross-app read leaves a row, and a row written after the response is a
      // row that a crash loses. `recordSafe` swallows its own failure (and logs
      // it), so this can never turn a readable section into an error.
      await auditService.recordSafe({
        tenantId,
        actorId: input.actorId,
        actorType: 'user',
        action: 'ci.live.read',
        entityType: 'ci',
        entityId: ciId,
        after: {
          app,
          outcome,
          durationMs: Date.now() - startedAt,
          // Named so a reader of the ledger cannot miss it (see file header).
          // 'none' means no sibling was contacted, never "contacted with the
          // app key" — there is no code path here that does that.
          authority: credential ? 'delegated_user_token' : 'none',
          // Correlation ids, not credentials: `jti` matches the row Obligate
          // wrote when it minted, and the one the audience wrote when it
          // verified. The token itself is never logged or stored.
          delegationJti: credential?.jti ?? null,
          delegationKid: credential?.kid ?? null,
          ...extra,
        },
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });
    };

    // ── 1. Oblidesk authorises first, in its own model ──────────────────────
    // The capability was checked by the route; this is the tenant half of the
    // same question, and it is deliberately not "master tenant sees all".
    const ci = (await scoped('cis', tenantId)
      .where('cis.id', ciId)
      .whereNull('cis.deleted_at')
      .first('id', 'display_name', 'hardware_uuid')) as CiRow | undefined;

    if (!ci) {
      await audit('no_ci');
      return unavailable(app, 'no_ci');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_BUDGET_MS);

    try {
      const links = await resolveLinks(tenantId, ci, controller.signal);
      const link: SourceLink = links[app] ?? {
        app,
        rowId: null,
        externalId: null,
        externalPath: null,
        url: null,
        base: null,
        cachedPayload: null,
        lastFetchedAt: null,
      };

      // ── 2. Circuit breaker, per (app, tenant) ────────────────────────────
      // A dead sibling must not make every ticket open wait four seconds.
      const key = breakerKey(app, tenantId);
      if (breakerIsOpen(key)) {
        const cached = staleFrom(link, 'circuit_open');
        await audit('circuit_open', { served: cached ? 'cache' : 'none' });
        return cached ?? unavailable(app, 'circuit_open');
      }

      const raw = await appConfigService.getObligateRaw();
      if (!raw.url || !raw.apiKey) {
        // Without Obligate there is no way to establish the acting user's
        // authority, so there is no read AND no cached answer (`staleFrom`
        // refuses this reason). That is a configuration fact, not a flaky
        // source: the breaker stays shut.
        await audit('not_configured', { served: 'none' });
        return unavailable(app, 'not_configured');
      }

      // ── 3. The credential: the ACTING USER's authority, or nothing ───────
      // Minted per (user, audience, tenant slug) and cached for ~90 s of its
      // 120 s life by `delegation.service`, so this costs one round trip per
      // user per app per minute and a half, not one per request.
      //
      // It returns an OUTCOME and never throws, so a mint failure returns from
      // right here and never reaches the catch below that opens the breaker:
      // a mint failure is Obligate's problem, and suspending calls to an
      // innocent sibling for a minute would point the next reader at the wrong
      // app.
      const delegated = await delegationService.getTokenOutcome({
        userId: input.actorId,
        // ONE audience: the app this section reads, and nothing else. Never an
        // array, never a wildcard — a token good for two apps is a token whose
        // leak costs twice as much.
        audience: app,
        tenantSlug: input.tenantSlug,
        tenantId,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });

      if (!delegated.ok) {
        // No token, no read, and NO FALLBACK to the static app key. The rail
        // shows the reason instead, because a section that quietly reads with
        // the wrong authority is worse than a section that says it cannot.
        const reason: CiLiveReason =
          delegated.refusal === 'not_configured'
            ? 'not_configured'
            : delegated.refusal === 'refused' || delegated.refusal === 'no_obligate_identity'
              ? 'not_authorised'
              : 'obligate_unreachable';
        await audit(reason, { served: 'none', delegation: delegated.refusal, delegationDetail: delegated.detail });
        return unavailable(app, reason);
      }

      credential = delegated.token;

      const ctx: FetchContext = {
        token: credential.token,
        tenantSlug: input.tenantSlug,
        signal: controller.signal,
        obligateBase: safeBase(raw.url),
      };

      // ── 4. The read itself, as the acting user ───────────────────────────
      const data = await PLANS[app]({ tenantId, ci, link, links, fetch: ctx });
      breakerSucceeded(key);

      if (!data) {
        // Nothing to show is NOT a failure, and it must not look like one: an
        // app that simply does not hold this machine gets an empty body, which
        // the rail renders as "aucune donnee". The distinction from a source we
        // could not read is the whole point of this file, so the empty body is
        // literally empty (the client reads zero keys as "empty") and the
        // reason lives in the audit row instead.
        await audit('empty', { reason: 'not_linked' });
        return result(app, { status: 'empty', data: {}, url: link.url });
      }

      const fetchedAt = new Date();
      await rememberPayload(tenantId, ci.id, link, ci.hardware_uuid, data, fetchedAt);
      await audit('ok', { served: 'source', url: link.url });

      return result(app, {
        status: 'ok',
        data: withMeta(data, link, {
          stale: false,
          lastFetchedAt: fetchedAt.toISOString(),
          reason: null,
        }),
        url: link.url,
        lastFetchedAt: fetchedAt.toISOString(),
      });
    } catch (error) {
      const reason: CiLiveReason =
        error instanceof SourceUnavailable
          ? error.reason
          : controller.signal.aborted
            ? 'timeout'
            : 'source_error';

      // Permanent conditions (no link, refused, not configured) say nothing
      // about the source being flaky, so they must not open the breaker: doing
      // so would suppress the honest reason for a minute and replace it with
      // "circuit_open", which points the reader at the wrong problem.
      if (!PERMANENT_REASONS.has(reason)) breakerFailed(breakerKey(app, tenantId));

      if (!(error instanceof SourceUnavailable)) {
        logger.warn(
          { err: (error as Error).message, tenantId, ciId, app },
          'ci live: unexpected failure reading a sibling app',
        );
      }

      // The link is re-read only to reach the cache: `resolveLinks` may itself
      // be what failed, so this is a plain, cheap row lookup.
      const cached = await cachedLink(tenantId, ciId, app);
      const stale = cached ? staleFrom(cached, reason) : null;
      await audit(reason, { served: stale ? 'cache' : 'none' });
      return stale ?? unavailable(app, reason);
    } finally {
      clearTimeout(timer);
    }
  },
};

/** The cache row alone, for the failure path. Never throws. */
async function cachedLink(
  tenantId: number,
  ciId: number,
  app: CiSourceApp,
): Promise<SourceLink | null> {
  try {
    const row = (await scoped('ci_source_links', tenantId)
      .where({ 'ci_source_links.ci_id': ciId, 'ci_source_links.app_type': app })
      // NULLS LAST explicitly: Postgres sorts NULL first on a DESC order, so a
      // link row that has never been read would otherwise win over the one
      // holding the payload we are here to show.
      .orderBy('last_fetched_at', 'desc', 'last')
      .first('id', 'app_type', 'external_id', 'external_path', 'url', 'last_fetched_at', 'payload')) as
      | LinkRow
      | undefined;
    if (!row) return null;
    return {
      app,
      rowId: row.id,
      externalId: row.external_id,
      externalPath: row.external_path,
      url: row.url,
      base: safeBase(row.url),
      cachedPayload: parseJsonColumn(row.payload),
      lastFetchedAt: toIso(row.last_fetched_at),
    };
  } catch {
    return null;
  }
}

export default ciLiveService;
