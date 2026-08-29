import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlarmClock, Inbox, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SOCKET_EVENTS } from '@oblidesk/shared';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useSocketStore } from '@/store/socketStore';
import { getSocket } from '@/socket';
import { cn } from '@/utils/cn';
import { Logo } from '@/components/common/Logo';
import { UserAvatar } from '@/components/common/UserAvatar';
import { NotificationCenter } from './NotificationCenter';
import { TenantSwitcher, currentTenantSlug } from './TenantSwitcher';

// ── App switcher ─────────────────────────────────────────────────────────────
//
// Design system §1 + §4.1. SEVEN pills in a FIXED order, identical in all seven
// repos, so muscle memory carries between apps. Do not sort, do not reorder to
// put the current app first — the position of a pill is what people aim at.

type AppType =
  | 'obliview'
  | 'obliguard'
  | 'oblimap'
  | 'obliance'
  | 'obliplan'
  | 'oblidesk'
  | 'oblihub';

interface AppEntry {
  type: AppType;
  label: string;
  /** Brand dot colour — matches the sibling app's own accent. */
  color: string;
}

const APP_ORDER: AppEntry[] = [
  { type: 'obliview', label: 'Obliview', color: '#2bc4bd' },
  { type: 'obliguard', label: 'Obliguard', color: '#f5a623' },
  { type: 'oblimap', label: 'Oblimap', color: '#1edd8a' },
  { type: 'obliance', label: 'Obliance', color: '#e03a3a' },
  { type: 'obliplan', label: 'Obliplan', color: '#7c6cff' },
  { type: 'oblidesk', label: 'Oblidesk', color: '#22b8f5' },
  { type: 'oblihub', label: 'Oblihub', color: '#2d4ec9' },
];

const CURRENT_APP: AppType = 'oblidesk';

interface ConnectedApp {
  appType: string;
  name: string;
  baseUrl: string;
}

// ── Desk chips ───────────────────────────────────────────────────────────────
//
// Saved-view slugs the chips link to. Views are config objects, so these are
// SLUGS (HARD RULE 3), never ids. Both are seeded by the baseline bundle; if an
// admin archives one the link simply lands on an empty view, which is a better
// failure than a dead numeric id.
const OPEN_VIEW_SLUG = 'open';
const AT_RISK_VIEW_SLUG = 'sla-at-risk';

interface DeskCounters {
  open: number;
  breachingSoon: number;
}

export function Header() {
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const { memberships, currentTenantId } = useTenantStore();
  const { status: socketStatus } = useSocketStore();

  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>([]);
  const [counters, setCounters] = useState<DeskCounters | null>(null);

  // ── Which sibling apps this user can actually reach ────────────────────────
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/connected-apps', { credentials: 'include' })
      .then((response) => response.json())
      .then((body: { success?: boolean; data?: ConnectedApp[] }) => {
        if (!cancelled && body?.success && Array.isArray(body.data)) setConnectedApps(body.data);
      })
      .catch(() => {
        /* Silent: the pills simply collapse to Oblidesk alone. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Desk chips ─────────────────────────────────────────────────────────────
  const loadCounters = useCallback(() => {
    fetch('/api/tickets/summary', { credentials: 'include' })
      .then((response) => response.json())
      .then((body: { success?: boolean; data?: Partial<DeskCounters> }) => {
        if (body?.success && body.data) {
          setCounters({
            open: body.data.open ?? 0,
            breachingSoon: body.data.breachingSoon ?? 0,
          });
        }
      })
      .catch(() => {
        /* Silent: chips just don't render. */
      });
  }, []);

  useEffect(() => {
    loadCounters();
    // A slow poll is the floor; the socket below is what actually keeps these
    // live. Without the poll a tab left open through a reconnect would sit on
    // stale numbers until the next queue change.
    const interval = setInterval(loadCounters, 120_000);
    return () => clearInterval(interval);
  }, [loadCounters, currentTenantId]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const refresh = () => loadCounters();
    socket.on(SOCKET_EVENTS.queueCounters, refresh);
    socket.on(SOCKET_EVENTS.slaBreached, refresh);
    socket.on(SOCKET_EVENTS.slaWarning, refresh);
    return () => {
      socket.off(SOCKET_EVENTS.queueCounters, refresh);
      socket.off(SOCKET_EVENTS.slaBreached, refresh);
      socket.off(SOCKET_EVENTS.slaWarning, refresh);
    };
  }, [loadCounters, socketStatus]);

  const reachable = new Set<string>([CURRENT_APP]);
  for (const app of connectedApps) reachable.add(app.appType);

  const goToApp = (app: AppEntry) => {
    if (app.type === CURRENT_APP) return;
    const target = connectedApps.find((entry) => entry.appType === app.type);
    if (!target) return;

    // Cross-app tenant handoff. The SLUG travels, never the numeric id
    // (HARD RULE 13): each app owns its own `tenants` sequence, so id 4 here
    // and id 4 there are unrelated rows. The target app re-resolves the slug
    // after Obligate SSO and falls back to the user's first tenant if it has
    // no tenant by that slug.
    const slug = currentTenantSlug(memberships, currentTenantId);
    const url = new URL(`${target.baseUrl.replace(/\/$/, '')}/auth/sso-redirect`);
    if (slug) url.searchParams.set('tenant', slug);
    window.location.href = url.toString();
  };

  const username = user?.username ?? '';
  const displayName = user?.displayName?.trim() || username;

  const socketTitle =
    socketStatus === 'connected'
      ? t('header.socketConnected', 'Temps reel connecte')
      : socketStatus === 'reconnecting'
        ? t('header.socketReconnecting', 'Reconnexion en cours…')
        : t('header.socketDisconnected', 'Temps reel deconnecte — cliquez pour recharger');

  return (
    <header
      className="flex shrink-0 items-center gap-3 bg-bg-secondary px-4"
      style={{ height: 52 }}
    >
      {/* Logo — lives in the topbar, not the sidebar, so it stays put whatever
          the sidebar is doing (pinned / 64px / floating). Design system §12. */}
      <Link to="/" className="flex shrink-0 items-center" title="Oblidesk">
        <Logo size={26} />
      </Link>

      <TenantSwitcher />

      {/* App switcher — only the current app plus apps the user can actually
          reach. Unreachable apps are hidden outright rather than greyed out:
          a disabled pill invites a click that can never work. */}
      <nav className="ml-1 flex shrink-0 items-center gap-1 rounded-card bg-bg-hover p-1">
        {APP_ORDER.filter((app) => app.type === CURRENT_APP || reachable.has(app.type)).map(
          (app) => {
            const isCurrent = app.type === CURRENT_APP;
            return (
              <button
                key={app.type}
                type="button"
                onClick={() => goToApp(app)}
                title={app.label}
                aria-current={isCurrent ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-pill px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                  isCurrent
                    ? 'bg-accent/12 font-semibold text-accent'
                    : 'text-text-secondary hover:bg-bg-active hover:text-text-primary',
                )}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{
                    background: app.color,
                    // The current app's dot glows — §4.1.
                    boxShadow: isCurrent ? `0 0 8px ${app.color}` : undefined,
                  }}
                />
                <span className="hidden lg:inline">{app.label}</span>
              </button>
            );
          },
        )}
      </nav>

      <div className="ml-auto flex items-center gap-2.5">
        {/* Desk chips — the two numbers an agent glances at all day. Each one
            opens the saved view it counts, so the chip is also the shortcut. */}
        {counters && (
          <div className="hidden items-center gap-1.5 sm:flex">
            <Link
              to={`/tickets?view=${OPEN_VIEW_SLUG}`}
              title={t('header.openTicketsHint', 'Ouvrir la vue des tickets ouverts')}
              className="flex items-center gap-1.5 rounded-pill bg-status-open-bg px-2 py-1 font-mono text-[11px] font-semibold text-status-open transition-opacity hover:opacity-80"
            >
              <Inbox size={11} />
              {counters.open}
              <span className="hidden font-sans font-medium xl:inline">
                {t('header.openTickets', 'ouverts')}
              </span>
            </Link>

            {counters.breachingSoon > 0 && (
              <Link
                to={`/tickets?view=${AT_RISK_VIEW_SLUG}`}
                title={t('header.breachingSoonHint', 'Tickets dont le SLA expire bientot')}
                className="flex items-center gap-1.5 rounded-pill bg-sla-warn-bg px-2 py-1 font-mono text-[11px] font-semibold text-sla-warn transition-opacity hover:opacity-80"
              >
                <AlarmClock size={11} />
                {counters.breachingSoon}
                <span className="hidden font-sans font-medium xl:inline">
                  {t('header.breachingSoon', 'bientot en depassement')}
                </span>
              </Link>
            )}
          </div>
        )}

        {/* Socket status. Disconnected is clickable because the only real fix
            an agent has is a reload, and a silent dead socket means the board
            quietly stops updating. */}
        <button
          type="button"
          onClick={socketStatus !== 'connected' ? () => window.location.reload() : undefined}
          title={socketTitle}
          aria-label={socketTitle}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-pill transition-opacity',
            socketStatus === 'connected' ? 'cursor-default' : 'cursor-pointer hover:opacity-70',
          )}
        >
          <span
            className={cn(
              'h-2 w-2 rounded-full transition-colors',
              socketStatus === 'connected' && 'bg-status-resolved',
              socketStatus === 'reconnecting' && 'animate-pulse bg-sla-warn',
              socketStatus !== 'connected' &&
                socketStatus !== 'reconnecting' &&
                'animate-pulse bg-sla-breach',
            )}
          />
        </button>

        <NotificationCenter />

        {user && (
          <>
            <Link
              to="/profile"
              className="flex items-center gap-2 rounded-card bg-bg-hover py-1 pl-1.5 pr-3 transition-colors hover:bg-bg-active"
              title={displayName}
            >
              <UserAvatar avatar={user.avatar} username={username} size={26} />
              <span className="hidden max-w-[140px] truncate text-[13px] font-medium text-text-primary md:inline">
                {displayName}
              </span>
              <span className="hidden border-l border-border-light pl-2 font-mono text-[10px] uppercase tracking-[0.1em] text-accent md:inline">
                {user.role}
              </span>
            </Link>

            <button
              type="button"
              onClick={() => void logout()}
              title={t('nav.signOut', 'Se deconnecter')}
              aria-label={t('nav.signOut', 'Se deconnecter')}
              className="flex h-7 w-7 items-center justify-center rounded-pill text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <LogOut size={15} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
