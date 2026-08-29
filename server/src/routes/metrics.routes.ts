/**
 * metrics.routes.ts — `/api/metrics`.
 *
 * ── The shape of this API is the point ───────────────────────────────────────
 * There is no endpoint here that takes a query. There is one that takes a
 * registered metric KEY, a declared DIMENSION, an offered RANGE and a
 * published saved-view SLUG, and there is one that returns the catalogue those
 * choices come from.
 *
 * That is deliberate and it is not negotiable: a reporting endpoint that
 * accepts a filter object accepts SQL by a slower route. The client builds its
 * pickers from `GET /catalog`, so an invalid combination is not something a
 * user can express, and `metric.service` re-validates every choice against the
 * same registry, so an invalid combination is not something a crafted request
 * can express either.
 *
 * MOUNTING: expects the app's auth middleware in front; `resolveActor` fails
 * closed with 401 if it is not there.
 */

import { Router, type Request, type Response } from 'express';

import { CAPABILITIES } from '@oblidesk/shared';

import {
  metricCatalog,
  metricRecords,
  resolveDelta,
  resolveMetric,
  type MetricRequest,
} from '../services/metric.service';
import { isRunning, runOnce } from '../services/rollup.service';
import {
  handleServiceError,
  metricDeltaQuerySchema,
  metricQuerySchema,
  metricRecordsQuerySchema,
  requireCapability,
  resolveActor,
  sendOk,
  toMetricRequest,
} from '../validators/config.validators';

const router = Router();

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((error: unknown) => handleServiceError(res, error));
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// The catalogue
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every registered metric with its unit, aggregation, declared dimensions and
 * offered ranges. The client's metric picker, dimension picker and range
 * picker are all generated from this, which is what makes "the UI cannot offer
 * an invalid combination" true by construction rather than by review.
 */
router.get('/catalog', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_VIEW);
  sendOk(res, { metrics: metricCatalog(), rollupRunning: isRunning() });
}));

// ═════════════════════════════════════════════════════════════════════════════
// Resolution
// ═════════════════════════════════════════════════════════════════════════════

/** One metric, by query string. `?key=open_tickets&groupBy=queue_slug`. */
router.get('/', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_VIEW);

  const parsed = metricQuerySchema.parse(req.query);
  const request = toMetricRequest(parsed) as MetricRequest;
  sendOk(res, await resolveMetric(actor.tenantId, actor, request));
}));

/**
 * Several metrics in one round trip — what a KPI row asks for.
 *
 * Resolved sequentially: a row of six tiles firing six concurrent aggregates
 * at a pool of ten connections starves every request behind it, and the row is
 * not measurably faster for it. One failing metric returns its error in place
 * rather than failing the batch.
 */
router.post('/batch', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_VIEW);

  const body = req.body as { queries?: unknown };
  const queries = Array.isArray(body?.queries) ? body.queries.slice(0, 24) : [];

  const results: Array<Record<string, unknown>> = [];
  for (const raw of queries) {
    try {
      const parsed = metricQuerySchema.parse(raw);
      const request = toMetricRequest(parsed) as MetricRequest;
      results.push({ ok: true, result: await resolveMetric(actor.tenantId, actor, request) });
    } catch (error) {
      results.push({
        ok: false,
        error: error instanceof Error ? error.message : 'That metric could not be resolved.',
      });
    }
  }

  sendOk(res, results);
}));

/** One metric by path, so a KPI tile has a bookmarkable URL. */
router.get('/:key', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_VIEW);

  const parsed = metricQuerySchema.parse({ ...req.query, key: req.params.key });
  const request = toMetricRequest(parsed) as MetricRequest;
  sendOk(res, await resolveMetric(actor.tenantId, actor, request));
}));

/**
 * The tickets behind the number.
 *
 * Built from the SAME predicates as the aggregate, inside the same registry
 * definition, so the list can never disagree with the KPI it was reached from.
 * `group` narrows it to the bar that was clicked.
 */
router.get('/:key/records', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_VIEW);

  const parsed = metricRecordsQuerySchema.parse({ ...req.query, key: req.params.key });
  const request = toMetricRequest(parsed) as MetricRequest;

  const records = await metricRecords(
    actor.tenantId,
    actor,
    { ...request, granularity: null, group: parsed.group ?? undefined },
    { page: parsed.page, limit: parsed.limit },
  );

  res.status(200).json({
    success: true,
    data: records.rows,
    page: records.page,
    limit: records.limit,
    total: records.rows.length,
    warnings: records.warnings,
  });
}));

/**
 * "vs yesterday" / "vs last week" for a KPI tile.
 *
 * For a point-in-time metric the comparison is read out of
 * `metric_daily_rollup` — that table is the only place last Tuesday's open
 * count still exists.
 */
router.get('/:key/delta', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_VIEW);

  const parsed = metricDeltaQuerySchema.parse({ ...req.query, key: req.params.key });
  const request = toMetricRequest(parsed) as MetricRequest;

  sendOk(res, await resolveDelta(
    actor.tenantId,
    actor,
    { ...request, granularity: null },
    parsed.compareTo ?? 'yesterday',
  ));
}));

// ═════════════════════════════════════════════════════════════════════════════
// Rollup control
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Recompute the daily rollup now, for this tenant.
 *
 * Idempotent (every write is an upsert on the day/metric/dimension key), so
 * the worst a double-click costs is a repeated job. Gated on REPORT_ADMIN
 * because it is a background job somebody can hold down.
 */
router.post('/rollup/run', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_ADMIN);

  const body = req.body as { offsetDays?: unknown } | undefined;
  const offsetDays = Number(body?.offsetDays);

  sendOk(res, await runOnce({
    tenantId: actor.tenantId,
    offsetDays: Number.isInteger(offsetDays) && offsetDays >= 0 && offsetDays <= 400 ? offsetDays : 1,
  }));
}));

export { router as metricsRouter };
export default router;
