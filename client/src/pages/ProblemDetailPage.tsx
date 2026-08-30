/**
 * ProblemDetailPage — `/problems/:id`
 *
 * The problem folder. Four things live here and they are deliberately not four
 * equal panels:
 *
 *   1. THE ANALYSIS TREE, which owns the main column. Five whys is a chain,
 *      Ishikawa is a two-level fan, and they are the SAME data (`problem_causes`
 *      with a parent and a category) rendered two ways. So the view toggle is a
 *      toggle, not two editors: adding a why under a node in the chain puts a
 *      bone on the fishbone, and neither view can produce something the other
 *      cannot show.
 *
 *   2. THE LINKED INCIDENTS, each with the weight it carries in the closure
 *      cascade. `planClosureCascade` is the arithmetic on both sides, but the
 *      POPULATION is not the same on both sides: the list below is ONE server
 *      page, while the cascade acts on every linked incident. So the rows are
 *      classified here, from what is on screen, and every COUNT the operator
 *      reads — the tiles, the truncation warning, the confirm dialog — comes
 *      from the server's own preview, which runs the same function over all of
 *      them. A figure that quantifies a bulk mutation of customer-facing
 *      tickets must never be the total of the visible slice.
 *
 *   3. THE WORKAROUND and its publication as a known error.
 *
 *   4. THE WHY PANEL, a straight read of `decision_log` through the same drawer
 *      the ticket page uses.
 *
 * ── HARD RULE 12, and where it stops ────────────────────────────────────────
 * Every field on this page autosaves on its own and validates nothing. An
 * analysis can sit half written for three weeks. Completeness is demanded at
 * exactly two moments, by exactly two shared functions:
 * `evaluateAnalysisTransition` for a state change, `evaluateKnownErrorPublication`
 * for publishing. Those are the SAME functions the server calls to refuse, so
 * the greyed-out button and the 422 always say the same words, and the panel
 * under the button lists them rather than making the agent guess.
 *
 * ── HARD RULE 7, twice ──────────────────────────────────────────────────────
 * Three separate row versions cross this page: `problems.row_version` (the
 * folder), `problem_analyses.row_version` (the workshop) and
 * `problem_causes.row_version` (one node). They are separate concurrency
 * domains on purpose: a facilitator typing into a why must not 409 the team
 * lead editing the workaround. Each save sends the version it read; a mismatch
 * comes back as a 409 carrying the current row, and ALL THREE rebase on it
 * rather than silently overwriting — the folder through the banner, the
 * workshop by putting the server's row straight back into the node under the
 * server's own message. Rebasing is not courtesy: the version left in state is
 * the base of the NEXT save, so a domain that drops the payload keeps
 * re-sending a version that has already lost, and the node stops saving at all.
 *
 * HARD RULE 11 — no border on any card, pill or button below.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  CornerDownRight,
  Flame,
  GitBranch,
  Link2,
  Network,
  Paperclip,
  Plus,
  RefreshCw,
  Siren,
  Target,
  Trash2,
  Unlink,
  Wrench,
  X,
} from 'lucide-react';
import {
  CAPABILITIES,
  CAUSE_CATEGORIES,
  CAUSE_CATEGORY_LABELS,
  CAUSE_CONFIDENCES,
  CAUSE_CONFIDENCE_LABELS,
  CAUSE_CONFIRMATION_METHODS,
  CAUSE_CONFIRMATION_METHOD_LABELS,
  CAUSE_KINDS,
  CAUSE_KIND_LABELS,
  CASCADE_BLOCK_REASON_LABELS,
  CASCADE_BUCKET_LABELS,
  KNOWN_ERROR_STATE_LABELS,
  PROBLEM_ANALYSIS_STATE_LABELS,
  PROBLEM_ANALYSIS_TRANSITIONS,
  PROBLEM_CLOSURE_POLICIES,
  PROBLEM_CLOSURE_POLICY_LABELS,
  PROBLEM_DETECTED_BY_LABELS,
  PROBLEM_EVIDENCE_TYPES,
  RCA_METHODS,
  RCA_METHOD_LABELS,
  WORKAROUND_RISKS,
  WORKAROUND_RISK_LABELS,
  evaluateAnalysisTransition,
  evaluateCauseConfirmation,
  evaluateKnownErrorPublication,
  planClosureCascade,
  statusCategoryLabel,
} from '@oblidesk/shared';
import type {
  AddProblemCauseEvidenceRequest,
  AnalysisCauseSnapshot,
  CascadeBucket,
  CascadeIncidentSnapshot,
  CascadePlan,
  CauseCategory,
  CauseConfidence,
  CauseConfirmationMethod,
  CauseKind,
  KnownErrorState,
  ProblemActorContext,
  ProblemAlertSignature,
  ProblemAnalysisState,
  ProblemAnalysisWithCauses,
  ProblemCause,
  ProblemClosurePolicy,
  ProblemEvidenceType,
  ProblemRequirement,
  ProblemWithRelations,
  RcaMethod,
  UpdateProblemRequest,
  WorkaroundRisk,
} from '@oblidesk/shared';
import { errorMessage } from '@/api/client';
import problemsApi, { problemConflictOf } from '@/api/problems.api';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { Toggle } from '@/components/common/Toggle';
import InlineField from '@/components/tickets/InlineField';
import StatusPill from '@/components/tickets/StatusPill';
import WhyDrawer from '@/components/tickets/WhyDrawer';
import { formatAbsolute, formatRelative } from '@/components/tickets/SlaChip';
import { useAuthStore } from '@/store/authStore';

// ═════════════════════════════════════════════════════════════════════════════
// Literal class tables — Tailwind cannot see a concatenated class name
// ═════════════════════════════════════════════════════════════════════════════

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

const ANALYSIS_STATE_CLASSES: Readonly<Record<ProblemAnalysisState, string>> = {
  draft: 'bg-bg-tertiary text-text-muted',
  in_review: 'bg-status-scheduled-bg text-status-scheduled',
  concluded: 'bg-sla-ok-bg text-sla-ok',
  superseded: 'bg-status-closed-bg text-status-closed',
  abandoned: 'bg-status-cancelled-bg text-status-cancelled',
};

const CONFIDENCE_CLASSES: Readonly<Record<CauseConfidence, string>> = {
  suspected: 'bg-bg-hover text-text-muted',
  probable: 'bg-status-scheduled-bg text-status-scheduled',
  confirmed: 'bg-sla-ok-bg text-sla-ok',
  refuted: 'bg-status-cancelled-bg text-status-cancelled',
};

const KIND_CLASSES: Readonly<Record<CauseKind, string>> = {
  cause: 'bg-accent/12 text-accent',
  contributing: 'bg-bg-hover text-text-secondary',
  trigger: 'bg-sla-warn-bg text-sla-warn',
  non_cause: 'bg-status-cancelled-bg text-status-cancelled',
};

const BUCKET_CLASSES: Readonly<Record<CascadeBucket, string>> = {
  skipped_terminal: 'bg-status-closed-bg text-status-closed',
  blocked_human_waiting: 'bg-sla-warn-bg text-sla-warn',
  auto_resolved: 'bg-sla-ok-bg text-sla-ok',
  worked_not_waiting: 'bg-accent/12 text-accent',
};

/** No shared map exists for these: they name an artefact, not a domain state. */
const EVIDENCE_TYPE_LABELS: Readonly<Record<ProblemEvidenceType, { key: string; fallback: string }>> = {
  ticket_evidence: { key: 'problem.evidenceType.ticketEvidence', fallback: 'Evidence on a ticket' },
  ci: { key: 'problem.evidenceType.ci', fallback: 'Configuration item' },
  alert: { key: 'problem.evidenceType.alert', fallback: 'Suite alert' },
  ticket: { key: 'problem.evidenceType.ticket', fallback: 'Ticket' },
  journal: { key: 'problem.evidenceType.journal', fallback: 'Journal entry' },
  kb_article: { key: 'problem.evidenceType.kbArticle', fallback: 'Knowledge article' },
  external: { key: 'problem.evidenceType.external', fallback: 'External link' },
};

/** Which key of the request each evidence type fills. Exactly one is non-null. */
const EVIDENCE_TARGET_KEY: Readonly<
  Record<Exclude<ProblemEvidenceType, 'external'>, keyof AddProblemCauseEvidenceRequest>
> = {
  ticket_evidence: 'ticketEvidenceId',
  ci: 'ciId',
  alert: 'alertId',
  ticket: 'ticketId',
  journal: 'journalId',
  kb_article: 'kbArticleId',
};

type RcaView = 'chain' | 'fishbone';

/**
 * Nothing more can be written to an analysis in one of these three states, and
 * `PROBLEM_ANALYSIS_TRANSITIONS` gives all three nowhere to go. They are the
 * states in which the workshop MUST offer another door, and the same predicate
 * greys the editors and renders that door so the two cannot drift apart.
 */
function isWorkshopClosed(state: ProblemAnalysisState): boolean {
  return state === 'concluded' || state === 'superseded' || state === 'abandoned';
}

// ═════════════════════════════════════════════════════════════════════════════
// Time helpers for the two datetime inputs on this page
// ═════════════════════════════════════════════════════════════════════════════

/** ISO instant to the `datetime-local` shape the browser wants. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** Back to a full ISO instant, or null when the field was cleared. */
function fromLocalInput(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function evidenceCountOf(cause: ProblemCause): number {
  return cause.evidenceCount ?? cause.evidence?.length ?? 0;
}

/**
 * The current row a 409 carries, for the two version domains `problemConflictOf`
 * does not know about (HARD RULE 7).
 *
 * `problemConflictOf` types its answer as the problem folder, so the workshop
 * cannot use it for `problem_analyses.row_version` or `problem_causes.row_version`
 * — and dropping the payload there is not a cosmetic loss. The stale version
 * stays in state, so the NEXT save on that node sends the same base version and
 * 409s again, and again: the node becomes permanently unsaveable until a full
 * reload. Rebasing on the server's row is what makes the retry land.
 *
 * One function for both domains rather than one per caller: the envelope is the
 * same, and the copy that drifts is always the one nobody reads.
 */
function conflictCurrentOf<T>(error: unknown): T | null {
  const payload = (error as { payload?: Record<string, unknown> })?.payload;
  const current = payload?.current;
  return current === undefined || current === null ? null : (current as T);
}

function toSnapshot(cause: ProblemCause): AnalysisCauseSnapshot {
  return {
    id: cause.id,
    statement: cause.statement ?? '',
    kind: cause.kind,
    category: cause.category,
    confidence: cause.confidence,
    confirmationMethod: cause.confirmationMethod,
    confirmedBy: cause.confirmedBy,
    evidenceCount: evidenceCountOf(cause),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Page
// ═════════════════════════════════════════════════════════════════════════════

export function ProblemDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();

  const parsed = Number(params.id);
  const problemTicketId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;

  const session = useAuthStore((state) => state.session);
  const hasCapability = useAuthStore((state) => state.hasCapability);
  const canWrite = hasCapability(CAPABILITIES.PROBLEM_RW);
  const canPublishKb = hasCapability(CAPABILITIES.KB_PUBLISH);

  /** What the shared evaluators need about the signed-in actor. */
  const actor = useMemo<ProblemActorContext>(
    () => ({ capabilities: session?.capabilities ?? null, isAdmin: session?.isAdmin ?? false }),
    [session],
  );

  const [problem, setProblem] = useState<ProblemWithRelations | null>(null);
  const [analyses, setAnalyses] = useState<ProblemAnalysisWithCauses[]>([]);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<number | null>(null);
  const [incidents, setIncidents] = useState<CascadeIncidentSnapshot[]>([]);
  const [signatures, setSignatures] = useState<ProblemAlertSignature[]>([]);

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);

  const load = useCallback(async () => {
    if (problemTicketId === null) return;
    setLoading(true);
    try {
      const [record, analysisList, incidentList, signatureList] = await Promise.all([
        problemsApi.get(problemTicketId),
        problemsApi.listAnalyses(problemTicketId).catch(() => []),
        problemsApi.listIncidents(problemTicketId).catch(() => []),
        problemsApi.listSignatures(problemTicketId).catch(() => []),
      ]);
      setProblem(record);
      setAnalyses(analysisList);
      setIncidents(incidentList);
      setSignatures(signatureList);
      setNotFound(false);
    } catch (error) {
      setNotFound(true);
      toast.error(errorMessage(error, t('problem.detailLoadFailed', 'This problem could not be read.')));
    } finally {
      setLoading(false);
    }
  }, [problemTicketId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // The analysis on screen: the one picked, else the current one, else the
  // newest. A superseded analysis is readable and never editable.
  const analysis = useMemo<ProblemAnalysisWithCauses | null>(() => {
    if (analyses.length === 0) return problem?.currentAnalysis ?? null;
    if (selectedAnalysisId !== null) {
      const picked = analyses.find((entry) => entry.id === selectedAnalysisId);
      if (picked) return picked;
    }
    return analyses.find((entry) => entry.isCurrent) ?? analyses[0];
  }, [analyses, selectedAnalysisId, problem]);

  /**
   * One PATCH per field, carrying `problems.row_version`. A 409 replaces the
   * page with the server's row and raises the banner; the error is rethrown so
   * the field that failed keeps the agent's text and says so in place.
   */
  const saveProblem = useCallback(
    async (patch: Omit<UpdateProblemRequest, 'baseRowVersion'>): Promise<void> => {
      if (!problem || problemTicketId === null) return;
      try {
        const next = await problemsApi.update(problemTicketId, {
          baseRowVersion: problem.rowVersion,
          ...patch,
        });
        setProblem(next);
        setConflicted(false);
      } catch (error) {
        const detail = problemConflictOf(error);
        if (detail) {
          setProblem(detail.current);
          setConflicted(true);
        }
        throw error;
      }
    },
    [problem, problemTicketId],
  );

  const replaceAnalysis = useCallback((next: ProblemAnalysisWithCauses) => {
    setAnalyses((current) => {
      const index = current.findIndex((entry) => entry.id === next.id);
      if (index < 0) return [next, ...current];
      const copy = [...current];
      copy[index] = next;
      return copy;
    });
  }, []);

  const patchCause = useCallback((next: ProblemCause) => {
    setAnalyses((current) =>
      current.map((entry) =>
        entry.id !== next.analysisId
          ? entry
          : {
              ...entry,
              causes: entry.causes.some((cause) => cause.id === next.id)
                ? entry.causes.map((cause) =>
                    cause.id === next.id ? { ...cause, ...next, evidence: cause.evidence } : cause,
                  )
                : [...entry.causes, next],
            },
      ),
    );
  }, []);

  if (problemTicketId === null) {
    return (
      <NotFoundCard
        title={t('problem.badId', 'Invalid problem identifier')}
        body={t('problem.badIdBody', 'The address does not carry a usable problem identifier.')}
      />
    );
  }

  if (loading && !problem) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center p-6">
        <LoadingSpinner size="lg" label={t('common.loading', 'Loading…')} />
      </div>
    );
  }

  if (notFound || !problem) {
    return (
      <NotFoundCard
        title={t('problem.notFound', 'Problem not found')}
        body={t(
          'problem.notFoundBody',
          'This problem does not exist in this workspace, or it belongs to another organisation.',
        )}
      />
    );
  }

  const header = problem.ticket;
  const publication = evaluateKnownErrorPublication({
    problem,
    currentAnalysis: analysis ? { state: analysis.state, rootCauseId: analysis.rootCauseId } : null,
    linkedCiCount: problem.ciIds?.length ?? 0,
    actor,
  });

  return (
    <div className="space-y-4 p-6">
      {/* ── Chrome ───────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/problems"
          className="inline-flex items-center gap-1.5 text-[13px] text-text-muted transition-colors hover:text-text-secondary"
        >
          <ArrowLeft size={14} aria-hidden />
          {t('problem.backToList', 'All problems')}
        </Link>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            icon={<Clock3 size={14} />}
            onClick={() => setWhyOpen(true)}
            title={t('problem.whyHint', 'Read the decision log for this problem.')}
          >
            {t('why.title', 'Why?')}
          </Button>
          <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void load()}>
            {t('problem.refresh', 'Reload')}
          </Button>
        </div>
      </header>

      {conflicted && (
        <div className="flex flex-wrap items-center gap-3 rounded-card bg-sla-warn-bg px-4 py-3 shadow-card">
          <AlertTriangle size={15} className="shrink-0 text-sla-warn" aria-hidden />
          <p className="min-w-0 flex-1 text-[13px] leading-snug text-sla-warn">
            {t(
              'problem.conflictBanner',
              'Somebody else saved this problem while you were editing. The page now shows their version; check your change before saving it again.',
            )}
          </p>
          <button
            type="button"
            onClick={() => setConflicted(false)}
            aria-label={t('common.close', 'Close')}
            className="rounded-pill p-1 text-sla-warn transition-colors hover:bg-bg-hover"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* ── Identity ─────────────────────────────────────────────────────── */}
      <section className="rounded-card bg-bg-secondary p-5 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px] text-text-muted">
            {header?.number ?? `#${problem.ticketId}`}
          </span>
          {header && (
            <StatusPill statusSlug={header.statusSlug} category={header.statusCategory} size="sm" />
          )}
          <KnownErrorPill state={problem.knownErrorState} />
          {problem.major && (
            <span className="inline-flex items-center gap-1 rounded-pill bg-priority-p1-bg px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-priority-p1">
              <Flame size={10} aria-hidden />
              {t('problem.majorShort', 'Major')}
            </span>
          )}
          <span className="flex-1" />
          {header && (
            <button
              type="button"
              onClick={() => navigate(`/tickets/${problem.ticketId}`)}
              className="rounded-pill bg-bg-tertiary px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-accent"
            >
              {t('problem.openTicket', 'Open the ticket')}
            </button>
          )}
        </div>

        <h1 className="mt-2 font-display text-2xl font-semibold leading-tight tracking-wide text-text-primary">
          <Siren size={20} className="mr-2 inline-block text-accent" aria-hidden />
          {header?.subject ?? t('problem.untitled', 'Problem without a subject')}
        </h1>

        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <Fact label={t('problem.fact.occurred', 'Occurred')}>
            <span title={formatAbsolute(header?.occurredAt ?? null)}>
              {header ? formatRelative(header.occurredAt, t) : t('problem.neverSeen', 'never')}
            </span>
          </Fact>
          <Fact label={t('problem.fact.incidents', 'Incidents')}>{problem.incidentCount}</Fact>
          <Fact label={t('problem.fact.firstIncident', 'First')}>
            <span title={formatAbsolute(problem.firstIncidentAt)}>
              {problem.firstIncidentAt
                ? formatRelative(problem.firstIncidentAt, t)
                : t('problem.neverSeen', 'never')}
            </span>
          </Fact>
          <Fact label={t('problem.fact.lastIncident', 'Last')}>
            <span title={formatAbsolute(problem.lastIncidentAt)}>
              {problem.lastIncidentAt
                ? formatRelative(problem.lastIncidentAt, t)
                : t('problem.neverSeen', 'never')}
            </span>
          </Fact>
          <Fact label={t('problem.fact.origin', 'Origin')}>
            {t(
              PROBLEM_DETECTED_BY_LABELS[problem.detectedBy].key,
              PROBLEM_DETECTED_BY_LABELS[problem.detectedBy].fallback,
            )}
          </Fact>
        </dl>
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* ── Main column ────────────────────────────────────────────────── */}
        <div className="space-y-4 xl:col-span-2">
          <RcaWorkshop
            problemTicketId={problemTicketId}
            analyses={analyses}
            analysis={analysis}
            selectedAnalysisId={selectedAnalysisId}
            onSelectAnalysis={setSelectedAnalysisId}
            canWrite={canWrite}
            actor={actor}
            onAnalysisChanged={replaceAnalysis}
            onCauseChanged={patchCause}
            onReload={() => void load()}
          />

          <IncidentPanel
            problemTicketId={problemTicketId}
            problem={problem}
            incidents={incidents}
            canWrite={canWrite}
            onReload={() => void load()}
          />
        </div>

        {/* ── Right column ───────────────────────────────────────────────── */}
        <div className="space-y-4">
          <KnownErrorPanel
            problemTicketId={problemTicketId}
            problem={problem}
            publication={publication.blockers}
            publishAllowed={publication.allowed}
            canWrite={canWrite}
            canPublishKb={canPublishKb}
            onSaveField={saveProblem}
            onReplaced={(next) => {
              setProblem(next);
              setConflicted(false);
            }}
          />

          <section className="rounded-card bg-bg-secondary p-5 shadow-card">
            <PanelHeading icon={<CircleDot size={12} aria-hidden />}>
              {t('problem.symptomsHeading', 'Symptoms')}
            </PanelHeading>
            <p className="mt-1 text-[11px] leading-snug text-text-muted">
              {t(
                'problem.symptomsHint',
                'Phrased the way a requester describes it. This is what the intake matcher indexes, and half of what makes the known error findable.',
              )}
            </p>
            <div className="mt-3">
              <InlineField
                field="symptomsMd"
                label={t('problem.field.symptoms', 'Symptoms')}
                value={problem.symptomsMd}
                type="textarea"
                rows={4}
                readOnly={!canWrite}
                placeholder={t('problem.field.symptomsPlaceholder', 'The printer on the second floor stops after ten pages…')}
                onSave={(value) => saveProblem({ symptomsMd: value })}
              />
            </div>
          </section>

          <GovernancePanel problem={problem} canWrite={canWrite} onSaveField={saveProblem} />

          <SignaturePanel
            problemTicketId={problemTicketId}
            signatures={signatures}
            canWrite={canWrite}
            onChanged={setSignatures}
          />
        </div>
      </div>

      <WhyDrawer
        ticketId={problem.ticketId}
        ticketNumber={header?.number}
        open={whyOpen}
        onClose={() => setWhyOpen(false)}
      />
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The RCA workshop
// ═════════════════════════════════════════════════════════════════════════════

function RcaWorkshop({
  problemTicketId,
  analyses,
  analysis,
  selectedAnalysisId,
  onSelectAnalysis,
  canWrite,
  actor,
  onAnalysisChanged,
  onCauseChanged,
  onReload,
}: {
  problemTicketId: number;
  analyses: ProblemAnalysisWithCauses[];
  analysis: ProblemAnalysisWithCauses | null;
  selectedAnalysisId: number | null;
  onSelectAnalysis: (id: number | null) => void;
  canWrite: boolean;
  actor: ProblemActorContext;
  onAnalysisChanged: (next: ProblemAnalysisWithCauses) => void;
  onCauseChanged: (next: ProblemCause) => void;
  onReload: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [view, setView] = useState<RcaView | null>(null);
  const [busy, setBusy] = useState(false);
  const [concluding, setConcluding] = useState(false);
  const [confirming, setConfirming] = useState<ProblemCause | null>(null);
  const [evidencing, setEvidencing] = useState<ProblemCause | null>(null);

  // The method chooses the default drawing; the toggle then wins, so switching
  // it never rewrites the stored method behind the facilitator's back.
  const effectiveView: RcaView =
    view ?? (analysis?.method === 'ishikawa' ? 'fishbone' : 'chain');

  const causes = analysis?.causes ?? [];
  const snapshots = useMemo(() => causes.map(toSnapshot), [causes]);
  const editable = analysis !== null && canWrite && !isWorkshopClosed(analysis.state);

  /** What is still missing before this analysis could be concluded. */
  const concludeGate = useMemo(
    () =>
      analysis
        ? evaluateAnalysisTransition({
            analysis: { state: analysis.state, rootCauseId: analysis.rootCauseId },
            causes: snapshots,
            toState: 'concluded',
            actor,
          })
        : null,
    [analysis, snapshots, actor],
  );

  async function startAnalysis(): Promise<void> {
    setBusy(true);
    try {
      const created = await problemsApi.createAnalysis(problemTicketId, { method: 'five_whys' });
      onSelectAnalysis(created.id);
      onReload();
      toast.success(t('problem.analysisStarted', 'Analysis opened.'));
    } catch (error) {
      toast.error(errorMessage(error, t('problem.analysisStartFailed', 'The analysis could not be opened.')));
    } finally {
      setBusy(false);
    }
  }

  async function changeState(toState: ProblemAnalysisState, conclusionMd?: string): Promise<void> {
    if (!analysis) return;
    setBusy(true);
    try {
      const next = await problemsApi.changeAnalysisState(problemTicketId, analysis.id, {
        baseRowVersion: analysis.rowVersion,
        toState,
        conclusionMd: conclusionMd ?? undefined,
      });
      onAnalysisChanged(next);
      setConcluding(false);
      onReload();
    } catch (error) {
      // Same rebase as the autosaves: without it the button carries the stale
      // version for ever and the analysis can never leave its state again.
      const current = conflictCurrentOf<ProblemAnalysisWithCauses>(error);
      if (current) onAnalysisChanged(current);
      toast.error(errorMessage(error, t('problem.analysisStateFailed', 'The analysis could not change state.')));
    } finally {
      setBusy(false);
    }
  }

  async function saveAnalysisField(patch: {
    title?: string | null;
    method?: RcaMethod;
    rootCauseId?: number | null;
    conclusionMd?: string | null;
  }): Promise<void> {
    if (!analysis) return;
    try {
      const next = await problemsApi.updateAnalysis(problemTicketId, analysis.id, {
        baseRowVersion: analysis.rowVersion,
        ...patch,
      });
      onAnalysisChanged(next);
    } catch (error) {
      // HARD RULE 7: a 409 carries the row as it now stands, and the workshop
      // takes it. The field then shows the other facilitator's text with the
      // server's own message on it, and the next save carries a version the
      // server will accept instead of retrying a losing one for ever.
      const current = conflictCurrentOf<ProblemAnalysisWithCauses>(error);
      if (current) onAnalysisChanged(current);
      // Rethrown so the inline field prints the reason where it happened.
      throw new Error(errorMessage(error, t('problem.analysisSaveFailed', 'Saving failed.')));
    }
  }

  async function addCause(parentCauseId: number | null): Promise<void> {
    if (!analysis) return;
    setBusy(true);
    try {
      const created = await problemsApi.createCause(problemTicketId, analysis.id, {
        parentCauseId,
        statement: '',
        kind: 'cause',
      });
      onCauseChanged(created);
    } catch (error) {
      toast.error(errorMessage(error, t('problem.causeAddFailed', 'The cause could not be added.')));
    } finally {
      setBusy(false);
    }
  }

  async function saveCause(
    cause: ProblemCause,
    patch: { statement?: string; detailMd?: string | null; category?: CauseCategory; kind?: CauseKind },
  ): Promise<void> {
    try {
      const next = await problemsApi.updateCause(problemTicketId, cause.id, {
        baseRowVersion: cause.rowVersion,
        ...patch,
      });
      onCauseChanged(next);
    } catch (error) {
      // The node's own version domain, rebased for the same reason.
      const current = conflictCurrentOf<ProblemCause>(error);
      if (current) onCauseChanged(current);
      throw new Error(errorMessage(error, t('problem.causeSaveFailed', 'Saving failed.')));
    }
  }

  async function deleteCause(cause: ProblemCause): Promise<void> {
    setBusy(true);
    try {
      await problemsApi.deleteCause(problemTicketId, cause.id);
      onReload();
    } catch (error) {
      toast.error(errorMessage(error, t('problem.causeDeleteFailed', 'The cause could not be removed.')));
    } finally {
      setBusy(false);
    }
  }

  async function electRoot(cause: ProblemCause): Promise<void> {
    setBusy(true);
    try {
      await saveAnalysisField({ rootCauseId: cause.id });
    } catch (error) {
      toast.error(errorMessage(error, t('problem.rootElectFailed', 'The root cause could not be elected.')));
    } finally {
      setBusy(false);
    }
  }

  if (!analysis) {
    return (
      <section className="rounded-card bg-bg-secondary p-5 shadow-card">
        <PanelHeading icon={<Network size={12} aria-hidden />}>
          {t('problem.rcaHeading', 'Root cause analysis')}
        </PanelHeading>
        <div className="mt-4">
          <EmptyState
            compact
            icon={<Network size={22} />}
            title={t('problem.rcaEmptyTitle', 'No analysis on this problem yet')}
            description={t(
              'problem.rcaEmptyBody',
              'Five whys is a chain, Ishikawa is a fan, and both are the same tree here. Start one and add the first why.',
            )}
            action={
              canWrite ? (
                <Button size="sm" variant="primary" icon={<Plus size={14} />} loading={busy} onClick={() => void startAnalysis()}>
                  {t('problem.startAnalysis', 'Start an analysis')}
                </Button>
              ) : undefined
            }
          />
        </div>
      </section>
    );
  }

  /**
   * The moves the state bar offers, which are NOT every move the machine
   * declares.
   *
   * `superseded` is filtered out. The shared machine lists it as the one target
   * of `concluded`, but its own comment says it "is reached only when a NEW
   * analysis becomes current": it is the machine's word for "something took
   * over", not a decision an agent makes. Rendered as a button it sits next to
   * "Open a new analysis" and does half of it — the current analysis is dropped
   * and no new one is opened — after which the problem has no current analysis,
   * `evaluateKnownErrorPublication` blocks publication for ever on
   * `known_error_needs_conclusion`, and nothing on this page can undo it.
   * Opening a new analysis is the supported way to reach `superseded`, and the
   * server supersedes the current one itself.
   */
  const targets = (PROBLEM_ANALYSIS_TRANSITIONS[analysis.state] ?? []).filter(
    (target) => target !== 'superseded',
  );

  /**
   * Whether this problem still has an analysis somebody could write in. It is
   * the guard on the door below: opening a new analysis SUPERSEDES the current
   * one, so offering that while browsing an old superseded analysis would let
   * one click bury a draft the team is in the middle of.
   */
  const hasLiveAnalysis = analyses.some(
    (entry) => entry.isCurrent && !isWorkshopClosed(entry.state),
  );

  // `abandoned` stays offered as a target — a facilitator may genuinely drop a
  // dead end — because the way back out is now rendered whenever nothing
  // writable is left, whatever closed the workshop.
  const workshopClosed = isWorkshopClosed(analysis.state) && !hasLiveAnalysis;

  return (
    <section className="rounded-card bg-bg-secondary p-5 shadow-card">
      {/* ── Workshop header ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <PanelHeading icon={<Network size={12} aria-hidden />}>
          {t('problem.rcaHeading', 'Root cause analysis')}
        </PanelHeading>
        <span className="flex-1" />

        {analyses.length > 1 && (
          <select
            value={String(selectedAnalysisId ?? analysis.id)}
            onChange={(event) => onSelectAnalysis(Number(event.target.value))}
            aria-label={t('problem.pickAnalysis', 'Pick an analysis')}
            className="rounded-pill bg-bg-tertiary px-2.5 py-1 text-[11px] text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent [&>option]:bg-bg-secondary [&>option]:text-text-primary"
          >
            {analyses.map((entry, index) => (
              <option key={entry.id} value={entry.id}>
                {t('problem.analysisOption', 'Analysis {{n}} · {{state}}', {
                  n: analyses.length - index,
                  state: t(
                    PROBLEM_ANALYSIS_STATE_LABELS[entry.state].key,
                    PROBLEM_ANALYSIS_STATE_LABELS[entry.state].fallback,
                  ),
                })}
              </option>
            ))}
          </select>
        )}

        <span
          className={clsx(
            'rounded-pill px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]',
            ANALYSIS_STATE_CLASSES[analysis.state],
          )}
        >
          {t(
            PROBLEM_ANALYSIS_STATE_LABELS[analysis.state].key,
            PROBLEM_ANALYSIS_STATE_LABELS[analysis.state].fallback,
          )}
        </span>

        {/* One tree, two drawings. */}
        <div className="flex items-center gap-0.5 rounded-pill bg-bg-tertiary p-0.5">
          <ViewChip active={effectiveView === 'chain'} onClick={() => setView('chain')} icon={<GitBranch size={11} aria-hidden />}>
            {t('problem.viewChain', 'Chain')}
          </ViewChip>
          <ViewChip active={effectiveView === 'fishbone'} onClick={() => setView('fishbone')} icon={<Network size={11} aria-hidden />}>
            {t('problem.viewFishbone', 'Fishbone')}
          </ViewChip>
        </div>
      </div>

      {/* ── Title and method ───────────────────────────────────────────── */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <InlineField
          field="analysisTitle"
          label={t('problem.field.analysisTitle', 'Analysis title')}
          value={analysis.title}
          readOnly={!editable}
          placeholder={t('problem.field.analysisTitlePlaceholder', 'What this session is trying to explain')}
          onSave={(value) => saveAnalysisField({ title: value })}
        />
        <InlineField
          field="analysisMethod"
          label={t('problem.field.method', 'Method')}
          value={analysis.method}
          type="select"
          readOnly={!editable}
          options={RCA_METHODS.map((method) => ({
            value: method,
            label: t(RCA_METHOD_LABELS[method].key, RCA_METHOD_LABELS[method].fallback),
          }))}
          onSave={(value) => saveAnalysisField({ method: (value ?? 'mixed') as RcaMethod })}
        />
      </div>

      {/* ── The tree ───────────────────────────────────────────────────── */}
      <div className="mt-4">
        {causes.length === 0 ? (
          <div className="rounded-card bg-bg-tertiary px-4 py-8 text-center">
            <p className="text-[13px] text-text-secondary">
              {t('problem.noCauseYet', 'Nothing has been written down yet.')}
            </p>
            <p className="mx-auto mt-1 max-w-md text-[12px] leading-snug text-text-muted">
              {t(
                'problem.noCauseHint',
                'Start with the symptom stated as a fact, then ask why. Each answer becomes a node you can categorise, evidence and confirm.',
              )}
            </p>
            {editable && (
              <Button
                size="sm"
                variant="primary"
                icon={<Plus size={14} />}
                className="mt-3"
                loading={busy}
                onClick={() => void addCause(null)}
              >
                {t('problem.addFirstWhy', 'Add the first why')}
              </Button>
            )}
          </div>
        ) : effectiveView === 'chain' ? (
          <CauseChain
            causes={causes}
            rootCauseId={analysis.rootCauseId}
            editable={editable}
            onAddChild={(parentId) => void addCause(parentId)}
            onSave={saveCause}
            onDelete={(cause) => void deleteCause(cause)}
            onElectRoot={(cause) => void electRoot(cause)}
            onConfirm={setConfirming}
            onEvidence={setEvidencing}
          />
        ) : (
          <CauseFishbone
            causes={causes}
            rootCauseId={analysis.rootCauseId}
            editable={editable}
            onAddChild={(parentId) => void addCause(parentId)}
            onSave={saveCause}
            onDelete={(cause) => void deleteCause(cause)}
            onElectRoot={(cause) => void electRoot(cause)}
            onConfirm={setConfirming}
            onEvidence={setEvidencing}
          />
        )}

        {causes.length > 0 && editable && (
          <Button
            size="xs"
            variant="ghost"
            icon={<Plus size={12} />}
            className="mt-2"
            loading={busy}
            onClick={() => void addCause(null)}
          >
            {t('problem.addBranch', 'Add another branch')}
          </Button>
        )}
      </div>

      {/* ── Conclusion, and what stands in its way ─────────────────────── */}
      {analysis.state === 'concluded' && analysis.conclusionMd && (
        <div className="mt-4 rounded-card bg-bg-tertiary p-3">
          <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
            {t('problem.conclusionHeading', 'Conclusion')}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-text-primary">
            {analysis.conclusionMd}
          </p>
        </div>
      )}

      {concludeGate && !concludeGate.allowed && analysis.state !== 'concluded' && (
        <BlockerList
          heading={t('problem.toConclude', 'To conclude this analysis')}
          blockers={concludeGate.blockers}
          missingCapabilities={concludeGate.missingCapabilities.length > 0}
        />
      )}

      {/* ── State bar ──────────────────────────────────────────────────── */}
      {canWrite && (targets.length > 0 || workshopClosed) && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {targets.map((target) => {
            const gate = evaluateAnalysisTransition({
              analysis: { state: analysis.state, rootCauseId: analysis.rootCauseId },
              causes: snapshots,
              toState: target,
              actor,
            });
            const label = PROBLEM_ANALYSIS_STATE_LABELS[target];
            return (
              <Button
                key={target}
                size="sm"
                variant={target === 'concluded' ? 'primary' : 'secondary'}
                disabled={!gate.allowed || busy}
                title={
                  gate.allowed
                    ? undefined
                    : gate.blockers.map((blocker) => t(blocker.key, blocker.fallback)).join(' · ')
                }
                onClick={() => {
                  if (target === 'concluded') setConcluding(true);
                  else void changeState(target);
                }}
              >
                {t('problem.moveTo', 'Move to {{state}}', {
                  state: t(label.key, label.fallback),
                })}
              </Button>
            );
          })}

          {/* The only door out of a closed workshop, offered for all three
              closed states rather than for `concluded` alone: an abandoned or
              superseded analysis has no transition left either, and while this
              button hung on `concluded` a single Abandon click left the RCA and
              the known error unreachable for good. */}
          {workshopClosed && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={13} />}
              loading={busy}
              onClick={() => void startAnalysis()}
              title={
                analysis.state === 'concluded'
                  ? t(
                      'problem.newAnalysisHint',
                      'The current analysis is kept exactly as it was concluded and marked superseded.',
                    )
                  : t(
                      'problem.reopenAnalysisHint',
                      'This analysis is finished and cannot be edited again. A new one starts empty and this one is kept exactly as it stands.',
                    )
              }
            >
              {t('problem.newAnalysis', 'Open a new analysis')}
            </Button>
          )}
        </div>
      )}

      <ConcludeModal
        open={concluding}
        busy={busy}
        analysis={analysis}
        causes={causes}
        onClose={() => setConcluding(false)}
        onConclude={(conclusionMd) => void changeState('concluded', conclusionMd)}
      />

      <ConfirmCauseModal
        problemTicketId={problemTicketId}
        cause={confirming}
        actor={actor}
        onClose={() => setConfirming(null)}
        onConfirmed={(next) => {
          onCauseChanged(next);
          setConfirming(null);
        }}
        onRebase={(next) => {
          // The modal holds its own copy of the node, so a 409 has to land in
          // both places or Apply keeps sending the version that just lost.
          onCauseChanged(next);
          setConfirming(next);
        }}
      />

      <EvidenceModal
        problemTicketId={problemTicketId}
        cause={evidencing}
        onClose={() => setEvidencing(null)}
        onAdded={() => {
          setEvidencing(null);
          onReload();
        }}
      />
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The tree, drawn two ways
// ═════════════════════════════════════════════════════════════════════════════

interface TreeHandlers {
  editable: boolean;
  rootCauseId: number | null;
  onAddChild: (parentId: number | null) => void;
  onSave: (
    cause: ProblemCause,
    patch: { statement?: string; detailMd?: string | null; category?: CauseCategory; kind?: CauseKind },
  ) => Promise<void>;
  onDelete: (cause: ProblemCause) => void;
  onElectRoot: (cause: ProblemCause) => void;
  onConfirm: (cause: ProblemCause) => void;
  onEvidence: (cause: ProblemCause) => void;
}

function childrenOf(causes: readonly ProblemCause[], parentId: number | null): ProblemCause[] {
  return causes
    .filter((cause) => cause.parentCauseId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

/** Five whys: the chain, indented, with the connector drawn as a background. */
function CauseChain({
  causes,
  ...handlers
}: { causes: ProblemCause[] } & TreeHandlers): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {childrenOf(causes, null).map((cause) => (
        <CauseBranch key={cause.id} causes={causes} cause={cause} {...handlers} />
      ))}
    </div>
  );
}

function CauseBranch({
  causes,
  cause,
  ...handlers
}: { causes: ProblemCause[]; cause: ProblemCause } & TreeHandlers): JSX.Element {
  const children = childrenOf(causes, cause.id);

  return (
    <div>
      <CauseNode cause={cause} {...handlers} />
      {children.length > 0 && (
        <div className="mt-2 flex">
          {/* The connector is a background rule, not a border: HARD RULE 11. */}
          <span className="ml-3 mr-2 w-px shrink-0 bg-border" aria-hidden />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {children.map((child) => (
              <CauseBranch key={child.id} causes={causes} cause={child} {...handlers} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Ishikawa: the depth-0 nodes fanned out by category, their whys underneath. */
function CauseFishbone({
  causes,
  ...handlers
}: { causes: ProblemCause[] } & TreeHandlers): JSX.Element {
  const { t } = useTranslation();
  const roots = childrenOf(causes, null);

  const groups = useMemo(() => {
    const bag = new Map<CauseCategory, ProblemCause[]>();
    for (const cause of roots) {
      const list = bag.get(cause.category) ?? [];
      list.push(cause);
      bag.set(cause.category, list);
    }
    return CAUSE_CATEGORIES.filter((category) => bag.has(category)).map((category) => ({
      category,
      items: bag.get(category) ?? [],
    }));
  }, [roots]);

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {groups.map((group) => (
        <div key={group.category} className="rounded-card bg-bg-primary/40 p-2.5">
          <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
            <CornerDownRight size={10} aria-hidden />
            {t(
              CAUSE_CATEGORY_LABELS[group.category].key,
              CAUSE_CATEGORY_LABELS[group.category].fallback,
            )}
            <span className="text-text-muted">({group.items.length})</span>
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {group.items.map((cause) => (
              <CauseBranch key={cause.id} causes={causes} cause={cause} {...handlers} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** One node: the statement autosaves, everything else is a one-click change. */
function CauseNode({
  cause,
  editable,
  rootCauseId,
  onAddChild,
  onSave,
  onDelete,
  onElectRoot,
  onConfirm,
  onEvidence,
}: { cause: ProblemCause } & TreeHandlers): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isRoot = rootCauseId === cause.id;
  const evidence = cause.evidence ?? [];
  const count = evidenceCountOf(cause);

  return (
    <div
      className={clsx(
        'rounded-card p-3 transition-colors',
        isRoot ? 'bg-accent/12' : 'bg-bg-tertiary',
      )}
    >
      {/* The mono label doubles as the depth marker: WHY 1, WHY 2, … */}
      <InlineField
        field={`cause.${cause.id}.statement`}
        label={
          isRoot
            ? t('problem.rootCauseLabel', 'Root cause')
            : t('problem.whyLabel', 'Why {{n}}', { n: cause.depth + 1 })
        }
        value={cause.statement}
        type="textarea"
        rows={2}
        readOnly={!editable}
        placeholder={t('problem.field.statementPlaceholder', 'Because…')}
        onSave={(value) => onSave(cause, { statement: value ?? '' })}
      />

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {isRoot && (
          <span className="inline-flex items-center gap-1 rounded-pill bg-accent px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-bg-primary">
            <Target size={10} aria-hidden />
            {t('problem.electedRoot', 'Elected root')}
          </span>
        )}

        <NodeSelect
          value={cause.category}
          disabled={!editable}
          ariaLabel={t('problem.field.category', 'Category')}
          options={CAUSE_CATEGORIES.map((category) => ({
            value: category,
            label: t(CAUSE_CATEGORY_LABELS[category].key, CAUSE_CATEGORY_LABELS[category].fallback),
          }))}
          onChange={(value) => void onSave(cause, { category: value as CauseCategory })}
        />

        <NodeSelect
          value={cause.kind}
          disabled={!editable}
          ariaLabel={t('problem.field.kind', 'Kind')}
          className={KIND_CLASSES[cause.kind]}
          options={CAUSE_KINDS.map((kind) => ({
            value: kind,
            label: t(CAUSE_KIND_LABELS[kind].key, CAUSE_KIND_LABELS[kind].fallback),
          }))}
          onChange={(value) => void onSave(cause, { kind: value as CauseKind })}
        />

        <button
          type="button"
          disabled={!editable}
          onClick={() => onConfirm(cause)}
          title={t('problem.changeConfidence', 'Change the confidence on this node')}
          className={clsx(
            'rounded-pill px-2 py-0.5 text-[11px] transition-colors disabled:cursor-default disabled:opacity-70',
            CONFIDENCE_CLASSES[cause.confidence],
          )}
        >
          {t(
            CAUSE_CONFIDENCE_LABELS[cause.confidence].key,
            CAUSE_CONFIDENCE_LABELS[cause.confidence].fallback,
          )}
        </button>

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className={clsx(
            'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] transition-colors',
            count > 0 ? 'bg-bg-hover text-text-secondary' : 'bg-bg-hover text-text-muted',
            'hover:bg-bg-active',
          )}
        >
          {open ? <ChevronDown size={10} aria-hidden /> : <ChevronRight size={10} aria-hidden />}
          <Paperclip size={10} aria-hidden />
          {t('problem.evidenceCount', '{{count}} evidence', { count })}
        </button>

        <span className="flex-1" />

        {editable && (
          <>
            <IconAction
              icon={<Plus size={12} />}
              label={t('problem.addWhy', 'Ask why under this node')}
              onClick={() => onAddChild(cause.id)}
            />
            <IconAction
              icon={<Target size={12} />}
              label={t('problem.markRoot', 'Mark as the root cause')}
              onClick={() => onElectRoot(cause)}
              active={isRoot}
            />
            <IconAction
              icon={<Trash2 size={12} />}
              label={t('problem.deleteCause', 'Remove this node and everything under it')}
              onClick={() => onDelete(cause)}
              danger
            />
          </>
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          <InlineField
            field={`cause.${cause.id}.detail`}
            label={t('problem.field.detail', 'Notes')}
            value={cause.detailMd}
            type="textarea"
            rows={2}
            readOnly={!editable}
            placeholder={t('problem.field.detailPlaceholder', 'What was checked, what was measured')}
            onSave={(value) => onSave(cause, { detailMd: value })}
          />

          {evidence.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {evidence.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center gap-2 rounded-card bg-bg-hover px-2.5 py-1.5 text-[11px]"
                >
                  <Link2 size={11} className="shrink-0 text-text-muted" aria-hidden />
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted">
                    {t(
                      EVIDENCE_TYPE_LABELS[entry.evidenceType].key,
                      EVIDENCE_TYPE_LABELS[entry.evidenceType].fallback,
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text-secondary">
                    {entry.note ?? entry.externalUrl ?? ''}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-text-muted">
                    {formatRelative(entry.capturedAt, t)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] leading-snug text-text-muted">
              {t(
                'problem.noEvidence',
                'Nothing on file. A cause cannot be confirmed without at least one artefact.',
              )}
            </p>
          )}

          {editable && (
            <Button size="xs" variant="ghost" icon={<Paperclip size={12} />} onClick={() => onEvidence(cause)}>
              {t('problem.addEvidence', 'Attach evidence')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Conclude, confirm, evidence
// ═════════════════════════════════════════════════════════════════════════════

function ConcludeModal({
  open,
  busy,
  analysis,
  causes,
  onClose,
  onConclude,
}: {
  open: boolean;
  busy: boolean;
  analysis: ProblemAnalysisWithCauses;
  causes: ProblemCause[];
  onClose: () => void;
  onConclude: (conclusionMd: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [conclusion, setConclusion] = useState('');

  useEffect(() => {
    if (open) setConclusion(analysis.conclusionMd ?? '');
  }, [open, analysis.conclusionMd]);

  const root = causes.find((cause) => cause.id === analysis.rootCauseId) ?? null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={t('problem.concludeTitle', 'Conclude the analysis')}
      subtitle={t(
        'problem.concludeSubtitle',
        'Concluding freezes the elected root cause. A later analysis supersedes this one; it never rewrites it.',
      )}
      closeLabel={t('common.close', 'Close')}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button size="sm" variant="primary" loading={busy} onClick={() => onConclude(conclusion.trim())}>
            {t('problem.concludeConfirm', 'Conclude')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-card bg-bg-tertiary p-3">
          <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
            {t('problem.rootCauseLabel', 'Root cause')}
          </p>
          <p className="mt-1 text-[13px] leading-snug text-text-primary">
            {root
              ? root.statement || t('problem.emptyStatement', 'This node has no statement yet.')
              : t('problem.noRootElected', 'No root cause has been elected.')}
          </p>
        </div>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
            {t('problem.field.conclusion', 'Conclusion')}
          </span>
          <textarea
            rows={4}
            value={conclusion}
            onChange={(event) => setConclusion(event.target.value)}
            placeholder={t('problem.field.conclusionPlaceholder', 'What was established, and what remains open')}
            className="resize-y rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </label>
      </div>
    </Modal>
  );
}

function ConfirmCauseModal({
  problemTicketId,
  cause,
  actor,
  onClose,
  onConfirmed,
  onRebase,
}: {
  problemTicketId: number;
  cause: ProblemCause | null;
  actor: ProblemActorContext;
  onClose: () => void;
  onConfirmed: (next: ProblemCause) => void;
  /** The row a 409 came back with (HARD RULE 7). Not a success. */
  onRebase: (current: ProblemCause) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const session = useAuthStore((state) => state.session);
  const [confidence, setConfidence] = useState<CauseConfidence>('probable');
  const [method, setMethod] = useState<CauseConfirmationMethod | ''>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!cause) return;
    setConfidence(cause.confidence);
    setMethod(cause.confirmationMethod ?? '');
  }, [cause]);

  // The SAME evaluator the route runs, so the greyed button and the 422 say the
  // same words. `confirmedBy` is the signed-in user: an automation actor passes
  // null here and can never reach 'confirmed'.
  const gate = cause
    ? evaluateCauseConfirmation({
        cause: {
          kind: cause.kind,
          evidenceCount: evidenceCountOf(cause),
          statement: cause.statement ?? '',
        },
        toConfidence: confidence,
        confirmationMethod: method === '' ? null : method,
        confirmedBy: session?.user.id ?? null,
        actor,
      })
    : null;

  async function submit(): Promise<void> {
    if (!cause) return;
    setBusy(true);
    try {
      const next = await problemsApi.confirmCause(problemTicketId, cause.id, {
        baseRowVersion: cause.rowVersion,
        confidence,
        confirmationMethod: method === '' ? null : method,
      });
      onConfirmed(next);
    } catch (error) {
      const current = conflictCurrentOf<ProblemCause>(error);
      if (current) onRebase(current);
      toast.error(errorMessage(error, t('problem.confirmFailed', 'The confidence could not be changed.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={cause !== null}
      onClose={onClose}
      size="md"
      title={t('problem.confirmTitle', 'Confidence on this cause')}
      subtitle={t(
        'problem.confirmSubtitle',
        'Confirming and refuting both cost the same three things: an artefact on file, a named method, and a person.',
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
            disabled={!gate?.allowed}
            onClick={() => void submit()}
          >
            {t('problem.confirmApply', 'Apply')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
            {t('problem.field.confidence', 'Confidence')}
          </span>
          <select
            value={confidence}
            onChange={(event) => setConfidence(event.target.value as CauseConfidence)}
            className="rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent [&>option]:bg-bg-secondary [&>option]:text-text-primary"
          >
            {CAUSE_CONFIDENCES.map((value) => (
              <option key={value} value={value}>
                {t(CAUSE_CONFIDENCE_LABELS[value].key, CAUSE_CONFIDENCE_LABELS[value].fallback)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
            {t('problem.field.confirmationMethod', 'How was it established?')}
          </span>
          <select
            value={method}
            onChange={(event) => setMethod(event.target.value as CauseConfirmationMethod | '')}
            className="rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent [&>option]:bg-bg-secondary [&>option]:text-text-primary"
          >
            <option value="">{t('problem.field.methodNone', 'Not stated')}</option>
            {CAUSE_CONFIRMATION_METHODS.map((value) => (
              <option key={value} value={value}>
                {t(
                  CAUSE_CONFIRMATION_METHOD_LABELS[value].key,
                  CAUSE_CONFIRMATION_METHOD_LABELS[value].fallback,
                )}
              </option>
            ))}
          </select>
        </label>

        {gate && !gate.allowed && (
          <BlockerList
            heading={t('problem.confirmBlocked', 'Still missing')}
            blockers={gate.blockers}
            missingCapabilities={gate.missingCapabilities.length > 0}
          />
        )}
      </div>
    </Modal>
  );
}

function EvidenceModal({
  problemTicketId,
  cause,
  onClose,
  onAdded,
}: {
  problemTicketId: number;
  cause: ProblemCause | null;
  onClose: () => void;
  onAdded: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [type, setType] = useState<ProblemEvidenceType>('ticket');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!cause) return;
    setType('ticket');
    setTarget('');
    setNote('');
  }, [cause]);

  async function submit(): Promise<void> {
    if (!cause) return;
    const payload: AddProblemCauseEvidenceRequest = {
      evidenceType: type,
      note: note.trim() || null,
    };
    if (type === 'external') {
      payload.externalUrl = target.trim() || null;
    } else {
      const id = Number(target);
      if (!Number.isInteger(id) || id <= 0) {
        toast.error(t('problem.evidenceNeedsTarget', 'Give the identifier of the artefact this points at.'));
        return;
      }
      // Exactly one target per row: the request mirrors the table's own CHECK.
      (payload as unknown as Record<string, unknown>)[EVIDENCE_TARGET_KEY[type]] = id;
    }

    setBusy(true);
    try {
      await problemsApi.addCauseEvidence(problemTicketId, cause.id, payload);
      toast.success(t('problem.evidenceAdded', 'Evidence attached.'));
      onAdded();
    } catch (error) {
      toast.error(errorMessage(error, t('problem.evidenceFailed', 'The evidence could not be attached.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={cause !== null}
      onClose={onClose}
      size="md"
      title={t('problem.evidenceTitle', 'Attach evidence')}
      subtitle={t(
        'problem.evidenceSubtitle',
        'One artefact per row, and the note says why it proves the cause. Without the note the evidence is an ornament.',
      )}
      closeLabel={t('common.close', 'Close')}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button size="sm" variant="primary" loading={busy} onClick={() => void submit()}>
            {t('problem.evidenceApply', 'Attach')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
            {t('problem.field.evidenceType', 'Kind of artefact')}
          </span>
          <select
            value={type}
            onChange={(event) => setType(event.target.value as ProblemEvidenceType)}
            className="rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent [&>option]:bg-bg-secondary [&>option]:text-text-primary"
          >
            {PROBLEM_EVIDENCE_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(EVIDENCE_TYPE_LABELS[value].key, EVIDENCE_TYPE_LABELS[value].fallback)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
            {type === 'external'
              ? t('problem.field.externalUrl', 'Address')
              : t('problem.field.targetId', 'Identifier')}
          </span>
          <input
            type={type === 'external' ? 'url' : 'number'}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder={
              type === 'external'
                ? t('problem.field.externalUrlPlaceholder', 'https://vendor.example/kb/12345')
                : t('problem.field.targetIdPlaceholder', 'Numeric identifier of the artefact')
            }
            className={clsx(
              'rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent',
              type !== 'external' && 'font-mono',
            )}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
            {t('problem.field.evidenceNote', 'Why it proves the cause')}
          </span>
          <input
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('problem.field.evidenceNotePlaceholder', 'The counter resets on every firmware restart')}
            className="rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </label>

        <p className="rounded-card bg-bg-tertiary px-3 py-2 text-[11px] leading-snug text-text-muted">
          {t(
            'problem.evidenceScreenshotNote',
            'A screenshot is not a target here: attach it as a file on the node, the way any other attachment is stored.',
          )}
        </p>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Linked incidents and the cascade
// ═════════════════════════════════════════════════════════════════════════════

function IncidentPanel({
  problemTicketId,
  problem,
  incidents,
  canWrite,
  onReload,
}: {
  problemTicketId: number;
  problem: ProblemWithRelations;
  incidents: CascadeIncidentSnapshot[];
  canWrite: boolean;
  onReload: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [previewPolicy, setPreviewPolicy] = useState<ProblemClosurePolicy | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmCascade, setConfirmCascade] = useState(false);

  const [serverPlan, setServerPlan] = useState<CascadePlan | null>(null);
  const [planUnreadable, setPlanUnreadable] = useState(false);

  const policy = previewPolicy ?? problem.closurePolicy;

  // The rows on screen, classified by the exact function the server runs. This
  // is honest about what it covers and nothing more: `GET /incidents` is
  // PAGINATED, so `incidents` is one page and a count taken from it counts a
  // slice. It decides what each visible row says, never a total.
  const pagePlan = useMemo(() => planClosureCascade(incidents, policy), [incidents, policy]);

  /**
   * The plan over EVERY linked incident, from the server's own dry run.
   *
   * `POST /cascade` acts on all of them, so the figure an operator approves has
   * to come from all of them; a confirm dialog promising 31 transitions while
   * the pass performs 74 is worse than no dialog. The endpoint writes nothing
   * and logs nothing, and runs the same `planClosureCascade` this file imports,
   * so the two still cannot disagree on arithmetic — only the population
   * differs, and the server's is the one that acts.
   *
   * Re-read when the policy select moves (the operator is comparing outcomes)
   * and when `incidents` is replaced, which is what a link, an unlink or a
   * finished cascade does through `onReload`.
   */
  useEffect(() => {
    let cancelled = false;
    // Dropped BEFORE the request, never after it: a plan computed for the
    // policy the operator has just moved off is precisely the stale figure this
    // whole arrangement exists to keep out of the confirm dialog.
    setServerPlan(null);
    setPlanUnreadable(false);
    problemsApi
      .previewCascade(problemTicketId, policy)
      .then((result) => {
        if (!cancelled) setServerPlan(result.plan);
      })
      .catch(() => {
        if (cancelled) return;
        setServerPlan(null);
        setPlanUnreadable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [problemTicketId, policy, incidents]);

  // Counts come from the whole population when it is known. Until it is, the
  // page plan keeps the tiles populated, the scope line stays off and the
  // cascade button stays disabled, so nothing quotes a slice as a total.
  const plan = serverPlan ?? pagePlan;

  const byTicket = useMemo(() => {
    const map = new Map<number, CascadeIncidentSnapshot>();
    for (const incident of incidents) map.set(incident.ticketId, incident);
    return map;
  }, [incidents]);

  async function link(): Promise<void> {
    const ids = linkInput
      .split(/[^0-9]+/)
      .map((token) => Number(token))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) return;

    setBusy(true);
    try {
      const result = await problemsApi.linkIncidents(problemTicketId, { incidentIds: ids, source: 'manual' });
      if (result.skipped.length > 0) {
        toast.error(
          t('problem.linkPartly', '{{linked}} linked, {{skipped}} refused.', {
            linked: result.linked.length,
            skipped: result.skipped.length,
          }),
        );
      } else {
        toast.success(t('problem.linked', '{{count}} incidents linked.', { count: result.linked.length }));
      }
      setLinkInput('');
      onReload();
    } catch (error) {
      toast.error(errorMessage(error, t('problem.linkFailed', 'The incidents could not be linked.')));
    } finally {
      setBusy(false);
    }
  }

  async function unlink(ticketId: number): Promise<void> {
    setBusy(true);
    try {
      await problemsApi.unlinkIncidents(problemTicketId, { incidentIds: [ticketId] });
      onReload();
    } catch (error) {
      toast.error(errorMessage(error, t('problem.unlinkFailed', 'The incident could not be unlinked.')));
    } finally {
      setBusy(false);
    }
  }

  async function runCascade(): Promise<void> {
    setBusy(true);
    try {
      const result = await problemsApi.runCascade(problemTicketId, {
        baseRowVersion: problem.rowVersion,
        policy,
      });
      toast.success(
        t('problem.cascadeDone', '{{resolved}} resolved, {{blocked}} left to a human.', {
          resolved: result.resolvedTicketIds.length,
          blocked: result.blocked.length,
        }),
      );
      setConfirmCascade(false);
      onReload();
    } catch (error) {
      toast.error(errorMessage(error, t('problem.cascadeFailed', 'The cascade could not be run.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card bg-bg-secondary p-5 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <PanelHeading icon={<Link2 size={12} aria-hidden />}>
          {t('problem.incidentsHeading', 'Linked incidents')}
        </PanelHeading>
        <span className="flex-1" />
        <select
          value={policy}
          onChange={(event) => setPreviewPolicy(event.target.value as ProblemClosurePolicy)}
          aria-label={t('problem.previewPolicy', 'Preview another closure policy')}
          className="rounded-pill bg-bg-tertiary px-2.5 py-1 text-[11px] text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent [&>option]:bg-bg-secondary [&>option]:text-text-primary"
        >
          {PROBLEM_CLOSURE_POLICIES.map((value) => (
            <option key={value} value={value}>
              {t(PROBLEM_CLOSURE_POLICY_LABELS[value].key, PROBLEM_CLOSURE_POLICY_LABELS[value].fallback)}
            </option>
          ))}
        </select>
      </div>

      {/* ── The plan, before anybody clicks ────────────────────────────── */}
      {/* Dimmed while the counts are the page's own rather than the whole
          population's: provisional figures should not look settled. */}
      <div
        className={clsx(
          'mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 transition-opacity',
          serverPlan === null && 'opacity-60',
        )}
      >
        <PlanTile value={plan.willResolve} tone="ok" label={t('problem.plan.willResolve', 'Will be resolved')} />
        <PlanTile value={plan.blocked} tone="warn" label={t('problem.plan.needsHuman', 'Needs a human')} />
        <PlanTile value={plan.workedNotWaiting} tone="neutral" label={t('problem.plan.worked', 'Worked, nobody waiting')} />
        {/* The bucket's own label, not a second wording of it: an incident an
            agent resolved himself lands here too, so "Already closed" would be
            wrong on exactly the rows the pill below already names correctly. */}
        <PlanTile
          value={plan.skippedTerminal}
          tone="muted"
          label={t(
            CASCADE_BUCKET_LABELS.skipped_terminal.key,
            CASCADE_BUCKET_LABELS.skipped_terminal.fallback,
          )}
        />
      </div>

      <p className="mt-2 text-[11px] leading-snug text-text-muted">
        {t(
          'problem.cascadeNote',
          'The cascade resolves; it never closes. A resolved incident stays reopenable and the requester can still object.',
        )}
      </p>

      {/* What the tiles above cover, said out loud whenever the list is short
          of the population. Without it the four figures read as a census of
          the rows underneath them, which they deliberately are not. */}
      {serverPlan !== null && serverPlan.total > incidents.length && (
        <p className="mt-2 text-[11px] leading-snug text-text-muted">
          {t(
            'problem.planScope',
            'Counted over all {{total}} linked incidents; the list below shows the first {{shown}}.',
            { total: serverPlan.total, shown: incidents.length },
          )}
        </p>
      )}

      {planUnreadable && (
        <p className="mt-2 flex items-start gap-1.5 rounded-card bg-sla-warn-bg px-2.5 py-1.5 text-[11px] leading-snug text-sla-warn">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
          {t(
            'problem.planUnavailable',
            'The full plan could not be read, so these counts cover only the incidents listed below. Reload before running the cascade.',
          )}
        </p>
      )}

      {plan.truncated && (
        <p className="mt-2 flex items-start gap-1.5 rounded-card bg-sla-warn-bg px-2.5 py-1.5 text-[11px] leading-snug text-sla-warn">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
          {t('problem.cascadeTruncated', '{{count}} incidents beyond the cap will be left untouched by one pass.', {
            count: plan.remaining,
          })}
        </p>
      )}

      {/* ── One row per incident, with the weight it carries ───────────── */}
      {incidents.length === 0 ? (
        <p className="mt-4 rounded-card bg-bg-tertiary px-3 py-4 text-center text-[12px] text-text-muted">
          {t('problem.noIncidents', 'No incident is linked to this problem yet.')}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {/* The page's own classification: one entry per row actually on
              screen. The server's plan covers more incidents than this list
              has rows, so it can only answer the counters above. */}
          {pagePlan.classifications.map((entry) => {
            const incident = byTicket.get(entry.ticketId);
            if (!incident) return null;
            const bucket = CASCADE_BUCKET_LABELS[entry.bucket];
            const category = statusCategoryLabel(incident.statusCategory);
            return (
              <li
                key={entry.ticketId}
                className="flex flex-wrap items-center gap-2 rounded-card bg-bg-tertiary px-2.5 py-2"
              >
                <Link
                  to={`/tickets/${incident.ticketId}`}
                  className="font-mono text-[11px] text-text-secondary transition-colors hover:text-accent"
                >
                  {incident.number}
                </Link>

                {/* The snapshot now carries the status the operator reads, so
                    the chip says what every other screen says. The category
                    still decides the colour (HARD RULE 5); it only stopped
                    deciding the words. Falling back to the slug is the same
                    thing ContextRail does when no configured label is joined. */}
                <StatusPill
                  statusSlug={incident.statusSlug}
                  category={incident.statusCategory}
                  label={incident.statusSlug || t(category.key, category.fallback)}
                  size="sm"
                />

                <span
                  className={clsx(
                    'rounded-pill px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]',
                    BUCKET_CLASSES[entry.bucket],
                  )}
                >
                  {t(bucket.key, bucket.fallback)}
                </span>

                {entry.blockReason && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">
                    {t(
                      CASCADE_BLOCK_REASON_LABELS[entry.blockReason].key,
                      CASCADE_BLOCK_REASON_LABELS[entry.blockReason].fallback,
                    )}
                  </span>
                )}

                <span className="flex-1" />

                {canWrite && (
                  <IconAction
                    icon={<Unlink size={12} />}
                    label={t('problem.unlink', 'Unlink this incident')}
                    onClick={() => void unlink(incident.ticketId)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canWrite && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
              {t('problem.linkIncidents', 'Link incidents')}
            </span>
            <input
              type="text"
              value={linkInput}
              onChange={(event) => setLinkInput(event.target.value)}
              placeholder={t('problem.linkPlaceholder', 'Ticket identifiers, separated by commas')}
              className="rounded-card bg-bg-tertiary px-2.5 py-1.5 font-mono text-[13px] text-text-primary placeholder:font-sans placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void link()}>
            {t('problem.linkApply', 'Link')}
          </Button>

          <span className="flex-1" />

          {/* No approving a figure the page has not got: until the server's
              plan is in, the operator would be confirming the slice. */}
          <Button
            size="sm"
            variant="secondary"
            icon={<Wrench size={14} />}
            disabled={serverPlan === null || (plan.willResolve === 0 && plan.willNotify === 0)}
            onClick={() => setConfirmCascade(true)}
            title={
              serverPlan === null
                ? t(
                    'problem.runCascadePending',
                    'The plan over every linked incident is not readable yet. The cascade acts on all of them, not only on the ones listed here.',
                  )
                : t(
                    'problem.runCascadeHint',
                    'The cascade also runs on its own when the problem moves to a resolved status.',
                  )
            }
          >
            {t('problem.runCascade', 'Run the cascade now')}
          </Button>
        </div>
      )}

      <Modal
        open={confirmCascade}
        onClose={() => setConfirmCascade(false)}
        size="md"
        title={t('problem.cascadeConfirmTitle', 'Run the closure cascade')}
        subtitle={t(
          PROBLEM_CLOSURE_POLICY_LABELS[policy].key,
          PROBLEM_CLOSURE_POLICY_LABELS[policy].fallback,
        )}
        closeLabel={t('common.close', 'Close')}
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirmCascade(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void runCascade()}>
              {t('problem.cascadeConfirm', 'Run it')}
            </Button>
          </div>
        }
      >
        <p className="text-[13px] leading-relaxed text-text-primary">
          {t(
            'problem.cascadeConfirmBody',
            '{{resolve}} incidents will be moved to a resolved status and {{notify}} will only get an automation note. Nothing will be closed.',
            { resolve: plan.willResolve, notify: plan.willNotify },
          )}
        </p>
      </Modal>
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Known error
// ═════════════════════════════════════════════════════════════════════════════

function KnownErrorPanel({
  problemTicketId,
  problem,
  publication,
  publishAllowed,
  canWrite,
  canPublishKb,
  onSaveField,
  onReplaced,
}: {
  problemTicketId: number;
  problem: ProblemWithRelations;
  publication: ProblemRequirement[];
  publishAllowed: boolean;
  canWrite: boolean;
  canPublishKb: boolean;
  onSaveField: (patch: Omit<UpdateProblemRequest, 'baseRowVersion'>) => Promise<void>;
  onReplaced: (next: ProblemWithRelations) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<ProblemWithRelations>, failure: string): Promise<void> {
    setBusy(true);
    try {
      onReplaced(await action());
    } catch (error) {
      toast.error(errorMessage(error, failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card bg-bg-secondary p-5 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <PanelHeading icon={<Wrench size={12} aria-hidden />}>
          {t('problem.workaroundHeading', 'Workaround and known error')}
        </PanelHeading>
        <span className="flex-1" />
        <KnownErrorPill state={problem.knownErrorState} />
      </div>

      {problem.knownErrorPublishedAt && (
        <p className="mt-1 font-mono text-[10px] text-text-muted">
          {t('problem.publishedAt', 'Published {{when}}', {
            when: formatRelative(problem.knownErrorPublishedAt, t),
          })}
        </p>
      )}

      <div className="mt-3 space-y-3">
        <InlineField
          field="workaroundMd"
          label={t('problem.field.workaround', 'Workaround')}
          value={problem.workaroundMd}
          type="textarea"
          rows={5}
          readOnly={!canWrite}
          placeholder={t('problem.field.workaroundPlaceholder', 'The steps the desk applies at 09:00')}
          helpText={t(
            'problem.field.workaroundHint',
            'Written for whoever picks up the next incident, not for the person who found it.',
          )}
          onSave={(value) => onSaveField({ workaroundMd: value })}
        />

        <InlineField
          field="workaroundRisk"
          label={t('problem.field.risk', 'Risk of applying it')}
          value={problem.workaroundRisk}
          type="select"
          readOnly={!canWrite}
          options={WORKAROUND_RISKS.map((risk) => ({
            value: risk,
            label: t(WORKAROUND_RISK_LABELS[risk].key, WORKAROUND_RISK_LABELS[risk].fallback),
          }))}
          onSave={(value) => onSaveField({ workaroundRisk: value as WorkaroundRisk | null })}
        />

        {problem.workaroundRisk && (
          <span
            className={clsx(
              'inline-flex items-center rounded-pill px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]',
              RISK_CLASSES[problem.workaroundRisk],
            )}
          >
            {t(
              WORKAROUND_RISK_LABELS[problem.workaroundRisk].key,
              WORKAROUND_RISK_LABELS[problem.workaroundRisk].fallback,
            )}
          </span>
        )}

        <div className="flex items-center gap-2 rounded-card bg-bg-tertiary px-2.5 py-2">
          {problem.workaroundVerifiedAt ? (
            <>
              <Check size={13} className="shrink-0 text-sla-ok" aria-hidden />
              <span className="min-w-0 flex-1 text-[12px] text-text-secondary">
                {t('problem.workaroundVerified', 'Replayed {{when}}', {
                  when: formatRelative(problem.workaroundVerifiedAt, t),
                })}
              </span>
            </>
          ) : (
            <span className="min-w-0 flex-1 text-[12px] leading-snug text-text-muted">
              {t('problem.workaroundUnverified', 'Never replayed. A workaround nobody re-ran is a hypothesis.')}
            </span>
          )}
          {canWrite && (
            <Button
              size="xs"
              variant="secondary"
              loading={busy}
              onClick={() =>
                void run(
                  () =>
                    problemsApi.verifyWorkaround(problemTicketId, {
                      baseRowVersion: problem.rowVersion,
                    }),
                  t('problem.verifyFailed', 'The workaround could not be marked as replayed.'),
                )
              }
            >
              {t('problem.verifyWorkaround', 'Mark replayed')}
            </Button>
          )}
        </div>
      </div>

      {/* ── Publication, gated by the shared evaluator ─────────────────── */}
      {canWrite && (
        <div className="mt-4 space-y-2">
          {problem.knownErrorState !== 'published' ? (
            <>
              <Button
                size="sm"
                variant="primary"
                fullWidth
                icon={<AlertTriangle size={14} />}
                loading={busy}
                disabled={!publishAllowed}
                onClick={() =>
                  void run(
                    () =>
                      problemsApi.publishKnownError(problemTicketId, {
                        baseRowVersion: problem.rowVersion,
                      }),
                    t('problem.publishFailed', 'The known error could not be published.'),
                  )
                }
              >
                {t('problem.publishKnownError', 'Publish as a known error')}
              </Button>

              {!publishAllowed && (
                <BlockerList
                  heading={t('problem.toPublish', 'Before the desk can be offered this')}
                  blockers={publication}
                  missingCapabilities={false}
                />
              )}
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                loading={busy}
                onClick={() =>
                  void run(
                    () =>
                      problemsApi.retireKnownError(problemTicketId, {
                        baseRowVersion: problem.rowVersion,
                      }),
                    t('problem.retireFailed', 'The known error could not be retired.'),
                  )
                }
                title={t(
                  'problem.retireHint',
                  'The workaround stays readable: incidents closed months ago reference it.',
                )}
              >
                {t('problem.retireKnownError', 'Retire it')}
              </Button>

              {canPublishKb && problem.kbArticleId === null && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<BookOpen size={14} />}
                  loading={busy}
                  onClick={() =>
                    void run(
                      async () => {
                        const result = await problemsApi.publishToKb(problemTicketId, {
                          baseRowVersion: problem.rowVersion,
                        });
                        toast.success(t('problem.kbCreated', 'Article created. It now lives on its own.'));
                        return result.problem;
                      },
                      t('problem.kbFailed', 'The article could not be created.'),
                    )
                  }
                  title={t(
                    'problem.kbHint',
                    'Seeds an article from this workaround. The two never synchronise afterwards, in either direction.',
                  )}
                >
                  {t('problem.publishToKb', 'Seed a KB article')}
                </Button>
              )}

              {problem.kbArticleId !== null && (
                <span className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2.5 py-1 text-[11px] text-text-secondary">
                  <BookOpen size={11} aria-hidden />
                  {t('problem.kbLinked', 'Article {{id}}', { id: problem.kbArticleId })}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Governance and alert signatures
// ═════════════════════════════════════════════════════════════════════════════

function GovernancePanel({
  problem,
  canWrite,
  onSaveField,
}: {
  problem: ProblemWithRelations;
  canWrite: boolean;
  onSaveField: (patch: Omit<UpdateProblemRequest, 'baseRowVersion'>) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();

  function fire(patch: Omit<UpdateProblemRequest, 'baseRowVersion'>, failure: string): void {
    void onSaveField(patch).catch((error: unknown) => toast.error(errorMessage(error, failure)));
  }

  return (
    <section className="rounded-card bg-bg-secondary p-5 shadow-card">
      <PanelHeading icon={<Target size={12} aria-hidden />}>
        {t('problem.governanceHeading', 'How this problem is run')}
      </PanelHeading>

      <div className="mt-3 space-y-3">
        <Toggle
          checked={problem.rcaRequired}
          disabled={!canWrite}
          labelFirst
          label={t('problem.field.rcaRequired', 'A root-cause analysis is required')}
          description={t(
            'problem.field.rcaRequiredHint',
            'Turn it off for a problem the team is only tracking.',
          )}
          onChange={(next) =>
            fire({ rcaRequired: next }, t('problem.saveFailed', 'The change could not be saved.'))
          }
        />

        <Toggle
          checked={problem.major}
          disabled={!canWrite}
          labelFirst
          label={t('problem.field.major', 'Major problem')}
          description={t('problem.field.majorHint', 'It owes a formal review by the date below.')}
          onChange={(next) =>
            fire({ major: next }, t('problem.saveFailed', 'The change could not be saved.'))
          }
        />

        {problem.major && (
          <InlineField
            field="majorReviewDueAt"
            label={t('problem.field.majorReviewDue', 'Review due')}
            value={toLocalInput(problem.majorReviewDueAt)}
            type="datetime"
            readOnly={!canWrite}
            onSave={(value) => onSaveField({ majorReviewDueAt: fromLocalInput(value) })}
          />
        )}

        <InlineField
          field="closurePolicy"
          label={t('problem.field.closurePolicy', 'When this problem is resolved')}
          value={problem.closurePolicy}
          type="select"
          readOnly={!canWrite}
          options={PROBLEM_CLOSURE_POLICIES.map((value) => ({
            value,
            label: t(
              PROBLEM_CLOSURE_POLICY_LABELS[value].key,
              PROBLEM_CLOSURE_POLICY_LABELS[value].fallback,
            ),
          }))}
          helpText={t(
            'problem.field.closurePolicyHint',
            'Decided once, here, visibly. It is what the cascade obeys.',
          )}
          onSave={(value) => onSaveField({ closurePolicy: (value ?? 'notify_only') as ProblemClosurePolicy })}
        />
      </div>
    </section>
  );
}

function SignaturePanel({
  problemTicketId,
  signatures,
  canWrite,
  onChanged,
}: {
  problemTicketId: number;
  signatures: ProblemAlertSignature[];
  canWrite: boolean;
  onChanged: (next: ProblemAlertSignature[]) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [sourceApp, setSourceApp] = useState('');
  const [dedupeKey, setDedupeKey] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(): Promise<void> {
    if (!sourceApp.trim() || !dedupeKey.trim()) return;
    setBusy(true);
    try {
      const created = await problemsApi.addSignature(problemTicketId, {
        sourceApp: sourceApp.trim(),
        dedupeKey: dedupeKey.trim(),
      });
      onChanged([...signatures, created]);
      setSourceApp('');
      setDedupeKey('');
    } catch (error) {
      toast.error(errorMessage(error, t('problem.signatureFailed', 'The signature could not be added.')));
    } finally {
      setBusy(false);
    }
  }

  async function remove(signatureId: number): Promise<void> {
    setBusy(true);
    try {
      await problemsApi.removeSignature(problemTicketId, signatureId);
      onChanged(signatures.filter((entry) => entry.id !== signatureId));
    } catch (error) {
      toast.error(errorMessage(error, t('problem.signatureRemoveFailed', 'The signature could not be removed.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card bg-bg-secondary p-5 shadow-card">
      <PanelHeading icon={<Siren size={12} aria-hidden />}>
        {t('problem.signaturesHeading', 'Alert signatures')}
      </PanelHeading>
      <p className="mt-1 text-[11px] leading-snug text-text-muted">
        {t(
          'problem.signaturesHint',
          'Dedupe keys an engineer declared equivalent to this problem. An alert carrying one of them is matched on ingest and the workaround is stamped into the new incident.',
        )}
      </p>

      {signatures.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {signatures.map((signature) => (
            <li
              key={signature.id}
              className="flex items-center gap-2 rounded-card bg-bg-tertiary px-2.5 py-1.5"
            >
              <span className="shrink-0 rounded-pill bg-bg-hover px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-text-muted">
                {signature.sourceApp}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">
                {signature.dedupeKey}
              </span>
              {canWrite && (
                <IconAction
                  icon={<X size={12} />}
                  label={t('problem.removeSignature', 'Remove this signature')}
                  onClick={() => void remove(signature.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex w-24 flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
              {t('problem.field.sourceApp', 'App')}
            </span>
            <input
              type="text"
              value={sourceApp}
              onChange={(event) => setSourceApp(event.target.value)}
              placeholder="obliview"
              className="rounded-card bg-bg-tertiary px-2 py-1.5 font-mono text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>
          <label className="flex min-w-[10rem] flex-1 flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
              {t('problem.field.dedupeKey', 'Dedupe key')}
            </span>
            <input
              type="text"
              value={dedupeKey}
              onChange={(event) => setDedupeKey(event.target.value)}
              placeholder={t('problem.field.dedupeKeyPlaceholder', 'monitor:1042:down')}
              className="rounded-card bg-bg-tertiary px-2 py-1.5 font-mono text-[12px] text-text-primary placeholder:font-sans placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void add()}>
            {t('problem.addSignature', 'Add')}
          </Button>
        </div>
      )}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Small local pieces
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What stands between the actor and the action, in the evaluator's own words.
 * The list is the whole point: "the button is grey" without a reason is how an
 * agent learns to fight the form instead of the incident.
 */
function BlockerList({
  heading,
  blockers,
  missingCapabilities,
}: {
  heading: string;
  blockers: ProblemRequirement[];
  missingCapabilities: boolean;
}): JSX.Element | null {
  const { t } = useTranslation();
  if (blockers.length === 0 && !missingCapabilities) return null;

  return (
    <div className="mt-3 rounded-card bg-bg-tertiary p-3">
      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">{heading}</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {blockers.map((blocker) => (
          <li key={blocker.code} className="flex items-start gap-1.5 text-[12px] leading-snug text-text-secondary">
            <CircleDot size={11} className="mt-0.5 shrink-0 text-sla-warn" aria-hidden />
            <span>{t(blocker.key, blocker.fallback)}</span>
          </li>
        ))}
        {missingCapabilities && (
          <li className="flex items-start gap-1.5 text-[12px] leading-snug text-text-secondary">
            <CircleDot size={11} className="mt-0.5 shrink-0 text-sla-breach" aria-hidden />
            <span>{t('problem.needsProblemRw', 'Managing problems requires the problem capability.')}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

function PlanTile({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: 'ok' | 'warn' | 'neutral' | 'muted';
}): JSX.Element {
  const toneClass =
    tone === 'ok'
      ? 'text-sla-ok'
      : tone === 'warn'
        ? 'text-sla-warn'
        : tone === 'neutral'
          ? 'text-accent'
          : 'text-text-muted';

  return (
    <div className="rounded-card bg-bg-tertiary px-3 py-2">
      <p className={clsx('font-mono text-[20px] font-semibold leading-none', toneClass)}>{value}</p>
      <p className="mt-1 text-[11px] leading-snug text-text-muted">{label}</p>
    </div>
  );
}

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

function ViewChip({
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
        'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] transition-colors',
        active
          ? 'bg-bg-active text-text-primary'
          : 'text-text-muted hover:bg-bg-hover hover:text-text-secondary',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function NodeSelect({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  className,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (next: string) => void;
  disabled: boolean;
  ariaLabel: string;
  className?: string;
}): JSX.Element {
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      className={clsx(
        'rounded-pill px-2 py-0.5 text-[11px] transition-colors focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-default disabled:opacity-70',
        '[&>option]:bg-bg-secondary [&>option]:text-text-primary',
        className ?? 'bg-bg-hover text-text-secondary',
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function IconAction({
  icon,
  label,
  onClick,
  danger = false,
  active = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  active?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={clsx(
        'inline-flex h-6 w-6 items-center justify-center rounded-pill transition-colors',
        active
          ? 'bg-accent/20 text-accent'
          : danger
            ? 'text-text-muted hover:bg-priority-p1/15 hover:text-priority-p1'
            : 'text-text-muted hover:bg-bg-hover hover:text-text-secondary',
      )}
    >
      {icon}
    </button>
  );
}

function NotFoundCard({ title, body }: { title: string; body: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="p-6">
      <div className="mx-auto max-w-md space-y-3 rounded-card bg-bg-secondary p-8 text-center shadow-card">
        <h1 className="font-display text-xl font-semibold tracking-wide text-text-primary">{title}</h1>
        <p className="text-[13px] leading-relaxed text-text-muted">{body}</p>
        <Link to="/problems">
          <Button size="sm" variant="secondary" icon={<ArrowLeft size={14} />}>
            {t('problem.backToList', 'All problems')}
          </Button>
        </Link>
      </div>
    </div>
  );
}

export default ProblemDetailPage;
