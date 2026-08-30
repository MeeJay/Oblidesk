import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  AlarmClock,
  BookOpen,
  Bookmark,
  Building2,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clock4,
  Contact,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  LogOut,
  Mail,
  Pin,
  PinOff,
  Plus,
  Replace,
  Search,
  Server,
  Settings,
  ShoppingBag,
  SlidersHorizontal,
  Siren,
  Table2,
  Ticket,
  Users,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CAPABILITIES, SOCKET_EVENTS, STORAGE_KEYS, type Capability } from '@oblidesk/shared';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { getSocket } from '@/socket';
import { UserAvatar } from '@/components/common/UserAvatar';
import { openCommandPalette } from './CommandPalette';
import { cn } from '@/utils/cn';

// ═════════════════════════════════════════════════════════════════════════════
// Sidebar geometry — a tiny module store rather than a slice of the global UI
// store, because AppLayout and Sidebar are the only two readers and the state
// is pure chrome. `useSyncExternalStore` keeps both in step without a provider.
//
// Persistence keys come from STORAGE_KEYS in @oblidesk/shared. `sidebarCollapsed`
// is deliberately prefixed `oblidesk:` there rather than shared suite-wide: this
// sidebar carries queue and saved-view sections the other apps do not have, so
// a width that suits Obliance is not automatically right here.
// ═════════════════════════════════════════════════════════════════════════════

export const SIDEBAR_COLLAPSED_WIDTH = 64;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 260;

export interface SidebarState {
  collapsed: boolean;
  floating: boolean;
  width: number;
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === 'true';
  } catch {
    return fallback;
  }
}

function readWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.sidebarWidth);
    const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parsed));
    }
  } catch {
    /* localStorage unavailable (private mode, blocked cookies) */
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

let state: SidebarState = {
  collapsed: readBool(STORAGE_KEYS.sidebarCollapsed, false),
  floating: readBool(STORAGE_KEYS.sidebarFloating, false),
  width: readWidth(),
};

const listeners = new Set<() => void>();

function emit(next: Partial<SidebarState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function useSidebarState(): SidebarState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

/** Collapsed and floating are mutually exclusive — one always turns the other off. */
export function setSidebarCollapsed(collapsed: boolean) {
  persist(STORAGE_KEYS.sidebarCollapsed, String(collapsed));
  if (collapsed) persist(STORAGE_KEYS.sidebarFloating, 'false');
  emit({ collapsed, floating: collapsed ? false : state.floating });
}

export function setSidebarFloating(floating: boolean) {
  persist(STORAGE_KEYS.sidebarFloating, String(floating));
  if (floating) persist(STORAGE_KEYS.sidebarCollapsed, 'false');
  emit({ floating, collapsed: floating ? false : state.collapsed });
}

export function setSidebarWidth(width: number) {
  const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
  persist(STORAGE_KEYS.sidebarWidth, String(clamped));
  emit({ width: clamped });
}

// ═════════════════════════════════════════════════════════════════════════════
// Nav model
// ═════════════════════════════════════════════════════════════════════════════

interface NavItem {
  labelKey: string;
  /** Inline French fallback — HARD RULE 10. */
  label: string;
  path: string;
  icon: ReactNode;
  /** Non-admins need this capability. Admins always pass. */
  capability?: Capability;
  adminOnly?: boolean;
}

// ── Live counters pushed over the socket ─────────────────────────────────────

interface CounterRow {
  slug: string;
  open?: number;
  unassigned?: number;
  breachingSoon?: number;
  count?: number;
}

/** `queue:counters` / `view:counters` are tolerated in either shape. */
function readCounterRows(payload: unknown): CounterRow[] {
  if (!payload || typeof payload !== 'object') return [];
  const body = payload as Record<string, unknown>;
  const raw = Array.isArray(body.counts)
    ? body.counts
    : Array.isArray(body.queues)
      ? body.queues
      : Array.isArray(body.views)
        ? body.views
        : Array.isArray(payload)
          ? payload
          : [];
  const rows: CounterRow[] = [];
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const slug = typeof row.slug === 'string' ? row.slug : null;
    if (!slug) continue;
    rows.push({
      slug,
      open: typeof row.open === 'number' ? row.open : undefined,
      unassigned: typeof row.unassigned === 'number' ? row.unassigned : undefined,
      breachingSoon: typeof row.breachingSoon === 'number' ? row.breachingSoon : undefined,
      count: typeof row.count === 'number' ? row.count : undefined,
    });
  }
  return rows;
}

interface ConfigRef {
  slug: string;
  name: string;
  /** Saved views may declare a lucide icon name; queues do not. */
  icon?: string | null;
}

function readConfigRefs(payload: unknown): ConfigRef[] {
  const body = payload as { success?: boolean; data?: unknown } | null;
  const raw = Array.isArray(body?.data) ? body?.data : [];
  const rows: ConfigRef[] = [];
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.slug !== 'string') continue;
    rows.push({
      slug: row.slug,
      name: typeof row.name === 'string' ? row.name : row.slug,
      icon: typeof row.icon === 'string' ? row.icon : null,
    });
  }
  return rows;
}

// ═════════════════════════════════════════════════════════════════════════════
// Small presentational pieces
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Remember which sidebar sections are folded.
 *
 * The sidebar body is one scroll area holding the main nav, the queues, the
 * saved views and the admin links. On a laptop that is more rows than fit, and
 * widening the sidebar does nothing for a VERTICAL overflow — which is exactly
 * the complaint that produced this: "even at max width I can't see them all
 * without scrolling". Folding the section you are not using right now (usually
 * ADMINISTRATION) is what actually buys the space back.
 */
const SECTION_STORAGE_KEY = 'oblidesk:sidebarSections';

function readFoldedSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

function useFoldedSection(id: string): [boolean, () => void] {
  const [folded, setFolded] = useState(() => readFoldedSections()[id] === true);

  const toggle = useCallback(() => {
    setFolded((previous) => {
      const next = !previous;
      persist(SECTION_STORAGE_KEY, JSON.stringify({ ...readFoldedSections(), [id]: next }));
      return next;
    });
  }, [id]);

  return [folded, toggle];
}

/**
 * A foldable section label.
 *
 * The whole header is the hit target, not just the chevron: a 10px chevron is a
 * miss, and the label is the thing the eye is already on.
 */
function SectionHeader({
  children,
  action,
  folded,
  onToggle,
}: {
  children: ReactNode;
  action?: ReactNode;
  folded?: boolean;
  onToggle?: () => void;
}) {
  const label = (
    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
      {children}
    </span>
  );

  if (!onToggle) {
    return (
      <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-4">
        {label}
        {action}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 pb-1 pt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!folded}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-pill px-3 py-0.5 text-left transition-colors hover:bg-bg-hover"
      >
        <ChevronRight
          size={11}
          className={cn(
            'shrink-0 text-text-muted transition-transform duration-150',
            !folded && 'rotate-90',
          )}
        />
        {label}
      </button>
      {action && <span className="pr-3">{action}</span>}
    </div>
  );
}

function CountPill({ value, tone }: { value: number; tone: 'default' | 'warn' }) {
  if (!value) return null;
  return (
    <span
      className={cn(
        'shrink-0 rounded-pill px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none',
        tone === 'warn' ? 'bg-sla-warn-bg text-sla-warn' : 'bg-bg-tertiary text-text-muted',
      )}
    >
      {value > 999 ? '999+' : value}
    </span>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Sidebar
// ═════════════════════════════════════════════════════════════════════════════

export function Sidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const { user, isAdmin, hasCapability } = useAuthStore();
  const { currentTenantId } = useTenantStore();
  const { collapsed, floating } = useSidebarState();

  const [search, setSearch] = useState('');
  // Folded state for the three foldable sections, persisted under one key.
  const [queuesFolded, toggleQueues] = useFoldedSection('queues');
  const [viewsFolded, toggleViews] = useFoldedSection('views');
  const [adminFolded, toggleAdmin] = useFoldedSection('admin');
  const [queues, setQueues] = useState<ConfigRef[]>([]);
  const [views, setViews] = useState<ConfigRef[]>([]);
  const [queueCounts, setQueueCounts] = useState<Record<string, CounterRow>>({});
  const [viewCounts, setViewCounts] = useState<Record<string, CounterRow>>({});

  const admin = isAdmin();

  // ── Nav definitions ────────────────────────────────────────────────────────
  const mainNav: NavItem[] = useMemo(
    () => [
      {
        labelKey: 'nav.shiftBoard',
        label: 'Shift Board',
        // The Shift Board is the landing screen at '/'. '/board' is the kanban
        // VIEW MODE of the ticket workspace — a different page.
        path: '/',
        icon: <LayoutGrid size={17} />,
        capability: CAPABILITIES.TICKET_READ,
      },
      {
        labelKey: 'nav.tickets',
        label: 'Tickets',
        path: '/tickets',
        icon: <Ticket size={17} />,
        capability: CAPABILITIES.TICKET_READ,
      },
      {
        labelKey: 'nav.gridView',
        label: 'Vue tableau',
        path: '/grid',
        icon: <Table2 size={17} />,
        capability: CAPABILITIES.TICKET_READ,
      },
      {
        labelKey: 'nav.assets',
        label: 'Actifs',
        path: '/ci',
        icon: <Server size={17} />,
        capability: CAPABILITIES.CI_READ,
      },
      {
        labelKey: 'nav.problems',
        label: 'Problemes',
        path: '/problems',
        icon: <Siren size={17} />,
        capability: CAPABILITIES.TICKET_READ,
      },
      {
        labelKey: 'nav.changes',
        label: 'Changements',
        path: '/changes',
        icon: <Replace size={17} />,
        capability: CAPABILITIES.TICKET_READ,
      },
      {
        labelKey: 'nav.knowledge',
        label: 'Connaissance',
        path: '/kb',
        icon: <BookOpen size={17} />,
        capability: CAPABILITIES.KB_READ,
      },
      {
        labelKey: 'nav.catalog',
        label: 'Catalogue',
        path: '/catalog',
        icon: <ShoppingBag size={17} />,
        capability: CAPABILITIES.TICKET_READ,
      },
    ],
    [],
  );

  const adminNav: NavItem[] = useMemo(
    () => [
      {
        labelKey: 'nav.automation',
        label: 'Automatisation',
        path: '/admin/automation',
        icon: <Workflow size={17} />,
        capability: CAPABILITIES.AUTOMATION_ADMIN,
      },
      {
        labelKey: 'nav.slaAndTeams',
        label: 'SLA et equipes',
        path: '/admin/sla',
        icon: <AlarmClock size={17} />,
        capability: CAPABILITIES.SLA_ADMIN,
      },
      {
        labelKey: 'nav.timeAndContracts',
        label: 'Temps et contrats',
        path: '/admin/contracts',
        icon: <Clock4 size={17} />,
        capability: CAPABILITIES.CONTRACT_ADMIN,
      },
      {
        labelKey: 'nav.dashboards',
        label: 'Tableaux de bord',
        path: '/dashboards',
        icon: <LayoutDashboard size={17} />,
        capability: CAPABILITIES.REPORT_VIEW,
      },
      {
        labelKey: 'nav.channels',
        label: 'Canaux',
        path: '/admin/channels',
        icon: <Mail size={17} />,
        capability: CAPABILITIES.ALERT_ADMIN,
      },
      {
        labelKey: 'nav.configuration',
        label: 'Configuration',
        path: '/admin/config',
        icon: <SlidersHorizontal size={17} />,
        capability: CAPABILITIES.CONFIG_ADMIN,
      },
      {
        // The portal had a complete API and no door. It sits next to Users
        // because it answers the same question about the other half of the
        // people in the system: Users is who may work the desk, this is who may
        // read it from outside and how much of their own company they see.
        //
        // Guarded by the capability rather than `adminOnly`, because
        // `portal_admin` is exactly what /api/organizations and
        // /api/portal-admin demand on every route. A nav entry that leads to a
        // 403 is worse than no entry at all.
        labelKey: 'nav.portal',
        label: 'Portail client',
        path: '/admin/portal',
        icon: <Contact size={17} />,
        capability: CAPABILITIES.PORTAL_ADMIN,
      },
      {
        labelKey: 'nav.users',
        label: 'Utilisateurs',
        path: '/admin/users',
        icon: <Users size={17} />,
        adminOnly: true,
      },
      {
        // The page, its API and its 25-capability catalogue have all shipped;
        // only the way in was missing, so the whole RBAC surface read as
        // unbuilt. It sits next to Users because that is the question it
        // answers: what may this person do.
        labelKey: 'nav.permissionSets',
        label: 'Jeux de permissions',
        path: '/admin/permission-sets',
        icon: <ShieldCheck size={17} />,
        adminOnly: true,
      },
      {
        labelKey: 'nav.tenants',
        label: 'Tenants',
        path: '/admin/tenants',
        icon: <Building2 size={17} />,
        adminOnly: true,
      },
      {
        labelKey: 'nav.settings',
        label: 'Parametres',
        path: '/settings',
        icon: <Settings size={17} />,
        adminOnly: true,
      },
    ],
    [],
  );

  const visible = useCallback(
    (item: NavItem) => {
      if (item.adminOnly && !admin) return false;
      if (item.capability && !hasCapability(item.capability)) return false;
      return true;
    },
    [admin, hasCapability],
  );

  const label = useCallback((item: NavItem) => t(item.labelKey, item.label), [t]);

  const query = search.trim().toLowerCase();
  const matches = useCallback(
    (text: string) => !query || text.toLowerCase().includes(query),
    [query],
  );

  const mainItems = mainNav.filter((item) => visible(item) && matches(label(item)));
  const adminItems = adminNav.filter((item) => visible(item) && matches(label(item)));

  // ── Queues + saved views ───────────────────────────────────────────────────
  useEffect(() => {
    if (!hasCapability(CAPABILITIES.TICKET_READ)) return;
    let cancelled = false;

    const load = async (url: string, apply: (rows: ConfigRef[]) => void) => {
      try {
        const response = await fetch(url, { credentials: 'include' });
        const body: unknown = await response.json();
        if (!cancelled) apply(readConfigRefs(body));
      } catch {
        /* Silent: the section simply does not render. */
      }
    };

    // Queues are config objects, so they are read from the config store like
    // every other kind. There is no separate /api/queues collection, and
    // inventing one would be a second place for the same rows to drift.
    void load('/api/config/queue?status=published', setQueues);
    void load('/api/views', setViews);

    return () => {
      cancelled = true;
    };
    // Re-fetch on a tenant switch: queues and views are config objects and are
    // entirely different per tenant.
  }, [currentTenantId, hasCapability]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onQueue = (payload: unknown) => {
      const rows = readCounterRows(payload);
      if (rows.length === 0) return;
      setQueueCounts((prev) => {
        const next = { ...prev };
        for (const row of rows) next[row.slug] = row;
        return next;
      });
    };
    const onView = (payload: unknown) => {
      const rows = readCounterRows(payload);
      if (rows.length === 0) return;
      setViewCounts((prev) => {
        const next = { ...prev };
        for (const row of rows) next[row.slug] = row;
        return next;
      });
    };

    socket.on(SOCKET_EVENTS.queueCounters, onQueue);
    socket.on(SOCKET_EVENTS.viewCounters, onView);
    return () => {
      socket.off(SOCKET_EVENTS.queueCounters, onQueue);
      socket.off(SOCKET_EVENTS.viewCounters, onView);
    };
  }, [currentTenantId]);

  // ── Active-route test ──────────────────────────────────────────────────────
  const isActive = useCallback(
    (path: string) =>
      location.pathname === path || (path !== '/' && location.pathname.startsWith(`${path}/`)),
    [location.pathname],
  );

  const canCreate = hasCapability(CAPABILITIES.TICKET_RW);
  const displayName = user?.displayName?.trim() || user?.username || '';

  // ═══════════════════════════════════════════════════════════════════════════
  // Collapsed — 64 px icon rail. Design system §4.2: collapsed NEVER hides the
  // sidebar, it shrinks it. A hidden sidebar loses the queue rail, which is the
  // agent's primary way back to work.
  // ═══════════════════════════════════════════════════════════════════════════
  if (collapsed) {
    return (
      <aside
        className="flex h-full flex-col bg-bg-secondary"
        style={{ width: SIDEBAR_COLLAPSED_WIDTH }}
      >
        <div className="flex h-9 shrink-0 items-center justify-center pt-2">
          <button
            type="button"
            onClick={() => setSidebarCollapsed(false)}
            title={t('nav.expandSidebar', 'Deplier le menu')}
            aria-label={t('nav.expandSidebar', 'Deplier le menu')}
            className="rounded-pill p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <ChevronsRight size={16} />
          </button>
        </div>

        {canCreate && (
          <div className="px-2 pt-2">
            <Link
              to="/tickets/new"
              title={t('nav.newTicket', 'Nouveau ticket')}
              className="flex h-10 w-full items-center justify-center rounded-pill bg-accent/12 text-accent transition-colors hover:bg-accent/20"
            >
              <Plus size={17} />
            </Link>
          </div>
        )}

        <div className="px-2 pt-1">
          <button
            type="button"
            onClick={openCommandPalette}
            title={t('nav.commandPalette', 'Palette de commandes (Ctrl+K)')}
            aria-label={t('nav.commandPalette', 'Palette de commandes (Ctrl+K)')}
            className="flex h-10 w-full items-center justify-center rounded-pill text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <Search size={17} />
          </button>
        </div>

        <nav className="scrollbar-none flex-1 space-y-1 overflow-y-auto px-2 pt-2">
          {[...mainItems, ...adminItems].map((item) => (
            <Link
              key={item.path}
              to={item.path}
              title={label(item)}
              className={cn(
                'flex h-10 w-full items-center justify-center rounded-pill transition-colors',
                isActive(item.path)
                  ? 'bg-accent/12 text-accent'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              {item.icon}
            </Link>
          ))}
        </nav>

        <div className="space-y-1 p-2">
          <Link
            to="/profile"
            title={displayName}
            className="flex h-10 w-full items-center justify-center rounded-pill transition-colors hover:bg-bg-hover"
          >
            <UserAvatar avatar={user?.avatar} username={user?.username} size={24} />
          </Link>
          <button
            type="button"
            onClick={() => void useAuthStore.getState().logout()}
            title={t('nav.signOut', 'Se deconnecter')}
            aria-label={t('nav.signOut', 'Se deconnecter')}
            className="flex h-10 w-full items-center justify-center rounded-pill text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Expanded
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <aside className="flex h-full w-full flex-col bg-bg-secondary">
      {/* Toggle row. No logo here — it lives in the topbar so it survives every
          sidebar state (design system §12). */}
      <div className="flex h-9 shrink-0 items-center justify-end gap-1 px-3 pt-2">
        {!floating && (
          <button
            type="button"
            onClick={() => setSidebarCollapsed(true)}
            title={t('nav.collapseSidebar', 'Replier le menu')}
            aria-label={t('nav.collapseSidebar', 'Replier le menu')}
            className="rounded-pill p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <ChevronsLeft size={15} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setSidebarFloating(!floating)}
          title={
            floating
              ? t('nav.pinSidebar', 'Epingler le menu')
              : t('nav.floatSidebar', 'Menu flottant (masquage auto)')
          }
          aria-label={
            floating
              ? t('nav.pinSidebar', 'Epingler le menu')
              : t('nav.floatSidebar', 'Menu flottant (masquage auto)')
          }
          className={cn(
            'rounded-pill p-1.5 transition-colors',
            floating
              ? 'text-accent hover:bg-accent/10'
              : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          {floating ? <PinOff size={15} /> : <Pin size={15} />}
        </button>
      </div>

      {/* Primary action */}
      {canCreate && (
        <div className="px-3 pt-2">
          <Link
            to="/tickets/new"
            className="flex w-full items-center justify-center gap-2 rounded-pill bg-accent/12 px-3 py-2 text-[13px] font-medium text-accent transition-colors hover:bg-accent/20"
          >
            <Plus size={15} />
            {t('nav.newTicket', 'Nouveau ticket')}
          </Link>
        </div>
      )}

      {/* Filter. This narrows the nav below it; Ctrl+K opens the palette, which
          is the thing that actually searches tickets and runs actions. */}
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-pill bg-bg-tertiary px-3 focus-within:ring-1 focus-within:ring-accent">
          <Search size={13} className="shrink-0 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('nav.filterMenu', 'Filtrer le menu')}
            aria-label={t('nav.filterMenu', 'Filtrer le menu')}
            className="min-w-0 flex-1 bg-transparent py-2 text-[13px] text-text-primary outline-none placeholder:text-text-muted"
          />
          <button
            type="button"
            onClick={openCommandPalette}
            title={t('nav.commandPalette', 'Palette de commandes (Ctrl+K)')}
            className="shrink-0 rounded px-1 font-mono text-[10px] text-text-muted transition-colors hover:text-text-primary"
          >
            ⌘K
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <nav className="space-y-0.5">
          {mainItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                'flex items-center gap-3 rounded-pill px-3 py-2 text-[13.5px] transition-colors',
                isActive(item.path)
                  ? 'bg-accent/12 font-medium text-accent'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              <span className="shrink-0">{item.icon}</span>
              <span className="truncate">{label(item)}</span>
            </Link>
          ))}
        </nav>

        {/* ── FILES (queues) ────────────────────────────────────────────────
            Counts arrive over `queue:counters` and are keyed by SLUG, because
            a queue is a config object and config cross-references are slugs
            (HARD RULE 3). */}
        {queues.length > 0 && (
          <>
            <SectionHeader folded={queuesFolded} onToggle={toggleQueues}>
              {t('nav.sectionQueues', 'Files')}
            </SectionHeader>
            {!queuesFolded && (
            <nav className="space-y-0.5">
              {queues
                .filter((queue) => matches(queue.name))
                .map((queue) => {
                  const counts = queueCounts[queue.slug];
                  const open = counts?.open ?? counts?.count ?? 0;
                  const breaching = counts?.breachingSoon ?? 0;
                  const path = `/queues/${queue.slug}`;
                  return (
                    <Link
                      key={queue.slug}
                      to={path}
                      title={queue.name}
                      className={cn(
                        'flex items-center gap-2.5 rounded-pill px-3 py-1.5 text-[13px] transition-colors',
                        isActive(path)
                          ? 'bg-accent/12 font-medium text-accent'
                          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                      )}
                    >
                      <Inbox size={14} className="shrink-0 opacity-70" />
                      <span className="min-w-0 flex-1 truncate">{queue.name}</span>
                      {/* At-risk count wins the pill: an agent needs to see the
                          queue that is about to breach before the busy one. */}
                      {breaching > 0 ? (
                        <CountPill value={breaching} tone="warn" />
                      ) : (
                        <CountPill value={open} tone="default" />
                      )}
                    </Link>
                  );
                })}
            </nav>
            )}
          </>
        )}

        {/* ── VUES (saved views) ────────────────────────────────────────────── */}
        {views.length > 0 && (
          <>
            <SectionHeader folded={viewsFolded} onToggle={toggleViews}>
              {t('nav.sectionViews', 'Vues')}
            </SectionHeader>
            {!viewsFolded && (
            <nav className="space-y-0.5">
              {views
                .filter((view) => matches(view.name))
                .map((view) => {
                  const counts = viewCounts[view.slug];
                  const total = counts?.count ?? counts?.open ?? 0;
                  const path = `/tickets?view=${encodeURIComponent(view.slug)}`;
                  const active = location.search.includes(`view=${view.slug}`);
                  return (
                    <Link
                      key={view.slug}
                      to={path}
                      title={view.name}
                      className={cn(
                        'flex items-center gap-2.5 rounded-pill px-3 py-1.5 text-[13px] transition-colors',
                        active
                          ? 'bg-accent/12 font-medium text-accent'
                          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                      )}
                    >
                      <Bookmark size={14} className="shrink-0 opacity-70" />
                      <span className="min-w-0 flex-1 truncate">{view.name}</span>
                      <CountPill value={total} tone="default" />
                    </Link>
                  );
                })}
            </nav>
            )}
          </>
        )}

        {/* ── ADMINISTRATION ───────────────────────────────────────────────── */}
        {adminItems.length > 0 && (
          <>
            <div className="mx-3 mt-4 h-px bg-border" />
            <SectionHeader folded={adminFolded} onToggle={toggleAdmin}>
              {t('nav.sectionAdmin', 'Administration')}
            </SectionHeader>

            {!adminFolded && (
              <nav className="space-y-0.5">
                {adminItems.map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={cn(
                      'flex items-center gap-3 rounded-pill px-3 py-2 text-[13.5px] transition-colors',
                      isActive(item.path)
                        ? 'bg-accent/12 font-medium text-accent'
                        : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                    )}
                  >
                    <span className="shrink-0">{item.icon}</span>
                    <span className="truncate">{label(item)}</span>
                  </Link>
                ))}
              </nav>
            )}
          </>
        )}
      </div>

      {/* Pinned footer */}
      <div className="shrink-0 p-2">
        <div className="mx-1 mb-2 h-px bg-border" />
        <Link
          to="/profile"
          className={cn(
            'flex items-center gap-2.5 rounded-pill px-2 py-1.5 transition-colors',
            isActive('/profile') ? 'bg-accent/10' : 'hover:bg-bg-hover',
          )}
        >
          <UserAvatar avatar={user?.avatar} username={user?.username} size={22} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-text-primary">{displayName}</div>
            <div className="truncate font-mono text-[10px] text-text-muted">
              {user?.username ?? ''} · {user?.role ?? ''}
            </div>
          </div>
        </Link>
        <button
          type="button"
          onClick={() => void useAuthStore.getState().logout()}
          className="flex w-full items-center gap-3 rounded-pill px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <LogOut size={16} />
          {t('nav.signOut', 'Se deconnecter')}
        </button>
      </div>
    </aside>
  );
}
