import type { Knex } from 'knex';

import { seed as seedCore } from './01_core';
import { seed as seedBaselineConfig } from './02_baseline_config';

export {
  DEFAULT_TENANT_SLUG,
  DEFAULT_TENANT_NAME,
  DEFAULT_ASSIGNMENT_GROUP_SLUG,
  DEFAULT_TICKET_PREFIX,
} from './01_core';

export {
  BASELINE_OBJECTS,
  BODY_FORMAT_VERSIONS,
  checksumOf,
} from './02_baseline_config';

// ConditionNode / Operator are NOT re-exported from here any more: they belong to
// @oblidesk/shared, and the seed bundle now imports them from there. Re-exporting
// a second copy is what let the two shapes drift apart in the first place.
export type { ConfigKind } from './02_baseline_config';
export type { ConditionNode, Operator } from '@oblidesk/shared';

/**
 * seeds/index.ts — the programmatic entry point for the Oblidesk seed bundle.
 *
 * There are two ways the seeds run and they must never fight:
 *
 *   • `knex seed:run` executes every file in this directory in ALPHABETICAL
 *     order — 01_core.ts, then 02_baseline_config.ts, then this file.
 *   • The server bootstrap calls `runSeeds(db)` below, which runs the same two
 *     in the same order.
 *
 * Which is why the `seed` export here is deliberately a NO-OP: if it delegated
 * to runSeeds(), a `knex seed:run` would execute the whole bundle twice. Both
 * seeds are idempotent so that would be harmless, but "harmless" is not a
 * reason to do a thing twice.
 */
export async function runSeeds(knex: Knex): Promise<void> {
  // Order is load-bearing: 02 looks the default tenant up by slug and refuses
  // to run without it.
  await seedCore(knex);
  await seedBaselineConfig(knex);
}

export { seedCore, seedBaselineConfig };

/**
 * Knex seed-file contract. Intentionally does nothing — see the note above.
 * `knex` is accepted so the signature matches what the seeder expects.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function seed(_knex: Knex): Promise<void> {
  // No-op. 01_core.ts and 02_baseline_config.ts have already run by the time
  // the seeder reaches this file.
}
