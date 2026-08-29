/**
 * dashboard.api.ts — boards, their widgets, and the metrics behind the numbers.
 *
 * The drill-through is the point of the design: every widget's number is built
 * from a named metric in the server-side registry, and `/records` returns the
 * tickets behind that same number using the SAME predicates. A dashboard whose
 * tile says 42 and whose drill-through lists 39 rows is worse than no tile, so
 * the client never reimplements a metric — it asks for it and asks for its rows.
 */

import apiClient, { toApiError, toQuery, unwrap, type Envelope } from './client';
import type {
  CreateDashboardRequest,
  CreateDashboardWidgetRequest,
  Dashboard,
  DashboardWidget,
  TicketWithRelations,
  UpdateDashboardRequest,
  UpdateDashboardWidgetRequest,
} from '@oblidesk/shared';

// ═════════════════════════════════════════════════════════════════════════════
// Metrics
// ═════════════════════════════════════════════════════════════════════════════

export interface MetricDefinition {
  key: string;
  label: string;
  labelKey?: string;
  description?: string;
  unit?: 'count' | 'minutes' | 'percent' | 'currency';
  dimensions: string[];
  ranges: string[];
}

export interface MetricCatalog {
  metrics: MetricDefinition[];
  /** Whether the nightly rollup worker is running on this server. */
  rollupRunning: boolean;
}

export interface MetricRequestParams {
  key: string;
  range?: string;
  from?: string;
  to?: string;
  groupBy?: string;
  granularity?: 'day' | 'week' | 'month' | null;
  queueSlugs?: string[];
  prioritySlugs?: string[];
  assigneeIds?: number[];
}

export interface MetricResolution {
  key: string;
  label: string;
  unit: string;
  value: number;
  /** Present when `groupBy` was asked for. */
  groups?: Array<{ key: string; label: string; value: number }>;
  /** Present when a granularity was asked for. */
  series?: Array<{ day: string; value: number }>;
  from: string;
  to: string;
  approximate?: boolean;
}

export interface MetricDelta {
  current: number;
  previous: number;
  delta: number;
  deltaPercent: number | null;
  /** True when up is the good direction for this metric. */
  higherIsBetter: boolean;
}

export interface MetricRecordsPage {
  rows: TicketWithRelations[];
  page: number;
  limit: number;
  total: number;
}

interface RecordsEnvelope extends Envelope<TicketWithRelations[]> {
  page?: number;
  limit?: number;
  total?: number;
}

/** One entry of the batch endpoint — failures are per query, not per request. */
export type BatchMetricResult =
  | { ok: true; result: MetricResolution }
  | { ok: false; error: string };

// ═════════════════════════════════════════════════════════════════════════════
// Dashboards
// ═════════════════════════════════════════════════════════════════════════════

/** A board with its widgets already resolved to values. */
export interface ResolvedDashboard extends Dashboard {
  widgets: Array<DashboardWidget & { resolved?: MetricResolution | null; error?: string | null }>;
}

export const dashboardApi = {
  async list(): Promise<Dashboard[]> {
    try {
      const res = await apiClient.get<Envelope<Dashboard[]>>('/dashboards');
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** The board a user lands on. 404 when the tenant has none yet. */
  async getDefault(): Promise<Dashboard | null> {
    try {
      const res = await apiClient.get<Envelope<Dashboard>>('/dashboards/default');
      return unwrap(res.data);
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.isNotFound) return null;
      throw apiError;
    }
  },

  async get(slug: string): Promise<Dashboard> {
    try {
      const res = await apiClient.get<Envelope<Dashboard>>(`/dashboards/${slug}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** The board AND every widget's number, in one round trip. */
  async resolve(slug: string, params: { range?: string } = {}): Promise<ResolvedDashboard> {
    try {
      const res = await apiClient.get<Envelope<ResolvedDashboard>>(`/dashboards/${slug}/resolve`, {
        params: toQuery({ ...params }),
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async create(payload: CreateDashboardRequest): Promise<Dashboard> {
    try {
      const res = await apiClient.post<Envelope<Dashboard>>('/dashboards', payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async update(slug: string, payload: UpdateDashboardRequest): Promise<Dashboard> {
    try {
      const res = await apiClient.patch<Envelope<Dashboard>>(`/dashboards/${slug}`, payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async remove(slug: string): Promise<void> {
    try {
      await apiClient.delete(`/dashboards/${slug}`);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Instantiate a shipped `config_objects` dashboard into the live tables.
   * Explicit rather than automatic: it REPLACES the widgets of the board it
   * creates, so an admin who has rearranged theirs should clone first.
   */
  async materialize(configSlug: string): Promise<Dashboard> {
    try {
      const res = await apiClient.post<Envelope<Dashboard>>('/dashboards/materialize', { configSlug });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Widgets ───────────────────────────────────────────────────────────────

  async createWidget(slug: string, payload: CreateDashboardWidgetRequest): Promise<DashboardWidget> {
    try {
      const res = await apiClient.post<Envelope<DashboardWidget>>(`/dashboards/${slug}/widgets`, payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async updateWidget(id: number, payload: UpdateDashboardWidgetRequest): Promise<DashboardWidget> {
    try {
      const res = await apiClient.patch<Envelope<DashboardWidget>>(`/dashboards/widgets/${id}`, payload);
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

  /** Persist a drag-and-drop rearrangement in one write. */
  async saveLayout(
    slug: string,
    layout: Array<{ id: number; x: number; y: number; w: number; h: number; tabKey?: string }>,
  ): Promise<Dashboard> {
    try {
      const res = await apiClient.post<Envelope<Dashboard>>(`/dashboards/${slug}/layout`, { layout });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** The tickets behind a widget's number. `group` narrows it to one bar. */
  async widgetRecords(
    id: number,
    params: { group?: string; page?: number; limit?: number } = {},
  ): Promise<MetricRecordsPage> {
    try {
      const res = await apiClient.get<RecordsEnvelope>(`/dashboards/widgets/${id}/records`, {
        params: toQuery({ ...params }),
      });
      const rows = unwrap<TicketWithRelations[]>(res.data) ?? [];
      return {
        rows,
        page: res.data.page ?? 1,
        limit: res.data.limit ?? rows.length,
        total: res.data.total ?? rows.length,
      };
    } catch (error) {
      throw toApiError(error);
    }
  },
};

export const metricsApi = {
  async catalog(): Promise<MetricCatalog> {
    try {
      const res = await apiClient.get<Envelope<MetricCatalog>>('/metrics/catalog');
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async resolve(params: MetricRequestParams): Promise<MetricResolution> {
    try {
      const { key, ...rest } = params;
      const res = await apiClient.get<Envelope<MetricResolution>>(`/metrics/${key}`, {
        params: toQuery({ ...rest }),
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * A KPI row asks for all its tiles at once. The server resolves them
   * sequentially — six concurrent aggregates against the pool is how a
   * dashboard makes the queue behind it feel broken.
   */
  async batch(queries: MetricRequestParams[]): Promise<BatchMetricResult[]> {
    try {
      const res = await apiClient.post<Envelope<BatchMetricResult[]>>('/metrics/batch', {
        queries: queries.slice(0, 24),
      });
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  async records(
    key: string,
    params: Omit<MetricRequestParams, 'key'> & { group?: string; page?: number; limit?: number } = {},
  ): Promise<MetricRecordsPage> {
    try {
      const res = await apiClient.get<RecordsEnvelope>(`/metrics/${key}/records`, {
        params: toQuery({ ...params }),
      });
      const rows = unwrap<TicketWithRelations[]>(res.data) ?? [];
      return {
        rows,
        page: res.data.page ?? 1,
        limit: res.data.limit ?? rows.length,
        total: res.data.total ?? rows.length,
      };
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** This period against the last — the arrow next to a KPI. */
  async delta(key: string, params: Omit<MetricRequestParams, 'key'> & { compareTo?: string } = {}): Promise<MetricDelta> {
    try {
      const res = await apiClient.get<Envelope<MetricDelta>>(`/metrics/${key}/delta`, {
        params: toQuery({ ...params }),
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Re-run the daily rollup. Admin escape hatch after a backfill. */
  async runRollup(offsetDays = 1): Promise<{ days: number; rows: number }> {
    try {
      const res = await apiClient.post<Envelope<{ days: number; rows: number }>>('/metrics/rollup/run', {
        offsetDays,
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },
};

export default dashboardApi;
