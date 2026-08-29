/**
 * audit.service.ts — the append-only, hash-chained audit ledger.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  What this file guarantees
 * ──────────────────────────────────────────────────────────────────────────
 * Every row in `audit_log` carries `hash = sha256(prev_hash || canonical_json(row))`
 * where `prev_hash` is the hash of the PREVIOUS row of the SAME TENANT. That
 * makes the table tamper-evident: editing a row, deleting a row, or slipping a
 * row in between two others changes a hash that some later row already
 * committed to, and {@link verifyChain} finds the exact link that broke.
 *
 * Three properties have to hold or the chain is decorative rather than
 * evidential, and all three are enforced here:
 *
 *  1. THE HASH IS COMPUTED IN THE SAME TRANSACTION AS THE WRITE IT DESCRIBES.
 *     `record()` takes the caller's transaction. If the business write rolls
 *     back, so does its audit row; if the audit row cannot be written, the
 *     business write dies with it. An audit trail written by a separate
 *     "log it later" path is a trail that disagrees with the data.
 *
 *  2. THE CHAIN CANNOT FORK UNDER CONCURRENCY. Two concurrent requests that
 *     both read "the last row of tenant 7" would both chain onto it and
 *     produce two rows with the same `prev_hash` — a fork, which verification
 *     reports as corruption even though nothing was tampered with. `record()`
 *     therefore takes a per-tenant Postgres ADVISORY TRANSACTION LOCK
 *     (`pg_advisory_xact_lock`) before reading the tail, so appends for one
 *     tenant are serialised. The lock is transaction-scoped: it is released by
 *     COMMIT or ROLLBACK, never leaked, and never needs an explicit unlock.
 *
 *     Consequence worth knowing: audit writes for ONE tenant serialise for the
 *     remainder of the enclosing transaction. Take the audit row LATE in a long
 *     transaction, not early.
 *
 *  3. `canonical_json` IS STABLE. Keys are sorted recursively, `undefined` is
 *     dropped exactly as `JSON.stringify`/jsonb drop it, and Dates are
 *     serialised as ISO strings. An unstable serialisation would produce a
 *     different digest for the same row on the way out than on the way in, and
 *     the chain would appear broken with nothing wrong. Postgres `jsonb` does
 *     NOT preserve key order, which is exactly why the ordering must come from
 *     us and not from the storage engine.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  What is deliberately NOT here
 * ──────────────────────────────────────────────────────────────────────────
 * There is no `update()` and no `delete()`. `redact()` does not remove a row —
 * removing one would break every hash after it — it APPENDS a tombstone that
 * marks the target redacted, and the read paths in this module mask the
 * payload of any row a tombstone points at. That keeps "this content is gone"
 * and "the ledger is still verifiable" true at the same time.
 */

import crypto from 'crypto';
import type { Knex } from 'knex';
import { db, scoped, insertScoped, assertTenantId, type Executor } from '../db';
import type { ActorType, AuditLogEntry } from '@oblidesk/shared';
import { PAGINATION } from '@oblidesk/shared';
import { logger } from '../utils/logger';

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

export interface AuditRecordInput {
  tenantId: number;
  /** NULL for system / automation / AI / portal actors. */
  actorId?: number | null;
  actorType?: ActorType;
  /** Dotted verb: 'ticket.assign', 'config.publish', 'user.create'. */
  action: string;
  /** 'ticket' | 'config_object' | 'user' | 'team' | … */
  entityType: string;
  /** Numeric id OR slug. Stored as TEXT so both fit. */
  entityId?: string | number | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * Event instant. Defaults to now(). Passed explicitly (never left to the
   * column default) because the hash covers it — the value we hash and the
   * value we store must be the same one.
   */
  at?: Date;
}

export interface AuditListQuery {
  action?: string;
  /** Prefix match, e.g. 'ticket.' for every ticket action. */
  actionPrefix?: string;
  entityType?: string;
  entityId?: string | number;
  actorId?: number;
  actorType?: ActorType;
  from?: Date | string;
  to?: Date | string;
  /** Free text over action / entity_type / entity_id. */
  q?: string;
  page?: number;
  limit?: number;
}

export interface AuditListResult {
  entries: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
}

export type ChainBreakReason =
  | 'hash_mismatch'
  | 'prev_hash_mismatch'
  | 'genesis_has_prev_hash'
  | 'missing_hash';

export interface ChainBreak {
  id: number;
  at: string;
  action: string;
  entityType: string;
  entityId: string | null;
  reason: ChainBreakReason;
  expectedHash: string | null;
  actualHash: string | null;
  expectedPrevHash: string | null;
  actualPrevHash: string | null;
}

export interface ChainVerification {
  tenantId: number;
  ok: boolean;
  /** Rows walked before the verdict. */
  checked: number;
  /** Total rows in the tenant's chain. */
  total: number;
  /** The FIRST link that does not reconcile. Everything after it is suspect. */
  firstBrokenLink: ChainBreak | null;
  headHash: string | null;
  durationMs: number;
}

export interface RedactInput {
  tenantId: number;
  /** The audit_log row to mark redacted. */
  targetId: number;
  actorId?: number | null;
  actorType?: ActorType;
  /** Why — retention policy, GDPR erasure request, leaked secret… */
  reason: string;
  ip?: string | null;
  userAgent?: string | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Row shape
// ═════════════════════════════════════════════════════════════════════════════

interface AuditRow {
  id: string | number;
  tenant_id: number;
  actor_id: number | null;
  actor_type: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  at: Date | string;
  prev_hash: string | null;
  hash: string;
}

/**
 * The exact projection that is hashed. Column names (snake_case) rather than
 * DTO names, so the digest is computed over what the DATABASE holds and
 * verification can rebuild it from a plain SELECT.
 */
interface HashPayload {
  tenant_id: number;
  actor_id: number | null;
  actor_type: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  at: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Canonical JSON
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Deterministic JSON: object keys sorted recursively, `undefined` dropped from
 * objects (and rendered `null` inside arrays, matching `JSON.stringify`),
 * Dates as ISO-8601, non-finite numbers as `null`, BigInt as its decimal
 * string. Arrays keep their order — order is data.
 *
 * This is the load-bearing function of the whole module: two different strings
 * for the same logical row means a silently broken chain, so it is exported
 * and unit-testable rather than hidden inside `record()`.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, 0);
}

const MAX_CANONICAL_DEPTH = 64;

function canonicalize(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) return '"[max-depth]"';
  if (value === null || value === undefined) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'string':
      return JSON.stringify(value);
    case 'function':
    case 'symbol':
      return 'null';
    default:
      break;
  }

  if (value instanceof Date) {
    return JSON.stringify(Number.isNaN(value.getTime()) ? null : value.toISOString());
  }
  if (Buffer.isBuffer(value)) {
    return JSON.stringify(value.toString('base64'));
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item, depth + 1)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  // `.sort()` with no comparator = UTF-16 code-unit order. Both the write path
  // and the verify path call this same function, so the order only has to be
  // deterministic, not locale-aware — and a locale-aware sort would NOT be
  // deterministic across hosts, which is precisely the failure mode to avoid.
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();

  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], depth + 1)}`);
  return `{${parts.join(',')}}`;
}

/** `sha256(prev_hash || canonical_json(row))`, hex. */
export function computeHash(prevHash: string | null, payload: HashPayload): string {
  return crypto
    .createHash('sha256')
    .update(prevHash ?? '', 'utf8')
    .update('\n', 'utf8')
    .update(canonicalJson(payload), 'utf8')
    .digest('hex');
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Advisory-lock namespace for the audit chain. Any int32 works as long as it
 * is not reused by another subsystem's advisory lock — collisions would make
 * two unrelated subsystems block each other for no reason.
 */
const AUDIT_LOCK_CLASS = 741_501;

function isTransaction(executor: Executor | undefined): executor is Knex.Transaction {
  return Boolean(executor && (executor as Knex.Transaction).isTransaction);
}

function toIso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return new Date(0).toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function toEntityId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/** jsonb comes back parsed by `pg`, but a string sneaks through some drivers. */
function toJson(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function rowToPayload(row: AuditRow): HashPayload {
  return {
    tenant_id: Number(row.tenant_id),
    actor_id: row.actor_id === null || row.actor_id === undefined ? null : Number(row.actor_id),
    actor_type: String(row.actor_type),
    action: String(row.action),
    entity_type: String(row.entity_type),
    entity_id: row.entity_id === null || row.entity_id === undefined ? null : String(row.entity_id),
    before: toJson(row.before),
    after: toJson(row.after),
    ip: row.ip ?? null,
    user_agent: row.user_agent ?? null,
    at: toIso(row.at),
  };
}

function rowToEntry(row: AuditRow): AuditLogEntry {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    actorId: row.actor_id === null || row.actor_id === undefined ? null : Number(row.actor_id),
    actorType: row.actor_type as ActorType,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id ?? null,
    before: toJson(row.before),
    after: toJson(row.after),
    ip: row.ip ?? null,
    userAgent: row.user_agent ?? null,
    at: toIso(row.at),
    prevHash: row.prev_hash ?? null,
    hash: row.hash,
  };
}

/** The action a tombstone carries. Kept as a constant — it is queried, not just written. */
export const REDACTION_ACTION = 'audit.redacted';
const REDACTION_ENTITY_TYPE = 'audit_log';
const REDACTED_PLACEHOLDER = { redacted: true } as const;

// ═════════════════════════════════════════════════════════════════════════════
// The service
// ═════════════════════════════════════════════════════════════════════════════

export const auditService = {
  /**
   * Append one row to the tenant's chain.
   *
   * PASS THE CALLER'S TRANSACTION. `record(input, trx)` inside the transaction
   * that performs the action is the entire point: the audit row and the change
   * it describes commit together or not at all. Calling it without one is
   * supported (it opens its own transaction) but means the two can diverge —
   * use that only for actions that are not themselves database writes, such as
   * a login or a failed authorisation.
   */
  async record(input: AuditRecordInput, executor?: Executor): Promise<AuditLogEntry> {
    assertTenantId(input.tenantId);
    if (!input.action) throw new Error('auditService.record: action is required');
    if (!input.entityType) throw new Error('auditService.record: entityType is required');

    const run = async (trx: Knex.Transaction): Promise<AuditLogEntry> => {
      // ── Serialise appends for THIS tenant. Transaction-scoped: released by
      //    COMMIT/ROLLBACK, so a crash cannot leave the chain wedged.
      await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [AUDIT_LOCK_CLASS, input.tenantId]);

      const previous = (await scoped('audit_log', input.tenantId, trx)
        .orderBy('id', 'desc')
        .first('id', 'hash')) as { id: string | number; hash: string } | undefined;

      const prevHash = previous?.hash ?? null;

      const payload: HashPayload = {
        tenant_id: input.tenantId,
        actor_id: input.actorId ?? null,
        actor_type: input.actorType ?? 'user',
        action: input.action,
        entity_type: input.entityType,
        entity_id: toEntityId(input.entityId),
        before: input.before ?? null,
        after: input.after ?? null,
        ip: input.ip ?? null,
        user_agent: input.userAgent ?? null,
        // Explicit, never the column default: the hash covers this value, so
        // the row must store exactly the instant that was hashed.
        at: (input.at ?? new Date()).toISOString(),
      };

      const hash = computeHash(prevHash, payload);

      const [row] = (await insertScoped(
        'audit_log',
        input.tenantId,
        {
          actor_id: payload.actor_id,
          actor_type: payload.actor_type,
          action: payload.action,
          entity_type: payload.entity_type,
          entity_id: payload.entity_id,
          before: payload.before === null ? null : JSON.stringify(payload.before),
          after: payload.after === null ? null : JSON.stringify(payload.after),
          ip: payload.ip,
          user_agent: payload.user_agent,
          at: payload.at,
          prev_hash: prevHash,
          hash,
        },
        trx,
      ).returning('*')) as AuditRow[];

      return rowToEntry(row);
    };

    if (isTransaction(executor)) return run(executor);
    return db.transaction(run);
  },

  /**
   * Fire-and-forget variant for paths where an audit failure must not take the
   * request down with it (a login attempt, a read-only export). Never use it
   * for a state change — a state change with no audit row is exactly what the
   * ledger exists to make impossible.
   */
  async recordSafe(input: AuditRecordInput, executor?: Executor): Promise<AuditLogEntry | null> {
    try {
      return await auditService.record(input, executor);
    } catch (error) {
      logger.error(
        { err: error, tenantId: input.tenantId, action: input.action },
        'audit: failed to append (swallowed by recordSafe)',
      );
      return null;
    }
  },

  // ── Reads ────────────────────────────────────────────────────────────────

  async list(tenantId: number, query: AuditListQuery = {}): Promise<AuditListResult> {
    assertTenantId(tenantId);

    const limit = Math.min(
      Math.max(1, query.limit ?? PAGINATION.defaultLimit),
      PAGINATION.maxLimit,
    );
    const page = Math.max(1, query.page ?? 1);

    const applyFilters = (builder: Knex.QueryBuilder): Knex.QueryBuilder => {
      if (query.action) builder.where('audit_log.action', query.action);
      if (query.actionPrefix) builder.where('audit_log.action', 'like', `${query.actionPrefix}%`);
      if (query.entityType) builder.where('audit_log.entity_type', query.entityType);
      if (query.entityId !== undefined) builder.where('audit_log.entity_id', String(query.entityId));
      if (query.actorId !== undefined) builder.where('audit_log.actor_id', query.actorId);
      if (query.actorType) builder.where('audit_log.actor_type', query.actorType);
      if (query.from) builder.where('audit_log.at', '>=', new Date(query.from));
      if (query.to) builder.where('audit_log.at', '<=', new Date(query.to));
      if (query.q) {
        const needle = `%${query.q}%`;
        builder.where((sub) =>
          sub
            .whereILike('audit_log.action', needle)
            .orWhereILike('audit_log.entity_type', needle)
            .orWhereILike('audit_log.entity_id', needle),
        );
      }
      return builder;
    };

    const countRow = (await applyFilters(scoped('audit_log', tenantId)).count<{ count: string }[]>(
      'audit_log.id as count',
    )) as unknown as Array<{ count: string }>;
    const total = Number(countRow[0]?.count ?? 0);

    const rows = (await applyFilters(scoped('audit_log', tenantId))
      .orderBy('audit_log.id', 'desc')
      .limit(limit)
      .offset((page - 1) * limit)
      .select('audit_log.*')) as AuditRow[];

    const entries = await auditService.maskRedacted(tenantId, rows.map(rowToEntry));
    return { entries, total, page, limit };
  },

  async getById(tenantId: number, id: number): Promise<AuditLogEntry | null> {
    assertTenantId(tenantId);
    const row = (await scoped('audit_log', tenantId).where('audit_log.id', id).first()) as
      | AuditRow
      | undefined;
    if (!row) return null;
    const [entry] = await auditService.maskRedacted(tenantId, [rowToEntry(row)]);
    return entry ?? null;
  },

  /** Full history for one entity, oldest first — the entity's "what happened" tab. */
  async getForEntity(
    tenantId: number,
    entityType: string,
    entityId: string | number,
    limit = 200,
  ): Promise<AuditLogEntry[]> {
    assertTenantId(tenantId);
    const rows = (await scoped('audit_log', tenantId)
      .where({ 'audit_log.entity_type': entityType, 'audit_log.entity_id': String(entityId) })
      .orderBy('audit_log.id', 'asc')
      .limit(Math.min(Math.max(1, limit), 1000))
      .select('audit_log.*')) as AuditRow[];
    return auditService.maskRedacted(tenantId, rows.map(rowToEntry));
  },

  // ── Integrity ────────────────────────────────────────────────────────────

  /**
   * Walk the tenant's chain from the genesis row forward, recomputing every
   * digest, and return the FIRST link that does not reconcile.
   *
   * "First" matters: once one link is broken every subsequent hash is computed
   * from a value that no longer matches, so reporting all of them would be
   * thousands of rows of noise pointing at one incident. The id returned is
   * where to look.
   *
   * Streams in batches so a tenant with millions of rows does not have to fit
   * in memory.
   */
  async verifyChain(tenantId: number, batchSize = 1000): Promise<ChainVerification> {
    assertTenantId(tenantId);
    const startedAt = Date.now();

    const countRow = (await scoped('audit_log', tenantId).count<{ count: string }[]>(
      'audit_log.id as count',
    )) as unknown as Array<{ count: string }>;
    const total = Number(countRow[0]?.count ?? 0);

    let cursor = 0;
    let checked = 0;
    let expectedPrevHash: string | null = null;
    let headHash: string | null = null;

    for (;;) {
      const rows = (await scoped('audit_log', tenantId)
        .where('audit_log.id', '>', cursor)
        .orderBy('audit_log.id', 'asc')
        .limit(batchSize)
        .select('audit_log.*')) as AuditRow[];

      if (rows.length === 0) break;

      for (const row of rows) {
        const id = Number(row.id);
        cursor = id;
        checked += 1;

        const actualPrevHash = row.prev_hash ?? null;
        const actualHash = row.hash ?? null;

        if (!actualHash) {
          return {
            tenantId,
            ok: false,
            checked,
            total,
            headHash,
            durationMs: Date.now() - startedAt,
            firstBrokenLink: {
              id,
              at: toIso(row.at),
              action: row.action,
              entityType: row.entity_type,
              entityId: row.entity_id ?? null,
              reason: 'missing_hash',
              expectedHash: null,
              actualHash: null,
              expectedPrevHash,
              actualPrevHash,
            },
          };
        }

        if (actualPrevHash !== expectedPrevHash) {
          return {
            tenantId,
            ok: false,
            checked,
            total,
            headHash,
            durationMs: Date.now() - startedAt,
            firstBrokenLink: {
              id,
              at: toIso(row.at),
              action: row.action,
              entityType: row.entity_type,
              entityId: row.entity_id ?? null,
              reason: expectedPrevHash === null ? 'genesis_has_prev_hash' : 'prev_hash_mismatch',
              expectedHash: null,
              actualHash,
              expectedPrevHash,
              actualPrevHash,
            },
          };
        }

        const recomputed = computeHash(actualPrevHash, rowToPayload(row));
        if (recomputed !== actualHash) {
          return {
            tenantId,
            ok: false,
            checked,
            total,
            headHash,
            durationMs: Date.now() - startedAt,
            firstBrokenLink: {
              id,
              at: toIso(row.at),
              action: row.action,
              entityType: row.entity_type,
              entityId: row.entity_id ?? null,
              reason: 'hash_mismatch',
              expectedHash: recomputed,
              actualHash,
              expectedPrevHash,
              actualPrevHash,
            },
          };
        }

        expectedPrevHash = actualHash;
        headHash = actualHash;
      }

      if (rows.length < batchSize) break;
    }

    return {
      tenantId,
      ok: true,
      checked,
      total,
      headHash,
      firstBrokenLink: null,
      durationMs: Date.now() - startedAt,
    };
  },

  /** The tenant's current chain head — cheap "did anything change?" probe. */
  async getHead(tenantId: number): Promise<{ id: number; hash: string; at: string } | null> {
    assertTenantId(tenantId);
    const row = (await scoped('audit_log', tenantId)
      .orderBy('audit_log.id', 'desc')
      .first('id', 'hash', 'at')) as { id: string | number; hash: string; at: Date } | undefined;
    return row ? { id: Number(row.id), hash: row.hash, at: toIso(row.at) } : null;
  },

  // ── Redaction ────────────────────────────────────────────────────────────

  /**
   * Mark an audit row's payload as redacted WITHOUT deleting or editing it.
   *
   * Deleting the row, or blanking its `before`/`after`, would change the value
   * the next row's `prev_hash` committed to and break the chain from that point
   * to the head — trading a privacy problem for an integrity problem. Instead
   * we APPEND a tombstone (`audit.redacted`, entity `audit_log:<id>`), which is
   * itself chained and auditable, and every read path in this module masks the
   * payload of a row a tombstone points at.
   *
   * The bytes still exist in the table. If a retention policy genuinely
   * requires physical erasure, that is a separate, audited job that truncates
   * the whole tenant chain and starts a new genesis row — not an in-place edit.
   */
  async redact(input: RedactInput, executor?: Executor): Promise<AuditLogEntry> {
    assertTenantId(input.tenantId);

    const target = (await scoped('audit_log', input.tenantId)
      .where('audit_log.id', input.targetId)
      .first('id', 'action', 'entity_type', 'entity_id')) as
      | Pick<AuditRow, 'id' | 'action' | 'entity_type' | 'entity_id'>
      | undefined;

    if (!target) {
      throw new Error(`audit: row ${input.targetId} not found in tenant ${input.tenantId}`);
    }

    return auditService.record(
      {
        tenantId: input.tenantId,
        actorId: input.actorId ?? null,
        actorType: input.actorType ?? 'user',
        action: REDACTION_ACTION,
        entityType: REDACTION_ENTITY_TYPE,
        entityId: String(input.targetId),
        before: null,
        after: {
          redactedId: Number(target.id),
          redactedAction: target.action,
          redactedEntityType: target.entity_type,
          redactedEntityId: target.entity_id,
          reason: input.reason,
        },
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
      executor,
    );
  },

  /** Audit row ids this tenant has tombstoned, restricted to `ids`. */
  async getRedactedIds(tenantId: number, ids: number[]): Promise<Set<number>> {
    if (ids.length === 0) return new Set();
    assertTenantId(tenantId);
    const rows = (await scoped('audit_log', tenantId)
      .where({ 'audit_log.action': REDACTION_ACTION, 'audit_log.entity_type': REDACTION_ENTITY_TYPE })
      .whereIn(
        'audit_log.entity_id',
        ids.map((id) => String(id)),
      )
      .select('audit_log.entity_id')) as Array<{ entity_id: string }>;
    return new Set(rows.map((row) => Number(row.entity_id)));
  },

  /**
   * Replace `before`/`after` with a placeholder on any entry that has been
   * tombstoned. Applied by every read path in this module so a redaction is
   * effective no matter which one the caller used.
   */
  async maskRedacted(tenantId: number, entries: AuditLogEntry[]): Promise<AuditLogEntry[]> {
    if (entries.length === 0) return entries;
    const redacted = await auditService.getRedactedIds(
      tenantId,
      entries.map((entry) => entry.id),
    );
    if (redacted.size === 0) return entries;
    return entries.map((entry) =>
      redacted.has(entry.id)
        ? { ...entry, before: entry.before === null ? null : { ...REDACTED_PLACEHOLDER }, after: entry.after === null ? null : { ...REDACTED_PLACEHOLDER } }
        : entry,
    );
  },
};

export default auditService;
