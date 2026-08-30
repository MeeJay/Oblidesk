/**
 * search.service.ts — full-text and fuzzy ticket search.
 *
 * HARD RULE 8: NO pgvector. The deployment is `postgres:16-alpine`, where the
 * extension does not exist, so every search here is built from the three
 * extensions migration 001 does create:
 *
 *   to_tsvector('simple', …)  ranked lexeme matching
 *   unaccent                  "reseau" finds "réseau"
 *   pg_trgm                   "kubernets" finds "kubernetes"
 *
 * ── Why 'simple' and not 'english' ───────────────────────────────────────────
 * Tenants file tickets in mixed languages — a French desk with English vendor
 * quotes in the body is the normal case, not the exception. An English stemmer
 * mangles French ("données" → "données", but "connexions" ≠ "connexion") and
 * makes recall worse for the majority of the corpus. 'simple' does no stemming
 * at all, which is why the trigram arm is not a nicety: it is what recovers the
 * morphological matches the dictionary would have given us.
 *
 * ── The index this is written against ────────────────────────────────────────
 *   tickets_search_gin     GIN (search_tsv)                — the lexeme arm
 *   tickets_subject_trgm   GIN (subject gin_trgm_ops)      — the fuzzy arm
 *
 * `search_tsv` is maintained by `tickets_search_tsv_trigger()`, never by
 * application code: `unaccent()` is STABLE rather than IMMUTABLE, so the column
 * cannot be generated and cannot be an expression index. Writing it from here
 * would produce a value that disagrees with the trigger on the next UPDATE.
 *
 * This module deliberately returns IDs and scores, not tickets: hydration
 * (joins, tenancy-checked relations, DTO mapping) belongs to `ticket.service`,
 * and keeping it out of here is what stops the two modules from importing each
 * other.
 */
import type { Knex } from 'knex';
import { PAGINATION } from '@oblidesk/shared';

import { db, scoped, type Executor } from '../db';
import { parseTicketNumber } from './ticketNumber.service';

/** Below this length a trigram match is noise, so the fuzzy arm stays off. */
const MIN_TRIGRAM_LENGTH = 3;

/** Longer than this and the user pasted a log file, not a query. */
const MAX_QUERY_LENGTH = 512;

/**
 * The text-search configuration. Never 'english' — see the header.
 *
 * Exported so a module that has to build its own predicate against a DIFFERENT
 * tsvector column (`problems.search_tsv`, whose trigger uses the same
 * configuration) spells it from here rather than from a second literal. Two
 * literals drift, and the one that drifts is the one nobody reads.
 */
export const TS_CONFIG = 'simple';

export interface TicketSearchRow {
  ticketId: number;
  rank: number;
  /** `ts_headline` fragment with `<mark>` around the matches. */
  highlight: string | null;
}

export interface TicketSearchOptions {
  limit?: number;
  /** Skip the (relatively expensive) `ts_headline` when nothing renders it. */
  withHighlight?: boolean;
  includeDeleted?: boolean;
  /** Narrow the corpus before ranking — a queue, a saved view's ids, … */
  restrictToIds?: readonly number[] | null;
  executor?: Executor;
}

/**
 * Trim and cap a raw query string. Returns null when there is nothing worth
 * searching for, which every caller reads as "no text filter".
 */
export function normalizeQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed === '') return null;
  return trimmed.slice(0, MAX_QUERY_LENGTH);
}

/**
 * `websearch_to_tsquery` rather than `to_tsquery`: it accepts anything a human
 * types — quotes, `or`, a leading hyphen — and NEVER raises a syntax error.
 * `to_tsquery('a b')` throws, and a search box that 500s on a space is not a
 * search box.
 */
function tsQuery(knex: Executor, query: string): Knex.Raw {
  return knex.raw(`websearch_to_tsquery('${TS_CONFIG}', unaccent(?))`, [query]);
}

/**
 * Add the text predicate to an existing ticket query.
 *
 * Three arms, OR-ed:
 *   1. the ticket NUMBER — an exact or prefix match wins outright, because
 *      someone typing "ACME-1042" wants that ticket and nothing else;
 *   2. the lexeme arm against `search_tsv` (GIN, unaccented);
 *   3. the trigram arm against `subject` (GIN), for typos and stem misses.
 *
 * The builder is mutated and returned so it composes with the list filters.
 */
export function applyTicketSearch(
  qb: Knex.QueryBuilder,
  query: string,
  knex: Executor = db,
): Knex.QueryBuilder {
  const normalized = normalizeQuery(query);
  if (!normalized) return qb;

  const parsedNumber = parseTicketNumber(normalized);

  return qb.where((b) => {
    // 1 — the number
    if (parsedNumber) {
      b.orWhere('tickets.number', normalized);
    }
    // A partial number ("ACME-10") is still a number lookup; `number` is citext
    // so the comparison is already case-insensitive.
    if (/^[A-Za-z0-9]{1,16}-\d{0,18}$/.test(normalized)) {
      b.orWhere('tickets.number', 'like', `${normalized.replace(/[%_]/g, '\\$&')}%`);
    }

    // 2 — lexemes
    b.orWhereRaw('tickets.search_tsv @@ ?', [tsQuery(knex, normalized)]);

    // 3 — trigrams. `%` (not similarity(...) > x) so the GIN index is usable.
    if (normalized.length >= MIN_TRIGRAM_LENGTH) {
      b.orWhereRaw('tickets.subject % ?', [normalized]);
    }
  });
}

/**
 * The ranking expression.
 *
 * `ts_rank_cd` with normalisation 32 (`rank / (rank + 1)`) keeps the lexeme
 * score inside 0..1 so the trigram similarity — also 0..1 — can be blended with
 * it instead of being drowned out. Recency is a third, deliberately small term:
 * a desk search is "find the thing I half remember", and among equally relevant
 * matches the recent one is almost always the right one — but relevance still
 * has to beat recency, or the search box degenerates into a sorted list.
 */
function rankExpression(knex: Executor, query: string): Knex.Raw {
  return knex.raw(
    `(
       ts_rank_cd(tickets.search_tsv, ?, 32) * 1.0
       + similarity(tickets.subject, ?) * 0.6
       + (1.0 / (1.0 + (EXTRACT(EPOCH FROM (now() - tickets.updated_at)) / 86400.0))) * 0.2
     )`,
    [tsQuery(knex, query), query],
  );
}

/**
 * Highlight over the RAW text, not the unaccented text.
 *
 * The query is unaccented (so "reseau" matches "réseau") but the displayed
 * fragment is not, because showing a French agent "reseau" in their own ticket
 * looks like corruption. The cost is that an accented word matched via unaccent
 * may not get its `<mark>`; the fragment is still the right fragment.
 */
function headlineExpression(knex: Executor, query: string): Knex.Raw {
  return knex.raw(
    `ts_headline(
       '${TS_CONFIG}',
       coalesce(tickets.subject, '') || ' — ' || left(coalesce(tickets.description_md, ''), 800),
       ?,
       'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, FragmentDelimiter= … , MinWords=4, MaxWords=18, HighlightAll=FALSE'
     )`,
    [tsQuery(knex, query)],
  );
}

/**
 * Search a tenant's tickets. Returns ids + scores, ranked; the caller hydrates.
 *
 * Tenant-scoped through `scoped()` like everything else — a search that forgot
 * its tenant would be the single most damaging leak in the product, because it
 * is the one screen where a user is invited to type another customer's name.
 */
export async function searchTickets(
  tenantId: number,
  query: string,
  options: TicketSearchOptions = {},
): Promise<TicketSearchRow[]> {
  const normalized = normalizeQuery(query);
  if (!normalized) return [];

  const knex = options.executor ?? db;
  const limit = Math.min(Math.max(options.limit ?? PAGINATION.defaultLimit, 1), PAGINATION.maxLimit);

  const qb = scoped('tickets', tenantId, knex).select('tickets.id as ticket_id');

  if (!options.includeDeleted) qb.whereNull('tickets.deleted_at');
  if (options.restrictToIds && options.restrictToIds.length > 0) {
    qb.whereIn('tickets.id', options.restrictToIds as number[]);
  }

  applyTicketSearch(qb, normalized, knex);

  qb.select({ rank: rankExpression(knex, normalized) });
  if (options.withHighlight !== false) {
    qb.select({ highlight: headlineExpression(knex, normalized) });
  }

  const rows = (await qb
    .orderBy('rank', 'desc')
    .orderBy('tickets.updated_at', 'desc')
    .limit(limit)) as unknown as Array<{
    ticket_id: number;
    rank: string | number;
    highlight?: string | null;
  }>;

  return rows.map((row) => ({
    ticketId: row.ticket_id,
    rank: Number(row.rank ?? 0),
    highlight: row.highlight ?? null,
  }));
}

/**
 * Type-ahead over subjects and numbers. Trigram-only and capped hard: this runs
 * on every keystroke, so it must never touch `description_md` or headline.
 */
export async function suggestTickets(
  tenantId: number,
  query: string,
  limit = 8,
  executor: Executor = db,
): Promise<Array<{ id: number; number: string; subject: string; statusCategory: string }>> {
  const normalized = normalizeQuery(query);
  if (!normalized) return [];

  const rows = (await scoped('tickets', tenantId, executor)
    .whereNull('tickets.deleted_at')
    .where((b) => {
      b.orWhere('tickets.number', 'like', `${normalized.replace(/[%_]/g, '\\$&')}%`);
      if (normalized.length >= MIN_TRIGRAM_LENGTH) b.orWhereRaw('tickets.subject % ?', [normalized]);
      else b.orWhereRaw('tickets.subject ILIKE ?', [`%${normalized.replace(/[%_]/g, '\\$&')}%`]);
    })
    .select(
      'tickets.id',
      'tickets.number',
      'tickets.subject',
      'tickets.status_category',
    )
    .orderByRaw('similarity(tickets.subject, ?) DESC', [normalized])
    .orderBy('tickets.updated_at', 'desc')
    .limit(Math.min(Math.max(limit, 1), 25))) as unknown as Array<{
    id: number;
    number: string;
    subject: string;
    status_category: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    subject: row.subject,
    statusCategory: row.status_category,
  }));
}

/**
 * Fuzzy lookup used by the "is this a duplicate?" prompt at intake and by the
 * alert binder when it has no dedupe key: same subject, still live, same
 * organisation. Deliberately narrow — a false "duplicate" suggestion trains
 * agents to ignore the prompt.
 */
export async function findSimilarOpenTickets(
  tenantId: number,
  input: {
    subject: string;
    organizationId?: number | null;
    primaryCiId?: number | null;
    excludeTicketId?: number | null;
    limit?: number;
  },
  executor: Executor = db,
): Promise<Array<{ id: number; number: string; subject: string; similarity: number }>> {
  const subject = normalizeQuery(input.subject);
  if (!subject || subject.length < MIN_TRIGRAM_LENGTH) return [];

  const qb = scoped('tickets', tenantId, executor)
    .whereNull('tickets.deleted_at')
    .whereIn('tickets.status_category', [
      'new',
      'open',
      'pending_requester',
      'pending_third_party',
      'scheduled',
    ])
    .whereRaw('tickets.subject % ?', [subject]);

  if (input.excludeTicketId) qb.whereNot('tickets.id', input.excludeTicketId);
  if (input.organizationId) qb.where('tickets.organization_id', input.organizationId);
  if (input.primaryCiId) qb.where('tickets.primary_ci_id', input.primaryCiId);

  const rows = (await qb
    .select('tickets.id', 'tickets.number', 'tickets.subject')
    .select({ score: executor.raw('similarity(tickets.subject, ?)', [subject]) })
    .orderBy('score', 'desc')
    .limit(Math.min(Math.max(input.limit ?? 5, 1), 20))) as unknown as Array<{
    id: number;
    number: string;
    subject: string;
    score: string | number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    subject: row.subject,
    similarity: Number(row.score ?? 0),
  }));
}
