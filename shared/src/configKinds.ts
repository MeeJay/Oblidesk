// ─────────────────────────────────────────────────────────────────────────────
// config_objects — the kinds, their body shapes, and their format versions.
//
// HARD RULE 3 — every cross-reference in a body is a human SLUG
//   (`queueSlug`, `calendarSlug`, `fieldSlugs`, `prioritySlug`, …), NEVER a
//   numeric id. Config objects are exported, diffed, imported into another
//   tenant and version-controlled; numeric ids do not survive any of that.
//
// HARD RULE 4 — `config_objects.body_format_version` is per KIND. Never change
//   a body shape silently. To change one:
//     1. bump the number in CONFIG_BODY_FORMAT_VERSIONS below,
//     2. add a migration step to the server's config body upgrader,
//     3. leave the old interface in place as `…BodyV1` so old rows still type.
//   A reader that meets a body_format_version it does not know MUST refuse to
//   evaluate it rather than guess.
//
// The seeded baseline (`is_system = true`) is the day-one config bundle, and
// it is exported/imported through exactly these shapes.
// ─────────────────────────────────────────────────────────────────────────────

import type { ConditionNode } from './conditions';
import type { StatusCategory } from './statusCategories';
import type { BusinessCalendar } from './calendar';

// ── Kinds ────────────────────────────────────────────────────────────────────

export const CONFIG_KINDS = [
  'field',
  'form',
  'view',
  'rule',
  'sla',
  'state_machine',
  'queue',
  'priority_matrix',
  'alert_binding',
  'catalog_item',
  'notification_template',
  'dashboard',
  'macro',
  'calendar',
  'escalation',
  'approval',
  /**
   * The recurrence detector's thresholds and signal weights.
   *
   * It lives here rather than in `settings` for one reason: `settings` is a
   * jsonb blob with no format version, no slug, no diff and no export. A
   * proposed problem candidate writes `decision_log.rule_slug` +
   * `rule_version` (HARD RULES 3 and 4) to name the published object that
   * proposed it — and a candidate raised by a configuration nobody can
   * retrieve as it stood is a candidate nobody can explain.
   *
   * `config_objects.kind` is an unconstrained varchar(32), so this costs no
   * migration.
   */
  'problem_detection',
  /**
   * Change management, in three objects rather than one, because the three
   * answer three different questions and a tenant edits them on three
   * different days:
   *
   *   change_policy  WHICH controls apply to WHICH change: the risk matrix,
   *                  the per-band approval slugs, the gate modes, the PIR
   *                  requirement and the lead time. It does SELECTION only —
   *                  the CAB itself is an ordinary `approval` object run by
   *                  the existing approval engine. Nothing about approval
   *                  mechanics is rebuilt here.
   *   change_model   a pre-approved recipe for a `standard` change. Its plans
   *                  are COPIED into the change at creation, never referenced:
   *                  the model gets edited next year, and the plan the CAB
   *                  blessed must stay readable exactly as it was executed.
   *   change_freeze  a period during which changes are refused, expressed by
   *                  INVERTING a `calendar` (see ChangeFreezeBody).
   *
   * They live here rather than in `settings` for the reason
   * `problem_detection` does: `settings` has no format version, no slug, no
   * diff and no export, and `decision_log.rule_slug` + `rule_version`
   * (HARD RULES 3 and 4) must be able to name the published object that
   * decided — a change blocked by a configuration nobody can retrieve as it
   * stood is a change nobody can explain.
   *
   * `config_objects.kind` is an unconstrained varchar(32), so all three cost
   * no migration.
   */
  'change_policy',
  'change_model',
  'change_freeze',
] as const;

export type ConfigKind = (typeof CONFIG_KINDS)[number];

/**
 * Current body format version per kind. ALL start at 1.
 * Bumping one is a deliberate, migrated act — see the header.
 */
export const CONFIG_BODY_FORMAT_VERSIONS: Readonly<Record<ConfigKind, number>> = {
  field: 1,
  form: 1,
  view: 1,
  rule: 1,
  sla: 1,
  state_machine: 1,
  queue: 1,
  priority_matrix: 1,
  alert_binding: 1,
  catalog_item: 1,
  notification_template: 1,
  dashboard: 1,
  macro: 1,
  calendar: 1,
  escalation: 1,
  approval: 1,
  problem_detection: 1,
  change_policy: 1,
  change_model: 1,
  change_freeze: 1,
};

export const CONFIG_KIND_LABELS: Readonly<Record<ConfigKind, { key: string; fallback: string }>> = {
  field: { key: 'config.kind.field', fallback: 'Field' },
  form: { key: 'config.kind.form', fallback: 'Form' },
  view: { key: 'config.kind.view', fallback: 'View' },
  rule: { key: 'config.kind.rule', fallback: 'Rule' },
  sla: { key: 'config.kind.sla', fallback: 'SLA policy' },
  state_machine: { key: 'config.kind.stateMachine', fallback: 'State machine' },
  queue: { key: 'config.kind.queue', fallback: 'Queue' },
  priority_matrix: { key: 'config.kind.priorityMatrix', fallback: 'Priority matrix' },
  alert_binding: { key: 'config.kind.alertBinding', fallback: 'Alert binding' },
  catalog_item: { key: 'config.kind.catalogItem', fallback: 'Catalog item' },
  notification_template: { key: 'config.kind.notificationTemplate', fallback: 'Notification template' },
  dashboard: { key: 'config.kind.dashboard', fallback: 'Dashboard' },
  macro: { key: 'config.kind.macro', fallback: 'Macro' },
  calendar: { key: 'config.kind.calendar', fallback: 'Calendar' },
  escalation: { key: 'config.kind.escalation', fallback: 'Escalation' },
  approval: { key: 'config.kind.approval', fallback: 'Approval' },
  problem_detection: { key: 'config.kind.problemDetection', fallback: 'Problem detection' },
  change_policy: { key: 'config.kind.changePolicy', fallback: 'Change policy' },
  change_model: { key: 'config.kind.changeModel', fallback: 'Change model' },
  change_freeze: { key: 'config.kind.changeFreeze', fallback: 'Change freeze' },
};

export function isConfigKind(value: unknown): value is ConfigKind {
  return typeof value === 'string' && (CONFIG_KINDS as readonly string[]).includes(value);
}

/** The version a freshly authored body of this kind must carry. */
export function currentBodyFormatVersion(kind: ConfigKind): number {
  return CONFIG_BODY_FORMAT_VERSIONS[kind];
}

/**
 * A reader must call this before evaluating a body. `false` ⇒ refuse to run the
 * engine on it and surface "this object was written by a newer Oblidesk".
 */
export function isReadableBodyVersion(kind: ConfigKind, bodyFormatVersion: number): boolean {
  return Number.isInteger(bodyFormatVersion) && bodyFormatVersion >= 1 && bodyFormatVersion <= CONFIG_BODY_FORMAT_VERSIONS[kind];
}

// ── Shared vocabulary ────────────────────────────────────────────────────────

/** Impact / urgency axes of the priority matrix. Hard-coded, like categories. */
export type ImpactLevel = 'high' | 'medium' | 'low';
export type UrgencyLevel = 'high' | 'medium' | 'low';

export const IMPACT_LEVELS: readonly ImpactLevel[] = ['high', 'medium', 'low'];
export const URGENCY_LEVELS: readonly UrgencyLevel[] = ['high', 'medium', 'low'];

/**
 * The SECOND axis of change risk, alongside `ImpactLevel`. It lives here beside
 * impact and urgency for the same reason they do: it is body vocabulary read by
 * a config object (`ChangePolicyBody.riskMatrix`) as well as a column
 * (`changes.failure_likelihood`), and one home means one spelling.
 *
 * Impact alone cannot separate "restart a mail server" from "restart a mail
 * server with a script we have never run", and that distinction is exactly what
 * risk is supposed to express. Urgency is deliberately NOT reused: urgency is
 * how fast the requester needs it, which says nothing about how likely the work
 * is to go wrong.
 */
export type FailureLikelihood = 'high' | 'medium' | 'low';
export const FAILURE_LIKELIHOODS: readonly FailureLikelihood[] = ['high', 'medium', 'low'];

/** Who a configuration surface is meant for. */
export type ConfigAudience = 'agent' | 'portal' | 'both';

/** Key of a priority-matrix cell — `${impact}:${urgency}`. */
export type PriorityMatrixKey = `${ImpactLevel}:${UrgencyLevel}`;

export function priorityMatrixKey(impact: ImpactLevel, urgency: UrgencyLevel): PriorityMatrixKey {
  return `${impact}:${urgency}`;
}

// ── kind: field ──────────────────────────────────────────────────────────────

export type FieldType =
  | 'text'
  | 'textarea'
  | 'markdown'
  | 'number'
  | 'boolean'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'datetime'
  | 'duration'
  | 'url'
  | 'email'
  | 'phone'
  | 'currency'
  | 'json'
  | 'user'
  | 'group'
  | 'contact'
  | 'organization'
  | 'ci'
  | 'ticket'
  | 'attachment';

export interface FieldOption {
  /** Stored value — a slug, never an id. */
  value: string;
  label: string;
  labelKey?: string;
  /** Design-token tone or hex; the chip renderer decides. */
  color?: string;
  sortOrder: number;
  isActive?: boolean;
}

export interface FieldBody {
  /** Storage key inside `tickets.data`. Immutable once published. */
  key: string;
  type: FieldType;
  label: string;
  labelKey?: string;
  helpText?: string;
  /** Placeholder text — goes through `t()` like every other string. */
  placeholder?: string;
  defaultValue?: unknown;
  /** select / multiselect only. */
  options?: FieldOption[];
  /** Pull options from another config object (by SLUG) instead of inline. */
  optionsSourceSlug?: string | null;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  /** Client-side pattern hint. Enforcement still happens at the transition. */
  pattern?: string;
  unit?: string;
  currency?: string;
  /** Record types this field applies to; empty = all. */
  appliesToRecordTypes?: string[];
  readOnly?: boolean;
  /** Feed the value into `tickets.search_tsv`. */
  indexed?: boolean;
  /** Redacted in exports, portal views and AI prompts. */
  piiSensitive?: boolean;
  visibleTo: ConfigAudience;
  /**
   * HARD RULE 12 — this is evaluated ONLY at a state transition, by
   * `evaluateCondition` on both client and server. Inline autosave never runs it.
   */
  requiredWhen?: ConditionNode | null;
  visibleWhen?: ConditionNode | null;
  editableWhen?: ConditionNode | null;
  sortOrder?: number;
}

// ── kind: form ───────────────────────────────────────────────────────────────

export interface FormSectionSpec {
  key: string;
  title: string;
  titleKey?: string;
  columns: 1 | 2;
  collapsedByDefault?: boolean;
  visibleWhen?: ConditionNode | null;
  /** Field config-object SLUGS, in render order (HARD RULE 3). */
  fieldSlugs: string[];
}

export interface FormBody {
  /** Record types this form serves; empty = all. */
  recordTypes: string[];
  audience: ConfigAudience;
  sections: FormSectionSpec[];
  submitLabel?: string;
  submitLabelKey?: string;
  /** Show the attachment dropzone under the last section. */
  allowAttachments?: boolean;
  /** Suggest KB articles as the requester types the subject. */
  suggestKb?: boolean;
}

// ── kind: view ───────────────────────────────────────────────────────────────

export interface ViewColumnSpec {
  /** Ticket column or `data.<field_slug>`. */
  field: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  sortOrder: number;
}

export interface ViewSortSpec {
  field: string;
  direction: 'asc' | 'desc';
}

export interface ViewBody {
  scope: 'personal' | 'tenant' | 'system';
  /** The saved filter. `null` = everything the viewer may see. */
  filter: ConditionNode | null;
  columns: ViewColumnSpec[];
  sort: ViewSortSpec[];
  groupBy?: string | null;
  pageSize?: number;
  /** Show a live count badge in the sidebar (backed by `saved_view_counts`). */
  showCount?: boolean;
  /** lucide-react icon name. */
  icon?: string;
  refreshSeconds?: number;
  /** Only offer the view to holders of these capabilities. */
  visibleToCapabilities?: string[];
  /** Default board grouping when the view is rendered as a kanban. */
  layout?: 'table' | 'board' | 'split';
  sortOrder?: number;
}

// ── kind: rule ───────────────────────────────────────────────────────────────

export type RuleTrigger =
  | 'ticket_created'
  | 'ticket_updated'
  | 'journal_added'
  | 'status_changed'
  | 'assignment_changed'
  | 'sla_warning'
  | 'sla_breached'
  | 'approval_decided'
  | 'alert_received'
  | 'mail_received'
  | 'schedule'
  | 'manual';

export type RuleActionType =
  | 'set_field'
  | 'set_status'
  | 'set_priority'
  | 'assign_to_user'
  | 'assign_to_group'
  | 'move_to_queue'
  | 'add_journal'
  | 'add_watcher'
  | 'send_notification'
  | 'send_email'
  | 'apply_macro'
  | 'start_approval'
  | 'link_ticket'
  | 'set_sla'
  | 'pause_sla'
  | 'resume_sla'
  | 'escalate'
  | 'add_tag'
  | 'webhook'
  | 'run_ai';

export interface RuleActionSpec {
  type: RuleActionType;
  /**
   * Action parameters. Every reference inside is a SLUG or a username, never a
   * numeric id. Templated strings use `{{ticket.number}}` style placeholders.
   */
  params: Record<string, unknown>;
  /** Skip this action (but keep it in the object) — handy while tuning. */
  disabled?: boolean;
}

export interface RuleBody {
  /** One rule may answer several triggers. */
  triggers: RuleTrigger[];
  when: ConditionNode | null;
  actions: RuleActionSpec[];
  /** Lower runs first. Ties break on slug for determinism. */
  priority: number;
  /** Stop evaluating later rules for this event once this one matches. */
  stopProcessing?: boolean;
  /** Fire at most once per ticket, ever. */
  runOnce?: boolean;
  /** Minimum minutes between two firings on the same ticket. */
  cooldownMinutes?: number;
  /** For the `schedule` trigger. */
  schedule?: { cron?: string; everyMinutes?: number; calendarSlug?: string | null } | null;
  /**
   * Evaluate and write `rule_executions` + `decision_log` rows, but perform no
   * action. The safe way to introduce a rule on a live desk.
   */
  dryRun?: boolean;
  enabled: boolean;
}

// ── kind: sla ────────────────────────────────────────────────────────────────

export type SlaMetric = 'first_response' | 'next_update' | 'resolution' | 'custom';

export interface SlaTargetSpec {
  /** Target slug, unique within the policy, e.g. 'first_response'. */
  slug: string;
  label: string;
  labelKey?: string;
  metric: SlaMetric;
  /** Overrides the policy calendar for this target only. */
  calendarSlug?: string | null;
  /** Which tickets this target applies to inside the policy. */
  appliesWhen?: ConditionNode | null;
  /** prioritySlug → minutes. Missing priority ⇒ target does not apply. */
  durationsByPriority: Record<string, number>;
  /** Status CATEGORIES that pause this clock (HARD RULE 5). */
  pauseOnCategories: StatusCategory[];
  /** Non-default clock start / stop. */
  startWhen?: ConditionNode | null;
  stopWhen?: ConditionNode | null;
  /** Raise a warning at this % of the budget (0-100). */
  warnAtPercent?: number;
  /** Escalation config object to run on warn / breach (by SLUG). */
  escalationSlug?: string | null;
}

export interface SlaBody {
  /** Default calendar for every target (by SLUG). */
  calendarSlug: string;
  targets: SlaTargetSpec[];
  /** Which tickets this policy covers at all. */
  appliesWhen?: ConditionNode | null;
  /** Higher wins when several policies match. */
  precedence: number;
  /**
   * Recompute `due_at` when priority changes mid-flight (`target_switch` is
   * written to `sla_ledger`), instead of freezing the original target.
   */
  reevaluateOnPriorityChange?: boolean;
  enabled?: boolean;
}

// ── kind: state_machine ──────────────────────────────────────────────────────

export interface StatusSpec {
  /** Configurable slug — the tenant may rename freely. */
  slug: string;
  label: string;
  labelKey?: string;
  /**
   * MANDATORY (HARD RULE 5). Every engine keys off THIS, never off `slug`.
   */
  category: StatusCategory;
  color?: string;
  /** Shown to portal contacts. */
  portalVisible?: boolean;
  portalLabel?: string;
  sortOrder: number;
  isDefault?: boolean;
}

export interface TransitionSpec {
  /** Source status slugs, or `'*'` for "from anywhere". */
  from: string[] | '*';
  /** Destination status slug. */
  to: string;
  label?: string;
  labelKey?: string;
  /** Extra guard beyond the from/to edge. */
  guard?: ConditionNode | null;
  /**
   * Field config-object SLUGS that must be non-empty to make this move.
   * HARD RULE 12 — this is the ONLY place required-ness is enforced, and it is
   * enforced by the same `evaluateCondition` run on client and server.
   */
  requiredFields?: string[];
  /** Capability keys the actor must hold. */
  requiredCapabilities?: string[];
  /** Fields to prompt for in the transition dialog (superset of required). */
  promptFor?: string[];
  /** Ask "are you sure?" before performing it. */
  confirm?: boolean;
  /** Values written as part of the transition (`resolution_code`, …). */
  setFields?: Record<string, unknown>;
  /** Perform the transition automatically once this becomes true. */
  autoWhen?: ConditionNode | null;
  sortOrder?: number;
}

export interface StateMachineBody {
  /** Record types this machine drives; empty = all. */
  recordTypes: string[];
  statuses: StatusSpec[];
  transitions: TransitionSpec[];
  /** Status a brand-new ticket starts in. */
  initialStatusSlug: string;
  /** Status a reopened ticket lands in. */
  reopenToStatusSlug?: string | null;
  /** Auto-close resolved tickets after N calendar days. */
  autoCloseAfterDays?: number | null;
  /** Days after closing during which a reply reopens instead of forking. */
  reopenWindowDays?: number | null;
}

// ── kind: queue ──────────────────────────────────────────────────────────────

export type QueueRoutingStrategy = 'manual' | 'round_robin' | 'least_loaded' | 'skill';

export interface QueueBody {
  /** Assignment group that owns the queue (by SLUG). */
  assignmentGroupSlug?: string | null;
  /** Fallback assignee, by USERNAME (never a user id). */
  defaultAssigneeUsername?: string | null;
  routing: QueueRoutingStrategy;
  /** Auto-route a ticket into this queue when this matches. */
  matchWhen?: ConditionNode | null;
  slaPolicySlug?: string | null;
  calendarSlug?: string | null;
  formSlug?: string | null;
  stateMachineSlug?: string | null;
  /** Inbound addresses that land in this queue. */
  mailAliases?: string[];
  /** Reply-from address for this queue. */
  fromAddress?: string | null;
  color?: string;
  icon?: string;
  sortOrder: number;
  /** Only route into this queue during its calendar's business hours. */
  businessHoursOnly?: boolean;
  isActive?: boolean;
}

// ── kind: priority_matrix ────────────────────────────────────────────────────

export interface PrioritySpec {
  slug: string;
  label: string;
  labelKey?: string;
  /** 1 = most urgent. Drives sorting and the P1/P2/P3/P4 chips. */
  rank: number;
  color?: string;
  /** Per-priority SLA override (by SLUG). */
  slaPolicySlug?: string | null;
  sortOrder: number;
}

export interface PriorityMatrixBody {
  priorities: PrioritySpec[];
  /** `${impact}:${urgency}` → priority SLUG. Must be exhaustive (3 × 3). */
  matrix: Partial<Record<PriorityMatrixKey, string>>;
  defaultPrioritySlug: string;
  /** Let an agent override the computed priority by hand. */
  allowManualOverride: boolean;
  /** Re-derive the priority whenever impact or urgency changes. */
  recomputeOnChange?: boolean;
}

// ── kind: alert_binding ──────────────────────────────────────────────────────

export type AlertBindingAction = 'create_ticket' | 'append_journal' | 'raise_only' | 'suppress';

export interface AlertBindingBody {
  /** Suite apps this binding listens to, e.g. ['obliguard', 'obliance']. */
  sourceApps: string[];
  matchWhen?: ConditionNode | null;
  /**
   * Template for `suite_alerts.dedupe_key`, e.g.
   * `{{source_app}}:{{ci.hardware_uuid}}:{{alert.check}}`.
   * Two alerts with the same key are ONE incident with an occurrence count.
   */
  dedupeKeyTemplate: string;
  action: AlertBindingAction;
  queueSlug?: string | null;
  recordType?: string;
  prioritySlug?: string | null;
  impact?: ImpactLevel;
  urgency?: UrgencyLevel;
  subjectTemplate: string;
  bodyTemplate?: string;
  /** Reuse an existing ticket resolved less than N minutes ago. */
  reopenWindowMinutes?: number;
  /** Resolve the ticket when the source app clears the alert. */
  autoResolveOnClear: boolean;
  suppressWhen?: ConditionNode | null;
  /** Ignore a flapping source: N occurrences within M minutes before acting. */
  flapGuard?: { occurrences: number; withinMinutes: number } | null;
  /** Match/create a CI from the alert's hardware UUID (cross-app join). */
  linkCiByHardwareUuid: boolean;
  /**
   * HARD RULE 13 — cross-app tenant identity joins on tenant SLUG. The binding
   * carries the slug the source app sends; the numeric tenant id is resolved
   * locally.
   */
  tenantSlugField?: string;
  enabled: boolean;
}

// ── kind: catalog_item ───────────────────────────────────────────────────────

export interface CatalogItemBody {
  category: string;
  icon?: string;
  shortDescription: string;
  shortDescriptionKey?: string;
  descriptionMd?: string;
  /** Request form (by SLUG). */
  formSlug: string;
  recordType: string;
  queueSlug?: string | null;
  prioritySlug?: string | null;
  approvalSlug?: string | null;
  slaPolicySlug?: string | null;
  fulfilmentGroupSlug?: string | null;
  costEstimate?: { amount: number; currency: string } | null;
  deliveryEstimateDays?: number | null;
  visibleToPortal: boolean;
  visibleWhen?: ConditionNode | null;
  /** Related KB article slugs shown as "before you ask". */
  kbArticleSlugs?: string[];
  sortOrder: number;
  isActive?: boolean;
}

// ── kind: notification_template ──────────────────────────────────────────────

export type NotificationAudience =
  | 'requester'
  | 'assignee'
  | 'assignment_group'
  | 'watchers'
  | 'participants'
  | 'approvers'
  | 'custom';

export interface NotificationTemplateLocaleBody {
  subject: string;
  bodyMd: string;
  bodyHtml?: string;
}

export interface NotificationTemplateBody {
  /** Domain event this template answers, e.g. 'ticket.public_reply'. */
  event: string;
  /** Channel types this template can render for: email / inapp / webhook / … */
  channelTypes: string[];
  audience: NotificationAudience;
  /** Extra recipients when audience = 'custom' — usernames or addresses. */
  customRecipients?: string[];
  /** Locale code ('en', 'fr') → the rendered strings. Seed en + fr. */
  locales: Record<string, NotificationTemplateLocaleBody>;
  defaultLocale: string;
  /** Never leak internal work notes into a requester-facing email. */
  includePublicJournalOnly: boolean;
  attachFiles?: boolean;
  sendWhen?: ConditionNode | null;
  /** Collapse repeats within this window. */
  throttleMinutes?: number;
  enabled: boolean;
}

// ── kind: dashboard ──────────────────────────────────────────────────────────

export type WidgetType =
  | 'kpi'
  | 'ticket_list'
  | 'bar_chart'
  | 'line_chart'
  | 'area_chart'
  | 'donut'
  | 'heatmap'
  | 'sla_gauge'
  | 'queue_load'
  | 'agent_leaderboard'
  | 'activity_feed'
  | 'alert_feed'
  | 'csat'
  | 'time_summary'
  | 'text';

export interface DashboardTabSpec {
  key: string;
  label: string;
  labelKey?: string;
  sortOrder: number;
}

export interface DashboardWidgetSpec {
  /** Stable key so a layout move does not orphan the widget's config. */
  key: string;
  widgetType: WidgetType;
  title: string;
  titleKey?: string;
  tabKey: string;
  /** 12-column grid. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Widget-specific settings — metric key, filter, view slug, colours. */
  config: Record<string, unknown>;
  sortOrder: number;
}

export interface DashboardBody {
  tabs: DashboardTabSpec[];
  widgets: DashboardWidgetSpec[];
  refreshSeconds?: number;
  /** Default time range token, e.g. '7d', '30d', 'mtd'. */
  defaultRange?: string;
  isDefault?: boolean;
}

// ── kind: macro ──────────────────────────────────────────────────────────────

export interface MacroBody {
  /** Only offer the macro when this matches the open ticket. */
  appliesWhen?: ConditionNode | null;
  actions: RuleActionSpec[];
  /** Canned journal entry appended when the macro runs. */
  journal?: {
    kind: 'public_reply' | 'work_note';
    visibility: 'public' | 'internal';
    bodyMd: string;
    /** locale → bodyMd override. */
    locales?: Record<string, string>;
  } | null;
  requiredCapabilities?: string[];
  /** e.g. 'mod+shift+1'. */
  keyboardShortcut?: string;
  icon?: string;
  sortOrder: number;
  isActive?: boolean;
}

// ── kind: calendar ───────────────────────────────────────────────────────────

/**
 * Identical to the pure `BusinessCalendar` consumed by `calendar.ts`, so the
 * SLA engine can feed a config body straight into `businessMinutesBetween`
 * with no adapter in between.
 */
export type CalendarBody = BusinessCalendar;

// ── kind: escalation ─────────────────────────────────────────────────────────

export type EscalationTrigger =
  | 'sla_warning'
  | 'sla_breach'
  | 'no_update'
  | 'unassigned'
  | 'reopened'
  | 'priority';

/**
 * How `kind: 'on_call'` picks a member of the group named by `ref`. The choice
 * is a pure function of the instant, so the `decision_log` row an escalation
 * writes replays to the SAME person a year later — which a shift table read at
 * fire time could never promise. Both halves are defaulted by the engine.
 */
export interface EscalationRotationSpec {
  /** Length of one shift, in hours. Default 168 (one week). */
  periodHours?: number;
  /** ISO-8601 instant shift 0 began. Default the Unix epoch. */
  anchor?: string;
}

export interface EscalationNotifyTarget {
  kind:
    | 'assignee'
    | 'assignment_group'
    | 'manager_of_assignee'
    | 'user'
    | 'channel'
    | 'requester'
    /** Rotate over the members of the assignment group named by `ref`. */
    | 'on_call'
    /** Everybody already watching the ticket. */
    | 'watchers';
  /** Username / group slug / channel name — never a numeric id. */
  ref?: string;
  /** `on_call` only. Omitted ⇒ the engine's weekly-from-the-epoch default. */
  rotation?: EscalationRotationSpec | null;
}

export interface EscalationStepSpec {
  /** Business minutes after the trigger (measured on `calendarSlug`). */
  afterMinutes: number;
  calendarSlug?: string | null;
  notify: EscalationNotifyTarget[];
  actions: RuleActionSpec[];
  /** Repeat this step every `afterMinutes` until `stopWhen` becomes true. */
  repeat?: boolean;
  maxRepeats?: number;
  /** Tone of the bell entry / notification this step raises. Default 'warning'. */
  severity?: 'critical' | 'warning' | 'info';
  /** Notification template this step renders (HARD RULE 3 — a slug). */
  templateSlug?: string | null;
  /** Author's name for the step, shown in the ladder editor and the Why drawer. */
  label?: string;
}

export interface EscalationBody {
  trigger: EscalationTrigger;
  appliesWhen?: ConditionNode | null;
  steps: EscalationStepSpec[];
  /** Ladder-wide default calendar (by SLUG); a step may override it. */
  calendarSlug?: string | null;
  /** Cancel the whole ladder once this matches. */
  stopWhen?: ConditionNode | null;
  enabled: boolean;
}

// ── kind: approval ───────────────────────────────────────────────────────────

export type ApprovalMode = 'sequential' | 'parallel' | 'quorum';

export interface ApprovalApproverSpec {
  kind: 'user' | 'group' | 'manager_of_requester' | 'field';
  /** Username, group slug, or field slug when kind = 'field'. */
  ref?: string;
}

export interface ApprovalStepSpec {
  stepIndex: number;
  label?: string;
  labelKey?: string;
  approvers: ApprovalApproverSpec[];
  mode: ApprovalMode;
  /** Required approvals when mode = 'quorum'. */
  quorum?: number;
  /** Business minutes before the step times out. */
  dueMinutes?: number;
  calendarSlug?: string | null;
  onTimeout: 'approve' | 'reject' | 'escalate' | 'wait';
  /**
   * Ladder armed when `onTimeout === 'escalate'` (HARD RULE 3 — a slug).
   * Falls back to the definition-wide `ApprovalBody.escalationSlug`; a step
   * that escalates on timeout and names neither notifies nobody.
   */
  escalationSlug?: string | null;
  /** Overrides the definition-wide reminder cadence for this step only. */
  reminderMinutes?: number;
}

export interface ApprovalBody {
  /** When a ticket needs this approval at all. */
  requiredWhen?: ConditionNode | null;
  steps: ApprovalStepSpec[];
  onApproved: RuleActionSpec[];
  onRejected: RuleActionSpec[];
  allowDelegate: boolean;
  /** Remind pending approvers every N business minutes. */
  reminderMinutes?: number;
  /** Default calendar every step's `dueMinutes` is measured on (by SLUG). */
  calendarSlug?: string | null;
  /** Default ladder for a step that escalates on timeout (by SLUG). */
  escalationSlug?: string | null;
  /** Block the ticket from leaving its status while pending. */
  blocksTransitions?: boolean;
  /**
   * WHICH transitions a pending approval blocks. `blocksTransitions` on its own
   * is a boolean that never says what it stops, so these two narrow it:
   *
   *   blockedStatusSlugs      destination statuses that are refused
   *   blockedStatusCategories destination CATEGORIES that are refused (RULE 5)
   *
   * Both empty (the shipped default) blocks resolving and closing only — see
   * `blocksThisMove()` in the approval engine for why that is the conservative
   * reading and why "everything except cancelled" is not.
   */
  blockedStatusSlugs?: string[];
  blockedStatusCategories?: StatusCategory[];
}

// ── kind: problem_detection ──────────────────────────────────────────────────

/** The six recurrence signals, in the order the candidate card renders them. */
export const PROBLEM_DETECTION_SIGNALS = [
  'ci_repetition',
  'alert_flapping',
  'subject_cluster',
  'reopen_pressure',
  'queue_spike',
  'known_error_miss',
] as const;

export type ProblemDetectionSignal = (typeof PROBLEM_DETECTION_SIGNALS)[number];

/**
 * Signals whose evidence is an EXACT machine identity rather than a
 * resemblance: the same CI, the same alert dedupe key, the same already
 * published known error. At least one of these must have fired before a
 * candidate may be raised (`requireExactSignal`).
 *
 * The weights below already make a text-only candidate arithmetically
 * impossible, but a tenant may edit weights and this invariant may not be
 * edited away: a card raised because "both tickets contain the word printer"
 * teaches agents to reject without reading, and a suggestion box that is not
 * read is worth less than no suggestion box.
 */
export const PROBLEM_EXACT_SIGNALS: readonly ProblemDetectionSignal[] = [
  'ci_repetition',
  'alert_flapping',
  'known_error_miss',
];

/** One signal's switch, weight and thresholds. */
export interface ProblemSignalSpec {
  enabled: boolean;
  /**
   * Noisy-OR weight in 0..1 — the score this signal alone can reach when
   * fully saturated. See `scoreProblemCandidate` in ./problem.
   */
  weight: number;
  /** Signal-specific trigger threshold; the meaning is per signal. */
  threshold: number;
  /**
   * Second threshold for the two signals that have one:
   *   alert_flapping   `threshold` = cleared cycles, `secondary` = peak occurrences
   *   subject_cluster  `threshold` = matching incidents, `secondary` = min similarity 0..1
   * Ignored by the other four.
   */
  secondary?: number;
}

export interface ProblemDetectionBody {
  enabled: boolean;
  /** Look-back of one pass, in days. */
  windowDays: number;
  /** Score at or above which a candidate is raised. */
  scoreThreshold: number;
  /** New cards per tenant per pass, best score first. The rest are simply not created. */
  maxNewCandidatesPerRun: number;
  /** Keep the "at least one exact signal" guard. Belt and braces over the weights. */
  requireExactSignal: boolean;

  signals: Readonly<Record<ProblemDetectionSignal, ProblemSignalSpec>>;

  rejection: {
    /** How long a rejected signature stays suppressed. */
    cooldownDays: number;
    /**
     * A suppressed signature is re-proposed BEFORE the cooldown expires only
     * when the evidence has materially worsened: the new score reaches
     * `rejectedScore * escalationFactor`, or the incident count doubled. A
     * suppression with no way out turns a human "no" into amnesia.
     */
    escalationFactor: number;
  };

  /** HARD RULE 3 — by slug. Used when a candidate is accepted into a problem. */
  defaultQueueSlug: string | null;
  defaultPrioritySlug: string | null;
}

// ── Change management: shared vocabulary ─────────────────────────────────────
//
// These tuples are body vocabulary AND column vocabulary: each one mirrors a
// CHECK in migration 011. They live here rather than in ./change because the
// three change bodies below are typed through them and ./change imports this
// module, never the reverse.

/**
 * `changes.change_type`. The slug is `emergency`, not `urgent`, even though the
 * French label is "urgente": `tickets.urgency` already exists with
 * high|medium|low, and a row carrying `change_type = 'urgent'` next to
 * `urgency = 'high'` is a naming trap in every query, every report and every
 * condition tree a tenant writes. Labels are i18n; slugs are forever.
 *
 * The type is not a chip colour. It switches exactly four engine behaviours —
 * approval selection, the conflict gate, the freeze gate, the PIR requirement —
 * and nothing else in the module keys on it.
 */
export const CHANGE_TYPES = ['standard', 'normal', 'emergency'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/** `changes.risk` and `changes.risk_computed`. The output of the matrix. */
export const CHANGE_RISKS = ['high', 'medium', 'low'] as const;
export type ChangeRisk = (typeof CHANGE_RISKS)[number];

/** The 3x3 lookup key of `ChangePolicyBody.riskMatrix`: `impact:likelihood`. */
export type ChangeRiskMatrixKey = `${ImpactLevel}:${FailureLikelihood}`;

/**
 * How hard a control bites.
 *
 *   block  the shared evaluator refuses the move and the server refuses it too
 *   warn   the panel says so, the move proceeds
 *   off    not evaluated at all
 *
 * `warn` is not weakness: a control people route around is not a control, and a
 * hard block on every band is how teams end up scheduling outside the tool —
 * which destroys the calendar the conflict detector reads, i.e. its own input.
 */
export const CHANGE_GATE_MODES = ['block', 'warn', 'off'] as const;
export type ChangeGateMode = (typeof CHANGE_GATE_MODES)[number];

/** When a band owes a post-implementation review. */
export const CHANGE_PIR_REQUIREMENTS = ['always', 'on_failure', 'never'] as const;
export type ChangePirRequirement = (typeof CHANGE_PIR_REQUIREMENTS)[number];

// ── kind: change_policy ──────────────────────────────────────────────────────

/** What one risk band demands. Every cross-reference is a SLUG (HARD RULE 3). */
export interface ChangeRiskBandSpec {
  /**
   * The `approval` objects a change in this band must obtain. The CAB is one of
   * these; it is an ordinary approval definition run by the existing engine.
   *
   * An approval named here MUST carry no `requiredWhen` of its own. The
   * selection has already decided, and a definition that ALSO carries a
   * condition is started twice — once by this policy, once by the transition
   * hook that runs `startRequiredApprovals` on every non-terminal move. Two
   * pending approvals, two inboxes, one change. The config linter refuses it.
   */
  approvalSlugs: string[];
  conflictGate: ChangeGateMode;
  freezeGate: ChangeGateMode;
  pirRequired: ChangePirRequirement;
  /** Business minutes a change in this band must be scheduled ahead by. */
  leadTimeMinutes: number;
  /** Calendar the lead time and the PIR due date are measured on (by SLUG). */
  calendarSlug?: string | null;
  /** Business minutes after the outcome is recorded before the PIR is due. */
  pirDueBusinessMinutes: number;
  /** Business minutes overdue before `pirEscalationSlug` is started. */
  pirEscalateAfterBusinessMinutes?: number;
}

/** Per-type overrides. Anything omitted falls through to the risk band. */
export interface ChangeTypeSpec {
  /**
   * `standard` only. A standard change may not be authored freehand: it must
   * name a `change_model`. That single requirement is the only thing that makes
   * "pre-approved" safe, because 'standard' without a model is just 'normal
   * with the controls turned off'.
   */
  requireModel?: boolean;
  /** Union the resolved band's `approvalSlugs` on top of this type's own. */
  inheritFromRiskBand?: boolean;
  approvalSlugs?: string[];
  conflictGate?: ChangeGateMode;
  freezeGate?: ChangeGateMode;
  pirRequired?: ChangePirRequirement;
  leadTimeMinutes?: number;
}

/** Extra approvals earned by the change's context, never removed by it. */
export interface ChangeApprovalAddition {
  addApprovalSlugs: string[];
}

export interface ChangePolicyBody {
  /** Exhaustive 3x3. A missing cell would silently become the safest guess. */
  riskMatrix: Readonly<Record<ChangeRiskMatrixKey, ChangeRisk>>;
  riskBands: Readonly<Record<ChangeRisk, ChangeRiskBandSpec>>;
  byType: Readonly<Record<ChangeType, ChangeTypeSpec>>;

  /**
   * Keyed by the worst `cis.criticality` among the CIs linked as primary or
   * affected. The four values are the hard-coded CMDB enum, so this is fully
   * lintable.
   */
  byCiCriticality?: Partial<
    Record<'critical' | 'high' | 'medium' | 'low', ChangeApprovalAddition>
  >;
  /**
   * Keyed by queue SLUG. Deliberately by queue and not by assignment group:
   * assignment groups are ROWS, not config objects, `assignment_group` is not a
   * ConfigKind and CONFIG_KIND_REFERENCES cannot express it — the same reason
   * the queue baseline's `default_assignment_group` is excluded from the
   * linter. A tenant who genuinely needs a per-service owner writes an
   * `approval` whose approvers include a `field` approver; that is reuse of an
   * existing facility, not a new one.
   */
  byQueue?: Record<string, ChangeApprovalAddition>;

  conflictDetection: {
    enabled: boolean;
    /** How far ahead the sweeper re-scans planned windows. */
    lookaheadDays: number;
    /** Above this many overlapping changes on one queue, raise a saturation row. */
    maxConcurrentPerQueue: number;
    /** Off by default: capacity is a different signal from a real conflict. */
    queueSaturationEnabled: boolean;
  };

  /**
   * How far the planned window may move after the baseline is frozen before
   * the granted approvals are invalidated and re-selected. An approval is
   * consent to a SPECIFIC window; silently carrying it onto another one is
   * consent nobody gave.
   */
  windowMoveToleranceMinutes: number;
  /** Ladder started when a PIR stays overdue (HARD RULE 3 — a slug). */
  escalationSlug?: string | null;
  /** Fallback calendar for lead time and PIR due dates (by SLUG). */
  calendarSlug?: string | null;
}

// ── kind: change_model ───────────────────────────────────────────────────────

/**
 * A pre-approved recipe. Its plans are COPIED into the change at creation and
 * never referenced: the model will be edited next year and the plan the CAB
 * blessed must stay readable exactly as it was executed. Same argument that
 * gave `problem_analyses` its superseded rows.
 */
export interface ChangeModelBody {
  /** Every change created from this model is this type. Normally 'standard'. */
  changeType: ChangeType;
  /** Copied verbatim into `changes.implementation_md` at creation. */
  implementationMd: string;
  /** Copied verbatim into `changes.backout_md`. */
  backoutMd?: string | null;
  /** Copied verbatim into `changes.test_md`. */
  testMd?: string | null;
  /** Seeds `tickets.impact` and `changes.failure_likelihood`. */
  impact?: ImpactLevel | null;
  failureLikelihood?: FailureLikelihood | null;
  /** Typical duration, used to pre-fill the planned window in the picker. */
  defaultDurationMinutes?: number;
  /** HARD RULE 3 — all by slug. */
  formSlug?: string | null;
  queueSlug?: string | null;
  prioritySlug?: string | null;
  /** Approvals this model always demands, on top of whatever the policy picks. */
  approvalSlugs?: string[];
  calendarSlug?: string | null;
  isActive: boolean;
}

// ── kind: change_freeze ──────────────────────────────────────────────────────

/**
 * A period during which changes are refused, expressed by INVERTING a
 * `calendar`.
 *
 * THE INVERSION IS THE WHOLE TRICK, and it is why freezes cost almost nothing.
 * A `calendar` already models weekly shifts, holidays, exception days and a
 * timezone; `calendarService.calendarBands()` already splits a range into
 * open/shut bands and is already tested. A freeze calendar is authored with the
 * FREEZE PERIODS AS THE OPEN SHIFTS, and then:
 *
 *     frozen  ⇔  calendarBands(freezeCalendar, plannedStart, plannedEnd)
 *                contains any band with open === true
 *
 * One line, one existing function, no second date engine. `open === true` means
 * FROZEN here and open-for-business everywhere else in the product, so the
 * config editor says so in prose above the picker and this comment says it in
 * code. The alternative — a `change_freeze_periods` table with a start and an
 * end — survives about a month, until somebody asks for "every Friday after
 * 16:00" and "the 24th to the 2nd, every year", at which point recurrence has
 * been rebuilt badly. The calendar already has recurrence, holidays, exceptions
 * and a timezone, the tenant already knows its editor, and the config bundle
 * already exports it.
 *
 * A freeze has NO clock, NO pause, NO breach, NO target and NO ledger. It
 * answers one boolean per change per evaluation. The day somebody asks for
 * "business minutes remaining in the freeze", the answer is that this is an
 * `sla` object and a different question.
 */
export interface ChangeFreezeBody {
  enabled: boolean;
  /**
   * The calendar whose OPEN bands are the frozen periods (HARD RULE 3).
   * Required: a freeze naming no calendar freezes nothing, and the linter says
   * so rather than letting it sit there looking like a control.
   */
  calendarSlug: string;
  /** Narrow the freeze to some changes. Evaluated by the caller, not here. */
  appliesWhen?: ConditionNode | null;
  /**
   * Types this freeze never applies to. Shipping `['emergency']` is the honest
   * default: a freeze that stops a 03:00 outage fix gets the fix done off-book
   * and ticketed never. Note that `['standard','emergency']` sounds equally
   * reasonable and quietly means the freeze catches ONLY normal changes — which
   * may well be right, but it must be SAID, so the editor renders the
   * exclusions in prose.
   */
  exemptTypes?: ChangeType[];
  /** Bands this freeze applies to. Empty catches NOTHING; the linter warns. */
  appliesToRiskBands?: ChangeRisk[];
  /** `block` refuses the move; `warn` lets it through and says so. */
  severity: 'block' | 'warn';
  /**
   * When set, overriding this freeze is not a click: it starts that `approval`
   * and the block stands until it is granted (HARD RULE 3). That is how a
   * tenant makes a freeze genuinely hard without making it impossible.
   */
  overrideApprovalSlug?: string | null;
  label?: string;
  labelKey?: string;
  /** Shown to whoever is refused. `t(reasonKey, reason)` — HARD RULE 10. */
  reason?: string;
  reasonKey?: string;
}

// ── Kind → body map ──────────────────────────────────────────────────────────

/**
 * The one place that says "kind X carries body shape Y". `ConfigObject<K>` in
 * `types.ts` is typed through this, so a mismatched body is a compile error.
 */
export interface ConfigBodyByKind {
  field: FieldBody;
  form: FormBody;
  view: ViewBody;
  rule: RuleBody;
  sla: SlaBody;
  state_machine: StateMachineBody;
  queue: QueueBody;
  priority_matrix: PriorityMatrixBody;
  alert_binding: AlertBindingBody;
  catalog_item: CatalogItemBody;
  notification_template: NotificationTemplateBody;
  dashboard: DashboardBody;
  macro: MacroBody;
  calendar: CalendarBody;
  escalation: EscalationBody;
  approval: ApprovalBody;
  problem_detection: ProblemDetectionBody;
  change_policy: ChangePolicyBody;
  change_model: ChangeModelBody;
  change_freeze: ChangeFreezeBody;
}

export type ConfigBodyFor<K extends ConfigKind> = ConfigBodyByKind[K];

/** Any config body, for code that handles the kinds generically. */
export type AnyConfigBody = ConfigBodyByKind[ConfigKind];

/**
 * Which kinds may reference which other kinds, by slug. The config linter walks
 * this to flag a dangling `queueSlug` before an engine silently no-ops on it.
 *
 * This is a CATALOGUE, not a filter: an edge missing here does not stop the
 * linter resolving the slug, it stops the linter knowing the reference was
 * meant to exist — so the entry has to match what the shipped baseline and the
 * body shapes above actually contain, kind by kind.
 *
 * What is deliberately NOT here: the queue baseline's `default_assignment_group`
 * and `visible_to_groups`. Those name `assignment_groups` ROWS, not config
 * objects; `assignment_group` is not a `ConfigKind` and this map cannot express
 * it. The linter excludes them for the same reason (see its `REFERENCE_KEYS`).
 */
export const CONFIG_KIND_REFERENCES: Readonly<Record<ConfigKind, readonly ConfigKind[]>> = {
  field: ['field'],
  // The baseline's `incident_default` form names the state machine whose
  // transitions its required-ness is enforced by (HARD RULE 12).
  form: ['field', 'state_machine'],
  view: ['field'],
  // `RuleBody.actions` is the closed action catalogue: `escalate` carries an
  // escalation slug like `apply_macro` carries a macro slug. `calendar` comes
  // from `RuleBody.schedule.calendarSlug`.
  rule: ['queue', 'macro', 'approval', 'sla', 'notification_template', 'field', 'escalation', 'calendar'],
  // The baseline `standard` policy names a template per `notify_on` threshold.
  sla: ['calendar', 'escalation', 'notification_template'],
  state_machine: ['field'],
  // The baseline queues carry `default_priority_matrix` alongside the other four.
  queue: ['sla', 'calendar', 'form', 'state_machine', 'priority_matrix'],
  priority_matrix: ['sla'],
  alert_binding: ['queue', 'priority_matrix'],
  catalog_item: ['form', 'queue', 'approval', 'sla'],
  notification_template: [],
  dashboard: ['view'],
  // `MacroBody.actions` is the SAME closed catalogue as `RuleBody.actions`, so
  // a macro reaches every kind an action can name.
  macro: ['field', 'queue', 'notification_template', 'macro', 'approval', 'sla', 'escalation'],
  calendar: [],
  escalation: ['calendar', 'notification_template'],
  // `escalationSlug`, on the body and on a step that escalates on timeout.
  approval: ['calendar', 'escalation'],
  // `defaultQueueSlug` names a queue; `defaultPrioritySlug` is a cell of the
  // priority matrix, which is the object that owns the priority vocabulary.
  problem_detection: ['queue', 'priority_matrix'],
  // `approval` from every band's and every type's `approvalSlugs` plus the two
  // addition maps; `calendar` from the band and the policy fallback; `queue`
  // from the keys of `byQueue`; `escalation` from `escalationSlug`.
  change_policy: ['approval', 'calendar', 'queue', 'escalation'],
  change_model: ['form', 'queue', 'priority_matrix', 'approval', 'calendar'],
  // `calendarSlug` is the INVERTED calendar whose open bands are the freeze;
  // `overrideApprovalSlug` is what a would-be overrider must obtain.
  change_freeze: ['calendar', 'approval'],
};
