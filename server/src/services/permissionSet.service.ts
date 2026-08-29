/**
 * permissionSet.service.ts — named capability bundles.
 *
 * A permission set is a reusable answer to "what does an Agent get?" that an
 * admin can edit once instead of ticking twenty boxes per user. Sets are
 * tenant-scoped, assigned through `user_permission_sets`, and unioned into the
 * effective capabilities by `permission.service.resolve()`.
 *
 * ── `is_system` sets ──────────────────────────────────────────────────────
 * The seed ships the presets from `CAPABILITY_PRESETS` (@oblidesk/shared) with
 * `is_system = true`. They are RENAMEABLE and their capability list is
 * EDITABLE — an admin who wants "Agent" to include `ticket_delete` should be
 * able to say so — but they are NOT DELETABLE, because a routing rule, an
 * escalation or an SSO role mapping can reference them by name, and deleting
 * the target of a reference is how a desk quietly stops granting anything.
 *
 * Cloning is offered instead, and `clone()` exists so the UI has a one-click
 * answer when someone tries to delete a system set.
 */

import { db, scoped, insertScoped, assertTenantId } from '../db';
import type {
  Capability,
  CreatePermissionSetRequest,
  PermissionSet,
  UpdatePermissionSetRequest,
} from '@oblidesk/shared';
import {
  CAPABILITY_CATALOG,
  CAPABILITY_GROUPS,
  CAPABILITY_PRESETS,
  expandCapabilities,
  sanitizeCapabilities,
} from '@oblidesk/shared';
import { auditService } from './audit.service';
import { permissionService } from './permission.service';

// ═════════════════════════════════════════════════════════════════════════════
// Rows
// ═════════════════════════════════════════════════════════════════════════════

interface PermissionSetRow {
  id: number;
  tenant_id: number;
  name: string;
  description: string | null;
  capabilities: Capability[] | string;
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
  assignee_count?: string | number;
}

function parseCapabilities(value: Capability[] | string | null): Capability[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    try {
      return sanitizeCapabilities(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return sanitizeCapabilities(value);
}

function rowToSet(row: PermissionSetRow): PermissionSet {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    capabilities: parseCapabilities(row.capabilities),
    isSystem: row.is_system,
  };
}

export interface PermissionSetAuditContext {
  tenantId: number;
  actorId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** A set plus how many people hold it — what the admin list shows. */
export interface PermissionSetWithUsage extends PermissionSet {
  assigneeCount: number;
  /** Capabilities after the `implies` closure — what holders REALLY get. */
  effectiveCapabilities: Capability[];
}

/** The capability picker's data: grouped, labelled, ready for `t(key, fallback)`. */
export interface CapabilityCatalogView {
  groups: Array<{
    group: string;
    capabilities: Array<{
      key: Capability;
      label: string;
      labelKey: string;
      description: string;
      implies: readonly Capability[];
      sensitive: boolean;
    }>;
  }>;
  presets: typeof CAPABILITY_PRESETS;
}

// ═════════════════════════════════════════════════════════════════════════════
// Service
// ═════════════════════════════════════════════════════════════════════════════

export const permissionSetService = {
  /**
   * All sets in the tenant, system ones first (they are the defaults people
   * look for), each with its assignee count and its EXPANDED capability list.
   *
   * Showing the expansion matters: an admin who ticks `config_admin` and sees
   * one checkbox has no idea they just granted seven capabilities. The list is
   * how the UI can say so before they save.
   */
  async list(tenantId: number): Promise<PermissionSetWithUsage[]> {
    assertTenantId(tenantId);

    const rows = (await scoped('permission_sets', tenantId)
      .select(
        'permission_sets.*',
        db.raw(
          '(SELECT COUNT(*) FROM user_permission_sets ' +
            'WHERE user_permission_sets.permission_set_id = permission_sets.id) AS assignee_count',
        ),
      )
      .orderBy('permission_sets.is_system', 'desc')
      .orderBy('permission_sets.name')) as PermissionSetRow[];

    return rows.map((row) => {
      const set = rowToSet(row);
      return {
        ...set,
        assigneeCount: Number(row.assignee_count ?? 0),
        effectiveCapabilities: expandCapabilities(set.capabilities),
      };
    });
  },

  async getById(tenantId: number, id: number): Promise<PermissionSet | null> {
    assertTenantId(tenantId);
    const row = (await scoped('permission_sets', tenantId)
      .where('permission_sets.id', id)
      .first('permission_sets.*')) as PermissionSetRow | undefined;
    return row ? rowToSet(row) : null;
  },

  async getByName(tenantId: number, name: string): Promise<PermissionSet | null> {
    assertTenantId(tenantId);
    const row = (await scoped('permission_sets', tenantId)
      .where('permission_sets.name', name)
      .first('permission_sets.*')) as PermissionSetRow | undefined;
    return row ? rowToSet(row) : null;
  },

  async create(
    tenantId: number,
    data: CreatePermissionSetRequest,
    ctx: PermissionSetAuditContext,
  ): Promise<PermissionSet> {
    assertTenantId(tenantId);

    return db.transaction(async (trx) => {
      const capabilities = sanitizeCapabilities(data.capabilities);

      const [row] = (await insertScoped(
        'permission_sets',
        tenantId,
        {
          name: data.name,
          description: data.description ?? null,
          capabilities: JSON.stringify(capabilities),
          is_system: false,
        },
        trx,
      ).returning('*')) as PermissionSetRow[];

      const set = rowToSet(row);

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'permission_set.create',
          entityType: 'permission_set',
          entityId: set.id,
          after: { name: set.name, capabilities: set.capabilities },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return set;
    });
  },

  async update(
    tenantId: number,
    id: number,
    data: UpdatePermissionSetRequest,
    ctx: PermissionSetAuditContext,
  ): Promise<PermissionSet | null> {
    assertTenantId(tenantId);

    const result = await db.transaction(async (trx) => {
      const existing = (await scoped('permission_sets', tenantId, trx)
        .where('permission_sets.id', id)
        .first('permission_sets.*')) as PermissionSetRow | undefined;
      if (!existing) return null;

      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (data.name !== undefined) patch.name = data.name;
      if (data.description !== undefined) patch.description = data.description;
      if (data.capabilities !== undefined) {
        patch.capabilities = JSON.stringify(sanitizeCapabilities(data.capabilities));
      }

      const [row] = (await scoped('permission_sets', tenantId, trx)
        .where('permission_sets.id', id)
        .update(patch)
        .returning('*')) as PermissionSetRow[];

      const set = rowToSet(row);

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'permission_set.update',
          entityType: 'permission_set',
          entityId: id,
          before: {
            name: existing.name,
            capabilities: parseCapabilities(existing.capabilities),
            isSystem: existing.is_system,
          },
          after: { name: set.name, capabilities: set.capabilities },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return set;
    });

    if (result) permissionService.invalidateTenant(tenantId);
    return result;
  },

  /**
   * Delete a non-system set. Throws (rather than returning false) when the set
   * is a system one, so the route can answer 400 with the reason instead of a
   * bare 404 that looks like the set does not exist.
   */
  async delete(
    tenantId: number,
    id: number,
    ctx: PermissionSetAuditContext,
  ): Promise<boolean> {
    assertTenantId(tenantId);

    const deleted = await db.transaction(async (trx) => {
      const existing = (await scoped('permission_sets', tenantId, trx)
        .where('permission_sets.id', id)
        .first('permission_sets.*')) as PermissionSetRow | undefined;
      if (!existing) return false;

      if (existing.is_system) {
        throw new Error(
          `"${existing.name}" is a system permission set and cannot be deleted. Clone it instead.`,
        );
      }

      // user_permission_sets cascades on the FK — the assignments go with it,
      // which is exactly why the list view shows the assignee count first.
      await scoped('permission_sets', tenantId, trx).where('permission_sets.id', id).del();

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'permission_set.delete',
          entityType: 'permission_set',
          entityId: id,
          before: {
            name: existing.name,
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

  /** Copy a set (system or not) into a new, editable, deletable one. */
  async clone(
    tenantId: number,
    id: number,
    newName: string,
    ctx: PermissionSetAuditContext,
  ): Promise<PermissionSet | null> {
    const source = await permissionSetService.getById(tenantId, id);
    if (!source) return null;

    return permissionSetService.create(
      tenantId,
      {
        name: newName,
        description: source.description,
        capabilities: source.capabilities,
      },
      ctx,
    );
  },

  // ── Assignment ───────────────────────────────────────────────────────────

  async getAssignees(tenantId: number, id: number): Promise<number[]> {
    assertTenantId(tenantId);
    const rows = (await scoped('permission_sets', tenantId)
      .where('permission_sets.id', id)
      .join(
        'user_permission_sets',
        'user_permission_sets.permission_set_id',
        'permission_sets.id',
      )
      .select('user_permission_sets.user_id')) as Array<{ user_id: number }>;
    return rows.map((row) => row.user_id);
  },

  /** The sets one user holds in one tenant. */
  async getForUser(tenantId: number, userId: number): Promise<PermissionSet[]> {
    assertTenantId(tenantId);
    const rows = (await scoped('permission_sets', tenantId)
      .join(
        'user_permission_sets',
        'user_permission_sets.permission_set_id',
        'permission_sets.id',
      )
      .where('user_permission_sets.user_id', userId)
      .orderBy('permission_sets.name')
      .select('permission_sets.*')) as PermissionSetRow[];
    return rows.map(rowToSet);
  },

  /**
   * Replace the set assignments for one user, inside one tenant.
   *
   * Scoped on both sides: only sets belonging to THIS tenant may be assigned,
   * and only rows pointing at this tenant's sets are cleared — a user who holds
   * sets in three tenants keeps the other two untouched. Deleting by
   * `user_id` alone would silently strip their permissions everywhere else.
   */
  async setForUser(
    tenantId: number,
    userId: number,
    setIds: number[],
    ctx: PermissionSetAuditContext,
  ): Promise<PermissionSet[]> {
    assertTenantId(tenantId);

    await db.transaction(async (trx) => {
      const unique = [...new Set(setIds)];

      const valid = (await scoped('permission_sets', tenantId, trx)
        .whereIn('permission_sets.id', unique.length > 0 ? unique : [-1])
        .select('permission_sets.id')) as Array<{ id: number }>;
      const validIds = valid.map((row) => row.id);

      const rejected = unique.filter((id) => !validIds.includes(id));
      if (rejected.length > 0) {
        throw new Error(
          `Permission set(s) ${rejected.join(', ')} do not belong to this tenant.`,
        );
      }

      const tenantSetIds = (await scoped('permission_sets', tenantId, trx).select(
        'permission_sets.id',
      )) as Array<{ id: number }>;

      const before = (await trx('user_permission_sets')
        .where({ user_id: userId })
        .whereIn(
          'permission_set_id',
          tenantSetIds.map((row) => row.id),
        )
        .select('permission_set_id')) as Array<{ permission_set_id: number }>;

      await trx('user_permission_sets')
        .where({ user_id: userId })
        .whereIn(
          'permission_set_id',
          tenantSetIds.length > 0 ? tenantSetIds.map((row) => row.id) : [-1],
        )
        .del();

      if (validIds.length > 0) {
        await trx('user_permission_sets').insert(
          validIds.map((permissionSetId) => ({
            user_id: userId,
            permission_set_id: permissionSetId,
          })),
        );
      }

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'permission_set.assign',
          entityType: 'user',
          entityId: userId,
          before: { permissionSetIds: before.map((row) => row.permission_set_id) },
          after: { permissionSetIds: validIds },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );
    });

    permissionService.invalidate(userId, tenantId);
    return permissionSetService.getForUser(tenantId, userId);
  },

  // ── Catalog ──────────────────────────────────────────────────────────────

  /**
   * The capability picker's source data: the shared catalog, grouped, with the
   * `implies` edges so the UI can show "granting this also grants…" instead of
   * surprising the admin after they save.
   */
  getCatalog(): CapabilityCatalogView {
    return {
      groups: CAPABILITY_GROUPS.map((group) => ({
        group,
        capabilities: CAPABILITY_CATALOG.filter((entry) => entry.group === group)
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((entry) => ({
            key: entry.key,
            label: entry.label,
            labelKey: entry.labelKey,
            description: entry.description,
            implies: entry.implies,
            sensitive: entry.sensitive,
          })),
      })),
      presets: CAPABILITY_PRESETS,
    };
  },

  /** What a set really grants once `implies` is closed. */
  expand(capabilities: readonly Capability[]): Capability[] {
    return expandCapabilities(capabilities);
  },
};

export default permissionSetService;
