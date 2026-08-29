/**
 * ci.api.ts — every cross-app read the context rail makes, and the honesty
 * policy that goes with them.
 *
 * ── The problem this file exists to solve ────────────────────────────────────
 * The context rail shows data that Oblidesk does not own: device health from
 * Obliance, monitor state from Obliview, bans from Obliguard, the site from
 * Oblimap. Those are five separate services with five separate ways of being
 * down, and the rail renders next to a ticket a technician is about to act on.
 *
 * A rail that shows a spinner forever, or silently drops a section it could not
 * reach, teaches technicians to distrust ALL of it — and a source they distrust
 * is worse than a source they do not have, because they stop reading the ones
 * that work. So every section here returns a RESULT, never a throw:
 *
 *     { status: 'ok',            data, fetchedAt }
 *     { status: 'empty',         data: null, fetchedAt }      nothing to show
 *     { status: 'unavailable',   reason, fetchedAt }          not deployed / 5xx
 *     { status: 'forbidden',     reason, fetchedAt }          you may not see it
 *     { status: 'timeout',       reason, fetchedAt }          took too long
 *     { status: 'circuit_open',  reason, fetchedAt, stale }   we stopped asking
 *
 * `fetchedAt` is what the rail turns into "dernière lecture il y a 4 min". A
 * section that has not been refreshed in an hour must LOOK an hour old.
 *
 * ── Timeout and circuit breaker, per section ────────────────────────────────
 * Each section has its own AbortController and its own breaker keyed on
 * (section, subject). One dead sibling app must not slow the four that answer,
 * and once a source has failed three times in a row we stop asking for 60 s and
 * say so — hammering a service that is already struggling is how a degraded
 * dependency becomes an outage.
 *
 * ── What is real today ──────────────────────────────────────────────────────
 * `ciTickets` is implemented: `GET /api/tickets?ciIds=` exists and is scoped.
 * The CI projection service (`/api/ci/**`), the contract endpoint and the
 * suite-alert list are NOT on this server yet, so those probes return
 * `unavailable` with a reason that names the missing endpoint rather than a
 * spinner that never ends. When those routes land, this file needs no change:
 * the same call starts returning 200 and the rail lights up.
 */
import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { CI_SOURCE_APPS } from '@oblidesk/shared';
import type { Ci, Contract, SuiteAlert, TicketWithRelations } from '@oblidesk/shared';
import apiClient from '@/api/client';

// ═════════════════════════════════════════════════════════════════════════════
// Result shape
// ═════════════════════════════════════════════════════════════════════════════

export type SectionStatus =
  | 'ok'
  | 'empty'
  | 'unavailable'
  | 'forbidden'
  | 'timeout'
  | 'circuit_open';

export interface SectionResult<T> {
  section: string;
  status: SectionStatus;
  data: T | null;
  /** i18n key + inline French fallback, ready for `t(key, fallback)`. */
  reasonKey: string | null;
  reason: string | null;
  /** ISO timestamp of THIS read — the rail renders "dernière lecture il y a X". */
  fetchedAt: string;
  /** Which sibling app the section speaks for, when it speaks for one. */
  sourceApp: string | null;
  /** Deep link into the source app, when the payload carried one. */
  href: string | null;
  /** True when `data` is the last good payload rather than a fresh read. */
  stale: boolean;
}

function result<T>(
  section: string,
  status: SectionStatus,
  patch: Partial<SectionResult<T>> = {},
): SectionResult<T> {
  return {
    section,
    status,
    data: null,
    reasonKey: null,
    reason: null,
    fetchedAt: new Date().toISOString(),
    sourceApp: null,
    href: null,
    stale: false,
    ...patch,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Circuit breaker
// ═════════════════════════════════════════════════════════════════════════════

/** Consecutive failures before we stop asking. */
const BREAKER_THRESHOLD = 3;
/** How long the breaker stays open. */
const BREAKER_OPEN_MS = 60_000;
/** Default per-section budget. A rail section is not worth more than this. */
export const SECTION_TIMEOUT_MS = 4_000;

interface BreakerState {
  failures: number;
  openedAt: number;
  /** Last successful payload, so an open breaker can still show something old. */
  lastGood: { data: unknown; at: string } | null;
}

const breakers = new Map<string, BreakerState>();

function breakerFor(key: string): BreakerState {
  let state = breakers.get(key);
  if (!state) {
    state = { failures: 0, openedAt: 0, lastGood: null };
    breakers.set(key, state);
  }
  return state;
}

function breakerIsOpen(state: BreakerState): boolean {
  if (state.failures < BREAKER_THRESHOLD) return false;
  if (Date.now() - state.openedAt < BREAKER_OPEN_MS) return true;
  // Half-open: let exactly one probe through and judge on its outcome.
  state.failures = BREAKER_THRESHOLD - 1;
  return false;
}

/** Forget every breaker — call after a tenant switch or an explicit "retry all". */
export function resetCircuitBreakers(prefix?: string): void {
  if (!prefix) {
    breakers.clear();
    return;
  }
  for (const key of [...breakers.keys()]) if (key.startsWith(prefix)) breakers.delete(key);
}

/** Diagnostics for the rail's footer: how many sources are currently tripped. */
export function openCircuitCount(): number {
  let open = 0;
  for (const state of breakers.values()) if (breakerIsOpen(state)) open += 1;
  return open;
}

// ═════════════════════════════════════════════════════════════════════════════
// The one probe every section goes through
// ═════════════════════════════════════════════════════════════════════════════

interface ProbeOptions {
  section: string;
  /** Breaker identity — section plus whatever makes this call distinct. */
  key: string;
  url: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  sourceApp?: string | null;
  /** Turn a 200 body into the section payload, or `null` for "nothing to show". */
  select: (body: unknown) => { data: unknown; href?: string | null } | null;
}

/**
 * One guarded read.
 *
 * Never throws. Every failure mode becomes a status the rail can render and a
 * sentence a human can act on — "Obliview n'expose pas encore cette section"
 * beats "Erreur" by exactly the amount of trust the rail is trying to keep.
 */
async function probe<T>(options: ProbeOptions): Promise<SectionResult<T>> {
  const { section, key, url, params, sourceApp = null } = options;
  const state = breakerFor(key);

  if (breakerIsOpen(state)) {
    return result<T>(section, 'circuit_open', {
      sourceApp,
      data: (state.lastGood?.data ?? null) as T | null,
      stale: state.lastGood !== null,
      fetchedAt: state.lastGood?.at ?? new Date().toISOString(),
      reasonKey: 'ci.section.circuitOpen',
      reason:
        'Source injoignable à plusieurs reprises. Les appels sont suspendus une minute.',
    });
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), options.timeoutMs ?? SECTION_TIMEOUT_MS);

  const config: AxiosRequestConfig = { params, signal: controller.signal };

  try {
    const response = await apiClient.get<unknown>(url, config);
    const selected = options.select(response.data);

    state.failures = 0;

    if (selected === null) {
      return result<T>(section, 'empty', { sourceApp });
    }

    const at = new Date().toISOString();
    state.lastGood = { data: selected.data, at };

    return result<T>(section, 'ok', {
      sourceApp,
      data: selected.data as T,
      href: selected.href ?? null,
      fetchedAt: at,
    });
  } catch (error: unknown) {
    const aborted = controller.signal.aborted;
    const status = axios.isAxiosError(error) ? error.response?.status ?? 0 : 0;

    // A 404 is not a failure of the source — it is this server telling us the
    // endpoint does not exist yet. Tripping the breaker on it would hide a
    // permanent, explainable condition behind a temporary-looking one.
    if (status === 404) {
      return result<T>(section, 'unavailable', {
        sourceApp,
        reasonKey: 'ci.section.notDeployed',
        reason: `Cette source n’est pas encore exposée par ce serveur (${url}).`,
      });
    }

    if (status === 401 || status === 403) {
      state.failures = 0;
      return result<T>(section, 'forbidden', {
        sourceApp,
        reasonKey: 'ci.section.forbidden',
        reason: 'Vous n’avez pas le droit de lire cette source.',
      });
    }

    state.failures += 1;
    if (state.failures >= BREAKER_THRESHOLD) state.openedAt = Date.now();

    if (aborted) {
      return result<T>(section, 'timeout', {
        sourceApp,
        data: (state.lastGood?.data ?? null) as T | null,
        stale: state.lastGood !== null,
        reasonKey: 'ci.section.timeout',
        reason: `Pas de réponse en ${Math.round((options.timeoutMs ?? SECTION_TIMEOUT_MS) / 1000)} s.`,
      });
    }

    const detail =
      axios.isAxiosError(error) && typeof error.response?.data === 'object'
        ? ((error.response?.data as { error?: string }).error ?? null)
        : null;

    return result<T>(section, 'unavailable', {
      sourceApp,
      data: (state.lastGood?.data ?? null) as T | null,
      stale: state.lastGood !== null,
      reasonKey: 'ci.section.unavailable',
      reason: detail ?? (status ? `Le serveur a répondu ${status}.` : 'Source injoignable.'),
    });
  } finally {
    window.clearTimeout(timer);
  }
}

/** Unwrap `{ success, data }` without assuming the envelope is present. */
function envelope(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: unknown }).data;
  }
  return body;
}

function nonEmptyArray(body: unknown): { data: unknown } | null {
  const data = envelope(body);
  if (!Array.isArray(data) || data.length === 0) return null;
  return { data };
}

// ═════════════════════════════════════════════════════════════════════════════
// Sections
// ═════════════════════════════════════════════════════════════════════════════

/** Ordered exactly as the rail renders them (CI_SOURCE_APPS from shared). */
export const CI_LIVE_SECTIONS = CI_SOURCE_APPS;
export type CiLiveSection = (typeof CI_LIVE_SECTIONS)[number];

/** Human heading per source, i18n key + French fallback. */
export const CI_SECTION_LABELS: Readonly<
  Record<CiLiveSection, { key: string; fallback: string }>
> = {
  obliance: { key: 'ci.section.obliance', fallback: 'Poste (Obliance)' },
  obliview: { key: 'ci.section.obliview', fallback: 'Supervision (Obliview)' },
  obliguard: { key: 'ci.section.obliguard', fallback: 'Sécurité (Obliguard)' },
  oblimap: { key: 'ci.section.oblimap', fallback: 'Site (Oblimap)' },
  obligate: { key: 'ci.section.obligate', fallback: 'Identité (Obligate)' },
};

/**
 * The CI itself, as Oblidesk projected it.
 *
 * This is desk-owned data (`cis` + `ci_source_links` + `ci_overlays`), so when
 * it is unavailable the whole rail is unavailable and the sections below it are
 * not even attempted.
 */
export function fetchCi(ciId: number): Promise<SectionResult<Ci>> {
  return probe<Ci>({
    section: 'ci',
    key: `ci:${ciId}`,
    url: `/ci/${ciId}`,
    select: (body) => {
      const data = envelope(body);
      return data && typeof data === 'object' ? { data } : null;
    },
  });
}

/**
 * One sibling app's live view of the CI.
 *
 * The desk proxies: the browser must never call Obliview directly (different
 * origin, different session, and the tenant mapping is by SLUG — HARD RULE 13 —
 * which only the server can resolve).
 */
export function fetchCiLiveSection(
  ciId: number,
  app: CiLiveSection,
): Promise<SectionResult<Record<string, unknown>>> {
  return probe<Record<string, unknown>>({
    section: app,
    key: `${app}:${ciId}`,
    url: `/ci/${ciId}/live/${app}`,
    sourceApp: app,
    select: (body) => {
      const data = envelope(body);
      if (!data || typeof data !== 'object') return null;
      const record = data as Record<string, unknown>;
      if (Object.keys(record).length === 0) return null;
      const href = typeof record.url === 'string' ? record.url : null;
      return { data: record, href };
    },
  });
}

/**
 * The CI's recent tickets.
 *
 * REAL TODAY — the ticket list endpoint accepts `ciIds`, so this section works
 * on a stock deployment and is the rail's proof that "unavailable" elsewhere
 * means the source, not the rail.
 */
export function fetchCiTickets(
  ciId: number,
  limit = 5,
): Promise<SectionResult<TicketWithRelations[]>> {
  return probe<TicketWithRelations[]>({
    section: 'ci_tickets',
    key: `ci_tickets:${ciId}`,
    url: '/tickets',
    params: { ciIds: String(ciId), limit, sortBy: 'updated_at', sortDir: 'desc' },
    select: nonEmptyArray,
  });
}

/**
 * Contract coverage for the requester's organisation.
 *
 * The chip answers one question — "is this customer covered right now, and how
 * much of their block is left?" — and it must never guess. No contract service
 * on this server yet, so today this reports `unavailable` and the chip says so.
 */
export function fetchContractCoverage(
  organizationId: number,
): Promise<SectionResult<Contract[]>> {
  return probe<Contract[]>({
    section: 'contract',
    key: `contract:${organizationId}`,
    url: '/contracts',
    params: { organizationId, active: true },
    select: nonEmptyArray,
  });
}

/**
 * Suite alerts that have not become a ticket.
 *
 * The fourth column of the shift board, and the only place in the product where
 * an incident the suite already knows about is visibly NOT yet somebody's
 * problem. Ingest exists (`POST /api/alerts/ingest`); the read side does not
 * yet, so the column renders an honest "source indisponible" rather than an
 * empty list that would read as "all clear".
 */
export function fetchUnboundAlerts(limit = 50): Promise<SectionResult<SuiteAlert[]>> {
  return probe<SuiteAlert[]>({
    section: 'unbound_alerts',
    key: 'unbound_alerts',
    url: '/alerts',
    params: { bound: false, cleared: false, limit },
    timeoutMs: 6_000,
    select: (body) => {
      const data = envelope(body);
      if (!Array.isArray(data)) return null;
      // An EMPTY array is a real answer here ("rien en attente"), not "nothing
      // to show" — the board must be able to say "aucune alerte orpheline".
      return { data };
    },
  });
}

/**
 * Everything the rail needs for one CI, fetched in parallel AFTER first paint.
 *
 * Parallel and independent: five sources, five budgets, five outcomes. The
 * caller renders each result as it lands rather than waiting for the slowest —
 * `Promise.allSettled` semantics are built into `probe`, which never rejects.
 */
export async function fetchCiRail(
  ciId: number,
): Promise<{
  ci: SectionResult<Ci>;
  tickets: SectionResult<TicketWithRelations[]>;
  live: Array<SectionResult<Record<string, unknown>>>;
}> {
  const [ci, tickets, live] = await Promise.all([
    fetchCi(ciId),
    fetchCiTickets(ciId),
    Promise.all(CI_LIVE_SECTIONS.map((app) => fetchCiLiveSection(ciId, app))),
  ]);
  return { ci, tickets, live };
}
