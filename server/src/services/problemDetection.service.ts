/**
 * problemDetection.service.ts — the recurrence detector.
 *
 * This is the module that reads a fortnight of the desk and says "these nine
 * tickets are one problem". Everything else in problem management is a place to
 * put an answer; this is the only part that asks the question nobody had time
 * to ask.
 *
 * ── What it produces, and what it is forbidden to produce ────────────────────
 * It produces `problem_candidates` rows: a SUGGESTION, scored, carrying the
 * incidents that make the case, waiting for a human. It never opens a problem
 * on its own. The reason is not timidity: a problem opened by a machine has no
 * owner, and an unowned problem is a row that ages until someone deletes the
 * board.
 *
 * ── The six signals, and the one that is not allowed to decide ───────────────
 * Three signals are EXACT machine identities and can anchor a candidate:
 *
 *   ci_repetition     the same configuration item keeps breaking
 *   alert_flapping    the same dedupe key clears and comes back
 *   known_error_miss  new incidents landing on an already published known error
 *
 * Three are corroborating and only ever ride on an anchor:
 *
 *   subject_cluster   the anchor's incidents are described the same way
 *   reopen_pressure   the anchor's incidents keep being reopened
 *   queue_spike       the anchor's queue is above its own 28-day baseline
 *
 * The split is arithmetic, not taste. With the shipped weights, noisy-OR gives
 * `subject_cluster + queue_spike`, both fully saturated, 0.545 against a 0.60
 * threshold: text alone CANNOT raise a card. `requireExactSignal` keeps that
 * true after a tenant edits the weights. A card raised because two tickets both
 * contain the word "printer" teaches agents to reject without reading, and a
 * suggestion box nobody reads is worth less than no suggestion box.
 *
 * That is also why the `text:` / `reopen:` / `queue:` signature families exist
 * in `@oblidesk/shared` but this pass anchors on none of them: a card anchored
 * there could not qualify while `requireExactSignal` is on, and proposing cards
 * that are withheld every hour is a way to burn a detector's credibility
 * without ever showing anyone a card.
 *
 * ── HARD RULE 2, and the volumetrics that make it survivable ─────────────────
 * Every card PROPOSED, SUPPRESSED, ESCALATED, ACCEPTED or REJECTED writes its
 * `decision_log` row through `withDecision()`, on the same code path and in the
 * same transaction, naming the incidents that triggered it. Two rulings keep
 * that ledger readable rather than turning it into a log file:
 *
 *   • A re-detection BUMPS an existing card and writes NO row. It is the same
 *     conclusion re-affirmed, not a new decision, and the fact is recorded on
 *     the row it bumped (`occurrence_count`, `last_seen_at`) — exactly as
 *     `alert.service` bumps `suite_alerts.occurrence_count` on a dedupe hit
 *     without a decision row per alert.
 *   • A suppressed signature writes at most ONE row per
 *     `SUPPRESSION_NOTICE_INTERVAL_MS`. A suppression is a STANDING decision
 *     that a human already took; the row exists so that "why did this go quiet
 *     for three months?" is answerable, and one row a day answers it while
 *     twenty-four do not.
 *
 * A pass that changed nothing writes nothing at all. A journal that logs "I
 * looked and did nothing" every hour buries the twelve rows that matter.
 *
 * ── The bound ────────────────────────────────────────────────────────────────
 * A tenant with 50 000 incidents must cost the same as a tenant with 500. No
 * query here is unbounded and none of them joins tickets to tickets:
 *
 *   1. ONE window read, `ORDER BY coalesce(occurred_at, created_at) DESC LIMIT
 *      MAX_WINDOW_TICKETS`, straight down `tickets_tenant_type_occurred`. The
 *      grouping by CI then happens in memory over at most that many rows.
 *   2. The alert and known-error queries GROUP in Postgres and `LIMIT` the
 *      number of groups.
 *   3. Anchors are capped at `MAX_ANCHORS_PER_PASS`, strongest exact signal
 *      first, so every per-anchor query below is a bounded number of bounded
 *      queries.
 *   4. The trigram cluster is one indexed `subject % seed` probe per anchor
 *      with its own `LIMIT` — never a global O(n²) clustering pass, which is
 *      the number one technical reason these features end up switched off.
 *   5. Every candidate keeps at most `MAX_TICKETS_PER_ANCHOR` incidents.
 *
 * ── HARD RULES 3 and 4 ───────────────────────────────────────────────────────
 * The thresholds, the window and the weights are a published `config_objects`
 * row of kind `problem_detection`, referenced by SLUG, and its
 * `body_format_version` is checked on read: a body from a future format is
 * REFUSED, never guessed at. The slug and version are stamped on every card and
 * every decision row, so a card can be replayed against the configuration that
 * produced it.
 */

import type { Knex } from 'knex';

import {
  CASCADE_ELIGIBLE_RECORD_TYPES,
  CONFIG_BODY_FORMAT_VERSIONS,
  DEFAULT_PROBLEM_DETECTION_BODY,
  LIMITS,
  OPEN_STATUS_CATEGORIES,
  PROBLEM_DECISIONS,
  PROBLEM_DETECTION_DEFAULT_SLUG,
  PROBLEM_DETECTION_SIGNALS,
  PROBLEM_LINK_KIND,
  alertCandidateSignature,
  assertProblemLimitsAgree,
  ciCandidateSignature,
  evaluateCandidateSuppression,
  knownErrorMissCandidateSignature,
  scoreProblemCandidate,
  signalSaturation,
  type AcceptProblemCandidateRequest,
  type ProblemCandidate,
  type ProblemCandidateState,
  type ProblemCandidateTicket,
  type ProblemCandidateWithTickets,
  type ProblemDetectionBody,
  type ProblemDetectionRunOutcome,
  type ProblemDetectionSignal,
  type ProblemSignalReading,
  type ProblemSignalReadings,
  type ProblemSignalSpec,
  type ProblemWithRelations,
  type PromoteIncidentRequest,
  type RejectProblemCandidateRequest,
} from '@oblidesk/shared';

import { db, insertScoped, scoped, scopedAs, type Executor } from '../db';
import { logger } from '../utils/logger';
import { AppError, badRequest, conflict, notFound } from '../middleware/errorHandler';
import { withDecision } from './decision.service';
import { readPublishedConfigObject } from './stateMachine.service';
import type { ActorContext } from './ticket.service';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Bounds and cadence
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The single hard ceiling on the whole pass. The window read takes the most
 * recent N incidents and stops; a desk with 50 000 incidents in a fortnight
 * costs exactly what a desk with 5 000 costs, and what it loses is the OLDEST
 * end of the window — the end a recurrence detector cares about least.
 */
const MAX_WINDOW_TICKETS = 5_000;

/** Groups one anchor family may return. Applied as a SQL LIMIT on the grouped query. */
const MAX_ANCHORS_PER_FAMILY = 25;

/**
 * Anchors carried into the (per-anchor) enrichment queries, strongest exact
 * signal first. Everything after this point is `MAX_ANCHORS_PER_PASS` small
 * indexed queries, which is what keeps the pass linear in the CAP rather than
 * in the tenant.
 */
const MAX_ANCHORS_PER_PASS = 20;

/** Incidents kept on one candidate. The board shows evidence, not an export. */
const MAX_TICKETS_PER_ANCHOR = 50;

/** Rows the trigram probe may examine for one anchor. Its own LIMIT, per query. */
const MAX_CLUSTER_SCAN = 200;

/** Days of history the queue-spike baseline is computed over. */
const QUEUE_BASELINE_DAYS = 28;

/**
 * How often a still-suppressed signature is worth a `decision_log` row.
 *
 * A suppression is a standing human decision, not an hourly one. Writing it
 * every pass would put ~2 100 identical rows behind one rejection and bury the
 * rows that explain an actual card. One a day keeps "why did this go quiet?"
 * answerable at the resolution anyone ever asks it.
 */
const SUPPRESSION_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * The sweep cadence: hourly, not the SLA ticker's 60 seconds.
 *
 * An SLA breach is a deadline and a minute late is a minute wrong. A recurrence
 * is a shape that takes days to form: a signature that qualifies at 14:00 still
 * qualifies at 15:00, and sweeping sixty times more often would buy nothing but
 * sixty times the query load and sixty times the chance of racing a human who
 * is deciding on the card.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

/** Record types a candidate may be built from. A problem never recurses onto a problem. */
const INCIDENT_RECORD_TYPES: readonly string[] = [...CASCADE_ELIGIBLE_RECORD_TYPES];

/** Categories in which a problem still counts as open for the absorption test. */
const LIVE_CATEGORIES: readonly string[] = [...OPEN_STATUS_CATEGORIES];

/** Config kind and the day-one slug (HARD RULE 3 — by slug, never by id). */
const DETECTOR_KIND = 'problem_detection';

/**
 * `detector_version` written when the pass ran on the SHIPPED baseline because
 * the tenant has no published object. Zero is not "unknown": it names the
 * constant in `@oblidesk/shared`, which is as retrievable as a stored row and
 * is versioned by the release rather than by `config_objects.version`.
 */
const BUILTIN_DETECTOR_VERSION = 0;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Small helpers
// ═════════════════════════════════════════════════════════════════════════════

function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** `decimal(5,4)` columns. Rounding at the edge keeps the DB and the UI agreeing. */
function scale4(value: number): number {
  return Number(clamp(value, 0, 1).toFixed(4));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** `int[]` coming back from `array_agg`. pg hands them over as JS arrays already. */
function intArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    const parsed = num(entry, Number.NaN);
    if (Number.isInteger(parsed) && parsed > 0) out.push(parsed);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — The detector body (HARD RULES 3 and 4)
// ═════════════════════════════════════════════════════════════════════════════

export interface LoadedDetector {
  /** HARD RULE 3 — the slug is the reference, stamped on every card it raises. */
  slug: string;
  /** `config_objects.version`, or 0 for the shipped baseline. */
  version: number;
  body: ProblemDetectionBody;
  /** True when no published object was found and the shipped baseline was used. */
  builtin: boolean;
}

function normalizeSignalSpec(raw: unknown, fallback: ProblemSignalSpec): ProblemSignalSpec {
  const source = (raw ?? {}) as Partial<ProblemSignalSpec>;
  const spec: ProblemSignalSpec = {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    weight: clamp(num(source.weight, fallback.weight), 0, 1),
    // A threshold of zero would make `signalSaturation` return 1 for any
    // observation at all, which is how a detector starts proposing everything.
    threshold: Math.max(1, Math.round(num(source.threshold, fallback.threshold))),
  };
  const secondary = source.secondary ?? fallback.secondary;
  if (secondary !== undefined) spec.secondary = num(secondary, 0);
  return spec;
}

/**
 * Merge a stored body over the shipped baseline.
 *
 * Missing keys are FILLED (an object written by an older editor must not turn
 * the detector into a no-op); an unknown `body_format_version` is REFUSED by
 * the caller rather than merged, because a future shape's key may mean
 * something this release would misread.
 */
function normalizeDetectionBody(raw: unknown): ProblemDetectionBody {
  const base = DEFAULT_PROBLEM_DETECTION_BODY;
  const source = (raw ?? {}) as Partial<ProblemDetectionBody>;
  const rawSignals = (source.signals ?? {}) as Partial<Record<ProblemDetectionSignal, unknown>>;

  const signals = {} as Record<ProblemDetectionSignal, ProblemSignalSpec>;
  for (const name of PROBLEM_DETECTION_SIGNALS) {
    signals[name] = normalizeSignalSpec(rawSignals[name], base.signals[name]);
  }

  const rejection = (source.rejection ?? {}) as Partial<ProblemDetectionBody['rejection']>;

  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : base.enabled,
    windowDays: Math.round(clamp(num(source.windowDays, base.windowDays), 1, 90)),
    scoreThreshold: clamp(num(source.scoreThreshold, base.scoreThreshold), 0, 1),
    maxNewCandidatesPerRun: Math.round(
      clamp(num(source.maxNewCandidatesPerRun, base.maxNewCandidatesPerRun), 0, 50),
    ),
    requireExactSignal:
      typeof source.requireExactSignal === 'boolean'
        ? source.requireExactSignal
        : base.requireExactSignal,
    signals,
    rejection: {
      cooldownDays: Math.round(
        clamp(num(rejection.cooldownDays, base.rejection.cooldownDays), 0, 3_650),
      ),
      escalationFactor: clamp(
        num(rejection.escalationFactor, base.rejection.escalationFactor),
        1,
        10,
      ),
    },
    defaultQueueSlug:
      typeof source.defaultQueueSlug === 'string' ? source.defaultQueueSlug : base.defaultQueueSlug,
    defaultPrioritySlug:
      typeof source.defaultPrioritySlug === 'string'
        ? source.defaultPrioritySlug
        : base.defaultPrioritySlug,
  };
}

/**
 * Read the tenant's detector, or fall back to the shipped baseline.
 *
 * Returns `null` ONLY for a body this release cannot read. `configKinds.ts`
 * states the rule plainly: "a reader that meets a body_format_version it does
 * not know MUST refuse to evaluate it rather than guess." Guessing here would
 * mean raising cards from thresholds nobody wrote.
 */
export async function loadDetector(
  tenantId: number,
  slug: string = PROBLEM_DETECTION_DEFAULT_SLUG,
  executor: Executor = db,
): Promise<LoadedDetector | null> {
  const row = await readPublishedConfigObject(tenantId, DETECTOR_KIND, slug, executor);
  if (!row) {
    return {
      slug: PROBLEM_DETECTION_DEFAULT_SLUG,
      version: BUILTIN_DETECTOR_VERSION,
      body: DEFAULT_PROBLEM_DETECTION_BODY,
      builtin: true,
    };
  }

  const supported = CONFIG_BODY_FORMAT_VERSIONS[DETECTOR_KIND];
  if (row.bodyFormatVersion > supported) {
    logger.warn(
      { tenantId, slug: row.slug, bodyFormatVersion: row.bodyFormatVersion, supported },
      'problem detection: refusing a detector body from a newer format — the detector stands down for this tenant',
    );
    return null;
  }

  return {
    slug: row.slug,
    version: row.version,
    body: normalizeDetectionBody(row.body),
    builtin: false,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Row shapes
// ═════════════════════════════════════════════════════════════════════════════

/** What the pass needs to know about one incident. Nothing else is read. */
interface TicketFacts {
  id: number;
  number: string;
  subject: string;
  queueSlug: string | null;
  reopenCount: number;
  /** `coalesce(occurred_at, created_at)` — HARD RULE 6: when it HAPPENED. */
  at: string;
  primaryCiId: number | null;
}

type AnchorFamily = 'ci' | 'alert' | 'known_error_miss';

/** A candidate under construction. One anchor family, many signal readings. */
interface AnchorDraft {
  signature: string;
  family: AnchorFamily;
  /** The anchoring signal, i.e. the one that made this anchor exist at all. */
  anchorSignal: ProblemDetectionSignal;
  /** Set from real tenant data (an incident subject), never an English sentence. */
  title: string;
  ciId: number | null;
  dedupeKey: string | null;
  queueSlug: string | null;
  /** ticket id → the signal that retained it. First writer wins: the anchor. */
  tickets: Map<number, ProblemDetectionSignal>;
  signals: ProblemSignalReadings;
  /** Seeds the trigram probe. The most recent retained subject. */
  seedTicketId: number | null;
  seedSubject: string | null;
}

interface CandidateRow {
  id: number;
  tenant_id: number;
  signature: string;
  state: string;
  score: string | number;
  signals: unknown;
  title: string;
  ci_id: number | null;
  dedupe_key: string | null;
  queue_slug: string | null;
  incident_count: number;
  window_start: unknown;
  window_end: unknown;
  detector_slug: string;
  detector_version: number;
  occurrence_count: number;
  proposed_at: unknown;
  last_seen_at: unknown;
  decided_at: unknown;
  decided_by: number | null;
  decision_note: string | null;
  problem_ticket_id: number | null;
  suppressed_until: unknown;
  superseded_candidate_id: number | null;
}

function mapCandidate(row: CandidateRow): ProblemCandidate {
  const rawSignals = typeof row.signals === 'string' ? JSON.parse(row.signals) : row.signals;
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    signature: String(row.signature),
    state: String(row.state) as ProblemCandidateState,
    score: num(row.score),
    signals: (rawSignals ?? {}) as ProblemSignalReadings,
    title: String(row.title),
    ciId: row.ci_id === null ? null : Number(row.ci_id),
    dedupeKey: row.dedupe_key === null ? null : String(row.dedupe_key),
    queueSlug: row.queue_slug === null ? null : String(row.queue_slug),
    incidentCount: Number(row.incident_count),
    windowStart: toIso(row.window_start),
    windowEnd: toIso(row.window_end),
    detectorSlug: String(row.detector_slug),
    detectorVersion: Number(row.detector_version),
    occurrenceCount: Number(row.occurrence_count),
    proposedAt: toIso(row.proposed_at),
    lastSeenAt: toIso(row.last_seen_at),
    decidedAt: toIsoOrNull(row.decided_at),
    decidedBy: row.decided_by === null ? null : Number(row.decided_by),
    decisionNote: row.decision_note === null ? null : String(row.decision_note),
    problemTicketId: row.problem_ticket_id === null ? null : Number(row.problem_ticket_id),
    suppressedUntil: toIsoOrNull(row.suppressed_until),
    supersededCandidateId:
      row.superseded_candidate_id === null ? null : Number(row.superseded_candidate_id),
  };
}

const CANDIDATE_COLUMNS = 'problem_candidates.*';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — The bounded window read
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The most recent `MAX_WINDOW_TICKETS` incidents of the window.
 *
 * THE bound of the whole engine. `tickets_tenant_type_occurred` (migration 006)
 * is `(tenant_id, record_type, coalesce(occurred_at, created_at) DESC) WHERE
 * deleted_at IS NULL`, so this is an index scan that stops at the LIMIT: the
 * cost is the cap, never the tenant's size.
 *
 * Incidents already attached to a problem are excluded, and that exclusion is
 * the FIRST of the two absorption layers: an open problem swallows its own
 * incidents instead of letting them fuel a duplicate candidate next to it.
 */
async function readWindowTickets(
  tenantId: number,
  from: Date,
  to: Date,
  executor: Executor,
): Promise<TicketFacts[]> {
  const rows = (await scoped('tickets', tenantId, executor)
    .whereNull('tickets.deleted_at')
    .whereIn('tickets.record_type', INCIDENT_RECORD_TYPES)
    .whereRaw('coalesce(tickets.occurred_at, tickets.created_at) >= ?', [from])
    .whereRaw('coalesce(tickets.occurred_at, tickets.created_at) <= ?', [to])
    .whereNotExists((qb) =>
      // A joined tenant table is re-scoped by hand — `scoped()` only owns the
      // query root (see the note on `scopedAs` in server/src/db/index.ts).
      qb
        .select(executor.raw('1'))
        .from('ticket_link')
        .where('ticket_link.tenant_id', tenantId)
        .where('ticket_link.kind', PROBLEM_LINK_KIND)
        .whereRaw('ticket_link.from_ticket_id = tickets.id'),
    )
    .orderByRaw('coalesce(tickets.occurred_at, tickets.created_at) DESC')
    .limit(MAX_WINDOW_TICKETS)
    .select(
      'tickets.id',
      'tickets.number',
      'tickets.subject',
      'tickets.queue_slug',
      'tickets.reopen_count',
      'tickets.primary_ci_id',
      executor.raw('coalesce(tickets.occurred_at, tickets.created_at) AS at'),
    )) as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: num(row.id),
    number: String(row.number ?? ''),
    subject: String(row.subject ?? ''),
    queueSlug: row.queue_slug === null || row.queue_slug === undefined ? null : String(row.queue_slug),
    reopenCount: num(row.reopen_count),
    at: toIso(row.at),
    primaryCiId:
      row.primary_ci_id === null || row.primary_ci_id === undefined ? null : num(row.primary_ci_id),
  }));
}

/**
 * The second half of "which CI does this ticket touch".
 *
 * A CI is reached from a ticket in TWO real ways — `tickets.primary_ci_id` and
 * a `ticket_cis` row — and a query that tests only one of them under-counts
 * exactly the tickets an agent linked by hand while triaging. Bounded by the
 * window read that produced `ticketIds`.
 */
async function readTicketCis(
  tenantId: number,
  ticketIds: readonly number[],
  executor: Executor,
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (ticketIds.length === 0) return out;

  const rows = (await scoped('ticket_cis', tenantId, executor)
    .whereIn('ticket_cis.ticket_id', [...ticketIds])
    .select('ticket_cis.ticket_id', 'ticket_cis.ci_id')) as unknown as Array<
    Record<string, unknown>
  >;

  for (const row of rows) {
    const ticketId = num(row.ticket_id);
    const ciId = num(row.ci_id);
    if (ticketId <= 0 || ciId <= 0) continue;
    const list = out.get(ticketId);
    if (list) list.push(ciId);
    else out.set(ticketId, [ciId]);
  }
  return out;
}

/** Hydrate arbitrary retained ticket ids. Bounded by anchors × tickets-per-anchor. */
async function readTicketFacts(
  tenantId: number,
  ticketIds: readonly number[],
  executor: Executor,
): Promise<Map<number, TicketFacts>> {
  const out = new Map<number, TicketFacts>();
  if (ticketIds.length === 0) return out;

  const rows = (await scoped('tickets', tenantId, executor)
    .whereIn('tickets.id', [...ticketIds])
    .whereNull('tickets.deleted_at')
    .whereIn('tickets.record_type', INCIDENT_RECORD_TYPES)
    .select(
      'tickets.id',
      'tickets.number',
      'tickets.subject',
      'tickets.queue_slug',
      'tickets.reopen_count',
      'tickets.primary_ci_id',
      executor.raw('coalesce(tickets.occurred_at, tickets.created_at) AS at'),
    )) as unknown as Array<Record<string, unknown>>;

  for (const row of rows) {
    const id = num(row.id);
    out.set(id, {
      id,
      number: String(row.number ?? ''),
      subject: String(row.subject ?? ''),
      queueSlug:
        row.queue_slug === null || row.queue_slug === undefined ? null : String(row.queue_slug),
      reopenCount: num(row.reopen_count),
      at: toIso(row.at),
      primaryCiId:
        row.primary_ci_id === null || row.primary_ci_id === undefined
          ? null
          : num(row.primary_ci_id),
    });
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — The three anchor signals
// ═════════════════════════════════════════════════════════════════════════════

/**
 * S1 — the same configuration item keeps breaking.
 *
 * Grouped in memory over the already-bounded window read rather than in SQL,
 * because the same rows also feed `reopen_pressure` and the seed subject: one
 * scan, three uses, and no second trip for a `GROUP BY` that would return at
 * most a few dozen rows anyway.
 */
function buildCiAnchors(
  window: readonly TicketFacts[],
  ciByTicket: ReadonlyMap<number, number[]>,
  spec: ProblemSignalSpec,
): AnchorDraft[] {
  if (!spec.enabled) return [];

  const byCi = new Map<number, TicketFacts[]>();
  for (const ticket of window) {
    const ciIds = new Set<number>();
    if (ticket.primaryCiId !== null) ciIds.add(ticket.primaryCiId);
    for (const ciId of ciByTicket.get(ticket.id) ?? []) ciIds.add(ciId);

    for (const ciId of ciIds) {
      const bucket = byCi.get(ciId);
      if (bucket) bucket.push(ticket);
      else byCi.set(ciId, [ticket]);
    }
  }

  const anchors: AnchorDraft[] = [];
  for (const [ciId, tickets] of byCi) {
    if (tickets.length < spec.threshold) continue;
    // `window` is already sorted newest first, so the head is the most recent
    // incident and its subject is the one an agent will recognise.
    const retained = tickets.slice(0, MAX_TICKETS_PER_ANCHOR);
    const head = retained[0];

    const draft: AnchorDraft = {
      signature: ciCandidateSignature(ciId),
      family: 'ci',
      anchorSignal: 'ci_repetition',
      title: head?.subject ?? '',
      ciId,
      dedupeKey: null,
      queueSlug: null,
      tickets: new Map(retained.map((ticket) => [ticket.id, 'ci_repetition' as const])),
      signals: {
        ci_repetition: reading(tickets.length, spec, retained.map((t) => t.id), {
          ciId,
          distinctQueues: new Set(retained.map((t) => t.queueSlug ?? '')).size,
        }),
      },
      seedTicketId: head?.id ?? null,
      seedSubject: head?.subject ?? null,
    };
    anchors.push(draft);
  }

  return anchors
    .sort((a, b) => saturationOf(b, 'ci_repetition') - saturationOf(a, 'ci_repetition'))
    .slice(0, MAX_ANCHORS_PER_FAMILY);
}

/**
 * S2 — a dedupe key that clears and comes right back.
 *
 * The textbook problem, and the one a desk is structurally blind to: every
 * cycle is a CLOSED incident, so nothing on any board is red and nobody sees
 * the pattern. Counted straight down `suite_alerts_dedupe_history` (migration
 * 006), which exists precisely because `suite_alerts_live` and
 * `suite_alerts_dedupe_live` are partial on `cleared_at IS NULL` and therefore
 * blind to exactly the rows this signal is made of.
 *
 * `secondary` is the second door: a key that never cleared but reached a very
 * high `occurrence_count` is flapping too. Saturation takes the better of the
 * two readings, and `detail` carries both so the card can say which one fired.
 */
async function buildAlertAnchors(
  tenantId: number,
  from: Date,
  to: Date,
  spec: ProblemSignalSpec,
  executor: Executor,
): Promise<AnchorDraft[]> {
  if (!spec.enabled) return [];

  const rows = (await scoped('suite_alerts', tenantId, executor)
    .where('suite_alerts.last_seen_at', '>=', from)
    .where('suite_alerts.last_seen_at', '<=', to)
    .groupBy('suite_alerts.source_app', 'suite_alerts.dedupe_key')
    .havingRaw('count(*) FILTER (WHERE suite_alerts.cleared_at IS NOT NULL) >= 1')
    .orderByRaw('count(*) FILTER (WHERE suite_alerts.cleared_at IS NOT NULL) DESC')
    .limit(MAX_ANCHORS_PER_FAMILY)
    .select(
      'suite_alerts.source_app',
      'suite_alerts.dedupe_key',
      executor.raw(
        'count(*) FILTER (WHERE suite_alerts.cleared_at IS NOT NULL)::int AS cleared_cycles',
      ),
      executor.raw('max(suite_alerts.occurrence_count)::int AS peak_occurrences'),
      executor.raw('max(suite_alerts.ci_id)::int AS ci_id'),
      executor.raw(
        `(array_remove(array_agg(DISTINCT suite_alerts.ticket_id), NULL))[1:${MAX_TICKETS_PER_ANCHOR}] AS ticket_ids`,
      ),
      executor.raw(
        '(array_agg(suite_alerts.title ORDER BY suite_alerts.last_seen_at DESC))[1] AS title',
      ),
    )) as unknown as Array<Record<string, unknown>>;

  const anchors: AnchorDraft[] = [];
  for (const row of rows) {
    const cycles = num(row.cleared_cycles);
    const peak = num(row.peak_occurrences);
    const secondary = spec.secondary ?? 0;

    const cycleSaturation = signalSaturation(cycles, spec.threshold);
    const occurrenceSaturation = secondary > 0 ? signalSaturation(peak, secondary) : 0;
    const saturation = Math.max(cycleSaturation, occurrenceSaturation);
    if (saturation <= 0) continue;

    const sourceApp = String(row.source_app ?? '');
    const dedupeKey = String(row.dedupe_key ?? '');
    if (sourceApp === '' || dedupeKey.trim() === '') continue;

    const ticketIds = intArray(row.ticket_ids).slice(0, MAX_TICKETS_PER_ANCHOR);

    anchors.push({
      signature: alertCandidateSignature(sourceApp, dedupeKey),
      family: 'alert',
      anchorSignal: 'alert_flapping',
      title: String(row.title ?? dedupeKey),
      ciId: row.ci_id === null || row.ci_id === undefined ? null : num(row.ci_id),
      dedupeKey,
      queueSlug: null,
      tickets: new Map(ticketIds.map((id) => [id, 'alert_flapping' as const])),
      signals: {
        alert_flapping: {
          observed: cycles,
          threshold: spec.threshold,
          weight: spec.weight,
          saturation,
          ticketIds,
          detail: {
            sourceApp,
            dedupeKey,
            clearedCycles: cycles,
            peakOccurrences: peak,
            occurrenceThreshold: secondary,
            cycleSaturation,
            occurrenceSaturation,
          },
        },
      },
      seedTicketId: ticketIds[0] ?? null,
      seedSubject: null,
    });
  }
  return anchors;
}

/**
 * S3 — new incidents landing on an already PUBLISHED known error.
 *
 * The most valuable of the six and the least obvious: the workaround no longer
 * suffices. That is a candidate for a NEW problem (the permanent fix), not a
 * duplicate of the old one, which is why the signature is keyed on the known
 * error's ticket rather than on its CI.
 *
 * Only incidents that arrived AFTER publication count. Counting the ones that
 * motivated the publication would make every known error a known-error miss on
 * the day it was published.
 */
async function buildKnownErrorMissAnchors(
  tenantId: number,
  from: Date,
  to: Date,
  spec: ProblemSignalSpec,
  executor: Executor,
): Promise<AnchorDraft[]> {
  if (!spec.enabled) return [];

  const rows = (await scoped('ticket_link', tenantId, executor)
    .where('ticket_link.kind', PROBLEM_LINK_KIND)
    // Joined tenant tables carry their own predicate — HARD RULE 1 does not
    // stop at the query root.
    .join('problems', 'problems.ticket_id', 'ticket_link.to_ticket_id')
    .where('problems.tenant_id', tenantId)
    .where('problems.known_error_state', 'published')
    .whereNotNull('problems.known_error_published_at')
    .join({ inc: 'tickets' }, 'inc.id', 'ticket_link.from_ticket_id')
    .where('inc.tenant_id', tenantId)
    .whereNull('inc.deleted_at')
    .whereIn('inc.record_type', INCIDENT_RECORD_TYPES)
    .whereRaw('coalesce(inc.occurred_at, inc.created_at) >= ?', [from])
    .whereRaw('coalesce(inc.occurred_at, inc.created_at) <= ?', [to])
    .whereRaw('coalesce(inc.occurred_at, inc.created_at) >= problems.known_error_published_at')
    .groupBy('problems.ticket_id')
    .havingRaw('count(DISTINCT inc.id) >= ?', [spec.threshold])
    .orderByRaw('count(DISTINCT inc.id) DESC')
    .limit(MAX_ANCHORS_PER_FAMILY)
    .select(
      'problems.ticket_id as problem_ticket_id',
      executor.raw('count(DISTINCT inc.id)::int AS misses'),
      executor.raw(
        `(array_agg(DISTINCT inc.id))[1:${MAX_TICKETS_PER_ANCHOR}] AS ticket_ids`,
      ),
      executor.raw(
        '(array_agg(inc.subject ORDER BY coalesce(inc.occurred_at, inc.created_at) DESC))[1] AS title',
      ),
      executor.raw(
        '(array_agg(inc.id ORDER BY coalesce(inc.occurred_at, inc.created_at) DESC))[1]::int AS seed_ticket_id',
      ),
    )) as unknown as Array<Record<string, unknown>>;

  const anchors: AnchorDraft[] = [];
  for (const row of rows) {
    const problemTicketId = num(row.problem_ticket_id);
    if (problemTicketId <= 0) continue;
    const misses = num(row.misses);
    const ticketIds = intArray(row.ticket_ids).slice(0, MAX_TICKETS_PER_ANCHOR);

    anchors.push({
      signature: knownErrorMissCandidateSignature(problemTicketId),
      family: 'known_error_miss',
      anchorSignal: 'known_error_miss',
      title: String(row.title ?? ''),
      ciId: null,
      dedupeKey: null,
      queueSlug: null,
      tickets: new Map(ticketIds.map((id) => [id, 'known_error_miss' as const])),
      signals: {
        known_error_miss: reading(misses, spec, ticketIds, { knownErrorTicketId: problemTicketId }),
      },
      seedTicketId: num(row.seed_ticket_id) || (ticketIds[0] ?? null),
      seedSubject: null,
    });
  }
  return anchors;
}

/** One reading, from an observation and the spec in force for this pass. */
function reading(
  observed: number,
  spec: ProblemSignalSpec,
  ticketIds: readonly number[],
  detail?: Record<string, unknown>,
): ProblemSignalReading {
  const value: ProblemSignalReading = {
    observed,
    threshold: spec.threshold,
    weight: spec.weight,
    saturation: signalSaturation(observed, spec.threshold),
  };
  if (ticketIds.length > 0) value.ticketIds = [...ticketIds];
  if (detail) value.detail = detail;
  return value;
}

function saturationOf(anchor: AnchorDraft, signal: ProblemDetectionSignal): number {
  return anchor.signals[signal]?.saturation ?? 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — The three corroborating signals
// ═════════════════════════════════════════════════════════════════════════════

/**
 * S4 — the anchor's incidents keep being reopened.
 *
 * Computed from facts already in hand, so it costs nothing: no query, no join.
 * An incident counts as reopened at `reopen_count >= 2` — "a ticket reopened
 * twice was never fixed" — and `spec.threshold` is how many such incidents the
 * anchor needs before the signal is worth anything.
 *
 * This is also the signal the closure cascade feeds back into: an incident the
 * cascade resolved and a requester reopened raises `reopen_count`, so a
 * cascade that was wrong makes the NEXT candidate stronger rather than
 * disappearing quietly.
 */
function enrichReopenPressure(
  anchor: AnchorDraft,
  facts: ReadonlyMap<number, TicketFacts>,
  spec: ProblemSignalSpec,
): void {
  if (!spec.enabled) return;

  const reopened: number[] = [];
  for (const ticketId of anchor.tickets.keys()) {
    const fact = facts.get(ticketId);
    if (fact && fact.reopenCount >= 2) reopened.push(ticketId);
  }
  if (reopened.length === 0) return;

  anchor.signals.reopen_pressure = reading(reopened.length, spec, reopened, {
    minReopenCount: 2,
  });
}

/**
 * S5 — the anchor's incidents are all described the same way.
 *
 * ONE indexed probe per anchor, seeded by the anchor's most recent incident:
 * `tickets.subject % seed` uses `tickets_subject_trgm` (the `%` operator is the
 * only form that does — `similarity(...) > x` cannot use the GIN index, which
 * is the rule `search.service.ts` states and this module obeys rather than
 * re-deriving). `spec.secondary` is the minimum similarity, tightening pg_trgm's
 * own threshold, and the query carries its own `LIMIT`.
 *
 * Deliberately NOT a nightly clustering pass over every subject: O(n²) over
 * 50 000 subjects is the number one technical reason these features get
 * switched off, and a cluster nobody anchors is a cluster nobody can act on.
 */
async function enrichSubjectCluster(
  tenantId: number,
  anchor: AnchorDraft,
  from: Date,
  to: Date,
  spec: ProblemSignalSpec,
  executor: Executor,
): Promise<void> {
  if (!spec.enabled) return;
  const seed = anchor.seedSubject;
  // pg_trgm on a two-character subject is noise, not similarity.
  if (!seed || seed.trim().length < 3) return;

  const minSimilarity = clamp(spec.secondary ?? 0.45, 0, 1);

  const rows = (await scoped('tickets', tenantId, executor)
    .whereNull('tickets.deleted_at')
    .whereIn('tickets.record_type', INCIDENT_RECORD_TYPES)
    .whereRaw('coalesce(tickets.occurred_at, tickets.created_at) >= ?', [from])
    .whereRaw('coalesce(tickets.occurred_at, tickets.created_at) <= ?', [to])
    .whereRaw('tickets.subject % ?', [seed])
    .whereRaw('similarity(tickets.subject, ?) >= ?', [seed, minSimilarity])
    .orderByRaw('similarity(tickets.subject, ?) DESC', [seed])
    .limit(MAX_CLUSTER_SCAN)
    .select(
      'tickets.id',
      executor.raw('similarity(tickets.subject, ?) AS sim', [seed]),
    )) as unknown as Array<Record<string, unknown>>;

  if (rows.length === 0) return;

  const matched: number[] = [];
  let best = 0;
  for (const row of rows) {
    const id = num(row.id);
    if (id > 0) matched.push(id);
    best = Math.max(best, num(row.sim));
  }

  anchor.signals.subject_cluster = reading(matched.length, spec, matched.slice(0, MAX_TICKETS_PER_ANCHOR), {
    seedTicketId: anchor.seedTicketId,
    minSimilarity,
    bestSimilarity: best,
    truncated: rows.length >= MAX_CLUSTER_SCAN,
  });

  // A clustered ticket joins the candidate's evidence, but never displaces the
  // exact signal that retained it: the board must be able to say "this one is
  // here because of the CI, that one because it reads the same".
  for (const id of matched) {
    if (anchor.tickets.size >= MAX_TICKETS_PER_ANCHOR) break;
    if (!anchor.tickets.has(id)) anchor.tickets.set(id, 'subject_cluster');
  }
}

/**
 * S6 — the anchor's queue is above its own baseline.
 *
 * Free: `metric_daily_rollup` already maintains `created` per `queue_slug` per
 * day, so this is one grouped read over `metric_daily_rollup_series` for the
 * handful of queues the anchors actually sit in. Nothing is recomputed from
 * `tickets`.
 *
 * `observed` here is a z-score, not a count: how many standard deviations the
 * window's worst day sits above the pre-window mean. `signalSaturation` is
 * monotone and bounded either way, and `detail` carries the raw numbers so the
 * card can show the arithmetic instead of a bare "spike".
 *
 * The baseline is the `QUEUE_BASELINE_DAYS` BEFORE the window, so the spike is
 * not compared against itself. A window wider than the baseline leaves nothing
 * to compare against and the signal simply stays silent.
 */
async function enrichQueueSpike(
  tenantId: number,
  anchors: readonly AnchorDraft[],
  from: Date,
  spec: ProblemSignalSpec,
  executor: Executor,
): Promise<void> {
  if (!spec.enabled) return;

  const queues = [
    ...new Set(anchors.map((a) => a.queueSlug).filter((slug): slug is string => !!slug)),
  ];
  if (queues.length === 0) return;

  const baselineStart = new Date(from.getTime() - QUEUE_BASELINE_DAYS * 86_400_000);

  const rows = (await scoped('metric_daily_rollup', tenantId, executor)
    .where('metric_daily_rollup.metric_key', 'created')
    .where('metric_daily_rollup.day', '>=', baselineStart)
    .whereRaw("metric_daily_rollup.dimensions->>'queue_slug' = ANY(?)", [queues])
    .groupByRaw("metric_daily_rollup.dimensions->>'queue_slug'")
    .select(
      executor.raw("metric_daily_rollup.dimensions->>'queue_slug' AS queue_slug"),
      executor.raw('avg(value) FILTER (WHERE "day" < ?) AS baseline_mean', [from]),
      executor.raw('stddev_samp(value) FILTER (WHERE "day" < ?) AS baseline_sigma', [from]),
      executor.raw('count(*) FILTER (WHERE "day" < ?)::int AS baseline_days', [from]),
      executor.raw('max(value) FILTER (WHERE "day" >= ?) AS window_peak', [from]),
    )) as unknown as Array<Record<string, unknown>>;

  const byQueue = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const slug = row.queue_slug === null || row.queue_slug === undefined ? '' : String(row.queue_slug);
    if (slug !== '') byQueue.set(slug, row);
  }

  for (const anchor of anchors) {
    if (!anchor.queueSlug) continue;
    const row = byQueue.get(anchor.queueSlug);
    if (!row) continue;

    const baselineDays = num(row.baseline_days);
    const mean = num(row.baseline_mean);
    const sigma = num(row.baseline_sigma);
    const peak = num(row.window_peak);

    // Fewer than a week of history is not a baseline, it is an anecdote, and a
    // zero sigma means the queue has never varied — dividing by it would turn
    // one extra ticket into an infinite spike.
    if (baselineDays < 7 || sigma <= 0 || peak <= mean) continue;

    const zScore = (peak - mean) / sigma;
    anchor.signals.queue_spike = reading(zScore, spec, [], {
      queueSlug: anchor.queueSlug,
      baselineMean: mean,
      baselineSigma: sigma,
      baselineDays,
      windowPeak: peak,
      sigmasAboveMean: zScore,
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Absorption: what an already-open problem swallows
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The second absorption layer.
 *
 * Layer one is the window read, which drops any incident already linked
 * `caused_by`. It is not enough on its own: a problem opened five minutes ago
 * has its CI but not yet all of its incidents, and those unlinked incidents
 * would raise a candidate sitting right beside the problem they belong to.
 *
 * So a CI on which a NON-TERMINAL problem is already open is removed from the
 * pass entirely. A CI whose problems are all resolved is not: incidents landing
 * on a CI six weeks after its problem was closed are a new problem, and that is
 * precisely the case a detector exists to catch.
 */
async function ciIdsWithOpenProblem(
  tenantId: number,
  ciIds: readonly number[],
  executor: Executor,
): Promise<Set<number>> {
  const out = new Set<number>();
  if (ciIds.length === 0) return out;
  const ids = [...ciIds];

  const direct = (await scopedAs('tickets', 'pt', tenantId, executor)
    .where('pt.record_type', 'problem')
    .whereNull('pt.deleted_at')
    .whereIn('pt.status_category', LIVE_CATEGORIES)
    .whereIn('pt.primary_ci_id', ids)
    .select('pt.primary_ci_id as ci_id')) as unknown as Array<Record<string, unknown>>;
  for (const row of direct) out.add(num(row.ci_id));

  const linked = (await scoped('ticket_cis', tenantId, executor)
    .whereIn('ticket_cis.ci_id', ids)
    .join({ pt: 'tickets' }, 'pt.id', 'ticket_cis.ticket_id')
    .where('pt.tenant_id', tenantId)
    .where('pt.record_type', 'problem')
    .whereNull('pt.deleted_at')
    .whereIn('pt.status_category', LIVE_CATEGORIES)
    .select('ticket_cis.ci_id')) as unknown as Array<Record<string, unknown>>;
  for (const row of linked) out.add(num(row.ci_id));

  out.delete(0);
  return out;
}

/**
 * The same absorption for the alert family, through the CURATED bond.
 *
 * `problem_alert_signatures` is what an engineer declared equivalent to a known
 * error; `suite_alerts.ticket_id` only says which ticket one alert opened. A
 * flapping key already bound to a live problem is that problem's signal, not a
 * new candidate.
 */
async function dedupeKeysWithOpenProblem(
  tenantId: number,
  pairs: ReadonlyArray<{ sourceApp: string; dedupeKey: string }>,
  executor: Executor,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (pairs.length === 0) return out;

  const rows = (await scoped('problem_alert_signatures', tenantId, executor)
    .join({ pt: 'tickets' }, 'pt.id', 'problem_alert_signatures.problem_ticket_id')
    .where('pt.tenant_id', tenantId)
    .whereNull('pt.deleted_at')
    .whereIn('pt.status_category', LIVE_CATEGORIES)
    .where((qb) => {
      for (const pair of pairs) {
        void qb.orWhere((inner) => {
          void inner
            .where('problem_alert_signatures.source_app', pair.sourceApp)
            .where('problem_alert_signatures.dedupe_key', pair.dedupeKey);
        });
      }
    })
    .select(
      'problem_alert_signatures.source_app',
      'problem_alert_signatures.dedupe_key',
    )) as unknown as Array<Record<string, unknown>>;

  for (const row of rows) {
    out.add(alertCandidateSignature(String(row.source_app ?? ''), String(row.dedupe_key ?? '')));
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — One pass
// ═════════════════════════════════════════════════════════════════════════════

export interface DetectionRunOptions {
  now?: Date;
  detectorSlug?: string;
  /** Score and decide, write nothing, log nothing. The "what would you propose?" button. */
  dryRun?: boolean;
}

function emptyOutcome(startedAt: number): ProblemDetectionRunOutcome {
  return {
    evaluated: 0,
    proposed: 0,
    bumped: 0,
    withheld: 0,
    suppressed: 0,
    escalated: 0,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * A single detection pass for one tenant.
 *
 * The whole engine in reading order: load the config, read the window once,
 * build anchors from the three exact signals, cap them, enrich them, score them
 * with the SHARED scorer (so the number on the card is the number the server
 * computed, to the digit), then decide what to do with each qualifying
 * signature.
 */
export async function runForTenant(
  tenantId: number,
  options: DetectionRunOptions = {},
): Promise<ProblemDetectionRunOutcome> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;

  const detector = await loadDetector(tenantId, options.detectorSlug, db);
  if (!detector) return emptyOutcome(startedAt);
  const { body } = detector;
  if (!body.enabled) return emptyOutcome(startedAt);

  const to = now;
  const from = new Date(now.getTime() - body.windowDays * 86_400_000);
  const windowStart = from.toISOString();
  const windowEnd = to.toISOString();

  // ── 1. One bounded window read, three uses ────────────────────────────────
  const window = await readWindowTickets(tenantId, from, to, db);
  const ciByTicket = await readTicketCis(
    tenantId,
    window.map((t) => t.id),
    db,
  );

  // ── 2. Anchors, from the three EXACT signals only ─────────────────────────
  const ciAnchors = buildCiAnchors(window, ciByTicket, body.signals.ci_repetition);
  const alertAnchors = await buildAlertAnchors(
    tenantId,
    from,
    to,
    body.signals.alert_flapping,
    db,
  );
  const missAnchors = await buildKnownErrorMissAnchors(
    tenantId,
    from,
    to,
    body.signals.known_error_miss,
    db,
  );

  // ── 3. Absorption, before anything is enriched or scored ──────────────────
  const occupiedCis = await ciIdsWithOpenProblem(
    tenantId,
    ciAnchors.map((a) => a.ciId).filter((id): id is number => id !== null),
    db,
  );
  const occupiedKeys = await dedupeKeysWithOpenProblem(
    tenantId,
    alertAnchors
      .filter((a) => a.dedupeKey !== null)
      .map((a) => ({
        sourceApp: String(a.signals.alert_flapping?.detail?.sourceApp ?? ''),
        dedupeKey: a.dedupeKey as string,
      })),
    db,
  );

  let anchors = [
    ...ciAnchors.filter((a) => a.ciId === null || !occupiedCis.has(a.ciId)),
    ...alertAnchors.filter((a) => !occupiedKeys.has(a.signature)),
    ...missAnchors,
  ];

  // Strongest exact evidence first, then capped: every query after this line is
  // per-anchor, so this is where the pass stops being able to grow.
  anchors = anchors
    .sort((a, b) => saturationOf(b, b.anchorSignal) - saturationOf(a, a.anchorSignal))
    .slice(0, MAX_ANCHORS_PER_PASS);

  if (anchors.length === 0) return emptyOutcome(startedAt);

  // ── 4. Hydrate every retained incident, once ──────────────────────────────
  const allTicketIds = new Set<number>();
  for (const anchor of anchors) for (const id of anchor.tickets.keys()) allTicketIds.add(id);
  const facts = await readTicketFacts(tenantId, [...allTicketIds], db);

  for (const anchor of anchors) {
    // Drop retained ids that no longer resolve to a live incident (deleted, or
    // an alert that opened a change rather than an incident).
    for (const id of [...anchor.tickets.keys()]) {
      if (!facts.has(id)) anchor.tickets.delete(id);
    }
    anchor.queueSlug = modalQueue(anchor, facts);
    if (anchor.seedSubject === null) {
      const seed = anchor.seedTicketId !== null ? facts.get(anchor.seedTicketId) : undefined;
      const fallback = newestFact(anchor, facts);
      anchor.seedSubject = seed?.subject ?? fallback?.subject ?? null;
      if (anchor.seedTicketId === null) anchor.seedTicketId = fallback?.id ?? null;
    }
    if (anchor.title.trim() === '') {
      anchor.title = newestFact(anchor, facts)?.subject ?? anchor.signature;
    }
  }

  anchors = anchors.filter((anchor) => anchor.tickets.size > 0);

  // ── 5. Enrichment: three corroborating signals ────────────────────────────
  for (const anchor of anchors) {
    enrichReopenPressure(anchor, facts, body.signals.reopen_pressure);
    await enrichSubjectCluster(
      tenantId,
      anchor,
      from,
      to,
      body.signals.subject_cluster,
      db,
    );
  }
  await enrichQueueSpike(tenantId, anchors, from, body.signals.queue_spike, db);

  // ── 6. Score with the SHARED scorer ───────────────────────────────────────
  const scored = anchors
    .map((anchor) => ({ anchor, score: scoreProblemCandidate({ signals: anchor.signals, body }) }))
    .sort((a, b) => b.score.score - a.score.score);

  const outcome: ProblemDetectionRunOutcome = {
    evaluated: scored.length,
    proposed: 0,
    bumped: 0,
    withheld: 0,
    suppressed: 0,
    escalated: 0,
    durationMs: 0,
  };

  // ── 7. Decide, one signature at a time ────────────────────────────────────
  let created = 0;
  for (const { anchor, score } of scored) {
    if (!score.qualifies) continue;

    // Write the per-ticket contribution the card will render, from the same
    // numbers the score was built out of.
    const contributions = new Map<number, number>();
    for (const [ticketId, signal] of anchor.tickets) {
      contributions.set(ticketId, scale4(score.contributions[signal] ?? 0));
    }

    const live = await findLiveCandidate(tenantId, anchor.signature, db);
    if (live) {
      // A re-detection BUMPS. It never inserts a second card (the partial
      // unique index would refuse it anyway) and it writes no decision row:
      // see the volumetric ruling in the module header.
      if (!dryRun) {
        await bumpCandidate(tenantId, live.id, anchor, score.score, contributions, {
          windowStart,
          windowEnd,
          now,
        });
      }
      outcome.bumped += 1;
      continue;
    }

    const headstone = await findHeadstone(tenantId, anchor.signature, db);
    const verdict = evaluateCandidateSuppression({
      headstone,
      newScore: score.score,
      newIncidentCount: anchor.tickets.size,
      escalationFactor: body.rejection.escalationFactor,
      now: now.toISOString(),
    });

    if (verdict.action === 'suppress') {
      outcome.suppressed += 1;
      if (!dryRun) {
        await noteSuppression(tenantId, detector, anchor, headstone, score.score, verdict.suppressedUntil, now);
      }
      continue;
    }

    if (created >= body.maxNewCandidatesPerRun) {
      // Qualified, but this pass has already produced its quota. Not created,
      // not lost: the next pass reconsiders it, and the census names it.
      outcome.withheld += 1;
      continue;
    }

    if (!dryRun) {
      await proposeCandidate(tenantId, detector, anchor, score.score, contributions, {
        windowStart,
        windowEnd,
        now,
        supersedes: verdict.action === 'escalate' ? verdict.supersedes : null,
        escalationReason: verdict.action === 'escalate' ? verdict.reason : null,
        escalationFactor: body.rejection.escalationFactor,
        headstoneScore: headstone?.score ?? null,
      });
    }
    created += 1;
    outcome.proposed += 1;
    if (verdict.action === 'escalate') outcome.escalated += 1;
  }

  outcome.durationMs = Date.now() - startedAt;

  // ── 8. The census row (HARD RULE 2), only when the pass DID something ─────
  //
  // A bump alone is not a decision (it re-affirms one), so a pass that only
  // bumped is silent. A pass that proposed, escalated, suppressed or withheld
  // writes exactly one row naming the window, the enabled signals and the
  // totals — which is what makes "did the detector earn its keep?" answerable
  // without reading every card.
  const changed =
    outcome.proposed + outcome.suppressed + outcome.escalated + outcome.withheld > 0;
  if (changed && !dryRun) {
    await withDecision(
      {
        tenantId,
        ticketId: null,
        subsystem: 'problem',
        decision: PROBLEM_DECISIONS.detectionRun,
        ruleSlug: detector.slug,
        ruleVersion: detector.version,
        actorType: 'system',
        inputs: {
          windowDays: body.windowDays,
          windowStart,
          windowEnd,
          scoreThreshold: body.scoreThreshold,
          requireExactSignal: body.requireExactSignal,
          enabledSignals: PROBLEM_DETECTION_SIGNALS.filter((s) => body.signals[s].enabled),
          detectorBuiltin: detector.builtin,
        },
      },
      (recorder) => {
        recorder.outcome({ ...outcome });
      },
    );
  }

  return outcome;
}

function newestFact(
  anchor: AnchorDraft,
  facts: ReadonlyMap<number, TicketFacts>,
): TicketFacts | null {
  let best: TicketFacts | null = null;
  for (const id of anchor.tickets.keys()) {
    const fact = facts.get(id);
    if (!fact) continue;
    if (!best || fact.at > best.at) best = fact;
  }
  return best;
}

/** The queue most of the anchor's incidents landed in. Ties go to the newest. */
function modalQueue(
  anchor: AnchorDraft,
  facts: ReadonlyMap<number, TicketFacts>,
): string | null {
  const counts = new Map<string, number>();
  for (const id of anchor.tickets.keys()) {
    const slug = facts.get(id)?.queueSlug;
    if (!slug) continue;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [slug, count] of counts) {
    if (count > bestCount) {
      best = slug;
      bestCount = count;
    }
  }
  return best ?? newestFact(anchor, facts)?.queueSlug ?? null;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Writing a candidate
// ═════════════════════════════════════════════════════════════════════════════

async function findLiveCandidate(
  tenantId: number,
  signature: string,
  executor: Executor,
): Promise<ProblemCandidate | null> {
  const row = (await scoped('problem_candidates', tenantId, executor)
    .where('problem_candidates.signature', signature)
    .whereIn('problem_candidates.state', ['proposed', 'accepted'])
    .first(CANDIDATE_COLUMNS)) as CandidateRow | undefined;
  return row ? mapCandidate(row) : null;
}

/**
 * The headstone: the most recently decided card for this signature that still
 * carries a suppression. Never deleted, which is the whole point — it is the
 * memory of a human "no", and `evaluateCandidateSuppression` is the only door
 * out of it.
 */
async function findHeadstone(
  tenantId: number,
  signature: string,
  executor: Executor,
): Promise<ProblemCandidate | null> {
  const row = (await scoped('problem_candidates', tenantId, executor)
    .where('problem_candidates.signature', signature)
    .whereNotNull('problem_candidates.suppressed_until')
    .orderBy('problem_candidates.suppressed_until', 'desc')
    .first(CANDIDATE_COLUMNS)) as CandidateRow | undefined;
  return row ? mapCandidate(row) : null;
}

interface WindowBounds {
  windowStart: string;
  windowEnd: string;
  now: Date;
}

function signalsJson(anchor: AnchorDraft): string {
  return JSON.stringify(anchor.signals);
}

async function writeCandidateTickets(
  tenantId: number,
  candidateId: number,
  anchor: AnchorDraft,
  contributions: ReadonlyMap<number, number>,
  trx: Knex.Transaction,
): Promise<void> {
  const rows = [...anchor.tickets.entries()].map(([ticketId, signal]) => ({
    candidate_id: candidateId,
    ticket_id: ticketId,
    signal,
    contribution: contributions.get(ticketId) ?? null,
  }));
  if (rows.length === 0) return;

  await insertScoped('problem_candidate_tickets', tenantId, rows, trx)
    .onConflict(['candidate_id', 'ticket_id'])
    .merge(['signal', 'contribution']);
}

/**
 * A re-detection: same conclusion, fresher evidence.
 *
 * `proposed_at` is NEVER touched — "how long has this been sitting unread?" is
 * the one number that shames a review board into working, and refreshing it
 * every hour would make every card look new for ever.
 */
async function bumpCandidate(
  tenantId: number,
  candidateId: number,
  anchor: AnchorDraft,
  score: number,
  contributions: ReadonlyMap<number, number>,
  bounds: WindowBounds,
): Promise<void> {
  await db.transaction(async (trx) => {
    await scoped('problem_candidates', tenantId, trx)
      .where('problem_candidates.id', candidateId)
      .where('problem_candidates.state', 'proposed')
      .update({
        score: scale4(score),
        signals: signalsJson(anchor),
        incident_count: anchor.tickets.size,
        window_start: bounds.windowStart,
        window_end: bounds.windowEnd,
        occurrence_count: trx.raw('occurrence_count + 1'),
        last_seen_at: bounds.now,
        title: truncate(anchor.title, 512),
        ci_id: anchor.ciId,
        dedupe_key: anchor.dedupeKey,
        queue_slug: anchor.queueSlug,
      });

    await writeCandidateTickets(tenantId, candidateId, anchor, contributions, trx);
  });
}

interface ProposeContext extends WindowBounds {
  supersedes: number | null;
  escalationReason: 'score' | 'incidents' | null;
  escalationFactor: number;
  headstoneScore: number | null;
}

/**
 * Create the card, its incident links and its `decision_log` row in ONE
 * transaction (HARD RULE 2): a card that exists without the row explaining it
 * is a card nobody can argue with.
 */
async function proposeCandidate(
  tenantId: number,
  detector: LoadedDetector,
  anchor: AnchorDraft,
  score: number,
  contributions: ReadonlyMap<number, number>,
  ctx: ProposeContext,
): Promise<void> {
  const ticketIds = [...anchor.tickets.keys()];

  try {
    await db.transaction(async (trx) => {
      const inserted = (await insertScoped(
        'problem_candidates',
        tenantId,
        {
          signature: anchor.signature,
          state: 'proposed',
          score: scale4(score),
          signals: signalsJson(anchor),
          title: truncate(anchor.title, 512),
          ci_id: anchor.ciId,
          dedupe_key: anchor.dedupeKey,
          queue_slug: anchor.queueSlug,
          incident_count: anchor.tickets.size,
          window_start: ctx.windowStart,
          window_end: ctx.windowEnd,
          // HARD RULES 3 and 4 — which published object proposed this, by slug.
          detector_slug: truncate(detector.slug, 128),
          detector_version: detector.version,
          occurrence_count: 1,
          proposed_at: ctx.now,
          last_seen_at: ctx.now,
          superseded_candidate_id: ctx.supersedes,
        },
        trx,
      ).returning('*')) as unknown as CandidateRow[];

      const candidate = mapCandidate(inserted[0] as CandidateRow);
      await writeCandidateTickets(tenantId, candidate.id, anchor, contributions, trx);

      // The escalation row comes FIRST when there is one: it explains why a
      // signature a human refused is on the board again, which is the question
      // that gets asked before "what is this card?".
      if (ctx.supersedes !== null) {
        await withDecision(
          {
            tenantId,
            ticketId: null,
            subsystem: 'problem',
            decision: PROBLEM_DECISIONS.candidateEscalated,
            ruleSlug: detector.slug,
            ruleVersion: detector.version,
            actorType: 'system',
            trx,
            inputs: {
              signature: anchor.signature,
              rejectedScore: ctx.headstoneScore,
              newScore: scale4(score),
              escalationFactor: ctx.escalationFactor,
              reason: ctx.escalationReason,
              ticketIds,
            },
          },
          (recorder) => {
            recorder.outcome({
              newCandidateId: candidate.id,
              supersededCandidateId: ctx.supersedes,
            });
          },
        );
      }

      await withDecision(
        {
          tenantId,
          ticketId: null,
          subsystem: 'problem',
          decision: PROBLEM_DECISIONS.candidateProposed,
          ruleSlug: detector.slug,
          ruleVersion: detector.version,
          actorType: 'system',
          trx,
          inputs: {
            signature: anchor.signature,
            family: anchor.family,
            score: scale4(score),
            signals: anchor.signals as unknown as Record<string, unknown>,
            // The incidents that made the case, named on the row itself: the
            // `signals` map carries them per signal, this carries the union, and
            // a reader should not have to reduce one to get the other.
            ticketIds,
            windowStart: ctx.windowStart,
            windowEnd: ctx.windowEnd,
          },
        },
        (recorder) => {
          recorder.outcome({
            candidateId: candidate.id,
            incidentCount: candidate.incidentCount,
            title: candidate.title,
          });
        },
      );
    });
  } catch (error) {
    // `problem_candidates_live_uq` is the last word on "one live card per
    // signature". Losing that race means somebody else created the card we were
    // about to create, which is the outcome we wanted: log it and move on
    // rather than failing a whole pass over a duplicate we did not want.
    if ((error as { code?: string }).code === '23505') {
      logger.debug(
        { tenantId, signature: anchor.signature },
        'problem detection: a concurrent pass already created this card',
      );
      return;
    }
    throw error;
  }
}

/**
 * Record that a signature is still suppressed, at most once per
 * `SUPPRESSION_NOTICE_INTERVAL_MS`.
 *
 * ── How this resists "one more incident arrived after the rejection" ─────────
 * That is THE failure mode of every recurrence detector: a human rejects a
 * card, one more matching incident lands, the pass finds the signature again,
 * and the card comes straight back. The rejection then means nothing and the
 * board is ignored within a week.
 *
 * Three things stop it, and none of them is a heuristic:
 *
 *   1. The rejected row is NEVER deleted. It is the headstone, found by
 *      `findHeadstone()` on `problem_candidates_tomb` before anything is
 *      created, and it carries `suppressed_until` = the rejection instant plus
 *      the cooldown (90 days by default).
 *   2. Inside that window `evaluateCandidateSuppression()` — the SHARED
 *      function, so the UI can explain the same verdict — demands that the
 *      evidence has MATERIALLY worsened: `newScore >= rejectedScore × 1.5`, or
 *      `newIncidentCount >= 2 × incidentCountAtRejection`. One extra incident
 *      moves the count by one and the score by a fraction of a saturation step;
 *      it clears neither bar. Ten more do, and that is the point: the way out
 *      exists, it is numeric, and it is written down.
 *   3. The headstone's `score` and `incident_count` are NEVER overwritten by a
 *      later pass. They are the terms of the human's decision, and rewriting
 *      them would quietly lower the bar the escalation has to clear — the
 *      system would forget the "no" by degrees instead of all at once.
 *
 * Only `last_seen_at` moves, and only so this notice stays daily.
 */
async function noteSuppression(
  tenantId: number,
  detector: LoadedDetector,
  anchor: AnchorDraft,
  headstone: ProblemCandidate | null,
  score: number,
  suppressedUntil: string,
  now: Date,
): Promise<void> {
  if (!headstone) return;

  const lastSeen = Date.parse(headstone.lastSeenAt);
  const quiet =
    Number.isNaN(lastSeen) || now.getTime() - lastSeen >= SUPPRESSION_NOTICE_INTERVAL_MS;

  await db.transaction(async (trx) => {
    await scoped('problem_candidates', tenantId, trx)
      .where('problem_candidates.id', headstone.id)
      .update({ last_seen_at: now });

    if (!quiet) return;

    await withDecision(
      {
        tenantId,
        ticketId: null,
        subsystem: 'problem',
        decision: PROBLEM_DECISIONS.candidateSuppressed,
        ruleSlug: detector.slug,
        ruleVersion: detector.version,
        actorType: 'system',
        trx,
        inputs: {
          signature: anchor.signature,
          rejectedScore: headstone.score,
          newScore: scale4(score),
          rejectedIncidentCount: headstone.incidentCount,
          newIncidentCount: anchor.tickets.size,
          decisionNote: headstone.decisionNote,
          ticketIds: [...anchor.tickets.keys()],
        },
      },
      (recorder) => {
        recorder.outcome({
          reason: 'cooldown',
          suppressedUntil,
          headstoneCandidateId: headstone.id,
        });
      },
    );
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — The review board
// ═════════════════════════════════════════════════════════════════════════════

export interface CandidateListQuery {
  state?: ProblemCandidateState | ProblemCandidateState[];
  minScore?: number;
  page?: number;
  limit?: number;
}

async function readCandidateTickets(
  tenantId: number,
  candidateIds: readonly number[],
  executor: Executor,
): Promise<Map<number, ProblemCandidateTicket[]>> {
  const out = new Map<number, ProblemCandidateTicket[]>();
  if (candidateIds.length === 0) return out;

  const rows = (await scoped('problem_candidate_tickets', tenantId, executor)
    .whereIn('problem_candidate_tickets.candidate_id', [...candidateIds])
    .select(
      'problem_candidate_tickets.candidate_id',
      'problem_candidate_tickets.ticket_id',
      'problem_candidate_tickets.signal',
      'problem_candidate_tickets.contribution',
    )) as unknown as Array<Record<string, unknown>>;

  for (const row of rows) {
    const candidateId = num(row.candidate_id);
    const entry: ProblemCandidateTicket = {
      candidateId,
      ticketId: num(row.ticket_id),
      tenantId,
      signal: String(row.signal) as ProblemDetectionSignal,
      contribution: row.contribution === null ? null : num(row.contribution),
    };
    const bucket = out.get(candidateId);
    if (bucket) bucket.push(entry);
    else out.set(candidateId, [entry]);
  }
  return out;
}

/**
 * The review board. Defaults to `proposed`, best score first, straight down
 * `problem_candidates_board`.
 */
export async function listCandidates(
  tenantId: number,
  query: CandidateListQuery = {},
  executor: Executor = db,
): Promise<{ items: ProblemCandidateWithTickets[]; total: number }> {
  const states = query.state === undefined
    ? (['proposed'] as ProblemCandidateState[])
    : Array.isArray(query.state)
      ? query.state
      : [query.state];

  const page = Math.max(1, Math.floor(query.page ?? 1));
  const limit = Math.round(clamp(query.limit ?? 25, 1, 100));

  const base = (): Knex.QueryBuilder => {
    const qb = scoped('problem_candidates', tenantId, executor);
    if (states.length > 0) void qb.whereIn('problem_candidates.state', states);
    if (query.minScore !== undefined) {
      void qb.where('problem_candidates.score', '>=', clamp(query.minScore, 0, 1));
    }
    return qb;
  };

  const countRow = (await base().count<{ count: string }>({ count: '*' }).first()) as
    | { count: string }
    | undefined;
  const total = num(countRow?.count);

  const rows = (await base()
    .orderBy('problem_candidates.score', 'desc')
    .orderBy('problem_candidates.proposed_at', 'desc')
    .limit(limit)
    .offset((page - 1) * limit)
    .select(CANDIDATE_COLUMNS)) as unknown as CandidateRow[];

  const candidates = rows.map(mapCandidate);
  const tickets = await readCandidateTickets(
    tenantId,
    candidates.map((c) => c.id),
    executor,
  );

  return {
    items: candidates.map((candidate) => ({
      ...candidate,
      tickets: tickets.get(candidate.id) ?? [],
    })),
    total,
  };
}

/** One card, its contributing incidents, and the rejected card it escalates. */
export async function getCandidate(
  tenantId: number,
  candidateId: number,
  executor: Executor = db,
): Promise<ProblemCandidateWithTickets | null> {
  const row = (await scoped('problem_candidates', tenantId, executor)
    .where('problem_candidates.id', candidateId)
    .first(CANDIDATE_COLUMNS)) as CandidateRow | undefined;
  if (!row) return null;

  const candidate = mapCandidate(row);
  const tickets = await readCandidateTickets(tenantId, [candidate.id], executor);

  let supersedes: ProblemCandidate | null = null;
  if (candidate.supersededCandidateId !== null) {
    const parent = (await scoped('problem_candidates', tenantId, executor)
      .where('problem_candidates.id', candidate.supersededCandidateId)
      .first(CANDIDATE_COLUMNS)) as CandidateRow | undefined;
    supersedes = parent ? mapCandidate(parent) : null;
  }

  return { ...candidate, tickets: tickets.get(candidate.id) ?? [], supersedes };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — Accept / reject
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `problem.service` reached at CALL time, memoised, degrading to null.
 *
 * The same shape `ticket.service` uses for the escalation and approval engines,
 * for the same two reasons. First the dependency graph: accepting a card
 * creates a problem, and a problem's published known error feeds this module's
 * `known_error_miss` signal, so a static import would close a
 * module-initialisation cycle. Second the cost: this module is imported by
 * `index.ts` on every replica to arm the sweeper, and the sweep itself needs
 * nothing from the ticket engine — dragging the whole desk in behind it would
 * make a boot pay for a path that only runs when a human clicks "accept".
 *
 * The interface is declared structurally rather than as
 * `typeof import('./problem.service')` on purpose: it names EXACTLY what this
 * module calls, so the coupling is one paragraph long and visible.
 */
interface ProblemServiceLike {
  promote(
    tenantId: number,
    actor: ActorContext,
    input: PromoteIncidentRequest,
    trx?: Knex.Transaction,
  ): Promise<ProblemWithRelations>;
  get(
    tenantId: number,
    problemTicketId: number,
    executor?: Executor,
  ): Promise<ProblemWithRelations | null>;
}

let problemModule: ProblemServiceLike | null | undefined;

function problemService(): ProblemServiceLike {
  if (problemModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      problemModule = require('./problem.service') as ProblemServiceLike;
    } catch {
      problemModule = null;
    }
  }
  if (!problemModule) {
    // The require above only breaks the import cycle; the module ships with
    // every build. Failing it means this install is broken, not that an
    // operator turned something off, so do not dress it up as a capability.
    throw new AppError(503, 'Problem management failed to load', {
      code: 'internal_error',
    });
  }
  return problemModule;
}

/**
 * Accept a card: it becomes a problem.
 *
 * `occurredAt` is the EARLIEST of the contributing incidents (HARD RULE 6): the
 * condition started when the first incident happened, not when a reviewer got
 * round to the board, and Rewind reconstructs the environment as it stood then.
 * That is why the earliest incident is handed to `promote()` as the source and
 * the rest ride along in `alsoLinkIncidentIds` — one transaction, one set of
 * rollups, one decision trail.
 */
export async function acceptCandidate(
  tenantId: number,
  actor: ActorContext,
  candidateId: number,
  input: AcceptProblemCandidateRequest = {},
  trx?: Knex.Transaction,
): Promise<ProblemWithRelations> {
  const run = async (tx: Knex.Transaction): Promise<ProblemWithRelations> => {
    const row = (await scoped('problem_candidates', tenantId, tx)
      .where('problem_candidates.id', candidateId)
      .forUpdate()
      .first(CANDIDATE_COLUMNS)) as CandidateRow | undefined;
    if (!row) throw notFound('Candidate not found');

    const candidate = mapCandidate(row);
    if (candidate.state !== 'proposed') {
      throw conflict('This candidate has already been decided', {
        code: 'candidate_already_decided',
        state: candidate.state,
        problemTicketId: candidate.problemTicketId,
      });
    }

    // Ordered oldest first, and re-checked against the tickets table: a card
    // proposed a fortnight ago may name incidents that have since been deleted
    // or merged, and promoting onto one of those would create a problem whose
    // `occurred_at` came from a row nobody can open.
    const incidents = (await scoped('problem_candidate_tickets', tenantId, tx)
      .where('problem_candidate_tickets.candidate_id', candidateId)
      .join({ inc: 'tickets' }, 'inc.id', 'problem_candidate_tickets.ticket_id')
      .where('inc.tenant_id', tenantId)
      .whereNull('inc.deleted_at')
      .whereNull('inc.merged_into_id')
      .whereIn('inc.record_type', INCIDENT_RECORD_TYPES)
      .orderByRaw('coalesce(inc.occurred_at, inc.created_at) ASC')
      .select('inc.id', 'inc.subject')) as unknown as Array<Record<string, unknown>>;

    const incidentIds = incidents.map((entry) => num(entry.id)).filter((id) => id > 0);
    if (incidentIds.length === 0) {
      throw badRequest(
        'Every incident behind this candidate has been deleted or merged, so there is nothing to promote',
      );
    }

    const [sourceIncidentId, ...alsoLink] = incidentIds;

    const promoted = await problemService().promote(
      tenantId,
      actor,
      {
        incidentId: sourceIncidentId as number,
        subject: input.subject ?? truncate(candidate.title, 512),
        symptomsMd: input.symptomsMd ?? null,
        queueSlug: input.queueSlug ?? candidate.queueSlug,
        prioritySlug: input.prioritySlug ?? null,
        assigneeId: input.assigneeId ?? null,
        alsoLinkIncidentIds: alsoLink,
      },
      tx,
    );

    // `detected_by` and `candidate_id` are the detector's provenance and there
    // is no field for them on `PromoteIncidentRequest` — promotion is a human
    // act and its request has no business carrying a detector's id. They are
    // stamped here, in the SAME transaction as the creation, and `row_version`
    // is deliberately NOT bumped: nobody has read this row yet, so there is no
    // editor to reconcile with (HARD RULE 7 is about concurrent readers, not
    // about counting writes).
    await scoped('problems', tenantId, tx)
      .where('problems.ticket_id', promoted.ticketId)
      .update({ detected_by: 'recurrence', candidate_id: candidateId });

    await scoped('problem_candidates', tenantId, tx)
      .where('problem_candidates.id', candidateId)
      .update({
        state: 'accepted',
        decided_at: new Date(),
        decided_by: actor.userId ?? null,
        decision_note: input.note ? truncate(input.note, 512) : null,
        problem_ticket_id: promoted.ticketId,
      });

    await withDecision(
      {
        tenantId,
        // The row belongs on the NEW problem: this is the first thing its Why
        // drawer has to be able to say about where it came from.
        ticketId: promoted.ticketId,
        subsystem: 'problem',
        decision: PROBLEM_DECISIONS.candidateAccepted,
        ruleSlug: candidate.detectorSlug,
        ruleVersion: candidate.detectorVersion,
        actorId: actor.userId ?? null,
        actorType: actor.actorType,
        trx: tx,
        inputs: {
          candidateId,
          signature: candidate.signature,
          score: candidate.score,
          signals: candidate.signals as unknown as Record<string, unknown>,
          ticketIds: incidentIds,
        },
      },
      (recorder) => {
        recorder.outcome({
          problemTicketId: promoted.ticketId,
          linked: incidentIds.length,
          sourceIncidentId,
          detectedBy: 'recurrence',
        });
      },
    );

    const fresh = await problemService().get(tenantId, promoted.ticketId, tx);
    return fresh ?? promoted;
  };

  return trx ? run(trx) : db.transaction(run);
}

/**
 * Reject a card. The row is the headstone and is never deleted.
 *
 * The note is REQUIRED by the DTO for a reason that only shows up months later:
 * it is what the escalation banner shows when the same signature comes back
 * with worse evidence, and "somebody said no in March" is not an argument a
 * reviewer can weigh.
 */
export async function rejectCandidate(
  tenantId: number,
  actor: ActorContext,
  candidateId: number,
  input: RejectProblemCandidateRequest,
  trx?: Knex.Transaction,
): Promise<ProblemCandidate> {
  const run = async (tx: Knex.Transaction): Promise<ProblemCandidate> => {
    const row = (await scoped('problem_candidates', tenantId, tx)
      .where('problem_candidates.id', candidateId)
      .forUpdate()
      .first(CANDIDATE_COLUMNS)) as CandidateRow | undefined;
    if (!row) throw notFound('Candidate not found');

    const candidate = mapCandidate(row);
    if (candidate.state !== 'proposed') {
      throw conflict('This candidate has already been decided', {
        code: 'candidate_already_decided',
        state: candidate.state,
      });
    }

    const note = input.note?.trim() ?? '';
    if (note === '') {
      throw badRequest('Say why this is not a problem. The note is what the next proposal is judged against.');
    }

    // The tenant's own cooldown, then the shipped one. `LIMITS` is the floor of
    // last resort so a detector object that lost its `rejection` block cannot
    // produce a zero-day suppression, which would be no suppression at all.
    const detector = await loadDetector(tenantId, undefined, tx);
    const cooldownDays = Math.round(
      clamp(
        input.cooldownDays ??
          detector?.body.rejection.cooldownDays ??
          LIMITS.problemCandidateCooldownDays,
        0,
        3_650,
      ),
    );

    const decidedAt = new Date();
    const suppressedUntil = new Date(decidedAt.getTime() + cooldownDays * 86_400_000);

    const updated = (await scoped('problem_candidates', tenantId, tx)
      .where('problem_candidates.id', candidateId)
      .update({
        state: 'rejected',
        decided_at: decidedAt,
        decided_by: actor.userId ?? null,
        decision_note: truncate(note, 512),
        suppressed_until: suppressedUntil,
      })
      .returning('*')) as unknown as CandidateRow[];

    const ticketRows = (await scoped('problem_candidate_tickets', tenantId, tx)
      .where('problem_candidate_tickets.candidate_id', candidateId)
      .select('problem_candidate_tickets.ticket_id')) as unknown as Array<Record<string, unknown>>;
    const ticketIds = ticketRows.map((entry) => num(entry.ticket_id));

    await withDecision(
      {
        tenantId,
        ticketId: null,
        subsystem: 'problem',
        decision: PROBLEM_DECISIONS.candidateRejected,
        ruleSlug: candidate.detectorSlug,
        ruleVersion: candidate.detectorVersion,
        actorId: actor.userId ?? null,
        actorType: actor.actorType,
        trx: tx,
        inputs: {
          candidateId,
          signature: candidate.signature,
          note: truncate(note, 512),
          score: candidate.score,
          incidentCount: candidate.incidentCount,
          ticketIds,
        },
      },
      (recorder) => {
        recorder.outcome({
          suppressedUntil: suppressedUntil.toISOString(),
          cooldownDays,
          // The two bars the signature has to clear to come back early. Written
          // down at rejection time so nobody has to reverse-engineer them from
          // the detector body six months later.
          escalatesAtScore: scale4(
            candidate.score * (detector?.body.rejection.escalationFactor ?? 1.5),
          ),
          escalatesAtIncidentCount: candidate.incidentCount * 2,
        });
      },
    );

    return mapCandidate(updated[0] as CandidateRow);
  };

  return trx ? run(trx) : db.transaction(run);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13 — The sweeper
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One pass per tenant that has published an ENABLED detector.
 *
 * Opting in through configuration rather than through a global switch is
 * deliberate: a desk that never seeded the object is never surprised by cards
 * appearing on a board it did not ask for. A manual kick
 * (`POST /api/problems/candidates/run`) still runs on the shipped baseline, so
 * an admin can see what the detector WOULD say before publishing anything.
 *
 * `tenants` is a global table, so `db('tenants')` is correct here — the same
 * enumeration `rollup.service` and `sla.service` use. Every read afterwards is
 * scoped to one tenant.
 */
export async function runAllTenants(
  options: { now?: Date } = {},
): Promise<Map<number, ProblemDetectionRunOutcome>> {
  const results = new Map<number, ProblemDetectionRunOutcome>();
  const tenants = (await db('tenants').select('id').orderBy('id')) as Array<{ id: number }>;

  for (const tenant of tenants) {
    if (stopRequested) break;
    const tenantId = Number(tenant.id);
    try {
      const detector = await loadDetector(tenantId, undefined, db);
      if (!detector || detector.builtin || !detector.body.enabled) continue;

      const outcome = await runForTenant(tenantId, { now: options.now });
      results.set(tenantId, outcome);

      if (outcome.proposed + outcome.suppressed + outcome.escalated + outcome.withheld > 0) {
        logger.info({ tenantId, ...outcome }, 'problem detection: pass');
      }
    } catch (error) {
      // One tenant's bad data must never stop the sweep for the others: a
      // detector that goes silent for everybody because one desk has a broken
      // rollup is a worse failure than the one it was avoiding.
      logger.error(
        { tenantId, err: (error as Error).message },
        'problem detection: pass failed for one tenant',
      );
    }
  }

  return results;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let stopRequested = false;
let inFlight: Promise<unknown> | null = null;

/**
 * The sweeper, shaped like `escalationService` so `index.ts` can start it
 * behind the same advisory leader lock: one detector per cluster. Two would not
 * create duplicate cards (`problem_candidates_live_uq` makes that impossible)
 * but they would race each other into the unique violation on every pass.
 *
 * `setTimeout` chained after each pass rather than `setInterval`, so a pass
 * slower than the period never overlaps the next one.
 */
export const problemDetectionSweeper = {
  start(options: { intervalMs?: number } = {}): void {
    if (running) return;

    // Boot assertion (the shared module asks for it explicitly): the cascade cap
    // is duplicated between `LIMITS` and `shared/problem.ts`, and a drift there
    // silently changes how many incidents a cascade touches. Failing HERE means
    // `startWorker()` logs it loudly and the desk still serves its login page.
    assertProblemLimitsAgree(LIMITS.problemCascadeMaxIncidents);

    const intervalMs = Math.max(60_000, options.intervalMs ?? SWEEP_INTERVAL_MS);
    running = true;
    stopRequested = false;

    const loop = async (): Promise<void> => {
      if (stopRequested) return;
      inFlight = (async () => {
        try {
          await runAllTenants();
        } catch (error) {
          logger.error(
            { err: (error as Error).message },
            'problem detection: sweep failed — the sweeper continues',
          );
        }
      })();
      try {
        await inFlight;
      } finally {
        inFlight = null;
      }
      if (stopRequested) return;
      timer = setTimeout(() => void loop(), intervalMs);
      timer.unref?.();
    };

    // The first pass waits a full period rather than firing at boot: a desk
    // restarting is the worst moment to add a fortnight-wide scan to the load,
    // and one hour of delay costs a detector measured in days precisely nothing.
    timer = setTimeout(() => void loop(), intervalMs);
    timer.unref?.();

    logger.info({ intervalMs }, 'problem detection: sweeper started');
  },

  /** Stop, letting an in-flight pass finish rather than tearing it in half. */
  async stop(): Promise<void> {
    stopRequested = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // Already logged where it happened.
      }
    }
    running = false;
    logger.info('problem detection: sweeper stopped');
  },

  isRunning(): boolean {
    return running;
  },

  tick: runAllTenants,
};

/** The contract's names. Thin wrappers so both spellings stay honest. */
export function startSweeper(): void {
  problemDetectionSweeper.start();
}

export function stopSweeper(): void {
  void problemDetectionSweeper.stop();
}

export const problemDetectionService = {
  runForTenant,
  runAllTenants,
  startSweeper,
  stopSweeper,
  listCandidates,
  getCandidate,
  acceptCandidate,
  rejectCandidate,
  loadDetector,
};

export default problemDetectionService;
