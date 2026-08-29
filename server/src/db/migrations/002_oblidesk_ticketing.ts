import type { Knex } from 'knex';

/**
 * 002_oblidesk_ticketing.ts
 *
 * "The desk" — every table that makes Oblidesk a service desk rather than a
 * generic multi-tenant shell. 001_oblidesk_core.ts owns auth, tenancy, RBAC,
 * config_objects, audit_log, decision_log and notifications; everything here
 * builds on top of those.
 *
 * Tables created (dependency order, NOT spec order):
 *
 *   Directory
 *     organizations, portal_contacts, assignment_groups, ticket_sequences
 *
 *   CMDB (mirror + desk-owned overlay)
 *     cis, ci_source_links, ci_overlays, ci_state_cache
 *
 *   Business time
 *     calendars, calendar_shifts, calendar_holidays
 *
 *   Commercials
 *     rate_cards, contracts
 *
 *   The ticket itself
 *     tickets, ticket_journal, ticket_link, ticket_watcher, ticket_participant,
 *     ticket_cis, ticket_evidence
 *
 *   Attachments (metadata only — bytes live under CUSTOM_DIR)
 *     attachments, attachment_links
 *
 *   Mail
 *     mail_accounts, mail_messages, mail_suppressions
 *
 *   Engines
 *     sla_instances, sla_ledger, rule_executions
 *
 *   Suite integration
 *     suite_alerts
 *
 *   Time & knowledge
 *     time_entries, kb_articles, kb_article_versions, kb_feedback
 *
 *   Approvals
 *     approvals, approval_steps
 *
 *   Analytics
 *     dashboards, dashboard_widgets, metric_daily_rollup,
 *     satisfaction_responses, saved_view_counts
 *
 *   AI
 *     ai_suggestions, ai_usage_ledger
 *
 * ── Invariants enforced at the schema level ──────────────────────────────────
 *  1. Every table holding tenant data carries
 *     tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE.
 *     The only exceptions are pure child rows whose ONLY parent is itself
 *     tenant-scoped and cascades (calendar_shifts, calendar_holidays,
 *     kb_article_versions) — those inherit tenancy through the parent FK and
 *     are unreachable except through a scoped join.
 *  5. tickets.status_category is a hard-coded enum, CHECK-constrained here.
 *     Statuses (status_slug) are configurable; the CATEGORY is not, and every
 *     engine keys off the category.
 *  6. tickets.occurred_at is captured at intake and is NOT created_at.
 *  7. tickets.row_version drives optimistic concurrency (409 on mismatch).
 *  8. No pgvector. Search is to_tsvector('simple', unaccent(...)) + pg_trgm.
 *  9. attachments UNIQUE(tenant_id, content_hash) — dedupe is PER TENANT,
 *     never a global blob pool. attachment_links is the refcount.
 */

// ── Hard-coded status categories (HARD RULE 5) ───────────────────────────────
const STATUS_CATEGORIES = [
  'new',
  'open',
  'pending_requester',
  'pending_third_party',
  'scheduled',
  'resolved',
  'closed',
  'cancelled',
] as const;

/**
 * The categories a ticket is considered "live" in. Used by every partial index
 * on the hot views so the planner only ever walks the working set, not the
 * years of closed history behind it.
 */
const OPEN_CATEGORIES = [
  'new',
  'open',
  'pending_requester',
  'pending_third_party',
  'scheduled',
] as const;

const OPEN_PREDICATE =
  `deleted_at IS NULL AND status_category IN (${OPEN_CATEGORIES.map((c) => `'${c}'`).join(', ')})`;

/** `col IN ('a', 'b')` — small helper so CHECK bodies stay readable. */
function inList(col: string, values: readonly string[]): string {
  return `"${col}" IN (${values.map((v) => `'${v}'`).join(', ')})`;
}

export async function up(knex: Knex): Promise<void> {
  // Extensions are created by 001_oblidesk_core.ts. Re-asserting them here is
  // idempotent and keeps 002 runnable in isolation (test fixtures, partial
  // rebuilds) without depending on the order of a sibling migration.
  await knex.schema.raw('CREATE EXTENSION IF NOT EXISTS citext');
  await knex.schema.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await knex.schema.raw('CREATE EXTENSION IF NOT EXISTS unaccent');

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — Directory: who reports, who fixes, how tickets are numbered
  // ══════════════════════════════════════════════════════════════════════════

  // organizations — the customer/company a ticket belongs to. `domains` lets
  // inbound mail be attributed to an org without a pre-existing contact.
  await knex.schema.createTable('organizations', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 200).notNullable();
    t.specificType('slug', 'citext').notNullable();
    t.specificType('domains', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
    t.string('external_ref', 200).nullable()
      .comment('Opaque id in the customer CRM / billing system. Never joined on.');
    t.timestamps(true, true);
    t.unique(['tenant_id', 'slug'], { indexName: 'organizations_tenant_slug_uq' });
  });
  await knex.schema.raw('CREATE INDEX organizations_domains_gin ON organizations USING GIN ("domains")');

  // portal_contacts — a requester. May or may not have a login (user_id).
  await knex.schema.createTable('portal_contacts', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.specificType('email', 'citext').notNullable();
    t.string('display_name', 200).nullable();
    t.string('phone', 64).nullable();
    t.integer('organization_id').nullable()
      .references('id').inTable('organizations').onDelete('SET NULL');
    t.integer('user_id').nullable().references('id').inTable('users').onDelete('SET NULL')
      .comment('Set when the contact also holds an Oblidesk login.');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.string('locale', 10).notNullable().defaultTo('en');
    t.timestamps(true, true);
    t.unique(['tenant_id', 'email'], { indexName: 'portal_contacts_tenant_email_uq' });
  });
  await knex.schema.raw('CREATE INDEX portal_contacts_tenant_org ON portal_contacts (tenant_id, organization_id)');
  await knex.schema.raw('CREATE INDEX portal_contacts_user ON portal_contacts (user_id) WHERE user_id IS NOT NULL');
  await knex.schema.raw(
    'CREATE INDEX portal_contacts_name_trgm ON portal_contacts USING GIN (display_name gin_trgm_ops)',
  );

  // assignment_groups — the fixing side. Referenced everywhere by SLUG
  // (HARD RULE 3); member_user_ids is denormalised for fast "my groups" reads.
  await knex.schema.createTable('assignment_groups', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.specificType('slug', 'citext').notNullable();
    t.string('name', 200).notNullable();
    t.text('description').nullable();
    t.specificType('member_user_ids', 'int[]').notNullable().defaultTo(knex.raw("'{}'::int[]"));
    t.string('email', 255).nullable().comment('Group mailbox used as the From/Reply-To for its queues.');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamps(true, true);
    t.unique(['tenant_id', 'slug'], { indexName: 'assignment_groups_tenant_slug_uq' });
  });
  await knex.schema.raw(
    'CREATE INDEX assignment_groups_members_gin ON assignment_groups USING GIN ("member_user_ids")',
  );

  // ticket_sequences — human ticket numbers (ACME-1042). One row per tenant;
  // the allocator takes a row lock, so numbers are gapless per tenant.
  await knex.schema.createTable('ticket_sequences', (t) => {
    t.integer('tenant_id').primary().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('prefix', 16).notNullable().defaultTo('TKT');
    t.bigInteger('last_number').notNullable().defaultTo(0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — CMDB: a mirror of the suite, plus desk-owned overlay
  // ══════════════════════════════════════════════════════════════════════════

  // cis — configuration items. Oblidesk is NEVER the source of truth for a CI's
  // inventory data: it mirrors Obliance/Obliguard/etc. via ci_source_links and
  // stores only desk-owned attributes in ci_overlays.
  await knex.schema.createTable('cis', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('kind', 24).notNullable().defaultTo('other');
    t.string('display_name', 255).notNullable();
    t.specificType('hardware_uuid', 'citext').nullable()
      .comment('Cross-app CI identity. NULL for CIs the desk invented itself.');
    t.string('criticality', 16).nullable();
    t.integer('owner_contact_id').nullable()
      .references('id').inTable('portal_contacts').onDelete('SET NULL');
    t.integer('support_group_id').nullable()
      .references('id').inTable('assignment_groups').onDelete('SET NULL');
    t.timestamp('first_seen_at', { useTz: true }).nullable();
    t.timestamp('last_seen_at', { useTz: true }).nullable();
    t.timestamp('deleted_at', { useTz: true }).nullable();
  });
  await knex.schema.raw(
    `ALTER TABLE "cis" ADD CONSTRAINT cis_kind_ck CHECK (${inList('kind', [
      'device', 'monitor', 'host', 'network', 'service', 'identity', 'other',
    ])})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "cis" ADD CONSTRAINT cis_criticality_ck CHECK (criticality IS NULL OR ${inList(
      'criticality', ['critical', 'high', 'medium', 'low'],
    )})`,
  );
  // hardware_uuid is NULLable, and Postgres treats NULLs as distinct — so this
  // constrains only the CIs that actually carry a cross-app identity.
  await knex.schema.raw(
    'CREATE UNIQUE INDEX cis_tenant_hwuuid_uq ON cis (tenant_id, hardware_uuid) WHERE hardware_uuid IS NOT NULL',
  );
  await knex.schema.raw('CREATE INDEX cis_tenant_kind ON cis (tenant_id, kind) WHERE deleted_at IS NULL');
  await knex.schema.raw('CREATE INDEX cis_name_trgm ON cis USING GIN (display_name gin_trgm_ops)');

  // ci_source_links — where this CI is mirrored FROM. One row per source app.
  await knex.schema.createTable('ci_source_links', (t) => {
    t.increments('id').primary();
    t.integer('ci_id').notNullable().references('id').inTable('cis').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('app_type', 32).notNullable().comment('obliance | obliguard | obligate | …');
    t.string('external_id', 128).notNullable();
    t.string('external_path', 512).nullable();
    t.text('url').nullable().comment('Deep link back into the owning app.');
    t.timestamp('last_fetched_at', { useTz: true }).nullable();
    t.jsonb('payload').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.unique(['ci_id', 'app_type', 'external_id'], { indexName: 'ci_source_links_uq' });
  });
  await knex.schema.raw('CREATE INDEX ci_source_links_lookup ON ci_source_links (tenant_id, app_type, external_id)');

  // ci_overlays — desk-owned attributes ONLY. Never mirror a source field here;
  // if the source owns it, read it through ci_source_links.payload instead.
  await knex.schema.createTable('ci_overlays', (t) => {
    t.increments('id').primary();
    t.integer('ci_id').notNullable().references('id').inTable('cis').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('key', 128).notNullable();
    t.jsonb('value').notNullable().defaultTo(knex.raw("'null'::jsonb"));
    t.unique(['ci_id', 'key'], { indexName: 'ci_overlays_ci_key_uq' });
  });

  // ci_state_cache — last known liveness, refreshed by the suite poller. Pure
  // cache: safe to TRUNCATE, never a source of truth.
  await knex.schema.createTable('ci_state_cache', (t) => {
    t.integer('ci_id').primary().references('id').inTable('cis').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.boolean('online').nullable();
    t.jsonb('state').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp('observed_at', { useTz: true }).nullable();
  });
  await knex.schema.raw('CREATE INDEX ci_state_cache_tenant ON ci_state_cache (tenant_id, online)');

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 3 — Business time
  // ══════════════════════════════════════════════════════════════════════════

  // calendars — the runtime projection of the `calendar` config_objects. The
  // config_object is the source of truth; publishing writes these rows.
  await knex.schema.createTable('calendars', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.specificType('slug', 'citext').notNullable();
    t.string('name', 128).notNullable();
    t.string('timezone', 64).notNullable().defaultTo('Europe/Paris');
    t.boolean('is_default').notNullable().defaultTo(false);
    t.unique(['tenant_id', 'slug'], { indexName: 'calendars_tenant_slug_uq' });
  });
  await knex.schema.raw(
    'CREATE UNIQUE INDEX calendars_one_default ON calendars (tenant_id) WHERE is_default',
  );

  // calendar_shifts — minutes-from-midnight in the calendar's own timezone.
  // weekday is ISO-8601: 1 = Monday … 7 = Sunday.
  // Tenancy is inherited through calendar_id (ON DELETE CASCADE); these rows
  // are unreachable except through an already tenant-scoped calendar.
  await knex.schema.createTable('calendar_shifts', (t) => {
    t.increments('id').primary();
    t.integer('calendar_id').notNullable().references('id').inTable('calendars').onDelete('CASCADE');
    t.integer('weekday').notNullable();
    t.integer('start_minute').notNullable();
    t.integer('end_minute').notNullable();
  });
  await knex.schema.raw(
    'ALTER TABLE "calendar_shifts" ADD CONSTRAINT calendar_shifts_weekday_ck CHECK (weekday BETWEEN 1 AND 7)',
  );
  await knex.schema.raw(
    'ALTER TABLE "calendar_shifts" ADD CONSTRAINT calendar_shifts_range_ck ' +
    'CHECK (start_minute >= 0 AND end_minute <= 1440 AND end_minute > start_minute)',
  );
  await knex.schema.raw('CREATE INDEX calendar_shifts_cal ON calendar_shifts (calendar_id, weekday)');

  // calendar_holidays — full non-working days. Half-days are modelled as a
  // shift override, not here.
  await knex.schema.createTable('calendar_holidays', (t) => {
    t.increments('id').primary();
    t.integer('calendar_id').notNullable().references('id').inTable('calendars').onDelete('CASCADE');
    t.date('day').notNullable();
    t.string('name', 128).nullable();
    t.unique(['calendar_id', 'day'], { indexName: 'calendar_holidays_uq' });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 4 — Commercials
  // ══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('rate_cards', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.specificType('slug', 'citext').notNullable();
    t.string('name', 128).notNullable();
    t.decimal('hourly_rate', 12, 2).notNullable().defaultTo(0);
    t.string('currency', 3).notNullable().defaultTo('EUR');
    t.jsonb('conditions').notNullable().defaultTo(knex.raw("'{}'::jsonb"))
      .comment('ConditionNode deciding when this card applies (out-of-hours, P1, …).');
    t.unique(['tenant_id', 'slug'], { indexName: 'rate_cards_tenant_slug_uq' });
  });

  await knex.schema.createTable('contracts', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('organization_id').notNullable()
      .references('id').inTable('organizations').onDelete('CASCADE');
    t.string('name', 200).notNullable();
    t.string('kind', 24).notNullable().defaultTo('block_hours');
    t.integer('total_minutes').nullable();
    t.integer('consumed_minutes').notNullable().defaultTo(0);
    t.date('period_start').nullable();
    t.date('period_end').nullable();
    t.specificType('sla_policy_slug', 'citext').nullable()
      .comment('Cross-reference by SLUG into config_objects(kind=sla). HARD RULE 3.');
    t.boolean('is_active').notNullable().defaultTo(true);
  });
  await knex.schema.raw(
    `ALTER TABLE "contracts" ADD CONSTRAINT contracts_kind_ck CHECK (${inList('kind', [
      'block_hours', 'retainer', 'per_ticket', 'unlimited',
    ])})`,
  );
  await knex.schema.raw(
    'CREATE INDEX contracts_tenant_org ON contracts (tenant_id, organization_id) WHERE is_active',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 5 — The ticket
  // ══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('tickets', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');

    t.string('record_type', 16).notNullable().defaultTo('incident');
    t.specificType('number', 'citext').notNullable()
      .comment('Human ticket number, e.g. ACME-1042. Allocated from ticket_sequences.');
    t.string('subject', 512).notNullable();
    t.text('description_md').nullable();
    t.text('description_html').nullable();

    // ── State (HARD RULE 5) ────────────────────────────────────────────────
    t.specificType('status_slug', 'citext').notNullable()
      .comment('Configurable status. Engines NEVER key off this — they key off status_category.');
    t.string('status_category', 24).notNullable()
      .comment('Hard-coded category enum. The contract every engine reads.');

    t.specificType('priority_slug', 'citext').notNullable().defaultTo('p3');
    t.string('impact', 16).nullable();
    t.string('urgency', 16).nullable();

    // ── Routing ────────────────────────────────────────────────────────────
    t.specificType('queue_slug', 'citext').notNullable().defaultTo('general');
    t.integer('assignment_group_id').nullable()
      .references('id').inTable('assignment_groups').onDelete('SET NULL');
    t.integer('assignee_id').nullable().references('id').inTable('users').onDelete('SET NULL');

    // ── Who ────────────────────────────────────────────────────────────────
    t.integer('requester_contact_id').nullable()
      .references('id').inTable('portal_contacts').onDelete('SET NULL');
    t.integer('requester_user_id').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    t.integer('organization_id').nullable()
      .references('id').inTable('organizations').onDelete('SET NULL');
    t.integer('primary_ci_id').nullable().references('id').inTable('cis').onDelete('SET NULL');

    t.string('source', 16).notNullable().defaultTo('web');

    // ── Time (HARD RULE 6) ─────────────────────────────────────────────────
    t.timestamp('occurred_at', { useTz: true }).nullable()
      .comment(
        'When the incident ACTUALLY happened, captured at intake. Distinct from created_at ' +
        '(when the ticket was filed). This is what makes Rewind possible and it can never be ' +
        'backfilled — if it was not asked for at intake it is gone.',
      );
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('first_response_at', { useTz: true }).nullable();
    t.timestamp('resolved_at', { useTz: true }).nullable();
    t.timestamp('closed_at', { useTz: true }).nullable();
    t.timestamp('due_at', { useTz: true }).nullable()
      .comment('Denormalised earliest live SLA due date. Authoritative copy is sla_instances.');

    // ── Relationships ──────────────────────────────────────────────────────
    t.integer('reopen_count').notNullable().defaultTo(0);
    t.integer('parent_ticket_id').nullable().references('id').inTable('tickets').onDelete('SET NULL');
    t.integer('merged_into_id').nullable().references('id').inTable('tickets').onDelete('SET NULL')
      .comment('A merge NEVER moves journal rows. See ticket_journal.');

    // ── Outcome ────────────────────────────────────────────────────────────
    t.string('resolution_code', 64).nullable();
    t.text('resolution_md').nullable();
    t.smallint('csat_score').nullable();

    // ── Payload ────────────────────────────────────────────────────────────
    t.jsonb('data').notNullable().defaultTo(knex.raw("'{}'::jsonb"))
      .comment('Custom field values, keyed by field config_object slug.');
    t.jsonb('set_by').notNullable().defaultTo(knex.raw("'{}'::jsonb"))
      .comment(
        'Per-field provenance: { "<field>": { "actor_type": "automation", "actor": "rule:auto_assign_by_queue", ' +
        '"at": "…" } }. Lets the UI say WHY a field holds its value without replaying decision_log.',
      );

    // ── Concurrency (HARD RULE 7) ──────────────────────────────────────────
    t.integer('row_version').notNullable().defaultTo(1)
      .comment('Optimistic concurrency. Mutations send a base version; a mismatch is a 409 + current row.');

    t.timestamp('deleted_at', { useTz: true }).nullable();

    // ── Search (HARD RULE 8 — no pgvector) ─────────────────────────────────
    t.specificType('search_tsv', 'tsvector').nullable()
      .comment('Maintained by tickets_search_tsv_trigger(). Never written by application code.');
  });

  await knex.schema.raw(
    `ALTER TABLE "tickets" ADD CONSTRAINT tickets_record_type_ck CHECK (${inList('record_type', [
      'incident', 'request', 'problem', 'change', 'task', 'release',
    ])})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "tickets" ADD CONSTRAINT tickets_status_category_ck CHECK (${inList(
      'status_category', STATUS_CATEGORIES,
    )})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "tickets" ADD CONSTRAINT tickets_source_ck CHECK (${inList('source', [
      'web', 'email', 'portal', 'api', 'alert', 'phone', 'chat',
    ])})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "tickets" ADD CONSTRAINT tickets_impact_ck CHECK (impact IS NULL OR ${inList(
      'impact', ['high', 'medium', 'low'],
    )})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "tickets" ADD CONSTRAINT tickets_urgency_ck CHECK (urgency IS NULL OR ${inList(
      'urgency', ['high', 'medium', 'low'],
    )})`,
  );
  await knex.schema.raw(
    'ALTER TABLE "tickets" ADD CONSTRAINT tickets_csat_ck CHECK (csat_score IS NULL OR csat_score BETWEEN 1 AND 5)',
  );
  await knex.schema.raw(
    'ALTER TABLE "tickets" ADD CONSTRAINT tickets_row_version_ck CHECK (row_version >= 1)',
  );
  await knex.schema.raw(
    'ALTER TABLE "tickets" ADD CONSTRAINT tickets_no_self_merge_ck CHECK (merged_into_id IS NULL OR merged_into_id <> id)',
  );
  await knex.schema.raw(
    'ALTER TABLE "tickets" ADD CONSTRAINT tickets_no_self_parent_ck CHECK (parent_ticket_id IS NULL OR parent_ticket_id <> id)',
  );

  // ── tickets indexes ────────────────────────────────────────────────────────
  await knex.schema.raw('CREATE UNIQUE INDEX tickets_tenant_number_uq ON tickets (tenant_id, "number")');
  await knex.schema.raw('CREATE INDEX tickets_data_gin ON tickets USING GIN ("data")');
  await knex.schema.raw('CREATE INDEX tickets_search_gin ON tickets USING GIN (search_tsv)');
  await knex.schema.raw('CREATE INDEX tickets_subject_trgm ON tickets USING GIN (subject gin_trgm_ops)');
  await knex.schema.raw(
    'CREATE INDEX tickets_tenant_cat_updated ON tickets (tenant_id, status_category, updated_at DESC)',
  );
  await knex.schema.raw(
    'CREATE INDEX tickets_tenant_assignee_cat ON tickets (tenant_id, assignee_id, status_category)',
  );
  await knex.schema.raw('CREATE INDEX tickets_tenant_queue ON tickets (tenant_id, queue_slug)');
  await knex.schema.raw('CREATE INDEX tickets_tenant_org ON tickets (tenant_id, organization_id)');
  await knex.schema.raw('CREATE INDEX tickets_tenant_requester ON tickets (tenant_id, requester_contact_id)');
  await knex.schema.raw('CREATE INDEX tickets_parent ON tickets (parent_ticket_id) WHERE parent_ticket_id IS NOT NULL');
  await knex.schema.raw('CREATE INDEX tickets_merged_into ON tickets (merged_into_id) WHERE merged_into_id IS NOT NULL');
  await knex.schema.raw('CREATE INDEX tickets_primary_ci ON tickets (tenant_id, primary_ci_id) WHERE primary_ci_id IS NOT NULL');

  // Partial indexes for the hot saved views. Each one covers the working set
  // only — closed history never enters them, so they stay small forever.
  await knex.schema.raw(
    `CREATE INDEX tickets_open_by_assignee ON tickets (tenant_id, assignee_id, updated_at DESC) WHERE ${OPEN_PREDICATE}`,
  );
  await knex.schema.raw(
    `CREATE INDEX tickets_open_by_queue ON tickets (tenant_id, queue_slug, priority_slug, updated_at DESC) WHERE ${OPEN_PREDICATE}`,
  );
  await knex.schema.raw(
    `CREATE INDEX tickets_open_unassigned ON tickets (tenant_id, queue_slug, created_at) WHERE assignee_id IS NULL AND ${OPEN_PREDICATE}`,
  );
  await knex.schema.raw(
    `CREATE INDEX tickets_breaching_soon ON tickets (tenant_id, due_at) WHERE due_at IS NOT NULL AND ${OPEN_PREDICATE}`,
  );

  // ── tickets.search_tsv trigger ─────────────────────────────────────────────
  // unaccent() is STABLE, not IMMUTABLE, so this can never be a generated
  // column or an expression index — it has to be a real column kept current by
  // a trigger. 'simple' (not 'english') because tenants file tickets in mixed
  // languages and stemming one of them wrongly is worse than not stemming.
  await knex.schema.raw(`
    CREATE FUNCTION tickets_search_tsv_trigger() RETURNS trigger AS $$
    BEGIN
      NEW.search_tsv := to_tsvector(
        'simple',
        unaccent(coalesce(NEW.subject, '') || ' ' || coalesce(NEW.description_md, ''))
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await knex.schema.raw(`
    CREATE TRIGGER tickets_search_tsv_biu
      BEFORE INSERT OR UPDATE OF subject, description_md ON tickets
      FOR EACH ROW EXECUTE FUNCTION tickets_search_tsv_trigger()
  `);

  // ── ticket_journal ────────────────────────────────────────────────────────
  // The append-only conversation + system trail of one ticket.
  //
  // seq is per-ticket and gapless, and UNIQUE(ticket_id, seq) is the guard.
  //
  // A MERGE NEVER MOVES JOURNAL ROWS. Merging ticket B into ticket A writes:
  //   • a ticket_link (B → A, kind 'merged_from'),
  //   • tickets.merged_into_id on B,
  //   • exactly ONE synthesised journal row of kind 'merge' on each side.
  // The original rows stay on the ticket they were written against, so seq
  // stays stable, permalinks keep resolving, and an un-merge is a link delete
  // rather than an archaeological dig.
  await knex.schema.createTable('ticket_journal', (t) => {
    t.bigIncrements('id').primary();
    t.integer('ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('seq').notNullable().comment('Per-ticket, 1-based, gapless. Never renumbered.');
    t.string('kind', 24).notNullable();
    t.string('visibility', 12).notNullable().defaultTo('internal');
    t.integer('author_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('author_contact_id').nullable()
      .references('id').inTable('portal_contacts').onDelete('SET NULL');
    t.string('author_type', 16).notNullable().defaultTo('user');
    t.text('body_md').nullable();
    t.text('body_html').nullable();
    t.jsonb('meta').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['ticket_id', 'seq'], { indexName: 'ticket_journal_ticket_seq_uq' });
  });
  await knex.schema.raw(
    `ALTER TABLE "ticket_journal" ADD CONSTRAINT ticket_journal_kind_ck CHECK (${inList('kind', [
      'public_reply', 'work_note', 'system', 'state_change', 'assignment', 'attachment',
      'ai_suggestion', 'automation', 'approval', 'time', 'merge', 'alert',
    ])})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "ticket_journal" ADD CONSTRAINT ticket_journal_visibility_ck CHECK (${inList(
      'visibility', ['public', 'internal'],
    )})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "ticket_journal" ADD CONSTRAINT ticket_journal_author_type_ck CHECK (${inList(
      'author_type', ['user', 'contact', 'system', 'automation', 'ai', 'portal'],
    )})`,
  );
  await knex.schema.raw(
    'ALTER TABLE "ticket_journal" ADD CONSTRAINT ticket_journal_seq_ck CHECK (seq >= 1)',
  );
  await knex.schema.raw('CREATE INDEX ticket_journal_tenant_created ON ticket_journal (tenant_id, created_at DESC)');
  // The portal only ever reads public rows — give it its own small index.
  await knex.schema.raw(
    "CREATE INDEX ticket_journal_public ON ticket_journal (ticket_id, seq) WHERE visibility = 'public'",
  );

  // ticket_link — every relationship between two tickets, including merges.
  await knex.schema.createTable('ticket_link', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('from_ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.integer('to_ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.string('kind', 16).notNullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['from_ticket_id', 'to_ticket_id', 'kind'], { indexName: 'ticket_link_uq' });
  });
  await knex.schema.raw(
    `ALTER TABLE "ticket_link" ADD CONSTRAINT ticket_link_kind_ck CHECK (${inList('kind', [
      'related', 'duplicate', 'blocks', 'caused_by', 'child', 'merged_from',
    ])})`,
  );
  await knex.schema.raw(
    'ALTER TABLE "ticket_link" ADD CONSTRAINT ticket_link_not_self_ck CHECK (from_ticket_id <> to_ticket_id)',
  );
  await knex.schema.raw('CREATE INDEX ticket_link_to ON ticket_link (to_ticket_id, kind)');
  await knex.schema.raw('CREATE INDEX ticket_link_tenant ON ticket_link (tenant_id)');

  // ticket_watcher — notification subscribers. Exactly one of user_id /
  // contact_id is set; the CHECK makes a watcher who watches nothing impossible.
  await knex.schema.createTable('ticket_watcher', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.integer('user_id').nullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('contact_id').nullable().references('id').inTable('portal_contacts').onDelete('CASCADE');
    t.string('reason', 32).nullable().comment('manual | assignee | escalation | rule:<slug> | …');
  });
  await knex.schema.raw(
    'ALTER TABLE "ticket_watcher" ADD CONSTRAINT ticket_watcher_who_ck ' +
    'CHECK ((user_id IS NOT NULL)::int + (contact_id IS NOT NULL)::int = 1)',
  );
  await knex.schema.raw(
    'CREATE UNIQUE INDEX ticket_watcher_user_uq ON ticket_watcher (ticket_id, user_id) WHERE user_id IS NOT NULL',
  );
  await knex.schema.raw(
    'CREATE UNIQUE INDEX ticket_watcher_contact_uq ON ticket_watcher (ticket_id, contact_id) WHERE contact_id IS NOT NULL',
  );

  // ticket_participant — the mail envelope of the ticket (requester / cc / bcc).
  await knex.schema.createTable('ticket_participant', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.integer('contact_id').notNullable()
      .references('id').inTable('portal_contacts').onDelete('CASCADE');
    t.string('role', 16).notNullable().defaultTo('cc');
    t.unique(['ticket_id', 'contact_id', 'role'], { indexName: 'ticket_participant_uq' });
  });
  await knex.schema.raw(
    `ALTER TABLE "ticket_participant" ADD CONSTRAINT ticket_participant_role_ck CHECK (${inList(
      'role', ['requester', 'cc', 'bcc'],
    )})`,
  );

  // ticket_cis — the CIs a ticket touches. primary/affected/cause.
  await knex.schema.createTable('ticket_cis', (t) => {
    t.integer('ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.integer('ci_id').notNullable().references('id').inTable('cis').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('role', 16).notNullable().defaultTo('affected');
    t.primary(['ticket_id', 'ci_id']);
  });
  await knex.schema.raw(
    `ALTER TABLE "ticket_cis" ADD CONSTRAINT ticket_cis_role_ck CHECK (${inList('role', [
      'primary', 'affected', 'cause',
    ])})`,
  );
  await knex.schema.raw('CREATE INDEX ticket_cis_ci ON ticket_cis (tenant_id, ci_id)');

  // ticket_evidence — a frozen snapshot pulled from another suite app at a
  // point in time. Immutable: never updated, only added to.
  await knex.schema.createTable('ticket_evidence', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.string('kind', 48).notNullable().comment('metric_window | log_excerpt | config_diff | screenshot | …');
    t.string('source_app', 32).nullable();
    t.timestamp('captured_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.jsonb('payload').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
  });
  await knex.schema.raw('CREATE INDEX ticket_evidence_ticket ON ticket_evidence (ticket_id, captured_at DESC)');
  await knex.schema.raw('CREATE INDEX ticket_evidence_tenant ON ticket_evidence (tenant_id)');

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 6 — Attachments (HARD RULE 9)
  // ══════════════════════════════════════════════════════════════════════════

  // attachments — METADATA ONLY. The bytes live on disk at
  //   /custom/attachments/<tenant_id>/<yyyy>/<mm>/<sha256[0:2]>/<sha256>
  // UNIQUE(tenant_id, content_hash): dedupe is scoped PER TENANT. A global
  // blob pool would leak the existence of one tenant's file to another and
  // make a tenant delete unsafe — never do it.
  await knex.schema.createTable('attachments', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('content_hash', 64).notNullable().comment('sha256 hex of the bytes.');
    t.string('mime', 191).nullable();
    t.bigInteger('byte_size').notNullable().defaultTo(0);
    t.string('filename', 512).nullable();
    t.text('storage_key').notNullable()
      .comment('Path under CUSTOM_DIR. Derived from tenant_id + date + hash — never user input.');
    t.string('scan_status', 12).notNullable().defaultTo('pending');
    t.integer('uploaded_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['tenant_id', 'content_hash'], { indexName: 'attachments_tenant_hash_uq' });
  });
  await knex.schema.raw(
    `ALTER TABLE "attachments" ADD CONSTRAINT attachments_scan_status_ck CHECK (${inList(
      'scan_status', ['pending', 'clean', 'infected', 'skipped'],
    )})`,
  );
  await knex.schema.raw(
    'ALTER TABLE "attachments" ADD CONSTRAINT attachments_hash_ck CHECK (char_length(content_hash) = 64)',
  );

  // attachment_links — THE REFCOUNT. A blob dies when its last link dies; the
  // sweeper deletes the file only when no attachment_links row remains.
  await knex.schema.createTable('attachment_links', (t) => {
    t.increments('id').primary();
    t.integer('attachment_id').notNullable()
      .references('id').inTable('attachments').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('entity_type', 32).notNullable().comment('ticket | journal | kb_article | mail_message | …');
    t.bigInteger('entity_id').notNullable();
    t.string('inline_cid', 191).nullable().comment('Content-ID for images embedded in an HTML body.');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['attachment_id', 'entity_type', 'entity_id'], { indexName: 'attachment_links_uq' });
  });
  await knex.schema.raw(
    'CREATE INDEX attachment_links_entity ON attachment_links (tenant_id, entity_type, entity_id)',
  );
  await knex.schema.raw('CREATE INDEX attachment_links_attachment ON attachment_links (attachment_id)');

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 7 — Mail
  // ══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('mail_accounts', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 128).notNullable();
    t.string('kind', 16).notNullable().defaultTo('imap');
    t.jsonb('config').notNullable().defaultTo(knex.raw("'{}'::jsonb"))
      .comment('Host/port/auth. Secrets are stored encrypted with ENCRYPTION_KEY, never in clear.');
    t.specificType('queue_slug', 'citext').nullable()
      .comment('Queue new mail lands in. Cross-reference by SLUG (HARD RULE 3).');
    t.jsonb('health').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp('last_seen_at', { useTz: true }).nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
  });
  await knex.schema.raw(
    `ALTER TABLE "mail_accounts" ADD CONSTRAINT mail_accounts_kind_ck CHECK (${inList('kind', [
      'imap', 'graph', 'webhook',
    ])})`,
  );
  await knex.schema.raw('CREATE INDEX mail_accounts_tenant ON mail_accounts (tenant_id) WHERE is_active');

  // mail_messages — one row per RFC-822 message seen, in either direction.
  // UNIQUE(tenant_id, message_id) is the idempotency guard: a mailbox replay,
  // a double-delivery or a restarted IMAP cursor can never fork a thread.
  await knex.schema.createTable('mail_messages', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('mail_account_id').nullable()
      .references('id').inTable('mail_accounts').onDelete('SET NULL');
    t.specificType('message_id', 'citext').notNullable().comment('RFC-822 Message-ID, angle brackets stripped.');
    t.specificType('references_ids', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
    t.specificType('in_reply_to', 'citext').nullable();
    t.string('direction', 4).notNullable();
    t.integer('ticket_id').nullable().references('id').inTable('tickets').onDelete('SET NULL');
    t.bigInteger('journal_id').nullable()
      .references('id').inTable('ticket_journal').onDelete('SET NULL');
    t.text('raw_key').nullable().comment('Path under CUSTOM_DIR to the raw .eml, for forensics.');
    t.string('raw_hash', 64).nullable();
    t.jsonb('parsed').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.specificType('from_address', 'citext').nullable();
    t.specificType('to_addresses', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
    t.text('subject').nullable();
    t.timestamp('received_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['tenant_id', 'message_id'], { indexName: 'mail_messages_tenant_msgid_uq' });
  });
  await knex.schema.raw(
    `ALTER TABLE "mail_messages" ADD CONSTRAINT mail_messages_direction_ck CHECK (${inList(
      'direction', ['in', 'out'],
    )})`,
  );
  // Threading: match an incoming References: header against everything we know.
  await knex.schema.raw(
    'CREATE INDEX mail_messages_references_gin ON mail_messages USING GIN ("references_ids")',
  );
  await knex.schema.raw('CREATE INDEX mail_messages_ticket ON mail_messages (tenant_id, ticket_id)');
  await knex.schema.raw(
    'CREATE INDEX mail_messages_in_reply_to ON mail_messages (tenant_id, in_reply_to) WHERE in_reply_to IS NOT NULL',
  );
  await knex.schema.raw('CREATE INDEX mail_messages_received ON mail_messages (tenant_id, received_at DESC)');

  // mail_suppressions — hard bounces, unsubscribes and loop-breakers. Checked
  // before every outbound send.
  await knex.schema.createTable('mail_suppressions', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.specificType('address', 'citext').notNullable();
    t.string('reason', 64).nullable().comment('hard_bounce | complaint | unsubscribe | loop_detected');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['tenant_id', 'address'], { indexName: 'mail_suppressions_uq' });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 8 — Engines: SLA and rules
  // ══════════════════════════════════════════════════════════════════════════

  // sla_instances — one live clock per (ticket, target). policy_slug +
  // policy_version pin the policy AS IT WAS when the clock started, so editing
  // the SLA policy tomorrow cannot retroactively breach yesterday's tickets.
  await knex.schema.createTable('sla_instances', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.specificType('target_slug', 'citext').notNullable().comment('response | resolution | …');
    t.specificType('policy_slug', 'citext').notNullable();
    t.integer('policy_version').notNullable().defaultTo(1);
    t.specificType('calendar_slug', 'citext').notNullable();
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('due_at', { useTz: true }).nullable();
    t.bigInteger('paused_ms').notNullable().defaultTo(0);
    t.boolean('running').notNullable().defaultTo(true);
    t.string('status', 12).notNullable().defaultTo('running');
    t.timestamp('breached_at', { useTz: true }).nullable();
    t.timestamp('met_at', { useTz: true }).nullable();
    t.jsonb('resolved_via').nullable()
      .comment('What stopped the clock: { journal_id, kind, actor }. Makes a met SLA auditable.');
  });
  await knex.schema.raw(
    `ALTER TABLE "sla_instances" ADD CONSTRAINT sla_instances_status_ck CHECK (${inList('status', [
      'running', 'paused', 'met', 'breached', 'cancelled',
    ])})`,
  );
  // Exactly one LIVE clock per (ticket, target). Finished instances are left
  // alone so a reopen can start a fresh one without deleting history.
  await knex.schema.raw(
    "CREATE UNIQUE INDEX sla_instances_live_uq ON sla_instances (ticket_id, target_slug) " +
    "WHERE status IN ('running', 'paused')",
  );
  await knex.schema.raw(
    "CREATE INDEX sla_instances_due_scan ON sla_instances (tenant_id, due_at) WHERE status = 'running'",
  );
  await knex.schema.raw('CREATE INDEX sla_instances_ticket ON sla_instances (ticket_id)');

  // sla_ledger — every event that moved a clock, with the business ms already
  // elapsed BEFORE it. Replaying the ledger reproduces due_at exactly.
  //
  // UNIQUE(instance_id, event, at) makes the boot catch-up pass idempotent: a
  // restart mid-sweep re-emits the same (instance, event, at) triple and the
  // insert is a no-op instead of a double pause.
  await knex.schema.createTable('sla_ledger', (t) => {
    t.increments('id').primary();
    t.integer('instance_id').notNullable()
      .references('id').inTable('sla_instances').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.string('event', 16).notNullable();
    t.string('reason_code', 48).nullable();
    t.integer('actor_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.bigInteger('elapsed_business_ms_before').notNullable().defaultTo(0);
    t.timestamp('new_due_at', { useTz: true }).nullable();
    t.text('note').nullable();
    t.unique(['instance_id', 'event', 'at'], { indexName: 'sla_ledger_idempotency_uq' });
  });
  await knex.schema.raw(
    `ALTER TABLE "sla_ledger" ADD CONSTRAINT sla_ledger_event_ck CHECK (${inList('event', [
      'start', 'pause', 'resume', 'target_switch', 'breach', 'met', 'cancel',
    ])})`,
  );
  await knex.schema.raw('CREATE INDEX sla_ledger_instance ON sla_ledger (instance_id, at)');
  await knex.schema.raw('CREATE INDEX sla_ledger_tenant ON sla_ledger (tenant_id, at DESC)');

  // rule_executions — every rule evaluation, matched or not. Answers "why did
  // nothing happen?", which is the question decision_log alone cannot.
  await knex.schema.createTable('rule_executions', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('ticket_id').nullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.specificType('rule_slug', 'citext').notNullable();
    t.integer('rule_version').notNullable().defaultTo(1);
    t.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.boolean('matched').notNullable().defaultTo(false);
    t.jsonb('actions').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.text('error').nullable();
    t.integer('duration_ms').nullable();
    t.boolean('dry_run').notNullable().defaultTo(false);
  });
  await knex.schema.raw('CREATE INDEX rule_executions_rule ON rule_executions (tenant_id, rule_slug, at DESC)');
  await knex.schema.raw(
    'CREATE INDEX rule_executions_ticket ON rule_executions (ticket_id, at DESC) WHERE ticket_id IS NOT NULL',
  );
  await knex.schema.raw(
    'CREATE INDEX rule_executions_errors ON rule_executions (tenant_id, at DESC) WHERE error IS NOT NULL',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 9 — Suite alert intake
  // ══════════════════════════════════════════════════════════════════════════

  // suite_alerts — alerts pushed in from the other Obli* apps.
  //
  // THE ANTI-LANDFILL GUARANTEE: dedupe_key is NOT NULL and CHECK-constrained
  // non-empty. A source that cannot say "this is the same condition as before"
  // cannot bind an alert at all — so a flapping monitor collapses onto one row
  // with occurrence_count++, and can never fan out into ten thousand tickets.
  //
  // tenant_slug carries the ORIGINATING tenant's slug: cross-app identity joins
  // on SLUG, never a numeric tenant id (HARD RULE 13 — each app has its own
  // tenants table with its own autoincrement ids).
  await knex.schema.createTable('suite_alerts', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('source_app', 32).notNullable();
    t.specificType('dedupe_key', 'citext').notNullable();
    t.string('severity', 16).notNullable().defaultTo('warning');
    t.string('title', 512).notNullable();
    t.text('message').nullable();
    t.integer('ci_id').nullable().references('id').inTable('cis').onDelete('SET NULL');
    t.string('external_id', 128).nullable();
    t.specificType('tenant_slug', 'citext').nullable()
      .comment('Originating tenant SLUG from the source app. HARD RULE 13 — never a numeric id.');
    t.integer('occurrence_count').notNullable().defaultTo(1);
    t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('cleared_at', { useTz: true }).nullable();
    t.integer('ticket_id').nullable().references('id').inTable('tickets').onDelete('SET NULL');
    t.string('suppressed_reason', 64).nullable()
      .comment('Set when a binding matched but deliberately did NOT open a ticket.');
    t.jsonb('payload').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.unique(['tenant_id', 'dedupe_key', 'first_seen_at'], { indexName: 'suite_alerts_dedupe_uq' });
  });
  await knex.schema.raw(
    "ALTER TABLE \"suite_alerts\" ADD CONSTRAINT suite_alerts_dedupe_key_ck " +
    "CHECK (btrim(dedupe_key::text) <> '')",
  );
  await knex.schema.raw(
    `ALTER TABLE "suite_alerts" ADD CONSTRAINT suite_alerts_severity_ck CHECK (${inList('severity', [
      'critical', 'error', 'warning', 'info',
    ])})`,
  );
  await knex.schema.raw(
    'ALTER TABLE "suite_alerts" ADD CONSTRAINT suite_alerts_occurrence_ck CHECK (occurrence_count >= 1)',
  );
  // The open-alert board: only uncleared rows, newest first.
  await knex.schema.raw(
    'CREATE INDEX suite_alerts_live ON suite_alerts (tenant_id, severity, last_seen_at DESC) WHERE cleared_at IS NULL',
  );
  // The dedupe lookup on ingest: "is this condition already live?"
  await knex.schema.raw(
    'CREATE INDEX suite_alerts_dedupe_live ON suite_alerts (tenant_id, dedupe_key) WHERE cleared_at IS NULL',
  );
  await knex.schema.raw('CREATE INDEX suite_alerts_ticket ON suite_alerts (ticket_id) WHERE ticket_id IS NOT NULL');
  await knex.schema.raw('CREATE INDEX suite_alerts_ci ON suite_alerts (tenant_id, ci_id) WHERE ci_id IS NOT NULL');

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 10 — Time & knowledge
  // ══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('time_entries', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.integer('user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('started_at', { useTz: true }).nullable();
    t.timestamp('ended_at', { useTz: true }).nullable();
    t.integer('minutes').notNullable().defaultTo(0);
    t.boolean('billable').notNullable().defaultTo(true);
    t.specificType('rate_card_slug', 'citext').nullable()
      .comment('Cross-reference by SLUG into rate_cards. HARD RULE 3.');
    t.text('note').nullable();
    t.string('source', 20).notNullable().defaultTo('manual');
    t.string('external_ref', 200).nullable().comment('e.g. an Obliance remote session id.');
    t.timestamp('approved_at', { useTz: true }).nullable();
    t.integer('approved_by').nullable().references('id').inTable('users').onDelete('SET NULL');
  });
  await knex.schema.raw(
    `ALTER TABLE "time_entries" ADD CONSTRAINT time_entries_source_ck CHECK (${inList('source', [
      'manual', 'timer', 'remote_session',
    ])})`,
  );
  await knex.schema.raw(
    'ALTER TABLE "time_entries" ADD CONSTRAINT time_entries_minutes_ck CHECK (minutes >= 0)',
  );
  await knex.schema.raw('CREATE INDEX time_entries_ticket ON time_entries (ticket_id)');
  await knex.schema.raw('CREATE INDEX time_entries_user ON time_entries (tenant_id, user_id, started_at DESC)');
  await knex.schema.raw(
    'CREATE INDEX time_entries_unapproved ON time_entries (tenant_id, started_at) WHERE approved_at IS NULL AND billable',
  );

  await knex.schema.createTable('kb_articles', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.specificType('slug', 'citext').notNullable();
    t.string('title', 512).notNullable();
    t.text('body_md').nullable();
    t.text('body_html').nullable();
    t.string('locale', 10).notNullable().defaultTo('en');
    t.string('status', 12).notNullable().defaultTo('draft');
    t.string('category', 128).nullable();
    t.specificType('tags', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
    t.integer('author_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('reviewed_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('published_at', { useTz: true }).nullable();
    t.integer('views').notNullable().defaultTo(0);
    t.integer('helpful').notNullable().defaultTo(0);
    t.integer('unhelpful').notNullable().defaultTo(0);
    t.specificType('search_tsv', 'tsvector').nullable()
      .comment('Maintained by kb_articles_search_tsv_trigger(). Never written by application code.');
    t.unique(['tenant_id', 'slug', 'locale'], { indexName: 'kb_articles_tenant_slug_locale_uq' });
  });
  await knex.schema.raw(
    `ALTER TABLE "kb_articles" ADD CONSTRAINT kb_articles_status_ck CHECK (${inList('status', [
      'draft', 'review', 'published', 'retired',
    ])})`,
  );
  await knex.schema.raw('CREATE INDEX kb_articles_search_gin ON kb_articles USING GIN (search_tsv)');
  await knex.schema.raw('CREATE INDEX kb_articles_tags_gin ON kb_articles USING GIN ("tags")');
  await knex.schema.raw('CREATE INDEX kb_articles_title_trgm ON kb_articles USING GIN (title gin_trgm_ops)');
  await knex.schema.raw(
    "CREATE INDEX kb_articles_published ON kb_articles (tenant_id, locale, category) WHERE status = 'published'",
  );

  // Same shape as the ticket trigger, same reasoning: unaccent() is STABLE, so
  // the column has to be maintained rather than generated.
  await knex.schema.raw(`
    CREATE FUNCTION kb_articles_search_tsv_trigger() RETURNS trigger AS $$
    BEGIN
      NEW.search_tsv := to_tsvector(
        'simple',
        unaccent(coalesce(NEW.title, '') || ' ' || coalesce(NEW.body_md, ''))
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await knex.schema.raw(`
    CREATE TRIGGER kb_articles_search_tsv_biu
      BEFORE INSERT OR UPDATE OF title, body_md ON kb_articles
      FOR EACH ROW EXECUTE FUNCTION kb_articles_search_tsv_trigger()
  `);

  // kb_article_versions — tenancy inherited via article_id (CASCADE).
  await knex.schema.createTable('kb_article_versions', (t) => {
    t.increments('id').primary();
    t.integer('article_id').notNullable().references('id').inTable('kb_articles').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.text('body_md').nullable();
    t.integer('author_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.text('note').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['article_id', 'version'], { indexName: 'kb_article_versions_uq' });
  });

  await knex.schema.createTable('kb_feedback', (t) => {
    t.increments('id').primary();
    t.integer('article_id').notNullable().references('id').inTable('kb_articles').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.boolean('helpful').notNullable();
    t.text('comment').nullable();
    t.integer('contact_id').nullable()
      .references('id').inTable('portal_contacts').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.raw('CREATE INDEX kb_feedback_article ON kb_feedback (article_id, created_at DESC)');

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 11 — Approvals
  // ══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('approvals', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.specificType('definition_slug', 'citext').notNullable()
      .comment('config_objects(kind=approval).slug. HARD RULE 3.');
    t.string('state', 12).notNullable().defaultTo('pending');
    t.string('mode', 12).notNullable().defaultTo('sequential');
    t.integer('quorum').nullable().comment('Only meaningful when mode = quorum.');
    t.timestamp('due_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('decided_at', { useTz: true }).nullable();
  });
  await knex.schema.raw(
    `ALTER TABLE "approvals" ADD CONSTRAINT approvals_state_ck CHECK (${inList('state', [
      'pending', 'approved', 'rejected', 'expired', 'cancelled',
    ])})`,
  );
  await knex.schema.raw(
    `ALTER TABLE "approvals" ADD CONSTRAINT approvals_mode_ck CHECK (${inList('mode', [
      'sequential', 'parallel', 'quorum',
    ])})`,
  );
  await knex.schema.raw(
    "ALTER TABLE \"approvals\" ADD CONSTRAINT approvals_quorum_ck " +
    "CHECK (mode <> 'quorum' OR (quorum IS NOT NULL AND quorum >= 1))",
  );
  await knex.schema.raw('CREATE INDEX approvals_ticket ON approvals (ticket_id)');
  await knex.schema.raw(
    "CREATE INDEX approvals_pending ON approvals (tenant_id, due_at) WHERE state = 'pending'",
  );

  await knex.schema.createTable('approval_steps', (t) => {
    t.increments('id').primary();
    t.integer('approval_id').notNullable().references('id').inTable('approvals').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('step_index').notNullable().defaultTo(0);
    t.integer('approver_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('approver_group_id').nullable()
      .references('id').inTable('assignment_groups').onDelete('SET NULL');
    t.string('state', 12).notNullable().defaultTo('pending');
    t.timestamp('decided_at', { useTz: true }).nullable();
    t.text('comment').nullable();
  });
  await knex.schema.raw(
    `ALTER TABLE "approval_steps" ADD CONSTRAINT approval_steps_state_ck CHECK (${inList('state', [
      'pending', 'approved', 'rejected', 'expired', 'cancelled', 'skipped',
    ])})`,
  );
  // A step nobody can act on is a deadlock — make it impossible to create one.
  await knex.schema.raw(
    'ALTER TABLE "approval_steps" ADD CONSTRAINT approval_steps_approver_ck ' +
    'CHECK (approver_user_id IS NOT NULL OR approver_group_id IS NOT NULL)',
  );
  await knex.schema.raw('CREATE INDEX approval_steps_approval ON approval_steps (approval_id, step_index)');
  await knex.schema.raw(
    "CREATE INDEX approval_steps_my_queue ON approval_steps (tenant_id, approver_user_id) WHERE state = 'pending'",
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 12 — Analytics
  // ══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('dashboards', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.specificType('slug', 'citext').notNullable();
    t.string('name', 200).notNullable();
    t.integer('owner_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.boolean('is_shared').notNullable().defaultTo(false);
    t.boolean('is_default').notNullable().defaultTo(false);
    t.jsonb('layout').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.unique(['tenant_id', 'slug'], { indexName: 'dashboards_tenant_slug_uq' });
  });
  await knex.schema.raw(
    'CREATE UNIQUE INDEX dashboards_one_default ON dashboards (tenant_id) WHERE is_default',
  );

  await knex.schema.createTable('dashboard_widgets', (t) => {
    t.increments('id').primary();
    t.integer('dashboard_id').notNullable()
      .references('id').inTable('dashboards').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('tab_key', 64).notNullable().defaultTo('overview');
    t.integer('x').notNullable().defaultTo(0);
    t.integer('y').notNullable().defaultTo(0);
    t.integer('w').notNullable().defaultTo(3);
    t.integer('h').notNullable().defaultTo(2);
    t.string('widget_type', 48).notNullable();
    t.string('title', 200).nullable();
    t.jsonb('config').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.integer('sort_order').notNullable().defaultTo(0);
  });
  await knex.schema.raw(
    'ALTER TABLE "dashboard_widgets" ADD CONSTRAINT dashboard_widgets_size_ck CHECK (w >= 1 AND h >= 1)',
  );
  await knex.schema.raw(
    'CREATE INDEX dashboard_widgets_dash ON dashboard_widgets (dashboard_id, tab_key, sort_order)',
  );

  // metric_daily_rollup — one row per (day, metric, dimension set). `dimensions`
  // is part of the unique key: jsonb has a btree equality operator, so the
  // upsert target is exact rather than "whichever row we found first".
  await knex.schema.createTable('metric_daily_rollup', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.date('day').notNullable();
    t.string('metric_key', 96).notNullable();
    t.jsonb('dimensions').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.decimal('value', 18, 4).notNullable().defaultTo(0);
    t.unique(['tenant_id', 'day', 'metric_key', 'dimensions'], { indexName: 'metric_daily_rollup_uq' });
  });
  await knex.schema.raw(
    'CREATE INDEX metric_daily_rollup_series ON metric_daily_rollup (tenant_id, metric_key, "day")',
  );

  await knex.schema.createTable('satisfaction_responses', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.integer('contact_id').nullable()
      .references('id').inTable('portal_contacts').onDelete('SET NULL');
    t.integer('score').nullable();
    t.text('comment').nullable();
    t.timestamp('responded_at', { useTz: true }).nullable();
    t.string('token', 64).notNullable().unique()
      .comment('Single-use unguessable link token. Present before the response exists.');
  });
  await knex.schema.raw(
    'ALTER TABLE "satisfaction_responses" ADD CONSTRAINT satisfaction_responses_score_ck ' +
    'CHECK (score IS NULL OR score BETWEEN 1 AND 5)',
  );
  await knex.schema.raw(
    'CREATE UNIQUE INDEX satisfaction_responses_ticket_uq ON satisfaction_responses (ticket_id)',
  );
  await knex.schema.raw(
    'CREATE INDEX satisfaction_responses_scored ON satisfaction_responses (tenant_id, responded_at DESC) ' +
    'WHERE responded_at IS NOT NULL',
  );

  // saved_view_counts — a CACHE of the sidebar badge numbers. Safe to TRUNCATE;
  // a stale row is a wrong badge, never a wrong list.
  await knex.schema.createTable('saved_view_counts', (t) => {
    t.specificType('view_slug', 'citext').notNullable();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('count').notNullable().defaultTo(0);
    t.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['tenant_id', 'view_slug', 'user_id']);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 13 — AI
  // ══════════════════════════════════════════════════════════════════════════

  // ai_suggestions — a suggestion is never applied silently. `accepted` +
  // `accepted_by` record the human who took responsibility for it.
  await knex.schema.createTable('ai_suggestions', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('ticket_id').notNullable().references('id').inTable('tickets').onDelete('CASCADE');
    t.string('kind', 48).notNullable().comment('summary | reply_draft | category | dedupe | kb_link | …');
    t.jsonb('payload').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.decimal('confidence', 5, 4).nullable();
    t.string('engine', 16).notNullable().defaultTo('llm');
    t.string('model', 128).nullable();
    t.boolean('accepted').nullable().comment('NULL = not acted on yet, false = explicitly rejected.');
    t.integer('accepted_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('accepted_at', { useTz: true }).nullable();
    t.decimal('cost_usd', 12, 6).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.raw(
    `ALTER TABLE "ai_suggestions" ADD CONSTRAINT ai_suggestions_engine_ck CHECK (${inList('engine', [
      'llm', 'heuristic',
    ])})`,
  );
  await knex.schema.raw(
    'ALTER TABLE "ai_suggestions" ADD CONSTRAINT ai_suggestions_confidence_ck ' +
    'CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))',
  );
  await knex.schema.raw('CREATE INDEX ai_suggestions_ticket ON ai_suggestions (ticket_id, created_at DESC)');
  await knex.schema.raw(
    'CREATE INDEX ai_suggestions_pending ON ai_suggestions (tenant_id, created_at DESC) WHERE accepted IS NULL',
  );

  // ai_usage_ledger — every billable call, so an admin can see the spend per
  // feature before the invoice does.
  await knex.schema.createTable('ai_usage_ledger', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.string('feature', 64).notNullable();
    t.string('model', 128).nullable();
    t.integer('input_tokens').notNullable().defaultTo(0);
    t.integer('output_tokens').notNullable().defaultTo(0);
    t.decimal('cost_usd', 12, 6).notNullable().defaultTo(0);
    t.integer('ticket_id').nullable().references('id').inTable('tickets').onDelete('SET NULL');
  });
  await knex.schema.raw('CREATE INDEX ai_usage_ledger_tenant_at ON ai_usage_ledger (tenant_id, at DESC)');
  await knex.schema.raw('CREATE INDEX ai_usage_ledger_feature ON ai_usage_ledger (tenant_id, feature, at DESC)');
}

export async function down(knex: Knex): Promise<void> {
  // Triggers go with their tables, but the functions do not — drop them last.

  // AI
  await knex.schema.dropTableIfExists('ai_usage_ledger');
  await knex.schema.dropTableIfExists('ai_suggestions');

  // Analytics
  await knex.schema.dropTableIfExists('saved_view_counts');
  await knex.schema.dropTableIfExists('satisfaction_responses');
  await knex.schema.dropTableIfExists('metric_daily_rollup');
  await knex.schema.dropTableIfExists('dashboard_widgets');
  await knex.schema.dropTableIfExists('dashboards');

  // Approvals
  await knex.schema.dropTableIfExists('approval_steps');
  await knex.schema.dropTableIfExists('approvals');

  // Time & knowledge
  await knex.schema.dropTableIfExists('kb_feedback');
  await knex.schema.dropTableIfExists('kb_article_versions');
  await knex.schema.dropTableIfExists('kb_articles');
  await knex.schema.dropTableIfExists('time_entries');

  // Suite integration
  await knex.schema.dropTableIfExists('suite_alerts');

  // Engines
  await knex.schema.dropTableIfExists('rule_executions');
  await knex.schema.dropTableIfExists('sla_ledger');
  await knex.schema.dropTableIfExists('sla_instances');

  // Mail — mail_messages FKs ticket_journal, so it goes before the ticket tables.
  await knex.schema.dropTableIfExists('mail_suppressions');
  await knex.schema.dropTableIfExists('mail_messages');
  await knex.schema.dropTableIfExists('mail_accounts');

  // Attachments
  await knex.schema.dropTableIfExists('attachment_links');
  await knex.schema.dropTableIfExists('attachments');

  // The ticket
  await knex.schema.dropTableIfExists('ticket_evidence');
  await knex.schema.dropTableIfExists('ticket_cis');
  await knex.schema.dropTableIfExists('ticket_participant');
  await knex.schema.dropTableIfExists('ticket_watcher');
  await knex.schema.dropTableIfExists('ticket_link');
  await knex.schema.dropTableIfExists('ticket_journal');
  await knex.schema.dropTableIfExists('tickets');

  // Commercials
  await knex.schema.dropTableIfExists('contracts');
  await knex.schema.dropTableIfExists('rate_cards');

  // Business time
  await knex.schema.dropTableIfExists('calendar_holidays');
  await knex.schema.dropTableIfExists('calendar_shifts');
  await knex.schema.dropTableIfExists('calendars');

  // CMDB
  await knex.schema.dropTableIfExists('ci_state_cache');
  await knex.schema.dropTableIfExists('ci_overlays');
  await knex.schema.dropTableIfExists('ci_source_links');
  await knex.schema.dropTableIfExists('cis');

  // Directory
  await knex.schema.dropTableIfExists('ticket_sequences');
  await knex.schema.dropTableIfExists('assignment_groups');
  await knex.schema.dropTableIfExists('portal_contacts');
  await knex.schema.dropTableIfExists('organizations');

  // Trigger functions
  await knex.schema.raw('DROP FUNCTION IF EXISTS kb_articles_search_tsv_trigger()');
  await knex.schema.raw('DROP FUNCTION IF EXISTS tickets_search_tsv_trigger()');

  // Extensions are owned by 001_oblidesk_core.ts — intentionally not dropped
  // here, so rolling 002 back does not break a still-installed 001.
}
