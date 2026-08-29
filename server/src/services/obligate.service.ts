/**
 * obligate.service.ts — the CONSUMER side of Obligate SSO.
 *
 * Oblidesk is registered in Obligate as AppType 'oblidesk'. This module speaks
 * the same wire protocol as every other Obli* app, so nothing here may drift
 * from the provider:
 *
 *   GET  {obligate}/authorize?client_id&redirect_uri&state   (browser)
 *   POST {obligate}/api/oauth/token/exchange                 (server→server)
 *   POST {obligate}/api/apps/report-provision
 *   POST {obligate}/api/apps/sync-capability-schemas
 *   GET  {obligate}/api/apps/connected[?userId=]
 *   GET  {obligate}/api/apps/user-preferences/:obligateUserId
 *   POST {obligate}/api/devices/register  ·  GET {obligate}/api/devices/links
 *
 * Every call authenticates with `Authorization: Bearer <app api key>` held in
 * `app_config` (never in the environment) and every one of them fails SOFT:
 * Obligate being down must degrade Oblidesk to local login, never break it.
 */

import { db } from '../db';
import { logger } from '../utils/logger';
import { safeEqual } from '../utils/crypto';
import { appConfigService } from './appConfig.service';
import { CAPABILITY_SCHEMAS, toAppTheme } from '@oblidesk/shared';
import type { UserPreferences } from '@oblidesk/shared';

/** How long we wait on Obligate before deciding it is unreachable. */
const REACHABILITY_TIMEOUT_MS = 2000;
const EXCHANGE_TIMEOUT_MS = 10000;

/**
 * The claim set Obligate returns from the code exchange. Shape is fixed by
 * the provider (`oauth.service.ts` → `exchangeCode`), not by us.
 */
export interface ObligateUserAssertion {
  obligateUserId: number;
  username: string;
  email: string | null;
  displayName: string | null;
  /** App-wide role: 'admin' means "All tenants" admin — a platform admin here. */
  role: string;
  /** Tenant bindings, identified BY SLUG (HARD RULE 13). */
  tenants: Array<{ slug: string; role: string; capabilities?: string[] }>;
  /** Flat list of team NAMES across the user's tenants. */
  teams: string[];
  capabilities?: string[];
  authSource: 'local' | 'ldap';
  /** Set once we have reported a provision back; lets Obligate re-link. */
  linkedLocalUserId: number | null;
  preferences?: {
    preferredTheme?: string;
    toastEnabled?: boolean;
    toastPosition?: string;
    profilePhotoUrl?: string | null;
    preferredLanguage?: string;
    anonymousMode?: boolean;
    appSpecific?: Record<string, string>;
  };
}

interface ConnectedApp {
  appType: string;
  name: string;
  baseUrl: string;
  icon: string | null;
  color: string | null;
}

interface DeviceLink {
  appType: string;
  name: string;
  url: string;
  icon: string | null;
  color: string | null;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Coerce a toast position pushed by Obligate to something this app renders. */
function toToastPosition(value: unknown): UserPreferences['toastPosition'] | undefined {
  return value === 'top-center' || value === 'bottom-right' ? value : undefined;
}

/**
 * Merge UI preferences into `users.preferences` (jsonb) without dropping keys
 * this app owns and Obligate knows nothing about (density, saved views…).
 */
async function mergeUiPreferences(localUserId: number, incoming: Partial<UserPreferences>): Promise<void> {
  const keys = Object.keys(incoming);
  if (keys.length === 0) return;

  const row = (await db('users').where({ id: localUserId }).first('preferences')) as
    | { preferences: unknown }
    | undefined;

  let existing: Record<string, unknown> = {};
  const stored = row?.preferences;
  if (typeof stored === 'string') {
    try {
      existing = JSON.parse(stored) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  } else if (stored && typeof stored === 'object') {
    existing = stored as Record<string, unknown>;
  }

  await db('users')
    .where({ id: localUserId })
    .update({ preferences: JSON.stringify({ ...existing, ...incoming }), updated_at: new Date() });
}

export const obligateService = {
  /**
   * What the login page asks for: is SSO configured, enabled and up right now?
   * Never throws — a dead Obligate must still render a local login form.
   */
  async getSsoConfig(): Promise<{ obligateUrl: string | null; obligateReachable: boolean; obligateEnabled: boolean }> {
    const cfg = await appConfigService.getObligateConfig();
    if (!cfg.url || !cfg.enabled) {
      return { obligateUrl: cfg.url, obligateReachable: false, obligateEnabled: cfg.enabled };
    }

    try {
      const res = await fetchWithTimeout(`${cfg.url}/health`, {}, REACHABILITY_TIMEOUT_MS);
      return { obligateUrl: cfg.url, obligateReachable: res.ok, obligateEnabled: true };
    } catch {
      return { obligateUrl: cfg.url, obligateReachable: false, obligateEnabled: true };
    }
  },

  /**
   * Trade the one-time code for the assertion. `redirectUri` MUST be byte-for
   * byte the one used in the authorize request — Obligate claims the code on
   * the pair, so a mismatch is indistinguishable from a replay and returns
   * null.
   */
  async exchangeCode(code: string, redirectUri: string): Promise<ObligateUserAssertion | null> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) {
      logger.warn('obligate: code exchange skipped — SSO is not configured');
      return null;
    }

    try {
      const res = await fetchWithTimeout(
        `${raw.url}/api/oauth/token/exchange`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${raw.apiKey}` },
          body: JSON.stringify({ code, redirect_uri: redirectUri }),
        },
        EXCHANGE_TIMEOUT_MS,
      );

      if (!res.ok) {
        logger.warn({ status: res.status }, 'obligate: code exchange rejected');
        return null;
      }

      const data = (await res.json()) as { success: boolean; data?: ObligateUserAssertion };
      if (!data.success || !data.data) return null;
      return data.data;
    } catch (err) {
      logger.error({ err }, 'obligate: code exchange failed');
      return null;
    }
  },

  /**
   * Tell Obligate which local user id an Obligate user maps to, so the next
   * assertion carries `linkedLocalUserId` and we never provision twice.
   * `remoteUserId = 0` clears a stale link.
   */
  async reportProvision(obligateUserId: number, remoteUserId: number): Promise<void> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;

    try {
      await fetchWithTimeout(
        `${raw.url}/api/apps/report-provision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${raw.apiKey}` },
          body: JSON.stringify({ obligateUserId, remoteUserId }),
        },
        EXCHANGE_TIMEOUT_MS,
      );
    } catch (err) {
      logger.error({ err, obligateUserId }, 'obligate: report-provision failed');
    }
  },

  /**
   * Publish this app's capability catalogue to Obligate so an operator can
   * tick real Oblidesk capabilities on a user↔tenant binding instead of
   * typing free-form strings. Called once at boot; a failure is logged and
   * forgotten — the catalogue is a convenience for Obligate's UI, and the
   * authoritative copy always lives in @oblidesk/shared.
   */
  async syncCapabilitySchemas(): Promise<void> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;

    try {
      const res = await fetchWithTimeout(
        `${raw.url}/api/apps/sync-capability-schemas`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${raw.apiKey}` },
          body: JSON.stringify({ schemas: CAPABILITY_SCHEMAS }),
        },
        EXCHANGE_TIMEOUT_MS,
      );
      if (res.ok) {
        logger.info({ count: CAPABILITY_SCHEMAS.length }, 'obligate: capability schemas synced');
      } else {
        logger.warn({ status: res.status }, 'obligate: capability schema sync refused');
      }
    } catch (err) {
      logger.warn({ err }, 'obligate: capability schema sync failed');
    }
  },

  /**
   * Register a device UUID + path so ObliTools can offer the other Obli* apps
   * installed on the same machine. Throttled to one call per UUID per 10 min;
   * a failed attempt does NOT arm the throttle, so the next push retries.
   */
  _linkThrottle: new Map<string, number>(),
  async registerDeviceLink(uuid: string, appPath: string): Promise<void> {
    const now = Date.now();
    if (now - (this._linkThrottle.get(uuid) ?? 0) < 10 * 60 * 1000) return;

    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;

    try {
      const res = await fetchWithTimeout(
        `${raw.url}/api/devices/register`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${raw.apiKey}` },
          body: JSON.stringify({ uuid, path: appPath }),
        },
        EXCHANGE_TIMEOUT_MS,
      );
      if (res.ok) this._linkThrottle.set(uuid, now);
    } catch {
      /* non-critical — retried on the next push */
    }
  },

  async getDeviceLinks(uuid: string): Promise<DeviceLink[]> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return [];

    try {
      const res = await fetchWithTimeout(
        `${raw.url}/api/devices/links?uuid=${encodeURIComponent(uuid)}`,
        { headers: { Authorization: `Bearer ${raw.apiKey}` } },
        EXCHANGE_TIMEOUT_MS,
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { success: boolean; data?: DeviceLink[] };
      return data.data ?? [];
    } catch {
      return [];
    }
  },

  /**
   * Pull the user's preferences from Obligate and mirror them locally, so a
   * theme or language picked in any suite app follows the user here.
   * Throttled to once a minute per local user; never throws.
   */
  _prefThrottle: new Map<number, number>(),
  async syncUserPreferences(localUserId: number, obligateUserId: number): Promise<void> {
    const now = Date.now();
    if (now - (this._prefThrottle.get(localUserId) ?? 0) < 60 * 1000) return;

    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;

    try {
      const res = await fetchWithTimeout(
        `${raw.url}/api/apps/user-preferences/${obligateUserId}`,
        { headers: { Authorization: `Bearer ${raw.apiKey}` } },
        EXCHANGE_TIMEOUT_MS,
      );
      if (!res.ok) return;
      this._prefThrottle.set(localUserId, now);

      const { success, data } = (await res.json()) as {
        success: boolean;
        data?: {
          preferredTheme?: string;
          toastEnabled?: boolean;
          toastPosition?: string;
          preferredLanguage?: string;
          anonymousMode?: boolean;
          profilePhotoUrl?: string | null;
        };
      };
      if (!success || !data) return;

      await this.applyPreferences(localUserId, data);
    } catch {
      /* non-critical */
    }
  },

  /**
   * Apply an Obligate preference payload to the local user. Shared by the SSO
   * callback (fresh assertion) and the throttled background sync.
   */
  async applyPreferences(
    localUserId: number,
    prefs: {
      preferredTheme?: string;
      toastEnabled?: boolean;
      toastPosition?: string;
      preferredLanguage?: string;
      anonymousMode?: boolean;
      profilePhotoUrl?: string | null;
    },
  ): Promise<void> {
    // Columns: language and avatar are first-class on `users`.
    const columnUpdate: Record<string, unknown> = {};
    if (prefs.preferredLanguage) columnUpdate.preferred_language = prefs.preferredLanguage;
    if (prefs.profilePhotoUrl !== undefined) columnUpdate.avatar = prefs.profilePhotoUrl;
    if (Object.keys(columnUpdate).length > 0) {
      columnUpdate.updated_at = new Date();
      await db('users').where({ id: localUserId }).update(columnUpdate);
    }

    // JSON: the UI preferences. A theme Oblidesk cannot render is coerced to
    // the default rather than written through — an upstream theme must never
    // be able to brick the client.
    const ui: Partial<UserPreferences> = {};
    if (prefs.preferredTheme) ui.preferredTheme = toAppTheme(prefs.preferredTheme);
    if (prefs.toastEnabled !== undefined) ui.toastEnabled = prefs.toastEnabled;
    const position = toToastPosition(prefs.toastPosition);
    if (position) ui.toastPosition = position;
    if (prefs.anonymousMode !== undefined) ui.anonymousMode = prefs.anonymousMode;

    await mergeUiPreferences(localUserId, ui);
  },

  /**
   * The app switcher's contents.
   *
   * Scoped to the caller's Obligate entitlements whenever we know their
   * Obligate id: without `userId` the provider returns EVERY connected app,
   * and the header would advertise apps the user cannot open.
   */
  async getConnectedApps(obligateUserId?: number | null): Promise<ConnectedApp[]> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return [];

    const url = obligateUserId
      ? `${raw.url}/api/apps/connected?userId=${encodeURIComponent(String(obligateUserId))}`
      : `${raw.url}/api/apps/connected`;

    try {
      const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${raw.apiKey}` } }, EXCHANGE_TIMEOUT_MS);
      if (!res.ok) return [];
      const data = (await res.json()) as { success: boolean; data?: ConnectedApp[] };
      return data.data ?? [];
    } catch {
      return [];
    }
  },

  /**
   * The logout URL to bounce through after a local logout, so the Obligate
   * session dies too and the next login is a real login.
   */
  async getLogoutUrl(redirectUri: string): Promise<string | null> {
    const cfg = await appConfigService.getObligateRaw();
    if (!cfg.url) return null;
    return `${cfg.url}/logout?redirect_uri=${encodeURIComponent(redirectUri)}`;
  },

  /**
   * Guard for the endpoints Obligate calls on US (`/app-info`,
   * `/dashboard-stats`, `/sso-user-sync`): the Bearer token must equal the
   * API key we hold for it.
   */
  async verifyInboundBearer(authorization: string | undefined): Promise<boolean> {
    if (!authorization?.startsWith('Bearer ')) return false;
    const raw = await appConfigService.getObligateRaw();
    if (!raw.apiKey) return false;
    // Timing-safe: this is a value an attacker can submit repeatedly.
    return safeEqual(authorization.slice(7), raw.apiKey);
  },
};
