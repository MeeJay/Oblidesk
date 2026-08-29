/**
 * inbound.service.ts — mail in.
 *
 * Two doors, one room. IMAP (with IDLE) polls the mailboxes an admin
 * configured; the webhook takes a push from a provider that has one. Both hand
 * a raw RFC-822 buffer to `ingestRaw()`, which is the only code path that
 * turns bytes into a ticket. One entry point, so "why did this mail not become
 * a ticket?" has one place to look.
 *
 * ── Idempotency, which is the whole ball game ───────────────────────────────
 *
 * IMAP redelivers. It redelivers when a connection drops mid-fetch, when a
 * server renumbers a folder, when someone restores a backup, when a `\Seen`
 * flag fails to stick, and when a webhook provider retries a 200 it never saw.
 * Without a hard guard, every one of those turns one customer e-mail into two
 * tickets, and the desk's ticket count becomes fiction.
 *
 * The guard is `UNIQUE(tenant_id, message_id)` on `mail_messages`, claimed as
 * the FIRST statement of the ingest transaction. A redelivery loses the race on
 * the index, gets zero rows back from `ON CONFLICT DO NOTHING`, and returns
 * `deduplicated` without creating anything.
 *
 * Messages with NO Message-ID exist. Cheap appliances, some fax gateways and a
 * couple of well-known monitoring products all emit them. For those the
 * fallback is the RAW HASH: the id becomes
 * `<sha256>@no-message-id.oblidesk.invalid`, which is deterministic, so the
 * same bytes arriving twice still collide on the same unique index. Without
 * that fallback every redelivery of a headerless message is a new ticket, and
 * those are exactly the senders that redeliver most.
 *
 * ── One transaction, staged bytes ───────────────────────────────────────────
 *
 * Inline images are the reason the ordering is fixed:
 *
 *     parse → stage + persist attachments → rewrite cid: → insert journal →
 *     link attachments → stamp the mail_messages row
 *
 * The journal HTML cannot be rendered until the attachment ids exist (a `cid:`
 * has to become `/api/attachments/<id>/download`), and the attachment LINKS
 * cannot be written until the journal id exists. So attachments are uploaded
 * unlinked, the HTML is rewritten, the journal row is inserted, and the links
 * are written last — all inside one transaction over a staged storage write.
 * A crash anywhere leaves staged bytes (swept) and no rows; what can never
 * happen is a journal entry whose `<img>` points at a row that was rolled back.
 *
 * ── One bad part never fails the message ────────────────────────────────────
 *
 * Every decode, every attachment, and the whole parse are individually
 * wrapped. A message whose MIME tree cannot be walked still becomes a ticket
 * carrying the raw body and a parse-error note, because a desk that drops mail
 * it cannot parse is a desk that silently loses the ticket from the one
 * customer whose mail server is broken — which is disproportionately the
 * customer who needs it.
 */
import { simpleParser, type Attachment as ParsedAttachment, type AddressObject, type ParsedMail } from 'mailparser';
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import type { Knex } from 'knex';

import { db, scoped, insertScoped, assertTenantId } from '../../db';
import { logger } from '../../utils/logger';
import { AppError } from '../../middleware/errorHandler';
import { sanitizeHtml, htmlToPlainText } from '../../utils/markdown';
import { withDecision } from '../decision.service';
import { getStorageDriver, hashBytes, type StagedBlob } from '../storage.service';
import * as attachmentService from '../attachment.service';
import { ticketService, emitTicketCreated } from '../ticket.service';
import { settingsService } from '../settings.service';
import { mailboxService } from './mailbox.service';
import { isOwnMessageId } from './outbound.service';
import { parseReply, rewriteCidReferences, safeDecodePart } from './replyParser';
import {
  normalizeMessageId,
  parseMessageIdList,
  resolveThread,
  type ThreadResolution,
} from './threading';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Shapes
// ═════════════════════════════════════════════════════════════════════════════

export type IngestSource = 'imap' | 'webhook' | 'manual';

export interface IngestInput {
  tenantId: number;
  mailAccountId: number | null;
  /** The complete RFC-822 message. */
  raw: Buffer;
  source: IngestSource;
  /** IMAP internal date, when the poller has one. Beats the Date: header. */
  receivedAt?: Date | null;
  /** Envelope recipient, when the transport knows it (the +alias lives here). */
  envelopeTo?: readonly string[];
}

export type IngestOutcome =
  | 'created'
  | 'appended'
  | 'reopened'
  | 'deduplicated'
  | 'ignored_loop'
  | 'ignored_bounce';

export interface IngestResult {
  outcome: IngestOutcome;
  mailMessageId: number | null;
  messageId: string;
  ticketId: number | null;
  ticketNumber: string | null;
  journalId: number | null;
  threadTier: ThreadResolution['tier'];
  suggestions: ThreadResolution['suggestions'];
  warnings: string[];
}

interface ParsedEnvelope {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  fromAddress: string | null;
  fromName: string | null;
  to: string[];
  cc: string[];
  recipients: string[];
  date: Date | null;
  text: string;
  html: string | null;
  formatFlowed: boolean;
  delSp: boolean;
  autoSubmitted: boolean;
  precedenceBulk: boolean;
  isBounce: boolean;
  originTenantSlug: string | null;
  attachments: ParsedAttachment[];
  warnings: string[];
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Header reading that cannot throw
// ═════════════════════════════════════════════════════════════════════════════

function headerString(parsed: ParsedMail, key: string): string | null {
  try {
    const value = parsed.headers.get(key);
    if (value == null) return null;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
    if (typeof value === 'object' && 'value' in value) return String((value as { value: unknown }).value);
    return String(value);
  } catch {
    return null;
  }
}

function addressList(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) return [];
  const objects = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const object of objects) {
    for (const entry of object.value ?? []) {
      if (entry.address) out.push(entry.address.trim().toLowerCase());
      for (const nested of entry.group ?? []) {
        if (nested.address) out.push(nested.address.trim().toLowerCase());
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Content-Type parameters for the top-level text/plain part.
 *
 * `format=flowed` matters: without it an Apple Mail paragraph is seventy-column
 * hard wrapping, and the reply parser's quote heuristics see line starts the
 * writer never made.
 */
function textPlainParams(parsed: ParsedMail): { formatFlowed: boolean; delSp: boolean } {
  const raw = (headerString(parsed, 'content-type') ?? '').toLowerCase();
  return {
    formatFlowed: /format\s*=\s*"?flowed"?/.test(raw),
    delSp: /delsp\s*=\s*"?yes"?/.test(raw),
  };
}

/**
 * A minimal header scrape for the case where the MIME parser gave up entirely.
 *
 * Reads only what a ticket needs to exist: an id, a sender, a subject. Anything
 * it cannot find is left empty, and the raw message is on the row regardless.
 */
function scrapeHeaders(raw: Buffer): Partial<ParsedEnvelope> {
  const head = raw.subarray(0, Math.min(raw.length, 64 * 1024)).toString('latin1');
  const boundary = head.search(/\r?\n\r?\n/);
  const headerBlock = (boundary >= 0 ? head.slice(0, boundary) : head).replace(/\r?\n[ \t]+/g, ' ');

  const read = (name: string): string | null => {
    const match = new RegExp(`^${name}\\s*:\\s*(.+)$`, 'im').exec(headerBlock);
    return match ? match[1].trim() : null;
  };

  const from = read('from');
  const address = from ? /<([^>]+)>/.exec(from)?.[1] ?? from : null;

  return {
    messageId: normalizeMessageId(read('message-id')) ?? '',
    inReplyTo: normalizeMessageId(read('in-reply-to')),
    references: parseMessageIdList(read('references')),
    subject: read('subject') ?? '(no subject)',
    fromAddress: address ? address.trim().toLowerCase() : null,
    to: read('to') ? parseAddressHeader(read('to') as string) : [],
    cc: read('cc') ? parseAddressHeader(read('cc') as string) : [],
  };
}

function parseAddressHeader(value: string): string[] {
  const out: string[] = [];
  for (const piece of value.split(',')) {
    const match = /<([^>]+)>/.exec(piece) ?? /([^\s<>,;]+@[^\s<>,;]+)/.exec(piece);
    if (match) out.push(match[1].trim().toLowerCase());
  }
  return [...new Set(out)];
}

/**
 * Parse one message, degrading rather than throwing.
 *
 * `keepCidLinks` is on so `cid:` survives to `rewriteCidReferences()`. The
 * default behaviour — inlining every related part as a base64 `data:` URI —
 * would put megabytes of image into `ticket_journal.body_html`, where it is
 * unindexable, uncacheable, un-deduplicated and impossible to virus-scan.
 */
async function parseMessage(raw: Buffer): Promise<ParsedEnvelope> {
  const warnings: string[] = [];
  const rawHash = hashBytes(raw);

  let parsed: ParsedMail | null = null;
  try {
    parsed = await simpleParser(raw, { keepCidLinks: true, skipTextLinks: true });
  } catch (err) {
    warnings.push(`MIME parse failed (${(err as Error).message}) — fell back to a header scrape`);
    logger.warn({ err: (err as Error).message }, 'mail: MIME parse failed, degrading to header scrape');
  }

  if (!parsed) {
    const scraped = scrapeHeaders(raw);
    const decoded = safeDecodePart(raw);
    if (decoded.error) warnings.push(decoded.error);
    return {
      messageId: scraped.messageId || `${rawHash}@no-message-id.oblidesk.invalid`,
      inReplyTo: scraped.inReplyTo ?? null,
      references: scraped.references ?? [],
      subject: scraped.subject ?? '(no subject)',
      fromAddress: scraped.fromAddress ?? null,
      fromName: null,
      to: scraped.to ?? [],
      cc: scraped.cc ?? [],
      recipients: [...(scraped.to ?? []), ...(scraped.cc ?? [])],
      date: null,
      text: decoded.value,
      html: null,
      formatFlowed: false,
      delSp: false,
      autoSubmitted: false,
      precedenceBulk: false,
      isBounce: false,
      originTenantSlug: null,
      attachments: [],
      warnings,
    };
  }

  const to = addressList(parsed.to);
  const cc = addressList(parsed.cc);
  // `Delivered-To` and `X-Original-To` carry the address the message was
  // actually delivered to, which is where a +alias survives when a mailing list
  // or a forwarding rule rewrote To:. Missing them loses tier 2 for exactly the
  // setups that need it most.
  const delivered = [
    ...parseAddressHeader(headerString(parsed, 'delivered-to') ?? ''),
    ...parseAddressHeader(headerString(parsed, 'x-original-to') ?? ''),
    ...parseAddressHeader(headerString(parsed, 'envelope-to') ?? ''),
  ];

  const autoSubmittedRaw = (headerString(parsed, 'auto-submitted') ?? '').toLowerCase();
  const precedence = (headerString(parsed, 'precedence') ?? '').toLowerCase();
  const returnPath = (headerString(parsed, 'return-path') ?? '').trim();
  const contentType = (headerString(parsed, 'content-type') ?? '').toLowerCase();

  const params = textPlainParams(parsed);

  return {
    messageId: normalizeMessageId(parsed.messageId) ?? `${rawHash}@no-message-id.oblidesk.invalid`,
    inReplyTo: normalizeMessageId(parsed.inReplyTo ?? null),
    references: parseMessageIdList(parsed.references ?? null),
    subject: (parsed.subject ?? '').trim() || '(no subject)',
    fromAddress: parsed.from?.value?.[0]?.address?.trim().toLowerCase() ?? null,
    fromName: parsed.from?.value?.[0]?.name?.trim() || null,
    to,
    cc,
    recipients: [...new Set([...to, ...cc, ...delivered])],
    date: parsed.date ?? null,
    text: typeof parsed.text === 'string' ? parsed.text : '',
    html: typeof parsed.html === 'string' ? parsed.html : null,
    formatFlowed: params.formatFlowed,
    delSp: params.delSp,
    autoSubmitted: autoSubmittedRaw !== '' && autoSubmittedRaw !== 'no',
    precedenceBulk: /^(bulk|list|junk)$/.test(precedence),
    // RFC 3464: a delivery-status notification has a null Return-Path and a
    // multipart/report body. Either alone is suggestive; both is conclusive.
    isBounce:
      returnPath === '<>' ||
      contentType.includes('multipart/report') ||
      /report-type\s*=\s*"?delivery-status"?/.test(contentType),
    originTenantSlug: headerString(parsed, 'x-oblidesk-origin'),
    attachments: parsed.attachments ?? [],
    warnings,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2b — Delivery-status notifications
// ═════════════════════════════════════════════════════════════════════════════

export interface BounceReport {
  /** True only for a 5.x.x status — the ONLY kind that may suppress an address. */
  permanent: boolean;
  status: string | null;
  /** The addresses the report says failed. Never our own mailbox. */
  recipients: string[];
}

/**
 * Read an RFC 3464 delivery-status report.
 *
 * Scanned out of the RAW bytes rather than the parsed tree because the
 * `message/delivery-status` part is a header block with no body, which several
 * MIME parsers (including this one, depending on the producer) hand back empty.
 * The three fields that matter are plain ASCII in a fixed shape, and a regex
 * over the raw message finds them whatever the tree looks like.
 *
 * The temporary/permanent distinction is the important part. `Status: 4.2.2`
 * means "mailbox full, try later"; suppressing on it would silently stop
 * mailing a customer because their disk filled up, and nobody would ever
 * connect the two. Only `5.x.x` is a permanent failure.
 */
export function parseBounce(raw: Buffer): BounceReport {
  const text = raw.subarray(0, Math.min(raw.length, 256 * 1024)).toString('latin1');

  const statusMatch = /^Status:\s*([245])\.(\d{1,3})\.(\d{1,3})/im.exec(text);
  const status = statusMatch ? `${statusMatch[1]}.${statusMatch[2]}.${statusMatch[3]}` : null;

  const recipients = new Set<string>();
  const recipientRe = /^(?:Final|Original)-Recipient:\s*(?:rfc822\s*;)?\s*<?([^\s<>;]+@[^\s<>;]+)>?/gim;
  let match: RegExpExecArray | null;
  while ((match = recipientRe.exec(text)) !== null) {
    recipients.add(match[1].trim().toLowerCase());
  }

  // Exim and a few gateways skip the structured report entirely and use this.
  const failed = /^X-Failed-Recipients:\s*(.+)$/im.exec(text);
  if (failed) {
    for (const piece of failed[1].split(',')) {
      const address = piece.trim().replace(/^<|>$/g, '').toLowerCase();
      if (address.includes('@')) recipients.add(address);
    }
  }

  return {
    permanent: status !== null && status.startsWith('5.'),
    status,
    recipients: [...recipients],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Requester identity
// ═════════════════════════════════════════════════════════════════════════════

interface RequesterIdentity {
  contactId: number | null;
  organizationId: number | null;
  created: boolean;
}

/**
 * Find (or create) the `portal_contacts` row this mail came from, and the
 * organisation it belongs to.
 *
 * Organisation is matched on the sender's DOMAIN against
 * `organizations.domains` — that column exists precisely so inbound mail from
 * somebody with no contact row is still attributed to the right customer,
 * which is what makes the first mail from a new employee at a known client land
 * in the right place instead of in an unassigned limbo.
 *
 * A contact created here is a bare shell: address, display name from the From
 * header, and nothing else. It is NOT a `users` row (see `portal.service.ts` —
 * that distinction is the identity boundary with Obligate).
 */
async function resolveRequester(
  tenantId: number,
  address: string | null,
  displayName: string | null,
  trx: Knex.Transaction,
): Promise<RequesterIdentity> {
  if (!address) return { contactId: null, organizationId: null, created: false };

  const existing = (await scoped('portal_contacts', tenantId, trx)
    .where('portal_contacts.email', address)
    .first('portal_contacts.id', 'portal_contacts.organization_id')) as
    | { id: number; organization_id: number | null }
    | undefined;

  if (existing) {
    return { contactId: existing.id, organizationId: existing.organization_id, created: false };
  }

  const domain = address.slice(address.lastIndexOf('@') + 1);
  const organization = (await scoped('organizations', tenantId, trx)
    .whereRaw('? = ANY(organizations.domains)', [domain])
    .first('organizations.id')) as { id: number } | undefined;

  // `ignore()` rather than `merge()`: two messages from a new address arriving
  // at once both reach this insert, and a `merge(['display_name'])` would let
  // the loser overwrite a name with the NULL it happens to be carrying. The
  // loser gets zero rows back and re-selects instead — a contact's name is
  // theirs, not the last writer's.
  const inserted = (await insertScoped(
    'portal_contacts',
    tenantId,
    {
      email: address,
      display_name: displayName,
      organization_id: organization?.id ?? null,
      is_active: true,
    },
    trx,
  )
    .onConflict(['tenant_id', 'email'])
    .ignore()
    .returning(['id', 'organization_id'])) as unknown as Array<{
    id: number;
    organization_id: number | null;
  }>;

  if (inserted.length > 0) {
    return {
      contactId: inserted[0].id,
      organizationId: inserted[0].organization_id,
      created: true,
    };
  }

  const raced = (await scoped('portal_contacts', tenantId, trx)
    .where('portal_contacts.email', address)
    .first('portal_contacts.id', 'portal_contacts.organization_id')) as
    | { id: number; organization_id: number | null }
    | undefined;

  return {
    contactId: raced?.id ?? null,
    organizationId: raced?.organization_id ?? null,
    created: false,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Attachments
// ═════════════════════════════════════════════════════════════════════════════

interface StoredAttachment {
  id: number;
  filename: string;
  cid: string | null;
  inline: boolean;
}

/**
 * Store every attachment, skipping — never failing on — the ones that will not
 * go in.
 *
 * A 90 MB video and a corrupt base64 part are both routine. Rejecting the
 * message because of either would lose the customer's actual question, which is
 * in the text part and is fine. Each skip becomes a note on the entry so the
 * agent knows to ask for the file rather than wondering what happened.
 */
async function storeAttachments(
  tenantId: number,
  attachments: readonly ParsedAttachment[],
  maxBytes: number,
  warnings: string[],
  trx: Knex.Transaction,
): Promise<StoredAttachment[]> {
  const stored: StoredAttachment[] = [];

  for (const [index, attachment] of attachments.entries()) {
    const filename =
      attachment.filename && attachment.filename.trim() !== ''
        ? attachment.filename
        : `part-${index + 1}${attachment.contentType?.includes('/') ? '' : '.bin'}`;

    try {
      const content: Buffer = Buffer.isBuffer(attachment.content)
        ? attachment.content
        : Buffer.from(String(attachment.content ?? ''), 'binary');

      if (content.length === 0) {
        warnings.push(`attachment "${filename}" was empty — skipped`);
        continue;
      }
      if (content.length > maxBytes) {
        warnings.push(
          `attachment "${filename}" is ${Math.round(content.length / 1024)} KB, over the ` +
            `${Math.round(maxBytes / 1024)} KB limit — not stored`,
        );
        continue;
      }

      const result = await attachmentService.uploadAttachment(
        {
          tenantId,
          uploadedBy: null,
          file: { originalname: filename, buffer: content, mimetype: attachment.contentType },
          // Linked below, once the journal row exists and we know its id.
          link: null,
          // Inbound mail legitimately carries installers and scripts; refusing
          // them outright loses evidence on exactly the tickets that need it.
          // The download path never serves them inline (`isNeverInline`) and
          // `scan_status` stays 'pending' until a scanner says otherwise.
          rejectExecutables: false,
        },
        trx,
      );

      const cid = attachment.cid ?? attachment.contentId?.replace(/^<|>$/g, '') ?? null;
      stored.push({
        id: result.attachment.id,
        filename,
        cid,
        inline: Boolean(attachment.related && cid),
      });
    } catch (err) {
      // INVARIANT: one bad part never fails the message.
      warnings.push(
        `attachment "${filename}" could not be stored (${(err as Error).message}) — see the raw message`,
      );
      logger.warn(
        { tenantId, filename, err: (err as Error).message },
        'mail: attachment rejected, continuing with the message',
      );
    }
  }

  return stored;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — The raw .eml
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Where the untouched message lives, for forensics and for "show me exactly
 * what they sent".
 *
 * Under the attachment root (so `storage.resolveKey` accepts it) but in its own
 * `raw/` namespace, so the orphan sweeper — which works from the `attachments`
 * table — can never reach a file that has no attachments row by design.
 */
function rawStorageKey(tenantId: number, rawHash: string, when: Date): string {
  const yyyy = String(when.getUTCFullYear()).padStart(4, '0');
  const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
  return ['attachments', String(tenantId), 'raw', yyyy, mm, `${rawHash}.eml`].join('/');
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Ingest
// ═════════════════════════════════════════════════════════════════════════════

const TERMINAL_CATEGORIES = new Set(['resolved', 'closed', 'cancelled']);

/**
 * Turn one raw message into a ticket, a reply, or a recorded no-op.
 *
 * Returns rather than throws for every ordinary refusal — a duplicate, a loop,
 * a bounce — because each of those is the system working, and a caller (the
 * webhook, the poller) that treats them as failures retries them for ever.
 */
export async function ingestRaw(input: IngestInput): Promise<IngestResult> {
  assertTenantId(input.tenantId);

  const tenant = await mailboxService.tenantIdentity(input.tenantId);
  const account = input.mailAccountId
    ? await mailboxService.getRow(input.tenantId, input.mailAccountId)
    : null;

  const rawHash = hashBytes(input.raw);
  const envelope = await parseMessage(input.raw);
  const warnings = [...envelope.warnings];
  const receivedAt = input.receivedAt ?? envelope.date ?? new Date();

  const empty = (outcome: IngestOutcome, mailMessageId: number | null): IngestResult => ({
    outcome,
    mailMessageId,
    messageId: envelope.messageId,
    ticketId: null,
    ticketNumber: null,
    journalId: null,
    threadTier: 'none',
    suggestions: [],
    warnings,
  });

  // ── Our own message coming back ──────────────────────────────────────────
  // A mailbox that BCCs itself, a Sent folder the poller can also see, a list
  // that reflects. Ingesting this appends our own reply to the ticket a second
  // time and, on a busy thread, starts a loop with ourselves.
  if (isOwnMessageId(envelope.messageId) || envelope.originTenantSlug === tenant.slug) {
    logger.debug(
      { tenantId: input.tenantId, messageId: envelope.messageId },
      'mail: ignoring our own message echoed back',
    );
    return empty('ignored_loop', null);
  }

  const maxBytes = await settingsService
    .get<number>(input.tenantId, 'mail.maxAttachmentBytes')
    .catch(() => attachmentService.MAX_ATTACHMENT_BYTES);
  const stripQuoted =
    mailboxService.mailboxFlags(account).stripQuotedReplies ??
    (await settingsService
      .get<boolean>(input.tenantId, 'mail.stripQuotedReplies')
      .catch(() => true));

  const driver = getStorageDriver();
  let staged: StagedBlob | null = null;
  let emittedTicketId: number | null = null;
  /**
   * `ticketService.create()` deliberately does NOT emit `ticket:created` when
   * it is handed a transaction — the caller owns the commit, and announcing a
   * ticket that then rolls back puts a row on every open queue board that
   * disappears on the next refresh. So the event is ours to send, afterwards.
   */
  let createdTicket: Awaited<ReturnType<typeof ticketService.create>> | null = null;

  try {
    staged = await driver.stage(input.raw);
    const rawKey = rawStorageKey(input.tenantId, rawHash, receivedAt);

    const result = await db.transaction(async (trx): Promise<IngestResult> => {
      // ── 1. CLAIM THE IDEMPOTENCY KEY, FIRST ───────────────────────────────
      // Before anything else, so a redelivery arriving concurrently blocks on
      // the unique index and then finds nothing to do. Doing this last would
      // leave a window in which both transactions create a ticket.
      const claimed = (await insertScoped(
        'mail_messages',
        input.tenantId,
        {
          mail_account_id: input.mailAccountId ?? null,
          message_id: envelope.messageId,
          // `references_ids` and `to_addresses` are Postgres `text[]`, NOT
          // jsonb. node-postgres serialises a JS array into `{a,b}` for them;
          // a `JSON.stringify` here would hand Postgres `["a","b"]` and fail
          // with "malformed array literal" — so the arrays go through as-is.
          references_ids: envelope.references,
          in_reply_to: envelope.inReplyTo,
          direction: 'in',
          ticket_id: null,
          journal_id: null,
          raw_key: rawKey,
          raw_hash: rawHash,
          parsed: JSON.stringify({}),
          from_address: envelope.fromAddress,
          to_addresses: envelope.recipients,
          subject: envelope.subject.slice(0, 4000),
          received_at: receivedAt,
        },
        trx,
      )
        .onConflict(['tenant_id', 'message_id'])
        .ignore()
        .returning('id')) as unknown as Array<{ id: string | number }>;

      if (claimed.length === 0) {
        logger.debug(
          { tenantId: input.tenantId, messageId: envelope.messageId },
          'mail: duplicate message — already ingested',
        );
        return empty('deduplicated', null);
      }

      const mailMessageId = Number(claimed[0].id);

      // ── 2. Bounces and auto-replies never become tickets ──────────────────
      if (envelope.isBounce) {
        const bounce = parseBounce(input.raw);

        // ONLY on a permanent (5.x.x) failure, and ONLY for the addresses the
        // report actually names.
        //
        // Both halves matter. Suppressing on a 4.x.x transient — a full
        // mailbox, a greylist, a server rebooting — would permanently stop
        // mailing a customer because their disk filled up on a Tuesday. And
        // suppressing `envelope.recipients` would suppress OUR OWN mailbox,
        // because a DSN is addressed to us: the failed address lives in the
        // report's `Final-Recipient`, nowhere else.
        if (bounce.permanent) {
          for (const address of bounce.recipients) {
            await mailboxService.suppress(input.tenantId, address, 'hard_bounce', trx);
          }
        }

        await stampMailMessage(input.tenantId, mailMessageId, trx, {
          parsed: {
            textBody: envelope.text.slice(0, 16 * 1024),
            autoSubmitted: true,
            ignored: 'bounce',
            bounce: {
              permanent: bounce.permanent,
              status: bounce.status,
              recipients: bounce.recipients,
            },
          },
        });
        logger.info(
          {
            tenantId: input.tenantId,
            permanent: bounce.permanent,
            status: bounce.status,
            recipients: bounce.recipients,
          },
          'mail: delivery-status notification recorded',
        );
        return { ...empty('ignored_bounce', mailMessageId) };
      }

      if (envelope.autoSubmitted || envelope.precedenceBulk) {
        // RFC 3834: an out-of-office reply must not open a ticket, and must not
        // be answered. It is recorded so an agent can see it happened.
        await stampMailMessage(input.tenantId, mailMessageId, trx, {
          parsed: {
            textBody: envelope.text.slice(0, 16 * 1024),
            autoSubmitted: true,
            ignored: envelope.precedenceBulk ? 'precedence_bulk' : 'auto_submitted',
          },
        });
        logger.info(
          { tenantId: input.tenantId, from: envelope.fromAddress },
          'mail: auto-submitted message recorded, not ticketed',
        );
        return empty('ignored_loop', mailMessageId);
      }

      // ── 3. Which ticket? ──────────────────────────────────────────────────
      const thread = await resolveThread(
        {
          tenantId: input.tenantId,
          tenantSlug: tenant.slug,
          mailAccountId: input.mailAccountId ?? null,
          messageId: envelope.messageId,
          inReplyTo: envelope.inReplyTo,
          references: envelope.references,
          recipients: [...envelope.recipients, ...(input.envelopeTo ?? [])],
          subject: envelope.subject,
          fromAddress: envelope.fromAddress,
          receivedAt,
        },
        trx,
      );

      // ── 4. Who wrote it? ──────────────────────────────────────────────────
      const requester = await resolveRequester(
        input.tenantId,
        envelope.fromAddress,
        envelope.fromName,
        trx,
      );

      // ── 5. Body: reply above the line ─────────────────────────────────────
      const parsedReply = parseReply({
        text: envelope.text,
        html: envelope.html,
        formatFlowed: envelope.formatFlowed,
        delSp: envelope.delSp,
        collapseQuotes: stripQuoted,
      });
      warnings.push(...parsedReply.warnings);

      // ── 6. Attachments BEFORE the journal — the cid: rewrite needs ids ────
      const stored = await storeAttachments(
        input.tenantId,
        envelope.attachments,
        Number(maxBytes) || attachmentService.MAX_ATTACHMENT_BYTES,
        warnings,
        trx,
      );

      const cidMap = new Map<string, number>();
      for (const item of stored) {
        if (item.cid) {
          cidMap.set(item.cid, item.id);
          cidMap.set(item.cid.toLowerCase(), item.id);
        }
      }

      let bodyHtml: string | null = null;
      if (parsedReply.replyHtml) {
        const rewritten = rewriteCidReferences(parsedReply.replyHtml, cidMap);
        if (rewritten.unresolved.length > 0) {
          warnings.push(
            `${rewritten.unresolved.length} inline image(s) referenced a Content-ID that was not in the message`,
          );
        }
        bodyHtml = sanitizeHtml(rewritten.html, { openLinksInNewTab: true });
      }

      const bodyMd = parsedReply.replyText.trim() !== ''
        ? parsedReply.replyText
        : bodyHtml
          ? htmlToPlainText(bodyHtml)
          : '(this message had no readable body — open the raw message)';

      const entryMeta = {
        mailMessageId,
        emailMessageId: envelope.messageId,
        mail: {
          from: envelope.fromAddress,
          fromName: envelope.fromName,
          to: envelope.to,
          cc: envelope.cc,
          subject: envelope.subject,
          receivedAt: receivedAt.toISOString(),
          /** ONE expandable chip: quoted history + signature + disclaimer. */
          chip: parsedReply.chipHtml,
          chipText: parsedReply.chipText.slice(0, 32 * 1024),
          collapsedKinds: parsedReply.collapsed.map((segment) => segment.kind),
          attachments: stored.map((item) => ({
            id: item.id,
            filename: item.filename,
            inline: item.inline,
          })),
          parseErrors: warnings,
          degraded: parsedReply.degraded,
          rawKey,
        },
      };

      const nonInlineIds = stored.filter((item) => !item.inline).map((item) => item.id);

      // ── 7. Append, or create ──────────────────────────────────────────────
      let ticketId: number;
      let ticketNumber: string;
      let journalId: number;
      let outcome: IngestOutcome;

      if (thread.auto && thread.ticketId !== null) {
        const ticket = await scoped('tickets', input.tenantId, trx)
          .where('tickets.id', thread.ticketId)
          .first('tickets.id', 'tickets.number', 'tickets.status_category');
        if (!ticket) throw new AppError(500, 'threading returned a ticket that no longer exists');

        ticketId = Number(ticket.id);
        ticketNumber = String(ticket.number);

        const actor = ticketService.systemActor({ actorType: 'portal', actorId: null });

        // A requester replying to a resolved ticket is the canonical reopen
        // trigger; `reopen()` owns the window rule and starts a FRESH SLA
        // instance rather than resuming the old one.
        let reopened = false;
        if (TERMINAL_CATEGORIES.has(String(ticket.status_category))) {
          const reopenResult = await ticketService.reopen(
            input.tenantId,
            actor,
            ticketId,
            { reason: 'requester_replied_by_mail', comment: bodyMd.slice(0, 500) },
            trx,
          );
          reopened = reopenResult.reopened;
          if (reopenResult.followUp) {
            // Past the reopen window: the reply belongs on the follow-up.
            ticketId = reopenResult.followUp.id;
            ticketNumber = reopenResult.followUp.number;
          }
        }

        const entry = await ticketService.addJournalEntry(
          input.tenantId,
          actor,
          ticketId,
          {
            kind: 'public_reply',
            visibility: 'public',
            bodyMd,
            attachmentIds: nonInlineIds,
          },
          trx,
        );
        journalId = Number(entry.id);
        outcome = reopened ? 'reopened' : 'appended';
      } else {
        const created = await ticketService.create(
          {
            tenantId: input.tenantId,
            recordType: 'incident',
            subject: envelope.subject.slice(0, 512),
            descriptionMd: bodyMd,
            source: 'email',
            queueSlug: account?.queue_slug ?? undefined,
            requesterContactId: requester.contactId,
            organizationId: requester.organizationId,
            // HARD RULE 6 — the message's own Date:, not the moment our poller
            // happened to notice it. A mailbox that was down for six hours must
            // not make every ticket look like it arrived at once.
            occurredAt: receivedAt.toISOString(),
            openingEntry: {
              kind: 'public_reply',
              visibility: 'public',
              bodyMd,
              meta: entryMeta,
            },
            data: {
              mail_message_id: mailMessageId,
              mail_from: envelope.fromAddress,
              mail_subject: envelope.subject,
            },
          },
          { actorType: 'portal', actorId: null, trx },
        );

        ticketId = created.id;
        ticketNumber = created.number;
        createdTicket = created;

        const opening = (await scoped('ticket_journal', input.tenantId, trx)
          .where('ticket_journal.ticket_id', ticketId)
          .orderBy('ticket_journal.seq', 'asc')
          .first('ticket_journal.id')) as { id: string | number } | undefined;
        if (!opening) throw new AppError(500, 'mail intake: the opening journal entry is missing');
        journalId = Number(opening.id);

        if (nonInlineIds.length > 0) {
          await attachmentService.linkMany(
            input.tenantId,
            nonInlineIds,
            { entityType: 'journal', entityId: journalId },
            trx,
          );
        }
        outcome = 'created';
      }

      // ── 8. The HTML body and the author, on the entry we just wrote ───────
      // `ticketService.create()` / `addJournalEntry()` both take markdown only;
      // mail is not markdown, and re-rendering the sanitised HTML from the text
      // would lose the formatting the requester actually sent. The row was
      // inserted moments ago inside this same transaction and nothing has read
      // it, so this is completing the insert rather than editing history — the
      // append-only rule is about entries that have been observed.
      await scoped('ticket_journal', input.tenantId, trx)
        .where('ticket_journal.id', journalId)
        .update({
          body_html: bodyHtml,
          author_contact_id: requester.contactId,
          author_type: 'portal',
          meta: db.raw("coalesce(ticket_journal.meta, '{}'::jsonb) || ?::jsonb", [
            JSON.stringify(entryMeta),
          ]),
        });

      // ── 9. Inline images: linked WITH their Content-ID ────────────────────
      for (const item of stored) {
        if (!item.inline || !item.cid) continue;
        await attachmentService.linkAttachment(
          input.tenantId,
          item.id,
          { entityType: 'journal', entityId: journalId, inlineCid: item.cid },
          trx,
        );
      }
      // Every part is also linked to the mail message, so "show me the original"
      // still resolves after somebody detaches a file from the timeline.
      for (const item of stored) {
        await attachmentService.linkAttachment(
          input.tenantId,
          item.id,
          { entityType: 'mail_message', entityId: mailMessageId },
          trx,
        );
      }

      // ── 10. Stamp the mail row with what it became ────────────────────────
      await stampMailMessage(input.tenantId, mailMessageId, trx, {
        ticketId,
        journalId,
        parsed: {
          cc: envelope.cc,
          textBody: envelope.text.slice(0, 64 * 1024),
          htmlBody: (envelope.html ?? '').slice(0, 256 * 1024) || undefined,
          attachmentCount: stored.length,
          autoSubmitted: false,
          threadTier: thread.tier,
          threadConfidence: thread.confidence,
        },
      });

      // ── 11. HARD RULE 2 — the routing decision, on this code path ─────────
      await withDecision(
        {
          tenantId: input.tenantId,
          ticketId,
          subsystem: 'routing',
          decision:
            outcome === 'created'
              ? `inbound mail opened ${ticketNumber} (no thread matched)`
              : `inbound mail threaded onto ${ticketNumber} via the ${thread.tier} tier`,
          trx,
          actorType: 'portal',
          actorId: null,
        },
        (recorder) => {
          recorder
            .input({
              messageId: envelope.messageId,
              from: envelope.fromAddress,
              subject: envelope.subject,
              mailAccountId: input.mailAccountId ?? null,
              source: input.source,
              tier: thread.tier,
              auto: thread.auto,
              evidence: thread.evidence,
              threadWarnings: thread.warnings,
              suggestions: thread.suggestions.map((s) => ({ ticketId: s.ticketId, score: s.score })),
              contactCreated: requester.created,
            })
            .outcome({
              outcome,
              ticketId,
              ticketNumber,
              journalId,
              mailMessageId,
              attachments: stored.length,
            });
          return Promise.resolve(null);
        },
      );

      emittedTicketId = ticketId;

      return {
        outcome,
        mailMessageId,
        messageId: envelope.messageId,
        ticketId,
        ticketNumber,
        journalId,
        threadTier: thread.tier,
        suggestions: thread.suggestions,
        warnings,
      };
    });

    // The bytes become visible under their final name only once the rows are
    // committed — a rolled-back ingest must not leave a raw_key pointing at a
    // file whose row does not exist, and an unreferenced staged file is swept.
    if (result.mailMessageId !== null && staged) {
      await driver.commit(staged, rawStorageKey(input.tenantId, rawHash, receivedAt));
      staged = null;
    }

    // Only now, with the rows committed, does the desk hear about it. Without
    // this a mail-created ticket does not appear on an open queue board until
    // somebody reloads, which on a busy morning reads as "the mailbox is down".
    if (createdTicket) emitTicketCreated(input.tenantId, createdTicket);

    if (emittedTicketId !== null) {
      logger.info(
        {
          tenantId: input.tenantId,
          ticketId: emittedTicketId,
          outcome: result.outcome,
          tier: result.threadTier,
        },
        'mail: message ingested',
      );
    }

    return result;
  } finally {
    if (staged) await driver.discard(staged);
  }
}

async function stampMailMessage(
  tenantId: number,
  mailMessageId: number,
  trx: Knex.Transaction,
  patch: { ticketId?: number; journalId?: number; parsed?: Record<string, unknown> },
): Promise<void> {
  const changes: Record<string, unknown> = {};
  if (patch.ticketId !== undefined) changes.ticket_id = patch.ticketId;
  if (patch.journalId !== undefined) changes.journal_id = patch.journalId;
  if (patch.parsed !== undefined) {
    changes.parsed = db.raw("coalesce(mail_messages.parsed, '{}'::jsonb) || ?::jsonb", [
      JSON.stringify(patch.parsed),
    ]);
  }
  if (Object.keys(changes).length === 0) return;
  await scoped('mail_messages', tenantId, trx)
    .where('mail_messages.id', mailMessageId)
    .update(changes);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — IMAP
// ═════════════════════════════════════════════════════════════════════════════

interface ConnectionOptions {
  /** Ceiling on the reconnect backoff. */
  maxBackoffMs: number;
  /** Fallback poll cadence when the server has no IDLE. */
  pollMs: number;
}

const DEFAULT_CONNECTION_OPTIONS: ConnectionOptions = {
  maxBackoffMs: 5 * 60_000,
  pollMs: 60_000,
};

/**
 * One long-lived connection to one mailbox.
 *
 * ── Backoff ─────────────────────────────────────────────────────────────────
 * A mailbox whose password was changed will refuse every connection. Retrying
 * that every five seconds is a login-failure storm that some providers answer
 * by locking the account — turning a wrong password into an outage. So the
 * delay doubles, up to five minutes, with jitter so twelve mailboxes on the
 * same dead server do not retry in lockstep.
 *
 * ── UIDVALIDITY ─────────────────────────────────────────────────────────────
 * IMAP UIDs are only meaningful within one UIDVALIDITY generation. When a
 * server renumbers a folder (a restore, a migration, some Exchange
 * maintenance), UIDVALIDITY changes and every stored UID becomes a lie: "fetch
 * everything after UID 8300" now means something else entirely, and the mailbox
 * either re-downloads the world or silently skips it. Detecting the change and
 * resyncing from zero is the only correct answer — and it is CHEAP, because the
 * idempotency guard means a full resync creates nothing.
 */
class MailboxConnection {
  private client: ImapFlow | null = null;
  private stopped = false;
  private failures = 0;
  private syncing = false;
  private pending = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tenantId: number,
    private readonly accountId: number,
    private readonly options: ConnectionOptions = DEFAULT_CONNECTION_OPTIONS,
  ) {}

  get key(): string {
    return `${this.tenantId}:${this.accountId}`;
  }

  async start(): Promise<void> {
    this.stopped = false;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }

  private backoffMs(): number {
    const raw = Math.min(5_000 * 2 ** Math.max(0, this.failures - 1), this.options.maxBackoffMs);
    return Math.round(raw * (0.8 + Math.random() * 0.4));
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectAndWatch();
        this.failures = 0;
      } catch (err) {
        this.failures += 1;
        const message = err instanceof Error ? err.message : String(err);
        await mailboxService
          .recordHealth(this.tenantId, this.accountId, {
            ok: false,
            lastError: message,
            consecutiveFailures: this.failures,
          })
          .catch(() => undefined);
        logger.warn(
          { tenantId: this.tenantId, mailAccountId: this.accountId, failures: this.failures, err: message },
          'mail: IMAP connection failed — backing off',
        );
      }

      if (this.stopped) return;
      await new Promise((resolve) => setTimeout(resolve, this.backoffMs()));
    }
  }

  private async connectAndWatch(): Promise<void> {
    const row = await mailboxService.getRow(this.tenantId, this.accountId);
    if (!row || !row.is_active) {
      this.stopped = true;
      return;
    }

    const settings = mailboxService.resolveImapSettings(row);
    if (!settings.host || !settings.user) {
      throw new Error('mailbox is missing a host or username');
    }
    if (!settings.pass && !settings.accessToken) {
      throw new Error('mailbox has no usable credential — re-enter the password');
    }

    const client = new ImapFlow({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: settings.accessToken
        ? { user: settings.user, accessToken: settings.accessToken }
        : { user: settings.user, pass: settings.pass ?? '' },
      // The library's own logging would print the LOGIN command. Ours does not.
      logger: false,
      clientInfo: { name: 'Oblidesk', vendor: 'ObliTools' },
    });

    this.client = client;

    client.on('error', (error: Error) => {
      logger.warn(
        { tenantId: this.tenantId, mailAccountId: this.accountId, err: error.message },
        'mail: IMAP client error',
      );
    });

    // IDLE: the server tells us the moment something lands. `exists` fires on
    // new mail; the sync is scheduled rather than run inline so a burst of
    // twenty messages produces one sync, not twenty overlapping ones.
    client.on('exists', () => {
      void this.scheduleSync(settings.folder, settings);
    });

    await client.connect();
    await mailboxService.recordHealth(
      this.tenantId,
      this.accountId,
      { ok: true, lastError: null, consecutiveFailures: 0 },
      { touchLastSeen: true },
    );

    // A first pass on connect: IDLE only reports what arrives from now on, so
    // without this everything delivered while we were disconnected sits unseen
    // until the next new message happens to arrive.
    await this.scheduleSync(settings.folder, settings);

    // Servers without IDLE (and there are still some) get a poll. imapflow
    // falls back internally too, but an explicit timer means a mailbox whose
    // IDLE silently stalls still drains.
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      void this.scheduleSync(settings.folder, settings);
    }, this.options.pollMs);
    this.pollTimer.unref?.();

    // Park here until the connection dies; the loop above then reconnects.
    await new Promise<void>((resolve) => {
      client.on('close', () => resolve());
    });

    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.client = null;
    if (!this.stopped) throw new Error('IMAP connection closed');
  }

  /** Collapse overlapping sync requests into one, with one re-run queued. */
  private async scheduleSync(
    folder: string,
    settings: ReturnType<typeof mailboxService.resolveImapSettings>,
  ): Promise<void> {
    if (this.syncing) {
      this.pending = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.pending = false;
        await this.sync(folder, settings);
      } while (this.pending && !this.stopped);
    } catch (err) {
      logger.warn(
        { tenantId: this.tenantId, mailAccountId: this.accountId, err: (err as Error).message },
        'mail: sync pass failed',
      );
      await mailboxService
        .recordHealth(this.tenantId, this.accountId, {
          ok: false,
          lastError: (err as Error).message,
        })
        .catch(() => undefined);
    } finally {
      this.syncing = false;
    }
  }

  private async sync(
    folder: string,
    settings: ReturnType<typeof mailboxService.resolveImapSettings>,
  ): Promise<void> {
    const client = this.client;
    if (!client) return;

    const lock = await client.getMailboxLock(folder);
    let fetched = 0;
    try {
      const mailbox = client.mailbox;
      if (!mailbox) return;

      const uidValidity = String(mailbox.uidValidity);
      const state = await mailboxService.readSyncState(this.tenantId, this.accountId, folder);

      // ── UIDVALIDITY reset ──────────────────────────────────────────────────
      let lastUid = state.lastUid;
      if (state.uidValidity !== null && state.uidValidity !== uidValidity) {
        logger.warn(
          {
            tenantId: this.tenantId,
            mailAccountId: this.accountId,
            folder,
            was: state.uidValidity,
            now: uidValidity,
          },
          'mail: UIDVALIDITY changed — resyncing the folder from the start',
        );
        lastUid = 0;
      }

      const range = `${lastUid + 1}:*`;
      let highestUid = lastUid;

      for await (const message of client.fetch(range, { uid: true, source: true, internalDate: true }, { uid: true })) {
        if (this.stopped) break;
        const typed = message as FetchMessageObject;
        // `n:*` always returns at least one message even when nothing is new —
        // the server clamps the range to the highest existing UID. Skipping
        // what we have already seen is what keeps that from re-ingesting the
        // newest message on every single IDLE notification.
        if (typed.uid <= lastUid) continue;
        if (!typed.source) continue;

        try {
          await ingestRaw({
            tenantId: this.tenantId,
            mailAccountId: this.accountId,
            raw: typed.source,
            source: 'imap',
            receivedAt: typed.internalDate ? new Date(typed.internalDate) : null,
          });
          fetched += 1;
        } catch (err) {
          // A message that cannot be ingested must not stall the cursor behind
          // it for ever: the error is recorded, the UID advances, and the raw
          // message is still on the server for a human to look at.
          logger.error(
            {
              tenantId: this.tenantId,
              mailAccountId: this.accountId,
              uid: typed.uid,
              err: (err as Error).message,
            },
            'mail: message could not be ingested — advancing past it',
          );
        }

        highestUid = Math.max(highestUid, typed.uid);

        // The cursor advances per message, not per batch. A crash halfway
        // through a hundred-message backlog then resumes where it stopped
        // instead of replaying the lot (which dedupe would absorb, but slowly).
        await mailboxService.writeSyncState(this.tenantId, this.accountId, folder, {
          uidValidity,
          lastUid: highestUid,
          lastSyncAt: new Date().toISOString(),
        });

        if (settings.deleteAfterFetch) {
          await client.messageFlagsAdd(String(typed.uid), ['\\Deleted'], { uid: true }).catch(() => false);
        } else {
          await client.messageFlagsAdd(String(typed.uid), ['\\Seen'], { uid: true }).catch(() => false);
        }
      }

      await mailboxService.writeSyncState(this.tenantId, this.accountId, folder, {
        uidValidity,
        lastUid: highestUid,
        lastSyncAt: new Date().toISOString(),
      });
    } finally {
      lock.release();
    }

    if (fetched > 0) {
      await mailboxService
        .recordHealth(
          this.tenantId,
          this.accountId,
          { ok: true, lastError: null, consecutiveFailures: 0 },
          { touchLastSeen: true },
        )
        .catch(() => undefined);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — The worker
// ═════════════════════════════════════════════════════════════════════════════

const connections = new Map<string, MailboxConnection>();
let reconcileTimer: NodeJS.Timeout | null = null;

/**
 * Reconcile the live connections against the configured mailboxes.
 *
 * Runs on a timer rather than on a signal because a mailbox can be added,
 * disabled or deleted from three places (the admin screen, a config import, a
 * tenant being removed) and a poller that only learns about one of them stops
 * collecting for the other two.
 */
async function reconcile(): Promise<void> {
  const rows = await mailboxService.listActiveForPolling();
  const wanted = new Set<string>();

  for (const row of rows) {
    const key = `${row.tenant_id}:${row.id}`;
    wanted.add(key);
    if (connections.has(key)) continue;

    const connection = new MailboxConnection(row.tenant_id, row.id);
    connections.set(key, connection);
    await connection.start();
    logger.info(
      { tenantId: row.tenant_id, mailAccountId: row.id, name: row.name },
      'mail: mailbox connection started',
    );
  }

  for (const [key, connection] of connections) {
    if (wanted.has(key)) continue;
    connections.delete(key);
    await connection.stop();
    logger.info({ mailbox: key }, 'mail: mailbox connection stopped');
  }
}

export const mailInboundWorker = {
  async start(options: { intervalMs?: number } = {}): Promise<void> {
    if (reconcileTimer) return;
    const intervalMs = options.intervalMs ?? 60_000;

    await reconcile().catch((err: unknown) => {
      logger.error({ err }, 'mail: initial mailbox reconcile failed');
    });

    reconcileTimer = setInterval(() => {
      void reconcile().catch((err: unknown) => {
        logger.error({ err }, 'mail: mailbox reconcile failed');
      });
    }, intervalMs);
    reconcileTimer.unref?.();
    logger.info({ intervalMs, mailboxes: connections.size }, 'Inbound mail poller started');
  },

  async stop(): Promise<void> {
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
    const live = [...connections.values()];
    connections.clear();
    await Promise.all(live.map((connection) => connection.stop()));
  },

  /** Force one pass — the "collect now" button in the channel console. */
  reconcile,
  connectionCount: (): number => connections.size,
};

/**
 * Verify one mailbox's credentials without starting a poller.
 *
 * `verifyOnly` logs out immediately after AUTH, so the test cannot leave a
 * dangling connection on a server that counts them.
 */
export async function testConnection(
  tenantId: number,
  accountId: number,
): Promise<{ ok: boolean; error: string | null; folders?: string[] }> {
  const row = await mailboxService.getRow(tenantId, accountId);
  if (!row) throw new AppError(404, 'Mailbox not found');

  const settings = mailboxService.resolveImapSettings(row);
  if (!settings.host || !settings.user) {
    return { ok: false, error: 'This mailbox has no host or username configured' };
  }

  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: settings.accessToken
      ? { user: settings.user, accessToken: settings.accessToken }
      : { user: settings.user, pass: settings.pass ?? '' },
    logger: false,
  });

  try {
    await client.connect();
    const folders = await client.list();
    await client.logout();
    await mailboxService.recordHealth(
      tenantId,
      accountId,
      { ok: true, lastError: null, consecutiveFailures: 0 },
      { touchLastSeen: true },
    );
    return { ok: true, error: null, folders: folders.map((folder) => folder.path) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      client.close();
    } catch {
      /* the connection is already gone */
    }
    await mailboxService.recordHealth(tenantId, accountId, { ok: false, lastError: message });
    return { ok: false, error: message };
  }
}

export const inboundService = {
  ingestRaw,
  testConnection,
  worker: mailInboundWorker,
};

export default inboundService;
