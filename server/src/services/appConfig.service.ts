/**
 * appConfig.service.ts — the platform key/value store (`app_config`).
 *
 * `app_config` is a GLOBAL table (see GLOBAL_TABLES in db/index.ts): it
 * configures the installation, not a tenant, so `db('app_config')` is the
 * correct access path and HARD RULE 1 does not apply to it.
 *
 * `value` is `jsonb NOT NULL`, so every write goes through `JSON.stringify`
 * (node-postgres would otherwise turn a JS array into a Postgres array
 * literal, which jsonb refuses) and every read comes back already parsed.
 *
 * Secrets NEVER leave this module in clear text through a `getAll()` style
 * call: the Obligate API key and the AI provider key are stored AES-256-GCM
 * encrypted under ENCRYPTION_KEY (utils/crypto) and only the `*Raw()` readers
 * decrypt them — those are for server→server calls, never for a response body.
 */

import { db } from '../db';
import { encryptSecret, tryDecryptSecret } from '../utils/crypto';
import { logger } from '../utils/logger';
import type { AppConfig, ObligateConfig, AiConfig } from '@oblidesk/shared';

// ── Keys ─────────────────────────────────────────────────────────────────────
// `app_config.key` is varchar(64); keep these short and stable — they are the
// on-disk contract of an already-migrated database.
export const CONFIG_KEYS = {
  obligate: 'obligate_config',
  /** Legacy split flag, still honoured on read so an older row keeps working. */
  obligateEnabled: 'obligate_enabled',
  allow2fa: 'allow_2fa',
  force2fa: 'force_2fa',
  otpSmtpServerId: 'otp_smtp_server_id',
  ai: 'ai_config',
} as const;

interface ObligateStored {
  url?: string | null;
  /** AES-256-GCM ciphertext of the Obligate app API key. */
  apiKeyEnc?: string | null;
  /** Only present on rows written before the key was encrypted at rest. */
  apiKey?: string | null;
  enabled?: boolean;
}

export type AiProvider = AiConfig['provider'];

interface AiStored {
  enabled?: boolean;
  provider?: AiProvider;
  model?: string | null;
  apiKeyEnc?: string | null;
  apiKey?: string | null;
  monthlyBudgetUsd?: number | null;
  /**
   * Per-tenant monthly ceiling, keyed by tenant SLUG (HARD RULE 13) so the
   * blob survives an export/import into an installation whose tenant ids
   * differ. A tenant absent from the map falls back to `monthlyBudgetUsd`.
   */
  tenantBudgetsUsd?: Record<string, number>;
  features?: Partial<AiConfig['features']>;
}

const AI_FEATURE_DEFAULTS: AiConfig['features'] = {
  summarize: false,
  draftReply: false,
  suggestKb: false,
  triage: false,
  dedupe: false,
};

const AI_PROVIDERS: readonly AiProvider[] = ['anthropic', 'openai', 'azure', 'local', 'none'];

function toProvider(value: unknown): AiProvider {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value)
    ? (value as AiProvider)
    : 'none';
}

/** Decrypt a stored secret, tolerating a legacy clear-text value. */
function readSecret(enc: string | null | undefined, legacy: string | null | undefined): string | null {
  if (enc) {
    const plain = tryDecryptSecret(enc);
    if (plain === null) {
      logger.error('appConfig: a stored secret could not be decrypted — has ENCRYPTION_KEY changed?');
    }
    return plain;
  }
  return legacy ?? null;
}

/** Encrypt a secret for storage; `null` clears it. */
function writeSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return encryptSecret(value);
}

export const appConfigService = {
  // ── Raw key/value ─────────────────────────────────────────────────────────

  async get<T = unknown>(key: string): Promise<T | null> {
    const row = (await db('app_config').where({ key }).first('value')) as { value: T } | undefined;
    return row === undefined || row.value === null ? null : row.value;
  },

  async set(key: string, value: unknown): Promise<void> {
    const payload = JSON.stringify(value ?? null);
    await db('app_config')
      .insert({ key, value: payload, updated_at: new Date() })
      .onConflict('key')
      .merge({ value: payload, updated_at: new Date() });
  },

  async delete(key: string): Promise<void> {
    await db('app_config').where({ key }).del();
  },

  /**
   * The whole platform configuration as the admin UI sees it.
   * Secrets are reduced to a boolean — this shape is safe to serialise.
   */
  async getAll(): Promise<AppConfig> {
    const [allow2fa, force2fa, otpSmtpServerId, obligate, ai] = await Promise.all([
      this.get<boolean>(CONFIG_KEYS.allow2fa),
      this.get<boolean>(CONFIG_KEYS.force2fa),
      this.get<number>(CONFIG_KEYS.otpSmtpServerId),
      this.getObligateConfig(),
      this.getAiConfig(),
    ]);

    return {
      allow2fa: allow2fa === true,
      force2fa: force2fa === true,
      otpSmtpServerId: typeof otpSmtpServerId === 'number' ? otpSmtpServerId : null,
      obligate,
      ai,
    };
  },

  // ── 2FA policy ────────────────────────────────────────────────────────────

  async is2faAllowed(): Promise<boolean> {
    return (await this.get<boolean>(CONFIG_KEYS.allow2fa)) === true;
  },

  async is2faForced(): Promise<boolean> {
    return (await this.get<boolean>(CONFIG_KEYS.force2fa)) === true;
  },

  /** The SMTP server used for one-time codes and password-reset mail. */
  async getOtpSmtpServerId(): Promise<number | null> {
    const value = await this.get<number>(CONFIG_KEYS.otpSmtpServerId);
    return typeof value === 'number' ? value : null;
  },

  // ── Obligate SSO gateway ──────────────────────────────────────────────────

  /** Public view: never exposes the API key, only whether one is stored. */
  async getObligateConfig(): Promise<ObligateConfig> {
    const stored = (await this.get<ObligateStored>(CONFIG_KEYS.obligate)) ?? {};
    const legacyEnabled = await this.get<boolean>(CONFIG_KEYS.obligateEnabled);
    return {
      url: stored.url ?? null,
      apiKeySet: Boolean(stored.apiKeyEnc || stored.apiKey),
      enabled: stored.enabled ?? legacyEnabled === true,
    };
  },

  /**
   * Server-to-server view, with the API key decrypted. Never put the result of
   * this in a response body.
   */
  async getObligateRaw(): Promise<{ url: string | null; apiKey: string | null; enabled: boolean }> {
    const stored = (await this.get<ObligateStored>(CONFIG_KEYS.obligate)) ?? {};
    const legacyEnabled = await this.get<boolean>(CONFIG_KEYS.obligateEnabled);
    return {
      url: stored.url ? stored.url.replace(/\/+$/, '') : null,
      apiKey: readSecret(stored.apiKeyEnc, stored.apiKey),
      enabled: stored.enabled ?? legacyEnabled === true,
    };
  },

  /**
   * Merge-patch. Omitting `apiKey` keeps the stored one (so the admin form can
   * round-trip without ever holding the secret); passing `null` clears it.
   */
  async patchObligateConfig(patch: {
    url?: string | null;
    apiKey?: string | null;
    enabled?: boolean;
  }): Promise<ObligateConfig> {
    const stored = (await this.get<ObligateStored>(CONFIG_KEYS.obligate)) ?? {};
    const current = await this.getObligateConfig();

    const next: ObligateStored = {
      url: 'url' in patch ? (patch.url ?? null) : (stored.url ?? null),
      apiKeyEnc: 'apiKey' in patch
        ? writeSecret(patch.apiKey)
        : (stored.apiKeyEnc ?? writeSecret(stored.apiKey ?? null)),
      enabled: 'enabled' in patch ? Boolean(patch.enabled) : current.enabled,
    };

    await this.set(CONFIG_KEYS.obligate, next);
    // Keep the legacy flag in step so a downgrade still reads the right value.
    await this.set(CONFIG_KEYS.obligateEnabled, next.enabled === true);

    return {
      url: next.url ?? null,
      apiKeySet: Boolean(next.apiKeyEnc),
      enabled: next.enabled === true,
    };
  },

  // ── AI provider ───────────────────────────────────────────────────────────

  /** Public view: provider, model, budget and feature switches. No key. */
  async getAiConfig(): Promise<AiConfig> {
    const stored = (await this.get<AiStored>(CONFIG_KEYS.ai)) ?? {};
    return {
      enabled: stored.enabled === true,
      provider: toProvider(stored.provider),
      model: stored.model ?? null,
      apiKeySet: Boolean(stored.apiKeyEnc || stored.apiKey),
      monthlyBudgetUsd: typeof stored.monthlyBudgetUsd === 'number' ? stored.monthlyBudgetUsd : null,
      features: { ...AI_FEATURE_DEFAULTS, ...(stored.features ?? {}) },
    };
  },

  /** Server-side view with the provider key decrypted. Never serialise this. */
  async getAiRaw(): Promise<AiConfig & { apiKey: string | null; tenantBudgetsUsd: Record<string, number> }> {
    const stored = (await this.get<AiStored>(CONFIG_KEYS.ai)) ?? {};
    const safe = await this.getAiConfig();
    return {
      ...safe,
      apiKey: readSecret(stored.apiKeyEnc, stored.apiKey),
      tenantBudgetsUsd: stored.tenantBudgetsUsd ?? {},
    };
  },

  /**
   * The monthly ceiling that applies to one tenant, looked up BY SLUG
   * (HARD RULE 13). Falls back to the platform-wide budget.
   */
  async getAiBudgetForTenant(tenantSlug: string): Promise<number | null> {
    const stored = (await this.get<AiStored>(CONFIG_KEYS.ai)) ?? {};
    const perTenant = stored.tenantBudgetsUsd ?? {};
    const own = perTenant[tenantSlug];
    if (typeof own === 'number') return own;
    return typeof stored.monthlyBudgetUsd === 'number' ? stored.monthlyBudgetUsd : null;
  },

  async patchAiConfig(patch: {
    enabled?: boolean;
    provider?: AiProvider;
    model?: string | null;
    apiKey?: string | null;
    monthlyBudgetUsd?: number | null;
    tenantBudgetsUsd?: Record<string, number>;
    features?: Partial<AiConfig['features']>;
  }): Promise<AiConfig> {
    const stored = (await this.get<AiStored>(CONFIG_KEYS.ai)) ?? {};

    const next: AiStored = {
      enabled: 'enabled' in patch ? Boolean(patch.enabled) : stored.enabled === true,
      provider: 'provider' in patch ? toProvider(patch.provider) : toProvider(stored.provider),
      model: 'model' in patch ? (patch.model ?? null) : (stored.model ?? null),
      apiKeyEnc: 'apiKey' in patch
        ? writeSecret(patch.apiKey)
        : (stored.apiKeyEnc ?? writeSecret(stored.apiKey ?? null)),
      monthlyBudgetUsd: 'monthlyBudgetUsd' in patch
        ? (typeof patch.monthlyBudgetUsd === 'number' ? patch.monthlyBudgetUsd : null)
        : (stored.monthlyBudgetUsd ?? null),
      tenantBudgetsUsd: 'tenantBudgetsUsd' in patch
        ? (patch.tenantBudgetsUsd ?? {})
        : (stored.tenantBudgetsUsd ?? {}),
      features: { ...AI_FEATURE_DEFAULTS, ...(stored.features ?? {}), ...(patch.features ?? {}) },
    };

    await this.set(CONFIG_KEYS.ai, next);
    return this.getAiConfig();
  },
};
