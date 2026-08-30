/**
 * change.service.ts — the change record, its window, its consent and its review.
 *
 * A change IS a ticket (`record_type = 'change'`). Everything that concerns the
 * ticket itself — creation, transitions, the journal, links — goes through
 * `ticket.service`. This module owns the 1:1 `changes` row and nothing else.
 * There is no second state machine here, no second approval engine, no second
 * calendar and no second clock: the CAB is a `config_objects(kind='approval')`
 * row plus `approval.service`, a freeze is an INVERTED `calendar` plus
 * `calendar.service`, and a PIR due date is one comparison computed on that
 * same calendar. Every one of those was already built and reviewed; a second
 * implementation would only be a second opinion, and a second opinion is a bug
 * that shows up in front of a customer.
 *
 *   HARD RULE 1  every query is `scoped()` / `insertScoped()`; no bare db().
 *   HARD RULE 2  a decision_log row is written by `withDecision()` on the SAME
 *                code path, in the SAME transaction, as the action it explains.
 *                The one deliberate exception is a REFUSAL — see
 *                `recordRefusal()`, which writes outside the transaction
 *                precisely because the throw rolls that transaction back and a
 *                refusal nobody can read is a refusal nobody can answer.
 *   HARD RULE 3  every configuration reference here is a SLUG: the policy, the
 *                model, the freeze, the approval, the calendar, the escalation.
 *   HARD RULE 4  a `change_policy` body from a newer `body_format_version` is
 *                REFUSED, never guessed at — the module falls back to the
 *                shipped baseline and says so in the decision row.
 *   HARD RULE 5  every gate keys off `status_category`, never a status slug.
 *                The missing `implementing` category is DERIVED from the actual
 *                window (`isImplementing`), not invented as a ninth word.
 *   HARD RULE 6  four time notions, never confused: `tickets.occurred_at` (NULL
 *                on a change and never written by this module), `planned_*`
 *                (the commitment), `baseline_*` (the promise, frozen once) and
 *                `implementation_*` (the record).
 *   HARD RULE 7  `changes.row_version` is its OWN concurrency domain, separate
 *                from `tickets.row_version`, so the plan workshop and the
 *                ticket header cannot 409 each other.
 *   HARD RULE 12 inline edits autosave field by field and validate NOTHING.
 *                Completeness is demanded only at a gate, by the SHARED
 *                evaluators in `@oblidesk/shared` — `evaluateChangeSchedule`,
 *                `evaluateChangeClosure`, `evaluateChangeReview`,
 *                `evaluateChangeFreezeOverride` — which are the same four
 *                functions the client runs to grey the button out. This file
 *                imports them and never re-implements a single one of them.
 *
 * ── Where this module is plugged in ─────────────────────────────────────────
 *
 * Two entry points belong to `ticket.service` and are documented here so they
 * cannot become the dead code the previous module shipped:
 *
 *   assertTransitionAllowed()  THE gate. `ticket.service.transition()` must
 *                              call it beside `approvalEngine()?.
 *                              assertTransitionAllowed(...)`, inside the same
 *                              `if (request.system !== true)` block and BEFORE
 *                              the withDecision that applies the move.
 *   onChangeResolved()         THE hook. `ticket.service.transition()` must call
 *                              it beside `runHook('problem.onResolved', …)`,
 *                              INSIDE the withDecision and the transaction.
 *
 * A third belongs to `approval.service`:
 *
 *   onApprovalDecided()        freezes the baseline the instant the LAST
 *                              selected approval is granted. Until it is wired
 *                              into `approval.service.decide()`, the baseline is
 *                              still latched by every window write through
 *                              `maybeFreezeBaseline()` — late, but never wrong
 *                              and never silent.
 *
 * ── The dangerous half of this file ─────────────────────────────────────────
 *
 * `overrideFreeze()` lets one person carry a change through a period the
 * business declared shut. It leaves FOUR traces in one transaction — the
 * columns, a `decision_log` row, a hash-chained `audit_log` row and a work note
 * on the timeline — because "why did this go ahead during the freeze?" is asked
 * months later by somebody who will not open a Why drawer, and an override that
 * only one of those four remembers is an override that can be argued away.
 */
import type { Knex } from 'knex';
import {
  CAPABILITIES,
  CHANGE_DECISIONS,
  CHANGE_POLICY_DEFAULT_SLUG,
  CONFIG_BODY_FORMAT_VERSIONS,
  DEFAULT_CHANGE_POLICY_BODY,
  PAGINATION,
  acknowledgeableConflicts,
  baselineWindowOf,
  changeWindowMoveExceedsTolerance,
  computeChangeRisk,
  conflictDigest,
  evaluateChangeClosure,
  evaluateChangeFreezeOverride,
  evaluateChangeReview,
  evaluateChangeSchedule,
  evaluateChangeTransition,
  hasCapability,
  isChangeFrozen,
  isImplementing,
  isPirOwed,
  plannedWindowOf,
  resolveChangePolicy,
  type Capability,
  type Change,
  type ChangeActorContext,
  type ChangeApprovalSelection,
  type ChangeConflict,
  type ChangeConflictClassification,
  type ChangeConflictKind,
  type ChangeConflictSeverity,
  type ChangeConflictView,
  type ChangeCiCriticality,
  type ChangeFreezeBody,
  type ChangeFreezeVerdict,
  type ChangeGateEvaluation,
  type ChangeGateFacts,
  type ChangeListQuery,
  type ChangeModelBody,
  type ChangeOutcome,
  type ChangePolicyBody,
  type ChangePolicyResolution,
  type ChangeRisk,
  type ChangeTicketHeader,
  type ChangeType,
  type ChangeWithRelations,
  type FailureLikelihood,
  type ImpactLevel,
  type StatusCategory,
} from '@oblidesk/shared';

import { assertTenantId, db, insertScoped, scoped, type Executor } from '../db';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { renderMarkdown } from '../utils/markdown';
import { auditService } from './audit.service';
import { addBusinessMinutesOn, businessMsBetween } from './calendar.service';
import { loadPublished, loadPublishedOne } from './configObject.service';
import { withDecision } from './decision.service';
import * as journalService from './journal.service';
import * as approvalService from './approval.service';
import * as ticketService from './ticket.service';

/** The acting user or engine. Same shape the rest of the desk passes around. */
export type ActorContext = ticketService.ActorContext;

/**
 * HARD RULE 3 — the slug the Why drawer prints beside every row this module
 * writes when no tenant policy decided. Change MANAGEMENT is product behaviour;
 * the change POLICY is tenant configuration, and where a policy did decide, its
 * own slug and published version are stamped instead (see `decisionContext`).
 */
const CHANGE_ENGINE_SLUG = 'change_management';
const CHANGE_ENGINE_VERSION = 1;

/**
 * `decision_log.subsystem`. Declared as a plain string because 'change' is not
 * in `DECISION_SUBSYSTEMS` yet: `decision.service` writes an unknown subsystem
 * anyway (it warns rather than refusing — a taxonomy problem must never become
 * a missing-evidence problem), and `EngineDecisionContext.subsystem` accepts
 * `DecisionSubsystem | string`, so this needs no cast and no lie.
 */
const CHANGE_SUBSYSTEM = 'change';

/** `config_objects.kind` values this module reads (HARD RULES 3 and 4). */
const POLICY_KIND = 'change_policy' as const;
const MODEL_KIND = 'change_model' as const;
const FREEZE_KIND = 'change_freeze' as const;

/**
 * `ticket_link.kind` used by the review's "did this change cause an incident?".
 * The row reads INCIDENT caused_by CHANGE, which is the direction the schema
 * already carries for problems.
 */
const CAUSED_BY_LINK_KIND = 'caused_by';

/** Roles that mean "this change TOUCHES the item", as opposed to `cause`. */
const TOUCHING_CI_ROLES = ['primary', 'affected'] as const;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Errors the controller turns into rich responses
// ═════════════════════════════════════════════════════════════════════════════

/**
 * HARD RULE 7 on the CHANGE's own axis. `current` is the whole hydrated change
 * so the client can render a diff, and `code` stays `version_conflict` because
 * that is what the client already branches on for a ticket and for a problem:
 * one reconciliation path, not three.
 */
export class ChangeVersionConflictError extends AppError {
  constructor(current: ChangeWithRelations, conflictingFields: string[]) {
    super(409, 'This change was modified while you were editing it', {
      code: 'version_conflict',
      payload: { current, conflictingFields },
    });
    this.name = 'ChangeVersionConflictError';
  }
}

/**
 * A gate one of the four SHARED evaluators refused (HARD RULE 12). Blockers and
 * warnings travel verbatim: each already carries its `t(key, fallback)` pair, so
 * the 422 body says exactly what greyed the button out on the client.
 */
export class ChangeGateError extends AppError {
  constructor(message: string, evaluation: ChangeGateEvaluation) {
    super(422, message, {
      code: 'transition_blocked',
      payload: {
        blockers: evaluation.blockers,
        warnings: evaluation.warnings,
        missingCapabilities: evaluation.missingCapabilities,
      },
    });
    this.name = 'ChangeGateError';
  }
}

/** A capability refusal that is not a gate verdict (an explicit act). */
function forbidden(capability: Capability, what: string): AppError {
  return new AppError(403, `You do not have permission to ${what}`, {
    code: 'forbidden',
    payload: { missingCapabilities: [capability] },
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Row shapes and mappers
// ═════════════════════════════════════════════════════════════════════════════

interface ChangeRow {
  ticket_id: number;
  tenant_id: number;
  change_type: string;
  model_slug: string | null;
  model_version: number | string | null;
  policy_slug: string | null;
  policy_version: number | string | null;
  failure_likelihood: string | null;
  risk_computed: string | null;
  risk: string | null;
  risk_overridden_by: number | null;
  risk_overridden_at: Date | string | null;
  risk_override_reason: string | null;
  implementation_md: string | null;
  implementation_html: string | null;
  backout_md: string | null;
  backout_html: string | null;
  test_md: string | null;
  test_html: string | null;
  backout_not_applicable: boolean;
  backout_waiver_reason: string | null;
  planned_start_at: Date | string | null;
  planned_end_at: Date | string | null;
  baseline_start_at: Date | string | null;
  baseline_end_at: Date | string | null;
  baseline_set_at: Date | string | null;
  implementation_started_at: Date | string | null;
  implementation_ended_at: Date | string | null;
  freeze_override_by: number | null;
  freeze_override_at: Date | string | null;
  freeze_override_reason: string | null;
  freeze_override_slugs: unknown;
  conflict_ack_by: number | null;
  conflict_ack_at: Date | string | null;
  conflict_ack_reason: string | null;
  conflict_ack_digest: string | null;
  outcome: string | null;
  outcome_recorded_at: Date | string | null;
  outcome_recorded_by: number | null;
  major: boolean;
  pir_required: boolean;
  pir_due_at: Date | string | null;
  pir_overdue_notified_at: Date | string | null;
  pir_completed_at: Date | string | null;
  pir_completed_by: number | null;
  pir_findings_md: string | null;
  pir_caused_incident: boolean | null;
  row_version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ConflictRow {
  id: number | string;
  tenant_id: number;
  change_ticket_id: number;
  kind: string;
  severity: string;
  other_ticket_id: number | null;
  freeze_slug: string | null;
  freeze_version: number | string | null;
  queue_slug: string | null;
  ci_ids: unknown;
  overlap_start_at: Date | string | null;
  overlap_end_at: Date | string | null;
  detected_at: Date | string;
  cleared_at: Date | string | null;
  digest: string;
}

interface TicketHeaderRow {
  id: number;
  number: string;
  subject: string;
  status_slug: string;
  status_category: string;
  priority_slug: string;
  queue_slug: string;
  assignee_id: number | null;
  requester_user_id: number | null;
  impact: string | null;
  occurred_at: Date | string | null;
  created_at: Date | string;
  row_version: number | string;
  record_type: string;
  primary_ci_id: number | null;
}

/** Postgres hands back Date objects; the wire wants ISO-8601 strings. */
function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Same, for a column the DTO declares non-null. */
function isoAt(value: Date | string | null | undefined, fallback: Date | string): string {
  return iso(value) ?? iso(fallback) ?? new Date().toISOString();
}

function int(value: number | string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

function lower(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

/** jsonb columns come back parsed by pg, but a text fallback must not crash. */
function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function stringArray(value: unknown): string[] {
  return jsonArray(value)
    .map((entry) => (typeof entry === 'string' ? entry : String(entry)))
    .filter((entry) => entry.length > 0);
}

function numberArray(value: unknown): number[] {
  return jsonArray(value)
    .map((entry) => int(entry as number | string, Number.NaN))
    .filter((entry) => Number.isFinite(entry));
}

function mapChangeRow(row: ChangeRow): Change {
  return {
    ticketId: row.ticket_id,
    tenantId: row.tenant_id,

    changeType: row.change_type as ChangeType,
    modelSlug: row.model_slug,
    modelVersion: intOrNull(row.model_version),
    policySlug: row.policy_slug,
    policyVersion: intOrNull(row.policy_version),

    failureLikelihood: (row.failure_likelihood as FailureLikelihood | null) ?? null,
    riskComputed: (row.risk_computed as ChangeRisk | null) ?? null,
    risk: (row.risk as ChangeRisk | null) ?? null,
    riskOverriddenBy: row.risk_overridden_by,
    riskOverriddenAt: iso(row.risk_overridden_at),
    riskOverrideReason: row.risk_override_reason,

    implementationMd: row.implementation_md,
    implementationHtml: row.implementation_html,
    backoutMd: row.backout_md,
    backoutHtml: row.backout_html,
    testMd: row.test_md,
    testHtml: row.test_html,
    backoutNotApplicable: row.backout_not_applicable === true,
    backoutWaiverReason: row.backout_waiver_reason,

    plannedStartAt: iso(row.planned_start_at),
    plannedEndAt: iso(row.planned_end_at),
    baselineStartAt: iso(row.baseline_start_at),
    baselineEndAt: iso(row.baseline_end_at),
    baselineSetAt: iso(row.baseline_set_at),
    implementationStartedAt: iso(row.implementation_started_at),
    implementationEndedAt: iso(row.implementation_ended_at),

    freezeOverrideBy: row.freeze_override_by,
    freezeOverrideAt: iso(row.freeze_override_at),
    freezeOverrideReason: row.freeze_override_reason,
    freezeOverrideSlugs: stringArray(row.freeze_override_slugs),

    conflictAckBy: row.conflict_ack_by,
    conflictAckAt: iso(row.conflict_ack_at),
    conflictAckReason: row.conflict_ack_reason,
    conflictAckDigest: row.conflict_ack_digest,

    outcome: (row.outcome as ChangeOutcome | null) ?? null,
    outcomeRecordedAt: iso(row.outcome_recorded_at),
    outcomeRecordedBy: row.outcome_recorded_by,

    major: row.major === true,
    pirRequired: row.pir_required === true,
    pirDueAt: iso(row.pir_due_at),
    pirOverdueNotifiedAt: iso(row.pir_overdue_notified_at),
    pirCompletedAt: iso(row.pir_completed_at),
    pirCompletedBy: row.pir_completed_by,
    pirFindingsMd: row.pir_findings_md,
    pirCausedIncident: row.pir_caused_incident,

    rowVersion: int(row.row_version, 1),
    createdAt: isoAt(row.created_at, new Date()),
    updatedAt: isoAt(row.updated_at, new Date()),
  };
}

function mapTicketHeaderRow(row: TicketHeaderRow): ChangeTicketHeader {
  return {
    ticketId: row.id,
    number: row.number,
    subject: row.subject,
    statusSlug: row.status_slug,
    statusCategory: row.status_category as StatusCategory,
    prioritySlug: row.priority_slug,
    queueSlug: row.queue_slug,
    assigneeId: row.assignee_id,
    requesterUserId: row.requester_user_id,
    // Read RAW, not through `mapTicketRow`'s `level()`, which folds NULL into
    // 'medium'. `computeChangeRisk` treats a missing impact as 'medium' too, but
    // it also records that it did — and "nobody rated this" is a different fact
    // from "somebody rated it medium" when the question is why the band is what
    // it is.
    impact: (row.impact as ImpactLevel | null) ?? null,
    // HARD RULE 6 — NULL on a change and it stays NULL. This module never
    // writes the column; it only reports what is there.
    occurredAt: iso(row.occurred_at),
    createdAt: isoAt(row.created_at, new Date()),
    rowVersion: int(row.row_version, 1),
  };
}

function mapConflictRow(row: ConflictRow): ChangeConflict {
  return {
    id: int(row.id),
    tenantId: row.tenant_id,
    changeTicketId: row.change_ticket_id,
    kind: row.kind as ChangeConflictKind,
    severity: row.severity as ChangeConflictSeverity,
    otherTicketId: row.other_ticket_id,
    freezeSlug: row.freeze_slug,
    freezeVersion: intOrNull(row.freeze_version),
    queueSlug: row.queue_slug,
    ciIds: numberArray(row.ci_ids),
    overlapStartAt: iso(row.overlap_start_at),
    overlapEndAt: iso(row.overlap_end_at),
    detectedAt: isoAt(row.detected_at, new Date()),
    clearedAt: iso(row.cleared_at),
    digest: row.digest,
  };
}

/**
 * A cached conflict row, in the shape the SHARED gate consumes.
 *
 * The cache and the gate must judge the SAME set, because
 * `changes.conflict_ack_digest` is computed over it on both sides. Converting
 * here — rather than letting each caller pick fields — is what stops the
 * client's digest and the server's from drifting apart by one field.
 */
function conflictToClassification(conflict: ChangeConflict): ChangeConflictClassification {
  return {
    kind: conflict.kind,
    severity: conflict.severity,
    otherTicketId: conflict.otherTicketId,
    freezeSlug: conflict.freezeSlug,
    freezeVersion: conflict.freezeVersion,
    queueSlug: conflict.queueSlug,
    ciIds: conflict.ciIds,
    worstCiCriticality: null,
    overlapStartAt: conflict.overlapStartAt,
    overlapEndAt: conflict.overlapEndAt,
    digest: conflict.digest,
  };
}

/** The slim projection of `changes` the four shared gates read. */
function gateFacts(change: Change): ChangeGateFacts {
  return {
    ticketId: change.ticketId,
    changeType: change.changeType,
    modelSlug: change.modelSlug,
    risk: change.risk,
    riskComputed: change.riskComputed,
    implementationMd: change.implementationMd,
    backoutMd: change.backoutMd,
    testMd: change.testMd,
    backoutNotApplicable: change.backoutNotApplicable,
    backoutWaiverReason: change.backoutWaiverReason,
    plannedStartAt: change.plannedStartAt,
    plannedEndAt: change.plannedEndAt,
    implementationStartedAt: change.implementationStartedAt,
    implementationEndedAt: change.implementationEndedAt,
    freezeOverrideAt: change.freezeOverrideAt,
    freezeOverrideSlugs: change.freezeOverrideSlugs,
    conflictAckAt: change.conflictAckAt,
    conflictAckDigest: change.conflictAckDigest,
    outcome: change.outcome,
    pirRequired: change.pirRequired,
    pirCompletedAt: change.pirCompletedAt,
    pirFindingsMd: change.pirFindingsMd,
    pirCausedIncident: change.pirCausedIncident,
  };
}

const TICKET_HEADER_COLUMNS = [
  'tickets.id',
  'tickets.number',
  'tickets.subject',
  'tickets.status_slug',
  'tickets.status_category',
  'tickets.priority_slug',
  'tickets.queue_slug',
  'tickets.assignee_id',
  'tickets.requester_user_id',
  'tickets.impact',
  'tickets.occurred_at',
  'tickets.created_at',
  'tickets.row_version',
  'tickets.record_type',
  'tickets.primary_ci_id',
];

/**
 * The SAME columns, aliased, for the two reads that select `changes.*` and the
 * ticket header from one joined row.
 *
 * THE ALIASES ARE LOAD-BEARING AND NOT COSMETIC. `tickets` and `changes` both
 * carry `created_at` and `row_version`; in a single result object the later
 * column silently wins, so an unaliased join would hand `mapChangeRow` the
 * TICKET's `row_version` as the change's. The client would then send the wrong
 * base version on every autosave — HARD RULE 7's whole mechanism, quietly
 * pointed at the wrong concurrency domain, with no error anywhere to notice it
 * by.
 */
const TICKET_HEADER_JOINED = [
  'tickets.id as t_id',
  'tickets.number as t_number',
  'tickets.subject as t_subject',
  'tickets.status_slug as t_status_slug',
  'tickets.status_category as t_status_category',
  'tickets.priority_slug as t_priority_slug',
  'tickets.queue_slug as t_queue_slug',
  'tickets.assignee_id as t_assignee_id',
  'tickets.requester_user_id as t_requester_user_id',
  'tickets.impact as t_impact',
  'tickets.occurred_at as t_occurred_at',
  'tickets.created_at as t_created_at',
  'tickets.row_version as t_row_version',
  'tickets.record_type as t_record_type',
  'tickets.primary_ci_id as t_primary_ci_id',
];

interface JoinedTicketHeaderRow {
  t_id: number;
  t_number: string;
  t_subject: string;
  t_status_slug: string;
  t_status_category: string;
  t_priority_slug: string;
  t_queue_slug: string;
  t_assignee_id: number | null;
  t_requester_user_id: number | null;
  t_impact: string | null;
  t_occurred_at: Date | string | null;
  t_created_at: Date | string;
  t_row_version: number | string;
  t_record_type: string;
  t_primary_ci_id: number | null;
}

function mapJoinedTicketHeader(row: JoinedTicketHeaderRow): ChangeTicketHeader {
  return mapTicketHeaderRow({
    id: row.t_id,
    number: row.t_number,
    subject: row.t_subject,
    status_slug: row.t_status_slug,
    status_category: row.t_status_category,
    priority_slug: row.t_priority_slug,
    queue_slug: row.t_queue_slug,
    assignee_id: row.t_assignee_id,
    requester_user_id: row.t_requester_user_id,
    impact: row.t_impact,
    occurred_at: row.t_occurred_at,
    created_at: row.t_created_at,
    row_version: row.t_row_version,
    record_type: row.t_record_type,
    primary_ci_id: row.t_primary_ci_id,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Small shared helpers
// ═════════════════════════════════════════════════════════════════════════════

/** Run `fn` in `trx` when one was handed down, otherwise open one. */
function inTransaction<T>(
  trx: Knex.Transaction | undefined,
  fn: (tx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  return trx ? fn(trx) : db.transaction(fn);
}

/** The outermost transaction: a savepoint releases long before the real commit. */
function rootTransaction(tx: Knex.Transaction): Knex.Transaction {
  let current = tx;
  while (current.parentTransaction) current = current.parentTransaction;
  return current;
}

/**
 * Run `send` once the transaction it belongs to has COMMITTED.
 *
 * Same reasoning as `problem.service`'s copy: work announced from inside a
 * transaction describes rows nobody else can read yet, and work announced from
 * a transaction that then rolls back describes something that never happened.
 */
function afterCommit(tx: Knex.Transaction, send: () => void): void {
  void rootTransaction(tx).executionPromise.then(
    () => {
      try {
        send();
      } catch (error) {
        logger.warn({ err: error }, 'Change module: post-commit side effect dropped');
      }
    },
    () => {
      /* rolled back — nothing happened, so nothing is announced */
    },
  );
}

/** What the SHARED evaluators need to know about the actor. */
function actorGate(actor: ActorContext | null | undefined): ChangeActorContext | undefined {
  if (!actor) return undefined;
  return { capabilities: actor.capabilities, isAdmin: actor.isAdmin ?? false };
}

function actorHas(actor: ActorContext | null | undefined, capability: Capability): boolean {
  if (!actor) return false;
  return hasCapability(actor.capabilities, capability, actor.isAdmin ?? false);
}

/**
 * The `withDecision` context every row in this module shares.
 *
 * HARD RULES 3 and 4: when a tenant `change_policy` decided, the row is stamped
 * with THAT slug and THAT published version, so a decision taken under a policy
 * edited since still replays against the body that produced it. Only where no
 * policy was involved does the engine name itself.
 */
function decisionContext(
  tenantId: number,
  ticketId: number | null,
  decision: string,
  actor: ActorContext | null,
  trx: Executor | undefined,
  inputs?: Record<string, unknown>,
  policy?: { policySlug: string; policyVersion: number } | null,
) {
  return {
    tenantId,
    ticketId,
    subsystem: CHANGE_SUBSYSTEM,
    decision,
    ruleSlug: policy ? policy.policySlug : CHANGE_ENGINE_SLUG,
    ruleVersion: policy ? policy.policyVersion : CHANGE_ENGINE_VERSION,
    actorId: actor?.userId ?? null,
    actorType: actor?.actorType,
    ...(trx ? { trx } : {}),
    ...(inputs ? { inputs } : {}),
  };
}

/**
 * Write the row that explains a REFUSAL — deliberately OUTSIDE the caller's
 * transaction.
 *
 * HARD RULE 2 asks for the row on the same code path and in the same
 * transaction as the action. A refusal is the one case where the second half
 * defeats the first: the refusal is delivered by throwing, the throw rolls the
 * transaction back, and a decision row written inside it disappears with the
 * work it was explaining. `ticket.service` reached the same conclusion for
 * `transition_refused` and writes it with no `trx`; this follows that
 * precedent, so "why was I not allowed to schedule this?" survives.
 */
async function recordRefusal(
  tenantId: number,
  ticketId: number,
  decision: string,
  actor: ActorContext | null,
  inputs: Record<string, unknown>,
  outcome: Record<string, unknown>,
  policy?: { policySlug: string; policyVersion: number } | null,
): Promise<void> {
  try {
    await withDecision(
      decisionContext(tenantId, ticketId, decision, actor, undefined, inputs, policy),
      async (recorder) => {
        recorder.outcome(outcome);
      },
    );
  } catch (error) {
    // A ledger failure must never replace the refusal the caller is about to
    // throw: the user would get "database error" instead of "write the backout
    // plan first", which is strictly worse for them and for the log.
    logger.warn({ err: error, tenantId, ticketId, decision }, 'Change module: refusal row not written');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — The two sibling engines, reached by a call-time require
// ═════════════════════════════════════════════════════════════════════════════
//
// `changeConflict.service` and `changeFreeze.service` are separate modules that
// both import THIS one (they need its loaders and its policy resolution), so a
// static import here would close a module-initialisation cycle. They are
// therefore resolved by a `require` at CALL time — the same defensive shape
// `ticket.service` uses for escalation, approval and problem — memoised, and
// degrading to `null` rather than to a 500 when the module is not deployed.
//
// The port is declared STRUCTURALLY rather than as `typeof import(…)` on
// purpose: this file must compile before its siblings exist, and a
// `typeof import('./changeConflict.service')` on a module that is not on disk
// yet is a TS2307 that would block every other agent working in this tree.
// The positional shape `(tenantId, ticketId, options)` is the one the rest of
// the desk uses and the one `changes.routes.ts` already calls the two siblings
// with; both return shapes are accepted (a bare array or `{ conflicts }` /
// `{ verdicts }`) so a reasonable difference of taste on the other side is not
// a runtime crash.
//
// AND, THE PART THAT MATTERS: when an engine is absent or throws, this module
// does NOT report "no conflicts" or "no freeze". It reports NOT EVALUATED, in
// the decision row and in the logs. A row asserting a clean window nobody
// checked is worse than no row at all.

interface ChangeEngineCallOptions {
  trx?: Executor;
  executor?: Executor;
  actorId?: number | null;
  /**
   * `planning` — a human is choosing a date, so the clean result is logged too.
   * `sweep` — a cache refresh nobody asked for, which logs only its diff.
   * Every call from THIS module is a human act, so every one is `planning`.
   */
  mode?: 'planning' | 'sweep';
}

type ConflictScanReturn =
  | readonly ChangeConflictClassification[]
  | { conflicts?: readonly ChangeConflictClassification[] }
  | null
  | undefined;

interface ChangeConflictEngine {
  /** Compute the live conflicts for one change. Writes `conflictEvaluated`. */
  detect?(
    tenantId: number,
    ticketId: number,
    options?: ChangeEngineCallOptions,
  ): Promise<ConflictScanReturn>;
  /** Compute AND upsert the cache, writing `conflictRaised` / `conflictCleared`. */
  refresh?(
    tenantId: number,
    ticketId: number,
    options?: ChangeEngineCallOptions,
  ): Promise<ConflictScanReturn>;
}

type FreezeScanReturn =
  | readonly ChangeFreezeVerdict[]
  | { verdicts?: readonly ChangeFreezeVerdict[] }
  | null
  | undefined;

interface ChangeFreezeEngine {
  evaluate?(
    tenantId: number,
    ticketId: number,
    options?: ChangeEngineCallOptions,
  ): Promise<FreezeScanReturn>;
  /**
   * The name `changeConflict.service` uses for the same act. Accepted as an
   * alias because the freeze evaluator currently lives beside the conflict
   * detector rather than in a module of its own — they share the freeze
   * calendar load and the change subject read, so that is a reasonable place
   * for it, and this module should not care which file answers.
   */
  evaluateFreezesForChange?(
    tenantId: number,
    ticketId: number,
    options?: ChangeEngineCallOptions,
  ): Promise<FreezeScanReturn>;
}

let conflictModule: ChangeConflictEngine | null | undefined;
let freezeModule: ChangeFreezeEngine | null | undefined;

function conflictEngine(): ChangeConflictEngine | null {
  if (conflictModule === undefined) {
    try {
      conflictModule = require('./changeConflict.service') as ChangeConflictEngine;
    } catch {
      conflictModule = null;
    }
  }
  return conflictModule;
}

function freezeEngine(): ChangeFreezeEngine | null {
  if (freezeModule === undefined) {
    // Two candidates, in order of specificity: a dedicated module if one is
    // deployed, otherwise the conflict detector, which already loads the freeze
    // calendars for its own panel. Resolving both here means this module keeps
    // working whichever shape the deployment has, instead of silently reporting
    // "no freeze applies" — the one answer it must never invent.
    for (const path of ['./changeFreeze.service', './changeConflict.service']) {
      try {
        const candidate = require(path) as ChangeFreezeEngine;
        if (candidate.evaluate || candidate.evaluateFreezesForChange) {
          freezeModule = candidate;
          break;
        }
      } catch {
        /* not deployed — try the next one */
      }
    }
    if (freezeModule === undefined) freezeModule = null;
  }
  return freezeModule;
}

function unwrapConflicts(value: ConflictScanReturn): ChangeConflictClassification[] | null {
  if (!value) return null;
  if (Array.isArray(value)) return [...value];
  const wrapped = (value as { conflicts?: readonly ChangeConflictClassification[] }).conflicts;
  return wrapped ? [...wrapped] : null;
}

function unwrapVerdicts(value: FreezeScanReturn): ChangeFreezeVerdict[] | null {
  if (!value) return null;
  if (Array.isArray(value)) return [...value];
  const wrapped = (value as { verdicts?: readonly ChangeFreezeVerdict[] }).verdicts;
  return wrapped ? [...wrapped] : null;
}

/**
 * Ask the freeze engine which freezes fire on this window.
 *
 * Returns `null` — never `[]` — when the engine is absent or fails, so every
 * caller can tell "no freeze applies" apart from "nobody looked".
 */
async function evaluateFreezes(
  tenantId: number,
  change: Change,
  executor: Executor,
): Promise<ChangeFreezeVerdict[] | null> {
  const engine = freezeEngine();
  const run = engine?.evaluate ?? engine?.evaluateFreezesForChange;
  if (!engine || !run) return null;
  try {
    return unwrapVerdicts(
      await run.call(engine, tenantId, change.ticketId, { executor, trx: executor }),
    );
  } catch (error) {
    logger.warn(
      { err: error, tenantId, ticketId: change.ticketId },
      'Change module: freeze evaluation failed — treating the freeze verdict as UNKNOWN, not as clear',
    );
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — The policy (HARD RULES 3 and 4, and the trap-2 guard)
// ═════════════════════════════════════════════════════════════════════════════

export interface LoadedChangePolicy {
  /** HARD RULE 3 — what every decision row this module writes will name. */
  slug: string;
  /** `config_objects.version`, or 0 for the SHIPPED baseline. */
  version: number;
  body: ChangePolicyBody;
  /** True when no published object was found and the baseline is in force. */
  builtin: boolean;
}

function pickRecord<T>(raw: unknown, base: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  if (!raw || typeof raw !== 'object') return base;
  return { ...base, ...(raw as Record<string, T>) };
}

/**
 * Merge a stored body over the shipped baseline.
 *
 * Missing keys are FILLED rather than left undefined. An object written by an
 * older editor — or by hand, or by a config import from a tenant that never had
 * `conflictDetection` — must not turn the engine into a no-op or, worse, into a
 * crash inside `resolveChangePolicy` when it dereferences a band that is not
 * there. Same shape and same argument as `problemDetection`'s
 * `normalizeDetectionBody`.
 */
function normalizeChangePolicyBody(raw: unknown): ChangePolicyBody {
  const base = DEFAULT_CHANGE_POLICY_BODY;
  const source = (raw ?? {}) as Partial<ChangePolicyBody>;

  const detection = (source.conflictDetection ?? {}) as Partial<
    ChangePolicyBody['conflictDetection']
  >;

  return {
    riskMatrix: pickRecord(source.riskMatrix, base.riskMatrix) as ChangePolicyBody['riskMatrix'],
    riskBands: pickRecord(source.riskBands, base.riskBands) as ChangePolicyBody['riskBands'],
    byType: pickRecord(source.byType, base.byType) as ChangePolicyBody['byType'],
    byCiCriticality: source.byCiCriticality ?? base.byCiCriticality,
    byQueue: source.byQueue ?? base.byQueue,
    conflictDetection: {
      enabled:
        typeof detection.enabled === 'boolean'
          ? detection.enabled
          : base.conflictDetection.enabled,
      lookaheadDays: int(detection.lookaheadDays as number, base.conflictDetection.lookaheadDays),
      maxConcurrentPerQueue: int(
        detection.maxConcurrentPerQueue as number,
        base.conflictDetection.maxConcurrentPerQueue,
      ),
      queueSaturationEnabled:
        typeof detection.queueSaturationEnabled === 'boolean'
          ? detection.queueSaturationEnabled
          : base.conflictDetection.queueSaturationEnabled,
    },
    windowMoveToleranceMinutes: int(
      source.windowMoveToleranceMinutes as number,
      base.windowMoveToleranceMinutes,
    ),
    escalationSlug: source.escalationSlug ?? base.escalationSlug ?? null,
    calendarSlug: source.calendarSlug ?? base.calendarSlug ?? null,
  };
}

/**
 * Read the tenant's change policy, or fall back to the SHIPPED baseline.
 *
 * THE TRAP-2 GUARD, and it is the reason this function can never return null.
 * Nothing seeds a `change_policy` object. A tenant that has never opened the
 * configuration page must still get risk banding, approval selection, conflict
 * detection and PIRs on day one — the previous module shipped a sweeper whose
 * tenant selection required a published object, so it ran empty for every
 * customer, and that cost an entire review.
 *
 * A body from a FUTURE `body_format_version` is the one case that is refused
 * rather than merged (HARD RULE 4): a later shape's key may mean something this
 * release would misread, and misreading a gate is how a change goes ahead
 * during a freeze. The baseline takes over and the log says so.
 */
export async function loadChangePolicy(
  tenantId: number,
  slug: string = CHANGE_POLICY_DEFAULT_SLUG,
  executor: Executor = db,
): Promise<LoadedChangePolicy> {
  const baseline: LoadedChangePolicy = {
    slug: CHANGE_POLICY_DEFAULT_SLUG,
    version: 0,
    body: DEFAULT_CHANGE_POLICY_BODY,
    builtin: true,
  };

  let published: Awaited<ReturnType<typeof loadPublishedOne>> = null;
  try {
    published = await loadPublishedOne(tenantId, POLICY_KIND, slug, executor);
  } catch (error) {
    logger.warn({ err: error, tenantId, slug }, 'Change module: policy read failed — using the shipped baseline');
    return baseline;
  }
  if (!published) return baseline;

  const supported = CONFIG_BODY_FORMAT_VERSIONS[POLICY_KIND];
  if (published.bodyFormatVersion > supported) {
    logger.warn(
      { tenantId, slug: published.slug, bodyFormatVersion: published.bodyFormatVersion, supported },
      'Change module: refusing a change_policy body from a newer format — the shipped baseline takes over',
    );
    return baseline;
  }

  return {
    slug: published.slug,
    version: published.version,
    body: normalizeChangePolicyBody(published.body),
    builtin: false,
  };
}

/** The policy resolved against ONE change's facts. Never null (see above). */
async function resolvePolicyFor(
  tenantId: number,
  change: Change,
  ticket: ChangeTicketHeader | null,
  worstCiCriticality: ChangeCiCriticality | null,
  executor: Executor,
): Promise<ChangePolicyResolution> {
  const loaded = await loadChangePolicy(
    tenantId,
    change.policySlug ?? CHANGE_POLICY_DEFAULT_SLUG,
    executor,
  );
  return resolveChangePolicy(
    loaded.builtin ? null : loaded.body,
    {
      changeType: change.changeType,
      risk: change.risk,
      queueSlug: ticket?.queueSlug ?? null,
      worstCiCriticality,
    },
    { slug: loaded.slug, version: loaded.version },
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Loaders
// ═════════════════════════════════════════════════════════════════════════════

async function loadChangeRow(
  tenantId: number,
  ticketId: number,
  executor: Executor,
  lock = false,
): Promise<ChangeRow | undefined> {
  const qb = scoped('changes', tenantId, executor).where('changes.ticket_id', ticketId);
  if (lock) qb.forUpdate();
  return (await qb.first('changes.*')) as ChangeRow | undefined;
}

async function requireChangeRow(
  tenantId: number,
  ticketId: number,
  executor: Executor,
  lock = false,
): Promise<ChangeRow> {
  const row = await loadChangeRow(tenantId, ticketId, executor, lock);
  if (!row) throw new AppError(404, 'Change not found', { code: 'not_found' });
  return row;
}

async function loadTicketHeaderRow(
  tenantId: number,
  ticketId: number,
  executor: Executor,
): Promise<TicketHeaderRow | undefined> {
  return (await scoped('tickets', tenantId, executor)
    .where('tickets.id', ticketId)
    .whereNull('tickets.deleted_at')
    .first(...TICKET_HEADER_COLUMNS)) as TicketHeaderRow | undefined;
}

/**
 * The CIs this change TOUCHES, and the worst criticality among them.
 *
 * Two things are deliberate. First, a CI is reached from a ticket in two real
 * ways — `tickets.primary_ci_id` and a `ticket_cis` row — and reading only one
 * of them under-reports, which here would mean losing the `critical_ci` risk
 * floor on a change whose only link is the primary one.
 *
 * Second, the `ticket_cis` role filter is `primary | affected` and NOT `cause`.
 * `cause` on a change means "this item is WHY we are doing the work", not "we
 * are touching it" — counting it would raise the risk band of every change that
 * names the thing it is fixing, and would make the conflict panel noise on day
 * one. The conflict detector applies the same filter on both sides for the same
 * reason.
 */
async function loadTouchedCis(
  tenantId: number,
  ticketId: number,
  primaryCiId: number | null,
  executor: Executor,
): Promise<{ ciIds: number[]; worst: ChangeCiCriticality | null }> {
  const ids = new Set<number>();
  if (primaryCiId) ids.add(primaryCiId);

  const links = (await scoped('ticket_cis', tenantId, executor)
    .where('ticket_cis.ticket_id', ticketId)
    .whereIn('ticket_cis.role', [...TOUCHING_CI_ROLES])
    .select('ticket_cis.ci_id')) as unknown as Array<{ ci_id: number }>;
  for (const link of links) ids.add(int(link.ci_id));

  const ciIds = [...ids].filter((id) => Number.isFinite(id) && id > 0);
  if (ciIds.length === 0) return { ciIds, worst: null };

  const rows = (await scoped('cis', tenantId, executor)
    .whereIn('cis.id', ciIds)
    .whereNull('cis.deleted_at')
    .select('cis.criticality')) as unknown as Array<{ criticality: string | null }>;

  const RANK: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2, critical: 3 };
  let worst: ChangeCiCriticality | null = null;
  for (const row of rows) {
    const value = row.criticality;
    if (value !== 'critical' && value !== 'high' && value !== 'medium' && value !== 'low') continue;
    if (worst === null || RANK[value] > RANK[worst]) worst = value;
  }
  return { ciIds, worst };
}

/** Live conflicts for one change, straight off the cache. */
async function loadLiveConflicts(
  tenantId: number,
  ticketId: number,
  executor: Executor,
  includeCleared = false,
): Promise<ChangeConflict[]> {
  const qb = scoped('change_conflicts', tenantId, executor).where(
    'change_conflicts.change_ticket_id',
    ticketId,
  );
  if (!includeCleared) qb.whereNull('change_conflicts.cleared_at');
  const rows = (await qb
    .orderBy('change_conflicts.detected_at', 'desc')
    .select('change_conflicts.*')) as unknown as ConflictRow[];
  return rows.map(mapConflictRow);
}

/**
 * The conflict panel's read: the cached rows plus the names they need.
 *
 * Four small `whereIn` reads rather than a five-way join, because the panel is
 * rendered for one change at a time and a join here would drag the freeze
 * bodies (which live in `config_objects`, not in a table the row can join to)
 * into a shape SQL cannot express anyway.
 */
async function hydrateConflicts(
  tenantId: number,
  conflicts: readonly ChangeConflict[],
  executor: Executor,
): Promise<ChangeConflictView[]> {
  if (conflicts.length === 0) return [];

  const otherIds = [
    ...new Set(conflicts.map((c) => c.otherTicketId).filter((id): id is number => !!id)),
  ];
  const ciIds = [...new Set(conflicts.flatMap((c) => c.ciIds))];
  const freezeSlugs = [
    ...new Set(
      conflicts.map((c) => lower(c.freezeSlug)).filter((slug): slug is string => slug !== null),
    ),
  ];

  const others = new Map<
    number,
    { number: string; subject: string; assigneeId: number | null }
  >();
  const windows = new Map<number, { startAt: string | null; endAt: string | null }>();
  const ciNames = new Map<number, string>();
  const freezes = new Map<string, ChangeFreezeBody>();

  if (otherIds.length > 0) {
    const rows = (await scoped('tickets', tenantId, executor)
      .whereIn('tickets.id', otherIds)
      .select(
        'tickets.id',
        'tickets.number',
        'tickets.subject',
        'tickets.assignee_id',
      )) as unknown as Array<{
      id: number;
      number: string;
      subject: string;
      assignee_id: number | null;
    }>;
    for (const row of rows) {
      others.set(int(row.id), {
        number: row.number,
        subject: row.subject,
        assigneeId: row.assignee_id,
      });
    }

    const windowRows = (await scoped('changes', tenantId, executor)
      .whereIn('changes.ticket_id', otherIds)
      .select(
        'changes.ticket_id',
        'changes.planned_start_at',
        'changes.planned_end_at',
      )) as unknown as Array<{
      ticket_id: number;
      planned_start_at: Date | string | null;
      planned_end_at: Date | string | null;
    }>;
    for (const row of windowRows) {
      windows.set(int(row.ticket_id), {
        startAt: iso(row.planned_start_at),
        endAt: iso(row.planned_end_at),
      });
    }
  }

  if (ciIds.length > 0) {
    const rows = (await scoped('cis', tenantId, executor)
      .whereIn('cis.id', ciIds)
      .select('cis.id', 'cis.display_name')) as unknown as Array<{
      id: number;
      display_name: string;
    }>;
    for (const row of rows) ciNames.set(int(row.id), row.display_name);
  }

  if (freezeSlugs.length > 0) {
    try {
      const published = await loadPublished(tenantId, FREEZE_KIND, executor);
      for (const slug of freezeSlugs) {
        const found = published.get(slug);
        if (found) freezes.set(slug, found.body as unknown as ChangeFreezeBody);
      }
    } catch (error) {
      logger.warn({ err: error, tenantId }, 'Change module: freeze labels unavailable for the conflict panel');
    }
  }

  return conflicts.map((conflict) => {
    const view: ChangeConflictView = { ...conflict };
    if (conflict.otherTicketId) {
      const other = others.get(conflict.otherTicketId);
      if (other) {
        view.otherNumber = other.number;
        view.otherSubject = other.subject;
        view.otherAssigneeId = other.assigneeId;
      }
      const window = windows.get(conflict.otherTicketId);
      if (window) {
        view.otherPlannedStartAt = window.startAt;
        view.otherPlannedEndAt = window.endAt;
      }
    }
    if (conflict.ciIds.length > 0) {
      view.ciNames = conflict.ciIds.map((id) => ciNames.get(id) ?? `CI #${id}`);
    }
    const freezeSlug = lower(conflict.freezeSlug);
    if (freezeSlug) {
      const body = freezes.get(freezeSlug);
      view.freezeLabel = body?.label ?? conflict.freezeSlug;
      view.freezeReason = body?.reason ?? null;
    }
    return view;
  });
}

/**
 * Approval counts for the schedule gate.
 *
 * COUNTS, never rows. `approval.service` owns the rows, decides who may answer
 * them and decides what they block; this gate must not re-judge any of that.
 */
async function loadApprovalFacts(
  tenantId: number,
  ticketId: number,
  executor: Executor,
): Promise<{ pending: number; rejected: number; granted: string[]; bySlug: Map<string, string> }> {
  const rows = (await scoped('approvals', tenantId, executor)
    .where('approvals.ticket_id', ticketId)
    .select('approvals.definition_slug', 'approvals.state')) as unknown as Array<{
    definition_slug: string;
    state: string;
  }>;

  let pending = 0;
  let rejected = 0;
  const granted: string[] = [];
  const bySlug = new Map<string, string>();

  for (const row of rows) {
    const slug = lower(row.definition_slug) ?? '';
    if (row.state === 'pending') pending += 1;
    if (row.state === 'rejected') rejected += 1;
    if (row.state === 'approved' && slug) granted.push(slug);

    // Worst state wins the per-slug reading: a slug with one pending row is
    // pending whatever an earlier, superseded round said.
    const current = bySlug.get(slug);
    const rank = (state: string): number =>
      state === 'rejected' ? 3 : state === 'pending' ? 2 : state === 'approved' ? 1 : 0;
    if (!current || rank(row.state) > rank(current)) bySlug.set(slug, row.state);
  }

  return { pending, rejected, granted: [...new Set(granted)], bySlug };
}

/** Incidents recorded as caused by this change (`ticket_link.kind='caused_by'`). */
async function countLinkedIncidents(
  tenantId: number,
  ticketId: number,
  executor: Executor,
): Promise<number> {
  const rows = (await scoped('ticket_link', tenantId, executor)
    .join({ inc: 'tickets' }, 'inc.id', 'ticket_link.from_ticket_id')
    // The join leaves the tenant predicate behind, so re-apply it by hand: a
    // link read without the tenant in hand is how one crosses tenants.
    .where('inc.tenant_id', tenantId)
    .whereNull('inc.deleted_at')
    .where('ticket_link.to_ticket_id', ticketId)
    .where('ticket_link.kind', CAUSED_BY_LINK_KIND)
    .count<{ count: string }[]>('ticket_link.from_ticket_id as count')) as unknown as Array<{
    count: string | number;
  }>;
  return int(rows[0]?.count);
}

/**
 * Business minutes of notice this window gives, on the band's calendar.
 *
 * Returns null when there is no window, because an UNMEASURED lead time must
 * never block: `evaluateChangeSchedule` refuses on a number, and refusing on a
 * number nobody computed is a refusal nobody can answer.
 */
async function measureLeadTime(
  tenantId: number,
  change: Change,
  policy: ChangePolicyResolution,
  now: string,
  executor: Executor,
): Promise<number | null> {
  if (!change.plannedStartAt) return null;
  if (policy.leadTimeMinutes <= 0) return null;
  const startMs = Date.parse(change.plannedStartAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return null;
  if (startMs <= nowMs) return 0;
  try {
    const ms = await businessMsBetween(tenantId, policy.calendarSlug, now, change.plannedStartAt, executor);
    return Math.round(ms / 60_000);
  } catch (error) {
    logger.warn(
      { err: error, tenantId, ticketId: change.ticketId },
      'Change module: lead time not measurable — it will not block',
    );
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — The assembled context every gate and every read runs on
// ═════════════════════════════════════════════════════════════════════════════

interface ChangeContext {
  row: ChangeRow;
  change: Change;
  ticket: ChangeTicketHeader | null;
  policy: ChangePolicyResolution;
  ciIds: number[];
  worstCiCriticality: ChangeCiCriticality | null;
  conflicts: ChangeConflict[];
  classifications: ChangeConflictClassification[];
  /** null means NOT EVALUATED, which is different from "no freeze applies". */
  freezes: ChangeFreezeVerdict[] | null;
  approvals: { pending: number; rejected: number; granted: string[] };
  leadTimeMinutes: number | null;
  now: string;
}

async function assembleContext(
  tenantId: number,
  ticketId: number,
  executor: Executor,
  options: { row?: ChangeRow; skipFreezes?: boolean } = {},
): Promise<ChangeContext> {
  const row = options.row ?? (await requireChangeRow(tenantId, ticketId, executor));
  const change = mapChangeRow(row);
  const headerRow = await loadTicketHeaderRow(tenantId, ticketId, executor);
  const ticket = headerRow ? mapTicketHeaderRow(headerRow) : null;

  const { ciIds, worst } = await loadTouchedCis(
    tenantId,
    ticketId,
    headerRow?.primary_ci_id ?? null,
    executor,
  );
  const policy = await resolvePolicyFor(tenantId, change, ticket, worst, executor);
  const conflicts = await loadLiveConflicts(tenantId, ticketId, executor);
  const approvals = await loadApprovalFacts(tenantId, ticketId, executor);
  const now = new Date().toISOString();
  const freezes = options.skipFreezes ? null : await evaluateFreezes(tenantId, change, executor);
  const leadTimeMinutes = await measureLeadTime(tenantId, change, policy, now, executor);

  return {
    row,
    change,
    ticket,
    policy,
    ciIds,
    worstCiCriticality: worst,
    conflicts,
    classifications: conflicts.map(conflictToClassification),
    freezes,
    approvals: { pending: approvals.pending, rejected: approvals.rejected, granted: approvals.granted },
    leadTimeMinutes,
    now,
  };
}

/** The schedule gate, run against an assembled context. ONE implementation. */
function scheduleGateOf(context: ChangeContext, actor: ActorContext | null): ChangeGateEvaluation {
  return evaluateChangeSchedule({
    change: gateFacts(context.change),
    policy: context.policy,
    conflicts: context.classifications,
    freezes: context.freezes ?? [],
    // `granted` travels too: without it the gate cannot tell an answered
    // approval from one nobody ever asked for.
    approvals: {
      pending: context.approvals.pending,
      rejected: context.approvals.rejected,
      granted: context.approvals.granted,
    },
    leadTimeMinutes: context.leadTimeMinutes,
    worstCiCriticality: context.worstCiCriticality,
    now: context.now,
    actor: actorGate(actor),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Reading
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The change file: the row, its ticket header, the live conflicts with their
 * names, the touched CIs, the approvals this change's policy selects, and BOTH
 * gate verdicts already evaluated by the same functions the write routes run.
 *
 * Shipping the verdicts with the payload is what lets the client grey the
 * Schedule and Close buttons out — with the exact list of what is missing —
 * without a second round trip and, more importantly, without a second opinion.
 */
export async function get(
  tenantId: number,
  ticketId: number,
  options: { executor?: Executor; actor?: ActorContext | null } = {},
): Promise<ChangeWithRelations | null> {
  assertTenantId(tenantId);
  const executor = options.executor ?? db;

  const row = await loadChangeRow(tenantId, ticketId, executor);
  if (!row) return null;

  return hydrateFromRow(tenantId, row, executor, options.actor ?? null);
}

async function hydrateFromRow(
  tenantId: number,
  row: ChangeRow,
  executor: Executor,
  actor: ActorContext | null,
): Promise<ChangeWithRelations> {
  const context = await assembleContext(tenantId, row.ticket_id, executor, { row });
  const views = await hydrateConflicts(tenantId, context.conflicts, executor);

  const out: ChangeWithRelations = {
    ...context.change,
    conflicts: views,
    ciIds: context.ciIds,
    worstCiCriticality: context.worstCiCriticality,
    scheduleGate: scheduleGateOf(context, actor),
    closureGate: evaluateChangeClosure({
      change: gateFacts(context.change),
      actor: actorGate(actor),
    }),
    selectedApprovals: context.policy.approvals,
  };
  if (context.ticket) out.ticket = context.ticket;
  return out;
}

/** Hydrate after a write. Throws 404 if the row vanished under us. */
async function requireChange(
  tenantId: number,
  ticketId: number,
  executor: Executor,
  actor: ActorContext | null,
): Promise<ChangeWithRelations> {
  const row = await requireChangeRow(tenantId, ticketId, executor);
  return hydrateFromRow(tenantId, row, executor, actor);
}

function asArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * The change list.
 *
 * Every filter that touches the lifecycle keys off `tickets.status_category`
 * (HARD RULE 5), never off a status slug, so a tenant renaming "Scheduled" to
 * "Booked in" changes nothing here.
 */
export async function list(
  tenantId: number,
  query: ChangeListQuery = {},
  options: { executor?: Executor } = {},
): Promise<{ items: ChangeWithRelations[]; total: number; page: number; limit: number }> {
  assertTenantId(tenantId);
  const executor = options.executor ?? db;

  const page = Math.max(1, int(query.page, 1));
  const limit = Math.min(PAGINATION.maxLimit, Math.max(1, int(query.limit, PAGINATION.defaultLimit)));

  const base = () => {
    const qb = scoped('changes', tenantId, executor)
      .join('tickets', 'tickets.id', 'changes.ticket_id')
      // Re-scope the joined table by hand: `scoped()` constrains the ROOT only.
      .where('tickets.tenant_id', tenantId)
      .whereNull('tickets.deleted_at');

    const changeTypes = asArray(query.changeType);
    if (changeTypes?.length) qb.whereIn('changes.change_type', changeTypes);

    const risks = asArray(query.risk);
    if (risks?.length) qb.whereIn('changes.risk', risks);

    const outcomes = asArray(query.outcome);
    if (outcomes?.length) qb.whereIn('changes.outcome', outcomes);

    const categories = asArray(query.statusCategory);
    if (categories?.length) qb.whereIn('tickets.status_category', categories);

    if (query.queueSlug) qb.where('tickets.queue_slug', query.queueSlug);
    if (query.assigneeId !== undefined) qb.where('tickets.assignee_id', query.assigneeId);
    if (query.major !== undefined) qb.where('changes.major', query.major);

    if (query.windowFrom) qb.where('changes.planned_end_at', '>', query.windowFrom);
    if (query.windowTo) qb.where('changes.planned_start_at', '<', query.windowTo);

    if (query.implementing === true) {
      qb.whereNotNull('changes.implementation_started_at').whereNull('changes.implementation_ended_at');
    } else if (query.implementing === false) {
      qb.where((b) =>
        b.whereNull('changes.implementation_started_at').orWhereNotNull('changes.implementation_ended_at'),
      );
    }

    if (query.pirOutstanding === true) {
      qb.where('changes.pir_required', true).whereNull('changes.pir_completed_at');
    }

    if (query.ciId !== undefined) {
      qb.where((b) =>
        b
          .where('tickets.primary_ci_id', query.ciId as number)
          .orWhereExists((sub) => {
            void sub
              .from('ticket_cis')
              .whereRaw('ticket_cis.ticket_id = changes.ticket_id')
              .where('ticket_cis.tenant_id', tenantId)
              .where('ticket_cis.ci_id', query.ciId as number)
              .whereIn('ticket_cis.role', [...TOUCHING_CI_ROLES]);
          }),
      );
    }

    if (query.minConflictSeverity) {
      const ORDER: readonly ChangeConflictSeverity[] = ['high', 'medium', 'low', 'info'];
      const cutoff = ORDER.indexOf(query.minConflictSeverity);
      const accepted = ORDER.slice(0, cutoff < 0 ? ORDER.length : cutoff + 1);
      qb.whereExists((sub) => {
        void sub
          .from('change_conflicts')
          .whereRaw('change_conflicts.change_ticket_id = changes.ticket_id')
          .where('change_conflicts.tenant_id', tenantId)
          .whereNull('change_conflicts.cleared_at')
          .whereIn('change_conflicts.severity', [...accepted]);
      });
    }

    if (query.q && query.q.trim().length > 0) {
      const term = `%${query.q.trim()}%`;
      qb.where((b) => b.whereILike('tickets.subject', term).orWhereILike('tickets.number', term));
    }

    return qb;
  };

  const countRows = (await base().count<{ count: string }[]>(
    'changes.ticket_id as count',
  )) as unknown as Array<{ count: string | number }>;
  const total = int(countRows[0]?.count);

  const direction = query.direction === 'asc' ? 'asc' : 'desc';
  const rowsQuery = base()
    // The ticket header rides on the join that is already there, so the board
    // costs no extra read for the number, the subject and the category every
    // row renders. ALIASED — see `TICKET_HEADER_JOINED`.
    .select('changes.*', ...TICKET_HEADER_JOINED)
    .limit(limit)
    .offset((page - 1) * limit);

  switch (query.sort) {
    case 'created_at':
      rowsQuery.orderBy('changes.created_at', direction);
      break;
    case 'pir_due_at':
      rowsQuery.orderBy('changes.pir_due_at', direction);
      break;
    case 'risk':
      // `risk` is a varchar, so alphabetical order would read high, low,
      // medium — which is exactly backwards in the middle.
      rowsQuery.orderByRaw(
        `CASE changes.risk WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END ${
          direction === 'asc' ? 'asc' : 'desc'
        }`,
      );
      break;
    case 'planned_start_at':
    default:
      rowsQuery.orderByRaw(
        `changes.planned_start_at ${direction === 'asc' ? 'asc' : 'desc'} NULLS LAST`,
      );
      break;
  }

  const rows = (await rowsQuery) as unknown as Array<ChangeRow & JoinedTicketHeaderRow>;
  const ticketIds = rows.map((row) => row.ticket_id);

  // ── Hydration is BATCHED, and that is not a micro-optimisation ────────────
  //
  // Running the detail page's `assembleContext` per row would cost six queries
  // each — the ticket header, two CI reads, the conflicts, the approvals and a
  // `config_objects` read for the policy, none of which is cached — so a fifty
  // row board would be three hundred round trips. Three batched reads answer
  // the same question, and the board renders badges rather than gates: no
  // policy resolution, no approval counts and no freeze verdicts here. The
  // detail page and every write path evaluate all three for real.
  const ciByTicket = new Map<number, number[]>();
  const worstByTicket = new Map<number, ChangeCiCriticality | null>();
  const conflictsByTicket = new Map<number, ChangeConflict[]>();

  if (ticketIds.length > 0) {
    const CRITICALITY_RANK: Readonly<Record<string, number>> = {
      low: 0,
      medium: 1,
      high: 2,
      critical: 3,
    };

    for (const row of rows) {
      const ids = ciByTicket.get(row.ticket_id) ?? [];
      if (row.t_primary_ci_id) ids.push(row.t_primary_ci_id);
      ciByTicket.set(row.ticket_id, ids);
    }

    const links = (await scoped('ticket_cis', tenantId, executor)
      .join('cis', 'cis.id', 'ticket_cis.ci_id')
      // `scoped()` owns the ROOT only; every joined tenant table is re-scoped by
      // hand or the join is a cross-tenant read waiting to happen.
      .where('cis.tenant_id', tenantId)
      .whereNull('cis.deleted_at')
      .whereIn('ticket_cis.ticket_id', ticketIds)
      .whereIn('ticket_cis.role', [...TOUCHING_CI_ROLES])
      .select(
        'ticket_cis.ticket_id',
        'ticket_cis.ci_id',
        'cis.criticality',
      )) as unknown as Array<{ ticket_id: number; ci_id: number; criticality: string | null }>;

    for (const link of links) {
      const ticketId = int(link.ticket_id);
      const ids = ciByTicket.get(ticketId) ?? [];
      if (!ids.includes(int(link.ci_id))) ids.push(int(link.ci_id));
      ciByTicket.set(ticketId, ids);

      const value = link.criticality;
      if (value !== 'critical' && value !== 'high' && value !== 'medium' && value !== 'low') continue;
      const current = worstByTicket.get(ticketId) ?? null;
      if (current === null || CRITICALITY_RANK[value] > CRITICALITY_RANK[current]) {
        worstByTicket.set(ticketId, value);
      }
    }

    const conflictRows = (await scoped('change_conflicts', tenantId, executor)
      .whereIn('change_conflicts.change_ticket_id', ticketIds)
      .whereNull('change_conflicts.cleared_at')
      .orderBy('change_conflicts.detected_at', 'desc')
      .select('change_conflicts.*')) as unknown as ConflictRow[];

    for (const conflictRow of conflictRows) {
      const conflict = mapConflictRow(conflictRow);
      const bucket = conflictsByTicket.get(conflict.changeTicketId) ?? [];
      bucket.push(conflict);
      conflictsByTicket.set(conflict.changeTicketId, bucket);
    }
  }

  const items: ChangeWithRelations[] = rows.map((row) => ({
    ...mapChangeRow(row),
    ticket: mapJoinedTicketHeader(row),
    ciIds: ciByTicket.get(row.ticket_id) ?? [],
    worstCiCriticality: worstByTicket.get(row.ticket_id) ?? null,
    conflicts: conflictsByTicket.get(row.ticket_id) ?? [],
  }));

  return { items, total, page, limit };
}

/** The cached conflict read. Deliberately NOT what the transition gate calls. */
export async function listConflicts(
  tenantId: number,
  ticketId: number,
  options: { includeCleared?: boolean; executor?: Executor } = {},
): Promise<ChangeConflictView[]> {
  assertTenantId(tenantId);
  const executor = options.executor ?? db;
  const conflicts = await loadLiveConflicts(
    tenantId,
    ticketId,
    executor,
    options.includeCleared === true,
  );
  return hydrateConflicts(tenantId, conflicts, executor);
}

/**
 * "Is this change inside a freeze?" — a READ, and only a read.
 *
 * `isChangeFrozen` paints the banner. It never decides whether an override is
 * permitted; that is `evaluateChangeFreezeOverride`, behind its own capability,
 * called from `overrideFreeze`. Reusing a read predicate to authorise a write
 * is the defect the previous module's review found, and the split is kept here
 * in the one place it would be tempting to collapse.
 */
export async function freezeStatus(
  tenantId: number,
  ticketId: number,
  options: { executor?: Executor } = {},
): Promise<{ verdicts: ChangeFreezeVerdict[]; frozen: boolean; evaluated: boolean }> {
  assertTenantId(tenantId);
  const executor = options.executor ?? db;
  const row = await requireChangeRow(tenantId, ticketId, executor);
  const context = await assembleContext(tenantId, ticketId, executor, { row });
  const verdicts = context.freezes ?? [];
  return { verdicts, frozen: isChangeFrozen(verdicts), evaluated: context.freezes !== null };
}

/**
 * The forward schedule: every change whose planned window intersects the range.
 *
 * Reads `changes_board (tenant_id, planned_start_at)`, which is why the range
 * is expressed as a start-bounded predicate rather than as an overlap on the
 * generated range column — the board asks for a fortnight, not for a scan.
 */
export async function schedule(
  tenantId: number,
  query: { from: string; to: string; queueSlug?: string },
  options: { executor?: Executor } = {},
  // Flat `ChangeWithRelations`, exactly like `list()`. It used to return
  // `{ change, ticket }` pairs while the client typed and read the flat shape,
  // so every field the calendar drew a bar from was `undefined`: the schedule
  // was structurally empty, on the one screen the module exists for. Two shapes
  // for two readings of the same rows was the whole defect; there is one now.
): Promise<ChangeWithRelations[]> {
  assertTenantId(tenantId);
  const executor = options.executor ?? db;

  const qb = scoped('changes', tenantId, executor)
    .join('tickets', 'tickets.id', 'changes.ticket_id')
    .where('tickets.tenant_id', tenantId)
    .whereNull('tickets.deleted_at')
    .whereNotNull('changes.planned_start_at')
    .where('changes.planned_start_at', '<', query.to)
    .where('changes.planned_end_at', '>', query.from)
    .orderBy('changes.planned_start_at', 'asc')
    .limit(PAGINATION.maxLimit);

  if (query.queueSlug) qb.where('tickets.queue_slug', query.queueSlug);

  const rows = (await qb.select(
    'changes.*',
    ...TICKET_HEADER_JOINED,
  )) as unknown as Array<ChangeRow & JoinedTicketHeaderRow>;

  return rows.map((row) => ({
    ...mapChangeRow(row),
    ticket: mapJoinedTicketHeader(row) ?? undefined,
  }));
}

/** Published, active `change_model` bodies, by slug (HARD RULE 3). */
export async function listModels(
  tenantId: number,
  options: { executor?: Executor; includeInactive?: boolean } = {},
): Promise<Array<{ slug: string; name: string; version: number; body: ChangeModelBody }>> {
  assertTenantId(tenantId);
  const executor = options.executor ?? db;
  const published = await loadPublished(tenantId, MODEL_KIND, executor);

  const out: Array<{ slug: string; name: string; version: number; body: ChangeModelBody }> = [];
  for (const entry of published.values()) {
    if (entry.bodyFormatVersion > CONFIG_BODY_FORMAT_VERSIONS[MODEL_KIND]) continue;
    const body = entry.body as unknown as ChangeModelBody;
    if (options.includeInactive !== true && body.isActive === false) continue;
    out.push({ slug: entry.slug, name: entry.name, version: entry.version, body });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — Creating
// ═════════════════════════════════════════════════════════════════════════════
//
// Argument order across the whole write half of this file:
//   create      (tenantId, input, actor, trx?)          — pinned by the contract
//   everything  (tenantId, actor, ticketId, input, trx?) — the shape
//   else                                                  `problem.service` and
//                                                         `ticket.service` use,
//                                                         and the one
//                                                         `changes.routes.ts`
//                                                         calls.

/**
 * The ticket half of `POST /api/changes`, when the caller is opening a new
 * ticket rather than attaching a change record to one that exists.
 *
 * `recordType` is fixed by this module and `occurredAt` is absent by
 * construction (HARD RULE 6): a change has no "when did it happen", it has a
 * PLANNED window, which is a different kind of time in different columns.
 */
export type ChangeTicketDraft = Omit<
  Parameters<typeof ticketService.create>[2],
  'recordType' | 'occurredAt' | 'ruleSlug'
>;

export interface CreateChangeInput {
  /** Attach to an EXISTING `record_type = 'change'` ticket. */
  ticketId?: number;
  /** Or open one. Exactly one of `ticketId` and `ticket`. */
  ticket?: ChangeTicketDraft;

  changeType?: ChangeType;
  /** HARD RULE 3 — a `change_model` slug. Its plans are COPIED, never linked. */
  modelSlug?: string | null;

  /**
   * `POST /from-model` only. Applied through `setPlannedWindow`, so committing
   * a date at creation goes through the SAME capability check and the SAME
   * conflict scan as committing one later. A template is not a side door.
   */
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;

  major?: boolean;
  failureLikelihood?: FailureLikelihood | null;
  implementationMd?: string | null;
  backoutMd?: string | null;
  testMd?: string | null;
}

/**
 * Raise a change.
 *
 * IT ACCEPTS A THIN RECORD, AND THAT IS THE WHOLE POINT (HARD RULE 12). A
 * change is raised as a one-line idea — "we need to move the DNS forwarders" —
 * and fleshed out over a week. Only `change_type` is needed; no plan, no window,
 * no likelihood. Demanding them here is exactly the trap the previous module
 * fell into: a form that posts an empty field the schema refuses, and a 400 on
 * every click. Completeness is demanded at the SCHEDULE gate and nowhere else.
 *
 * The one thing that is NOT optional is structural: `changes_emergency_pir_ck`
 * means an `emergency` change must carry `pir_required = true` IN THE SAME
 * INSERT — the column defaults to false, so relying on a later UPDATE produces
 * a 23514 instead of a change.
 *
 * HARD RULE 6: `tickets.occurred_at` is never written by this module, neither
 * set nor cleared. A change is not something that happened to you, it is
 * something you intend to do, and borrowing that column for a window would
 * corrupt the one column Rewind rests on across every incident that shares the
 * table.
 */
export async function create(
  tenantId: number,
  actor: ActorContext,
  input: CreateChangeInput,
  trx?: Knex.Transaction,
): Promise<ChangeWithRelations> {
  assertTenantId(tenantId);
  if (!actorHas(actor, CAPABILITIES.CHANGE_RW)) {
    throw forbidden(CAPABILITIES.CHANGE_RW, 'raise a change');
  }

  return inTransaction(trx, async (tx) => {
    // ── The model, resolved BEFORE anything is written, so its plans and its
    //    defaults can seed both the ticket and the change in one pass.
    const modelSlug = lower(input.modelSlug);
    let model: { slug: string; version: number; body: ChangeModelBody } | null = null;
    if (modelSlug) {
      const published = await loadPublishedOne(tenantId, MODEL_KIND, modelSlug, tx);
      if (!published) {
        throw new AppError(404, `No published change model named "${modelSlug}"`, {
          code: 'not_found',
        });
      }
      if (published.bodyFormatVersion > CONFIG_BODY_FORMAT_VERSIONS[MODEL_KIND]) {
        throw new AppError(
          422,
          `The change model "${modelSlug}" was written by a newer version of Oblidesk and cannot be read here`,
          { code: 'config_unreadable' },
        );
      }
      model = {
        slug: published.slug,
        version: published.version,
        body: published.body as unknown as ChangeModelBody,
      };
    }

    const changeType: ChangeType = input.changeType ?? model?.body.changeType ?? 'normal';

    // ── The ticket: either the one we were handed, or a new one ─────────────
    let ticketId: number;
    let createdTicket: Awaited<ReturnType<typeof ticketService.create>> | null = null;

    if (input.ticketId !== undefined) {
      const existing = await loadTicketHeaderRow(tenantId, input.ticketId, tx);
      if (!existing) throw new AppError(404, 'Ticket not found', { code: 'not_found' });
      if (existing.record_type !== 'change') {
        throw new AppError(400, 'That ticket is not a change', { code: 'validation_failed' });
      }
      const already = await loadChangeRow(tenantId, input.ticketId, tx);
      if (already) {
        throw new AppError(409, 'That ticket already carries a change record', {
          code: 'conflict',
          payload: { ticketId: input.ticketId },
        });
      }
      ticketId = input.ticketId;
    } else {
      const draft = input.ticket;
      const subject = (draft?.subject ?? '').trim();
      if (!draft || subject === '') {
        throw new AppError(400, 'A subject is required to raise a change', {
          code: 'validation_failed',
          fieldErrors: { subject: 'A subject is required' },
        });
      }
      createdTicket = await ticketService.create(
        tenantId,
        actor,
        {
          ...draft,
          recordType: 'change',
          subject,
          // The model SEEDS what the draft did not say. It never overrides the
          // person filling the form in: a template is a starting point.
          queueSlug: draft.queueSlug ?? model?.body.queueSlug ?? undefined,
          prioritySlug: draft.prioritySlug ?? model?.body.prioritySlug ?? undefined,
          impact: draft.impact ?? model?.body.impact ?? undefined,
          source: draft.source ?? 'web',
          ruleSlug: CHANGE_ENGINE_SLUG,
        },
        tx,
      );
      ticketId = createdTicket.id;
    }

    const failureLikelihood =
      input.failureLikelihood ?? model?.body.failureLikelihood ?? null;

    const implementationMd = input.implementationMd ?? model?.body.implementationMd ?? null;
    const backoutMd = input.backoutMd ?? model?.body.backoutMd ?? null;
    const testMd = input.testMd ?? model?.body.testMd ?? null;

    // THE STRUCTURAL TOOTH: `pir_required` in the SAME statement, or 23514.
    const pirRequired = changeType === 'emergency';

    const inserted = (await insertScoped(
      'changes',
      tenantId,
      {
        ticket_id: ticketId,
        change_type: changeType,
        model_slug: model?.slug ?? null,
        model_version: model?.version ?? null,
        failure_likelihood: failureLikelihood,
        implementation_md: implementationMd,
        implementation_html: implementationMd ? renderMarkdown(implementationMd) : null,
        backout_md: backoutMd,
        backout_html: backoutMd ? renderMarkdown(backoutMd) : null,
        test_md: testMd,
        test_html: testMd ? renderMarkdown(testMd) : null,
        major: input.major === true,
        pir_required: pirRequired,
      },
      tx,
    ).returning('*')) as unknown as ChangeRow[];

    if (inserted.length === 0) throw new AppError(500, 'The change record could not be created');

    if (model) {
      await withDecision(
        decisionContext(
          tenantId,
          ticketId,
          CHANGE_DECISIONS.createdFromModel,
          actor,
          tx,
          { modelSlug: model.slug, modelVersion: model.version, changeType },
        ),
        async (recorder) => {
          recorder
            .rule(model.slug, model.version)
            .decide(
              `change raised from model "${model.slug}" v${model.version}; the plans were COPIED, not linked, so the plan that is executed stays readable exactly as it was approved`,
            )
            .outcome({
              copied: {
                implementationMd: implementationMd !== null,
                backoutMd: backoutMd !== null,
                testMd: testMd !== null,
              },
              seeded: {
                impact: model.body.impact ?? null,
                failureLikelihood: model.body.failureLikelihood ?? null,
                queueSlug: model.body.queueSlug ?? null,
                prioritySlug: model.body.prioritySlug ?? null,
              },
            });
        },
      );
    }

    // The band, computed on the same code path so the file opens with a risk
    // rather than with a blank chip nobody knows how to fill in.
    await recomputeRisk(tenantId, actor, ticketId, { trx: tx, force: true });

    // A window proposed by `POST /from-model` goes through the ONE door that
    // commits the desk to a date: same capability, same conflict scan, same
    // decision row. A template that could book a slot without them would be a
    // fifth door around four locked ones.
    if (input.plannedStartAt && input.plannedEndAt) {
      await setPlannedWindow(
        tenantId,
        actor,
        ticketId,
        {
          baseRowVersion: int(inserted[0].row_version, 1),
          plannedStartAt: input.plannedStartAt,
          plannedEndAt: input.plannedEndAt,
        },
        tx,
      );
    }

    if (createdTicket) {
      // `ticketService.create()` emits nothing when it is handed a transaction,
      // and this one always hands it one.
      const announced = createdTicket;
      afterCommit(tx, () => ticketService.emitTicketCreated(tenantId, announced));
    }

    return requireChange(tenantId, ticketId, tx, actor);
  });
}

/** `POST /api/changes/from-model`. The model is mandatory; the rest is `create`. */
export async function createFromModel(
  tenantId: number,
  actor: ActorContext,
  input: CreateChangeInput & { modelSlug: string },
  trx?: Knex.Transaction,
): Promise<ChangeWithRelations> {
  if (blank(input.modelSlug)) {
    throw new AppError(400, 'A change model slug is required', {
      code: 'validation_failed',
      fieldErrors: { modelSlug: 'A change model slug is required' },
    });
  }
  return create(tenantId, actor, input, trx);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Editing (HARD RULE 12: autosave validates NOTHING)
// ═════════════════════════════════════════════════════════════════════════════

export interface UpdateChangeInput {
  baseRowVersion: number;
  changeType?: ChangeType;
  failureLikelihood?: FailureLikelihood | null;
  implementationMd?: string | null;
  backoutMd?: string | null;
  testMd?: string | null;
  backoutNotApplicable?: boolean;
  backoutWaiverReason?: string | null;
  major?: boolean;
  pirRequired?: boolean;
}

/**
 * Inline autosave, one field at a time.
 *
 * IT VALIDATES NO COMPLETENESS AT ALL (HARD RULE 12). A half-written
 * implementation plan, an empty backout, a change with no window: all legal,
 * all day. Required-ness is asked for once, at the gate, by the SHARED
 * evaluator the client already ran to grey the button out.
 *
 * The two things it does enforce are not completeness, they are structure:
 *
 *   • moving to `emergency` sets `pir_required` in the SAME statement, because
 *     `changes_emergency_pir_ck` would otherwise reject the update with a 23514
 *     the user cannot act on;
 *   • clearing `pir_required` on an emergency change is refused in words rather
 *     than by the constraint, for the same reason.
 *
 * The waiver's own reason is NOT demanded here — the database CHECK
 * (`changes_backout_waiver_ck`) is, so the pair must move together in one
 * statement, and the SHARED gate is what explains a missing reason before the
 * user ever reaches a constraint.
 */
export async function update(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: UpdateChangeInput,
  trx?: Knex.Transaction,
): Promise<ChangeWithRelations> {
  assertTenantId(tenantId);
  if (!actorHas(actor, CAPABILITIES.CHANGE_RW)) {
    throw forbidden(CAPABILITIES.CHANGE_RW, 'edit a change');
  }

  return inTransaction(trx, async (tx) => {
    const current = await requireChangeRow(tenantId, ticketId, tx, true);
    const patch: Record<string, unknown> = {};

    const nextType: ChangeType = input.changeType ?? (current.change_type as ChangeType);
    if (input.changeType !== undefined && input.changeType !== current.change_type) {
      patch.change_type = input.changeType;
    }

    if (input.failureLikelihood !== undefined) patch.failure_likelihood = input.failureLikelihood;
    if (input.major !== undefined) patch.major = input.major;

    if (input.implementationMd !== undefined) {
      patch.implementation_md = input.implementationMd;
      patch.implementation_html = input.implementationMd ? renderMarkdown(input.implementationMd) : null;
    }
    if (input.backoutMd !== undefined) {
      patch.backout_md = input.backoutMd;
      patch.backout_html = input.backoutMd ? renderMarkdown(input.backoutMd) : null;
    }
    if (input.testMd !== undefined) {
      patch.test_md = input.testMd;
      patch.test_html = input.testMd ? renderMarkdown(input.testMd) : null;
    }

    // The waiver and its reason move together: the CHECK is on the pair.
    if (input.backoutNotApplicable !== undefined) {
      patch.backout_not_applicable = input.backoutNotApplicable;
      if (input.backoutNotApplicable === false && input.backoutWaiverReason === undefined) {
        patch.backout_waiver_reason = null;
      }
    }
    if (input.backoutWaiverReason !== undefined) {
      patch.backout_waiver_reason = input.backoutWaiverReason;
    }
    const waiving =
      (input.backoutNotApplicable ?? current.backout_not_applicable) === true;
    const waiverReason =
      input.backoutWaiverReason !== undefined
        ? input.backoutWaiverReason
        : current.backout_waiver_reason;
    if (waiving && blank(waiverReason)) {
      throw new AppError(
        422,
        'Say why no backout plan is needed. A waiver without a reason is a blank field with a tick next to it.',
        {
          code: 'validation_failed',
          fieldErrors: { backoutWaiverReason: 'A reason is required to waive the backout plan' },
        },
      );
    }

    // pir_required: an emergency change may never carry false (the CHECK), and
    // an engine that armed a review must not be un-armed by an autosave.
    if (nextType === 'emergency') {
      if (input.pirRequired === false) {
        throw new AppError(
          422,
          'Every emergency change owes a post-implementation review. That is not configurable.',
          { code: 'validation_failed', fieldErrors: { pirRequired: 'Emergency changes always owe a review' } },
        );
      }
      if (current.pir_required !== true) patch.pir_required = true;
    } else if (input.pirRequired !== undefined) {
      patch.pir_required = input.pirRequired;
    }

    // Nothing to write is not an error: an autosave debounce can fire with no
    // net change. Answer with the current row so the client stays in sync.
    if (Object.keys(patch).length === 0) {
      return requireChange(tenantId, ticketId, tx, actor);
    }

    const updated = (await scoped('changes', tenantId, tx)
      .where('changes.ticket_id', ticketId)
      .where('changes.row_version', input.baseRowVersion)
      .update({ ...patch, row_version: tx.raw('row_version + 1'), updated_at: tx.fn.now() })
      .returning('*')) as unknown as ChangeRow[];

    if (updated.length === 0) {
      throw new ChangeVersionConflictError(
        await requireChange(tenantId, ticketId, tx, actor),
        Object.keys(patch),
      );
    }

    // Three of those fields are risk INPUTS. Recomputing on the same code path
    // is what stops a change from being scheduled against a band computed from
    // facts that changed an hour ago.
    const touchedRisk =
      input.failureLikelihood !== undefined ||
      input.backoutMd !== undefined ||
      input.backoutNotApplicable !== undefined;
    if (touchedRisk) await recomputeRisk(tenantId, actor, ticketId, { trx: tx });

    return requireChange(tenantId, ticketId, tx, actor);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — Risk
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Recompute the band from the matrix and the two hard floors.
 *
 * THE TWO INVARIANTS, both of which exist so the desk can later ask "how often
 * do we overrule our own risk matrix, and in which direction":
 *
 *   • `risk_computed` always tracks the MATRIX. It is never overwritten with a
 *     human's answer, because that number is what proves the matrix wrong and
 *     it is unreconstructable once decision rows age out.
 *   • `risk` is only rewritten while `risk_overridden_at IS NULL`. After an
 *     override the engine STOPS: silently re-deriving over a human's judgement
 *     teaches people the field is a lie and they stop using it. Drift is
 *     reported instead, as a `riskDrifted` row with outcome noop, which changes
 *     no column and leaves the human in charge.
 *
 * VOLUMETRICS, stated because a decision row is cheap to write and expensive to
 * read: when the band has not moved and was already stored, this function
 * writes NO row. It took no action. That is the same ruling `change.ts` makes
 * for the sweeper census, and the opposite of the one it makes for the
 * synchronous conflict check — which DOES log its clean result, because there
 * the clean result is the answer somebody asked for. Pass `force` to log
 * regardless; creation does.
 */
export async function recomputeRisk(
  tenantId: number,
  actor: ActorContext | null,
  ticketId: number,
  options: { trx?: Knex.Transaction; force?: boolean } = {},
): Promise<ChangeRisk | null> {
  assertTenantId(tenantId);

  return inTransaction(options.trx, async (tx) => {
    const row = await requireChangeRow(tenantId, ticketId, tx);
    const change = mapChangeRow(row);
    const headerRow = await loadTicketHeaderRow(tenantId, ticketId, tx);
    const ticket = headerRow ? mapTicketHeaderRow(headerRow) : null;
    const { worst } = await loadTouchedCis(
      tenantId,
      ticketId,
      headerRow?.primary_ci_id ?? null,
      tx,
    );

    const loaded = await loadChangePolicy(
      tenantId,
      change.policySlug ?? CHANGE_POLICY_DEFAULT_SLUG,
      tx,
    );

    const result = computeChangeRisk({
      impact: ticket?.impact ?? null,
      failureLikelihood: change.failureLikelihood,
      worstCiCriticality: worst,
      hasBackoutPlan: !blank(change.backoutMd),
      backoutWaived: change.backoutNotApplicable,
      matrix: loaded.body.riskMatrix,
    });

    const overridden = change.riskOverriddenAt !== null;
    const computedChanged = change.riskComputed !== result.band;
    const riskChanged = !overridden && change.risk !== result.band;
    const policyChanged =
      change.policySlug !== loaded.slug || change.policyVersion !== loaded.version;

    if (!computedChanged && !riskChanged && !policyChanged && options.force !== true) {
      return change.risk;
    }

    const patch: Record<string, unknown> = {
      risk_computed: result.band,
      policy_slug: loaded.slug,
      policy_version: loaded.version,
      updated_at: tx.fn.now(),
    };
    // `row_version` is deliberately NOT bumped: this is a DERIVED value, never
    // a field a human edits, and bumping it would 409 the plan workshop for a
    // change it does not care about. Same ruling `problem.service` makes for
    // its rollups; `updated_at` still moves, so a client that cares can tell.
    if (!overridden) patch.risk = result.band;

    await scoped('changes', tenantId, tx).where('changes.ticket_id', ticketId).update(patch);

    const policyStamp = { policySlug: loaded.slug, policyVersion: loaded.version };

    await withDecision(
      decisionContext(
        tenantId,
        ticketId,
        CHANGE_DECISIONS.riskComputed,
        actor,
        tx,
        {
          impact: ticket?.impact ?? null,
          failureLikelihood: change.failureLikelihood,
          worstCiCriticality: worst,
          hasBackoutPlan: !blank(change.backoutMd),
          backoutWaived: change.backoutNotApplicable,
          matrixKey: result.matrixKey,
        },
        policyStamp,
      ),
      async (recorder) => {
        recorder
          .decide(
            `risk computed as ${result.band} (matrix ${result.matrixKey} said ${result.matrixBand}` +
              `${result.floorsApplied.length > 0 ? `, floors: ${result.floorsApplied.join(', ')}` : ''})`,
          )
          .outcome({
            band: result.band,
            matrixBand: result.matrixBand,
            floorsApplied: result.floorsApplied,
            stored: !overridden,
          });
      },
    );

    if (overridden && computedChanged) {
      await withDecision(
        decisionContext(
          tenantId,
          ticketId,
          CHANGE_DECISIONS.riskDrifted,
          actor,
          tx,
          { from: change.riskComputed, to: result.band, humanBand: change.risk },
          policyStamp,
        ),
        async (recorder) => {
          recorder
            .decide(
              `the matrix now says ${result.band} but a human set this change to ${change.risk ?? 'nothing'}; the human stays in charge and no column was rewritten`,
            )
            .noop('risk_overridden_by_human');
        },
      );
    }

    return overridden ? change.risk : result.band;
  });
}

export interface OverrideRiskInput {
  baseRowVersion: number;
  risk: ChangeRisk;
  reason: string;
}

/**
 * A human disagrees with the matrix.
 *
 * `risk_computed` is left exactly as it was — the override is a second opinion
 * recorded beside the first, never a rewrite of it. The reason is mandatory in
 * words here as well as in `changes_risk_override_ck`, so the user reads a
 * sentence instead of a 23514.
 */
export async function overrideRisk(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: OverrideRiskInput,
  trx?: Knex.Transaction,
): Promise<ChangeWithRelations> {
  assertTenantId(tenantId);
  if (!actorHas(actor, CAPABILITIES.CHANGE_RW)) {
    throw forbidden(CAPABILITIES.CHANGE_RW, 'override the risk of a change');
  }
  if (blank(input.reason)) {
    throw new AppError(422, 'Say why you disagree with the computed risk band', {
      code: 'validation_failed',
      fieldErrors: { reason: 'A reason is required to override the risk band' },
    });
  }
  if (actor.userId === null) {
    // `changes_risk_override_ck` demands a named human. An anonymous override is
    // the same as no control at all, so it is refused in words.
    throw new AppError(422, 'Only a signed-in user can override a risk band', {
      code: 'validation_failed',
    });
  }

  return inTransaction(trx, async (tx) => {
    const current = await requireChangeRow(tenantId, ticketId, tx, true);
    const before = mapChangeRow(current);

    const updated = (await scoped('changes', tenantId, tx)
      .where('changes.ticket_id', ticketId)
      .where('changes.row_version', input.baseRowVersion)
      .update({
        risk: input.risk,
        risk_overridden_by: actor.userId,
        risk_overridden_at: tx.fn.now(),
        risk_override_reason: input.reason.trim(),
        row_version: tx.raw('row_version + 1'),
        updated_at: tx.fn.now(),
      })
      .returning('*')) as unknown as ChangeRow[];

    if (updated.length === 0) {
      throw new ChangeVersionConflictError(await requireChange(tenantId, ticketId, tx, actor), ['risk']);
    }

    await withDecision(
      decisionContext(tenantId, ticketId, CHANGE_DECISIONS.riskOverridden, actor, tx, {
        from: before.risk,
        computed: before.riskComputed,
        to: input.risk,
        reason: input.reason.trim(),
      }),
      async (recorder) => {
        recorder
          .decide(
            `risk overridden from ${before.risk ?? 'unset'} to ${input.risk} by a human; the matrix still says ${before.riskComputed ?? 'nothing'}`,
          )
          .outcome({ risk: input.risk, riskComputed: before.riskComputed, overriddenBy: actor.userId });
      },
    );

    return requireChange(tenantId, ticketId, tx, actor);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — The window, the baseline, and the consent that hangs off it
// ═════════════════════════════════════════════════════════════════════════════

export interface SetWindowInput {
  baseRowVersion: number;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
}

export interface SetWindowResult {
  change: ChangeWithRelations;
  conflicts: ChangeConflictView[];
  gate: ChangeGateEvaluation;
}

/**
 * Commit the change to a maintenance window — and say straight away what is in
 * the way.
 *
 * THE CONFLICTS ARE RECOMPUTED SYNCHRONOUSLY AND RETURNED IN THE MUTATION
 * RESPONSE, while the date picker is still open. A conflict discovered at the
 * CAB is a conflict discovered after somebody promised a customer a date, and
 * by then moving is expensive in a way it was not thirty seconds earlier.
 *
 * When a window already exists this delegates to `moveWindow`, which is where
 * the tolerance test and the approval invalidation live. One door for the
 * route, two behaviours, and the second one is never skipped by accident.
 */
export async function setPlannedWindow(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: SetWindowInput,
  trx?: Knex.Transaction,
): Promise<SetWindowResult> {
  assertTenantId(tenantId);
  if (!actorHas(actor, CAPABILITIES.CHANGE_SCHEDULE)) {
    throw forbidden(CAPABILITIES.CHANGE_SCHEDULE, 'set the window of a change');
  }

  return inTransaction(trx, async (tx) => {
    const current = await requireChangeRow(tenantId, ticketId, tx, true);
    const before = mapChangeRow(current);
    if (plannedWindowOf(before) !== null) {
      return moveWindow(tenantId, actor, ticketId, input, tx);
    }
    return applyWindow(tenantId, ticketId, input, actor, tx, current, 'planned');
  });
}

/**
 * Move a window that was already committed.
 *
 * AN APPROVAL IS CONSENT TO A SPECIFIC WINDOW. Carrying it silently onto
 * another one is consent nobody gave, so a move beyond the policy's tolerance
 * does not merely warn: it cancels the pending rounds and re-opens the ones
 * that had been granted, and it says so in a decision row naming every slug.
 * Fifteen minutes of drift is the same window; an hour is a different night for
 * whoever is on call.
 *
 * `baseline_*` is NEVER edited here. That is the whole reason it exists: on-time
 * delivery measured against a window somebody moved yesterday to make it true
 * is not a measurement.
 */
export async function moveWindow(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: SetWindowInput,
  trx?: Knex.Transaction,
): Promise<SetWindowResult> {
  assertTenantId(tenantId);
  if (!actorHas(actor, CAPABILITIES.CHANGE_SCHEDULE)) {
    throw forbidden(CAPABILITIES.CHANGE_SCHEDULE, 'move the window of a change');
  }

  return inTransaction(trx, async (tx) => {
    const current = await requireChangeRow(tenantId, ticketId, tx, true);
    return applyWindow(tenantId, ticketId, input, actor, tx, current, 'moved');
  });
}

async function applyWindow(
  tenantId: number,
  ticketId: number,
  input: SetWindowInput,
  actor: ActorContext,
  tx: Knex.Transaction,
  current: ChangeRow,
  kind: 'planned' | 'moved',
): Promise<SetWindowResult> {
  const before = mapChangeRow(current);

  const startAt = input.plannedStartAt ?? null;
  const endAt = input.plannedEndAt ?? null;
  // `changes_planned_pair_ck`: both ends or neither. Refused in words rather
  // than by the constraint, so the picker can point at the field.
  if ((startAt === null) !== (endAt === null)) {
    throw new AppError(422, 'A maintenance window needs both a start and an end', {
      code: 'validation_failed',
      fieldErrors: {
        [startAt === null ? 'plannedStartAt' : 'plannedEndAt']: 'Both ends of the window are required',
      },
    });
  }
  if (startAt !== null && endAt !== null && Date.parse(endAt) <= Date.parse(startAt)) {
    throw new AppError(422, 'The window must end after it starts', {
      code: 'validation_failed',
      fieldErrors: { plannedEndAt: 'The window must end after it starts' },
    });
  }

  const updated = (await scoped('changes', tenantId, tx)
    .where('changes.ticket_id', ticketId)
    .where('changes.row_version', input.baseRowVersion)
    .update({
      planned_start_at: startAt,
      planned_end_at: endAt,
      row_version: tx.raw('row_version + 1'),
      updated_at: tx.fn.now(),
    })
    .returning('*')) as unknown as ChangeRow[];

  if (updated.length === 0) {
    throw new ChangeVersionConflictError(await requireChange(tenantId, ticketId, tx, actor), [
      'plannedStartAt',
      'plannedEndAt',
    ]);
  }

  const after = mapChangeRow(updated[0]);
  const newWindow = plannedWindowOf(after);

  const headerRow = await loadTicketHeaderRow(tenantId, ticketId, tx);
  const ticket = headerRow ? mapTicketHeaderRow(headerRow) : null;
  const { worst } = await loadTouchedCis(tenantId, ticketId, headerRow?.primary_ci_id ?? null, tx);
  const policy = await resolvePolicyFor(tenantId, after, ticket, worst, tx);
  const policyStamp = { policySlug: policy.policySlug, policyVersion: policy.policyVersion };

  // ── The tolerance test, and the consent it may invalidate ────────────────
  const baseline = baselineWindowOf(after);
  const exceeded =
    kind === 'moved' &&
    changeWindowMoveExceedsTolerance(baseline, newWindow, policy.windowMoveToleranceMinutes);
  let invalidated: string[] = [];

  if (exceeded) {
    invalidated = await reopenConsent(tenantId, ticketId, policy, actor, tx);
  }

  await withDecision(
    decisionContext(
      tenantId,
      ticketId,
      kind === 'planned' ? CHANGE_DECISIONS.windowPlanned : CHANGE_DECISIONS.windowMoved,
      actor,
      tx,
      {
        from: { startAt: before.plannedStartAt, endAt: before.plannedEndAt },
        to: { startAt: after.plannedStartAt, endAt: after.plannedEndAt },
        baseline: baseline ?? null,
        toleranceMinutes: policy.windowMoveToleranceMinutes,
      },
      policyStamp,
    ),
    async (recorder) => {
      recorder
        .decide(
          kind === 'planned'
            ? `window committed: ${after.plannedStartAt ?? 'unset'} → ${after.plannedEndAt ?? 'unset'}`
            : `window moved to ${after.plannedStartAt ?? 'unset'} → ${after.plannedEndAt ?? 'unset'}` +
              (exceeded
                ? `, beyond the ${policy.windowMoveToleranceMinutes} minute tolerance, so consent was re-opened`
                : ' — inside tolerance, consent stands'),
        )
        .outcome({
          plannedStartAt: after.plannedStartAt,
          plannedEndAt: after.plannedEndAt,
          exceededTolerance: exceeded,
          invalidatedApprovals: invalidated,
          rowVersion: after.rowVersion,
        });
    },
  );

  // ── The conflict scan, synchronous, in this transaction ──────────────────
  const conflicts = await scanConflicts(tenantId, ticketId, after, policy, actor, tx);

  // With no approval to wait for, the commitment IS the promise: latch the
  // baseline now so on-time delivery has something honest to measure against.
  await maybeFreezeBaseline(tenantId, actor, ticketId, tx);

  const change = await requireChange(tenantId, ticketId, tx, actor);
  const context = await assembleContext(tenantId, ticketId, tx);
  return {
    change,
    conflicts: change.conflicts ?? conflicts,
    gate: scheduleGateOf(context, actor),
  };
}

/**
 * Re-open consent after a window move that exceeded the tolerance.
 *
 * A DECIDED approval cannot be cancelled — `approval.service` refuses that
 * outright, and it is right to: "une décision ne se réécrit pas", and rewriting
 * one would destroy the record of what was actually agreed. So invalidation is
 * expressed the only honest way: the still-pending rounds are cancelled (they
 * were being asked about a window that no longer exists) and a FRESH round is
 * started for every slug the policy selects. The old approved rows stay exactly
 * where they are, attached to the window they were given for.
 */
async function reopenConsent(
  tenantId: number,
  ticketId: number,
  policy: ChangePolicyResolution,
  actor: ActorContext,
  tx: Knex.Transaction,
): Promise<string[]> {
  const selected = policy.approvals;
  if (selected.length === 0) return [];

  const before = await loadApprovalFacts(tenantId, ticketId, tx);
  const affected = selected.filter((selection) => {
    const state = before.bySlug.get(selection.slug);
    return state === 'pending' || state === 'approved';
  });
  if (affected.length === 0) return [];

  const pendingRows = (await scoped('approvals', tenantId, tx)
    .where('approvals.ticket_id', ticketId)
    .where('approvals.state', 'pending')
    .select('approvals.id', 'approvals.definition_slug')) as unknown as Array<{
    id: number | string;
    definition_slug: string;
  }>;

  for (const row of pendingRows) {
    const slug = lower(row.definition_slug);
    if (!slug || !affected.some((selection) => selection.slug === slug)) continue;
    await approvalService.cancelApproval(tenantId, int(row.id), 'change_window_moved', {
      actorId: actor.userId ?? null,
      trx: tx,
    });
  }

  for (const selection of affected) {
    await approvalService.startApproval({
      tenantId,
      ticketId,
      definitionSlug: selection.slug,
      actorId: actor.userId ?? null,
      actorType: actor.actorType,
      force: true,
      trx: tx,
    });
  }

  const slugs = affected.map((selection) => selection.slug);
  await withDecision(
    decisionContext(
      tenantId,
      ticketId,
      CHANGE_DECISIONS.approvalInvalidatedByWindowMove,
      actor,
      tx,
      { slugs, toleranceMinutes: policy.windowMoveToleranceMinutes },
      { policySlug: policy.policySlug, policyVersion: policy.policyVersion },
    ),
    async (recorder) => {
      recorder
        .decide(
          `the window moved beyond tolerance, so consent was re-opened for ${slugs.join(', ')}; an approval is consent to a SPECIFIC window`,
        )
        .outcome({ slugs, restarted: slugs.length });
    },
  );

  return slugs;
}

/**
 * The synchronous planning check.
 *
 * The conflict engine owns the query, the cache and its own `conflictEvaluated`
 * row. What this function owns is the guarantee that the check HAPPENED — and
 * the honesty when it did not: an absent or failing engine writes a row saying
 * NOT EVALUATED rather than a row claiming a clean window nobody looked at. A
 * row that asserts what did not happen is worse than a row that is absent.
 */
async function scanConflicts(
  tenantId: number,
  ticketId: number,
  change: Change,
  policy: ChangePolicyResolution,
  actor: ActorContext | null,
  tx: Knex.Transaction,
): Promise<ChangeConflictView[]> {
  const engine = conflictEngine();
  const run = engine?.refresh ?? engine?.detect;

  if (!run) {
    await withDecision(
      decisionContext(
        tenantId,
        ticketId,
        CHANGE_DECISIONS.conflictEvaluated,
        actor,
        tx,
        { window: plannedWindowOf(change), engine: 'changeConflict.service' },
        { policySlug: policy.policySlug, policyVersion: policy.policyVersion },
      ),
      async (recorder) => {
        recorder
          .decide('conflict detection did not run: the conflict engine is not available in this deployment')
          .noop('conflict_engine_unavailable');
      },
    );
    return [];
  }

  try {
    await run.call(engine, tenantId, ticketId, {
      trx: tx,
      executor: tx,
      actorId: actor?.userId ?? null,
      // A human is choosing a date, so the CLEAN result is logged too: "we
      // checked your window and it is clear" is exactly the answer they asked
      // for, and silence is never evidence.
      mode: 'planning',
    });
  } catch (error) {
    logger.warn(
      { err: error, tenantId, ticketId },
      'Change module: synchronous conflict scan failed',
    );
    await withDecision(
      decisionContext(
        tenantId,
        ticketId,
        CHANGE_DECISIONS.conflictEvaluated,
        actor,
        tx,
        { window: plannedWindowOf(change) },
        { policySlug: policy.policySlug, policyVersion: policy.policyVersion },
      ),
      async (recorder) => {
        recorder
          .decide('conflict detection failed: this window has NOT been checked')
          .noop('conflict_scan_failed');
      },
    );
    return [];
  }

  return listConflicts(tenantId, ticketId, { executor: tx });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13 — Approvals: SELECTION here, mechanics in approval.service
// ═════════════════════════════════════════════════════════════════════════════

export interface RequestApprovalResult {
  started: ChangeApprovalSelection[];
  approvals: Awaited<ReturnType<typeof approvalService.listForTicket>>;
  gate: ChangeGateEvaluation;
}

/**
 * Ask for the change's approvals.
 *
 * THE SCHEDULE GATE RUNS FIRST, AND THAT IS THE POINT. The CAB reads the plans,
 * so the plans have to exist when the approval is REQUESTED, not when it is
 * answered — which is why `evaluateChangeSchedule` has three callers rather than
 * two: the client button, the transition path, and this function.
 *
 * Every selected slug is started with `force: true`. The SELECTION has already
 * decided; letting the definition's own `requiredWhen` decide again is two
 * policies answering one question, and when they disagree the approval silently
 * does not start. The corollary the config linter must enforce: an `approval`
 * named by a `change_policy` may carry NO `requiredWhen`, or the transition
 * hook that runs `startRequiredApprovals` on every non-terminal move starts it
 * a second time — two pending approvals, two inboxes, one change.
 *
 * An EMPTY selection is a decision too, and it is written down. "No approval was
 * needed" has to be a row: a year later, silence is indistinguishable from an
 * engine that never ran.
 */
export async function requestApproval(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: { baseRowVersion?: number },
  trx?: Knex.Transaction,
): Promise<RequestApprovalResult> {
  assertTenantId(tenantId);
  if (!actorHas(actor, CAPABILITIES.CHANGE_RW)) {
    throw forbidden(CAPABILITIES.CHANGE_RW, 'request approval for a change');
  }

  return inTransaction(trx, async (tx) => {
    const row = await requireChangeRow(tenantId, ticketId, tx, true);
    if (
      input.baseRowVersion !== undefined &&
      int(row.row_version, 1) !== input.baseRowVersion
    ) {
      throw new ChangeVersionConflictError(await requireChange(tenantId, ticketId, tx, actor), []);
    }

    // The band decides which approvals apply, so it is recomputed first.
    await recomputeRisk(tenantId, actor, ticketId, { trx: tx });

    const context = await assembleContext(tenantId, ticketId, tx);
    const policyStamp = {
      policySlug: context.policy.policySlug,
      policyVersion: context.policy.policyVersion,
    };

    const gate = scheduleGateOf(context, actor);
    if (!gate.allowed) {
      await recordRefusal(
        tenantId,
        ticketId,
        CHANGE_DECISIONS.scheduleBlocked,
        actor,
        { at: 'approval_request', toCategory: null },
        {
          blockers: gate.blockers.map((blocker) => blocker.code),
          missingCapabilities: gate.missingCapabilities,
        },
        policyStamp,
      );
      throw new ChangeGateError(
        'This change is not ready to be sent for approval',
        gate,
      );
    }

    // `resolveChangePolicy` already ran `selectChangeApprovals` over these exact
    // facts, and the resolution is what the client was shown as
    // `selectedApprovals`. Re-selecting here would be a second evaluation that
    // could disagree with the first — which is the whole class of bug this
    // module refuses to reintroduce.
    const selected = context.policy.approvals;

    if (selected.length === 0) {
      await withDecision(
        decisionContext(
          tenantId,
          ticketId,
          CHANGE_DECISIONS.approvalNotSelected,
          actor,
          tx,
          {
            changeType: context.change.changeType,
            risk: context.change.risk,
            queueSlug: context.ticket?.queueSlug ?? null,
            worstCiCriticality: context.worstCiCriticality,
          },
          policyStamp,
        ),
        async (recorder) => {
          recorder
            .decide(
              `no approval applies to this change under policy "${context.policy.policySlug}" v${context.policy.policyVersion}; that is a decision, not an omission`,
            )
            .noop('no_approval_selected');
        },
      );
      // Nothing to wait for: the commitment is the promise.
      await maybeFreezeBaseline(tenantId, actor, ticketId, tx);
      return {
        started: [],
        approvals: await approvalService.listForTicket(tenantId, ticketId, { executor: tx }),
        gate,
      };
    }

    await withDecision(
      decisionContext(
        tenantId,
        ticketId,
        CHANGE_DECISIONS.approvalsSelected,
        actor,
        tx,
        {
          changeType: context.change.changeType,
          risk: context.change.risk,
          queueSlug: context.ticket?.queueSlug ?? null,
          worstCiCriticality: context.worstCiCriticality,
        },
        policyStamp,
      ),
      async (recorder) => {
        recorder
          .decide(
            `${selected.length} approval(s) selected: ${selected
              .map((selection) => `${selection.slug} (because ${selection.because})`)
              .join(', ')}`,
          )
          .outcome({ approvals: selected });
      },
    );

    for (const selection of selected) {
      await approvalService.startApproval({
        tenantId,
        ticketId,
        definitionSlug: selection.slug,
        actorId: actor.userId ?? null,
        actorType: actor.actorType,
        force: true,
        trx: tx,
      });
    }

    // An approval may be auto-granted on the spot (a definition whose only
    // approver is the requester, a delegation). Latch the baseline if so.
    await maybeFreezeBaseline(tenantId, actor, ticketId, tx);

    return {
      started: selected,
      approvals: await approvalService.listForTicket(tenantId, ticketId, { executor: tx }),
      gate,
    };
  });
}

/**
 * Freeze the promise.
 *
 * Written EXACTLY ONCE, when there is a window and every selected approval has
 * been granted, and never edited afterwards. Schedule accuracy and on-time
 * delivery are measured against THIS, never against `planned_*` — without it,
 * "we deliver 90% of changes inside their window" is measured against a window
 * somebody moved yesterday to make it true, which is the reason most change
 * tools' on-time number means nothing.
 */
export async function freezeBaseline(
  tenantId: number,
  actor: ActorContext | null,
  ticketId: number,
  trx?: Knex.Transaction,
  options: { quiet?: boolean } = {},
): Promise<Change> {
  assertTenantId(tenantId);
  return inTransaction(trx, async (tx) => {
    const row = await requireChangeRow(tenantId, ticketId, tx, true);
    const change = mapChangeRow(row);
    const headerRow = await loadTicketHeaderRow(tenantId, ticketId, tx);
    const ticket = headerRow ? mapTicketHeaderRow(headerRow) : null;
    const { worst } = await loadTouchedCis(tenantId, ticketId, headerRow?.primary_ci_id ?? null, tx);
    const policy = await resolvePolicyFor(tenantId, change, ticket, worst, tx);
    const policyStamp = { policySlug: policy.policySlug, policyVersion: policy.policyVersion };

    const window = plannedWindowOf(change);
    const already = change.baselineSetAt !== null;

    const approvals = await loadApprovalFacts(tenantId, ticketId, tx);
    const outstanding = policy.approvals.filter(
      (selection) => approvals.bySlug.get(selection.slug) !== 'approved',
    );

    const reason = already
      ? 'baseline_already_frozen'
      : window === null
        ? 'no_planned_window'
        : outstanding.length > 0
          ? 'approvals_outstanding'
          : null;

    if (reason !== null) {
      // `quiet` is the LATCH calling — every window write asks "is the baseline
      // due yet?", and answering "not yet, the CAB has not replied" on each
      // keystroke of a date picker would bury the drawer under rows that record
      // no action. The three not-yet reasons are re-derivable from the row at
      // any moment (no baseline, no window, an unanswered approval), so the
      // absence costs nothing. An EXPLICIT `freezeBaseline()` still explains
      // itself: somebody asked, and "here is why not" is the answer.
      if (options.quiet !== true) {
        await withDecision(
          decisionContext(
            tenantId,
            ticketId,
            CHANGE_DECISIONS.baselineFrozen,
            actor,
            tx,
            { outstanding: outstanding.map((selection) => selection.slug) },
            policyStamp,
          ),
          async (recorder) => {
            recorder.noop(reason);
          },
        );
      }
      return change;
    }

    // `reason === null` already implies a window, but the compiler cannot read
    // a ternary chain as a narrowing, and an assertion here would be a claim
    // rather than a check.
    if (window === null) return change;

    await scoped('changes', tenantId, tx).where('changes.ticket_id', ticketId).update({
      baseline_start_at: window.startAt,
      baseline_end_at: window.endAt,
      baseline_set_at: tx.fn.now(),
      updated_at: tx.fn.now(),
    });

    await withDecision(
      decisionContext(
        tenantId,
        ticketId,
        CHANGE_DECISIONS.baselineFrozen,
        actor,
        tx,
        {
          window,
          approvals: policy.approvals.map((selection) => selection.slug),
        },
        policyStamp,
      ),
      async (recorder) => {
        recorder
          .decide(
            `baseline frozen at ${window.startAt} → ${window.endAt}; every selected approval is granted, so this is the window the desk promised`,
          )
          .outcome({ baselineStartAt: window.startAt, baselineEndAt: window.endAt });
      },
    );

    const refreshed = await requireChangeRow(tenantId, ticketId, tx);
    return mapChangeRow(refreshed);
  });
}

/**
 * Latch the baseline if it is due, and say nothing if it is not.
 *
 * Called from every window write, from `requestApproval` and from
 * `onApprovalDecided`, so the promise is recorded whichever of the three lands
 * last — the baseline cannot depend on one of them being wired. When the
 * baseline IS written it writes its `baselineFrozen` row like any other act;
 * when it is not yet due it writes nothing, because a latch that did not fire
 * took no action (see the `quiet` comment in `freezeBaseline`).
 */
async function maybeFreezeBaseline(
  tenantId: number,
  actor: ActorContext | null,
  ticketId: number,
  tx: Knex.Transaction,
): Promise<void> {
  try {
    await freezeBaseline(tenantId, actor, ticketId, tx, { quiet: true });
  } catch (error) {
    logger.warn({ err: error, tenantId, ticketId }, 'Change module: baseline latch failed');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 14 — Acknowledging conflicts, overriding freezes
// ═════════════════════════════════════════════════════════════════════════════

export interface AcknowledgeConflictsInput {
  baseRowVersion: number;
  reason: string;
  /** The digest the client SAW. A mismatch means new conflicts appeared. */
  digest?: string;
}

/**
 * "I have seen these conflicts, and we are going ahead anyway."
 *
 * ONE MOVE, ONE SEVERITY, ALWAYS ACKNOWLEDGEABLE — and never permanent. The
 * digest is computed over the SET of live conflicts, so a new one changes the
 * digest, the acknowledgement goes stale and the gate closes again. Without
 * that, one click at 09:00 buys immunity from everything discovered at 16:00: a
 * rubber stamp with a database column behind it.
 *
 * FREEZES ARE EXCLUDED from the set, by `acknowledgeableConflicts`, on both
 * sides. A freeze is stored as a conflict row so the operator reads one panel,
 * but a freeze is OVERRIDDEN — different capability, different columns, its own
 * audit trail — and never acknowledged. Folding it in would mean acknowledging a
 * CI overlap quietly also acknowledged a freeze.
 */
export async function acknowledgeConflicts(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: AcknowledgeConflictsInput,
  trx?: Knex.Transaction,
): Promise<ChangeWithRelations> {
  assertTenantId(tenantId);
  if (!actorHas(actor, CAPABILITIES.CHANGE_SCHEDULE)) {
    throw forbidden(CAPABILITIES.CHANGE_SCHEDULE, 'acknowledge a change conflict');
  }
  if (blank(input.reason)) {
    throw new AppError(422, 'Say why this change goes ahead despite the conflict', {
      code: 'validation_failed',
      fieldErrors: { reason: 'A reason is required to acknowledge a conflict' },
    });
  }
  if (actor.userId === null) {
    throw new AppError(422, 'Only a signed-in user can acknowledge a conflict', {
      code: 'validation_failed',
    });
  }

  return inTransaction(trx, async (tx) => {
    await requireChangeRow(tenantId, ticketId, tx, true);

    const live = await loadLiveConflicts(tenantId, ticketId, tx);
    const acknowledgeable = acknowledgeableConflicts(live);
    if (acknowledgeable.length === 0) {
      throw new AppError(409, 'There is nothing to acknowledge on this change', {
        code: 'conflict',
        payload: { conflicts: [] },
      });
    }

    const digest = conflictDigest(acknowledgeable.map(conflictToClassification));
    if (input.digest !== undefined && input.digest !== digest) {
      throw new AppError(
        409,
        'The conflicts changed while you were reading them. Read the new list and acknowledge again.',
        {
          code: 'conflict',
          payload: {
            expected: digest,
            received: input.digest,
            conflicts: await hydrateConflicts(tenantId, live, tx),
          },
        },
      );
    }

    // All four columns move together: `changes_conflict_ack_ck` demands a named
    // human, a digest and a non-blank reason, and an anonymous acknowledgement
    // is the same as no control at all.
    const updated = (await scoped('changes', tenantId, tx)
      .where('changes.ticket_id', ticketId)
      .where('changes.row_version', input.baseRowVersion)
      .update({
        conflict_ack_by: actor.userId,
        conflict_ack_at: tx.fn.now(),
        conflict_ack_reason: input.reason.trim(),
        conflict_ack_digest: digest,
        row_version: tx.raw('row_version + 1'),
        updated_at: tx.fn.now(),
      })
      .returning('*')) as unknown as ChangeRow[];

    if (updated.length === 0) {
      throw new ChangeVersionConflictError(await requireChange(tenantId, ticketId, tx, actor), [
        'conflictAckDigest',
      ]);
    }

    await withDecision(
      decisionContext(tenantId, ticketId, CHANGE_DECISIONS.conflictAcknowledged, actor, tx, {
        digest,
        reason: input.reason.trim(),
        conflicts: acknowledgeable.map((conflict) => ({
          kind: conflict.kind,
          severity: conflict.severity,
          otherTicketId: conflict.otherTicketId,
          ciIds: conflict.ciIds,
        })),
      }),
      async (recorder) => {
        recorder
          .decide(
            `${acknowledgeable.length} conflict(s) acknowledged in writing; this acknowledgement covers exactly this set and goes stale the moment a new one appears`,
          )
          .outcome({ digest, acknowledgedBy: actor.userId, count: acknowledgeable.length });
      },
    );

    return requireChange(tenantId, ticketId, tx, actor);
  });
}

export interface OverrideFreezeInput {
  baseRowVersion: number;
  reason: string;
  /** Freeze slugs being bypassed (HARD RULE 3). Empty means "all that block". */
  slugs?: string[];
}

/**
 * Carry a change through a period the business declared shut.
 *
 * FOUR TRACES, ONE TRANSACTION, and each one exists because the other three are
 * read by different people:
 *
 *   1. the columns          — the change itself says it was overridden, so the
 *                             gate stops blocking and the banner can say why.
 *   2. `decision_log`       — answers "why did this go ahead?" in the Why
 *                             drawer, naming the freeze SLUG and its published
 *                             VERSION so the bypass replays against the body
 *                             that produced it.
 *   3. `audit_log`          — hash-chained. decision_log answers "why"; the
 *                             audit chain answers "and nobody edited that
 *                             answer afterwards".
 *   4. a work note          — visible on the timeline without opening a drawer,
 *                             because the person who asks in six months is not
 *                             the person who knows the drawer exists.
 *
 * The permission question is `evaluateChangeFreezeOverride`, never
 * `isChangeFrozen`. The first is "may this person do it"; the second is "can
 * this person see it". They return the same type and answer different
 * questions, and using the read to authorise the write is the exact defect the
 * previous module's review found.
 */
export async function overrideFreeze(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: OverrideFreezeInput,
  trx?: Knex.Transaction,
): Promise<ChangeWithRelations> {
  assertTenantId(tenantId);
  if (actor.userId === null) {
    throw new AppError(422, 'Only a signed-in user can override a change freeze', {
      code: 'validation_failed',
    });
  }

  return inTransaction(trx, async (tx) => {
    const row = await requireChangeRow(tenantId, ticketId, tx, true);
    const context = await assembleContext(tenantId, ticketId, tx, { row });
    const policyStamp = {
      policySlug: context.policy.policySlug,
      policyVersion: context.policy.policyVersion,
    };

    if (context.freezes === null) {
      // Refusing is the safe answer: overriding a freeze nobody evaluated would
      // record a bypass of something we cannot name.
      throw new AppError(
        503,
        'The freeze calendar could not be read, so there is nothing to override yet',
        { code: 'config_unreadable' },
      );
    }

    const requested = new Set((input.slugs ?? []).map((slug) => slug.toLowerCase()));
    const verdicts =
      requested.size === 0
        ? context.freezes
        : context.freezes.filter((verdict) => requested.has(verdict.slug.toLowerCase()));

    const evaluation = evaluateChangeFreezeOverride({
      verdicts,
      reason: input.reason,
      grantedOverrideApprovals: context.approvals.granted,
      actor: actorGate(actor),
    });

    if (!evaluation.allowed) {
      await recordRefusal(
        tenantId,
        ticketId,
        CHANGE_DECISIONS.freezeBlocked,
        actor,
        { slugs: verdicts.map((verdict) => verdict.slug), attemptedOverride: true },
        {
          blockers: evaluation.blockers.map((blocker) => blocker.code),
          missingCapabilities: evaluation.missingCapabilities,
        },
        policyStamp,
      );
      throw new ChangeGateError('This change freeze may not be overridden', evaluation);
    }

    const blocking = verdicts.filter((verdict) => verdict.severity === 'block');
    if (blocking.length === 0) {
      throw new AppError(409, 'No change freeze is blocking this window', {
        code: 'conflict',
        payload: { verdicts },
      });
    }

    const slugs = [...new Set(blocking.map((verdict) => verdict.slug.toLowerCase()))];
    const reason = input.reason.trim();

    // ── Trace 1: the columns ────────────────────────────────────────────────
    const updated = (await scoped('changes', tenantId, tx)
      .where('changes.ticket_id', ticketId)
      .where('changes.row_version', input.baseRowVersion)
      .update({
        freeze_override_by: actor.userId,
        freeze_override_at: tx.fn.now(),
        freeze_override_reason: reason,
        freeze_override_slugs: JSON.stringify(slugs),
        row_version: tx.raw('row_version + 1'),
        updated_at: tx.fn.now(),
      })
      .returning('*')) as unknown as ChangeRow[];

    if (updated.length === 0) {
      throw new ChangeVersionConflictError(await requireChange(tenantId, ticketId, tx, actor), [
        'freezeOverrideSlugs',
      ]);
    }

    const versions = blocking.map((verdict) => ({ slug: verdict.slug, version: verdict.version }));

    // ── Trace 2: decision_log ───────────────────────────────────────────────
    await withDecision(
      decisionContext(
        tenantId,
        ticketId,
        CHANGE_DECISIONS.freezeOverridden,
        actor,
        tx,
        {
          freezes: versions,
          reason,
          plannedWindow: plannedWindowOf(context.change),
          changeType: context.change.changeType,
          risk: context.change.risk,
        },
        policyStamp,
      ),
      async (recorder) => {
        recorder
          .decide(
            `change freeze ${versions
              .map((entry) => `"${entry.slug}" v${entry.version}`)
              .join(', ')} overridden: ${reason}`,
          )
          .outcome({ slugs, versions, overriddenBy: actor.userId });
      },
    );

    // ── Trace 3: the hash-chained audit row ─────────────────────────────────
    await auditService.record(
      {
        tenantId,
        actorId: actor.userId,
        actorType: actor.actorType,
        action: 'change.freeze.override',
        entityType: 'change',
        entityId: ticketId,
        before: { freezeOverrideSlugs: context.change.freezeOverrideSlugs },
        after: { freezeOverrideSlugs: slugs, reason, freezes: versions },
      },
      tx,
    );

    // ── Trace 4: the work note, readable without a drawer ───────────────────
    await journalService.append(
      {
        tenantId,
        ticketId,
        kind: 'work_note',
        visibility: 'internal',
        authorId: actor.userId,
        authorType: actor.actorType,
        bodyMd:
          `**Change freeze overridden**: ${versions
            .map((entry) => `\`${entry.slug}\` (v${entry.version})`)
            .join(', ')}\n\n${reason}`,
        meta: { changeFreezeSlugs: slugs },
        emit: false,
      },
      tx,
    );

    return requireChange(tenantId, ticketId, tx, actor);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 15 — Implementation, outcome, review
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Hands on the system.
 *
 * An EXPLICIT act, not a side effect of a transition. The operator clicks the
 * status when they sit down and puts hands on the system twenty minutes later,
 * and duration accuracy is the whole reason this column exists — deriving it
 * from the transition would make every measurement of "how long did that
 * actually take" wrong by the size of the gap.
 */
export async function startImplementation(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: { baseRowVersion: number; at?: string },
  trx?: Knex.Transaction,
): Promise<ChangeWithRelations> {
  assertTenantId(tenantId);
  if (!actorHas(actor, CAPABILITIES.CHANGE_RW)) {
    throw forbidden(CAPABILITIES.CHANGE_RW, 'start the implementation of a change');
  }

  return inTransaction(trx, async (tx) => {
    const row = await requireChangeRow(tenantId, ticketId, tx, true);
    const change = mapChangeRow(row);
    if (change.implementationStartedAt !== null) {
      throw new AppError(409, 'This change has already been started', {
        code: 'conflict',
        payload: { implementationStartedAt: change.implementationStartedAt },
      });
    }

    // Starting is a STRONGER commitment than scheduling, so it re-runs the
    // schedule gate rather than trusting the one that ran when the window was
    // booked. Everything that gate reads can have moved since: an approver can
    // withdraw, a freeze can be declared for tonight, another team can book a
    // conflicting window on the same CI. Checking at booking time and not at
    // start time means the last thing standing between an unapproved change and
    // production is a stamp nobody re-read.
    //
    // This function held ONE guard — the CHANGE_RW capability — which every
    // agent has. It did not consult the approvals, the freezes, the conflicts,
    // or even the status category. A module whose whole premise is "you do not
    // do this without approval" had an unguarded door marked "do it".
    const header = await loadTicketHeaderRow(tenantId, ticketId, tx);
    if (header?.status_category !== 'scheduled') {
      throw new AppError(
        409,
        'A change is implemented from its scheduled window. Commit the window first.',
        { code: 'conflict', payload: { statusCategory: header?.status_category ?? null } },
      );
    }
    await assertTransitionAllowed(tenantId, ticketId, 'scheduled', tx, actor);

    const at = input.at ?? new Date().toISOString();
    const updated = (await scoped('changes', tenantId, tx)
      .where('changes.ticket_id', ticketId)
      .where('changes.row_version', input.baseRowVersion)
      .update({
        implementation_started_at: at,
        row_version: tx.raw('row_version + 1'),
        updated_at: tx.fn.now(),
      })
      .returning('*')) as unknown as ChangeRow[];

    if (updated.length === 0) {
      throw new ChangeVersionConflictError(await requireChange(tenantId, ticketId, tx, actor), [
        'implementationStartedAt',
      ]);
    }

    await withDecision(
      decisionContext(tenantId, ticketId, CHANGE_DECISIONS.implementationStarted, actor, tx, {
        at,
        plannedWindow: plannedWindowOf(change),
      }),
      async (recorder) => {
        recorder
          .decide(`implementation started at ${at}`)
          // OBSERVED: a human said so at the moment it happened. The contrast is
          // `actualWindowClosedOnResolve`, which is INFERRED and says so.
          .outcome({ implementationStartedAt: at, source: 'observed' });
      },
    );

    return requireChange(tenantId, ticketId, tx, actor);
  });
}

/** Hands off. Same explicit act, same `observed` source. */
export async function finishImplementation(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: { baseRowVersion: number; at?: string },
  trx?: Knex.Transaction,
): Promise<ChangeWithRelations> {
  assertTenantId(tenantId);
  if (!actorHas(actor, CAPABILITIES.CHANGE_RW)) {
    throw forbidden(CAPABILITIES.CHANGE_RW, 'finish the implementation of a change');
  }

  return inTransaction(trx, async (tx) => {
    const row = await requireChangeRow(tenantId, ticketId, tx, true);
    const change = mapChangeRow(row);
    if (change.implementationStartedAt === null) {
      throw new AppError(409, 'This change has not been started', { code: 'conflict' });
    }
    if (change.implementationEndedAt !== null) {
      throw new AppError(409, 'This change has already been finished', {
        code: 'conflict',
        payload: { implementationEndedAt: change.implementationEndedAt },
      });
    }

    const at = input.at ?? new Date().toISOString();
    // `changes_actual_order_ck` allows a zero-length window — a scripted change
    // that starts and finishes inside the same second really did happen — but
    // not an end before its start.
    if (Date.parse(at) < Date.parse(change.implementationStartedAt)) {
      throw new AppError(422, 'The implementation cannot end before it started', {
        code: 'validation_failed',
      });
    }

    const updated = (await scoped('changes', tenantId, tx)
      .where('changes.ticket_id', ticketId)
      .where('changes.row_version', input.baseRowVersion)
      .update({
        implementation_ended_at: at,
        row_version: tx.raw('row_version + 1'),
        updated_at: tx.fn.now(),
      })
      .returning('*')) as unknown as ChangeRow[];

    if (updated.length === 0) {
      throw new ChangeVersionConflictError(await requireChange(tenantId, ticketId, tx, actor), [
        'implementationEndedAt',
      ]);
    }

    await withDecision(
      decisionContext(tenantId, ticketId, CHANGE_DECISIONS.implementationEnded, actor, tx, {
        startedAt: change.implementationStartedAt,
        at,
      }),
      async (recorder) => {
        recorder
          .decide(`implementation finished at ${at}`)
          .outcome({ implementationEndedAt: at, source: 'observed' });
      },
    );

    return requireChange(tenantId, ticketId, tx, actor);
  });
}

/**
 * Record what happened — and arm the review on the SAME code path.
 *
 * The PIR is armed here rather than by a sweeper because the two facts belong
 * together: the outcome is what decides whether a review is owed
 * (`isPirOwed`), and a review armed later by a background pass is a review
 * whose arming nobody can explain. `pir_due_at` is one call to the EXISTING
 * calendar service — a comparison, not a new clock. A freeze and a PIR have no
 * pause, no breach and no ledger; the day somebody wants a countdown, that is
 * an `sla` object and a different question.
 *
 * `pir_required` is never CLEARED here. An emergency change may not lose it
 * (`changes_emergency_pir_ck`), and a human who ticked "this needs a review" is
 * not overruled by a policy that would not have asked for one.
 */
export async function recordOutcome(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: { baseRowVersion: number; outcome: ChangeOutcome; at?: string },
  trx?: Knex.Transaction,
): Promise<ChangeWithRelations> {
  assertTenantId(tenantId);
  if (!actorHas(actor, CAPABILITIES.CHANGE_RW)) {
    throw forbidden(CAPABILITIES.CHANGE_RW, 'record the outcome of a change');
  }

  return inTransaction(trx, async (tx) => {
    const row = await requireChangeRow(tenantId, ticketId, tx, true);
    const change = mapChangeRow(row);
    const headerRow = await loadTicketHeaderRow(tenantId, ticketId, tx);
    const ticket = headerRow ? mapTicketHeaderRow(headerRow) : null;
    const { worst } = await loadTouchedCis(tenantId, ticketId, headerRow?.primary_ci_id ?? null, tx);
    const policy = await resolvePolicyFor(tenantId, change, ticket, worst, tx);
    const policyStamp = { policySlug: policy.policySlug, policyVersion: policy.policyVersion };

    const recordedAt = input.at ?? new Date().toISOString();

    const owed = isPirOwed({
      changeType: change.changeType,
      outcome: input.outcome,
      major: change.major,
      pirRequired: policy.pirRequired,
    });
    const pirRequired = change.pirRequired || owed;

    let pirDueAt: string | null = change.pirDueAt;
    if (pirRequired && pirDueAt === null) {
      try {
        pirDueAt = await addBusinessMinutesOn(
          tenantId,
          policy.calendarSlug,
          recordedAt,
          policy.pirDueBusinessMinutes,
          tx,
        );
      } catch (error) {
        logger.warn(
          { err: error, tenantId, ticketId },
          'Change module: PIR due date not computable — the review is still owed, it simply has no deadline',
        );
        pirDueAt = null;
      }
    }

    // `changes_outcome_pair_ck`: the outcome and its instant move together.
    const updated = (await scoped('changes', tenantId, tx)
      .where('changes.ticket_id', ticketId)
      .where('changes.row_version', input.baseRowVersion)
      .update({
        outcome: input.outcome,
        outcome_recorded_at: recordedAt,
        outcome_recorded_by: actor.userId ?? null,
        pir_required: pirRequired,
        pir_due_at: pirDueAt,
        row_version: tx.raw('row_version + 1'),
        updated_at: tx.fn.now(),
      })
      .returning('*')) as unknown as ChangeRow[];

    if (updated.length === 0) {
      throw new ChangeVersionConflictError(await requireChange(tenantId, ticketId, tx, actor), [
        'outcome',
      ]);
    }

    await withDecision(
      decisionContext(
        tenantId,
        ticketId,
        CHANGE_DECISIONS.outcomeRecorded,
        actor,
        tx,
        {
          outcome: input.outcome,
          changeType: change.changeType,
          major: change.major,
          policyPirRequired: policy.pirRequired,
        },
        policyStamp,
      ),
      async (recorder) => {
        recorder
          .decide(
            `outcome recorded as ${input.outcome}${pirRequired ? '; a post-implementation review is owed' : ''}`,
          )
          .outcome({ outcome: input.outcome, recordedAt, pirRequired });
      },
    );

    if (pirRequired) {
      await withDecision(
        decisionContext(
          tenantId,
          ticketId,
          CHANGE_DECISIONS.pirArmed,
          actor,
          tx,
          {
            calendarSlug: policy.calendarSlug,
            pirDueBusinessMinutes: policy.pirDueBusinessMinutes,
            from: recordedAt,
          },
          policyStamp,
        ),
        async (recorder) => {
          recorder
            .decide(
              pirDueAt === null
                ? 'a post-implementation review is owed; no deadline could be computed'
                : `post-implementation review due ${pirDueAt} (${policy.pirDueBusinessMinutes} business minutes on calendar "${policy.calendarSlug ?? 'default'}")`,
            )
            .outcome({ pirDueAt, calendarSlug: policy.calendarSlug });
        },
      );
    }

    return requireChange(tenantId, ticketId, tx, actor);
  });
}

export interface CompleteReviewInput {
  baseRowVersion: number;
  /**
   * Both answers are OPTIONAL on the wire, and deliberately so: a blank finding
   * or a missing "did this cause an incident?" is refused by
   * `evaluateChangeReview` with a blocker code the client already renders, not
   * by a 400 that says `pirFindingsMd: Required`. Restating the requirement in
   * the request schema would be a second, divergent implementation of the one
   * rule this module exists to state once.
   */
  pirFindingsMd?: string | null;
  pirCausedIncident?: boolean | null;
  /** Incidents this change caused, to link as `caused_by` before the gate runs. */
  incidentTicketIds?: number[];
}

/**
 * Complete the post-implementation review.
 *
 * A COMPLETION GATE THAT REFUSES "WENT FINE". `evaluateChangeReview` demands an
 * outcome, non-blank findings, an explicit answer to "did this cause an
 * incident", and — when that answer is yes — a LINKED incident. An unlinked yes
 * cannot be counted, and a change failure rate that cannot be counted is a
 * survey.
 *
 * The links are written FIRST, in this transaction, precisely so the gate can
 * see them: asking the user to link the incident in a second request after
 * being refused is how a review gets abandoned half-finished.
 */
export async function completeReview(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: CompleteReviewInput,
  trx?: Knex.Transaction,
): Promise<ChangeWithRelations> {
  assertTenantId(tenantId);
  if (!actorHas(actor, CAPABILITIES.CHANGE_RW)) {
    throw forbidden(CAPABILITIES.CHANGE_RW, 'complete the review of a change');
  }
  if (actor.userId === null) {
    // `changes_pir_completed_ck` demands a named human alongside the findings.
    throw new AppError(422, 'Only a signed-in user can complete a review', {
      code: 'validation_failed',
    });
  }

  return inTransaction(trx, async (tx) => {
    const row = await requireChangeRow(tenantId, ticketId, tx, true);
    const change = mapChangeRow(row);

    // ── The links, before the gate reads them ───────────────────────────────
    for (const incidentId of [...new Set(input.incidentTicketIds ?? [])]) {
      if (incidentId === ticketId) continue;
      // `addProblemLink` is the only sanctioned writer of `ticket_link.kind =
      // 'caused_by'` — `addLink` refuses the kind outright. The invariant that
      // reservation protects (an incident hangs under AT MOST ONE problem) is
      // enforced by a `record_type = 'problem'` filter in
      // `problemsHoldingIncidents`, so a link pointing at a CHANGE cannot
      // collide with it. See needsOtherFile: the function's name now
      // under-describes its callers and deserves a neutral one.
      await ticketService.addProblemLink(
        tenantId,
        actor,
        incidentId,
        { toTicketId: ticketId, kind: CAUSED_BY_LINK_KIND },
        tx,
      );
    }

    const linkedIncidentCount = await countLinkedIncidents(tenantId, ticketId, tx);

    // The gate reads the change AS IT WILL BE, not as it is: the user is
    // submitting the findings in this same request, and refusing them because
    // the column is still empty would be refusing the user's own answer.
    // A field the request OMITS keeps whatever autosave already stored — the
    // review is edited inline like everything else, and only the completion is
    // gated (HARD RULE 12).
    const findings = input.pirFindingsMd !== undefined ? input.pirFindingsMd : change.pirFindingsMd;
    const causedIncident =
      input.pirCausedIncident !== undefined ? input.pirCausedIncident : change.pirCausedIncident;

    const proposed: ChangeGateFacts = {
      ...gateFacts(change),
      pirFindingsMd: findings,
      pirCausedIncident: causedIncident,
    };

    const evaluation = evaluateChangeReview({
      change: proposed,
      linkedIncidentCount,
      actor: actorGate(actor),
    });

    if (!evaluation.allowed) {
      await recordRefusal(
        tenantId,
        ticketId,
        CHANGE_DECISIONS.pirCompleted,
        actor,
        { linkedIncidentCount, causedIncident },
        {
          completed: false,
          blockers: evaluation.blockers.map((blocker) => blocker.code),
          missingCapabilities: evaluation.missingCapabilities,
        },
      );
      throw new ChangeGateError('This review is not complete', evaluation);
    }

    const updated = (await scoped('changes', tenantId, tx)
      .where('changes.ticket_id', ticketId)
      .where('changes.row_version', input.baseRowVersion)
      .update({
        pir_findings_md: findings,
        pir_caused_incident: causedIncident,
        pir_completed_at: tx.fn.now(),
        pir_completed_by: actor.userId,
        row_version: tx.raw('row_version + 1'),
        updated_at: tx.fn.now(),
      })
      .returning('*')) as unknown as ChangeRow[];

    if (updated.length === 0) {
      throw new ChangeVersionConflictError(await requireChange(tenantId, ticketId, tx, actor), [
        'pirCompletedAt',
      ]);
    }

    await withDecision(
      decisionContext(tenantId, ticketId, CHANGE_DECISIONS.pirCompleted, actor, tx, {
        outcome: change.outcome,
        findingsLength: (findings ?? '').trim().length,
        causedIncident,
        incidentTicketIds: input.incidentTicketIds ?? [],
      }),
      async (recorder) => {
        recorder
          .decide(
            `post-implementation review completed; caused an incident: ${causedIncident ? 'yes' : 'no'}` +
              (causedIncident ? ` (${linkedIncidentCount} linked)` : ''),
          )
          .outcome({
            completed: true,
            causedIncident,
            linkedIncidentCount,
            completedBy: actor.userId,
          });
      },
    );

    return requireChange(tenantId, ticketId, tx, actor);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 16 — The transition gate (the front door ticket.service calls)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Describe — never enforce — what this module would say about a move.
 *
 * `stateMachine.service.getAvailableTransitions()` renders the buttons, and a
 * button that looks enabled and then 422s is worse than one that is greyed with
 * a reason. This is the read half; `assertTransitionAllowed` below is the
 * enforcement, and BOTH run the same shared evaluator, so they cannot disagree.
 */
export async function evaluateTransition(
  tenantId: number,
  ticketId: number,
  toCategory: StatusCategory,
  options: { executor?: Executor; actor?: ActorContext | null } = {},
): Promise<ChangeGateEvaluation | null> {
  assertTenantId(tenantId);
  const executor = options.executor ?? db;
  const row = await loadChangeRow(tenantId, ticketId, executor);
  if (!row) return null;

  const context = await assembleContext(tenantId, ticketId, executor, { row });
  return evaluateChangeTransition({
    change: gateFacts(context.change),
    policy: context.policy,
    conflicts: context.classifications,
    freezes: context.freezes ?? [],
    // `granted` travels too: without it the gate cannot tell an answered
    // approval from one nobody ever asked for.
    approvals: {
      pending: context.approvals.pending,
      rejected: context.approvals.rejected,
      granted: context.approvals.granted,
    },
    leadTimeMinutes: context.leadTimeMinutes,
    worstCiCriticality: context.worstCiCriticality,
    now: context.now,
    actor: actorGate(options.actor ?? null),
    toCategory,
    linkedIncidentCount: await countLinkedIncidents(tenantId, ticketId, executor),
  });
}

/**
 * THE GATE. Throw a 422 carrying every blocker, or return quietly.
 *
 * ── WHERE THIS IS WIRED ─────────────────────────────────────────────────────
 * `ticket.service.transition()`, immediately beside
 * `approvalEngine()?.assertTransitionAllowed(...)`, inside the same
 * `if (request.system !== true)` block and BEFORE the `withDecision` that
 * applies the move:
 *
 *     if (request.system !== true) {
 *       await approvalEngine()?.assertTransitionAllowed(…);
 *       await changeEngine()?.assertTransitionAllowed(
 *         tenantId, ticketId, decision.toCategory, tx, actor,
 *       );
 *     }
 *
 * The `system === true` escape hatch is inherited deliberately: a merge, a
 * reopen and an alert recovery are facts arriving from elsewhere, not moves a
 * CAB was ever asked to gate.
 *
 * `actor` is the fifth argument and it is OPTIONAL only so the four-argument
 * wiring compiles. Pass it: without it the capability half of the gate stays
 * silent (an absent actor means "not asking about permissions"), and
 * CHANGE_SCHEDULE goes unchecked on the transition door.
 *
 * ── Why the refusal rows are written outside the transaction ────────────────
 * The refusal is delivered by throwing, the throw rolls this transaction back,
 * and a decision row written inside it would vanish with the work it explains.
 * `ticket.service` reached the same conclusion for `transition_refused`.
 */
export async function assertTransitionAllowed(
  tenantId: number,
  ticketId: number,
  toCategory: StatusCategory,
  executor: Executor = db,
  actor: ActorContext | null = null,
): Promise<void> {
  assertTenantId(tenantId);

  const row = await loadChangeRow(tenantId, ticketId, executor);
  // Not a change, or a `record_type = 'change'` ticket with no extension row.
  // Nothing to say, and inventing a `changes` row at a transition would
  // fabricate a change_type and a PIR requirement nobody chose.
  if (!row) return;

  // Committing to a window recomputes the band first: the band decides which
  // approvals apply, which conflicts block and which freeze bites, and
  // gating on a band computed an hour ago is gating on the wrong policy.
  if (toCategory === 'scheduled' && isTransaction(executor)) {
    await recomputeRisk(tenantId, actor, ticketId, { trx: executor });
  }

  const context = await assembleContext(tenantId, ticketId, executor);
  const policyStamp = {
    policySlug: context.policy.policySlug,
    policyVersion: context.policy.policyVersion,
  };

  const evaluation = evaluateChangeTransition({
    change: gateFacts(context.change),
    policy: context.policy,
    conflicts: context.classifications,
    freezes: context.freezes ?? [],
    // `granted` travels too: without it the gate cannot tell an answered
    // approval from one nobody ever asked for.
    approvals: {
      pending: context.approvals.pending,
      rejected: context.approvals.rejected,
      granted: context.approvals.granted,
    },
    leadTimeMinutes: context.leadTimeMinutes,
    worstCiCriticality: context.worstCiCriticality,
    now: context.now,
    actor: actorGate(actor),
    toCategory,
    // Not measured, and not needed: `evaluateChangeTransition` dispatches on
    // the CATEGORY and never reaches the review gate, which is the only reader
    // of this field. Counting the links on every transition would be a query
    // spent on an answer nobody looks at. `completeReview` measures it for real.
    linkedIncidentCount: 0,
  });

  if (evaluation.allowed) {
    // The template moved under an executed plan. A NOOP row, bounded to the one
    // moment it matters — the commitment — rather than written on every read.
    if (toCategory === 'scheduled' && isTransaction(executor)) {
      await noteModelDrift(tenantId, context.change, actor, executor, policyStamp);
    }
    return;
  }

  const codes = evaluation.blockers.map((blocker) => blocker.code);
  const inputs = {
    toCategory,
    changeType: context.change.changeType,
    risk: context.change.risk,
    plannedWindow: plannedWindowOf(context.change),
    leadTimeMinutes: context.leadTimeMinutes,
    requiredLeadTimeMinutes: context.policy.leadTimeMinutes,
  };

  // One row per FAMILY of refusal, because "why was I refused?" is asked with
  // different words depending on which control bit, and a single generic row
  // would make the freeze and the lead time indistinguishable in the drawer.
  if (toCategory === 'scheduled') {
    await recordRefusal(
      tenantId,
      ticketId,
      CHANGE_DECISIONS.scheduleBlocked,
      actor,
      inputs,
      { blockers: codes, missingCapabilities: evaluation.missingCapabilities },
      policyStamp,
    );
    if (codes.includes('change_lead_time_short')) {
      await recordRefusal(
        tenantId,
        ticketId,
        CHANGE_DECISIONS.leadTimeShort,
        actor,
        inputs,
        {
          leadTimeMinutes: context.leadTimeMinutes,
          requiredLeadTimeMinutes: context.policy.leadTimeMinutes,
        },
        policyStamp,
      );
    }
    if (codes.includes('change_freeze_active')) {
      const blocking = (context.freezes ?? []).filter((verdict) => verdict.severity === 'block');
      await recordRefusal(
        tenantId,
        ticketId,
        CHANGE_DECISIONS.freezeBlocked,
        actor,
        inputs,
        {
          freezes: blocking.map((verdict) => ({ slug: verdict.slug, version: verdict.version })),
        },
        policyStamp,
      );
    }
  } else if (toCategory === 'closed' && codes.includes('change_pir_outstanding')) {
    await recordRefusal(
      tenantId,
      ticketId,
      CHANGE_DECISIONS.closureBlockedPir,
      actor,
      inputs,
      { blockers: codes, pirDueAt: context.change.pirDueAt },
      policyStamp,
    );
  }

  throw new ChangeGateError(
    toCategory === 'scheduled'
      ? 'This change cannot be scheduled yet'
      : 'This change cannot be closed yet',
    evaluation,
  );
}

/** Knex has no public type guard for a transaction; this is the usual probe. */
function isTransaction(executor: Executor): executor is Knex.Transaction {
  return typeof (executor as Knex.Transaction).commit === 'function';
}

/**
 * "The model you copied has moved on since."
 *
 * A NOOP row that writes no column. The plans were COPIED at creation and are
 * never re-synchronised — the plan the CAB blessed must stay readable exactly
 * as it was executed — so the only useful thing to do about drift is to say it
 * out loud, once, at the moment somebody commits to running it.
 */
async function noteModelDrift(
  tenantId: number,
  change: Change,
  actor: ActorContext | null,
  tx: Knex.Transaction,
  policyStamp: { policySlug: string; policyVersion: number },
): Promise<void> {
  const slug = lower(change.modelSlug);
  if (!slug || change.modelVersion === null) return;

  try {
    const published = await loadPublishedOne(tenantId, MODEL_KIND, slug, tx);
    if (!published || published.version === change.modelVersion) return;

    await withDecision(
      decisionContext(
        tenantId,
        change.ticketId,
        CHANGE_DECISIONS.modelDrifted,
        actor,
        tx,
        { modelSlug: slug, copiedVersion: change.modelVersion, currentVersion: published.version },
        policyStamp,
      ),
      async (recorder) => {
        recorder
          .rule(published.slug, published.version)
          .decide(
            `this change runs the plan copied from model "${slug}" v${change.modelVersion}; the model is now v${published.version}; the copy is what was approved and it is not re-synchronised`,
          )
          .noop('model_drifted');
      },
    );
  } catch (error) {
    logger.warn({ err: error, tenantId, ticketId: change.ticketId }, 'Change module: model drift check failed');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 17 — The hooks
// ═════════════════════════════════════════════════════════════════════════════

export interface ChangeResolvedEvent {
  tenantId: number;
  ticket: { id: number; recordType: string; statusCategory: StatusCategory };
  previous: { statusCategory: StatusCategory } | null;
  actor: ActorContext;
  trx: Knex.Transaction;
}

/**
 * A change reached a resolved category.
 *
 * ── WHERE THIS IS WIRED ─────────────────────────────────────────────────────
 * `ticket.service.transition()`, beside `runHook('problem.onResolved', …)`,
 * INSIDE the `withDecision` and the transaction:
 *
 *     await runHook('change.onResolved', tenantId, ticketId, () =>
 *       changeEngine()?.onChangeResolved({
 *         tenantId,
 *         ticket: { id: ticketId, recordType: ticket.recordType,
 *                   statusCategory: ticket.statusCategory },
 *         previous: { statusCategory: beforeTicket.statusCategory },
 *         actor, trx: tx,
 *       }),
 *     );
 *
 * ── THE HONEST ROW ──────────────────────────────────────────────────────────
 * A change resolved with its actual window still open gets that window closed —
 * an open-ended actual window means "implementing", and a change cannot be both
 * resolved and still running. But we did not OBSERVE the end of the work; we
 * INFERRED it from the resolution. So the row is named
 * `actualWindowClosedOnResolve`, carries `source: 'inferred'`, and is
 * deliberately NOT `implementationEnded`. The duration-accuracy report can then
 * exclude these instead of silently averaging fiction into the number, and the
 * UI can mark the duration as inferred. A row that asserts what did not happen
 * is worse than a row that is absent.
 *
 * It never throws: `ticket.service` wraps hooks so an engine cannot take a
 * ticket down with it, and a change that fails to resolve because its window
 * bookkeeping hiccuped would be a far worse failure than a window closed late.
 */
export async function onChangeResolved(event: ChangeResolvedEvent): Promise<void> {
  const { tenantId, ticket, previous, actor, trx } = event;

  if (ticket.recordType !== 'change') return;

  const category = ticket.statusCategory;
  const previousCategory = previous?.statusCategory ?? null;
  if (category === previousCategory) return;

  const enteringResolved = category === 'resolved';
  // A tenant whose workflow goes straight from open to closed never passes
  // through `resolved`; firing on both unconditionally would run this twice and
  // the second row would claim a second closure that did not happen.
  const enteringClosedDirectly = category === 'closed' && previousCategory !== 'resolved';
  if (!enteringResolved && !enteringClosedDirectly) return;

  try {
    const row = await loadChangeRow(tenantId, ticket.id, trx, true);
    if (!row) {
      // A `record_type = 'change'` ticket with no `changes` row is reachable
      // from shipped configuration: `POST /api/tickets`, `split()` and the rule
      // builder's `create_child_ticket` action all accept the record type.
      // Doing nothing is right — inventing a change record at the moment of
      // resolution would fabricate a change_type and a PIR requirement nobody
      // chose. Doing nothing SILENTLY is not.
      await withDecision(
        decisionContext(
          tenantId,
          ticket.id,
          CHANGE_DECISIONS.actualWindowClosedOnResolve,
          actor,
          trx,
          { recordType: ticket.recordType, statusCategory: category },
        ),
        async (recorder) => {
          recorder.noop('no_change_record');
        },
      );
      return;
    }

    const change = mapChangeRow(row);
    if (!isImplementing(change)) return;

    const at = new Date().toISOString();
    await scoped('changes', tenantId, trx).where('changes.ticket_id', ticket.id).update({
      implementation_ended_at: at,
      updated_at: trx.fn.now(),
    });

    await withDecision(
      decisionContext(
        tenantId,
        ticket.id,
        CHANGE_DECISIONS.actualWindowClosedOnResolve,
        actor,
        trx,
        {
          startedAt: change.implementationStartedAt,
          statusCategory: category,
          previousCategory,
        },
      ),
      async (recorder) => {
        recorder
          .decide(
            `the change was still implementing when it reached ${category}, so its actual window was closed at ${at}; INFERRED from the resolution, not observed`,
          )
          .outcome({ implementationEndedAt: at, source: 'inferred' });
      },
    );
  } catch (error) {
    logger.warn(
      { err: error, tenantId, ticketId: ticket.id },
      'Change module: onChangeResolved failed — the transition stands',
    );
  }
}

export interface ChangeApprovalDecidedEvent {
  tenantId: number;
  ticketId: number;
  recordType?: string | null;
  state?: string | null;
  actor: ActorContext | null;
  trx: Knex.Transaction;
}

/**
 * An approval on this change was answered.
 *
 * ── WHERE THIS SHOULD BE WIRED ──────────────────────────────────────────────
 * `approval.service.decide()`, inside its own transaction, once the aggregate
 * has settled. Until it is, the baseline is still latched by every window write
 * and by `requestApproval` through `maybeFreezeBaseline()` — late, but never
 * wrong and never silent, because the noop reason on the `baselineFrozen` row
 * says exactly why it had not been frozen yet.
 *
 * It never throws, for the same reason `onChangeResolved` does not: an approver
 * clicking Approve must not see a 500 because a baseline could not be latched.
 */
export async function onApprovalDecided(event: ChangeApprovalDecidedEvent): Promise<void> {
  const { tenantId, ticketId, actor, trx } = event;
  if (event.recordType !== undefined && event.recordType !== null && event.recordType !== 'change') {
    return;
  }
  try {
    const row = await loadChangeRow(tenantId, ticketId, trx);
    if (!row) return;
    await maybeFreezeBaseline(tenantId, actor, ticketId, trx);
  } catch (error) {
    logger.warn({ err: error, tenantId, ticketId }, 'Change module: onApprovalDecided failed');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The object form, for callers that want one import
// ═════════════════════════════════════════════════════════════════════════════

export const changeService = {
  get,
  list,
  listConflicts,
  listModels,
  schedule,
  freezeStatus,
  loadChangePolicy,

  create,
  createFromModel,
  update,

  recomputeRisk,
  overrideRisk,

  setPlannedWindow,
  moveWindow,
  requestApproval,
  freezeBaseline,

  acknowledgeConflicts,
  overrideFreeze,

  startImplementation,
  finishImplementation,
  recordOutcome,
  completeReview,

  evaluateTransition,
  assertTransitionAllowed,
  onChangeResolved,
  onApprovalDecided,
};

export default changeService;
