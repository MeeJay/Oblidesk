/**
 * view.service.ts — saved views.
 *
 * A saved view is a `config_objects` row of kind 'view': a condition tree, a
 * column list, a sort, an optional grouping, and a count badge. It is
 * configuration, not code, which is why "show me everything breaching in the
 * next two hours" is an edit rather than a release.
 *
 * ── Compiling a condition tree to SQL ────────────────────────────────────────
 * The same tree that `evaluateCondition` runs in memory (for one ticket, on
 * both client and server) is compiled here into a WHERE clause (for the whole
 * table). Two evaluators over one language is a real risk of drift, so the
 * split is drawn deliberately:
 *
 *   • leaves over ticket columns and `data.*`  → compiled to SQL
 *   • leaves over `actor.*`                    → folded to TRUE/FALSE here,
 *     because the actor is a constant for the duration of one query
 *   • leaves needing a before/after snapshot (`changed`, `changed_to`, …) or
 *     an engine-computed `context.*` value → NOT compilable, folded to FALSE
 *     and reported in `warnings`
 *
 * Folding closed rather than open is the load-bearing choice: an uncompilable
 * predicate that returns everything silently shows an agent tickets they had
 * filtered out, while one that returns nothing is obviously broken and gets
 * fixed. The config linter flags these at publish time so it should rarely
 * matter — this is the second line, not the first.
 *
 * ── Counts ───────────────────────────────────────────────────────────────────
 * The sidebar badge is the single most frequently recomputed number in the
 * product, and `COUNT(*)` over an unbounded ticket table on every socket tick
 * is how a service desk turns into a load test. So the count is:
 *
 *   1. debounced in memory per (tenant, view, user);
 *   2. computed EXACTLY only while it is small, using a LIMIT probe that stops
 *      counting at `PAGINATION.exactCountThreshold` instead of walking the
 *      whole match set;
 *   3. above the threshold, reported as approximate, backed by the planner's
 *      own row estimate — "5 000+" is the honest answer, and it is the answer
 *      a human wanted anyway.
 */

import type { Knex } from 'knex';

import {
  PAGINATION,
  parseDurationMs,
  toTimestampMs,
  type Capability,
  type ConditionNode,
} from '@oblidesk/shared';

import { db, scoped, type Executor } from '../db';
import { normalizeConditionTree, normalizeFieldPath, TICKET_COLUMNS } from './configLinter.service';
import {
  ConfigServiceError,
  loadPublished,
  createConfigObject,
  updateConfigObject,
  publishConfigObject,
  archiveConfigObject,
  type ConfigActor,
} from './configObject.service';
import { loadFieldCatalog, type FieldCatalog, type FieldDefinition } from './customField.service';

// ═════════════════════════════════════════════════════════════════════════════
// Definitions
// ═════════════════════════════════════════════════════════════════════════════

export interface ViewColumn {
  field: string;
  width: number | null;
  align: 'left' | 'center' | 'right';
  sortOrder: number;
}

export interface ViewSort {
  field: string;
  direction: 'asc' | 'desc';
}

export interface ViewDefinition {
  slug: string;
  name: string;
  description: string | null;
  scope: 'personal' | 'tenant' | 'system';
  filter: ConditionNode | null;
  columns: ViewColumn[];
  sort: ViewSort[];
  groupBy: string | null;
  pageSize: number;
  showCount: boolean;
  icon: string | null;
  layout: 'table' | 'board' | 'split';
  refreshSeconds: number | null;
  visibleToCapabilities: string[];
  sortOrder: number;
  shared: boolean;
}

const DEFAULT_COLUMNS: readonly string[] = [
  'number', 'subject', 'status_slug', 'priority_slug',
  'assignee_id', 'queue_slug', 'due_at', 'updated_at',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

/** Read a view body in either dialect (baseline snake_case, or configKinds). */
export function normalizeViewBody(slug: string, name: string, body: Record<string, unknown>, shared = false): ViewDefinition {
  const rawColumns = Array.isArray(body.columns) ? body.columns : [...DEFAULT_COLUMNS];
  const columns: ViewColumn[] = rawColumns.map((column, index) => {
    if (typeof column === 'string') {
      return { field: normalizeFieldPath(column), width: null, align: 'left', sortOrder: (index + 1) * 10 };
    }
    if (isRecord(column) && typeof column.field === 'string') {
      const align = column.align;
      return {
        field: normalizeFieldPath(column.field),
        width: typeof column.width === 'number' ? column.width : null,
        align: align === 'center' || align === 'right' ? align : 'left',
        sortOrder: typeof column.sortOrder === 'number' ? column.sortOrder : (index + 1) * 10,
      };
    }
    return { field: 'subject', width: null, align: 'left', sortOrder: (index + 1) * 10 };
  });

  const rawSort = Array.isArray(body.sort) ? body.sort : [];
  const sort: ViewSort[] = rawSort
    .filter(isRecord)
    .map((entry) => {
      // Both dialects again: the baseline writes `dir`, configKinds `direction`.
      const direction = firstString(entry.direction, entry.dir) ?? 'desc';
      return {
        field: normalizeFieldPath(String(entry.field ?? 'updated_at')),
        direction: direction === 'asc' ? 'asc' : 'desc',
      };
    });

  const scopeRaw = firstString(body.scope);
  const scope: ViewDefinition['scope'] =
    scopeRaw === 'personal' || scopeRaw === 'system' ? scopeRaw : 'tenant';

  const layoutRaw = firstString(body.layout);
  const layout: ViewDefinition['layout'] =
    layoutRaw === 'board' || layoutRaw === 'split' ? layoutRaw : 'table';

  const capabilities = Array.isArray(body.visibleToCapabilities ?? body.visible_to_capabilities)
    ? (body.visibleToCapabilities ?? body.visible_to_capabilities as unknown[])
    : [];

  return {
    slug,
    name,
    description: firstString(body.description) ?? null,
    scope,
    filter: normalizeConditionTree(body.filter ?? null),
    columns,
    sort: sort.length > 0 ? sort : [{ field: 'updated_at', direction: 'desc' }],
    groupBy: firstString(body.groupBy, body.group_by),
    pageSize: Math.min(
      Math.max(Number(body.pageSize ?? body.page_size ?? PAGINATION.defaultLimit) || PAGINATION.defaultLimit, 1),
      PAGINATION.maxLimit,
    ),
    showCount: (body.showCount ?? body.count_badge ?? body.show_count) !== false,
    icon: firstString(body.icon),
    layout,
    refreshSeconds: Number.isFinite(Number(body.refreshSeconds)) ? Number(body.refreshSeconds) : null,
    visibleToCapabilities: (capabilities as unknown[]).filter((value): value is string => typeof value === 'string'),
    sortOrder: Number(body.sortOrder ?? body.order ?? 1000) || 1000,
    shared,
  };
}

/** Every published view the actor is allowed to see, in sidebar order. */
export async function listViews(
  tenantId: number,
  actor: ConfigActor,
  executor: Executor = db,
): Promise<ViewDefinition[]> {
  const published = await loadPublished(tenantId, 'view', executor);
  const held = new Set<string>(actor.capabilities as unknown as string[]);

  const views: ViewDefinition[] = [];
  for (const entry of published.values()) {
    const view = normalizeViewBody(entry.slug, entry.name, entry.body, entry.shared);
    if (view.visibleToCapabilities.length > 0 && !actor.isAdmin) {
      if (!view.visibleToCapabilities.some((capability) => held.has(capability))) continue;
    }
    views.push(view);
  }

  views.sort((a, b) => (a.sortOrder === b.sortOrder ? a.slug.localeCompare(b.slug) : a.sortOrder - b.sortOrder));
  return views;
}

export async function getView(
  tenantId: number,
  slug: string,
  executor: Executor = db,
): Promise<ViewDefinition | null> {
  const published = await loadPublished(tenantId, 'view', executor);
  const entry = published.get(slug.toLowerCase());
  return entry ? normalizeViewBody(entry.slug, entry.name, entry.body, entry.shared) : null;
}

export async function requireView(tenantId: number, slug: string): Promise<ViewDefinition> {
  const view = await getView(tenantId, slug);
  if (!view) throw new ConfigServiceError(404, `No published view with the slug "${slug}".`, 'not_found');
  return view;
}

// ═════════════════════════════════════════════════════════════════════════════
// Condition → SQL
// ═════════════════════════════════════════════════════════════════════════════

export interface CompileContext {
  actor: ConfigActor;
  now: Date;
  catalog: FieldCatalog;
  /** Predicates that could not be compiled, for the UI to show honestly. */
  warnings: string[];
}

const TICKET_COLUMN_SET = new Set(TICKET_COLUMNS);

/** Columns whose values are timestamps — drives duration operators and casts. */
const TIMESTAMP_COLUMNS = new Set([
  'occurred_at', 'created_at', 'updated_at', 'first_response_at',
  'resolved_at', 'closed_at', 'due_at', 'deleted_at',
]);

const NUMERIC_COLUMNS = new Set([
  'id', 'assignment_group_id', 'assignee_id', 'requester_contact_id',
  'requester_user_id', 'organization_id', 'primary_ci_id', 'reopen_count',
  'parent_ticket_id', 'merged_into_id', 'csat_score', 'row_version',
]);

type ColumnKind = 'text' | 'number' | 'timestamp' | 'boolean' | 'unsupported';

interface ColumnRef {
  /** Raw SQL for the value, with bindings applied. */
  sql: string;
  bindings: Knex.RawBinding[];
  kind: ColumnKind;
}

/**
 * Resolve one normalised field path to SQL.
 *
 * `data.<key>` becomes a jsonb text extraction, cast to the type its field
 * object declares. The cast is driven by the DECLARATION, never guessed from
 * the stored value — `coerceFieldValue` on the write path is what guarantees a
 * numeric field holds numbers, so the cast is safe precisely because the write
 * path refuses anything else.
 */
function resolveColumn(field: string, ctx: CompileContext): ColumnRef {
  if (TICKET_COLUMN_SET.has(field)) {
    const kind: ColumnKind = TIMESTAMP_COLUMNS.has(field)
      ? 'timestamp'
      : NUMERIC_COLUMNS.has(field) ? 'number' : 'text';
    return { sql: `tickets.${field}`, bindings: [], kind };
  }

  if (field.startsWith('data.')) {
    const key = field.slice('data.'.length);
    const definition: FieldDefinition | undefined = ctx.catalog.byKey.get(key);
    const base = `NULLIF(tickets.data ->> ?, '')`;

    switch (definition?.type) {
      case 'number':
      case 'currency':
      case 'duration':
        return { sql: `(${base})::numeric`, bindings: [key], kind: 'number' };
      case 'date':
      case 'datetime':
        return { sql: `(${base})::timestamptz`, bindings: [key], kind: 'timestamp' };
      case 'boolean':
        return { sql: `(${base})::boolean`, bindings: [key], kind: 'boolean' };
      case 'user':
      case 'group':
      case 'contact':
      case 'organization':
      case 'ci':
      case 'ticket':
        return { sql: `(${base})::numeric`, bindings: [key], kind: 'number' };
      default:
        return { sql: base, bindings: [key], kind: 'text' };
    }
  }

  return { sql: '', bindings: [], kind: 'unsupported' };
}

/**
 * Resolve a value token.
 *   '@me'         → the acting user's id
 *   '@my_groups'  → the acting user's assignment group ids
 *   '@now'        → evaluation instant
 *   '@now+2h'     → evaluation instant plus an offset (m | h | d | w)
 */
function resolveValue(raw: unknown, ctx: CompileContext): unknown {
  if (Array.isArray(raw)) return raw.flatMap((entry) => {
    const resolved = resolveValue(entry, ctx);
    return Array.isArray(resolved) ? resolved : [resolved];
  });

  if (typeof raw !== 'string' || !raw.startsWith('@')) return raw;

  if (raw === '@me') return ctx.actor.userId;
  if (raw === '@my_groups') return ctx.actor.groupIds;

  if (raw.startsWith('@now')) {
    const rest = raw.slice('@now'.length).trim();
    if (rest === '') return ctx.now;
    const sign = rest.startsWith('-') ? -1 : 1;
    const ms = parseDurationMs(rest.replace(/^[+-]/, ''));
    if (ms === null) return ctx.now;
    return new Date(ctx.now.getTime() + sign * ms);
  }

  return raw;
}

/**
 * Values a SQL comparison can actually take.
 *
 * Anything that is not a primitive is stringified rather than passed through:
 * a nested object arriving from a config body must never reach the driver as a
 * binding, where it would be serialised by whatever rule pg happens to apply.
 */
function toBindable(value: unknown, kind: ColumnKind): Knex.RawBinding {
  if (value instanceof Date) return value.toISOString();
  if (kind === 'timestamp' && typeof value === 'string') {
    const ms = toTimestampMs(value);
    return ms === null ? value : new Date(ms).toISOString();
  }
  if (value === null || value === undefined) return null as unknown as Knex.RawBinding;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

/**
 * Compile one node onto a knex builder. Every branch groups its children so
 * operator precedence survives nesting — a missing group is how `a AND (b OR
 * c)` quietly becomes `(a AND b) OR c` and a view starts showing other
 * people's tickets.
 */
export function compileCondition(
  builder: Knex.QueryBuilder,
  node: ConditionNode | null | undefined,
  ctx: CompileContext,
  depth = 0,
): void {
  if (node === null || node === undefined || depth > 32) return;

  if (isRecord(node) && Array.isArray((node as { all?: unknown[] }).all)) {
    const children = (node as { all: ConditionNode[] }).all;
    if (children.length === 0) return; // empty `all` = no restriction
    builder.where((group) => {
      for (const child of children) group.andWhere((inner) => compileCondition(inner, child, ctx, depth + 1));
    });
    return;
  }

  if (isRecord(node) && Array.isArray((node as { any?: unknown[] }).any)) {
    const children = (node as { any: ConditionNode[] }).any;
    if (children.length === 0) {
      // `{ any: [] }` has no alternative to satisfy: it matches nothing.
      builder.whereRaw('1 = 0');
      return;
    }
    builder.where((group) => {
      for (const child of children) group.orWhere((inner) => compileCondition(inner, child, ctx, depth + 1));
    });
    return;
  }

  if (isRecord(node) && (node as { not?: unknown }).not !== undefined) {
    const inner = (node as { not: ConditionNode }).not;
    builder.whereNot((group) => compileCondition(group, inner, ctx, depth + 1));
    return;
  }

  // `ConditionLeaf` is an interface, so narrowing the union by property access
  // deletes it (an interface has no implicit index signature). Read the leaf
  // through an explicit shape instead — the same reason `conditions.ts` keeps
  // an `isObjectLike` without a type predicate.
  const leaf = node as unknown as { field?: unknown; op?: unknown; value?: unknown };
  if (!isRecord(node) || typeof leaf.field !== 'string' || typeof leaf.op !== 'string') {
    ctx.warnings.push('A malformed condition node was skipped and treated as no match.');
    builder.whereRaw('1 = 0');
    return;
  }

  compileLeaf(builder, leaf.field, leaf.op, leaf.value, ctx);
}

function compileLeaf(
  builder: Knex.QueryBuilder,
  rawField: string,
  op: string,
  rawValue: unknown,
  ctx: CompileContext,
): void {
  const field = normalizeFieldPath(rawField);

  // ── actor.* is a constant for this query: fold it now ───────────────────
  if (field.startsWith('actor.')) {
    builder.whereRaw(evaluateActorLeaf(field, op, rawValue, ctx) ? '1 = 1' : '1 = 0');
    return;
  }

  // ── diff and engine-computed leaves cannot become SQL ───────────────────
  if (['changed', 'changed_to', 'changed_from'].includes(op)) {
    ctx.warnings.push(
      `"${rawField} ${op}" needs a before/after snapshot, which a list query does not have. It was treated as no match.`,
    );
    builder.whereRaw('1 = 0');
    return;
  }

  const column = resolveColumn(field, ctx);
  if (column.kind === 'unsupported') {
    ctx.warnings.push(
      `"${rawField}" is not a ticket column and no field object declares it, so the filter could not be applied and was treated as no match.`,
    );
    builder.whereRaw('1 = 0');
    return;
  }

  const value = resolveValue(rawValue, ctx);
  const { sql, bindings } = column;

  switch (op) {
    case 'eq': {
      if (value === null || value === undefined) { builder.whereRaw(`${sql} IS NULL`, bindings); return; }
      builder.whereRaw(`${sql} = ?`, [...bindings, toBindable(value, column.kind)]);
      return;
    }
    case 'neq': {
      if (value === null || value === undefined) { builder.whereRaw(`${sql} IS NOT NULL`, bindings); return; }
      // `<>` is false for NULL, which would silently drop unset rows from a
      // "not equal" filter. NULL is genuinely "not equal to X", so say so.
      builder.whereRaw(`(${sql} IS NULL OR ${sql} <> ?)`, [...bindings, ...bindings, toBindable(value, column.kind)]);
      return;
    }
    case 'in':
    case 'not_in': {
      const list = (Array.isArray(value) ? value : [value])
        .filter((entry) => entry !== null && entry !== undefined)
        .map((entry) => toBindable(entry, column.kind));
      if (list.length === 0) {
        builder.whereRaw(op === 'in' ? '1 = 0' : '1 = 1');
        return;
      }
      const placeholders = list.map(() => '?').join(', ');
      builder.whereRaw(
        op === 'in' ? `${sql} IN (${placeholders})` : `(${sql} IS NULL OR ${sql} NOT IN (${placeholders}))`,
        op === 'in' ? [...bindings, ...list] : [...bindings, ...bindings, ...list],
      );
      return;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const operator = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      builder.whereRaw(`${sql} ${operator} ?`, [...bindings, toBindable(value, column.kind)]);
      return;
    }
    case 'contains':
      builder.whereRaw(`${sql}::text ILIKE ?`, [...bindings, `%${escapeLike(String(value))}%`]);
      return;
    case 'not_contains':
      builder.whereRaw(`(${sql} IS NULL OR ${sql}::text NOT ILIKE ?)`, [...bindings, ...bindings, `%${escapeLike(String(value))}%`]);
      return;
    case 'starts_with':
      builder.whereRaw(`${sql}::text ILIKE ?`, [...bindings, `${escapeLike(String(value))}%`]);
      return;
    case 'ends_with':
      builder.whereRaw(`${sql}::text ILIKE ?`, [...bindings, `%${escapeLike(String(value))}`]);
      return;
    case 'is_empty':
      builder.whereRaw(`(${sql} IS NULL OR ${sql}::text = '')`, [...bindings, ...bindings]);
      return;
    case 'is_not_empty':
      builder.whereRaw(`(${sql} IS NOT NULL AND ${sql}::text <> '')`, [...bindings, ...bindings]);
      return;
    case 'older_than':
    case 'newer_than': {
      const ms = parseDurationMs(value);
      if (ms === null || column.kind !== 'timestamp') {
        ctx.warnings.push(`"${rawField} ${op}" needs a timestamp column and a duration; it was treated as no match.`);
        builder.whereRaw('1 = 0');
        return;
      }
      const cutoff = new Date(ctx.now.getTime() - ms).toISOString();
      builder.whereRaw(`${sql} ${op === 'older_than' ? '<' : '>'} ?`, [...bindings, cutoff]);
      return;
    }
    case 'matches': {
      // `~*` on a user-supplied pattern is a documented ReDoS surface, so the
      // pattern length is capped. Postgres regexes are not backtracking-free,
      // and a saved view is authored by an admin, not a stranger — but a
      // 4 000-character pattern in a config object is still not a thing that
      // should be able to pin a core.
      const pattern = String(value);
      if (pattern.length > 256) {
        ctx.warnings.push(`The regular expression on "${rawField}" is too long to run safely and was skipped.`);
        builder.whereRaw('1 = 0');
        return;
      }
      builder.whereRaw(`${sql}::text ~* ?`, [...bindings, pattern]);
      return;
    }
    default:
      ctx.warnings.push(`Unknown operator "${op}" on "${rawField}"; treated as no match.`);
      builder.whereRaw('1 = 0');
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Fold an `actor.*` leaf against the actor — a constant for one query. */
function evaluateActorLeaf(field: string, op: string, rawValue: unknown, ctx: CompileContext): boolean {
  const attribute = field.slice('actor.'.length);
  const actual: unknown = ({
    id: ctx.actor.userId,
    user_id: ctx.actor.userId,
    role: ctx.actor.role,
    type: ctx.actor.actorType,
    is_admin: ctx.actor.isAdmin,
    tenant_id: ctx.actor.tenantId,
    group_ids: ctx.actor.groupIds,
  } as Record<string, unknown>)[attribute];

  const value = resolveValue(rawValue, ctx);

  switch (op) {
    case 'eq': return actual === value;
    case 'neq': return actual !== value;
    case 'in': return Array.isArray(value) && value.includes(actual as never);
    case 'not_in': return !(Array.isArray(value) && value.includes(actual as never));
    case 'is_empty': return actual === null || actual === undefined || actual === '';
    case 'is_not_empty': return !(actual === null || actual === undefined || actual === '');
    case 'contains': return String(actual ?? '').toLowerCase().includes(String(value).toLowerCase());
    default:
      ctx.warnings.push(`Operator "${op}" is not supported on "${field}".`);
      return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Query building
// ═════════════════════════════════════════════════════════════════════════════

export interface ViewQuery {
  query: Knex.QueryBuilder;
  warnings: string[];
  view: ViewDefinition;
}

/**
 * Build the scoped, filtered `tickets` query behind a view.
 *
 * Soft-deleted rows are excluded here rather than in every caller: a saved
 * view is a working list, and a deleted ticket appearing in one is always a
 * bug, never a feature.
 */
export async function buildViewQuery(
  tenantId: number,
  actor: ConfigActor,
  view: ViewDefinition,
  options: { extraFilter?: ConditionNode | null; now?: Date; executor?: Executor } = {},
): Promise<ViewQuery> {
  const executor = options.executor ?? db;
  const catalog = await loadFieldCatalog(tenantId, executor);
  const ctx: CompileContext = {
    actor,
    now: options.now ?? new Date(),
    catalog,
    warnings: [],
  };

  const query = scoped('tickets', tenantId, executor).whereNull('tickets.deleted_at');

  if (view.filter) query.where((group) => compileCondition(group, view.filter, ctx));
  if (options.extraFilter) {
    const extra = normalizeConditionTree(options.extraFilter);
    if (extra) query.where((group) => compileCondition(group, extra, ctx));
  }

  return { query, warnings: ctx.warnings, view };
}

/** Same, by slug. */
export async function buildViewQueryBySlug(
  tenantId: number,
  actor: ConfigActor,
  slug: string,
  options: { extraFilter?: ConditionNode | null; now?: Date } = {},
): Promise<ViewQuery> {
  const view = await requireView(tenantId, slug);
  return buildViewQuery(tenantId, actor, view, options);
}

/** Apply the view's sort. Unknown sort fields are dropped, not guessed at. */
function applySort(query: Knex.QueryBuilder, view: ViewDefinition, catalog: FieldCatalog): void {
  let applied = 0;
  for (const entry of view.sort) {
    if (TICKET_COLUMN_SET.has(entry.field)) {
      // NULLS LAST on ascending: a ticket with no due date is not the most
      // urgent one on the desk, which is what the default ordering implies.
      query.orderByRaw(`tickets.${entry.field} ${entry.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`);
      applied += 1;
      continue;
    }
    if (entry.field.startsWith('data.')) {
      const key = entry.field.slice('data.'.length);
      if (!catalog.byKey.has(key)) continue;
      query.orderByRaw(`tickets.data ->> ? ${entry.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`, [key]);
      applied += 1;
    }
  }
  if (applied === 0) query.orderBy('tickets.updated_at', 'desc');
  // A stable tiebreaker: without it, two rows with the same updated_at can
  // swap between pages and the virtualised list duplicates or drops one.
  query.orderBy('tickets.id', 'desc');
}

export interface ViewPage {
  rows: Array<Record<string, unknown>>;
  page: number;
  limit: number;
  warnings: string[];
}

/** One page of a view. Keyset-friendly ordering, virtualised on the client. */
export async function listViewTickets(
  tenantId: number,
  actor: ConfigActor,
  slug: string,
  options: { page?: number; limit?: number; extraFilter?: ConditionNode | null } = {},
): Promise<ViewPage> {
  const view = await requireView(tenantId, slug);
  const { query, warnings } = await buildViewQuery(tenantId, actor, view, {
    extraFilter: options.extraFilter ?? null,
  });
  const catalog = await loadFieldCatalog(tenantId);

  const limit = Math.min(Math.max(options.limit ?? view.pageSize, 1), PAGINATION.maxLimit);
  const page = Math.max(options.page ?? 1, 1);

  applySort(query, view, catalog);
  const rows = (await query
    .select('tickets.*')
    .limit(limit)
    .offset((page - 1) * limit)) as Array<Record<string, unknown>>;

  return { rows, page, limit, warnings };
}

// ═════════════════════════════════════════════════════════════════════════════
// Counts
// ═════════════════════════════════════════════════════════════════════════════

export interface ViewCount {
  viewSlug: string;
  count: number;
  /** True when `count` is the threshold and the real number is higher. */
  approximate: boolean;
  /** The planner's row estimate when approximate; null otherwise. */
  estimate: number | null;
  computedAt: string;
  warnings: string[];
}

interface CountCacheEntry { value: ViewCount; at: number }

const countCache = new Map<string, CountCacheEntry>();

/**
 * How long a badge may be stale. Fifteen seconds is chosen against the socket:
 * `queue:counters` / `view:counters` fan out far more often than that on a
 * busy desk, and a badge that is a few seconds behind has never confused
 * anybody — a badge that costs a sequential scan every time somebody types has.
 */
export const COUNT_DEBOUNCE_MS = 15_000;

function cacheKey(tenantId: number, slug: string, userId: number | null): string {
  return `${tenantId}:${slug.toLowerCase()}:${userId ?? 0}`;
}

/** Drop cached counts — call when a ticket changes in a way that shifts them. */
export function invalidateViewCounts(tenantId: number, viewSlug?: string): void {
  const prefix = viewSlug ? `${tenantId}:${viewSlug.toLowerCase()}:` : `${tenantId}:`;
  for (const key of countCache.keys()) if (key.startsWith(prefix)) countCache.delete(key);
}

/**
 * Count a view.
 *
 * The LIMIT probe is the point: `SELECT count(*) FROM (SELECT 1 FROM tickets
 * WHERE … LIMIT 5001) probe` stops the executor after 5 001 rows. A desk with
 * 400 000 closed tickets pays for 5 001 of them, not 400 000, and the answer
 * the badge shows — "5 000+" — is the same either way.
 */
export async function countView(
  tenantId: number,
  actor: ConfigActor,
  slug: string,
  options: { force?: boolean; persist?: boolean } = {},
): Promise<ViewCount> {
  const key = cacheKey(tenantId, slug, actor.userId);
  const cached = countCache.get(key);
  if (!options.force && cached && Date.now() - cached.at < COUNT_DEBOUNCE_MS) return cached.value;

  const view = await requireView(tenantId, slug);
  const { query, warnings } = await buildViewQuery(tenantId, actor, view);

  const threshold = PAGINATION.exactCountThreshold;
  const probe = query.clone().clearSelect().clearOrder().select(db.raw('1')).limit(threshold + 1);

  const probed = (await db
    .count<{ count: string }[]>('* as count')
    .from(probe.as('probe'))
    .first()) as { count: string | number } | undefined;

  const probedCount = Number(probed?.count ?? 0);
  const approximate = probedCount > threshold;

  let estimate: number | null = null;
  if (approximate) estimate = await plannerEstimate(query);

  const result: ViewCount = {
    viewSlug: view.slug,
    count: approximate ? threshold : probedCount,
    approximate,
    estimate,
    computedAt: new Date().toISOString(),
    warnings,
  };

  countCache.set(key, { value: result, at: Date.now() });

  // `saved_view_counts` is a CACHE (its migration comment says so): safe to
  // truncate, and a stale row is a wrong badge, never a wrong list. Persisted
  // so a fresh process can paint the sidebar before it has counted anything.
  if (options.persist !== false && actor.userId !== null) {
    await db('saved_view_counts')
      .insert({
        tenant_id: tenantId,
        view_slug: view.slug,
        user_id: actor.userId,
        count: approximate ? (estimate ?? threshold) : probedCount,
        computed_at: db.fn.now(),
      })
      .onConflict(['tenant_id', 'view_slug', 'user_id'])
      .merge(['count', 'computed_at']);
  }

  return result;
}

/**
 * Ask the planner how many rows it expects. This is an estimate from
 * statistics, not a count — which is exactly what "5 000+" should be backed
 * by, and it costs one EXPLAIN rather than one scan.
 */
async function plannerEstimate(query: Knex.QueryBuilder): Promise<number | null> {
  try {
    const { sql, bindings } = query.clone().clearSelect().clearOrder().select(db.raw('1')).toSQL().toNative();
    const explained = await db.raw(`EXPLAIN (FORMAT JSON) ${sql}`, bindings as never);
    const rows = (explained as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    const plan = rows[0]?.['QUERY PLAN'];
    const parsed = typeof plan === 'string' ? JSON.parse(plan) : plan;
    const estimate = Array.isArray(parsed) ? parsed[0]?.Plan?.['Plan Rows'] : undefined;
    return typeof estimate === 'number' ? Math.round(estimate) : null;
  } catch {
    // An estimate is a nicety. Failing to get one must never fail the badge.
    return null;
  }
}

/** Counts for every view the actor can see — one sidebar paint. */
export async function countAllViews(
  tenantId: number,
  actor: ConfigActor,
  options: { force?: boolean } = {},
): Promise<ViewCount[]> {
  const views = await listViews(tenantId, actor);
  const out: ViewCount[] = [];
  // Sequential on purpose: this runs on a socket tick, and firing a dozen
  // concurrent counts at a pool of ten connections starves the request path.
  for (const view of views) {
    if (!view.showCount) continue;
    out.push(await countView(tenantId, actor, view.slug, options));
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// Grouping
// ═════════════════════════════════════════════════════════════════════════════

export interface ViewGroupCount {
  value: string | null;
  count: number;
}

/**
 * Counts per group — the kanban column headers and the "open by queue" chart.
 * Capped so a group-by over a high-cardinality column (a free-text field, a
 * user id on a big desk) returns a chart instead of a wall.
 */
export async function countViewByGroup(
  tenantId: number,
  actor: ConfigActor,
  slug: string,
  groupBy?: string,
  limit = 50,
): Promise<{ groups: ViewGroupCount[]; warnings: string[] }> {
  const view = await requireView(tenantId, slug);
  const field = normalizeFieldPath(groupBy ?? view.groupBy ?? 'queue_slug');
  const { query, warnings } = await buildViewQuery(tenantId, actor, view);
  const catalog = await loadFieldCatalog(tenantId);

  const column = resolveColumn(field, { actor, now: new Date(), catalog, warnings });
  if (column.kind === 'unsupported') {
    throw new ConfigServiceError(400, `"${field}" cannot be grouped on: it is neither a ticket column nor a declared field.`);
  }

  const rows = (await query
    .clearSelect()
    .clearOrder()
    .select(db.raw(`${column.sql}::text as group_value`, column.bindings as never))
    .count('* as count')
    .groupByRaw(`${column.sql}::text`, column.bindings as never)
    .orderByRaw('count(*) DESC')
    .limit(Math.min(Math.max(limit, 1), 200))) as Array<{ group_value: string | null; count: string }>;

  return {
    groups: rows.map((row) => ({ value: row.group_value, count: Number(row.count) })),
    warnings,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Authoring
// ═════════════════════════════════════════════════════════════════════════════

export interface SaveViewInput {
  slug: string;
  name: string;
  description?: string | null;
  filter?: ConditionNode | null;
  columns?: Array<string | ViewColumn>;
  sort?: ViewSort[];
  groupBy?: string | null;
  pageSize?: number;
  showCount?: boolean;
  icon?: string | null;
  layout?: 'table' | 'board' | 'split';
  scope?: 'personal' | 'tenant' | 'system';
  visibleToCapabilities?: Capability[];
  sortOrder?: number;
  /** Publish immediately. A view is low-risk, so this defaults to true. */
  publish?: boolean;
}

function toViewBody(input: SaveViewInput): Record<string, unknown> {
  const columns = (input.columns ?? [...DEFAULT_COLUMNS]).map((column, index) =>
    typeof column === 'string'
      ? { field: normalizeFieldPath(column), sortOrder: (index + 1) * 10 }
      : { ...column, field: normalizeFieldPath(column.field) });

  return {
    scope: input.scope ?? 'tenant',
    description: input.description ?? null,
    filter: normalizeConditionTree(input.filter ?? null),
    columns,
    sort: (input.sort ?? [{ field: 'updated_at', direction: 'desc' }]).map((entry) => ({
      field: normalizeFieldPath(entry.field),
      direction: entry.direction === 'asc' ? 'asc' : 'desc',
    })),
    groupBy: input.groupBy ?? null,
    pageSize: input.pageSize ?? PAGINATION.defaultLimit,
    showCount: input.showCount !== false,
    icon: input.icon ?? null,
    layout: input.layout ?? 'table',
    visibleToCapabilities: input.visibleToCapabilities ?? [],
    sortOrder: input.sortOrder ?? 1000,
  };
}

/** Create a view. Goes through the config store, so it is linted and versioned. */
export async function createView(actor: ConfigActor, input: SaveViewInput): Promise<ViewDefinition> {
  await createConfigObject(actor, {
    kind: 'view',
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    body: toViewBody(input),
  });
  if (input.publish !== false) await publishConfigObject(actor, 'view', input.slug, 'View created.');
  return requireView(actor.tenantId, input.slug);
}

export async function updateView(
  actor: ConfigActor,
  slug: string,
  input: Omit<SaveViewInput, 'slug'>,
  baseVersion?: number,
): Promise<ViewDefinition> {
  await updateConfigObject(actor, 'view', slug, {
    name: input.name,
    description: input.description ?? null,
    body: toViewBody({ ...input, slug }),
    baseVersion,
  });
  if (input.publish !== false) await publishConfigObject(actor, 'view', slug, 'View updated.');
  invalidateViewCounts(actor.tenantId, slug);
  return requireView(actor.tenantId, slug);
}

/** Archive a view. The badge cache for it goes with it. */
export async function archiveView(actor: ConfigActor, slug: string): Promise<void> {
  await archiveConfigObject(actor, 'view', slug);
  invalidateViewCounts(actor.tenantId, slug);
  await db('saved_view_counts')
    .where('tenant_id', actor.tenantId)
    .where('view_slug', slug)
    .delete();
}
