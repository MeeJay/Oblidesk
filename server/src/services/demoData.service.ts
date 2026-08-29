import { db } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  DEMO_DEFAULT_VOLUME,
  DEMO_MAX_VOLUME,
  DEMO_ORGANISATIONS,
  DEMO_PRIORITY_MIX,
  DEMO_REPLIES,
  DEMO_REQUESTERS,
  DEMO_SPREAD_DAYS,
  DEMO_STATUS_MIX,
  DEMO_SUBJECTS,
  DEMO_TENANT_MARKER,
  DEMO_TENANT_NAME,
  DEMO_TENANT_SLUG,
  DEMO_WORK_NOTES,
  demoRandom,
  pickWeighted,
} from '@oblidesk/shared';

/**
 * Demonstration data, driven by the DEMO_DATA environment variable.
 *
 *   DEMO_DATA=true   -> the demo tenant exists and is populated
 *   DEMO_DATA=false  -> the demo tenant does not exist
 *
 * Both directions are IDEMPOTENT and run at every boot, so the variable
 * describes a desired state rather than an action. Flipping it and restarting
 * is the whole interface.
 *
 * ── Why a whole tenant, and not a flag on some rows ────────────────────────
 *
 * Because the purge has to be safe, and "delete the rows I marked" is not.
 * A marker on a row is a promise that nothing else ever writes that marker,
 * that no import carries it, that no admin copies a demo ticket into a real
 * queue. Deleting real tickets because a flag leaked is unrecoverable, and it
 * is exactly the kind of failure a dev convenience must not be able to cause.
 *
 * A tenant is a hard boundary the whole product already enforces: every table
 * is tenant-scoped and cascades from `tenants`. Demo data therefore CANNOT be
 * mixed with real data, and the purge is one DELETE the database gets right.
 *
 * Two further guards, because "delete a tenant at boot" deserves them:
 *   1. Only the tenant whose slug is exactly DEMO_TENANT_SLUG is ever touched.
 *   2. It must carry `settings.isDemo === true`, which only this service writes.
 *      A real workspace someone happened to name "demo" survives untouched, and
 *      says so in the log instead of disappearing.
 *
 * The wizard's step 6 does the same thing from the UI; the fixtures are shared
 * so the two produce the same desk.
 */

interface DemoTenantRow {
  id: number;
  slug: string;
  name: string;
  settings: unknown;
}

function readSettings(value: unknown): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** The demo tenant, or null. Never creates. */
async function findDemoTenant(): Promise<DemoTenantRow | null> {
  const row = (await db('tenants')
    .where({ slug: DEMO_TENANT_SLUG })
    .first('id', 'slug', 'name', 'settings')) as DemoTenantRow | undefined;
  return row ?? null;
}

function isMarkedDemo(row: DemoTenantRow): boolean {
  return readSettings(row.settings)[DEMO_TENANT_MARKER] === true;
}

export const demoDataService = {
  /**
   * Reconcile the demo tenant with `config.demoData`. Called once at boot.
   *
   * Never throws: a demo tenant is not worth refusing to serve tickets over.
   * Every outcome is logged, including the ones where it deliberately did
   * nothing.
   */
  async reconcile(): Promise<void> {
    try {
      if (config.demoData) {
        await this.ensureSeeded();
      } else {
        await this.purge();
      }
    } catch (err) {
      logger.error({ err }, 'Demo data reconciliation failed — the server continues without it');
    }
  },

  /** Create and populate the demo tenant if it is not already there. */
  async ensureSeeded(volume = config.demoVolume): Promise<{ created: boolean; tickets: number }> {
    const existing = await findDemoTenant();

    if (existing && !isMarkedDemo(existing)) {
      // Somebody's real workspace is called "demo". Do not touch it, and do not
      // quietly seed into it either.
      logger.warn(
        { tenantId: existing.id, slug: existing.slug },
        `A tenant named "${DEMO_TENANT_SLUG}" exists but is not marked as demo data. ` +
          'Refusing to seed into it. Rename it or unset DEMO_DATA.',
      );
      return { created: false, tickets: 0 };
    }

    if (existing) {
      const [{ count }] = await db('tickets')
        .where({ tenant_id: existing.id })
        .count<[{ count: string }]>('* as count');
      logger.info(
        { tenantId: existing.id, tickets: Number(count) },
        'DEMO_DATA=true — the demo tenant is already seeded',
      );
      return { created: false, tickets: Number(count) };
    }

    const wanted = Math.min(Math.max(1, volume), DEMO_MAX_VOLUME);
    logger.info({ volume: wanted }, 'DEMO_DATA=true — seeding the demonstration tenant');

    const { tenantService } = await import('./tenant.service');
    const tenant = await tenantService.create({
      slug: DEMO_TENANT_SLUG,
      name: DEMO_TENANT_NAME,
      settings: { [DEMO_TENANT_MARKER]: true },
    } as Parameters<typeof tenantService.create>[0]);

    // The demo tenant needs statuses, priorities, queues, calendars and an SLA
    // policy or its tickets reference slugs that do not resolve.
    //
    // The seed bundle cannot help: seeds/02_baseline_config.seed() is bound to
    // DEFAULT_TENANT_SLUG. So COPY the published config from the master tenant
    // instead, which is also the better demo: it mirrors what this operator
    // actually configured rather than a pristine baseline they never saw.
    await this.copyPublishedConfig(tenant.id);

    // Without membership the demo tenant does not appear in the tenant switcher,
    // so the whole feature would be invisible to the person who asked for it.
    const memberIds = await this.grantAdminsAccess(tenant.id);

    const tickets = await this.generateTickets(tenant.id, wanted, memberIds);
    logger.info({ tenantId: tenant.id, tickets }, 'Demonstration tenant seeded');
    return { created: true, tickets };
  },

  /**
   * Copy the master tenant's PUBLISHED configuration into the demo tenant.
   *
   * Only published objects, and only their current body: a demo does not need
   * the version history, and copying drafts would show the operator edits they
   * have not released yet as if they were live.
   */
  async copyPublishedConfig(targetTenantId: number): Promise<number> {
    const source = (await db('tenants')
      .where({ is_master: true })
      .orWhere({ slug: 'default' })
      .orderBy('is_master', 'desc')
      .first('id')) as { id: number } | undefined;
    if (!source) {
      logger.warn('No source tenant to copy configuration from — the demo tenant will be bare');
      return 0;
    }

    const rows = (await db('config_objects')
      .where({ tenant_id: source.id, status: 'published' })
      .select('kind', 'slug', 'name', 'description', 'body', 'body_format_version', 'checksum')) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) return 0;

    await db('config_objects').insert(
      rows.map((row) => ({
        tenant_id: targetTenantId,
        kind: row.kind,
        slug: row.slug,
        name: row.name,
        description: row.description,
        body: typeof row.body === 'string' ? row.body : JSON.stringify(row.body),
        body_format_version: row.body_format_version,
        status: 'published',
        version: 1,
        is_system: true,
        checksum: row.checksum,
      })),
    );
    logger.info({ targetTenantId, objects: rows.length }, 'Configuration copied into the demo tenant');
    return rows.length;
  },

  /**
   * Make every platform admin a member of the demo tenant.
   *
   * Returns their ids, which double as the pool the generated tickets are
   * assigned from: an unassigned ticket cannot legally leave triage (the
   * shipped machine requires an assignee for in_progress), so a demo with no
   * assignees is a demo stuck at the first column.
   */
  async grantAdminsAccess(tenantId: number): Promise<number[]> {
    const admins = (await db('users')
      .where({ role: 'admin', is_active: true })
      .select('id')) as Array<{ id: number }>;
    if (admins.length === 0) return [];

    await db('user_tenants')
      .insert(admins.map((a) => ({ user_id: a.id, tenant_id: tenantId, role: 'admin' })))
      .onConflict(['user_id', 'tenant_id'])
      .ignore();

    logger.info({ tenantId, admins: admins.length }, 'Admins granted access to the demo tenant');
    return admins.map((a) => a.id);
  },

  /** Generate the tickets. Deterministic for a given volume. */
  async generateTickets(tenantId: number, volume: number, assignees: number[] = []): Promise<number> {
    const { ticketService, systemActor } = await import('./ticket.service');
    const actor = systemActor();
    const rnd = demoRandom(volume * 7919);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    let created = 0;
    for (let i = 0; i < volume; i += 1) {
      const subject = DEMO_SUBJECTS[Math.floor(rnd() * DEMO_SUBJECTS.length)];
      const requester = DEMO_REQUESTERS[Math.floor(rnd() * DEMO_REQUESTERS.length)];
      const org = DEMO_ORGANISATIONS[Math.floor(rnd() * DEMO_ORGANISATIONS.length)];
      const priority = pickWeighted(DEMO_PRIORITY_MIX, rnd).prioritySlug;
      const status = pickWeighted(DEMO_STATUS_MIX, rnd).statusSlug;

      // Spread backwards over the window, so the dashboard rollup and the
      // "breaching soon" view both have something to show.
      const occurredAt = new Date(now - rnd() * DEMO_SPREAD_DAYS * dayMs).toISOString();

      try {
        const ticket = await ticketService.create(
          {
            tenantId,
            recordType: 'incident',
            subject,
            descriptionMd: `Signalé par ${requester.name} (${org}).\n\n${subject}.`,
            prioritySlug: priority,
            source: 'email',
            occurredAt,
            assigneeId: assignees.length ? assignees[Math.floor(rnd() * assignees.length)] : null,
            data: { __demo: true, requesterName: requester.name, organisation: org },
          },
          { actorType: 'system', actorId: null },
        );
        created += 1;

        // Roughly half get a conversation, so the journal, the first-response
        // SLA and the collapsed-noise rendering all have something to render.
        if (rnd() > 0.5) {
          await ticketService.addJournalEntry(
            tenantId,
            actor,
            ticket.id,
            {
              kind: 'public_reply',
              visibility: 'public',
              bodyMd: DEMO_REPLIES[Math.floor(rnd() * DEMO_REPLIES.length)],
            },
          );
        }
        if (rnd() > 0.75) {
          await ticketService.addJournalEntry(
            tenantId,
            actor,
            ticket.id,
            {
              kind: 'work_note',
              visibility: 'internal',
              bodyMd: DEMO_WORK_NOTES[Math.floor(rnd() * DEMO_WORK_NOTES.length)],
            },
          );
        }

        // Walk the ticket to its intended status through the REAL state machine,
        // so the demo cannot contain a ticket in a state the machine forbids.
        if (status !== 'new') {
          await this.walkTo(tenantId, ticket.id, status);
        }
      } catch (err) {
        logger.warn({ err, subject }, 'Demo ticket could not be created — continuing');
      }
    }
    return created;
  },

  /**
   * Move a demo ticket to a target status the legal way.
   *
   * Deliberately goes through `transition()` rather than UPDATE-ing the column:
   * a demo that contains states the state machine would refuse is a demo that
   * lies about the product, and it is also how you discover at a customer site
   * that a guard was wrong.
   */
  async walkTo(tenantId: number, ticketId: number, target: string): Promise<void> {
    const { ticketService, systemActor } = await import('./ticket.service');
    const actor = systemActor();

    for (let hop = 0; hop < 6; hop += 1) {
      const ticket = await ticketService.getById(tenantId, ticketId);
      if (!ticket || ticket.statusSlug === target) return;

      const available = await ticketService.getAvailableTransitions(tenantId, actor, ticketId);
      const list = available.transitions;

      // Prefer the target if it is one hop away; otherwise take any legal move
      // and try again. Six hops is more than the shipped machine's diameter.
      //
      // The target is attempted even when getAvailableTransitions reports it
      // BLOCKED. That is not ignoring the guard: the shipped resolve transition has a
      // null guard and fails only on required_fields (assignee, resolution code,
      // resolution notes), and those are supplied in the call below. Filtering
      // on allowed first meant never attempting the very move the payload
      // unblocks, which is why the demo had zero resolved tickets.
      const next =
        list.find((tr) => tr.toStatusSlug === target) ??
        list.find((tr) => tr.allowed !== false);
      if (!next) return;

      try {
        // A move into resolved/closed needs resolution notes, because the state
        // machine requires them. Supplying them here is not cheating the guard,
        // it is satisfying it the way an agent would: without this the demo has
        // zero resolved tickets and the dashboard rollup has nothing to average,
        // which is exactly the screen the demo exists to show.
        const terminal = next.toStatusSlug === 'resolved' || next.toStatusSlug === 'closed';
        await ticketService.transition(
          tenantId,
          actor,
          ticketId,
          {
            baseRowVersion: ticket.rowVersion,
            toStatusSlug: next.toStatusSlug,
            system: true,
            ...(terminal
              ? {
                  resolutionCode: 'resolved',
                  resolutionMd:
                    'Résolu et vérifié avec le demandeur. Ticket de démonstration.',
                }
              : {}),
          },
        );
      } catch {
        return; // a guard refused; leave the ticket where it is
      }
    }
  },

  /**
   * Remove the demo tenant, and with it every row that cascaded from it.
   *
   * Silent and cheap when there is nothing to do, which is the common case:
   * DEMO_DATA is false on every real install and this runs at every boot.
   */
  async purge(): Promise<{ deleted: boolean }> {
    const existing = await findDemoTenant();
    if (!existing) return { deleted: false };

    if (!isMarkedDemo(existing)) {
      logger.warn(
        { tenantId: existing.id },
        `A tenant named "${DEMO_TENANT_SLUG}" exists but is not marked as demo data. ` +
          'It was NOT deleted. Only tenants this service created carry the marker.',
      );
      return { deleted: false };
    }

    const [{ count }] = await db('tickets')
      .where({ tenant_id: existing.id })
      .count<[{ count: string }]>('* as count');

    const { tenantService } = await import('./tenant.service');
    await tenantService.delete(existing.id, DEMO_TENANT_SLUG);

    logger.info(
      { tenantId: existing.id, tickets: Number(count) },
      'DEMO_DATA=false — demonstration tenant removed',
    );
    return { deleted: true };
  },
};

export const DEMO_VOLUME_DEFAULT = DEMO_DEFAULT_VOLUME;
