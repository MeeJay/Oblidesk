/**
 * auth.service.ts — authentication and the session it produces.
 *
 * Scope is deliberately narrow. This module answers three questions and
 * delegates everything else to the module that already owns it:
 *
 *   "is this password right?"        → here (`authenticate`)
 *   "which tenant does this session
 *    land on?"                       → here (`resolveDefaultTenantId`)
 *   "what may they do once in?"      → `permissionService.resolve()`
 *   "what does the user row look
 *    like as a DTO?"                 → `userService`
 *   "what is this tenant?"           → `tenantService`
 *
 * The alternative — resolving capabilities a second time here — would give the
 * installation two answers to the same question, and the one that drifts is
 * always the one nobody is looking at.
 *
 * Session fields are declared once, in `src/types/express.d.ts`; this module
 * writes them and never invents new ones.
 */

import type { Request } from 'express';
import { db } from '../db';
import { comparePassword } from '../utils/crypto';
import { logger } from '../utils/logger';
import { permissionService } from './permission.service';
import { tenantService } from './tenant.service';
import { userService } from './user.service';
import type { SessionContext, User, UserRole } from '@oblidesk/shared';

/**
 * Raised when a password login is attempted on an account that has no local
 * password. The caller turns it into a 401 that tells the login page to offer
 * the SSO button instead of "wrong password" — which would be a lie.
 */
export class SsoOnlyError extends Error {
  constructor(public readonly authSource: string) {
    super('SSO_ONLY');
    this.name = 'SsoOnlyError';
  }
}

const USER_ROLES: readonly UserRole[] = ['admin', 'manager', 'agent', 'user'];

/**
 * Coerce a role string from an untrusted source (an SSO assertion, a sync
 * call) to a role this app understands. A role Obligate invented must degrade
 * to the least-privileged one, never throw and never pass through.
 */
export function toUserRole(value: unknown, fallback: UserRole = 'user'): UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value)
    ? (value as UserRole)
    : fallback;
}

// ── Request helpers ──────────────────────────────────────────────────────────

/** Promise wrapper around `req.session.save`, so callers can `await` it. */
export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

/** The caller's IP as recorded in the audit log (45 chars fits IPv6). */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim().slice(0, 45);
  }
  const direct = req.ip ?? req.socket?.remoteAddress ?? null;
  return direct === null ? null : direct.slice(0, 45);
}

export function clientUserAgent(req: Request): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 512) : null;
}

export const authService = {
  // ── Authentication ────────────────────────────────────────────────────────

  /**
   * Verify a username/password pair.
   *
   * Returns null for "unknown user", "inactive user" and "wrong password"
   * alike — the caller must not be able to tell those apart, and neither must
   * the client. Throws {@link SsoOnlyError} only for an account that HAS no
   * local password, because there the honest answer changes what the user
   * should do next.
   */
  async authenticate(username: string, password: string): Promise<User | null> {
    const account = await userService.getWithSecrets(username);

    if (!account) {
      // Burn comparable time on the miss path: `comparePassword` with a null
      // hash does the same dummy bcrypt round the wrong-password path does.
      await comparePassword(password, null);
      return null;
    }

    if (!account.isActive) {
      await comparePassword(password, null);
      logger.info({ userId: account.id }, 'login: refused — account is inactive');
      return null;
    }

    if (!account.passwordHash) throw new SsoOnlyError(account.authSource);

    if (!(await comparePassword(password, account.passwordHash))) return null;

    // Strip the secrets before the value can escape into a response body.
    const { passwordHash: _hash, totpSecret: _secret, ...user } = account;
    return user;
  },

  // ── Tenancy ───────────────────────────────────────────────────────────────

  /**
   * The tenant a session lands on when nothing else was asked for: the master
   * tenant when the user can reach it (a platform admin always can), otherwise
   * their first membership. Returns null for an account with no tenant at all,
   * which the caller reports rather than papering over with tenant 1.
   */
  async resolveDefaultTenantId(userId: number): Promise<number | null> {
    const memberships = await permissionService.getTenantMemberships(userId);
    if (memberships.length === 0) return null;
    const master = memberships.find((membership) => membership.isMaster);
    return (master ?? memberships[0]).tenantId;
  },

  /**
   * Resolve a tenant SLUG (the cross-app identity — HARD RULE 13) to a local
   * tenant id, but only when this user may open it. Returns null for an
   * unknown slug and for one the user cannot reach; the caller treats both the
   * same, so a slug cannot be used to probe which tenants exist.
   */
  async resolveTenantSlugForUser(userId: number, slug: string): Promise<number | null> {
    const tenant = await tenantService.getBySlug(slug);
    if (!tenant) return null;
    return (await permissionService.hasTenantAccess(userId, tenant.id)) ? tenant.id : null;
  },

  // ── The session context ───────────────────────────────────────────────────

  /**
   * Everything `GET /api/auth/me` returns: the user, the active tenant, every
   * tenant they can switch to, and the capabilities resolved for the active
   * one.
   *
   * A `tenantId` the user can no longer reach is silently replaced by their
   * default: a membership revoked while a cookie was alive must not strand
   * the user on a dead tenant with no way to pick another.
   */
  async buildSessionContext(userId: number, tenantId?: number | null): Promise<SessionContext | null> {
    const user = await userService.getById(userId);
    if (!user || !user.isActive) return null;

    let activeTenantId = tenantId ?? null;
    if (activeTenantId !== null && !(await permissionService.hasTenantAccess(userId, activeTenantId))) {
      logger.info(
        { userId, tenantId: activeTenantId },
        'session: active tenant is out of reach — falling back to the default',
      );
      activeTenantId = null;
    }
    if (activeTenantId === null) activeTenantId = await this.resolveDefaultTenantId(userId);
    if (activeTenantId === null) return null;

    const [tenant, tenants, resolved] = await Promise.all([
      tenantService.getById(activeTenantId),
      permissionService.getTenantMemberships(userId),
      permissionService.resolve(userId, activeTenantId),
    ]);
    if (!tenant) return null;

    return {
      user,
      tenant,
      tenants,
      role: resolved.isPlatformAdmin ? 'admin' : resolved.tenantRole,
      capabilities: resolved.capabilities,
      teams: resolved.teams,
      isAdmin: resolved.isPlatformAdmin,
      isMasterTenant: tenant.isMaster,
    };
  },

  /**
   * Write the authenticated identity onto the session and return the tenant it
   * landed on. Clears the half-authenticated fields in the same breath, so a
   * session can never carry both.
   */
  async establishSession(req: Request, user: User, preferredTenantId?: number | null): Promise<number | null> {
    let tenantId = preferredTenantId ?? null;
    if (tenantId !== null && !(await permissionService.hasTenantAccess(user.id, tenantId))) tenantId = null;
    if (tenantId === null) tenantId = await this.resolveDefaultTenantId(user.id);

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    if (tenantId !== null) req.session.currentTenantId = tenantId;

    delete req.session.pendingUserId;
    delete req.session.pendingMfa;
    delete req.session.pendingMfaExpiresAt;
    delete req.session.pendingEmailOtpHash;

    return tenantId;
  },

  /**
   * `audit_log.tenant_id` is NOT NULL, so an auth event that happens outside a
   * tenant (a password reset, a lifecycle push from Obligate) still has to
   * name one. The user's default tenant is the honest answer; the master
   * tenant is the fallback for an account that belongs to none.
   */
  async auditTenantFor(userId: number | null): Promise<number | null> {
    if (userId !== null) {
      const own = await this.resolveDefaultTenantId(userId);
      if (own !== null) return own;
    }
    const master = await tenantService.getMaster();
    if (master) return master.id;
    const any = (await db('tenants').orderBy('id').first('id')) as { id: number } | undefined;
    return any?.id ?? null;
  },
};

export default authService;
