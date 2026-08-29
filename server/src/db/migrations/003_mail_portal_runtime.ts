/**
 * 003_mail_portal_runtime.ts — the two things Phase 6 needs that 001 and 002
 * did not provide.
 *
 * 001 and 002 are NEVER edited: a migration that has run on a real database is
 * history, and rewriting history means the schema an operator has is not the
 * schema the file describes.
 *
 * ── 1. portal_login_tokens ──────────────────────────────────────────────────
 *
 * The requester portal authenticates with a magic link, and a magic link that
 * cannot be BURNED is not single-use — it is a bearer credential sitting in a
 * mailbox for ever, replayable by anyone who later reads that mailbox (an
 * assistant, a shared alias, a backup, a compromised laptop). Single-use needs
 * server state, and this is it.
 *
 * It is deliberately NOT `password_reset_tokens`. That table is keyed to
 * `users(id)`, and reusing it would mean minting an Oblidesk user for every
 * requester — which is precisely the SSO bypass `portal.service.ts` exists to
 * refuse. Obligate is the suite's identity authority; a portal contact is a
 * different principal type and gets a different table.
 *
 * Only the HASH of the emailed value is stored. A leaked database backup then
 * yields no usable links, and the comparison is a lookup on a hash rather than
 * a scan comparing secrets.
 *
 * ── 2. The outbound-mail retry index ────────────────────────────────────────
 *
 * `outbound.service.ts` writes each message's delivery state into
 * `mail_messages.parsed -> 'delivery'` and drains what is still pending. That
 * predicate has no index in 002 (it did not exist yet), so the drain would be a
 * sequential scan over a table that grows for ever. A PARTIAL index on the
 * pending rows only is the right shape: it holds a handful of rows on a healthy
 * install and disappears entirely when everything is delivered.
 *
 * ── What this migration does NOT add, and why ───────────────────────────────
 *
 * No table for the IMAP cursor: it lives in `mail_accounts.health -> 'sync'`,
 * written in the same atomic `jsonb` merge as the health state it must agree
 * with. No table for the outbound loop-breaker counters: those are counted from
 * `mail_messages` itself, because a shadow counter is one more thing that can
 * disagree with the truth after a crash.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw('CREATE EXTENSION IF NOT EXISTS citext');

  // ── portal_login_tokens ────────────────────────────────────────────────────
  await knex.schema.createTable('portal_login_tokens', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('contact_id').notNullable()
      .references('id').inTable('portal_contacts').onDelete('CASCADE');

    t.string('token_hash', 64).notNullable()
      .comment('sha256 hex of the verifier that was e-mailed. The value itself is never stored.');

    t.specificType('email', 'citext').notNullable()
      .comment(
        'The address the link was sent to, kept alongside contact_id so per-address rate ' +
        'limiting survives a contact being renamed, merged or deleted.',
      );

    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true }).nullable()
      .comment('Set by the atomic burn on verify. A second use finds it non-NULL and is refused.');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.string('requested_ip', 64).nullable();
    t.string('user_agent', 255).nullable();

    // The lookup on verify: hash, inside a tenant. Unique so a hash collision
    // (or a duplicated insert) can never make "which token is this?" ambiguous.
    t.unique(['tenant_id', 'token_hash'], { indexName: 'portal_login_tokens_hash_uq' });
  });

  await knex.schema.raw(
    'ALTER TABLE "portal_login_tokens" ADD CONSTRAINT portal_login_tokens_hash_ck ' +
      'CHECK (char_length(token_hash) = 64)',
  );

  // Per-address rate limiting: "how many links has this address asked for in
  // the last N minutes?" is one index scan, not a table scan.
  await knex.schema.raw(
    'CREATE INDEX portal_login_tokens_rate ON portal_login_tokens (tenant_id, email, created_at DESC)',
  );

  // The pruner's only query. Partial, so it holds only what is still live.
  await knex.schema.raw(
    'CREATE INDEX portal_login_tokens_live ON portal_login_tokens (expires_at) WHERE used_at IS NULL',
  );

  // ── The outbound retry index ───────────────────────────────────────────────
  // `->>` is IMMUTABLE, so it is legal in a partial-index predicate.
  await knex.schema.raw(`
    CREATE INDEX mail_messages_outbound_pending
      ON mail_messages (received_at)
      WHERE direction = 'out' AND (parsed -> 'delivery' ->> 'status') = 'pending'
  `);

  // ── Threading reads ────────────────────────────────────────────────────────
  // Tier 1 also probes `message_id` directly inside one tenant. 002 gave that
  // pair a UNIQUE index, which serves the equality lookup, but the resolver
  // additionally filters on `ticket_id IS NOT NULL` while ordering by
  // `received_at` — this covers that shape without touching the unique index.
  await knex.schema.raw(`
    CREATE INDEX mail_messages_threadable
      ON mail_messages (tenant_id, received_at DESC)
      WHERE ticket_id IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP INDEX IF EXISTS mail_messages_threadable');
  await knex.schema.raw('DROP INDEX IF EXISTS mail_messages_outbound_pending');
  await knex.schema.dropTableIfExists('portal_login_tokens');
}
