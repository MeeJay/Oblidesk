/**
 * index.ts — the entrypoint. Boot order, background workers, shutdown.
 *
 * `./env` is the FIRST import and must stay that way: it loads `server/.env`
 * into `process.env`, and every module below reads its configuration at import
 * time. An import above it would capture the defaults instead.
 *
 * Boot sequence:
 *   1. migrations           knex.migrate.latest()
 *   2. seeds                only when `tenants` is empty — i.e. a fresh install
 *   3. blob store           make sure /custom/attachments exists and is writable
 *   4. HTTP server + API
 *   5. Socket.io            sharing the express session middleware
 *   6. capability schemas   published to Obligate once, fire-and-forget
 *   7. background workers   behind a Postgres advisory lock, so exactly ONE
 *                           replica runs the SLA ticker, the outbox drainer,
 *                           the rollup scheduler, the scheduled-rule sweep,
 *                           the escalation ticker and the mail workers
 *   8. listen
 *   9. graceful shutdown
 */
import './env';
import http from 'http';
import { mkdirSync } from 'fs';
import path from 'path';
import { Client as PgClient } from 'pg';

import { assertProductionConfig, config, degradedConfigWarnings } from './config';
import { db } from './db';
import { runSeeds } from './db/seeds';
import { createApp } from './app';
import { closeSocketServer, createSocketServer } from './socket';
import { logger } from './utils/logger';
import { obligateService } from './services/obligate.service';
import { outboxService } from './services/outbox.service';
import { rollupService } from './services/rollup.service';
import * as problemDetectionService from './services/problemDetection.service';
import * as changeConflictService from './services/changeConflict.service';
import * as portalService from './services/portal.service';

/** Expired magic-link tokens are litter after a day; sweep them hourly. */
const PORTAL_PRUNE_INTERVAL_MS = 3600_000;
let portalPruneTimer: NodeJS.Timeout | null = null;
import { slaTicker } from './services/sla.service';
import { ruleScheduler } from './services/rule.service';
import { escalationService } from './services/escalation.service';
import { inboundService } from './services/mail/inbound.service';
import { outboundService } from './services/mail/outbound.service';

// ═════════════════════════════════════════════════════════════════════════════
// Background workers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The shape every worker in `src/services/` presents to this file.
 *
 * They were once loaded by NAME through a dynamic import, because the engine
 * modules were written separately from this one and might not exist yet. They
 * all exist now, so every one of them is a LITERAL import: TypeScript then
 * checks that `start()` and `stop()` are really there, and a rename breaks the
 * build instead of silently logging "exports no { start() } worker" into a log
 * nobody reads — which is the same reason `outboxService` and `rollupService`
 * were always imported this way.
 *
 * Importing `rule.service` here has a second effect worth naming: the bottom of
 * that module calls `installRulesEngine()` at import time, so the rules engine
 * is installed on EVERY replica, including one running with
 * DISABLE_BACKGROUND_WORKERS. That is correct — the engine runs inline on the
 * request path; only the SCHEDULED sweep below belongs to the leader.
 */
interface BackgroundWorker {
  start(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

/**
 * Start one worker and register it for shutdown, swallowing a failed start.
 *
 * The guard matters more than it looks. `startWorkers()` is awaited BEFORE
 * `server.listen()`, so an exception from any single `start()` would propagate
 * out through the leader lock and `main()` and reach the `process.exit(1)` at
 * the bottom of this file — a desk that will not serve a login page because
 * the rollup scheduler could not read a table. Every worker is optional to
 * BOOTING even though none of them is optional to running well, so a failure
 * here logs loudly and the next worker still gets its turn.
 *
 * Only a worker that actually started is pushed onto `workers`, so shutdown
 * never calls `stop()` on something that never ran.
 */
async function startWorker(
  worker: BackgroundWorker,
  label: string,
  registry: BackgroundWorker[],
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    await worker.start();
    registry.push(worker);
    logger.info(details, `${label} started`);
  } catch (err) {
    logger.error({ err }, `${label} failed to start — the server continues without it`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Leader election — one ticker per cluster
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The SLA ticker and the outbox drainer must run on exactly ONE replica.
 *
 * Two replicas ticking means a breach is evaluated twice, two `decision_log`
 * rows are written for one decision (HARD RULE 2 says the row explains the
 * action — two rows for one action is a lie about what happened), and the
 * outbox sends every notification twice.
 *
 * A Postgres session-level advisory lock is the right tool: it needs no table,
 * no heartbeat and no lease arithmetic, and — the part that matters — it is
 * released automatically when the connection dies. A replica that is SIGKILLed
 * or loses its network hands leadership over within one TCP timeout, with no
 * stale-lock cleanup to write and get wrong.
 *
 * It gets its OWN connection, outside the knex pool: the lock lives as long as
 * the session holding it, so it must never be a pooled connection that knex can
 * hand to somebody else's query and then recycle.
 */
const ADVISORY_LOCK_CLASS = 0x0b11de5c; // "0B11DE5C" — Oblidesk, in a fit of whimsy
const ADVISORY_LOCK_OBJECT = 1; // 1 = background workers

class LeaderLock {
  private client: PgClient | null = null;
  private held = false;
  private retry: NodeJS.Timeout | null = null;

  constructor(private readonly onElected: () => Promise<void>) {}

  async tryAcquire(): Promise<boolean> {
    if (this.held) return true;
    try {
      if (!this.client) {
        this.client = new PgClient({
          connectionString: config.databaseUrl,
          application_name: 'oblidesk-leader',
        });
        this.client.on('error', (err: Error) => {
          // The connection died; leadership went with it. Drop everything and
          // let the retry timer contest the lock again.
          logger.warn({ err: err.message }, 'Leader lock connection lost — will re-contest');
          this.held = false;
          this.client = null;
        });
        await this.client.connect();
      }

      const result = await this.client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [ADVISORY_LOCK_CLASS, ADVISORY_LOCK_OBJECT],
      );
      this.held = result.rows[0]?.locked === true;
      return this.held;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Leader lock acquisition failed');
      this.held = false;
      return false;
    }
  }

  /**
   * Acquire now if possible; otherwise keep contesting in the background so a
   * standby replica picks up the work the moment the leader goes away.
   */
  async start(): Promise<void> {
    if (await this.tryAcquire()) {
      logger.info('Elected leader — starting background workers');
      await this.onElected();
      return;
    }

    logger.info(
      { retryMs: config.leaderRetryIntervalMs },
      'Another replica holds the worker lock — standing by',
    );
    this.retry = setInterval(() => {
      void this.tryAcquire().then(async (won) => {
        if (!won) return;
        if (this.retry) {
          clearInterval(this.retry);
          this.retry = null;
        }
        logger.info('Took over as leader — starting background workers');
        await this.onElected();
      });
    }, config.leaderRetryIntervalMs);
    this.retry.unref();
  }

  async release(): Promise<void> {
    if (this.retry) {
      clearInterval(this.retry);
      this.retry = null;
    }
    if (!this.client) return;
    try {
      if (this.held) {
        await this.client.query('SELECT pg_advisory_unlock($1, $2)', [
          ADVISORY_LOCK_CLASS,
          ADVISORY_LOCK_OBJECT,
        ]);
      }
      await this.client.end();
    } catch {
      // Shutting down; the connection closing releases the lock regardless.
    }
    this.client = null;
    this.held = false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Boot
// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // ── 0. Configuration gate — BEFORE anything writes ───────────────────────
  // This has to run first, and the reason is not style. It used to live in
  // createApp(), which runs after migrations and seeding: on a fresh
  // production install the bootstrap admin was created with the shipped
  // password, and only THEN did the check refuse to boot — telling the
  // operator to "set it before the first boot creates the bootstrap admin",
  // which had already happened. A guard that fires after the thing it guards
  // is not a guard; it is a crash loop that also lies.
  assertProductionConfig();
  for (const warning of degradedConfigWarnings()) logger.warn(warning);

  // ── 1. Migrations ────────────────────────────────────────────────────────
  logger.info('Running database migrations…');
  const [batch, applied] = (await db.migrate.latest()) as [number, string[]];
  if (applied.length > 0) {
    logger.info({ batch, applied }, `Applied ${applied.length} migration(s)`);
  } else {
    logger.info('Database schema is up to date');
  }

  // ── 2. Seeds — only on a genuinely empty install ─────────────────────────
  // `tenants` is the marker because every other seeded object hangs off a
  // tenant. Re-running seeds on a live desk is safe (they are idempotent) but
  // it is also pointless work on every boot, and "safe" is not a reason.
  const [{ count }] = await db('tenants').count<[{ count: string }]>('* as count');
  if (Number(count) === 0) {
    logger.info('No tenants found — seeding the baseline configuration');
    await runSeeds(db);
    logger.info('Seed complete');
  }

  // ── 2b. Demonstration data ───────────────────────────────────────────────
  // Reconciles the demo tenant with DEMO_DATA. Runs after the seeds so the
  // baseline config exists, and before anything serves traffic. Never throws.
  const { demoDataService } = await import('./services/demoData.service');
  await demoDataService.reconcile();

  // ── 3. Blob store (HARD RULE 9) ──────────────────────────────────────────
  // Fail soft: a read-only /custom must not stop the desk from serving
  // tickets, but the operator needs to know before the first upload fails.
  try {
    mkdirSync(path.join(config.customDir, 'attachments'), { recursive: true });
  } catch (err) {
    logger.error(
      { err, customDir: config.customDir },
      'Could not create the attachment directory — uploads will fail until this is fixed',
    );
  }

  // ── 4. HTTP + API ────────────────────────────────────────────────────────
  const { app, sessionMiddleware } = createApp();
  const server = http.createServer(app);

  // ── 5. Realtime ──────────────────────────────────────────────────────────
  const io = createSocketServer(server, sessionMiddleware);
  // Routes reach the io instance through the app, so a route file never has to
  // import the socket module (and never has to care whether it started).
  app.set('io', io);

  // ── 6. Capability schemas ────────────────────────────────────────────────
  // Tell Obligate which capabilities this desk understands, so the identity
  // side can offer them when someone edits a role. Deliberately NOT awaited:
  // it is a call to another service over the network, and a slow or missing
  // Obligate must delay the login page by exactly zero milliseconds. It is
  // also not gated on the leader lock — the push is idempotent, and a standby
  // replica that never wins the lock would otherwise never publish anything.
  //
  // `.catch()` is the whole error policy on purpose. Out-of-date capability
  // metadata in Obligate is a cosmetic problem in someone else's admin screen;
  // it is not a reason for this process to be anything other than fine.
  void obligateService.syncCapabilitySchemas().catch((err: unknown) => {
    logger.warn(
      { err: (err as Error).message },
      'Could not publish capability schemas to Obligate — roles there may list stale capabilities',
    );
  });

  // ── 7. Background workers, behind the leader lock ────────────────────────
  const workers: BackgroundWorker[] = [];

  const startWorkers = async (): Promise<void> => {
    // The SLA ticker. `start()` is called with no arguments, so its interval
    // falls back to `config.slaTickIntervalMs` inside the service — the detail
    // below is what the log line reports, not what is passed.
    await startWorker(
      slaTicker,
      'SLA ticker',
      workers,
      { intervalMs: config.slaTickIntervalMs },
    );

    await startWorker(
      outboxService,
      'Outbox worker',
      workers,
      { intervalMs: config.outboxIntervalMs },
    );

    // The rollup owns its own 30-minute sweep and boot catch-up. It is adapted
    // rather than passed straight through so the scheduler reports into the
    // app's structured logger instead of its `console` default.
    await startWorker(
      {
        start: () =>
          rollupService.start({
            logger: {
              info: (message: string) => logger.info(message),
              error: (message: string) => logger.error(message),
            },
          }),
        stop: () => rollupService.stop(),
      },
      'Rollup scheduler',
      workers,
    );

    // The scheduled-rule sweep — the ONLY thing that asks "has a `trigger:
    // schedule` rule come due?". Without it the seeded `escalate_p1_after_15m`
    // never fires at all, because nothing on the request path can notice the
    // passage of time. Adapted rather than passed straight through so the
    // interval comes from `config` (this file's contract is that config.ts is
    // the one module that reads `process.env`) instead of from the service's
    // own env fallback.
    //
    // It belongs under the leader lock: two replicas sweeping means every
    // escalation the sweep triggers fires twice.
    await startWorker(
      {
        start: () => ruleScheduler.start({ intervalMs: config.ruleScheduleIntervalMs }),
        stop: () => ruleScheduler.stop(),
      },
      'Rule scheduler',
      workers,
      { intervalMs: config.ruleScheduleIntervalMs },
    );

    // Portal magic-link housekeeping. Used and expired tokens are evidence for
    // a day and litter afterwards, and `pruneTokens` was written to say so and
    // then never called: the table grew for the life of the install, and the
    // index behind every sign-in grew with it. Hourly is generous for a row
    // that lives fifteen minutes.
    await startWorker(
      {
        start: () => {
          portalPruneTimer = setInterval(() => {
            void portalService
              .pruneTokens()
              .then((deleted) => {
                if (deleted > 0) logger.info({ deleted }, 'portal: expired login tokens pruned');
              })
              .catch((err: unknown) => logger.warn({ err }, 'portal: token prune failed'));
          }, PORTAL_PRUNE_INTERVAL_MS);
          portalPruneTimer.unref();
        },
        stop: () => {
          if (portalPruneTimer) clearInterval(portalPruneTimer);
          portalPruneTimer = null;
        },
      },
      'Portal token prune',
      workers,
      { intervalMs: PORTAL_PRUNE_INTERVAL_MS },
    );

    // The recurrence detector: the ONLY thing that asks "do these incidents
    // tell one story?". Without it the module still works by hand, but its
    // whole point — noticing before a human does — never happens, and the
    // candidate inbox stays permanently empty with nothing to explain why.
    //
    // Under the leader lock like every other sweep: two replicas detecting
    // means the same recurrence proposed twice, and a candidate proposed twice
    // is a candidate nobody trusts.
    await startWorker(
      {
        start: () => problemDetectionService.startSweeper(),
        stop: () => problemDetectionService.stopSweeper(),
      },
      'Problem detector',
      workers,
    );

    // The change conflict sweeper: the ONLY thing that notices that two changes
    // booked the same switch for Thursday night, or that a freeze came into
    // force over a window somebody scheduled last month. The planning path
    // answers for whichever change is open on somebody's screen; without this
    // pass, every OTHER change's panel is frozen at whatever it said the last
    // time a human touched it — and a conflict panel that is only correct for
    // the change you are looking at is a conflict panel nobody can trust.
    //
    // ONE TICK, TWO JOBS: the same pass also stamps overdue
    // post-implementation reviews and arms their escalation ladder. Both are
    // five-minute questions over the same table, and an eighth worker for the
    // second one would buy nothing.
    //
    // EVERY TENANT IS SWEPT, including one that never published a
    // `change_policy` — it runs on the shipped baseline, stamped version 0. A
    // sweeper whose tenant selection requires a config object is a sweeper that
    // runs empty for the life of the install, which is exactly the defect the
    // problem module shipped and had to have found for it.
    //
    // Under the leader lock like every other sweep: two replicas would race
    // each other into `change_conflicts_live_uq` on every pass, and both would
    // stamp `pir_overdue_notified_at` while only one of them sent the notice.
    await startWorker(
      {
        start: () => changeConflictService.startSweeper(),
        stop: () => changeConflictService.stopSweeper(),
      },
      'Change conflict sweeper',
      workers,
    );

    // The escalation ticker: armed ladders whose next step has come due, plus
    // state-triggered ladders. The APPROVAL timeout and reminder sweeps ride
    // this same tick, so this is the only extra worker the approval engine
    // needs — there is no separate approval worker to start.
    await startWorker(
      escalationService,
      'Escalation ticker',
      workers,
      { intervalMs: config.slaTickIntervalMs },
    );

    // Mail, both directions.
    //   inbound   reconciles one IMAP connection per active mailbox from
    //             `mail_accounts`; IDLE does the collecting between passes, so
    //             this timer is a reconcile, not a poll of the mail server.
    //   outbound  drains replies whose delivery is still pending after a
    //             transient SMTP failure. Without it a temporary failure is a
    //             permanent one until an admin presses "retry now" in the
    //             channel console.
    await startWorker(inboundService.worker, 'Inbound mail poller', workers);
    await startWorker(outboundService.worker, 'Outbound mail drain', workers);
  };

  const leader = new LeaderLock(startWorkers);
  if (config.disableBackgroundWorkers) {
    logger.warn('DISABLE_BACKGROUND_WORKERS is set — this replica will not tick SLAs or send mail');
  } else {
    await leader.start();
  }

  // ── 8. Listen ────────────────────────────────────────────────────────────
  server.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.nodeEnv, clientOrigin: config.clientOrigin },
      `${config.appName} server listening on port ${config.port}`,
    );
  });

  // ── 9. Graceful shutdown ─────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // a second Ctrl-C must not race the first
    shuttingDown = true;
    logger.info(`Received ${signal} — shutting down`);

    // Last resort. A stuck close() must not hold the container hostage while
    // the orchestrator waits to SIGKILL us anyway.
    const hardExit = setTimeout(() => {
      logger.warn('Shutdown: forcing exit after 10s');
      process.exit(0);
    }, 10_000);
    hardExit.unref();

    // Stop accepting work before tearing anything down.
    server.close();

    for (const worker of workers) {
      try {
        await worker.stop?.();
      } catch (err) {
        logger.warn({ err }, 'Worker stop failed');
      }
    }

    await closeSocketServer();
    // Release leadership explicitly so a standby takes over immediately rather
    // than after the TCP timeout.
    await leader.release();

    // The pool goes last. Any in-flight query is aborted here — expected on
    // shutdown — so swallow the rejection rather than letting it escape and
    // crash the process one line before a clean exit.
    try {
      await db.destroy();
    } catch (err) {
      logger.warn({ err }, 'Shutdown: db.destroy() aborted in-flight queries (expected)');
    }

    clearTimeout(hardExit);
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Safety nets.
  //   unhandledRejection — usually one recoverable operation; log and keep
  //     serving, because taking the whole desk down over a failed webhook is
  //     the worse outcome.
  //   uncaughtException — the process state is now unknown. Log and exit so
  //     Docker's restart policy gives us a clean one.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection (server kept running)');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal(err, 'Uncaught exception — exiting for a clean restart');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal(err, 'Failed to start the Oblidesk server');
  process.exit(1);
});
