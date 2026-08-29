/**
 * auth.api.ts — sign-in, the second factor, passwords and the SSO handoff.
 *
 * `login` has two shapes of success and the caller must handle both: either the
 * session was issued, or a second factor is owed. They are discriminated by
 * `mfaRequired`, never by "is `session` undefined" — a narrow that would break
 * silently the day the server adds a field.
 */

import apiClient, { toApiError, unwrap, type Envelope } from './client';
import type { LoginRequest, SessionContext } from '@oblidesk/shared';

/** The session was issued — sign-in is done. */
export interface LoginEstablished {
  session: SessionContext;
  /** Session id, replayed in `X-Auth-Token` when cookies are unavailable. */
  authToken: string;
  /** Force-2FA is on and this account has no factor yet. */
  requires2faSetup: boolean;
  mfaRequired?: undefined;
}

/** A second factor is owed before the session exists. */
export interface LoginMfaChallenge {
  mfaRequired: 'totp' | 'email_otp';
  /** The PENDING session's id — the cookie-less shell replays this one. */
  mfaToken: string;
  methods: { totp: boolean; email: boolean };
  emailSent: boolean;
  expiresAt: number;
  session?: undefined;
}

export type LoginResult = LoginEstablished | LoginMfaChallenge;

export function isMfaChallenge(result: LoginResult): result is LoginMfaChallenge {
  return (result as LoginMfaChallenge).mfaRequired !== undefined;
}

/** `GET /api/auth/me` — the session context, plus the two client-only extras. */
export type MeResponse = SessionContext & {
  authToken: string;
  requires2faSetup: boolean;
};

export interface SsoConfig {
  enabled: boolean;
  url: string | null;
  appType: string;
}

export interface ConnectedApp {
  appType: string;
  name: string;
  url: string;
  iconUrl?: string | null;
}

export interface DeviceLink {
  id: number;
  deviceName: string;
  appType: string;
  lastSeenAt: string | null;
}

export const authApi = {
  /**
   * `tenantSlug` is the cross-app handoff (HARD RULE 13): a user arriving from
   * Obliguard's tenant switcher lands on the same tenant here, by slug, because
   * the numeric ids of two apps are unrelated.
   */
  async login(data: LoginRequest & { tenantSlug?: string }): Promise<LoginResult> {
    try {
      const res = await apiClient.post<Envelope<LoginResult>>('/auth/login', data);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Finish a two-step sign-in. Returns the same envelope `login` does. */
  async verifyMfa(method: 'totp' | 'email', code: string): Promise<LoginEstablished> {
    try {
      const res = await apiClient.post<Envelope<LoginEstablished>>('/profile/2fa/verify', { method, code });
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Send a fresh e-mail code for the pending sign-in. */
  async resendMfa(): Promise<{ sent: boolean; expiresAt: number }> {
    try {
      const res = await apiClient.post<Envelope<{ sent: boolean; expiresAt: number }>>('/profile/2fa/resend');
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async logout(): Promise<void> {
    try {
      await apiClient.post('/auth/logout');
    } catch (error) {
      // A logout that fails server-side must still clear the client. The store
      // wipes state in a `finally`; swallowing here keeps that path simple.
      if (toApiError(error).status !== 401) throw toApiError(error);
    }
  },

  async me(): Promise<MeResponse> {
    try {
      const res = await apiClient.get<Envelope<MeResponse>>('/auth/me');
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    try {
      await apiClient.post('/auth/change-password', { currentPassword, newPassword });
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Always resolves — the server never says whether the address exists. */
  async forgotPassword(email: string): Promise<void> {
    try {
      await apiClient.post('/auth/forgot-password', { email });
    } catch (error) {
      throw toApiError(error);
    }
  },

  async validateResetToken(token: string): Promise<{ valid: boolean; username?: string }> {
    try {
      const res = await apiClient.post<Envelope<{ valid: boolean; username?: string }>>(
        '/auth/reset-password/validate',
        { token },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async resetPassword(token: string, password: string): Promise<void> {
    try {
      await apiClient.post('/auth/reset-password', { token, password });
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Obligate SSO ──────────────────────────────────────────────────────────

  async ssoConfig(): Promise<SsoConfig> {
    const res = await apiClient.get<Envelope<SsoConfig>>('/auth/sso-config');
    return unwrap(res.data);
  },

  /** Where to send the browser after a local logout, when SSO is in play. */
  async ssoLogoutUrl(): Promise<string | null> {
    try {
      const res = await apiClient.get<Envelope<string | null>>('/auth/sso-logout-url');
      return unwrap(res.data);
    } catch {
      // A missing logout URL must never block signing out locally.
      return null;
    }
  },

  /** The app switcher. Never fatal — an empty switcher is a cosmetic loss. */
  async connectedApps(): Promise<ConnectedApp[]> {
    try {
      const res = await apiClient.get<Envelope<ConnectedApp[]>>('/auth/connected-apps');
      return unwrap(res.data) ?? [];
    } catch {
      return [];
    }
  },

  async deviceLinks(): Promise<DeviceLink[]> {
    try {
      const res = await apiClient.get<Envelope<DeviceLink[]>>('/auth/device-links');
      return unwrap(res.data) ?? [];
    } catch {
      return [];
    }
  },
};

/**
 * The browser round trip that starts SSO. A full navigation, not an XHR: the
 * provider answers with a redirect the fetch layer cannot follow across origins.
 */
export function ssoRedirectUrl(tenantSlug?: string): string {
  const query = tenantSlug ? `?tenant=${encodeURIComponent(tenantSlug)}` : '';
  return `/auth/sso-redirect${query}`;
}

export default authApi;
