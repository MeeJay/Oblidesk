/**
 * metric.service.ts — THE METRIC REGISTRY.
 *
 * ── The boundary this file exists to hold ────────────────────────────────────
 * A reporting API that accepts a query fragment from the client is a reporting
 * API that accepts SQL from the client. It starts as "just a filter object",
 * grows a `having`, grows a raw column name for a group-by nobody anticipated,
 * and ends as a place where an authenticated user can ask the database
 * questions the product never intended to answer — across tenants, if the
 * fragment reaches a join.
 *
 * So the contract here is the opposite. The client picks:
 *
 *   • a registered metric KEY, from a closed catalogue;
 *   • a group-by DIMENSION, from the list that metric declares;
 *   • a date RANGE, from the list that metric declares;
 *   • optionally a saved VIEW slug — which is configuration, already linted,
 *     already versioned, and already compiled by view.service.
 *
 * That is the whole vocabulary. An invalid combination is not rejected — it is
 * unpickable, because the UI is built from this registry and the server
 * validates against the same declarations. Adding a metric is a change to
 * {@link METRIC_REGISTRY}; it is not a change to any route, any validator or
 * any client query builder.
 *
 * ── Every value drills through ───────────────────────────────────────────────
 * A KPI that cannot be clicked is a number an operator has to take on faith,
 * and a number taken on faith is a number nobody fixes. Each definition
 * therefore ships TWO queries: the aggregate, and the matching record query
 * that returns the exact tickets behind it. They are built from the same
 * predicates in the same function, so they cannot drift.
 *
 * ── Snapshot metrics vs event metrics ────────────────────────────────────────
 * "How many are open right now" and "how many were created last Tuesday" are
 * different shapes. Event metrics (created, resolved, breaches, csat) have a
 * timestamp to bucket on and are computed live. Snapshot metrics (open_tickets,
 * backlog_age) have no such column — yesterday's open count is not recoverable
 * from today's rows once a ticket has been resolved and re-opened — so their
 * history comes from `metric_daily_rollup`, which rollup.service materialises
 * nightly. That is the honest split, and it is declared per metric in
 * `seriesSource` rather than hidden in a branch.
 */

import type { Knex } from 'knex';

import {
  OPEN_STATUS_CATEGORIES,
  PAGINATION,
  type StatusCategory,
} from '@oblidesk/shared';

import { db, scoped, type Executor } from '../db';
import { ConfigServiceError, type ConfigActor } from './configObject.service';
import { loadFieldCatalog } from './customField.service';
import { compileCondition, getView, type CompileContext } from './view.service';

// ═════════════════════════════════════════════════════════════════════════════
// Vocabulary
// ═════════════════════════════════════════════════════════════════════════════

export const METRIC_KEYS = [
  'open_tickets',
  'created',
  'resolved',
  'first_response_time',
  'resolution_time',
  'sla_attainment',
  'breaches',
  'backlog_age',
  'reopen_rate',
  'csat',
  'tickets_by_queue',
  'tickets_by_priority',
  'tickets_by_assignee',
  'tickets_by_category',
  'tickets_by_organization',
  'tickets_by_source',
  'alert_to_ticket_ratio',
  'deflection_rate',
  'billable_minutes',
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export const METRIC_DIMENSIONS = [
  'queue_slug',
  'priority_slug',
  'assignee_id',
  'assignment_group_id',
  'organization_id',
  'record_type',
  'source',
  'status_slug',
  'status_category',
  'resolution_code',
  'impact',
  'urgency',
  'sla_target_slug',
  'source_app',
  'severity',
  'user_id',
  'rate_card_slug',
] as const;

export type MetricDimension = (typeof METRIC_DIMENSIONS)[number];

export const METRIC_RANGES = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_week',
  'this_month',
  'qtd',
  'ytd',
  'last_12_months',
  'all_time',
  'custom',
] as const;

export type MetricRangeKey = (typeof METRIC_RANGES)[number];

export type MetricUnit = 'count' | 'percent' | 'minutes' | 'days' | 'score' | 'ratio';
export type MetricAggregation = 'count' | 'sum' | 'avg' | 'median' | 'ratio';
export type MetricGranularity = 'day' | 'week' | 'month';

/**
 * Legacy metric keys used by the shipped baseline dashboard
 * (`db/seeds/02_baseline_config.ts`). They are aliases, not a second registry:
 * an old widget keeps working and resolves to exactly the same definition.
 */
export const METRIC_ALIASES: Readonly<Record<string, MetricKey>> = {
  ticket_count: 'open_tickets',
  backlog_size: 'open_tickets',
  resolved_count: 'resolved',
  sla_attainment_pct: 'sla_attainment',
  first_response_minutes_p50: 'first_response_time',
  csat_avg: 'csat',
  reopen_rate_pct: 'reopen_rate',
  breach_count: 'breaches',
};

export function isMetricKey(value: unknown): value is MetricKey {
  return typeof value === 'string' && (METRIC_KEYS as readonly string[]).includes(value);
}

export function resolveMetricKey(value: unknown): MetricKey | null {
  if (isMetricKey(value)) return value;
  if (typeof value === 'string' && METRIC_ALIASES[value]) return METRIC_ALIASES[value];
  return null;
}

export function isMetricDimension(value: unknown): value is MetricDimension {
  return typeof value === 'string' && (METRIC_DIMENSIONS as readonly string[]).includes(value);
}

export function isMetricRange(value: unknown): value is MetricRangeKey {
  return typeof value === 'string' && (METRIC_RANGES as readonly string[]).includes(value);
}

// ═════════════════════════════════════════════════════════════════════════════
// Ranges
// ═════════════════════════════════════════════════════════════════════════════

export interface ResolvedRange {
  key: MetricRangeKey;
  /** SQL expression for the inclusive lower bound. */
  fromSql: string;
  fromBindings: Knex.RawBinding[];
  /** SQL expression for the EXCLUSIVE upper bound. */
  toSql: string;
  toBindings: Knex.RawBinding[];
  timezone: string;
}

const TENANT_TZ_CACHE = new Map<number, { tz: string; at: number }>();
const TZ_CACHE_TTL_MS = 300_000;

/**
 * The tenant's timezone. Every boundary in this file is computed IN it, in
 * Postgres, because "today" is a local-calendar question and computing it in
 * UTC gives a shift lead in Paris the wrong day's numbers for an hour after
 * midnight and again for an hour before.
 */
export async function tenantTimezone(tenantId: number): Promise<string> {
  const cached = TENANT_TZ_CACHE.get(tenantId);
  if (cached && Date.now() - cached.at < TZ_CACHE_TTL_MS) return cached.tz;

  const row = await db('tenants').select('settings').where('id', tenantId).first();
  let tz = 'Europe/Paris';
  const settings = (row as { settings?: unknown } | undefined)?.settings;
  const parsed = typeof settings === 'string' ? safeParse(settings) : settings;
  if (parsed && typeof parsed === 'object') {
    const candidate = (parsed as Record<string, unknown>).timezone;
    if (typeof candidate === 'string' && candidate.trim() !== '') tz = candidate.trim();
  }

  TENANT_TZ_CACHE.set(tenantId, { tz, at: Date.now() });
  return tz;
}

function safeParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

/** `date_trunc(unit, now() in tz)` back as a timestamptz. */
function localTrunc(unit: string, tz: string): { sql: string; bindings: Knex.RawBinding[] } {
  return {
    sql: `((date_trunc(?, (now() AT TIME ZONE ?))) AT TIME ZONE ?)`,
    bindings: [unit, tz, tz],
  };
}

function shifted(base: { sql: string; bindings: Knex.RawBinding[] }, interval: string): { sql: string; bindings: Knex.RawBinding[] } {
  return { sql: `(${base.sql} + ?::interval)`, bindings: [...base.bindings, interval] };
}

export function resolveRange(
  key: MetricRangeKey,
  timezone: string,
  custom?: { from?: string; to?: string },
): ResolvedRange {
  const day = localTrunc('day', timezone);

  const make = (
    from: { sql: string; bindings: Knex.RawBinding[] },
    to: { sql: string; bindings: Knex.RawBinding[] },
  ): ResolvedRange => ({
    key,
    fromSql: from.sql,
    fromBindings: from.bindings,
    toSql: to.sql,
    toBindings: to.bindings,
    timezone,
  });

  switch (key) {
    case 'today':
      return make(day, shifted(day, '1 day'));
    case 'yesterday':
      return make(shifted(day, '-1 day'), day);
    case 'last_7_days':
      return make(shifted(day, '-6 days'), shifted(day, '1 day'));
    case 'last_30_days':
      return make(shifted(day, '-29 days'), shifted(day, '1 day'));
    case 'last_90_days':
      return make(shifted(day, '-89 days'), shifted(day, '1 day'));
    case 'this_week':
      return make(localTrunc('week', timezone), shifted(localTrunc('week', timezone), '1 week'));
    case 'this_month':
      return make(localTrunc('month', timezone), shifted(localTrunc('month', timezone), '1 month'));
    case 'qtd':
      return make(localTrunc('quarter', timezone), shifted(day, '1 day'));
    case 'ytd':
      return make(localTrunc('year', timezone), shifted(day, '1 day'));
    case 'last_12_months':
      return make(shifted(localTrunc('month', timezone), '-11 months'), shifted(localTrunc('month', timezone), '1 month'));
    case 'all_time':
      return make({ sql: `'-infinity'::timestamptz`, bindings: [] }, { sql: `'infinity'::timestamptz`, bindings: [] });
    case 'custom': {
      const from = parseIso(custom?.from);
      const to = parseIso(custom?.to);
      if (!from || !to) {
        throw new ConfigServiceError(400, 'A custom range needs a valid `from` and `to` (ISO-8601).');
      }
      if (from >= to) throw new ConfigServiceError(400, 'A custom range needs `from` before `to`.');
      return make(
        { sql: '?::timestamptz', bindings: [from.toISOString()] },
        { sql: '?::timestamptz', bindings: [to.toISOString()] },
      );
    }
    default:
      throw new ConfigServiceError(400, `"${String(key)}" is not a supported date range.`);
  }
}

function parseIso(value: string | undefined): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

// ═════════════════════════════════════════════════════════════════════════════
// Scope — the closed set of equality filters a client may express
// ═════════════════════════════════════════════════════════════════════════════

/**
 * NOT a filter object: every key here maps to one declared dimension of one
 * ticket column, and each is only accepted when the chosen metric declares
 * that dimension. There is no path from a request body to a column name, an
 * operator or a join.
 */
export interface MetricScope {
  queueSlug?: string;
  prioritySlug?: string;
  assigneeId?: number;
  assignmentGroupId?: number;
  organizationId?: number;
  recordType?: string;
  source?: string;
  statusCategory?: StatusCategory;
}

const SCOPE_TO_DIMENSION: Readonly<Record<keyof MetricScope, MetricDimension>> = {
  queueSlug: 'queue_slug',
  prioritySlug: 'priority_slug',
  assigneeId: 'assignee_id',
  assignmentGroupId: 'assignment_group_id',
  organizationId: 'organization_id',
  recordType: 'record_type',
  source: 'source',
  statusCategory: 'status_category',
};

const SCOPE_TO_COLUMN: Readonly<Record<keyof MetricScope, string>> = {
  queueSlug: 'tickets.queue_slug',
  prioritySlug: 'tickets.priority_slug',
  assigneeId: 'tickets.assignee_id',
  assignmentGroupId: 'tickets.assignment_group_id',
  organizationId: 'tickets.organization_id',
  recordType: 'tickets.record_type',
  source: 'tickets.source',
  statusCategory: 'tickets.status_category',
};

// ═════════════════════════════════════════════════════════════════════════════
// Dimension → column
// ═════════════════════════════════════════════════════════════════════════════

const DIMENSION_COLUMNS: Readonly<Record<MetricDimension, string>> = {
  queue_slug: 'tickets.queue_slug::text',
  priority_slug: 'tickets.priority_slug::text',
  assignee_id: 'tickets.assignee_id::text',
  assignment_group_id: 'tickets.assignment_group_id::text',
  organization_id: 'tickets.organization_id::text',
  record_type: 'tickets.record_type::text',
  source: 'tickets.source::text',
  status_slug: 'tickets.status_slug::text',
  status_category: 'tickets.status_category::text',
  resolution_code: 'tickets.resolution_code::text',
  impact: 'tickets.impact::text',
  urgency: 'tickets.urgency::text',
  sla_target_slug: 'sla_instances.target_slug::text',
  source_app: 'suite_alerts.source_app::text',
  severity: 'suite_alerts.severity::text',
  user_id: 'time_entries.user_id::text',
  rate_card_slug: 'time_entries.rate_card_slug::text',
};

// ═════════════════════════════════════════════════════════════════════════════
// Definitions
// ═════════════════════════════════════════════════════════════════════════════

export interface MetricBuildContext {
  tenantId: number;
  actor: ConfigActor;
  definition: MetricDefinition;
  range: ResolvedRange;
  groupBy: MetricDimension | null;
  granularity: MetricGranularity | null;
  scope: MetricScope;
  /** Compiled saved-view filter, applied to `tickets`. */
  applyViewFilter: ((query: Knex.QueryBuilder) => void) | null;
  limit: number;
  executor: Executor;
  warnings: string[];
}

export interface MetricDefinition {
  key: MetricKey;
  /** Inline English fallback; `labelKey` is what `t()` receives (HARD RULE 10). */
  label: string;
  labelKey: string;
  description: string;
  unit: MetricUnit;
  aggregation: MetricAggregation;
  /** null when neither direction is "good" (a raw volume). */
  higherIsBetter: boolean | null;
  dimensions: readonly MetricDimension[];
  ranges: readonly MetricRangeKey[];
  /** Forced grouping — the `tickets_by_*` family. */
  forcedGroupBy?: MetricDimension;
  /**
   * 'live'   — the metric has a timestamp to bucket on
   * 'rollup' — a point-in-time number whose history only exists because
   *            rollup.service wrote it down each night
   */
  seriesSource: 'live' | 'rollup';
  /** The aggregate. Returns rows of { bucket, group_value, value }. */
  build(ctx: MetricBuildContext): Knex.QueryBuilder;
  /** The SAME predicates, returning tickets — the drill-through. */
  records(ctx: MetricBuildContext, groupValue?: string | null): Knex.QueryBuilder;
}

// ── shared query fragments ──────────────────────────────────────────────────

const OPEN_CATEGORY_LIST = [...OPEN_STATUS_CATEGORIES];

function baseTickets(ctx: MetricBuildContext): Knex.QueryBuilder {
  const query = scoped('tickets', ctx.tenantId, ctx.executor).whereNull('tickets.deleted_at');
  applyScope(query, ctx);
  if (ctx.applyViewFilter) ctx.applyViewFilter(query);
  return query;
}

function applyScope(query: Knex.QueryBuilder, ctx: MetricBuildContext): void {
  for (const [name, value] of Object.entries(ctx.scope)) {
    if (value === undefined || value === null || value === '') continue;
    const scopeKey = name as keyof MetricScope;
    const dimension = SCOPE_TO_DIMENSION[scopeKey];
    if (!ctx.definition.dimensions.includes(dimension)) {
      // Unpickable rather than merely rejected: the registry says this metric
      // has no such axis, so the filter is not a thing that can be asked for.
      throw new ConfigServiceError(
        400,
        `Metric "${ctx.definition.key}" does not declare the dimension "${dimension}", so it cannot be filtered by it. Declared: ${ctx.definition.dimensions.join(', ') || 'none'}.`,
      );
    }
    query.where(SCOPE_TO_COLUMN[scopeKey], value as never);
  }
}

function withinRange(query: Knex.QueryBuilder, column: string, ctx: MetricBuildContext): void {
  const { range } = ctx;
  query.whereRaw(
    `${column} >= ${range.fromSql} AND ${column} < ${range.toSql}`,
    [...range.fromBindings, ...range.toBindings],
  );
}

function bucketExpression(column: string, ctx: MetricBuildContext): { sql: string; bindings: Knex.RawBinding[] } | null {
  if (!ctx.granularity) return null;
  return {
    sql: `to_char(date_trunc(?, (${column} AT TIME ZONE ?)), 'YYYY-MM-DD')`,
    bindings: [ctx.granularity, ctx.range.timezone],
  };
}

/**
 * Finish an aggregate: add the bucket and group columns the caller asked for
 * and the matching GROUP BY. Every metric funnels through this so the output
 * shape is identical no matter which table underneath produced it.
 */
function finishAggregate(
  query: Knex.QueryBuilder,
  valueSql: string,
  valueBindings: Knex.RawBinding[],
  timeColumn: string | null,
  ctx: MetricBuildContext,
): Knex.QueryBuilder {
  const selects: Knex.Raw[] = [];
  const groups: Knex.Raw[] = [];

  const bucket = timeColumn ? bucketExpression(timeColumn, ctx) : null;
  if (bucket) {
    selects.push(db.raw(`${bucket.sql} as bucket`, bucket.bindings as never));
    groups.push(db.raw(bucket.sql, bucket.bindings as never));
  } else {
    selects.push(db.raw(`NULL::text as bucket`));
  }

  const dimension = ctx.definition.forcedGroupBy ?? ctx.groupBy;
  if (dimension) {
    const column = DIMENSION_COLUMNS[dimension];
    selects.push(db.raw(`${column} as group_value`));
    groups.push(db.raw(column));
  } else {
    selects.push(db.raw(`NULL::text as group_value`));
  }

  selects.push(db.raw(`${valueSql} as value`, valueBindings as never));

  query.clearSelect().select(selects);
  if (groups.length > 0) query.groupBy(groups);

  // Ordering matters for a chart: buckets ascending so a line reads left to
  // right, groups by size descending so the legend is useful.
  if (bucket) query.orderByRaw(`${bucket.sql} ASC`, bucket.bindings as never);
  else if (dimension) query.orderByRaw('value DESC NULLS LAST');

  if (dimension) query.limit(Math.min(Math.max(ctx.limit, 1), 200));
  return query;
}

/** Join `tickets` onto a child table, scoping BOTH sides (HARD RULE 1). */
function joinTickets(query: Knex.QueryBuilder, childTable: string, tenantId: number, left = false): void {
  const on = `${childTable}.ticket_id`;
  if (left) query.leftJoin('tickets', 'tickets.id', on);
  else query.join('tickets', 'tickets.id', on);
  query.where((group) => {
    // A LEFT JOIN must not lose its unmatched rows to the tenant predicate.
    if (left) group.whereNull('tickets.id').orWhere('tickets.tenant_id', tenantId);
    else group.where('tickets.tenant_id', tenantId);
  });
}

// ── the count-of-tickets family ─────────────────────────────────────────────

function ticketCountDefinition(config: {
  key: MetricKey;
  label: string;
  labelKey: string;
  description: string;
  higherIsBetter: boolean | null;
  /** null ⇒ snapshot metric (no timestamp to bucket on). */
  timeColumn: string | null;
  predicate?: (query: Knex.QueryBuilder) => void;
  dimensions?: readonly MetricDimension[];
  forcedGroupBy?: MetricDimension;
  ranges?: readonly MetricRangeKey[];
}): MetricDefinition {
  const dimensions = config.dimensions ?? [
    'queue_slug', 'priority_slug', 'assignee_id', 'assignment_group_id',
    'organization_id', 'record_type', 'source', 'status_slug', 'status_category',
    'resolution_code', 'impact', 'urgency',
  ];

  const shape = (ctx: MetricBuildContext): Knex.QueryBuilder => {
    const query = baseTickets(ctx);
    if (config.predicate) config.predicate(query);
    if (config.timeColumn) withinRange(query, config.timeColumn, ctx);
    return query;
  };

  return {
    key: config.key,
    label: config.label,
    labelKey: config.labelKey,
    description: config.description,
    unit: 'count',
    aggregation: 'count',
    higherIsBetter: config.higherIsBetter,
    dimensions,
    // A snapshot metric offers every range too — not because it can filter on
    // one, but because its HISTORY over that range exists in
    // `metric_daily_rollup`. `resolveMetric` routes a bounded range on a
    // snapshot metric there; `all_time` is the live "right now" number.
    ranges: config.ranges ?? [...METRIC_RANGES],
    forcedGroupBy: config.forcedGroupBy,
    seriesSource: config.timeColumn ? 'live' : 'rollup',
    build: (ctx) => finishAggregate(shape(ctx), 'count(*)::numeric', [], config.timeColumn, ctx),
    records: (ctx, groupValue) => withGroupValue(shape(ctx), ctx, groupValue),
  };
}

/** Narrow a drill-through to one bar of the chart the user actually clicked. */
function withGroupValue(
  query: Knex.QueryBuilder,
  ctx: MetricBuildContext,
  groupValue: string | null | undefined,
): Knex.QueryBuilder {
  if (groupValue === undefined) return query;
  const dimension = ctx.definition.forcedGroupBy ?? ctx.groupBy;
  if (!dimension) return query;
  const column = DIMENSION_COLUMNS[dimension];
  if (groupValue === null) query.whereRaw(`${column} IS NULL`);
  else query.whereRaw(`${column} = ?`, [groupValue]);
  return query;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE REGISTRY
// ═════════════════════════════════════════════════════════════════════════════

const OPEN_TICKETS: MetricDefinition = ticketCountDefinition({
  key: 'open_tickets',
  label: 'Open tickets',
  labelKey: 'metric.openTickets',
  description: 'Tickets currently in a live status category. A point-in-time number: its history comes from the nightly rollup, because once a ticket closes there is no column that remembers it was open last Tuesday.',
  higherIsBetter: false,
  timeColumn: null,
  predicate: (query) => query.whereIn('tickets.status_category', OPEN_CATEGORY_LIST),
});

const REGISTRY_LIST: MetricDefinition[] = [
  OPEN_TICKETS,

  ticketCountDefinition({
    key: 'created',
    label: 'Created',
    labelKey: 'metric.created',
    description: 'Tickets filed in the window, by created_at. Note this is when the desk HEARD about it; occurred_at is when it happened (HARD RULE 6) and the two are deliberately different numbers.',
    higherIsBetter: null,
    timeColumn: 'tickets.created_at',
  }),

  ticketCountDefinition({
    key: 'resolved',
    label: 'Resolved',
    labelKey: 'metric.resolved',
    description: 'Tickets that reached a resolved status in the window.',
    higherIsBetter: true,
    timeColumn: 'tickets.resolved_at',
    predicate: (query) => query.whereNotNull('tickets.resolved_at'),
  }),

  // ── the tickets_by_* family: open_tickets with the axis pinned ───────────
  ticketCountDefinition({
    key: 'tickets_by_queue',
    label: 'Open by queue',
    labelKey: 'metric.ticketsByQueue',
    description: 'Live tickets broken down by queue.',
    higherIsBetter: null,
    timeColumn: null,
    predicate: (query) => query.whereIn('tickets.status_category', OPEN_CATEGORY_LIST),
    dimensions: ['queue_slug'],
    forcedGroupBy: 'queue_slug',
  }),
  ticketCountDefinition({
    key: 'tickets_by_priority',
    label: 'Open by priority',
    labelKey: 'metric.ticketsByPriority',
    description: 'Live tickets broken down by priority.',
    higherIsBetter: null,
    timeColumn: null,
    predicate: (query) => query.whereIn('tickets.status_category', OPEN_CATEGORY_LIST),
    dimensions: ['priority_slug'],
    forcedGroupBy: 'priority_slug',
  }),
  ticketCountDefinition({
    key: 'tickets_by_assignee',
    label: 'Open by assignee',
    labelKey: 'metric.ticketsByAssignee',
    description: 'Live tickets broken down by the agent who owns them. Unassigned tickets group under NULL — which is the bar that matters.',
    higherIsBetter: null,
    timeColumn: null,
    predicate: (query) => query.whereIn('tickets.status_category', OPEN_CATEGORY_LIST),
    dimensions: ['assignee_id'],
    forcedGroupBy: 'assignee_id',
  }),
  ticketCountDefinition({
    key: 'tickets_by_category',
    label: 'Open by status category',
    labelKey: 'metric.ticketsByCategory',
    description: 'Live tickets by hard-coded status CATEGORY, never by status slug (HARD RULE 5) — so renaming a status cannot move the chart.',
    higherIsBetter: null,
    timeColumn: null,
    predicate: (query) => query.whereIn('tickets.status_category', OPEN_CATEGORY_LIST),
    dimensions: ['status_category'],
    forcedGroupBy: 'status_category',
  }),
  ticketCountDefinition({
    key: 'tickets_by_organization',
    label: 'Open by organization',
    labelKey: 'metric.ticketsByOrganization',
    description: 'Live tickets broken down by customer organization.',
    higherIsBetter: null,
    timeColumn: null,
    predicate: (query) => query.whereIn('tickets.status_category', OPEN_CATEGORY_LIST),
    dimensions: ['organization_id'],
    forcedGroupBy: 'organization_id',
  }),
  ticketCountDefinition({
    key: 'tickets_by_source',
    label: 'Open by source',
    labelKey: 'metric.ticketsBySource',
    description: 'Live tickets broken down by how they arrived — web, email, portal, api, alert, phone, chat.',
    higherIsBetter: null,
    timeColumn: null,
    predicate: (query) => query.whereIn('tickets.status_category', OPEN_CATEGORY_LIST),
    dimensions: ['source'],
    forcedGroupBy: 'source',
  }),

  // ── durations ───────────────────────────────────────────────────────────
  {
    key: 'first_response_time',
    label: 'First response time',
    labelKey: 'metric.firstResponseTime',
    description: 'Median wall-clock minutes from created_at to the first public reply, over tickets that got one in the window. Median, not mean: one ticket that sat over a bank holiday should not move the number a whole team is judged by.',
    unit: 'minutes',
    aggregation: 'median',
    higherIsBetter: false,
    dimensions: ['queue_slug', 'priority_slug', 'assignee_id', 'assignment_group_id', 'organization_id', 'record_type', 'source'],
    ranges: [...METRIC_RANGES],
    seriesSource: 'live',
    build: (ctx) => finishAggregate(
      firstResponseShape(ctx),
      `percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (tickets.first_response_at - tickets.created_at)) / 60.0)`,
      [],
      'tickets.first_response_at',
      ctx,
    ),
    records: (ctx, groupValue) => withGroupValue(firstResponseShape(ctx), ctx, groupValue),
  },
  {
    key: 'resolution_time',
    label: 'Resolution time',
    labelKey: 'metric.resolutionTime',
    description: 'Median wall-clock minutes from created_at to resolved_at, over tickets resolved in the window. Wall-clock, not business time — the SLA metrics are the business-time ones.',
    unit: 'minutes',
    aggregation: 'median',
    higherIsBetter: false,
    dimensions: ['queue_slug', 'priority_slug', 'assignee_id', 'assignment_group_id', 'organization_id', 'record_type', 'resolution_code'],
    ranges: [...METRIC_RANGES],
    seriesSource: 'live',
    build: (ctx) => finishAggregate(
      resolutionShape(ctx),
      `percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (tickets.resolved_at - tickets.created_at)) / 60.0)`,
      [],
      'tickets.resolved_at',
      ctx,
    ),
    records: (ctx, groupValue) => withGroupValue(resolutionShape(ctx), ctx, groupValue),
  },

  // ── SLA ─────────────────────────────────────────────────────────────────
  {
    key: 'sla_attainment',
    label: 'SLA attainment',
    labelKey: 'metric.slaAttainment',
    description: 'Percentage of SLA clocks that finished MET, out of the clocks that finished at all in the window. Cancelled clocks are excluded: a cancelled ticket is not a met SLA, and counting it as one is how attainment quietly reaches 100%.',
    unit: 'percent',
    aggregation: 'ratio',
    higherIsBetter: true,
    dimensions: ['queue_slug', 'priority_slug', 'assignment_group_id', 'organization_id', 'sla_target_slug'],
    ranges: [...METRIC_RANGES],
    seriesSource: 'live',
    build: (ctx) => finishAggregate(
      slaFinishedShape(ctx),
      `(100.0 * count(*) FILTER (WHERE sla_instances.status = 'met')) / NULLIF(count(*), 0)`,
      [],
      'COALESCE(sla_instances.met_at, sla_instances.breached_at)',
      ctx,
    ),
    records: (ctx, groupValue) => withGroupValue(
      slaTicketsShape(ctx)
        .whereIn('sla_instances.status', ['met', 'breached'])
        // The SAME window as the aggregate. A drill-through that quietly drops
        // the window returns every clock that ever finished, and the list under
        // "94% this month" comes back with four thousand rows from last year.
        .modify((query) => withinRange(query, 'COALESCE(sla_instances.met_at, sla_instances.breached_at)', ctx)),
      ctx,
      groupValue,
    ),
  },
  {
    key: 'breaches',
    label: 'SLA breaches',
    labelKey: 'metric.breaches',
    description: 'SLA clocks that breached in the window. One ticket can contribute more than one breach — a missed response AND a missed resolution are two separate promises.',
    unit: 'count',
    aggregation: 'count',
    higherIsBetter: false,
    dimensions: ['queue_slug', 'priority_slug', 'assignment_group_id', 'organization_id', 'sla_target_slug'],
    ranges: [...METRIC_RANGES],
    seriesSource: 'live',
    build: (ctx) => finishAggregate(
      breachShape(ctx),
      'count(*)::numeric',
      [],
      'sla_instances.breached_at',
      ctx,
    ),
    records: (ctx, groupValue) => withGroupValue(
      slaTicketsShape(ctx).where('sla_instances.status', 'breached')
        .modify((query) => withinRange(query, 'sla_instances.breached_at', ctx)),
      ctx,
      groupValue,
    ),
  },

  // ── backlog ─────────────────────────────────────────────────────────────
  {
    key: 'backlog_age',
    label: 'Backlog age',
    labelKey: 'metric.backlogAge',
    description: 'Average age in days of the tickets that are open RIGHT NOW. A point-in-time number: rising while open_tickets holds steady is the shape that says the team is working the new arrivals and not the pile.',
    unit: 'days',
    aggregation: 'avg',
    higherIsBetter: false,
    dimensions: ['queue_slug', 'priority_slug', 'assignee_id', 'assignment_group_id', 'organization_id', 'status_category'],
    ranges: [...METRIC_RANGES],
    seriesSource: 'rollup',
    build: (ctx) => finishAggregate(
      backlogShape(ctx),
      `avg(EXTRACT(EPOCH FROM (now() - tickets.created_at)) / 86400.0)`,
      [],
      null,
      ctx,
    ),
    records: (ctx, groupValue) => withGroupValue(
      backlogShape(ctx).orderBy('tickets.created_at', 'asc'),
      ctx,
      groupValue,
    ),
  },

  // ── quality ─────────────────────────────────────────────────────────────
  {
    key: 'reopen_rate',
    label: 'Reopen rate',
    labelKey: 'metric.reopenRate',
    description: 'Of the tickets resolved in the window, the percentage that had been reopened at least once. The honest counterweight to "resolved" — a desk can always resolve more by resolving worse.',
    unit: 'percent',
    aggregation: 'ratio',
    higherIsBetter: false,
    dimensions: ['queue_slug', 'priority_slug', 'assignee_id', 'assignment_group_id', 'organization_id', 'record_type', 'resolution_code'],
    ranges: [...METRIC_RANGES],
    seriesSource: 'live',
    build: (ctx) => finishAggregate(
      resolutionShape(ctx),
      `(100.0 * count(*) FILTER (WHERE tickets.reopen_count > 0)) / NULLIF(count(*), 0)`,
      [],
      'tickets.resolved_at',
      ctx,
    ),
    records: (ctx, groupValue) => withGroupValue(
      resolutionShape(ctx).where('tickets.reopen_count', '>', 0),
      ctx,
      groupValue,
    ),
  },
  {
    key: 'csat',
    label: 'Satisfaction',
    labelKey: 'metric.csat',
    description: 'Mean satisfaction score (1-5) over surveys ANSWERED in the window. Unanswered surveys are excluded rather than counted as neutral: silence is not a rating.',
    unit: 'score',
    aggregation: 'avg',
    higherIsBetter: true,
    dimensions: ['queue_slug', 'priority_slug', 'assignee_id', 'assignment_group_id', 'organization_id'],
    ranges: [...METRIC_RANGES],
    seriesSource: 'live',
    build: (ctx) => finishAggregate(
      csatShape(ctx),
      'avg(satisfaction_responses.score)::numeric',
      [],
      'satisfaction_responses.responded_at',
      ctx,
    ),
    records: (ctx, groupValue) => withGroupValue(csatTicketsShape(ctx), ctx, groupValue),
  },

  // ── suite integration ───────────────────────────────────────────────────
  {
    key: 'alert_to_ticket_ratio',
    label: 'Alerts per ticket',
    labelKey: 'metric.alertToTicketRatio',
    description: 'Alert occurrences received in the window divided by the number of distinct tickets they opened. This is the de-duplication number: 1.0 means every alert became its own ticket, and a healthy desk is well above that.',
    unit: 'ratio',
    aggregation: 'ratio',
    higherIsBetter: true,
    dimensions: ['source_app', 'severity'],
    ranges: [...METRIC_RANGES],
    seriesSource: 'live',
    build: (ctx) => finishAggregate(
      alertShape(ctx),
      `sum(suite_alerts.occurrence_count)::numeric / NULLIF(count(DISTINCT suite_alerts.ticket_id), 0)`,
      [],
      'suite_alerts.first_seen_at',
      ctx,
    ),
    records: (ctx, groupValue) => {
      const query = scoped('tickets', ctx.tenantId, ctx.executor)
        .whereNull('tickets.deleted_at')
        .whereExists((sub) => {
          void sub.select(db.raw('1')).from('suite_alerts')
            .whereRaw('suite_alerts.ticket_id = tickets.id')
            .where('suite_alerts.tenant_id', ctx.tenantId)
            // Same window as the aggregate.
            .modify((builder) => withinRange(builder, 'suite_alerts.first_seen_at', ctx));
        });
      applyScope(query, ctx);
      if (ctx.applyViewFilter) ctx.applyViewFilter(query);
      return withGroupValue(query, ctx, groupValue);
    },
  },
  {
    key: 'deflection_rate',
    label: 'Deflection rate',
    labelKey: 'metric.deflectionRate',
    description: 'Of everyone the self-service path touched in the window — people who marked a knowledge-base article helpful, plus people who filed a portal or web ticket anyway — the percentage the knowledge base absorbed. Deliberately a conservative definition: it counts only explicit "this helped" feedback, never a page view, because a page view is not evidence that anybody was helped.',
    unit: 'percent',
    aggregation: 'ratio',
    higherIsBetter: true,
    dimensions: [],
    ranges: [...METRIC_RANGES],
    seriesSource: 'live',
    build: (ctx) => deflectionQuery(ctx),
    records: (ctx) => {
      // The drill-through of a deflection rate is the tickets that were NOT
      // deflected — the ones the knowledge base failed to answer.
      const query = baseTickets(ctx).whereIn('tickets.source', ['portal', 'web']);
      withinRange(query, 'tickets.created_at', ctx);
      return query;
    },
  },

  // ── commercial ──────────────────────────────────────────────────────────
  {
    key: 'billable_minutes',
    label: 'Billable minutes',
    labelKey: 'metric.billableMinutes',
    description: 'Minutes logged as billable in the window, by the entry\'s start time. Unapproved entries are included — excluding them would make the number lag approval and understate the current month every month.',
    unit: 'minutes',
    aggregation: 'sum',
    higherIsBetter: null,
    dimensions: ['user_id', 'rate_card_slug', 'organization_id', 'queue_slug', 'record_type'],
    ranges: [...METRIC_RANGES],
    seriesSource: 'live',
    build: (ctx) => finishAggregate(
      timeEntryShape(ctx),
      'sum(time_entries.minutes)::numeric',
      [],
      'time_entries.started_at',
      ctx,
    ),
    records: (ctx, groupValue) => {
      const query = baseTickets(ctx).whereExists((sub) => {
        void sub.select(db.raw('1')).from('time_entries')
          .whereRaw('time_entries.ticket_id = tickets.id')
          .where('time_entries.tenant_id', ctx.tenantId)
          .where('time_entries.billable', true)
          .whereNotNull('time_entries.started_at')
          // Same window as the aggregate.
          .modify((builder) => withinRange(builder, 'time_entries.started_at', ctx));
      });
      return withGroupValue(query, ctx, groupValue);
    },
  },
];

export const METRIC_REGISTRY: ReadonlyMap<MetricKey, MetricDefinition> = new Map(
  REGISTRY_LIST.map((definition) => [definition.key, definition]),
);

// ── shapes shared between an aggregate and its drill-through ────────────────

function firstResponseShape(ctx: MetricBuildContext): Knex.QueryBuilder {
  const query = baseTickets(ctx).whereNotNull('tickets.first_response_at');
  withinRange(query, 'tickets.first_response_at', ctx);
  return query;
}

function resolutionShape(ctx: MetricBuildContext): Knex.QueryBuilder {
  const query = baseTickets(ctx).whereNotNull('tickets.resolved_at');
  withinRange(query, 'tickets.resolved_at', ctx);
  return query;
}

function backlogShape(ctx: MetricBuildContext): Knex.QueryBuilder {
  return baseTickets(ctx).whereIn('tickets.status_category', OPEN_CATEGORY_LIST);
}

function slaFinishedShape(ctx: MetricBuildContext): Knex.QueryBuilder {
  const query = scoped('sla_instances', ctx.tenantId, ctx.executor)
    .whereIn('sla_instances.status', ['met', 'breached']);
  joinTickets(query, 'sla_instances', ctx.tenantId);
  query.whereNull('tickets.deleted_at');
  applyScope(query, ctx);
  if (ctx.applyViewFilter) ctx.applyViewFilter(query);
  withinRange(query, 'COALESCE(sla_instances.met_at, sla_instances.breached_at)', ctx);
  return query;
}

function breachShape(ctx: MetricBuildContext): Knex.QueryBuilder {
  const query = scoped('sla_instances', ctx.tenantId, ctx.executor)
    .where('sla_instances.status', 'breached')
    .whereNotNull('sla_instances.breached_at');
  joinTickets(query, 'sla_instances', ctx.tenantId);
  query.whereNull('tickets.deleted_at');
  applyScope(query, ctx);
  if (ctx.applyViewFilter) ctx.applyViewFilter(query);
  withinRange(query, 'sla_instances.breached_at', ctx);
  return query;
}

/** Tickets behind an SLA metric — the drill-through side. */
function slaTicketsShape(ctx: MetricBuildContext): Knex.QueryBuilder {
  const query = scoped('sla_instances', ctx.tenantId, ctx.executor);
  joinTickets(query, 'sla_instances', ctx.tenantId);
  query.whereNull('tickets.deleted_at');
  applyScope(query, ctx);
  if (ctx.applyViewFilter) ctx.applyViewFilter(query);
  return query;
}

function csatShape(ctx: MetricBuildContext): Knex.QueryBuilder {
  const query = scoped('satisfaction_responses', ctx.tenantId, ctx.executor)
    .whereNotNull('satisfaction_responses.responded_at')
    .whereNotNull('satisfaction_responses.score');
  joinTickets(query, 'satisfaction_responses', ctx.tenantId);
  query.whereNull('tickets.deleted_at');
  applyScope(query, ctx);
  if (ctx.applyViewFilter) ctx.applyViewFilter(query);
  withinRange(query, 'satisfaction_responses.responded_at', ctx);
  return query;
}

function csatTicketsShape(ctx: MetricBuildContext): Knex.QueryBuilder {
  const query = baseTickets(ctx).whereExists((sub) => {
    void sub.select(db.raw('1')).from('satisfaction_responses')
      .whereRaw('satisfaction_responses.ticket_id = tickets.id')
      .where('satisfaction_responses.tenant_id', ctx.tenantId)
      .whereNotNull('satisfaction_responses.responded_at')
      .whereNotNull('satisfaction_responses.score')
      // Same window as the aggregate — see the note on sla_attainment.
      .modify((builder) => withinRange(builder, 'satisfaction_responses.responded_at', ctx));
  });
  return query;
}

function alertShape(ctx: MetricBuildContext): Knex.QueryBuilder {
  const query = scoped('suite_alerts', ctx.tenantId, ctx.executor);
  withinRange(query, 'suite_alerts.first_seen_at', ctx);
  return query;
}

function timeEntryShape(ctx: MetricBuildContext): Knex.QueryBuilder {
  const query = scoped('time_entries', ctx.tenantId, ctx.executor)
    .where('time_entries.billable', true)
    .whereNotNull('time_entries.started_at');
  joinTickets(query, 'time_entries', ctx.tenantId);
  query.whereNull('tickets.deleted_at');
  applyScope(query, ctx);
  if (ctx.applyViewFilter) ctx.applyViewFilter(query);
  withinRange(query, 'time_entries.started_at', ctx);
  return query;
}

/**
 * Deflection needs two counts from two tables, so it is the one metric built
 * from scalar sub-selects rather than a GROUP BY. It declares no dimensions,
 * which is why it never needs the bucket/group machinery.
 */
function deflectionQuery(ctx: MetricBuildContext): Knex.QueryBuilder {
  const { range } = ctx;
  const rangeArgs = [...range.fromBindings, ...range.toBindings];

  const helpful = `(
    SELECT count(*) FROM kb_feedback
    WHERE kb_feedback.tenant_id = ?
      AND kb_feedback.helpful = true
      AND kb_feedback.created_at >= ${range.fromSql}
      AND kb_feedback.created_at <  ${range.toSql}
  )`;
  const filed = `(
    SELECT count(*) FROM tickets
    WHERE tickets.tenant_id = ?
      AND tickets.deleted_at IS NULL
      AND tickets.source IN ('portal', 'web')
      AND tickets.created_at >= ${range.fromSql}
      AND tickets.created_at <  ${range.toSql}
  )`;

  return ctx.executor
    .select(
      db.raw('NULL::text as bucket'),
      db.raw('NULL::text as group_value'),
      db.raw(
        `(100.0 * ${helpful}) / NULLIF(${helpful} + ${filed}, 0) as value`,
        [
          ctx.tenantId, ...rangeArgs,
          ctx.tenantId, ...rangeArgs,
          ctx.tenantId, ...rangeArgs,
        ] as never,
      ),
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// Catalogue (what the UI builds its pickers from)
// ═════════════════════════════════════════════════════════════════════════════

export interface MetricCatalogEntry {
  key: MetricKey;
  label: string;
  labelKey: string;
  description: string;
  unit: MetricUnit;
  aggregation: MetricAggregation;
  higherIsBetter: boolean | null;
  dimensions: MetricDimension[];
  ranges: MetricRangeKey[];
  forcedGroupBy: MetricDimension | null;
  supportsSeries: boolean;
  seriesSource: 'live' | 'rollup';
}

/**
 * The catalogue the client renders its metric and dimension pickers from.
 * Shipping this means the UI cannot offer an invalid combination, and the
 * server rejects one, from the same source of truth.
 */
export function metricCatalog(): MetricCatalogEntry[] {
  return REGISTRY_LIST.map((definition) => ({
    key: definition.key,
    label: definition.label,
    labelKey: definition.labelKey,
    description: definition.description,
    unit: definition.unit,
    aggregation: definition.aggregation,
    higherIsBetter: definition.higherIsBetter,
    dimensions: [...definition.dimensions],
    ranges: [...definition.ranges],
    forcedGroupBy: definition.forcedGroupBy ?? null,
    supportsSeries: true,
    seriesSource: definition.seriesSource,
  }));
}

export function requireMetric(key: unknown): MetricDefinition {
  const resolved = resolveMetricKey(key);
  const definition = resolved ? METRIC_REGISTRY.get(resolved) : undefined;
  if (!definition) {
    throw new ConfigServiceError(
      400,
      `"${String(key)}" is not a registered metric. Registered: ${METRIC_KEYS.join(', ')}.`,
      'not_found',
    );
  }
  return definition;
}

// ═════════════════════════════════════════════════════════════════════════════
// Resolution
// ═════════════════════════════════════════════════════════════════════════════

export interface MetricRequest {
  key: string;
  range?: MetricRangeKey;
  from?: string;
  to?: string;
  groupBy?: MetricDimension | null;
  granularity?: MetricGranularity | null;
  /** A saved view SLUG — configuration, not a filter fragment. */
  viewSlug?: string | null;
  scope?: MetricScope;
  limit?: number;
}

export interface MetricSeriesPoint {
  bucket: string | null;
  group: string | null;
  value: number | null;
}

export interface MetricResolution {
  key: MetricKey;
  label: string;
  labelKey: string;
  unit: MetricUnit;
  aggregation: MetricAggregation;
  higherIsBetter: boolean | null;
  range: MetricRangeKey;
  groupBy: MetricDimension | null;
  granularity: MetricGranularity | null;
  points: MetricSeriesPoint[];
  /** The headline number: the single value, or the sum/mean across groups. */
  total: number | null;
  /** Everything a KPI click needs to fetch the records behind this number. */
  drill: {
    metric: MetricKey;
    range: MetricRangeKey;
    from?: string;
    to?: string;
    groupBy: MetricDimension | null;
    viewSlug: string | null;
    scope: MetricScope;
  };
  warnings: string[];
}

/**
 * The range a metric means when the caller does not say.
 *
 * A snapshot metric defaults to `all_time`, which for it means "right now" —
 * the live number. Defaulting it to a window would send every unqualified
 * "how many are open?" to the rollup table, where the answer is yesterday's
 * and is missing entirely until the first nightly run.
 */
function defaultRangeFor(definition: MetricDefinition): MetricRangeKey {
  if (definition.seriesSource === 'rollup') return 'all_time';
  return definition.ranges.includes('last_30_days') ? 'last_30_days' : definition.ranges[0];
}

/**
 * True when a snapshot metric is being asked for HISTORY rather than for its
 * current value — either explicitly (a granularity) or implicitly (a bounded
 * range, which for a metric with no timestamp column can only mean "over
 * time").
 */
function wantsRollupHistory(ctx: MetricBuildContext): boolean {
  if (ctx.definition.seriesSource !== 'rollup') return false;
  return ctx.granularity !== null || ctx.range.key !== 'all_time';
}

async function buildContext(
  tenantId: number,
  actor: ConfigActor,
  request: MetricRequest,
  executor: Executor,
): Promise<MetricBuildContext> {
  const definition = requireMetric(request.key);
  const warnings: string[] = [];

  const rangeKey: MetricRangeKey = request.range ?? defaultRangeFor(definition);
  if (!definition.ranges.includes(rangeKey)) {
    throw new ConfigServiceError(
      400,
      `Metric "${definition.key}" does not offer the range "${rangeKey}". Offered: ${definition.ranges.join(', ')}.`,
    );
  }

  let groupBy: MetricDimension | null = null;
  if (definition.forcedGroupBy) {
    groupBy = definition.forcedGroupBy;
    if (request.groupBy && request.groupBy !== definition.forcedGroupBy) {
      warnings.push(`"${definition.key}" is always grouped by ${definition.forcedGroupBy}; the requested grouping was ignored.`);
    }
  } else if (request.groupBy) {
    if (!isMetricDimension(request.groupBy) || !definition.dimensions.includes(request.groupBy)) {
      throw new ConfigServiceError(
        400,
        `Metric "${definition.key}" cannot be grouped by "${String(request.groupBy)}". Declared dimensions: ${definition.dimensions.join(', ') || 'none'}.`,
      );
    }
    groupBy = request.groupBy;
  }

  const timezone = await tenantTimezone(tenantId);
  const range = resolveRange(rangeKey, timezone, { from: request.from, to: request.to });

  // The saved view is the ONLY way to narrow a metric beyond its declared
  // dimensions, and a view is configuration: linted at publish, versioned,
  // and compiled by view.service — never a tree handed over by the caller.
  let applyViewFilter: ((query: Knex.QueryBuilder) => void) | null = null;
  if (request.viewSlug) {
    const view = await getView(tenantId, request.viewSlug, executor);
    if (!view) {
      throw new ConfigServiceError(404, `No published view with the slug "${request.viewSlug}".`, 'not_found');
    }
    if (view.filter) {
      const catalog = await loadFieldCatalog(tenantId, executor);
      const compileCtx: CompileContext = { actor, now: new Date(), catalog, warnings };
      const filter = view.filter;
      applyViewFilter = (query) => { query.where((group) => compileCondition(group, filter, compileCtx)); };
    }
  }

  return {
    tenantId,
    actor,
    definition,
    range,
    groupBy,
    granularity: request.granularity ?? null,
    scope: request.scope ?? {},
    applyViewFilter,
    limit: Math.min(Math.max(request.limit ?? 20, 1), 200),
    executor,
    warnings,
  };
}

/** Resolve one metric to points plus a headline total and a drill descriptor. */
export async function resolveMetric(
  tenantId: number,
  actor: ConfigActor,
  request: MetricRequest,
  executor: Executor = db,
): Promise<MetricResolution> {
  const ctx = await buildContext(tenantId, actor, request, executor);
  const { definition } = ctx;

  // A snapshot metric has no timestamp to bucket on; its history lives in
  // metric_daily_rollup. Answering "open tickets over the last 30 days" from
  // the live table would return today's number and label it with a window,
  // which is worse than saying where the answer really comes from.
  if (wantsRollupHistory(ctx)) {
    return resolveFromRollup(tenantId, ctx);
  }

  const rows = (await definition.build(ctx)) as Array<{ bucket: string | null; group_value: string | null; value: string | number | null }>;

  const points: MetricSeriesPoint[] = rows.map((row) => ({
    bucket: row.bucket ?? null,
    group: row.group_value ?? null,
    value: row.value === null || row.value === undefined ? null : Number(row.value),
  }));

  return {
    key: definition.key,
    label: definition.label,
    labelKey: definition.labelKey,
    unit: definition.unit,
    aggregation: definition.aggregation,
    higherIsBetter: definition.higherIsBetter,
    range: ctx.range.key,
    groupBy: ctx.groupBy,
    granularity: ctx.granularity,
    points,
    total: headlineTotal(points, definition),
    drill: {
      metric: definition.key,
      range: ctx.range.key,
      from: request.from,
      to: request.to,
      groupBy: ctx.groupBy,
      viewSlug: request.viewSlug ?? null,
      scope: ctx.scope,
    },
    warnings: ctx.warnings,
  };
}

/**
 * The headline number.
 *
 * Counts and sums add up across groups. Percentages, ratios, scores and
 * medians do NOT — averaging a per-queue attainment gives a small queue the
 * same weight as a large one, which is exactly how a dashboard reports 94%
 * while the desk is at 71%. For those, a grouped result has no single honest
 * total, so it returns null and the UI shows the breakdown instead.
 */
function headlineTotal(points: MetricSeriesPoint[], definition: MetricDefinition): number | null {
  const values = points.map((point) => point.value).filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];

  if (definition.aggregation === 'count' || definition.aggregation === 'sum') {
    return values.reduce((sum, value) => sum + value, 0);
  }
  return null;
}

/** History of a snapshot metric, read back out of `metric_daily_rollup`. */
async function resolveFromRollup(tenantId: number, ctx: MetricBuildContext): Promise<MetricResolution> {
  const { definition, range } = ctx;

  const query = scoped('metric_daily_rollup', tenantId, ctx.executor)
    .where('metric_daily_rollup.metric_key', definition.key)
    .whereRaw(
      `metric_daily_rollup.day >= (${range.fromSql})::date AND metric_daily_rollup.day < (${range.toSql})::date`,
      [...range.fromBindings, ...range.toBindings],
    );

  const dimension = definition.forcedGroupBy ?? ctx.groupBy;

  // Weekly and monthly buckets re-truncate the stored daily rows. Note the
  // aggregate: a COUNT rolls up by summing, but a snapshot does not — three
  // days of "42 open" is not "126 open". A snapshot is averaged across the
  // bucket, which is the only reading of "open tickets, by week" that is not
  // simply wrong.
  const bucketSql = ctx.granularity && ctx.granularity !== 'day'
    ? `to_char(date_trunc('${ctx.granularity === 'week' ? 'week' : 'month'}', metric_daily_rollup.day), 'YYYY-MM-DD')`
    : `to_char(metric_daily_rollup.day, 'YYYY-MM-DD')`;

  const valueSql = definition.aggregation === 'count' || definition.aggregation === 'sum'
    ? 'sum(metric_daily_rollup.value)::numeric'
    : 'avg(metric_daily_rollup.value)::numeric';

  if (dimension) {
    query.select(
      db.raw(`${bucketSql} as bucket`),
      db.raw(`metric_daily_rollup.dimensions ->> ? as group_value`, [dimension]),
      db.raw(`${valueSql} as value`),
    )
      .groupByRaw(`${bucketSql}, metric_daily_rollup.dimensions ->> ?`, [dimension])
      .orderByRaw(`${bucketSql} ASC`);
  } else {
    query.select(
      db.raw(`${bucketSql} as bucket`),
      db.raw('NULL::text as group_value'),
      db.raw(`${valueSql} as value`),
    )
      // The overall figure is the row with NO dimensions. Summing the
      // per-queue rows instead would double-count every ticket that the
      // rollup wrote under more than one axis.
      .whereRaw(`metric_daily_rollup.dimensions = '{}'::jsonb`)
      .groupByRaw(bucketSql)
      .orderByRaw(`${bucketSql} ASC`);
  }

  const rows = (await query) as Array<{ bucket: string; group_value: string | null; value: string }>;
  const points: MetricSeriesPoint[] = rows.map((row) => ({
    bucket: row.bucket,
    group: row.group_value ?? null,
    value: row.value === null ? null : Number(row.value),
  }));

  if (points.length === 0) {
    ctx.warnings.push(
      `No daily rollup rows for "${definition.key}" in this range yet. Point-in-time metrics only have a history from the day the rollup first ran.`,
    );
  }

  return {
    key: definition.key,
    label: definition.label,
    labelKey: definition.labelKey,
    unit: definition.unit,
    aggregation: definition.aggregation,
    higherIsBetter: definition.higherIsBetter,
    range: range.key,
    groupBy: dimension,
    granularity: ctx.granularity,
    points,
    // The headline of a snapshot SERIES is its most recent point. Grouped, it
    // has none: the last row is one group's value, and presenting it as the
    // total would put a single queue's number under a chart of all of them.
    total: dimension === null && points.length > 0 ? points[points.length - 1].value : null,
    drill: {
      metric: definition.key,
      range: range.key,
      groupBy: dimension,
      viewSlug: null,
      scope: ctx.scope,
    },
    warnings: ctx.warnings,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Drill-through
// ═════════════════════════════════════════════════════════════════════════════

export interface MetricRecords {
  key: MetricKey;
  rows: Array<Record<string, unknown>>;
  page: number;
  limit: number;
  warnings: string[];
}

/**
 * The tickets behind a number — built from the SAME predicates as the
 * aggregate, in the same definition, so the list can never disagree with the
 * KPI it was reached from.
 *
 * `DISTINCT tickets.id` matters: an SLA or time-entry metric joins one ticket
 * to several child rows, and a drill-through that shows the same ticket four
 * times is a drill-through nobody trusts twice.
 */
export async function metricRecords(
  tenantId: number,
  actor: ConfigActor,
  request: MetricRequest & { group?: string | null },
  options: { page?: number; limit?: number } = {},
  executor: Executor = db,
): Promise<MetricRecords> {
  const ctx = await buildContext(tenantId, actor, request, executor);
  const limit = Math.min(Math.max(options.limit ?? PAGINATION.defaultLimit, 1), PAGINATION.maxLimit);
  const page = Math.max(options.page ?? 1, 1);

  const query = ctx.definition.records(ctx, request.group);

  const rows = (await query
    .clearSelect()
    .distinct('tickets.id')
    .select(
      'tickets.id', 'tickets.number', 'tickets.subject', 'tickets.record_type',
      'tickets.status_slug', 'tickets.status_category', 'tickets.priority_slug',
      'tickets.queue_slug', 'tickets.assignee_id', 'tickets.assignment_group_id',
      'tickets.organization_id', 'tickets.occurred_at', 'tickets.created_at',
      'tickets.updated_at', 'tickets.due_at', 'tickets.resolved_at',
      'tickets.reopen_count', 'tickets.row_version',
    )
    .orderBy('tickets.id', 'desc')
    .limit(limit)
    .offset((page - 1) * limit)) as Array<Record<string, unknown>>;

  return { key: ctx.definition.key, rows, page, limit, warnings: ctx.warnings };
}

// ═════════════════════════════════════════════════════════════════════════════
// Deltas
// ═════════════════════════════════════════════════════════════════════════════

export interface MetricDelta {
  current: number | null;
  previous: number | null;
  /** Absolute change; null when either side is unknown. */
  change: number | null;
  /** Percentage change; null when the previous value is 0 or unknown. */
  changePercent: number | null;
  /** 'up' | 'down' | 'flat' — direction, not judgement. */
  direction: 'up' | 'down' | 'flat' | 'unknown';
  /** True when the direction is the good one for THIS metric. */
  improved: boolean | null;
}

const PREVIOUS_RANGE: Partial<Record<MetricRangeKey, MetricRangeKey>> = {
  today: 'yesterday',
  last_7_days: 'last_7_days',
  last_30_days: 'last_30_days',
};

/**
 * "vs yesterday" / "vs last week" for a KPI tile.
 *
 * For a rollup-backed metric the comparison is read straight out of
 * `metric_daily_rollup`, which is the entire reason that table exists: last
 * Tuesday's open count is not derivable from today's rows.
 */
export async function resolveDelta(
  tenantId: number,
  actor: ConfigActor,
  request: MetricRequest,
  compareTo: 'yesterday' | 'last_week' = 'yesterday',
  executor: Executor = db,
): Promise<MetricDelta> {
  const definition = requireMetric(request.key);
  const current = await resolveMetric(tenantId, actor, request, executor);

  let previousValue: number | null = null;

  if (definition.seriesSource === 'rollup') {
    const offsetDays = compareTo === 'yesterday' ? 1 : 7;
    const row = (await scoped('metric_daily_rollup', tenantId, executor)
      .where('metric_daily_rollup.metric_key', definition.key)
      .whereRaw(`metric_daily_rollup.dimensions = '{}'::jsonb`)
      .whereRaw(`metric_daily_rollup.day = (CURRENT_DATE - ?::int)`, [offsetDays])
      .select('value')
      .first()) as { value: string } | undefined;
    previousValue = row ? Number(row.value) : null;
  } else {
    const previousRange = PREVIOUS_RANGE[current.range];
    if (previousRange) {
      // Shift the window back by its own length using an explicit custom range
      // rather than a second registry entry — the arithmetic is the same for
      // every event metric.
      const shiftDays = current.range === 'today' ? 1 : current.range === 'last_7_days' ? 7 : 30;
      const now = new Date();
      const to = new Date(now.getTime() - shiftDays * 86_400_000);
      const from = new Date(to.getTime() - shiftDays * 86_400_000);
      const previous = await resolveMetric(
        tenantId,
        actor,
        { ...request, range: 'custom', from: from.toISOString(), to: to.toISOString(), granularity: null },
        executor,
      );
      previousValue = previous.total;
    }
  }

  const currentValue = current.total;
  if (currentValue === null || previousValue === null) {
    return { current: currentValue, previous: previousValue, change: null, changePercent: null, direction: 'unknown', improved: null };
  }

  const change = currentValue - previousValue;
  const changePercent = previousValue === 0 ? null : (change / Math.abs(previousValue)) * 100;
  const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const improved = definition.higherIsBetter === null || change === 0
    ? null
    : definition.higherIsBetter ? change > 0 : change < 0;

  return { current: currentValue, previous: previousValue, change, changePercent, direction, improved };
}
