/**
 * profile.api.ts — the signed-in account: identity, preferences, password and
 * the second factor.
 *
 * `GET /api/profile` deliberately answers with the WHOLE session context —
 * user, active tenant, reachable tenants, expanded capabilities, teams — in one
 * round trip. Three requests would mean three chances to paint a half-authorised
 * UI, and a UI that renders admin chrome for a second before taking it away is
 * worse than one that waits.
 */

import apiClient, { toApiError, unwrap, type Envelope } from './client';
import type { SessionContext, UserPreferences, User } from '@oblidesk/shared';

export interface TwoFactorStatus {
  totpEnabled: boolean;
  emailOtpEnabled: boolean;
  email: string | null;
  /** Operator-level switches — an account cannot enrol when 2FA is off. */
  allowed: boolean;
  forced: boolean;
}

export interface TotpEnrolment {
  /** Base32 secret, shown for manual entry when the camera will not cooperate. */
  secret: string;
  /** otpauth:// URI. */
  uri: string;
  /** PNG data URI of the QR. */
  qrDataUrl: string;
}

export const profileApi = {
  /** The account plus the resolved session context for the active tenant. */
  async get(): Promise<SessionContext> {
    try {
      const res = await apiClient.get<Envelope<SessionContext>>('/profile');
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async update(payload: {
    displayName?: string | null;
    email?: string | null;
    preferredLanguage?: string;
    avatar?: string | null;
  }): Promise<User> {
    try {
      const res = await apiClient.put<Envelope<User>>('/profile', payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Preferences are MERGED server-side, not replaced. Send only what changed —
   * sending the whole bag from a stale copy is how one tab's theme choice
   * silently reverts another tab's density.
   */
  async setPreferences(preferences: Partial<UserPreferences>): Promise<UserPreferences> {
    try {
      const res = await apiClient.put<Envelope<UserPreferences>>('/profile/preferences', preferences);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    try {
      await apiClient.put('/profile/password', { currentPassword, newPassword });
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Just the expanded capability list — cheap enough to poll after a grant. */
  async capabilities(): Promise<Pick<SessionContext, 'capabilities' | 'role' | 'isAdmin'>> {
    try {
      const res = await apiClient.get<Envelope<Pick<SessionContext, 'capabilities' | 'role' | 'isAdmin'>>>(
        '/profile/capabilities',
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Second factor
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Enrolment is always two steps, for both methods: mint a candidate, then prove
 * possession before the factor is armed. Nothing is ever half-enabled — the
 * `*Enabled` flag is the only gate any login path reads.
 */
export const twoFactorApi = {
  async status(): Promise<TwoFactorStatus> {
    try {
      const res = await apiClient.get<Envelope<TwoFactorStatus>>('/profile/2fa/status');
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Step 1 — mint a candidate secret and return the QR for it. */
  async setupTotp(): Promise<TotpEnrolment> {
    try {
      const res = await apiClient.post<Envelope<TotpEnrolment>>('/profile/2fa/totp/setup');
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Step 2 — a live code from the authenticator arms the factor. */
  async enableTotp(code: string): Promise<void> {
    try {
      await apiClient.post('/profile/2fa/totp/enable', { code });
    } catch (error) {
      throw toApiError(error);
    }
  },

  async disableTotp(): Promise<void> {
    try {
      await apiClient.delete('/profile/2fa/totp');
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Step 1 — mail a code to the address being enrolled. */
  async setupEmailOtp(email: string): Promise<{ sent: boolean; email: string; expiresAt: number }> {
    try {
      const res = await apiClient.post<Envelope<{ sent: boolean; email: string; expiresAt: number }>>(
        '/profile/2fa/email/setup',
        { email },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Step 2 — the code proves the inbox, and only then does the address move
   * onto the account. The address is sent again here on purpose: the session
   * holds `sha256(address:code)`, so a code mailed to one inbox can never enrol
   * another.
   */
  async enableEmailOtp(email: string, code: string): Promise<void> {
    try {
      await apiClient.post('/profile/2fa/email/enable', { email, code });
    } catch (error) {
      throw toApiError(error);
    }
  },

  async disableEmailOtp(): Promise<void> {
    try {
      await apiClient.delete('/profile/2fa/email');
    } catch (error) {
      throw toApiError(error);
    }
  },
};

export default profileApi;
