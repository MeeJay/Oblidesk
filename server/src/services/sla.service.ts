/**
 * sla.service.ts — the SLA engine, and the registry that makes it arguable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  The thesis
 * ═══════════════════════════════════════════════════════════════════════════
 * Computing "four business hours from Tuesday 16:40" was never the hard part —
 * `shared/src/calendar.ts` already does that, purely and correctly, and this
 * file does not re-derive one minute of it. The hard part is PROVING the number
 * six weeks later, in a room, to a customer who remembers it differently.
 *
 * So every design choice below optimises for one thing: when someone disputes a
 * breach, the desk can produce the whole story without recomputing anything.
 *
 *   `sla_instances`  is the CACHE — due_at, paused_ms, running, status, and the
 *                    armed timer. Cheap to read, safe to lose.
 *   `sla_ledger`     is the TRUTH — one append-only row per start / pause /
 *                    resume / target_switch / breach / met / cancel, each
 *                    carrying the business milliseconds already elapsed BEFORE
 *                    it. Replaying the ledger reproduces due_at exactly, and
 *                    that replay is what the nightly verifier does.
 *
 * `UNIQUE(instance_id, event, at)` (migration 002) is load-bearing rather than
 * defensive: the boot catch-up pass deliberately re-emits every event it thinks
 * it may have missed, and the unique index turns a double-emit into a no-op.
 * Nothing here works around it — everything here relies on it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  Policy resolution, and why the losers are persisted
 * ═══════════════════════════════════════════════════════════════════════════
 * Order: contract → organisation → queue → record type → global. FIRST MATCH
 * WINS. The whole evaluated list — winner AND losers, each with the reason it
 * lost — is written into `sla_instances.resolved_via` at the moment the clock
 * starts, so the UI can render "the Gold contract won; here is what lost"
 * months later without re-running a resolution whose inputs have since changed.
 *
 * Asserting an order in a doc comment and not persisting the evaluation is
 * exactly what makes SLA arguments unwinnable: the config has moved on, the
 * customer's org has been re-parented, and nobody can reconstruct what the desk
 * actually looked at. So `resolved_via` carries three things:
 *   `resolution` — the evaluated list, in order, with outcomes;
 *   `stoppedBy`  — what satisfied or cancelled the clock (002's original use);
 *   `verification` — the nightly verifier's last reading, drift included.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  Pausing
 * ═══════════════════════════════════════════════════════════════════════════
 * Pause keys off the status CATEGORY (HARD RULE 5) through `pausesSla()` and
 * `stopsSla()` from `@oblidesk/shared` — never off a status slug, so a tenant
 * renaming "in progress" to "chez le technicien" cannot break a clock.
 *
 * Four non-status pause reasons exist on top: `maintenance_window`,
 * `device_offline`, `outside_hours`, and the audited `manual`.
 *
 * VALIDATION, refused rather than warned: a target may not declare BOTH a
 * business calendar and `outside_hours` in its pause list. The calendar already
 * excludes those hours; counting them again double-pauses, and the resulting
 * due date is wrong in a way that looks plausible. A 24×7 calendar plus
 * `outside_hours` is the legitimate pairing — that is a desk that runs a clock
 * around the clock but only wants to be judged on office hours.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  The clock is event-driven, never polled
 * ═══════════════════════════════════════════════════════════════════════════
 * The ticker does NOT scan open tickets. Every live instance arms exactly one
 * `next_timer_at` (migration 003) — the earliest of its breach, its next
 * warning threshold, its next calendar boundary, or the end of its pause — and
 * the ticker's only query is "which timers have come due?" against a partial
 * index. An idle desk with fifty thousand open tickets costs one empty index
 * scan a minute.
 *
 * On boot the ticker runs a CATCH-UP pass that replays each instance's timers
 * IN ORDER, at their own instants, between `last_tick_at` and now — not a jump
 * to the present. A restart must not silently forgive a breach that happened
 * while the process was down, and it must not record that breach at the wrong
 * time either.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  What this file will not do
 * ═══════════════════════════════════════════════════════════════════════════
 * It will not silently repair drift. The nightly verifier recomputes due_at and
 * paused_ms from the ledger, and on disagreement writes a `decision_log` entry,
 * an admin alert and a `note` row in the ledger — and then leaves the numbers
 * alone. Silent repair is precisely the recomputation the ledger exists to
 * prevent: a cache that quietly rewrites itself to match is a cache nobody can
 * audit, and "the system fixed it" is not an answer in a dispute.
 */

import { Client as PgClient } from 'pg';
import type { Knex } from 'knex';

import {
  MINUTE_MS,
  SLA_PAUSING_STATUS_CATEGORIES,
  SOCKET_EVENTS,
  addBusinessMinutesDetailed,
  businessMillisBetween,
  evaluateCondition,
  buildConditionFields,
  stopsSla,
  toStatusCategory,
  type BusinessCalendar,
  type ConditionNode,
  type StatusCategory,
  type Ticket,
} from '@oblidesk/shared';

import { config } from '../config';
import { db, insertScoped, scoped, type Executor } from '../db';
import { logger } from '../utils/logger';
import { withDecision } from './decision.service';
import { emitToTenant, emitToTicket } from '../socket';
import {
  calendarBands,
  defaultCalendarSlug,
  isOpenAt as isCalendarOpenAt,
  nextBoundary as calendarNextBoundary,
  resolveCalendar,
  type LoadedCalendar,
} from './calendar.service';
import { registerSlaEngine } from './ticket.service';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 0 — Vocabulary and tuning
// ═════════════════════════════════════════════════════════════════════════════

/** Ledger events. `note` is 003's annotation — it changes no state, ever. */
export type SlaLedgerEventName =
  | 'start'
  | 'pause'
  | 'resume'
  | 'target_switch'
  | 'breach'
  | 'met'
  | 'cancel'
  | 'note';

export type SlaInstanceStatus = 'running' | 'paused' | 'met' | 'breached' | 'cancelled';

/**
 * The non-status pause reasons. The status-driven ones are the CATEGORIES for
 * which `pausesSla()` is true, and they use the category name itself as the
 * reason code so the ledger reads as prose: "paused, pending_requester".
 */
export const SOURCE_PAUSE_REASONS = [
  'maintenance_window',
  'device_offline',
  'outside_hours',
] as const;
export type SourcePauseReason = (typeof SOURCE_PAUSE_REASONS)[number];

/** Everything that may appear in a target's `pause_on` list. */
export type PauseReason = StatusCategory | SourcePauseReason;

/** Reason codes that are not declared in configuration but can still pause. */
export const MANUAL_PAUSE_REASON = 'manual';

/** How a mid-flight priority change is handled. */
export type TargetSwitchMode = 'keep_elapsed' | 'restart' | 'recompute_from_start';

export const DEFAULT_TARGET_SWITCH_MODE: TargetSwitchMode = 'recompute_from_start';

/**
 * A ticket the alert spine opened and closed inside this window produced no
 * human work, so it produces no SLA outcome either — no breach, no met, and no
 * first-response metric. Without it a flapping monitor manufactures a breached
 * P1 every time it blinks, and the desk's SLA report becomes noise.
 */
const ALERT_AUTO_RESOLVE_GRACE_MS = 120_000;

/**
 * A CI liveness reading older than this is not evidence. Beyond it the engine
 * refuses to pause on `device_offline` and says so in the ledger — it never
 * keeps counting silently and never stops counting silently.
 */
const CI_STATE_STALE_AFTER_MS = 15 * 60_000;

/** Drift beyond this is reported. Below it is float noise on a business-ms sum. */
const DRIFT_TOLERANCE_MS = 1_000;

/** Instances processed per ticker pass. Bounds a catch-up after a long outage. */
const TICK_BATCH = 500;

/** Timers replayed for ONE instance in a single catch-up. Loop guard. */
const MAX_REPLAY_STEPS = 512;

/** Instances the nightly verifier reads per page. */
const VERIFY_PAGE = 200;

/** Local hour at which the verifier runs (server clock). */
const VERIFY_HOUR = 3;

/** `app_config` key holding the worker's cross-restart state. */
const WORKER_STATE_KEY = 'sla.worker_state';

/** Advisory lock: same class as index.ts's leader lock, its own object id. */
const ADVISORY_LOCK_CLASS = 0x0b11de5c;
const ADVISORY_LOCK_OBJECT = 2;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Reading an SLA policy body
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ── Why this parser is so forgiving ──────────────────────────────────────────
 * Three shapes of `sla` body exist in a live install and all three are
 * legitimate:
 *
 *   • `SlaBody` / `SlaTargetSpec` from `shared/src/configKinds.ts` — camelCase,
 *     `durationsByPriority`, `pauseOnCategories`, `calendarSlug`.
 *   • The SEEDED `standard` policy in `db/seeds/02_baseline_config.ts` —
 *     snake_case, `by_priority: { p1: { minutes, label } }`,
 *     `pause_on_categories`, `calendar`, `on_priority_change`,
 *     `warn_at_percent: [75, 90]`, and `start`/`stop` verbs instead of a
 *     `metric` string.
 *   • Whatever an admin hand-edits in the config screen, which is a mixture.
 *
 * A parser that understood only the first would refuse to start a clock on the
 * policy every fresh install ships with, and the failure mode is silent: no
 * instances, no ledger, no breach, a desk that looks like it has no SLAs. So
 * every field is read through `pick()` across its known spellings, every
 * tolerance is deliberate, and anything genuinely unreadable becomes a
 * `problems` entry the linter and the API surface rather than a guess.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asStringList(value: unknown): string[] {
  return asArray(value)
    .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
    .filter((entry) => entry.length > 0);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asCondition(value: unknown): ConditionNode | null {
  return isRecord(value) ? (value as unknown as ConditionNode) : null;
}

/** How a target's clock is stopped. */
export type StopKind = 'first_response' | 'category' | 'condition' | 'manual';

export interface SlaTargetPlan {
  slug: string;
  label: string;
  labelKey: string | null;
  /** Business minutes for the ticket's CURRENT priority, or null → no target. */
  budgetMinutes: number | null;
  /** Every priority the target knows, for the target-switch arithmetic. */
  budgetsByPriority: Record<string, number>;
  calendarSlug: string;
  /**
   * The calendar whose OPENING and CLOSING edges drive an `outside_hours`
   * pause — which is deliberately not the same thing as `calendarSlug`.
   *
   * The only legal way to use `outside_hours` is on a 24×7 target calendar
   * (see `validateTarget`), and a 24×7 calendar has no edges by definition. So
   * the edges have to come from somewhere else: the desk's real office hours.
   * A target may name one explicitly (`pause_calendar`); otherwise the tenant's
   * DEFAULT calendar is used, which is what "outside hours" means to everybody
   * who works there.
   *
   * The combination is not redundant with simply running on the business
   * calendar: this one counts wall-clock time and writes an explicit
   * pause/resume pair into the ledger at every edge, so the strip a customer is
   * shown says "closed 18:00 → 09:00" in its own words instead of leaving the
   * gap to be inferred from a calendar they cannot see.
   */
  pauseCalendarSlug: string | null;
  /** Status categories that pause, from `pausesSla()` unless overridden. */
  pauseCategories: StatusCategory[];
  /** Non-status pause sources this target opts into. */
  pauseSources: SourcePauseReason[];
  /** Categories that CANCEL rather than meet the target (usually `cancelled`). */
  cancelCategories: StatusCategory[];
  stopKind: StopKind;
  /** For `stopKind === 'category'`. */
  stopCategory: StatusCategory | null;
  appliesWhen: ConditionNode | null;
  startWhen: ConditionNode | null;
  stopWhen: ConditionNode | null;
  /** Ascending warn thresholds, 0 < pct < 100. */
  warnPercents: number[];
  escalationSlug: string | null;
  switchMode: TargetSwitchMode;
  /** True when a priority change must NOT move this target at all. */
  freezeOnPriorityChange: boolean;
}

export interface SlaPolicyPlan {
  slug: string;
  name: string;
  version: number;
  calendarSlug: string;
  precedence: number;
  enabled: boolean;
  appliesWhen: ConditionNode | null;
  targets: SlaTargetPlan[];
  /** Explicit bindings that decide the resolution LEVEL of this policy. */
  organizationSlugs: string[];
  queueSlugs: string[];
  recordTypes: string[];
  /** Anything the parser could not make sense of. Surfaced, never guessed. */
  problems: string[];
}

const SWITCH_MODE_ALIASES: Record<string, TargetSwitchMode> = {
  keep_elapsed: 'keep_elapsed',
  keepelapsed: 'keep_elapsed',
  switch_target_keep_elapsed: 'keep_elapsed',
  restart: 'restart',
  reset: 'restart',
  restart_clock: 'restart',
  recompute: 'recompute_from_start',
  recompute_from_start: 'recompute_from_start',
  recomputefromstart: 'recompute_from_start',
};

function parseSwitchMode(value: unknown, fallback: TargetSwitchMode): TargetSwitchMode {
  if (typeof value !== 'string') return fallback;
  return SWITCH_MODE_ALIASES[value.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? fallback;
}

/** `{ p1: 15 }`, `{ p1: { minutes: 15 } }` and `{ p1: '15' }` all read here. */
function parseBudgets(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(raw)) return out;
  for (const [priority, value] of Object.entries(raw)) {
    const minutes = isRecord(value)
      ? asNumber(pick(value, 'minutes', 'business_minutes', 'businessMinutes', 'value'))
      : asNumber(value);
    if (minutes === null || minutes <= 0) continue;
    out[priority.trim().toLowerCase()] = minutes;
  }
  return out;
}

function parseWarnPercents(...candidates: unknown[]): number[] {
  const out = new Set<number>();
  for (const candidate of candidates) {
    for (const entry of asArray(candidate)) {
      const value = isRecord(entry) ? asNumber(pick(entry, 'at_percent', 'atPercent', 'percent')) : asNumber(entry);
      if (value === null) continue;
      if (value <= 0 || value >= 100) continue; // 100% is the breach, not a warning
      out.add(Math.round(value));
    }
  }
  return [...out].sort((a, b) => a - b);
}

function toCategoryList(value: unknown): StatusCategory[] {
  const out: StatusCategory[] = [];
  for (const entry of asStringList(value)) {
    const category = toStatusCategory(entry, 'open');
    // `toStatusCategory` is total and falls back to 'open'; only keep entries
    // that really named a category, otherwise a typo silently pauses on 'open'
    // and freezes every clock on the desk.
    if (category === entry) out.push(category);
  }
  return [...new Set(out)];
}

function toSourceReasons(value: unknown): SourcePauseReason[] {
  const known = new Set<string>(SOURCE_PAUSE_REASONS);
  return [...new Set(asStringList(value).filter((entry) => known.has(entry)))] as SourcePauseReason[];
}

/**
 * Default pause set: every category for which `pausesSla()` is true.
 *
 * Taken from `SLA_PAUSING_STATUS_CATEGORIES` rather than a local list, so
 * adding a category to `statusCategories.ts` cannot leave a stale copy here
 * quietly refusing to pause on it (HARD RULE 5).
 */
function defaultPauseCategories(): StatusCategory[] {
  return [...SLA_PAUSING_STATUS_CATEGORIES];
}

function parseStop(target: Record<string, unknown>, slug: string): { kind: StopKind; category: StatusCategory | null } {
  const stop = pick(target, 'stop', 'stopOn', 'stop_on');
  if (isRecord(stop)) {
    const on = typeof stop.on === 'string' ? stop.on.trim().toLowerCase() : '';
    if (on === 'ticket.first_public_reply' || on === 'ticket.first_response') {
      return { kind: 'first_response', category: null };
    }
    if (on === 'ticket.category_reached' || on === 'ticket.status_category') {
      const category = typeof stop.category === 'string' ? toStatusCategory(stop.category, 'resolved') : 'resolved';
      return { kind: 'category', category };
    }
  }

  const metric = typeof pick(target, 'metric') === 'string' ? String(pick(target, 'metric')).toLowerCase() : '';
  if (metric === 'first_response') return { kind: 'first_response', category: null };
  if (metric === 'resolution') return { kind: 'category', category: 'resolved' };

  const normalized = slug.toLowerCase();
  if (normalized.includes('response') && !normalized.includes('resolution')) {
    return { kind: 'first_response', category: null };
  }
  if (normalized.includes('resolution') || normalized.includes('resolve')) {
    return { kind: 'category', category: 'resolved' };
  }

  if (pick(target, 'stopWhen', 'stop_when')) return { kind: 'condition', category: null };
  return { kind: 'manual', category: null };
}

function localized(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (isRecord(value)) {
    const fr = value.fr ?? value.en;
    if (typeof fr === 'string' && fr.length > 0) return fr;
  }
  return fallback;
}

/**
 * Parse one published `sla` body into the plan the engine runs on.
 * Never throws: an unreadable body yields a plan with no targets and a
 * populated `problems` list, which the resolver records as a loser rather than
 * a crash on the ticket-creation path.
 */
export function parseSlaPolicy(
  slug: string,
  name: string,
  version: number,
  rawBody: unknown,
): SlaPolicyPlan {
  const problems: string[] = [];
  const body = isRecord(rawBody) ? rawBody : {};
  if (!isRecord(rawBody)) problems.push('body is not an object');

  const policyCalendar =
    typeof pick(body, 'calendarSlug', 'calendar_slug', 'calendar') === 'string'
      ? String(pick(body, 'calendarSlug', 'calendar_slug', 'calendar'))
      : 'business';

  const policySwitchMode = parseSwitchMode(
    pick(body, 'onTargetSwitch', 'on_target_switch', 'on_priority_change', 'onPriorityChange'),
    DEFAULT_TARGET_SWITCH_MODE,
  );

  // `reevaluateOnPriorityChange: false` is `SlaBody`'s way of saying "freeze
  // the original target". It is NOT a switch mode — it is the absence of one.
  const reevaluate = pick(body, 'reevaluateOnPriorityChange', 'reevaluate_on_priority_change');
  const policyFreeze = reevaluate === false;

  const policyWarn = parseWarnPercents(
    pick(body, 'warnAtPercent', 'warn_at_percent'),
    pick(body, 'notifyOn', 'notify_on'),
  );

  const targets: SlaTargetPlan[] = [];
  const rawTargets = asArray(pick(body, 'targets'));
  if (rawTargets.length === 0) problems.push('policy declares no targets');

  for (const entry of rawTargets) {
    if (!isRecord(entry)) {
      problems.push('a target is not an object');
      continue;
    }
    const targetSlug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!targetSlug) {
      problems.push('a target has no slug');
      continue;
    }

    const budgets = parseBudgets(pick(entry, 'durationsByPriority', 'by_priority', 'durations', 'byPriority'));
    if (Object.keys(budgets).length === 0) {
      problems.push(`target "${targetSlug}" declares no per-priority duration`);
    }

    // `pause_on` is a MIXED list: status categories and the three source
    // reasons live in the same array in the wild. Split it, and fall back to
    // the `pausesSla()` defaults when the author named only source reasons —
    // "pause on maintenance_window" is an addition to the category rules, not
    // a silent instruction to stop pausing on pending_requester.
    const declaredCategories = pick(entry, 'pauseOnCategories', 'pause_on_categories', 'pauseOn', 'pause_on');
    const explicitCategories = declaredCategories === undefined ? [] : toCategoryList(declaredCategories);
    const pauseCategories = explicitCategories.length > 0 ? explicitCategories : defaultPauseCategories();
    const pauseSources = toSourceReasons(pick(entry, 'pauseOn', 'pause_on', 'pauseSources', 'pause_sources'));

    const stop = parseStop(entry, targetSlug);

    targets.push({
      slug: targetSlug,
      label: localized(pick(entry, 'label'), targetSlug),
      labelKey: typeof entry.labelKey === 'string' ? entry.labelKey : null,
      budgetMinutes: null, // filled per ticket, from `budgetsByPriority`
      budgetsByPriority: budgets,
      calendarSlug:
        typeof pick(entry, 'calendarSlug', 'calendar_slug', 'calendar') === 'string'
          ? String(pick(entry, 'calendarSlug', 'calendar_slug', 'calendar'))
          : policyCalendar,
      pauseCalendarSlug:
        typeof pick(entry, 'pauseCalendarSlug', 'pause_calendar', 'business_hours_calendar', 'officeHoursCalendar') ===
        'string'
          ? String(pick(entry, 'pauseCalendarSlug', 'pause_calendar', 'business_hours_calendar', 'officeHoursCalendar'))
          : null,
      pauseCategories,
      pauseSources,
      cancelCategories: toCategoryList(pick(entry, 'cancelOnCategories', 'cancel_on_categories')),
      stopKind: stop.kind,
      stopCategory: stop.category,
      appliesWhen: asCondition(pick(entry, 'appliesWhen', 'applies_when', 'applies_to', 'when')),
      startWhen: asCondition(pick(entry, 'startWhen', 'start_when')),
      stopWhen: asCondition(pick(entry, 'stopWhen', 'stop_when')),
      warnPercents: (() => {
        const own = parseWarnPercents(pick(entry, 'warnAtPercent', 'warn_at_percent'));
        return own.length > 0 ? own : policyWarn;
      })(),
      escalationSlug:
        typeof pick(entry, 'escalationSlug', 'escalation_slug', 'escalation') === 'string'
          ? String(pick(entry, 'escalationSlug', 'escalation_slug', 'escalation'))
          : null,
      switchMode: parseSwitchMode(pick(entry, 'onTargetSwitch', 'on_target_switch'), policySwitchMode),
      freezeOnPriorityChange: policyFreeze,
    });
  }

  return {
    slug,
    name,
    version,
    calendarSlug: policyCalendar,
    precedence: asNumber(pick(body, 'precedence', 'priority', 'order')) ?? 0,
    enabled: pick(body, 'enabled') === undefined ? true : pick(body, 'enabled') !== false,
    appliesWhen: asCondition(pick(body, 'appliesWhen', 'applies_when', 'applies_to', 'when')),
    targets,
    organizationSlugs: asStringList(
      pick(body, 'organizations', 'organization_slugs', 'organizationSlugs', 'orgs'),
    ),
    queueSlugs: asStringList(pick(body, 'queues', 'queue_slugs', 'queueSlugs')),
    recordTypes: asStringList(pick(body, 'recordTypes', 'record_types')),
    problems,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Target validation (the double-pause refusal)
// ═════════════════════════════════════════════════════════════════════════════

export interface TargetValidationIssue {
  targetSlug: string;
  code:
    | 'outside_hours_on_business_calendar'
    | 'outside_hours_without_office_hours'
    | 'no_duration_for_priority'
    | 'unparseable';
  message: string;
  /** French copy, per HARD RULE 10 — the UI pairs it with `t(key, fr)`. */
  messageFr: string;
  messageKey: string;
  severity: 'error' | 'warning';
}

/**
 * THE refusal. A target that pauses on `outside_hours` while running on a
 * business calendar counts the same closed hours twice: once because the
 * calendar does not advance through them, and again because the clock is
 * explicitly paused. The resulting due date is roughly twice as generous as the
 * contract says, and it is wrong in a way that looks entirely plausible on
 * screen — which is why this is an error and not a warning.
 *
 * 24×7 + `outside_hours` is the legitimate pairing and passes.
 *
 * Exported so `sla.validators.ts` can refuse the publish and the engine can
 * refuse the target, from the same function. Two copies of this rule would
 * eventually disagree, and the disagreement would be invisible.
 */
export function validateTarget(
  target: SlaTargetPlan,
  calendarIs24x7: boolean,
  prioritySlug?: string,
  /** Whether the calendar that supplies the office-hours edges never closes. */
  officeHoursCalendarIs24x7?: boolean,
): TargetValidationIssue[] {
  const issues: TargetValidationIssue[] = [];

  if (target.pauseSources.includes('outside_hours') && calendarIs24x7 && officeHoursCalendarIs24x7 === true) {
    // The pairing is legal but inert: a 24×7 target measured against 24×7
    // office hours has no closing edge, so `outside_hours` can never fire.
    // Warning rather than error — the clock it produces is CORRECT, just not
    // what the author thought they were configuring.
    issues.push({
      targetSlug: target.slug,
      code: 'outside_hours_without_office_hours',
      severity: 'warning',
      messageKey: 'sla.validation.outsideHoursWithoutOfficeHours',
      message:
        `Target "${target.slug}" pauses on outside_hours, but the calendar supplying its office hours ` +
        `("${target.pauseCalendarSlug ?? 'the tenant default'}") never closes, so the pause can never fire. ` +
        'Point `pause_calendar` at the calendar that describes when the desk is actually open.',
      messageFr:
        `La cible « ${target.slug} » se met en pause hors horaires, mais le calendrier qui definit ses heures ` +
        `d ouverture (« ${target.pauseCalendarSlug ?? 'defaut du locataire'} ») ne ferme jamais : la pause ne se ` +
        'declenchera jamais. Renseignez `pause_calendar` avec le calendrier des heures reelles d ouverture.',
    });
  }

  if (target.pauseSources.includes('outside_hours') && !calendarIs24x7) {
    issues.push({
      targetSlug: target.slug,
      code: 'outside_hours_on_business_calendar',
      severity: 'error',
      messageKey: 'sla.validation.outsideHoursDoublePause',
      message:
        `Target "${target.slug}" pauses on outside_hours while running on the business calendar ` +
        `"${target.calendarSlug}". The calendar already excludes those hours — counting them ` +
        'again doubles every deadline. Use a 24×7 calendar, or drop the outside_hours pause.',
      messageFr:
        `La cible « ${target.slug} » se met en pause hors horaires alors qu'elle utilise le calendrier ` +
        `ouvre « ${target.calendarSlug} ». Le calendrier exclut deja ces heures — les compter une ` +
        'seconde fois double chaque echeance. Utilisez un calendrier 24x7, ou retirez la pause hors horaires.',
    });
  }

  if (prioritySlug !== undefined && target.budgetsByPriority[prioritySlug.toLowerCase()] === undefined) {
    issues.push({
      targetSlug: target.slug,
      code: 'no_duration_for_priority',
      severity: 'warning',
      messageKey: 'sla.validation.noDurationForPriority',
      message: `Target "${target.slug}" declares no duration for priority "${prioritySlug}" — it does not apply.`,
      messageFr: `La cible « ${target.slug} » ne declare aucune duree pour la priorite « ${prioritySlug} » — elle ne s'applique pas.`,
    });
  }

  return issues;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Policy resolution, with the losers kept
// ═════════════════════════════════════════════════════════════════════════════

export const RESOLUTION_ORDER = ['contract', 'organisation', 'queue', 'record_type', 'global'] as const;
export type ResolutionLevel = (typeof RESOLUTION_ORDER)[number];

export type ResolutionOutcome =
  | 'selected'
  | 'condition_not_met'
  | 'disabled'
  | 'no_targets'
  | 'unreadable'
  | 'missing_policy'
  | 'no_binding'
  | 'lower_precedence'
  | 'not_reached';

export interface ResolutionCandidate {
  level: ResolutionLevel;
  policySlug: string | null;
  policyVersion: number | null;
  precedence: number;
  outcome: ResolutionOutcome;
  /** One human line the UI shows next to a loser. */
  detail: string;
  detailFr: string;
}

export interface PolicyResolution {
  at: string;
  order: readonly ResolutionLevel[];
  winner: { level: ResolutionLevel; policySlug: string; policyVersion: number } | null;
  evaluated: ResolutionCandidate[];
  plan: SlaPolicyPlan | null;
  /** The organisation slug the resolution ran against (HARD RULE 3 / 13). */
  organizationSlug: string | null;
}

interface PublishedPolicyRow {
  slug: string;
  name: string;
  body: unknown;
  version: number;
}

/**
 * Every published `sla` policy for a tenant, parsed. Not cached: policies are
 * read once per ticket-creation and once per resolution change, and a stale
 * policy cache is the exact failure the pinned `policy_version` on the instance
 * exists to prevent. The calendar cache is where caching belongs.
 */
async function loadPolicies(tenantId: number, executor: Executor): Promise<SlaPolicyPlan[]> {
  const rows = (await scoped('config_objects', tenantId, executor)
    .where('config_objects.kind', 'sla')
    .where('config_objects.status', 'published')
    .select(
      'config_objects.slug',
      'config_objects.name',
      'config_objects.body',
      'config_objects.version',
    )) as PublishedPolicyRow[];

  return rows.map((row) => {
    let body: unknown = row.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    return parseSlaPolicy(String(row.slug), row.name, Number(row.version) || 1, body);
  });
}

/** The condition bag. Both `ticket.x` and bare `x` resolve, in both cases. */
function conditionContextFor(ticket: Ticket, organizationSlug: string | null, nowIso: string) {
  const snake: Record<string, unknown> = {
    id: ticket.id,
    record_type: ticket.recordType,
    number: ticket.number,
    subject: ticket.subject,
    status_slug: ticket.statusSlug,
    status_category: ticket.statusCategory,
    priority_slug: ticket.prioritySlug,
    impact: ticket.impact,
    urgency: ticket.urgency,
    queue_slug: ticket.queueSlug,
    assignment_group_id: ticket.assignmentGroupId,
    assignee_id: ticket.assigneeId,
    requester_contact_id: ticket.requesterContactId,
    requester_user_id: ticket.requesterUserId,
    organization_id: ticket.organizationId,
    organization_slug: organizationSlug,
    primary_ci_id: ticket.primaryCiId,
    source: ticket.source,
    occurred_at: ticket.occurredAt,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
    first_response_at: ticket.firstResponseAt,
    resolved_at: ticket.resolvedAt,
    closed_at: ticket.closedAt,
    reopen_count: ticket.reopenCount,
    data: ticket.data ?? {},
  };

  // Both spellings, because the seeded conditions write `ticket.status_category`
  // while a hand-authored one may write the camelCase DTO key. Offering both
  // costs a shallow copy and removes an entire class of "the rule never fires".
  const base: Record<string, unknown> = { ...snake, ...ticket, ticket: { ...snake, ...ticket } };
  for (const [key, value] of Object.entries(ticket.data ?? {})) {
    base[`data.${key}`] = value;
    base[`ticket.data.${key}`] = value;
  }

  return { fields: buildConditionFields(base), previous: null, now: nowIso };
}

interface ContractBinding {
  policySlug: string;
  contractId: number;
  contractName: string;
}

async function contractPolicyFor(
  tenantId: number,
  ticket: Ticket,
  executor: Executor,
): Promise<ContractBinding | null> {
  if (ticket.organizationId === null) return null;
  const today = new Date().toISOString().slice(0, 10);

  const row = (await scoped('contracts', tenantId, executor)
    .where('contracts.organization_id', ticket.organizationId)
    .where('contracts.is_active', true)
    .whereNotNull('contracts.sla_policy_slug')
    .where((builder) => builder.whereNull('contracts.period_start').orWhere('contracts.period_start', '<=', today))
    .where((builder) => builder.whereNull('contracts.period_end').orWhere('contracts.period_end', '>=', today))
    // A tie between two live contracts is decided by the most recently created,
    // which is the one an account manager just signed.
    .orderBy('contracts.id', 'desc')
    .first('contracts.id', 'contracts.name', 'contracts.sla_policy_slug')) as
    | { id: number; name: string; sla_policy_slug: string }
    | undefined;

  if (!row) return null;
  return {
    policySlug: String(row.sla_policy_slug),
    contractId: Number(row.id),
    contractName: row.name,
  };
}

async function organizationSlugFor(
  tenantId: number,
  organizationId: number | null,
  executor: Executor,
): Promise<string | null> {
  if (organizationId === null) return null;
  const row = (await scoped('organizations', tenantId, executor)
    .where('organizations.id', organizationId)
    .first('organizations.slug')) as { slug: string } | undefined;
  return row ? String(row.slug).toLowerCase() : null;
}

/**
 * contract → organisation → queue → record type → global. FIRST MATCH WINS,
 * and everything that did not win is kept with the reason it did not.
 */
export async function resolvePolicy(
  tenantId: number,
  ticket: Ticket,
  executor: Executor = db,
): Promise<PolicyResolution> {
  const nowIso = new Date().toISOString();
  const evaluated: ResolutionCandidate[] = [];

  const policies = await loadPolicies(tenantId, executor);
  const bySlug = new Map(policies.map((policy) => [policy.slug.toLowerCase(), policy]));
  const organizationSlug = await organizationSlugFor(tenantId, ticket.organizationId, executor);
  const ctx = conditionContextFor(ticket, organizationSlug, nowIso);

  /** Does this policy's own `appliesWhen` accept the ticket? */
  const eligible = (policy: SlaPolicyPlan): { ok: boolean; outcome: ResolutionOutcome } => {
    if (!policy.enabled) return { ok: false, outcome: 'disabled' };
    if (policy.targets.length === 0) {
      return { ok: false, outcome: policy.problems.length > 0 ? 'unreadable' : 'no_targets' };
    }
    if (policy.appliesWhen && !evaluateCondition(policy.appliesWhen, ctx).matched) {
      return { ok: false, outcome: 'condition_not_met' };
    }
    return { ok: true, outcome: 'selected' };
  };

  const candidatesFor = (level: ResolutionLevel): SlaPolicyPlan[] => {
    switch (level) {
      case 'organisation':
        return organizationSlug === null
          ? []
          : policies.filter((policy) => policy.organizationSlugs.includes(organizationSlug));
      case 'queue':
        return policies.filter((policy) =>
          policy.queueSlugs.includes(ticket.queueSlug.toLowerCase()),
        );
      case 'record_type':
        return policies.filter((policy) =>
          policy.recordTypes.includes(String(ticket.recordType).toLowerCase()),
        );
      case 'global':
        // "Global" means bound to nothing in particular — the catch-all every
        // desk needs so a ticket in a brand-new queue still gets a clock.
        return policies.filter(
          (policy) =>
            policy.organizationSlugs.length === 0 &&
            policy.queueSlugs.length === 0 &&
            policy.recordTypes.length === 0,
        );
      default:
        return [];
    }
  };

  let winner: PolicyResolution['winner'] = null;
  let plan: SlaPolicyPlan | null = null;

  for (const level of RESOLUTION_ORDER) {
    if (winner !== null) {
      // Still recorded: "we never looked" is a materially different answer from
      // "we looked and it lost", and a customer arguing a breach deserves the
      // difference in writing.
      const skipped = level === 'contract' ? [] : candidatesFor(level);
      for (const policy of skipped) {
        evaluated.push({
          level,
          policySlug: policy.slug,
          policyVersion: policy.version,
          precedence: policy.precedence,
          outcome: 'not_reached',
          detail: 'A higher-precedence level already matched; this was never evaluated.',
          detailFr: 'Un niveau plus prioritaire a deja gagne ; celui-ci n a pas ete evalue.',
        });
      }
      continue;
    }

    if (level === 'contract') {
      const binding = await contractPolicyFor(tenantId, ticket, executor);
      if (!binding) {
        evaluated.push({
          level,
          policySlug: null,
          policyVersion: null,
          precedence: 0,
          outcome: 'no_binding',
          detail: 'No live contract on this organisation names an SLA policy.',
          detailFr: 'Aucun contrat actif de cette organisation ne designe de politique SLA.',
        });
        continue;
      }
      const policy = bySlug.get(binding.policySlug.toLowerCase());
      if (!policy) {
        evaluated.push({
          level,
          policySlug: binding.policySlug,
          policyVersion: null,
          precedence: 0,
          outcome: 'missing_policy',
          detail: `Contract "${binding.contractName}" names SLA policy "${binding.policySlug}", which is not published.`,
          detailFr: `Le contrat « ${binding.contractName} » designe la politique « ${binding.policySlug} », non publiee.`,
        });
        continue;
      }
      const verdict = eligible(policy);
      evaluated.push({
        level,
        policySlug: policy.slug,
        policyVersion: policy.version,
        precedence: policy.precedence,
        outcome: verdict.ok ? 'selected' : verdict.outcome,
        detail: verdict.ok
          ? `Contract "${binding.contractName}" selected policy "${policy.slug}".`
          : `Contract policy "${policy.slug}" was rejected: ${verdict.outcome}.`,
        detailFr: verdict.ok
          ? `Le contrat « ${binding.contractName} » a retenu la politique « ${policy.slug} ».`
          : `La politique de contrat « ${policy.slug} » a ete ecartee : ${verdict.outcome}.`,
      });
      if (verdict.ok) {
        winner = { level, policySlug: policy.slug, policyVersion: policy.version };
        plan = policy;
      }
      continue;
    }

    const candidates = candidatesFor(level).sort((a, b) => {
      if (b.precedence !== a.precedence) return b.precedence - a.precedence;
      return a.slug.localeCompare(b.slug); // deterministic tie-break
    });

    if (candidates.length === 0) {
      evaluated.push({
        level,
        policySlug: null,
        policyVersion: null,
        precedence: 0,
        outcome: 'no_binding',
        detail: 'No published policy is bound at this level.',
        detailFr: 'Aucune politique publiee n est rattachee a ce niveau.',
      });
      continue;
    }

    for (const policy of candidates) {
      if (winner !== null) {
        evaluated.push({
          level,
          policySlug: policy.slug,
          policyVersion: policy.version,
          precedence: policy.precedence,
          outcome: 'lower_precedence',
          detail: 'Another policy at this level won on precedence.',
          detailFr: 'Une autre politique de ce niveau l a emporte sur la precedence.',
        });
        continue;
      }
      const verdict = eligible(policy);
      evaluated.push({
        level,
        policySlug: policy.slug,
        policyVersion: policy.version,
        precedence: policy.precedence,
        outcome: verdict.ok ? 'selected' : verdict.outcome,
        detail: verdict.ok
          ? `Selected at the ${level} level (precedence ${policy.precedence}).`
          : `Rejected at the ${level} level: ${verdict.outcome}.`,
        detailFr: verdict.ok
          ? `Retenue au niveau ${level} (precedence ${policy.precedence}).`
          : `Ecartee au niveau ${level} : ${verdict.outcome}.`,
      });
      if (verdict.ok) {
        winner = { level, policySlug: policy.slug, policyVersion: policy.version };
        plan = policy;
      }
    }
  }

  return { at: nowIso, order: RESOLUTION_ORDER, winner, evaluated, plan, organizationSlug };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Rows, the ledger, and replay
// ═════════════════════════════════════════════════════════════════════════════

export interface SlaInstanceRow {
  id: number;
  tenant_id: number;
  ticket_id: number;
  target_slug: string;
  policy_slug: string;
  policy_version: number;
  calendar_slug: string;
  started_at: Date | string;
  due_at: Date | string | null;
  paused_ms: string | number;
  running: boolean;
  status: string;
  breached_at: Date | string | null;
  met_at: Date | string | null;
  resolved_via: unknown;
  next_timer_at: Date | string | null;
  timer_kind: string | null;
  warned_at: Date | string | null;
}

export interface SlaLedgerRow {
  id: number;
  instance_id: number;
  tenant_id: number;
  at: Date | string;
  event: string;
  reason_code: string | null;
  actor_id: number | null;
  elapsed_business_ms_before: string | number;
  new_due_at: Date | string | null;
  note: string | null;
}

const INSTANCE_COLUMNS = [
  'sla_instances.id',
  'sla_instances.tenant_id',
  'sla_instances.ticket_id',
  'sla_instances.target_slug',
  'sla_instances.policy_slug',
  'sla_instances.policy_version',
  'sla_instances.calendar_slug',
  'sla_instances.started_at',
  'sla_instances.due_at',
  'sla_instances.paused_ms',
  'sla_instances.running',
  'sla_instances.status',
  'sla_instances.breached_at',
  'sla_instances.met_at',
  'sla_instances.resolved_via',
  'sla_instances.next_timer_at',
  'sla_instances.timer_kind',
  'sla_instances.warned_at',
] as const;

function ms(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: Date | string | null | undefined): string | null {
  const parsed = ms(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function bigint(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseJsonColumn(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export interface AppendLedgerInput {
  tenantId: number;
  instanceId: number;
  event: SlaLedgerEventName;
  at: Date;
  reasonCode: string | null;
  actorId?: number | null;
  elapsedBusinessMsBefore: number;
  newDueAt?: Date | null;
  note?: string | null;
}

/**
 * Append one ledger row.
 *
 * `.onConflict(['instance_id','event','at']).ignore()` is the whole idempotency
 * story: the boot catch-up deliberately re-emits events it may already have
 * written, and a retried webhook or a double-fired timer lands on the same
 * triple. Working around the unique index — by nudging `at`, or by checking
 * first — would reintroduce exactly the double-pause it prevents.
 */
export async function appendLedger(input: AppendLedgerInput, executor: Executor): Promise<void> {
  await insertScoped(
    'sla_ledger',
    input.tenantId,
    {
      instance_id: input.instanceId,
      at: input.at,
      event: input.event,
      reason_code: input.reasonCode,
      actor_id: input.actorId ?? null,
      elapsed_business_ms_before: Math.max(0, Math.round(input.elapsedBusinessMsBefore)),
      new_due_at: input.newDueAt ?? null,
      note: input.note ?? null,
    },
    executor,
  )
    .onConflict(['instance_id', 'event', 'at'])
    .ignore();
}

async function readLedger(
  tenantId: number,
  instanceId: number,
  executor: Executor,
): Promise<SlaLedgerRow[]> {
  return (await scoped('sla_ledger', tenantId, executor)
    .where('sla_ledger.instance_id', instanceId)
    .orderBy('sla_ledger.at', 'asc')
    .orderBy('sla_ledger.id', 'asc')
    .select('*')) as SlaLedgerRow[];
}

export interface ReplayState {
  /** Business ms the clock actually RAN for. */
  elapsedMs: number;
  /** Business ms accumulated while paused — the `paused_ms` cache's truth. */
  pausedMs: number;
  /** Pause reasons currently holding the clock. Empty ⇒ running. */
  activePauses: Set<string>;
  /** Due date as the ledger says it should be. */
  dueAtMs: number | null;
  /** Total budget in business ms, derived from the start / switch rows. */
  budgetMs: number | null;
  /**
   * Business ms still owed at the instant the clock STOPPED RUNNING — the
   * first pause of the current paused period, not the most recent one.
   *
   * Overlapping pauses make that distinction load-bearing: a ticket paused at
   * 14:00 for `pending_requester` and again at 15:00 for `device_offline` owes
   * what it owed at 14:00. Measuring from 15:00 would quietly hand the desk a
   * free hour on every ticket that collects a second pause reason.
   */
  remainingAtPauseMs: number | null;
  /** Terminal event, if the ledger has one. */
  finished: 'met' | 'breached' | 'cancelled' | null;
  /** Instant the replay was carried to. */
  atMs: number;
}

/**
 * Replay a ledger into the clock's state at `upToMs`.
 *
 * This is THE recomputation — the thing the verifier compares the cache
 * against, and the thing that makes "we did not just make the number up"
 * demonstrable. It reads only the ledger and the calendar; it never looks at
 * `sla_instances`.
 */
export function replayLedger(
  rows: readonly SlaLedgerRow[],
  calendar: BusinessCalendar,
  startedAtMs: number,
  upToMs: number,
): ReplayState {
  const state: ReplayState = {
    elapsedMs: 0,
    pausedMs: 0,
    activePauses: new Set<string>(),
    dueAtMs: null,
    budgetMs: null,
    remainingAtPauseMs: null,
    finished: null,
    atMs: upToMs,
  };

  let cursor = startedAtMs;
  /** Business ms still owed at the moment the clock stopped running. */
  let remainingAtPause: number | null = null;

  const advance = (toMs: number): void => {
    if (toMs <= cursor) return;
    const span = businessMillisBetween(calendar, cursor, toMs);
    if (state.activePauses.size === 0) state.elapsedMs += span;
    else state.pausedMs += span;
    cursor = toMs;
  };

  for (const row of rows) {
    const atMs = ms(row.at);
    if (atMs === null) continue;
    if (atMs > upToMs) break;
    advance(atMs);

    switch (row.event) {
      case 'start': {
        const due = ms(row.new_due_at);
        if (due !== null) {
          state.dueAtMs = due;
          state.budgetMs = businessMillisBetween(calendar, atMs, due);
        }
        break;
      }
      case 'pause': {
        // Only the FIRST pause of a period fixes what is owed; a second reason
        // arriving later must not re-measure from its own instant.
        if (state.activePauses.size === 0 && state.dueAtMs !== null) {
          remainingAtPause = businessMillisBetween(calendar, atMs, state.dueAtMs);
        }
        state.activePauses.add(row.reason_code ?? 'unspecified');
        break;
      }
      case 'resume': {
        const reason = row.reason_code;
        if (reason === null || reason === 'all') state.activePauses.clear();
        else state.activePauses.delete(reason);
        if (state.activePauses.size === 0 && remainingAtPause !== null) {
          // The clock owes exactly what it owed when it stopped — pushed
          // forward onto the calendar from the instant it restarted.
          const settled = addBusinessMinutesDetailed(calendar, atMs, remainingAtPause / MINUTE_MS);
          state.dueAtMs = settled.atMs;
          remainingAtPause = null;
        }
        break;
      }
      case 'target_switch': {
        const due = ms(row.new_due_at);
        if (due !== null) {
          state.dueAtMs = due;
          state.budgetMs = state.elapsedMs + businessMillisBetween(calendar, atMs, due);
          if (state.activePauses.size > 0) {
            remainingAtPause = businessMillisBetween(calendar, atMs, due);
          }
        }
        break;
      }
      case 'met':
        state.finished = 'met';
        state.atMs = atMs;
        return state;
      case 'breach':
        // A breach does NOT stop the clock: a breached resolution target keeps
        // accruing until the ticket is actually resolved, and "how far past"
        // is the number every post-mortem asks for.
        break;
      case 'cancel':
        state.finished = 'cancelled';
        state.atMs = atMs;
        return state;
      case 'note':
        break; // an annotation, never part of the replay
      default:
        break;
    }
  }

  advance(upToMs);
  state.remainingAtPauseMs = remainingAtPause;
  return state;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Timers
// ═════════════════════════════════════════════════════════════════════════════

export type TimerKind = 'breach' | 'warn' | 'boundary' | 'resume';

export interface ArmedTimer {
  at: Date;
  kind: TimerKind;
}

/**
 * Work out the ONE instant at which this clock next needs attention.
 *
 * Four candidates, earliest wins:
 *   breach    — `due_at`, while the clock is running and unbreached.
 *   warn      — the next unfired warning threshold.
 *   boundary  — the next calendar edge, but ONLY when the target actually
 *               pauses on `outside_hours`. A target that does not is entirely
 *               indifferent to closing time (its calendar already handles it),
 *               and arming a boundary timer for it would wake the ticker twice
 *               a day per instance for nothing.
 *   resume    — a paused clock waiting on a calendar edge to reopen.
 */
async function computeNextTimer(
  tenantId: number,
  row: SlaInstanceRow,
  target: SlaTargetPlan | null,
  loaded: LoadedCalendar,
  state: ReplayState,
  fromMs: number,
  executor: Executor,
): Promise<ArmedTimer | null> {
  if (row.status !== 'running' && row.status !== 'paused') return null;

  const candidates: ArmedTimer[] = [];
  const dueMs = state.dueAtMs ?? ms(row.due_at);
  const running = state.activePauses.size === 0;

  if (running && dueMs !== null && row.breached_at === null && dueMs > fromMs) {
    candidates.push({ at: new Date(dueMs), kind: 'breach' });
  }

  if (running && dueMs !== null && target !== null && state.budgetMs !== null && state.budgetMs > 0) {
    const warnedAt = ms(row.warned_at);
    for (const percent of target.warnPercents) {
      // The warning instant is "budget × pct spent", expressed as the moment
      // the REMAINING business time falls to (100 − pct)% of the budget. Walking
      // back from `due_at` keeps it correct across pauses without re-deriving
      // the elapsed sum.
      const remainingAtWarn = (state.budgetMs * (100 - percent)) / 100;
      const warnMs = dueMs - remainingAtWarnToRealMs(loaded.calendar, dueMs, remainingAtWarn);
      if (!Number.isFinite(warnMs)) continue;
      if (warnedAt !== null && warnMs <= warnedAt) continue; // already fired
      if (warnMs <= fromMs) {
        candidates.push({ at: new Date(fromMs), kind: 'warn' });
        break;
      }
      candidates.push({ at: new Date(warnMs), kind: 'warn' });
      break; // thresholds are ascending — the first unfired one is the next
    }
  }

  // ── Calendar edges ─────────────────────────────────────────────────────────
  // Only for a target that actually pauses on `outside_hours`. A target that
  // does not is entirely indifferent to closing time — its calendar already
  // stops counting — and arming an edge for it would wake the ticker twice a
  // day, per instance, to do nothing.
  //
  // The timer's KIND is decided by the edge, not by whether the clock happens
  // to be running: arming a `boundary` (pause) on an OPENING edge would pause
  // the desk precisely when it opened. And when the calendar is already in the
  // wrong state — closed with no `outside_hours` pause, or open while still
  // holding one — the timer is armed for NOW so the next tick corrects it
  // rather than waiting for the following edge.
  const wantsBoundary = target?.pauseSources.includes('outside_hours') === true;
  if (wantsBoundary && target !== null) {
    const hoursSlug = target.pauseCalendarSlug ?? (await defaultCalendarSlug(tenantId, executor));
    const hours = await resolveCalendar(tenantId, hoursSlug, executor);

    // An office-hours calendar that never closes has no edges to arm, and a
    // pause that can never fire is worth saying nothing about here — the
    // validator is where that mis-configuration gets named.
    if (!hours.is24x7) {
      const openNow = await isCalendarOpenAt(tenantId, hours.slug, fromMs, executor);
      const pausedForHours = state.activePauses.has('outside_hours');

      if (!openNow && !pausedForHours) {
        candidates.push({ at: new Date(fromMs), kind: 'boundary' });
      } else if (openNow && pausedForHours) {
        candidates.push({ at: new Date(fromMs), kind: 'resume' });
      } else {
        const boundary = await calendarNextBoundary(tenantId, hours.slug, fromMs, executor);
        if (boundary && boundary.atMs > fromMs) {
          candidates.push({
            at: new Date(boundary.atMs),
            kind: boundary.kind === 'close' ? 'boundary' : 'resume',
          });
        }
      }
    }
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((best, entry) => (entry.at.getTime() < best.at.getTime() ? entry : best));
}

/**
 * Convert "N business ms still owed at the deadline" into the real-time offset
 * back from `dueMs`. Business time and wall time diverge across a weekend, so
 * subtracting business ms from a wall-clock instant directly would put a
 * Friday-evening warning somewhere in the middle of Saturday.
 */
function remainingAtWarnToRealMs(calendar: BusinessCalendar, dueMs: number, remainingBusinessMs: number): number {
  if (remainingBusinessMs <= 0) return 0;
  // Walk backwards by doubling until the window contains enough business time,
  // then bisect. Bounded by a year, which no SLA warning outlives.
  let span = Math.max(remainingBusinessMs, MINUTE_MS);
  const cap = 366 * 86_400_000;
  while (span < cap && businessMillisBetween(calendar, dueMs - span, dueMs) < remainingBusinessMs) {
    span *= 2;
  }
  let low = 0;
  let high = Math.min(span, cap);
  while (high - low > 1_000) {
    const mid = low + Math.floor((high - low) / 2);
    if (businessMillisBetween(calendar, dueMs - mid, dueMs) >= remainingBusinessMs) high = mid;
    else low = mid;
  }
  return high;
}

async function armTimer(
  tenantId: number,
  instanceId: number,
  timer: ArmedTimer | null,
  executor: Executor,
): Promise<void> {
  await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.id', instanceId)
    .update({
      next_timer_at: timer?.at ?? null,
      timer_kind: timer?.kind ?? null,
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Instance state: read, write, denormalise
// ═════════════════════════════════════════════════════════════════════════════

interface LoadedInstance {
  row: SlaInstanceRow;
  ledger: SlaLedgerRow[];
  loaded: LoadedCalendar;
  state: ReplayState;
  target: SlaTargetPlan | null;
}

/**
 * Load one instance with everything needed to reason about it: its ledger, its
 * calendar, the replayed state, and the target plan as it is published NOW.
 *
 * The target is looked up by slug against the CURRENT policy, which is a
 * deliberate asymmetry: durations and calendar are pinned on the instance
 * (`policy_version`, `calendar_slug`) so yesterday's tickets cannot be
 * retroactively breached, while pause semantics and warning thresholds are read
 * live so fixing a mis-configured pause rule takes effect on the tickets that
 * are suffering from it. `null` is a legitimate answer — a target deleted from
 * the policy leaves its running clocks alone rather than cancelling them.
 */
async function loadInstance(
  tenantId: number,
  instanceId: number,
  executor: Executor,
  upToMs = Date.now(),
): Promise<LoadedInstance | null> {
  const row = (await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.id', instanceId)
    .first(...INSTANCE_COLUMNS)) as SlaInstanceRow | undefined;
  if (!row) return null;

  const loaded = await resolveCalendar(tenantId, row.calendar_slug, executor);
  const ledger = await readLedger(tenantId, instanceId, executor);
  const startedAtMs = ms(row.started_at) ?? Date.now();
  const state = replayLedger(ledger, loaded.calendar, startedAtMs, upToMs);

  const policies = await loadPolicies(tenantId, executor);
  const policy = policies.find((entry) => entry.slug.toLowerCase() === String(row.policy_slug).toLowerCase());
  const target = policy?.targets.find((entry) => entry.slug.toLowerCase() === String(row.target_slug).toLowerCase()) ?? null;

  return { row, ledger, loaded, state, target };
}

/**
 * Refresh `tickets.due_at` — the denormalised "nearest live deadline" every
 * board sorts on. Recomputed from the instances rather than nudged, because a
 * nudge cannot know that the clock it is replacing was not the nearest one.
 */
async function refreshTicketDueAt(tenantId: number, ticketId: number, executor: Executor): Promise<void> {
  const rows = (await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.ticket_id', ticketId)
    .whereIn('sla_instances.status', ['running', 'paused'])
    .whereNotNull('sla_instances.due_at')
    .min({ soonest: 'sla_instances.due_at' })) as Array<{ soonest: Date | string | null }>;

  await scoped('tickets', tenantId, executor)
    .where('tickets.id', ticketId)
    .update({ due_at: rows[0]?.soonest ?? null });
}

/** Merge a patch into `resolved_via` without losing the resolution trace. */
async function patchResolvedVia(
  tenantId: number,
  instanceId: number,
  patch: Record<string, unknown>,
  executor: Executor,
): Promise<void> {
  const row = (await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.id', instanceId)
    .first('sla_instances.resolved_via')) as { resolved_via: unknown } | undefined;
  const current = parseJsonColumn(row?.resolved_via);
  await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.id', instanceId)
    .update({ resolved_via: JSON.stringify({ ...current, ...patch }) });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Emissions (queued, flushed after the transaction commits)
// ═════════════════════════════════════════════════════════════════════════════

type Emission =
  | { kind: 'warning'; tenantId: number; ticketId: number; number: string; instanceId: number; targetSlug: string; dueAt: string; remainingMinutes: number }
  | { kind: 'breach'; tenantId: number; ticketId: number; number: string; instanceId: number; targetSlug: string; policySlug: string; breachedAt: string };

/**
 * Socket frames are queued and flushed by the caller AFTER its transaction
 * commits. A breach notification emitted inside a transaction that then rolls
 * back is a page full of red that the database disagrees with, and the agent
 * who acts on it has no way to know it was a ghost.
 */
function flushEmissions(emissions: Emission[]): void {
  const at = new Date().toISOString();
  for (const emission of emissions) {
    if (emission.kind === 'warning') {
      const payload = {
        tenantId: emission.tenantId,
        at,
        ticketId: emission.ticketId,
        number: emission.number,
        instanceId: emission.instanceId,
        targetSlug: emission.targetSlug,
        dueAt: emission.dueAt,
        remainingMinutes: emission.remainingMinutes,
      };
      emitToTicket(emission.ticketId, SOCKET_EVENTS.slaWarning, payload);
      emitToTenant(emission.tenantId, SOCKET_EVENTS.slaWarning, payload);
    } else {
      const payload = {
        tenantId: emission.tenantId,
        at,
        ticketId: emission.ticketId,
        number: emission.number,
        instanceId: emission.instanceId,
        targetSlug: emission.targetSlug,
        policySlug: emission.policySlug,
        breachedAt: emission.breachedAt,
      };
      emitToTicket(emission.ticketId, SOCKET_EVENTS.slaBreached, payload);
      emitToTenant(emission.tenantId, SOCKET_EVENTS.slaBreached, payload);
    }
  }
}

async function ticketNumber(tenantId: number, ticketId: number, executor: Executor): Promise<string> {
  const row = (await scoped('tickets', tenantId, executor)
    .where('tickets.id', ticketId)
    .first('tickets.number')) as { number: string } | undefined;
  return row ? String(row.number) : `#${ticketId}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Starting clocks
// ═════════════════════════════════════════════════════════════════════════════

export interface StartInstancesResult {
  created: number[];
  skipped: Array<{ targetSlug: string; reason: string }>;
  resolution: PolicyResolution;
}

/**
 * Start every target of the winning policy that applies to this ticket.
 *
 * Idempotent by construction: `sla_instances_live_uq` (002) permits exactly one
 * live clock per (ticket, target), so a second call — a retried create, a rule
 * firing twice — collides and is skipped rather than opening a parallel clock.
 */
export async function startInstancesForTicket(
  tenantId: number,
  ticket: Ticket,
  executor: Executor,
  options: { reasonCode?: string; actorId?: number | null; onlyTargets?: string[]; at?: Date } = {},
): Promise<StartInstancesResult> {
  const at = options.at ?? new Date();
  const reasonCode = options.reasonCode ?? 'ticket_created';
  const resolution = await resolvePolicy(tenantId, ticket, executor);
  const created: number[] = [];
  const skipped: Array<{ targetSlug: string; reason: string }> = [];

  if (!resolution.plan || !resolution.winner) {
    return { created, skipped: [{ targetSlug: '*', reason: 'no_policy_matched' }], resolution };
  }

  const plan = resolution.plan;
  const winner = resolution.winner;
  const priority = ticket.prioritySlug.toLowerCase();
  const nowIso = at.toISOString();
  // The SAME bag the policy was resolved against, organisation slug included —
  // a target-level `appliesWhen` naming `organization_slug` must not silently
  // evaluate false because this call built a thinner context than the resolver.
  const ctx = conditionContextFor(ticket, resolution.organizationSlug, nowIso);

  for (const target of plan.targets) {
    if (options.onlyTargets && !options.onlyTargets.includes(target.slug)) continue;

    if (target.appliesWhen && !evaluateCondition(target.appliesWhen, ctx).matched) {
      skipped.push({ targetSlug: target.slug, reason: 'target_condition_not_met' });
      continue;
    }
    if (target.startWhen && !evaluateCondition(target.startWhen, ctx).matched) {
      skipped.push({ targetSlug: target.slug, reason: 'start_condition_not_met' });
      continue;
    }

    const budgetMinutes = target.budgetsByPriority[priority];
    if (budgetMinutes === undefined) {
      skipped.push({ targetSlug: target.slug, reason: 'no_duration_for_priority' });
      continue;
    }

    const loaded = await resolveCalendar(tenantId, target.calendarSlug, executor);
    const officeHours = target.pauseSources.includes('outside_hours')
      ? await resolveCalendar(tenantId, target.pauseCalendarSlug ?? (await defaultCalendarSlug(tenantId, executor)), executor)
      : null;
    const issues = validateTarget(target, loaded.is24x7, priority, officeHours?.is24x7).filter(
      (issue) => issue.severity === 'error',
    );
    if (issues.length > 0) {
      // Refused, loudly. Starting a clock on a target that double-pauses would
      // produce a deadline the desk cannot defend, and a missing clock the
      // admin can see beats a wrong clock nobody notices.
      skipped.push({ targetSlug: target.slug, reason: issues[0].code });
      logger.error(
        { tenantId, ticketId: ticket.id, target: target.slug, issue: issues[0].code },
        issues[0].message,
      );
      continue;
    }

    const dueAt = addBusinessMinutesDetailed(loaded.calendar, at, budgetMinutes);
    if (dueAt.exhausted) {
      logger.warn(
        { tenantId, ticketId: ticket.id, target: target.slug, calendar: target.calendarSlug },
        'Calendar offered no working time within the scan cap — due date fell back to continuous time',
      );
    }

    const resolvedVia = {
      resolution: {
        at: resolution.at,
        order: resolution.order,
        winner,
        evaluated: resolution.evaluated,
      },
      startedBy: { reasonCode, actorId: options.actorId ?? null },
    };

    // ── Two guards against a second clock, and both are needed ───────────────
    // `sla_instances_live_uq` (002) permits exactly one live clock per
    // (ticket, target), so a duplicate is a constraint violation. In Postgres a
    // violation ABORTS the enclosing transaction — and this code usually runs
    // inside `ticket.service`'s create/transition transaction, so catching the
    // error there and carrying on would leave every later statement failing
    // with "current transaction is aborted". Creating a ticket would 500
    // because an SLA clock already existed, which is absurd.
    //
    // So: a SELECT handles the ordinary case without touching the constraint,
    // and the insert runs inside a SAVEPOINT (`executor.transaction()` nests as
    // one) so a genuine race rolls back the savepoint alone and leaves the
    // caller's transaction healthy.
    const alreadyLive = (await scoped('sla_instances', tenantId, executor)
      .where('sla_instances.ticket_id', ticket.id)
      .where('sla_instances.target_slug', target.slug)
      .whereIn('sla_instances.status', ['running', 'paused'])
      .first('sla_instances.id')) as { id: number } | undefined;

    if (alreadyLive) {
      skipped.push({ targetSlug: target.slug, reason: 'already_live' });
      continue;
    }

    let instanceId: number | null = null;
    try {
      await (executor as Knex.Transaction).transaction(async (savepoint) => {
        const inserted = (await insertScoped(
          'sla_instances',
          tenantId,
          {
            ticket_id: ticket.id,
            target_slug: target.slug,
            policy_slug: plan.slug,
            policy_version: plan.version,
            calendar_slug: loaded.slug,
            started_at: at,
            due_at: new Date(dueAt.atMs),
            paused_ms: 0,
            running: true,
            status: 'running',
            resolved_via: JSON.stringify(resolvedVia),
          },
          savepoint,
        ).returning('id')) as Array<{ id: number }>;
        instanceId = Number(inserted[0]?.id ?? 0) || null;
      });
    } catch (error) {
      skipped.push({ targetSlug: target.slug, reason: 'already_live' });
      logger.debug(
        { tenantId, ticketId: ticket.id, target: target.slug, err: (error as Error).message },
        'SLA target already has a live clock — not starting a second',
      );
      continue;
    }

    if (instanceId === null) continue;

    await appendLedger(
      {
        tenantId,
        instanceId,
        event: 'start',
        at,
        reasonCode,
        actorId: options.actorId ?? null,
        elapsedBusinessMsBefore: 0,
        newDueAt: new Date(dueAt.atMs),
        note: `${plan.slug}/${target.slug} · ${budgetMinutes} business minutes on ${loaded.slug}`,
      },
      executor,
    );

    // A ticket that is ALREADY in a pausing category when the clock starts must
    // start paused. Creating a ticket straight into "scheduled" and having its
    // resolution clock run anyway is a real and frequently-hit bug.
    if (target.pauseCategories.includes(ticket.statusCategory)) {
      await scoped('sla_instances', tenantId, executor)
        .where('sla_instances.id', instanceId)
        .update({ running: false, status: 'paused' });
      await appendLedger(
        {
          tenantId,
          instanceId,
          event: 'pause',
          at: new Date(at.getTime() + 1),
          reasonCode: ticket.statusCategory,
          actorId: options.actorId ?? null,
          elapsedBusinessMsBefore: 0,
        },
        executor,
      );
    }

    created.push(instanceId);
    await rearm(tenantId, instanceId, executor, at.getTime());
  }

  if (created.length > 0) await refreshTicketDueAt(tenantId, ticket.id, executor);
  return { created, skipped, resolution };
}

/** Recompute and store the instance's next timer. Cheap, and always safe. */
async function rearm(
  tenantId: number,
  instanceId: number,
  executor: Executor,
  fromMs = Date.now(),
): Promise<void> {
  const loadedInstance = await loadInstance(tenantId, instanceId, executor, fromMs);
  if (!loadedInstance) return;
  const timer = await computeNextTimer(
    tenantId,
    loadedInstance.row,
    loadedInstance.target,
    loadedInstance.loaded,
    loadedInstance.state,
    fromMs,
    executor,
  );
  await armTimer(tenantId, instanceId, timer, executor);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — Pause / resume / stop
// ═════════════════════════════════════════════════════════════════════════════

export interface ClockChangeOptions {
  actorId?: number | null;
  at?: Date;
  note?: string | null;
}

/**
 * Pause one instance for `reason`. Overlapping reasons are a SET, not a flag:
 * a ticket that is both pending on the requester and sitting on an offline
 * device is paused twice, and clearing one of the two must not restart the
 * clock. That is why the pause state is replayed from the ledger rather than
 * kept as a boolean.
 */
async function pauseInstance(
  tenantId: number,
  instance: LoadedInstance,
  reason: string,
  executor: Executor,
  options: ClockChangeOptions = {},
): Promise<boolean> {
  const at = options.at ?? new Date();
  if (instance.row.status !== 'running' && instance.row.status !== 'paused') return false;
  if (instance.state.activePauses.has(reason)) return false;

  await appendLedger(
    {
      tenantId,
      instanceId: instance.row.id,
      event: 'pause',
      at,
      reasonCode: reason,
      actorId: options.actorId ?? null,
      elapsedBusinessMsBefore: instance.state.elapsedMs,
      note: options.note ?? null,
    },
    executor,
  );

  await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.id', instance.row.id)
    .update({
      running: false,
      status: 'paused',
      paused_ms: Math.round(instance.state.pausedMs),
    });

  await rearm(tenantId, instance.row.id, executor, at.getTime());
  await refreshTicketDueAt(tenantId, instance.row.ticket_id, executor);
  return true;
}

/**
 * Lift one pause reason. The clock only restarts when the LAST reason is gone,
 * and when it does, `due_at` is pushed forward by exactly the business time
 * that was still owed at the pause — never recomputed from the budget, which
 * would silently forgive the time already spent.
 */
async function resumeInstance(
  tenantId: number,
  instance: LoadedInstance,
  reason: string | null,
  executor: Executor,
  options: ClockChangeOptions = {},
): Promise<boolean> {
  const at = options.at ?? new Date();
  if (instance.row.status !== 'paused') return false;
  if (reason !== null && reason !== 'all' && !instance.state.activePauses.has(reason)) return false;

  // What was owed when the clock STOPPED — measured by the replay at the first
  // pause of this period, never re-measured from the reason being lifted.
  const remaining =
    instance.state.remainingAtPauseMs ??
    (instance.state.dueAtMs === null
      ? null
      : businessMillisBetween(instance.loaded.calendar, at, instance.state.dueAtMs));

  const willRun =
    reason === null || reason === 'all' || instance.state.activePauses.size <= 1;

  const newDueAt =
    willRun && remaining !== null
      ? new Date(addBusinessMinutesDetailed(instance.loaded.calendar, at, remaining / MINUTE_MS).atMs)
      : null;

  await appendLedger(
    {
      tenantId,
      instanceId: instance.row.id,
      event: 'resume',
      at,
      reasonCode: reason,
      actorId: options.actorId ?? null,
      elapsedBusinessMsBefore: instance.state.elapsedMs,
      newDueAt,
      note: options.note ?? null,
    },
    executor,
  );

  const patch: Record<string, unknown> = { paused_ms: Math.round(instance.state.pausedMs) };
  if (willRun) {
    patch.running = true;
    patch.status = 'running';
    if (newDueAt) patch.due_at = newDueAt;
  }

  await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.id', instance.row.id)
    .update(patch);

  await rearm(tenantId, instance.row.id, executor, at.getTime());
  await refreshTicketDueAt(tenantId, instance.row.ticket_id, executor);
  return true;
}

/** Stop a clock as MET. */
async function meetInstance(
  tenantId: number,
  instance: LoadedInstance,
  reason: string,
  executor: Executor,
  options: ClockChangeOptions & { stoppedBy?: Record<string, unknown> } = {},
): Promise<boolean> {
  const at = options.at ?? new Date();
  if (instance.row.status !== 'running' && instance.row.status !== 'paused') return false;

  await appendLedger(
    {
      tenantId,
      instanceId: instance.row.id,
      event: 'met',
      at,
      reasonCode: reason,
      actorId: options.actorId ?? null,
      elapsedBusinessMsBefore: instance.state.elapsedMs,
      note: options.note ?? null,
    },
    executor,
  );

  await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.id', instance.row.id)
    .update({
      status: 'met',
      running: false,
      met_at: at,
      paused_ms: Math.round(instance.state.pausedMs),
      next_timer_at: null,
      timer_kind: null,
    });

  if (options.stoppedBy) {
    await patchResolvedVia(tenantId, instance.row.id, { stoppedBy: options.stoppedBy }, executor);
  }
  await refreshTicketDueAt(tenantId, instance.row.ticket_id, executor);
  return true;
}

/** Stop a clock as CANCELLED — merged, deleted, auto-resolved by the source. */
async function cancelInstance(
  tenantId: number,
  instance: LoadedInstance,
  reason: string,
  executor: Executor,
  options: ClockChangeOptions & { stoppedBy?: Record<string, unknown> } = {},
): Promise<boolean> {
  const at = options.at ?? new Date();
  if (instance.row.status !== 'running' && instance.row.status !== 'paused') return false;

  await appendLedger(
    {
      tenantId,
      instanceId: instance.row.id,
      event: 'cancel',
      at,
      reasonCode: reason,
      actorId: options.actorId ?? null,
      elapsedBusinessMsBefore: instance.state.elapsedMs,
      note: options.note ?? null,
    },
    executor,
  );

  await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.id', instance.row.id)
    .update({
      status: 'cancelled',
      running: false,
      paused_ms: Math.round(instance.state.pausedMs),
      next_timer_at: null,
      timer_kind: null,
    });

  if (options.stoppedBy) {
    await patchResolvedVia(tenantId, instance.row.id, { stoppedBy: options.stoppedBy }, executor);
  }
  await refreshTicketDueAt(tenantId, instance.row.ticket_id, executor);
  return true;
}

/** Record a breach. Does NOT stop the clock — see `replayLedger`. */
async function breachInstance(
  tenantId: number,
  instance: LoadedInstance,
  executor: Executor,
  at: Date,
  emissions: Emission[],
): Promise<boolean> {
  if (instance.row.breached_at !== null) return false;
  if (instance.row.status !== 'running' && instance.row.status !== 'paused') return false;

  await appendLedger(
    {
      tenantId,
      instanceId: instance.row.id,
      event: 'breach',
      at,
      reasonCode: 'due_at_passed',
      elapsedBusinessMsBefore: instance.state.elapsedMs,
      newDueAt: instance.state.dueAtMs === null ? null : new Date(instance.state.dueAtMs),
    },
    executor,
  );

  await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.id', instance.row.id)
    .update({ status: 'breached', running: false, breached_at: at });

  emissions.push({
    kind: 'breach',
    tenantId,
    ticketId: instance.row.ticket_id,
    number: await ticketNumber(tenantId, instance.row.ticket_id, executor),
    instanceId: instance.row.id,
    targetSlug: String(instance.row.target_slug),
    policySlug: String(instance.row.policy_slug),
    breachedAt: at.toISOString(),
  });
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Lifecycle hooks (the SlaEngineHook contract in ticket.service)
// ═════════════════════════════════════════════════════════════════════════════

async function liveInstances(
  tenantId: number,
  ticketId: number,
  executor: Executor,
): Promise<SlaInstanceRow[]> {
  return (await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.ticket_id', ticketId)
    .whereIn('sla_instances.status', ['running', 'paused'])
    .orderBy('sla_instances.id', 'asc')
    .select(...INSTANCE_COLUMNS)) as SlaInstanceRow[];
}

/**
 * A ticket the alert spine opened AND closed within seconds produced no human
 * work. It must not produce a breach, and it must not produce a first-response
 * metric either — a monitor that flaps five times an hour would otherwise
 * manufacture five "responded in 4 seconds" data points and make the desk's
 * median response time a fiction.
 */
function isAlertAutoResolution(ticket: Ticket, atMs: number): boolean {
  if (ticket.source !== 'alert') return false;
  const createdMs = ms(ticket.createdAt);
  if (createdMs === null) return false;
  return atMs - createdMs <= ALERT_AUTO_RESOLVE_GRACE_MS;
}

export async function onTicketCreated(event: {
  tenantId: number;
  ticket: Ticket;
  trx: Knex.Transaction;
}): Promise<void> {
  const { tenantId, ticket, trx } = event;
  await withDecision(
    {
      tenantId,
      ticketId: ticket.id,
      subsystem: 'sla',
      decision: 'sla_clocks_started',
      actorType: 'automation',
      trx,
    },
    async (recorder) => {
      const result = await startInstancesForTicket(tenantId, ticket, trx, {
        reasonCode: 'ticket_created',
      });
      recorder
        .rule(result.resolution.winner?.policySlug ?? null, result.resolution.winner?.policyVersion ?? null)
        .input({
          prioritySlug: ticket.prioritySlug,
          queueSlug: ticket.queueSlug,
          recordType: ticket.recordType,
          organizationId: ticket.organizationId,
          resolutionOrder: result.resolution.order,
          evaluated: result.resolution.evaluated,
        })
        .outcome({ started: result.created.length, instances: result.created, skipped: result.skipped });
      if (result.created.length === 0) {
        recorder.noop(
          result.resolution.winner
            ? 'policy matched but no target applied to this ticket'
            : 'no SLA policy matched this ticket',
        );
      } else {
        recorder.decide(
          `SLA ${result.resolution.winner?.policySlug} won at the ${result.resolution.winner?.level} level; ` +
            `${result.created.length} clock(s) started`,
        );
      }
    },
  );
}

export async function onCategoryChanged(event: {
  tenantId: number;
  ticket: Ticket;
  fromCategory: StatusCategory;
  toCategory: StatusCategory;
  trx: Knex.Transaction;
}): Promise<void> {
  const { tenantId, ticket, fromCategory, toCategory, trx } = event;
  const at = new Date();

  await withDecision(
    {
      tenantId,
      ticketId: ticket.id,
      subsystem: 'sla',
      decision: 'sla_category_change',
      actorType: 'automation',
      trx,
    },
    async (recorder) => {
      const rows = await liveInstances(tenantId, ticket.id, trx);
      const actions: Array<Record<string, unknown>> = [];

      // The alert spine's open-and-close-in-seconds case, handled once for the
      // whole ticket rather than per target.
      const autoResolved = stopsSla(toCategory) && isAlertAutoResolution(ticket, at.getTime());

      for (const row of rows) {
        const instance = await loadInstance(tenantId, row.id, trx, at.getTime());
        if (!instance) continue;
        const target = instance.target;

        if (autoResolved) {
          await cancelInstance(tenantId, instance, 'alert_auto_resolved', trx, {
            at,
            stoppedBy: { kind: 'rule', ruleSlug: 'alert_spine', autoResolved: true },
            note: 'Opened and closed by the alert source inside the grace window — no human work, no outcome.',
          });
          actions.push({ instanceId: row.id, action: 'cancelled', reason: 'alert_auto_resolved' });
          continue;
        }

        // Cancel beats meet: a target that names `cancelled` in its cancel list
        // must not be recorded as satisfied by a ticket nobody fixed.
        if (target && target.cancelCategories.includes(toCategory)) {
          await cancelInstance(tenantId, instance, `status_category:${toCategory}`, trx, {
            at,
            stoppedBy: { kind: 'transition', toStatusSlug: ticket.statusSlug },
          });
          actions.push({ instanceId: row.id, action: 'cancelled', reason: toCategory });
          continue;
        }

        // HARD RULE 5 — `stopsSla()` and `pausesSla()` decide, never a slug.
        if (stopsSla(toCategory)) {
          const stopKind = target?.stopKind ?? 'category';
          const stopCategory = target?.stopCategory ?? 'resolved';
          const satisfied =
            stopKind === 'category'
              ? toCategory === stopCategory || (stopCategory === 'resolved' && toCategory === 'closed')
              : stopKind === 'manual';

          if (satisfied) {
            await meetInstance(tenantId, instance, `status_category:${toCategory}`, trx, {
              at,
              stoppedBy: { kind: 'transition', toStatusSlug: ticket.statusSlug },
            });
            actions.push({ instanceId: row.id, action: 'met', reason: toCategory });
          } else {
            // A response target still open when the ticket is resolved without
            // one was never met — cancel it rather than pretend.
            await cancelInstance(tenantId, instance, `status_category:${toCategory}`, trx, {
              at,
              stoppedBy: { kind: 'transition', toStatusSlug: ticket.statusSlug },
              note: 'Ticket left the working set before this target was satisfied.',
            });
            actions.push({ instanceId: row.id, action: 'cancelled', reason: toCategory });
          }
          continue;
        }

        const pauseCategories = target?.pauseCategories ?? defaultPauseCategories();
        const shouldPause = pauseCategories.includes(toCategory);
        const wasPausedForCategory = instance.state.activePauses.has(fromCategory);

        if (shouldPause) {
          if (await pauseInstance(tenantId, instance, toCategory, trx, { at })) {
            actions.push({ instanceId: row.id, action: 'paused', reason: toCategory });
          }
          if (wasPausedForCategory && fromCategory !== toCategory) {
            const refreshed = await loadInstance(tenantId, row.id, trx, at.getTime());
            if (refreshed) await resumeInstance(tenantId, refreshed, fromCategory, trx, { at });
          }
        } else if (wasPausedForCategory) {
          if (await resumeInstance(tenantId, instance, fromCategory, trx, { at })) {
            actions.push({ instanceId: row.id, action: 'resumed', reason: fromCategory });
          }
        }
      }

      recorder
        .input({ fromCategory, toCategory, statusSlug: ticket.statusSlug, source: ticket.source })
        .outcome({ actions, autoResolved });
      recorder.decide(
        actions.length === 0
          ? `No SLA clock moved for ${fromCategory} → ${toCategory}`
          : `${actions.length} SLA clock(s) reacted to ${fromCategory} → ${toCategory}`,
      );
    },
  );
}

/**
 * Reopen. A NEW instance is started and the old one is never resumed — a
 * reopened ticket owes a fresh resolution clock, and resuming the old one would
 * silently forgive the days the ticket spent closed.
 */
export async function startTarget(event: {
  tenantId: number;
  ticket: Ticket;
  targetSlug: string;
  reasonCode: string;
  actorId: number | null;
  trx: Knex.Transaction;
}): Promise<number | null> {
  const { tenantId, ticket, targetSlug, reasonCode, actorId, trx } = event;
  return withDecision(
    {
      tenantId,
      ticketId: ticket.id,
      subsystem: 'sla',
      decision: 'sla_target_started',
      actorId,
      actorType: actorId === null ? 'automation' : 'user',
      trx,
    },
    async (recorder) => {
      const result = await startInstancesForTicket(tenantId, ticket, trx, {
        reasonCode,
        actorId,
        onlyTargets: [targetSlug],
      });
      const instanceId = result.created[0] ?? null;
      recorder
        .rule(result.resolution.winner?.policySlug ?? null, result.resolution.winner?.policyVersion ?? null)
        .input({ targetSlug, reasonCode, reopenCount: ticket.reopenCount })
        .outcome({ instanceId, skipped: result.skipped })
        .decide(
          instanceId === null
            ? `No new ${targetSlug} clock: ${result.skipped[0]?.reason ?? 'no policy matched'}`
            : `Fresh ${targetSlug} clock #${instanceId} started (${reasonCode})`,
        );
      return instanceId;
    },
  );
}

/** Merge / delete: every live clock stops, and says why. */
export async function cancelForTicket(event: {
  tenantId: number;
  ticketId: number;
  reasonCode: string;
  actorId: number | null;
  trx: Knex.Transaction;
}): Promise<number[]> {
  const { tenantId, ticketId, reasonCode, actorId, trx } = event;
  return withDecision(
    {
      tenantId,
      ticketId,
      subsystem: 'sla',
      decision: 'sla_clocks_cancelled',
      actorId,
      actorType: actorId === null ? 'automation' : 'user',
      trx,
    },
    async (recorder) => {
      const at = new Date();
      const rows = await liveInstances(tenantId, ticketId, trx);
      const stopped: number[] = [];
      for (const row of rows) {
        const instance = await loadInstance(tenantId, row.id, trx, at.getTime());
        if (!instance) continue;
        if (
          await cancelInstance(tenantId, instance, reasonCode, trx, {
            at,
            actorId,
            stoppedBy: { kind: 'cancelled', actorId, reason: reasonCode },
          })
        ) {
          stopped.push(row.id);
        }
      }
      recorder
        .input({ reasonCode })
        .outcome({ stopped })
        .decide(
          stopped.length === 0
            ? 'No live SLA clock to stop'
            : `${stopped.length} SLA clock(s) stopped (${reasonCode})`,
        );
      return stopped;
    },
  );
}

/**
 * Priority changed mid-flight — the most-argued question in every ITSM tool.
 *
 *   keep_elapsed          the elapsed business time carries over; the deadline
 *                         is the NEW budget minus what has already been spent,
 *                         measured from now. An upgrade to P1 can therefore
 *                         land a deadline in the past, which is correct and is
 *                         precisely the honest answer.
 *   restart               a clean clock from now on the new budget. The elapsed
 *                         time is still in the ledger; it simply stops counting
 *                         against the target.
 *   recompute_from_start  the deadline the ticket would have had if it had been
 *                         raised at this priority to begin with. The DEFAULT,
 *                         because it is the only mode where a downgrade cannot
 *                         erase a breach that has already happened.
 *
 * Whichever mode applies, a `target_switch` row lands carrying BOTH the old and
 * the new `due_at` — the old one in `note`, the new one in `new_due_at` — so
 * the argument has a document.
 */
export async function onPriorityChanged(event: {
  tenantId: number;
  ticket: Ticket;
  fromPriority: string;
  toPriority: string;
  actorId?: number | null;
  trx: Knex.Transaction;
}): Promise<void> {
  const { tenantId, ticket, fromPriority, toPriority, trx } = event;
  if (fromPriority.toLowerCase() === toPriority.toLowerCase()) return;

  const at = new Date();
  await withDecision(
    {
      tenantId,
      ticketId: ticket.id,
      subsystem: 'sla',
      decision: 'sla_target_switch',
      actorId: event.actorId ?? null,
      actorType: event.actorId ? 'user' : 'automation',
      trx,
    },
    async (recorder) => {
      const rows = await liveInstances(tenantId, ticket.id, trx);
      const switched: Array<Record<string, unknown>> = [];

      for (const row of rows) {
        const instance = await loadInstance(tenantId, row.id, trx, at.getTime());
        if (!instance || !instance.target) continue;
        const target = instance.target;

        if (target.freezeOnPriorityChange) {
          switched.push({ instanceId: row.id, mode: 'frozen', reason: 'reevaluateOnPriorityChange=false' });
          continue;
        }

        const newBudget = target.budgetsByPriority[toPriority.toLowerCase()];
        if (newBudget === undefined) {
          switched.push({ instanceId: row.id, mode: 'skipped', reason: 'no_duration_for_priority' });
          continue;
        }

        const oldDueMs = instance.state.dueAtMs ?? ms(row.due_at);
        const calendar = instance.loaded.calendar;
        const startedAtMs = ms(row.started_at) ?? at.getTime();
        let newDueMs: number;

        switch (target.switchMode) {
          case 'restart':
            newDueMs = addBusinessMinutesDetailed(calendar, at, newBudget).atMs;
            break;
          case 'keep_elapsed': {
            const remaining = newBudget * MINUTE_MS - instance.state.elapsedMs;
            newDueMs =
              remaining <= 0
                ? at.getTime()
                : addBusinessMinutesDetailed(calendar, at, remaining / MINUTE_MS).atMs;
            break;
          }
          case 'recompute_from_start':
          default:
            newDueMs = addBusinessMinutesDetailed(calendar, startedAtMs, newBudget).atMs;
            break;
        }

        await appendLedger(
          {
            tenantId,
            instanceId: row.id,
            event: 'target_switch',
            at,
            reasonCode: `priority:${fromPriority}->${toPriority}`,
            actorId: event.actorId ?? null,
            elapsedBusinessMsBefore: instance.state.elapsedMs,
            newDueAt: new Date(newDueMs),
            note:
              `mode=${target.switchMode} · old_due_at=${oldDueMs === null ? 'null' : new Date(oldDueMs).toISOString()} · ` +
              `new_due_at=${new Date(newDueMs).toISOString()} · budget=${newBudget}m`,
          },
          trx,
        );

        await scoped('sla_instances', tenantId, trx)
          .where('sla_instances.id', row.id)
          .update({
            due_at: new Date(newDueMs),
            // A switch re-opens the warning question: the new budget moves every
            // threshold, so a warning already fired against the old one has not
            // been fired against this one.
            warned_at: null,
          });

        await rearm(tenantId, row.id, trx, at.getTime());
        switched.push({
          instanceId: row.id,
          mode: target.switchMode,
          oldDueAt: oldDueMs === null ? null : new Date(oldDueMs).toISOString(),
          newDueAt: new Date(newDueMs).toISOString(),
          budgetMinutes: newBudget,
        });
      }

      if (switched.length > 0) await refreshTicketDueAt(tenantId, ticket.id, trx);

      recorder
        .input({ fromPriority, toPriority })
        .outcome({ switched })
        .decide(
          switched.length === 0
            ? `Priority ${fromPriority} → ${toPriority} moved no SLA clock`
            : `Priority ${fromPriority} → ${toPriority} switched ${switched.length} target(s)`,
        );
    },
  );
}

/**
 * Record type changed — the policy must be RE-RESOLVED, because record type is
 * one of the five resolution levels. An incident promoted to a problem may be
 * governed by an entirely different policy, and leaving the old clocks running
 * would hold it to a contract that no longer applies.
 */
export async function onRecordTypeChanged(event: {
  tenantId: number;
  ticket: Ticket;
  fromRecordType: string;
  toRecordType: string;
  actorId?: number | null;
  trx: Knex.Transaction;
}): Promise<void> {
  const { tenantId, ticket, fromRecordType, toRecordType, trx } = event;
  if (fromRecordType === toRecordType) return;

  const at = new Date();
  await withDecision(
    {
      tenantId,
      ticketId: ticket.id,
      subsystem: 'sla',
      decision: 'sla_policy_reresolved',
      actorId: event.actorId ?? null,
      actorType: event.actorId ? 'user' : 'automation',
      trx,
    },
    async (recorder) => {
      const resolution = await resolvePolicy(tenantId, ticket, trx);
      const rows = await liveInstances(tenantId, ticket.id, trx);
      const nextSlug = resolution.winner?.policySlug ?? null;

      const unchanged = rows.every(
        (row) => nextSlug !== null && String(row.policy_slug).toLowerCase() === nextSlug.toLowerCase(),
      );

      if (unchanged && rows.length > 0) {
        recorder
          .input({ fromRecordType, toRecordType })
          .outcome({ policySlug: nextSlug, changed: false })
          .noop('record type changed but the winning policy did not');
        return;
      }

      const cancelled: number[] = [];
      for (const row of rows) {
        const instance = await loadInstance(tenantId, row.id, trx, at.getTime());
        if (!instance) continue;
        if (
          await cancelInstance(tenantId, instance, 'record_type_changed', trx, {
            at,
            actorId: event.actorId ?? null,
            stoppedBy: { kind: 'rule', ruleSlug: 'record_type_changed', fromRecordType, toRecordType },
            note: `Policy re-resolved after ${fromRecordType} → ${toRecordType}.`,
          })
        ) {
          cancelled.push(row.id);
        }
      }

      const restarted = await startInstancesForTicket(tenantId, ticket, trx, {
        reasonCode: 'record_type_changed',
        actorId: event.actorId ?? null,
        at,
      });

      recorder
        .rule(nextSlug, resolution.winner?.policyVersion ?? null)
        .input({ fromRecordType, toRecordType, evaluated: resolution.evaluated })
        .outcome({ cancelled, started: restarted.created })
        .decide(
          `Record type ${fromRecordType} → ${toRecordType}: ${cancelled.length} clock(s) stopped, ` +
            `${restarted.created.length} restarted under "${nextSlug ?? 'no policy'}"`,
        );
    },
  );
}

/**
 * The first public agent reply satisfies every `first_response` target.
 *
 * Deliberately NOT applied to a ticket the alert spine opened and closed inside
 * the grace window: an automated recovery note is not a first response, and
 * counting it produces a response-time median made of robot conversations.
 */
export async function onFirstResponse(event: {
  tenantId: number;
  ticket: Ticket;
  at?: Date;
  actorId?: number | null;
  journalEntryId?: number | null;
  trx: Knex.Transaction;
}): Promise<void> {
  const { tenantId, ticket, trx } = event;
  const at = event.at ?? new Date();

  await withDecision(
    {
      tenantId,
      ticketId: ticket.id,
      subsystem: 'sla',
      decision: 'sla_first_response',
      actorId: event.actorId ?? null,
      actorType: event.actorId ? 'user' : 'automation',
      trx,
    },
    async (recorder) => {
      if (isAlertAutoResolution(ticket, at.getTime())) {
        recorder
          .input({ source: ticket.source, createdAt: ticket.createdAt })
          .noop('alert opened and closed inside the grace window — not a first response');
        return;
      }

      const rows = await liveInstances(tenantId, ticket.id, trx);
      const met: number[] = [];
      for (const row of rows) {
        const instance = await loadInstance(tenantId, row.id, trx, at.getTime());
        if (!instance || instance.target?.stopKind !== 'first_response') continue;
        if (
          await meetInstance(tenantId, instance, 'first_public_reply', trx, {
            at,
            actorId: event.actorId ?? null,
            stoppedBy: {
              kind: 'journal',
              journalId: event.journalEntryId ?? undefined,
              actorId: event.actorId ?? null,
            },
          })
        ) {
          met.push(row.id);
        }
      }
      recorder
        .input({ journalEntryId: event.journalEntryId ?? null })
        .outcome({ met })
        .decide(met.length === 0 ? 'No response target was open' : `${met.length} response target(s) met`);
    },
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — Device-offline and maintenance pausing
// ═════════════════════════════════════════════════════════════════════════════

interface CiStateRow {
  ci_id: number;
  online: boolean | null;
  state: unknown;
  observed_at: Date | string | null;
}

/**
 * Read the CI liveness cache and say plainly what it knows.
 *
 * `unknown` is a first-class answer. `ci_state_cache` is a cache the suite
 * poller refreshes; when the poller is down, the rows go stale and the honest
 * report is "I do not know", not "the device is up" and not "the device is
 * down". Both of those guesses are wrong in the direction that hurts.
 */
async function readCiState(
  tenantId: number,
  ciId: number,
  executor: Executor,
  nowMs: number,
): Promise<{ known: boolean; online: boolean | null; inMaintenance: boolean; observedAt: string | null }> {
  const row = (await scoped('ci_state_cache', tenantId, executor)
    .where('ci_state_cache.ci_id', ciId)
    .first(
      'ci_state_cache.ci_id',
      'ci_state_cache.online',
      'ci_state_cache.state',
      'ci_state_cache.observed_at',
    )) as CiStateRow | undefined;

  if (!row) return { known: false, online: null, inMaintenance: false, observedAt: null };

  const observedMs = ms(row.observed_at);
  const fresh = observedMs !== null && nowMs - observedMs <= CI_STATE_STALE_AFTER_MS;
  const state = parseJsonColumn(row.state);
  const maintenance = state.maintenance;
  const inMaintenance =
    isRecord(maintenance) ? maintenance.inMaintenance === true || maintenance.in_maintenance === true : false;

  return {
    known: fresh && row.online !== null,
    online: row.online,
    inMaintenance: fresh ? inMaintenance : false,
    observedAt: iso(row.observed_at),
  };
}

/**
 * React to a CI state transition arriving through the alert envelope.
 *
 * The three outcomes, each of them mandatory:
 *   offline + fresh  → pause every clock on every ticket bound to the CI whose
 *                      target opted into `device_offline`.
 *   online  + fresh  → lift that pause.
 *   unknown / stale  → do NOT pause, and write a visible `note` row with reason
 *                      `pause_source_unavailable`. Never keep counting silently
 *                      and never stop counting silently: an engine that guesses
 *                      here is an engine whose numbers cannot be defended, and
 *                      an unexplained pause is worse than a wrong one because
 *                      nobody knows to go looking.
 */
export async function onCiStateChanged(event: {
  tenantId: number;
  ciId: number;
  at?: Date;
  executor?: Executor;
}): Promise<void> {
  const tenantId = event.tenantId;
  const at = event.at ?? new Date();
  const executor = event.executor ?? db;

  const state = await readCiState(tenantId, event.ciId, executor, at.getTime());

  // Which live clocks care? Only tickets bound to this CI, and only targets
  // that opted into device_offline — join first, decide second.
  const rows = (await scoped('sla_instances', tenantId, executor)
    .join('tickets', 'tickets.id', 'sla_instances.ticket_id')
    .where('tickets.tenant_id', tenantId)
    .whereIn('sla_instances.status', ['running', 'paused'])
    .where((builder) =>
      builder.where('tickets.primary_ci_id', event.ciId).orWhereExists((sub) => {
        void sub
          .select(db.raw('1'))
          .from('ticket_cis')
          .whereRaw('ticket_cis.ticket_id = tickets.id')
          .where('ticket_cis.tenant_id', tenantId)
          .where('ticket_cis.ci_id', event.ciId);
      }),
    )
    .select(...INSTANCE_COLUMNS)) as SlaInstanceRow[];

  if (rows.length === 0) return;

  await withDecision(
    {
      tenantId,
      ticketId: null,
      subsystem: 'sla',
      decision: 'sla_device_state',
      actorType: 'automation',
      trx: executor,
    },
    async (recorder) => {
      const actions: Array<Record<string, unknown>> = [];

      for (const row of rows) {
        const instance = await loadInstance(tenantId, row.id, executor, at.getTime());
        if (!instance) continue;
        if (instance.target?.pauseSources.includes('device_offline') !== true) continue;

        if (!state.known) {
          const alreadyPaused = instance.state.activePauses.has('device_offline');
          if (alreadyPaused) {
            // Paused on evidence that has gone stale. Resume — and say why, in
            // the ledger, where an auditor will find it.
            await resumeInstance(tenantId, instance, 'device_offline', executor, {
              at,
              note: 'CI liveness source unavailable — the pause could no longer be justified.',
            });
            actions.push({ instanceId: row.id, action: 'resumed', reason: 'pause_source_unavailable' });
          }
          await appendLedger(
            {
              tenantId,
              instanceId: row.id,
              event: 'note',
              at,
              reasonCode: 'pause_source_unavailable',
              elapsedBusinessMsBefore: instance.state.elapsedMs,
              note:
                `CI ${event.ciId} liveness is unknown or stale (last observed ${state.observedAt ?? 'never'}). ` +
                'The clock keeps running — degraded deliberately rather than guessing.',
            },
            executor,
          );
          actions.push({ instanceId: row.id, action: 'note', reason: 'pause_source_unavailable' });
          continue;
        }

        if (state.online === false) {
          if (await pauseInstance(tenantId, instance, 'device_offline', executor, { at })) {
            actions.push({ instanceId: row.id, action: 'paused', reason: 'device_offline' });
          }
        } else if (instance.state.activePauses.has('device_offline')) {
          if (await resumeInstance(tenantId, instance, 'device_offline', executor, { at })) {
            actions.push({ instanceId: row.id, action: 'resumed', reason: 'device_offline' });
          }
        }

        // Maintenance rides the same envelope and the same cache row.
        const refreshed = await loadInstance(tenantId, row.id, executor, at.getTime());
        if (refreshed && refreshed.target?.pauseSources.includes('maintenance_window') === true) {
          if (state.inMaintenance) {
            if (await pauseInstance(tenantId, refreshed, 'maintenance_window', executor, { at })) {
              actions.push({ instanceId: row.id, action: 'paused', reason: 'maintenance_window' });
            }
          } else if (refreshed.state.activePauses.has('maintenance_window')) {
            if (await resumeInstance(tenantId, refreshed, 'maintenance_window', executor, { at })) {
              actions.push({ instanceId: row.id, action: 'resumed', reason: 'maintenance_window' });
            }
          }
        }
      }

      recorder
        .input({ ciId: event.ciId, online: state.online, known: state.known, observedAt: state.observedAt })
        .outcome({ actions })
        .decide(
          state.known
            ? `CI ${event.ciId} is ${state.online === false ? 'offline' : 'online'}; ${actions.length} clock(s) reacted`
            : `CI ${event.ciId} liveness unavailable — ${actions.length} clock(s) annotated, none paused`,
        );
    },
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — Manual pause / resume (audited)
// ═════════════════════════════════════════════════════════════════════════════

export interface ManualClockChange {
  instanceId: number;
  status: string;
  running: boolean;
  dueAt: string | null;
  activePauses: string[];
}

/**
 * Both manual operations open their OWN transaction so the ledger row, the
 * instance update and the `decision_log` row commit together (HARD RULE 2). A
 * 404 is raised BEFORE `withDecision` opens: a decision row explaining an
 * action against an instance that does not exist is noise in the one table
 * that has to stay trustworthy.
 */
export async function pauseManually(
  tenantId: number,
  instanceId: number,
  actorId: number | null,
  note: string | null,
  executor: Executor = db,
): Promise<ManualClockChange> {
  const exists = (await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.id', instanceId)
    .first('sla_instances.id', 'sla_instances.ticket_id')) as
    | { id: number; ticket_id: number }
    | undefined;
  if (!exists) throw new SlaNotFoundError(instanceId);

  return db.transaction(async (trx) =>
    withDecision(
      {
        tenantId,
        ticketId: exists.ticket_id,
        subsystem: 'sla',
        decision: 'sla_manual_pause',
        actorId,
        actorType: 'user',
        trx,
      },
      async (recorder) => {
        const at = new Date();
        const instance = await loadInstance(tenantId, instanceId, trx, at.getTime());
        if (!instance) throw new SlaNotFoundError(instanceId);

        const changed = await pauseInstance(tenantId, instance, MANUAL_PAUSE_REASON, trx, {
          at,
          actorId,
          note,
        });
        const after = await loadInstance(tenantId, instanceId, trx, at.getTime());
        recorder
          .input({ instanceId, note })
          .outcome({ changed })
          .decide(
            changed
              ? `Clock #${instanceId} paused manually`
              : `Clock #${instanceId} was already paused manually`,
          );

        return summariseChange(after ?? instance);
      },
    ),
  );
}

export async function resumeManually(
  tenantId: number,
  instanceId: number,
  actorId: number | null,
  note: string | null,
  executor: Executor = db,
): Promise<ManualClockChange> {
  const exists = (await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.id', instanceId)
    .first('sla_instances.id', 'sla_instances.ticket_id')) as
    | { id: number; ticket_id: number }
    | undefined;
  if (!exists) throw new SlaNotFoundError(instanceId);

  return db.transaction(async (trx) =>
    withDecision(
      {
        tenantId,
        ticketId: exists.ticket_id,
        subsystem: 'sla',
        decision: 'sla_manual_resume',
        actorId,
        actorType: 'user',
        trx,
      },
      async (recorder) => {
        const at = new Date();
        const instance = await loadInstance(tenantId, instanceId, trx, at.getTime());
        if (!instance) throw new SlaNotFoundError(instanceId);

        const changed = await resumeInstance(tenantId, instance, MANUAL_PAUSE_REASON, trx, {
          at,
          actorId,
          note,
        });
        const after = await loadInstance(tenantId, instanceId, trx, at.getTime());

        // A manual resume that leaves the clock paused is not a failure — the
        // ticket is still pending on the requester — but the caller must be
        // told, or the UI will claim a clock is running that is not.
        recorder
          .input({ instanceId, note })
          .outcome({ changed, stillPaused: (after ?? instance).state.activePauses.size > 0 })
          .decide(
            changed
              ? `Manual pause lifted on clock #${instanceId}`
              : `Clock #${instanceId} carried no manual pause`,
          );

        return summariseChange(after ?? instance);
      },
    ),
  );
}

function summariseChange(instance: LoadedInstance): ManualClockChange {
  return {
    instanceId: instance.row.id,
    status: String(instance.row.status),
    running: instance.state.activePauses.size === 0,
    dueAt: instance.state.dueAtMs === null ? iso(instance.row.due_at) : new Date(instance.state.dueAtMs).toISOString(),
    activePauses: [...instance.state.activePauses],
  };
}

export class SlaNotFoundError extends Error {
  readonly status = 404;
  readonly code = 'not_found';
  constructor(instanceId: number) {
    super(`SLA instance ${instanceId} does not exist in this tenant.`);
    this.name = 'SlaNotFoundError';
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13 — Firing one timer
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Advance ONE instance through every timer that has come due, in order, at the
 * instants they were due — not at "now".
 *
 * This loop IS the catch-up. A process that was down for six hours must replay
 * a Friday-evening closing edge, a Monday-morning opening edge and the breach
 * in between, each stamped at its own instant, because a breach recorded at
 * restart time is a breach recorded at the wrong time, and the ledger's whole
 * value is that its timestamps are the real ones.
 */
async function advanceInstance(
  tenantId: number,
  instanceId: number,
  upToMs: number,
  executor: Executor,
  emissions: Emission[],
): Promise<number> {
  let fired = 0;

  for (let step = 0; step < MAX_REPLAY_STEPS; step += 1) {
    const instance = await loadInstance(tenantId, instanceId, executor, upToMs);
    if (!instance) return fired;
    if (instance.row.status !== 'running' && instance.row.status !== 'paused') {
      await armTimer(tenantId, instanceId, null, executor);
      return fired;
    }

    const timerAtMs = ms(instance.row.next_timer_at);
    const kind = instance.row.timer_kind as TimerKind | null;

    if (timerAtMs === null || kind === null) {
      // Never armed (a clock started by ticket.service's engine-less fallback,
      // or a row from before migration 003). Arm it and stop — the next pass
      // fires it if it is already due.
      await rearm(tenantId, instanceId, executor, upToMs);
      const rearmed = await loadInstance(tenantId, instanceId, executor, upToMs);
      const armedAt = ms(rearmed?.row.next_timer_at ?? null);
      if (armedAt === null || armedAt > upToMs) return fired;
      continue;
    }

    if (timerAtMs > upToMs) return fired;

    const at = new Date(timerAtMs);
    const target = instance.target;

    switch (kind) {
      case 'breach': {
        if (await breachInstance(tenantId, instance, executor, at, emissions)) fired += 1;
        break;
      }
      case 'warn': {
        const dueMs = instance.state.dueAtMs ?? ms(instance.row.due_at);
        await scoped('sla_instances', tenantId, executor)
          .where('sla_instances.id', instanceId)
          .update({ warned_at: at });
        if (dueMs !== null) {
          emissions.push({
            kind: 'warning',
            tenantId,
            ticketId: instance.row.ticket_id,
            number: await ticketNumber(tenantId, instance.row.ticket_id, executor),
            instanceId,
            targetSlug: String(instance.row.target_slug),
            dueAt: new Date(dueMs).toISOString(),
            remainingMinutes: Math.max(
              0,
              Math.round(businessMillisBetween(instance.loaded.calendar, at, dueMs) / MINUTE_MS),
            ),
          });
        }
        fired += 1;
        break;
      }
      case 'boundary': {
        // The desk just shut, and this target pauses outside hours.
        if (target?.pauseSources.includes('outside_hours') === true) {
          await pauseInstance(tenantId, instance, 'outside_hours', executor, { at });
          fired += 1;
        }
        break;
      }
      case 'resume': {
        if (instance.state.activePauses.has('outside_hours')) {
          await resumeInstance(tenantId, instance, 'outside_hours', executor, { at });
          fired += 1;
        }
        break;
      }
      default:
        break;
    }

    // Re-arm from the instant the timer fired, not from `now`: the next edge
    // must be found relative to the event we just replayed, or a catch-up jumps
    // straight past every boundary between then and now.
    await rearm(tenantId, instanceId, executor, timerAtMs + 1);

    const after = await loadInstance(tenantId, instanceId, executor, upToMs);
    const nextAtMs = ms(after?.row.next_timer_at ?? null);
    if (nextAtMs === null || nextAtMs > upToMs) return fired;
    if (nextAtMs <= timerAtMs) {
      // The clock is not advancing. Disarm rather than spin — a stuck timer
      // that burns a CPU is a worse outage than a missing warning.
      logger.error(
        { tenantId, instanceId, timerAtMs, nextAtMs },
        'SLA timer did not advance — disarming this instance to avoid a spin',
      );
      await armTimer(tenantId, instanceId, null, executor);
      return fired;
    }
  }

  logger.error({ tenantId, instanceId }, 'SLA catch-up hit the replay cap for one instance');
  return fired;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 14 — The ticker
// ═════════════════════════════════════════════════════════════════════════════

interface WorkerState {
  lastTickAt: string | null;
  lastVerifyAt: string | null;
  lastCatchUpAt: string | null;
}

async function readWorkerState(): Promise<WorkerState> {
  const row = (await db('app_config').where('key', WORKER_STATE_KEY).first('value')) as
    | { value: unknown }
    | undefined;
  const value = parseJsonColumn(row?.value);
  return {
    lastTickAt: typeof value.lastTickAt === 'string' ? value.lastTickAt : null,
    lastVerifyAt: typeof value.lastVerifyAt === 'string' ? value.lastVerifyAt : null,
    lastCatchUpAt: typeof value.lastCatchUpAt === 'string' ? value.lastCatchUpAt : null,
  };
}

async function writeWorkerState(patch: Partial<WorkerState>): Promise<void> {
  const current = await readWorkerState();
  const next = { ...current, ...patch };
  await db('app_config')
    .insert({ key: WORKER_STATE_KEY, value: JSON.stringify(next), updated_at: new Date() })
    .onConflict('key')
    .merge({ value: JSON.stringify(next), updated_at: new Date() });
}

export interface SlaTickResult {
  claimed: number;
  fired: number;
  errors: number;
  durationMs: number;
}

/**
 * The due-timer claim.
 *
 * ── On the bare `db('sla_instances')` here (HARD RULE 1) ─────────────────────
 * This is the same, single, documented exception `outbox.service` takes, for
 * the same reason: the ticker has no tenant context because it serves every
 * tenant, and a scoped variant would mean one ticker per tenant. The query
 * selects `tenant_id` explicitly, and EVERY subsequent read and write in the
 * pass goes through `scoped(..., tenantId)` with that value. No id in this
 * query comes from user input, and nothing here can be reached from a request.
 *
 * It is index-only in the sense that matters: `sla_instances_timer_due`
 * (migration 003) is partial on both `next_timer_at IS NOT NULL` and the live
 * statuses, so an idle desk returns zero rows without touching a ticket.
 */
async function claimDueTimers(upTo: Date, limit: number): Promise<Array<{ id: number; tenant_id: number }>> {
  return (await db('sla_instances')
    .whereNotNull('next_timer_at')
    .where('next_timer_at', '<=', upTo)
    .whereIn('status', ['running', 'paused'])
    .orderBy('next_timer_at', 'asc')
    .limit(limit)
    .select('id', 'tenant_id')) as Array<{ id: number; tenant_id: number }>;
}

/** Live instances that have never been armed — the catch-up's other half. */
async function claimUnarmed(limit: number): Promise<Array<{ id: number; tenant_id: number }>> {
  return (await db('sla_instances')
    .whereNull('next_timer_at')
    .whereIn('status', ['running', 'paused'])
    .orderBy('id', 'asc')
    .limit(limit)
    .select('id', 'tenant_id')) as Array<{ id: number; tenant_id: number }>;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let stopping = false;
let inFlight: Promise<unknown> | null = null;
let lockClient: PgClient | null = null;
let lockHeld = false;
let lockRetry: NodeJS.Timeout | null = null;

/**
 * A session-level advisory lock on its OWN connection.
 *
 * `index.ts` already elects a leader before it starts this worker, and this
 * lock is deliberately taken anyway. The two answer different questions: the
 * boot lock says "this replica runs the workers", and this one says "exactly
 * one SLA ticker exists in this cluster" — which also holds when someone starts
 * the ticker from a script, a test harness or a one-off maintenance process
 * that never went through `index.ts`. Two tickers means every breach is
 * evaluated twice, and HARD RULE 2 makes a duplicated decision row a lie about
 * what happened rather than a harmless retry.
 *
 * It must not be a pooled connection: the lock lives exactly as long as the
 * session holding it, and knex would hand that session to someone else's query
 * and eventually recycle it — releasing the lock while the ticker still thinks
 * it holds it.
 */
async function acquireLock(): Promise<boolean> {
  if (lockHeld) return true;
  try {
    if (!lockClient) {
      lockClient = new PgClient({
        connectionString: config.databaseUrl,
        application_name: 'oblidesk-sla-ticker',
      });
      lockClient.on('error', (error: Error) => {
        logger.warn({ err: error.message }, 'SLA ticker lock connection lost — will re-contest');
        lockHeld = false;
        lockClient = null;
      });
      await lockClient.connect();
    }
    const result = await lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [ADVISORY_LOCK_CLASS, ADVISORY_LOCK_OBJECT],
    );
    lockHeld = result.rows[0]?.locked === true;
    return lockHeld;
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'SLA ticker could not contest the advisory lock');
    lockHeld = false;
    return false;
  }
}

async function releaseLock(): Promise<void> {
  if (lockRetry) {
    clearInterval(lockRetry);
    lockRetry = null;
  }
  if (!lockClient) return;
  try {
    if (lockHeld) {
      await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [
        ADVISORY_LOCK_CLASS,
        ADVISORY_LOCK_OBJECT,
      ]);
    }
    await lockClient.end();
  } catch {
    // Shutting down: closing the connection releases the lock regardless.
  }
  lockClient = null;
  lockHeld = false;
}

/**
 * One pass. Claims the timers that have come due, advances each instance
 * through them, then flushes the socket frames — after the writes, never
 * before, so nothing is announced that the database did not accept.
 */
export async function tick(options: { upTo?: Date; limit?: number } = {}): Promise<SlaTickResult> {
  const startedAt = Date.now();
  const upTo = options.upTo ?? new Date();
  const limit = options.limit ?? TICK_BATCH;
  const result: SlaTickResult = { claimed: 0, fired: 0, errors: 0, durationMs: 0 };
  const emissions: Emission[] = [];

  const due = await claimDueTimers(upTo, limit);
  result.claimed = due.length;

  for (const row of due) {
    if (stopping) break;
    try {
      await db.transaction(async (trx) => {
        result.fired += await advanceInstance(Number(row.tenant_id), Number(row.id), upTo.getTime(), trx, emissions);
      });
    } catch (error) {
      result.errors += 1;
      logger.error(
        { tenantId: row.tenant_id, instanceId: row.id, err: (error as Error).message },
        'SLA timer failed — the instance keeps its armed timer and will be retried',
      );
    }
  }

  flushEmissions(emissions);
  await writeWorkerState({ lastTickAt: upTo.toISOString() });
  result.durationMs = Date.now() - startedAt;
  return result;
}

/**
 * The boot CATCH-UP.
 *
 * Two halves, both necessary:
 *   1. Arm every live clock that has no timer. Clocks created by
 *      `ticket.service`'s engine-less fallback have a NULL `due_at` and no
 *      timer at all; without this they would never be looked at again.
 *   2. Fire everything that came due while the process was down, replayed at
 *      the instants it was actually due (see `advanceInstance`).
 *
 * A restart must not silently forgive a breach. It also must not manufacture
 * one: the `UNIQUE(instance_id, event, at)` index means re-running the catch-up
 * writes nothing new, so an operator can run it as often as they like.
 */
export async function catchUp(upTo: Date = new Date()): Promise<{ armed: number; fired: number; passes: number }> {
  const state = await readWorkerState();
  const since = state.lastTickAt;
  let armed = 0;
  let fired = 0;
  let passes = 0;

  logger.info(
    { since: since ?? 'never', upTo: upTo.toISOString() },
    'SLA catch-up: replaying every timer missed while the ticker was down',
  );

  // ── 1. Arm the unarmed ────────────────────────────────────────────────────
  //
  // `rearm` may legitimately leave `next_timer_at` NULL — a clock with no
  // deadline and no calendar edge has nothing to wait for — so the "unarmed"
  // query would hand back the same rows for ever. Remembering what has been
  // visited is the termination condition; page count alone is not.
  const visited = new Set<number>();
  for (let page = 0; page < 200; page += 1) {
    const rows = await claimUnarmed(TICK_BATCH);
    const fresh = rows.filter((row) => !visited.has(Number(row.id)));
    if (fresh.length === 0) break;

    for (const row of fresh) {
      visited.add(Number(row.id));
      try {
        await db.transaction(async (trx) => {
          await rearm(Number(row.tenant_id), Number(row.id), trx, upTo.getTime());
        });
        armed += 1;
      } catch (error) {
        logger.error(
          { tenantId: row.tenant_id, instanceId: row.id, err: (error as Error).message },
          'SLA catch-up could not arm an instance',
        );
      }
    }
  }

  // ── 2. Fire what came due ─────────────────────────────────────────────────
  for (let page = 0; page < 200; page += 1) {
    if (stopping) break;
    const before = fired;
    const pass = await tick({ upTo, limit: TICK_BATCH });
    fired += pass.fired;
    passes += 1;
    if (pass.claimed === 0) break;
    if (pass.claimed < TICK_BATCH && fired === before) break;
  }

  await writeWorkerState({ lastCatchUpAt: upTo.toISOString(), lastTickAt: upTo.toISOString() });
  logger.info({ armed, fired, passes }, 'SLA catch-up complete');
  return { armed, fired, passes };
}

export interface SlaTickerOptions {
  intervalMs?: number;
}

/**
 * Start the ticker. Matches the `{ start, stop }` shape `index.ts` loads by
 * name — and note that `index.ts` calls `start()` with NO arguments, so the
 * interval must default rather than be required.
 */
export async function start(options: SlaTickerOptions = {}): Promise<void> {
  if (running) return;
  const intervalMs = options.intervalMs ?? config.slaTickIntervalMs;

  if (!(await acquireLock())) {
    logger.info(
      { retryMs: config.leaderRetryIntervalMs },
      'Another process holds the SLA ticker lock — standing by',
    );
    lockRetry = setInterval(() => {
      void acquireLock().then(async (won) => {
        if (!won || running) return;
        if (lockRetry) {
          clearInterval(lockRetry);
          lockRetry = null;
        }
        logger.info('Took over the SLA ticker');
        await beginTicking(intervalMs);
      });
    }, config.leaderRetryIntervalMs);
    lockRetry.unref();
    return;
  }

  await beginTicking(intervalMs);
}

async function beginTicking(intervalMs: number): Promise<void> {
  running = true;
  stopping = false;

  // ── The catch-up runs, but boot does not wait for it ──────────────────────
  // `index.ts` awaits `start()` BEFORE `server.listen()`, so awaiting a
  // catch-up here would hold the login page hostage to however long a desk that
  // has been down for a weekend takes to replay. It is launched instead and
  // parked in `inFlight`, which means: the interval below skips its ticks until
  // the catch-up finishes (so nothing races it), `stop()` still waits for it,
  // and the replay is idempotent anyway thanks to the ledger's unique index.
  //
  // Breaches are therefore still never forgiven — they are simply recorded a
  // few seconds after the desk starts answering, instead of a few seconds
  // before.
  inFlight = catchUp()
    .catch((error: unknown) => {
      logger.error({ err: (error as Error).message }, 'SLA catch-up failed — the ticker continues');
    })
    .finally(() => {
      inFlight = null;
    });

  timer = setInterval(() => {
    if (stopping || inFlight) return;
    inFlight = (async () => {
      try {
        await tick();
        await maybeVerify();
      } catch (error) {
        logger.error({ err: (error as Error).message }, 'SLA tick failed');
      } finally {
        inFlight = null;
      }
    })();
  }, intervalMs);
  timer.unref();

  logger.info({ intervalMs }, 'SLA ticker running — catch-up replaying in the background');
}

/** Stop, letting an in-flight tick finish rather than tearing it in half. */
export async function stop(): Promise<void> {
  stopping = true;
  if (lockRetry) {
    clearInterval(lockRetry);
    lockRetry = null;
  }
  if (timer) {
    clearInterval(timer);
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
  await releaseLock();
  logger.info('SLA ticker stopped');
}

export function isRunning(): boolean {
  return running;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 15 — The nightly verifier
// ═════════════════════════════════════════════════════════════════════════════

export interface DriftFinding {
  tenantId: number;
  instanceId: number;
  ticketId: number;
  targetSlug: string;
  cachedDueAt: string | null;
  expectedDueAt: string | null;
  dueDriftMs: number;
  cachedPausedMs: number;
  expectedPausedMs: number;
  pausedDriftMs: number;
}

export interface VerifyResult {
  checked: number;
  drifted: number;
  findings: DriftFinding[];
}

/**
 * Recompute `due_at` and `paused_ms` from the LEDGER and compare.
 *
 * It does not repair. That is not laziness and it is not a TODO — a verifier
 * that silently rewrote the cache to match its own recomputation would be doing
 * exactly the thing the ledger exists to make unnecessary, and the next time a
 * customer disputed a breach the honest answer would be "the number changed at
 * some point and we do not know when". Drift is a bug in the engine or a sign
 * of a hand-edited row, and both want a human, not a patch.
 *
 * What it does instead, on every disagreement: a `decision_log` entry, an
 * admin alert in `live_alerts`, and a `note` row in the ledger itself so the
 * instance's own history carries the discrepancy.
 */
export async function verify(options: { tenantId?: number; limit?: number } = {}): Promise<VerifyResult> {
  const result: VerifyResult = { checked: 0, drifted: 0, findings: [] };
  const nowMs = Date.now();
  const pageSize = options.limit ?? VERIFY_PAGE;

  const tenants = options.tenantId
    ? [{ id: options.tenantId }]
    : ((await db('tenants').select('id').orderBy('id')) as Array<{ id: number }>);

  for (const tenant of tenants) {
    const tenantId = Number(tenant.id);
    let lastId = 0;

    for (let page = 0; page < 500; page += 1) {
      const rows = (await scoped('sla_instances', tenantId)
        .whereIn('sla_instances.status', ['running', 'paused'])
        .where('sla_instances.id', '>', lastId)
        .orderBy('sla_instances.id', 'asc')
        .limit(pageSize)
        .select(...INSTANCE_COLUMNS)) as SlaInstanceRow[];

      if (rows.length === 0) break;
      lastId = Number(rows[rows.length - 1].id);

      for (const row of rows) {
        result.checked += 1;
        const loaded = await resolveCalendar(tenantId, row.calendar_slug);
        const ledger = await readLedger(tenantId, row.id, db);
        const startedAtMs = ms(row.started_at) ?? nowMs;
        const state = replayLedger(ledger, loaded.calendar, startedAtMs, nowMs);

        const cachedDue = ms(row.due_at);
        const cachedPaused = bigint(row.paused_ms);
        const dueDrift =
          state.dueAtMs === null || cachedDue === null ? 0 : Math.abs(state.dueAtMs - cachedDue);
        const pausedDrift = Math.abs(Math.round(state.pausedMs) - cachedPaused);

        // A clean instance is deliberately NOT stamped. Writing a
        // "verified, no drift" marker onto every live clock every night is one
        // jsonb rewrite per instance per day — table bloat and WAL traffic
        // proportional to the desk's size, bought with information nobody
        // reads. The clean pass is recorded once, in the worker state; the
        // instances that matter are the ones that disagreed.
        if (dueDrift <= DRIFT_TOLERANCE_MS && pausedDrift <= DRIFT_TOLERANCE_MS) continue;

        result.drifted += 1;
        const finding: DriftFinding = {
          tenantId,
          instanceId: row.id,
          ticketId: row.ticket_id,
          targetSlug: String(row.target_slug),
          cachedDueAt: iso(row.due_at),
          expectedDueAt: state.dueAtMs === null ? null : new Date(state.dueAtMs).toISOString(),
          dueDriftMs: dueDrift,
          cachedPausedMs: cachedPaused,
          expectedPausedMs: Math.round(state.pausedMs),
          pausedDriftMs: pausedDrift,
        };
        result.findings.push(finding);

        await reportDrift(finding);
      }
    }
  }

  await writeWorkerState({ lastVerifyAt: new Date(nowMs).toISOString() });
  logger.info({ checked: result.checked, drifted: result.drifted }, 'SLA verifier finished');
  return result;
}

async function reportDrift(finding: DriftFinding): Promise<void> {
  const at = new Date();

  await withDecision(
    {
      tenantId: finding.tenantId,
      ticketId: finding.ticketId,
      subsystem: 'sla',
      decision: 'sla_drift_detected',
      actorType: 'system',
    },
    async (recorder) => {
      recorder
        .input({
          instanceId: finding.instanceId,
          targetSlug: finding.targetSlug,
          cachedDueAt: finding.cachedDueAt,
          expectedDueAt: finding.expectedDueAt,
          cachedPausedMs: finding.cachedPausedMs,
          expectedPausedMs: finding.expectedPausedMs,
        })
        .outcome({
          dueDriftMs: finding.dueDriftMs,
          pausedDriftMs: finding.pausedDriftMs,
          repaired: false,
        })
        .decide(
          `SLA clock #${finding.instanceId} disagrees with its ledger by ` +
            `${Math.round(finding.dueDriftMs / 1000)}s on due_at and ` +
            `${Math.round(finding.pausedDriftMs / 1000)}s on paused_ms — reported, NOT repaired`,
        );
    },
  ).catch((error: unknown) => {
    logger.error({ err: (error as Error).message }, 'Could not record SLA drift in decision_log');
  });

  try {
    await appendLedger(
      {
        tenantId: finding.tenantId,
        instanceId: finding.instanceId,
        event: 'note',
        at,
        reasonCode: 'verifier_drift',
        elapsedBusinessMsBefore: 0,
        note:
          `Nightly verifier: cached due_at ${finding.cachedDueAt ?? 'null'} vs replayed ` +
          `${finding.expectedDueAt ?? 'null'} (${finding.dueDriftMs}ms); paused_ms ` +
          `${finding.cachedPausedMs} vs ${finding.expectedPausedMs} (${finding.pausedDriftMs}ms). ` +
          'Recorded, not repaired.',
      },
      db,
    );
  } catch (error) {
    logger.error({ err: (error as Error).message }, 'Could not annotate the SLA ledger with drift');
  }

  // Stamped on the instance so the ticket's own drawer can show "this clock is
  // under review" — the record of the disagreement, never a correction of it.
  try {
    await patchResolvedVia(
      finding.tenantId,
      finding.instanceId,
      {
        verification: {
          at: at.toISOString(),
          ok: false,
          repaired: false,
          dueDriftMs: finding.dueDriftMs,
          pausedDriftMs: finding.pausedDriftMs,
          expectedDueAt: finding.expectedDueAt,
          expectedPausedMs: finding.expectedPausedMs,
        },
      },
      db,
    );
  } catch (error) {
    logger.error({ err: (error as Error).message }, 'Could not stamp SLA drift on the instance');
  }

  try {
    const stableKey = `sla_drift:${finding.instanceId}`;
    const existing = (await scoped('live_alerts', finding.tenantId)
      .where('live_alerts.stable_key', stableKey)
      .whereNull('live_alerts.read_at')
      .first('id')) as { id: number } | undefined;

    const payload = {
      severity: 'warning',
      title: 'Ecart SLA detecte',
      message:
        `Le compteur SLA #${finding.instanceId} (cible ${finding.targetSlug}) ne correspond plus a son registre. ` +
        `Ecart d echeance : ${Math.round(finding.dueDriftMs / 1000)} s. Aucune correction automatique n a ete appliquee.`,
      navigate_to: `/tickets/${finding.ticketId}`,
      stable_key: stableKey,
    };

    if (existing) {
      await scoped('live_alerts', finding.tenantId)
        .where('live_alerts.id', existing.id)
        .update({ ...payload, created_at: at });
    } else {
      await insertScoped('live_alerts', finding.tenantId, payload);
    }
  } catch (error) {
    logger.error({ err: (error as Error).message }, 'Could not raise the SLA drift admin alert');
  }
}

/** Run the verifier once a day, shortly after `VERIFY_HOUR` on the server clock. */
async function maybeVerify(): Promise<void> {
  const state = await readWorkerState();
  const now = new Date();
  const lastMs = state.lastVerifyAt ? Date.parse(state.lastVerifyAt) : 0;
  const sinceLast = now.getTime() - (Number.isFinite(lastMs) ? lastMs : 0);

  const inWindow = now.getHours() === VERIFY_HOUR;
  const overdue = sinceLast > 26 * 3_600_000; // a missed night is still verified

  if (!inWindow && !overdue) return;
  if (sinceLast < 20 * 3_600_000) return;

  await verify();
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 16 — Read models for the API
// ═════════════════════════════════════════════════════════════════════════════

export interface SlaPolicySummary {
  slug: string;
  name: string;
  version: number;
  enabled: boolean;
  precedence: number;
  calendarSlug: string;
  bindings: { organizations: string[]; queues: string[]; recordTypes: string[] };
  /** The level this policy would be evaluated at. */
  level: ResolutionLevel;
  targets: Array<{
    slug: string;
    label: string;
    labelKey: string | null;
    calendarSlug: string;
    calendarIs24x7: boolean;
    /** Which calendar supplies the office-hours edges, when `outside_hours` is on. */
    pauseCalendarSlug: string | null;
    durationsByPriority: Record<string, number>;
    pauseOn: string[];
    warnAtPercent: number[];
    onTargetSwitch: TargetSwitchMode;
    stopKind: StopKind;
    escalationSlug: string | null;
    issues: TargetValidationIssue[];
  }>;
  problems: string[];
}

export async function listPolicies(
  tenantId: number,
  executor: Executor = db,
): Promise<SlaPolicySummary[]> {
  const policies = await loadPolicies(tenantId, executor);
  const out: SlaPolicySummary[] = [];

  for (const policy of policies) {
    const targets: SlaPolicySummary['targets'] = [];
    const tenantDefaultCalendar = await defaultCalendarSlug(tenantId, executor);

    for (const target of policy.targets) {
      const loaded = await resolveCalendar(tenantId, target.calendarSlug, executor);
      const officeHours = target.pauseSources.includes('outside_hours')
        ? await resolveCalendar(tenantId, target.pauseCalendarSlug ?? tenantDefaultCalendar, executor)
        : null;

      targets.push({
        slug: target.slug,
        label: target.label,
        labelKey: target.labelKey,
        calendarSlug: loaded.slug,
        calendarIs24x7: loaded.is24x7,
        pauseCalendarSlug: officeHours?.slug ?? null,
        durationsByPriority: target.budgetsByPriority,
        pauseOn: [...target.pauseCategories, ...target.pauseSources],
        warnAtPercent: target.warnPercents,
        onTargetSwitch: target.switchMode,
        stopKind: target.stopKind,
        escalationSlug: target.escalationSlug,
        issues: validateTarget(target, loaded.is24x7, undefined, officeHours?.is24x7),
      });
    }

    out.push({
      slug: policy.slug,
      name: policy.name,
      version: policy.version,
      enabled: policy.enabled,
      precedence: policy.precedence,
      calendarSlug: policy.calendarSlug,
      bindings: {
        organizations: policy.organizationSlugs,
        queues: policy.queueSlugs,
        recordTypes: policy.recordTypes,
      },
      level:
        policy.organizationSlugs.length > 0
          ? 'organisation'
          : policy.queueSlugs.length > 0
            ? 'queue'
            : policy.recordTypes.length > 0
              ? 'record_type'
              : 'global',
      targets,
      problems: policy.problems,
    });
  }

  return out.sort((a, b) => b.precedence - a.precedence || a.slug.localeCompare(b.slug));
}

export interface SlaInstanceView {
  id: number;
  ticketId: number;
  targetSlug: string;
  targetLabel: string;
  policySlug: string;
  policyVersion: number;
  calendarSlug: string;
  status: string;
  running: boolean;
  startedAt: string;
  dueAt: string | null;
  breachedAt: string | null;
  metAt: string | null;
  warnedAt: string | null;
  pausedMs: number;
  elapsedMs: number;
  budgetMs: number | null;
  remainingMinutes: number | null;
  elapsedPercent: number | null;
  activePauses: string[];
  nextTimerAt: string | null;
  nextTimerKind: string | null;
  /** The whole evaluated policy list — winner AND losers. */
  resolution: unknown;
}

function toInstanceView(instance: LoadedInstance): SlaInstanceView {
  const dueMs = instance.state.dueAtMs ?? ms(instance.row.due_at);
  const budget = instance.state.budgetMs;
  const resolvedVia = parseJsonColumn(instance.row.resolved_via);

  return {
    id: instance.row.id,
    ticketId: instance.row.ticket_id,
    targetSlug: String(instance.row.target_slug),
    targetLabel: instance.target?.label ?? String(instance.row.target_slug),
    policySlug: String(instance.row.policy_slug),
    policyVersion: Number(instance.row.policy_version),
    calendarSlug: String(instance.row.calendar_slug),
    status: String(instance.row.status),
    running: instance.state.activePauses.size === 0 && instance.row.status === 'running',
    startedAt: iso(instance.row.started_at) ?? new Date().toISOString(),
    dueAt: dueMs === null ? null : new Date(dueMs).toISOString(),
    breachedAt: iso(instance.row.breached_at),
    metAt: iso(instance.row.met_at),
    warnedAt: iso(instance.row.warned_at),
    pausedMs: Math.round(instance.state.pausedMs),
    elapsedMs: Math.round(instance.state.elapsedMs),
    budgetMs: budget === null ? null : Math.round(budget),
    remainingMinutes:
      dueMs === null
        ? null
        : Math.round(businessMillisBetween(instance.loaded.calendar, instance.state.atMs, dueMs) / MINUTE_MS) *
          (dueMs < instance.state.atMs ? -1 : 1),
    elapsedPercent:
      budget === null || budget <= 0 ? null : Math.round((instance.state.elapsedMs / budget) * 100),
    activePauses: [...instance.state.activePauses],
    nextTimerAt: iso(instance.row.next_timer_at),
    nextTimerKind: instance.row.timer_kind,
    resolution: resolvedVia.resolution ?? null,
  };
}

export async function instancesForTicket(
  tenantId: number,
  ticketId: number,
  executor: Executor = db,
): Promise<SlaInstanceView[]> {
  const rows = (await scoped('sla_instances', tenantId, executor)
    .where('sla_instances.ticket_id', ticketId)
    .orderBy('sla_instances.id', 'asc')
    .select(...INSTANCE_COLUMNS)) as SlaInstanceRow[];

  const out: SlaInstanceView[] = [];
  const nowMs = Date.now();
  for (const row of rows) {
    const instance = await loadInstance(tenantId, row.id, executor, nowMs);
    if (instance) out.push(toInstanceView(instance));
  }
  return out;
}

export async function instanceById(
  tenantId: number,
  instanceId: number,
  executor: Executor = db,
): Promise<SlaInstanceView | null> {
  const instance = await loadInstance(tenantId, instanceId, executor);
  return instance ? toInstanceView(instance) : null;
}

/** One band of the customer-showable strip. */
export interface ExplainerBand {
  from: string;
  to: string;
  ms: number;
  /** `worked` counts against the target; the other two do not. */
  kind: 'worked' | 'paused' | 'out_of_hours';
  /** Present for `paused` — the pause reason(s) in force. */
  reasons: string[];
  /** i18n key + French fallback, per HARD RULE 10. */
  labelKey: string;
  labelFr: string;
}

export interface SlaExplainer {
  instance: SlaInstanceView;
  ledger: Array<{
    id: number;
    at: string;
    event: string;
    reasonCode: string | null;
    actorId: number | null;
    elapsedBusinessMsBefore: number;
    newDueAt: string | null;
    note: string | null;
  }>;
  bands: ExplainerBand[];
  totals: { workedMs: number; pausedMs: number; outOfHoursMs: number };
  calendar: { slug: string; name: string; timezone: string; is24x7: boolean };
}

const BAND_LABELS: Record<ExplainerBand['kind'], { key: string; fr: string }> = {
  worked: { key: 'sla.band.worked', fr: 'Temps decompte' },
  paused: { key: 'sla.band.paused', fr: 'En pause' },
  out_of_hours: { key: 'sla.band.outOfHours', fr: 'Hors horaires' },
};

/**
 * THE explainer — the thing you put in front of a customer.
 *
 * The strip is built by walking the ledger's pause/resume edges and, inside
 * every running span, splitting on the CALENDAR's own open/shut edges. That
 * three-way split — worked, paused, out of hours — is the entire argument:
 * "you were not charged for the weekend, and here is the weekend."
 *
 * Every band is derived from the ledger and the calendar, never from
 * `paused_ms`. If the cache and the ledger disagree, this drawing shows the
 * ledger, which is the one that is true.
 */
export async function explainInstance(
  tenantId: number,
  instanceId: number,
  executor: Executor = db,
): Promise<SlaExplainer | null> {
  const nowMs = Date.now();
  const instance = await loadInstance(tenantId, instanceId, executor, nowMs);
  if (!instance) return null;

  const startedAtMs = ms(instance.row.started_at) ?? nowMs;
  const endMs = (() => {
    const met = ms(instance.row.met_at);
    if (met !== null) return met;
    if (instance.row.status === 'cancelled') {
      for (let i = instance.ledger.length - 1; i >= 0; i -= 1) {
        if (instance.ledger[i].event === 'cancel') return ms(instance.ledger[i].at) ?? nowMs;
      }
    }
    return nowMs;
  })();

  // ── Pass 1: the pause/resume edges from the ledger ─────────────────────────
  interface Span {
    fromMs: number;
    toMs: number;
    paused: string[];
  }
  const spans: Span[] = [];
  let cursor = startedAtMs;
  const active = new Set<string>();

  for (const row of instance.ledger) {
    const atMs = ms(row.at);
    if (atMs === null || atMs > endMs) break;
    if (row.event !== 'pause' && row.event !== 'resume') continue;
    if (atMs > cursor) spans.push({ fromMs: cursor, toMs: atMs, paused: [...active] });
    if (row.event === 'pause') active.add(row.reason_code ?? 'unspecified');
    else if (row.reason_code === null || row.reason_code === 'all') active.clear();
    else active.delete(row.reason_code);
    cursor = atMs;
  }
  if (cursor < endMs) spans.push({ fromMs: cursor, toMs: endMs, paused: [...active] });

  // ── Pass 2: split each running span on the calendar's edges ────────────────
  //
  // The band cap is on the WHOLE strip, not per span: a six-week-old ticket
  // with a dozen pause periods would otherwise produce a thousand rectangles,
  // of which the reader can distinguish perhaps forty. The totals below are
  // still summed over every span, so a truncated drawing never has misleading
  // numbers underneath it.
  const MAX_TOTAL_BANDS = 240;
  const bands: ExplainerBand[] = [];
  const totals = { workedMs: 0, pausedMs: 0, outOfHoursMs: 0 };

  for (const span of spans) {
    if (span.toMs <= span.fromMs) continue;

    if (span.paused.length > 0) {
      totals.pausedMs += span.toMs - span.fromMs;
      if (bands.length < MAX_TOTAL_BANDS) {
        bands.push({
          from: new Date(span.fromMs).toISOString(),
          to: new Date(span.toMs).toISOString(),
          ms: span.toMs - span.fromMs,
          kind: 'paused',
          reasons: span.paused,
          labelKey: BAND_LABELS.paused.key,
          labelFr: BAND_LABELS.paused.fr,
        });
      }
      continue;
    }

    for (const slice of calendarBands(instance.loaded.calendar, span.fromMs, span.toMs)) {
      const kind: ExplainerBand['kind'] = slice.open ? 'worked' : 'out_of_hours';
      const width = slice.toMs - slice.fromMs;
      if (width <= 0) continue;
      if (slice.open) totals.workedMs += width;
      else totals.outOfHoursMs += width;
      if (bands.length >= MAX_TOTAL_BANDS) continue;
      bands.push({
        from: new Date(slice.fromMs).toISOString(),
        to: new Date(slice.toMs).toISOString(),
        ms: width,
        kind,
        reasons: [],
        labelKey: BAND_LABELS[kind].key,
        labelFr: BAND_LABELS[kind].fr,
      });
    }
  }

  return {
    instance: toInstanceView(instance),
    ledger: instance.ledger.map((row) => ({
      id: row.id,
      at: iso(row.at) ?? new Date().toISOString(),
      event: String(row.event),
      reasonCode: row.reason_code,
      actorId: row.actor_id,
      elapsedBusinessMsBefore: bigint(row.elapsed_business_ms_before),
      newDueAt: iso(row.new_due_at),
      note: row.note,
    })),
    bands,
    totals,
    calendar: {
      slug: instance.loaded.slug,
      name: instance.loaded.name,
      timezone: instance.loaded.timezone,
      is24x7: instance.loaded.is24x7,
    },
  };
}

export interface AtRiskRow {
  instanceId: number;
  ticketId: number;
  ticketNumber: string;
  subject: string;
  statusSlug: string;
  statusCategory: string;
  prioritySlug: string;
  queueSlug: string;
  assigneeId: number | null;
  assignmentGroupId: number | null;
  targetSlug: string;
  policySlug: string;
  dueAt: string | null;
  status: string;
  running: boolean;
  minutesRemaining: number | null;
  breached: boolean;
}

/**
 * The Shift Board's "who is about to be late" query.
 *
 * Ordered by `due_at` and served straight off `sla_instances_at_risk` — it does
 * NOT replay a ledger per row, because this is a board that refreshes every few
 * seconds for every agent on shift and the cache is exactly what a cache is for.
 * The explainer is where the ledger gets read.
 */
export async function atRisk(
  tenantId: number,
  options: { withinMinutes?: number; includeBreached?: boolean; limit?: number; queueSlug?: string; assigneeId?: number } = {},
  executor: Executor = db,
): Promise<AtRiskRow[]> {
  const withinMinutes = options.withinMinutes ?? 120;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const now = Date.now();
  const horizon = new Date(now + withinMinutes * MINUTE_MS);

  const query = scoped('sla_instances', tenantId, executor)
    .join('tickets', 'tickets.id', 'sla_instances.ticket_id')
    .where('tickets.tenant_id', tenantId)
    .whereNull('tickets.deleted_at')
    .whereIn('sla_instances.status', options.includeBreached === false ? ['running', 'paused'] : ['running', 'paused', 'breached'])
    .whereNotNull('sla_instances.due_at')
    .where('sla_instances.due_at', '<=', horizon)
    .orderBy('sla_instances.due_at', 'asc')
    .limit(limit)
    .select(
      'sla_instances.id as instance_id',
      'sla_instances.ticket_id',
      'sla_instances.target_slug',
      'sla_instances.policy_slug',
      'sla_instances.due_at',
      'sla_instances.status',
      'sla_instances.running',
      'sla_instances.breached_at',
      'tickets.number',
      'tickets.subject',
      'tickets.status_slug',
      'tickets.status_category',
      'tickets.priority_slug',
      'tickets.queue_slug',
      'tickets.assignee_id',
      'tickets.assignment_group_id',
    );

  if (options.queueSlug) void query.where('tickets.queue_slug', options.queueSlug);
  if (options.assigneeId !== undefined) void query.where('tickets.assignee_id', options.assigneeId);

  const rows = (await query) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const dueMs = ms(row.due_at as Date | string | null);
    return {
      instanceId: Number(row.instance_id),
      ticketId: Number(row.ticket_id),
      ticketNumber: String(row.number),
      subject: String(row.subject),
      statusSlug: String(row.status_slug),
      statusCategory: String(row.status_category),
      prioritySlug: String(row.priority_slug),
      queueSlug: String(row.queue_slug),
      assigneeId: row.assignee_id === null ? null : Number(row.assignee_id),
      assignmentGroupId: row.assignment_group_id === null ? null : Number(row.assignment_group_id),
      targetSlug: String(row.target_slug),
      policySlug: String(row.policy_slug),
      dueAt: dueMs === null ? null : new Date(dueMs).toISOString(),
      status: String(row.status),
      running: row.running === true,
      // Wall-clock minutes, deliberately: this board answers "how long have I
      // got", and an agent looking at it at 17:55 needs the honest five
      // minutes, not the four business hours the calendar would report.
      minutesRemaining: dueMs === null ? null : Math.round((dueMs - now) / MINUTE_MS),
      breached: row.breached_at !== null,
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 17 — Registration and the worker barrel
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Self-registration.
 *
 * `ticket.service` declares `SlaEngineHook` with no-op defaults and exposes
 * `registerSlaEngine()` precisely so this file can plug itself in without
 * anyone editing `index.ts` or `ticket.service.ts`. Doing it at module scope
 * means the engine is live the instant something imports this module —
 * `index.ts`'s `loadWorker('./services/sla.service', …)` at boot, or
 * `sla.routes.ts` when the API is mounted, whichever happens first.
 *
 * The import direction is one-way (sla → ticket), so there is no cycle.
 */
registerSlaEngine({
  onTicketCreated,
  onCategoryChanged,
  startTarget,
  cancelForTicket,
});

/**
 * The worker `index.ts` loads by name. It probes `slaTicker`, `slaEngine` and
 * `slaService` in that order and calls `start()` with NO arguments, which is
 * why `start`'s options are optional and the interval falls back to
 * `config.slaTickIntervalMs`.
 */
export const slaTicker = {
  start,
  stop,
  isRunning,
  tick,
  catchUp,
  verify,
};

export const slaService = {
  // lifecycle hooks
  onTicketCreated,
  onCategoryChanged,
  onPriorityChanged,
  onRecordTypeChanged,
  onFirstResponse,
  onCiStateChanged,
  startTarget,
  cancelForTicket,
  // manual control
  pauseManually,
  resumeManually,
  // read models
  listPolicies,
  instancesForTicket,
  instanceById,
  explainInstance,
  atRisk,
  resolvePolicy,
  // engine internals worth exposing to the validators and tests
  parseSlaPolicy,
  validateTarget,
  replayLedger,
  startInstancesForTicket,
  // worker
  start,
  stop,
  isRunning,
  tick,
  catchUp,
  verify,
};

export default slaService;
