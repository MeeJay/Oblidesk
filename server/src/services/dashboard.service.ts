/**
 * dashboard.service.ts — dashboards, widgets, and resolving a widget to data.
 *
 * ── Two places a dashboard can live, and why ─────────────────────────────────
 * `config_objects` (kind = 'dashboard') holds SHIPPED dashboards: the baseline
 * "Operations" board, and anything an admin exports and moves between tenants.
 * The `dashboards` / `dashboard_widgets` tables hold LIVE ones: what people
 * actually drag around, per tenant, with owners and grid positions.
 *
 * They are not duplicates, they are a template and an instance.
 * {@link materializeFromConfig} turns one into the other, which is what makes
 * the shipped Operations board appear on a new tenant without the tenant's
 * layout edits being clobbered the next time the product ships a new baseline.
 *
 * ── Resolving a widget ───────────────────────────────────────────────────────
 * A widget's `config` is stored jsonb, which means it is untrusted input that
 * happens to be at rest. {@link resolveWidget} therefore validates it against
 * metric.service's registry before it becomes a query: the metric key must be
 * registered, the group-by must be one the metric declares, the range must be
 * one it offers, and the view must be a published saved view. Nothing in the
 * config reaches SQL as a column name, an operator or a fragment.
 *
 * A widget that fails validation renders as an error card naming what is
 * wrong. It does not render as an empty chart — an empty chart is
 * indistinguishable from "a quiet week", and that is the failure mode that
 * gets a dashboard quietly ignored for six months.
 */

import type { Knex } from 'knex';

import { PAGINATION, type WidgetType } from '@oblidesk/shared';

import { db, scoped, insertScoped, type Executor } from '../db';
import {
  ConfigServiceError,
  loadPublished,
  writeAudit,
  type ConfigActor,
} from './configObject.service';
import {
  isMetricDimension,
  isMetricRange,
  metricRecords,
  resolveDelta,
  resolveMetric,
  requireMetric,
  resolveMetricKey,
  type MetricDelta,
  type MetricDimension,
  type MetricGranularity,
  type MetricRangeKey,
  type MetricRequest,
  type MetricResolution,
  type MetricScope,
} from './metric.service';
import { getView, listViewTickets, type ViewDefinition } from './view.service';

// ═════════════════════════════════════════════════════════════════════════════
// Shapes
// ═════════════════════════════════════════════════════════════════════════════

export interface DashboardRecord {
  id: number;
  tenantId: number;
  slug: string;
  name: string;
  ownerId: number | null;
  isShared: boolean;
  isDefault: boolean;
  layout: Record<string, unknown>;
  widgets?: DashboardWidgetRecord[];
}

export interface DashboardWidgetRecord {
  id: number;
  dashboardId: number;
  tenantId: number;
  tabKey: string;
  x: number;
  y: number;
  w: number;
  h: number;
  widgetType: string;
  title: string | null;
  config: Record<string, unknown>;
  sortOrder: number;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function rowToDashboard(row: Record<string, unknown>): DashboardRecord {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    slug: String(row.slug),
    name: String(row.name),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : Number(row.owner_id),
    isShared: row.is_shared === true,
    isDefault: row.is_default === true,
    layout: parseJson(row.layout),
  };
}

function rowToWidget(row: Record<string, unknown>): DashboardWidgetRecord {
  return {
    id: Number(row.id),
    dashboardId: Number(row.dashboard_id),
    tenantId: Number(row.tenant_id),
    tabKey: String(row.tab_key ?? 'overview'),
    x: Number(row.x) || 0,
    y: Number(row.y) || 0,
    w: Number(row.w) || 3,
    h: Number(row.h) || 2,
    widgetType: String(row.widget_type),
    title: (row.title as string | null) ?? null,
    config: parseJson(row.config),
    sortOrder: Number(row.sort_order) || 0,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Dashboard CRUD
// ═════════════════════════════════════════════════════════════════════════════

/** Dashboards this actor may open: their own, plus everything shared. */
export async function listDashboards(actor: ConfigActor): Promise<DashboardRecord[]> {
  const rows = (await scoped('dashboards', actor.tenantId)
    .select('*')
    .where((group) => {
      group.where('dashboards.is_shared', true);
      if (actor.userId !== null) group.orWhere('dashboards.owner_id', actor.userId);
      group.orWhereNull('dashboards.owner_id');
    })
    .orderBy(['dashboards.is_default', 'dashboards.name'])) as Array<Record<string, unknown>>;

  return rows.map(rowToDashboard);
}

export async function getDashboard(
  actor: ConfigActor,
  slug: string,
  withWidgets = true,
): Promise<DashboardRecord | null> {
  const row = (await scoped('dashboards', actor.tenantId)
    .select('*')
    .where('dashboards.slug', slug)
    .first()) as Record<string, unknown> | undefined;
  if (!row) return null;

  const dashboard = rowToDashboard(row);

  // A private dashboard belongs to its owner. Sharing is opt-in, and an admin
  // seeing everything is a separate, deliberate grant.
  if (!dashboard.isShared && dashboard.ownerId !== null && dashboard.ownerId !== actor.userId && !actor.isAdmin) {
    return null;
  }

  if (withWidgets) dashboard.widgets = await listWidgets(actor, dashboard.id);
  return dashboard;
}

export async function requireDashboard(actor: ConfigActor, slug: string): Promise<DashboardRecord> {
  const dashboard = await getDashboard(actor, slug);
  if (!dashboard) throw new ConfigServiceError(404, `No dashboard with the slug "${slug}".`, 'not_found');
  return dashboard;
}

/** The board a user lands on: their default, else the tenant's. */
export async function defaultDashboard(actor: ConfigActor): Promise<DashboardRecord | null> {
  const row = (await scoped('dashboards', actor.tenantId)
    .select('*')
    .where('dashboards.is_default', true)
    .first()) as Record<string, unknown> | undefined;
  if (!row) {
    const all = await listDashboards(actor);
    return all.length > 0 ? getDashboard(actor, all[0].slug) : null;
  }
  const dashboard = rowToDashboard(row);
  dashboard.widgets = await listWidgets(actor, dashboard.id);
  return dashboard;
}

export interface CreateDashboardInput {
  slug: string;
  name: string;
  isShared?: boolean;
  isDefault?: boolean;
  layout?: Record<string, unknown>;
}

export async function createDashboard(
  actor: ConfigActor,
  input: CreateDashboardInput,
): Promise<DashboardRecord> {
  const slug = input.slug.trim().toLowerCase();
  if (!slug) throw new ConfigServiceError(400, 'A dashboard needs a slug.');

  return db.transaction(async (trx) => {
    const clash = await scoped('dashboards', actor.tenantId, trx)
      .where('dashboards.slug', slug)
      .first();
    if (clash) throw new ConfigServiceError(409, `A dashboard with the slug "${slug}" already exists.`, 'conflict');

    if (input.isDefault) await clearDefault(actor, trx);

    const [row] = (await insertScoped('dashboards', actor.tenantId, {
      slug,
      name: input.name.trim() || slug,
      owner_id: actor.userId,
      is_shared: input.isShared === true,
      is_default: input.isDefault === true,
      layout: JSON.stringify(input.layout ?? {}),
    }, trx).returning('*')) as Array<Record<string, unknown>>;

    await writeAudit(trx, actor, {
      action: 'dashboard.create',
      entityType: 'dashboard',
      entityId: slug,
      before: null,
      after: { slug, name: input.name, isShared: input.isShared === true },
    });

    return rowToDashboard(row);
  });
}

export async function updateDashboard(
  actor: ConfigActor,
  slug: string,
  patch: Partial<CreateDashboardInput>,
): Promise<DashboardRecord> {
  return db.transaction(async (trx) => {
    const existing = (await scoped('dashboards', actor.tenantId, trx)
      .select('*')
      .where('dashboards.slug', slug)
      .first()) as Record<string, unknown> | undefined;
    if (!existing) throw new ConfigServiceError(404, `No dashboard with the slug "${slug}".`, 'not_found');

    const current = rowToDashboard(existing);
    assertCanEdit(actor, current);

    if (patch.isDefault === true) await clearDefault(actor, trx);

    const update: Record<string, unknown> = {};
    if (patch.name !== undefined) update.name = patch.name.trim() || current.name;
    if (patch.isShared !== undefined) update.is_shared = patch.isShared;
    if (patch.isDefault !== undefined) update.is_default = patch.isDefault;
    if (patch.layout !== undefined) update.layout = JSON.stringify(patch.layout);

    if (Object.keys(update).length > 0) {
      await scoped('dashboards', actor.tenantId, trx).where('dashboards.id', current.id).update(update);
    }

    await writeAudit(trx, actor, {
      action: 'dashboard.update',
      entityType: 'dashboard',
      entityId: slug,
      before: { name: current.name, isShared: current.isShared, isDefault: current.isDefault },
      after: update,
    });

    const row = (await scoped('dashboards', actor.tenantId, trx)
      .select('*')
      .where('dashboards.id', current.id)
      .first()) as Record<string, unknown>;
    return rowToDashboard(row);
  });
}

export async function deleteDashboard(actor: ConfigActor, slug: string): Promise<void> {
  await db.transaction(async (trx) => {
    const existing = (await scoped('dashboards', actor.tenantId, trx)
      .select('*')
      .where('dashboards.slug', slug)
      .first()) as Record<string, unknown> | undefined;
    if (!existing) throw new ConfigServiceError(404, `No dashboard with the slug "${slug}".`, 'not_found');

    const current = rowToDashboard(existing);
    assertCanEdit(actor, current);

    // Widgets go with it (ON DELETE CASCADE), which is what you want: an
    // orphaned widget is invisible and still costs a row.
    await scoped('dashboards', actor.tenantId, trx).where('dashboards.id', current.id).delete();

    await writeAudit(trx, actor, {
      action: 'dashboard.delete',
      entityType: 'dashboard',
      entityId: slug,
      before: { slug, name: current.name },
      after: null,
    });
  });
}

function assertCanEdit(actor: ConfigActor, dashboard: DashboardRecord): void {
  if (actor.isAdmin) return;
  if (dashboard.ownerId === null || dashboard.ownerId === actor.userId) return;
  throw new ConfigServiceError(403, `"${dashboard.slug}" belongs to somebody else.`, 'forbidden');
}

/**
 * `dashboards_one_default` is a partial UNIQUE index, so two defaults is a
 * constraint violation rather than a silently ambiguous landing page. Clear
 * the old one first.
 */
async function clearDefault(actor: ConfigActor, trx: Knex.Transaction): Promise<void> {
  await scoped('dashboards', actor.tenantId, trx)
    .where('dashboards.is_default', true)
    .update({ is_default: false });
}

// ═════════════════════════════════════════════════════════════════════════════
// Widget CRUD
// ═════════════════════════════════════════════════════════════════════════════

export async function listWidgets(actor: ConfigActor, dashboardId: number): Promise<DashboardWidgetRecord[]> {
  const rows = (await scoped('dashboard_widgets', actor.tenantId)
    .select('*')
    .where('dashboard_widgets.dashboard_id', dashboardId)
    .orderBy(['dashboard_widgets.tab_key', 'dashboard_widgets.sort_order', 'dashboard_widgets.id'])) as Array<Record<string, unknown>>;
  return rows.map(rowToWidget);
}

export interface CreateWidgetInput {
  tabKey?: string;
  widgetType: string;
  title?: string | null;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  config?: Record<string, unknown>;
  sortOrder?: number;
}

export async function createWidget(
  actor: ConfigActor,
  dashboardSlug: string,
  input: CreateWidgetInput,
): Promise<DashboardWidgetRecord> {
  const dashboard = await requireDashboard(actor, dashboardSlug);
  assertCanEdit(actor, dashboard);

  // Validate BEFORE it is stored. A widget that cannot resolve should be
  // impossible to save, not a puzzle to debug on the board.
  assertWidgetConfig(input.widgetType, input.config ?? {});

  return db.transaction(async (trx) => {
    const [row] = (await insertScoped('dashboard_widgets', actor.tenantId, {
      dashboard_id: dashboard.id,
      tab_key: input.tabKey ?? 'overview',
      widget_type: input.widgetType,
      title: input.title ?? null,
      x: clampGrid(input.x ?? 0, 0, 11),
      y: Math.max(input.y ?? 0, 0),
      w: clampGrid(input.w ?? 3, 1, 12),
      h: Math.max(input.h ?? 2, 1),
      config: JSON.stringify(input.config ?? {}),
      sort_order: input.sortOrder ?? 0,
    }, trx).returning('*')) as Array<Record<string, unknown>>;

    await writeAudit(trx, actor, {
      action: 'dashboard.widget.create',
      entityType: 'dashboard_widget',
      entityId: `${dashboardSlug}:${String(row.id)}`,
      before: null,
      after: { widgetType: input.widgetType, tabKey: input.tabKey ?? 'overview' },
    });

    return rowToWidget(row);
  });
}

export async function updateWidget(
  actor: ConfigActor,
  widgetId: number,
  patch: Partial<CreateWidgetInput>,
): Promise<DashboardWidgetRecord> {
  return db.transaction(async (trx) => {
    const existing = (await scoped('dashboard_widgets', actor.tenantId, trx)
      .select('*')
      .where('dashboard_widgets.id', widgetId)
      .first()) as Record<string, unknown> | undefined;
    if (!existing) throw new ConfigServiceError(404, `No widget ${widgetId}.`, 'not_found');

    const current = rowToWidget(existing);
    const dashboardRow = (await scoped('dashboards', actor.tenantId, trx)
      .select('*')
      .where('dashboards.id', current.dashboardId)
      .first()) as Record<string, unknown>;
    assertCanEdit(actor, rowToDashboard(dashboardRow));

    const nextType = patch.widgetType ?? current.widgetType;
    const nextConfig = patch.config ?? current.config;
    assertWidgetConfig(nextType, nextConfig);

    const update: Record<string, unknown> = {};
    if (patch.tabKey !== undefined) update.tab_key = patch.tabKey;
    if (patch.widgetType !== undefined) update.widget_type = patch.widgetType;
    if (patch.title !== undefined) update.title = patch.title;
    if (patch.x !== undefined) update.x = clampGrid(patch.x, 0, 11);
    if (patch.y !== undefined) update.y = Math.max(patch.y, 0);
    if (patch.w !== undefined) update.w = clampGrid(patch.w, 1, 12);
    if (patch.h !== undefined) update.h = Math.max(patch.h, 1);
    if (patch.config !== undefined) update.config = JSON.stringify(patch.config);
    if (patch.sortOrder !== undefined) update.sort_order = patch.sortOrder;

    if (Object.keys(update).length > 0) {
      await scoped('dashboard_widgets', actor.tenantId, trx)
        .where('dashboard_widgets.id', widgetId)
        .update(update);
    }

    const row = (await scoped('dashboard_widgets', actor.tenantId, trx)
      .select('*')
      .where('dashboard_widgets.id', widgetId)
      .first()) as Record<string, unknown>;
    return rowToWidget(row);
  });
}

export async function deleteWidget(actor: ConfigActor, widgetId: number): Promise<void> {
  const existing = (await scoped('dashboard_widgets', actor.tenantId)
    .select('*')
    .where('dashboard_widgets.id', widgetId)
    .first()) as Record<string, unknown> | undefined;
  if (!existing) throw new ConfigServiceError(404, `No widget ${widgetId}.`, 'not_found');

  const current = rowToWidget(existing);
  const dashboardRow = (await scoped('dashboards', actor.tenantId)
    .select('*')
    .where('dashboards.id', current.dashboardId)
    .first()) as Record<string, unknown>;
  assertCanEdit(actor, rowToDashboard(dashboardRow));

  await scoped('dashboard_widgets', actor.tenantId)
    .where('dashboard_widgets.id', widgetId)
    .delete();
}

/**
 * Bulk layout save — one round trip for a whole drag-and-drop session.
 * Positions only: a layout save must never be able to change what a widget
 * queries, or "I moved a box" becomes "I rewrote a report".
 */
export async function saveLayout(
  actor: ConfigActor,
  dashboardSlug: string,
  positions: Array<{ id: number; x: number; y: number; w: number; h: number; tabKey?: string; sortOrder?: number }>,
): Promise<DashboardWidgetRecord[]> {
  const dashboard = await requireDashboard(actor, dashboardSlug);
  assertCanEdit(actor, dashboard);

  await db.transaction(async (trx) => {
    for (const position of positions) {
      await scoped('dashboard_widgets', actor.tenantId, trx)
        .where('dashboard_widgets.id', position.id)
        .where('dashboard_widgets.dashboard_id', dashboard.id)
        .update({
          x: clampGrid(position.x, 0, 11),
          y: Math.max(position.y, 0),
          w: clampGrid(position.w, 1, 12),
          h: Math.max(position.h, 1),
          ...(position.tabKey !== undefined ? { tab_key: position.tabKey } : {}),
          ...(position.sortOrder !== undefined ? { sort_order: position.sortOrder } : {}),
        });
    }
  });

  return listWidgets(actor, dashboard.id);
}

function clampGrid(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

// ═════════════════════════════════════════════════════════════════════════════
// Widget config → a validated metric request
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Widget types, normalised. The shipped baseline writes 'stat', 'bar', 'line',
 * 'area', 'donut'; `shared/src/configKinds.ts` declares 'kpi', 'bar_chart',
 * 'line_chart', 'area_chart', 'donut'. Both are real, so both are accepted.
 */
const WIDGET_TYPE_ALIASES: Readonly<Record<string, WidgetType>> = {
  stat: 'kpi',
  kpi: 'kpi',
  number: 'kpi',
  bar: 'bar_chart',
  bar_chart: 'bar_chart',
  line: 'line_chart',
  line_chart: 'line_chart',
  area: 'area_chart',
  area_chart: 'area_chart',
  donut: 'donut',
  pie: 'donut',
  heatmap: 'heatmap',
  sla_gauge: 'sla_gauge',
  queue_load: 'queue_load',
  agent_leaderboard: 'agent_leaderboard',
  ticket_list: 'ticket_list',
  activity_feed: 'activity_feed',
  alert_feed: 'alert_feed',
  csat: 'csat',
  time_summary: 'time_summary',
  text: 'text',
};

export function normalizeWidgetType(widgetType: string): WidgetType {
  const normalized = WIDGET_TYPE_ALIASES[widgetType.toLowerCase()];
  if (!normalized) {
    throw new ConfigServiceError(400, `"${widgetType}" is not a widget type.`);
  }
  return normalized;
}

/** Widget types that render a metric rather than a list or a block of text. */
const METRIC_WIDGETS = new Set<WidgetType>([
  'kpi', 'bar_chart', 'line_chart', 'area_chart', 'donut', 'heatmap',
  'sla_gauge', 'queue_load', 'agent_leaderboard', 'csat', 'time_summary',
]);

/** Chart types that want a time series rather than a single value. */
const SERIES_WIDGETS = new Set<WidgetType>(['line_chart', 'area_chart', 'heatmap']);

const RANGE_ALIASES: Readonly<Record<string, MetricRangeKey>> = {
  today: 'today',
  yesterday: 'yesterday',
  last_7_days: 'last_7_days',
  last7days: 'last_7_days',
  last_30_days: 'last_30_days',
  last30days: 'last_30_days',
  last_90_days: 'last_90_days',
  this_week: 'this_week',
  this_month: 'this_month',
  mtd: 'this_month',
  qtd: 'qtd',
  ytd: 'ytd',
  last_12_months: 'last_12_months',
  all_time: 'all_time',
  all: 'all_time',
  custom: 'custom',
};

export interface WidgetPlan {
  widgetType: WidgetType;
  kind: 'metric' | 'tickets' | 'activity' | 'text' | 'alerts';
  request?: MetricRequest;
  viewSlug?: string | null;
  limit: number;
  wantsSeries: boolean;
  wantsDelta: boolean;
  /** Reference line on a chart, e.g. an SLA target of 95%. */
  target: number | null;
  /** `{ value, tone }` — colour the tile when it crosses this. */
  toneWhenAbove: { value: number; tone: string } | null;
  drillToView: string | null;
}

/**
 * Turn a stored widget config into a plan, refusing anything the registry does
 * not declare. This is the choke point: after this function, every value that
 * reaches a query has been checked against the registry, and there is no path
 * from `config` to a column name or an operator.
 */
export function planWidget(widgetType: string, config: Record<string, unknown>): WidgetPlan {
  const normalizedType = normalizeWidgetType(widgetType);

  const limit = clampGrid(Number(config.limit ?? 20), 1, 200);
  const drillToView = typeof config.drill_to_view === 'string'
    ? config.drill_to_view
    : typeof config.drillToView === 'string' ? config.drillToView : null;

  const target = Number.isFinite(Number(config.target)) ? Number(config.target) : null;

  let toneWhenAbove: WidgetPlan['toneWhenAbove'] = null;
  const rawTone = config.tone_when_above ?? config.toneWhenAbove;
  if (rawTone && typeof rawTone === 'object' && !Array.isArray(rawTone)) {
    const tone = rawTone as Record<string, unknown>;
    if (Number.isFinite(Number(tone.value))) {
      toneWhenAbove = { value: Number(tone.value), tone: String(tone.tone ?? 'warn') };
    }
  }

  const viewSlug = typeof config.view === 'string'
    ? config.view
    : typeof config.viewSlug === 'string' ? config.viewSlug : null;

  if (normalizedType === 'text') {
    return { widgetType: normalizedType, kind: 'text', limit, wantsSeries: false, wantsDelta: false, target, toneWhenAbove, drillToView };
  }
  if (normalizedType === 'activity_feed') {
    return { widgetType: normalizedType, kind: 'activity', limit, wantsSeries: false, wantsDelta: false, target, toneWhenAbove, drillToView };
  }
  if (normalizedType === 'alert_feed') {
    return { widgetType: normalizedType, kind: 'alerts', limit, wantsSeries: false, wantsDelta: false, target, toneWhenAbove, drillToView };
  }
  if (normalizedType === 'ticket_list') {
    if (!viewSlug) {
      throw new ConfigServiceError(400, 'A ticket list widget needs a saved view (`view`).');
    }
    return { widgetType: normalizedType, kind: 'tickets', viewSlug, limit, wantsSeries: false, wantsDelta: false, target, toneWhenAbove, drillToView };
  }

  if (!METRIC_WIDGETS.has(normalizedType)) {
    throw new ConfigServiceError(400, `Widget type "${widgetType}" has no data source.`);
  }

  // ── metric ────────────────────────────────────────────────────────────
  const rawMetric = config.metric ?? config.metricKey;
  const rawRange = config.window ?? config.range ?? config.date_range ?? config.dateRange;

  const metricKey = resolveMetricKey(disambiguateLegacyKey(rawMetric, rawRange, config));
  if (!metricKey) {
    throw new ConfigServiceError(
      400,
      `"${String(rawMetric)}" is not a registered metric. A widget can only ask for a metric the registry declares.`,
    );
  }
  const definition = requireMetric(metricKey);
  let range: MetricRangeKey | undefined;
  if (typeof rawRange === 'string') {
    const mapped = RANGE_ALIASES[rawRange.toLowerCase()];
    if (!mapped || !isMetricRange(mapped)) {
      throw new ConfigServiceError(400, `"${rawRange}" is not a date range this product offers.`);
    }
    if (!definition.ranges.includes(mapped)) {
      throw new ConfigServiceError(
        400,
        `Metric "${metricKey}" does not offer the range "${mapped}". Offered: ${definition.ranges.join(', ')}.`,
      );
    }
    range = mapped;
  }

  const rawGroupBy = config.group_by ?? config.groupBy;
  let groupBy: MetricDimension | null = null;
  if (typeof rawGroupBy === 'string' && rawGroupBy !== '') {
    if (!isMetricDimension(rawGroupBy) || !definition.dimensions.includes(rawGroupBy)) {
      throw new ConfigServiceError(
        400,
        `Metric "${metricKey}" cannot be grouped by "${rawGroupBy}". Declared dimensions: ${definition.dimensions.join(', ') || 'none'}.`,
      );
    }
    groupBy = rawGroupBy;
  }

  const rawInterval = config.interval ?? config.granularity;
  let granularity: MetricGranularity | null = null;
  if (typeof rawInterval === 'string') {
    if (!['day', 'week', 'month'].includes(rawInterval)) {
      throw new ConfigServiceError(400, `"${rawInterval}" is not an interval. Expected day, week or month.`);
    }
    granularity = rawInterval as MetricGranularity;
  } else if (SERIES_WIDGETS.has(normalizedType)) {
    granularity = 'day';
  }

  const scope = readScope(config);

  return {
    widgetType: normalizedType,
    kind: 'metric',
    request: {
      key: metricKey,
      range,
      groupBy,
      granularity,
      viewSlug,
      scope,
      limit,
    },
    viewSlug,
    limit,
    wantsSeries: granularity !== null,
    wantsDelta: normalizedType === 'kpi',
    target,
    toneWhenAbove,
    drillToView,
  };
}

/**
 * `ticket_count` is the one legacy key whose meaning depends on its widget.
 *
 * On the shipped Operations board it appears twice with two different
 * intentions: as a live backlog count over a saved view ("Open", "Unassigned",
 * "Breaching soon", and the two donuts), and once as a throughput count over a
 * window with a resolution-code axis ("Top resolution codes, 30 days"). Those
 * are `open_tickets` and `resolved` respectively, and the tell is unambiguous:
 * an OPEN ticket has no resolution code and no completion date, so a bounded
 * window plus an outcome axis can only mean the tickets that finished in it.
 *
 * Resolving it here, once, keeps the registry honest — `open_tickets` does not
 * pretend to have a `resolution_code` dimension just to make an old widget
 * config parse.
 */
function disambiguateLegacyKey(
  rawMetric: unknown,
  rawRange: unknown,
  config: Record<string, unknown>,
): unknown {
  if (rawMetric !== 'ticket_count') return rawMetric;

  const bounded = typeof rawRange === 'string' && rawRange !== '' && rawRange !== 'all_time' && rawRange !== 'all';
  if (!bounded) return rawMetric;

  const groupBy = config.group_by ?? config.groupBy;
  const outcomeAxis = groupBy === 'resolution_code';

  return outcomeAxis ? 'resolved' : rawMetric;
}

/**
 * Read the closed scope vocabulary out of a widget config. Anything not on
 * this list is ignored rather than passed through — an unrecognised key in a
 * stored config must never become a predicate.
 */
function readScope(config: Record<string, unknown>): MetricScope {
  const scope: MetricScope = {};
  const source = (config.scope && typeof config.scope === 'object' && !Array.isArray(config.scope))
    ? config.scope as Record<string, unknown>
    : config;

  const str = (key: string): string | undefined => {
    const value = source[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
  const num = (key: string): number | undefined => {
    const value = Number(source[key]);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };

  const queueSlug = str('queue_slug') ?? str('queueSlug');
  if (queueSlug) scope.queueSlug = queueSlug;
  const prioritySlug = str('priority_slug') ?? str('prioritySlug');
  if (prioritySlug) scope.prioritySlug = prioritySlug;
  const recordType = str('record_type') ?? str('recordType');
  if (recordType) scope.recordType = recordType;
  const ticketSource = str('ticket_source') ?? str('source');
  if (ticketSource) scope.source = ticketSource;
  const assigneeId = num('assignee_id') ?? num('assigneeId');
  if (assigneeId) scope.assigneeId = assigneeId;
  const groupId = num('assignment_group_id') ?? num('assignmentGroupId');
  if (groupId) scope.assignmentGroupId = groupId;
  const organizationId = num('organization_id') ?? num('organizationId');
  if (organizationId) scope.organizationId = organizationId;

  return scope;
}

/** Throws when a widget config would not resolve. Used before every write. */
export function assertWidgetConfig(widgetType: string, config: Record<string, unknown>): void {
  planWidget(widgetType, config);
}

// ═════════════════════════════════════════════════════════════════════════════
// Resolution
// ═════════════════════════════════════════════════════════════════════════════

export interface ResolvedWidget {
  widget: DashboardWidgetRecord;
  widgetType: WidgetType;
  kind: WidgetPlan['kind'];
  metric?: MetricResolution;
  delta?: MetricDelta;
  tickets?: Array<Record<string, unknown>>;
  activity?: Array<Record<string, unknown>>;
  alerts?: Array<Record<string, unknown>>;
  view?: ViewDefinition | null;
  target: number | null;
  toneWhenAbove: WidgetPlan['toneWhenAbove'];
  drillToView: string | null;
  warnings: string[];
  /** Set when the widget could not be resolved. Rendered as an error card. */
  error: string | null;
}

/**
 * Resolve one widget to its data.
 *
 * Never throws: a broken widget on a dashboard of twelve must not take the
 * other eleven down with it. It returns an `error` string, which the client
 * renders as a card that says what is wrong with THIS widget.
 */
export async function resolveWidget(
  actor: ConfigActor,
  widget: DashboardWidgetRecord,
  executor: Executor = db,
): Promise<ResolvedWidget> {
  const base: ResolvedWidget = {
    widget,
    widgetType: 'text',
    kind: 'text',
    target: null,
    toneWhenAbove: null,
    drillToView: null,
    warnings: [],
    error: null,
  };

  let plan: WidgetPlan;
  try {
    plan = planWidget(widget.widgetType, widget.config);
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : 'This widget could not be resolved.',
    };
  }

  const resolved: ResolvedWidget = {
    ...base,
    widgetType: plan.widgetType,
    kind: plan.kind,
    target: plan.target,
    toneWhenAbove: plan.toneWhenAbove,
    drillToView: plan.drillToView,
  };

  try {
    switch (plan.kind) {
      case 'metric': {
        const request = plan.request as MetricRequest;
        resolved.metric = await resolveMetric(actor.tenantId, actor, request, executor);
        resolved.warnings = resolved.metric.warnings;
        if (plan.wantsDelta) {
          resolved.delta = await resolveDelta(actor.tenantId, actor, { ...request, granularity: null }, 'yesterday', executor);
        }
        if (plan.viewSlug) resolved.view = await getView(actor.tenantId, plan.viewSlug, executor);
        return resolved;
      }
      case 'tickets': {
        const page = await listViewTickets(actor.tenantId, actor, plan.viewSlug as string, { limit: plan.limit });
        resolved.tickets = page.rows;
        resolved.warnings = page.warnings;
        resolved.view = await getView(actor.tenantId, plan.viewSlug as string, executor);
        return resolved;
      }
      case 'activity': {
        resolved.activity = await recentActivity(actor, plan.limit, executor);
        return resolved;
      }
      case 'alerts': {
        resolved.alerts = await liveAlerts(actor, plan.limit, executor);
        return resolved;
      }
      default:
        return resolved;
    }
  } catch (error) {
    resolved.error = error instanceof Error ? error.message : 'This widget could not be resolved.';
    return resolved;
  }
}

/** Every widget of a dashboard, resolved. */
export async function resolveDashboard(
  actor: ConfigActor,
  slug: string,
): Promise<{ dashboard: DashboardRecord; widgets: ResolvedWidget[] }> {
  const dashboard = await requireDashboard(actor, slug);
  const widgets = dashboard.widgets ?? await listWidgets(actor, dashboard.id);

  // Sequential on purpose. A twelve-widget board firing twelve concurrent
  // aggregates at a pool of ten connections starves every request behind it,
  // and the board is not noticeably faster for it.
  const resolvedWidgets: ResolvedWidget[] = [];
  for (const widget of widgets) resolvedWidgets.push(await resolveWidget(actor, widget));

  return { dashboard, widgets: resolvedWidgets };
}

/** The drill-through behind a KPI: the tickets the number counted. */
export async function widgetRecords(
  actor: ConfigActor,
  widgetId: number,
  options: { group?: string | null; page?: number; limit?: number } = {},
): Promise<{ rows: Array<Record<string, unknown>>; page: number; limit: number; warnings: string[] }> {
  const row = (await scoped('dashboard_widgets', actor.tenantId)
    .select('*')
    .where('dashboard_widgets.id', widgetId)
    .first()) as Record<string, unknown> | undefined;
  if (!row) throw new ConfigServiceError(404, `No widget ${widgetId}.`, 'not_found');

  const widget = rowToWidget(row);
  const plan = planWidget(widget.widgetType, widget.config);

  if (plan.kind === 'tickets' && plan.viewSlug) {
    const page = await listViewTickets(actor.tenantId, actor, plan.viewSlug, {
      page: options.page,
      limit: options.limit,
    });
    return { rows: page.rows, page: page.page, limit: page.limit, warnings: page.warnings };
  }

  if (plan.kind !== 'metric' || !plan.request) {
    throw new ConfigServiceError(400, 'This widget has no records to drill into.');
  }

  const records = await metricRecords(
    actor.tenantId,
    actor,
    { ...plan.request, granularity: null, group: options.group },
    { page: options.page, limit: options.limit },
  );
  return { rows: records.rows, page: records.page, limit: records.limit, warnings: records.warnings };
}

// ── feed widgets ────────────────────────────────────────────────────────────

async function recentActivity(
  actor: ConfigActor,
  limit: number,
  executor: Executor,
): Promise<Array<Record<string, unknown>>> {
  // Portal actors never see internal work notes, whatever a widget asks for.
  const visibilities = actor.actorType === 'portal' ? ['public'] : ['public', 'internal'];

  return (await scoped('ticket_journal', actor.tenantId, executor)
    .join('tickets', 'tickets.id', 'ticket_journal.ticket_id')
    .where('tickets.tenant_id', actor.tenantId)
    .whereNull('tickets.deleted_at')
    .whereIn('ticket_journal.visibility', visibilities)
    .select(
      'ticket_journal.id', 'ticket_journal.ticket_id', 'ticket_journal.kind',
      'ticket_journal.visibility', 'ticket_journal.author_id', 'ticket_journal.author_type',
      'ticket_journal.body_md', 'ticket_journal.created_at',
      'tickets.number', 'tickets.subject',
    )
    .orderBy('ticket_journal.created_at', 'desc')
    .limit(Math.min(limit, PAGINATION.maxLimit))) as Array<Record<string, unknown>>;
}

async function liveAlerts(
  actor: ConfigActor,
  limit: number,
  executor: Executor,
): Promise<Array<Record<string, unknown>>> {
  return (await scoped('suite_alerts', actor.tenantId, executor)
    .whereNull('suite_alerts.cleared_at')
    .select(
      'suite_alerts.id', 'suite_alerts.source_app', 'suite_alerts.severity',
      'suite_alerts.title', 'suite_alerts.dedupe_key', 'suite_alerts.occurrence_count',
      'suite_alerts.first_seen_at', 'suite_alerts.last_seen_at', 'suite_alerts.ticket_id',
    )
    .orderBy('suite_alerts.last_seen_at', 'desc')
    .limit(Math.min(limit, PAGINATION.maxLimit))) as Array<Record<string, unknown>>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Template → instance
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Instantiate a shipped `config_objects` dashboard into the live tables.
 *
 * Idempotent by slug: running it twice does not duplicate the board. It
 * REPLACES the widgets of the dashboard it creates, so re-materialising after
 * a baseline upgrade picks up new widgets — which is why an admin who has
 * rearranged their copy should clone it first, and why this is an explicit
 * action rather than something that happens on boot.
 */
export async function materializeFromConfig(
  actor: ConfigActor,
  configSlug: string,
): Promise<DashboardRecord> {
  const published = await loadPublished(actor.tenantId, 'dashboard');
  const template = published.get(configSlug.toLowerCase());
  if (!template) {
    throw new ConfigServiceError(404, `No published dashboard config object with the slug "${configSlug}".`, 'not_found');
  }

  const body = template.body;
  const rawWidgets = Array.isArray(body.widgets) ? body.widgets : [];
  const isDefault = body.is_default === true || body.isDefault === true;

  return db.transaction(async (trx) => {
    let dashboardId: number;

    const existing = (await scoped('dashboards', actor.tenantId, trx)
      .select('id')
      .where('dashboards.slug', configSlug)
      .first()) as { id: number } | undefined;

    if (existing) {
      dashboardId = Number(existing.id);
      await scoped('dashboard_widgets', actor.tenantId, trx)
        .where('dashboard_widgets.dashboard_id', dashboardId)
        .delete();
    } else {
      if (isDefault) await clearDefault(actor, trx);
      const [row] = (await insertScoped('dashboards', actor.tenantId, {
        slug: configSlug,
        name: template.name,
        owner_id: null,
        is_shared: body.is_shared !== false,
        is_default: isDefault,
        layout: JSON.stringify({
          grid: body.grid ?? { columns: 12, row_height: 80 },
          tabs: body.tabs ?? [],
        }),
      }, trx).returning('id')) as Array<{ id: number }>;
      dashboardId = Number(row.id);
    }

    for (const [index, raw] of rawWidgets.entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const widget = raw as Record<string, unknown>;
      const widgetType = String(widget.widget_type ?? widget.widgetType ?? 'text');
      const config = parseJson(widget.config);

      // A template widget that will not resolve is skipped rather than stored:
      // materialising a broken board is how a shipped dashboard teaches a new
      // tenant that dashboards do not work.
      try {
        assertWidgetConfig(widgetType, config);
      } catch {
        continue;
      }

      await insertScoped('dashboard_widgets', actor.tenantId, {
        dashboard_id: dashboardId,
        tab_key: String(widget.tab_key ?? widget.tabKey ?? 'overview'),
        widget_type: widgetType,
        title: titleOf(widget.title),
        x: clampGrid(Number(widget.x ?? 0), 0, 11),
        y: Math.max(Number(widget.y ?? 0) || 0, 0),
        w: clampGrid(Number(widget.w ?? 3), 1, 12),
        h: Math.max(Number(widget.h ?? 2) || 2, 1),
        config: JSON.stringify(config),
        sort_order: Number(widget.sort_order ?? widget.sortOrder ?? (index + 1) * 10) || (index + 1) * 10,
      }, trx);
    }

    await writeAudit(trx, actor, {
      action: 'dashboard.materialize',
      entityType: 'dashboard',
      entityId: configSlug,
      before: null,
      after: { fromConfigSlug: configSlug, widgets: rawWidgets.length },
    });

    const row = (await scoped('dashboards', actor.tenantId, trx)
      .select('*')
      .where('dashboards.id', dashboardId)
      .first()) as Record<string, unknown>;
    return rowToDashboard(row);
  });
}

/** Titles in the baseline are `{ en, fr }` maps; in the tables they are text. */
function titleOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const map = value as Record<string, unknown>;
    for (const locale of ['en', 'fr']) {
      if (typeof map[locale] === 'string') return map[locale] as string;
    }
  }
  return null;
}
