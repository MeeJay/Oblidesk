/**
 * users.api.ts — accounts, teams and permission sets, inside the active tenant.
 *
 * Note the two scopes and keep them apart at every call site: `list()` returns
 * the MEMBERS OF THIS TENANT, `listAll()` returns every account on the
 * installation and is platform-admin only. They look interchangeable and are
 * not — rendering the second where the first belongs leaks the customer list of
 * every other tenant.
 */

import apiClient, { toApiError, toQuery, unwrap, type Envelope } from './client';
import type {
  Capability,
  CreatePermissionSetRequest,
  CreateTeamRequest,
  CreateUserRequest,
  PermissionSet,
  Team,
  TenantMembership,
  UpdatePermissionSetRequest,
  UpdateTeamRequest,
  UpdateUserRequest,
  User,
  UserRole,
} from '@oblidesk/shared';

export interface UserListParams {
  q?: string;
  role?: UserRole;
  isActive?: boolean;
  page?: number;
  limit?: number;
}

export interface UserPage {
  users: User[];
  total: number;
  page: number;
  limit: number;
}

interface UserPageEnvelope extends Envelope<User[]> {
  total?: number;
  page?: number;
  limit?: number;
}

function toPage(body: UserPageEnvelope): UserPage {
  const users = unwrap<User[]>(body) ?? [];
  return {
    users,
    total: body.total ?? users.length,
    page: body.page ?? 1,
    limit: body.limit ?? users.length,
  };
}

export const usersApi = {
  /** Members of the ACTIVE tenant. */
  async list(params: UserListParams = {}): Promise<UserPage> {
    try {
      const res = await apiClient.get<UserPageEnvelope>('/users', { params: toQuery({ ...params }) });
      return toPage(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Every account on the installation. Crosses tenants — platform admin only. */
  async listAll(params: { q?: string; page?: number; limit?: number } = {}): Promise<UserPage> {
    try {
      const res = await apiClient.get<UserPageEnvelope>('/users/all', { params: toQuery({ ...params }) });
      return toPage(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async get(id: number): Promise<User> {
    try {
      const res = await apiClient.get<Envelope<User>>(`/users/${id}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async create(payload: CreateUserRequest): Promise<User> {
    try {
      const res = await apiClient.post<Envelope<User>>('/users', payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async update(id: number, payload: UpdateUserRequest): Promise<User> {
    try {
      const res = await apiClient.put<Envelope<User>>(`/users/${id}`, payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Admin reset. Bumps the enrolment version, so every live session dies. */
  async setPassword(id: number, password: string): Promise<void> {
    try {
      await apiClient.put(`/users/${id}/password`, { password });
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Remove from THIS tenant. `purge` hard-deletes the account installation-wide
   * and is not recoverable — never wire it to the same button.
   */
  async remove(id: number, options: { purge?: boolean } = {}): Promise<void> {
    try {
      await apiClient.delete(`/users/${id}`, { params: toQuery({ purge: options.purge }) });
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Membership and grants ─────────────────────────────────────────────────

  /** The role this user holds HERE — it may differ from their global role. */
  async setTenantRole(id: number, role: UserRole): Promise<void> {
    try {
      await apiClient.put(`/users/${id}/tenant-role`, { role });
    } catch (error) {
      throw toApiError(error);
    }
  },

  async getTenants(id: number): Promise<TenantMembership[]> {
    const res = await apiClient.get<Envelope<TenantMembership[]>>(`/users/${id}/tenants`);
    return unwrap(res.data) ?? [];
  },

  /** Replaces every assignment. Platform admin. */
  async setTenants(
    id: number,
    assignments: Array<{ tenantId: number; role: UserRole }>,
  ): Promise<TenantMembership[]> {
    try {
      const res = await apiClient.put<Envelope<TenantMembership[]>>(`/users/${id}/tenants`, { assignments });
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  async getTeams(id: number): Promise<Team[]> {
    const res = await apiClient.get<Envelope<Team[]>>(`/users/${id}/teams`);
    return unwrap(res.data) ?? [];
  },

  async getPermissionSets(id: number): Promise<PermissionSet[]> {
    const res = await apiClient.get<Envelope<PermissionSet[]>>(`/users/${id}/permission-sets`);
    return unwrap(res.data) ?? [];
  },

  async setPermissionSets(id: number, permissionSetIds: number[]): Promise<PermissionSet[]> {
    try {
      const res = await apiClient.put<Envelope<PermissionSet[]>>(`/users/${id}/permission-sets`, {
        permissionSetIds,
      });
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Teams
// ═════════════════════════════════════════════════════════════════════════════

export const teamsApi = {
  async list(): Promise<Team[]> {
    const res = await apiClient.get<Envelope<Team[]>>('/teams');
    return unwrap(res.data) ?? [];
  },

  async get(id: number): Promise<Team> {
    try {
      const res = await apiClient.get<Envelope<Team>>(`/teams/${id}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async create(payload: CreateTeamRequest): Promise<Team> {
    try {
      const res = await apiClient.post<Envelope<Team>>('/teams', payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async update(id: number, payload: UpdateTeamRequest): Promise<Team> {
    try {
      const res = await apiClient.put<Envelope<Team>>(`/teams/${id}`, payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async remove(id: number): Promise<void> {
    try {
      await apiClient.delete(`/teams/${id}`);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async members(id: number): Promise<User[]> {
    const res = await apiClient.get<Envelope<User[]>>(`/teams/${id}/members`);
    return unwrap(res.data) ?? [];
  },

  async setMembers(id: number, userIds: number[]): Promise<User[]> {
    try {
      const res = await apiClient.put<Envelope<User[]>>(`/teams/${id}/members`, { userIds });
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Permission sets
// ═════════════════════════════════════════════════════════════════════════════

export interface CapabilityCatalogEntryDto {
  key: Capability;
  label: string;
  labelKey: string;
  description: string;
  group: string;
  sortOrder: number;
  implies: Capability[];
  sensitive: boolean;
}

export const permissionSetsApi = {
  async list(): Promise<PermissionSet[]> {
    const res = await apiClient.get<Envelope<PermissionSet[]>>('/permission-sets');
    return unwrap(res.data) ?? [];
  },

  /**
   * The capability catalog the editor renders. Fetched rather than imported so
   * a server that knows about a newer capability can offer it before the client
   * ships — the shared constant is the fallback, not the authority here.
   */
  async catalog(): Promise<CapabilityCatalogEntryDto[]> {
    const res = await apiClient.get<Envelope<CapabilityCatalogEntryDto[]>>('/permission-sets/catalog');
    return unwrap(res.data) ?? [];
  },

  async get(id: number): Promise<PermissionSet> {
    try {
      const res = await apiClient.get<Envelope<PermissionSet>>(`/permission-sets/${id}`);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async create(payload: CreatePermissionSetRequest): Promise<PermissionSet> {
    try {
      const res = await apiClient.post<Envelope<PermissionSet>>('/permission-sets', payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async update(id: number, payload: UpdatePermissionSetRequest): Promise<PermissionSet> {
    try {
      const res = await apiClient.put<Envelope<PermissionSet>>(`/permission-sets/${id}`, payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async remove(id: number): Promise<void> {
    try {
      await apiClient.delete(`/permission-sets/${id}`);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async clone(id: number, name: string): Promise<PermissionSet> {
    try {
      const res = await apiClient.post<Envelope<PermissionSet>>(`/permission-sets/${id}/clone`, { name });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async assignees(id: number): Promise<User[]> {
    const res = await apiClient.get<Envelope<User[]>>(`/permission-sets/${id}/assignees`);
    return unwrap(res.data) ?? [];
  },
};

export default usersApi;
