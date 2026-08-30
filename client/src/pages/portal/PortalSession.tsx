/**
 * PortalSession.tsx — who is signed in to the customer portal, and the gate.
 *
 * ── Why this is not `authStore` ─────────────────────────────────────────────
 * The agent store holds a `users` row, a tenant membership and a resolved
 * capability set. A portal contact has none of those three: no user row exists,
 * the tenant is pinned in the session by the burned magic-link token, and
 * `req.portal` deliberately carries no capabilities field at all so that no
 * capability middleware can ever be pointed at it. Modelling a requester in the
 * agent store would mean inventing an empty capability set for them, and an
 * empty set is one default-permission edit away from not being empty.
 *
 * So the two principals share a cookie jar and nothing else, here as on the
 * server. This context knows exactly what `GET /api/portal/me` reports and
 * refuses to synthesise the rest.
 *
 * ── The gate is a 401, not a stored flag ────────────────────────────────────
 * `requirePortalSession` re-reads the contact on EVERY request, so a contact an
 * agent deactivates at 09:00 loses access at 09:00 rather than at session
 * expiry. A client that trusted a boolean captured at boot would keep rendering
 * a dead session's screens until the next reload. `refresh()` therefore re-asks
 * the server, and any 401 anywhere collapses the session to anonymous.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { portalApi, type PortalMe } from '@/api/portal.api';
import { ApiError } from '@/api/client';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

export type PortalSessionStatus = 'loading' | 'authenticated' | 'anonymous';

interface PortalSessionValue {
  status: PortalSessionStatus;
  me: PortalMe | null;
  /**
   * Whether the ORGANISATION view may be offered at all.
   *
   * True only when the server explicitly says `org_visibility = 'organization'`
   * AND the contact actually belongs to an organisation — the same conjunction
   * `visibleTickets()` requires before it widens. Absent information is false:
   * see the note on `PortalMe.orgVisibility`.
   */
  canReadOrganization: boolean;
  /** Re-ask the server. Cheap, and the only way to notice a revoked contact. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const PortalSessionContext = createContext<PortalSessionValue | null>(null);

export function usePortalSession(): PortalSessionValue {
  const value = useContext(PortalSessionContext);
  if (!value) {
    // A hard throw rather than a null-shaped default: a portal screen rendered
    // outside the provider would otherwise show an empty page with no clue why.
    throw new Error('usePortalSession must be used inside <PortalSessionProvider>');
  }
  return value;
}

export function PortalSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<PortalSessionStatus>('loading');
  const [me, setMe] = useState<PortalMe | null>(null);

  // StrictMode mounts effects twice in development. Without this the boot probe
  // fires two identical requests and the second one's rate-limit bucket entry is
  // spent for nothing.
  const probed = useRef(false);

  const load = useCallback(async () => {
    try {
      const profile = await portalApi.me();
      setMe(profile);
      setStatus('authenticated');
    } catch (error) {
      // Any refusal is the same refusal here. A 401 is an expired or destroyed
      // session; anything else means we cannot prove a session exists, and
      // rendering the portal on an unproven session is the one outcome to avoid.
      setMe(null);
      setStatus('anonymous');
      if (!(error instanceof ApiError) || error.status === 0) {
        // Network failures are worth surfacing in the console — a customer
        // reporting "the portal signed me out" is usually this.
        console.warn('portal: session probe failed', error);
      }
    }
  }, []);

  useEffect(() => {
    if (probed.current) return;
    probed.current = true;
    void load();
  }, [load]);

  const signOut = useCallback(async () => {
    await portalApi.logout();
    setMe(null);
    setStatus('anonymous');
    // A full navigation, not `navigate()`: the session cookie has just been
    // destroyed server-side, and re-booting the SPA is what guarantees no
    // component is left holding a fetched-under-the-old-session list.
    window.location.assign('/portal/login');
  }, []);

  const value = useMemo<PortalSessionValue>(
    () => ({
      status,
      me,
      canReadOrganization: me?.orgVisibility === 'organization' && me.organizationId !== null,
      refresh: load,
      signOut,
    }),
    [status, me, load, signOut],
  );

  return <PortalSessionContext.Provider value={value}>{children}</PortalSessionContext.Provider>;
}

/**
 * The gate in front of every signed-in portal screen.
 *
 * The path being left is handed to the login screen as `next`, and travels from
 * there into the magic-link mail, so a customer who followed a deep link to one
 * ticket lands back on THAT ticket rather than on a list they then have to
 * search. The server validates the value again before putting it in the mail —
 * an open redirect on the endpoint that hands out sessions is exactly how a
 * legitimate desk domain becomes phishing bait.
 */
export function PortalGuard() {
  const { status } = usePortalSession();
  const location = useLocation();
  const { t } = useTranslation();

  if (status === 'loading') {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <LoadingSpinner size="lg" label={t('common.loading', 'Loading…')} />
      </div>
    );
  }

  if (status === 'anonymous') {
    const next = `${location.pathname}${location.search}`;
    const query = next && next !== '/portal' ? `?next=${encodeURIComponent(next)}` : '';
    return <Navigate to={`/portal/login${query}`} replace />;
  }

  return <Outlet />;
}
