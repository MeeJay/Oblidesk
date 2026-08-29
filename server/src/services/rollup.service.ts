/**
 * rollup.service.ts — the nightly (and on-boot) daily rollup.
 *
 * ── Why a rollup exists at all ───────────────────────────────────────────────
 * Most of the metric registry is computable live from `tickets` and its
 * children. Two things are not:
 *
 *  1. HISTORY OF A SNAPSHOT. "How many tickets were open last Tuesday" cannot
 *     be recovered from today's rows. A ticket that was open on Tuesday and
 *     closed on Wednesday leaves no column saying so, and one that was closed
 *     on Tuesday, reopened on Thursday and closed again on Friday leaves a
 *     `reopen_count` of 1 and nothing else. If nobody wrote the number down on
 *     Tuesday night, the number is gone.
 *
 *  2. CHEAP DELTAS. "vs yesterday" and "vs last week" appear on every KPI tile
 *     on the board. Recomputing them live would mean running the same
 *     aggregate two or three more times per tile, per viewer, per refresh.
 *
 * So each night, per tenant, in that tenant's own timezone, this writes one
 * row per (day, metric, dimension set) into `metric_daily_rollup`.
 *
 * ── Idempotent by construction ───────────────────────────────────────────────
 * Every write is `ON CONFLICT (tenant_id, day, metric_key, dimensions) DO
 * UPDATE`. Re-running a day — after a crash, after a fixed bug, after a
 * backfill — replaces its rows instead of doubling them. That property is what
 * makes the on-boot catch-up safe: a server that was down over midnight simply
 * runs the missed day when it comes back, and a server that was not down runs
 * the same day again for nothing.
 *
 * ── One honest approximation, stated out loud ────────────────────────────────
 * Event metrics (created, resolved, breaches, csat…) are exact: they are
 * computed from timestamps inside the day being rolled up, so they are the
 * same number whenever they are computed.
 *
 * Snapshot metrics (open_tickets, backlog_age, tickets_by_*) are NOT. They are
 * read from the live table at the moment the rollup runs, and stamped with the
 * day that just ended. Running at 00:05 local makes that a very good proxy for
 * "as at end of day". Running the catch-up at 14:00 after an outage does not —
 * such a row is the state at 14:00, labelled yesterday. It is recorded anyway,
 * because an approximate history is worth more than a hole, but the
 * approximation is named here rather than discovered later by somebody trying
 * to explain a step in a graph.
 */


import { db, scoped, type Executor } from '../db';
import { systemActor, type ConfigActor } from './configObject.service';
import {
  METRIC_REGISTRY,
  resolveMetric,
  tenantTimezone,
  type MetricDimension,
  type MetricKey,
} from './metric.service';

// ═════════════════════════════════════════════════════════════════════════════
// What gets rolled up
// ═════════════════════════════════════════════════════════════════════════════

export interface RollupPlanEntry {
  key: MetricKey;
  /**
   * 'day'      — an event metric: computed over the day's own window, exact.
   * 'snapshot' — a point-in-time metric: read live and stamped with the day.
   */
  mode: 'day' | 'snapshot';
  /**
   * Dimension sets to materialise. `null` is the overall figure, and it is
   * always first because it is the one every KPI tile reads.
   *
   * Kept deliberately short. Materialising every dimension of every metric is
   * a combinatorial explosion that turns a 30-second job into a 40-minute one
   * and a small table into a large one, for breakdowns that are perfectly
   * cheap to compute live over the last 30 days.
   */
  dimensions: ReadonlyArray<MetricDimension | null>;
}

export const ROLLUP_PLAN: readonly RollupPlanEntry[] = [
  // ── snapshots: the numbers that are otherwise unrecoverable ─────────────
  { key: 'open_tickets', mode: 'snapshot', dimensions: [null, 'queue_slug', 'priority_slug', 'status_category'] },
  { key: 'backlog_age', mode: 'snapshot', dimensions: [null, 'queue_slug'] },
  { key: 'tickets_by_queue', mode: 'snapshot', dimensions: ['queue_slug'] },
  { key: 'tickets_by_priority', mode: 'snapshot', dimensions: ['priority_slug'] },
  { key: 'tickets_by_assignee', mode: 'snapshot', dimensions: ['assignee_id'] },

  // ── daily events: exact, and the basis of every delta ───────────────────
  { key: 'created', mode: 'day', dimensions: [null, 'queue_slug', 'priority_slug', 'source'] },
  { key: 'resolved', mode: 'day', dimensions: [null, 'queue_slug', 'priority_slug'] },
  { key: 'breaches', mode: 'day', dimensions: [null, 'queue_slug', 'priority_slug'] },
  { key: 'sla_attainment', mode: 'day', dimensions: [null, 'queue_slug', 'priority_slug'] },
  { key: 'first_response_time', mode: 'day', dimensions: [null, 'queue_slug'] },
  { key: 'resolution_time', mode: 'day', dimensions: [null, 'queue_slug'] },
  { key: 'reopen_rate', mode: 'day', dimensions: [null] },
  { key: 'csat', mode: 'day', dimensions: [null] },
  { key: 'billable_minutes', mode: 'day', dimensions: [null, 'queue_slug'] },
  { key: 'alert_to_ticket_ratio', mode: 'day', dimensions: [null] },
  { key: 'deflection_rate', mode: 'day', dimensions: [null] },
];

// ═════════════════════════════════════════════════════════════════════════════
// Day boundaries, computed in Postgres so DST is not our problem
// ═════════════════════════════════════════════════════════════════════════════

export interface TenantDay {
  /** Local calendar date, 'YYYY-MM-DD' — the value of `metric_daily_rollup.day`. */
  label: string;
  /** Inclusive start instant. */
  from: string;
  /** Exclusive end instant. */
  to: string;
}

/**
 * The local day boundaries for a tenant.
 *
 * `offsetDays = 0` is today (so far), `1` is the day that just ended. The
 * arithmetic is `interval '1 day'` on a LOCAL timestamp before converting back
 * to an instant, so the day the clocks change is 23 or 25 hours long, exactly
 * as the people working that day experienced it. Subtracting 86 400 000 ms in
 * JavaScript would silently produce an hour of double-counting twice a year.
 */
export async function tenantDay(
  tenantId: number,
  offsetDays = 1,
  executor: Executor = db,
): Promise<TenantDay> {
  const tz = await tenantTimezone(tenantId);

  const result = await executor.raw(
    `SELECT to_char(d.local_day, 'YYYY-MM-DD')                AS label,
            (d.local_day AT TIME ZONE ?)                      AS from_at,
            ((d.local_day + interval '1 day') AT TIME ZONE ?) AS to_at
       FROM (
         SELECT date_trunc('day', (now() AT TIME ZONE ?)) - (? || ' days')::interval AS local_day
       ) d`,
    [tz, tz, tz, String(offsetDays)],
  );

  const row = (result as { rows: Array<{ label: string; from_at: Date | string; to_at: Date | string }> }).rows[0];
  return {
    label: row.label,
    from: toIso(row.from_at),
    to: toIso(row.to_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// ═════════════════════════════════════════════════════════════════════════════
// One tenant, one day
// ═════════════════════════════════════════════════════════════════════════════

export interface RollupResult {
  tenantId: number;
  day: string;
  rowsWritten: number;
  metricsRun: number;
  errors: Array<{ metric: MetricKey; dimension: MetricDimension | null; message: string }>;
  durationMs: number;
}

/**
 * Roll up one tenant for one local day.
 *
 * Every metric goes through `resolveMetric`, which means the rollup and the
 * live dashboard compute their numbers with the same code. A rollup with its
 * own private SQL is a rollup that eventually disagrees with the screen it
 * feeds, and there is no way to tell which one is lying.
 */
export async function rollupTenantDay(
  tenantId: number,
  offsetDays = 1,
  actor: ConfigActor = systemActor(tenantId),
): Promise<RollupResult> {
  const startedAt = Date.now();
  const day = await tenantDay(tenantId, offsetDays);

  const result: RollupResult = {
    tenantId,
    day: day.label,
    rowsWritten: 0,
    metricsRun: 0,
    errors: [],
    durationMs: 0,
  };

  const rows: Array<{ metric_key: string; dimensions: string; value: number }> = [];

  for (const entry of ROLLUP_PLAN) {
    const definition = METRIC_REGISTRY.get(entry.key);
    if (!definition) continue;

    for (const dimension of entry.dimensions) {
      try {
        const resolution = await resolveMetric(tenantId, actor, {
          key: entry.key,
          // A snapshot metric only offers 'all_time': it has no timestamp to
          // window on, which is precisely why its history has to be written
          // down rather than queried.
          range: entry.mode === 'snapshot' ? 'all_time' : 'custom',
          from: entry.mode === 'day' ? day.from : undefined,
          to: entry.mode === 'day' ? day.to : undefined,
          groupBy: definition.forcedGroupBy ? null : dimension,
          granularity: null,
          limit: 200,
        });

        result.metricsRun += 1;

        const effectiveDimension = definition.forcedGroupBy ?? dimension;

        for (const point of resolution.points) {
          if (point.value === null || !Number.isFinite(point.value)) continue;

          const dimensions: Record<string, string> = {};
          if (effectiveDimension && point.group !== null) {
            dimensions[effectiveDimension] = point.group;
          } else if (effectiveDimension && point.group === null) {
            // A NULL group (unassigned, no organization) is a real bucket and
            // is kept — it is usually the bucket somebody needs to act on.
            dimensions[effectiveDimension] = '';
          }

          rows.push({
            metric_key: entry.key,
            dimensions: JSON.stringify(dimensions),
            value: point.value,
          });
        }
      } catch (error) {
        // One metric failing must not cost the other eighteen their day.
        result.errors.push({
          metric: entry.key,
          dimension,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (rows.length > 0) {
    await db.transaction(async (trx) => {
      // Chunked: a tenant with 200 queues and 4 priorities produces a lot of
      // rows, and one statement with thousands of tuples is a lock held for
      // longer than any of them are worth.
      const CHUNK = 500;
      for (let index = 0; index < rows.length; index += CHUNK) {
        const chunk = rows.slice(index, index + CHUNK).map((row) => ({
          tenant_id: tenantId,
          day: day.label,
          metric_key: row.metric_key,
          dimensions: row.dimensions,
          value: row.value,
        }));

        await trx('metric_daily_rollup')
          .insert(chunk)
          .onConflict(['tenant_id', 'day', 'metric_key', 'dimensions'])
          .merge(['value']);

        result.rowsWritten += chunk.length;
      }
    });
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

/** Every tenant, one day. Sequential — this is a background job, not a race. */
export async function rollupAllTenants(offsetDays = 1): Promise<RollupResult[]> {
  const tenants = (await db('tenants').select('id', 'slug').orderBy('id')) as Array<{ id: number; slug: string }>;

  const results: RollupResult[] = [];
  for (const tenant of tenants) {
    if (!running && started) break; // stop() was called mid-sweep
    try {
      results.push(await rollupTenantDay(Number(tenant.id), offsetDays, systemActor(Number(tenant.id), tenant.slug)));
    } catch (error) {
      results.push({
        tenantId: Number(tenant.id),
        day: '',
        rowsWritten: 0,
        metricsRun: 0,
        errors: [{ metric: 'open_tickets', dimension: null, message: error instanceof Error ? error.message : String(error) }],
        durationMs: 0,
      });
    }
  }
  return results;
}

// ═════════════════════════════════════════════════════════════════════════════
// Catch-up
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Roll up any of the last `days` local days a tenant has no rows for.
 *
 * This is what makes an outage recoverable rather than a permanent gap in the
 * graph. Note the honesty limit: a snapshot metric backfilled three days late
 * records TODAY's state under that day's label (see the header). Event metrics
 * backfill exactly.
 */
export async function catchUpTenant(tenantId: number, days = 7): Promise<RollupResult[]> {
  const existing = (await scoped('metric_daily_rollup', tenantId)
    .distinct('day')
    .whereRaw(`metric_daily_rollup.day >= (CURRENT_DATE - ?::int)`, [days])) as Array<{ day: Date | string }>;

  const have = new Set(
    existing.map((row) => (row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10))),
  );

  const results: RollupResult[] = [];
  // Oldest first, so a partial catch-up still leaves a contiguous history.
  for (let offset = days; offset >= 1; offset -= 1) {
    const day = await tenantDay(tenantId, offset);
    if (have.has(day.label)) continue;
    results.push(await rollupTenantDay(tenantId, offset));
  }
  return results;
}

export async function catchUpAllTenants(days = 7): Promise<RollupResult[]> {
  const tenants = (await db('tenants').select('id').orderBy('id')) as Array<{ id: number }>;
  const results: RollupResult[] = [];
  for (const tenant of tenants) {
    if (!running && started) break;
    results.push(...await catchUpTenant(Number(tenant.id), days));
  }
  return results;
}

// ═════════════════════════════════════════════════════════════════════════════
// Retention
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Trim rollup rows older than `keepDays`. Two years by default: long enough
 * for a year-on-year comparison, short enough that the table never becomes the
 * reason a backup takes an hour.
 */
export async function pruneOldRollups(keepDays = 730): Promise<number> {
  const deleted = await db('metric_daily_rollup')
    .whereRaw('day < (CURRENT_DATE - ?::int)', [keepDays])
    .delete();
  return Number(deleted);
}

// ═════════════════════════════════════════════════════════════════════════════
// The scheduler
// ═════════════════════════════════════════════════════════════════════════════

export interface RollupSchedulerOptions {
  /**
   * How often to look for work. Every tenant has its own midnight, so this is
   * a poll rather than a cron: a 30-minute sweep finds each tenant's day
   * within half an hour of its own local midnight, without the server needing
   * a timer per timezone.
   */
  sweepIntervalMs?: number;
  /** Days of history the boot catch-up will fill. */
  catchUpDays?: number;
  /** Run the catch-up as soon as start() is called. */
  runOnBoot?: boolean;
  /** Rows older than this are pruned once a day. */
  retentionDays?: number;
  /** Where the job reports itself. Defaults to console. */
  logger?: { info: (message: string) => void; error: (message: string) => void };
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let started = false;
let sweepInFlight = false;
let lastPruneDay = '';

const DEFAULTS: Required<Omit<RollupSchedulerOptions, 'logger'>> = {
  sweepIntervalMs: 30 * 60 * 1000,
  catchUpDays: 7,
  runOnBoot: true,
  retentionDays: 730,
};

/**
 * Start the rollup.
 *
 * Safe to call twice — the second call is a no-op rather than a second timer,
 * because two schedulers writing the same rows is only harmless by accident
 * (the upsert saves it) and doubles the load for nothing.
 */
export function start(options: RollupSchedulerOptions = {}): void {
  if (started) return;

  const config = { ...DEFAULTS, ...options };
  const log = options.logger ?? {
    // eslint-disable-next-line no-console
    info: (message: string) => console.log(`[rollup] ${message}`),
    // eslint-disable-next-line no-console
    error: (message: string) => console.error(`[rollup] ${message}`),
  };

  started = true;
  running = true;

  const sweep = async (): Promise<void> => {
    if (!running || sweepInFlight) return;
    sweepInFlight = true;
    try {
      const results = await catchUpAllTenants(config.catchUpDays);
      const rows = results.reduce((sum, result) => sum + result.rowsWritten, 0);
      const errors = results.reduce((sum, result) => sum + result.errors.length, 0);
      if (results.length > 0) {
        log.info(`${results.length} tenant-day(s) rolled up, ${rows} row(s) written, ${errors} error(s).`);
      }
      for (const result of results) {
        for (const failure of result.errors) {
          log.error(`tenant ${result.tenantId} ${result.day} ${failure.metric}: ${failure.message}`);
        }
      }

      // Prune at most once per UTC day; it is cheap but it is a full-table
      // predicate and there is no reason to run it every half hour.
      const today = new Date().toISOString().slice(0, 10);
      if (lastPruneDay !== today) {
        lastPruneDay = today;
        const pruned = await pruneOldRollups(config.retentionDays);
        if (pruned > 0) log.info(`pruned ${pruned} rollup row(s) older than ${config.retentionDays} days.`);
      }
    } catch (error) {
      log.error(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      sweepInFlight = false;
    }
  };

  timer = setInterval(() => { void sweep(); }, config.sweepIntervalMs);
  // Never hold the process open for a background metric job.
  if (typeof timer.unref === 'function') timer.unref();

  if (config.runOnBoot) {
    // Deferred so boot is not blocked by a catch-up over a week of history.
    setTimeout(() => { void sweep(); }, 5_000).unref?.();
  }

  log.info(`started; sweeping every ${Math.round(config.sweepIntervalMs / 60000)} minute(s).`);
}

/**
 * Stop the rollup. An in-flight sweep finishes its current tenant-day and then
 * stops between tenants, so shutdown never leaves a half-written day — the
 * upsert would make even that harmless, but "harmless" and "correct" are worth
 * keeping apart.
 */
export function stop(): void {
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}

/** Is the scheduler running? For the health endpoint. */
export function isRunning(): boolean {
  return started && running;
}

/**
 * Run one sweep immediately, outside the schedule — the "recompute now" button
 * on the reporting screen, and what tests call.
 */
export async function runOnce(options: { tenantId?: number; offsetDays?: number } = {}): Promise<RollupResult[]> {
  if (options.tenantId !== undefined) {
    return [await rollupTenantDay(options.tenantId, options.offsetDays ?? 1)];
  }
  return rollupAllTenants(options.offsetDays ?? 1);
}

// Re-exported so index.ts can hold a single handle on the job.
export const rollupService = {
  start,
  stop,
  isRunning,
  runOnce,
  rollupTenantDay,
  catchUpTenant,
  pruneOldRollups,
  ROLLUP_PLAN,
};
