/**
 * rule.service.ts — ONE rules engine, one ordered list.
 *
 * ── The decision this file encodes ──────────────────────────────────────────
 * Every other desk on the market splits automation into four or five separate
 * engines: business rules, assignment rules, escalation rules, SLA workflows,
 * notification conditions. We reject that split deliberately. It doubles the
 * learning cost (five editors, five vocabularies, five places to look), and —
 * the part that actually hurts — it makes the operator's real question
 * unanswerable: "what will happen to this ticket, and in what order?" has no
 * answer when there is no single ordered list to point at. Presets over ONE
 * engine give the same perceived simplicity with none of the fragmentation.
 *
 * So: rules are config objects (`kind='rule'`, `RuleBody`). A trigger picks
 * them, `evaluateCondition` from `@oblidesk/shared` — the SAME evaluator the
 * browser runs — decides whether they match, and an explicit, editable,
 * ordered list of actions from the closed catalogue in `ruleActions.ts` runs.
 * That is the whole model.
 *
 * ── The execution log ships WITH the engine ─────────────────────────────────
 * Every evaluation writes a `rule_executions` row — matched or not, actions
 * taken, error, duration, dry_run. Not "later, when we add observability".
 * Without it, every unexpected field value is an unfalsifiable mystery: the
 * operator cannot tell "no rule matched" from "a rule matched and did nothing"
 * from "a rule threw", and all three look identical from the ticket.
 * `decision_log` says why something happened; `rule_executions` is the only
 * thing that can say why NOTHING happened.
 *
 * ── Guardrails ship at the same time ────────────────────────────────────────
 * The first production incident of an unguarded engine happens at 2am, and it
 * is always one of three: a rule whose action re-triggers the engine (loop), a
 * rule that fans out (budget), or a rule that fails on every ticket forever
 * (breaker). All three are here from day one, and all three STOP the work and
 * say so — a rule that would exceed a guardrail is never silently truncated,
 * because a truncation that looks like completion is the failure nobody
 * catches until the data is wrong.
 *
 * ── Wiring ──────────────────────────────────────────────────────────────────
 * `ticket.service.ts` exposes `registerRulesEngine()` with a no-op default
 * precisely so this file can attach without anybody editing that one. Importing
 * this module installs the engine; `installRulesEngine()` / `uninstall...` are
 * exported for tests and for an explicit boot sequence.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';

import {
  businessMinutesBetween,
  createAlwaysOpenCalendar,
  collectFields,
  evaluateCondition,
  isConditionNode,
  isTerminal,
  type BusinessCalendar,
  type ConditionEvaluation,
  type ConditionNode,
  type StatusCategory,
  type TicketWithRelations,
} from '@oblidesk/shared';

import { db, insertScoped, scoped, type Executor } from '../db';
import { logger } from '../utils/logger';

import {
  GuardrailError,
  normalizeActions,
  performAction,
  resolveTenantIdentity,
  type ActionContext,
  type ActionIssue,
  type ActionResult,
  type NormalizedAction,
} from './ruleActions';
import {
  ConfigServiceError,
  getConfigObject,
  loadPublished,
  publishConfigObject,
  updateConfigObject,
  type ConfigActor,
  type PublishedBody,
} from './configObject.service';
import { withDecision } from './decision.service';
import * as ticketService from './ticket.service';
import type { ActorContext, RulesEngineEvent, RulesEngineHook } from './ticket.service';
import { buildTransitionContext } from './stateMachine.service';

const log = logger.child({ subsystem: 'rules' });

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Guardrail knobs
// ═════════════════════════════════════════════════════════════════════════════

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * How deep a rule may re-enter the engine. An action that updates the ticket
 * fires `onTicketUpdated`, which evaluates the rules again — that is a FEATURE
 * (routing then priority then notification is a legitimate chain) right up
 * until it is a cycle. Three is enough for every legitimate chain we have and
 * short enough that a cycle is caught on the first ticket rather than the
 * thousandth.
 */
export const MAX_LOOP_DEPTH = envInt('RULES_MAX_LOOP_DEPTH', 3);

/**
 * Actions charged per top-level engine run for one ticket, across every nested
 * re-entry. A rule that wants to perform more than this to one ticket in one
 * event is not configured, it is broken.
 */
export const ACTION_BUDGET = envInt('RULES_ACTION_BUDGET', 40);

/** Consecutive failures before a rule is switched off and says so loudly. */
export const CIRCUIT_BREAKER_THRESHOLD = envInt('RULES_BREAKER_THRESHOLD', 5);

/** How long a published rule set is reused before it is re-read. */
export const RULE_CACHE_TTL_MS = envInt('RULES_CACHE_TTL_MS', 5_000);

/** Tickets one scheduled rule may sweep per tick. */
export const SCHEDULE_TICKET_LIMIT = envInt('RULES_SCHEDULE_LIMIT', 500);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Triggers
// ═════════════════════════════════════════════════════════════════════════════

export const RULE_TRIGGERS = [
  'ticket_created',
  'ticket_updated',
  'status_changed',
  'assignment_changed',
  'journal_added',
  'sla_warning',
  'sla_breached',
  'approval_decided',
  'alert_received',
  'mail_received',
  'schedule',
  'manual',
] as const;

export type RuleTriggerKind = (typeof RULE_TRIGGERS)[number];

/**
 * The dotted spellings the shipped baseline uses, folded onto the canonical
 * names. `seeds/02_baseline_config.ts` writes `trigger: { on: ['ticket.created'] }`
 * while `RuleBody` in `@oblidesk/shared` writes `triggers: ['ticket_created']`.
 * Refusing either dialect would ship a desk whose own baseline rules never
 * fire, which is the most embarrassing possible way to be strict.
 */
const TRIGGER_ALIASES: Readonly<Record<string, RuleTriggerKind>> = {
  'ticket.created': 'ticket_created',
  'ticket.updated': 'ticket_updated',
  'ticket.field_changed': 'ticket_updated',
  'ticket.fieldchanged': 'ticket_updated',
  'ticket.status_changed': 'status_changed',
  'ticket.transitioned': 'status_changed',
  'ticket.assigned': 'assignment_changed',
  'ticket.assignment_changed': 'assignment_changed',
  'ticket.commented': 'journal_added',
  'journal.added': 'journal_added',
  'journal.appended': 'journal_added',
  'sla.warning': 'sla_warning',
  'sla.warned': 'sla_warning',
  'sla.breach': 'sla_breached',
  'sla.breached': 'sla_breached',
  'approval.decided': 'approval_decided',
  'alert.received': 'alert_received',
  'mail.received': 'mail_received',
  schedule: 'schedule',
  manual: 'manual',
};

function normalizeTrigger(raw: unknown): RuleTriggerKind | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if ((RULE_TRIGGERS as readonly string[]).includes(key)) return key as RuleTriggerKind;
  return TRIGGER_ALIASES[key] ?? null;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — The normal form of a rule
// ═════════════════════════════════════════════════════════════════════════════

export interface NormalizedRule {
  slug: string;
  name: string;
  /** The PUBLISHED version. Pinned onto every row this rule writes (RULE 3/4). */
  version: number;
  bodyFormatVersion: number;
  /** Lower runs first. Ties break on slug, so the order is total and stable. */
  order: number;
  enabled: boolean;
  /** Evaluate and log, perform nothing. The safe way onto a live desk. */
  dryRun: boolean;
  stopProcessing: boolean;
  runOnce: boolean;
  cooldownMinutes: number | null;
  triggers: RuleTriggerKind[];
  /**
   * For `ticket_updated`: only fire when one of these columns changed. Empty
   * means "any change".
   */
  triggerFields: string[];
  when: ConditionNode | null;
  actions: NormalizedAction[];
  /** Everything wrong with the body that did not stop it loading. */
  issues: ActionIssue[];
  schedule: { everyMinutes: number | null; cron: string | null; calendarSlug: string | null } | null;
  /** `context.*` paths this rule's condition reads — drives what we compute. */
  contextFields: string[];
  decisionLabel: string | null;
  /** From the master tenant rather than this one. */
  shared: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (chr) => `_${chr.toLowerCase()}`);
}

function toConditionNode(raw: unknown): ConditionNode | null {
  if (raw === null || raw === undefined) return null;
  return isConditionNode(raw) ? raw : null;
}

/**
 * Fold a published rule body — in either dialect — into {@link NormalizedRule}.
 *
 * Never throws. A body this cannot read produces a DISABLED rule carrying the
 * reason, because a rule that silently vanishes from the ordered list is
 * exactly the failure the ordered list exists to prevent.
 */
export function normalizeRule(published: PublishedBody): NormalizedRule {
  const body = published.body as Record<string, unknown>;
  const issues: ActionIssue[] = [];

  // ── triggers ───────────────────────────────────────────────────────────────
  const triggerRaw = body.triggers ?? body.trigger;
  const triggerList = Array.isArray(triggerRaw)
    ? triggerRaw
    : isPlainObject(triggerRaw) && Array.isArray(triggerRaw.on)
      ? triggerRaw.on
      : [];

  const triggers: RuleTriggerKind[] = [];
  for (const entry of triggerList) {
    const normalized = normalizeTrigger(entry);
    if (normalized && !triggers.includes(normalized)) triggers.push(normalized);
  }

  const triggerFieldsRaw = isPlainObject(triggerRaw) && Array.isArray(triggerRaw.fields)
    ? triggerRaw.fields
    : Array.isArray(body.triggerFields) ? body.triggerFields : [];
  const triggerFields = triggerFieldsRaw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => camelToSnake(entry.replace(/^ticket\./, '')));

  // ── schedule ───────────────────────────────────────────────────────────────
  const scheduleSource = isPlainObject(body.schedule)
    ? body.schedule
    : isPlainObject(triggerRaw) ? triggerRaw : null;
  const everyMinutes = scheduleSource
    ? Number(scheduleSource.everyMinutes ?? scheduleSource.every_minutes ?? Number.NaN)
    : Number.NaN;
  const schedule = triggers.includes('schedule')
    ? {
      everyMinutes: Number.isFinite(everyMinutes) && everyMinutes > 0 ? everyMinutes : null,
      cron: scheduleSource && typeof scheduleSource.cron === 'string' ? scheduleSource.cron : null,
      calendarSlug: scheduleSource && typeof scheduleSource.calendarSlug === 'string'
        ? scheduleSource.calendarSlug
        : scheduleSource && typeof scheduleSource.calendar_slug === 'string'
          ? scheduleSource.calendar_slug
          : null,
    }
    : null;

  // ── condition ──────────────────────────────────────────────────────────────
  const rawWhen = body.when ?? body.condition ?? null;
  const when = toConditionNode(rawWhen);
  if (rawWhen !== null && rawWhen !== undefined && when === null) {
    issues.push({
      index: -1,
      actionType: 'when',
      code: 'malformed_action',
      message:
        'The condition tree is malformed. A malformed tree evaluates FALSE, so this rule can never match — ' +
        'it is switched off in every way except the one the UI shows.',
    });
  }

  // ── actions ────────────────────────────────────────────────────────────────
  const normalized = normalizeActions(body.actions);
  issues.push(...normalized.issues);

  const orderRaw = Number(body.order ?? body.priority ?? body.sortOrder ?? 1000);
  const cooldownRaw = Number(body.cooldownMinutes ?? body.cooldown_minutes ?? Number.NaN);

  const decisionLog = isPlainObject(body.decision_log)
    ? body.decision_log
    : isPlainObject(body.decisionLog) ? body.decisionLog : null;

  // A malformed condition is fatal to the rule: it can never match, so leaving
  // it "enabled" would be a lie the list tells every day. An ABSENT condition
  // is different and legal — it means "always".
  const conditionIsBroken = rawWhen !== null && rawWhen !== undefined && when === null;
  const enabled = body.enabled !== false && !conditionIsBroken;

  return {
    slug: published.slug,
    name: published.name,
    version: published.version,
    bodyFormatVersion: published.bodyFormatVersion,
    order: Number.isFinite(orderRaw) ? orderRaw : 1000,
    enabled,
    dryRun: body.dryRun === true || body.dry_run === true,
    stopProcessing: body.stopProcessing === true || body.stop_processing === true,
    runOnce: body.runOnce === true || body.once_per_ticket === true,
    cooldownMinutes: Number.isFinite(cooldownRaw) && cooldownRaw > 0 ? cooldownRaw : null,
    triggers,
    triggerFields,
    when,
    actions: normalized.actions,
    issues,
    schedule,
    contextFields: collectFields(when)
      .filter((field) => field.startsWith('context.'))
      .map((field) => field.slice('context.'.length)),
    decisionLabel: decisionLog && typeof decisionLog.decision === 'string'
      ? decisionLog.decision
      : null,
    shared: published.shared,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Loading, with a short cache
// ═════════════════════════════════════════════════════════════════════════════

interface CacheEntry {
  at: number;
  rules: NormalizedRule[];
}

const ruleCache = new Map<number, CacheEntry>();

/**
 * Call after publishing a rule so the next event sees it immediately. The TTL
 * is the safety net, not the mechanism — a five-second window between "I
 * published it" and "it fires" is the kind of thing that makes an admin
 * conclude the feature is broken and stop trusting it.
 */
export function invalidateRuleCache(tenantId?: number): void {
  if (tenantId === undefined) ruleCache.clear();
  else ruleCache.delete(tenantId);
}

/**
 * THE ordered list, exactly as the engine will run it: published rules sorted
 * by (order, slug). The admin screen renders this same array, because "what
 * will happen, and in what order" must be answered by the thing that decides,
 * not by a parallel implementation that agrees with it most of the time.
 */
export async function loadRules(
  tenantId: number,
  executor: Executor = db,
  options: { fresh?: boolean } = {},
): Promise<NormalizedRule[]> {
  const cached = ruleCache.get(tenantId);
  if (!options.fresh && cached && Date.now() - cached.at < RULE_CACHE_TTL_MS) {
    return cached.rules;
  }

  const published = await loadPublished(tenantId, 'rule', executor);
  const rules = [...published.values()]
    .map(normalizeRule)
    .sort((a, b) => (a.order === b.order ? a.slug.localeCompare(b.slug) : a.order - b.order));

  ruleCache.set(tenantId, { at: Date.now(), rules });
  return rules;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — The evaluation context
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `context.*` values: things that are true ABOUT a ticket but are not columns.
 *
 * Computed lazily from what the loaded rules actually read (`contextFields`),
 * because `public_reply_count` is a query per ticket and no desk should pay for
 * it on every event when no rule mentions it.
 */
export interface RuleContextExtras {
  [key: string]: unknown;
}

const calendarCache = new Map<number, { at: number; calendar: BusinessCalendar }>();

async function defaultCalendar(tenantId: number, executor: Executor): Promise<BusinessCalendar> {
  const cached = calendarCache.get(tenantId);
  if (cached && Date.now() - cached.at < 60_000) return cached.calendar;

  let calendar = createAlwaysOpenCalendar('Europe/Paris');
  try {
    const calendars = await loadPublished(tenantId, 'calendar', executor);
    const bodies = [...calendars.values()];
    const preferred =
      bodies.find((entry) => (entry.body as Record<string, unknown>).is_default === true)
      ?? bodies.find((entry) => entry.slug.toLowerCase() === 'business_hours')
      ?? bodies[0];
    if (preferred) calendar = preferred.body as unknown as BusinessCalendar;
  } catch (error) {
    log.warn({ tenantId, err: (error as Error).message }, 'rules: falling back to a 24×7 calendar');
  }

  calendarCache.set(tenantId, { at: Date.now(), calendar });
  return calendar;
}

async function buildExtras(
  tenantId: number,
  ticket: TicketWithRelations,
  needed: ReadonlySet<string>,
  now: string,
  executor: Executor,
): Promise<RuleContextExtras> {
  const extras: RuleContextExtras = {};
  if (needed.size === 0) return extras;

  const nowMs = new Date(now).getTime();
  const minutesSince = (iso: string | null): number | null =>
    iso ? Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 60_000)) : null;

  if (needed.has('minutes_since_created')) {
    extras.minutes_since_created = minutesSince(ticket.createdAt);
  }
  if (needed.has('minutes_since_updated')) {
    extras.minutes_since_updated = minutesSince(ticket.updatedAt);
  }
  if (needed.has('minutes_since_occurred')) {
    extras.minutes_since_occurred = minutesSince(ticket.occurredAt);
  }
  if (needed.has('minutes_since_first_response')) {
    extras.minutes_since_first_response = minutesSince(ticket.firstResponseAt);
  }

  const wantsBusiness =
    needed.has('business_minutes_since_created')
    || needed.has('business_minutes_since_updated')
    || needed.has('business_minutes_in_status');

  if (wantsBusiness) {
    const calendar = await defaultCalendar(tenantId, executor);
    if (needed.has('business_minutes_since_created')) {
      extras.business_minutes_since_created = Math.round(
        businessMinutesBetween(calendar, ticket.createdAt, now),
      );
    }
    if (needed.has('business_minutes_since_updated')) {
      extras.business_minutes_since_updated = Math.round(
        businessMinutesBetween(calendar, ticket.updatedAt, now),
      );
    }
    if (needed.has('business_minutes_in_status')) {
      extras.business_minutes_in_status = Math.round(
        businessMinutesBetween(calendar, ticket.updatedAt, now),
      );
    }
  }

  if (needed.has('public_reply_count')) {
    const rows = (await scoped('ticket_journal', tenantId, executor)
      .where('ticket_journal.ticket_id', ticket.id)
      .where('ticket_journal.kind', 'public_reply')
      .count({ count: '*' })) as unknown as Array<{ count: string | number }>;
    extras.public_reply_count = Number(rows?.[0]?.count ?? 0);
  }

  if (needed.has('watcher_count')) {
    const rows = (await scoped('ticket_watcher', tenantId, executor)
      .where('ticket_watcher.ticket_id', ticket.id)
      .count({ count: '*' })) as unknown as Array<{ count: string | number }>;
    extras.watcher_count = Number(rows?.[0]?.count ?? 0);
  }

  if (needed.has('open_approval_count')) {
    const rows = (await scoped('approvals', tenantId, executor)
      .where('approvals.ticket_id', ticket.id)
      .where('approvals.state', 'pending')
      .count({ count: '*' })) as unknown as Array<{ count: string | number }>;
    extras.open_approval_count = Number(rows?.[0]?.count ?? 0);
  }

  return extras;
}

/**
 * Build the condition context — the SAME shape `stateMachine.service` builds
 * for a transition guard, so a condition means one thing everywhere it is
 * written, and `previous` so `changed` / `changed_to` / `changed_from` can be
 * answered instead of reported as unanswerable.
 */
function buildRuleContext(input: {
  ticket: TicketWithRelations;
  previous: TicketWithRelations | null;
  actor: ActorContext;
  extras: RuleContextExtras;
  now: string;
}) {
  const current = buildTransitionContext({
    ticket: input.ticket,
    actor: input.actor,
    extras: input.extras,
    now: input.now,
  });

  const previous = input.previous
    ? buildTransitionContext({
      ticket: input.previous,
      actor: input.actor,
      extras: input.extras,
      now: input.now,
    }).fields
    : null;

  return { ...current, previous };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Guardrails
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `depth` is per re-entry; `shared` is per TOP-LEVEL run and is the same object
 * in every nested state.
 *
 * That split is load-bearing. The action budget is "per ticket, per event",
 * which means it must be spent from one purse across the whole chain — a
 * nested run that got its own copy of the counter would let a rule loop
 * forever by re-entering, spending 40 fresh actions each time, and never
 * tripping the guard that exists precisely to catch it.
 */
interface EngineRunState {
  correlationId: string;
  depth: number;
  budget: number;
  tenantId: number;
  rootTicketId: number;
  shared: { spent: number; guardrails: string[] };
}

/**
 * The loop guard has to survive a re-entry that happens through
 * `ticket.service.update()` → `onTicketUpdated` → here, which is a different
 * call stack in the same async context. Async-local storage is the only thing
 * that tracks that correctly; a module-level counter would be wrong the moment
 * two tickets are processed concurrently, and being wrong about a loop guard
 * means either false trips or no guard at all.
 */
const runStore = new AsyncLocalStorage<EngineRunState>();

/** The correlation id of the engine run in progress, if any. */
export function currentRunCorrelationId(): string | null {
  return runStore.getStore()?.correlationId ?? null;
}

// ── Circuit breaker ──────────────────────────────────────────────────────────

export interface BreakerState {
  /** Consecutive failures. Reset by one success, or by publishing a new version. */
  failures: number;
  /** Non-null while the rule is switched off by the breaker. */
  openedAt: string | null;
  lastError: string | null;
  /** The rule version the count belongs to — a new version starts clean. */
  version: number;
  hydrated: boolean;
}

const breakers = new Map<string, BreakerState>();

const breakerKey = (tenantId: number, slug: string): string => `${tenantId}:${slug.toLowerCase()}`;

export function ruleBreakerState(tenantId: number, slug: string): BreakerState | null {
  return breakers.get(breakerKey(tenantId, slug)) ?? null;
}

/** Close a breaker by hand — the "I fixed it, try again" button. */
export function resetRuleBreaker(tenantId: number, slug: string): void {
  breakers.delete(breakerKey(tenantId, slug));
}

/**
 * Seed the breaker from `rule_executions` the first time a rule is seen in
 * this process.
 *
 * In-memory alone would mean a rule that fails on every ticket gets N fresh
 * chances after every deploy and every restart — which, on a busy desk, is
 * indistinguishable from having no breaker. The log is already the record of
 * what happened; reading it back costs one indexed query per rule per process.
 */
async function hydrateBreaker(
  tenantId: number,
  rule: NormalizedRule,
  executor: Executor,
): Promise<BreakerState> {
  const key = breakerKey(tenantId, rule.slug);
  const existing = breakers.get(key);
  if (existing && existing.hydrated && existing.version === rule.version) return existing;

  const state: BreakerState = {
    failures: 0,
    openedAt: null,
    lastError: null,
    version: rule.version,
    hydrated: true,
  };

  try {
    const rows = (await scoped('rule_executions', tenantId, executor)
      .where('rule_executions.rule_slug', rule.slug)
      .where('rule_executions.rule_version', rule.version)
      .where('rule_executions.dry_run', false)
      .orderBy('rule_executions.at', 'desc')
      .limit(CIRCUIT_BREAKER_THRESHOLD)
      .select('error')) as Array<{ error: string | null }>;

    if (rows.length >= CIRCUIT_BREAKER_THRESHOLD && rows.every((row) => row.error !== null)) {
      state.failures = rows.length;
      state.openedAt = new Date().toISOString();
      state.lastError = rows[0]?.error ?? null;
      log.error(
        { tenantId, ruleSlug: rule.slug, ruleVersion: rule.version },
        'rules: circuit breaker restored to OPEN from the execution log',
      );
    }
  } catch (error) {
    // Failing to read history must not stop the engine — it just means this
    // process starts the count at zero, which is the safe direction.
    log.warn({ tenantId, ruleSlug: rule.slug, err: (error as Error).message },
      'rules: could not hydrate the circuit breaker');
  }

  breakers.set(key, state);
  return state;
}

async function tripBreaker(
  tenantId: number,
  rule: NormalizedRule,
  message: string,
  executor: Executor,
): Promise<BreakerState> {
  const key = breakerKey(tenantId, rule.slug);
  const state = breakers.get(key) ?? {
    failures: 0, openedAt: null, lastError: null, version: rule.version, hydrated: false,
  };

  if (state.version !== rule.version) {
    state.version = rule.version;
    state.failures = 0;
    state.openedAt = null;
  }

  state.failures += 1;
  state.lastError = message;

  if (state.failures >= CIRCUIT_BREAKER_THRESHOLD && state.openedAt === null) {
    state.openedAt = new Date().toISOString();

    // "Says so loudly" is a requirement, not a nicety. A rule that quietly
    // stops working looks exactly like a rule whose condition stopped matching,
    // and the two have completely different fixes.
    log.error(
      { tenantId, ruleSlug: rule.slug, ruleVersion: rule.version, failures: state.failures, lastError: message },
      'rules: CIRCUIT BREAKER OPEN — this rule is disabled until it is fixed or reset',
    );

    await raiseBreakerAlert(tenantId, rule, message, executor);
    await withDecision(
      {
        tenantId,
        ticketId: null,
        subsystem: 'rule',
        decision: `circuit breaker opened for rule ${rule.slug}`,
        ruleSlug: rule.slug,
        ruleVersion: rule.version,
        trx: executor,
        inputs: { failures: state.failures, threshold: CIRCUIT_BREAKER_THRESHOLD },
      },
      async (recorder) => {
        recorder.suppressed('circuit_open');
        recorder.outcome({ lastError: message });
      },
    ).catch(() => undefined);
  }

  breakers.set(key, state);
  return state;
}

function closeBreaker(tenantId: number, rule: NormalizedRule): void {
  const key = breakerKey(tenantId, rule.slug);
  const state = breakers.get(key);
  if (!state) return;
  if (state.failures === 0 && state.openedAt === null) return;
  state.failures = 0;
  state.openedAt = null;
  state.lastError = null;
  state.version = rule.version;
}

async function raiseBreakerAlert(
  tenantId: number,
  rule: NormalizedRule,
  message: string,
  executor: Executor,
): Promise<void> {
  try {
    const stableKey = `rule_breaker:${rule.slug}`;
    const existing = await scoped('live_alerts', tenantId, executor)
      .where('live_alerts.stable_key', stableKey)
      .whereNull('live_alerts.read_at')
      .first('id');
    if (existing) return;

    await insertScoped(
      'live_alerts',
      tenantId,
      {
        severity: 'critical',
        title: `Règle désactivée : ${rule.name}`,
        message:
          `La règle « ${rule.name} » (${rule.slug}) a échoué ${CIRCUIT_BREAKER_THRESHOLD} fois de suite `
          + `et a été désactivée automatiquement. Dernière erreur : ${message}`,
        navigate_to: `/config/rule/${rule.slug}`,
        stable_key: stableKey,
      },
      executor,
    );
  } catch (error) {
    log.warn({ tenantId, ruleSlug: rule.slug, err: (error as Error).message },
      'rules: could not raise the breaker alert');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — The execution log
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One entry in `rule_executions.actions`.
 *
 * The column is a jsonb ARRAY (and `decision.service.explainDetailed` parses it
 * as one), so the condition evaluation rides as the FIRST element rather than
 * as a sibling column. That keeps "why did this not match?" in the same row as
 * "what did it do when it did", which is the pair of questions people actually
 * ask together.
 */
export type ExecutionLogEntry =
  | {
    entry: 'evaluation';
    matched: boolean;
    summary: string;
    issues: ConditionEvaluation['issues'];
    trace: ConditionEvaluation['trace'] | null;
  }
  | ({ entry: 'action' } & ActionResult)
  | { entry: 'guardrail'; code: string; message: string; detail: Record<string, unknown> }
  | { entry: 'config'; issues: ActionIssue[] };

export interface RuleExecutionRecord {
  ruleSlug: string;
  ruleVersion: number;
  ticketId: number | null;
  matched: boolean;
  dryRun: boolean;
  durationMs: number;
  error: string | null;
  entries: ExecutionLogEntry[];
  at: string;
  /** Not persisted — carried back to the caller (and to the simulator). */
  trigger: RuleTriggerKind;
  skippedReason?: string;
}

async function writeExecutions(
  tenantId: number,
  records: readonly RuleExecutionRecord[],
  executor: Executor,
): Promise<void> {
  if (records.length === 0) return;
  try {
    await insertScoped(
      'rule_executions',
      tenantId,
      records.map((record) => ({
        ticket_id: record.ticketId,
        rule_slug: record.ruleSlug,
        rule_version: record.ruleVersion,
        at: new Date(record.at),
        matched: record.matched,
        actions: JSON.stringify(record.entries),
        error: record.error,
        duration_ms: record.durationMs,
        dry_run: record.dryRun,
      })),
      executor,
    );
  } catch (error) {
    // The log is the point of this engine, so a failure to write it is worth
    // a loud line — but it must not roll back the ticket work that succeeded.
    log.error({ tenantId, err: (error as Error).message, rows: records.length },
      'rules: could not write rule_executions');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Running the list
// ═════════════════════════════════════════════════════════════════════════════

export interface RuleEngineEvent {
  tenantId: number;
  trigger: RuleTriggerKind;
  ticket: TicketWithRelations;
  previous: TicketWithRelations | null;
  actor: ActorContext;
  trx: Knex.Transaction;
  changedFields?: string[];
  journalEntryId?: number;
  transition?: { slug: string | null; fromStatusSlug: string; toStatusSlug: string };
}

export interface RuleRunOptions {
  /** Force dry run for every rule, whatever the body says. The simulator's lever. */
  dryRun?: boolean;
  /** Evaluate THESE rules instead of the tenant's published set. */
  rules?: NormalizedRule[];
  /** Only these slugs, in the list's own order. */
  onlySlugs?: string[];
  correlationId?: string;
  /** Off for the simulator's inner loop, which batches its own rows. */
  persistExecutions?: boolean;
  now?: string;
  /** Skip the runOnce / cooldown history read (the simulator supplies its own). */
  skipHistory?: boolean;
}

export interface RuleRunResult {
  ticket: TicketWithRelations;
  executions: RuleExecutionRecord[];
  actionsSpent: number;
  guardrails: string[];
  /** True when a matched rule set `stop_processing`. */
  stopped: boolean;
}

/**
 * Evaluate the ordered list against one event.
 *
 * THIS FUNCTION IS THE ONLY EXECUTOR. `ruleSimulator.service.ts` calls it with
 * `dryRun: true` rather than reimplementing it, and that is the single most
 * important design constraint in this slice: a separate simulation
 * implementation drifts from production within one sprint and then lies —
 * quietly, and in the reassuring direction. "Highly configurable" is only a
 * benefit if changing the configuration is safe, and it is only safe if the
 * preview is the real thing.
 */
export async function runRules(
  event: RuleEngineEvent,
  options: RuleRunOptions = {},
): Promise<RuleRunResult> {
  const parent = runStore.getStore();
  const depth = parent ? parent.depth + 1 : 0;
  const now = options.now ?? new Date().toISOString();
  const persist = options.persistExecutions !== false;

  const state: EngineRunState = parent ?? {
    correlationId: options.correlationId ?? randomUUID(),
    depth: 0,
    budget: ACTION_BUDGET,
    tenantId: event.tenantId,
    rootTicketId: event.ticket.id,
    shared: { spent: 0, guardrails: [] },
  };

  const empty = (): RuleRunResult => ({
    ticket: event.ticket,
    executions: [],
    actionsSpent: state.shared.spent,
    guardrails: state.shared.guardrails,
    stopped: false,
  });

  // ── Guardrail 1: loop depth ───────────────────────────────────────────────
  if (depth > MAX_LOOP_DEPTH) {
    const message =
      `Rules re-entered ${depth} deep (max ${MAX_LOOP_DEPTH}). A rule's action is re-triggering the engine. `
      + 'Evaluation stopped — it was NOT truncated silently.';
    state.shared.guardrails.push('loop_depth');
    log.error({ tenantId: event.tenantId, ticketId: event.ticket.id, depth }, message);

    const record: RuleExecutionRecord = {
      ruleSlug: '__loop_guard__',
      ruleVersion: 0,
      ticketId: event.ticket.id,
      matched: false,
      dryRun: options.dryRun === true,
      durationMs: 0,
      error: message,
      at: now,
      trigger: event.trigger,
      entries: [{
        entry: 'guardrail',
        code: 'loop_depth',
        message,
        detail: { depth, max: MAX_LOOP_DEPTH, correlationId: state.correlationId },
      }],
    };
    if (persist) await writeExecutions(event.tenantId, [record], event.trx);
    return { ...empty(), executions: [record] };
  }

  // A nested run gets its own `depth` and the SAME `shared` object — the spread
  // copies the reference, which is exactly what the budget needs.
  const scopedState: EngineRunState = parent ? { ...state, depth } : state;

  return runStore.run(scopedState, async () => {
    const rules = (options.rules ?? (await loadRules(event.tenantId, event.trx)))
      .filter((rule) => rule.enabled)
      .filter((rule) => rule.triggers.includes(event.trigger))
      .filter((rule) => (options.onlySlugs ? options.onlySlugs.includes(rule.slug) : true));

    if (rules.length === 0) return empty();

    // ── What the conditions need, computed once ─────────────────────────────
    const neededContext = new Set<string>();
    for (const rule of rules) for (const field of rule.contextFields) neededContext.add(field);

    const extras = await buildExtras(
      event.tenantId, event.ticket, neededContext, now, event.trx,
    );

    const history = options.skipHistory
      ? new Map<string, { lastAt: string; count: number }>()
      : await loadTicketHistory(event.tenantId, event.ticket.id, rules.map((r) => r.slug), event.trx);

    const identity = await resolveTenantIdentity(event.tenantId, event.trx);

    const changed = new Set(
      (event.changedFields ?? []).map((field) => camelToSnake(field.replace(/^ticket\./, ''))),
    );

    let ticket = event.ticket;
    const executions: RuleExecutionRecord[] = [];
    let stopped = false;

    for (const rule of rules) {
      const started = Date.now();
      const entries: ExecutionLogEntry[] = [];
      let error: string | null = null;
      let matched = false;
      let skippedReason: string | undefined;

      const dryRun = options.dryRun === true || rule.dryRun;

      // ── Guardrail 3: the circuit breaker ─────────────────────────────────
      const breaker = await hydrateBreaker(event.tenantId, rule, event.trx);
      if (breaker.openedAt !== null) {
        skippedReason = 'circuit_open';
        entries.push({
          entry: 'guardrail',
          code: 'circuit_open',
          message:
            `This rule failed ${breaker.failures} times in a row and is switched off until it is fixed `
            + 'or reset. It is NOT quietly skipped: this row is the notice.',
          detail: { openedAt: breaker.openedAt, lastError: breaker.lastError },
        });
        executions.push(makeRecord(rule, event, entries, {
          matched: false, dryRun, error: null, started, now, skippedReason,
        }));
        continue;
      }

      // ── Trigger-field narrowing ──────────────────────────────────────────
      if (
        event.trigger === 'ticket_updated'
        && rule.triggerFields.length > 0
        && changed.size > 0
        && !rule.triggerFields.some((field) => changed.has(field))
      ) {
        skippedReason = 'no_watched_field_changed';
        entries.push({
          entry: 'evaluation',
          matched: false,
          summary: `None of [${rule.triggerFields.join(', ')}] changed.`,
          issues: [],
          trace: null,
        });
        executions.push(makeRecord(rule, event, entries, {
          matched: false, dryRun, error: null, started, now, skippedReason,
        }));
        continue;
      }

      // ── run-once and cooldown ────────────────────────────────────────────
      const past = history.get(rule.slug.toLowerCase());
      if (rule.runOnce && past) {
        skippedReason = 'already_ran_once';
        entries.push({
          entry: 'evaluation',
          matched: false,
          summary: `once_per_ticket — it already fired at ${past.lastAt}.`,
          issues: [],
          trace: null,
        });
        executions.push(makeRecord(rule, event, entries, {
          matched: false, dryRun, error: null, started, now, skippedReason,
        }));
        continue;
      }
      if (rule.cooldownMinutes && past) {
        const sinceMinutes = (new Date(now).getTime() - new Date(past.lastAt).getTime()) / 60_000;
        if (sinceMinutes < rule.cooldownMinutes) {
          skippedReason = 'cooldown';
          entries.push({
            entry: 'evaluation',
            matched: false,
            summary:
              `Cooling down — it fired ${Math.round(sinceMinutes)} min ago and the cooldown is `
              + `${rule.cooldownMinutes} min.`,
            issues: [],
            trace: null,
          });
          executions.push(makeRecord(rule, event, entries, {
            matched: false, dryRun, error: null, started, now, skippedReason,
          }));
          continue;
        }
      }

      // ── The condition, through THE shared evaluator ──────────────────────
      const context = buildRuleContext({
        ticket, previous: event.previous, actor: event.actor, extras, now,
      });
      const evaluation = evaluateCondition(rule.when, context);
      matched = evaluation.matched;

      entries.push({
        entry: 'evaluation',
        matched,
        summary: matched ? 'Condition matched.' : 'Condition did not match.',
        issues: evaluation.issues,
        trace: evaluation.trace,
      });

      if (rule.issues.length > 0) entries.push({ entry: 'config', issues: rule.issues });

      if (!matched) {
        executions.push(makeRecord(rule, event, entries, {
          matched: false, dryRun, error: null, started, now,
        }));
        continue;
      }

      // ── Actions, inside a SAVEPOINT: one rule applies, or it does not ────
      //
      // Two things depend on this savepoint, and both are load-bearing.
      //
      //  1. ISOLATION FROM THE CALLER. A Postgres error in action #2 aborts the
      //     transaction it runs in. Without a savepoint that is the CALLER's
      //     ticket transaction, so the very update the rule was reacting to
      //     would be lost — the engine would be able to destroy the change that
      //     triggered it.
      //
      //  2. PER-RULE ATOMICITY. The first failing action rolls the rule's
      //     earlier actions back and stops the rest. A half-applied rule — the
      //     queue moved, the notification never sent, nobody told — is the state
      //     nobody can reason about later, and it is the one an operator will
      //     eventually have to explain. The actions that were not attempted are
      //     written to the log as `not_attempted`, so the truncation is a fact
      //     in the record rather than an absence somebody has to notice.
      try {
        await event.trx.transaction(async (savepoint) => {
          const ctx = makeActionContext({
            tenantId: event.tenantId,
            identity,
            ticket,
            previous: event.previous,
            actor: event.actor,
            trx: savepoint,
            rule,
            dryRun,
            correlationId: scopedState.correlationId,
            now,
            trigger: event.trigger,
            depth,
            state: scopedState,
            onTicket: (next) => { ticket = next; },
          });

          for (const [position, action] of rule.actions.entries()) {
            if (action.disabled) {
              entries.push({
                entry: 'action',
                index: action.index,
                kind: action.kind,
                performed: false,
                skipped: 'disabled',
                detail: {},
                durationMs: 0,
              });
              continue;
            }
            const result = await performAction(ctx, action);
            entries.push({ entry: 'action', ...result });

            if (result.error) {
              // The rule as a whole has failed once one of its actions has:
              // that is what the breaker counts, and pretending otherwise is
              // how a rule fails forever without anyone noticing.
              for (const remaining of rule.actions.slice(position + 1)) {
                entries.push({
                  entry: 'action',
                  index: remaining.index,
                  kind: remaining.kind,
                  performed: false,
                  skipped: 'not_attempted',
                  detail: { because: `action ${action.index} (${action.kind}) failed` },
                  durationMs: 0,
                });
              }
              throw new ActionFailure(result.error);
            }
          }
        });
      } catch (guardOrDb) {
        if (guardOrDb instanceof ActionFailure) {
          error = guardOrDb.message;
          entries.push({
            entry: 'guardrail',
            code: 'rule_rolled_back',
            message:
              'An action failed, so this rule\'s earlier actions were rolled back and the ones after it were '
              + 'not attempted. The ticket is not left half-changed.',
            detail: { failedWith: guardOrDb.message },
          });
        } else if (guardOrDb instanceof GuardrailError) {
          state.shared.guardrails.push(guardOrDb.code);
          entries.push({
            entry: 'guardrail',
            code: guardOrDb.code,
            message: guardOrDb.message,
            detail: guardOrDb.detail,
          });
          error = guardOrDb.message;
          log.error(
            { tenantId: event.tenantId, ticketId: ticket.id, ruleSlug: rule.slug, code: guardOrDb.code },
            'rules: guardrail stopped the rule',
          );
        } else {
          error = guardOrDb instanceof Error ? guardOrDb.message : String(guardOrDb);
        }

        // The savepoint rolled back, so the in-memory ticket may claim changes
        // the database no longer has. Re-read rather than carry a lie forward.
        const refreshed = await ticketService.getById(event.tenantId, ticket.id, { executor: event.trx });
        if (refreshed) ticket = refreshed;
      }

      if (error) await tripBreaker(event.tenantId, rule, error, event.trx);
      else closeBreaker(event.tenantId, rule);

      executions.push(makeRecord(rule, event, entries, {
        matched: true, dryRun, error, started, now, ticketId: ticket.id,
      }));

      if (rule.stopProcessing) {
        stopped = true;
        break;
      }
      // A guardrail that fired is a stop signal for the whole run, not for one
      // rule: the budget is per ticket, so the next rule would trip it again.
      if (state.shared.guardrails.includes('action_budget')) {
        stopped = true;
        break;
      }
    }

    if (persist) await writeExecutions(event.tenantId, executions, event.trx);

    return {
      ticket,
      executions,
      actionsSpent: scopedState.shared.spent,
      guardrails: scopedState.shared.guardrails,
      stopped,
    };
  });
}

/**
 * Thrown to roll one rule's savepoint back after an action failed. Not an
 * error condition of its own — the real error is already in the log entry that
 * caused it.
 */
class ActionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionFailure';
  }
}

function makeRecord(
  rule: NormalizedRule,
  event: RuleEngineEvent,
  entries: ExecutionLogEntry[],
  meta: {
    matched: boolean;
    dryRun: boolean;
    error: string | null;
    started: number;
    now: string;
    ticketId?: number;
    skippedReason?: string;
  },
): RuleExecutionRecord {
  return {
    ruleSlug: rule.slug,
    ruleVersion: rule.version,
    ticketId: meta.ticketId ?? event.ticket.id,
    matched: meta.matched,
    dryRun: meta.dryRun,
    durationMs: Date.now() - meta.started,
    error: meta.error,
    entries,
    at: meta.now,
    trigger: event.trigger,
    ...(meta.skippedReason ? { skippedReason: meta.skippedReason } : {}),
  };
}

function makeActionContext(input: {
  tenantId: number;
  identity: { slug: string; name: string };
  ticket: TicketWithRelations;
  previous: TicketWithRelations | null;
  actor: ActorContext;
  trx: Knex.Transaction;
  rule: NormalizedRule;
  dryRun: boolean;
  correlationId: string;
  now: string;
  trigger: string;
  depth: number;
  state: EngineRunState;
  onTicket: (ticket: TicketWithRelations) => void;
}): ActionContext {
  const ctx: ActionContext = {
    tenantId: input.tenantId,
    tenantSlug: input.identity.slug,
    tenantName: input.identity.name,
    ticket: input.ticket,
    previous: input.previous,
    actor: input.actor,
    trx: input.trx,
    ruleSlug: input.rule.slug,
    ruleVersion: input.rule.version,
    dryRun: input.dryRun,
    correlationId: input.correlationId,
    now: input.now,
    trigger: input.trigger,
    depth: input.depth,

    spend(kind, cost) {
      input.state.shared.spent += cost;
      if (input.state.shared.spent > input.state.budget) {
        input.state.shared.guardrails.push('action_budget');
        throw new GuardrailError(
          'action_budget',
          `The per-ticket action budget of ${input.state.budget} is exhausted (rule "${input.rule.slug}", `
          + `action "${kind}"). Evaluation stopped rather than half-applied.`,
          {
            spent: input.state.shared.spent,
            budget: input.state.budget,
            rule: input.rule.slug,
            action: kind,
          },
        );
      }
    },

    setTicket(next) {
      ctx.ticket = next;
      input.onTicket(next);
    },

    /**
     * Dry run: fold the intended change into the in-memory ticket so a later
     * rule sees what production would have shown it. Discarding the change
     * instead would make every simulation of a multi-rule chain wrong after
     * the first link.
     */
    shadow(patch) {
      const next = { ...ctx.ticket } as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'data' && value && typeof value === 'object') {
          next.data = { ...(ctx.ticket.data ?? {}), ...(value as Record<string, unknown>) };
          continue;
        }
        if (key === 'priorityOverrideReason') continue;
        next[key] = value;
      }
      const shadowed = next as unknown as TicketWithRelations;
      ctx.ticket = shadowed;
      input.onTicket(shadowed);
    },
  };
  return ctx;
}

/**
 * The last time each of these rules fired on this ticket — one query, not one
 * per rule. `dry_run = false` on purpose: a simulation must never make a rule
 * think it has already run.
 */
async function loadTicketHistory(
  tenantId: number,
  ticketId: number,
  slugs: readonly string[],
  executor: Executor,
): Promise<Map<string, { lastAt: string; count: number }>> {
  const out = new Map<string, { lastAt: string; count: number }>();
  if (slugs.length === 0) return out;

  const rows = (await scoped('rule_executions', tenantId, executor)
    .where('rule_executions.ticket_id', ticketId)
    .where('rule_executions.matched', true)
    .where('rule_executions.dry_run', false)
    .whereIn('rule_executions.rule_slug', slugs as string[])
    .groupBy('rule_executions.rule_slug')
    .select('rule_executions.rule_slug')
    .max({ last_at: 'rule_executions.at' })
    .count({ count: '*' })) as Array<{
    rule_slug: string;
    last_at: string | Date;
    count: string | number;
  }>;

  for (const row of rows) {
    out.set(String(row.rule_slug).toLowerCase(), {
      lastAt: new Date(row.last_at).toISOString(),
      count: Number(row.count ?? 0),
    });
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — The hook into ticket.service
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `ticket.service.ts` calls these inside the ticket's own transaction and
 * swallows anything they throw (`runHook`), so a bad condition in one tenant's
 * automation can never make ticket creation return 500. We still catch here:
 * an error that reaches `runHook` is logged as a decision row with no rule
 * name, and "some rule failed" is a much worse answer than "THIS rule failed".
 */
export const rulesEngineHook: RulesEngineHook = {
  async onTicketCreated(event: RulesEngineEvent) {
    await dispatch('ticket_created', event);
  },
  async onTicketUpdated(event: RulesEngineEvent) {
    const changed = event.changedFields ?? [];
    await dispatch('ticket_updated', event);
    if (changed.some((field) => field === 'assigneeId' || field === 'assignmentGroupId')) {
      await dispatch('assignment_changed', event);
    }
  },
  async onTicketTransitioned(event: RulesEngineEvent) {
    await dispatch('status_changed', event);
  },
  async onJournalAppended(event: RulesEngineEvent) {
    await dispatch('journal_added', event);
  },
};

async function dispatch(trigger: RuleTriggerKind, event: RulesEngineEvent): Promise<void> {
  try {
    await runRules({
      tenantId: event.tenantId,
      trigger,
      ticket: event.ticket as TicketWithRelations,
      previous: (event.previous as TicketWithRelations | null) ?? null,
      actor: event.actor,
      trx: event.trx,
      changedFields: event.changedFields,
      journalEntryId: event.journalEntryId,
      transition: event.transition,
    });
  } catch (error) {
    log.error(
      { tenantId: event.tenantId, ticketId: event.ticket.id, trigger, err: (error as Error).message },
      'rules: engine run failed',
    );
    throw error;
  }
}

let installed = false;

/**
 * Attach the engine. Called on import so a build that includes this file has a
 * working engine without anyone remembering to wire it, and exported so a test
 * (or an explicit boot sequence) can control it.
 */
export function installRulesEngine(): void {
  if (installed) return;
  ticketService.registerRulesEngine(rulesEngineHook);
  installed = true;
  log.info(
    { maxLoopDepth: MAX_LOOP_DEPTH, actionBudget: ACTION_BUDGET, breakerThreshold: CIRCUIT_BREAKER_THRESHOLD },
    'rules engine installed',
  );
}

export function uninstallRulesEngine(): void {
  ticketService.registerRulesEngine(null);
  installed = false;
}

installRulesEngine();

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Reading the log
// ═════════════════════════════════════════════════════════════════════════════

export interface ExecutionQuery {
  ruleSlug?: string;
  ticketId?: number;
  matched?: boolean;
  dryRun?: boolean;
  /** Only rows that carry an error — the "what is broken" filter. */
  errorsOnly?: boolean;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface ExecutionRow {
  id: string;
  ruleSlug: string;
  ruleVersion: number;
  ticketId: number | null;
  at: string;
  matched: boolean;
  dryRun: boolean;
  durationMs: number | null;
  error: string | null;
  entries: ExecutionLogEntry[];
}

export async function listExecutions(
  tenantId: number,
  query: ExecutionQuery = {},
): Promise<{ rows: ExecutionRow[]; total: number; page: number; limit: number }> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const page = Math.max(query.page ?? 1, 1);

  const build = () => {
    const qb = scoped('rule_executions', tenantId);
    if (query.ruleSlug) qb.where('rule_executions.rule_slug', query.ruleSlug);
    if (query.ticketId) qb.where('rule_executions.ticket_id', query.ticketId);
    if (typeof query.matched === 'boolean') qb.where('rule_executions.matched', query.matched);
    if (typeof query.dryRun === 'boolean') qb.where('rule_executions.dry_run', query.dryRun);
    if (query.errorsOnly) qb.whereNotNull('rule_executions.error');
    if (query.from) qb.where('rule_executions.at', '>=', new Date(query.from));
    if (query.to) qb.where('rule_executions.at', '<=', new Date(query.to));
    return qb;
  };

  const countRows = (await build().count({ count: '*' })) as unknown as Array<{ count: string | number }>;
  const total = Number(countRows?.[0]?.count ?? 0);

  const rows = (await build()
    .orderBy('rule_executions.at', 'desc')
    .orderBy('rule_executions.id', 'desc')
    .limit(limit)
    .offset((page - 1) * limit)
    .select('*')) as Array<Record<string, unknown>>;

  return {
    total,
    page,
    limit,
    rows: rows.map((row) => ({
      id: String(row.id),
      ruleSlug: String(row.rule_slug),
      ruleVersion: Number(row.rule_version ?? 1),
      ticketId: row.ticket_id === null || row.ticket_id === undefined ? null : Number(row.ticket_id),
      at: new Date(row.at as string).toISOString(),
      matched: row.matched === true,
      dryRun: row.dry_run === true,
      durationMs: row.duration_ms === null || row.duration_ms === undefined
        ? null
        : Number(row.duration_ms),
      error: (row.error as string | null) ?? null,
      entries: parseEntries(row.actions),
    })),
  };
}

function parseEntries(raw: unknown): ExecutionLogEntry[] {
  if (Array.isArray(raw)) return raw as ExecutionLogEntry[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ExecutionLogEntry[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Persist execution records outside the run that produced them.
 *
 * The simulator needs this: its replay transactions are rolled back on
 * purpose, so rows written inside them would vanish along with the effects
 * they describe. The effects SHOULD vanish; the evidence should not.
 */
export async function recordExecutions(
  tenantId: number,
  records: readonly RuleExecutionRecord[],
  executor: Executor = db,
): Promise<void> {
  await writeExecutions(tenantId, records, executor);
}

/** Per-rule health, for the list screen: has it run, does it work, is it off? */
export interface RuleHealth {
  slug: string;
  runs: number;
  matches: number;
  errors: number;
  lastRunAt: string | null;
  lastErrorAt: string | null;
  breaker: BreakerState | null;
}

export async function ruleHealth(
  tenantId: number,
  slugs: readonly string[],
  windowDays = 30,
): Promise<Map<string, RuleHealth>> {
  const out = new Map<string, RuleHealth>();
  for (const slug of slugs) {
    out.set(slug.toLowerCase(), {
      slug,
      runs: 0,
      matches: 0,
      errors: 0,
      lastRunAt: null,
      lastErrorAt: null,
      breaker: ruleBreakerState(tenantId, slug),
    });
  }
  if (slugs.length === 0) return out;

  const since = new Date(Date.now() - windowDays * 86_400_000);
  const rows = (await scoped('rule_executions', tenantId)
    .whereIn('rule_executions.rule_slug', slugs as string[])
    .where('rule_executions.at', '>=', since)
    // Simulations are excluded: they are what WOULD have happened, and folding
    // them into "does this rule work?" would let a healthy-looking number come
    // entirely from dry runs.
    .where('rule_executions.dry_run', false)
    .groupBy('rule_executions.rule_slug')
    .select('rule_executions.rule_slug')
    .select(db.raw('COUNT(*)::int AS runs'))
    .select(db.raw('SUM(CASE WHEN matched THEN 1 ELSE 0 END)::int AS matches'))
    .select(db.raw('SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)::int AS errors'))
    .select(db.raw('MAX(at) AS last_run'))
    .select(db.raw('MAX(CASE WHEN error IS NOT NULL THEN at END) AS last_error'))) as Array<
    Record<string, unknown>
  >;

  for (const row of rows) {
    const key = String(row.rule_slug).toLowerCase();
    const entry = out.get(key);
    if (!entry) continue;
    entry.runs = Number(row.runs ?? 0);
    entry.matches = Number(row.matches ?? 0);
    entry.errors = Number(row.errors ?? 0);
    entry.lastRunAt = row.last_run ? new Date(row.last_run as string).toISOString() : null;
    entry.lastErrorAt = row.last_error ? new Date(row.last_error as string).toISOString() : null;
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — Scheduled rules
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The sweep for `trigger: schedule` rules.
 *
 * Exported with `start()` / `stop()` in the shape `index.ts`'s `loadWorker`
 * expects, so a boot sequence can pick it up by name without this file
 * importing anything from the entry point. It runs under the SAME leader lock
 * discipline as the SLA ticker: two replicas sweeping means every escalation
 * fires twice.
 */
let scheduleTimer: NodeJS.Timeout | null = null;
let sweeping = false;

export interface ScheduleTickResult {
  tenantsScanned: number;
  rulesRun: number;
  ticketsExamined: number;
  matched: number;
}

export const ruleScheduler = {
  start(options: { intervalMs?: number } = {}): void {
    if (scheduleTimer) return;
    const intervalMs = options.intervalMs ?? envInt('RULES_SCHEDULE_INTERVAL_MS', 60_000);
    scheduleTimer = setInterval(() => {
      void ruleScheduler.tick().catch((error: unknown) => {
        log.error({ err: (error as Error).message }, 'rules: scheduled sweep failed');
      });
    }, intervalMs);
    if (typeof scheduleTimer.unref === 'function') scheduleTimer.unref();
    log.info({ intervalMs }, 'rule scheduler started');
  },

  stop(): void {
    if (!scheduleTimer) return;
    clearInterval(scheduleTimer);
    scheduleTimer = null;
  },

  async tick(): Promise<ScheduleTickResult> {
    const result: ScheduleTickResult = {
      tenantsScanned: 0, rulesRun: 0, ticketsExamined: 0, matched: 0,
    };
    if (sweeping) return result;
    sweeping = true;

    try {
      const tenants = (await db('tenants').select('id')) as Array<{ id: number }>;
      for (const tenant of tenants) {
        const tenantId = Number(tenant.id);
        const rules = (await loadRules(tenantId))
          .filter((rule) => rule.enabled && rule.triggers.includes('schedule'));
        if (rules.length === 0) continue;
        result.tenantsScanned += 1;

        for (const rule of rules) {
          if (!(await scheduleIsDue(tenantId, rule))) continue;
          result.rulesRun += 1;

          const tickets = await candidateTickets(tenantId, rule);
          result.ticketsExamined += tickets.length;

          for (const ticket of tickets) {
            await db.transaction(async (trx) => {
              const run = await runRules(
                {
                  tenantId,
                  trigger: 'schedule',
                  ticket,
                  previous: null,
                  actor: ticketService.systemActor({ actorType: 'system' }),
                  trx,
                },
                { rules: [rule] },
              );
              if (run.executions.some((entry) => entry.matched)) result.matched += 1;
            }).catch((error: unknown) => {
              log.error(
                { tenantId, ruleSlug: rule.slug, ticketId: ticket.id, err: (error as Error).message },
                'rules: scheduled run failed for one ticket',
              );
            });
          }
        }
      }
    } finally {
      sweeping = false;
    }

    return result;
  },
};

/**
 * `every_minutes` honoured against the LOG, not against a process-local timer:
 * a restart must not re-fire every scheduled rule, and two replicas contending
 * for the leader lock must not double-fire the one that wins next.
 */
async function scheduleIsDue(tenantId: number, rule: NormalizedRule): Promise<boolean> {
  if (!rule.schedule?.everyMinutes) return true;

  const row = (await scoped('rule_executions', tenantId)
    .where('rule_executions.rule_slug', rule.slug)
    .where('rule_executions.dry_run', false)
    .max({ last_at: 'rule_executions.at' })
    .first()) as { last_at: string | Date | null } | undefined;

  if (!row?.last_at) return true;
  const sinceMinutes = (Date.now() - new Date(row.last_at).getTime()) / 60_000;
  return sinceMinutes >= rule.schedule.everyMinutes;
}

const OPEN_CATEGORIES: StatusCategory[] = [
  'new', 'open', 'pending_requester', 'pending_third_party', 'scheduled',
];

async function candidateTickets(
  tenantId: number,
  rule: NormalizedRule,
): Promise<TicketWithRelations[]> {
  // A scheduled rule sweeps LIVE tickets only. Re-evaluating a closed ticket
  // every five minutes forever is how a desk with two years of history spends
  // its afternoons scanning tickets nobody will ever look at again.
  const page = await ticketService.list(
    tenantId,
    ticketService.systemActor({ actorType: 'system' }),
    {
      statusCategories: OPEN_CATEGORIES,
      limit: SCHEDULE_TICKET_LIMIT,
      sortBy: 'updated_at',
      sortDir: 'asc',
    },
  );
  void rule;
  return page.items.filter((ticket) => !isTerminal(ticket.statusCategory));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — Editing the list
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Enabling, disabling and reordering all go through the CONFIG STORE — they are
 * not side-channel column updates.
 *
 * That costs an extra publish and it is worth every millisecond: turning a rule
 * off is exactly the kind of change someone needs to explain three weeks later,
 * and routing it through `updateConfigObject` + `publishConfigObject` means it
 * is checksummed, versioned, linted and audited like every other configuration
 * change. A toggle that leaves no version behind is a toggle nobody can account
 * for.
 *
 * An object the tenant does not own (one shared down from the master tenant)
 * is refused by `updateConfigObject`, and that refusal is surfaced rather than
 * swallowed: "your admin disabled it upstream" is a real answer.
 */
export async function setRuleEnabled(
  actor: ConfigActor,
  slug: string,
  enabled: boolean,
): Promise<{ slug: string; enabled: boolean; version: number; status: string }> {
  const current = await getConfigObject(actor, 'rule', slug);
  if (!current) {
    throw new ConfigServiceError(404, `No rule with the slug "${slug}".`, 'not_found');
  }

  const body = { ...(current.body as unknown as Record<string, unknown>), enabled };
  const wasPublished = current.status === 'published';

  await updateConfigObject(actor, 'rule', slug, {
    body,
    note: enabled ? `Rule enabled by ${actor.userId ?? 'system'}` : `Rule disabled by ${actor.userId ?? 'system'}`,
  });

  const result = wasPublished
    ? await publishConfigObject(actor, 'rule', slug, enabled ? 'enabled' : 'disabled')
    : await getConfigObject(actor, 'rule', slug);

  invalidateRuleCache(actor.tenantId);
  // Re-enabling by hand IS the "I fixed it, try again" gesture. Leaving the
  // breaker open after an explicit enable would be the engine arguing with the
  // administrator.
  if (enabled) resetRuleBreaker(actor.tenantId, slug);

  return {
    slug,
    enabled,
    version: result?.version ?? current.version,
    status: result?.status ?? current.status,
  };
}

export interface ReorderOutcome {
  slug: string;
  order: number;
  applied: boolean;
  reason?: string;
}

/**
 * Rewrite the ordered list.
 *
 * Orders are spaced by ten so a later insertion between two rules does not
 * force a rewrite of everything after it. Rules not named in the request keep
 * their own order and are simply sorted around the ones that moved — a reorder
 * that silently renumbered rules the caller never mentioned would be a
 * surprise waiting on the next screen refresh.
 */
export async function reorderRules(
  actor: ConfigActor,
  order: readonly string[],
): Promise<{ outcomes: ReorderOutcome[]; rules: NormalizedRule[] }> {
  const outcomes: ReorderOutcome[] = [];

  for (const [index, slug] of order.entries()) {
    const position = (index + 1) * 10;
    try {
      const current = await getConfigObject(actor, 'rule', slug);
      if (!current) {
        outcomes.push({ slug, order: position, applied: false, reason: 'not_found' });
        continue;
      }

      const body = { ...(current.body as unknown as Record<string, unknown>) };
      if (body.order === position && body.priority === undefined) {
        outcomes.push({ slug, order: position, applied: true });
        continue;
      }
      body.order = position;
      // Both spellings exist in the wild (`RuleBody.priority` in the shared
      // types, `order` in the shipped bodies). Writing only one would leave the
      // other stale and the engine reading whichever it prefers.
      if (body.priority !== undefined) body.priority = position;

      const wasPublished = current.status === 'published';
      await updateConfigObject(actor, 'rule', slug, { body, note: `Reordered to ${position}` });
      if (wasPublished) await publishConfigObject(actor, 'rule', slug, 'reordered');

      outcomes.push({ slug, order: position, applied: true });
    } catch (error) {
      // One rule the tenant may not edit must not abandon the rest of the
      // reorder — the caller gets a per-slug answer, not a single 403.
      outcomes.push({
        slug,
        order: position,
        applied: false,
        reason: error instanceof ConfigServiceError ? error.code : 'error',
      });
    }
  }

  invalidateRuleCache(actor.tenantId);
  return { outcomes, rules: await loadRules(actor.tenantId, db, { fresh: true }) };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13 — Utilities the routes and the simulator need
// ═════════════════════════════════════════════════════════════════════════════

/** The engine's own configuration, so the admin screen can show the limits. */
export function guardrailSettings(): {
  maxLoopDepth: number;
  actionBudget: number;
  breakerThreshold: number;
  cacheTtlMs: number;
  scheduleTicketLimit: number;
} {
  return {
    maxLoopDepth: MAX_LOOP_DEPTH,
    actionBudget: ACTION_BUDGET,
    breakerThreshold: CIRCUIT_BREAKER_THRESHOLD,
    cacheTtlMs: RULE_CACHE_TTL_MS,
    scheduleTicketLimit: SCHEDULE_TICKET_LIMIT,
  };
}

export const ruleService = {
  loadRules,
  runRules,
  listExecutions,
  recordExecutions,
  ruleHealth,
  setRuleEnabled,
  reorderRules,
  invalidateRuleCache,
  resetRuleBreaker,
  ruleBreakerState,
  guardrailSettings,
  normalizeRule,
  installRulesEngine,
  uninstallRulesEngine,
  scheduler: ruleScheduler,
};

export default ruleService;
