/**
 * config.api.ts — the configuration store, mounted at `/api/config-objects`.
 *
 * Everything configurable in the desk — fields, forms, views, rules, SLA
 * policies, state machines, queues, the priority matrix — is a row in
 * `config_objects` with a `kind`, a human `slug` and a versioned `body`. Three
 * consequences shape this module:
 *
 *   • The identity is `(kind, slug)`, never a numeric id (HARD RULE 3). Every
 *     path here is `/:kind/:slug`, and every cross-reference inside a body is a
 *     slug too, so an export from one tenant imports into another unchanged.
 *   • `body_format_version` travels with the body (HARD RULE 4). The catalog
 *     endpoint says which version this server writes per kind.
 *   • Publishing runs the linter first. A blocking finding comes back as a 422
 *     with `issues[]` — that is not a failure to retry, it is the answer.
 */

import apiClient, { toApiError, toQuery, unwrap, type Envelope } from './client';
import type {
  AnyConfigBody,
  ConfigBundle,
  ConfigKind,
  ConfigLintIssue,
  ConfigObject,
  ConfigObjectVersion,
  ConfigStatus,
  CreateConfigObjectRequest,
  UpdateConfigObjectRequest,
} from '@oblidesk/shared';

// ═════════════════════════════════════════════════════════════════════════════
// Shapes the routes return that are not in @oblidesk/shared
// ═════════════════════════════════════════════════════════════════════════════

export interface ConfigCatalog {
  kinds: Array<{
    kind: ConfigKind;
    bodyFormatVersion: number;
    /** Kinds this one may reference — drives the "used by" graph. */
    references: readonly ConfigKind[];
  }>;
}

export interface LintReport {
  findings: ConfigLintIssue[];
  summary: { error: number; warning: number; info: number };
}

export interface ConfigListParams {
  kind?: ConfigKind | ConfigKind[];
  status?: ConfigStatus | ConfigStatus[];
  q?: string;
  isSystem?: boolean;
  /** Include objects the master tenant pushed to this one. */
  includeShared?: boolean;
  page?: number;
  limit?: number;
}

export interface ConfigList {
  objects: ConfigObject[];
  total: number;
  page: number;
  limit: number;
}

interface ConfigListEnvelope extends Envelope<ConfigObject[]> {
  total?: number;
  page?: number;
  limit?: number;
}

/** One row of the three-column import diff: shipped · current · incoming. */
export interface BundlePlanEntry {
  kind: ConfigKind;
  slug: string;
  action: 'create' | 'update' | 'unchanged' | 'skip' | 'conflict';
  reason: string | null;
  current: AnyConfigBody | null;
  incoming: AnyConfigBody | null;
}

export interface BundleImportPlan {
  entries: BundlePlanEntry[];
  summary: { create: number; update: number; unchanged: number; skip: number; conflict: number };
  blocking: ConfigLintIssue[];
}

export interface BundleApplyResult {
  created: number;
  updated: number;
  skipped: number;
}

/** How far this object has drifted from the shipped baseline. */
export interface ConfigDrift {
  kind: ConfigKind;
  slug: string;
  modified: boolean;
  checksum: string;
  baselineChecksum: string | null;
  diff: Array<{ path: string; from: unknown; to: unknown }>;
}

// ═════════════════════════════════════════════════════════════════════════════
// API
// ═════════════════════════════════════════════════════════════════════════════

const BASE = '/config-objects';

export const configApi = {
  /** Kinds, the body format version each is written at, and the reference map. */
  async catalog(): Promise<ConfigCatalog> {
    try {
      const res = await apiClient.get<Envelope<ConfigCatalog>>(`${BASE}/catalog`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Every finding across the tenant — the config health panel. */
  async lintTenant(): Promise<LintReport> {
    try {
      const res = await apiClient.get<Envelope<LintReport>>(`${BASE}/lint`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async list(params: ConfigListParams = {}): Promise<ConfigList> {
    try {
      const res = await apiClient.get<ConfigListEnvelope>(BASE, { params: toQuery({ ...params }) });
      const objects = unwrap<ConfigObject[]>(res.data) ?? [];
      return {
        objects,
        total: res.data.total ?? objects.length,
        page: res.data.page ?? 1,
        limit: res.data.limit ?? objects.length,
      };
    } catch (error) {
      throw toApiError(error);
    }
  },

  async listKind(kind: ConfigKind, params: Omit<ConfigListParams, 'kind'> = {}): Promise<ConfigList> {
    try {
      const res = await apiClient.get<ConfigListEnvelope>(`${BASE}/${kind}`, { params: toQuery({ ...params }) });
      const objects = unwrap<ConfigObject[]>(res.data) ?? [];
      return {
        objects,
        total: res.data.total ?? objects.length,
        page: res.data.page ?? 1,
        limit: res.data.limit ?? objects.length,
      };
    } catch (error) {
      throw toApiError(error);
    }
  },

  async get<K extends ConfigKind>(kind: K, slug: string): Promise<ConfigObject<K>> {
    try {
      const res = await apiClient.get<Envelope<ConfigObject<K>>>(`${BASE}/${kind}/${slug}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async create<K extends ConfigKind>(payload: CreateConfigObjectRequest<K>): Promise<ConfigObject<K>> {
    try {
      const res = await apiClient.post<Envelope<ConfigObject<K>>>(BASE, payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** `baseVersion` is the optimistic-concurrency guard on the config store. */
  async update<K extends ConfigKind>(
    kind: K,
    slug: string,
    payload: UpdateConfigObjectRequest<K>,
  ): Promise<ConfigObject<K>> {
    try {
      const res = await apiClient.patch<Envelope<ConfigObject<K>>>(`${BASE}/${kind}/${slug}`, payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async remove(kind: ConfigKind, slug: string): Promise<void> {
    try {
      await apiClient.delete(`${BASE}/${kind}/${slug}`);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Publish. A blocking lint finding answers 422 with `issues[]` in the error
   * payload — surface them, do not retry. Publishing also invalidates the
   * engines' caches server-side, so the next ticket sees the new definition.
   */
  async publish<K extends ConfigKind>(kind: K, slug: string, note?: string): Promise<ConfigObject<K>> {
    try {
      const res = await apiClient.post<Envelope<ConfigObject<K>>>(`${BASE}/${kind}/${slug}/publish`, { note });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async archive<K extends ConfigKind>(kind: K, slug: string): Promise<ConfigObject<K>> {
    try {
      const res = await apiClient.post<Envelope<ConfigObject<K>>>(`${BASE}/${kind}/${slug}/archive`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async restore<K extends ConfigKind>(kind: K, slug: string): Promise<ConfigObject<K>> {
    try {
      const res = await apiClient.post<Envelope<ConfigObject<K>>>(`${BASE}/${kind}/${slug}/restore`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Roll the body back to an earlier version. Writes a new version row. */
  async revert<K extends ConfigKind>(kind: K, slug: string, version: number, note?: string): Promise<ConfigObject<K>> {
    try {
      const res = await apiClient.post<Envelope<ConfigObject<K>>>(`${BASE}/${kind}/${slug}/revert`, {
        version,
        note,
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async versions(kind: ConfigKind, slug: string): Promise<ConfigObjectVersion[]> {
    const res = await apiClient.get<Envelope<ConfigObjectVersion[]>>(`${BASE}/${kind}/${slug}/versions`);
    return unwrap(res.data) ?? [];
  },

  async version(kind: ConfigKind, slug: string, version: number): Promise<ConfigObjectVersion> {
    try {
      const res = await apiClient.get<Envelope<ConfigObjectVersion>>(`${BASE}/${kind}/${slug}/versions/${version}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async lint(kind: ConfigKind, slug: string): Promise<LintReport> {
    try {
      const res = await apiClient.get<Envelope<LintReport>>(`${BASE}/${kind}/${slug}/lint`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async drift(kind: ConfigKind, slug: string): Promise<ConfigDrift> {
    try {
      const res = await apiClient.get<Envelope<ConfigDrift>>(`${BASE}/${kind}/${slug}/drift`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Bundles ───────────────────────────────────────────────────────────────

  async exportBundle(): Promise<ConfigBundle> {
    try {
      const res = await apiClient.get<Envelope<ConfigBundle>>(`${BASE}/bundle`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Pass 1: the diff, computed but not written. Always run before `apply`. */
  async planImport(bundle: ConfigBundle): Promise<BundleImportPlan> {
    try {
      const res = await apiClient.post<Envelope<BundleImportPlan>>(`${BASE}/bundle/plan`, { bundle });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Pass 2: one transaction. Either the whole bundle lands or none of it does. */
  async applyImport(bundle: ConfigBundle, options: { overwrite?: boolean } = {}): Promise<BundleApplyResult> {
    try {
      const res = await apiClient.post<Envelope<BundleApplyResult>>(`${BASE}/bundle/apply`, {
        bundle,
        ...options,
      });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async planReset(): Promise<BundleImportPlan> {
    try {
      const res = await apiClient.get<Envelope<BundleImportPlan>>(`${BASE}/bundle/reset/plan`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Back to the shipped baseline. Destructive — always show the plan first. */
  async reset(): Promise<BundleApplyResult> {
    try {
      const res = await apiClient.post<Envelope<BundleApplyResult>>(`${BASE}/bundle/reset`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },
};

export default configApi;
