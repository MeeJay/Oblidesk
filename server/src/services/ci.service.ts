/**
 * ci.service.ts — the DESK-OWNED half of a configuration item.
 *
 * ── What Oblidesk stores about a machine, and what it refuses to store ──────
 * This is not a CMDB, and the distinction is the product decision the whole
 * module hangs on. A CI row here holds exactly two things:
 *
 *   IDENTITY      `cis.hardware_uuid`. ONE key. Never uuid -> mac -> fqdn ->
 *                 hostname matching, which is identity reconciliation: it
 *                 produces collisions, split identities and a merge queue, and
 *                 that is the disease we refused to inherit. One key, or no
 *                 link.
 *   DESK FIELDS   `owner_contact_id`, `criticality`, `support_group_id` and
 *                 whatever arbitrary key/value the desk puts in `ci_overlays`.
 *
 * Everything else about the machine (hardware, software, patch level, uptime,
 * threats, site) is READ THROUGH to the app that owns it, at render time, and
 * shown with a visible "last read" timestamp. If a technician sees a wrong disk
 * size the fix is in Obliance, never here.
 *
 * `ci_source_links.payload` is therefore a CACHE and nothing else. It is paired
 * with `last_fetched_at` for exactly that reason, {@link cacheSourcePayload} is
 * the only writer, and the UI must render the age beside it. Never treat a
 * cached sibling attribute as if the desk owned it.
 *
 * ── Where the cross-app proxy is ───────────────────────────────────────────
 * `GET /api/ci/:id/live/:app` is NOT in this file. Reading a sibling app is a
 * privileged, audited, SSRF-sensitive operation with its own module. What this
 * file provides is the SEAM it needs, and only the desk-owned parts of it:
 * {@link requireCi} (tenant ownership), {@link sourceLinkFor} /
 * {@link sourceLinksFor} (the closed set of places this ONE ci is mirrored
 * from, resolved from the database rather than from anything the client sent)
 * and {@link cacheSourcePayload} (the write-back, with its timestamp).
 *
 * ── Why there is no decision_log in this file ──────────────────────────────
 * HARD RULE 2 puts a decision row on the code path of anything an ENGINE
 * decides. Nothing here decides: an operator sets a field, a technician links a
 * ticket, an ingest resolves a UUID it was handed. Those are actions, and their
 * evidence is `audit_log` (hash-chained, written inside the same transaction as
 * the change, via {@link auditService.record}). Adding a decision row for a
 * human typing "critical" into a select would dilute the one table the Why
 * drawer reads.
 */
import type { Knex } from 'knex';
import {
  OPEN_STATUS_CATEGORIES,
  PAGINATION,
  type ActorType,
  type CiCriticality,
  type CiKind,
  type CiSourceApp,
  type TicketCiRole,
} from '@oblidesk/shared';

import { db, insertScoped, scoped, type Executor } from '../db';
import { auditService } from './audit.service';
import { badRequest, notFound } from '../middleware/errorHandler';

// ═════════════════════════════════════════════════════════════════════════════
// Shapes
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The CI as this service returns it.
 *
 * Field NAMES match the shared `Ci` DTO exactly, so the client's type reads
 * this payload unchanged. Two field TYPES are deliberately wider than the
 * shared DTO: migration 002 makes `criticality` and `ci_state_cache.online`
 * nullable, and the alert spine writes NULL for "we do not know". Narrowing
 * them here would force a fabricated default, and "medium" invented for
 * "unclassified" (or "offline" invented for "never observed") is precisely the
 * kind of confident wrong answer the context rail exists not to give.
 */
export interface CiRecord {
  id: number;
  tenantId: number;
  kind: CiKind;
  displayName: string;
  hardwareUuid: string | null;
  criticality: CiCriticality | null;
  ownerContactId: number | null;
  supportGroupId: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  deletedAt: string | null;
  /** Joined on the detail read only. */
  sources?: CiSourceLinkRecord[];
  overlays?: CiOverlayRecord[];
  state?: CiStateRecord | null;
  openTicketCount?: number;
}

/**
 * Where this CI is mirrored FROM. `payload` is a cache of the owning app's
 * answer, `lastFetchedAt` is how old that cache is, and the pair is meaningless
 * apart: render them together or render neither.
 */
export interface CiSourceLinkRecord {
  id: number;
  ciId: number;
  tenantId: number;
  appType: string;
  externalId: string;
  externalPath: string | null;
  url: string | null;
  lastFetchedAt: string | null;
  payload: Record<string, unknown>;
}

/** Desk-owned key/value. Never a mirror of a sibling app's field. */
export interface CiOverlayRecord {
  id: number;
  ciId: number;
  tenantId: number;
  key: string;
  value: unknown;
}

export interface CiStateRecord {
  ciId: number;
  tenantId: number;
  /** NULL means "never observed", which is not the same as "offline". */
  online: boolean | null;
  state: Record<string, unknown>;
  observedAt: string | null;
}

/** A ticket seen from a CI. Deliberately thin: the rail links, it does not embed. */
export interface CiTicketRef {
  id: number;
  number: string;
  subject: string;
  statusCategory: string;
  prioritySlug: string | null;
  /** The role recorded in `ticket_cis`, or null when only `primary_ci_id` links them. */
  role: TicketCiRole | null;
  updatedAt: string | null;
}

/** A CI seen from a ticket. */
export interface TicketCiLink {
  ticketId: number;
  ciId: number;
  role: TicketCiRole;
  ci: Pick<
    CiRecord,
    'id' | 'displayName' | 'kind' | 'criticality' | 'hardwareUuid' | 'deletedAt'
  > & { online: boolean | null; observedAt: string | null };
}

/** Who is doing this. Every mutation in this file takes one and audits it. */
export interface CiActor {
  actorId: number | null;
  actorType?: ActorType;
  ip?: string | null;
  userAgent?: string | null;
}

const SYSTEM_ACTOR: CiActor = { actorId: null, actorType: 'system' };

// ── Row shapes as Postgres hands them back ───────────────────────────────────

interface CiRow {
  id: number;
  tenant_id: number;
  kind: string;
  display_name: string;
  hardware_uuid: string | null;
  criticality: string | null;
  owner_contact_id: number | null;
  support_group_id: number | null;
  first_seen_at: Date | string | null;
  last_seen_at: Date | string | null;
  deleted_at: Date | string | null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `jsonb` arrives as an object on pg, as text on some drivers. Accept both. */
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function mapCiRow(row: CiRow): CiRecord {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    kind: row.kind as CiKind,
    displayName: row.display_name,
    hardwareUuid: row.hardware_uuid ?? null,
    criticality: (row.criticality as CiCriticality | null) ?? null,
    ownerContactId: row.owner_contact_id ?? null,
    supportGroupId: row.support_group_id ?? null,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    deletedAt: iso(row.deleted_at),
  };
}

const CI_COLUMNS = [
  'cis.id',
  'cis.tenant_id',
  'cis.kind',
  'cis.display_name',
  'cis.hardware_uuid',
  'cis.criticality',
  'cis.owner_contact_id',
  'cis.support_group_id',
  'cis.first_seen_at',
  'cis.last_seen_at',
  'cis.deleted_at',
] as const;

/** HARD RULE 5 — engines key off the hard-coded status CATEGORY, never a slug. */
const OPEN_CATEGORY_LIST = [...OPEN_STATUS_CATEGORIES];

// ═════════════════════════════════════════════════════════════════════════════
// list() — keyset pagination
// ═════════════════════════════════════════════════════════════════════════════
//
// Same shape as `ticket.service.list`, for the same reason: the asset list is
// virtualised and OFFSET both walks rows it throws away and shifts the window
// when a machine is seen again mid-scroll, silently skipping or repeating a row.

interface SortSpec {
  column: string;
  kind: 'text' | 'number' | 'timestamp';
}

/** Sort whitelist. Anything not here is refused, never passed through. */
const SORTABLE: Readonly<Record<string, SortSpec>> = {
  display_name: { column: 'cis.display_name', kind: 'text' },
  last_seen_at: { column: 'cis.last_seen_at', kind: 'timestamp' },
  first_seen_at: { column: 'cis.first_seen_at', kind: 'timestamp' },
  kind: { column: 'cis.kind', kind: 'text' },
  // Sorts alphabetically (critical, high, low, medium), not by rank. A rank
  // CASE would order better and would also stop being a column, which is what
  // the keyset cursor pins the page boundary to. Same trade `ticket.service`
  // makes for `priority_slug`, and it is stable, which is what pagination needs.
  criticality: { column: 'cis.criticality', kind: 'text' },
  id: { column: 'cis.id', kind: 'number' },
};

/** An asset list is a phone book, not a feed: name ascending is the useful default. */
const DEFAULT_SORT = 'display_name';

interface CursorPayload {
  v: 1;
  s: string;
  d: 'asc' | 'desc';
  /** Primary sort value at the page boundary; null when the column was NULL. */
  k: string | number | null;
  /** The tiebreaker. Without it, equal names drop or repeat rows. */
  i: number;
}

export function encodeCiCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCiCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
    if (parsed?.v !== 1 || typeof parsed.i !== 'number' || !SORTABLE[parsed.s]) return null;
    if (parsed.d !== 'asc' && parsed.d !== 'desc') return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface ListCisQuery {
  tenantId: number;
  /** Free text over `display_name` and `hardware_uuid` (pg_trgm). */
  search?: string | null;
  kind?: CiKind | CiKind[] | null;
  criticality?: CiCriticality | CiCriticality[] | null;
  /** true = only CIs with an open ticket, false = only CIs with none. */
  hasOpenTickets?: boolean | null;
  cursor?: string | null;
  limit?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  executor?: Executor;
}

export interface CiPage {
  items: CiRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Trigram search needs three characters to have anything to match on. */
const MIN_TRIGRAM_LENGTH = 3;

function likeEscape(value: string): string {
  return value.replace(/[%_]/g, '\\$&');
}

function asList<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Deleted CIs are never listed. A ticket that references one still renders it
 * through {@link get}, which returns the row with its `deletedAt` set so the UI
 * can mark it retired rather than showing a blank where a machine used to be.
 */
export async function list(query: ListCisQuery): Promise<CiPage> {
  const executor = query.executor ?? db;
  const tenantId = query.tenantId;

  const limit = Math.min(Math.max(query.limit ?? PAGINATION.defaultLimit, 1), PAGINATION.maxLimit);
  const sortKey = query.sortBy && SORTABLE[query.sortBy] ? query.sortBy : DEFAULT_SORT;
  const direction: 'asc' | 'desc' = query.sortDir === 'desc' ? 'desc' : 'asc';
  const sort = SORTABLE[sortKey];

  const qb = scoped('cis', tenantId, executor).whereNull('cis.deleted_at');

  const kinds = asList(query.kind);
  if (kinds.length > 0) qb.whereIn('cis.kind', kinds);

  const criticalities = asList(query.criticality);
  if (criticalities.length > 0) qb.whereIn('cis.criticality', criticalities);

  // ── Text ──────────────────────────────────────────────────────────────────
  //
  // `%` (not `similarity(...) > x`) so the `cis_name_trgm` GIN index is usable.
  // `hardware_uuid` has no trigram index and is `citext`, so it is matched with
  // a plain LIKE, which is already case-insensitive on that type. That arm is a
  // scan; the CI table is thousands of rows, not millions, and a technician
  // pasting a UUID out of an alert e-mail is the search that has to work.
  const term = (query.search ?? '').trim();
  if (term) {
    const escaped = likeEscape(term);
    qb.where((b) => {
      if (term.length >= MIN_TRIGRAM_LENGTH) b.orWhereRaw('cis.display_name % ?', [term]);
      else b.orWhereRaw('cis.display_name ILIKE ?', [`%${escaped}%`]);
      b.orWhere('cis.hardware_uuid', 'like', `%${escaped}%`);
    });
  }

  // ── Open tickets ──────────────────────────────────────────────────────────
  //
  // A ticket reaches a CI two ways: `tickets.primary_ci_id` and a `ticket_cis`
  // row. Both are real and `ticket.service` writes both, so both are checked.
  if (typeof query.hasOpenTickets === 'boolean') {
    const predicate = (sub: Knex.QueryBuilder): Knex.QueryBuilder =>
      sub
        .select(executor.raw('1'))
        .from('tickets')
        .where('tickets.tenant_id', tenantId)
        .whereNull('tickets.deleted_at')
        .whereIn('tickets.status_category', OPEN_CATEGORY_LIST)
        .where((b) => {
          b.orWhereRaw('tickets.primary_ci_id = cis.id').orWhereExists((inner) =>
            inner
              .select(executor.raw('1'))
              .from('ticket_cis')
              .whereRaw('ticket_cis.ticket_id = tickets.id')
              .where('ticket_cis.tenant_id', tenantId)
              .whereRaw('ticket_cis.ci_id = cis.id'),
          );
        });

    if (query.hasOpenTickets) qb.whereExists(predicate);
    else qb.whereNotExists(predicate);
  }

  // ── Keyset ────────────────────────────────────────────────────────────────
  //
  // ORDER BY <col> <dir> NULLS LAST, id <dir>. NULLS LAST in BOTH directions is
  // what lets one comparator serve both: the null block is always at the end,
  // so "after the cursor" needs no per-direction special case.
  //
  // Search FILTERS but never REORDERS. Ordering by `similarity()` would order
  // better and would also break the cursor, because the page boundary has to be
  // a column value the next query can compare against.
  const comparator = direction === 'desc' ? '<' : '>';
  const cursor = query.cursor ? decodeCiCursor(query.cursor) : null;

  if (cursor && cursor.s === sortKey && cursor.d === direction) {
    if (cursor.k === null) {
      // Inside the trailing NULL block: only the tiebreaker moves us on.
      qb.whereRaw(`(?? IS NULL AND cis.id ${comparator} ?)`, [sort.column, cursor.i]);
    } else {
      qb.whereRaw(
        `(?? ${comparator} ? OR (?? = ? AND cis.id ${comparator} ?) OR ?? IS NULL)`,
        [sort.column, cursor.k, sort.column, cursor.k, cursor.i, sort.column],
      );
    }
  }

  const rows = (await qb
    .select(...CI_COLUMNS)
    .orderByRaw(`?? ${direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`, [sort.column])
    .orderBy('cis.id', direction)
    .limit(limit + 1)) as unknown as CiRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(mapCiRow);

  // One grouped count for the whole page rather than a correlated subquery per
  // row: the badge is worth a query, not N of them.
  if (items.length > 0) {
    const counts = await openTicketCounts(
      tenantId,
      items.map((item) => item.id),
      executor,
    );
    for (const item of items) item.openTicketCount = counts.get(item.id) ?? 0;
  }

  let nextCursor: string | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1];
    const raw = (last as unknown as Record<string, unknown>)[sort.column.replace('cis.', '')];
    const key =
      raw === null || raw === undefined
        ? null
        : sort.kind === 'timestamp'
          ? iso(raw as Date | string)
          : sort.kind === 'number'
            ? Number(raw)
            : String(raw);
    nextCursor = encodeCiCursor({ v: 1, s: sortKey, d: direction, k: key, i: Number(last.id) });
  }

  return { items, nextCursor, hasMore };
}

/**
 * Open tickets per CI, counted without double counting.
 *
 * `ticket.service.create` writes BOTH `tickets.primary_ci_id` and a
 * `ticket_cis` row of role 'primary' for an alert-opened ticket, so summing the
 * two links naively counts that ticket twice. The second query therefore takes
 * only the primary links that have no `ticket_cis` row, and the two sums are
 * disjoint by construction rather than de-duplicated afterwards in JavaScript.
 */
export async function openTicketCounts(
  tenantId: number,
  ciIds: number[],
  executor: Executor = db,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (ciIds.length === 0) return out;

  const linked = (await scoped('ticket_cis', tenantId, executor)
    .join('tickets', 'tickets.id', 'ticket_cis.ticket_id')
    .where('tickets.tenant_id', tenantId)
    .whereNull('tickets.deleted_at')
    .whereIn('tickets.status_category', OPEN_CATEGORY_LIST)
    .whereIn('ticket_cis.ci_id', ciIds)
    .groupBy('ticket_cis.ci_id')
    .select('ticket_cis.ci_id')
    .count({ count: '*' })) as unknown as Array<{ ci_id: number; count: string }>;

  const primaryOnly = (await scoped('tickets', tenantId, executor)
    .whereNull('tickets.deleted_at')
    .whereIn('tickets.status_category', OPEN_CATEGORY_LIST)
    .whereIn('tickets.primary_ci_id', ciIds)
    .whereNotExists((sub) =>
      sub
        .select(executor.raw('1'))
        .from('ticket_cis')
        .whereRaw('ticket_cis.ticket_id = tickets.id')
        .where('ticket_cis.tenant_id', tenantId)
        .whereRaw('ticket_cis.ci_id = tickets.primary_ci_id'),
    )
    .groupBy('tickets.primary_ci_id')
    .select({ ci_id: 'tickets.primary_ci_id' })
    .count({ count: '*' })) as unknown as Array<{ ci_id: number; count: string }>;

  for (const row of [...linked, ...primaryOnly]) {
    const id = Number(row.ci_id);
    out.set(id, (out.get(id) ?? 0) + Number(row.count ?? 0));
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// get() — what GET /api/ci/:id serves
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One CI with everything the desk owns about it.
 *
 * Note what is NOT fetched here: nothing crosses the network. This read is the
 * rail's foundation section, and the four sibling-app sections load after it,
 * separately, each with its own budget and its own visible failure. A detail
 * read that blocked on Obliance would make one dead sibling app look like a
 * dead ticket.
 *
 * A soft-deleted CI IS returned, with `deletedAt` set. Tickets and evidence
 * still point at it and "retired on 3 March" is a better answer than a 404.
 */
export async function get(
  tenantId: number,
  ciId: number,
  executor: Executor = db,
): Promise<CiRecord | null> {
  const row = (await scoped('cis', tenantId, executor)
    .where('cis.id', ciId)
    .first(...CI_COLUMNS)) as CiRow | undefined;
  if (!row) return null;

  const ci = mapCiRow(row);

  const [sources, overlays, state, counts] = await Promise.all([
    sourceLinksFor(tenantId, ciId, executor),
    overlaysFor(tenantId, ciId, executor),
    stateFor(tenantId, ciId, executor),
    openTicketCounts(tenantId, [ciId], executor),
  ]);

  ci.sources = sources;
  ci.overlays = overlays;
  ci.state = state;
  ci.openTicketCount = counts.get(ciId) ?? 0;
  return ci;
}

/** {@link get}, but 404 instead of null. The shape every mutation starts from. */
export async function requireCi(
  tenantId: number,
  ciId: number,
  executor: Executor = db,
): Promise<CiRecord> {
  const row = (await scoped('cis', tenantId, executor)
    .where('cis.id', ciId)
    .first(...CI_COLUMNS)) as CiRow | undefined;
  if (!row) throw notFound('Configuration item not found');
  return mapCiRow(row);
}

export async function overlaysFor(
  tenantId: number,
  ciId: number,
  executor: Executor = db,
): Promise<CiOverlayRecord[]> {
  const rows = (await scoped('ci_overlays', tenantId, executor)
    .where('ci_overlays.ci_id', ciId)
    .orderBy('ci_overlays.key', 'asc')
    .select('ci_overlays.id', 'ci_overlays.ci_id', 'ci_overlays.tenant_id', 'ci_overlays.key', 'ci_overlays.value')) as unknown as Array<{
    id: number;
    ci_id: number;
    tenant_id: number;
    key: string;
    value: unknown;
  }>;

  return rows.map((row) => ({
    id: Number(row.id),
    ciId: Number(row.ci_id),
    tenantId: Number(row.tenant_id),
    key: row.key,
    value: parseJson(row.value),
  }));
}

export async function stateFor(
  tenantId: number,
  ciId: number,
  executor: Executor = db,
): Promise<CiStateRecord | null> {
  const row = (await scoped('ci_state_cache', tenantId, executor)
    .where('ci_state_cache.ci_id', ciId)
    .first(
      'ci_state_cache.ci_id',
      'ci_state_cache.tenant_id',
      'ci_state_cache.online',
      'ci_state_cache.state',
      'ci_state_cache.observed_at',
    )) as
    | {
        ci_id: number;
        tenant_id: number;
        online: boolean | null;
        state: unknown;
        observed_at: Date | string | null;
      }
    | undefined;

  if (!row) return null;
  return {
    ciId: Number(row.ci_id),
    tenantId: Number(row.tenant_id),
    online: row.online ?? null,
    state: parseJsonObject(row.state),
    observedAt: iso(row.observed_at),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// The seam the live proxy reads
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every place this ONE CI is mirrored from.
 *
 * This is the whole allow-list the cross-app proxy is permitted to reach: the
 * client sends a `ci_id` and an app slug, and the host, path and external id
 * come from HERE, out of the database, never out of the request. A proxy that
 * accepted a URL or a path from the browser would be an SSRF holding a
 * privileged app key.
 */
export async function sourceLinksFor(
  tenantId: number,
  ciId: number,
  executor: Executor = db,
): Promise<CiSourceLinkRecord[]> {
  const rows = (await scoped('ci_source_links', tenantId, executor)
    .where('ci_source_links.ci_id', ciId)
    .orderBy('ci_source_links.app_type', 'asc')
    .select(
      'ci_source_links.id',
      'ci_source_links.ci_id',
      'ci_source_links.tenant_id',
      'ci_source_links.app_type',
      'ci_source_links.external_id',
      'ci_source_links.external_path',
      'ci_source_links.url',
      'ci_source_links.last_fetched_at',
      'ci_source_links.payload',
    )) as unknown as Array<{
    id: number;
    ci_id: number;
    tenant_id: number;
    app_type: string;
    external_id: string;
    external_path: string | null;
    url: string | null;
    last_fetched_at: Date | string | null;
    payload: unknown;
  }>;

  return rows.map((row) => ({
    id: Number(row.id),
    ciId: Number(row.ci_id),
    tenantId: Number(row.tenant_id),
    appType: row.app_type,
    externalId: row.external_id,
    externalPath: row.external_path ?? null,
    url: row.url ?? null,
    lastFetchedAt: iso(row.last_fetched_at),
    payload: parseJsonObject(row.payload),
  }));
}

/**
 * The link for one app, or null when this CI is not mirrored there.
 *
 * Null is the proxy's cue to answer `unavailable('not_linked')` for that
 * section, which is a different and more useful sentence than an empty success.
 */
export async function sourceLinkFor(
  tenantId: number,
  ciId: number,
  appType: CiSourceApp | string,
  executor: Executor = db,
): Promise<CiSourceLinkRecord | null> {
  const wanted = String(appType).toLowerCase();
  const links = await sourceLinksFor(tenantId, ciId, executor);
  return links.find((link) => link.appType.toLowerCase() === wanted) ?? null;
}

/**
 * Write back what a sibling app answered.
 *
 * THIS IS A CACHE WRITE, and it is the only one. `payload` is the other app's
 * data, held so a rail can paint before the network answers and so a dead
 * source can still show something with an honest age on it. It is never read as
 * if the desk owned it, it is never merged into `cis`, and `lastFetchedAt` goes
 * with it everywhere it is rendered.
 *
 * Called by the live proxy after a successful cross-app read. Upserts on
 * (ci_id, app_type, external_id), matching `ci_source_links_uq`.
 */
export async function cacheSourcePayload(
  tenantId: number,
  ciId: number,
  input: {
    appType: CiSourceApp | string;
    externalId: string;
    externalPath?: string | null;
    url?: string | null;
    payload: Record<string, unknown>;
    fetchedAt?: Date;
  },
  executor: Executor = db,
): Promise<void> {
  await insertScoped(
    'ci_source_links',
    tenantId,
    {
      ci_id: ciId,
      app_type: input.appType,
      external_id: input.externalId,
      external_path: input.externalPath ?? null,
      url: input.url ?? null,
      last_fetched_at: input.fetchedAt ?? new Date(),
      payload: JSON.stringify(input.payload ?? {}),
    },
    executor,
  )
    .onConflict(['ci_id', 'app_type', 'external_id'])
    .merge(['external_path', 'url', 'last_fetched_at', 'payload']);
}

// ═════════════════════════════════════════════════════════════════════════════
// upsertByUuid() — THE identity rule
// ═════════════════════════════════════════════════════════════════════════════

export interface UpsertByUuidResult {
  ciId: number;
  created: boolean;
}

/**
 * Find or create a CI from a hardware UUID. ONE key.
 *
 * This is the canonical implementation of the identity rule, extracted so the
 * suite has exactly one of it.
 *
 * TODO(migrate): `alert.service.resolveCi()` still carries its own copy of this
 * logic and is the caller to move over. The two are deliberately identical
 * today, down to the details that look like oversights and are not:
 *   • `display_name` is NOT overwritten on an existing row. The desk owns that
 *     field, an operator may have renamed the machine to something a human
 *     recognises, and letting a monitor's name win would undo that on the next
 *     beat.
 *   • `last_seen_at` IS touched on every call, because "when did the suite last
 *     mention this machine" is the one thing the sighting proves.
 * Change one of them and change the other in the same commit, or the desk will
 * have two identity rules and no way to tell which one made a given row.
 *
 * No audit row for a plain sighting: an alert stream would write one per beat.
 * A CREATION is audited, because a new machine appearing in the desk is a fact
 * somebody may need to explain later.
 */
export async function upsertByUuid(
  tenantId: number,
  hardwareUuid: string,
  attrs: { displayName?: string | null; kind?: CiKind } = {},
  options: { actor?: CiActor; executor?: Executor } = {},
): Promise<UpsertByUuidResult> {
  const uuid = hardwareUuid?.trim();
  if (!uuid) {
    throw badRequest('A hardware UUID is required to identify a configuration item');
  }

  const executor = options.executor ?? db;
  const actor = options.actor ?? SYSTEM_ACTOR;

  const existing = (await scoped('cis', tenantId, executor)
    .where('cis.hardware_uuid', uuid)
    .first('cis.id')) as { id: number } | undefined;

  if (existing) {
    await scoped('cis', tenantId, executor)
      .where('cis.id', existing.id)
      .update({ last_seen_at: executor.fn.now() });
    return { ciId: Number(existing.id), created: false };
  }

  try {
    const [created] = (await insertScoped(
      'cis',
      tenantId,
      {
        kind: attrs.kind ?? 'device',
        display_name: attrs.displayName?.trim() || uuid,
        hardware_uuid: uuid,
        first_seen_at: executor.fn.now(),
        last_seen_at: executor.fn.now(),
      },
      executor,
    ).returning('id')) as unknown as Array<{ id: number } | number>;

    const ciId = Number(typeof created === 'object' ? created.id : created);

    await auditService.record(
      {
        tenantId,
        actorId: actor.actorId ?? null,
        actorType: actor.actorType ?? 'system',
        action: 'ci.create',
        entityType: 'ci',
        entityId: ciId,
        after: { hardwareUuid: uuid, kind: attrs.kind ?? 'device' },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      executor,
    );

    return { ciId, created: true };
  } catch (error) {
    // Two sightings of a new machine can race between the SELECT and the
    // INSERT. `cis_tenant_hwuuid_uq` catches it; the loser re-reads rather than
    // failing the ingest that was only ever asking "which CI is this?".
    if ((error as { code?: string }).code !== '23505') throw error;
    const raced = (await scoped('cis', tenantId, executor)
      .where('cis.hardware_uuid', uuid)
      .first('cis.id')) as { id: number } | undefined;
    if (!raced) throw error;
    return { ciId: Number(raced.id), created: false };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Desk-owned writes
// ═════════════════════════════════════════════════════════════════════════════

export interface DeskFieldsPatch {
  ownerContactId?: number | null;
  criticality?: CiCriticality | null;
  supportGroupId?: number | null;
}

/**
 * The ONLY attributes of a machine Oblidesk owns.
 *
 * Anything else a technician wants to change (hostname, RAM, OS build, patch
 * level) belongs to the app that owns it: the fix is in Obliance, and writing a
 * local copy here would create a second answer nobody could tell from the first.
 *
 * Both id fields are re-checked against THIS tenant. The foreign keys prove the
 * contact and the group exist; they do not prove they belong to the caller, and
 * pointing a CI at another customer's assignment group is a cross-tenant leak
 * that would read as a support routing bug for months.
 */
export async function setDeskFields(
  tenantId: number,
  ciId: number,
  patch: DeskFieldsPatch,
  actor: CiActor,
  executor: Executor = db,
): Promise<CiRecord> {
  const run = async (trx: Knex.Transaction): Promise<CiRecord> => {
    const before = await requireCi(tenantId, ciId, trx);

    const update: Record<string, unknown> = {};

    if (patch.ownerContactId !== undefined) {
      if (patch.ownerContactId !== null) {
        const contact = await scoped('portal_contacts', tenantId, trx)
          .where('portal_contacts.id', patch.ownerContactId)
          .first('portal_contacts.id');
        if (!contact) throw badRequest('That contact does not exist in this tenant');
      }
      update.owner_contact_id = patch.ownerContactId;
    }

    if (patch.supportGroupId !== undefined) {
      if (patch.supportGroupId !== null) {
        const group = await scoped('assignment_groups', tenantId, trx)
          .where('assignment_groups.id', patch.supportGroupId)
          .first('assignment_groups.id');
        if (!group) throw badRequest('That assignment group does not exist in this tenant');
      }
      update.support_group_id = patch.supportGroupId;
    }

    if (patch.criticality !== undefined) update.criticality = patch.criticality;

    if (Object.keys(update).length === 0) return before;

    await scoped('cis', tenantId, trx).where('cis.id', ciId).update(update);
    const after = await requireCi(tenantId, ciId, trx);

    await auditService.record(
      {
        tenantId,
        actorId: actor.actorId,
        actorType: actor.actorType ?? 'user',
        action: 'ci.desk_fields.update',
        entityType: 'ci',
        entityId: ciId,
        before: {
          ownerContactId: before.ownerContactId,
          criticality: before.criticality,
          supportGroupId: before.supportGroupId,
        },
        after: {
          ownerContactId: after.ownerContactId,
          criticality: after.criticality,
          supportGroupId: after.supportGroupId,
        },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      trx,
    );

    return after;
  };

  return isTransaction(executor) ? run(executor) : db.transaction(run);
}

/**
 * Set one desk-owned key/value.
 *
 * `ci_overlays` is for attributes the DESK invented: a room number, an asset
 * tag from a spreadsheet, a note about the tricky docking station. Never mirror
 * a sibling app's field into it. The moment two systems hold the same fact, one
 * of them is wrong and nobody can tell which.
 */
export async function setOverlay(
  tenantId: number,
  ciId: number,
  key: string,
  value: unknown,
  actor: CiActor,
  executor: Executor = db,
): Promise<CiOverlayRecord[]> {
  const trimmed = key.trim();
  if (!trimmed) throw badRequest('An overlay key is required');

  const run = async (trx: Knex.Transaction): Promise<CiOverlayRecord[]> => {
    await requireCi(tenantId, ciId, trx);

    const before = (await scoped('ci_overlays', tenantId, trx)
      .where({ ci_id: ciId, key: trimmed })
      .first('ci_overlays.value')) as { value: unknown } | undefined;

    await insertScoped(
      'ci_overlays',
      tenantId,
      { ci_id: ciId, key: trimmed, value: JSON.stringify(value ?? null) },
      trx,
    )
      .onConflict(['ci_id', 'key'])
      .merge(['value']);

    await auditService.record(
      {
        tenantId,
        actorId: actor.actorId,
        actorType: actor.actorType ?? 'user',
        action: 'ci.overlay.set',
        entityType: 'ci',
        entityId: ciId,
        before: before ? { key: trimmed, value: parseJson(before.value) } : null,
        after: { key: trimmed, value: value ?? null },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      trx,
    );

    return overlaysFor(tenantId, ciId, trx);
  };

  return isTransaction(executor) ? run(executor) : db.transaction(run);
}

/** Drop one desk-owned key. Removing a key nobody set is a no-op, not an error. */
export async function removeOverlay(
  tenantId: number,
  ciId: number,
  key: string,
  actor: CiActor,
  executor: Executor = db,
): Promise<CiOverlayRecord[]> {
  const trimmed = key.trim();
  if (!trimmed) throw badRequest('An overlay key is required');

  const run = async (trx: Knex.Transaction): Promise<CiOverlayRecord[]> => {
    await requireCi(tenantId, ciId, trx);

    const before = (await scoped('ci_overlays', tenantId, trx)
      .where({ ci_id: ciId, key: trimmed })
      .first('ci_overlays.value')) as { value: unknown } | undefined;

    if (before) {
      await scoped('ci_overlays', tenantId, trx).where({ ci_id: ciId, key: trimmed }).delete();

      await auditService.record(
        {
          tenantId,
          actorId: actor.actorId,
          actorType: actor.actorType ?? 'user',
          action: 'ci.overlay.remove',
          entityType: 'ci',
          entityId: ciId,
          before: { key: trimmed, value: parseJson(before.value) },
          after: null,
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
        },
        trx,
      );
    }

    return overlaysFor(tenantId, ciId, trx);
  };

  return isTransaction(executor) ? run(executor) : db.transaction(run);
}

/**
 * Retire a CI. NEVER a hard delete.
 *
 * Tickets, `ticket_cis` rows and frozen `ticket_evidence` all point at this id.
 * A DELETE would either cascade them away or leave them orphaned, and in both
 * cases the ticket that says "the laptop was replaced" loses the laptop it was
 * about. Setting `deleted_at` takes the CI out of every list while every record
 * that referenced it still resolves.
 */
export async function softDelete(
  tenantId: number,
  ciId: number,
  actor: CiActor,
  executor: Executor = db,
): Promise<CiRecord> {
  const run = async (trx: Knex.Transaction): Promise<CiRecord> => {
    const before = await requireCi(tenantId, ciId, trx);
    if (before.deletedAt) return before;

    await scoped('cis', tenantId, trx).where('cis.id', ciId).update({ deleted_at: trx.fn.now() });
    const after = await requireCi(tenantId, ciId, trx);

    await auditService.record(
      {
        tenantId,
        actorId: actor.actorId,
        actorType: actor.actorType ?? 'user',
        action: 'ci.delete',
        entityType: 'ci',
        entityId: ciId,
        before: { displayName: before.displayName, deletedAt: before.deletedAt },
        after: { displayName: after.displayName, deletedAt: after.deletedAt },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      trx,
    );

    return after;
  };

  return isTransaction(executor) ? run(executor) : db.transaction(run);
}

// ═════════════════════════════════════════════════════════════════════════════
// Ticket links
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Attach a CI to a ticket.
 *
 * `ticket_cis` and `tickets.primary_ci_id` record the same fact two ways.
 * `ticket.service` owns the column (it writes it on create, and every reader
 * that matters already checks both), so this function writes only the join
 * table. Reaching across to set `primary_ci_id` from here would put a second
 * writer on a field one service is responsible for.
 */
export async function linkTicket(
  tenantId: number,
  ticketId: number,
  ciId: number,
  role: TicketCiRole,
  actor: CiActor,
  executor: Executor = db,
): Promise<TicketCiLink[]> {
  const run = async (trx: Knex.Transaction): Promise<TicketCiLink[]> => {
    await requireCi(tenantId, ciId, trx);
    await requireTicket(tenantId, ticketId, trx);

    await insertScoped(
      'ticket_cis',
      tenantId,
      { ticket_id: ticketId, ci_id: ciId, role },
      trx,
    )
      .onConflict(['ticket_id', 'ci_id'])
      .merge(['role']);

    await auditService.record(
      {
        tenantId,
        actorId: actor.actorId,
        actorType: actor.actorType ?? 'user',
        action: 'ci.ticket.link',
        entityType: 'ci',
        entityId: ciId,
        after: { ticketId, role },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      trx,
    );

    return listForTicket(tenantId, ticketId, trx);
  };

  return isTransaction(executor) ? run(executor) : db.transaction(run);
}

/** Detach a CI from a ticket. Unlinking something already unlinked is a no-op. */
export async function unlinkTicket(
  tenantId: number,
  ticketId: number,
  ciId: number,
  actor: CiActor,
  executor: Executor = db,
): Promise<TicketCiLink[]> {
  const run = async (trx: Knex.Transaction): Promise<TicketCiLink[]> => {
    const existing = (await scoped('ticket_cis', tenantId, trx)
      .where({ ticket_id: ticketId, ci_id: ciId })
      .first('ticket_cis.role')) as { role: string } | undefined;

    if (existing) {
      await scoped('ticket_cis', tenantId, trx)
        .where({ ticket_id: ticketId, ci_id: ciId })
        .delete();

      await auditService.record(
        {
          tenantId,
          actorId: actor.actorId,
          actorType: actor.actorType ?? 'user',
          action: 'ci.ticket.unlink',
          entityType: 'ci',
          entityId: ciId,
          before: { ticketId, role: existing.role },
          after: null,
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
        },
        trx,
      );
    }

    return listForTicket(tenantId, ticketId, trx);
  };

  return isTransaction(executor) ? run(executor) : db.transaction(run);
}

/** The CIs a ticket touches, with the liveness the rail puts a dot next to. */
export async function listForTicket(
  tenantId: number,
  ticketId: number,
  executor: Executor = db,
): Promise<TicketCiLink[]> {
  const rows = (await scoped('ticket_cis', tenantId, executor)
    .where('ticket_cis.ticket_id', ticketId)
    .join('cis', 'cis.id', 'ticket_cis.ci_id')
    .where('cis.tenant_id', tenantId)
    .leftJoin('ci_state_cache', function joinState() {
      this.on('ci_state_cache.ci_id', '=', 'cis.id').andOn(
        'ci_state_cache.tenant_id',
        '=',
        'cis.tenant_id',
      );
    })
    .orderBy('cis.display_name', 'asc')
    .select(
      'ticket_cis.ticket_id',
      'ticket_cis.ci_id',
      'ticket_cis.role',
      'cis.display_name',
      'cis.kind',
      'cis.criticality',
      'cis.hardware_uuid',
      'cis.deleted_at',
      'ci_state_cache.online',
      'ci_state_cache.observed_at',
    )) as unknown as Array<{
    ticket_id: number;
    ci_id: number;
    role: string;
    display_name: string;
    kind: string;
    criticality: string | null;
    hardware_uuid: string | null;
    deleted_at: Date | string | null;
    online: boolean | null;
    observed_at: Date | string | null;
  }>;

  return rows.map((row) => ({
    ticketId: Number(row.ticket_id),
    ciId: Number(row.ci_id),
    role: row.role as TicketCiRole,
    ci: {
      id: Number(row.ci_id),
      displayName: row.display_name,
      kind: row.kind as CiKind,
      criticality: (row.criticality as CiCriticality | null) ?? null,
      hardwareUuid: row.hardware_uuid ?? null,
      deletedAt: iso(row.deleted_at),
      online: row.online ?? null,
      observedAt: iso(row.observed_at),
    },
  }));
}

/**
 * The mirror of {@link listForTicket}: the tickets a CI appears on.
 *
 * The context rail reads this through `GET /api/tickets?ciIds=` (which already
 * exists and already applies the caller's queue visibility). This is the
 * server-side equivalent, for callers that have a CI and want the short list
 * without going back out through HTTP.
 */
export async function ticketsForCi(
  tenantId: number,
  ciId: number,
  options: { limit?: number; openOnly?: boolean; executor?: Executor } = {},
): Promise<CiTicketRef[]> {
  const executor = options.executor ?? db;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), PAGINATION.maxLimit);

  const qb = scoped('tickets', tenantId, executor)
    .whereNull('tickets.deleted_at')
    .leftJoin('ticket_cis', function joinLink() {
      this.on('ticket_cis.ticket_id', '=', 'tickets.id')
        .andOn('ticket_cis.ci_id', '=', executor.raw('?', [ciId]))
        .andOn('ticket_cis.tenant_id', '=', 'tickets.tenant_id');
    })
    .where((b) => {
      b.where('tickets.primary_ci_id', ciId).orWhereNotNull('ticket_cis.ci_id');
    });

  if (options.openOnly) qb.whereIn('tickets.status_category', OPEN_CATEGORY_LIST);

  const rows = (await qb
    .orderBy('tickets.updated_at', 'desc')
    .limit(limit)
    .select(
      'tickets.id',
      'tickets.number',
      'tickets.subject',
      'tickets.status_category',
      'tickets.priority_slug',
      'tickets.updated_at',
      'ticket_cis.role',
    )) as unknown as Array<{
    id: number;
    number: string;
    subject: string;
    status_category: string;
    priority_slug: string | null;
    updated_at: Date | string | null;
    role: string | null;
  }>;

  return rows.map((row) => ({
    id: Number(row.id),
    number: row.number,
    subject: row.subject,
    statusCategory: row.status_category,
    prioritySlug: row.priority_slug ?? null,
    role: (row.role as TicketCiRole | null) ?? null,
    updatedAt: iso(row.updated_at),
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// Internals
// ═════════════════════════════════════════════════════════════════════════════

async function requireTicket(
  tenantId: number,
  ticketId: number,
  executor: Executor,
): Promise<void> {
  const ticket = await scoped('tickets', tenantId, executor)
    .where('tickets.id', ticketId)
    .whereNull('tickets.deleted_at')
    .first('tickets.id');
  if (!ticket) throw notFound('Ticket not found');
}

/** Same test `audit.service` uses, so "am I already in a transaction?" has one answer. */
function isTransaction(executor: Executor): executor is Knex.Transaction {
  return Boolean(executor && (executor as Knex.Transaction).isTransaction);
}
