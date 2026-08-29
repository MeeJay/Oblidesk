/**
 * ruleSimulator.service.ts — "what would this rule have done?"
 *
 * ── The one constraint that matters ─────────────────────────────────────────
 * THIS FILE CONTAINS NO EVALUATOR AND NO EXECUTOR. It replays the tenant's own
 * recent tickets through `runRules()` from `rule.service.ts` — the same
 * function production calls, with the same normalisation, the same ordering,
 * the same guardrails, the same `evaluateCondition` — with `dryRun` forced on.
 *
 * A second implementation would be easier to write and would be wrong within a
 * sprint. It would drift in exactly the direction that hurts: the simulation
 * would keep passing while production changed underneath it, so the tool whose
 * entire purpose is to make a config change safe would become the reason
 * somebody shipped a bad one. "Highly configurable" is only a benefit if
 * changing configuration is safe, and it is only safe if the preview is the
 * real thing. If you find yourself adding an `if (simulating)` branch to
 * `rule.service.ts`, that is the moment this design is being lost.
 *
 * ── Two independent safety nets, on purpose ─────────────────────────────────
 *   1. `dryRun: true` — every action resolves everything and then shadows its
 *      change instead of writing it.
 *   2. The replay runs inside a transaction that is ALWAYS rolled back.
 *
 * (1) is the intent; (2) is the structural guarantee. A future action that
 * forgets its dry-run branch is a bug, not a data-loss incident.
 *
 * ── What it can and cannot tell you ─────────────────────────────────────────
 * It replays a SNAPSHOT. A condition written with `changed` / `changed_to` /
 * `changed_from` has no "before" to compare against, so it evaluates false and
 * says `no_previous_snapshot`. That is reported as a caveat rather than
 * papered over with an invented previous state — a simulation that quietly
 * guesses is worse than one that admits its limits.
 */

import type { Knex } from 'knex';

import type {
  ConditionNode,
  StatusCategory,
  TicketWithRelations,
} from '@oblidesk/shared';

import { db } from '../db';
import { logger } from '../utils/logger';

import type { ConfigActor } from './configObject.service';
import { ConfigServiceError } from './configObject.service';
import {
  loadRules,
  normalizeRule,
  recordExecutions,
  runRules,
  type NormalizedRule,
  type RuleExecutionRecord,
  type RuleTriggerKind,
} from './rule.service';
import type { ActionIssue } from './ruleActions';
import * as ticketService from './ticket.service';
import type { ActorContext } from './ticket.service';

const log = logger.child({ subsystem: 'rules.simulator' });

/** Replaying more than this in one request is a report, not an interaction. */
export const MAX_SAMPLE_SIZE = 1000;
export const DEFAULT_SAMPLE_SIZE = 200;

// ═════════════════════════════════════════════════════════════════════════════
// Input / output
// ═════════════════════════════════════════════════════════════════════════════

export interface SimulationInput {
  /** Restrict the run to these rules. Empty means the whole ordered list. */
  ruleSlugs?: string[];
  /**
   * A rule body that is NOT published — the entire reason this exists. Testing
   * only what is already live answers the question after it stops mattering.
   */
  candidate?: {
    slug: string;
    name?: string;
    body: Record<string, unknown>;
  };
  /** How many of the most recent tickets to replay. */
  sampleSize?: number;
  /** Which trigger to replay them under. */
  trigger?: RuleTriggerKind;
  /** Narrow the sample the same way a saved view would. */
  filter?: ConditionNode | null;
  queueSlugs?: string[];
  statusCategories?: StatusCategory[];
  createdFrom?: string;
  createdTo?: string;
  /** Write the dry-run rows to `rule_executions`. Default true. */
  recordLog?: boolean;
}

export interface SimulatedChange {
  field: string;
  from: unknown;
  to: unknown;
  byRule: string;
  byAction: string;
}

export interface SimulatedAction {
  rule: string;
  action: string;
  performed: boolean;
  skipped?: string;
  error?: string;
  detail: Record<string, unknown>;
}

export interface SimulatedTicket {
  ticketId: number;
  number: string;
  subject: string;
  statusSlug: string;
  prioritySlug: string;
  queueSlug: string;
  matchedRules: string[];
  changes: SimulatedChange[];
  actions: SimulatedAction[];
  errors: string[];
  guardrails: string[];
}

export interface SimulatedRuleSummary {
  slug: string;
  name: string;
  version: number;
  enabled: boolean;
  order: number;
  /** Present only for the unpublished body under test. */
  candidate: boolean;
  evaluated: number;
  matched: number;
  actionsPerformed: number;
  actionsSkipped: number;
  errors: number;
  /** reason → count. The answer to "why did it not fire on those 180?". */
  skipReasons: Record<string, number>;
  configIssues: ActionIssue[];
}

export interface SimulationResult {
  dryRun: true;
  trigger: RuleTriggerKind;
  sampleSize: number;
  ticketsExamined: number;
  /** Tickets where at least one rule would have changed something. */
  ticketsAffected: number;
  byRule: SimulatedRuleSummary[];
  /** Only the tickets something would have happened to. */
  changes: SimulatedTicket[];
  guardrails: string[];
  /** Honest limits of a snapshot replay. */
  caveats: string[];
  durationMs: number;
  executionsRecorded: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// The replay
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Replay the tenant's last N tickets through the production executor.
 *
 * Runs one transaction PER TICKET, each rolled back. One big transaction over
 * 200 tickets would hold locks for the length of the whole simulation and
 * would make a single failure lose every result before it; per-ticket keeps
 * both the lock window and the blast radius to one row.
 */
export async function simulateRules(
  actor: ConfigActor,
  input: SimulationInput = {},
): Promise<SimulationResult> {
  const startedAt = Date.now();
  const tenantId = actor.tenantId;
  const trigger: RuleTriggerKind = input.trigger ?? 'ticket_created';
  const sampleSize = Math.min(
    Math.max(input.sampleSize ?? DEFAULT_SAMPLE_SIZE, 1),
    MAX_SAMPLE_SIZE,
  );

  const { rules, forced } = await assembleRules(tenantId, input);
  if (rules.length === 0) {
    throw new ConfigServiceError(
      400,
      'No rule to simulate: the selection is empty, and simulating nothing would report a reassuring zero.',
      'validation_failed',
    );
  }

  const runActor = toActorContext(actor);
  const tickets = await sampleTickets(tenantId, runActor, input, sampleSize);

  const summaries = new Map<string, SimulatedRuleSummary>();
  for (const rule of rules) {
    summaries.set(rule.slug.toLowerCase(), {
      slug: rule.slug,
      name: rule.name,
      version: rule.version,
      // The rule's REAL state, not the forced one — a summary saying "enabled"
      // about a rule that is switched off would be the exact misreading this
      // whole endpoint exists to prevent.
      enabled: !forced.includes(rule.slug),
      order: rule.order,
      candidate: input.candidate?.slug.toLowerCase() === rule.slug.toLowerCase(),
      evaluated: 0,
      matched: 0,
      actionsPerformed: 0,
      actionsSkipped: 0,
      errors: 0,
      skipReasons: {},
      configIssues: rule.issues,
    });
  }

  const changes: SimulatedTicket[] = [];
  const allRecords: RuleExecutionRecord[] = [];
  const guardrails = new Set<string>();
  const caveats = new Set<string>();

  for (const slug of forced) {
    caveats.add(
      `"${slug}" is currently DISABLED. It was evaluated here because you asked about it by name; `
      + 'on the live desk it does nothing until it is enabled.',
    );
  }

  // The order the engine would use — and therefore the order this reports —
  // is the rules' own, not the order they were requested in.
  const ordered = [...rules].sort(
    (a, b) => (a.order === b.order ? a.slug.localeCompare(b.slug) : a.order - b.order),
  );

  for (const ticket of tickets) {
    const before = snapshot(ticket);
    let result: Awaited<ReturnType<typeof runRules>> | null = null;

    try {
      await db.transaction(async (trx: Knex.Transaction) => {
        result = await runRules(
          {
            tenantId,
            trigger,
            ticket,
            // A snapshot has no "before". Saying so is the honest answer; the
            // evaluator reports `no_previous_snapshot` and we surface it.
            previous: null,
            actor: runActor,
            trx,
          },
          {
            dryRun: true,
            rules: ordered,
            persistExecutions: false,
          },
        );

        // ALWAYS. The dry-run branch is the intent; this is the guarantee.
        throw new RollbackSignal();
      });
    } catch (error) {
      if (!(error instanceof RollbackSignal)) {
        log.warn(
          { tenantId, ticketId: ticket.id, err: (error as Error).message },
          'rules.simulator: a ticket failed to replay',
        );
        continue;
      }
    }

    if (!result) continue;
    const run = result as Awaited<ReturnType<typeof runRules>>;

    run.guardrails.forEach((code) => guardrails.add(code));
    allRecords.push(...run.executions);

    const ticketChanges: SimulatedChange[] = [];
    const ticketActions: SimulatedAction[] = [];
    const ticketErrors: string[] = [];
    const matchedRules: string[] = [];

    for (const execution of run.executions) {
      const summary = summaries.get(execution.ruleSlug.toLowerCase());
      if (summary) {
        summary.evaluated += 1;
        if (execution.matched) summary.matched += 1;
        if (execution.error) summary.errors += 1;
        if (execution.skippedReason) {
          summary.skipReasons[execution.skippedReason] =
            (summary.skipReasons[execution.skippedReason] ?? 0) + 1;
        }
      }

      if (execution.matched) matchedRules.push(execution.ruleSlug);
      if (execution.error) ticketErrors.push(`${execution.ruleSlug}: ${execution.error}`);

      for (const entry of execution.entries) {
        if (entry.entry === 'evaluation') {
          for (const issue of entry.issues) {
            if (issue.reason === 'no_previous_snapshot') {
              caveats.add(
                `"${issue.field}" is compared with a change operator, which a snapshot replay cannot answer. `
                + 'Those leaves evaluated false here and may behave differently in production.',
              );
            }
            if (issue.reason === 'unknown_field') {
              caveats.add(
                `"${issue.field}" is not a ticket column and no field object declares it, so it evaluates `
                + 'FALSE everywhere — in this simulation and on the live desk.',
              );
            }
          }
          continue;
        }
        if (entry.entry === 'guardrail') {
          guardrails.add(entry.code);
          continue;
        }
        if (entry.entry !== 'action') continue;

        if (summary) {
          if (entry.performed) summary.actionsPerformed += 1;
          else summary.actionsSkipped += 1;
        }

        ticketActions.push({
          rule: execution.ruleSlug,
          action: entry.kind,
          performed: entry.performed,
          ...(entry.skipped ? { skipped: entry.skipped } : {}),
          ...(entry.error ? { error: entry.error } : {}),
          detail: entry.detail,
        });
      }
    }

    // The diff the operator actually reads: before vs the shadowed after.
    for (const change of diffTickets(before, snapshot(run.ticket))) {
      const author = ticketActions.find(
        (action) => action.performed && touches(action, change.field),
      );
      ticketChanges.push({
        ...change,
        byRule: author?.rule ?? matchedRules[0] ?? '',
        byAction: author?.action ?? '',
      });
    }

    if (ticketChanges.length > 0 || ticketErrors.length > 0
      || ticketActions.some((action) => action.performed)) {
      changes.push({
        ticketId: ticket.id,
        number: ticket.number,
        subject: ticket.subject,
        statusSlug: ticket.statusSlug,
        prioritySlug: ticket.prioritySlug,
        queueSlug: ticket.queueSlug,
        matchedRules,
        changes: ticketChanges,
        actions: ticketActions,
        errors: ticketErrors,
        guardrails: run.guardrails,
      });
    }
  }

  // The log is written AFTER the rollbacks, in its own committed transaction:
  // the effects are discarded, the evidence is not. A simulation nobody can
  // look at afterwards is a simulation nobody can defend a decision with.
  let executionsRecorded = 0;
  if (input.recordLog !== false && allRecords.length > 0) {
    await recordExecutions(tenantId, allRecords);
    executionsRecorded = allRecords.length;
  }

  return {
    dryRun: true,
    trigger,
    sampleSize,
    ticketsExamined: tickets.length,
    ticketsAffected: changes.length,
    byRule: [...summaries.values()].sort(
      (a, b) => (a.order === b.order ? a.slug.localeCompare(b.slug) : a.order - b.order),
    ),
    changes,
    guardrails: [...guardrails],
    caveats: [...caveats],
    durationMs: Date.now() - startedAt,
    executionsRecorded,
  };
}

/** Thrown to roll a replay transaction back. Never an error condition. */
class RollbackSignal extends Error {
  constructor() {
    super('rules.simulator: intentional rollback');
    this.name = 'RollbackSignal';
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Assembling the rule set under test
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The published list, with the candidate body folded in.
 *
 * A candidate REPLACES the published rule of the same slug rather than running
 * alongside it: the question being asked is "what happens if I publish this?",
 * and answering it with both versions in the list would produce a result that
 * can never occur.
 */
async function assembleRules(
  tenantId: number,
  input: SimulationInput,
): Promise<{ rules: NormalizedRule[]; forced: string[] }> {
  const published = await loadRules(tenantId, db, { fresh: true });
  const selected = input.ruleSlugs?.map((slug) => slug.toLowerCase());

  const byName = new Map<string, NormalizedRule>();
  for (const rule of published) byName.set(rule.slug.toLowerCase(), rule);

  if (input.candidate) {
    const slug = input.candidate.slug;
    const existing = byName.get(slug.toLowerCase());
    const candidate = normalizeRule({
      slug,
      name: input.candidate.name ?? existing?.name ?? slug,
      body: input.candidate.body,
      bodyFormatVersion: existing?.bodyFormatVersion ?? 1,
      // A draft has no published version yet. Marking it as the next one keeps
      // the execution rows honest about which body produced them.
      version: (existing?.version ?? 0) + 1,
      isSystem: false,
      shared: false,
    });
    byName.set(slug.toLowerCase(), candidate);
  }

  const all = [...byName.values()];
  const chosen = !selected || selected.length === 0
    ? all
    : all.filter((rule) => selected.includes(rule.slug.toLowerCase()));

  // A rule you asked about BY NAME is evaluated even when it is switched off.
  //
  // Drafting with `enabled: false` is the sensible way to write a new rule, and
  // an empty simulation is the least useful possible answer to "what would this
  // do?". The forcing is reported as a caveat and the summary still shows the
  // rule's real `enabled` state, so nobody concludes it is live.
  const namedByHand = new Set<string>([
    ...(selected ?? []),
    ...(input.candidate ? [input.candidate.slug.toLowerCase()] : []),
  ]);

  const forced: string[] = [];
  const rules = chosen.map((rule) => {
    if (rule.enabled || !namedByHand.has(rule.slug.toLowerCase())) return rule;
    forced.push(rule.slug);
    return { ...rule, enabled: true };
  });

  return { rules, forced };
}

// ═════════════════════════════════════════════════════════════════════════════
// The sample
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Real tickets, newest first.
 *
 * Deliberately the tenant's OWN history rather than fixtures: a rule is only
 * safe against the data it will actually meet, and the shapes that break
 * automation — the ticket with no requester, the one whose queue was renamed,
 * the one an import left half-populated — are exactly the ones nobody thinks
 * to write a fixture for.
 */
async function sampleTickets(
  tenantId: number,
  actor: ActorContext,
  input: SimulationInput,
  sampleSize: number,
): Promise<TicketWithRelations[]> {
  const collected: TicketWithRelations[] = [];
  let cursor: string | null = null;

  while (collected.length < sampleSize) {
    const page: ticketService.TicketPage = await ticketService.list(tenantId, actor, {
      limit: Math.min(sampleSize - collected.length, 100),
      cursor,
      sortBy: 'created_at',
      sortDir: 'desc',
      ...(input.filter ? { filter: input.filter } : {}),
      ...(input.queueSlugs?.length ? { queueSlugs: input.queueSlugs } : {}),
      ...(input.statusCategories?.length ? { statusCategories: input.statusCategories } : {}),
      ...(input.createdFrom ? { createdFrom: input.createdFrom } : {}),
      ...(input.createdTo ? { createdTo: input.createdTo } : {}),
    });

    collected.push(...page.items);
    if (!page.hasMore || !page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }

  return collected.slice(0, sampleSize);
}

// ═════════════════════════════════════════════════════════════════════════════
// Diffing
// ═════════════════════════════════════════════════════════════════════════════

/** The fields a rule can move. Diffing everything would report `updated_at`. */
const DIFFED_FIELDS = [
  'subject',
  'descriptionMd',
  'statusSlug',
  'prioritySlug',
  'impact',
  'urgency',
  'queueSlug',
  'assigneeId',
  'assignmentGroupId',
  'organizationId',
  'requesterContactId',
  'primaryCiId',
  'dueAt',
  'occurredAt',
  'resolutionCode',
  'resolutionMd',
] as const;

interface TicketSnapshot {
  fields: Record<string, unknown>;
  data: Record<string, unknown>;
}

function snapshot(ticket: TicketWithRelations): TicketSnapshot {
  const fields: Record<string, unknown> = {};
  for (const field of DIFFED_FIELDS) {
    fields[field] = (ticket as unknown as Record<string, unknown>)[field] ?? null;
  }
  return { fields, data: { ...(ticket.data ?? {}) } };
}

function diffTickets(
  before: TicketSnapshot,
  after: TicketSnapshot,
): Array<{ field: string; from: unknown; to: unknown }> {
  const out: Array<{ field: string; from: unknown; to: unknown }> = [];

  for (const field of DIFFED_FIELDS) {
    if (!same(before.fields[field], after.fields[field])) {
      out.push({ field, from: before.fields[field], to: after.fields[field] });
    }
  }

  const keys = new Set([...Object.keys(before.data), ...Object.keys(after.data)]);
  for (const key of keys) {
    if (!same(before.data[key], after.data[key])) {
      out.push({ field: `data.${key}`, from: before.data[key] ?? null, to: after.data[key] ?? null });
    }
  }

  return out;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
  return false;
}

/** Did this action plausibly produce that field change? Best-effort attribution. */
function touches(action: SimulatedAction, field: string): boolean {
  const detail = action.detail ?? {};
  const named = typeof detail.field === 'string' ? detail.field : null;
  if (named && (named === field || named.endsWith(`.${field}`) || field.endsWith(named))) return true;

  const wouldChange = detail.wouldChange;
  if (wouldChange && typeof wouldChange === 'object') {
    if (Object.prototype.hasOwnProperty.call(wouldChange, field)) return true;
    const dataPatch = (wouldChange as Record<string, unknown>).data;
    if (dataPatch && typeof dataPatch === 'object' && field.startsWith('data.')) {
      return Object.prototype.hasOwnProperty.call(dataPatch, field.slice('data.'.length));
    }
  }

  switch (action.action) {
    case 'set_priority':
      return field === 'prioritySlug';
    case 'assign_to_user':
      return field === 'assigneeId';
    case 'assign_to_group':
    case 'assign_group_by_queue':
      return field === 'assignmentGroupId';
    case 'move_to_queue':
      return field === 'queueSlug';
    case 'transition_to':
      return field === 'statusSlug';
    case 'add_tag':
    case 'remove_tag':
      return field === 'data.tags';
    default:
      return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Actor
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The simulation runs as the ADMIN who asked for it, not as the system actor.
 * `actor.*` leaves in a condition then resolve to the same values the person
 * reading the result would see, and a rule gated on a capability they do not
 * hold does not quietly look like it would fire.
 */
function toActorContext(actor: ConfigActor): ActorContext {
  return {
    userId: actor.userId,
    username: null,
    role: actor.role,
    actorType: actor.actorType,
    capabilities: actor.capabilities,
    assignmentGroupIds: actor.groupIds,
    isAdmin: actor.isAdmin,
  };
}

export const ruleSimulatorService = {
  simulateRules,
  MAX_SAMPLE_SIZE,
  DEFAULT_SAMPLE_SIZE,
};

export default ruleSimulatorService;
