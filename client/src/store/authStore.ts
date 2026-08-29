/**
 * authStore.ts — who is signed in, in which tenant, with what rights.
 *
 * The server resolves all of that ONCE per request into a `SessionContext`:
 * the user, the active tenant, every tenant they can switch to, their
 * capabilities already expanded through the `implies` graph, and their teams.
 * This store caches that object and nothing else. It never derives a permission
 * locally beyond reading the expanded list — a client that computes its own
 * capability closure will drift from the server's, and the disagreement always
 * surfaces as "the button was there and then it 403'd".
 *
 * `hasCapability` is a RENDER hint. Every mutation is authorised again server
 * side; hiding a control the server would refuse is courtesy, not security.
 */

import { create } from 'zustand';
import type { Capability, SessionContext, User, UserPreferences, UserRole } from '@oblidesk/shared';
import { authApi, isMfaChallenge, type LoginMfaChallenge, type LoginResult } from '@/api/auth.api';
import { profileApi } from '@/api/profile.api';
import { setAuthToken, setTenantOverride } from '@/api/client';
import { connectSocket, disconnectSocket } from '@/socket';
import { applyTheme } from '@/utils/theme';
import { setLanguage } from '@/i18n';
import { useTenantStore } from './tenantStore';
import { useUiStore } from './uiStore';

/** Push the preferences that live outside this store into their owners. */
function syncPreferences(user: User): void {
  const prefs = user.preferences ?? null;
  if (prefs?.preferredTheme) applyTheme(prefs.preferredTheme);
  if (prefs?.density) useUiStore.getState().setDensity(prefs.density);
  if (typeof prefs?.sidebarCollapsed === 'boolean') {
    useUiStore.getState().setSidebarCollapsed(prefs.sidebarCollapsed);
  }
  if (user.preferredLanguage) setLanguage(user.preferredLanguage);
}

interface AuthState {
  session: SessionContext | null;
  user: User | null;
  /** Force-2FA is on and this account has no factor yet — route to /enroll. */
  requires2faSetup: boolean;
  /** A sign-in that is waiting for a second factor. Never a session. */
  mfaChallenge: LoginMfaChallenge | null;

  isLoading: boolean;
  /** False until the first `checkSession` settles — routes must wait on it. */
  isInitialized: boolean;

  login: (username: string, password: string, tenantSlug?: string) => Promise<LoginResult>;
  completeMfa: (method: 'totp' | 'email', code: string) => Promise<void>;
  resendMfa: () => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  /** Re-read the session after a grant change or a tenant switch. */
  refresh: () => Promise<void>;
  /** Merge-patch the signed-in user's preferences, optimistically. */
  savePreferences: (patch: Partial<UserPreferences>) => Promise<void>;

  isAdmin: () => boolean;
  hasRole: (...roles: UserRole[]) => boolean;
  hasCapability: (capability: Capability) => boolean;
  hasAnyCapability: (...capabilities: Capability[]) => boolean;
  hasAllCapabilities: (...capabilities: Capability[]) => boolean;
}

/** Adopt a freshly issued session: state, side stores, socket. */
function adopt(
  set: (partial: Partial<AuthState>) => void,
  session: SessionContext,
  extras: { authToken?: string; requires2faSetup?: boolean } = {},
): void {
  if (extras.authToken) setAuthToken(extras.authToken);

  set({
    session,
    user: session.user,
    requires2faSetup: extras.requires2faSetup ?? false,
    mfaChallenge: null,
    isLoading: false,
    isInitialized: true,
  });

  syncPreferences(session.user);
  useTenantStore.getState().adoptSession(session);
  connectSocket(session.tenant.id);
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  requires2faSetup: false,
  mfaChallenge: null,
  isLoading: false,
  isInitialized: false,

  login: async (username, password, tenantSlug) => {
    set({ isLoading: true });
    try {
      const result = await authApi.login({ username, password, tenantSlug });

      if (isMfaChallenge(result)) {
        // The PENDING session's id. The cookie-less shell must replay it or the
        // verify call arrives with no sign-in waiting on it.
        setAuthToken(result.mfaToken);
        set({ mfaChallenge: result, isLoading: false });
        return result;
      }

      adopt(set, result.session, {
        authToken: result.authToken,
        requires2faSetup: result.requires2faSetup,
      });
      return result;
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  completeMfa: async (method, code) => {
    set({ isLoading: true });
    try {
      const result = await authApi.verifyMfa(method, code);
      adopt(set, result.session, {
        authToken: result.authToken,
        requires2faSetup: result.requires2faSetup,
      });
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  resendMfa: async () => {
    const challenge = get().mfaChallenge;
    if (!challenge) return;
    const { expiresAt } = await authApi.resendMfa();
    set({ mfaChallenge: { ...challenge, emailSent: true, expiresAt } });
  },

  logout: async () => {
    // Ask for the SSO logout URL before destroying the local session — the
    // endpoint needs it, and after `logout()` it would 401.
    const ssoLogoutUrl = await authApi.ssoLogoutUrl();

    try {
      await authApi.logout();
    } finally {
      disconnectSocket();
      setAuthToken(null);
      setTenantOverride(null);
      useTenantStore.getState().reset();
      set({
        session: null,
        user: null,
        requires2faSetup: false,
        mfaChallenge: null,
        isInitialized: true,
      });
    }

    if (ssoLogoutUrl) window.location.href = ssoLogoutUrl;
  },

  checkSession: async () => {
    try {
      const me = await authApi.me();
      const { authToken, requires2faSetup, ...session } = me;
      adopt(set, session as SessionContext, { authToken, requires2faSetup });
    } catch {
      // Not signed in is a normal answer here, not an error to surface.
      set({
        session: null,
        user: null,
        requires2faSetup: false,
        isInitialized: true,
        isLoading: false,
      });
    }
  },

  refresh: async () => {
    try {
      const session = await profileApi.get();
      set({ session, user: session.user });
      syncPreferences(session.user);
      useTenantStore.getState().adoptSession(session);
    } catch {
      // A failed refresh leaves the last good context in place. Blanking the
      // UI because one poll failed is a worse answer than slightly stale rights.
    }
  },

  savePreferences: async (patch) => {
    const current = get().user;
    if (!current) return;

    const optimistic: User = {
      ...current,
      preferences: { ...(current.preferences ?? {}), ...patch },
    };
    set({ user: optimistic, session: get().session ? { ...get().session!, user: optimistic } : null });
    syncPreferences(optimistic);

    try {
      const saved = await profileApi.setPreferences(patch);
      const merged: User = { ...optimistic, preferences: saved };
      set({ user: merged, session: get().session ? { ...get().session!, user: merged } : null });
    } catch (error) {
      // Roll back to what the server last confirmed rather than leaving the UI
      // showing a preference that was never stored.
      set({ user: current, session: get().session ? { ...get().session!, user: current } : null });
      syncPreferences(current);
      throw error;
    }
  },

  isAdmin: () => get().session?.isAdmin === true,

  hasRole: (...roles) => {
    const role = get().session?.role;
    return role !== undefined && roles.includes(role);
  },

  hasCapability: (capability) => {
    const session = get().session;
    if (!session) return false;
    // A tenant admin holds every capability by definition; the server agrees.
    if (session.isAdmin) return true;
    return session.capabilities.includes(capability);
  },

  hasAnyCapability: (...capabilities) => {
    const has = get().hasCapability;
    return capabilities.some((capability) => has(capability));
  },

  hasAllCapabilities: (...capabilities) => {
    const has = get().hasCapability;
    return capabilities.every((capability) => has(capability));
  },
}));

/** Non-reactive read, for modules outside React (interceptors, socket wiring). */
export function currentSession(): SessionContext | null {
  return useAuthStore.getState().session;
}
