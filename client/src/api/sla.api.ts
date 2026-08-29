/**
 * sla.api.ts — `/api/sla`, plus policy and calendar authoring.
 *
 * ── The read side is the engine's own arithmetic, shown ─────────────────────
 * Nothing in this module computes a clock. `instances()` returns what the
 * engine cached; `ledger()` returns the LEDGER REPLAY — the three-way strip of
 * worked / paused / out-of-hours bands the server derives by walking the
 * ledger's pause and resume edges and splitting every running span on the
 * calendar's own open and shut edges.
 *
 * That distinction is the whole point of the explainer. If the cache and the
 * ledger ever disagree, `/instances/:id/ledger` shows the LEDGER, and so does
 * the screen built on it. A client that re-derived the bands from `pausedMs`
 * would be showing a third number in an argument that already has two.
 *
 * ── Manual pause costs SLA_ADMIN, and that is deliberate ────────────────────
 * Everything an agent does to an SLA — resolving, replying, moving to pending —
 * pauses or stops clocks as a SIDE EFFECT of work. Reaching in and stopping the
 * clock without doing the work is a different act: it can turn a breach into a
 * met target, and it is the one thing here a customer might later dispute. The
 * server gates it on `SLA_ADMIN`; the UI hides the control accordingly rather
 * than offering a button that answers 403.
 *
 * ── Authoring goes through the config store ─────────────────────────────────
 * A policy is a `config_objects` row of kind `sla`; a calendar is one of kind
 * `calendar` whose body IS the pure `BusinessCalendar` the engine consumes. So
 * saving either one is `configApi.create/update` + `publish`, which buys the
 * version history, the checksum, the linter and the export bundle for free.
 * The linter's refusal of a business-calendar target that also pauses on
 * `outside_hours` arrives as a 422 with `issues[]` — an answer, not an outage.
 */

import apiClient, { toApiError, toQuery, unwrap, type Envelope } from './client';
import { configApi } from './config.api';
import type {
  BusinessCalendar,
  CalendarShift,
  ConditionNode,
  SlaBody,
  StatusCategory,
} from '@oblidesk/shared';

// ═════════════════════════════════════════════════════════════════════════════
// Vocabulary the engine owns
// ═════════════════════════════════════════════════════════════════════════════

/** Non-status pause reasons — `SOURCE_PAUSE_REASONS` in sla.service.ts. */
export const SOURCE_PAUSE_REASONS = ['maintenance_window', 'device_offline', 'outside_hours'] as const;
export type SourcePauseReason = (typeof SOURCE_PAUSE_REASONS)[number];

export const PAUSE_REASON_LABELS: Readonly<Record<string, { key: string; fr: string }>> = {
  maintenance_window: { key: 'sla.pause.maintenance', fr: 'Fenêtre de maintenance' },
  device_offline: { key: 'sla.pause.deviceOffline', fr: 'Équipement hors ligne' },
  outside_hours: { key: 'sla.pause.outsideHours', fr: 'Hors horaires d’ouverture' },
  manual: { key: 'sla.pause.manual', fr: 'Pause manuelle' },
  pending_requester: { key: 'sla.pause.pendingRequester', fr: 'Attente client' },
  pending_third_party: { key: 'sla.pause.pendingThirdParty', fr: 'Attente d’un tiers' },
  scheduled: { key: 'sla.pause.scheduled', fr: 'Planifié' },
};

/** How a mid-flight priority change is handled — `TargetSwitchMode`. */
export const TARGET_SWITCH_MODES = ['keep_elapsed', 'restart', 'recompute_from_start'] as const;
export type TargetSwitchMode = (typeof TARGET_SWITCH_MODES)[number];

export const TARGET_SWITCH_LABELS: Readonly<Record<TargetSwitchMode, { key: string; fr: string; help: string }>> = {
  keep_elapsed: {
    key: 'sla.switch.keepElapsed',
    fr: 'Conserver le temps écoulé',
    help: 'Le temps déjà consommé reste consommé ; seule la cible change.',
  },
  restart: {
    key: 'sla.switch.restart',
    fr: 'Repartir de zéro',
    help: 'L’horloge redémarre à l’instant du changement de priorité.',
  },
  recompute_from_start: {
    key: 'sla.switch.recompute',
    fr: 'Recalculer depuis le départ',
    help: 'L’échéance est recalculée comme si la nouvelle priorité s’appliquait depuis le début.',
  },
};

export type StopKind = 'first_response' | 'category' | 'condition' | 'manual';

export const STOP_KIND_LABELS: Readonly<Record<StopKind, { key: string; fr: string }>> = {
  first_response: { key: 'sla.stop.firstResponse', fr: 'À la première réponse publique' },
  category: { key: 'sla.stop.category', fr: 'À l’entrée dans une catégorie de statut' },
  condition: { key: 'sla.stop.condition', fr: 'Quand la condition d’arrêt devient vraie' },
  manual: { key: 'sla.stop.manual', fr: 'Manuellement' },
};

export type ResolutionLevel = 'contract' | 'organisation' | 'queue' | 'record_type' | 'global';

// ═════════════════════════════════════════════════════════════════════════════
// Wire shapes (server: sla.routes.ts / sla.service.ts read models)
// ═════════════════════════════════════════════════════════════════════════════

/** A runtime validation finding on one target, already localised. */
export interface TargetIssue {
  targetSlug: string;
  code:
    | 'outside_hours_on_business_calendar'
    | 'outside_hours_without_office_hours'
    | 'no_duration_for_priority'
    | 'unparseable';
  severity: 'error' | 'warning';
  messageKey: string;
  /** French copy — the `t()` fallback. */
  message: string;
  messageEn: string;
}

export interface PolicyTargetSummary {
  slug: string;
  label: string;
  labelKey: string | null;
  calendarSlug: string;
  calendarIs24x7: boolean;
  /** Which calendar supplies the office-hours edges when `outside_hours` is on. */
  pauseCalendarSlug: string | null;
  /** prioritySlug → business minutes. */
  durationsByPriority: Record<string, number>;
  /** Status categories AND source reasons, in one list, as the engine reads it. */
  pauseOn: string[];
  warnAtPercent: number[];
  onTargetSwitch: TargetSwitchMode;
  stopKind: StopKind;
  escalationSlug: string | null;
  issues: TargetIssue[];
}

export interface SlaPolicySummary {
  slug: string;
  name: string;
  version: number;
  enabled: boolean;
  precedence: number;
  calendarSlug: string;
  bindings: { organizations: string[]; queues: string[]; recordTypes: string[] };
  /** The level this policy competes at when several match. */
  level: ResolutionLevel;
  targets: PolicyTargetSummary[];
  /** Anything the parser could not make sense of. Surfaced, never guessed. */
  problems: string[];
}

export interface CalendarSummary {
  slug: string;
  name: string;
  timezone: string;
  isDefault: boolean;
  is24x7: boolean;
  source: 'config_object' | 'projection' | 'fallback';
  version: number;
  weeklyMinutes: number;
  weeklyHours: number;
  holidayCount: number;
  shifts: CalendarShift[];
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

export interface InstancesForTicket {
  ticketId: number;
  instances: SlaInstanceView[];
  /** The one the header counts down. Chosen server-side so screens agree. */
  nearest: SlaInstanceView | null;
}

/** One coloured band of the customer-showable strip. */
export interface ExplainerBand {
  from: string;
  to: string;
  ms: number;
  /** `worked` counts against the target; the other two do not. */
  kind: 'worked' | 'paused' | 'out_of_hours';
  /** Present for `paused` — the reason(s) in force. */
  reasons: string[];
  labelKey: string;
  labelFr: string;
}

export interface LedgerRow {
  id: number;
  at: string;
  event: string;
  reasonCode: string | null;
  actorId: number | null;
  elapsedBusinessMsBefore: number;
  newDueAt: string | null;
  note: string | null;
}

export interface SlaExplainer {
  instance: SlaInstanceView;
  ledger: LedgerRow[];
  bands: ExplainerBand[];
  totals: { workedMs: number; pausedMs: number; outOfHoursMs: number };
  calendar: { slug: string; name: string; timezone: string; is24x7: boolean };
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
  /** Wall-clock, not business time — an agent at 17:55 needs the honest five. */
  minutesRemaining: number | null;
  breached: boolean;
}

export interface ManualClockChange {
  instanceId: number;
  status: string;
  running: boolean;
  dueAt: string | null;
  /** Non-empty after a resume means something ELSE is still holding the clock. */
  activePauses: string[];
}

// ═════════════════════════════════════════════════════════════════════════════
// The policy draft — what SlaPolicyEditor edits
// ═════════════════════════════════════════════════════════════════════════════

export interface TargetDraft {
  /** Local identity so React keys survive a reorder. Not persisted. */
  uid: string;
  slug: string;
  label: string;
  /** Empty = inherit the policy calendar. */
  calendarSlug: string;
  /** Office-hours edges for an `outside_hours` pause. Empty = tenant default. */
  pauseCalendarSlug: string;
  durationsByPriority: Record<string, number>;
  pauseOnCategories: StatusCategory[];
  pauseSources: SourcePauseReason[];
  warnAtPercent: number[];
  onTargetSwitch: TargetSwitchMode;
  stopKind: StopKind;
  stopCategory: StatusCategory | null;
  stopWhen: ConditionNode | null;
  appliesWhen: ConditionNode | null;
  escalationSlug: string;
}

export interface PolicyDraft {
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  calendarSlug: string;
  precedence: number;
  appliesWhen: ConditionNode | null;
  organizations: string[];
  queues: string[];
  recordTypes: string[];
  /** `false` freezes the original target across a priority change. */
  reevaluateOnPriorityChange: boolean;
  targets: TargetDraft[];
}

let uidCounter = 0;
export function newTargetUid(): string {
  uidCounter += 1;
  return `t${uidCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyTarget(slug = ''): TargetDraft {
  return {
    uid: newTargetUid(),
    slug,
    label: '',
    calendarSlug: '',
    pauseCalendarSlug: '',
    durationsByPriority: {},
    // The shipped default: the engine pauses on the categories for which
    // `pausesSla()` is true. Spelling them out here means the editor shows what
    // is actually in force rather than an empty list that means "something".
    pauseOnCategories: ['pending_requester', 'pending_third_party', 'scheduled'],
    pauseSources: [],
    warnAtPercent: [75],
    onTargetSwitch: 'recompute_from_start',
    stopKind: slug.includes('response') ? 'first_response' : 'category',
    stopCategory: slug.includes('response') ? null : 'resolved',
    stopWhen: null,
    appliesWhen: null,
    escalationSlug: '',
  };
}

export function emptyPolicyDraft(): PolicyDraft {
  return {
    slug: '',
    name: '',
    description: '',
    enabled: true,
    calendarSlug: 'business',
    precedence: 100,
    appliesWhen: null,
    organizations: [],
    queues: [],
    recordTypes: [],
    reevaluateOnPriorityChange: true,
    targets: [emptyTarget('first_response')],
  };
}

const STATUS_CATEGORY_SET = new Set<string>([
  'new',
  'open',
  'pending_requester',
  'pending_third_party',
  'scheduled',
  'resolved',
  'closed',
  'cancelled',
]);

function splitPauseOn(pauseOn: readonly string[]): {
  categories: StatusCategory[];
  sources: SourcePauseReason[];
} {
  const categories: StatusCategory[] = [];
  const sources: SourcePauseReason[] = [];
  for (const entry of pauseOn) {
    if (STATUS_CATEGORY_SET.has(entry)) categories.push(entry as StatusCategory);
    else if ((SOURCE_PAUSE_REASONS as readonly string[]).includes(entry)) {
      sources.push(entry as SourcePauseReason);
    }
  }
  return { categories, sources };
}

/**
 * Build the editor's draft from the ENGINE's parsed view of the policy, not
 * from the raw body.
 *
 * `listPolicies()` already folded both dialects, expanded the calendar, split
 * the mixed `pause_on` list and attached the validation findings. Re-parsing the
 * body in the browser would be a second parser, and the day the two disagree is
 * the day an admin edits a policy that does not do what the screen said.
 *
 * The two things the read model does NOT carry — `appliesWhen` and per-target
 * conditions — come from the stored body, which is why `load()` fetches both.
 */
export function draftFromPolicy(
  policy: SlaPolicySummary,
  body: Record<string, unknown> | null,
  description = '',
): PolicyDraft {
  const rawTargets = Array.isArray(body?.targets) ? (body?.targets as Array<Record<string, unknown>>) : [];
  const rawBySlug = new Map<string, Record<string, unknown>>();
  for (const entry of rawTargets) {
    if (entry && typeof entry.slug === 'string') rawBySlug.set(entry.slug, entry);
  }

  return {
    slug: policy.slug,
    name: policy.name,
    description,
    enabled: policy.enabled,
    calendarSlug: policy.calendarSlug,
    precedence: policy.precedence,
    appliesWhen: (body?.appliesWhen ?? body?.applies_when ?? null) as ConditionNode | null,
    organizations: [...policy.bindings.organizations],
    queues: [...policy.bindings.queues],
    recordTypes: [...policy.bindings.recordTypes],
    reevaluateOnPriorityChange: body?.reevaluateOnPriorityChange !== false,
    targets: policy.targets.map((target) => {
      const raw = rawBySlug.get(target.slug) ?? {};
      const { categories, sources } = splitPauseOn(target.pauseOn);
      return {
        uid: newTargetUid(),
        slug: target.slug,
        label: target.label,
        calendarSlug: target.calendarSlug === policy.calendarSlug ? '' : target.calendarSlug,
        pauseCalendarSlug: target.pauseCalendarSlug ?? '',
        durationsByPriority: { ...target.durationsByPriority },
        pauseOnCategories: categories,
        pauseSources: sources,
        warnAtPercent: [...target.warnAtPercent],
        onTargetSwitch: target.onTargetSwitch,
        stopKind: target.stopKind,
        stopCategory:
          target.stopKind === 'category'
            ? ((raw.stop as { category?: string } | undefined)?.category as StatusCategory | undefined) ?? 'resolved'
            : null,
        stopWhen: (raw.stopWhen ?? raw.stop_when ?? null) as ConditionNode | null,
        appliesWhen: (raw.appliesWhen ?? raw.applies_when ?? null) as ConditionNode | null,
        escalationSlug: target.escalationSlug ?? '',
      };
    }),
  };
}

/**
 * The draft in the one dialect `parseSlaPolicy()` reads.
 *
 * `pauseOnCategories` and `pauseOn` are written as SEPARATE keys even though
 * the engine accepts them mixed in one array: the parser splits a mixed list by
 * membership, and a target that names only source reasons in `pause_on` would
 * silently inherit the DEFAULT categories rather than the empty set the author
 * may have meant. Two keys, two meanings, no inference.
 */
export function policyDraftToBody(draft: PolicyDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    calendarSlug: draft.calendarSlug || 'business',
    precedence: draft.precedence,
    enabled: draft.enabled,
    reevaluateOnPriorityChange: draft.reevaluateOnPriorityChange,
    targets: draft.targets.map((target) => {
      const entry: Record<string, unknown> = {
        slug: target.slug,
        label: target.label || target.slug,
        durationsByPriority: { ...target.durationsByPriority },
        pauseOnCategories: [...target.pauseOnCategories],
        onTargetSwitch: target.onTargetSwitch,
      };
      if (target.calendarSlug) entry.calendarSlug = target.calendarSlug;
      if (target.pauseSources.length > 0) entry.pauseOn = [...target.pauseSources];
      if (target.pauseCalendarSlug) entry.pauseCalendarSlug = target.pauseCalendarSlug;
      if (target.warnAtPercent.length > 0) entry.warnAtPercent = [...target.warnAtPercent];
      if (target.escalationSlug) entry.escalationSlug = target.escalationSlug;
      if (target.appliesWhen) entry.appliesWhen = target.appliesWhen;

      if (target.stopKind === 'first_response') {
        entry.metric = 'first_response';
        entry.stop = { on: 'ticket.first_response' };
      } else if (target.stopKind === 'category') {
        entry.metric = 'resolution';
        entry.stop = { on: 'ticket.category_reached', category: target.stopCategory ?? 'resolved' };
      } else if (target.stopKind === 'condition' && target.stopWhen) {
        entry.stopWhen = target.stopWhen;
      }

      return entry;
    }),
  };

  if (draft.appliesWhen) body.appliesWhen = draft.appliesWhen;
  if (draft.organizations.length > 0) body.organizations = [...draft.organizations];
  if (draft.queues.length > 0) body.queues = [...draft.queues];
  if (draft.recordTypes.length > 0) body.recordTypes = [...draft.recordTypes];

  return body;
}

/**
 * THE refusal, evaluated locally so the editor can say no before the server does.
 *
 * A target that pauses on `outside_hours` while running on a business calendar
 * counts the same closed hours twice: once because the calendar does not
 * advance through them, and again because the clock is explicitly paused. The
 * resulting due date is roughly twice as generous as the contract says, and it
 * is wrong in a way that looks entirely plausible on screen.
 *
 * This is a MIRROR of `validateTarget()` and of the linter's `sla_double_pause`,
 * not a replacement: the server refuses the publish regardless. It exists so the
 * refusal arrives while the author is still looking at the target that caused
 * it, with the same wording.
 */
export function reviewPolicyDraft(
  draft: PolicyDraft,
  calendars: readonly CalendarSummary[],
): TargetIssue[] {
  const byslug = new Map(calendars.map((calendar) => [calendar.slug, calendar]));
  const issues: TargetIssue[] = [];

  for (const target of draft.targets) {
    const slug = target.calendarSlug || draft.calendarSlug;
    const calendar = byslug.get(slug);
    const wantsOutsideHours = target.pauseSources.includes('outside_hours');

    if (wantsOutsideHours && calendar && !calendar.is24x7) {
      issues.push({
        targetSlug: target.slug,
        code: 'outside_hours_on_business_calendar',
        severity: 'error',
        messageKey: 'sla.issue.doublePause',
        message:
          `La cible « ${target.slug} » tourne sur le calendrier ouvré « ${calendar.name} » ET se met en pause `
          + 'hors horaires : les heures fermées seraient décomptées deux fois et l’échéance serait environ deux '
          + 'fois plus généreuse que le contrat. Choisissez le calendrier 24×7, ou retirez la pause « hors horaires ».',
        messageEn:
          `Target "${target.slug}" runs on business calendar "${calendar.name}" AND pauses outside hours: `
          + 'the closed hours would be counted twice.',
      });
    }

    if (wantsOutsideHours && calendar?.is24x7) {
      const officeSlug = target.pauseCalendarSlug || calendars.find((entry) => entry.isDefault)?.slug;
      const office = officeSlug ? byslug.get(officeSlug) : undefined;
      if (!office || office.is24x7) {
        issues.push({
          targetSlug: target.slug,
          code: 'outside_hours_without_office_hours',
          severity: 'warning',
          messageKey: 'sla.issue.noOfficeHours',
          message:
            `La cible « ${target.slug} » se met en pause hors horaires, mais aucun calendrier d’ouverture `
            + 'ne fournit les bornes : sans horaires, il n’y a jamais de « hors horaires » et la pause ne se déclenchera pas.',
          messageEn:
            `Target "${target.slug}" pauses outside hours but no office-hours calendar supplies the edges.`,
        });
      }
    }

    if (Object.keys(target.durationsByPriority).length === 0) {
      issues.push({
        targetSlug: target.slug,
        code: 'no_duration_for_priority',
        severity: 'error',
        messageKey: 'sla.issue.noDuration',
        message:
          `La cible « ${target.slug} » ne déclare aucune durée par priorité : elle ne démarrera sur aucun ticket.`,
        messageEn: `Target "${target.slug}" declares no per-priority duration; it will never start.`,
      });
    }

    if (!target.slug.trim()) {
      issues.push({
        targetSlug: target.slug,
        code: 'unparseable',
        severity: 'error',
        messageKey: 'sla.issue.noSlug',
        message: 'Une cible sans identifiant est ignorée par le moteur.',
        messageEn: 'A target with no slug is dropped by the engine.',
      });
    }
  }

  return issues;
}

// ═════════════════════════════════════════════════════════════════════════════
// API
// ═════════════════════════════════════════════════════════════════════════════

interface ListEnvelope<T> extends Envelope<T[]> {
  total?: number;
  page?: number;
  limit?: number;
}

export const slaApi = {
  /**
   * Every published policy, parsed, with its bindings and its per-target
   * runtime findings.
   *
   * A policy the engine refuses still appears, WITH the finding attached — the
   * alternative is an admin staring at a ticket with no clock and no reason.
   */
  async policies(includeProblems = true): Promise<SlaPolicySummary[]> {
    try {
      const res = await apiClient.get<ListEnvelope<SlaPolicySummary>>('/sla/policies', {
        params: toQuery({ includeProblems }),
      });
      return unwrap<SlaPolicySummary[]>(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * The calendars as `calendar.service` resolves them — config body merged with
   * its projection rows, recurring holidays already expanded, the 24×7 flag
   * already decided. The same answer the engine read.
   */
  async calendars(): Promise<CalendarSummary[]> {
    try {
      const res = await apiClient.get<ListEnvelope<CalendarSummary>>('/sla/calendars');
      return unwrap<CalendarSummary[]>(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  async atRisk(params: {
    withinMinutes?: number;
    includeBreached?: boolean;
    limit?: number;
    queueSlug?: string;
    assigneeId?: number;
  } = {}): Promise<AtRiskRow[]> {
    try {
      const res = await apiClient.get<ListEnvelope<AtRiskRow>>('/sla/at-risk', {
        params: toQuery({ ...params }),
      });
      return unwrap<AtRiskRow[]>(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  async instances(ticketId: number): Promise<InstancesForTicket> {
    try {
      const res = await apiClient.get<Envelope<InstancesForTicket>>('/sla/instances', {
        params: toQuery({ ticketId }),
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async instance(id: number): Promise<SlaInstanceView> {
    try {
      const res = await apiClient.get<Envelope<SlaInstanceView>>(`/sla/instances/${id}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** THE explainer: the ledger, the replayed bands, the totals, the calendar. */
  async ledger(id: number): Promise<SlaExplainer> {
    try {
      const res = await apiClient.get<Envelope<SlaExplainer>>(`/sla/instances/${id}/ledger`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Add `manual` to the instance's pause SET — it does not replace whatever
   * else is holding the clock, which is why the result reports `activePauses`.
   */
  async pause(id: number, note?: string): Promise<ManualClockChange> {
    try {
      const res = await apiClient.post<Envelope<ManualClockChange>>(`/sla/instances/${id}/pause`, {
        note: note ?? null,
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Lift the MANUAL pause only. If the ticket is still pending on the
   * requester, the clock stays paused and the result says so through
   * `running: false` — a UI claiming otherwise would be contradicting the
   * ledger, which is the one that gets quoted.
   */
  async resume(id: number, note?: string): Promise<ManualClockChange> {
    try {
      const res = await apiClient.post<Envelope<ManualClockChange>>(`/sla/instances/${id}/resume`, {
        note: note ?? null,
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Authoring ────────────────────────────────────────────────────────────

  /** The stored policy body — the half the read model does not carry. */
  async policyObject(slug: string) {
    try {
      return await configApi.get<'sla'>('sla', slug);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async savePolicy(draft: PolicyDraft, options: { create?: boolean; note?: string } = {}) {
    // The engine's dialect is a superset of `SlaBody` (it reads `stop`,
    // `pauseOnCategories`, `onTargetSwitch`…). The cast says so out loud rather
    // than pretending the older published type is the whole vocabulary.
    const body = policyDraftToBody(draft) as unknown as SlaBody;
    try {
      if (options.create) {
        await configApi.create<'sla'>({
          kind: 'sla',
          slug: draft.slug,
          name: draft.name || draft.slug,
          description: draft.description || null,
          body,
        });
      } else {
        await configApi.update<'sla'>('sla', draft.slug, {
          name: draft.name || draft.slug,
          description: draft.description || null,
          body,
          note: options.note,
        });
      }
      return await configApi.publish<'sla'>('sla', draft.slug, options.note);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async calendarObject(slug: string) {
    try {
      return await configApi.get<'calendar'>('calendar', slug);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Save a calendar. The body IS the pure `BusinessCalendar` — the same shape
   * `businessMinutesBetween()` consumes, with no adapter in between, so what
   * the editor previews is what the engine counts.
   */
  async saveCalendar(
    slug: string,
    name: string,
    calendar: BusinessCalendar,
    options: { create?: boolean; note?: string; description?: string | null } = {},
  ) {
    try {
      if (options.create) {
        await configApi.create<'calendar'>({
          kind: 'calendar',
          slug,
          name,
          description: options.description ?? null,
          body: calendar,
        });
      } else {
        await configApi.update<'calendar'>('calendar', slug, {
          name,
          description: options.description ?? null,
          body: calendar,
          note: options.note,
        });
      }
      return await configApi.publish<'calendar'>('calendar', slug, options.note);
    } catch (error) {
      throw toApiError(error);
    }
  },
};

export default slaApi;
