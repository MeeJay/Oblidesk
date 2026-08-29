/**
 * decision.service.ts — HARD RULE 2, made unavoidable.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  The rule
 * ──────────────────────────────────────────────────────────────────────────
 * Every automated decision — which queue, which priority, which assignee,
 * which SLA policy, which escalation, which approval — writes a `decision_log`
 * row ON THE SAME CODE PATH AND IN THE SAME TRANSACTION as the action it
 * explains. Never in a background sweep, never reconstructed afterwards from
 * the timeline.
 *
 * The reason is not tidiness. A reconstruction is a GUESS: it reads the state
 * that exists now and infers what must have happened. When an operator asks
 * "why is this P1 and why did it land on Marie's queue?", a guess is exactly
 * the answer they must not be given — especially at 3am, especially when the
 * rule that did it has since been edited. The row has to be written by the
 * engine that decided, holding the inputs it actually read and naming the
 * published config object it actually used.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  How this file makes that hard to get wrong
 * ──────────────────────────────────────────────────────────────────────────
 * {@link withDecision} wraps the action. The engine cannot "forget" the log
 * line, because the log line is the wrapper around the work:
 *
 *   const ticket = await withDecision(
 *     { tenantId, ticketId, trx },
 *     'priority',
 *     async (d) => {
 *       d.rule(matrix.slug, matrix.version);
 *       d.inputs({ impact, urgency });
 *       const priority = resolveFromMatrix(matrix, impact, urgency);
 *       d.decide(`priority set to ${priority} (impact=${impact}, urgency=${urgency})`);
 *       d.outcome({ prioritySlug: priority });
 *       return applyPriority(trx, ticket, priority);
 *     },
 *   );
 *
 * A row is written whether the callback returns or throws. A callback that
 * decides nothing still writes a row (`outcome.recorded = false`) — silence is
 * never evidence, and an engine that ran and did nothing is a fact worth
 * keeping.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  Schema notes that matter
 * ──────────────────────────────────────────────────────────────────────────
 * `decision_log.ticket_id` deliberately has NO foreign key. A decision must
 * OUTLIVE a purged or hard-deleted ticket: "why did this ticket exist and what
 * did the machine do to it" is precisely the question asked after the ticket is
 * gone. Do not add the constraint.
 *
 * `rule_slug` + `rule_version` pin the CONFIG OBJECT that decided (HARD RULE 3
 * — by slug, never by numeric id), so the Why drawer can deep-link to the exact
 * published version whose body produced the outcome, even after the object has
 * been edited five times since.
 */

import type { Knex } from 'knex';
import {
  db,
  scoped,
  insertScoped,
  assertTenantId,
  type Executor,
} from '../db';
import type {
  ConditionTrace,
  ConditionIssue,
  ConditionEvaluation,
  DecisionInputs,
  DecisionLogEntry,
  DecisionSubsystem,
  WhyExplanation,
} from '@oblidesk/shared';
import { DECISION_SUBSYSTEMS, describeTrace, PAGINATION } from '@oblidesk/shared';
import { logger } from '../utils/logger';

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

export interface DecisionContext {
  tenantId: number;
  /** NULL for tenant-wide decisions (a rule that matched nothing, a sweep). */
  ticketId?: number | null;
  /**
   * THE transaction the action runs in. Pass it. Without it the decision row
   * commits independently of the change it explains, and a rolled-back action
   * leaves behind a row claiming something happened that did not.
   */
  trx?: Executor;
  /** Stamped into `inputs.actor` — decision_log has no actor column of its own. */
  actorId?: number | null;
  actorType?: string;
  /** Correlation id shared by every decision of one intake / one request. */
  correlationId?: string;
}

export interface DecisionRecordInput {
  tenantId: number;
  ticketId?: number | null;
  subsystem: DecisionSubsystem;
  /** Human one-liner: 'priority set to P2 (impact=medium, urgency=high)'. */
  decision: string;
  inputs?: DecisionInputs;
  /** The published config object that decided — a SLUG (HARD RULE 3). */
  ruleSlug?: string | null;
  ruleVersion?: number | null;
  outcome?: Record<string, unknown>;
  durationMs?: number | null;
  at?: Date;
}

/**
 * The handle an engine uses inside {@link withDecision}. Every setter is
 * chainable and every one of them is optional — but an engine that sets none
 * of them produces a row that says so.
 */
export interface DecisionRecorder {
  /** The human sentence the Why drawer shows as the headline. */
  decide(sentence: string): DecisionRecorder;
  /** Merge into `inputs` — what the engine actually read. */
  inputs(values: DecisionInputs): DecisionRecorder;
  /**
   * Add to `inputs`, either one key at a time or as a patch.
   *
   * The two-form signature is not sugar: the desk engines (ticket, priority,
   * routing) declare their own structural binding to this recorder and call
   * `input({ … })` with a patch. Accepting only `(key, value)` would compile
   * fine on their side — they cast — and then write a row keyed by
   * `"[object Object]"` at runtime, which is the worst kind of bug in a ledger
   * whose entire job is to be trustworthy.
   */
  input(patch: Record<string, unknown>): DecisionRecorder;
  input(key: string, value: unknown): DecisionRecorder;
  /** The config object that decided. Slug + published version. */
  rule(slug: string | null | undefined, version?: number | null): DecisionRecorder;
  /** Attach a condition evaluation: trace + issues, replayable. */
  evaluation(evaluation: ConditionEvaluation): DecisionRecorder;
  trace(trace: ConditionTrace): DecisionRecorder;
  issues(issues: ConditionIssue[]): DecisionRecorder;
  /** Merge into `outcome` — what the engine produced. */
  outcome(values: Record<string, unknown>): DecisionRecorder;
  /** Ran, matched nothing, changed nothing. Still a fact. */
  noop(reason: string): DecisionRecorder;
  /** Loop guard / budget exhausted. */
  suppressed(reason: string): DecisionRecorder;
  /** Re-target the row at a ticket discovered mid-flight (intake creating one). */
  ticket(ticketId: number | null): DecisionRecorder;
}

export interface DecisionListQuery {
  ticketId?: number | null;
  subsystem?: DecisionSubsystem;
  ruleSlug?: string;
  from?: Date | string;
  to?: Date | string;
  page?: number;
  limit?: number;
}

/**
 * The Why drawer's full read: the causal chain plus the LIVE state each entry
 * points at, so the UI can render "SLA paused because the status category is
 * pending_requester" without re-deriving anything.
 */
export interface WhyExplanationDetailed extends WhyExplanation {
  sla: Array<{
    targetSlug: string;
    policySlug: string;
    policyVersion: number;
    calendarSlug: string;
    status: string;
    running: boolean;
    startedAt: string;
    dueAt: string | null;
    pausedMs: number;
    breachedAt: string | null;
    metAt: string | null;
    /** Why the clock is where it is — the last ledger event. */
    lastEvent: { event: string; reasonCode: string | null; at: string; note: string | null } | null;
  }>;
  approvals: Array<{
    id: number;
    definitionSlug: string;
    state: string;
    mode: string;
    quorum: number | null;
    dueAt: string | null;
    /** Steps still pending — what is actually blocking. */
    blockingSteps: Array<{
      stepIndex: number;
      approverUserId: number | null;
      approverGroupId: number | null;
      state: string;
    }>;
  }>;
  /**
   * Rules that were EVALUATED, matched or not. decision_log answers "why did
   * this happen"; rule_executions answers "why did nothing happen", which is
   * the question decision_log alone structurally cannot.
   */
  ruleExecutions: Array<{
    ruleSlug: string;
    ruleVersion: number;
    at: string;
    matched: boolean;
    actions: unknown[];
    error: string | null;
    durationMs: number | null;
    dryRun: boolean;
  }>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Row shapes
// ═════════════════════════════════════════════════════════════════════════════

interface DecisionRow {
  id: string | number;
  tenant_id: number;
  ticket_id: number | null;
  at: Date | string;
  subsystem: string;
  decision: string;
  inputs: DecisionInputs | string | null;
  rule_slug: string | null;
  rule_version: number | null;
  outcome: Record<string, unknown> | string | null;
  duration_ms: number | null;
}

const SUBSYSTEM_SET: ReadonlySet<string> = new Set(DECISION_SUBSYSTEMS);

function toIso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function rowToEntry(row: DecisionRow): DecisionLogEntry {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    ticketId: row.ticket_id === null || row.ticket_id === undefined ? null : Number(row.ticket_id),
    at: toIso(row.at),
    subsystem: row.subsystem as DecisionSubsystem,
    decision: row.decision,
    inputs: parseJson<DecisionInputs>(row.inputs, {}),
    ruleSlug: row.rule_slug ?? null,
    ruleVersion: row.rule_version === null || row.rule_version === undefined ? null : Number(row.rule_version),
    outcome: parseJson<Record<string, unknown>>(row.outcome, {}),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
  };
}

/**
 * The sentence the Why drawer shows. Prefers the engine's own words; falls back
 * to the condition trace, then to a mechanical rendering of the outcome. It
 * never returns an empty string — an unexplained row is worse than a clumsy
 * sentence.
 */
function summarise(entry: DecisionLogEntry): string {
  if (entry.decision && entry.decision.trim().length > 0) return entry.decision.trim();

  const trace = entry.inputs?.trace;
  if (trace) {
    const lines = describeTrace(trace);
    if (lines.length > 0) return lines.join('\n');
  }

  const outcomeKeys = Object.keys(entry.outcome ?? {});
  if (outcomeKeys.length > 0) {
    const rendered = outcomeKeys
      .slice(0, 4)
      .map((key) => `${key}=${JSON.stringify((entry.outcome as Record<string, unknown>)[key])}`)
      .join(', ');
    return `${entry.subsystem}: ${rendered}`;
  }

  return `${entry.subsystem}: no detail recorded`;
}

function actorLabelOf(entry: DecisionLogEntry): string | null {
  const inputs = entry.inputs as Record<string, unknown> | undefined;
  const actor = inputs?.actor;
  if (typeof actor === 'string' && actor.length > 0) return actor;
  if (entry.ruleSlug) return `rule:${entry.ruleSlug}`;
  const actorType = inputs?.actorType;
  if (typeof actorType === 'string' && actorType.length > 0) return actorType;
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// The service
// ═════════════════════════════════════════════════════════════════════════════

export const decisionService = {
  /**
   * Write one decision row. Prefer {@link withDecision} — this is the low-level
   * primitive it is built on, useful when an engine already owns its timing or
   * is replaying a decision it made in-memory.
   *
   * PASS THE ACTION'S TRANSACTION as `executor`.
   */
  async record(input: DecisionRecordInput, executor?: Executor): Promise<DecisionLogEntry> {
    assertTenantId(input.tenantId);

    if (!SUBSYSTEM_SET.has(input.subsystem)) {
      // Not fatal — refusing to log because the label is unknown would trade a
      // taxonomy problem for a missing-evidence problem. Log loudly instead.
      logger.warn(
        { subsystem: input.subsystem, tenantId: input.tenantId },
        'decision_log: unknown subsystem — writing it anyway, but fix the caller',
      );
    }

    const decision = (input.decision ?? '').trim() || `${input.subsystem}: no decision recorded`;

    const [row] = (await insertScoped(
      'decision_log',
      input.tenantId,
      {
        ticket_id: input.ticketId ?? null,
        at: input.at ?? new Date(),
        subsystem: input.subsystem,
        decision,
        inputs: JSON.stringify(input.inputs ?? {}),
        rule_slug: input.ruleSlug ?? null,
        rule_version: input.ruleVersion ?? null,
        outcome: JSON.stringify(input.outcome ?? {}),
        duration_ms: input.durationMs ?? null,
      },
      executor ?? db,
    ).returning('*')) as DecisionRow[];

    return rowToEntry(row);
  },

  /**
   * THE wrapper every engine puts around its action (HARD RULE 2).
   *
   * Runs `fn`, times it, and writes exactly one `decision_log` row using the
   * caller's transaction — on success AND on failure. On failure the row is
   * written with `outcome.error` and the original error is rethrown unchanged,
   * so a crashed engine still leaves a trace of what it was trying to do.
   *
   * If the enclosing transaction later rolls back, the decision row rolls back
   * with the action: the ledger and the data can never disagree, which is the
   * whole point of writing them together.
   */
  async withDecision<T>(
    ctx: DecisionContext,
    subsystem: DecisionSubsystem,
    fn: (recorder: DecisionRecorder) => Promise<T> | T,
  ): Promise<T> {
    assertTenantId(ctx.tenantId);

    const startedAt = Date.now();

    let ticketId: number | null = ctx.ticketId ?? null;
    let sentence = '';
    let ruleSlug: string | null = null;
    let ruleVersion: number | null = null;
    let touched = false;

    const inputs: DecisionInputs = {};
    const outcome: Record<string, unknown> = {};

    if (ctx.actorId !== undefined && ctx.actorId !== null) inputs.actorId = ctx.actorId;
    if (ctx.actorType) inputs.actorType = ctx.actorType;
    if (ctx.correlationId) inputs.correlationId = ctx.correlationId;

    const recorder: DecisionRecorder = {
      decide(text) {
        sentence = text;
        touched = true;
        return recorder;
      },
      inputs(values) {
        Object.assign(inputs, values);
        touched = true;
        return recorder;
      },
      input(keyOrPatch: string | Record<string, unknown>, value?: unknown) {
        if (typeof keyOrPatch === 'string') {
          (inputs as Record<string, unknown>)[keyOrPatch] = value;
        } else if (keyOrPatch && typeof keyOrPatch === 'object') {
          Object.assign(inputs, keyOrPatch);
        }
        touched = true;
        return recorder;
      },
      rule(slug, version) {
        ruleSlug = slug ?? null;
        ruleVersion = version ?? null;
        touched = true;
        return recorder;
      },
      evaluation(evaluation) {
        inputs.trace = evaluation.trace;
        if (evaluation.issues.length > 0) inputs.issues = evaluation.issues;
        outcome.matched = evaluation.matched;
        touched = true;
        return recorder;
      },
      trace(value) {
        inputs.trace = value;
        touched = true;
        return recorder;
      },
      issues(values) {
        if (values.length > 0) inputs.issues = values;
        touched = true;
        return recorder;
      },
      outcome(values) {
        Object.assign(outcome, values);
        touched = true;
        return recorder;
      },
      noop(reason) {
        outcome.result = 'noop';
        outcome.reason = reason;
        if (!sentence) sentence = `${subsystem}: no change (${reason})`;
        touched = true;
        return recorder;
      },
      suppressed(reason) {
        outcome.result = 'suppressed_loop';
        outcome.reason = reason;
        if (!sentence) sentence = `${subsystem}: suppressed (${reason})`;
        touched = true;
        return recorder;
      },
      ticket(id) {
        ticketId = id;
        return recorder;
      },
    };

    const write = async (): Promise<void> => {
      if (!touched) {
        // An engine that ran and recorded nothing is a bug in that engine, but
        // hiding it would be a worse bug here: the row is what proves the
        // engine executed at all.
        outcome.recorded = false;
        logger.warn(
          { subsystem, tenantId: ctx.tenantId, ticketId },
          'decision_log: engine recorded no decision detail — the row will say so',
        );
      }
      try {
        await decisionService.record(
          {
            tenantId: ctx.tenantId,
            ticketId,
            subsystem,
            decision: sentence,
            inputs,
            ruleSlug,
            ruleVersion,
            outcome,
            durationMs: Date.now() - startedAt,
          },
          ctx.trx,
        );
      } catch (error) {
        // Do not let a logging failure mask the engine's own error. Surface it
        // loudly; if we are inside the caller's transaction the whole unit of
        // work will fail anyway, which is the correct outcome.
        logger.error(
          { err: error, subsystem, tenantId: ctx.tenantId, ticketId },
          'decision_log: FAILED TO WRITE — the action is now unexplained',
        );
        throw error;
      }
    };

    try {
      const result = await fn(recorder);
      await write();
      return result;
    } catch (error) {
      outcome.result = outcome.result ?? 'error';
      outcome.error = error instanceof Error ? error.message : String(error);
      if (!sentence) sentence = `${subsystem}: failed — ${String(outcome.error)}`;
      touched = true;
      try {
        await write();
      } catch {
        // `write()` already logged. Rethrowing it here would replace the real
        // failure with a bookkeeping failure.
      }
      throw error;
    }
  },

  // ── Reads ────────────────────────────────────────────────────────────────

  async list(tenantId: number, query: DecisionListQuery = {}): Promise<{
    entries: DecisionLogEntry[];
    total: number;
    page: number;
    limit: number;
  }> {
    assertTenantId(tenantId);

    const limit = Math.min(Math.max(1, query.limit ?? PAGINATION.defaultLimit), PAGINATION.maxLimit);
    const page = Math.max(1, query.page ?? 1);

    const applyFilters = (builder: Knex.QueryBuilder): Knex.QueryBuilder => {
      if (query.ticketId !== undefined && query.ticketId !== null) {
        builder.where('decision_log.ticket_id', query.ticketId);
      }
      if (query.subsystem) builder.where('decision_log.subsystem', query.subsystem);
      if (query.ruleSlug) builder.where('decision_log.rule_slug', query.ruleSlug);
      if (query.from) builder.where('decision_log.at', '>=', new Date(query.from));
      if (query.to) builder.where('decision_log.at', '<=', new Date(query.to));
      return builder;
    };

    const countRow = (await applyFilters(scoped('decision_log', tenantId)).count<{ count: string }[]>(
      'decision_log.id as count',
    )) as unknown as Array<{ count: string }>;
    const total = Number(countRow[0]?.count ?? 0);

    const rows = (await applyFilters(scoped('decision_log', tenantId))
      .orderBy('decision_log.at', 'desc')
      .orderBy('decision_log.id', 'desc')
      .limit(limit)
      .offset((page - 1) * limit)
      .select('decision_log.*')) as DecisionRow[];

    return { entries: rows.map(rowToEntry), total, page, limit };
  },

  /** The raw causal chain for one ticket, OLDEST FIRST — causality reads forward. */
  async forTicket(tenantId: number, ticketId: number, limit = 500): Promise<DecisionLogEntry[]> {
    assertTenantId(tenantId);
    const rows = (await scoped('decision_log', tenantId)
      .where('decision_log.ticket_id', ticketId)
      .orderBy('decision_log.at', 'asc')
      .orderBy('decision_log.id', 'asc')
      .limit(Math.min(Math.max(1, limit), 2000))
      .select('decision_log.*')) as DecisionRow[];
    return rows.map(rowToEntry);
  },

  /**
   * What the "Why?" drawer renders: the ordered causal chain for one ticket,
   * each entry carrying a human sentence and the config slug + version that
   * produced it, so the UI can deep-link to the exact object that decided.
   */
  async explain(tenantId: number, ticketId: number): Promise<WhyExplanation> {
    const entries = await decisionService.forTicket(tenantId, ticketId);
    return {
      ticketId,
      entries: entries.map((entry) => ({
        ...entry,
        summary: summarise(entry),
        actorLabel: actorLabelOf(entry),
      })),
    };
  },

  /**
   * `explain()` plus the LIVE state those decisions produced: which SLA policy
   * applied and why its clock is where it is, which approval is blocking, and
   * which rules were evaluated without matching.
   *
   * The last one matters more than it looks: `decision_log` can only tell you
   * why something happened. When an operator's real question is "why did
   * NOTHING happen?", the answer lives in `rule_executions` — rules that ran
   * and did not match. Without it the drawer would be silent exactly when the
   * user needs it most.
   */
  async explainDetailed(tenantId: number, ticketId: number): Promise<WhyExplanationDetailed> {
    assertTenantId(tenantId);

    const base = await decisionService.explain(tenantId, ticketId);

    const slaRows = (await scoped('sla_instances', tenantId)
      .where('sla_instances.ticket_id', ticketId)
      .orderBy('sla_instances.id', 'asc')
      .select('*')) as Array<{
      id: number;
      target_slug: string;
      policy_slug: string;
      policy_version: number;
      calendar_slug: string;
      status: string;
      running: boolean;
      started_at: Date;
      due_at: Date | null;
      paused_ms: string | number;
      breached_at: Date | null;
      met_at: Date | null;
    }>;

    const instanceIds = slaRows.map((row) => row.id);
    const lastEvents = new Map<
      number,
      { event: string; reasonCode: string | null; at: string; note: string | null }
    >();

    if (instanceIds.length > 0) {
      // One row per instance: the most recent ledger event. DISTINCT ON is the
      // cheap way to say that in Postgres without a window function.
      const ledgerRows = (await scoped('sla_ledger', tenantId)
        .whereIn('sla_ledger.instance_id', instanceIds)
        .orderBy('sla_ledger.instance_id', 'asc')
        .orderBy('sla_ledger.at', 'desc')
        .orderBy('sla_ledger.id', 'desc')
        .select(
          'sla_ledger.instance_id',
          'sla_ledger.event',
          'sla_ledger.reason_code',
          'sla_ledger.at',
          'sla_ledger.note',
        )) as Array<{
        instance_id: number;
        event: string;
        reason_code: string | null;
        at: Date;
        note: string | null;
      }>;

      for (const row of ledgerRows) {
        if (lastEvents.has(row.instance_id)) continue; // ordered desc — first wins
        lastEvents.set(row.instance_id, {
          event: row.event,
          reasonCode: row.reason_code ?? null,
          at: toIso(row.at),
          note: row.note ?? null,
        });
      }
    }

    const approvalRows = (await scoped('approvals', tenantId)
      .where('approvals.ticket_id', ticketId)
      .orderBy('approvals.id', 'asc')
      .select('*')) as Array<{
      id: number;
      definition_slug: string;
      state: string;
      mode: string;
      quorum: number | null;
      due_at: Date | null;
    }>;

    const approvalIds = approvalRows.map((row) => row.id);
    const stepsByApproval = new Map<
      number,
      Array<{ stepIndex: number; approverUserId: number | null; approverGroupId: number | null; state: string }>
    >();

    if (approvalIds.length > 0) {
      const stepRows = (await scoped('approval_steps', tenantId)
        .whereIn('approval_steps.approval_id', approvalIds)
        .where('approval_steps.state', 'pending')
        .orderBy('approval_steps.step_index', 'asc')
        .select(
          'approval_steps.approval_id',
          'approval_steps.step_index',
          'approval_steps.approver_user_id',
          'approval_steps.approver_group_id',
          'approval_steps.state',
        )) as Array<{
        approval_id: number;
        step_index: number;
        approver_user_id: number | null;
        approver_group_id: number | null;
        state: string;
      }>;

      for (const row of stepRows) {
        const list = stepsByApproval.get(row.approval_id) ?? [];
        list.push({
          stepIndex: row.step_index,
          approverUserId: row.approver_user_id ?? null,
          approverGroupId: row.approver_group_id ?? null,
          state: row.state,
        });
        stepsByApproval.set(row.approval_id, list);
      }
    }

    const executionRows = (await scoped('rule_executions', tenantId)
      .where('rule_executions.ticket_id', ticketId)
      .orderBy('rule_executions.at', 'asc')
      .orderBy('rule_executions.id', 'asc')
      .limit(500)
      .select('*')) as Array<{
      rule_slug: string;
      rule_version: number;
      at: Date;
      matched: boolean;
      actions: unknown;
      error: string | null;
      duration_ms: number | null;
      dry_run: boolean;
    }>;

    return {
      ...base,
      sla: slaRows.map((row) => ({
        targetSlug: row.target_slug,
        policySlug: row.policy_slug,
        policyVersion: Number(row.policy_version),
        calendarSlug: row.calendar_slug,
        status: row.status,
        running: Boolean(row.running),
        startedAt: toIso(row.started_at),
        dueAt: row.due_at ? toIso(row.due_at) : null,
        pausedMs: Number(row.paused_ms ?? 0),
        breachedAt: row.breached_at ? toIso(row.breached_at) : null,
        metAt: row.met_at ? toIso(row.met_at) : null,
        lastEvent: lastEvents.get(row.id) ?? null,
      })),
      approvals: approvalRows.map((row) => ({
        id: row.id,
        definitionSlug: row.definition_slug,
        state: row.state,
        mode: row.mode,
        quorum: row.quorum ?? null,
        dueAt: row.due_at ? toIso(row.due_at) : null,
        blockingSteps: stepsByApproval.get(row.id) ?? [],
      })),
      ruleExecutions: executionRows.map((row) => ({
        ruleSlug: row.rule_slug,
        ruleVersion: Number(row.rule_version),
        at: toIso(row.at),
        matched: Boolean(row.matched),
        actions: parseJson<unknown[]>(row.actions, []),
        error: row.error ?? null,
        durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
        dryRun: Boolean(row.dry_run),
      })),
    };
  },

  /**
   * Every decision made by one config object, newest first. Powers the
   * "what has this rule actually done?" panel on a config object's page —
   * the answer to "is it safe to change this?".
   */
  async forRule(
    tenantId: number,
    ruleSlug: string,
    limit = 100,
  ): Promise<DecisionLogEntry[]> {
    assertTenantId(tenantId);
    const rows = (await scoped('decision_log', tenantId)
      .where('decision_log.rule_slug', ruleSlug)
      .orderBy('decision_log.at', 'desc')
      .limit(Math.min(Math.max(1, limit), 500))
      .select('decision_log.*')) as DecisionRow[];
    return rows.map(rowToEntry);
  },

  /** Decision volume per subsystem over a window — the automation health tile. */
  async subsystemStats(
    tenantId: number,
    since: Date,
  ): Promise<Array<{ subsystem: DecisionSubsystem; count: number; avgDurationMs: number | null }>> {
    assertTenantId(tenantId);
    const rows = (await scoped('decision_log', tenantId)
      .where('decision_log.at', '>=', since)
      .groupBy('decision_log.subsystem')
      .select('decision_log.subsystem')
      .count<{ count: string }[]>('decision_log.id as count')
      .avg('decision_log.duration_ms as avg_duration_ms')) as unknown as Array<{
      subsystem: string;
      count: string;
      avg_duration_ms: string | null;
    }>;

    return rows.map((row) => ({
      subsystem: row.subsystem as DecisionSubsystem,
      count: Number(row.count),
      avgDurationMs: row.avg_duration_ms === null ? null : Math.round(Number(row.avg_duration_ms)),
    }));
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// The standalone binding the engines import
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The context shape the desk engines pass: one flat object carrying the
 * subsystem, the sentence and the deciding config object, followed by the work.
 *
 * ticket.service, priority.service and the routing engines each re-declare this
 * structurally and cast to it, so that a change to this signature surfaces in
 * their file as a compile error rather than as a silently missing audit trail.
 * That is a deliberate choice on their side, and it means THIS function has to
 * be the one that stays compatible.
 */
export interface EngineDecisionContext {
  tenantId: number;
  ticketId?: number | null;
  subsystem: DecisionSubsystem | string;
  /** Short machine key or human sentence, e.g. 'priority_from_matrix'. */
  decision?: string;
  inputs?: DecisionInputs;
  /** HARD RULE 3 — the config object that decided, by slug. */
  ruleSlug?: string | null;
  ruleVersion?: number | null;
  actorId?: number | null;
  actorType?: string;
  correlationId?: string;
  trx?: Executor;
}

/**
 * `withDecision(ctx, run)` — wrap an action so its `decision_log` row is
 * written on the action's own code path, in the action's own transaction
 * (HARD RULE 2).
 *
 * Two call shapes are accepted, and both write exactly the same row:
 *
 *   withDecision({ tenantId, ticketId, subsystem, decision, trx }, run)
 *   withDecision({ tenantId, ticketId, trx }, 'priority', run)
 *
 * The first is what the desk engines use — everything up front, because they
 * know their decision before they start. The second suits an engine that only
 * learns what it decided while deciding, and fills the recorder in as it goes.
 * Supporting both is cheaper than making eight engines agree on one, and the
 * row they produce is identical either way.
 */
export function withDecision<T>(
  ctx: EngineDecisionContext,
  run: (recorder: DecisionRecorder) => Promise<T> | T,
): Promise<T>;
export function withDecision<T>(
  ctx: DecisionContext,
  subsystem: DecisionSubsystem,
  run: (recorder: DecisionRecorder) => Promise<T> | T,
): Promise<T>;
export function withDecision<T>(
  ctx: EngineDecisionContext | DecisionContext,
  second: DecisionSubsystem | ((recorder: DecisionRecorder) => Promise<T> | T),
  third?: (recorder: DecisionRecorder) => Promise<T> | T,
): Promise<T> {
  // ── Two-argument form: the subsystem and the sentence ride on the context.
  if (typeof second === 'function') {
    const engineCtx = ctx as EngineDecisionContext;
    const run = second as (recorder: DecisionRecorder) => Promise<T> | T;

    return decisionService.withDecision<T>(
      {
        tenantId: engineCtx.tenantId,
        ticketId: engineCtx.ticketId ?? null,
        trx: engineCtx.trx,
        actorId: engineCtx.actorId ?? null,
        actorType: engineCtx.actorType,
        correlationId: engineCtx.correlationId,
      },
      // An engine that forgot to name its subsystem still gets a row; the
      // taxonomy is worth less than the evidence.
      (engineCtx.subsystem ?? 'workflow') as DecisionSubsystem,
      (recorder) => {
        // Seed the recorder from the context BEFORE the work runs, so a
        // callback that throws still produces a row naming what was attempted
        // and which config object was about to decide.
        if (engineCtx.decision) recorder.decide(engineCtx.decision);
        if (engineCtx.inputs) recorder.inputs(engineCtx.inputs);
        if (engineCtx.ruleSlug !== undefined && engineCtx.ruleSlug !== null) {
          recorder.rule(engineCtx.ruleSlug, engineCtx.ruleVersion ?? null);
        }
        return run(recorder);
      },
    );
  }

  // ── Three-argument form.
  if (!third) {
    throw new Error('withDecision: a run callback is required');
  }
  return decisionService.withDecision<T>(ctx as DecisionContext, second, third);
}

/** Standalone aliases, so an engine can import just what it uses. */
export const recordDecision = decisionService.record;
export const explainTicket = decisionService.explain;

export default decisionService;
