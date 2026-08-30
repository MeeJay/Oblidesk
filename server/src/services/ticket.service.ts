/**
 * ticket.service.ts — the heart of the desk.
 *
 * Everything that can change a ticket goes through this module, and every path
 * out of it obeys the same five rules:
 *
 *   HARD RULE 1  every query is `scoped()`; there is no bare `db('tickets')`.
 *   HARD RULE 2  a decision_log row is written on the SAME code path as the
 *                action it explains — never reconstructed from the timeline.
 *   HARD RULE 5  engines key off `status_category`, never off `status_slug`.
 *   HARD RULE 6  `occurred_at` (when it happened) is a different column from
 *                `created_at` (when we heard about it), captured at intake and
 *                never backfilled.
 *   HARD RULE 7  every mutation carries the row_version it read; a mismatch is
 *                a 409 carrying the current row, never a last-write-wins clobber.
 *   HARD RULE 12 inline edits autosave one field at a time and NEVER validate
 *                required-ness. `transition()` is the only place that does.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────
 * Rules, SLA clocks and realtime are behind registration hooks with no-op (or
 * minimal) defaults. The desk boots and works with none of them registered,
 * which is what makes each of those engines independently testable — and what
 * stops this file from importing half the server.
 */
import type { Knex } from 'knex';
import { randomUUID } from 'crypto';
import {
  ALL_CAPABILITIES,
  DEFAULT_PRIORITY_SLUG,
  DEFAULT_QUEUE_SLUG,
  LIMITS,
  PAGINATION,
  PROBLEM_LINK_KIND,
  ROOMS,
  SOCKET_EVENTS,
  TICKET_RECORD_TYPES,
  TICKET_SOURCES,
  canReopen,
  isTerminal,
  isWorkable,
  toStatusCategory,
  type ActorType,
  type ConditionNode,
  type CreateTicketRequest,
  type FieldProvenance,
  type JournalMeta,
  type JournalVisibility,
  type StatusCategory,
  type Ticket,
  type TicketConflict,
  type TicketListQuery,
  type TicketRecordType,
  type TicketSearchHit,
  type TicketSource,
  type TicketWithRelations,
  type TransitionTicketRequest,
  type UpdateTicketRequest,
} from '@oblidesk/shared';

import { assertTenantId, db, insertScoped, scoped, type Executor } from '../db';
import { AppError } from '../middleware/errorHandler';
import { withDecision as withDecisionRaw } from './decision.service';
import * as journalService from './journal.service';
import { emitDeskEvent, registerDeskRealtime, type DeskRealtime } from './journal.service';
import { allocateTicketNumber } from './ticketNumber.service';
import * as searchService from './search.service';
import * as attachmentService from './attachment.service';
import {
  applyPriorityOverride,
  computePriority,
  loadPriorityMatrix,
  type DecisionContext,
  type DecisionRecorder,
} from './priority.service';
import {
  applyApprovalBlocks,
  availableTransitions as evaluateAvailableTransitions,
  buildTransitionContext,
  categoryOf,
  evaluateTransition,
  loadRequiredWhenFields,
  loadStateMachineForTicket,
  readPublishedConfigObject,
  resolveConditionTokens,
  resolveTicketFieldPath,
  statusForCategory,
  toConditionNode,
  type NormalizedStateMachine,
  type TransitionActor,
  type TransitionContextExtras,
  type TransitionDecision,
  type TicketFieldRef,
} from './stateMachine.service';

// Re-exported so the socket layer has one obvious place to wire itself in.
export { registerDeskRealtime };
export type { DeskRealtime };

/** The acting user or engine. Built by the controller, never by a service. */
export type ActorContext = TransitionActor;

type WithDecision = <T>(
  ctx: DecisionContext,
  run: (recorder?: DecisionRecorder) => Promise<T>,
) => Promise<T>;

const withDecision = withDecisionRaw as unknown as WithDecision;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Errors the controller turns into rich responses
// ═════════════════════════════════════════════════════════════════════════════

/**
 * HARD RULE 7. Carries the CURRENT row so the client can render a diff instead
 * of a scary modal: "someone changed the assignee while you were typing" is
 * actionable, "409 Conflict" is not.
 *
 * Extends `AppError` with `code` and `payload`, so the shared `errorHandler`
 * emits the whole envelope on its own — a handler that simply calls `next(err)`
 * still returns the current row, and there is no way to lose it by forgetting a
 * special case.
 */
export class TicketVersionConflictError extends AppError {
  constructor(public readonly conflict: TicketConflict) {
    super(409, 'This ticket changed while you were editing it', {
      code: 'version_conflict',
      payload: {
        current: conflict.current,
        conflictingFields: conflict.conflictingFields,
      },
    });
    this.name = 'TicketVersionConflictError';
  }
}

/**
 * A refused transition (HARD RULE 12), carrying the structured reasons the UI
 * renders: which fields are empty, which capability is missing, and the guard
 * trace. `message` is the ready-made French sentence.
 */
export class TransitionRefusedError extends AppError {
  constructor(public readonly evaluation: TransitionDecision) {
    super(422, evaluation.reason ?? 'This transition is not allowed', {
      code:
        evaluation.missingRequiredFields.length > 0
          ? 'required_fields_missing'
          : 'transition_blocked',
      payload: { evaluation },
      fieldErrors: Object.fromEntries(
        evaluation.missingRequiredFields.map((field) => [field, 'required']),
      ),
    });
    this.name = 'TransitionRefusedError';
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Engine hooks
// ═════════════════════════════════════════════════════════════════════════════

export interface RulesEngineEvent {
  tenantId: number;
  ticket: Ticket;
  previous: Ticket | null;
  actor: ActorContext;
  trx: Knex.Transaction;
  /** Populated for transitions. */
  transition?: { slug: string | null; fromStatusSlug: string; toStatusSlug: string };
  /** Populated for journal appends. */
  journalEntryId?: number;
  changedFields?: string[];
}

/**
 * The rules engine's entry points.
 *
 * Declared here as an interface with a no-op default so a later phase can
 * `registerRulesEngine(realEngine)` from `index.ts` WITHOUT editing this file.
 * Rules must be able to fail without taking the ticket with them — a bad
 * condition in one tenant's automation cannot be allowed to make ticket
 * creation return 500 — so every call is wrapped (see `runHook`).
 */
export interface RulesEngineHook {
  onTicketCreated?(event: RulesEngineEvent): Promise<void> | void;
  onTicketUpdated?(event: RulesEngineEvent): Promise<void> | void;
  onTicketTransitioned?(event: RulesEngineEvent): Promise<void> | void;
  onJournalAppended?(event: RulesEngineEvent): Promise<void> | void;
}

const NOOP_RULES_ENGINE: RulesEngineHook = {};
let rulesEngine: RulesEngineHook = NOOP_RULES_ENGINE;

export function registerRulesEngine(engine: RulesEngineHook | null): void {
  rulesEngine = engine ?? NOOP_RULES_ENGINE;
}

export function getRulesEngine(): RulesEngineHook {
  return rulesEngine;
}

export interface SlaEngineHook {
  onTicketCreated?(event: { tenantId: number; ticket: Ticket; trx: Knex.Transaction }): Promise<void> | void;
  onCategoryChanged?(event: {
    tenantId: number;
    ticket: Ticket;
    fromCategory: StatusCategory;
    toCategory: StatusCategory;
    trx: Knex.Transaction;
  }): Promise<void> | void;
  /** Start a fresh clock for one target. Returns the new instance id. */
  startTarget?(event: {
    tenantId: number;
    ticket: Ticket;
    targetSlug: string;
    reasonCode: string;
    actorId: number | null;
    trx: Knex.Transaction;
  }): Promise<number | null>;
  /** Stop every live clock on a ticket. Returns the ids it stopped. */
  cancelForTicket?(event: {
    tenantId: number;
    ticketId: number;
    reasonCode: string;
    actorId: number | null;
    trx: Knex.Transaction;
  }): Promise<number[]>;
  /**
   * Priority moved mid-flight. The engine re-derives the deadline against the
   * new budget; whether that keeps the elapsed time, restarts or recomputes
   * from the start is the policy's business, not ours.
   */
  onPriorityChanged?(event: {
    tenantId: number;
    ticket: Ticket;
    fromPriority: string;
    toPriority: string;
    actorId?: number | null;
    trx: Knex.Transaction;
  }): Promise<void> | void;
  /**
   * Record type moved. Record type is one of the policy resolution levels, so
   * the policy must be RE-RESOLVED — leaving the old clocks running holds the
   * ticket to a contract that no longer applies to it.
   */
  onRecordTypeChanged?(event: {
    tenantId: number;
    ticket: Ticket;
    fromRecordType: string;
    toRecordType: string;
    actorId?: number | null;
    trx: Knex.Transaction;
  }): Promise<void> | void;
  /**
   * The first PUBLIC agent reply — what a `first_response` target stops on.
   * Without this call the response-time SLA never stops, and every response
   * target on the desk breaches in silence.
   */
  onFirstResponse?(event: {
    tenantId: number;
    ticket: Ticket;
    at?: Date;
    actorId?: number | null;
    journalEntryId?: number | null;
    trx: Knex.Transaction;
  }): Promise<void> | void;
}

let slaEngine: SlaEngineHook = {};

export function registerSlaEngine(engine: SlaEngineHook | null): void {
  slaEngine = engine ?? {};
}

/**
 * Never let an engine's failure roll back the action it was reacting to. The
 * failure IS recorded — as a decision_log row — so "the rule did not fire" is
 * answerable rather than invisible.
 */
async function runHook(
  label: string,
  tenantId: number,
  ticketId: number | null,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    await withDecision(
      {
        tenantId,
        ticketId,
        subsystem: 'rule',
        decision: 'engine_hook_failed',
        inputs: { hook: label },
      },
      async (recorder) => {
        recorder?.outcome?.({
          error: error instanceof Error ? error.message : String(error),
        });
      },
    ).catch(() => undefined);
  }
}

// ── Escalation and approval: the same optionality, from the other side ───────
//
// The two engines above plug themselves in through `registerRulesEngine()` /
// `registerSlaEngine()`. Escalation and approval cannot: they sit BELOW this
// file in the dependency graph (both reach `configObject.service`, and
// `ruleActions.ts` imports this module and them), so a static import here would
// close a module-initialisation cycle and drag half the server into every
// process that only wanted to read a ticket.
//
// So they are resolved by a `require` at CALL time — the same defensive shape
// `middleware/validate.ts` uses — memoised, and degrading to `null` rather than
// to a 500 when the module is not deployed. `typeof import(...)` is a TYPE
// position, so it is erased and adds no runtime edge.

type EscalationEngine = typeof import('./escalation.service');
type ApprovalEngine = typeof import('./approval.service');

let escalationModule: EscalationEngine | null | undefined;
let approvalModule: ApprovalEngine | null | undefined;

function escalationEngine(): EscalationEngine | null {
  if (escalationModule === undefined) {
    try {
      escalationModule = require('./escalation.service') as EscalationEngine;
    } catch {
      escalationModule = null;
    }
  }
  return escalationModule;
}

function approvalEngine(): ApprovalEngine | null {
  if (approvalModule === undefined) {
    try {
      approvalModule = require('./approval.service') as ApprovalEngine;
    } catch {
      approvalModule = null;
    }
  }
  return approvalModule;
}

/**
 * The problem engine, reached the same lazy way as escalation and approval.
 *
 * It has to be lazy: `problem.service` imports THIS module (it creates the
 * problem ticket and transitions the incidents its cascade resolves), so a
 * static import would close the cycle. The engine was written with a hook
 * called `onProblemResolved` and its own header says it is "registered on
 * ticket.service's transition hook" — it never was, so the automatic cascade
 * and the known-error retirement were dead code behind a manual button.
 */
/**
 * The change engine, reached the same lazy way as the problem engine and for
 * the same reason: `change.service` imports THIS module to create and
 * transition its ticket, so a static import would close the cycle.
 *
 * Wired here because it was not. Three functions in that file each carried a
 * header saying "WHERE THIS IS WIRED: ticket.service.transition()", and none of
 * them had a caller — the same defect the problem module shipped, in a module
 * written after it and warned about it. A comment describing a call site is not
 * a call site.
 */
type ChangeEngineModule = typeof import('./change.service');

let changeModule: ChangeEngineModule | null | undefined;

function changeEngine(): ChangeEngineModule | null {
  if (changeModule === undefined) {
    try {
      changeModule = require('./change.service') as ChangeEngineModule;
    } catch {
      changeModule = null;
    }
  }
  return changeModule;
}

type ProblemEngineModule = typeof import('./problem.service');

let problemModule: ProblemEngineModule | null | undefined;

function problemEngine(): ProblemEngineModule | null {
  if (problemModule === undefined) {
    try {
      problemModule = require('./problem.service') as ProblemEngineModule;
    } catch {
      problemModule = null;
    }
  }
  return problemModule;
}

type SlaEngineModule = typeof import('./sla.service');

let slaModule: SlaEngineModule | null | undefined;

function slaEngineModule(): SlaEngineModule | null {
  if (slaModule === undefined) {
    try {
      slaModule = require('./sla.service') as SlaEngineModule;
    } catch {
      slaModule = null;
    }
  }
  return slaModule;
}

/**
 * The three hooks that were added to `SlaEngineHook` AFTER `sla.service` wrote
 * its self-registration.
 *
 * `sla.service` registers itself with a fixed object literal naming four hooks.
 * A hook added to the interface later is therefore absent from what was
 * registered — and an absent hook here is not a degraded clock, it is a
 * response-time SLA that never stops, silently, on every ticket on the desk.
 * That is precisely the class of failure the interface exists to prevent, so it
 * must not depend on somebody remembering to widen a literal in another file.
 *
 * A REGISTERED hook always wins (that is what lets a test swap in a fake); only
 * a genuinely absent one falls through to the engine module's own export of the
 * same name, resolved by the same call-time `require` as the two engines above.
 * `sla.service` imports THIS file in order to register, so the import has to
 * stay call-time; by the time a ticket moves, both modules are initialised.
 * With no SLA engine deployed at all this still resolves to `undefined` and
 * still degrades rather than crashing.
 *
 * Retiring this is one line in `sla.service`: pass `slaService` (which already
 * carries all seven) to `registerSlaEngine()` instead of the literal. The `Pick`
 * in the return type is deliberate — it keeps the bridge to exactly the three
 * hooks that need it, and leaves the original four behaving exactly as before.
 */
function newerSlaHooks(): Pick<
  SlaEngineHook,
  'onPriorityChanged' | 'onRecordTypeChanged' | 'onFirstResponse'
> {
  const engine = slaEngineModule();
  if (!engine) return slaEngine;
  return {
    onPriorityChanged: slaEngine.onPriorityChanged ?? engine.onPriorityChanged,
    onRecordTypeChanged: slaEngine.onRecordTypeChanged ?? engine.onRecordTypeChanged,
    onFirstResponse: slaEngine.onFirstResponse ?? engine.onFirstResponse,
  };
}

/**
 * The field moves an SLA policy is resolved against, fired from the one place
 * both `update()` and `transition()` can see them: the row BEFORE against the
 * row AFTER.
 *
 * Comparing rows rather than inspecting the request is deliberate. Priority does
 * not only move through `PATCHABLE.prioritySlug` — the matrix recomputes it from
 * an impact/urgency edit, and a transition effect can set it outright — so a
 * check keyed off "did the caller mention prioritySlug?" misses two of the three
 * ways it actually changes, and a deadline that silently never moves is exactly
 * the failure this wiring closes.
 *
 * Both hooks are idempotent and both no-op when the value did not move, so the
 * cost on the overwhelming majority of edits is two string comparisons.
 */
async function runFieldChangeHooks(
  tenantId: number,
  before: Ticket,
  after: Ticket,
  actorId: number | null,
  tx: Knex.Transaction,
): Promise<void> {
  if (after.prioritySlug !== before.prioritySlug) {
    await runHook('sla.onPriorityChanged', tenantId, after.id, () =>
      newerSlaHooks().onPriorityChanged?.({
        tenantId,
        ticket: after,
        fromPriority: before.prioritySlug,
        toPriority: after.prioritySlug,
        actorId,
        trx: tx,
      }),
    );
    // A P3 becoming a P1 is one of the three ticket-level escalation triggers:
    // the ladder that pages the on-call for a P1 must arm on the UPGRADE, not
    // only on tickets that were born critical.
    await runHook('escalation.onPriorityChanged', tenantId, after.id, async () => {
      await escalationEngine()?.onTicketEvent({
        tenantId,
        ticketId: after.id,
        trigger: 'priority',
        occurrenceRef: after.prioritySlug,
        context: { fromPriority: before.prioritySlug, toPriority: after.prioritySlug },
        actorId,
        trx: tx,
      });
    });
  }

  if (after.recordType !== before.recordType) {
    await runHook('sla.onRecordTypeChanged', tenantId, after.id, () =>
      newerSlaHooks().onRecordTypeChanged?.({
        tenantId,
        ticket: after,
        fromRecordType: before.recordType,
        toRecordType: after.recordType,
        actorId,
        trx: tx,
      }),
    );
  }
}

// ── Minimal SLA behaviour when no engine is registered ───────────────────────
//
// `merge()` and `reopen()` make promises about clocks that must hold whether or
// not `sla.service` is wired in, so the fallbacks below do the part that needs
// no calendar arithmetic: cancelling live instances, and OPENING a new instance
// without a due date. `due_at` is deliberately left NULL rather than guessed —
// a made-up deadline is worse than a missing one, and the SLA sweeper fills it
// in the moment the real engine registers.

async function cancelLiveSlaInstances(
  tenantId: number,
  ticketId: number,
  reasonCode: string,
  actorId: number | null,
  trx: Knex.Transaction,
): Promise<number[]> {
  if (slaEngine.cancelForTicket) {
    return (await slaEngine.cancelForTicket({ tenantId, ticketId, reasonCode, actorId, trx })) ?? [];
  }

  const live = (await scoped('sla_instances', tenantId, trx)
    .where('sla_instances.ticket_id', ticketId)
    .whereIn('sla_instances.status', ['running', 'paused'])
    .select('sla_instances.id')) as unknown as Array<{ id: number }>;

  if (live.length === 0) return [];
  const ids = live.map((row) => row.id);

  await scoped('sla_instances', tenantId, trx)
    .whereIn('sla_instances.id', ids)
    .update({ status: 'cancelled', running: false });

  for (const id of ids) {
    await insertScoped(
      'sla_ledger',
      tenantId,
      {
        instance_id: id,
        event: 'cancel',
        reason_code: reasonCode,
        actor_id: actorId,
        elapsed_business_ms_before: 0,
      },
      trx,
    )
      .onConflict(['instance_id', 'event', 'at'])
      .ignore();
  }
  return ids;
}

async function startSlaTarget(
  tenantId: number,
  ticket: Ticket,
  targetSlug: string,
  reasonCode: string,
  actorId: number | null,
  trx: Knex.Transaction,
): Promise<number | null> {
  if (slaEngine.startTarget) {
    return (
      (await slaEngine.startTarget({ tenantId, ticket, targetSlug, reasonCode, actorId, trx })) ?? null
    );
  }

  // Copy the policy from the LAST instance for this target so the new clock is
  // governed by the same policy version the ticket has been living under.
  const previous = await scoped('sla_instances', tenantId, trx)
    .where({ 'sla_instances.ticket_id': ticket.id, 'sla_instances.target_slug': targetSlug })
    .orderBy('sla_instances.id', 'desc')
    .first<{ policy_slug: string; policy_version: number; calendar_slug: string }>(
      'sla_instances.policy_slug',
      'sla_instances.policy_version',
      'sla_instances.calendar_slug',
    );

  if (!previous) return null;

  const inserted = (await insertScoped(
    'sla_instances',
    tenantId,
    {
      ticket_id: ticket.id,
      target_slug: targetSlug,
      policy_slug: previous.policy_slug,
      policy_version: previous.policy_version,
      calendar_slug: previous.calendar_slug,
      started_at: new Date(),
      due_at: null, // the engine computes this against the calendar
      paused_ms: 0,
      running: true,
      status: 'running',
    },
    trx,
  ).returning('id')) as unknown as Array<{ id: number }>;

  const instanceId = inserted[0]?.id ?? null;
  if (instanceId !== null) {
    await insertScoped(
      'sla_ledger',
      tenantId,
      {
        instance_id: instanceId,
        event: 'start',
        reason_code: reasonCode,
        actor_id: actorId,
        elapsed_business_ms_before: 0,
      },
      trx,
    )
      .onConflict(['instance_id', 'event', 'at'])
      .ignore();
  }
  return instanceId;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Rows ↔ DTOs
// ═════════════════════════════════════════════════════════════════════════════

interface TicketRow {
  id: number;
  tenant_id: number;
  record_type: string;
  number: string;
  subject: string;
  description_md: string | null;
  description_html: string | null;
  status_slug: string;
  status_category: string;
  priority_slug: string;
  impact: string | null;
  urgency: string | null;
  queue_slug: string;
  assignment_group_id: number | null;
  assignee_id: number | null;
  requester_contact_id: number | null;
  requester_user_id: number | null;
  organization_id: number | null;
  primary_ci_id: number | null;
  source: string;
  occurred_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  first_response_at: Date | string | null;
  resolved_at: Date | string | null;
  closed_at: Date | string | null;
  due_at: Date | string | null;
  reopen_count: number;
  parent_ticket_id: number | null;
  merged_into_id: number | null;
  resolution_code: string | null;
  resolution_md: string | null;
  csat_score: number | null;
  data: Record<string, unknown> | null;
  set_by: Record<string, FieldProvenance> | null;
  row_version: number;
  deleted_at: Date | string | null;

  // joined
  assignee_username?: string | null;
  assignee_display_name?: string | null;
  assignee_avatar?: string | null;
  group_slug?: string | null;
  group_name?: string | null;
  org_name?: string | null;
  org_slug?: string | null;
  requester_email?: string | null;
  requester_display_name?: string | null;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function iso(value: Date | string | null | undefined, fallback: string): string {
  return isoOrNull(value) ?? fallback;
}

const LEVELS = ['high', 'medium', 'low'] as const;
type Level = (typeof LEVELS)[number];

function level(value: string | null | undefined): Level {
  return value === 'high' || value === 'low' ? value : 'medium';
}

export function mapTicketRow(row: TicketRow): TicketWithRelations {
  const createdAt = iso(row.created_at, new Date().toISOString());

  const ticket: TicketWithRelations = {
    id: row.id,
    tenantId: row.tenant_id,
    recordType: row.record_type as TicketRecordType,
    number: row.number,
    subject: row.subject,
    descriptionMd: row.description_md,
    descriptionHtml: row.description_html,
    statusSlug: row.status_slug,
    statusCategory: toStatusCategory(row.status_category, 'open'),
    prioritySlug: row.priority_slug,
    impact: level(row.impact),
    urgency: level(row.urgency),
    queueSlug: row.queue_slug,
    assignmentGroupId: row.assignment_group_id,
    assigneeId: row.assignee_id,
    requesterContactId: row.requester_contact_id,
    requesterUserId: row.requester_user_id,
    organizationId: row.organization_id,
    primaryCiId: row.primary_ci_id,
    source: row.source as TicketSource,
    // HARD RULE 6 — a distinct column. The fallback exists only for rows that
    // predate intake capture; nothing ever WRITES created_at into it.
    occurredAt: iso(row.occurred_at, createdAt),
    createdAt,
    updatedAt: iso(row.updated_at, createdAt),
    firstResponseAt: isoOrNull(row.first_response_at),
    resolvedAt: isoOrNull(row.resolved_at),
    closedAt: isoOrNull(row.closed_at),
    dueAt: isoOrNull(row.due_at),
    reopenCount: row.reopen_count ?? 0,
    parentTicketId: row.parent_ticket_id,
    mergedIntoId: row.merged_into_id,
    resolutionCode: row.resolution_code,
    resolutionMd: row.resolution_md,
    csatScore: row.csat_score,
    data: (row.data ?? {}) as Record<string, unknown>,
    setBy: (row.set_by ?? {}) as Record<string, FieldProvenance>,
    rowVersion: row.row_version,
    deletedAt: isoOrNull(row.deleted_at),
  };

  if (row.assignee_id !== null && row.assignee_username !== undefined) {
    ticket.assignee = {
      id: row.assignee_id,
      username: row.assignee_username ?? '',
      displayName: row.assignee_display_name ?? null,
      avatar: row.assignee_avatar ?? null,
    };
  }
  if (row.assignment_group_id !== null && row.group_slug !== undefined) {
    ticket.assignmentGroup = {
      id: row.assignment_group_id,
      slug: row.group_slug ?? '',
      name: row.group_name ?? '',
    };
  }
  if (row.organization_id !== null && row.org_slug !== undefined) {
    ticket.organization = {
      id: row.organization_id,
      name: row.org_name ?? '',
      slug: row.org_slug ?? '',
    };
  }
  if (row.requester_contact_id !== null && row.requester_email !== undefined) {
    ticket.requesterContact = {
      id: row.requester_contact_id,
      email: row.requester_email ?? '',
      displayName: row.requester_display_name ?? null,
    };
  }
  return ticket;
}

const TICKET_SELECT = 'tickets.*';

const RELATION_SELECT = [
  'au.username as assignee_username',
  'au.display_name as assignee_display_name',
  'au.avatar as assignee_avatar',
  'ag.slug as group_slug',
  'ag.name as group_name',
  'org.name as org_name',
  'org.slug as org_slug',
  'pc.email as requester_email',
  'pc.display_name as requester_display_name',
];

/** Attach the four joins the list and detail views always need. */
function withRelations(qb: Knex.QueryBuilder, tenantId: number, knex: Executor): Knex.QueryBuilder {
  return qb
    // `users` is a GLOBAL table (see db/index.ts) — no tenant predicate here.
    .leftJoin('users as au', 'au.id', 'tickets.assignee_id')
    // Every joined TENANT table gets its own tenant predicate. Joining on the
    // foreign key alone would be correct today and a cross-tenant leak the
    // first time an id is reused after a restore.
    .leftJoin('assignment_groups as ag', function joinGroup() {
      this.on('ag.id', 'tickets.assignment_group_id').andOn(
        'ag.tenant_id',
        '=',
        knex.raw('?', [tenantId]),
      );
    })
    .leftJoin('organizations as org', function joinOrg() {
      this.on('org.id', 'tickets.organization_id').andOn(
        'org.tenant_id',
        '=',
        knex.raw('?', [tenantId]),
      );
    })
    .leftJoin('portal_contacts as pc', function joinContact() {
      this.on('pc.id', 'tickets.requester_contact_id').andOn(
        'pc.tenant_id',
        '=',
        knex.raw('?', [tenantId]),
      );
    })
    .select(TICKET_SELECT, ...RELATION_SELECT);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Provenance (tickets.set_by)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Who last wrote each field. Stored on the row so the UI can say "priority set
 * by rule escalate_p1_after_15m" without replaying decision_log, and so a rule
 * can decline to overwrite a value a human chose.
 */
function provenance(actor: ActorContext, ruleSlug?: string | null): FieldProvenance {
  return {
    actorType: actor.actorType,
    actorId: actor.userId ?? null,
    ruleSlug: ruleSlug ?? null,
    at: new Date().toISOString(),
  };
}

function stampProvenance(
  existing: Record<string, FieldProvenance>,
  fields: readonly string[],
  actor: ActorContext,
  ruleSlug?: string | null,
): Record<string, FieldProvenance> {
  const stamp = provenance(actor, ruleSlug);
  const next = { ...existing };
  for (const field of fields) next[field] = stamp;
  return next;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Reads
// ═════════════════════════════════════════════════════════════════════════════

export async function getById(
  tenantId: number,
  ticketId: number,
  options: { includeDeleted?: boolean; executor?: Executor } = {},
): Promise<TicketWithRelations | null> {
  const knex = options.executor ?? db;
  const qb = scoped('tickets', tenantId, knex).where('tickets.id', ticketId);
  if (!options.includeDeleted) qb.whereNull('tickets.deleted_at');

  const row = (await withRelations(qb, tenantId, knex).first()) as TicketRow | undefined;
  return row ? mapTicketRow(row) : null;
}

export async function getByNumber(
  tenantId: number,
  number: string,
  executor: Executor = db,
): Promise<TicketWithRelations | null> {
  const qb = scoped('tickets', tenantId, executor)
    .where('tickets.number', number)
    .whereNull('tickets.deleted_at');
  const row = (await withRelations(qb, tenantId, executor).first()) as TicketRow | undefined;
  return row ? mapTicketRow(row) : null;
}

/** Raw row, locked, inside a transaction. The starting point of every mutation. */
async function lockTicket(
  tenantId: number,
  ticketId: number,
  trx: Knex.Transaction,
): Promise<TicketRow> {
  const row = (await scoped('tickets', tenantId, trx)
    .where('tickets.id', ticketId)
    .forUpdate()
    .first('tickets.*')) as TicketRow | undefined;
  if (!row) throw new AppError(404, 'Ticket not found');
  return row;
}

/**
 * Hydrate the extras the detail view needs but the list must never pay for:
 * counts are one query each, and a 100 000-row virtualised list would run
 * 300 000 of them.
 */
export async function getDetail(
  tenantId: number,
  ticketId: number,
  executor: Executor = db,
): Promise<TicketWithRelations | null> {
  const ticket = await getById(tenantId, ticketId, { executor });
  if (!ticket) return null;

  const [journalCount, attachmentCount, watcherRows, slaRows, ciRows] = await Promise.all([
    journalService.count(tenantId, ticketId, {}, executor),
    attachmentService.countsForEntities(tenantId, 'ticket', [ticketId], executor),
    scoped('ticket_watcher', tenantId, executor)
      .where('ticket_watcher.ticket_id', ticketId)
      .count({ count: '*' }) as unknown as Promise<Array<{ count: string }>>,
    scoped('sla_instances', tenantId, executor)
      .where('sla_instances.ticket_id', ticketId)
      .orderBy('sla_instances.id', 'asc')
      .select('sla_instances.*') as unknown as Promise<Array<Record<string, unknown>>>,
    scoped('ticket_cis', tenantId, executor)
      .where('ticket_cis.ticket_id', ticketId)
      .join('cis', 'cis.id', 'ticket_cis.ci_id')
      .where('cis.tenant_id', tenantId)
      .select(
        'cis.id',
        'cis.display_name',
        'cis.kind',
        'cis.criticality',
      ) as unknown as Promise<
      Array<{ id: number; display_name: string; kind: string; criticality: string | null }>
    >,
  ]);

  ticket.journalCount = journalCount;
  ticket.attachmentCount = attachmentCount.get(ticketId) ?? 0;
  ticket.watcherCount = Number(watcherRows?.[0]?.count ?? 0);
  ticket.cis = ciRows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    kind: row.kind,
    criticality: row.criticality ?? null,
  })) as unknown as TicketWithRelations['cis'];
  // The SLA DTO belongs to sla.service; passing the rows through here untyped
  // keeps this module from owning a shape it does not write.
  ticket.slaInstances = slaRows as unknown as TicketWithRelations['slaInstances'];

  return ticket;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — The filter compiler
// ═════════════════════════════════════════════════════════════════════════════
//
// A saved view carries a ConditionNode. Turning it into SQL is the one place in
// the product where stored configuration meets the query planner, so it is also
// the one place where a mistake becomes "any tenant admin can read any column".
//
// Two rules make that impossible rather than unlikely:
//   • the field must resolve through `resolveTicketFieldPath()` — a whitelist,
//     not a sanitiser. An unknown path is REPORTED and the clause fails closed.
//   • every value is a bound parameter. Nothing is concatenated, ever, and the
//     only interpolation is `??` for a whitelisted identifier.

export interface UnsupportedClause {
  field: string;
  op: string;
  reason: 'unknown_field' | 'unsupported_operator' | 'bad_value';
}

interface CompileCtx {
  knex: Executor;
  unsupported: UnsupportedClause[];
}

/**
 * Knex types raw bindings tightly; everything that reaches here has already
 * been through the whitelist (identifiers) or is a caller value bound as a
 * parameter (never interpolated), so widening at the boundary is safe.
 */
type Bindings = Knex.RawBinding[];

function binds(...values: unknown[]): Bindings {
  return values as Bindings;
}

interface Lhs {
  sql: string;
  bindings: Bindings;
}

function lhsFor(ref: TicketFieldRef, cast?: 'numeric' | 'timestamptz'): Lhs {
  if (ref.jsonKey !== undefined) {
    const base: Lhs = { sql: '(tickets.data ->> ?)', bindings: binds(ref.jsonKey) };
    return cast ? { sql: `${base.sql}::${cast}`, bindings: base.bindings } : base;
  }
  return { sql: '??', bindings: binds(ref.column) };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** `2h`, `30m`, `3 d`, `1w`, or a bare number of minutes. */
function parseDurationMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 60_000;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 60_000;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/.exec(trimmed);
  if (!match) return null;
  const units: Record<string, number> = {
    ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
  };
  return Number(match[1]) * units[match[2]];
}

function applyLeaf(
  qb: Knex.QueryBuilder,
  leaf: { field: string; op: string; value?: unknown },
  ctx: CompileCtx,
): void {
  const ref = resolveTicketFieldPath(leaf.field);
  if (!ref) {
    ctx.unsupported.push({ field: leaf.field, op: leaf.op, reason: 'unknown_field' });
    // Fail CLOSED. A filter naming a field we do not understand may be trying
    // to narrow visibility; widening it would be the wrong kind of forgiving.
    qb.whereRaw('false');
    return;
  }

  const value = leaf.value;
  const numericValue = typeof value === 'number' ? value : null;
  const cast =
    ref.jsonKey !== undefined && numericValue !== null ? ('numeric' as const) : undefined;
  const lhs = lhsFor(ref, cast);

  switch (leaf.op) {
    case 'eq':
      if (value === null || value === undefined) qb.whereRaw(`${lhs.sql} IS NULL`, lhs.bindings);
      else qb.whereRaw(`${lhs.sql} = ?`, binds(...lhs.bindings, value));
      return;

    case 'neq':
      qb.whereRaw(`${lhs.sql} IS DISTINCT FROM ?`, binds(...lhs.bindings, value ?? null));
      return;

    case 'in':
    case 'not_in': {
      const list = Array.isArray(value) ? value.filter((v) => v !== undefined) : [value];
      if (list.length === 0) {
        // `IN ()` is not valid SQL, and the honest answer differs per operator:
        // "in nothing" matches nothing, "not in nothing" matches everything.
        qb.whereRaw(leaf.op === 'in' ? 'false' : 'true');
        return;
      }
      const placeholders = list.map(() => '?').join(', ');
      if (leaf.op === 'in') {
        qb.whereRaw(`${lhs.sql} IN (${placeholders})`, binds(...lhs.bindings, ...list));
      } else {
        // NULL NOT IN (…) is NULL, not TRUE — so an unassigned ticket would
        // silently vanish from "not assigned to Bob". Say what we mean.
        qb.whereRaw(
          `(${lhs.sql} IS NULL OR ${lhs.sql} NOT IN (${placeholders}))`,
          binds(...lhs.bindings, ...lhs.bindings, ...list),
        );
      }
      return;
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const operator = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[leaf.op];
      qb.whereRaw(`${lhs.sql} ${operator} ?`, binds(...lhs.bindings, value));
      return;
    }

    case 'contains':
    case 'not_contains':
    case 'starts_with':
    case 'ends_with': {
      if (typeof value !== 'string') {
        ctx.unsupported.push({ field: leaf.field, op: leaf.op, reason: 'bad_value' });
        qb.whereRaw('false');
        return;
      }
      const escaped = escapeLike(value);
      const pattern =
        leaf.op === 'starts_with'
          ? `${escaped}%`
          : leaf.op === 'ends_with'
            ? `%${escaped}`
            : `%${escaped}%`;
      if (leaf.op === 'not_contains') {
        qb.whereRaw(`(${lhs.sql} IS NULL OR ${lhs.sql} NOT ILIKE ?)`, binds(...lhs.bindings, ...lhs.bindings, pattern));
      } else {
        qb.whereRaw(`${lhs.sql} ILIKE ?`, binds(...lhs.bindings, pattern));
      }
      return;
    }

    case 'is_empty':
      qb.whereRaw(`(${lhs.sql} IS NULL OR ${lhs.sql}::text = '')`, binds(...lhs.bindings, ...lhs.bindings));
      return;

    case 'is_not_empty':
      qb.whereRaw(`(${lhs.sql} IS NOT NULL AND ${lhs.sql}::text <> '')`, binds(...lhs.bindings, ...lhs.bindings));
      return;

    case 'matches': {
      // Postgres regexes are server-side and can be slow; cap the pattern so a
      // saved view cannot become a denial of service.
      if (typeof value !== 'string' || value.length > 256) {
        ctx.unsupported.push({ field: leaf.field, op: leaf.op, reason: 'bad_value' });
        qb.whereRaw('false');
        return;
      }
      qb.whereRaw(`${lhs.sql}::text ~* ?`, binds(...lhs.bindings, value));
      return;
    }

    case 'older_than':
    case 'newer_than': {
      const ms = parseDurationMs(value);
      if (ms === null) {
        ctx.unsupported.push({ field: leaf.field, op: leaf.op, reason: 'bad_value' });
        qb.whereRaw('false');
        return;
      }
      const operator = leaf.op === 'older_than' ? '<' : '>';
      qb.whereRaw(`${lhs.sql} ${operator} (now() - (? || ' milliseconds')::interval)`, binds(...lhs.bindings, String(ms)));
      return;
    }

    default:
      // `changed` / `changed_to` / `changed_from` compare against a BEFORE
      // snapshot, which exists for a rule firing and not for a stored list
      // query. Report it and impose no restriction — blanking the queue over a
      // rule operator that leaked into a view helps nobody.
      ctx.unsupported.push({ field: leaf.field, op: leaf.op, reason: 'unsupported_operator' });
  }
}

function applyNode(qb: Knex.QueryBuilder, node: ConditionNode, ctx: CompileCtx): void {
  if ('all' in node) {
    for (const child of node.all) qb.andWhere((b) => applyNode(b, child, ctx));
    return;
  }
  if ('any' in node) {
    if (node.any.length === 0) {
      qb.whereRaw('false'); // `{ any: [] }` matches nothing, per the shared contract
      return;
    }
    qb.andWhere((b) => {
      for (const child of node.any) b.orWhere((c) => applyNode(c, child, ctx));
    });
    return;
  }
  if ('not' in node) {
    qb.andWhereNot((b) => applyNode(b, node.not, ctx));
    return;
  }
  applyLeaf(qb, node, ctx);
}

/** Compile a stored/ad-hoc condition onto a ticket query. */
export function applyConditionFilter(
  qb: Knex.QueryBuilder,
  raw: unknown,
  actor: ActorContext,
  knex: Executor = db,
): UnsupportedClause[] {
  const node = resolveConditionTokens(toConditionNode(raw), {
    me: actor.userId,
    myGroups: actor.assignmentGroupIds ?? [],
    now: new Date(),
  });
  if (!node) return [];
  const ctx: CompileCtx = { knex, unsupported: [] };
  qb.andWhere((b) => applyNode(b, node, ctx));
  return ctx.unsupported;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — list(): keyset pagination
// ═════════════════════════════════════════════════════════════════════════════
//
// The queue is a virtualised list of up to ~100 000 rows with NO pagination
// controls, so OFFSET is not an option: `OFFSET 90000` makes Postgres walk
// 90 000 rows it then throws away, and — worse — a ticket updated between two
// scroll fetches shifts the window, so a row is silently skipped or shown
// twice. Keyset pagination reads the next page from where the last one ended
// and is therefore both O(page) and stable under concurrent writes.

interface SortSpec {
  column: string;
  kind: 'text' | 'number' | 'timestamp';
}

/** Sort whitelist. Anything not here is refused, never passed through. */
const SORTABLE: Readonly<Record<string, SortSpec>> = {
  updated_at: { column: 'tickets.updated_at', kind: 'timestamp' },
  created_at: { column: 'tickets.created_at', kind: 'timestamp' },
  occurred_at: { column: 'tickets.occurred_at', kind: 'timestamp' },
  due_at: { column: 'tickets.due_at', kind: 'timestamp' },
  first_response_at: { column: 'tickets.first_response_at', kind: 'timestamp' },
  resolved_at: { column: 'tickets.resolved_at', kind: 'timestamp' },
  closed_at: { column: 'tickets.closed_at', kind: 'timestamp' },
  number: { column: 'tickets.number', kind: 'text' },
  subject: { column: 'tickets.subject', kind: 'text' },
  // The baseline slugs (p1..p4) sort in rank order alphabetically. A tenant
  // renaming them keeps a stable — if arbitrary — order rather than an error.
  priority_slug: { column: 'tickets.priority_slug', kind: 'text' },
  status_category: { column: 'tickets.status_category', kind: 'text' },
  queue_slug: { column: 'tickets.queue_slug', kind: 'text' },
  reopen_count: { column: 'tickets.reopen_count', kind: 'number' },
  id: { column: 'tickets.id', kind: 'number' },
};

const DEFAULT_SORT = 'updated_at';

interface CursorPayload {
  v: 1;
  s: string;
  d: 'asc' | 'desc';
  /** Primary sort value at the page boundary; null when the column was NULL. */
  k: string | number | null;
  /** The tiebreaker. Without it, equal timestamps drop or repeat rows. */
  i: number;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
    if (parsed?.v !== 1 || typeof parsed.i !== 'number' || !SORTABLE[parsed.s]) return null;
    if (parsed.d !== 'asc' && parsed.d !== 'desc') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * `filter` is widened to `unknown` on purpose: the server accepts BOTH stored
 * condition dialects (`{ all: [...] }` and `{ op: 'and', children: [...] }`)
 * and normalises them in `applyConditionFilter`. Typing it as `ConditionNode`
 * would force every caller to pre-convert, and the one that forgot would send
 * a tree the compiler blessed and the evaluator could not read.
 */
export interface ListTicketsQuery extends Omit<TicketListQuery, 'filter'> {
  filter?: unknown;
  /** Opaque keyset cursor from the previous page. */
  cursor?: string | null;
  /** Ask for a (possibly approximate) total. Off by default — it costs a scan. */
  withTotal?: boolean;
}

export interface TicketPage {
  items: TicketWithRelations[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Present only when `withTotal`. */
  total?: number;
  /** True when `total` was capped at `PAGINATION.exactCountThreshold`. */
  totalIsApproximate?: boolean;
  /** Clauses the compiler could not honour — surfaced, never swallowed. */
  unsupported: UnsupportedClause[];
}

const OPEN_CATEGORY_LIST: StatusCategory[] = [
  'new',
  'open',
  'pending_requester',
  'pending_third_party',
  'scheduled',
];

async function resolveViewFilter(
  tenantId: number,
  viewSlug: string,
  executor: Executor,
): Promise<unknown> {
  const view = await readPublishedConfigObject(tenantId, 'view', viewSlug, executor);
  return view?.body?.filter ?? null;
}

export async function list(
  tenantId: number,
  actor: ActorContext,
  query: ListTicketsQuery = {},
  executor: Executor = db,
): Promise<TicketPage> {
  const limit = Math.min(
    Math.max(query.limit ?? PAGINATION.defaultLimit, 1),
    PAGINATION.maxLimit,
  );

  const sortKey = query.sortBy && SORTABLE[query.sortBy] ? query.sortBy : DEFAULT_SORT;
  const direction: 'asc' | 'desc' = query.sortDir === 'asc' ? 'asc' : 'desc';
  const sort = SORTABLE[sortKey];

  const qb = scoped('tickets', tenantId, executor);
  if (!query.includeDeleted) qb.whereNull('tickets.deleted_at');

  // ── Column filters ────────────────────────────────────────────────────────
  if (query.statusCategories?.length) qb.whereIn('tickets.status_category', query.statusCategories);
  if (query.queueSlugs?.length) qb.whereIn('tickets.queue_slug', query.queueSlugs);
  if (query.prioritySlugs?.length) qb.whereIn('tickets.priority_slug', query.prioritySlugs);
  if (query.recordTypes?.length) qb.whereIn('tickets.record_type', query.recordTypes);
  if (query.sources?.length) qb.whereIn('tickets.source', query.sources);
  if (query.organizationIds?.length) qb.whereIn('tickets.organization_id', query.organizationIds);
  if (query.assignmentGroupIds?.length) {
    qb.whereIn('tickets.assignment_group_id', query.assignmentGroupIds);
  }
  if (query.assigneeIds?.length) {
    // `0` is the UI's "unassigned" sentinel — an id column cannot hold it, and
    // asking for it separately would double the number of filter chips.
    const ids = query.assigneeIds.filter((id) => id > 0);
    const wantsUnassigned = query.assigneeIds.some((id) => id <= 0);
    qb.andWhere((b) => {
      if (ids.length > 0) b.orWhereIn('tickets.assignee_id', ids);
      if (wantsUnassigned) b.orWhereNull('tickets.assignee_id');
    });
  }
  if (query.ciIds?.length) {
    qb.andWhere((b) => {
      b.orWhereIn('tickets.primary_ci_id', query.ciIds as number[]).orWhereExists((sub) =>
        sub
          .select(executor.raw('1'))
          .from('ticket_cis')
          .whereRaw('ticket_cis.ticket_id = tickets.id')
          .where('ticket_cis.tenant_id', tenantId)
          .whereIn('ticket_cis.ci_id', query.ciIds as number[]),
      );
    });
  }

  // HARD RULE 6 — `occurredFrom/To` filter on when it HAPPENED, which is a
  // different question from when it was filed. Both are offered.
  if (query.occurredFrom) qb.where('tickets.occurred_at', '>=', query.occurredFrom);
  if (query.occurredTo) qb.where('tickets.occurred_at', '<=', query.occurredTo);
  if (query.createdFrom) qb.where('tickets.created_at', '>=', query.createdFrom);
  if (query.createdTo) qb.where('tickets.created_at', '<=', query.createdTo);
  if (query.updatedFrom) qb.where('tickets.updated_at', '>=', query.updatedFrom);
  if (query.updatedTo) qb.where('tickets.updated_at', '<=', query.updatedTo);

  if (typeof query.breachingWithinMinutes === 'number') {
    qb.whereNotNull('tickets.due_at')
      .whereIn('tickets.status_category', OPEN_CATEGORY_LIST)
      .whereRaw(`tickets.due_at <= now() + (? || ' minutes')::interval`, [
        String(Math.max(query.breachingWithinMinutes, 0)),
      ]);
  }

  // ── Saved view + ad-hoc filter (compiled through the whitelist) ────────────
  const unsupported: UnsupportedClause[] = [];
  if (query.viewSlug) {
    const viewFilter = await resolveViewFilter(tenantId, query.viewSlug, executor);
    unsupported.push(...applyConditionFilter(qb, viewFilter, actor, executor));
  }
  if (query.filter) {
    unsupported.push(...applyConditionFilter(qb, query.filter, actor, executor));
  }

  // ── Text ──────────────────────────────────────────────────────────────────
  if (query.q) searchService.applyTicketSearch(qb, query.q, executor);

  // ── Keyset ────────────────────────────────────────────────────────────────
  //
  // ORDER BY <col> <dir> NULLS LAST, id <dir>. NULLS LAST in BOTH directions is
  // what makes one comparator work for both: the null block is always at the
  // end, so "after the cursor" is expressible without a per-direction special
  // case for where NULLs live.
  const comparator = direction === 'desc' ? '<' : '>';
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  if (cursor && cursor.s === sortKey && cursor.d === direction) {
    if (cursor.k === null) {
      // Inside the trailing NULL block: only the tiebreaker moves us on.
      qb.whereRaw(`(?? IS NULL AND tickets.id ${comparator} ?)`, [sort.column, cursor.i]);
    } else {
      qb.whereRaw(
        `(?? ${comparator} ? OR (?? = ? AND tickets.id ${comparator} ?) OR ?? IS NULL)`,
        [sort.column, cursor.k, sort.column, cursor.k, cursor.i, sort.column],
      );
    }
  }

  withRelations(qb, tenantId, executor)
    .orderByRaw(`?? ${direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`, [sort.column])
    .orderBy('tickets.id', direction)
    .limit(limit + 1);

  const rows = (await qb) as unknown as TicketRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(mapTicketRow);

  let nextCursor: string | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1];
    const raw = (last as unknown as Record<string, unknown>)[
      sort.column.replace('tickets.', '')
    ];
    const key =
      raw === null || raw === undefined
        ? null
        : sort.kind === 'timestamp'
          ? isoOrNull(raw as Date | string)
          : sort.kind === 'number'
            ? Number(raw)
            : String(raw);
    nextCursor = encodeCursor({ v: 1, s: sortKey, d: direction, k: key, i: last.id });
  }

  const result: TicketPage = { items, nextCursor, hasMore, unsupported };

  if (query.withTotal) {
    const counted = await countMatching(tenantId, actor, query, executor);
    result.total = counted.total;
    result.totalIsApproximate = counted.approximate;
  }
  return result;
}

/**
 * Count matches, capped.
 *
 * Above `PAGINATION.exactCountThreshold` the answer becomes "5 000+": an exact
 * count of a quarter of a million rows costs a full scan on every keystroke of
 * a filter, and no human has ever made a different decision because the badge
 * said 41 927 rather than "40 000+".
 */
export async function countMatching(
  tenantId: number,
  actor: ActorContext,
  query: ListTicketsQuery,
  executor: Executor = db,
): Promise<{ total: number; approximate: boolean }> {
  const cap = PAGINATION.exactCountThreshold;

  const inner = scoped('tickets', tenantId, executor).select(executor.raw('1'));
  if (!query.includeDeleted) inner.whereNull('tickets.deleted_at');
  if (query.statusCategories?.length) {
    inner.whereIn('tickets.status_category', query.statusCategories);
  }
  if (query.queueSlugs?.length) inner.whereIn('tickets.queue_slug', query.queueSlugs);
  if (query.prioritySlugs?.length) inner.whereIn('tickets.priority_slug', query.prioritySlugs);
  if (query.assigneeIds?.length) {
    inner.whereIn('tickets.assignee_id', query.assigneeIds.filter((id) => id > 0));
  }
  if (query.viewSlug) {
    applyConditionFilter(inner, await resolveViewFilter(tenantId, query.viewSlug, executor), actor, executor);
  }
  if (query.filter) applyConditionFilter(inner, query.filter, actor, executor);
  if (query.q) searchService.applyTicketSearch(inner, query.q, executor);
  inner.limit(cap + 1);

  const rows = (await executor
    .from(inner.as('capped'))
    .count({ count: '*' })) as unknown as Array<{ count: string }>;

  const total = Number(rows?.[0]?.count ?? 0);
  return { total: Math.min(total, cap), approximate: total > cap };
}

/** Full-text search, hydrated into the DTO the UI renders. */
export async function search(
  tenantId: number,
  actor: ActorContext,
  q: string,
  options: { limit?: number; executor?: Executor } = {},
): Promise<TicketSearchHit[]> {
  const executor = options.executor ?? db;
  const hits = await searchService.searchTickets(tenantId, q, {
    limit: options.limit,
    executor,
  });
  if (hits.length === 0) return [];

  const qb = scoped('tickets', tenantId, executor).whereIn(
    'tickets.id',
    hits.map((hit) => hit.ticketId),
  );
  const rows = (await withRelations(qb, tenantId, executor)) as unknown as TicketRow[];
  const byId = new Map(rows.map((row) => [row.id, mapTicketRow(row)]));

  // Preserve the ranker's order; the SQL IN() above does not guarantee it.
  return hits
    .map((hit) => {
      const ticket = byId.get(hit.ticketId);
      return ticket
        ? ({ ticket, highlight: hit.highlight ?? undefined, rank: hit.rank } as TicketSearchHit)
        : null;
    })
    .filter((hit): hit is TicketSearchHit => hit !== null);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — create()
// ═════════════════════════════════════════════════════════════════════════════

export interface CreateTicketInput extends CreateTicketRequest {
  /** Required when `prioritySlug` disagrees with the matrix (HARD RULE 2). */
  priorityOverrideReason?: string | null;
  /**
   * The first timeline entry. Mail intake passes the original message so the
   * conversation starts with what the requester actually wrote; the web form
   * leaves it out and gets a `system` "ticket created" row.
   */
  openingEntry?: {
    kind: 'public_reply' | 'work_note' | 'system' | 'alert';
    visibility?: JournalVisibility;
    bodyMd?: string | null;
    meta?: JournalMeta;
  } | null;
  /** Set when an engine created the ticket (HARD RULE 3 — a slug). */
  ruleSlug?: string | null;
}

export async function create(
  tenantId: number,
  actor: ActorContext,
  payload: CreateTicketInput,
  trx?: Knex.Transaction,
): Promise<TicketWithRelations> {
  const run = async (tx: Knex.Transaction): Promise<TicketWithRelations> => {
    const subject = (payload.subject ?? '').trim();
    if (subject === '') throw new AppError(400, 'A subject is required');

    const recordType: TicketRecordType = (TICKET_RECORD_TYPES as readonly string[]).includes(
      payload.recordType ?? '',
    )
      ? (payload.recordType as TicketRecordType)
      : 'incident';

    const source: TicketSource = (TICKET_SOURCES as readonly string[]).includes(payload.source ?? '')
      ? (payload.source as TicketSource)
      : 'web';

    const queueSlug = payload.queueSlug?.trim() || DEFAULT_QUEUE_SLUG;

    // ── Status comes from the machine, not from the caller's imagination ────
    const machine = await loadStateMachineForTicket(tenantId, { queueSlug }, tx);
    const statusSlug = payload.statusSlug?.trim() || machine.initialStatusSlug;
    const statusCategory = categoryOf(machine, statusSlug);
    if (!statusCategory) {
      throw new AppError(400, `Status "${statusSlug}" is not part of the "${machine.slug}" lifecycle`);
    }

    // ── Priority is DERIVED; an explicit disagreement is an override ────────
    const matrix = await loadPriorityMatrix(tenantId, undefined, tx);
    const computed = computePriority(matrix, payload.impact, payload.urgency);
    let prioritySlug = computed.prioritySlug;

    if (payload.prioritySlug && payload.prioritySlug !== computed.prioritySlug) {
      const override = await applyPriorityOverride({
        tenantId,
        // No id yet — the ticket is inserted a few lines below. The decision
        // row is still written here, on the same code path as the choice.
        ticketId: null,
        actor,
        computedSlug: computed.prioritySlug,
        chosenSlug: payload.prioritySlug,
        reason: payload.priorityOverrideReason,
        impact: computed.impact,
        urgency: computed.urgency,
        trx: tx,
      });
      prioritySlug = override.prioritySlug;
    }

    // HARD RULE 6 — occurred_at is captured HERE, at intake, and defaults to
    // now only because "now" is the honest answer when nobody was asked. It is
    // never derived from created_at later: if it was not captured, it is gone.
    const occurredAt = payload.occurredAt ? new Date(payload.occurredAt) : new Date();

    const number = await allocateTicketNumber(tenantId, tx);

    const suppliedFields = [
      'subject',
      ...(payload.descriptionMd ? ['description_md'] : []),
      ...(payload.impact ? ['impact'] : []),
      ...(payload.urgency ? ['urgency'] : []),
      ...(payload.assigneeId ? ['assignee_id'] : []),
      ...(payload.assignmentGroupId ? ['assignment_group_id'] : []),
      'priority_slug',
      'queue_slug',
      'status_slug',
      'occurred_at',
    ];

    const inserted = (await insertScoped(
      'tickets',
      tenantId,
      {
        record_type: recordType,
        number: number.number,
        subject: subject.slice(0, LIMITS.subjectMaxLength),
        description_md: payload.descriptionMd ?? null,
        description_html: null,
        status_slug: statusSlug,
        status_category: statusCategory,
        priority_slug: prioritySlug,
        impact: payload.impact ?? computed.impact,
        urgency: payload.urgency ?? computed.urgency,
        queue_slug: queueSlug,
        assignment_group_id: payload.assignmentGroupId ?? null,
        assignee_id: payload.assigneeId ?? null,
        requester_contact_id: payload.requesterContactId ?? null,
        requester_user_id: payload.requesterUserId ?? null,
        organization_id: payload.organizationId ?? null,
        primary_ci_id: payload.primaryCiId ?? null,
        source,
        occurred_at: occurredAt,
        parent_ticket_id: payload.parentTicketId ?? null,
        data: JSON.stringify(payload.data ?? {}),
        set_by: JSON.stringify(stampProvenance({}, suppliedFields, actor, payload.ruleSlug)),
        row_version: 1,
      },
      tx,
    ).returning('*')) as unknown as TicketRow[];

    const ticket = mapTicketRow(inserted[0]);

    // ── CI link, watchers, attachments ────────────────────────────────────
    if (payload.primaryCiId) {
      await insertScoped(
        'ticket_cis',
        tenantId,
        { ticket_id: ticket.id, ci_id: payload.primaryCiId, role: 'primary' },
        tx,
      )
        .onConflict(['ticket_id', 'ci_id'])
        .ignore();
    }
    if (ticket.assigneeId) await addWatcher(tenantId, ticket.id, { userId: ticket.assigneeId, reason: 'assignee' }, tx);
    if (ticket.requesterUserId) {
      await addWatcher(tenantId, ticket.id, { userId: ticket.requesterUserId, reason: 'requester' }, tx);
    }
    if (ticket.requesterContactId) {
      await addWatcher(tenantId, ticket.id, { contactId: ticket.requesterContactId, reason: 'requester' }, tx);
      await insertScoped(
        'ticket_participant',
        tenantId,
        { ticket_id: ticket.id, contact_id: ticket.requesterContactId, role: 'requester' },
        tx,
      )
        .onConflict(['ticket_id', 'contact_id', 'role'])
        .ignore();
    }
    if (payload.attachmentIds?.length) {
      await attachmentService.linkMany(
        tenantId,
        payload.attachmentIds,
        { entityType: 'ticket', entityId: ticket.id },
        tx,
      );
    }

    // ── The opening journal entry ─────────────────────────────────────────
    const opening = payload.openingEntry;
    await journalService.append(
      {
        tenantId,
        ticketId: ticket.id,
        kind: opening?.kind ?? 'system',
        visibility: opening?.visibility ?? (opening?.kind === 'public_reply' ? 'public' : 'internal'),
        authorId: actor.userId,
        authorType: actor.actorType,
        bodyMd: opening?.bodyMd ?? null,
        meta: {
          created: true,
          number: ticket.number,
          source,
          // Kept on the entry so the timeline can show "happened 06:14, filed
          // 08:30" without a second read of the ticket row.
          occurredAt: ticket.occurredAt,
          queueSlug,
          statusSlug,
          toCategory: statusCategory,
          ...(payload.ruleSlug ? { ruleSlug: payload.ruleSlug } : {}),
          ...(opening?.meta ?? {}),
        },
        emit: false, // the ticket:created event below already carries the ticket
      },
      tx,
    );

    // ── Engines, on the same code path (HARD RULE 2) ──────────────────────
    await withDecision(
      {
        tenantId,
        ticketId: ticket.id,
        subsystem: 'workflow',
        decision: 'ticket_created',
        ruleSlug: payload.ruleSlug ?? machine.slug,
        ruleVersion: machine.version,
        actorId: actor.userId ?? null,
        trx: tx,
        inputs: {
          fields: {
            source,
            recordType,
            queueSlug,
            statusSlug,
            statusCategory,
            prioritySlug,
            impact: ticket.impact,
            urgency: ticket.urgency,
            occurredAt: ticket.occurredAt,
            createdAt: ticket.createdAt,
          },
        },
      },
      async (recorder) => {
        recorder?.outcome?.({ ticketId: ticket.id, number: ticket.number });
      },
    );

    await runHook('sla.onTicketCreated', tenantId, ticket.id, () =>
      slaEngine.onTicketCreated?.({ tenantId, ticket, trx: tx }),
    );
    await runHook('rules.onTicketCreated', tenantId, ticket.id, () =>
      rulesEngine.onTicketCreated?.({ tenantId, ticket, previous: null, actor, trx: tx }),
    );

    return ticket;
  };

  const created = trx ? await run(trx) : await db.transaction(run);

  // Re-read so rules that changed the row (routing, auto-assign) are reflected
  // in what the caller and the socket both receive. Through `trx` when the
  // caller owns the transaction — `db` would not see the uncommitted insert.
  const hydrated = (await getById(tenantId, created.id, { executor: trx ?? db })) ?? created;

  // A caller-owned transaction may still roll back, so the event is theirs to
  // send once it has committed (see `split()` and `reopen()`).
  if (!trx) emitTicketCreated(tenantId, hydrated);
  return hydrated;
}

/** Announce a new ticket. Split out so callers that own the transaction can
 *  emit after THEIR commit rather than before it. */
export function emitTicketCreated(tenantId: number, ticket: TicketWithRelations): void {
  emitDeskEvent(
    [ROOMS.tenant(tenantId), ROOMS.queue(tenantId, ticket.queueSlug)],
    SOCKET_EVENTS.ticketCreated,
    { tenantId, at: new Date().toISOString(), ticket },
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — update(): inline edits
// ═════════════════════════════════════════════════════════════════════════════

/** Patchable columns. `status_slug` is absent on purpose: that is a transition. */
const PATCHABLE: Readonly<Record<keyof UpdateTicketRequest & string, string | null>> = {
  baseRowVersion: null,
  subject: 'subject',
  descriptionMd: 'description_md',
  prioritySlug: 'priority_slug',
  impact: 'impact',
  urgency: 'urgency',
  queueSlug: 'queue_slug',
  assignmentGroupId: 'assignment_group_id',
  assigneeId: 'assignee_id',
  requesterContactId: 'requester_contact_id',
  organizationId: 'organization_id',
  primaryCiId: 'primary_ci_id',
  occurredAt: 'occurred_at',
  dueAt: 'due_at',
  resolutionCode: 'resolution_code',
  resolutionMd: 'resolution_md',
  data: null,
};

export interface UpdateTicketInput extends UpdateTicketRequest {
  priorityOverrideReason?: string | null;
  ruleSlug?: string | null;
}

function buildConflict(
  current: TicketWithRelations,
  patch: UpdateTicketInput,
): TicketConflict {
  const conflicting: string[] = [];
  for (const key of Object.keys(patch) as Array<keyof UpdateTicketInput>) {
    if (key === 'baseRowVersion' || key === 'priorityOverrideReason' || key === 'ruleSlug') continue;
    if (key === 'data') {
      for (const dataKey of Object.keys(patch.data ?? {})) {
        if (current.data[dataKey] !== (patch.data ?? {})[dataKey]) conflicting.push(`data.${dataKey}`);
      }
      continue;
    }
    const requested = patch[key];
    const actual = (current as unknown as Record<string, unknown>)[key];
    if (requested !== undefined && requested !== actual) conflicting.push(key);
  }
  return { code: 'version_conflict', current, conflictingFields: conflicting };
}

/**
 * Inline autosave.
 *
 * HARD RULE 12: this NEVER validates required-ness. An agent can empty the
 * resolution notes, leave the assignee blank and walk away — the ticket is
 * simply not resolvable until `transition()` says so. Enforcing required-ness
 * here is what produces the classic "I cannot save my one-character typo fix
 * because a field I have never heard of is empty" experience.
 *
 * HARD RULE 7: the UPDATE carries `WHERE row_version = :base` and bumps the
 * version in the SAME statement. A mismatch cannot be reported as success by a
 * race, because there is no read-then-write window to lose.
 */
export async function update(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  patch: UpdateTicketInput,
  trx?: Knex.Transaction,
): Promise<TicketWithRelations> {
  const run = async (tx: Knex.Transaction) => {
    const before = await lockTicket(tenantId, ticketId, tx);
    const beforeTicket = mapTicketRow(before);

    if (beforeTicket.rowVersion !== patch.baseRowVersion) {
      const current = (await getById(tenantId, ticketId, { executor: tx })) ?? beforeTicket;
      throw new TicketVersionConflictError(buildConflict(current, patch));
    }

    const columns: Record<string, unknown> = {};
    const changed: Array<{ field: string; from: unknown; to: unknown }> = [];
    const provenanceFields: string[] = [];

    for (const [key, column] of Object.entries(PATCHABLE)) {
      if (column === null) continue;
      const value = (patch as unknown as Record<string, unknown>)[key];
      if (value === undefined) continue;

      const currentValue = (beforeTicket as unknown as Record<string, unknown>)[key];
      const normalised =
        key === 'occurredAt' || key === 'dueAt'
          ? value === null
            ? null
            : new Date(value as string)
          : value;

      if (currentValue === value) continue;
      columns[column] = normalised;
      changed.push({ field: key, from: currentValue, to: value });
      provenanceFields.push(column);
    }

    // `data` is MERGED, never replaced: an inline edit sends only the field it
    // changed, and replacing the bag would silently drop every other custom
    // field the form did not happen to render.
    if (patch.data) {
      const merged = { ...beforeTicket.data };
      for (const [key, value] of Object.entries(patch.data)) {
        if (merged[key] === value) continue;
        changed.push({ field: `data.${key}`, from: merged[key], to: value });
        provenanceFields.push(`data.${key}`);
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      columns.data = JSON.stringify(merged);
    }

    // ── Priority: recompute or override ───────────────────────────────────
    const impactChanged = patch.impact !== undefined && patch.impact !== beforeTicket.impact;
    const urgencyChanged = patch.urgency !== undefined && patch.urgency !== beforeTicket.urgency;

    if (impactChanged || urgencyChanged || patch.prioritySlug !== undefined) {
      const matrix = await loadPriorityMatrix(tenantId, undefined, tx);
      const computed = computePriority(
        matrix,
        patch.impact ?? beforeTicket.impact,
        patch.urgency ?? beforeTicket.urgency,
      );

      if (patch.prioritySlug !== undefined && patch.prioritySlug !== computed.prioritySlug) {
        const override = await applyPriorityOverride({
          tenantId,
          ticketId,
          actor,
          computedSlug: computed.prioritySlug,
          chosenSlug: patch.prioritySlug,
          reason: patch.priorityOverrideReason,
          impact: computed.impact,
          urgency: computed.urgency,
          trx: tx,
        });
        columns.priority_slug = override.prioritySlug;
      } else if (patch.prioritySlug === undefined && matrix.recomputeOnChange) {
        if (computed.prioritySlug !== beforeTicket.prioritySlug) {
          columns.priority_slug = computed.prioritySlug;
          changed.push({
            field: 'prioritySlug',
            from: beforeTicket.prioritySlug,
            to: computed.prioritySlug,
          });
          provenanceFields.push('priority_slug');
        }
      }
    }

    if (Object.keys(columns).length === 0) return { ticket: beforeTicket, changed: [] as typeof changed };

    columns.set_by = JSON.stringify(
      stampProvenance(beforeTicket.setBy, provenanceFields, actor, patch.ruleSlug),
    );
    columns.updated_at = tx.fn.now();

    const updated = (await scoped('tickets', tenantId, tx)
      .where('tickets.id', ticketId)
      .where('tickets.row_version', patch.baseRowVersion)
      .update({ ...columns, row_version: tx.raw('row_version + 1') })
      .returning('*')) as unknown as TicketRow[];

    if (updated.length === 0) {
      const current = (await getById(tenantId, ticketId, { executor: tx })) ?? beforeTicket;
      throw new TicketVersionConflictError(buildConflict(current, patch));
    }

    const ticket = mapTicketRow(updated[0]);

    // Subscribing the new assignee is DATA, not an event, so it belongs inside
    // the transaction — a caller-owned transaction that rolls back must not
    // leave a watcher behind for an assignment that never happened.
    if (changed.some((c) => c.field === 'assigneeId') && ticket.assigneeId) {
      await addWatcher(tenantId, ticketId, { userId: ticket.assigneeId, reason: 'assignee' }, tx);
    }

    await journalService.append(
      {
        tenantId,
        ticketId,
        kind: 'state_change',
        visibility: 'internal',
        authorId: actor.userId,
        authorType: actor.actorType,
        meta: {
          changes: changed,
          ...(patch.ruleSlug ? { ruleSlug: patch.ruleSlug } : {}),
        },
        emit: false,
      },
      tx,
    );

    await withDecision(
      {
        tenantId,
        ticketId,
        subsystem: 'workflow',
        decision: 'ticket_fields_updated',
        ruleSlug: patch.ruleSlug ?? null,
        actorId: actor.userId ?? null,
        trx: tx,
        inputs: { fields: Object.fromEntries(changed.map((c) => [c.field, c.to])) },
      },
      async (recorder) => {
        recorder?.outcome?.({ rowVersion: ticket.rowVersion, changedFields: changed.map((c) => c.field) });
      },
    );

    // Before the rules engine, for the same reason `create()` runs SLA first:
    // a rule that reacts to the new priority should see the clock that the
    // priority change already moved, not race it.
    await runFieldChangeHooks(tenantId, beforeTicket, ticket, actor.userId ?? null, tx);

    await runHook('rules.onTicketUpdated', tenantId, ticketId, () =>
      rulesEngine.onTicketUpdated?.({
        tenantId,
        ticket,
        previous: beforeTicket,
        actor,
        trx: tx,
        changedFields: changed.map((c) => c.field),
      }),
    );

    return { ticket, changed };
  };

  const { ticket, changed } = trx ? await run(trx) : await db.transaction(run);
  if (changed.length === 0) return ticket;

  const hydrated = (await getById(tenantId, ticketId, { executor: trx ?? db })) ?? ticket;
  const changedFields = changed.map((c) => c.field);
  // Inside a caller-owned transaction the change is not durable yet; the caller
  // emits once it commits.
  if (trx) return hydrated;

  emitDeskEvent(
    [ROOMS.ticket(ticketId), ROOMS.tenant(tenantId), ROOMS.queue(tenantId, hydrated.queueSlug)],
    SOCKET_EVENTS.ticketUpdated,
    {
      tenantId,
      at: new Date().toISOString(),
      ticketId,
      ticket: hydrated,
      changedFields,
      rowVersion: hydrated.rowVersion,
      actorId: actor.userId ?? null,
      actorType: actor.actorType,
    },
  );

  const assignmentChange = changed.find((c) => c.field === 'assigneeId');
  if (assignmentChange) {
    emitDeskEvent([ROOMS.ticket(ticketId), ROOMS.tenant(tenantId)], SOCKET_EVENTS.ticketAssigned, {
      tenantId,
      at: new Date().toISOString(),
      ticketId,
      number: hydrated.number,
      subject: hydrated.subject,
      fromAssigneeId: (assignmentChange.from ?? null) as number | null,
      toAssigneeId: hydrated.assigneeId,
      assignmentGroupId: hydrated.assignmentGroupId,
      actorId: actor.userId ?? null,
      ruleSlug: patch.ruleSlug ?? null,
    });
  }

  return hydrated;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — transition(): the ONLY place required-ness is enforced
// ═════════════════════════════════════════════════════════════════════════════

/** Gather the `context.*` values the baseline guards ask about. */
async function loadTransitionExtras(
  tenantId: number,
  ticket: Ticket,
  executor: Executor,
): Promise<TransitionContextExtras> {
  const [publicReplies, approval] = await Promise.all([
    journalService.publicReplyCount(tenantId, ticket.id, executor),
    scoped('approvals', tenantId, executor)
      .where('approvals.ticket_id', ticket.id)
      .orderBy('approvals.id', 'desc')
      .first<{ state: string }>('approvals.state'),
  ]);

  const msPerDay = 86_400_000;
  const sinceUpdate = Date.now() - new Date(ticket.updatedAt).getTime();
  const closedAt = ticket.closedAt ?? ticket.resolvedAt;

  return {
    publicReplyCount: publicReplies,
    approvalState: approval?.state ?? null,
    // Calendar-day approximations. The SLA engine owns real business time; a
    // guard that says "5 days without a reply" does not need minute accuracy,
    // and pulling the calendar in here would make every button render a query.
    businessDaysInStatus: Math.floor(sinceUpdate / msPerDay),
    businessDaysSinceClosed: closedAt
      ? Math.floor((Date.now() - new Date(closedAt).getTime()) / msPerDay)
      : 0,
  };
}

export interface AvailableTransitionsResult {
  machineSlug: string;
  currentStatusSlug: string;
  currentCategory: StatusCategory;
  transitions: TransitionDecision[];
}

/**
 * What the header bar may render. Includes blocked moves WITH their reasons —
 * a greyed-out "Resolve" that explains itself is the whole point.
 */
export async function getAvailableTransitions(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  executor: Executor = db,
): Promise<AvailableTransitionsResult> {
  const ticket = await getById(tenantId, ticketId, { executor });
  if (!ticket) throw new AppError(404, 'Ticket not found');

  const [machine, requiredWhenFields] = await Promise.all([
    loadStateMachineForTicket(tenantId, ticket, executor),
    loadRequiredWhenFields(tenantId, executor),
  ]);
  const extras = await loadTransitionExtras(tenantId, ticket, executor);

  const transitions = evaluateAvailableTransitions({
    machine,
    ticket,
    actor,
    extras,
    requiredWhenFields,
    now: new Date().toISOString(),
  });

  return {
    machineSlug: machine.slug,
    currentStatusSlug: ticket.statusSlug,
    currentCategory: ticket.statusCategory,
    // A pending approval is the one refusal `evaluateTransition()` cannot see:
    // it is a query, and the evaluator is synchronous so the header bar can
    // render a list of tickets without a query per button. It is merged in here
    // instead, so the inspector says "bloqué : l'approbation « CAB » attend
    // Marie Dupont" in the PREVIEW rather than in a 409 after the click.
    transitions: await applyApprovalBlocks(tenantId, ticketId, transitions, executor),
  };
}

/**
 * Apply a transition's declared effects to the pending column patch.
 *
 * Every field goes through `resolveTicketFieldPath()` and is skipped unless it
 * is WRITABLE: a state machine may set `resolution_code`, and must not be able
 * to set `row_version`, `number` or `tenant_id`.
 */
function applyEffects(
  decision: TransitionDecision,
  ticket: Ticket,
  columns: Record<string, unknown>,
  data: Record<string, unknown>,
  provenanceFields: string[],
): void {
  for (const effect of decision.effects) {
    const ref = resolveTicketFieldPath(effect.field);
    if (!ref || !ref.writable) continue;

    if (ref.jsonKey !== undefined) {
      if (effect.type === 'clear_field') delete data[ref.jsonKey];
      else if (effect.type === 'increment_field') {
        data[ref.jsonKey] = Number(data[ref.jsonKey] ?? 0) + effect.value;
      } else data[ref.jsonKey] = pickLocalized(effect.value);
      provenanceFields.push(`data.${ref.jsonKey}`);
      continue;
    }

    const column = ref.column.replace('tickets.', '');
    if (effect.type === 'clear_field') columns[column] = null;
    else if (effect.type === 'increment_field') {
      const current = Number((ticket as unknown as Record<string, unknown>)[column] ?? 0);
      columns[column] = current + effect.value;
    } else columns[column] = pickLocalized(effect.value);
    provenanceFields.push(column);
  }
}

/** Effect values may be `{ en, fr }` maps; the column stores one string. */
function pickLocalized(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const map = value as Record<string, unknown>;
    if (typeof map.fr === 'string' || typeof map.en === 'string') return map.fr ?? map.en;
  }
  return value;
}

export interface TransitionInput extends TransitionTicketRequest {
  ruleSlug?: string | null;
  /** Skip guards and required-ness. ONLY for system merges/reopens. */
  system?: boolean;
  /**
   * The instant the state change ACTUALLY happened, when that is not now.
   *
   * A human clicking Resolve resolves it now, so this stays undefined. But an
   * alert recovery carries the source app's real recovery timestamp, and an
   * imported ticket carries the original one. Stamping now() in those cases
   * inflates MTTR by the delivery lag — silently, and in the direction that
   * flatters the team, which is the worst kind of wrong number.
   */
  effectiveAt?: string | Date | null;
}

/**
 * Move a ticket to another status.
 *
 * This is the one door required-ness comes through (HARD RULE 12). On refusal
 * it does not throw a bare 422: it throws the whole `TransitionDecision`, so
 * the UI can render "Résoudre — bloqué : les notes de résolution sont vides ;
 * vous n'êtes pas dans le groupe N2" instead of "Forbidden".
 *
 * The whole thing runs inside `withDecision()`, so the decision_log row lands
 * on the same code path whether the answer was yes or no — "why was I not
 * allowed to close this?" is a question decision_log must be able to answer.
 */
export async function transition(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  request: TransitionInput,
  trx?: Knex.Transaction,
): Promise<{ ticket: TicketWithRelations; decision: TransitionDecision }> {
  const run = async (tx: Knex.Transaction) => {
    const before = await lockTicket(tenantId, ticketId, tx);
    const beforeTicket = mapTicketRow(before);

    if (beforeTicket.rowVersion !== request.baseRowVersion) {
      const current = (await getById(tenantId, ticketId, { executor: tx })) ?? beforeTicket;
      throw new TicketVersionConflictError({
        code: 'version_conflict',
        current,
        conflictingFields: ['statusSlug'],
      });
    }

    const [machine, requiredWhenFields] = await Promise.all([
      loadStateMachineForTicket(tenantId, beforeTicket, tx),
      loadRequiredWhenFields(tenantId, tx),
    ]);
    const extras = await loadTransitionExtras(tenantId, beforeTicket, tx);
    const now = new Date().toISOString();

    // Values the transition dialog collected, plus the two the request carries
    // as first-class properties because every desk needs them.
    const pending: Record<string, unknown> = { ...(request.fields ?? {}) };
    if (request.resolutionCode !== undefined) pending['ticket.resolution_code'] = request.resolutionCode;
    if (request.resolutionMd !== undefined) pending['ticket.resolution_md'] = request.resolutionMd;

    const decision = evaluateTransition({
      machine,
      ticket: beforeTicket,
      actor,
      toStatusSlug: request.toStatusSlug,
      fields: pending,
      extras,
      requiredWhenFields,
      now,
    });

    const decisionInputs = {
      fields: {
        fromStatusSlug: beforeTicket.statusSlug,
        fromCategory: beforeTicket.statusCategory,
        toStatusSlug: request.toStatusSlug,
        transitionSlug: decision.transitionSlug,
        actorType: actor.actorType,
        ...extras,
      },
      trace: decision.guardTrace ?? undefined,
    };

    // ── Refusal ───────────────────────────────────────────────────────────
    //
    // "Why was I not allowed to close this?" is a question decision_log has to
    // answer, so a refusal is logged as deliberately as a success. It is logged
    // WITHOUT the transaction on purpose: the throw below rolls `tx` back, and
    // a decision row that rolls back with the thing it was explaining explains
    // nothing.
    if (!decision.allowed && request.system !== true) {
      await withDecision(
        {
          tenantId,
          ticketId,
          subsystem: 'workflow',
          decision: 'transition_refused',
          ruleSlug: request.ruleSlug ?? machine.slug,
          ruleVersion: machine.version,
          actorId: actor.userId ?? null,
          inputs: decisionInputs,
        },
        async (recorder) => {
          recorder?.outcome?.({
            allowed: false,
            reason: decision.reason,
            blocked: decision.blocked.map((b) => b.code),
            missingRequiredFields: decision.missingRequiredFields,
            missingCapabilities: decision.missingCapabilities,
          });
        },
      );
      throw new TransitionRefusedError(decision);
    }

    // ── A pending approval BLOCKS the move ────────────────────────────────
    //
    // `getAvailableTransitions()` already previews this, but a preview computed
    // when the page rendered is a description, not a control: the approver can
    // still be pending when the click lands. This is the enforcement, and it
    // throws a 409 carrying the approver's NAME rather than a bare refusal.
    //
    // Skipped for `system: true` on exactly the same grounds as the guards
    // above: a merge, a reopen and an alert recovery are facts arriving from
    // elsewhere, not moves an approver was ever asked to gate.
    if (request.system !== true) {
      await approvalEngine()?.assertTransitionAllowed(
        tenantId,
        ticketId,
        request.toStatusSlug,
        decision.toCategory,
        tx,
      );

      // A change carries gates an approval definition cannot express: its
      // backout plan, its planned window, a freeze it falls inside, a conflict
      // somebody has to acknowledge. Refused HERE rather than in the change
      // routes, because the transition is reachable from the rules engine, a
      // macro and the bulk bar as well — gating only the module's own screen
      // would leave three doors open.
      //
      // Skipped for `system: true` on the same grounds as the approval gate
      // above: a merge or an alert recovery is a fact arriving from elsewhere.
      // `toCategory` is null on a transition the machine leaves categoryless;
      // there is no change gate to apply to a move that lands nowhere.
      if (decision.toCategory !== null) {
        await changeEngine()?.assertTransitionAllowed(
          tenantId,
          ticketId,
          decision.toCategory,
          tx,
          actor,
        );
      }
    }

    return withDecision(
      {
        tenantId,
        ticketId,
        subsystem: 'workflow',
        decision: 'transition_applied',
        ruleSlug: request.ruleSlug ?? machine.slug,
        ruleVersion: machine.version,
        actorId: actor.userId ?? null,
        trx: tx,
        inputs: decisionInputs,
      },
      async (recorder) => {
        const target = machine.statusBySlug.get(request.toStatusSlug);
        const toCategory: StatusCategory =
          target?.category ?? toStatusCategory(request.toStatusSlug, beforeTicket.statusCategory);

        const columns: Record<string, unknown> = {
          status_slug: request.toStatusSlug,
          status_category: toCategory,
          updated_at: tx.fn.now(),
        };
        const data = { ...beforeTicket.data };
        const provenanceFields = ['status_slug', 'status_category'];

        // The dialog may write ONLY what the transition asked it for.
        //
        // Without this the endpoint becomes a second, unguarded write path:
        // `fields: { 'ticket.priority_slug': 'p1' }` on any transition would
        // set the priority while skipping the override-reason rule that
        // `update()` enforces. A transition writes its own prompts; everything
        // else is an inline edit and goes through PATCH.
        const promptable = new Set<string>(['ticket.resolution_code', 'ticket.resolution_md']);
        for (const path of decision.promptFor) {
          const ref = resolveTicketFieldPath(path);
          if (ref) promptable.add(ref.path);
        }

        // Dialog values first, then the transition's own effects: a transition
        // that says `resolution_code = 'no_response'` is stating policy and
        // must win over whatever the form happened to submit.
        for (const [rawPath, value] of Object.entries(pending)) {
          const ref = resolveTicketFieldPath(rawPath);
          if (!ref || !ref.writable || !promptable.has(ref.path)) continue;
          if (ref.jsonKey !== undefined) {
            data[ref.jsonKey] = value;
            provenanceFields.push(`data.${ref.jsonKey}`);
          } else {
            columns[ref.column.replace('tickets.', '')] = value;
            provenanceFields.push(ref.column.replace('tickets.', ''));
          }
        }
        applyEffects(decision, beforeTicket, columns, data, provenanceFields);
        columns.data = JSON.stringify(data);

        // Category-driven timestamps (HARD RULE 5 — never keyed off the slug).
        // effectiveAt wins over now() when the caller knows the real instant
        // (alert recovery, import). See TransitionInput.effectiveAt.
        const stampedAt = request.effectiveAt ? new Date(request.effectiveAt) : null;
        const at = () => (stampedAt && !Number.isNaN(stampedAt.getTime()) ? stampedAt : tx.fn.now());
        if (toCategory === 'resolved' && !beforeTicket.resolvedAt) columns.resolved_at = at();
        if (toCategory === 'closed') {
          columns.closed_at = at();
          if (!beforeTicket.resolvedAt) columns.resolved_at = at();
        }
        if (toCategory === 'cancelled' && !beforeTicket.closedAt) columns.closed_at = at();
        if (!isTerminal(toCategory) && toCategory !== 'resolved') {
          columns.resolved_at = null;
          columns.closed_at = null;
        }

        columns.set_by = JSON.stringify(
          stampProvenance(beforeTicket.setBy, provenanceFields, actor, request.ruleSlug),
        );

        const updated = (await scoped('tickets', tenantId, tx)
          .where('tickets.id', ticketId)
          .where('tickets.row_version', request.baseRowVersion)
          .update({ ...columns, row_version: tx.raw('row_version + 1') })
          .returning('*')) as unknown as TicketRow[];

        if (updated.length === 0) {
          const current = (await getById(tenantId, ticketId, { executor: tx })) ?? beforeTicket;
          throw new TicketVersionConflictError({
            code: 'version_conflict',
            current,
            conflictingFields: ['statusSlug'],
          });
        }

        const ticket = mapTicketRow(updated[0]);

        const stateEntry = await journalService.append(
          {
            tenantId,
            ticketId,
            kind: 'state_change',
            visibility: 'internal',
            authorId: actor.userId,
            authorType: actor.actorType,
            meta: {
              fromStatusSlug: beforeTicket.statusSlug,
              toStatusSlug: ticket.statusSlug,
              fromCategory: beforeTicket.statusCategory,
              toCategory: ticket.statusCategory,
              transitionSlug: decision.transitionSlug,
              ...(request.ruleSlug ? { ruleSlug: request.ruleSlug } : {}),
            },
            emit: false,
          },
          tx,
        );

        // An optional comment rides the SAME transaction: "resolved, here is
        // why" must not be able to half-commit.
        if (request.comment?.bodyMd) {
          await addJournalEntry(
            tenantId,
            actor,
            ticketId,
            {
              kind: request.comment.visibility === 'public' ? 'public_reply' : 'work_note',
              visibility: request.comment.visibility,
              bodyMd: request.comment.bodyMd,
            },
            tx,
          );
        }

        await runHook('sla.onCategoryChanged', tenantId, ticketId, () =>
          slaEngine.onCategoryChanged?.({
            tenantId,
            ticket,
            fromCategory: beforeTicket.statusCategory,
            toCategory: ticket.statusCategory,
            trx: tx,
          }),
        );

        // A transition's `effects` can set the priority outright, so the same
        // comparison `update()` runs belongs here too — the clock must move
        // whichever door changed the field.
        await runFieldChangeHooks(tenantId, beforeTicket, ticket, actor.userId ?? null, tx);

        // ── The two lifecycle engines ─────────────────────────────────────
        //
        // `resolved` is included alongside the terminal categories on purpose.
        // It is deliberately NOT terminal (the requester can still push back and
        // the auto-close job has not run), but it is equally not a state anybody
        // should be paged about at 03:00, and an approval nobody can answer any
        // more is a row that would block the reopen for no reason.
        //
        // Coming back out is symmetric: `reopen()` arms the ladders again through
        // `onTicketEvent('reopened')`, and any transition back into the workable
        // set runs `startRequiredApprovals()` in the else branch below.
        const settled = isTerminal(ticket.statusCategory) || ticket.statusCategory === 'resolved';
        const closeReason = `ticket_${ticket.statusCategory}`;

        if (settled) {
          await runHook('escalation.cancelForTicket', tenantId, ticketId, async () => {
            await escalationEngine()?.cancelForTicket(tenantId, ticketId, closeReason, {
              trx: tx,
              actorId: actor.userId ?? null,
            });
          });
          await runHook('approval.cancelForTicket', tenantId, ticketId, async () => {
            await approvalEngine()?.cancelForTicket(tenantId, ticketId, closeReason, {
              trx: tx,
              actorId: actor.userId ?? null,
            });
          });
        } else {
          // `requiredWhen` gets its chance on every move, not only on creation:
          // an approval that applies once the change reaches `scheduled` can
          // only be started by the transition that puts it there.
          await runHook('approval.startRequiredApprovals', tenantId, ticketId, async () => {
            await approvalEngine()?.startRequiredApprovals(tenantId, ticketId, {
              trx: tx,
              actorId: actor.userId ?? null,
            });
          });
        }

        // A problem reaching a resolved category is what runs the cascade over
        // its linked incidents and retires its known error. Inside THIS
        // transaction, so the cascade and the transition that caused it commit
        // or roll back together, and `runHook` keeps a cascade failure from
        // taking the transition down with it.
        // The change's own terminal work: freezing the implementation window
        // it actually ran in, and arming the post-implementation review an
        // emergency change owes. Same transaction as the transition that
        // caused it, same `runHook` isolation.
        await runHook('change.onResolved', tenantId, ticketId, () =>
          changeEngine()?.onChangeResolved({
            tenantId,
            ticket: {
              id: ticketId,
              recordType: ticket.recordType,
              statusCategory: ticket.statusCategory,
            },
            previous: { statusCategory: beforeTicket.statusCategory },
            actor,
            trx: tx,
          }),
        );

        await runHook('problem.onResolved', tenantId, ticketId, () =>
          problemEngine()?.onProblemResolved({
            tenantId,
            ticket: {
              id: ticketId,
              recordType: ticket.recordType,
              statusCategory: ticket.statusCategory,
            },
            previous: { statusCategory: beforeTicket.statusCategory },
            actor,
            trx: tx,
          }),
        );

        await runHook('rules.onTicketTransitioned', tenantId, ticketId, () =>
          rulesEngine.onTicketTransitioned?.({
            tenantId,
            ticket,
            previous: beforeTicket,
            actor,
            trx: tx,
            transition: {
              slug: decision.transitionSlug,
              fromStatusSlug: beforeTicket.statusSlug,
              toStatusSlug: ticket.statusSlug,
            },
            journalEntryId: stateEntry.id,
          }),
        );

        recorder?.outcome?.({
          allowed: true,
          fromStatusSlug: beforeTicket.statusSlug,
          toStatusSlug: ticket.statusSlug,
          toCategory: ticket.statusCategory,
          rowVersion: ticket.rowVersion,
        });

        return { ticket, decision, previous: beforeTicket };
      },
    );
  };

  const outcome = trx ? await run(trx) : await db.transaction(run);
  const hydrated = (await getById(tenantId, ticketId, { executor: trx ?? db })) ?? outcome.ticket;
  if (trx) return { ticket: hydrated, decision: outcome.decision };

  emitDeskEvent(
    [ROOMS.ticket(ticketId), ROOMS.tenant(tenantId), ROOMS.queue(tenantId, hydrated.queueSlug)],
    SOCKET_EVENTS.ticketStatusChanged,
    {
      tenantId,
      at: new Date().toISOString(),
      ticketId,
      fromStatusSlug: outcome.previous.statusSlug,
      toStatusSlug: hydrated.statusSlug,
      fromCategory: outcome.previous.statusCategory,
      toCategory: hydrated.statusCategory,
      rowVersion: hydrated.rowVersion,
      actorId: actor.userId ?? null,
    },
  );

  return { ticket: hydrated, decision: outcome.decision };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — Journal entries that move the ticket
// ═════════════════════════════════════════════════════════════════════════════

export interface AddJournalInput {
  kind: 'public_reply' | 'work_note';
  visibility: JournalVisibility;
  bodyMd: string;
  attachmentIds?: number[];
  macroSlug?: string | null;
  ccEmails?: string[];
}

/**
 * Append a reply or a work note, and do the two things a bare journal insert
 * cannot: stamp `first_response_at` on the first PUBLIC reply, and tell the
 * engines. `first_response_at` is what the response SLA is measured against, so
 * it has to be written by whatever actually responds — not by a nightly job
 * that guesses from the timeline.
 */
export async function addJournalEntry(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: AddJournalInput,
  trx?: Knex.Transaction,
) {
  const run = async (tx: Knex.Transaction) => {
    const before = await lockTicket(tenantId, ticketId, tx);
    const beforeTicket = mapTicketRow(before);

    const entry = await journalService.append(
      {
        tenantId,
        ticketId,
        kind: input.kind,
        // The visibility COLUMN, never a boolean derived from the kind at read
        // time — see journal.service's header.
        visibility: input.visibility,
        // A requester writing from the portal is `actorType: 'portal'`, and
        // their identity is a `portal_contacts` row, not a `users` row.
        authorId: actor.actorType === 'portal' ? null : actor.userId,
        authorContactId: actor.actorType === 'portal' ? actor.userId : null,
        authorType: actor.actorType,
        bodyMd: input.bodyMd,
        meta: {
          ...(input.macroSlug ? { macroSlug: input.macroSlug } : {}),
          ...(input.ccEmails?.length ? { ccEmails: input.ccEmails } : {}),
        },
      },
      tx,
    );

    if (input.attachmentIds?.length) {
      await attachmentService.linkMany(
        tenantId,
        input.attachmentIds,
        { entityType: 'journal', entityId: entry.id },
        tx,
      );
    }

    // The response SLA measures how long WE took to answer, so the requester's
    // own reply is not a first response. Getting this wrong makes every
    // response target look met the instant a customer chases the ticket.
    const isFirstPublicResponse =
      input.visibility === 'public' &&
      actor.actorType !== 'portal' &&
      beforeTicket.firstResponseAt === null;

    if (isFirstPublicResponse) {
      await scoped('tickets', tenantId, tx)
        .where('tickets.id', ticketId)
        .update({ first_response_at: tx.fn.now(), updated_at: tx.fn.now() });

      // The response clock stops HERE, on the same code path as the column it is
      // measured against, and off the flag computed just above rather than off a
      // second opinion inside the engine — two implementations of "what counts
      // as a first response" is two different response-time medians.
      await runHook('sla.onFirstResponse', tenantId, ticketId, () =>
        newerSlaHooks().onFirstResponse?.({
          tenantId,
          // `beforeTicket` is the row as it was a statement ago; the engine reads
          // its id, source and createdAt, none of which this append touched.
          ticket: beforeTicket,
          at: new Date(entry.createdAt),
          actorId: actor.userId ?? null,
          journalEntryId: entry.id,
          trx: tx,
        }),
      );
    } else {
      await scoped('tickets', tenantId, tx)
        .where('tickets.id', ticketId)
        .update({ updated_at: tx.fn.now() });
    }

    await runHook('rules.onJournalAppended', tenantId, ticketId, () =>
      rulesEngine.onJournalAppended?.({
        tenantId,
        ticket: beforeTicket,
        previous: beforeTicket,
        actor,
        trx: tx,
        journalEntryId: entry.id,
      }),
    );

    return entry;
  };

  return trx ? run(trx) : db.transaction(run);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — merge / revert / split
// ═════════════════════════════════════════════════════════════════════════════

export interface MergeManifestEntry {
  ticketId: number;
  number: string;
  previousStatusSlug: string;
  previousStatusCategory: StatusCategory;
  previousMergedIntoId: number | null;
  movedWatcherIds: number[];
  cancelledSlaInstanceIds: number[];
}

export interface MergeManifest {
  mergeId: string;
  targetTicketId: number;
  at: string;
  /** After this instant a revert is refused (LIMITS.mergeRevertWindowDays). */
  revertBefore: string;
  sources: MergeManifestEntry[];
}

/**
 * Fold source tickets into a target.
 *
 * A MERGE NEVER MOVES JOURNAL ROWS. `ticket_journal.seq` is per-ticket and
 * unique; renumbering it to interleave two timelines would break every
 * permalink, every `meta.decisionLogId` cross-reference and every "entry 4 of
 * ticket 812" an agent has ever quoted in an email. Instead:
 *
 *   • `ticket_link(from = source, to = target, kind = 'merged_from')`
 *   • `tickets.merged_into_id` on the source
 *   • exactly ONE synthesised `merge` journal row on EACH side
 *   • watchers move across (nobody loses their subscription)
 *   • the source's live SLA clocks stop with reason 'merged' — a clock still
 *     ticking on a ticket nobody will work is a breach statistic that means
 *     nothing
 *   • the source is parked in the machine's `cancelled` status, and its previous
 *     status is written into the MANIFEST so a revert restores it exactly.
 *
 * The manifest lives in the target's merge entry's `meta`, which is append-only
 * and tenant-scoped — the right place for a record whose whole job is to still
 * be there in three weeks.
 */
export async function merge(
  tenantId: number,
  actor: ActorContext,
  input: { sourceTicketIds: number[]; targetTicketId: number; comment?: string | null },
  trx?: Knex.Transaction,
): Promise<{ target: TicketWithRelations; manifest: MergeManifest }> {
  const run = async (tx: Knex.Transaction) => {
    const sourceIds = [...new Set(input.sourceTicketIds)].filter((id) => id !== input.targetTicketId);
    if (sourceIds.length === 0) throw new AppError(400, 'Nothing to merge');
    if (sourceIds.length > 50) throw new AppError(400, 'Merge at most 50 tickets at once');

    const target = mapTicketRow(await lockTicket(tenantId, input.targetTicketId, tx));
    if (isTerminal(target.statusCategory)) {
      throw new AppError(409, 'Cannot merge into a closed ticket');
    }

    const machine = await loadStateMachineForTicket(tenantId, target, tx);
    const cancelledStatus = statusForCategory(machine, 'cancelled');

    const manifest: MergeManifest = {
      mergeId: randomUUID(),
      targetTicketId: target.id,
      at: new Date().toISOString(),
      revertBefore: new Date(
        Date.now() + LIMITS.mergeRevertWindowDays * 86_400_000,
      ).toISOString(),
      sources: [],
    };

    for (const sourceId of sourceIds) {
      const source = mapTicketRow(await lockTicket(tenantId, sourceId, tx));
      if (source.mergedIntoId === target.id) continue; // already folded in

      await insertScoped(
        'ticket_link',
        tenantId,
        {
          from_ticket_id: sourceId,
          to_ticket_id: target.id,
          kind: 'merged_from',
          created_by: actor.userId ?? null,
        },
        tx,
      )
        .onConflict(['from_ticket_id', 'to_ticket_id', 'kind'])
        .ignore();

      // ── watchers move, they do not get copied-and-forgotten ────────────
      const watchers = (await scoped('ticket_watcher', tenantId, tx)
        .where('ticket_watcher.ticket_id', sourceId)
        .select('*')) as unknown as Array<{
        id: number;
        user_id: number | null;
        contact_id: number | null;
        reason: string | null;
      }>;

      for (const watcher of watchers) {
        await addWatcher(
          tenantId,
          target.id,
          {
            userId: watcher.user_id,
            contactId: watcher.contact_id,
            reason: watcher.reason ?? 'manual',
          },
          tx,
        );
      }
      await scoped('ticket_watcher', tenantId, tx).where('ticket_watcher.ticket_id', sourceId).del();

      const cancelledSla = await cancelLiveSlaInstances(
        tenantId,
        sourceId,
        'merged',
        actor.userId ?? null,
        tx,
      );

      const columns: Record<string, unknown> = {
        merged_into_id: target.id,
        updated_at: tx.fn.now(),
      };
      if (cancelledStatus) {
        // A merge is a SYSTEM action, not an agent transition: it deliberately
        // bypasses guards and required-ness, because refusing to park a
        // duplicate because its resolution notes are empty is nonsense.
        columns.status_slug = cancelledStatus.slug;
        columns.status_category = cancelledStatus.category;
        columns.closed_at = tx.fn.now();
      }

      await scoped('tickets', tenantId, tx)
        .where('tickets.id', sourceId)
        .update({ ...columns, row_version: tx.raw('row_version + 1') });

      manifest.sources.push({
        ticketId: sourceId,
        number: source.number,
        previousStatusSlug: source.statusSlug,
        previousStatusCategory: source.statusCategory,
        previousMergedIntoId: source.mergedIntoId,
        movedWatcherIds: watchers.map((w) => w.id),
        cancelledSlaInstanceIds: cancelledSla,
      });

      // One synthesised entry on the SOURCE side.
      await journalService.append(
        {
          tenantId,
          ticketId: sourceId,
          kind: 'merge',
          visibility: 'internal',
          authorId: actor.userId,
          authorType: actor.actorType,
          bodyMd: input.comment ?? null,
          meta: {
            mergeId: manifest.mergeId,
            direction: 'merged_into',
            targetTicketId: target.id,
            targetNumber: target.number,
          },
          emit: false,
        },
        tx,
      );
    }

    // …and exactly one on the TARGET side, carrying the manifest.
    const targetEntry = await journalService.append(
      {
        tenantId,
        ticketId: target.id,
        kind: 'merge',
        visibility: 'internal',
        authorId: actor.userId,
        authorType: actor.actorType,
        bodyMd: input.comment ?? null,
        meta: {
          mergeId: manifest.mergeId,
          direction: 'merged_from',
          mergedTicketIds: manifest.sources.map((s) => s.ticketId),
          manifest: manifest as unknown as Record<string, unknown>,
        },
        emit: false,
      },
      tx,
    );

    await withDecision(
      {
        tenantId,
        ticketId: target.id,
        subsystem: 'workflow',
        decision: 'tickets_merged',
        actorId: actor.userId ?? null,
        trx: tx,
        inputs: { fields: { sourceTicketIds: manifest.sources.map((s) => s.ticketId) } },
      },
      async (recorder) => {
        recorder?.outcome?.({
          mergeId: manifest.mergeId,
          manifestJournalId: targetEntry.id,
          revertBefore: manifest.revertBefore,
        });
      },
    );

    return { manifest, manifestJournalId: targetEntry.id };
  };

  const { manifest } = trx ? await run(trx) : await db.transaction(run);
  const target = (await getById(tenantId, input.targetTicketId))!;

  emitDeskEvent([ROOMS.tenant(tenantId)], SOCKET_EVENTS.ticketUpdated, {
    tenantId,
    at: new Date().toISOString(),
    ticketId: target.id,
    ticket: target,
    changedFields: ['mergedFrom'],
    rowVersion: target.rowVersion,
    actorId: actor.userId ?? null,
    actorType: actor.actorType,
  });

  return { target, manifest };
}

/**
 * Undo a merge from its manifest.
 *
 * Refused once the target is closed: by then the merged ticket has been
 * reported on, possibly invoiced, and pulling a ticket back out from under a
 * closed parent produces two records that disagree about what happened. It is
 * also refused past `LIMITS.mergeRevertWindowDays` — an undo that still works
 * after a month is not an undo, it is a time machine.
 */
export async function revertMerge(
  tenantId: number,
  actor: ActorContext,
  manifestJournalId: number,
  trx?: Knex.Transaction,
): Promise<{ target: TicketWithRelations; restored: number[] }> {
  const run = async (tx: Knex.Transaction) => {
    const entry = await journalService.getById(tenantId, manifestJournalId, tx);
    if (!entry || entry.kind !== 'merge') throw new AppError(404, 'Merge record not found');

    const manifest = entry.meta?.manifest as MergeManifest | undefined;
    if (!manifest?.sources) throw new AppError(400, 'This merge has no reversible manifest');

    if (Date.parse(manifest.revertBefore) < Date.now()) {
      throw new AppError(
        409,
        `A merge can only be reverted within ${LIMITS.mergeRevertWindowDays} days`,
      );
    }

    const target = mapTicketRow(await lockTicket(tenantId, manifest.targetTicketId, tx));
    if (isTerminal(target.statusCategory)) {
      throw new AppError(409, 'Cannot revert a merge whose target ticket is closed');
    }

    const restored: number[] = [];
    for (const source of manifest.sources) {
      await scoped('tickets', tenantId, tx)
        .where('tickets.id', source.ticketId)
        .update({
          merged_into_id: source.previousMergedIntoId,
          status_slug: source.previousStatusSlug,
          status_category: source.previousStatusCategory,
          closed_at: isTerminal(source.previousStatusCategory) ? tx.fn.now() : null,
          updated_at: tx.fn.now(),
          row_version: tx.raw('row_version + 1'),
        });

      await scoped('ticket_link', tenantId, tx)
        .where({
          'ticket_link.from_ticket_id': source.ticketId,
          'ticket_link.to_ticket_id': manifest.targetTicketId,
          'ticket_link.kind': 'merged_from',
        })
        .del();

      await journalService.append(
        {
          tenantId,
          ticketId: source.ticketId,
          kind: 'merge',
          visibility: 'internal',
          authorId: actor.userId,
          authorType: actor.actorType,
          meta: { mergeId: manifest.mergeId, direction: 'merge_reverted', targetTicketId: manifest.targetTicketId },
          emit: false,
        },
        tx,
      );
      restored.push(source.ticketId);
    }

    await journalService.append(
      {
        tenantId,
        ticketId: manifest.targetTicketId,
        kind: 'merge',
        visibility: 'internal',
        authorId: actor.userId,
        authorType: actor.actorType,
        meta: { mergeId: manifest.mergeId, direction: 'merge_reverted', mergedTicketIds: restored },
        emit: false,
      },
      tx,
    );

    await withDecision(
      {
        tenantId,
        ticketId: manifest.targetTicketId,
        subsystem: 'workflow',
        decision: 'merge_reverted',
        actorId: actor.userId ?? null,
        trx: tx,
        inputs: { fields: { mergeId: manifest.mergeId, restored } },
      },
      async (recorder) => {
        recorder?.outcome?.({ restored });
      },
    );

    return { targetId: manifest.targetTicketId, restored };
  };

  const { targetId, restored } = trx ? await run(trx) : await db.transaction(run);
  return { target: (await getById(tenantId, targetId))!, restored };
}

export interface SplitTicketInput {
  subject: string;
  descriptionMd?: string | null;
  /** Journal entries to QUOTE into the new ticket. They are never moved. */
  quoteJournalIds?: number[];
  queueSlug?: string | null;
  assigneeId?: number | null;
  assignmentGroupId?: number | null;
  recordType?: TicketRecordType;
}

/**
 * Split a second problem out of a ticket into its own child.
 *
 * Like a merge, this does not move journal rows — the selected entries are
 * QUOTED into the new ticket's opening entry and stay where they were written.
 * The new ticket carries `parent_ticket_id` and a `child` link, so both
 * directions are navigable and neither timeline is falsified.
 */
export async function split(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: SplitTicketInput,
  trx?: Knex.Transaction,
): Promise<{ parent: TicketWithRelations; child: TicketWithRelations }> {
  const run = async (tx: Knex.Transaction) => {
    const parent = mapTicketRow(await lockTicket(tenantId, ticketId, tx));

    let quoted = '';
    if (input.quoteJournalIds?.length) {
      const entries = await Promise.all(
        input.quoteJournalIds.map((id) => journalService.getById(tenantId, id, tx)),
      );
      quoted = entries
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null && entry.ticketId === ticketId)
        .map((entry) => `> **#${entry.seq}** — ${entry.bodyMd ?? ''}`)
        .join('\n>\n');
    }

    const child = await create(
      tenantId,
      actor,
      {
        subject: input.subject,
        recordType: input.recordType ?? parent.recordType,
        descriptionMd: input.descriptionMd ?? parent.descriptionMd,
        // HARD RULE 6 — the split inherits WHEN IT HAPPENED. A new created_at
        // is correct; a new occurred_at would erase the incident's real clock.
        occurredAt: parent.occurredAt,
        queueSlug: input.queueSlug ?? parent.queueSlug,
        assigneeId: input.assigneeId ?? null,
        assignmentGroupId: input.assignmentGroupId ?? parent.assignmentGroupId,
        requesterContactId: parent.requesterContactId,
        requesterUserId: parent.requesterUserId,
        organizationId: parent.organizationId,
        primaryCiId: parent.primaryCiId,
        impact: parent.impact,
        urgency: parent.urgency,
        source: parent.source,
        parentTicketId: parent.id,
        openingEntry: {
          kind: 'work_note',
          visibility: 'internal',
          bodyMd: quoted
            ? `Séparé de ${parent.number}.\n\n${quoted}`
            : `Séparé de ${parent.number}.`,
          meta: { splitFromTicketId: parent.id, quotedJournalIds: input.quoteJournalIds ?? [] },
        },
      },
      tx,
    );

    await insertScoped(
      'ticket_link',
      tenantId,
      {
        from_ticket_id: parent.id,
        to_ticket_id: child.id,
        kind: 'child',
        created_by: actor.userId ?? null,
      },
      tx,
    )
      .onConflict(['from_ticket_id', 'to_ticket_id', 'kind'])
      .ignore();

    await journalService.append(
      {
        tenantId,
        ticketId: parent.id,
        kind: 'system',
        visibility: 'internal',
        authorId: actor.userId,
        authorType: actor.actorType,
        meta: { splitToTicketId: child.id, splitToNumber: child.number },
        emit: false,
      },
      tx,
    );

    await withDecision(
      {
        tenantId,
        ticketId: parent.id,
        subsystem: 'workflow',
        decision: 'ticket_split',
        actorId: actor.userId ?? null,
        trx: tx,
        inputs: { fields: { childTicketId: child.id } },
      },
      async (recorder) => {
        recorder?.outcome?.({ childTicketId: child.id, childNumber: child.number });
      },
    );

    return { parentId: parent.id, childId: child.id };
  };

  const { parentId, childId } = trx ? await run(trx) : await db.transaction(run);
  const executor = trx ?? db;
  const parent = (await getById(tenantId, parentId, { executor }))!;
  const child = (await getById(tenantId, childId, { executor }))!;

  // `create()` deferred the event because it ran inside our transaction.
  if (!trx) emitTicketCreated(tenantId, child);
  return { parent, child };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13 — reopen()
// ═════════════════════════════════════════════════════════════════════════════

export interface ReopenResult {
  reopened: boolean;
  ticket: TicketWithRelations;
  /** Set when the window had closed and a linked follow-up was opened instead. */
  followUp?: TicketWithRelations;
  reason: 'reopened' | 'window_expired' | 'not_reopenable';
}

/**
 * A requester replied to a resolved ticket. Should it come back to life?
 *
 * Inside `LIMITS.reopenWindowDays`: yes. The ticket reopens, `reopen_count`
 * goes up, and a BRAND NEW resolution SLA instance starts.
 *
 * That last part is the whole point. Resuming the old instance would let a
 * team close a ticket at 99% of its resolution target, have it reopened, and
 * finish inside the leftover 1% — so the ledger shows a met SLA for work that
 * actually took three times the target. Close-and-reopen gaming has to be
 * VISIBLE, and it is visible precisely because the second clock is its own row
 * with its own start (and because `reopen_count` is on the ticket).
 *
 * Past the window: the old ticket stays closed and a linked follow-up is
 * created. Reviving a ticket resolved five months ago destroys every metric it
 * was already counted in.
 */
export async function reopen(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  input: { reason?: string | null; comment?: string | null; viaJournalId?: number | null } = {},
  trx?: Knex.Transaction,
): Promise<ReopenResult> {
  const run = async (tx: Knex.Transaction): Promise<{ result: ReopenResult; emitted: boolean }> => {
    const before = mapTicketRow(await lockTicket(tenantId, ticketId, tx));

    if (!canReopen(before.statusCategory)) {
      return {
        result: { reopened: false, ticket: before, reason: 'not_reopenable' },
        emitted: false,
      };
    }

    const machine = await loadStateMachineForTicket(tenantId, before, tx);
    const windowDays = machine.reopenWindowDays ?? LIMITS.reopenWindowDays;
    const anchor = before.closedAt ?? before.resolvedAt ?? before.updatedAt;
    const ageDays = (Date.now() - Date.parse(anchor)) / 86_400_000;

    // ── Past the window: a linked follow-up, not a resurrection ───────────
    if (ageDays > windowDays) {
      const followUp = await create(
        tenantId,
        actor,
        {
          subject: `${before.subject} (suivi)`,
          recordType: before.recordType,
          descriptionMd: input.comment ?? null,
          occurredAt: new Date().toISOString(),
          queueSlug: before.queueSlug,
          assignmentGroupId: before.assignmentGroupId,
          requesterContactId: before.requesterContactId,
          requesterUserId: before.requesterUserId,
          organizationId: before.organizationId,
          primaryCiId: before.primaryCiId,
          impact: before.impact,
          urgency: before.urgency,
          source: before.source,
          parentTicketId: before.id,
          openingEntry: {
            kind: 'work_note',
            visibility: 'internal',
            bodyMd: `Suite de ${before.number} — la fenêtre de réouverture de ${windowDays} jours est dépassée.`,
            meta: { followUpForTicketId: before.id, reopenWindowDays: windowDays },
          },
        },
        tx,
      );

      await insertScoped(
        'ticket_link',
        tenantId,
        {
          from_ticket_id: before.id,
          to_ticket_id: followUp.id,
          kind: 'related',
          created_by: actor.userId ?? null,
        },
        tx,
      )
        .onConflict(['from_ticket_id', 'to_ticket_id', 'kind'])
        .ignore();

      await withDecision(
        {
          tenantId,
          ticketId: before.id,
          subsystem: 'workflow',
          decision: 'reopen_window_expired',
          ruleSlug: machine.slug,
          ruleVersion: machine.version,
          actorId: actor.userId ?? null,
          trx: tx,
          inputs: { fields: { ageDays: Math.round(ageDays), windowDays, anchor } },
        },
        async (recorder) => {
          recorder?.outcome?.({ followUpTicketId: followUp.id, followUpNumber: followUp.number });
        },
      );

      return {
        result: { reopened: false, ticket: before, followUp, reason: 'window_expired' },
        emitted: false,
      };
    }

    // ── Inside the window: reopen ─────────────────────────────────────────
    const targetSlug =
      machine.reopenToStatusSlug ??
      machine.transitions.find((t) => t.slug === 'reopen')?.to ??
      statusForCategory(machine, 'open')?.slug ??
      before.statusSlug;

    const targetCategory = categoryOf(machine, targetSlug) ?? 'open';

    const updated = (await scoped('tickets', tenantId, tx)
      .where('tickets.id', ticketId)
      .update({
        status_slug: targetSlug,
        status_category: targetCategory,
        resolved_at: null,
        closed_at: null,
        reopen_count: tx.raw('reopen_count + 1'),
        updated_at: tx.fn.now(),
        row_version: tx.raw('row_version + 1'),
        set_by: JSON.stringify(
          stampProvenance(before.setBy, ['status_slug', 'status_category', 'reopen_count'], actor),
        ),
      })
      .returning('*')) as unknown as TicketRow[];

    const ticket = mapTicketRow(updated[0]);

    // A NEW instance — never a resume. See the doc comment above.
    const newInstanceId = await startSlaTarget(
      tenantId,
      ticket,
      'resolution',
      'reopened',
      actor.userId ?? null,
      tx,
    );

    await journalService.append(
      {
        tenantId,
        ticketId,
        kind: 'state_change',
        visibility: 'internal',
        authorId: actor.userId,
        authorType: actor.actorType,
        bodyMd: input.comment ?? null,
        meta: {
          reopened: true,
          fromStatusSlug: before.statusSlug,
          toStatusSlug: targetSlug,
          fromCategory: before.statusCategory,
          toCategory: targetCategory,
          reopenCount: ticket.reopenCount,
          reason: input.reason ?? null,
          viaJournalId: input.viaJournalId ?? null,
          newSlaInstanceId: newInstanceId,
        },
        emit: false,
      },
      tx,
    );

    await withDecision(
      {
        tenantId,
        ticketId,
        subsystem: 'sla',
        decision: 'ticket_reopened',
        ruleSlug: machine.slug,
        ruleVersion: machine.version,
        actorId: actor.userId ?? null,
        trx: tx,
        inputs: {
          fields: {
            ageDays: Math.round(ageDays),
            windowDays,
            fromCategory: before.statusCategory,
            reopenCountBefore: before.reopenCount,
          },
        },
      },
      async (recorder) => {
        recorder?.outcome?.({
          toStatusSlug: targetSlug,
          reopenCount: ticket.reopenCount,
          // Explicitly recorded so an auditor can see the old clock was NOT
          // resumed, rather than having to infer it.
          newResolutionSlaInstanceId: newInstanceId,
          resumedPreviousInstance: false,
        });
      },
    );

    // A reopen is one of the three ticket-level escalation triggers. Keyed off
    // the reopen COUNT so the third reopen arms a third time — the ladder that
    // says "tell the service owner when this comes back" is worthless if it only
    // ever fires once.
    await runHook('escalation.onTicketReopened', tenantId, ticketId, async () => {
      await escalationEngine()?.onTicketEvent({
        tenantId,
        ticketId,
        trigger: 'reopened',
        occurrenceRef: ticket.reopenCount,
        context: {
          fromStatusSlug: before.statusSlug,
          toStatusSlug: targetSlug,
          reopenCount: ticket.reopenCount,
          reason: input.reason ?? null,
        },
        actorId: actor.userId ?? null,
        trx: tx,
      });
    });

    await runHook('rules.onTicketTransitioned', tenantId, ticketId, () =>
      rulesEngine.onTicketTransitioned?.({
        tenantId,
        ticket,
        previous: before,
        actor,
        trx: tx,
        transition: {
          slug: 'reopen',
          fromStatusSlug: before.statusSlug,
          toStatusSlug: targetSlug,
        },
      }),
    );

    return { result: { reopened: true, ticket, reason: 'reopened' }, emitted: true };
  };

  const { result, emitted } = trx ? await run(trx) : await db.transaction(run);

  if (!emitted) {
    // `create()` deferred the follow-up's event because it ran inside our
    // transaction; announce it now that the transaction has committed.
    if (result.followUp && !trx) emitTicketCreated(tenantId, result.followUp);
    return result;
  }
  if (trx) return result;

  const hydrated = (await getById(tenantId, ticketId)) ?? result.ticket;
  emitDeskEvent(
    [ROOMS.ticket(ticketId), ROOMS.tenant(tenantId), ROOMS.queue(tenantId, hydrated.queueSlug)],
    SOCKET_EVENTS.ticketStatusChanged,
    {
      tenantId,
      at: new Date().toISOString(),
      ticketId,
      fromStatusSlug: result.ticket.statusSlug,
      toStatusSlug: hydrated.statusSlug,
      fromCategory: result.ticket.statusCategory,
      toCategory: hydrated.statusCategory,
      rowVersion: hydrated.rowVersion,
      actorId: actor.userId ?? null,
    },
  );
  return { ...result, ticket: hydrated };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 14 — bulk: preview → apply → undo
// ═════════════════════════════════════════════════════════════════════════════

export type BulkPatch = Pick<
  UpdateTicketRequest,
  'prioritySlug' | 'queueSlug' | 'assigneeId' | 'assignmentGroupId' | 'impact' | 'urgency'
>;

export interface BulkPreviewRow {
  ticketId: number;
  number: string;
  subject: string;
  currentRowVersion: number;
  /** What would actually change on THIS ticket. */
  changes: Array<{ field: string; from: unknown; to: unknown }>;
  eligible: boolean;
  reason?: string;
}

export interface BulkPreview {
  rows: BulkPreviewRow[];
  eligible: number;
  skipped: number;
}

/**
 * Show the agent exactly what 400 tickets are about to become, per ticket,
 * before anything is written. A bulk action nobody can preview is a bulk action
 * nobody can safely refuse.
 */
export async function bulkPreview(
  tenantId: number,
  ticketIds: readonly number[],
  patch: BulkPatch,
  executor: Executor = db,
): Promise<BulkPreview> {
  if (ticketIds.length === 0) return { rows: [], eligible: 0, skipped: 0 };
  if (ticketIds.length > LIMITS.bulkMaxTickets) {
    throw new AppError(400, `Bulk actions are limited to ${LIMITS.bulkMaxTickets} tickets`);
  }

  const rows = (await scoped('tickets', tenantId, executor)
    .whereIn('tickets.id', ticketIds as number[])
    .select('tickets.*')) as unknown as TicketRow[];

  const preview: BulkPreviewRow[] = rows.map((row) => {
    const ticket = mapTicketRow(row);
    const changes: BulkPreviewRow['changes'] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const current = (ticket as unknown as Record<string, unknown>)[key];
      if (current !== value) changes.push({ field: key, from: current, to: value });
    }
    const terminal = isTerminal(ticket.statusCategory);
    return {
      ticketId: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      currentRowVersion: ticket.rowVersion,
      changes,
      eligible: !terminal && ticket.deletedAt === null && changes.length > 0,
      reason: terminal
        ? 'terminal'
        : ticket.deletedAt !== null
          ? 'deleted'
          : changes.length === 0
            ? 'no_change'
            : undefined,
    };
  });

  return {
    rows: preview,
    eligible: preview.filter((row) => row.eligible).length,
    skipped: preview.filter((row) => !row.eligible).length,
  };
}

export interface BulkApplyResult {
  updated: number[];
  conflicted: Array<{ ticketId: number; currentRowVersion: number }>;
  failed: Array<{ ticketId: number; error: string }>;
  /** Present when at least one ticket changed. Valid for LIMITS.bulkUndoWindowMs. */
  undoToken?: string;
  undoExpiresAt?: string;
}

interface UndoEntry {
  tenantId: number;
  actorId: number | null;
  expiresAt: number;
  tickets: Array<{ ticketId: number; before: BulkPatch }>;
}

/**
 * Undo journal for bulk actions, in memory.
 *
 * Deliberately NOT a table: an undo token is valid for ten minutes, is only
 * ever redeemed by the browser tab that just did the thing, and a restart
 * losing it is the correct behaviour — "undo" that survives a deploy is really
 * "revert", and revert is what the timeline and `decision_log` are for.
 */
const undoJournal = new Map<string, UndoEntry>();

function pruneUndoJournal(): void {
  const now = Date.now();
  for (const [token, entry] of undoJournal) {
    if (entry.expiresAt <= now) undoJournal.delete(token);
  }
}

/**
 * Apply a bulk patch ticket by ticket, in its own transaction.
 *
 * One transaction for all of them would mean a single stale row_version rolls
 * back 399 legitimate edits; per-ticket transactions turn that into a partial-
 * failure REPORT the agent can act on. Every ticket still goes through
 * `update()`, so provenance, journal entries, decision_log rows and rule hooks
 * all happen exactly as they would for a single edit.
 */
export async function bulkApply(
  tenantId: number,
  actor: ActorContext,
  ticketIds: readonly number[],
  baseRowVersions: Record<number, number>,
  patch: BulkPatch,
): Promise<BulkApplyResult> {
  if (ticketIds.length > LIMITS.bulkMaxTickets) {
    throw new AppError(400, `Bulk actions are limited to ${LIMITS.bulkMaxTickets} tickets`);
  }

  const result: BulkApplyResult = { updated: [], conflicted: [], failed: [] };
  const undo: UndoEntry = {
    tenantId,
    actorId: actor.userId ?? null,
    expiresAt: Date.now() + LIMITS.bulkUndoWindowMs,
    tickets: [],
  };

  for (const ticketId of ticketIds) {
    try {
      const before = await getById(tenantId, ticketId);
      if (!before) {
        result.failed.push({ ticketId, error: 'not_found' });
        continue;
      }

      const baseVersion = baseRowVersions[ticketId] ?? before.rowVersion;
      await update(tenantId, actor, ticketId, { ...patch, baseRowVersion: baseVersion });

      undo.tickets.push({
        ticketId,
        before: {
          prioritySlug: before.prioritySlug,
          queueSlug: before.queueSlug,
          assigneeId: before.assigneeId,
          assignmentGroupId: before.assignmentGroupId,
          impact: before.impact,
          urgency: before.urgency,
        },
      });
      result.updated.push(ticketId);
    } catch (error) {
      if (error instanceof TicketVersionConflictError) {
        result.conflicted.push({
          ticketId,
          currentRowVersion: error.conflict.current.rowVersion,
        });
        continue;
      }
      result.failed.push({
        ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (undo.tickets.length > 0) {
    pruneUndoJournal();
    const token = randomUUID();
    undoJournal.set(token, undo);
    result.undoToken = token;
    result.undoExpiresAt = new Date(undo.expiresAt).toISOString();
  }
  return result;
}

/**
 * Redeem an undo token.
 *
 * Restores each ticket against ITS CURRENT row_version, not the one it had
 * before the bulk: somebody else may have legitimately edited a ticket in the
 * intervening minutes, and refusing the whole undo because of that would be
 * useless. What it will not do is resurrect values on a ticket that has since
 * been transitioned — those come back as `failed` entries.
 */
export async function bulkUndo(
  tenantId: number,
  actor: ActorContext,
  token: string,
): Promise<BulkApplyResult> {
  pruneUndoJournal();
  const entry = undoJournal.get(token);
  if (!entry || entry.tenantId !== tenantId) {
    throw new AppError(404, 'This undo token has expired');
  }
  undoJournal.delete(token);

  const result: BulkApplyResult = { updated: [], conflicted: [], failed: [] };
  for (const item of entry.tickets) {
    try {
      const current = await getById(tenantId, item.ticketId);
      if (!current) {
        result.failed.push({ ticketId: item.ticketId, error: 'not_found' });
        continue;
      }
      await update(tenantId, actor, item.ticketId, {
        ...item.before,
        baseRowVersion: current.rowVersion,
      });
      result.updated.push(item.ticketId);
    } catch (error) {
      result.failed.push({
        ticketId: item.ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 15 — watchers, links, soft delete
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Subscribe a user or a contact to a ticket.
 *
 * `ticket_watcher`'s uniqueness comes from two PARTIAL unique indexes
 * (`… WHERE user_id IS NOT NULL`, `… WHERE contact_id IS NOT NULL`). Plain
 * `ON CONFLICT (ticket_id, user_id)` cannot infer a partial index — Postgres
 * answers "no unique or exclusion constraint matching the ON CONFLICT
 * specification" — and a read-then-insert is not a fix either: the losing
 * insert would raise inside the caller's transaction and Postgres aborts the
 * WHOLE transaction on a constraint error, so catching it in JavaScript would
 * still take the ticket down with it.
 *
 * The index PREDICATE therefore has to be part of the statement, which knex's
 * builder cannot express — hence the one raw INSERT in this file. `tenant_id`
 * is bound explicitly and validated, so the isolation guarantee `insertScoped`
 * exists to provide is preserved and visible in the SQL.
 */
export async function addWatcher(
  tenantId: number,
  ticketId: number,
  who: { userId?: number | null; contactId?: number | null; reason?: string },
  executor: Executor = db,
): Promise<void> {
  if (!who.userId && !who.contactId) return;
  assertTenantId(tenantId);

  const byUser = Boolean(who.userId);
  const conflictTarget = byUser
    ? '(ticket_id, user_id) WHERE user_id IS NOT NULL'
    : '(ticket_id, contact_id) WHERE contact_id IS NOT NULL';

  await executor.raw(
    `INSERT INTO ticket_watcher (tenant_id, ticket_id, user_id, contact_id, reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT ${conflictTarget} DO NOTHING`,
    [tenantId, ticketId, who.userId ?? null, who.contactId ?? null, who.reason ?? 'manual'],
  );
}

export async function removeWatcher(
  tenantId: number,
  ticketId: number,
  who: { userId?: number | null; contactId?: number | null },
  executor: Executor = db,
): Promise<number> {
  const qb = scoped('ticket_watcher', tenantId, executor).where(
    'ticket_watcher.ticket_id',
    ticketId,
  );
  if (who.userId) qb.where('ticket_watcher.user_id', who.userId);
  else if (who.contactId) qb.where('ticket_watcher.contact_id', who.contactId);
  else return 0;
  return qb.del();
}

export async function listWatchers(tenantId: number, ticketId: number, executor: Executor = db) {
  return (await scoped('ticket_watcher', tenantId, executor)
    .where('ticket_watcher.ticket_id', ticketId)
    .leftJoin('users as wu', 'wu.id', 'ticket_watcher.user_id')
    .leftJoin('portal_contacts as wc', function joinContact() {
      this.on('wc.id', 'ticket_watcher.contact_id').andOn(
        'wc.tenant_id',
        '=',
        executor.raw('?', [tenantId]),
      );
    })
    .select(
      'ticket_watcher.*',
      'wu.username',
      'wu.display_name',
      'wu.avatar',
      'wc.email as contact_email',
      'wc.display_name as contact_display_name',
    )) as unknown as Array<Record<string, unknown>>;
}

/**
 * The one INSERT every `ticket_link` row that is not a merge goes through.
 *
 * Split out of `addLink` so the RESERVED kinds (below) have somewhere to write
 * from without the self-link test, the existence test and the idempotent upsert
 * being spelled out a second time and drifting.
 */
async function writeLink(
  tenantId: number,
  actor: ActorContext,
  fromTicketId: number,
  input: { toTicketId: number; kind: string },
  executor: Executor,
): Promise<void> {
  if (fromTicketId === input.toTicketId) throw new AppError(400, 'A ticket cannot link to itself');
  const other = await scoped('tickets', tenantId, executor)
    .where('tickets.id', input.toTicketId)
    .first<{ id: number }>('tickets.id');
  if (!other) throw new AppError(404, 'The linked ticket does not exist');

  await insertScoped(
    'ticket_link',
    tenantId,
    {
      from_ticket_id: fromTicketId,
      to_ticket_id: input.toTicketId,
      kind: input.kind,
      created_by: actor.userId ?? null,
    },
    executor,
  )
    .onConflict(['from_ticket_id', 'to_ticket_id', 'kind'])
    .ignore();
}

/**
 * The free-form link kinds: 'related', 'duplicate', 'blocks', 'child'.
 *
 * Two kinds are RESERVED, and for the same reason: for them the row is not the
 * whole act, so a row written behind the act's back leaves the desk holding a
 * link that nothing explains and no counter reflects.
 *
 *   'merged_from'  is written by merge() alone: hand-crafting one would produce
 *                  a merge with no manifest, which is a merge nobody can undo.
 *
 *   'caused_by'    is the problem module's spine. It carries an invariant no
 *                  unique index can express — an incident hangs under AT MOST
 *                  ONE problem, because with two, the first one's closure
 *                  cascade resolves an incident the second is still causing —
 *                  it feeds the three rollups on `problems` that the problem
 *                  list and the dashboard read, and it owes the incident the
 *                  decision_log row that answers "why does my ticket point at
 *                  PRB-12?" (HARD RULE 2). This function supplies none of the
 *                  three, and it is reached from a route gated on `ticket_rw`,
 *                  which every agent holds and which deliberately does NOT
 *                  imply `problem_rw`. `POST /api/problems/:ticketId/incidents`
 *                  does all of it in one transaction; the problem module's own
 *                  writes come back through `addProblemLink` below.
 */
export async function addLink(
  tenantId: number,
  actor: ActorContext,
  fromTicketId: number,
  input: { toTicketId: number; kind: string },
  executor: Executor = db,
): Promise<void> {
  if (input.kind === 'merged_from') {
    throw new AppError(400, 'Merge links are created by the merge action');
  }
  if (input.kind === PROBLEM_LINK_KIND) {
    throw new AppError(
      400,
      'Incident to problem links are created from the problem, not from the ticket link list',
      { code: 'validation_failed' },
    );
  }
  return writeLink(tenantId, actor, fromTicketId, input, executor);
}

/**
 * The problem module's door to `ticket_link`.
 *
 * The same row and the same idempotency as `addLink`, reachable only from a
 * caller that has ALREADY applied the one-problem-per-incident guard, will
 * recompute the rollups and will write the incident its decision row — which is
 * exactly what `addLink` cannot promise, and why it refuses the kind. The
 * signature mirrors `addLink` so the module's call sites swap name for name.
 */
export async function addProblemLink(
  tenantId: number,
  actor: ActorContext,
  fromTicketId: number,
  input: { toTicketId: number; kind: string },
  executor: Executor = db,
): Promise<void> {
  if (input.kind !== PROBLEM_LINK_KIND) {
    throw new AppError(400, 'This entry point writes incident to problem links only');
  }
  return writeLink(tenantId, actor, fromTicketId, input, executor);
}

/**
 * Drop a link by id.
 *
 * 'caused_by' is refused for the mirror image of the reason `addLink` refuses
 * it: detaching an incident moves `problems.incident_count`, `first_incident_at`
 * and `last_incident_at`, and owes the incident a decision row saying it was
 * detached. This function is handed a link id and no actor, so it can write
 * neither; `DELETE /api/problems/:ticketId/incidents` writes both in one
 * transaction. The kind is read before the delete rather than filtered in the
 * WHERE clause on purpose: a silent 0 would reach the controller as "link not
 * found" and tell the caller the opposite of what happened.
 */
export async function removeLink(
  tenantId: number,
  linkId: number,
  executor: Executor = db,
): Promise<number> {
  const link = (await scoped('ticket_link', tenantId, executor)
    .where('ticket_link.id', linkId)
    .first('ticket_link.kind')) as { kind: string } | undefined;
  if (!link) return 0;
  if (link.kind === PROBLEM_LINK_KIND) {
    throw new AppError(
      409,
      'Detaching an incident from its problem is done from the problem, not from the ticket link list',
      { code: 'conflict' },
    );
  }
  return scoped('ticket_link', tenantId, executor).where('ticket_link.id', linkId).del();
}

/**
 * Every link touching a ticket, in both directions, with the OTHER ticket
 * joined for rendering. Two queries rather than one CASE-expression join: the
 * direction has to reach the UI anyway ("blocks" and "blocked by" are different
 * sentences), so computing it in SQL and then re-deriving it in JavaScript
 * would be work done twice.
 */
export async function listLinks(tenantId: number, ticketId: number, executor: Executor = db) {
  const columns = [
    'ticket_link.*',
    'lt.id as other_id',
    'lt.number as other_number',
    'lt.subject as other_subject',
    'lt.status_slug as other_status_slug',
    'lt.status_category as other_status_category',
  ];

  const joinOther = (foreignKey: string) =>
    function joinTicket(this: Knex.JoinClause) {
      this.on('lt.id', foreignKey).andOn('lt.tenant_id', '=', executor.raw('?', [tenantId]));
    };

  const [outgoing, incoming] = await Promise.all([
    scoped('ticket_link', tenantId, executor)
      .where('ticket_link.from_ticket_id', ticketId)
      .join('tickets as lt', joinOther('ticket_link.to_ticket_id'))
      .select(...columns) as unknown as Promise<Array<Record<string, unknown>>>,
    scoped('ticket_link', tenantId, executor)
      .where('ticket_link.to_ticket_id', ticketId)
      .join('tickets as lt', joinOther('ticket_link.from_ticket_id'))
      .select(...columns) as unknown as Promise<Array<Record<string, unknown>>>,
  ]);

  return [
    ...outgoing.map((row) => ({ ...row, direction: 'outgoing' })),
    ...incoming.map((row) => ({ ...row, direction: 'incoming' })),
  ];
}

/**
 * Soft delete. Never a DELETE: a ticket is referenced by time entries, invoices,
 * decision_log rows and other tickets' links, and the row surviving is what
 * keeps all of those honest.
 */
export async function softDelete(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
  baseRowVersion: number,
): Promise<TicketWithRelations> {
  return db.transaction(async (tx) => {
    const before = mapTicketRow(await lockTicket(tenantId, ticketId, tx));
    if (before.rowVersion !== baseRowVersion) {
      const current = (await getById(tenantId, ticketId, { executor: tx })) ?? before;
      throw new TicketVersionConflictError({
        code: 'version_conflict',
        current,
        conflictingFields: ['deletedAt'],
      });
    }

    await cancelLiveSlaInstances(tenantId, ticketId, 'ticket_deleted', actor.userId ?? null, tx);

    const updated = (await scoped('tickets', tenantId, tx)
      .where('tickets.id', ticketId)
      .update({
        deleted_at: tx.fn.now(),
        updated_at: tx.fn.now(),
        row_version: tx.raw('row_version + 1'),
      })
      .returning('*')) as unknown as TicketRow[];

    await journalService.append(
      {
        tenantId,
        ticketId,
        kind: 'system',
        visibility: 'internal',
        authorId: actor.userId,
        authorType: actor.actorType,
        meta: { deleted: true },
        emit: false,
      },
      tx,
    );

    await withDecision(
      {
        tenantId,
        ticketId,
        subsystem: 'workflow',
        decision: 'ticket_deleted',
        actorId: actor.userId ?? null,
        trx: tx,
        inputs: { fields: { number: before.number, statusCategory: before.statusCategory } },
      },
      async (recorder) => {
        recorder?.outcome?.({ softDeleted: true });
      },
    );

    const ticket = mapTicketRow(updated[0]);
    emitDeskEvent([ROOMS.tenant(tenantId), ROOMS.ticket(ticketId)], SOCKET_EVENTS.ticketDeleted, {
      tenantId,
      at: new Date().toISOString(),
      ticketId,
      number: ticket.number,
      purged: false,
    });
    return ticket;
  });
}

export async function restore(
  tenantId: number,
  actor: ActorContext,
  ticketId: number,
): Promise<TicketWithRelations> {
  return db.transaction(async (tx) => {
    await lockTicket(tenantId, ticketId, tx);
    const updated = (await scoped('tickets', tenantId, tx)
      .where('tickets.id', ticketId)
      .update({
        deleted_at: null,
        updated_at: tx.fn.now(),
        row_version: tx.raw('row_version + 1'),
      })
      .returning('*')) as unknown as TicketRow[];

    await journalService.append(
      {
        tenantId,
        ticketId,
        kind: 'system',
        visibility: 'internal',
        authorId: actor.userId,
        authorType: actor.actorType,
        meta: { restored: true },
        emit: false,
      },
      tx,
    );
    return mapTicketRow(updated[0]);
  });
}

/**
 * Guard rail for the queue counters and the intake form: the default priority
 * when nothing else is known. Exported so callers stop hard-coding 'p3'.
 */
export const FALLBACK_PRIORITY_SLUG = DEFAULT_PRIORITY_SLUG;

/** Re-exported so callers building a guard context do not import two modules. */
export { buildTransitionContext };

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 16 — the engine-facing surface
// ═════════════════════════════════════════════════════════════════════════════

/** An engine acting with no human behind it. */
export function systemActor(
  options: { actorType?: ActorType; actorId?: number | null; role?: string } = {},
): ActorContext {
  return {
    userId: options.actorId ?? null,
    username: null,
    role: options.role ?? 'system',
    actorType: options.actorType ?? 'system',
    // An engine is not RBAC-limited: it is limited by its binding's
    // configuration, which the caller already evaluated.
    capabilities: [...ALL_CAPABILITIES],
    assignmentGroupIds: [],
    isAdmin: true,
  };
}

export interface SystemCreateTicketInput
  extends Omit<CreateTicketInput, 'recordType' | 'source'> {
  tenantId: number;
  /** Validated against TICKET_RECORD_TYPES inside `create()`. */
  recordType?: string;
  source?: string;
}

export interface SystemActorOptions {
  actorType?: ActorType;
  actorId?: number | null;
  trx?: Knex.Transaction;
}

/**
 * Close (or park) a ticket that an alert's recovery signal says is fixed.
 *
 * The guardrail is the whole point. If a human replied publicly or logged time,
 * they WORKED this ticket, and auto-closing it deletes that from the record —
 * the ticket stops appearing in "handled by", the time looks unbilled, and the
 * agent finds out their afternoon vanished when someone asks about it.
 *
 * So the recovery has two outcomes, never one:
 *
 *   UNTOUCHED → the `resolved` category. Nobody worked it, the problem is gone,
 *     and leaving it open just means someone closes it by hand tomorrow.
 *
 *   TOUCHED → review. There is no `review` status category — HARD RULE 5 fixes
 *     the eight — so "review" is expressed in the vocabulary the desk actually
 *     has: the ticket is pulled back into the WORKABLE (`open`) category, where
 *     it sits in an agent's queue with the recovery note on top, for a human to
 *     read and close. That matters most for a ticket parked in
 *     `pending_requester` / `pending_third_party` / `scheduled`: those are the
 *     states nobody looks at, and a fixed-but-touched ticket left there is a
 *     ticket that quietly rots. A ticket already `new` or `open` is in front of
 *     a human by definition, so its status is left exactly where the agent put
 *     it and the journal entry is the flag.
 *
 * Both outcomes append the journal entry, and both write a `decision_log` row
 * on this same code path (HARD RULE 2) — the resolve and review branches
 * through `transition()`, which records its own, and the two branches that
 * deliberately move nothing through an explicit row that says so. "The alert
 * cleared but my ticket did not move" has to be answerable, and a branch that
 * returns silently is exactly the one that gets asked about.
 *
 * Every transition is taken with `system: true`: recovery is a fact from
 * another app, not an agent's move, and refusing it because the resolution
 * notes are empty would leave a fixed problem open forever.
 */
export async function applyAlertRecovery(
  input: {
    tenantId: number;
    ticketId: number;
    clearedAt: string;
    /** A human replied or logged time — do NOT auto-close. */
    touched: boolean;
    note: string;
  },
  trx?: Knex.Transaction,
): Promise<{ closed: boolean; review: boolean; ticket: TicketWithRelations | null }> {
  const run = async (tx: Knex.Transaction) => {
    const ticket = await getById(input.tenantId, input.ticketId, { executor: tx });
    if (!ticket) return { closed: false, review: false, ticket: null };

    const actor = systemActor();

    await journalService.append(
      {
        tenantId: input.tenantId,
        ticketId: input.ticketId,
        kind: 'alert',
        visibility: 'internal',
        authorType: 'system',
        bodyMd: input.note,
        meta: { alertRecovery: true, clearedAt: input.clearedAt, touched: input.touched },
        emit: false,
      },
      tx,
    );

    const decisionInputs = {
      clearedAt: input.clearedAt,
      touched: input.touched,
      fromStatusSlug: ticket.statusSlug,
      fromStatusCategory: ticket.statusCategory,
    };

    /** The row for a branch that moves nothing — see HARD RULE 2 above. */
    const recordNoMove = (decision: string, reason: string): Promise<void> =>
      withDecision(
        {
          tenantId: input.tenantId,
          ticketId: input.ticketId,
          subsystem: 'workflow',
          decision,
          ruleSlug: 'alert_recovery',
          actorId: null,
          trx: tx,
          inputs: decisionInputs,
        },
        async (recorder) => {
          recorder?.outcome?.({ moved: false, reason, statusSlug: ticket.statusSlug });
        },
      );

    // Already finished. The recovery is still journalled — it is evidence about
    // when the problem actually cleared — but there is nothing left to move.
    if (isTerminal(ticket.statusCategory)) {
      await recordNoMove('alert_recovery_noop', 'already_terminal');
      return { closed: false, review: false, ticket };
    }

    const machine = await loadStateMachineForTicket(input.tenantId, ticket, tx);

    // ── A human worked it → review, never auto-close ─────────────────────────
    if (input.touched) {
      if (isWorkable(ticket.statusCategory)) {
        await recordNoMove('alert_recovery_review', 'already_workable');
        return { closed: false, review: true, ticket };
      }

      const review = statusForCategory(machine, 'open');
      if (!review) {
        await recordNoMove('alert_recovery_review', 'no_open_status_in_machine');
        return { closed: false, review: false, ticket };
      }

      const reviewed = await transition(
        input.tenantId,
        actor,
        input.ticketId,
        {
          baseRowVersion: ticket.rowVersion,
          toStatusSlug: review.slug,
          system: true,
          ruleSlug: 'alert_recovery',
          effectiveAt: input.clearedAt,
        },
        tx,
      );
      return { closed: false, review: true, ticket: reviewed.ticket };
    }

    // ── Nobody touched it → resolve ──────────────────────────────────────────
    const resolved = statusForCategory(machine, 'resolved');
    if (!resolved) {
      await recordNoMove('alert_recovery_noop', 'no_resolved_status_in_machine');
      return { closed: false, review: false, ticket };
    }

    const result = await transition(
      input.tenantId,
      actor,
      input.ticketId,
      {
        baseRowVersion: ticket.rowVersion,
        toStatusSlug: resolved.slug,
        resolutionCode: 'auto_recovered',
        resolutionMd: input.note,
        system: true,
        ruleSlug: 'alert_recovery',
        // The source app's real recovery time, not ingest time — MTTR depends on it.
        effectiveAt: input.clearedAt,
      },
      tx,
    );
    return { closed: true, review: false, ticket: result.ticket };
  };

  return trx ? run(trx) : db.transaction(run);
}

/**
 * The object form of this module.
 *
 * `alert.service` (and any other engine that only needs a couple of entry
 * points) imports this rather than the whole namespace, and `create()` here
 * takes `tenantId` on the payload with the actor described by options — the
 * shape an engine naturally has, since it has no request and no session.
 */
export const ticketService = {
  create: (
    input: SystemCreateTicketInput,
    options: SystemActorOptions = {},
  ): Promise<TicketWithRelations> => {
    const { tenantId, ...payload } = input;
    return create(
      tenantId,
      systemActor({ actorType: options.actorType, actorId: options.actorId }),
      payload as CreateTicketInput,
      options.trx,
    );
  },
  applyAlertRecovery,
  getById,
  getByNumber,
  getDetail,
  list,
  search,
  update,
  transition,
  getAvailableTransitions,
  addJournalEntry,
  merge,
  revertMerge,
  split,
  reopen,
  bulkPreview,
  bulkApply,
  bulkUndo,
  softDelete,
  restore,
  addWatcher,
  removeWatcher,
  listWatchers,
  addLink,
  removeLink,
  listLinks,
  systemActor,
};

export default ticketService;
