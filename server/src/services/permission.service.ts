/**
 * permission.service.ts — who can do what, inside which tenant.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  The model
 * ──────────────────────────────────────────────────────────────────────────
 * Capabilities are resolved PER (user, tenant). A user is a global account
 * (`users`) that can work in several tenants; everything about what they may
 * DO comes from the tenant they are currently acting in. Four sources feed the
 * effective set, unioned:
 *
 *   1. `users.role = 'admin'`      — the platform administrator. Everything,
 *                                    everywhere. Short-circuits the rest.
 *   2. `user_tenants.role`         — the role INSIDE this tenant, mapped
 *                                    through ROLE_CAPABILITIES below.
 *   3. `user_tenants.capabilities` — per-tenant grants on top of the role.
 *   4. `permission_sets` (via `user_permission_sets`) and `teams` (via
 *      `team_memberships`) — named bundles, both tenant-scoped.
 *
 * The union is then run through `expandCapabilities()` from @oblidesk/shared,
 * which closes the `implies` graph: granting `config_admin` really does unlock
 * queue/sla/automation/catalog/alert/portal admin, once, in shared code that
 * the client uses too. The client greys out a button using the same expansion
 * the server enforces with — one implementation, two callers.
 *
 * ── Two shapes of `capabilities` ──────────────────────────────────────────
 * `user_tenants.capabilities` is jsonb and legitimately holds EITHER a plain
 * array (`["ticket_rw","kb_read"]`) or a map (`{"ticket_rw": true,
 * "ticket_delete": false, "*": true}`). The seed writes the map form with the
 * `*` wildcard for the bootstrap admin. Both are parsed here, and the map form
 * additionally supports explicit DENIES — a `false` removes a capability the
 * role or a permission set would otherwise have granted, which is the only way
 * to say "an agent, but never allowed to delete tickets".
 *
 * Denies are applied AFTER expansion, so denying `ticket_delete` cannot be
 * defeated by holding something that implies it.
 *
 * ── Caching ───────────────────────────────────────────────────────────────
 * Resolution touches five tables; it runs on every capability check. Results
 * are cached per (user, tenant) for a few seconds with an explicit
 * `invalidate()` called by every write path in this module's sibling services.
 * The TTL is short on purpose: a permission change that takes effect in ten
 * seconds is acceptable; one that needs a logout is not.
 */

import {
  db,
  scoped,
  assertTenantId,
  type Executor,
} from '../db';
import type { Capability, TenantMembership, UserRole } from '@oblidesk/shared';
import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  expandCapabilities,
  isCapability,
  sanitizeCapabilities,
} from '@oblidesk/shared';

// ═════════════════════════════════════════════════════════════════════════════
// Role → capability matrix
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What a bare tenant ROLE grants before any permission set or explicit grant.
 * Deliberately conservative: a role is a starting point, and anything beyond it
 * is an explicit, auditable grant rather than a side effect of a job title.
 *
 * `implies` expansion runs afterwards, so this table lists the intent, not the
 * closure — `TICKET_RW` here already means `TICKET_READ` at check time.
 */
export const ROLE_CAPABILITIES: Readonly<Record<UserRole, readonly Capability[]>> = {
  // Tenant admin: everything the app can do inside this tenant. NOT the same as
  // a platform admin — the scope is still one tenant.
  admin: ALL_CAPABILITIES,

  manager: [
    CAPABILITIES.TICKET_RW,
    CAPABILITIES.TICKET_ASSIGN,
    CAPABILITIES.QUEUE_ADMIN,
    CAPABILITIES.KB_RW,
    CAPABILITIES.KB_PUBLISH,
    CAPABILITIES.SLA_ADMIN,
    CAPABILITIES.AUTOMATION_ADMIN,
    CAPABILITIES.REPORT_ADMIN,
    CAPABILITIES.TIME_APPROVE,
    CAPABILITIES.CONTRACT_ADMIN,
    CAPABILITIES.CI_RW,
    CAPABILITIES.ALERT_ADMIN,
    CAPABILITIES.PORTAL_ADMIN,
    CAPABILITIES.AI_USE,
  ],

  agent: [
    CAPABILITIES.TICKET_RW,
    CAPABILITIES.TICKET_ASSIGN,
    CAPABILITIES.KB_READ,
    CAPABILITIES.REPORT_VIEW,
    CAPABILITIES.TIME_RW,
    CAPABILITIES.CI_READ,
    CAPABILITIES.AI_USE,
  ],

  // The portal-facing role. Reading tickets here means "the ones they raised",
  // which the ticket service enforces by requester, not by capability.
  user: [CAPABILITIES.TICKET_READ, CAPABILITIES.KB_READ],
};

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

export interface ResolvedPermissions {
  userId: number;
  tenantId: number;
  /** Global `users.role` — 'admin' here means PLATFORM admin. */
  platformRole: UserRole;
  /** `user_tenants.role` — the role inside this tenant. */
  tenantRole: UserRole;
  isPlatformAdmin: boolean;
  isTenantAdmin: boolean;
  isMasterTenant: boolean;
  /** Expanded and de-duplicated; denies already applied. */
  capabilities: Capability[];
  teams: Array<{ id: number; name: string }>;
  permissionSets: Array<{ id: number; name: string }>;
  /** True when the user is a member of this tenant at all. */
  isMember: boolean;
}

interface CacheEntry {
  value: ResolvedPermissions;
  expiresAt: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// Cache
// ═════════════════════════════════════════════════════════════════════════════

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(userId: number, tenantId: number): string {
  return `${userId}:${tenantId}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Capability parsing
// ═════════════════════════════════════════════════════════════════════════════

interface ParsedGrants {
  granted: Capability[];
  denied: Capability[];
  /** `{"*": true}` — the seed's bootstrap admin marker. */
  wildcard: boolean;
}

/**
 * Parse a `capabilities` jsonb column that may be an array, a map, or a JSON
 * string of either. Unknown keys are dropped rather than throwing: a capability
 * removed in an upgrade must not lock an admin out of their own tenant.
 */
export function parseCapabilityGrants(raw: unknown): ParsedGrants {
  const empty: ParsedGrants = { granted: [], denied: [], wildcard: false };
  if (raw === null || raw === undefined) return empty;

  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return empty;
    }
  }

  if (Array.isArray(value)) {
    return { granted: sanitizeCapabilities(value), denied: [], wildcard: value.includes('*') };
  }

  if (typeof value === 'object' && value !== null) {
    const granted: Capability[] = [];
    const denied: Capability[] = [];
    let wildcard = false;

    for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
      if (key === '*') {
        wildcard = enabled !== false;
        continue;
      }
      if (!isCapability(key)) continue;
      if (enabled === false) denied.push(key);
      else granted.push(key);
    }

    return { granted, denied, wildcard };
  }

  return empty;
}

// ═════════════════════════════════════════════════════════════════════════════
// Service
// ═════════════════════════════════════════════════════════════════════════════

export const permissionService = {
  /**
   * THE resolver. Everything else in this module is a thin read of its result.
   *
   * Returns a fully-resolved, expanded capability set for one user in one
   * tenant, including for a NON-member (empty capabilities, `isMember: false`)
   * so callers can distinguish "not allowed" from "not here" without a second
   * query.
   */
  async resolve(
    userId: number,
    tenantId: number,
    options: { skipCache?: boolean; executor?: Executor } = {},
  ): Promise<ResolvedPermissions> {
    assertTenantId(tenantId);

    const key = cacheKey(userId, tenantId);
    if (!options.skipCache) {
      const hit = cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
    }

    const executor = options.executor ?? db;

    const user = (await executor('users')
      .where({ id: userId })
      .first('id', 'role', 'is_active')) as
      | { id: number; role: string; is_active: boolean }
      | undefined;

    const tenant = (await executor('tenants')
      .where({ id: tenantId })
      .first('id', 'is_master')) as { id: number; is_master: boolean } | undefined;

    const platformRole = (user?.role ?? 'user') as UserRole;
    const isPlatformAdmin = Boolean(user?.is_active) && platformRole === 'admin';
    const isMasterTenant = Boolean(tenant?.is_master);

    const membership = (await scoped('user_tenants', tenantId, executor)
      .where('user_tenants.user_id', userId)
      .first('role', 'capabilities')) as
      | { role: string; capabilities: unknown }
      | undefined;

    // Teams and permission sets are tenant-scoped; a membership in another
    // tenant's team must not leak a capability into this one.
    const teams = (await scoped('teams', tenantId, executor)
      .join('team_memberships', 'team_memberships.team_id', 'teams.id')
      .where('team_memberships.user_id', userId)
      .select('teams.id', 'teams.name', 'teams.capabilities')) as Array<{
      id: number;
      name: string;
      capabilities: unknown;
    }>;

    const permissionSets = (await scoped('permission_sets', tenantId, executor)
      .join('user_permission_sets', 'user_permission_sets.permission_set_id', 'permission_sets.id')
      .where('user_permission_sets.user_id', userId)
      .select(
        'permission_sets.id',
        'permission_sets.name',
        'permission_sets.capabilities',
      )) as Array<{ id: number; name: string; capabilities: unknown }>;

    const tenantRole = (membership?.role ?? 'user') as UserRole;
    const isMember = Boolean(membership);

    const granted = new Set<Capability>();
    const denied = new Set<Capability>();

    if (isPlatformAdmin) {
      for (const capability of ALL_CAPABILITIES) granted.add(capability);
    }

    if (isMember) {
      for (const capability of ROLE_CAPABILITIES[tenantRole] ?? []) granted.add(capability);

      const explicit = parseCapabilityGrants(membership?.capabilities);
      if (explicit.wildcard) for (const capability of ALL_CAPABILITIES) granted.add(capability);
      for (const capability of explicit.granted) granted.add(capability);
      for (const capability of explicit.denied) denied.add(capability);

      for (const team of teams) {
        const parsed = parseCapabilityGrants(team.capabilities);
        if (parsed.wildcard) for (const capability of ALL_CAPABILITIES) granted.add(capability);
        for (const capability of parsed.granted) granted.add(capability);
        // Team-level denies are intentionally NOT honoured: a team is additive.
        // A deny belongs on the user's tenant membership, where it is one row
        // an admin can see, not spread across every team someone might join.
      }

      for (const set of permissionSets) {
        const parsed = parseCapabilityGrants(set.capabilities);
        if (parsed.wildcard) for (const capability of ALL_CAPABILITIES) granted.add(capability);
        for (const capability of parsed.granted) granted.add(capability);
      }
    }

    // Expand the `implies` closure FIRST, then subtract denies — otherwise a
    // deny could be defeated by holding a capability that implies it, which is
    // exactly the hole an explicit deny exists to close.
    const expanded = expandCapabilities([...granted]);
    const capabilities = isPlatformAdmin
      ? expanded
      : expanded.filter((capability) => !denied.has(capability));

    const resolved: ResolvedPermissions = {
      userId,
      tenantId,
      platformRole,
      tenantRole,
      isPlatformAdmin,
      isTenantAdmin: isPlatformAdmin || tenantRole === 'admin',
      isMasterTenant,
      capabilities,
      teams: teams.map((team) => ({ id: team.id, name: team.name })),
      permissionSets: permissionSets.map((set) => ({ id: set.id, name: set.name })),
      isMember,
    };

    cache.set(key, { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
    return resolved;
  },

  /** Just the capability list — the common case. */
  async getCapabilities(userId: number, tenantId: number): Promise<Capability[]> {
    const resolved = await permissionService.resolve(userId, tenantId);
    return resolved.capabilities;
  },

  /** Does this user hold `capability` in this tenant? */
  async can(userId: number, tenantId: number, capability: Capability): Promise<boolean> {
    const resolved = await permissionService.resolve(userId, tenantId);
    if (resolved.isPlatformAdmin) return true;
    return resolved.capabilities.includes(capability);
  },

  async canAny(
    userId: number,
    tenantId: number,
    capabilities: readonly Capability[],
  ): Promise<boolean> {
    if (capabilities.length === 0) return true;
    const resolved = await permissionService.resolve(userId, tenantId);
    if (resolved.isPlatformAdmin) return true;
    return capabilities.some((capability) => resolved.capabilities.includes(capability));
  },

  async canAll(
    userId: number,
    tenantId: number,
    capabilities: readonly Capability[],
  ): Promise<boolean> {
    if (capabilities.length === 0) return true;
    const resolved = await permissionService.resolve(userId, tenantId);
    if (resolved.isPlatformAdmin) return true;
    return capabilities.every((capability) => resolved.capabilities.includes(capability));
  },

  /** True when the user may act inside this tenant at all. */
  async hasTenantAccess(userId: number, tenantId: number): Promise<boolean> {
    const resolved = await permissionService.resolve(userId, tenantId);
    return resolved.isPlatformAdmin || resolved.isMember;
  },

  /**
   * Every tenant this user can reach, with the role and capabilities they hold
   * in each — what the tenant selector renders.
   *
   * A platform admin sees every tenant, including ones they have no membership
   * row for; that is the point of being a platform admin, and hiding tenants
   * from them would just make them create a membership row to work around it.
   */
  async getTenantMemberships(userId: number): Promise<TenantMembership[]> {
    const user = (await db('users').where({ id: userId }).first('role', 'is_active')) as
      | { role: string; is_active: boolean }
      | undefined;
    const isPlatformAdmin = Boolean(user?.is_active) && user?.role === 'admin';

    const rows = isPlatformAdmin
      ? ((await db('tenants')
          .leftJoin('user_tenants', function joinOn() {
            this.on('user_tenants.tenant_id', '=', 'tenants.id').andOnVal(
              'user_tenants.user_id',
              '=',
              userId,
            );
          })
          .orderBy('tenants.name')
          .select(
            'tenants.id',
            'tenants.slug',
            'tenants.name',
            'tenants.is_master',
            'user_tenants.role',
            'user_tenants.capabilities',
          )) as Array<{
          id: number;
          slug: string;
          name: string;
          is_master: boolean;
          role: string | null;
          capabilities: unknown;
        }>)
      : ((await db('tenants')
          .join('user_tenants', 'user_tenants.tenant_id', 'tenants.id')
          .where('user_tenants.user_id', userId)
          .orderBy('tenants.name')
          .select(
            'tenants.id',
            'tenants.slug',
            'tenants.name',
            'tenants.is_master',
            'user_tenants.role',
            'user_tenants.capabilities',
          )) as Array<{
          id: number;
          slug: string;
          name: string;
          is_master: boolean;
          role: string | null;
          capabilities: unknown;
        }>);

    // Resolve each tenant properly rather than guessing from the row: teams and
    // permission sets are per-tenant and only `resolve()` knows about them.
    return Promise.all(
      rows.map(async (row) => {
        const resolved = await permissionService.resolve(userId, row.id);
        return {
          tenantId: row.id,
          tenantSlug: row.slug,
          tenantName: row.name,
          isMaster: row.is_master,
          role: (row.role ?? resolved.platformRole) as UserRole,
          capabilities: resolved.capabilities,
        } satisfies TenantMembership;
      }),
    );
  },

  /** The teams this user belongs to inside one tenant. */
  async getUserTeams(
    userId: number,
    tenantId: number,
  ): Promise<Array<{ id: number; name: string }>> {
    const resolved = await permissionService.resolve(userId, tenantId);
    return resolved.teams;
  },

  /**
   * Users in this tenant who hold `capability` — the recipient list for a
   * notification binding ("everyone who can approve"), and the candidate list
   * for round-robin assignment.
   *
   * Resolution is per user rather than a single clever join because the union
   * of four sources plus the `implies` closure is not expressible in SQL
   * without duplicating the closure in the database, and a duplicated rule is a
   * rule that will drift.
   */
  async getUsersWithCapability(tenantId: number, capability: Capability): Promise<number[]> {
    assertTenantId(tenantId);

    const memberRows = (await scoped('user_tenants', tenantId)
      .join('users', 'users.id', 'user_tenants.user_id')
      .where('users.is_active', true)
      .select('user_tenants.user_id')) as Array<{ user_id: number }>;

    const adminRows = (await db('users')
      .where({ role: 'admin', is_active: true })
      .select('id')) as Array<{ id: number }>;

    const candidates = new Set<number>([
      ...memberRows.map((row) => row.user_id),
      ...adminRows.map((row) => row.id),
    ]);

    const holders: number[] = [];
    for (const userId of candidates) {
      if (await permissionService.can(userId, tenantId, capability)) holders.push(userId);
    }
    return holders.sort((a, b) => a - b);
  },

  // ── Cache control ────────────────────────────────────────────────────────

  /**
   * Drop cached resolutions. Called by every write that can change an
   * effective capability: role changes, team membership, permission sets,
   * tenant membership. Cheap enough to over-call and dangerous to under-call.
   */
  invalidate(userId?: number, tenantId?: number): void {
    if (userId === undefined) {
      cache.clear();
      return;
    }
    if (tenantId === undefined) {
      const prefix = `${userId}:`;
      for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
      return;
    }
    cache.delete(cacheKey(userId, tenantId));
  },

  /** Drop every cached resolution for one tenant (team or permission-set edit). */
  invalidateTenant(tenantId: number): void {
    const suffix = `:${tenantId}`;
    for (const key of cache.keys()) if (key.endsWith(suffix)) cache.delete(key);
  },
};

export default permissionService;
