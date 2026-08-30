/**
 * problem.service.ts — the problem record, its root-cause analysis, the known
 * error it may become, and the closure cascade it may run.
 *
 * A problem IS a ticket (`record_type = 'problem'`). Everything that concerns
 * the ticket itself — creation, transitions, journal entries, links — goes
 * through `ticket.service`. This module owns the 1:1 `problems` row and its
 * children, and nothing else. There is no second state machine here.
 *
 *   HARD RULE 1  every query is `scoped()` / `insertScoped()`; no bare db().
 *   HARD RULE 2  a decision_log row is written by `withDecision()` on the SAME
 *                code path, in the SAME transaction, as the action it explains.
 *   HARD RULE 5  the cascade and the rollups key off `status_category`, never
 *                off a status slug. The target status is resolved from the
 *                tenant's state machine by CATEGORY.
 *   HARD RULE 6  a promoted problem inherits the INCIDENT's `occurred_at`, not
 *                the promotion instant. An outage that started at 02:14 keeps
 *                02:14 even when it is ticketed as a problem at 16:00.
 *   HARD RULE 7  `problems.row_version` is its own concurrency domain, separate
 *                from `tickets.row_version`. Every mutation carries the base
 *                version it read; a mismatch is a 409 carrying the current row.
 *   HARD RULE 12 inline edits autosave field by field and validate NOTHING.
 *                Completeness is demanded only at a gate, by the SHARED
 *                evaluator the client runs to grey out the same button.
 *
 * ── The dangerous half of this file ──────────────────────────────────────────
 *
 * `cascadeOnResolve()` resolves other people's tickets in bulk from one click.
 * A bug there does not produce a stack trace, it produces a Monday morning in
 * which forty requesters were told their problem was fixed while they were
 * waiting for an answer. Every guard is stated where it is applied, and the
 * ordering of the file puts the guards before the action deliberately:
 *
 *   1. the plan is computed by the SHARED `planClosureCascade()` BEFORE
 *      anything is written, so the preview the agent read and the pass that
 *      runs are the same arithmetic;
 *   2. the pass never CLOSES, it only RESOLVES (`CASCADE_TARGET_CATEGORY`), so
 *      an automation that got it wrong is reversible;
 *   3. the pass goes through `ticketService.transition()` with guards ON, never
 *      a direct UPDATE and never a hard-coded slug, so a tenant's own workflow
 *      rules still get the last word;
 *   4. every incident runs in its own SAVEPOINT, so one failure blocks one
 *      incident instead of poisoning the whole transaction and silently
 *      abandoning the rest;
 *   5. an incident the classifier could not read (an unparseable scheduled
 *      instant, a queue whose state machine has no `resolved` status) is
 *      BLOCKED, never resolved. When the data is unreadable the safe answer is
 *      a human.
 */
import type { Knex } from 'knex';
import {
  CAPABILITIES,
  CASCADE_ELIGIBLE_RECORD_TYPES,
  CASCADE_RESOLUTION_CODE,
  CASCADE_TARGET_CATEGORY,
  KNOWN_ERROR_WEAPON_WEIGHTS,
  LIMITS,
  PAGINATION,
  PROBLEM_DECISIONS,
  PROBLEM_LINK_KIND,
  evaluateAnalysisTransition,
  evaluateCauseConfirmation,
  evaluateKnownErrorPublication,
  hasCapability,
  isProblemAnalysisState,
  planClosureCascade,
  type AddProblemAlertSignatureRequest,
  type AddProblemCauseEvidenceRequest,
  type AnalysisCauseSnapshot,
  type Capability,
  type CascadeBlockReason,
  type CascadeIncidentSnapshot,
  type ChangeProblemAnalysisStateRequest,
  type ConfirmProblemCauseRequest,
  type CreateProblemAnalysisRequest,
  type CreateProblemCauseRequest,
  type CauseCategory,
  type CauseConfidence,
  type CauseConfirmationMethod,
  type CauseKind,
  type KnownErrorMatchWeapon,
  type KnownErrorState,
  type KnownErrorSuggestion,
  type LinkIncidentsRequest,
  type Problem,
  type ProblemActorContext,
  type ProblemAlertSignature,
  type ProblemAnalysis,
  type ProblemAnalysisState,
  type ProblemAnalysisWithCauses,
  type ProblemCascadeOutcome,
  type ProblemCascadeResult,
  type ProblemCause,
  type ProblemCauseEvidence,
  type ProblemClosurePolicy,
  type ProblemDetectedBy,
  type ProblemEvidenceType,
  type ProblemGateEvaluation,
  type ProblemLinkSource,
  type ProblemListQuery,
  type ProblemRequirement,
  type ProblemTicketHeader,
  type ProblemWithRelations,
  type PromoteIncidentRequest,
  type PublishKnownErrorRequest,
  type PublishKnownErrorToKbRequest,
  type RcaMethod,
  type RetireKnownErrorRequest,
  type StatusCategory,
  type UnlinkIncidentsRequest,
  type UpdateProblemAnalysisRequest,
  type UpdateProblemCauseRequest,
  type UpdateProblemRequest,
  type VerifyWorkaroundRequest,
  type WorkaroundRisk,
} from '@oblidesk/shared';

import { db, insertScoped, scoped, assertTenantId, type Executor } from '../db';
import { AppError } from '../middleware/errorHandler';
import { withDecision } from './decision.service';
import * as journalService from './journal.service';
import * as ticketService from './ticket.service';
import { loadStateMachineForTicket, statusForCategory } from './stateMachine.service';
import { normalizeQuery, TS_CONFIG } from './search.service';
import { logger } from '../utils/logger';

/** The acting user or engine. Same shape the rest of the desk passes around. */
export type ActorContext = ticketService.ActorContext;

/**
 * HARD RULE 3 — the config slug the Why drawer prints next to every row this
 * module writes. Problem management is product behaviour, not a tenant-editable
 * rule, so the slug is fixed and its version is 1 until the semantics change.
 */
const PROBLEM_ENGINE_SLUG = 'problem_management';
const PROBLEM_ENGINE_VERSION = 1;

/** Maximum depth of the cause tree. Mirrors `problem_causes_depth_ck`. */
const MAX_CAUSE_DEPTH = 12;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Errors the controller turns into rich responses
// ═════════════════════════════════════════════════════════════════════════════

/**
 * HARD RULE 7 on the PROBLEM's own axis. `current` is the whole problem so the
 * client can render a diff, and `code` stays `version_conflict` because that is
 * what the client branches on for a ticket too: one reconciliation path, not
 * two.
 */
export class ProblemVersionConflictError extends AppError {
  constructor(current: ProblemWithRelations, conflictingFields: string[]) {
    super(409, 'This problem changed while you were editing it', {
      code: 'version_conflict',
      payload: { current, conflictingFields },
    });
    this.name = 'ProblemVersionConflictError';
  }
}

/**
 * A gate the SHARED evaluator refused (HARD RULE 12). The blockers travel
 * verbatim: each one already carries its `t(key, fallback)` pair, so the 422
 * body says exactly what greyed the button out on the client.
 */
export class ProblemGateError extends AppError {
  constructor(message: string, evaluation: ProblemGateEvaluation) {
    super(422, message, {
      code: 'transition_blocked',
      payload: {
        blockers: evaluation.blockers,
        missingCapabilities: evaluation.missingCapabilities,
      },
    });
    this.name = 'ProblemGateError';
  }
}

/** A row-version conflict on an analysis or a cause node. */
function versionConflict(what: string, current: unknown): AppError {
  return new AppError(409, `This ${what} changed while you were editing it`, {
    code: 'version_conflict',
    payload: { current, conflictingFields: [] },
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Row shapes and mappers
// ═════════════════════════════════════════════════════════════════════════════

interface ProblemRow {
  ticket_id: number;
  tenant_id: number;
  known_error_state: string;
  known_error_published_at: Date | string | null;
  known_error_published_by: number | null;
  symptoms_md: string | null;
  workaround_md: string | null;
  workaround_html: string | null;
  workaround_risk: string | null;
  workaround_verified_at: Date | string | null;
  workaround_verified_by: number | null;
  first_incident_at: Date | string | null;
  last_incident_at: Date | string | null;
  incident_count: number | string;
  detected_by: string;
  candidate_id: number | null;
  rca_required: boolean;
  closure_policy: string;
  major: boolean;
  major_review_due_at: Date | string | null;
  kb_article_id: number | null;
  row_version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AnalysisRow {
  id: number;
  tenant_id: number;
  problem_ticket_id: number;
  title: string | null;
  method: string;
  state: string;
  facilitator_id: number | null;
  root_cause_id: number | string | null;
  conclusion_md: string | null;
  is_current: boolean;
  started_at: Date | string;
  concluded_at: Date | string | null;
  concluded_by: number | null;
  row_version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CauseRow {
  id: number | string;
  tenant_id: number;
  analysis_id: number;
  parent_cause_id: number | string | null;
  depth: number | string;
  sort_order: number | string;
  category: string;
  statement: string;
  detail_md: string | null;
  kind: string;
  confidence: string;
  confirmation_method: string | null;
  confirmed_at: Date | string | null;
  confirmed_by: number | null;
  created_by: number | null;
  row_version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EvidenceRow {
  id: number | string;
  tenant_id: number;
  cause_id: number | string;
  evidence_type: string;
  ticket_evidence_id: number | null;
  ci_id: number | null;
  alert_id: number | null;
  ticket_id: number | null;
  journal_id: number | string | null;
  kb_article_id: number | null;
  external_url: string | null;
  note: string | null;
  added_by: number | null;
  captured_at: Date | string;
}

interface SignatureRow {
  id: number;
  tenant_id: number;
  problem_ticket_id: number;
  source_app: string;
  dedupe_key: string;
  added_by: number | null;
  created_at: Date | string;
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
  occurred_at: Date | string | null;
  created_at: Date | string;
  resolved_at: Date | string | null;
  closed_at: Date | string | null;
  row_version: number | string;
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

function mapProblemRow(row: ProblemRow): Problem {
  return {
    ticketId: row.ticket_id,
    tenantId: row.tenant_id,
    knownErrorState: row.known_error_state as KnownErrorState,
    knownErrorPublishedAt: iso(row.known_error_published_at),
    knownErrorPublishedBy: row.known_error_published_by,
    symptomsMd: row.symptoms_md,
    workaroundMd: row.workaround_md,
    workaroundHtml: row.workaround_html,
    workaroundRisk: (row.workaround_risk as WorkaroundRisk | null) ?? null,
    workaroundVerifiedAt: iso(row.workaround_verified_at),
    workaroundVerifiedBy: row.workaround_verified_by,
    firstIncidentAt: iso(row.first_incident_at),
    lastIncidentAt: iso(row.last_incident_at),
    incidentCount: int(row.incident_count),
    detectedBy: row.detected_by as ProblemDetectedBy,
    candidateId: row.candidate_id,
    rcaRequired: row.rca_required,
    closurePolicy: row.closure_policy as ProblemClosurePolicy,
    major: row.major,
    majorReviewDueAt: iso(row.major_review_due_at),
    kbArticleId: row.kb_article_id,
    rowVersion: int(row.row_version, 1),
    createdAt: isoAt(row.created_at, new Date()),
    updatedAt: isoAt(row.updated_at, new Date()),
  };
}

function mapAnalysisRow(row: AnalysisRow): ProblemAnalysis {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    problemTicketId: row.problem_ticket_id,
    title: row.title,
    method: row.method as RcaMethod,
    state: row.state as ProblemAnalysisState,
    facilitatorId: row.facilitator_id,
    rootCauseId: row.root_cause_id === null ? null : int(row.root_cause_id, 0) || null,
    conclusionMd: row.conclusion_md,
    isCurrent: row.is_current,
    startedAt: isoAt(row.started_at, new Date()),
    concludedAt: iso(row.concluded_at),
    concludedBy: row.concluded_by,
    rowVersion: int(row.row_version, 1),
    createdAt: isoAt(row.created_at, new Date()),
    updatedAt: isoAt(row.updated_at, new Date()),
  };
}

function mapCauseRow(row: CauseRow, evidenceCount?: number): ProblemCause {
  const cause: ProblemCause = {
    id: int(row.id),
    tenantId: row.tenant_id,
    analysisId: row.analysis_id,
    parentCauseId: row.parent_cause_id === null ? null : int(row.parent_cause_id, 0) || null,
    depth: int(row.depth),
    sortOrder: int(row.sort_order),
    category: row.category as CauseCategory,
    statement: row.statement,
    detailMd: row.detail_md,
    kind: row.kind as CauseKind,
    confidence: row.confidence as CauseConfidence,
    confirmationMethod: (row.confirmation_method as CauseConfirmationMethod | null) ?? null,
    confirmedAt: iso(row.confirmed_at),
    confirmedBy: row.confirmed_by,
    createdBy: row.created_by,
    rowVersion: int(row.row_version, 1),
    createdAt: isoAt(row.created_at, new Date()),
    updatedAt: isoAt(row.updated_at, new Date()),
  };
  if (evidenceCount !== undefined) cause.evidenceCount = evidenceCount;
  return cause;
}

function mapEvidenceRow(row: EvidenceRow): ProblemCauseEvidence {
  return {
    id: int(row.id),
    tenantId: row.tenant_id,
    causeId: int(row.cause_id),
    evidenceType: row.evidence_type as ProblemEvidenceType,
    ticketEvidenceId: row.ticket_evidence_id,
    ciId: row.ci_id,
    alertId: row.alert_id,
    ticketId: row.ticket_id,
    journalId: row.journal_id === null ? null : int(row.journal_id, 0) || null,
    kbArticleId: row.kb_article_id,
    externalUrl: row.external_url,
    note: row.note,
    addedBy: row.added_by,
    capturedAt: isoAt(row.captured_at, new Date()),
  };
}

function mapSignatureRow(row: SignatureRow): ProblemAlertSignature {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    problemTicketId: row.problem_ticket_id,
    sourceApp: row.source_app,
    dedupeKey: row.dedupe_key,
    addedBy: row.added_by,
    createdAt: isoAt(row.created_at, new Date()),
  };
}

function mapTicketHeaderRow(row: TicketHeaderRow): ProblemTicketHeader {
  return {
    ticketId: row.id,
    number: row.number,
    subject: row.subject,
    statusSlug: row.status_slug,
    statusCategory: row.status_category as StatusCategory,
    prioritySlug: row.priority_slug,
    queueSlug: row.queue_slug,
    assigneeId: row.assignee_id,
    // HARD RULE 6 — `occurred_at` is the authority; `created_at` is only the
    // fallback for rows predating intake capture, never a backfill of it.
    occurredAt: isoAt(row.occurred_at, row.created_at),
    createdAt: isoAt(row.created_at, new Date()),
    resolvedAt: iso(row.resolved_at),
    closedAt: iso(row.closed_at),
    rowVersion: int(row.row_version, 1),
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
  'tickets.occurred_at',
  'tickets.created_at',
  'tickets.resolved_at',
  'tickets.closed_at',
  'tickets.row_version',
];

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Small shared helpers
// ═════════════════════════════════════════════════════════════════════════════

/** What the shared evaluators need to know about the actor. */
function actorGate(actor: ActorContext): ProblemActorContext {
  return { capabilities: actor.capabilities, isAdmin: actor.isAdmin ?? false };
}

/** The `withDecision` context every row in this module shares. */
function decisionContext(
  tenantId: number,
  ticketId: number | null,
  decision: string,
  actor: ActorContext | null,
  trx: Executor,
  inputs?: Record<string, unknown>,
) {
  return {
    tenantId,
    ticketId,
    subsystem: 'problem' as const,
    decision,
    ruleSlug: PROBLEM_ENGINE_SLUG,
    ruleVersion: PROBLEM_ENGINE_VERSION,
    actorId: actor?.userId ?? null,
    actorType: actor?.actorType,
    trx,
    ...(inputs ? { inputs } : {}),
  };
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

/** Load the `problems` row, locking it when the caller is about to mutate it. */
async function loadProblemRow(
  tenantId: number,
  problemTicketId: number,
  executor: Executor,
  lock = false,
): Promise<ProblemRow | undefined> {
  const qb = scoped('problems', tenantId, executor).where('problems.ticket_id', problemTicketId);
  if (lock) qb.forUpdate();
  return (await qb.first('problems.*')) as ProblemRow | undefined;
}

async function requireProblemRow(
  tenantId: number,
  problemTicketId: number,
  executor: Executor,
  lock = false,
): Promise<ProblemRow> {
  const row = await loadProblemRow(tenantId, problemTicketId, executor, lock);
  if (!row) throw new AppError(404, 'Problem not found', { code: 'not_found' });
  return row;
}

async function loadTicketHeader(
  tenantId: number,
  ticketId: number,
  executor: Executor,
): Promise<ProblemTicketHeader | null> {
  const row = (await scoped('tickets', tenantId, executor)
    .where('tickets.id', ticketId)
    .whereNull('tickets.deleted_at')
    .first(...TICKET_HEADER_COLUMNS)) as TicketHeaderRow | undefined;
  return row ? mapTicketHeaderRow(row) : null;
}

/**
 * The CIs a problem touches. A CI is reached from a ticket in TWO real ways —
 * `tickets.primary_ci_id` and a `ticket_cis` row — and a query that tests only
 * one of them under-reports, which here would mean refusing to publish a
 * perfectly findable known error.
 */
async function loadProblemCiIds(
  tenantId: number,
  problemTicketId: number,
  executor: Executor,
): Promise<number[]> {
  const ids = new Set<number>();

  const ticket = (await scoped('tickets', tenantId, executor)
    .where('tickets.id', problemTicketId)
    .first('tickets.primary_ci_id')) as { primary_ci_id: number | null } | undefined;
  if (ticket?.primary_ci_id) ids.add(ticket.primary_ci_id);

  const links = (await scoped('ticket_cis', tenantId, executor)
    .where('ticket_cis.ticket_id', problemTicketId)
    .select('ticket_cis.ci_id')) as unknown as Array<{ ci_id: number }>;
  for (const link of links) ids.add(link.ci_id);

  return [...ids];
}

/** Evidence counts per cause, in one round trip. */
async function evidenceCountsByCause(
  tenantId: number,
  causeIds: readonly number[],
  executor: Executor,
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (causeIds.length === 0) return counts;

  const rows = (await scoped('problem_cause_evidence', tenantId, executor)
    .whereIn('problem_cause_evidence.cause_id', causeIds as number[])
    .groupBy('problem_cause_evidence.cause_id')
    .select('problem_cause_evidence.cause_id')
    .count<{ cause_id: number | string; count: string }[]>(
      'problem_cause_evidence.id as count',
    )) as unknown as Array<{ cause_id: number | string; count: string }>;

  for (const row of rows) counts.set(int(row.cause_id), int(row.count));
  return counts;
}

/** Causes of one analysis, flat, in `(parent, sortOrder)` order with counts. */
async function loadCauses(
  tenantId: number,
  analysisId: number,
  executor: Executor,
): Promise<ProblemCause[]> {
  const rows = (await scoped('problem_causes', tenantId, executor)
    .where('problem_causes.analysis_id', analysisId)
    .orderBy([
      { column: 'problem_causes.depth', order: 'asc' },
      { column: 'problem_causes.sort_order', order: 'asc' },
      { column: 'problem_causes.id', order: 'asc' },
    ])
    .select('problem_causes.*')) as unknown as CauseRow[];

  const counts = await evidenceCountsByCause(
    tenantId,
    rows.map((row) => int(row.id)),
    executor,
  );
  return rows.map((row) => mapCauseRow(row, counts.get(int(row.id)) ?? 0));
}

/** The snapshot shape the shared analysis evaluator consumes. */
function toCauseSnapshot(cause: ProblemCause): AnalysisCauseSnapshot {
  return {
    id: cause.id,
    statement: cause.statement ?? '',
    kind: cause.kind,
    category: cause.category,
    confidence: cause.confidence,
    confirmationMethod: cause.confirmationMethod,
    confirmedBy: cause.confirmedBy,
    evidenceCount: cause.evidenceCount ?? 0,
  };
}

async function loadAnalysisRow(
  tenantId: number,
  analysisId: number,
  executor: Executor,
  lock = false,
): Promise<AnalysisRow | undefined> {
  const qb = scoped('problem_analyses', tenantId, executor).where(
    'problem_analyses.id',
    analysisId,
  );
  if (lock) qb.forUpdate();
  return (await qb.first('problem_analyses.*')) as AnalysisRow | undefined;
}

async function loadCurrentAnalysis(
  tenantId: number,
  problemTicketId: number,
  executor: Executor,
): Promise<ProblemAnalysisWithCauses | null> {
  const row = (await scoped('problem_analyses', tenantId, executor)
    .where('problem_analyses.problem_ticket_id', problemTicketId)
    .where('problem_analyses.is_current', true)
    .first('problem_analyses.*')) as AnalysisRow | undefined;
  if (!row) return null;
  const analysis = mapAnalysisRow(row);
  return { ...analysis, causes: await loadCauses(tenantId, analysis.id, executor) };
}

async function hydrateAnalysis(
  tenantId: number,
  row: AnalysisRow,
  executor: Executor,
): Promise<ProblemAnalysisWithCauses> {
  const analysis = mapAnalysisRow(row);
  return { ...analysis, causes: await loadCauses(tenantId, analysis.id, executor) };
}

/**
 * Recompute the three rollups from the links that actually exist, in the SAME
 * transaction as the link write.
 *
 * `row_version` is deliberately NOT bumped here. The rollups are a derived
 * aggregate over another table, never a field a human edits, and bumping would
 * 409 the RCA workshop for a change it does not care about (HARD RULE 7 exists
 * to protect concurrent EDITS, not to broadcast counters). `updated_at` moves,
 * so a client that cares can still tell the row changed.
 */
async function recomputeRollups(
  tenantId: number,
  problemTicketId: number,
  trx: Knex.Transaction,
): Promise<{ incidentCount: number; firstIncidentAt: string | null; lastIncidentAt: string | null }> {
  const rows = (await scoped('ticket_link', tenantId, trx)
    .join('tickets', 'tickets.id', 'ticket_link.from_ticket_id')
    // The join leaves the tenant predicate behind, so re-apply it by hand:
    // a link assembled without the tenant in hand is how one crosses tenants.
    .where('tickets.tenant_id', tenantId)
    .where('ticket_link.to_ticket_id', problemTicketId)
    .where('ticket_link.kind', PROBLEM_LINK_KIND)
    .whereNull('tickets.deleted_at')
    .select(
      trx.raw('count(*)::int as incident_count'),
      trx.raw('min(coalesce(tickets.occurred_at, tickets.created_at)) as first_incident_at'),
      trx.raw('max(coalesce(tickets.occurred_at, tickets.created_at)) as last_incident_at'),
    )) as unknown as Array<{
    incident_count: number | string;
    first_incident_at: Date | string | null;
    last_incident_at: Date | string | null;
  }>;

  const aggregate = rows[0] ?? { incident_count: 0, first_incident_at: null, last_incident_at: null };
  const incidentCount = int(aggregate.incident_count);
  const firstIncidentAt = iso(aggregate.first_incident_at);
  const lastIncidentAt = iso(aggregate.last_incident_at);

  await scoped('problems', tenantId, trx)
    .where('problems.ticket_id', problemTicketId)
    .update({
      incident_count: incidentCount,
      first_incident_at: aggregate.first_incident_at ?? null,
      last_incident_at: aggregate.last_incident_at ?? null,
      updated_at: trx.fn.now(),
    });

  return { incidentCount, firstIncidentAt, lastIncidentAt };
}

/** Run `fn` in `trx` when one was handed down, otherwise open one. */
function inTransaction<T>(trx: Knex.Transaction | undefined, fn: (tx: Knex.Transaction) => Promise<T>): Promise<T> {
  return trx ? fn(trx) : db.transaction(fn);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Reading
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The problem file: the row, its ticket header, the current analysis with its
 * causes, the alert signatures, the CIs, and the publication verdict already
 * evaluated by the SAME function the publish route runs. Shipping the verdict
 * with the payload is what lets the client grey the button out without a
 * second round trip and without a second opinion.
 */
export async function get(
  tenantId: number,
  problemTicketId: number,
  executor: Executor = db,
): Promise<ProblemWithRelations | null> {
  assertTenantId(tenantId);

  const row = await loadProblemRow(tenantId, problemTicketId, executor);
  if (!row) return null;
  const problem = mapProblemRow(row);

  const [ticket, currentAnalysis, alertSignatures, ciIds, analysisCount, linkedIncidentCount] =
    await Promise.all([
      loadTicketHeader(tenantId, problemTicketId, executor),
      loadCurrentAnalysis(tenantId, problemTicketId, executor),
      listAlertSignatures(tenantId, problemTicketId, executor),
      loadProblemCiIds(tenantId, problemTicketId, executor),
      countAnalyses(tenantId, problemTicketId, executor),
      countLinkedIncidents(tenantId, problemTicketId, executor),
    ]);

  return {
    ...problem,
    ticket: ticket ?? undefined,
    currentAnalysis,
    analysisCount,
    alertSignatures,
    ciIds,
    linkedIncidentCount,
    knownErrorPublication: evaluateKnownErrorPublication({
      problem,
      currentAnalysis: currentAnalysis
        ? { state: currentAnalysis.state, rootCauseId: currentAnalysis.rootCauseId }
        : null,
      linkedCiCount: ciIds.length,
    }),
  };
}

async function countAnalyses(
  tenantId: number,
  problemTicketId: number,
  executor: Executor,
): Promise<number> {
  const rows = (await scoped('problem_analyses', tenantId, executor)
    .where('problem_analyses.problem_ticket_id', problemTicketId)
    .count<{ count: string }[]>('problem_analyses.id as count')) as unknown as Array<{
    count: string;
  }>;
  return int(rows[0]?.count);
}

async function countLinkedIncidents(
  tenantId: number,
  problemTicketId: number,
  executor: Executor,
): Promise<number> {
  const rows = (await scoped('ticket_link', tenantId, executor)
    .join('tickets', 'tickets.id', 'ticket_link.from_ticket_id')
    .where('tickets.tenant_id', tenantId)
    .where('ticket_link.to_ticket_id', problemTicketId)
    .where('ticket_link.kind', PROBLEM_LINK_KIND)
    .whereNull('tickets.deleted_at')
    .count<{ count: string }[]>('ticket_link.id as count')) as unknown as Array<{ count: string }>;
  return int(rows[0]?.count);
}

/** Fetch a problem that must exist, already hydrated. Used to build 409 bodies. */
async function requireProblem(
  tenantId: number,
  problemTicketId: number,
  executor: Executor,
): Promise<ProblemWithRelations> {
  const problem = await get(tenantId, problemTicketId, executor);
  if (!problem) throw new AppError(404, 'Problem not found', { code: 'not_found' });
  return problem;
}

function asArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * The problem board.
 *
 * HARD RULE 5 in the filter list: `statusCategory` filters on the TICKET's
 * category, and there is deliberately no status-slug filter. A tenant renaming
 * "Investigating" changes nothing here.
 */
export async function list(
  tenantId: number,
  query: ProblemListQuery,
  executor: Executor = db,
): Promise<{ items: ProblemWithRelations[]; total: number; page: number; limit: number }> {
  assertTenantId(tenantId);

  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const limit = Math.min(PAGINATION.maxLimit, Math.max(1, Math.trunc(query.limit ?? PAGINATION.defaultLimit)));

  const base = scoped('problems', tenantId, executor)
    .join('tickets', 'tickets.id', 'problems.ticket_id')
    .where('tickets.tenant_id', tenantId)
    .whereNull('tickets.deleted_at');

  const knownErrorStates = asArray(query.knownErrorState);
  if (knownErrorStates && knownErrorStates.length > 0) {
    base.whereIn('problems.known_error_state', knownErrorStates);
  }

  const statusCategories = asArray(query.statusCategory);
  if (statusCategories && statusCategories.length > 0) {
    base.whereIn('tickets.status_category', statusCategories);
  }

  if (query.queueSlug) base.where('tickets.queue_slug', query.queueSlug);
  if (query.assigneeId !== undefined) base.where('tickets.assignee_id', query.assigneeId);
  if (query.major !== undefined) base.where('problems.major', query.major);
  if (query.detectedBy) base.where('problems.detected_by', query.detectedBy);

  if (query.ciId !== undefined) {
    // Both routes to a CI are real (see `loadProblemCiIds`), so the filter has
    // to test both or it silently hides half the board.
    base.where((qb) => {
      qb.where('tickets.primary_ci_id', query.ciId).orWhereExists((sub) => {
        sub
          .select(1)
          .from('ticket_cis')
          .whereRaw('ticket_cis.ticket_id = problems.ticket_id')
          .where('ticket_cis.tenant_id', tenantId)
          .where('ticket_cis.ci_id', query.ciId as number);
      });
    });
  }

  const text = normalizeQuery(query.q);
  if (text) {
    // The same two arms the desk's own search uses, on the same configuration
    // ('simple', never 'english'): the problem's symptoms/workaround lexemes,
    // and a trigram over the ticket subject for typos and stem misses.
    base.where((qb) => {
      qb.whereRaw(`problems.search_tsv @@ websearch_to_tsquery('${TS_CONFIG}', unaccent(?))`, [text]);
      if (text.length >= 3) qb.orWhereRaw('tickets.subject % ?', [text]);
      qb.orWhereRaw('tickets.number ILIKE ?', [`${text}%`]);
    });
  }

  const countRows = (await base
    .clone()
    .clearSelect()
    .clearOrder()
    .count<{ count: string }[]>('problems.ticket_id as count')) as unknown as Array<{
    count: string;
  }>;
  const total = int(countRows[0]?.count);

  const sortColumn =
    query.sort === 'incident_count'
      ? 'problems.incident_count'
      : query.sort === 'created_at'
        ? 'problems.created_at'
        : query.sort === 'major_review_due_at'
          ? 'problems.major_review_due_at'
          : 'problems.last_incident_at';
  const direction = query.direction === 'asc' ? 'asc' : 'desc';

  const rows = (await base
    .orderByRaw(`${sortColumn} ${direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`)
    .orderBy('problems.ticket_id', 'desc')
    .limit(limit)
    .offset((page - 1) * limit)
    .select('problems.*', ...TICKET_HEADER_COLUMNS.map((column) => `${column} as t_${column.split('.')[1]}`))) as unknown as Array<
    ProblemRow & Record<string, unknown>
  >;

  const items: ProblemWithRelations[] = rows.map((row) => {
    const header: TicketHeaderRow = {
      id: row.t_id as number,
      number: row.t_number as string,
      subject: row.t_subject as string,
      status_slug: row.t_status_slug as string,
      status_category: row.t_status_category as string,
      priority_slug: row.t_priority_slug as string,
      queue_slug: row.t_queue_slug as string,
      assignee_id: (row.t_assignee_id as number | null) ?? null,
      occurred_at: (row.t_occurred_at as Date | string | null) ?? null,
      created_at: row.t_created_at as Date | string,
      resolved_at: (row.t_resolved_at as Date | string | null) ?? null,
      closed_at: (row.t_closed_at as Date | string | null) ?? null,
      row_version: row.t_row_version as number | string,
    };
    return { ...mapProblemRow(row), ticket: mapTicketHeaderRow(header) };
  });

  return { items, total, page, limit };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Promotion, and the incident links
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Promote an incident into a problem.
 *
 * The incident is NOT mutated: its `record_type` is not flipped, its state,
 * assignee and SLA are untouched. Its number is printed in the requester's
 * mail, its SLA clocks and its CSAT hang off it, and turning it into something
 * else orphans all three. A NEW problem ticket is created and the incident
 * points at it through `ticket_link(kind = 'caused_by')`, which already reads
 * in the right direction: the incident is caused_by the problem.
 *
 * HARD RULE 6 — the problem inherits the incident's `occurred_at`. The
 * condition started when it started, not when somebody noticed it deserved a
 * problem record.
 */
export async function promote(
  tenantId: number,
  actor: ActorContext,
  input: PromoteIncidentRequest,
  trx?: Knex.Transaction,
): Promise<ProblemWithRelations> {
  assertTenantId(tenantId);

  return inTransaction(trx, async (tx) => {
    const incident = (await scoped('tickets', tenantId, tx)
      .where('tickets.id', input.incidentId)
      .whereNull('tickets.deleted_at')
      .first('tickets.*')) as
      | {
          id: number;
          record_type: string;
          subject: string;
          description_md: string | null;
          queue_slug: string;
          priority_slug: string;
          organization_id: number | null;
          primary_ci_id: number | null;
          occurred_at: Date | string | null;
          created_at: Date | string;
        }
      | undefined;

    if (!incident) throw new AppError(404, 'Incident not found', { code: 'not_found' });

    if (!(CASCADE_ELIGIBLE_RECORD_TYPES as readonly string[]).includes(incident.record_type)) {
      throw new AppError(
        400,
        'Only an incident or a request can be promoted to a problem',
        { code: 'validation_failed' },
      );
    }

    const occurredAt = isoAt(incident.occurred_at, incident.created_at);

    const problemTicket = await ticketService.create(
      tenantId,
      actor,
      {
        recordType: 'problem',
        subject: (input.subject ?? '').trim() || incident.subject,
        descriptionMd: input.descriptionMd ?? incident.description_md,
        occurredAt,
        queueSlug: input.queueSlug ?? incident.queue_slug,
        prioritySlug: input.prioritySlug ?? incident.priority_slug,
        assigneeId: input.assigneeId ?? null,
        organizationId: incident.organization_id,
        primaryCiId: incident.primary_ci_id,
        source: 'web',
        ruleSlug: PROBLEM_ENGINE_SLUG,
      },
      tx,
    );

    const inserted = (await insertScoped(
      'problems',
      tenantId,
      {
        ticket_id: problemTicket.id,
        symptoms_md: input.symptomsMd ?? null,
        detected_by: 'promotion' satisfies ProblemDetectedBy,
        rca_required: input.rcaRequired ?? true,
        closure_policy: input.closurePolicy ?? 'notify_only',
        major: input.major ?? false,
      },
      tx,
    ).returning('*')) as unknown as ProblemRow[];

    if (inserted.length === 0) {
      throw new AppError(500, 'The problem record could not be created');
    }

    // The originating link, plus anything the dialog batched with it, in the
    // SAME transaction: a problem that exists without its founding incident is
    // a record nobody can explain.
    await ticketService.addLink(
      tenantId,
      actor,
      incident.id,
      { toTicketId: problemTicket.id, kind: PROBLEM_LINK_KIND },
      tx,
    );

    const rollups = await recomputeRollups(tenantId, problemTicket.id, tx);

    await withDecision(
      decisionContext(tenantId, problemTicket.id, PROBLEM_DECISIONS.promotedFromIncident, actor, tx, {
        incidentId: incident.id,
        subject: problemTicket.subject,
        occurredAt,
      }),
      async (recorder) => {
        recorder.outcome({ problemTicketId: problemTicket.id, linkKind: PROBLEM_LINK_KIND });
      },
    );

    // A second row, on the INCIDENT, because "why does my ticket point at
    // problem PRB-12?" is a question asked from the incident's Why drawer.
    await withDecision(
      decisionContext(tenantId, incident.id, PROBLEM_DECISIONS.incidentLinked, actor, tx, {
        problemTicketId: problemTicket.id,
        source: 'promotion' satisfies ProblemLinkSource,
      }),
      async (recorder) => {
        recorder.outcome({
          incidentCount: rollups.incidentCount,
          firstIncidentAt: rollups.firstIncidentAt,
          lastIncidentAt: rollups.lastIncidentAt,
        });
      },
    );

    const extra = (input.alsoLinkIncidentIds ?? []).filter((id) => id !== incident.id);
    if (extra.length > 0) {
      await linkIncidents(
        tenantId,
        actor,
        problemTicket.id,
        { incidentIds: extra, source: 'promotion' },
        tx,
      );
    }

    return requireProblem(tenantId, problemTicket.id, tx);
  });
}

/**
 * Attach incidents to a problem.
 *
 * Every refusal is a SKIP with a reason rather than a failed request: an agent
 * multi-selecting twelve tickets, one of which was merged away this morning,
 * wants the eleven links and a sentence about the twelfth.
 *
 * The refusals, and why each one exists:
 *
 *   self_link                    a ticket cannot be its own cause.
 *   not_found                    absent, deleted, or another tenant's. Tenancy
 *                                is enforced by `scoped()`, so a foreign id is
 *                                indistinguishable from a missing one, which is
 *                                exactly the right answer to give.
 *   record_type_not_eligible     only an incident or a request. A problem
 *                                linked under a problem would let one cascade
 *                                drive another, and a cascade that can trigger
 *                                a cascade has no bound.
 *   already_linked               idempotent, not an error.
 *   linked_to_another_problem    THE cascade guard. An incident hanging under
 *                                two problems would be auto-resolved by
 *                                whichever is fixed first, while the other is
 *                                still open and still hurting it.
 */
export async function linkIncidents(
  tenantId: number,
  actor: ActorContext,
  problemTicketId: number,
  input: LinkIncidentsRequest,
  trx?: Knex.Transaction,
): Promise<{ problem: Problem; linked: number[]; skipped: Array<{ ticketId: number; reason: string }> }> {
  assertTenantId(tenantId);
  const source: ProblemLinkSource = input.source ?? 'manual';

  return inTransaction(trx, async (tx) => {
    await requireProblemRow(tenantId, problemTicketId, tx, true);

    const requested = [...new Set(input.incidentIds ?? [])];
    const linked: number[] = [];
    const skipped: Array<{ ticketId: number; reason: string }> = [];
    const refusals: Array<{ ticketId: number; reason: string }> = [];

    for (const incidentId of requested) {
      if (incidentId === problemTicketId) {
        skipped.push({ ticketId: incidentId, reason: 'self_link' });
        continue;
      }

      const candidate = (await scoped('tickets', tenantId, tx)
        .where('tickets.id', incidentId)
        .whereNull('tickets.deleted_at')
        .first('tickets.id', 'tickets.record_type')) as
        | { id: number; record_type: string }
        | undefined;

      if (!candidate) {
        // No decision row: the ticket is not ours to explain anything about.
        skipped.push({ ticketId: incidentId, reason: 'not_found' });
        continue;
      }

      if (!(CASCADE_ELIGIBLE_RECORD_TYPES as readonly string[]).includes(candidate.record_type)) {
        skipped.push({ ticketId: incidentId, reason: 'record_type_not_eligible' });
        refusals.push({ ticketId: incidentId, reason: 'record_type_not_eligible' });
        continue;
      }

      const existing = (await scoped('ticket_link', tenantId, tx)
        .join('tickets as other', 'other.id', 'ticket_link.to_ticket_id')
        .where('other.tenant_id', tenantId)
        .where('ticket_link.from_ticket_id', incidentId)
        .where('ticket_link.kind', PROBLEM_LINK_KIND)
        .where('other.record_type', 'problem')
        .whereNull('other.deleted_at')
        .select('ticket_link.to_ticket_id')) as unknown as Array<{ to_ticket_id: number }>;

      if (existing.some((row) => row.to_ticket_id === problemTicketId)) {
        skipped.push({ ticketId: incidentId, reason: 'already_linked' });
        continue;
      }
      if (existing.length > 0) {
        skipped.push({ ticketId: incidentId, reason: 'linked_to_another_problem' });
        refusals.push({ ticketId: incidentId, reason: 'linked_to_another_problem' });
        continue;
      }

      await ticketService.addLink(
        tenantId,
        actor,
        incidentId,
        { toTicketId: problemTicketId, kind: PROBLEM_LINK_KIND },
        tx,
      );
      linked.push(incidentId);
    }

    const rollups = await recomputeRollups(tenantId, problemTicketId, tx);

    for (const incidentId of linked) {
      await withDecision(
        decisionContext(tenantId, incidentId, PROBLEM_DECISIONS.incidentLinked, actor, tx, {
          problemTicketId,
          source,
        }),
        async (recorder) => {
          recorder.outcome({
            incidentCount: rollups.incidentCount,
            firstIncidentAt: rollups.firstIncidentAt,
            lastIncidentAt: rollups.lastIncidentAt,
          });
        },
      );
    }

    // HARD RULE 2 — a refusal is a decision. "We declined to link this ticket,
    // and here is why" belongs in the incident's Why drawer just as much as the
    // link would have.
    for (const refusal of refusals) {
      await withDecision(
        decisionContext(tenantId, refusal.ticketId, PROBLEM_DECISIONS.incidentLinked, actor, tx, {
          problemTicketId,
          source,
        }),
        async (recorder) => {
          recorder.noop(refusal.reason);
        },
      );
    }

    const problem = mapProblemRow(await requireProblemRow(tenantId, problemTicketId, tx));
    return { problem, linked, skipped };
  });
}

/** Detach incidents. The rollups are recomputed in the same transaction. */
export async function unlinkIncidents(
  tenantId: number,
  actor: ActorContext,
  problemTicketId: number,
  input: UnlinkIncidentsRequest,
  trx?: Knex.Transaction,
): Promise<{ problem: Problem; unlinked: number[] }> {
  assertTenantId(tenantId);

  return inTransaction(trx, async (tx) => {
    await requireProblemRow(tenantId, problemTicketId, tx, true);

    const requested = [...new Set(input.incidentIds ?? [])];
    const unlinked: number[] = [];

    for (const incidentId of requested) {
      const removed = await scoped('ticket_link', tenantId, tx)
        .where('ticket_link.from_ticket_id', incidentId)
        .where('ticket_link.to_ticket_id', problemTicketId)
        .where('ticket_link.kind', PROBLEM_LINK_KIND)
        .del();
      if (removed > 0) unlinked.push(incidentId);
    }

    const rollups = await recomputeRollups(tenantId, problemTicketId, tx);

    for (const incidentId of unlinked) {
      await withDecision(
        decisionContext(tenantId, incidentId, PROBLEM_DECISIONS.incidentUnlinked, actor, tx, {
          problemTicketId,
        }),
        async (recorder) => {
          recorder.outcome({
            incidentCount: rollups.incidentCount,
            firstIncidentAt: rollups.firstIncidentAt,
            lastIncidentAt: rollups.lastIncidentAt,
          });
        },
      );
    }

    const problem = mapProblemRow(await requireProblemRow(tenantId, problemTicketId, tx));
    return { problem, unlinked };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Inline autosave on the problem file
// ═════════════════════════════════════════════════════════════════════════════

/**
 * HARD RULE 12 — one field at a time, validating NOTHING. A problem can sit
 * with an empty workaround and no risk for three weeks; the gate is
 * `publishKnownError()`, and it is the only place completeness is demanded.
 *
 * The single exception is not a completeness check, it is an invariant on
 * something ALREADY published: emptying the workaround of a live known error
 * would break `problems_published_workaround_ck` and surface as a 23514 with a
 * pg message the client cannot read. So it is refused here, in words, with the
 * action that unblocks it (retire it first).
 */
export async function update(
  tenantId: number,
  actor: ActorContext,
  problemTicketId: number,
  input: UpdateProblemRequest,
  trx?: Knex.Transaction,
): Promise<ProblemWithRelations> {
  assertTenantId(tenantId);

  return inTransaction(trx, async (tx) => {
    const current = await requireProblemRow(tenantId, problemTicketId, tx, true);

    const patch: Record<string, unknown> = {};
    if (input.symptomsMd !== undefined) patch.symptoms_md = input.symptomsMd;
    if (input.workaroundMd !== undefined) patch.workaround_md = input.workaroundMd;
    if (input.workaroundRisk !== undefined) patch.workaround_risk = input.workaroundRisk;
    if (input.rcaRequired !== undefined) patch.rca_required = input.rcaRequired;
    if (input.closurePolicy !== undefined) patch.closure_policy = input.closurePolicy;
    if (input.major !== undefined) patch.major = input.major;
    if (input.majorReviewDueAt !== undefined) patch.major_review_due_at = input.majorReviewDueAt;

    if (current.known_error_state === 'published') {
      const nextWorkaround =
        input.workaroundMd !== undefined ? input.workaroundMd : current.workaround_md;
      const nextRisk =
        input.workaroundRisk !== undefined ? input.workaroundRisk : current.workaround_risk;
      if (blank(nextWorkaround) || nextRisk === null) {
        throw new ProblemGateError('A published known error must keep its workaround', {
          allowed: false,
          missingCapabilities: [],
          blockers: [
            {
              code: 'known_error_published_workaround_required',
              key: 'problem.knownErrorBlocked.publishedWorkaroundRequired',
              fallback:
                'Retire this known error before emptying its workaround. The desk is still being told to apply it.',
            },
          ],
        });
      }
    }

    // Nothing to write is not an error: an autosave debounce can fire with no
    // net change. Answer with the current row so the client stays in sync.
    if (Object.keys(patch).length === 0) {
      return requireProblem(tenantId, problemTicketId, tx);
    }

    const updated = (await scoped('problems', tenantId, tx)
      .where('problems.ticket_id', problemTicketId)
      .where('problems.row_version', input.baseRowVersion)
      .update({ ...patch, row_version: tx.raw('row_version + 1'), updated_at: tx.fn.now() })
      .returning('*')) as unknown as ProblemRow[];

    if (updated.length === 0) {
      throw new ProblemVersionConflictError(
        await requireProblem(tenantId, problemTicketId, tx),
        Object.keys(patch),
      );
    }

    return requireProblem(tenantId, problemTicketId, tx);
  });
}

/**
 * Stamp the workaround as replayed. A workaround nobody has re-run since the
 * last upgrade is a hypothesis, and the UI saying "verified 8 months ago" is
 * the whole reason this column exists.
 */
export async function verifyWorkaround(
  tenantId: number,
  actor: ActorContext,
  problemTicketId: number,
  input: VerifyWorkaroundRequest,
  trx?: Knex.Transaction,
): Promise<ProblemWithRelations> {
  assertTenantId(tenantId);

  return inTransaction(trx, async (tx) => {
    await requireProblemRow(tenantId, problemTicketId, tx, true);

    const updated = (await scoped('problems', tenantId, tx)
      .where('problems.ticket_id', problemTicketId)
      .where('problems.row_version', input.baseRowVersion)
      .update({
        workaround_verified_at: input.verifiedAt ?? tx.fn.now(),
        workaround_verified_by: actor.userId ?? null,
        row_version: tx.raw('row_version + 1'),
        updated_at: tx.fn.now(),
      })
      .returning('*')) as unknown as ProblemRow[];

    if (updated.length === 0) {
      throw new ProblemVersionConflictError(await requireProblem(tenantId, problemTicketId, tx), [
        'workaroundVerifiedAt',
      ]);
    }

    return requireProblem(tenantId, problemTicketId, tx);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — The known error
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Publish. The server refuses with the SAME function that greys the button out
 * on the client (HARD RULE 12): `evaluateKnownErrorPublication`. There is no
 * server-side second opinion, so a blocker the agent could not see is
 * impossible by construction.
 */
export async function publishKnownError(
  tenantId: number,
  actor: ActorContext,
  problemTicketId: number,
  input: PublishKnownErrorRequest,
  trx?: Knex.Transaction,
): Promise<ProblemWithRelations> {
  assertTenantId(tenantId);

  return inTransaction(trx, async (tx) => {
    const row = await requireProblemRow(tenantId, problemTicketId, tx, true);
    const problem = mapProblemRow(row);

    const [currentAnalysis, ciIds] = await Promise.all([
      loadCurrentAnalysis(tenantId, problemTicketId, tx),
      loadProblemCiIds(tenantId, problemTicketId, tx),
    ]);

    const evaluation = evaluateKnownErrorPublication({
      problem,
      currentAnalysis: currentAnalysis
        ? { state: currentAnalysis.state, rootCauseId: currentAnalysis.rootCauseId }
        : null,
      linkedCiCount: ciIds.length,
      actor: actorGate(actor),
    });

    if (!evaluation.allowed) {
      throw new ProblemGateError('This known error cannot be published yet', evaluation);
    }

    const updated = (await scoped('problems', tenantId, tx)
      .where('problems.ticket_id', problemTicketId)
      .where('problems.row_version', input.baseRowVersion)
      .update({
        known_error_state: 'published' satisfies KnownErrorState,
        known_error_published_at: tx.fn.now(),
        known_error_published_by: actor.userId ?? null,
        row_version: tx.raw('row_version + 1'),
        updated_at: tx.fn.now(),
      })
      .returning('*')) as unknown as ProblemRow[];

    if (updated.length === 0) {
      throw new ProblemVersionConflictError(await requireProblem(tenantId, problemTicketId, tx), [
        'knownErrorState',
      ]);
    }

    const published = mapProblemRow(updated[0]);

    await withDecision(
      decisionContext(tenantId, problemTicketId, PROBLEM_DECISIONS.knownErrorPublished, actor, tx, {
        analysisId: currentAnalysis?.id ?? null,
        workaroundRisk: published.workaroundRisk,
        ciIds,
      }),
      async (recorder) => {
        recorder.outcome({
          state: published.knownErrorState,
          publishedAt: published.knownErrorPublishedAt,
        });
      },
    );

    return requireProblem(tenantId, problemTicketId, tx);
  });
}

/**
 * Retire. The permanent fix shipped, or the problem itself was resolved.
 *
 * The workaround text is NOT erased: incidents closed six months ago reference
 * it, and a retired known error that reads as an empty page turns their history
 * into a mystery. Retiring only stops the intake banner offering it.
 *
 * `baseRowVersion` is honoured when the caller supplies a real one. The
 * internal path (`onProblemResolved`) reads the row under the same lock and
 * passes what it read, so the guarantee is the same on both routes.
 */
export async function retireKnownError(
  tenantId: number,
  actor: ActorContext,
  problemTicketId: number,
  input: RetireKnownErrorRequest,
  trx?: Knex.Transaction,
): Promise<ProblemWithRelations> {
  assertTenantId(tenantId);

  return inTransaction(trx, async (tx) => {
    const row = await requireProblemRow(tenantId, problemTicketId, tx, true);

    // Nothing to retire is still a fact worth a row: "why did the cascade not
    // retire anything?" is a real question (HARD RULE 2).
    if (row.known_error_state === 'none' || row.known_error_state === 'retired') {
      await withDecision(
        decisionContext(tenantId, problemTicketId, PROBLEM_DECISIONS.knownErrorRetired, actor, tx, {
          resolutionCode: input.reason ?? null,
        }),
        async (recorder) => {
          recorder.noop(`already_${row.known_error_state}`);
          recorder.outcome({ state: row.known_error_state });
        },
      );
      return requireProblem(tenantId, problemTicketId, tx);
    }

    const updated = (await scoped('problems', tenantId, tx)
      .where('problems.ticket_id', problemTicketId)
      .where('problems.row_version', input.baseRowVersion)
      .update({
        known_error_state: 'retired' satisfies KnownErrorState,
        row_version: tx.raw('row_version + 1'),
        updated_at: tx.fn.now(),
      })
      .returning('*')) as unknown as ProblemRow[];

    if (updated.length === 0) {
      throw new ProblemVersionConflictError(await requireProblem(tenantId, problemTicketId, tx), [
        'knownErrorState',
      ]);
    }

    await withDecision(
      decisionContext(tenantId, problemTicketId, PROBLEM_DECISIONS.knownErrorRetired, actor, tx, {
        resolutionCode: input.reason ?? null,
      }),
      async (recorder) => {
        recorder.outcome({ state: 'retired' });
      },
    );

    return requireProblem(tenantId, problemTicketId, tx);
  });
}

/**
 * Seed a KB article from the known error and link it, once.
 *
 * The article is created as a DRAFT even though the caller holds KB_PUBLISH.
 * An internal workaround naming a host, a service account and an admin console,
 * pushed verbatim to the portal, is a data leak wearing a feature badge.
 * Rewriting it for the public is an editorial act by a human, and the two rows
 * are never synchronised afterwards, in either direction.
 */
export async function publishToKb(
  tenantId: number,
  actor: ActorContext,
  problemTicketId: number,
  input: PublishKnownErrorToKbRequest,
  trx?: Knex.Transaction,
): Promise<{ problem: ProblemWithRelations; kbArticleId: number }> {
  assertTenantId(tenantId);

  if (!hasCapability(actor.capabilities, CAPABILITIES.KB_PUBLISH, actor.isAdmin ?? false)) {
    throw new AppError(403, 'Publishing to the knowledge base needs kb_publish', {
      code: 'forbidden',
    });
  }

  return inTransaction(trx, async (tx) => {
    const row = await requireProblemRow(tenantId, problemTicketId, tx, true);

    if (row.kb_article_id !== null) {
      throw new AppError(409, 'This known error already has a knowledge base article', {
        code: 'conflict',
        payload: { kbArticleId: row.kb_article_id },
      });
    }

    const header = await loadTicketHeader(tenantId, problemTicketId, tx);
    if (!header) throw new AppError(404, 'Problem ticket not found', { code: 'not_found' });

    const slug = (input.slug ?? `known-error-${header.number}`).trim().toLowerCase();
    const locale = (input.locale ?? 'en').trim();
    const title = (input.title ?? '').trim() || header.subject;
    const bodyMd =
      input.bodyMd ??
      [
        row.symptoms_md ? `## Symptoms\n\n${row.symptoms_md}` : null,
        row.workaround_md ? `## Workaround\n\n${row.workaround_md}` : null,
      ]
        .filter((section): section is string => section !== null)
        .join('\n\n');

    const inserted = (await insertScoped(
      'kb_articles',
      tenantId,
      {
        slug,
        title,
        body_md: bodyMd,
        locale,
        status: 'draft',
        tags: ['known-error'],
        author_id: actor.userId ?? null,
      },
      tx,
    ).returning('id')) as unknown as Array<{ id: number }>;

    const kbArticleId = inserted[0]?.id;
    if (!kbArticleId) throw new AppError(500, 'The knowledge base article could not be created');

    const updated = (await scoped('problems', tenantId, tx)
      .where('problems.ticket_id', problemTicketId)
      .where('problems.row_version', input.baseRowVersion)
      .update({
        kb_article_id: kbArticleId,
        row_version: tx.raw('row_version + 1'),
        updated_at: tx.fn.now(),
      })
      .returning('*')) as unknown as ProblemRow[];

    if (updated.length === 0) {
      throw new ProblemVersionConflictError(await requireProblem(tenantId, problemTicketId, tx), [
        'kbArticleId',
      ]);
    }

    await withDecision(
      decisionContext(tenantId, problemTicketId, PROBLEM_DECISIONS.kbArticleCreated, actor, tx, {
        articleSlug: slug,
      }),
      async (recorder) => {
        recorder.outcome({ kbArticleId });
      },
    );

    return { problem: await requireProblem(tenantId, problemTicketId, tx), kbArticleId };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Root-cause analyses
// ═════════════════════════════════════════════════════════════════════════════

/** Newest first. A superseded analysis is returned exactly as it was concluded. */
export async function listAnalyses(
  tenantId: number,
  problemTicketId: number,
  executor: Executor = db,
): Promise<ProblemAnalysisWithCauses[]> {
  assertTenantId(tenantId);

  const rows = (await scoped('problem_analyses', tenantId, executor)
    .where('problem_analyses.problem_ticket_id', problemTicketId)
    .orderBy('problem_analyses.started_at', 'desc')
    .orderBy('problem_analyses.id', 'desc')
    .select('problem_analyses.*')) as unknown as AnalysisRow[];

  const analyses: ProblemAnalysisWithCauses[] = [];
  for (const row of rows) analyses.push(await hydrateAnalysis(tenantId, row, executor));
  return analyses;
}

/**
 * Open a new analysis.
 *
 * The previous current one is SUPERSEDED, never rewritten. "We concluded it was
 * the network; it was the connection pool" is the most valuable row in a
 * post-mortem, and mutating a single analysis in place deletes it.
 * `problem_analyses_current_uq` (partial unique on `is_current`) is what makes
 * the flip safe under concurrency.
 */
export async function createAnalysis(
  tenantId: number,
  actor: ActorContext,
  problemTicketId: number,
  input: CreateProblemAnalysisRequest,
  trx?: Knex.Transaction,
): Promise<ProblemAnalysisWithCauses> {
  assertTenantId(tenantId);

  return inTransaction(trx, async (tx) => {
    await requireProblemRow(tenantId, problemTicketId, tx, true);

    await scoped('problem_analyses', tenantId, tx)
      .where('problem_analyses.problem_ticket_id', problemTicketId)
      .where('problem_analyses.is_current', true)
      .update({
        state: 'superseded' satisfies ProblemAnalysisState,
        is_current: false,
        row_version: tx.raw('row_version + 1'),
        updated_at: tx.fn.now(),
      });

    const inserted = (await insertScoped(
      'problem_analyses',
      tenantId,
      {
        problem_ticket_id: problemTicketId,
        title: input.title ?? null,
        method: input.method ?? 'five_whys',
        state: 'draft' satisfies ProblemAnalysisState,
        facilitator_id: input.facilitatorId ?? null,
        is_current: true,
      },
      tx,
    ).returning('*')) as unknown as AnalysisRow[];

    return hydrateAnalysis(tenantId, inserted[0], tx);
  });
}

/**
 * Autosave on an analysis. Validates nothing (HARD RULE 12).
 *
 * `rootCauseId` is the one exception, and it is referential rather than a
 * completeness check: `problem_analyses.root_cause_id` deliberately carries no
 * foreign key (see the column comment in migration 006), so electing a node
 * from a different analysis would be a dangling pointer nothing else would ever
 * catch.
 */
export async function updateAnalysis(
  tenantId: number,
  actor: ActorContext,
  analysisId: number,
  input: UpdateProblemAnalysisRequest,
  trx?: Knex.Transaction,
): Promise<ProblemAnalysisWithCauses> {
  assertTenantId(tenantId);

  return inTransaction(trx, async (tx) => {
    const current = await loadAnalysisRow(tenantId, analysisId, tx, true);
    if (!current) throw new AppError(404, 'Analysis not found', { code: 'not_found' });
    assertAnalysisEditable(current);

    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.method !== undefined) patch.method = input.method;
    if (input.conclusionMd !== undefined) patch.conclusion_md = input.conclusionMd;

    if (input.rootCauseId !== undefined) {
      if (input.rootCauseId !== null) {
        const owned = await scoped('problem_causes', tenantId, tx)
          .where('problem_causes.id', input.rootCauseId)
          .where('problem_causes.analysis_id', analysisId)
          .first('problem_causes.id');
        if (!owned) {
          throw new AppError(400, 'That cause does not belong to this analysis', {
            code: 'validation_failed',
          });
        }
      }
      patch.root_cause_id = input.rootCauseId;
    }

    if (Object.keys(patch).length === 0) {
      return hydrateAnalysis(tenantId, current, tx);
    }

    const updated = (await scoped('problem_analyses', tenantId, tx)
      .where('problem_analyses.id', analysisId)
      .where('problem_analyses.row_version', input.baseRowVersion)
      .update({ ...patch, row_version: tx.raw('row_version + 1'), updated_at: tx.fn.now() })
      .returning('*')) as unknown as AnalysisRow[];

    if (updated.length === 0) {
      throw versionConflict('analysis', await hydrateAnalysis(tenantId, current, tx));
    }

    return hydrateAnalysis(tenantId, updated[0], tx);
  });
}

/**
 * THE completeness gate of the RCA workshop.
 *
 * `evaluateAnalysisTransition` is the shared function; the client runs it to
 * grey the button out and list what is missing, and this is the same call with
 * the same inputs. The `problem_analyses_concluded_ck` CHECK behind it is the
 * last line of defence, not the first.
 */
export async function changeAnalysisState(
  tenantId: number,
  actor: ActorContext,
  analysisId: number,
  input: ChangeProblemAnalysisStateRequest,
  trx?: Knex.Transaction,
): Promise<ProblemAnalysisWithCauses> {
  assertTenantId(tenantId);

  if (!isProblemAnalysisState(input.toState)) {
    throw new AppError(400, 'Unknown analysis state', { code: 'validation_failed' });
  }

  return inTransaction(trx, async (tx) => {
    const current = await loadAnalysisRow(tenantId, analysisId, tx, true);
    if (!current) throw new AppError(404, 'Analysis not found', { code: 'not_found' });

    const analysis = mapAnalysisRow(current);
    const causes = await loadCauses(tenantId, analysisId, tx);

    const evaluation = evaluateAnalysisTransition({
      analysis: { state: analysis.state, rootCauseId: analysis.rootCauseId },
      causes: causes.map(toCauseSnapshot),
      toState: input.toState,
      rootCauseId: input.rootCauseId,
      actor: actorGate(actor),
    });

    // `problem_analyses_concluded_ck` demands a named human. The shared
    // evaluator has no way to know the actor is an automation, so the guard
    // lives here: a machine may drive an analysis, it may not sign one off.
    if (input.toState === 'concluded' && !actor.userId) {
      evaluation.blockers.push({
        code: 'analysis_needs_human',
        key: 'problem.analysisBlocked.needsHuman',
        fallback: 'A person has to conclude an analysis. An automation can only prepare one.',
      });
      evaluation.allowed = false;
    }

    if (!evaluation.allowed) {
      throw new ProblemGateError('This analysis cannot move to that state yet', evaluation);
    }

    const rootCauseId = input.rootCauseId ?? analysis.rootCauseId ?? null;
    const patch: Record<string, unknown> = {
      state: input.toState,
      row_version: tx.raw('row_version + 1'),
      updated_at: tx.fn.now(),
    };
    if (input.conclusionMd !== undefined) patch.conclusion_md = input.conclusionMd;

    if (input.toState === 'concluded') {
      patch.root_cause_id = rootCauseId;
      patch.concluded_at = tx.fn.now();
      patch.concluded_by = actor.userId;
    }
    // A superseded or abandoned analysis stops being the current one; the
    // partial unique index then leaves the slot free for the next attempt.
    if (input.toState === 'superseded' || input.toState === 'abandoned') {
      patch.is_current = false;
    }

    const updated = (await scoped('problem_analyses', tenantId, tx)
      .where('problem_analyses.id', analysisId)
      .where('problem_analyses.row_version', input.baseRowVersion)
      .update(patch)
      .returning('*')) as unknown as AnalysisRow[];

    if (updated.length === 0) {
      throw versionConflict('analysis', await hydrateAnalysis(tenantId, current, tx));
    }

    if (input.toState !== 'concluded') {
      return hydrateAnalysis(tenantId, updated[0], tx);
    }

    // Concluding an RCA makes the problem a known-error CANDIDATE, never a
    // published known error: publishing needs a workaround somebody re-read,
    // and that is a separate, human, gated act.
    const problemRow = await requireProblemRow(tenantId, analysis.problemTicketId, tx, true);
    let knownErrorState = problemRow.known_error_state as KnownErrorState;
    if (knownErrorState === 'none') {
      knownErrorState = 'candidate';
      await scoped('problems', tenantId, tx)
        .where('problems.ticket_id', analysis.problemTicketId)
        .update({
          known_error_state: knownErrorState,
          row_version: tx.raw('row_version + 1'),
          updated_at: tx.fn.now(),
        });
    }

    const root = causes.find((cause) => cause.id === rootCauseId) ?? null;

    await withDecision(
      decisionContext(
        tenantId,
        analysis.problemTicketId,
        PROBLEM_DECISIONS.analysisConcluded,
        actor,
        tx,
        { analysisId, method: analysis.method, causeCount: causes.length },
      ),
      async (recorder) => {
        recorder.outcome({
          rootCauseId,
          category: root?.category ?? null,
          confirmationMethod: root?.confirmationMethod ?? null,
          knownErrorState,
        });
      },
    );

    return hydrateAnalysis(tenantId, updated[0], tx);
  });
}

/**
 * A superseded or abandoned analysis is history and is frozen. A concluded one
 * stays editable on purpose: correcting a typo in the conclusion is a normal
 * act, and the one thing that must not move is the elected root itself, which
 * `deleteCause` protects.
 */
function assertAnalysisEditable(row: AnalysisRow): void {
  if (row.state === 'superseded' || row.state === 'abandoned') {
    throw new AppError(422, 'This analysis is closed and can no longer be edited', {
      code: 'transition_blocked',
      payload: { state: row.state },
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — The cause tree
// ═════════════════════════════════════════════════════════════════════════════

/** Every node of an analysis, as raw rows, for the in-memory tree walks. */
async function loadCauseRows(
  tenantId: number,
  analysisId: number,
  executor: Executor,
): Promise<CauseRow[]> {
  return (await scoped('problem_causes', tenantId, executor)
    .where('problem_causes.analysis_id', analysisId)
    .select('problem_causes.*')) as unknown as CauseRow[];
}

/** Ids of a node and everything under it. Walked in memory: an analysis is dozens of nodes. */
function subtreeIds(rows: readonly CauseRow[], rootId: number): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const row of rows) {
    const parent = row.parent_cause_id === null ? 0 : int(row.parent_cause_id);
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(int(row.id));
    else childrenOf.set(parent, [int(row.id)]);
  }

  const collected: number[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as number;
    collected.push(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return collected;
}

/**
 * Add a node.
 *
 * `depth` is derived server-side from the parent and never trusted from the
 * client: a client-supplied depth is how a fishbone rib ends up claiming to be
 * a first why, and the cause report reads depth.
 */
export async function createCause(
  tenantId: number,
  actor: ActorContext,
  analysisId: number,
  input: CreateProblemCauseRequest,
  trx?: Knex.Transaction,
): Promise<ProblemCause> {
  assertTenantId(tenantId);

  const statement = (input.statement ?? '').trim();
  if (statement === '') {
    throw new AppError(400, 'A cause needs a statement', { code: 'validation_failed' });
  }

  return inTransaction(trx, async (tx) => {
    const analysis = await loadAnalysisRow(tenantId, analysisId, tx);
    if (!analysis) throw new AppError(404, 'Analysis not found', { code: 'not_found' });
    assertAnalysisEditable(analysis);

    let depth = 0;
    if (input.parentCauseId !== null && input.parentCauseId !== undefined) {
      const parent = (await scoped('problem_causes', tenantId, tx)
        .where('problem_causes.id', input.parentCauseId)
        .where('problem_causes.analysis_id', analysisId)
        .first('problem_causes.id', 'problem_causes.depth')) as
        | { id: number | string; depth: number | string }
        | undefined;
      if (!parent) {
        throw new AppError(400, 'That parent cause does not belong to this analysis', {
          code: 'validation_failed',
        });
      }
      depth = int(parent.depth) + 1;
    }

    if (depth > MAX_CAUSE_DEPTH) {
      throw new AppError(
        400,
        `A cause chain stops at ${MAX_CAUSE_DEPTH} levels. Split the analysis instead of digging deeper.`,
        { code: 'validation_failed' },
      );
    }

    // Append by default, so a new node lands where the agent is looking.
    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
      const siblings = scoped('problem_causes', tenantId, tx).where(
        'problem_causes.analysis_id',
        analysisId,
      );
      if (input.parentCauseId === null || input.parentCauseId === undefined) {
        siblings.whereNull('problem_causes.parent_cause_id');
      } else {
        siblings.where('problem_causes.parent_cause_id', input.parentCauseId);
      }
      const rows = (await siblings.max({ max: 'sort_order' })) as unknown as Array<{
        max: number | string | null;
      }>;
      sortOrder = int(rows[0]?.max, -1) + 1;
    }

    const inserted = (await insertScoped(
      'problem_causes',
      tenantId,
      {
        analysis_id: analysisId,
        parent_cause_id: input.parentCauseId ?? null,
        depth,
        sort_order: sortOrder,
        category: input.category ?? 'unknown',
        statement,
        detail_md: input.detailMd ?? null,
        kind: input.kind ?? 'cause',
        created_by: actor.userId ?? null,
      },
      tx,
    ).returning('*')) as unknown as CauseRow[];

    return mapCauseRow(inserted[0], 0);
  });
}

/**
 * Edit or move a node.
 *
 * Re-parenting is the only interesting part, and it has three invariants:
 *
 *   1. the new parent belongs to the same analysis (no cross-analysis grafts);
 *   2. the new parent is not the node itself nor one of its descendants, which
 *      would detach the subtree from the tree and leave a cycle unreachable
 *      from any root. `problem_causes_parent_ck` only stops self-parenting; a
 *      two-node cycle is invisible to it;
 *   3. the deepest node of the moved subtree still fits under the cap, checked
 *      BEFORE anything is written so a refused move changes nothing.
 */
export async function updateCause(
  tenantId: number,
  actor: ActorContext,
  causeId: number,
  input: UpdateProblemCauseRequest,
  trx?: Knex.Transaction,
): Promise<ProblemCause> {
  assertTenantId(tenantId);

  return inTransaction(trx, async (tx) => {
    const current = (await scoped('problem_causes', tenantId, tx)
      .where('problem_causes.id', causeId)
      .forUpdate()
      .first('problem_causes.*')) as CauseRow | undefined;
    if (!current) throw new AppError(404, 'Cause not found', { code: 'not_found' });

    const analysis = await loadAnalysisRow(tenantId, current.analysis_id, tx);
    if (!analysis) throw new AppError(404, 'Analysis not found', { code: 'not_found' });
    assertAnalysisEditable(analysis);

    const patch: Record<string, unknown> = {};
    if (input.category !== undefined) patch.category = input.category;
    if (input.detailMd !== undefined) patch.detail_md = input.detailMd;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;
    if (input.statement !== undefined) {
      const statement = input.statement.trim();
      if (statement === '') {
        throw new AppError(400, 'A cause needs a statement', { code: 'validation_failed' });
      }
      patch.statement = statement;
    }

    let depthShift = 0;
    let movedSubtree: number[] = [];

    if (input.parentCauseId !== undefined) {
      const rows = await loadCauseRows(tenantId, current.analysis_id, tx);
      movedSubtree = subtreeIds(rows, causeId);

      let newDepth = 0;
      if (input.parentCauseId !== null) {
        if (input.parentCauseId === causeId || movedSubtree.includes(input.parentCauseId)) {
          throw new AppError(400, 'A cause cannot be moved under itself', {
            code: 'validation_failed',
          });
        }
        const parent = rows.find((row) => int(row.id) === input.parentCauseId);
        if (!parent) {
          throw new AppError(400, 'That parent cause does not belong to this analysis', {
            code: 'validation_failed',
          });
        }
        newDepth = int(parent.depth) + 1;
      }

      depthShift = newDepth - int(current.depth);
      const deepest = Math.max(
        ...movedSubtree.map((id) => {
          const row = rows.find((candidate) => int(candidate.id) === id);
          return row ? int(row.depth) : 0;
        }),
      );
      if (deepest + depthShift > MAX_CAUSE_DEPTH) {
        throw new AppError(
          400,
          `That move would push part of the chain past ${MAX_CAUSE_DEPTH} levels.`,
          { code: 'validation_failed' },
        );
      }

      patch.parent_cause_id = input.parentCauseId;
      patch.depth = newDepth;
    }

    if (Object.keys(patch).length === 0) {
      return mapCauseRow(current);
    }

    const updated = (await scoped('problem_causes', tenantId, tx)
      .where('problem_causes.id', causeId)
      .where('problem_causes.row_version', input.baseRowVersion)
      .update({ ...patch, row_version: tx.raw('row_version + 1'), updated_at: tx.fn.now() })
      .returning('*')) as unknown as CauseRow[];

    if (updated.length === 0) {
      throw versionConflict('cause', mapCauseRow(current));
    }

    // The descendants follow the node. Their own row_version is bumped because
    // their depth genuinely changed, and an editor holding a stale copy of a
    // moved child should rebase rather than write a stale depth back.
    const descendants = movedSubtree.filter((id) => id !== causeId);
    if (depthShift !== 0 && descendants.length > 0) {
      await scoped('problem_causes', tenantId, tx)
        .whereIn('problem_causes.id', descendants)
        .update({
          depth: tx.raw('depth + ?', [depthShift]),
          row_version: tx.raw('row_version + 1'),
          updated_at: tx.fn.now(),
        });
    }

    return mapCauseRow(updated[0]);
  });
}

/**
 * Delete a node and everything under it.
 *
 * The one refusal: the elected root of a CONCLUDED analysis. There is no
 * foreign key doing this (see the `root_cause_id` column comment in 006), so
 * deleting it would leave the conclusion pointing at nothing and
 * `problem_analyses_concluded_ck` would only notice at the next write. On a
 * still-open analysis the election is simply cleared with the node, in the same
 * transaction, so the pointer is never dangling either way.
 */
export async function deleteCause(
  tenantId: number,
  actor: ActorContext,
  causeId: number,
  trx?: Knex.Transaction,
): Promise<number> {
  assertTenantId(tenantId);

  return inTransaction(trx, async (tx) => {
    const current = (await scoped('problem_causes', tenantId, tx)
      .where('problem_causes.id', causeId)
      .first('problem_causes.*')) as CauseRow | undefined;
    if (!current) return 0;

    const analysis = await loadAnalysisRow(tenantId, current.analysis_id, tx, true);
    if (!analysis) throw new AppError(404, 'Analysis not found', { code: 'not_found' });
    if (analysis.state === 'superseded' || analysis.state === 'abandoned') {
      assertAnalysisEditable(analysis);
    }

    const isElectedRoot = analysis.root_cause_id !== null && int(analysis.root_cause_id) === causeId;
    if (isElectedRoot && analysis.state === 'concluded') {
      throw new AppError(
        422,
        'This node is the concluded root cause. Reopen the analysis before deleting it.',
        { code: 'transition_blocked', payload: { analysisId: analysis.id } },
      );
    }

    const rows = await loadCauseRows(tenantId, current.analysis_id, tx);
    const doomed = subtreeIds(rows, causeId);

    // Clear the election first: the column has no FK, so nothing else would.
    if (analysis.root_cause_id !== null && doomed.includes(int(analysis.root_cause_id))) {
      await scoped('problem_analyses', tenantId, tx)
        .where('problem_analyses.id', analysis.id)
        .update({ root_cause_id: null, row_version: tx.raw('row_version + 1'), updated_at: tx.fn.now() });
    }

    // The children and their evidence go with it, by CASCADE.
    await scoped('problem_causes', tenantId, tx).where('problem_causes.id', causeId).del();
    return doomed.length;
  });
}

/**
 * Confirm, refute or demote a cause.
 *
 * The gate is the shared `evaluateCauseConfirmation`: `confirmed` and `refuted`
 * cost a piece of evidence on file, a named method and a named human. Without
 * all three, `confidence` becomes a checkbox inside a week.
 *
 * A demotion back to `suspected` or `probable` CLEARS the confirmation stamp.
 * Leaving `confirmed_by` on a node nobody stands behind any more is a lie the
 * cause report would then publish.
 */
export async function confirmCause(
  tenantId: number,
  actor: ActorContext,
  causeId: number,
  input: ConfirmProblemCauseRequest,
  trx?: Knex.Transaction,
): Promise<ProblemCause> {
  assertTenantId(tenantId);

  return inTransaction(trx, async (tx) => {
    const current = (await scoped('problem_causes', tenantId, tx)
      .where('problem_causes.id', causeId)
      .forUpdate()
      .first('problem_causes.*')) as CauseRow | undefined;
    if (!current) throw new AppError(404, 'Cause not found', { code: 'not_found' });

    const analysis = await loadAnalysisRow(tenantId, current.analysis_id, tx);
    if (!analysis) throw new AppError(404, 'Analysis not found', { code: 'not_found' });
    assertAnalysisEditable(analysis);

    const evidence = (await scoped('problem_cause_evidence', tenantId, tx)
      .where('problem_cause_evidence.cause_id', causeId)
      .select('problem_cause_evidence.id')) as unknown as Array<{ id: number | string }>;
    const evidenceIds = evidence.map((row) => int(row.id));

    const confirming = input.confidence === 'confirmed' || input.confidence === 'refuted';
    const method = input.confirmationMethod ?? null;

    const evaluation = evaluateCauseConfirmation({
      cause: {
        kind: current.kind as CauseKind,
        evidenceCount: evidenceIds.length,
        statement: String(current.statement ?? ''),
      },
      toConfidence: input.confidence,
      confirmationMethod: method,
      // An automation actor carries no user id, and the evaluator refuses on
      // that alone: a machine may propose a cause, it may never confirm one.
      confirmedBy: actor.userId ?? null,
      actor: actorGate(actor),
    });

    if (!evaluation.allowed) {
      throw new ProblemGateError('This cause cannot be confirmed yet', evaluation);
    }

    const patch: Record<string, unknown> = {
      confidence: input.confidence,
      confirmation_method: confirming ? method : null,
      confirmed_at: confirming ? tx.fn.now() : null,
      confirmed_by: confirming ? actor.userId : null,
      row_version: tx.raw('row_version + 1'),
      updated_at: tx.fn.now(),
    };

    const updated = (await scoped('problem_causes', tenantId, tx)
      .where('problem_causes.id', causeId)
      .where('problem_causes.row_version', input.baseRowVersion)
      .update(patch)
      .returning('*')) as unknown as CauseRow[];

    if (updated.length === 0) {
      throw versionConflict('cause', mapCauseRow(current, evidenceIds.length));
    }

    const cause = mapCauseRow(updated[0], evidenceIds.length);

    await withDecision(
      decisionContext(
        tenantId,
        analysis.problem_ticket_id,
        PROBLEM_DECISIONS.causeConfirmed,
        actor,
        tx,
        { causeId, method, evidenceIds },
      ),
      async (recorder) => {
        recorder.outcome({ confidence: cause.confidence, confirmedBy: cause.confirmedBy });
        if (!confirming) recorder.noop('confidence_demoted');
      },
    );

    return cause;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Evidence
// ═════════════════════════════════════════════════════════════════════════════

/** The seven targets, and the tenant-scoped table each one must exist in. */
const EVIDENCE_TARGETS: ReadonlyArray<{
  type: ProblemEvidenceType;
  column: string;
  table: string | null;
  idColumn: string;
}> = [
  { type: 'ticket_evidence', column: 'ticket_evidence_id', table: 'ticket_evidence', idColumn: 'id' },
  { type: 'ci', column: 'ci_id', table: 'cis', idColumn: 'id' },
  { type: 'alert', column: 'alert_id', table: 'suite_alerts', idColumn: 'id' },
  { type: 'ticket', column: 'ticket_id', table: 'tickets', idColumn: 'id' },
  { type: 'journal', column: 'journal_id', table: 'ticket_journal', idColumn: 'id' },
  { type: 'kb_article', column: 'kb_article_id', table: 'kb_articles', idColumn: 'id' },
  { type: 'external', column: 'external_url', table: null, idColumn: '' },
];

/**
 * Attach an artefact that already exists. We point, we never copy.
 *
 * A SCREENSHOT is not one of these seven: it is an `attachment_links` row with
 * `entity_type = 'problem_cause'`, so HARD RULE 9 keeps its single refcount and
 * the blob still dies with its last link.
 *
 * Attaching the same artefact twice attaches it once: the partial unique
 * indexes say so, and the pre-check turns what would be a 23505 into the
 * idempotent answer the button implies.
 */
export async function addCauseEvidence(
  tenantId: number,
  actor: ActorContext,
  causeId: number,
  input: AddProblemCauseEvidenceRequest,
  trx?: Knex.Transaction,
): Promise<ProblemCauseEvidence> {
  assertTenantId(tenantId);

  return inTransaction(trx, async (tx) => {
    const cause = (await scoped('problem_causes', tenantId, tx)
      .where('problem_causes.id', causeId)
      .first('problem_causes.id', 'problem_causes.analysis_id')) as
      | { id: number | string; analysis_id: number }
      | undefined;
    if (!cause) throw new AppError(404, 'Cause not found', { code: 'not_found' });

    const supplied: Record<string, unknown> = {
      ticket_evidence_id: input.ticketEvidenceId ?? null,
      ci_id: input.ciId ?? null,
      alert_id: input.alertId ?? null,
      ticket_id: input.ticketId ?? null,
      journal_id: input.journalId ?? null,
      kb_article_id: input.kbArticleId ?? null,
      external_url: blank(input.externalUrl) ? null : (input.externalUrl as string).trim(),
    };

    const present = EVIDENCE_TARGETS.filter((target) => supplied[target.column] !== null);
    if (present.length !== 1) {
      throw new AppError(400, 'A piece of evidence points at exactly one artefact', {
        code: 'validation_failed',
      });
    }

    const target = present[0];
    if (target.type !== input.evidenceType) {
      throw new AppError(400, 'The evidence type does not match the artefact supplied', {
        code: 'validation_failed',
      });
    }

    // Tenancy is proven by looking the artefact up THROUGH `scoped()`. A link
    // built from an id nobody checked is how a row ends up pointing across
    // tenants, and this table holds six of them.
    if (target.table !== null) {
      const found = await scoped(target.table, tenantId, tx)
        .where(`${target.table}.${target.idColumn}`, supplied[target.column] as number)
        .first(`${target.table}.${target.idColumn}`);
      if (!found) {
        throw new AppError(404, 'That artefact does not exist in this tenant', {
          code: 'not_found',
        });
      }
    }

    const existing = (await scoped('problem_cause_evidence', tenantId, tx)
      .where('problem_cause_evidence.cause_id', causeId)
      .where(`problem_cause_evidence.${target.column}`, supplied[target.column] as never)
      .first('problem_cause_evidence.*')) as EvidenceRow | undefined;
    if (existing) return mapEvidenceRow(existing);

    const inserted = (await insertScoped(
      'problem_cause_evidence',
      tenantId,
      {
        cause_id: causeId,
        evidence_type: input.evidenceType,
        ...supplied,
        note: input.note ?? null,
        added_by: actor.userId ?? null,
      },
      tx,
    ).returning('*')) as unknown as EvidenceRow[];

    return mapEvidenceRow(inserted[0]);
  });
}

/**
 * Detach evidence.
 *
 * Removing the LAST piece of evidence from a confirmed or refuted cause would
 * silently invalidate the confirmation the shared evaluator demanded. It is
 * refused rather than cascaded: demoting somebody's conclusion as a side effect
 * of a delete button is exactly the kind of quiet mutation that makes a team
 * stop trusting the record.
 */
export async function removeCauseEvidence(
  tenantId: number,
  evidenceId: number,
  trx?: Knex.Transaction,
): Promise<number> {
  assertTenantId(tenantId);

  return inTransaction(trx, async (tx) => {
    const evidence = (await scoped('problem_cause_evidence', tenantId, tx)
      .where('problem_cause_evidence.id', evidenceId)
      .first('problem_cause_evidence.*')) as EvidenceRow | undefined;
    if (!evidence) return 0;

    const cause = (await scoped('problem_causes', tenantId, tx)
      .where('problem_causes.id', int(evidence.cause_id))
      .first('problem_causes.id', 'problem_causes.confidence')) as
      | { id: number | string; confidence: string }
      | undefined;

    if (cause && (cause.confidence === 'confirmed' || cause.confidence === 'refuted')) {
      const rows = (await scoped('problem_cause_evidence', tenantId, tx)
        .where('problem_cause_evidence.cause_id', int(evidence.cause_id))
        .count<{ count: string }[]>('problem_cause_evidence.id as count')) as unknown as Array<{
        count: string;
      }>;
      if (int(rows[0]?.count) <= 1) {
        throw new AppError(
          422,
          'This is the only evidence behind a confirmed cause. Lower the confidence first.',
          {
            code: 'transition_blocked',
            payload: {
              blockers: [
                {
                  code: 'cause_last_evidence',
                  key: 'problem.causeBlocked.lastEvidence',
                  fallback:
                    'This is the only evidence behind a confirmed cause. Lower the confidence first.',
                  refs: [int(cause.id)],
                },
              ] satisfies ProblemRequirement[],
            },
          },
        );
      }
    }

    return scoped('problem_cause_evidence', tenantId, tx)
      .where('problem_cause_evidence.id', evidenceId)
      .del();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — Alert signatures
// ═════════════════════════════════════════════════════════════════════════════

export async function listAlertSignatures(
  tenantId: number,
  problemTicketId: number,
  executor: Executor = db,
): Promise<ProblemAlertSignature[]> {
  assertTenantId(tenantId);
  const rows = (await scoped('problem_alert_signatures', tenantId, executor)
    .where('problem_alert_signatures.problem_ticket_id', problemTicketId)
    .orderBy('problem_alert_signatures.id', 'asc')
    .select('problem_alert_signatures.*')) as unknown as SignatureRow[];
  return rows.map(mapSignatureRow);
}

/**
 * Declare a machine key equivalent to this known error.
 *
 * `suite_alerts.ticket_id` cannot stand in for this: it names the ticket ONE
 * alert opened, not the keys an engineer decided mean the same fault.
 */
export async function addAlertSignature(
  tenantId: number,
  actor: ActorContext,
  problemTicketId: number,
  input: AddProblemAlertSignatureRequest,
  trx?: Knex.Transaction,
): Promise<ProblemAlertSignature> {
  assertTenantId(tenantId);

  const sourceApp = (input.sourceApp ?? '').trim();
  const dedupeKey = (input.dedupeKey ?? '').trim();
  if (sourceApp === '' || dedupeKey === '') {
    throw new AppError(400, 'A signature needs a source app and a dedupe key', {
      code: 'validation_failed',
    });
  }

  return inTransaction(trx, async (tx) => {
    await requireProblemRow(tenantId, problemTicketId, tx);

    const existing = (await scoped('problem_alert_signatures', tenantId, tx)
      .where('problem_alert_signatures.problem_ticket_id', problemTicketId)
      .where('problem_alert_signatures.source_app', sourceApp)
      .where('problem_alert_signatures.dedupe_key', dedupeKey)
      .first('problem_alert_signatures.*')) as SignatureRow | undefined;
    if (existing) return mapSignatureRow(existing);

    const inserted = (await insertScoped(
      'problem_alert_signatures',
      tenantId,
      {
        problem_ticket_id: problemTicketId,
        source_app: sourceApp,
        dedupe_key: dedupeKey,
        added_by: actor.userId ?? null,
      },
      tx,
    ).returning('*')) as unknown as SignatureRow[];

    return mapSignatureRow(inserted[0]);
  });
}

export async function removeAlertSignature(
  tenantId: number,
  actor: ActorContext,
  signatureId: number,
  trx?: Knex.Transaction,
): Promise<number> {
  assertTenantId(tenantId);
  return inTransaction(trx, async (tx) =>
    scoped('problem_alert_signatures', tenantId, tx)
      .where('problem_alert_signatures.id', signatureId)
      .del(),
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — Finding a known error from an incident
// ═════════════════════════════════════════════════════════════════════════════

interface SuggestionRow extends TicketHeaderRow {
  /** Which CI the match landed on, so the card can name it. */
  primary_ci_id: number | null;
  symptoms_md: string | null;
  workaround_md: string | null;
  workaround_risk: string | null;
  workaround_verified_at: Date | string | null;
  known_error_published_at: Date | string | null;
  incident_count: number | string;
}

const SUGGESTION_COLUMNS = [
  'tickets.id',
  'tickets.number',
  'tickets.subject',
  'tickets.status_slug',
  'tickets.status_category',
  'tickets.priority_slug',
  'tickets.queue_slug',
  'tickets.assignee_id',
  'tickets.occurred_at',
  'tickets.created_at',
  'tickets.resolved_at',
  'tickets.closed_at',
  'tickets.row_version',
  'tickets.primary_ci_id',
  'problems.symptoms_md',
  'problems.workaround_md',
  'problems.workaround_risk',
  'problems.workaround_verified_at',
  'problems.known_error_published_at',
  'problems.incident_count',
];

function toSuggestion(
  row: SuggestionRow,
  weapon: KnownErrorMatchWeapon,
  strength: number,
  extras: { matchedCiId?: number | null; matchedDedupeKey?: string | null } = {},
): KnownErrorSuggestion {
  const clamped = Math.max(0, Math.min(1, strength));
  return {
    problemTicketId: row.id,
    number: row.number,
    subject: row.subject,
    symptomsMd: row.symptoms_md,
    workaroundMd: row.workaround_md,
    workaroundRisk: (row.workaround_risk as WorkaroundRisk | null) ?? null,
    workaroundVerifiedAt: iso(row.workaround_verified_at),
    knownErrorPublishedAt: iso(row.known_error_published_at),
    incidentCount: int(row.incident_count),
    weapon,
    score: KNOWN_ERROR_WEAPON_WEIGHTS[weapon] * clamped,
    ...extras,
  };
}

/** Published known errors only. `retired` stays readable but is never offered. */
function publishedKnownErrors(tenantId: number, executor: Executor) {
  return scoped('problems', tenantId, executor)
    .join('tickets', 'tickets.id', 'problems.ticket_id')
    .where('tickets.tenant_id', tenantId)
    .whereNull('tickets.deleted_at')
    .where('problems.known_error_state', 'published');
}

/**
 * The intake banner's matcher: three weapons, in decreasing certainty.
 *
 *   CI          1.0  a configuration item is a fact.
 *   dedupe key  1.0  a machine-generated key is a fact.
 *   text        0.5  a resemblance, and capped for it. A wrong textual
 *                    suggestion teaches agents to ignore the banner, and an
 *                    ignored banner is worth less than no banner at all.
 *
 * It reuses the desk's own search stack (`normalizeQuery`, `TS_CONFIG`,
 * `websearch_to_tsquery`, the `%` trigram operator) rather than growing a
 * second one: two search implementations drift, and the one that drifts is
 * always the one nobody looks at.
 */
export async function suggestKnownErrors(
  tenantId: number,
  input: {
    subject: string;
    primaryCiId?: number | null;
    ciIds?: number[];
    sourceApp?: string | null;
    dedupeKey?: string | null;
    excludeTicketId?: number | null;
    limit?: number;
  },
  executor: Executor = db,
): Promise<KnownErrorSuggestion[]> {
  assertTenantId(tenantId);

  const limit = Math.min(20, Math.max(1, Math.trunc(input.limit ?? 5)));
  const best = new Map<number, KnownErrorSuggestion>();

  const keep = (suggestion: KnownErrorSuggestion): void => {
    const existing = best.get(suggestion.problemTicketId);
    if (!existing || suggestion.score > existing.score) best.set(suggestion.problemTicketId, suggestion);
  };

  const exclude = (qb: Knex.QueryBuilder): Knex.QueryBuilder =>
    input.excludeTicketId ? qb.whereNot('tickets.id', input.excludeTicketId) : qb;

  // ── Weapon 1: the configuration item ───────────────────────────────────────
  const ciIds = [...new Set([...(input.ciIds ?? []), input.primaryCiId ?? undefined].filter(
    (value): value is number => typeof value === 'number',
  ))];

  if (ciIds.length > 0) {
    const rows = (await exclude(publishedKnownErrors(tenantId, executor))
      .where((qb) => {
        qb.whereIn('tickets.primary_ci_id', ciIds).orWhereExists((sub) => {
          sub
            .select(1)
            .from('ticket_cis')
            .whereRaw('ticket_cis.ticket_id = problems.ticket_id')
            .where('ticket_cis.tenant_id', tenantId)
            .whereIn('ticket_cis.ci_id', ciIds);
        });
      })
      .orderBy('problems.last_incident_at', 'desc')
      .limit(limit)
      .select(...SUGGESTION_COLUMNS)) as unknown as SuggestionRow[];

    for (const row of rows) {
      keep(toSuggestion(row, 'ci', 1, { matchedCiId: row.primary_ci_id ?? ciIds[0] ?? null }));
    }
  }

  // ── Weapon 2: the curated dedupe key ───────────────────────────────────────
  if (input.sourceApp && input.dedupeKey) {
    const rows = (await exclude(publishedKnownErrors(tenantId, executor))
      .join(
        'problem_alert_signatures',
        'problem_alert_signatures.problem_ticket_id',
        'problems.ticket_id',
      )
      .where('problem_alert_signatures.tenant_id', tenantId)
      .where('problem_alert_signatures.source_app', input.sourceApp.trim())
      .where('problem_alert_signatures.dedupe_key', input.dedupeKey.trim())
      .limit(limit)
      .select(...SUGGESTION_COLUMNS)) as unknown as SuggestionRow[];

    for (const row of rows) {
      keep(toSuggestion(row, 'dedupe_key', 1, { matchedDedupeKey: input.dedupeKey.trim() }));
    }
  }

  // ── Weapon 3: the text, capped ─────────────────────────────────────────────
  const text = normalizeQuery(input.subject);
  if (text) {
    const rows = (await exclude(publishedKnownErrors(tenantId, executor))
      .where((qb) => {
        qb.whereRaw(`problems.search_tsv @@ websearch_to_tsquery('${TS_CONFIG}', unaccent(?))`, [
          text,
        ]);
        if (text.length >= 3) qb.orWhereRaw('tickets.subject % ?', [text]);
      })
      .orderByRaw(
        `(ts_rank_cd(problems.search_tsv, websearch_to_tsquery('${TS_CONFIG}', unaccent(?)), 32) ` +
          '+ similarity(tickets.subject, ?)) DESC',
        [text, text],
      )
      .limit(limit)
      .select(
        ...SUGGESTION_COLUMNS,
        executor.raw(
          `least(1, ts_rank_cd(problems.search_tsv, websearch_to_tsquery('${TS_CONFIG}', unaccent(?)), 32) ` +
            '+ similarity(tickets.subject, ?)) as strength',
          [text, text],
        ),
      )) as unknown as Array<SuggestionRow & { strength: number | string }>;

    for (const row of rows) {
      keep(toSuggestion(row, 'text', Number(row.strength) || 0));
    }
  }

  const suggestions = [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);

  // HARD RULE 2 — a suggestion IS an automated decision about this incident,
  // and this row is what later answers "does the text weapon earn its keep?".
  //
  // A lookup that found NOTHING writes no row, deliberately: `ticket_id` on
  // decision_log serves one ticket's Why drawer, and one "we looked and found
  // nothing" per intake would bury the rows that matter under thousands that
  // do not. The same volumetric ruling the cascade census already makes.
  if (input.excludeTicketId && suggestions.length > 0) {
    for (const suggestion of suggestions) {
      await withDecision(
        decisionContext(
          tenantId,
          input.excludeTicketId,
          PROBLEM_DECISIONS.knownErrorSuggested,
          null,
          executor,
          { weapon: suggestion.weapon, score: suggestion.score },
        ),
        async (recorder) => {
          // `accepted` is unknowable at suggestion time; the acceptance is a
          // later act, and stamping a guess here would poison the metric.
          recorder.outcome({ problemTicketId: suggestion.problemTicketId, accepted: null });
        },
      );
    }
  }

  return suggestions;
}

/**
 * The exact lookup `alert.service` runs AFTER dedupe, so an inbound alert on a
 * known fault can carry the workaround into the incident's first internal note.
 * No fuzziness here at all: a machine key either matches or it does not.
 *
 * The `known_error_matched_on_alert` decision belongs to the caller, which is
 * the only side that knows whether it actually stamped anything.
 */
export async function matchKnownErrorForAlert(
  tenantId: number,
  sourceApp: string,
  dedupeKey: string,
  executor: Executor = db,
): Promise<ProblemWithRelations | null> {
  assertTenantId(tenantId);

  const app = (sourceApp ?? '').trim();
  const key = (dedupeKey ?? '').trim();
  if (app === '' || key === '') return null;

  const row = (await publishedKnownErrors(tenantId, executor)
    .join(
      'problem_alert_signatures',
      'problem_alert_signatures.problem_ticket_id',
      'problems.ticket_id',
    )
    .where('problem_alert_signatures.tenant_id', tenantId)
    .where('problem_alert_signatures.source_app', app)
    .where('problem_alert_signatures.dedupe_key', key)
    .orderBy('problems.last_incident_at', 'desc')
    .first('problems.ticket_id')) as { ticket_id: number } | undefined;

  if (!row) return null;
  return get(tenantId, row.ticket_id, executor);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13 — The closure cascade
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The sentinel written into `CascadeIncidentSnapshot.scheduledFor` when an
 * incident sits in the `scheduled` category and the desk has no instant for it.
 *
 * The shared classifier documents the behaviour this leans on: an UNPARSEABLE
 * instant blocks rather than resolves. A scheduled intervention whose date
 * nobody recorded is precisely the case where "we do not know" must mean "leave
 * it to a human", and a `null` there would have meant "go ahead".
 */
const UNKNOWN_SCHEDULED_INSTANT = 'unknown';

/** Custom-field keys an intake form may use for the planned intervention. */
const SCHEDULED_FIELD_KEYS = ['scheduledFor', 'scheduled_for', 'scheduledAt', 'scheduled_at'];

interface CascadeTicketRow {
  id: number;
  number: string;
  status_category: string;
  row_version: number | string;
  first_response_at: Date | string | null;
  data: Record<string, unknown> | null;
}

/**
 * Turn the linked incidents into the facts the shared classifier reasons over.
 *
 * Guards baked into the query itself, so no later code has to remember them:
 *   • only `caused_by` links pointing AT this problem;
 *   • only record types the cascade may touch. A problem, a change or a release
 *     linked under a problem is never auto-resolved;
 *   • never a soft-deleted ticket;
 *   • ordered by id, deterministically, because the cap slices a PREFIX and a
 *     preview that sliced a different prefix from the pass would be a lie.
 */
async function loadCascadeSnapshots(
  tenantId: number,
  problemTicketId: number,
  executor: Executor,
): Promise<CascadeIncidentSnapshot[]> {
  const rows = (await scoped('ticket_link', tenantId, executor)
    .join('tickets', 'tickets.id', 'ticket_link.from_ticket_id')
    .where('tickets.tenant_id', tenantId)
    .where('ticket_link.to_ticket_id', problemTicketId)
    .where('ticket_link.kind', PROBLEM_LINK_KIND)
    .whereIn('tickets.record_type', CASCADE_ELIGIBLE_RECORD_TYPES as unknown as string[])
    .whereNull('tickets.deleted_at')
    .orderBy('tickets.id', 'asc')
    .select(
      'tickets.id',
      'tickets.number',
      'tickets.status_category',
      'tickets.row_version',
      'tickets.first_response_at',
      'tickets.data',
    )) as unknown as CascadeTicketRow[];

  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [approvals, worked, timed, lastPublic] = await Promise.all([
    openApprovalsByTicket(tenantId, ids, executor),
    agentEntriesByTicket(tenantId, ids, executor),
    timeEntriesByTicket(tenantId, ids, executor),
    lastPublicReplyByTicket(tenantId, ids, executor),
  ]);

  return rows.map((row) => {
    const category = row.status_category as StatusCategory;
    let scheduledFor: string | null = null;
    if (category === 'scheduled') {
      scheduledFor = readScheduledInstant(row.data) ?? UNKNOWN_SCHEDULED_INSTANT;
    }

    return {
      ticketId: row.id,
      number: row.number,
      statusCategory: category,
      rowVersion: int(row.row_version, 1),
      firstResponseAt: iso(row.first_response_at),
      lastPublicReplyBy: lastPublic.get(row.id) ?? null,
      hasOpenApproval: approvals.has(row.id),
      scheduledFor,
      // Same definition the alert recovery already uses: an agent journal entry
      // or logged time. Both mean a human spent their afternoon on this, and
      // auto-resolving deletes that from the record.
      humanTouched: worked.has(row.id) || timed.has(row.id),
    };
  });
}

function readScheduledInstant(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  for (const key of SCHEDULED_FIELD_KEYS) {
    const value = data[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

async function openApprovalsByTicket(
  tenantId: number,
  ticketIds: readonly number[],
  executor: Executor,
): Promise<Set<number>> {
  const rows = (await scoped('approvals', tenantId, executor)
    .whereIn('approvals.ticket_id', ticketIds as number[])
    .where('approvals.state', 'pending')
    .distinct('approvals.ticket_id')) as unknown as Array<{ ticket_id: number }>;
  return new Set(rows.map((row) => row.ticket_id));
}

async function agentEntriesByTicket(
  tenantId: number,
  ticketIds: readonly number[],
  executor: Executor,
): Promise<Set<number>> {
  const rows = (await scoped('ticket_journal', tenantId, executor)
    .whereIn('ticket_journal.ticket_id', ticketIds as number[])
    .whereIn('ticket_journal.kind', ['public_reply', 'work_note'])
    .whereNotNull('ticket_journal.author_id')
    .distinct('ticket_journal.ticket_id')) as unknown as Array<{ ticket_id: number }>;
  return new Set(rows.map((row) => row.ticket_id));
}

async function timeEntriesByTicket(
  tenantId: number,
  ticketIds: readonly number[],
  executor: Executor,
): Promise<Set<number>> {
  const rows = (await scoped('time_entries', tenantId, executor)
    .whereIn('time_entries.ticket_id', ticketIds as number[])
    .distinct('time_entries.ticket_id')) as unknown as Array<{ ticket_id: number }>;
  return new Set(rows.map((row) => row.ticket_id));
}

/**
 * Who spoke last in the PUBLIC conversation.
 *
 * `system` and `automation` entries are excluded rather than counted as an
 * agent: an automatic acknowledgement is not an answer, and letting one
 * overwrite "the requester replied and is waiting" would defeat the guard that
 * matters most.
 */
async function lastPublicReplyByTicket(
  tenantId: number,
  ticketIds: readonly number[],
  executor: Executor,
): Promise<Map<number, 'agent' | 'requester'>> {
  const rows = (await scoped('ticket_journal', tenantId, executor)
    .whereIn('ticket_journal.ticket_id', ticketIds as number[])
    .where('ticket_journal.kind', 'public_reply')
    .where('ticket_journal.visibility', 'public')
    .whereIn('ticket_journal.author_type', ['user', 'portal', 'contact'])
    .orderBy('ticket_journal.ticket_id', 'asc')
    .orderBy('ticket_journal.seq', 'asc')
    .select(
      'ticket_journal.ticket_id',
      'ticket_journal.author_type',
      'ticket_journal.author_contact_id',
    )) as unknown as Array<{
    ticket_id: number;
    author_type: string;
    author_contact_id: number | null;
  }>;

  const last = new Map<number, 'agent' | 'requester'>();
  for (const row of rows) {
    const fromRequester =
      row.author_type === 'portal' || row.author_type === 'contact' || row.author_contact_id !== null;
    last.set(row.ticket_id, fromRequester ? 'requester' : 'agent');
  }
  return last;
}

function emptyOutcome(): ProblemCascadeOutcome {
  return {
    total: 0,
    skippedTerminal: 0,
    blocked: {},
    autoResolved: 0,
    workedNotWaiting: 0,
    truncated: false,
    remaining: 0,
  };
}

/**
 * The dry run. Writes nothing, logs nothing, and produces the SAME shape the
 * real pass returns, because the page that said "12 will be resolved" has to
 * render the same component afterwards saying "12 were resolved".
 */
export async function previewCascade(
  tenantId: number,
  problemTicketId: number,
  policy?: ProblemClosurePolicy,
  executor: Executor = db,
): Promise<ProblemCascadeResult> {
  assertTenantId(tenantId);

  const row = await requireProblemRow(tenantId, problemTicketId, executor);
  const effectivePolicy = policy ?? (row.closure_policy as ProblemClosurePolicy);

  const snapshots = await loadCascadeSnapshots(tenantId, problemTicketId, executor);
  const plan = planClosureCascade(snapshots, effectivePolicy, {
    maxIncidents: LIMITS.problemCascadeMaxIncidents,
  });

  const byId = new Map(snapshots.map((snapshot) => [snapshot.ticketId, snapshot]));

  return {
    problemTicketId,
    policy: effectivePolicy,
    dryRun: true,
    plan,
    outcome: {
      total: plan.total,
      skippedTerminal: plan.skippedTerminal,
      blocked: plan.blockedByReason,
      autoResolved: plan.autoResolved,
      workedNotWaiting: plan.workedNotWaiting,
      truncated: plan.truncated,
      remaining: plan.remaining,
    },
    resolvedTicketIds: [],
    blocked: plan.actionable
      .filter((entry) => entry.bucket === 'blocked_human_waiting' && entry.blockReason !== null)
      .map((entry) => ({
        ticketId: entry.ticketId,
        number: byId.get(entry.ticketId)?.number ?? String(entry.ticketId),
        reason: entry.blockReason as CascadeBlockReason,
      })),
  };
}

/** The incidents a cascade would consider, with their cascade-relevant facts. */
export async function listCascadeIncidents(
  tenantId: number,
  problemTicketId: number,
  executor: Executor = db,
): Promise<CascadeIncidentSnapshot[]> {
  assertTenantId(tenantId);
  return loadCascadeSnapshots(tenantId, problemTicketId, executor);
}

/**
 * The linked incidents the problem page lists, one page at a time.
 *
 * A thin page over `listCascadeIncidents` rather than a second query: the
 * snapshot it builds already carries the facts the cascade classifier keys off,
 * which is exactly what the panel renders next to each incident. Counting them
 * twice under two names would be two places for the same classification to
 * drift, and the one that drifts is always the one nobody reads.
 */
export async function listLinkedIncidents(
  tenantId: number,
  problemTicketId: number,
  query: { page?: number; limit?: number } = {},
  executor: Executor = db,
): Promise<CascadeIncidentSnapshot[]> {
  const all = await listCascadeIncidents(tenantId, problemTicketId, executor);
  const limit = Math.min(PAGINATION.maxLimit, Math.max(1, Math.trunc(query.limit ?? PAGINATION.defaultLimit)));
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  return all.slice((page - 1) * limit, (page - 1) * limit + limit);
}

/**
 * Run the cascade.
 *
 * The order below is the safety argument, and it is deliberate:
 *
 *   1. the WHOLE plan is computed first, by the shared `planClosureCascade`,
 *      before a single row is written. The preview the agent approved and this
 *      pass are the same arithmetic over the same snapshots;
 *   2. only entries the plan marked `resolves` are transitioned. The classifier
 *      never marks a blocked incident, and this function never second-guesses
 *      it in the permissive direction;
 *   3. the target status is looked up by CATEGORY in the incident's OWN state
 *      machine (HARD RULE 5). Two queues may spell "resolved" differently, and
 *      a hard-coded slug would either fail loudly or, worse, land tickets in
 *      the wrong state;
 *   4. `CASCADE_TARGET_CATEGORY` is `resolved`, never `closed`. There is no
 *      path here to a terminal, possibly-unreopenable state: an automation is
 *      allowed to be wrong, it is not allowed to be irreversible;
 *   5. every transition goes through `ticketService.transition()` with guards
 *      ON (no `system: true`). A tenant's own workflow keeps the last word, and
 *      its refusal becomes `transition_refused` rather than a bypass;
 *   6. each incident runs in its OWN savepoint. One failure blocks one
 *      incident; without it a single constraint violation would abort the whole
 *      transaction and the remaining incidents would be silently abandoned
 *      while the census claimed success;
 *   7. `baseRowVersion` is the version read when the plan was built, so a
 *      ticket somebody edited in between becomes `concurrent_edit` instead of
 *      being clobbered (HARD RULE 7);
 *   8. everything above the cap is reported as `truncated` / `remaining`. A
 *      truncation that looks like a completion is the failure nobody catches.
 */
export async function cascadeOnResolve(
  tenantId: number,
  actor: ActorContext,
  problemTicketId: number,
  options: { policy?: ProblemClosurePolicy; trx?: Knex.Transaction } = {},
): Promise<ProblemCascadeResult> {
  assertTenantId(tenantId);

  return inTransaction(options.trx, async (tx) => {
    const row = await requireProblemRow(tenantId, problemTicketId, tx);
    const policy = options.policy ?? (row.closure_policy as ProblemClosurePolicy);

    const problemHeader = await loadTicketHeader(tenantId, problemTicketId, tx);
    const problemNumber = problemHeader?.number ?? String(problemTicketId);

    const snapshots = await loadCascadeSnapshots(tenantId, problemTicketId, tx);
    const plan = planClosureCascade(snapshots, policy, {
      maxIncidents: LIMITS.problemCascadeMaxIncidents,
    });
    const byId = new Map(snapshots.map((snapshot) => [snapshot.ticketId, snapshot]));

    return withDecision(
      decisionContext(tenantId, problemTicketId, PROBLEM_DECISIONS.closureCascade, actor, tx, {
        policy,
        total: plan.total,
      }),
      async (recorder) => {
        const resolvedTicketIds: number[] = [];
        const blocked: Array<{ ticketId: number; number: string; reason: CascadeBlockReason }> = [];
        const blockedByReason: Partial<Record<CascadeBlockReason, number>> = {
          ...plan.blockedByReason,
        };
        const machines = new Map<string, string | null>();

        const noteBlocked = (ticketId: number, number: string, reason: CascadeBlockReason): void => {
          blocked.push({ ticketId, number, reason });
          blockedByReason[reason] = (blockedByReason[reason] ?? 0) + 1;
        };

        for (const entry of plan.actionable) {
          const snapshot = byId.get(entry.ticketId);
          if (!snapshot) continue;

          // ── Already terminal: nothing to do, and no row of its own. The
          // census carries the count; 500 rows saying "we looked and did
          // nothing" would bury the twelve that matter.
          if (entry.bucket === 'skipped_terminal') continue;

          if (entry.bucket === 'blocked_human_waiting' && entry.blockReason !== null) {
            blocked.push({
              ticketId: snapshot.ticketId,
              number: snapshot.number,
              reason: entry.blockReason,
            });
            await notifyIncident(tenantId, actor, snapshot, problemNumber, entry.blockReason, tx);
            await withDecision(
              decisionContext(
                tenantId,
                snapshot.ticketId,
                PROBLEM_DECISIONS.incidentCascadeBlocked,
                actor,
                tx,
                { problemTicketId, policy },
              ),
              async (inner) => {
                inner.outcome({ reason: entry.blockReason });
              },
            );
            continue;
          }

          if (!entry.resolves) {
            // Worked or untouched, but the policy says notify only.
            if (entry.notifies) {
              await notifyIncident(tenantId, actor, snapshot, problemNumber, null, tx);
            }
            continue;
          }

          // ── Resolve, through the state machine, by category ────────────────
          const outcome = await resolveOneIncident(
            tenantId,
            actor,
            problemTicketId,
            problemNumber,
            snapshot,
            entry.bucket,
            machines,
            tx,
          );

          if (outcome.resolved) resolvedTicketIds.push(snapshot.ticketId);
          else noteBlocked(snapshot.ticketId, snapshot.number, outcome.reason);
        }

        const result: ProblemCascadeResult = {
          problemTicketId,
          policy,
          dryRun: false,
          plan,
          outcome: {
            total: plan.total,
            skippedTerminal: plan.skippedTerminal,
            blocked: blockedByReason,
            autoResolved: resolvedTicketIds.length,
            workedNotWaiting: plan.workedNotWaiting,
            truncated: plan.truncated,
            remaining: plan.remaining,
          },
          resolvedTicketIds,
          blocked,
        };

        recorder.outcome({ ...result.outcome });
        return result;
      },
    );
  });
}

/**
 * One incident, in its own savepoint.
 *
 * The savepoint is the whole point: `ticketService.transition()` runs guards,
 * hooks and a journal append, any of which can raise. Without a savepoint the
 * first failure would abort the enclosing transaction and every later statement
 * would fail with 25P02 — the census would then claim a pass that never
 * happened, which is worse than a blocked incident.
 */
async function resolveOneIncident(
  tenantId: number,
  actor: ActorContext,
  problemTicketId: number,
  problemNumber: string,
  snapshot: CascadeIncidentSnapshot,
  bucket: string,
  machines: Map<string, string | null>,
  tx: Knex.Transaction,
): Promise<{ resolved: true } | { resolved: false; reason: CascadeBlockReason }> {
  try {
    return await tx.transaction(async (sp) => {
      const ticket = (await scoped('tickets', tenantId, sp)
        .where('tickets.id', snapshot.ticketId)
        .first('tickets.id', 'tickets.queue_slug')) as
        | { id: number; queue_slug: string }
        | undefined;
      if (!ticket) return { resolved: false, reason: 'transition_refused' as CascadeBlockReason };

      // HARD RULE 5 — resolve the SLUG from the tenant's machine by CATEGORY,
      // per queue, cached for the pass. Never a literal.
      let targetSlug = machines.get(ticket.queue_slug);
      if (targetSlug === undefined) {
        // `ticket` here is a raw row (snake_case); the loader reads `queueSlug`.
        // Passing the row straight through compiles away to `undefined` and
        // silently hands every ticket the tenant's DEFAULT machine.
        const machine = await loadStateMachineForTicket(
          tenantId,
          { queueSlug: ticket.queue_slug },
          sp,
        );
        targetSlug = statusForCategory(machine, CASCADE_TARGET_CATEGORY)?.slug ?? null;
        machines.set(ticket.queue_slug, targetSlug);
      }
      if (targetSlug === null) {
        // The queue's workflow has no `resolved` status. Blocking is the only
        // honest answer; inventing one would put tickets in a state the tenant
        // never defined.
        return { resolved: false, reason: 'transition_refused' as CascadeBlockReason };
      }

      await ticketService.transition(
        tenantId,
        actor,
        snapshot.ticketId,
        {
          baseRowVersion: snapshot.rowVersion,
          toStatusSlug: targetSlug,
          resolutionCode: CASCADE_RESOLUTION_CODE,
          resolutionMd: `Resolved by problem ${problemNumber}.`,
          ruleSlug: PROBLEM_ENGINE_SLUG,
          // Guards stay ON. The tenant's own workflow keeps the last word, and
          // a refusal is reported rather than bypassed.
        },
        sp,
      );

      await withDecision(
        decisionContext(
          tenantId,
          snapshot.ticketId,
          PROBLEM_DECISIONS.incidentAutoResolved,
          actor,
          sp,
          { problemTicketId, bucket, baseRowVersion: snapshot.rowVersion },
        ),
        async (recorder) => {
          recorder.outcome({ statusSlug: targetSlug, resolutionCode: CASCADE_RESOLUTION_CODE });
        },
      );

      return { resolved: true as const };
    });
  } catch (error) {
    const reason = cascadeFailureReason(error);
    logger.warn(
      { tenantId, problemTicketId, ticketId: snapshot.ticketId, reason },
      'Problem cascade left an incident to a human',
    );

    // The refusal row is written OUTSIDE the failed savepoint, on the enclosing
    // transaction: a decision row that rolls back with the thing it was
    // explaining explains nothing. Same ruling ticket.service makes for a
    // refused transition.
    await withDecision(
      decisionContext(
        tenantId,
        snapshot.ticketId,
        PROBLEM_DECISIONS.incidentCascadeBlocked,
        actor,
        tx,
        { problemTicketId, bucket, baseRowVersion: snapshot.rowVersion },
      ),
      async (recorder) => {
        recorder.outcome({ reason });
      },
    );

    return { resolved: false, reason };
  }
}

/** Map what went wrong onto the vocabulary the census and the UI already speak. */
function cascadeFailureReason(error: unknown): CascadeBlockReason {
  if (error instanceof ticketService.TicketVersionConflictError) return 'concurrent_edit';
  if (error instanceof ticketService.TransitionRefusedError) return 'transition_refused';
  // Anything else is unknown, and unknown means a human. Never a silent skip.
  return 'transition_refused';
}

/**
 * Tell an incident its problem was fixed, without touching its state.
 *
 * The body is written in English and the structured facts ride in `meta`, so
 * the client renders it through `t(key, fallback)` (HARD RULE 10) instead of
 * parsing a sentence the server chose a locale for.
 */
async function notifyIncident(
  tenantId: number,
  actor: ActorContext,
  snapshot: CascadeIncidentSnapshot,
  problemNumber: string,
  blockReason: CascadeBlockReason | null,
  executor: Knex.Transaction,
): Promise<void> {
  const bodyMd =
    blockReason === null
      ? `The underlying problem ${problemNumber} has been resolved. This ticket was left as it is.`
      : `The underlying problem ${problemNumber} has been resolved, but this ticket still needs a human.`;

  await journalService.append(
    {
      tenantId,
      ticketId: snapshot.ticketId,
      kind: 'automation',
      visibility: 'internal',
      authorId: null,
      authorType: 'system',
      bodyMd,
      meta: {
        ruleSlug: PROBLEM_ENGINE_SLUG,
        ruleVersion: PROBLEM_ENGINE_VERSION,
        problemNumber,
        cascadeBlockReason: blockReason,
        i18nKey: blockReason === null ? 'problem.cascade.notified' : 'problem.cascade.needsHuman',
      },
      // The owner of the transaction emits after its own commit.
      emit: false,
    },
    executor,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 14 — The hook: a problem was resolved
// ═════════════════════════════════════════════════════════════════════════════

export interface ProblemResolvedEvent {
  tenantId: number;
  ticket: { id: number; recordType: string; statusCategory: StatusCategory };
  previous: { statusCategory: StatusCategory } | null;
  actor: ActorContext;
  trx: Knex.Transaction;
}

/**
 * Registered on `ticket.service`'s transition hook.
 *
 * It fires ONCE, on the move into `resolved`, and again on `closed` only when
 * `resolved` was skipped (a tenant whose workflow goes straight from open to
 * closed). Firing on both unconditionally would run the cascade twice; the
 * second pass would find every incident terminal and be harmless, but a census
 * row claiming a second pass happened is evidence of something that did not.
 *
 * It never throws. `ticket.service` wraps hooks so an engine cannot take the
 * ticket down with it, and a problem that fails to close because its cascade
 * hiccuped would be a worse failure than a cascade that did not run.
 */
export async function onProblemResolved(event: ProblemResolvedEvent): Promise<void> {
  const { tenantId, ticket, previous, actor, trx } = event;

  if (ticket.recordType !== 'problem') return;

  const category = ticket.statusCategory;
  const previousCategory = previous?.statusCategory ?? null;
  if (category === previousCategory) return;

  const enteringResolved = category === 'resolved';
  const enteringClosedDirectly = category === 'closed' && previousCategory !== 'resolved';
  if (!enteringResolved && !enteringClosedDirectly) return;

  const row = await loadProblemRow(tenantId, ticket.id, trx, true);
  if (!row) return;

  await cascadeOnResolve(tenantId, actor, ticket.id, { trx });

  // The permanent fix shipped, so the workaround stops being offered. The text
  // stays readable: incidents closed months ago point at it.
  if (row.known_error_state === 'published' || row.known_error_state === 'candidate') {
    await retireKnownError(
      tenantId,
      actor,
      ticket.id,
      // The row was read under `FOR UPDATE` a few statements ago and nothing
      // between here and there touches it, so this IS the version we read.
      { baseRowVersion: int(row.row_version, 1), reason: 'problem_resolved' },
      trx,
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The object form, for callers that want one import
// ═════════════════════════════════════════════════════════════════════════════

export const problemService = {
  get,
  list,
  promote,
  update,
  linkIncidents,
  unlinkIncidents,
  verifyWorkaround,
  publishKnownError,
  retireKnownError,
  publishToKb,
  listAnalyses,
  createAnalysis,
  updateAnalysis,
  changeAnalysisState,
  createCause,
  updateCause,
  deleteCause,
  confirmCause,
  addCauseEvidence,
  removeCauseEvidence,
  listAlertSignatures,
  addAlertSignature,
  removeAlertSignature,
  suggestKnownErrors,
  matchKnownErrorForAlert,
  previewCascade,
  listCascadeIncidents,
  cascadeOnResolve,
  onProblemResolved,
};

export default problemService;
