import type { Knex } from 'knex';
import { createHash } from 'crypto';

import { DEFAULT_TENANT_SLUG, DEFAULT_ASSIGNMENT_GROUP_SLUG } from './01_core';

/**
 * 02_baseline_config.ts — the day-one Oblidesk baseline.
 *
 * ── What this file IS ────────────────────────────────────────────────────────
 * The entire out-of-the-box configuration of the desk, written as
 * config_objects rows with is_system = true, in EXACTLY the JSON shape an admin
 * will later get when they hit "Export configuration". Import and export are
 * therefore the same code path as this seed — if a body cannot round-trip
 * through here, it is malformed.
 *
 * It is deliberately small enough to read end to end in twenty minutes. That is
 * a design constraint, not an accident: a baseline nobody has read is a baseline
 * nobody can safely change.
 *
 * ── Rules this file obeys ────────────────────────────────────────────────────
 *  • HARD RULE 3  — every cross-reference inside a body is by human SLUG.
 *    There is not one numeric id anywhere in these bodies.
 *  • HARD RULE 4  — every row carries body_format_version. Bumping a body shape
 *    without bumping the version is a defect; BODY_FORMAT_VERSIONS below is the
 *    single place that number lives.
 *  • HARD RULE 5  — every status carries a mandatory hard-coded CATEGORY, and
 *    `category_semantics` on the state machine spells out what each category
 *    means to the engines. Engines key off the category, never the slug.
 *  • HARD RULE 10 — every user-visible string in a body is a { en, fr } map, so
 *    the client can feed it to t() with an English fallback.
 *  • HARD RULE 12 — required-ness lives ONLY on a transition's required_fields.
 *    No field object says "required: true"; inline edits must never validate it.
 *
 * IDEMPOTENT: ON CONFLICT (tenant_id, kind, slug) DO NOTHING. Re-running never
 * clobbers an admin's edits to a system object — shipping a NEW baseline is an
 * explicit upgrade action, not a side effect of a restart.
 */

// ═════════════════════════════════════════════════════════════════════════════
// The condition language
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ConditionNode — the one shape used by every guard, filter and rule predicate
 * in the whole product. Mirrors `ConditionNode` in @oblidesk/shared.
 *
 * One uniform node:
 *   group : { op: 'and' | 'or', children: ConditionNode[] }
 *   negate: { op: 'not', children: [ConditionNode] }
 *   leaf  : { op: <comparison>, field: string, value?: unknown }
 *
 * Field paths are dotted and namespaced:
 *   ticket.<column>          e.g. ticket.status_category, ticket.assignee_id
 *   ticket.data.<field slug> e.g. ticket.data.vendor_ref
 *   actor.<attr>             e.g. actor.role, actor.type
 *   context.<derived>        engine-computed, e.g. context.business_minutes_since_created
 *
 * Values may use a token instead of a literal:
 *   '@me'         the acting user
 *   '@my_groups'  every assignment group the acting user belongs to
 *   '@now'        evaluation time
 *   '@now+2h'     evaluation time plus an offset (m | h | d, business-time aware
 *                 when the surrounding object names a calendar)
 */
export type ConditionOp =
  | 'and' | 'or' | 'not'
  | 'eq' | 'ne' | 'in' | 'not_in'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'starts_with' | 'matches'
  | 'is_empty' | 'is_not_empty' | 'changed';

export interface ConditionNode {
  op: ConditionOp;
  field?: string;
  value?: unknown;
  children?: ConditionNode[];
}

const and = (...children: ConditionNode[]): ConditionNode => ({ op: 'and', children });
const or = (...children: ConditionNode[]): ConditionNode => ({ op: 'or', children });
const eq = (field: string, value: unknown): ConditionNode => ({ op: 'eq', field, value });
const ne = (field: string, value: unknown): ConditionNode => ({ op: 'ne', field, value });
const oneOf = (field: string, value: unknown[]): ConditionNode => ({ op: 'in', field, value });
const gte = (field: string, value: unknown): ConditionNode => ({ op: 'gte', field, value });
const lte = (field: string, value: unknown): ConditionNode => ({ op: 'lte', field, value });
const isEmpty = (field: string): ConditionNode => ({ op: 'is_empty', field });
const isNotEmpty = (field: string): ConditionNode => ({ op: 'is_not_empty', field });

/** Categories a ticket is "live" in. Mirrors OPEN_CATEGORIES in migration 002. */
const OPEN_CATEGORIES = [
  'new',
  'open',
  'pending_requester',
  'pending_third_party',
  'scheduled',
] as const;

const AGENT_ROLES = ['agent', 'manager', 'admin'] as const;

// ═════════════════════════════════════════════════════════════════════════════
// Body format versions (HARD RULE 4)
// ═════════════════════════════════════════════════════════════════════════════

export type ConfigKind =
  | 'field' | 'form' | 'view' | 'rule' | 'sla' | 'state_machine' | 'queue'
  | 'priority_matrix' | 'alert_binding' | 'catalog_item' | 'notification_template'
  | 'dashboard' | 'macro' | 'calendar' | 'escalation' | 'approval';

/**
 * The body shape version PER KIND. Changing the shape of a body without bumping
 * its number here is the defect HARD RULE 4 exists to prevent: readers key off
 * this to decide which parser to use, and a silently-changed shape makes every
 * previously-exported bundle unreadable.
 */
export const BODY_FORMAT_VERSIONS: Record<ConfigKind, number> = {
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

type Localized = { en: string; fr: string };

interface BaselineObject {
  kind: ConfigKind;
  slug: string;
  name: string;
  description: string;
  body: Record<string, unknown>;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1 — state_machine 'default'
// ═════════════════════════════════════════════════════════════════════════════

const STATE_MACHINE_DEFAULT: BaselineObject = {
  kind: 'state_machine',
  slug: 'default',
  name: 'Default lifecycle',
  description: 'The ticket lifecycle every record type starts on.',
  body: {
    label: { en: 'Default lifecycle', fr: 'Cycle de vie par défaut' } satisfies Localized,
    applies_to_record_types: ['incident', 'request', 'problem', 'change', 'task', 'release'],
    initial_status: 'new',

    /**
     * HARD RULE 5 made explicit. Statuses are configurable; these eight
     * categories are not. Every engine reads THIS map, never a status slug —
     * which is why renaming 'pending_vendor' to 'waiting_on_supplier' cannot
     * break the SLA clock.
     */
    category_semantics: {
      new: { sla: 'running', counts_as_open: true, terminal: false },
      open: { sla: 'running', counts_as_open: true, terminal: false },
      pending_requester: { sla: 'paused', counts_as_open: true, terminal: false },
      pending_third_party: { sla: 'paused', counts_as_open: true, terminal: false },
      scheduled: { sla: 'paused', counts_as_open: true, terminal: false },
      resolved: { sla: 'stopped', counts_as_open: false, terminal: false },
      closed: { sla: 'stopped', counts_as_open: false, terminal: true },
      cancelled: { sla: 'cancelled', counts_as_open: false, terminal: true },
    },

    statuses: [
      {
        slug: 'new', category: 'new', order: 10, tone: 'accent',
        label: { en: 'New', fr: 'Nouveau' },
        description: { en: 'Filed, not yet looked at.', fr: 'Créé, pas encore consulté.' },
      },
      {
        slug: 'triage', category: 'open', order: 20, tone: 'info',
        label: { en: 'Triage', fr: 'Tri' },
        description: { en: 'Being classified and routed.', fr: 'En cours de qualification et de routage.' },
      },
      {
        slug: 'in_progress', category: 'open', order: 30, tone: 'info',
        label: { en: 'In Progress', fr: 'En cours' },
        description: { en: 'Someone is actively working it.', fr: 'Quelqu’un y travaille activement.' },
      },
      {
        slug: 'pending_requester', category: 'pending_requester', order: 40, tone: 'warn',
        label: { en: 'Pending Requester', fr: 'En attente du demandeur' },
        description: { en: 'Waiting on the person who reported it.', fr: 'En attente de la personne à l’origine du signalement.' },
      },
      {
        slug: 'pending_vendor', category: 'pending_third_party', order: 50, tone: 'warn',
        label: { en: 'Pending Vendor', fr: 'En attente du fournisseur' },
        description: { en: 'Waiting on a third party we do not control.', fr: 'En attente d’un tiers hors de notre contrôle.' },
      },
      {
        slug: 'scheduled', category: 'scheduled', order: 60, tone: 'pending',
        label: { en: 'Scheduled', fr: 'Planifié' },
        description: { en: 'Work is booked for a future date.', fr: 'Intervention planifiée à une date future.' },
      },
      {
        slug: 'resolved', category: 'resolved', order: 70, tone: 'success',
        label: { en: 'Resolved', fr: 'Résolu' },
        description: { en: 'Fixed, awaiting confirmation.', fr: 'Corrigé, en attente de confirmation.' },
      },
      {
        slug: 'closed', category: 'closed', order: 80, tone: 'neutral',
        label: { en: 'Closed', fr: 'Fermé' },
        description: { en: 'Finished and confirmed.', fr: 'Terminé et confirmé.' },
      },
      {
        slug: 'cancelled', category: 'cancelled', order: 90, tone: 'neutral',
        label: { en: 'Cancelled', fr: 'Annulé' },
        description: { en: 'Withdrawn without a fix.', fr: 'Abandonné sans correction.' },
      },
    ],

    /**
     * HARD RULE 12 lives here. `required_fields` is the ONLY place required-ness
     * is declared, and the same evaluator runs it on the client (to grey out the
     * button and say what is missing) and on the server (to reject the
     * transition). Inline field edits never consult it.
     */
    transitions: [
      {
        slug: 'triage', from: ['new'], to: 'triage',
        label: { en: 'Start triage', fr: 'Démarrer le tri' },
        allowed_roles: [...AGENT_ROLES],
        guard: null,
        required_fields: [],
      },
      {
        slug: 'start', from: ['new', 'triage'], to: 'in_progress',
        label: { en: 'Start work', fr: 'Commencer le travail' },
        allowed_roles: [...AGENT_ROLES],
        // A change cannot start until its approval came back green. Every other
        // record type passes this guard trivially.
        guard: or(
          ne('ticket.record_type', 'change'),
          eq('context.approval_state', 'approved'),
        ),
        required_fields: ['ticket.assignee_id', 'ticket.queue_slug'],
      },
      {
        slug: 'await_requester', from: ['triage', 'in_progress'], to: 'pending_requester',
        label: { en: 'Wait for requester', fr: 'Attendre le demandeur' },
        allowed_roles: [...AGENT_ROLES],
        // Parking a ticket on the requester without ever having asked them
        // anything is how backlogs get laundered. At least one public reply.
        guard: gte('context.public_reply_count', 1),
        required_fields: [],
      },
      {
        slug: 'await_vendor', from: ['triage', 'in_progress'], to: 'pending_vendor',
        label: { en: 'Wait for vendor', fr: 'Attendre le fournisseur' },
        allowed_roles: [...AGENT_ROLES],
        guard: null,
        required_fields: ['ticket.data.vendor_ref'],
      },
      {
        slug: 'schedule', from: ['triage', 'in_progress'], to: 'scheduled',
        label: { en: 'Schedule', fr: 'Planifier' },
        allowed_roles: [...AGENT_ROLES],
        guard: null,
        required_fields: ['ticket.due_at'],
      },
      {
        slug: 'resume',
        from: ['pending_requester', 'pending_vendor', 'scheduled'], to: 'in_progress',
        label: { en: 'Resume work', fr: 'Reprendre le travail' },
        allowed_roles: [...AGENT_ROLES],
        guard: null,
        required_fields: [],
      },
      {
        slug: 'resolve',
        from: ['triage', 'in_progress', 'pending_requester', 'pending_vendor', 'scheduled'],
        to: 'resolved',
        label: { en: 'Resolve', fr: 'Résoudre' },
        allowed_roles: [...AGENT_ROLES],
        guard: null,
        required_fields: ['ticket.assignee_id', 'ticket.resolution_code', 'ticket.resolution_md'],
      },
      {
        slug: 'auto_resolve_stale', from: ['pending_requester'], to: 'resolved',
        label: { en: 'Auto-resolve (no response)', fr: 'Résolution auto (sans réponse)' },
        allowed_actor_types: ['automation'],
        guard: gte('context.business_days_in_status', 5),
        // required_fields is empty because `effects` supplies the resolution
        // itself — an automation must never be able to skip a required field it
        // simply has not got.
        required_fields: [],
        effects: [
          { type: 'set_field', field: 'ticket.resolution_code', value: 'no_response' },
          {
            type: 'set_field', field: 'ticket.resolution_md',
            value: {
              en: 'Resolved automatically: no response from the requester for 5 business days.',
              fr: 'Résolu automatiquement : aucune réponse du demandeur pendant 5 jours ouvrés.',
            },
          },
        ],
      },
      {
        slug: 'close', from: ['resolved'], to: 'closed',
        label: { en: 'Close', fr: 'Fermer' },
        allowed_roles: [...AGENT_ROLES],
        guard: null,
        required_fields: [],
      },
      {
        slug: 'auto_close', from: ['resolved'], to: 'closed',
        label: { en: 'Auto-close', fr: 'Fermeture auto' },
        allowed_actor_types: ['automation'],
        guard: gte('context.business_days_in_status', 5),
        required_fields: [],
      },
      {
        slug: 'reopen', from: ['resolved', 'closed'], to: 'in_progress',
        label: { en: 'Reopen', fr: 'Réouvrir' },
        allowed_roles: [...AGENT_ROLES, 'user'],
        // An agent may always reopen. A requester may reopen their own ticket
        // for 14 business days, after which they have to file a new one — this
        // is what stops a two-year-old ticket coming back to life.
        guard: or(
          oneOf('actor.role', [...AGENT_ROLES]),
          and(
            eq('actor.type', 'contact'),
            lte('context.business_days_since_closed', 14),
          ),
        ),
        required_fields: [],
        effects: [{ type: 'increment_field', field: 'ticket.reopen_count', value: 1 }],
      },
      {
        slug: 'cancel',
        from: ['new', 'triage', 'in_progress', 'pending_requester', 'pending_vendor', 'scheduled'],
        to: 'cancelled',
        label: { en: 'Cancel', fr: 'Annuler' },
        allowed_roles: [...AGENT_ROLES],
        guard: null,
        // Cancelling without saying why turns the metric into noise.
        required_fields: ['ticket.resolution_md'],
      },
      {
        slug: 'reinstate', from: ['cancelled'], to: 'triage',
        label: { en: 'Reinstate', fr: 'Rétablir' },
        allowed_roles: ['manager', 'admin'],
        guard: null,
        required_fields: [],
      },
    ],
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// 2 — priority_matrix 'default'
// ═════════════════════════════════════════════════════════════════════════════

const PRIORITY_MATRIX_DEFAULT: BaselineObject = {
  kind: 'priority_matrix',
  slug: 'default',
  name: 'Impact × urgency',
  description: 'Derives P1..P4 from impact and urgency. The agent picks two words, not a number.',
  body: {
    label: { en: 'Impact × urgency', fr: 'Impact × urgence' } satisfies Localized,
    impacts: [
      { slug: 'high', order: 10, label: { en: 'High — a site or a service', fr: 'Élevé — un site ou un service' } },
      { slug: 'medium', order: 20, label: { en: 'Medium — a team', fr: 'Moyen — une équipe' } },
      { slug: 'low', order: 30, label: { en: 'Low — one person', fr: 'Faible — une personne' } },
    ],
    urgencies: [
      { slug: 'high', order: 10, label: { en: 'High — blocked now', fr: 'Élevée — bloqué maintenant' } },
      { slug: 'medium', order: 20, label: { en: 'Medium — degraded', fr: 'Moyenne — dégradé' } },
      { slug: 'low', order: 30, label: { en: 'Low — can wait', fr: 'Faible — peut attendre' } },
    ],
    priorities: [
      { slug: 'p1', order: 10, tone: 'critical', label: { en: 'P1 — Critical', fr: 'P1 — Critique' } },
      { slug: 'p2', order: 20, tone: 'high', label: { en: 'P2 — High', fr: 'P2 — Élevée' } },
      { slug: 'p3', order: 30, tone: 'normal', label: { en: 'P3 — Normal', fr: 'P3 — Normale' } },
      { slug: 'p4', order: 40, tone: 'low', label: { en: 'P4 — Low', fr: 'P4 — Faible' } },
    ],
    // matrix[impact][urgency] -> priority slug
    matrix: {
      high: { high: 'p1', medium: 'p2', low: 'p3' },
      medium: { high: 'p2', medium: 'p3', low: 'p4' },
      low: { high: 'p3', medium: 'p4', low: 'p4' },
    },
    default_impact: 'medium',
    default_urgency: 'medium',
    default_priority: 'p3',
    // An agent who overrides the derived priority has to say why; the override
    // and the reason both land in decision_log on the same code path.
    allow_manual_override: true,
    override_requires_reason: true,
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// 3 — queues
// ═════════════════════════════════════════════════════════════════════════════

interface QueueSpec {
  slug: string;
  order: number;
  isDefault: boolean;
  label: Localized;
  description: Localized;
}

const QUEUE_SPECS: QueueSpec[] = [
  {
    slug: 'general', order: 10, isDefault: true,
    label: { en: 'General', fr: 'Général' },
    description: { en: 'Everything that has not been routed anywhere else.', fr: 'Tout ce qui n’a pas été routé ailleurs.' },
  },
  {
    slug: 'network', order: 20, isDefault: false,
    label: { en: 'Network', fr: 'Réseau' },
    description: { en: 'Connectivity, firewalls, VPN, Wi-Fi.', fr: 'Connectivité, pare-feu, VPN, Wi-Fi.' },
  },
  {
    slug: 'security', order: 30, isDefault: false,
    label: { en: 'Security', fr: 'Sécurité' },
    description: { en: 'Suspected compromise, phishing, access abuse.', fr: 'Suspicion de compromission, hameçonnage, abus d’accès.' },
  },
  {
    slug: 'onboarding', order: 40, isDefault: false,
    label: { en: 'Onboarding', fr: 'Intégration' },
    description: { en: 'Joiners, movers, leavers.', fr: 'Arrivées, mobilités, départs.' },
  },
];

const QUEUES: BaselineObject[] = QUEUE_SPECS.map((q) => ({
  kind: 'queue',
  slug: q.slug,
  name: q.label.en,
  description: q.description.en,
  body: {
    label: q.label,
    description: q.description,
    order: q.order,
    is_default: q.isDefault,
    // Every cross-reference by SLUG (HARD RULE 3).
    default_assignment_group: DEFAULT_ASSIGNMENT_GROUP_SLUG,
    default_sla_policy: 'standard',
    default_calendar: q.slug === 'security' ? '24x7' : 'business',
    default_state_machine: 'default',
    default_priority_matrix: 'default',
    default_form: 'incident_default',
    accepts_record_types: ['incident', 'request', 'problem', 'change', 'task', 'release'],
    // A queue nobody owns is a queue nobody empties.
    visible_to_groups: [DEFAULT_ASSIGNMENT_GROUP_SLUG],
  },
}));

// ═════════════════════════════════════════════════════════════════════════════
// 4 — saved views
// ═════════════════════════════════════════════════════════════════════════════

const DEFAULT_COLUMNS = [
  'number', 'subject', 'status_slug', 'priority_slug',
  'assignee_id', 'queue_slug', 'due_at', 'updated_at',
];

function view(
  slug: string,
  order: number,
  label: Localized,
  description: Localized,
  filter: ConditionNode,
  overrides: Record<string, unknown> = {},
): BaselineObject {
  return {
    kind: 'view',
    slug,
    name: label.en,
    description: description.en,
    body: {
      label,
      description,
      scope: 'tickets',
      filter,
      columns: DEFAULT_COLUMNS,
      sort: [{ field: 'updated_at', dir: 'desc' }],
      group_by: null,
      page_size: 50,
      show_in_sidebar: true,
      count_badge: true,
      order,
      ...overrides,
    },
  };
}

const openFilter = oneOf('ticket.status_category', [...OPEN_CATEGORIES]);

const VIEWS: BaselineObject[] = [
  view(
    'my_open', 10,
    { en: 'My open tickets', fr: 'Mes tickets ouverts' },
    { en: 'Everything assigned to you that is not finished.', fr: 'Tout ce qui vous est assigné et n’est pas terminé.' },
    and(openFilter, eq('ticket.assignee_id', '@me')),
    { sort: [{ field: 'due_at', dir: 'asc' }, { field: 'updated_at', dir: 'desc' }] },
  ),
  view(
    'unassigned', 20,
    { en: 'Unassigned', fr: 'Non assignés' },
    { en: 'Live tickets nobody has picked up yet.', fr: 'Tickets actifs que personne n’a pris en charge.' },
    and(openFilter, isEmpty('ticket.assignee_id')),
    { sort: [{ field: 'created_at', dir: 'asc' }] },
  ),
  view(
    'breaching_soon', 30,
    { en: 'Breaching soon', fr: 'Bientôt hors SLA' },
    { en: 'Live tickets whose SLA is due within two business hours.', fr: 'Tickets actifs dont le SLA échoit dans les deux heures ouvrées.' },
    and(openFilter, isNotEmpty('ticket.due_at'), lte('ticket.due_at', '@now+2h')),
    {
      sort: [{ field: 'due_at', dir: 'asc' }],
      columns: [...DEFAULT_COLUMNS, 'assignment_group_id'],
      tone: 'danger',
    },
  ),
  view(
    'pending_requester', 40,
    { en: 'Waiting on requester', fr: 'En attente du demandeur' },
    { en: 'Parked on someone outside the team — check it is still true.', fr: 'En attente d’une personne hors de l’équipe — vérifiez que c’est toujours le cas.' },
    eq('ticket.status_category', 'pending_requester'),
    { sort: [{ field: 'updated_at', dir: 'asc' }] },
  ),
  view(
    'all_open', 50,
    { en: 'All open', fr: 'Tous les ouverts' },
    { en: 'Every live ticket in every queue you can see.', fr: 'Tous les tickets actifs des files que vous pouvez voir.' },
    openFilter,
    { group_by: 'queue_slug' },
  ),
];

// ═════════════════════════════════════════════════════════════════════════════
// 5 — sla 'standard'
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Durations are BUSINESS minutes on the referenced calendar, so "1 day" on the
 * 'business' calendar is 540 minutes (09:00-18:00), not 1440. The label is what
 * the UI shows; the number is what the clock uses. Keeping both in the body
 * means nobody has to reverse-engineer one from the other.
 */
const SLA_STANDARD: BaselineObject = {
  kind: 'sla',
  slug: 'standard',
  name: 'Standard',
  description: 'P1 15m/4h, P2 1h/8h, P3 4h/2d, P4 1d/5d on the business calendar.',
  body: {
    label: { en: 'Standard', fr: 'Standard' } satisfies Localized,
    calendar: 'business',
    duration_unit: 'business_minutes',
    applies_to: null,
    targets: [
      {
        slug: 'response',
        label: { en: 'First response', fr: 'Première réponse' },
        start: { on: 'ticket.created' },
        stop: { on: 'ticket.first_public_reply' },
        // Pause semantics key off the CATEGORY, never a status slug (HARD RULE 5).
        pause_on_categories: ['pending_requester', 'pending_third_party', 'scheduled'],
        cancel_on_categories: ['cancelled'],
        by_priority: {
          p1: { minutes: 15, label: { en: '15m', fr: '15 min' } },
          p2: { minutes: 60, label: { en: '1h', fr: '1 h' } },
          p3: { minutes: 240, label: { en: '4h', fr: '4 h' } },
          p4: { minutes: 540, label: { en: '1 business day', fr: '1 jour ouvré' } },
        },
      },
      {
        slug: 'resolution',
        label: { en: 'Resolution', fr: 'Résolution' },
        start: { on: 'ticket.created' },
        stop: { on: 'ticket.category_reached', category: 'resolved' },
        pause_on_categories: ['pending_requester', 'pending_third_party', 'scheduled'],
        cancel_on_categories: ['cancelled'],
        by_priority: {
          p1: { minutes: 240, label: { en: '4h', fr: '4 h' } },
          p2: { minutes: 480, label: { en: '8h', fr: '8 h' } },
          p3: { minutes: 1080, label: { en: '2 business days', fr: '2 jours ouvrés' } },
          p4: { minutes: 2700, label: { en: '5 business days', fr: '5 jours ouvrés' } },
        },
      },
    ],
    /**
     * When priority changes mid-flight the clock does NOT restart: the target
     * switches, a 'target_switch' row lands in sla_ledger with the business ms
     * already elapsed, and due_at is recomputed from that. Restarting would let
     * a breach be erased by a priority downgrade.
     */
    on_priority_change: 'switch_target_keep_elapsed',
    warn_at_percent: [75, 90],
    notify_on: [
      { at_percent: 75, template: 'sla_breach_warning', to: ['assignee', 'assignment_group'] },
      { at_percent: 100, template: 'sla_breach_warning', to: ['assignee', 'assignment_group', 'managers'] },
    ],
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// 6 — calendars
// ═════════════════════════════════════════════════════════════════════════════

/** weekday is ISO-8601: 1 = Monday … 7 = Sunday. Minutes are from midnight, local to `timezone`. */
const businessShifts = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  start: '09:00',
  end: '18:00',
  start_minute: 9 * 60,
  end_minute: 18 * 60,
}));

const alwaysShifts = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday,
  start: '00:00',
  end: '24:00',
  start_minute: 0,
  end_minute: 24 * 60,
}));

const CALENDARS: BaselineObject[] = [
  {
    kind: 'calendar',
    slug: 'business',
    name: 'Business hours',
    description: 'Mon-Fri 09:00-18:00 Europe/Paris, French public holidays.',
    body: {
      label: { en: 'Business hours', fr: 'Heures ouvrées' } satisfies Localized,
      timezone: 'Europe/Paris',
      is_default: true,
      weekday_convention: 'iso-8601 (1 = Monday … 7 = Sunday)',
      shifts: businessShifts,
      // Seeded with the fixed-date French public holidays only. The moving ones
      // (Easter Monday, Ascension, Whit Monday) are deliberately absent rather
      // than wrong — an admin adds them, or points the calendar at a feed.
      holidays: [
        { day: '01-01', recurring: true, name: { en: 'New Year’s Day', fr: 'Jour de l’An' } },
        { day: '05-01', recurring: true, name: { en: 'Labour Day', fr: 'Fête du Travail' } },
        { day: '05-08', recurring: true, name: { en: 'Victory in Europe Day', fr: 'Victoire 1945' } },
        { day: '07-14', recurring: true, name: { en: 'Bastille Day', fr: 'Fête nationale' } },
        { day: '08-15', recurring: true, name: { en: 'Assumption', fr: 'Assomption' } },
        { day: '11-01', recurring: true, name: { en: 'All Saints’ Day', fr: 'Toussaint' } },
        { day: '11-11', recurring: true, name: { en: 'Armistice Day', fr: 'Armistice 1918' } },
        { day: '12-25', recurring: true, name: { en: 'Christmas Day', fr: 'Noël' } },
      ],
    },
  },
  {
    kind: 'calendar',
    slug: '24x7',
    name: '24×7',
    description: 'Always on. No holidays, no pauses — used by the security queue.',
    body: {
      label: { en: '24×7', fr: '24×7' } satisfies Localized,
      timezone: 'Europe/Paris',
      is_default: false,
      weekday_convention: 'iso-8601 (1 = Monday … 7 = Sunday)',
      shifts: alwaysShifts,
      holidays: [],
    },
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// 7 — rules
// ═════════════════════════════════════════════════════════════════════════════

const RULES: BaselineObject[] = [
  {
    kind: 'rule',
    slug: 'auto_assign_by_queue',
    name: 'Auto-assign by queue',
    description: 'Gives every unowned ticket a group as soon as its queue is known.',
    body: {
      label: { en: 'Auto-assign by queue', fr: 'Attribution automatique par file' } satisfies Localized,
      enabled: true,
      dry_run: false,
      order: 100,
      stop_processing: false,
      trigger: { on: ['ticket.created', 'ticket.field_changed'], fields: ['queue_slug'] },
      when: isEmpty('ticket.assignment_group_id'),
      actions: [
        {
          type: 'assign_group_by_queue',
          // Slug → slug (HARD RULE 3). Day one every queue lands on the one
          // seeded group; splitting the desk is an edit here, not a code change.
          map: {
            general: DEFAULT_ASSIGNMENT_GROUP_SLUG,
            network: DEFAULT_ASSIGNMENT_GROUP_SLUG,
            security: DEFAULT_ASSIGNMENT_GROUP_SLUG,
            onboarding: DEFAULT_ASSIGNMENT_GROUP_SLUG,
          },
          fallback_group: DEFAULT_ASSIGNMENT_GROUP_SLUG,
        },
      ],
      // Written by the routing engine on the same code path as the assignment
      // itself, never reconstructed afterwards (HARD RULE 2).
      decision_log: { subsystem: 'routing', decision: 'assign_group_by_queue' },
    },
  },
  {
    kind: 'rule',
    slug: 'ack_email_on_create',
    name: 'Acknowledge on create',
    description: 'Emails the requester their ticket number as soon as it exists.',
    body: {
      label: { en: 'Acknowledge on create', fr: 'Accusé de réception à la création' } satisfies Localized,
      enabled: true,
      dry_run: false,
      order: 200,
      stop_processing: false,
      trigger: { on: ['ticket.created'] },
      when: and(
        isNotEmpty('ticket.requester_contact_id'),
        // Never acknowledge a ticket the desk itself opened from an alert —
        // that is how two robots start emailing each other.
        oneOf('ticket.source', ['web', 'email', 'portal', 'phone', 'chat']),
      ),
      actions: [
        {
          type: 'send_notification',
          template: 'ticket_acknowledged',
          to: ['requester'],
          channel_types: ['email'],
          // Suppression list and loop detection are checked by the outbox, not
          // here: mail_suppressions is the single chokepoint for both.
          respect_suppressions: true,
        },
      ],
      decision_log: { subsystem: 'rule', decision: 'ack_email_on_create' },
    },
  },
  {
    kind: 'rule',
    slug: 'escalate_p1_after_15m',
    name: 'Escalate unanswered P1',
    description: 'Pulls a manager in when a P1 has had no first response for 15 business minutes.',
    body: {
      label: { en: 'Escalate unanswered P1', fr: 'Escalade P1 sans réponse' } satisfies Localized,
      enabled: true,
      dry_run: false,
      order: 300,
      stop_processing: false,
      trigger: { on: ['schedule'], every_minutes: 5 },
      when: and(
        eq('ticket.priority_slug', 'p1'),
        isEmpty('ticket.first_response_at'),
        oneOf('ticket.status_category', ['new', 'open']),
        gte('context.business_minutes_since_created', 15),
      ),
      actions: [
        { type: 'add_watcher', role: 'manager', reason: 'escalation' },
        {
          type: 'send_notification',
          template: 'sla_breach_warning',
          to: ['assignee', 'assignment_group', 'managers'],
          channel_types: ['email', 'live'],
        },
        {
          type: 'add_journal',
          kind: 'automation',
          visibility: 'internal',
          body_md: {
            en: 'Escalated: P1 with no first response after 15 business minutes.',
            fr: 'Escalade : P1 sans première réponse après 15 minutes ouvrées.',
          },
        },
        { type: 'set_field', field: 'ticket.data.escalated', value: true },
      ],
      /**
       * Load-bearing. Without this a 5-minute schedule re-escalates the same
       * ticket twelve times an hour until someone answers, and the escalation
       * mail becomes the thing people filter out.
       */
      once_per_ticket: true,
      decision_log: { subsystem: 'escalation', decision: 'escalate_p1_no_response' },
    },
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// 8 — fields
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A field object NEVER declares required-ness (HARD RULE 12). Inline edits
 * autosave one field at a time and must never block on "you also have to fill
 * in X" — that question is only ever asked at a state transition, by the
 * transition's required_fields.
 *
 * `storage` is always data.<slug>: the field's slug is its key in tickets.data,
 * which is the GIN-indexed jsonb column.
 */
const FIELDS: BaselineObject[] = [
  {
    kind: 'field',
    slug: 'site',
    name: 'Site',
    description: 'Which physical location the problem is at.',
    body: {
      key: 'site',
      storage: 'data.site',
      type: 'select',
      label: { en: 'Site', fr: 'Site' } satisfies Localized,
      help: { en: 'Where is the problem, physically?', fr: 'Où se situe physiquement le problème ?' },
      placeholder: { en: 'Pick a site', fr: 'Choisir un site' },
      options: [
        { value: 'hq', label: { en: 'Head office', fr: 'Siège' } },
        { value: 'branch', label: { en: 'Branch office', fr: 'Agence' } },
        { value: 'remote', label: { en: 'Remote / home', fr: 'Télétravail' } },
      ],
      searchable: true,
      applies_to_record_types: ['incident', 'request'],
    },
  },
  {
    kind: 'field',
    slug: 'vendor_ref',
    name: 'Vendor reference',
    description: 'The third party’s own case number. Required to park a ticket on a vendor.',
    body: {
      key: 'vendor_ref',
      storage: 'data.vendor_ref',
      type: 'text',
      max_length: 128,
      label: { en: 'Vendor reference', fr: 'Référence fournisseur' } satisfies Localized,
      help: {
        en: 'Their case number, so "waiting on the vendor" is a fact rather than a claim.',
        fr: 'Leur numéro de dossier, pour que « en attente du fournisseur » soit vérifiable.',
      },
      placeholder: { en: 'e.g. INC0043921', fr: 'ex. INC0043921' },
      searchable: true,
      applies_to_record_types: ['incident', 'problem', 'change'],
    },
  },
  {
    kind: 'field',
    slug: 'affected_users',
    name: 'Affected users',
    description: 'Roughly how many people are hit. Feeds the impact suggestion.',
    body: {
      key: 'affected_users',
      storage: 'data.affected_users',
      type: 'number',
      min: 0,
      step: 1,
      label: { en: 'Affected users', fr: 'Utilisateurs impactés' } satisfies Localized,
      help: { en: 'A rough count is fine.', fr: 'Une estimation suffit.' },
      placeholder: { en: '0', fr: '0' },
      searchable: false,
      applies_to_record_types: ['incident', 'problem'],
      // Read by the priority engine as a hint; it never overrides the matrix.
      suggests: { target: 'impact', thresholds: [{ gte: 50, value: 'high' }, { gte: 5, value: 'medium' }] },
    },
  },
  {
    kind: 'field',
    slug: 'callback_phone',
    name: 'Callback number',
    description: 'Where to reach the requester if email is the thing that is broken.',
    body: {
      key: 'callback_phone',
      storage: 'data.callback_phone',
      type: 'phone',
      label: { en: 'Callback number', fr: 'Numéro de rappel' } satisfies Localized,
      help: { en: 'Useful when the broken thing is email.', fr: 'Utile quand c’est justement la messagerie qui est en panne.' },
      placeholder: { en: '+33 …', fr: '+33 …' },
      searchable: true,
      applies_to_record_types: ['incident', 'request'],
    },
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// 9 — form 'incident_default'
// ═════════════════════════════════════════════════════════════════════════════

const FORM_INCIDENT_DEFAULT: BaselineObject = {
  kind: 'form',
  slug: 'incident_default',
  name: 'Incident',
  description: 'The default intake and detail layout for an incident.',
  body: {
    label: { en: 'Incident', fr: 'Incident' } satisfies Localized,
    record_type: 'incident',
    state_machine: 'default',
    // Field references are SLUGS into config_objects(kind='field'). Built-in
    // ticket columns are referenced by their column name.
    sections: [
      {
        key: 'what',
        title: { en: 'What happened', fr: 'Que s’est-il passé ?' },
        columns: 2,
        fields: [
          { ref: 'subject', builtin: true, span: 2 },
          { ref: 'description_md', builtin: true, span: 2, widget: 'markdown' },
          /**
           * HARD RULE 6 in the UI. occurred_at is asked HERE, at intake, because
           * it is the one thing that genuinely cannot be backfilled: nobody
           * remembers next Tuesday what time the printer died. created_at is
           * never a substitute for it.
           */
          {
            ref: 'occurred_at', builtin: true, span: 1, widget: 'datetime',
            label: { en: 'When did it happen?', fr: 'Quand est-ce arrivé ?' },
            help: {
              en: 'Not when you are filing this — when it actually started.',
              fr: 'Pas l’heure de saisie — l’heure réelle du début.',
            },
          },
          { ref: 'site', builtin: false, span: 1 },
        ],
      },
      {
        key: 'who',
        title: { en: 'Who is affected', fr: 'Qui est impacté' },
        columns: 2,
        fields: [
          { ref: 'requester_contact_id', builtin: true, span: 1, widget: 'contact_picker' },
          { ref: 'organization_id', builtin: true, span: 1, widget: 'organization_picker' },
          { ref: 'affected_users', builtin: false, span: 1 },
          { ref: 'callback_phone', builtin: false, span: 1 },
          { ref: 'primary_ci_id', builtin: true, span: 2, widget: 'ci_picker' },
        ],
      },
      {
        key: 'how_bad',
        title: { en: 'How bad is it', fr: 'Quelle gravité' },
        columns: 2,
        fields: [
          { ref: 'impact', builtin: true, span: 1, widget: 'impact_picker' },
          { ref: 'urgency', builtin: true, span: 1, widget: 'urgency_picker' },
          // Derived from the two above by priority_matrix 'default'.
          { ref: 'priority_slug', builtin: true, span: 2, widget: 'priority_derived', readonly_unless_override: true },
        ],
      },
      {
        key: 'routing',
        title: { en: 'Routing', fr: 'Routage' },
        columns: 2,
        collapsed_by_default: true,
        fields: [
          { ref: 'queue_slug', builtin: true, span: 1, widget: 'queue_picker' },
          { ref: 'assignment_group_id', builtin: true, span: 1, widget: 'group_picker' },
          { ref: 'assignee_id', builtin: true, span: 1, widget: 'user_picker' },
          { ref: 'vendor_ref', builtin: false, span: 1 },
        ],
      },
    ],
    // Which fields the portal (an unauthenticated requester) may see and set.
    portal_visible_sections: ['what', 'who'],
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// 10 — macro 'ask_for_screenshot'
// ═════════════════════════════════════════════════════════════════════════════

const MACRO_ASK_FOR_SCREENSHOT: BaselineObject = {
  kind: 'macro',
  slug: 'ask_for_screenshot',
  name: 'Ask for a screenshot',
  description: 'Sends the "send us a screenshot" reply and parks the ticket on the requester.',
  body: {
    label: { en: 'Ask for a screenshot', fr: 'Demander une capture d’écran' } satisfies Localized,
    icon: 'image',
    shortcut: 'g s',
    applies_to: oneOf('ticket.status_category', ['new', 'open']),
    actions: [
      {
        type: 'add_journal',
        kind: 'public_reply',
        visibility: 'public',
        body_md: {
          en: 'Hello,\n\nCould you send us a screenshot of the error, including the whole window and the clock?\n\nThat usually tells us in one look what several messages would not.\n\nThank you.',
          fr: 'Bonjour,\n\nPourriez-vous nous envoyer une capture d’écran de l’erreur, avec la fenêtre entière et l’heure visible ?\n\nCela nous en dit généralement plus en un coup d’œil que plusieurs messages.\n\nMerci.',
        },
      },
      // Runs through the state machine, so the 'await_requester' guard still
      // applies — a macro is never a way around a transition guard.
      { type: 'apply_transition', transition: 'await_requester' },
    ],
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// 11 — notification templates
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Referenced by SLUG from the rules and the SLA policy above. They exist here
 * so the seeded bundle has no dangling cross-reference: a rule pointing at a
 * template that was never shipped is a silent no-op at 3am.
 */
const NOTIFICATION_TEMPLATES: BaselineObject[] = [
  {
    kind: 'notification_template',
    slug: 'ticket_acknowledged',
    name: 'Ticket acknowledged',
    description: 'Sent to the requester when their ticket is created.',
    body: {
      label: { en: 'Ticket acknowledged', fr: 'Ticket enregistré' } satisfies Localized,
      channel_types: ['email'],
      audience: 'requester',
      subject: {
        en: '[{{ticket.number}}] We have your request',
        fr: '[{{ticket.number}}] Nous avons bien reçu votre demande',
      },
      body_md: {
        en: 'Hello {{requester.display_name}},\n\nWe logged your request as **{{ticket.number}}** — {{ticket.subject}}.\n\nYou can reply to this email and it will land straight on the ticket.\n\n{{portal_link}}',
        fr: 'Bonjour {{requester.display_name}},\n\nVotre demande est enregistrée sous le numéro **{{ticket.number}}** — {{ticket.subject}}.\n\nVous pouvez répondre à cet e-mail : votre réponse sera ajoutée au ticket.\n\n{{portal_link}}',
      },
      variables: ['ticket.number', 'ticket.subject', 'requester.display_name', 'portal_link'],
      // Threading headers so the reply comes back on the same thread rather
      // than opening a second ticket.
      set_reply_headers: true,
    },
  },
  {
    kind: 'notification_template',
    slug: 'ticket_resolved',
    name: 'Ticket resolved',
    description: 'Sent to the requester when the ticket reaches the resolved category.',
    body: {
      label: { en: 'Ticket resolved', fr: 'Ticket résolu' } satisfies Localized,
      channel_types: ['email'],
      audience: 'requester',
      subject: {
        en: '[{{ticket.number}}] Resolved — {{ticket.subject}}',
        fr: '[{{ticket.number}}] Résolu — {{ticket.subject}}',
      },
      body_md: {
        en: 'Hello {{requester.display_name}},\n\nWe believe **{{ticket.number}}** is resolved:\n\n{{ticket.resolution_md}}\n\nIf it is not, just reply and the ticket reopens.\n\n{{satisfaction_link}}',
        fr: 'Bonjour {{requester.display_name}},\n\nNous considérons **{{ticket.number}}** comme résolu :\n\n{{ticket.resolution_md}}\n\nSi ce n’est pas le cas, répondez simplement à ce message et le ticket sera réouvert.\n\n{{satisfaction_link}}',
      },
      variables: ['ticket.number', 'ticket.subject', 'ticket.resolution_md', 'requester.display_name', 'satisfaction_link'],
      set_reply_headers: true,
    },
  },
  {
    kind: 'notification_template',
    slug: 'sla_breach_warning',
    name: 'SLA at risk',
    description: 'Internal warning sent to the assignee and their group.',
    body: {
      label: { en: 'SLA at risk', fr: 'SLA menacé' } satisfies Localized,
      channel_types: ['email', 'live'],
      audience: 'internal',
      subject: {
        en: '[{{ticket.number}}] {{sla.target_label}} due {{sla.due_at_relative}}',
        fr: '[{{ticket.number}}] {{sla.target_label}} échéance {{sla.due_at_relative}}',
      },
      body_md: {
        en: '**{{ticket.number}}** — {{ticket.subject}}\n\n{{sla.target_label}} is due {{sla.due_at_relative}} ({{sla.percent_elapsed}}% elapsed).\n\nPriority {{ticket.priority_slug}} · queue {{ticket.queue_slug}} · assignee {{assignee.display_name}}.\n\n{{ticket_link}}',
        fr: '**{{ticket.number}}** — {{ticket.subject}}\n\n{{sla.target_label}} à échéance {{sla.due_at_relative}} ({{sla.percent_elapsed}} % écoulé).\n\nPriorité {{ticket.priority_slug}} · file {{ticket.queue_slug}} · assigné à {{assignee.display_name}}.\n\n{{ticket_link}}',
      },
      variables: [
        'ticket.number', 'ticket.subject', 'ticket.priority_slug', 'ticket.queue_slug',
        'assignee.display_name', 'sla.target_label', 'sla.due_at_relative',
        'sla.percent_elapsed', 'ticket_link',
      ],
      set_reply_headers: false,
    },
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// 12 — dashboard 'operations'
// ═════════════════════════════════════════════════════════════════════════════

const DASHBOARD_OPERATIONS: BaselineObject = {
  kind: 'dashboard',
  slug: 'operations',
  name: 'Operations',
  description: 'The default shift-handover view: what is live, what is late, what changed.',
  body: {
    label: { en: 'Operations', fr: 'Exploitation' } satisfies Localized,
    is_default: true,
    is_shared: true,
    grid: { columns: 12, row_height: 80 },
    tabs: [
      { key: 'overview', label: { en: 'Overview', fr: 'Vue d’ensemble' }, order: 10 },
      { key: 'quality', label: { en: 'Quality', fr: 'Qualité' }, order: 20 },
    ],
    widgets: [
      // ── Overview: the four numbers a shift lead reads first ───────────────
      {
        tab_key: 'overview', widget_type: 'stat', x: 0, y: 0, w: 3, h: 2, sort_order: 10,
        title: { en: 'Open', fr: 'Ouverts' },
        config: { metric: 'ticket_count', view: 'all_open', drill_to_view: 'all_open' },
      },
      {
        tab_key: 'overview', widget_type: 'stat', x: 3, y: 0, w: 3, h: 2, sort_order: 20,
        title: { en: 'Unassigned', fr: 'Non assignés' },
        config: { metric: 'ticket_count', view: 'unassigned', drill_to_view: 'unassigned', tone_when_above: { value: 0, tone: 'warn' } },
      },
      {
        tab_key: 'overview', widget_type: 'stat', x: 6, y: 0, w: 3, h: 2, sort_order: 30,
        title: { en: 'Breaching soon', fr: 'Bientôt hors SLA' },
        config: { metric: 'ticket_count', view: 'breaching_soon', drill_to_view: 'breaching_soon', tone_when_above: { value: 0, tone: 'danger' } },
      },
      {
        tab_key: 'overview', widget_type: 'stat', x: 9, y: 0, w: 3, h: 2, sort_order: 40,
        title: { en: 'Resolved today', fr: 'Résolus aujourd’hui' },
        config: { metric: 'resolved_count', window: 'today' },
      },
      {
        tab_key: 'overview', widget_type: 'donut', x: 0, y: 2, w: 4, h: 4, sort_order: 50,
        title: { en: 'Open by priority', fr: 'Ouverts par priorité' },
        config: { metric: 'ticket_count', view: 'all_open', group_by: 'priority_slug' },
      },
      {
        tab_key: 'overview', widget_type: 'bar', x: 4, y: 2, w: 4, h: 4, sort_order: 60,
        title: { en: 'Open by queue', fr: 'Ouverts par file' },
        config: { metric: 'ticket_count', view: 'all_open', group_by: 'queue_slug' },
      },
      {
        tab_key: 'overview', widget_type: 'area', x: 8, y: 2, w: 4, h: 4, sort_order: 70,
        title: { en: 'Backlog, 30 days', fr: 'Encours, 30 jours' },
        config: { metric: 'backlog_size', window: 'last_30_days', interval: 'day' },
      },
      {
        tab_key: 'overview', widget_type: 'ticket_list', x: 0, y: 6, w: 8, h: 5, sort_order: 80,
        title: { en: 'My open tickets', fr: 'Mes tickets ouverts' },
        config: { view: 'my_open', limit: 10 },
      },
      {
        tab_key: 'overview', widget_type: 'activity_feed', x: 8, y: 6, w: 4, h: 5, sort_order: 90,
        title: { en: 'Recent activity', fr: 'Activité récente' },
        config: { limit: 20, visibility: 'internal' },
      },

      // ── Quality: is the desk actually any good ────────────────────────────
      {
        tab_key: 'quality', widget_type: 'line', x: 0, y: 0, w: 6, h: 4, sort_order: 10,
        title: { en: 'SLA attainment, 30 days', fr: 'Respect du SLA, 30 jours' },
        config: { metric: 'sla_attainment_pct', window: 'last_30_days', interval: 'day', target: 95 },
      },
      {
        tab_key: 'quality', widget_type: 'line', x: 6, y: 0, w: 6, h: 4, sort_order: 20,
        title: { en: 'Median first response', fr: 'Médiane de première réponse' },
        config: { metric: 'first_response_minutes_p50', window: 'last_30_days', interval: 'day' },
      },
      {
        tab_key: 'quality', widget_type: 'stat', x: 0, y: 4, w: 3, h: 2, sort_order: 30,
        title: { en: 'CSAT, 30 days', fr: 'Satisfaction, 30 jours' },
        config: { metric: 'csat_avg', window: 'last_30_days' },
      },
      {
        tab_key: 'quality', widget_type: 'stat', x: 3, y: 4, w: 3, h: 2, sort_order: 40,
        title: { en: 'Reopen rate', fr: 'Taux de réouverture' },
        config: { metric: 'reopen_rate_pct', window: 'last_30_days', tone_when_above: { value: 10, tone: 'warn' } },
      },
      {
        tab_key: 'quality', widget_type: 'bar', x: 6, y: 4, w: 6, h: 4, sort_order: 50,
        title: { en: 'Top resolution codes', fr: 'Principaux codes de résolution' },
        config: { metric: 'ticket_count', window: 'last_30_days', group_by: 'resolution_code', limit: 8 },
      },
    ],
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// The bundle
// ═════════════════════════════════════════════════════════════════════════════

export const BASELINE_OBJECTS: BaselineObject[] = [
  STATE_MACHINE_DEFAULT,
  PRIORITY_MATRIX_DEFAULT,
  ...QUEUES,
  ...VIEWS,
  SLA_STANDARD,
  ...CALENDARS,
  ...RULES,
  ...FIELDS,
  FORM_INCIDENT_DEFAULT,
  MACRO_ASK_FOR_SCREENSHOT,
  ...NOTIFICATION_TEMPLATES,
  DASHBOARD_OPERATIONS,
];

/**
 * Canonical JSON: object keys sorted, array order preserved. The checksum has
 * to be stable across a re-serialise, otherwise "has this object drifted from
 * the shipped baseline?" cannot be answered by comparing two hex strings.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalise(source[key]);
    return out;
  }
  return value;
}

/** sha256 over (kind, body_format_version, canonical body). 64 hex chars. */
export function checksumOf(kind: ConfigKind, body: unknown): string {
  const formatVersion = BODY_FORMAT_VERSIONS[kind];
  return createHash('sha256')
    .update(`${kind}:${formatVersion}:${JSON.stringify(canonicalise(body))}`)
    .digest('hex');
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[seed:02_baseline_config] ${message}`);
}

export async function seed(knex: Knex): Promise<void> {
  const tenant = await knex('tenants')
    .select('id')
    .where('slug', DEFAULT_TENANT_SLUG)
    .first();

  if (!tenant) {
    throw new Error(
      `[seed:02_baseline_config] tenant '${DEFAULT_TENANT_SLUG}' not found — run 01_core first.`,
    );
  }
  const tenantId: number = tenant.id;

  // System objects are authored by the product, not a person. We still stamp
  // the bootstrap admin as created_by when one exists so the audit trail has a
  // human to point at; NULL is fine when it does not.
  const admin = await knex('users').select('id').where('role', 'admin').orderBy('id').first();
  const createdBy: number | null = admin ? admin.id : null;

  let inserted = 0;
  let skipped = 0;

  for (const object of BASELINE_OBJECTS) {
    const formatVersion = BODY_FORMAT_VERSIONS[object.kind];
    const checksum = checksumOf(object.kind, object.body);

    const rows = await knex('config_objects')
      .insert({
        tenant_id: tenantId,
        kind: object.kind,
        slug: object.slug,
        name: object.name,
        description: object.description,
        body: JSON.stringify(object.body),
        body_format_version: formatVersion,
        status: 'published',
        version: 1,
        is_system: true,
        // Empty = applies to its owning tenant only. A non-empty array is how a
        // master-tenant admin pushes one object down to specific tenants.
        target_tenant_ids: [],
        checksum,
        created_by: createdBy,
        updated_at: knex.fn.now(),
      })
      .onConflict(['tenant_id', 'kind', 'slug'])
      .ignore()
      .returning('id');

    if (rows.length === 0) {
      skipped += 1;
      continue;
    }
    inserted += 1;

    // A config object with a version but no version row reads as "someone
    // deleted the history". Ship v1 alongside it.
    const configObjectId = typeof rows[0] === 'object' ? (rows[0] as { id: number }).id : (rows[0] as number);
    await knex('config_object_versions')
      .insert({
        config_object_id: configObjectId,
        version: 1,
        body: JSON.stringify(object.body),
        body_format_version: formatVersion,
        author_id: createdBy,
        note: 'Shipped baseline (is_system).',
      })
      .onConflict(['config_object_id', 'version'])
      .ignore();
  }

  log(
    `${BASELINE_OBJECTS.length} baseline objects: ${inserted} inserted, ${skipped} already present ` +
    '(existing rows are never overwritten).',
  );
}
