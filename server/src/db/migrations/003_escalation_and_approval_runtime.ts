import type { Knex } from 'knex';

/**
 * 003_escalation_and_approval_runtime.ts
 *
 * Additive only. 001 and 002 are never edited (they are the shipped baseline
 * this instance already ran); everything here is new tables plus new NULLABLE
 * columns on two existing ones, so an existing database migrates forward with
 * no rewrite and no data loss.
 *
 * ── Why these tables exist ──────────────────────────────────────────────────
 *
 * 002 gave the desk `approvals` + `approval_steps` — the RESULT of an approval
 * — but nothing that carries an escalation ladder's RUNTIME, and nothing that
 * makes either engine idempotent under a ticker that fires twice.
 *
 * `escalation_runs` / `escalation_fires` close that hole:
 *
 *   escalation_runs   one armed ladder for one ticket, for one OCCURRENCE of
 *                     its trigger. UNIQUE(tenant, ticket, ladder, occurrence)
 *                     is what makes arming idempotent: an SLA warning
 *                     re-delivered by a retrying ticker arms nothing new.
 *
 *   escalation_fires  one row per (run, step, repeat) that actually fired.
 *                     UNIQUE(run_id, step_index, repeat_index) is THE guard
 *                     against the classic bug — the ticker runs twice, the
 *                     same step notifies the on-call engineer twice at 03:00,
 *                     and nobody trusts the pager again. The engine CLAIMS the
 *                     row with `ON CONFLICT DO NOTHING RETURNING id` inside the
 *                     same transaction as the notification, so a claim that
 *                     returns nothing means "someone else already fired this"
 *                     and a transaction that rolls back releases the claim with
 *                     it. Read-then-write cannot give that; a unique index can.
 *
 * ── Why the new approval columns exist ──────────────────────────────────────
 *
 *   approvals.definition_version   the config version the approval STARTED
 *   approvals.spec                 the resolved stage specs, snapshotted
 *
 *     An approval's aggregate state is recomputed from its steps. Recomputing
 *     it against a definition that has been republished mid-flight silently
 *     changes the rules of an approval already in progress — a two-of-three
 *     quorum becomes three-of-three between the second approval and the third.
 *     Pinning the version and snapshotting the spec makes every recomputation
 *     replayable against the body that was in force when the ticket entered it.
 *
 *   approval_steps.due_at          per-STAGE deadline
 *
 *     `approvals.due_at` is one column, and a sequential approval has one
 *     deadline per stage. Without this, stage two of a three-stage approval
 *     has no timeout at all, which is the exact "stuck for three weeks"
 *     failure the timeout requirement exists to prevent.
 *
 *   approval_steps.timed_out_at    the timeout fired, once
 *   approval_steps.reminded_at     the last reminder went out
 *   approval_steps.decided_by_user_id / delegated_from_user_id
 *
 *     `approver_user_id` is who was ASKED. After a delegation that is no longer
 *     who ANSWERED, and an approval trail that cannot tell the two apart is not
 *     an audit trail.
 */

function inList(col: string, values: readonly string[]): string {
  return `"${col}" IN (${values.map((v) => `'${v}'`).join(', ')})`;
}

export async function up(knex: Knex): Promise<void> {
  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — Escalation runtime
  // ══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('escalation_runs', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');

    t.specificType('ladder_slug', 'citext').notNullable()
      .comment('config_objects(kind=escalation).slug. HARD RULE 3 — by slug, never by id.');
    t.integer('ladder_version').notNullable().defaultTo(1)
      .comment('The published version armed. Pins the ladder a run replays against.');

    t.string('trigger', 24).notNullable()
      .comment('sla_warning | sla_breach | no_update | unassigned | reopened | priority | manual');

    /**
     * What made THIS arming distinct from the last one. Two examples:
     *   'sla:1841:warning'          the warning of one SLA instance
     *   'no_update:2026-08-29T09:14:02.000Z'  a specific "last update" instant
     * Re-arming with the same key is a no-op; a NEW key (a fresh update landed)
     * supersedes the old run.
     */
    t.string('occurrence_key', 160).notNullable();

    t.string('state', 12).notNullable().defaultTo('armed');

    t.timestamp('armed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('anchor_at', { useTz: true }).notNullable()
      .comment('The instant step offsets are measured from — the trigger, not the arming.');

    t.specificType('calendar_slug', 'citext').nullable()
      .comment('Business calendar the offsets are measured on. NULL = 24x7.');

    // Precomputed wake-up, so the sweep is an index range scan rather than an
    // evaluation of every armed run on every tick.
    t.timestamp('next_due_at', { useTz: true }).nullable();
    t.integer('next_step_index').notNullable().defaultTo(0);
    t.integer('next_repeat_index').notNullable().defaultTo(0);

    t.jsonb('context').notNullable().defaultTo(knex.raw("'{}'::jsonb"))
      .comment('What triggered it: sla instance id, target slug, previous priority…');

    t.timestamp('closed_at', { useTz: true }).nullable();
    t.string('close_reason', 32).nullable()
      .comment('completed | stopped | cancelled | ticket_closed | ladder_gone | superseded');

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(
    `ALTER TABLE "escalation_runs" ADD CONSTRAINT escalation_runs_state_ck CHECK (${inList('state', [
      'armed', 'completed', 'stopped', 'cancelled',
    ])})`,
  );

  // THE arming idempotency guard.
  await knex.schema.raw(
    'CREATE UNIQUE INDEX escalation_runs_occurrence_uq ' +
    'ON escalation_runs (tenant_id, ticket_id, ladder_slug, occurrence_key)',
  );
  // The sweep's only hot query.
  await knex.schema.raw(
    "CREATE INDEX escalation_runs_due ON escalation_runs (tenant_id, next_due_at) " +
    "WHERE state = 'armed'",
  );
  await knex.schema.raw('CREATE INDEX escalation_runs_ticket ON escalation_runs (ticket_id, armed_at DESC)');
  await knex.schema.raw(
    "CREATE INDEX escalation_runs_ladder ON escalation_runs (tenant_id, ladder_slug) WHERE state = 'armed'",
  );
  await knex.schema.raw(
    `COMMENT ON TABLE escalation_runs IS
     'One armed escalation ladder, for one ticket, for one occurrence of its trigger. UNIQUE(tenant_id, ticket_id, ladder_slug, occurrence_key) makes arming idempotent.'`,
  );

  await knex.schema.createTable('escalation_fires', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('run_id').notNullable()
      .references('id').inTable('escalation_runs').onDelete('CASCADE');
    t.integer('ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');

    t.integer('step_index').notNullable();
    t.integer('repeat_index').notNullable().defaultTo(0);

    t.timestamp('due_at', { useTz: true }).nullable().comment('When it was SUPPOSED to fire.');
    t.timestamp('fired_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.jsonb('notified').notNullable().defaultTo(knex.raw("'[]'::jsonb"))
      .comment('Resolved recipients: [{ kind, ref, userId, username }]. Replayable.');
    t.jsonb('actions').notNullable().defaultTo(knex.raw("'[]'::jsonb"))
      .comment('Rule actions the step asked for, and what happened to each.');

    t.bigInteger('decision_log_id').nullable()
      .comment('The decision_log row this fire wrote. No FK — decision_log outlives purges.');
    t.text('error').nullable();
  });

  // THE step idempotency guard: one fire per (run, step, repeat), forever.
  await knex.schema.raw(
    'ALTER TABLE "escalation_fires" ADD CONSTRAINT escalation_fires_once_uq ' +
    'UNIQUE (run_id, step_index, repeat_index)',
  );
  await knex.schema.raw(
    'CREATE INDEX escalation_fires_ticket ON escalation_fires (tenant_id, ticket_id, fired_at DESC)',
  );
  await knex.schema.raw(
    `COMMENT ON TABLE escalation_fires IS
     'One row per escalation step that actually fired. UNIQUE(run_id, step_index, repeat_index) is claimed inside the notifying transaction, so a ticker that runs twice notifies once.'`,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — Approval runtime (additive columns only)
  // ══════════════════════════════════════════════════════════════════════════

  await knex.schema.alterTable('approvals', (t) => {
    t.integer('definition_version').nullable()
      .comment('config_objects.version of the approval definition when this started.');
    t.jsonb('spec').notNullable().defaultTo(knex.raw("'{}'::jsonb"))
      .comment(
        'Snapshot of the resolved stage specs at start. The aggregate state is recomputed ' +
        'from the steps AGAINST THIS, so republishing the definition cannot change the ' +
        'rules of an approval already in flight.',
      );
    t.integer('started_by_user_id').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    t.text('cancel_reason').nullable();
  });

  await knex.schema.alterTable('approval_steps', (t) => {
    t.timestamp('due_at', { useTz: true }).nullable()
      .comment('Per-stage deadline. approvals.due_at is the earliest of these.');
    t.timestamp('timed_out_at', { useTz: true }).nullable()
      .comment('Set once when the timeout behaviour ran. Stops it running every tick.');
    t.timestamp('reminded_at', { useTz: true }).nullable();
    t.timestamp('notified_at', { useTz: true }).nullable();
    t.integer('decided_by_user_id').nullable()
      .references('id').inTable('users').onDelete('SET NULL')
      .comment('Who ANSWERED. NULL when a timeout decided it. Differs from approver after a delegation.');
    t.integer('delegated_from_user_id').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
  });

  // The timeout sweep's hot query.
  await knex.schema.raw(
    "CREATE INDEX approval_steps_due ON approval_steps (tenant_id, due_at) " +
    "WHERE state = 'pending' AND due_at IS NOT NULL",
  );
  // The group inbox: pending steps addressed to a group rather than a person.
  await knex.schema.raw(
    "CREATE INDEX approval_steps_group_queue ON approval_steps (tenant_id, approver_group_id) " +
    "WHERE state = 'pending' AND approver_group_id IS NOT NULL",
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP INDEX IF EXISTS approval_steps_group_queue');
  await knex.schema.raw('DROP INDEX IF EXISTS approval_steps_due');

  await knex.schema.alterTable('approval_steps', (t) => {
    t.dropColumn('delegated_from_user_id');
    t.dropColumn('decided_by_user_id');
    t.dropColumn('notified_at');
    t.dropColumn('reminded_at');
    t.dropColumn('timed_out_at');
    t.dropColumn('due_at');
  });

  await knex.schema.alterTable('approvals', (t) => {
    t.dropColumn('cancel_reason');
    t.dropColumn('started_by_user_id');
    t.dropColumn('spec');
    t.dropColumn('definition_version');
  });

  await knex.schema.dropTableIfExists('escalation_fires');
  await knex.schema.dropTableIfExists('escalation_runs');
}
