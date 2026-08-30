import type { Knex } from 'knex';

/**
 * 010_attachment_link_attribution.ts — who attached this file, HERE.
 *
 * ── Why the blob could not answer it ────────────────────────────────────────
 * `attachments.uploaded_by` references `users` and nothing else, so a file a
 * customer attached through the portal was stored with a null author: the
 * portal has no `users` row to name. "Who sent us this?" had no answer, on the
 * one surface where the sender is not an employee.
 *
 * Adding a contact column to `attachments` would not have fixed it either, and
 * that is the more interesting half. `attachments` is de-duplicated by content
 * hash per tenant (`attachments_tenant_hash_uq`): identical bytes are ONE row,
 * reused by every ticket that carries them. Its `uploaded_by` therefore names
 * whoever uploaded those bytes FIRST, anywhere in the tenant — which is not the
 * question anybody asks when they are looking at one ticket.
 *
 * ── Where it belongs ────────────────────────────────────────────────────────
 * `attachment_links` is the (blob, context) pair: one row per place a file
 * appears. That is the grain attribution has, so the columns go here. The same
 * PDF attached by an agent to a ticket and by a customer to their reply is one
 * blob and two links, each naming its own author, which is the truth.
 *
 * Two nullable columns rather than one polymorphic pair, matching how
 * `ticket_journal` already distinguishes `author_id` from `author_contact_id`:
 * the reader asks "is this ours or theirs" by looking at which one is set, and
 * a CHECK keeps a link from claiming both.
 *
 * Both are ON DELETE SET NULL, and deliberately: a purged account must not take
 * the file's history with it, exactly as 007 and 008 concluded for the other
 * actor columns in this schema.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('attachment_links', (t) => {
    t.integer('linked_by_user_id').nullable()
      .references('id').inTable('users').onDelete('SET NULL')
      .comment('The agent who attached the file HERE. Null when a contact did.');
    t.integer('linked_by_contact_id').nullable()
      .references('id').inTable('portal_contacts').onDelete('SET NULL')
      .comment('The portal contact who attached the file HERE. Null when an agent did.');
  });

  // A link is attached by one side or the other, never by both. Neither is a
  // legal state too: every link written before this migration has no author,
  // and inventing one for them would be worse than admitting we do not know.
  await knex.schema.raw(
    'ALTER TABLE "attachment_links" ADD CONSTRAINT attachment_links_author_ck ' +
      'CHECK (linked_by_user_id IS NULL OR linked_by_contact_id IS NULL)',
  );

  // "What has this customer sent us?" is the question the portal makes possible
  // and the only one that needs an index of its own here.
  await knex.schema.raw(
    'CREATE INDEX attachment_links_by_contact ON attachment_links (tenant_id, linked_by_contact_id) ' +
      'WHERE linked_by_contact_id IS NOT NULL',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP INDEX IF EXISTS attachment_links_by_contact');
  await knex.schema.raw(
    'ALTER TABLE "attachment_links" DROP CONSTRAINT IF EXISTS attachment_links_author_ck',
  );
  await knex.schema.alterTable('attachment_links', (t) => {
    t.dropColumn('linked_by_contact_id');
    t.dropColumn('linked_by_user_id');
  });
}
