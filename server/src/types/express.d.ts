/**
 * express.d.ts — the shape of a request once Oblidesk's middleware has run.
 *
 * Two augmentations live here and nowhere else, so there is exactly one
 * declaration of each and TypeScript cannot end up merging two subtly different
 * versions from two files:
 *
 *   • `Express.Request`      — what `requireAuth` / `requireTenant` / `rbac`
 *                              attach.
 *   • `SessionData`          — what we are allowed to put in the session cookie
 *                              store.
 *
 * `req.scoped` is the important one. HARD RULE 1 says every tenant-data query
 * goes through `scoped(table, tenantId)`; binding it to the request means a
 * route handler cannot accidentally scope to the wrong tenant, because it never
 * types a tenant id at all — it writes `req.scoped('tickets')`.
 */
import type { Knex } from 'knex';
import type { Capability, UserRole } from '@oblidesk/shared';

declare global {
  namespace Express {
    interface Request {
      /**
       * The tenant this request operates in. Set by `requireTenant`; reading it
       * on a route that did not run `requireTenant` is a programming error and
       * the tenant helpers will throw rather than return cross-tenant rows.
       */
      tenantId: number;

      /** The tenant's slug — the cross-app identity (HARD RULE 13). */
      tenantSlug: string;

      /** The caller's role INSIDE `tenantId` (may differ from `users.role`). */
      tenantRole: UserRole;

      /**
       * True when the caller is an admin of the master tenant and is therefore
       * acting across tenant boundaries (the MSP console). Membership checks
       * are skipped for them; audit rows still record who did what.
       */
      isMasterAdmin: boolean;

      /** True when `users.role === 'admin'` (platform admin). */
      isPlatformAdmin: boolean;

      /**
       * Expanded capability set for (user, tenant). Populated lazily by
       * `resolveRequestCapabilities`; prefer that helper over reading this.
       */
      capabilities?: Capability[];

      /** Tenant-bound `scoped()` — the sanctioned way to touch tenant data. */
      scoped: (table: string, executor?: Knex | Knex.Transaction) => Knex.QueryBuilder;

      /** Tenant-bound `scopedAs()`, for joins that need an alias. */
      scopedAs: (
        table: string,
        alias: string,
        executor?: Knex | Knex.Transaction,
      ) => Knex.QueryBuilder;

      /** Tenant-bound `scopedOrGlobal()` for the nullable-tenant tables. */
      scopedOrGlobal: (table: string, executor?: Knex | Knex.Transaction) => Knex.QueryBuilder;

      /** Tenant-bound `insertScoped()` — stamps tenant_id on every row. */
      insertScoped: <T extends Record<string, unknown>>(
        table: string,
        rows: T | T[],
        executor?: Knex | Knex.Transaction,
      ) => Knex.QueryBuilder;
    }
  }
}

declare module 'express-session' {
  interface SessionData {
    /** Set only once authentication has fully completed (2FA included). */
    userId: number;
    username: string;
    /** Platform role from `users.role`. Tenant role lives on the request. */
    role: UserRole;
    /** The tenant the user is currently working in. */
    currentTenantId: number;

    /** Obligate SSO handshake state. */
    oauthState?: string;
    oauthNonce?: string;
    requestedTenantSlug?: string;
    postLoginRedirect?: string;

    /** Half-authenticated state while a second factor is outstanding. */
    pendingUserId?: number;
    pendingMfa?: 'totp' | 'email_otp';
    pendingMfaExpiresAt?: number;
    pendingEmailOtpHash?: string;
  }
}

export {};
