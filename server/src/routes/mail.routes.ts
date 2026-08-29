/**
 * mail.routes.ts — the mail channel: intake, mailbox administration, health.
 *
 * MOUNT POINT: `/api/mail`, in the GLOBAL tier of `routes/index.ts` —
 * alongside `/api/alerts` and for the same reason. `POST /api/mail/webhook` is
 * called SERVER-TO-SERVER by a mail provider that has no session and no tenant
 * context; putting this router behind `requireTenant` would break it. Every
 * other route here therefore applies `requireAuth` + `requireTenant` +
 * `requireCapability` PER ROUTE rather than with a `router.use()` at the top.
 *
 *   POST   /api/mail/webhook              raw message in (bearer)
 *   GET    /api/mail/accounts             mailboxes, secrets redacted
 *   POST   /api/mail/accounts             add one
 *   PATCH  /api/mail/accounts/:id         edit one (a secret omitted is KEPT)
 *   DELETE /api/mail/accounts/:id         remove one
 *   POST   /api/mail/accounts/:id/test    verify credentials, no poller
 *   POST   /api/mail/accounts/:id/collect force a sync pass now
 *   GET    /api/mail/health               the channel console
 *   GET    /api/mail/suppressions         who we have stopped mailing, and why
 *   DELETE /api/mail/suppressions/:address  let an address back in
 *
 * ── Why the webhook answers 2xx on a duplicate ──────────────────────────────
 *
 * Deduplication is the NORMAL path for a mail webhook: providers retry, and a
 * retry of a message we already have is the system working. Answering 4xx would
 * make the provider retry harder, then quarantine the endpoint, and the desk
 * would stop receiving mail because it was doing the right thing. Same contract
 * as the alert ingest.
 */
import { Router, type Request, type Response } from 'express';
import express from 'express';
import crypto from 'crypto';
import { CAPABILITIES, LIMITS } from '@oblidesk/shared';

import { db } from '../db';
import { logger } from '../utils/logger';
import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireAnyCapability, requireCapability } from '../middleware/rbac';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { mailboxService } from '../services/mail/mailbox.service';
import { inboundService } from '../services/mail/inbound.service';
import { outboundService } from '../services/mail/outbound.service';

const router = Router();

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — The webhook
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Constant-time bearer check against the installation-wide mail ingest key.
 *
 * Modelled on `alerts.routes.ts` deliberately: one shape for every
 * machine-to-machine door means one thing to review and one thing to rotate.
 * The caller controls the retry rate, so a timing-distinguishable compare here
 * is an attack rather than a curiosity.
 */
async function authenticateIngestKey(header: string | undefined): Promise<boolean> {
  if (!header || !header.startsWith('Bearer ')) return false;
  const presented = header.slice(7).trim();
  if (presented === '') return false;

  const row = await db('app_config').where({ key: 'mailWebhookKey' }).first('value');
  const raw = row?.value;
  const expected = typeof raw === 'string' ? raw : (raw as { key?: string } | undefined)?.key;
  if (!expected) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Burn a comparison so the cost of a failure does not depend on length.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function bearerValue(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  const value = header.slice(7).trim();
  return value === '' ? null : value;
}

/** `message/rfc822` bodies bypass JSON entirely — a 20 MB mail is not a JSON string. */
const rawMessageParser = express.raw({
  type: ['message/rfc822', 'application/octet-stream'],
  limit: `${Math.ceil(LIMITS.attachmentMaxBytes / (1024 * 1024)) + 8}mb`,
});

interface WebhookBody {
  tenantSlug?: string;
  mailbox?: string;
  raw?: string;
  rawBase64?: string;
  envelopeTo?: string[];
  receivedAt?: string;
}

/**
 * POST /api/mail/webhook
 *
 * Two body shapes, because providers differ:
 *   • `application/json` with `{ tenantSlug, mailbox, rawBase64 | raw }`
 *   • `message/rfc822` with the message itself, and the tenant + mailbox named
 *     by the `X-Oblidesk-Tenant` / `X-Oblidesk-Mailbox` headers.
 *
 * The TENANT IS NAMED BY SLUG (HARD RULE 13) and the mailbox is resolved INSIDE
 * that tenant. Resolving a mailbox by address across tenants would let anyone
 * who knows one tenant's support address post mail into a different one.
 */
router.post(
  '/webhook',
  rawMessageParser,
  asyncHandler(async (req: Request, res: Response) => {
    const isRaw = Buffer.isBuffer(req.body);
    const body: WebhookBody = isRaw ? {} : ((req.body ?? {}) as WebhookBody);

    const tenantSlug = String(
      body.tenantSlug ?? req.get('X-Oblidesk-Tenant') ?? '',
    ).trim();
    const mailboxName = String(body.mailbox ?? req.get('X-Oblidesk-Mailbox') ?? '').trim();

    if (tenantSlug === '') {
      return res
        .status(400)
        .json({ success: false, error: 'tenantSlug is required (the tenant SLUG, never an id)' });
    }

    const tenant = await mailboxService.tenantBySlug(tenantSlug);
    // A wrong tenant slug and a wrong key must be indistinguishable, or the
    // endpoint becomes a tenant-enumeration oracle for anyone with a spare
    // afternoon.
    const presented = bearerValue(req.headers.authorization);
    const account = tenant && mailboxName !== ''
      ? await mailboxService.findByAddressOrName(tenant.id, mailboxName)
      : null;

    const authorised =
      (account !== null && presented !== null && mailboxService.verifyWebhookSecret(account, presented)) ||
      (await authenticateIngestKey(req.headers.authorization));

    if (!tenant || !authorised) {
      logger.warn({ tenantSlug, mailboxName }, 'mail: webhook rejected');
      return res.status(401).json({ success: false, error: 'Invalid or missing ingest key' });
    }

    let raw: Buffer;
    if (isRaw) {
      raw = req.body as Buffer;
    } else if (typeof body.rawBase64 === 'string') {
      raw = Buffer.from(body.rawBase64, 'base64');
    } else if (typeof body.raw === 'string') {
      raw = Buffer.from(body.raw, 'utf8');
    } else {
      return res
        .status(400)
        .json({ success: false, error: 'A raw RFC-822 message is required (raw or rawBase64)' });
    }

    if (raw.length === 0) {
      return res.status(400).json({ success: false, error: 'The message body was empty' });
    }

    const receivedAt = body.receivedAt ? new Date(body.receivedAt) : null;

    const result = await inboundService.ingestRaw({
      tenantId: tenant.id,
      mailAccountId: account?.id ?? null,
      raw,
      source: 'webhook',
      receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : null,
      envelopeTo: Array.isArray(body.envelopeTo) ? body.envelopeTo.map(String) : undefined,
    });

    logger.info(
      {
        tenantId: tenant.id,
        mailAccountId: account?.id ?? null,
        outcome: result.outcome,
        ticketId: result.ticketId,
      },
      'mail: webhook message ingested',
    );

    // A duplicate, a bounce and a loop are all 2xx. See the header.
    return res.json({
      success: true,
      data: {
        outcome: result.outcome,
        messageId: result.messageId,
        ticketId: result.ticketId,
        ticketNumber: result.ticketNumber,
        threadTier: result.threadTier,
        suggestions: result.suggestions,
        warnings: result.warnings,
      },
    });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Mailbox administration
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Reads are open to whoever configures routing (a mailbox IS routing: it names
 * the queue new mail lands in). Writes need CONFIG_ADMIN, because they touch
 * stored credentials.
 */
const readMail = [
  requireAuth,
  requireTenant,
  requireAnyCapability(CAPABILITIES.CONFIG_ADMIN, CAPABILITIES.QUEUE_ADMIN),
] as const;

const writeMail = [requireAuth, requireTenant, requireCapability(CAPABILITIES.CONFIG_ADMIN)] as const;

function accountId(req: Request): number {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, 'Invalid mailbox id');
  return id;
}

router.get(
  '/accounts',
  ...readMail,
  asyncHandler(async (req, res) => {
    const accounts = await mailboxService.list(req.tenantId);
    res.json({ success: true, data: accounts, total: accounts.length });
  }),
);

router.post(
  '/accounts',
  ...writeMail,
  asyncHandler(async (req, res) => {
    const payload = (req.body ?? {}) as Record<string, unknown>;
    const account = await mailboxService.create(req.tenantId, {
      name: String(payload.name ?? ''),
      kind: (payload.kind ?? 'imap') as 'imap' | 'graph' | 'webhook',
      config: (payload.config ?? {}) as Record<string, unknown>,
      queueSlug: String(payload.queueSlug ?? ''),
      isActive: payload.isActive === undefined ? true : Boolean(payload.isActive),
    });

    // Pick it up without waiting for the next reconcile tick, so "save" and
    // "it is collecting" are the same moment from the admin's point of view.
    void inboundService.worker.reconcile().catch(() => undefined);

    logger.info(
      { tenantId: req.tenantId, mailAccountId: account.id, userId: req.session.userId },
      'mail: mailbox created',
    );
    res.status(201).json({ success: true, data: account });
  }),
);

router.patch(
  '/accounts/:id',
  ...writeMail,
  asyncHandler(async (req, res) => {
    const payload = (req.body ?? {}) as Record<string, unknown>;
    const account = await mailboxService.update(req.tenantId, accountId(req), {
      ...(payload.name !== undefined ? { name: String(payload.name) } : {}),
      ...(payload.kind !== undefined ? { kind: payload.kind as 'imap' | 'graph' | 'webhook' } : {}),
      ...(payload.config !== undefined
        ? { config: payload.config as Record<string, unknown> }
        : {}),
      ...(payload.queueSlug !== undefined ? { queueSlug: String(payload.queueSlug) } : {}),
      ...(payload.isActive !== undefined ? { isActive: Boolean(payload.isActive) } : {}),
    });

    void inboundService.worker.reconcile().catch(() => undefined);
    res.json({ success: true, data: account });
  }),
);

router.delete(
  '/accounts/:id',
  ...writeMail,
  asyncHandler(async (req, res) => {
    await mailboxService.remove(req.tenantId, accountId(req));
    void inboundService.worker.reconcile().catch(() => undefined);
    logger.info(
      { tenantId: req.tenantId, userId: req.session.userId },
      'mail: mailbox deleted',
    );
    res.json({ success: true, data: { deleted: true } });
  }),
);

/**
 * Verify credentials without starting a poller.
 *
 * Returns `{ ok: false, error }` with a 200 rather than a 4xx: "your password
 * is wrong" is a successful test, and a client that has to distinguish a
 * transport failure from a test result should not have to read a status code to
 * do it.
 */
router.post(
  '/accounts/:id/test',
  ...writeMail,
  asyncHandler(async (req, res) => {
    const result = await inboundService.testConnection(req.tenantId, accountId(req));
    res.json({ success: true, data: result });
  }),
);

/** "Collect now" — one reconcile pass, for an admin who does not want to wait. */
router.post(
  '/accounts/:id/collect',
  ...writeMail,
  asyncHandler(async (req, res) => {
    const id = accountId(req);
    const account = await mailboxService.getById(req.tenantId, id);
    if (!account) throw new AppError(404, 'Mailbox not found');
    await inboundService.worker.reconcile();
    res.json({ success: true, data: { mailAccountId: id, connections: inboundService.worker.connectionCount() } });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — The channel console
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/mail/health
 *
 * One payload for the whole console: every mailbox, its last error, its 24-hour
 * volume in both directions, and how much outbound is still waiting on a retry.
 * The last number is the one that matters — a mailbox that looks connected
 * while forty replies sit undelivered is the failure mode nobody notices until
 * a customer calls.
 */
router.get(
  '/health',
  ...readMail,
  asyncHandler(async (req, res) => {
    const mailboxes = await mailboxService.healthOverview(req.tenantId);
    res.json({
      success: true,
      data: {
        mailboxes,
        connections: inboundService.worker.connectionCount(),
        anyDegraded: mailboxes.some((mailbox) => !mailbox.health.ok),
      },
      total: mailboxes.length,
    });
  }),
);

/** Force one pass of the outbound retry drain — the console's "retry now". */
router.post(
  '/outbound/drain',
  ...writeMail,
  asyncHandler(async (_req, res) => {
    const result = await outboundService.drain();
    res.json({ success: true, data: result });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Suppressions
// ═════════════════════════════════════════════════════════════════════════════

router.get(
  '/suppressions',
  ...readMail,
  asyncHandler(async (req, res) => {
    const rows = await mailboxService.listSuppressions(req.tenantId);
    res.json({ success: true, data: rows, total: rows.length });
  }),
);

/**
 * Let an address back in.
 *
 * Deliberately a deliberate act: a hard bounce or a detected loop put it there,
 * and un-suppressing without fixing the cause simply restarts the loop. The
 * audit trail is the log line plus the fact that the row is gone.
 */
router.delete(
  '/suppressions/:address',
  ...writeMail,
  asyncHandler(async (req, res) => {
    const removed = await mailboxService.unsuppress(req.tenantId, req.params.address);
    if (!removed) throw new AppError(404, 'That address is not suppressed');
    logger.info(
      { tenantId: req.tenantId, address: req.params.address, userId: req.session.userId },
      'mail: suppression lifted',
    );
    res.json({ success: true, data: { address: req.params.address, suppressed: false } });
  }),
);

export default router;
