/**
 * TicketDetailPage — one ticket, and everything that is true about it.
 *
 * ── Why the body is a separate export ───────────────────────────────────────
 * `TicketConversation` is the whole ticket UI minus the page chrome, and
 * `TicketsPage` renders it inside its centre pane keyed on the selected id.
 * That is what makes moving between tickets in the three-pane layout cost zero
 * queue refetch: the route never unmounts, only this subtree does. The default
 * export is the same thing wearing a standalone route (`/tickets/:id`) for deep
 * links, sharing and the "open in a new tab" case.
 *
 * ── HARD RULE 12, on screen ─────────────────────────────────────────────────
 * Every inline field autosaves on its own, one PATCH per field, and NOT ONE OF
 * THEM checks required-ness. A half-filled ticket is legal all day. Obligation
 * appears exactly once — when a transition is attempted — and then it appears
 * as a named list of what is missing, with a link to each field.
 *
 * ── HARD RULE 7, on screen ──────────────────────────────────────────────────
 * A 409 is never swallowed and never replayed. The banner names the fields that
 * moved, and offers two explicit choices: take the server's row, or re-apply
 * this one edit on top of the new version. There is no third path where the
 * screen quietly keeps a value the server refused, and no path at all where
 * this client overwrites somebody's work without a human saying so.
 *
 * ── The transition bar is the server's answer ───────────────────────────────
 * Blocked moves stay visible with their reasons (TransitionInspector). A 422
 * from the real attempt lands in the same inspector, so the tooltip and the
 * refusal always agree — they are the same evaluator, run twice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  ArrowLeft,
  History,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { SOCKET_EVENTS } from '@oblidesk/shared';
import type {
  StatusCategory,
  TicketJournalEntry,
  TicketWithRelations,
  TransitionTicketRequest,
  UpdateTicketRequest,
} from '@oblidesk/shared';
import { ApiError, errorMessage } from '@/api/client';
import { conflictOf, evaluationOf, ticketsApi } from '@/api/tickets.api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { EmptyState } from '@/components/common/EmptyState';
import { Modal } from '@/components/common/Modal';
import Composer from '@/components/tickets/Composer';
import ContextRail from '@/components/tickets/ContextRail';
import InlineField from '@/components/tickets/InlineField';
import TicketHeader from '@/components/tickets/TicketHeader';
import TicketJournal from '@/components/tickets/TicketJournal';
import TransitionInspector, {
  transitionLabel,
  type AvailableTransitions,
  type TransitionOption,
} from '@/components/tickets/TransitionInspector';
import WhyDrawer from '@/components/tickets/WhyDrawer';
import {
  loadTicketFieldOptions,
  type TicketFieldOptions,
} from '@/components/tickets/BulkActionBar';
import { useKeyboard } from '@/hooks/useKeyboard';
import { usePresence } from '@/hooks/usePresence';
import { onSocket } from '@/socket';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useTicketStore } from '@/store/ticketStore';
import { useUiStore } from '@/store/uiStore';

// ═════════════════════════════════════════════════════════════════════════════
// Small helpers
// ═════════════════════════════════════════════════════════════════════════════

const EMPTY_OPTIONS: TicketFieldOptions = { queues: [], priorities: [], agents: [] };

/** ISO → the `YYYY-MM-DDTHH:mm` a `datetime-local` input expects, in LOCAL time. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** …and back. An unparseable string is dropped rather than sent as `Invalid Date`. */
function fromLocalInput(value: string | null): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * `GET /tickets/:id/transitions` returns the machine identity alongside the
 * decisions (`AvailableTransitionsResult` server-side). The client's API module
 * declares the narrower `TicketTransitions`; the inspector needs the machine
 * slug and the current status to explain a refusal, so we read the body for
 * what the route actually sends.
 */
async function fetchTransitions(ticketId: number): Promise<AvailableTransitions> {
  const raw = await ticketsApi.transitions(ticketId);
  return raw as unknown as AvailableTransitions;
}

/**
 * `POST /tickets/:id/transition` answers `{ ticket, transition }`. The API
 * module types it as the ticket alone, so unwrap defensively rather than
 * assuming either shape.
 */
function ticketOfTransitionResult(result: unknown): TicketWithRelations {
  const wrapped = (result as { ticket?: TicketWithRelations }).ticket;
  return wrapped ?? (result as TicketWithRelations);
}

function firstAllowedTo(
  transitions: AvailableTransitions | null,
  category: StatusCategory,
): TransitionOption | null {
  if (!transitions) return null;
  return transitions.transitions.find((option) => option.allowed && option.toCategory === category) ?? null;
}

// ═════════════════════════════════════════════════════════════════════════════
// The conversation — everything but the page chrome
// ═════════════════════════════════════════════════════════════════════════════

export interface TicketConversationProps {
  ticketId: number;
  /** Render the context rail here. `TicketsPage` owns its own and passes false. */
  withRail?: boolean;
  onOpenTicket?: (ticketId: number) => void;
  /** A back affordance; omitted inside the three-pane layout. */
  onBack?: () => void;
  /**
   * Every version of the ticket this component holds, handed upward.
   *
   * `TicketsPage` renders the context rail as its own pane and needs the same
   * row — without this it would either issue a SECOND `GET /tickets/:id` or read
   * the queue store, which does not contain a deep-linked ticket that the
   * current filter never matched.
   */
  onTicketLoaded?: (ticket: TicketWithRelations) => void;
  className?: string;
}

export function TicketConversation({
  ticketId,
  withRail = true,
  onOpenTicket,
  onBack,
  onTicketLoaded,
  className,
}: TicketConversationProps): JSX.Element {
  const { t } = useTranslation();

  const me = useAuthStore((state) => state.user);
  const tenantId = useTenantStore((state) => state.currentTenantId);
  const upsert = useTicketStore((state) => state.upsert);

  const [ticket, setTicket] = useState<TicketWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [transitions, setTransitions] = useState<AvailableTransitions | null>(null);
  const [transitionsLoading, setTransitionsLoading] = useState(false);

  /** A newer server row we have NOT adopted, because the agent is mid-edit. */
  const [remote, setRemote] = useState<TicketWithRelations | null>(null);
  /** A 409: the server row plus the fields that actually disagree. */
  const [conflict, setConflict] = useState<{
    current: TicketWithRelations;
    conflictingFields: string[];
    /** The edit that lost, kept so "conserver ma valeur" can re-apply it. */
    attempted: Record<string, unknown>;
  } | null>(null);

  const [injected, setInjected] = useState<TicketJournalEntry | null>(null);
  const [quoted, setQuoted] = useState<{ text: string; token: number } | null>(null);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [options, setOptions] = useState<TicketFieldOptions>(EMPTY_OPTIONS);

  const [whyOpen, setWhyOpen] = useState(false);
  const [whyDecisionId, setWhyDecisionId] = useState<number | null>(null);

  /** The transition awaiting prompted fields / a confirmation. */
  const [pendingTransition, setPendingTransition] = useState<TransitionOption | null>(null);
  const [promptValues, setPromptValues] = useState<Record<string, string>>({});
  const [transitionComment, setTransitionComment] = useState('');
  const [transitionBusy, setTransitionBusy] = useState(false);
  /** A 422 evaluation from the real attempt — shown in the same inspector. */
  const [refusal, setRefusal] = useState<TransitionOption | null>(null);

  const [myEditingField, setMyEditingField] = useState<string | null>(null);
  const presence = usePresence(ticketId);

  const fieldsPanelRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);

  // ── Load ─────────────────────────────────────────────────────────────────
  const reload = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setLoadError(null);
      try {
        const [fresh, moves] = await Promise.all([
          ticketsApi.get(ticketId),
          fetchTransitions(ticketId).catch(() => null),
        ]);
        setTicket(fresh);
        setTransitions(moves);
        setRemote(null);
        setConflict(null);
        // Refresh the queue row for this ticket WITHOUT injecting a ticket the
        // current filter never matched: `upsert` prepends unknown ids, and a
        // deep-linked ticket appearing at the top of somebody's saved view is a
        // row that does not belong to it.
        if (useTicketStore.getState().byId[fresh.id]) upsert(fresh);
      } catch (err) {
        setLoadError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [ticketId, upsert],
  );

  useEffect(() => {
    setTicket(null);
    setTransitions(null);
    setInjected(null);
    setQuoted(null);
    setRefusal(null);
    void reload();
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    void loadTicketFieldOptions().then((loaded) => {
      if (!cancelled) setOptions(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  // One place, so every path that changes the row — load, autosave, transition,
  // socket — feeds the parent without each remembering to.
  useEffect(() => {
    if (ticket) onTicketLoaded?.(ticket);
  }, [ticket, onTicketLoaded]);

  const refreshTransitions = useCallback(async () => {
    setTransitionsLoading(true);
    try {
      setTransitions(await fetchTransitions(ticketId));
    } catch {
      // A bar we could not read is better empty than wrong: TicketHeader says
      // "aucune transition déclarée" rather than inventing buttons.
      setTransitions(null);
    } finally {
      setTransitionsLoading(false);
    }
  }, [ticketId]);

  // ── Live updates ─────────────────────────────────────────────────────────
  // The current row is read through a ref rather than inside a state updater:
  // an updater must be pure, and React may run it twice — which would fire the
  // "held back" branch twice for one frame.
  const ticketRef = useRef<TicketWithRelations | null>(null);
  ticketRef.current = ticket;

  useEffect(() => {
    const off = onSocket(SOCKET_EVENTS.ticketUpdated, (event) => {
      const incoming = event.ticket;
      if (!incoming || incoming.id !== ticketId) return;

      const current = ticketRef.current;
      if (current && incoming.rowVersion <= current.rowVersion) return;

      // Adopting while somebody is typing would yank the value out from under
      // their caret. Hold it, and let the banner offer the swap explicitly.
      if (current && myEditingField !== null) {
        setRemote(incoming);
        return;
      }
      setTicket(incoming);
    });
    return off;
  }, [ticketId, myEditingField]);

  // ── Autosave: one field, one PATCH, never validated for completeness ─────
  const savePatch = useCallback(
    async (patch: Record<string, unknown>, override?: number) => {
      const base = ticket;
      if (!base) return;

      try {
        // The patch is a bag of ticket field paths — `subject`, `assigneeId`,
        // `data.site_code`. Its shape is validated by the route's zod schema,
        // which is the authority; asserting it here would only duplicate that
        // rule in a second, drift-prone place.
        const saved = await ticketsApi.update(base.id, {
          baseRowVersion: override ?? base.rowVersion,
          ...patch,
        } as UpdateTicketRequest);
        setTicket(saved);
        setConflict(null);
        if (useTicketStore.getState().byId[saved.id]) upsert(saved);
        // A field the state machine guards on can flip a move from blocked to
        // allowed; the bar has to follow or it lies until the next reload.
        void refreshTransitions();
      } catch (err) {
        if (err instanceof ApiError && err.isConflict) {
          const detail = conflictOf(err);
          if (detail) {
            setConflict({
              current: detail.current,
              conflictingFields: detail.conflictingFields,
              attempted: patch,
            });
            // The screen shows the SERVER's row while the human decides. It
            // never keeps showing a value the server refused.
            setTicket(detail.current);
          }
        }
        // Rethrow so InlineField keeps the agent's text and shows the message.
        throw err;
      }
    },
    [ticket, upsert, refreshTransitions],
  );

  /** Re-apply the one edit that lost, on top of the version that beat it. */
  const reapplyOverConflict = useCallback(async () => {
    if (!conflict) return;
    const { attempted, current } = conflict;
    setConflict(null);
    try {
      await savePatch(attempted, current.rowVersion);
      toast.success(t('tickets.conflict.reapplied', 'Votre modification a été réappliquée.'));
    } catch (err) {
      toast.error(errorMessage(err, t('errors.generic', 'Une erreur est survenue.')));
    }
  }, [conflict, savePatch, t]);

  // ── Transitions ──────────────────────────────────────────────────────────
  const runTransition = useCallback(
    async (option: TransitionOption, extra: Partial<TransitionTicketRequest> = {}) => {
      const base = ticket;
      if (!base) return;

      setTransitionBusy(true);
      setRefusal(null);
      try {
        const result = await ticketsApi.transition(base.id, {
          baseRowVersion: base.rowVersion,
          toStatusSlug: option.toStatusSlug,
          ...extra,
        });
        const next = ticketOfTransitionResult(result);
        setTicket(next);
        if (useTicketStore.getState().byId[next.id]) upsert(next);
        setPendingTransition(null);
        setPromptValues({});
        setTransitionComment('');
        await refreshTransitions();
        toast.success(t('tickets.transition.done', 'Statut mis à jour.'));
      } catch (err) {
        if (err instanceof ApiError && err.isConflict) {
          const detail = conflictOf(err);
          if (detail) {
            setTicket(detail.current);
            setConflict({
              current: detail.current,
              conflictingFields: detail.conflictingFields,
              attempted: {},
            });
            setPendingTransition(null);
            return;
          }
        }

        // A refused transition is not an error message — it is a list of what is
        // missing, rendered by the same component the greyed button uses.
        const evaluation = evaluationOf(err);
        if (evaluation) {
          setRefusal({ ...option, ...evaluation } as TransitionOption);
          setPendingTransition(null);
          await refreshTransitions();
          return;
        }

        toast.error(errorMessage(err, t('errors.generic', 'Une erreur est survenue.')));
      } finally {
        setTransitionBusy(false);
      }
    },
    [ticket, upsert, refreshTransitions, t],
  );

  const startTransition = useCallback(
    (option: TransitionOption) => {
      setRefusal(null);
      if (option.promptFor.length > 0 || option.confirm) {
        setPromptValues({});
        setTransitionComment('');
        setPendingTransition(option);
        return;
      }
      void runTransition(option);
    },
    [runTransition],
  );

  /** Composer's resolution mode: notes in hand, fire the move that resolves. */
  const handleResolve = useCallback(
    async ({ resolutionMd, resolutionCode }: { resolutionMd: string; resolutionCode: string | null }) => {
      const option = firstAllowedTo(transitions, 'resolved');
      if (!option) {
        throw new Error(
          t(
            'tickets.transition.noResolved',
            'Aucune transition vers un statut « résolu » n’est autorisée depuis ce statut.',
          ),
        );
      }
      await runTransition(option, { resolutionMd, resolutionCode });
    },
    [transitions, runTransition, t],
  );

  // ── Presence plumbing ────────────────────────────────────────────────────
  const handleFocusField = useCallback(
    (field: string) => {
      setMyEditingField(field);
      presence.notifyTyping(field);
    },
    [presence],
  );

  const handleBlurField = useCallback(() => {
    setMyEditingField(null);
    presence.notifyStoppedTyping();
  }, [presence]);

  const contendedBy = useCallback(
    (field: string) => presence.isFieldLocked(field)?.displayName ?? null,
    [presence],
  );

  // ── Keyboard: only the ticket-scoped actions ─────────────────────────────
  // Navigation and selection belong to the queue; supplying them here too would
  // fire both handlers on one keypress.
  const focusComposer = useCallback((mode: 'public' | 'internal') => {
    const root = composerRef.current;
    if (!root) return;
    // The mode buttons are the composer's `aria-pressed` controls, in the order
    // MODES declares them (Composer.tsx): public, internal, resolution.
    const buttons = root.querySelectorAll<HTMLButtonElement>('button[aria-pressed]');
    const target = buttons[mode === 'public' ? 0 : 1];
    target?.click();
    root.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, []);

  const goToField = useCallback((field: string) => {
    setFieldsOpen(true);
    // The panel has to exist before it can be focused.
    window.setTimeout(() => {
      const root = fieldsPanelRef.current;
      const control = root?.querySelector<HTMLElement>(`[data-field="${field}"] select, [data-field="${field}"] input, [data-field="${field}"] textarea`);
      control?.focus();
      control?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 0);
  }, []);

  useKeyboard({
    reply: () => focusComposer('public'),
    note: () => focusComposer('internal'),
    edit: () => setFieldsOpen((open) => !open),
    assign: () => goToField('assigneeId'),
    assignToMe: () => {
      if (!me) return;
      void savePatch({ assigneeId: me.id }).catch((err) =>
        toast.error(errorMessage(err, t('errors.generic', 'Une erreur est survenue.'))),
      );
    },
    snooze: () => {
      const option = firstAllowedTo(transitions, 'scheduled');
      if (!option) {
        toast(
          t(
            'tickets.transition.noScheduled',
            'Aucun statut « planifié » n’est atteignable depuis ici : la mise en veille n’est pas déclarée par cet automate.',
          ),
        );
        return;
      }
      startTransition(option);
    },
    resolve: () => {
      const option = firstAllowedTo(transitions, 'resolved');
      if (!option) {
        toast(
          t(
            'tickets.transition.noResolved',
            'Aucune transition vers un statut « résolu » n’est autorisée depuis ce statut.',
          ),
        );
        return;
      }
      startTransition(option);
    },
    showHelp: () => useUiStore.getState().setKeyboardHelpOpen(true),
  });

  // ── Field panel options ──────────────────────────────────────────────────
  const assigneeOptions = useMemo(
    () => options.agents.map((agent) => ({ value: agent.value, label: agent.label })),
    [options.agents],
  );

  const levelOptions = useMemo(
    () => [
      { value: 'high', label: t('tickets.levels.high', 'Élevé') },
      { value: 'medium', label: t('tickets.levels.medium', 'Moyen') },
      { value: 'low', label: t('tickets.levels.low', 'Faible') },
    ],
    [t],
  );

  /** Field slugs a blocked transition named — marked, never enforced (RULE 12). */
  const requiredForTransition = useMemo(() => {
    const out = new Map<string, string>();
    for (const option of transitions?.transitions ?? []) {
      if (option.allowed) continue;
      for (const field of option.missingRequiredFields) {
        if (!out.has(field)) out.set(field, transitionLabel(option));
      }
    }
    return out;
  }, [transitions]);

  // ═══════════════════════════════════════════════════════════════════════════

  if (loading && !ticket) {
    return (
      <div className={clsx('flex h-full items-center justify-center', className)}>
        <LoadingSpinner label={t('common.loading', 'Chargement…')} />
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className={clsx('flex h-full items-center justify-center p-6', className)}>
        <EmptyState
          icon={<ShieldAlert size={22} className="text-sla-breach" />}
          title={t('tickets.notFound', 'Ce ticket est introuvable')}
          description={
            loadError ??
            t(
              'tickets.notFoundHint',
              'Il a peut-être été supprimé, fusionné, ou appartient à un autre tenant.',
            )
          }
          action={
            <button
              type="button"
              onClick={() => void reload()}
              className="rounded-pill bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg-primary hover:bg-accent-hover"
            >
              {t('common.retry', 'Réessayer')}
            </button>
          }
        />
      </div>
    );
  }

  const body = (
    <div className={clsx('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      {/* ── Back, only on the standalone route ───────────────────────────── */}
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mx-4 mt-3 inline-flex w-fit items-center gap-1.5 rounded-pill bg-bg-tertiary px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <ArrowLeft size={12} aria-hidden />
          {t('tickets.backToQueue', 'Retour à la file')}
        </button>
      )}

      <TicketHeader
        ticket={ticket}
        transitions={transitions}
        transitionsLoading={transitionsLoading}
        onTransition={startTransition}
        onPatch={savePatch}
        onOpenWhy={() => {
          setWhyDecisionId(null);
          setWhyOpen(true);
        }}
        onGoToField={goToField}
        presenceOthers={presence.viewers}
        myEditingField={myEditingField}
        onFocusField={handleFocusField}
        onBlurField={handleBlurField}
      />

      {/* ── "Ce ticket a changé" ─────────────────────────────────────────── */}
      {conflict && (
        <ConflictBanner
          fields={conflict.conflictingFields}
          canReapply={Object.keys(conflict.attempted).length > 0}
          onReload={() => void reload(true)}
          onReapply={() => void reapplyOverConflict()}
          onDismiss={() => setConflict(null)}
        />
      )}

      {/* A newer row we deliberately did not adopt because somebody is typing. */}
      {remote && !conflict && (
        <div className="mx-4 mt-2 flex flex-wrap items-center gap-2 rounded-card bg-sla-warn-bg px-3 py-2 text-[12px] text-sla-warn shadow-card">
          <RefreshCw size={13} aria-hidden />
          <span>
            {t(
              'tickets.remoteUpdate',
              'Une version plus récente est arrivée pendant votre saisie. Elle n’a pas été appliquée.',
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              setTicket(remote);
              setRemote(null);
            }}
            className="rounded-pill bg-accent px-2.5 py-1 text-[11px] font-semibold text-bg-primary hover:bg-accent-hover"
          >
            {t('tickets.conflict.takeTheirs', 'Garder la version du serveur')}
          </button>
          <button
            type="button"
            onClick={() => setRemote(null)}
            aria-label={t('common.close', 'Fermer')}
            className="ml-auto rounded-full p-1 hover:bg-bg-hover"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      )}

      {/* ── A refusal from the real attempt ──────────────────────────────── */}
      {refusal && transitions && (
        <div className="mx-4 mt-2">
          <TransitionInspector
            option={refusal}
            machineSlug={transitions.machineSlug}
            currentStatusSlug={transitions.currentStatusSlug}
            currentCategory={transitions.currentCategory}
            onGoToField={(field) => {
              setRefusal(null);
              goToField(field);
            }}
          />
        </div>
      )}

      {/* ── The editable fields ──────────────────────────────────────────── */}
      <div className="px-4 pt-2">
        <button
          type="button"
          onClick={() => setFieldsOpen((open) => !open)}
          aria-expanded={fieldsOpen}
          className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <SlidersHorizontal size={12} aria-hidden />
          {fieldsOpen
            ? t('tickets.fieldsHide', 'Masquer les champs')
            : t('tickets.fieldsShow', 'Modifier les champs')}
        </button>
      </div>

      {fieldsOpen && (
        <div
          ref={fieldsPanelRef}
          className="mx-4 mt-2 grid gap-3 rounded-card bg-bg-secondary p-3 shadow-card sm:grid-cols-2 lg:grid-cols-3"
        >
          <div data-field="prioritySlug">
            <InlineField
              field="prioritySlug"
              label={t('tickets.priority', 'Priorité')}
              type="select"
              options={options.priorities.map((option) => ({ value: option.value, label: option.label }))}
              value={ticket.prioritySlug}
              contendedBy={contendedBy('prioritySlug')}
              requiredForTransition={requiredForTransition.get('priority_slug') ?? null}
              onSave={(value) => savePatch({ prioritySlug: value ?? undefined })}
              onFocusField={handleFocusField}
              onBlurField={handleBlurField}
            />
          </div>

          <div data-field="queueSlug">
            <InlineField
              field="queueSlug"
              label={t('tickets.queue', 'File')}
              type="select"
              options={options.queues.map((option) => ({ value: option.value, label: option.label }))}
              value={ticket.queueSlug}
              contendedBy={contendedBy('queueSlug')}
              requiredForTransition={requiredForTransition.get('queue_slug') ?? null}
              onSave={(value) => savePatch({ queueSlug: value ?? undefined })}
              onFocusField={handleFocusField}
              onBlurField={handleBlurField}
            />
          </div>

          <div data-field="assigneeId">
            <InlineField
              field="assigneeId"
              label={t('tickets.assignee', 'Assigné à')}
              type="select"
              placeholder={t('common.unassigned', 'Non assigné')}
              options={assigneeOptions}
              value={ticket.assigneeId ?? ''}
              contendedBy={contendedBy('assigneeId')}
              requiredForTransition={requiredForTransition.get('assignee_id') ?? null}
              onSave={(value) => savePatch({ assigneeId: value === null ? null : Number(value) })}
              onFocusField={handleFocusField}
              onBlurField={handleBlurField}
            />
          </div>

          <div data-field="impact">
            <InlineField
              field="impact"
              label={t('tickets.impact', 'Impact')}
              type="select"
              options={levelOptions}
              value={ticket.impact}
              contendedBy={contendedBy('impact')}
              onSave={(value) => savePatch({ impact: value ?? undefined })}
              onFocusField={handleFocusField}
              onBlurField={handleBlurField}
            />
          </div>

          <div data-field="urgency">
            <InlineField
              field="urgency"
              label={t('tickets.urgency', 'Urgence')}
              type="select"
              options={levelOptions}
              value={ticket.urgency}
              contendedBy={contendedBy('urgency')}
              onSave={(value) => savePatch({ urgency: value ?? undefined })}
              onFocusField={handleFocusField}
              onBlurField={handleBlurField}
            />
          </div>

          <div data-field="occurredAt">
            <InlineField
              field="occurredAt"
              label={t('tickets.occurredAt', 'Survenu le')}
              helpText={t(
                'tickets.occurredAtHelp',
                'Quand l’incident s’est réellement produit (distinct de la date de création).',
              )}
              type="datetime"
              value={toLocalInput(ticket.occurredAt)}
              contendedBy={contendedBy('occurredAt')}
              onSave={(value) => savePatch({ occurredAt: fromLocalInput(value) ?? undefined })}
              onFocusField={handleFocusField}
              onBlurField={handleBlurField}
            />
          </div>

          <div data-field="descriptionMd" className="sm:col-span-2 lg:col-span-3">
            <InlineField
              field="descriptionMd"
              label={t('tickets.description', 'Description')}
              type="textarea"
              rows={5}
              value={ticket.descriptionMd ?? ''}
              placeholder={t(
                'tickets.descriptionPlaceholder',
                'Ce qui s’est passé, ce qui était attendu, ce qui a déjà été tenté…',
              )}
              contendedBy={contendedBy('descriptionMd')}
              requiredForTransition={requiredForTransition.get('description_md') ?? null}
              onSave={(value) => savePatch({ descriptionMd: value })}
              onFocusField={handleFocusField}
              onBlurField={handleBlurField}
            />
          </div>
        </div>
      )}

      {/* ── The timeline ─────────────────────────────────────────────────── */}
      <TicketJournal
        ticketId={ticket.id}
        injected={injected}
        onQuote={(entry) =>
          setQuoted({ text: entry.bodyMd ?? '', token: Date.now() })
        }
        onOpenWhy={(decisionLogId) => {
          setWhyDecisionId(decisionLogId);
          setWhyOpen(true);
        }}
        className="min-h-0 flex-1"
      />

      {/* ── The composer ─────────────────────────────────────────────────── */}
      <div ref={composerRef} className="shrink-0 px-4 pb-3">
        <Composer
          ticket={ticket}
          tenantId={tenantId}
          me={me}
          onPosted={(entry) => setInjected(entry)}
          onResolve={handleResolve}
          onApplyMacro={(patch) => savePatch(patch)}
          onTyping={(typing) => {
            if (typing) presence.notifyTyping('composer');
            else presence.notifyStoppedTyping();
          }}
          quoted={quoted}
        />
      </div>

      {/* ── Prompted fields / confirmation for a transition ──────────────── */}
      <Modal
        open={pendingTransition !== null}
        onClose={() => setPendingTransition(null)}
        size="md"
        title={
          pendingTransition
            ? t('tickets.transition.title', 'Changer le statut') + ' : ' + transitionLabel(pendingTransition)
            : ''
        }
        subtitle={t(
          'tickets.transition.promptHint',
          'Ces valeurs sont demandées par la transition elle-même.',
        )}
        footer={
          <div className="flex w-full justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingTransition(null)}
              className="rounded-pill bg-bg-tertiary px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover"
            >
              {t('common.cancel', 'Annuler')}
            </button>
            <button
              type="button"
              disabled={transitionBusy}
              onClick={() => {
                if (!pendingTransition) return;
                void runTransition(pendingTransition, {
                  fields: Object.keys(promptValues).length > 0 ? promptValues : undefined,
                  comment: transitionComment.trim()
                    ? { bodyMd: transitionComment.trim(), visibility: 'internal' }
                    : null,
                });
              }}
              className="rounded-pill bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg-primary hover:bg-accent-hover disabled:opacity-50"
            >
              {t('tickets.transition.confirm', 'Changer le statut')}
            </button>
          </div>
        }
      >
        {pendingTransition && (
          <div className="flex flex-col gap-3">
            {pendingTransition.promptFor.map((field) => (
              <label key={field} className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted">
                  {field}
                </span>
                <input
                  type="text"
                  value={promptValues[field] ?? ''}
                  onChange={(event) =>
                    setPromptValues((current) => ({ ...current, [field]: event.target.value }))
                  }
                  className="rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:ring-1 focus:ring-accent"
                />
              </label>
            ))}

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted">
                {t('tickets.transition.comment', 'Commentaire')}
              </span>
              <textarea
                rows={3}
                value={transitionComment}
                onChange={(event) => setTransitionComment(event.target.value)}
                placeholder={t(
                  'tickets.transition.commentPlaceholder',
                  'Optionnel : sera ajouté au journal.',
                )}
                className="resize-y rounded-card bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:ring-1 focus:ring-accent"
              />
            </label>
          </div>
        )}
      </Modal>

      <WhyDrawer
        ticketId={ticket.id}
        ticketNumber={ticket.number}
        open={whyOpen}
        onClose={() => setWhyOpen(false)}
        focusDecisionId={whyDecisionId}
      />
    </div>
  );

  if (!withRail) return body;

  return (
    <div className="flex min-h-0 flex-1">
      {body}
      {/* The width lives on the wrapper: ContextRail is `w-full` inside its own
          column, and stacking a second width class on it would depend on
          stylesheet order rather than on anything we control. */}
      <div className="w-[320px] shrink-0 overflow-hidden bg-bg-primary">
        <ContextRail ticket={ticket} onOpenTicket={onOpenTicket} className="h-full" />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The conflict banner
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The honest 409.
 *
 * It names the fields that moved, and offers two explicit choices. There is no
 * "OK" that quietly discards the other agent's work, and no automatic retry —
 * a retry is a decision, and this is the screen where somebody makes it.
 */
function ConflictBanner({
  fields,
  canReapply,
  onReload,
  onReapply,
  onDismiss,
}: {
  fields: string[];
  canReapply: boolean;
  onReload: () => void;
  onReapply: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      role="alert"
      className="mx-4 mt-2 flex flex-wrap items-center gap-2 rounded-card bg-sla-breach-bg px-3 py-2 text-[12px] text-sla-breach shadow-card"
    >
      <History size={13} aria-hidden />
      <span className="font-medium">
        {t('tickets.conflict.title', 'Ce ticket a changé pendant votre modification')}
      </span>

      {fields.length > 0 && (
        <span className="font-mono text-[11px] opacity-90">{fields.join(', ')}</span>
      )}

      <span className="text-text-secondary">
        {t(
          'tickets.conflict.bodyShort',
          'Votre saisie n’a pas été appliquée. Rien n’a été écrasé.',
        )}
      </span>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onReload}
          className="rounded-pill bg-bg-secondary px-2.5 py-1 text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        >
          {t('tickets.conflict.takeTheirs', 'Garder la version du serveur')}
        </button>
        {canReapply && (
          <button
            type="button"
            onClick={onReapply}
            className="rounded-pill bg-accent px-2.5 py-1 text-[11px] font-semibold text-bg-primary hover:bg-accent-hover"
          >
            {t('tickets.conflict.keepMine', 'Réappliquer ma modification')}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('common.close', 'Fermer')}
          className="rounded-full p-1 hover:bg-bg-hover"
        >
          <X size={12} aria-hidden />
        </button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The standalone route
// ═════════════════════════════════════════════════════════════════════════════

export function TicketDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();

  const railOpen = useUiStore((state) => state.contextRailOpen);
  const toggleRail = useUiStore((state) => state.toggleContextRail);

  const ticketId = Number(params.id);

  if (!Number.isFinite(ticketId) || ticketId <= 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<ShieldAlert size={22} className="text-sla-breach" />}
          title={t('tickets.badId', 'Cette adresse ne désigne pas un ticket')}
          description={t(
            'tickets.badIdHint',
            'Un ticket s’ouvre par son identifiant numérique. Utilisez la recherche ou la palette de commandes pour le retrouver.',
          )}
          action={
            <button
              type="button"
              onClick={() => navigate('/tickets')}
              className="rounded-pill bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg-primary hover:bg-accent-hover"
            >
              {t('tickets.backToQueue', 'Retour à la file')}
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-end px-4 pt-2">
        <RailToggle open={railOpen} onToggle={toggleRail} />
      </div>

      <TicketConversation
        key={ticketId}
        ticketId={ticketId}
        withRail={railOpen}
        onBack={() => navigate('/tickets')}
        onOpenTicket={(id) => navigate(`/tickets/${id}`)}
      />
    </div>
  );
}

/** Shared by both layouts so the rail control looks the same everywhere. */
export function RailToggle({
  open,
  onToggle,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  className?: string;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      title={open ? t('rail.hide', 'Masquer le contexte') : t('rail.show', 'Afficher le contexte')}
      className={clsx(
        'rounded-pill bg-bg-tertiary p-1.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary',
        className,
      )}
    >
      {open ? <PanelRightClose size={13} aria-hidden /> : <PanelRightOpen size={13} aria-hidden />}
    </button>
  );
}

export default TicketDetailPage;
