/**
 * tenant.ts — resolve WHICH tenant this request operates in, prove the caller
 * belongs to it, and hand the handler a query builder that cannot leave it.
 *
 * ── Why the binding matters (HARD RULE 1) ───────────────────────────────────
 * `scoped(table, tenantId)` is only as safe as the `tenantId` handed to it. A
 * handler that writes `scoped('tickets', req.body.tenantId)` is scoped and
 * still wrong. So `requireTenant` binds the helpers to the resolved tenant and
 * puts them on the request: a handler writes `req.scoped('tickets')` and never
 * names a tenant at all. There is no argument left to get wrong.
 *
 * ── Resolution order ────────────────────────────────────────────────────────
 *   1. `X-Tenant-Id` header (TENANT_OVERRIDE_HEADER) — honoured ONLY for a
 *      platform admin or an admin of the master tenant. This is how the MSP
 *      console acts inside a customer tenant without switching session state,
 *      and how ObliTools opens a deep link into another tenant.
 *   2. `req.session.currentTenantId` — the normal path.
 *
 * Membership is then verified against `user_tenants`, EXCEPT for an admin of
 * the master tenant, who by design administers every tenant without being a
 * member of it (migration 001: "The master tenant sees across tenants").
 */
import type { NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';
import { TENANT_OVERRIDE_HEADER } from '@oblidesk/shared';
import type { UserRole } from '@oblidesk/shared';
import {
  db,
  insertScoped,
  scoped,
  scopedAs,
  scopedOrGlobal,
  type Executor,
} from '../db';
import { AppError, badRequest, forbidden, unauthorized } from './errorHandler';

interface TenantRow {
  id: number;
  slug: string;
  is_master: boolean;
}

interface MembershipRow {
  role: UserRole;
}

/**
 * The master tenant changes about once in the life of an install, and every
 * request that carries a tenant override asks for it. A short TTL cache keeps
 * that from being two extra queries per request without making a tenant rename
 * require a restart.
 */
const MASTER_CACHE_TTL_MS = 60_000;
let masterTenantIds: number[] = [];
let masterTenantIdsAt = 0;

async function getMasterTenantIds(): Promise<number[]> {
  if (Date.now() - masterTenantIdsAt < MASTER_CACHE_TTL_MS) return masterTenantIds;
  // `tenants` is a GLOBAL table — db() is the correct accessor here.
  masterTenantIds = await db('tenants').where('is_master', true).pluck<number[]>('id');
  masterTenantIdsAt = Date.now();
  return masterTenantIds;
}

/** Invalidate the cache after a tenant's `is_master` flag is edited. */
export function invalidateMasterTenantCache(): void {
  masterTenantIdsAt = 0;
}

/**
 * True when `userId` is an admin of a master tenant. Each membership lookup
 * goes through `scoped()` — including this one, which is cross-tenant by
 * nature: we enumerate master tenants from the global `tenants` table and then
 * ask, one scoped query at a time, whether the user is an admin there.
 */
export async function isMasterTenantAdmin(userId: number): Promise<boolean> {
  const masters = await getMasterTenantIds();
  for (const tenantId of masters) {
    const membership = (await scoped('user_tenants', tenantId)
      .where('user_id', userId)
      .first('role')) as MembershipRow | undefined;
    if (membership?.role === 'admin') return true;
  }
  return false;
}

/**
 * Every tenant id `userId` is a member of.
 *
 * ── The one unscoped read of `user_tenants`, and why ────────────────────────
 * HARD RULE 1 says tenant data is reached through `scoped(table, tenantId)`.
 * That helper needs a tenant id — and this query is what PRODUCES one. It is
 * the bootstrap read that precedes tenancy rather than operating inside it, so
 * there is no tenant to scope it by. Its isolation predicate is `user_id`,
 * which is the correct one here, and it returns tenant IDS, never tenant data.
 *
 * It lives in this one place so that the codebase contains exactly one
 * unscoped `user_tenants` read, right next to the explanation. A second one
 * appearing anywhere else is a defect: route it through here instead.
 */
export async function listUserTenantIds(userId: number): Promise<number[]> {
  return db('user_tenants').where('user_id', userId).pluck<number[]>('tenant_id');
}

/** The caller's role inside a tenant, or null when they are not a member. */
export async function tenantMembershipRole(
  userId: number,
  tenantId: number,
): Promise<UserRole | null> {
  const row = (await scoped('user_tenants', tenantId)
    .where('user_id', userId)
    .first('role')) as MembershipRow | undefined;
  return row?.role ?? null;
}

/** Attach the tenant-bound query helpers. Called once per request. */
function bindScopedHelpers(req: Request, tenantId: number): void {
  req.scoped = (table: string, executor?: Executor) => scoped(table, tenantId, executor ?? db);
  req.scopedAs = (table: string, alias: string, executor?: Executor) =>
    scopedAs(table, alias, tenantId, executor ?? db);
  req.scopedOrGlobal = (table: string, executor?: Executor) =>
    scopedOrGlobal(table, tenantId, executor ?? db);
  req.insertScoped = <T extends Record<string, unknown>>(
    table: string,
    rows: T | T[],
    executor?: Executor,
  ) => insertScoped(table, tenantId, rows, executor ?? db);
}

/**
 * Resolve `req.tenantId` and verify membership.
 *
 * Apply AFTER `requireAuth` on every route that touches tenant data. A route
 * that reads `req.tenantId` without it gets `undefined`, and `scoped()` throws
 * on `undefined` rather than returning cross-tenant rows — the failure is loud
 * by design.
 */
export async function requireTenant(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Idempotent by design. Every feature router in this codebase applies
    // `requireAuth` + `requireTenant` itself, AND the tenant tier in
    // routes/index.ts applies them again as the safety net for a router that
    // forgets. Without this guard that belt-and-braces arrangement would cost
    // a tenant lookup plus a membership check twice on every single request.
    // Resolving once and short-circuiting means the safety net is free, so
    // there is never a reason to remove it.
    if (req.tenantId && typeof req.scoped === 'function') {
      next();
      return;
    }

    const userId = req.session?.userId;
    if (!userId) {
      next(unauthorized());
      return;
    }

    const isPlatformAdmin = req.session.role === 'admin';
    const masterAdmin = isPlatformAdmin || (await isMasterTenantAdmin(userId));

    // ── 1. Where does the tenant id come from? ─────────────────────────────
    const headerRaw = req.get(TENANT_OVERRIDE_HEADER);
    let tenantId: number | undefined;
    let viaOverride = false;

    if (headerRaw !== undefined && headerRaw.trim() !== '') {
      if (!masterAdmin) {
        next(forbidden(`${TENANT_OVERRIDE_HEADER} is reserved for platform administrators`));
        return;
      }
      const parsed = Number.parseInt(headerRaw.trim(), 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        next(badRequest(`${TENANT_OVERRIDE_HEADER} must be a positive integer tenant id`));
        return;
      }
      tenantId = parsed;
      viaOverride = true;
    } else {
      tenantId = req.session.currentTenantId;
    }

    if (!tenantId) {
      next(new AppError(400, 'No tenant selected', { code: 'tenant_mismatch' }));
      return;
    }

    // ── 2. Does the tenant exist? ──────────────────────────────────────────
    const tenant = (await db('tenants')
      .where('id', tenantId)
      .first('id', 'slug', 'is_master')) as TenantRow | undefined;

    if (!tenant) {
      next(new AppError(404, 'Tenant not found', { code: 'tenant_mismatch' }));
      return;
    }

    // ── 3. May the caller act in it? ───────────────────────────────────────
    const membershipRole = await tenantMembershipRole(userId, tenant.id);

    if (!membershipRole && !masterAdmin) {
      // Same answer whether the tenant is missing or merely forbidden — a
      // difference here is a tenant-enumeration oracle.
      next(new AppError(404, 'Tenant not found', { code: 'tenant_mismatch' }));
      return;
    }

    // ── 4. Publish the resolution on the request ───────────────────────────
    req.tenantId = tenant.id;
    req.tenantSlug = tenant.slug;
    req.tenantRole = membershipRole ?? (masterAdmin ? 'admin' : 'user');
    req.isMasterAdmin = masterAdmin && (!membershipRole || viaOverride || tenant.is_master);
    req.isPlatformAdmin = isPlatformAdmin;

    bindScopedHelpers(req, tenant.id);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Same resolution, but a request without a tenant simply carries on. For
 * endpoints that are useful both inside and outside a tenant (`/api/auth/me`,
 * the tenant switcher itself).
 */
export async function optionalTenant(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.session?.userId || !req.session.currentTenantId) {
    next();
    return;
  }
  await requireTenant(req, res, (err?: unknown) => {
    // A stale `currentTenantId` (the membership was revoked while the session
    // lived on) must not 404 an endpoint that does not need a tenant.
    next(err instanceof AppError ? undefined : err);
  });
}

/**
 * Guard for cross-tenant administration endpoints: only an admin of the master
 * tenant, or a platform admin, may pass.
 */
export async function requireMasterAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      next(unauthorized());
      return;
    }
    if (req.session.role === 'admin' || (await isMasterTenantAdmin(userId))) {
      req.isMasterAdmin = true;
      next();
      return;
    }
    next(forbidden('This action requires master-tenant administration rights'));
  } catch (err) {
    next(err);
  }
}

/**
 * Escape hatch for the rare service that legitimately needs a builder for a
 * tenant other than the request's (an MSP fan-out writing a config object into
 * every target tenant). Still goes through `scoped()`; the point is that it is
 * explicit and greppable.
 */
export function scopedFor(table: string, tenantId: number, executor?: Knex | Knex.Transaction) {
  return scoped(table, tenantId, executor ?? db);
}
