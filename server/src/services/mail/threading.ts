/**
 * threading.ts — deciding which ticket an inbound e-mail belongs to.
 *
 * Around 70% of tickets arrive by mail, and broken threading destroys trust
 * faster than any missing ITIL module: a reply that opens a second ticket makes
 * the desk look like it lost the conversation, and a reply that lands on the
 * WRONG ticket is a data leak. So this module is deliberately conservative —
 * it would rather hand an agent a suggestion than merge two conversations by
 * itself.
 *
 * ── The four tiers, in order ────────────────────────────────────────────────
 *
 *   1. REFERENCES / IN-REPLY-TO   the RFC 5322 message graph, matched against
 *                                 `mail_messages`. The strongest signal there
 *                                 is: the sender's client copied ids we minted.
 *   2. +ALIAS                     a signed sub-address on the recipient, e.g.
 *                                 `support+t42.9f3c…@desk.tld`.
 *   3. SUBJECT TOKEN              `[#ACME-1042-9f3c…]` in the subject line.
 *   4. FUZZY                      same sender + similar subject inside a
 *                                 window. SUGGESTED ONLY. Never auto-merged.
 *
 * Tiers 1–3 may auto-thread. Tier 4 never does, because "same person wrote
 * about something similar last Tuesday" is a hypothesis, not an identity, and
 * a silent merge on it destroys two tickets at once with no undo an agent can
 * find. It returns candidates the composer shows as "is this the same issue?".
 *
 * ── Why the tenant check on tier 1 is not optional ──────────────────────────
 *
 * `mail_messages.message_id` is UNIQUE **per tenant**, not globally. Two
 * tenants can therefore legitimately hold a row with the same Message-ID —
 * which happens for real the moment somebody forwards a thread from one
 * customer's desk to another's, or a shared vendor CCs two of your clients.
 *
 * A lookup that searched `mail_messages` without a tenant predicate would find
 * the OTHER tenant's row, return its ticket id, and the ingest path would then
 * append a stranger's mail to that ticket and mail the whole thread back out.
 * That is a cross-tenant leak with a delivery mechanism attached. Every query
 * below therefore goes through `scoped()` (HARD RULE 1) AND re-asserts
 * `row.tenant_id === tenantId` afterwards — belt and braces, because this is
 * the one place where getting it wrong is silent, plausible-looking, and
 * catastrophic.
 *
 * ── Why tiers 2 and 3 are signed ────────────────────────────────────────────
 *
 * A bare `[#ACME-1042]` in a subject line is a forgery primitive: anyone who
 * can send mail to the desk can append text to a subject, and an unsigned
 * token would let them post into any ticket number they can guess (and ticket
 * numbers are sequential, so guessing is counting). The same is true of a bare
 * `support+42@…` alias.
 *
 * Both therefore carry an HMAC over `(tenant slug, ticket id)` under a
 * PER-TENANT key, compared in constant time. An unsigned or badly-signed token
 * does not fail closed into "no match" — it degrades to a SUGGESTION, so a
 * legacy thread from before signing still reaches a human, and a forged one
 * reaches a human too, which is exactly where a forgery should end up.
 *
 * The per-tenant key is derived (HKDF-SHA256) from the installation secret and
 * the tenant SLUG (HARD RULE 13 — the cross-app tenant identity), so there is
 * no key table to provision, no key to leak through a config export, and one
 * tenant's key tells you nothing about another's. Rotating ENCRYPTION_KEY
 * rotates every tenant's threading key, which invalidates outstanding tokens —
 * the fallback is tier 1 and then a suggestion, never a wrong ticket.
 */
import crypto from 'crypto';
import type { StatusCategory } from '@oblidesk/shared';

import { db, scoped, assertTenantId, type Executor } from '../../db';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { parseTicketNumber } from '../ticketNumber.service';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Shapes
// ═════════════════════════════════════════════════════════════════════════════

export const THREAD_TIERS = ['references', 'alias', 'subject_token', 'fuzzy'] as const;
export type ThreadTier = (typeof THREAD_TIERS)[number];

/** A ticket the resolver thinks MIGHT be the right one. Never auto-applied. */
export interface ThreadCandidate {
  ticketId: number;
  number: string;
  subject: string;
  statusCategory: StatusCategory;
  /** 0…1. Only meaningful for ranking within one tier. */
  score: number;
  /** Human sentence for the "is this the same issue?" chip. */
  why: string;
}

export interface ThreadResolution {
  /** Which tier produced the answer. `'none'` when nothing matched at all. */
  tier: ThreadTier | 'none';
  /**
   * The ticket to append to. NON-NULL only when `auto` is true — a caller that
   * reads this field without checking `auto` cannot silently merge on tier 4,
   * because tier 4 never sets it.
   */
  ticketId: number | null;
  /** True only for tiers 1–3 with a verified signature (or a graph match). */
  auto: boolean;
  confidence: number;
  /** Everything the decision_log row should carry, already JSON-safe. */
  evidence: Record<string, unknown>;
  /** Candidates for a human. Present on every tier, including a tier-1 hit. */
  suggestions: ThreadCandidate[];
  /** The id our reply should set as In-Reply-To. */
  parentMessageId: string | null;
  /** The References chain to echo back, oldest first. */
  referenceChain: string[];
  /** Signature failures worth surfacing rather than swallowing. */
  warnings: string[];
}

export interface ThreadResolveInput {
  tenantId: number;
  /** HARD RULE 13 — the slug is the cross-app tenant identity, and the HMAC salt. */
  tenantSlug: string;
  /** The mailbox that RECEIVED this message. Its tenant bounds every lookup. */
  mailAccountId: number | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: readonly string[];
  /** Every address on To/Cc/Delivered-To/X-Original-To — the +alias hunting ground. */
  recipients: readonly string[];
  subject: string | null;
  fromAddress: string | null;
  receivedAt: Date;
  /** How far back the fuzzy tier looks. Default 14 days. */
  fuzzyWindowHours?: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Message-ID hygiene
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Strip the angle brackets, whitespace and stray quoting real clients add, and
 * lower-case the domain half.
 *
 * The local part of a Message-ID is case-SENSITIVE per RFC 5322 (it is an
 * opaque token), while the domain is not. Lower-casing the whole thing would
 * make `<AbC@x>` and `<abc@x>` the same id, which is wrong; not lower-casing
 * the domain would make `<a@Example.com>` and `<a@example.com>` different,
 * which is also wrong. The column is `citext`, so the database is forgiving —
 * this normalisation exists so the ARRAY comparisons (`references_ids`, a
 * plain `text[]`, which is NOT citext) behave the same way.
 */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (value === '') return null;

  // Some appliances send `In-Reply-To: "<id>"` or wrap in extra brackets.
  value = value.replace(/^["'\s]+|["'\s]+$/g, '');
  const bracketed = /<([^<>]+)>/.exec(value);
  if (bracketed) value = bracketed[1];
  value = value.replace(/[<>\s]/g, '');
  if (value === '') return null;
  if (value.length > 512) value = value.slice(0, 512);

  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return value;
  return `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`;
}

/**
 * Split a `References:` header into ids, oldest first.
 *
 * Real headers are folded across lines, separated by whitespace and sometimes
 * by commas (which is not legal, and happens anyway). Anything that does not
 * look like an id at all is dropped rather than carried forward as noise that
 * would widen the tier-1 query for nothing.
 */
export function parseMessageIdList(raw: string | readonly string[] | null | undefined): string[] {
  if (raw == null) return [];
  const source = Array.isArray(raw) ? raw.join(' ') : String(raw);

  const out: string[] = [];
  const seen = new Set<string>();
  const bracketed = source.match(/<[^<>]+>/g);
  const pieces = bracketed && bracketed.length > 0 ? bracketed : source.split(/[\s,]+/);

  for (const piece of pieces) {
    const id = normalizeMessageId(piece);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    // RFC 5322 does not bound References, but a thread that has been running
    // for two years can carry hundreds of ids. Past a point they add query
    // cost and no information: the ancestors we care about are the recent ones.
    if (out.length >= 64) break;
  }
  return out;
}

/**
 * Build the References chain for a reply: the inbound chain plus the message
 * being replied to, trimmed to the ends.
 *
 * RFC 5322 §3.6.4 explicitly allows an implementation to drop the middle of an
 * over-long chain, and every real client does. Keeping the FIRST id preserves
 * the thread root (which is what mail clients group on) and keeping the last
 * few preserves the immediate ancestry (which is what our tier 1 matches on).
 */
export function buildReferenceChain(
  existing: readonly string[],
  parentMessageId: string | null,
  maxIds = 20,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...existing, parentMessageId]) {
    const id = normalizeMessageId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    chain.push(id);
  }
  if (chain.length <= maxIds) return chain;
  return [chain[0], ...chain.slice(chain.length - (maxIds - 1))];
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — The per-tenant signing key
// ═════════════════════════════════════════════════════════════════════════════

/** Bytes of signature carried in an alias / subject token. 64 bits. */
const TOKEN_HEX_LENGTH = 16;

const keyCache = new Map<string, Buffer>();

function rootSecret(): string {
  // ENCRYPTION_KEY is required in production (`assertProductionConfig`), so the
  // fallback is a development convenience exactly like `utils/crypto` uses.
  return config.encryptionKey ?? config.sessionSecret;
}

/**
 * HKDF-SHA256 → one 32-byte key per tenant slug.
 *
 * The slug is the SALT rather than part of the info string so two tenants
 * whose slugs share a prefix cannot end up with related keys through a sloppy
 * concatenation, and the purpose string pins this key to mail threading — the
 * same root secret also protects SMTP passwords, and a key that could be used
 * for both would let a threading-token oracle say something about the other.
 */
export function threadKeyFor(tenantSlug: string): Buffer {
  const slug = (tenantSlug ?? '').trim().toLowerCase();
  if (slug === '') throw new Error('threading: a tenant slug is required to derive the signing key');

  const cached = keyCache.get(slug);
  if (cached) return cached;

  const derived = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(rootSecret(), 'utf8'),
      Buffer.from(slug, 'utf8'),
      Buffer.from('oblidesk:mail-thread:v1', 'utf8'),
      32,
    ),
  );
  keyCache.set(slug, derived);
  return derived;
}

/** Drop the cache — called by tests and after a key rotation. */
export function resetThreadKeyCache(): void {
  keyCache.clear();
}

/** The signature carried by an alias or a subject token. Lower-case hex. */
export function signThreadToken(tenantSlug: string, ticketId: number): string {
  return crypto
    .createHmac('sha256', threadKeyFor(tenantSlug))
    .update(`${tenantSlug.trim().toLowerCase()} ${ticketId}`, 'utf8')
    .digest('hex')
    .slice(0, TOKEN_HEX_LENGTH);
}

/**
 * Constant-time verification.
 *
 * `timingSafeEqual` throws on a length mismatch, and the throw itself leaks the
 * length — so a wrong-length candidate still burns one comparison before the
 * false. The attacker controls the retry rate here (they can send mail as fast
 * as they like), which is precisely when a timing side channel stops being
 * theoretical.
 */
export function verifyThreadToken(
  tenantSlug: string,
  ticketId: number,
  presented: string | null | undefined,
): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const expected = Buffer.from(signThreadToken(tenantSlug, ticketId), 'utf8');
  const actual = Buffer.from(presented.trim().toLowerCase(), 'utf8');
  if (expected.length !== actual.length) {
    crypto.timingSafeEqual(expected, expected);
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — The +alias (tier 2)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `support` + `desk.acme.tld` + ticket 1042
 *   → `support+t1042.4f2a9b7c1e0d3a56@desk.acme.tld`
 *
 * `+` sub-addressing is understood by every mainstream MTA and, crucially,
 * survives being put in a `Reply-To:` — which is what makes it stronger than a
 * subject token: the requester's client never sees it as editable text.
 *
 * Only `a-z0-9` and `.` appear after the `+`, so the result stays inside the
 * conservative subset of RFC 5322 `atext` that badly-written relays accept.
 */
export function buildReplyAlias(
  mailboxAddress: string,
  tenantSlug: string,
  ticketId: number,
): string | null {
  const at = mailboxAddress.lastIndexOf('@');
  if (at <= 0) return null;
  const local = mailboxAddress.slice(0, at);
  const domain = mailboxAddress.slice(at + 1);
  // A mailbox that already carries a sub-address gets its base used, otherwise
  // replies would accrete `+t1+t2+t3` on every round trip.
  const base = local.split('+')[0];
  if (base === '') return null;
  return `${base}+t${ticketId}.${signThreadToken(tenantSlug, ticketId)}@${domain}`;
}

export interface ParsedReplyAlias {
  ticketId: number;
  signature: string;
  /** The mailbox the alias belongs to, without the sub-address. */
  baseAddress: string;
}

export function parseReplyAlias(address: string | null | undefined): ParsedReplyAlias | null {
  if (typeof address !== 'string') return null;
  const cleaned = address.trim().replace(/^<|>$/g, '').toLowerCase();
  const at = cleaned.lastIndexOf('@');
  if (at <= 0) return null;

  const local = cleaned.slice(0, at);
  const domain = cleaned.slice(at + 1);
  const match = /^([^+]+)\+t(\d{1,12})\.([0-9a-f]{8,64})$/.exec(local);
  if (!match) return null;

  const ticketId = Number(match[2]);
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0) return null;
  return { ticketId, signature: match[3], baseAddress: `${match[1]}@${domain}` };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — The subject token (tier 3)
// ═════════════════════════════════════════════════════════════════════════════

/** `[#ACME-1042-4f2a9b7c1e0d3a56]` */
export function buildSubjectToken(
  tenantSlug: string,
  ticketNumber: string,
  ticketId: number,
): string {
  return `[#${ticketNumber}-${signThreadToken(tenantSlug, ticketId)}]`;
}

export interface ParsedSubjectToken {
  number: string;
  prefix: string;
  sequence: number;
  /** NULL for a legacy / forged token with no signature at all. */
  signature: string | null;
}

/**
 * Find the token in a subject.
 *
 * Deliberately tolerant of what mail clients do to a subject: `Re:`, `Fwd:`,
 * `[EXTERNAL]` banners prepended by a gateway, and the `Re: Re: Re:` stack.
 * The token can therefore be anywhere, not just at the start.
 */
export function parseSubjectToken(subject: string | null | undefined): ParsedSubjectToken | null {
  if (typeof subject !== 'string') return null;
  const match = /\[#\s*([A-Za-z0-9]{1,16}-\d{1,18})(?:[-.]([0-9a-fA-F]{8,64}))?\s*\]/.exec(subject);
  if (!match) return null;

  const parsed = parseTicketNumber(match[1]);
  if (!parsed) return null;
  return {
    number: `${parsed.prefix}-${parsed.sequence}`,
    prefix: parsed.prefix,
    sequence: parsed.sequence,
    signature: match[2] ? match[2].toLowerCase() : null,
  };
}

/** Remove our token so it is not duplicated when we prepend a fresh one. */
export function stripSubjectToken(subject: string | null | undefined): string {
  if (typeof subject !== 'string') return '';
  return subject.replace(/\[#\s*[A-Za-z0-9]{1,16}-\d{1,18}(?:[-.][0-9a-fA-F]{8,64})?\s*\]/g, '').trim();
}

/**
 * Strip reply/forward prefixes and our own token, for fuzzy comparison.
 *
 * The prefix list is multilingual on purpose. A French Outlook writes `RE:` and
 * `TR:`, a German one `AW:` and `WG:`, Spanish `RV:`; a desk that only knows
 * `Re:` and `Fwd:` compares "TR: Imprimante HS" against "Imprimante HS" and
 * scores them as different subjects, which breaks the fuzzy tier precisely for
 * the tenants who need it most.
 */
const REPLY_PREFIX_RE =
  /^\s*(?:(?:re|aw|antw|sv|vs|vá|odp|res|rif|r)|(?:fw|fwd|wg|tr|rv|enc|vs|doorst))\s*(?:\[\d+\])?\s*:\s*/i;

export function normalizeSubject(subject: string | null | undefined): string {
  let value = stripSubjectToken(subject ?? '');
  // Gateways bolt banners on: [EXTERNAL], [SPAM], [Ext].
  value = value.replace(/^\s*\[[^\]]{1,24}\]\s*/g, '');
  for (let i = 0; i < 8; i += 1) {
    const next = value.replace(REPLY_PREFIX_RE, '');
    if (next === value) break;
    value = next;
  }
  return value.replace(/\s+/g, ' ').trim();
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — The resolver
// ═════════════════════════════════════════════════════════════════════════════

interface MailRow {
  id: string | number;
  tenant_id: number;
  message_id: string;
  ticket_id: number | null;
  references_ids: string[] | null;
  in_reply_to: string | null;
  direction: string;
  received_at: Date | string;
}

interface TicketRow {
  id: number;
  tenant_id: number;
  number: string;
  subject: string;
  status_category: StatusCategory;
  deleted_at: Date | string | null;
  merged_into_id: number | null;
  requester_contact_id: number | null;
  created_at: Date | string;
}

const DEFAULT_FUZZY_WINDOW_HOURS = 14 * 24;
/** pg_trgm similarity below this is noise; above it, worth showing a human. */
const FUZZY_MIN_SIMILARITY = 0.42;
const FUZZY_MAX_CANDIDATES = 5;

/**
 * Load a ticket by id, refusing anything that is not this tenant's, is deleted,
 * or has been merged away.
 *
 * A merged ticket is followed to its target rather than rejected: a requester
 * replying to the mail we sent before the merge should land on the surviving
 * ticket, not open a third one. The hop is bounded because `merged_into_id`
 * is a plain column and a bad import could point two rows at each other.
 */
async function loadThreadTarget(
  tenantId: number,
  ticketId: number,
  executor: Executor,
): Promise<TicketRow | null> {
  let currentId = ticketId;
  for (let hops = 0; hops < 8; hops += 1) {
    const row = (await scoped('tickets', tenantId, executor)
      .where('tickets.id', currentId)
      .first(
        'tickets.id',
        'tickets.tenant_id',
        'tickets.number',
        'tickets.subject',
        'tickets.status_category',
        'tickets.deleted_at',
        'tickets.merged_into_id',
        'tickets.requester_contact_id',
        'tickets.created_at',
      )) as TicketRow | undefined;

    if (!row) return null;
    // Defence in depth: `scoped()` already added the predicate, and this proves
    // it did. If these ever disagree, something upstream is building queries by
    // hand and the right answer is "no match", not "somebody else's ticket".
    if (row.tenant_id !== tenantId) {
      logger.error(
        { tenantId, rowTenantId: row.tenant_id, ticketId: currentId },
        'threading: refusing a cross-tenant ticket row — scoping invariant violated',
      );
      return null;
    }
    if (row.deleted_at) return null;
    if (row.merged_into_id && row.merged_into_id !== currentId) {
      currentId = row.merged_into_id;
      continue;
    }
    return row;
  }
  return null;
}

function candidateFrom(row: TicketRow, score: number, why: string): ThreadCandidate {
  return {
    ticketId: row.id,
    number: row.number,
    subject: row.subject,
    statusCategory: row.status_category,
    score,
    why,
  };
}

/**
 * TIER 1 — the References / In-Reply-To graph.
 *
 * Matches on three things at once, because clients disagree about which they
 * populate: the ancestor ids appearing as a `message_id` we already hold, the
 * ancestor ids appearing inside somebody's `references_ids`, and our own
 * `in_reply_to`. All three are scoped to this tenant.
 */
async function matchByReferences(
  input: ThreadResolveInput,
  ancestors: readonly string[],
  executor: Executor,
): Promise<{ row: MailRow; ticket: TicketRow } | null> {
  if (ancestors.length === 0) return null;

  const ids = ancestors.slice(0, 64);
  const rows = (await scoped('mail_messages', input.tenantId, executor)
    .whereNotNull('mail_messages.ticket_id')
    .where((builder) => {
      builder
        .whereIn('mail_messages.message_id', ids)
        .orWhereRaw('mail_messages.references_ids && ?::text[]', [ids])
        .orWhereIn('mail_messages.in_reply_to', ids);
    })
    .orderBy('mail_messages.received_at', 'desc')
    .limit(16)
    .select(
      'mail_messages.id',
      'mail_messages.tenant_id',
      'mail_messages.message_id',
      'mail_messages.ticket_id',
      'mail_messages.references_ids',
      'mail_messages.in_reply_to',
      'mail_messages.direction',
      'mail_messages.received_at',
    )) as MailRow[];

  for (const row of rows) {
    // THE cross-tenant guard. See the module header: message_id is unique per
    // tenant, so a row from another tenant is a legitimate database state and
    // an illegitimate answer.
    if (row.tenant_id !== input.tenantId) {
      logger.error(
        { tenantId: input.tenantId, rowTenantId: row.tenant_id, messageId: row.message_id },
        'threading: mail_messages row escaped its tenant scope — refusing the match',
      );
      continue;
    }
    if (!row.ticket_id) continue;
    const ticket = await loadThreadTarget(input.tenantId, row.ticket_id, executor);
    if (ticket) return { row, ticket };
  }
  return null;
}

/** TIER 4 — same sender, similar subject, recent. Suggestions only. */
async function fuzzyCandidates(
  input: ThreadResolveInput,
  executor: Executor,
): Promise<ThreadCandidate[]> {
  const subject = normalizeSubject(input.subject);
  const from = (input.fromAddress ?? '').trim().toLowerCase();
  if (subject.length < 6 || from === '') return [];

  const contact = (await scoped('portal_contacts', input.tenantId, executor)
    .where('portal_contacts.email', from)
    .first('portal_contacts.id')) as { id: number } | undefined;
  if (!contact) return [];

  const windowHours = input.fuzzyWindowHours ?? DEFAULT_FUZZY_WINDOW_HOURS;
  const since = new Date(input.receivedAt.getTime() - windowHours * 3600_000);

  // `subject % ?` is the pg_trgm operator, which uses `tickets_subject_trgm`
  // (GIN, gin_trgm_ops). `similarity()` is then computed only for the rows the
  // index already narrowed to, so this stays cheap on a large tenant.
  const rows = (await scoped('tickets', input.tenantId, executor)
    .whereNull('tickets.deleted_at')
    .whereNull('tickets.merged_into_id')
    .where('tickets.requester_contact_id', contact.id)
    .where('tickets.created_at', '>=', since)
    .whereRaw('tickets.subject % ?', [subject])
    .orderByRaw('similarity(tickets.subject, ?) DESC', [subject])
    .limit(FUZZY_MAX_CANDIDATES)
    .select(
      'tickets.id',
      'tickets.tenant_id',
      'tickets.number',
      'tickets.subject',
      'tickets.status_category',
      'tickets.deleted_at',
      'tickets.merged_into_id',
      'tickets.requester_contact_id',
      'tickets.created_at',
      db.raw('similarity(tickets.subject, ?) AS sim', [subject]),
    )) as Array<TicketRow & { sim: number | string }>;

  return rows
    .filter((row) => row.tenant_id === input.tenantId)
    .map((row) => ({ row, sim: Number(row.sim) }))
    .filter(({ sim }) => sim >= FUZZY_MIN_SIMILARITY)
    .map(({ row, sim }) =>
      candidateFrom(
        row,
        sim,
        `Same requester, ${Math.round(sim * 100)}% subject match, opened ${new Date(
          row.created_at,
        ).toISOString().slice(0, 10)}`,
      ),
    );
}

/**
 * Resolve the thread for one inbound message.
 *
 * Returns as soon as a tier produces an auto-linkable answer — but always
 * computes the fuzzy suggestions when no tier did, so the composer has
 * something to offer instead of an empty "new ticket" it cannot second-guess.
 */
export async function resolveThread(
  input: ThreadResolveInput,
  executor: Executor = db,
): Promise<ThreadResolution> {
  assertTenantId(input.tenantId);

  const inReplyTo = normalizeMessageId(input.inReplyTo);
  const references = parseMessageIdList([...input.references]);
  const ancestors = parseMessageIdList([...(inReplyTo ? [inReplyTo] : []), ...references]);
  const warnings: string[] = [];

  const base = {
    parentMessageId: inReplyTo ?? (references.length > 0 ? references[references.length - 1] : null),
    referenceChain: references,
    warnings,
  };

  // ── Tier 1 — the message graph ─────────────────────────────────────────────
  const graph = await matchByReferences(input, ancestors, executor);
  if (graph) {
    return {
      ...base,
      tier: 'references',
      ticketId: graph.ticket.id,
      auto: true,
      confidence: 0.99,
      evidence: {
        matchedMessageId: graph.row.message_id,
        matchedDirection: graph.row.direction,
        ancestorsTried: ancestors.length,
        ticketNumber: graph.ticket.number,
      },
      suggestions: [candidateFrom(graph.ticket, 1, 'Matched the References header')],
    };
  }

  // ── Tier 2 — the signed +alias ────────────────────────────────────────────
  for (const recipient of input.recipients) {
    const alias = parseReplyAlias(recipient);
    if (!alias) continue;

    if (!verifyThreadToken(input.tenantSlug, alias.ticketId, alias.signature)) {
      warnings.push(`alias_signature_invalid:${alias.ticketId}`);
      logger.warn(
        { tenantId: input.tenantId, recipient, ticketId: alias.ticketId },
        'threading: +alias signature did not verify — treating as a suggestion, not a match',
      );
      const ticket = await loadThreadTarget(input.tenantId, alias.ticketId, executor);
      if (ticket) {
        return {
          ...base,
          tier: 'fuzzy',
          ticketId: null,
          auto: false,
          confidence: 0.3,
          evidence: { rejectedAlias: recipient, reason: 'signature_mismatch' },
          suggestions: [candidateFrom(ticket, 0.3, 'Alias pointed here but its signature did not verify')],
        };
      }
      continue;
    }

    const ticket = await loadThreadTarget(input.tenantId, alias.ticketId, executor);
    if (!ticket) {
      warnings.push(`alias_ticket_missing:${alias.ticketId}`);
      continue;
    }
    return {
      ...base,
      tier: 'alias',
      ticketId: ticket.id,
      auto: true,
      confidence: 0.97,
      evidence: { alias: recipient, ticketNumber: ticket.number },
      suggestions: [candidateFrom(ticket, 1, 'Signed reply alias on the recipient address')],
    };
  }

  // ── Tier 3 — the signed subject token ─────────────────────────────────────
  const token = parseSubjectToken(input.subject);
  if (token) {
    const ticket = (await scoped('tickets', input.tenantId, executor)
      .where('tickets.number', token.number)
      .first(
        'tickets.id',
        'tickets.tenant_id',
        'tickets.number',
        'tickets.subject',
        'tickets.status_category',
        'tickets.deleted_at',
        'tickets.merged_into_id',
        'tickets.requester_contact_id',
        'tickets.created_at',
      )) as TicketRow | undefined;

    if (ticket && ticket.tenant_id === input.tenantId && !ticket.deleted_at) {
      const target = await loadThreadTarget(input.tenantId, ticket.id, executor);
      const verified = token.signature !== null &&
        verifyThreadToken(input.tenantSlug, ticket.id, token.signature);

      if (target && verified) {
        return {
          ...base,
          tier: 'subject_token',
          ticketId: target.id,
          auto: true,
          confidence: 0.92,
          evidence: { subjectToken: token.number, ticketNumber: target.number },
          suggestions: [candidateFrom(target, 1, 'Signed ticket token in the subject')],
        };
      }

      // Unsigned or wrongly-signed. NOT a match — that is the forgery path.
      // It becomes the top suggestion so a legitimate legacy thread still
      // reaches the agent in one click.
      warnings.push(token.signature ? 'subject_token_signature_invalid' : 'subject_token_unsigned');
      if (target) {
        return {
          ...base,
          tier: 'fuzzy',
          ticketId: null,
          auto: false,
          confidence: 0.35,
          evidence: {
            subjectToken: token.number,
            reason: token.signature ? 'signature_mismatch' : 'unsigned',
          },
          suggestions: [
            candidateFrom(
              target,
              0.35,
              token.signature
                ? 'Subject token points here but its signature did not verify'
                : 'Subject token has no signature — confirm before threading',
            ),
            ...(await fuzzyCandidates(input, executor)),
          ].slice(0, FUZZY_MAX_CANDIDATES),
        };
      }
    }
  }

  // ── Tier 4 — fuzzy. SUGGEST, never merge ──────────────────────────────────
  const suggestions = await fuzzyCandidates(input, executor);
  return {
    ...base,
    tier: suggestions.length > 0 ? 'fuzzy' : 'none',
    ticketId: null,
    auto: false,
    confidence: suggestions.length > 0 ? suggestions[0].score : 0,
    evidence: {
      normalizedSubject: normalizeSubject(input.subject),
      from: input.fromAddress,
      ancestorsTried: ancestors.length,
    },
    suggestions,
  };
}

export const threading = {
  normalizeMessageId,
  parseMessageIdList,
  buildReferenceChain,
  threadKeyFor,
  resetThreadKeyCache,
  signThreadToken,
  verifyThreadToken,
  buildReplyAlias,
  parseReplyAlias,
  buildSubjectToken,
  parseSubjectToken,
  stripSubjectToken,
  normalizeSubject,
  resolveThread,
};

export default threading;
