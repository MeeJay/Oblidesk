/**
 * outbox.service.ts — the notification outbox worker.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  What it is for
 * ──────────────────────────────────────────────────────────────────────────
 * `notificationService.dispatch()` enqueues rows inside the transaction that
 * caused them. This worker drains that queue afterwards, so a dead SMTP server
 * never rolls back a ticket update, and a rolled-back ticket update never
 * leaves a mail already sent. See the header of notification.service.ts.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  Claiming rows: FOR UPDATE SKIP LOCKED
 * ──────────────────────────────────────────────────────────────────────────
 * A tick claims a batch with:
 *
 *   SELECT id … WHERE status='pending' AND next_attempt_at <= now()
 *   ORDER BY next_attempt_at, id LIMIT n FOR UPDATE SKIP LOCKED
 *
 * `SKIP LOCKED` is what makes several workers (or several server replicas)
 * safe against each other: a row another transaction is already holding is
 * skipped rather than waited on, so two workers never send the same
 * notification twice and neither blocks behind the other.
 *
 * The same statement pushes `next_attempt_at` forward and increments
 * `attempts`. That doubles as a LEASE: if this process dies mid-send, the row
 * is not stuck `pending` at a timestamp in the past being re-claimed in a hot
 * loop — it becomes due again after the backoff, exactly like a failure would.
 * Incrementing attempts at CLAIM time rather than at failure time is the
 * deliberate part: a row that repeatedly kills the worker mid-send would
 * otherwise retry for ever, because it would never reach the code that counts
 * the failure.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  Backoff
 * ──────────────────────────────────────────────────────────────────────────
 * `base * 2^(attempts-1)`, capped, with ±20% jitter. The jitter is not
 * decoration: without it, a hundred notifications enqueued by one SLA sweep and
 * failed by one dead endpoint all retry at the same instant, for ever — a
 * thundering herd that turns one outage into a self-inflicted one.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  start() / stop()
 * ──────────────────────────────────────────────────────────────────────────
 * `index.ts` calls `start()` behind its own advisory lock so a multi-replica
 * deployment runs one scheduler. The row-level `SKIP LOCKED` claim means a
 * second worker slipping through that lock is still CORRECT — it just does
 * some of the work. Belt and braces, in that order.
 */

import { db, scoped, insertScoped, assertTenantId } from '../db';
import type { NotificationPayload } from '../notifications/types';
import { getPlugin } from '../notifications/registry';
import { notificationService } from './notification.service';
import { smtpServerService } from './smtpServer.service';
import { settingsService } from './settings.service';
import { logger } from '../utils/logger';

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

interface OutboxRow {
  id: string | number;
  tenant_id: number;
  kind: string;
  payload: Record<string, unknown> | string;
  attempts: number;
  next_attempt_at: Date;
  status: string;
  last_error: string | null;
  created_at: Date;
  sent_at: Date | null;
}

export interface OutboxTickResult {
  claimed: number;
  sent: number;
  failed: number;
  deadLettered: number;
}

export interface OutboxStats {
  pending: number;
  failed: number;
  sentLastHour: number;
  oldestPendingAt: string | null;
}

interface WorkerConfig {
  batchSize: number;
  intervalMs: number;
  maxAttempts: number;
  baseBackoffSeconds: number;
  maxBackoffSeconds: number;
}

const FALLBACK_CONFIG: WorkerConfig = {
  batchSize: 25,
  intervalMs: 5_000,
  maxAttempts: 8,
  baseBackoffSeconds: 30,
  maxBackoffSeconds: 3600,
};

function parsePayload(value: OutboxRow['payload']): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value ?? {};
}

/**
 * `base * 2^(attempts-1)`, capped, ±20% jitter. `attempts` has already been
 * incremented by the claim, so attempt 1 waits `base`, attempt 2 waits `2×base`.
 */
export function backoffSeconds(attempts: number, config: WorkerConfig): number {
  const exponent = Math.max(0, attempts - 1);
  const raw = config.baseBackoffSeconds * 2 ** Math.min(exponent, 20);
  const capped = Math.min(raw, config.maxBackoffSeconds);
  const jitter = capped * 0.2 * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(capped + jitter));
}

// ═════════════════════════════════════════════════════════════════════════════
// Worker state
// ═════════════════════════════════════════════════════════════════════════════

let timer: NodeJS.Timeout | null = null;
let running = false;
let ticking = false;
let stopRequested = false;

/**
 * Worker configuration comes from `settings`, read at the PLATFORM level: the
 * outbox is one queue for the whole installation, so a per-tenant batch size
 * would be meaningless. (Those keys are `platformOnly` in
 * settings.service.ts for exactly this reason.)
 */
async function loadConfig(): Promise<WorkerConfig> {
  try {
    const [batchSize, intervalSeconds, maxAttempts, base, max] = await Promise.all([
      settingsService.getGlobal<number>('notifications.outboxBatchSize'),
      settingsService.getGlobal<number>('notifications.outboxIntervalSeconds'),
      settingsService.getGlobal<number>('notifications.maxAttempts'),
      settingsService.getGlobal<number>('notifications.baseBackoffSeconds'),
      settingsService.getGlobal<number>('notifications.maxBackoffSeconds'),
    ]);
    return {
      batchSize: Number(batchSize) || FALLBACK_CONFIG.batchSize,
      intervalMs: (Number(intervalSeconds) || 5) * 1000,
      maxAttempts: Number(maxAttempts) || FALLBACK_CONFIG.maxAttempts,
      baseBackoffSeconds: Number(base) || FALLBACK_CONFIG.baseBackoffSeconds,
      maxBackoffSeconds: Number(max) || FALLBACK_CONFIG.maxBackoffSeconds,
    };
  } catch (error) {
    // The worker must survive an unreadable settings table — a queue that
    // stops draining because a config read failed is a worse outage than one
    // running on defaults.
    logger.warn({ err: error }, 'outbox: could not read settings, using defaults');
    return FALLBACK_CONFIG;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Service
// ═════════════════════════════════════════════════════════════════════════════

export const outboxService = {
  /**
   * Claim and process one batch. Returns what happened, so a caller (a test, an
   * admin "drain now" button) can drive the worker without the timer.
   */
  async tick(overrides: Partial<WorkerConfig> = {}): Promise<OutboxTickResult> {
    const config = { ...(await loadConfig()), ...overrides };
    const result: OutboxTickResult = { claimed: 0, sent: 0, failed: 0, deadLettered: 0 };

    const claimed = await outboxService.claim(config);
    result.claimed = claimed.length;
    if (claimed.length === 0) return result;

    // ── A note on the unscoped writes below (HARD RULE 1) ───────────────────
    // `notification_outbox` is a tenant table, and everywhere else in the app a
    // bare `db('notification_outbox')` would be a defect. The worker is the one
    // legitimate exception, and it is worth being explicit about why:
    //
    //   • The outbox is ONE queue for the whole installation. The worker has no
    //     tenant context to scope by — it drains whatever is due, for everyone.
    //     A tenant filter here would mean one worker per tenant.
    //   • Each `id` comes from a row THIS worker just claimed under
    //     `FOR UPDATE SKIP LOCKED`, so it is a primary key we already hold a
    //     lease on. There is no user input anywhere near it and no way for one
    //     tenant's request to name another tenant's row.
    //
    // The tenant-scoped surface of this module — `stats`, `retryFailed`,
    // `pruneSent` — does go through `scoped()`, because those ARE reached from
    // a request with a tenant.
    for (const row of claimed) {
      if (stopRequested) break;

      const id = Number(row.id);
      try {
        await outboxService.process(row);
        await db('notification_outbox')
          .where({ id })
          .update({ status: 'sent', sent_at: new Date(), last_error: null });
        result.sent += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (row.attempts >= config.maxAttempts) {
          // Dead letter: stop retrying, keep the row and the reason. Deleting
          // it would destroy the only evidence that somebody was never told.
          await db('notification_outbox')
            .where({ id })
            .update({ status: 'failed', last_error: message });
          result.deadLettered += 1;
          logger.error(
            { outboxId: id, tenantId: row.tenant_id, attempts: row.attempts, err: message },
            'outbox: giving up after max attempts — notification NOT delivered',
          );
        } else {
          const delay = backoffSeconds(row.attempts, config);
          await db('notification_outbox')
            .where({ id })
            .update({
              status: 'pending',
              last_error: message,
              next_attempt_at: new Date(Date.now() + delay * 1000),
            });
          result.failed += 1;
          logger.warn(
            { outboxId: id, tenantId: row.tenant_id, attempts: row.attempts, retryInSeconds: delay },
            `outbox: delivery failed — ${message}`,
          );
        }
      }
    }

    return result;
  },

  /**
   * Claim up to `batchSize` due rows.
   *
   * One statement: the CTE selects with `FOR UPDATE SKIP LOCKED`, the UPDATE
   * increments `attempts` and pushes `next_attempt_at` out by one backoff
   * period (the lease), and RETURNING hands back the claimed rows. Splitting
   * this into a SELECT then an UPDATE would reopen the double-send window that
   * SKIP LOCKED exists to close.
   */
  async claim(config: WorkerConfig): Promise<OutboxRow[]> {
    const leaseSeconds = backoffSeconds(1, config);

    const result = await db.raw(
      `WITH due AS (
         SELECT id
           FROM notification_outbox
          WHERE status = 'pending'
            AND next_attempt_at <= now()
          ORDER BY next_attempt_at, id
          LIMIT ?
          FOR UPDATE SKIP LOCKED
       )
       UPDATE notification_outbox AS o
          SET attempts = o.attempts + 1,
              next_attempt_at = now() + (? * interval '1 second')
         FROM due
        WHERE o.id = due.id
      RETURNING o.*`,
      [config.batchSize, leaseSeconds],
    );

    return (result?.rows ?? []) as OutboxRow[];
  },

  /**
   * Deliver one row according to its `kind`. Throws on failure — `tick()` turns
   * the throw into a retry or a dead letter.
   */
  async process(row: OutboxRow): Promise<void> {
    const payload = parsePayload(row.payload);
    const tenantId = Number(row.tenant_id);

    switch (row.kind) {
      case 'channel': {
        const channelId = Number(payload.channelId);
        const notification = payload.notification as NotificationPayload | undefined;
        if (!Number.isInteger(channelId) || !notification) {
          throw new Error('outbox: malformed channel payload (channelId / notification missing)');
        }
        await notificationService.deliver(tenantId, channelId, notification);
        return;
      }

      case 'email': {
        await outboxService.sendDirectEmail(tenantId, payload);
        return;
      }

      case 'webhook': {
        const plugin = getPlugin('webhook');
        if (!plugin) throw new Error('outbox: the webhook plugin is not registered');
        const notification = payload.notification as NotificationPayload | undefined;
        if (!notification) throw new Error('outbox: webhook payload has no notification');
        await plugin.send({ url: payload.url, secret: payload.secret }, notification);
        return;
      }

      case 'portal':
      case 'inapp': {
        await outboxService.raiseLiveAlert(tenantId, payload);
        return;
      }

      default:
        // An unknown kind is a programming error, not a transient failure.
        // Throwing lets it dead-letter after the retries rather than looping
        // silently, and the row keeps the payload for whoever debugs it.
        throw new Error(`outbox: unknown kind "${row.kind}"`);
    }
  },

  /**
   * Direct e-mail that does not go through a channel: an acknowledgement to a
   * requester, a password reset. Uses the tenant's default SMTP server, falling
   * back to the platform one.
   */
  async sendDirectEmail(tenantId: number, payload: Record<string, unknown>): Promise<void> {
    const explicitServerId = Number(payload.smtpServerId);
    const server = Number.isInteger(explicitServerId) && explicitServerId > 0
      ? await smtpServerService.getTransportConfig(explicitServerId)
      : await (async () => {
          const preferred = await smtpServerService.getDefault(tenantId);
          return preferred ? smtpServerService.getTransportConfig(preferred.id) : null;
        })();

    if (!server) {
      throw new Error(
        `outbox: no SMTP server available for tenant ${tenantId} — set a default in Admin → SMTP servers`,
      );
    }

    const plugin = getPlugin('smtp');
    if (!plugin) throw new Error('outbox: the smtp plugin is not registered');

    const notification = payload.notification as NotificationPayload | undefined;
    if (!notification) throw new Error('outbox: email payload has no notification');

    await plugin.send(
      {
        host: server.host,
        port: server.port,
        secure: server.secure,
        username: server.username,
        password: server.password,
        from: server.fromAddress,
        fromName: server.fromName,
        to: payload.to ?? notification.to,
        replyTo: payload.replyTo ?? null,
        messageId: payload.messageId ?? null,
        inReplyTo: payload.inReplyTo ?? null,
        references: payload.references ?? null,
      },
      notification,
    );
  },

  /**
   * The in-app bell entry. `stable_key` dedupes: a re-fire of the same
   * condition updates rather than stacking, which is what stops a flapping
   * monitor from producing four hundred unread bells overnight.
   */
  async raiseLiveAlert(tenantId: number, payload: Record<string, unknown>): Promise<void> {
    assertTenantId(tenantId);

    const notification = payload.notification as NotificationPayload | undefined;
    const stableKey = typeof payload.stableKey === 'string' ? payload.stableKey : null;

    const title = String(payload.title ?? notification?.title ?? 'Notification');
    const message = String(payload.message ?? notification?.body ?? '');
    const severity = String(payload.severity ?? notification?.severity ?? 'info');
    const navigateTo =
      typeof payload.navigateTo === 'string'
        ? payload.navigateTo
        : typeof notification?.url === 'string'
          ? notification.url
          : null;

    if (stableKey) {
      const existing = (await scoped('live_alerts', tenantId)
        .where('live_alerts.stable_key', stableKey)
        .whereNull('live_alerts.read_at')
        .first('id')) as { id: number } | undefined;

      if (existing) {
        await scoped('live_alerts', tenantId)
          .where('live_alerts.id', existing.id)
          .update({ title, message, navigate_to: navigateTo, created_at: new Date() });
        return;
      }
    }

    await insertScoped('live_alerts', tenantId, {
      severity,
      title,
      message,
      navigate_to: navigateTo,
      stable_key: stableKey,
    });
  },

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the drain loop. Idempotent — a second call is a no-op rather than a
   * second timer, because two timers on one process would double the claim
   * rate for no benefit.
   *
   * `setTimeout` chained after each tick, not `setInterval`: with an interval,
   * a tick slower than the period overlaps with the next one and the batches
   * pile up. Chaining guarantees exactly one tick in flight.
   */
  async start(): Promise<void> {
    if (running) {
      logger.debug('outbox: worker already running');
      return;
    }
    running = true;
    stopRequested = false;

    const config = await loadConfig();
    logger.info(
      { intervalMs: config.intervalMs, batchSize: config.batchSize },
      'outbox: worker started',
    );

    const loop = async (): Promise<void> => {
      if (stopRequested) return;
      ticking = true;
      try {
        await outboxService.tick();
      } catch (error) {
        // Never let a tick failure kill the loop: the next tick may well
        // succeed, and a silently dead worker is the failure mode that takes
        // days to notice.
        logger.error({ err: error }, 'outbox: tick failed');
      } finally {
        ticking = false;
      }
      if (stopRequested) return;
      const next = await loadConfig();
      timer = setTimeout(() => void loop(), next.intervalMs);
      // Do not hold the process open for the next tick — a shutdown should not
      // have to wait out an interval.
      timer.unref?.();
    };

    timer = setTimeout(() => void loop(), config.intervalMs);
    timer.unref?.();
  },

  /**
   * Stop the loop and wait for an in-flight tick to finish, so a shutdown does
   * not cut a delivery in half and leave the row leased.
   */
  async stop(): Promise<void> {
    stopRequested = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    const deadline = Date.now() + 15_000;
    while (ticking && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    running = false;
    logger.info('outbox: worker stopped');
  },

  isRunning(): boolean {
    return running;
  },

  // ── Operations ───────────────────────────────────────────────────────────

  /** Queue health for the admin dashboard. */
  async stats(tenantId: number): Promise<OutboxStats> {
    assertTenantId(tenantId);

    const [pendingRow] = (await scoped('notification_outbox', tenantId)
      .where('notification_outbox.status', 'pending')
      .count<{ count: string }[]>('notification_outbox.id as count')) as unknown as Array<{
      count: string;
    }>;

    const [failedRow] = (await scoped('notification_outbox', tenantId)
      .where('notification_outbox.status', 'failed')
      .count<{ count: string }[]>('notification_outbox.id as count')) as unknown as Array<{
      count: string;
    }>;

    const [sentRow] = (await scoped('notification_outbox', tenantId)
      .where('notification_outbox.status', 'sent')
      .where('notification_outbox.sent_at', '>=', new Date(Date.now() - 3600_000))
      .count<{ count: string }[]>('notification_outbox.id as count')) as unknown as Array<{
      count: string;
    }>;

    const oldest = (await scoped('notification_outbox', tenantId)
      .where('notification_outbox.status', 'pending')
      .orderBy('notification_outbox.created_at', 'asc')
      .first('created_at')) as { created_at: Date } | undefined;

    return {
      pending: Number(pendingRow?.count ?? 0),
      failed: Number(failedRow?.count ?? 0),
      sentLastHour: Number(sentRow?.count ?? 0),
      oldestPendingAt: oldest ? oldest.created_at.toISOString() : null,
    };
  },

  /**
   * Put dead-lettered rows back in the queue with `attempts` reset — the
   * "retry failed notifications" button, for after the SMTP server came back.
   */
  async retryFailed(tenantId: number, ids?: number[]): Promise<number> {
    assertTenantId(tenantId);

    const query = scoped('notification_outbox', tenantId).where(
      'notification_outbox.status',
      'failed',
    );
    if (ids && ids.length > 0) query.whereIn('notification_outbox.id', ids);

    return query.update({
      status: 'pending',
      attempts: 0,
      next_attempt_at: new Date(),
      last_error: null,
    });
  },

  /**
   * Prune delivered rows older than `days`. `sent` rows only: a `failed` row is
   * the record of a notification somebody never received, and that is worth
   * more than the disk space it occupies.
   */
  async pruneSent(tenantId: number, days: number): Promise<number> {
    assertTenantId(tenantId);
    const cutoff = new Date(Date.now() - days * 86_400_000);
    return scoped('notification_outbox', tenantId)
      .where('notification_outbox.status', 'sent')
      .where('notification_outbox.sent_at', '<', cutoff)
      .del();
  },
};

export default outboxService;
