import knex, { type Knex } from 'knex';
import knexConfig from '../../knexfile';

/**
 * The single Knex instance for the whole server.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  HARD RULE 1 — tenant isolation
 * ──────────────────────────────────────────────────────────────────────────
 * Every table that holds tenant data carries `tenant_id INT NOT NULL
 * REFERENCES tenants(id) ON DELETE CASCADE`, and EVERY read and write against
 * such a table must go through {@link scoped} (or {@link scopedAs} /
 * {@link scopedOrGlobal} / {@link insertScoped}).
 *
 * Bare `db('<tenant table>')` access is BANNED. Not "discouraged" — banned.
 * The reason is blunt: a single forgotten `.where('tenant_id', …)` leaks one
 * customer's tickets, journal entries, mail, attachments or decision trail
 * into another customer's UI, and that class of bug is invisible in
 * development (where there is one tenant) and catastrophic in production.
 * A `.where()` you must remember is a `.where()` you will eventually forget;
 * a helper that refuses to build an unscoped query cannot be forgotten.
 *
 * The helpers below therefore throw instead of silently returning a global
 * query, and `scoped()` also throws when handed a table that is NOT tenant
 * scoped — so a typo in a table name fails loudly at the first call rather
 * than quietly returning cross-tenant rows.
 *
 * Legitimate exceptions to the ban (use `db(...)` directly for these):
 *   • the tables in {@link GLOBAL_TABLES} (users, session, tenants, app_config,
 *     …) which are platform-level by design;
 *   • migrations and seeds, which run before/outside any request context;
 *   • the child tables in {@link PARENT_SCOPED_TABLES}, which have no
 *     tenant_id of their own and MUST be reached by joining/filtering through
 *     their already-scoped parent (e.g. `config_object_versions` through
 *     `config_objects`, `calendar_shifts` through `calendars`).
 */
export const db = knex(knexConfig);

/**
 * Tables whose `tenant_id` is NOT NULL. These are the tables `scoped()`
 * accepts. Keep in sync with migrations 001 and 002 — a table added there
 * with a NOT NULL tenant_id belongs in this list on the same commit.
 */
export const TENANT_SCOPED_TABLES = [
  // ── 001 core ──────────────────────────────────────────────────────────
  'user_tenants',
  'teams',
  'permission_sets',
  'audit_log',
  'decision_log',
  'config_objects',
  'notification_log',
  'notification_outbox',
  'live_alerts',

  // ── 002 ticketing: directory ──────────────────────────────────────────
  'organizations',
  'portal_contacts',
  'assignment_groups',
  'ticket_sequences',

  // ── 002 ticketing: the desk ───────────────────────────────────────────
  'tickets',
  'ticket_journal',
  'ticket_link',
  'ticket_watcher',
  'ticket_participant',

  // ── 002 attachments ───────────────────────────────────────────────────
  'attachments',
  'attachment_links',

  // ── 002 mail ──────────────────────────────────────────────────────────
  'mail_accounts',
  'mail_messages',
  'mail_suppressions',

  // ── 002 time / SLA ────────────────────────────────────────────────────
  'calendars',
  'sla_instances',
  'sla_ledger',
  'rule_executions',

  // ── 002 CMDB ──────────────────────────────────────────────────────────
  'cis',
  'ci_source_links',
  'ci_overlays',
  'ci_state_cache',
  'ticket_cis',
  'ticket_evidence',
  'suite_alerts',

  // ── 002 billing ───────────────────────────────────────────────────────
  'time_entries',
  'contracts',
  'rate_cards',

  // ── 002 knowledge ─────────────────────────────────────────────────────
  'kb_articles',
  'kb_feedback',

  // ── 002 approvals ─────────────────────────────────────────────────────
  'approvals',
  'approval_steps',

  // ── 002 analytics ─────────────────────────────────────────────────────
  'dashboards',
  'dashboard_widgets',
  'metric_daily_rollup',
  'satisfaction_responses',
  'saved_view_counts',

  // ── 002 AI ────────────────────────────────────────────────────────────
  'ai_suggestions',
  'ai_usage_ledger',
] as const;

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];

/**
 * Tables whose `tenant_id` is NULLABLE: a NULL row is platform-wide and is
 * visible to every tenant, a non-NULL row belongs to exactly one tenant.
 * Read these with {@link scopedOrGlobal}; write them with an explicit
 * tenant_id (or explicit NULL for a platform row) from an admin-only path.
 */
export const PLATFORM_OPTIONAL_TENANT_TABLES = [
  'settings',
  'smtp_servers',
  'notification_channels',
] as const;

/**
 * Tables with no `tenant_id` of their own — isolation is inherited from the
 * parent row. Always reach them through the (already scoped) parent.
 */
export const PARENT_SCOPED_TABLES = [
  'config_object_versions', // → config_objects
  'notification_bindings',  // → notification_channels
  'team_memberships',       // → teams
  'user_permission_sets',   // → permission_sets
  'calendar_shifts',        // → calendars
  'calendar_holidays',      // → calendars
  'kb_article_versions',    // → kb_articles
] as const;

/**
 * Genuinely global tables. `db('<table>')` is correct for these.
 */
export const GLOBAL_TABLES = [
  'users',
  'session',
  'password_reset_tokens',
  'sso_link_tokens',
  'tenants',
  'app_config',
  'knex_migrations',
  'knex_migrations_lock',
] as const;

const TENANT_SCOPED_SET: ReadonlySet<string> = new Set(TENANT_SCOPED_TABLES);
const PLATFORM_OPTIONAL_SET: ReadonlySet<string> = new Set(
  PLATFORM_OPTIONAL_TENANT_TABLES,
);
const PARENT_SCOPED_SET: ReadonlySet<string> = new Set(PARENT_SCOPED_TABLES);

/** Anything that can be used as a query root: the pool, or a transaction. */
export type Executor = Knex | Knex.Transaction;

/** True when `table` carries a NOT NULL tenant_id and must be scoped. */
export function isTenantScoped(table: string): boolean {
  return TENANT_SCOPED_SET.has(table);
}

/** True when `table` carries a NULLABLE tenant_id (NULL = platform-wide). */
export function hasOptionalTenant(table: string): boolean {
  return PLATFORM_OPTIONAL_SET.has(table);
}

/**
 * Guard for a tenant id arriving from a request. Rejects 0, NaN, negatives,
 * `undefined` and numeric strings that are not integers — all of which would
 * otherwise produce a query that matches nothing (best case) or throws deep
 * inside pg (worst case), long after the real mistake.
 */
export function assertTenantId(tenantId: number): number {
  if (typeof tenantId !== 'number' || !Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(
      `Tenant isolation: invalid tenant id ${JSON.stringify(tenantId)} — ` +
        'a positive integer is required (did the request context lose its tenant?)',
    );
  }
  return tenantId;
}

function assertScopedTable(table: string): string {
  if (TENANT_SCOPED_SET.has(table)) return table;

  if (PARENT_SCOPED_SET.has(table)) {
    throw new Error(
      `Tenant isolation: "${table}" has no tenant_id — scope its parent row ` +
        'and reach it through that parent (see PARENT_SCOPED_TABLES).',
    );
  }
  if (PLATFORM_OPTIONAL_SET.has(table)) {
    throw new Error(
      `Tenant isolation: "${table}" has a NULLABLE tenant_id — use ` +
        'scopedOrGlobal() so platform-wide rows stay visible.',
    );
  }
  if ((GLOBAL_TABLES as readonly string[]).includes(table)) {
    throw new Error(
      `Tenant isolation: "${table}" is a global table — query it with db('${table}').`,
    );
  }
  throw new Error(
    `Tenant isolation: unknown table "${table}". Add it to TENANT_SCOPED_TABLES ` +
      '(or one of the other lists in server/src/db/index.ts) when you create it.',
  );
}

/**
 * THE tenant-scoped query builder — the only sanctioned way to touch a table
 * that holds tenant data (HARD RULE 1).
 *
 *   const rows = await scoped('tickets', tenantId).where('status_category', 'open');
 *   await scoped('tickets', tenantId, trx).where({ id }).update({ subject });
 *
 * The `tenant_id` predicate is qualified with the table name so the builder
 * keeps working once joins are added. When you need an alias, use
 * {@link scopedAs} rather than passing `'tickets as t'` here.
 */
export function scoped(
  table: string,
  tenantId: number,
  executor: Executor = db,
): Knex.QueryBuilder {
  assertScopedTable(table);
  assertTenantId(tenantId);
  return executor(table).where(`${table}.tenant_id`, tenantId);
}

/**
 * Same as {@link scoped} but for an aliased table, so joins stay readable:
 *
 *   scopedAs('tickets', 't', tenantId)
 *     .join('ticket_journal as j', 'j.ticket_id', 't.id')
 *     .where('j.tenant_id', tenantId)   // scope EVERY joined tenant table too
 */
export function scopedAs(
  table: string,
  alias: string,
  tenantId: number,
  executor: Executor = db,
): Knex.QueryBuilder {
  assertScopedTable(table);
  assertTenantId(tenantId);
  return executor({ [alias]: table }).where(`${alias}.tenant_id`, tenantId);
}

/**
 * Read helper for the NULLABLE-tenant tables (settings, smtp_servers,
 * notification_channels): returns rows owned by this tenant PLUS the
 * platform-wide rows. Order by `tenant_id NULLS LAST` at the call site when
 * a tenant row should override the platform default.
 */
export function scopedOrGlobal(
  table: string,
  tenantId: number,
  executor: Executor = db,
): Knex.QueryBuilder {
  if (!PLATFORM_OPTIONAL_SET.has(table)) {
    throw new Error(
      `Tenant isolation: "${table}" does not have a nullable tenant_id — use scoped().`,
    );
  }
  assertTenantId(tenantId);
  return executor(table).where((b) =>
    b.where(`${table}.tenant_id`, tenantId).orWhereNull(`${table}.tenant_id`),
  );
}

/**
 * Insert helper that stamps `tenant_id` on every row, so a write can never
 * land in the wrong tenant because a caller forgot the column. Any tenant_id
 * already present on a row must match, otherwise the insert is refused.
 */
export function insertScoped<T extends Record<string, unknown>>(
  table: string,
  tenantId: number,
  rows: T | T[],
  executor: Executor = db,
): Knex.QueryBuilder {
  assertScopedTable(table);
  assertTenantId(tenantId);
  const list = Array.isArray(rows) ? rows : [rows];
  const stamped = list.map((row) => {
    const existing = (row as { tenant_id?: number }).tenant_id;
    if (existing !== undefined && existing !== null && existing !== tenantId) {
      throw new Error(
        `Tenant isolation: refusing to insert into "${table}" with tenant_id ` +
          `${existing} while scoped to tenant ${tenantId}.`,
      );
    }
    return { ...row, tenant_id: tenantId };
  });
  return executor(table).insert(stamped);
}
