// ─────────────────────────────────────────────────────────────────────────────
// Change management — vocabulary, DTOs and the evaluators BOTH sides run.
//
// HARD RULE 12 is the reason this file exists rather than living in the server.
// Every gate in this module is ONE function with TWO callers: the client calls
// it to grey out a button and list exactly what is missing; the server calls the
// same function to refuse the request and to name the same reasons in the 422
// body and in `decision_log`. A second implementation on the client is a second
// opinion, and a second opinion is a bug that only shows up in front of a
// customer.
//
// What is NOT here, deliberately:
//
//   • a `change_status` enum. A change's lifecycle IS `tickets.status_category`
//     (HARD RULE 5). `change_type`, `risk` and `outcome` are ORTHOGONAL axes,
//     and the missing `implementing` category is DERIVED from the data rather
//     than named as a ninth word — see `isImplementing`. This is the same trap
//     `problems` refused when it declined a `problem_status`.
//
//   • any SQL. The overlap query, the freeze calendar bands and the approval
//     rows belong to the server; what crosses is the READING each of them
//     produced, so the verdict is computed once and the client can explain a
//     refusal without re-querying.
//
//   • any clock. A freeze window and a PIR due date have no pause, no breach
//     and no ledger. They are a boolean and a comparison, computed against the
//     EXISTING calendar service. The day somebody asks for "business minutes
//     remaining in the freeze", the answer is that this is an `sla` object and
//     a different question — two timer wheels that disagree is a support case
//     nobody can reason about.
//
//   • any zod schema. This package has no zod dependency and the repo keeps its
//     request schemas in `server/src/validators/*`. The literal tuples below are
//     what those schemas and migration 011's CHECKs must mirror, so a drift is a
//     compile error in one file instead of a 23514 at runtime.
//
// This module is exported BEFORE ./types in the barrel, for the same reason
// ./problem is: it declares its own slim `ChangeTicketHeader` rather than
// importing `Ticket`, so the shared evaluators stay importable from the client
// without dragging the whole DTO surface behind them.
// ─────────────────────────────────────────────────────────────────────────────

import { type Capability, CAPABILITIES, hasCapability } from './capabilities';
import type {
  ChangeFreezeBody,
  ChangeGateMode,
  ChangePirRequirement,
  ChangePolicyBody,
  ChangeRisk,
  ChangeRiskMatrixKey,
  ChangeType,
  FailureLikelihood,
  ImpactLevel,
} from './configKinds';
import type { StatusCategory } from './statusCategories';

// ═════════════════════════════════════════════════════════════════════════════
// Vocabulary — every tuple mirrors a CHECK constraint in migration 011
// ═════════════════════════════════════════════════════════════════════════════
//
// `CHANGE_TYPES`, `CHANGE_RISKS`, `FAILURE_LIKELIHOODS`, `CHANGE_GATE_MODES`
// and `CHANGE_PIR_REQUIREMENTS` are declared in ./configKinds, beside
// `IMPACT_LEVELS`, because the three change config bodies are typed through
// them and ./configKinds may not import this file. Import them from
// '@oblidesk/shared' like anything else — the barrel re-exports both modules.

/**
 * `changes.outcome`.
 *
 * `successful_with_issues` earns its slot: a change that worked but overran, or
 * needed an unplanned step, is neither a success nor a failure. A desk forced
 * to pick one of the two produces a change failure rate that is either
 * flattering or hysterical, and both make the only metric that tells you
 * whether your CAB does anything useless.
 */
export const CHANGE_OUTCOMES = [
  'successful',
  'successful_with_issues',
  'failed',
  'rolled_back',
] as const;
export type ChangeOutcome = (typeof CHANGE_OUTCOMES)[number];

/** Outcomes that arm a post-implementation review whatever the band says. */
export const CHANGE_FAILURE_OUTCOMES: readonly ChangeOutcome[] = ['failed', 'rolled_back'];

/**
 * `change_conflicts.kind`.
 *
 *   ci_overlap        THE conflict: two changes touching the same CI with
 *                     overlapping planned windows.
 *   freeze_window     a `change_freeze` object fired on this window. Modelled
 *                     as a conflict row on purpose, so the operator reads ONE
 *                     panel with one vocabulary instead of two panels that
 *                     disagree about what is wrong with their date.
 *   queue_saturation  a CAPACITY signal, never blocking, off by default. It
 *                     gets a different word deliberately: calling a capacity
 *                     warning a "conflict" devalues the word for the case that
 *                     actually causes an outage.
 *
 * `lead_time` is deliberately absent. It is true or false at one instant rather
 * than standing, it has none of the three targets migration 011's CHECK
 * demands, and it is a transition blocker instead.
 */
export const CHANGE_CONFLICT_KINDS = ['ci_overlap', 'freeze_window', 'queue_saturation'] as const;
export type ChangeConflictKind = (typeof CHANGE_CONFLICT_KINDS)[number];

export const CHANGE_CONFLICT_SEVERITIES = ['high', 'medium', 'low', 'info'] as const;
export type ChangeConflictSeverity = (typeof CHANGE_CONFLICT_SEVERITIES)[number];

/**
 * Criticality of a linked CI, as `cis.criticality` stores it. NULL is a real
 * answer and not a gap: the alert spine writes NULL for "we do not know", and
 * inventing `medium` there would be the confident wrong answer.
 *
 * Spelled out here rather than imported from ./types so this module stays a
 * leaf of the DTO graph (see the header). It is structurally identical to
 * `CiCriticality`, so values pass in both directions with no cast.
 */
export type ChangeCiCriticality = 'critical' | 'high' | 'medium' | 'low';

/**
 * Every reason a change gate can refuse. Stable machine codes: they are what
 * `decision_log.outputs` names, what the 422 body carries and what the client
 * keys its help text off. Never shown to a user — each blocker carries its own
 * `t(key, fallback)` pair for that.
 */
export const CHANGE_BLOCKER_CODES = [
  'change_model_required',
  'change_plan_implementation_missing',
  'change_plan_test_missing',
  'change_plan_backout_missing',
  'change_backout_waiver_reason_missing',
  'change_backout_waiver_not_allowed',
  'change_window_missing',
  'change_window_inverted',
  'change_window_in_past',
  'change_lead_time_short',
  'change_conflict_unacknowledged',
  'change_conflict_ack_stale',
  'change_freeze_active',
  'change_freeze_override_forbidden',
  'change_freeze_override_reason_missing',
  'change_freeze_override_approval_pending',
  'change_approval_pending',
  /** The policy selected an approval that was never requested. */
  'change_approval_missing',
  'change_approval_rejected',
  'change_implementation_open',
  'change_outcome_missing',
  'change_pir_outstanding',
  'change_pir_findings_missing',
  'change_pir_incident_answer_missing',
  'change_pir_incident_link_missing',
] as const;
export type ChangeBlockerCode = (typeof CHANGE_BLOCKER_CODES)[number];

/** Why `computeChangeRisk` raised the band above what the matrix said. */
export const CHANGE_RISK_FLOORS = ['no_backout_plan', 'critical_ci'] as const;
export type ChangeRiskFloor = (typeof CHANGE_RISK_FLOORS)[number];

/** Why an approval slug ended up on a change. Printed in the decision row. */
export const CHANGE_APPROVAL_REASONS = ['type', 'risk_band', 'ci_criticality', 'queue'] as const;
export type ChangeApprovalReason = (typeof CHANGE_APPROVAL_REASONS)[number];

// ═════════════════════════════════════════════════════════════════════════════
// Labels — HARD RULE 10: every one is a t(key, fallback) pair, so a missing key
// degrades to readable English and never to a raw key.
// ═════════════════════════════════════════════════════════════════════════════

export interface LocalizedLabelSpec {
  key: string;
  fallback: string;
}

export const CHANGE_TYPE_LABELS: Readonly<Record<ChangeType, LocalizedLabelSpec>> = {
  standard: { key: 'change.type.standard', fallback: 'Standard' },
  normal: { key: 'change.type.normal', fallback: 'Normal' },
  emergency: { key: 'change.type.emergency', fallback: 'Emergency' },
};

export const CHANGE_RISK_LABELS: Readonly<Record<ChangeRisk, LocalizedLabelSpec>> = {
  high: { key: 'change.risk.high', fallback: 'High risk' },
  medium: { key: 'change.risk.medium', fallback: 'Medium risk' },
  low: { key: 'change.risk.low', fallback: 'Low risk' },
};

export const FAILURE_LIKELIHOOD_LABELS: Readonly<Record<FailureLikelihood, LocalizedLabelSpec>> = {
  high: { key: 'change.likelihood.high', fallback: 'Likely to fail' },
  medium: { key: 'change.likelihood.medium', fallback: 'Could fail' },
  low: { key: 'change.likelihood.low', fallback: 'Unlikely to fail' },
};

export const CHANGE_OUTCOME_LABELS: Readonly<Record<ChangeOutcome, LocalizedLabelSpec>> = {
  successful: { key: 'change.outcome.successful', fallback: 'Successful' },
  successful_with_issues: {
    key: 'change.outcome.successfulWithIssues',
    fallback: 'Successful, with issues',
  },
  failed: { key: 'change.outcome.failed', fallback: 'Failed' },
  rolled_back: { key: 'change.outcome.rolledBack', fallback: 'Rolled back' },
};

export const CHANGE_CONFLICT_KIND_LABELS: Readonly<
  Record<ChangeConflictKind, LocalizedLabelSpec>
> = {
  ci_overlap: { key: 'change.conflict.kind.ciOverlap', fallback: 'Overlapping work on a shared item' },
  freeze_window: { key: 'change.conflict.kind.freezeWindow', fallback: 'Inside a change freeze' },
  queue_saturation: { key: 'change.conflict.kind.queueSaturation', fallback: 'Queue is saturated' },
};

export const CHANGE_CONFLICT_SEVERITY_LABELS: Readonly<
  Record<ChangeConflictSeverity, LocalizedLabelSpec>
> = {
  high: { key: 'change.conflict.severity.high', fallback: 'High' },
  medium: { key: 'change.conflict.severity.medium', fallback: 'Medium' },
  low: { key: 'change.conflict.severity.low', fallback: 'Low' },
  info: { key: 'change.conflict.severity.info', fallback: 'For information' },
};

// ═════════════════════════════════════════════════════════════════════════════
// DTOs
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The slim ticket projection the change pages and the gates need. Deliberately
 * NOT `Ticket`: see the header.
 */
export interface ChangeTicketHeader {
  ticketId: number;
  number: string;
  subject: string;
  statusSlug: string;
  /** HARD RULE 5 — every engine keys off this, never off `statusSlug`. */
  statusCategory: StatusCategory;
  prioritySlug: string;
  queueSlug: string;
  assigneeId: number | null;
  requesterUserId: number | null;
  /** The impact axis of the risk matrix. It lives on the ticket, not here. */
  impact: ImpactLevel | null;
  /**
   * HARD RULE 6. NULL on a change and it stays NULL: a change is not something
   * that happened to you, it is something you intend to do. Borrowing this
   * column for the window would corrupt the one column Rewind rests on, across
   * the incidents that share the table.
   */
  occurredAt: string | null;
  createdAt: string;
  /** `tickets.row_version`. Distinct from `Change.rowVersion` (HARD RULE 7). */
  rowVersion: number;
}

/** The `changes` row, camelCased. One field per column, same order. */
export interface Change {
  ticketId: number;
  tenantId: number;

  changeType: ChangeType;
  modelSlug: string | null;
  modelVersion: number | null;
  policySlug: string | null;
  /** 0 means the SHIPPED baseline policy decided, because none is published. */
  policyVersion: number | null;

  failureLikelihood: FailureLikelihood | null;
  /** What the matrix said. Never overwritten by a human. */
  riskComputed: ChangeRisk | null;
  /** The band in force. */
  risk: ChangeRisk | null;
  riskOverriddenBy: number | null;
  riskOverriddenAt: string | null;
  riskOverrideReason: string | null;

  implementationMd: string | null;
  implementationHtml: string | null;
  backoutMd: string | null;
  backoutHtml: string | null;
  testMd: string | null;
  testHtml: string | null;
  backoutNotApplicable: boolean;
  backoutWaiverReason: string | null;

  plannedStartAt: string | null;
  plannedEndAt: string | null;
  baselineStartAt: string | null;
  baselineEndAt: string | null;
  baselineSetAt: string | null;
  implementationStartedAt: string | null;
  implementationEndedAt: string | null;

  freezeOverrideBy: number | null;
  freezeOverrideAt: string | null;
  freezeOverrideReason: string | null;
  /** WHICH freezes were bypassed, by slug (HARD RULE 3). */
  freezeOverrideSlugs: string[];

  conflictAckBy: number | null;
  conflictAckAt: string | null;
  conflictAckReason: string | null;
  conflictAckDigest: string | null;

  outcome: ChangeOutcome | null;
  outcomeRecordedAt: string | null;
  outcomeRecordedBy: number | null;

  major: boolean;
  pirRequired: boolean;
  pirDueAt: string | null;
  pirOverdueNotifiedAt: string | null;
  pirCompletedAt: string | null;
  pirCompletedBy: number | null;
  pirFindingsMd: string | null;
  pirCausedIncident: boolean | null;

  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** The `change_conflicts` row, camelCased. A CACHE — safe to rebuild. */
export interface ChangeConflict {
  id: number;
  tenantId: number;
  changeTicketId: number;
  kind: ChangeConflictKind;
  severity: ChangeConflictSeverity;
  /** `ci_overlap` only. */
  otherTicketId: number | null;
  /** `freeze_window` only (HARD RULE 3). */
  freezeSlug: string | null;
  freezeVersion: number | null;
  /** `queue_saturation` only (HARD RULE 3). */
  queueSlug: string | null;
  ciIds: number[];
  overlapStartAt: string | null;
  overlapEndAt: string | null;
  detectedAt: string;
  clearedAt: string | null;
  digest: string;
}

/** What the conflict panel renders: the row plus the names it needs. */
export interface ChangeConflictView extends ChangeConflict {
  otherNumber?: string | null;
  otherSubject?: string | null;
  otherPlannedStartAt?: string | null;
  otherPlannedEndAt?: string | null;
  otherAssigneeId?: number | null;
  ciNames?: string[];
  freezeLabel?: string | null;
  freezeReason?: string | null;
}

export interface ChangeWithRelations extends Change {
  ticket?: ChangeTicketHeader;
  /** Live conflicts only (`cleared_at IS NULL`). */
  conflicts?: ChangeConflictView[];
  /** CI ids reached through `ticket_cis` OR `tickets.primary_ci_id`. Both are real. */
  ciIds?: number[];
  worstCiCriticality?: ChangeCiCriticality | null;
  /** Precomputed by the same evaluator the schedule route runs. */
  scheduleGate?: ChangeGateEvaluation;
  /** Precomputed by the same evaluator the close route runs. */
  closureGate?: ChangeGateEvaluation;
  /** Approval slugs this change's policy selected, with the reason for each. */
  selectedApprovals?: ChangeApprovalSelection[];
}

export interface ChangeListQuery {
  page?: number;
  limit?: number;
  changeType?: ChangeType | ChangeType[];
  risk?: ChangeRisk | ChangeRisk[];
  outcome?: ChangeOutcome | ChangeOutcome[];
  /** HARD RULE 5 — filter on the TICKET's category, never on a status slug. */
  statusCategory?: StatusCategory | StatusCategory[];
  queueSlug?: string;
  assigneeId?: number;
  ciId?: number;
  major?: boolean;
  /** Only changes whose planned window intersects [from, to]. */
  windowFrom?: string;
  windowTo?: string;
  /** Only changes whose actual window is open. See `isImplementing`. */
  implementing?: boolean;
  /** Only changes owing a review that is not done. */
  pirOutstanding?: boolean;
  /** Only changes carrying at least one live conflict at this severity or worse. */
  minConflictSeverity?: ChangeConflictSeverity;
  q?: string;
  sort?: 'planned_start_at' | 'created_at' | 'risk' | 'pir_due_at';
  direction?: 'asc' | 'desc';
}

// ═════════════════════════════════════════════════════════════════════════════
// Windows — the four time notions, and the one derived state (HARD RULE 6)
// ═════════════════════════════════════════════════════════════════════════════

export interface ChangeWindow {
  startAt: string;
  endAt: string;
}

const MINUTE_MS = 60_000;

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Half-open, exactly like the `[)` ranges migration 011 generates: a change
 * ending at 02:00 and one starting at 02:00 do NOT overlap, which is what a
 * scheduler means by back-to-back. Client and server must agree on that, so
 * both read this function rather than each writing their own `<` or `<=`.
 */
export function windowsOverlap(a: ChangeWindow | null, b: ChangeWindow | null): boolean {
  return changeWindowIntersection(a, b) !== null;
}

/** The overlap itself, or null when there is none. */
export function changeWindowIntersection(
  a: ChangeWindow | null,
  b: ChangeWindow | null,
): ChangeWindow | null {
  if (!a || !b) return null;
  const aStart = toMs(a.startAt);
  const aEnd = toMs(a.endAt);
  const bStart = toMs(b.startAt);
  const bEnd = toMs(b.endAt);
  if (aStart === null || aEnd === null || bStart === null || bEnd === null) return null;

  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  if (end <= start) return null;
  return { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
}

/** The planned window as a pair, or null while one end is unset. */
export function plannedWindowOf(
  change: Pick<Change, 'plannedStartAt' | 'plannedEndAt'>,
): ChangeWindow | null {
  if (!change.plannedStartAt || !change.plannedEndAt) return null;
  return { startAt: change.plannedStartAt, endAt: change.plannedEndAt };
}

/** The approved baseline window as a pair, or null while it is not frozen. */
export function baselineWindowOf(
  change: Pick<Change, 'baselineStartAt' | 'baselineEndAt'>,
): ChangeWindow | null {
  if (!change.baselineStartAt || !change.baselineEndAt) return null;
  return { startAt: change.baselineStartAt, endAt: change.baselineEndAt };
}

/**
 * THE ANSWER TO THE MISSING `implementing` CATEGORY.
 *
 * The eight hard-coded status categories have no `implementing`, and adding one
 * is forbidden by HARD RULE 5 in spirit as well as in letter: a second
 * lifecycle vocabulary makes every engine learn two words for "where is this".
 * Letting `scheduled` mean both "approved and waiting" and "running right now"
 * is worse, because the freeze evaluator and the conflict detector both need to
 * tell those apart.
 *
 * So it is derived from the data: a change is implementing iff its ACTUAL
 * window is open-ended. That reading introduces no enum, is orthogonal to
 * `status_category` exactly as `problems.known_error_state` is, is unfalsifiable
 * (a started implementation has a timestamp whatever the tenant named its
 * statuses), is an index lookup on a column both engines already read, and it
 * survives a tenant that models implementation as three statuses (pre-checks,
 * cutover, validation — all three category `open`, all three inside one actual
 * window).
 */
export function isImplementing(
  change: Pick<Change, 'implementationStartedAt' | 'implementationEndedAt'>,
): boolean {
  return change.implementationStartedAt !== null && change.implementationEndedAt === null;
}

/** The actual window, open-ended while the work is running. */
export function actualWindowOf(
  change: Pick<Change, 'implementationStartedAt' | 'implementationEndedAt'>,
): { startAt: string; endAt: string | null } | null {
  if (!change.implementationStartedAt) return null;
  return { startAt: change.implementationStartedAt, endAt: change.implementationEndedAt };
}

/**
 * Has the planned window drifted far enough from the approved baseline that the
 * granted approvals no longer apply?
 *
 * An approval is consent to a SPECIFIC window. Carrying it silently onto
 * another one is consent nobody gave — which is why exceeding the tolerance
 * cancels and re-selects rather than merely warning. Both ends are measured:
 * a change that keeps its start and doubles its duration has moved.
 */
export function changeWindowMoveExceedsTolerance(
  baseline: ChangeWindow | null,
  planned: ChangeWindow | null,
  toleranceMinutes: number,
): boolean {
  if (!baseline || !planned) return false;
  const tolerance = Math.max(0, toleranceMinutes) * MINUTE_MS;
  const bStart = toMs(baseline.startAt);
  const bEnd = toMs(baseline.endAt);
  const pStart = toMs(planned.startAt);
  const pEnd = toMs(planned.endAt);
  if (bStart === null || bEnd === null || pStart === null || pEnd === null) return false;
  return Math.abs(pStart - bStart) > tolerance || Math.abs(pEnd - bEnd) > tolerance;
}

// ═════════════════════════════════════════════════════════════════════════════
// Conflict identity and the acknowledgement digest
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What makes one conflict the SAME conflict across two scans.
 *
 * THE RULING THAT MATTERS: the identity is (kind, counterpart, shared CIs). The
 * overlap INSTANTS are deliberately excluded. A neighbour nudging their window
 * by ten minutes is the same conflict the scheduler already answered, and
 * re-raising it would train people to dismiss the panel. A NEW counterpart or a
 * NEW shared CI is a different conflict and must re-raise.
 *
 * A freeze carries its VERSION in its identity, because a republished freeze is
 * a new statement about which days are shut, and an acknowledgement of the old
 * one says nothing about the new one.
 */
export interface ChangeConflictIdentity {
  kind: ChangeConflictKind;
  otherTicketId?: number | null;
  freezeSlug?: string | null;
  freezeVersion?: number | null;
  queueSlug?: string | null;
  ciIds?: readonly number[];
}

export function changeConflictIdentity(input: ChangeConflictIdentity): string {
  const ciIds = [...(input.ciIds ?? [])].sort((a, b) => a - b).join(',');
  switch (input.kind) {
    case 'ci_overlap':
      return `ci_overlap:${input.otherTicketId ?? 0}:${ciIds}`;
    case 'freeze_window':
      return `freeze_window:${(input.freezeSlug ?? '').toLowerCase()}:${input.freezeVersion ?? 0}`;
    case 'queue_saturation':
      return `queue_saturation:${(input.queueSlug ?? '').toLowerCase()}`;
    default:
      return `unknown:${String(input.kind)}`;
  }
}

const FNV_PRIME = 0x01000193;

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    hash = Math.imul(hash ^ (code & 0xff), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ (code >>> 8), FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A 128-bit hex digest over a string, in pure TypeScript.
 *
 * NOT sha256, and that is a decision rather than a shortcut: this package has
 * no crypto dependency, `node:crypto` is unavailable in the browser, and
 * SubtleCrypto is asynchronous — which would make every gate evaluator async
 * for a value that guards nothing. This digest is a CHANGE-DETECTION MARKER
 * ("are these the same conflicts I acknowledged?"), never a security primitive:
 * it authorises nothing, and a collision would at worst let one stale
 * acknowledgement stand.
 */
function digestOf(input: string): string {
  const salted = `${input.length}|${input}`;
  const lanes = [
    fnv1a32(input, 0x811c9dc5),
    fnv1a32(salted, 0x01000193),
    fnv1a32(`${input}|${input.length}`, 0x9e3779b9),
    fnv1a32(salted, 0x85ebca6b),
  ];
  return lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('');
}

/** What goes in `change_conflicts.digest` — one row's stable identity. */
export function changeConflictRowDigest(input: ChangeConflictIdentity): string {
  return digestOf(changeConflictIdentity(input));
}

/**
 * What goes in `changes.conflict_ack_digest` — the identity of a whole SET.
 *
 * THE LOAD-BEARING PART OF THE ACKNOWLEDGEMENT. Acknowledging is not a
 * permanent state, it is "I have seen THESE conflicts". When a new one appears
 * the digest changes, the acknowledgement is stale and the gate closes again.
 * Without it, one click at 09:00 buys immunity from everything discovered at
 * 16:00: a rubber stamp with a database column behind it.
 */
export function conflictDigest(conflicts: readonly ChangeConflictIdentity[]): string {
  const identities = conflicts.map(changeConflictIdentity).sort();
  return digestOf(identities.join('\n'));
}

/**
 * The subset of live conflicts an acknowledgement is ABOUT.
 *
 * Freezes are stored as `change_conflicts` rows so the operator reads one panel
 * with one vocabulary, but they are never ACKNOWLEDGED: a freeze is OVERRIDDEN,
 * behind a different capability, with its own columns and its own audit trail.
 * Folding them into the digest would mean acknowledging a CI overlap quietly
 * also acknowledged a freeze. Both sides compute `conflict_ack_digest` over
 * this filtered set, which is why the filter is a function and not an inline
 * `.filter()` in two places that will drift.
 */
export function acknowledgeableConflicts<T extends { kind: ChangeConflictKind }>(
  conflicts: readonly T[],
): T[] {
  return conflicts.filter((conflict) => conflict.kind !== 'freeze_window');
}

/** Is a stored acknowledgement still about the conflicts that are live now? */
export function isConflictAckCurrent(
  change: Pick<Change, 'conflictAckAt' | 'conflictAckDigest'>,
  liveConflicts: readonly ChangeConflictIdentity[],
): boolean {
  if (!change.conflictAckAt || !change.conflictAckDigest) return false;
  return change.conflictAckDigest === conflictDigest(acknowledgeableConflicts(liveConflicts));
}

// ═════════════════════════════════════════════════════════════════════════════
// Risk — computed, stored, overridable, and the computed value never lost
// ═════════════════════════════════════════════════════════════════════════════

const RISK_RANK: Readonly<Record<ChangeRisk, number>> = { low: 0, medium: 1, high: 2 };

function maxRisk(a: ChangeRisk, b: ChangeRisk): ChangeRisk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

export function changeRiskMatrixKey(
  impact: ImpactLevel,
  likelihood: FailureLikelihood,
): ChangeRiskMatrixKey {
  return `${impact}:${likelihood}`;
}

export interface ChangeRiskInput {
  /** `tickets.impact`. Unknown is treated as `medium`, never as `low`. */
  impact: ImpactLevel | null | undefined;
  failureLikelihood: FailureLikelihood | null | undefined;
  /** Worst criticality among the CIs linked as `primary` or `affected`. */
  worstCiCriticality?: ChangeCiCriticality | null;
  /** `changes.backout_md` is non-blank. */
  hasBackoutPlan: boolean;
  /** `changes.backout_not_applicable`, with its reason already validated. */
  backoutWaived?: boolean;
  /** Defaults to the shipped baseline matrix when the tenant published none. */
  matrix?: Readonly<Record<ChangeRiskMatrixKey, ChangeRisk>>;
}

export interface ChangeRiskResult {
  /** The band in force after the floors. This is what goes in `risk_computed`. */
  band: ChangeRisk;
  /** The straight matrix lookup, before the floors. */
  matrixBand: ChangeRisk;
  matrixKey: ChangeRiskMatrixKey;
  floorsApplied: ChangeRiskFloor[];
}

/**
 * The matrix plus two HARD FLOORS.
 *
 * The floors live in the shared evaluator, not in the tenant's matrix, because
 * they are not opinions:
 *
 *   no_backout_plan  a change you cannot undo is never low risk, whatever a
 *                    tenant's matrix says. The waiver clears this floor, and
 *                    the waiver is itself gated (see `evaluateChangeSchedule`).
 *   critical_ci      work touching a CI the desk itself marked `critical`
 *                    cannot come out below `medium`.
 *
 * A missing impact or likelihood is read as `medium`, never as `low`: treating
 * "nobody rated it" as the safest possible answer is how an unrated change
 * slips every gate in the module.
 */
export function computeChangeRisk(input: ChangeRiskInput): ChangeRiskResult {
  const impact: ImpactLevel = input.impact ?? 'medium';
  const likelihood: FailureLikelihood = input.failureLikelihood ?? 'medium';
  const matrixKey = changeRiskMatrixKey(impact, likelihood);
  const matrix = input.matrix ?? DEFAULT_CHANGE_RISK_MATRIX;
  const matrixBand: ChangeRisk = matrix[matrixKey] ?? 'medium';

  let band = matrixBand;
  const floorsApplied: ChangeRiskFloor[] = [];

  if (!input.hasBackoutPlan && input.backoutWaived !== true) {
    band = maxRisk(band, 'high');
    floorsApplied.push('no_backout_plan');
  }
  if (input.worstCiCriticality === 'critical') {
    const raised = maxRisk(band, 'medium');
    if (raised !== band || matrixBand === 'low') floorsApplied.push('critical_ci');
    band = raised;
  }

  return { band, matrixBand, matrixKey, floorsApplied };
}

/**
 * May this change waive its backout plan?
 *
 * A waiver that is always available is a required field that is not required:
 * everybody types "n/a" and the field is worse than absent, because now it
 * looks answered. So it is offered only where it is genuinely defensible — a
 * low-risk change touching nothing critical.
 *
 * Note this reads the MATRIX band, not `changes.risk`: allowing the waiver to
 * be unlocked by a human risk override would make the override a way of
 * deleting the requirement rather than of disagreeing with the matrix.
 */
export function canWaiveBackout(input: {
  matrixBand: ChangeRisk | null;
  worstCiCriticality?: ChangeCiCriticality | null;
}): boolean {
  return input.matrixBand === 'low' && input.worstCiCriticality !== 'critical';
}

// ═════════════════════════════════════════════════════════════════════════════
// Policy resolution and approval SELECTION
// ═════════════════════════════════════════════════════════════════════════════
//
// Nothing about approval mechanics is rebuilt here. `approval.service` already
// owns startApproval / startRequiredApprovals / blockingApprovals /
// transitionBlocks / assertTransitionAllowed / decide / inbox / the timeout and
// reminder sweeps / delegation. The CAB is a `config_objects(kind='approval')`
// row and that engine. What this module adds is the answer to WHICH approval
// applies to WHICH change.

export interface ChangePolicyFacts {
  changeType: ChangeType;
  /** `changes.risk`. Unknown is resolved on the `medium` band. */
  risk: ChangeRisk | null | undefined;
  queueSlug?: string | null;
  worstCiCriticality?: ChangeCiCriticality | null;
}

export interface ChangeApprovalSelection {
  /** HARD RULE 3 — an `approval` config object, by slug. */
  slug: string;
  /** What the decision row prints and what the UI shows before you submit. */
  because: ChangeApprovalReason;
}

/** Everything the gates, the sweeper and the approval selector need, resolved. */
export interface ChangePolicyResolution {
  /** HARD RULE 3/4 — what `decision_log.rule_slug` + `rule_version` will name. */
  policySlug: string;
  /** 0 ⇒ the SHIPPED baseline decided, because the tenant published none. */
  policyVersion: number;
  band: ChangeRisk;
  approvals: ChangeApprovalSelection[];
  conflictGate: ChangeGateMode;
  freezeGate: ChangeGateMode;
  pirRequired: ChangePirRequirement;
  leadTimeMinutes: number;
  calendarSlug: string | null;
  pirDueBusinessMinutes: number;
  pirEscalateAfterBusinessMinutes: number;
  escalationSlug: string | null;
  requireModel: boolean;
  windowMoveToleranceMinutes: number;
  conflictDetection: ChangePolicyBody['conflictDetection'];
}

/**
 * Ordered, deduplicated, and each slug carrying WHY it is there.
 *
 * The union order is declaration order and it is stable: type, then band, then
 * CI criticality, then queue. `decision_log` prints the list with its reasons,
 * which is what answers "why did this change need three approvals" a year
 * later.
 *
 * Every slug here is started with `force: true`, which skips the definition's
 * own `requiredWhen`. That is deliberate: the SELECTION has already decided,
 * and letting the approval's condition decide again is two policies answering
 * one question — when they disagree, the approval silently does not start,
 * which is the exact failure this module exists to prevent. The corollary is a
 * rule the config linter enforces: an `approval` named by a `change_policy`
 * must carry NO `requiredWhen`, or the transition hook that runs
 * `startRequiredApprovals` on every non-terminal move will start it a second
 * time. Two pending approvals, two inboxes, one change.
 */
export function selectChangeApprovals(
  policy: ChangePolicyBody | null | undefined,
  facts: ChangePolicyFacts,
): ChangeApprovalSelection[] {
  const body = policy ?? DEFAULT_CHANGE_POLICY_BODY;
  const band: ChangeRisk = facts.risk ?? 'medium';
  const typeSpec = body.byType[facts.changeType] ?? {};
  const bandSpec = body.riskBands[band];

  const out: ChangeApprovalSelection[] = [];
  const seen = new Set<string>();
  const push = (slug: string | null | undefined, because: ChangeApprovalReason): void => {
    const key = (slug ?? '').trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push({ slug: key, because });
  };

  for (const slug of typeSpec.approvalSlugs ?? []) push(slug, 'type');
  if (typeSpec.inheritFromRiskBand === true) {
    for (const slug of bandSpec?.approvalSlugs ?? []) push(slug, 'risk_band');
  }
  const criticality = facts.worstCiCriticality;
  if (criticality) {
    for (const slug of body.byCiCriticality?.[criticality]?.addApprovalSlugs ?? []) {
      push(slug, 'ci_criticality');
    }
  }
  const queueSlug = (facts.queueSlug ?? '').trim().toLowerCase();
  if (queueSlug.length > 0) {
    for (const slug of body.byQueue?.[queueSlug]?.addApprovalSlugs ?? []) push(slug, 'queue');
  }

  return out;
}

/**
 * The one function every caller in this module reads its settings from.
 *
 * TRAP-2 GUARD, EXPLICITLY: `policy` may be null, and a null policy is not an
 * excuse to do nothing. A tenant that never opened the config page resolves on
 * the SHIPPED baseline and is stamped `policyVersion: 0`, exactly as the
 * problem detector stamps its own baseline. A sweeper whose tenant selection
 * requires a published config object is a sweeper that runs empty, and that
 * defect cost the previous module an entire review.
 */
export function resolveChangePolicy(
  policy: ChangePolicyBody | null | undefined,
  facts: ChangePolicyFacts,
  meta?: { slug?: string | null; version?: number | null },
): ChangePolicyResolution {
  const usingBaseline = policy === null || policy === undefined;
  const body = policy ?? DEFAULT_CHANGE_POLICY_BODY;
  const band: ChangeRisk = facts.risk ?? 'medium';
  const bandSpec = body.riskBands[band] ?? DEFAULT_CHANGE_POLICY_BODY.riskBands[band];
  const typeSpec = body.byType[facts.changeType] ?? {};

  return {
    policySlug: (meta?.slug ?? null) ?? CHANGE_POLICY_DEFAULT_SLUG,
    policyVersion: usingBaseline ? 0 : meta?.version ?? 0,
    band,
    approvals: selectChangeApprovals(body, facts),
    conflictGate: typeSpec.conflictGate ?? bandSpec.conflictGate,
    freezeGate: typeSpec.freezeGate ?? bandSpec.freezeGate,
    pirRequired: typeSpec.pirRequired ?? bandSpec.pirRequired,
    leadTimeMinutes: typeSpec.leadTimeMinutes ?? bandSpec.leadTimeMinutes,
    calendarSlug: bandSpec.calendarSlug ?? body.calendarSlug ?? null,
    pirDueBusinessMinutes: bandSpec.pirDueBusinessMinutes,
    pirEscalateAfterBusinessMinutes: bandSpec.pirEscalateAfterBusinessMinutes ?? 0,
    escalationSlug: body.escalationSlug ?? null,
    requireModel: typeSpec.requireModel === true,
    windowMoveToleranceMinutes: body.windowMoveToleranceMinutes,
    conflictDetection: body.conflictDetection,
  };
}

/**
 * Does this change owe a post-implementation review?
 *
 * The `emergency` arm is redundant with migration 011's
 * `changes_emergency_pir_ck`, and that redundancy is the point: the CHECK is
 * what makes "we review every emergency change" unclearable by any engine,
 * rule, user or tenant configuration, and this function is what lets the UI say
 * so before the insert rather than surfacing a 23514.
 */
export function isPirOwed(input: {
  changeType: ChangeType;
  outcome: ChangeOutcome | null | undefined;
  major: boolean;
  pirRequired: ChangePirRequirement;
}): boolean {
  if (input.changeType === 'emergency') return true;
  if (input.major) return true;
  if (input.outcome && CHANGE_FAILURE_OUTCOMES.includes(input.outcome)) return true;
  if (input.pirRequired === 'always') return true;
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// Conflict classification
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One row of the server's overlap query, before it is judged.
 *
 * The server's query filters `ticket_cis.role IN ('primary','affected')` on
 * BOTH sides, and that filter is load-bearing: `cause` on a change means "this
 * CI is WHY we are doing the work", not "we are touching it". Counting cause
 * links would flag every change that references the thing it is fixing, the
 * panel would be noise on day one, and a panel dismissed by reflex takes the
 * conflict that mattered down with it.
 */
export interface ChangeConflictCandidate {
  otherTicketId: number;
  window: ChangeWindow | null;
  otherWindow: ChangeWindow | null;
  sharedCiIds: readonly number[];
  /** Worst `cis.criticality` among the shared CIs. NULL is "we do not know". */
  worstCiCriticality: ChangeCiCriticality | null;
}

export interface ChangeConflictClassification {
  kind: ChangeConflictKind;
  severity: ChangeConflictSeverity;
  otherTicketId: number | null;
  freezeSlug: string | null;
  freezeVersion: number | null;
  queueSlug: string | null;
  ciIds: number[];
  worstCiCriticality: ChangeCiCriticality | null;
  overlapStartAt: string | null;
  overlapEndAt: string | null;
  digest: string;
}

/**
 * Judge one overlap. Returns null when there is nothing to say — no shared CI,
 * or windows that only touch.
 *
 * SEVERITY IS THE SHARED CI'S CRITICALITY, not the change's risk. Two low-risk
 * changes on the same core switch will still take the switch down twice, and a
 * high-risk change on a lab box will not. The thing at stake is the CI.
 *
 * PARENT-CI AND DEPENDENCY CONFLICTS ARE NOT DETECTED, and that is a decision
 * rather than an omission. The schema has `cis`, `ci_source_links`,
 * `ci_overlays` and `ci_state_cache`: there is no edge table, no parent_ci_id
 * and no relationship graph anywhere in this application. The only
 * hierarchy-shaped field is `ci_source_links.external_path`, which is another
 * app's URL layout, and inferring parenthood from its prefixes is guessing at a
 * foreign product's routing. A conflict raised on a guess is the fastest way to
 * teach people to dismiss the panel without reading it. Ship exact-CI
 * conflicts, say plainly in the UI that dependency-aware conflicts are not
 * detected, and let the CMDB earn the second band later.
 */
export function classifyChangeConflict(
  candidate: ChangeConflictCandidate,
): ChangeConflictClassification | null {
  const ciIds = [...new Set(candidate.sharedCiIds)].sort((a, b) => a - b);
  if (ciIds.length === 0) return null;

  const overlap = changeWindowIntersection(candidate.window, candidate.otherWindow);
  if (!overlap) return null;

  const criticality = candidate.worstCiCriticality;
  const severity: ChangeConflictSeverity =
    criticality === 'critical' || criticality === 'high'
      ? 'high'
      : criticality === 'medium'
        ? 'medium'
        : 'low';

  const identity: ChangeConflictIdentity = {
    kind: 'ci_overlap',
    otherTicketId: candidate.otherTicketId,
    ciIds,
  };

  return {
    kind: 'ci_overlap',
    severity,
    otherTicketId: candidate.otherTicketId,
    freezeSlug: null,
    freezeVersion: null,
    queueSlug: null,
    ciIds,
    worstCiCriticality: criticality,
    overlapStartAt: overlap.startAt,
    overlapEndAt: overlap.endAt,
    digest: changeConflictRowDigest(identity),
  };
}

/** Judge a queue-saturation reading. `info` always: capacity is not a conflict. */
export function classifyQueueSaturation(input: {
  queueSlug: string;
  concurrent: number;
  maxConcurrentPerQueue: number;
}): ChangeConflictClassification | null {
  if (input.maxConcurrentPerQueue <= 0) return null;
  if (input.concurrent <= input.maxConcurrentPerQueue) return null;
  const queueSlug = input.queueSlug.trim().toLowerCase();
  return {
    kind: 'queue_saturation',
    severity: 'info',
    otherTicketId: null,
    freezeSlug: null,
    freezeVersion: null,
    queueSlug,
    ciIds: [],
    worstCiCriticality: null,
    overlapStartAt: null,
    overlapEndAt: null,
    digest: changeConflictRowDigest({ kind: 'queue_saturation', queueSlug }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Freeze windows
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One published `change_freeze`, with the single fact this module cannot work
 * out for itself already resolved by the caller.
 *
 * `frozenBandFound` is the INVERTED CALENDAR reading: the caller ran
 * `calendarService.calendarBands(freezeCalendar, plannedStart, plannedEnd)` and
 * is reporting whether any band came back `open === true` — which, in a freeze
 * calendar, means SHUT FOR CHANGES. That inversion is what makes freezes cost
 * one line instead of a second date engine, and it is stated in
 * `ChangeFreezeBody`'s own comment as well as here because the two readings are
 * opposite and a reader must not have to guess which one is in force.
 *
 * `appliesWhenMatched` is the caller's `evaluateCondition(body.appliesWhen, …)`
 * result. Undefined means "not asked", which is read as matching: the client
 * often has no ticket context on first paint, and answering "frozen" to an
 * unknown is how you grey out a button for no reason.
 */
export interface ChangeFreezeCandidate {
  slug: string;
  /** `config_objects.version`, so a bypass can be replayed (HARD RULE 4). */
  version: number;
  body: ChangeFreezeBody;
  frozenBandFound: boolean;
  overlapStartAt?: string | null;
  overlapEndAt?: string | null;
  appliesWhenMatched?: boolean;
}

export interface ChangeFreezeVerdict {
  slug: string;
  version: number;
  /** `block` refuses the move; `warn` lets it through and says so. */
  severity: 'block' | 'warn';
  /** `t(reasonKey, reason)` — HARD RULE 10. */
  reason: string;
  reasonKey: string;
  /** When set, the override is not a click: it is this approval (HARD RULE 3). */
  overrideApprovalSlug: string | null;
  overlapStartAt: string | null;
  overlapEndAt: string | null;
  digest: string;
}

/**
 * Which freezes actually fire on this change's planned window, and how hard.
 *
 * `gate` is the policy band's `freezeGate`. `off` skips the evaluation
 * entirely; `warn` downgrades every verdict, which is how an `emergency` change
 * is exempted from the BLOCK without being exempted from the RECORD.
 */
export function evaluateChangeFreezes(input: {
  candidates: readonly ChangeFreezeCandidate[];
  changeType: ChangeType;
  risk: ChangeRisk | null | undefined;
  gate: ChangeGateMode;
}): ChangeFreezeVerdict[] {
  if (input.gate === 'off') return [];
  const band: ChangeRisk = input.risk ?? 'medium';
  const out: ChangeFreezeVerdict[] = [];

  for (const candidate of input.candidates) {
    const body = candidate.body;
    if (!body.enabled) continue;
    if (!candidate.frozenBandFound) continue;
    if (candidate.appliesWhenMatched === false) continue;
    if ((body.exemptTypes ?? []).includes(input.changeType)) continue;

    const bands = body.appliesToRiskBands ?? [];
    if (bands.length > 0 && !bands.includes(band)) continue;

    const severity: 'block' | 'warn' = input.gate === 'warn' ? 'warn' : body.severity;
    out.push({
      slug: candidate.slug,
      version: candidate.version,
      severity,
      reason: body.reason ?? 'A change freeze covers this window.',
      reasonKey: body.reasonKey ?? 'change.freeze.default',
      overrideApprovalSlug: body.overrideApprovalSlug ?? null,
      overlapStartAt: candidate.overlapStartAt ?? null,
      overlapEndAt: candidate.overlapEndAt ?? null,
      digest: changeConflictRowDigest({
        kind: 'freeze_window',
        freezeSlug: candidate.slug,
        freezeVersion: candidate.version,
      }),
    });
  }

  return out;
}

/** A freeze verdict, as a `change_conflicts` row for the one shared panel. */
export function freezeVerdictToConflict(
  verdict: ChangeFreezeVerdict,
): ChangeConflictClassification {
  return {
    kind: 'freeze_window',
    severity: verdict.severity === 'block' ? 'high' : 'low',
    otherTicketId: null,
    freezeSlug: verdict.slug,
    freezeVersion: verdict.version,
    queueSlug: null,
    ciIds: [],
    worstCiCriticality: null,
    overlapStartAt: verdict.overlapStartAt,
    overlapEndAt: verdict.overlapEndAt,
    digest: verdict.digest,
  };
}

/**
 * A READ predicate: "is this change inside a freeze right now?" It paints the
 * banner and nothing else.
 *
 * IT IS NOT WHAT DECIDES WHETHER AN OVERRIDE IS PERMITTED. That is
 * `evaluateChangeFreezeOverride`, which is a capability question. Two
 * functions, deliberately, because "can this person see it" and "may this
 * person do it" are different questions that happen to return the same type —
 * and reusing a read predicate to authorise a write is exactly the defect the
 * previous module's review found.
 */
export function isChangeFrozen(verdicts: readonly ChangeFreezeVerdict[]): boolean {
  return verdicts.length > 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// The gates — ONE implementation, TWO callers (HARD RULE 12)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A single thing standing between the actor and the move, already carrying its
 * `t(key, fallback)` pair so the client renders it, the server puts the same
 * words in the 422 body, and `decision_log` records the same code.
 */
export interface ChangeRequirement {
  /** Stable machine code. Never shown to a user. */
  code: ChangeBlockerCode;
  key: string;
  fallback: string;
  /** Rows the UI can jump to: the other change's ticket ids, CI ids. */
  refs?: number[];
  /** Config objects the UI can name: freeze slugs, approval slugs. */
  slugs?: string[];
  /**
   * Interpolation values for `key`.
   *
   * Needed because the fallback and the translation are not interchangeable
   * once numbers are involved: the inline fallback can build its sentence with
   * a template literal, but the LOCALE string cannot, so a blocker whose
   * fallback said "asks for 240 minutes and this gives 30" degraded to a
   * numberless sentence the moment somebody translated it. The gate knows the
   * numbers; this is how they reach the screen.
   */
  params?: Record<string, string | number>;
}

/**
 * The shape every gate in this module returns, so the transition bar renders
 * all of them with one component and one vocabulary.
 *
 * `warnings` is the one addition over `ProblemGateEvaluation`, and it is not
 * decoration: this module deliberately has controls that speak without
 * refusing (a `warn` conflict gate, an exempt freeze on an emergency change).
 * A warning silently dropped because the shape had nowhere to put it is a
 * control that does not exist.
 */
export interface ChangeGateEvaluation {
  allowed: boolean;
  /** Empty when allowed. Ordered most actionable first. */
  blockers: ChangeRequirement[];
  /** Never blocks. Always rendered. */
  warnings: ChangeRequirement[];
  missingCapabilities: Capability[];
}

/** What the evaluators need to know about the actor. Omit to skip the check. */
export interface ChangeActorContext {
  capabilities?: readonly Capability[] | null;
  isAdmin?: boolean;
}

/** The slim projection of `changes` every gate below reads. */
export type ChangeGateFacts = Pick<
  Change,
  | 'ticketId'
  | 'changeType'
  | 'modelSlug'
  | 'risk'
  | 'riskComputed'
  | 'implementationMd'
  | 'backoutMd'
  | 'testMd'
  | 'backoutNotApplicable'
  | 'backoutWaiverReason'
  | 'plannedStartAt'
  | 'plannedEndAt'
  | 'implementationStartedAt'
  | 'implementationEndedAt'
  | 'freezeOverrideAt'
  | 'freezeOverrideSlugs'
  | 'conflictAckAt'
  | 'conflictAckDigest'
  | 'outcome'
  | 'pirRequired'
  | 'pirCompletedAt'
  | 'pirFindingsMd'
  | 'pirCausedIncident'
>;

function requirement(
  code: ChangeBlockerCode,
  key: string,
  fallback: string,
  extra?: { refs?: number[]; slugs?: string[]; params?: Record<string, string | number> },
): ChangeRequirement {
  const out: ChangeRequirement = { code, key, fallback };
  if (extra?.refs && extra.refs.length > 0) out.refs = extra.refs;
  if (extra?.slugs && extra.slugs.length > 0) out.slugs = extra.slugs;
  if (extra?.params && Object.keys(extra.params).length > 0) out.params = extra.params;
  return out;
}

function capabilityGate(
  actor: ChangeActorContext | undefined,
  needed: Capability,
): Capability[] {
  // No actor supplied means "not asking about permissions" — the server always
  // supplies one, the client may not have loaded them yet, and answering
  // "forbidden" to an unknown actor would grey out buttons on first paint.
  if (!actor || actor.capabilities === undefined) return [];
  return hasCapability(actor.capabilities, needed, actor.isAdmin ?? false) ? [] : [needed];
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

function settle(
  blockers: ChangeRequirement[],
  warnings: ChangeRequirement[],
  missingCapabilities: Capability[],
): ChangeGateEvaluation {
  return {
    allowed: blockers.length === 0 && missingCapabilities.length === 0,
    blockers,
    warnings,
    missingCapabilities,
  };
}

// ── 1. The schedule gate ─────────────────────────────────────────────────────

export interface ChangeScheduleInput {
  change: ChangeGateFacts;
  /** From `resolveChangePolicy`. Never null: the baseline resolves too. */
  policy: ChangePolicyResolution;
  /** Live conflicts, already classified. Freezes may be included or not. */
  conflicts?: readonly ChangeConflictClassification[];
  /** Freeze verdicts for the planned window, from `evaluateChangeFreezes`. */
  freezes?: readonly ChangeFreezeVerdict[];
  /**
   * From `approvalService.transitionBlocks` / `listForTicket`. Counts, not
   * rows: the approval engine owns the rows and this gate must not re-judge
   * them.
   */
  /**
   * `granted` is not decoration: without it this gate cannot tell "no approval
   * is outstanding" from "no approval was ever started". Counting only pending
   * and rejected let a change whose policy demands the CAB sail through as long
   * as nobody opened the request — the emptiest inbox in the world looks
   * exactly like unanimous consent.
   */
  approvals?: { pending?: number; rejected?: number; granted?: readonly string[] };
  /**
   * Business minutes between `now` and `plannedStartAt`, measured by the caller
   * on `policy.calendarSlug`. Null means "not measured", and an unmeasured lead
   * time never blocks: refusing on a number nobody computed is a refusal
   * nobody can answer.
   */
  leadTimeMinutes?: number | null;
  /** Worst criticality among the linked CIs, for the backout-waiver test. */
  worstCiCriticality?: ChangeCiCriticality | null;
  /** ISO-8601. Engines MUST pass it so the decision row replays. */
  now?: string;
  actor?: ChangeActorContext;
}

/**
 * THE GATE OF THIS MODULE: may this change commit to its window?
 *
 * THE MOMENT IS ENTRY INTO THE `scheduled` CATEGORY (HARD RULE 5 — category,
 * never a slug), and three other moments were considered and rejected:
 *
 *   at CREATION       kills the module. A change is raised as a one-line idea
 *                     ("we need to move the DNS forwarders") and fleshed out
 *                     over a week. This is exactly the trap the previous module
 *                     fell into: a form that posts an empty field the schema
 *                     refuses, 400 on every click. HARD RULE 12 says a record
 *                     is created THIN.
 *   at the CAB ANSWER too late. The CAB reads the plans, so they must exist
 *                     when the approval is REQUESTED. That is why
 *                     `changeService.requestApproval()` calls this same
 *                     function — three callers, not two.
 *   at IMPLEMENTATION far too late. The plans are the thing that was approved.
 */
export function evaluateChangeSchedule(input: ChangeScheduleInput): ChangeGateEvaluation {
  const { change, policy } = input;
  const blockers: ChangeRequirement[] = [];
  const warnings: ChangeRequirement[] = [];
  const missingCapabilities = capabilityGate(input.actor, CAPABILITIES.CHANGE_SCHEDULE);

  // ── The model, for a standard change ──────────────────────────────────────
  if (policy.requireModel && isBlank(change.modelSlug)) {
    blockers.push(
      requirement(
        'change_model_required',
        'change.blocked.modelRequired',
        'A standard change must be created from a change model. Pre-approval only means anything when the plan is the one that was pre-approved.',
      ),
    );
  }

  // ── The plans (HARD RULE 12: demanded here and nowhere else) ──────────────
  if (isBlank(change.implementationMd)) {
    blockers.push(
      requirement(
        'change_plan_implementation_missing',
        'change.blocked.implementationMissing',
        'Write the implementation plan before committing to a window.',
      ),
    );
  }
  if (isBlank(change.testMd)) {
    blockers.push(
      requirement(
        'change_plan_test_missing',
        'change.blocked.testMissing',
        'Write the test plan: how will you know this worked?',
      ),
    );
  }
  if (change.backoutNotApplicable) {
    if (isBlank(change.backoutWaiverReason)) {
      blockers.push(
        requirement(
          'change_backout_waiver_reason_missing',
          'change.blocked.backoutWaiverReasonMissing',
          'Say why no backout plan is needed. A waiver without a reason is a blank field with a tick next to it.',
        ),
      );
    }
    if (!canWaiveBackout({
      matrixBand: change.riskComputed,
      worstCiCriticality: input.worstCiCriticality,
    })) {
      blockers.push(
        requirement(
          'change_backout_waiver_not_allowed',
          'change.blocked.backoutWaiverNotAllowed',
          'Only a low-risk change touching no critical item may waive its backout plan. Write one, or lower the risk honestly.',
        ),
      );
    }
  } else if (isBlank(change.backoutMd)) {
    blockers.push(
      requirement(
        'change_plan_backout_missing',
        'change.blocked.backoutMissing',
        'Write the backout plan, or waive it explicitly with a reason.',
      ),
    );
  }

  // ── The window ────────────────────────────────────────────────────────────
  const planned = plannedWindowOf(change);
  if (!planned) {
    blockers.push(
      requirement(
        'change_window_missing',
        'change.blocked.windowMissing',
        'Set a start and an end for the maintenance window.',
      ),
    );
  } else {
    const startMs = toMs(planned.startAt);
    const endMs = toMs(planned.endAt);
    if (startMs === null || endMs === null || endMs <= startMs) {
      blockers.push(
        requirement(
          'change_window_inverted',
          'change.blocked.windowInverted',
          'The window must end after it starts.',
        ),
      );
    } else {
      const nowMs = toMs(input.now ?? null) ?? Date.now();
      if (startMs < nowMs) {
        blockers.push(
          requirement(
            'change_window_in_past',
            'change.blocked.windowInPast',
            'The window starts in the past. Move it forward, or record what actually happened instead of scheduling it.',
          ),
        );
      }
    }
  }

  // ── Lead time. A COMPARISON, not a clock (see the header) ─────────────────
  if (
    typeof input.leadTimeMinutes === 'number' &&
    policy.leadTimeMinutes > 0 &&
    input.leadTimeMinutes < policy.leadTimeMinutes
  ) {
    blockers.push(
      requirement(
        'change_lead_time_short',
        'change.blocked.leadTimeShort',
        `This band asks for ${policy.leadTimeMinutes} business minutes of notice and this window gives ${Math.max(0, Math.round(input.leadTimeMinutes))}.`,
        {
          params: {
            required: policy.leadTimeMinutes,
            given: Math.max(0, Math.round(input.leadTimeMinutes)),
          },
        },
      ),
    );
  }

  // ── Approvals. Counts only: the approval engine owns the rows ─────────────
  const pending = input.approvals?.pending ?? 0;
  const rejected = input.approvals?.rejected ?? 0;
  if (rejected > 0) {
    blockers.push(
      requirement(
        'change_approval_rejected',
        'change.blocked.approvalRejected',
        'An approval on this change was rejected. Answer it before scheduling.',
      ),
    );
  } else if (pending > 0) {
    blockers.push(
      requirement(
        'change_approval_pending',
        'change.blocked.approvalPending',
        'This change is waiting on an approval.',
      ),
    );
  } else {
    // Nothing pending and nothing rejected. That is only consent if every
    // approval the policy selected was actually GRANTED; otherwise the request
    // was never raised, and silence is not an answer.
    const granted = new Set(
      (input.approvals?.granted ?? []).map((slug) => slug.toLowerCase()),
    );
    const missing = (input.policy?.approvals ?? [])
      .map((selection) => selection.slug)
      .filter((slug) => !granted.has(slug.toLowerCase()));

    if (missing.length > 0) {
      blockers.push(
        requirement(
          'change_approval_missing',
          'change.blocked.approvalMissing',
          'This change needs an approval that has not been requested yet.',
        ),
      );
    }
  }

  // ── Freezes ───────────────────────────────────────────────────────────────
  const overridden = new Set((change.freezeOverrideSlugs ?? []).map((s) => s.toLowerCase()));
  const overrideIsLive = change.freezeOverrideAt !== null;
  for (const verdict of input.freezes ?? []) {
    const isOverridden = overrideIsLive && overridden.has(verdict.slug.toLowerCase());
    if (verdict.severity === 'block' && !isOverridden) {
      blockers.push(
        requirement('change_freeze_active', verdict.reasonKey, verdict.reason, {
          slugs: [verdict.slug],
        }),
      );
    } else {
      warnings.push(
        requirement('change_freeze_active', verdict.reasonKey, verdict.reason, {
          slugs: [verdict.slug],
        }),
      );
    }
  }

  // ── Conflicts ─────────────────────────────────────────────────────────────
  //
  // ONE MOVE, ONE SEVERITY, ALWAYS ACKNOWLEDGEABLE. A pure warning nobody must
  // answer is a warning nobody reads, which is how every change tool's conflict
  // panel dies. But an unoverridable block is worse: teams schedule outside the
  // tool, and then the calendar the detector reads is fiction, so the detector
  // destroys its own input. Acknowledge-with-reason keeps the tool
  // authoritative AND produces the only artefact that matters at the
  // post-mortem: a named person, a timestamp, and a sentence.
  // FREEZE ROWS ARE EXCLUDED HERE ON PURPOSE. A freeze is stored as a
  // `change_conflicts` row so the operator reads one panel, but it is JUDGED
  // above, by `input.freezes`. Letting it through here too would refuse the
  // same move twice with two different codes, and — worse — would fold freezes
  // into the acknowledgement digest, so acknowledging a CI overlap would
  // quietly also acknowledge a freeze. A freeze is OVERRIDDEN, by a different
  // capability, with its own columns and its own audit trail; it is never
  // acknowledged. `changes.conflict_ack_digest` is therefore computed over
  // exactly this filtered set, on both sides.
  const conflicts = acknowledgeableConflicts(input.conflicts ?? []);
  if (policy.conflictGate !== 'off' && conflicts.length > 0) {
    const blocking = conflicts.filter((c) => c.severity === 'high');
    const informational = conflicts.filter((c) => c.severity !== 'high');

    for (const conflict of informational) {
      warnings.push(
        requirement(
          'change_conflict_unacknowledged',
          'change.warning.conflict',
          'Another change overlaps this window on a shared item.',
          {
            refs: conflict.otherTicketId ? [conflict.otherTicketId] : conflict.ciIds,
            slugs: conflict.freezeSlug ? [conflict.freezeSlug] : undefined,
          },
        ),
      );
    }

    if (blocking.length > 0) {
      if (policy.conflictGate === 'warn') {
        for (const conflict of blocking) {
          warnings.push(
            requirement(
              'change_conflict_unacknowledged',
              'change.warning.conflictHigh',
              'Another change overlaps this window on a critical item.',
              { refs: conflict.otherTicketId ? [conflict.otherTicketId] : conflict.ciIds },
            ),
          );
        }
      } else if (!change.conflictAckAt || !change.conflictAckDigest) {
        blockers.push(
          requirement(
            'change_conflict_unacknowledged',
            'change.blocked.conflictUnacknowledged',
            'This window overlaps other work on a critical item. Acknowledge the conflict, in writing, or move the window.',
            { refs: blocking.map((c) => c.otherTicketId ?? 0).filter((id) => id > 0) },
          ),
        );
      } else if (change.conflictAckDigest !== conflictDigest(conflicts)) {
        blockers.push(
          requirement(
            'change_conflict_ack_stale',
            'change.blocked.conflictAckStale',
            'New conflicts appeared since this was acknowledged. Read them and acknowledge again.',
            { refs: blocking.map((c) => c.otherTicketId ?? 0).filter((id) => id > 0) },
          ),
        );
      }
    }
  }

  return settle(blockers, warnings, missingCapabilities);
}

// ── 2. The freeze-override gate ──────────────────────────────────────────────

export interface ChangeFreezeOverrideInput {
  /** The verdicts being overridden. Empty ⇒ nothing to override, allowed. */
  verdicts: readonly ChangeFreezeVerdict[];
  /** The mandatory sentence. */
  reason: string | null | undefined;
  /**
   * Slugs of the override approvals that are GRANTED. A freeze naming an
   * `overrideApprovalSlug` is not bypassed by a click: the approval must have
   * been answered, which is how a tenant makes a freeze genuinely hard without
   * making it impossible.
   */
  grantedOverrideApprovals?: readonly string[];
  actor?: ChangeActorContext;
}

/**
 * May THIS person bypass THESE freezes?
 *
 * Deliberately separate from `isChangeFrozen`, which is a read. Reusing a read
 * predicate to authorise a write is the defect the previous module's review
 * found, and it is repeated here in the one place it would be tempting.
 */
export function evaluateChangeFreezeOverride(
  input: ChangeFreezeOverrideInput,
): ChangeGateEvaluation {
  const blockers: ChangeRequirement[] = [];
  const warnings: ChangeRequirement[] = [];

  const blocking = input.verdicts.filter((v) => v.severity === 'block');
  if (blocking.length === 0) return settle(blockers, warnings, []);

  const missingCapabilities = capabilityGate(input.actor, CAPABILITIES.CHANGE_FREEZE_OVERRIDE);
  if (missingCapabilities.length > 0) {
    blockers.push(
      requirement(
        'change_freeze_override_forbidden',
        'change.blocked.freezeOverrideForbidden',
        'Overriding a change freeze needs the change-freeze override permission.',
        { slugs: blocking.map((v) => v.slug) },
      ),
    );
  }

  if (isBlank(input.reason)) {
    blockers.push(
      requirement(
        'change_freeze_override_reason_missing',
        'change.blocked.freezeOverrideReasonMissing',
        'Say why this change must go ahead inside the freeze. This sentence is what the post-mortem reads.',
      ),
    );
  }

  const granted = new Set((input.grantedOverrideApprovals ?? []).map((s) => s.toLowerCase()));
  const ungranted = blocking
    .filter((v) => v.overrideApprovalSlug && !granted.has(v.overrideApprovalSlug.toLowerCase()))
    .map((v) => v.slug);
  if (ungranted.length > 0) {
    blockers.push(
      requirement(
        'change_freeze_override_approval_pending',
        'change.blocked.freezeOverrideApprovalPending',
        'This freeze may only be overridden once its override approval is granted.',
        { slugs: ungranted },
      ),
    );
  }

  return settle(blockers, warnings, missingCapabilities);
}

// ── 3. The closure gate — the tooth that imposes the review ──────────────────

export interface ChangeClosureInput {
  change: ChangeGateFacts;
  actor?: ChangeActorContext;
}

/**
 * May this change be CLOSED?
 *
 * This is the tooth that actually bites, because everybody wants their board
 * clean and `closed` is the only way to get there.
 *
 * DELIBERATELY NOT `resolved`: the change worked, the service is back, let the
 * live board clear. Paperwork debt belongs in `closed`, which is where debt
 * belongs. And nothing in this module ever blocks `cancelled` — a change that
 * cannot be abandoned is immortal, and the approval engine already draws that
 * same line for the same reason.
 */
export function evaluateChangeClosure(input: ChangeClosureInput): ChangeGateEvaluation {
  const { change } = input;
  const blockers: ChangeRequirement[] = [];
  const warnings: ChangeRequirement[] = [];
  const missingCapabilities = capabilityGate(input.actor, CAPABILITIES.CHANGE_RW);

  if (isImplementing(change)) {
    blockers.push(
      requirement(
        'change_implementation_open',
        'change.blocked.implementationOpen',
        'The implementation window is still open. Finish it, or cancel the change.',
      ),
    );
  }

  // An outcome is demanded only where work was actually done. A change closed
  // without ever being started has nothing to report, and demanding a verdict
  // on work that never happened is how "successful" becomes the default answer.
  if (change.implementationStartedAt !== null && change.outcome === null) {
    blockers.push(
      requirement(
        'change_outcome_missing',
        'change.blocked.outcomeMissing',
        'Record what happened: successful, successful with issues, failed or rolled back.',
      ),
    );
  }

  if (change.pirRequired && change.pirCompletedAt === null) {
    blockers.push(
      requirement(
        'change_pir_outstanding',
        'change.blocked.pirOutstanding',
        'This change owes a post-implementation review. Complete it before closing.',
      ),
    );
  }

  return settle(blockers, warnings, missingCapabilities);
}

// ── 4. The review gate — what a PIR must actually contain ────────────────────

export interface ChangeReviewInput {
  change: ChangeGateFacts;
  /**
   * Incidents linked to this change as `ticket_link(kind='caused_by')`. That
   * link already exists in the schema and already reads in the right direction
   * (the INCIDENT is caused_by the CHANGE), so this invents nothing — and it is
   * what turns the change failure rate into a real number instead of a survey.
   */
  linkedIncidentCount?: number;
  actor?: ChangeActorContext;
}

/**
 * May this post-implementation review be marked complete?
 *
 * A COMPLETION GATE THAT REFUSES "WENT FINE". A review with no findings and no
 * answer to "did this cause an incident" is a tick box, and a tick box produces
 * a change failure rate of zero on a desk that broke production twice.
 *
 * A PIR is deliberately NOT a separate record_type and NOT a child ticket. A
 * PIR with its own number, its own queue and its own SLA is a second object
 * nobody fills in, and it shows up on the board as forty overdue rows people
 * learn to ignore. It is five columns on the change it reviews, gated at that
 * change's own closure. If it produces work, that work is a normal ticket
 * linked `child`; if it produces a root cause, that is a `problem`, and the
 * previous module already built the whole apparatus for it.
 */
export function evaluateChangeReview(input: ChangeReviewInput): ChangeGateEvaluation {
  const { change } = input;
  const blockers: ChangeRequirement[] = [];
  const warnings: ChangeRequirement[] = [];
  const missingCapabilities = capabilityGate(input.actor, CAPABILITIES.CHANGE_RW);

  if (change.outcome === null) {
    blockers.push(
      requirement(
        'change_outcome_missing',
        'change.blocked.outcomeMissing',
        'Record the outcome before reviewing it.',
      ),
    );
  }
  if (isBlank(change.pirFindingsMd)) {
    blockers.push(
      requirement(
        'change_pir_findings_missing',
        'change.blocked.pirFindingsMissing',
        'Write what the review found. "Went fine" is not a finding.',
      ),
    );
  }
  if (change.pirCausedIncident === null) {
    blockers.push(
      requirement(
        'change_pir_incident_answer_missing',
        'change.blocked.pirIncidentAnswerMissing',
        'Answer the question the review exists for: did this change cause an incident?',
      ),
    );
  } else if (change.pirCausedIncident === true && (input.linkedIncidentCount ?? 0) === 0) {
    blockers.push(
      requirement(
        'change_pir_incident_link_missing',
        'change.blocked.pirIncidentLinkMissing',
        'Link the incident this change caused. An unlinked yes cannot be counted.',
      ),
    );
  }

  return settle(blockers, warnings, missingCapabilities);
}

// ── 5. The one front door the transition path calls ──────────────────────────

export interface ChangeTransitionInput extends ChangeScheduleInput {
  /** HARD RULE 5 — the DESTINATION category, never a status slug. */
  toCategory: StatusCategory;
  linkedIncidentCount?: number;
}

/**
 * THE function `ticket.service`'s transition path calls, and the same function
 * the client calls to grey out a transition button.
 *
 * It dispatches on the destination CATEGORY, never on a status slug (HARD RULE
 * 5), so a tenant renaming "Scheduled" to "Booked in" changes nothing.
 *
 *   cancelled   ALWAYS allowed. No gate in this module may ever refuse it: a
 *               change that cannot be abandoned is immortal.
 *   scheduled   the schedule gate: plans, window, lead time, approvals,
 *               freezes, conflicts.
 *   closed      the closure gate: the open implementation window, the outcome,
 *               the outstanding review.
 *   anything    allowed. Nothing here blocks `resolved` — the eCAB does that
 *   else        through the approval engine's own `blockedStatusCategories`,
 *               which is a facility that already exists and needs no second
 *               implementation.
 */
export function evaluateChangeTransition(input: ChangeTransitionInput): ChangeGateEvaluation {
  if (input.toCategory === 'cancelled') {
    return { allowed: true, blockers: [], warnings: [], missingCapabilities: [] };
  }
  if (input.toCategory === 'scheduled') return evaluateChangeSchedule(input);
  if (input.toCategory === 'closed') {
    return evaluateChangeClosure({ change: input.change, actor: input.actor });
  }
  return { allowed: true, blockers: [], warnings: [], missingCapabilities: [] };
}

// ═════════════════════════════════════════════════════════════════════════════
// decision_log catalogue (HARD RULE 2)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every automated decision this module takes, written by `decisionService` with
 * `subsystem: 'change'` on the SAME code path and in the SAME transaction as
 * the action. Never reconstructed from the journal afterwards.
 *
 * Two volumetric rulings worth stating, because a cache refresh is tempting to
 * log wrongly:
 *
 *   • the SYNCHRONOUS planning check ALWAYS writes `conflictEvaluated`,
 *     INCLUDING the clean result, with outcome `noop` and `conflicts: 0`. "We
 *     checked your date and it is clear" is exactly what the scheduler wants on
 *     the record, and silence is never evidence.
 *   • the SWEEPER writes its per-tenant census `conflictScan` only when
 *     raised + cleared > 0. That differs from `problem_detection_run`, which
 *     logs every pass, and the difference is defensible: the detector's job is
 *     to PROPOSE, so a pass that proposed nothing is still a judgement; this
 *     sweeper's job is to MAINTAIN A CACHE, and a refresh with no diff took no
 *     action and has nothing to explain. Logging it every five minutes per
 *     tenant would bury the rows that matter.
 *
 * Every row carries `rule_slug` + `rule_version` naming the config object that
 * decided (HARD RULES 3 and 4), so a decision taken under a policy that has
 * since been edited still replays against the body that produced it.
 */
export const CHANGE_DECISIONS = {
  // risk
  riskComputed: 'change_risk_computed',
  riskOverridden: 'change_risk_overridden',
  /** The matrix moved under a human override. Writes nothing, says so. */
  riskDrifted: 'change_risk_drifted',

  // approvals
  approvalsSelected: 'change_approvals_selected',
  /** Written when the selection is EMPTY. "No approval was needed" is a row. */
  approvalNotSelected: 'change_approval_not_selected',
  approvalInvalidatedByWindowMove: 'change_approval_invalidated_by_window_move',

  // windows
  windowPlanned: 'change_window_planned',
  windowMoved: 'change_window_moved',
  baselineFrozen: 'change_baseline_frozen',

  // conflicts
  conflictEvaluated: 'change_conflict_evaluated',
  conflictRaised: 'change_conflict_raised',
  conflictCleared: 'change_conflict_cleared',
  conflictAcknowledged: 'change_conflict_acknowledged',
  conflictScan: 'change_conflict_scan',

  // gates
  scheduleBlocked: 'change_schedule_blocked',
  leadTimeShort: 'change_lead_time_short',

  // freezes
  freezeEvaluated: 'change_freeze_evaluated',
  freezeBlocked: 'change_freeze_blocked',
  freezeOverridden: 'change_freeze_overridden',

  // implementation
  implementationStarted: 'change_implementation_started',
  implementationEnded: 'change_implementation_ended',
  /**
   * THE HONEST ROW. A change moving into a `resolved` category with an open
   * actual window gets its end stamped to the transition instant — but we did
   * not OBSERVE the end of the work, we inferred it. So the row says
   * `source: 'inferred'` and is named differently from
   * `implementationEnded`, the UI marks the duration as inferred, and the
   * duration-accuracy report can exclude these instead of silently averaging
   * fiction into the number. A row that asserts what did not happen is worse
   * than a row that is absent.
   */
  actualWindowClosedOnResolve: 'change_actual_window_closed_on_resolve',

  // outcome and review
  outcomeRecorded: 'change_outcome_recorded',
  pirArmed: 'change_pir_armed',
  pirOverdue: 'change_pir_overdue',
  pirEscalated: 'change_pir_escalated',
  pirCompleted: 'change_pir_completed',
  closureBlockedPir: 'change_closure_blocked_pir',

  // models
  createdFromModel: 'change_created_from_model',
  /** The template moved under an executed plan. Writes nothing, says so. */
  modelDrifted: 'change_model_drifted',
} as const;

export type ChangeDecision = (typeof CHANGE_DECISIONS)[keyof typeof CHANGE_DECISIONS];

/** Shape of the sweeper census `outcome`, so the Why drawer can render it. */
export interface ChangeConflictScanOutcome {
  evaluated: number;
  raised: number;
  cleared: number;
  freezesFired: number;
  durationMs: number;
}

/** Shape of `implementationStarted` / `implementationEnded` inputs. */
export type ChangeTimestampSource = 'observed' | 'inferred';

// ═════════════════════════════════════════════════════════════════════════════
// The shipped baseline policy
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Slug the change engine looks for. NOT seeded, deliberately: nothing writes a
 * `change_policy` object, so a tenant that has never opened the screen runs on
 * the built-in body below and still gets risk banding, approval selection,
 * conflict detection and PIRs on day one. Publishing an object under this slug
 * in Admin → Configuration overrides it, which is how every other engine here
 * is tuned (HARD RULE 3 — the reference is the slug, never an id).
 */
export const CHANGE_POLICY_DEFAULT_SLUG = 'default';

/**
 * The 3x3. Read it as "impact of the change going wrong" by "how likely it is
 * to go wrong", never as urgency: urgency is how fast the requester wants it,
 * which says nothing about the danger.
 */
export const DEFAULT_CHANGE_RISK_MATRIX: Readonly<Record<ChangeRiskMatrixKey, ChangeRisk>> = {
  'high:high': 'high',
  'high:medium': 'high',
  'high:low': 'medium',
  'medium:high': 'high',
  'medium:medium': 'medium',
  'medium:low': 'low',
  'low:high': 'medium',
  'low:medium': 'low',
  'low:low': 'low',
};

/**
 * The body the change engine runs on until a tenant writes its own.
 *
 * Two shipped choices worth defending:
 *
 *   • the approval slugs are EMPTY. This module will not invent a `cab`
 *     approval object that does not exist on the tenant, because
 *     `startApproval` throws 422 on a definition it cannot find, and a fresh
 *     install whose first change 422s is a fresh install nobody uses. A tenant
 *     names its own CAB here once, and the config linter tells it whether the
 *     slug resolves.
 *   • `emergency` inherits nothing and gates nothing: an emergency change is
 *     never blocked by a conflict or a freeze. It still owes a PIR, and the
 *     eCAB approval is what blocks CLOSURE. The record is not bypassed; only
 *     the block is.
 */
export const DEFAULT_CHANGE_POLICY_BODY: ChangePolicyBody = {
  riskMatrix: DEFAULT_CHANGE_RISK_MATRIX,
  riskBands: {
    high: {
      approvalSlugs: [],
      conflictGate: 'block',
      freezeGate: 'block',
      pirRequired: 'always',
      // Three business days. Long enough that a CAB can actually meet.
      leadTimeMinutes: 3 * 8 * 60,
      calendarSlug: null,
      // Two business days to write the review while it is still remembered.
      pirDueBusinessMinutes: 2 * 8 * 60,
      pirEscalateAfterBusinessMinutes: 3 * 8 * 60,
    },
    medium: {
      approvalSlugs: [],
      conflictGate: 'block',
      freezeGate: 'block',
      pirRequired: 'on_failure',
      leadTimeMinutes: 8 * 60,
      calendarSlug: null,
      pirDueBusinessMinutes: 3 * 8 * 60,
      pirEscalateAfterBusinessMinutes: 5 * 8 * 60,
    },
    low: {
      approvalSlugs: [],
      conflictGate: 'warn',
      freezeGate: 'warn',
      pirRequired: 'never',
      leadTimeMinutes: 0,
      calendarSlug: null,
      pirDueBusinessMinutes: 5 * 8 * 60,
      pirEscalateAfterBusinessMinutes: 0,
    },
  },
  byType: {
    standard: {
      // The only thing that makes "pre-approved" safe.
      requireModel: true,
      inheritFromRiskBand: false,
      approvalSlugs: [],
      conflictGate: 'warn',
      freezeGate: 'warn',
      pirRequired: 'never',
      leadTimeMinutes: 0,
    },
    normal: {
      inheritFromRiskBand: true,
    },
    emergency: {
      inheritFromRiskBand: false,
      approvalSlugs: [],
      conflictGate: 'warn',
      freezeGate: 'warn',
      pirRequired: 'always',
      leadTimeMinutes: 0,
    },
  },
  byCiCriticality: {},
  byQueue: {},
  conflictDetection: {
    enabled: true,
    // Four weeks: far enough ahead that a quarterly freeze shows up while the
    // date picker is still open, near enough that the sweeper stays cheap.
    lookaheadDays: 28,
    maxConcurrentPerQueue: 3,
    // Off: capacity is a different signal, and shipping it on would spend the
    // panel's credibility on the least important row in it.
    queueSaturationEnabled: false,
  },
  // Fifteen minutes. A window nudged by a quarter of an hour is the same
  // window; an hour is a different night for whoever is on call.
  windowMoveToleranceMinutes: 15,
  escalationSlug: null,
  calendarSlug: null,
};
