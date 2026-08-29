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
};
