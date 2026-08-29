/**
 * journal.service.ts — the ticket timeline.
 *
 * `ticket_journal` is append-only and per-ticket sequenced:
 *
 *     UNIQUE (ticket_id, seq)   seq is 1-based, gapless, never renumbered
 *
 * ── Public reply vs work note is a COLUMN, not a flag ────────────────────────
 * `visibility` is `'public' | 'internal'`, a CHECK-constrained column with its
 * own partial index (`ticket_journal_public`). It is deliberately not a boolean
 * called `isInternal` and not something derived from `kind`: the portal query
 * is `WHERE visibility = 'public'`, and the only way to be certain a work note
 * can never leak to a customer is for that predicate to be a first-class,
 * indexable, CHECK-constrained value that every reader filters on. A boolean
 * inverted at one call site is a data breach; a column with an index is a query
 * plan.
 *
 * ── Why seq is allocated under a row lock ────────────────────────────────────
 * Two agents replying at the same instant both compute `MAX(seq) + 1` and one
 * insert violates the unique index. Retrying is possible but produces a
 * different failure — reordered entries — under load. Taking `SELECT … FOR
 * UPDATE` on the TICKET row (not on the journal) serialises appends per ticket
 * and costs nothing, because two people replying to the same ticket in the same
 * millisecond is already a collision the UI is warning them about.
 *
 * ── A merge NEVER moves journal rows ─────────────────────────────────────────
 * See `ticket.service.ts#merge`. Rows stay on the ticket they were written
 * against so `seq` stays stable and permalinks keep resolving; a merge writes
 * exactly one synthesised `merge` row on each side.
 */
import type { Knex } from 'knex';
import {
  COLLAPSIBLE_JOURNAL_KINDS,
  JOURNAL_KINDS,
  PAGINATION,
  ROOMS,
  SOCKET_EVENTS,
  type ActorType,
  type JournalKind,
  type JournalMeta,
  type JournalVisibility,
  type SocketEventName,
  type TicketJournalEntry,
} from '@oblidesk/shared';

import { db, insertScoped, scoped, type Executor } from '../db';
import { renderMarkdown } from '../utils/markdown';
import { AppError } from '../middleware/errorHandler';

// ═════════════════════════════════════════════════════════════════════════════
// Realtime fan-out
// ═════════════════════════════════════════════════════════════════════════════
//
// The socket server is wired at boot by `src/index.ts`; the desk services must
// not import it, or every unit test would need a live io instance and the
// import graph would become a cycle (socket → services → socket).
//
// So the registry lives HERE, in the lowest desk module that needs to emit, and
// `ticket.service.ts` re-exports it for convenience. Until something registers,
// every emit is a no-op — the desk works, it is just quiet.

export interface DeskRealtime {
  /** Emit one event to every listed room. Must never throw. */
  emit(rooms: readonly string[], event: SocketEventName, payload: unknown): void;
}

const NOOP_REALTIME: DeskRealtime = {
  emit: () => {
    /* no socket server registered — see registerDeskRealtime() */
  },
};

let realtime: DeskRealtime = NOOP_REALTIME;

/**
 * Wire the socket server into the desk services. Call once from `index.ts`:
 *
 *     registerDeskRealtime({
 *       emit: (rooms, event, payload) => { for (const r of rooms) io.to(r).emit(event, payload); },
 *     });
 */
export function registerDeskRealtime(next: DeskRealtime | null): void {
  realtime = next ?? NOOP_REALTIME;
}

/** Emit without ever letting a socket problem fail the database work. */
export function emitDeskEvent(
  rooms: readonly string[],
  event: SocketEventName,
  payload: unknown,
): void {
  try {
    realtime.emit(rooms, event, payload);
  } catch {
    /* a dead socket must never roll back a ticket */
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Markdown
// ═════════════════════════════════════════════════════════════════════════════
//
// `utils/markdown.ts` is owned by another module; it may render synchronously
// or asynchronously. Normalising the shape here means a change there is not a
// change everywhere.
type MarkdownRenderer = (markdown: string) => string | Promise<string>;
const render = renderMarkdown as unknown as MarkdownRenderer;

async function toHtml(bodyMd: string | null | undefined): Promise<string | null> {
  if (bodyMd === null || bodyMd === undefined || bodyMd === '') return null;
  return (await render(bodyMd)) ?? null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Rows ↔ DTOs
// ═════════════════════════════════════════════════════════════════════════════

interface JournalRow {
  id: string | number;
  ticket_id: number;
  tenant_id: number;
  seq: number;
  kind: string;
  visibility: string;
  author_id: number | null;
  author_contact_id: number | null;
  author_type: string;
  body_md: string | null;
  body_html: string | null;
  meta: JournalMeta | null;
  created_at: Date | string;
  author_username?: string | null;
  author_display_name?: string | null;
  author_avatar?: string | null;
  contact_email?: string | null;
  contact_display_name?: string | null;
}

function iso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function mapJournalRow(row: JournalRow): TicketJournalEntry {
  const entry: TicketJournalEntry = {
    // `ticket_journal.id` is a bigint; node-postgres returns those as strings.
    id: Number(row.id),
    ticketId: row.ticket_id,
    tenantId: row.tenant_id,
    seq: row.seq,
    kind: row.kind as JournalKind,
    visibility: row.visibility as JournalVisibility,
    authorId: row.author_id,
    authorContactId: row.author_contact_id,
    // Legacy rows may carry 'contact'; the DTO's vocabulary calls that 'portal'.
    authorType: (row.author_type === 'contact' ? 'portal' : row.author_type) as ActorType,
    bodyMd: row.body_md,
    bodyHtml: row.body_html,
    meta: (row.meta ?? {}) as JournalMeta,
    createdAt: iso(row.created_at),
  };

  if (row.author_id !== null && row.author_username !== undefined) {
    entry.author = {
      id: row.author_id,
      username: row.author_username ?? '',
      displayName: row.author_display_name ?? null,
      avatar: row.author_avatar ?? null,
    };
  }
  if (row.author_contact_id !== null && row.contact_email !== undefined) {
    entry.authorContact = {
      id: row.author_contact_id,
      email: row.contact_email ?? '',
      displayName: row.contact_display_name ?? null,
    };
  }
  return entry;
}

const JOURNAL_KIND_SET: ReadonlySet<string> = new Set(JOURNAL_KINDS);

export function isJournalKind(value: unknown): value is JournalKind {
  return typeof value === 'string' && JOURNAL_KIND_SET.has(value);
}

/** Kinds the UI folds into a single expandable "3 system events" row. */
export function isCollapsibleKind(kind: JournalKind): boolean {
  return (COLLAPSIBLE_JOURNAL_KINDS as readonly string[]).includes(kind);
}

// ═════════════════════════════════════════════════════════════════════════════
// append()
// ═════════════════════════════════════════════════════════════════════════════

export interface AppendJournalInput {
  tenantId: number;
  ticketId: number;
  kind: JournalKind;
  /**
   * The visibility COLUMN. A `public_reply` is public and a `work_note` is
   * internal by definition; every other kind must say so explicitly, and the
   * safe default when it does not is `internal`.
   */
  visibility?: JournalVisibility;
  authorId?: number | null;
  authorContactId?: number | null;
  authorType?: ActorType;
  bodyMd?: string | null;
  /** Pre-rendered HTML. Supply it only when the source was not markdown (mail). */
  bodyHtml?: string | null;
  meta?: JournalMeta;
  /** Emit `ticket:journal` after the write. Off for bulk backfills. */
  emit?: boolean;
}

/**
 * Append one entry and return it.
 *
 * Pass `trx` whenever the entry belongs to a larger action (a transition, a
 * merge, a rule firing) so the entry and the action commit or fail together —
 * a timeline that disagrees with the ticket is worse than no timeline.
 */
export async function append(
  input: AppendJournalInput,
  trx?: Knex.Transaction,
): Promise<TicketJournalEntry> {
  if (trx) return appendInTransaction(input, trx);
  return db.transaction((tx) => appendInTransaction(input, tx));
}

async function appendInTransaction(
  input: AppendJournalInput,
  trx: Knex.Transaction,
): Promise<TicketJournalEntry> {
  const { tenantId, ticketId } = input;

  if (!isJournalKind(input.kind)) {
    throw new AppError(400, `Unknown journal kind "${String(input.kind)}"`);
  }

  // Lock the TICKET row. This is what serialises seq allocation, and it also
  // proves the ticket exists and belongs to this tenant before we write a child
  // row against it.
  const ticket = await scoped('tickets', tenantId, trx)
    .where('tickets.id', ticketId)
    .forUpdate()
    .first<{ id: number }>('tickets.id');

  if (!ticket) throw new AppError(404, 'Ticket not found');

  const maxRow = (await scoped('ticket_journal', tenantId, trx)
    .where('ticket_journal.ticket_id', ticketId)
    .max({ max: 'seq' })) as unknown as Array<{ max: number | string | null }>;
  const seq = Number(maxRow?.[0]?.max ?? 0) + 1;

  const visibility: JournalVisibility =
    input.visibility ??
    (input.kind === 'public_reply' ? 'public' : 'internal');

  const bodyMd = input.bodyMd ?? null;
  const bodyHtml = input.bodyHtml !== undefined ? input.bodyHtml : await toHtml(bodyMd);

  // `ActorType` in @oblidesk/shared spells a requester 'portal', while the
  // table's CHECK also permits the legacy value 'contact'. Write 'portal' so
  // the column and the DTO agree — a row the mapper cannot type is a row the
  // timeline cannot render.
  const authorType: ActorType =
    input.authorType ??
    (input.authorId ? 'user' : input.authorContactId ? 'portal' : 'system');

  const inserted = (await insertScoped(
    'ticket_journal',
    tenantId,
    {
      ticket_id: ticketId,
      seq,
      kind: input.kind,
      visibility,
      author_id: input.authorId ?? null,
      author_contact_id: input.authorContactId ?? null,
      author_type: authorType,
      body_md: bodyMd,
      body_html: bodyHtml,
      meta: JSON.stringify(input.meta ?? {}),
    },
    trx,
  ).returning('*')) as unknown as JournalRow[];

  const entry = mapJournalRow(inserted[0]);

  if (input.emit !== false) {
    emitDeskEvent(
      [ROOMS.ticket(ticketId), ROOMS.tenant(tenantId)],
      SOCKET_EVENTS.journalAppended,
      { tenantId, at: new Date().toISOString(), ticketId, entry },
    );
  }

  return entry;
}

// ═════════════════════════════════════════════════════════════════════════════
// Reads
// ═════════════════════════════════════════════════════════════════════════════

export interface ListJournalOptions {
  /** Portal callers pass `'public'`; the agent console passes nothing. */
  visibility?: JournalVisibility | null;
  kinds?: JournalKind[] | null;
  /** Keyset cursor: return entries with `seq` strictly after / before this. */
  afterSeq?: number | null;
  beforeSeq?: number | null;
  limit?: number;
  /** `'asc'` reads the story forwards; `'desc'` fills the detail pane fastest. */
  direction?: 'asc' | 'desc';
  /** Join the author rows the timeline renders. */
  withAuthors?: boolean;
}

export interface JournalPage {
  entries: TicketJournalEntry[];
  hasMore: boolean;
  /** Feed straight back as `afterSeq` / `beforeSeq`. */
  nextSeq: number | null;
}

export async function list(
  tenantId: number,
  ticketId: number,
  options: ListJournalOptions = {},
  executor: Executor = db,
): Promise<JournalPage> {
  const direction = options.direction ?? 'asc';
  const limit = Math.min(
    Math.max(options.limit ?? PAGINATION.defaultLimit, 1),
    PAGINATION.maxLimit,
  );

  const qb = scoped('ticket_journal', tenantId, executor)
    .where('ticket_journal.ticket_id', ticketId);

  if (options.visibility) qb.where('ticket_journal.visibility', options.visibility);
  if (options.kinds && options.kinds.length > 0) qb.whereIn('ticket_journal.kind', options.kinds);
  if (typeof options.afterSeq === 'number') qb.where('ticket_journal.seq', '>', options.afterSeq);
  if (typeof options.beforeSeq === 'number') qb.where('ticket_journal.seq', '<', options.beforeSeq);

  if (options.withAuthors !== false) {
    qb.leftJoin('users as ju', 'ju.id', 'ticket_journal.author_id')
      .leftJoin('portal_contacts as jc', function joinContact() {
        this.on('jc.id', 'ticket_journal.author_contact_id').andOn(
          'jc.tenant_id',
          '=',
          executor.raw('?', [tenantId]),
        );
      })
      .select(
        'ticket_journal.*',
        'ju.username as author_username',
        'ju.display_name as author_display_name',
        'ju.avatar as author_avatar',
        'jc.email as contact_email',
        'jc.display_name as contact_display_name',
      );
  } else {
    qb.select('ticket_journal.*');
  }

  // Fetch one extra row: cheaper than a second COUNT to answer "is there more?".
  const rows = await qb.orderBy('ticket_journal.seq', direction).limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows) as JournalRow[];
  const entries = page.map(mapJournalRow);

  return {
    entries,
    hasMore,
    nextSeq: hasMore && entries.length > 0 ? entries[entries.length - 1].seq : null,
  };
}

export async function getById(
  tenantId: number,
  entryId: number,
  executor: Executor = db,
): Promise<TicketJournalEntry | null> {
  const row = await scoped('ticket_journal', tenantId, executor)
    .where('ticket_journal.id', entryId)
    .leftJoin('users as ju', 'ju.id', 'ticket_journal.author_id')
    .leftJoin('portal_contacts as jc', function joinContact() {
      this.on('jc.id', 'ticket_journal.author_contact_id').andOn(
        'jc.tenant_id',
        '=',
        executor.raw('?', [tenantId]),
      );
    })
    .first<JournalRow>(
      'ticket_journal.*',
      'ju.username as author_username',
      'ju.display_name as author_display_name',
      'ju.avatar as author_avatar',
      'jc.email as contact_email',
      'jc.display_name as contact_display_name',
    );
  return row ? mapJournalRow(row) : null;
}

/** Number of entries on a ticket, optionally restricted to a kind. */
export async function count(
  tenantId: number,
  ticketId: number,
  filter: { kind?: JournalKind; visibility?: JournalVisibility } = {},
  executor: Executor = db,
): Promise<number> {
  const qb = scoped('ticket_journal', tenantId, executor)
    .where('ticket_journal.ticket_id', ticketId);
  if (filter.kind) qb.where('ticket_journal.kind', filter.kind);
  if (filter.visibility) qb.where('ticket_journal.visibility', filter.visibility);
  const rows = (await qb.count({ count: '*' })) as unknown as Array<{ count: string }>;
  return Number(rows?.[0]?.count ?? 0);
}

/**
 * How many public replies a ticket has had. The baseline state machine guards
 * "wait for requester" on this being ≥ 1 — parking a ticket on someone you
 * never actually asked anything is how backlogs get laundered.
 */
export async function publicReplyCount(
  tenantId: number,
  ticketId: number,
  executor: Executor = db,
): Promise<number> {
  return count(tenantId, ticketId, { kind: 'public_reply', visibility: 'public' }, executor);
}

/** The most recent entry, for rule contexts like `journal.last.kind`. */
export async function lastEntry(
  tenantId: number,
  ticketId: number,
  executor: Executor = db,
): Promise<TicketJournalEntry | null> {
  const row = await scoped('ticket_journal', tenantId, executor)
    .where('ticket_journal.ticket_id', ticketId)
    .orderBy('ticket_journal.seq', 'desc')
    .first<JournalRow>('ticket_journal.*');
  return row ? mapJournalRow(row) : null;
}

/**
 * Bulk counts for a set of tickets — one query, not N. Used by the detail
 * prefetch and the export path.
 */
export async function countsByTicket(
  tenantId: number,
  ticketIds: readonly number[],
  executor: Executor = db,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (ticketIds.length === 0) return out;
  const rows = (await scoped('ticket_journal', tenantId, executor)
    .whereIn('ticket_journal.ticket_id', ticketIds as number[])
    .groupBy('ticket_journal.ticket_id')
    .select('ticket_journal.ticket_id')
    .count({ count: '*' })) as unknown as Array<{ ticket_id: number; count: string }>;
  for (const row of rows) out.set(row.ticket_id, Number(row.count));
  return out;
}
