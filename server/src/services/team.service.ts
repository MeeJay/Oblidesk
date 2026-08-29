/**
 * team.service.ts — the human grouping.
 *
 * Teams are about PEOPLE and PERMISSIONS: "the network crew", "L1 support".
 * They carry a capability bundle that every member inherits, and they are
 * tenant-scoped (`teams.tenant_id`), so joining a team in one tenant grants
 * nothing in another.
 *
 * ── Teams are NOT assignment groups ───────────────────────────────────────
 * A ticket is routed to an `assignment_group` (migration 002), not to a team.
 * The two look similar and are deliberately separate:
 *
 *   • a TEAM answers "what may these people do?"  → capabilities, RBAC
 *   • an ASSIGNMENT GROUP answers "whose queue is this?" → routing, mailbox
 *
 * Fusing them would mean every routing change is also a permissions change,
 * which is how a desk ends up granting `ticket_delete` to whoever happens to
 * be on the escalation rota this week.
 *
 * `team_memberships` has no tenant_id of its own — it is a PARENT_SCOPED_TABLE
 * reached through the already-scoped `teams` row, which is why every query
 * below starts from `scoped('teams', …)` and joins outward.
 */

import { db, scoped, insertScoped, assertTenantId } from '../db';
import type { Capability, CreateTeamRequest, Team, UpdateTeamRequest } from '@oblidesk/shared';
import { sanitizeCapabilities } from '@oblidesk/shared';
import { auditService } from './audit.service';
import { permissionService } from './permission.service';

// ═════════════════════════════════════════════════════════════════════════════
// Rows
// ═════════════════════════════════════════════════════════════════════════════

interface TeamRow {
  id: number;
  tenant_id: number;
  name: string;
  description: string | null;
  capabilities: Capability[] | string;
  created_at: Date;
  updated_at: Date;
  member_count?: string | number;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseCapabilities(value: Capability[] | string | null): Capability[] {
  if (value === null || value === undefined) return [];
  const raw = typeof value === 'string' ? safeParse(value) : value;
  return sanitizeCapabilities(raw);
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function rowToTeam(row: TeamRow): Team {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    capabilities: parseCapabilities(row.capabilities),
    memberCount:
      row.member_count === undefined || row.member_count === null
        ? undefined
        : Number(row.member_count),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface TeamAuditContext {
  tenantId: number;
  actorId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface TeamMember {
  userId: number;
  username: string;
  displayName: string | null;
  email: string | null;
  isActive: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Service
// ═════════════════════════════════════════════════════════════════════════════

export const teamService = {
  /**
   * Every team in the tenant, with its member count.
   *
   * The count is a correlated subquery rather than a LEFT JOIN + GROUP BY: with
   * the join, a team's `capabilities` jsonb ends up in the GROUP BY clause,
   * which Postgres will do but which forces a sort over a jsonb column for no
   * reason. The subquery keeps the plan on the `idx_team_memberships_user`
   * index.
   */
  async list(tenantId: number): Promise<Team[]> {
    assertTenantId(tenantId);

    const rows = (await scoped('teams', tenantId)
      .select(
        'teams.*',
        db.raw(
          '(SELECT COUNT(*) FROM team_memberships WHERE team_memberships.team_id = teams.id) AS member_count',
        ),
      )
      .orderBy('teams.name')) as TeamRow[];

    return rows.map(rowToTeam);
  },

  async getById(tenantId: number, id: number): Promise<Team | null> {
    assertTenantId(tenantId);
    const row = (await scoped('teams', tenantId).where('teams.id', id).first('teams.*')) as
      | TeamRow
      | undefined;
    return row ? rowToTeam(row) : null;
  },

  async create(tenantId: number, data: CreateTeamRequest, ctx: TeamAuditContext): Promise<Team> {
    assertTenantId(tenantId);

    return db.transaction(async (trx) => {
      const capabilities = sanitizeCapabilities(data.capabilities ?? []);

      const [row] = (await insertScoped(
        'teams',
        tenantId,
        {
          name: data.name,
          description: data.description ?? null,
          capabilities: JSON.stringify(capabilities),
        },
        trx,
      ).returning('*')) as TeamRow[];

      const team = rowToTeam(row);

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'team.create',
          entityType: 'team',
          entityId: team.id,
          after: { name: team.name, description: team.description, capabilities: team.capabilities },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return team;
    });
  },

  async update(
    tenantId: number,
    id: number,
    data: UpdateTeamRequest,
    ctx: TeamAuditContext,
  ): Promise<Team | null> {
    assertTenantId(tenantId);

    const result = await db.transaction(async (trx) => {
      const existing = (await scoped('teams', tenantId, trx)
        .where('teams.id', id)
        .first('teams.*')) as TeamRow | undefined;
      if (!existing) return null;

      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (data.name !== undefined) patch.name = data.name;
      if (data.description !== undefined) patch.description = data.description;
      if (data.capabilities !== undefined) {
        // Unknown capability keys are dropped rather than rejected: a bundle
        // exported from a newer build must still import, minus what this build
        // does not understand. Silently keeping a key we cannot enforce would
        // be worse — it would look granted in the UI and do nothing.
        patch.capabilities = JSON.stringify(sanitizeCapabilities(data.capabilities));
      }

      const [row] = (await scoped('teams', tenantId, trx)
        .where('teams.id', id)
        .update(patch)
        .returning('*')) as TeamRow[];

      const team = rowToTeam(row);

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'team.update',
          entityType: 'team',
          entityId: id,
          before: {
            name: existing.name,
            description: existing.description,
            capabilities: parseCapabilities(existing.capabilities),
          },
          after: { name: team.name, description: team.description, capabilities: team.capabilities },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return team;
    });

    // A capability change alters what every member may do. Blow the whole
    // tenant's cache rather than trying to enumerate members — cheap, and
    // under-invalidating here means someone keeps a permission they just lost.
    if (result) permissionService.invalidateTenant(tenantId);
    return result;
  },

  async delete(tenantId: number, id: number, ctx: TeamAuditContext): Promise<boolean> {
    assertTenantId(tenantId);

    const deleted = await db.transaction(async (trx) => {
      const existing = (await scoped('teams', tenantId, trx)
        .where('teams.id', id)
        .first('teams.*')) as TeamRow | undefined;
      if (!existing) return false;

      // team_memberships cascades on the FK; nothing to clean up by hand.
      await scoped('teams', tenantId, trx).where('teams.id', id).del();

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'team.delete',
          entityType: 'team',
          entityId: id,
          before: {
            name: existing.name,
            description: existing.description,
            capabilities: parseCapabilities(existing.capabilities),
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return true;
    });

    if (deleted) permissionService.invalidateTenant(tenantId);
    return deleted;
  },

  // ── Members ──────────────────────────────────────────────────────────────

  async getMembers(tenantId: number, teamId: number): Promise<TeamMember[]> {
    assertTenantId(tenantId);

    const rows = (await scoped('teams', tenantId)
      .where('teams.id', teamId)
      .join('team_memberships', 'team_memberships.team_id', 'teams.id')
      .join('users', 'users.id', 'team_memberships.user_id')
      .orderBy('users.username')
      .select(
        'users.id as user_id',
        'users.username',
        'users.display_name',
        'users.email',
        'users.is_active',
      )) as Array<{
      user_id: number;
      username: string;
      display_name: string | null;
      email: string | null;
      is_active: boolean;
    }>;

    return rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      isActive: row.is_active,
    }));
  },

  /**
   * Replace the whole membership list in one transaction.
   *
   * Two guards that are easy to skip and expensive to skip:
   *  • the team must belong to THIS tenant (the id came from a URL);
   *  • every proposed member must already be a member of this tenant, so a
   *    crafted request cannot pull a user from another customer's tenant into
   *    a team and hand them its capabilities.
   */
  async setMembers(
    tenantId: number,
    teamId: number,
    userIds: number[],
    ctx: TeamAuditContext,
  ): Promise<TeamMember[] | null> {
    assertTenantId(tenantId);

    const result = await db.transaction(async (trx) => {
      const team = (await scoped('teams', tenantId, trx)
        .where('teams.id', teamId)
        .first('teams.id', 'teams.name')) as { id: number; name: string } | undefined;
      if (!team) return null;

      const unique = [...new Set(userIds)];

      // Only users who already belong to this tenant may join its teams.
      const allowed = (await scoped('user_tenants', tenantId, trx)
        .whereIn('user_tenants.user_id', unique.length > 0 ? unique : [-1])
        .select('user_tenants.user_id')) as Array<{ user_id: number }>;
      const allowedIds = new Set(allowed.map((row) => row.user_id));

      const rejected = unique.filter((id) => !allowedIds.has(id));
      if (rejected.length > 0) {
        throw new Error(
          `Refusing to add user(s) ${rejected.join(', ')} to team ${teamId}: ` +
            'they are not members of this tenant.',
        );
      }

      const before = (await trx('team_memberships')
        .where({ team_id: teamId })
        .select('user_id')) as Array<{ user_id: number }>;

      await trx('team_memberships').where({ team_id: teamId }).del();
      if (allowedIds.size > 0) {
        await trx('team_memberships').insert(
          [...allowedIds].map((userId) => ({ team_id: teamId, user_id: userId })),
        );
      }

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'team.set_members',
          entityType: 'team',
          entityId: teamId,
          before: { userIds: before.map((row) => row.user_id) },
          after: { userIds: [...allowedIds] },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return true;
    });

    if (!result) return null;

    permissionService.invalidateTenant(tenantId);
    return teamService.getMembers(tenantId, teamId);
  },

  async addMember(
    tenantId: number,
    teamId: number,
    userId: number,
    ctx: TeamAuditContext,
  ): Promise<boolean> {
    assertTenantId(tenantId);

    const added = await db.transaction(async (trx) => {
      const team = (await scoped('teams', tenantId, trx)
        .where('teams.id', teamId)
        .first('teams.id')) as { id: number } | undefined;
      if (!team) return false;

      const member = (await scoped('user_tenants', tenantId, trx)
        .where('user_tenants.user_id', userId)
        .first('user_tenants.user_id')) as { user_id: number } | undefined;
      if (!member) {
        throw new Error(`User ${userId} is not a member of this tenant.`);
      }

      await trx('team_memberships')
        .insert({ team_id: teamId, user_id: userId })
        .onConflict(['team_id', 'user_id'])
        .ignore();

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'team.add_member',
          entityType: 'team',
          entityId: teamId,
          after: { userId },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return true;
    });

    if (added) permissionService.invalidate(userId, tenantId);
    return added;
  },

  async removeMember(
    tenantId: number,
    teamId: number,
    userId: number,
    ctx: TeamAuditContext,
  ): Promise<boolean> {
    assertTenantId(tenantId);

    const removed = await db.transaction(async (trx) => {
      const team = (await scoped('teams', tenantId, trx)
        .where('teams.id', teamId)
        .first('teams.id')) as { id: number } | undefined;
      if (!team) return false;

      const count = await trx('team_memberships')
        .where({ team_id: teamId, user_id: userId })
        .del();
      if (count === 0) return false;

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'team.remove_member',
          entityType: 'team',
          entityId: teamId,
          before: { userId },
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

  /** The teams one user belongs to, inside one tenant. */
  async getTeamsForUser(tenantId: number, userId: number): Promise<Team[]> {
    assertTenantId(tenantId);
    const rows = (await scoped('teams', tenantId)
      .join('team_memberships', 'team_memberships.team_id', 'teams.id')
      .where('team_memberships.user_id', userId)
      .orderBy('teams.name')
      .select('teams.*')) as TeamRow[];
    return rows.map(rowToTeam);
  },

  /**
   * User ids in a team — the recipient list when a notification binding or an
   * escalation targets a team rather than an individual.
   */
  async getMemberIds(tenantId: number, teamId: number): Promise<number[]> {
    assertTenantId(tenantId);
    const rows = (await scoped('teams', tenantId)
      .where('teams.id', teamId)
      .join('team_memberships', 'team_memberships.team_id', 'teams.id')
      .select('team_memberships.user_id')) as Array<{ user_id: number }>;
    return rows.map((row) => row.user_id);
  },
};

export default teamService;
