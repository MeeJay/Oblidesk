/**
 * views.api.ts — saved views: the sidebar, its badges, and the rows behind one.
 *
 * A saved view is a config object (`kind: 'view'`), so authoring it goes
 * through the config store and it is checksummed, versioned and linted like
 * everything else. What lives here is the READ side plus the thin authoring
 * wrappers the sidebar needs.
 *
 * `warnings` rides along with the rows deliberately. When a predicate could not
 * be compiled the list is NARROWER than its author intended, and the UI has to
 * be able to say so — a quietly narrowed view is noticed only once something
 * has already been missed.
 */

import apiClient, { toApiError, toQuery, unwrap, type Envelope } from './client';
import type { ConditionNode, TicketWithRelations } from '@oblidesk/shared';

export interface ViewColumn {
  key: string;
  label?: string;
  width?: number;
}

export interface ViewSort {
  key: string;
  dir: 'asc' | 'desc';
}

/** The resolved view, as `view.service` hands it to the client. */
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

export interface ViewCount {
  viewSlug: string;
  count: number;
  /** True when `count` is the threshold and the real number is higher. */
  approximate: boolean;
  estimate: number | null;
  computedAt: string;
  warnings: string[];
}

export interface ViewTicketPage {
  rows: TicketWithRelations[];
  page: number;
  limit: number;
  total: number;
  warnings: string[];
}

interface ViewTicketEnvelope extends Envelope<TicketWithRelations[]> {
  page?: number;
  limit?: number;
  total?: number;
  warnings?: string[];
}

/** One column of a board, or one bar of an "open by …" chart. */
export interface ViewGroupCount {
  key: string;
  label: string;
  count: number;
}

export interface CreateViewRequest {
  slug: string;
  name: string;
  description?: string | null;
  filter?: ConditionNode | null;
  columns?: ViewColumn[];
  sort?: ViewSort[];
  groupBy?: string | null;
  pageSize?: number;
  showCount?: boolean;
  icon?: string | null;
  layout?: 'table' | 'board' | 'split';
  refreshSeconds?: number | null;
  visibleToCapabilities?: string[];
  sortOrder?: number;
  shared?: boolean;
}

export type UpdateViewRequest = Partial<Omit<CreateViewRequest, 'slug'>>;

export const viewsApi = {
  async list(): Promise<ViewDefinition[]> {
    try {
      const res = await apiClient.get<Envelope<ViewDefinition[]>>('/views');
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Every badge in ONE call. A dozen concurrent counts against a pool of ten
   * connections is how the sidebar starves the page it decorates; the server
   * computes them sequentially and serves cached values inside the debounce.
   */
  async counts(force = false): Promise<ViewCount[]> {
    try {
      const res = await apiClient.get<Envelope<ViewCount[]>>('/views/counts', {
        params: toQuery({ force: force || undefined }),
      });
      return unwrap(res.data) ?? [];
    } catch {
      // Badges are decoration. Losing them must not blank the sidebar.
      return [];
    }
  },

  async get(slug: string): Promise<ViewDefinition> {
    try {
      const res = await apiClient.get<Envelope<ViewDefinition>>(`/views/${slug}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async tickets(slug: string, params: { page?: number; limit?: number } = {}): Promise<ViewTicketPage> {
    try {
      const res = await apiClient.get<ViewTicketEnvelope>(`/views/${slug}/tickets`, {
        params: toQuery({ ...params }),
      });
      const rows = unwrap<TicketWithRelations[]>(res.data) ?? [];
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

  async count(slug: string, force = false): Promise<ViewCount> {
    try {
      const res = await apiClient.get<Envelope<ViewCount>>(`/views/${slug}/count`, {
        params: toQuery({ force: force || undefined }),
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async groups(slug: string, groupBy: string, limit?: number): Promise<ViewGroupCount[]> {
    try {
      const res = await apiClient.get<Envelope<ViewGroupCount[]>>(`/views/${slug}/groups`, {
        params: toQuery({ groupBy, limit }),
      });
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  async create(payload: CreateViewRequest): Promise<ViewDefinition> {
    try {
      const res = await apiClient.post<Envelope<ViewDefinition>>('/views', payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async update(slug: string, payload: UpdateViewRequest): Promise<ViewDefinition> {
    try {
      const res = await apiClient.patch<Envelope<ViewDefinition>>(`/views/${slug}`, payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Archives the config object rather than deleting it — history survives. */
  async remove(slug: string): Promise<void> {
    try {
      await apiClient.delete(`/views/${slug}`);
    } catch (error) {
      throw toApiError(error);
    }
  },
};

export default viewsApi;
