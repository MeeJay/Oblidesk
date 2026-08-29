import type { Knex } from 'knex';
import { db, scoped } from '../db';
import { logger } from '../utils/logger';

/**
 * The alert spine — killer feature #2.
 *
 * Suite apps (Obliview, Obliguard, Oblimap, Obliance) push alerts here. This
 * service turns a stream of repeated, flapping, maintenance-window-noisy events
 * into AT MOST ONE ticket per real problem, and closes that ticket when the
 * source says the problem is gone.
 *
 * Every desk that has ever wired monitoring to ticketing has turned it off again
 * within a month, because one ticket per event turns the queue into landfill.
 * Four unglamorous guarantees are what make the difference — all four are
 * enforced here, not documented as best practice:
 *
 *   1. DEDUPE KEY IS MANDATORY. Without a stable key we cannot correlate a
 *      repeat with the original, so we refuse the payload outright. The DB
 *      carries a CHECK constraint saying the same thing.
 *   2. MINIMUM OCCURRENCES. A binding may require N sightings before a ticket is
 *      opened, which kills flapping without dropping the signal — the alert row
 *      still exists and its occurrence_count still climbs.
 *   3. MAINTENANCE SUPPRESSION BLOCKS TICKET CREATION, not merely notification.
 *      A ticket you have to close by hand is worse than no ticket.
 *   4. AUTO-CLOSE ON RECOVERY, with one guardrail: if a human replied or logged
 *      time on the ticket, it goes to REVIEW, never straight to closed. Silently
 *      closing work a human touched is how a team stops trusting automation.
 *
 * Everything this service decides is written to decision_log on the same code
 * path as the action (HARD RULE 2), so the Why drawer can explain any ticket
 * that an alert opened.
 */

// ── Contract with the source apps ────────────────────────────────────────────
//
// Mirrors D:/Obliview/server/src/notifications/plugins/oblidesk.ts verbatim.
// Additive changes only; a breaking change bumps `version`.

export const ALERT_INGEST_VERSION = 1;

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'firing' | 'resolved';
export type SourceApp = 'obliview' | 'obliguard' | 'oblimap' | 'obliance' | 'obligate';

export interface AlertIngestBody {
  source: SourceApp;
  version: number;
  /** NEVER empty — the anti-landfill guarantee. */
  stableKey: string;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  message: string | null;
  /** ISO-8601. The real state-change time, not the send time. */
  occurredAt: string;
  /** ISO-8601 when status === 'resolved'. The REAL recovery time — drives MTTR. */
  resolvedAt: string | null;
  occurrenceCount: number;
  queueSlug: string | null;
  /** THE cross-app join key (HARD RULE 13). Never a numeric tenant id. */
  tenantSlug: string | null;
  tenantId: number | null;
  appName: string | null;
  monitor?: {
    id: number | null;
    name: string;
    type: string | null;
    url: string | null;
    oldStatus: string;
    newStatus: string;
  };
  group?: {
    id: number | null;
    name: string | null;
    downMonitors: string[];
    failingMonitors: string[];
    totalFailingCount: number | null;
  } | null;
  device?: {
    agentDeviceId: number | null;
    /** The suite-wide CMDB key. Hardware UUID only — see HARD RULE on CI identity. */
    deviceUuid: string | null;
  };
  maintenance?: {
    inMaintenance: boolean;
    suppressedReason: string | null;
  };
}

export type IngestAction = 'created' | 'deduped' | 'resolved' | 'ignored';

export interface AlertIngestResult {
  alertId: number;
  stableKey: string;
  action: IngestAction;
  ticketId: number | null;
  ticketNumber: string | null;
}

export class AlertIngestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * Binding = the policy that decides whether an alert becomes a ticket.
 * Stored as a config object (kind='alert_binding'), so it exports, diffs and
 * rolls back like every other piece of configuration.
 */
interface AlertBinding {
  slug: string;
  sourceApp: SourceApp | 'any';
  minSeverity: AlertSeverity;
  /** Sightings required before a ticket opens. 1 = open immediately. */
  minOccurrences: number;
  queueSlug: string | null;
  recordType: string;
  priorityBySeverity: Partial<Record<AlertSeverity, string>>;
  /** Close the ticket when the source reports recovery. */
  autoResolve: boolean;
  /** Suppress ticket CREATION (not just notification) during maintenance. */
  suppressInMaintenance: boolean;
  active: boolean;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

/**
 * Used when a tenant has published no binding at all. Deliberately conservative:
 * warning-and-above, two sightings before a ticket, auto-resolve on, maintenance
 * suppressed. A fresh install therefore behaves sanely before anyone configures
 * anything — and an admin who wants one ticket per beep has to ask for it.
 */
const FALLBACK_BINDING: AlertBinding = {
  slug: '__default__',
  sourceApp: 'any',
  minSeverity: 'warning',
  minOccurrences: 2,
  queueSlug: null,
  recordType: 'incident',
  priorityBySeverity: { critical: 'p1', warning: 'p3', info: 'p4' },
  autoResolve: true,
  suppressInMaintenance: true,
  active: true,
};

function normalizeSeverity(value: unknown, fallback: AlertSeverity = 'warning'): AlertSeverity {
  return value === 'info' || value === 'warning' || value === 'critical' ? value : fallback;
}

function parseInstant(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string' || !value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export const alertService = {
  /**
   * Validate a payload from a suite app. Throws AlertIngestError with a message
   * the caller will record in its own notification log, so be specific.
   */
  validate(body: unknown): AlertIngestBody {
    if (!body || typeof body !== 'object') {
      throw new AlertIngestError('Body must be a JSON object');
    }
    const b = body as Partial<AlertIngestBody>;

    // GUARANTEE 1 — no dedupe key, no ingest. This is the whole anti-landfill
    // contract; accepting the alert without one would open a ticket per beat.
    if (typeof b.stableKey !== 'string' || !b.stableKey.trim()) {
      throw new AlertIngestError(
        'stableKey is required — an alert without a dedupe key cannot be correlated or auto-resolved',
      );
    }
    if (typeof b.source !== 'string' || !b.source.trim()) {
      throw new AlertIngestError('source is required (obliview | obliguard | oblimap | obliance | obligate)');
    }
    if (typeof b.title !== 'string' || !b.title.trim()) {
      throw new AlertIngestError('title is required');
    }
    if (b.status !== 'firing' && b.status !== 'resolved') {
      throw new AlertIngestError("status must be 'firing' or 'resolved'");
    }

    return {
      source: b.source as SourceApp,
      version: typeof b.version === 'number' ? b.version : 1,
      stableKey: b.stableKey.trim(),
      severity: normalizeSeverity(b.severity),
      status: b.status,
      title: b.title.trim().slice(0, 512),
      message: typeof b.message === 'string' ? b.message : null,
      occurredAt: parseInstant(b.occurredAt, new Date()).toISOString(),
      resolvedAt: b.resolvedAt ? parseInstant(b.resolvedAt, new Date()).toISOString() : null,
      occurrenceCount: typeof b.occurrenceCount === 'number' && b.occurrenceCount > 0 ? b.occurrenceCount : 1,
      queueSlug: typeof b.queueSlug === 'string' && b.queueSlug ? b.queueSlug : null,
      tenantSlug: typeof b.tenantSlug === 'string' && b.tenantSlug ? b.tenantSlug : null,
      tenantId: typeof b.tenantId === 'number' ? b.tenantId : null,
      appName: typeof b.appName === 'string' ? b.appName : null,
      monitor: b.monitor,
      group: b.group ?? null,
      device: b.device,
      maintenance: b.maintenance,
    };
  },

  /**
   * Resolve the ORIGINATING tenant slug onto a local tenant.
   *
   * HARD RULE 13: each app has its own tenants table with its own autoincrement,
   * so `tenantId` from the source is meaningless here. Only the slug joins.
   * An unresolvable slug is an explicit error, never a silent fall-through to
   * the default tenant — routing another customer's alert into the wrong
   * workspace is the worst failure this endpoint can have.
   */
  async resolveTenant(body: AlertIngestBody): Promise<number> {
    if (!body.tenantSlug) {
      throw new AlertIngestError(
        'tenantSlug is required — cross-app tenant identity joins on the slug, never a numeric id',
        422,
      );
    }
    const row = await db('tenants').where({ slug: body.tenantSlug }).first('id');
    if (!row) {
      throw new AlertIngestError(
        `Unknown tenant slug "${body.tenantSlug}" — create the workspace in Oblidesk first`,
        422,
      );
    }
    return row.id as number;
  },

  /** Load the published binding that matches, or the conservative fallback. */
  async resolveBinding(tenantId: number, body: AlertIngestBody): Promise<AlertBinding> {
    const rows = await scoped('config_objects', tenantId)
      .where({ kind: 'alert_binding', status: 'published' })
      .select('slug', 'body');

    const candidates: AlertBinding[] = [];
    for (const row of rows as Array<{ slug: string; body: unknown }>) {
      const raw = (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as Partial<AlertBinding>;
      if (raw?.active === false) continue;
      const sourceApp = (raw?.sourceApp ?? 'any') as SourceApp | 'any';
      if (sourceApp !== 'any' && sourceApp !== body.source) continue;
      candidates.push({
        ...FALLBACK_BINDING,
        ...raw,
        slug: row.slug,
        sourceApp,
        minSeverity: normalizeSeverity(raw?.minSeverity, FALLBACK_BINDING.minSeverity),
        minOccurrences: Math.max(1, Number(raw?.minOccurrences ?? FALLBACK_BINDING.minOccurrences)),
      });
    }

    // A binding naming this source explicitly beats a catch-all.
    candidates.sort((a, b) => (a.sourceApp === 'any' ? 1 : 0) - (b.sourceApp === 'any' ? 1 : 0));
    return candidates[0] ?? FALLBACK_BINDING;
  },

  /**
   * Link the alert to a configuration item by HARDWARE UUID ONLY.
   *
   * Deliberately not multi-key matching (uuid → mac → fqdn → hostname): that is
   * identity reconciliation, it produces collisions and split identities, and it
   * is exactly the CMDB disease we refused to build. One key, or no link.
   * The CI row here holds identity only — every attribute is read through to the
   * owning app at render time.
   */
  async resolveCi(tenantId: number, body: AlertIngestBody, trx?: Knex.Transaction): Promise<number | null> {
    const uuid = body.device?.deviceUuid;
    if (!uuid) return null;

    const q = trx ? trx('cis') : db('cis');
    const existing = await q.where({ tenant_id: tenantId, hardware_uuid: uuid }).first('id');
    if (existing) {
      await (trx ? trx('cis') : db('cis'))
        .where({ id: existing.id })
        .update({ last_seen_at: db.fn.now() });
      return existing.id as number;
    }

    const [created] = await (trx ? trx('cis') : db('cis'))
      .insert({
        tenant_id: tenantId,
        kind: 'device',
        display_name: body.monitor?.name ?? uuid,
        hardware_uuid: uuid,
        first_seen_at: db.fn.now(),
        last_seen_at: db.fn.now(),
      })
      .returning('id');
    return (typeof created === 'object' ? created.id : created) as number;
  },

  /**
   * Ingest one alert.
   *
   * The whole thing runs in ONE transaction, with a row lock on the open alert
   * for this dedupe key — two beats arriving at once must not both decide they
   * are the first and open two tickets.
   */
  async ingest(body: AlertIngestBody): Promise<AlertIngestResult> {
    const tenantId = await this.resolveTenant(body);
    const binding = await this.resolveBinding(tenantId, body);
    const severity = normalizeSeverity(body.severity);

    return db.transaction(async (trx) => {
      // The open alert for this key, locked. "Open" = not cleared.
      const open = await trx('suite_alerts')
        .where({ tenant_id: tenantId, dedupe_key: body.stableKey })
        .whereNull('cleared_at')
        .orderBy('first_seen_at', 'desc')
        .forUpdate()
        .first();

      // ── Recovery ────────────────────────────────────────────────────────────
      if (body.status === 'resolved') {
        if (!open) {
          // Nothing open to close. Normal after a restart — accept quietly.
          return { alertId: 0, stableKey: body.stableKey, action: 'ignored' as const, ticketId: null, ticketNumber: null };
        }

        // GUARANTEE 4 — the REAL recovery timestamp, never now(). MTTR depends
        // on it, and "now" would silently inflate every incident by the send lag.
        const clearedAt = body.resolvedAt ?? body.occurredAt;
        await trx('suite_alerts').where({ id: open.id }).update({
          cleared_at: clearedAt,
          last_seen_at: clearedAt,
          occurrence_count: Math.max(open.occurrence_count, body.occurrenceCount),
        });

        if (!open.ticket_id || !binding.autoResolve) {
          return { alertId: open.id, stableKey: body.stableKey, action: 'resolved' as const, ticketId: open.ticket_id ?? null, ticketNumber: null };
        }

        const outcome = await this.closeTicketForRecovery(trx, tenantId, open.ticket_id, clearedAt, body);
        return {
          alertId: open.id,
          stableKey: body.stableKey,
          action: 'resolved' as const,
          ticketId: open.ticket_id,
          ticketNumber: outcome.ticketNumber,
        };
      }

      // ── Firing ──────────────────────────────────────────────────────────────
      const ciId = await this.resolveCi(tenantId, body, trx);

      if (open) {
        // GUARANTEE 2 (second half) — a repeat NEVER opens a second ticket. It
        // bumps the counter, and may cross minOccurrences and open the first one.
        const occurrenceCount = Math.max(open.occurrence_count + 1, body.occurrenceCount);
        await trx('suite_alerts').where({ id: open.id }).update({
          last_seen_at: body.occurredAt,
          occurrence_count: occurrenceCount,
          severity,
          title: body.title,
          message: body.message,
          ci_id: ciId ?? open.ci_id,
          payload: JSON.stringify(body),
        });

        if (open.ticket_id) {
          return { alertId: open.id, stableKey: body.stableKey, action: 'deduped' as const, ticketId: open.ticket_id, ticketNumber: null };
        }

        const gate = this.gate(binding, severity, occurrenceCount, body);
        if (gate.suppressed) {
          await trx('suite_alerts').where({ id: open.id }).update({ suppressed_reason: gate.reason });
          return { alertId: open.id, stableKey: body.stableKey, action: 'deduped' as const, ticketId: null, ticketNumber: null };
        }

        const ticket = await this.openTicket(trx, tenantId, binding, severity, body, ciId, open.id);
        await trx('suite_alerts').where({ id: open.id }).update({ ticket_id: ticket.id, suppressed_reason: null });
        return { alertId: open.id, stableKey: body.stableKey, action: 'created' as const, ticketId: ticket.id, ticketNumber: ticket.number };
      }

      // First sighting of this key.
      const gate = this.gate(binding, severity, body.occurrenceCount, body);
      const [inserted] = await trx('suite_alerts')
        .insert({
          tenant_id: tenantId,
          source_app: body.source,
          dedupe_key: body.stableKey,
          severity,
          title: body.title,
          message: body.message,
          ci_id: ciId,
          external_id: body.monitor?.id != null ? String(body.monitor.id) : null,
          tenant_slug: body.tenantSlug,
          occurrence_count: body.occurrenceCount,
          first_seen_at: body.occurredAt,
          last_seen_at: body.occurredAt,
          suppressed_reason: gate.suppressed ? gate.reason : null,
          payload: JSON.stringify(body),
        })
        .returning(['id']);
      const alertId = (typeof inserted === 'object' ? inserted.id : inserted) as number;

      if (gate.suppressed) {
        // The alert EXISTS and is visible on the Shift Board's fourth column —
        // it simply has no ticket yet. Suppression must never mean "discarded".
        return { alertId, stableKey: body.stableKey, action: 'ignored' as const, ticketId: null, ticketNumber: null };
      }

      const ticket = await this.openTicket(trx, tenantId, binding, severity, body, ciId, alertId);
      await trx('suite_alerts').where({ id: alertId }).update({ ticket_id: ticket.id });
      return { alertId, stableKey: body.stableKey, action: 'created' as const, ticketId: ticket.id, ticketNumber: ticket.number };
    });
  },

  /** The three reasons an alert legitimately does NOT become a ticket. */
  gate(
    binding: AlertBinding,
    severity: AlertSeverity,
    occurrenceCount: number,
    body: AlertIngestBody,
  ): { suppressed: boolean; reason: string | null } {
    // GUARANTEE 3 — suppression blocks CREATION, not just notification.
    if (binding.suppressInMaintenance && body.maintenance?.inMaintenance) {
      return { suppressed: true, reason: 'maintenance_window' };
    }
    if (SEVERITY_RANK[severity] < SEVERITY_RANK[binding.minSeverity]) {
      return { suppressed: true, reason: 'below_min_severity' };
    }
    // GUARANTEE 2 — flap damping. The alert is kept; only the ticket waits.
    if (occurrenceCount < binding.minOccurrences) {
      return { suppressed: true, reason: 'below_min_occurrences' };
    }
    return { suppressed: false, reason: null };
  },

  async openTicket(
    trx: Knex.Transaction,
    tenantId: number,
    binding: AlertBinding,
    severity: AlertSeverity,
    body: AlertIngestBody,
    ciId: number | null,
    alertId: number,
  ): Promise<{ id: number; number: string }> {
    const { ticketService } = await import('./ticket.service');
    const priority = binding.priorityBySeverity[severity] ?? 'p3';

    const ticket = await ticketService.create(
      {
        tenantId,
        recordType: binding.recordType,
        subject: body.title,
        descriptionMd: this.renderDescription(body),
        prioritySlug: priority,
        queueSlug: body.queueSlug ?? binding.queueSlug ?? undefined,
        source: 'alert',
        // HARD RULE 6 — the alert's own timestamp, not ingest time. This is what
        // lets Rewind scrub to the moment the problem actually started.
        occurredAt: body.occurredAt,
        primaryCiId: ciId,
        data: { alertId, sourceApp: body.source, dedupeKey: body.stableKey },
      },
      { actorType: 'system', actorId: null, trx },
    );

    return { id: ticket.id, number: ticket.number };
  },

  /**
   * Close the ticket a recovery clears — with the guardrail.
   *
   * If a human replied publicly or logged time, the problem was worked, and
   * auto-closing it erases that work from the record. Those go to REVIEW.
   */
  async closeTicketForRecovery(
    trx: Knex.Transaction,
    tenantId: number,
    ticketId: number,
    clearedAt: string,
    body: AlertIngestBody,
  ): Promise<{ ticketNumber: string | null; touched: boolean }> {
    const ticket = await trx('tickets').where({ id: ticketId, tenant_id: tenantId }).first();
    if (!ticket) return { ticketNumber: null, touched: false };

    const [{ count: replyCount }] = await trx('ticket_journal')
      .where({ ticket_id: ticketId })
      .whereIn('kind', ['public_reply', 'work_note'])
      .whereNotNull('author_id')
      .count({ count: '*' });
    const [{ count: timeCount }] = await trx('time_entries')
      .where({ ticket_id: ticketId })
      .count({ count: '*' });

    const touched = Number(replyCount) > 0 || Number(timeCount) > 0;

    const { ticketService } = await import('./ticket.service');
    await ticketService.applyAlertRecovery(
      {
        tenantId,
        ticketId,
        clearedAt,
        touched,
        note: touched
          ? `${body.appName ?? body.source} signale le retablissement a ${clearedAt}. Un intervenant a travaille ce ticket — il passe en revue plutot qu'en ferme.`
          : `${body.appName ?? body.source} signale le retablissement a ${clearedAt}. Aucune intervention humaine enregistree — fermeture automatique.`,
      },
      trx,
    );

    logger.info(
      { ticketId, touched, clearedAt, source: body.source },
      touched ? 'Alert recovery -> review (human worked the ticket)' : 'Alert recovery -> auto-closed',
    );
    return { ticketNumber: ticket.number ?? null, touched };
  },

  /** The opening description. Everything the technician needs, nothing they must go fetch. */
  renderDescription(body: AlertIngestBody): string {
    const lines: string[] = [];
    lines.push(`**${body.appName ?? body.source}** a signale un probleme.`);
    lines.push('');
    if (body.message) {
      lines.push(body.message, '');
    }
    if (body.monitor) {
      lines.push(`- Moniteur : ${body.monitor.name}${body.monitor.type ? ` (${body.monitor.type})` : ''}`);
      if (body.monitor.url) lines.push(`- Cible : ${body.monitor.url}`);
      lines.push(`- Etat : ${body.monitor.oldStatus} → **${body.monitor.newStatus}**`);
    }
    if (body.group && body.group.totalFailingCount) {
      lines.push(`- Groupe : ${body.group.name ?? '-'} — ${body.group.totalFailingCount} moniteur(s) en echec`);
      if (body.group.failingMonitors.length) {
        lines.push(`- En echec : ${body.group.failingMonitors.join(', ')}`);
      }
    }
    if (body.device?.deviceUuid) {
      lines.push(`- Machine : \`${body.device.deviceUuid}\``);
    }
    lines.push(`- Severite : ${body.severity}`);
    lines.push(`- Survenu a : ${body.occurredAt}`);
    lines.push(`- Cle de deduplication : \`${body.stableKey}\``);
    return lines.join('\n');
  },

  /** Alerts with no ticket — the Shift Board's fourth column. */
  async listUnticketed(tenantId: number, limit = 50) {
    return scoped('suite_alerts', tenantId)
      .whereNull('ticket_id')
      .whereNull('cleared_at')
      .orderBy('last_seen_at', 'desc')
      .limit(limit)
      .select('*');
  },
};
