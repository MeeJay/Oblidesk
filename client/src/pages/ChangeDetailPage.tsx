/**
 * ChangeDetailPage — `/changes/:id`
 *
 * The change folder. What is on it, and why it is arranged this way:
 *
 *   1. THE TRANSITION BAR sits directly under the identity card, above
 *      everything else, because every panel below exists to unblock it. It is
 *      greyed by `evaluateChangeTransition` — THE SAME function the server's
 *      transition path calls to refuse — and it LISTS what is missing. A grey
 *      button with no reason is how an agent learns to fight the form instead
 *      of doing the work.
 *
 *   2. THE THREE PLANS, THE WINDOW, THE CONFLICTS, THE FREEZES, in that order,
 *      because that is the order the schedule gate reads them in and the order
 *      a scheduler fills them in.
 *
 *   3. THE RISK, THE APPROVALS AND THE ITEMS TOUCHED in the right column: they
 *      are consequences, not inputs. Risk is computed from the impact, the
 *      failure likelihood and the items; the approval selection is computed
 *      from the risk. Putting them beside the work rather than in it is what
 *      stops somebody "fixing" a band by editing the wrong field.
 *
 *   4. THE WHY PANEL, a straight read of `decision_log` through the same drawer
 *      the ticket and problem pages use.
 *
 * ── HARD RULE 12, and exactly where it stops ────────────────────────────────
 * Every field here autosaves on its own and validates NOTHING. A change can sit
 * with an empty backout plan for three weeks. Completeness is demanded at four
 * moments and nowhere else, by four SHARED functions the server calls too:
 * `evaluateChangeSchedule` (entering `scheduled`, and requesting the CAB),
 * `evaluateChangeClosure` (entering `closed`), `evaluateChangeReview`
 * (completing the PIR) and `evaluateChangeFreezeOverride` (bypassing a freeze).
 * One implementation, two callers.
 *
 * ── Why the gates are a UNION of two readings ───────────────────────────────
 * The page runs the evaluators itself, so the button reacts to a keystroke
 * without a round trip. But there is exactly one input the browser cannot
 * produce: the LEAD TIME, which is business minutes measured against a
 * `calendar` on the server. So the server also precomputes the same gate and
 * sends it on the record, and `mergeGates` shows the UNION of the two — never
 * the more permissive of them. The server's copy is at most one unsaved
 * keystroke stale, because every successful autosave replaces the record with
 * the server's freshly evaluated row.
 *
 * ── HARD RULE 7, twice ──────────────────────────────────────────────────────
 * Two row versions cross this page and they are NOT interchangeable.
 * `change.rowVersion` is `changes.row_version` and rides every `/changes`
 * mutation; `change.ticket.rowVersion` is `tickets.row_version` and rides the
 * transition. They are separate concurrency domains on purpose: rewriting a
 * backout plan must not 409 the person moving the ticket, and moving the ticket
 * must not 409 the person mid-sentence in the test plan. A 409 replaces the
 * record with the server's row and raises the banner — rebasing is not
 * courtesy, it is what makes the NEXT save land.
 *
 * ── HARD RULE 6 ─────────────────────────────────────────────────────────────
 * Three time notions live here and the page never conflates them: the PLANNED
 * window (intent), the BASELINE window (what the approvals consented to) and
 * the ACTUAL window (what happened). `tickets.occurred_at` is none of them and
 * stays empty on a change: a change is not something that happened to you.
 *
 * HARD RULE 11 — no border on any card, pill or button below.
 * HARD RULE 10 — every visible string is `t('change.…', 'English fallback')`.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  Check,
  CircleDot,
  ClipboardCheck,
  Clock3,
  Hammer,
  RefreshCw,
  Replace,
  RotateCcw,
  Server,
  ShieldCheck,
  Snowflake,
  Users,
  X,
} from 'lucide-react';
import {
  CAPABILITIES,
  CHANGE_CONFLICT_KIND_LABELS,
  CHANGE_CONFLICT_SEVERITY_LABELS,
  CHANGE_OUTCOMES,
  CHANGE_OUTCOME_LABELS,
  CHANGE_RISKS,
  CHANGE_RISK_LABELS,
  CHANGE_TYPE_LABELS,
  FAILURE_LIKELIHOODS,
  FAILURE_LIKELIHOOD_LABELS,
  acknowledgeableConflicts,
  baselineWindowOf,
  canWaiveBackout,
  changeWindowMoveExceedsTolerance,
  conflictDigest,
  evaluateChangeClosure,
  evaluateChangeFreezeOverride,
  evaluateChangeReview,
  evaluateChangeSchedule,
  evaluateChangeTransition,
  isChangeFrozen,
  isConflictAckCurrent,
  isImplementing,
  plannedWindowOf,
  resolveChangePolicy,
} from '@oblidesk/shared';
import type {
  Approval,
  ApprovalState,
  Capability,
  ChangeActorContext,
  ChangeConflictClassification,
  ChangeConflictSeverity,
  ChangeConflictView,
  ChangeFreezeVerdict,
  ChangeGateEvaluation,
  ChangeOutcome,
  ChangePolicyResolution,
  ChangeRequirement,
  ChangeRisk,
  ChangeScheduleInput,
  ChangeType,
  ChangeWithRelations,
  ChangeCiCriticality,
  FailureLikelihood,
  StatusCategory,
} from '@oblidesk/shared';
import { errorMessage } from '@/api/client';
import { fetchCi } from '@/api/ci.api';
import changesApi, {
  changeBlockersOf,
  changeConflictOf,
  toConflictClassification,
  type ChangeFreezeStatus,
  type ChangePolicySource,
  type UpdateChangeRequest,
} from '@/api/changes.api';
import { ticketsApi, evaluationOf } from '@/api/tickets.api';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { Toggle } from '@/components/common/Toggle';
import InlineField from '@/components/tickets/InlineField';
import StatusPill from '@/components/tickets/StatusPill';
import WhyDrawer from '@/components/tickets/WhyDrawer';
import {
  transitionLabel,
  type AvailableTransitions,
  type TransitionOption,
} from '@/components/tickets/TransitionInspector';
import { formatAbsolute } from '@/components/tickets/SlaChip';
import { useAuthStore } from '@/store/authStore';
import { formatDateTime } from '@/utils/format';

// ═════════════════════════════════════════════════════════════════════════════
// Literal class tables — Tailwind cannot see a concatenated class name
// ═════════════════════════════════════════════════════════════════════════════

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

const CONFLICT_SEVERITY_CLASSES: Readonly<Record<ChangeConflictSeverity, string>> = {
  high: 'bg-sla-breach-bg text-sla-breach',
  medium: 'bg-sla-warn-bg text-sla-warn',
  low: 'bg-bg-hover text-text-muted',
  info: 'bg-bg-hover text-text-muted',
};

const APPROVAL_STATE_CLASSES: Readonly<Record<ApprovalState, string>> = {
  pending: 'bg-status-scheduled-bg text-status-scheduled',
  approved: 'bg-sla-ok-bg text-sla-ok',
  rejected: 'bg-sla-breach-bg text-sla-breach',
  expired: 'bg-bg-tertiary text-text-muted',
  cancelled: 'bg-status-cancelled-bg text-status-cancelled',
};

/**
 * No shared map exists for these: `ApprovalState` belongs to the approval
 * engine, which has no UI of its own yet. The keys stay under `change.` so the
 * locale author owns one namespace, and every one carries its English fallback.
 */
const APPROVAL_STATE_LABELS: Readonly<Record<ApprovalState, { key: string; fallback: string }>> = {
  pending: { key: 'change.approvalState.pending', fallback: 'Waiting' },
  approved: { key: 'change.approvalState.approved', fallback: 'Approved' },
  rejected: { key: 'change.approvalState.rejected', fallback: 'Rejected' },
  expired: { key: 'change.approvalState.expired', fallback: 'Expired' },
  cancelled: { key: 'change.approvalState.cancelled', fallback: 'Withdrawn' },
};

/** Why an approval slug was selected, in words. */
const APPROVAL_REASON_LABELS: Readonly<Record<string, { key: string; fallback: string }>> = {
  type: { key: 'change.approvalBecause.type', fallback: 'because of the change type' },
  risk_band: { key: 'change.approvalBecause.riskBand', fallback: 'because of the risk band' },
  ci_criticality: {
    key: 'change.approvalBecause.ciCriticality',
    fallback: 'because of a critical item',
  },
  queue: { key: 'change.approvalBecause.queue', fallback: 'because of the queue' },
};

// ═════════════════════════════════════════════════════════════════════════════
// Time helpers for the datetime inputs
// ═════════════════════════════════════════════════════════════════════════════

/** ISO instant → the `YYYY-MM-DDTHH:mm` a `datetime-local` wants, in LOCAL time. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** …and back. An unparseable string is dropped rather than sent as an invalid date. */
function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

// ═════════════════════════════════════════════════════════════════════════════
// Gate merging
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The union of the browser's reading and the server's, never the intersection.
 *
 * Both come from the same evaluator, so they normally agree word for word. They
 * differ in exactly two directions and both are handled by taking the union:
 * the SERVER knows the business-hours lead time the browser cannot compute, and
 * the BROWSER knows the field the agent blanked half a second ago. A gate that
 * is more permissive than either opinion would promise a move the server is
 * about to refuse, which is the one failure mode a shared evaluator exists to
 * prevent.
 */
function mergeGates(
  local: ChangeGateEvaluation,
  server: ChangeGateEvaluation | undefined,
): ChangeGateEvaluation {
  if (!server) return local;

  const blockers: ChangeRequirement[] = [...local.blockers];
  const seenBlockers = new Set(local.blockers.map((entry) => entry.code));
  for (const blocker of server.blockers) {
    if (seenBlockers.has(blocker.code)) continue;
    seenBlockers.add(blocker.code);
    blockers.push(blocker);
  }

  const warnings: ChangeRequirement[] = [...local.warnings];
  const warningKey = (entry: ChangeRequirement): string =>
    `${entry.code}|${entry.key}|${(entry.slugs ?? []).join(',')}`;
  const seenWarnings = new Set(local.warnings.map(warningKey));
  for (const warning of server.warnings) {
    const key = warningKey(warning);
    if (seenWarnings.has(key)) continue;
    seenWarnings.add(key);
    warnings.push(warning);
  }

  const missingCapabilities: Capability[] = [
    ...new Set([...local.missingCapabilities, ...server.missingCapabilities]),
  ];

  return {
    allowed: blockers.length === 0 && missingCapabilities.length === 0,
    blockers,
    warnings,
    missingCapabilities,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Page
// ═════════════════════════════════════════════════════════════════════════════

export function ChangeDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();

  const parsed = Number(params.id);
  const ticketId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;

  const session = useAuthStore((state) => state.session);
  const hasCapability = useAuthStore((state) => state.hasCapability);
  const canWrite = hasCapability(CAPABILITIES.CHANGE_RW);
  const canSchedule = hasCapability(CAPABILITIES.CHANGE_SCHEDULE);
  const canOverrideFreeze = hasCapability(CAPABILITIES.CHANGE_FREEZE_OVERRIDE);

  /** What the shared evaluators need about the signed-in actor. */
  const actor = useMemo<ChangeActorContext>(
    () => ({ capabilities: session?.capabilities ?? null, isAdmin: session?.isAdmin ?? false }),
    [session],
  );

  const [change, setChange] = useState<ChangeWithRelations | null>(null);
  const [freeze, setFreeze] = useState<ChangeFreezeStatus | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [policySource, setPolicySource] = useState<ChangePolicySource | null>(null);
  const [transitions, setTransitions] = useState<AvailableTransitions | null>(null);
  const [ciNames, setCiNames] = useState<Record<number, string>>({});

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);

  /** The blockers a refused mutation sent back, shown beside the local ones. */
  const [refusal, setRefusal] = useState<ChangeRequirement[] | null>(null);

  /** How many incidents the reviewer has named as caused by this change. */
  const [reviewIncidentCount, setReviewIncidentCount] = useState(0);

  const load = useCallback(async () => {
    if (ticketId === null) return;
    setLoading(true);
    try {
      const record = await changesApi.get(ticketId);
      setChange(record);
      setNotFound(false);
      setRefusal(null);

      // Everything else is independent and none of it may block the folder:
      // a freeze route that is slow, an approval list that 403s for a reader,
      // a policy nobody published — all of those must still leave a readable
      // page. `resolveChangePolicy(null, …)` falls back to the shipped
      // baseline, which is the whole point of it.
      const [freezeStatus, approvalList, policy, transitionList] = await Promise.all([
        changesApi.freeze(ticketId).catch(() => null),
        changesApi.approvals(ticketId).catch(() => []),
        changesApi.policy(record.policySlug ?? undefined),
        ticketsApi
          .transitions(ticketId)
          .then((raw) => raw as unknown as AvailableTransitions)
          .catch(() => null),
      ]);
      setFreeze(freezeStatus);
      setApprovals(approvalList);
      setPolicySource(policy);
      setTransitions(transitionList);
    } catch (error) {
      setNotFound(true);
      toast.error(errorMessage(error, t('change.detailLoadFailed', 'This change could not be read.')));
    } finally {
      setLoading(false);
    }
  }, [ticketId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The linked item ids as a STABLE key.
   *
   * Every mutation on this page adopts a fresh server row, and a fresh row
   * carries a fresh `ciIds` array with a new identity. Keying the effect below
   * on the array itself would therefore re-fetch every item name on every
   * keystroke's autosave. The joined string only changes when the LINKS change,
   * which is the only thing that can change a name lookup.
   */
  const ciKey = (change?.ciIds ?? []).join(',');

  // Item names, fetched after first paint and never allowed to fail loudly:
  // `fetchCi` answers a section result and does not reject, so a CMDB that is
  // briefly unavailable costs the chip its label and nothing else.
  useEffect(() => {
    const ids = ciKey
      .split(',')
      .map((entry) => Number(entry))
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, 20);
    if (ids.length === 0) return;
    let alive = true;
    void Promise.all(ids.map((id) => fetchCi(id))).then((results) => {
      if (!alive) return;
      const names: Record<number, string> = {};
      results.forEach((result, index) => {
        const name = result.data?.displayName;
        if (name) names[ids[index]] = name;
      });
      setCiNames(names);
    });
    return () => {
      alive = false;
    };
  }, [ciKey]);

  /** Adopt a server row. Every mutation lands here, so the gates stay fresh. */
  const adopt = useCallback((next: ChangeWithRelations) => {
    setChange(next);
    setConflicted(false);
    setRefusal(null);
  }, []);

  /**
   * One PATCH per field, carrying `changes.row_version` (HARD RULE 7). A 409
   * replaces the record with the server's row and raises the banner; the error
   * is rethrown so the field that failed keeps the agent's text and says so in
   * place rather than silently reverting.
   */
  const saveField = useCallback(
    async (patch: Omit<UpdateChangeRequest, 'baseRowVersion'>): Promise<void> => {
      if (!change || ticketId === null) return;
      try {
        adopt(await changesApi.update(ticketId, { baseRowVersion: change.rowVersion, ...patch }));
      } catch (error) {
        const current = changeConflictOf(error);
        if (current) {
          setChange(current);
          setConflicted(true);
        }
        throw error;
      }
    },
    [change, ticketId, adopt],
  );

  // ── Everything the four gates read ────────────────────────────────────────

  const conflictViews = useMemo<ChangeConflictView[]>(() => change?.conflicts ?? [], [change]);

  const classifications = useMemo<ChangeConflictClassification[]>(
    () => conflictViews.map(toConflictClassification),
    [conflictViews],
  );

  const freezeVerdicts = useMemo<ChangeFreezeVerdict[]>(() => freeze?.verdicts ?? [], [freeze]);

  const approvalCounts = useMemo(
    () => ({
      pending: approvals.filter((approval) => approval.state === 'pending').length,
      rejected: approvals.filter((approval) => approval.state === 'rejected').length,
    }),
    [approvals],
  );

  const policy = useMemo<ChangePolicyResolution | null>(() => {
    if (!change) return null;
    return resolveChangePolicy(
      policySource?.body ?? null,
      {
        changeType: change.changeType,
        risk: change.risk,
        queueSlug: change.ticket?.queueSlug ?? null,
        worstCiCriticality: (change.worstCiCriticality ?? null) as ChangeCiCriticality | null,
      },
      { slug: policySource?.slug ?? null, version: policySource?.version ?? null },
    );
  }, [change, policySource]);

  const scheduleInput = useMemo<ChangeScheduleInput | null>(() => {
    if (!change || !policy) return null;
    return {
      change,
      policy,
      conflicts: classifications,
      freezes: freezeVerdicts,
      approvals: approvalCounts,
      // Business minutes are a calendar question and the browser has no
      // calendar. `null` never blocks; the server's own reading of the same
      // gate carries the lead-time blocker, and `mergeGates` unions it in.
      leadTimeMinutes: null,
      worstCiCriticality: (change.worstCiCriticality ?? null) as ChangeCiCriticality | null,
      actor,
    };
  }, [change, policy, classifications, freezeVerdicts, approvalCounts, actor]);

  const scheduleGate = useMemo<ChangeGateEvaluation | null>(() => {
    if (!scheduleInput) return null;
    return mergeGates(evaluateChangeSchedule(scheduleInput), change?.scheduleGate);
  }, [scheduleInput, change]);

  const closureGate = useMemo<ChangeGateEvaluation | null>(() => {
    if (!change) return null;
    return mergeGates(evaluateChangeClosure({ change, actor }), change.closureGate);
  }, [change, actor]);

  const reviewGate = useMemo<ChangeGateEvaluation | null>(() => {
    if (!change) return null;
    // `linkedIncidentCount` is what the reviewer has named in the form below.
    // The server counts the `caused_by` links that actually exist, which is the
    // authoritative reading; this one exists so "yes, it caused an incident"
    // cannot be submitted with an empty list.
    return evaluateChangeReview({ change, linkedIncidentCount: reviewIncidentCount, actor });
  }, [change, reviewIncidentCount, actor]);

  if (ticketId === null) {
    return (
      <NotFoundCard
        title={t('change.badId', 'Invalid change identifier')}
        body={t('change.badIdBody', 'The address does not carry a usable change identifier.')}
      />
    );
  }

  if (loading && !change) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center p-6">
        <LoadingSpinner size="lg" label={t('common.loading', 'Loading…')} />
      </div>
    );
  }

  if (notFound || !change || !policy || !scheduleGate || !closureGate || !reviewGate) {
    return (
      <NotFoundCard
        title={t('change.notFound', 'Change not found')}
        body={t(
          'change.notFoundBody',
          'This change does not exist in this workspace, or it belongs to another organisation.',
        )}
      />
    );
  }

  const header = change.ticket;
  const planned = plannedWindowOf(change);
  const baseline = baselineWindowOf(change);
  const running = isImplementing(change);

  return (
    <div className="space-y-4 p-6">
      {/* ── Chrome ───────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/changes"
          className="inline-flex items-center gap-1.5 text-[13px] text-text-muted transition-colors hover:text-text-secondary"
        >
          <ArrowLeft size={14} aria-hidden />
          {t('change.backToList', 'All changes')}
        </Link>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            icon={<Clock3 size={14} />}
            onClick={() => setWhyOpen(true)}
            title={t('change.whyHint', 'Read the decision log for this change.')}
          >
            {t('why.title', 'Why?')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={14} />}
            onClick={() => void load()}
          >
            {t('change.refresh', 'Reload')}
          </Button>
        </div>
      </header>

      {conflicted && (
        <Banner
          tone="warn"
          onDismiss={() => setConflicted(false)}
          dismissLabel={t('common.close', 'Close')}
        >
          {t(
            'change.conflictBanner',
            'Somebody else saved this change while you were editing. The page now shows their version; check your change before saving it again.',
          )}
        </Banner>
      )}

      {isChangeFrozen(freezeVerdicts) && (
        <Banner tone="warn">
          {t(
            'change.frozenBanner',
            'A change freeze covers this window. Read the freeze panel before promising a date.',
          )}
        </Banner>
      )}

      {/* ── Identity ─────────────────────────────────────────────────────── */}
      <section className="rounded-card bg-bg-secondary p-5 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px] text-text-muted">
            {header?.number ?? `#${change.ticketId}`}
          </span>
          {header && (
            <StatusPill statusSlug={header.statusSlug} category={header.statusCategory} size="sm" />
          )}
          <Pill className={TYPE_CLASSES[change.changeType]}>
            {t(
              CHANGE_TYPE_LABELS[change.changeType].key,
              CHANGE_TYPE_LABELS[change.changeType].fallback,
            )}
          </Pill>
          {change.risk && (
            <Pill className={RISK_CLASSES[change.risk]}>
              {t(CHANGE_RISK_LABELS[change.risk].key, CHANGE_RISK_LABELS[change.risk].fallback)}
            </Pill>
          )}
          {change.major && (
            <Pill className="bg-priority-p1-bg text-priority-p1">
              {t('change.majorShort', 'Major')}
            </Pill>
          )}
          {running && (
            <Pill className="bg-accent/15 text-accent">
              <Activity size={10} aria-hidden />
              {t('change.runningNow', 'Running now')}
            </Pill>
          )}
          {change.outcome && (
            <Pill className={OUTCOME_CLASSES[change.outcome]}>
              {t(
                CHANGE_OUTCOME_LABELS[change.outcome].key,
                CHANGE_OUTCOME_LABELS[change.outcome].fallback,
              )}
            </Pill>
          )}

          <span className="flex-1" />

          <button
            type="button"
            onClick={() => navigate(`/tickets/${change.ticketId}`)}
            className="rounded-pill bg-bg-tertiary px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-accent"
          >
            {t('change.openTicket', 'Open the ticket')}
          </button>
        </div>

        <h1 className="mt-2 font-display text-2xl font-semibold leading-tight tracking-wide text-text-primary">
          <Replace size={20} className="mr-2 inline-block text-accent" aria-hidden />
          {header?.subject ?? t('change.untitled', 'Change without a subject')}
        </h1>

        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <Fact label={t('change.fact.planned', 'Planned')}>
            {planned
              ? `${formatDateTime(planned.startAt)} → ${formatDateTime(planned.endAt)}`
              : t('change.noWindow', 'No window yet')}
          </Fact>
          <Fact label={t('change.fact.baseline', 'Approved for')}>
            <span
              title={t(
                'change.fact.baselineHint',
                'The window the approvals consented to. On-time delivery is measured against this, never against the current plan.',
              )}
            >
              {baseline
                ? `${formatDateTime(baseline.startAt)} → ${formatDateTime(baseline.endAt)}`
                : t('change.noBaseline', 'Not frozen')}
            </span>
          </Fact>
          <Fact label={t('change.fact.actual', 'Actual')}>
            {change.implementationStartedAt
              ? `${formatDateTime(change.implementationStartedAt)} → ${
                  change.implementationEndedAt
                    ? formatDateTime(change.implementationEndedAt)
                    : t('change.stillRunning', 'still running')
                }`
              : t('change.notStarted', 'not started')}
          </Fact>
          <Fact label={t('change.fact.model', 'Model')}>
            {change.modelSlug
              ? `${change.modelSlug} v${change.modelVersion ?? 0}`
              : t('change.noModel', 'none')}
          </Fact>
          <Fact label={t('change.fact.policy', 'Policy')}>
            <span
              title={t(
                'change.fact.policyHint',
                'Version 0 means no policy is published and the shipped baseline decided.',
              )}
            >
              {`${policy.policySlug} v${policy.policyVersion}`}
            </span>
          </Fact>
          {change.pirRequired && (
            <Fact label={t('change.fact.pirDue', 'Review due')}>
              <span title={formatAbsolute(change.pirDueAt)}>
                {change.pirCompletedAt
                  ? t('change.pirDone', 'done')
                  : change.pirDueAt
                    ? formatDateTime(change.pirDueAt)
                    : t('change.pirNotArmed', 'not armed yet')}
              </span>
            </Fact>
          )}
        </dl>
      </section>

      {/* ── The transition bar ───────────────────────────────────────────── */}
      <TransitionBar
        change={change}
        transitions={transitions}
        scheduleInput={scheduleInput}
        scheduleGate={scheduleGate}
        closureGate={closureGate}
        refusal={refusal}
        onRefused={setRefusal}
        onMoved={() => void load()}
      />

      <div className="grid gap-4 xl:grid-cols-3">
        {/* ── Main column ────────────────────────────────────────────────── */}
        <div className="space-y-4 xl:col-span-2">
          <PlanPanel
            change={change}
            canWrite={canWrite}
            worstCiCriticality={(change.worstCiCriticality ?? null) as ChangeCiCriticality | null}
            onSaveField={saveField}
          />

          <WindowPanel
            change={change}
            policy={policy}
            canSchedule={canSchedule}
            canWrite={canWrite}
            onAdopt={adopt}
            onConflict={(current) => {
              setChange(current);
              setConflicted(true);
            }}
            onRefused={setRefusal}
          />

          <ConflictPanel
            change={change}
            conflicts={conflictViews}
            classifications={classifications}
            ciNames={ciNames}
            canSchedule={canSchedule}
            onAdopt={adopt}
            onOpenChange={(id) => navigate(`/changes/${id}`)}
          />

          <FreezePanel
            change={change}
            verdicts={freezeVerdicts}
            approvals={approvals}
            actor={actor}
            canOverride={canOverrideFreeze}
            onAdopt={adopt}
          />

          <OutcomePanel
            change={change}
            canWrite={canWrite}
            reviewGate={reviewGate}
            onIncidentCount={setReviewIncidentCount}
            onAdopt={adopt}
            onRefused={setRefusal}
          />
        </div>

        {/* ── Right column ───────────────────────────────────────────────── */}
        <div className="space-y-4">
          <RiskPanel change={change} canWrite={canWrite} onAdopt={adopt} onSaveField={saveField} />

          <ApprovalPanel
            change={change}
            approvals={approvals}
            canWrite={canWrite}
            scheduleGate={scheduleGate}
            onStarted={() => void load()}
            onRefused={setRefusal}
          />

          <ItemPanel change={change} ciNames={ciNames} />
        </div>
      </div>

      <WhyDrawer
        ticketId={change.ticketId}
        ticketNumber={header?.number}
        open={whyOpen}
        onClose={() => setWhyOpen(false)}
      />
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The transition bar — HARD RULE 12's whole point
// ═════════════════════════════════════════════════════════════════════════════

function TransitionBar({
  change,
  transitions,
  scheduleInput,
  scheduleGate,
  closureGate,
  refusal,
  onRefused,
  onMoved,
}: {
  change: ChangeWithRelations;
  transitions: AvailableTransitions | null;
  scheduleInput: ChangeScheduleInput | null;
  scheduleGate: ChangeGateEvaluation;
  closureGate: ChangeGateEvaluation;
  refusal: ChangeRequirement[] | null;
  onRefused: (blockers: ChangeRequirement[] | null) => void;
  onMoved: () => void;
}): JSX.Element | null {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * The change gate for one destination, run by CATEGORY (HARD RULE 5).
   *
   * A transition whose target category the machine did not send cannot be
   * judged here — there is nothing to dispatch on. It is left to the machine's
   * own answer and to the server, which runs the same evaluator on the real
   * category inside the transaction. The button is never MORE permissive than
   * the server as a result: it simply stops adding a reason of its own.
   */
  const gateFor = useCallback(
    (category: StatusCategory | null): ChangeGateEvaluation | null => {
      if (!category || !scheduleInput) return null;
      if (category === 'scheduled') return scheduleGate;
      if (category === 'closed') return closureGate;
      return evaluateChangeTransition({ ...scheduleInput, toCategory: category });
    },
    [scheduleInput, scheduleGate, closureGate],
  );

  const options = transitions?.transitions ?? [];

  // The panel is not only the buttons: it is also the list of what is standing
  // in the way. So it survives a state machine that offers nothing right now —
  // hiding the reasons at exactly the moment there is nothing to click is the
  // opposite of what the list is for.
  const nothingToSay =
    options.length === 0 &&
    refusal === null &&
    scheduleGate.blockers.length === 0 &&
    scheduleGate.warnings.length === 0 &&
    closureGate.blockers.length === 0;
  if (nothingToSay) return null;

  async function fire(option: TransitionOption): Promise<void> {
    if (!change.ticket) return;
    setBusy(option.toStatusSlug);
    onRefused(null);
    try {
      await ticketsApi.transition(change.ticketId, {
        // HARD RULE 7 — the TICKET's version, not the change's. Two domains.
        baseRowVersion: change.ticket.rowVersion,
        toStatusSlug: option.toStatusSlug,
      });
      toast.success(t('change.moved', 'The change moved.'));
      onMoved();
    } catch (error) {
      const blockers = changeBlockersOf(error);
      if (blockers) {
        onRefused(blockers);
      } else {
        const evaluation = evaluationOf(error);
        toast.error(
          evaluation?.reason ??
            errorMessage(error, t('change.moveFailed', 'The change could not be moved.')),
        );
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-card bg-bg-secondary p-4 shadow-card">
      <PanelHeading icon={<CircleDot size={12} aria-hidden />}>
        {t('change.transitionHeading', 'Move this change')}
      </PanelHeading>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {options.map((option) => {
          const gate = gateFor(option.toCategory);
          const allowed = option.allowed && (gate?.allowed ?? true);
          const reasons = [
            ...(gate?.blockers ?? []).map((blocker) => t(blocker.key, blocker.fallback)),
            ...option.blocked.map((reason) => t(reason.i18nKey, reason.fallback, reason.params)),
          ];

          return (
            <Button
              key={option.toStatusSlug}
              size="sm"
              variant={option.toCategory === 'scheduled' ? 'primary' : 'secondary'}
              disabled={!allowed}
              loading={busy === option.toStatusSlug}
              title={reasons.length > 0 ? reasons.join(' · ') : undefined}
              onClick={() => void fire(option)}
            >
              {transitionLabel(option)}
            </Button>
          );
        })}
      </div>

      {/* The list under the buttons is the point: "grey" is not a reason. */}
      <RequirementList
        heading={t('change.blockedHeading', 'What is standing in the way')}
        blockers={dedupeByCode([
          ...scheduleGate.blockers,
          ...closureGate.blockers,
          ...(refusal ?? []),
        ])}
        missingCapabilities={[
          ...new Set([...scheduleGate.missingCapabilities, ...closureGate.missingCapabilities]),
        ]}
      />

      <RequirementList
        heading={t('change.warningHeading', 'Worth reading before you move it')}
        blockers={dedupeByCode(scheduleGate.warnings)}
        missingCapabilities={[]}
        tone="warn"
      />
    </section>
  );
}

function dedupeByCode(entries: readonly ChangeRequirement[]): ChangeRequirement[] {
  const seen = new Set<string>();
  const out: ChangeRequirement[] = [];
  for (const entry of entries) {
    const key = `${entry.code}|${entry.key}|${(entry.slugs ?? []).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// The three plans
// ═════════════════════════════════════════════════════════════════════════════

function PlanPanel({
  change,
  canWrite,
  worstCiCriticality,
  onSaveField,
}: {
  change: ChangeWithRelations;
  canWrite: boolean;
  worstCiCriticality: ChangeCiCriticality | null;
  onSaveField: (patch: Omit<UpdateChangeRequest, 'baseRowVersion'>) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();

  // The waiver is offered only where it is genuinely defensible, and the rule
  // reads the MATRIX band rather than the band in force: a human risk override
  // must be a way of disagreeing with the matrix, never a way of deleting a
  // requirement.
  const waiverAllowed = canWaiveBackout({
    matrixBand: change.riskComputed,
    worstCiCriticality,
  });

  return (
    <section className="rounded-card bg-bg-secondary p-5 shadow-card">
      <PanelHeading icon={<Hammer size={12} aria-hidden />}>
        {t('change.plansHeading', 'The three plans')}
      </PanelHeading>
      <p className="mt-1 text-[11px] leading-snug text-text-muted">
        {t(
          'change.plansHint',
          'Written before the approval is requested, because the plans are what the board reads. Nothing here is required until the change is scheduled.',
        )}
      </p>

      <div className="mt-3 space-y-3">
        <InlineField
          field="implementationMd"
          label={t('change.field.implementation', 'Implementation plan')}
          value={change.implementationMd}
          type="textarea"
          rows={6}
          readOnly={!canWrite}
          placeholder={t(
            'change.field.implementationPlaceholder',
            'Step by step: what is done, in what order, by whom…',
          )}
          onSave={(value) => onSaveField({ implementationMd: value })}
        />

        <InlineField
          field="testMd"
          label={t('change.field.test', 'Test plan')}
          value={change.testMd}
          type="textarea"
          rows={4}
          readOnly={!canWrite}
          placeholder={t('change.field.testPlaceholder', 'How will you know this worked?')}
          onSave={(value) => onSaveField({ testMd: value })}
        />

        <div className="rounded-card bg-bg-tertiary p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
              {t('change.field.backout', 'Backout plan')}
            </span>
            <Toggle
              checked={change.backoutNotApplicable}
              disabled={!canWrite}
              size="sm"
              label={t('change.field.backoutWaive', 'No backout is possible')}
              onChange={(next) => void onSaveField({ backoutNotApplicable: next })}
            />
          </div>

          {change.backoutNotApplicable ? (
            <div className="mt-2 space-y-2">
              <InlineField
                field="backoutWaiverReason"
                label={t('change.field.backoutWaiverReason', 'Why no backout is needed')}
                value={change.backoutWaiverReason}
                type="textarea"
                rows={3}
                readOnly={!canWrite}
                placeholder={t(
                  'change.field.backoutWaiverReasonPlaceholder',
                  'A waiver without a reason is a blank field with a tick next to it.',
                )}
                onSave={(value) => onSaveField({ backoutWaiverReason: value })}
              />
              {!waiverAllowed && (
                <p className="flex items-start gap-1.5 rounded-card bg-sla-warn-bg px-2.5 py-1.5 text-[11px] leading-snug text-sla-warn">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
                  {t(
                    'change.waiverNotAllowedHint',
                    'Only a low-risk change touching no critical item may waive its backout plan. This one may be saved, but it will not be allowed to schedule.',
                  )}
                </p>
              )}
            </div>
          ) : (
            <div className="mt-2">
              <InlineField
                field="backoutMd"
                label={t('change.field.backout', 'Backout plan')}
                value={change.backoutMd}
                type="textarea"
                rows={4}
                readOnly={!canWrite}
                placeholder={t(
                  'change.field.backoutPlaceholder',
                  'How the service is put back if this goes wrong…',
                )}
                onSave={(value) => onSaveField({ backoutMd: value })}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The window
// ═════════════════════════════════════════════════════════════════════════════

function WindowPanel({
  change,
  policy,
  canSchedule,
  canWrite,
  onAdopt,
  onConflict,
  onRefused,
}: {
  change: ChangeWithRelations;
  policy: ChangePolicyResolution;
  canSchedule: boolean;
  canWrite: boolean;
  onAdopt: (next: ChangeWithRelations) => void;
  onConflict: (current: ChangeWithRelations) => void;
  onRefused: (blockers: ChangeRequirement[] | null) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [startAt, setStartAt] = useState(() => toLocalInput(change.plannedStartAt));
  const [endAt, setEndAt] = useState(() => toLocalInput(change.plannedEndAt));
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);

  // The server is the source of truth; a window moved elsewhere replaces the
  // draft. There is no caret to steal here — these are two date pickers, not a
  // sentence somebody is in the middle of.
  useEffect(() => {
    setStartAt(toLocalInput(change.plannedStartAt));
    setEndAt(toLocalInput(change.plannedEndAt));
  }, [change.plannedStartAt, change.plannedEndAt]);

  const draftStart = fromLocalInput(startAt);
  const draftEnd = fromLocalInput(endAt);
  const complete = draftStart !== null && draftEnd !== null;
  const dirty =
    complete && (draftStart !== change.plannedStartAt || draftEnd !== change.plannedEndAt);

  const baseline = baselineWindowOf(change);
  const exceedsTolerance =
    complete &&
    changeWindowMoveExceedsTolerance(
      baseline,
      { startAt: draftStart, endAt: draftEnd },
      policy.windowMoveToleranceMinutes,
    );

  async function commit(): Promise<void> {
    if (!complete) return;
    setBusy(true);
    onRefused(null);
    try {
      const result = await changesApi.setWindow(change.ticketId, {
        baseRowVersion: change.rowVersion,
        plannedStartAt: draftStart,
        plannedEndAt: draftEnd,
      });
      onAdopt(result.change);
      // The conflicts came back with the mutation, while the picker is still
      // open. That is the whole reason this route answers with them.
      const collisions = result.conflicts.filter((entry) => entry.kind !== 'freeze_window').length;
      if (collisions > 0) {
        toast(
          t('change.windowSavedWithConflicts', 'Window saved. {{count}} conflicts to read below.', {
            count: collisions,
          }),
          { icon: '⚠' },
        );
      } else {
        toast.success(t('change.windowSaved', 'Window saved. Nothing collides with it.'));
      }
    } catch (error) {
      const current = changeConflictOf(error);
      if (current) {
        onConflict(current);
        return;
      }
      const blockers = changeBlockersOf(error);
      if (blockers) {
        onRefused(blockers);
        return;
      }
      toast.error(errorMessage(error, t('change.windowSaveFailed', 'The window could not be saved.')));
    } finally {
      setBusy(false);
    }
  }

  async function stamp(action: 'start' | 'finish'): Promise<void> {
    setRunning(true);
    try {
      onAdopt(
        action === 'start'
          ? await changesApi.startImplementation(change.ticketId, change.rowVersion)
          : await changesApi.finishImplementation(change.ticketId, change.rowVersion),
      );
    } catch (error) {
      const current = changeConflictOf(error);
      if (current) onConflict(current);
      else {
        toast.error(
          errorMessage(error, t('change.implementationFailed', 'That could not be recorded.')),
        );
      }
    } finally {
      setRunning(false);
    }
  }

  const live = isImplementing(change);

  return (
    <section className="rounded-card bg-bg-secondary p-5 shadow-card">
      <PanelHeading icon={<CalendarClock size={12} aria-hidden />}>
        {t('change.windowHeading', 'The maintenance window')}
      </PanelHeading>
      <p className="mt-1 text-[11px] leading-snug text-text-muted">
        {t(
          'change.windowHint',
          'Saving the window checks it against every other change on the same items straight away, so a collision is found while the date is still a proposal.',
        )}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label={t('change.field.plannedStart', 'Start')}>
          <input
            type="datetime-local"
            value={startAt}
            disabled={!canSchedule}
            onChange={(event) => setStartAt(event.target.value)}
            aria-label={t('change.field.plannedStart', 'Start')}
            className="w-full rounded-card bg-bg-tertiary px-2.5 py-1.5 font-mono text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
          />
        </Field>
        <Field label={t('change.field.plannedEnd', 'End')}>
          <input
            type="datetime-local"
            value={endAt}
            disabled={!canSchedule}
            onChange={(event) => setEndAt(event.target.value)}
            aria-label={t('change.field.plannedEnd', 'End')}
            className="w-full rounded-card bg-bg-tertiary px-2.5 py-1.5 font-mono text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
          />
        </Field>
      </div>

      {exceedsTolerance && (
        <p className="mt-2 flex items-start gap-1.5 rounded-card bg-sla-warn-bg px-2.5 py-1.5 text-[11px] leading-snug text-sla-warn">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
          {t(
            'change.windowMoveWarning',
            'This moves the window further than the policy tolerates, so the approvals already granted will be cancelled and asked again. An approval is consent to a specific window.',
          )}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={!canSchedule || !dirty}
          title={
            canSchedule
              ? undefined
              : t('change.needsSchedule', 'Committing to a window needs the scheduling permission.')
          }
          onClick={() => void commit()}
        >
          {t('change.saveWindow', 'Save the window')}
        </Button>

        {dirty && (
          <button
            type="button"
            onClick={() => {
              setStartAt(toLocalInput(change.plannedStartAt));
              setEndAt(toLocalInput(change.plannedEndAt));
            }}
            className="inline-flex items-center gap-1 rounded-pill px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
          >
            <RotateCcw size={11} aria-hidden />
            {t('change.resetWindow', 'Undo my edit')}
          </button>
        )}

        <span className="flex-1" />

        {/* The actual window: two explicit acts, never a side effect of a move. */}
        {!change.implementationStartedAt ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Activity size={14} />}
            loading={running}
            disabled={!canWrite}
            onClick={() => void stamp('start')}
            title={t(
              'change.startHint',
              'Records that the work has actually begun. This, not the status, is what says the change is running.',
            )}
          >
            {t('change.startImplementation', 'Work has started')}
          </Button>
        ) : live ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Check size={14} />}
            loading={running}
            disabled={!canWrite}
            onClick={() => void stamp('finish')}
          >
            {t('change.finishImplementation', 'Work has finished')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Conflicts
// ═════════════════════════════════════════════════════════════════════════════

function ConflictPanel({
  change,
  conflicts,
  classifications,
  ciNames,
  canSchedule,
  onAdopt,
  onOpenChange,
}: {
  change: ChangeWithRelations;
  conflicts: ChangeConflictView[];
  classifications: ChangeConflictClassification[];
  ciNames: Record<number, string>;
  canSchedule: boolean;
  onAdopt: (next: ChangeWithRelations) => void;
  onOpenChange: (ticketId: number) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [acknowledging, setAcknowledging] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  // A freeze is stored as a conflict row so the operator reads one panel, but
  // it is OVERRIDDEN and never acknowledged — different capability, different
  // columns, its own audit trail. Both sides compute the digest over exactly
  // this filtered set, which is why the filter is a shared function.
  const acknowledgeable = useMemo(
    () => acknowledgeableConflicts(conflicts),
    [conflicts],
  );
  const digest = useMemo(
    () => conflictDigest(acknowledgeableConflicts(classifications)),
    [classifications],
  );
  const ackCurrent = isConflictAckCurrent(change, classifications);

  async function acknowledge(): Promise<void> {
    setBusy(true);
    try {
      onAdopt(
        await changesApi.acknowledgeConflicts(change.ticketId, {
          baseRowVersion: change.rowVersion,
          reason: reason.trim(),
          digest,
        }),
      );
      toast.success(t('change.conflictAcknowledged', 'Conflicts acknowledged, with your reason.'));
      setAcknowledging(false);
      setReason('');
    } catch (error) {
      toast.error(
        errorMessage(error, t('change.acknowledgeFailed', 'The acknowledgement was refused.')),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card bg-bg-secondary p-5 shadow-card">
      <PanelHeading icon={<AlertCircle size={12} aria-hidden />}>
        {t('change.conflictHeading', 'What this window collides with')}
      </PanelHeading>

      {acknowledgeable.length === 0 ? (
        <p className="mt-2 text-[12px] leading-snug text-text-muted">
          {t(
            'change.noConflicts',
            'Nothing else is planned on these items in this window. Dependencies between items are not detected: this desk has no relationship graph, so an overlap is an exact match on an item, never a guess.',
          )}
        </p>
      ) : (
        <>
          <ul className="mt-3 flex flex-col gap-2">
            {acknowledgeable.map((conflict) => (
              <li key={conflict.id} className="rounded-card bg-bg-tertiary p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill className={CONFLICT_SEVERITY_CLASSES[conflict.severity]}>
                    {t(
                      CHANGE_CONFLICT_SEVERITY_LABELS[conflict.severity].key,
                      CHANGE_CONFLICT_SEVERITY_LABELS[conflict.severity].fallback,
                    )}
                  </Pill>

                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted">
                    {t(
                      CHANGE_CONFLICT_KIND_LABELS[conflict.kind].key,
                      CHANGE_CONFLICT_KIND_LABELS[conflict.kind].fallback,
                    )}
                  </span>

                  {conflict.otherTicketId !== null && (
                    <button
                      type="button"
                      onClick={() => onOpenChange(conflict.otherTicketId as number)}
                      className="rounded-pill bg-bg-hover px-2 py-0.5 font-mono text-[11px] text-text-secondary transition-colors hover:text-accent"
                    >
                      {conflict.otherNumber ?? `#${conflict.otherTicketId}`}
                    </button>
                  )}

                  <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">
                    {conflict.otherSubject ?? t('change.conflictUnnamed', 'Another change')}
                  </span>
                </div>

                {conflict.overlapStartAt && conflict.overlapEndAt && (
                  <p className="mt-1 font-mono text-[10px] text-text-muted">
                    {t('change.conflictOverlap', 'Overlap: {{from}} → {{to}}', {
                      from: formatDateTime(conflict.overlapStartAt),
                      to: formatDateTime(conflict.overlapEndAt),
                    })}
                  </p>
                )}

                {conflict.ciIds.length > 0 && (
                  <p className="mt-1 text-[11px] leading-snug text-text-muted">
                    {t('change.conflictItems', 'Shared items: {{items}}', {
                      // The fetched map is keyed by id and is the unambiguous
                      // reading; the row's own `ciNames` is positional, so it
                      // is only the fallback. Shared items are by definition a
                      // subset of this change's own, so the map covers them.
                      items: conflict.ciIds
                        .map((id, index) => ciNames[id] ?? conflict.ciNames?.[index] ?? `#${id}`)
                        .join(', '),
                    })}
                  </p>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {change.conflictAckAt && (
              <span
                className={clsx(
                  'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px]',
                  ackCurrent ? 'bg-sla-ok-bg text-sla-ok' : 'bg-sla-warn-bg text-sla-warn',
                )}
                title={change.conflictAckReason ?? undefined}
              >
                {ackCurrent
                  ? t('change.ackCurrent', 'Acknowledged {{when}}', {
                      when: formatDateTime(change.conflictAckAt),
                    })
                  : t('change.ackStale', 'The acknowledgement no longer covers these conflicts')}
              </span>
            )}

            <Button
              size="sm"
              variant={ackCurrent ? 'secondary' : 'primary'}
              disabled={!canSchedule}
              title={
                canSchedule
                  ? undefined
                  : t(
                      'change.needsSchedule',
                      'Committing to a window needs the scheduling permission.',
                    )
              }
              onClick={() => setAcknowledging(true)}
            >
              {t('change.acknowledgeConflicts', 'Acknowledge, in writing')}
            </Button>
          </div>
        </>
      )}

      <Modal
        open={acknowledging}
        onClose={() => setAcknowledging(false)}
        size="md"
        title={t('change.ackTitle', 'Acknowledge these conflicts')}
        subtitle={t(
          'change.ackSubtitle',
          'This is not a permanent state. It records that you have seen exactly these conflicts, and it lapses the moment a new one appears.',
        )}
        closeLabel={t('common.close', 'Close')}
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAcknowledging(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={reason.trim() === ''}
              title={
                reason.trim() === ''
                  ? t('change.ackNeedsReason', 'The sentence is what the post-mortem reads.')
                  : undefined
              }
              onClick={() => void acknowledge()}
            >
              {t('change.ackConfirm', 'Acknowledge')}
            </Button>
          </div>
        }
      >
        <Field
          label={t('change.field.ackReason', 'Why is this going ahead anyway?')}
          hint={t(
            'change.field.ackReasonHint',
            'Required. A named person, a timestamp and a sentence are the only artefacts that matter at the post-mortem.',
          )}
        >
          <textarea
            rows={4}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t(
              'change.field.ackReasonPlaceholder',
              'Both teams are in the same bridge, the switch work runs first…',
            )}
            className="w-full resize-y rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </Field>
      </Modal>
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Freezes
// ═════════════════════════════════════════════════════════════════════════════

function FreezePanel({
  change,
  verdicts,
  approvals,
  actor,
  canOverride,
  onAdopt,
}: {
  change: ChangeWithRelations;
  verdicts: ChangeFreezeVerdict[];
  approvals: Approval[];
  actor: ChangeActorContext;
  canOverride: boolean;
  onAdopt: (next: ChangeWithRelations) => void;
}): JSX.Element | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const granted = useMemo(
    () =>
      approvals
        .filter((approval) => approval.state === 'approved')
        .map((approval) => approval.definitionSlug),
    [approvals],
  );

  /**
   * MAY THIS PERSON BYPASS THESE FREEZES — a write question.
   *
   * Deliberately not `isChangeFrozen`, which is the read predicate that paints
   * the banner at the top of the page. Reusing a read predicate to authorise a
   * write is the defect the previous module's review found, and this is the one
   * place in this page where it would be tempting.
   */
  const gate = evaluateChangeFreezeOverride({
    verdicts,
    reason,
    grantedOverrideApprovals: granted,
    actor,
  });

  if (verdicts.length === 0) return null;

  const blocking = verdicts.filter((verdict) => verdict.severity === 'block');
  const alreadyOverridden = new Set(
    change.freezeOverrideAt ? change.freezeOverrideSlugs.map((slug) => slug.toLowerCase()) : [],
  );

  async function override(): Promise<void> {
    setBusy(true);
    try {
      onAdopt(
        await changesApi.overrideFreeze(change.ticketId, {
          baseRowVersion: change.rowVersion,
          reason: reason.trim(),
          slugs: blocking.map((verdict) => verdict.slug),
        }),
      );
      toast.success(
        t('change.freezeOverridden', 'Freeze overridden. It is in the decision log and the audit trail.'),
      );
      setOpen(false);
      setReason('');
    } catch (error) {
      toast.error(errorMessage(error, t('change.freezeOverrideFailed', 'The override was refused.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card bg-bg-secondary p-5 shadow-card">
      <PanelHeading icon={<Snowflake size={12} aria-hidden />}>
        {t('change.freezeHeading', 'Change freezes on this window')}
      </PanelHeading>

      <ul className="mt-3 flex flex-col gap-2">
        {verdicts.map((verdict) => {
          const bypassed = alreadyOverridden.has(verdict.slug.toLowerCase());
          return (
            <li key={`${verdict.slug}-${verdict.version}`} className="rounded-card bg-bg-tertiary p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Pill
                  className={
                    bypassed
                      ? 'bg-bg-hover text-text-muted'
                      : verdict.severity === 'block'
                        ? 'bg-sla-breach-bg text-sla-breach'
                        : 'bg-sla-warn-bg text-sla-warn'
                  }
                >
                  {bypassed
                    ? t('change.freezeBypassed', 'Overridden')
                    : verdict.severity === 'block'
                      ? t('change.freezeBlocks', 'Blocks')
                      : t('change.freezeWarns', 'Warns')}
                </Pill>
                <span className="font-mono text-[11px] text-text-muted">
                  {verdict.slug} v{verdict.version}
                </span>
              </div>

              <p className="mt-1 text-[12px] leading-snug text-text-secondary">
                {t(verdict.reasonKey, verdict.reason)}
              </p>

              {verdict.overrideApprovalSlug && (
                <p className="mt-1 text-[11px] leading-snug text-text-muted">
                  {t(
                    'change.freezeNeedsApproval',
                    'Overriding this one is not a click: the approval "{{slug}}" must be granted first.',
                    { slug: verdict.overrideApprovalSlug },
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {change.freezeOverrideAt && (
        <p className="mt-3 rounded-card bg-bg-tertiary px-3 py-2 text-[11px] leading-snug text-text-muted">
          {t('change.freezeOverrideRecord', 'Overridden on {{when}}: {{reason}}', {
            when: formatDateTime(change.freezeOverrideAt),
            reason: change.freezeOverrideReason ?? '',
          })}
        </p>
      )}

      {blocking.length > 0 && (
        <div className="mt-3">
          <Button
            size="sm"
            variant="danger"
            disabled={!canOverride}
            title={
              canOverride
                ? undefined
                : t(
                    'change.needsFreezeOverride',
                    'Overriding a change freeze needs the change-freeze override permission.',
                  )
            }
            onClick={() => setOpen(true)}
          >
            {t('change.overrideFreeze', 'Override the freeze')}
          </Button>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="md"
        title={t('change.freezeOverrideTitle', 'Override the freeze')}
        subtitle={t(
          'change.freezeOverrideSubtitle',
          'This lands in four places at once: the change, the decision log, the audit trail and the ticket journal. It is meant to be visible.',
        )}
        closeLabel={t('common.close', 'Close')}
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              disabled={!gate.allowed}
              onClick={() => void override()}
            >
              {t('change.overrideConfirm', 'Override')}
            </Button>
          </div>
        }
      >
        <Field
          label={t('change.field.freezeReason', 'Why must this go ahead inside the freeze?')}
          hint={t(
            'change.field.freezeReasonHint',
            'Required. This sentence is what the post-mortem reads, and it is the whole reason an override is allowed at all.',
          )}
        >
          <textarea
            rows={4}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t(
              'change.field.freezeReasonPlaceholder',
              'Security fix for an actively exploited flaw, agreed with the service owner…',
            )}
            className="w-full resize-y rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </Field>

        <RequirementList
          heading={t('change.blockedHeading', 'What is standing in the way')}
          blockers={gate.blockers}
          missingCapabilities={gate.missingCapabilities}
        />
      </Modal>
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Outcome and the post-implementation review
// ═════════════════════════════════════════════════════════════════════════════

function OutcomePanel({
  change,
  canWrite,
  reviewGate,
  onIncidentCount,
  onAdopt,
  onRefused,
}: {
  change: ChangeWithRelations;
  canWrite: boolean;
  reviewGate: ChangeGateEvaluation;
  onIncidentCount: (count: number) => void;
  onAdopt: (next: ChangeWithRelations) => void;
  onRefused: (blockers: ChangeRequirement[] | null) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [outcome, setOutcome] = useState<ChangeOutcome | ''>(change.outcome ?? '');
  const [findings, setFindings] = useState(change.pirFindingsMd ?? '');
  const [causedIncident, setCausedIncident] = useState<boolean | null>(change.pirCausedIncident);
  const [incidentIds, setIncidentIds] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    setOutcome(change.outcome ?? '');
    setFindings(change.pirFindingsMd ?? '');
    setCausedIncident(change.pirCausedIncident);
  }, [change.outcome, change.pirFindingsMd, change.pirCausedIncident]);

  const parsedIncidents = useMemo(
    () =>
      incidentIds
        .split(/[,\s]+/)
        .map((entry) => Number(entry.trim()))
        .filter((value) => Number.isInteger(value) && value > 0),
    [incidentIds],
  );

  useEffect(() => {
    onIncidentCount(parsedIncidents.length);
  }, [parsedIncidents.length, onIncidentCount]);

  async function record(): Promise<void> {
    if (outcome === '') return;
    setBusy(true);
    try {
      onAdopt(
        await changesApi.recordOutcome(change.ticketId, {
          baseRowVersion: change.rowVersion,
          outcome,
        }),
      );
      toast.success(t('change.outcomeRecorded', 'Outcome recorded. The review, if owed, is armed.'));
    } catch (error) {
      toast.error(errorMessage(error, t('change.outcomeFailed', 'The outcome could not be recorded.')));
    } finally {
      setBusy(false);
    }
  }

  async function complete(): Promise<void> {
    if (causedIncident === null) return;
    setReviewing(true);
    onRefused(null);
    try {
      onAdopt(
        await changesApi.completeReview(change.ticketId, {
          baseRowVersion: change.rowVersion,
          pirFindingsMd: findings.trim(),
          pirCausedIncident: causedIncident,
          incidentTicketIds: parsedIncidents.length > 0 ? parsedIncidents : undefined,
        }),
      );
      toast.success(t('change.pirCompleted', 'Review recorded.'));
    } catch (error) {
      const blockers = changeBlockersOf(error);
      if (blockers) onRefused(blockers);
      else {
        toast.error(errorMessage(error, t('change.pirFailed', 'The review could not be recorded.')));
      }
    } finally {
      setReviewing(false);
    }
  }

  return (
    <section className="rounded-card bg-bg-secondary p-5 shadow-card">
      <PanelHeading icon={<ClipboardCheck size={12} aria-hidden />}>
        {t('change.outcomeHeading', 'What happened, and what it taught us')}
      </PanelHeading>

      {/* ── The outcome ────────────────────────────────────────────────── */}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label={t('change.field.outcome', 'Outcome')}>
          <select
            value={outcome}
            disabled={!canWrite}
            onChange={(event) => setOutcome(event.target.value as ChangeOutcome | '')}
            aria-label={t('change.field.outcome', 'Outcome')}
            className="rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60 [&>option]:bg-bg-secondary [&>option]:text-text-primary"
          >
            <option value="">{t('change.outcomeUnset', 'Not recorded')}</option>
            {CHANGE_OUTCOMES.map((entry) => (
              <option key={entry} value={entry}>
                {t(CHANGE_OUTCOME_LABELS[entry].key, CHANGE_OUTCOME_LABELS[entry].fallback)}
              </option>
            ))}
          </select>
        </Field>

        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={!canWrite || outcome === '' || outcome === change.outcome}
          onClick={() => void record()}
        >
          {t('change.recordOutcome', 'Record the outcome')}
        </Button>
      </div>

      <p className="mt-2 text-[11px] leading-snug text-text-muted">
        {t(
          'change.outcomeHint',
          '"Successful, with issues" exists so a change that worked but overran is neither a triumph nor a failure. Forcing that choice is what makes a change failure rate meaningless.',
        )}
      </p>

      {/* ── The review ─────────────────────────────────────────────────── */}
      {change.pirRequired && (
        <div className="mt-4 rounded-card bg-bg-tertiary p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
              {t('change.pirHeading', 'Post-implementation review')}
            </span>
            {change.pirCompletedAt && (
              <Pill className="bg-sla-ok-bg text-sla-ok">
                {t('change.pirDoneOn', 'Completed {{when}}', {
                  when: formatDateTime(change.pirCompletedAt),
                })}
              </Pill>
            )}
          </div>

          <div className="mt-2 space-y-3">
            <Field
              label={t('change.field.pirFindings', 'What did the review find?')}
              hint={t('change.field.pirFindingsHint', '"Went fine" is not a finding.')}
            >
              <textarea
                rows={4}
                value={findings}
                disabled={!canWrite}
                onChange={(event) => setFindings(event.target.value)}
                placeholder={t(
                  'change.field.pirFindingsPlaceholder',
                  'What was learned, what was slower than planned, what would be done differently…',
                )}
                className="w-full resize-y rounded-card bg-bg-secondary px-2.5 py-1.5 text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
              />
            </Field>

            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                {t('change.field.pirCausedIncident', 'Did this change cause an incident?')}
              </span>
              <Choice
                active={causedIncident === false}
                disabled={!canWrite}
                onClick={() => setCausedIncident(false)}
              >
                {t('common.no', 'No')}
              </Choice>
              <Choice
                active={causedIncident === true}
                disabled={!canWrite}
                onClick={() => setCausedIncident(true)}
              >
                {t('common.yes', 'Yes')}
              </Choice>
            </div>

            {causedIncident === true && (
              <Field
                label={t('change.field.pirIncidents', 'Which incidents?')}
                hint={t(
                  'change.field.pirIncidentsHint',
                  'Ticket numbers, separated by commas. An unlinked yes cannot be counted, so the change failure rate would quietly stay at zero.',
                )}
              >
                <input
                  type="text"
                  value={incidentIds}
                  disabled={!canWrite}
                  onChange={(event) => setIncidentIds(event.target.value)}
                  placeholder="1042, 1043"
                  className="w-full rounded-card bg-bg-secondary px-2.5 py-1.5 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
                />
              </Field>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                loading={reviewing}
                disabled={!canWrite || !reviewGate.allowed || change.pirCompletedAt !== null}
                onClick={() => void complete()}
              >
                {t('change.completeReview', 'Complete the review')}
              </Button>
            </div>

            {change.pirCompletedAt === null && (
              <RequirementList
                heading={t('change.reviewBlockedHeading', 'The review is not complete yet')}
                blockers={reviewGate.blockers}
                missingCapabilities={reviewGate.missingCapabilities}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Risk
// ═════════════════════════════════════════════════════════════════════════════

function RiskPanel({
  change,
  canWrite,
  onAdopt,
  onSaveField,
}: {
  change: ChangeWithRelations;
  canWrite: boolean;
  onAdopt: (next: ChangeWithRelations) => void;
  onSaveField: (patch: Omit<UpdateChangeRequest, 'baseRowVersion'>) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [band, setBand] = useState<ChangeRisk>(change.risk ?? 'medium');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  // The dialog opens on the band actually in force, not on the one that was in
  // force when this panel first mounted. A recompute between the two would
  // otherwise pre-select a band nobody is looking at any more.
  useEffect(() => {
    if (open) setBand(change.risk ?? 'medium');
  }, [open, change.risk]);

  async function override(): Promise<void> {
    setBusy(true);
    try {
      onAdopt(
        await changesApi.overrideRisk(change.ticketId, {
          baseRowVersion: change.rowVersion,
          risk: band,
          reason: reason.trim(),
        }),
      );
      toast.success(t('change.riskOverridden', 'Risk overridden, with your reason on the record.'));
      setOpen(false);
      setReason('');
    } catch (error) {
      toast.error(errorMessage(error, t('change.riskOverrideFailed', 'The override was refused.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card bg-bg-secondary p-5 shadow-card">
      <PanelHeading icon={<ShieldCheck size={12} aria-hidden />}>
        {t('change.riskHeading', 'Risk')}
      </PanelHeading>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Fact label={t('change.riskComputed', 'What the matrix said')}>
          {change.riskComputed
            ? t(
                CHANGE_RISK_LABELS[change.riskComputed].key,
                CHANGE_RISK_LABELS[change.riskComputed].fallback,
              )
            : t('change.riskUnrated', 'Not rated')}
        </Fact>
        <Fact label={t('change.riskInForce', 'Band in force')}>
          {change.risk
            ? t(CHANGE_RISK_LABELS[change.risk].key, CHANGE_RISK_LABELS[change.risk].fallback)
            : t('change.riskUnrated', 'Not rated')}
        </Fact>
      </div>

      {change.riskOverriddenAt && (
        <p className="mt-2 rounded-card bg-bg-tertiary px-3 py-2 text-[11px] leading-snug text-text-muted">
          {t('change.riskOverrideRecord', 'Overridden on {{when}}: {{reason}}', {
            when: formatDateTime(change.riskOverriddenAt),
            reason: change.riskOverrideReason ?? '',
          })}
        </p>
      )}

      <div className="mt-3 space-y-3">
        <Field
          label={t('change.field.likelihood', 'How likely is this to go wrong?')}
          hint={t(
            'change.field.likelihoodHint',
            'One axis of the matrix. The other is the impact, which lives on the ticket.',
          )}
        >
          <select
            value={change.failureLikelihood ?? ''}
            disabled={!canWrite}
            aria-label={t('change.field.likelihood', 'How likely is this to go wrong?')}
            onChange={(event) =>
              void onSaveField({
                failureLikelihood: (event.target.value || null) as FailureLikelihood | null,
              })
            }
            className="w-full rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60 [&>option]:bg-bg-secondary [&>option]:text-text-primary"
          >
            <option value="">{t('change.likelihoodUnset', 'Not rated (read as medium)')}</option>
            {FAILURE_LIKELIHOODS.map((entry) => (
              <option key={entry} value={entry}>
                {t(FAILURE_LIKELIHOOD_LABELS[entry].key, FAILURE_LIKELIHOOD_LABELS[entry].fallback)}
              </option>
            ))}
          </select>
        </Field>

        <Button size="sm" variant="secondary" disabled={!canWrite} onClick={() => setOpen(true)}>
          {t('change.overrideRisk', 'Disagree with the matrix')}
        </Button>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="md"
        title={t('change.riskOverrideTitle', 'Override the computed risk')}
        subtitle={t(
          'change.riskOverrideSubtitle',
          'What the matrix said is kept beside what you decided. The override never unlocks the backout waiver: that reads the matrix band on purpose.',
        )}
        closeLabel={t('common.close', 'Close')}
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={reason.trim() === ''}
              title={
                reason.trim() === ''
                  ? t('change.riskNeedsReason', 'An override without a reason is a number nobody can defend.')
                  : undefined
              }
              onClick={() => void override()}
            >
              {t('change.riskOverrideConfirm', 'Override')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={t('change.field.riskBand', 'Band')}>
            <select
              value={band}
              onChange={(event) => setBand(event.target.value as ChangeRisk)}
              className="w-full rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent [&>option]:bg-bg-secondary [&>option]:text-text-primary"
            >
              {CHANGE_RISKS.map((entry) => (
                <option key={entry} value={entry}>
                  {t(CHANGE_RISK_LABELS[entry].key, CHANGE_RISK_LABELS[entry].fallback)}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('change.field.riskReason', 'Why?')}>
            <textarea
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t(
                'change.field.riskReasonPlaceholder',
                'The matrix does not know this is a rehearsed failover we run monthly…',
              )}
              className="w-full resize-y rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </Field>
        </div>
      </Modal>
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Approvals
// ═════════════════════════════════════════════════════════════════════════════

function ApprovalPanel({
  change,
  approvals,
  canWrite,
  scheduleGate,
  onStarted,
  onRefused,
}: {
  change: ChangeWithRelations;
  approvals: Approval[];
  canWrite: boolean;
  scheduleGate: ChangeGateEvaluation;
  onStarted: () => void;
  onRefused: (blockers: ChangeRequirement[] | null) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const selected = change.selectedApprovals ?? [];

  async function request(): Promise<void> {
    setBusy(true);
    onRefused(null);
    try {
      const result = await changesApi.requestApprovals(change.ticketId, change.rowVersion);
      if (result.started.length === 0) {
        // "No approval was needed" is an answer, not an absence — the engine
        // writes a decision row saying so, and the toast says the same thing.
        toast(t('change.noApprovalNeeded', 'This change needs no approval under its policy.'));
      } else {
        toast.success(
          t('change.approvalsStarted', '{{count}} approvals requested.', {
            count: result.started.length,
          }),
        );
      }
      onStarted();
    } catch (error) {
      const blockers = changeBlockersOf(error);
      if (blockers) onRefused(blockers);
      else {
        toast.error(
          errorMessage(error, t('change.approvalsFailed', 'The approvals could not be requested.')),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card bg-bg-secondary p-5 shadow-card">
      <PanelHeading icon={<Users size={12} aria-hidden />}>
        {t('change.approvalHeading', 'Who has to say yes')}
      </PanelHeading>

      {selected.length > 0 && (
        <div className="mt-3">
          <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
            {t('change.approvalsSelected', 'Selected by the policy')}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {selected.map((entry) => (
              <li key={entry.slug} className="text-[12px] leading-snug text-text-secondary">
                <span className="font-mono">{entry.slug}</span>{' '}
                <span className="text-text-muted">
                  {t(
                    APPROVAL_REASON_LABELS[entry.because]?.key ?? 'change.approvalBecause.type',
                    APPROVAL_REASON_LABELS[entry.because]?.fallback ?? entry.because,
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {approvals.length === 0 ? (
        <p className="mt-3 text-[12px] leading-snug text-text-muted">
          {t(
            'change.noApprovalsYet',
            'Nothing has been asked yet. Requesting the approvals runs the schedule gate first, because the board reads the plans.',
          )}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {approvals.map((approval) => (
            <li key={approval.id} className="rounded-card bg-bg-tertiary p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Pill className={APPROVAL_STATE_CLASSES[approval.state]}>
                  {t(
                    APPROVAL_STATE_LABELS[approval.state].key,
                    APPROVAL_STATE_LABELS[approval.state].fallback,
                  )}
                </Pill>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">
                  {approval.definitionSlug}
                </span>
              </div>

              {(approval.steps ?? []).length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {(approval.steps ?? []).map((step) => (
                    <li
                      key={step.id}
                      className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted"
                    >
                      <span className="font-mono">{`#${step.stepIndex + 1}`}</span>
                      <span className="text-text-secondary">
                        {step.approver?.displayName?.trim() ||
                          step.approver?.username ||
                          (step.approverGroupId !== null
                            ? t('change.approverGroup', 'a group')
                            : t('change.approverUnknown', 'nobody resolved'))}
                      </span>
                      <span aria-hidden>·</span>
                      <span>
                        {step.state === 'pending'
                          ? t('change.stepWaiting', 'still owed')
                          : t('change.stepAnswered', 'answered {{when}}', {
                              when: formatDateTime(step.decidedAt),
                            })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {approval.dueAt && approval.state === 'pending' && (
                <p className="mt-1 font-mono text-[10px] text-text-muted">
                  {t('change.approvalDue', 'Due {{when}}', {
                    when: formatDateTime(approval.dueAt),
                  })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3">
        <Button
          size="sm"
          variant="secondary"
          fullWidth
          loading={busy}
          // HARD RULE 12 — the SAME gate the route runs before it starts
          // anything. The board reads the plans, so the plans must exist when
          // the approval is REQUESTED, not when it is answered. The reasons are
          // listed under the transition bar rather than repeated here.
          disabled={!canWrite || !scheduleGate.allowed}
          title={
            scheduleGate.allowed
              ? undefined
              : t(
                  'change.approvalNeedsPlans',
                  'The board reads the plans, so the schedule gate runs before the approvals are asked. What is missing is listed under the transition bar.',
                )
          }
          onClick={() => void request()}
        >
          {t('change.requestApprovals', 'Request the approvals')}
        </Button>
      </div>
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The items this change touches
// ═════════════════════════════════════════════════════════════════════════════

function ItemPanel({
  change,
  ciNames,
}: {
  change: ChangeWithRelations;
  ciNames: Record<number, string>;
}): JSX.Element {
  const { t } = useTranslation();
  const ids = change.ciIds ?? [];

  return (
    <section className="rounded-card bg-bg-secondary p-5 shadow-card">
      <PanelHeading icon={<Server size={12} aria-hidden />}>
        {t('change.itemsHeading', 'Items this change touches')}
      </PanelHeading>

      {ids.length === 0 ? (
        <p className="mt-2 text-[12px] leading-snug text-text-muted">
          {t(
            'change.noItems',
            'Nothing is linked yet. Conflicts are detected on the items linked to the ticket as primary or affected, so an unlinked change collides with nothing and warns about nothing.',
          )}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-1">
          {ids.map((id) => (
            <Link
              key={id}
              to={`/assets/${id}`}
              className="rounded-pill bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-accent"
            >
              {ciNames[id] ?? `#${id}`}
            </Link>
          ))}
        </div>
      )}

      {change.worstCiCriticality && (
        <p className="mt-2 text-[11px] leading-snug text-text-muted">
          {t('change.worstCriticality', 'Worst criticality among them: {{value}}', {
            value: change.worstCiCriticality,
          })}
        </p>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Small local pieces
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What stands between the actor and the action, in the evaluator's own words.
 * The list IS the feature: "the button is grey" without a reason is how an
 * agent learns to fight the form instead of doing the work.
 */
function RequirementList({
  heading,
  blockers,
  missingCapabilities,
  tone = 'block',
}: {
  heading: string;
  blockers: ChangeRequirement[];
  missingCapabilities: Capability[];
  tone?: 'block' | 'warn';
}): JSX.Element | null {
  const { t } = useTranslation();
  if (blockers.length === 0 && missingCapabilities.length === 0) return null;

  return (
    <div className="mt-3 rounded-card bg-bg-tertiary p-3">
      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">{heading}</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {blockers.map((blocker) => (
          <li
            key={`${blocker.code}-${blocker.key}-${(blocker.slugs ?? []).join(',')}`}
            className="flex items-start gap-1.5 text-[12px] leading-snug text-text-secondary"
          >
            <CircleDot
              size={11}
              className={clsx('mt-0.5 shrink-0', tone === 'warn' ? 'text-sla-warn' : 'text-sla-breach')}
              aria-hidden
            />
            <span>
              {t(blocker.key, blocker.fallback, blocker.params)}
              {blocker.refs && blocker.refs.length > 0 && (
                <span className="ml-1 font-mono text-[10px] text-text-muted">
                  {blocker.refs.map((ref) => `#${ref}`).join(' ')}
                </span>
              )}
            </span>
          </li>
        ))}
        {missingCapabilities.map((capability) => (
          <li
            key={capability}
            className="flex items-start gap-1.5 text-[12px] leading-snug text-text-secondary"
          >
            <CircleDot size={11} className="mt-0.5 shrink-0 text-sla-breach" aria-hidden />
            <span>
              {t('change.missingCapability', 'You are missing the permission "{{capability}}".', {
                capability,
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Banner({
  tone,
  children,
  onDismiss,
  dismissLabel,
}: {
  tone: 'warn';
  children: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}): JSX.Element {
  return (
    <div
      className={clsx(
        'flex flex-wrap items-center gap-3 rounded-card px-4 py-3 shadow-card',
        tone === 'warn' && 'bg-sla-warn-bg',
      )}
    >
      <AlertTriangle size={15} className="shrink-0 text-sla-warn" aria-hidden />
      <p className="min-w-0 flex-1 text-[13px] leading-snug text-sla-warn">{children}</p>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel ?? ''}
          className="rounded-pill p-1 text-sla-warn transition-colors hover:bg-bg-hover"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** HARD RULE 11 — a pill is a tinted background, never an outline. */
function Pill({ className, children }: { className: string; children: ReactNode }): JSX.Element {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px]',
        className,
      )}
    >
      {children}
    </span>
  );
}

function Choice({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'rounded-pill px-2.5 py-1 text-[11px] transition-colors disabled:opacity-50',
        active
          ? 'bg-accent/12 text-accent'
          : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover hover:text-text-secondary',
      )}
    >
      {children}
    </button>
  );
}

function PanelHeading({ icon, children }: { icon: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <h2 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
      {icon}
      {children}
    </h2>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <dt className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">{label}</dt>
      <dd className="mt-0.5 font-mono text-[12px] text-text-secondary">{children}</dd>
    </div>
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

function NotFoundCard({ title, body }: { title: string; body: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="p-6">
      <div className="mx-auto max-w-md space-y-3 rounded-card bg-bg-secondary p-8 text-center shadow-card">
        <h1 className="font-display text-xl font-semibold tracking-wide text-text-primary">
          {title}
        </h1>
        <p className="text-[13px] leading-relaxed text-text-muted">{body}</p>
        <Link to="/changes">
          <Button size="sm" variant="secondary" icon={<ArrowLeft size={14} />}>
            {t('change.backToList', 'All changes')}
          </Button>
        </Link>
      </div>
    </div>
  );
}

export default ChangeDetailPage;
