/**
 * metrics.api.ts — the client half of the metric registry, and the dashboard
 * endpoints the board editor drives.
 *
 * ── Why this file is shaped like the server's registry ───────────────────────
 * `server/src/services/metric.service.ts` is a CLOSED catalogue. The client may
 * name a registered metric key, one dimension that metric declares, one range
 * it offers, a granularity, and a published saved-view slug. That is the entire
 * vocabulary — there is no filter object, no column list, no sort expression,
 * no `having`. A reporting API that accepts a query fragment accepts SQL by a
 * slower route, and the only reason that boundary holds is that BOTH sides are
 * generated from the same declarations.
 *
 * So the types below are a faithful mirror of the server's, not a convenient
 * approximation of them, and every picker in the dashboard editor is built from
 * {@link metricsApi.catalog}. An invalid combination is UNPICKABLE rather than
 * rejected after the fact. If you are tempted to add a `filter` or a `sortBy`
 * that reaches the server here, add a metric to the registry instead.
 *
 * ── Why the dashboard calls live here and not only in dashboard.api.ts ──────
 * `client/src/api/dashboard.api.ts` predates the server routes and disagrees
 * with them on the wire in two places that matter to a board editor:
 *
 *   • `POST /dashboards/:slug/layout` — the route parses `layoutSchema`, which
 *     requires `{ positions: [...] }`. dashboard.api.ts posts `{ layout }`, so
 *     every drag-and-drop save 400s.
 *   • `GET /dashboards/:slug/resolve` — the route returns
 *     `{ dashboard, widgets }`. dashboard.api.ts types it as a flat `Dashboard`
 *     with a `widgets` array of a different shape, so nothing on a resolved
 *     board type-checks against what actually arrives.
 *
 * Its `MetricResolution` is likewise a different shape from the server's
 * (`value`/`groups`/`series` vs `points`/`total`/`drill`). Rather than edit a
 * module this work does not own, the endpoints the editor needs are declared
 * here against the real routes. The two should be collapsed once ownership
 * allows — see the note in the handover.
 */

import apiClient, { toApiError, toQuery, unwrap, type Envelope } from './client';
import type { StatusCategory, TicketRecordType, TicketSource } from '@oblidesk/shared';

/**
 * A ticket row as the REPORTING endpoints return it — snake_case, straight off
 * the column names.
 *
 * This is not `TicketWithRelations` and must not be typed as one. `metricRecords`
 * selects `tickets.number, tickets.status_slug, …` and `listViewTickets` selects
 * `tickets.*`; knex is configured with no `postProcessResponse`, so nothing
 * camel-cases them on the way out. Typing these rows as the camelCase DTO would
 * compile perfectly and render a column of blank cells, which is the worst
 * possible failure for a drill-through whose entire job is to prove the number.
 */
export interface DashboardTicketRow {
  id: number;
  number: string;
  subject: string;
  record_type?: string;
  status_slug: string;
  status_category: string;
  priority_slug: string;
  queue_slug?: string;
  assignee_id?: number | null;
  assignment_group_id?: number | null;
  organization_id?: number | null;
  /** HARD RULE 6 — when it HAPPENED, distinct from `created_at`. */
  occurred_at?: string;
  created_at?: string;
  updated_at?: string;
  due_at?: string | null;
  resolved_at?: string | null;
  reopen_count?: number;
  row_version?: number;
  [column: string]: unknown;
}

// ═════════════════════════════════════════════════════════════════════════════
// The vocabulary — mirrors metric.service.ts exactly
// ═════════════════════════════════════════════════════════════════════════════

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

export const METRIC_GRANULARITIES = ['day', 'week', 'month'] as const;
export type MetricGranularity = (typeof METRIC_GRANULARITIES)[number];

export type MetricUnit = 'count' | 'percent' | 'minutes' | 'days' | 'score' | 'ratio';
export type MetricAggregation = 'count' | 'sum' | 'avg' | 'median' | 'ratio';

/**
 * Label metadata as DATA rather than as `t()` calls, following the pattern of
 * `CONFIG_KIND_LABELS` in `@oblidesk/shared`: this module must not import
 * i18next (an api module at the bottom of the graph pulling in a React
 * provider is how you get an import cycle), so it ships the key and the inline
 * French fallback and the component does `t(entry.key, entry.fallback)`.
 * HARD RULE 10 is satisfied at the call site, with a real French sentence.
 */
export interface LabelSpec {
  key: string;
  fallback: string;
}

export const METRIC_DIMENSION_LABELS: Readonly<Record<MetricDimension, LabelSpec>> = {
  queue_slug: { key: 'metricDimension.queueSlug', fallback: 'File' },
  priority_slug: { key: 'metricDimension.prioritySlug', fallback: 'Priorité' },
  assignee_id: { key: 'metricDimension.assigneeId', fallback: 'Assigné à' },
  assignment_group_id: { key: 'metricDimension.assignmentGroupId', fallback: "Groupe d'assignation" },
  organization_id: { key: 'metricDimension.organizationId', fallback: 'Organisation' },
  record_type: { key: 'metricDimension.recordType', fallback: 'Type d’enregistrement' },
  source: { key: 'metricDimension.source', fallback: 'Canal d’arrivée' },
  status_slug: { key: 'metricDimension.statusSlug', fallback: 'Statut' },
  status_category: { key: 'metricDimension.statusCategory', fallback: 'Catégorie de statut' },
  resolution_code: { key: 'metricDimension.resolutionCode', fallback: 'Code de résolution' },
  impact: { key: 'metricDimension.impact', fallback: 'Impact' },
  urgency: { key: 'metricDimension.urgency', fallback: 'Urgence' },
  sla_target_slug: { key: 'metricDimension.slaTargetSlug', fallback: 'Cible SLA' },
  source_app: { key: 'metricDimension.sourceApp', fallback: 'Application source' },
  severity: { key: 'metricDimension.severity', fallback: 'Sévérité' },
  user_id: { key: 'metricDimension.userId', fallback: 'Utilisateur' },
  rate_card_slug: { key: 'metricDimension.rateCardSlug', fallback: 'Grille tarifaire' },
};

export const METRIC_RANGE_LABELS: Readonly<Record<MetricRangeKey, LabelSpec>> = {
  today: { key: 'metricRange.today', fallback: 'Aujourd’hui' },
  yesterday: { key: 'metricRange.yesterday', fallback: 'Hier' },
  last_7_days: { key: 'metricRange.last7Days', fallback: '7 derniers jours' },
  last_30_days: { key: 'metricRange.last30Days', fallback: '30 derniers jours' },
  last_90_days: { key: 'metricRange.last90Days', fallback: '90 derniers jours' },
  this_week: { key: 'metricRange.thisWeek', fallback: 'Cette semaine' },
  this_month: { key: 'metricRange.thisMonth', fallback: 'Ce mois-ci' },
  qtd: { key: 'metricRange.qtd', fallback: 'Trimestre en cours' },
  ytd: { key: 'metricRange.ytd', fallback: 'Année en cours' },
  last_12_months: { key: 'metricRange.last12Months', fallback: '12 derniers mois' },
  all_time: { key: 'metricRange.allTime', fallback: 'Depuis toujours' },
  custom: { key: 'metricRange.custom', fallback: 'Personnalisé' },
};

export const METRIC_GRANULARITY_LABELS: Readonly<Record<MetricGranularity, LabelSpec>> = {
  day: { key: 'metricGranularity.day', fallback: 'Par jour' },
  week: { key: 'metricGranularity.week', fallback: 'Par semaine' },
  month: { key: 'metricGranularity.month', fallback: 'Par mois' },
};

/**
 * The closed scope vocabulary. Each key is accepted by the server only when the
 * chosen metric DECLARES the matching dimension — `applyScope` throws
 * otherwise. The editor therefore only offers a filter row for a dimension the
 * selected metric declares.
 */
export interface MetricScope {
  queueSlug?: string;
  prioritySlug?: string;
  assigneeId?: number;
  assignmentGroupId?: number;
  organizationId?: number;
  recordType?: TicketRecordType;
  source?: TicketSource;
  statusCategory?: StatusCategory;
}

/** Which scope key narrows which declared dimension. Mirrors SCOPE_TO_DIMENSION. */
export const SCOPE_KEY_FOR_DIMENSION: Readonly<Partial<Record<MetricDimension, keyof MetricScope>>> = {
  queue_slug: 'queueSlug',
  priority_slug: 'prioritySlug',
  assignee_id: 'assigneeId',
  assignment_group_id: 'assignmentGroupId',
  organization_id: 'organizationId',
  record_type: 'recordType',
  source: 'source',
  status_category: 'statusCategory',
};

// ═════════════════════════════════════════════════════════════════════════════
// Catalogue
// ═════════════════════════════════════════════════════════════════════════════

/** One entry of `GET /api/metrics/catalog` — the picker's whole source of truth. */
export interface MetricCatalogEntry {
  key: string;
  /** English fallback shipped by the registry. */
  label: string;
  /** What `t()` receives — the registry declares it (HARD RULE 10). */
  labelKey: string;
  description: string;
  unit: MetricUnit;
  aggregation: MetricAggregation;
  /** null when neither direction is "good" — a raw volume. */
  higherIsBetter: boolean | null;
  /** The ONLY group-by axes this metric may be asked for. */
  dimensions: MetricDimension[];
  /** The ONLY windows this metric offers. */
  ranges: MetricRangeKey[];
  /** Set on the `tickets_by_*` family: the axis is pinned and unpickable. */
  forcedGroupBy: MetricDimension | null;
  supportsSeries: boolean;
  /**
   * 'live'   — the metric has a timestamp to bucket on.
   * 'rollup' — a point-in-time number whose history only exists because the
   *            nightly rollup wrote it down. Asking for a window returns the
   *            rollup, and returns NOTHING until the first run — which is why
   *            an empty snapshot series must render as "no history yet" and
   *            never as a zero.
   */
  seriesSource: 'live' | 'rollup';
}

export interface MetricCatalogResponse {
  metrics: MetricCatalogEntry[];
  /** Whether the nightly rollup worker is running on this server. */
  rollupRunning: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Resolution
// ═════════════════════════════════════════════════════════════════════════════

/** Everything a caller may say. There is deliberately nothing else. */
export interface MetricQuery extends MetricScope {
  key: string;
  range?: MetricRangeKey;
  /** ISO-8601 with offset. Only meaningful with `range: 'custom'`. */
  from?: string;
  to?: string;
  groupBy?: MetricDimension | null;
  granularity?: MetricGranularity | null;
  /** A published saved-view SLUG — configuration, never a filter tree. */
  viewSlug?: string | null;
  limit?: number;
}

export interface MetricSeriesPoint {
  /** 'YYYY-MM-DD' when a granularity was asked for, else null. */
  bucket: string | null;
  /** The group value when grouped, else null. `null` is itself a group. */
  group: string | null;
  value: number | null;
}

/** Everything a click on a number needs to fetch the records behind it. */
export interface MetricDrill {
  metric: string;
  range: MetricRangeKey;
  from?: string;
  to?: string;
  groupBy: MetricDimension | null;
  viewSlug: string | null;
  scope: MetricScope;
}

export interface MetricResolution {
  key: string;
  label: string;
  labelKey: string;
  unit: MetricUnit;
  aggregation: MetricAggregation;
  higherIsBetter: boolean | null;
  range: MetricRangeKey;
  groupBy: MetricDimension | null;
  granularity: MetricGranularity | null;
  points: MetricSeriesPoint[];
  /**
   * The headline number, or null when a grouped result has no honest single
   * total — averaging per-queue attainment gives a small queue the same weight
   * as a large one. Null means "show the breakdown", never "show 0".
   */
  total: number | null;
  drill: MetricDrill;
  warnings: string[];
}

export interface MetricDelta {
  current: number | null;
  previous: number | null;
  change: number | null;
  /** Null when the previous value was 0 or unknown — never a fabricated 0%. */
  changePercent: number | null;
  direction: 'up' | 'down' | 'flat' | 'unknown';
  /** True when the direction is the GOOD one for this metric. */
  improved: boolean | null;
}

export interface MetricRecordsPage {
  rows: DashboardTicketRow[];
  page: number;
  limit: number;
  total: number;
  warnings: string[];
}

/** One entry of the batch endpoint — failures are per query, not per request. */
export type BatchMetricResult =
  | { ok: true; result: MetricResolution }
  | { ok: false; error: string };

interface RecordsEnvelope extends Envelope<DashboardTicketRow[]> {
  page?: number;
  limit?: number;
  total?: number;
  warnings?: string[];
}

/**
 * The parameter names `metricQuerySchema` parses — as an ALLOW-LIST, not a
 * spread.
 *
 * A spread would forward whatever the caller happened to be holding, and the
 * day someone puts a `filter` on a widget config object it would ride along to
 * a reporting endpoint. Anything not on this list is dropped here, before the
 * request is built. Adding a name to it is a deliberate act that has to be
 * matched on the server.
 */
const WIRE_PARAMS = [
  'range', 'from', 'to', 'groupBy', 'granularity', 'viewSlug', 'limit',
  'queueSlug', 'prioritySlug', 'assigneeId', 'assignmentGroupId',
  'organizationId', 'recordType', 'source', 'statusCategory',
  // records / delta only
  'group', 'page', 'compareTo',
] as const;

function queryParams(query: object): Record<string, string> {
  const source = query as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const name of WIRE_PARAMS) {
    if (source[name] !== undefined) picked[name] = source[name];
  }
  return toQuery(picked);
}

/** Turn a server-issued drill descriptor back into a records query. */
export function drillToQuery(drill: MetricDrill): MetricQuery {
  return {
    key: drill.metric,
    range: drill.range,
    from: drill.from,
    to: drill.to,
    groupBy: drill.groupBy,
    viewSlug: drill.viewSlug,
    ...drill.scope,
  };
}

export const metricsApi = {
  /**
   * Every registered metric with its unit, aggregation, declared dimensions and
   * offered ranges. The metric picker, the group-by picker and the range picker
   * are all generated from this — which is what makes "the UI cannot offer an
   * invalid combination" true by construction rather than by review.
   */
  async catalog(): Promise<MetricCatalogResponse> {
    try {
      const res = await apiClient.get<Envelope<MetricCatalogResponse>>('/metrics/catalog');
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async resolve(query: MetricQuery): Promise<MetricResolution> {
    try {
      const { key, ...rest } = query;
      const res = await apiClient.get<Envelope<MetricResolution>>(
        `/metrics/${encodeURIComponent(key)}`,
        { params: queryParams(rest) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Several metrics in one round trip. The server resolves them SEQUENTIALLY —
   * six concurrent aggregates against a pool of ten is how a dashboard makes
   * the queue behind it feel broken — and returns one failure in place rather
   * than failing the batch.
   */
  async batch(queries: MetricQuery[]): Promise<BatchMetricResult[]> {
    try {
      const res = await apiClient.post<Envelope<BatchMetricResult[]>>('/metrics/batch', {
        queries: queries.slice(0, 24),
      });
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * The tickets behind the number — built from the SAME predicates as the
   * aggregate, inside the same registry definition, so the list can never
   * disagree with the KPI it was reached from.
   *
   * `group` narrows it to the one bar that was clicked.
   *
   * KNOWN GAP: the NULL group (unassigned tickets, tickets with no resolution
   * code) is not addressable. `metricRecordsQuerySchema` reads `group` off the
   * query string, where a real `null` cannot arrive, so `withGroupValue`'s
   * `IS NULL` branch is unreachable over HTTP. Callers must NOT pass a
   * sentinel like `'null'` — it would filter on the literal text and silently
   * return zero rows. Pass `undefined` and SAY that the list covers the whole
   * metric, which is what the drill drawer in `DashboardsPage` does.
   */
  async records(
    query: MetricQuery & { group?: string; page?: number; limit?: number },
  ): Promise<MetricRecordsPage> {
    try {
      const { key, ...rest } = query;
      const res = await apiClient.get<RecordsEnvelope>(
        `/metrics/${encodeURIComponent(key)}/records`,
        { params: queryParams(rest) },
      );
      const rows = unwrap<DashboardTicketRow[]>(res.data) ?? [];
      return {
        rows,
        page: res.data.page ?? 1,
        limit: res.data.limit ?? rows.length,
        total: res.data.total ?? rows.length,
        warnings: res.data.warnings ?? [],
      };
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * "vs hier" / "vs la semaine dernière" for a KPI tile.
   *
   * For a point-in-time metric the comparison is read out of
   * `metric_daily_rollup` — that table is the only place last Tuesday's open
   * count still exists. When it has not run yet the server answers
   * `direction: 'unknown'` with a null previous, and the tile must render that
   * as "pas d'historique", never as 0%.
   */
  async delta(
    query: MetricQuery & { compareTo?: 'yesterday' | 'last_week' },
  ): Promise<MetricDelta> {
    try {
      const { key, ...rest } = query;
      const res = await apiClient.get<Envelope<MetricDelta>>(
        `/metrics/${encodeURIComponent(key)}/delta`,
        { params: queryParams(rest) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Recompute the daily rollup now. Idempotent; gated on REPORT_ADMIN. */
  async runRollup(offsetDays = 1): Promise<{ days?: number; rows?: number } & Record<string, unknown>> {
    try {
      const res = await apiClient.post<Envelope<Record<string, unknown>>>('/metrics/rollup/run', {
        offsetDays,
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Dashboards — the shapes the routes actually return
// ═════════════════════════════════════════════════════════════════════════════

export interface DashboardRecord {
  id: number;
  tenantId: number;
  slug: string;
  name: string;
  ownerId: number | null;
  isShared: boolean;
  isDefault: boolean;
  /** `{ grid, tabs }`. The tab strip is persisted here (see DashboardsPage). */
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
  /** Null means "use the metric's own label" — not "untitled". */
  title: string | null;
  config: Record<string, unknown>;
  sortOrder: number;
}

/** What `resolveWidget` returns. `error` is per widget, never per board. */
export interface ResolvedWidget {
  widget: DashboardWidgetRecord;
  widgetType: string;
  kind: 'metric' | 'tickets' | 'activity' | 'text' | 'alerts';
  metric?: MetricResolution;
  delta?: MetricDelta;
  tickets?: DashboardTicketRow[];
  activity?: Array<Record<string, unknown>>;
  alerts?: Array<Record<string, unknown>>;
  view?: { slug: string; name: string } | null;
  /** Reference line on a chart, e.g. an SLA target of 95. */
  target: number | null;
  toneWhenAbove: { value: number; tone: string } | null;
  drillToView: string | null;
  warnings: string[];
  /** Set when THIS widget could not be resolved. Render an error card. */
  error: string | null;
}

export interface ResolvedDashboardPayload {
  dashboard: DashboardRecord;
  widgets: ResolvedWidget[];
}

export interface WidgetPosition {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  tabKey?: string;
  sortOrder?: number;
}

export interface CreateWidgetPayload {
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

export const dashboardsApi = {
  async list(): Promise<DashboardRecord[]> {
    try {
      const res = await apiClient.get<Envelope<DashboardRecord[]>>('/dashboards');
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** The board a user lands on. Null when the tenant has none yet. */
  async getDefault(): Promise<DashboardRecord | null> {
    try {
      const res = await apiClient.get<Envelope<DashboardRecord>>('/dashboards/default');
      return unwrap(res.data);
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.isNotFound) return null;
      throw apiError;
    }
  },

  /**
   * The board AND every widget's data, in one call. A twelve-widget board that
   * fetches twelve times opens twelve connections against a pool of ten and is
   * slower for it.
   */
  async resolve(slug: string): Promise<ResolvedDashboardPayload> {
    try {
      const res = await apiClient.get<Envelope<ResolvedDashboardPayload>>(
        `/dashboards/${encodeURIComponent(slug)}/resolve`,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async create(payload: {
    slug: string;
    name: string;
    isShared?: boolean;
    isDefault?: boolean;
    layout?: Record<string, unknown>;
  }): Promise<DashboardRecord> {
    try {
      const res = await apiClient.post<Envelope<DashboardRecord>>('/dashboards', payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Renaming a tab, adding a tab and reordering tabs all land here. */
  async update(
    slug: string,
    payload: { name?: string; isShared?: boolean; isDefault?: boolean; layout?: Record<string, unknown> },
  ): Promise<DashboardRecord> {
    try {
      const res = await apiClient.patch<Envelope<DashboardRecord>>(
        `/dashboards/${encodeURIComponent(slug)}`,
        payload,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async remove(slug: string): Promise<void> {
    try {
      await apiClient.delete(`/dashboards/${encodeURIComponent(slug)}`);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Instantiate a shipped `config_objects` dashboard. REPLACES its widgets. */
  async materialize(configSlug: string): Promise<DashboardRecord> {
    try {
      const res = await apiClient.post<Envelope<DashboardRecord>>('/dashboards/materialize', {
        configSlug,
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async createWidget(slug: string, payload: CreateWidgetPayload): Promise<DashboardWidgetRecord> {
    try {
      const res = await apiClient.post<Envelope<DashboardWidgetRecord>>(
        `/dashboards/${encodeURIComponent(slug)}/widgets`,
        payload,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async updateWidget(
    id: number,
    payload: Partial<CreateWidgetPayload>,
  ): Promise<DashboardWidgetRecord> {
    try {
      const res = await apiClient.patch<Envelope<DashboardWidgetRecord>>(
        `/dashboards/widgets/${id}`,
        payload,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async deleteWidget(id: number): Promise<void> {
    try {
      await apiClient.delete(`/dashboards/widgets/${id}`);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * One round trip for a whole drag session. POSITIONS ONLY — the route
   * refuses to touch `config`, so "I moved a box" can never become "I rewrote a
   * report". The body key is `positions`; the server's `layoutSchema` names it.
   */
  async saveLayout(slug: string, positions: WidgetPosition[]): Promise<DashboardWidgetRecord[]> {
    try {
      const res = await apiClient.post<Envelope<DashboardWidgetRecord[]>>(
        `/dashboards/${encodeURIComponent(slug)}/layout`,
        { positions },
      );
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** The drill-through of a SAVED widget, by widget id. */
  async widgetRecords(
    id: number,
    params: { group?: string; page?: number; limit?: number } = {},
  ): Promise<MetricRecordsPage> {
    try {
      const res = await apiClient.get<RecordsEnvelope>(`/dashboards/widgets/${id}/records`, {
        params: toQuery({ ...params }),
      });
      const rows = unwrap<DashboardTicketRow[]>(res.data) ?? [];
      return {
        rows,
        page: res.data.page ?? 1,
        limit: res.data.limit ?? rows.length,
        total: res.data.total ?? rows.length,
        warnings: res.data.warnings ?? [],
      };
    } catch (error) {
      throw toApiError(error);
    }
  },
};

export default metricsApi;
