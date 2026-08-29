import { Router } from 'express';
import crypto from 'crypto';
import { db, scoped } from '../db';
import { logger } from '../utils/logger';
import { CAPABILITIES } from '@oblidesk/shared';
import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireCapability } from '../middleware/rbac';
import { asyncHandler } from '../utils/asyncHandler';
import { alertService, AlertIngestError } from '../services/alert.service';

/**
 * Alert ingest — the entry point of the alert spine.
 *
 * Called SERVER-TO-SERVER by the suite apps, so it authenticates with a bearer
 * token rather than a session cookie: there is no user behind an alert.
 *
 * The token lives in app_config under `alertIngestKey`. It is compared in
 * constant time — a timing-distinguishable compare on a shared secret is a real
 * attack, not a theoretical one, because the caller controls the retry rate.
 *
 * Response contract (consumed verbatim by
 * D:/Obliview/server/src/notifications/plugins/oblidesk.ts):
 *   2xx + { success: true, data: { alertId, stableKey, action, ticketId, ticketNumber } }
 *   non-2xx + { success: false, error: "<human readable>" }
 *
 * A REPEAT OF A KNOWN KEY IS NOT AN ERROR. Deduplication is the normal path and
 * must answer 2xx — returning 4xx would fill the caller's notification_log with
 * failures for behaviour that is working exactly as designed.
 */

const router = Router();

/** Constant-time bearer check against the configured ingest key. */
async function authenticateApp(header: string | undefined): Promise<boolean> {
  if (!header || !header.startsWith('Bearer ')) return false;
  const presented = header.slice(7).trim();
  if (!presented) return false;

  const row = await db('app_config').where({ key: 'alertIngestKey' }).first('value');
  const raw = row?.value;
  const expected = typeof raw === 'string' ? raw : (raw as { key?: string } | undefined)?.key;
  if (!expected) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (a.length !== b.length) {
    // Still burn a comparison so the failure cost does not depend on length.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// POST /api/alerts/ingest — one alert from a suite app
router.post('/ingest', async (req, res) => {
  try {
    if (!(await authenticateApp(req.headers.authorization))) {
      return res.status(401).json({ success: false, error: 'Invalid or missing ingest key' });
    }

    const body = alertService.validate(req.body);
    const result = await alertService.ingest(body);

    logger.info(
      { source: body.source, stableKey: body.stableKey, action: result.action, ticketId: result.ticketId },
      'Alert ingested',
    );
    return res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof AlertIngestError) {
      // A deliberate, explainable refusal — the caller logs this message.
      logger.warn({ err: err.message }, 'Alert ingest refused');
      return res.status(err.status).json({ success: false, error: err.message });
    }
    logger.error(err, 'Alert ingest failed');
    return res.status(500).json({ success: false, error: 'Alert ingest failed' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Read side — session-authenticated, tenant-scoped.
//
// Everything below is a normal desk API: a human is looking at the Shift Board.
// The ingest route above deliberately sits OUTSIDE this tier, so these two
// middlewares must be applied per-route rather than with router.use() at the
// top — a router.use() here would also gate /ingest and break the sibling apps.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/alerts?state=unticketed|open|all&limit=
 *
 * Feeds the Shift Board's fourth column: suite alerts that are still firing and
 * have NO ticket. Every service desk on earth starts the morning blind to
 * unreported incidents; a desk that owns the monitoring does not.
 */
router.get(
  '/',
  requireAuth,
  requireTenant,
  requireCapability(CAPABILITIES.TICKET_READ),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const state = String(req.query.state ?? 'unticketed');
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);

    let rows;
    if (state === 'unticketed') {
      rows = await alertService.listUnticketed(tenantId, limit);
    } else {
      const q = scoped('suite_alerts', tenantId).orderBy('last_seen_at', 'desc').limit(limit);
      if (state === 'open') q.whereNull('cleared_at');
      rows = await q.select('*');
    }

    res.json({
      success: true,
      data: rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        sourceApp: r.source_app,
        dedupeKey: r.dedupe_key,
        severity: r.severity,
        title: r.title,
        message: r.message,
        ciId: r.ci_id,
        externalId: r.external_id,
        tenantSlug: r.tenant_slug,
        occurrenceCount: r.occurrence_count,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        clearedAt: r.cleared_at,
        ticketId: r.ticket_id,
        suppressedReason: r.suppressed_reason,
      })),
      total: rows.length,
    });
  }),
);

/**
 * POST /api/alerts/:id/convert — turn an un-ticketed alert into a ticket.
 *
 * The one keystroke on the Shift Board's fourth column. It MUST be the server
 * that stamps `suite_alerts.ticket_id`: without that write the alert has no
 * memory of its ticket, so it reappears in the column on the next reload and
 * the next beat opens a second ticket — which is the landfill the whole spine
 * exists to prevent.
 *
 * Idempotent by design: converting an already-converted alert returns the
 * existing ticket rather than creating another.
 */
router.post(
  '/:id/convert',
  requireAuth,
  requireTenant,
  requireCapability(CAPABILITIES.TICKET_RW),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const alertId = parseInt(req.params.id, 10);
    if (!Number.isFinite(alertId)) {
      return res.status(400).json({ success: false, error: 'Invalid alert id' });
    }

    const result = await db.transaction(async (trx) => {
      const alert = await trx('suite_alerts')
        .where({ id: alertId, tenant_id: tenantId })
        .forUpdate()
        .first();
      if (!alert) return { notFound: true as const };

      if (alert.ticket_id) {
        const existing = await trx('tickets')
          .where({ id: alert.ticket_id, tenant_id: tenantId })
          .first('id', 'number');
        return { alert, ticket: existing ?? null, created: false };
      }

      const { ticketService } = await import('../services/ticket.service');
      const payload = (typeof alert.payload === 'string' ? JSON.parse(alert.payload) : alert.payload) ?? {};

      const ticket = await ticketService.create(
        {
          tenantId,
          recordType: 'incident',
          subject: alert.title,
          descriptionMd: alertService.renderDescription({ ...payload, title: alert.title }),
          prioritySlug: alert.severity === 'critical' ? 'p1' : alert.severity === 'warning' ? 'p3' : 'p4',
          source: 'alert',
          // HARD RULE 6 — when the problem started, not when a human noticed it.
          occurredAt: alert.first_seen_at,
          primaryCiId: alert.ci_id ?? null,
          data: {
            suite_alert_id: alert.id,
            source_app: alert.source_app,
            dedupe_key: alert.dedupe_key,
            external_id: alert.external_id,
            occurrence_count: alert.occurrence_count,
          },
        },
        // Converted BY a human, so the actor is the person who pressed the key —
        // the audit trail must not read as if automation opened it.
        { actorType: 'user', actorId: req.session.userId ?? null, trx },
      );

      await trx('suite_alerts')
        .where({ id: alertId })
        .update({ ticket_id: ticket.id, suppressed_reason: null });

      return { alert, ticket: { id: ticket.id, number: ticket.number }, created: true };
    });

    if ('notFound' in result) {
      return res.status(404).json({ success: false, error: 'Alert not found' });
    }

    logger.info(
      { alertId, ticketId: result.ticket?.id, created: result.created, userId: req.session.userId },
      result.created ? 'Alert converted to ticket' : 'Alert already had a ticket',
    );
    return res.json({
      success: true,
      data: {
        alertId,
        ticketId: result.ticket?.id ?? null,
        ticketNumber: result.ticket?.number ?? null,
        created: result.created,
      },
    });
  }),
);

/**
 * POST /api/alerts/:id/dismiss — acknowledge an alert without opening a ticket.
 *
 * Clears it off the board with a stated reason, which is honest bookkeeping
 * rather than deletion: the row survives, so the next occurrence still dedupes
 * against it and the decision is visible.
 */
router.post(
  '/:id/dismiss',
  requireAuth,
  requireTenant,
  requireCapability(CAPABILITIES.TICKET_RW),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId!;
    const alertId = parseInt(req.params.id, 10);
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 64)
      : 'dismissed_by_agent';

    const updated = await scoped('suite_alerts', tenantId)
      .where('suite_alerts.id', alertId)
      .whereNull('ticket_id')
      .update({ suppressed_reason: reason, cleared_at: db.fn.now() });

    if (!updated) {
      return res.status(404).json({ success: false, error: 'Alert not found, already ticketed, or already cleared' });
    }
    return res.json({ success: true, data: { alertId, reason } });
  }),
);

export default router;
