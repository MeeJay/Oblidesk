/**
 * system.routes.ts — "what is this install, and is it healthy?"
 *
 * Two audiences, two levels of detail:
 *
 *   GET /api/system/version   any authenticated user. Feeds the About dialog
 *                             and the "your client is older than the server"
 *                             banner. Deliberately says nothing about the host.
 *
 *   GET /api/system           platform admins only. Node version, memory, load,
 *                             database reachability, installed extensions,
 *                             migration state, realtime stats. This is the page
 *                             an operator opens before filing a bug, so it is
 *                             worth the extra queries — but it also describes
 *                             the host, which is why it is admin-gated.
 */
import { Router, type Request, type Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import os from 'os';
import {
  APP_ACCENT_HEX,
  APP_TYPE,
  DEFAULT_LOCALE,
  SEEDED_LOCALES,
  SUPPORTED_LOCALES,
} from '@oblidesk/shared';
import { db } from '../db';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { asyncHandler } from '../utils/asyncHandler';
import { socketStatus } from '../socket';
import { presenceStats } from '../socket-handlers';

const router = Router();

/**
 * Read once at module load: `package.json` does not change while the process
 * runs, and re-reading it per request would put a synchronous file read on a
 * polled endpoint. `process.cwd()` is the server directory both under
 * `npx tsx` and in the container (WORKDIR /app/server).
 */
const serverVersion = ((): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? 'dev';
  } catch {
    return 'dev';
  }
})();

export function getServerVersion(): string {
  return serverVersion;
}

// ── GET /api/system/version — any authenticated user ─────────────────────────

router.get('/version', requireAuth, (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      app: APP_TYPE,
      name: config.appName,
      version: serverVersion,
      accent: APP_ACCENT_HEX,
      defaultLocale: DEFAULT_LOCALE,
      seededLocales: [...SEEDED_LOCALES],
      supportedLocales: [...SUPPORTED_LOCALES],
    },
  });
});

// ── GET /api/system — platform admins ────────────────────────────────────────

interface MigrationRow {
  name: string;
  batch: number;
  migration_time: Date;
}

router.get(
  '/',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (_req: Request, res: Response) => {
    const memory = process.memoryUsage();
    const [load1, load5, load15] = os.loadavg();

    // ── Database ─────────────────────────────────────────────────────────
    let database: {
      status: 'ok' | 'error';
      version: string | null;
      extensions: string[];
      lastMigration: string | null;
      migrationBatch: number | null;
      tenants: number | null;
    } = {
      status: 'error',
      version: null,
      extensions: [],
      lastMigration: null,
      migrationBatch: null,
      tenants: null,
    };

    try {
      const versionRow = (await db.raw('SELECT version() AS version')) as {
        rows: Array<{ version: string }>;
      };
      const extensionRows = (await db.raw(
        "SELECT extname FROM pg_extension WHERE extname IN ('citext','pg_trgm','unaccent') ORDER BY extname",
      )) as { rows: Array<{ extname: string }> };

      // knex_migrations and tenants are GLOBAL tables — db() is correct.
      const migration = (await db('knex_migrations')
        .orderBy('id', 'desc')
        .first('name', 'batch', 'migration_time')) as MigrationRow | undefined;
      const tenantCount = await db('tenants').count<[{ count: string }]>('* as count');

      database = {
        status: 'ok',
        version: versionRow.rows[0]?.version ?? null,
        extensions: extensionRows.rows.map((row) => row.extname),
        lastMigration: migration?.name ?? null,
        migrationBatch: migration?.batch ?? null,
        tenants: Number(tenantCount[0]?.count ?? 0),
      };
    } catch {
      // Leave the `error` shape — the point of this endpoint is to report a
      // sick database, not to fail because of one.
    }

    res.json({
      success: true,
      data: {
        app: {
          type: APP_TYPE,
          name: config.appName,
          version: serverVersion,
          accent: APP_ACCENT_HEX,
          environment: config.nodeEnv,
        },
        runtime: {
          nodeVersion: process.version,
          pid: process.pid,
          uptimeSeconds: Math.floor(process.uptime()),
          platform: os.platform(),
          arch: os.arch(),
          isDocker: existsSync('/.dockerenv'),
          customDir: config.customDir,
        },
        memory: {
          processRssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
          processHeapMb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
          systemTotalMb: Math.round(os.totalmem() / 1024 / 1024),
          systemFreeMb: Math.round(os.freemem() / 1024 / 1024),
        },
        cpu: {
          cores: os.cpus().length,
          loadAvg1: Math.round(load1 * 100) / 100,
          loadAvg5: Math.round(load5 * 100) / 100,
          loadAvg15: Math.round(load15 * 100) / 100,
        },
        database,
        realtime: { ...socketStatus(), presence: presenceStats() },
        i18n: {
          defaultLocale: DEFAULT_LOCALE,
          seeded: [...SEEDED_LOCALES],
          supported: [...SUPPORTED_LOCALES],
        },
      },
    });
  }),
);

export default router;
