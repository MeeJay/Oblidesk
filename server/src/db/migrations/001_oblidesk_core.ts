import type { Knex } from 'knex';

/**
 * 001_oblidesk_core.ts — the foundation.
 *
 * Everything that is NOT the service desk itself: identity, tenancy, RBAC,
 * platform configuration, the two append-only ledgers, the configuration
 * object store and the notification plumbing. Migration 002 builds the desk
 * (tickets, mail, SLA, CMDB, KB, billing…) on top of this.
 *
 * Tables created (in dependency order):
 *
 *   Extensions
 *     citext, pg_trgm, unaccent
 *     (there is NO pgvector — the deployment is postgres:16-alpine and search
 *      is to_tsvector('simple', unaccent(…)) + pg_trgm, see migration 002)
 *
 *   Core auth
 *     users, session, password_reset_tokens, sso_link_tokens
 *
 *   Multi-tenancy
 *     tenants, user_tenants
 *
 *   Teams & RBAC
 *     teams, team_memberships, permission_sets, user_permission_sets
 *
 *   Platform configuration
 *     app_config, settings
 *
 *   Ledgers (append-only)
 *     audit_log, decision_log
 *
 *   Configuration object store
 *     config_objects, config_object_versions
 *
 *   Notifications
 *     notification_channels, notification_bindings, notification_log,
 *     smtp_servers, notification_outbox
 *
 *   Live alert feed
 *     live_alerts
 *
 * Conventions used throughout (mirrored by migration 002):
 *   • HARD RULE 1 — every table holding tenant data has
 *     `tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`, and
 *     is reached in application code exclusively through `scoped()` in
 *     server/src/db/index.ts. The three platform-shared tables (settings,
 *     smtp_servers, notification_channels) have a NULLABLE tenant_id where
 *     NULL means "platform-wide"; they still CASCADE so deleting a tenant
 *     removes its own rows.
 *   • HARD RULE 3 — cross-references between configuration objects are by
 *     human SLUG (`*_slug` columns), never by numeric id.
 *   • Timestamps are `timestamptz`. `timestamps(true, true)` = created_at +
 *     updated_at, NOT NULL, default now().
 *   • Enum-ish columns are short varchars with the allowed values in a
 *     comment, not Postgres enums: the suite adds values over time and an
 *     ALTER TYPE on a live enum is a migration hazard.
 *   • This migration inserts NO data. The day-one baseline (default tenant,
 *     admin user, the is_system config_objects bundle) belongs to
 *     server/src/db/seeds/.
 */

export async function up(knex: Knex): Promise<void> {

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 0 — Extensions
  // ══════════════════════════════════════════════════════════════════════════

  // citext   — case-insensitive uniqueness for logins, slugs, e-mail addresses
  //            and Message-IDs without a lower() index on every lookup.
  // pg_trgm  — trigram indexes for fuzzy "subject contains…" search and for
  //            similarity() suggestions (duplicate ticket detection).
  // unaccent — folds accents so a French requester searching "reseau" finds
  //            "réseau". Used inside the tsvector expressions in 002.
  await knex.schema.raw('CREATE EXTENSION IF NOT EXISTS citext');
  await knex.schema.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await knex.schema.raw('CREATE EXTENSION IF NOT EXISTS unaccent');

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — Core auth
  // ══════════════════════════════════════════════════════════════════════════

  // users — local auth, TOTP/e-mail 2FA, preferences, locale, Obligate SSO link.
  //
  // Users are GLOBAL (not tenant-scoped): one account can work in several
  // tenants, and its per-tenant role/capabilities live in user_tenants.
  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();

    // citext: 'Admin' and 'admin' are the same login, enforced by the DB
    // rather than by every call site remembering to lower() the input.
    t.specificType('username', 'citext').notNullable().unique();

    // NULL for accounts that authenticate only through Obligate SSO or LDAP —
    // there is no local password to verify for those.
    t.string('password_hash', 255).nullable();

    t.string('display_name', 128).nullable();
    t.specificType('email', 'citext').nullable();

    // admin | manager | agent | user
    // (platform-level default role; the effective role inside a tenant comes
    //  from user_tenants.role and the permission sets)
    t.string('role', 16).notNullable().defaultTo('user');
    t.boolean('is_active').notNullable().defaultTo(true);

    // Data URI or /custom-relative path — see the avatar service.
    t.text('avatar').nullable();

    // Two-factor
    t.text('totp_secret').nullable();
    t.boolean('totp_enabled').notNullable().defaultTo(false);
    t.boolean('email_otp_enabled').notNullable().defaultTo(false);

    // Free-form per-user UI state (density, pinned views, column layouts…).
    t.jsonb('preferences').nullable().defaultTo(null);

    t.string('preferred_language', 10).notNullable().defaultTo('en');
    t.integer('enrollment_version').notNullable().defaultTo(0);

    // Obligate SSO: the user id on the Obligate side. Tenant identity across
    // apps joins on tenant SLUG (HARD RULE 13), but the USER link is a stable
    // numeric id issued by the single SSO provider, which is safe.
    t.integer('obligate_user_id').nullable();

    // local | obligate | ldap
    t.string('auth_source', 16).notNullable().defaultTo('local');

    t.timestamps(true, true);

    t.index('email', 'idx_users_email');
    t.index('is_active', 'idx_users_is_active');
  });
  await knex.schema.raw(
    `CREATE UNIQUE INDEX idx_users_obligate_user_id
       ON users (obligate_user_id) WHERE obligate_user_id IS NOT NULL`,
  );

  // session — owned by connect-pg-simple; the column names are its contract.
  await knex.schema.createTable('session', (t) => {
    t.string('sid').primary();
    t.json('sess').notNullable();
    t.timestamp('expire', { useTz: true }).notNullable();
  });
  await knex.schema.raw('CREATE INDEX idx_session_expire ON session (expire)');

  // password_reset_tokens — `token` holds the HASH of the value e-mailed to
  // the user, never the value itself.
  await knex.schema.createTable('password_reset_tokens', (t) => {
    t.increments('id').primary();
    t.integer('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.string('token', 255).notNullable().unique();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index('user_id', 'idx_password_reset_tokens_user');
  });
  await knex.schema.raw(
    `CREATE INDEX idx_password_reset_tokens_expires
       ON password_reset_tokens (expires_at) WHERE used_at IS NULL`,
  );

  // sso_link_tokens — one-time tokens for the Obligate account-linking flow.
  // `payload` carries the claims returned by Obligate (display name, e-mail,
  // tenant slugs, role) so the account can be provisioned on consumption
  // without a second round trip.
  await knex.schema.createTable('sso_link_tokens', (t) => {
    t.increments('id').primary();
    t.string('token', 128).notNullable().unique();
    t.integer('obligate_user_id').notNullable();
    t.jsonb('payload').notNullable().defaultTo('{}');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('consumed_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.raw(
    `CREATE INDEX idx_sso_link_tokens_pending
       ON sso_link_tokens (expires_at) WHERE consumed_at IS NULL`,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — Multi-tenancy
  // ══════════════════════════════════════════════════════════════════════════

  // tenants — created before everything tenant-scoped so the FKs resolve.
  //
  // `slug` is the cross-app identity (HARD RULE 13): every other Obli* app has
  // its own tenants table with its own autoincrement ids, so a suite alert or
  // a CI arriving from Obliguard/Obliance carries a tenant SLUG, never an id.
  // citext because "ACME" and "acme" must not be two tenants.
  await knex.schema.createTable('tenants', (t) => {
    t.increments('id').primary();
    t.specificType('slug', 'citext').notNullable().unique();
    t.string('name', 128).notNullable();

    // The master tenant sees across tenants (MSP console) — exactly one row
    // should carry this flag.
    t.boolean('is_master').notNullable().defaultTo(false);

    // Branding, business defaults, portal switches, feature flags.
    t.jsonb('settings').notNullable().defaultTo('{}');

    t.timestamps(true, true);
  });
  await knex.schema.raw(
    `CREATE INDEX idx_tenants_is_master ON tenants (is_master) WHERE is_master = true`,
  );

  // user_tenants — membership + per-tenant role and capability overrides.
  await knex.schema.createTable('user_tenants', (t) => {
    t.integer('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');

    // admin | manager | agent | user
    t.string('role', 16).notNullable().defaultTo('agent');

    // Extra capabilities granted (or explicitly denied) inside this tenant,
    // on top of whatever the user's permission sets already allow.
    t.jsonb('capabilities').nullable().defaultTo(null);

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.primary(['user_id', 'tenant_id']);
    t.index('tenant_id', 'idx_user_tenants_tenant');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 3 — Teams & RBAC
  // ══════════════════════════════════════════════════════════════════════════

  // teams — the human grouping (support L1, network, security…). Ticket
  // routing targets assignment_groups (migration 002); teams are about people
  // and permissions.
  await knex.schema.createTable('teams', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 128).notNullable();
    t.text('description').nullable();
    t.jsonb('capabilities').notNullable().defaultTo('[]');
    t.timestamps(true, true);

    t.unique(['tenant_id', 'name'], { indexName: 'uq_teams_tenant_name' });
    t.index('tenant_id', 'idx_teams_tenant');
  });

  await knex.schema.createTable('team_memberships', (t) => {
    t.integer('team_id').notNullable()
      .references('id').inTable('teams').onDelete('CASCADE');
    t.integer('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.primary(['team_id', 'user_id']);
    t.index('user_id', 'idx_team_memberships_user');
  });

  // permission_sets — named capability bundles assignable to users.
  // `is_system` rows are shipped by the seed bundle and are not editable in
  // the UI (they can be cloned).
  await knex.schema.createTable('permission_sets', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 128).notNullable();
    t.text('description').nullable();
    t.jsonb('capabilities').notNullable().defaultTo('[]');
    t.boolean('is_system').notNullable().defaultTo(false);
    t.timestamps(true, true);

    t.unique(['tenant_id', 'name'], { indexName: 'uq_permission_sets_tenant_name' });
    t.index('tenant_id', 'idx_permission_sets_tenant');
  });

  await knex.schema.createTable('user_permission_sets', (t) => {
    t.integer('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.integer('permission_set_id').notNullable()
      .references('id').inTable('permission_sets').onDelete('CASCADE');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.primary(['user_id', 'permission_set_id']);
    t.index('permission_set_id', 'idx_user_permission_sets_set');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 4 — Platform configuration
  // ══════════════════════════════════════════════════════════════════════════

  // app_config — platform-wide key/value (Obligate SSO url/apiKey/enabled,
  // AI provider config, 2FA policy…). Global on purpose: it configures the
  // installation, not a tenant. Values are jsonb so a key can hold an object.
  await knex.schema.createTable('app_config', (t) => {
    t.string('key', 64).primary();
    t.jsonb('value').notNullable();
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // settings — inheritance store. tenant_id NULL + scope 'global' is the
  // platform default; a tenant row overrides it for that tenant.
  await knex.schema.createTable('settings', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').nullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.string('scope', 16).notNullable().defaultTo('global'); // global | tenant
    t.string('key', 128).notNullable();
    t.jsonb('value').notNullable();
    t.timestamps(true, true);

    t.index('tenant_id', 'idx_settings_tenant');
  });
  // NULLs are distinct in a plain UNIQUE constraint, which would let two
  // global rows share a key. COALESCE(tenant_id, 0) closes that hole.
  await knex.schema.raw(
    `CREATE UNIQUE INDEX uq_settings_tenant_key
       ON settings ((COALESCE(tenant_id, 0)), key)`,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 5 — Ledgers (append-only)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * audit_log — APPEND-ONLY, HASH-CHAINED.
   *
   * Nothing in the application may UPDATE or DELETE a row here. Rows leave
   * only with their tenant (the FK cascade) or through an explicit, audited
   * retention job — which is also why the append-only property is enforced in
   * the audit service rather than by a database trigger: a BEFORE DELETE
   * trigger would make `DELETE FROM tenants` fail, and a rule that silently
   * swallowed writes would be worse than no rule at all.
   *
   * The chain: `hash` = sha256(prev_hash || canonical_json(row_without_hash)),
   * computed in the audit service inside the same transaction as the write;
   * `prev_hash` is the `hash` of the previous row FOR THE SAME TENANT (NULL on
   * the first row of a tenant). Verification walks a tenant's rows in id order
   * and recomputes — a tampered or removed row breaks the chain at that point.
   * UNIQUE (tenant_id, id) is what makes "the previous row of this tenant"
   * cheap to look up and locks the chain to its tenant.
   */
  await knex.schema.createTable('audit_log', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');

    // NULL when the actor is not a local user (system / automation / AI /
    // portal contact); ON DELETE SET NULL so history survives user deletion.
    t.integer('actor_id').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    // user | system | automation | ai | portal
    t.string('actor_type', 16).notNullable().defaultTo('user');

    t.string('action', 64).notNullable();       // 'ticket.assign', 'config.publish', …
    t.string('entity_type', 64).notNullable();  // 'ticket', 'config_object', 'user', …
    t.text('entity_id').nullable();             // numeric id OR slug, as text

    t.jsonb('before').nullable();
    t.jsonb('after').nullable();

    t.string('ip', 45).nullable();
    t.text('user_agent').nullable();

    t.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Hash chain — see the block comment above.
    t.string('prev_hash', 64).nullable();
    t.string('hash', 64).notNullable();

    t.unique(['tenant_id', 'id'], { indexName: 'uq_audit_log_tenant_id' });
  });
  await knex.schema.raw(
    'CREATE INDEX idx_audit_log_tenant_at ON audit_log (tenant_id, at DESC)',
  );
  await knex.schema.raw(
    `CREATE INDEX idx_audit_log_entity
       ON audit_log (tenant_id, entity_type, entity_id, at DESC)`,
  );
  await knex.schema.raw(
    'CREATE INDEX idx_audit_log_actor ON audit_log (tenant_id, actor_id, at DESC)',
  );
  await knex.schema.raw(
    'CREATE INDEX idx_audit_log_action ON audit_log (tenant_id, action, at DESC)',
  );
  await knex.schema.raw(
    `COMMENT ON TABLE audit_log IS
     'Append-only, hash-chained per tenant. Never UPDATE or DELETE a row: the chain (prev_hash -> hash) is computed by the audit service on the write path and any mutation invalidates every row after it.'`,
  );

  /**
   * decision_log — why the machine did what it did.
   *
   * HARD RULE 2: every engine (routing, priority, sla, assignment, escalation,
   * approval, rule, alert binding, ai, workflow) writes its row HERE, on the
   * SAME code path and in the same transaction as the action it explains.
   * These rows are never reconstructed after the fact — a reconstruction is a
   * guess, and a guess is exactly what an operator asking "why is this P1 and
   * why is it on Marie's queue?" must not be given.
   *
   * `ticket_id` is deliberately NOT a foreign key: tickets are created in
   * migration 002, and more importantly a decision must outlive a purged or
   * hard-deleted ticket. Rows are scoped by tenant_id like everything else.
   */
  await knex.schema.createTable('decision_log', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');

    // No FK — see the note above. Populated for ticket-bound decisions.
    t.integer('ticket_id').nullable();

    t.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // routing | priority | sla | assignment | escalation | approval | rule |
    // alert | ai | workflow
    t.string('subsystem', 24).notNullable();

    // Human-readable one-liner: 'priority set to P2 (impact=medium, urgency=high)'
    t.text('decision').notNullable();

    // Exactly what the engine saw…
    t.jsonb('inputs').notNullable().defaultTo('{}');
    // …which published configuration object it used (HARD RULE 3: by slug)…
    t.string('rule_slug', 128).nullable();
    t.integer('rule_version').nullable();
    // …and what it produced.
    t.jsonb('outcome').notNullable().defaultTo('{}');

    t.integer('duration_ms').nullable();
  });
  await knex.schema.raw(
    'CREATE INDEX idx_decision_log_ticket ON decision_log (tenant_id, ticket_id, at DESC)',
  );
  await knex.schema.raw(
    'CREATE INDEX idx_decision_log_subsystem ON decision_log (subsystem, at DESC)',
  );
  await knex.schema.raw(
    'CREATE INDEX idx_decision_log_tenant_at ON decision_log (tenant_id, at DESC)',
  );
  await knex.schema.raw(
    `CREATE INDEX idx_decision_log_rule
       ON decision_log (tenant_id, rule_slug, at DESC) WHERE rule_slug IS NOT NULL`,
  );
  await knex.schema.raw(
    `COMMENT ON TABLE decision_log IS
     'Written on the same code path as the action it explains (HARD RULE 2). Never reconstructed afterwards.'`,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 6 — Configuration object store
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * config_objects — the whole configurable surface of the desk in one table.
   *
   * kind ∈ field | form | view | rule | sla | state_machine | queue |
   *        priority_matrix | alert_binding | catalog_item |
   *        notification_template | dashboard | macro | calendar | escalation |
   *        approval
   *
   * `slug` is the identity that everything else references (HARD RULE 3):
   * bodies point at other objects by slug so a bundle can be exported from one
   * tenant and imported into another whose numeric ids differ.
   *
   * `body_format_version` is per KIND (HARD RULE 4). Changing the shape of a
   * body without bumping it is a defect — the readers dispatch on it.
   */
  await knex.schema.createTable('config_objects', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');

    t.string('kind', 32).notNullable();
    t.specificType('slug', 'citext').notNullable();
    t.string('name', 191).notNullable();
    t.text('description').nullable();

    t.jsonb('body').notNullable().defaultTo('{}');
    t.integer('body_format_version').notNullable().defaultTo(1);

    // draft | published | archived — engines read PUBLISHED objects only.
    t.string('status', 16).notNullable().defaultTo('draft');
    t.integer('version').notNullable().defaultTo(1);

    // Shipped by the seed bundle; clonable but not editable in place.
    t.boolean('is_system').notNullable().defaultTo(false);

    // MSP fan-out: when set, the master tenant pushes this object to these
    // tenants. NULL/empty = applies to its own tenant only.
    t.specificType('target_tenant_ids', 'integer[]').nullable();

    // sha256 of the canonical body — cheap "did this actually change?" test on
    // import and on publish.
    t.string('checksum', 64).nullable();

    t.integer('created_by').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['tenant_id', 'kind', 'slug'], { indexName: 'uq_config_objects_tenant_kind_slug' });
  });
  await knex.schema.raw(
    'CREATE INDEX idx_config_objects_kind_status ON config_objects (tenant_id, kind, status)',
  );
  await knex.schema.raw(
    'CREATE INDEX idx_config_objects_targets ON config_objects USING GIN (target_tenant_ids)',
  );
  await knex.schema.raw(
    'CREATE INDEX idx_config_objects_body ON config_objects USING GIN (body)',
  );
  await knex.schema.raw(
    'CREATE INDEX idx_config_objects_created_by ON config_objects (created_by)',
  );

  // config_object_versions — immutable history; publishing snapshots the body
  // so a decision_log row that names (rule_slug, rule_version) can always be
  // replayed against the exact body that produced it.
  await knex.schema.createTable('config_object_versions', (t) => {
    t.increments('id').primary();
    t.integer('config_object_id').notNullable()
      .references('id').inTable('config_objects').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.jsonb('body').notNullable();
    t.integer('body_format_version').notNullable().defaultTo(1);
    t.integer('author_id').nullable()
      .references('id').inTable('users').onDelete('SET NULL');
    t.text('note').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['config_object_id', 'version'], { indexName: 'uq_config_object_versions' });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 7 — Notifications
  // ══════════════════════════════════════════════════════════════════════════

  // notification_channels — tenant_id NULL = platform channel usable by every
  // tenant; non-null = owned by that tenant. CASCADE (not SET NULL) so a
  // deleted tenant's channel is removed instead of being promoted to global.
  await knex.schema.createTable('notification_channels', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').nullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 128).notNullable();
    // email | webhook | slack | teams | discord | sms | …
    t.string('type', 32).notNullable();
    t.jsonb('config').notNullable().defaultTo('{}');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamps(true, true);

    t.index('tenant_id', 'idx_notification_channels_tenant');
  });

  // notification_bindings — which events feed which channel, with optional
  // conditions (queue slug, priority slug, category…). Inherits its tenant
  // from the channel.
  await knex.schema.createTable('notification_bindings', (t) => {
    t.increments('id').primary();
    t.integer('channel_id').notNullable()
      .references('id').inTable('notification_channels').onDelete('CASCADE');
    // 'ticket.created', 'ticket.assigned', 'sla.breached', 'approval.pending', …
    t.string('event', 64).notNullable();
    t.jsonb('conditions').notNullable().defaultTo('{}');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // NOT unique on (channel_id, event): one channel legitimately carries
    // several bindings for the same event with different conditions
    // (e.g. ticket.created → #network for queue 'network', → #sec for 'security').
    t.index(['channel_id', 'event'], 'idx_notification_bindings_channel_event');
    t.index('event', 'idx_notification_bindings_event');
  });

  // notification_log — delivery history. channel_id is SET NULL so history
  // survives the deletion of the channel it went through.
  await knex.schema.createTable('notification_log', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('channel_id').nullable()
      .references('id').inTable('notification_channels').onDelete('SET NULL');
    t.string('event', 64).notNullable();
    t.jsonb('payload').notNullable().defaultTo('{}');
    // sent | failed | skipped | suppressed
    t.string('status', 16).notNullable();
    t.text('error').nullable();
    t.timestamp('sent_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index('channel_id', 'idx_notification_log_channel');
  });
  await knex.schema.raw(
    'CREATE INDEX idx_notification_log_tenant_sent ON notification_log (tenant_id, sent_at DESC)',
  );

  // smtp_servers — tenant_id NULL = platform SMTP. `password_enc` is
  // AES-256-GCM ciphertext under ENCRYPTION_KEY; plaintext never lands here.
  await knex.schema.createTable('smtp_servers', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').nullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 128).notNullable();
    t.string('host', 255).notNullable();
    t.integer('port').notNullable().defaultTo(587);
    t.boolean('secure').notNullable().defaultTo(false);
    t.string('username', 255).nullable();
    t.text('password_enc').nullable();
    t.string('from_address', 255).notNullable();
    t.string('from_name', 128).nullable();
    t.boolean('is_default').notNullable().defaultTo(false);
    t.timestamps(true, true);

    t.index('tenant_id', 'idx_smtp_servers_tenant');
  });
  // At most one default per scope (per tenant, and one for the platform).
  await knex.schema.raw(
    `CREATE UNIQUE INDEX uq_smtp_servers_default
       ON smtp_servers ((COALESCE(tenant_id, 0))) WHERE is_default = true`,
  );

  // notification_outbox — transactional outbox: the write that causes a
  // notification enqueues it in the SAME transaction, and a worker drains it
  // with exponential backoff. This is what stops a mail failure from rolling
  // back a ticket update, and a ticket rollback from sending a phantom mail.
  await knex.schema.createTable('notification_outbox', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    // email | webhook | channel | portal — what the worker should do with it
    t.string('kind', 32).notNullable();
    t.jsonb('payload').notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('next_attempt_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // pending | sent | failed
    t.string('status', 16).notNullable().defaultTo('pending');
    t.text('last_error').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('sent_at', { useTz: true }).nullable();
  });
  // The worker's only hot query: the due queue, oldest first.
  await knex.schema.raw(
    `CREATE INDEX idx_notification_outbox_due
       ON notification_outbox (next_attempt_at, id) WHERE status = 'pending'`,
  );
  await knex.schema.raw(
    'CREATE INDEX idx_notification_outbox_tenant ON notification_outbox (tenant_id, created_at DESC)',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 8 — Live alert feed
  // ══════════════════════════════════════════════════════════════════════════

  // live_alerts — the in-app bell feed, pushed over socket.io. `stable_key`
  // dedupes: skip inserting when an unread row with the same
  // (tenant_id, stable_key) already exists.
  await knex.schema.createTable('live_alerts', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    // critical | warning | info | success
    t.string('severity', 16).notNullable().defaultTo('info');
    t.text('title').notNullable();
    t.text('message').notNullable();
    // Client-side route to open when the alert is clicked, e.g. '/tickets/42'
    t.text('navigate_to').nullable();
    t.text('stable_key').nullable();
    t.timestamp('read_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.raw(
    'CREATE INDEX idx_live_alerts_tenant_created ON live_alerts (tenant_id, created_at DESC)',
  );
  await knex.schema.raw(
    `CREATE INDEX idx_live_alerts_unread
       ON live_alerts (tenant_id, created_at DESC) WHERE read_at IS NULL`,
  );
  await knex.schema.raw(
    `CREATE INDEX idx_live_alerts_stable_key
       ON live_alerts (tenant_id, stable_key) WHERE stable_key IS NOT NULL`,
  );
}

export async function down(knex: Knex): Promise<void> {
  // Reverse dependency order. Indexes and constraints go with their table.

  // Live alert feed
  await knex.schema.dropTableIfExists('live_alerts');

  // Notifications
  await knex.schema.dropTableIfExists('notification_outbox');
  await knex.schema.dropTableIfExists('smtp_servers');
  await knex.schema.dropTableIfExists('notification_log');
  await knex.schema.dropTableIfExists('notification_bindings');
  await knex.schema.dropTableIfExists('notification_channels');

  // Configuration object store
  await knex.schema.dropTableIfExists('config_object_versions');
  await knex.schema.dropTableIfExists('config_objects');

  // Ledgers
  await knex.schema.dropTableIfExists('decision_log');
  await knex.schema.dropTableIfExists('audit_log');

  // Platform configuration
  await knex.schema.dropTableIfExists('settings');
  await knex.schema.dropTableIfExists('app_config');

  // Teams & RBAC
  await knex.schema.dropTableIfExists('user_permission_sets');
  await knex.schema.dropTableIfExists('permission_sets');
  await knex.schema.dropTableIfExists('team_memberships');
  await knex.schema.dropTableIfExists('teams');

  // Multi-tenancy
  await knex.schema.dropTableIfExists('user_tenants');
  await knex.schema.dropTableIfExists('tenants');

  // Core auth
  await knex.schema.dropTableIfExists('sso_link_tokens');
  await knex.schema.dropTableIfExists('password_reset_tokens');
  await knex.schema.dropTableIfExists('session');
  await knex.schema.dropTableIfExists('users');

  // Extensions are intentionally NOT dropped: they may be shared with other
  // schemas in the same database, and DROP EXTENSION would fail (or cascade
  // into someone else's indexes) rather than cleanly undo this migration.
}
