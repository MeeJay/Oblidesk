import type { Knex } from 'knex';

/**
 * 006_problem_management.ts — problems, root-cause analysis, known errors and
 * the recurrence detector.
 *
 * 001..005 are never edited: a migration that has run on a real database is
 * history, and rewriting history means the schema an operator has is not the
 * schema the file describes. Everything here is additive — seven new tables,
 * three new indexes on existing tables, one function and one trigger. No
 * existing column is renamed, no existing CHECK is widened.
 *
 * ── Why `problems` is a 1:1 extension table and not columns on `tickets` ─────
 *
 * A problem IS a ticket (`record_type = 'problem'`): one number, one lifecycle,
 * one search surface. What it additionally carries lives here, for four
 * reasons, in order of force:
 *
 *   1. The constraints become writable. The real invariant is "a PUBLISHED
 *      known error must carry a non-empty workaround". On `tickets` that is a
 *      doubly-negated CHECK conditional on `record_type`, illegible and due for
 *      a rewrite the day `record_type` gains a seventh value. On a table where
 *      EVERY row is a problem it is one readable line, and a constraint you can
 *      read is a constraint you keep.
 *
 *   2. Two concurrency domains (HARD RULE 7). If `workaround_md` lived on
 *      `tickets`, every autosaved keystroke in the RCA workshop would bump
 *      `tickets.row_version` and 409 the team lead editing the header. A
 *      post-incident review has four people in the room; `problems.row_version`
 *      separate from `tickets.row_version` is what lets them all work.
 *
 *   3. The cost would be paid by the wrong population. A desk has 50 000
 *      incidents and 200 problems. A column on `tickets` is paid in row width
 *      across 50 000 rows and inside the four hot partial indexes the queue
 *      reads on every render. A join over 200 rows is free.
 *
 *   4. `tickets.data` is the obvious wrong answer. These fields are read by
 *      ENGINES (closure cascade, known-error suggester, recurrence detector).
 *      An engine keying on `data->>'workaroundMd'` has no FK, no CHECK and no
 *      usable index. `data` is for a tenant's FORM fields, not for the
 *      product's domain model.
 *
 * ── Why there is no `problem_status` ────────────────────────────────────────
 *
 * HARD RULE 5 says every engine keys off `status_category`. A problem's
 * lifecycle IS `status_category`: new (detected), open (investigating),
 * pending_third_party (with the vendor), scheduled (fix planned), resolved,
 * closed. The SLA pauses at the vendor for free, by category.
 *
 * `known_error_state` is an ORTHOGONAL axis answering a different question:
 * "is there, right now, a documented workaround the desk can apply?" A problem
 * can be `open` (still hunting the permanent fix) and simultaneously a
 * published known error — that is the ITIL definition, and it is the single
 * most useful state in the module. One enum cannot express it; a second
 * lifecycle enum would force every engine to learn two vocabularies, which is
 * exactly what HARD RULE 5 exists to forbid.
 *
 * ── What this migration deliberately does NOT change ────────────────────────
 *
 *   • `tickets.record_type` already accepts 'problem' (002). No CHECK widened.
 *   • `ticket_link.kind` already carries 'caused_by' (002), and it reads in the
 *     right direction: the INCIDENT is caused_by the PROBLEM. Promotion writes
 *     `ticket_link(from = incident, to = problem, kind = 'caused_by')` and
 *     invents nothing.
 *   • `ticket_journal.kind` already carries 'system', 'automation' and 'alert'.
 *   • `config_objects.kind` and `decision_log.subsystem` are unconstrained
 *     varchars, so the new kind `problem_detection` and the new subsystem
 *     `problem` are shared-constant additions with no DDL.
 *   • `attachment_links.entity_type` is an unconstrained varchar(32), so a
 *     screenshot pinned to a cause is `entity_type = 'problem_cause'`. HARD
 *     RULE 9 keeps its single refcount; there is deliberately NO
 *     `attachment_id` column on `problem_cause_evidence`, because a second
 *     direct reference to `attachments` would break "the blob dies with its
 *     last link" and the sweeper would delete files still in use.
 *   • No pgvector, no embeddings table (HARD RULE 8). The deployment is
 *     postgres:16-alpine; similarity is `pg_trgm` + `to_tsvector('simple', …)`.
 */

/** `col IN ('a', 'b')` — small helper so CHECK bodies stay readable. */
function inList(col: string, values: readonly string[]): string {
  return `"${col}" IN (${values.map((v) => `'${v}'`).join(', ')})`;
}

const KNOWN_ERROR_STATES = ['none', 'candidate', 'published', 'retired'] as const;
const WORKAROUND_RISKS = ['low', 'medium', 'high'] as const;
const PROBLEM_DETECTED_BY = ['manual', 'promotion', 'recurrence', 'alert'] as const;
const PROBLEM_CLOSURE_POLICIES = [
  'notify_only',
  'resolve_untouched',
  'resolve_all_pending_confirmation',
] as const;

const ANALYSIS_METHODS = ['five_whys', 'ishikawa', 'mixed'] as const;
const ANALYSIS_STATES = ['draft', 'in_review', 'concluded', 'superseded', 'abandoned'] as const;

const CAUSE_CATEGORIES = [
  'people',
  'process',
  'technology',
  'environment',
  'measurement',
  'supplier',
  'policy',
  'unknown',
] as const;
const CAUSE_KINDS = ['cause', 'contributing', 'trigger', 'non_cause'] as const;
const CAUSE_CONFIDENCES = ['suspected', 'probable', 'confirmed', 'refuted'] as const;
const CAUSE_CONFIRMATION_METHODS = [
  'evidence',
  'reproduction',
  'vendor_confirmation',
  'fix_verified',
  'expert_review',
] as const;

const EVIDENCE_TYPES = [
  'ticket_evidence',
  'ci',
  'alert',
  'ticket',
  'journal',
  'kb_article',
  'external',
] as const;

const CANDIDATE_STATES = ['proposed', 'accepted', 'rejected', 'expired', 'merged'] as const;
const DETECTION_SIGNALS = [
  'ci_repetition',
  'alert_flapping',
  'subject_cluster',
  'reopen_pressure',
  'queue_spike',
  'known_error_miss',
] as const;

export async function up(knex: Knex): Promise<void> {
  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — problems: the 1:1 extension of a `record_type = 'problem'`
  //             ticket
  // ══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('problems', (t) => {
    // The identity of a problem IS its ticket. No second number, no second
    // lifecycle, no second search page.
    t.integer('ticket_id').primary().references('id').inTable('tickets').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE')
      .comment('HARD RULE 1. Present in its own right so the detector reads problems by tenant without joining tickets.');

    // ── The known-error axis, orthogonal to status_category (HARD RULE 5) ────
    t.string('known_error_state', 16).notNullable().defaultTo('none')
      .comment('none | candidate | published | retired. Answers "is there a workaround the desk can apply RIGHT NOW?", not "where is this in its lifecycle".');
    t.timestamp('known_error_published_at', { useTz: true }).nullable();
    t.integer('known_error_published_by').nullable()
      .references('id').inTable('users').onDelete('SET NULL')
      .comment('Publication is a human act. An engine may propose a known error; it never publishes one.');

    // The linguistic bridge. The problem SUBJECT is written by an engineer
    // ("MAPI proxy pool exhaustion"); the incident subject is written by a user
    // ("Outlook stuck on Trying to connect"). A trigram between those never
    // matches. `symptoms_md` is phrased in the REQUESTER's words and is what
    // gets indexed — without it, known-error lookup from intake cannot work no
    // matter how good the matcher is.
    t.text('symptoms_md').nullable();

    t.text('workaround_md').nullable()
      .comment('The internal payload. This is the one field the desk reads at 09:00.');
    t.text('workaround_html').nullable();
    t.string('workaround_risk', 16).nullable()
      .comment('low | medium | high. Emptying a cache and restarting a production database are not applied with the same nonchalance.');
    t.timestamp('workaround_verified_at', { useTz: true }).nullable()
      .comment('A workaround never replayed is a hypothesis. This is what lets the UI say "verified 8 months ago".');
    t.integer('workaround_verified_by').nullable()
      .references('id').inTable('users').onDelete('SET NULL');

    // Rollups maintained inside the SAME transaction as the ticket_link
    // insert/delete. "How long has this been hurting, and is it still alive"
    // is the only number that arbitrates a problem's priority, and computing
    // it by scanning N incidents on every board render is what kills the board.
    // This is NOT a backfill of occurred_at (HARD RULE 6): it is a derived
    // aggregate, on another table, that overwrites nothing.
    t.timestamp('first_incident_at', { useTz: true }).nullable();
    t.timestamp('last_incident_at', { useTz: true }).nullable();
    t.integer('incident_count').notNullable().defaultTo(0);

    t.string('detected_by', 16).notNullable().defaultTo('manual')
      .comment('manual | promotion | recurrence | alert. Without it, "did the detector ever earn its keep?" is unanswerable and the feature is cut at the first review.');
    t.integer('candidate_id').nullable()
      .comment('FK added at the end of this migration, once problem_candidates exists. Closes the detector precision loop: candidate -> problem -> solved or abandoned.');

    t.boolean('rca_required').notNullable().defaultTo(true)
      .comment('Some problems need no internal analysis (a vendor bug with a public advisory). Without this flag the evaluator either demands an RCA and agents type "vendor bug" into a five-whys chain, or demands nothing and the RCA is never done.');
    t.string('closure_policy', 32).notNullable().defaultTo('notify_only')
      .comment('The cascade rule is a decision the problem owner takes ONCE, visibly, on the problem, not a global switch someone flipped a year ago.');

    t.boolean('major').notNullable().defaultTo(false);
    t.timestamp('major_review_due_at', { useTz: true }).nullable()
      .comment('The only deadline a problem has. Problems get no first-response SLA: nobody is waiting for a reply on a problem, and a board where 40 problems are in breach is a board people stop reading.');

    t.integer('kb_article_id').nullable()
      .references('id').inTable('kb_articles').onDelete('SET NULL')
      .comment('The single, one-way link to the EXTERNAL publication. Never synchronised: an internal workaround naming a host and an admin console, pushed verbatim to the portal, is a data leak wearing a feature badge.');

    t.integer('row_version').notNullable().defaultTo(1)
      .comment('HARD RULE 7, on its own axis so the RCA workshop and the ticket header do not 409 each other.');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.specificType('search_tsv', 'tsvector').nullable()
      .comment('Maintained by problems_search_tsv_trigger(). Never written by application code.');
  });

  await knex.schema.raw(
    `ALTER TABLE "problems" ADD CONSTRAINT problems_known_error_state_ck CHECK (${inList(
      'known_error_state', KNOWN_ERROR_STATES,
    )})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "problems" ADD CONSTRAINT problems_workaround_risk_ck CHECK (workaround_risk IS NULL OR ${inList(
      'workaround_risk', WORKAROUND_RISKS,
    )})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "problems" ADD CONSTRAINT problems_detected_by_ck CHECK (${inList(
      'detected_by', PROBLEM_DETECTED_BY,
    )})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "problems" ADD CONSTRAINT problems_closure_policy_ck CHECK (${inList(
      'closure_policy', PROBLEM_CLOSURE_POLICIES,
    )})`,
  );

  // THE readable invariant, and the whole argument for a separate table: a
  // published known error without a workaround is a promise the desk cannot
  // keep. The evaluator in shared/ refuses the transition first and says what
  // is missing; this is the last line of defence behind it.
  await knex.schema.raw(
    `ALTER TABLE "problems" ADD CONSTRAINT problems_published_workaround_ck CHECK (
       known_error_state <> 'published'
       OR (workaround_md IS NOT NULL AND btrim(workaround_md) <> ''
           AND workaround_risk IS NOT NULL
           AND known_error_published_at IS NOT NULL))`,
  );
  await knex.schema.raw(
    'ALTER TABLE "problems" ADD CONSTRAINT problems_incident_count_ck CHECK (incident_count >= 0)',
  );
  await knex.schema.raw(
    'ALTER TABLE "problems" ADD CONSTRAINT problems_row_version_ck CHECK (row_version >= 1)',
  );
  await knex.schema.raw(
    `ALTER TABLE "problems" ADD CONSTRAINT problems_incident_window_ck CHECK (
       last_incident_at IS NULL OR first_incident_at IS NULL OR last_incident_at >= first_incident_at)`,
  );

  // The intake suggester's hot path: published known errors only, freshest
  // first. Partial, so retired and unpublished problems cost nothing.
  await knex.schema.raw(
    "CREATE INDEX problems_known_errors ON problems (tenant_id, last_incident_at DESC) " +
    "WHERE known_error_state = 'published'",
  );
  // The problem board, ordered by "is it still alive".
  await knex.schema.raw(
    'CREATE INDEX problems_board ON problems (tenant_id, last_incident_at DESC NULLS LAST)',
  );
  await knex.schema.raw('CREATE INDEX problems_search_gin ON problems USING GIN (search_tsv)');
  await knex.schema.raw(
    'CREATE INDEX problems_candidate ON problems (candidate_id) WHERE candidate_id IS NOT NULL',
  );
  await knex.schema.raw(
    'CREATE INDEX problems_kb ON problems (kb_article_id) WHERE kb_article_id IS NOT NULL',
  );
  await knex.schema.raw(
    'CREATE INDEX problems_major_due ON problems (tenant_id, major_review_due_at) ' +
    'WHERE major AND major_review_due_at IS NOT NULL',
  );

  await knex.schema.raw(
    `COMMENT ON TABLE problems IS
     'The 1:1 extension of a record_type=problem ticket. known_error_state is ORTHOGONAL to tickets.status_category (HARD RULE 5): a problem can be open and a published known error at the same time.'`,
  );

  // Same shape and same reasoning as tickets_search_tsv_trigger(): unaccent()
  // is STABLE, never IMMUTABLE, so this can be neither a generated column nor
  // an expression index. 'simple' rather than 'english' because the corpus is
  // multilingual (HARD RULE 8's search stack). Symptoms + workaround is
  // deliberate: the symptoms are the requester's words, which is what an
  // incident subject will look like.
  await knex.schema.raw(`
    CREATE FUNCTION problems_search_tsv_trigger() RETURNS trigger AS $$
    BEGIN
      NEW.search_tsv := to_tsvector(
        'simple',
        unaccent(coalesce(NEW.symptoms_md, '') || ' ' || coalesce(NEW.workaround_md, ''))
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await knex.schema.raw(`
    CREATE TRIGGER problems_search_tsv_biu
      BEFORE INSERT OR UPDATE OF symptoms_md, workaround_md ON problems
      FOR EACH ROW EXECUTE FUNCTION problems_search_tsv_trigger()
  `);

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — problem_analyses: N analyses per problem, exactly one current
  // ══════════════════════════════════════════════════════════════════════════
  //
  // A problem gets more than one analysis in its life: the first one, then a
  // second after a recurrence proved the first conclusion wrong. Mutating a
  // single analysis in place DELETES the wrong conclusion from the file — and
  // the wrong conclusion is the most valuable object in a post-mortem ("we
  // concluded it was the network; it was the connection pool"). Superseded
  // analyses stay readable exactly as they were concluded.

  await knex.schema.createTable('problem_analyses', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('problem_ticket_id').notNullable()
      .references('ticket_id').inTable('problems').onDelete('CASCADE');

    t.string('title', 255).nullable();
    t.string('method', 16).notNullable().defaultTo('five_whys')
      .comment("five_whys | ishikawa | mixed. 'mixed' is not a compromise: digging one fishbone rib into a five-whys chain is the normal case.");
    t.string('state', 16).notNullable().defaultTo('draft');

    t.integer('facilitator_id').nullable().references('id').inTable('users').onDelete('SET NULL');

    t.bigInteger('root_cause_id').nullable()
      .comment('The elected root among problem_causes. Deliberately NO foreign key: problem_causes CASCADE-deletes with this row, and an ON DELETE SET NULL here would re-evaluate problem_analyses_concluded_ck and fail the delete with a check violation instead of a readable error. The election is enforced by the shared evaluator and by that CHECK at write time.');

    t.text('conclusion_md').nullable();

    t.boolean('is_current').notNullable().defaultTo(true);
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('concluded_at', { useTz: true }).nullable();
    t.integer('concluded_by').nullable().references('id').inTable('users').onDelete('SET NULL');

    t.integer('row_version').notNullable().defaultTo(1);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(
    `ALTER TABLE "problem_analyses" ADD CONSTRAINT problem_analyses_method_ck CHECK (${inList(
      'method', ANALYSIS_METHODS,
    )})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "problem_analyses" ADD CONSTRAINT problem_analyses_state_ck CHECK (${inList(
      'state', ANALYSIS_STATES,
    )})`,
  );
  await knex.schema.raw(
    'ALTER TABLE "problem_analyses" ADD CONSTRAINT problem_analyses_row_version_ck CHECK (row_version >= 1)',
  );
  // HARD RULE 12 in the schema: typing into a cause node autosaves and
  // validates nothing. Completeness is demanded only at the CONCLUDE
  // transition, by the same evaluator on both sides. This CHECK bites there
  // and nowhere else.
  await knex.schema.raw(
    `ALTER TABLE "problem_analyses" ADD CONSTRAINT problem_analyses_concluded_ck CHECK (
       state <> 'concluded'
       OR (root_cause_id IS NOT NULL AND concluded_at IS NOT NULL AND concluded_by IS NOT NULL))`,
  );

  await knex.schema.raw(
    'CREATE UNIQUE INDEX problem_analyses_current_uq ON problem_analyses (problem_ticket_id) WHERE is_current',
  );
  await knex.schema.raw(
    'CREATE INDEX problem_analyses_problem ON problem_analyses (tenant_id, problem_ticket_id, started_at DESC)',
  );

  await knex.schema.raw(
    `COMMENT ON TABLE problem_analyses IS
     'One RCA attempt. A superseded analysis is never rewritten: the conclusion that turned out to be wrong is the most valuable row in a post-mortem.'`,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 3 — problem_causes: ONE tree, two methods
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Five whys is a degenerate tree (every node has exactly one child).
  // Ishikawa is a depth-2 tree rooted in categories. Same structure. Two
  // tables would mean two editors, two evaluators, two reporting queries, and
  // a forced re-keying the day a team starts from a fishbone and then digs one
  // rib five-whys deep — which is the normal case, not the exotic one.

  await knex.schema.createTable('problem_causes', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE')
      .comment('Its own tenant_id although it has a parent: the RCA statistics query reads (tenant, category, confidence) without touching the analysis. Same precedent as escalation_fires in 004.');
    t.integer('analysis_id').notNullable()
      .references('id').inTable('problem_analyses').onDelete('CASCADE');
    t.bigInteger('parent_cause_id').nullable()
      .references('id').inTable('problem_causes').onDelete('CASCADE');

    t.smallint('depth').notNullable().defaultTo(0)
      .comment('The number of the "why". 0 is a fishbone category head or the first why.');
    t.integer('sort_order').notNullable().defaultTo(0);

    // NOT NULL on EVERY node, five-whys chains included. That is what makes
    // "40% of our root causes are process causes" computable ACROSS the two
    // methods; a category that only existed on fishbones would make the
    // statistic wrong by construction. The classic 6M are replaced by this set
    // because in IT half of real root causes are a supplier or an internal
    // policy, and none of the 6M names either.
    t.string('category', 24).notNullable().defaultTo('unknown');

    t.string('statement', 512).notNullable()
      .comment('Capped on purpose: a cause you cannot say in one sentence is two causes.');
    t.text('detail_md').nullable();

    t.string('kind', 16).notNullable().defaultTo('cause')
      .comment("cause | contributing | trigger | non_cause. 'non_cause' earns its slot: \"we checked the firewall, it was not the firewall\" is a RESULT, and a team that cannot record a ruled-out branch re-investigates it next quarter.");

    t.string('confidence', 12).notNullable().defaultTo('suspected');
    t.string('confirmation_method', 24).nullable()
      .comment('The name of the method states the strength of the proof: fix_verified (we fixed it and it stopped) outranks expert_review (someone senior agreed), and a report that blends the two lies.');
    t.timestamp('confirmed_at', { useTz: true }).nullable();
    t.integer('confirmed_by').nullable().references('id').inTable('users').onDelete('SET NULL')
      .comment('A human, always. An automation may propose a cause; it may not confirm one.');

    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('row_version').notNullable().defaultTo(1);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(
    `ALTER TABLE "problem_causes" ADD CONSTRAINT problem_causes_category_ck CHECK (${inList(
      'category', CAUSE_CATEGORIES,
    )})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "problem_causes" ADD CONSTRAINT problem_causes_kind_ck CHECK (${inList(
      'kind', CAUSE_KINDS,
    )})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "problem_causes" ADD CONSTRAINT problem_causes_confidence_ck CHECK (${inList(
      'confidence', CAUSE_CONFIDENCES,
    )})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "problem_causes" ADD CONSTRAINT problem_causes_confirmation_method_ck CHECK (
       confirmation_method IS NULL OR ${inList('confirmation_method', CAUSE_CONFIRMATION_METHODS)})`,
  );
  await knex.schema.raw(
    'ALTER TABLE "problem_causes" ADD CONSTRAINT problem_causes_depth_ck CHECK (depth BETWEEN 0 AND 12)',
  );
  await knex.schema.raw(
    'ALTER TABLE "problem_causes" ADD CONSTRAINT problem_causes_parent_ck CHECK (parent_cause_id IS NULL OR parent_cause_id <> id)',
  );
  await knex.schema.raw(
    'ALTER TABLE "problem_causes" ADD CONSTRAINT problem_causes_row_version_ck CHECK (row_version >= 1)',
  );
  // Confirming costs a named human AND a named method. The THIRD requirement —
  // at least one problem_cause_evidence row — is carried by the shared
  // evaluator, not by a trigger: a trigger refusing the UPDATE until the
  // evidence exists would impose an insertion order on the API and break on
  // the first bundle import. An evaluator that lists "evidence is missing" is
  // readable and replayable. Without all three, `confirmed` degenerates into a
  // checkbox inside a week and `confidence` stops being information.
  await knex.schema.raw(
    `ALTER TABLE "problem_causes" ADD CONSTRAINT problem_causes_confirmed_ck CHECK (
       confidence NOT IN ('confirmed', 'refuted')
       OR (confirmation_method IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))`,
  );

  // The tree walk: children of a node, in order.
  await knex.schema.raw(
    'CREATE INDEX problem_causes_analysis ON problem_causes (analysis_id, parent_cause_id, sort_order)',
  );
  // The one report that ever justifies problem management at a budget review:
  // "our top three root-cause categories".
  await knex.schema.raw(
    "CREATE INDEX problem_causes_stats ON problem_causes (tenant_id, category, confidence) " +
    "WHERE confidence = 'confirmed'",
  );

  await knex.schema.raw(
    `COMMENT ON TABLE problem_causes IS
     'One adjacency-list tree serving both five whys (degenerate chain) and Ishikawa (depth-2). category is NOT NULL on every node so cause statistics are comparable across both methods.'`,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 4 — problem_cause_evidence: we point at artefacts, we never copy
  // ══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('problem_cause_evidence', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE')
      .comment('Its own tenant_id: every FK below points at a tenant-scoped row, and a link assembled without the tenant in hand is how one crosses tenants.');
    t.bigInteger('cause_id').notNullable()
      .references('id').inTable('problem_causes').onDelete('CASCADE');

    t.string('evidence_type', 16).notNullable();

    // ticket_evidence is the frozen snapshot 002 already models (an Obliview
    // metric window, a log excerpt, a config diff). Attaching one creates a
    // ticket_evidence row ON THE PROBLEM TICKET and then a link here. There is
    // no second evidence store.
    t.integer('ticket_evidence_id').nullable()
      .references('id').inTable('ticket_evidence').onDelete('CASCADE');
    t.integer('ci_id').nullable().references('id').inTable('cis').onDelete('SET NULL');
    t.integer('alert_id').nullable().references('id').inTable('suite_alerts').onDelete('SET NULL');
    t.integer('ticket_id').nullable().references('id').inTable('tickets').onDelete('SET NULL');
    t.bigInteger('journal_id').nullable()
      .references('id').inTable('ticket_journal').onDelete('SET NULL');
    t.integer('kb_article_id').nullable()
      .references('id').inTable('kb_articles').onDelete('SET NULL');
    t.text('external_url').nullable().comment('The vendor advisory.');

    t.string('note', 512).nullable()
      .comment('WHY this artefact proves the cause. Without it, in six months nobody knows what the graph was supposed to show and the evidence is an ornament.');

    t.integer('added_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('captured_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(
    `ALTER TABLE "problem_cause_evidence" ADD CONSTRAINT problem_cause_evidence_type_ck CHECK (${inList(
      'evidence_type', EVIDENCE_TYPES,
    )})`,
  );
  // Exactly one target, on the model of ticket_watcher_who_ck.
  await knex.schema.raw(
    `ALTER TABLE "problem_cause_evidence" ADD CONSTRAINT problem_cause_evidence_target_ck CHECK (
       (ticket_evidence_id IS NOT NULL)::int
     + (ci_id IS NOT NULL)::int
     + (alert_id IS NOT NULL)::int
     + (ticket_id IS NOT NULL)::int
     + (journal_id IS NOT NULL)::int
     + (kb_article_id IS NOT NULL)::int
     + (external_url IS NOT NULL)::int = 1)`,
  );

  await knex.schema.raw(
    'CREATE INDEX problem_cause_evidence_cause ON problem_cause_evidence (cause_id, captured_at DESC)',
  );
  await knex.schema.raw(
    'CREATE INDEX problem_cause_evidence_alert ON problem_cause_evidence (tenant_id, alert_id) WHERE alert_id IS NOT NULL',
  );
  await knex.schema.raw(
    'CREATE INDEX problem_cause_evidence_ticket ON problem_cause_evidence (tenant_id, ticket_id) WHERE ticket_id IS NOT NULL',
  );
  // One link per (cause, artefact): clicking "attach" twice attaches once.
  for (const column of [
    'ticket_evidence_id',
    'ci_id',
    'alert_id',
    'ticket_id',
    'journal_id',
    'kb_article_id',
  ]) {
    await knex.schema.raw(
      `CREATE UNIQUE INDEX problem_cause_evidence_${column}_uq ` +
      `ON problem_cause_evidence (cause_id, ${column}) WHERE ${column} IS NOT NULL`,
    );
  }

  await knex.schema.raw(
    `COMMENT ON TABLE problem_cause_evidence IS
     'Polymorphic link from a cause to an artefact that already exists. No attachment_id column on purpose: a screenshot is an attachment_links row with entity_type = problem_cause, so HARD RULE 9 keeps its single refcount.'`,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 5 — problem_alert_signatures: the CURATED known-error / alert bond
  // ══════════════════════════════════════════════════════════════════════════
  //
  // `suite_alerts.ticket_id` cannot stand in for this: it says which ticket ONE
  // alert opened, not which dedupe keys an engineer has declared equivalent to
  // this known error. This table is what lets alert.service route an inbound
  // alert straight onto the known error and stamp the workaround into the
  // incident's first internal note. Without it the bond would have to be
  // textual, which is exactly what a machine-generated key exists to avoid.

  await knex.schema.createTable('problem_alert_signatures', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('problem_ticket_id').notNullable()
      .references('ticket_id').inTable('problems').onDelete('CASCADE');

    t.string('source_app', 32).notNullable();
    t.specificType('dedupe_key', 'citext').notNullable()
      .comment('Matched against suite_alerts.dedupe_key. Exact machine identity, never a similarity.');

    t.integer('added_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['tenant_id', 'source_app', 'dedupe_key', 'problem_ticket_id'], {
      indexName: 'problem_alert_signatures_uq',
    });
  });

  // Same anti-discharge guarantee as suite_alerts: no key, no binding.
  await knex.schema.raw(
    `ALTER TABLE "problem_alert_signatures" ADD CONSTRAINT problem_alert_signatures_key_ck
     CHECK (btrim(dedupe_key::text) <> '')`,
  );
  await knex.schema.raw(
    'CREATE INDEX problem_alert_signatures_lookup ON problem_alert_signatures (tenant_id, source_app, dedupe_key)',
  );
  await knex.schema.raw(
    'CREATE INDEX problem_alert_signatures_problem ON problem_alert_signatures (problem_ticket_id)',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 6 — problem_candidates: the suggestion box, with its headstone
  // ══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('problem_candidates', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');

    // THE stable identity, deterministic per signal family:
    //   ci:<ci_id> · alert:<source_app>:<dedupe_key> · queue:<queue_slug>
    //   reopen:<ci_id|queue_slug> · kemiss:<problem_ticket_id>
    //   text:<sha256 of the 8 sorted leading tokens of lower(unaccent(subject))>
    // It is what stops the detector spamming, and it is the doctrine
    // suite_alerts already proved rather than a reinvention of it.
    t.specificType('signature', 'citext').notNullable();

    t.string('state', 16).notNullable().defaultTo('proposed');
    t.decimal('score', 5, 4).notNullable()
      .comment('Noisy-OR over saturated signals, 0..1. Not a weighted sum: a sum lets three weak signals clear a threshold, noisy-OR saturates and never exceeds 1.');
    t.jsonb('signals').notNullable().defaultTo(knex.raw("'{}'::jsonb"))
      .comment('The answer to "why was this proposed?", per signal: observed, threshold, saturation, weight.');

    t.string('title', 512).notNullable();

    // Denormalised anchors so the board renders without opening `signals`.
    t.integer('ci_id').nullable().references('id').inTable('cis').onDelete('SET NULL');
    t.specificType('dedupe_key', 'citext').nullable();
    t.specificType('queue_slug', 'citext').nullable();
    t.integer('incident_count').notNullable().defaultTo(0);

    t.timestamp('window_start', { useTz: true }).notNullable();
    t.timestamp('window_end', { useTz: true }).notNullable();

    // WHICH published config proposed it (HARD RULES 3 and 4) — the same pair
    // decision_log carries. A candidate proposed by a config nobody can
    // retrieve as it stood is a candidate nobody can explain.
    t.string('detector_slug', 128).notNullable();
    t.integer('detector_version').notNullable();

    t.integer('occurrence_count').notNullable().defaultTo(1)
      .comment('A re-detection BUMPS this row. It never inserts a second one: the suite_alerts doctrine, reused.');
    t.timestamp('proposed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.timestamp('decided_at', { useTz: true }).nullable();
    t.integer('decided_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('decision_note', 512).nullable();
    t.integer('problem_ticket_id').nullable()
      .references('id').inTable('tickets').onDelete('SET NULL');

    // THE anti-loop column. A rejected row is not deleted: it is the headstone,
    // consulted BEFORE anything is created, and it keeps the reason for the
    // refusal attached to the evidence that motivated it. No separate
    // suppression table: fewer moving parts, and one fact in one place.
    t.timestamp('suppressed_until', { useTz: true }).nullable();
    t.integer('superseded_candidate_id').nullable()
      .references('id').inTable('problem_candidates').onDelete('SET NULL')
      .comment('Set when a suppressed signature is re-proposed early because the evidence materially worsened. A suppression with no way out turns a refusal into amnesia: the day it truly gets worse, the system goes quiet.');
  });

  await knex.schema.raw(
    `ALTER TABLE "problem_candidates" ADD CONSTRAINT problem_candidates_state_ck CHECK (${inList(
      'state', CANDIDATE_STATES,
    )})`,
  );
  await knex.schema.raw(
    'ALTER TABLE "problem_candidates" ADD CONSTRAINT problem_candidates_score_ck CHECK (score >= 0 AND score <= 1)',
  );
  await knex.schema.raw(
    `ALTER TABLE "problem_candidates" ADD CONSTRAINT problem_candidates_accepted_ck CHECK (
       state <> 'accepted' OR problem_ticket_id IS NOT NULL)`,
  );
  await knex.schema.raw(
    `ALTER TABLE "problem_candidates" ADD CONSTRAINT problem_candidates_rejected_ck CHECK (
       state <> 'rejected' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))`,
  );
  await knex.schema.raw(
    'ALTER TABLE "problem_candidates" ADD CONSTRAINT problem_candidates_window_ck CHECK (window_end >= window_start)',
  );
  await knex.schema.raw(
    'ALTER TABLE "problem_candidates" ADD CONSTRAINT problem_candidates_occurrence_ck CHECK (occurrence_count >= 1)',
  );

  // ONE live card per signature. A re-detection bumps; it does not create.
  await knex.schema.raw(
    "CREATE UNIQUE INDEX problem_candidates_live_uq ON problem_candidates (tenant_id, signature) " +
    "WHERE state IN ('proposed', 'accepted')",
  );
  // The headstone lookup, run before any creation.
  await knex.schema.raw(
    'CREATE INDEX problem_candidates_tomb ON problem_candidates (tenant_id, signature, suppressed_until DESC) ' +
    'WHERE suppressed_until IS NOT NULL',
  );
  // The review board: best first.
  await knex.schema.raw(
    "CREATE INDEX problem_candidates_board ON problem_candidates (tenant_id, score DESC, proposed_at DESC) " +
    "WHERE state = 'proposed'",
  );
  await knex.schema.raw(
    'CREATE INDEX problem_candidates_problem ON problem_candidates (problem_ticket_id) WHERE problem_ticket_id IS NOT NULL',
  );

  await knex.schema.raw(
    `COMMENT ON TABLE problem_candidates IS
     'One live card per signature (partial unique index). A rejected row is kept as the headstone and consulted before any new proposal: a detector that can emit 200 cards produces zero attention.'`,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 7 — problem_candidate_tickets: the incidents that make the case
  // ══════════════════════════════════════════════════════════════════════════
  //
  // A link table and not an int[]: an array carries no foreign key, and a
  // deleted incident would leave a phantom id the board would still render.

  await knex.schema.createTable('problem_candidate_tickets', (t) => {
    t.integer('candidate_id').notNullable()
      .references('id').inTable('problem_candidates').onDelete('CASCADE');
    t.integer('ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('signal', 24).notNullable().comment('WHICH signal retained this ticket.');
    t.decimal('contribution', 5, 4).nullable();
    t.primary(['candidate_id', 'ticket_id']);
  });

  await knex.schema.raw(
    `ALTER TABLE "problem_candidate_tickets" ADD CONSTRAINT problem_candidate_tickets_signal_ck CHECK (${inList(
      'signal', DETECTION_SIGNALS,
    )})`,
  );
  await knex.schema.raw(
    'CREATE INDEX problem_candidate_tickets_ticket ON problem_candidate_tickets (tenant_id, ticket_id)',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 8 — Deferred FK + the indexes the detector needs on 002 tables
  // ══════════════════════════════════════════════════════════════════════════

  await knex.schema.raw(
    'ALTER TABLE "problems" ADD CONSTRAINT problems_candidate_fk ' +
    'FOREIGN KEY (candidate_id) REFERENCES problem_candidates(id) ON DELETE SET NULL',
  );

  // S1 (repetition on a CI) groups live incidents by their occurrence instant.
  // No 002 index covers (tenant, record_type, when it happened), and coalesce()
  // is IMMUTABLE so the expression index is legal.
  await knex.schema.raw(
    'CREATE INDEX tickets_tenant_type_occurred ON tickets ' +
    '(tenant_id, record_type, (coalesce(occurred_at, created_at)) DESC) WHERE deleted_at IS NULL',
  );
  // S2 (a dedupe key that keeps coming back) counts CLEARED cycles.
  // suite_alerts_live and suite_alerts_dedupe_live are both partial on
  // `cleared_at IS NULL`, so they are blind to exactly the rows this signal is.
  await knex.schema.raw(
    'CREATE INDEX suite_alerts_dedupe_history ON suite_alerts (tenant_id, dedupe_key, last_seen_at DESC)',
  );
  // S4 (reopen pressure). A ticket reopened twice was never fixed.
  await knex.schema.raw(
    'CREATE INDEX tickets_reopened ON tickets (tenant_id, primary_ci_id, updated_at DESC) ' +
    'WHERE reopen_count >= 2 AND deleted_at IS NULL',
  );
}

export async function down(knex: Knex): Promise<void> {
  // Reverse dependency order throughout.
  await knex.schema.raw('DROP INDEX IF EXISTS tickets_reopened');
  await knex.schema.raw('DROP INDEX IF EXISTS suite_alerts_dedupe_history');
  await knex.schema.raw('DROP INDEX IF EXISTS tickets_tenant_type_occurred');

  await knex.schema.raw('ALTER TABLE "problems" DROP CONSTRAINT IF EXISTS problems_candidate_fk');

  await knex.schema.dropTableIfExists('problem_candidate_tickets');
  await knex.schema.dropTableIfExists('problem_candidates');
  await knex.schema.dropTableIfExists('problem_alert_signatures');
  await knex.schema.dropTableIfExists('problem_cause_evidence');
  await knex.schema.dropTableIfExists('problem_causes');
  await knex.schema.dropTableIfExists('problem_analyses');

  await knex.schema.raw('DROP TRIGGER IF EXISTS problems_search_tsv_biu ON problems');
  await knex.schema.dropTableIfExists('problems');
  await knex.schema.raw('DROP FUNCTION IF EXISTS problems_search_tsv_trigger()');

  // citext / pg_trgm / unaccent are owned by 001_oblidesk_core.ts — a sibling
  // module still needs them, so they are intentionally not dropped.
}
