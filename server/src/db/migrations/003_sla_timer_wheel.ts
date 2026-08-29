import type { Knex } from 'knex';

/**
 * 003_sla_timer_wheel.ts
 *
 * Three things `002` could not have known it needed, all of them demanded by
 * the SLA engine's two hardest requirements: "strictly event-driven, never
 * polled per ticket", and "never silently keep counting, never silently stop".
 *
 * `001` and `002` are NOT edited — they are shipped and applied. This is a new
 * file, and it is additive: every column is nullable or defaulted, so it
 * applies to a live desk with rows already in `sla_instances` without a
 * rewrite and without a lock that outlives the statement.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. `sla_instances.next_timer_at` + `timer_kind` — THE timer wheel
 * ─────────────────────────────────────────────────────────────────────────────
 * The ticker must fire timers that have come due, not scan the open desk. With
 * only `due_at` to go on, a ticker that also has to raise WARNINGS and honour
 * CALENDAR BOUNDARIES has no choice but to read every live instance every
 * minute and re-derive three instants for each of them — which is the polling
 * loop the design forbids, wearing a partial index as a disguise.
 *
 * `next_timer_at` is the single earliest instant at which this instance needs
 * attention (its breach, its warning, its next opening or closing edge, the end
 * of a maintenance window). The ticker's whole query becomes
 *
 *     WHERE next_timer_at <= now() AND status IN ('running','paused')
 *
 * against the partial index below: it returns the instances that are actually
 * due and nothing else, so an idle desk costs one empty index scan a minute
 * regardless of how many tickets are open. `timer_kind` says which of the four
 * it is, so the handler does not have to guess.
 *
 * It is a CACHE, like `due_at` and `paused_ms`: `sla_ledger` remains the truth,
 * and the nightly verifier recomputes against the ledger rather than trusting
 * any of them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. `sla_instances.warned_at` — the warning is an edge, not a level
 * ─────────────────────────────────────────────────────────────────────────────
 * `sla:warning` fires once, when the clock crosses the warn threshold. Without
 * a persisted stamp, a restart re-crosses every threshold it has already
 * crossed and every at-risk ticket on the desk re-notifies its assignee. The
 * ledger cannot carry this: `sla_ledger.event` is a CHECK-constrained list of
 * events that MOVED the clock, and a warning moves nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 3. `sla_ledger.event` gains `'note'` — the annotation that is not a repair
 * ─────────────────────────────────────────────────────────────────────────────
 * Two requirements need to write something into the ledger that changes no
 * state at all:
 *
 *   • Device-offline pausing degrades to NOT pausing when the CI state source
 *     is unreachable, and must "write a visible ledger row with reason
 *     `pause_source_unavailable`" rather than silently keep counting. A `pause`
 *     row would pause the clock — the opposite of the degradation — and a
 *     `resume` row on a running clock is simply a lie.
 *   • The nightly verifier records drift and NEVER repairs it. Writing the
 *     drift as `pause`/`resume`/`target_switch` would be a repair.
 *
 * So the constraint is dropped and re-added with `'note'` in the list. A `note`
 * row carries a `reason_code`, a `note` and the elapsed-business-ms reading at
 * the time, and is ignored by every replay: it annotates the narrative without
 * being part of it. `UNIQUE(instance_id, event, at)` still applies, so a
 * repeated annotation at the same instant collapses instead of accumulating.
 *
 * Dropping and re-adding a CHECK in a NEW migration is not "editing 002" — the
 * shipped file stays exactly as it was, and the schema's history reads as the
 * sequence of decisions that actually happened.
 */

const LEDGER_EVENTS = [
  'start',
  'pause',
  'resume',
  'target_switch',
  'breach',
  'met',
  'cancel',
  // New in 003. See the header — an annotation, never a state change.
  'note',
] as const;

const LEDGER_EVENTS_002 = [
  'start',
  'pause',
  'resume',
  'target_switch',
  'breach',
  'met',
  'cancel',
] as const;

function inList(col: string, values: readonly string[]): string {
  return `"${col}" IN (${values.map((v) => `'${v}'`).join(', ')})`;
}

export async function up(knex: Knex): Promise<void> {
  // ── 1 + 2: the wheel and the warning edge ──────────────────────────────────
  const hasTimer = await knex.schema.hasColumn('sla_instances', 'next_timer_at');
  if (!hasTimer) {
    await knex.schema.alterTable('sla_instances', (t) => {
      t.timestamp('next_timer_at', { useTz: true }).nullable().comment(
        'Earliest instant this clock needs attention: breach, warning, calendar ' +
          'boundary or maintenance edge. THE ticker\'s only scan key — a cache ' +
          'over sla_ledger, never a source of truth.',
      );
      t.string('timer_kind', 16).nullable().comment('breach | warn | boundary | resume');
      t.timestamp('warned_at', { useTz: true }).nullable().comment(
        'When SOCKET_EVENTS.slaWarning last fired for this clock. Persisted so a ' +
          'restart does not re-warn every at-risk ticket on the desk.',
      );
    });
  }

  await knex.schema.raw(
    `ALTER TABLE "sla_instances" DROP CONSTRAINT IF EXISTS sla_instances_timer_kind_ck`,
  );
  await knex.schema.raw(
    `ALTER TABLE "sla_instances" ADD CONSTRAINT sla_instances_timer_kind_ck ` +
      `CHECK (timer_kind IS NULL OR ${inList('timer_kind', ['breach', 'warn', 'boundary', 'resume'])})`,
  );

  // The ticker's index. Partial on both axes: only LIVE clocks, and only those
  // that have actually armed a timer. A desk whose every clock is far from any
  // edge keeps this index nearly empty, which is the point.
  await knex.schema.raw(
    `CREATE INDEX IF NOT EXISTS sla_instances_timer_due
       ON sla_instances (next_timer_at)
       WHERE next_timer_at IS NOT NULL AND status IN ('running', 'paused')`,
  );

  // The Shift Board's "breaching soon" read, tenant-first because that query
  // always names a tenant (HARD RULE 1) while the ticker's above never can.
  //
  // `breached` is in the predicate on purpose: 002's `sla_instances_due_scan`
  // covers `status = 'running'` only, and the board's default view is
  // "everything about to be late PLUS everything already late" — a board that
  // hid the tickets that have already breached would be hiding exactly the
  // ones somebody needs to pick up.
  await knex.schema.raw(
    `CREATE INDEX IF NOT EXISTS sla_instances_at_risk
       ON sla_instances (tenant_id, due_at)
       WHERE status IN ('running', 'paused', 'breached')`,
  );

  // ── 3: the annotation event ────────────────────────────────────────────────
  await knex.schema.raw('ALTER TABLE "sla_ledger" DROP CONSTRAINT IF EXISTS sla_ledger_event_ck');
  await knex.schema.raw(
    `ALTER TABLE "sla_ledger" ADD CONSTRAINT sla_ledger_event_ck CHECK (${inList(
      'event',
      LEDGER_EVENTS,
    )})`,
  );
}

export async function down(knex: Knex): Promise<void> {
  // Annotations are not state, so deleting them loses no clock history — but a
  // constraint that rejects rows already in the table would make `down()` fail
  // and leave the schema half-reverted, which is worse than losing an
  // annotation nobody replays.
  await knex('sla_ledger').where('event', 'note').del();

  await knex.schema.raw('ALTER TABLE "sla_ledger" DROP CONSTRAINT IF EXISTS sla_ledger_event_ck');
  await knex.schema.raw(
    `ALTER TABLE "sla_ledger" ADD CONSTRAINT sla_ledger_event_ck CHECK (${inList(
      'event',
      LEDGER_EVENTS_002,
    )})`,
  );

  await knex.schema.raw('DROP INDEX IF EXISTS sla_instances_at_risk');
  await knex.schema.raw('DROP INDEX IF EXISTS sla_instances_timer_due');
  await knex.schema.raw(
    'ALTER TABLE "sla_instances" DROP CONSTRAINT IF EXISTS sla_instances_timer_kind_ck',
  );

  const hasTimer = await knex.schema.hasColumn('sla_instances', 'next_timer_at');
  if (hasTimer) {
    await knex.schema.alterTable('sla_instances', (t) => {
      t.dropColumn('next_timer_at');
      t.dropColumn('timer_kind');
      t.dropColumn('warned_at');
    });
  }
}
