/**
 * ViewBar.tsx — the saved-view strip above the queue.
 *
 * Three jobs, in order of how often they save somebody:
 *
 *  1. WHICH VIEW AM I IN. The active view is a filled pill, the others are
 *     background steps. There is no "no view" state that looks like a view: an
 *     ad-hoc filter gets its own pill that says so.
 *
 *  2. WHAT IS ACTUALLY APPLIED. Under the strip is a row of chips spelling out
 *     every predicate currently narrowing the list — the view's own filter, the
 *     ad-hoc additions, the search text. Each ad-hoc chip removes itself. A
 *     queue that is filtered in a way the agent cannot see is a queue where a
 *     ticket goes unworked and nobody knows why.
 *
 *  3. HOW MANY, HONESTLY. Above `PAGINATION.exactCountThreshold` the server
 *     stops counting exactly and says so, and the badge then renders `~5 200`
 *     with a tooltip explaining the estimate. Rounding 5 213 to "5 200" without
 *     the tilde would be a lie with no tell; printing "5 000+" when the server
 *     handed back an estimate of 5 213 throws away the only number it has.
 *
 * ── Counts come from ONE call ───────────────────────────────────────────────
 * `viewStore.loadCounts()` fetches every badge in a single request and the
 * socket pushes `view:counters` after that. This component never counts a view
 * itself — twelve badges each firing an aggregate is how the sidebar starves
 * the queue it decorates.
 *
 * HARD RULE 11 — no border on any pill or chip here. The active view is an
 * accent fill; the rest are `bg-bg-tertiary`.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  Filter as FilterIcon,
  Layers,
  LayoutGrid,
  Rows3,
  RotateCw,
  Search,
  SlidersHorizontal,
  AlertTriangle,
  X,
} from 'lucide-react';
import {
  PAGINATION,
  isAllNode,
  isAnyNode,
  isConditionLeaf,
  isNotNode,
  statusCategoryLabel,
  toStatusCategory,
  type ConditionNode,
  type StatusCategory,
} from '@oblidesk/shared';
import type { TicketSortField } from '@/api/tickets.api';
import { TICKET_SORT_FIELDS } from '@/api/tickets.api';
import type { ViewCount, ViewDefinition } from '@/api/views.api';
import { formatNumber } from '@/utils/format';
import { useTicketStore, type TicketQueryState } from '@/store/ticketStore';
import { selectSidebarViews, useViewStore } from '@/store/viewStore';

// ═════════════════════════════════════════════════════════════════════════════
// Grouping vocabulary
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Grouping is restricted to columns the SERVER can sort by.
 *
 * A group only holds together if its rows are contiguous, and the rows are
 * contiguous only if the query is ordered by the grouping column. Offering
 * "group by assignee" — which is not a sort field — would produce a board where
 * the same agent appears in four separate blocks, which is worse than no
 * grouping at all. So choosing a group also sets the sort, and the control says
 * so rather than doing it silently.
 */
export const QUEUE_GROUP_FIELDS = ['status_category', 'priority_slug', 'queue_slug'] as const;
export type QueueGroupField = (typeof QUEUE_GROUP_FIELDS)[number];

const GROUP_SORT_FIELD: Readonly<Record<QueueGroupField, TicketSortField>> = {
  status_category: 'status_category',
  priority_slug: 'priority_slug',
  queue_slug: 'queue_slug',
};

const GROUP_LABELS: Readonly<Record<QueueGroupField, { key: string; fallback: string }>> = {
  status_category: { key: 'tickets.columns.status', fallback: 'Statut' },
  priority_slug: { key: 'tickets.columns.priority', fallback: 'Priorité' },
  queue_slug: { key: 'tickets.columns.queue', fallback: 'File' },
};

export function queueGroupFieldLabel(field: QueueGroupField): { key: string; fallback: string } {
  return GROUP_LABELS[field];
}

export function queueGroupSortField(field: QueueGroupField): TicketSortField {
  return GROUP_SORT_FIELD[field];
}

/** The raw group key for a row. Stable — it is what the sort ordered by. */
export function queueGroupKeyOf(
  ticket: { statusCategory: StatusCategory; prioritySlug: string; queueSlug: string },
  field: QueueGroupField,
): string {
  if (field === 'status_category') return ticket.statusCategory;
  if (field === 'priority_slug') return ticket.prioritySlug;
  return ticket.queueSlug;
}

/**
 * The heading for a group. Status categories have hard-coded human names in
 * shared; a priority or queue SLUG is the tenant's own word and is shown as-is
 * rather than prettified into something they never typed.
 */
export function queueGroupHeading(
  key: string,
  field: QueueGroupField,
  t: (k: string, fallback: string) => string,
): string {
  if (field === 'status_category') {
    const label = statusCategoryLabel(toStatusCategory(key));
    return t(label.key, label.fallback);
  }
  return key || t('common.notSet', 'Non renseigné');
}

// ═════════════════════════════════════════════════════════════════════════════
// Counts
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `count` is exact, `estimate` is the planner's row estimate, and `approximate`
 * says which of the two you are looking at. The tilde is the tell.
 */
export function formatViewCount(count: ViewCount | undefined): string | null {
  if (!count) return null;
  if (!count.approximate) return formatNumber(count.count);
  const value = count.estimate ?? count.count;
  return `~${formatNumber(value)}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Filter summary
// ═════════════════════════════════════════════════════════════════════════════

interface Chip {
  id: string;
  label: string;
  title?: string;
  tone?: 'neutral' | 'warn';
  /** Present only for predicates the agent added and can therefore remove. */
  onRemove?: () => void;
}

/** How many leaves a saved view's compiled filter carries. */
function countLeaves(node: ConditionNode | null | undefined): number {
  if (!node) return 0;
  if (isAllNode(node)) return node.all.reduce((sum, child) => sum + countLeaves(child), 0);
  if (isAnyNode(node)) return node.any.reduce((sum, child) => sum + countLeaves(child), 0);
  if (isNotNode(node)) return countLeaves(node.not);
  return isConditionLeaf(node) ? 1 : 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// Component
// ═════════════════════════════════════════════════════════════════════════════

export interface ViewBarProps {
  /** Slug of the saved view driving the queue, or null for an ad-hoc filter. */
  activeSlug: string | null;
  onSelectView: (slug: string | null) => void;
  groupBy: QueueGroupField | null;
  onGroupByChange: (field: QueueGroupField | null) => void;
  className?: string;
}

export default function ViewBar({
  activeSlug,
  onSelectView,
  groupBy,
  onGroupByChange,
  className,
}: ViewBarProps): JSX.Element {
  const { t } = useTranslation();
  // The kanban was implemented (CategoryBoard) but had no way in: '/board'
  // was reachable only from the command palette. The layout lives in the
  // pathname, so switching is a navigation, not a piece of state.
  const location = useLocation();
  const navigate = useNavigate();
  const boardMode = location.pathname.startsWith('/board');

  const views = useViewStore(selectSidebarViews);
  const counts = useViewStore((state) => state.counts);
  const isCounting = useViewStore((state) => state.isCounting);
  const loadViews = useViewStore((state) => state.loadViews);
  const loadCounts = useViewStore((state) => state.loadCounts);

  const query = useTicketStore((state) => state.query);
  const setQuery = useTicketStore((state) => state.setQuery);
  const total = useTicketStore((state) => state.total);
  const totalIsApproximate = useTicketStore((state) => state.totalIsApproximate);
  const unsupportedFilters = useTicketStore((state) => state.unsupportedFilters);
  const loadedCount = useTicketStore((state) => state.ids.length);

  // Views and their badges load once for the page; the socket keeps the numbers
  // fresh afterwards, and the poll below is only the dead-socket fallback.
  const loadedOnce = useRef(false);
  useEffect(() => {
    if (loadedOnce.current) return;
    loadedOnce.current = true;
    void loadViews().then(() => loadCounts());
  }, [loadViews, loadCounts]);

  const activeView: ViewDefinition | undefined = useMemo(
    () => views.find((view) => view.slug === activeSlug),
    [views, activeSlug],
  );

  const patch = useCallback(
    (next: Partial<TicketQueryState>) => {
      void setQuery(next);
    },
    [setQuery],
  );

  // ── The chip row ─────────────────────────────────────────────────────────
  const chips = useMemo<Chip[]>(() => {
    const out: Chip[] = [];

    if (activeView) {
      const leaves = countLeaves(activeView.filter);
      out.push({
        id: 'view',
        label: t('views.filterOfView', 'Filtre de la vue « {{name}} »', { name: activeView.name }),
        title:
          leaves > 0
            ? t('views.filterLeaves', '{{count}} condition(s) définies par la vue', { count: leaves })
            : t('views.filterNone', 'Cette vue ne pose aucune condition.'),
      });
    }

    if (query.q) {
      out.push({
        id: 'q',
        label: `« ${query.q} »`,
        title: t('tickets.filter.search', 'Recherche plein texte'),
        onRemove: () => patch({ q: undefined }),
      });
    }

    if (query.statusCategories?.length) {
      out.push({
        id: 'statusCategories',
        label: query.statusCategories
          .map((category) => {
            const label = statusCategoryLabel(toStatusCategory(category));
            return t(label.key, label.fallback);
          })
          .join(', '),
        title: t('tickets.columns.status', 'Statut'),
        onRemove: () => patch({ statusCategories: undefined }),
      });
    }

    if (query.queueSlugs?.length) {
      out.push({
        id: 'queueSlugs',
        label: query.queueSlugs.join(', '),
        title: t('tickets.columns.queue', 'File'),
        onRemove: () => patch({ queueSlugs: undefined }),
      });
    }

    if (query.prioritySlugs?.length) {
      out.push({
        id: 'prioritySlugs',
        label: query.prioritySlugs.join(', ').toUpperCase(),
        title: t('tickets.columns.priority', 'Priorité'),
        onRemove: () => patch({ prioritySlugs: undefined }),
      });
    }

    if (query.assigneeIds?.length) {
      // `0` is the server's "unassigned" sentinel — spelling it out matters,
      // because "assigné à 0" is meaningless and "non assigné" is the query.
      const unassigned = query.assigneeIds.includes(0);
      const named = query.assigneeIds.filter((id) => id !== 0).length;
      out.push({
        id: 'assigneeIds',
        label: unassigned && named === 0
          ? t('common.unassigned', 'Non assigné')
          : t('tickets.filter.assignees', '{{count}} assigné(s)', { count: named + (unassigned ? 1 : 0) }),
        title: t('tickets.columns.assignee', 'Assigné'),
        onRemove: () => patch({ assigneeIds: undefined }),
      });
    }

    if (query.breachingWithinMinutes !== undefined) {
      out.push({
        id: 'breaching',
        label: t('tickets.filter.breachingWithin', 'SLA dans moins de {{count}} min', {
          count: query.breachingWithinMinutes,
        }),
        onRemove: () => patch({ breachingWithinMinutes: undefined }),
      });
    }

    if (query.occurredFrom || query.occurredTo) {
      out.push({
        id: 'occurred',
        label: t('tickets.filter.occurredBetween', 'Survenu entre {{from}} et {{to}}', {
          from: query.occurredFrom ?? '…',
          to: query.occurredTo ?? '…',
        }),
        title: t('tickets.occurredAtHelp', 'Quand l’incident s’est réellement produit.'),
        onRemove: () => patch({ occurredFrom: undefined, occurredTo: undefined }),
      });
    }

    if (query.includeDeleted) {
      out.push({
        id: 'deleted',
        label: t('tickets.filter.includeDeleted', 'Tickets supprimés inclus'),
        tone: 'warn',
        onRemove: () => patch({ includeDeleted: undefined }),
      });
    }

    // The most important chip on the row: the server could not compile part of
    // the filter, so the list is NARROWER than what was asked for.
    for (const predicate of unsupportedFilters) {
      out.push({
        id: `unsupported:${predicate}`,
        label: predicate,
        tone: 'warn',
        title: t(
          'tickets.unsupportedFilters',
          'Une partie du filtre n’a pas pu être appliquée : cette liste est plus étroite que prévu.',
        ),
      });
    }

    return out;
  }, [activeView, query, unsupportedFilters, patch, t]);

  const activeCount = formatViewCount(activeSlug ? counts[activeSlug] : undefined);

  const sortOptions = useMemo(
    () =>
      TICKET_SORT_FIELDS.map((field) => ({
        value: field,
        label: t(`tickets.sort.${field}`, SORT_FALLBACK[field] ?? field),
      })),
    [t],
  );

  return (
    <div className={clsx('flex flex-col gap-2 bg-bg-primary px-3 pb-2 pt-2.5', className)}>
      {/* ── The view strip ─────────────────────────────────────────────────
          The views get a row to THEMSELVES, and the sort/group/refresh
          controls get the next one.

          They used to share one row. Once the strip started wrapping instead of
          scrolling, that meant the views wrapped to three short lines while the
          controls sat pinned to the right of the second one, so the whole
          header looked stacked and the views never got the width they needed.
          Giving the strip the full width is what stops it wrapping in the first
          place; on a narrow window it still wraps, but into two full lines
          rather than three ragged ones. */}
      <div className="flex flex-wrap items-center gap-1">
        {/*
          Wrap, do not scroll.

          This row was `overflow-x-auto`, which hid views off the right edge —
          the whole point of the strip is that you can see every view you have
          without hunting for one. `overflow-x-auto` also clipped the row
          VERTICALLY (CSS refuses `overflow-x: auto` with `overflow-y: visible`
          and quietly promotes the other axis to `auto` too), so the active
          chip's ring was sheared off along its top edge.

          Wrapping costs a second line when there are many views and gives back
          both: nothing is hidden, and nothing is clipped.
        */}
        <div
          role="tablist"
          aria-label={t('views.title', 'Vues')}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
        >
          {views.length === 0 && (
            <span className="px-1 text-[12px] text-text-muted">
              {t('views.none', 'Aucune vue enregistrée.')}
            </span>
          )}

          {views.map((view) => {
            const isActive = view.slug === activeSlug;
            const badge = view.showCount ? formatViewCount(counts[view.slug]) : null;
            const warnings = counts[view.slug]?.warnings ?? [];

            return (
              <button
                key={view.slug}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onSelectView(view.slug)}
                title={view.description ?? view.name}
                className={clsx(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2.5 py-1.5 text-[12px] transition-colors',
                  isActive
                    ? 'bg-accent font-semibold text-bg-primary'
                    : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                )}
              >
                <span className="max-w-[13rem] truncate">{view.name}</span>

                {badge !== null && (
                  <span
                    title={
                      counts[view.slug]?.approximate
                        ? t(
                            'views.countApproximateHelp',
                            'Au-delà de {{threshold}} tickets le compteur exact n’est plus calculé : ceci est une estimation du serveur.',
                            { threshold: formatNumber(PAGINATION.exactCountThreshold) },
                          )
                        : undefined
                    }
                    className={clsx(
                      'rounded-pill px-1.5 py-px font-mono text-[10px] tabular-nums',
                      isActive ? 'bg-bg-primary/25 text-bg-primary' : 'bg-bg-primary/40 text-text-muted',
                    )}
                  >
                    {badge}
                  </span>
                )}

                {warnings.length > 0 && (
                  <AlertTriangle
                    size={11}
                    className={isActive ? 'text-bg-primary' : 'text-sla-warn'}
                    aria-label={t(
                      'views.countWarning',
                      'Le compteur est partiel : une partie du filtre n’a pas pu être appliquée.',
                    )}
                  />
                )}
              </button>
            );
          })}

          {/* An ad-hoc filter is a state, not the absence of one. */}
          {activeSlug === null && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-accent px-2.5 py-1.5 text-[12px] font-semibold text-bg-primary">
              <SlidersHorizontal size={12} aria-hidden />
              {t('views.adhoc', 'Filtre libre')}
            </span>
          )}
        </div>
      </div>

      {/* ── Controls: sort, grouping, refresh ─────────────────────────────
          Their own row, so the view strip above keeps the full width. */}
      <div className="flex flex-wrap items-center gap-2">

        {/* ── Layout: list or kanban ─────────────────────────────────────── */}
        <div className="flex shrink-0 items-center gap-0.5 rounded-pill bg-bg-tertiary p-0.5">
          <button
            type="button"
            onClick={() => navigate('/tickets')}
            aria-pressed={!boardMode}
            title={t('views.layoutList', 'List')}
            className={clsx(
              'flex items-center gap-1 rounded-pill px-2 py-1 text-[11px] transition-colors',
              !boardMode ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-secondary',
            )}
          >
            <Rows3 size={13} aria-hidden />
            <span className="sr-only">{t('views.layoutList', 'List')}</span>
          </button>
          <button
            type="button"
            onClick={() => navigate('/board')}
            aria-pressed={boardMode}
            title={t('views.layoutBoard', 'Board')}
            className={clsx(
              'flex items-center gap-1 rounded-pill px-2 py-1 text-[11px] transition-colors',
              boardMode ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-secondary',
            )}
          >
            <LayoutGrid size={13} aria-hidden />
            <span className="sr-only">{t('views.layoutBoard', 'Board')}</span>
          </button>
        </div>

        {/* ── Sort ───────────────────────────────────────────────────────── */}
        <label className="flex shrink-0 items-center gap-1.5 rounded-pill bg-bg-tertiary py-1 pl-2.5 pr-1 text-[11px] text-text-muted">
          <span className="sr-only">{t('views.sort', 'Tri')}</span>
          <select
            value={query.sortBy}
            onChange={(event) => patch({ sortBy: event.target.value as TicketSortField })}
            className="cursor-pointer bg-transparent py-0.5 pr-1 text-[11px] text-text-secondary outline-none"
          >
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value} className="bg-bg-secondary">
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => patch({ sortDir: query.sortDir === 'asc' ? 'desc' : 'asc' })}
          title={
            query.sortDir === 'asc'
              ? t('common.sortAscending', 'Tri croissant')
              : t('common.sortDescending', 'Tri décroissant')
          }
          className="shrink-0 rounded-pill bg-bg-tertiary p-1.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          {query.sortDir === 'asc' ? (
            <ArrowUpWideNarrow size={13} aria-hidden />
          ) : (
            <ArrowDownWideNarrow size={13} aria-hidden />
          )}
        </button>

        {/* ── Group ──────────────────────────────────────────────────────── */}
        <label
          className="flex shrink-0 items-center gap-1.5 rounded-pill bg-bg-tertiary py-1 pl-2.5 pr-1 text-[11px] text-text-muted"
          title={t(
            'views.groupByHelp',
            'Regrouper impose le tri sur la même colonne : sans cela les groupes seraient éclatés.',
          )}
        >
          <Layers size={12} aria-hidden />
          <span className="sr-only">{t('views.groupBy', 'Regrouper par')}</span>
          <select
            value={groupBy ?? ''}
            onChange={(event) => {
              const value = event.target.value as QueueGroupField | '';
              if (value === '') {
                onGroupByChange(null);
                return;
              }
              onGroupByChange(value);
              // Grouping without the matching sort produces broken groups.
              patch({ sortBy: queueGroupSortField(value), sortDir: 'asc' });
            }}
            className="cursor-pointer bg-transparent py-0.5 pr-1 text-[11px] text-text-secondary outline-none"
          >
            <option value="" className="bg-bg-secondary">
              {t('views.groupByNone', 'Sans regroupement')}
            </option>
            {QUEUE_GROUP_FIELDS.map((field) => {
              const label = queueGroupFieldLabel(field);
              return (
                <option key={field} value={field} className="bg-bg-secondary">
                  {t(label.key, label.fallback)}
                </option>
              );
            })}
          </select>
        </label>

        <button
          type="button"
          onClick={() => void loadCounts(true)}
          title={t('views.refreshCounts', 'Recalculer les compteurs')}
          className="shrink-0 rounded-pill bg-bg-tertiary p-1.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <RotateCw size={13} className={clsx(isCounting && 'animate-spin')} aria-hidden />
        </button>
      </div>

      {/* ── The filter summary ───────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-text-muted">
          <FilterIcon size={11} aria-hidden />
          {chips.length === 0
            ? t('tickets.filter.none', 'Aucun filtre : tout ce que vous pouvez voir.')
            : t('common.filters', 'Filtres')}
        </span>

        {chips.map((chip) => (
          <span
            key={chip.id}
            title={chip.title}
            className={clsx(
              'inline-flex max-w-[18rem] items-center gap-1 rounded-pill py-1 pl-2 text-[11px]',
              chip.onRemove ? 'pr-1' : 'pr-2',
              chip.tone === 'warn'
                ? 'bg-sla-warn-bg text-sla-warn'
                : 'bg-bg-tertiary text-text-secondary',
            )}
          >
            {chip.tone === 'warn' && <AlertTriangle size={10} aria-hidden />}
            <span className="truncate">{chip.label}</span>
            {chip.onRemove && (
              <button
                type="button"
                onClick={chip.onRemove}
                aria-label={t('common.remove', 'Retirer')}
                className="rounded-full p-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                <X size={10} aria-hidden />
              </button>
            )}
          </span>
        ))}

        {/* The count for the list actually on screen, in the same vocabulary as
            the badges: a tilde whenever the number is an estimate. */}
        <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-text-muted">
          <Search size={11} aria-hidden />
          {total === null
            ? t('tickets.loadedCount', '{{count}} lignes chargées', { count: loadedCount })
            : t('tickets.matchCount', '{{shown}} sur {{total}}', {
                shown: formatNumber(loadedCount),
                total: totalIsApproximate ? `~${formatNumber(total)}` : formatNumber(total),
              })}
          {activeCount !== null && activeSlug !== null && (
            <span
              className="text-text-muted/70"
              title={t('views.badgeCount', 'Compteur de la vue')}
            >
              · {activeCount}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/** French fallbacks for the sort menu, paired with `tickets.sort.*` keys. */
const SORT_FALLBACK: Readonly<Record<string, string>> = {
  updated_at: 'Mis à jour',
  created_at: 'Créé',
  occurred_at: 'Survenu',
  due_at: 'Échéance',
  first_response_at: 'Première réponse',
  resolved_at: 'Résolu',
  closed_at: 'Clôturé',
  number: 'Numéro',
  subject: 'Objet',
  priority_slug: 'Priorité',
  status_category: 'Statut',
  queue_slug: 'File',
  reopen_count: 'Réouvertures',
  id: 'Identifiant',
};
