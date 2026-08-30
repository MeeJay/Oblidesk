/**
 * ChangesPage — `/changes`
 *
 * Two surfaces over the same records, and the ORDER matters: the CALENDAR is
 * the default and the LIST is the second tab, not the other way round.
 *
 * ── Why the calendar leads ──────────────────────────────────────────────────
 * A window conflict is invisible in a table. Two rows reading "12 Feb 22:00 →
 * 02:00" and "12 Feb 23:30 → 01:00" are two ordinary rows; on a timeline they
 * are one obvious collision, and the person who has to decide sees it without
 * being told. Everything else this module computes — the risk band, the CAB
 * selection, the freeze verdicts — exists to be acted on at exactly the moment
 * somebody is choosing a date, so that is the moment the screen has to be good
 * at.
 *
 * So the timeline draws, per change:
 *   • a bar across the days its PLANNED window spans (half-open, like the
 *     `[)` ranges migration 011 generates — a change ending at 02:00 and one
 *     starting at 02:00 are back-to-back, not overlapping);
 *   • the OVERLAP SEGMENTS of every live conflict, painted inside the bar, so
 *     the collision is located in time and not merely announced;
 *   • a freeze mark when a `change_freeze` fired on the window;
 *   • a live mark while the ACTUAL window is open (`isImplementing` — the
 *     derived state that replaces a ninth status category, HARD RULE 5).
 * Hovering a bar dims everything it has no conflict with, which turns "this one
 * is red" into "this one is red BECAUSE of that one".
 *
 * ── What the calendar cannot show, and says so ──────────────────────────────
 * A change with no planned window has nothing to draw. Those are counted in the
 * footer and one click away in the list, because a scheduler who cannot see the
 * unscheduled work plans against a calendar that is quietly incomplete.
 *
 * ── Filtering ───────────────────────────────────────────────────────────────
 * `GET /changes/schedule` takes a range and a queue and answers with everything
 * in it — deliberately unpaginated, because a paginated calendar hides the
 * collision on the 26th row. The chips below therefore narrow the CALENDAR in
 * the browser and the LIST on the server, which is not an inconsistency: the
 * list is a paged query and the calendar is a bounded one.
 *
 * HARD RULE 11 — no border anywhere below. Depth is the background step plus
 * `shadow-card`; a chip is a tinted background and hover swaps that background.
 * HARD RULE 10 — every visible string is `t('change.…', 'English fallback')`.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Plus,
  Replace,
  Rows3,
  Search,
  Snowflake,
  X,
} from 'lucide-react';
import {
  CAPABILITIES,
  CHANGE_CONFLICT_KIND_LABELS,
  CHANGE_OUTCOME_LABELS,
  CHANGE_RISKS,
  CHANGE_RISK_LABELS,
  CHANGE_TYPES,
  CHANGE_TYPE_LABELS,
  isImplementing,
  plannedWindowOf,
} from '@oblidesk/shared';
import type {
  ChangeConflictView,
  ChangeListQuery,
  ChangeOutcome,
  ChangeRisk,
  ChangeType,
  ChangeWithRelations,
  StatusCategory,
} from '@oblidesk/shared';
import { ApiError, errorMessage } from '@/api/client';
import changesApi, { type ChangeModelSummary } from '@/api/changes.api';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import StatusPill from '@/components/tickets/StatusPill';
import { formatAbsolute } from '@/components/tickets/SlaChip';
import {
  loadTicketFieldOptions,
  type TicketFieldOptions,
} from '@/components/tickets/BulkActionBar';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useDebounce } from '@/hooks/useDebounce';
import { formatDateTime } from '@/utils/format';

const PAGE_SIZE = 25;

type Tab = 'calendar' | 'list';
type Span = 'week' | 'fortnight' | 'month';

/** The status categories worth a chip on a change board. */
const BOARD_CATEGORIES: readonly StatusCategory[] = [
  'new',
  'open',
  'scheduled',
  'resolved',
  'closed',
  'cancelled',
];

const CATEGORY_LABELS: Readonly<Record<StatusCategory, { key: string; fallback: string }>> = {
  new: { key: 'status.category.new', fallback: 'New' },
  open: { key: 'status.category.open', fallback: 'Open' },
  pending_requester: { key: 'status.category.pendingRequester', fallback: 'Pending requester' },
  pending_third_party: {
    key: 'status.category.pendingThirdParty',
    fallback: 'Pending third party',
  },
  scheduled: { key: 'status.category.scheduled', fallback: 'Scheduled' },
  resolved: { key: 'status.category.resolved', fallback: 'Resolved' },
  closed: { key: 'status.category.closed', fallback: 'Closed' },
  cancelled: { key: 'status.category.cancelled', fallback: 'Cancelled' },
};

/**
 * Tailwind cannot see a class it has to concatenate at runtime, so every
 * mapping in this file is a literal table (the convention StatusPill documents).
 */
const RISK_CLASSES: Readonly<Record<ChangeRisk, string>> = {
  high: 'bg-sla-breach-bg text-sla-breach',
  medium: 'bg-sla-warn-bg text-sla-warn',
  low: 'bg-sla-ok-bg text-sla-ok',
};

const TYPE_CLASSES: Readonly<Record<ChangeType, string>> = {
  standard: 'bg-bg-tertiary text-text-muted',
  normal: 'bg-accent/12 text-accent',
  emergency: 'bg-priority-p1-bg text-priority-p1',
};

const OUTCOME_CLASSES: Readonly<Record<ChangeOutcome, string>> = {
  successful: 'bg-sla-ok-bg text-sla-ok',
  successful_with_issues: 'bg-sla-warn-bg text-sla-warn',
  failed: 'bg-sla-breach-bg text-sla-breach',
  rolled_back: 'bg-status-cancelled-bg text-status-cancelled',
};

/** The bar's own surface, by the worst live conflict on it. */
const BAR_CLASSES = {
  clear: 'bg-accent/15 text-accent hover:bg-accent/25',
  warn: 'bg-sla-warn-bg text-sla-warn hover:bg-sla-warn/25',
  blocked: 'bg-sla-breach-bg text-sla-breach hover:bg-sla-breach/25',
} as const;

type BarTone = keyof typeof BAR_CLASSES;

type SignalTone = 'accent' | 'warn' | 'breach' | 'muted';

const SORTS: ReadonlyArray<{
  value: NonNullable<ChangeListQuery['sort']>;
  key: string;
  fallback: string;
}> = [
  { value: 'planned_start_at', key: 'change.sort.plannedStart', fallback: 'Planned window' },
  { value: 'created_at', key: 'change.sort.created', fallback: 'Raised' },
  { value: 'risk', key: 'change.sort.risk', fallback: 'Risk' },
  { value: 'pir_due_at', key: 'change.sort.pirDue', fallback: 'Review due' },
];

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

function startOfDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

/**
 * The range a span covers, anchored on a day.
 *
 * `month` snaps to the calendar month rather than "thirty days from here",
 * because a change calendar is read against the month somebody's freeze policy
 * is written in ("the last week of December"), not against a rolling window.
 */
function rangeOf(anchor: Date, span: Span): { start: Date; end: Date; days: Date[] } {
  let start: Date;
  let end: Date;

  if (span === 'month') {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  } else {
    // Monday-first: an operations week is Monday to Sunday, and a change
    // calendar that splits the weekend across two screens hides the window most
    // maintenance actually runs in.
    const base = startOfDay(anchor);
    const weekday = (base.getDay() + 6) % 7;
    start = new Date(base.getFullYear(), base.getMonth(), base.getDate() - weekday);
    end = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + (span === 'week' ? 7 : 14),
    );
  }

  const days: Date[] = [];
  for (let cursor = new Date(start); cursor < end; cursor.setDate(cursor.getDate() + 1)) {
    days.push(new Date(cursor));
  }
  return { start, end, days };
}

function shiftAnchor(anchor: Date, span: Span, direction: -1 | 1): Date {
  if (span === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
  const step = span === 'week' ? 7 : 14;
  return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + direction * step);
}

/** Live conflicts, minus the freeze rows the freeze panel owns. */
function ciConflictsOf(change: ChangeWithRelations): ChangeConflictView[] {
  return (change.conflicts ?? []).filter((conflict) => conflict.kind !== 'freeze_window');
}

function hasFreeze(change: ChangeWithRelations): boolean {
  return (change.conflicts ?? []).some((conflict) => conflict.kind === 'freeze_window');
}

/**
 * The bar's tone.
 *
 * A `high` conflict is the one that will take a shared critical item down
 * twice; anything else is worth a colour but not an alarm. The freeze gets its
 * own mark rather than its own colour, because a freeze is OVERRIDDEN and a
 * conflict is ACKNOWLEDGED — two different doors, and one colour for both would
 * teach people they are the same thing.
 */
function toneOf(change: ChangeWithRelations): BarTone {
  const conflicts = ciConflictsOf(change);
  if (conflicts.some((conflict) => conflict.severity === 'high')) return 'blocked';
  if (conflicts.length > 0 || hasFreeze(change)) return 'warn';
  return 'clear';
}

/**
 * Where the change stands with its approvals, read off the SERVER'S OWN GATE.
 *
 * `scheduleGate` on the record is `evaluateChangeSchedule` as the server ran
 * it, so `change_approval_pending` and `change_approval_rejected` are the exact
 * codes that will refuse the move to `scheduled`. Counting approval rows here
 * instead would be a second opinion about a question the gate has already
 * answered — and the board would then disagree with the folder.
 *
 * `baselineSetAt` is stamped once, when the LAST selected approval is granted,
 * so it is the honest reading of "approved" and needs no row count either.
 */
function approvalStateOf(change: ChangeWithRelations): {
  tone: SignalTone;
  key: string;
  fallback: string;
} {
  const codes = new Set((change.scheduleGate?.blockers ?? []).map((blocker) => blocker.code));
  if (codes.has('change_approval_rejected')) {
    return { tone: 'breach', key: 'change.approval.rejected', fallback: 'Rejected' };
  }
  if (codes.has('change_approval_pending')) {
    return { tone: 'warn', key: 'change.approval.waiting', fallback: 'Waiting' };
  }
  if (change.baselineSetAt !== null) {
    return { tone: 'accent', key: 'change.approval.granted', fallback: 'Approved' };
  }
  if ((change.selectedApprovals?.length ?? 0) > 0) {
    return { tone: 'muted', key: 'change.approval.notAsked', fallback: 'Not asked yet' };
  }
  return { tone: 'muted', key: 'change.approval.none', fallback: 'None needed' };
}

// ═════════════════════════════════════════════════════════════════════════════
// Page
// ═════════════════════════════════════════════════════════════════════════════

export function ChangesPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentTenantId = useTenantStore((state) => state.currentTenantId);
  const hasCapability = useAuthStore((state) => state.hasCapability);
  const canWrite = hasCapability(CAPABILITIES.CHANGE_RW);

  const [tab, setTab] = useState<Tab>('calendar');
  const [denied, setDenied] = useState(false);
  const [creating, setCreating] = useState(false);

  // ── Filters, shared by both surfaces ──────────────────────────────────────
  const [search, setSearch] = useState('');
  const [types, setTypes] = useState<ChangeType[]>([]);
  const [risks, setRisks] = useState<ChangeRisk[]>([]);
  const [categories, setCategories] = useState<StatusCategory[]>([]);
  const [implementingOnly, setImplementingOnly] = useState(false);
  const [pirOnly, setPirOnly] = useState(false);
  const debouncedSearch = useDebounce(search, 300);

  // ── Calendar state ────────────────────────────────────────────────────────
  const [span, setSpan] = useState<Span>('fortnight');
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [scheduled, setScheduled] = useState<ChangeWithRelations[]>([]);
  const [loadingCalendar, setLoadingCalendar] = useState(true);

  // ── List state ────────────────────────────────────────────────────────────
  const [sort, setSort] = useState<NonNullable<ChangeListQuery['sort']>>('planned_start_at');
  const [rows, setRows] = useState<ChangeWithRelations[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const range = useMemo(() => rangeOf(anchor, span), [anchor, span]);

  const listQuery = useMemo<ChangeListQuery>(
    () => ({
      q: debouncedSearch.trim() || undefined,
      changeType: types.length > 0 ? types : undefined,
      risk: risks.length > 0 ? risks : undefined,
      statusCategory: categories.length > 0 ? categories : undefined,
      implementing: implementingOnly ? true : undefined,
      pirOutstanding: pirOnly ? true : undefined,
      sort,
      direction: sort === 'created_at' ? 'desc' : 'asc',
      limit: PAGE_SIZE,
    }),
    [debouncedSearch, types, risks, categories, implementingOnly, pirOnly, sort],
  );

  const loadCalendar = useCallback(async () => {
    setLoadingCalendar(true);
    try {
      const result = await changesApi.schedule({
        from: range.start.toISOString(),
        to: range.end.toISOString(),
      });
      setScheduled(result);
      setDenied(false);
    } catch (error) {
      setScheduled([]);
      if (error instanceof ApiError && error.isForbidden) setDenied(true);
      else {
        toast.error(
          errorMessage(error, t('change.calendarLoadFailed', 'The change calendar could not be loaded.')),
        );
      }
    } finally {
      setLoadingCalendar(false);
    }
  }, [range.start, range.end, t]);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const result = await changesApi.list({ ...listQuery, page: 1 });
      setRows(result.items);
      setTotal(result.total);
      setPage(1);
      setDenied(false);
    } catch (error) {
      // Reset the page counter with the list: "load more" from a stale page
      // number appends rows computed under the previous filters.
      setPage(1);
      setRows([]);
      setTotal(0);
      if (error instanceof ApiError && error.isForbidden) setDenied(true);
      else toast.error(errorMessage(error, t('change.loadFailed', 'The changes could not be loaded.')));
    } finally {
      setLoadingList(false);
    }
  }, [listQuery, t]);

  // Queues, policies and freeze calendars are entirely different per tenant, so
  // both surfaces key off the current one.
  useEffect(() => {
    void loadCalendar();
  }, [loadCalendar, currentTenantId]);

  useEffect(() => {
    void loadList();
  }, [loadList, currentTenantId]);

  async function loadMore(): Promise<void> {
    const next = page + 1;
    setLoadingMore(true);
    try {
      const result = await changesApi.list({ ...listQuery, page: next });
      setRows((current) => [...current, ...result.items]);
      setTotal(result.total);
      setPage(next);
    } catch (error) {
      toast.error(errorMessage(error, t('change.loadFailed', 'The changes could not be loaded.')));
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * The calendar's own filtering.
   *
   * `GET /changes/schedule` answers with the whole range on purpose (see the
   * header), so the chips are applied here. `q` is deliberately NOT applied to
   * the calendar: the server searches the plan bodies with a tsvector the
   * browser has no equivalent of, and a half-implemented local search that
   * silently misses rows is worse on a collision view than no search at all.
   */
  const visible = useMemo(() => {
    return scheduled.filter((change) => {
      if (types.length > 0 && !types.includes(change.changeType)) return false;
      if (risks.length > 0 && (change.risk === null || !risks.includes(change.risk))) return false;
      if (categories.length > 0) {
        const category = change.ticket?.statusCategory;
        if (!category || !categories.includes(category)) return false;
      }
      if (implementingOnly && !isImplementing(change)) return false;
      if (pirOnly && !(change.pirRequired && change.pirCompletedAt === null)) return false;
      return true;
    });
  }, [scheduled, types, risks, categories, implementingOnly, pirOnly]);

  const undated = useMemo(
    () => visible.filter((change) => plannedWindowOf(change) === null).length,
    [visible],
  );

  const hasFilters =
    types.length > 0 ||
    risks.length > 0 ||
    categories.length > 0 ||
    implementingOnly ||
    pirOnly ||
    search.trim() !== '';

  if (denied) {
    return (
      <div className="p-6">
        <p className="rounded-card bg-bg-secondary p-6 text-sm text-text-muted shadow-card">
          {t('common.forbidden', 'You do not have the rights for this page.')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-wide text-text-primary">
            <Replace size={22} className="text-accent" />
            {t('change.title', 'Changes')}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {t(
              'change.subtitle',
              'What is planned, what it will touch, who has to say yes, and what collided with it.',
            )}
          </p>
        </div>

        {canWrite && (
          <Button
            size="sm"
            variant="primary"
            icon={<Plus size={14} />}
            onClick={() => setCreating(true)}
            title={t(
              'change.newHint',
              'Raise a change with a subject and a type. The plans and the window come later.',
            )}
          >
            {t('change.new', 'New change')}
          </Button>
        )}
      </header>

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <div className="flex w-fit items-center gap-0.5 rounded-pill bg-bg-tertiary p-0.5">
        <TabButton
          active={tab === 'calendar'}
          onClick={() => setTab('calendar')}
          icon={<CalendarDays size={13} aria-hidden />}
        >
          {t('change.tab.calendar', 'Calendar')}
        </TabButton>
        <TabButton
          active={tab === 'list'}
          onClick={() => setTab('list')}
          icon={<Rows3 size={13} aria-hidden />}
        >
          {t('change.tab.list', 'All changes')}
          <TabCount value={total} active={tab === 'list'} />
        </TabButton>
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('change.searchPlaceholder', 'Search a change, a plan, a backout…')}
              aria-label={t('change.searchPlaceholder', 'Search a change, a plan, a backout…')}
              className="w-full rounded-md bg-bg-tertiary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          {tab === 'list' && (
            <label className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                {t('change.sortBy', 'Sort')}
              </span>
              <select
                value={sort}
                onChange={(event) =>
                  setSort(event.target.value as NonNullable<ChangeListQuery['sort']>)
                }
                className="rounded-pill bg-bg-tertiary px-3 py-1.5 text-[12px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent [&>option]:bg-bg-secondary [&>option]:text-text-primary"
              >
                {SORTS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {t(entry.key, entry.fallback)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {tab === 'calendar' && search.trim() !== '' && (
          <p className="text-[11px] leading-snug text-text-muted">
            {t(
              'change.searchListOnly',
              'The search runs against the plan bodies on the server, so it narrows the list rather than the calendar.',
            )}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <FilterLabel>{t('change.typeFilter', 'Type')}</FilterLabel>
          {CHANGE_TYPES.map((type) => (
            <FilterChip
              key={type}
              active={types.includes(type)}
              onClick={() => setTypes((current) => toggle(current, type))}
            >
              {t(CHANGE_TYPE_LABELS[type].key, CHANGE_TYPE_LABELS[type].fallback)}
            </FilterChip>
          ))}

          <span className="mx-1 h-4 w-px bg-border" aria-hidden />

          <FilterLabel>{t('change.riskFilter', 'Risk')}</FilterLabel>
          {CHANGE_RISKS.map((risk) => (
            <FilterChip
              key={risk}
              active={risks.includes(risk)}
              onClick={() => setRisks((current) => toggle(current, risk))}
            >
              {t(CHANGE_RISK_LABELS[risk].key, CHANGE_RISK_LABELS[risk].fallback)}
            </FilterChip>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <FilterLabel>{t('change.stateFilter', 'State')}</FilterLabel>
          {BOARD_CATEGORIES.map((category) => (
            <FilterChip
              key={category}
              active={categories.includes(category)}
              onClick={() => setCategories((current) => toggle(current, category))}
            >
              {t(CATEGORY_LABELS[category].key, CATEGORY_LABELS[category].fallback)}
            </FilterChip>
          ))}

          <span className="mx-1 h-4 w-px bg-border" aria-hidden />

          <FilterChip
            active={implementingOnly}
            onClick={() => setImplementingOnly((value) => !value)}
          >
            {t('change.implementingOnly', 'Running now')}
          </FilterChip>
          <FilterChip active={pirOnly} onClick={() => setPirOnly((value) => !value)}>
            {t('change.pirOutstandingOnly', 'Review outstanding')}
          </FilterChip>

          {hasFilters && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setTypes([]);
                setRisks([]);
                setCategories([]);
                setImplementingOnly(false);
                setPirOnly(false);
              }}
              className="inline-flex items-center gap-1 rounded-pill px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
            >
              <X size={11} aria-hidden />
              {t('change.clearFilters', 'Clear everything')}
            </button>
          )}
        </div>
      </div>

      {tab === 'calendar' ? (
        <ChangeCalendar
          changes={visible}
          loading={loadingCalendar}
          span={span}
          onSpan={setSpan}
          range={range}
          undated={undated}
          onPrevious={() => setAnchor((current) => shiftAnchor(current, span, -1))}
          onNext={() => setAnchor((current) => shiftAnchor(current, span, 1))}
          onToday={() => setAnchor(new Date())}
          onOpen={(ticketId) => navigate(`/changes/${ticketId}`)}
          onShowUndated={() => {
            setTab('list');
            setSort('created_at');
          }}
        />
      ) : (
        <>
          <ChangeTable
            items={rows}
            loading={loadingList}
            onOpen={(ticketId) => navigate(`/changes/${ticketId}`)}
          />

          {!loadingList && rows.length > 0 && (
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span className="font-mono">
                {t('change.shownCount', '{{shown}} of {{total}} changes', {
                  shown: rows.length,
                  total,
                })}
              </span>
              {rows.length < total && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {t('change.loadMore', 'Load more')}
                </Button>
              )}
            </div>
          )}
        </>
      )}

      <NewChangeModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(ticketId) => {
          setCreating(false);
          navigate(`/changes/${ticketId}`);
        }}
      />
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The calendar
// ═════════════════════════════════════════════════════════════════════════════

/** One change, placed. Everything geometric is computed once, per render. */
interface Bar {
  change: ChangeWithRelations;
  ticketId: number;
  lane: number;
  /** Percentages across the whole range, already clipped to it. */
  left: number;
  width: number;
  tone: BarTone;
  freeze: boolean;
  live: boolean;
  /** Overlap segments of the live conflicts, in the same percentage space. */
  overlaps: Array<{ left: number; width: number }>;
  /** Counterpart ticket ids, for the "because of that one" highlight. */
  neighbours: number[];
}

const SPANS: ReadonlyArray<{ value: Span; key: string; fallback: string }> = [
  { value: 'week', key: 'change.span.week', fallback: 'Week' },
  { value: 'fortnight', key: 'change.span.fortnight', fallback: 'Two weeks' },
  { value: 'month', key: 'change.span.month', fallback: 'Month' },
];

function ChangeCalendar({
  changes,
  loading,
  span,
  onSpan,
  range,
  undated,
  onPrevious,
  onNext,
  onToday,
  onOpen,
  onShowUndated,
}: {
  changes: ChangeWithRelations[];
  loading: boolean;
  span: Span;
  onSpan: (next: Span) => void;
  range: { start: Date; end: Date; days: Date[] };
  undated: number;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onOpen: (ticketId: number) => void;
  onShowUndated: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [focused, setFocused] = useState<number | null>(null);

  const rangeStart = range.start.getTime();
  const rangeEnd = range.end.getTime();
  const rangeMs = Math.max(1, rangeEnd - rangeStart);

  /** A percentage position for an instant, clipped to the drawn range. */
  const pctOf = useCallback(
    (ms: number): number => ((Math.min(Math.max(ms, rangeStart), rangeEnd) - rangeStart) / rangeMs) * 100,
    [rangeStart, rangeEnd, rangeMs],
  );

  const bars = useMemo<Bar[]>(() => {
    const placed: Array<{ bar: Bar; endMs: number }> = [];
    // Lane packing is greedy first-fit over changes sorted by start. It is the
    // arrangement a reader expects (earliest work at the top) and it keeps two
    // overlapping windows on two lines, which is the entire point of the view.
    const withWindows = changes
      .map((change) => ({ change, window: plannedWindowOf(change) }))
      .filter(
        (entry): entry is { change: ChangeWithRelations; window: { startAt: string; endAt: string } } =>
          entry.window !== null,
      )
      .map((entry) => ({
        ...entry,
        startMs: Date.parse(entry.window.startAt),
        endMs: Date.parse(entry.window.endAt),
      }))
      .filter((entry) => Number.isFinite(entry.startMs) && Number.isFinite(entry.endMs))
      .sort((a, b) => a.startMs - b.startMs);

    const laneEnds: number[] = [];

    for (const entry of withWindows) {
      let lane = laneEnds.findIndex((end) => end <= entry.startMs);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(entry.endMs);
      } else {
        laneEnds[lane] = entry.endMs;
      }

      const left = pctOf(entry.startMs);
      // A five-minute change would otherwise be an invisible hairline. 0.5% of
      // a fortnight is about two hours of screen: enough to click, honest
      // enough that nobody reads it as a duration.
      const width = Math.max(0.5, pctOf(entry.endMs) - left);

      const conflicts = ciConflictsOf(entry.change);
      const overlaps = conflicts
        .map((conflict) => {
          const from = conflict.overlapStartAt ? Date.parse(conflict.overlapStartAt) : NaN;
          const to = conflict.overlapEndAt ? Date.parse(conflict.overlapEndAt) : NaN;
          if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
          const overlapLeft = pctOf(from);
          const overlapWidth = Math.max(0.3, pctOf(to) - overlapLeft);
          // Re-expressed relative to the bar, because the marker is drawn
          // INSIDE it and a percentage of the range means nothing there.
          return {
            left: ((overlapLeft - left) / width) * 100,
            width: (overlapWidth / width) * 100,
          };
        })
        .filter((segment): segment is { left: number; width: number } => segment !== null);

      placed.push({
        endMs: entry.endMs,
        bar: {
          change: entry.change,
          ticketId: entry.change.ticketId,
          lane,
          left,
          width,
          tone: toneOf(entry.change),
          freeze: hasFreeze(entry.change),
          live: isImplementing(entry.change),
          overlaps,
          neighbours: conflicts
            .map((conflict) => conflict.otherTicketId)
            .filter((id): id is number => typeof id === 'number'),
        },
      });
    }

    return placed.map((entry) => entry.bar);
  }, [changes, pctOf]);

  const laneCount = bars.reduce((max, bar) => Math.max(max, bar.lane + 1), 0);
  const nowMs = Date.now();
  const nowVisible = nowMs >= rangeStart && nowMs < rangeEnd;

  /** The set kept bright while a bar is hovered: itself and its counterparts. */
  const related = useMemo<Set<number> | null>(() => {
    if (focused === null) return null;
    const bar = bars.find((entry) => entry.ticketId === focused);
    if (!bar) return null;
    const set = new Set<number>([focused, ...bar.neighbours]);
    // Conflicts are symmetric but the cache is written per owner, so a
    // counterpart that lists US is related even when we do not list it.
    for (const other of bars) {
      if (other.neighbours.includes(focused)) set.add(other.ticketId);
    }
    return set;
  }, [focused, bars]);

  const label = useMemo(() => {
    const first = range.days[0];
    const last = range.days[range.days.length - 1];
    if (!first || !last) return '';
    return span === 'month'
      ? first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : `${first.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })} → ${last.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}`;
  }, [range.days, span]);

  return (
    <section className="space-y-3">
      {/* ── Range control ────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-pill bg-bg-tertiary p-0.5">
          <IconStep
            icon={<ChevronLeft size={15} />}
            label={t('change.calendarPrevious', 'Earlier')}
            onClick={onPrevious}
          />
          <button
            type="button"
            onClick={onToday}
            className="rounded-pill px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            {t('change.calendarToday', 'Today')}
          </button>
          <IconStep
            icon={<ChevronRight size={15} />}
            label={t('change.calendarNext', 'Later')}
            onClick={onNext}
          />
        </div>

        <span className="font-display text-[15px] font-semibold tracking-wide text-text-primary">
          {label}
        </span>

        <span className="flex-1" />

        <div className="flex items-center gap-0.5 rounded-pill bg-bg-tertiary p-0.5">
          {SPANS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              onClick={() => onSpan(entry.value)}
              aria-pressed={span === entry.value}
              className={clsx(
                'rounded-pill px-2.5 py-1 text-[11px] transition-colors',
                span === entry.value
                  ? 'bg-bg-active font-medium text-text-primary'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-secondary',
              )}
            >
              {t(entry.key, entry.fallback)}
            </button>
          ))}
        </div>
      </div>

      {/* ── The timeline ─────────────────────────────────────────────────── */}
      <div className="overflow-x-auto rounded-card bg-bg-secondary p-3 shadow-card">
        <div style={{ minWidth: `${Math.max(640, range.days.length * 96)}px` }}>
          {/* Day header */}
          <div className="flex">
            {range.days.map((day) => {
              const weekend = day.getDay() === 0 || day.getDay() === 6;
              const today = startOfDay(new Date()).getTime() === day.getTime();
              return (
                <div
                  key={day.toISOString()}
                  className={clsx(
                    'flex-1 rounded-t-card px-1 py-1.5 text-center',
                    weekend && 'bg-bg-tertiary/60',
                  )}
                >
                  <p
                    className={clsx(
                      'font-mono text-[9px] uppercase tracking-[0.14em]',
                      today ? 'text-accent' : 'text-text-muted',
                    )}
                  >
                    {day.toLocaleDateString(undefined, { weekday: 'short' })}
                  </p>
                  <p
                    className={clsx(
                      'font-mono text-[12px]',
                      today ? 'font-semibold text-accent' : 'text-text-secondary',
                    )}
                  >
                    {day.getDate()}
                  </p>
                </div>
              );
            })}
          </div>

          {/* Lanes */}
          {/* Three lanes' worth of height is the floor, so the loading spinner
              and the "nothing planned" line have somewhere to sit instead of
              collapsing the grid to a stripe. */}
          <div
            className="relative mt-1"
            style={{ height: `${Math.max(3, laneCount) * 34 + 8}px` }}
            onMouseLeave={() => setFocused(null)}
          >
            {/* Day columns, as background only. */}
            <div className="absolute inset-0 flex" aria-hidden>
              {range.days.map((day) => {
                const weekend = day.getDay() === 0 || day.getDay() === 6;
                return (
                  <div
                    key={day.toISOString()}
                    className={clsx('flex-1', weekend ? 'bg-bg-tertiary/40' : 'bg-bg-tertiary/15')}
                  />
                );
              })}
            </div>

            {nowVisible && (
              <span
                className="absolute top-0 bottom-0 w-px bg-accent"
                style={{ left: `${pctOf(nowMs)}%` }}
                aria-hidden
              />
            )}

            {loading ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <LoadingSpinner label={t('common.loading', 'Loading…')} />
              </div>
            ) : bars.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-[12px] text-text-muted">
                  {t('change.calendarEmpty', 'No change is planned in this window.')}
                </p>
              </div>
            ) : (
              bars.map((bar) => {
                const dimmed = related !== null && !related.has(bar.ticketId);
                return (
                  <button
                    key={bar.ticketId}
                    type="button"
                    onClick={() => onOpen(bar.ticketId)}
                    onMouseEnter={() => setFocused(bar.ticketId)}
                    onFocus={() => setFocused(bar.ticketId)}
                    onBlur={() => setFocused(null)}
                    title={barTitle(bar, t)}
                    className={clsx(
                      'absolute flex h-[28px] items-center gap-1 overflow-hidden rounded-pill px-2 text-left transition-all',
                      BAR_CLASSES[bar.tone],
                      dimmed && 'opacity-30',
                    )}
                    style={{
                      left: `${bar.left}%`,
                      width: `${bar.width}%`,
                      top: `${bar.lane * 34 + 4}px`,
                    }}
                  >
                    {/* The overlap segments, painted inside the bar. */}
                    {bar.overlaps.map((segment, index) => (
                      <span
                        key={`${bar.ticketId}-${index}`}
                        aria-hidden
                        className="pointer-events-none absolute inset-y-0 bg-sla-breach/25"
                        style={{
                          left: `${Math.max(0, segment.left)}%`,
                          width: `${Math.min(100, segment.width)}%`,
                        }}
                      />
                    ))}

                    {bar.live && (
                      <Activity size={11} className="relative shrink-0" aria-hidden />
                    )}
                    {bar.freeze && (
                      <Snowflake size={11} className="relative shrink-0" aria-hidden />
                    )}
                    {bar.tone === 'blocked' && (
                      <AlertCircle size={11} className="relative shrink-0" aria-hidden />
                    )}
                    <span className="relative truncate font-mono text-[10px]">
                      {bar.change.ticket?.number ?? `#${bar.ticketId}`}
                    </span>
                    <span className="relative truncate text-[11px] text-text-primary">
                      {bar.change.ticket?.subject ?? ''}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* ── Legend and the honest footnote ───────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-text-muted">
        <LegendKey className="bg-accent/25">{t('change.legend.clear', 'No conflict')}</LegendKey>
        <LegendKey className="bg-sla-warn-bg">
          {t('change.legend.warn', 'Overlap or freeze to read')}
        </LegendKey>
        <LegendKey className="bg-sla-breach-bg">
          {t('change.legend.blocked', 'Overlap on a critical item')}
        </LegendKey>
        <span className="inline-flex items-center gap-1">
          <Activity size={11} aria-hidden />
          {t('change.legend.live', 'Running now')}
        </span>
        <span className="inline-flex items-center gap-1">
          <Snowflake size={11} aria-hidden />
          {t('change.legend.freeze', 'Inside a freeze')}
        </span>
      </div>

      <p className="text-[11px] leading-snug text-text-muted">
        {t(
          'change.calendarNote',
          'Overlaps are detected on items linked as primary or affected. Dependencies between items are not detected: this desk has no relationship graph, and a conflict raised on a guess is a panel people stop reading.',
        )}
      </p>

      {undated > 0 && (
        <button
          type="button"
          onClick={onShowUndated}
          className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-accent"
        >
          <ClipboardCheck size={12} aria-hidden />
          {t('change.undatedCount', '{{count}} changes in this range have no window yet', {
            count: undated,
          })}
        </button>
      )}
    </section>
  );
}

/** The bar's tooltip: the window, the state, and what it collides with. */
function barTitle(
  bar: Bar,
  t: (key: string, fallback: string, opts?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  const header = bar.change.ticket;
  parts.push(`${header?.number ?? `#${bar.ticketId}`} — ${header?.subject ?? ''}`.trim());
  parts.push(
    `${formatDateTime(bar.change.plannedStartAt)} → ${formatDateTime(bar.change.plannedEndAt)}`,
  );
  for (const conflict of bar.change.conflicts ?? []) {
    parts.push(
      t(
        CHANGE_CONFLICT_KIND_LABELS[conflict.kind].key,
        CHANGE_CONFLICT_KIND_LABELS[conflict.kind].fallback,
      ),
    );
  }
  return parts.filter((part) => part.length > 0).join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// The list
// ═════════════════════════════════════════════════════════════════════════════

function ChangeTable({
  items,
  loading,
  onOpen,
}: {
  items: ChangeWithRelations[];
  loading: boolean;
  onOpen: (ticketId: number) => void;
}): JSX.Element {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="flex justify-center rounded-card bg-bg-secondary py-16 shadow-card">
        <LoadingSpinner label={t('common.loading', 'Loading…')} />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Replace size={24} />}
        title={t('change.emptyTitle', 'No change here')}
        description={t(
          'change.emptyBody',
          'A change is raised with a subject and a type. Its plans, its window and its approvals are collected before it is scheduled, never at creation.',
        )}
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-card bg-bg-secondary shadow-card">
      <table className="w-full min-w-[72rem] text-left">
        <thead>
          <tr className="border-b border-border">
            <Th className="w-28">{t('change.col.number', 'Number')}</Th>
            <Th>{t('change.col.subject', 'Change')}</Th>
            <Th className="w-32">{t('change.col.state', 'State')}</Th>
            <Th className="w-28">{t('change.col.type', 'Type')}</Th>
            <Th className="w-28">{t('change.col.risk', 'Risk')}</Th>
            <Th className="w-52">{t('change.col.window', 'Planned window')}</Th>
            <Th className="w-36">{t('change.col.approval', 'Approval')}</Th>
            <Th className="w-40">{t('change.col.signals', 'Signals')}</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((change) => {
            const header = change.ticket;
            const conflicts = ciConflictsOf(change);
            const worst = conflicts.some((conflict) => conflict.severity === 'high');
            const approval = approvalStateOf(change);

            return (
              <tr
                key={change.ticketId}
                onClick={() => onOpen(change.ticketId)}
                tabIndex={0}
                role="button"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen(change.ticketId);
                  }
                }}
                className="cursor-pointer border-b border-border/40 transition-colors last:border-0 hover:bg-bg-hover focus:bg-bg-hover focus:outline-none"
              >
                <Td>
                  <span className="font-mono text-[12px] text-text-muted">
                    {header?.number ?? `#${change.ticketId}`}
                  </span>
                </Td>
                <Td>
                  <div className="flex min-w-0 items-center gap-2">
                    {change.major && (
                      <span
                        className="inline-flex shrink-0 items-center rounded-pill bg-priority-p1-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-priority-p1"
                        title={t('change.majorHint', 'Major change: it always owes a review.')}
                      >
                        {t('change.majorShort', 'Major')}
                      </span>
                    )}
                    <span className="truncate text-[13px] text-text-primary">
                      {header?.subject ?? t('change.untitled', 'Change without a subject')}
                    </span>
                  </div>
                  {change.outcome !== null && (
                    <span
                      className={clsx(
                        'mt-0.5 inline-flex rounded-pill px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em]',
                        OUTCOME_CLASSES[change.outcome],
                      )}
                    >
                      {t(
                        CHANGE_OUTCOME_LABELS[change.outcome].key,
                        CHANGE_OUTCOME_LABELS[change.outcome].fallback,
                      )}
                    </span>
                  )}
                </Td>
                <Td>
                  {header ? (
                    <StatusPill
                      statusSlug={header.statusSlug}
                      category={header.statusCategory}
                      size="sm"
                    />
                  ) : null}
                </Td>
                <Td>
                  <span
                    className={clsx(
                      'inline-flex rounded-pill px-2 py-0.5 text-[11px]',
                      TYPE_CLASSES[change.changeType],
                    )}
                  >
                    {t(
                      CHANGE_TYPE_LABELS[change.changeType].key,
                      CHANGE_TYPE_LABELS[change.changeType].fallback,
                    )}
                  </span>
                </Td>
                <Td>
                  {change.risk ? (
                    <span
                      className={clsx(
                        'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px]',
                        RISK_CLASSES[change.risk],
                      )}
                      title={
                        change.riskOverriddenAt
                          ? t('change.riskOverriddenHint', 'A human overrode the matrix here.')
                          : undefined
                      }
                    >
                      {t(CHANGE_RISK_LABELS[change.risk].key, CHANGE_RISK_LABELS[change.risk].fallback)}
                      {change.riskOverriddenAt && <span aria-hidden>*</span>}
                    </span>
                  ) : (
                    <span className="text-[11px] text-text-muted">
                      {t('change.riskUnrated', 'Not rated')}
                    </span>
                  )}
                </Td>
                <Td>
                  {change.plannedStartAt ? (
                    <span
                      className="font-mono text-[11px] text-text-secondary"
                      title={`${formatAbsolute(change.plannedStartAt)} → ${formatAbsolute(change.plannedEndAt)}`}
                    >
                      {formatDateTime(change.plannedStartAt)}
                    </span>
                  ) : (
                    <span className="text-[11px] text-text-muted">
                      {t('change.noWindow', 'No window yet')}
                    </span>
                  )}
                </Td>
                <Td>
                  <Signal tone={approval.tone}>{t(approval.key, approval.fallback)}</Signal>
                </Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-1">
                    {isImplementing(change) && (
                      <Signal tone="accent" icon={<Activity size={10} aria-hidden />}>
                        {t('change.signal.live', 'Running')}
                      </Signal>
                    )}
                    {conflicts.length > 0 && (
                      <Signal
                        tone={worst ? 'breach' : 'warn'}
                        icon={<AlertCircle size={10} aria-hidden />}
                      >
                        {String(conflicts.length)}
                      </Signal>
                    )}
                    {hasFreeze(change) && (
                      <Signal tone="warn" icon={<Snowflake size={10} aria-hidden />}>
                        {t('change.signal.freeze', 'Freeze')}
                      </Signal>
                    )}
                    {change.pirRequired && change.pirCompletedAt === null && (
                      <Signal tone="warn" icon={<ClipboardCheck size={10} aria-hidden />}>
                        {t('change.signal.pir', 'Review')}
                      </Signal>
                    )}
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Small local pieces
// ═════════════════════════════════════════════════════════════════════════════

const SIGNAL_CLASSES: Readonly<Record<SignalTone, string>> = {
  accent: 'bg-accent/12 text-accent',
  warn: 'bg-sla-warn-bg text-sla-warn',
  breach: 'bg-sla-breach-bg text-sla-breach',
  muted: 'bg-bg-tertiary text-text-muted',
};

function Signal({
  tone,
  icon,
  children,
}: {
  tone: SignalTone;
  icon?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-pill px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]',
        SIGNAL_CLASSES[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}

function LegendKey({ className, children }: { className: string; children: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx('h-2.5 w-4 rounded-pill', className)} aria-hidden />
      {children}
    </span>
  );
}

function IconStep({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex h-6 w-6 items-center justify-center rounded-pill text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
    >
      {icon}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-[12px] transition-colors',
        active
          ? 'bg-bg-active font-medium text-text-primary'
          : 'text-text-muted hover:bg-bg-hover hover:text-text-secondary',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function TabCount({ value, active }: { value: number; active: boolean }): JSX.Element | null {
  if (value <= 0) return null;
  return (
    <span
      className={clsx(
        'rounded-pill px-1.5 py-px font-mono text-[10px]',
        active ? 'bg-bg-tertiary text-text-secondary' : 'bg-bg-hover text-text-muted',
      )}
    >
      {value}
    </span>
  );
}

function FilterLabel({ children }: { children: string }): JSX.Element {
  return (
    <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
      {children}
    </span>
  );
}

/** HARD RULE 11 — a chip is a tinted background, never an outline. */
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'rounded-pill px-2.5 py-1 text-[11px] transition-colors',
        active
          ? 'bg-accent/12 text-accent'
          : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover hover:text-text-secondary',
      )}
    >
      {children}
    </button>
  );
}

/** The table rules are the one place a hairline border is the right answer. */
function Th({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <th
      scope="col"
      className={clsx(
        'px-3 py-2 font-mono text-[10px] font-normal uppercase tracking-[0.12em] text-text-muted',
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <td className={clsx('px-3 py-2.5 align-middle', className)}>{children}</td>;
}

// ═════════════════════════════════════════════════════════════════════════════
// The creation modal
//
// It lives with the board rather than with the folder, and that is a chunking
// decision as much as an ownership one: the board owns the "New change" button,
// and importing the modal from `ChangeDetailPage` would make opening the
// calendar download the whole folder — the four gate evaluators, the conflict
// panel, the review — for a dialog with five fields in it.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A THIN change: a subject, a type, and optionally a model.
 *
 * THE TRAP THIS AVOIDS, stated plainly: a creation form that also asks for the
 * plans and the window posts empty strings the schema refuses, and the module
 * dies at its front door. A change is raised as a one-line idea and fleshed out
 * over a week; HARD RULE 12 says completeness belongs to the transition. The
 * subject is the ONE thing required here, and it is required because it is the
 * TICKET's subject and a ticket cannot exist without one — not because the
 * change record wants it.
 */
export function NewChangeModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (ticketId: number) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [subject, setSubject] = useState('');
  const [changeType, setChangeType] = useState<ChangeType>('normal');
  const [modelSlug, setModelSlug] = useState('');
  const [queueSlug, setQueueSlug] = useState('');
  const [prioritySlug, setPrioritySlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<ChangeModelSummary[]>([]);
  const [options, setOptions] = useState<TicketFieldOptions | null>(null);

  useEffect(() => {
    if (!open) return;
    setSubject('');
    setChangeType('normal');
    setModelSlug('');
    setQueueSlug('');
    setPrioritySlug('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void changesApi
      .listModels()
      .catch(() => [])
      .then((loaded) => {
        if (alive) setModels(loaded.filter((model) => model.body.isActive));
      });
    void loadTicketFieldOptions().then((loaded) => {
      if (alive) setOptions(loaded);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  const model = models.find((entry) => entry.slug === modelSlug) ?? null;

  async function submit(): Promise<void> {
    if (subject.trim() === '') return;
    setBusy(true);
    try {
      // The ticket half is NESTED. Both create schemas are `.strict()` and take
      // exactly one of `ticketId` or `ticket`, so a flat body was refused on
      // every click — the create form never worked once.
      //
      // `changeType` is sent only on the plain path: a model carries its own,
      // and letting the caller override it would let a "standard, pre-approved"
      // template be raised as an emergency by whoever wrote the request.
      const ticket = {
        subject: subject.trim(),
        queueSlug: queueSlug || null,
        prioritySlug: prioritySlug || null,
      };
      const created = model
        ? await changesApi.createFromModel({ modelSlug: model.slug, ticket })
        : await changesApi.create({ ticket, changeType });
      toast.success(t('change.created', 'Change raised. Add the plans and the window next.'));
      onCreated(created.ticketId);
    } catch (error) {
      toast.error(errorMessage(error, t('change.createFailed', 'The change could not be raised.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('change.newTitle', 'Raise a change')}
      subtitle={t(
        'change.newSubtitle',
        'A subject and a type are enough. The plans, the window, the items and the approvals are collected before it is scheduled, not now.',
      )}
      closeLabel={t('common.close', 'Close')}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={subject.trim() === ''}
            title={
              subject.trim() === ''
                ? t('change.needsSubject', 'A ticket needs a subject. Nothing else is required yet.')
                : undefined
            }
            onClick={() => void submit()}
          >
            {t('change.createConfirm', 'Raise the change')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('change.field.subject', 'Subject')}>
          <input
            type="text"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder={t('change.field.subjectPlaceholder', 'Move the DNS forwarders to the new pair')}
            className="w-full rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </Field>

        <Field
          label={t('change.field.model', 'Model')}
          hint={t(
            'change.field.modelHint',
            'A model copies its plans into the change. A standard change must have one: pre-approval only means anything when the plan is the one that was pre-approved.',
          )}
        >
          <select
            value={modelSlug}
            onChange={(event) => setModelSlug(event.target.value)}
            className="w-full rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent [&>option]:bg-bg-secondary [&>option]:text-text-primary"
          >
            <option value="">{t('change.field.modelNone', 'No model')}</option>
            {models.map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.name}
              </option>
            ))}
          </select>
        </Field>

        {model ? (
          <p className="rounded-card bg-bg-tertiary px-3 py-2 text-[12px] leading-snug text-text-muted">
            {t(
              'change.modelDecidesType',
              'The model decides the type ({{type}}) and brings its own plans.',
              {
                type: t(
                  CHANGE_TYPE_LABELS[model.body.changeType].key,
                  CHANGE_TYPE_LABELS[model.body.changeType].fallback,
                ),
              },
            )}
          </p>
        ) : (
          <Field label={t('change.field.type', 'Type')}>
            <div className="flex flex-wrap gap-1.5">
              {CHANGE_TYPES.map((entry) => (
                <Choice
                  key={entry}
                  active={changeType === entry}
                  onClick={() => setChangeType(entry)}
                >
                  {t(CHANGE_TYPE_LABELS[entry].key, CHANGE_TYPE_LABELS[entry].fallback)}
                </Choice>
              ))}
            </div>
          </Field>
        )}

        {changeType === 'emergency' && !model && (
          <p className="flex items-start gap-1.5 rounded-card bg-sla-warn-bg px-2.5 py-1.5 text-[11px] leading-snug text-sla-warn">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
            {t(
              'change.emergencyNotice',
              'An emergency change always owes a review. That is enforced in the database and cannot be cleared by any rule or configuration.',
            )}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('change.field.queue', 'Queue')}>
            <SlugSelect
              value={queueSlug}
              onChange={setQueueSlug}
              options={options?.queues ?? []}
              placeholder={t('change.field.queueDefault', 'Let the routing decide')}
            />
          </Field>
          <Field label={t('change.field.priority', 'Priority')}>
            <SlugSelect
              value={prioritySlug}
              onChange={setPrioritySlug}
              options={options?.priorities ?? []}
              placeholder={t('change.field.priorityDefault', 'Let the matrix decide')}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}


function Choice({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'rounded-pill px-2.5 py-1 text-[11px] transition-colors',
        active
          ? 'bg-accent/12 text-accent'
          : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover hover:text-text-secondary',
      )}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
        {label}
      </span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-text-muted">{hint}</span>}
    </label>
  );
}

function SlugSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder: string;
}): JSX.Element {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent [&>option]:bg-bg-secondary [&>option]:text-text-primary"
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export default ChangesPage;
