/**
 * ProblemsPage — `/problems`
 *
 * Two surfaces, one screen, because they answer the same question from
 * opposite ends: "what keeps hurting us?"
 *
 *   • The BOARD is the record. Problems a human opened, with their known-error
 *     state, how many incidents hang off them and when the last one landed.
 *
 *   • The INBOX is the detector's proposal queue. It is the surface that has to
 *     earn its keep at a glance, so a card states, in this order: how strongly
 *     it scored, WHICH signals fired and by how much, and which incidents are
 *     underneath. Then two actions and nothing else. A recurrence card that
 *     needs three clicks before it says anything is a card people reject
 *     without reading, and a detector nobody reads is worse than no detector.
 *
 * ── Why the signal breakdown is rendered from the stored reading ─────────────
 * `ProblemSignalReading` carries `weight` and `saturation` as they stood at the
 * pass that raised the card, so the bar shows what actually carried it, not
 * what today's config would produce. The detector body may well have been
 * edited since; recomputing against the current one would quietly rewrite
 * history on a card somebody is about to accept or refuse.
 *
 * ── Why there is no "new problem" button ────────────────────────────────────
 * A problem is born from an incident (promotion, on the incident's own page) or
 * from a detected candidate (accept, here). A blank problem with no incident
 * under it has nothing to analyse and no rollups to compute, and every desk
 * that offers one ends up with a backlog of empty shells.
 *
 * HARD RULE 11 — no border anywhere below. Depth is the background step plus
 * `shadow-card`; a chip is a tinted background and hover swaps that background.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import {
  Activity,
  AlertTriangle,
  CircleSlash,
  Flame,
  Inbox,
  Play,
  Search,
  Siren,
  ThumbsDown,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  CAPABILITIES,
  KNOWN_ERROR_STATES,
  KNOWN_ERROR_STATE_LABELS,
  PROBLEM_CANDIDATE_STATE_LABELS,
  PROBLEM_DETECTED_BY_LABELS,
  PROBLEM_SIGNAL_LABELS,
  WORKAROUND_RISK_LABELS,
} from '@oblidesk/shared';
import type {
  KnownErrorState,
  ProblemCandidateState,
  ProblemCandidateWithTickets,
  ProblemDetectionSignal,
  ProblemListQuery,
  ProblemSignalReading,
  ProblemWithRelations,
  StatusCategory,
  WorkaroundRisk,
} from '@oblidesk/shared';
import { ApiError, errorMessage } from '@/api/client';
import problemsApi from '@/api/problems.api';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import StatusPill from '@/components/tickets/StatusPill';
import { formatAbsolute, formatRelative } from '@/components/tickets/SlaChip';
import {
  loadTicketFieldOptions,
  type TicketFieldOptions,
} from '@/components/tickets/BulkActionBar';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useDebounce } from '@/hooks/useDebounce';
import { formatDate } from '@/utils/format';

const PAGE_SIZE = 25;

type Tab = 'board' | 'candidates';

/** Board sort columns the route accepts. Anything else is a 400. */
const SORTS: ReadonlyArray<{ value: NonNullable<ProblemListQuery['sort']>; key: string; fallback: string }> = [
  { value: 'last_incident_at', key: 'problem.sort.lastIncident', fallback: 'Last incident' },
  { value: 'incident_count', key: 'problem.sort.incidentCount', fallback: 'Incident count' },
  { value: 'created_at', key: 'problem.sort.created', fallback: 'Opened' },
  { value: 'major_review_due_at', key: 'problem.sort.majorReview', fallback: 'Major review due' },
];

/** The status categories worth a chip on a problem board. */
const BOARD_CATEGORIES: readonly StatusCategory[] = ['new', 'open', 'scheduled', 'resolved', 'closed'];

const CATEGORY_LABELS: Readonly<Record<StatusCategory, { key: string; fallback: string }>> = {
  new: { key: 'status.category.new', fallback: 'New' },
  open: { key: 'status.category.open', fallback: 'Open' },
  pending_requester: { key: 'status.category.pendingRequester', fallback: 'Pending requester' },
  pending_third_party: { key: 'status.category.pendingThirdParty', fallback: 'Pending third party' },
  scheduled: { key: 'status.category.scheduled', fallback: 'Scheduled' },
  resolved: { key: 'status.category.resolved', fallback: 'Resolved' },
  closed: { key: 'status.category.closed', fallback: 'Closed' },
  cancelled: { key: 'status.category.cancelled', fallback: 'Cancelled' },
};

/**
 * Tailwind cannot see a class it has to concatenate at runtime, so every
 * mapping in this file is a literal table (the convention StatusPill documents).
 */
const KNOWN_ERROR_CLASSES: Readonly<Record<KnownErrorState, string>> = {
  none: 'bg-bg-tertiary text-text-muted',
  candidate: 'bg-status-scheduled-bg text-status-scheduled',
  published: 'bg-sla-ok-bg text-sla-ok',
  retired: 'bg-status-closed-bg text-status-closed',
};

const RISK_CLASSES: Readonly<Record<WorkaroundRisk, string>> = {
  low: 'bg-sla-ok-bg text-sla-ok',
  medium: 'bg-sla-warn-bg text-sla-warn',
  high: 'bg-sla-breach-bg text-sla-breach',
};

const CANDIDATE_STATE_CLASSES: Readonly<Record<ProblemCandidateState, string>> = {
  proposed: 'bg-accent/12 text-accent',
  accepted: 'bg-sla-ok-bg text-sla-ok',
  rejected: 'bg-status-cancelled-bg text-status-cancelled',
  expired: 'bg-bg-tertiary text-text-muted',
  merged: 'bg-status-closed-bg text-status-closed',
};

/** A card at 0.90 and a card at 0.61 must not look alike from across the room. */
function scoreTone(score: number): { text: string; stroke: string; fill: string } {
  if (score >= 0.8) return { text: 'text-sla-breach', stroke: 'text-sla-breach', fill: 'bg-sla-breach' };
  if (score >= 0.65) return { text: 'text-sla-warn', stroke: 'text-sla-warn', fill: 'bg-sla-warn' };
  return { text: 'text-accent', stroke: 'text-accent', fill: 'bg-accent' };
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

// ═════════════════════════════════════════════════════════════════════════════
// Page
// ═════════════════════════════════════════════════════════════════════════════

export function ProblemsPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentTenantId = useTenantStore((state) => state.currentTenantId);
  const hasCapability = useAuthStore((state) => state.hasCapability);

  const canWrite = hasCapability(CAPABILITIES.PROBLEM_RW);
  const canRunDetector = hasCapability(CAPABILITIES.AUTOMATION_ADMIN);

  const [tab, setTab] = useState<Tab>('board');
  const [denied, setDenied] = useState(false);

  // ── Board state ───────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [knownErrorStates, setKnownErrorStates] = useState<KnownErrorState[]>([]);
  const [categories, setCategories] = useState<StatusCategory[]>([]);
  const [majorOnly, setMajorOnly] = useState(false);
  const [sort, setSort] = useState<NonNullable<ProblemListQuery['sort']>>('last_incident_at');
  const [problems, setProblems] = useState<ProblemWithRelations[]>([]);
  const [problemTotal, setProblemTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadingBoard, setLoadingBoard] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const debouncedSearch = useDebounce(search, 300);

  // ── Inbox state ───────────────────────────────────────────────────────────
  const [candidateStates, setCandidateStates] = useState<ProblemCandidateState[]>(['proposed']);
  const [candidates, setCandidates] = useState<ProblemCandidateWithTickets[]>([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [loadingCandidates, setLoadingCandidates] = useState(true);
  const [running, setRunning] = useState(false);
  const [accepting, setAccepting] = useState<ProblemCandidateWithTickets | null>(null);
  const [rejecting, setRejecting] = useState<ProblemCandidateWithTickets | null>(null);

  const query = useMemo<ProblemListQuery>(
    () => ({
      q: debouncedSearch.trim() || undefined,
      knownErrorState: knownErrorStates.length > 0 ? knownErrorStates : undefined,
      statusCategory: categories.length > 0 ? categories : undefined,
      major: majorOnly ? true : undefined,
      sort,
      direction: 'desc',
      limit: PAGE_SIZE,
    }),
    [debouncedSearch, knownErrorStates, categories, majorOnly, sort],
  );

  const loadBoard = useCallback(async () => {
    setLoadingBoard(true);
    try {
      const result = await problemsApi.list({ ...query, page: 1 });
      setProblems(result.items);
      setProblemTotal(result.total);
      setPage(1);
      setDenied(false);
    } catch (error) {
      // Reset the page counter with the list: "load more" from a stale page
      // number appends rows computed under the previous filters.
      setPage(1);
      setProblems([]);
      setProblemTotal(0);
      if (error instanceof ApiError && error.isForbidden) setDenied(true);
      else toast.error(errorMessage(error, t('problem.loadFailed', 'The problems could not be loaded.')));
    } finally {
      setLoadingBoard(false);
    }
  }, [query, t]);

  const loadCandidates = useCallback(async () => {
    setLoadingCandidates(true);
    try {
      const result = await problemsApi.listCandidates({
        state: candidateStates.length > 0 ? candidateStates : undefined,
        limit: PAGE_SIZE,
      });
      setCandidates(result.items);
      setCandidateTotal(result.total);
    } catch (error) {
      setCandidates([]);
      setCandidateTotal(0);
      if (!(error instanceof ApiError && error.isForbidden)) {
        toast.error(
          errorMessage(error, t('problem.candidateLoadFailed', 'The detected candidates could not be loaded.')),
        );
      }
    } finally {
      setLoadingCandidates(false);
    }
  }, [candidateStates, t]);

  // Config objects, queues and detector state are entirely different per
  // tenant, so both lists key off the current one.
  useEffect(() => {
    void loadBoard();
  }, [loadBoard, currentTenantId]);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates, currentTenantId]);

  async function loadMore(): Promise<void> {
    const next = page + 1;
    setLoadingMore(true);
    try {
      const result = await problemsApi.list({ ...query, page: next });
      setProblems((current) => [...current, ...result.items]);
      setProblemTotal(result.total);
      setPage(next);
    } catch (error) {
      toast.error(errorMessage(error, t('problem.loadFailed', 'The problems could not be loaded.')));
    } finally {
      setLoadingMore(false);
    }
  }

  async function runDetection(): Promise<void> {
    setRunning(true);
    try {
      const outcome = await problemsApi.runDetection(false);
      toast.success(
        t('problem.detectionDone', '{{proposed}} new, {{bumped}} refreshed, {{suppressed}} still silenced.', {
          proposed: outcome.proposed,
          bumped: outcome.bumped,
          suppressed: outcome.suppressed,
        }),
      );
      await loadCandidates();
    } catch (error) {
      toast.error(errorMessage(error, t('problem.detectionFailed', 'The detection pass could not be run.')));
    } finally {
      setRunning(false);
    }
  }

  if (denied) {
    return (
      <div className="p-6">
        <p className="rounded-card bg-bg-secondary p-6 text-sm text-text-muted shadow-card">
          {t('common.forbidden', 'You do not have the rights for this page.')}
        </p>
      </div>
    );
  }

  const hasBoardFilters =
    knownErrorStates.length > 0 || categories.length > 0 || majorOnly || search.trim() !== '';

  return (
    <div className="space-y-5 p-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-wide text-text-primary">
            <Siren size={22} className="text-accent" />
            {t('problem.title', 'Problems')}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {t(
              'problem.subtitle',
              'The causes behind the tickets: what recurs, what is understood, and what already has a workaround.',
            )}
          </p>
        </div>

        {canRunDetector && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Play size={14} />}
            loading={running}
            onClick={() => void runDetection()}
            title={t('problem.runDetectionHint', 'Run one detection pass now instead of waiting for the hourly sweep.')}
          >
            {t('problem.runDetection', 'Run the detector')}
          </Button>
        )}
      </header>

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <div className="flex w-fit items-center gap-0.5 rounded-pill bg-bg-tertiary p-0.5">
        <TabButton active={tab === 'board'} onClick={() => setTab('board')} icon={<Siren size={13} aria-hidden />}>
          {t('problem.tab.board', 'Problems')}
          <TabCount value={problemTotal} active={tab === 'board'} />
        </TabButton>
        <TabButton
          active={tab === 'candidates'}
          onClick={() => setTab('candidates')}
          icon={<Inbox size={13} aria-hidden />}
        >
          {t('problem.tab.candidates', 'Detected')}
          <TabCount value={candidateTotal} active={tab === 'candidates'} highlight />
        </TabButton>
      </div>

      {tab === 'board' ? (
        <>
          {/* ── Search and filters ───────────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-0 flex-1 sm:max-w-md">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('problem.searchPlaceholder', 'Search a problem, a symptom, a workaround…')}
                  aria-label={t('problem.searchPlaceholder', 'Search a problem, a symptom, a workaround…')}
                  className="w-full rounded-md bg-bg-tertiary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>

              <label className="flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                  {t('problem.sortBy', 'Sort')}
                </span>
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value as NonNullable<ProblemListQuery['sort']>)}
                  className="rounded-pill bg-bg-tertiary px-3 py-1.5 text-[12px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent [&>option]:bg-bg-secondary [&>option]:text-text-primary"
                >
                  {SORTS.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {t(entry.key, entry.fallback)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <FilterLabel>{t('problem.knownErrorFilter', 'Known error')}</FilterLabel>
              {KNOWN_ERROR_STATES.map((state) => (
                <FilterChip
                  key={state}
                  active={knownErrorStates.includes(state)}
                  onClick={() => setKnownErrorStates((current) => toggle(current, state))}
                >
                  {t(KNOWN_ERROR_STATE_LABELS[state].key, KNOWN_ERROR_STATE_LABELS[state].fallback)}
                </FilterChip>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <FilterLabel>{t('problem.stateFilter', 'State')}</FilterLabel>
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

              <FilterChip active={majorOnly} onClick={() => setMajorOnly((value) => !value)}>
                {t('problem.majorOnly', 'Major problems')}
              </FilterChip>

              {hasBoardFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('');
                    setKnownErrorStates([]);
                    setCategories([]);
                    setMajorOnly(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-pill px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
                >
                  <X size={11} aria-hidden />
                  {t('problem.clearFilters', 'Clear everything')}
                </button>
              )}
            </div>
          </div>

          <ProblemTable
            items={problems}
            loading={loadingBoard}
            onOpen={(problem) => navigate(`/problems/${problem.ticketId}`)}
          />

          {!loadingBoard && problems.length > 0 && (
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span className="font-mono">
                {t('problem.shownCount', '{{shown}} of {{total}} problems', {
                  shown: problems.length,
                  total: problemTotal,
                })}
              </span>
              {problems.length < problemTotal && (
                <Button size="sm" variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
                  {t('problem.loadMore', 'Load more')}
                </Button>
              )}
            </div>
          )}
        </>
      ) : (
        <CandidateInbox
          candidates={candidates}
          loading={loadingCandidates}
          states={candidateStates}
          onToggleState={(state) => setCandidateStates((current) => toggle(current, state))}
          canWrite={canWrite}
          onAccept={setAccepting}
          onReject={setRejecting}
          onOpenTicket={(ticketId) => navigate(`/tickets/${ticketId}`)}
          onOpenProblem={(ticketId) => navigate(`/problems/${ticketId}`)}
        />
      )}

      <AcceptCandidateModal
        candidate={accepting}
        onClose={() => setAccepting(null)}
        onAccepted={(problemTicketId) => {
          setAccepting(null);
          void loadCandidates();
          void loadBoard();
          navigate(`/problems/${problemTicketId}`);
        }}
      />

      <RejectCandidateModal
        candidate={rejecting}
        onClose={() => setRejecting(null)}
        onRejected={() => {
          setRejecting(null);
          void loadCandidates();
        }}
      />
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The board table
// ═════════════════════════════════════════════════════════════════════════════

function ProblemTable({
  items,
  loading,
  onOpen,
}: {
  items: ProblemWithRelations[];
  loading: boolean;
  onOpen: (problem: ProblemWithRelations) => void;
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
        icon={<Siren size={24} />}
        title={t('problem.emptyTitle', 'No problem on the board')}
        description={t(
          'problem.emptyBody',
          'A problem is opened from an incident, or accepted from a card the detector raised. It is never a blank form.',
        )}
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-card bg-bg-secondary shadow-card">
      <table className="w-full min-w-[52rem] text-left">
        <thead>
          <tr className="border-b border-border">
            <Th className="w-28">{t('problem.col.number', 'Number')}</Th>
            <Th>{t('problem.col.subject', 'Problem')}</Th>
            <Th className="w-36">{t('problem.col.state', 'State')}</Th>
            <Th className="w-44">{t('problem.col.knownError', 'Known error')}</Th>
            <Th className="w-24 text-right">{t('problem.col.incidents', 'Incidents')}</Th>
            <Th className="w-40">{t('problem.col.lastIncident', 'Last incident')}</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((problem) => {
            const header = problem.ticket;
            const risk = problem.workaroundRisk;
            return (
              <tr
                key={problem.ticketId}
                onClick={() => onOpen(problem)}
                tabIndex={0}
                role="button"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen(problem);
                  }
                }}
                className="cursor-pointer border-b border-border/40 transition-colors last:border-0 hover:bg-bg-hover focus:bg-bg-hover focus:outline-none"
              >
                <Td>
                  <span className="font-mono text-[12px] text-text-muted">
                    {header?.number ?? `#${problem.ticketId}`}
                  </span>
                </Td>
                <Td>
                  <div className="flex min-w-0 items-center gap-2">
                    {problem.major && (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-priority-p1-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-priority-p1"
                        title={t('problem.majorHint', 'Major problem: it owes a formal review.')}
                      >
                        <Flame size={10} aria-hidden />
                        {t('problem.majorShort', 'Major')}
                      </span>
                    )}
                    <span className="truncate text-[13px] text-text-primary">
                      {header?.subject ?? t('problem.untitled', 'Problem without a subject')}
                    </span>
                  </div>
                  <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted">
                    {t(
                      PROBLEM_DETECTED_BY_LABELS[problem.detectedBy].key,
                      PROBLEM_DETECTED_BY_LABELS[problem.detectedBy].fallback,
                    )}
                  </span>
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
                  <div className="flex flex-wrap items-center gap-1">
                    <KnownErrorPill state={problem.knownErrorState} />
                    {risk !== null && problem.knownErrorState !== 'none' && (
                      <span
                        className={clsx(
                          'inline-flex items-center rounded-pill px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]',
                          RISK_CLASSES[risk],
                        )}
                      >
                        {t(WORKAROUND_RISK_LABELS[risk].key, WORKAROUND_RISK_LABELS[risk].fallback)}
                      </span>
                    )}
                  </div>
                </Td>
                <Td className="text-right">
                  <span className="font-mono text-[13px] text-text-primary">{problem.incidentCount}</span>
                </Td>
                <Td>
                  <span
                    className="font-mono text-[11px] text-text-muted"
                    title={formatAbsolute(problem.lastIncidentAt)}
                  >
                    {problem.lastIncidentAt
                      ? formatRelative(problem.lastIncidentAt, t)
                      : t('problem.neverSeen', 'never')}
                  </span>
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
// The detector's inbox
// ═════════════════════════════════════════════════════════════════════════════

const INBOX_STATES: readonly ProblemCandidateState[] = ['proposed', 'accepted', 'rejected', 'expired'];

function CandidateInbox({
  candidates,
  loading,
  states,
  onToggleState,
  canWrite,
  onAccept,
  onReject,
  onOpenTicket,
  onOpenProblem,
}: {
  candidates: ProblemCandidateWithTickets[];
  loading: boolean;
  states: ProblemCandidateState[];
  onToggleState: (state: ProblemCandidateState) => void;
  canWrite: boolean;
  onAccept: (candidate: ProblemCandidateWithTickets) => void;
  onReject: (candidate: ProblemCandidateWithTickets) => void;
  onOpenTicket: (ticketId: number) => void;
  onOpenProblem: (ticketId: number) => void;
}): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterLabel>{t('problem.candidateStateFilter', 'Card state')}</FilterLabel>
        {INBOX_STATES.map((state) => (
          <FilterChip key={state} active={states.includes(state)} onClick={() => onToggleState(state)}>
            {t(PROBLEM_CANDIDATE_STATE_LABELS[state].key, PROBLEM_CANDIDATE_STATE_LABELS[state].fallback)}
          </FilterChip>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center rounded-card bg-bg-secondary py-16 shadow-card">
          <LoadingSpinner label={t('common.loading', 'Loading…')} />
        </div>
      ) : candidates.length === 0 ? (
        <EmptyState
          icon={<Inbox size={24} />}
          title={t('problem.inboxEmptyTitle', 'Nothing is recurring right now')}
          description={t(
            'problem.inboxEmptyBody',
            'The detector runs every hour over the last two weeks. It only raises a card when a hard signal fires: the same asset, the same alert, or a workaround that stopped holding.',
          )}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {candidates.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              canWrite={canWrite}
              onAccept={() => onAccept(candidate)}
              onReject={() => onReject(candidate)}
              onOpenTicket={onOpenTicket}
              onOpenProblem={onOpenProblem}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CandidateCard({
  candidate,
  canWrite,
  onAccept,
  onReject,
  onOpenTicket,
  onOpenProblem,
}: {
  candidate: ProblemCandidateWithTickets;
  canWrite: boolean;
  onAccept: () => void;
  onReject: () => void;
  onOpenTicket: (ticketId: number) => void;
  onOpenProblem: (ticketId: number) => void;
}): JSX.Element {
  const { t } = useTranslation();

  // Sorted by contribution: the reason the card exists goes first, and a signal
  // that fired at 0.02 must not sit above the one that carried it.
  const readings = useMemo(() => {
    const entries = Object.entries(candidate.signals) as Array<
      [ProblemDetectionSignal, ProblemSignalReading | undefined]
    >;
    return entries
      .filter((entry): entry is [ProblemDetectionSignal, ProblemSignalReading] => Boolean(entry[1]))
      .map(([signal, reading]) => ({
        signal,
        reading,
        contribution: Math.max(0, Math.min(1, reading.weight * reading.saturation)),
      }))
      .sort((a, b) => b.contribution - a.contribution);
  }, [candidate.signals]);

  const ticketIds = useMemo(
    () => [...new Set(candidate.tickets.map((entry) => entry.ticketId))],
    [candidate.tickets],
  );

  const decided = candidate.state !== 'proposed';

  return (
    <article className="rounded-card bg-bg-secondary p-4 shadow-card">
      <div className="flex flex-col gap-4 sm:flex-row">
        {/* ── The score, readable from across the room ─────────────────── */}
        <div className="flex shrink-0 flex-col items-center gap-1">
          <ScoreDial score={candidate.score} />
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
            {t('problem.scoreLabel', 'Score')}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          {/* ── Identity ──────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-start gap-2">
            <h3 className="min-w-0 flex-1 text-[15px] font-medium leading-snug text-text-primary">
              {candidate.title}
            </h3>
            <span
              className={clsx(
                'shrink-0 rounded-pill px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]',
                CANDIDATE_STATE_CLASSES[candidate.state],
              )}
            >
              {t(
                PROBLEM_CANDIDATE_STATE_LABELS[candidate.state].key,
                PROBLEM_CANDIDATE_STATE_LABELS[candidate.state].fallback,
              )}
            </span>
          </div>

          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-text-muted">
            <span title={t('problem.windowHint', 'The observation window this pass looked at.')}>
              {formatDate(candidate.windowStart)} → {formatDate(candidate.windowEnd)}
            </span>
            <span aria-hidden>·</span>
            <span>
              {t('problem.incidentsCounted', '{{count}} incidents', { count: candidate.incidentCount })}
            </span>
            <span aria-hidden>·</span>
            <span title={t('problem.occurrenceHint', 'How many passes have seen this same signature.')}>
              {t('problem.seenTimes', 'seen {{count}} times', { count: candidate.occurrenceCount })}
            </span>
            <span aria-hidden>·</span>
            <span title={t('problem.detectorHint', 'The published detector object that raised it.')}>
              {candidate.detectorSlug} v{candidate.detectorVersion}
            </span>
          </p>

          {/* ── The card came back after a refusal ────────────────────── */}
          {candidate.supersededCandidateId !== null && (
            <p className="mt-2 flex items-start gap-1.5 rounded-card bg-sla-warn-bg px-2.5 py-1.5 text-[11px] leading-snug text-sla-warn">
              <TrendingUp size={12} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                {t(
                  'problem.escalatedNotice',
                  'This signature was refused before. It is back because the evidence got materially worse, not because the refusal was forgotten.',
                )}
                {candidate.supersedes?.decisionNote ? (
                  <span className="mt-0.5 block italic text-text-muted">
                    {t('problem.previousNote', 'Earlier note: {{note}}', {
                      note: candidate.supersedes.decisionNote,
                    })}
                  </span>
                ) : null}
              </span>
            </p>
          )}

          {/* ── Which signals fired, and by how much ──────────────────── */}
          <div className="mt-3 space-y-1.5">
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
              {t('problem.signalsHeading', 'What fired')}
            </p>
            {readings.length === 0 ? (
              <p className="text-[12px] text-text-muted">
                {t('problem.noSignalReading', 'This pass recorded no readable signal.')}
              </p>
            ) : (
              readings.map((entry) => (
                <SignalRow
                  key={entry.signal}
                  signal={entry.signal}
                  reading={entry.reading}
                  contribution={entry.contribution}
                />
              ))
            )}
          </div>

          {/* ── The incidents underneath ──────────────────────────────── */}
          {ticketIds.length > 0 && (
            <div className="mt-3">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
                {t('problem.contributingTickets', 'Incidents underneath')}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {ticketIds.slice(0, 14).map((ticketId) => (
                  <button
                    key={ticketId}
                    type="button"
                    onClick={() => onOpenTicket(ticketId)}
                    className="rounded-pill bg-bg-tertiary px-2 py-0.5 font-mono text-[10px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-accent"
                    title={t('problem.openIncident', 'Open this incident')}
                  >
                    #{ticketId}
                  </button>
                ))}
                {ticketIds.length > 14 && (
                  <span className="rounded-pill bg-bg-tertiary px-2 py-0.5 font-mono text-[10px] text-text-muted">
                    {t('problem.moreTickets', '+{{count}} more', { count: ticketIds.length - 14 })}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ── Two actions, and nothing else ─────────────────────────── */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {decided ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-[12px] text-text-muted">
                  <CircleSlash size={12} aria-hidden />
                  {candidate.decisionNote
                    ? t('problem.decidedWithNote', 'Decided: {{note}}', { note: candidate.decisionNote })
                    : t('problem.decided', 'This card has been decided.')}
                </span>
                {candidate.problemTicketId !== null && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => onOpenProblem(candidate.problemTicketId as number)}
                  >
                    {t('problem.openTheProblem', 'Open the problem')}
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Siren size={14} />}
                  disabled={!canWrite}
                  title={
                    canWrite
                      ? undefined
                      : t('problem.needsProblemRw', 'Managing problems requires the problem capability.')
                  }
                  onClick={onAccept}
                >
                  {t('problem.acceptCandidate', 'Open a problem')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<ThumbsDown size={14} />}
                  disabled={!canWrite}
                  title={
                    canWrite
                      ? undefined
                      : t('problem.needsProblemRw', 'Managing problems requires the problem capability.')
                  }
                  onClick={onReject}
                >
                  {t('problem.rejectCandidate', 'Not a problem')}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/** One fired signal: what it saw, against what it needed, and what it added. */
function SignalRow({
  signal,
  reading,
  contribution,
}: {
  signal: ProblemDetectionSignal;
  reading: ProblemSignalReading;
  contribution: number;
}): JSX.Element {
  const { t } = useTranslation();
  const label = PROBLEM_SIGNAL_LABELS[signal];
  const tone = scoreTone(contribution >= 0.6 ? 0.85 : contribution >= 0.4 ? 0.7 : 0.2);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-card bg-bg-tertiary px-2.5 py-1.5">
      <Activity size={12} className={clsx('shrink-0', tone.text)} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">
        {t(label.key, label.fallback)}
      </span>

      <span
        className="shrink-0 font-mono text-[10px] text-text-muted"
        title={t('problem.observedHint', 'Observed against the threshold in force at that pass.')}
      >
        {reading.observed}/{reading.threshold}
      </span>

      <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-pill bg-bg-hover" aria-hidden>
        <span
          className={clsx('block h-full rounded-pill', tone.fill)}
          style={{ width: `${Math.round(contribution * 100)}%` }}
        />
      </span>

      <span className={clsx('w-9 shrink-0 text-right font-mono text-[10px]', tone.text)}>
        {contribution.toFixed(2)}
      </span>
    </div>
  );
}

/**
 * The score as an arc. `r = 15.915` makes the circumference exactly 100, so the
 * dash array IS the percentage and no arithmetic hides in the geometry.
 */
function ScoreDial({ score }: { score: number }): JSX.Element {
  const value = Math.max(0, Math.min(1, score));
  const tone = scoreTone(value);
  const filled = value * 100;

  return (
    <div className="relative h-[58px] w-[58px]">
      <svg viewBox="0 0 42 42" className="h-full w-full -rotate-90" aria-hidden>
        <circle
          cx="21"
          cy="21"
          r="15.915"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.5"
          className="text-bg-tertiary"
        />
        <circle
          cx="21"
          cy="21"
          r="15.915"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${filled.toFixed(1)} ${(100 - filled).toFixed(1)}`}
          className={tone.stroke}
        />
      </svg>
      <span
        className={clsx(
          'absolute inset-0 flex items-center justify-center font-mono text-[15px] font-semibold',
          tone.text,
        )}
      >
        {Math.round(filled)}
      </span>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Accept
// ═════════════════════════════════════════════════════════════════════════════

function AcceptCandidateModal({
  candidate,
  onClose,
  onAccepted,
}: {
  candidate: ProblemCandidateWithTickets | null;
  onClose: () => void;
  onAccepted: (problemTicketId: number) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [subject, setSubject] = useState('');
  const [symptoms, setSymptoms] = useState('');
  const [queueSlug, setQueueSlug] = useState('');
  const [prioritySlug, setPrioritySlug] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<TicketFieldOptions | null>(null);

  useEffect(() => {
    if (!candidate) return;
    setSubject(candidate.title);
    setSymptoms('');
    setQueueSlug(candidate.queueSlug ?? '');
    setPrioritySlug('');
    setNote('');
  }, [candidate]);

  useEffect(() => {
    if (!candidate) return;
    let alive = true;
    void loadTicketFieldOptions().then((loaded) => {
      if (alive) setOptions(loaded);
    });
    return () => {
      alive = false;
    };
  }, [candidate]);

  async function submit(): Promise<void> {
    if (!candidate) return;
    setBusy(true);
    try {
      const problem = await problemsApi.acceptCandidate(candidate.id, {
        subject: subject.trim() || undefined,
        symptomsMd: symptoms.trim() || null,
        queueSlug: queueSlug || null,
        prioritySlug: prioritySlug || null,
        note: note.trim() || null,
      });
      toast.success(t('problem.accepted', 'Problem opened and every incident linked to it.'));
      onAccepted(problem.ticketId);
    } catch (error) {
      toast.error(errorMessage(error, t('problem.acceptFailed', 'The problem could not be opened.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={candidate !== null}
      onClose={onClose}
      size="lg"
      title={t('problem.acceptTitle', 'Open a problem from this card')}
      subtitle={t(
        'problem.acceptSubtitle',
        'The incidents underneath are linked in the same transaction, and the problem takes the oldest of their occurrence times.',
      )}
      closeLabel={t('common.close', 'Close')}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button size="sm" variant="primary" loading={busy} onClick={() => void submit()}>
            {t('problem.acceptConfirm', 'Open the problem')}
          </Button>
        </div>
      }
    >
      {candidate && (
        <div className="flex flex-col gap-3">
          <Field label={t('problem.field.subject', 'Subject')}>
            <input
              type="text"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder={t('problem.field.subjectPlaceholder', 'What is actually broken')}
              className="w-full rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </Field>

          <Field
            label={t('problem.field.symptoms', 'Symptoms')}
            hint={t(
              'problem.field.symptomsHint',
              'Phrased the way a requester describes it. This is what the intake matcher indexes.',
            )}
          >
            <textarea
              rows={3}
              value={symptoms}
              onChange={(event) => setSymptoms(event.target.value)}
              placeholder={t('problem.field.symptomsPlaceholder', 'The printer on the second floor stops after ten pages…')}
              className="w-full resize-y rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('problem.field.queue', 'Queue')}>
              <SlugSelect
                value={queueSlug}
                onChange={setQueueSlug}
                options={options?.queues ?? []}
                placeholder={t('problem.field.queueDefault', 'Let the routing decide')}
              />
            </Field>
            <Field label={t('problem.field.priority', 'Priority')}>
              <SlugSelect
                value={prioritySlug}
                onChange={setPrioritySlug}
                options={options?.priorities ?? []}
                placeholder={t('problem.field.priorityDefault', 'Let the matrix decide')}
              />
            </Field>
          </div>

          <Field
            label={t('problem.field.note', 'Note')}
            hint={t('problem.field.noteHint', 'Written to the decision log with the acceptance.')}
          >
            <input
              type="text"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t('problem.field.notePlaceholder', 'Why this card is worth a problem')}
              className="w-full rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </Field>

          <p className="rounded-card bg-bg-tertiary px-3 py-2 text-[12px] leading-snug text-text-muted">
            {t('problem.acceptLinkNotice', '{{count}} incidents will be linked to the new problem.', {
              count: new Set(candidate.tickets.map((entry) => entry.ticketId)).size,
            })}
          </p>
        </div>
      )}
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Reject
// ═════════════════════════════════════════════════════════════════════════════

function RejectCandidateModal({
  candidate,
  onClose,
  onRejected,
}: {
  candidate: ProblemCandidateWithTickets | null;
  onClose: () => void;
  onRejected: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [cooldown, setCooldown] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!candidate) return;
    setNote('');
    setCooldown('');
  }, [candidate]);

  async function submit(): Promise<void> {
    if (!candidate) return;
    const days = Number(cooldown);
    setBusy(true);
    try {
      await problemsApi.rejectCandidate(candidate.id, {
        note: note.trim(),
        cooldownDays: Number.isInteger(days) && days > 0 ? days : undefined,
      });
      toast.success(t('problem.rejected', 'Card refused. The signature stays quiet for the cooldown.'));
      onRejected();
    } catch (error) {
      toast.error(errorMessage(error, t('problem.rejectFailed', 'The card could not be refused.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={candidate !== null}
      onClose={onClose}
      size="md"
      title={t('problem.rejectTitle', 'Refuse this card')}
      subtitle={t(
        'problem.rejectSubtitle',
        'The card is kept, never deleted. It is what silences the signature, and what lets the detector come back the day the evidence gets materially worse.',
      )}
      closeLabel={t('common.close', 'Close')}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={busy}
            disabled={note.trim() === ''}
            title={
              note.trim() === ''
                ? t('problem.rejectNeedsNote', 'The note is what the escalation banner shows back months later.')
                : undefined
            }
            onClick={() => void submit()}
          >
            {t('problem.rejectConfirm', 'Refuse the card')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label={t('problem.field.rejectNote', 'Why is this not a problem?')}
          hint={t(
            'problem.field.rejectNoteHint',
            'Required. Somebody will read it in three months, on the day the detector proposes it again.',
          )}
        >
          <textarea
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('problem.field.rejectNotePlaceholder', 'Known migration, the site is being decommissioned…')}
            className="w-full resize-y rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </Field>

        <Field
          label={t('problem.field.cooldown', 'Silence for (days)')}
          hint={t('problem.field.cooldownHint', 'Leave empty to use the detector default.')}
        >
          <input
            type="number"
            min={1}
            value={cooldown}
            onChange={(event) => setCooldown(event.target.value)}
            placeholder="90"
            className="w-32 rounded-card bg-bg-tertiary px-2.5 py-1.5 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </Field>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Small local pieces
// ═════════════════════════════════════════════════════════════════════════════

function KnownErrorPill({ state }: { state: KnownErrorState }): JSX.Element {
  const { t } = useTranslation();
  const label = KNOWN_ERROR_STATE_LABELS[state];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px]',
        KNOWN_ERROR_CLASSES[state],
      )}
    >
      {state === 'published' && <AlertTriangle size={10} aria-hidden />}
      {t(label.key, label.fallback)}
    </span>
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

function TabCount({
  value,
  active,
  highlight = false,
}: {
  value: number;
  active: boolean;
  highlight?: boolean;
}): JSX.Element | null {
  if (value <= 0) return null;
  return (
    <span
      className={clsx(
        'rounded-pill px-1.5 py-px font-mono text-[10px]',
        highlight && !active
          ? 'bg-accent/12 text-accent'
          : active
            ? 'bg-bg-tertiary text-text-secondary'
            : 'bg-bg-hover text-text-muted',
      )}
    >
      {value}
    </span>
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
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-text-muted">{hint}</span>}
    </label>
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

export default ProblemsPage;
