/**
 * escalation.service.ts — the escalation ladder engine.
 *
 * ── What an escalation ladder is ────────────────────────────────────────────
 * A published `config_objects` row of `kind = 'escalation'` carrying an
 * `EscalationBody`: one TRIGGER, an optional `appliesWhen`, an ordered list of
 * STEPS (each `afterMinutes` of BUSINESS time after the trigger, each naming
 * who to notify and what to do), and an optional `stopWhen` that cancels the
 * whole ladder the moment the situation resolves itself.
 *
 * Ladders are referenced by SLUG everywhere (HARD RULE 3) — `SlaTargetSpec`
 * points at one through `escalationSlug`, never through an id.
 *
 * ── The one bug this module exists to not have ──────────────────────────────
 * "The ticker ran twice, so the on-call engineer was paged twice at 03:00."
 * That is the classic escalation defect, and it is not solvable by being
 * careful: a read-then-write ("has step 2 fired? no → fire it") loses to two
 * concurrent tickers, to a retried tick, and to a second replica every time.
 *
 * So firing is a CLAIM, not a check:
 *
 *     INSERT INTO escalation_fires (run_id, step_index, repeat_index) …
 *     ON CONFLICT DO NOTHING RETURNING id
 *
 * against `UNIQUE (run_id, step_index, repeat_index)` (migration 003), taken
 * INSIDE the same transaction as the notification and the `decision_log` row.
 * Zero rows back means somebody else owns this step — return, notify nobody.
 * A transaction that rolls back releases the claim with the notification it
 * failed to send, so a retry is correct rather than a duplicate.
 *
 * Arming is idempotent for the same reason, one level up:
 * `UNIQUE (tenant_id, ticket_id, ladder_slug, occurrence_key)`. An SLA warning
 * redelivered by a retrying SLA ticker arms nothing new.
 *
 * ── Business hours ──────────────────────────────────────────────────────────
 * Delegated to `calendar.service` — `addBusinessMinutesOn()` — which is itself
 * a thin wrapper over the pure functions in `@oblidesk/shared`. This module
 * does NOT re-derive business time. A second implementation of "when is the
 * desk open" is a second answer, and the two will disagree on a DST Sunday.
 *
 * ── HARD RULE 2 ─────────────────────────────────────────────────────────────
 * Every arm, every fire, every cancellation and every no-op writes its
 * `decision_log` row through `withDecision()`, on the same code path and in
 * the same transaction as the action. An escalation nobody can explain is an
 * escalation nobody will trust.
 */

import type { Knex } from 'knex';

import {
  DEFAULT_LOCALE,
  SOCKET_EVENTS,
  buildConditionFields,
  describeCondition,
  evaluateCondition,
  isTerminal,
  normalizeCondition,
  toStatusCategory,
  type ConditionEvaluation,
  type ConditionNode,
  type EscalationTrigger,
  type LiveAlert,
  type RuleActionSpec,
  type StatusCategory,
} from '@oblidesk/shared';

import {
  assertTenantId,
  db,
  insertScoped,
  isTenantScoped,
  scoped,
  type Executor,
} from '../db';
import { logger } from '../utils/logger';
import { config as appConfig } from '../config';
import { emitToTicket, emitToUser } from '../socket';
import { withDecision } from './decision.service';
import { loadPublished, loadPublishedOne, type PublishedBody } from './configObject.service';
import { addBusinessMinutesOn } from './calendar.service';
import { notificationService } from './notification.service';
import * as journalService from './journal.service';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Table names and the scoping shim
// ═════════════════════════════════════════════════════════════════════════════

const RUNS = 'escalation_runs';
const FIRES = 'escalation_fires';

/**
 * HARD RULE 1 with a migration in flight.
 *
 * `escalation_runs` / `escalation_fires` arrive in `004_escalation_and_approval_runtime.ts`
 * and are not yet listed in `TENANT_SCOPED_TABLES` (that list lives in
 * `server/src/db/index.ts`, which this module does not own). `scoped()` refuses
 * a table it does not know, so this shim routes through `scoped()` the moment
 * the table IS listed and otherwise applies the identical guard locally.
 *
 * It is deliberately not a general escape hatch: it asserts the tenant id and
 * always qualifies the predicate with the table name, exactly like `scoped()`,
 * so there is no code path here that can produce an unscoped query. When the
 * two names are added to `TENANT_SCOPED_TABLES` this function keeps working
 * unchanged and simply starts delegating.
 */
function scopedRuntime(
  table: string,
  tenantId: number,
  executor: Executor = db,
): Knex.QueryBuilder {
  if (isTenantScoped(table)) return scoped(table, tenantId, executor);
  assertTenantId(tenantId);
  return executor(table).where(`${table}.tenant_id`, tenantId);
}

function insertRuntime<T extends Record<string, unknown>>(
  table: string,
  tenantId: number,
  rows: T | T[],
  executor: Executor = db,
): Knex.QueryBuilder {
  if (isTenantScoped(table)) return insertScoped(table, tenantId, rows, executor);
  assertTenantId(tenantId);
  const list = Array.isArray(rows) ? rows : [rows];
  const stamped = list.map((row) => {
    const existing = (row as { tenant_id?: number }).tenant_id;
    if (existing !== undefined && existing !== null && existing !== tenantId) {
      throw new Error(
        `Tenant isolation: refusing to insert into "${table}" with tenant_id ` +
          `${existing} while scoped to tenant ${tenantId}.`,
      );
    }
    return { ...row, tenant_id: tenantId };
  });
  return executor(table).insert(stamped);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — The normalized ladder
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Notify kinds.
 *
 * `EscalationNotifyTarget` in `@oblidesk/shared` declares six. Two more are
 * accepted here because a ladder without them cannot express what an operator
 * actually asks for:
 *
 *   'on_call'   a deterministic rotation over an assignment group's members.
 *               `ref` is the group slug; `rotation.periodHours` (default 168 —
 *               a week) and `rotation.anchor` (default the Unix epoch) pick the
 *               member. The choice is a pure function of the instant, so a
 *               `decision_log` row replays to the SAME person a year later,
 *               which a shift table read at fire time could never promise.
 *   'watchers'  everybody already watching the ticket.
 *
 * Bodies are read off the database as `Record<string, unknown>`, so accepting
 * a superset here breaks nothing; the shared union should grow to match (see
 * the TODO at the foot of this file).
 */
export type EscalationNotifyKind =
  | 'assignee'
  | 'assignment_group'
  | 'manager_of_assignee'
  | 'user'
  | 'channel'
  | 'requester'
  | 'on_call'
  | 'watchers';

export interface EscalationRotationSpec {
  /** Length of one shift, in hours. Default 168 (one week). */
  periodHours: number;
  /** ISO-8601 instant shift 0 began. Default the Unix epoch. */
  anchor: string;
}

export interface NormalizedNotifyTarget {
  kind: EscalationNotifyKind;
  /** Username / group slug / channel name — never a numeric id (HARD RULE 3). */
  ref: string | null;
  rotation: EscalationRotationSpec | null;
}

export interface NormalizedEscalationStep {
  /** Position in the ladder, 0-based. Stable across a republish that reorders. */
  index: number;
  /** Business minutes after the TRIGGER (not after the previous step). */
  afterMinutes: number;
  calendarSlug: string | null;
  notify: NormalizedNotifyTarget[];
  actions: RuleActionSpec[];
  repeat: boolean;
  /** Total firings of a repeating step, including the first. */
  maxRepeats: number;
  /** Severity of the bell entry / notification this step raises. */
  severity: 'critical' | 'warning' | 'info';
  /** Optional notification template slug (HARD RULE 3). */
  templateSlug: string | null;
  label: string | null;
}

export interface NormalizedLadder {
  slug: string;
  name: string;
  /** Published config version — pinned into every decision_log row. */
  version: number;
  bodyFormatVersion: number;
  trigger: EscalationTrigger;
  appliesWhen: ConditionNode | null;
  stopWhen: ConditionNode | null;
  steps: NormalizedEscalationStep[];
  /** Ladder-wide default; a step may override it. */
  calendarSlug: string | null;
  enabled: boolean;
}

const ESCALATION_TRIGGERS: readonly EscalationTrigger[] = [
  'sla_warning',
  'sla_breach',
  'no_update',
  'unassigned',
  'reopened',
  'priority',
];

/** Triggers this module's own sweep can raise without an external event. */
const SWEEPABLE_TRIGGERS: readonly EscalationTrigger[] = ['no_update', 'unassigned'];

const NOTIFY_KINDS: readonly EscalationNotifyKind[] = [
  'assignee',
  'assignment_group',
  'manager_of_assignee',
  'user',
  'channel',
  'requester',
  'on_call',
  'watchers',
];

const DEFAULT_ROTATION_PERIOD_HOURS = 168;
const DEFAULT_ROTATION_ANCHOR = '1970-01-01T00:00:00.000Z';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeNotifyTarget(raw: unknown): NormalizedNotifyTarget | null {
  if (!isPlainObject(raw)) return null;
  const kind = readString(raw.kind)?.toLowerCase() ?? '';
  if (!(NOTIFY_KINDS as readonly string[]).includes(kind)) return null;

  const rotationRaw = raw.rotation;
  let rotation: EscalationRotationSpec | null = null;
  if (isPlainObject(rotationRaw)) {
    const periodHours =
      readNumber(rotationRaw.periodHours ?? rotationRaw.period_hours) ?? DEFAULT_ROTATION_PERIOD_HOURS;
    rotation = {
      periodHours: periodHours > 0 ? periodHours : DEFAULT_ROTATION_PERIOD_HOURS,
      anchor: readString(rotationRaw.anchor) ?? DEFAULT_ROTATION_ANCHOR,
    };
  } else if (kind === 'on_call') {
    rotation = { periodHours: DEFAULT_ROTATION_PERIOD_HOURS, anchor: DEFAULT_ROTATION_ANCHOR };
  }

  return {
    kind: kind as EscalationNotifyKind,
    ref: readString(raw.ref) ?? readString(raw.slug) ?? readString(raw.username),
    rotation,
  };
}

function normalizeActions(raw: unknown): RuleActionSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: RuleActionSpec[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const type = readString(entry.type);
    if (!type) continue;
    if (entry.disabled === true) continue;
    out.push({
      type: type as RuleActionSpec['type'],
      params: isPlainObject(entry.params) ? entry.params : {},
      disabled: false,
    });
  }
  return out;
}

/**
 * Read an escalation body defensively.
 *
 * Bodies come off `config_objects.body` as untyped JSON and may have been
 * written by an older editor, a bundle import or a hand-edited export. A
 * normaliser that throws turns a cosmetic body problem into a dead engine, so
 * this one never throws: it drops what it cannot read and `validateEscalationDefinition`
 * is what refuses to publish the same body.
 */
export function normalizeEscalationBody(
  slug: string,
  name: string,
  version: number,
  bodyFormatVersion: number,
  raw: unknown,
): NormalizedLadder {
  const body = isPlainObject(raw) ? raw : {};

  const triggerRaw = readString(body.trigger)?.toLowerCase() ?? '';
  const trigger = (ESCALATION_TRIGGERS as readonly string[]).includes(triggerRaw)
    ? (triggerRaw as EscalationTrigger)
    : 'sla_breach';

  const ladderCalendar = readString(body.calendarSlug ?? body.calendar_slug);

  const stepsRaw = Array.isArray(body.steps) ? body.steps.filter(isPlainObject) : [];
  const steps: NormalizedEscalationStep[] = stepsRaw.map((step, index) => {
    const afterMinutes = readNumber(step.afterMinutes ?? step.after_minutes) ?? 0;
    const maxRepeats = readNumber(step.maxRepeats ?? step.max_repeats) ?? 0;
    const severityRaw = readString(step.severity)?.toLowerCase();
    return {
      index,
      afterMinutes: afterMinutes > 0 ? afterMinutes : 0,
      calendarSlug: readString(step.calendarSlug ?? step.calendar_slug) ?? ladderCalendar,
      notify: (Array.isArray(step.notify) ? step.notify : [])
        .map(normalizeNotifyTarget)
        .filter((target): target is NormalizedNotifyTarget => target !== null),
      actions: normalizeActions(step.actions),
      repeat: step.repeat === true,
      // A repeating step with no cap is a pager that never stops. Default to a
      // number an operator would have picked anyway rather than to infinity.
      maxRepeats: step.repeat === true ? Math.max(1, Math.min(maxRepeats || 5, 50)) : 1,
      severity:
        severityRaw === 'critical' || severityRaw === 'info' ? severityRaw : 'warning',
      templateSlug: readString(step.templateSlug ?? step.template_slug),
      label: readString(step.label),
    };
  });

  // Offsets are measured from the trigger, so the ladder only makes sense in
  // ascending order. Sorting here (rather than trusting the author) means a
  // reordered body still escalates in time order — but `index` is assigned
  // BEFORE the sort, so `escalation_fires.step_index` keeps pointing at the
  // same authored step across a republish that only reorders.
  steps.sort((a, b) => a.afterMinutes - b.afterMinutes || a.index - b.index);

  return {
    slug,
    name,
    version,
    bodyFormatVersion,
    trigger,
    appliesWhen: normalizeConditionOrNull(body.appliesWhen ?? body.applies_when),
    stopWhen: normalizeConditionOrNull(body.stopWhen ?? body.stop_when),
    steps,
    calendarSlug: ladderCalendar,
    enabled: body.enabled !== false,
  };
}

function normalizeConditionOrNull(raw: unknown): ConditionNode | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) return null;
  const normalized = normalizeCondition(raw as ConditionNode);
  // `normalizeCondition` turns nothing into `{ all: [] }`, which matches
  // everything. That is the right default for "no restriction", but storing it
  // as a real condition would make the Why drawer claim a test ran.
  if (Array.isArray((normalized as { all?: unknown[] }).all) &&
      (normalized as { all: unknown[] }).all.length === 0) {
    return null;
  }
  return normalized;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Definition validation (the config linter's escalation half)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Codes deliberately drawn from `ConfigLintCode` in `configLinter.service.ts`,
 * so a finding can be mapped straight into a `ConfigLintFinding` with no
 * translation table in between.
 */
export type EscalationFindingCode =
  | 'empty_condition'
  | 'dangling_reference'
  | 'unreachable_state'
  | 'unknown_field';

export interface EscalationFinding {
  severity: 'error' | 'warning' | 'info';
  path: string;
  code: EscalationFindingCode;
  message: string;
}

export interface EscalationLintContext {
  /** Lowercased usernames of active users. */
  usernames?: ReadonlySet<string>;
  /** Lowercased group slug → member count. */
  groups?: ReadonlyMap<string, number>;
  /** Lowercased published calendar slugs. */
  calendars?: ReadonlySet<string>;
  /** Lowercased published notification-template slugs. */
  templates?: ReadonlySet<string>;
}

/**
 * The blocking checks for an escalation ladder.
 *
 * The two that matter are the same two an approval has, for the same reason:
 * a ladder with no steps, or a step that resolves to nobody, is a ladder that
 * runs, writes a decision row saying it ran, and tells no human anything. That
 * is worse than having no ladder, because the operator believes they are
 * covered.
 *
 * Pure — no I/O. `configLinter.service.ts` supplies the directory context it
 * already built for its other checks (see the TODO at the foot of this file).
 */
export function validateEscalationDefinition(
  raw: unknown,
  ctx: EscalationLintContext = {},
): EscalationFinding[] {
  const out: EscalationFinding[] = [];
  const push = (
    severity: EscalationFinding['severity'],
    path: string,
    code: EscalationFindingCode,
    message: string,
  ): void => { out.push({ severity, path, code, message }); };

  if (!isPlainObject(raw)) {
    push('error', '', 'empty_condition', 'The escalation body is not a JSON object.');
    return out;
  }

  const triggerRaw = readString(raw.trigger)?.toLowerCase() ?? '';
  if (!(ESCALATION_TRIGGERS as readonly string[]).includes(triggerRaw)) {
    push('error', 'trigger', 'unknown_field',
      `Unknown escalation trigger "${triggerRaw}". Expected one of: ${ESCALATION_TRIGGERS.join(', ')}.`);
  }

  const ladder = normalizeEscalationBody('(candidate)', '(candidate)', 0, 1, raw);

  if (ladder.steps.length === 0) {
    push('error', 'steps', 'empty_condition',
      'An escalation with no steps arms, waits, and tells nobody anything. Every ticket that trips its trigger silently believes it is covered.');
    return out;
  }

  ladder.steps.forEach((step, position) => {
    const path = `steps[${position}]`;

    if (step.afterMinutes <= 0 && position > 0) {
      push('warning', `${path}.afterMinutes`, 'unreachable_state',
        `Step ${position + 1} fires at the same instant as the trigger. Two steps with the same offset both fire on the first sweep, which is almost never what "escalate after…" was meant to say.`);
    }

    if (step.notify.length === 0 && step.actions.length === 0) {
      push('error', path, 'empty_condition',
        `Step ${position + 1} notifies nobody and does nothing. It burns a rung of the ladder and produces only a log line.`);
    }

    let reachable = 0;
    step.notify.forEach((target, targetIndex) => {
      const targetPath = `${path}.notify[${targetIndex}]`;
      switch (target.kind) {
        case 'user': {
          if (!target.ref) {
            push('error', targetPath, 'empty_condition', 'A notify target of kind "user" with no username.');
            return;
          }
          if (ctx.usernames && !ctx.usernames.has(target.ref.toLowerCase())) {
            push('error', targetPath, 'dangling_reference',
              `No active user is named "${target.ref}". Notify targets are referenced by username, never by id (HARD RULE 3).`);
            return;
          }
          reachable += 1;
          return;
        }
        case 'assignment_group':
        case 'on_call': {
          // A bare `assignment_group` with no ref means "the ticket's own
          // group", which is resolvable at run time and always legitimate.
          if (!target.ref) {
            if (target.kind === 'on_call') {
              push('error', targetPath, 'empty_condition',
                'An on-call rotation needs the assignment group it rotates over.');
              return;
            }
            reachable += 1;
            return;
          }
          const members = ctx.groups?.get(target.ref.toLowerCase());
          if (ctx.groups && members === undefined) {
            push('error', targetPath, 'dangling_reference',
              `No assignment group has the slug "${target.ref}".`);
            return;
          }
          if (members === 0) {
            push('error', targetPath, 'empty_condition',
              `The assignment group "${target.ref}" has no members, so this step escalates to nobody.`);
            return;
          }
          reachable += 1;
          return;
        }
        case 'channel': {
          if (!target.ref) {
            push('error', targetPath, 'empty_condition', 'A notify target of kind "channel" with no channel name.');
            return;
          }
          reachable += 1;
          return;
        }
        default:
          // assignee / requester / manager_of_assignee / watchers all resolve
          // from the ticket at fire time. Assume reachable and let the fire's
          // own decision_log row explain a miss.
          reachable += 1;
      }
    });

    if (step.notify.length > 0 && reachable === 0) {
      push('error', `${path}.notify`, 'empty_condition',
        `Step ${position + 1} resolves to zero reachable recipients.`);
    }

    if (step.calendarSlug && ctx.calendars && !ctx.calendars.has(step.calendarSlug.toLowerCase())) {
      push('error', `${path}.calendarSlug`, 'dangling_reference',
        `No calendar object has the slug "${step.calendarSlug}". Business-hours offsets would silently fall back to the tenant default.`);
    }
    if (step.templateSlug && ctx.templates && !ctx.templates.has(step.templateSlug.toLowerCase())) {
      push('error', `${path}.templateSlug`, 'dangling_reference',
        `No notification_template object has the slug "${step.templateSlug}".`);
    }
  });

  if (ladder.calendarSlug && ctx.calendars && !ctx.calendars.has(ladder.calendarSlug.toLowerCase())) {
    push('error', 'calendarSlug', 'dangling_reference',
      `No calendar object has the slug "${ladder.calendarSlug}".`);
  }

  return out;
}

/**
 * Build a lint context from the database, so the routes' save path checks the
 * same things the publish gate does. The config linter builds an equivalent one
 * of its own and passes it straight in.
 */
export async function buildEscalationLintContext(
  tenantId: number,
  executor: Executor = db,
): Promise<EscalationLintContext> {
  assertTenantId(tenantId);

  const [users, groups, calendars, templates] = await Promise.all([
    // `users` / `user_tenants` are GLOBAL tables — db() is correct for them.
    executor('users')
      .join('user_tenants', 'user_tenants.user_id', 'users.id')
      .where('user_tenants.tenant_id', tenantId)
      .where('users.is_active', true)
      .select('users.username') as Promise<Array<{ username: string }>>,
    scoped('assignment_groups', tenantId, executor)
      .where('assignment_groups.is_active', true)
      .select('assignment_groups.slug', 'assignment_groups.member_user_ids') as Promise<
        Array<{ slug: string; member_user_ids: unknown }>
      >,
    loadPublished(tenantId, 'calendar', executor),
    loadPublished(tenantId, 'notification_template', executor),
  ]);

  return {
    usernames: new Set(users.map((row) => String(row.username).toLowerCase())),
    groups: new Map(
      groups.map((row) => [
        String(row.slug).toLowerCase(),
        Array.isArray(row.member_user_ids) ? row.member_user_ids.length : 0,
      ]),
    ),
    calendars: new Set([...calendars.keys()]),
    templates: new Set([...templates.keys()]),
  };
}

export class EscalationServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = 'validation_failed',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'EscalationServiceError';
  }
}

/** Throw unless the body is publishable. Used by the routes' save path. */
export function assertEscalationDefinitionSavable(
  raw: unknown,
  ctx: EscalationLintContext = {},
): void {
  const findings = validateEscalationDefinition(raw, ctx);
  const blocking = findings.filter((finding) => finding.severity === 'error');
  if (blocking.length > 0) {
    throw new EscalationServiceError(
      422,
      'This escalation ladder cannot be saved as it stands.',
      'validation_failed',
      findings,
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Loading ladders
// ═════════════════════════════════════════════════════════════════════════════

function toLadder(published: PublishedBody): NormalizedLadder {
  return normalizeEscalationBody(
    published.slug,
    published.name,
    published.version,
    published.bodyFormatVersion,
    published.body,
  );
}

/** Every published ladder for a tenant, keyed by lowercased slug. */
export async function listLadders(
  tenantId: number,
  executor: Executor = db,
): Promise<NormalizedLadder[]> {
  const published = await loadPublished(tenantId, 'escalation', executor);
  return [...published.values()].map(toLadder).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** One published ladder, or null. Never throws for "not configured". */
export async function loadLadder(
  tenantId: number,
  slug: string,
  executor: Executor = db,
): Promise<NormalizedLadder | null> {
  const published = await loadPublishedOne(tenantId, 'escalation', slug, executor);
  return published ? toLadder(published) : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Rows
// ═════════════════════════════════════════════════════════════════════════════

export type EscalationRunState = 'armed' | 'completed' | 'stopped' | 'cancelled';

export interface EscalationRunRow {
  id: number;
  tenant_id: number;
  ticket_id: number;
  ladder_slug: string;
  ladder_version: number;
  trigger: string;
  occurrence_key: string;
  state: EscalationRunState;
  armed_at: Date | string;
  anchor_at: Date | string;
  calendar_slug: string | null;
  next_due_at: Date | string | null;
  next_step_index: number;
  next_repeat_index: number;
  context: Record<string, unknown> | string;
  closed_at: Date | string | null;
  close_reason: string | null;
}

export interface EscalationRun {
  id: number;
  tenantId: number;
  ticketId: number;
  ladderSlug: string;
  ladderVersion: number;
  trigger: string;
  occurrenceKey: string;
  state: EscalationRunState;
  armedAt: string;
  anchorAt: string;
  calendarSlug: string | null;
  nextDueAt: string | null;
  nextStepIndex: number;
  nextRepeatIndex: number;
  context: Record<string, unknown>;
  closedAt: string | null;
  closeReason: string | null;
}

export interface EscalationFire {
  id: number;
  runId: number;
  ticketId: number;
  stepIndex: number;
  repeatIndex: number;
  dueAt: string | null;
  firedAt: string;
  notified: ResolvedRecipient[];
  actions: Array<Record<string, unknown>>;
  error: string | null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

function mapRun(row: EscalationRunRow): EscalationRun {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    ticketId: Number(row.ticket_id),
    ladderSlug: String(row.ladder_slug),
    ladderVersion: Number(row.ladder_version) || 1,
    trigger: String(row.trigger),
    occurrenceKey: String(row.occurrence_key),
    state: row.state,
    armedAt: toIso(row.armed_at) ?? new Date().toISOString(),
    anchorAt: toIso(row.anchor_at) ?? new Date().toISOString(),
    calendarSlug: row.calendar_slug === null ? null : String(row.calendar_slug),
    nextDueAt: toIso(row.next_due_at),
    nextStepIndex: Number(row.next_step_index) || 0,
    nextRepeatIndex: Number(row.next_repeat_index) || 0,
    context: parseJson<Record<string, unknown>>(row.context, {}),
    closedAt: toIso(row.closed_at),
    closeReason: row.close_reason,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — The ticket snapshot the engine evaluates against
// ═════════════════════════════════════════════════════════════════════════════

interface TicketSnapshot {
  id: number;
  number: string;
  subject: string;
  statusSlug: string;
  statusCategory: StatusCategory;
  prioritySlug: string;
  queueSlug: string;
  assigneeId: number | null;
  assignmentGroupId: number | null;
  requesterUserId: number | null;
  requesterContactId: number | null;
  organizationId: number | null;
  recordType: string;
  createdAt: string;
  updatedAt: string;
  occurredAt: string | null;
  dueAt: string | null;
  reopenCount: number;
  data: Record<string, unknown>;
}

const TICKET_COLUMNS = [
  'tickets.id',
  'tickets.number',
  'tickets.subject',
  'tickets.status_slug',
  'tickets.status_category',
  'tickets.priority_slug',
  'tickets.queue_slug',
  'tickets.assignee_id',
  'tickets.assignment_group_id',
  'tickets.requester_user_id',
  'tickets.requester_contact_id',
  'tickets.organization_id',
  'tickets.record_type',
  'tickets.created_at',
  'tickets.updated_at',
  'tickets.occurred_at',
  'tickets.due_at',
  'tickets.reopen_count',
  'tickets.data',
];

async function loadTicketSnapshot(
  tenantId: number,
  ticketId: number,
  executor: Executor = db,
): Promise<TicketSnapshot | null> {
  const row = (await scoped('tickets', tenantId, executor)
    .where('tickets.id', ticketId)
    .whereNull('tickets.deleted_at')
    .first(...TICKET_COLUMNS)) as Record<string, unknown> | undefined;
  return row ? mapTicketSnapshot(row) : null;
}

function mapTicketSnapshot(row: Record<string, unknown>): TicketSnapshot {
  return {
    id: Number(row.id),
    number: String(row.number ?? ''),
    subject: String(row.subject ?? ''),
    statusSlug: String(row.status_slug ?? ''),
    statusCategory: toStatusCategory(row.status_category, 'open'),
    prioritySlug: String(row.priority_slug ?? ''),
    queueSlug: String(row.queue_slug ?? ''),
    assigneeId: row.assignee_id === null || row.assignee_id === undefined ? null : Number(row.assignee_id),
    assignmentGroupId:
      row.assignment_group_id === null || row.assignment_group_id === undefined
        ? null
        : Number(row.assignment_group_id),
    requesterUserId:
      row.requester_user_id === null || row.requester_user_id === undefined
        ? null
        : Number(row.requester_user_id),
    requesterContactId:
      row.requester_contact_id === null || row.requester_contact_id === undefined
        ? null
        : Number(row.requester_contact_id),
    organizationId:
      row.organization_id === null || row.organization_id === undefined ? null : Number(row.organization_id),
    recordType: String(row.record_type ?? 'incident'),
    createdAt: toIso(row.created_at as Date) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at as Date) ?? new Date().toISOString(),
    occurredAt: toIso(row.occurred_at as Date),
    dueAt: toIso(row.due_at as Date),
    reopenCount: Number(row.reopen_count) || 0,
    data: parseJson<Record<string, unknown>>(row.data, {}),
  };
}

/**
 * The condition context. Both dotted (`ticket.priority_slug`) and bare
 * (`priority_slug`) spellings are present, because shipped bodies use both and
 * an unknown field evaluates FALSE — which would silently disarm a ladder.
 */
function conditionContextFor(
  ticket: TicketSnapshot,
  extras: Record<string, unknown>,
  now: string,
): { fields: Record<string, unknown>; now: string } {
  const base: Record<string, unknown> = {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    status_slug: ticket.statusSlug,
    status_category: ticket.statusCategory,
    priority_slug: ticket.prioritySlug,
    queue_slug: ticket.queueSlug,
    assignee_id: ticket.assigneeId,
    assignment_group_id: ticket.assignmentGroupId,
    requester_user_id: ticket.requesterUserId,
    requester_contact_id: ticket.requesterContactId,
    organization_id: ticket.organizationId,
    record_type: ticket.recordType,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
    occurred_at: ticket.occurredAt,
    due_at: ticket.dueAt,
    reopen_count: ticket.reopenCount,
  };

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    fields[key] = value;
    fields[`ticket.${key}`] = value;
  }
  for (const [key, value] of Object.entries(ticket.data)) {
    fields[`data.${key}`] = value;
    fields[`ticket.data.${key}`] = value;
  }
  for (const [key, value] of Object.entries(extras)) {
    fields[key] = value;
    fields[`escalation.${key}`] = value;
  }

  return { fields: buildConditionFields(fields), now };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Arming
// ═════════════════════════════════════════════════════════════════════════════

export interface ArmEscalationInput {
  tenantId: number;
  ticketId: number;
  /** The ladder, by SLUG (HARD RULE 3). */
  ladderSlug: string;
  /** Which trigger fired. A ladder answers exactly one. */
  trigger: EscalationTrigger;
  /**
   * What makes THIS arming distinct from the last. Two arms with the same key
   * are the same event redelivered and the second is a no-op. Defaults to the
   * trigger plus the anchor instant, which is right for everything except an
   * SLA event (pass `sla:<instanceId>:warning`).
   */
  occurrenceKey?: string;
  /** The instant step offsets are measured from. Defaults to now. */
  anchorAt?: string | Date;
  /** Anything the Why drawer should show: sla instance id, target slug… */
  context?: Record<string, unknown>;
  actorId?: number | null;
  actorType?: string;
  correlationId?: string;
  /** THE caller's transaction. Pass it. */
  trx?: Executor;
}

export interface ArmEscalationResult {
  armed: boolean;
  run: EscalationRun | null;
  reason:
    | 'armed'
    | 'already_armed'
    | 'ladder_missing'
    | 'ladder_disabled'
    | 'trigger_mismatch'
    | 'no_steps'
    | 'not_applicable'
    | 'already_stopped'
    | 'ticket_missing'
    | 'ticket_terminal';
}

/**
 * Arm a ladder against a ticket. Idempotent per (ticket, ladder, occurrence).
 *
 * Everything that can decline is a FACT, not a silence: each branch writes its
 * own `decision_log` row saying which ladder was considered and why it did not
 * arm. "Why did nothing escalate?" is the question that gets asked at 09:00 the
 * morning after, and it has to have an answer.
 */
export async function arm(input: ArmEscalationInput): Promise<ArmEscalationResult> {
  const { tenantId, ticketId } = input;
  assertTenantId(tenantId);

  const executor = input.trx ?? db;
  const anchorAt = toIso(input.anchorAt ?? new Date()) ?? new Date().toISOString();
  const occurrenceKey = (input.occurrenceKey ?? `${input.trigger}:${anchorAt}`).slice(0, 160);
  const context = { ...(input.context ?? {}), trigger: input.trigger, anchorAt };

  return withDecision<ArmEscalationResult>(
    {
      tenantId,
      ticketId,
      subsystem: 'escalation',
      ruleSlug: input.ladderSlug,
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? 'system',
      correlationId: input.correlationId,
      trx: executor,
    },
    async (recorder) => {
      recorder.input({
        ladderSlug: input.ladderSlug,
        trigger: input.trigger,
        occurrenceKey,
        anchorAt,
        context: input.context ?? {},
      });

      const ladder = await loadLadder(tenantId, input.ladderSlug, executor);
      if (!ladder) {
        recorder
          .decide(`escalation "${input.ladderSlug}" not armed — no published ladder with that slug`)
          .noop('ladder_missing');
        return { armed: false, run: null, reason: 'ladder_missing' };
      }
      recorder.rule(ladder.slug, ladder.version);

      if (!ladder.enabled) {
        recorder.decide(`escalation "${ladder.slug}" not armed — the ladder is disabled`).noop('ladder_disabled');
        return { armed: false, run: null, reason: 'ladder_disabled' };
      }
      if (ladder.trigger !== input.trigger) {
        recorder
          .decide(`escalation "${ladder.slug}" not armed — it answers "${ladder.trigger}", not "${input.trigger}"`)
          .noop('trigger_mismatch');
        return { armed: false, run: null, reason: 'trigger_mismatch' };
      }
      if (ladder.steps.length === 0) {
        recorder.decide(`escalation "${ladder.slug}" not armed — it has no steps`).noop('no_steps');
        return { armed: false, run: null, reason: 'no_steps' };
      }

      const ticket = await loadTicketSnapshot(tenantId, ticketId, executor);
      if (!ticket) {
        recorder.decide(`escalation "${ladder.slug}" not armed — ticket ${ticketId} is gone`).noop('ticket_missing');
        return { armed: false, run: null, reason: 'ticket_missing' };
      }
      if (isTerminal(ticket.statusCategory)) {
        recorder
          .decide(`escalation "${ladder.slug}" not armed — ${ticket.number} is already ${ticket.statusCategory}`)
          .noop('ticket_terminal');
        return { armed: false, run: null, reason: 'ticket_terminal' };
      }

      const ctx = conditionContextFor(ticket, context, anchorAt);

      if (ladder.appliesWhen) {
        const evaluation = evaluateCondition(ladder.appliesWhen, ctx);
        recorder.evaluation(evaluation);
        if (!evaluation.matched) {
          recorder
            .decide(
              `escalation "${ladder.slug}" not armed on ${ticket.number} — ${describeCondition(ladder.appliesWhen)} is false`,
            )
            .noop('not_applicable');
          return { armed: false, run: null, reason: 'not_applicable' };
        }
      }

      if (ladder.stopWhen) {
        const stop: ConditionEvaluation = evaluateCondition(ladder.stopWhen, ctx);
        if (stop.matched) {
          recorder
            .decide(
              `escalation "${ladder.slug}" not armed on ${ticket.number} — its stop condition already holds`,
            )
            .trace(stop.trace)
            .noop('already_stopped');
          return { armed: false, run: null, reason: 'already_stopped' };
        }
      }

      const firstStep = ladder.steps[0];
      const calendarSlug = firstStep.calendarSlug ?? ladder.calendarSlug;
      const nextDueAt = await addBusinessMinutesOn(
        tenantId,
        calendarSlug,
        anchorAt,
        firstStep.afterMinutes,
        executor,
      );

      // ── The arming claim (HARD RULE: idempotent per occurrence) ──────────
      const inserted = (await insertRuntime(
        RUNS,
        tenantId,
        {
          ticket_id: ticketId,
          ladder_slug: ladder.slug,
          ladder_version: ladder.version,
          trigger: ladder.trigger,
          occurrence_key: occurrenceKey,
          state: 'armed',
          anchor_at: new Date(anchorAt),
          calendar_slug: calendarSlug,
          next_due_at: new Date(nextDueAt),
          next_step_index: 0,
          next_repeat_index: 0,
          context: JSON.stringify(context),
        },
        executor,
      )
        .onConflict(['tenant_id', 'ticket_id', 'ladder_slug', 'occurrence_key'])
        .ignore()
        .returning('*')) as unknown as EscalationRunRow[];

      if (!inserted || inserted.length === 0) {
        recorder
          .decide(
            `escalation "${ladder.slug}" already armed on ${ticket.number} for this occurrence — not armed twice`,
          )
          .outcome({ result: 'idempotent', occurrenceKey });
        return { armed: false, run: null, reason: 'already_armed' };
      }

      const run = mapRun(inserted[0]);
      recorder
        .decide(
          `escalation "${ladder.slug}" armed on ${ticket.number} by ${ladder.trigger}; ` +
            `step 1 of ${ladder.steps.length} due ${nextDueAt}`,
        )
        .outcome({
          result: 'armed',
          runId: run.id,
          stepCount: ladder.steps.length,
          nextDueAt,
          calendarSlug,
          occurrenceKey,
        });

      // No socket frame on ARMING, deliberately. `SOCKET_EVENTS` has no
      // escalation event, and borrowing `sla:warning` to mean "a ladder is
      // armed" would make the client show an SLA warning for a ticket whose
      // clock is fine. The frames go out when a step actually FIRES, which is
      // the moment a human needs to know something.
      return { armed: true, run, reason: 'armed' };
    },
  );
}

/**
 * Supersede every armed run of one ladder on one ticket whose occurrence key is
 * NOT the given one. This is what makes a `no_update` ladder self-correcting:
 * a fresh reply lands, the new occurrence arms, and the old ladder — which was
 * about to page somebody about a ticket that just moved — is closed.
 */
async function supersedeOtherOccurrences(
  tenantId: number,
  ticketId: number,
  ladderSlug: string,
  keepOccurrenceKey: string,
  executor: Executor,
): Promise<number> {
  return (await scopedRuntime(RUNS, tenantId, executor)
    .where(`${RUNS}.ticket_id`, ticketId)
    .where(`${RUNS}.ladder_slug`, ladderSlug)
    .where(`${RUNS}.state`, 'armed')
    .whereNot(`${RUNS}.occurrence_key`, keepOccurrenceKey)
    .update({
      state: 'cancelled',
      closed_at: new Date(),
      close_reason: 'superseded',
      next_due_at: null,
      updated_at: new Date(),
    })) as unknown as number;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Cancellation
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Close every armed ladder on a ticket. Call it from the transition that
 * resolves, closes or cancels the ticket — an escalation that keeps paging
 * about a ticket somebody already fixed is how a pager gets ignored.
 */
export async function cancelForTicket(
  tenantId: number,
  ticketId: number,
  reason = 'cancelled',
  options: { trx?: Executor; actorId?: number | null; correlationId?: string } = {},
): Promise<number> {
  assertTenantId(tenantId);
  const executor = options.trx ?? db;

  return withDecision<number>(
    {
      tenantId,
      ticketId,
      subsystem: 'escalation',
      actorId: options.actorId ?? null,
      actorType: 'system',
      correlationId: options.correlationId,
      trx: executor,
    },
    async (recorder) => {
      const armed = (await scopedRuntime(RUNS, tenantId, executor)
        .where(`${RUNS}.ticket_id`, ticketId)
        .where(`${RUNS}.state`, 'armed')
        .select(`${RUNS}.id`, `${RUNS}.ladder_slug`)) as Array<{ id: number; ladder_slug: string }>;

      if (armed.length === 0) {
        recorder.decide('no armed escalation ladder to cancel').noop('nothing_armed');
        return 0;
      }

      await scopedRuntime(RUNS, tenantId, executor)
        .whereIn(`${RUNS}.id`, armed.map((row) => Number(row.id)))
        .update({
          state: 'cancelled',
          closed_at: new Date(),
          close_reason: reason.slice(0, 32),
          next_due_at: null,
          updated_at: new Date(),
        });

      recorder
        .decide(
          `cancelled ${armed.length} armed escalation ladder${armed.length === 1 ? '' : 's'} (${reason})`,
        )
        .outcome({
          result: 'cancelled',
          reason,
          runIds: armed.map((row) => Number(row.id)),
          ladders: armed.map((row) => String(row.ladder_slug)),
        });

      return armed.length;
    },
  );
}

/** Close one run by id. Returns false when it was not armed. */
export async function cancelRun(
  tenantId: number,
  runId: number,
  reason = 'cancelled',
  options: { trx?: Executor; actorId?: number | null } = {},
): Promise<boolean> {
  assertTenantId(tenantId);
  const executor = options.trx ?? db;

  const run = (await scopedRuntime(RUNS, tenantId, executor)
    .where(`${RUNS}.id`, runId)
    .first()) as EscalationRunRow | undefined;
  if (!run) throw new EscalationServiceError(404, `No escalation run ${runId}.`, 'not_found');
  if (run.state !== 'armed') return false;

  return withDecision<boolean>(
    {
      tenantId,
      ticketId: Number(run.ticket_id),
      subsystem: 'escalation',
      ruleSlug: String(run.ladder_slug),
      ruleVersion: Number(run.ladder_version) || 1,
      actorId: options.actorId ?? null,
      actorType: options.actorId ? 'user' : 'system',
      trx: executor,
    },
    async (recorder) => {
      await scopedRuntime(RUNS, tenantId, executor)
        .where(`${RUNS}.id`, runId)
        .update({
          state: 'cancelled',
          closed_at: new Date(),
          close_reason: reason.slice(0, 32),
          next_due_at: null,
          updated_at: new Date(),
        });
      recorder
        .decide(`escalation "${run.ladder_slug}" cancelled at step ${Number(run.next_step_index) + 1} (${reason})`)
        .outcome({ result: 'cancelled', runId, reason });
      return true;
    },
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — Recipient resolution
// ═════════════════════════════════════════════════════════════════════════════

export interface ResolvedRecipient {
  kind: EscalationNotifyKind;
  /** The configured reference, verbatim, so the row replays. */
  ref: string | null;
  userId: number | null;
  username: string | null;
  displayName: string | null;
  email: string | null;
  /** Populated for `kind: 'channel'`. */
  channel: string | null;
  /** Why this person and not another — the on-call rotation slot, mainly. */
  note: string | null;
}

interface DirectoryUser {
  id: number;
  username: string;
  display_name: string | null;
  email: string | null;
}

async function usersByIds(ids: number[], executor: Executor): Promise<Map<number, DirectoryUser>> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (unique.length === 0) return new Map();
  // `users` is a GLOBAL table (see GLOBAL_TABLES) — db() is correct here.
  const rows = (await executor('users')
    .whereIn('id', unique)
    .where('is_active', true)
    .select('id', 'username', 'display_name', 'email')) as DirectoryUser[];
  return new Map(rows.map((row) => [Number(row.id), row]));
}

async function groupMembers(
  tenantId: number,
  options: { slug?: string | null; id?: number | null },
  executor: Executor,
): Promise<{ id: number; slug: string; memberIds: number[] } | null> {
  const qb = scoped('assignment_groups', tenantId, executor).where('assignment_groups.is_active', true);
  if (options.slug) qb.where('assignment_groups.slug', options.slug);
  else if (options.id) qb.where('assignment_groups.id', options.id);
  else return null;

  const row = (await qb.first(
    'assignment_groups.id',
    'assignment_groups.slug',
    'assignment_groups.member_user_ids',
  )) as { id: number; slug: string; member_user_ids: unknown } | undefined;
  if (!row) return null;

  const raw = row.member_user_ids;
  const memberIds = Array.isArray(raw)
    ? raw.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
    : [];
  return { id: Number(row.id), slug: String(row.slug), memberIds };
}

/**
 * "Managers" of a tenant.
 *
 * There is no `users.manager_user_id` anywhere in 001/002 — the desk has no
 * org chart — so `manager_of_assignee` resolves to the people the tenant has
 * actually named as managers: `user_tenants.role IN ('manager', 'admin')`,
 * managers first. That is a heuristic and it is written down as one rather than
 * pretended to be a lookup; see the TODO at the foot of this file.
 */
async function tenantManagers(tenantId: number, executor: Executor): Promise<number[]> {
  const rows = (await executor('user_tenants')
    .join('users', 'users.id', 'user_tenants.user_id')
    .where('user_tenants.tenant_id', tenantId)
    .whereIn('user_tenants.role', ['manager', 'admin'])
    .where('users.is_active', true)
    .orderByRaw("CASE WHEN user_tenants.role = 'manager' THEN 0 ELSE 1 END")
    .select('users.id')) as Array<{ id: number }>;
  return rows.map((row) => Number(row.id));
}

/**
 * Which member of a rotation is on call at `atISO`.
 *
 * A pure function of the instant, the anchor and the period — never a clock
 * read and never a table lookup — so a `decision_log` row written today still
 * names the same engineer when it is replayed next year. Members are sorted by
 * id so the order does not depend on however Postgres returned the array.
 */
export function onCallMemberIndex(
  memberCount: number,
  atISO: string,
  rotation: EscalationRotationSpec,
): number {
  if (memberCount <= 0) return -1;
  const atMs = new Date(atISO).getTime();
  const anchorMs = new Date(rotation.anchor).getTime();
  if (!Number.isFinite(atMs) || !Number.isFinite(anchorMs)) return 0;
  const periodMs = Math.max(1, rotation.periodHours) * 3_600_000;
  const slot = Math.floor((atMs - anchorMs) / periodMs);
  // `%` keeps the sign of the dividend in JS; an instant before the anchor must
  // still land on a real member.
  return ((slot % memberCount) + memberCount) % memberCount;
}

async function resolveRecipients(
  tenantId: number,
  ticket: TicketSnapshot,
  targets: readonly NormalizedNotifyTarget[],
  atISO: string,
  executor: Executor,
): Promise<ResolvedRecipient[]> {
  const out: ResolvedRecipient[] = [];
  const seen = new Set<string>();

  const push = (recipient: ResolvedRecipient): void => {
    const key = recipient.userId !== null
      ? `u:${recipient.userId}`
      : recipient.channel !== null
        ? `c:${recipient.channel.toLowerCase()}`
        : `x:${recipient.kind}:${recipient.ref ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(recipient);
  };

  const pendingUserIds: Array<{ id: number; kind: EscalationNotifyKind; ref: string | null; note: string | null }> = [];

  for (const target of targets) {
    switch (target.kind) {
      case 'assignee': {
        if (ticket.assigneeId) {
          pendingUserIds.push({ id: ticket.assigneeId, kind: target.kind, ref: null, note: 'ticket assignee' });
        }
        break;
      }
      case 'requester': {
        if (ticket.requesterUserId) {
          pendingUserIds.push({ id: ticket.requesterUserId, kind: target.kind, ref: null, note: 'ticket requester' });
        }
        break;
      }
      case 'user': {
        if (!target.ref) break;
        const row = (await executor('users')
          .where('username', target.ref)
          .where('is_active', true)
          .first('id', 'username', 'display_name', 'email')) as DirectoryUser | undefined;
        if (row) {
          push({
            kind: target.kind,
            ref: target.ref,
            userId: Number(row.id),
            username: String(row.username),
            displayName: row.display_name,
            email: row.email,
            channel: null,
            note: null,
          });
        }
        break;
      }
      case 'assignment_group': {
        const group = await groupMembers(
          tenantId,
          target.ref ? { slug: target.ref } : { id: ticket.assignmentGroupId },
          executor,
        );
        if (!group) break;
        for (const memberId of group.memberIds) {
          pendingUserIds.push({
            id: memberId,
            kind: target.kind,
            ref: group.slug,
            note: `member of ${group.slug}`,
          });
        }
        break;
      }
      case 'on_call': {
        const group = await groupMembers(
          tenantId,
          target.ref ? { slug: target.ref } : { id: ticket.assignmentGroupId },
          executor,
        );
        if (!group || group.memberIds.length === 0) break;
        const rotation = target.rotation ?? {
          periodHours: DEFAULT_ROTATION_PERIOD_HOURS,
          anchor: DEFAULT_ROTATION_ANCHOR,
        };
        const ordered = [...group.memberIds].sort((a, b) => a - b);
        const index = onCallMemberIndex(ordered.length, atISO, rotation);
        if (index < 0) break;
        pendingUserIds.push({
          id: ordered[index],
          kind: target.kind,
          ref: group.slug,
          note: `on call for ${group.slug} (slot ${index + 1} of ${ordered.length}, ${rotation.periodHours}h rotation)`,
        });
        break;
      }
      case 'manager_of_assignee': {
        const managers = await tenantManagers(tenantId, executor);
        for (const managerId of managers) {
          if (managerId === ticket.assigneeId) continue;
          pendingUserIds.push({
            id: managerId,
            kind: target.kind,
            ref: target.ref,
            note: 'named a manager of this tenant',
          });
        }
        break;
      }
      case 'watchers': {
        const rows = (await scoped('ticket_watcher', tenantId, executor)
          .where('ticket_watcher.ticket_id', ticket.id)
          .whereNotNull('ticket_watcher.user_id')
          .select('ticket_watcher.user_id')) as Array<{ user_id: number }>;
        for (const row of rows) {
          pendingUserIds.push({
            id: Number(row.user_id),
            kind: target.kind,
            ref: null,
            note: 'watching this ticket',
          });
        }
        break;
      }
      case 'channel': {
        if (!target.ref) break;
        push({
          kind: target.kind,
          ref: target.ref,
          userId: null,
          username: null,
          displayName: null,
          email: null,
          channel: target.ref,
          note: null,
        });
        break;
      }
      default:
        break;
    }
  }

  const directory = await usersByIds(pendingUserIds.map((entry) => entry.id), executor);
  for (const entry of pendingUserIds) {
    const row = directory.get(entry.id);
    if (!row) continue;
    push({
      kind: entry.kind,
      ref: entry.ref,
      userId: Number(row.id),
      username: String(row.username),
      displayName: row.display_name,
      email: row.email,
      channel: null,
      note: entry.note,
    });
  }

  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Delivery
// ═════════════════════════════════════════════════════════════════════════════

function recipientLabel(recipient: ResolvedRecipient): string {
  return recipient.displayName ?? recipient.username ?? recipient.channel ?? 'quelqu’un';
}

async function deliverStep(
  tenantId: number,
  ticket: TicketSnapshot,
  ladder: NormalizedLadder,
  step: NormalizedEscalationStep,
  repeatIndex: number,
  recipients: ResolvedRecipient[],
  runId: number,
  trx: Executor,
): Promise<void> {
  const now = new Date().toISOString();
  const rung = step.index + 1;
  const label = step.label ?? `Palier ${rung}`;
  const title = `Escalade ${ticket.number} — ${label}`;
  const bodyLines = [
    `**${ticket.subject}**`,
    '',
    `Palier ${rung} de l’escalade « ${ladder.name} » (${ladder.slug}), ` +
      `déclenchée par ${ladder.trigger}, ${step.afterMinutes} min ouvrées après le déclencheur.`,
    `Statut : ${ticket.statusSlug} · Priorité : ${ticket.prioritySlug} · File : ${ticket.queueSlug}`,
  ];
  if (repeatIndex > 0) bodyLines.push(`Rappel n°${repeatIndex + 1}.`);
  if (recipients.length > 0) {
    bodyLines.push('', `Destinataires : ${recipients.map(recipientLabel).join(', ')}`);
  }
  const body = bodyLines.join('\n');

  // ── 1. The in-app bell. One entry per (run, step, repeat) — the stable key
  //       is the same triple the fire claim used, so a retried delivery
  //       refreshes the entry instead of stacking a second one.
  const stableKey = `escalation:${runId}:${step.index}:${repeatIndex}`;
  const existing = (await scoped('live_alerts', tenantId, trx)
    .where('live_alerts.stable_key', stableKey)
    .first('id')) as { id: number } | undefined;

  let alertId = existing ? Number(existing.id) : 0;
  if (!existing) {
    const [inserted] = (await insertScoped(
      'live_alerts',
      tenantId,
      {
        severity: step.severity,
        title,
        message: body,
        navigate_to: `/tickets/${ticket.id}`,
        stable_key: stableKey,
      },
      trx,
    ).returning('id')) as unknown as Array<{ id: number }>;
    alertId = Number(inserted?.id ?? 0);
  }

  const alert: LiveAlert = {
    id: alertId,
    tenantId,
    severity: step.severity,
    title,
    message: body,
    navigateTo: `/tickets/${ticket.id}`,
    stableKey,
    readAt: null,
    createdAt: now,
  };

  // ── 2. The people. A socket frame reaches whoever is at their desk right
  //       now; a watcher row is what makes every LATER change reach them too,
  //       which is the difference between "you were told once" and "you are on
  //       this ticket".
  for (const recipient of recipients) {
    if (recipient.userId === null) continue;

    await trx('ticket_watcher')
      .insert({
        tenant_id: tenantId,
        ticket_id: ticket.id,
        user_id: recipient.userId,
        reason: 'escalation',
      })
      .onConflict(['ticket_id', 'user_id'])
      .ignore();

    emitToUser(recipient.userId, SOCKET_EVENTS.notificationNew, { tenantId, at: now, alert });
  }

  // Everyone with the ticket open sees the escalation land on the timeline.
  emitToTicket(ticket.id, SOCKET_EVENTS.notificationNew, { tenantId, at: now, alert });

  // ── 3. The outbound channels (mail, webhook, chat). Best-effort: a channel
  //       that is misconfigured must not roll back the fire, because rolling it
  //       back would release the idempotency claim and page everyone again on
  //       the next tick.
  try {
    const channels = recipients
      .filter((recipient) => recipient.channel !== null)
      .map((recipient) => recipient.channel as string);

    if (step.templateSlug) {
      await notificationService.dispatchTemplate({
        tenantId,
        templateSlug: step.templateSlug,
        event: 'escalation.step',
        locale: DEFAULT_LOCALE,
        variables: {
          ticket,
          ladderSlug: ladder.slug,
          ladderName: ladder.name,
          stepIndex: rung,
          stepLabel: label,
          recipients: recipients.map(recipientLabel),
        },
        severity: step.severity,
        url: `/tickets/${ticket.id}`,
        fields: escalationDispatchFields(ticket, ladder, step, channels),
        ticketId: ticket.id,
        trx,
      });
    } else {
      await notificationService.dispatch({
        tenantId,
        event: 'escalation.step',
        fields: escalationDispatchFields(ticket, ladder, step, channels),
        ticketId: ticket.id,
        trx,
        payload: {
          event: 'escalation.step',
          title,
          body,
          severity: step.severity,
          url: `/tickets/${ticket.id}`,
          locale: DEFAULT_LOCALE,
          ticket: {
            id: ticket.id,
            number: ticket.number,
            subject: ticket.subject,
            recordType: ticket.recordType,
            statusSlug: ticket.statusSlug,
            statusCategory: ticket.statusCategory,
            prioritySlug: ticket.prioritySlug,
            queueSlug: ticket.queueSlug,
            assigneeName: null,
            requesterName: null,
            organizationName: null,
            occurredAt: ticket.occurredAt,
            createdAt: ticket.createdAt,
          },
          facts: [
            { label: 'Escalade', value: `${ladder.name} (${ladder.slug})` },
            { label: 'Palier', value: `${rung}` },
            { label: 'Destinataires', value: recipients.map(recipientLabel).join(', ') || '—' },
          ],
        },
      });
    }
  } catch (error) {
    logger.warn(
      { err: error, tenantId, ticketId: ticket.id, ladder: ladder.slug, step: step.index },
      'escalation: notification dispatch failed — the escalation itself still fired',
    );
  }

  // ── 4. The timeline. An escalation that leaves no trace on the ticket is one
  //       the next agent cannot see happened.
  await journalService.append(
    {
      tenantId,
      ticketId: ticket.id,
      kind: 'automation',
      visibility: 'internal',
      authorType: 'automation',
      bodyMd: body,
      meta: {
        escalationSlug: ladder.slug,
        escalationVersion: ladder.version,
        escalationRunId: runId,
        stepIndex: step.index,
        repeatIndex,
        notified: recipients.map((recipient) => ({
          userId: recipient.userId,
          username: recipient.username,
          kind: recipient.kind,
          note: recipient.note,
        })),
      },
    },
    trx as Knex.Transaction,
  );
}

function escalationDispatchFields(
  ticket: TicketSnapshot,
  ladder: NormalizedLadder,
  step: NormalizedEscalationStep,
  channels: readonly string[],
): Record<string, unknown> {
  return buildConditionFields({
    'ticket.queue_slug': ticket.queueSlug,
    'ticket.priority_slug': ticket.prioritySlug,
    'ticket.status_category': ticket.statusCategory,
    'ticket.record_type': ticket.recordType,
    'ticket.organization_id': ticket.organizationId,
    'escalation.slug': ladder.slug,
    'escalation.trigger': ladder.trigger,
    'escalation.step_index': step.index,
    'escalation.severity': step.severity,
    'escalation.channels': channels,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10b — The bridge to the rules engine's action catalogue
// ═════════════════════════════════════════════════════════════════════════════

export interface RuleActionOutcome {
  type: string;
  performed: boolean;
  skipped?: string;
  error?: string;
  detail: Record<string, unknown>;
}

export interface RunRuleActionsInput {
  tenantId: number;
  ticketId: number;
  actions: readonly RuleActionSpec[];
  /**
   * The config object asking. Becomes `decision_log.rule_slug` on every row the
   * actions write, so "who reassigned this ticket at 04:00" resolves to the
   * ladder or the approval definition rather than to nothing.
   */
  sourceSlug: string;
  sourceVersion: number;
  /** `decision_log.inputs.trigger` — 'escalation.step', 'approval.approved'… */
  trigger: string;
  actorId?: number | null;
  correlationId?: string;
  trx: Executor;
}

/**
 * Run a step's / an outcome's `RuleActionSpec[]` through the rules engine's own
 * action catalogue.
 *
 * There is exactly ONE implementation of "apply a rule action" — `performAction`
 * in `ruleActions.ts`, with its parameter validation, its per-action
 * `decision_log` row and its budget — and a second copy here would be the
 * fragmentation that module's own comments reject. So this builds the
 * `ActionContext` the catalogue expects and hands each action over.
 *
 * BOTH modules are loaded by a specifier held in a variable, and that is not
 * decoration: `ruleActions.ts` statically imports `approval.service`, which
 * imports this file, so a static import back would close a module-initialisation
 * cycle. Deferring the require to call time — when everything is initialised —
 * is the fix, and it doubles as the same graceful degradation `index.ts` uses:
 * a tree without the rules engine still escalates and still notifies.
 *
 * Errors never propagate. An escalation whose `set_priority` action failed has
 * still PAGED SOMEBODY, and rolling that back would release the idempotency
 * claim and page them again on the next tick.
 */
export async function runRuleActions(
  input: RunRuleActionsInput,
): Promise<RuleActionOutcome[]> {
  if (input.actions.length === 0) return [];

  const actionsSpec = './ruleActions';
  const ticketSpec = './ticket.service';

  let catalogue: {
    normalizeActions?: (raw: unknown) => { actions: unknown[]; issues: unknown[] };
    performAction?: (ctx: unknown, action: unknown) => Promise<RuleActionOutcome & { index: number; kind: string }>;
  };
  let tickets: {
    getById?: (
      tenantId: number,
      ticketId: number,
      options?: { executor?: Executor },
    ) => Promise<unknown>;
    systemActor?: (options?: Record<string, unknown>) => unknown;
  };

  try {
    catalogue = (await import(actionsSpec)) as typeof catalogue;
    tickets = (await import(ticketSpec)) as typeof tickets;
  } catch (error) {
    logger.warn(
      { err: (error as Error).message, source: input.sourceSlug },
      'rule actions: the action catalogue is not available — actions NOT applied',
    );
    return input.actions.map((action) => ({
      type: action.type,
      performed: false,
      skipped: 'no_action_catalogue',
      detail: { params: action.params },
    }));
  }

  if (
    typeof catalogue.normalizeActions !== 'function' ||
    typeof catalogue.performAction !== 'function' ||
    typeof tickets.getById !== 'function' ||
    typeof tickets.systemActor !== 'function'
  ) {
    return input.actions.map((action) => ({
      type: action.type,
      performed: false,
      skipped: 'no_action_catalogue',
      detail: { params: action.params },
    }));
  }

  const ticket = await tickets.getById(input.tenantId, input.ticketId, { executor: input.trx });
  if (!ticket) {
    return input.actions.map((action) => ({
      type: action.type,
      performed: false,
      skipped: 'ticket_gone',
      detail: {},
    }));
  }

  const tenant = (await db('tenants')
    .where('id', input.tenantId)
    .first('slug', 'name')) as { slug: string; name: string } | undefined;

  const normalized = catalogue.normalizeActions(input.actions as unknown);
  const now = new Date().toISOString();

  // A local budget, deliberately smaller than the rules engine's: an escalation
  // rung or an approval outcome is a handful of actions, and a runaway loop
  // here would be one an operator never asked for.
  const budget = 20;
  let spent = 0;

  const ctx = {
    tenantId: input.tenantId,
    tenantSlug: tenant ? String(tenant.slug) : null,
    tenantName: tenant ? String(tenant.name) : null,
    ticket: ticket as unknown,
    previous: null,
    actor: tickets.systemActor({ actorType: 'automation', actorId: input.actorId ?? null }),
    trx: input.trx,
    ruleSlug: input.sourceSlug,
    ruleVersion: input.sourceVersion,
    dryRun: false,
    correlationId: input.correlationId ?? `${input.trigger}:${input.sourceSlug}:${now}`,
    now,
    trigger: input.trigger,
    depth: 0,
    spend(_kind: string, cost: number): void {
      spent += cost;
      if (spent > budget) {
        throw new Error(
          `The action budget of ${budget} for "${input.sourceSlug}" is exhausted. ` +
            'Evaluation stopped rather than half-applied.',
        );
      }
    },
    setTicket(next: unknown): void {
      // A mutating action returns the row it wrote; later actions in the same
      // batch must see it, or the second `set_field` would overwrite the first.
      (ctx as { ticket: unknown }).ticket = next;
    },
    shadow(): void {
      // Dry run only; this bridge never runs one.
    },
  };

  const out: RuleActionOutcome[] = [];
  for (const action of normalized.actions) {
    try {
      const result = await catalogue.performAction(ctx, action);
      out.push({
        type: result.kind,
        performed: result.performed,
        skipped: result.skipped,
        error: result.error,
        detail: result.detail ?? {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { err: message, source: input.sourceSlug, ticketId: input.ticketId },
        'rule actions: an action failed — the escalation or approval itself stands',
      );
      out.push({
        type: (action as { kind?: string }).kind ?? 'unknown',
        performed: false,
        error: message,
        detail: {},
      });
      // A budget failure stops the rest; a single bad action does not.
      if (message.includes('budget')) break;
    }
  }

  for (const issue of normalized.issues) {
    out.push({
      type: 'unreadable',
      performed: false,
      skipped: 'invalid_action',
      detail: issue as Record<string, unknown>,
    });
  }

  return out;
}

/** Rule actions attached to an escalation step. */
async function runStepActions(
  tenantId: number,
  ticket: TicketSnapshot,
  ladder: NormalizedLadder,
  step: NormalizedEscalationStep,
  trx: Executor,
): Promise<Array<Record<string, unknown>>> {
  const results = await runRuleActions({
    tenantId,
    ticketId: ticket.id,
    actions: step.actions,
    sourceSlug: ladder.slug,
    sourceVersion: ladder.version,
    trigger: `escalation.step.${step.index}`,
    trx,
  });
  return results as unknown as Array<Record<string, unknown>>;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — Firing one due step
// ═════════════════════════════════════════════════════════════════════════════

export interface FireStepResult {
  fired: boolean;
  runId: number;
  stepIndex: number;
  repeatIndex: number;
  recipients: number;
  reason:
    | 'fired'
    | 'already_fired'
    | 'not_armed'
    | 'not_due'
    | 'completed'
    | 'stopped'
    | 'ticket_gone'
    | 'ticket_terminal'
    | 'ladder_gone';
}

async function closeRun(
  tenantId: number,
  runId: number,
  reason: string,
  state: EscalationRunState,
  trx: Executor,
): Promise<void> {
  await scopedRuntime(RUNS, tenantId, trx)
    .where(`${RUNS}.id`, runId)
    .update({
      state,
      closed_at: new Date(),
      close_reason: reason.slice(0, 32),
      next_due_at: null,
      updated_at: new Date(),
    });
}

/**
 * Fire the next due step of one run, in one transaction.
 *
 * The order inside the transaction is deliberate:
 *   1. re-read the run FOR UPDATE (the sweep's snapshot may be stale),
 *   2. re-check every reason to stop (the ticket may have been resolved in the
 *      seconds since the sweep listed it),
 *   3. CLAIM the fire row — this is the point of no return,
 *   4. resolve recipients, deliver, run actions,
 *   5. advance the cursor.
 *
 * Claiming before delivering (rather than after) is what makes a crash safe:
 * the claim and the delivery share a transaction, so either both happened or
 * neither did, and the next tick sees a consistent world.
 */
export async function fireDueStep(
  tenantId: number,
  runId: number,
  options: { now?: Date; correlationId?: string } = {},
): Promise<FireStepResult> {
  assertTenantId(tenantId);
  const now = options.now ?? new Date();

  return db.transaction(async (trx) => {
    const run = (await scopedRuntime(RUNS, tenantId, trx)
      .where(`${RUNS}.id`, runId)
      .forUpdate()
      .first()) as EscalationRunRow | undefined;

    if (!run || run.state !== 'armed') {
      return { fired: false, runId, stepIndex: -1, repeatIndex: 0, recipients: 0, reason: 'not_armed' as const };
    }

    const stepIndex = Number(run.next_step_index) || 0;
    const repeatIndex = Number(run.next_repeat_index) || 0;
    const dueAt = run.next_due_at ? new Date(run.next_due_at) : null;
    const ticketId = Number(run.ticket_id);

    if (dueAt !== null && dueAt.getTime() > now.getTime()) {
      return { fired: false, runId, stepIndex, repeatIndex, recipients: 0, reason: 'not_due' as const };
    }

    const ladder = await loadLadder(tenantId, String(run.ladder_slug), trx);
    if (!ladder || !ladder.enabled) {
      await closeRun(tenantId, runId, 'ladder_gone', 'cancelled', trx);
      return { fired: false, runId, stepIndex, repeatIndex, recipients: 0, reason: 'ladder_gone' as const };
    }

    const step = ladder.steps[stepIndex];
    if (!step) {
      await closeRun(tenantId, runId, 'completed', 'completed', trx);
      return { fired: false, runId, stepIndex, repeatIndex, recipients: 0, reason: 'completed' as const };
    }

    const ticket = await loadTicketSnapshot(tenantId, ticketId, trx);
    if (!ticket) {
      await closeRun(tenantId, runId, 'ticket_closed', 'cancelled', trx);
      return { fired: false, runId, stepIndex, repeatIndex, recipients: 0, reason: 'ticket_gone' as const };
    }
    if (isTerminal(ticket.statusCategory)) {
      await closeRun(tenantId, runId, 'ticket_closed', 'stopped', trx);
      return { fired: false, runId, stepIndex, repeatIndex, recipients: 0, reason: 'ticket_terminal' as const };
    }

    const context = parseJson<Record<string, unknown>>(run.context, {});
    const nowIso = now.toISOString();
    const ctx = conditionContextFor(ticket, context, nowIso);

    if (ladder.stopWhen) {
      const stop = evaluateCondition(ladder.stopWhen, ctx);
      if (stop.matched) {
        await closeRun(tenantId, runId, 'stopped', 'stopped', trx);
        await withDecision(
          {
            tenantId,
            ticketId,
            subsystem: 'escalation',
            ruleSlug: ladder.slug,
            ruleVersion: ladder.version,
            actorType: 'system',
            correlationId: options.correlationId,
            trx,
          },
          (recorder) => {
            recorder
              .decide(
                `escalation "${ladder.slug}" stopped on ${ticket.number} before step ${stepIndex + 1} — ` +
                  `${describeCondition(ladder.stopWhen)} became true`,
              )
              .trace(stop.trace)
              .outcome({ result: 'stopped', runId, stepIndex });
          },
        );
        return { fired: false, runId, stepIndex, repeatIndex, recipients: 0, reason: 'stopped' as const };
      }
    }

    // ── THE CLAIM ────────────────────────────────────────────────────────
    // UNIQUE(run_id, step_index, repeat_index). Zero rows back means another
    // pass — another tick, another replica, a retry of this very tick — owns
    // this rung. Notify nobody and say so.
    const claimed = (await insertRuntime(
      FIRES,
      tenantId,
      {
        run_id: runId,
        ticket_id: ticketId,
        step_index: stepIndex,
        repeat_index: repeatIndex,
        due_at: dueAt,
        fired_at: now,
      },
      trx,
    )
      .onConflict(['run_id', 'step_index', 'repeat_index'])
      .ignore()
      .returning('id')) as unknown as Array<{ id: number }>;

    if (!claimed || claimed.length === 0) {
      logger.debug(
        { tenantId, runId, stepIndex, repeatIndex },
        'escalation: step already claimed by another pass — not firing twice',
      );
      await advanceCursor(tenantId, runId, ladder, step, stepIndex, repeatIndex, run, now, trx);
      return { fired: false, runId, stepIndex, repeatIndex, recipients: 0, reason: 'already_fired' as const };
    }

    const fireId = Number(claimed[0].id);

    const recipients = await resolveRecipients(tenantId, ticket, step.notify, nowIso, trx);
    let deliveryError: string | null = null;
    let actionResults: Array<Record<string, unknown>> = [];

    await withDecision(
      {
        tenantId,
        ticketId,
        subsystem: 'escalation',
        ruleSlug: ladder.slug,
        ruleVersion: ladder.version,
        actorType: 'system',
        correlationId: options.correlationId,
        trx,
      },
      async (recorder) => {
        recorder.input({
          runId,
          fireId,
          stepIndex,
          repeatIndex,
          trigger: ladder.trigger,
          occurrenceKey: String(run.occurrence_key),
          anchorAt: toIso(run.anchor_at),
          dueAt: toIso(dueAt),
          calendarSlug: run.calendar_slug,
          afterMinutes: step.afterMinutes,
          notifyTargets: step.notify.map((target) => ({ kind: target.kind, ref: target.ref })),
          context,
        });

        if (recipients.length === 0 && step.notify.length > 0) {
          // Not a crash, but absolutely not a success either: the ladder ran
          // and reached nobody, and that has to be visible.
          recorder
            .decide(
              `escalation "${ladder.slug}" step ${stepIndex + 1} fired on ${ticket.number} but resolved to ZERO recipients`,
            )
            .outcome({ result: 'fired_no_recipients', runId, fireId, stepIndex, repeatIndex });
          logger.warn(
            { tenantId, ticketId, ladder: ladder.slug, stepIndex },
            'escalation: step resolved to zero recipients — nobody was told',
          );
        }

        /**
         * A delivery failure keeps the CLAIM and does not rethrow.
         *
         * Rethrowing would roll the transaction back, and the claim with it —
         * so the next tick would re-fire this exact rung. That is the right
         * shape for an idempotent retry and the wrong shape for a pager: a
         * failure that repeats every minute pages the on-call engineer every
         * minute, which is the outage on top of the outage. At-most-once with
         * a visible, recorded failure is the safer trade for a notification,
         * and the failure IS visible — on the fire row, in `decision_log`, and
         * in the log. The alternative would need a per-fire attempt counter
         * this table deliberately does not have.
         */
        try {
          if (recipients.length > 0) {
            await deliverStep(tenantId, ticket, ladder, step, repeatIndex, recipients, runId, trx);
          }
          actionResults = await runStepActions(tenantId, ticket, ladder, step, trx);
        } catch (error) {
          deliveryError = error instanceof Error ? error.message : String(error);
          logger.error(
            { err: error, tenantId, ticketId, ladder: ladder.slug, stepIndex, repeatIndex },
            'escalation: step CLAIMED but delivery failed — recorded, not retried',
          );
          recorder.outcome({ deliveryError });
        }

        recorder
          .decide(
            `escalation "${ladder.slug}" step ${stepIndex + 1}/${ladder.steps.length}` +
              (repeatIndex > 0 ? ` (rappel ${repeatIndex + 1})` : '') +
              (deliveryError === null ? ' fired on ' : ' FAILED to deliver on ') +
              `${ticket.number}: ${recipients.map(recipientLabel).join(', ') || 'no recipient'}`,
          )
          .outcome({
            result: deliveryError === null ? 'fired' : 'fired_delivery_failed',
            runId,
            fireId,
            stepIndex,
            repeatIndex,
            recipients: recipients.map((recipient) => ({
              kind: recipient.kind,
              userId: recipient.userId,
              username: recipient.username,
              channel: recipient.channel,
              note: recipient.note,
            })),
            actions: actionResults,
          });
      },
    );

    await scopedRuntime(FIRES, tenantId, trx)
      .where(`${FIRES}.id`, fireId)
      .update({
        notified: JSON.stringify(recipients),
        actions: JSON.stringify(actionResults),
        error: deliveryError,
      });

    await advanceCursor(tenantId, runId, ladder, step, stepIndex, repeatIndex, run, now, trx);

    return {
      fired: true,
      runId,
      stepIndex,
      repeatIndex,
      recipients: recipients.length,
      reason: 'fired' as const,
    };
  });
}

/**
 * Move the run's cursor to the next rung.
 *
 * `afterMinutes` is documented as "business minutes after the TRIGGER", so a
 * non-repeating step's due date is measured from `anchor_at`, not from the
 * previous fire. A REPEATING step is the exception — there `afterMinutes` is
 * the period, so the next repeat is measured from this fire.
 */
async function advanceCursor(
  tenantId: number,
  runId: number,
  ladder: NormalizedLadder,
  step: NormalizedEscalationStep,
  stepIndex: number,
  repeatIndex: number,
  run: EscalationRunRow,
  now: Date,
  trx: Executor,
): Promise<void> {
  if (step.repeat && repeatIndex + 1 < step.maxRepeats) {
    const nextDue = await addBusinessMinutesOn(
      tenantId,
      step.calendarSlug ?? ladder.calendarSlug,
      now,
      step.afterMinutes,
      trx,
    );
    await scopedRuntime(RUNS, tenantId, trx)
      .where(`${RUNS}.id`, runId)
      .update({
        next_repeat_index: repeatIndex + 1,
        next_due_at: new Date(nextDue),
        updated_at: new Date(),
      });
    return;
  }

  const nextStep = ladder.steps[stepIndex + 1];
  if (!nextStep) {
    await closeRun(tenantId, runId, 'completed', 'completed', trx);
    return;
  }

  const anchorAt = toIso(run.anchor_at) ?? now.toISOString();
  const nextDue = await addBusinessMinutesOn(
    tenantId,
    nextStep.calendarSlug ?? ladder.calendarSlug,
    anchorAt,
    nextStep.afterMinutes,
    trx,
  );

  await scopedRuntime(RUNS, tenantId, trx)
    .where(`${RUNS}.id`, runId)
    .update({
      next_step_index: stepIndex + 1,
      next_repeat_index: 0,
      // A ladder whose later rung is already overdue (the ticket sat over a
      // weekend) must fire on the NEXT tick, not be skipped — clamping to `now`
      // would be wrong for the same reason: the due date is what the Why drawer
      // shows. Store the true due date; the sweep picks up anything <= now.
      next_due_at: new Date(nextDue),
      updated_at: new Date(),
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — External triggers
// ═════════════════════════════════════════════════════════════════════════════

export interface SlaEscalationEvent {
  tenantId: number;
  ticketId: number;
  /** `sla_instances.id` — makes the occurrence key unique per clock. */
  instanceId: number;
  targetSlug: string;
  policySlug: string;
  /** The ladder named by `SlaTargetSpec.escalationSlug` (HARD RULE 3). */
  escalationSlug: string | null | undefined;
  /** When the warning / breach happened. NOT when the ticker noticed. */
  at?: string | Date;
  trx?: Executor;
  correlationId?: string;
}

/**
 * Called by the SLA ticker when a clock crosses its warning threshold.
 *
 * Idempotent by construction: the occurrence key is the SLA INSTANCE, so a
 * ticker that re-emits the same warning after a restart arms nothing new.
 */
export async function onSlaWarning(event: SlaEscalationEvent): Promise<ArmEscalationResult> {
  return armFromSla(event, 'sla_warning', 'warning');
}

/** Called by the SLA ticker when a clock breaches. */
export async function onSlaBreach(event: SlaEscalationEvent): Promise<ArmEscalationResult> {
  return armFromSla(event, 'sla_breach', 'breach');
}

async function armFromSla(
  event: SlaEscalationEvent,
  trigger: EscalationTrigger,
  suffix: string,
): Promise<ArmEscalationResult> {
  if (!event.escalationSlug) {
    return { armed: false, run: null, reason: 'ladder_missing' };
  }
  return arm({
    tenantId: event.tenantId,
    ticketId: event.ticketId,
    ladderSlug: event.escalationSlug,
    trigger,
    occurrenceKey: `sla:${event.instanceId}:${suffix}`,
    anchorAt: event.at ?? new Date(),
    context: {
      slaInstanceId: event.instanceId,
      targetSlug: event.targetSlug,
      policySlug: event.policySlug,
    },
    actorType: 'system',
    correlationId: event.correlationId,
    trx: event.trx,
  });
}

export interface TicketEscalationEvent {
  tenantId: number;
  ticketId: number;
  trigger: Extract<EscalationTrigger, 'reopened' | 'priority' | 'unassigned'>;
  /** Distinguishes this occurrence — the reopen count, the new priority… */
  occurrenceRef?: string | number | null;
  at?: string | Date;
  context?: Record<string, unknown>;
  actorId?: number | null;
  trx?: Executor;
  correlationId?: string;
}

/**
 * Arm every published ladder that answers a ticket-level trigger.
 *
 * Called from `ticket.service`'s reopen / update paths (see the TODO at the
 * foot of this file). Each ladder gets its own `decision_log` row via `arm()`,
 * including the ones that decline.
 */
export async function onTicketEvent(event: TicketEscalationEvent): Promise<ArmEscalationResult[]> {
  const ladders = await listLadders(event.tenantId, event.trx ?? db);
  const matching = ladders.filter((ladder) => ladder.enabled && ladder.trigger === event.trigger);
  if (matching.length === 0) return [];

  const at = toIso(event.at ?? new Date()) ?? new Date().toISOString();
  const results: ArmEscalationResult[] = [];
  for (const ladder of matching) {
    results.push(
      await arm({
        tenantId: event.tenantId,
        ticketId: event.ticketId,
        ladderSlug: ladder.slug,
        trigger: event.trigger,
        occurrenceKey: `${event.trigger}:${event.occurrenceRef ?? at}`,
        anchorAt: at,
        context: event.context,
        actorId: event.actorId ?? null,
        correlationId: event.correlationId,
        trx: event.trx,
      }),
    );
  }
  return results;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13 — The sweeps
// ═════════════════════════════════════════════════════════════════════════════

export interface SweepOptions {
  /** Limit to one tenant. Omit for the whole installation (the ticker). */
  tenantId?: number;
  now?: Date;
  /** Maximum steps fired in one pass. Keeps a backlog from monopolising a tick. */
  limit?: number;
  correlationId?: string;
}

export interface EscalationTickResult {
  fired: number;
  skipped: number;
  armed: number;
  superseded: number;
  errors: number;
}

const DEFAULT_SWEEP_LIMIT = 200;

/**
 * Fire everything that is due.
 *
 * ── A note on the unscoped read below (HARD RULE 1) ──────────────────────────
 * `escalation_runs` is a tenant table and a bare `db(...)` against it would be
 * a defect anywhere else. The ticker is the same legitimate exception the
 * outbox drainer documents: it has no tenant context because it sweeps for
 * EVERY tenant, and each id it then acts on came from a row it just read and is
 * re-read `FOR UPDATE` inside `fireDueStep`, which scopes by tenant again from
 * the row's own `tenant_id`. There is no user input anywhere near it. When
 * `tenantId` IS supplied (the routes' manual sweep) the query goes through the
 * scoped builder like everything else.
 */
export async function sweepDueSteps(options: SweepOptions = {}): Promise<EscalationTickResult> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_SWEEP_LIMIT, 1000));
  const result: EscalationTickResult = { fired: 0, skipped: 0, armed: 0, superseded: 0, errors: 0 };

  const base = options.tenantId !== undefined
    ? scopedRuntime(RUNS, options.tenantId)
    : db(RUNS);

  const due = (await base
    .where(`${RUNS}.state`, 'armed')
    .whereNotNull(`${RUNS}.next_due_at`)
    .where(`${RUNS}.next_due_at`, '<=', now)
    .orderBy(`${RUNS}.next_due_at`, 'asc')
    .limit(limit)
    .select(`${RUNS}.id`, `${RUNS}.tenant_id`)) as Array<{ id: number; tenant_id: number }>;

  for (const row of due) {
    try {
      const fired = await fireDueStep(Number(row.tenant_id), Number(row.id), {
        now,
        correlationId: options.correlationId,
      });
      if (fired.fired) result.fired += 1;
      else result.skipped += 1;
    } catch (error) {
      result.errors += 1;
      logger.error(
        { err: error, runId: row.id, tenantId: row.tenant_id },
        'escalation: firing a due step failed — it will be retried on the next tick',
      );
    }
  }

  return result;
}

/**
 * Arm the state-persistence ladders — `no_update` and `unassigned`.
 *
 * These have no event to hang off: nothing HAPPENS when a ticket stops being
 * touched. So the sweep looks for the condition instead, and re-anchors on the
 * instant the state began (the last update, the creation) rather than on now —
 * otherwise "escalate after 4 business hours of silence" would restart its
 * clock on every tick and never fire.
 *
 * The wall-clock pre-filter is safe in the only direction that matters:
 * business time elapsed is never MORE than wall-clock time elapsed, so a ticket
 * whose wall-clock silence is shorter than the first rung cannot possibly be
 * due, and skipping it cannot miss an escalation.
 */
export async function sweepStateLadders(options: SweepOptions = {}): Promise<EscalationTickResult> {
  const now = options.now ?? new Date();
  const result: EscalationTickResult = { fired: 0, skipped: 0, armed: 0, superseded: 0, errors: 0 };

  // `tenants` is a GLOBAL table (see GLOBAL_TABLES) — db() is correct — and it
  // carries no is_active flag, so every tenant is swept.
  const tenantIds = options.tenantId !== undefined
    ? [options.tenantId]
    : ((await db('tenants').select('id')) as Array<{ id: number }>).map((row) => Number(row.id));

  for (const tenantId of tenantIds) {
    let ladders: NormalizedLadder[];
    try {
      ladders = (await listLadders(tenantId)).filter(
        (ladder) => ladder.enabled &&
          ladder.steps.length > 0 &&
          (SWEEPABLE_TRIGGERS as readonly string[]).includes(ladder.trigger),
      );
    } catch (error) {
      result.errors += 1;
      logger.error({ err: error, tenantId }, 'escalation: could not read ladders for the state sweep');
      continue;
    }
    if (ladders.length === 0) continue;

    for (const ladder of ladders) {
      const firstRung = ladder.steps[0].afterMinutes;
      const cutoff = new Date(now.getTime() - firstRung * 60_000);

      const qb = scoped('tickets', tenantId)
        .whereNull('tickets.deleted_at')
        .whereNotIn('tickets.status_category', ['resolved', 'closed', 'cancelled'])
        .limit(Math.max(1, Math.min(options.limit ?? DEFAULT_SWEEP_LIMIT, 1000)));

      if (ladder.trigger === 'no_update') {
        qb.where('tickets.updated_at', '<=', cutoff);
      } else {
        qb.whereNull('tickets.assignee_id')
          .whereNull('tickets.assignment_group_id')
          .where('tickets.created_at', '<=', cutoff);
      }

      let candidates: Array<Record<string, unknown>>;
      try {
        candidates = (await qb.select(...TICKET_COLUMNS)) as Array<Record<string, unknown>>;
      } catch (error) {
        result.errors += 1;
        logger.error({ err: error, tenantId, ladder: ladder.slug }, 'escalation: state sweep query failed');
        continue;
      }

      if (candidates.length === 0) continue;

      const snapshots = candidates.map(mapTicketSnapshot);

      /**
       * ── Why the pre-filter is not an optimisation ──────────────────────
       *
       * `arm()` writes a `decision_log` row for every outcome, including
       * "already armed" and "not applicable". That is exactly right when an
       * EVENT arms a ladder — an SLA breach considered one ladder, and the row
       * is the evidence. It is exactly wrong here: this sweep runs every
       * minute, and calling `arm()` per candidate would write one row per
       * silent ticket per tick — hundreds of thousands of rows a day saying
       * nothing happened, in the one table whose value is that it can be read.
       *
       * So the two cheap, PURE answers are computed here and the survivors —
       * the tickets that genuinely reach an arming attempt — go through
       * `arm()` and get their row. HARD RULE 2 asks for a row on the action's
       * code path, not for a row per row examined.
       */
      const existing = (await scopedRuntime(RUNS, tenantId)
        .where(`${RUNS}.ladder_slug`, ladder.slug)
        .whereIn(`${RUNS}.ticket_id`, snapshots.map((ticket) => ticket.id))
        .select(
          `${RUNS}.ticket_id`,
          `${RUNS}.occurrence_key`,
          `${RUNS}.state`,
        )) as Array<{ ticket_id: number; occurrence_key: string; state: string }>;

      const knownKeys = new Set(
        existing.map((row) => `${Number(row.ticket_id)}::${String(row.occurrence_key)}`),
      );
      const armedKeyByTicket = new Map<number, string>();
      for (const row of existing) {
        if (row.state === 'armed') armedKeyByTicket.set(Number(row.ticket_id), String(row.occurrence_key));
      }

      for (const ticket of snapshots) {
        const anchorAt = ladder.trigger === 'no_update' ? ticket.updatedAt : ticket.createdAt;
        const occurrenceKey = `${ladder.trigger}:${anchorAt}`;

        try {
          // A newer occurrence supersedes the old one, so a ticket that was
          // replied to five minutes ago stops carrying a ladder armed against
          // yesterday's silence. Only issued when there IS a stale armed run.
          const armedKey = armedKeyByTicket.get(ticket.id);
          if (armedKey !== undefined && armedKey !== occurrenceKey) {
            result.superseded += await supersedeOtherOccurrences(
              tenantId, ticket.id, ladder.slug, occurrenceKey, db,
            );
          }

          // Already handled — armed, completed or deliberately cancelled. Any
          // of those means this occurrence has had its turn.
          if (knownKeys.has(`${ticket.id}::${occurrenceKey}`)) continue;

          // `appliesWhen` is a pure evaluation; running it here costs nothing
          // and keeps the ledger free of a row per non-matching ticket.
          if (ladder.appliesWhen) {
            const ctx = conditionContextFor(
              ticket,
              { sweep: ladder.trigger, silentSinceIso: anchorAt },
              now.toISOString(),
            );
            if (!evaluateCondition(ladder.appliesWhen, ctx).matched) continue;
          }

          const armed = await arm({
            tenantId,
            ticketId: ticket.id,
            ladderSlug: ladder.slug,
            trigger: ladder.trigger,
            occurrenceKey,
            anchorAt,
            context: {
              sweep: ladder.trigger,
              silentSinceIso: anchorAt,
            },
            actorType: 'system',
            correlationId: options.correlationId,
          });
          if (armed.armed) result.armed += 1;
        } catch (error) {
          result.errors += 1;
          logger.error(
            { err: error, tenantId, ticketId: ticket.id, ladder: ladder.slug },
            'escalation: could not arm a state ladder',
          );
        }
      }
    }
  }

  return result;
}

/** One full pass: arm what the state has earned, then fire what is due. */
export async function tick(options: SweepOptions = {}): Promise<EscalationTickResult> {
  const now = options.now ?? new Date();
  const armedPass = await sweepStateLadders({ ...options, now });
  const firedPass = await sweepDueSteps({ ...options, now });

  // The approval engine's timeout sweep rides this tick.
  //
  // The specifier is held in a variable so TypeScript resolves the module for
  // TYPES only and the `require` happens at call time, when both modules are
  // fully initialised — `approval.service` reaches back into this one for its
  // `onTimeout: 'escalate'` behaviour, and a pair of static imports would be a
  // module-initialisation cycle. Deferring one side of it is the fix.
  let approvals = { timedOut: 0, reminded: 0, errors: 0 };
  const approvalSpec = './approval.service';
  try {
    const loaded = (await import(approvalSpec)) as {
      sweepApprovalTimeouts?: (opts: SweepOptions) => Promise<{ timedOut: number; reminded: number; errors: number }>;
    };
    if (typeof loaded.sweepApprovalTimeouts === 'function') {
      approvals = await loaded.sweepApprovalTimeouts({ ...options, now });
    }
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'escalation: approval timeout sweep failed');
  }

  return {
    fired: firedPass.fired,
    skipped: firedPass.skipped,
    armed: armedPass.armed,
    superseded: armedPass.superseded,
    errors: armedPass.errors + firedPass.errors + approvals.errors,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 14 — Reads for the UI
// ═════════════════════════════════════════════════════════════════════════════

export async function runsForTicket(
  tenantId: number,
  ticketId: number,
  options: { includeClosed?: boolean; executor?: Executor } = {},
): Promise<EscalationRun[]> {
  assertTenantId(tenantId);
  const executor = options.executor ?? db;
  const qb = scopedRuntime(RUNS, tenantId, executor).where(`${RUNS}.ticket_id`, ticketId);
  if (!options.includeClosed) qb.where(`${RUNS}.state`, 'armed');
  const rows = (await qb.orderBy(`${RUNS}.armed_at`, 'desc').select('*')) as EscalationRunRow[];
  return rows.map(mapRun);
}

export async function getRun(
  tenantId: number,
  runId: number,
  executor: Executor = db,
): Promise<EscalationRun | null> {
  assertTenantId(tenantId);
  const row = (await scopedRuntime(RUNS, tenantId, executor)
    .where(`${RUNS}.id`, runId)
    .first()) as EscalationRunRow | undefined;
  return row ? mapRun(row) : null;
}

export async function firesForRun(
  tenantId: number,
  runId: number,
  executor: Executor = db,
): Promise<EscalationFire[]> {
  assertTenantId(tenantId);
  const rows = (await scopedRuntime(FIRES, tenantId, executor)
    .where(`${FIRES}.run_id`, runId)
    .orderBy(`${FIRES}.fired_at`, 'asc')
    .select('*')) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id),
    runId: Number(row.run_id),
    ticketId: Number(row.ticket_id),
    stepIndex: Number(row.step_index),
    repeatIndex: Number(row.repeat_index) || 0,
    dueAt: toIso(row.due_at as Date),
    firedAt: toIso(row.fired_at as Date) ?? new Date().toISOString(),
    notified: parseJson<ResolvedRecipient[]>(row.notified, []),
    actions: parseJson<Array<Record<string, unknown>>>(row.actions, []),
    error: (row.error as string | null) ?? null,
  }));
}

/** Everything the "why is this escalating?" panel needs, in one call. */
export async function explainForTicket(
  tenantId: number,
  ticketId: number,
  executor: Executor = db,
): Promise<Array<EscalationRun & { ladder: NormalizedLadder | null; fires: EscalationFire[] }>> {
  const runs = await runsForTicket(tenantId, ticketId, { includeClosed: true, executor });
  const out: Array<EscalationRun & { ladder: NormalizedLadder | null; fires: EscalationFire[] }> = [];
  for (const run of runs) {
    out.push({
      ...run,
      ladder: await loadLadder(tenantId, run.ladderSlug, executor),
      fires: await firesForRun(tenantId, run.id, executor),
    });
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 15 — The worker
// ═════════════════════════════════════════════════════════════════════════════

let timer: NodeJS.Timeout | null = null;
let running = false;
let ticking = false;
let stopRequested = false;

export interface EscalationWorkerOptions {
  intervalMs?: number;
  limit?: number;
}

let workerOptions: Required<EscalationWorkerOptions> = {
  intervalMs: appConfig.slaTickIntervalMs,
  limit: DEFAULT_SWEEP_LIMIT,
};

/**
 * The escalation ticker.
 *
 * Shaped exactly like `outboxService` so `index.ts` can start it behind the
 * same advisory leader lock: one ticker per cluster. Two tickers would not
 * double-fire (the `escalation_fires` unique index makes that impossible) but
 * they would double the query load for nothing.
 *
 * `setTimeout` chained after each tick rather than `setInterval`, so a tick
 * slower than the period never overlaps the next one.
 */
export const escalationService = {
  async start(options: EscalationWorkerOptions = {}): Promise<void> {
    if (running) {
      logger.debug('escalation: worker already running');
      return;
    }
    workerOptions = {
      intervalMs: options.intervalMs ?? appConfig.slaTickIntervalMs,
      limit: options.limit ?? DEFAULT_SWEEP_LIMIT,
    };
    running = true;
    stopRequested = false;

    logger.info({ intervalMs: workerOptions.intervalMs }, 'escalation: ticker started');

    const loop = async (): Promise<void> => {
      if (stopRequested) return;
      ticking = true;
      try {
        const result = await tick({ limit: workerOptions.limit });
        if (result.fired > 0 || result.armed > 0 || result.errors > 0) {
          logger.info(result, 'escalation: tick');
        }
      } catch (error) {
        // Never let one tick kill the loop — a silently dead escalation engine
        // is the failure nobody notices until the month-end review.
        logger.error({ err: error }, 'escalation: tick failed');
      } finally {
        ticking = false;
      }
      if (stopRequested) return;
      timer = setTimeout(() => void loop(), workerOptions.intervalMs);
      timer.unref?.();
    };

    timer = setTimeout(() => void loop(), workerOptions.intervalMs);
    timer.unref?.();
  },

  async stop(): Promise<void> {
    stopRequested = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const deadline = Date.now() + 15_000;
    while (ticking && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    running = false;
    logger.info('escalation: ticker stopped');
  },

  isRunning(): boolean {
    return running;
  },

  tick,
  arm,
  cancelForTicket,
  cancelRun,
  onSlaWarning,
  onSlaBreach,
  onTicketEvent,
  listLadders,
  loadLadder,
  buildEscalationLintContext,
  runsForTicket,
  getRun,
  firesForRun,
  explainForTicket,
  sweepDueSteps,
  sweepStateLadders,
  validateEscalationDefinition,
  assertEscalationDefinitionSavable,
  normalizeEscalationBody,
};

/** Aliases, so `loadWorker()` finds it whichever name `index.ts` tries. */
export const escalationEngine = escalationService;
export const escalationTicker = escalationService;

export default escalationService;

// ═════════════════════════════════════════════════════════════════════════════
// Wiring still owed by files this module does not own
// ═════════════════════════════════════════════════════════════════════════════
//
// TODO(db/index.ts): add 'escalation_runs' and 'escalation_fires' to
//   TENANT_SCOPED_TABLES. `scopedRuntime()` above starts delegating to
//   `scoped()` the moment they are there, with no change here.
//
// TODO(index.ts): start this worker behind the leader lock, next to the SLA
//   ticker and the outbox drainer:
//     await startWorker(escalationService, 'Escalation ticker', workers,
//                       { intervalMs: config.slaTickIntervalMs });
//
// TODO(sla.service.ts): call `onSlaWarning()` / `onSlaBreach()` with the
//   `sla_instances.id` as `instanceId` and `SlaTargetSpec.escalationSlug` as
//   `escalationSlug`, passing the ticker's transaction as `trx`.
//
// TODO(ticket.service.ts): call `cancelForTicket()` on the transition into a
//   terminal category, and `onTicketEvent()` on reopen / priority change.
//
// TODO(configLinter.service.ts): call `validateEscalationDefinition()` from
//   `lintTargetBody()`'s `case 'escalation'` — the codes above are already
//   `ConfigLintCode` values, so the findings map straight across:
//     case 'escalation':
//       findings.push(...validateEscalationDefinition(body, {
//         usernames: ctx.usernames, groups: ctx.groups,
//         calendars: publishedSlugs(ctx, 'calendar'),
//         templates: publishedSlugs(ctx, 'notification_template'),
//       }).map((f) => ({ ...f, kind, slug })));
//
// TODO(@oblidesk/shared configKinds.ts): widen `EscalationNotifyTarget.kind`
//   with 'on_call' and 'watchers', and add the optional `rotation` /
//   `severity` / `templateSlug` fields this engine already reads.
