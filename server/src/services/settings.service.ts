/**
 * settings.service.ts — the two-level settings inheritance store.
 *
 * `settings` has a NULLABLE tenant_id:
 *
 *   tenant_id IS NULL, scope 'global'  → the PLATFORM default
 *   tenant_id = n,     scope 'tenant'  → that tenant's override
 *
 * A read resolves in three steps: hard-coded default → platform row → tenant
 * row, and reports WHICH of the three won. That last part is the reason this is
 * a service and not two `SELECT`s: a settings screen that shows "30" without
 * saying whether 30 is the built-in default, an installation-wide policy, or
 * something this tenant chose is a screen that gets edited by mistake.
 *
 * The unique index is on `(COALESCE(tenant_id, 0), key)`, not on
 * `(tenant_id, key)` — NULLs are distinct in a plain UNIQUE constraint, which
 * would happily allow two platform rows for the same key and make "the global
 * default" ambiguous. Every upsert below therefore has to target that
 * expression, which is why the writes are explicit SELECT-then-INSERT/UPDATE
 * rather than `onConflict(['tenant_id','key'])`: Postgres cannot infer an
 * expression index from a column list.
 *
 * VALUES ARE `jsonb`. A setting can hold a number, a boolean, a string or an
 * object; `DEFINITIONS` below declares the expected shape and range, and
 * `set()` refuses anything outside it. Validating here rather than only in a
 * zod route schema means a value written by a seed, a migration or an import
 * path is checked too.
 */

import { db, scopedOrGlobal, assertTenantId } from '../db';
import type { SettingsScope } from '@oblidesk/shared';
import { LIMITS, PAGINATION } from '@oblidesk/shared';
import { auditService } from './audit.service';
import { logger } from '../utils/logger';

// ═════════════════════════════════════════════════════════════════════════════
// The catalog
// ═════════════════════════════════════════════════════════════════════════════

export type SettingValueType = 'number' | 'boolean' | 'string' | 'json';

export interface SettingDefinition {
  key: string;
  type: SettingValueType;
  /** The value used when neither a platform nor a tenant row exists. */
  default: unknown;
  /** Inline English fallback, paired with `t('setting.<key>', label)`. */
  label: string;
  description: string;
  /** Grouping in the settings UI. */
  group: 'desk' | 'sla' | 'mail' | 'notifications' | 'portal' | 'security' | 'ai' | 'retention';
  min?: number;
  max?: number;
  /** Only a platform admin may set this; tenants cannot override it. */
  platformOnly?: boolean;
  /** Allowed values for a string setting. */
  choices?: readonly string[];
}

/**
 * Every setting the desk reads. A key that is not here cannot be written —
 * a typo'd key would otherwise be stored happily and silently read back as
 * the default forever.
 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  // ── Desk behaviour ───────────────────────────────────────────────────────
  {
    key: 'desk.autoCloseResolvedAfterDays',
    type: 'number',
    default: 7,
    min: 0,
    max: 365,
    label: 'Auto-close resolved tickets after (days)',
    description: 'A resolved ticket closes itself after this many days. 0 disables auto-close.',
    group: 'desk',
  },
  {
    key: 'desk.reopenWindowDays',
    type: 'number',
    default: LIMITS.reopenWindowDays,
    min: 0,
    max: 365,
    label: 'Reopen window (days)',
    description:
      'A requester reply within this window reopens the ticket; after it, a linked follow-up is created instead.',
    group: 'desk',
  },
  {
    key: 'desk.defaultPageSize',
    type: 'number',
    default: PAGINATION.defaultLimit,
    min: 10,
    max: PAGINATION.maxLimit,
    label: 'Default page size',
    description: 'Rows fetched per page in the ticket list.',
    group: 'desk',
  },
  {
    key: 'desk.requireResolutionCode',
    type: 'boolean',
    default: false,
    label: 'Require a resolution code',
    description: 'Block the transition to resolved until a resolution code is chosen.',
    group: 'desk',
  },
  {
    key: 'desk.allowPublicReplyOnClosed',
    type: 'boolean',
    default: false,
    label: 'Allow public replies on closed tickets',
    description: 'When off, replying to a closed ticket opens a linked follow-up instead.',
    group: 'desk',
  },

  // ── SLA ──────────────────────────────────────────────────────────────────
  {
    key: 'sla.sweepIntervalSeconds',
    type: 'number',
    default: 60,
    min: 15,
    max: 900,
    label: 'SLA sweep interval (seconds)',
    description: 'How often at-risk and breached clocks are re-evaluated.',
    group: 'sla',
    platformOnly: true,
  },
  {
    key: 'sla.atRiskThresholdPercent',
    type: 'number',
    default: 80,
    min: 1,
    max: 99,
    label: 'At-risk threshold (%)',
    description: 'Percentage of the SLA budget consumed before a clock is flagged at risk.',
    group: 'sla',
  },

  // ── Mail ─────────────────────────────────────────────────────────────────
  {
    key: 'mail.pollIntervalSeconds',
    type: 'number',
    default: 60,
    min: 15,
    max: 3600,
    label: 'Mailbox poll interval (seconds)',
    description: 'How often each active IMAP mailbox is checked for new messages.',
    group: 'mail',
    platformOnly: true,
  },
  {
    key: 'mail.stripQuotedReplies',
    type: 'boolean',
    default: true,
    label: 'Strip quoted history from replies',
    description: 'Trim the quoted thread from an inbound reply before it lands in the journal.',
    group: 'mail',
  },
  {
    key: 'mail.maxAttachmentBytes',
    type: 'number',
    default: LIMITS.attachmentMaxBytes,
    min: 1024,
    max: 200 * 1024 * 1024,
    label: 'Maximum attachment size (bytes)',
    description: 'Inbound and outbound attachments larger than this are rejected.',
    group: 'mail',
  },

  // ── Notifications / outbox ───────────────────────────────────────────────
  {
    key: 'notifications.outboxBatchSize',
    type: 'number',
    default: 25,
    min: 1,
    max: 500,
    label: 'Outbox batch size',
    description: 'Rows the notification worker claims per tick.',
    group: 'notifications',
    platformOnly: true,
  },
  {
    key: 'notifications.outboxIntervalSeconds',
    type: 'number',
    default: 5,
    min: 1,
    max: 300,
    label: 'Outbox poll interval (seconds)',
    description: 'How often the notification worker drains the outbox.',
    group: 'notifications',
    platformOnly: true,
  },
  {
    key: 'notifications.maxAttempts',
    type: 'number',
    default: 8,
    min: 1,
    max: 50,
    label: 'Maximum delivery attempts',
    description: 'After this many failures a notification is marked failed and stops retrying.',
    group: 'notifications',
    platformOnly: true,
  },
  {
    key: 'notifications.baseBackoffSeconds',
    type: 'number',
    default: 30,
    min: 1,
    max: 3600,
    label: 'Retry backoff base (seconds)',
    description: 'First retry delay; each subsequent attempt doubles it, with jitter.',
    group: 'notifications',
    platformOnly: true,
  },
  {
    key: 'notifications.maxBackoffSeconds',
    type: 'number',
    default: 3600,
    min: 60,
    max: 86_400,
    label: 'Retry backoff ceiling (seconds)',
    description: 'Upper bound on the exponential backoff.',
    group: 'notifications',
    platformOnly: true,
  },
  {
    key: 'notifications.throttleMinutes',
    type: 'number',
    default: 0,
    min: 0,
    max: 1440,
    label: 'Repeat suppression (minutes)',
    description: 'Collapse identical notifications inside this window. 0 disables suppression.',
    group: 'notifications',
  },

  // ── Portal ───────────────────────────────────────────────────────────────
  {
    key: 'portal.enabled',
    type: 'boolean',
    default: true,
    label: 'Enable the requester portal',
    description: 'When off, requesters can still e-mail the desk but cannot sign in to the portal.',
    group: 'portal',
  },
  {
    key: 'portal.allowAttachmentUpload',
    type: 'boolean',
    default: true,
    label: 'Allow portal attachments',
    description: 'Let requesters attach files from the portal.',
    group: 'portal',
  },
  {
    key: 'portal.showSlaCountdown',
    type: 'boolean',
    default: false,
    label: 'Show the SLA countdown to requesters',
    description: 'Publishing a countdown sets an expectation you then have to meet.',
    group: 'portal',
  },

  // ── Security ─────────────────────────────────────────────────────────────
  {
    key: 'security.sessionIdleMinutes',
    type: 'number',
    default: 480,
    min: 5,
    max: 43_200,
    label: 'Session idle timeout (minutes)',
    description: 'A session with no activity for this long is invalidated.',
    group: 'security',
    platformOnly: true,
  },
  {
    key: 'security.require2fa',
    type: 'boolean',
    default: false,
    label: 'Require two-factor authentication',
    description: 'Force every local account to enrol a second factor.',
    group: 'security',
    platformOnly: true,
  },
  {
    key: 'security.auditVerifyOnBoot',
    type: 'boolean',
    default: false,
    label: 'Verify the audit chain at boot',
    description:
      'Walk every tenant audit chain on start-up. Correct but slow — leave off unless investigating.',
    group: 'security',
    platformOnly: true,
  },

  // ── AI ───────────────────────────────────────────────────────────────────
  {
    key: 'ai.enabled',
    type: 'boolean',
    default: false,
    label: 'Enable AI assists',
    description: 'Summarise, draft reply and KB suggestions.',
    group: 'ai',
  },
  {
    key: 'ai.monthlyBudgetUsd',
    type: 'number',
    default: 0,
    min: 0,
    max: 100_000,
    label: 'Monthly AI budget (USD)',
    description: 'Spend ceiling per month. 0 means no budget cap is enforced.',
    group: 'ai',
  },

  // ── Retention ────────────────────────────────────────────────────────────
  {
    key: 'retention.decisionLogDays',
    type: 'number',
    default: 730,
    min: 30,
    max: 3650,
    label: 'Decision log retention (days)',
    description: 'How long automated decisions are kept before pruning.',
    group: 'retention',
    platformOnly: true,
  },
  {
    key: 'retention.notificationLogDays',
    type: 'number',
    default: 90,
    min: 7,
    max: 3650,
    label: 'Notification log retention (days)',
    description: 'How long delivery history is kept.',
    group: 'retention',
    platformOnly: true,
  },
];

const DEFINITIONS_BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function getDefinition(key: string): SettingDefinition | undefined {
  return DEFINITIONS_BY_KEY.get(key);
}

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

export type SettingSource = 'default' | 'global' | 'tenant';

export interface ResolvedSetting<T = unknown> {
  key: string;
  value: T;
  /** Which level actually supplied the value. Drives the "inherited" badge. */
  source: SettingSource;
  /** The value each level holds, so the UI can show what reverting would give. */
  defaultValue: unknown;
  globalValue: unknown | undefined;
  tenantValue: unknown | undefined;
  definition: SettingDefinition;
}

export type ResolvedSettings = Record<string, ResolvedSetting>;

interface SettingRow {
  id: number;
  tenant_id: number | null;
  scope: string;
  key: string;
  value: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface SettingsAuditContext {
  actorId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Validation
// ═════════════════════════════════════════════════════════════════════════════

/** Throws with a message an admin can act on. Never returns a coerced value silently. */
export function validateSetting(definition: SettingDefinition, value: unknown): unknown {
  switch (definition.type) {
    case 'number': {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) {
        throw new Error(`Setting "${definition.key}" expects a number, got ${JSON.stringify(value)}`);
      }
      if (definition.min !== undefined && numeric < definition.min) {
        throw new Error(`Setting "${definition.key}" must be at least ${definition.min}`);
      }
      if (definition.max !== undefined && numeric > definition.max) {
        throw new Error(`Setting "${definition.key}" must be at most ${definition.max}`);
      }
      return numeric;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1) return true;
      if (value === 'false' || value === 0) return false;
      throw new Error(`Setting "${definition.key}" expects a boolean, got ${JSON.stringify(value)}`);
    }
    case 'string': {
      if (typeof value !== 'string') {
        throw new Error(`Setting "${definition.key}" expects a string`);
      }
      if (definition.choices && !definition.choices.includes(value)) {
        throw new Error(
          `Setting "${definition.key}" must be one of: ${definition.choices.join(', ')}`,
        );
      }
      return value;
    }
    case 'json':
    default:
      return value;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Service
// ═════════════════════════════════════════════════════════════════════════════

export const settingsService = {
  /**
   * Every setting resolved for one tenant, with the value each level holds.
   *
   * One query, not one per key: `scopedOrGlobal()` returns the tenant's rows
   * AND the platform rows together, and the merge happens in memory. A per-key
   * round trip would be thirty queries to render one screen.
   */
  async resolveAll(tenantId: number): Promise<ResolvedSettings> {
    assertTenantId(tenantId);

    const rows = (await scopedOrGlobal('settings', tenantId).select('*')) as SettingRow[];

    const globalValues = new Map<string, unknown>();
    const tenantValues = new Map<string, unknown>();
    for (const row of rows) {
      if (row.tenant_id === null) globalValues.set(row.key, row.value);
      else tenantValues.set(row.key, row.value);
    }

    const resolved: ResolvedSettings = {};
    for (const definition of SETTING_DEFINITIONS) {
      const tenantValue = tenantValues.get(definition.key);
      const globalValue = globalValues.get(definition.key);

      let value = definition.default;
      let source: SettingSource = 'default';
      if (globalValue !== undefined) {
        value = globalValue;
        source = 'global';
      }
      // A tenant override wins — EXCEPT for platform-only settings, where a
      // stale tenant row (written before the flag existed, or by an import)
      // must not quietly override installation policy.
      if (tenantValue !== undefined && !definition.platformOnly) {
        value = tenantValue;
        source = 'tenant';
      }

      resolved[definition.key] = {
        key: definition.key,
        value,
        source,
        defaultValue: definition.default,
        globalValue,
        tenantValue: definition.platformOnly ? undefined : tenantValue,
        definition,
      };
    }

    return resolved;
  },

  /**
   * One resolved value, typed by the caller. The hot path — engines call this
   * on every tick, so it reads the same two rows the resolver would and skips
   * building the whole map.
   */
  async get<T = unknown>(tenantId: number, key: string): Promise<T> {
    assertTenantId(tenantId);

    const definition = DEFINITIONS_BY_KEY.get(key);
    if (!definition) {
      throw new Error(`Unknown setting key "${key}" — add it to SETTING_DEFINITIONS.`);
    }

    const rows = (await scopedOrGlobal('settings', tenantId)
      .where('settings.key', key)
      // A tenant row must beat the platform row; NULLS LAST puts it first.
      .orderByRaw('settings.tenant_id NULLS LAST')
      .select('tenant_id', 'value')) as Array<{ tenant_id: number | null; value: unknown }>;

    if (definition.platformOnly) {
      const platformRow = rows.find((row) => row.tenant_id === null);
      return (platformRow ? platformRow.value : definition.default) as T;
    }

    return (rows.length > 0 ? rows[0].value : definition.default) as T;
  },

  /** Platform-level value only, ignoring any tenant override. */
  async getGlobal<T = unknown>(key: string): Promise<T> {
    const definition = DEFINITIONS_BY_KEY.get(key);
    if (!definition) throw new Error(`Unknown setting key "${key}"`);

    const row = (await db('settings')
      .whereNull('tenant_id')
      .where({ key })
      .first('value')) as { value: unknown } | undefined;

    return (row ? row.value : definition.default) as T;
  },

  /**
   * Write a TENANT override.
   *
   * The unique index is on the expression `COALESCE(tenant_id, 0)`, which
   * `onConflict()` cannot target, so this is an explicit read-then-write inside
   * a transaction. The transaction is what makes the read-modify-write safe;
   * the alternative — a raw `ON CONFLICT ON CONSTRAINT` — would couple this
   * code to the index name.
   */
  async setTenant(
    tenantId: number,
    key: string,
    value: unknown,
    ctx: SettingsAuditContext = {},
  ): Promise<ResolvedSetting> {
    assertTenantId(tenantId);

    const definition = DEFINITIONS_BY_KEY.get(key);
    if (!definition) throw new Error(`Unknown setting key "${key}"`);
    if (definition.platformOnly) {
      throw new Error(`Setting "${key}" is platform-wide and cannot be overridden per tenant.`);
    }

    const validated = validateSetting(definition, value);

    await db.transaction(async (trx) => {
      const existing = (await trx('settings')
        .where({ tenant_id: tenantId, key })
        .first('id', 'value')) as { id: number; value: unknown } | undefined;

      if (existing) {
        await trx('settings')
          .where({ id: existing.id })
          .update({ value: JSON.stringify(validated), updated_at: new Date() });
      } else {
        await trx('settings').insert({
          tenant_id: tenantId,
          scope: 'tenant',
          key,
          value: JSON.stringify(validated),
        });
      }

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'settings.set',
          entityType: 'setting',
          entityId: key,
          before: existing ? { value: existing.value, scope: 'tenant' } : null,
          after: { value: validated, scope: 'tenant' },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );
    });

    const resolved = await settingsService.resolveAll(tenantId);
    return resolved[key];
  },

  /**
   * Write the PLATFORM default. Platform admin only — this changes behaviour
   * for every tenant that has not overridden the key.
   *
   * `auditTenantId` says which tenant's chain records the change. The audit
   * ledger is per-tenant by construction, so a platform-wide change is recorded
   * in the chain of the tenant the admin was acting in, with the scope stamped
   * in the payload so it reads unambiguously.
   */
  async setGlobal(
    key: string,
    value: unknown,
    auditTenantId: number,
    ctx: SettingsAuditContext = {},
  ): Promise<unknown> {
    assertTenantId(auditTenantId);

    const definition = DEFINITIONS_BY_KEY.get(key);
    if (!definition) throw new Error(`Unknown setting key "${key}"`);

    const validated = validateSetting(definition, value);

    await db.transaction(async (trx) => {
      const existing = (await trx('settings')
        .whereNull('tenant_id')
        .where({ key })
        .first('id', 'value')) as { id: number; value: unknown } | undefined;

      if (existing) {
        await trx('settings')
          .where({ id: existing.id })
          .update({ value: JSON.stringify(validated), updated_at: new Date() });
      } else {
        await trx('settings').insert({
          tenant_id: null,
          scope: 'global',
          key,
          value: JSON.stringify(validated),
        });
      }

      await auditService.record(
        {
          tenantId: auditTenantId,
          actorId: ctx.actorId ?? null,
          action: 'settings.set_global',
          entityType: 'setting',
          entityId: key,
          before: existing ? { value: existing.value, scope: 'global' } : null,
          after: { value: validated, scope: 'global' },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );
    });

    logger.info({ key, value: validated }, 'platform setting updated');
    return validated;
  },

  /**
   * Drop a tenant override so the key falls back to the platform value (or the
   * hard-coded default). This is "revert to inherited", and it is a different
   * operation from writing the inherited value: writing it would pin the
   * current default forever, so a later change to installation policy would
   * not reach this tenant.
   */
  async clearTenant(
    tenantId: number,
    key: string,
    ctx: SettingsAuditContext = {},
  ): Promise<ResolvedSetting> {
    assertTenantId(tenantId);

    const definition = DEFINITIONS_BY_KEY.get(key);
    if (!definition) throw new Error(`Unknown setting key "${key}"`);

    await db.transaction(async (trx) => {
      const existing = (await trx('settings')
        .where({ tenant_id: tenantId, key })
        .first('id', 'value')) as { id: number; value: unknown } | undefined;
      if (!existing) return;

      await trx('settings').where({ id: existing.id }).del();

      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'settings.clear',
          entityType: 'setting',
          entityId: key,
          before: { value: existing.value, scope: 'tenant' },
          after: { inherited: true },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );
    });

    const resolved = await settingsService.resolveAll(tenantId);
    return resolved[key];
  },

  /**
   * Apply several tenant overrides in ONE transaction, so a settings form
   * saves atomically. A per-key loop would leave the tenant half-configured
   * when the fourth of seven values fails validation.
   */
  async setTenantBulk(
    tenantId: number,
    entries: Array<{ key: string; value: unknown }>,
    ctx: SettingsAuditContext = {},
  ): Promise<ResolvedSettings> {
    assertTenantId(tenantId);

    // Validate everything BEFORE opening the transaction: a rejected value
    // should cost nothing, and the error should name the key, not the row.
    const validated = entries.map((entry) => {
      const definition = DEFINITIONS_BY_KEY.get(entry.key);
      if (!definition) throw new Error(`Unknown setting key "${entry.key}"`);
      if (definition.platformOnly) {
        throw new Error(`Setting "${entry.key}" is platform-wide and cannot be set per tenant.`);
      }
      return { key: entry.key, value: validateSetting(definition, entry.value) };
    });

    await db.transaction(async (trx) => {
      const before = (await trx('settings')
        .where({ tenant_id: tenantId })
        .whereIn(
          'key',
          validated.map((entry) => entry.key),
        )
        .select('key', 'value')) as Array<{ key: string; value: unknown }>;

      for (const entry of validated) {
        const existing = (await trx('settings')
          .where({ tenant_id: tenantId, key: entry.key })
          .first('id')) as { id: number } | undefined;

        if (existing) {
          await trx('settings')
            .where({ id: existing.id })
            .update({ value: JSON.stringify(entry.value), updated_at: new Date() });
        } else {
          await trx('settings').insert({
            tenant_id: tenantId,
            scope: 'tenant',
            key: entry.key,
            value: JSON.stringify(entry.value),
          });
        }
      }

      // One audit row for the whole save, not one per key: the operator made
      // one decision and the ledger should read that way.
      await auditService.record(
        {
          tenantId,
          actorId: ctx.actorId ?? null,
          action: 'settings.set_bulk',
          entityType: 'setting',
          entityId: null,
          before: { entries: before },
          after: { entries: validated },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        trx,
      );
    });

    return settingsService.resolveAll(tenantId);
  },

  /** The catalog, for the settings screen. */
  getDefinitions(): readonly SettingDefinition[] {
    return SETTING_DEFINITIONS;
  },

  /** Definitions grouped as the settings screen lays them out. */
  getDefinitionsByGroup(): Array<{ group: string; settings: SettingDefinition[] }> {
    const groups = new Map<string, SettingDefinition[]>();
    for (const definition of SETTING_DEFINITIONS) {
      const list = groups.get(definition.group) ?? [];
      list.push(definition);
      groups.set(definition.group, list);
    }
    return [...groups.entries()].map(([group, settings]) => ({ group, settings }));
  },

  /**
   * Read several keys at once, resolved. For a worker that needs its whole
   * config on each tick without thirty round trips.
   */
  async getMany(tenantId: number, keys: string[]): Promise<Record<string, unknown>> {
    const resolved = await settingsService.resolveAll(tenantId);
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = resolved[key]?.value ?? DEFINITIONS_BY_KEY.get(key)?.default;
    return out;
  },

  /** Every platform-level row, for the installation settings screen. */
  async listGlobal(): Promise<Array<{ key: string; value: unknown; scope: SettingsScope }>> {
    const rows = (await db('settings')
      .whereNull('tenant_id')
      .orderBy('key')
      .select('key', 'value', 'scope')) as Array<{
      key: string;
      value: unknown;
      scope: string;
    }>;
    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      scope: row.scope as SettingsScope,
    }));
  },
};

export default settingsService;
