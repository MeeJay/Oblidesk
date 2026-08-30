/**
 * changeConflict.service.ts — the differentiating function of change management.
 *
 * Every service desk can hold a change record. What almost none of them does is
 * answer the only question the change board actually meets to ask: "if we run
 * this on Thursday at 22:00, what else is happening to the same machines, and
 * are we even allowed to touch them that week?" This module is that answer, and
 * it is deliberately the only place in the module that reads other people's
 * changes.
 *
 * ── The three things it detects, and the one it refuses to invent ────────────
 *
 *   ci_overlap        two live changes whose PLANNED WINDOWS overlap and which
 *                     share at least one configuration item. THE conflict. Its
 *                     severity is the shared CI's criticality, never the
 *                     change's own risk: two "low risk" changes on the same core
 *                     switch still take the switch down twice.
 *   freeze_window     a published `change_freeze` whose INVERTED CALENDAR is
 *                     open over the planned window. See `evaluateFreezes`.
 *   queue_saturation  more concurrent changes on one queue than the policy
 *                     allows. Severity `info`, always, and OFF by default:
 *                     capacity is not a conflict, and shipping it on would
 *                     spend the panel's credibility on its least important row.
 *
 * Parent/dependency conflicts are NOT detected. `shared/src/change.ts` states
 * the reason at `classifyChangeConflict`: this application has no CI edge
 * table, so a dependency conflict could only be guessed at, and a panel that
 * guesses is a panel people learn to dismiss without reading — which takes the
 * conflict that mattered down with it.
 *
 * ── HARD RULE 2, and the volumetrics that keep the ledger readable ──────────
 * Two code paths, two logging rules, and the difference is not laziness:
 *
 *   PLANNING (`detect(…, { mode: 'planning' })`) — somebody is choosing a date
 *     right now. It ALWAYS writes `change_conflict_evaluated`, INCLUDING the
 *     clean result, with `outcome.result = 'noop'` and `conflicts: 0`. "We
 *     checked your date and it is clear" is exactly what the scheduler needs on
 *     the record, and silence is never evidence.
 *   SWEEP (`runForTenant`) — a cache refresh nobody asked for. It writes NO
 *     per-change evaluation row. It writes one `change_conflict_raised` per
 *     conflict that appeared and one `change_conflict_cleared` per conflict
 *     that went away — both on the same code path and in the same transaction
 *     as the cache row they explain — and one per-tenant `change_conflict_scan`
 *     census ONLY when raised + cleared > 0. A refresh with no diff took no
 *     action and has nothing to explain; logging it every five minutes per
 *     tenant would bury the twelve rows that matter.
 *
 * A conflict that is re-detected unchanged writes NO row. It is the same
 * conclusion re-affirmed, not a new decision, and the fact is recorded on the
 * row it refreshed (`detected_at`) — the same ruling `problemDetection` makes
 * when it bumps a candidate instead of proposing it again.
 *
 * ── The bounds. Read this before adding a query ─────────────────────────────
 * A tenant with 10 000 changes must cost what a tenant with 10 costs, and the
 * shape that would kill this module is a changes×changes join. There is none.
 * Every query below states its own bound where it is written; the two whole-pass
 * shapes are:
 *
 *   ONE CHANGE (the planning path) — three targeted queries, driven from the CI
 *     side. The change's own CIs (capped), then `ticket_cis` probed by those ci
 *     ids on `ticket_cis_ci (tenant_id, ci_id)` and immediately inner-joined to
 *     `changes`, then one criticality read. The join to `changes` is what keeps
 *     a hot CI cheap: an incident touching the core switch has no `changes` row
 *     at all and falls out of the join before the window is ever tested.
 *   ONE TENANT (the sweep) — three tenant-wide queries and then IN-MEMORY
 *     pairing. The window read is bounded by `MAX_CHANGES_PER_PASS` and by the
 *     policy's lookahead, the CI read by that set, and the pairing by
 *     `MAX_PAIR_EVALUATIONS`. Nothing in the sweep is per-change except the
 *     writes, and the writes only happen for changes whose conflict set
 *     actually differs.
 *
 * ── TRAP 2, explicitly ──────────────────────────────────────────────────────
 * EVERY tenant is swept. A tenant that has never published a `change_policy`
 * runs on `DEFAULT_CHANGE_POLICY_BODY`, stamped `policyVersion: 0`, exactly as
 * the problem detector stamps its own baseline. The ONE thing that takes a
 * tenant out of the conflict scan is an explicitly published policy carrying
 * `conflictDetection.enabled = false` — a decision somebody took and can be
 * read back. An absent config row is not a decision, and a sweeper whose tenant
 * selection requires one is a sweeper that runs empty for the life of the
 * install.
 *
 * ── What this module does not own ───────────────────────────────────────────
 * It never decides whether a change may be scheduled. That is
 * `evaluateChangeSchedule` in `@oblidesk/shared`, called by the client, by
 * ticket.service's transition path and by `changeService.requestApproval` —
 * one implementation, three callers (HARD RULE 12). This module supplies that
 * function's `conflicts` and `freezes` inputs and nothing else. It also never
 * authorises an override: `isChangeFrozen` is a READ predicate that paints a
 * banner, and `evaluateChangeFreezeOverride` is the capability question. They
 * are two functions on purpose.
 */

import type { Knex } from 'knex';

import {
  CHANGE_DECISIONS,
  CHANGE_OUTCOMES,
  CHANGE_POLICY_DEFAULT_SLUG,
  CONFIG_BODY_FORMAT_VERSIONS,
  DEFAULT_CHANGE_POLICY_BODY,
  OPEN_STATUS_CATEGORIES,
  buildConditionFields,
  classifyChangeConflict,
  classifyQueueSaturation,
  evaluateChangeFreezes,
  evaluateCondition,
  freezeVerdictToConflict,
  isPirOwed,
  resolveChangePolicy,
  toStatusCategory,
  type ChangeCiCriticality,
  type ChangeConflict,
  type ChangeConflictClassification,
  type ChangeConflictKind,
  type ChangeConflictScanOutcome,
  type ChangeConflictSeverity,
  type ChangeConflictView,
  type ChangeFreezeBody,
  type ChangeFreezeCandidate,
  type ChangeFreezeVerdict,
  type ChangeGateMode,
  type ChangeOutcome,
  type ChangePolicyBody,
  type ChangePolicyResolution,
  type ChangeRisk,
  type ChangeType,
  type ConditionNode,
  type StatusCategory,
} from '@oblidesk/shared';

import { db, insertScoped, scoped, type Executor } from '../db';
import { logger } from '../utils/logger';
import { withDecision } from './decision.service';
import { readPublishedConfigObject, listPublishedConfigObjects } from './stateMachine.service';
import {
  addBusinessMinutesOn,
  calendarBands,
  resolveCalendar,
} from './calendar.service';
import { arm as armEscalation, loadLadder } from './escalation.service';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Bounds and cadence
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The subsystem every row this module writes is filed under.
 *
 * `'change'` is not yet in `DECISION_SUBSYSTEMS` (shared/src/constants.ts is
 * another author's file this release — see the hand-off notes). That is a
 * cosmetic gap and not a functional one: `decisionService.record` logs a warn
 * for an unknown label and WRITES THE ROW ANYWAY, because refusing to log
 * because the taxonomy is behind would trade a naming problem for a
 * missing-evidence problem. The column is `varchar(24)` with no CHECK, so
 * adding the constant needs no migration.
 */
const CHANGE_SUBSYSTEM = 'change';

/**
 * `decision_log.decision` holds the MACHINE KEY from `CHANGE_DECISIONS`, never
 * an English sentence, and that is a HARD RULE 10 decision rather than a
 * stylistic one.
 *
 * The Why drawer is a user-visible surface, so every sentence it renders has to
 * go through `t(key, fallback)`. A prose sentence baked into the ledger at write
 * time is a string that can never be translated and can never be re-worded
 * without rewriting history. The key is stable, queryable ("show me every
 * conflict this desk raised last quarter"), and the client owns the wording.
 * The narrative that a reader needs lives in `inputs` and `outcome`, which the
 * drawer renders as facts.
 */

/** How often the sweeper refreshes the cache and looks for overdue PIRs. */
const SWEEP_INTERVAL_MS = 5 * 60_000;

/** Floor for a caller-supplied interval. Below this the sweep is a busy loop. */
const MIN_SWEEP_INTERVAL_MS = 30_000;

/**
 * How far BEHIND now the sweep still looks. A window that started yesterday and
 * runs for three days is still live work and can still collide; anchoring the
 * scan at `now` would drop exactly the long changes that are most disruptive.
 */
const SWEEP_LOOKBEHIND_MS = 24 * 3_600_000;

/**
 * Changes examined per tenant per pass, soonest window first.
 *
 * THE bound of the sweep. With the shipped 28-day lookahead a real desk has a
 * few dozen scheduled changes; a desk that has 10 000 gets its next 250 windows
 * scanned this tick and the rest on a later one, and the planning path still
 * answers exactly for whichever change somebody actually opens. A cap that
 * degrades to "slightly stale for the far future" is the right failure mode; an
 * unbounded pass that times out and refreshes NOTHING is not.
 */
const MAX_CHANGES_PER_PASS = 250;

/** CIs read per change. Beyond this a change is a spreadsheet, not a change. */
const MAX_CIS_PER_CHANGE = 200;

/**
 * Rows the single-change overlap probe will scan on the other side. It is a
 * ceiling on a query that is already selective (see the query's own comment);
 * it exists so a pathological CI cannot turn one date-picker keystroke into a
 * sequential scan.
 */
const MAX_CONFLICT_CANDIDATE_ROWS = 2_000;

/** Conflicting counterparts retained for one change. The panel is a panel. */
const MAX_OTHER_CHANGES = 50;

/** In-memory pair tests per tenant pass. 250 changes cannot reach it. */
const MAX_PAIR_EVALUATIONS = 20_000;

/**
 * Counterpart changes whose cache is repaired when one change's window moves.
 *
 * A CI overlap is symmetric but its two `change_conflicts` rows are not: A's row
 * names B and B's row names A. When A moves, B's row is stale until the next
 * sweep — and a stale row on B is not cosmetic, it is a BLOCKER B's owner
 * cannot clear. So the planning path repairs both sides, one level deep, never
 * recursively, capped here. Whatever the cap drops, the five-minute sweep
 * catches.
 */
const MAX_MIRROR_REFRESH = 25;

/** Overdue PIRs stamped per tenant per pass. */
const MAX_PIR_PER_PASS = 200;

/** Published `change_freeze` objects considered. A desk has a handful. */
const MAX_FREEZE_OBJECTS = 50;

/**
 * Categories a ticket must be in for its change to still be able to collide.
 *
 * HARD RULE 5 — derived from the category metadata, never from a hand-written
 * list of slugs and never from a hand-written list of categories either.
 * `countsAsOpen` is exactly `new | open | pending_requester |
 * pending_third_party | scheduled`, i.e. everything that is not
 * resolved/closed/cancelled. A change somebody already resolved cannot take
 * your switch down.
 */
const LIVE_CATEGORIES: readonly string[] = [...OPEN_STATUS_CATEGORIES];

/**
 * The `ticket_cis.role` values that mean "this change TOUCHES the item".
 *
 * THE FILTER IS LOAD-BEARING AND IT APPLIES ON BOTH SIDES. `cause` means "this
 * CI is WHY we are doing the work" — the failing disk the change replaces —
 * not "we are taking it down". Counting cause links would flag every change
 * against the very thing it is fixing, and the panel would be noise on day one.
 */
const TOUCHING_ROLES: readonly string[] = ['primary', 'affected'];

const POLICY_KIND = 'change_policy';
const FREEZE_KIND = 'change_freeze';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Small helpers
// ═════════════════════════════════════════════════════════════════════════════

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toIso(value: unknown, fallback: string): string {
  return toIsoOrNull(value) ?? fallback;
}

function msOf(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function strOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length === 0 ? null : s;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `jsonb` comes back parsed from pg, but a string is still possible on raw. */
function intArray(value: unknown): number[] {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return [];
          }
        })()
      : value;
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const item of raw) {
    const n = Number(item);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}

/** `cis.criticality` is a nullable varchar; anything unknown reads as null. */
function toCiCriticality(value: unknown): ChangeCiCriticality | null {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  return null;
}

const CRITICALITY_RANK: Readonly<Record<ChangeCiCriticality, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Worst (highest) criticality of a set. NULL means "we do not know", not "low". */
function worstCriticality(
  ciIds: readonly number[],
  byCi: ReadonlyMap<number, ChangeCiCriticality | null>,
): ChangeCiCriticality | null {
  let worst: ChangeCiCriticality | null = null;
  for (const ciId of ciIds) {
    const value = byCi.get(ciId) ?? null;
    if (value === null) continue;
    if (worst === null || CRITICALITY_RANK[value] > CRITICALITY_RANK[worst]) worst = value;
  }
  return worst;
}

function toChangeType(value: unknown): ChangeType {
  return value === 'standard' || value === 'emergency' ? value : 'normal';
}

function toChangeRisk(value: unknown): ChangeRisk | null {
  return value === 'high' || value === 'medium' || value === 'low' ? value : null;
}

function toChangeOutcome(value: unknown): ChangeOutcome | null {
  return (CHANGE_OUTCOMES as readonly string[]).includes(String(value))
    ? (value as ChangeOutcome)
    : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — The policy: THE trap-2 guard
// ═════════════════════════════════════════════════════════════════════════════

export interface LoadedChangePolicy {
  /** HARD RULE 3 — what `decision_log.rule_slug` will name. */
  slug: string;
  /** HARD RULE 4 — `0` means the SHIPPED baseline decided. */
  version: number;
  body: ChangePolicyBody;
  /** False when no object was published and the baseline is in force. */
  published: boolean;
}

/**
 * Fold a published body over the shipped baseline.
 *
 * A tenant that publishes `{ conflictDetection: { enabled: false } }` and
 * nothing else must not take the risk matrix, the bands or the tolerance down
 * with it. Every unknown or malformed sub-object falls back to the baseline's,
 * one level at a time, because the alternative — refusing the whole body — turns
 * one bad key into a tenant with no change policy at all.
 */
function normalizePolicyBody(raw: unknown): ChangePolicyBody {
  const base = DEFAULT_CHANGE_POLICY_BODY;
  if (!isRecord(raw)) return base;

  const body = raw as Partial<ChangePolicyBody>;
  const detection = isRecord(body.conflictDetection)
    ? (body.conflictDetection as ChangePolicyBody['conflictDetection'])
    : base.conflictDetection;

  return {
    riskMatrix: isRecord(body.riskMatrix) ? { ...base.riskMatrix, ...body.riskMatrix } : base.riskMatrix,
    riskBands: isRecord(body.riskBands)
      ? {
          high: { ...base.riskBands.high, ...(isRecord(body.riskBands.high) ? body.riskBands.high : {}) },
          medium: { ...base.riskBands.medium, ...(isRecord(body.riskBands.medium) ? body.riskBands.medium : {}) },
          low: { ...base.riskBands.low, ...(isRecord(body.riskBands.low) ? body.riskBands.low : {}) },
        }
      : base.riskBands,
    byType: isRecord(body.byType)
      ? {
          standard: { ...base.byType.standard, ...(isRecord(body.byType.standard) ? body.byType.standard : {}) },
          normal: { ...base.byType.normal, ...(isRecord(body.byType.normal) ? body.byType.normal : {}) },
          emergency: { ...base.byType.emergency, ...(isRecord(body.byType.emergency) ? body.byType.emergency : {}) },
        }
      : base.byType,
    byCiCriticality: isRecord(body.byCiCriticality) ? body.byCiCriticality : base.byCiCriticality,
    byQueue: isRecord(body.byQueue) ? (body.byQueue as Record<string, { addApprovalSlugs: string[] }>) : base.byQueue,
    conflictDetection: {
      enabled: detection.enabled !== false,
      lookaheadDays:
        Number.isFinite(detection.lookaheadDays) && Number(detection.lookaheadDays) > 0
          ? Math.min(365, Math.floor(Number(detection.lookaheadDays)))
          : base.conflictDetection.lookaheadDays,
      maxConcurrentPerQueue:
        Number.isFinite(detection.maxConcurrentPerQueue) && Number(detection.maxConcurrentPerQueue) >= 0
          ? Math.floor(Number(detection.maxConcurrentPerQueue))
          : base.conflictDetection.maxConcurrentPerQueue,
      queueSaturationEnabled: detection.queueSaturationEnabled === true,
    },
    windowMoveToleranceMinutes:
      Number.isFinite(body.windowMoveToleranceMinutes) && Number(body.windowMoveToleranceMinutes) >= 0
        ? Math.floor(Number(body.windowMoveToleranceMinutes))
        : base.windowMoveToleranceMinutes,
    escalationSlug: strOrNull(body.escalationSlug),
    calendarSlug: strOrNull(body.calendarSlug),
  };
}

/**
 * THE trap-2 guard, and the reason every tenant is swept.
 *
 * Returns the SHIPPED baseline stamped `version: 0` when the tenant published
 * nothing. Returns `null` for exactly one thing: a body from a
 * `body_format_version` this release does not know, which `configKinds.ts`
 * says plainly must be REFUSED rather than guessed at. Guessing there would
 * mean gating a production change on thresholds nobody wrote.
 */
export async function loadChangePolicy(
  tenantId: number,
  slug: string = CHANGE_POLICY_DEFAULT_SLUG,
  executor: Executor = db,
): Promise<LoadedChangePolicy | null> {
  const row = await readPublishedConfigObject(tenantId, POLICY_KIND, slug, executor);
  if (!row) {
    return {
      slug: CHANGE_POLICY_DEFAULT_SLUG,
      version: 0,
      body: DEFAULT_CHANGE_POLICY_BODY,
      published: false,
    };
  }

  const supported = CONFIG_BODY_FORMAT_VERSIONS[POLICY_KIND];
  if (row.bodyFormatVersion > supported) {
    logger.warn(
      { tenantId, slug: row.slug, bodyFormatVersion: row.bodyFormatVersion, supported },
      'change conflicts: refusing a change_policy body from a newer format — this tenant stands down',
    );
    return null;
  }

  return {
    slug: row.slug,
    version: row.version,
    body: normalizePolicyBody(row.body),
    published: true,
  };
}

/** Resolve the policy for one change's facts. Never null: the baseline resolves. */
function resolveFor(
  loaded: LoadedChangePolicy | null,
  facts: { changeType: ChangeType; risk: ChangeRisk | null; queueSlug: string | null },
  worstCi: ChangeCiCriticality | null,
): ChangePolicyResolution {
  return resolveChangePolicy(
    loaded?.body ?? null,
    {
      changeType: facts.changeType,
      risk: facts.risk,
      queueSlug: facts.queueSlug,
      worstCiCriticality: worstCi,
    },
    { slug: loaded?.slug ?? null, version: loaded?.published ? loaded.version : 0 },
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Freeze windows: one existing calendar, INVERTED
// ═════════════════════════════════════════════════════════════════════════════

export interface LoadedChangeFreeze {
  slug: string;
  /** `config_objects.version`, so a bypass replays against what refused it. */
  version: number;
  body: ChangeFreezeBody;
}

/**
 * Tolerant read of a `change_freeze` body.
 *
 * Returns null when the object cannot possibly freeze anything — no
 * `calendarSlug` — rather than carrying a control that looks live and is not.
 * The config linter is what TELLS the tenant (see the hand-off notes); this is
 * what stops the engine acting on it.
 */
function normalizeFreezeBody(raw: unknown): ChangeFreezeBody | null {
  if (!isRecord(raw)) return null;
  const calendarSlug = strOrNull(raw.calendarSlug);
  if (calendarSlug === null) return null;

  const exemptTypes = Array.isArray(raw.exemptTypes)
    ? raw.exemptTypes.filter(
        (t): t is ChangeType => t === 'standard' || t === 'normal' || t === 'emergency',
      )
    : undefined;
  const appliesToRiskBands = Array.isArray(raw.appliesToRiskBands)
    ? raw.appliesToRiskBands.filter(
        (b): b is ChangeRisk => b === 'high' || b === 'medium' || b === 'low',
      )
    : undefined;

  return {
    enabled: raw.enabled !== false,
    calendarSlug,
    appliesWhen: (raw.appliesWhen ?? null) as ConditionNode | null,
    exemptTypes,
    appliesToRiskBands,
    severity: raw.severity === 'warn' ? 'warn' : 'block',
    overrideApprovalSlug: strOrNull(raw.overrideApprovalSlug),
    label: strOrNull(raw.label) ?? undefined,
    labelKey: strOrNull(raw.labelKey) ?? undefined,
    reason: strOrNull(raw.reason) ?? undefined,
    reasonKey: strOrNull(raw.reasonKey) ?? undefined,
  };
}

/**
 * Every published `change_freeze` this tenant can be refused by.
 *
 * BOUND: one indexed read of `config_objects` by (tenant_id, kind, status) — a
 * handful of rows on any real desk, capped at `MAX_FREEZE_OBJECTS` so a tenant
 * that scripted a thousand of them cannot turn one date-picker keystroke into a
 * thousand calendar evaluations. The sweep loads this ONCE per tenant pass and
 * hands it to every change.
 */
export async function loadChangeFreezes(
  tenantId: number,
  executor: Executor = db,
): Promise<LoadedChangeFreeze[]> {
  const rows = await listPublishedConfigObjects(tenantId, FREEZE_KIND, executor);
  const supported = CONFIG_BODY_FORMAT_VERSIONS[FREEZE_KIND];
  const out: LoadedChangeFreeze[] = [];

  for (const row of rows) {
    if (out.length >= MAX_FREEZE_OBJECTS) {
      logger.warn(
        { tenantId, cap: MAX_FREEZE_OBJECTS },
        'change freezes: more published freezes than the cap — the rest are ignored this pass',
      );
      break;
    }
    if (row.bodyFormatVersion > supported) {
      // Same ruling as the policy: refuse, never guess. A freeze from a future
      // format could mean the opposite of what this release would read.
      logger.warn(
        { tenantId, slug: row.slug, bodyFormatVersion: row.bodyFormatVersion, supported },
        'change freezes: ignoring a change_freeze body from a newer format',
      );
      continue;
    }
    const body = normalizeFreezeBody(row.body);
    if (!body) {
      logger.warn(
        { tenantId, slug: row.slug },
        'change freezes: ignoring a change_freeze with no calendarSlug — it freezes nothing',
      );
      continue;
    }
    out.push({ slug: row.slug, version: row.version, body });
  }

  return out;
}

/** The ticket facts a freeze's `appliesWhen` may be written against. */
export interface ChangeFreezeSubject {
  ticketId: number;
  changeType: ChangeType;
  risk: ChangeRisk | null;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  /** Ticket columns, so `appliesWhen` can say "only the network queue". */
  ticket?: Record<string, unknown> | null;
}

export interface EvaluateFreezesInput {
  tenantId: number;
  change: ChangeFreezeSubject;
  /** The policy band's `freezeGate`. `off` skips everything. */
  gate: ChangeGateMode;
  /** Pre-loaded by the sweep; read on demand by the planning path. */
  freezes?: readonly LoadedChangeFreeze[];
  /** Names the policy on the `freezeEvaluated` row (HARD RULES 3 and 4). */
  policy?: ChangePolicyResolution;
  /** Write `change_freeze_evaluated`. TRUE on the planning path only. */
  record?: boolean;
  now?: string;
  executor?: Executor;
  trx?: Executor;
}

/**
 * Which freezes actually cover this change's planned window, and how hard.
 *
 * ── THE INVERSION ───────────────────────────────────────────────────────────
 * A freeze is a `calendar` authored with the FREEZE PERIODS AS THE OPEN SHIFTS.
 * So here, and ONLY here in the whole product, `band.open === true` means SHUT
 * FOR CHANGES. That single line is why freezes cost one function instead of a
 * second date engine with its own recurrence, holidays, exceptions and
 * timezone — all of which `calendar.service` already has, already tests, and
 * already exports in the config bundle.
 *
 * BOUND: one `calendarBands` call per enabled freeze per change, over the
 * planned window only. `calendarBands` is pure CPU over a calendar
 * `resolveCalendar` caches for five minutes, and it caps itself at 120 bands.
 * There is no query in this loop.
 *
 * The verdicts come out of `evaluateChangeFreezes` in `@oblidesk/shared` — the
 * SAME function the client calls to grey the Schedule button — so the exemption
 * rules (disabled, wrong type, wrong band, `appliesWhen` said no, gate `warn`
 * downgrading a block) live in one place and cannot drift.
 */
export async function evaluateFreezes(input: EvaluateFreezesInput): Promise<ChangeFreezeVerdict[]> {
  const { tenantId, change } = input;
  const executor = input.executor ?? db;
  const nowIso = input.now ?? new Date().toISOString();

  // No window, nothing to test. The schedule gate refuses the move on
  // `change_window_missing`; a freeze has nothing to add to that.
  if (change.plannedStartAt === null || change.plannedEndAt === null) return [];
  if (input.gate === 'off') return [];

  const freezes = input.freezes ?? (await loadChangeFreezes(tenantId, executor));
  if (freezes.length === 0) {
    if (input.record) {
      await withDecision(
        {
          tenantId,
          ticketId: change.ticketId,
          subsystem: CHANGE_SUBSYSTEM,
          decision: CHANGE_DECISIONS.freezeEvaluated,
          ruleSlug: input.policy?.policySlug ?? null,
          ruleVersion: input.policy?.policyVersion ?? null,
          actorType: 'system',
          trx: input.trx,
          inputs: {
            window: { startAt: change.plannedStartAt, endAt: change.plannedEndAt },
            gate: input.gate,
            freezesConsidered: [],
            at: nowIso,
          },
        },
        (recorder) => {
          recorder.noop('no_freeze_published');
        },
      );
    }
    return [];
  }

  const candidates: ChangeFreezeCandidate[] = [];
  const considered: string[] = [];

  for (const freeze of freezes) {
    considered.push(freeze.slug);
    if (!freeze.body.enabled) {
      // `evaluateChangeFreezes` would drop it anyway; skipping here saves the
      // calendar read for a freeze somebody deliberately switched off.
      continue;
    }

    const loaded = await resolveCalendar(tenantId, freeze.body.calendarSlug, executor);

    // `resolveCalendar` falls back to the tenant DEFAULT when a slug does not
    // resolve. That is right for the SLA engine, which wants business hours
    // when nobody named a calendar, and catastrophic here, because a freeze
    // calendar INVERTS the meaning: `open === true` is FROZEN. Falling back to
    // the working-hours calendar therefore freezes every working hour — one
    // typo in a freeze's `calendarSlug` and nothing can be deployed all week,
    // with the block naming a freeze that was never meant to bite.
    //
    // The freeze is skipped instead. Silently protecting nothing would be the
    // other bad answer, so it is skipped LOUDLY: the operator who wrote the
    // typo is the only person who can fix it, and a freeze that quietly does
    // not apply is one somebody believes is protecting them.
    const requested = (freeze.body.calendarSlug ?? '').toLowerCase();
    if (requested !== '' && loaded.slug.toLowerCase() !== requested) {
      logger.error(
        { tenantId, freezeSlug: freeze.slug, calendarSlug: freeze.body.calendarSlug, resolved: loaded.slug },
        'change freeze: its calendar does not exist — the freeze is INACTIVE until the slug is fixed',
      );
      continue;
    }

    const bands = calendarBands(loaded.calendar, change.plannedStartAt, change.plannedEndAt);
    const frozen = bands.find((band) => band.open);

    candidates.push({
      slug: freeze.slug,
      version: freeze.version,
      body: freeze.body,
      // THE INVERSION. `open === true` in a freeze calendar means FROZEN.
      frozenBandFound: frozen !== undefined,
      // The FIRST frozen band, clamped to the window by `calendarBands` itself.
      // A freeze that opens twice inside one window reports the first: the panel
      // needs "the freeze starts biting here", not a list of fragments.
      overlapStartAt: frozen ? new Date(frozen.fromMs).toISOString() : null,
      overlapEndAt: frozen ? new Date(frozen.toMs).toISOString() : null,
      appliesWhenMatched: freezeApplies(freeze.body.appliesWhen, change, nowIso),
    });
  }

  const verdicts = evaluateChangeFreezes({
    candidates,
    changeType: change.changeType,
    risk: change.risk,
    gate: input.gate,
  });

  if (input.record) {
    await withDecision(
      {
        tenantId,
        ticketId: change.ticketId,
        subsystem: CHANGE_SUBSYSTEM,
        decision: CHANGE_DECISIONS.freezeEvaluated,
        // The policy chose the GATE; the freeze objects are named in the inputs
        // and, when one actually fires, on the `conflictRaised` row that carries
        // its own slug and published version.
        ruleSlug: input.policy?.policySlug ?? null,
        ruleVersion: input.policy?.policyVersion ?? null,
        actorType: 'system',
        trx: input.trx,
        inputs: {
          window: { startAt: change.plannedStartAt, endAt: change.plannedEndAt },
          gate: input.gate,
          changeType: change.changeType,
          risk: change.risk,
          freezesConsidered: considered,
          at: nowIso,
        },
      },
      (recorder) => {
        if (verdicts.length === 0) {
          recorder.noop('no_freeze_applies');
          return;
        }
        recorder.outcome({
          fired: verdicts.length,
          blocking: verdicts.filter((v) => v.severity === 'block').length,
          verdicts: verdicts.map((v) => ({
            slug: v.slug,
            version: v.version,
            severity: v.severity,
            overrideApprovalSlug: v.overrideApprovalSlug,
          })),
        });
      },
    );
  }

  return verdicts;
}

/**
 * The caller's half of `ChangeFreezeCandidate.appliesWhenMatched`.
 *
 * `undefined` means "not asked", which the shared evaluator reads as MATCHING.
 * That is deliberate in both directions: a freeze with no `appliesWhen` applies
 * to everything, and a freeze whose condition we cannot evaluate (no ticket
 * context) must not be silently dropped — a freeze that quietly stops applying
 * is the failure this control exists to prevent.
 */
function freezeApplies(
  appliesWhen: ConditionNode | null | undefined,
  change: ChangeFreezeSubject,
  nowIso: string,
): boolean | undefined {
  if (appliesWhen === null || appliesWhen === undefined) return undefined;
  if (!change.ticket) return undefined;

  const base: Record<string, unknown> = { ...change.ticket };
  base['change.change_type'] = change.changeType;
  base['change.risk'] = change.risk;
  base['change.planned_start_at'] = change.plannedStartAt;
  base['change.planned_end_at'] = change.plannedEndAt;

  return evaluateCondition(appliesWhen, {
    fields: buildConditionFields(base),
    // HARD RULE 2's replayability clause: an engine that lets the evaluator
    // default to `Date.now()` writes a row that cannot be replayed.
    now: nowIso,
  }).matched;
}

/**
 * The route-shaped entry point: "which freezes does change N run into?".
 *
 * `GET /api/changes/:ticketId/freeze` has a ticket id and nothing else, so this
 * reads the change, resolves the policy (baseline included — TRAP 2) and hands
 * the rest to `evaluateFreezes`.
 *
 * IT WRITES NO DECISION ROW, and that is deliberate: this is a READ. Painting
 * the banner is not a decision, and logging one every time a drawer opens would
 * bury the row written when a freeze actually refuses a move. The verdicts it
 * returns feed `isChangeFrozen`, which is likewise a read predicate and must
 * never be used to authorise an override — that is
 * `evaluateChangeFreezeOverride`, a capability question, deliberately a
 * different function.
 */
export async function evaluateFreezesForChange(
  tenantId: number,
  ticketId: number,
  options: { now?: string; executor?: Executor } = {},
): Promise<ChangeFreezeVerdict[]> {
  const executor = options.executor ?? db;
  const subject = await readChangeSubject(tenantId, ticketId, executor);
  if (!subject) return [];

  const policyLoaded = await loadChangePolicy(tenantId, undefined, executor);
  const policy = resolveFor(policyLoaded, subject, null);

  return evaluateFreezes({
    tenantId,
    change: {
      ticketId,
      changeType: subject.changeType,
      risk: subject.risk,
      plannedStartAt: subject.plannedStartAt,
      plannedEndAt: subject.plannedEndAt,
      ticket: subject.ticketFields,
    },
    gate: policy.freezeGate,
    policy,
    record: false,
    now: options.now,
    executor,
  });
}

export const changeFreezeService = {
  /** `(tenantId, ticketId)` — what the freeze route calls. */
  evaluate: evaluateFreezesForChange,
  /** The full form, for callers that already hold the change and the policy. */
  evaluateWith: evaluateFreezes,
  load: loadChangeFreezes,
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Row shapes
// ═════════════════════════════════════════════════════════════════════════════

/** Everything the detector needs about ONE change. Nothing else is read. */
export interface ChangeConflictSubject {
  ticketId: number;
  changeType: ChangeType;
  risk: ChangeRisk | null;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  conflictAckAt: string | null;
  conflictAckDigest: string | null;
  /** From the TICKET (HARD RULE 3 — routing is a queue slug). */
  queueSlug: string | null;
  statusCategory: StatusCategory;
  number: string;
  subject: string;
  /** The bag `appliesWhen` is evaluated against. */
  ticketFields: Record<string, unknown>;
}

/** Columns of `tickets` the freeze conditions and the panel may read. */
const TICKET_COLUMNS = [
  'tickets.id as t_id',
  'tickets.number as t_number',
  'tickets.subject as t_subject',
  'tickets.record_type as t_record_type',
  'tickets.status_slug as t_status_slug',
  'tickets.status_category as t_status_category',
  'tickets.priority_slug as t_priority_slug',
  'tickets.impact as t_impact',
  'tickets.urgency as t_urgency',
  'tickets.queue_slug as t_queue_slug',
  'tickets.assignee_id as t_assignee_id',
  'tickets.assignment_group_id as t_assignment_group_id',
  'tickets.requester_user_id as t_requester_user_id',
  'tickets.organization_id as t_organization_id',
  'tickets.occurred_at as t_occurred_at',
  'tickets.created_at as t_created_at',
  'tickets.updated_at as t_updated_at',
] as const;

const CHANGE_COLUMNS = [
  'changes.ticket_id',
  'changes.change_type',
  'changes.risk',
  'changes.planned_start_at',
  'changes.planned_end_at',
  'changes.conflict_ack_at',
  'changes.conflict_ack_digest',
] as const;

function mapSubject(row: Record<string, unknown>): ChangeConflictSubject {
  const statusCategory = toStatusCategory(row.t_status_category);
  const queueSlug = strOrNull(row.t_queue_slug);

  // The `appliesWhen` bag, in the same two spellings every other engine offers
  // (`status_category` and `ticket.status_category`), so a condition written
  // for a rule works unchanged in a freeze.
  const base: Record<string, unknown> = {
    id: num(row.t_id),
    number: String(row.t_number ?? ''),
    subject: String(row.t_subject ?? ''),
    record_type: strOrNull(row.t_record_type),
    status_slug: strOrNull(row.t_status_slug),
    status_category: statusCategory,
    priority_slug: strOrNull(row.t_priority_slug),
    impact: strOrNull(row.t_impact),
    urgency: strOrNull(row.t_urgency),
    queue_slug: queueSlug,
    assignee_id: row.t_assignee_id === null || row.t_assignee_id === undefined ? null : num(row.t_assignee_id),
    assignment_group_id:
      row.t_assignment_group_id === null || row.t_assignment_group_id === undefined
        ? null
        : num(row.t_assignment_group_id),
    requester_user_id:
      row.t_requester_user_id === null || row.t_requester_user_id === undefined
        ? null
        : num(row.t_requester_user_id),
    organization_id:
      row.t_organization_id === null || row.t_organization_id === undefined ? null : num(row.t_organization_id),
    occurred_at: toIsoOrNull(row.t_occurred_at),
    created_at: toIsoOrNull(row.t_created_at),
    updated_at: toIsoOrNull(row.t_updated_at),
  };
  const ticketFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    ticketFields[key] = value;
    ticketFields[`ticket.${key}`] = value;
  }

  return {
    ticketId: num(row.ticket_id),
    changeType: toChangeType(row.change_type),
    risk: toChangeRisk(row.risk),
    plannedStartAt: toIsoOrNull(row.planned_start_at),
    plannedEndAt: toIsoOrNull(row.planned_end_at),
    conflictAckAt: toIsoOrNull(row.conflict_ack_at),
    conflictAckDigest: strOrNull(row.conflict_ack_digest),
    queueSlug,
    statusCategory,
    number: String(row.t_number ?? ''),
    subject: String(row.t_subject ?? ''),
    ticketFields,
  };
}

interface LiveConflictRow {
  id: number;
  digest: string;
  kind: ChangeConflictKind;
  severity: ChangeConflictSeverity;
  otherTicketId: number | null;
  freezeSlug: string | null;
  /** HARD RULE 4 — so a CLEARED freeze row still names the version that raised it. */
  freezeVersion: number | null;
  queueSlug: string | null;
  ciIds: number[];
  overlapStartAt: string | null;
  overlapEndAt: string | null;
}

function mapConflictRow(row: Record<string, unknown>): ChangeConflict {
  return {
    id: num(row.id),
    tenantId: num(row.tenant_id),
    changeTicketId: num(row.change_ticket_id),
    kind: String(row.kind) as ChangeConflictKind,
    severity: String(row.severity) as ChangeConflictSeverity,
    otherTicketId:
      row.other_ticket_id === null || row.other_ticket_id === undefined ? null : num(row.other_ticket_id),
    freezeSlug: strOrNull(row.freeze_slug),
    freezeVersion: row.freeze_version === null || row.freeze_version === undefined ? null : num(row.freeze_version),
    queueSlug: strOrNull(row.queue_slug),
    ciIds: intArray(row.ci_ids),
    overlapStartAt: toIsoOrNull(row.overlap_start_at),
    overlapEndAt: toIsoOrNull(row.overlap_end_at),
    detectedAt: toIso(row.detected_at, new Date().toISOString()),
    clearedAt: toIsoOrNull(row.cleared_at),
    digest: String(row.digest ?? ''),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — The reads, each with its own bound
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One change and its ticket.
 *
 * BOUND: two primary-key lookups joined. `changes.ticket_id` is the PK and
 * `tickets.id` is the PK; there is no scan here at any tenant size.
 */
export async function readChangeSubject(
  tenantId: number,
  ticketId: number,
  executor: Executor = db,
): Promise<ChangeConflictSubject | null> {
  const row = (await scoped('changes', tenantId, executor)
    .join('tickets', 'tickets.id', 'changes.ticket_id')
    // `scoped()` owns the ROOT only. Every joined tenant table is re-scoped by
    // hand or the join is a cross-tenant read waiting to happen (HARD RULE 1).
    .where('tickets.tenant_id', tenantId)
    .whereNull('tickets.deleted_at')
    .where('changes.ticket_id', ticketId)
    .first(...CHANGE_COLUMNS, ...TICKET_COLUMNS)) as Record<string, unknown> | undefined;

  return row ? mapSubject(row) : null;
}

/**
 * The CIs this change TOUCHES.
 *
 * BOUND: `ticket_cis` is keyed on `(ticket_id, ci_id)`, so this is one index
 * range over one ticket, capped at `MAX_CIS_PER_CHANGE`. A change with no CI
 * link produces an empty list, and the caller then issues NO further queries at
 * all — which is the honest answer, because a change nobody linked to anything
 * cannot be shown to collide with anything.
 */
async function readTouchedCis(
  tenantId: number,
  ticketId: number,
  executor: Executor,
): Promise<number[]> {
  const rows = (await scoped('ticket_cis', tenantId, executor)
    .where('ticket_cis.ticket_id', ticketId)
    .whereIn('ticket_cis.role', TOUCHING_ROLES)
    .orderBy('ticket_cis.ci_id', 'asc')
    .limit(MAX_CIS_PER_CHANGE)
    .select('ticket_cis.ci_id')) as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => num(row.ci_id)).filter((id) => id > 0);
}

/**
 * Criticality of a set of CIs.
 *
 * BOUND: one `whereIn` on the `cis` primary key, over a list that is already
 * capped by the reads above. This is what makes a conflict's SEVERITY a
 * property of the thing at stake rather than of the change's own risk band.
 */
async function readCriticality(
  tenantId: number,
  ciIds: readonly number[],
  executor: Executor,
): Promise<Map<number, ChangeCiCriticality | null>> {
  const out = new Map<number, ChangeCiCriticality | null>();
  if (ciIds.length === 0) return out;

  const rows = (await scoped('cis', tenantId, executor)
    .whereIn('cis.id', [...ciIds])
    .select('cis.id', 'cis.criticality')) as unknown as Array<Record<string, unknown>>;

  for (const row of rows) out.set(num(row.id), toCiCriticality(row.criticality));
  return out;
}

interface OverlapCandidate {
  otherTicketId: number;
  otherWindow: { startAt: string; endAt: string } | null;
  sharedCiIds: number[];
}

/**
 * THE overlap probe for ONE change, and the query whose shape decides whether
 * this feature is usable on a real desk.
 *
 * IT IS DRIVEN FROM THE CI SIDE, NEVER FROM CHANGES × CHANGES. The naive
 * version — "join every change to every other change, then test the windows" —
 * is a cartesian product that a tenant with 10 000 changes turns into 100
 * million row pairs, and it is why conflict detection is switched off in most
 * of the tools that ship it.
 *
 * BOUND, in the order the planner walks it:
 *   1. `ticket_cis_ci (tenant_id, ci_id)` — an index probe for the (capped) CI
 *      list. This is the only cardinality that is not fixed: a CI that every
 *      incident on the desk mentions has many rows here.
 *   2. the INNER JOIN to `changes` on its primary key immediately drops all of
 *      them that are not changes. An incident on the core switch has no
 *      `changes` row, so a hot CI costs one PK miss per link and nothing more.
 *      This join is the reason step 1's cardinality is survivable.
 *   3. `planned_window && tstzrange(…)` on the survivors, backed by
 *      `changes_planned_gist` when the planner prefers to start there instead.
 *   4. `LIMIT MAX_CONFLICT_CANDIDATE_ROWS`, so even a pathological CMDB cannot
 *      turn one keystroke in a date picker into an unbounded read.
 *
 * The window predicate is `&&` on the two GENERATED half-open `[)` ranges, so
 * back-to-back windows (22:00–23:00 and 23:00–00:00) do NOT collide — which is
 * the whole reason migration 011 generates them half-open rather than letting
 * each caller re-derive the comparison and get the boundary wrong differently.
 */
async function readOverlapCandidates(
  tenantId: number,
  ticketId: number,
  ciIds: readonly number[],
  window: { startAt: string; endAt: string },
  executor: Executor,
): Promise<OverlapCandidate[]> {
  if (ciIds.length === 0) return [];

  const rows = (await scoped('ticket_cis', tenantId, executor)
    .join('changes', 'changes.ticket_id', 'ticket_cis.ticket_id')
    .join('tickets', 'tickets.id', 'ticket_cis.ticket_id')
    // Re-scope EVERY joined tenant table (HARD RULE 1).
    .where('changes.tenant_id', tenantId)
    .where('tickets.tenant_id', tenantId)
    .whereIn('ticket_cis.ci_id', [...ciIds])
    .whereIn('ticket_cis.role', TOUCHING_ROLES)
    .whereNot('ticket_cis.ticket_id', ticketId)
    .whereNull('tickets.deleted_at')
    // HARD RULE 5 — the CATEGORY decides, never a status slug.
    .whereIn('tickets.status_category', LIVE_CATEGORIES)
    .whereRaw("changes.planned_window && tstzrange(?, ?, '[)')", [window.startAt, window.endAt])
    .limit(MAX_CONFLICT_CANDIDATE_ROWS)
    .select(
      'ticket_cis.ticket_id',
      'ticket_cis.ci_id',
      'changes.planned_start_at',
      'changes.planned_end_at',
    )) as unknown as Array<Record<string, unknown>>;

  const byTicket = new Map<number, OverlapCandidate>();
  for (const row of rows) {
    const otherTicketId = num(row.ticket_id);
    const ciId = num(row.ci_id);
    if (otherTicketId <= 0 || ciId <= 0) continue;

    let entry = byTicket.get(otherTicketId);
    if (!entry) {
      if (byTicket.size >= MAX_OTHER_CHANGES) continue;
      const startAt = toIsoOrNull(row.planned_start_at);
      const endAt = toIsoOrNull(row.planned_end_at);
      entry = {
        otherTicketId,
        otherWindow: startAt !== null && endAt !== null ? { startAt, endAt } : null,
        sharedCiIds: [],
      };
      byTicket.set(otherTicketId, entry);
    }
    if (!entry.sharedCiIds.includes(ciId)) entry.sharedCiIds.push(ciId);
  }

  return [...byTicket.values()];
}

/**
 * How many other live changes share this change's queue and window.
 *
 * BOUND: one COUNT over `changes` joined to `tickets`, restricted by the same
 * `planned_window &&` predicate as above. Only ever issued when the tenant
 * turned `queueSaturationEnabled` on — it ships OFF, so on a default install
 * this query never runs at all.
 */
async function countQueueConcurrency(
  tenantId: number,
  ticketId: number,
  queueSlug: string,
  window: { startAt: string; endAt: string },
  executor: Executor,
): Promise<number> {
  const row = (await scoped('changes', tenantId, executor)
    .join('tickets', 'tickets.id', 'changes.ticket_id')
    .where('tickets.tenant_id', tenantId)
    .whereNull('tickets.deleted_at')
    .whereIn('tickets.status_category', LIVE_CATEGORIES)
    .where('tickets.queue_slug', queueSlug)
    .whereNot('changes.ticket_id', ticketId)
    .whereRaw("changes.planned_window && tstzrange(?, ?, '[)')", [window.startAt, window.endAt])
    .count<{ count: string }>('changes.ticket_id as count')
    .first()) as { count?: string } | undefined;

  return num(row?.count);
}

/**
 * The live cache rows for one change.
 *
 * BOUND: `change_conflicts_open (tenant_id, change_ticket_id) WHERE cleared_at
 * IS NULL` — a partial index over exactly the rows that are still live, so a
 * change that has been re-planned fifty times costs the same as one that never
 * moved.
 */
async function readLiveConflicts(
  tenantId: number,
  ticketIds: readonly number[],
  executor: Executor,
): Promise<Map<number, LiveConflictRow[]>> {
  const out = new Map<number, LiveConflictRow[]>();
  if (ticketIds.length === 0) return out;

  const rows = (await scoped('change_conflicts', tenantId, executor)
    .whereIn('change_conflicts.change_ticket_id', [...ticketIds])
    .whereNull('change_conflicts.cleared_at')
    .select(
      'change_conflicts.id',
      'change_conflicts.change_ticket_id',
      'change_conflicts.digest',
      'change_conflicts.kind',
      'change_conflicts.severity',
      'change_conflicts.other_ticket_id',
      'change_conflicts.freeze_slug',
      'change_conflicts.freeze_version',
      'change_conflicts.queue_slug',
      'change_conflicts.ci_ids',
      'change_conflicts.overlap_start_at',
      'change_conflicts.overlap_end_at',
    )) as unknown as Array<Record<string, unknown>>;

  for (const row of rows) {
    const changeTicketId = num(row.change_ticket_id);
    const entry: LiveConflictRow = {
      id: num(row.id),
      digest: String(row.digest ?? ''),
      kind: String(row.kind) as ChangeConflictKind,
      severity: String(row.severity) as ChangeConflictSeverity,
      otherTicketId:
        row.other_ticket_id === null || row.other_ticket_id === undefined ? null : num(row.other_ticket_id),
      freezeSlug: strOrNull(row.freeze_slug),
      freezeVersion:
        row.freeze_version === null || row.freeze_version === undefined ? null : num(row.freeze_version),
      queueSlug: strOrNull(row.queue_slug),
      ciIds: intArray(row.ci_ids),
      overlapStartAt: toIsoOrNull(row.overlap_start_at),
      overlapEndAt: toIsoOrNull(row.overlap_end_at),
    };
    const list = out.get(changeTicketId);
    if (list) list.push(entry);
    else out.set(changeTicketId, [entry]);
  }

  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — detect(): the planning check
// ═════════════════════════════════════════════════════════════════════════════

export interface ChangeConflictDetection {
  ticketId: number;
  /** CI overlaps and queue saturation. NOT freezes — those are judged apart. */
  conflicts: ChangeConflictClassification[];
  /** Freeze verdicts for the planned window. */
  freezes: ChangeFreezeVerdict[];
  /**
   * ONE PANEL: the conflicts above plus every freeze verdict rendered as a row.
   * This is what is cached and what the drawer renders, so an operator reads a
   * single list. It is safe to hand to `evaluateChangeSchedule` as `conflicts`
   * because that gate applies `acknowledgeableConflicts()`, which drops
   * `freeze_window` — a freeze is OVERRIDDEN, never acknowledged.
   */
  panel: ChangeConflictClassification[];
  policy: ChangePolicyResolution;
  ciIds: number[];
  worstCiCriticality: ChangeCiCriticality | null;
  /**
   * The change's OWN planned window at the moment of detection. Carried because
   * "why did my conflict disappear?" cannot be answered without it: a cleared
   * row has to distinguish "you removed your window" from "they moved theirs".
   */
  window: { startAt: string; endAt: string } | null;
  /** How many counterpart changes were actually judged. */
  evaluated: number;
}

/**
 * Either an unresolved policy (this module resolves it against the change's
 * own facts) or a resolution the caller already made.
 *
 * `change.service` holds a `ChangePolicyResolution` by the time it asks for a
 * scan — it resolved one to decide the gates in the first place — and making it
 * hand that over rather than re-deriving it here means the conflict rows and
 * the schedule gate are keyed off the SAME policy version. Two resolutions of
 * one policy inside one transaction is a way for a decision row to name a
 * version that did not decide.
 */
export type PolicyOption = LoadedChangePolicy | ChangePolicyResolution | null;

function isResolution(policy: PolicyOption | undefined): policy is ChangePolicyResolution {
  return (
    policy !== null &&
    policy !== undefined &&
    typeof (policy as ChangePolicyResolution).policySlug === 'string'
  );
}

export interface DetectOptions {
  /**
   * `planning` — a human is choosing a date. ALWAYS writes
   * `change_conflict_evaluated`, clean result included (HARD RULE 2: silence is
   * never evidence, and "your date is clear" is the answer the scheduler asked
   * for).
   * `sweep` — a cache refresh nobody asked for. Writes NOTHING here; the
   * raise/clear rows and the per-tenant census carry the evidence.
   */
  mode?: 'planning' | 'sweep';
  policy?: PolicyOption;
  freezes?: readonly LoadedChangeFreeze[];
  subject?: ChangeConflictSubject;
  now?: string;
  executor?: Executor;
  trx?: Executor;
}

/**
 * The OBJECT call shape, and why this module accepts two.
 *
 * `change.service` reaches this engine through a call-time `require` behind a
 * STRUCTURAL port — it has to, because a static import would close a
 * module-initialisation cycle — and it calls
 * `run({ tenantId, changeTicketId, window, policy, actor, trx })`. A structural
 * port is not type-checked across the boundary, so a positional-only signature
 * here would compile perfectly, throw `invalid tenant id` at runtime, be caught
 * by that module's `try`, and log "conflict detection failed" forever. That is
 * the previous module's dead-hook defect wearing a different hat, and it is
 * cheaper to accept both shapes than to leave a landmine that only fires in
 * production.
 *
 * `window` is accepted and IGNORED on purpose: the detector re-reads the window
 * from the row it is about to judge, inside the caller's transaction, so it can
 * never disagree with what was actually stored.
 */
export interface ChangeConflictScanInput extends DetectOptions {
  tenantId: number;
  changeTicketId: number;
  /** Accepted for the port's sake; the row is re-read instead. */
  window?: { startAt: string; endAt: string } | null;
  /** Accepted for the port's sake; decision rows stamp `actorType: 'system'`. */
  actor?: unknown;
}

function normalizeScanArgs<O extends DetectOptions>(
  a: number | ChangeConflictScanInput,
  b: number | undefined,
  c: O,
): { tenantId: number; ticketId: number; options: O } {
  if (typeof a === 'number') {
    return { tenantId: a, ticketId: b ?? 0, options: c };
  }
  const { tenantId, changeTicketId, window: _window, actor: _actor, ...rest } = a;
  void _window;
  void _actor;
  return { tenantId, ticketId: changeTicketId, options: rest as unknown as O };
}

/**
 * Judge ONE change against everything else on the desk.
 *
 * Three queries in the worst case (CIs, overlaps, criticality), plus one COUNT
 * when queue saturation is switched on, plus the freeze evaluation which issues
 * no query of its own beyond the cached calendar read. A change with no CI links
 * and no planned window costs a single row read.
 */
export async function detect(
  tenantId: number,
  ticketId: number,
  options?: DetectOptions,
): Promise<ChangeConflictDetection | null>;
export async function detect(
  input: ChangeConflictScanInput,
): Promise<ChangeConflictDetection | null>;
export async function detect(
  a: number | ChangeConflictScanInput,
  b?: number,
  c: DetectOptions = {},
): Promise<ChangeConflictDetection | null> {
  const { tenantId, ticketId, options } = normalizeScanArgs(a, b, c);
  const executor = options.trx ?? options.executor ?? db;
  const mode = options.mode ?? 'planning';
  const nowIso = options.now ?? new Date().toISOString();

  const subject = options.subject ?? (await readChangeSubject(tenantId, ticketId, executor));
  if (!subject) return null;

  const ciIds = await readTouchedCis(tenantId, ticketId, executor);
  const criticality = await readCriticality(tenantId, ciIds, executor);
  const worstCi = worstCriticality(ciIds, criticality);

  // A caller that already resolved the policy hands the RESOLUTION over, so the
  // conflict rows and the gate that will read them name the same version.
  const policy = isResolution(options.policy)
    ? options.policy
    : resolveFor(
        options.policy !== undefined
          ? options.policy
          : await loadChangePolicy(tenantId, undefined, executor),
        subject,
        worstCi,
      );

  const conflicts: ChangeConflictClassification[] = [];
  let evaluated = 0;

  const window =
    subject.plannedStartAt !== null && subject.plannedEndAt !== null
      ? { startAt: subject.plannedStartAt, endAt: subject.plannedEndAt }
      : null;

  // A published policy that switched detection off still resolves, still gates,
  // still selects approvals — it just stops LOOKING. That is a decision the
  // tenant took and can read back, unlike an absent config row (TRAP 2).
  const detectionOn = policy.conflictDetection.enabled;

  if (window !== null && detectionOn) {
    const candidates = await readOverlapCandidates(tenantId, ticketId, ciIds, window, executor);
    evaluated = candidates.length;

    for (const candidate of candidates) {
      const classification = classifyChangeConflict({
        otherTicketId: candidate.otherTicketId,
        window,
        otherWindow: candidate.otherWindow,
        sharedCiIds: candidate.sharedCiIds,
        // The severity of an overlap is the severity of the SHARED item, so the
        // criticality is read over the intersection, not over this change's
        // whole CI list.
        worstCiCriticality: worstCriticality(candidate.sharedCiIds, criticality),
      });
      if (classification) conflicts.push(classification);
    }

    if (policy.conflictDetection.queueSaturationEnabled && subject.queueSlug) {
      const concurrent = await countQueueConcurrency(
        tenantId,
        ticketId,
        subject.queueSlug,
        window,
        executor,
      );
      const saturation = classifyQueueSaturation({
        queueSlug: subject.queueSlug,
        concurrent: concurrent + 1, // this change is one of them
        maxConcurrentPerQueue: policy.conflictDetection.maxConcurrentPerQueue,
      });
      if (saturation) conflicts.push(saturation);
    }
  }

  const freezes = await evaluateFreezes({
    tenantId,
    change: {
      ticketId,
      changeType: subject.changeType,
      risk: subject.risk,
      plannedStartAt: subject.plannedStartAt,
      plannedEndAt: subject.plannedEndAt,
      ticket: subject.ticketFields,
    },
    gate: policy.freezeGate,
    freezes: options.freezes,
    policy,
    // Freezes follow the same volumetric ruling as the conflicts: explained on
    // the planning path, silent on the sweep, where a freeze that actually
    // fires is named on its own `conflictRaised` row instead.
    record: mode === 'planning',
    now: nowIso,
    executor,
    trx: options.trx,
  });

  const panel: ChangeConflictClassification[] = [
    ...conflicts,
    ...freezes.map((verdict) => freezeVerdictToConflict(verdict)),
  ];

  if (mode === 'planning') {
    await withDecision(
      {
        tenantId,
        ticketId,
        subsystem: CHANGE_SUBSYSTEM,
        decision: CHANGE_DECISIONS.conflictEvaluated,
        // HARD RULES 3 and 4 — the policy that set the gates, by slug and
        // published version, so this answer replays after somebody edits it.
        ruleSlug: policy.policySlug,
        ruleVersion: policy.policyVersion,
        actorType: 'system',
        trx: options.trx,
        inputs: {
          window,
          ciIds,
          worstCiCriticality: worstCi,
          changeType: subject.changeType,
          risk: subject.risk,
          queueSlug: subject.queueSlug,
          conflictGate: policy.conflictGate,
          freezeGate: policy.freezeGate,
          detectionEnabled: detectionOn,
          candidatesEvaluated: evaluated,
          at: nowIso,
        },
      },
      (recorder) => {
        if (window === null) {
          recorder.noop('no_planned_window');
          return;
        }
        if (!detectionOn) {
          recorder.noop('detection_disabled');
          return;
        }
        if (panel.length === 0) {
          // THE CLEAN ROW. "We looked at N neighbours over your window and it is
          // clear" is precisely what somebody committing to a date needs on the
          // record, and it is what makes a later collision answerable. HARD
          // RULE 2: silence is never evidence.
          recorder.outcome({ conflicts: 0, freezes: 0, examined: evaluated }).noop('clear');
          return;
        }
        recorder.outcome({
          conflicts: conflicts.length,
          freezes: freezes.length,
          worstSeverity: panel.reduce<ChangeConflictSeverity>(
            (worst, c) => (severityRank(c.severity) > severityRank(worst) ? c.severity : worst),
            'info',
          ),
          others: conflicts.map((c) => c.otherTicketId).filter((id): id is number => id !== null),
          freezeSlugs: freezes.map((f) => f.slug),
        });
      },
    );
  }

  return {
    ticketId,
    conflicts,
    freezes,
    panel,
    policy,
    ciIds,
    worstCiCriticality: worstCi,
    window,
    evaluated,
  };
}

const SEVERITY_RANK: Readonly<Record<ChangeConflictSeverity, number>> = {
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function severityRank(severity: ChangeConflictSeverity): number {
  return SEVERITY_RANK[severity] ?? 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — refresh(): the cache, and the two rows that explain it
// ═════════════════════════════════════════════════════════════════════════════

export interface ChangeConflictRefreshOutcome {
  ticketId: number;
  evaluated: number;
  raised: number;
  cleared: number;
  freezesFired: number;
  /** The live panel after the refresh — what the mutation response returns. */
  conflicts: ChangeConflictClassification[];
  policy: ChangePolicyResolution;
  worstCiCriticality: ChangeCiCriticality | null;
  ciIds: number[];
}

export interface RefreshOptions extends DetectOptions {
  /**
   * Repair the counterpart changes' cache too. Defaults to TRUE on the planning
   * path and FALSE on the sweep, which visits every change anyway.
   *
   * A CI overlap is symmetric, but its two cache rows are not: A's row names B
   * and B's names A. When A moves its window, B's row goes stale — and a stale
   * high-severity row on B is not cosmetic, it is a BLOCKER B's owner cannot
   * clear and cannot explain. One level deep, never recursive, capped at
   * `MAX_MIRROR_REFRESH`; the sweep catches whatever the cap drops.
   */
  mirror?: boolean;
  /** Set by the mirror pass so the repair cannot recurse. */
  mirrorDepth?: number;
}

/**
 * Recompute a change's conflicts and make the cache agree, writing one
 * `decision_log` row per conflict RAISED and per conflict CLEARED, in the same
 * transaction as the cache row each one explains (HARD RULE 2).
 *
 * A conflict that is still there writes no row: it is the same conclusion
 * re-affirmed, recorded on the row it refreshed (`detected_at`), exactly as the
 * problem detector bumps a candidate rather than proposing it again.
 */
export async function refresh(
  tenantId: number,
  ticketId: number,
  options?: RefreshOptions,
): Promise<ChangeConflictRefreshOutcome | null>;
export async function refresh(
  input: ChangeConflictScanInput & { mirror?: boolean },
): Promise<ChangeConflictRefreshOutcome | null>;
export async function refresh(
  a: number | (ChangeConflictScanInput & { mirror?: boolean }),
  b?: number,
  c: RefreshOptions = {},
): Promise<ChangeConflictRefreshOutcome | null> {
  const { tenantId, ticketId, options } = normalizeScanArgs<RefreshOptions>(a, b, c);
  // A caller that did not say defaults to the shape its mode implies: somebody
  // planning a date wants both sides of the overlap left consistent; the sweep
  // is already walking every change and would only do the work twice.
  const mirror = options.mirror ?? (options.mode ?? 'planning') !== 'sweep';

  const run = async (trx: Executor): Promise<ChangeConflictRefreshOutcome | null> => {
    const detection = await detect(tenantId, ticketId, { ...options, trx, executor: trx });
    if (!detection) return null;

    const applied = await applyConflictDiff(tenantId, detection, options.now ?? null, trx);

    // ── The mirror ─────────────────────────────────────────────────────────
    if (mirror && (options.mirrorDepth ?? 0) === 0) {
      const counterparts = new Set<number>();
      for (const id of applied.touchedOthers) counterparts.add(id);
      let repaired = 0;
      for (const other of counterparts) {
        if (repaired >= MAX_MIRROR_REFRESH) {
          logger.info(
            { tenantId, ticketId, cap: MAX_MIRROR_REFRESH },
            'change conflicts: mirror repair capped — the sweep will finish the rest',
          );
          break;
        }
        repaired += 1;
        await refresh(tenantId, other, {
          ...options,
          // The counterpart's own row set is a SWEEP-shaped refresh: nobody
          // asked it a question, so it must not write an evaluation row.
          mode: 'sweep',
          mirror: false,
          mirrorDepth: 1,
          subject: undefined,
          // A RESOLVED policy belongs to the change it was resolved for: the
          // counterpart may be a different type in a different band with a
          // different freeze gate, and judging it on our band would raise
          // conflicts on its record under a policy that never applied to it.
          // A LOADED policy is tenant-level and is correct to pass on.
          policy: isResolution(options.policy) ? undefined : options.policy,
          trx,
          executor: trx,
        });
      }
    }

    return {
      ticketId,
      evaluated: detection.evaluated,
      raised: applied.raised,
      cleared: applied.cleared,
      freezesFired: detection.freezes.length,
      conflicts: detection.panel,
      policy: detection.policy,
      worstCiCriticality: detection.worstCiCriticality,
      ciIds: detection.ciIds,
    };
  };

  if (options.trx) return run(options.trx);
  return db.transaction((trx) => run(trx));
}

interface ConflictDiffResult {
  raised: number;
  cleared: number;
  /** Counterpart ticket ids whose own cache may now disagree. */
  touchedOthers: number[];
}

/**
 * Make `change_conflicts` say what the detector just computed.
 *
 * The UPSERT targets `change_conflicts_live_uq (change_ticket_id, digest) WHERE
 * cleared_at IS NULL`, which is what makes a re-scan idempotent: two sweepers,
 * or a sweeper racing the planning path, converge on one row instead of racing
 * into a duplicate. The digest deliberately EXCLUDES the overlap instants
 * (`changeConflictIdentity` in `@oblidesk/shared` says so): a neighbour nudging
 * their window by ten minutes is the SAME conflict, and re-raising it would
 * stale every acknowledgement on the desk every time anybody touched a date.
 *
 * Conflicts are CLEARED, never deleted. "You are clear now" is a notification,
 * and a notification needs the row it is about to still exist when it is sent.
 */
async function applyConflictDiff(
  tenantId: number,
  detection: ChangeConflictDetection,
  nowIso: string | null,
  trx: Executor,
): Promise<ConflictDiffResult> {
  const ticketId = detection.ticketId;
  const now = nowIso ?? new Date().toISOString();

  const existingByTicket = await readLiveConflicts(tenantId, [ticketId], trx);
  const existing = existingByTicket.get(ticketId) ?? [];
  const existingByDigest = new Map(existing.map((row) => [row.digest, row]));

  const live = detection.panel;
  const liveByDigest = new Map(live.map((c) => [c.digest, c]));

  const touchedOthers = new Set<number>();
  let raised = 0;
  let cleared = 0;

  // ── Raise or refresh ─────────────────────────────────────────────────────
  for (const conflict of live) {
    if (conflict.otherTicketId !== null) touchedOthers.add(conflict.otherTicketId);
    const isNew = !existingByDigest.has(conflict.digest);

    await insertScoped(
      'change_conflicts',
      tenantId,
      {
        change_ticket_id: ticketId,
        kind: conflict.kind,
        severity: conflict.severity,
        other_ticket_id: conflict.otherTicketId,
        freeze_slug: conflict.freezeSlug,
        freeze_version: conflict.freezeVersion,
        queue_slug: conflict.queueSlug,
        ci_ids: JSON.stringify(conflict.ciIds),
        overlap_start_at: conflict.overlapStartAt,
        overlap_end_at: conflict.overlapEndAt,
        detected_at: now,
        cleared_at: null,
        digest: conflict.digest,
      },
      trx,
    )
      // The partial unique index is the conflict target, predicate included —
      // this is `ON CONFLICT (…) WHERE … DO UPDATE`, the index_predicate form.
      .onConflict(trx.raw('(change_ticket_id, digest) WHERE cleared_at IS NULL') as unknown as Knex.Raw)
      .merge({
        severity: conflict.severity,
        ci_ids: JSON.stringify(conflict.ciIds),
        overlap_start_at: conflict.overlapStartAt,
        overlap_end_at: conflict.overlapEndAt,
        detected_at: now,
      });

    if (!isNew) continue;
    raised += 1;

    await withDecision(
      {
        tenantId,
        ticketId,
        subsystem: CHANGE_SUBSYSTEM,
        decision: CHANGE_DECISIONS.conflictRaised,
        // A freeze row names the FREEZE that refused, with its published
        // version, because that is the object somebody will have to override
        // and later justify (HARD RULES 3 and 4). Everything else names the
        // policy whose gates decided it mattered.
        ruleSlug: conflict.freezeSlug ?? detection.policy.policySlug,
        ruleVersion: conflict.freezeSlug ? conflict.freezeVersion : detection.policy.policyVersion,
        actorType: 'system',
        trx,
        inputs: {
          kind: conflict.kind,
          digest: conflict.digest,
          ciIds: conflict.ciIds,
          otherTicketId: conflict.otherTicketId,
          freezeSlug: conflict.freezeSlug,
          queueSlug: conflict.queueSlug,
          window: detection.window,
          overlap: { startAt: conflict.overlapStartAt, endAt: conflict.overlapEndAt },
          worstCiCriticality: conflict.worstCiCriticality,
          at: now,
        },
      },
      (recorder) => {
        recorder.outcome({ severity: conflict.severity, kind: conflict.kind });
      },
    );
  }

  // ── Clear what is no longer true ─────────────────────────────────────────
  const goneOthers = existing
    .filter((row) => !liveByDigest.has(row.digest) && row.otherTicketId !== null)
    .map((row) => row.otherTicketId as number);
  const reasons = await explainClears(tenantId, detection, goneOthers, trx);

  for (const row of existing) {
    if (liveByDigest.has(row.digest)) continue;
    if (row.otherTicketId !== null) touchedOthers.add(row.otherTicketId);

    const updated = (await scoped('change_conflicts', tenantId, trx)
      .where('change_conflicts.id', row.id)
      .whereNull('change_conflicts.cleared_at')
      .update({ cleared_at: now })) as unknown as number;

    // Somebody else cleared it between the read and here. Their transaction
    // wrote the row that explains it; writing a second one would claim this
    // pass did something it did not.
    if (updated === 0) continue;
    cleared += 1;

    const reason = clearReason(row, detection, reasons);
    await withDecision(
      {
        tenantId,
        ticketId,
        subsystem: CHANGE_SUBSYSTEM,
        decision: CHANGE_DECISIONS.conflictCleared,
        ruleSlug: row.freezeSlug ?? detection.policy.policySlug,
        ruleVersion: row.freezeSlug ? row.freezeVersion : detection.policy.policyVersion,
        actorType: 'system',
        trx,
        inputs: {
          kind: row.kind,
          digest: row.digest,
          otherTicketId: row.otherTicketId,
          freezeSlug: row.freezeSlug,
          queueSlug: row.queueSlug,
          ciIds: row.ciIds,
          window: detection.window,
          at: now,
        },
      },
      (recorder) => {
        // THE REASON IS THE POINT OF THIS ROW. "Cleared" on its own leaves "why
        // did my blocker vanish overnight?" unanswerable, which is the same
        // failure as not writing the row at all.
        recorder.outcome({ reason, severity: row.severity, kind: row.kind });
      },
    );
  }

  return { raised, cleared, touchedOthers: [...touchedOthers] };
}

type ClearReason =
  | 'window_cleared'
  | 'window_moved'
  | 'other_change_closed'
  | 'ci_unlinked'
  | 'freeze_no_longer_applies'
  | 'queue_no_longer_saturated'
  | 'detection_disabled';

interface CounterpartState {
  live: boolean;
  window: { startAt: string; endAt: string } | null;
}

/**
 * Why did these overlaps stop being true?
 *
 * ONE query, issued ONLY when something actually cleared, over the counterpart
 * ticket ids that disappeared — a list bounded by `MAX_OTHER_CHANGES`. Without
 * it the cleared row would say "cleared" and nothing else, and "why did my
 * blocker vanish overnight?" would have no answer, which is the same failure as
 * not writing the row at all.
 */
async function explainClears(
  tenantId: number,
  detection: ChangeConflictDetection,
  otherTicketIds: readonly number[],
  trx: Executor,
): Promise<Map<number, CounterpartState>> {
  const out = new Map<number, CounterpartState>();
  if (otherTicketIds.length === 0) return out;

  const rows = (await scoped('changes', tenantId, trx)
    .join('tickets', 'tickets.id', 'changes.ticket_id')
    .where('tickets.tenant_id', tenantId)
    .whereIn('changes.ticket_id', [...new Set(otherTicketIds)])
    .select(
      'changes.ticket_id',
      'changes.planned_start_at',
      'changes.planned_end_at',
      'tickets.status_category',
      'tickets.deleted_at',
    )) as unknown as Array<Record<string, unknown>>;

  for (const row of rows) {
    const startAt = toIsoOrNull(row.planned_start_at);
    const endAt = toIsoOrNull(row.planned_end_at);
    out.set(num(row.ticket_id), {
      live:
        row.deleted_at === null &&
        LIVE_CATEGORIES.includes(toStatusCategory(row.status_category)),
      window: startAt !== null && endAt !== null ? { startAt, endAt } : null,
    });
  }

  return out;
}

/**
 * Which of the four things that can end a conflict actually ended this one.
 *
 * The tests run cheapest-and-most-explanatory first, and every one of them is
 * answered from data already in hand: the detection's own window, and the one
 * bounded counterpart read above.
 */
function clearReason(
  row: LiveConflictRow,
  detection: ChangeConflictDetection,
  counterparts: ReadonlyMap<number, CounterpartState>,
): ClearReason {
  if (row.kind === 'freeze_window') return 'freeze_no_longer_applies';
  if (row.kind === 'queue_saturation') return 'queue_no_longer_saturated';
  if (!detection.policy.conflictDetection.enabled) return 'detection_disabled';

  // Our own window went away, so nothing can overlap it any more. Tested first
  // because it explains every ci_overlap on this change at once and needs no
  // counterpart at all.
  if (detection.window === null) return 'window_cleared';

  const state = row.otherTicketId === null ? undefined : counterparts.get(row.otherTicketId);
  // No counterpart row came back at all: the ticket was hard-deleted or purged.
  if (state === undefined) return 'other_change_closed';
  if (!state.live) return 'other_change_closed';
  if (state.window === null) return 'window_moved';

  // Both sides still exist and both still have windows. The detector has
  // already told us the conflict is gone, so if the windows STILL overlap the
  // only remaining explanation is that the CI link that made them share an item
  // was removed on one side.
  return windowsOverlapHalfOpen(detection.window, state.window) ? 'ci_unlinked' : 'window_moved';
}

/** Half-open `[)`, matching the ranges migration 011 generates. */
function windowsOverlapHalfOpen(
  a: { startAt: string; endAt: string },
  b: { startAt: string; endAt: string },
): boolean {
  const aStart = msOf(a.startAt);
  const aEnd = msOf(a.endAt);
  const bStart = msOf(b.startAt);
  const bEnd = msOf(b.endAt);
  if (aStart === null || aEnd === null || bStart === null || bEnd === null) return false;
  return aStart < bEnd && bStart < aEnd;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — The cached read
// ═════════════════════════════════════════════════════════════════════════════

export interface ListConflictsQuery {
  includeCleared?: boolean;
  /** Narrow the panel. Absent means every kind. */
  kind?: readonly ChangeConflictKind[];
  /** Narrow the panel. Absent means every severity. */
  severity?: readonly ChangeConflictSeverity[];
  limit?: number;
}

/**
 * The panel's read. A CACHE READ, deliberately NOT what the transition gate
 * calls: the gate re-detects, because a gate that trusts a cache is a gate that
 * lets a change through on a five-minute-old picture of the desk.
 *
 * BOUND: `change_conflicts_open (tenant_id, change_ticket_id) WHERE cleared_at
 * IS NULL` for the live read, plus one hydration query for the counterpart
 * tickets and one for the CI names — both over lists the first query already
 * capped.
 */
export async function listConflicts(
  tenantId: number,
  ticketId: number,
  query: ListConflictsQuery = {},
  executor: Executor = db,
): Promise<ChangeConflictView[]> {
  const limit = Math.min(200, Math.max(1, query.limit ?? 100));

  let builder = scoped('change_conflicts', tenantId, executor)
    .where('change_conflicts.change_ticket_id', ticketId)
    .orderBy('change_conflicts.detected_at', 'desc')
    .limit(limit);
  if (query.includeCleared !== true) builder = builder.whereNull('change_conflicts.cleared_at');
  if (query.kind && query.kind.length > 0) {
    builder = builder.whereIn('change_conflicts.kind', [...query.kind]);
  }
  if (query.severity && query.severity.length > 0) {
    builder = builder.whereIn('change_conflicts.severity', [...query.severity]);
  }

  const rows = (await builder.select('change_conflicts.*')) as unknown as Array<Record<string, unknown>>;
  const conflicts = rows.map(mapConflictRow);
  if (conflicts.length === 0) return [];

  const otherIds = [
    ...new Set(conflicts.map((c) => c.otherTicketId).filter((id): id is number => id !== null)),
  ];
  const ciIds = [...new Set(conflicts.flatMap((c) => c.ciIds))];
  const freezeSlugs = [
    ...new Set(conflicts.map((c) => c.freezeSlug).filter((slug): slug is string => slug !== null)),
  ];

  const [others, ciNames, freezes] = await Promise.all([
    otherIds.length === 0
      ? Promise.resolve<Array<Record<string, unknown>>>([])
      : (scoped('changes', tenantId, executor)
          .join('tickets', 'tickets.id', 'changes.ticket_id')
          .where('tickets.tenant_id', tenantId)
          .whereIn('changes.ticket_id', otherIds)
          .select(
            'changes.ticket_id',
            'changes.planned_start_at',
            'changes.planned_end_at',
            'tickets.number',
            'tickets.subject',
            'tickets.assignee_id',
          ) as unknown as Promise<Array<Record<string, unknown>>>),
    ciIds.length === 0
      ? Promise.resolve<Array<Record<string, unknown>>>([])
      : (scoped('cis', tenantId, executor)
          .whereIn('cis.id', ciIds)
          .select('cis.id', 'cis.display_name') as unknown as Promise<Array<Record<string, unknown>>>),
    freezeSlugs.length === 0 ? Promise.resolve<LoadedChangeFreeze[]>([]) : loadChangeFreezes(tenantId, executor),
  ]);

  const otherById = new Map(others.map((row) => [num(row.ticket_id), row]));
  const ciNameById = new Map(ciNames.map((row) => [num(row.id), String(row.display_name ?? '')]));
  const freezeBySlug = new Map(freezes.map((f) => [f.slug.toLowerCase(), f]));

  return conflicts.map((conflict) => {
    const view: ChangeConflictView = { ...conflict };
    const other = conflict.otherTicketId === null ? undefined : otherById.get(conflict.otherTicketId);
    if (other) {
      view.otherNumber = String(other.number ?? '');
      view.otherSubject = String(other.subject ?? '');
      view.otherPlannedStartAt = toIsoOrNull(other.planned_start_at) ?? undefined;
      view.otherPlannedEndAt = toIsoOrNull(other.planned_end_at) ?? undefined;
      view.otherAssigneeId =
        other.assignee_id === null || other.assignee_id === undefined ? undefined : num(other.assignee_id);
    }
    if (conflict.ciIds.length > 0) {
      view.ciNames = conflict.ciIds.map((id) => ciNameById.get(id) ?? `#${id}`);
    }
    if (conflict.freezeSlug) {
      const freeze = freezeBySlug.get(conflict.freezeSlug.toLowerCase());
      if (freeze) {
        view.freezeLabel = freeze.body.label ?? freeze.slug;
        view.freezeReason = freeze.body.reason ?? undefined;
      }
    }
    return view;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — The sweep: one tenant, three queries, in-memory pairing
// ═════════════════════════════════════════════════════════════════════════════

export interface ChangeSweepOutcome extends ChangeConflictScanOutcome {
  /** Changes examined this pass. */
  changes: number;
  pirOverdue: number;
  pirEscalated: number;
  /** Non-null when the conflict half of the pass deliberately did nothing. */
  skipped: 'detection_disabled' | 'policy_unreadable' | null;
}

function emptySweep(startedAt: number): ChangeSweepOutcome {
  return {
    evaluated: 0,
    raised: 0,
    cleared: 0,
    freezesFired: 0,
    durationMs: Date.now() - startedAt,
    changes: 0,
    pirOverdue: 0,
    pirEscalated: 0,
    skipped: null,
  };
}

interface SweepChange {
  subject: ChangeConflictSubject;
  ciIds: number[];
  window: { startAt: string; endAt: string };
}

/**
 * One tenant's pass: refresh the conflict cache, then look for overdue PIRs.
 *
 * TWO JOBS, ONE TICK, on purpose. Both are five-minute questions over the same
 * `changes` table; giving the PIR scan its own worker would mean an eighth
 * timer, an eighth leader-lock consumer and an eighth thing to remember to stop
 * on shutdown, in exchange for nothing.
 *
 * THE CONFLICT HALF'S BOUND, end to end:
 *   query 1  the changes whose PLANNED WINDOW intersects [now − 1 day, now +
 *            lookahead], soonest first, `LIMIT MAX_CHANGES_PER_PASS`. The
 *            predicate is on the generated range so a long change that started
 *            last week is still caught; ordering by `planned_start_at` lets the
 *            planner use `changes_board (tenant_id, planned_start_at)` and the
 *            LIMIT stops the scan there.
 *   query 2  every `ticket_cis` row for exactly that set of tickets.
 *   query 3  the criticality of exactly those CIs.
 *   query 4  every LIVE cache row for exactly that set of changes.
 * Then the pairing is IN MEMORY: bucket by ci id, pair within the bucket,
 * capped at `MAX_PAIR_EVALUATIONS`. No changes×changes join is ever issued, and
 * the only writes are for changes whose set actually differs — the steady state
 * of this pass is four reads and nothing else.
 */
export async function runForTenant(
  tenantId: number,
  options: { now?: Date; executor?: Executor } = {},
): Promise<ChangeSweepOutcome> {
  const startedAt = Date.now();
  const executor = options.executor ?? db;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const outcome = emptySweep(startedAt);

  const policyLoaded = await loadChangePolicy(tenantId, undefined, executor);

  // The PIR half runs whatever the policy says about conflicts, and even when
  // the policy body is unreadable: `pir_due_at` is already ON the row, computed
  // when the outcome was recorded, so "is this review late?" needs no config at
  // all. Only the ESCALATION needs a ladder slug, and it simply does not happen
  // without one.
  const pir = await sweepOverduePirs(tenantId, policyLoaded, now, executor);
  outcome.pirOverdue = pir.overdue;
  outcome.pirEscalated = pir.escalated;

  if (policyLoaded === null) {
    outcome.skipped = 'policy_unreadable';
    outcome.durationMs = Date.now() - startedAt;
    return outcome;
  }

  // TRAP 2, stated one more time where it bites: `published === false` means
  // the tenant never opened the screen, and that tenant is swept on the shipped
  // baseline. The ONLY exclusion is an explicitly published `enabled: false`.
  if (policyLoaded.published && policyLoaded.body.conflictDetection.enabled === false) {
    outcome.skipped = 'detection_disabled';
    outcome.durationMs = Date.now() - startedAt;
    return outcome;
  }

  const lookaheadMs = policyLoaded.body.conflictDetection.lookaheadDays * 86_400_000;
  const from = new Date(now.getTime() - SWEEP_LOOKBEHIND_MS).toISOString();
  const to = new Date(now.getTime() + lookaheadMs).toISOString();

  // ── Query 1: the window ──────────────────────────────────────────────────
  const changeRows = (await scoped('changes', tenantId, executor)
    .join('tickets', 'tickets.id', 'changes.ticket_id')
    .where('tickets.tenant_id', tenantId)
    .whereNull('tickets.deleted_at')
    .whereIn('tickets.status_category', LIVE_CATEGORIES)
    .whereRaw("changes.planned_window && tstzrange(?, ?, '[)')", [from, to])
    .orderBy('changes.planned_start_at', 'asc')
    .limit(MAX_CHANGES_PER_PASS)
    .select(...CHANGE_COLUMNS, ...TICKET_COLUMNS)) as unknown as Array<Record<string, unknown>>;

  const subjects = changeRows.map(mapSubject);
  outcome.changes = subjects.length;
  if (subjects.length === 0) {
    outcome.durationMs = Date.now() - startedAt;
    return outcome;
  }

  const ticketIds = subjects.map((s) => s.ticketId);

  // ── Query 2: every touched CI for exactly that set ───────────────────────
  const ciRows = (await scoped('ticket_cis', tenantId, executor)
    .whereIn('ticket_cis.ticket_id', ticketIds)
    .whereIn('ticket_cis.role', TOUCHING_ROLES)
    .select('ticket_cis.ticket_id', 'ticket_cis.ci_id')) as unknown as Array<Record<string, unknown>>;

  const ciIdsByTicket = new Map<number, number[]>();
  const ticketsByCi = new Map<number, number[]>();
  for (const row of ciRows) {
    const ticketId = num(row.ticket_id);
    const ciId = num(row.ci_id);
    if (ticketId <= 0 || ciId <= 0) continue;

    const owned = ciIdsByTicket.get(ticketId);
    if (owned) {
      if (owned.length < MAX_CIS_PER_CHANGE && !owned.includes(ciId)) owned.push(ciId);
    } else {
      ciIdsByTicket.set(ticketId, [ciId]);
    }

    const holders = ticketsByCi.get(ciId);
    if (holders) holders.push(ticketId);
    else ticketsByCi.set(ciId, [ticketId]);
  }

  // ── Query 3: criticality of exactly those CIs ────────────────────────────
  const allCiIds = [...ticketsByCi.keys()];
  const criticality = await readCriticality(tenantId, allCiIds, executor);

  // ── Query 4: the live cache for exactly those changes ────────────────────
  const liveByTicket = await readLiveConflicts(tenantId, ticketIds, executor);

  // ── The pairing, in memory ───────────────────────────────────────────────
  const sweepChanges = new Map<number, SweepChange>();
  for (const subject of subjects) {
    if (subject.plannedStartAt === null || subject.plannedEndAt === null) continue;
    sweepChanges.set(subject.ticketId, {
      subject,
      ciIds: ciIdsByTicket.get(subject.ticketId) ?? [],
      window: { startAt: subject.plannedStartAt, endAt: subject.plannedEndAt },
    });
  }

  /** ticketId → (otherTicketId → shared ci ids). */
  const sharedByTicket = new Map<number, Map<number, number[]>>();
  let pairs = 0;
  let pairCapHit = false;

  for (const [ciId, holders] of ticketsByCi) {
    const live = holders.filter((id) => sweepChanges.has(id));
    if (live.length < 2) continue;
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        if (pairs >= MAX_PAIR_EVALUATIONS) {
          pairCapHit = true;
          break;
        }
        pairs += 1;
        const a = live[i];
        const b = live[j];
        if (a === b) continue;
        recordShared(sharedByTicket, a, b, ciId);
        recordShared(sharedByTicket, b, a, ciId);
      }
      if (pairCapHit) break;
    }
    if (pairCapHit) break;
  }
  if (pairCapHit) {
    logger.warn(
      { tenantId, cap: MAX_PAIR_EVALUATIONS },
      'change conflicts: pair budget exhausted — some overlaps were not judged this pass',
    );
  }

  // Queue concurrency, also in memory: how many of THIS pass's changes share a
  // queue and a window. The tenant-wide read already has every one of them, so
  // the per-change COUNT query never runs on the sweep path.
  const queueConcurrency = countQueueConcurrencyInMemory(sweepChanges);

  const freezes = await loadChangeFreezes(tenantId, executor);

  // ── The writes, only where the set actually differs ──────────────────────
  for (const [ticketId, change] of sweepChanges) {
    const policy = resolveFor(
      policyLoaded,
      change.subject,
      worstCriticality(change.ciIds, criticality),
    );

    const conflicts: ChangeConflictClassification[] = [];
    const shared = sharedByTicket.get(ticketId);
    if (shared) {
      let kept = 0;
      for (const [otherTicketId, sharedCiIds] of shared) {
        if (kept >= MAX_OTHER_CHANGES) break;
        const other = sweepChanges.get(otherTicketId);
        if (!other) continue;
        const classification = classifyChangeConflict({
          otherTicketId,
          window: change.window,
          otherWindow: other.window,
          sharedCiIds,
          worstCiCriticality: worstCriticality(sharedCiIds, criticality),
        });
        if (classification) {
          conflicts.push(classification);
          kept += 1;
        }
      }
    }

    if (policy.conflictDetection.queueSaturationEnabled && change.subject.queueSlug) {
      const saturation = classifyQueueSaturation({
        queueSlug: change.subject.queueSlug,
        concurrent: queueConcurrency.get(ticketId) ?? 1,
        maxConcurrentPerQueue: policy.conflictDetection.maxConcurrentPerQueue,
      });
      if (saturation) conflicts.push(saturation);
    }

    const verdicts = await evaluateFreezes({
      tenantId,
      change: {
        ticketId,
        changeType: change.subject.changeType,
        risk: change.subject.risk,
        plannedStartAt: change.subject.plannedStartAt,
        plannedEndAt: change.subject.plannedEndAt,
        ticket: change.subject.ticketFields,
      },
      gate: policy.freezeGate,
      freezes,
      policy,
      // The sweep explains what CHANGED, never what it merely looked at.
      record: false,
      now: nowIso,
      executor,
    });

    const detection: ChangeConflictDetection = {
      ticketId,
      conflicts,
      freezes: verdicts,
      panel: [...conflicts, ...verdicts.map((v) => freezeVerdictToConflict(v))],
      policy,
      ciIds: change.ciIds,
      worstCiCriticality: worstCriticality(change.ciIds, criticality),
      window: change.window,
      evaluated: shared ? shared.size : 0,
    };

    outcome.evaluated += detection.evaluated;
    outcome.freezesFired += verdicts.length;

    // The cheap pre-check that keeps the steady state at four reads: if the
    // digests already agree, there is nothing to write and no transaction to
    // open. The authoritative comparison still happens inside the transaction.
    const existing = liveByTicket.get(ticketId) ?? [];
    if (!setsDiffer(existing, detection.panel)) continue;

    try {
      const applied = await db.transaction((trx) =>
        applyConflictDiff(tenantId, detection, nowIso, trx),
      );
      outcome.raised += applied.raised;
      outcome.cleared += applied.cleared;
    } catch (error) {
      // One change's bad row must not stop the pass for the rest of the desk.
      logger.error(
        { tenantId, ticketId, err: (error as Error).message },
        'change conflicts: refresh failed for one change — the pass continues',
      );
    }
  }

  outcome.durationMs = Date.now() - startedAt;

  // ── The census (HARD RULE 2, volumetrically) ─────────────────────────────
  // Written ONLY when something actually changed. This is deliberately unlike
  // `problem_detection_run`, which logs every pass: that detector's job is to
  // PROPOSE, so a pass that proposed nothing is still a judgement. This one's
  // job is to MAINTAIN A CACHE, and a refresh with no diff took no action and
  // has nothing to explain. One row per tenant every five minutes, forever,
  // would bury the raise and clear rows that do.
  if (outcome.raised + outcome.cleared > 0) {
    await withDecision(
      {
        tenantId,
        ticketId: null,
        subsystem: CHANGE_SUBSYSTEM,
        decision: CHANGE_DECISIONS.conflictScan,
        ruleSlug: policyLoaded.published ? policyLoaded.slug : CHANGE_POLICY_DEFAULT_SLUG,
        ruleVersion: policyLoaded.published ? policyLoaded.version : 0,
        actorType: 'system',
        inputs: {
          window: { from, to },
          changesExamined: outcome.changes,
          lookaheadDays: policyLoaded.body.conflictDetection.lookaheadDays,
          at: nowIso,
        },
      },
      (recorder) => {
        // The shape `ChangeConflictScanOutcome` declares in @oblidesk/shared, so
        // the Why drawer can render this census without re-deriving anything.
        const census: ChangeConflictScanOutcome = {
          evaluated: outcome.evaluated,
          raised: outcome.raised,
          cleared: outcome.cleared,
          freezesFired: outcome.freezesFired,
          durationMs: outcome.durationMs,
        };
        recorder.outcome({ ...census });
      },
    );
  }

  return outcome;
}

function recordShared(
  index: Map<number, Map<number, number[]>>,
  ticketId: number,
  otherTicketId: number,
  ciId: number,
): void {
  let byOther = index.get(ticketId);
  if (!byOther) {
    byOther = new Map<number, number[]>();
    index.set(ticketId, byOther);
  }
  const list = byOther.get(otherTicketId);
  if (list) {
    if (!list.includes(ciId)) list.push(ciId);
  } else {
    byOther.set(otherTicketId, [ciId]);
  }
}

/**
 * Concurrency PER CHANGE: how many changes on the same queue, this change
 * included, have a window overlapping its own.
 *
 * Measured per change rather than as one peak per queue on purpose. A queue's
 * busiest hour is not a fact about a change scheduled a fortnight later, and
 * telling that change it is saturated is precisely the kind of row that
 * teaches people to close the panel.
 *
 * This is the SAME measure `countQueueConcurrency` takes with a COUNT on the
 * single-change path; the two paths must not answer differently for one change.
 * O(n²) over one queue's changes, bounded by `MAX_CHANGES_PER_PASS`.
 */
function countQueueConcurrencyInMemory(
  changes: ReadonlyMap<number, SweepChange>,
): Map<number, number> {
  const byQueue = new Map<string, SweepChange[]>();
  for (const change of changes.values()) {
    const queueSlug = change.subject.queueSlug;
    if (!queueSlug) continue;
    const key = queueSlug.toLowerCase();
    const list = byQueue.get(key);
    if (list) list.push(change);
    else byQueue.set(key, [change]);
  }

  const out = new Map<number, number>();
  for (const list of byQueue.values()) {
    for (const probe of list) {
      let concurrent = 0;
      for (const other of list) {
        // Half-open `[)`, matching the generated ranges: back-to-back windows
        // are not concurrent. `other === probe` counts itself, which is why the
        // query path adds one to its COUNT of the others.
        if (windowsOverlapHalfOpen(probe.window, other.window)) concurrent += 1;
      }
      out.set(probe.subject.ticketId, concurrent);
    }
  }
  return out;
}

/** Cheap digest-set comparison, so an unchanged change opens no transaction. */
function setsDiffer(
  existing: readonly LiveConflictRow[],
  live: readonly ChangeConflictClassification[],
): boolean {
  if (existing.length !== live.length) return true;
  const have = new Set(existing.map((row) => row.digest));
  for (const conflict of live) {
    if (!have.has(conflict.digest)) return true;
  }
  // Same identities, but a severity or an overlap instant may still have moved.
  // Those are refreshed in place with no decision row, so a difference here is
  // still worth the (cheap) upsert.
  const bySeverity = new Map(existing.map((row) => [row.digest, row]));
  for (const conflict of live) {
    const row = bySeverity.get(conflict.digest);
    if (!row) return true;
    if (row.severity !== conflict.severity) return true;
    if (row.overlapStartAt !== conflict.overlapStartAt) return true;
    if (row.overlapEndAt !== conflict.overlapEndAt) return true;
  }
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — The other half of the tick: overdue post-implementation reviews
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Stamp the PIRs that have gone past their due date, once each.
 *
 * A PIR HAS NO CLOCK, and that is the design, not an omission: `pir_due_at` was
 * computed ONCE by `changeService.recordOutcome` on the policy's calendar, and
 * the question here is a COMPARISON against it. A freeze and a PIR have no
 * pause, no breach and no ledger; the day somebody wants a countdown, that is
 * an `sla` object and a different question.
 *
 * BOUND: one read down `changes_pir_due (tenant_id, pir_due_at) WHERE
 * pir_required AND pir_completed_at IS NULL` — a partial index over exactly the
 * rows that can be late — capped at `MAX_PIR_PER_PASS`.
 *
 * IDEMPOTENCE: `pir_overdue_notified_at` is stamped by an UPDATE guarded on it
 * still being NULL, and the decision row is written only when that UPDATE
 * touched a row. Two replicas, or a retried pass, therefore produce ONE row.
 * The stamp deliberately does NOT bump `changes.row_version`: a sweeper writing
 * a notification marker must not 409 the form an operator has open (HARD RULE 7
 * guards what humans edit, and no form posts this column).
 */
async function sweepOverduePirs(
  tenantId: number,
  policyLoaded: LoadedChangePolicy | null,
  now: Date,
  executor: Executor,
): Promise<{ overdue: number; escalated: number }> {
  const nowIso = now.toISOString();

  const rows = (await scoped('changes', tenantId, executor)
    .where('changes.pir_required', true)
    .whereNull('changes.pir_completed_at')
    .whereNull('changes.pir_overdue_notified_at')
    .whereNotNull('changes.pir_due_at')
    .where('changes.pir_due_at', '<=', nowIso)
    .orderBy('changes.pir_due_at', 'asc')
    .limit(MAX_PIR_PER_PASS)
    .select(
      'changes.ticket_id',
      'changes.change_type',
      'changes.risk',
      'changes.outcome',
      'changes.major',
      'changes.pir_due_at',
    )) as unknown as Array<Record<string, unknown>>;

  let overdue = 0;
  let escalated = 0;

  for (const row of rows) {
    const ticketId = num(row.ticket_id);
    const changeType = toChangeType(row.change_type);
    const risk = toChangeRisk(row.risk);
    const dueAt = toIsoOrNull(row.pir_due_at);
    if (ticketId <= 0 || dueAt === null) continue;

    const policy = resolveFor(policyLoaded, { changeType, risk, queueSlug: null }, null);

    // Sanity, not paranoia: `pir_required` is a stored column and `isPirOwed`
    // is the live rule. If they disagree the stored column wins — it is what
    // the CHECK constraint and the closure gate read — but the row says so, so
    // a policy edit that changed the answer is visible instead of mysterious.
    const stillOwed = isPirOwed({
      changeType,
      outcome: toChangeOutcome(row.outcome),
      major: row.major === true,
      pirRequired: policy.pirRequired,
    });

    try {
      const armed = await db.transaction(async (trx) => {
        const updated = (await scoped('changes', tenantId, trx)
          .where('changes.ticket_id', ticketId)
          .whereNull('changes.pir_overdue_notified_at')
          .whereNull('changes.pir_completed_at')
          .update({ pir_overdue_notified_at: nowIso, updated_at: nowIso })) as unknown as number;

        // Another replica, or an earlier pass, got there first. Their
        // transaction wrote the row that explains it.
        if (updated === 0) return false;

        // ── The escalation ────────────────────────────────────────────────
        // Armed HERE, inside the same guarded UPDATE that makes this branch
        // run exactly once, which is what makes the arming idempotent without
        // a `pir_escalated_at` column. The LADDER owns the wait: the anchor is
        // the instant the policy says escalation is due, and the ladder's own
        // step offsets run from it. That is what escalation ladders are for,
        // and re-implementing the delay here would be a second timer wheel.
        let armedLadder: string | null = null;
        let armReason: string | null = null;

        if (policy.escalationSlug) {
          const escalateAt =
            policy.pirEscalateAfterBusinessMinutes > 0
              ? await addBusinessMinutesOn(
                  tenantId,
                  policy.calendarSlug,
                  dueAt,
                  policy.pirEscalateAfterBusinessMinutes,
                  trx,
                )
              : dueAt;

          const ladder = await loadLadder(tenantId, policy.escalationSlug, trx);
          if (!ladder) {
            armReason = 'ladder_missing';
          } else {
            // `EscalationTrigger` has no `pir_overdue` member, and adding one
            // is escalation.service's file, not this one. The POLICY naming
            // the ladder is the trigger — the same argument that lets the
            // approval selection start its definitions with `force: true` —
            // so the ladder is armed on the trigger it declares, and the real
            // cause is stamped in `context` where the Why drawer reads it.
            const result = await armEscalation({
              tenantId,
              ticketId,
              ladderSlug: ladder.slug,
              trigger: ladder.trigger,
              occurrenceKey: `change_pir_overdue:${ticketId}`,
              anchorAt: escalateAt,
              context: {
                cause: 'change_pir_overdue',
                pirDueAt: dueAt,
                escalateAt,
                changeType,
                risk,
              },
              actorType: 'system',
              trx,
            });
            armedLadder = result.armed ? ladder.slug : null;
            armReason = result.armed ? null : result.reason;
          }
        }

        await withDecision(
          {
            tenantId,
            ticketId,
            subsystem: CHANGE_SUBSYSTEM,
            decision: CHANGE_DECISIONS.pirOverdue,
            ruleSlug: policy.policySlug,
            ruleVersion: policy.policyVersion,
            actorType: 'system',
            trx,
            inputs: {
              pirDueAt: dueAt,
              changeType,
              risk,
              outcome: strOrNull(row.outcome),
              major: row.major === true,
              pirRequiredByPolicy: policy.pirRequired,
              stillOwedByPolicy: stillOwed,
              at: nowIso,
            },
          },
          (recorder) => {
            recorder.outcome({
              overdue: true,
              // Named whichever way it went, INCLUDING the refusals. "Nothing
              // escalated" is a fact somebody will ask about at 09:00 the
              // morning after, and it has to have an answer here.
              escalation: armedLadder ?? armReason ?? 'no_ladder_configured',
            });
          },
        );

        if (armedLadder !== null) {
          await withDecision(
            {
              tenantId,
              ticketId,
              subsystem: CHANGE_SUBSYSTEM,
              decision: CHANGE_DECISIONS.pirEscalated,
              // HARD RULE 3 — the ladder that was started, by slug.
              ruleSlug: armedLadder,
              actorType: 'system',
              trx,
              inputs: { cause: 'change_pir_overdue', pirDueAt: dueAt, at: nowIso },
            },
            (recorder) => {
              recorder.outcome({ ladderSlug: armedLadder });
            },
          );
        }

        return armedLadder !== null;
      });

      overdue += 1;
      if (armed) escalated += 1;
    } catch (error) {
      logger.error(
        { tenantId, ticketId, err: (error as Error).message },
        'change PIR sweep: failed for one change — the pass continues',
      );
    }
  }

  return { overdue, escalated };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — The sweeper
// ═════════════════════════════════════════════════════════════════════════════

let timer: NodeJS.Timeout | null = null;
let running = false;
let stopRequested = false;
let inFlight: Promise<unknown> | null = null;

/**
 * Every tenant, every pass.
 *
 * `tenants` is a global table, so `db('tenants')` is correct here — the same
 * enumeration `rollup.service`, `sla.service` and `problemDetection.service`
 * use. Every read after this line is scoped to one tenant.
 *
 * THERE IS NO CONFIG FILTER ON THIS LOOP, and that is the point (TRAP 2). A
 * tenant that never published a `change_policy` is swept on the shipped
 * baseline; `runForTenant` is the only place that may decline, and the only
 * thing it declines for is an explicitly published `enabled: false`.
 */
export async function runAllTenants(
  options: { now?: Date } = {},
): Promise<Map<number, ChangeSweepOutcome>> {
  const results = new Map<number, ChangeSweepOutcome>();
  const tenants = (await db('tenants').select('id').orderBy('id')) as Array<{ id: number }>;

  for (const tenant of tenants) {
    if (stopRequested) break;
    const tenantId = Number(tenant.id);
    try {
      const outcome = await runForTenant(tenantId, { now: options.now });
      results.set(tenantId, outcome);

      if (outcome.raised + outcome.cleared + outcome.pirOverdue > 0) {
        logger.info({ tenantId, ...outcome }, 'change conflicts: pass');
      }
    } catch (error) {
      // One tenant's bad data must never stop the sweep for the others: a
      // conflict panel that goes stale for every desk because one of them has a
      // broken calendar is a worse failure than the one it was avoiding.
      logger.error(
        { tenantId, err: (error as Error).message },
        'change conflicts: pass failed for one tenant',
      );
    }
  }

  return results;
}

/**
 * The worker, shaped like `problemDetectionSweeper` so `index.ts` can start it
 * behind the same advisory leader lock with the same three lines.
 *
 * ONE per cluster. Two would not create duplicate cache rows —
 * `change_conflicts_live_uq` makes that impossible — but they would race each
 * other into the unique violation on every pass, and worse, both would stamp
 * `pir_overdue_notified_at` and one of them would write a decision row for a
 * notification the other one sent.
 *
 * `setTimeout` chained after each pass rather than `setInterval`, so a pass
 * slower than the period never overlaps the next one.
 */
export const changeConflictSweeper = {
  start(options: { intervalMs?: number } = {}): void {
    if (running) return;

    const intervalMs = Math.max(MIN_SWEEP_INTERVAL_MS, options.intervalMs ?? SWEEP_INTERVAL_MS);
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
            'change conflicts: sweep failed — the sweeper continues',
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

    // The first pass waits a full period. A desk restarting is the worst moment
    // to add a tenant-wide window scan to the load, and five minutes of delay
    // costs a cache whose freshness is measured in five minutes nothing.
    timer = setTimeout(() => void loop(), intervalMs);
    timer.unref?.();

    logger.info({ intervalMs }, 'change conflicts: sweeper started');
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
    logger.info('change conflicts: sweeper stopped');
  },

  isRunning(): boolean {
    return running;
  },

  tick: runAllTenants,
};

/** The names `index.ts` starts and stops. Thin wrappers, both spellings honest. */
export function startSweeper(): void {
  changeConflictSweeper.start();
}

export function stopSweeper(): void {
  void changeConflictSweeper.stop();
}

// ═════════════════════════════════════════════════════════════════════════════
// Barrel
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `list` is the name the routes call; `listConflicts` is the name this module
 * reads best under. Same function, both spellings honest — the same courtesy
 * `problemDetection.service` extends to `startSweeper` / `sweeper.start`.
 */
export const list = listConflicts;

export const changeConflictService = {
  detect,
  refresh,
  list,
  listConflicts,
  loadChangePolicy,
  loadChangeFreezes,
  evaluateFreezes,
  evaluateFreezesForChange,
  runForTenant,
  runAllTenants,
  startSweeper,
  stopSweeper,
  sweeper: changeConflictSweeper,
};

export default changeConflictService;
