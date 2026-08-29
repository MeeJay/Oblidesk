/**
 * notification.service.ts — channels, bindings, templates, and the enqueue side
 * of the transactional outbox.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  The shape of the thing
 * ──────────────────────────────────────────────────────────────────────────
 *   notification_channels   WHERE the message goes (a Slack webhook, an SMTP
 *                           server, a customer's endpoint). tenant_id NULL = a
 *                           platform channel every tenant may bind to.
 *   notification_bindings   WHICH events feed a channel, with optional
 *                           conditions. No tenant_id of its own — it inherits
 *                           the channel's, so it is always reached through an
 *                           already-scoped channel row.
 *   notification_outbox     the QUEUE. Written in the caller's transaction.
 *   notification_log        what actually happened on the wire.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  Why dispatch() enqueues instead of sending
 * ──────────────────────────────────────────────────────────────────────────
 * `dispatch()` resolves the channels and writes one `notification_outbox` row
 * per channel USING THE CALLER'S TRANSACTION. It does not touch the network.
 * The worker in outbox.service.ts drains the queue afterwards.
 *
 * That split is the whole design, and both halves of it matter:
 *
 *  • An SMTP server that is down must not roll back the ticket update that
 *    triggered the mail. Sending inline makes every notification target a
 *    single point of failure for the write that caused it.
 *  • A ticket update that rolls back must not leave a mail already sent.
 *    Sending inline makes "we told the customer their ticket was resolved"
 *    survive the rollback that un-resolved it.
 *
 * Enqueue-in-transaction is the only arrangement where both are true, which is
 * why `dispatch()` takes a `trx` and why calling it without one is worth
 * flagging in review.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  Templates
 * ──────────────────────────────────────────────────────────────────────────
 * Bodies come from `config_objects` with `kind = 'notification_template'`,
 * PUBLISHED only, referenced by SLUG (HARD RULE 3). Two body shapes exist in
 * the wild and `normalizeTemplateBody()` reads both:
 *
 *   • the seeded/day-one shape — snake_case with per-locale maps:
 *     `{ subject: {en, fr}, body_md: {en, fr}, channel_types: [...] }`
 *   • the `NotificationTemplateBody` shape from @oblidesk/shared — camelCase
 *     with a `locales` record: `{ locales: { en: { subject, bodyMd } } }`
 *
 * A reader that understood only one of them would silently render an empty
 * e-mail for half the tenants, which is exactly the class of failure nobody
 * notices until a customer says they never heard back.
 */

import type { Knex } from 'knex';
import {
  db,
  scoped,
  scopedOrGlobal,
  insertScoped,
  assertTenantId,
  type Executor,
} from '../db';
import type {
  ConditionNode,
  CreateNotificationChannelRequest,
  NotificationBinding,
  NotificationChannel,
  NotificationLogEntry,
  NotificationStatus,
  UpdateNotificationChannelRequest,
} from '@oblidesk/shared';
import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  buildConditionFields,
  evaluateCondition,
  isConditionNode,
} from '@oblidesk/shared';
import {
  getPlugin,
  missingRequiredFields,
  secretFieldKeys,
} from '../notifications/registry';
import type { NotificationPayload, NotificationSeverity } from '../notifications/types';
import { smtpServerService } from './smtpServer.service';
import { auditService } from './audit.service';
import { logger } from '../utils/logger';

// ═════════════════════════════════════════════════════════════════════════════
// Rows
// ═════════════════════════════════════════════════════════════════════════════

interface ChannelRow {
  id: number;
  tenant_id: number | null;
  name: string;
  type: string;
  config: Record<string, unknown> | string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface BindingRow {
  id: number;
  channel_id: number;
  event: string;
  conditions: unknown;
  is_active: boolean;
  created_at: Date;
}

interface ConfigObjectRow {
  id: number;
  slug: string;
  name: string;
  body: Record<string, unknown> | string;
  body_format_version: number;
  version: number;
  status: string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Replace secret values with a boolean marker. Applied on EVERY read path, not
 * just the list endpoint: a webhook token that leaks through a detail view is
 * as leaked as one that leaks through a list.
 */
function redactConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const secrets = new Set(secretFieldKeys(type));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = secrets.has(key) ? Boolean(value) : value;
  }
  return out;
}

function rowToChannel(row: ChannelRow, redact = true): NotificationChannel {
  const config = parseJsonObject(row.config);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    type: row.type,
    config: redact ? redactConfig(row.type, config) : config,
    isActive: row.is_active,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Channels this tenant OWNS — the write scope.
 *
 * `notification_channels` is one of the three PLATFORM-OPTIONAL tables: its
 * `tenant_id` is NULLABLE, where NULL means "a platform channel every tenant
 * may bind to". `scoped()` deliberately refuses those tables (it would hide the
 * platform rows), and `scopedOrGlobal()` is the wrong tool for a WRITE — it
 * would let one tenant's admin retune a channel every other tenant is bound to.
 *
 * So writes filter on an explicit, non-null `tenant_id`. A platform channel is
 * simply not reachable from a tenant-scoped path, which is the intent: it is
 * edited from the platform settings screen or not at all.
 */
function ownedChannels(tenantId: number, executor: Executor = db): Knex.QueryBuilder {
  assertTenantId(tenantId);
  return executor('notification_channels').where('notification_channels.tenant_id', tenantId);
}

function rowToBinding(row: BindingRow): NotificationBinding {
  const conditions = row.conditions;
  const parsed = typeof conditions === 'string' ? parseJsonObject(conditions) : conditions;
  return {
    id: row.id,
    channelId: row.channel_id,
    // An empty `{}` in the column means "no condition". Storing null would be
    // cleaner but the column defaults to '{}', so both have to read as none.
    conditions: isConditionNode(parsed) ? (parsed as ConditionNode) : null,
    event: row.event,
    isActive: row.is_active,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Templates
// ═════════════════════════════════════════════════════════════════════════════

export interface TemplateLocaleStrings {
  subject: string;
  bodyMd: string;
  bodyHtml?: string;
}

export interface ResolvedTemplate {
  slug: string;
  name: string;
  version: number;
  bodyFormatVersion: number;
  /** The domain event this template answers, when the body declares one. */
  event: string | null;
  channelTypes: string[];
  audience: string;
  customRecipients: string[];
  locales: Record<string, TemplateLocaleStrings>;
  defaultLocale: string;
  includePublicJournalOnly: boolean;
  attachFiles: boolean;
  sendWhen: ConditionNode | null;
  throttleMinutes: number;
  enabled: boolean;
  /** Set In-Reply-To / References so the reply threads onto the same ticket. */
  setReplyHeaders: boolean;
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

/**
 * Read either body shape into one structure. See the header comment for why
 * both exist; the rule is that a missing field degrades to a sane default
 * rather than throwing — a malformed template must not take down the write
 * that triggered it.
 */
export function normalizeTemplateBody(row: ConfigObjectRow): ResolvedTemplate {
  const body = parseJsonObject(row.body);

  // ── Shape B: the typed NotificationTemplateBody from @oblidesk/shared ────
  const typedLocales = body.locales;
  const locales: Record<string, TemplateLocaleStrings> = {};

  if (typedLocales && typeof typedLocales === 'object') {
    for (const [locale, strings] of Object.entries(typedLocales as Record<string, unknown>)) {
      const entry = parseJsonObject(strings);
      locales[locale] = {
        subject: typeof entry.subject === 'string' ? entry.subject : '',
        bodyMd: typeof entry.bodyMd === 'string' ? entry.bodyMd : '',
        bodyHtml: typeof entry.bodyHtml === 'string' ? entry.bodyHtml : undefined,
      };
    }
  }

  // ── Shape A: the seeded snake_case shape with per-locale maps ────────────
  if (Object.keys(locales).length === 0) {
    const subjects = asStringMap(body.subject);
    const bodies = asStringMap(body.body_md ?? body.bodyMd);
    const htmls = asStringMap(body.body_html ?? body.bodyHtml);
    for (const locale of new Set([...Object.keys(subjects), ...Object.keys(bodies)])) {
      locales[locale] = {
        subject: subjects[locale] ?? '',
        bodyMd: bodies[locale] ?? '',
        bodyHtml: htmls[locale],
      };
    }
  }

  const channelTypes = Array.isArray(body.channelTypes)
    ? (body.channelTypes as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : Array.isArray(body.channel_types)
      ? (body.channel_types as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : ['email'];

  const sendWhen = body.sendWhen ?? body.send_when;

  return {
    slug: row.slug,
    name: row.name,
    version: row.version,
    bodyFormatVersion: row.body_format_version,
    event: typeof body.event === 'string' ? body.event : null,
    channelTypes,
    audience: typeof body.audience === 'string' ? body.audience : 'requester',
    customRecipients: Array.isArray(body.customRecipients ?? body.custom_recipients)
      ? ((body.customRecipients ?? body.custom_recipients) as unknown[]).filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
    locales,
    defaultLocale:
      typeof (body.defaultLocale ?? body.default_locale) === 'string'
        ? String(body.defaultLocale ?? body.default_locale)
        : DEFAULT_LOCALE,
    includePublicJournalOnly:
      (body.includePublicJournalOnly ?? body.include_public_journal_only) !== false,
    attachFiles: Boolean(body.attachFiles ?? body.attach_files),
    sendWhen: isConditionNode(sendWhen) ? (sendWhen as ConditionNode) : null,
    throttleMinutes: Number(body.throttleMinutes ?? body.throttle_minutes ?? 0) || 0,
    enabled: (body.enabled ?? true) !== false,
    setReplyHeaders: Boolean(body.setReplyHeaders ?? body.set_reply_headers),
  };
}

/**
 * `{{ticket.number}}` → the value at that dotted path.
 *
 * Missing paths render as an EMPTY STRING, not as the literal `{{…}}`. A
 * customer receiving "Hello {{requester.display_name}}" is a worse outcome than
 * "Hello ," and the template linter is where a missing variable should be
 * caught, not the send path at 3am.
 */
export function renderTemplateString(
  template: string,
  variables: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = path.split('.').reduce<unknown>((cursor, segment) => {
      if (cursor === null || cursor === undefined) return undefined;
      if (typeof cursor !== 'object') return undefined;
      return (cursor as Record<string, unknown>)[segment];
    }, variables);

    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Dispatch types
// ═════════════════════════════════════════════════════════════════════════════

export interface DispatchInput {
  tenantId: number;
  /** Domain event: 'ticket.created', 'sla.breached', 'approval.requested'. */
  event: string;
  /**
   * The fields a binding's conditions are evaluated against — queue slug,
   * priority slug, status category, organization, whatever the tenant filters
   * on. Build it with `buildConditionFields()` at the call site so a declared
   * field that happens to be empty reads as "known and empty" rather than
   * "unknown", which is what makes `is_empty` trustworthy.
   */
  fields?: Record<string, unknown>;
  /** Everything the plugins need except what dispatch fills in itself. */
  payload: Omit<NotificationPayload, 'appName' | 'tenantSlug' | 'tenantName' | 'occurredAt'> & {
    occurredAt?: string;
  };
  /** THE caller's transaction. Pass it — see the header comment. */
  trx?: Executor;
  ticketId?: number | null;
}

export interface DispatchResult {
  /** Outbox row ids enqueued. */
  enqueued: number[];
  /** Channels considered but skipped, with the reason. */
  skipped: Array<{ channelId: number; reason: string }>;
}

export interface NotificationAuditContext {
  actorId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Service
// ═════════════════════════════════════════════════════════════════════════════

export const notificationService = {
  // ── Channels ─────────────────────────────────────────────────────────────

  /** This tenant's channels plus the platform ones, secrets redacted. */
  async listChannels(tenantId: number): Promise<NotificationChannel[]> {
    assertTenantId(tenantId);
    const rows = (await scopedOrGlobal('notification_channels', tenantId)
      .orderByRaw('notification_channels.tenant_id NULLS LAST')
      .orderBy('notification_channels.name')
      .select('*')) as ChannelRow[];
    return rows.map((row) => rowToChannel(row));
  },

  async getChannel(tenantId: number, id: number): Promise<NotificationChannel | null> {
    assertTenantId(tenantId);
    const row = (await scopedOrGlobal('notification_channels', tenantId)
      .where('notification_channels.id', id)
      .first()) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  },

  async createChannel(
    tenantId: number,
    data: CreateNotificationChannelRequest,
    ctx: NotificationAuditContext = {},
  ): Promise<NotificationChannel> {
    assertTenantId(tenantId);

    const plugin = getPlugin(data.type);
    if (!plugin) throw new Error(`Unknown notification channel type "${data.type}"`);

    // Refuse at save time rather than at first delivery: a channel that cannot
    // possibly send is one an admin should hear about now, not the night an
    // SLA breaches.
    const missing = missingRequiredFields(data.type, data.config ?? {});
    if (missing.length > 0) {
      throw new Error(`Missing required field(s) for ${plugin.name}: ${missing.join(', ')}`);
    }

    return db.transaction(async (trx) => {
      // `notification_channels` is one of the three PLATFORM-OPTIONAL tables:
      // its tenant_id is NULLABLE (NULL = a channel every tenant may bind to).
      // `scoped()` / `insertScoped()` deliberately REFUSE those tables — a
      // scoped helper on a nullable column would silently hide the platform
      // rows — so the tenant_id is written explicitly here, and reads go
      // through `scopedOrGlobal()`.
      const [row] = (await trx('notification_channels')
        .insert({
          tenant_id: tenantId,
          name: data.name,
          type: data.type,
          config: JSON.stringify(data.config ?? {}),
          is_active: data.isActive ?? true,
        })
        .returning('*')) as ChannelRow[];

      const channel = rowToChannel(row);

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'notification_channel.create',
          entityType: 'notification_channel',
          entityId: channel.id,
          // The REDACTED config — an audit row must not become the place a
          // webhook token is readable after it was redacted everywhere else.
          after: { name: channel.name, type: channel.type, config: channel.config },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return channel;
    });
  },

  /**
   * Update a channel. A secret field omitted from `config` KEEPS its stored
   * value — the client never receives the secret back (it gets `true`), so a
   * naive round trip would otherwise overwrite every token with the boolean it
   * was shown.
   */
  async updateChannel(
    tenantId: number,
    id: number,
    data: UpdateNotificationChannelRequest,
    ctx: NotificationAuditContext = {},
  ): Promise<NotificationChannel | null> {
    assertTenantId(tenantId);

    return db.transaction(async (trx) => {
      const existing = (await ownedChannels(tenantId, trx)
        .where('notification_channels.id', id)
        .first()) as ChannelRow | undefined;

      // Only the OWNING tenant may edit. A platform channel (tenant_id NULL)
      // is not reachable from this path at all, because scoped() requires a
      // matching tenant_id — which is the intent: one tenant must not retune a
      // channel every other tenant is bound to.
      if (!existing) return null;

      const currentConfig = parseJsonObject(existing.config);
      const patch: Record<string, unknown> = { updated_at: new Date() };

      if (data.name !== undefined) patch.name = data.name;
      if (data.isActive !== undefined) patch.is_active = data.isActive;

      if (data.config !== undefined) {
        const secrets = new Set(secretFieldKeys(existing.type));
        const merged: Record<string, unknown> = { ...currentConfig };
        for (const [key, value] of Object.entries(data.config)) {
          // `true` is the redaction marker the client was shown; treat it as
          // "unchanged" rather than as a literal value.
          if (secrets.has(key) && (value === true || value === '' || value === undefined)) continue;
          merged[key] = value;
        }
        const missing = missingRequiredFields(existing.type, merged);
        if (missing.length > 0) {
          throw new Error(`Missing required field(s): ${missing.join(', ')}`);
        }
        patch.config = JSON.stringify(merged);
      }

      const [row] = (await trx('notification_channels')
        .where({ id, tenant_id: tenantId })
        .update(patch)
        .returning('*')) as ChannelRow[];

      const channel = rowToChannel(row);

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'notification_channel.update',
          entityType: 'notification_channel',
          entityId: id,
          before: {
            name: existing.name,
            isActive: existing.is_active,
            config: redactConfig(existing.type, currentConfig),
          },
          after: { name: channel.name, isActive: channel.isActive, config: channel.config },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return channel;
    });
  },

  async deleteChannel(
    tenantId: number,
    id: number,
    ctx: NotificationAuditContext = {},
  ): Promise<boolean> {
    assertTenantId(tenantId);

    return db.transaction(async (trx) => {
      const existing = (await ownedChannels(tenantId, trx)
        .where('notification_channels.id', id)
        .first()) as ChannelRow | undefined;
      if (!existing) return false;

      // Bindings cascade with the channel. `notification_log.channel_id` is
      // ON DELETE SET NULL, so the delivery history survives with a null
      // channel rather than vanishing along with the evidence.
      await trx('notification_channels').where({ id, tenant_id: tenantId }).del();

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'notification_channel.delete',
          entityType: 'notification_channel',
          entityId: id,
          before: {
            name: existing.name,
            type: existing.type,
            config: redactConfig(existing.type, parseJsonObject(existing.config)),
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return true;
    });
  },

  /**
   * The RESOLVED config a plugin receives: secrets in plaintext, SMTP
   * credentials injected from `smtp_servers`. Never serialise the result.
   */
  async resolveChannelConfig(channelId: number): Promise<{
    type: string;
    config: Record<string, unknown>;
    tenantId: number | null;
    name: string;
    isActive: boolean;
  } | null> {
    const row = (await db('notification_channels').where({ id: channelId }).first()) as
      | ChannelRow
      | undefined;
    if (!row) return null;

    const config = parseJsonObject(row.config);

    if (row.type === 'smtp') {
      const serverId = Number(config.smtpServerId);
      if (!Number.isInteger(serverId) || serverId <= 0) {
        throw new Error(`Channel ${channelId} is an SMTP channel with no smtpServerId`);
      }
      const server = await smtpServerService.getTransportConfig(serverId);
      if (!server) {
        throw new Error(`Channel ${channelId} points at SMTP server ${serverId}, which no longer exists`);
      }
      return {
        type: row.type,
        name: row.name,
        tenantId: row.tenant_id,
        isActive: row.is_active,
        config: {
          ...config,
          host: server.host,
          port: server.port,
          secure: server.secure,
          username: server.username,
          password: server.password,
          from: config.fromOverride || server.fromAddress,
          fromName: server.fromName,
        },
      };
    }

    return {
      type: row.type,
      name: row.name,
      tenantId: row.tenant_id,
      isActive: row.is_active,
      config,
    };
  },

  /** "Send test" from the channel editor. Bypasses the outbox on purpose. */
  async testChannel(tenantId: number, id: number): Promise<void> {
    assertTenantId(tenantId);

    const visible = (await scopedOrGlobal('notification_channels', tenantId)
      .where('notification_channels.id', id)
      .first('id')) as { id: number } | undefined;
    if (!visible) throw new Error('Notification channel not found');

    const resolved = await notificationService.resolveChannelConfig(id);
    if (!resolved) throw new Error('Notification channel not found');

    const plugin = getPlugin(resolved.type);
    if (!plugin) throw new Error(`No plugin for channel type "${resolved.type}"`);

    await plugin.sendTest(resolved.config);
  },

  // ── Bindings ─────────────────────────────────────────────────────────────

  /**
   * Bindings for one channel. `notification_bindings` has no tenant_id, so the
   * channel is scoped first and the bindings are reached through it — the
   * PARENT_SCOPED_TABLES rule from server/src/db/index.ts.
   */
  async listBindings(tenantId: number, channelId: number): Promise<NotificationBinding[]> {
    assertTenantId(tenantId);

    const channel = (await scopedOrGlobal('notification_channels', tenantId)
      .where('notification_channels.id', channelId)
      .first('id')) as { id: number } | undefined;
    if (!channel) return [];

    const rows = (await db('notification_bindings')
      .where({ channel_id: channelId })
      .orderBy('event')
      .select('*')) as BindingRow[];
    return rows.map(rowToBinding);
  },

  /** Every binding visible to this tenant, grouped by event — the routing matrix. */
  async listAllBindings(tenantId: number): Promise<NotificationBinding[]> {
    assertTenantId(tenantId);
    const rows = (await scopedOrGlobal('notification_channels', tenantId)
      .join(
        'notification_bindings',
        'notification_bindings.channel_id',
        'notification_channels.id',
      )
      .orderBy('notification_bindings.event')
      .select('notification_bindings.*')) as BindingRow[];
    return rows.map(rowToBinding);
  },

  async createBinding(
    tenantId: number,
    channelId: number,
    data: { event: string; conditions?: ConditionNode | null; isActive?: boolean },
    ctx: NotificationAuditContext = {},
  ): Promise<NotificationBinding | null> {
    assertTenantId(tenantId);

    return db.transaction(async (trx) => {
      const channel = (await ownedChannels(tenantId, trx)
        .where('notification_channels.id', channelId)
        .first('id')) as { id: number } | undefined;
      if (!channel) return null;

      const [row] = (await trx('notification_bindings')
        .insert({
          channel_id: channelId,
          event: data.event,
          conditions: JSON.stringify(data.conditions ?? {}),
          is_active: data.isActive ?? true,
        })
        .returning('*')) as BindingRow[];

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'notification_binding.create',
          entityType: 'notification_binding',
          entityId: row.id,
          after: { channelId, event: data.event, conditions: data.conditions ?? null },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return rowToBinding(row);
    });
  },

  async updateBinding(
    tenantId: number,
    bindingId: number,
    data: { event?: string; conditions?: ConditionNode | null; isActive?: boolean },
    ctx: NotificationAuditContext = {},
  ): Promise<NotificationBinding | null> {
    assertTenantId(tenantId);

    return db.transaction(async (trx) => {
      const owned = (await ownedChannels(tenantId, trx)
        .join(
          'notification_bindings',
          'notification_bindings.channel_id',
          'notification_channels.id',
        )
        .where('notification_bindings.id', bindingId)
        .first('notification_bindings.*')) as BindingRow | undefined;
      if (!owned) return null;

      const patch: Record<string, unknown> = {};
      if (data.event !== undefined) patch.event = data.event;
      if (data.conditions !== undefined) patch.conditions = JSON.stringify(data.conditions ?? {});
      if (data.isActive !== undefined) patch.is_active = data.isActive;

      const [row] = (await trx('notification_bindings')
        .where({ id: bindingId })
        .update(patch)
        .returning('*')) as BindingRow[];

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'notification_binding.update',
          entityType: 'notification_binding',
          entityId: bindingId,
          before: { event: owned.event, isActive: owned.is_active },
          after: { event: row.event, isActive: row.is_active },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return rowToBinding(row);
    });
  },

  async deleteBinding(
    tenantId: number,
    bindingId: number,
    ctx: NotificationAuditContext = {},
  ): Promise<boolean> {
    assertTenantId(tenantId);

    return db.transaction(async (trx) => {
      const owned = (await ownedChannels(tenantId, trx)
        .join(
          'notification_bindings',
          'notification_bindings.channel_id',
          'notification_channels.id',
        )
        .where('notification_bindings.id', bindingId)
        .first('notification_bindings.*')) as BindingRow | undefined;
      if (!owned) return false;

      await trx('notification_bindings').where({ id: bindingId }).del();

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'notification_binding.delete',
          entityType: 'notification_binding',
          entityId: bindingId,
          before: { channelId: owned.channel_id, event: owned.event },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );

      return true;
    });
  },

  // ── Resolution ───────────────────────────────────────────────────────────

  /**
   * Which channels should receive this event, and why.
   *
   * A channel legitimately carries several bindings for the same event with
   * different conditions (`ticket.created` → #network for queue 'network',
   * → #sec for 'security'), so the first MATCHING binding wins per channel and
   * the rest are not evaluated — otherwise one channel would receive the same
   * event twice.
   */
  async resolveChannelsForEvent(
    tenantId: number,
    event: string,
    fields: Record<string, unknown> = {},
    executor: Executor = db,
  ): Promise<Array<{ channelId: number; type: string; name: string; bindingId: number }>> {
    assertTenantId(tenantId);

    const rows = (await scopedOrGlobal('notification_channels', tenantId, executor)
      .join(
        'notification_bindings',
        'notification_bindings.channel_id',
        'notification_channels.id',
      )
      .where('notification_bindings.event', event)
      .where('notification_bindings.is_active', true)
      .where('notification_channels.is_active', true)
      .orderBy('notification_bindings.id')
      .select(
        'notification_channels.id as channel_id',
        'notification_channels.type',
        'notification_channels.name',
        'notification_bindings.id as binding_id',
        'notification_bindings.conditions',
      )) as Array<{
      channel_id: number;
      type: string;
      name: string;
      binding_id: number;
      conditions: unknown;
    }>;

    const conditionContext = {
      fields: buildConditionFields(fields),
      // Engines must pass the evaluation instant so the decision is replayable.
      now: Date.now(),
    };

    const matched: Array<{ channelId: number; type: string; name: string; bindingId: number }> = [];
    const seen = new Set<number>();

    for (const row of rows) {
      if (seen.has(row.channel_id)) continue;

      const conditions =
        typeof row.conditions === 'string' ? parseJsonObject(row.conditions) : row.conditions;
      const node = isConditionNode(conditions) ? (conditions as ConditionNode) : null;

      // A null / `{}` condition is "no restriction" — evaluateCondition already
      // treats an empty tree as matching, so this stays one code path.
      const evaluation = evaluateCondition(node, conditionContext);
      if (!evaluation.matched) continue;

      seen.add(row.channel_id);
      matched.push({
        channelId: row.channel_id,
        type: row.type,
        name: row.name,
        bindingId: row.binding_id,
      });
    }

    return matched;
  },

  // ── Dispatch (enqueue) ───────────────────────────────────────────────────

  /**
   * Resolve the channels for an event and enqueue one outbox row per channel,
   * IN THE CALLER'S TRANSACTION.
   *
   * Returns without enqueueing anything when no binding matches. That is a
   * normal outcome, not an error: most tenants bind three events out of forty.
   */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    assertTenantId(input.tenantId);

    const executor = input.trx ?? db;

    const tenant = (await executor('tenants')
      .where({ id: input.tenantId })
      .first('slug', 'name')) as { slug: string; name: string } | undefined;
    if (!tenant) {
      throw new Error(`notification: tenant ${input.tenantId} not found`);
    }

    const channels = await notificationService.resolveChannelsForEvent(
      input.tenantId,
      input.event,
      input.fields ?? {},
      executor,
    );

    const result: DispatchResult = { enqueued: [], skipped: [] };
    if (channels.length === 0) return result;

    const payload: NotificationPayload = {
      ...input.payload,
      appName: process.env.APP_NAME || 'Oblidesk',
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      occurredAt: input.payload.occurredAt ?? new Date().toISOString(),
      event: input.event,
    };

    for (const channel of channels) {
      if (!getPlugin(channel.type)) {
        // One channel with a missing plugin must not stop the other three from
        // telling somebody the SLA just breached.
        result.skipped.push({ channelId: channel.channelId, reason: `no plugin for "${channel.type}"` });
        logger.warn(
          { channelId: channel.channelId, type: channel.type, tenantId: input.tenantId },
          'notification: no plugin for channel type — skipping',
        );
        continue;
      }

      const [row] = (await insertScoped(
        'notification_outbox',
        input.tenantId,
        {
          kind: 'channel',
          payload: JSON.stringify({
            channelId: channel.channelId,
            channelType: channel.type,
            bindingId: channel.bindingId,
            ticketId: input.ticketId ?? null,
            notification: payload,
          }),
          attempts: 0,
          next_attempt_at: new Date(),
          status: 'pending',
        },
        executor,
      ).returning('id')) as Array<{ id: string | number }>;

      result.enqueued.push(Number(row.id));
    }

    return result;
  },

  /**
   * Enqueue a raw outbox row without going through bindings. For the paths that
   * already know their recipient: an acknowledgement to the requester, a
   * password-reset mail, an in-app bell entry.
   */
  async enqueue(
    tenantId: number,
    kind: 'email' | 'webhook' | 'channel' | 'portal' | 'inapp',
    payload: Record<string, unknown>,
    executor: Executor = db,
  ): Promise<number> {
    assertTenantId(tenantId);
    const [row] = (await insertScoped(
      'notification_outbox',
      tenantId,
      {
        kind,
        payload: JSON.stringify(payload),
        attempts: 0,
        next_attempt_at: new Date(),
        status: 'pending',
      },
      executor,
    ).returning('id')) as Array<{ id: string | number }>;
    return Number(row.id);
  },

  // ── Delivery (called by the outbox worker) ───────────────────────────────

  /**
   * Actually put one payload on the wire through one channel, and log the
   * outcome. THROWS on failure — the worker's retry and backoff are driven by
   * that throw, so swallowing an error here turns a retryable failure into
   * silent loss.
   */
  async deliver(
    tenantId: number,
    channelId: number,
    payload: NotificationPayload,
  ): Promise<void> {
    assertTenantId(tenantId);

    const resolved = await notificationService.resolveChannelConfig(channelId);
    if (!resolved) {
      await notificationService.log(tenantId, channelId, payload.event, payload, 'skipped', 'channel deleted');
      return;
    }
    if (!resolved.isActive) {
      await notificationService.log(tenantId, channelId, payload.event, payload, 'skipped', 'channel disabled');
      return;
    }

    const plugin = getPlugin(resolved.type);
    if (!plugin) {
      await notificationService.log(
        tenantId,
        channelId,
        payload.event,
        payload,
        'skipped',
        `no plugin for "${resolved.type}"`,
      );
      return;
    }

    try {
      await plugin.send(resolved.config, payload);
      await notificationService.log(tenantId, channelId, payload.event, payload, 'sent', null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await notificationService.log(tenantId, channelId, payload.event, payload, 'failed', message);
      throw error;
    }
  },

  /**
   * Delivery history. The payload is stored WITHOUT the resolved config, so a
   * log row can never become the place a credential is readable.
   */
  async log(
    tenantId: number,
    channelId: number | null,
    event: string,
    payload: NotificationPayload | Record<string, unknown>,
    status: NotificationStatus | 'skipped' | 'suppressed',
    error: string | null,
    executor: Executor = db,
  ): Promise<void> {
    assertTenantId(tenantId);
    await insertScoped(
      'notification_log',
      tenantId,
      {
        channel_id: channelId,
        event,
        payload: JSON.stringify(payload),
        status,
        error,
        sent_at: new Date(),
      },
      executor,
    );
  },

  async listLog(
    tenantId: number,
    query: { channelId?: number; event?: string; status?: string; limit?: number; page?: number } = {},
  ): Promise<{ entries: NotificationLogEntry[]; total: number; page: number; limit: number }> {
    assertTenantId(tenantId);

    const limit = Math.min(Math.max(1, query.limit ?? 50), 200);
    const page = Math.max(1, query.page ?? 1);

    const applyFilters = (builder: Knex.QueryBuilder): Knex.QueryBuilder => {
      if (query.channelId !== undefined) builder.where('notification_log.channel_id', query.channelId);
      if (query.event) builder.where('notification_log.event', query.event);
      if (query.status) builder.where('notification_log.status', query.status);
      return builder;
    };

    const countRow = (await applyFilters(
      scoped('notification_log', tenantId),
    ).count<{ count: string }[]>('notification_log.id as count')) as unknown as Array<{
      count: string;
    }>;

    const rows = (await applyFilters(scoped('notification_log', tenantId))
      .orderBy('notification_log.sent_at', 'desc')
      .limit(limit)
      .offset((page - 1) * limit)
      .select('notification_log.*')) as Array<{
      id: number;
      tenant_id: number;
      channel_id: number | null;
      event: string;
      payload: unknown;
      status: string;
      error: string | null;
      sent_at: Date;
    }>;

    return {
      entries: rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        channelId: row.channel_id,
        event: row.event,
        payload: parseJsonObject(row.payload),
        status: row.status as NotificationStatus,
        error: row.error,
        sentAt: toIso(row.sent_at),
      })),
      total: Number(countRow[0]?.count ?? 0),
      page,
      limit,
    };
  },

  // ── Templates ────────────────────────────────────────────────────────────

  /**
   * A PUBLISHED notification template by slug. Drafts are invisible here on
   * purpose: an engine must never render a body someone is halfway through
   * editing.
   */
  async getTemplate(
    tenantId: number,
    slug: string,
    executor: Executor = db,
  ): Promise<ResolvedTemplate | null> {
    assertTenantId(tenantId);
    const row = (await scoped('config_objects', tenantId, executor)
      .where({
        'config_objects.kind': 'notification_template',
        'config_objects.slug': slug,
        'config_objects.status': 'published',
      })
      .first('id', 'slug', 'name', 'body', 'body_format_version', 'version', 'status')) as
      | ConfigObjectRow
      | undefined;
    return row ? normalizeTemplateBody(row) : null;
  },

  /** Every published template for a tenant — the template picker. */
  async listTemplates(tenantId: number): Promise<ResolvedTemplate[]> {
    assertTenantId(tenantId);
    const rows = (await scoped('config_objects', tenantId)
      .where({ 'config_objects.kind': 'notification_template', 'config_objects.status': 'published' })
      .orderBy('config_objects.slug')
      .select('id', 'slug', 'name', 'body', 'body_format_version', 'version', 'status')) as
      ConfigObjectRow[];
    return rows.map(normalizeTemplateBody);
  },

  /**
   * Render a template into a subject + body for one locale.
   *
   * Locale fallback is explicit and three-deep: the requested locale, then the
   * template's own default, then the app fallback (`en`). A template that has
   * only `fr` must still produce something for an English recipient rather than
   * an empty e-mail — HARD RULE 10 is about never degrading to a raw key, and
   * that applies to outbound mail as much as to the UI.
   */
  render(
    template: ResolvedTemplate,
    locale: string,
    variables: Record<string, unknown>,
  ): TemplateLocaleStrings {
    const strings =
      template.locales[locale] ??
      template.locales[template.defaultLocale] ??
      template.locales[FALLBACK_LOCALE] ??
      Object.values(template.locales)[0];

    if (!strings) {
      return { subject: '', bodyMd: '' };
    }

    return {
      subject: renderTemplateString(strings.subject, variables),
      bodyMd: renderTemplateString(strings.bodyMd, variables),
      bodyHtml: strings.bodyHtml ? renderTemplateString(strings.bodyHtml, variables) : undefined,
    };
  },

  /**
   * Look a template up, render it, and enqueue it — the one call an engine
   * needs. Returns `null` when the template is missing or disabled, so the
   * caller can decide whether that is worth logging.
   */
  async dispatchTemplate(input: {
    tenantId: number;
    templateSlug: string;
    event: string;
    locale?: string;
    variables: Record<string, unknown>;
    severity?: NotificationSeverity;
    url?: string;
    fields?: Record<string, unknown>;
    ticketId?: number | null;
    trx?: Executor;
  }): Promise<DispatchResult | null> {
    const template = await notificationService.getTemplate(
      input.tenantId,
      input.templateSlug,
      input.trx ?? db,
    );
    if (!template || !template.enabled) return null;

    const rendered = notificationService.render(
      template,
      input.locale ?? DEFAULT_LOCALE,
      input.variables,
    );

    return notificationService.dispatch({
      tenantId: input.tenantId,
      event: input.event,
      fields: input.fields,
      ticketId: input.ticketId,
      trx: input.trx,
      payload: {
        event: input.event,
        title: rendered.subject,
        body: rendered.bodyMd,
        bodyHtml: rendered.bodyHtml,
        severity: input.severity ?? 'info',
        url: input.url,
        locale: input.locale ?? DEFAULT_LOCALE,
      },
    });
  },
};

export default notificationService;
