/**
 * env.ts — environment bootstrap.
 *
 * This module has ONE job: load `server/.env` into `process.env` before any
 * other module reads a variable. It must therefore be the FIRST import of
 * every entrypoint:
 *
 *   server/src/index.ts   → import './env';
 *   server/knexfile.ts    → import './src/env';
 *
 * Importing it anywhere else is harmless (dotenv is idempotent and never
 * overwrites variables that are already set — in Docker the real values come
 * from the container environment and the .env file simply does not exist).
 *
 * Do NOT put typed config here; `src/config.ts` owns the typed view of the
 * environment. Keeping this file a single side effect is what guarantees the
 * ordering above stays correct.
 */
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
