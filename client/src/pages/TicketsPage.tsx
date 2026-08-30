/**
 * TicketsPage — the three-pane desk.
 *
 *   ┌──────────────┬────────────────────────────────┬──────────────┐
 *   │ ViewBar      │                                │              │
 *   │ TicketQueue  │  the ticket, keyed on its id   │ ContextRail  │
 *   │ (virtualised)│                                │ (collapsible)│
 *   └──────────────┴────────────────────────────────┴──────────────┘
 *
 * ── The queue never unmounts ────────────────────────────────────────────────
 * Moving between tickets changes a piece of local state, not the route. The
 * queue keeps its rows, its keyset cursor, its scroll offset and its selection,
 * so opening the fortieth ticket in a triage session costs one `GET /tickets/:id`
 * and nothing else. Routing `/tickets/:id` to a page that renders the queue as a
 * sibling would tear the list down and refetch it on every navigation — which is
 * the single most expensive mistake this layout exists to avoid.
 *
 * The URL still moves (`/tickets/:id`), because a ticket has to be shareable and
 * the back button has to work. It moves through `navigate`, and the route entry
 * for `/tickets/:id` renders THIS page: same component, same mounted queue, only
 * the `:id` param differs. The centre pane is keyed on the id so React remounts
 * the conversation — a new ticket must not inherit the previous one's composer
 * draft state — while everything around it stays put.
 *
 * ── Widths are the agent's, and they persist ────────────────────────────────
 * Both splitters write to localStorage. An agent who wants a 520px queue and no
 * rail should find that layout tomorrow morning; re-deciding it every session is
 * a small tax paid several hundred times.
 *
 * HARD RULE 11 — the panes are separated by background steps and a 4px drag
 * strip, never a border.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { Inbox, PanelRightClose, PanelRightOpen, Plus, ShieldAlert } from 'lucide-react';
import { STATUS_CATEGORY_META, STATUS_CATEGORY_ORDER } from '@oblidesk/shared';
import type { StatusCategory, TicketWithRelations } from '@oblidesk/shared';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import PriorityBadge from '@/components/tickets/PriorityBadge';
import SlaChip, { nearestInstance } from '@/components/tickets/SlaChip';
import StatusPill from '@/components/tickets/StatusPill';
import BulkActionBar from '@/components/tickets/BulkActionBar';
import ContextRail from '@/components/tickets/ContextRail';
import TicketQueue from '@/components/tickets/TicketQueue';
import ViewBar, { QUEUE_GROUP_FIELDS, type QueueGroupField } from '@/components/tickets/ViewBar';
import { NewTicketModal } from '@/components/tickets/NewTicketModal';
import { TicketConversation } from '@/pages/TicketDetailPage';
import { useKeyboard } from '@/hooks/useKeyboard';
import { selectByCategory, useTicketStore } from '@/store/ticketStore';
import { useUiStore } from '@/store/uiStore';
import { useViewStore } from '@/store/viewStore';

// ═════════════════════════════════════════════════════════════════════════════
// Persisted layout
// ═════════════════════════════════════════════════════════════════════════════

const QUEUE_WIDTH_KEY = 'oblidesk:queueWidth';
const RAIL_WIDTH_KEY = 'oblidesk:railWidth';
const GROUP_BY_KEY = 'oblidesk:queueGroupBy';

const QUEUE_BOUNDS = { min: 300, max: 720, fallback: 420 } as const;
const RAIL_BOUNDS = { min: 260, max: 520, fallback: 320 } as const;

function readWidth(key: string, bounds: { min: number; max: number; fallback: number }): number {
  try {
    const raw = Number(localStorage.getItem(key));
    if (!Number.isFinite(raw) || raw <= 0) return bounds.fallback;
    return Math.min(bounds.max, Math.max(bounds.min, raw));
  } catch {
    return bounds.fallback;
  }
}

function writeWidth(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // Storage blocked — the layout simply will not survive a reload.
  }
}

/** One arrow-key step on a splitter: clamp, apply, persist — same as a drag. */
function nudge(
  current: number,
  delta: number,
  bounds: { min: number; max: number },
  key: string,
  apply: (width: number) => void,
): void {
  const next = Math.min(bounds.max, Math.max(bounds.min, current + delta));
  apply(next);
  writeWidth(key, next);
}

function readGroupBy(): QueueGroupField | null {
  try {
    const raw = localStorage.getItem(GROUP_BY_KEY);
    return QUEUE_GROUP_FIELDS.includes(raw as QueueGroupField) ? (raw as QueueGroupField) : null;
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Page
// ═════════════════════════════════════════════════════════════════════════════

export function TicketsPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ id?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * `/board` is the same page wearing the kanban layout (see the route table).
   * It keys off the pathname rather than a prop so no state has to cross the
   * route boundary — and so the queue store, already loaded, is simply grouped
   * differently instead of refetched.
   */
  const boardMode = location.pathname.startsWith('/board');

  const railOpen = useUiStore((state) => state.contextRailOpen);
  const toggleRail = useUiStore((state) => state.toggleContextRail);

  const views = useViewStore((state) => state.views);
  const activeSlug = useViewStore((state) => state.activeSlug);
  const setActive = useViewStore((state) => state.setActive);
  const initialSlug = useViewStore((state) => state.initialSlug);

  const setQuery = useTicketStore((state) => state.setQuery);

  const [queueWidth, setQueueWidth] = useState(() => readWidth(QUEUE_WIDTH_KEY, QUEUE_BOUNDS));
  const [railWidth, setRailWidth] = useState(() => readWidth(RAIL_WIDTH_KEY, RAIL_BOUNDS));
  const [groupBy, setGroupByState] = useState<QueueGroupField | null>(readGroupBy);

  /** The row the conversation is holding — the rail renders from this. */
  const [railTicket, setRailTicket] = useState<TicketWithRelations | null>(null);

  const routeId = params.id?.trim() ?? '';
  const parsedId = /^\d+$/.test(routeId) ? Number(routeId) : null;
  const selectedId = parsedId !== null && parsedId > 0 ? parsedId : null;
  /** An `:id` that is present but is not a ticket id — `/tickets/ACME-42`. */
  const badRouteId = routeId !== '' && routeId !== 'new' && selectedId === null;
  /** `/tickets/new` is the composer, not a ticket id. */
  const composerOpen = routeId === 'new';

  // ── Which view drives the queue ──────────────────────────────────────────
  // `?view=` wins (it is what the sidebar links to and what a shared URL
  // carries); the remembered choice is the fallback.
  const urlView = searchParams.get('view');

  useEffect(() => {
    if (urlView && urlView !== activeSlug) setActive(urlView);
  }, [urlView, activeSlug, setActive]);

  /**
   * The FIRST load, and every view change.
   *
   * `setQuery` resets the window and the selection, which is correct on a view
   * change and wrong on anything else — so this effect keys strictly on the
   * slug and never on the query object it writes.
   */
  const lastAppliedSlug = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (views.length === 0) return;

    // `initialSlug()` is the LANDING choice only. Applying it every time the
    // slug is null would make "Filtre libre" impossible: clearing the view would
    // instantly snap back to the remembered one.
    const first = lastAppliedSlug.current === undefined;
    const slug = urlView ?? activeSlug ?? (first ? initialSlug() : null);
    if (!first && lastAppliedSlug.current === slug) return;
    lastAppliedSlug.current = slug;

    if (slug) {
      setActive(slug);
      void setQuery({ viewSlug: slug, cursor: null });
    } else {
      void setQuery({ viewSlug: undefined, cursor: null });
    }
  }, [views, urlView, activeSlug, initialSlug, setActive, setQuery]);

  const handleSelectView = useCallback(
    (slug: string | null) => {
      setActive(slug);
      const next = new URLSearchParams(searchParams);
      if (slug) next.set('view', slug);
      else next.delete('view');
      setSearchParams(next, { replace: true });
    },
    [setActive, searchParams, setSearchParams],
  );

  const handleGroupBy = useCallback((field: QueueGroupField | null) => {
    setGroupByState(field);
    try {
      if (field) localStorage.setItem(GROUP_BY_KEY, field);
      else localStorage.removeItem(GROUP_BY_KEY);
    } catch {
      // Non-fatal: the grouping holds for this session only.
    }
  }, []);

  // ── Opening a ticket moves the URL, not the tree ────────────────────────
  const openTicket = useCallback(
    (ticketId: number) => {
      const suffix = searchParams.toString();
      navigate(`/tickets/${ticketId}${suffix ? `?${suffix}` : ''}`);
    },
    [navigate, searchParams],
  );

  // ── Splitters ────────────────────────────────────────────────────────────
  const dragSplitter = useCallback(
    (
      event: ReactMouseEvent,
      current: number,
      bounds: { min: number; max: number },
      direction: 1 | -1,
      apply: (width: number) => void,
      persist: (width: number) => void,
    ) => {
      event.preventDefault();
      const startX = event.clientX;
      let latest = current;

      const onMove = (moveEvent: globalThis.MouseEvent): void => {
        const delta = (moveEvent.clientX - startX) * direction;
        latest = Math.min(bounds.max, Math.max(bounds.min, current + delta));
        apply(latest);
      };

      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        persist(latest);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      // Without these the drag selects page text and the cursor flickers back to
      // the arrow every time it leaves the 4px strip.
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [],
  );

  // ── Page-level keys ──────────────────────────────────────────────────────
  // The queue owns navigation; the conversation owns the ticket verbs. What is
  // left is moving between views and creating a ticket.
  useKeyboard({
    nextView: () => {
      if (views.length === 0) return;
      const index = views.findIndex((view) => view.slug === activeSlug);
      handleSelectView(views[(index + 1 + views.length) % views.length].slug);
    },
    previousView: () => {
      if (views.length === 0) return;
      const index = views.findIndex((view) => view.slug === activeSlug);
      handleSelectView(views[(index - 1 + views.length) % views.length].slug);
    },
    newTicket: () => navigate('/tickets/new'),
  });

  // A ticket that is no longer on screen must not leave its context in the rail.
  useEffect(() => {
    setRailTicket((current) => (current && current.id === selectedId ? current : null));
  }, [selectedId]);

  if (boardMode) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg-primary">
        <ViewBar
          activeSlug={activeSlug}
          onSelectView={handleSelectView}
          groupBy={groupBy}
          onGroupByChange={handleGroupBy}
        />
        <div className="px-3">
          <BulkActionBar />
        </div>
        <CategoryBoard onOpen={openTicket} />
        <NewTicketModal
          open={composerOpen}
          onClose={() => navigate('/board')}
          onCreated={(id) => navigate(`/tickets/${id}`)}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-bg-primary">
      <NewTicketModal
        open={composerOpen}
        onClose={() => navigate('/tickets')}
        onCreated={(id) => navigate(`/tickets/${id}`)}
      />
      {/* ══ Pane 1 — the queue ════════════════════════════════════════════ */}
      <div
        style={{ width: `${queueWidth}px` }}
        className="flex min-h-0 shrink-0 flex-col overflow-hidden"
      >
        <ViewBar
          activeSlug={activeSlug}
          onSelectView={handleSelectView}
          groupBy={groupBy}
          onGroupByChange={handleGroupBy}
        />
        <TicketQueue
          activeTicketId={selectedId}
          onOpen={openTicket}
          groupBy={groupBy}
          className="min-h-0 flex-1 rounded-tr-card"
        />
      </div>

      <Splitter
        label={t('tickets.resizeQueue', 'Redimensionner la file')}
        onMouseDown={(event) =>
          dragSplitter(event, queueWidth, QUEUE_BOUNDS, 1, setQueueWidth, (width) =>
            writeWidth(QUEUE_WIDTH_KEY, width),
          )
        }
        onNudge={(delta) => nudge(queueWidth, delta, QUEUE_BOUNDS, QUEUE_WIDTH_KEY, setQueueWidth)}
      />

      {/* ══ Pane 2 — the conversation ═════════════════════════════════════ */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-2">
          <BulkActionBar className="min-w-0 flex-1" />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/tickets/new')}
              className="inline-flex items-center gap-1.5 rounded-pill bg-accent px-2.5 py-1.5 text-[12px] font-semibold text-bg-primary transition-colors hover:bg-accent-hover"
            >
              <Plus size={13} aria-hidden />
              {t('tickets.new', 'Nouveau ticket')}
            </button>
            <button
              type="button"
              onClick={toggleRail}
              aria-pressed={railOpen}
              title={
                railOpen
                  ? t('rail.hide', 'Masquer le contexte')
                  : t('rail.show', 'Afficher le contexte')
              }
              className="rounded-pill bg-bg-tertiary p-1.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              {railOpen ? (
                <PanelRightClose size={13} aria-hidden />
              ) : (
                <PanelRightOpen size={13} aria-hidden />
              )}
            </button>
          </div>
        </div>

        {badRouteId ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <EmptyState
              icon={<ShieldAlert size={24} className="text-sla-breach" />}
              title={t('tickets.badId', 'Cette adresse ne désigne pas un ticket')}
              description={t(
                'tickets.badIdHint',
                'Un ticket s’ouvre par son identifiant numérique. Utilisez la recherche ou la palette de commandes pour le retrouver.',
              )}
            />
          </div>
        ) : selectedId === null ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <EmptyState
              icon={<Inbox size={24} className="text-text-muted" />}
              title={t('tickets.pickOne', 'Choisissez un ticket dans la file')}
              description={t(
                'tickets.pickOneHint',
                'La conversation, le contexte et les actions s’ouvrent ici. Au clavier : j et k pour parcourir, o pour ouvrir.',
              )}
            />
          </div>
        ) : (
          // The key is the whole point: the conversation remounts per ticket
          // while the queue beside it never does.
          <TicketConversation
            key={selectedId}
            ticketId={selectedId}
            withRail={false}
            onOpenTicket={openTicket}
            onTicketLoaded={setRailTicket}
            className="min-h-0 flex-1"
          />
        )}
      </div>

      {/* ══ Pane 3 — the context rail ═════════════════════════════════════ */}
      {railOpen && (
        <>
          <Splitter
            label={t('tickets.resizeRail', 'Redimensionner le contexte')}
            onMouseDown={(event) =>
              dragSplitter(event, railWidth, RAIL_BOUNDS, -1, setRailWidth, (width) =>
                writeWidth(RAIL_WIDTH_KEY, width),
              )
            }
            onNudge={(delta) => nudge(railWidth, -delta, RAIL_BOUNDS, RAIL_WIDTH_KEY, setRailWidth)}
          />
          <div
            style={{ width: `${railWidth}px` }}
            className="min-h-0 shrink-0 overflow-hidden"
          >
            {railTicket ? (
              <ContextRail ticket={railTicket} onOpenTicket={openTicket} className="h-full" />
            ) : (
              <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-text-muted">
                {selectedId === null
                  ? t(
                      'rail.noTicket',
                      'Le contexte (poste, contrat, alertes liées) apparaît dès qu’un ticket est ouvert.',
                    )
                  : t('common.loading', 'Chargement…')}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default TicketsPage;

// ═════════════════════════════════════════════════════════════════════════════
// Board mode
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The same loaded window, one column per status CATEGORY (HARD RULE 5 — never
 * per status slug, or a tenant with nine statuses gets nine columns and no
 * shape). `selectByCategory` is exactly this projection, so the board costs a
 * grouping pass over rows the queue already holds and not one extra request.
 *
 * Cards do not drag between columns. A move between categories is a state
 * TRANSITION: it can be blocked, it can require fields, and it can fire effects.
 * A drag that quietly attempts one and bounces back teaches agents that the
 * board lies; the card opens the ticket, where the legal moves live with their
 * reasons.
 */
function CategoryBoard({ onOpen }: { onOpen: (ticketId: number) => void }): JSX.Element {
  const { t } = useTranslation();

  const byCategory = useTicketStore(selectByCategory);
  const isLoading = useTicketStore((state) => state.isLoading);
  const loaded = useTicketStore((state) => state.ids.length);
  const hasMore = useTicketStore((state) => state.hasMore);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  const columns = STATUS_CATEGORY_ORDER.filter(
    (category) => (byCategory[category]?.length ?? 0) > 0,
  );

  if (isLoading && loaded === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoadingSpinner label={t('common.loading', 'Chargement…')} />
      </div>
    );
  }

  if (columns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={<Inbox size={24} className="text-text-muted" />}
          title={t('tickets.noTickets', 'Aucun ticket')}
          description={t(
            'tickets.noTicketsHint',
            'Cette vue est vide. Changez de filtre ou créez un ticket.',
          )}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      {/* The board shows the LOADED window, not the whole result set. Saying so
          is the difference between a board and a board-shaped lie. */}
      {hasMore && (
        <p className="shrink-0 px-1 text-[11px] text-text-muted">
          {t(
            'tickets.boardWindow',
            'Ce tableau montre les {{count}} lignes chargées. Faites défiler la file pour en charger davantage.',
            { count: loaded },
          )}
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-1">
        {columns.map((category) => (
          <BoardColumn
            key={category}
            category={category}
            tickets={byCategory[category] ?? []}
            now={now}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}

function BoardColumn({
  category,
  tickets,
  now,
  onOpen,
}: {
  category: StatusCategory;
  tickets: TicketWithRelations[];
  now: number;
  onOpen: (ticketId: number) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const meta = STATUS_CATEGORY_META[category];

  return (
    <section className="flex min-h-0 w-[300px] shrink-0 flex-col gap-2 rounded-card bg-bg-secondary p-2.5 shadow-card">
      <header className="flex shrink-0 items-center gap-2">
        <h2 className="flex-1 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
          {t(meta.labelKey, meta.label)}
        </h2>
        <span className="rounded-pill bg-bg-tertiary px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-muted">
          {tickets.length}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {tickets.map((ticket) => {
          const sla = nearestInstance(ticket.slaInstances);
          return (
            <button
              key={ticket.id}
              type="button"
              onClick={() => onOpen(ticket.id)}
              className="flex w-full flex-col gap-1.5 rounded-card bg-bg-tertiary px-2.5 py-2 text-left transition-colors hover:bg-bg-hover"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 font-mono text-[11px] text-accent">{ticket.number}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">
                  {ticket.subject}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusPill
                  statusSlug={ticket.statusSlug}
                  category={ticket.statusCategory}
                  label={ticket.status?.label ?? ticket.statusSlug}
                  size="sm"
                />
                <PriorityBadge
                  prioritySlug={ticket.prioritySlug}
                  rank={ticket.priority?.rank}
                  label={ticket.priority?.label ?? ticket.prioritySlug}
                  size="sm"
                />
                {sla && <SlaChip instance={sla} now={now} size="sm" />}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The drag strip
// ═════════════════════════════════════════════════════════════════════════════

/** How far one arrow-key press moves a pane edge. */
const NUDGE_PX = 16;

/**
 * 4px of grab area, no border. It gets a `separator` role AND working arrow
 * keys — a splitter that only responds to a drag is a splitter half the desk
 * cannot use, and the layout is something an agent lives inside all day.
 */
function Splitter({
  label,
  onMouseDown,
  onNudge,
  className,
}: {
  label: string;
  onMouseDown: (event: ReactMouseEvent) => void;
  /** Signed pixels, in the same direction the drag moves this edge. */
  onNudge: (delta: number) => void;
  className?: string;
}): JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onNudge(-NUDGE_PX);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          onNudge(NUDGE_PX);
        }
      }}
      className={clsx(
        'w-1 shrink-0 cursor-col-resize bg-bg-primary transition-colors hover:bg-accent/40 focus:bg-accent/60 focus:outline-none',
        className,
      )}
    />
  );
}
