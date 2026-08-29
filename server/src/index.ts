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
 *                           replica runs the SLA ticker, the outbox drainer
 *                           and the rollup scheduler
 *   8. listen
 *   9. graceful shutdown
 */
import './env';
import http from 'http';
import { mkdirSync } from 'fs';
import path from 'path';
import { Client as PgClient } from 'pg';

import { config } from './config';
import { db } from './db';
import { runSeeds } from './db/seeds';
import { createApp } from './app';
import { closeSocketServer, createSocketServer } from './socket';
import { logger } from './utils/logger';
import { obligateService } from './services/obligate.service';
import { outboxService } from './services/outbox.service';
import { rollupService } from './services/rollup.service';

// ═════════════════════════════════════════════════════════════════════════════
// Background workers — owned by other modules, loaded defensively
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The SLA ticker and the notification-outbox drainer live in `src/services/`,
 * which is written separately from this file. They are therefore loaded through
 * a dynamic import wrapped in try/catch against this minimal interface: if the
 * module is not there yet, the server logs one line and boots anyway.
 *
 * That is deliberate. A server that refuses to start because an engine module
 * is missing gives the operator a stack trace where they wanted a login page,
 * and gives whoever is mid-refactor an unbootable tree. Real-time SLA warnings
 * degrade; the desk keeps working.
 */
interface BackgroundWorker {
  start(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

function looksLikeWorker(value: unknown): value is BackgroundWorker {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BackgroundWorker).start === 'function'
  );
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
  worker: BackgroundWorker | null,
  label: string,
  registry: BackgroundWorker[],
  details: Record<string, unknown> = {},
): Promise<void> {
  if (!worker) return;
  try {
    await worker.start();
    registry.push(worker);
    logger.info(details, `${label} started`);
  } catch (err) {
    logger.error({ err }, `${label} failed to start — the server continues without it`);
  }
}

/**
 * Load a worker from `moduleSpec`, preferring the named exports listed. The
 * specifier is held in a variable on purpose: with a string literal TypeScript
 * would resolve the module at compile time and fail the build for a file that
 * does not exist yet, which is exactly the coupling this is avoiding.
 */
async function loadWorker(
  moduleSpec: string,
  exportNames: readonly string[],
  label: string,
): Promise<BackgroundWorker | null> {
  try {
    const loaded = (await import(moduleSpec)) as Record<string, unknown>;
    for (const name of exportNames) {
      if (looksLikeWorker(loaded[name])) return loaded[name] as BackgroundWorker;
    }
    if (looksLikeWorker(loaded.default)) return loaded.default as BackgroundWorker;

    logger.warn(
      { module: moduleSpec, tried: exportNames },
      `${label}: module loaded but exports no { start() } worker — skipping`,
    );
    return null;
  } catch (err) {
    logger.warn(
      { module: moduleSpec, err: (err as Error).message },
      `${label}: not available yet — the server will run without it`,
    );
    return null;
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
    // The SLA ticker is the one worker still loaded by name: `sla.service.ts`
    // is not written yet, so a literal `import()` would fail the BUILD rather
    // than degrade at runtime, which is the whole point of `loadWorker`.
    await startWorker(
      await loadWorker(
        './services/sla.service',
        ['slaTicker', 'slaEngine', 'slaService'],
        'SLA ticker',
      ),
      'SLA ticker',
      workers,
      { intervalMs: config.slaTickIntervalMs },
    );

    // The outbox drainer and the rollup scheduler DO exist, so they are
    // imported by literal specifier: TypeScript then checks that `start()` and
    // `stop()` are really there, and a rename breaks the build instead of
    // silently logging "exports no { start() } worker" into a log nobody reads.
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
