/**
 * tenantStore.ts — which tenant the desk is looking at.
 *
 * HARD RULE 13: the cross-app identity is the tenant SLUG. The numeric id is
 * local to this installation and must never leave it — a handoff to Obliguard
 * carries `?tenant=<slug>`, never `?tenant=4`.
 *
 * ── Switching ───────────────────────────────────────────────────────────────
 * The right mechanism is a SESSION switch: it survives a reload, a socket
 * reconnect and a second tab. `requireTenant` reads `session.currentTenantId`
 * first and only then honours the `X-Tenant-Id` override — and that override is
 * refused for anyone who is not a platform admin.
 *
 * So `switchTenant` tries the session endpoint, and falls back to the header
 * ONLY for a platform admin. For anyone else it fails loudly rather than
 * sending a header that would 403 every subsequent request and look like the
 * app had broken.
 */

import { create } from 'zustand';
import type { SessionContext, TenantMembership } from '@oblidesk/shared';
import { tenantsApi } from '@/api/tenants.api';
import { setTenantOverride } from '@/api/client';
import { connectSocket } from '@/socket';

interface TenantState {
  currentTenantId: number | null;
  currentTenantSlug: string | null;
  currentTenantName: string | null;
  isMasterTenant: boolean;
  /** Every tenant the signed-in user may act in. */
  memberships: TenantMembership[];
  isSwitching: boolean;

  /** Called by the auth store whenever a session context arrives. */
  adoptSession: (session: SessionContext) => void;
  fetchMemberships: () => Promise<void>;
  switchTenant: (tenantId: number) => Promise<void>;
  reset: () => void;

  bySlug: (slug: string) => TenantMembership | undefined;
}

export const useTenantStore = create<TenantState>((set, get) => ({
  currentTenantId: null,
  currentTenantSlug: null,
  currentTenantName: null,
  isMasterTenant: false,
  memberships: [],
  isSwitching: false,

  adoptSession: (session) => {
    set({
      currentTenantId: session.tenant.id,
      currentTenantSlug: session.tenant.slug,
      currentTenantName: session.tenant.name,
      isMasterTenant: session.isMasterTenant,
      // The session context already carries them; a second fetch would be a
      // round trip for data we were just handed.
      memberships: session.tenants,
    });
  },

  fetchMemberships: async () => {
    try {
      set({ memberships: await tenantsApi.mine() });
    } catch {
      // The switcher going empty is a cosmetic loss; the current tenant still
      // works. Never blank the page over it.
    }
  },

  switchTenant: async (tenantId) => {
    const { currentTenantId, memberships } = get();
    if (tenantId === currentTenantId) return;

    const target = memberships.find((membership) => membership.tenantId === tenantId);
    if (!target) {
      throw new Error('Vous n’êtes pas membre de ce tenant / You are not a member of that tenant');
    }

    set({ isSwitching: true });
    try {
      const switched = await tenantsApi.trySwitch(tenantId);

      if (!switched) {
        // No session-side switch on this server. The per-request override is
        // legal only for a platform admin — see the header note above.
        const { useAuthStore } = await import('./authStore');
        if (!useAuthStore.getState().isAdmin()) {
          throw new Error(
            'Le changement de tenant n’est pas disponible / Switching tenants is not available on this server',
          );
        }
        setTenantOverride(tenantId);
      }

      // Re-resolve rights from the server rather than assuming this membership's
      // capabilities: role and grants differ per tenant, and guessing them is
      // how the UI offers a button the next request refuses.
      const { useAuthStore } = await import('./authStore');
      await useAuthStore.getState().refresh();

      // Rooms were authorised at connect time, so the socket has to be rebuilt.
      connectSocket(tenantId);

      set({
        currentTenantId: tenantId,
        currentTenantSlug: target.tenantSlug,
        currentTenantName: target.tenantName,
        isMasterTenant: target.isMaster,
      });
    } finally {
      set({ isSwitching: false });
    }
  },

  reset: () => {
    setTenantOverride(null);
    set({
      currentTenantId: null,
      currentTenantSlug: null,
      currentTenantName: null,
      isMasterTenant: false,
      memberships: [],
      isSwitching: false,
    });
  },

  bySlug: (slug) => get().memberships.find((membership) => membership.tenantSlug === slug),
}));

/** The slug to hand to a sibling app in a cross-app link (HARD RULE 13). */
export function currentTenantSlug(): string | null {
  return useTenantStore.getState().currentTenantSlug;
}
