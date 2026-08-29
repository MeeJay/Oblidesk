/**
 * TicketHeader.tsx — identity, state, and the only moves that exist.
 *
 * ── The transition bar renders the SERVER's answer, nothing else ─────────────
 * `GET /api/tickets/:id/transitions` returns every edge the state machine
 * declares out of the current status, blocked ones included, each with the
 * reasons it is blocked. This bar renders exactly that list. It does not filter
 * it, does not add a "Resolve" button because resolving seems reasonable, and
 * does not hide a blocked move.
 *
 * A hidden blocked move is the worst of the three options: the agent concludes
 * the desk cannot do the thing, escalates, and the answer turns out to be "you
 * needed to fill the resolution notes". A greyed button that says exactly that
 * costs one hover.
 *
 * ── HARD RULE 6 is on screen ────────────────────────────────────────────────
 * `occurred_at` and `created_at` are shown as two different facts — "survenu"
 * and "créé" — because they are. An alert that fired at 02:14 and was ticketed
 * at 08:30 is a six-hour detection gap, and that gap is invisible on any desk
 * that shows one timestamp.
 *
 * ── HARD RULE 12 is on screen too ───────────────────────────────────────────
 * The subject is an InlineField: it autosaves on blur and never checks whether
 * it is "valid enough". Obligation appears only when a transition is attempted,
 * and then it appears as a named list in TransitionInspector.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  AlarmClock,
  CalendarClock,
  ChevronDown,
  Eye,
  HelpCircle,
  Inbox,
  Loader2,
  Radio,
  RotateCcw,
  UserRound,
} from 'lucide-react';
import type { TicketPresenceEvent, TicketWithRelations } from '@oblidesk/shared';
import InlineField from './InlineField';
import PresenceBar from './PresenceBar';
import PriorityBadge from './PriorityBadge';
import SlaChip, { SlaChipRow, formatAbsolute, formatRelative, nearestInstance } from './SlaChip';
import StatusPill from './StatusPill';
import TransitionInspector, {
  describeBlockedTransition,
  transitionLabel,
  type AvailableTransitions,
  type TransitionOption,
} from './TransitionInspector';

type Viewer = TicketPresenceEvent['viewers'][number];

const SOURCE_LABEL: Readonly<Record<string, { key: string; fallback: string }>> = {
  web: { key: 'source.web', fallback: 'Web' },
  email: { key: 'source.email', fallback: 'Courriel' },
  portal: { key: 'source.portal', fallback: 'Portail' },
  api: { key: 'source.api', fallback: 'API' },
  alert: { key: 'source.alert', fallback: 'Alerte suite' },
  phone: { key: 'source.phone', fallback: 'Téléphone' },
  chat: { key: 'source.chat', fallback: 'Chat' },
};

export interface TicketHeaderProps {
  ticket: TicketWithRelations;
  transitions: AvailableTransitions | null;
  transitionsLoading?: boolean;
  /** Fire a transition. The parent collects prompted fields and handles 422. */
  onTransition: (option: TransitionOption) => void;
  /** Inline autosave — one field, one PATCH, with the base row version. */
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
  onOpenWhy: () => void;
  onOpenConfig?: (kind: string, slug: string) => void;
  /** Scroll to and focus a field named by a blocked transition. */
  onGoToField?: (field: string) => void;
  presenceOthers?: Viewer[];
  myEditingField?: string | null;
  onFocusField?: (field: string) => void;
  onBlurField?: (field: string) => void;
  /** Shared ticker so the clocks do not each own a timer. */
  now?: number;
  className?: string;
}

export default function TicketHeader({
  ticket,
  transitions,
  transitionsLoading = false,
  onTransition,
  onPatch,
  onOpenWhy,
  onOpenConfig,
  onGoToField,
  presenceOthers = [],
  myEditingField,
  onFocusField,
  onBlurField,
  now,
  className,
}: TicketHeaderProps): JSX.Element {
  const { t } = useTranslation();
  const [inspecting, setInspecting] = useState<TransitionOption | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  // Close the inspector on Escape or on a click outside it.
  useEffect(() => {
    if (!inspecting) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setInspecting(null);
    };
    const onClick = (event: MouseEvent): void => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) setInspecting(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [inspecting]);

  const sorted = useMemo(() => {
    if (!transitions) return [];
    // Allowed first, then blocked — but blocked stay VISIBLE (see header).
    return [...transitions.transitions].sort((a, b) => Number(b.allowed) - Number(a.allowed));
  }, [transitions]);

  const nearest = useMemo(() => nearestInstance(ticket.slaInstances), [ticket.slaInstances]);

  const source = SOURCE_LABEL[ticket.source] ?? SOURCE_LABEL.web;

  const handleTransitionClick = useCallback(
    (option: TransitionOption) => {
      if (option.allowed) {
        onTransition(option);
        return;
      }
      // Blocked: the click opens the reason, it does not fail silently.
      setInspecting((current) => (current === option ? null : option));
    },
    [onTransition],
  );

  const detectionGapMs = useMemo(() => {
    const occurred = Date.parse(ticket.occurredAt);
    const created = Date.parse(ticket.createdAt);
    if (Number.isNaN(occurred) || Number.isNaN(created)) return 0;
    return Math.max(0, created - occurred);
  }, [ticket.occurredAt, ticket.createdAt]);

  return (
    <header className={clsx('flex flex-col gap-2 bg-bg-primary px-4 pb-2 pt-3', className)}>
      {/* ── Identity row ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <span className="mt-1 shrink-0 rounded-pill bg-bg-tertiary px-2 py-1 font-mono text-[12px] font-medium tracking-[0.04em] text-accent">
          {ticket.number}
        </span>

        <div className="min-w-[16rem] flex-1">
          <InlineField
            field="subject"
            label={t('ticket.subject', 'Objet')}
            value={ticket.subject}
            titleMode
            onSave={(value) => onPatch({ subject: value ?? '' })}
            onFocusField={onFocusField}
            onBlurField={onBlurField}
            contendedBy={
              presenceOthers.find((viewer) => viewer.editingField === 'subject')?.displayName ?? null
            }
          />
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenWhy}
            className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2.5 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover"
            title={t('ticket.whyTooltip', 'Toutes les décisions automatiques sur ce ticket')}
          >
            <HelpCircle size={13} aria-hidden />
            {t('ticket.why', 'Pourquoi ?')}
          </button>
        </div>
      </div>

      {/* ── Facts row ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <StatusPill
          statusSlug={ticket.statusSlug}
          category={ticket.statusCategory}
          label={ticket.status?.label ?? ticket.statusSlug}
        />
        <PriorityBadge
          prioritySlug={ticket.prioritySlug}
          rank={ticket.priority?.rank}
          label={ticket.priority?.label ?? ticket.prioritySlug}
        />

        {ticket.slaInstances && ticket.slaInstances.length > 0 ? (
          <SlaChipRow instances={ticket.slaInstances} now={now} />
        ) : (
          <span className="rounded-pill bg-bg-tertiary px-2 py-1 font-mono text-[11px] text-text-muted">
            {t('sla.none', 'aucun SLA')}
          </span>
        )}

        <span className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2 py-1 text-[11px] text-text-secondary">
          <Inbox size={11} aria-hidden />
          {ticket.queue?.name ?? ticket.queueSlug}
        </span>

        <span className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2 py-1 text-[11px] text-text-secondary">
          <UserRound size={11} aria-hidden />
          {ticket.assignee
            ? ticket.assignee.displayName ?? ticket.assignee.username
            : t('ticket.unassigned', 'non assigné')}
        </span>

        <span className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2 py-1 text-[11px] text-text-secondary">
          <Radio size={11} aria-hidden />
          {t(source.key, source.fallback)}
        </span>

        {ticket.reopenCount > 0 && (
          <span
            className="inline-flex items-center gap-1.5 rounded-pill bg-sla-warn-bg px-2 py-1 text-[11px] text-sla-warn"
            title={t('ticket.reopenedTooltip', 'Ce ticket a déjà été rouvert')}
          >
            <RotateCcw size={11} aria-hidden />
            {t('ticket.reopened', 'rouvert ×{{count}}', { count: ticket.reopenCount })}
          </span>
        )}

        {ticket.watcherCount ? (
          <span className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2 py-1 text-[11px] text-text-secondary">
            <Eye size={11} aria-hidden />
            {ticket.watcherCount}
          </span>
        ) : null}
      </div>

      {/* ── HARD RULE 6: two timestamps, two meanings ────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-text-muted">
        <span
          className="inline-flex items-center gap-1.5"
          title={`${t('ticket.occurredAtTooltip', 'Quand l’incident s’est produit — saisi à la prise en charge, jamais recalculé')} : ${formatAbsolute(ticket.occurredAt)}`}
        >
          <AlarmClock size={11} aria-hidden />
          {t('ticket.occurredAt', 'survenu')} {formatRelative(ticket.occurredAt, t, now)}
        </span>

        <span
          className="inline-flex items-center gap-1.5"
          title={`${t('ticket.createdAtTooltip', 'Quand le ticket a été créé')} : ${formatAbsolute(ticket.createdAt)}`}
        >
          <CalendarClock size={11} aria-hidden />
          {t('ticket.createdAt', 'créé')} {formatRelative(ticket.createdAt, t, now)}
        </span>

        {/* The gap between the two is the detection delay. Naming it is the
            entire reason the two columns are separate. */}
        {detectionGapMs > 60_000 && (
          <span className="text-sla-warn">
            {t('ticket.detectionGap', 'détection : {{delay}}', {
              delay: formatRelative(ticket.occurredAt, () => '', Date.parse(ticket.createdAt))
                ? new Intl.NumberFormat().format(Math.round(detectionGapMs / 60_000))
                : '',
            })}{' '}
            min
          </span>
        )}

        {nearest && (
          <span className="inline-flex items-center gap-1.5">
            {t('sla.nearest', 'échéance la plus proche')}
            <SlaChip instance={nearest} now={now} size="sm" />
          </span>
        )}
      </div>

      {/* ── Presence ─────────────────────────────────────────────────────── */}
      <PresenceBar others={presenceOthers} myEditingField={myEditingField} />

      {/* ── Transition bar ───────────────────────────────────────────────── */}
      <div ref={barRef} className="relative flex flex-wrap items-center gap-1.5 pt-1">
        {transitionsLoading && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-text-muted">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            {t('transition.loading', 'Lecture des transitions possibles…')}
          </span>
        )}

        {!transitionsLoading && sorted.length === 0 && (
          <span className="text-[12px] text-text-muted">
            {t(
              'transition.none',
              'Aucune transition déclarée depuis ce statut par l’automate.',
            )}
          </span>
        )}

        {sorted.map((option) => {
          const label = transitionLabel(option);
          const blockedTitle = option.allowed
            ? label
            : describeBlockedTransition(option, t as never);

          return (
            <button
              key={`${option.transitionSlug ?? 'edge'}-${option.toStatusSlug}`}
              type="button"
              onClick={() => handleTransitionClick(option)}
              title={blockedTitle}
              aria-label={blockedTitle}
              aria-disabled={!option.allowed}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-[12px] font-medium transition-colors',
                option.allowed
                  ? 'bg-accent text-bg-primary hover:bg-accent-hover'
                  : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover',
              )}
            >
              {label}
              {!option.allowed && <ChevronDown size={12} aria-hidden />}
            </button>
          );
        })}

        {/* The reason, in full, anchored to the bar. */}
        {inspecting && transitions && (
          <div className="absolute left-0 top-full z-30 mt-2">
            <TransitionInspector
              option={inspecting}
              machineSlug={transitions.machineSlug}
              currentStatusSlug={transitions.currentStatusSlug}
              currentCategory={transitions.currentCategory}
              onGoToField={(field) => {
                setInspecting(null);
                onGoToField?.(field);
              }}
              onOpenConfig={onOpenConfig}
            />
          </div>
        )}
      </div>
    </header>
  );
}
