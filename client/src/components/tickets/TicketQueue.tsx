/**
 * TicketQueue.tsx — the virtualised queue.
 *
 * ── No pagination controls. Anywhere. ───────────────────────────────────────
 * There is no page number, no "next", no "50 per page". The queue is one
 * continuous list over a keyset cursor: `@tanstack/react-virtual` mounts ~40
 * rows out of however many exist, and when the window approaches the end of the
 * loaded set the store fetches the next keyset page. An agent working a backlog
 * should never have to remember which page they were on, and a page number over
 * a table that is being written to is a lie anyway — rows move between pages
 * while you read them.
 *
 * ── New arrivals do not move the ground under your cursor ───────────────────
 * A ticket that arrives while you are reading row 40 goes into the store's
 * `pendingIds` and surfaces as a "3 nouveaux" pill. Clicking the pill is the
 * ONLY thing that inserts rows at the top, and when it does, the store shifts
 * `focusedIndex` by the same amount so the highlighted ticket is still the same
 * ticket. Auto-prepending would shift every row under the pointer by one, which
 * is how an agent opens the wrong ticket.
 *
 * ── Select-all is explicit about what it covers ─────────────────────────────
 * `Ctrl+A` selects the LOADED rows and says so. Extending to "everything that
 * matches" is a second, separate click that names the number, loads those rows
 * (a bulk apply needs each row's own `rowVersion` — HARD RULE 7 — so a
 * selection of rows we have never fetched is not a selection, it is a wish),
 * and refuses above `LIMITS.bulkMaxTickets` with the reason rather than
 * silently truncating.
 *
 * ── One ticker, not forty ───────────────────────────────────────────────────
 * A single 1 s interval lives here and is passed to every visible row. Forty
 * `setInterval`s mounting and unmounting as the scrollbar moves is what makes a
 * queue stutter exactly where it must not.
 *
 * HARD RULE 11 — no border on any surface in this file.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowUp,
  CheckCheck,
  Inbox,
  Loader2,
  Rows3,
  Rows4,
  AlertTriangle,
  X,
} from 'lucide-react';
import { LIMITS, PAGINATION } from '@oblidesk/shared';
import type { TicketWithRelations } from '@oblidesk/shared';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useKeyboard } from '@/hooks/useKeyboard';
import { selectPendingCount, selectRows, useTicketStore } from '@/store/ticketStore';
import { useUiStore } from '@/store/uiStore';
import { formatNumber } from '@/utils/format';
import TicketRow, { TICKET_ROW_HEIGHT, type TicketRowLabels } from './TicketRow';
import { queueGroupHeading, queueGroupKeyOf, type QueueGroupField } from './ViewBar';

/** Group headings are sticky-ish rows in the same virtual list as the tickets. */
const GROUP_HEADER_HEIGHT = 28;

/** How close to the end of the loaded window before the next page is fetched. */
const PREFETCH_ROWS = 12;

type Item =
  | { kind: 'group'; key: string; label: string; count: number }
  | { kind: 'ticket'; key: number; ticket: TicketWithRelations; index: number };

export interface TicketQueueProps {
  /** The ticket open in the centre pane — drawn as the active row. */
  activeTicketId: number | null;
  onOpen: (ticketId: number) => void;
  /** Null = flat list. Set by ViewBar, which also forces the matching sort. */
  groupBy: QueueGroupField | null;
  className?: string;
}

export default function TicketQueue({
  activeTicketId,
  onOpen,
  groupBy,
  className,
}: TicketQueueProps): JSX.Element {
  const { t } = useTranslation();

  const rows = useTicketStore(selectRows);
  const ids = useTicketStore((state) => state.ids);
  const isLoading = useTicketStore((state) => state.isLoading);
  const isLoadingMore = useTicketStore((state) => state.isLoadingMore);
  const error = useTicketStore((state) => state.error);
  const hasMore = useTicketStore((state) => state.hasMore);
  const capReached = useTicketStore((state) => state.capReached);
  const total = useTicketStore((state) => state.total);
  const totalIsApproximate = useTicketStore((state) => state.totalIsApproximate);
  const focusedIndex = useTicketStore((state) => state.focusedIndex);
  const selectedIds = useTicketStore((state) => state.selectedIds);
  const pendingCount = useTicketStore(selectPendingCount);

  const fetchMore = useTicketStore((state) => state.fetchMore);
  const refresh = useTicketStore((state) => state.refresh);
  const flushPending = useTicketStore((state) => state.flushPending);
  const focusIndex = useTicketStore((state) => state.focusIndex);
  const focusNext = useTicketStore((state) => state.focusNext);
  const focusPrevious = useTicketStore((state) => state.focusPrevious);
  const toggleSelected = useTicketStore((state) => state.toggleSelected);
  const selectAllLoaded = useTicketStore((state) => state.selectAllLoaded);
  const clearSelection = useTicketStore((state) => state.clearSelection);

  const density = useUiStore((state) => state.density);
  const toggleDensity = useUiStore((state) => state.toggleDensity);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Anchor for shift-range selection: the last row toggled without shift. */
  const anchorRef = useRef<number | null>(null);

  // ── One ticker for every visible clock ────────────────────────────────────
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  // ── Selection, as a set, so a row lookup is O(1) and not O(n) ────────────
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // ── The row model: tickets, plus group headings when grouping is on ──────
  const items = useMemo<Item[]>(() => {
    if (!groupBy) {
      return rows.map((ticket, index) => ({ kind: 'ticket', key: ticket.id, ticket, index }));
    }

    const out: Item[] = [];
    let currentKey: string | null = null;
    let headerAt = -1;

    rows.forEach((ticket, index) => {
      const key = queueGroupKeyOf(ticket, groupBy);
      if (key !== currentKey) {
        currentKey = key;
        headerAt = out.length;
        out.push({
          kind: 'group',
          key,
          label: queueGroupHeading(key, groupBy, t as (k: string, f: string) => string),
          count: 0,
        });
      }
      // The count is filled in as the group grows, so a header always states
      // the size of the block it actually introduces.
      const header = out[headerAt];
      if (header && header.kind === 'group') header.count += 1;
      out.push({ kind: 'ticket', key: ticket.id, ticket, index });
    });

    return out;
  }, [rows, groupBy, t]);

  /** Row index → position in the virtual list, for keyboard scroll-into-view. */
  const virtualIndexOfRow = useMemo(() => {
    const map = new Map<number, number>();
    items.forEach((item, position) => {
      if (item.kind === 'ticket') map.set(item.index, position);
    });
    return map;
  }, [items]);

  const rowHeight = TICKET_ROW_HEIGHT[density];

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (items[index]?.kind === 'group' ? GROUP_HEADER_HEIGHT : rowHeight),
    overscan: 10,
    getItemKey: (index) => {
      const item = items[index];
      return item.kind === 'group' ? `g:${item.key}` : item.key;
    },
  });

  // Density changes every row's height; the virtualiser has to be told, or it
  // keeps positioning rows at the previous pitch and the list overlaps itself.
  useEffect(() => {
    virtualizer.measure();
  }, [density, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  // ── Keyset paging: fetch when the window nears the end ───────────────────
  const lastVirtual = virtualItems[virtualItems.length - 1];
  useEffect(() => {
    if (!lastVirtual) return;
    if (!hasMore || isLoadingMore || isLoading) return;
    if (lastVirtual.index >= items.length - PREFETCH_ROWS) void fetchMore();
  }, [lastVirtual, items.length, hasMore, isLoadingMore, isLoading, fetchMore]);

  // ── Keep the keyboard cursor on screen ───────────────────────────────────
  // Only when the cursor MOVED. `virtualIndexOfRow` is rebuilt on every store
  // change, and scrolling on those would yank an agent who has scrolled away
  // back to the focused row every time a socket frame lands.
  const lastScrolledTo = useRef(-1);
  useEffect(() => {
    if (focusedIndex < 0 || focusedIndex === lastScrolledTo.current) return;
    lastScrolledTo.current = focusedIndex;
    const position = virtualIndexOfRow.get(focusedIndex);
    if (position === undefined) return;
    virtualizer.scrollToIndex(position, { align: 'auto' });
  }, [focusedIndex, virtualIndexOfRow, virtualizer]);

  // ── Selection ────────────────────────────────────────────────────────────
  const handleToggleSelect = useCallback(
    (ticketId: number, index: number, shift: boolean) => {
      const anchor = anchorRef.current;

      if (shift && anchor !== null && anchor !== index) {
        // A shift-range ADDS the span; it never clears what is already selected,
        // because an agent building a selection in two passes should not lose
        // the first one to a stray Shift.
        const from = Math.min(anchor, index);
        const to = Math.max(anchor, index);
        const span = ids.slice(from, to + 1);
        const current = new Set(useTicketStore.getState().selectedIds);
        for (const id of span) current.add(id);
        useTicketStore.setState({ selectedIds: [...current] });
        return;
      }

      anchorRef.current = index;
      toggleSelected(ticketId);
    },
    [ids, toggleSelected],
  );

  const handleOpen = useCallback(
    (ticketId: number, index: number) => {
      focusIndex(index);
      anchorRef.current = index;
      onOpen(ticketId);
    },
    [focusIndex, onOpen],
  );

  // ── Select-all-matching ──────────────────────────────────────────────────
  const [extending, setExtending] = useState(false);
  const [extendError, setExtendError] = useState<string | null>(null);

  const allLoadedSelected = selectedIds.length > 0 && selectedIds.length === ids.length;
  const moreExist = hasMore || (total !== null && total > ids.length);
  const tooManyToSelect = total !== null && total > LIMITS.bulkMaxTickets;

  /**
   * Load every remaining page, then select the lot.
   *
   * We cannot select rows we have not fetched: `bulkApply` sends one
   * `baseRowVersion` per ticket, and we only have a row's version once we have
   * read the row. So "select everything matching" is honestly implemented as
   * "load everything matching, then select it", with the number stated up front.
   */
  const selectAllMatching = useCallback(async () => {
    setExtending(true);
    setExtendError(null);
    try {
      // Bounded: the store stops at its own ceiling and flips `capReached`, and
      // this loop stops with it rather than spinning forever on a moving table.
      for (let guard = 0; guard < 200; guard += 1) {
        const state = useTicketStore.getState();
        if (!state.hasMore || state.capReached) break;
        if (state.ids.length >= LIMITS.bulkMaxTickets) break;
        await state.fetchMore();
        if (useTicketStore.getState().error) break;
      }
      useTicketStore.getState().selectAllLoaded();
    } catch (err) {
      setExtendError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtending(false);
    }
  }, []);

  // ── Keyboard: the queue owns navigation and selection only ───────────────
  // The ticket-scoped actions (reply, note, assign…) belong to whatever is in
  // the centre pane; supplying them here too would fire both.
  useKeyboard({
    navigateDown: () => focusNext(),
    navigateUp: () => focusPrevious(),
    open: () => {
      const ticket = useTicketStore.getState().focusedTicket();
      if (ticket) handleOpen(ticket.id, useTicketStore.getState().focusedIndex);
    },
    toggleSelect: () => {
      const state = useTicketStore.getState();
      const ticket = state.focusedTicket();
      if (ticket) handleToggleSelect(ticket.id, state.focusedIndex, false);
    },
    selectAll: () => selectAllLoaded(),
    toggleDensity: () => toggleDensity(),
    refresh: () => void refresh(),
  });

  // ── Row strings, resolved once ───────────────────────────────────────────
  const rowLabels = useMemo<TicketRowLabels>(
    () => ({
      select: t('common.select', 'Sélectionner'),
      deselect: t('common.deselectAll', 'Désélectionner'),
      unassigned: t('common.unassigned', 'Non assigné'),
      noQueue: t('tickets.noQueue', 'Aucune file'),
      noSla: t('sla.none', 'aucun SLA'),
      noRequester: t('rail.noRequester', 'Aucun demandeur rattaché.'),
      age: t('tickets.age', 'Âge'),
      occurredAt: t('tickets.occurredAt', 'Survenu le'),
      createdAt: t('tickets.createdAt', 'Créé le'),
      updatedAt: t('tickets.updatedAt', 'Mis à jour le'),
      requester: t('tickets.requester', 'Demandeur'),
      queue: t('tickets.queue', 'File'),
      reopened: t('tickets.reopenCount', 'Réouvertures'),
    }),
    [t],
  );

  const selectionActive = selectedIds.length > 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div className={clsx('relative flex min-h-0 flex-col bg-bg-secondary', className)}>
      {/* ── Strip: density, selection state ──────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
        <span className="font-mono text-[11px] tabular-nums text-text-muted">
          {total === null
            ? t('tickets.loadedCount', '{{count}} lignes chargées', { count: ids.length })
            : t('tickets.matchCount', '{{shown}} sur {{total}}', {
                shown: formatNumber(ids.length),
                total: totalIsApproximate ? `~${formatNumber(total)}` : formatNumber(total),
              })}
        </span>

        {selectionActive && (
          <button
            type="button"
            onClick={() => {
              clearSelection();
              anchorRef.current = null;
            }}
            className="inline-flex items-center gap-1.5 rounded-pill bg-accent/12 px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent/20"
          >
            <X size={11} aria-hidden />
            {t('tickets.bulk.selected', '{{count}} tickets sélectionnés', {
              count: selectedIds.length,
            })}
          </button>
        )}

        <button
          type="button"
          onClick={toggleDensity}
          title={
            density === 'compact'
              ? t('common.comfortable', 'Confortable')
              : t('common.compact', 'Compact')
          }
          aria-label={t('common.density', 'Densité')}
          className="ml-auto rounded-pill bg-bg-tertiary p-1.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          {density === 'compact' ? <Rows3 size={13} aria-hidden /> : <Rows4 size={13} aria-hidden />}
        </button>
      </div>

      {/* ── Select-all-matching, stating exactly what it covers ──────────── */}
      {allLoadedSelected && moreExist && (
        <div className="mx-3 mb-1.5 flex shrink-0 flex-wrap items-center gap-2 rounded-card bg-accent/10 px-3 py-2 text-[11px] text-text-secondary shadow-card">
          <CheckCheck size={13} className="shrink-0 text-accent" aria-hidden />
          <span>
            {t('tickets.selectAll.loadedOnly', 'Les {{count}} lignes chargées sont sélectionnées.', {
              count: ids.length,
            })}
          </span>

          {tooManyToSelect ? (
            <span className="text-sla-warn">
              {t(
                'tickets.bulk.tooMany',
                'Au-delà de {{count}} tickets, affinez d’abord le filtre.',
                { count: LIMITS.bulkMaxTickets },
              )}
            </span>
          ) : total === null || totalIsApproximate ? (
            <span className="text-text-muted">
              {t(
                'tickets.selectAll.unknownTotal',
                'Le total exact n’est pas connu au-delà de {{threshold}} lignes — affinez le filtre pour tout sélectionner.',
                { threshold: formatNumber(PAGINATION.exactCountThreshold) },
              )}
            </span>
          ) : (
            <button
              type="button"
              disabled={extending}
              onClick={() => void selectAllMatching()}
              className="inline-flex items-center gap-1.5 rounded-pill bg-accent px-2.5 py-1 font-medium text-bg-primary transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {extending && <Loader2 size={11} className="animate-spin" aria-hidden />}
              {t(
                'tickets.selectAll.extend',
                'Charger et sélectionner les {{count}} tickets de ce filtre',
                { count: total },
              )}
            </button>
          )}

          {extendError && <span className="text-sla-breach">{extendError}</span>}
        </div>
      )}

      {/* ── "N nouveaux" — the only thing that moves the anchor ──────────── */}
      {pendingCount > 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-9 z-20 flex justify-center">
          <button
            type="button"
            onClick={() => {
              flushPending();
              virtualizer.scrollToIndex(0, { align: 'start' });
            }}
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-pill bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg-primary shadow-card transition-colors hover:bg-accent-hover"
          >
            <ArrowUp size={13} aria-hidden />
            {t('tickets.newArrivals', '{{count}} nouveaux', { count: pendingCount })}
          </button>
        </div>
      )}

      {/* ── The list ─────────────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        role="grid"
        aria-rowcount={total ?? ids.length}
        aria-label={t('tickets.title', 'Tickets')}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        {isLoading && rows.length === 0 ? (
          <div className="flex h-full items-center justify-center py-12">
            <LoadingSpinner label={t('common.loading', 'Chargement…')} />
          </div>
        ) : error && rows.length === 0 ? (
          <EmptyState
            icon={<AlertTriangle size={22} className="text-sla-breach" />}
            title={t('tickets.loadFailed', 'La file n’a pas pu être chargée')}
            description={error}
            action={
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-pill bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg-primary hover:bg-accent-hover"
              >
                {t('common.retry', 'Réessayer')}
              </button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Inbox size={22} className="text-text-muted" />}
            title={t('tickets.noTickets', 'Aucun ticket')}
            description={t(
              'tickets.noTicketsHint',
              'Cette vue est vide. Changez de filtre ou créez un ticket.',
            )}
          />
        ) : (
          <div
            style={{ height: `${virtualizer.getTotalSize()}px` }}
            className="relative w-full"
          >
            {virtualItems.map((virtualRow) => {
              const item = items[virtualRow.index];
              if (!item) return null;

              const style: CSSProperties = {
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              };

              if (item.kind === 'group') {
                return (
                  <div
                    key={`g:${item.key}`}
                    style={style}
                    className="absolute left-0 top-0 flex w-full items-center gap-2 bg-bg-tertiary px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted"
                  >
                    <span className="truncate">{item.label}</span>
                    <span className="tabular-nums opacity-70">{formatNumber(item.count)}</span>
                  </div>
                );
              }

              return (
                <TicketRow
                  key={item.key}
                  ticket={item.ticket}
                  index={item.index}
                  density={density}
                  selected={selectedSet.has(item.ticket.id)}
                  focused={focusedIndex === item.index}
                  active={activeTicketId === item.ticket.id}
                  selectable={selectionActive}
                  now={now}
                  labels={rowLabels}
                  onOpen={handleOpen}
                  onToggleSelect={handleToggleSelect}
                  style={style}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ── The end of the list, told honestly ───────────────────────────── */}
      <div className="flex shrink-0 items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] text-text-muted">
        {isLoadingMore ? (
          <>
            <Loader2 size={11} className="animate-spin" aria-hidden />
            {t('tickets.loadingMore', 'Chargement…')}
          </>
        ) : capReached ? (
          <span className="text-sla-warn">
            {t(
              'tickets.capReachedHint',
              'Affinez le filtre : au-delà de {{count}} lignes, la file n’est plus lisible.',
              { count: PAGINATION.exactCountThreshold },
            )}
          </span>
        ) : hasMore ? (
          // No button. Scrolling is the control; this only says more exists.
          <span>{t('tickets.moreBelow', 'Continuez à faire défiler pour la suite.')}</span>
        ) : rows.length > 0 ? (
          <span>{t('tickets.endOfList', 'Fin de la file.')}</span>
        ) : null}
      </div>
    </div>
  );
}
