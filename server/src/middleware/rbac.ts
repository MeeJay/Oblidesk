/**
 * rbac.ts — role and capability enforcement.
 *
 * ── The resolution order (this is the contract) ─────────────────────────────
 * For a given (user, tenant), the effective capability set is:
 *
 *   0. `users.role === 'admin'`            → every capability. Platform admin.
 *   1. `user_tenants` membership           → no row means NO capabilities in
 *                                            this tenant, full stop. A master
 *                                            tenant admin is the one exception
 *                                            (see `requireTenant`).
 *   2. `user_tenants.role === 'admin'`     → every capability inside it.
 *   3. `user_tenants.capabilities`         → the per-tenant grant. `{"*":true}`
 *                                            is the wildcard the seed writes;
 *                                            an array or a `{cap: true}` map
 *                                            both work. NULL means "no
 *                                            override" and falls back to the
 *                                            preset for the tenant role.
 *   4. ∪ `teams.capabilities`              → for every team in this tenant the
 *                                            user belongs to.
 *   5. ∪ `permission_sets.capabilities`    → for every set assigned to them in
 *                                            this tenant.
 *   6. `expandCapabilities()`              → transitive closure of `implies`,
 *                                            from @oblidesk/shared. The SAME
 *                                            function the client uses to decide
 *                                            what to render, so an affordance
 *                                            the UI shows is one the server
 *                                            will honour, and vice versa.
 *
 * ── Why the server re-checks what the client already checked ───────────────
 * `hasCapability` runs on both sides on purpose. The client's call hides a
 * button; the server's call refuses the request. Neither substitutes for the
 * other, and a mutation gated only client-side is a defect, not a shortcut.
 */
import type { NextFunction, Request, Response } from 'express';
import {
  ALL_CAPABILITIES,
  CAPABILITY_PRESETS,
  expandCapabilities,
  hasAllCapabilities,
  hasAnyCapability,
  hasCapability,
  isCapability,
  sanitizeCapabilities,
} from '@oblidesk/shared';
import type { Capability, UserRole } from '@oblidesk/shared';
import { scoped } from '../db';
import { forbidden, unauthorized } from './errorHandler';
import { isMasterTenantAdmin } from './tenant';

// ═════════════════════════════════════════════════════════════════════════════
// Parsing what the database actually holds
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `capabilities` columns are jsonb and three shapes exist in the wild:
 *
 *   ["ticket_rw","kb_read"]     the normal grant (teams, permission_sets)
 *   {"*": true}                 the wildcard the core seed writes for the admin
 *   {"ticket_rw": true, …}      a map, from an older import or Obligate
 *
 * Plus the string form, because some drivers hand back jsonb as text. Parse all
 * of them, throw none of them away, and never throw: a malformed grant must
 * degrade to "no extra capabilities", not 500 every request the user makes.
 */
export function parseCapabilityColumn(raw: unknown): { wildcard: boolean; capabilities: Capability[] } {
  if (raw === null || raw === undefined) return { wildcard: false, capabilities: [] };

  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { wildcard: false, capabilities: [] };
    }
  }

  if (Array.isArray(value)) {
    if (value.includes('*')) return { wildcard: true, capabilities: [...ALL_CAPABILITIES] };
    return { wildcard: false, capabilities: sanitizeCapabilities(value) };
  }

  if (value !== null && typeof value === 'object') {
    const map = value as Record<string, unknown>;
    if (map['*'] === true) return { wildcard: true, capabilities: [...ALL_CAPABILITIES] };
    const granted = Object.entries(map)
      .filter(([, enabled]) => enabled === true)
      .map(([key]) => key)
      .filter(isCapability);
    return { wildcard: false, capabilities: granted };
  }

  return { wildcard: false, capabilities: [] };
}

/** Preset applied when a membership carries no explicit capability grant. */
function presetForRole(role: UserRole): Capability[] {
  const slug =
    role === 'manager' ? 'service_manager' : role === 'agent' ? 'agent' : 'read_only';
  const preset = CAPABILITY_PRESETS.find((entry) => entry.slug === slug);
  return preset ? [...preset.capabilities] : [];
}

// ═════════════════════════════════════════════════════════════════════════════
// Resolution
// ═════════════════════════════════════════════════════════════════════════════

interface CapabilityRow {
  capabilities: unknown;
}

interface MembershipRow {
  role: UserRole;
  capabilities: unknown;
}

/**
 * The effective, EXPANDED capability set for (user, tenant).
 *
 * Exported because it is not only a middleware concern: `auth.routes` builds
 * `SessionContext.capabilities` from it so the client's `hasCapability` calls
 * agree with the server's, and the socket layer uses it to decide who may join
 * a queue room.
 */
export async function resolveUserCapabilities(
  userId: number,
  tenantId: number,
  options?: { isPlatformAdmin?: boolean },
): Promise<Capability[]> {
  if (options?.isPlatformAdmin) return [...ALL_CAPABILITIES];

  // 1. Membership. No row, no capabilities — unless they administer the master
  //    tenant, which `requireTenant` has already established for the request.
  const membership = (await scoped('user_tenants', tenantId)
    .where('user_id', userId)
    .first('role', 'capabilities')) as MembershipRow | undefined;

  if (!membership) {
    return (await isMasterTenantAdmin(userId)) ? [...ALL_CAPABILITIES] : [];
  }

  // 2. Tenant admin holds everything inside this tenant.
  if (membership.role === 'admin') return [...ALL_CAPABILITIES];

  const held = new Set<Capability>();

  // 3. The membership grant, or the role preset when there is none.
  const membershipGrant = parseCapabilityColumn(membership.capabilities);
  if (membershipGrant.wildcard) return [...ALL_CAPABILITIES];
  if (membership.capabilities === null || membership.capabilities === undefined) {
    for (const capability of presetForRole(membership.role)) held.add(capability);
  } else {
    for (const capability of membershipGrant.capabilities) held.add(capability);
  }

  // 4. Teams. `team_memberships` has no tenant_id of its own (PARENT_SCOPED),
  //    so it is reached through the already-scoped `teams` row.
  const teamRows = (await scoped('teams', tenantId)
    .join('team_memberships', 'team_memberships.team_id', 'teams.id')
    .where('team_memberships.user_id', userId)
    .select('teams.capabilities')) as CapabilityRow[];

  for (const row of teamRows) {
    const grant = parseCapabilityColumn(row.capabilities);
    if (grant.wildcard) return [...ALL_CAPABILITIES];
    for (const capability of grant.capabilities) held.add(capability);
  }

  // 5. Permission sets, likewise reached through their scoped parent.
  const setRows = (await scoped('permission_sets', tenantId)
    .join(
      'user_permission_sets',
      'user_permission_sets.permission_set_id',
      'permission_sets.id',
    )
    .where('user_permission_sets.user_id', userId)
    .select('permission_sets.capabilities')) as CapabilityRow[];

  for (const row of setRows) {
    const grant = parseCapabilityColumn(row.capabilities);
    if (grant.wildcard) return [...ALL_CAPABILITIES];
    for (const capability of grant.capabilities) held.add(capability);
  }

  // 6. Transitive closure — `config_admin` alone unlocks queue/sla/automation.
  return expandCapabilities([...held]);
}

/**
 * Per-request memo. Several guards on one route (`requireCapability` twice, a
 * handler asking again for a conditional field) must not each pay for four
 * queries.
 */
export async function resolveRequestCapabilities(req: Request): Promise<Capability[]> {
  if (req.capabilities) return req.capabilities;

  const userId = req.session?.userId;
  if (!userId) return [];

  const resolved =
    req.isPlatformAdmin || req.isMasterAdmin
      ? [...ALL_CAPABILITIES]
      : await resolveUserCapabilities(userId, req.tenantId, {
          isPlatformAdmin: req.session.role === 'admin',
        });

  req.capabilities = resolved;
  return resolved;
}

/** True when the request's caller effectively holds every capability. */
function isAdminRequest(req: Request): boolean {
  return req.session?.role === 'admin' || req.isPlatformAdmin === true || req.isMasterAdmin === true;
}

// ═════════════════════════════════════════════════════════════════════════════
// Guards
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Role gate. Checks the role INSIDE the current tenant when one has been
 * resolved (`req.tenantRole`), falling back to the platform role otherwise —
 * an agent in tenant A must not inherit their manager role in tenant B.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      next(unauthorized());
      return;
    }
    if (req.session.role === 'admin') {
      next();
      return;
    }

    const effective = (req.tenantRole ?? req.session.role) as UserRole;
    if (!roles.includes(effective)) {
      next(forbidden());
      return;
    }
    next();
  };
}

/**
 * Capability gate — the one to reach for on a write route.
 *
 * Apply after `requireAuth` + `requireTenant`: capabilities are per-tenant, and
 * without a resolved tenant the honest answer is "none".
 */
export function requireCapability(capability: Capability) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.session?.userId) {
        next(unauthorized());
        return;
      }
      if (isAdminRequest(req)) {
        next();
        return;
      }
      const held = await resolveRequestCapabilities(req);
      if (!hasCapability(held, capability)) {
        next(forbidden(`This action requires the "${capability}" capability`));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Passes when the caller holds AT LEAST ONE of the listed capabilities. */
export function requireAnyCapability(...capabilities: Capability[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.session?.userId) {
        next(unauthorized());
        return;
      }
      if (isAdminRequest(req)) {
        next();
        return;
      }
      const held = await resolveRequestCapabilities(req);
      if (!hasAnyCapability(held, capabilities)) {
        next(forbidden(`This action requires one of: ${capabilities.join(', ')}`));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Passes only when the caller holds EVERY listed capability. */
export function requireAllCapabilities(...capabilities: Capability[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.session?.userId) {
        next(unauthorized());
        return;
      }
      if (isAdminRequest(req)) {
        next();
        return;
      }
      const held = await resolveRequestCapabilities(req);
      if (!hasAllCapabilities(held, capabilities)) {
        next(forbidden(`This action requires all of: ${capabilities.join(', ')}`));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Non-throwing check for a handler that must branch rather than refuse — for
 * example a ticket read that hides work notes from a caller without
 * `ticket_rw`, instead of 403-ing the whole ticket.
 */
export async function requestHasCapability(
  req: Request,
  capability: Capability,
): Promise<boolean> {
  if (isAdminRequest(req)) return true;
  const held = await resolveRequestCapabilities(req);
  return hasCapability(held, capability);
}
