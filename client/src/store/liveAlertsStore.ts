/**
 * liveAlertsStore.ts — the bell feed, and the toast tray that is a view of it.
 *
 * ── Where the rows come from ────────────────────────────────────────────────
 * Alerts arrive over the socket as `notification:new` and nowhere else. There
 * is no REST surface for `live_alerts` on the server, so this store is fed by
 * `useSocket` and holds what arrived while the tab was open. That is a
 * deliberate limit, not an oversight: a reload starts the bell empty rather
 * than replaying a night's worth of resolved noise.
 *
 * ── Read state is local ─────────────────────────────────────────────────────
 * `LiveAlert.readAt` is the server's truth and the only thing the wire carries;
 * the server exposes no endpoint to set it. `read` is therefore the client's
 * own flag, and `isAlertRead` (LiveAlerts.tsx) reads it first and falls back to
 * `readAt`. Nothing here invents a request the API does not answer.
 *
 * ── The three switches belong to the ACCOUNT ────────────────────────────────
 * "pop-ups on", "pop-ups for every tenant" and the toast corner are
 * `UserPreferences`, so they must follow the user to another machine. The auth
 * store owns them; this store MIRRORS them and writes through
 * `savePreferences`. One writer, one direction — a second copy of a preference
 * is how two tabs end up disagreeing about it.
 *
 * ── Dismissing is not reading ───────────────────────────────────────────────
 * `dismissToast` hides the card and nothing else. An SLA breach that scrolled
 * past while somebody was on a call stays unread in the bell until it is
 * actually opened.
 */

import { create } from 'zustand';
import type { LiveAlert, UserPreferences } from '@oblidesk/shared';
import type { DeskAlert } from '@/components/layout/LiveAlerts';
import { useAuthStore } from './authStore';

export type ToastPosition = NonNullable<UserPreferences['toastPosition']>;

/**
 * Enough history to survive an alert storm and still scroll the bell, bounded
 * so a bad night cannot grow the tab's memory without limit.
 */
const MAX_ALERTS = 200;

/**
 * A re-fire of a known `stableKey` is the SAME alert, not a second one — that
 * is the whole point of the key on the wire — so it replaces its row instead of
 * stacking under it. The key is only unique within a tenant.
 */
function isSameAlert(existing: DeskAlert, incoming: LiveAlert): boolean {
  if (existing.id === incoming.id) return true;
  return (
    incoming.stableKey !== null &&
    existing.stableKey === incoming.stableKey &&
    existing.tenantId === incoming.tenantId
  );
}

interface PreferenceSlice {
  localEnabled: boolean;
  multiTenantEnabled: boolean;
  position: ToastPosition;
}

/**
 * Defaults matter here: an account that has never touched the switches should
 * see its own tenant's pop-ups (that is what the bell is for) and NOT every
 * other tenant's, which is opt-in noise for a platform admin.
 */
function preferenceSlice(preferences: UserPreferences | null | undefined): PreferenceSlice {
  return {
    localEnabled: preferences?.toastEnabled ?? true,
    multiTenantEnabled: preferences?.multiTenantNotificationsEnabled ?? false,
    position: preferences?.toastPosition ?? 'bottom-right',
  };
}

interface LiveAlertsState extends PreferenceSlice {
  alerts: DeskAlert[];

  /** One `notification:new` frame. Called by `useSocket`, never by a page. */
  receive: (alert: LiveAlert) => void;

  /** Hide the toast, leave the alert unread in the bell. */
  dismissToast: (id: number) => void;
  markAlertRead: (id: number) => void;
  markAllRead: () => void;
  removeAlert: (id: number) => void;
  clearAll: () => void;

  setLocalEnabled: (value: boolean) => void;
  setMultiTenantEnabled: (value: boolean) => void;

  /** Mirror the signed-in account's preferences. Driven by the auth store. */
  adoptPreferences: (preferences: UserPreferences | null | undefined) => void;
}

export const useLiveAlertsStore = create<LiveAlertsState>((set, get) => ({
  alerts: [],
  ...preferenceSlice(useAuthStore.getState().user?.preferences),

  receive: (alert) =>
    set((state) => ({
      // Newest first: the toast tray reverses it for the bottom-right stack and
      // takes `[0]` for the single top-center card.
      alerts: [{ ...alert }, ...state.alerts.filter((existing) => !isSameAlert(existing, alert))]
        .slice(0, MAX_ALERTS),
    })),

  dismissToast: (id) =>
    set((state) => ({
      alerts: state.alerts.map((alert) =>
        alert.id === id ? { ...alert, toastDismissed: true } : alert,
      ),
    })),

  markAlertRead: (id) =>
    set((state) => ({
      alerts: state.alerts.map((alert) => (alert.id === id ? { ...alert, read: true } : alert)),
    })),

  markAllRead: () =>
    set((state) => ({
      alerts: state.alerts.map((alert) => ({ ...alert, read: true })),
    })),

  removeAlert: (id) =>
    set((state) => ({ alerts: state.alerts.filter((alert) => alert.id !== id) })),

  clearAll: () => set({ alerts: [] }),

  setLocalEnabled: (value) => {
    // Optimistic locally so the switch answers the click even before the PUT,
    // and even on the sign-in screen where there is no account to save against.
    set({ localEnabled: value });
    void useAuthStore
      .getState()
      .savePreferences({ toastEnabled: value })
      .catch(() => {
        // `savePreferences` already rolled the account back to what the server
        // confirmed. Re-mirror it rather than leaving the switch showing a
        // choice that was never stored.
        get().adoptPreferences(useAuthStore.getState().user?.preferences);
      });
  },

  setMultiTenantEnabled: (value) => {
    set({ multiTenantEnabled: value });
    void useAuthStore
      .getState()
      .savePreferences({ multiTenantNotificationsEnabled: value })
      .catch(() => {
        get().adoptPreferences(useAuthStore.getState().user?.preferences);
      });
  },

  adoptPreferences: (preferences) => set(preferenceSlice(preferences)),
}));

/**
 * The account is the source of truth for the three switches, so this store
 * follows it: a sign-in, a `refresh()` after a tenant switch and the profile
 * page all land here without anyone wiring them up.
 *
 * Signing out drops the feed as well — the alerts belonged to that session's
 * user and tenant, and leaving them behind the login screen would show the next
 * person who signs in on this machine somebody else's breaches.
 */
useAuthStore.subscribe((state, previous) => {
  if (state.user === previous.user) return;
  if (!state.user) {
    useLiveAlertsStore.getState().clearAll();
    return;
  }
  useLiveAlertsStore.getState().adoptPreferences(state.user.preferences);
});

export default useLiveAlertsStore;
