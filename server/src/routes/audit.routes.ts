/**
 * audit.routes.ts — `/api/audit`
 *
 * Read access to the append-only, hash-chained ledger, plus the two operations
 * that are not reads: verifying the chain and redacting a row.
 *
 * ── There is no POST ──────────────────────────────────────────────────────
 * Audit rows are written by `auditService.record()` on the code path of the
 * action they describe, inside that action's transaction. An HTTP endpoint that
 * appended an arbitrary row would let anyone with a session write history —
 * which is precisely what a tamper-evident ledger exists to prevent. The
 * absence of a create endpoint here is the feature.
 *
 * ── There is no DELETE either ─────────────────────────────────────────────
 * `POST /:id/redact` appends a TOMBSTONE. Deleting a row (or blanking its
 * payload) would change the value the next row's `prev_hash` committed to and
 * break the chain from that point to the head, trading a privacy problem for an
 * integrity problem. The tombstone masks the payload on every read path while
 * leaving the chain verifiable.
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth, currentUserId } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireRole } from '../middleware/rbac';
import { auditService } from '../services/audit.service';
import { decisionService } from '../services/decision.service';
import type { ActorType, DecisionSubsystem } from '@oblidesk/shared';
import { logger } from '../utils/logger';

const router = Router();

interface ActorContext {
  tenantId: number;
  actorId: number;
  ip: string | null;
  userAgent: string | null;
}

/** See users.routes.ts — `currentUserId()` throws rather than yielding a null actor. */
function actorContext(req: Request): ActorContext {
  return {
    tenantId: req.tenantId,
    actorId: currentUserId(req),
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ success: false, error });
}

function parseId(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

router.use(requireAuth);
router.use(requireTenant);

// ═════════════════════════════════════════════════════════════════════════════
// Reads
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/audit — the tenant's audit trail, newest first.
 *
 * Managers can read it: an audit log only a platform admin can see is an audit
 * log nobody consults, and the point of keeping it is that somebody looks.
 */
router.get('/', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { tenantId } = actorContext(req);
    const result = await auditService.list(tenantId, {
      action: asString(req.query.action),
      actionPrefix: asString(req.query.actionPrefix),
      entityType: asString(req.query.entityType),
      entityId: asString(req.query.entityId),
      actorId: req.query.actorId ? Number(req.query.actorId) : undefined,
      actorType: asString(req.query.actorType) as ActorType | undefined,
      from: asString(req.query.from),
      to: asString(req.query.to),
      q: asString(req.query.q),
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });

    res.json({
      success: true,
      data: result.entries,
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  } catch (error) {
    logger.error({ err: error }, 'audit: list failed');
    fail(res, 500, 'Failed to load the audit log');
  }
});

/**
 * GET /api/audit/head — the chain head.
 *
 * Cheap enough to poll: comparing the head hash against a previously recorded
 * one detects tampering without walking the whole chain, which is what makes a
 * scheduled integrity check affordable.
 */
router.get('/head', requireRole('admin'), async (req, res) => {
  try {
    const { tenantId } = actorContext(req);
    const head = await auditService.getHead(tenantId);
    res.json({ success: true, data: head });
  } catch (error) {
    logger.error({ err: error }, 'audit: head failed');
    fail(res, 500, 'Failed to read the chain head');
  }
});

/**
 * GET /api/audit/verify — recompute every digest and report the FIRST link that
 * does not reconcile.
 *
 * "First" and not "all": once one link breaks, every hash after it is computed
 * from a value that no longer matches, so listing them all would be thousands
 * of rows pointing at one incident. The id returned is where to look.
 *
 * This walks the whole chain, so it is admin-only and deliberately not on a hot
 * path.
 */
router.get('/verify', requireRole('admin'), async (req, res) => {
  try {
    const { tenantId } = actorContext(req);
    const verification = await auditService.verifyChain(tenantId);
    // A broken chain is a successful ANSWER to the question, not a failed
    // request — 200 with `ok: false`, so the client renders the finding rather
    // than an error toast.
    res.json({ success: true, data: verification });
  } catch (error) {
    logger.error({ err: error }, 'audit: verify failed');
    fail(res, 500, 'Failed to verify the audit chain');
  }
});

/** GET /api/audit/entity/:entityType/:entityId — one entity's full history. */
router.get('/entity/:entityType/:entityId', requireRole('admin', 'manager'), async (req, res) => {
  const { entityType, entityId } = req.params;
  if (!entityType || !entityId) return fail(res, 400, 'entityType and entityId are required');

  try {
    const { tenantId } = actorContext(req);
    const entries = await auditService.getForEntity(
      tenantId,
      entityType,
      entityId,
      req.query.limit ? Number(req.query.limit) : 200,
    );
    res.json({ success: true, data: entries });
  } catch (error) {
    logger.error({ err: error }, 'audit: entity history failed');
    fail(res, 500, 'Failed to load entity history');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// The decision log — the "why", next to the "what"
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/audit/decisions — the automated-decision ledger (HARD RULE 2).
 *
 * It lives beside the audit log because operators reach for them together:
 * `audit_log` answers "who changed this", `decision_log` answers "why did the
 * machine change it". Two tabs of one screen, two routes on one router.
 */
router.get('/decisions', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { tenantId } = actorContext(req);
    const result = await decisionService.list(tenantId, {
      ticketId: req.query.ticketId ? Number(req.query.ticketId) : undefined,
      subsystem: asString(req.query.subsystem) as DecisionSubsystem | undefined,
      ruleSlug: asString(req.query.ruleSlug),
      from: asString(req.query.from),
      to: asString(req.query.to),
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });

    res.json({
      success: true,
      data: result.entries,
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  } catch (error) {
    logger.error({ err: error }, 'audit: decisions failed');
    fail(res, 500, 'Failed to load the decision log');
  }
});

/** GET /api/audit/decisions/stats — decision volume per subsystem. */
router.get('/decisions/stats', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { tenantId } = actorContext(req);
    const days = req.query.days ? Number(req.query.days) : 7;
    const since = new Date(Date.now() - Math.max(1, days) * 86_400_000);
    const stats = await decisionService.subsystemStats(tenantId, since);
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error({ err: error }, 'audit: decision stats failed');
    fail(res, 500, 'Failed to load decision statistics');
  }
});

/**
 * GET /api/audit/decisions/ticket/:ticketId — what the Why drawer renders.
 *
 * `?detailed=true` adds the live state those decisions produced: the SLA clocks
 * with the ledger event that last moved them, the approvals still blocking, and
 * the rules that were evaluated WITHOUT matching. That last set is the answer to
 * "why did nothing happen?", which the decision log alone structurally cannot
 * give.
 *
 * No role gate: any agent who can see the ticket must be able to see why it is
 * where it is. Hiding the reasoning from the person working the ticket is how
 * automation stops being trusted.
 */
router.get('/decisions/ticket/:ticketId', async (req, res) => {
  const ticketId = parseId(req.params.ticketId);
  if (!ticketId) return fail(res, 400, 'Invalid ticket id');

  try {
    const { tenantId } = actorContext(req);
    const explanation =
      req.query.detailed === 'true'
        ? await decisionService.explainDetailed(tenantId, ticketId)
        : await decisionService.explain(tenantId, ticketId);
    res.json({ success: true, data: explanation });
  } catch (error) {
    logger.error({ err: error }, 'audit: explain failed');
    fail(res, 500, 'Failed to explain the ticket');
  }
});

/** GET /api/audit/decisions/rule/:slug — everything one config object decided. */
router.get('/decisions/rule/:slug', requireRole('admin', 'manager'), async (req, res) => {
  const slug = req.params.slug;
  if (!slug) return fail(res, 400, 'A rule slug is required');

  try {
    const { tenantId } = actorContext(req);
    const entries = await decisionService.forRule(
      tenantId,
      slug,
      req.query.limit ? Number(req.query.limit) : 100,
    );
    res.json({ success: true, data: entries });
  } catch (error) {
    logger.error({ err: error }, 'audit: rule decisions failed');
    fail(res, 500, 'Failed to load rule decisions');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// One row (declared last so the literal paths above win)
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/audit/:id */
router.get('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid audit entry id');

  try {
    const { tenantId } = actorContext(req);
    const entry = await auditService.getById(tenantId, id);
    if (!entry) return fail(res, 404, 'Audit entry not found');
    res.json({ success: true, data: entry });
  } catch (error) {
    logger.error({ err: error }, 'audit: get failed');
    fail(res, 500, 'Failed to load the audit entry');
  }
});

/**
 * POST /api/audit/:id/redact — append a tombstone.
 *
 * A reason is REQUIRED. The tombstone is itself a chained, auditable row, and a
 * redaction with no stated reason is indistinguishable from someone hiding
 * something — which defeats the purpose of keeping the ledger at all.
 */
router.post('/:id/redact', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'Invalid audit entry id');

  const { reason } = req.body as { reason?: string };
  if (!reason || reason.trim().length < 3) {
    return fail(res, 400, 'A reason is required to redact an audit entry');
  }

  try {
    const ctx = actorContext(req);
    const tombstone = await auditService.redact({
      tenantId: ctx.tenantId,
      targetId: id,
      actorId: ctx.actorId,
      reason: reason.trim(),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    res.json({ success: true, data: tombstone });
  } catch (error) {
    logger.error({ err: error }, 'audit: redact failed');
    fail(res, 404, error instanceof Error ? error.message : 'Failed to redact the audit entry');
  }
});

export { router as auditRouter };
export default router;
