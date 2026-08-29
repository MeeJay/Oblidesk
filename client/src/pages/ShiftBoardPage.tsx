/**
 * ShiftBoardPage — the landing screen. "What needs me, now."
 *
 * Four columns, and the fourth is the reason the screen exists.
 *
 *   1. Bientôt en dépassement       saved view `breaching_soon`
 *   2. Assignés à moi               saved view `my_open`
 *   3. En attente du demandeur      saved view `pending_requester`
 *   4. ALERTES DE LA SUITE SANS TICKET
 *
 * ── Why the fourth column ───────────────────────────────────────────────────
 * Obliview, Obliguard, Obliance and Oblimap all raise alerts. An alert that has
 * been raised and NOT turned into a ticket is the one failure mode a service
 * desk cannot see: it is not in a queue, it is not on a dashboard, and it is not
 * assigned to anybody. It is a problem the suite already knows about and that
 * nobody has picked up. Putting it beside the three ordinary columns — with its
 * source app, its severity, how many times it has fired and when it was last
 * seen — is what turns "the monitoring is noisy" into "these six things are
 * unowned right now", and one keystroke turns one into a ticket.
 *
 * ── The fourth column is honest about being unavailable ─────────────────────
 * The read side (`GET /api/alerts`) is not on this server yet — ingest is. So
 * `fetchUnboundAlerts` reports `unavailable` with the endpoint it could not
 * reach, and this column renders THAT rather than an empty list. An empty list
 * here would read as "all clear", which is the most dangerous thing this screen
 * could say while the source is down.
 *
 * ── Columns 1-3 are ordinary saved views ────────────────────────────────────
 * They resolve through `viewSlug`, so a tenant that renamed or re-filtered
 * `breaching_soon` gets its own definition, not a hard-coded copy of it. When a
 * view has been archived we fall back to an equivalent ad-hoc filter and SAY SO,
 * rather than silently rendering something the tenant did not configure.
 *
 * HARD RULE 11 — cards are `bg-bg-secondary` + `shadow-card`. No borders.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlarmClock,
  BellRing,
  CheckCircle2,
  Inbox,
  Loader2,
  PlugZap,
  RefreshCw,
  UserRound,
  Zap,
} from 'lucide-react';
import { OPEN_STATUS_CATEGORIES } from '@oblidesk/shared';
import type { AlertSeverity, SuiteAlert, TicketWithRelations } from '@oblidesk/shared';
import { errorMessage } from '@/api/client';
import { fetchUnboundAlerts, resetCircuitBreakers, type SectionResult } from '@/api/ci.api';
import { ticketsApi, type TicketListParams } from '@/api/tickets.api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { UserAvatar } from '@/components/common/UserAvatar';
import PriorityBadge from '@/components/tickets/PriorityBadge';
import SlaChip, {
  formatAbsolute,
  formatRelative,
  nearestInstance,
} from '@/components/tickets/SlaChip';
import StatusPill from '@/components/tickets/StatusPill';
import { useAuthStore } from '@/store/authStore';
import { useViewStore } from '@/store/viewStore';
import { formatNumber } from '@/utils/format';

/** How many cards a column shows before it says "and N more". */
const COLUMN_LIMIT = 12;

// ═════════════════════════════════════════════════════════════════════════════
// Column definitions
// ═════════════════════════════════════════════════════════════════════════════

interface ColumnSpec {
  id: string;
  slug: string;
  titleKey: string;
  titleFallback: string;
  emptyKey: string;
  emptyFallback: string;
  icon: typeof AlarmClock;
  tone: 'danger' | 'accent' | 'muted';
  /**
   * The query to run when the saved view is gone. It is NOT the definition of
   * the column — the view is — it is the honest degraded mode, and the column
   * says which one it used.
   */
  fallback: (meId: number | null) => TicketListParams;
}

const COLUMNS: readonly ColumnSpec[] = [
  {
    id: 'breaching',
    slug: 'breaching_soon',
    titleKey: 'shiftBoard.breachingSoon',
    titleFallback: 'Bientôt en dépassement',
    emptyKey: 'shiftBoard.breachingEmpty',
    emptyFallback: 'Aucun SLA n’arrive à échéance dans les deux prochaines heures.',
    icon: AlarmClock,
    tone: 'danger',
    fallback: () => ({
      breachingWithinMinutes: 120,
      statusCategories: [...OPEN_STATUS_CATEGORIES],
      sortBy: 'due_at',
      sortDir: 'asc',
    }),
  },
  {
    id: 'mine',
    slug: 'my_open',
    // Not `shiftBoard.myTickets` ("Mes tickets"): that key already exists with a
    // different wording, and the resource would win over this fallback.
    titleKey: 'shiftBoard.assignedToMe',
    titleFallback: 'Assignés à moi',
    emptyKey: 'shiftBoard.mineEmpty',
    emptyFallback: 'Rien ne vous est assigné. Prenez le suivant dans la file non assignée.',
    icon: UserRound,
    tone: 'accent',
    fallback: (meId) => ({
      assigneeIds: meId ? [meId] : [],
      statusCategories: [...OPEN_STATUS_CATEGORIES],
      sortBy: 'due_at',
      sortDir: 'asc',
    }),
  },
  {
    id: 'pending',
    slug: 'pending_requester',
    titleKey: 'shiftBoard.waitingRequester',
    titleFallback: 'En attente du demandeur',
    emptyKey: 'shiftBoard.pendingEmpty',
    emptyFallback: 'Personne n’attend une réponse du demandeur : rien ne dort ici.',
    icon: Inbox,
    tone: 'muted',
    fallback: () => ({
      statusCategories: ['pending_requester'],
      sortBy: 'updated_at',
      sortDir: 'asc',
    }),
  },
];

const TONE_TEXT: Readonly<Record<ColumnSpec['tone'], string>> = {
  danger: 'text-sla-breach',
  accent: 'text-accent',
  muted: 'text-text-secondary',
};

// ═════════════════════════════════════════════════════════════════════════════
// Suite alert presentation
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Source-app dot colours, fixed by the design system (§1) and NOT theme
 * swappable: the dot is how an agent tells an Obliguard alert from an Obliance
 * one without reading, and it has to mean the same thing in every app.
 */
const SOURCE_DOT: Readonly<Record<string, string>> = {
  obliance: '#e03a3a',
  obliview: '#2bc4bd',
  obliguard: '#f5a623',
  oblimap: '#1edd8a',
  obligate: '#2d4ec9',
  oblihub: '#2d4ec9',
};

const SEVERITY_CLASSES: Readonly<Record<AlertSeverity, string>> = {
  info: 'bg-status-new-bg text-status-new',
  warning: 'bg-sla-warn-bg text-sla-warn',
  critical: 'bg-sla-breach-bg text-sla-breach',
  down: 'bg-sla-breach-bg text-sla-breach',
  up: 'bg-sla-ok-bg text-sla-ok',
};

const SEVERITY_LABEL: Readonly<Record<AlertSeverity, { key: string; fallback: string }>> = {
  info: { key: 'alerts.severities.info', fallback: 'Information' },
  warning: { key: 'alerts.severities.warning', fallback: 'Avertissement' },
  critical: { key: 'alerts.severities.critical', fallback: 'Critique' },
  down: { key: 'alerts.severities.down', fallback: 'Hors service' },
  up: { key: 'alerts.severities.up', fallback: 'Rétabli' },
};

/** Severity → the priority the converted ticket opens at. */
const SEVERITY_PRIORITY: Readonly<Record<AlertSeverity, string>> = {
  critical: 'p1',
  down: 'p1',
  warning: 'p3',
  info: 'p4',
  up: 'p4',
};

// ═════════════════════════════════════════════════════════════════════════════
// Page
// ═════════════════════════════════════════════════════════════════════════════

export function ShiftBoardPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const me = useAuthStore((state) => state.user);
  const views = useViewStore((state) => state.views);
  const loadViews = useViewStore((state) => state.loadViews);

  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (views.length === 0) void loadViews();
  }, [views.length, loadViews]);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return t('shiftBoard.greetingMorning', 'Bonjour');
    if (hour < 18) return t('shiftBoard.greetingAfternoon', 'Bon après-midi');
    return t('shiftBoard.greetingEvening', 'Bonsoir');
  }, [t]);

  const refreshAll = useCallback(() => {
    resetCircuitBreakers();
    setNonce((value) => value + 1);
  }, []);

  const openTicket = useCallback((ticketId: number) => navigate(`/tickets/${ticketId}`), [navigate]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      {/* ── Page header (design system §4.3: title · meta, no banner) ────── */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
            {greeting}
            {me?.displayName ? `, ${me.displayName.split(' ')[0]}` : ''}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {t('shiftBoard.subtitle', 'Ce qui a besoin de vous, maintenant.')}
          </p>
        </div>

        <button
          type="button"
          onClick={refreshAll}
          className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <RefreshCw size={13} aria-hidden />
          {t('common.refresh', 'Actualiser')}
        </button>
      </header>

      {/* ── The four columns ─────────────────────────────────────────────── */}
      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto lg:grid-cols-2 2xl:grid-cols-4">
        {COLUMNS.map((column) => (
          <TicketColumn
            key={column.id}
            spec={column}
            meId={me?.id ?? null}
            hasView={views.some((view) => view.slug === column.slug)}
            viewsLoaded={views.length > 0}
            nonce={nonce}
            onOpen={openTicket}
          />
        ))}

        <UnboundAlertsColumn nonce={nonce} onOpen={openTicket} />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Columns 1–3
// ═════════════════════════════════════════════════════════════════════════════

function TicketColumn({
  spec,
  meId,
  hasView,
  viewsLoaded,
  nonce,
  onOpen,
}: {
  spec: ColumnSpec;
  meId: number | null;
  hasView: boolean;
  viewsLoaded: boolean;
  nonce: number;
  onOpen: (ticketId: number) => void;
}): JSX.Element {
  const { t } = useTranslation();

  const [tickets, setTickets] = useState<TicketWithRelations[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // One ticker per column, shared by its chips — same discipline as the queue.
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  useEffect(() => {
    // Wait for the view list before choosing between the view and the fallback,
    // or the first paint would always show the degraded mode.
    if (!viewsLoaded) return undefined;

    let cancelled = false;
    setLoading(true);
    setError(null);

    const params: TicketListParams = hasView
      ? { viewSlug: spec.slug, limit: COLUMN_LIMIT, withTotal: true }
      : { ...spec.fallback(meId), limit: COLUMN_LIMIT, withTotal: true };

    void ticketsApi
      .list(params)
      .then((page) => {
        if (cancelled) return;
        setTickets(page.items);
        setTotal(page.total ?? page.items.length);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [spec, hasView, viewsLoaded, meId, nonce]);

  const Icon = spec.icon;
  const overflow = total !== null ? total - tickets.length : 0;

  return (
    <section className="flex min-h-0 flex-col gap-2 rounded-card bg-bg-secondary p-3 shadow-card">
      <header className="flex shrink-0 items-center gap-2">
        <Icon size={14} className={TONE_TEXT[spec.tone]} aria-hidden />
        <h2 className="flex-1 truncate font-display text-[15px] font-semibold text-text-primary">
          {t(spec.titleKey, spec.titleFallback)}
        </h2>
        {total !== null && (
          <span className="rounded-pill bg-bg-tertiary px-2 py-0.5 font-mono text-[11px] tabular-nums text-text-muted">
            {formatNumber(total)}
          </span>
        )}
      </header>

      {/* The degraded mode is visible, not silent. */}
      {viewsLoaded && !hasView && (
        <p className="shrink-0 rounded-card bg-sla-warn-bg px-2.5 py-1.5 text-[11px] text-sla-warn">
          {t(
            'shiftBoard.viewMissing',
            'La vue « {{slug}} » n’existe plus : cette colonne utilise un filtre équivalent.',
            { slug: spec.slug },
          )}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-8">
            <LoadingSpinner size="sm" />
          </div>
        ) : error ? (
          <p className="rounded-card bg-sla-breach-bg px-2.5 py-2 text-[11px] text-sla-breach">
            {error}
          </p>
        ) : tickets.length === 0 ? (
          // A real sentence. "Rien ici" tells an agent nothing about whether
          // that is good news or a broken filter.
          <p className="flex items-start gap-2 px-1 py-6 text-[12px] leading-relaxed text-text-muted">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-sla-ok" aria-hidden />
            {t(spec.emptyKey, spec.emptyFallback)}
          </p>
        ) : (
          <>
            {tickets.map((ticket) => (
              <TicketCard key={ticket.id} ticket={ticket} now={now} onOpen={onOpen} />
            ))}
            {overflow > 0 && (
              <p className="px-1 pt-1 text-[11px] text-text-muted">
                {t('shiftBoard.andMore', '… et {{count}} de plus dans la file.', {
                  count: overflow,
                })}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function TicketCard({
  ticket,
  now,
  onOpen,
}: {
  ticket: TicketWithRelations;
  now: number;
  onOpen: (ticketId: number) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const sla = nearestInstance(ticket.slaInstances);

  return (
    <button
      type="button"
      onClick={() => onOpen(ticket.id)}
      className="flex w-full flex-col gap-1.5 rounded-card bg-bg-tertiary px-2.5 py-2 text-left transition-colors hover:bg-bg-hover"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 font-mono text-[11px] text-accent">{ticket.number}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">
          {ticket.subject}
        </span>
        {ticket.assignee ? (
          <UserAvatar
            avatar={ticket.assignee.avatar}
            username={ticket.assignee.displayName ?? ticket.assignee.username}
            size={18}
          />
        ) : (
          <span
            title={t('common.unassigned', 'Non assigné')}
            className="h-[18px] w-[18px] shrink-0 rounded-full bg-bg-secondary"
          />
        )}
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
        <span
          className="ml-auto font-mono text-[10px] text-text-muted"
          title={`${t('tickets.occurredAt', 'Survenu le')} ${formatAbsolute(ticket.occurredAt)}`}
        >
          {formatRelative(ticket.occurredAt, t, now)}
        </span>
      </div>
    </button>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Column 4 — the differentiator
// ═════════════════════════════════════════════════════════════════════════════

function UnboundAlertsColumn({
  nonce,
  onOpen,
}: {
  nonce: number;
  onOpen: (ticketId: number) => void;
}): JSX.Element {
  const { t } = useTranslation();

  const [state, setState] = useState<SectionResult<SuiteAlert[]> | null>(null);
  const [converting, setConverting] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(handle);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    // `fetchUnboundAlerts` never rejects: every failure comes back as a status
    // with a sentence attached, which is exactly what this column renders.
    void fetchUnboundAlerts(COLUMN_LIMIT * 2).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  /**
   * One alert → one ticket.
   *
   * `occurredAt` is the alert's FIRST occurrence, not now (HARD RULE 6): an
   * alert that has been firing since 02:14 produces a ticket that is six hours
   * old, and the detection gap on the ticket header is then true rather than
   * flattering.
   */
  const convert = useCallback(
    async (alert: SuiteAlert) => {
      setConverting(alert.id);
      try {
        const ticket = await ticketsApi.create({
          subject: alert.title,
          descriptionMd: alert.message ?? null,
          source: 'alert',
          occurredAt: alert.firstSeenAt,
          prioritySlug: SEVERITY_PRIORITY[alert.severity],
          data: {
            suite_alert_id: alert.id,
            source_app: alert.sourceApp,
            dedupe_key: alert.dedupeKey,
            external_id: alert.externalId,
            occurrence_count: alert.occurrenceCount,
          },
        });

        // Drop it from the column immediately: it now HAS a ticket, which is the
        // one thing that disqualifies it from this list.
        setState((current) =>
          current && current.data
            ? { ...current, data: current.data.filter((row) => row.id !== alert.id) }
            : current,
        );

        toast.success(
          t('shiftBoard.alertConverted', 'Ticket {{number}} créé depuis l’alerte.', {
            number: ticket.number,
          }),
        );
        onOpen(ticket.id);
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setConverting(null);
      }
    },
    [onOpen, t],
  );

  const alerts = state?.data ?? [];

  /**
   * `t` converts the top alert.
   *
   * It is a plain listener rather than a `useKeyboard` binding on purpose:
   * `KEYBOARD_ACTIONS` is a closed vocabulary shared with the remapping UI, and
   * quietly widening it here would put an action in the shortcuts panel that
   * only exists on one screen. The guards are the same ones `useKeyboard`
   * applies — never inside a text field, never with a modifier held.
   */
  useEffect(() => {
    const first = alerts[0];
    if (!first || converting !== null) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 't' || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }

      event.preventDefault();
      void convert(first);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [alerts, converting, convert]);

  return (
    <section className="flex min-h-0 flex-col gap-2 rounded-card bg-bg-secondary p-3 shadow-card">
      <header className="flex shrink-0 items-center gap-2">
        <BellRing size={14} className="text-sla-warn" aria-hidden />
        <h2 className="flex-1 truncate font-display text-[15px] font-semibold text-text-primary">
          {t('shiftBoard.unboundAlerts', 'Alertes de la suite sans ticket')}
        </h2>
        {state?.status === 'ok' && (
          <span className="rounded-pill bg-bg-tertiary px-2 py-0.5 font-mono text-[11px] tabular-nums text-text-muted">
            {formatNumber(alerts.length)}
          </span>
        )}
      </header>

      <p className="shrink-0 px-0.5 text-[11px] leading-relaxed text-text-muted">
        {t(
          'shiftBoard.unboundAlertsHint',
          'Remontées par Obliview, Obliguard, Obliance ou Oblimap, et que personne n’a encore prises en charge.',
        )}
      </p>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {state === null ? (
          <div className="flex justify-center py-8">
            <LoadingSpinner size="sm" />
          </div>
        ) : state.status === 'ok' && alerts.length > 0 ? (
          alerts.map((alert, index) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              now={now}
              /* The first card carries the keystroke, so a shift starts with one
                 hand on the keyboard and no aim required. */
              hotkeyHint={index === 0}
              busy={converting === alert.id}
              onConvert={() => void convert(alert)}
            />
          ))
        ) : state.status === 'ok' || state.status === 'empty' ? (
          <p className="flex items-start gap-2 px-1 py-6 text-[12px] leading-relaxed text-text-muted">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-sla-ok" aria-hidden />
            {t(
              'shiftBoard.unboundAlertsEmpty',
              'Aucune alerte orpheline : tout ce que la suite a remonté est rattaché à un ticket.',
            )}
          </p>
        ) : (
          // Unavailable, forbidden, timed out or circuit-open. Never an empty
          // list, which here would read as "all clear".
          <div className="flex flex-col gap-2 rounded-card bg-bg-tertiary px-2.5 py-3">
            <p className="flex items-start gap-2 text-[12px] leading-relaxed text-sla-warn">
              <PlugZap size={14} className="mt-0.5 shrink-0" aria-hidden />
              {t(
                'shiftBoard.unboundAlertsUnavailable',
                'Impossible de savoir s’il reste des alertes sans ticket : la source est injoignable.',
              )}
            </p>
            {state.reason && (
              <p className="pl-6 text-[11px] text-text-muted">{state.reason}</p>
            )}
            <p className="pl-6 font-mono text-[10px] text-text-muted">
              {t('shiftBoard.lastRead', 'dernière lecture')} {formatAbsolute(state.fetchedAt)}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function AlertCard({
  alert,
  now,
  hotkeyHint,
  busy,
  onConvert,
}: {
  alert: SuiteAlert;
  now: number;
  hotkeyHint: boolean;
  busy: boolean;
  onConvert: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const severity = SEVERITY_LABEL[alert.severity] ?? SEVERITY_LABEL.info;

  return (
    <article className="flex flex-col gap-1.5 rounded-card bg-bg-tertiary px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          title={alert.sourceApp}
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: SOURCE_DOT[alert.sourceApp] ?? 'currentColor' }}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary" title={alert.title}>
          {alert.title}
        </span>
        <span
          className={clsx(
            'shrink-0 rounded-pill px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em]',
            SEVERITY_CLASSES[alert.severity] ?? SEVERITY_CLASSES.info,
          )}
        >
          {t(severity.key, severity.fallback)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] text-text-muted">
        <span>{alert.sourceApp}</span>
        <span title={t('alerts.dedupeKey', 'Clé de déduplication')}>
          ×{formatNumber(alert.occurrenceCount)}
        </span>
        <span title={`${t('alerts.lastSeen', 'Dernière occurrence')} ${formatAbsolute(alert.lastSeenAt)}`}>
          {formatRelative(alert.lastSeenAt, t, now)}
        </span>
        {alert.suppressedReason && (
          <span className="text-sla-warn" title={t('alerts.suppressed', 'Supprimée : {{reason}}', {
            reason: alert.suppressedReason,
          })}>
            {alert.suppressedReason}
          </span>
        )}
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={onConvert}
        className="inline-flex items-center justify-center gap-1.5 rounded-pill bg-accent px-2.5 py-1 text-[11px] font-semibold text-bg-primary transition-colors hover:bg-accent-hover disabled:opacity-60"
      >
        {busy ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <Zap size={11} aria-hidden />}
        {t('shiftBoard.convertToTicket', 'Créer un ticket')}
        {hotkeyHint && (
          <kbd className="ml-1 rounded bg-bg-primary/25 px-1 font-mono text-[9px] leading-none">
            t
          </kbd>
        )}
      </button>
    </article>
  );
}

export default ShiftBoardPage;
