import type { Knex } from 'knex';
import bcrypt from 'bcrypt';

/**
 * 01_core.ts — the minimum a fresh Oblidesk needs to be usable.
 *
 * Creates, in order:
 *   1. the default tenant   (slug 'default', is_master = true)
 *   2. the bootstrap admin  (DEFAULT_ADMIN_USERNAME / DEFAULT_ADMIN_PASSWORD)
 *   3. the admin's membership of the default tenant
 *   4. one assignment group ('service-desk') with the admin in it
 *   5. the tenant's ticket_sequences row (so ticket #1 can be allocated)
 *
 * IDEMPOTENT. Every write is ON CONFLICT DO NOTHING, so re-running this on a
 * live database is a no-op — it will never reset a changed admin password, and
 * it will never renumber ticket_sequences.
 *
 * Cross-references use SLUGS, never numeric ids (HARD RULE 3 / 13): the tenant
 * is looked up by slug, and everything downstream keys off that slug.
 */

const BCRYPT_ROUNDS = 12;

export const DEFAULT_TENANT_SLUG = 'default';
export const DEFAULT_TENANT_NAME = 'Default';
export const DEFAULT_ASSIGNMENT_GROUP_SLUG = 'service-desk';
export const DEFAULT_TICKET_PREFIX = 'TKT';

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[seed:01_core] ${message}`);
}

export async function seed(knex: Knex): Promise<void> {
  // ── 1. Default tenant ─────────────────────────────────────────────────────
  // is_master marks the tenant whose admins can see and administer every other
  // tenant. There is exactly one, and it is created here.
  await knex('tenants')
    .insert({
      slug: DEFAULT_TENANT_SLUG,
      name: DEFAULT_TENANT_NAME,
      is_master: true,
      settings: JSON.stringify({}),
    })
    .onConflict('slug')
    .ignore();

  const tenant = await knex('tenants')
    .select('id', 'slug')
    .where('slug', DEFAULT_TENANT_SLUG)
    .first();

  if (!tenant) {
    throw new Error(
      `[seed:01_core] default tenant '${DEFAULT_TENANT_SLUG}' is missing after insert — ` +
      'refusing to seed the rest against an unknown tenant.',
    );
  }
  const tenantId: number = tenant.id;
  log(`tenant '${DEFAULT_TENANT_SLUG}' -> id ${tenantId}`);

  // ── 2. Bootstrap admin ────────────────────────────────────────────────────
  const username = (process.env.DEFAULT_ADMIN_USERNAME || 'admin').trim();
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'changeme';
  const adminEmail = (process.env.DEFAULT_ADMIN_EMAIL || '').trim() || null;

  if (!process.env.DEFAULT_ADMIN_PASSWORD) {
    log(
      'WARNING: DEFAULT_ADMIN_PASSWORD is not set — falling back to "changeme". ' +
      'Set it in the environment before exposing this instance.',
    );
  }

  const existingAdmin = await knex('users').select('id').where('username', username).first();

  if (!existingAdmin) {
    // Only pay for the bcrypt round trip when we are actually going to insert.
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await knex('users')
      .insert({
        username,
        password_hash: passwordHash,
        display_name: 'Administrator',
        email: adminEmail,
        role: 'admin',
        is_active: true,
        preferred_language: 'en',
        auth_source: 'local',
        preferences: JSON.stringify({}),
      })
      .onConflict('username')
      .ignore();
    log(`created admin user '${username}'`);
  } else {
    log(`admin user '${username}' already exists — password left untouched`);
  }

  const admin = await knex('users').select('id').where('username', username).first();
  if (!admin) {
    throw new Error(`[seed:01_core] admin user '${username}' is missing after insert.`);
  }
  const adminId: number = admin.id;

  // ── 3. Admin ↔ tenant membership ──────────────────────────────────────────
  // capabilities '*' is the wildcard the RBAC evaluator reads as "everything";
  // the global users.role = 'admin' alone does not grant tenant scope.
  await knex('user_tenants')
    .insert({
      user_id: adminId,
      tenant_id: tenantId,
      role: 'admin',
      capabilities: JSON.stringify({ '*': true }),
    })
    .onConflict(['user_id', 'tenant_id'])
    .ignore();

  // ── 4. The one assignment group ───────────────────────────────────────────
  // Every seeded queue routes here (see 02_baseline_config.ts). A desk with no
  // group would leave auto_assign_by_queue pointing at nothing.
  await knex('assignment_groups')
    .insert({
      tenant_id: tenantId,
      slug: DEFAULT_ASSIGNMENT_GROUP_SLUG,
      name: 'Service Desk',
      description: 'Default catch-all group. Every seeded queue routes here until you split it up.',
      member_user_ids: [adminId],
      email: null,
      is_active: true,
    })
    .onConflict(['tenant_id', 'slug'])
    .ignore();

  // Re-running must not silently drop the admin out of the group if a previous
  // run created it empty — but it must also never clobber a curated member list.
  const group = await knex('assignment_groups')
    .select('id', 'member_user_ids')
    .where({ tenant_id: tenantId, slug: DEFAULT_ASSIGNMENT_GROUP_SLUG })
    .first();

  if (group && Array.isArray(group.member_user_ids) && group.member_user_ids.length === 0) {
    await knex('assignment_groups')
      .where({ id: group.id })
      .update({ member_user_ids: [adminId] });
    log(`assignment group '${DEFAULT_ASSIGNMENT_GROUP_SLUG}' was empty — added the admin`);
  }

  // ── 5. Ticket numbering ───────────────────────────────────────────────────
  // ON CONFLICT DO NOTHING is load-bearing here: re-seeding a live desk must
  // never rewind last_number and start handing out duplicate ticket numbers.
  await knex('ticket_sequences')
    .insert({
      tenant_id: tenantId,
      prefix: (process.env.DEFAULT_TICKET_PREFIX || DEFAULT_TICKET_PREFIX).trim().toUpperCase(),
      last_number: 0,
    })
    .onConflict('tenant_id')
    .ignore();

  log('done');
}
