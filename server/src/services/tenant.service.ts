/**
 * tenant.service.ts — tenants, and the slug that identifies them across the suite.
 *
 * ── HARD RULE 13 ──────────────────────────────────────────────────────────
 * `tenants.slug` is the cross-app identity. Every Obli* app owns its own
 * `tenants` table with its own autoincrement sequence, so tenant id 4 in
 * Obliguard and tenant id 4 in Oblidesk are unrelated rows that happen to share
 * a number. An alert pushed in from a sibling app, a CI projection, an SSO
 * assertion — all of them carry `tenantSlug`, and `getBySlug()` is how they
 * land in the right tenant here. A numeric tenant id crossing an app boundary
 * is a defect, and the one that produces the worst possible failure: silently
 * writing one customer's data into another customer's tenant.
 *
 * The column is `citext`, so "ACME" and "acme" are the same tenant — enforced
 * by the database rather than by every caller remembering to lowercase.
 *
 * ── Deleting a tenant ─────────────────────────────────────────────────────
 * Every tenant-scoped FK is ON DELETE CASCADE, so `delete()` removes tickets,
 * journal, attachments metadata, audit chain and decision log in one statement.
 * That is irreversible and it is not what an operator usually wants, so the
 * method demands the slug be re-typed as confirmation — the same pattern GitHub
 * uses for repository deletion, for the same reason.
 */

import type { Knex } from 'knex';
import { db, scoped, insertScoped, assertTenantId } from '../db';
import type {
  CreateTenantRequest,
  Tenant,
  TenantSettings,
  UpdateTenantRequest,
  UserRole,
} from '@oblidesk/shared';
import { DEFAULT_TICKET_PREFIX } from '@oblidesk/shared';
import { auditService } from './audit.service';
import { permissionService } from './permission.service';
import { logger } from '../utils/logger';

// ═════════════════════════════════════════════════════════════════════════════
// Rows
// ═════════════════════════════════════════════════════════════════════════════

interface TenantRow {
  id: number;
  slug: string;
  name: string;
  is_master: boolean;
  settings: TenantSettings | string;
  created_at: Date;
  updated_at: Date;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseSettings(value: TenantSettings | string | null): TenantSettings {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as TenantSettings;
    } catch {
      return {};
    }
  }
  return value;
}

function rowToTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    isMaster: row.is_master,
    settings: parseSettings(row.settings),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface TenantAuditContext {
  actorId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface TenantStats {
  users: number;
  tickets: number;
  openTickets: number;
  configObjects: number;
}

/**
 * Slug rules: lowercase letters, digits and single hyphens. Enforced here
 * rather than only in a zod schema because slugs travel between apps, and a
 * slug with a space or a slash in it breaks a URL path in an app that has no
 * idea this one created it.
 */
export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    // Strip the combining marks NFKD just separated out, so "Café" → "cafe"
    // rather than "caf-". U+0300–U+036F is the combining-diacritics block.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length >= 2 && slug.length <= 63;
}

// ═════════════════════════════════════════════════════════════════════════════
// Service
// ═════════════════════════════════════════════════════════════════════════════

export const tenantService = {
  async list(): Promise<Tenant[]> {
    const rows = (await db('tenants').orderBy('name').select('*')) as TenantRow[];
    return rows.map(rowToTenant);
  },

  async getById(id: number): Promise<Tenant | null> {
    const row = (await db('tenants').where({ id }).first()) as TenantRow | undefined;
    return row ? rowToTenant(row) : null;
  },

  /**
   * THE cross-app lookup (HARD RULE 13). Every inbound integration — suite
   * alerts, CI projections, SSO assertions — resolves its tenant through here.
   */
  async getBySlug(slug: string): Promise<Tenant | null> {
    const row = (await db('tenants').where({ slug }).first()) as TenantRow | undefined;
    return row ? rowToTenant(row) : null;
  },

  /** Resolve many slugs at once — an SSO assertion carries a list of them. */
  async getBySlugs(slugs: string[]): Promise<Map<string, Tenant>> {
    if (slugs.length === 0) return new Map();
    const rows = (await db('tenants').whereIn('slug', slugs).select('*')) as TenantRow[];
    // Key on the LOWERCASED slug: the column is citext so the DB matched
    // case-insensitively, but a JS Map would not, and a caller looking up
    // 'ACME' after querying with 'ACME' would miss the row stored as 'acme'.
    return new Map(rows.map((row) => [row.slug.toLowerCase(), rowToTenant(row)]));
  },

  /** The one tenant whose admins see across every other tenant (the MSP console). */
  async getMaster(): Promise<Tenant | null> {
    const row = (await db('tenants').where({ is_master: true }).first()) as TenantRow | undefined;
    return row ? rowToTenant(row) : null;
  },

  async isMaster(tenantId: number): Promise<boolean> {
    assertTenantId(tenantId);
    const row = (await db('tenants').where({ id: tenantId }).first('is_master')) as
      | { is_master: boolean }
      | undefined;
    return Boolean(row?.is_master);
  },

  /**
   * Create a tenant, its ticket-number sequence, and (optionally) its first
   * admin membership — all in one transaction.
   *
   * The `ticket_sequences` row is not optional bookkeeping: without it the
   * first ticket in the new tenant cannot allocate a number, and the failure
   * surfaces as a confusing error on someone's first real use of the tenant
   * rather than here, at creation, where it belongs.
   */
  async create(
    data: CreateTenantRequest & { ownerUserId?: number },
    ctx: TenantAuditContext = {},
  ): Promise<Tenant> {
    const slug = normalizeSlug(data.slug);
    if (!isValidSlug(slug)) {
      throw new Error(
        `Invalid tenant slug "${data.slug}" — use 2-63 lowercase letters, digits and single hyphens.`,
      );
    }

    return db.transaction(async (trx) => {
      const settings: TenantSettings = {
        ticketPrefix: DEFAULT_TICKET_PREFIX,
        ...(data.settings ?? {}),
      };

      const [row] = (await trx('tenants')
        .insert({
          slug,
          name: data.name,
          is_master: data.isMaster ?? false,
          settings: JSON.stringify(settings),
        })
        .returning('*')) as TenantRow[];

      const tenant = rowToTenant(row);

      await insertScoped(
        'ticket_sequences',
        tenant.id,
        { prefix: settings.ticketPrefix ?? DEFAULT_TICKET_PREFIX, last_number: 0 },
        trx,
      )
        .onConflict('tenant_id')
        .ignore();

      if (data.ownerUserId) {
        await insertScoped('user_tenants', tenant.id, { user_id: data.ownerUserId, role: 'admin' }, trx)
          .onConflict(['user_id', 'tenant_id'])
          .merge({ role: 'admin' });
      }

      // The tenant's own chain starts with its creation. Genesis row.
      await auditService.record(
        {
          tenantId: tenant.id,
          actorId: ctx.actorId ?? null,
          action: 'tenant.create',
          entityType: 'tenant',
          entityId: tenant.slug,
          after: { slug: tenant.slug, name: tenant.name, isMaster: tenant.isMaster },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      if (data.ownerUserId) permissionService.invalidate(data.ownerUserId);
      logger.info({ tenantId: tenant.id, slug: tenant.slug }, 'tenant created');
      return tenant;
    });
  },

  /**
   * Update name / master flag / settings. The SLUG IS NOT UPDATABLE and the
   * type reflects that (`UpdateTenantRequest` omits it): every sibling app
   * stores this tenant by slug, so renaming it here would silently orphan the
   * CI projections, alert bindings and SSO mappings that point at the old one.
   */
  async update(
    id: number,
    data: UpdateTenantRequest,
    ctx: TenantAuditContext = {},
  ): Promise<Tenant | null> {
    assertTenantId(id);

    return db.transaction(async (trx) => {
      const existing = (await trx('tenants').where({ id }).first()) as TenantRow | undefined;
      if (!existing) return null;

      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (data.name !== undefined) patch.name = data.name;
      if (data.isMaster !== undefined) {
        // Exactly one master tenant. Promoting one demotes the rest in the same
        // transaction — two masters would mean two god-views disagreeing.
        if (data.isMaster) await trx('tenants').whereNot({ id }).update({ is_master: false });
        patch.is_master = data.isMaster;
      }
      if (data.settings !== undefined) {
        // Merge rather than replace: the settings blob accumulates keys from
        // several screens (branding, portal, business defaults), and a PATCH
        // from one of them must not blank the others.
        const merged: TenantSettings = { ...parseSettings(existing.settings), ...data.settings };
        patch.settings = JSON.stringify(merged);
      }

      const [row] = (await trx('tenants').where({ id }).update(patch).returning('*')) as TenantRow[];
      const tenant = rowToTenant(row);

      // The ticket prefix lives in two places by design — the settings blob is
      // what admins edit, `ticket_sequences.prefix` is what the allocator reads
      // on the hot path. Keep them in step here so a prefix change takes effect
      // on the next ticket rather than never.
      if (data.settings?.ticketPrefix) {
        await scoped('ticket_sequences', id, trx).update({ prefix: data.settings.ticketPrefix });
      }

      await auditService.record(
        {
          tenantId: id,
          actorId: ctx.actorId ?? null,
          action: 'tenant.update',
          entityType: 'tenant',
          entityId: tenant.slug,
          before: {
            name: existing.name,
            isMaster: existing.is_master,
            settings: parseSettings(existing.settings),
          },
          after: { name: tenant.name, isMaster: tenant.isMaster, settings: tenant.settings },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      permissionService.invalidateTenant(id);
      return tenant;
    });
  },

  /** Patch a single settings key without reading the blob at the call site. */
  async setSetting<K extends keyof TenantSettings>(
    id: number,
    key: K,
    value: TenantSettings[K],
    ctx: TenantAuditContext = {},
  ): Promise<Tenant | null> {
    return tenantService.update(id, { settings: { [key]: value } as TenantSettings }, ctx);
  },

  /**
   * Delete a tenant AND every row that cascades from it: tickets, journal,
   * attachments metadata, mail, SLA history, the audit chain, the decision log.
   *
   * `confirmSlug` must equal the tenant's slug. An id is easy to fat-finger and
   * impossible to recognise; a slug someone has to type is a decision they made
   * on purpose. There is no undo — the cascade is the database's, not ours.
   *
   * Attachment BYTES on disk are NOT removed here (the rows that reference them
   * are). Reclaiming them is the attachment service's job, driven by the
   * refcount in `attachment_links`, and doing it from a cascade would mean
   * deleting files inside a transaction that can still roll back.
   */
  async delete(id: number, confirmSlug: string, ctx: TenantAuditContext = {}): Promise<boolean> {
    assertTenantId(id);

    const existing = (await db('tenants').where({ id }).first()) as TenantRow | undefined;
    if (!existing) return false;

    if (existing.slug.toLowerCase() !== confirmSlug.trim().toLowerCase()) {
      throw new Error(
        `Refusing to delete tenant ${id}: confirmation "${confirmSlug}" does not match slug "${existing.slug}".`,
      );
    }
    if (existing.is_master) {
      throw new Error(
        'Refusing to delete the master tenant — promote another tenant to master first.',
      );
    }

    logger.warn(
      { tenantId: id, slug: existing.slug, actorId: ctx.actorId },
      'tenant delete: cascading removal of all tenant data',
    );

    await db('tenants').where({ id }).del();
    permissionService.invalidateTenant(id);
    return true;
  },

  // ── Membership & stats ───────────────────────────────────────────────────

  /** Everyone who belongs to this tenant, with the role they hold here. */
  async getMembers(
    tenantId: number,
  ): Promise<Array<{ userId: number; username: string; displayName: string | null; email: string | null; role: UserRole; isActive: boolean }>> {
    assertTenantId(tenantId);
    const rows = (await scoped('user_tenants', tenantId)
      .join('users', 'users.id', 'user_tenants.user_id')
      .orderBy('users.username')
      .select(
        'users.id as user_id',
        'users.username',
        'users.display_name',
        'users.email',
        'users.is_active',
        'user_tenants.role',
      )) as Array<{
      user_id: number;
      username: string;
      display_name: string | null;
      email: string | null;
      is_active: boolean;
      role: string;
    }>;

    return rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      role: row.role as UserRole,
      isActive: row.is_active,
    }));
  },

  /** Headline counts for the tenant card in the MSP console. */
  async getStats(tenantId: number): Promise<TenantStats> {
    assertTenantId(tenantId);

    // HARD RULE 1 — every one of these is a tenant table, so every one of them
    // goes through scoped(). A bare db('tickets') here would count the whole
    // installation and report it as one customer's number.
    const [users, tickets, openTickets, configObjects] = await Promise.all([
      countOf(scoped('user_tenants', tenantId)),
      countOf(scoped('tickets', tenantId).whereNull('tickets.deleted_at')),
      countOf(
        scoped('tickets', tenantId)
          .whereNull('tickets.deleted_at')
          // HARD RULE 5 — "open" is a CATEGORY question, never a slug question.
          // A tenant renaming its statuses must not change this number.
          .whereNotIn('tickets.status_category', ['resolved', 'closed', 'cancelled']),
      ),
      countOf(scoped('config_objects', tenantId)),
    ]);

    return { users, tickets, openTickets, configObjects };
  },
};

async function countOf(query: Knex.QueryBuilder): Promise<number> {
  const rows = (await query.count<{ count: string }[]>('* as count')) as unknown as Array<{
    count: string;
  }>;
  return Number(rows[0]?.count ?? 0);
}

export default tenantService;
