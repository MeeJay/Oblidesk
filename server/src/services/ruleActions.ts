/**
 * ruleActions.ts — THE closed action catalogue, and the one executor that
 * performs them.
 *
 * ── Why a closed list, and why it stays closed ──────────────────────────────
 * A rule may COMPUTE a value — a default, a rendered template, an approver, a
 * queue picked out of a map — but it may never express a STATEMENT that
 * performs something. There is no scripting hook here and there will not be
 * one. That single line is what keeps three other features possible:
 *
 *   • SIMULATION. `ruleSimulator.service.ts` replays real tickets through the
 *     executor below with `dryRun`. A scripted action could open a socket or
 *     charge a card; an enumerated one declares what it touches, so the
 *     simulator can shadow it instead of doing it.
 *   • CONFIG DIFFING. `{ type, params }` diffs. A function body does not.
 *   • THE WHY DRAWER. Every action names itself, its parameters and its
 *     outcome in `rule_executions.actions`, and writes a `decision_log` row on
 *     its own code path (HARD RULE 2). "The queue changed and nobody knows
 *     why" is not a state this engine can reach.
 *
 * The moment someone adds `eval_expression` to this file, all three stop being
 * true at once — and they stop being true silently, which is the part that
 * makes it expensive.
 *
 * ── Two dialects, one normal form ───────────────────────────────────────────
 * `RuleBody` in `@oblidesk/shared` spells an action `{ type, params: {...} }`,
 * while the shipped baseline in `seeds/02_baseline_config.ts` writes its
 * parameters inline in snake_case (`{ type: 'send_notification', template: …,
 * to: [...] }`) and uses older type names (`add_journal`, `set_status`).
 * `normalizeActions()` folds both into {@link NormalizedAction}. Rejecting the
 * seeded dialect would ship a desk whose three baseline rules never fire, and
 * "the automation silently did nothing" is the failure this whole slice
 * exists to make impossible.
 *
 * ── Dry run is the same code path, not a second one ─────────────────────────
 * Every mutating action resolves everything it needs — slug → id lookups,
 * template rendering, guard checks — and only then either WRITES (live) or
 * folds the intended change into the in-memory ticket (dry). Same resolution,
 * same ordering, same guardrails, same failures; one branch at the last step.
 * Shadowing the change rather than discarding it matters: rule #7 reading a
 * priority that rule #2 set has to see the same value in a simulation that it
 * would see in production, or the simulation lies in the most reassuring
 * direction.
 */

import type { Knex } from 'knex';

import type {
  ConfigKind,
  ConditionNode,
  JournalVisibility,
  TicketWithRelations,
} from '@oblidesk/shared';

import { config } from '../config';
import { db, scoped, type Executor } from '../db';
import { logger } from '../utils/logger';

import * as approvalService from './approval.service';
import * as ticketService from './ticket.service';
import type { ActorContext } from './ticket.service';
import * as journalService from './journal.service';
import { notificationService } from './notification.service';
import { loadPublishedOne } from './configObject.service';
import { withDecision } from './decision.service';

const log = logger.child({ subsystem: 'rules' });

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — The catalogue
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The closed list. Deliberately NOT `RuleActionType` from `@oblidesk/shared`:
 * that union is the vocabulary a config body may be written in, this one is
 * the vocabulary the engine can actually perform. They overlap, they are not
 * the same thing, and conflating them is how a desk ends up shipping an action
 * type nothing implements.
 *
 * A body naming something outside this list is not silently ignored — it is
 * reported as `unknown_action` on the `rule_executions` row and by the linter.
 */
export type RuleActionKind =
  // ── the ticket row ────────────────────────────────────────────────────────
  | 'set_field'
  | 'set_priority'
  | 'transition_to'
  // ── routing ───────────────────────────────────────────────────────────────
  | 'assign_to_user'
  | 'assign_to_group'
  | 'assign_group_by_queue'
  | 'move_to_queue'
  // ── labels and people ─────────────────────────────────────────────────────
  | 'add_tag'
  | 'remove_tag'
  | 'add_watcher'
  // ── the timeline ──────────────────────────────────────────────────────────
  | 'post_public_reply'
  | 'post_work_note'
  | 'apply_macro'
  // ── the other engines ─────────────────────────────────────────────────────
  | 'send_notification'
  | 'start_sla_target'
  | 'pause_sla'
  | 'resume_sla'
  | 'escalate'
  | 'request_approval'
  // ── other tickets ─────────────────────────────────────────────────────────
  | 'link_ticket'
  | 'create_child_ticket'
  // ── outside the desk ──────────────────────────────────────────────────────
  | 'webhook_out';

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

/**
 * One parameter, described well enough that the admin UI can render a form
 * field for it and the config linter can resolve its reference — without
 * either of them hard-coding a per-action special case.
 */
export interface ActionParamSpec {
  name: string;
  type: ActionParamType;
  required: boolean;
  /**
   * HARD RULE 3 — when the value is a cross-reference it is a human SLUG, and
   * this says which config kind it must resolve to. `null` means the slug
   * names a database row (an assignment group, a status) rather than a config
   * object.
   */
  referenceKind?: ConfigKind | null;
  enumValues?: readonly string[];
  /** Spellings accepted from the seeded / snake_case dialect. */
  aliases?: readonly string[];
  defaultValue?: unknown;
  label: Localized;
  /** HARD RULE 10 — the UI translates through this; `label` is the fallback. */
  labelKey: string;
  help: Localized;
}

export interface RuleActionDefinition {
  kind: RuleActionKind;
  group: 'ticket' | 'routing' | 'people' | 'timeline' | 'engine' | 'relation' | 'external';
  label: Localized;
  labelKey: string;
  summary: Localized;
  params: readonly ActionParamSpec[];
  /**
   * Changes columns on the ticket row. Dry run shadows these so a later rule
   * in the same pass evaluates against the same state production would show.
   */
  mutatesTicket: boolean;
  /**
   * Can re-enter the engine (it calls a ticket.service door that fires the
   * rules hook). These are the ones the loop-depth guard exists for.
   */
  reentrant: boolean;
  /** Charged against the per-ticket action budget when it performs. */
  budgetCost: number;
  /** Type names accepted for this action from another dialect. */
  aliases: readonly string[];
}

const T = (en: string, fr: string): Localized => ({ en, fr });

function param(
  name: string,
  type: ActionParamType,
  required: boolean,
  label: Localized,
  labelKey: string,
  help: Localized,
  extra: Partial<ActionParamSpec> = {},
): ActionParamSpec {
  return { name, type, required, label, labelKey, help, ...extra };
}

/**
 * THE catalogue. Everything the UI, the linter and the executor know about an
 * action lives in exactly one place, so a new action cannot be half-added:
 * omit it here and it does not exist; add it here without a performer and the
 * executor fails to compile.
 */
export const RULE_ACTION_CATALOGUE: Readonly<Record<RuleActionKind, RuleActionDefinition>> = {
  set_field: {
    kind: 'set_field',
    group: 'ticket',
    label: T('Set a field', 'Définir un champ'),
    labelKey: 'rules.action.setField',
    summary: T(
      'Writes one ticket column or custom field. Never the status — that is a transition.',
      'Écrit une colonne du ticket ou un champ personnalisé. Jamais le statut : c’est une transition.',
    ),
    params: [
      param('field', 'string', true,
        T('Field', 'Champ'), 'rules.param.field',
        T('A ticket column (priority_slug) or a custom field (data.escalated).',
          'Une colonne du ticket (priority_slug) ou un champ personnalisé (data.escalated).'),
        { aliases: ['path', 'name', 'key'] }),
      param('value', 'json', true,
        T('Value', 'Valeur'), 'rules.param.value',
        T('A literal, or a template like {{ticket.number}}. An expression may RETURN a value; it may never perform an action.',
          'Une valeur littérale ou un gabarit comme {{ticket.number}}. Une expression peut RENVOYER une valeur ; jamais exécuter une action.')),
    ],
    mutatesTicket: true,
    reentrant: true,
    budgetCost: 1,
    aliases: ['set_value', 'update_field'],
  },

  set_priority: {
    kind: 'set_priority',
    group: 'ticket',
    label: T('Set the priority', 'Définir la priorité'),
    labelKey: 'rules.action.setPriority',
    summary: T(
      'Overrides the priority matrix. The reason is written to decision_log alongside the computed value.',
      'Remplace la matrice de priorité. La raison est écrite dans decision_log à côté de la valeur calculée.',
    ),
    params: [
      param('priority', 'slug', true,
        T('Priority', 'Priorité'), 'rules.param.priority',
        T('A priority slug declared by the priority matrix (p1, p2…).',
          'Un slug de priorité déclaré par la matrice de priorité (p1, p2…).'),
        { aliases: ['priority_slug', 'to', 'value'], referenceKind: null }),
      param('reason', 'string', false,
        T('Reason', 'Raison'), 'rules.param.reason',
        T('Why the matrix is being overridden. Shown in the Why drawer.',
          'Pourquoi la matrice est contournée. Affiché dans le tiroir « Pourquoi ».')),
    ],
    mutatesTicket: true,
    reentrant: true,
    budgetCost: 1,
    aliases: [],
  },

  transition_to: {
    kind: 'transition_to',
    group: 'ticket',
    label: T('Move to a status', 'Passer à un statut'),
    labelKey: 'rules.action.transitionTo',
    summary: T(
      'Goes through the state machine, so guards and required fields still apply (HARD RULE 12).',
      'Passe par la machine à états : gardes et champs obligatoires s’appliquent toujours (RÈGLE 12).',
    ),
    params: [
      param('status', 'slug', true,
        T('Status', 'Statut'), 'rules.param.status',
        T('Destination status slug. The transition itself is looked up in the state machine.',
          'Slug du statut de destination. La transition est retrouvée dans la machine à états.'),
        { aliases: ['to', 'status_slug', 'to_status_slug'], referenceKind: null }),
      param('comment', 'template', false,
        T('Comment', 'Commentaire'), 'rules.param.comment',
        T('Optional note appended atomically with the move.',
          'Note facultative ajoutée en même temps que le changement.'),
        { aliases: ['body_md', 'note'] }),
      param('resolutionCode', 'string', false,
        T('Resolution code', 'Code de résolution'), 'rules.param.resolutionCode',
        T('Set when moving into a resolved status.',
          'À renseigner lors d’un passage en statut résolu.'),
        { aliases: ['resolution_code'] }),
      param('resolutionMd', 'template', false,
        T('Resolution notes', 'Notes de résolution'), 'rules.param.resolutionMd',
        T('Set when moving into a resolved status.',
          'À renseigner lors d’un passage en statut résolu.'),
        { aliases: ['resolution_md'] }),
      param('system', 'boolean', false,
        T('Bypass guards', 'Ignorer les gardes'),
        'rules.param.systemTransition',
        T('Only for recoveries and merges. A rule that routinely bypasses guards has the wrong guards.',
          'Réservé aux reprises et fusions. Une règle qui contourne systématiquement les gardes signale de mauvaises gardes.'),
        { defaultValue: false }),
    ],
    mutatesTicket: true,
    reentrant: true,
    budgetCost: 1,
    aliases: ['set_status', 'change_status'],
  },

  assign_to_user: {
    kind: 'assign_to_user',
    group: 'routing',
    label: T('Assign to a person', 'Affecter à une personne'),
    labelKey: 'rules.action.assignToUser',
    summary: T(
      'Sets the assignee by username — never by numeric id, which does not survive a config export.',
      'Définit le responsable par nom d’utilisateur — jamais par identifiant numérique, qui ne survit pas à un export.',
    ),
    params: [
      param('username', 'username', true,
        T('User', 'Utilisateur'), 'rules.param.username',
        T('Must be a member of this tenant.', 'Doit être membre de ce locataire.'),
        { aliases: ['user', 'assignee', 'to'] }),
    ],
    mutatesTicket: true,
    reentrant: true,
    budgetCost: 1,
    aliases: ['assign_user', 'set_assignee'],
  },

  assign_to_group: {
    kind: 'assign_to_group',
    group: 'routing',
    label: T('Assign to a group', 'Affecter à un groupe'),
    labelKey: 'rules.action.assignToGroup',
    summary: T('Sets the assignment group by slug.', 'Définit le groupe d’affectation par slug.'),
    params: [
      param('group', 'group_slug', true,
        T('Assignment group', 'Groupe d’affectation'), 'rules.param.group',
        T('An assignment_groups slug.', 'Un slug de assignment_groups.'),
        { aliases: ['group_slug', 'assignment_group', 'to'] }),
    ],
    mutatesTicket: true,
    reentrant: true,
    budgetCost: 1,
    aliases: ['assign_group', 'set_assignment_group'],
  },

  assign_group_by_queue: {
    kind: 'assign_group_by_queue',
    group: 'routing',
    label: T('Assign a group from the queue', 'Affecter un groupe selon la file'),
    labelKey: 'rules.action.assignGroupByQueue',
    summary: T(
      'Queue slug → group slug, with a fallback. Splitting the desk is an edit here, not a code change.',
      'Slug de file → slug de groupe, avec repli. Découper le service se fait ici, pas dans le code.',
    ),
    params: [
      param('map', 'map', true,
        T('Queue → group', 'File → groupe'), 'rules.param.queueGroupMap',
        T('An object mapping each queue slug to an assignment group slug.',
          'Un objet associant chaque slug de file à un slug de groupe.'),
        { aliases: ['queue_map', 'mapping'] }),
      param('fallbackGroup', 'group_slug', false,
        T('Fallback group', 'Groupe de repli'), 'rules.param.fallbackGroup',
        T('Used when the queue is not in the map. Without it an unmapped queue is a no-op, and says so.',
          'Utilisé quand la file n’est pas dans la table. Sans lui, une file absente ne fait rien — et le dit.'),
        { aliases: ['fallback_group', 'default_group'] }),
    ],
    mutatesTicket: true,
    reentrant: true,
    budgetCost: 1,
    aliases: [],
  },

  move_to_queue: {
    kind: 'move_to_queue',
    group: 'routing',
    label: T('Move to a queue', 'Déplacer vers une file'),
    labelKey: 'rules.action.moveToQueue',
    summary: T(
      'Changes the queue, which may change the SLA policy and the state machine that apply.',
      'Change la file, ce qui peut changer la politique de SLA et la machine à états applicables.',
    ),
    params: [
      param('queue', 'slug', true,
        T('Queue', 'File'), 'rules.param.queue',
        T('A published queue config object.', 'Un objet de configuration « queue » publié.'),
        { aliases: ['queue_slug', 'to'], referenceKind: 'queue' }),
    ],
    mutatesTicket: true,
    reentrant: true,
    budgetCost: 1,
    aliases: ['set_queue'],
  },

  add_tag: {
    kind: 'add_tag',
    group: 'people',
    label: T('Add a tag', 'Ajouter une étiquette'),
    labelKey: 'rules.action.addTag',
    summary: T(
      'Appends to data.tags. Tickets have no tags column — the bag is the honest place for a free list.',
      'Ajoute à data.tags. Les tickets n’ont pas de colonne d’étiquettes — le sac JSON est l’endroit honnête.',
    ),
    params: [
      param('tags', 'string_list', true,
        T('Tags', 'Étiquettes'), 'rules.param.tags',
        T('One tag or a list of them.', 'Une étiquette ou une liste.'),
        { aliases: ['tag', 'value'] }),
    ],
    mutatesTicket: true,
    reentrant: true,
    budgetCost: 1,
    aliases: [],
  },

  remove_tag: {
    kind: 'remove_tag',
    group: 'people',
    label: T('Remove a tag', 'Retirer une étiquette'),
    labelKey: 'rules.action.removeTag',
    summary: T('Removes from data.tags.', 'Retire de data.tags.'),
    params: [
      param('tags', 'string_list', true,
        T('Tags', 'Étiquettes'), 'rules.param.tags',
        T('One tag or a list of them.', 'Une étiquette ou une liste.'),
        { aliases: ['tag', 'value'] }),
    ],
    mutatesTicket: true,
    reentrant: true,
    budgetCost: 1,
    aliases: [],
  },

  add_watcher: {
    kind: 'add_watcher',
    group: 'people',
    label: T('Add a watcher', 'Ajouter un observateur'),
    labelKey: 'rules.action.addWatcher',
    summary: T(
      'Subscribes a person, a group’s members, or a role to the ticket.',
      'Abonne une personne, les membres d’un groupe ou un rôle au ticket.',
    ),
    params: [
      param('username', 'username', false,
        T('User', 'Utilisateur'), 'rules.param.username',
        T('One named person.', 'Une personne nommée.'), { aliases: ['user'] }),
      param('group', 'group_slug', false,
        T('Group', 'Groupe'), 'rules.param.group',
        T('Every member of the assignment group.', 'Tous les membres du groupe d’affectation.'),
        { aliases: ['group_slug'] }),
      param('role', 'enum', false,
        T('Role', 'Rôle'), 'rules.param.watcherRole',
        T('assignee, requester, or every manager and admin of the tenant.',
          'responsable, demandeur, ou tous les gestionnaires et administrateurs du locataire.'),
        { enumValues: ['assignee', 'requester', 'manager', 'admin'] }),
      param('reason', 'string', false,
        T('Reason', 'Raison'), 'rules.param.reason',
        T('Stored on the watcher row: manual | assignee | escalation | rule:<slug>.',
          'Stocké sur la ligne d’observateur : manual | assignee | escalation | rule:<slug>.'),
        { defaultValue: 'rule' }),
    ],
    mutatesTicket: false,
    reentrant: false,
    budgetCost: 1,
    aliases: ['watch', 'subscribe'],
  },

  post_public_reply: {
    kind: 'post_public_reply',
    group: 'timeline',
    label: T('Post a public reply', 'Publier une réponse publique'),
    labelKey: 'rules.action.postPublicReply',
    summary: T(
      'Visible to the requester, and it stamps first_response_at — so an automated reply really does answer the response SLA.',
      'Visible par le demandeur, et marque first_response_at — une réponse automatique répond donc bien au SLA de réponse.',
    ),
    params: [
      param('bodyMd', 'template', true,
        T('Message', 'Message'), 'rules.param.bodyMd',
        T('Markdown. Templated with {{ticket.*}}.', 'Markdown. Gabarit avec {{ticket.*}}.'),
        { aliases: ['body_md', 'body', 'message', 'text'] }),
    ],
    mutatesTicket: false,
    reentrant: true,
    budgetCost: 1,
    aliases: [],
  },

  post_work_note: {
    kind: 'post_work_note',
    group: 'timeline',
    label: T('Post a work note', 'Publier une note interne'),
    labelKey: 'rules.action.postWorkNote',
    summary: T('Internal only. Never reaches the requester.', 'Interne uniquement. N’atteint jamais le demandeur.'),
    params: [
      param('bodyMd', 'template', true,
        T('Note', 'Note'), 'rules.param.bodyMd',
        T('Markdown. Templated with {{ticket.*}}.', 'Markdown. Gabarit avec {{ticket.*}}.'),
        { aliases: ['body_md', 'body', 'message', 'text'] }),
      param('automation', 'boolean', false,
        T('File as automation', 'Classer comme automatisation'), 'rules.param.automationNote',
        T('Files the entry under the collapsible automation kind instead of an agent work note.',
          'Classe l’entrée dans le type « automatisation » repliable plutôt qu’en note d’agent.'),
        { defaultValue: true }),
    ],
    mutatesTicket: false,
    reentrant: true,
    budgetCost: 1,
    aliases: ['add_journal', 'add_note', 'comment'],
  },

  apply_macro: {
    kind: 'apply_macro',
    group: 'timeline',
    label: T('Apply a macro', 'Appliquer une macro'),
    labelKey: 'rules.action.applyMacro',
    summary: T(
      'Expands the macro’s own action list through this same executor — one implementation, one log.',
      'Déroule la liste d’actions de la macro dans ce même exécuteur — une implémentation, un seul journal.',
    ),
    params: [
      param('macro', 'slug', true,
        T('Macro', 'Macro'), 'rules.param.macro',
        T('A published macro config object.', 'Un objet de configuration « macro » publié.'),
        { aliases: ['macro_slug', 'slug'], referenceKind: 'macro' }),
    ],
    mutatesTicket: true,
    reentrant: true,
    budgetCost: 1,
    aliases: [],
  },

  send_notification: {
    kind: 'send_notification',
    group: 'engine',
    label: T('Send a notification', 'Envoyer une notification'),
    labelKey: 'rules.action.sendNotification',
    summary: T(
      'Renders a template and enqueues it. Suppressions and loop detection are the outbox’s job, not the rule’s.',
      'Rend un gabarit et le met en file. Les suppressions et la détection de boucle sont l’affaire de la file d’envoi.',
    ),
    params: [
      param('template', 'slug', true,
        T('Template', 'Gabarit'), 'rules.param.template',
        T('A published notification_template config object.',
          'Un objet de configuration « notification_template » publié.'),
        { aliases: ['template_slug'], referenceKind: 'notification_template' }),
      param('event', 'string', false,
        T('Event', 'Événement'), 'rules.param.event',
        T('Domain event the channel bindings filter on. Defaults to the template’s own.',
          'Événement métier sur lequel filtrent les liaisons de canal. Par défaut celui du gabarit.')),
      param('to', 'string_list', false,
        T('Audience', 'Destinataires'), 'rules.param.audience',
        T('requester | assignee | assignment_group | managers | watchers, or usernames.',
          'requester | assignee | assignment_group | managers | watchers, ou des noms d’utilisateur.'),
        { aliases: ['audience', 'recipients'] }),
      param('channelTypes', 'string_list', false,
        T('Channel types', 'Types de canaux'), 'rules.param.channelTypes',
        T('email | inapp | webhook | chat. Passed to the channel bindings as a condition field — the '
          + 'bindings decide delivery, this narrows what they may pick.',
          'email | inapp | webhook | chat. Transmis aux liaisons de canal comme champ de condition — '
          + 'ce sont les liaisons qui décident de l’envoi, ceci restreint leur choix.'),
        { aliases: ['channel_types', 'channels'] }),
      param('severity', 'enum', false,
        T('Severity', 'Gravité'), 'rules.param.severity',
        T('Drives colour and routing in the rich channels.',
          'Détermine la couleur et le routage dans les canaux riches.'),
        { enumValues: ['info', 'success', 'warning', 'critical'], defaultValue: 'info' }),
      param('locale', 'enum', false,
        T('Locale', 'Langue'), 'rules.param.locale',
        T('fr or en. Defaults to the tenant default.', 'fr ou en. Par défaut la langue du locataire.'),
        { enumValues: ['fr', 'en'] }),
    ],
    mutatesTicket: false,
    reentrant: false,
    budgetCost: 1,
    aliases: ['send_email', 'notify'],
  },

  start_sla_target: {
    kind: 'start_sla_target',
    group: 'engine',
    label: T('Start an SLA clock', 'Démarrer une horloge SLA'),
    labelKey: 'rules.action.startSlaTarget',
    summary: T(
      'Opens a clock for one target of the applicable policy.',
      'Ouvre une horloge pour une cible de la politique applicable.',
    ),
    params: [
      param('target', 'slug', true,
        T('Target', 'Cible'), 'rules.param.slaTarget',
        T('A target slug inside the SLA policy (first_response, resolution…).',
          'Un slug de cible dans la politique de SLA (first_response, resolution…).'),
        { aliases: ['target_slug', 'sla_target'], referenceKind: null }),
      param('policy', 'slug', false,
        T('Policy', 'Politique'), 'rules.param.slaPolicy',
        T('Pin a policy instead of letting the engine pick by precedence.',
          'Épingle une politique au lieu de laisser le moteur choisir par précédence.'),
        { aliases: ['policy_slug', 'sla'], referenceKind: 'sla' }),
      param('reason', 'string', false,
        T('Reason code', 'Code de raison'), 'rules.param.reason',
        T('Written to sla_ledger so the clock is auditable.',
          'Écrit dans sla_ledger pour rendre l’horloge auditable.'),
        { defaultValue: 'rule' }),
    ],
    mutatesTicket: false,
    reentrant: false,
    budgetCost: 1,
    aliases: ['set_sla', 'start_sla'],
  },

  pause_sla: {
    kind: 'pause_sla',
    group: 'engine',
    label: T('Pause the SLA', 'Suspendre le SLA'),
    labelKey: 'rules.action.pauseSla',
    summary: T(
      'Pauses one target, or every live clock on the ticket.',
      'Suspend une cible, ou toutes les horloges actives du ticket.',
    ),
    params: [
      param('target', 'slug', false,
        T('Target', 'Cible'), 'rules.param.slaTarget',
        T('Leave empty to pause every running clock.',
          'Laisser vide pour suspendre toutes les horloges en cours.'),
        { aliases: ['target_slug'], referenceKind: null }),
      param('reason', 'string', false,
        T('Reason code', 'Code de raison'), 'rules.param.reason',
        T('Written to sla_ledger.', 'Écrit dans sla_ledger.'), { defaultValue: 'rule' }),
    ],
    mutatesTicket: false,
    reentrant: false,
    budgetCost: 1,
    aliases: [],
  },

  resume_sla: {
    kind: 'resume_sla',
    group: 'engine',
    label: T('Resume the SLA', 'Reprendre le SLA'),
    labelKey: 'rules.action.resumeSla',
    summary: T('Resumes paused clocks.', 'Reprend les horloges suspendues.'),
    params: [
      param('target', 'slug', false,
        T('Target', 'Cible'), 'rules.param.slaTarget',
        T('Leave empty to resume every paused clock.',
          'Laisser vide pour reprendre toutes les horloges suspendues.'),
        { aliases: ['target_slug'], referenceKind: null }),
      param('reason', 'string', false,
        T('Reason code', 'Code de raison'), 'rules.param.reason',
        T('Written to sla_ledger.', 'Écrit dans sla_ledger.'), { defaultValue: 'rule' }),
    ],
    mutatesTicket: false,
    reentrant: false,
    budgetCost: 1,
    aliases: [],
  },

  escalate: {
    kind: 'escalate',
    group: 'engine',
    label: T('Escalate', 'Escalader'),
    labelKey: 'rules.action.escalate',
    summary: T(
      'Runs one step of an escalation ladder: notify, watch, and raise the priority if the step says so.',
      'Exécute une étape d’une échelle d’escalade : notifier, observer, et relever la priorité si l’étape le prévoit.',
    ),
    params: [
      param('escalation', 'slug', true,
        T('Escalation', 'Escalade'), 'rules.param.escalation',
        T('A published escalation config object.',
          'Un objet de configuration « escalation » publié.'),
        { aliases: ['escalation_slug', 'ladder'], referenceKind: 'escalation' }),
      param('step', 'number', false,
        T('Step', 'Étape'), 'rules.param.escalationStep',
        T('Which rung to run. Defaults to the first.', 'Quel échelon exécuter. Le premier par défaut.'),
        { defaultValue: 0 }),
    ],
    mutatesTicket: true,
    reentrant: true,
    budgetCost: 1,
    aliases: [],
  },

  request_approval: {
    kind: 'request_approval',
    group: 'engine',
    label: T('Request an approval', 'Demander une approbation'),
    labelKey: 'rules.action.requestApproval',
    summary: T(
      'Opens a pending approval with its steps resolved to real approvers. Never opens a second one for the same definition.',
      'Ouvre une approbation en attente avec ses étapes résolues en approbateurs réels. N’en ouvre jamais une seconde pour la même définition.',
    ),
    params: [
      param('approval', 'slug', true,
        T('Approval', 'Approbation'), 'rules.param.approval',
        T('A published approval config object.', 'Un objet de configuration « approval » publié.'),
        { aliases: ['approval_slug', 'definition'], referenceKind: 'approval' }),
    ],
    mutatesTicket: false,
    reentrant: false,
    budgetCost: 1,
    aliases: ['start_approval'],
  },

  link_ticket: {
    kind: 'link_ticket',
    group: 'relation',
    label: T('Link another ticket', 'Lier un autre ticket'),
    labelKey: 'rules.action.linkTicket',
    summary: T('Creates a typed link to an existing ticket, by number.',
      'Crée un lien typé vers un ticket existant, par numéro.'),
    params: [
      param('ticketNumber', 'ticket_number', true,
        T('Ticket number', 'Numéro du ticket'), 'rules.param.ticketNumber',
        T('Templated, so it can come from a custom field.',
          'Gabarit, il peut donc provenir d’un champ personnalisé.'),
        { aliases: ['ticket_number', 'number', 'to'] }),
      param('linkKind', 'enum', false,
        T('Link type', 'Type de lien'), 'rules.param.linkKind',
        T('merged_from is written by merge() alone and is refused here.',
          'merged_from n’est écrit que par merge() et est refusé ici.'),
        {
          aliases: ['kind', 'link_kind'],
          enumValues: ['related', 'duplicate', 'blocks', 'caused_by', 'child'],
          defaultValue: 'related',
        }),
    ],
    mutatesTicket: false,
    reentrant: false,
    budgetCost: 1,
    aliases: [],
  },

  create_child_ticket: {
    kind: 'create_child_ticket',
    group: 'relation',
    label: T('Create a child ticket', 'Créer un ticket enfant'),
    labelKey: 'rules.action.createChildTicket',
    summary: T(
      'Opens a related ticket that inherits occurred_at from its parent (HARD RULE 6).',
      'Ouvre un ticket lié qui hérite de occurred_at de son parent (RÈGLE 6).',
    ),
    params: [
      param('subject', 'template', true,
        T('Subject', 'Objet'), 'rules.param.subject',
        T('Templated. {{ticket.number}} is usually worth including.',
          'Gabarit. {{ticket.number}} vaut généralement la peine d’être inclus.')),
      param('queue', 'slug', false,
        T('Queue', 'File'), 'rules.param.queue',
        T('Defaults to the parent’s queue.', 'Par défaut, la file du parent.'),
        { aliases: ['queue_slug'], referenceKind: 'queue' }),
      param('recordType', 'enum', false,
        T('Record type', 'Type d’enregistrement'), 'rules.param.recordType',
        T('incident, request, task…', 'incident, request, task…'),
        {
          aliases: ['record_type'],
          enumValues: ['incident', 'request', 'problem', 'change', 'task', 'release'],
          defaultValue: 'task',
        }),
      param('descriptionMd', 'template', false,
        T('Description', 'Description'), 'rules.param.descriptionMd',
        T('Markdown, templated.', 'Markdown, gabarit.'), { aliases: ['description_md', 'body_md'] }),
      param('priority', 'slug', false,
        T('Priority', 'Priorité'), 'rules.param.priority',
        T('Defaults to the parent’s.', 'Par défaut, celle du parent.'),
        { aliases: ['priority_slug'], referenceKind: null }),
      param('group', 'group_slug', false,
        T('Assignment group', 'Groupe d’affectation'), 'rules.param.group',
        T('Optional. Otherwise the child routes itself.',
          'Facultatif. Sinon l’enfant se route lui-même.'),
        { aliases: ['group_slug', 'assignment_group'] }),
      param('linkKind', 'enum', false,
        T('Link type', 'Type de lien'), 'rules.param.linkKind',
        T('How the child is linked back to the parent.',
          'Comment l’enfant est relié au parent.'),
        {
          aliases: ['link_kind'],
          enumValues: ['related', 'duplicate', 'blocks', 'caused_by', 'child'],
          defaultValue: 'child',
        }),
    ],
    mutatesTicket: false,
    reentrant: true,
    budgetCost: 2,
    aliases: ['create_ticket', 'spawn_task'],
  },

  webhook_out: {
    kind: 'webhook_out',
    group: 'external',
    label: T('Call a webhook', 'Appeler un webhook'),
    labelKey: 'rules.action.webhookOut',
    summary: T(
      'ENQUEUES a webhook through the outbox. It is never sent inline: an HTTP call inside a ticket transaction holds a database lock open across somebody else’s network.',
      'MET EN FILE un webhook via la file d’envoi. Jamais envoyé en ligne : un appel HTTP dans une transaction de ticket garde un verrou ouvert le temps du réseau d’un tiers.',
    ),
    params: [
      param('url', 'string', true,
        T('URL', 'URL'), 'rules.param.webhookUrl',
        T('https only.', 'https uniquement.')),
      param('secret', 'string', false,
        T('Shared secret', 'Secret partagé'), 'rules.param.webhookSecret',
        T('Signs the request so the receiver can verify it.',
          'Signe la requête pour que le destinataire puisse la vérifier.')),
      param('event', 'string', false,
        T('Event', 'Événement'), 'rules.param.event',
        T('Defaults to rule.<slug>.', 'Par défaut rule.<slug>.')),
      param('title', 'template', false,
        T('Title', 'Titre'), 'rules.param.title',
        T('Defaults to the ticket number and subject.',
          'Par défaut le numéro et l’objet du ticket.')),
      param('body', 'template', false,
        T('Body', 'Corps'), 'rules.param.body',
        T('Markdown, templated.', 'Markdown, gabarit.'), { aliases: ['body_md', 'message'] }),
      param('severity', 'enum', false,
        T('Severity', 'Gravité'), 'rules.param.severity',
        T('Carried in the payload.', 'Transmise dans la charge utile.'),
        { enumValues: ['info', 'success', 'warning', 'critical'], defaultValue: 'info' }),
    ],
    mutatesTicket: false,
    reentrant: false,
    budgetCost: 1,
    aliases: ['webhook', 'http_post'],
  },
};

export const RULE_ACTION_KINDS = Object.keys(RULE_ACTION_CATALOGUE) as RuleActionKind[];

/** Every accepted spelling → the canonical kind. Built once from the catalogue. */
const ACTION_ALIASES: ReadonlyMap<string, RuleActionKind> = (() => {
  const map = new Map<string, RuleActionKind>();
  for (const definition of Object.values(RULE_ACTION_CATALOGUE)) {
    map.set(definition.kind, definition.kind);
    for (const alias of definition.aliases) map.set(alias, definition.kind);
  }
  return map;
})();

export function isRuleActionKind(value: unknown): value is RuleActionKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RULE_ACTION_CATALOGUE, value);
}

/**
 * The catalogue, flattened for the admin UI's action picker. Returned by
 * `GET /api/rules/actions` so the form renderer has no hard-coded copy of it.
 */
export function actionCatalogue(): RuleActionDefinition[] {
  return RULE_ACTION_KINDS.map((kind) => RULE_ACTION_CATALOGUE[kind]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Normalisation (two dialects in, one shape out)
// ═════════════════════════════════════════════════════════════════════════════

export interface NormalizedAction {
  /** Position in the rule's ordered list. The order IS the semantics. */
  index: number;
  kind: RuleActionKind;
  params: Record<string, unknown>;
  disabled: boolean;
  /**
   * Keys the author wrote that no parameter spec claims, and which were
   * therefore dropped. Reported rather than swallowed: a closed catalogue that
   * quietly discards half an action's configuration is indistinguishable from
   * a bug, and the author has no way to find out.
   */
  ignoredParams: string[];
  /** The body as authored, kept for diffing and for the execution log. */
  raw: Record<string, unknown>;
}

export type ActionIssueCode =
  | 'unknown_action'
  | 'malformed_action'
  | 'missing_param'
  | 'bad_param'
  | 'forbidden_param'
  /** Present in the body, claimed by no parameter spec, therefore dropped. */
  | 'ignored_param';

export interface ActionIssue {
  index: number;
  actionType: string;
  param?: string;
  code: ActionIssueCode;
  message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

/** The keys that are structural, never parameters, in either dialect. */
const STRUCTURAL_KEYS = new Set(['type', 'action', 'params', 'disabled', 'enabled', 'comment']);

/**
 * `kind` and `visibility` are CONSUMED by the `add_journal` fan-out below — on
 * a journal action they are type information, not parameters, so reporting
 * them as dropped would put noise on every shipped rule. They are not
 * structural in general: `link_ticket` legitimately takes `kind` as an alias
 * for its link type.
 */
const JOURNAL_TYPE_KEYS = new Set(['kind', 'visibility']);

/**
 * Fold one authored action into the normal form.
 *
 * Parameters are read from `params` when present and from the action object
 * itself otherwise, so `{ type: 'send_notification', template: 'x' }` and
 * `{ type: 'send_notification', params: { template: 'x' } }` are the same
 * action. Aliases declared in the catalogue are resolved here, which is why
 * the performers below can read one spelling and nothing else.
 */
export function normalizeAction(raw: unknown, index: number): NormalizedAction | ActionIssue {
  if (!isPlainObject(raw)) {
    return {
      index,
      actionType: String(raw),
      code: 'malformed_action',
      message: 'An action must be an object with a "type".',
    };
  }

  const declaredType = typeof raw.type === 'string'
    ? raw.type
    : typeof raw.action === 'string' ? raw.action : '';

  let kind = ACTION_ALIASES.get(declaredType.trim().toLowerCase());

  // `add_journal` is one authored type that fans out into two catalogue
  // entries: what makes a timeline entry public is its VISIBILITY, and a rule
  // that means to answer the requester must not silently file an internal note.
  if (declaredType === 'add_journal' || declaredType === 'add_note' || declaredType === 'journal') {
    const inner = isPlainObject(raw.params) ? raw.params : raw;
    const visibility = String(inner.visibility ?? '').toLowerCase();
    const journalKind = String(inner.kind ?? '').toLowerCase();
    kind = visibility === 'public' || journalKind === 'public_reply'
      ? 'post_public_reply'
      : 'post_work_note';
  }

  if (!kind) {
    return {
      index,
      actionType: declaredType || '(missing)',
      code: 'unknown_action',
      message:
        `"${declaredType || '(missing)'}" is not in the action catalogue. The catalogue is closed on purpose — ` +
        'an action nothing implements would be a rule that reports success and does nothing.',
    };
  }

  const definition = RULE_ACTION_CATALOGUE[kind];
  const source: Record<string, unknown> = isPlainObject(raw.params)
    ? { ...raw, ...raw.params }
    : raw;

  const byNormalizedKey = new Map<string, unknown>();
  // Normalised key → the spelling the author actually wrote, so a report about
  // a dropped parameter names the line in their body rather than a mangled
  // lookup key they have never seen.
  const authoredSpelling = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (STRUCTURAL_KEYS.has(key)) continue;
    const normalized = normalizeKey(key);
    byNormalizedKey.set(normalized, value);
    if (!authoredSpelling.has(normalized)) authoredSpelling.set(normalized, key);
  }

  const params: Record<string, unknown> = {};
  const claimed = new Set<string>();
  for (const spec of definition.params) {
    const candidates = [spec.name, ...(spec.aliases ?? [])].map(normalizeKey);
    let found: unknown;
    for (const candidate of candidates) {
      if (byNormalizedKey.has(candidate)) {
        found = byNormalizedKey.get(candidate);
        claimed.add(candidate);
        break;
      }
    }
    if (found === undefined && spec.defaultValue !== undefined) found = spec.defaultValue;
    if (found !== undefined) params[spec.name] = found;
  }

  const isJournalPost = kind === 'post_public_reply' || kind === 'post_work_note';
  const ignoredParams = [...byNormalizedKey.keys()]
    .filter((key) => !claimed.has(key) && !(isJournalPost && JOURNAL_TYPE_KEYS.has(key)))
    .map((key) => authoredSpelling.get(key) ?? key);

  // The old `add_journal` dialect carried its text under `body_md` as a
  // localized object; keep the French, fall back to English (HARD RULE 10).
  if ((kind === 'post_public_reply' || kind === 'post_work_note') && isPlainObject(params.bodyMd)) {
    const localized = params.bodyMd as Record<string, unknown>;
    params.bodyMd = String(localized.fr ?? localized.en ?? '');
  }

  return {
    index,
    kind,
    params,
    disabled: raw.disabled === true || raw.enabled === false,
    ignoredParams,
    raw,
  };
}

export function normalizeActions(raw: unknown): { actions: NormalizedAction[]; issues: ActionIssue[] } {
  const list = Array.isArray(raw) ? raw : [];
  const actions: NormalizedAction[] = [];
  const issues: ActionIssue[] = [];

  list.forEach((entry, index) => {
    const result = normalizeAction(entry, index);
    if ('code' in result) {
      issues.push(result);
      return;
    }
    actions.push(result);
    issues.push(...validateActionParams(result));
    for (const ignored of result.ignoredParams) {
      issues.push({
        index,
        actionType: result.kind,
        param: ignored,
        code: 'ignored_param',
        message:
          `"${ignored}" is not a parameter of ${result.kind} and was dropped. Check the action catalogue — `
          + 'a setting that silently does nothing is worse than one that is missing.',
      });
    }
  });

  return { actions, issues };
}

/**
 * Check one normalised action against its declared parameter schema.
 *
 * Reported, never thrown: a rule with one bad action still runs its other
 * actions, and the bad one lands in `rule_executions` with a reason. Refusing
 * the whole rule would turn a typo in action #4 into "the automation stopped
 * working" with no further detail.
 */
export function validateActionParams(action: NormalizedAction): ActionIssue[] {
  const definition = RULE_ACTION_CATALOGUE[action.kind];
  const issues: ActionIssue[] = [];
  const push = (code: ActionIssueCode, message: string, paramName?: string): void => {
    issues.push({ index: action.index, actionType: action.kind, param: paramName, code, message });
  };

  for (const spec of definition.params) {
    const value = action.params[spec.name];

    if (value === undefined || value === null || value === '') {
      if (spec.required) {
        push('missing_param', `"${spec.name}" is required by ${action.kind}.`, spec.name);
      }
      continue;
    }

    switch (spec.type) {
      case 'number':
      case 'minutes':
        if (!Number.isFinite(Number(value))) {
          push('bad_param', `"${spec.name}" must be a number.`, spec.name);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          push('bad_param', `"${spec.name}" must be true or false.`, spec.name);
        }
        break;
      case 'enum':
        if (spec.enumValues && !spec.enumValues.includes(String(value))) {
          push('bad_param',
            `"${spec.name}" must be one of ${spec.enumValues.join(', ')}.`, spec.name);
        }
        break;
      case 'map':
        if (!isPlainObject(value)) {
          push('bad_param', `"${spec.name}" must be an object of slug → slug.`, spec.name);
        }
        break;
      case 'string_list':
        if (!Array.isArray(value) && typeof value !== 'string') {
          push('bad_param', `"${spec.name}" must be a string or a list of strings.`, spec.name);
        }
        break;
      case 'slug':
      case 'username':
      case 'group_slug':
        if (typeof value !== 'string') {
          push('bad_param', `"${spec.name}" must be a slug (HARD RULE 3 — never a numeric id).`, spec.name);
        }
        break;
      default:
        break;
    }
  }

  // One targeted refusal rather than a generic type check: `merged_from` links
  // exist only as the output of merge(), and one hand-made by a rule is a merge
  // nobody can undo.
  if (action.kind === 'link_ticket' && String(action.params.linkKind) === 'merged_from') {
    push('forbidden_param', 'Merge links are created by the merge action, never by a rule.', 'linkKind');
  }

  return issues;
}

/**
 * Every config-object reference the action list makes, by slug. The linter
 * resolves these; nothing here does, because a rule that names a queue which
 * does not exist should fail at PUBLISH time, not at 2am.
 */
export function collectActionReferences(
  actions: readonly NormalizedAction[],
): Array<{ index: number; path: string; targetKind: ConfigKind; slug: string }> {
  const out: Array<{ index: number; path: string; targetKind: ConfigKind; slug: string }> = [];
  for (const action of actions) {
    const definition = RULE_ACTION_CATALOGUE[action.kind];
    for (const spec of definition.params) {
      if (!spec.referenceKind) continue;
      const value = action.params[spec.name];
      if (typeof value !== 'string' || value.trim() === '') continue;
      out.push({
        index: action.index,
        path: `actions[${action.index}].${spec.name}`,
        targetKind: spec.referenceKind,
        slug: value.trim(),
      });
    }
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Templates: an expression may RETURN, never PERFORM
// ═════════════════════════════════════════════════════════════════════════════

/** The closed formatter set. There is no `eval`, and there will not be one. */
const FORMATTERS: Readonly<Record<string, (value: unknown) => string>> = {
  upper: (value) => String(value ?? '').toUpperCase(),
  lower: (value) => String(value ?? '').toLowerCase(),
  trim: (value) => String(value ?? '').trim(),
  date: (value) => {
    const parsed = value ? new Date(String(value)) : null;
    return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
  },
  time: (value) => {
    const parsed = value ? new Date(String(value)) : null;
    return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(11, 19) : '';
  },
  json: (value) => JSON.stringify(value ?? null),
};

function readPath(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * `{{ticket.number}}`, `{{ticket.data.site | upper}}`.
 *
 * An unresolved placeholder renders as the empty string rather than throwing:
 * a notification that reads "Ticket  is late" is a bug someone reports, while
 * an exception here would abort an action that had already half-run.
 */
export function renderTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression: string) => {
    const [rawPath, ...filters] = expression.split('|').map((part) => part.trim());
    let value = readPath(variables, rawPath);
    for (const filter of filters) {
      const formatter = FORMATTERS[filter.toLowerCase()];
      if (formatter) value = formatter(value);
    }
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

/** Render only when the value is a string; literals pass through untouched. */
function renderValue(value: unknown, variables: Record<string, unknown>): unknown {
  return typeof value === 'string' ? renderTemplate(value, variables) : value;
}

/**
 * The variable bag every template and every computed parameter reads.
 * Deliberately flat-ish and boring: what a rule author can reach is exactly
 * what this function puts here.
 */
export function buildTemplateVariables(input: {
  ticket: TicketWithRelations;
  actor: ActorContext;
  ruleSlug: string;
  ruleVersion: number;
  now: string;
  tenantSlug: string | null;
}): Record<string, unknown> {
  const { ticket } = input;
  return {
    ticket: {
      id: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      description_md: ticket.descriptionMd,
      record_type: ticket.recordType,
      status_slug: ticket.statusSlug,
      status_category: ticket.statusCategory,
      priority_slug: ticket.prioritySlug,
      impact: ticket.impact,
      urgency: ticket.urgency,
      queue_slug: ticket.queueSlug,
      assignee_id: ticket.assigneeId,
      assignee: ticket.assignee?.displayName ?? ticket.assignee?.username ?? null,
      assignment_group_id: ticket.assignmentGroupId,
      assignment_group: ticket.assignmentGroup?.name ?? null,
      organization: ticket.organization?.name ?? null,
      requester: ticket.requesterContact?.displayName ?? ticket.requesterContact?.email ?? null,
      occurred_at: ticket.occurredAt,
      created_at: ticket.createdAt,
      due_at: ticket.dueAt,
      resolution_code: ticket.resolutionCode,
      resolution_md: ticket.resolutionMd,
      row_version: ticket.rowVersion,
      data: { ...(ticket.data ?? {}) },
    },
    actor: {
      id: input.actor.userId,
      username: input.actor.username ?? null,
      type: input.actor.actorType,
    },
    rule: { slug: input.ruleSlug, version: input.ruleVersion },
    tenant: { slug: input.tenantSlug },
    now: input.now,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Guardrails, as errors the engine can name
// ═════════════════════════════════════════════════════════════════════════════

export type GuardrailCode = 'loop_depth' | 'action_budget' | 'circuit_open';

/**
 * A guardrail STOPS work and says so. It is deliberately an error rather than
 * a `return null`: the difference between "the rule finished" and "the rule was
 * cut off at action 12 of 20" has to survive all the way to the execution log,
 * and a truncation that looks like completion is the one failure mode nobody
 * catches until the ticket is wrong.
 */
export class GuardrailError extends Error {
  constructor(
    readonly code: GuardrailCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GuardrailError';
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — The execution context
// ═════════════════════════════════════════════════════════════════════════════

export interface ActionContext {
  tenantId: number;
  tenantSlug: string | null;
  tenantName: string | null;
  /** The CURRENT ticket. Replaced after every real write, shadowed in dry run. */
  ticket: TicketWithRelations;
  previous: TicketWithRelations | null;
  actor: ActorContext;
  trx: Knex.Transaction;
  ruleSlug: string;
  ruleVersion: number;
  /** Evaluate and log, perform nothing. */
  dryRun: boolean;
  correlationId: string;
  /** ENGINES MUST PASS THIS so the row replays identically. */
  now: string;
  trigger: string;
  /** Nesting depth, for actions that can re-enter the engine. */
  depth: number;
  /** Charge the per-ticket budget. Throws {@link GuardrailError} when spent. */
  spend(kind: RuleActionKind, cost: number): void;
  /** Adopt the row a real write returned. */
  setTicket(ticket: TicketWithRelations): void;
  /** Dry run: fold the intended change into the in-memory ticket. */
  shadow(patch: Record<string, unknown>): void;
}

export interface ActionResult {
  index: number;
  kind: RuleActionKind;
  /** True only when something actually changed (or would have, in dry run). */
  performed: boolean;
  /** Ran, decided there was nothing to do, and said why. Still a fact. */
  skipped?: string;
  error?: string;
  detail: Record<string, unknown>;
  durationMs: number;
}

/** What a mutating action decided to do, before we know whether we write it. */
interface TicketPatchPlan {
  patch: Record<string, unknown>;
  summary: Record<string, unknown>;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Field paths
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Column → the `UpdateTicketRequest` key that writes it.
 *
 * `status_slug` is deliberately absent. A status change is a transition: it has
 * guards, required fields and a state machine behind it, and letting a rule
 * poke the column would route around HARD RULE 12 in the one place it matters
 * most. `set_field` on the status is refused with that sentence, not ignored.
 */
const WRITABLE_COLUMNS: Readonly<Record<string, string>> = {
  subject: 'subject',
  description_md: 'descriptionMd',
  priority_slug: 'prioritySlug',
  impact: 'impact',
  urgency: 'urgency',
  queue_slug: 'queueSlug',
  assignment_group_id: 'assignmentGroupId',
  assignee_id: 'assigneeId',
  requester_contact_id: 'requesterContactId',
  organization_id: 'organizationId',
  primary_ci_id: 'primaryCiId',
  occurred_at: 'occurredAt',
  due_at: 'dueAt',
  resolution_code: 'resolutionCode',
  resolution_md: 'resolutionMd',
};

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (chr) => `_${chr.toLowerCase()}`);
}

/** `ticket.data.x` / `data.x` / `ticket.priority_slug` / `prioritySlug` → one shape. */
export function classifyFieldPath(
  rawPath: string,
): { kind: 'column'; column: string; patchKey: string }
  | { kind: 'data'; key: string }
  | { kind: 'status' }
  | { kind: 'unwritable'; path: string } {
  const stripped = rawPath.trim().replace(/^ticket\./, '');
  const snake = camelToSnake(stripped);

  if (snake === 'status_slug' || snake === 'status' || snake === 'status_category') {
    return { kind: 'status' };
  }
  if (snake.startsWith('data.')) {
    return { kind: 'data', key: stripped.slice('data.'.length) };
  }
  const patchKey = WRITABLE_COLUMNS[snake];
  if (patchKey) return { kind: 'column', column: snake, patchKey };
  return { kind: 'unwritable', path: rawPath };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Resolution helpers (slug → row, HARD RULE 3 in one direction)
// ═════════════════════════════════════════════════════════════════════════════

async function findUserByUsername(
  tenantId: number,
  username: string,
  executor: Executor,
): Promise<{ id: number; username: string } | null> {
  const row = (await executor('users')
    .join('user_tenants', 'user_tenants.user_id', 'users.id')
    .where('user_tenants.tenant_id', tenantId)
    .where('users.username', username)
    .where('users.is_active', true)
    .first('users.id', 'users.username')) as { id: number; username: string } | undefined;
  return row ? { id: Number(row.id), username: String(row.username) } : null;
}

async function findGroupBySlug(
  tenantId: number,
  slug: string,
  executor: Executor,
): Promise<{ id: number; slug: string; memberUserIds: number[] } | null> {
  const row = (await scoped('assignment_groups', tenantId, executor)
    .where('assignment_groups.slug', slug)
    .where('assignment_groups.is_active', true)
    .first('id', 'slug', 'member_user_ids')) as
    | { id: number; slug: string; member_user_ids: number[] | null }
    | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    slug: String(row.slug),
    memberUserIds: (row.member_user_ids ?? []).map(Number),
  };
}

async function usersWithRole(
  tenantId: number,
  roles: readonly string[],
  executor: Executor,
): Promise<number[]> {
  const rows = (await executor('user_tenants')
    .join('users', 'users.id', 'user_tenants.user_id')
    .where('user_tenants.tenant_id', tenantId)
    .whereIn('user_tenants.role', roles as string[])
    .where('users.is_active', true)
    .select('users.id')) as Array<{ id: number }>;
  return rows.map((row) => Number(row.id));
}

/**
 * Cached for a minute. A tenant's slug is its cross-app identity (HARD RULE
 * 13) and changes about once ever, while a 200-ticket simulation would
 * otherwise ask for it 200 times.
 */
const identityCache = new Map<number, { at: number; slug: string; name: string }>();

async function tenantIdentity(
  tenantId: number,
  executor: Executor,
): Promise<{ slug: string; name: string }> {
  const cached = identityCache.get(tenantId);
  if (cached && Date.now() - cached.at < 60_000) {
    return { slug: cached.slug, name: cached.name };
  }

  const row = (await executor('tenants')
    .where('id', tenantId)
    .first('slug', 'name')) as { slug: string; name: string } | undefined;
  const identity = {
    slug: row ? String(row.slug) : `tenant-${tenantId}`,
    name: row ? String(row.name) : '',
  };
  identityCache.set(tenantId, { at: Date.now(), ...identity });
  return identity;
}

function currentTags(ticket: TicketWithRelations): string[] {
  const raw = (ticket.data ?? {}).tags;
  if (Array.isArray(raw)) return raw.map((entry) => String(entry));
  if (typeof raw === 'string' && raw.trim() !== '') return [raw.trim()];
  return [];
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter((entry) => entry !== '');
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  return [];
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Optional engines, reached without a compile-time dependency
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The SLA engine lives in `sla.service.ts`, which is another slice's file and
 * may not exist in a given build. The specifier is held in a VARIABLE for the
 * same reason `index.ts` does it: a string literal would make TypeScript
 * resolve the module at compile time and fail the build for a file that is not
 * written yet, which is exactly the coupling this avoids.
 *
 * When it is absent the SLA actions are recorded as SKIPPED with the reason —
 * never as performed, and never silently.
 */
interface SlaBridge {
  startTarget?(input: Record<string, unknown>): Promise<unknown>;
  pauseTarget?(input: Record<string, unknown>): Promise<unknown>;
  resumeTarget?(input: Record<string, unknown>): Promise<unknown>;
}

let slaBridgeCache: SlaBridge | null | undefined;

async function slaBridge(): Promise<SlaBridge | null> {
  if (slaBridgeCache !== undefined) return slaBridgeCache;
  const specifier = './sla.service';
  try {
    const loaded = (await import(specifier)) as Record<string, unknown>;
    for (const name of ['slaService', 'slaEngine', 'slaTicker', 'default']) {
      const candidate = loaded[name];
      if (candidate && typeof candidate === 'object') {
        const bridge = candidate as SlaBridge;
        if (bridge.startTarget || bridge.pauseTarget || bridge.resumeTarget) {
          slaBridgeCache = bridge;
          return slaBridgeCache;
        }
      }
    }
    slaBridgeCache = null;
  } catch {
    slaBridgeCache = null;
  }
  return slaBridgeCache;
}

/** Test seam and escape hatch for a build that wires the SLA engine by hand. */
export function registerSlaBridge(bridge: SlaBridge | null): void {
  slaBridgeCache = bridge;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — The performers
// ═════════════════════════════════════════════════════════════════════════════

type Performer = (
  ctx: ActionContext,
  action: NormalizedAction,
  variables: Record<string, unknown>,
) => Promise<Omit<ActionResult, 'index' | 'kind' | 'durationMs'>>;

const skipped = (reason: string, detail: Record<string, unknown> = {}) => ({
  performed: false,
  skipped: reason,
  detail,
});

const done = (detail: Record<string, unknown>) => ({ performed: true, detail });

/**
 * Apply a ticket patch — for real, or into the shadow.
 *
 * THIS is the one branch between production and simulation. Everything above
 * it (resolution, rendering, guard checks) has already run identically.
 */
async function applyTicketPatch(
  ctx: ActionContext,
  plan: TicketPatchPlan,
): Promise<Omit<ActionResult, 'index' | 'kind' | 'durationMs'>> {
  if (Object.keys(plan.patch).length === 0) {
    return skipped('no_change', plan.summary);
  }

  if (ctx.dryRun) {
    ctx.shadow(plan.patch);
    return done({ ...plan.summary, dryRun: true, wouldChange: plan.patch });
  }

  const write = async (): Promise<TicketWithRelations> =>
    ticketService.update(
      ctx.tenantId,
      ctx.actor,
      ctx.ticket.id,
      {
        baseRowVersion: ctx.ticket.rowVersion,
        ruleSlug: ctx.ruleSlug,
        ...plan.patch,
      } as ticketService.UpdateTicketInput,
      ctx.trx,
    );

  let retried = false;
  try {
    await write();
  } catch (error) {
    // HARD RULE 7 in the one place it is NOT a user-facing conflict. `update()`
    // fires the rules hook, so a rule THIS rule triggered may have moved the
    // row underneath us — an expected consequence of a chain, not a collision
    // between two people. Re-read and try once; a second failure is real and
    // is reported.
    if (!(error instanceof ticketService.TicketVersionConflictError)) throw error;
    await refreshTicket(ctx);
    retried = true;
    await write();
  }

  // Deliberately re-read rather than trusting the row `update()` returned: a
  // nested rule that ran inside its hook may have changed the ticket again,
  // and carrying a stale `row_version` into the next action would turn a
  // working chain into a 409 on the third link.
  await refreshTicket(ctx);
  return done({ ...plan.summary, rowVersion: ctx.ticket.rowVersion, ...(retried ? { retried } : {}) });
}

/** Re-read the ticket inside the action's own transaction. */
async function refreshTicket(ctx: ActionContext): Promise<void> {
  const fresh = await ticketService.getById(ctx.tenantId, ctx.ticket.id, { executor: ctx.trx });
  if (fresh) ctx.setTicket(fresh);
}

const PERFORMERS: Readonly<Record<RuleActionKind, Performer>> = {
  // ── the ticket row ────────────────────────────────────────────────────────

  async set_field(ctx, action, variables) {
    const path = String(action.params.field ?? '');
    const classified = classifyFieldPath(path);
    const value = renderValue(action.params.value, variables);

    if (classified.kind === 'status') {
      return skipped(
        'status_needs_transition',
        {
          field: path,
          why: 'A status change goes through the state machine (HARD RULE 12). Use transition_to.',
        },
      );
    }
    if (classified.kind === 'unwritable') {
      return skipped('unwritable_field', { field: path });
    }

    if (classified.kind === 'data') {
      const current = (ctx.ticket.data ?? {})[classified.key];
      if (current === value) return skipped('already_set', { field: path, value });
      return applyTicketPatch(ctx, {
        patch: { data: { [classified.key]: value } },
        summary: { field: `data.${classified.key}`, from: current, to: value },
      });
    }

    const current = (ctx.ticket as unknown as Record<string, unknown>)[classified.patchKey];
    if (current === value) return skipped('already_set', { field: path, value });
    return applyTicketPatch(ctx, {
      patch: { [classified.patchKey]: value },
      summary: { field: classified.column, from: current, to: value },
    });
  },

  async set_priority(ctx, action, variables) {
    const priority = String(renderValue(action.params.priority, variables) ?? '').trim();
    if (!priority) return skipped('missing_priority');
    if (priority === ctx.ticket.prioritySlug) {
      return skipped('already_set', { prioritySlug: priority });
    }
    return applyTicketPatch(ctx, {
      patch: {
        prioritySlug: priority,
        // The matrix would otherwise recompute over the top of us; the reason
        // is what makes the override auditable rather than mysterious.
        priorityOverrideReason:
          String(action.params.reason ?? '') || `rule:${ctx.ruleSlug}`,
      },
      summary: { from: ctx.ticket.prioritySlug, to: priority },
    });
  },

  async transition_to(ctx, action, variables) {
    const toStatusSlug = String(renderValue(action.params.status, variables) ?? '').trim();
    if (!toStatusSlug) return skipped('missing_status');
    if (toStatusSlug === ctx.ticket.statusSlug) {
      return skipped('already_in_status', { statusSlug: toStatusSlug });
    }

    const comment = action.params.comment
      ? renderTemplate(String(action.params.comment), variables)
      : null;

    if (ctx.dryRun) {
      // A dry run must not ask the state machine to move anything, but it MUST
      // report the intent — "this rule would have closed the ticket" is the
      // single most important line a simulation can produce.
      ctx.shadow({ statusSlug: toStatusSlug });
      return done({
        dryRun: true,
        wouldTransition: { from: ctx.ticket.statusSlug, to: toStatusSlug },
      });
    }

    const from = ctx.ticket.statusSlug;
    let result: Awaited<ReturnType<typeof ticketService.transition>>;
    try {
      result = await ticketService.transition(
        ctx.tenantId,
        ctx.actor,
        ctx.ticket.id,
        {
          baseRowVersion: ctx.ticket.rowVersion,
          toStatusSlug,
          ruleSlug: ctx.ruleSlug,
          system: action.params.system === true,
          ...(comment ? { comment: { bodyMd: comment, visibility: 'internal' as JournalVisibility } } : {}),
          ...(action.params.resolutionCode
            ? { resolutionCode: String(action.params.resolutionCode) }
            : {}),
          ...(action.params.resolutionMd
            ? { resolutionMd: renderTemplate(String(action.params.resolutionMd), variables) }
            : {}),
        },
        ctx.trx,
      );
    } catch (error) {
      // A guard refusal is a RESULT, not a failure: the state machine did its
      // job (HARD RULE 12). `transition()` signals it by throwing, so if this
      // were left to the generic error path a rule that legitimately tries to
      // close not-yet-closable tickets would trip the circuit breaker after
      // five of them — punishing the rule for the state machine working.
      if (error instanceof ticketService.TransitionRefusedError) {
        return skipped('transition_refused', {
          to: toStatusSlug,
          reason: error.evaluation.reason ?? null,
          missingRequiredFields: error.evaluation.missingRequiredFields,
        });
      }
      throw error;
    }

    if (!result.decision.allowed) {
      return skipped('transition_refused', {
        to: toStatusSlug,
        reason: result.decision.reason ?? null,
        missingRequiredFields: result.decision.missingRequiredFields,
      });
    }

    await refreshTicket(ctx);
    return done({ from, to: ctx.ticket.statusSlug });
  },

  // ── routing ───────────────────────────────────────────────────────────────

  async assign_to_user(ctx, action, variables) {
    const username = String(renderValue(action.params.username, variables) ?? '').trim();
    if (!username) return skipped('missing_username');

    const user = await findUserByUsername(ctx.tenantId, username, ctx.trx);
    if (!user) return skipped('unknown_user', { username });
    if (ctx.ticket.assigneeId === user.id) return skipped('already_assigned', { username });

    return applyTicketPatch(ctx, {
      patch: { assigneeId: user.id },
      summary: { from: ctx.ticket.assigneeId, to: user.id, username: user.username },
    });
  },

  async assign_to_group(ctx, action, variables) {
    const slug = String(renderValue(action.params.group, variables) ?? '').trim();
    if (!slug) return skipped('missing_group');

    const group = await findGroupBySlug(ctx.tenantId, slug, ctx.trx);
    if (!group) return skipped('unknown_group', { group: slug });
    if (ctx.ticket.assignmentGroupId === group.id) return skipped('already_assigned', { group: slug });

    return applyTicketPatch(ctx, {
      patch: { assignmentGroupId: group.id },
      summary: { from: ctx.ticket.assignmentGroupId, to: group.id, groupSlug: group.slug },
    });
  },

  async assign_group_by_queue(ctx, action) {
    const map = isPlainObject(action.params.map) ? action.params.map : {};
    const queueSlug = ctx.ticket.queueSlug;
    const mapped = map[queueSlug] ?? map[queueSlug.toLowerCase()];
    const fallback = action.params.fallbackGroup;
    const target = String(mapped ?? fallback ?? '').trim();

    if (!target) {
      return skipped('no_mapping_for_queue', { queueSlug, mappedQueues: Object.keys(map) });
    }

    const group = await findGroupBySlug(ctx.tenantId, target, ctx.trx);
    if (!group) return skipped('unknown_group', { group: target, queueSlug });
    if (ctx.ticket.assignmentGroupId === group.id) {
      return skipped('already_assigned', { group: target });
    }

    return applyTicketPatch(ctx, {
      patch: { assignmentGroupId: group.id },
      summary: {
        queueSlug,
        via: mapped ? 'map' : 'fallback',
        from: ctx.ticket.assignmentGroupId,
        to: group.id,
        groupSlug: group.slug,
      },
    });
  },

  async move_to_queue(ctx, action, variables) {
    const queueSlug = String(renderValue(action.params.queue, variables) ?? '').trim();
    if (!queueSlug) return skipped('missing_queue');
    if (queueSlug === ctx.ticket.queueSlug) return skipped('already_in_queue', { queueSlug });

    const queue = await loadPublishedOne(ctx.tenantId, 'queue', queueSlug, ctx.trx);
    if (!queue) return skipped('unknown_queue', { queueSlug });

    return applyTicketPatch(ctx, {
      patch: { queueSlug },
      summary: { from: ctx.ticket.queueSlug, to: queueSlug },
    });
  },

  // ── labels and people ─────────────────────────────────────────────────────

  async add_tag(ctx, action, variables) {
    const wanted = asList(renderValue(action.params.tags, variables)).map((tag) => tag.trim());
    if (wanted.length === 0) return skipped('no_tags');

    const existing = currentTags(ctx.ticket);
    const additions = wanted.filter(
      (tag) => !existing.some((entry) => entry.toLowerCase() === tag.toLowerCase()),
    );
    if (additions.length === 0) return skipped('already_tagged', { tags: wanted });

    return applyTicketPatch(ctx, {
      patch: { data: { tags: [...existing, ...additions] } },
      summary: { added: additions, tags: [...existing, ...additions] },
    });
  },

  async remove_tag(ctx, action, variables) {
    const wanted = asList(renderValue(action.params.tags, variables)).map((tag) => tag.toLowerCase());
    if (wanted.length === 0) return skipped('no_tags');

    const existing = currentTags(ctx.ticket);
    const next = existing.filter((tag) => !wanted.includes(tag.toLowerCase()));
    if (next.length === existing.length) return skipped('not_tagged', { tags: wanted });

    return applyTicketPatch(ctx, {
      patch: { data: { tags: next } },
      summary: { removed: existing.filter((tag) => wanted.includes(tag.toLowerCase())), tags: next },
    });
  },

  async add_watcher(ctx, action, variables) {
    const reason = String(action.params.reason ?? 'rule') || 'rule';
    const userIds = new Set<number>();
    const contactIds = new Set<number>();
    const resolvedFrom: string[] = [];

    const username = action.params.username
      ? String(renderValue(action.params.username, variables)).trim()
      : '';
    if (username) {
      const user = await findUserByUsername(ctx.tenantId, username, ctx.trx);
      if (user) { userIds.add(user.id); resolvedFrom.push(`user:${username}`); }
    }

    const groupSlug = action.params.group ? String(action.params.group).trim() : '';
    if (groupSlug) {
      const group = await findGroupBySlug(ctx.tenantId, groupSlug, ctx.trx);
      if (group) {
        group.memberUserIds.forEach((id) => userIds.add(id));
        resolvedFrom.push(`group:${groupSlug}`);
      }
    }

    const role = action.params.role ? String(action.params.role) : '';
    if (role === 'assignee' && ctx.ticket.assigneeId) {
      userIds.add(ctx.ticket.assigneeId);
      resolvedFrom.push('role:assignee');
    } else if (role === 'requester') {
      if (ctx.ticket.requesterUserId) userIds.add(ctx.ticket.requesterUserId);
      if (ctx.ticket.requesterContactId) contactIds.add(ctx.ticket.requesterContactId);
      resolvedFrom.push('role:requester');
    } else if (role === 'manager' || role === 'admin') {
      const roles = role === 'manager' ? ['manager', 'admin'] : ['admin'];
      (await usersWithRole(ctx.tenantId, roles, ctx.trx)).forEach((id) => userIds.add(id));
      resolvedFrom.push(`role:${role}`);
    }

    if (userIds.size === 0 && contactIds.size === 0) {
      return skipped('no_watcher_resolved', { username, group: groupSlug, role });
    }

    if (ctx.dryRun) {
      return done({
        dryRun: true,
        wouldWatch: { userIds: [...userIds], contactIds: [...contactIds] },
        resolvedFrom,
      });
    }

    for (const userId of userIds) {
      await ticketService.addWatcher(ctx.tenantId, ctx.ticket.id, { userId, reason }, ctx.trx);
    }
    for (const contactId of contactIds) {
      await ticketService.addWatcher(ctx.tenantId, ctx.ticket.id, { contactId, reason }, ctx.trx);
    }
    return done({ userIds: [...userIds], contactIds: [...contactIds], resolvedFrom, reason });
  },

  // ── the timeline ──────────────────────────────────────────────────────────

  async post_public_reply(ctx, action, variables) {
    const bodyMd = renderTemplate(String(action.params.bodyMd ?? ''), variables).trim();
    if (!bodyMd) return skipped('empty_body');

    if (ctx.dryRun) return done({ dryRun: true, wouldPost: { visibility: 'public', bodyMd } });

    const entry = await ticketService.addJournalEntry(
      ctx.tenantId,
      ctx.actor,
      ctx.ticket.id,
      { kind: 'public_reply', visibility: 'public', bodyMd },
      ctx.trx,
    );
    // The reply may have stamped first_response_at; re-read so a later action
    // in the same pass does not write against a stale row_version.
    const refreshed = await ticketService.getById(ctx.tenantId, ctx.ticket.id, { executor: ctx.trx });
    if (refreshed) ctx.setTicket(refreshed);
    return done({ journalEntryId: entry.id, visibility: 'public' });
  },

  async post_work_note(ctx, action, variables) {
    const bodyMd = renderTemplate(String(action.params.bodyMd ?? ''), variables).trim();
    if (!bodyMd) return skipped('empty_body');

    if (ctx.dryRun) return done({ dryRun: true, wouldPost: { visibility: 'internal', bodyMd } });

    // An automation note goes in as kind `automation`, which the timeline
    // collapses. Filing every rule note as a work note is how a chatty rule
    // buries the three entries a human actually wrote.
    const asAutomation = action.params.automation !== false;

    if (asAutomation) {
      const entry = await journalService.append(
        {
          tenantId: ctx.tenantId,
          ticketId: ctx.ticket.id,
          kind: 'automation',
          visibility: 'internal',
          authorId: null,
          authorType: 'system',
          bodyMd,
          meta: { ruleSlug: ctx.ruleSlug, ruleVersion: ctx.ruleVersion },
        },
        ctx.trx,
      );
      return done({ journalEntryId: entry.id, visibility: 'internal', kind: 'automation' });
    }

    const entry = await ticketService.addJournalEntry(
      ctx.tenantId,
      ctx.actor,
      ctx.ticket.id,
      { kind: 'work_note', visibility: 'internal', bodyMd },
      ctx.trx,
    );
    return done({ journalEntryId: entry.id, visibility: 'internal', kind: 'work_note' });
  },

  async apply_macro(ctx, action) {
    const macroSlug = String(action.params.macro ?? '').trim();
    if (!macroSlug) return skipped('missing_macro');

    const macro = await loadPublishedOne(ctx.tenantId, 'macro', macroSlug, ctx.trx);
    if (!macro) return skipped('unknown_macro', { macro: macroSlug });

    const body = macro.body as Record<string, unknown>;
    const { actions, issues } = normalizeActions(body.actions);

    const nested: ActionResult[] = [];
    for (const inner of actions) {
      if (inner.disabled) continue;
      nested.push(await performAction({ ...ctx, depth: ctx.depth + 1 }, inner));
    }

    // The macro's canned journal entry, if it has one.
    const journal = isPlainObject(body.journal) ? body.journal : null;
    if (journal && !ctx.dryRun) {
      const bodyMd = String(journal.bodyMd ?? journal.body_md ?? '');
      if (bodyMd.trim() !== '') {
        await ticketService.addJournalEntry(
          ctx.tenantId,
          ctx.actor,
          ctx.ticket.id,
          {
            kind: journal.kind === 'public_reply' ? 'public_reply' : 'work_note',
            visibility: journal.visibility === 'public' ? 'public' : 'internal',
            bodyMd,
            macroSlug,
          },
          ctx.trx,
        );
      }
    }

    return done({
      macro: macroSlug,
      macroVersion: macro.version,
      nested,
      issues,
      performedCount: nested.filter((entry) => entry.performed).length,
    });
  },

  // ── the other engines ─────────────────────────────────────────────────────

  async send_notification(ctx, action, variables) {
    const templateSlug = String(action.params.template ?? '').trim();
    if (!templateSlug) return skipped('missing_template');

    const event = String(action.params.event ?? '') || `rule.${ctx.ruleSlug}`;
    const audience = asList(action.params.to);
    const channelTypes = asList(action.params.channelTypes);

    if (ctx.dryRun) {
      return done({
        dryRun: true,
        wouldSend: { template: templateSlug, event, audience, channelTypes },
      });
    }

    const result = await notificationService.dispatchTemplate({
      tenantId: ctx.tenantId,
      templateSlug,
      event,
      locale: action.params.locale ? String(action.params.locale) : undefined,
      variables,
      severity: (action.params.severity as 'info' | 'success' | 'warning' | 'critical' | undefined) ?? 'info',
      fields: {
        'ticket.queue_slug': ctx.ticket.queueSlug,
        'ticket.priority_slug': ctx.ticket.prioritySlug,
        'ticket.status_category': ctx.ticket.statusCategory,
        'ticket.record_type': ctx.ticket.recordType,
        'rule.slug': ctx.ruleSlug,
        // The bindings own delivery; this is the rule's request, expressed as a
        // field they can condition on rather than as a filter applied behind
        // their back.
        'notification.channel_types': channelTypes,
        'notification.audience': audience,
      },
      ticketId: ctx.ticket.id,
      trx: ctx.trx,
    });

    if (!result) return skipped('template_missing_or_disabled', { template: templateSlug });
    return done({
      template: templateSlug,
      event,
      audience,
      channelTypes,
      enqueued: result.enqueued.length,
      skippedChannels: result.skipped,
    });
  },

  async start_sla_target(ctx, action) {
    const targetSlug = String(action.params.target ?? '').trim();
    if (!targetSlug) return skipped('missing_target');

    if (ctx.dryRun) return done({ dryRun: true, wouldStart: targetSlug });

    const bridge = await slaBridge();
    if (!bridge?.startTarget) {
      // Deliberately NOT a hand-rolled clock. A due date invented without the
      // policy's calendar is worse than a missing one: it looks authoritative
      // and it is wrong, and every report downstream inherits the error.
      return skipped('sla_engine_unavailable', { target: targetSlug });
    }

    const instanceId = await bridge.startTarget({
      tenantId: ctx.tenantId,
      ticket: ctx.ticket,
      targetSlug,
      policySlug: action.params.policy ? String(action.params.policy) : null,
      reasonCode: String(action.params.reason ?? 'rule'),
      actorId: ctx.actor.userId ?? null,
      trx: ctx.trx,
    });
    return done({ target: targetSlug, instanceId: instanceId ?? null });
  },

  async pause_sla(ctx, action) {
    if (ctx.dryRun) return done({ dryRun: true, wouldPause: action.params.target ?? 'all' });
    const bridge = await slaBridge();
    if (!bridge?.pauseTarget) return skipped('sla_engine_unavailable');

    const result = await bridge.pauseTarget({
      tenantId: ctx.tenantId,
      ticketId: ctx.ticket.id,
      targetSlug: action.params.target ? String(action.params.target) : null,
      reasonCode: String(action.params.reason ?? 'rule'),
      actorId: ctx.actor.userId ?? null,
      trx: ctx.trx,
    });
    return done({ paused: result ?? null });
  },

  async resume_sla(ctx, action) {
    if (ctx.dryRun) return done({ dryRun: true, wouldResume: action.params.target ?? 'all' });
    const bridge = await slaBridge();
    if (!bridge?.resumeTarget) return skipped('sla_engine_unavailable');

    const result = await bridge.resumeTarget({
      tenantId: ctx.tenantId,
      ticketId: ctx.ticket.id,
      targetSlug: action.params.target ? String(action.params.target) : null,
      reasonCode: String(action.params.reason ?? 'rule'),
      actorId: ctx.actor.userId ?? null,
      trx: ctx.trx,
    });
    return done({ resumed: result ?? null });
  },

  async escalate(ctx, action, variables) {
    const slug = String(action.params.escalation ?? '').trim();
    if (!slug) return skipped('missing_escalation');

    const escalation = await loadPublishedOne(ctx.tenantId, 'escalation', slug, ctx.trx);
    if (!escalation) return skipped('unknown_escalation', { escalation: slug });

    const body = escalation.body as Record<string, unknown>;
    if (body.enabled === false) return skipped('escalation_disabled', { escalation: slug });

    const steps = Array.isArray(body.steps) ? body.steps.filter(isPlainObject) : [];
    const stepIndex = Math.max(0, Number(action.params.step ?? 0) || 0);
    const step = steps[stepIndex];
    if (!step) return skipped('no_such_step', { escalation: slug, step: stepIndex, steps: steps.length });

    const performed: Record<string, unknown> = { escalation: slug, step: stepIndex };

    // 1 — watchers, so the people being escalated to can see the thread.
    const notify = Array.isArray(step.notify) ? step.notify.filter(isPlainObject) : [];
    const watchers: number[] = [];
    for (const target of notify) {
      const kind = String(target.kind ?? '');
      const ref = target.ref ? String(target.ref) : '';
      if (kind === 'user' && ref) {
        const user = await findUserByUsername(ctx.tenantId, ref, ctx.trx);
        if (user) watchers.push(user.id);
      } else if (kind === 'assignment_group' && ref) {
        const group = await findGroupBySlug(ctx.tenantId, ref, ctx.trx);
        if (group) watchers.push(...group.memberUserIds);
      } else if (kind === 'assignee' && ctx.ticket.assigneeId) {
        watchers.push(ctx.ticket.assigneeId);
      } else if (kind === 'manager_of_assignee') {
        watchers.push(...(await usersWithRole(ctx.tenantId, ['manager', 'admin'], ctx.trx)));
      }
    }
    performed.watchers = watchers;

    // 2 — the priority bump the rung asks for, through the same patch path as
    //     every other field change, so it is versioned and logged identically.
    const raiseTo = step.raisePriorityTo ?? step.raise_priority_to;
    if (typeof raiseTo === 'string' && raiseTo && raiseTo !== ctx.ticket.prioritySlug) {
      const patched = await applyTicketPatch(ctx, {
        patch: { prioritySlug: raiseTo, priorityOverrideReason: `escalation:${slug}` },
        summary: { from: ctx.ticket.prioritySlug, to: raiseTo },
      });
      performed.priority = patched.detail;
    }

    if (ctx.dryRun) {
      return done({ ...performed, dryRun: true, wouldNotify: notify.length });
    }

    for (const userId of watchers) {
      await ticketService.addWatcher(
        ctx.tenantId, ctx.ticket.id, { userId, reason: 'escalation' }, ctx.trx,
      );
    }

    // 3 — the notification the rung declares.
    const templateSlug = step.templateSlug ?? step.template_slug ?? step.template;
    if (typeof templateSlug === 'string' && templateSlug) {
      const dispatched = await notificationService.dispatchTemplate({
        tenantId: ctx.tenantId,
        templateSlug,
        event: `escalation.${slug}`,
        variables,
        severity: 'warning',
        ticketId: ctx.ticket.id,
        trx: ctx.trx,
      });
      performed.notified = dispatched ? dispatched.enqueued.length : 0;
    }

    return done(performed);
  },

  /**
   * DELEGATES to `approval.service`. There is exactly one implementation of
   * "start an approval", and this is not it: approver resolution, quorum,
   * stage ordering and the refusal-rather-than-park behaviour all live there,
   * and a second copy here would be the fragmentation this whole slice rejects.
   */
  async request_approval(ctx, action) {
    const slug = String(action.params.approval ?? '').trim();
    if (!slug) return skipped('missing_approval');

    const definition = await loadPublishedOne(ctx.tenantId, 'approval', slug, ctx.trx);
    if (!definition) return skipped('unknown_approval', { approval: slug });

    // One pending approval per (ticket, definition) — the service enforces this
    // too, but a dry run must be able to say so without calling it.
    const existing = await scoped('approvals', ctx.tenantId, ctx.trx)
      .where('approvals.ticket_id', ctx.ticket.id)
      .where('approvals.definition_slug', slug)
      .where('approvals.state', 'pending')
      .first('id');
    if (existing) return skipped('already_pending', { approval: slug });

    if (ctx.dryRun) {
      return done({ dryRun: true, wouldRequest: { approval: slug } });
    }

    const result = await approvalService.startApproval({
      tenantId: ctx.tenantId,
      ticketId: ctx.ticket.id,
      definitionSlug: slug,
      actorId: ctx.actor.userId ?? null,
      actorType: 'automation',
      correlationId: ctx.correlationId,
      // The rule's own `when` IS the requirement test. Re-asking the
      // definition's `requiredWhen` would mean a rule can name an approval and
      // then quietly not start it, which is the worst of both models.
      force: true,
      trx: ctx.trx,
    });

    if (!result.started) return skipped(result.reason, { approval: slug });
    return done({
      approval: slug,
      approvalId: result.approval?.id ?? null,
      state: result.approval?.state ?? null,
      steps: result.approval?.steps?.length ?? 0,
    });
  },

  // ── other tickets ─────────────────────────────────────────────────────────

  async link_ticket(ctx, action, variables) {
    const number = renderTemplate(String(action.params.ticketNumber ?? ''), variables).trim();
    if (!number) return skipped('missing_ticket_number');

    const linkKind = String(action.params.linkKind ?? 'related');
    if (linkKind === 'merged_from') return skipped('forbidden_link_kind', { linkKind });

    const other = await ticketService.getByNumber(ctx.tenantId, number, ctx.trx);
    if (!other) return skipped('unknown_ticket', { number });
    if (other.id === ctx.ticket.id) return skipped('self_link', { number });

    if (ctx.dryRun) return done({ dryRun: true, wouldLink: { number, linkKind } });

    await ticketService.addLink(
      ctx.tenantId, ctx.actor, ctx.ticket.id, { toTicketId: other.id, kind: linkKind }, ctx.trx,
    );
    return done({ number, toTicketId: other.id, linkKind });
  },

  async create_child_ticket(ctx, action, variables) {
    const subject = renderTemplate(String(action.params.subject ?? ''), variables).trim();
    if (!subject) return skipped('missing_subject');

    const queueSlug = action.params.queue ? String(action.params.queue) : ctx.ticket.queueSlug;
    const groupSlug = action.params.group ? String(action.params.group) : '';
    const group = groupSlug ? await findGroupBySlug(ctx.tenantId, groupSlug, ctx.trx) : null;

    const payload: ticketService.CreateTicketInput = {
      subject,
      recordType: (String(action.params.recordType ?? 'task') as ticketService.CreateTicketInput['recordType']),
      queueSlug,
      prioritySlug: action.params.priority ? String(action.params.priority) : ctx.ticket.prioritySlug,
      descriptionMd: action.params.descriptionMd
        ? renderTemplate(String(action.params.descriptionMd), variables)
        : null,
      // HARD RULE 6 — the child is about the same event, so it inherits WHEN it
      // happened. Stamping now() would make the child look like a fresh
      // incident and inflate every "time to detect" number that reads it.
      occurredAt: ctx.ticket.occurredAt,
      parentTicketId: ctx.ticket.id,
      organizationId: ctx.ticket.organizationId,
      requesterContactId: ctx.ticket.requesterContactId,
      assignmentGroupId: group ? group.id : null,
      source: 'api',
      ruleSlug: ctx.ruleSlug,
    };

    if (ctx.dryRun) {
      return done({ dryRun: true, wouldCreate: { subject, queueSlug, parentTicketId: ctx.ticket.id } });
    }

    const child = await ticketService.create(ctx.tenantId, ctx.actor, payload, ctx.trx);

    const linkKind = String(action.params.linkKind ?? 'child');
    if (linkKind !== 'merged_from') {
      await ticketService.addLink(
        ctx.tenantId, ctx.actor, ctx.ticket.id, { toTicketId: child.id, kind: linkKind }, ctx.trx,
      );
    }

    return done({ childTicketId: child.id, number: child.number, queueSlug, linkKind });
  },

  // ── outside the desk ──────────────────────────────────────────────────────

  async webhook_out(ctx, action, variables) {
    const url = String(renderValue(action.params.url, variables) ?? '').trim();
    if (!url) return skipped('missing_url');
    if (!/^https:\/\//i.test(url)) {
      return skipped('insecure_url', {
        url,
        why: 'https only — a webhook carries ticket content off the desk.',
      });
    }

    const event = String(action.params.event ?? '') || `rule.${ctx.ruleSlug}`;
    const title = action.params.title
      ? renderTemplate(String(action.params.title), variables)
      : `${ctx.ticket.number} — ${ctx.ticket.subject}`;
    const body = action.params.body
      ? renderTemplate(String(action.params.body), variables)
      : `${ctx.ticket.number} (${ctx.ticket.statusSlug}, ${ctx.ticket.prioritySlug})`;

    if (ctx.dryRun) return done({ dryRun: true, wouldPost: { url, event, title } });

    // ENQUEUED, never sent inline. `ctx.trx` is a live ticket transaction: an
    // outbound HTTP call here would hold row locks for as long as somebody
    // else's server takes to answer, which is unbounded by definition.
    const outboxId = await notificationService.enqueue(
      ctx.tenantId,
      'webhook',
      {
        url,
        secret: action.params.secret ? String(action.params.secret) : undefined,
        notification: {
          event,
          appName: config.appName,
          tenantSlug: ctx.tenantSlug ?? '',
          tenantName: ctx.tenantName ?? '',
          title,
          body,
          severity: String(action.params.severity ?? 'info'),
          occurredAt: ctx.now,
          locale: 'fr',
          ticket: {
            id: ctx.ticket.id,
            number: ctx.ticket.number,
            subject: ctx.ticket.subject,
            statusSlug: ctx.ticket.statusSlug,
            prioritySlug: ctx.ticket.prioritySlug,
          },
        },
      },
      ctx.trx,
    );

    return done({ url, event, outboxId });
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — The one door every action goes through
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Perform one action and return what it did.
 *
 * HARD RULE 2 — the `decision_log` row is written HERE, on the action's own
 * code path, inside the action's own transaction, whether it succeeded, was
 * skipped, or threw. The Why drawer can therefore name the rule, the version
 * and the parameter that touched a field without replaying anything.
 *
 * Errors do NOT escape: one broken action must not abandon the rest of the
 * rule, and it must not take the ticket down with it. The error becomes the
 * result, and the caller decides whether that trips the circuit breaker.
 * Guardrail errors are the deliberate exception — they mean "stop", and
 * swallowing a stop signal is how a loop guard becomes decorative.
 */
export async function performAction(
  ctx: ActionContext,
  action: NormalizedAction,
): Promise<ActionResult> {
  const definition = RULE_ACTION_CATALOGUE[action.kind];
  const started = Date.now();

  if (action.disabled) {
    return {
      index: action.index, kind: action.kind, performed: false,
      skipped: 'disabled', detail: {}, durationMs: 0,
    };
  }

  const paramIssues = validateActionParams(action);
  if (paramIssues.some((issue) => issue.code === 'missing_param' || issue.code === 'forbidden_param')) {
    return {
      index: action.index, kind: action.kind, performed: false,
      skipped: 'invalid_params', detail: { issues: paramIssues }, durationMs: Date.now() - started,
    };
  }

  // The budget is charged BEFORE the work, not after: an action that runs and
  // then discovers it was over budget has already had its effect.
  ctx.spend(action.kind, definition.budgetCost);

  const variables = buildTemplateVariables({
    ticket: ctx.ticket,
    actor: ctx.actor,
    ruleSlug: ctx.ruleSlug,
    ruleVersion: ctx.ruleVersion,
    now: ctx.now,
    tenantSlug: ctx.tenantSlug,
  });

  return withDecision(
    {
      tenantId: ctx.tenantId,
      ticketId: ctx.ticket.id,
      subsystem: subsystemFor(action.kind),
      decision: `${action.kind} (rule:${ctx.ruleSlug})`,
      ruleSlug: ctx.ruleSlug,
      ruleVersion: ctx.ruleVersion,
      actorId: ctx.actor.userId ?? null,
      actorType: ctx.actor.actorType,
      correlationId: ctx.correlationId,
      trx: ctx.trx,
      inputs: {
        trigger: ctx.trigger,
        action: action.kind,
        params: action.params,
        dryRun: ctx.dryRun,
        depth: ctx.depth,
      },
    },
    async (recorder): Promise<ActionResult> => {
      try {
        const outcome = await PERFORMERS[action.kind](ctx, action, variables);
        const result: ActionResult = {
          index: action.index,
          kind: action.kind,
          durationMs: Date.now() - started,
          ...outcome,
        };

        if (result.performed) {
          recorder.outcome({ performed: true, ...result.detail });
        } else if (result.skipped) {
          // "Ran, changed nothing, and here is why" is evidence, not noise.
          // Without it, an action that never fires is indistinguishable from
          // an action that was never configured.
          recorder.noop(result.skipped);
          recorder.outcome({ performed: false, skipped: result.skipped, ...result.detail });
        }
        return result;
      } catch (error) {
        if (error instanceof GuardrailError) {
          recorder.suppressed(error.code);
          recorder.outcome({ guardrail: error.code, ...error.detail });
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        log.warn(
          { ruleSlug: ctx.ruleSlug, action: action.kind, ticketId: ctx.ticket.id, err: message },
          'rule action failed',
        );
        recorder.outcome({ performed: false, error: message });
        return {
          index: action.index,
          kind: action.kind,
          performed: false,
          error: message,
          detail: { params: action.params },
          durationMs: Date.now() - started,
        };
      }
    },
  );
}

/**
 * Which subsystem owns the decision row. Routing decisions belong under
 * `routing` and escalations under `escalation` even when a rule triggered
 * them, because the operator asking "why was this assigned here?" filters by
 * what happened, not by what caused it.
 */
function subsystemFor(kind: RuleActionKind): string {
  switch (kind) {
    case 'assign_to_user':
    case 'assign_to_group':
    case 'assign_group_by_queue':
    case 'move_to_queue':
      return 'routing';
    case 'set_priority':
      return 'priority';
    case 'start_sla_target':
    case 'pause_sla':
    case 'resume_sla':
      return 'sla';
    case 'escalate':
      return 'escalation';
    case 'request_approval':
      return 'approval';
    case 'transition_to':
      return 'workflow';
    default:
      return 'rule';
  }
}

/** Resolve the tenant's identity once per run (HARD RULE 13 — by slug). */
export async function resolveTenantIdentity(
  tenantId: number,
  executor: Executor = db,
): Promise<{ slug: string; name: string }> {
  return tenantIdentity(tenantId, executor);
}

/** Re-exported so `rule.service.ts` can hand a condition tree straight through. */
export type { ConditionNode };
