/**
 * configObject.service.ts — the configuration store.
 *
 * `config_objects` holds the entire configurable surface of the desk: fields,
 * forms, views, rules, SLA policies, state machines, queues, the priority
 * matrix, alert bindings, catalog items, notification templates, dashboards,
 * macros, calendars, escalations and approvals. Sixteen kinds, one table, one
 * lifecycle.
 *
 * ── The lifecycle ────────────────────────────────────────────────────────────
 *   draft ──publish──► published ──archive──► archived
 *     ▲                    │                     │
 *     └────── edit ────────┘  ◄──── restore ─────┘
 *
 * Engines read PUBLISHED objects only. Editing a published object writes to it
 * in place and moves it back to draft; publishing appends an immutable row to
 * `config_object_versions` and bumps `version`. That append is what makes a
 * `decision_log` row naming `(rule_slug, rule_version)` replayable years later
 * against the exact body that produced it — the version history is not a
 * convenience feature, it is the thing that makes the audit trail mean
 * anything.
 *
 * ── Publishing is gated by the linter ────────────────────────────────────────
 * Every cross-reference in a body is a slug with no foreign key behind it
 * (HARD RULE 3), so Postgres cannot catch a dangling one. `publish()` runs
 * configLinter.service and REFUSES on any error-severity finding. That refusal
 * is the only thing standing between "renamed an SLA policy" and "P1s silently
 * have no clock".
 *
 * ── target_tenant_ids and the anti-escalation sanitiser ──────────────────────
 * Following the Obliance convention: a master-tenant admin may push one object
 * down to named tenants by listing their ids in `target_tenant_ids`. A
 * non-master tenant can READ such an object, but the field is IGNORED on write
 * — silently preserved from the stored row, never taken from the request.
 * Implemented explicitly in {@link sanitizeTargetTenantIds} rather than left to
 * a route to remember, because "the route validates it" is how a tenant ends
 * up publishing configuration into its neighbours.
 *
 * ── Every write is audited ───────────────────────────────────────────────────
 * `audit_log` is append-only and hash-chained per tenant
 * (`hash = sha256(prevHash + canonical(row))`). The chain is computed on the
 * write path, inside the same transaction as the change, under a per-tenant
 * advisory lock so two concurrent writers cannot both claim the same
 * predecessor.
 */

import { createHash } from 'crypto';
import type { Knex } from 'knex';

import {
  CONFIG_BODY_FORMAT_VERSIONS,
  CONFIG_KINDS,
  isConfigKind,
  PAGINATION,
  type ActorType,
  type Capability,
  type ConfigKind,
  type ConfigObject,
  type ConfigObjectVersion,
  type ConfigStatus,
  type UserRole,
} from '@oblidesk/shared';

import { db, scoped, type Executor } from '../db';
import {
  buildLintContext,
  canonicaliseBody,
  checksumOfBody,
  hasBlockingIssue,
  lintObjects,
  type ConfigLintFinding,
  type LintTarget,
} from './configLinter.service';

// ═════════════════════════════════════════════════════════════════════════════
// Actor
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Who is doing this. Assembled once at the HTTP boundary
 * (`validators/config.validators.ts`) and threaded through every service call,
 * so no service ever has to reach for a request object — and so a background
 * job can act with an explicit, auditable system actor instead of pretending
 * to be a user.
 */
export interface ConfigActor {
  tenantId: number;
  tenantSlug: string | null;
  userId: number | null;
  actorType: ActorType;
  role: UserRole;
  capabilities: Capability[];
  /** Platform or tenant admin — bypasses capability checks. */
  isAdmin: boolean;
  /** True when this actor's tenant carries `tenants.is_master`. */
  isMasterTenant: boolean;
  /** Assignment groups the user belongs to — resolves the `@my_groups` token. */
  groupIds: number[];
  ip: string | null;
  userAgent: string | null;
}

/** The actor a scheduled job acts as. Never a user; always attributable. */
export function systemActor(tenantId: number, tenantSlug: string | null = null): ConfigActor {
  return {
    tenantId,
    tenantSlug,
    userId: null,
    actorType: 'system',
    role: 'admin',
    capabilities: [],
    isAdmin: true,
    isMasterTenant: false,
    groupIds: [],
    ip: null,
    userAgent: null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Errors
// ═════════════════════════════════════════════════════════════════════════════

export class ConfigServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code:
      | 'not_found' | 'forbidden' | 'validation_failed' | 'conflict'
      | 'version_conflict' | 'config_unreadable' | 'tenant_mismatch' = 'validation_failed',
  ) {
    super(message);
    this.name = 'ConfigServiceError';
  }
}

/** Publish refused: the body would break something the database cannot see. */
export class ConfigLintError extends ConfigServiceError {
  constructor(readonly findings: ConfigLintFinding[]) {
    super(
      422,
      `Refusing to publish: ${findings.filter((f) => f.severity === 'error').length} blocking issue(s).`,
      'validation_failed',
    );
    this.name = 'ConfigLintError';
  }
}

/** Optimistic concurrency on `config_objects.version`. */
export class ConfigVersionConflictError extends ConfigServiceError {
  constructor(readonly current: ConfigObject) {
    super(409, 'This object changed since you loaded it.', 'version_conflict');
    this.name = 'ConfigVersionConflictError';
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Row mapping
// ═════════════════════════════════════════════════════════════════════════════

interface ConfigObjectRow {
  id: number;
  tenant_id: number;
  kind: string;
  slug: string;
  name: string;
  description: string | null;
  body: unknown;
  body_format_version: number;
  status: string;
  version: number;
  is_system: boolean;
  target_tenant_ids: number[] | null;
  checksum: string | null;
  created_by: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const SELECT_COLUMNS = [
  'config_objects.id',
  'config_objects.tenant_id',
  'config_objects.kind',
  'config_objects.slug',
  'config_objects.name',
  'config_objects.description',
  'config_objects.body',
  'config_objects.body_format_version',
  'config_objects.status',
  'config_objects.version',
  'config_objects.is_system',
  'config_objects.target_tenant_ids',
  'config_objects.checksum',
  'config_objects.created_by',
  'config_objects.created_at',
  'config_objects.updated_at',
];

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function rowToConfigObject(row: ConfigObjectRow): ConfigObject {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind as ConfigKind,
    slug: row.slug,
    name: row.name,
    description: row.description,
    // `body` is deliberately widened: the store is generic over the sixteen
    // kinds, and the per-kind narrowing happens where a kind is known.
    body: parseJson(row.body) as unknown as ConfigObject['body'],
    bodyFormatVersion: Number(row.body_format_version) || 1,
    status: (row.status as ConfigStatus) ?? 'draft',
    version: Number(row.version) || 1,
    isSystem: row.is_system === true,
    targetTenantIds: Array.isArray(row.target_tenant_ids) ? row.target_tenant_ids : [],
    checksum: row.checksum ?? '',
    createdBy: row.created_by,
    updatedAt: toIso(row.updated_at),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Master tenant
// ═════════════════════════════════════════════════════════════════════════════

interface MasterCacheEntry { id: number | null; at: number }
let masterCache: MasterCacheEntry | null = null;
const MASTER_CACHE_TTL_MS = 60_000;

/**
 * The id of the tenant carrying `is_master`, or null when there is none.
 * Cached for a minute: it is read on every config list and it changes roughly
 * never, but a restart-free change should still take effect within a minute.
 */
export async function masterTenantId(): Promise<number | null> {
  if (masterCache && Date.now() - masterCache.at < MASTER_CACHE_TTL_MS) return masterCache.id;
  const row = await db('tenants').select('id').where('is_master', true).orderBy('id').first();
  masterCache = { id: row ? Number(row.id) : null, at: Date.now() };
  return masterCache.id;
}

/** Drop the cached master id — call after a tenant's `is_master` flag moves. */
export function invalidateMasterTenantCache(): void {
  masterCache = null;
}

export async function isMasterTenant(tenantId: number): Promise<boolean> {
  const master = await masterTenantId();
  return master !== null && master === tenantId;
}

/**
 * Objects the MASTER tenant has explicitly pushed at `tenantId`.
 *
 * Note the shape of the query: it is scoped to the MASTER tenant and then
 * narrowed to rows that name this tenant in `target_tenant_ids`. That keeps
 * HARD RULE 1 intact — there is no unscoped `db('config_objects')` anywhere in
 * this file — and it encodes the rule that only the master tenant may share,
 * in the query itself rather than in a comment.
 */
/**
 * The builder is returned INSIDE an object, and that is not decoration.
 *
 * A Knex query builder is thenable. An `async` function that returns one hands
 * back a promise whose resolution chains straight into the builder, so
 * `await sharedFromMaster(...)` does not yield the builder at all: it RUNS the
 * query and yields the rows. Every caller then dies on `.select is not a
 * function`, and only for a tenant that is not the master, which is why this
 * survived for as long as the install had a single tenant.
 *
 * Wrapping makes the value inert, so the trap cannot come back.
 */
async function sharedFromMaster(
  tenantId: number,
  executor: Executor = db,
): Promise<{ query: Knex.QueryBuilder } | null> {
  const master = await masterTenantId();
  if (master === null || master === tenantId) return null;
  return {
    query: scoped('config_objects', master, executor)
      .whereRaw('config_objects.target_tenant_ids @> ?::int[]', [`{${tenantId}}`]),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// The anti-escalation sanitiser
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `target_tenant_ids` is the only field in this table that can affect another
 * tenant, so it is the only one with its own gate.
 *
 * A NON-MASTER caller's value is discarded outright and the stored value is
 * preserved. Not rejected — *ignored*. Rejecting would leak the existence of
 * the mechanism and would break the ordinary case of a tenant admin editing
 * the name of an object that the master happens to share with them; ignoring
 * means the field simply cannot be set from a tenant that has no business
 * setting it, no matter what the request body says.
 *
 * A MASTER caller's value is normalised: integers only, positive, unique, and
 * with its own tenant id removed (an object always applies to its owner; there
 * is no such thing as sharing with yourself, and allowing it would make
 * "shared with me" queries return the master's own objects twice).
 */
export function sanitizeTargetTenantIds(
  actor: ConfigActor,
  requested: unknown,
  existing: number[] | null | undefined,
): number[] {
  const stored = Array.isArray(existing) ? existing : [];

  if (!actor.isMasterTenant) return stored;
  if (requested === undefined) return stored;
  if (requested === null) return [];
  if (!Array.isArray(requested)) return stored;

  const out = new Set<number>();
  for (const value of requested) {
    const id = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (id === actor.tenantId) continue;
    out.add(id);
  }
  return [...out].sort((a, b) => a - b);
}

/** Drop target ids that name a tenant which does not exist. */
async function existingTenantIds(ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db('tenants').select('id').whereIn('id', ids as number[]);
  return (rows as Array<{ id: number }>).map((row) => Number(row.id)).sort((a, b) => a - b);
}

// ═════════════════════════════════════════════════════════════════════════════
// Audit (append-only, hash-chained)
// ═════════════════════════════════════════════════════════════════════════════

export interface AuditEntryInput {
  action: string;
  entityType: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Append one hash-chained audit row. MUST run inside the same transaction as
 * the change it describes — an audit row that survives a rolled-back write is
 * a lie, and a write that outlives a failed audit is worse.
 *
 * The per-tenant advisory lock serialises chain construction: without it two
 * concurrent publishes both read the same `prev_hash` and the chain forks,
 * which the verifier reports as tampering.
 */
export async function writeAudit(
  trx: Knex.Transaction,
  actor: ConfigActor,
  entry: AuditEntryInput,
): Promise<void> {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), ?)', ['oblidesk:audit_log', actor.tenantId]);

  const previous = await scoped('audit_log', actor.tenantId, trx)
    .select('hash')
    .orderBy('id', 'desc')
    .first();
  const prevHash: string | null = previous ? String((previous as { hash: string }).hash) : null;

  const at = new Date();
  const payload = {
    tenant_id: actor.tenantId,
    actor_id: actor.userId,
    actor_type: actor.actorType,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    at: at.toISOString(),
  };
  const hash = createHash('sha256')
    .update(`${prevHash ?? ''}${JSON.stringify(canonicaliseBody(payload))}`)
    .digest('hex');

  await trx('audit_log').insert({
    tenant_id: actor.tenantId,
    actor_id: actor.userId,
    actor_type: actor.actorType,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    before: entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
    after: entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
    ip: actor.ip,
    user_agent: actor.userAgent,
    at,
    prev_hash: prevHash,
    hash,
  });
}

/**
 * HARD RULE 2 — the configuration engine writes its own `decision_log` row on
 * the same code path as the action, in the same transaction. Publishing is a
 * decision (the linter said yes, and these are the findings it weighed), so it
 * is recorded like any other engine decision rather than left to the audit
 * trail alone: audit says WHAT changed, decision_log says WHY it was allowed.
 */
async function writeConfigDecision(
  trx: Knex.Transaction,
  actor: ConfigActor,
  decision: string,
  ruleSlug: string,
  ruleVersion: number,
  inputs: Record<string, unknown>,
  outcome: Record<string, unknown>,
  durationMs: number | null,
): Promise<void> {
  await trx('decision_log').insert({
    tenant_id: actor.tenantId,
    ticket_id: null,
    subsystem: 'workflow',
    decision,
    inputs: JSON.stringify(inputs),
    rule_slug: ruleSlug,
    rule_version: ruleVersion,
    outcome: JSON.stringify(outcome),
    duration_ms: durationMs,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Reads
// ═════════════════════════════════════════════════════════════════════════════

export interface ListConfigQuery {
  kind?: ConfigKind | ConfigKind[];
  status?: ConfigStatus | ConfigStatus[];
  /** Substring match on slug or name. */
  q?: string;
  isSystem?: boolean;
  /** Include objects the master tenant shares with this tenant. Default true. */
  includeShared?: boolean;
  page?: number;
  limit?: number;
}

export interface ListConfigResult {
  objects: ConfigObject[];
  total: number;
  page: number;
  limit: number;
}

function applyFilters(query: Knex.QueryBuilder, filters: ListConfigQuery): Knex.QueryBuilder {
  if (filters.kind) {
    const kinds = Array.isArray(filters.kind) ? filters.kind : [filters.kind];
    query.whereIn('config_objects.kind', kinds);
  }
  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    query.whereIn('config_objects.status', statuses);
  }
  if (typeof filters.isSystem === 'boolean') {
    query.where('config_objects.is_system', filters.isSystem);
  }
  if (filters.q && filters.q.trim() !== '') {
    const pattern = `%${filters.q.trim()}%`;
    query.where((builder) => {
      builder
        .whereILike('config_objects.slug', pattern)
        .orWhereILike('config_objects.name', pattern);
    });
  }
  return query;
}

/**
 * List the tenant's own objects plus anything the master tenant shares with
 * it. The two sets are fetched separately (each with its own tenant scope) and
 * merged in memory: a shared object never shadows a local one of the same
 * (kind, slug), because a tenant that has made its own copy has said what it
 * wants.
 */
export async function listConfigObjects(
  actor: ConfigActor,
  filters: ListConfigQuery = {},
): Promise<ListConfigResult> {
  const limit = Math.min(Math.max(filters.limit ?? PAGINATION.defaultLimit, 1), PAGINATION.maxLimit);
  const page = Math.max(filters.page ?? 1, 1);

  const own = applyFilters(scoped('config_objects', actor.tenantId), filters)
    .select(SELECT_COLUMNS)
    .orderBy(['config_objects.kind', 'config_objects.slug']);

  const rows = (await own) as ConfigObjectRow[];
  const objects = rows.map(rowToConfigObject);

  if (filters.includeShared !== false) {
    const shared = await sharedFromMaster(actor.tenantId);
    if (shared) {
      const sharedRows = (await applyFilters(shared.query, filters)
        .select(SELECT_COLUMNS)) as ConfigObjectRow[];
      const localKeys = new Set(objects.map((object) => `${object.kind}:${object.slug.toLowerCase()}`));
      for (const row of sharedRows) {
        const object = rowToConfigObject(row);
        if (localKeys.has(`${object.kind}:${object.slug.toLowerCase()}`)) continue;
        objects.push(object);
      }
    }
  }

  objects.sort((a, b) => (a.kind === b.kind ? a.slug.localeCompare(b.slug) : a.kind.localeCompare(b.kind)));

  const total = objects.length;
  const start = (page - 1) * limit;
  return { objects: objects.slice(start, start + limit), total, page, limit };
}

/**
 * One object by (kind, slug). Falls back to a master-shared object when the
 * tenant has no copy of its own — which is exactly what "a non-master tenant
 * can READ a shared object" means in practice.
 */
export async function getConfigObject(
  actor: ConfigActor,
  kind: ConfigKind,
  slug: string,
): Promise<ConfigObject | null> {
  const own = (await scoped('config_objects', actor.tenantId)
    .select(SELECT_COLUMNS)
    .where('config_objects.kind', kind)
    .where('config_objects.slug', slug)
    .first()) as ConfigObjectRow | undefined;
  if (own) return rowToConfigObject(own);

  const fromMaster = await sharedFromMaster(actor.tenantId);
  if (!fromMaster) return null;
  const shared = (await fromMaster.query
    .select(SELECT_COLUMNS)
    .where('config_objects.kind', kind)
    .where('config_objects.slug', slug)
    .first()) as ConfigObjectRow | undefined;
  return shared ? rowToConfigObject(shared) : null;
}

/** Same, by numeric id — only ever within the caller's own tenant. */
export async function getConfigObjectById(actor: ConfigActor, id: number): Promise<ConfigObject | null> {
  const row = (await scoped('config_objects', actor.tenantId)
    .select(SELECT_COLUMNS)
    .where('config_objects.id', id)
    .first()) as ConfigObjectRow | undefined;
  return row ? rowToConfigObject(row) : null;
}

export interface PublishedBody {
  slug: string;
  name: string;
  body: Record<string, unknown>;
  bodyFormatVersion: number;
  version: number;
  isSystem: boolean;
  /** True when this came from the master tenant rather than the caller's own. */
  shared: boolean;
}

/**
 * THE loader every engine uses: published objects of one kind, keyed by slug,
 * with the master's shared objects folded in underneath the tenant's own.
 *
 * Returns bodies, not `ConfigObject`s, because engines want the body and the
 * version — the version is what a `decision_log` row pins so the decision can
 * be replayed against the body that produced it.
 */
export async function loadPublished(
  tenantId: number,
  kind: ConfigKind,
  executor: Executor = db,
): Promise<Map<string, PublishedBody>> {
  const out = new Map<string, PublishedBody>();

  const shared = await sharedFromMaster(tenantId, executor);
  if (shared) {
    const sharedRows = (await shared.query
      .select(SELECT_COLUMNS)
      .where('config_objects.kind', kind)
      .where('config_objects.status', 'published')) as ConfigObjectRow[];
    for (const row of sharedRows) {
      out.set(String(row.slug).toLowerCase(), {
        slug: String(row.slug),
        name: row.name,
        body: parseJson(row.body),
        bodyFormatVersion: Number(row.body_format_version) || 1,
        version: Number(row.version) || 1,
        isSystem: row.is_system === true,
        shared: true,
      });
    }
  }

  const rows = (await scoped('config_objects', tenantId, executor)
    .select(SELECT_COLUMNS)
    .where('config_objects.kind', kind)
    .where('config_objects.status', 'published')) as ConfigObjectRow[];
  for (const row of rows) {
    // A local object always wins over a shared one of the same slug.
    out.set(String(row.slug).toLowerCase(), {
      slug: String(row.slug),
      name: row.name,
      body: parseJson(row.body),
      bodyFormatVersion: Number(row.body_format_version) || 1,
      version: Number(row.version) || 1,
      isSystem: row.is_system === true,
      shared: false,
    });
  }

  return out;
}

/** One published body by slug, or null. Degrades rather than throwing. */
export async function loadPublishedOne(
  tenantId: number,
  kind: ConfigKind,
  slug: string,
  executor: Executor = db,
): Promise<PublishedBody | null> {
  const all = await loadPublished(tenantId, kind, executor);
  return all.get(slug.toLowerCase()) ?? null;
}

// ── versions ────────────────────────────────────────────────────────────────

function rowToVersion(row: Record<string, unknown>): ConfigObjectVersion {
  return {
    id: Number(row.id),
    configObjectId: Number(row.config_object_id),
    version: Number(row.version),
    body: parseJson(row.body) as unknown as ConfigObjectVersion['body'],
    bodyFormatVersion: Number(row.body_format_version) || 1,
    authorId: row.author_id === null || row.author_id === undefined ? null : Number(row.author_id),
    note: (row.note as string | null) ?? null,
    createdAt: toIso(row.created_at as string),
  };
}

/**
 * `config_object_versions` has no tenant_id of its own (PARENT_SCOPED_TABLES),
 * so it is always reached through an already-scoped parent — never queried
 * directly by id from a request parameter.
 */
export async function listVersions(
  actor: ConfigActor,
  kind: ConfigKind,
  slug: string,
): Promise<ConfigObjectVersion[]> {
  const parent = await requireOwnObject(actor, kind, slug);
  const rows = await db('config_object_versions')
    .select('*')
    .where('config_object_id', parent.id)
    .orderBy('version', 'desc');
  return (rows as Array<Record<string, unknown>>).map(rowToVersion);
}

export async function getVersion(
  actor: ConfigActor,
  kind: ConfigKind,
  slug: string,
  version: number,
): Promise<ConfigObjectVersion | null> {
  const parent = await requireOwnObject(actor, kind, slug);
  const row = await db('config_object_versions')
    .select('*')
    .where('config_object_id', parent.id)
    .where('version', version)
    .first();
  return row ? rowToVersion(row as Record<string, unknown>) : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Writes
// ═════════════════════════════════════════════════════════════════════════════

async function requireOwnObject(
  actor: ConfigActor,
  kind: ConfigKind,
  slug: string,
  executor: Executor = db,
): Promise<ConfigObject> {
  const row = (await scoped('config_objects', actor.tenantId, executor)
    .select(SELECT_COLUMNS)
    .where('config_objects.kind', kind)
    .where('config_objects.slug', slug)
    .first()) as ConfigObjectRow | undefined;
  if (!row) {
    throw new ConfigServiceError(404, `No ${kind} object with the slug "${slug}".`, 'not_found');
  }
  return rowToConfigObject(row);
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,126}[a-z0-9]$|^[a-z0-9]$/;

export function assertValidSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!SLUG_PATTERN.test(normalized)) {
    throw new ConfigServiceError(
      400,
      `"${slug}" is not a valid slug. Slugs are the identity every cross-reference uses (HARD RULE 3): lowercase letters, digits, hyphen and underscore, 1-128 characters.`,
    );
  }
  return normalized;
}

export function assertKnownKind(kind: string): ConfigKind {
  if (!isConfigKind(kind)) {
    throw new ConfigServiceError(400, `"${kind}" is not a configuration kind. Expected one of: ${CONFIG_KINDS.join(', ')}.`);
  }
  return kind;
}

export interface CreateConfigInput {
  kind: ConfigKind;
  slug: string;
  name: string;
  description?: string | null;
  body: Record<string, unknown>;
  /** Draft unless the caller explicitly publishes. */
  status?: Extract<ConfigStatus, 'draft' | 'published'>;
  targetTenantIds?: number[];
  note?: string;
}

/**
 * Create a new object. It lands as a DRAFT by default: a config object that
 * goes live the instant it is saved gives the author no chance to run the
 * linter over it, and the linter is the whole safety net.
 */
export async function createConfigObject(
  actor: ConfigActor,
  input: CreateConfigInput,
): Promise<ConfigObject> {
  const kind = assertKnownKind(input.kind);
  const slug = assertValidSlug(input.slug);
  const name = input.name?.trim();
  if (!name) throw new ConfigServiceError(400, 'A configuration object needs a name.');

  const bodyFormatVersion = CONFIG_BODY_FORMAT_VERSIONS[kind];
  const targets = await existingTenantIds(sanitizeTargetTenantIds(actor, input.targetTenantIds, []));
  const checksum = checksumOfBody(kind, input.body, bodyFormatVersion);

  return db.transaction(async (trx) => {
    const clash = await scoped('config_objects', actor.tenantId, trx)
      .where('config_objects.kind', kind)
      .where('config_objects.slug', slug)
      .first();
    if (clash) {
      throw new ConfigServiceError(409, `A ${kind} object with the slug "${slug}" already exists.`, 'conflict');
    }

    const [row] = (await trx('config_objects')
      .insert({
        tenant_id: actor.tenantId,
        kind,
        slug,
        name,
        description: input.description ?? null,
        body: JSON.stringify(input.body ?? {}),
        body_format_version: bodyFormatVersion,
        status: 'draft',
        version: 1,
        is_system: false,
        target_tenant_ids: targets,
        checksum,
        created_by: actor.userId,
        updated_at: trx.fn.now(),
      })
      .returning(SELECT_COLUMNS.map((column) => column.replace('config_objects.', '')))) as ConfigObjectRow[];

    await writeAudit(trx, actor, {
      action: 'config.create',
      entityType: 'config_object',
      entityId: `${kind}:${slug}`,
      before: null,
      after: { kind, slug, name, status: 'draft', checksum },
    });

    const created = rowToConfigObject(row);
    if (input.status === 'published') {
      return publishWithin(trx, actor, created, input.note ?? 'Created and published.');
    }
    return created;
  });
}

export interface UpdateConfigInput {
  name?: string;
  description?: string | null;
  body?: Record<string, unknown>;
  targetTenantIds?: number[];
  note?: string;
  /** Optimistic concurrency against `config_objects.version`. */
  baseVersion?: number;
}

/**
 * Edit an object in place. The edit does NOT publish: a published object that
 * is edited returns to `draft`, so the engines keep running the last body that
 * was linted and approved while the author works.
 *
 * `is_system` objects ARE editable (an admin must be able to change the
 * shipped SLA), they are simply not deletable — and their checksum drifting
 * from the shipped one is what drives the "modified from baseline" badge.
 */
export async function updateConfigObject(
  actor: ConfigActor,
  kind: ConfigKind,
  slug: string,
  input: UpdateConfigInput,
): Promise<ConfigObject> {
  return db.transaction(async (trx) => {
    const current = await requireOwnObject(actor, kind, slug, trx);

    if (input.baseVersion !== undefined && input.baseVersion !== current.version) {
      throw new ConfigVersionConflictError(current);
    }

    const nextBody = input.body ?? (current.body as unknown as Record<string, unknown>);
    const bodyFormatVersion = current.bodyFormatVersion;
    const checksum = checksumOfBody(kind, nextBody, bodyFormatVersion);

    const targets = await existingTenantIds(
      sanitizeTargetTenantIds(actor, input.targetTenantIds, current.targetTenantIds),
    );

    const patch: Record<string, unknown> = {
      body: JSON.stringify(nextBody),
      checksum,
      target_tenant_ids: targets,
      // Back to draft: engines keep the last published body until the author
      // publishes again and the linter has had another look.
      status: current.status === 'archived' ? 'archived' : 'draft',
      updated_at: trx.fn.now(),
    };
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new ConfigServiceError(400, 'A configuration object needs a name.');
      patch.name = name;
    }
    if (input.description !== undefined) patch.description = input.description;

    await scoped('config_objects', actor.tenantId, trx)
      .where('config_objects.id', current.id)
      .update(patch);

    await writeAudit(trx, actor, {
      action: 'config.update',
      entityType: 'config_object',
      entityId: `${kind}:${slug}`,
      before: { name: current.name, checksum: current.checksum, status: current.status, targetTenantIds: current.targetTenantIds },
      after: { name: patch.name ?? current.name, checksum, status: patch.status, targetTenantIds: targets },
    });

    return requireOwnObject(actor, kind, slug, trx);
  });
}

/**
 * Publish: lint, refuse on any error, append an immutable version row, bump
 * `version`, mark the object published.
 *
 * The lint runs against a context that already contains THIS body, so an
 * object may satisfy its own self-references, and against the tenant's
 * published set for everything else.
 */
export async function publishConfigObject(
  actor: ConfigActor,
  kind: ConfigKind,
  slug: string,
  note?: string,
): Promise<ConfigObject> {
  return db.transaction(async (trx) => {
    const current = await requireOwnObject(actor, kind, slug, trx);
    return publishWithin(trx, actor, current, note);
  });
}

async function publishWithin(
  trx: Knex.Transaction,
  actor: ConfigActor,
  current: ConfigObject,
  note?: string,
): Promise<ConfigObject> {
  const startedAt = Date.now();

  const target: LintTarget = {
    kind: current.kind,
    slug: current.slug,
    name: current.name,
    body: current.body,
    bodyFormatVersion: current.bodyFormatVersion,
    status: 'published',
  };

  const lintContext = await buildLintContext(actor.tenantId, [target]);
  const findings = lintObjects([target], lintContext);

  if (hasBlockingIssue(findings)) {
    // Record the refusal. A publish that was blocked is a decision the desk
    // made, and an admin who cannot see why their publish failed will edit the
    // database instead.
    await writeConfigDecision(
      trx, actor, 'config_publish_blocked', `${current.kind}:${current.slug}`, current.version,
      { findings },
      { published: false, blocking: findings.filter((f) => f.severity === 'error').length },
      Date.now() - startedAt,
    );
    throw new ConfigLintError(findings);
  }

  const nextVersion = current.version + 1;
  const checksum = checksumOfBody(current.kind, current.body, current.bodyFormatVersion);

  await scoped('config_objects', actor.tenantId, trx)
    .where('config_objects.id', current.id)
    .update({
      status: 'published',
      version: nextVersion,
      checksum,
      updated_at: trx.fn.now(),
    });

  // Append-only history. `onConflict().ignore()` makes a retried publish safe
  // rather than a unique-violation 500.
  await trx('config_object_versions')
    .insert({
      config_object_id: current.id,
      version: nextVersion,
      body: JSON.stringify(current.body),
      body_format_version: current.bodyFormatVersion,
      author_id: actor.userId,
      note: note ?? null,
    })
    .onConflict(['config_object_id', 'version'])
    .ignore();

  await writeAudit(trx, actor, {
    action: 'config.publish',
    entityType: 'config_object',
    entityId: `${current.kind}:${current.slug}`,
    before: { status: current.status, version: current.version, checksum: current.checksum },
    after: { status: 'published', version: nextVersion, checksum },
  });

  await writeConfigDecision(
    trx, actor, 'config_published', `${current.kind}:${current.slug}`, nextVersion,
    { findings },
    { published: true, version: nextVersion, checksum, warnings: findings.filter((f) => f.severity !== 'error').length },
    Date.now() - startedAt,
  );

  return { ...current, status: 'published', version: nextVersion, checksum };
}

/**
 * Archive. Engines stop reading the object immediately (they read published
 * only), but the row and its history stay: a `decision_log` entry from last
 * month still names it, and a decision that cannot be replayed is a decision
 * nobody can audit.
 */
export async function archiveConfigObject(
  actor: ConfigActor,
  kind: ConfigKind,
  slug: string,
): Promise<ConfigObject> {
  return db.transaction(async (trx) => {
    const current = await requireOwnObject(actor, kind, slug, trx);

    await scoped('config_objects', actor.tenantId, trx)
      .where('config_objects.id', current.id)
      .update({ status: 'archived', updated_at: trx.fn.now() });

    await writeAudit(trx, actor, {
      action: 'config.archive',
      entityType: 'config_object',
      entityId: `${kind}:${slug}`,
      before: { status: current.status },
      after: { status: 'archived' },
    });

    return { ...current, status: 'archived' as ConfigStatus };
  });
}

/** Bring an archived object back as a draft — never straight to published. */
export async function restoreConfigObject(
  actor: ConfigActor,
  kind: ConfigKind,
  slug: string,
): Promise<ConfigObject> {
  return db.transaction(async (trx) => {
    const current = await requireOwnObject(actor, kind, slug, trx);
    if (current.status !== 'archived') return current;

    await scoped('config_objects', actor.tenantId, trx)
      .where('config_objects.id', current.id)
      .update({ status: 'draft', updated_at: trx.fn.now() });

    await writeAudit(trx, actor, {
      action: 'config.restore',
      entityType: 'config_object',
      entityId: `${kind}:${slug}`,
      before: { status: 'archived' },
      after: { status: 'draft' },
    });

    return { ...current, status: 'draft' as ConfigStatus };
  });
}

/**
 * Roll a body back to an earlier version. The rollback is itself an edit — it
 * lands as a draft and has to be published like anything else, so a bad
 * rollback still meets the linter before it reaches an engine.
 */
export async function revertToVersion(
  actor: ConfigActor,
  kind: ConfigKind,
  slug: string,
  version: number,
): Promise<ConfigObject> {
  return db.transaction(async (trx) => {
    const current = await requireOwnObject(actor, kind, slug, trx);
    const historic = await trx('config_object_versions')
      .select('*')
      .where('config_object_id', current.id)
      .where('version', version)
      .first();
    if (!historic) {
      throw new ConfigServiceError(404, `Version ${version} of ${kind}:${slug} does not exist.`, 'not_found');
    }

    const body = parseJson((historic as Record<string, unknown>).body);
    const bodyFormatVersion = Number((historic as Record<string, unknown>).body_format_version) || 1;
    const checksum = checksumOfBody(kind, body, bodyFormatVersion);

    await scoped('config_objects', actor.tenantId, trx)
      .where('config_objects.id', current.id)
      .update({
        body: JSON.stringify(body),
        body_format_version: bodyFormatVersion,
        checksum,
        status: 'draft',
        updated_at: trx.fn.now(),
      });

    await writeAudit(trx, actor, {
      action: 'config.revert',
      entityType: 'config_object',
      entityId: `${kind}:${slug}`,
      before: { version: current.version, checksum: current.checksum },
      after: { revertedTo: version, checksum, status: 'draft' },
    });

    return requireOwnObject(actor, kind, slug, trx);
  });
}

/**
 * Hard delete. Refused for `is_system` objects: they are the shipped baseline,
 * they are editable and archivable, and deleting one leaves every bundle that
 * references it dangling with nothing to restore from.
 */
export async function deleteConfigObject(
  actor: ConfigActor,
  kind: ConfigKind,
  slug: string,
): Promise<void> {
  await db.transaction(async (trx) => {
    const current = await requireOwnObject(actor, kind, slug, trx);
    if (current.isSystem) {
      throw new ConfigServiceError(
        409,
        `"${slug}" is a shipped system object. Archive it instead — deleting it would strand every reference to it with nothing to restore from.`,
        'conflict',
      );
    }

    await scoped('config_objects', actor.tenantId, trx)
      .where('config_objects.id', current.id)
      .delete();

    await writeAudit(trx, actor, {
      action: 'config.delete',
      entityType: 'config_object',
      entityId: `${kind}:${slug}`,
      before: { kind, slug, name: current.name, checksum: current.checksum },
      after: null,
    });
  });
}

/**
 * "Modified from the shipped baseline?" — compares the live checksum against
 * the checksum of the object's FIRST version row, which for a system object is
 * the body the seed shipped.
 */
export async function driftFromShipped(
  actor: ConfigActor,
  kind: ConfigKind,
  slug: string,
): Promise<{ shipped: string | null; current: string; modified: boolean }> {
  const current = await requireOwnObject(actor, kind, slug);
  const first = await db('config_object_versions')
    .select('body', 'body_format_version')
    .where('config_object_id', current.id)
    .orderBy('version', 'asc')
    .first();

  if (!first) return { shipped: null, current: current.checksum, modified: false };

  const shipped = checksumOfBody(
    kind,
    parseJson((first as Record<string, unknown>).body),
    Number((first as Record<string, unknown>).body_format_version) || 1,
  );
  return { shipped, current: current.checksum, modified: shipped !== current.checksum };
}
