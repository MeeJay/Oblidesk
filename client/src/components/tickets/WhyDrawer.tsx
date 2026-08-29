/**
 * WhyDrawer.tsx — "pourquoi ce ticket est-il comme ça ?"
 *
 * ── A straight read of decision_log ──────────────────────────────────────────
 * `GET /api/tickets/:id/explain` returns the ticket's `decision_log` rows, in
 * order, each with the condition trace the engine evaluated and the config
 * object slug that decided (HARD RULE 2 and HARD RULE 3). This component
 * renders that and nothing else — it does not infer, correlate or summarise.
 * The moment the drawer starts reconstructing a story the log did not record,
 * it stops being evidence and becomes a plausible narrative, which is exactly
 * what an audit needs not to be.
 *
 * ── Every card deep-links to the thing that decided ──────────────────────────
 * A decision naming `rule: escalate_p1_after_15m` is only half an answer. The
 * other half is the rule itself, at the version that ran — so each card links
 * to `config/<kind>/<slug>` and carries the version it fired at, because the
 * object may well have been edited since.
 *
 * ── "Nothing happened" is also an answer ─────────────────────────────────────
 * `decision_log` explains why something happened. It structurally cannot
 * explain why NOTHING happened — a rule that was evaluated and did not match
 * writes a `rule_executions` row, not a decision. The detailed payload carries
 * those too, and they get their own section, because "aucune règle n'a
 * correspondu" is the answer to half the questions people open this drawer
 * with.
 */
import { useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock3,
  Gauge,
  Loader2,
  ShieldCheck,
  Timer,
  X,
} from 'lucide-react';
import type {
  ConditionTrace,
  DecisionLogEntry,
  DecisionSubsystem,
  WhyExplanation,
} from '@oblidesk/shared';
import apiClient from '@/api/client';
import { formatAbsolute, formatRelative } from './SlaChip';

// ═════════════════════════════════════════════════════════════════════════════
// The wire shape (server: services/decision.service.ts → explainDetailed)
// ═════════════════════════════════════════════════════════════════════════════

interface SlaExplanation {
  targetSlug: string;
  policySlug: string;
  policyVersion: number;
  calendarSlug: string;
  status: string;
  running: boolean;
  startedAt: string;
  dueAt: string | null;
  pausedMs: number;
  breachedAt: string | null;
  metAt: string | null;
  lastEvent: { event: string; reasonCode: string | null; at: string; note: string | null } | null;
}

interface ApprovalExplanation {
  id: number;
  definitionSlug: string;
  state: string;
  mode: string;
  quorum: number | null;
  dueAt: string | null;
  blockingSteps: Array<{
    stepIndex: number;
    approverUserId: number | null;
    approverGroupId: number | null;
    state: string;
  }>;
}

interface RuleExecutionExplanation {
  ruleSlug: string;
  ruleVersion: number;
  at: string;
  matched: boolean;
  [key: string]: unknown;
}

export interface WhyExplanationDetailed extends WhyExplanation {
  sla?: SlaExplanation[];
  approvals?: ApprovalExplanation[];
  ruleExecutions?: RuleExecutionExplanation[];
}

type ExplainEntry = WhyExplanation['entries'][number];

// ═════════════════════════════════════════════════════════════════════════════
// Presentation tables
// ═════════════════════════════════════════════════════════════════════════════

const SUBSYSTEM_META: Readonly<
  Record<DecisionSubsystem, { key: string; fallback: string; icon: typeof Bot }>
> = {
  routing: { key: 'why.subsystem.routing', fallback: 'Routage', icon: ArrowUpRight },
  priority: { key: 'why.subsystem.priority', fallback: 'Priorité', icon: Gauge },
  sla: { key: 'why.subsystem.sla', fallback: 'SLA', icon: Timer },
  assignment: { key: 'why.subsystem.assignment', fallback: 'Affectation', icon: ArrowUpRight },
  escalation: { key: 'why.subsystem.escalation', fallback: 'Escalade', icon: AlertTriangle },
  approval: { key: 'why.subsystem.approval', fallback: 'Approbation', icon: ShieldCheck },
  rule: { key: 'why.subsystem.rule', fallback: 'Règle', icon: Bot },
  alert: { key: 'why.subsystem.alert', fallback: 'Alerte', icon: AlertTriangle },
  ai: { key: 'why.subsystem.ai', fallback: 'IA', icon: Bot },
  workflow: { key: 'why.subsystem.workflow', fallback: 'Workflow', icon: ChevronRight },
};

/** Which config kind a subsystem's `ruleSlug` points at, for the deep link. */
const SUBSYSTEM_CONFIG_KIND: Readonly<Record<DecisionSubsystem, string>> = {
  routing: 'queue',
  priority: 'priority_matrix',
  sla: 'sla',
  assignment: 'queue',
  escalation: 'escalation',
  approval: 'approval',
  rule: 'rule',
  alert: 'alert_binding',
  ai: 'rule',
  workflow: 'state_machine',
};

function TraceLines({ trace, depth = 0 }: { trace: ConditionTrace; depth?: number }): JSX.Element {
  const mark = trace.matched ? '✓' : '✗';
  const tone = trace.matched ? 'text-sla-ok' : 'text-sla-breach';

  if (trace.type === 'invalid') {
    return (
      <div className="font-mono text-[11px] text-text-muted" style={{ paddingLeft: depth * 12 }}>
        <span className="text-sla-breach">✗</span> {trace.detail}
      </div>
    );
  }

  if (trace.type === 'leaf') {
    return (
      <div className="font-mono text-[11px]" style={{ paddingLeft: depth * 12 }}>
        <span className={tone}>{mark}</span>{' '}
        <span className="text-text-primary">{trace.field}</span>{' '}
        <span className="text-text-muted">{trace.op}</span>{' '}
        <span className="text-accent">{JSON.stringify(trace.value ?? null)}</span>{' '}
        <span className="text-text-muted">→ {JSON.stringify(trace.actual ?? null)}</span>
      </div>
    );
  }

  return (
    <div>
      <div className="font-mono text-[11px]" style={{ paddingLeft: depth * 12 }}>
        <span className={tone}>{mark}</span>{' '}
        <span className="uppercase tracking-[0.08em] text-text-muted">
          {trace.type === 'not' ? 'NON' : trace.type === 'all' ? 'TOUTES' : 'AU MOINS UNE'}
        </span>
      </div>
      {trace.children.map((child, index) => (
        <TraceLines key={index} trace={child} depth={depth + 1} />
      ))}
    </div>
  );
}

function DecisionCard({
  entry,
  onOpenConfig,
}: {
  entry: ExplainEntry;
  onOpenConfig?: (kind: string, slug: string, version: number | null) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const meta = SUBSYSTEM_META[entry.subsystem] ?? SUBSYSTEM_META.rule;
  const Icon = meta.icon;
  const kind = SUBSYSTEM_CONFIG_KIND[entry.subsystem] ?? 'rule';
  const trace = (entry.inputs as DecisionLogEntry['inputs'])?.trace;

  return (
    <article className="rounded-card bg-bg-secondary p-3 shadow-card">
      <header className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">
          <Icon size={11} aria-hidden />
          {t(meta.key, meta.fallback)}
        </span>

        <span className="font-mono text-[11px] text-text-primary">{entry.decision}</span>

        <span className="flex-1" />

        {entry.durationMs !== null && (
          <span className="font-mono text-[10px] text-text-muted">{entry.durationMs} ms</span>
        )}

        <time
          dateTime={entry.at}
          title={formatAbsolute(entry.at)}
          className="font-mono text-[10px] text-text-muted"
        >
          {formatRelative(entry.at, t)}
        </time>
      </header>

      <p className="mt-1.5 text-[13px] leading-snug text-text-primary">{entry.summary}</p>

      {entry.actorLabel && (
        <p className="mt-1 text-[11px] text-text-muted">
          {t('why.actor', 'Acteur')} : {entry.actorLabel}
        </p>
      )}

      {/* The config object that decided — HARD RULE 3, a slug, deep-linked. */}
      {entry.ruleSlug && (
        <button
          type="button"
          onClick={() => onOpenConfig?.(kind, entry.ruleSlug as string, entry.ruleVersion)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2 py-1 font-mono text-[11px] text-accent hover:bg-bg-hover"
        >
          {kind}/{entry.ruleSlug}
          {entry.ruleVersion !== null ? ` v${entry.ruleVersion}` : ''}
          <ArrowUpRight size={11} aria-hidden />
        </button>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mt-2 flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted hover:text-text-secondary"
      >
        {open ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
        {t('why.details', 'Entrées et résultat')}
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {trace && (
            <div className="overflow-x-auto rounded-card bg-bg-tertiary p-2">
              <TraceLines trace={trace} />
            </div>
          )}
          <pre className="max-h-56 overflow-auto rounded-card bg-bg-tertiary p-2 font-mono text-[10px] leading-relaxed text-text-secondary">
            {JSON.stringify({ inputs: entry.inputs, outcome: entry.outcome }, null, 2)}
          </pre>
        </div>
      )}
    </article>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The drawer
// ═════════════════════════════════════════════════════════════════════════════

export interface WhyDrawerProps {
  ticketId: number;
  ticketNumber?: string;
  open: boolean;
  onClose: () => void;
  onOpenConfig?: (kind: string, slug: string, version: number | null) => void;
  /** Scroll to the card produced by this decision_log row. */
  focusDecisionId?: number | null;
}

export default function WhyDrawer({
  ticketId,
  ticketNumber,
  open,
  onClose,
  onOpenConfig,
  focusDecisionId,
}: WhyDrawerProps): JSX.Element | null {
  const { t } = useTranslation();
  const [data, setData] = useState<WhyExplanationDetailed | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'unavailable'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    setState('loading');
    setMessage(null);

    apiClient
      .get<{ success: boolean; data: WhyExplanationDetailed }>(`/tickets/${ticketId}/explain`)
      .then((response) => {
        setData(response.data.data);
        setState('idle');
      })
      .catch((error: unknown) => {
        const status =
          typeof error === 'object' && error !== null
            ? (error as { response?: { status?: number; data?: { error?: string } } }).response
            : undefined;

        // A 404 here means the explain endpoint is not on this server yet —
        // say that, rather than implying the ticket has no history.
        if (status?.status === 404) {
          setState('unavailable');
          setMessage(
            t(
              'why.notDeployed',
              'Le journal des décisions n’est pas encore exposé par ce serveur (GET /api/tickets/:id/explain).',
            ),
          );
          return;
        }
        setState('error');
        setMessage(status?.data?.error ?? t('why.failed', 'Lecture impossible.'));
      });
  }, [ticketId, t]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const entries = data?.entries ?? [];
  const unmatched = (data?.ruleExecutions ?? []).filter((execution) => !execution.matched);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label={t('common.close', 'Fermer')}
        onClick={onClose}
        className="flex-1 bg-black/40"
      />

      <div className="flex h-full w-[min(34rem,100vw)] flex-col bg-bg-primary shadow-card">
        <header className="flex shrink-0 items-center gap-2 px-4 py-3">
          <Clock3 size={15} className="text-accent" aria-hidden />
          <h2 className="flex-1 font-display text-[20px] font-semibold text-text-primary">
            {t('why.title', 'Pourquoi ?')}
            {ticketNumber && (
              <span className="ml-2 font-mono text-[12px] font-normal text-text-muted">
                {ticketNumber}
              </span>
            )}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-pill p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary"
            aria-label={t('common.close', 'Fermer')}
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-6">
          {state === 'loading' && (
            <p className="flex items-center gap-2 py-8 text-[13px] text-text-muted">
              <Loader2 size={14} className="animate-spin" aria-hidden />
              {t('why.loading', 'Lecture du journal des décisions…')}
            </p>
          )}

          {(state === 'error' || state === 'unavailable') && (
            <div className="rounded-card bg-bg-secondary p-4 shadow-card">
              <p
                className={clsx(
                  'text-[13px]',
                  state === 'unavailable' ? 'text-text-secondary' : 'text-sla-breach',
                )}
              >
                {message}
              </p>
              <button
                type="button"
                onClick={load}
                className="mt-2 rounded-pill bg-bg-tertiary px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover"
              >
                {t('common.retry', 'Réessayer')}
              </button>
            </div>
          )}

          {state === 'idle' && entries.length === 0 && (
            <p className="py-8 text-center text-[13px] text-text-muted">
              {t(
                'why.empty',
                'Aucune décision automatique enregistrée : ce ticket a été piloté à la main de bout en bout.',
              )}
            </p>
          )}

          {/* ── The causal chain, oldest first ─────────────────────────── */}
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={clsx(focusDecisionId === entry.id && 'rounded-card ring-1 ring-accent')}
            >
              <DecisionCard entry={entry} onOpenConfig={onOpenConfig} />
            </div>
          ))}

          {/* ── SLA clocks: why the countdown says what it says ────────── */}
          {data?.sla && data.sla.length > 0 && (
            <section className="mt-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                {t('why.slaSection', 'Horloges SLA')}
              </h3>
              <div className="mt-1.5 flex flex-col gap-1.5">
                {data.sla.map((clock) => (
                  <div
                    key={`${clock.policySlug}-${clock.targetSlug}`}
                    className="rounded-card bg-bg-secondary p-2.5 text-[12px] shadow-card"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-text-primary">{clock.targetSlug}</span>
                      <span className="font-mono text-[10px] text-text-muted">
                        {clock.policySlug} v{clock.policyVersion} · {clock.calendarSlug}
                      </span>
                      <span className="flex-1" />
                      <span
                        className={clsx(
                          'rounded-pill px-2 py-0.5 font-mono text-[10px]',
                          clock.status === 'breached'
                            ? 'bg-sla-breach-bg text-sla-breach'
                            : clock.running
                              ? 'bg-sla-ok-bg text-sla-ok'
                              : 'bg-sla-paused-bg text-sla-paused',
                        )}
                      >
                        {clock.status}
                      </span>
                    </div>
                    {clock.lastEvent && (
                      <p className="mt-1 text-[11px] text-text-muted">
                        {t('why.lastClockEvent', 'Dernier événement')} : {clock.lastEvent.event}
                        {clock.lastEvent.reasonCode ? ` (${clock.lastEvent.reasonCode})` : ''} ·{' '}
                        {formatRelative(clock.lastEvent.at, t)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Approvals that are blocking ────────────────────────────── */}
          {data?.approvals && data.approvals.length > 0 && (
            <section className="mt-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                {t('why.approvalsSection', 'Approbations')}
              </h3>
              <div className="mt-1.5 flex flex-col gap-1.5">
                {data.approvals.map((approval) => (
                  <div
                    key={approval.id}
                    className="rounded-card bg-bg-secondary p-2.5 text-[12px] shadow-card"
                  >
                    <span className="font-mono text-text-primary">{approval.definitionSlug}</span>
                    <span className="ml-2 font-mono text-[10px] text-text-muted">
                      {approval.mode}
                      {approval.quorum ? ` · quorum ${approval.quorum}` : ''}
                    </span>
                    <p className="mt-1 text-[11px] text-text-muted">
                      {t('why.approvalState', 'État')} : {approval.state}
                      {approval.blockingSteps.length > 0
                        ? ` — ${t('why.blockingSteps', '{{count}} étape(s) en attente', {
                            count: approval.blockingSteps.length,
                          })}`
                        : ''}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── "Rien ne s'est passé" — the question decision_log cannot answer */}
          {unmatched.length > 0 && (
            <section className="mt-2">
              <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                {t('why.evaluatedSection', 'Règles évaluées sans correspondance')}
              </h3>
              <ul className="mt-1.5 flex flex-col gap-1">
                {unmatched.slice(0, 20).map((execution, index) => (
                  <li
                    key={`${execution.ruleSlug}-${index}`}
                    className="flex items-center gap-2 rounded-card bg-bg-secondary px-2.5 py-1.5 text-[11px] shadow-card"
                  >
                    <Bot size={11} className="shrink-0 text-text-muted" aria-hidden />
                    <span className="flex-1 truncate font-mono text-text-secondary">
                      {execution.ruleSlug} v{execution.ruleVersion}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-text-muted">
                      {formatRelative(execution.at, t)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
