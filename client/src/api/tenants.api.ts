/**
 * tenants.api.ts — the tenant selector and tenant administration.
 *
 * Two audiences, one router. `mine()` needs only a session and answers "which
 * tenants may I act in?"; everything else is platform admin and crosses tenant
 * boundaries by design.
 *
 * HARD RULE 13 — the cross-app identity is the SLUG. Each Obli* app owns its
 * own `tenants` table with its own sequence, so id 4 here and id 4 in Obliguard
 * are unrelated rows. Anything that leaves this app (an SSO handoff, an alert
 * payload, a CI projection) travels by slug; the numeric id is local only.
 */

import apiClient, { setTenantOverride, toApiError, unwrap, type Envelope } from './client';
import type {
  CreateTenantRequest,
  Tenant,
  TenantMembership,
  UpdateTenantRequest,
  User,
  UserRole,
} from '@oblidesk/shared';

export interface TenantStats {
  users: number;
  openTickets: number;
  ticketsLast30Days: number;
  breachedSlaLast30Days: number;
  storageBytes: number;
}

export interface TenantMemberRow {
  user: User;
  role: UserRole;
  capabilities: string[];
}

export const tenantsApi = {
  /** The tenants this user may switch to, with the rights they hold in each. */
  async mine(): Promise<TenantMembership[]> {
    try {
      const res = await apiClient.get<Envelope<TenantMembership[]>>('/tenants/mine');
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Every tenant on the installation. Platform admin. */
  async list(): Promise<Tenant[]> {
    try {
      const res = await apiClient.get<Envelope<Tenant[]>>('/tenants');
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  async get(id: number): Promise<Tenant> {
    try {
      const res = await apiClient.get<Envelope<Tenant>>(`/tenants/${id}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async getBySlug(slug: string): Promise<Tenant> {
    try {
      const res = await apiClient.get<Envelope<Tenant>>(`/tenants/by-slug/${slug}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async stats(id: number): Promise<TenantStats> {
    try {
      const res = await apiClient.get<Envelope<TenantStats>>(`/tenants/${id}/stats`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async members(id: number): Promise<TenantMemberRow[]> {
    const res = await apiClient.get<Envelope<TenantMemberRow[]>>(`/tenants/${id}/members`);
    return unwrap(res.data) ?? [];
  },

  async create(payload: CreateTenantRequest): Promise<Tenant> {
    try {
      const res = await apiClient.post<Envelope<Tenant>>('/tenants', payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async update(id: number, payload: UpdateTenantRequest): Promise<Tenant> {
    try {
      const res = await apiClient.put<Envelope<Tenant>>(`/tenants/${id}`, payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async remove(id: number): Promise<void> {
    try {
      await apiClient.delete(`/tenants/${id}`);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Move the SESSION onto another tenant.
   *
   * The session-side switch is the correct mechanism — it survives a reload and
   * a socket reconnect, and it is the one `requireTenant` reads first. Until
   * that endpoint exists this returns `false` rather than pretending, and the
   * caller decides whether the per-request `X-Tenant-Id` override is a legal
   * fallback for THIS viewer (it is honoured for platform admins only; sending
   * it as anyone else answers 403 on every subsequent call).
   */
  async trySwitch(tenantId: number): Promise<boolean> {
    try {
      await apiClient.post('/tenant/switch', { tenantId });
      // The session now owns the choice — the header would only shadow it.
      setTenantOverride(null);
      return true;
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.isNotFound || apiError.status === 405) return false;
      throw apiError;
    }
  },
};

export default tenantsApi;
