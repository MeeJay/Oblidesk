import type { Knex } from 'knex';

/**
 * 009_portal_contact_visibility.ts — organisation-wide reading becomes a RIGHT
 * a person is granted, instead of a query parameter anyone may pass.
 *
 * ── What it was ─────────────────────────────────────────────────────────────
 * `GET /api/portal/tickets?scope=organization` was honoured for ANY contact
 * carrying an `organization_id`: the route read the parameter, and
 * `visibleTickets` widened on the single condition that the contact belonged to
 * an organisation at all. Nothing was checked, because there was nothing to
 * check against.
 *
 * On a desk serving one company that reads as a feature. On a desk serving
 * several — which is what `organizations` exists for — it means every employee
 * of a customer can read every ticket their colleagues ever filed, including
 * the ones about them, by editing the URL. The requester who reported a
 * harassment case, a payroll error or a suspected leak filed it believing they
 * were writing to the helpdesk, not to their whole floor.
 *
 * ── What it is ──────────────────────────────────────────────────────────────
 * `portal_contacts.org_visibility` says what a contact may see:
 *
 *   own          their own tickets. The default, and what every existing row
 *                gets: a migration must never widen access that was not asked
 *                for, and silence has to mean the narrow reading.
 *   organization every ticket belonging to their organisation. This is the
 *                customer-side manager the desk deliberately grants it to.
 *
 * A column rather than a boolean because the next question this will be asked
 * is "and their own department", and `own | department | organization` extends
 * where `is_manager` would have to be replaced.
 *
 * The grant means nothing on a contact with no organisation, and the CHECK says
 * so rather than leaving a row whose right cannot be exercised.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('portal_contacts', (t) => {
    t.string('org_visibility', 16).notNullable().defaultTo('own')
      .comment(
        'What this contact may read: own = their own tickets; organization = ' +
          'every ticket of their organisation. Granted by an agent, never by the ' +
          'requester, and never inferred from belonging to an organisation.',
      );
  });

  await knex.schema.raw(
    'ALTER TABLE "portal_contacts" ADD CONSTRAINT portal_contacts_org_visibility_ck ' +
      "CHECK (org_visibility IN ('own', 'organization'))",
  );

  // A right that names no organisation cannot be exercised, and a row that
  // carries one is a promise the reader has to keep checking. Refuse it here.
  await knex.schema.raw(
    'ALTER TABLE "portal_contacts" ADD CONSTRAINT portal_contacts_org_visibility_needs_org_ck ' +
      "CHECK (org_visibility = 'own' OR organization_id IS NOT NULL)",
  );

  // The portal asks this on every list: "may this contact widen, and to what".
  await knex.schema.raw(
    'CREATE INDEX portal_contacts_org_readers ON portal_contacts (tenant_id, organization_id) ' +
      "WHERE org_visibility = 'organization'",
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP INDEX IF EXISTS portal_contacts_org_readers');
  await knex.schema.raw(
    'ALTER TABLE "portal_contacts" DROP CONSTRAINT IF EXISTS portal_contacts_org_visibility_needs_org_ck',
  );
  await knex.schema.raw(
    'ALTER TABLE "portal_contacts" DROP CONSTRAINT IF EXISTS portal_contacts_org_visibility_ck',
  );
  await knex.schema.alterTable('portal_contacts', (t) => {
    t.dropColumn('org_visibility');
  });
}
