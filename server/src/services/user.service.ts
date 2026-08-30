/**
 * user.service.ts — the global user account.
 *
 * `users` is one of the few genuinely GLOBAL tables (see GLOBAL_TABLES in
 * server/src/db/index.ts): one account works across several tenants, and what
 * it may DO in each of them lives in `user_tenants` + the tenant-scoped
 * permission sets and teams. So this module talks to `db('users')` directly —
 * that is correct here and a defect anywhere tenant data is involved.
 *
 * Two consequences follow from users being global, and both are enforced below:
 *
 *  • LISTING users is tenant-scoped even though the table is not. A tenant
 *    admin must see the members of THEIR tenant, not every account on the
 *    installation. `listForTenant()` joins through `user_tenants`; only
 *    `listAll()` (platform admin) skips that.
 *
 *  • DELETING a user is a platform action with tenant-wide consequences. The
 *    FKs are ON DELETE SET NULL for history (audit_log.actor_id,
 *    tickets.assignee_id) precisely so that deleting an account never deletes
 *    the record of what they did. Deactivating is almost always the right call
 *    and `deactivate()` exists to make it the easy one.
 */

import bcrypt from 'bcrypt';
import type { Knex } from 'knex';
import { db, scoped, insertScoped, assertTenantId } from '../db';
import { AppError } from '../middleware/errorHandler';
import type {
  CreateUserRequest,
  UpdateUserRequest,
  User,
  UserPreferences,
  UserRole,
  AuthSource,
} from '@oblidesk/shared';
import { PAGINATION } from '@oblidesk/shared';
import { auditService } from './audit.service';
import { permissionService } from './permission.service';

const BCRYPT_ROUNDS = 12;

// ═════════════════════════════════════════════════════════════════════════════
// Rows
// ═════════════════════════════════════════════════════════════════════════════

interface UserRow {
  id: number;
  username: string;
  password_hash: string | null;
  display_name: string | null;
  email: string | null;
  role: string;
  is_active: boolean;
  avatar: string | null;
  totp_secret: string | null;
  totp_enabled: boolean;
  email_otp_enabled: boolean;
  preferences: UserPreferences | string | null;
  preferred_language: string;
  enrollment_version: number;
  obligate_user_id: number | null;
  auth_source: string;
  created_at: Date;
  updated_at: Date;
}

/** Columns safe to select. `password_hash` and `totp_secret` are never among them. */
const PUBLIC_COLUMNS = [
  'id',
  'username',
  'display_name',
  'email',
  'role',
  'is_active',
  'avatar',
  'totp_enabled',
  'email_otp_enabled',
  'preferences',
  'preferred_language',
  'enrollment_version',
  'obligate_user_id',
  'auth_source',
  'created_at',
  'updated_at',
] as const;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parsePreferences(value: UserPreferences | string | null): UserPreferences | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as UserPreferences;
    } catch {
      return null;
    }
  }
  return value;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role as UserRole,
    isActive: row.is_active,
    avatar: row.avatar,
    totpEnabled: row.totp_enabled,
    emailOtpEnabled: row.email_otp_enabled,
    preferences: parsePreferences(row.preferences),
    preferredLanguage: row.preferred_language,
    enrollmentVersion: row.enrollment_version,
    obligateUserId: row.obligate_user_id,
    authSource: row.auth_source as AuthSource,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** What lands in an audit row. Never a hash, never a TOTP secret. */
function forAudit(user: User): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    preferredLanguage: user.preferredLanguage,
    authSource: user.authSource,
  };
}

export interface UserAuditContext {
  tenantId: number;
  actorId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface UserListQuery {
  q?: string;
  role?: UserRole;
  isActive?: boolean;
  page?: number;
  limit?: number;
}

/** A tenant member: the global account plus the role they hold HERE. */
export interface TenantMember extends User {
  tenantRole: UserRole;
  teams: Array<{ id: number; name: string }>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Service
// ═════════════════════════════════════════════════════════════════════════════

export const userService = {
  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * Members of ONE tenant. This is the list a tenant admin sees — the users
   * table is global, but showing every account on a multi-tenant installation
   * to one customer's admin would be a data leak dressed up as a feature.
   */
  async listForTenant(
    tenantId: number,
    query: UserListQuery = {},
  ): Promise<{ users: TenantMember[]; total: number; page: number; limit: number }> {
    assertTenantId(tenantId);

    const limit = Math.min(Math.max(1, query.limit ?? PAGINATION.defaultLimit), PAGINATION.maxLimit);
    const page = Math.max(1, query.page ?? 1);

    const applyFilters = (builder: Knex.QueryBuilder): Knex.QueryBuilder => {
      builder.join('users', 'users.id', 'user_tenants.user_id');
      if (query.q) {
        const needle = `%${query.q}%`;
        builder.where((sub) =>
          sub
            .whereILike('users.username', needle)
            .orWhereILike('users.display_name', needle)
            .orWhereILike('users.email', needle),
        );
      }
      if (query.role) builder.where('user_tenants.role', query.role);
      if (query.isActive !== undefined) builder.where('users.is_active', query.isActive);
      return builder;
    };

    const countRow = (await applyFilters(scoped('user_tenants', tenantId)).count<{ count: string }[]>(
      'users.id as count',
    )) as unknown as Array<{ count: string }>;
    const total = Number(countRow[0]?.count ?? 0);

    const rows = (await applyFilters(scoped('user_tenants', tenantId))
      .orderBy('users.username')
      .limit(limit)
      .offset((page - 1) * limit)
      .select(
        ...PUBLIC_COLUMNS.map((column) => `users.${column}`),
        db.raw('user_tenants.role as tenant_role'),
      )) as Array<UserRow & { tenant_role: string }>;

    if (rows.length === 0) return { users: [], total, page, limit };

    // One query for every member's teams rather than N — a 200-agent tenant
    // would otherwise open 200 connections to render one page.
    const teamRows = (await scoped('teams', tenantId)
      .join('team_memberships', 'team_memberships.team_id', 'teams.id')
      .whereIn(
        'team_memberships.user_id',
        rows.map((row) => row.id),
      )
      .select('team_memberships.user_id', 'teams.id', 'teams.name')) as Array<{
      user_id: number;
      id: number;
      name: string;
    }>;

    const teamsByUser = new Map<number, Array<{ id: number; name: string }>>();
    for (const team of teamRows) {
      const list = teamsByUser.get(team.user_id) ?? [];
      list.push({ id: team.id, name: team.name });
      teamsByUser.set(team.user_id, list);
    }

    return {
      users: rows.map((row) => ({
        ...rowToUser(row),
        tenantRole: row.tenant_role as UserRole,
        teams: teamsByUser.get(row.id) ?? [],
      })),
      total,
      page,
      limit,
    };
  },

  /** Every account on the installation. PLATFORM ADMIN ONLY. */
  async listAll(
    query: UserListQuery = {},
  ): Promise<{ users: User[]; total: number; page: number; limit: number }> {
    const limit = Math.min(Math.max(1, query.limit ?? PAGINATION.defaultLimit), PAGINATION.maxLimit);
    const page = Math.max(1, query.page ?? 1);

    const applyFilters = (builder: Knex.QueryBuilder): Knex.QueryBuilder => {
      if (query.q) {
        const needle = `%${query.q}%`;
        builder.where((sub) =>
          sub
            .whereILike('username', needle)
            .orWhereILike('display_name', needle)
            .orWhereILike('email', needle),
        );
      }
      if (query.role) builder.where('role', query.role);
      if (query.isActive !== undefined) builder.where('is_active', query.isActive);
      return builder;
    };

    const countRow = (await applyFilters(db('users')).count<{ count: string }[]>(
      'id as count',
    )) as unknown as Array<{ count: string }>;
    const total = Number(countRow[0]?.count ?? 0);

    const rows = (await applyFilters(db('users'))
      .orderBy('username')
      .limit(limit)
      .offset((page - 1) * limit)
      .select(...PUBLIC_COLUMNS)) as UserRow[];

    return { users: rows.map(rowToUser), total, page, limit };
  },

  async getById(id: number): Promise<User | null> {
    const row = (await db('users').where({ id }).first(...PUBLIC_COLUMNS)) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  },

  async getByUsername(username: string): Promise<User | null> {
    // `username` is citext — 'Admin' and 'admin' are the same login, enforced
    // by the column type rather than by every call site remembering lower().
    const row = (await db('users').where({ username }).first(...PUBLIC_COLUMNS)) as
      | UserRow
      | undefined;
    return row ? rowToUser(row) : null;
  },

  /** Resolve several ids at once — for assignee columns, watcher lists, mentions. */
  async getManyByIds(ids: number[]): Promise<Map<number, User>> {
    if (ids.length === 0) return new Map();
    const rows = (await db('users')
      .whereIn('id', [...new Set(ids)])
      .select(...PUBLIC_COLUMNS)) as UserRow[];
    return new Map(rows.map((row) => [row.id, rowToUser(row)]));
  },

  /**
   * The row including `password_hash`. Only the auth path may call this, and it
   * is deliberately NOT named `getById` so it cannot be reached by accident
   * from a route that serialises whatever it gets.
   */
  async getWithSecrets(
    username: string,
  ): Promise<(User & { passwordHash: string | null; totpSecret: string | null }) | null> {
    const row = (await db('users').where({ username }).first()) as UserRow | undefined;
    if (!row) return null;
    return {
      ...rowToUser(row),
      passwordHash: row.password_hash,
      totpSecret: row.totp_secret,
    };
  },

  // ── Writes ───────────────────────────────────────────────────────────────

  /**
   * Create an account and, when `ctx.tenantId` is given, make it a member of
   * that tenant in the same transaction. Creating a user who belongs to no
   * tenant is possible (a platform admin does) but is almost never what a
   * tenant admin means, so the tenant-scoped route always passes it.
   */
  async create(
    data: CreateUserRequest & { tenantRole?: UserRole },
    ctx: UserAuditContext,
  ): Promise<User> {
    assertTenantId(ctx.tenantId);

    return db.transaction(async (trx) => {
      const passwordHash = data.password ? await bcrypt.hash(data.password, BCRYPT_ROUNDS) : null;

      const [row] = (await trx('users')
        .insert({
          username: data.username,
          password_hash: passwordHash,
          display_name: data.displayName ?? null,
          email: data.email ?? null,
          role: data.role ?? 'user',
          is_active: data.isActive ?? true,
          preferred_language: data.preferredLanguage ?? 'en',
          auth_source: 'local',
          preferences: JSON.stringify({}),
        })
        .returning('*')) as UserRow[];

      const user = rowToUser(row);

      await insertScoped(
        'user_tenants',
        ctx.tenantId,
        {
          user_id: user.id,
          role: data.tenantRole ?? data.role ?? 'agent',
          capabilities: null,
        },
        trx,
      )
        .onConflict(['user_id', 'tenant_id'])
        .ignore();

      await auditService.record(
        {
          tenantId: ctx.tenantId,
          actorId: ctx.actorId ?? null,
          action: 'user.create',
          entityType: 'user',
          entityId: user.id,
          after: forAudit(user),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      permissionService.invalidate(user.id);
      return user;
    });
  },

  async update(id: number, data: UpdateUserRequest, ctx: UserAuditContext): Promise<User | null> {
    assertTenantId(ctx.tenantId);

    return db.transaction(async (trx) => {
      const before = (await trx('users').where({ id }).first(...PUBLIC_COLUMNS)) as
        | UserRow
        | undefined;
      if (!before) return null;

      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (data.displayName !== undefined) patch.display_name = data.displayName;
      if (data.email !== undefined) patch.email = data.email;
      if (data.role !== undefined) patch.role = data.role;
      if (data.isActive !== undefined) patch.is_active = data.isActive;
      if (data.preferredLanguage !== undefined) patch.preferred_language = data.preferredLanguage;
      if (data.avatar !== undefined) patch.avatar = data.avatar;
      if (data.preferences !== undefined) {
        patch.preferences = data.preferences === null ? null : JSON.stringify(data.preferences);
      }
      if (data.password) patch.password_hash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);

      const [row] = (await trx('users')
        .where({ id })
        .update(patch)
        .returning(PUBLIC_COLUMNS as unknown as string[])) as UserRow[];

      const user = rowToUser(row);

      await auditService.record(
        {
          tenantId: ctx.tenantId,
          actorId: ctx.actorId ?? null,
          action: 'user.update',
          entityType: 'user',
          entityId: id,
          before: forAudit(rowToUser(before)),
          after: forAudit(user),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      permissionService.invalidate(id);
      return user;
    });
  },

  /**
   * Set a password. Bumps `enrollment_version`, which every live session
   * carries: incrementing it is what makes an admin-forced password change
   * actually log the user out everywhere instead of leaving the old session
   * happily authenticated.
   */
  async setPassword(
    id: number,
    newPassword: string,
    ctx: UserAuditContext,
  ): Promise<boolean> {
    assertTenantId(ctx.tenantId);

    return db.transaction(async (trx) => {
      const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      const updated = await trx('users').where({ id }).update({
        password_hash: hash,
        enrollment_version: trx.raw('enrollment_version + 1'),
        updated_at: new Date(),
      });
      if (updated === 0) return false;

      await auditService.record(
        {
          tenantId: ctx.tenantId,
          actorId: ctx.actorId ?? null,
          action: 'user.password_change',
          entityType: 'user',
          entityId: id,
          // No before/after: there is nothing about a password worth recording
          // beyond the fact that it changed, and anything more is a liability.
          after: { changed: true },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return true;
    });
  },

  /** Verify a plaintext password against the stored hash. */
  async verifyPassword(username: string, password: string): Promise<User | null> {
    const row = (await db('users').where({ username }).first()) as UserRow | undefined;
    if (!row || !row.is_active || !row.password_hash) return null;
    const ok = await bcrypt.compare(password, row.password_hash);
    return ok ? rowToUser(row) : null;
  },

  /**
   * Deactivate rather than delete. Keeps every foreign key intact, keeps the
   * name on the tickets they worked, and is reversible — which `delete()` is
   * not.
   */
  async deactivate(id: number, ctx: UserAuditContext): Promise<boolean> {
    return Boolean(await userService.update(id, { isActive: false }, ctx));
  },

  /**
   * Hard-delete an account. PLATFORM ADMIN ONLY.
   *
   * The FKs pointing here are ON DELETE SET NULL (audit_log.actor_id,
   * tickets.assignee_id, config_objects.created_by…), so history survives with
   * a null actor rather than disappearing. The audit row is written BEFORE the
   * delete, inside the same transaction — writing it afterwards would leave a
   * row whose `actor_id` was just nulled by its own cascade.
   */
  async delete(id: number, ctx: UserAuditContext): Promise<boolean> {
    assertTenantId(ctx.tenantId);

    return db.transaction(async (trx) => {
      const before = (await trx('users').where({ id }).first(...PUBLIC_COLUMNS)) as
        | UserRow
        | undefined;
      if (!before) return false;

      await auditService.record(
        {
          tenantId: ctx.tenantId,
          actorId: ctx.actorId ?? null,
          action: 'user.delete',
          entityType: 'user',
          entityId: id,
          before: forAudit(rowToUser(before)),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      // A pending approval step naming this person, with no group behind them,
      // is the one thing the purge genuinely must not blank: the FK would set
      // it to null and strand a running approval nobody can decide. Postgres
      // already refuses it through approval_steps_approver_ck, but from inside
      // the RI trigger, where the only thing the operator sees is a 23514 and a
      // 500. Asking first turns that into a sentence they can act on.
      const stranded = (await trx('approval_steps')
        .where('approval_steps.approver_user_id', id)
        .where('approval_steps.state', 'pending')
        .whereNull('approval_steps.approver_group_id')
        .count<[{ count: string }]>('* as count')) as unknown as [{ count: string }];

      if (Number(stranded[0].count) > 0) {
        throw new AppError(
          409,
          `This account is the only approver on ${stranded[0].count} approval step(s) that are still ` +
            'pending. Reassign or cancel those approvals first, then remove the account.',
          { code: 'conflict' },
        );
      }

      await trx('users').where({ id }).del();
      permissionService.invalidate(id);
      return true;
    });
  },

  // ── Tenant membership ────────────────────────────────────────────────────

  /** Add or update this user's membership of one tenant. */
  async setTenantMembership(
    userId: number,
    tenantId: number,
    role: UserRole,
    ctx: Omit<UserAuditContext, 'tenantId'>,
  ): Promise<void> {
    assertTenantId(tenantId);

    await db.transaction(async (trx) => {
      const before = (await scoped('user_tenants', tenantId, trx)
        .where('user_tenants.user_id', userId)
        .first('role')) as { role: string } | undefined;

      await insertScoped('user_tenants', tenantId, { user_id: userId, role }, trx)
        .onConflict(['user_id', 'tenant_id'])
        .merge({ role });

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: before ? 'user.tenant_role_change' : 'user.tenant_add',
          entityType: 'user',
          entityId: userId,
          before: before ? { role: before.role } : null,
          after: { role },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );
    });

    permissionService.invalidate(userId, tenantId);
  },

  async removeTenantMembership(
    userId: number,
    tenantId: number,
    ctx: Omit<UserAuditContext, 'tenantId'>,
  ): Promise<boolean> {
    assertTenantId(tenantId);

    const removed = await db.transaction(async (trx) => {
      const before = (await scoped('user_tenants', tenantId, trx)
        .where('user_tenants.user_id', userId)
        .first('role')) as { role: string } | undefined;
      if (!before) return false;

      await scoped('user_tenants', tenantId, trx).where('user_tenants.user_id', userId).del();

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'user.tenant_remove',
          entityType: 'user',
          entityId: userId,
          before: { role: before.role },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );
      return true;
    });

    if (removed) permissionService.invalidate(userId, tenantId);
    return removed;
  },

  /**
   * Replace every tenant assignment for one user in a single transaction.
   * A full replace rather than a diff: the admin screen shows the complete
   * grid, so a partial apply would leave the UI and the database disagreeing
   * about a checkbox the admin just unticked.
   */
  async setTenantAssignments(
    userId: number,
    assignments: Array<{ tenantId: number; role: UserRole }>,
    ctx: Omit<UserAuditContext, 'tenantId'> & { tenantId: number },
  ): Promise<void> {
    assertTenantId(ctx.tenantId);

    await db.transaction(async (trx) => {
      // DELIBERATELY UNSCOPED, and the only place in this module that is.
      // This method answers "which tenants does this account belong to?",
      // which is a question ABOUT the set of tenants — scoping it to one would
      // make a full replace impossible. `scoped()` is the right default
      // precisely because exceptions like this one have to be argued for; the
      // guard is that the route behind it is platform-admin only.
      const before = (await trx('user_tenants')
        .where({ user_id: userId })
        .select('tenant_id', 'role')) as Array<{ tenant_id: number; role: string }>;

      await trx('user_tenants').where({ user_id: userId }).del();

      if (assignments.length > 0) {
        await trx('user_tenants').insert(
          assignments.map((assignment) => ({
            user_id: userId,
            tenant_id: assignment.tenantId,
            role: assignment.role,
          })),
        );
      }

      await auditService.record(
        {
          tenantId: ctx.tenantId,
          actorId: ctx.actorId ?? null,
          action: 'user.tenant_assignments',
          entityType: 'user',
          entityId: userId,
          before: { assignments: before.map((row) => ({ tenantId: row.tenant_id, role: row.role })) },
          after: { assignments },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );
    });

    permissionService.invalidate(userId);
  },

  // ── Self-service (profile) ───────────────────────────────────────────────

  /**
   * The user editing their own account. Deliberately a different method from
   * `update()`: it accepts only the fields a person may change about
   * themselves, so a crafted request body cannot promote its own role by
   * hitting the profile endpoint.
   */
  async updateOwnProfile(
    id: number,
    data: {
      displayName?: string | null;
      email?: string | null;
      preferredLanguage?: string;
      avatar?: string | null;
      preferences?: UserPreferences | null;
    },
    ctx: UserAuditContext,
  ): Promise<User | null> {
    assertTenantId(ctx.tenantId);

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (data.displayName !== undefined) patch.display_name = data.displayName;
    if (data.email !== undefined) patch.email = data.email;
    if (data.preferredLanguage !== undefined) patch.preferred_language = data.preferredLanguage;
    if (data.avatar !== undefined) patch.avatar = data.avatar;
    if (data.preferences !== undefined) {
      patch.preferences = data.preferences === null ? null : JSON.stringify(data.preferences);
    }

    return db.transaction(async (trx) => {
      const [row] = (await trx('users')
        .where({ id })
        .update(patch)
        .returning(PUBLIC_COLUMNS as unknown as string[])) as UserRow[];
      if (!row) return null;

      await auditService.record(
        {
          tenantId: ctx.tenantId,
          actorId: id,
          action: 'profile.update',
          entityType: 'user',
          entityId: id,
          after: forAudit(rowToUser(row)),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return rowToUser(row);
    });
  },

  /**
   * Change one's own password, verifying the current one first. Returns
   * `'wrong_password'` rather than throwing so the route can answer 400 without
   * inspecting an error message.
   */
  async changeOwnPassword(
    id: number,
    currentPassword: string,
    newPassword: string,
    ctx: UserAuditContext,
  ): Promise<'ok' | 'wrong_password' | 'not_found'> {
    const row = (await db('users').where({ id }).first()) as UserRow | undefined;
    if (!row) return 'not_found';

    // An SSO-only account has no local password to verify — and setting one
    // here would create a second credential path nobody expects to exist.
    if (!row.password_hash) return 'wrong_password';

    const ok = await bcrypt.compare(currentPassword, row.password_hash);
    if (!ok) return 'wrong_password';

    await userService.setPassword(id, newPassword, { ...ctx, actorId: id });
    return 'ok';
  },

  /** Only the preferences blob — the autosave path behind every UI toggle. */
  async setPreferences(id: number, preferences: UserPreferences): Promise<UserPreferences | null> {
    const [row] = (await db('users')
      .where({ id })
      .update({ preferences: JSON.stringify(preferences), updated_at: new Date() })
      .returning(PUBLIC_COLUMNS as unknown as string[])) as UserRow[];
    return row ? parsePreferences(row.preferences) : null;
  },
};

export default userService;
