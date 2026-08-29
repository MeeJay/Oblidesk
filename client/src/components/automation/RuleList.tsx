/**
 * RuleList.tsx — ONE ordered list, because the order is the semantics.
 *
 * ── Why a single list and not a table of independent rows ───────────────────
 * "What will happen to this ticket, and in what order?" has one answer, and
 * this is it. Rules run top to bottom; `stopProcessing` on a rule ends the pass;
 * a rule that moves a ticket into a queue changes what the rules below it see.
 * So position is not a display preference, it is the program. That is why the
 * position number is printed next to every row and why reordering asks for
 * confirmation instead of silently saving on drop: dropping a row one line
 * higher can change what the desk does tomorrow morning, and a gesture that
 * consequential should not be indistinguishable from a mis-click.
 *
 * ── The whole-list write ────────────────────────────────────────────────────
 * Confirming sends the COMPLETE ordered list of slugs, not a set of
 * `{slug, position}` edits. Two admins dragging at the same time with pairwise
 * positions produce an order neither of them chose; a whole-list write means
 * the second one simply wins and can see that it did. The server answers with
 * one outcome per slug, so a row that refused to move (shared from the master
 * tenant, or deleted underneath us) says so instead of failing the whole drag.
 *
 * ── What a row has to show without being opened ─────────────────────────────
 *   • its position, and that position is draggable
 *   • on / off, switchable in place
 *   • its triggers, in French
 *   • what it last DID — runs, matches, errors, when. A rule that has not fired
 *     in six weeks and one that fires four hundred times a day look identical
 *     in a body; they are not the same rule to operate.
 *   • its config problems, and its circuit breaker if it has tripped. A rule
 *     the engine has switched off for failing is the single most important
 *     thing on this screen and it gets the loudest treatment.
 *
 * HARD RULE 11 — rows are background steps, never outlined boxes.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertOctagon,
  AlertTriangle,
  Check,
  FlaskConical,
  GripVertical,
  Plus,
  RotateCcw,
  Share2,
  X,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { Toggle } from '@/components/common/Toggle';
import { formatRelative } from '@/utils/format';
import { cn } from '@/utils/cn';
import {
  TRIGGER_LABELS,
  type RuleGuardrails,
  type RuleSummary,
} from '@/api/rules.api';

// ═════════════════════════════════════════════════════════════════════════════
// One row
// ═════════════════════════════════════════════════════════════════════════════

interface RowProps {
  rule: RuleSummary;
  position: number;
  selected: boolean;
  reordering: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onResetBreaker: () => void;
}

function RuleRow({
  rule,
  position,
  selected,
  reordering,
  busy,
  onSelect,
  onToggle,
  onResetBreaker,
}: RowProps): JSX.Element {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rule.slug,
  });

  const breakerOpen = rule.breaker?.openedAt != null;
  const errors = rule.issues.filter((issue) => issue.code !== 'ignored_param');
  const health = rule.health ?? null;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group relative flex items-stretch gap-2 rounded-lg transition-colors',
        selected ? 'bg-accent/10' : 'bg-bg-secondary hover:bg-bg-hover',
        isDragging && 'z-10 opacity-90 shadow-lg',
        !rule.enabled && !isDragging && 'opacity-70',
      )}
    >
      {/* ── position + grab handle ─────────────────────────────────────────── */}
      <div className="flex w-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-l-lg bg-bg-tertiary/70 py-2">
        <span
          className={cn(
            'font-mono text-[13px] font-semibold tabular-nums',
            reordering ? 'text-accent' : 'text-text-secondary',
          )}
          title={t('rules.positionHelp', 'Ordre d’exécution : les règles s’appliquent de haut en bas.')}
        >
          {position}
        </span>
        <button
          type="button"
          {...attributes}
          {...listeners}
          disabled={busy}
          aria-label={t('rules.dragHandle', 'Déplacer cette règle dans l’ordre')}
          className="cursor-grab text-text-muted transition-colors hover:text-text-primary active:cursor-grabbing"
        >
          <GripVertical size={14} />
        </button>
      </div>

      {/* ── the rule ───────────────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col gap-1 py-2 pr-2 text-left"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'truncate text-[13.5px] font-medium',
              rule.enabled ? 'text-text-primary' : 'text-text-muted',
            )}
          >
            {rule.name || rule.slug}
          </span>

          {rule.dryRun && (
            <span
              className="inline-flex items-center gap-1 rounded-pill bg-status-scheduled-bg px-2 py-0.5 text-[10.5px] font-medium text-status-scheduled"
              title={t('rules.dryRunHelp', 'Évaluée et journalisée, mais n’effectue aucune action.')}
            >
              <FlaskConical size={10} />
              {t('rules.dryRun', 'Simulation')}
            </span>
          )}
          {rule.stopProcessing && (
            <span
              className="rounded-pill bg-bg-tertiary px-2 py-0.5 text-[10.5px] text-text-secondary"
              title={t('rules.stopProcessingHelp', 'Si elle correspond, les règles suivantes ne sont pas évaluées.')}
            >
              {t('rules.stopProcessing', 'Arrête la suite')}
            </span>
          )}
          {rule.shared && (
            <span
              className="inline-flex items-center gap-1 rounded-pill bg-bg-tertiary px-2 py-0.5 text-[10.5px] text-text-muted"
              title={t('rules.sharedHelp', 'Poussée depuis le locataire maître : modifiable seulement là-bas.')}
            >
              <Share2 size={10} />
              {t('rules.shared', 'Partagée')}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-text-muted">
          <span className="font-mono">{rule.slug}</span>
          <span aria-hidden>·</span>
          <span>
            {rule.triggers.length === 0
              ? t('rules.noTrigger', 'aucun déclencheur')
              : rule.triggers
                .map((trigger) => t(TRIGGER_LABELS[trigger]?.key ?? trigger, TRIGGER_LABELS[trigger]?.fr ?? trigger))
                .join(' · ')}
          </span>
          <span aria-hidden>·</span>
          <span>
            {t('rules.actionCount', '{{count}} action(s)', { count: rule.actions.length })}
          </span>
        </div>

        {/* what it last did */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]">
          {health && health.runs > 0 ? (
            <>
              <span className="text-text-secondary">
                {t('rules.lastRun', 'Dernière exécution')} {formatRelative(health.lastRunAt)}
              </span>
              <span aria-hidden className="text-text-muted">·</span>
              <span className="text-text-secondary">
                {t('rules.matchCount', '{{matches}} / {{runs}} correspondances', {
                  matches: health.matches,
                  runs: health.runs,
                })}
              </span>
              {health.errors > 0 && (
                <>
                  <span aria-hidden className="text-text-muted">·</span>
                  <span className="text-sla-breach">
                    {t('rules.errorCount', '{{count}} erreur(s)', { count: health.errors })}
                  </span>
                </>
              )}
            </>
          ) : (
            <span className="text-text-muted">
              {health
                ? t('rules.neverRan', 'Jamais exécutée sur la période observée')
                : t('rules.healthUnknown', 'Historique non chargé')}
            </span>
          )}
        </div>

        {breakerOpen && (
          <div className="mt-0.5 flex items-start gap-1.5 rounded-md bg-sla-breach-bg px-2 py-1 text-[11.5px] text-sla-breach">
            <AlertOctagon size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              {t(
                'rules.breakerOpen',
                'Coupe-circuit ouvert : {{failures}} échecs consécutifs, la règle ne tourne plus.',
                { failures: rule.breaker?.failures ?? 0 },
              )}{' '}
              {rule.breaker?.lastError && <span className="opacity-80">{rule.breaker.lastError}</span>}
            </span>
          </div>
        )}

        {errors.length > 0 && (
          <div className="mt-0.5 flex items-start gap-1.5 text-[11.5px] text-sla-warn">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              {/*
                The linter's message arrives from the server in English. Every
                issue also carries a stable `code`, so translate on the code and
                keep the server's sentence as the fallback: a new code the client
                does not know yet still says something true instead of nothing.
                HARD RULE 10 — the raw English string was reaching the screen.
              */}
              {errors.length === 1
                ? t(`rules.lint.${errors[0].code}`, errors[0].message)
                : t('rules.issueCount', '{{count}} problème(s) de configuration', { count: errors.length })}
            </span>
          </div>
        )}
      </button>

      {/* ── inline controls ────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-1 pr-2">
        {breakerOpen && (
          <button
            type="button"
            disabled={busy}
            onClick={onResetBreaker}
            title={t('rules.resetBreaker', 'Réarmer le coupe-circuit')}
            aria-label={t('rules.resetBreaker', 'Réarmer le coupe-circuit')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-sla-breach transition-colors hover:bg-bg-hover"
          >
            <RotateCcw size={13} />
          </button>
        )}
        <Toggle
          size="sm"
          checked={rule.enabled}
          onChange={onToggle}
          disabled={busy || rule.shared}
          disabledReason={
            rule.shared
              ? t('rules.sharedReadOnly', 'Règle partagée : à modifier depuis le locataire maître.')
              : t('common.saving', 'Enregistrement…')
          }
          aria-label={t('rules.toggleRule', 'Activer la règle {{name}}', {
            name: rule.name || rule.slug,
          })}
        />
      </div>
    </li>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The list
// ═════════════════════════════════════════════════════════════════════════════

export interface RuleListProps {
  rules: RuleSummary[];
  guardrails?: RuleGuardrails | null;
  selectedSlug?: string | null;
  busy?: boolean;
  onSelect: (slug: string) => void;
  /** Whole-list write. Resolves when the server has accepted the new order. */
  onReorder: (order: string[]) => Promise<void>;
  onToggle: (slug: string, enabled: boolean) => Promise<void> | void;
  onResetBreaker: (slug: string) => void;
  onCreate?: () => void;
}

export function RuleList({
  rules,
  guardrails,
  selectedSlug,
  busy = false,
  onSelect,
  onReorder,
  onToggle,
  onResetBreaker,
  onCreate,
}: RuleListProps): JSX.Element {
  const { t } = useTranslation();

  // The server's order, and the order the admin has dragged into but not yet
  // confirmed. Keeping them apart is what makes "confirm on drop" possible.
  const serverOrder = useMemo(() => rules.map((rule) => rule.slug), [rules]);
  const [pending, setPending] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  // A refresh from the server wins over an unconfirmed drag: the list must
  // never show an order the engine is not running unless a human is mid-edit.
  useEffect(() => {
    setPending((current) => {
      if (!current) return null;
      const sameSet =
        current.length === serverOrder.length && current.every((slug) => serverOrder.includes(slug));
      return sameSet ? current : null;
    });
  }, [serverOrder]);

  const order = pending ?? serverOrder;
  const bySlug = useMemo(() => new Map(rules.map((rule) => [rule.slug, rule])), [rules]);
  const ordered = useMemo(
    () => order.map((slug) => bySlug.get(slug)).filter((rule): rule is RuleSummary => rule !== undefined),
    [order, bySlug],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    setPending(arrayMove(order, from, to));
  }

  async function confirm() {
    if (!pending) return;
    setSaving(true);
    try {
      await onReorder(pending);
      setPending(null);
    } finally {
      setSaving(false);
    }
  }

  if (rules.length === 0) {
    return (
      <EmptyState
        icon={<Zap size={22} />}
        title={t('rules.emptyTitle', 'Aucune règle publiée')}
        description={t(
          'rules.emptyDesc',
          'Les règles s’appliquent de haut en bas à chaque événement du ticket. Commencez par une règle en simulation : elle sera évaluée et journalisée sans rien modifier.',
        )}
        action={
          onCreate ? (
            <Button variant="primary" icon={<Plus size={14} />} onClick={onCreate}>
              {t('rules.create', 'Nouvelle règle')}
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-text-muted">
          {t(
            'rules.orderHelp',
            'Les règles s’exécutent dans cet ordre, de haut en bas. Faites glisser une ligne pour la déplacer.',
          )}
        </p>
        {onCreate && (
          <Button size="sm" variant="secondary" icon={<Plus size={13} />} onClick={onCreate}>
            {t('rules.create', 'Nouvelle règle')}
          </Button>
        )}
      </div>

      {/* The confirmation bar. Reordering is a change to the program, so it
          takes a deliberate second gesture. */}
      {pending && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-accent/10 px-3 py-2">
          <span className="text-[12.5px] text-text-primary">
            {t(
              'rules.reorderPending',
              'Nouvel ordre non appliqué. L’ordre décide de ce que le bureau fait. Confirmez pour l’enregistrer.',
            )}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              icon={<X size={13} />}
              disabled={saving}
              onClick={() => setPending(null)}
            >
              {t('common.cancel', 'Annuler')}
            </Button>
            <Button size="sm" variant="primary" icon={<Check size={13} />} loading={saving} onClick={confirm}>
              {t('rules.applyOrder', 'Appliquer cet ordre')}
            </Button>
          </div>
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <ul className="space-y-1.5">
            {ordered.map((rule, index) => (
              <RuleRow
                key={rule.slug}
                rule={rule}
                position={index + 1}
                selected={rule.slug === selectedSlug}
                reordering={pending !== null}
                busy={busy || saving}
                onSelect={() => onSelect(rule.slug)}
                onToggle={(enabled) => onToggle(rule.slug, enabled)}
                onResetBreaker={() => onResetBreaker(rule.slug)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {guardrails && (
        <p className="px-1 text-[11px] text-text-muted">
          {t(
            'rules.guardrails',
            'Garde-fous du moteur : {{budget}} actions par ticket et par événement, profondeur de ré-entrée {{depth}}, coupe-circuit après {{threshold}} échecs consécutifs.',
            {
              budget: guardrails.actionBudget,
              depth: guardrails.maxLoopDepth,
              threshold: guardrails.breakerThreshold,
            },
          )}
        </p>
      )}
    </div>
  );
}

export default RuleList;
