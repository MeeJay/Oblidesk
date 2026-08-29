/**
 * rules.api.ts — `/api/rules`, plus the authoring round-trip through the
 * configuration store.
 *
 * ── One list, one order, one answer ─────────────────────────────────────────
 * `GET /api/rules` does NOT return raw config bodies. It returns the
 * NORMALISED, ORDERED, engine-eye view — the same array `runRules()` iterates,
 * built by the same `normalizeRule()`. So this module never parses a rule body
 * itself: it reads the engine's answer, edits THAT, and writes it back in the
 * one dialect the engine reads. A second interpretation living in the browser
 * is how "what will happen to this ticket?" quietly acquires two answers.
 *
 * ── Reading and writing are different doors, on purpose ─────────────────────
 *   READ    `/api/rules`          the ordered list, health, breakers, issues
 *   RUN     `/api/rules/simulate` the dry run, over real tickets
 *   ORDER   `POST /api/rules`     a whole-list write (race-free by design)
 *   TOGGLE  `/:slug/enable|disable`
 *   AUTHOR  `/api/config-objects` create / update / publish, versioned, linted
 *
 * Authoring goes through the config store rather than a bespoke rule endpoint
 * because a rule IS a config object: it is checksummed, versioned, linted,
 * exportable and revertible only if it stays one. `saveRule()` below is a thin
 * wrapper over `configApi`, not a second store.
 *
 * ── The action catalogue is fetched, never hard-coded ───────────────────────
 * `GET /api/rules/actions` serves the closed catalogue with its parameter
 * schemas, and `ActionEditor` renders its form from that. A copy of the list in
 * the client would be an open catalogue with extra steps: the day somebody adds
 * an action server-side, the copy is wrong and nobody finds out until a rule
 * reports success and does nothing.
 *
 * ── The field catalogue is NOT served by an endpoint (yet) ──────────────────
 * `ConditionBuilder` needs the set of leaf paths a condition may name. The
 * server's whitelist lives in `stateMachine.service.ts` (`TICKET_FIELDS` +
 * `resolveTicketFieldPath`) and is not exposed over HTTP today, so
 * `loadFieldCatalogue()` mirrors it EXACTLY — every path below is one the
 * server would resolve — and enriches it with the tenant's own published
 * configuration (custom fields, queues, priorities, statuses) so the picker
 * offers real values rather than free text. The mirror is documented as a
 * mirror; when `GET /api/rules/fields` lands, delete `TICKET_FIELD_PATHS` and
 * fetch it. Until then, adding a column to the server whitelist means adding it
 * here too.
 */

import apiClient, { toApiError, unwrap, type Envelope } from './client';
import { configApi } from './config.api';
import {
  CONDITION_OPERATORS,
  STATUS_CATEGORY_META,
  STATUS_CATEGORY_ORDER,
  type ConditionIssue,
  type ConditionNode,
  type ConditionTrace,
  type FieldBody,
  type Operator,
  type PriorityMatrixBody,
  type RuleBody,
  type StateMachineBody,
  type StatusCategory,
} from '@oblidesk/shared';

// ═════════════════════════════════════════════════════════════════════════════
// The wire shapes (server: routes/rules.routes.ts → toWire)
// ═════════════════════════════════════════════════════════════════════════════

/** The engine's trigger vocabulary — `RULE_TRIGGERS` in rule.service.ts. */
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

/** French label + i18n key per trigger, so no screen invents its own wording. */
export const TRIGGER_LABELS: Readonly<Record<RuleTriggerKind, { key: string; fr: string }>> = {
  ticket_created: { key: 'rules.trigger.ticketCreated', fr: 'À la création du ticket' },
  ticket_updated: { key: 'rules.trigger.ticketUpdated', fr: 'À la modification du ticket' },
  status_changed: { key: 'rules.trigger.statusChanged', fr: 'Au changement de statut' },
  assignment_changed: { key: 'rules.trigger.assignmentChanged', fr: "Au changement d'affectation" },
  journal_added: { key: 'rules.trigger.journalAdded', fr: 'À chaque entrée de journal' },
  sla_warning: { key: 'rules.trigger.slaWarning', fr: 'À la pré-alerte SLA' },
  sla_breached: { key: 'rules.trigger.slaBreached', fr: 'Au dépassement de SLA' },
  approval_decided: { key: 'rules.trigger.approvalDecided', fr: "À la décision d'approbation" },
  alert_received: { key: 'rules.trigger.alertReceived', fr: "À la réception d'une alerte" },
  mail_received: { key: 'rules.trigger.mailReceived', fr: "À la réception d'un e-mail" },
  schedule: { key: 'rules.trigger.schedule', fr: 'Sur planification' },
  manual: { key: 'rules.trigger.manual', fr: 'Manuellement, par un agent' },
};

export type ActionParamType =
  | 'string'
  | 'text'
  | 'template'
  | 'number'
  | 'boolean'
  | 'slug'
  | 'username'
  | 'group_slug'
  | 'enum'
  | 'string_list'
  | 'map'
  | 'json'
  | 'ticket_number'
  | 'minutes';

export interface Localized {
  en: string;
  fr: string;
}

export interface ActionParamSpec {
  name: string;
  type: ActionParamType;
  required: boolean;
  /** The config kind a slug parameter must resolve to; null = a database row. */
  referenceKind?: string | null;
  enumValues?: readonly string[];
  aliases?: readonly string[];
  defaultValue?: unknown;
  label: Localized;
  labelKey: string;
  help: Localized;
}

export interface RuleActionDefinition {
  kind: string;
  group: 'ticket' | 'routing' | 'people' | 'timeline' | 'engine' | 'relation' | 'external';
  label: Localized;
  labelKey: string;
  summary: Localized;
  params: ActionParamSpec[];
  mutatesTicket: boolean;
  /** Can re-enter the engine — the loop-depth guard exists for these. */
  reentrant: boolean;
  budgetCost: number;
  aliases: string[];
}

export interface RuleGuardrails {
  maxLoopDepth: number;
  actionBudget: number;
  breakerThreshold: number;
  cacheTtlMs: number;
  scheduleTicketLimit: number;
}

/** Everything wrong with a body that did not stop it loading. */
export interface RuleIssue {
  index: number;
  actionType: string;
  param?: string;
  code:
    | 'unknown_action'
    | 'malformed_action'
    | 'missing_param'
    | 'bad_param'
    | 'forbidden_param'
    | 'ignored_param';
  message: string;
}

export interface RuleBreakerState {
  failures: number;
  /** Non-null while the rule is switched off BY THE BREAKER, not by an admin. */
  openedAt: string | null;
  lastError: string | null;
  version: number;
  hydrated: boolean;
}

export interface RuleHealth {
  slug: string;
  runs: number;
  matches: number;
  errors: number;
  lastRunAt: string | null;
  lastErrorAt: string | null;
  breaker: RuleBreakerState | null;
}

export interface RuleAction {
  index: number;
  kind: string;
  params: Record<string, unknown>;
  disabled: boolean;
}

export interface RuleSchedule {
  everyMinutes: number | null;
  cron: string | null;
  calendarSlug: string | null;
}

/** One rule, as the engine sees it. */
export interface RuleSummary {
  slug: string;
  name: string;
  version: number;
  bodyFormatVersion: number;
  /** Lower runs first. THE semantics of the list. */
  order: number;
  enabled: boolean;
  dryRun: boolean;
  stopProcessing: boolean;
  runOnce: boolean;
  cooldownMinutes: number | null;
  triggers: RuleTriggerKind[];
  triggerFields: string[];
  when: ConditionNode | null;
  schedule: RuleSchedule | null;
  /** Pushed down from the master tenant — editable only there. */
  shared: boolean;
  actions: RuleAction[];
  issues: RuleIssue[];
  breaker: RuleBreakerState | null;
  health?: RuleHealth | null;
}

export interface RuleDetail extends RuleSummary {
  recentExecutions: ExecutionRow[];
}

export interface RuleListResult {
  rules: RuleSummary[];
  guardrails: RuleGuardrails | null;
}

export interface ReorderOutcome {
  slug: string;
  order: number;
  applied: boolean;
  /** `not_found`, `shared`, `forbidden` — why one row refused to move. */
  reason?: string;
}

export interface ReorderResult {
  outcomes: ReorderOutcome[];
  rules: RuleSummary[];
}

// ── The execution log ────────────────────────────────────────────────────────

export type ExecutionEntry =
  | {
    entry: 'evaluation';
    matched: boolean;
    summary: string;
    /** Everything the evaluator could not answer — the same shape it emits. */
    issues: ConditionIssue[];
    trace: ConditionTrace | null;
  }
  | {
    entry: 'action';
    index: number;
    kind: string;
    performed: boolean;
    skipped?: string;
    error?: string;
    detail: Record<string, unknown>;
    durationMs: number;
  }
  | { entry: 'guardrail'; code: string; message: string; detail: Record<string, unknown> }
  | { entry: 'config'; issues: RuleIssue[] };

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
  entries: ExecutionEntry[];
}

export interface ExecutionsQuery {
  ruleSlug?: string;
  ticketId?: number;
  matched?: boolean;
  /** Simulations are excluded by default — they are not what the desk DID. */
  dryRun?: boolean;
  errorsOnly?: boolean;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface ExecutionPage {
  rows: ExecutionRow[];
  total: number;
  page: number;
  limit: number;
}

// ── The simulator ────────────────────────────────────────────────────────────

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
  /** True for the unpublished body under test. */
  candidate: boolean;
  evaluated: number;
  matched: number;
  actionsPerformed: number;
  actionsSkipped: number;
  errors: number;
  /** reason → count: the answer to "why did it not fire on those 180?". */
  skipReasons: Record<string, number>;
  configIssues: RuleIssue[];
}

export interface SimulationResultData {
  dryRun: true;
  trigger: RuleTriggerKind;
  sampleSize: number;
  ticketsExamined: number;
  ticketsAffected: number;
  byRule: SimulatedRuleSummary[];
  changes: SimulatedTicket[];
  guardrails: string[];
  /** Honest limits of a snapshot replay — shown, never hidden. */
  caveats: string[];
  durationMs: number;
  executionsRecorded: number;
}

export interface SimulateRequest {
  ruleSlugs?: string[];
  candidate?: { slug: string; name?: string; body: Record<string, unknown> };
  sampleSize?: number;
  trigger?: RuleTriggerKind;
  filter?: ConditionNode | null;
  queueSlugs?: string[];
  statusCategories?: StatusCategory[];
  createdFrom?: string;
  createdTo?: string;
  recordLog?: boolean;
}

/** The simulator's own ceiling — `MAX_SAMPLE_SIZE` / `DEFAULT_SAMPLE_SIZE`. */
export const MAX_SAMPLE_SIZE = 1000;
export const DEFAULT_SAMPLE_SIZE = 200;

// ═════════════════════════════════════════════════════════════════════════════
// The draft — what the editor edits
// ═════════════════════════════════════════════════════════════════════════════

export interface DraftAction {
  /** Stable across reorders, so React keys survive a drag. Not persisted. */
  uid: string;
  kind: string;
  params: Record<string, unknown>;
  disabled: boolean;
}

export interface RuleDraft {
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Evaluate, log, perform nothing. The safe way onto a live desk. */
  dryRun: boolean;
  stopProcessing: boolean;
  runOnce: boolean;
  cooldownMinutes: number | null;
  order: number;
  triggers: RuleTriggerKind[];
  /** For `ticket_updated`: only fire when one of these columns changed. */
  triggerFields: string[];
  when: ConditionNode | null;
  actions: DraftAction[];
  schedule: RuleSchedule | null;
}

let uidCounter = 0;
/** Local identity for a draft action. Never written to the body. */
export function newActionUid(): string {
  uidCounter += 1;
  return `a${uidCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyDraft(): RuleDraft {
  return {
    slug: '',
    name: '',
    description: '',
    enabled: true,
    // A brand-new rule starts in dry run. Somebody authoring their first rule
    // on a live desk should have to switch it on deliberately, having seen a
    // simulation, rather than discover it working on real tickets.
    dryRun: true,
    stopProcessing: false,
    runOnce: false,
    cooldownMinutes: null,
    order: 1000,
    triggers: ['ticket_created'],
    triggerFields: [],
    when: { all: [] },
    actions: [],
    schedule: null,
  };
}

export function draftFromRule(rule: RuleSummary, description = ''): RuleDraft {
  return {
    slug: rule.slug,
    name: rule.name,
    description,
    enabled: rule.enabled,
    dryRun: rule.dryRun,
    stopProcessing: rule.stopProcessing,
    runOnce: rule.runOnce,
    cooldownMinutes: rule.cooldownMinutes,
    order: rule.order,
    triggers: [...rule.triggers],
    triggerFields: [...rule.triggerFields],
    when: rule.when,
    actions: rule.actions.map((action) => ({
      uid: newActionUid(),
      kind: action.kind,
      params: { ...action.params },
      disabled: action.disabled,
    })),
    schedule: rule.schedule ? { ...rule.schedule } : null,
  };
}

/**
 * The draft, in the ONE dialect `normalizeRule()` reads.
 *
 * Every key here is one the engine looks for by that exact name — `triggers`,
 * `triggerFields`, `when`, `actions[].type`, `order`, `cooldownMinutes`,
 * `dryRun`, `stopProcessing`, `runOnce`, `schedule`. The engine also accepts a
 * snake_case dialect from the shipped baseline; we deliberately write only one
 * of them, because a body carrying both spellings is a body where the two can
 * disagree.
 *
 * `actions[].type` carries the ENGINE's action kind (`post_work_note`,
 * `transition_to`, …) rather than the older `RuleActionType` union in
 * `@oblidesk/shared`. The catalogue served by `GET /api/rules/actions` is the
 * authority on what can actually be performed; that union is the older
 * vocabulary a body may be written in, and the two overlap without being equal.
 */
export function draftToBody(draft: RuleDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    enabled: draft.enabled,
    order: draft.order,
    triggers: [...draft.triggers],
    when: draft.when,
    actions: draft.actions.map((action) => ({
      type: action.kind,
      params: action.params,
      disabled: action.disabled,
    })),
    dryRun: draft.dryRun,
    stopProcessing: draft.stopProcessing,
    runOnce: draft.runOnce,
  };

  if (draft.triggerFields.length > 0) body.triggerFields = [...draft.triggerFields];
  if (draft.cooldownMinutes && draft.cooldownMinutes > 0) body.cooldownMinutes = draft.cooldownMinutes;
  if (draft.triggers.includes('schedule') && draft.schedule) body.schedule = { ...draft.schedule };

  return body;
}

/** Local structural findings — shown before the server is asked anything. */
export interface DraftFinding {
  severity: 'error' | 'warning';
  messageKey: string;
  message: string;
  /** `slug`, `triggers`, `actions`, `actions.3.queue_slug`… */
  path: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Cheap, local checks — NOT a second linter.
 *
 * The blocking authority is `configLinter.service.ts` at publish time, and this
 * function deliberately does not try to reproduce it: it checks the four things
 * a user can see are wrong without asking a server (a missing slug, no trigger,
 * no action, a schedule with no interval), and lets the real linter answer
 * everything else. Two linters disagreeing is worse than one being slow.
 */
export function reviewDraft(draft: RuleDraft): DraftFinding[] {
  const findings: DraftFinding[] = [];

  if (!draft.slug.trim()) {
    findings.push({
      severity: 'error',
      path: 'slug',
      messageKey: 'rules.finding.slugRequired',
      message: 'Une règle a besoin d’un identifiant (slug) : c’est par lui que tout la référence.',
    });
  } else if (!SLUG_RE.test(draft.slug.trim())) {
    findings.push({
      severity: 'error',
      path: 'slug',
      messageKey: 'rules.finding.slugShape',
      message: 'Le slug accepte minuscules, chiffres, tiret et souligné, en commençant par une lettre ou un chiffre.',
    });
  }

  if (!draft.name.trim()) {
    findings.push({
      severity: 'warning',
      path: 'name',
      messageKey: 'rules.finding.nameRequired',
      message: 'Sans nom lisible, la liste ordonnée ne se lit plus.',
    });
  }

  if (draft.triggers.length === 0) {
    findings.push({
      severity: 'error',
      path: 'triggers',
      messageKey: 'rules.finding.noTrigger',
      message: 'Une règle sans déclencheur ne sera jamais évaluée.',
    });
  }

  if (draft.actions.length === 0) {
    findings.push({
      severity: 'error',
      path: 'actions',
      messageKey: 'rules.finding.noAction',
      message: 'Une règle sans action peut correspondre, mais ne fera rien.',
    });
  } else if (draft.actions.every((action) => action.disabled)) {
    findings.push({
      severity: 'warning',
      path: 'actions',
      messageKey: 'rules.finding.allActionsDisabled',
      message: 'Toutes les actions sont désactivées : la règle tournera pour rien.',
    });
  }

  if (draft.triggers.includes('schedule')) {
    const everyMinutes = draft.schedule?.everyMinutes ?? null;
    const cron = draft.schedule?.cron ?? null;
    if (!everyMinutes && !cron) {
      findings.push({
        severity: 'error',
        path: 'schedule',
        messageKey: 'rules.finding.scheduleEmpty',
        message: 'Un déclencheur planifié demande un intervalle en minutes ou une expression cron.',
      });
    }
  }

  return findings;
}

// ═════════════════════════════════════════════════════════════════════════════
// The field catalogue — what a ConditionNode leaf may name
// ═════════════════════════════════════════════════════════════════════════════

export type FieldValueKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'enum'
  | 'slug'
  | 'list'
  | 'json';

export interface FieldChoice {
  value: string;
  label: string;
}

export interface FieldDescriptor {
  /** The leaf's `field` — exactly what the server's whitelist resolves. */
  path: string;
  label: string;
  labelKey?: string;
  kind: FieldValueKind;
  /** Section heading in the picker. Already French. */
  group: string;
  groupKey: string;
  /** Closed value list, when there is one. Drives a select instead of a box. */
  choices?: FieldChoice[];
  help?: string;
}

export interface FieldCatalogue {
  fields: FieldDescriptor[];
  /** Path → descriptor, for labelling a tree whose author picked from an older set. */
  byPath: Map<string, FieldDescriptor>;
}

const GROUP_TICKET = { key: 'rules.fieldGroup.ticket', fr: 'Ticket' };
const GROUP_PEOPLE = { key: 'rules.fieldGroup.people', fr: 'Personnes et affectation' };
const GROUP_TIME = { key: 'rules.fieldGroup.time', fr: 'Dates' };
const GROUP_CUSTOM = { key: 'rules.fieldGroup.custom', fr: 'Champs personnalisés' };
const GROUP_CONTEXT = { key: 'rules.fieldGroup.context', fr: 'Contexte calculé' };
const GROUP_ACTOR = { key: 'rules.fieldGroup.actor', fr: 'Auteur de l’action' };

interface StaticField {
  path: string;
  fr: string;
  key: string;
  kind: FieldValueKind;
  group: { key: string; fr: string };
  help?: string;
}

/**
 * MIRROR of `TICKET_FIELDS` in `server/src/services/stateMachine.service.ts`.
 *
 * Every path here is one `resolveTicketFieldPath()` accepts in its bare
 * spelling (the engine registers both `subject` and `ticket.subject`; the bare
 * form is what the shipped bodies and `@oblidesk/shared` document, so it is
 * what the picker writes). If the server's list changes, this one must follow —
 * see the file header.
 */
const TICKET_FIELD_PATHS: readonly StaticField[] = [
  { path: 'subject', fr: 'Objet', key: 'field.subject', kind: 'string', group: GROUP_TICKET },
  { path: 'description_md', fr: 'Description', key: 'field.description', kind: 'string', group: GROUP_TICKET },
  { path: 'number', fr: 'Numéro', key: 'field.number', kind: 'string', group: GROUP_TICKET },
  { path: 'record_type', fr: 'Type d’enregistrement', key: 'field.recordType', kind: 'enum', group: GROUP_TICKET },
  { path: 'status_slug', fr: 'Statut', key: 'field.status', kind: 'enum', group: GROUP_TICKET },
  {
    path: 'status_category',
    fr: 'Catégorie de statut',
    key: 'field.statusCategory',
    kind: 'enum',
    group: GROUP_TICKET,
    help: 'Les moteurs raisonnent sur la CATÉGORIE, jamais sur le slug du statut.',
  },
  { path: 'priority_slug', fr: 'Priorité', key: 'field.priority', kind: 'enum', group: GROUP_TICKET },
  { path: 'impact', fr: 'Impact', key: 'field.impact', kind: 'enum', group: GROUP_TICKET },
  { path: 'urgency', fr: 'Urgence', key: 'field.urgency', kind: 'enum', group: GROUP_TICKET },
  { path: 'queue_slug', fr: 'File', key: 'field.queue', kind: 'enum', group: GROUP_TICKET },
  { path: 'source', fr: 'Canal d’origine', key: 'field.source', kind: 'enum', group: GROUP_TICKET },
  { path: 'resolution_code', fr: 'Code de résolution', key: 'field.resolutionCode', kind: 'string', group: GROUP_TICKET },
  { path: 'resolution_md', fr: 'Notes de résolution', key: 'field.resolutionNotes', kind: 'string', group: GROUP_TICKET },
  { path: 'reopen_count', fr: 'Nombre de réouvertures', key: 'field.reopenCount', kind: 'number', group: GROUP_TICKET },
  { path: 'csat_score', fr: 'Note de satisfaction', key: 'field.csat', kind: 'number', group: GROUP_TICKET },

  { path: 'assignee_id', fr: 'Responsable', key: 'field.assignee', kind: 'number', group: GROUP_PEOPLE },
  { path: 'assignment_group_id', fr: 'Groupe d’affectation', key: 'field.assignmentGroup', kind: 'number', group: GROUP_PEOPLE },
  { path: 'requester_contact_id', fr: 'Demandeur (contact)', key: 'field.requesterContact', kind: 'number', group: GROUP_PEOPLE },
  { path: 'requester_user_id', fr: 'Demandeur (agent)', key: 'field.requesterUser', kind: 'number', group: GROUP_PEOPLE },
  { path: 'organization_id', fr: 'Organisation', key: 'field.organization', kind: 'number', group: GROUP_PEOPLE },
  { path: 'primary_ci_id', fr: 'Élément de configuration', key: 'field.primaryCi', kind: 'number', group: GROUP_PEOPLE },
  { path: 'parent_ticket_id', fr: 'Ticket parent', key: 'field.parentTicket', kind: 'number', group: GROUP_PEOPLE },

  {
    path: 'occurred_at',
    fr: 'Date de survenue',
    key: 'field.occurredAt',
    kind: 'timestamp',
    group: GROUP_TIME,
    help: 'L’instant où l’incident a eu lieu — distinct de la date de création.',
  },
  { path: 'created_at', fr: 'Date de création', key: 'field.createdAt', kind: 'timestamp', group: GROUP_TIME },
  { path: 'updated_at', fr: 'Dernière modification', key: 'field.updatedAt', kind: 'timestamp', group: GROUP_TIME },
  { path: 'first_response_at', fr: 'Première réponse', key: 'field.firstResponseAt', kind: 'timestamp', group: GROUP_TIME },
  { path: 'resolved_at', fr: 'Résolu le', key: 'field.resolvedAt', kind: 'timestamp', group: GROUP_TIME },
  { path: 'closed_at', fr: 'Clos le', key: 'field.closedAt', kind: 'timestamp', group: GROUP_TIME },
  { path: 'due_at', fr: 'Échéance', key: 'field.dueAt', kind: 'timestamp', group: GROUP_TIME },
];

/**
 * `context.*` — true ABOUT a ticket without being a column.
 *
 * Mirrors `buildExtras()` in `rule.service.ts`. The engine computes each one
 * LAZILY, only when a loaded rule's condition mentions it, so naming one here
 * costs nothing until somebody uses it.
 */
const CONTEXT_FIELDS: readonly StaticField[] = [
  { path: 'context.minutes_since_created', fr: 'Minutes depuis la création', key: 'context.minutesSinceCreated', kind: 'number', group: GROUP_CONTEXT },
  { path: 'context.minutes_since_updated', fr: 'Minutes depuis la modification', key: 'context.minutesSinceUpdated', kind: 'number', group: GROUP_CONTEXT },
  { path: 'context.minutes_since_occurred', fr: 'Minutes depuis la survenue', key: 'context.minutesSinceOccurred', kind: 'number', group: GROUP_CONTEXT },
  { path: 'context.minutes_since_first_response', fr: 'Minutes depuis la première réponse', key: 'context.minutesSinceFirstResponse', kind: 'number', group: GROUP_CONTEXT },
  {
    path: 'context.business_minutes_since_created',
    fr: 'Minutes ouvrées depuis la création',
    key: 'context.businessMinutesSinceCreated',
    kind: 'number',
    group: GROUP_CONTEXT,
    help: 'Comptées sur le calendrier ouvré par défaut du locataire.',
  },
  { path: 'context.business_minutes_since_updated', fr: 'Minutes ouvrées depuis la modification', key: 'context.businessMinutesSinceUpdated', kind: 'number', group: GROUP_CONTEXT },
  { path: 'context.business_minutes_in_status', fr: 'Minutes ouvrées dans le statut', key: 'context.businessMinutesInStatus', kind: 'number', group: GROUP_CONTEXT },
  { path: 'context.public_reply_count', fr: 'Nombre de réponses publiques', key: 'context.publicReplyCount', kind: 'number', group: GROUP_CONTEXT },
  { path: 'context.watcher_count', fr: 'Nombre d’observateurs', key: 'context.watcherCount', kind: 'number', group: GROUP_CONTEXT },
  { path: 'context.open_approval_count', fr: 'Approbations en attente', key: 'context.openApprovalCount', kind: 'number', group: GROUP_CONTEXT },
];

/** `actor.*` — who is doing the thing that fired the rule. */
const ACTOR_FIELDS: readonly StaticField[] = [
  { path: 'actor.username', fr: 'Identifiant de l’auteur', key: 'actor.username', kind: 'string', group: GROUP_ACTOR },
  { path: 'actor.type', fr: 'Type d’auteur', key: 'actor.type', kind: 'enum', group: GROUP_ACTOR },
  { path: 'actor.role', fr: 'Rôle de l’auteur', key: 'actor.role', kind: 'string', group: GROUP_ACTOR },
  { path: 'actor.is_admin', fr: 'L’auteur est administrateur', key: 'actor.isAdmin', kind: 'boolean', group: GROUP_ACTOR },
  { path: 'actor.capabilities', fr: 'Capacités de l’auteur', key: 'actor.capabilities', kind: 'list', group: GROUP_ACTOR },
];

const ACTOR_TYPE_CHOICES: FieldChoice[] = [
  { value: 'user', label: 'Agent' },
  { value: 'system', label: 'Système' },
  { value: 'rule', label: 'Règle' },
  { value: 'portal', label: 'Portail' },
  { value: 'api', label: 'API' },
];

const SOURCE_CHOICES: FieldChoice[] = [
  { value: 'web', label: 'Web' },
  { value: 'email', label: 'E-mail' },
  { value: 'phone', label: 'Téléphone' },
  { value: 'portal', label: 'Portail' },
  { value: 'alert', label: 'Alerte' },
  { value: 'api', label: 'API' },
  { value: 'chat', label: 'Chat' },
];

const IMPACT_URGENCY_CHOICES: FieldChoice[] = [
  { value: 'high', label: 'Élevé' },
  { value: 'medium', label: 'Moyen' },
  { value: 'low', label: 'Faible' },
];

/** Custom-field type → how a condition compares it. */
function kindForFieldType(type: FieldBody['type']): FieldValueKind {
  switch (type) {
    case 'number':
    case 'currency':
    case 'duration':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
    case 'datetime':
      return 'timestamp';
    case 'select':
      return 'enum';
    case 'multiselect':
      return 'list';
    case 'json':
    case 'attachment':
      return 'json';
    case 'user':
    case 'group':
    case 'contact':
    case 'organization':
    case 'ci':
    case 'ticket':
      return 'slug';
    default:
      return 'string';
  }
}

function descriptor(entry: StaticField, choices?: FieldChoice[]): FieldDescriptor {
  return {
    path: entry.path,
    label: entry.fr,
    labelKey: entry.key,
    kind: entry.kind,
    group: entry.group.fr,
    groupKey: entry.group.key,
    choices,
    help: entry.help,
  };
}

/**
 * Build the picker's field list: the mirrored server whitelist, plus this
 * tenant's published statuses, priorities, queues and custom fields so the
 * value side of a leaf is a choice rather than a typed guess.
 *
 * Configuration reads are best-effort: a tenant with no published state machine
 * still gets a working builder, it just types its status slugs by hand. Failing
 * the whole screen because one optional enrichment 404'd would be the wrong
 * trade.
 */
export async function loadFieldCatalogue(): Promise<FieldCatalogue> {
  const [fieldObjects, queueObjects, matrixObjects, machineObjects] = await Promise.all([
    configApi.listKind('field', { status: 'published', limit: 200 }).then((r) => r.objects).catch(() => []),
    configApi.listKind('queue', { status: 'published', limit: 200 }).then((r) => r.objects).catch(() => []),
    configApi.listKind('priority_matrix', { status: 'published', limit: 20 }).then((r) => r.objects).catch(() => []),
    configApi.listKind('state_machine', { status: 'published', limit: 50 }).then((r) => r.objects).catch(() => []),
  ]);

  const statusChoices: FieldChoice[] = [];
  const seenStatus = new Set<string>();
  for (const machine of machineObjects) {
    const body = machine.body as unknown as StateMachineBody | null;
    for (const status of body?.statuses ?? []) {
      if (!status?.slug || seenStatus.has(status.slug)) continue;
      seenStatus.add(status.slug);
      statusChoices.push({ value: status.slug, label: status.label || status.slug });
    }
  }

  const priorityChoices: FieldChoice[] = [];
  const seenPriority = new Set<string>();
  for (const matrix of matrixObjects) {
    const body = matrix.body as unknown as PriorityMatrixBody | null;
    for (const priority of body?.priorities ?? []) {
      if (!priority?.slug || seenPriority.has(priority.slug)) continue;
      seenPriority.add(priority.slug);
      priorityChoices.push({ value: priority.slug, label: priority.label || priority.slug });
    }
  }

  const queueChoices: FieldChoice[] = queueObjects.map((queue) => ({
    value: queue.slug,
    label: queue.name || queue.slug,
  }));

  const categoryChoices: FieldChoice[] = STATUS_CATEGORY_ORDER.map((category) => ({
    value: category,
    label: STATUS_CATEGORY_META[category].label,
  }));

  const choicesByPath: Record<string, FieldChoice[] | undefined> = {
    status_slug: statusChoices.length > 0 ? statusChoices : undefined,
    status_category: categoryChoices,
    priority_slug: priorityChoices.length > 0 ? priorityChoices : undefined,
    queue_slug: queueChoices.length > 0 ? queueChoices : undefined,
    impact: IMPACT_URGENCY_CHOICES,
    urgency: IMPACT_URGENCY_CHOICES,
    source: SOURCE_CHOICES,
    'actor.type': ACTOR_TYPE_CHOICES,
  };

  const fields: FieldDescriptor[] = [
    ...TICKET_FIELD_PATHS.map((entry) => descriptor(entry, choicesByPath[entry.path])),
    ...CONTEXT_FIELDS.map((entry) => descriptor(entry)),
    ...ACTOR_FIELDS.map((entry) => descriptor(entry, choicesByPath[entry.path])),
  ];

  for (const object of fieldObjects) {
    const body = object.body as unknown as FieldBody | null;
    if (!body?.key) continue;
    fields.push({
      path: `data.${body.key}`,
      label: body.label || object.name || body.key,
      labelKey: body.labelKey,
      kind: kindForFieldType(body.type),
      group: GROUP_CUSTOM.fr,
      groupKey: GROUP_CUSTOM.key,
      choices: body.options?.map((option) => ({
        value: String(option.value),
        label: option.label || String(option.value),
      })),
      help: body.helpText,
    });
  }

  const byPath = new Map<string, FieldDescriptor>();
  for (const field of fields) byPath.set(field.path, field);

  return { fields, byPath };
}

// ── Operators a field's type actually supports ──────────────────────────────

const OPERATORS_BY_KIND: Readonly<Record<FieldValueKind, readonly Operator[]>> = {
  string: [
    'eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'starts_with', 'ends_with',
    'matches', 'is_empty', 'is_not_empty', 'changed', 'changed_to', 'changed_from',
  ],
  slug: ['eq', 'neq', 'in', 'not_in', 'is_empty', 'is_not_empty', 'changed', 'changed_to', 'changed_from'],
  enum: ['eq', 'neq', 'in', 'not_in', 'is_empty', 'is_not_empty', 'changed', 'changed_to', 'changed_from'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_empty', 'is_not_empty', 'changed'],
  boolean: ['eq', 'neq', 'is_empty', 'is_not_empty', 'changed'],
  timestamp: ['older_than', 'newer_than', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty', 'changed'],
  list: ['contains', 'not_contains', 'in', 'not_in', 'is_empty', 'is_not_empty', 'changed'],
  json: ['is_empty', 'is_not_empty', 'eq', 'neq', 'changed'],
};

/**
 * Which operators make sense on this field.
 *
 * Unknown fields (a tree authored against a field that has since been deleted,
 * or a path this mirror does not know) get the FULL list rather than an empty
 * one: refusing to render an operator the tree already contains would silently
 * rewrite somebody's condition the moment they opened it.
 */
export function operatorsForField(field: FieldDescriptor | undefined): readonly Operator[] {
  if (!field) return CONDITION_OPERATORS;
  return OPERATORS_BY_KIND[field.kind] ?? CONDITION_OPERATORS;
}

/** French phrasing for an operator, paired with its key for `t()`. */
export const OPERATOR_LABELS: Readonly<Record<Operator, string>> = {
  eq: 'est',
  neq: 'n’est pas',
  in: 'est parmi',
  not_in: 'n’est pas parmi',
  gt: 'est supérieur à',
  gte: 'est au moins',
  lt: 'est inférieur à',
  lte: 'est au plus',
  contains: 'contient',
  not_contains: 'ne contient pas',
  starts_with: 'commence par',
  ends_with: 'finit par',
  is_empty: 'est vide',
  is_not_empty: 'n’est pas vide',
  changed: 'a changé',
  changed_to: 'est passé à',
  changed_from: 'était',
  older_than: 'est plus ancien que',
  newer_than: 'est plus récent que',
  matches: 'correspond au motif',
};

// ═════════════════════════════════════════════════════════════════════════════
// API
// ═════════════════════════════════════════════════════════════════════════════

interface RuleListEnvelope extends Envelope<RuleSummary[]> {
  total?: number;
  guardrails?: RuleGuardrails;
}

interface ExecutionEnvelope extends Envelope<ExecutionRow[]> {
  total?: number;
  page?: number;
  limit?: number;
}

export const rulesApi = {
  /**
   * The ordered list, exactly as the engine runs it.
   *
   * `withHealth` costs one extra query and buys the only honest answer to "is
   * it safe to change this?" — what the rule has actually done lately.
   */
  async list(params: {
    trigger?: RuleTriggerKind;
    includeDisabled?: boolean;
    withHealth?: boolean;
    healthWindowDays?: number;
  } = {}): Promise<RuleListResult> {
    // Same `z.coerce.boolean()` trap as `executions()` below: a literal
    // "false" reaches the server as true, so a false flag travels empty.
    const query: Record<string, string> = {};
    if (params.trigger) query.trigger = params.trigger;
    if (params.includeDisabled !== undefined) query.includeDisabled = params.includeDisabled ? 'true' : '';
    if (params.withHealth !== undefined) query.withHealth = params.withHealth ? 'true' : '';
    if (params.healthWindowDays !== undefined) query.healthWindowDays = String(params.healthWindowDays);

    try {
      const res = await apiClient.get<RuleListEnvelope>('/rules', { params: query });
      return {
        rules: unwrap<RuleSummary[]>(res.data) ?? [],
        guardrails: res.data.guardrails ?? null,
      };
    } catch (error) {
      throw toApiError(error);
    }
  },

  async get(slug: string): Promise<RuleDetail> {
    try {
      const res = await apiClient.get<Envelope<RuleDetail>>(`/rules/${encodeURIComponent(slug)}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Rewrite the order — the WHOLE list, never a set of pairs.
   *
   * Two admins dragging rows at the same time with pairwise positions produce
   * an order neither of them chose. A whole-list write means the second one
   * simply wins, and `outcomes` lets the screen say which rows refused to move.
   */
  async reorder(order: string[]): Promise<ReorderResult> {
    try {
      const res = await apiClient.post<Envelope<ReorderResult>>('/rules', { order });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** The closed catalogue with its parameter schemas. Cached by the caller. */
  async actions(): Promise<{ actions: RuleActionDefinition[]; guardrails: RuleGuardrails }> {
    try {
      const res = await apiClient.get<Envelope<{ actions: RuleActionDefinition[]; guardrails: RuleGuardrails }>>(
        '/rules/actions',
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * The execution log.
   *
   * The boolean filters are serialised by hand rather than through `toQuery`,
   * and that is not fussiness. `executionsQuerySchema` parses them with
   * `z.coerce.boolean()`, and `Boolean("false") === true` — so sending the
   * obvious `matched=false` asks for exactly the opposite of what it says. The
   * only wire spelling that coerces to false is an EMPTY value, which
   * `toQuery` (correctly, for every other endpoint) drops.
   *
   * `dryRun` has a second wrinkle: the route substitutes `false` when the
   * parameter is absent, so "real runs" is the default and there is no way to
   * ask for both at once. The UI offers the two the API can actually answer.
   */
  async executions(query: ExecutionsQuery = {}): Promise<ExecutionPage> {
    const params: Record<string, string> = {};
    if (query.ruleSlug) params.ruleSlug = query.ruleSlug;
    if (query.ticketId !== undefined) params.ticketId = String(query.ticketId);
    if (query.matched !== undefined) params.matched = query.matched ? 'true' : '';
    if (query.dryRun !== undefined) params.dryRun = query.dryRun ? 'true' : '';
    if (query.errorsOnly !== undefined) params.errorsOnly = query.errorsOnly ? 'true' : '';
    if (query.from) params.from = query.from;
    if (query.to) params.to = query.to;
    if (query.page !== undefined) params.page = String(query.page);
    if (query.limit !== undefined) params.limit = String(query.limit);

    try {
      const res = await apiClient.get<ExecutionEnvelope>('/rules/executions', { params });
      const rows = unwrap<ExecutionRow[]>(res.data) ?? [];
      return {
        rows,
        total: res.data.total ?? rows.length,
        page: res.data.page ?? 1,
        limit: res.data.limit ?? rows.length,
      };
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * The dry run, over the tenant's own recent tickets.
   *
   * Slow by nature — real rules over real tickets, one rolled-back transaction
   * each — so callers show progress rather than a spinner that looks stuck.
   */
  async simulate(request: SimulateRequest): Promise<SimulationResultData> {
    try {
      const res = await apiClient.post<Envelope<SimulationResultData>>('/rules/simulate', request);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async setEnabled(slug: string, enabled: boolean, reason?: string): Promise<{
    slug: string;
    enabled: boolean;
    version: number;
    status: string;
  }> {
    try {
      const res = await apiClient.post<Envelope<{ slug: string; enabled: boolean; version: number; status: string }>>(
        `/rules/${encodeURIComponent(slug)}/${enabled ? 'enable' : 'disable'}`,
        reason ? { reason } : {},
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** "I fixed it, try again" — close a tripped circuit breaker. */
  async resetBreaker(slug: string): Promise<void> {
    try {
      await apiClient.post(`/rules/${encodeURIComponent(slug)}/reset-breaker`, {});
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Authoring, through the config store ──────────────────────────────────

  /**
   * Create or update the rule's config object, then publish it.
   *
   * Publishing runs the linter first; a blocking finding comes back as a 422
   * carrying `issues[]`, which is an ANSWER, not a failure to retry. The caller
   * shows those findings and leaves the draft on screen.
   */
  async save(draft: RuleDraft, options: { create?: boolean; note?: string; publish?: boolean } = {}) {
    const body = draftToBody(draft) as unknown as RuleBody;
    const publish = options.publish !== false;
    try {
      if (options.create) {
        await configApi.create<'rule'>({
          kind: 'rule',
          slug: draft.slug,
          name: draft.name || draft.slug,
          description: draft.description || null,
          body,
        });
      } else {
        await configApi.update<'rule'>('rule', draft.slug, {
          name: draft.name || draft.slug,
          description: draft.description || null,
          body,
          note: options.note,
        });
      }
      return publish ? await configApi.publish<'rule'>('rule', draft.slug, options.note) : null;
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** The stored object — the source of the description and the version history. */
  async configObject(slug: string) {
    try {
      return await configApi.get<'rule'>('rule', slug);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Archive rather than delete: the history and the executions survive. */
  async archive(slug: string): Promise<void> {
    try {
      await configApi.archive('rule', slug);
    } catch (error) {
      throw toApiError(error);
    }
  },
};

export default rulesApi;
