/**
 * outbound.service.ts — every message the desk sends.
 *
 * ── The ordering invariant ──────────────────────────────────────────────────
 *
 * A `mail_messages` row carrying the Message-ID and In-Reply-To is written
 * BEFORE the message is handed to SMTP. Not after, not in a callback, not
 * "best effort".
 *
 * The reason is threading, and it is not subtle. Tier 1 of `threading.ts`
 * matches an inbound reply's `References:` against ids we already hold. Those
 * ids are the ones WE minted. If the row is written after the send, then every
 * message lost in the window — a crash, a redeploy, an SMTP timeout that
 * actually delivered — is a message whose id we never recorded, and the
 * requester's reply to it matches nothing. The desk opens a second ticket, the
 * agent sees a stranger asking about a printer, and the customer sees their
 * conversation forked. Writing first means the worst case is a recorded message
 * that never went out, which is visible, retryable, and does not fork anything.
 *
 * So: transaction → allocate id → insert row → COMMIT → hand to SMTP. The
 * delivery state then lives on that same row under `parsed.delivery`, and the
 * retry drain below picks up anything the inline attempt could not deliver.
 *
 * ── RFC 3834 and friends ────────────────────────────────────────────────────
 *
 *   Auto-Submitted: auto-generated   on anything a machine composed. This is
 *     what stops a vacation responder answering our acknowledgement, and our
 *     acknowledgement answering the vacation responder, for ever.
 *   Precedence: bulk                 on digests. Older responders honour this
 *     when they have never heard of Auto-Submitted, and plenty have not.
 *   List-Id                          stable per tenant. It gives every filter
 *     in every requester's client one thing to key on, and gives our own
 *     intake a second, header-based way to spot our own traffic.
 *   X-Oblidesk-Origin                the tenant slug (HARD RULE 13), echoed on
 *     everything we send, so self-echo detection does not depend on the
 *     Message-ID surviving a mailing list rewrite.
 *
 * ── The loop breaker is TWO counters, not one ───────────────────────────────
 *
 * Per (mailbox, sender): stops the classic ping-pong with one broken
 * autoresponder.
 *
 * Per (mailbox, thread): stops the case a per-sender counter cannot see — a
 * distribution list where each bounce arrives from a DIFFERENT address, or an
 * integration that CCs a fresh alias every time. Each sender looks quiet; the
 * thread is on fire. A desk with only the per-sender counter mails a thousand
 * people once each and calls it fine.
 *
 * Both count real rows in `mail_messages` inside a window rather than keeping
 * a side table of counters. The data is the truth; a shadow counter is one more
 * thing that can disagree with it after a crash.
 */
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import type { Knex } from 'knex';

import { db, scoped, insertScoped, assertTenantId, type Executor } from '../../db';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { AppError } from '../../middleware/errorHandler';
import { withDecision } from '../decision.service';
import { smtpServerService } from '../smtpServer.service';
import {
  mailboxAddress,
  mailboxService,
  type MailAccountRow,
  type TenantIdentity,
} from './mailbox.service';
import { buildReferenceChain, buildReplyAlias, buildSubjectToken, normalizeMessageId, stripSubjectToken } from './threading';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Identity of the messages we mint
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Local-part prefix on every Message-ID we generate.
 *
 * It exists so `isOwnMessageId()` can answer without a query. That matters on
 * the intake path: a mail that quotes our own id in its References is normal,
 * but a mail whose OWN Message-ID is one of ours is our message coming back —
 * a mailbox that BCCs itself, a Sent folder the poller can also see, a list
 * that reflects. Ingesting it would append our own reply to the ticket a second
 * time and, worse, start a loop.
 */
const MESSAGE_ID_PREFIX = 'oblidesk';

function messageIdDomain(fromAddress: string | null): string {
  const at = (fromAddress ?? '').lastIndexOf('@');
  if (at > 0) return (fromAddress as string).slice(at + 1).toLowerCase();
  try {
    return new URL(config.appUrl).hostname.toLowerCase();
  } catch {
    return 'oblidesk.invalid';
  }
}

/** `<oblidesk.acme.1042.9f3c…@desk.acme.tld>` — angle brackets stripped. */
export function mintMessageId(
  tenantSlug: string,
  ticketId: number | null,
  fromAddress: string | null,
): string {
  const slug = tenantSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'tenant';
  const unique = crypto.randomBytes(12).toString('hex');
  return `${MESSAGE_ID_PREFIX}.${slug}.${ticketId ?? 0}.${unique}@${messageIdDomain(fromAddress)}`;
}

export function isOwnMessageId(messageId: string | null | undefined): boolean {
  const id = normalizeMessageId(messageId);
  return id !== null && id.startsWith(`${MESSAGE_ID_PREFIX}.`);
}

/** Stable per tenant, so a requester's filter rule keeps working for years. */
export function listIdFor(tenant: TenantIdentity, fromAddress: string | null): string {
  return `Oblidesk ${tenant.name} <tickets.${tenant.slug.toLowerCase()}.${messageIdDomain(
    fromAddress,
  )}>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Shapes
// ═════════════════════════════════════════════════════════════════════════════

export interface OutboundAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  /** Set to embed the part as an inline image referenced by `cid:`. */
  cid?: string;
}

export interface SendMailInput {
  tenantId: number;
  /** The mailbox we send AS. Null falls back to the tenant's default SMTP identity. */
  mailAccountId?: number | null;
  ticketId?: number | null;
  journalId?: number | null;
  to: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject: string;
  text: string;
  html?: string | null;
  /** RFC 3834. TRUE for anything not typed by a human in the composer. */
  automated?: boolean;
  /** `Precedence: bulk` — digests, newsletters, weekly summaries. */
  bulk?: boolean;
  replyTo?: string | null;
  inReplyTo?: string | null;
  references?: readonly string[];
  headers?: Readonly<Record<string, string>>;
  attachments?: readonly OutboundAttachment[];
  smtpServerId?: number | null;
  /** Skip the loop breaker. Only ever true for a human pressing Send. */
  humanInitiated?: boolean;
  /** Correlation id shared with the decision rows of the action that caused this. */
  correlationId?: string;
}

export interface SendMailResult {
  /** `mail_messages.id`. Always present — the row is written before the send. */
  mailMessageId: number;
  messageId: string;
  /** False when the loop breaker or a suppression stopped the send. */
  sent: boolean;
  suppressed: boolean;
  reason: string | null;
  recipients: string[];
}

interface DeliveryState {
  status: 'pending' | 'sent' | 'failed' | 'suppressed';
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  sentAt: string | null;
  reason?: string;
}

interface StoredEnvelope {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string | null;
  replyTo: string | null;
  headers: Record<string, string>;
  smtpServerId: number | null;
  /** Attachment bytes are NOT stored — a retry re-links them from the journal. */
  attachmentIds: number[];
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — The loop breaker
// ═════════════════════════════════════════════════════════════════════════════

export interface LoopBreakerConfig {
  windowMinutes: number;
  maxPerSender: number;
  maxPerThread: number;
}

export const DEFAULT_LOOP_BREAKER: LoopBreakerConfig = {
  windowMinutes: 60,
  // Twelve messages to one person in an hour is already pathological for a
  // desk; twenty on one thread covers a genuinely busy incident bridge.
  maxPerSender: 12,
  maxPerThread: 20,
};

export interface LoopVerdict {
  tripped: boolean;
  scope: 'sender' | 'thread' | null;
  address: string | null;
  count: number;
  limit: number;
}

/**
 * Have we already sent too much, to this person or on this thread?
 *
 * Counts committed `mail_messages` rows, so it sees what actually happened
 * rather than what an in-memory counter believes happened across a restart.
 */
export async function checkLoopBreaker(
  tenantId: number,
  mailAccountId: number | null,
  ticketId: number | null,
  recipients: readonly string[],
  options: Partial<LoopBreakerConfig> = {},
  executor: Executor = db,
): Promise<LoopVerdict> {
  assertTenantId(tenantId);
  const cfg = { ...DEFAULT_LOOP_BREAKER, ...options };
  const since = new Date(Date.now() - cfg.windowMinutes * 60_000);

  const accountPredicate = (qb: Knex.QueryBuilder) =>
    mailAccountId === null
      ? qb.whereNull('mail_messages.mail_account_id')
      : qb.where('mail_messages.mail_account_id', mailAccountId);

  // ── Per (mailbox, sender) ────────────────────────────────────────────────
  for (const raw of recipients) {
    const address = raw.trim().toLowerCase();
    if (address === '') continue;

    const row = (await accountPredicate(
      scoped('mail_messages', tenantId, executor)
        .where('mail_messages.direction', 'out')
        .where('mail_messages.received_at', '>=', since)
        // A message the breaker already suppressed was never delivered, so it
        // is not evidence that we are shouting at anyone — counting it would
        // make the breaker latch for the whole window once it had tripped once.
        .whereRaw("coalesce(mail_messages.parsed -> 'delivery' ->> 'status', 'sent') <> 'suppressed'")
        .whereRaw('? = ANY(mail_messages.to_addresses)', [address]),
    ).count({ total: '*' })) as unknown as Array<{ total: string | number }>;

    const count = Number(row?.[0]?.total ?? 0);
    if (count >= cfg.maxPerSender) {
      return { tripped: true, scope: 'sender', address, count, limit: cfg.maxPerSender };
    }
  }

  // ── Per (mailbox, thread) ────────────────────────────────────────────────
  // The counter the per-sender one cannot see: a distribution list that bounces
  // from a different address each time keeps every per-sender count at one.
  if (ticketId !== null) {
    const row = (await accountPredicate(
      scoped('mail_messages', tenantId, executor)
        .where('mail_messages.direction', 'out')
        .where('mail_messages.ticket_id', ticketId)
        .where('mail_messages.received_at', '>=', since)
        .whereRaw("coalesce(mail_messages.parsed -> 'delivery' ->> 'status', 'sent') <> 'suppressed'"),
    ).count({ total: '*' })) as unknown as Array<{ total: string | number }>;

    const count = Number(row?.[0]?.total ?? 0);
    if (count >= cfg.maxPerThread) {
      return { tripped: true, scope: 'thread', address: null, count, limit: cfg.maxPerThread };
    }
  }

  return { tripped: false, scope: null, address: null, count: 0, limit: 0 };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Composing
// ═════════════════════════════════════════════════════════════════════════════

export interface ComposedMessage {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  headers: Record<string, string>;
  replyTo: string | null;
  subject: string;
  to: string[];
  cc: string[];
  bcc: string[];
}

function cleanAddresses(list: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const address = String(raw ?? '').trim().toLowerCase();
    if (address === '' || !address.includes('@') || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

/**
 * The last thing we know about this thread, so a reply threads correctly even
 * when the caller did not supply In-Reply-To.
 *
 * Prefers the most recent INBOUND message: replying to our own last message
 * produces a chain the requester's client renders as us talking to ourselves.
 */
async function threadAnchors(
  tenantId: number,
  ticketId: number | null,
  executor: Executor,
): Promise<{ inReplyTo: string | null; references: string[] }> {
  if (ticketId === null) return { inReplyTo: null, references: [] };

  const rows = (await scoped('mail_messages', tenantId, executor)
    .where('mail_messages.ticket_id', ticketId)
    .orderBy('mail_messages.received_at', 'desc')
    .limit(24)
    .select(
      'mail_messages.message_id',
      'mail_messages.direction',
      'mail_messages.references_ids',
    )) as Array<{ message_id: string; direction: string; references_ids: string[] | null }>;

  if (rows.length === 0) return { inReplyTo: null, references: [] };

  const anchor = rows.find((row) => row.direction === 'in') ?? rows[0];
  const existing = [
    ...(anchor.references_ids ?? []),
    // Oldest first: the rows came back newest-first, so reverse them.
    ...rows.map((row) => row.message_id).reverse(),
  ];

  return {
    inReplyTo: normalizeMessageId(anchor.message_id),
    references: buildReferenceChain(existing, normalizeMessageId(anchor.message_id)),
  };
}

/**
 * Build the headers.
 *
 * `Auto-Submitted` and `Precedence` are set from the caller's intent rather
 * than guessed, because the cost of guessing wrong runs both ways: marking an
 * agent's hand-typed reply `auto-generated` tells the requester's client to
 * ignore it, and failing to mark an automated acknowledgement starts the loop
 * RFC 3834 exists to prevent.
 */
export async function compose(
  input: SendMailInput,
  tenant: TenantIdentity,
  account: MailAccountRow | null,
  fromAddress: string,
  executor: Executor = db,
): Promise<ComposedMessage> {
  const anchors = input.inReplyTo || (input.references && input.references.length > 0)
    ? {
        inReplyTo: normalizeMessageId(input.inReplyTo ?? null),
        references: buildReferenceChain(input.references ?? [], normalizeMessageId(input.inReplyTo ?? null)),
      }
    : await threadAnchors(input.tenantId, input.ticketId ?? null, executor);

  const messageId = mintMessageId(tenant.slug, input.ticketId ?? null, fromAddress);

  const headers: Record<string, string> = {
    'List-Id': listIdFor(tenant, fromAddress),
    'X-Oblidesk-Origin': tenant.slug,
    ...(input.ticketId ? { 'X-Oblidesk-Ticket': String(input.ticketId) } : {}),
    ...(input.headers ?? {}),
  };

  if (input.automated) {
    // RFC 3834 §5. `auto-generated` (not `auto-replied`) because these are
    // notifications the desk produced, not replies to a specific message.
    headers['Auto-Submitted'] = 'auto-generated';
    headers['X-Auto-Response-Suppress'] = 'All';
  }
  if (input.bulk) headers.Precedence = 'bulk';

  // A signed reply alias beats a bare Reply-To: it survives being forwarded,
  // and its signature is what tier 2 of the resolver verifies.
  let replyTo = input.replyTo ?? null;
  if (!replyTo && account && input.ticketId) {
    const address = mailboxAddress(account);
    if (address) replyTo = buildReplyAlias(address, tenant.slug, input.ticketId);
  }

  return {
    messageId,
    inReplyTo: anchors.inReplyTo,
    references: anchors.references,
    headers,
    replyTo,
    subject: input.subject,
    to: cleanAddresses(input.to),
    cc: cleanAddresses(input.cc),
    bcc: cleanAddresses(input.bcc),
  };
}

/** `Re: [#ACME-1042-9f3c…] Printer offline` — token first, prefix outside it. */
export function threadedSubject(
  tenantSlug: string,
  ticketNumber: string,
  ticketId: number,
  subject: string,
  isReply: boolean,
): string {
  const bare = stripSubjectToken(subject).replace(/^\s*re\s*:\s*/i, '').trim();
  const token = buildSubjectToken(tenantSlug, ticketNumber, ticketId);
  return `${isReply ? 'Re: ' : ''}${token} ${bare}`.trim();
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Persist, then send
// ═════════════════════════════════════════════════════════════════════════════

function initialDelivery(): DeliveryState {
  return {
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
    lastError: null,
    sentAt: null,
  };
}

async function resolveFrom(
  tenantId: number,
  account: MailAccountRow | null,
  smtpServerId: number | null,
): Promise<{ address: string; name: string | null; serverId: number | null }> {
  const accountAddress = account ? mailboxAddress(account) : null;

  const server = smtpServerId
    ? await smtpServerService.getById(tenantId, smtpServerId)
    : await smtpServerService.getDefault(tenantId);

  return {
    address: accountAddress ?? server?.fromAddress ?? 'no-reply@localhost',
    name: server?.fromName ?? null,
    serverId: server?.id ?? null,
  };
}

/**
 * Send one message.
 *
 * The row is written and COMMITTED before SMTP is touched, then the delivery
 * attempt happens outside that transaction. Holding a transaction open across
 * a network call to a third party is how a slow mail server becomes a database
 * connection-pool outage.
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  assertTenantId(input.tenantId);

  const tenant = await mailboxService.tenantIdentity(input.tenantId);
  const account = input.mailAccountId
    ? await mailboxService.getRow(input.tenantId, input.mailAccountId)
    : null;

  const recipients = cleanAddresses(input.to);
  if (recipients.length === 0) throw new AppError(400, 'An outbound message needs a recipient');

  const from = await resolveFrom(input.tenantId, account, input.smtpServerId ?? null);
  const composed = await compose(input, tenant, account, from.address, db);

  // ── Suppression list ─────────────────────────────────────────────────────
  const deliverable: string[] = [];
  const suppressedAddresses: string[] = [];
  for (const address of composed.to) {
    if (await mailboxService.isSuppressed(input.tenantId, address)) suppressedAddresses.push(address);
    else deliverable.push(address);
  }

  // ── Loop breaker ─────────────────────────────────────────────────────────
  let verdict: LoopVerdict = { tripped: false, scope: null, address: null, count: 0, limit: 0 };
  if (!input.humanInitiated && deliverable.length > 0) {
    verdict = await checkLoopBreaker(
      input.tenantId,
      input.mailAccountId ?? null,
      input.ticketId ?? null,
      deliverable,
    );
  }

  const blocked = verdict.tripped || deliverable.length === 0;
  const reason = verdict.tripped
    ? `loop_breaker_${verdict.scope}`
    : deliverable.length === 0
      ? 'all_recipients_suppressed'
      : null;

  const envelope: StoredEnvelope = {
    to: deliverable,
    cc: composed.cc,
    bcc: composed.bcc,
    subject: composed.subject,
    text: input.text,
    html: input.html ?? null,
    replyTo: composed.replyTo,
    headers: composed.headers,
    smtpServerId: from.serverId,
    attachmentIds: [],
  };

  const delivery: DeliveryState = blocked
    ? {
        status: 'suppressed',
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        sentAt: null,
        reason: reason ?? 'blocked',
      }
    : initialDelivery();

  // ── THE ORDERING INVARIANT: the row, then the send ───────────────────────
  const mailMessageId = await db.transaction(async (trx) => {
    const inserted = (await insertScoped(
      'mail_messages',
      input.tenantId,
      {
        mail_account_id: input.mailAccountId ?? null,
        message_id: composed.messageId,
        // `text[]` columns, not jsonb: node-postgres turns a JS array into
        // `{a,b}`, while a JSON string would arrive as `["a","b"]` and fail
        // with "malformed array literal".
        references_ids: composed.references,
        in_reply_to: composed.inReplyTo,
        direction: 'out',
        ticket_id: input.ticketId ?? null,
        journal_id: input.journalId ?? null,
        raw_hash: null,
        parsed: JSON.stringify({
          textBody: input.text.slice(0, 64 * 1024),
          htmlBody: (input.html ?? '').slice(0, 256 * 1024) || undefined,
          cc: composed.cc,
          bcc: composed.bcc,
          autoSubmitted: Boolean(input.automated),
          delivery,
          envelope,
          suppressedRecipients: suppressedAddresses,
        }),
        from_address: from.address,
        to_addresses: [...deliverable, ...suppressedAddresses],
        subject: composed.subject,
        received_at: new Date(),
      },
      trx,
    ).returning('id')) as unknown as Array<{ id: string | number }>;

    const id = Number(inserted[0].id);

    // HARD RULE 2 — the refusal is a decision, and it is written on the same
    // code path, in the same transaction, as the row that records the refusal.
    // A send that silently did not happen is the single hardest thing to debug
    // on a desk, because nothing anywhere says so.
    if (blocked) {
      await withDecision(
        {
          tenantId: input.tenantId,
          ticketId: input.ticketId ?? null,
          subsystem: 'workflow',
          decision: verdict.tripped
            ? `outbound mail suppressed — ${verdict.scope} loop breaker tripped ` +
              `(${verdict.count} in the last ${DEFAULT_LOOP_BREAKER.windowMinutes} min, limit ${verdict.limit})`
            : 'outbound mail suppressed — every recipient is on the suppression list',
          trx,
          correlationId: input.correlationId,
          actorType: input.humanInitiated ? 'user' : 'automation',
        },
        (recorder) => {
          recorder
            .input({
              recipients: composed.to,
              suppressed: suppressedAddresses,
              mailAccountId: input.mailAccountId ?? null,
              scope: verdict.scope,
              count: verdict.count,
              limit: verdict.limit,
            })
            .outcome({ mailMessageId: id, messageId: composed.messageId, sent: false });
          return Promise.resolve(null);
        },
      );

      // A per-sender loop is the address's problem, so the address goes on the
      // suppression list; a per-thread loop is the thread's problem, and
      // suppressing every participant would punish the wrong people.
      if (verdict.tripped && verdict.scope === 'sender' && verdict.address) {
        await mailboxService.suppress(input.tenantId, verdict.address, 'loop_detected', trx);
      }
    }

    return id;
  });

  if (blocked) {
    logger.warn(
      { tenantId: input.tenantId, ticketId: input.ticketId, reason, mailMessageId },
      'mail: outbound message suppressed',
    );
    return {
      mailMessageId,
      messageId: composed.messageId,
      sent: false,
      suppressed: true,
      reason,
      recipients: deliverable,
    };
  }

  const outcome = await attemptDelivery(input.tenantId, mailMessageId, {
    from,
    composed,
    envelope,
    attachments: input.attachments ?? [],
  });

  return {
    mailMessageId,
    messageId: composed.messageId,
    sent: outcome.sent,
    suppressed: false,
    reason: outcome.error,
    recipients: deliverable,
  };
}

interface DeliveryContext {
  from: { address: string; name: string | null; serverId: number | null };
  composed: ComposedMessage;
  envelope: StoredEnvelope;
  attachments: readonly OutboundAttachment[];
}

/**
 * Hand one already-recorded message to SMTP and write the outcome back.
 *
 * Never throws: a failed send updates `parsed.delivery` and returns, so the
 * caller (an agent pressing Send, a rule firing) gets a truthful answer and the
 * drain below retries. Throwing here would roll back the ticket action that
 * caused the mail, which is exactly the coupling `notification_outbox` exists
 * to avoid everywhere else.
 */
async function attemptDelivery(
  tenantId: number,
  mailMessageId: number,
  ctx: DeliveryContext,
): Promise<{ sent: boolean; error: string | null }> {
  const server = ctx.from.serverId
    ? await smtpServerService.getTransportConfig(ctx.from.serverId)
    : null;

  if (!server) {
    const error =
      'no SMTP server available for this tenant — set a default in Admin → SMTP servers';
    await writeDelivery(tenantId, mailMessageId, error);
    return { sent: false, error };
  }

  try {
    const transport = nodemailer.createTransport({
      host: server.host,
      port: server.port,
      secure: server.secure,
      auth: server.username ? { user: server.username, pass: server.password ?? '' } : undefined,
    });

    await transport.sendMail({
      from: ctx.from.name
        ? `"${ctx.from.name.replace(/"/g, '')}" <${ctx.from.address}>`
        : ctx.from.address,
      to: ctx.envelope.to,
      cc: ctx.envelope.cc.length > 0 ? ctx.envelope.cc : undefined,
      bcc: ctx.envelope.bcc.length > 0 ? ctx.envelope.bcc : undefined,
      replyTo: ctx.envelope.replyTo ?? undefined,
      subject: ctx.envelope.subject,
      text: ctx.envelope.text,
      html: ctx.envelope.html ?? undefined,
      // Angle brackets are re-added here: the column stores them stripped so
      // the citext comparisons in `threading.ts` line up, but the wire format
      // requires them.
      messageId: `<${ctx.composed.messageId}>`,
      inReplyTo: ctx.composed.inReplyTo ? `<${ctx.composed.inReplyTo}>` : undefined,
      references: ctx.composed.references.map((id) => `<${id}>`),
      headers: ctx.envelope.headers,
      attachments: ctx.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
        cid: attachment.cid,
      })),
    });

    await writeDelivery(tenantId, mailMessageId, null);
    return { sent: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeDelivery(tenantId, mailMessageId, message);
    logger.warn(
      { tenantId, mailMessageId, err: message },
      'mail: outbound delivery failed — queued for retry',
    );
    return { sent: false, error: message };
  }
}

const MAX_SEND_ATTEMPTS = 8;
const BASE_BACKOFF_SECONDS = 60;

/** `base * 2^(attempts-1)`, capped at an hour, with ±20% jitter. */
function backoffSeconds(attempts: number): number {
  const raw = BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(raw, 3600);
  return Math.round(capped * (0.8 + Math.random() * 0.4));
}

async function writeDelivery(
  tenantId: number,
  mailMessageId: number,
  error: string | null,
): Promise<void> {
  const row = (await scoped('mail_messages', tenantId)
    .where('mail_messages.id', mailMessageId)
    .first('mail_messages.parsed')) as { parsed: Record<string, unknown> | string } | undefined;
  if (!row) return;

  const parsed =
    typeof row.parsed === 'string' ? (JSON.parse(row.parsed) as Record<string, unknown>) : row.parsed;
  const previous = (parsed.delivery ?? {}) as Partial<DeliveryState>;
  const attempts = Number(previous.attempts ?? 0) + 1;

  const next: DeliveryState = error
    ? {
        status: attempts >= MAX_SEND_ATTEMPTS ? 'failed' : 'pending',
        attempts,
        nextAttemptAt:
          attempts >= MAX_SEND_ATTEMPTS
            ? null
            : new Date(Date.now() + backoffSeconds(attempts) * 1000).toISOString(),
        lastError: error,
        sentAt: null,
      }
    : {
        status: 'sent',
        attempts,
        nextAttemptAt: null,
        lastError: null,
        sentAt: new Date().toISOString(),
      };

  await scoped('mail_messages', tenantId)
    .where('mail_messages.id', mailMessageId)
    .update({
      parsed: db.raw("jsonb_set(mail_messages.parsed, '{delivery}', ?::jsonb, true)", [
        JSON.stringify(next),
      ]),
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — The retry drain
// ═════════════════════════════════════════════════════════════════════════════

export interface OutboundTickResult {
  claimed: number;
  sent: number;
  failed: number;
  deadLettered: number;
}

/**
 * Retry everything whose inline attempt did not land.
 *
 * Bounded by `received_at` so the scan uses `mail_messages_received`
 * (tenant_id, received_at DESC) instead of a sequential scan over a table that
 * grows for ever: a message nobody could deliver in three days is not going to
 * start working, and it is already visible in the channel console.
 */
export async function drain(limit = 25): Promise<OutboundTickResult> {
  const result: OutboundTickResult = { claimed: 0, sent: 0, failed: 0, deadLettered: 0 };
  const horizon = new Date(Date.now() - 3 * 24 * 3600_000);

  // The drainer has no tenant context — it serves every tenant — and every row
  // it touches is re-scoped by `tenant_id` before it is written. Same
  // exception, and the same reasoning, as `outbox.service`'s worker.
  const rows = (await db('mail_messages')
    .where('direction', 'out')
    .where('received_at', '>=', horizon)
    .whereRaw("parsed -> 'delivery' ->> 'status' = 'pending'")
    .whereRaw("coalesce(parsed -> 'delivery' ->> 'nextAttemptAt', '') <= ?", [
      new Date().toISOString(),
    ])
    .orderBy('received_at')
    .limit(limit)
    .select('id', 'tenant_id', 'mail_account_id', 'message_id', 'in_reply_to', 'references_ids', 'parsed', 'from_address', 'ticket_id')) as Array<{
    id: string | number;
    tenant_id: number;
    mail_account_id: number | null;
    message_id: string;
    in_reply_to: string | null;
    references_ids: string[] | null;
    parsed: Record<string, unknown> | string;
    from_address: string | null;
    ticket_id: number | null;
  }>;

  result.claimed = rows.length;

  for (const row of rows) {
    const tenantId = Number(row.tenant_id);
    const id = Number(row.id);

    // ── Claim it, atomically ──────────────────────────────────────────────
    // One compare-and-set that pushes `nextAttemptAt` forward. Whoever wins
    // sends; whoever loses sees zero rows and moves on. Without this, two
    // replicas draining at the same moment both send the same reply, and the
    // customer gets it twice — which is exactly the failure `SKIP LOCKED` is
    // preventing over in `outbox.service`. The pushed timestamp doubles as a
    // LEASE: a worker that dies mid-send leaves the row due again after the
    // lease rather than stuck in a hot retry loop.
    const lease = new Date(Date.now() + 5 * 60_000).toISOString();
    const claimed = await db('mail_messages')
      .where({ id, tenant_id: tenantId })
      .whereRaw("parsed -> 'delivery' ->> 'status' = 'pending'")
      .whereRaw("coalesce(parsed -> 'delivery' ->> 'nextAttemptAt', '') <= ?", [
        new Date().toISOString(),
      ])
      .update({
        parsed: db.raw("jsonb_set(parsed, '{delivery,nextAttemptAt}', to_jsonb(?::text), true)", [
          lease,
        ]),
      });
    if (claimed !== 1) continue;

    const parsed =
      typeof row.parsed === 'string' ? (JSON.parse(row.parsed) as Record<string, unknown>) : row.parsed;
    const envelope = parsed.envelope as StoredEnvelope | undefined;
    if (!envelope) {
      // Nothing to resend from. Mark it failed rather than looping on a row
      // that can never succeed.
      await writeDelivery(tenantId, id, 'no stored envelope — cannot retry');
      result.deadLettered += 1;
      continue;
    }

    const account = row.mail_account_id
      ? await mailboxService.getRow(tenantId, row.mail_account_id)
      : null;
    const from = await resolveFrom(tenantId, account, envelope.smtpServerId);

    const outcome = await attemptDelivery(tenantId, id, {
      from,
      composed: {
        messageId: row.message_id,
        inReplyTo: row.in_reply_to,
        references: row.references_ids ?? [],
        headers: envelope.headers,
        replyTo: envelope.replyTo,
        subject: envelope.subject,
        to: envelope.to,
        cc: envelope.cc,
        bcc: envelope.bcc,
      },
      envelope,
      // Attachment BYTES are not stored on the row (they would double every
      // blob in the database). A retry therefore sends the text, which is the
      // part that carries the answer; the attachment is still on the ticket.
      attachments: [],
    });

    if (outcome.sent) result.sent += 1;
    else {
      const attempts = Number((parsed.delivery as DeliveryState | undefined)?.attempts ?? 0) + 1;
      if (attempts >= MAX_SEND_ATTEMPTS) result.deadLettered += 1;
      else result.failed += 1;
    }
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * `start()` / `stop()`, so `index.ts` can hold this behind the same leader lock
 * as the SLA ticker and the outbox drainer. Two replicas draining at once is
 * not corrupting — each row's delivery state is rewritten from what it reads —
 * but it is two connections to the same SMTP server for no reason.
 */
export const mailOutboundWorker = {
  async start(options: { intervalMs?: number } = {}): Promise<void> {
    if (timer) return;
    const intervalMs = options.intervalMs ?? 60_000;
    timer = setInterval(() => {
      if (running) return;
      running = true;
      void drain()
        .catch((err: unknown) => {
          logger.error({ err }, 'mail: outbound drain failed');
        })
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    // `unref` so a drain timer never keeps the process alive during shutdown.
    timer.unref?.();
    logger.info({ intervalMs }, 'Outbound mail drain started');
  },

  async stop(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = null;
  },

  drain,
};

export const outboundService = {
  mintMessageId,
  isOwnMessageId,
  listIdFor,
  compose,
  threadedSubject,
  checkLoopBreaker,
  sendMail,
  drain,
  worker: mailOutboundWorker,
};

export default outboundService;
