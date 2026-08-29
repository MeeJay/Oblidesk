/**
 * ticketNumber.service.ts — the human ticket number allocator.
 *
 * A ticket has two identities: `tickets.id` (a surrogate the database owns and
 * the UI never shows) and `tickets.number` — `ACME-1042` — which is what people
 * say on the phone, put in an email subject and search for six months later.
 *
 * The number comes from `ticket_sequences`, one row per tenant:
 *
 *     ticket_sequences (tenant_id PK, prefix, last_number)
 *
 * ── Why not a Postgres sequence? ─────────────────────────────────────────────
 * Because a sequence is deliberately NOT transactional: `nextval()` keeps its
 * increment when the surrounding transaction rolls back, so a failed create
 * burns a number. Customers read gaps as lost tickets ("what happened to
 * ACME-1041?"), and no amount of explaining makes that go away. A row with
 * `SELECT … FOR UPDATE` is gapless because the allocation lives and dies with
 * the transaction that inserted the ticket, at the cost of serialising ticket
 * creation *per tenant* — which at desk volumes is free.
 *
 * The allocator therefore MUST be called inside the same transaction as the
 * INSERT into `tickets`, and it takes the executor as an argument to make
 * forgetting that awkward.
 */
import type { Knex } from 'knex';
import { DEFAULT_TICKET_PREFIX } from '@oblidesk/shared';

import { db, insertScoped, scoped, type Executor } from '../db';

/** Prefixes are what people type; keep them short, upper-case and boring. */
const PREFIX_MAX_LENGTH = 16;
const PREFIX_SAFE_RE = /[^A-Z0-9]/g;

export interface AllocatedTicketNumber {
  /** The full human number, e.g. `ACME-1042`. */
  number: string;
  prefix: string;
  sequence: number;
}

/**
 * Normalise a candidate prefix. Anything that is not A-Z or 0-9 is dropped, so
 * a tenant slug like `acme-corp` becomes `ACMECORP` rather than producing a
 * number with two separators in it.
 */
export function normalizeTicketPrefix(candidate: string | null | undefined): string {
  const cleaned = (candidate ?? '').toUpperCase().replace(PREFIX_SAFE_RE, '').slice(0, PREFIX_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : DEFAULT_TICKET_PREFIX;
}

/**
 * Read a tenant's configured prefix without allocating anything. Used by the
 * settings screen so an admin can see what the next number will look like.
 */
export async function getTicketPrefix(tenantId: number, executor: Executor = db): Promise<string> {
  const row = await scoped('ticket_sequences', tenantId, executor).first<{ prefix: string }>('prefix');
  return normalizeTicketPrefix(row?.prefix ?? null);
}

/**
 * Peek at the number that would be allocated next. Advisory only — two callers
 * peeking concurrently see the same answer, which is exactly why `allocate()`
 * exists and this does not lock.
 */
export async function peekNextTicketNumber(
  tenantId: number,
  executor: Executor = db,
): Promise<string> {
  const row = await scoped('ticket_sequences', tenantId, executor)
    .first<{ prefix: string; last_number: string | number }>('prefix', 'last_number');
  const prefix = normalizeTicketPrefix(row?.prefix ?? null);
  const last = Number(row?.last_number ?? 0);
  return formatTicketNumber(prefix, last + 1);
}

export function formatTicketNumber(prefix: string, sequence: number): string {
  return `${prefix}-${sequence}`;
}

/**
 * Split `ACME-1042` back into its parts. Returns null for anything that is not
 * a ticket number, which is how the search box decides whether a query is a
 * lookup or a phrase.
 */
export function parseTicketNumber(value: string): { prefix: string; sequence: number } | null {
  const match = /^([A-Za-z0-9]{1,16})-(\d{1,18})$/.exec(value.trim());
  if (!match) return null;
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
  return { prefix: match[1].toUpperCase(), sequence };
}

/**
 * Allocate the next number for a tenant.
 *
 * MUST run inside the transaction that inserts the ticket. The `FOR UPDATE`
 * lock is held until that transaction ends, which is what makes the sequence
 * gapless: a rollback un-allocates the number.
 *
 * The sequence row is created on first use, so a tenant provisioned before
 * `ticket_sequences` was seeded (or created by an admin screen that forgot)
 * still gets `TKT-1` rather than a foreign-key error on its first ticket.
 */
export async function allocateTicketNumber(
  tenantId: number,
  trx: Knex.Transaction,
  options: { prefixHint?: string | null } = {},
): Promise<AllocatedTicketNumber> {
  let row = await scoped('ticket_sequences', tenantId, trx)
    .forUpdate()
    .first<{ prefix: string; last_number: string | number }>('prefix', 'last_number');

  if (!row) {
    // Race-safe bootstrap: two concurrent first-tickets both try to insert, one
    // wins, and the loser falls through to the re-select below with the lock.
    await insertScoped(
      'ticket_sequences',
      tenantId,
      {
        prefix: normalizeTicketPrefix(options.prefixHint ?? process.env.DEFAULT_TICKET_PREFIX ?? null),
        last_number: 0,
      },
      trx,
    )
      .onConflict('tenant_id')
      .ignore();

    row = await scoped('ticket_sequences', tenantId, trx)
      .forUpdate()
      .first<{ prefix: string; last_number: string | number }>('prefix', 'last_number');
  }

  if (!row) {
    throw new Error(`ticketNumber: could not create a sequence row for tenant ${tenantId}`);
  }

  const prefix = normalizeTicketPrefix(row.prefix);
  // `last_number` is a bigint — node-postgres hands those back as strings, so
  // Number() is mandatory. Silently concatenating "1042" + 1 is a classic.
  const next = Number(row.last_number) + 1;

  await scoped('ticket_sequences', tenantId, trx).update({ last_number: next });

  return { number: formatTicketNumber(prefix, next), prefix, sequence: next };
}

/**
 * Change a tenant's prefix without renumbering anything. Existing tickets keep
 * the number they were issued — a ticket number is a name, and renaming a
 * thousand of them breaks every link and email thread that referenced them.
 */
export async function setTicketPrefix(
  tenantId: number,
  prefix: string,
  executor: Executor = db,
): Promise<string> {
  const normalised = normalizeTicketPrefix(prefix);
  const updated = await scoped('ticket_sequences', tenantId, executor).update({ prefix: normalised });
  if (updated === 0) {
    await insertScoped(
      'ticket_sequences',
      tenantId,
      { prefix: normalised, last_number: 0 },
      executor,
    )
      .onConflict('tenant_id')
      .merge(['prefix']);
  }
  return normalised;
}
