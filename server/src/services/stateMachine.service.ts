/**
 * stateMachine.service.ts — the ticket lifecycle, loaded from configuration.
 *
 * A status is DATA (`config_objects` of kind `state_machine`); a status
 * CATEGORY is CODE (the eight values in `@oblidesk/shared`). HARD RULE 5 exists
 * because a tenant renaming "Pending Vendor" to "Waiting on supplier" must not
 * be able to break the SLA clock: every engine keys off `category`, never off
 * `slug`, and this module is where the two are bound together.
 *
 * It owns four things:
 *
 *   1. reading and caching published config objects (the desk's only reader
 *      until a dedicated `config.service` takes it over — deliberately
 *      dependency-free so the engines can boot without it);
 *   2. NORMALISING two body dialects into one shape (see below);
 *   3. the canonical map of ticket field paths a configuration may address —
 *      the whitelist the list-filter SQL compiler also uses, so config can
 *      never reach a column the product did not offer it;
 *   4. `availableTransitions()` / `blockedReasons()`, the single evaluator the
 *      header bar and the transition endpoint both run (HARD RULE 12).
 *
 * ── Two dialects, one shape ──────────────────────────────────────────────────
 * The shipped baseline (`seeds/02_baseline_config.ts`, and therefore every row
 * actually in the database) writes snake_case bodies:
 *
 *     { initial_status, statuses: [{ slug, category, order, label: {en,fr} }],
 *       transitions: [{ slug, from, to, allowed_roles, guard, required_fields }] }
 *
 * while `StateMachineBody` in `@oblidesk/shared` describes the camelCase DTO
 * the config editor round-trips:
 *
 *     { initialStatusSlug, statuses: [{ slug, category, label, sortOrder }],
 *       transitions: [{ from, to, guard, requiredFields, requiredCapabilities }] }
 *
 * Both are legitimate — one is the export format, one is the API DTO — and a
 * reader that understands only one of them silently mis-reads half the tenants.
 * `normalizeStateMachineBody()` accepts either and every consumer sees exactly
 * one shape.
 *
 * ── Conditions ───────────────────────────────────────────────────────────────
 * The stored guard dialect is `{ op: 'and', children: [...] }`; the evaluator in
 * `@oblidesk/shared` takes `{ all: [...] }`. `toConditionNode()` translates, and
 * an operator the evaluator does not know becomes `{ any: [] }` — a node that
 * matches NOTHING. Guards fail closed: an unreadable guard must refuse the
 * transition, never wave it through.
 */
import {
  BASELINE_SLUGS,
  CAPABILITIES,
  DEFAULT_STATUS_SLUG,
  STATUS_CATEGORIES,
  evaluateCondition,
  isStatusCategory,
  isTerminal,
  toStatusCategory,
  type Capability,
  type ConditionContext,
  type ConditionNode,
  type ConditionTrace,
  type Operator,
  type StatusCategory,
  type ActorType,
  type Ticket,
  type TransitionEvaluation,
} from '@oblidesk/shared';

import { db, scoped, type Executor } from '../db';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — config_objects access
// ═════════════════════════════════════════════════════════════════════════════

export interface ConfigObjectRow {
  id: number;
  kind: string;
  slug: string;
  name: string;
  description: string | null;
  body: Record<string, unknown>;
  bodyFormatVersion: number;
  version: number;
  isSystem: boolean;
}

interface RawConfigRow {
  id: number;
  kind: string;
  slug: string;
  name: string;
  description: string | null;
  body: unknown;
  body_format_version: number;
  version: number;
  is_system: boolean;
}

function mapConfigRow(row: RawConfigRow): ConfigObjectRow {
  return {
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    name: row.name,
    description: row.description,
    body: (typeof row.body === 'string' ? JSON.parse(row.body) : row.body ?? {}) as Record<
      string,
      unknown
    >,
    bodyFormatVersion: row.body_format_version,
    version: row.version,
    isSystem: row.is_system,
  };
}

/** One published config object, or null. Never throws for "not configured". */
export async function readPublishedConfigObject(
  tenantId: number,
  kind: string,
  slug: string,
  executor: Executor = db,
): Promise<ConfigObjectRow | null> {
  const row = await scoped('config_objects', tenantId, executor)
    .where({ 'config_objects.kind': kind, 'config_objects.slug': slug, 'config_objects.status': 'published' })
    .first<RawConfigRow>(
      'config_objects.id',
      'config_objects.kind',
      'config_objects.slug',
      'config_objects.name',
      'config_objects.description',
      'config_objects.body',
      'config_objects.body_format_version',
      'config_objects.version',
      'config_objects.is_system',
    );
  return row ? mapConfigRow(row) : null;
}

/** Every published object of a kind, slug-ascending. */
export async function listPublishedConfigObjects(
  tenantId: number,
  kind: string,
  executor: Executor = db,
): Promise<ConfigObjectRow[]> {
  const rows = (await scoped('config_objects', tenantId, executor)
    .where({ 'config_objects.kind': kind, 'config_objects.status': 'published' })
    .orderBy('config_objects.slug', 'asc')
    .select(
      'config_objects.id',
      'config_objects.kind',
      'config_objects.slug',
      'config_objects.name',
      'config_objects.description',
      'config_objects.body',
      'config_objects.body_format_version',
      'config_objects.version',
      'config_objects.is_system',
    )) as unknown as RawConfigRow[];
  return rows.map(mapConfigRow);
}

// ── Cache ────────────────────────────────────────────────────────────────────
//
// Engines read the same handful of config objects on every ticket. A short TTL
// plus an explicit invalidation hook is enough: config publishes are rare and
// human-paced, and a stale machine for a few seconds is far cheaper than a
// SELECT per transition on a busy desk.

const CONFIG_CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const machineCache = new Map<string, CacheEntry<NormalizedStateMachine>>();
const fieldCache = new Map<string, CacheEntry<RequiredWhenField[]>>();

function cacheKey(tenantId: number, slug: string): string {
  return `${tenantId}::${slug}`;
}

/**
 * Drop cached config. Call from the config publish path:
 *   invalidateStateMachineCache(tenantId)                  — everything
 *   invalidateStateMachineCache(tenantId, 'default')       — one machine
 */
export function invalidateStateMachineCache(tenantId?: number, slug?: string): void {
  if (tenantId === undefined) {
    machineCache.clear();
    fieldCache.clear();
    return;
  }
  if (slug !== undefined) {
    machineCache.delete(cacheKey(tenantId, slug));
    return;
  }
  const prefix = `${tenantId}::`;
  for (const key of [...machineCache.keys()]) if (key.startsWith(prefix)) machineCache.delete(key);
  for (const key of [...fieldCache.keys()]) if (key.startsWith(prefix)) fieldCache.delete(key);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — stored condition dialect → the shared evaluator's dialect
// ═════════════════════════════════════════════════════════════════════════════

/** A node that matches nothing. Used wherever a condition cannot be read. */
const NEVER: ConditionNode = { any: [] };

/** A node that imposes no restriction. */
export const ALWAYS: ConditionNode = { all: [] };

const KNOWN_OPERATORS: ReadonlySet<string> = new Set<string>([
  'eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte',
  'contains', 'not_contains', 'starts_with', 'ends_with',
  'is_empty', 'is_not_empty', 'changed', 'changed_to', 'changed_from',
  'older_than', 'newer_than', 'matches',
]);

/** Stored spellings that differ from the evaluator's. */
const OPERATOR_ALIASES: Readonly<Record<string, Operator>> = {
  ne: 'neq',
  not_eq: 'neq',
  '!=': 'neq',
  '=': 'eq',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  one_of: 'in',
  none_of: 'not_in',
  regex: 'matches',
  empty: 'is_empty',
  not_empty: 'is_not_empty',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapOperator(raw: unknown): Operator | null {
  if (typeof raw !== 'string') return null;
  const lowered = raw.toLowerCase();
  if (KNOWN_OPERATORS.has(lowered)) return lowered as Operator;
  return OPERATOR_ALIASES[lowered] ?? null;
}

/**
 * Translate a stored condition into the shape `evaluateCondition()` reads.
 *
 * Accepts BOTH dialects, at any depth, in any mix:
 *   `{ op: 'and', children: [...] }`   the exported/seeded form
 *   `{ all: [...] }`                   the shared DTO form
 *
 * Returns `null` for "no condition at all" (which every caller reads as "no
 * restriction") and `{ any: [] }` — matches nothing — for a node it cannot
 * understand, so an unreadable guard refuses rather than permits.
 */
export function toConditionNode(raw: unknown, depth = 0): ConditionNode | null {
  if (raw === null || raw === undefined) return null;
  if (depth > 24 || !isRecord(raw)) return NEVER;

  // ── Already the shared dialect ────────────────────────────────────────────
  if (Array.isArray(raw.all)) {
    return { all: raw.all.map((child) => toConditionNode(child, depth + 1) ?? ALWAYS) };
  }
  if (Array.isArray(raw.any)) {
    return { any: raw.any.map((child) => toConditionNode(child, depth + 1) ?? NEVER) };
  }
  if (raw.not !== undefined) {
    return { not: toConditionNode(raw.not, depth + 1) ?? ALWAYS };
  }

  // ── The stored dialect: one uniform node keyed by `op` ────────────────────
  const op = typeof raw.op === 'string' ? raw.op.toLowerCase() : null;
  const children = Array.isArray(raw.children) ? raw.children : [];

  if (op === 'and') {
    return { all: children.map((child) => toConditionNode(child, depth + 1) ?? ALWAYS) };
  }
  if (op === 'or') {
    return { any: children.map((child) => toConditionNode(child, depth + 1) ?? NEVER) };
  }
  if (op === 'not') {
    const inner = children.length > 0 ? toConditionNode(children[0], depth + 1) : null;
    return { not: inner ?? ALWAYS };
  }

  const operator = mapOperator(op ?? raw.operator);
  const field = typeof raw.field === 'string' ? raw.field : null;
  if (!operator || !field) return NEVER;

  return raw.value === undefined
    ? { field, op: operator }
    : { field, op: operator, value: raw.value };
}

// ── Token substitution ───────────────────────────────────────────────────────

export interface ConditionTokens {
  /** `@me` — the acting user id. */
  me?: number | null;
  /** `@my_groups` — assignment groups the actor belongs to. */
  myGroups?: readonly number[];
  /** `@now`, `@now+2h`, `@now-30m`. */
  now?: Date;
}

const NOW_TOKEN_RE = /^@now(?:\s*([+-])\s*(\d+)\s*([smhdw]))?$/i;
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Resolve `@me` / `@my_groups` / `@now±<n><unit>` inside a condition's values.
 *
 * Tokens exist so a saved view can say "assigned to me" without baking a user
 * id into shared configuration (HARD RULE 3 in spirit: config never carries an
 * identity). They are resolved as late as possible — here — so the same stored
 * view means the right thing for every viewer.
 */
export function resolveConditionTokens(
  node: ConditionNode | null,
  tokens: ConditionTokens,
): ConditionNode | null {
  if (!node) return null;
  if ('all' in node) return { all: node.all.map((c) => resolveConditionTokens(c, tokens) ?? ALWAYS) };
  if ('any' in node) return { any: node.any.map((c) => resolveConditionTokens(c, tokens) ?? NEVER) };
  if ('not' in node) return { not: resolveConditionTokens(node.not, tokens) ?? ALWAYS };

  if (node.value === undefined) return node;
  return { ...node, value: resolveTokenValue(node.value, tokens) };
}

export function resolveTokenValue(value: unknown, tokens: ConditionTokens): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveTokenValue(item, tokens));
  if (typeof value !== 'string' || !value.startsWith('@')) return value;

  if (value === '@me') return tokens.me ?? null;
  if (value === '@my_groups') return [...(tokens.myGroups ?? [])];

  const match = NOW_TOKEN_RE.exec(value);
  if (match) {
    const base = (tokens.now ?? new Date()).getTime();
    if (!match[1]) return new Date(base).toISOString();
    const delta = Number(match[2]) * (UNIT_MS[match[3].toLowerCase()] ?? 0);
    return new Date(match[1] === '-' ? base - delta : base + delta).toISOString();
  }
  return value;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — the ticket field whitelist
// ═════════════════════════════════════════════════════════════════════════════
//
// The single answer to "what may a configuration address?". Guards, saved-view
// filters, transition effects and the list-filter SQL compiler all resolve
// through here, which is why no client string ever reaches a column name.

export type TicketFieldKind = 'string' | 'number' | 'boolean' | 'timestamp' | 'json';

export interface TicketFieldRef {
  /** Canonical dotted path, always `ticket.…`. */
  path: string;
  /** Physical column, qualified with the table. */
  column: string;
  kind: TicketFieldKind;
  /** Set when the value lives inside `tickets.data`. */
  jsonKey?: string;
  /** May a transition effect or an inline edit write it? */
  writable: boolean;
}

function col(
  path: string,
  column: string,
  kind: TicketFieldKind,
  writable = true,
): [string, TicketFieldRef] {
  return [path, { path: `ticket.${path}`, column: `tickets.${column}`, kind, writable }];
}

const TICKET_FIELDS: ReadonlyMap<string, TicketFieldRef> = new Map([
  col('id', 'id', 'number', false),
  col('number', 'number', 'string', false),
  col('record_type', 'record_type', 'string', false),
  col('subject', 'subject', 'string'),
  col('description_md', 'description_md', 'string'),
  col('status_slug', 'status_slug', 'string', false),
  col('status_category', 'status_category', 'string', false),
  col('priority_slug', 'priority_slug', 'string'),
  col('impact', 'impact', 'string'),
  col('urgency', 'urgency', 'string'),
  col('queue_slug', 'queue_slug', 'string'),
  col('assignment_group_id', 'assignment_group_id', 'number'),
  col('assignee_id', 'assignee_id', 'number'),
  col('requester_contact_id', 'requester_contact_id', 'number'),
  col('requester_user_id', 'requester_user_id', 'number'),
  col('organization_id', 'organization_id', 'number'),
  col('primary_ci_id', 'primary_ci_id', 'number'),
  col('source', 'source', 'string', false),
  col('occurred_at', 'occurred_at', 'timestamp'),
  col('created_at', 'created_at', 'timestamp', false),
  col('updated_at', 'updated_at', 'timestamp', false),
  col('first_response_at', 'first_response_at', 'timestamp', false),
  col('resolved_at', 'resolved_at', 'timestamp', false),
  col('closed_at', 'closed_at', 'timestamp', false),
  col('due_at', 'due_at', 'timestamp'),
  col('reopen_count', 'reopen_count', 'number'),
  col('parent_ticket_id', 'parent_ticket_id', 'number'),
  col('merged_into_id', 'merged_into_id', 'number', false),
  col('resolution_code', 'resolution_code', 'string'),
  col('resolution_md', 'resolution_md', 'string'),
  col('csat_score', 'csat_score', 'number', false),
  col('row_version', 'row_version', 'number', false),
  col('deleted_at', 'deleted_at', 'timestamp', false),
]);

/** Custom-field keys are slugs; anything else is not addressable. */
const DATA_KEY_RE = /^[a-z0-9][a-z0-9_]{0,62}$/i;

/**
 * Resolve a configured field path to a physical column.
 *
 * Accepts `ticket.assignee_id`, `assignee_id`, `ticket.data.vendor_ref` and
 * `data.vendor_ref` — all four spellings appear in real bodies. Returns null
 * for anything not on the whitelist, and the caller reports it rather than
 * guessing: a filter that silently drops a clause it did not understand shows
 * the agent the wrong tickets, which is worse than an error.
 */
export function resolveTicketFieldPath(rawPath: string): TicketFieldRef | null {
  const path = rawPath.trim();
  const withoutPrefix = path.startsWith('ticket.') ? path.slice('ticket.'.length) : path;

  if (withoutPrefix.startsWith('data.')) {
    const key = withoutPrefix.slice('data.'.length);
    if (!DATA_KEY_RE.test(key)) return null;
    return {
      path: `ticket.data.${key}`,
      column: 'tickets.data',
      kind: 'json',
      jsonKey: key,
      writable: true,
    };
  }
  return TICKET_FIELDS.get(withoutPrefix) ?? null;
}

/** Every non-custom path a configuration may name. For the config linter. */
export function listTicketFieldPaths(): string[] {
  return [...TICKET_FIELDS.values()].map((ref) => ref.path);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — the normalised state machine
// ═════════════════════════════════════════════════════════════════════════════

export interface LocalizedLabel {
  en: string;
  fr?: string;
}

export interface NormalizedStatus {
  slug: string;
  /** HARD RULE 5 — mandatory, hard-coded, what every engine reads. */
  category: StatusCategory;
  label: LocalizedLabel;
  description?: LocalizedLabel;
  tone?: string;
  color?: string;
  sortOrder: number;
  portalVisible: boolean;
  isDefault: boolean;
}

export type TransitionEffect =
  | { type: 'set_field'; field: string; value: unknown }
  | { type: 'increment_field'; field: string; value: number }
  | { type: 'clear_field'; field: string };

export interface NormalizedTransition {
  slug: string;
  from: string[] | '*';
  to: string;
  label: LocalizedLabel;
  guard: ConditionNode | null;
  /** HARD RULE 12 — the ONLY declaration of required-ness. */
  requiredFields: string[];
  requiredCapabilities: Capability[];
  /** Null means "any role". */
  allowedRoles: string[] | null;
  /** Null means "any actor". Baseline uses it to fence automation-only moves. */
  allowedActorTypes: ActorType[] | null;
  promptFor: string[];
  confirm: boolean;
  effects: TransitionEffect[];
  autoWhen: ConditionNode | null;
  sortOrder: number;
}

export interface NormalizedStateMachine {
  slug: string;
  version: number;
  bodyFormatVersion: number;
  recordTypes: string[];
  initialStatusSlug: string;
  reopenToStatusSlug: string | null;
  autoCloseAfterDays: number | null;
  reopenWindowDays: number | null;
  statuses: NormalizedStatus[];
  statusBySlug: ReadonlyMap<string, NormalizedStatus>;
  transitions: NormalizedTransition[];
  /** True when this is the built-in fallback rather than tenant config. */
  isFallback: boolean;
}

// ── Body readers that tolerate both dialects ────────────────────────────────

function pick(body: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = body[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function readLabel(raw: unknown, fallback: string): LocalizedLabel {
  if (typeof raw === 'string' && raw.trim() !== '') return { en: raw };
  if (isRecord(raw)) {
    const en = typeof raw.en === 'string' ? raw.en : fallback;
    const fr = typeof raw.fr === 'string' ? raw.fr : undefined;
    return fr ? { en, fr } : { en };
  }
  return { en: fallback };
}

function readStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

function readNumber(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readEffects(raw: unknown, setFields: unknown): TransitionEffect[] {
  const effects: TransitionEffect[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item) || typeof item.field !== 'string') continue;
      const type = typeof item.type === 'string' ? item.type : 'set_field';
      if (type === 'increment_field') {
        effects.push({ type, field: item.field, value: readNumber(item.value, 1) });
      } else if (type === 'clear_field') {
        effects.push({ type, field: item.field });
      } else if (type === 'set_field') {
        effects.push({ type, field: item.field, value: item.value });
      }
      // Anything else (notify, webhook, …) belongs to the rules engine, not to
      // the state machine — silently ignoring it here keeps the two separable.
    }
  }

  // The shared DTO spells the same idea as a plain map.
  if (isRecord(setFields)) {
    for (const [field, value] of Object.entries(setFields)) {
      effects.push({ type: 'set_field', field, value });
    }
  }
  return effects;
}

function normalizeStatus(raw: unknown, index: number): NormalizedStatus | null {
  if (!isRecord(raw) || typeof raw.slug !== 'string') return null;
  const rawCategory = raw.category;
  // A status with an unreadable category is a configuration defect, but
  // refusing to load the whole machine over it would take the desk down. Fall
  // back to 'open' — the least surprising live category — and keep going.
  const category: StatusCategory = isStatusCategory(rawCategory)
    ? rawCategory
    : toStatusCategory(rawCategory, 'open');

  return {
    slug: raw.slug,
    category,
    label: readLabel(raw.label, raw.slug),
    description: raw.description !== undefined ? readLabel(raw.description, '') : undefined,
    tone: typeof raw.tone === 'string' ? raw.tone : undefined,
    color: typeof raw.color === 'string' ? raw.color : undefined,
    sortOrder: readNumber(pick(raw, 'order', 'sortOrder', 'sort_order'), (index + 1) * 10),
    portalVisible: raw.portalVisible !== false && raw.portal_visible !== false,
    isDefault: raw.isDefault === true || raw.is_default === true,
  };
}

function normalizeTransition(raw: unknown, index: number): NormalizedTransition | null {
  if (!isRecord(raw) || typeof raw.to !== 'string') return null;

  const from: string[] | '*' =
    raw.from === '*' ? '*' : readStringArray(raw.from);

  const capabilities = readStringArray(
    pick(raw, 'requiredCapabilities', 'required_capabilities'),
  ).filter((value): value is Capability =>
    (Object.values(CAPABILITIES) as string[]).includes(value),
  );

  const allowedRolesRaw = pick(raw, 'allowedRoles', 'allowed_roles');
  const allowedActorsRaw = pick(raw, 'allowedActorTypes', 'allowed_actor_types');

  return {
    slug: typeof raw.slug === 'string' ? raw.slug : `${Array.isArray(from) ? from.join('_') : 'any'}__${raw.to}`,
    from,
    to: raw.to,
    label: readLabel(raw.label, raw.to),
    guard: toConditionNode(raw.guard),
    requiredFields: readStringArray(pick(raw, 'requiredFields', 'required_fields')),
    requiredCapabilities: capabilities,
    allowedRoles: allowedRolesRaw === undefined ? null : readStringArray(allowedRolesRaw),
    allowedActorTypes:
      allowedActorsRaw === undefined ? null : (readStringArray(allowedActorsRaw) as ActorType[]),
    promptFor: readStringArray(pick(raw, 'promptFor', 'prompt_for')),
    confirm: raw.confirm === true,
    effects: readEffects(raw.effects, pick(raw, 'setFields', 'set_fields')),
    autoWhen: toConditionNode(pick(raw, 'autoWhen', 'auto_when')),
    sortOrder: readNumber(pick(raw, 'sortOrder', 'sort_order', 'order'), (index + 1) * 10),
  };
}

/** Turn either body dialect into the one shape the engines read. */
export function normalizeStateMachineBody(
  slug: string,
  body: Record<string, unknown>,
  meta: { version?: number; bodyFormatVersion?: number } = {},
): NormalizedStateMachine {
  const statuses = (Array.isArray(body.statuses) ? body.statuses : [])
    .map(normalizeStatus)
    .filter((s): s is NormalizedStatus => s !== null)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const transitions = (Array.isArray(body.transitions) ? body.transitions : [])
    .map(normalizeTransition)
    .filter((t): t is NormalizedTransition => t !== null)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const statusBySlug = new Map(statuses.map((status) => [status.slug, status]));

  const initial =
    (typeof pick(body, 'initialStatusSlug', 'initial_status') === 'string'
      ? (pick(body, 'initialStatusSlug', 'initial_status') as string)
      : null) ??
    statuses.find((s) => s.isDefault)?.slug ??
    statuses[0]?.slug ??
    DEFAULT_STATUS_SLUG;

  const reopenTo = pick(body, 'reopenToStatusSlug', 'reopen_to_status', 'reopen_status');
  const autoClose = pick(body, 'autoCloseAfterDays', 'auto_close_after_days');
  const reopenWindow = pick(body, 'reopenWindowDays', 'reopen_window_days');

  return {
    slug,
    version: meta.version ?? 1,
    bodyFormatVersion: meta.bodyFormatVersion ?? 1,
    recordTypes: readStringArray(
      pick(body, 'recordTypes', 'applies_to_record_types', 'record_types'),
    ),
    initialStatusSlug: initial,
    reopenToStatusSlug: typeof reopenTo === 'string' ? reopenTo : null,
    autoCloseAfterDays: autoClose === undefined ? null : readNumber(autoClose, 0) || null,
    reopenWindowDays: reopenWindow === undefined ? null : readNumber(reopenWindow, 0) || null,
    statuses,
    statusBySlug,
    transitions,
    isFallback: false,
  };
}

/**
 * The machine used when a tenant has no published `state_machine` — an admin
 * can archive any baseline object, and the desk must degrade rather than throw
 * (see BASELINE_SLUGS: "fallbacks, never guarantees").
 *
 * One status per category, and every move allowed from anywhere: permissive on
 * purpose, because a desk that cannot move a ticket at all is a worse failure
 * than one whose lifecycle is temporarily flat.
 */
function buildFallbackMachine(slug: string): NormalizedStateMachine {
  const statuses: NormalizedStatus[] = STATUS_CATEGORIES.map((category, index) => ({
    slug: category,
    category,
    label: { en: category.replace(/_/g, ' ') },
    sortOrder: (index + 1) * 10,
    portalVisible: true,
    isDefault: category === 'new',
  }));

  const transitions: NormalizedTransition[] = statuses.map((status, index) => ({
    slug: `to_${status.slug}`,
    from: '*',
    to: status.slug,
    label: status.label,
    guard: null,
    requiredFields: [],
    requiredCapabilities: [CAPABILITIES.TICKET_RW],
    allowedRoles: null,
    allowedActorTypes: null,
    promptFor: [],
    confirm: false,
    effects: [],
    autoWhen: null,
    sortOrder: (index + 1) * 10,
  }));

  return {
    slug,
    version: 0,
    bodyFormatVersion: 1,
    recordTypes: [],
    initialStatusSlug: 'new',
    reopenToStatusSlug: 'open',
    autoCloseAfterDays: null,
    reopenWindowDays: null,
    statuses,
    statusBySlug: new Map(statuses.map((s) => [s.slug, s])),
    transitions,
    isFallback: true,
  };
}

/** Load (and cache) a published state machine. Never throws. */
export async function loadStateMachine(
  tenantId: number,
  slug: string = BASELINE_SLUGS.stateMachine,
  executor: Executor = db,
): Promise<NormalizedStateMachine> {
  const key = cacheKey(tenantId, slug);
  const hit = machineCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const row = await readPublishedConfigObject(tenantId, 'state_machine', slug, executor);
  const machine = row
    ? normalizeStateMachineBody(row.slug, row.body, {
        version: row.version,
        bodyFormatVersion: row.bodyFormatVersion,
      })
    : buildFallbackMachine(slug);

  machineCache.set(key, { value: machine, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
  return machine;
}

/**
 * Which machine drives this ticket. A queue may name its own
 * (`default_state_machine` / `stateMachineSlug`); otherwise the baseline.
 */
export async function loadStateMachineForTicket(
  tenantId: number,
  ticket: { queueSlug?: string | null },
  executor: Executor = db,
): Promise<NormalizedStateMachine> {
  if (ticket.queueSlug) {
    const queue = await readPublishedConfigObject(tenantId, 'queue', ticket.queueSlug, executor);
    const named = queue
      ? pick(queue.body, 'stateMachineSlug', 'default_state_machine', 'state_machine')
      : undefined;
    if (typeof named === 'string' && named.trim() !== '') {
      return loadStateMachine(tenantId, named, executor);
    }
  }
  return loadStateMachine(tenantId, BASELINE_SLUGS.stateMachine, executor);
}

/** The category a status slug carries, or null when the machine has no such status. */
export function categoryOf(
  machine: NormalizedStateMachine,
  statusSlug: string,
): StatusCategory | null {
  return machine.statusBySlug.get(statusSlug)?.category ?? null;
}

/** First status carrying a category — how engines pick "the cancelled status". */
export function statusForCategory(
  machine: NormalizedStateMachine,
  category: StatusCategory,
): NormalizedStatus | null {
  return machine.statuses.find((status) => status.category === category) ?? null;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — field-level required-ness
// ═════════════════════════════════════════════════════════════════════════════

export interface RequiredWhenField {
  slug: string;
  /** Key inside `tickets.data`. */
  key: string;
  /** Canonical path, e.g. `ticket.data.vendor_ref`. */
  path: string;
  label: LocalizedLabel;
  requiredWhen: ConditionNode | null;
  appliesToRecordTypes: string[];
}

/**
 * Load the `field` config objects that declare a `requiredWhen`.
 *
 * The baseline declares required-ness only on transitions (correctly — HARD
 * RULE 12), so this is usually empty; it exists because `FieldBody.requiredWhen`
 * is part of the shared contract and a tenant may use it. Evaluated at the same
 * moment, by the same evaluator, as the transition's own `requiredFields`.
 */
export async function loadRequiredWhenFields(
  tenantId: number,
  executor: Executor = db,
): Promise<RequiredWhenField[]> {
  const key = cacheKey(tenantId, '::fields');
  const hit = fieldCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const rows = await listPublishedConfigObjects(tenantId, 'field', executor);
  const fields: RequiredWhenField[] = [];

  for (const row of rows) {
    const requiredWhen = toConditionNode(pick(row.body, 'requiredWhen', 'required_when'));
    if (!requiredWhen) continue;
    const fieldKey = typeof row.body.key === 'string' ? row.body.key : row.slug;
    fields.push({
      slug: row.slug,
      key: fieldKey,
      path: `ticket.data.${fieldKey}`,
      label: readLabel(row.body.label, row.name),
      requiredWhen,
      appliesToRecordTypes: readStringArray(
        pick(row.body, 'appliesToRecordTypes', 'applies_to_record_types'),
      ),
    });
  }

  fieldCache.set(key, { value: fields, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
  return fields;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — the transition evaluator
// ═════════════════════════════════════════════════════════════════════════════

export interface TransitionActor {
  userId: number | null;
  username?: string | null;
  role?: string | null;
  actorType: ActorType;
  capabilities: readonly Capability[];
  assignmentGroupIds?: readonly number[];
  isAdmin?: boolean;
}

/**
 * Values the guard language calls `context.*`: things that are true ABOUT the
 * ticket but are not columns on it. The caller computes them because only the
 * caller knows which are worth a query — `availableTransitions()` for a list of
 * ten tickets must not run ten journal counts.
 */
export interface TransitionContextExtras {
  publicReplyCount?: number;
  businessDaysInStatus?: number;
  businessDaysSinceClosed?: number;
  approvalState?: string | null;
  openApprovalCount?: number;
  attachmentCount?: number;
  [key: string]: unknown;
}

export type BlockedReasonCode =
  | 'unknown_status'
  | 'no_transition'
  | 'terminal_status'
  | 'missing_field'
  | 'missing_capability'
  | 'role_not_allowed'
  | 'actor_type_not_allowed'
  | 'guard_failed'
  /** An approval is still pending. Merged in by `applyApprovalBlocks()`. */
  | 'approval_pending';

/**
 * One reason a move is refused, structured so the client renders it through
 * `t()` (HARD RULE 10) and falls back to readable French when a key is missing.
 */
export interface BlockedReason {
  code: BlockedReasonCode;
  i18nKey: string;
  fallback: string;
  params?: Record<string, unknown>;
}

export interface TransitionDecision extends TransitionEvaluation {
  transitionSlug: string | null;
  label: LocalizedLabel;
  toCategory: StatusCategory | null;
  blocked: BlockedReason[];
  promptFor: string[];
  confirm: boolean;
  effects: TransitionEffect[];
}

export interface EvaluateTransitionInput {
  machine: NormalizedStateMachine;
  ticket: Ticket;
  actor: TransitionActor;
  toStatusSlug: string;
  /** Values collected by the transition dialog; merged OVER the ticket. */
  fields?: Record<string, unknown>;
  extras?: TransitionContextExtras;
  requiredWhenFields?: readonly RequiredWhenField[];
  /** ENGINES MUST PASS THIS so the decision_log row is replayable. */
  now?: string;
}

// ── Context construction ─────────────────────────────────────────────────────

function ticketFieldValues(ticket: Ticket): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, ref] of TICKET_FIELDS) {
    const value = (ticket as unknown as Record<string, unknown>)[snakeToCamel(key)];
    out[ref.path] = value ?? null;
    // Bare spelling too: `@oblidesk/shared` documents leaves as `status_category`
    // while the shipped bodies write `ticket.status_category`. Both resolve.
    out[key] = value ?? null;
  }
  for (const [key, value] of Object.entries(ticket.data ?? {})) {
    out[`ticket.data.${key}`] = value ?? null;
    out[`data.${key}`] = value ?? null;
  }
  return out;
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, chr: string) => chr.toUpperCase());
}

/**
 * Build the evaluation context for a guard, a required-ness check or a rule.
 *
 * `pending` (the transition dialog's values) is layered OVER the ticket so
 * "resolution notes are empty" is answered against what the agent is about to
 * save, not against what is on disk. Getting that backwards makes the dialog
 * refuse the very values it just asked for.
 */
export function buildTransitionContext(input: {
  ticket: Ticket;
  actor: TransitionActor;
  extras?: TransitionContextExtras;
  pending?: Record<string, unknown>;
  declaredFields?: readonly string[];
  now?: string;
}): ConditionContext {
  const fields: Record<string, unknown> = ticketFieldValues(input.ticket);

  fields['actor.id'] = input.actor.userId ?? null;
  fields['actor.type'] = input.actor.actorType;
  fields['actor.role'] = input.actor.role ?? null;
  fields['actor.username'] = input.actor.username ?? null;
  fields['actor.group_ids'] = [...(input.actor.assignmentGroupIds ?? [])];
  fields['actor.is_admin'] = input.actor.isAdmin === true;
  fields['actor.capabilities'] = [...input.actor.capabilities];

  for (const [key, value] of Object.entries(input.extras ?? {})) {
    fields[`context.${key}`] = value ?? null;
    fields[`context.${camelToSnake(key)}`] = value ?? null;
  }

  for (const [rawPath, value] of Object.entries(input.pending ?? {})) {
    const ref = resolveTicketFieldPath(rawPath);
    if (!ref) continue;
    fields[ref.path] = value ?? null;
    fields[ref.path.slice('ticket.'.length)] = value ?? null;
  }

  return {
    fields,
    declaredFields: input.declaredFields,
    now: input.now ?? new Date().toISOString(),
  };
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (chr) => `_${chr.toLowerCase()}`);
}

// ── The check itself ─────────────────────────────────────────────────────────

/**
 * Is a value "filled in"? Deliberately strict about the empty string and the
 * empty array, because "" in a resolution-notes box is exactly the case HARD
 * RULE 12 is protecting against.
 */
function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * French names for the built-in ticket columns, so the fallback refusal reads
 * "les notes de résolution sont vides" rather than "resolution md est vide".
 *
 * These are FALLBACKS. The structured `BlockedReason.params.field` travels with
 * every reason so the client renders the real label through `t()` (HARD RULE
 * 10); this string is what a missing key degrades to, and it should still be a
 * sentence a human can act on.
 */
const FIELD_LABELS_FR: Readonly<Record<string, string>> = {
  'ticket.subject': 'objet',
  'ticket.description_md': 'description',
  'ticket.assignee_id': 'responsable',
  'ticket.assignment_group_id': 'groupe d’affectation',
  'ticket.queue_slug': 'file',
  'ticket.priority_slug': 'priorité',
  'ticket.impact': 'impact',
  'ticket.urgency': 'urgence',
  'ticket.organization_id': 'organisation',
  'ticket.requester_contact_id': 'demandeur',
  'ticket.primary_ci_id': 'élément de configuration',
  'ticket.occurred_at': 'date de survenue',
  'ticket.due_at': 'échéance',
  'ticket.resolution_code': 'code de résolution',
  'ticket.resolution_md': 'notes de résolution',
};

function labelForPath(path: string, requiredWhenFields: readonly RequiredWhenField[]): string {
  const declared = requiredWhenFields.find((field) => field.path === path);
  if (declared) return declared.label.fr ?? declared.label.en;
  const ref = resolveTicketFieldPath(path);
  if (!ref) return path;
  return (
    FIELD_LABELS_FR[ref.path] ??
    ref.path.replace(/^ticket\.(data\.)?/, '').replace(/_/g, ' ')
  );
}

function candidateTransitions(
  machine: NormalizedStateMachine,
  fromStatusSlug: string,
  toStatusSlug: string,
): NormalizedTransition[] {
  return machine.transitions.filter(
    (t) => t.to === toStatusSlug && (t.from === '*' || t.from.includes(fromStatusSlug)),
  );
}

/**
 * Evaluate ONE move. The single implementation behind both the enabled/disabled
 * state of the header button and the server's accept/refuse — HARD RULE 12 is
 * only true if there is exactly one of these.
 */
export function evaluateTransition(input: EvaluateTransitionInput): TransitionDecision {
  const { machine, ticket, actor, toStatusSlug } = input;
  const requiredWhenFields = input.requiredWhenFields ?? [];
  const target = machine.statusBySlug.get(toStatusSlug) ?? null;

  const base: TransitionDecision = {
    toStatusSlug,
    allowed: false,
    missingRequiredFields: [],
    missingCapabilities: [],
    guardTrace: null,
    reason: null,
    transitionSlug: null,
    label: target?.label ?? { en: toStatusSlug },
    toCategory: target?.category ?? null,
    blocked: [],
    promptFor: [],
    confirm: false,
    effects: [],
  };

  if (!target) {
    base.blocked.push({
      code: 'unknown_status',
      i18nKey: 'transition.blocked.unknownStatus',
      fallback: `le statut « ${toStatusSlug} » n'existe pas dans ce cycle de vie`,
      params: { statusSlug: toStatusSlug },
    });
    return finish(base, target);
  }

  const candidates = candidateTransitions(machine, ticket.statusSlug, toStatusSlug);
  if (candidates.length === 0) {
    base.blocked.push(
      isTerminal(ticket.statusCategory)
        ? {
            code: 'terminal_status',
            i18nKey: 'transition.blocked.terminal',
            fallback: 'ce ticket est terminé et ne peut plus changer de statut',
          }
        : {
            code: 'no_transition',
            i18nKey: 'transition.blocked.noTransition',
            fallback: `aucune transition de « ${ticket.statusSlug} » vers « ${toStatusSlug} »`,
            params: { from: ticket.statusSlug, to: toStatusSlug },
          },
    );
    return finish(base, target);
  }

  // Several edges can reach the same status (an agent "resolve" and an
  // automation "auto_resolve_stale"). Evaluate every one and take the first
  // that passes — a move the actor is entitled to make by ANY route is allowed.
  let best: TransitionDecision | null = null;

  for (const transition of candidates) {
    const decision = evaluateOne(transition, input, requiredWhenFields, target);
    if (decision.allowed) return decision;
    if (!best || decision.blocked.length < best.blocked.length) best = decision;
  }
  return best ?? finish(base, target);
}

function evaluateOne(
  transition: NormalizedTransition,
  input: EvaluateTransitionInput,
  requiredWhenFields: readonly RequiredWhenField[],
  target: NormalizedStatus,
): TransitionDecision {
  const { ticket, actor } = input;
  const blocked: BlockedReason[] = [];
  const missingRequiredFields: string[] = [];
  const missingCapabilities: Capability[] = [];

  // ── Who may make the move ─────────────────────────────────────────────────
  if (transition.allowedActorTypes && transition.allowedActorTypes.length > 0) {
    if (!transition.allowedActorTypes.includes(actor.actorType)) {
      blocked.push({
        code: 'actor_type_not_allowed',
        i18nKey: 'transition.blocked.actorType',
        fallback: 'cette transition est réservée à l’automatisation',
        params: { allowed: transition.allowedActorTypes },
      });
    }
  }

  if (transition.allowedRoles && transition.allowedRoles.length > 0 && actor.isAdmin !== true) {
    const role = actor.role ?? '';
    // A contact acting from the portal has no agent role; the guard is what
    // lets them through (see the baseline 'reopen' edge), not the role list.
    if (!transition.allowedRoles.includes(role)) {
      blocked.push({
        code: 'role_not_allowed',
        i18nKey: 'transition.blocked.role',
        fallback: 'votre rôle ne permet pas cette transition',
        params: { allowed: transition.allowedRoles, role },
      });
    }
  }

  for (const capability of transition.requiredCapabilities) {
    if (actor.isAdmin === true) break;
    if (!actor.capabilities.includes(capability)) {
      missingCapabilities.push(capability);
      blocked.push({
        code: 'missing_capability',
        i18nKey: 'transition.blocked.capability',
        fallback: `il vous manque la permission « ${capability} »`,
        params: { capability },
      });
    }
  }

  // ── Required-ness (HARD RULE 12) ──────────────────────────────────────────
  //
  // Evaluated with `evaluateCondition` — the SAME function the client runs — so
  // the button's tooltip and the server's refusal can never disagree.
  const applicableRequiredWhen = requiredWhenFields.filter(
    (field) =>
      field.appliesToRecordTypes.length === 0 ||
      field.appliesToRecordTypes.includes(ticket.recordType),
  );

  const declaredPaths = [
    ...transition.requiredFields,
    ...applicableRequiredWhen.map((field) => field.path),
  ];

  const ctx = buildTransitionContext({
    ticket,
    actor,
    extras: input.extras,
    pending: input.fields,
    declaredFields: declaredPaths,
    now: input.now,
  });

  for (const path of transition.requiredFields) {
    const evaluation = evaluateCondition({ field: path, op: 'is_not_empty' }, ctx);
    if (!evaluation.matched) {
      missingRequiredFields.push(path);
      blocked.push({
        code: 'missing_field',
        i18nKey: 'transition.blocked.requiredField',
        fallback: `le champ « ${labelForPath(path, requiredWhenFields)} » est vide`,
        params: { field: path, label: labelForPath(path, requiredWhenFields) },
      });
    }
  }

  for (const field of applicableRequiredWhen) {
    if (!evaluateCondition(field.requiredWhen, ctx).matched) continue;
    if (isFilled(ctx.fields[field.path])) continue;
    missingRequiredFields.push(field.path);
    blocked.push({
      code: 'missing_field',
      i18nKey: 'transition.blocked.requiredField',
      fallback: `le champ « ${field.label.fr ?? field.label.en} » est vide`,
      params: { field: field.path, label: field.label.fr ?? field.label.en },
    });
  }

  // ── The guard ─────────────────────────────────────────────────────────────
  let guardTrace: ConditionTrace | null = null;
  if (transition.guard) {
    const resolved = resolveConditionTokens(transition.guard, {
      me: actor.userId,
      myGroups: actor.assignmentGroupIds ?? [],
      now: input.now ? new Date(input.now) : new Date(),
    });
    const evaluation = evaluateCondition(resolved, ctx);
    guardTrace = evaluation.trace;
    if (!evaluation.matched) {
      blocked.push({
        code: 'guard_failed',
        i18nKey: 'transition.blocked.guard',
        fallback: 'les conditions de cette transition ne sont pas réunies',
        params: { issues: evaluation.issues },
      });
    }
  }

  const decision: TransitionDecision = {
    toStatusSlug: transition.to,
    allowed: blocked.length === 0,
    missingRequiredFields,
    missingCapabilities,
    guardTrace,
    reason: null,
    transitionSlug: transition.slug,
    label: transition.label,
    toCategory: target.category,
    blocked,
    promptFor: transition.promptFor.length > 0 ? transition.promptFor : transition.requiredFields,
    confirm: transition.confirm,
    effects: transition.effects,
  };
  return finish(decision, target);
}

/**
 * Compose the one-line refusal the UI shows, e.g.
 *
 *   "Résoudre — bloqué : les notes de résolution sont vides ;
 *    vous n'êtes pas dans le groupe N2"
 *
 * The structured `blocked` array stays alongside it so the client can render
 * each reason through `t()` (HARD RULE 10); this string is the fallback and
 * what lands in `decision_log`.
 */
function finish(decision: TransitionDecision, target: NormalizedStatus | null): TransitionDecision {
  decision.allowed = decision.blocked.length === 0;
  if (decision.allowed) {
    decision.reason = null;
    return decision;
  }
  const label = decision.label.fr ?? decision.label.en ?? target?.slug ?? decision.toStatusSlug;
  decision.reason = `${label} — bloqué : ${decision.blocked.map((b) => b.fallback).join(' ; ')}`;
  return decision;
}

/**
 * Every move the header bar should render for this ticket and this actor.
 *
 * Returns BLOCKED transitions too — with their reasons — because a greyed-out
 * button that explains itself is the entire point; hiding it just makes the
 * agent ask a colleague why they cannot resolve the ticket.
 */
export function availableTransitions(input: {
  machine: NormalizedStateMachine;
  ticket: Ticket;
  actor: TransitionActor;
  extras?: TransitionContextExtras;
  requiredWhenFields?: readonly RequiredWhenField[];
  now?: string;
  /** Drop the blocked ones (the portal shows only what it can do). */
  allowedOnly?: boolean;
}): TransitionDecision[] {
  const { machine, ticket } = input;

  const reachable = machine.transitions.filter(
    (t) => t.from === '*' || t.from.includes(ticket.statusSlug),
  );

  const seen = new Set<string>();
  const decisions: TransitionDecision[] = [];

  for (const transition of reachable) {
    if (transition.to === ticket.statusSlug) continue; // a move to where you are is not a move
    if (seen.has(transition.to)) continue;
    seen.add(transition.to);

    const decision = evaluateTransition({
      machine,
      ticket,
      actor: input.actor,
      toStatusSlug: transition.to,
      extras: input.extras,
      requiredWhenFields: input.requiredWhenFields,
      now: input.now,
    });
    if (input.allowedOnly && !decision.allowed) continue;
    decisions.push(decision);
  }

  return decisions;
}

/** Just the refusal reasons for one move — what the button tooltip renders. */
export function blockedReasons(input: EvaluateTransitionInput): BlockedReason[] {
  return evaluateTransition(input).blocked;
}

// ─────────────────────────────────────────────────────────────────────────────
// The one refusal the synchronous evaluator cannot see
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The approval engine, resolved by a `require` at CALL time.
 *
 * This module is deliberately dependency-free (see the header: the engines boot
 * without it) and `approval.service` reaches `configObject.service`, which
 * reaches the config linter, which reaches back into the approval engine. A
 * static import would close that ring at module-initialisation time; a call-time
 * `require` closes nothing, and degrades to `null` — a desk with no approval
 * engine simply has no approvals to be blocked by.
 */
type ApprovalEngine = typeof import('./approval.service');

let approvalModule: ApprovalEngine | null | undefined;

function approvalEngine(): ApprovalEngine | null {
  if (approvalModule === undefined) {
    try {
      approvalModule = require('./approval.service') as ApprovalEngine;
    } catch {
      approvalModule = null;
    }
  }
  return approvalModule;
}

/**
 * Merge the approval engine's blocks into moves that have already been
 * evaluated.
 *
 * `evaluateTransition()` is synchronous on purpose — the header bar evaluates
 * every button for every row of a list, and a query per button would make the
 * cheapest read on the desk the most expensive one. "Is an approval pending?"
 * IS a query, so it is applied here instead, by the async caller, immediately
 * after evaluation. The result is the same `blocked` array the client already
 * renders through `t()`, carrying the approver's NAME in `params` — a button
 * that looks available and then refuses is exactly what the inspector exists to
 * prevent.
 *
 * Mutates and returns the decisions it was given: they were built one line
 * earlier by the caller and copying them would only invite the two copies to
 * disagree.
 */
export async function applyApprovalBlocks<T extends TransitionDecision>(
  tenantId: number,
  ticketId: number,
  decisions: T[],
  executor: Executor = db,
): Promise<T[]> {
  const engine = approvalEngine();
  if (!engine || decisions.length === 0) return decisions;

  // One probe for the whole ticket first. Almost every ticket has no pending
  // approval at all, and asking per candidate status just to learn that would
  // put six queries behind every header bar.
  const pending = await engine.blockingApprovals(tenantId, ticketId, executor);
  if (pending.length === 0) return decisions;

  for (const decision of decisions) {
    const blocks = await engine.transitionBlocks(
      tenantId,
      ticketId,
      decision.toStatusSlug,
      decision.toCategory,
      executor,
    );
    if (blocks.length === 0) continue;
    decision.blocked.push(...blocks);
    // Re-derive `allowed` and the one-line French reason over the widened
    // array. `finish()` only reads the target for a label fallback, and the
    // decision already carries its own.
    finish(decision, null);
  }

  return decisions;
}
