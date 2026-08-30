import type { Knex } from 'knex';

/**
 * 011_change_management.ts — changes, their windows, and the conflict cache.
 *
 * 001..010 are never edited: a migration that has run on a real database is
 * history, and rewriting history means the schema an operator has is not the
 * schema the file describes. Everything here is additive — two new tables, one
 * function and one trigger. No existing column is renamed, no existing CHECK is
 * widened, no extension is created.
 *
 * ── Why `changes` is a 1:1 extension table and not columns on `tickets` ──────
 *
 * A change IS a ticket (`record_type = 'change'`): one number, one lifecycle,
 * one search surface. What it additionally carries lives here, for five
 * reasons. The first four are the ones 006 made for `problems`; the fifth is
 * specific to this module and settles it on its own.
 *
 *   1. The constraints become writable. The real invariants are "a completed
 *      PIR carries findings AND an answer to did-this-cause-an-incident", "a
 *      waived backout carries a waiver reason", "an emergency change may never
 *      have pir_required = false". On `tickets` each is a doubly-negated CHECK
 *      conditional on `record_type`, illegible and due for a rewrite the day
 *      `record_type` gains a seventh value. On a table where EVERY row is a
 *      change they are one readable line each, and a constraint you can read is
 *      a constraint you keep.
 *
 *   2. Two concurrency domains (HARD RULE 7). `implementation_md`,
 *      `backout_md` and `test_md` are long markdown, edited in a change-builder
 *      workshop while the change manager edits the ticket header. If they lived
 *      on `tickets`, every autosaved keystroke would bump `tickets.row_version`
 *      and 409 the manager. `changes.row_version` is a separate axis, exactly
 *      as `problems.row_version` is.
 *
 *   3. The cost would be paid by the wrong population. A desk has 50 000
 *      incidents and ~300 changes. A column on `tickets` is paid in row width
 *      across 50 000 rows and inside the hot partial indexes the queue board
 *      reads on every render. A join over 300 rows is free.
 *
 *   4. `tickets.data` is the obvious wrong answer. These fields are read by
 *      ENGINES (the conflict detector, the freeze evaluator, the PIR sweeper,
 *      the approval selector). An engine keying on `data->>'plannedStart'` has
 *      no FK, no CHECK and no usable index. `data` is for a tenant's FORM
 *      fields, not for the product's domain model.
 *
 *   5. THE ONE THAT SETTLES IT: the conflict detector is a range-overlap query.
 *      It needs `planned_window tstzrange` GENERATED ALWAYS from the two
 *      timestamps, and a GiST index on it. A jsonb text key cannot be
 *      GiST-indexed as a range, and a trigger-maintained range column on
 *      `tickets` would fire on all 50 000 rows for a feature 300 of them use.
 *      The differentiating function of this module is only cheap if the window
 *      is a typed column on a small table.
 *
 * ── Why there is no `change_status` ─────────────────────────────────────────
 *
 * HARD RULE 5 says every engine keys off `status_category`. A change's
 * lifecycle IS `status_category`: new (raised), open (being planned),
 * pending_* (waiting on an approver or a vendor), scheduled (a window is
 * committed), resolved, closed, cancelled. A second lifecycle enum would force
 * every engine to learn two vocabularies, which is exactly what RULE 5 exists
 * to forbid — the same reason 006 declined a `problem_status`.
 *
 * The eight categories have no `implementing`, and that gap is answered by the
 * DATA rather than by a ninth word: a change is implementing iff
 * `implementation_started_at IS NOT NULL AND implementation_ended_at IS NULL`,
 * i.e. iff `actual_window` is open-ended. That reading introduces no enum, is
 * unfalsifiable (a started implementation has a timestamp whatever the tenant
 * named its statuses), is read off a range both engines already index, and
 * survives a tenant that models implementation as three statuses (pre-checks,
 * cutover, validation — all three category `open`, all three inside one actual
 * window). `scheduled` therefore means "committed to a window, hands not yet
 * on"; implementing means "the actual window is open".
 *
 * ── The four time notions, named so they cannot collide (HARD RULE 6) ───────
 *
 *   tickets.occurred_at  "when did it happen". ON A CHANGE IT IS NULL AND
 *                        STAYS NULL. A change is not something that happened to
 *                        you; it is something you intend to do. Borrowing that
 *                        column for the window would corrupt the one column
 *                        Rewind rests on, across the incidents that share the
 *                        table. No CHECK enforces the NULL — a
 *                        record_type-conditional CHECK on `tickets` is exactly
 *                        the illegibility reason 1 above rejects — the change
 *                        service simply never writes it.
 *   planned_*            THE COMMITMENT. What the CAB is asked to approve, what
 *                        the freeze is tested against, what the detector
 *                        overlaps, what the forward schedule renders.
 *   baseline_*           THE PROMISE, frozen when the last selected approval is
 *                        granted and never edited afterwards. This is the one
 *                        most tools omit, and it is why their on-time metric is
 *                        a lie: without it, "we deliver 90% of changes inside
 *                        their window" is measured against a window somebody
 *                        moved yesterday to make it true.
 *   implementation_*     THE RECORD. Duration accuracy, outage accounting, and
 *                        Rewind on a change ("show me this CI as it stood when
 *                        we touched it").
 *
 * ── What this migration deliberately does NOT change ────────────────────────
 *
 *   • `tickets.record_type` already accepts 'change' (002). No CHECK widened.
 *   • `tickets.impact` already carries high|medium|low with its CHECK, and it
 *     is reused as the impact axis of the risk matrix. One vocabulary.
 *   • `ticket_link.kind` already carries 'caused_by' and reads in the right
 *     direction: the INCIDENT is caused_by the CHANGE. The PIR's "did this
 *     cause an incident?" writes that link and invents nothing.
 *   • `ticket_cis` already carries role primary|affected|cause and is already
 *     indexed (tenant_id, ci_id). The conflict query needs no new index there.
 *   • `config_objects.kind` and `decision_log.subsystem` are unconstrained
 *     varchars, so the kinds `change_policy` / `change_model` / `change_freeze`
 *     and the subsystem `change` are shared-constant additions with no DDL.
 *   • No new extension. `tstzrange` and GiST over a range are core PostgreSQL.
 *     btree_gist (which would allow the ideal `GIST (tenant_id,
 *     planned_window)`) is deliberately NOT created — see the index section.
 *   • No pgvector (HARD RULE 8). `search_tsv` is `to_tsvector('simple', …)`
 *     over unaccent(), the same shape as tickets and problems.
 */

/** `col IN ('a', 'b')` — small helper so CHECK bodies stay readable. */
function inList(col: string, values: readonly string[]): string {
  return `"${col}" IN (${values.map((v) => `'${v}'`).join(', ')})`;
}

/**
 * `emergency`, not `urgent`, even though the French label is "urgente".
 * `tickets.urgency` already exists with high|medium|low; a row carrying
 * change_type = 'urgent' next to urgency = 'high' is a naming trap in every
 * query, every report and every condition tree a tenant writes. Labels are
 * i18n; slugs are forever.
 */
const CHANGE_TYPES = ['standard', 'normal', 'emergency'] as const;

const CHANGE_RISKS = ['high', 'medium', 'low'] as const;
const FAILURE_LIKELIHOODS = ['high', 'medium', 'low'] as const;

/**
 * `successful_with_issues` earns its slot: a change that worked but overran, or
 * needed an unplanned step, is neither a success nor a failure, and a desk
 * forced to pick one of those two produces a change failure rate that is
 * either flattering or hysterical. Both make the number useless.
 */
const CHANGE_OUTCOMES = [
  'successful',
  'successful_with_issues',
  'failed',
  'rolled_back',
] as const;

const CONFLICT_KINDS = ['ci_overlap', 'freeze_window', 'queue_saturation'] as const;
const CONFLICT_SEVERITIES = ['high', 'medium', 'low', 'info'] as const;

export async function up(knex: Knex): Promise<void> {
  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — changes: the 1:1 extension of a `record_type = 'change'` ticket
  // ══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('changes', (t) => {
    // The identity of a change IS its ticket. No second number, no second
    // lifecycle, no second search page.
    t.integer('ticket_id').primary().references('id').inTable('tickets').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE')
      .comment('HARD RULE 1. Present in its own right so the conflict sweeper and the PIR sweeper read changes by tenant without joining tickets.');

    // ── What the type actually switches ──────────────────────────────────────
    // Not a chip colour. It selects the approvals, decides whether a conflict
    // blocks or warns, decides whether a freeze applies, and decides whether a
    // PIR is owed. Nothing else in the module keys on it.
    t.string('change_type', 16).notNullable().defaultTo('normal')
      .comment('standard | normal | emergency. Switches four engine behaviours: approval selection, the conflict gate, the freeze gate and the PIR requirement.');

    t.specificType('model_slug', 'citext').nullable()
      .comment("config_objects(kind='change_model').slug (HARD RULE 3). A `standard` change MUST name one: 'standard' without a model is just 'normal with the controls turned off'.");
    t.integer('model_version').nullable()
      .comment('The model version the plans were COPIED from. Provenance only — the copy is what was executed and it is never re-synchronised.');

    t.specificType('policy_slug', 'citext').nullable()
      .comment("config_objects(kind='change_policy').slug in force at the last risk compute (HARD RULE 3).");
    t.integer('policy_version').nullable()
      .comment('0 means the SHIPPED baseline policy was used because the tenant published none — the same stamp problemDetection uses. A NULL here means no policy has been resolved yet, which is a different fact.');

    // ── Risk: computed, stored, overridable — and never overwritten ─────────
    // `tickets.impact` is the impact axis; it is NOT duplicated here. One
    // vocabulary, HARD RULE 5's spirit.
    t.string('failure_likelihood', 8).nullable()
      .comment('The second axis. Impact alone cannot separate "restart a mail server" from "restart a mail server with a script we have never run", and that difference is exactly what risk is supposed to express.');
    t.string('risk_computed', 8).nullable()
      .comment('What the matrix said. NEVER overwritten by a human. "How often does this desk overrule its own risk matrix, and in which direction" is the single number that proves the matrix wrong, and it is unreconstructable once decision_log rows age out.');
    t.string('risk', 8).nullable()
      .comment('The band in force. Equals risk_computed until a human overrides it.');
    t.integer('risk_overridden_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('risk_overridden_at', { useTz: true }).nullable()
      .comment('Set ⇒ the engine STOPS recomputing `risk`. An engine that silently re-derives over a human override teaches people the field is a lie and they stop using it; drift is reported as a change_risk_drifted noop row instead.');
    t.text('risk_override_reason').nullable();

    // ── The plans (HARD RULE 12 — required only at the gate, never at keystroke)
    t.text('implementation_md').nullable();
    t.text('implementation_html').nullable();
    t.text('backout_md').nullable()
      .comment('The plan the approver actually approves. Absent and unwaived, it floors the computed risk at `high`: a change you cannot undo is never low risk, whatever a tenant matrix says.');
    t.text('backout_html').nullable();
    t.text('test_md').nullable();
    t.text('test_html').nullable();
    t.boolean('backout_not_applicable').notNullable().defaultTo(false)
      .comment('The waiver. Accepted by the shared evaluator ONLY when the computed band is low and no linked CI is critical — a waiver that is always available is a required field that is not required, and everyone types "n/a".');
    t.text('backout_waiver_reason').nullable();

    // ── The windows (HARD RULE 6 — see the header) ──────────────────────────
    t.timestamp('planned_start_at', { useTz: true }).nullable();
    t.timestamp('planned_end_at', { useTz: true }).nullable();

    t.timestamp('baseline_start_at', { useTz: true }).nullable()
      .comment('Frozen the instant the last selected approval is granted, and never edited after. Schedule accuracy and on-time delivery are measured against THIS, never against planned_*.');
    t.timestamp('baseline_end_at', { useTz: true }).nullable();
    t.timestamp('baseline_set_at', { useTz: true }).nullable();

    t.timestamp('implementation_started_at', { useTz: true }).nullable()
      .comment('Stamped by an explicit act (POST /implementation/start), not as a side effect of a transition: the operator puts hands on the system twenty minutes after clicking the status.');
    t.timestamp('implementation_ended_at', { useTz: true }).nullable()
      .comment('NULL while started ⇒ the change is IMPLEMENTING. That derived reading is the answer to the missing `implementing` category (see the header).');

    // ── Freeze override ─────────────────────────────────────────────────────
    t.integer('freeze_override_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('freeze_override_at', { useTz: true }).nullable();
    t.text('freeze_override_reason').nullable();
    t.jsonb('freeze_override_slugs').notNullable().defaultTo(knex.raw("'[]'::jsonb"))
      .comment('WHICH change_freeze objects were bypassed, by slug (HARD RULE 3), so a reader next year knows what was overridden and not merely that something was.');

    // ── Conflict acknowledgement ────────────────────────────────────────────
    t.integer('conflict_ack_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('conflict_ack_at', { useTz: true }).nullable();
    t.text('conflict_ack_reason').nullable();
    t.string('conflict_ack_digest', 64).nullable()
      .comment('Digest over the SET of live conflicts that was acknowledged. Acknowledging is "I have seen THESE", not a permanent immunity: a new conflict changes the digest, the acknowledgement goes stale and the gate closes again. Without it, one click at 09:00 buys immunity from everything found at 16:00.');

    // ── Outcome + post-implementation review ────────────────────────────────
    t.string('outcome', 24).nullable();
    t.timestamp('outcome_recorded_at', { useTz: true }).nullable();
    t.integer('outcome_recorded_by').nullable().references('id').inTable('users').onDelete('SET NULL');

    t.boolean('major').notNullable().defaultTo(false)
      .comment('Mirrors problems.major. A major change owes a PIR whatever its band says.');

    t.boolean('pir_required').notNullable().defaultTo(false);
    t.timestamp('pir_due_at', { useTz: true }).nullable()
      .comment('addBusinessMinutesOn(calendarSlug, outcome_recorded_at, pirDueBusinessMinutes) — a COMPARISON computed once on the existing calendar service, not a new clock. A freeze and a PIR have no ledger, no pause and no breach; the day somebody wants a countdown, that is an `sla` object.');
    t.timestamp('pir_overdue_notified_at', { useTz: true }).nullable()
      .comment('Idempotence marker for the sweeper: change_pir_overdue is written ONCE per change, not every five minutes.');
    t.timestamp('pir_completed_at', { useTz: true }).nullable();
    t.integer('pir_completed_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.text('pir_findings_md').nullable();
    t.boolean('pir_caused_incident').nullable()
      .comment('The question a PIR may not dodge. `true` is expected to be backed by a ticket_link(from = incident, to = change, kind = caused_by) — that link is what turns the change failure rate into a real number instead of a survey.');

    t.integer('row_version').notNullable().defaultTo(1)
      .comment('HARD RULE 7, on its own axis so the plan workshop and the ticket header do not 409 each other.');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.specificType('search_tsv', 'tsvector').nullable()
      .comment('Maintained by changes_search_tsv_trigger(). Never written by application code.');
  });

  // ── Vocabulary CHECKs. Each one is mirrored by a literal tuple in
  //    shared/src/change.ts, so a drift is a compile error in one file instead
  //    of a 23514 at runtime.
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_type_ck CHECK (${inList('change_type', CHANGE_TYPES)})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_failure_likelihood_ck CHECK (
       failure_likelihood IS NULL OR ${inList('failure_likelihood', FAILURE_LIKELIHOODS)})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_risk_computed_ck CHECK (
       risk_computed IS NULL OR ${inList('risk_computed', CHANGE_RISKS)})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_risk_ck CHECK (
       risk IS NULL OR ${inList('risk', CHANGE_RISKS)})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_outcome_ck CHECK (
       outcome IS NULL OR ${inList('outcome', CHANGE_OUTCOMES)})`,
  );

  // An override without a named human and a stated reason is an anonymous
  // override, which is the same as no control at all.
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_risk_override_ck CHECK (
       risk_overridden_at IS NULL
       OR (risk_overridden_by IS NOT NULL AND btrim(coalesce(risk_override_reason, '')) <> ''))`,
  );
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_freeze_override_ck CHECK (
       freeze_override_at IS NULL
       OR (freeze_override_by IS NOT NULL AND btrim(coalesce(freeze_override_reason, '')) <> ''))`,
  );
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_conflict_ack_ck CHECK (
       conflict_ack_at IS NULL
       OR (conflict_ack_by IS NOT NULL
           AND conflict_ack_digest IS NOT NULL
           AND btrim(coalesce(conflict_ack_reason, '')) <> ''))`,
  );

  // The waiver carries its own sentence, always. The BAND test (low risk, no
  // critical CI) lives in the shared evaluator, because it depends on rows in
  // another table; this is the half a CHECK can hold.
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_backout_waiver_ck CHECK (
       NOT backout_not_applicable OR btrim(coalesce(backout_waiver_reason, '')) <> '')`,
  );

  // A window is a window: both ends or neither, and it moves forward.
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_planned_pair_ck CHECK (
       (planned_start_at IS NULL) = (planned_end_at IS NULL))`,
  );
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_planned_order_ck CHECK (
       planned_end_at IS NULL OR planned_end_at > planned_start_at)`,
  );
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_baseline_pair_ck CHECK (
       (baseline_start_at IS NULL) = (baseline_end_at IS NULL))`,
  );
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_baseline_order_ck CHECK (
       baseline_end_at IS NULL OR baseline_end_at > baseline_start_at)`,
  );
  // An end with no beginning is not a duration, it is a data error. The actual
  // window is deliberately allowed to be zero-length: a scripted change that
  // starts and finishes inside the same second really did happen.
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_actual_order_ck CHECK (
       implementation_ended_at IS NULL
       OR (implementation_started_at IS NOT NULL
           AND implementation_ended_at >= implementation_started_at))`,
  );

  // THE STRUCTURAL TOOTH. "We review every emergency change" is the one
  // commitment that must not be configurable away by whoever is tidying the
  // config page on a Friday, so it is a database constraint and not a policy
  // setting. No engine, no rule, no user and no tenant configuration can clear
  // it.
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_emergency_pir_ck CHECK (
       change_type <> 'emergency' OR pir_required)`,
  );

  // An outcome is an event: it has a moment or it has not been recorded.
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_outcome_pair_ck CHECK (
       (outcome IS NULL) = (outcome_recorded_at IS NULL))`,
  );

  // HARD RULE 12 in the schema: typing into the review autosaves and validates
  // nothing. Completeness is demanded only at COMPLETION, by the same
  // evaluator on both sides. This CHECK bites there and nowhere else — and it
  // is what refuses a PIR that says "went fine" and nothing more.
  await knex.schema.raw(
    `ALTER TABLE "changes" ADD CONSTRAINT changes_pir_completed_ck CHECK (
       pir_completed_at IS NULL
       OR (outcome IS NOT NULL
           AND pir_completed_by IS NOT NULL
           AND btrim(coalesce(pir_findings_md, '')) <> ''
           AND pir_caused_incident IS NOT NULL))`,
  );
  await knex.schema.raw(
    'ALTER TABLE "changes" ADD CONSTRAINT changes_row_version_ck CHECK (row_version >= 1)',
  );

  // ── The two generated ranges ────────────────────────────────────────────────
  //
  // `tstzrange(timestamptz, timestamptz, text)` is IMMUTABLE, so these are
  // valid GENERATED ALWAYS … STORED columns on PostgreSQL 16 and need no
  // trigger. If a future planner ever objects, the replacement is a
  // BEFORE INSERT OR UPDATE trigger writing the same column — same shape, same
  // index, one more moving part.
  //
  // `[)` is half-open on purpose: a change ending at 02:00 and one starting at
  // 02:00 do NOT overlap, which is what a scheduler means by back-to-back.
  //
  // `actual_window` is deliberately UNBOUNDED ABOVE while the work is running
  // (`tstzrange(started, NULL)` ⇒ `[started,)`). That is not a placeholder: it
  // is the honest statement that the end is not yet known, and it makes "is
  // this change implementing right now" an index lookup rather than a second
  // enum.
  await knex.schema.raw(`
    ALTER TABLE "changes" ADD COLUMN planned_window tstzrange
      GENERATED ALWAYS AS (
        CASE WHEN planned_start_at IS NOT NULL AND planned_end_at IS NOT NULL
             THEN tstzrange(planned_start_at, planned_end_at, '[)')
        END
      ) STORED
  `);
  await knex.schema.raw(`
    ALTER TABLE "changes" ADD COLUMN actual_window tstzrange
      GENERATED ALWAYS AS (
        CASE WHEN implementation_started_at IS NOT NULL
             THEN tstzrange(implementation_started_at, implementation_ended_at, '[)')
        END
      ) STORED
  `);
  await knex.schema.raw(
    `COMMENT ON COLUMN changes.planned_window IS
     'Generated from planned_start_at/planned_end_at. THE column the conflict detector overlaps. Half-open: back-to-back windows do not conflict.'`,
  );
  await knex.schema.raw(
    `COMMENT ON COLUMN changes.actual_window IS
     'Generated from implementation_started_at/implementation_ended_at. Unbounded above while the work runs: that open end IS the derived implementing state, and it is why this module needs no ninth status category.'`,
  );

  // ── Indexes ────────────────────────────────────────────────────────────────
  //
  // DEFERRAL, STATED SO IT IS NOT MISTAKEN FOR AN OVERSIGHT: the ideal index is
  // GIST (tenant_id, planned_window), which needs CREATE EXTENSION btree_gist.
  // btree_gist ships in postgres:16-alpine's contrib, but creating an extension
  // is a deployment fact and not a free one, and at ~300 changes per tenant the
  // ticket_cis join already narrows brutally before the range test runs. Ship
  // the single-column GiST; if EXPLAIN ever degrades, btree_gist plus the
  // composite is a one-line migration.
  //
  // AND: an EXCLUDE constraint is NOT the tool here. EXCLUDE would FORBID
  // overlapping windows. Overlaps are legal — we warn about them. A constraint
  // that makes the conflict impossible also makes the feature impossible.
  await knex.schema.raw('CREATE INDEX changes_planned_gist ON changes USING GIST (planned_window)');
  await knex.schema.raw(
    'CREATE INDEX changes_board ON changes (tenant_id, planned_start_at) WHERE planned_start_at IS NOT NULL',
  );
  // The PIR sweeper's hot path. Partial, so the 95% of changes that owe no
  // review cost nothing.
  await knex.schema.raw(
    'CREATE INDEX changes_pir_due ON changes (tenant_id, pir_due_at) ' +
    'WHERE pir_required AND pir_completed_at IS NULL',
  );
  // "What is running right now" — the derived implementing state, indexed.
  await knex.schema.raw(
    'CREATE INDEX changes_implementing ON changes (tenant_id) ' +
    'WHERE implementation_started_at IS NOT NULL AND implementation_ended_at IS NULL',
  );
  await knex.schema.raw(
    'CREATE INDEX changes_model ON changes (tenant_id, model_slug) WHERE model_slug IS NOT NULL',
  );
  await knex.schema.raw('CREATE INDEX changes_search_gin ON changes USING GIN (search_tsv)');

  await knex.schema.raw(
    `COMMENT ON TABLE changes IS
     'The 1:1 extension of a record_type=change ticket. The lifecycle is tickets.status_category (HARD RULE 5); change_type, risk and outcome are ORTHOGONAL axes, and "implementing" is derived from actual_window rather than named as a ninth category.'`,
  );

  // Same shape and same reasoning as tickets_search_tsv_trigger() and
  // problems_search_tsv_trigger(): unaccent() is STABLE, never IMMUTABLE, so
  // this can be neither a generated column nor an expression index. 'simple'
  // rather than 'english' because the corpus is multilingual (HARD RULE 8).
  // The three plans are indexed and the ticket subject is not: the subject is
  // already in tickets.search_tsv, and indexing it twice would double-rank
  // every change against a plain word search.
  await knex.schema.raw(`
    CREATE FUNCTION changes_search_tsv_trigger() RETURNS trigger AS $$
    BEGIN
      NEW.search_tsv := to_tsvector(
        'simple',
        unaccent(
          coalesce(NEW.implementation_md, '') || ' ' ||
          coalesce(NEW.backout_md, '') || ' ' ||
          coalesce(NEW.test_md, '')
        )
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await knex.schema.raw(`
    CREATE TRIGGER changes_search_tsv_biu
      BEFORE INSERT OR UPDATE OF implementation_md, backout_md, test_md ON changes
      FOR EACH ROW EXECUTE FUNCTION changes_search_tsv_trigger()
  `);

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — change_conflicts: a CACHE, and honest about it
  // ══════════════════════════════════════════════════════════════════════════
  //
  // These rows are a materialised cache of the overlap query, refreshed by the
  // sweeper and by every planning write. Safe to TRUNCATE and rebuild, exactly
  // like ci_state_cache. `decision_log` is NEVER derived from it (HARD RULE 2):
  // a conflict RAISED and a conflict CLEARED each write their own decision row
  // on the same code path, in the same transaction, as the cache row.
  //
  // Why store rows at all rather than recompute every time: the sweeper needs a
  // previous state to diff against in order to say "raised" and — the one
  // people actually act on — "CLEARED: the other team moved, you are clear".
  // That sentence is uncomputable without a stored prior. The cache also lets
  // the board render 200 changes without 200 range queries.
  //
  // FREEZE WINDOWS LIVE HERE TOO, as kind = 'freeze_window', so the operator
  // reads ONE panel with one vocabulary instead of two panels that disagree
  // about what is wrong with their date.

  await knex.schema.createTable('change_conflicts', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE')
      .comment('HARD RULE 1, in its own right: the sweeper reads conflicts by (tenant, severity) without touching `changes`. Same argument that gave escalation_fires and problem_causes theirs.');
    t.integer('change_ticket_id').notNullable()
      .references('ticket_id').inTable('changes').onDelete('CASCADE');

    t.string('kind', 24).notNullable()
      .comment("ci_overlap is THE conflict. queue_saturation is a CAPACITY signal wearing a different word on purpose: calling a capacity warning a 'conflict' devalues the word for the case that actually causes an outage.");
    t.string('severity', 8).notNullable();

    t.integer('other_ticket_id').nullable().references('id').inTable('tickets').onDelete('CASCADE')
      .comment('ci_overlap only. The OTHER change. FK to tickets rather than changes so a row survives the other side losing its extension row.');
    t.specificType('freeze_slug', 'citext').nullable()
      .comment('freeze_window only (HARD RULE 3).');
    t.integer('freeze_version').nullable()
      .comment('The config_objects.version that fired, so a bypass can be replayed against the body that produced it (HARD RULE 4).');
    t.specificType('queue_slug', 'citext').nullable()
      .comment('queue_saturation only (HARD RULE 3).');

    t.jsonb('ci_ids').notNullable().defaultTo(knex.raw("'[]'::jsonb"))
      .comment('The shared CIs, for the panel. Deliberately a jsonb array and not a join table: this is cache, rebuilt wholesale, and a child table of a cache is a second thing to keep consistent.');

    t.timestamp('overlap_start_at', { useTz: true }).nullable();
    t.timestamp('overlap_end_at', { useTz: true }).nullable();

    t.timestamp('detected_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('cleared_at', { useTz: true }).nullable()
      .comment('Cleared rather than deleted: "you are clear now" is a notification, and a notification needs the row it is about to still exist when it is sent.');

    t.string('digest', 64).notNullable()
      .comment('Stable identity of this conflict, computed by conflictDigest() in shared/ so client and server agree. Feeds changes.conflict_ack_digest: when the live set changes, the digest changes and the acknowledgement goes stale.');
  });

  await knex.schema.raw(
    `ALTER TABLE "change_conflicts" ADD CONSTRAINT change_conflicts_kind_ck CHECK (${inList(
      'kind', CONFLICT_KINDS,
    )})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "change_conflicts" ADD CONSTRAINT change_conflicts_severity_ck CHECK (${inList(
      'severity', CONFLICT_SEVERITIES,
    )})`,
  );
  // Exactly one target per row, whatever the kind. The same shape ticket_watcher
  // uses to make a watcher who watches nothing impossible. `lead_time` is
  // deliberately NOT a kind here: it has none of the three targets, it is true
  // or false at one instant rather than standing, and it is a transition
  // blocker instead. Adding it would have forced this CHECK open, and a CHECK
  // you weaken for one caller stops constraining the others.
  await knex.schema.raw(
    `ALTER TABLE "change_conflicts" ADD CONSTRAINT change_conflicts_target_ck CHECK (
       (other_ticket_id IS NOT NULL)::int
       + (freeze_slug IS NOT NULL)::int
       + (queue_slug IS NOT NULL)::int = 1)`,
  );
  await knex.schema.raw(
    `ALTER TABLE "change_conflicts" ADD CONSTRAINT change_conflicts_no_self_ck CHECK (
       other_ticket_id IS NULL OR other_ticket_id <> change_ticket_id)`,
  );
  await knex.schema.raw(
    `ALTER TABLE "change_conflicts" ADD CONSTRAINT change_conflicts_overlap_order_ck CHECK (
       overlap_end_at IS NULL OR overlap_start_at IS NULL OR overlap_end_at >= overlap_start_at)`,
  );

  // One LIVE row per (change, identity). The refresh upserts on this, which is
  // what makes a re-scan idempotent and what stops a five-minute sweeper from
  // growing the table by one row per pass forever.
  await knex.schema.raw(
    'CREATE UNIQUE INDEX change_conflicts_live_uq ON change_conflicts (change_ticket_id, digest) ' +
    'WHERE cleared_at IS NULL',
  );
  await knex.schema.raw(
    'CREATE INDEX change_conflicts_open ON change_conflicts (tenant_id, change_ticket_id) WHERE cleared_at IS NULL',
  );
  await knex.schema.raw(
    'CREATE INDEX change_conflicts_sev ON change_conflicts (tenant_id, severity) WHERE cleared_at IS NULL',
  );
  // Reverse lookup: "which changes am I in the way of?" — the query that lets
  // the sweeper notify BOTH owners. A conflict notified to one side only is
  // exactly how two teams each assume the other will move.
  await knex.schema.raw(
    'CREATE INDEX change_conflicts_other ON change_conflicts (other_ticket_id) WHERE cleared_at IS NULL',
  );

  await knex.schema.raw(
    `COMMENT ON TABLE change_conflicts IS
     'Materialised cache of the planned-window overlap query plus the freeze verdicts. Safe to truncate and rebuild. decision_log is never derived from it: raised and cleared each write their own row on the same code path.'`,
  );
}

export async function down(knex: Knex): Promise<void> {
  // Reverse dependency order throughout.
  await knex.schema.dropTableIfExists('change_conflicts');

  await knex.schema.raw('DROP TRIGGER IF EXISTS changes_search_tsv_biu ON changes');
  await knex.schema.dropTableIfExists('changes');
  await knex.schema.raw('DROP FUNCTION IF EXISTS changes_search_tsv_trigger()');

  // citext / pg_trgm / unaccent are owned by 001_oblidesk_core.ts — sibling
  // modules still need them, so they are intentionally not dropped.
}
