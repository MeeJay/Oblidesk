/**
 * SlaPolicyEditor.tsx — one contract, its targets, and the arithmetic they buy.
 *
 * ── The refusal this editor exists to make ──────────────────────────────────
 * A target that runs on a BUSINESS calendar and also pauses on `outside_hours`
 * counts the closed hours twice: once because the calendar does not advance
 * through them, and again because the clock is explicitly paused. The resulting
 * due date is roughly twice as generous as the contract says, and it looks
 * entirely plausible on screen — which is exactly why it is an error and not a
 * warning.
 *
 * The server refuses it twice already: `configLinter.lintSla()` refuses the
 * publish, and `sla.service.validateTarget()` refuses to start such a clock at
 * runtime. This editor refuses it a third time, locally, so the refusal arrives
 * while the author is still looking at the target that caused it — with the
 * same wording, from `reviewPolicyDraft()`, which mirrors the server's rule
 * rather than inventing a second one.
 *
 * The legitimate pairing — 24×7 calendar + `outside_hours`, taking its edges
 * from a named office-hours calendar — is offered and explained, because it is
 * the one that produces a customer-facing strip saying "closed 18:00 → 09:00"
 * in words instead of leaving a gap to be inferred.
 *
 * ── Durations are per priority, and a missing one means "no target" ─────────
 * A target with no duration for the ticket's priority does not apply to that
 * ticket. That is a feature (P4 with no resolution target), and it is also the
 * single most common accident, so the grid shows every priority the tenant has
 * with its cell empty rather than hiding the ones nobody filled in.
 *
 * ── What the editor writes ──────────────────────────────────────────────────
 * `policyDraftToBody()` writes ONE dialect — the one `parseSlaPolicy()` reads —
 * with pause categories and pause sources as separate keys. The engine accepts
 * them mixed in a single array and splits by membership; writing them mixed
 * would let a target that names only source reasons silently inherit the
 * default categories.
 *
 * HARD RULE 11 — sections and target cards are background steps, not outlines.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ChevronDown,
  Clock,
  Copy,
  Plus,
  Save,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import {
  STATUS_CATEGORY_META,
  STATUS_CATEGORY_ORDER,
  type ConfigLintIssue,
  type StatusCategory,
} from '@oblidesk/shared';
import { Button } from '@/components/common/Button';
import { Toggle } from '@/components/common/Toggle';
import ConditionBuilder, { useFieldCatalogue } from '@/components/automation/ConditionBuilder';
import { cn } from '@/utils/cn';
import type { FieldChoice } from '@/api/rules.api';
import {
  SOURCE_PAUSE_REASONS,
  STOP_KIND_LABELS,
  TARGET_SWITCH_LABELS,
  TARGET_SWITCH_MODES,
  emptyTarget,
  newTargetUid,
  reviewPolicyDraft,
  type CalendarSummary,
  type PolicyDraft,
  type SourcePauseReason,
  type StopKind,
  type TargetDraft,
  type TargetIssue,
} from '@/api/sla.api';

const CONTROL =
  'h-8 rounded-md bg-bg-tertiary px-2 text-[13px] text-text-primary outline-none '
  + 'focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50';

/** The three targets a desk actually sells. Anything else is a custom slug. */
const TARGET_PRESETS: Array<{ slug: string; fr: string; key: string; stopKind: StopKind; stopCategory: StatusCategory | null }> = [
  {
    slug: 'first_response',
    fr: 'Première réponse',
    key: 'sla.preset.firstResponse',
    stopKind: 'first_response',
    stopCategory: null,
  },
  {
    slug: 'resolution',
    fr: 'Résolution',
    key: 'sla.preset.resolution',
    stopKind: 'category',
    stopCategory: 'resolved',
  },
  {
    slug: 'next_update',
    fr: 'Prochaine mise à jour',
    key: 'sla.preset.nextUpdate',
    stopKind: 'manual',
    stopCategory: null,
  },
];

const PAUSE_SOURCE_LABELS: Readonly<Record<SourcePauseReason, { key: string; fr: string; help: string }>> = {
  maintenance_window: {
    key: 'sla.pauseSource.maintenance',
    fr: 'Fenêtre de maintenance',
    help: 'L’horloge s’arrête pendant une fenêtre de maintenance déclarée sur l’élément de configuration.',
  },
  device_offline: {
    key: 'sla.pauseSource.deviceOffline',
    fr: 'Équipement hors ligne',
    help: 'L’horloge s’arrête tant que l’équipement est injoignable. Une mesure trop ancienne n’est pas une preuve et ne met pas en pause.',
  },
  outside_hours: {
    key: 'sla.pauseSource.outsideHours',
    fr: 'Hors horaires d’ouverture',
    help: 'À n’utiliser que sur un calendrier 24×7 : les bornes viennent alors du calendrier d’ouverture choisi, et chaque bord est inscrit au registre.',
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// One target
// ═════════════════════════════════════════════════════════════════════════════

interface TargetCardProps {
  target: TargetDraft;
  policyCalendarSlug: string;
  calendars: readonly CalendarSummary[];
  priorities: readonly FieldChoice[];
  issues: TargetIssue[];
  disabled: boolean;
  onChange: (next: TargetDraft) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}

function TargetCard({
  target,
  policyCalendarSlug,
  calendars,
  priorities,
  issues,
  disabled,
  onChange,
  onRemove,
  onDuplicate,
}: TargetCardProps): JSX.Element {
  const { t } = useTranslation();
  const { catalogue } = useFieldCatalogue();
  const [open, setOpen] = useState(true);
  const [showScope, setShowScope] = useState(target.appliesWhen !== null);

  const effectiveCalendarSlug = target.calendarSlug || policyCalendarSlug;
  const effectiveCalendar = calendars.find((entry) => entry.slug === effectiveCalendarSlug);
  const errors = issues.filter((issue) => issue.severity === 'error');

  function patch(partial: Partial<TargetDraft>) {
    onChange({ ...target, ...partial });
  }

  function setDuration(prioritySlug: string, raw: string) {
    const next = { ...target.durationsByPriority };
    if (raw.trim() === '') delete next[prioritySlug];
    else {
      const minutes = Number(raw);
      if (Number.isFinite(minutes) && minutes > 0) next[prioritySlug] = Math.round(minutes);
    }
    patch({ durationsByPriority: next });
  }

  return (
    // A blocking target is marked by a deeper, tinted surface: HARD RULE 11
    // forbids an outline, and a red wash reads faster than one anyway.
    <li className={cn('rounded-lg p-3', errors.length > 0 ? 'bg-sla-breach-bg/40' : 'bg-bg-secondary')}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          <ChevronDown
            size={13}
            className={cn('shrink-0 text-text-muted transition-transform', !open && '-rotate-90')}
          />
          <Clock size={13} className="shrink-0 text-text-muted" />
          <span className="truncate text-[13.5px] font-medium text-text-primary">
            {target.label || target.slug || t('sla.untitledTarget', 'Cible sans nom')}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-text-muted">{target.slug}</span>
          <span className="shrink-0 text-[11.5px] text-text-muted">
            {t(STOP_KIND_LABELS[target.stopKind].key, STOP_KIND_LABELS[target.stopKind].fr)}
          </span>
          {effectiveCalendar && (
            <span
              className={cn(
                'shrink-0 rounded-pill px-2 py-0.5 text-[10.5px]',
                effectiveCalendar.is24x7
                  ? 'bg-status-open-bg text-status-open'
                  : 'bg-bg-tertiary text-text-secondary',
              )}
            >
              {effectiveCalendar.is24x7 ? '24×7' : effectiveCalendar.name || effectiveCalendar.slug}
            </span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            disabled={disabled}
            onClick={onDuplicate}
            aria-label={t('sla.duplicateTarget', 'Dupliquer la cible')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <Copy size={13} />
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onRemove}
            aria-label={t('sla.removeTarget', 'Supprimer la cible')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-priority-p1"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {issues.length > 0 && (
        <ul className="mt-2 space-y-1">
          {issues.map((issue, index) => (
            <li
              key={index}
              className={cn(
                'flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-[12px]',
                issue.severity === 'error' ? 'bg-sla-breach-bg text-sla-breach' : 'bg-sla-warn-bg text-sla-warn',
              )}
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              {t(issue.messageKey, issue.message)}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          {/* ── identity + stop ──────────────────────────────────────────── */}
          <div className="grid gap-2.5 sm:grid-cols-3">
            <label className="block space-y-1">
              <span className="text-[11.5px] font-medium text-text-secondary">
                {t('sla.targetSlug', 'Identifiant')}
              </span>
              <input
                type="text"
                disabled={disabled}
                value={target.slug}
                onChange={(event) =>
                  patch({ slug: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '_') })
                }
                className={cn(CONTROL, 'w-full font-mono')}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11.5px] font-medium text-text-secondary">
                {t('sla.targetLabel', 'Libellé')}
              </span>
              <input
                type="text"
                disabled={disabled}
                value={target.label}
                onChange={(event) => patch({ label: event.target.value })}
                className={cn(CONTROL, 'w-full')}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11.5px] font-medium text-text-secondary">
                {t('sla.stopKind', 'L’horloge s’arrête')}
              </span>
              <select
                disabled={disabled}
                value={target.stopKind}
                onChange={(event) => {
                  const stopKind = event.target.value as StopKind;
                  patch({
                    stopKind,
                    stopCategory: stopKind === 'category' ? target.stopCategory ?? 'resolved' : null,
                  });
                }}
                className={cn(CONTROL, 'w-full appearance-none pr-6')}
              >
                {(Object.keys(STOP_KIND_LABELS) as StopKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {t(STOP_KIND_LABELS[kind].key, STOP_KIND_LABELS[kind].fr)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {target.stopKind === 'category' && (
            <label className="block max-w-xs space-y-1">
              <span className="text-[11.5px] font-medium text-text-secondary">
                {t('sla.stopCategory', 'Catégorie qui arrête l’horloge')}
              </span>
              <select
                disabled={disabled}
                value={target.stopCategory ?? 'resolved'}
                onChange={(event) => patch({ stopCategory: event.target.value as StatusCategory })}
                className={cn(CONTROL, 'w-full appearance-none pr-6')}
              >
                {STATUS_CATEGORY_ORDER.map((category) => (
                  <option key={category} value={category}>
                    {t(STATUS_CATEGORY_META[category].labelKey, STATUS_CATEGORY_META[category].label)}
                  </option>
                ))}
              </select>
              <span className="block text-[11px] text-text-muted">
                {t(
                  'sla.stopCategoryHelp',
                  'Les moteurs raisonnent sur la catégorie, jamais sur le nom du statut : un locataire peut renommer « Résolu » sans casser ses contrats.',
                )}
              </span>
            </label>
          )}

          {target.stopKind === 'condition' && (
            <ConditionBuilder
              value={target.stopWhen}
              onChange={(stopWhen) => patch({ stopWhen })}
              catalogue={catalogue}
              disabled={disabled}
              label={t('sla.stopWhen', 'Condition d’arrêt')}
              emptyMeaning={t('sla.stopWhenEmpty', 'jamais : sans condition, l’horloge ne s’arrêtera pas toute seule')}
            />
          )}

          {/* ── durations ────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <span className="text-[11.5px] font-medium text-text-secondary">
              {t('sla.durations', 'Durées par priorité, en minutes ouvrées')}
            </span>
            {priorities.length === 0 ? (
              <p className="text-[12px] text-text-muted">
                {t('sla.noPriorities', 'Aucune priorité publiée : publiez une matrice de priorités d’abord.')}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {priorities.map((priority) => (
                  <label key={priority.value} className="space-y-1">
                    <span className="block text-[11px] text-text-muted">{priority.label}</span>
                    <input
                      type="number"
                      min={1}
                      disabled={disabled}
                      value={target.durationsByPriority[priority.value] ?? ''}
                      onChange={(event) => setDuration(priority.value, event.target.value)}
                      placeholder="—"
                      className={cn(CONTROL, 'w-[92px] text-right font-mono')}
                    />
                  </label>
                ))}
              </div>
            )}
            <p className="text-[11px] text-text-muted">
              {t(
                'sla.durationsHelp',
                'Une priorité laissée vide signifie « pas de cible » : aucun compteur ne démarre pour ces tickets.',
              )}
            </p>
          </div>

          {/* ── calendar ─────────────────────────────────────────────────── */}
          <div className="grid gap-2.5 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[11.5px] font-medium text-text-secondary">
                {t('sla.targetCalendar', 'Calendrier de décompte')}
              </span>
              <select
                disabled={disabled}
                value={target.calendarSlug}
                onChange={(event) => patch({ calendarSlug: event.target.value })}
                className={cn(CONTROL, 'w-full appearance-none pr-6')}
              >
                <option value="">
                  {t('sla.inheritCalendar', 'Hériter du contrat ({{slug}})', { slug: policyCalendarSlug })}
                </option>
                {calendars.map((entry) => (
                  <option key={entry.slug} value={entry.slug}>
                    {entry.name || entry.slug}
                    {entry.is24x7 ? ' (24×7)' : ` (${entry.weeklyHours} h/sem.)`}
                  </option>
                ))}
              </select>
            </label>

            {target.pauseSources.includes('outside_hours') && (
              <label className="block space-y-1">
                <span className="text-[11.5px] font-medium text-text-secondary">
                  {t('sla.pauseCalendar', 'Calendrier fournissant les horaires d’ouverture')}
                </span>
                <select
                  disabled={disabled}
                  value={target.pauseCalendarSlug}
                  onChange={(event) => patch({ pauseCalendarSlug: event.target.value })}
                  className={cn(CONTROL, 'w-full appearance-none pr-6')}
                >
                  <option value="">{t('sla.tenantDefaultCalendar', 'Calendrier par défaut du locataire')}</option>
                  {calendars
                    .filter((entry) => !entry.is24x7)
                    .map((entry) => (
                      <option key={entry.slug} value={entry.slug}>
                        {entry.name || entry.slug}
                      </option>
                    ))}
                </select>
                <span className="block text-[11px] text-text-muted">
                  {t(
                    'sla.pauseCalendarHelp',
                    'Un calendrier 24×7 n’a pas de bords : les heures d’ouverture doivent venir d’ailleurs.',
                  )}
                </span>
              </label>
            )}
          </div>

          {/* ── pauses ───────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <span className="text-[11.5px] font-medium text-text-secondary">
              {t('sla.pauseOn', 'L’horloge se met en pause')}
            </span>
            <div className="flex flex-wrap gap-1">
              {STATUS_CATEGORY_ORDER.filter((category) => !STATUS_CATEGORY_META[category].terminal).map(
                (category) => {
                  const active = target.pauseOnCategories.includes(category);
                  return (
                    <button
                      key={category}
                      type="button"
                      disabled={disabled}
                      aria-pressed={active}
                      onClick={() =>
                        patch({
                          pauseOnCategories: active
                            ? target.pauseOnCategories.filter((entry) => entry !== category)
                            : [...target.pauseOnCategories, category],
                        })
                      }
                      className={cn(
                        'h-7 rounded-pill px-2.5 text-[12px] transition-colors',
                        active ? 'bg-sla-paused-bg text-sla-paused' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                      )}
                    >
                      {t(STATUS_CATEGORY_META[category].labelKey, STATUS_CATEGORY_META[category].label)}
                    </button>
                  );
                },
              )}
            </div>

            <div className="flex flex-wrap gap-1">
              {SOURCE_PAUSE_REASONS.map((source) => {
                const active = target.pauseSources.includes(source);
                return (
                  <button
                    key={source}
                    type="button"
                    disabled={disabled}
                    aria-pressed={active}
                    title={PAUSE_SOURCE_LABELS[source].help}
                    onClick={() =>
                      patch({
                        pauseSources: active
                          ? target.pauseSources.filter((entry) => entry !== source)
                          : [...target.pauseSources, source],
                      })
                    }
                    className={cn(
                      'h-7 rounded-pill px-2.5 text-[12px] transition-colors',
                      active ? 'bg-status-scheduled-bg text-status-scheduled' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                    )}
                  >
                    {t(PAUSE_SOURCE_LABELS[source].key, PAUSE_SOURCE_LABELS[source].fr)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── warnings + switch + escalation ───────────────────────────── */}
          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="space-y-1">
              <span className="text-[11.5px] font-medium text-text-secondary">
                {t('sla.warnAt', 'Pré-alerte à')}
              </span>
              <div className="flex flex-wrap gap-1">
                {[50, 75, 90].map((percent) => {
                  const active = target.warnAtPercent.includes(percent);
                  return (
                    <button
                      key={percent}
                      type="button"
                      disabled={disabled}
                      aria-pressed={active}
                      onClick={() =>
                        patch({
                          warnAtPercent: active
                            ? target.warnAtPercent.filter((entry) => entry !== percent)
                            : [...target.warnAtPercent, percent].sort((a, b) => a - b),
                        })
                      }
                      className={cn(
                        'h-7 rounded-pill px-2.5 font-mono text-[12px] transition-colors',
                        active ? 'bg-sla-warn-bg text-sla-warn' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                      )}
                    >
                      {percent}%
                    </button>
                  );
                })}
              </div>
              <span className="block text-[11px] text-text-muted">
                {t('sla.warnAtHelp', '100 % est le dépassement, pas une alerte.')}
              </span>
            </div>

            <label className="block space-y-1">
              <span className="text-[11.5px] font-medium text-text-secondary">
                {t('sla.escalation', 'Escalade déclenchée (slug)')}
              </span>
              <input
                type="text"
                disabled={disabled}
                value={target.escalationSlug}
                onChange={(event) => patch({ escalationSlug: event.target.value })}
                className={cn(CONTROL, 'w-full font-mono')}
                placeholder="escalade_p1"
              />
            </label>
          </div>

          <div className="space-y-1">
            <span className="text-[11.5px] font-medium text-text-secondary">
              {t('sla.onTargetSwitch', 'Si la priorité change en cours de route')}
            </span>
            <div className="flex flex-wrap gap-1">
              {TARGET_SWITCH_MODES.map((mode) => {
                const active = target.onTargetSwitch === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    disabled={disabled}
                    aria-pressed={active}
                    title={TARGET_SWITCH_LABELS[mode].help}
                    onClick={() => patch({ onTargetSwitch: mode })}
                    className={cn(
                      'h-7 rounded-pill px-3 text-[12px] transition-colors',
                      active ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                    )}
                  >
                    {t(TARGET_SWITCH_LABELS[mode].key, TARGET_SWITCH_LABELS[mode].fr)}
                  </button>
                );
              })}
            </div>
            <span className="block text-[11px] text-text-muted">
              {TARGET_SWITCH_LABELS[target.onTargetSwitch].help}
            </span>
          </div>

          {/* ── scope ────────────────────────────────────────────────────── */}
          <div>
            <button
              type="button"
              onClick={() => setShowScope((current) => !current)}
              className="flex items-center gap-1.5 text-[12px] text-text-muted transition-colors hover:text-text-secondary"
            >
              <ChevronDown size={12} className={cn('transition-transform', !showScope && '-rotate-90')} />
              {t('sla.targetScope', 'Restreindre cette cible à certains tickets')}
            </button>
            {showScope && (
              <div className="mt-1.5">
                <ConditionBuilder
                  value={target.appliesWhen}
                  onChange={(appliesWhen) => patch({ appliesWhen })}
                  catalogue={catalogue}
                  disabled={disabled}
                  emptyMeaning={t('sla.targetScopeEmpty', 'tous les tickets couverts par le contrat')}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The policy
// ═════════════════════════════════════════════════════════════════════════════

export interface SlaPolicyEditorProps {
  draft: PolicyDraft;
  onChange: (next: PolicyDraft) => void;
  calendars: CalendarSummary[];
  /** Priority slugs from the tenant's published matrix, for the duration grid. */
  priorities: FieldChoice[];
  isNew: boolean;
  readOnly?: boolean;
  saving?: boolean;
  lintIssues?: ConfigLintIssue[];
  onSave: () => Promise<void> | void;
  onCancel: () => void;
  onDelete?: () => void;
}

export function SlaPolicyEditor({
  draft,
  onChange,
  calendars,
  priorities,
  isNew,
  readOnly = false,
  saving = false,
  lintIssues = [],
  onSave,
  onCancel,
  onDelete,
}: SlaPolicyEditorProps): JSX.Element {
  const { t } = useTranslation();
  const { catalogue } = useFieldCatalogue();
  const [showScope, setShowScope] = useState(draft.appliesWhen !== null);

  const issues = useMemo(() => reviewPolicyDraft(draft, calendars), [draft, calendars]);
  const blocking = issues.filter((issue) => issue.severity === 'error');
  const issuesByTarget = useMemo(() => {
    const map = new Map<string, TargetIssue[]>();
    for (const issue of issues) {
      const list = map.get(issue.targetSlug) ?? [];
      list.push(issue);
      map.set(issue.targetSlug, list);
    }
    return map;
  }, [issues]);

  function patch(partial: Partial<PolicyDraft>) {
    onChange({ ...draft, ...partial });
  }

  function addPreset(preset: (typeof TARGET_PRESETS)[number]) {
    const target = emptyTarget(preset.slug);
    patch({
      targets: [
        ...draft.targets,
        {
          ...target,
          label: preset.fr,
          stopKind: preset.stopKind,
          stopCategory: preset.stopCategory,
        },
      ],
    });
  }

  return (
    <div className="space-y-3">
      {/* ── header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-[19px] font-semibold tracking-wide text-text-primary">
            {draft.name || draft.slug || t('sla.newPolicy', 'Nouveau contrat')}
          </h2>
          <p className="text-[11.5px] text-text-muted">
            {t(
              'sla.policyHeaderHelp',
              'Priorité {{precedence}}. Quand plusieurs contrats correspondent, la précédence la plus élevée gagne, et les perdants restent inscrits sur le ticket.',
              { precedence: draft.precedence },
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {onDelete && !isNew && !readOnly && (
            <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={onDelete}>
              {t('sla.archive', 'Archiver')}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={onCancel}>
            {t('common.cancel', 'Annuler')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Save size={13} />}
            loading={saving}
            disabled={readOnly || blocking.length > 0 || !draft.slug.trim()}
            title={
              blocking.length > 0
                ? t('sla.blockedBySelfCheck', 'Un problème bloquant empêche l’enregistrement : voir la cible concernée.')
                : undefined
            }
            onClick={() => void onSave()}
          >
            {isNew ? t('sla.createAndPublish', 'Créer et publier') : t('common.saveAndPublish', 'Enregistrer et publier')}
          </Button>
        </div>
      </div>

      {blocking.length > 0 && (
        <div className="space-y-1 rounded-lg bg-sla-breach-bg px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-sla-breach">
            <ShieldAlert size={14} />
            {t('sla.refuseToSave', 'Enregistrement refusé tant que ceci n’est pas corrigé')}
          </p>
          <ul className="space-y-0.5">
            {blocking.map((issue, index) => (
              <li key={index} className="text-[12px] text-text-secondary">
                {t(issue.messageKey, issue.message)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {lintIssues.length > 0 && (
        <div className="space-y-1 rounded-lg bg-sla-breach-bg px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-sla-breach">
            <ShieldAlert size={14} />
            {t('sla.lintRefused', 'La publication a été refusée par le contrôle de configuration')}
          </p>
          <ul className="space-y-0.5">
            {lintIssues.map((issue, index) => (
              <li key={index} className="text-[12px] text-text-secondary">
                <span className="font-mono text-[11px] text-text-muted">{issue.path || issue.code}</span>{' '}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── identity ─────────────────────────────────────────────────────── */}
      <section className="grid gap-2.5 rounded-lg bg-bg-secondary/60 p-3 sm:grid-cols-4">
        <label className="block space-y-1 sm:col-span-2">
          <span className="text-[11.5px] font-medium text-text-secondary">{t('sla.policyName', 'Nom')}</span>
          <input
            type="text"
            disabled={readOnly}
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            className={cn(CONTROL, 'w-full')}
            placeholder={t('sla.policyNamePlaceholder', 'Contrat Or (clients sous contrat)')}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11.5px] font-medium text-text-secondary">{t('sla.policySlug', 'Identifiant')}</span>
          <input
            type="text"
            disabled={readOnly || !isNew}
            value={draft.slug}
            onChange={(event) =>
              patch({ slug: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '_') })
            }
            className={cn(CONTROL, 'w-full font-mono')}
            placeholder="gold"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11.5px] font-medium text-text-secondary">
            {t('sla.precedence', 'Précédence')}
          </span>
          <input
            type="number"
            disabled={readOnly}
            value={draft.precedence}
            onChange={(event) => patch({ precedence: Number(event.target.value) || 0 })}
            className={cn(CONTROL, 'w-full text-right font-mono')}
          />
        </label>

        <label className="block space-y-1 sm:col-span-2">
          <span className="text-[11.5px] font-medium text-text-secondary">
            {t('sla.policyCalendar', 'Calendrier par défaut du contrat')}
          </span>
          <select
            disabled={readOnly}
            value={draft.calendarSlug}
            onChange={(event) => patch({ calendarSlug: event.target.value })}
            className={cn(CONTROL, 'w-full appearance-none pr-6')}
          >
            {calendars.length === 0 && <option value={draft.calendarSlug}>{draft.calendarSlug}</option>}
            {calendars.map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.name || entry.slug}
                {entry.is24x7 ? ' (24×7)' : ` (${entry.weeklyHours} h/sem.)`}
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-1 sm:col-span-2">
          <span className="text-[11.5px] font-medium text-text-secondary">
            {t('sla.enabled', 'Contrat actif')}
          </span>
          <Toggle
            checked={draft.enabled}
            onChange={(enabled) => patch({ enabled })}
            disabled={readOnly}
            disabledReason={t(
              'sla.readOnlyNotice',
              'Lecture seule : la publication d’un contrat ou d’un calendrier demande la capacité « administration de la configuration ».',
            )}
            aria-label={t('sla.enabled', 'Contrat actif')}
            className="block"
          />
        </div>
      </section>

      {/* ── bindings + scope ─────────────────────────────────────────────── */}
      <section className="space-y-2.5 rounded-lg bg-bg-secondary/60 p-3">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-text-secondary">
          {t('sla.coverage', 'Portée du contrat')}
        </h3>
        <div className="grid gap-2.5 sm:grid-cols-3">
          {(
            [
              ['organizations', t('sla.bindOrganizations', 'Organisations (slugs)')],
              ['queues', t('sla.bindQueues', 'Files (slugs)')],
              ['recordTypes', t('sla.bindRecordTypes', 'Types d’enregistrement')],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block space-y-1">
              <span className="text-[11.5px] font-medium text-text-secondary">{label}</span>
              <input
                type="text"
                disabled={readOnly}
                value={draft[key].join(', ')}
                onChange={(event) =>
                  patch({
                    [key]: event.target.value
                      .split(',')
                      .map((entry) => entry.trim())
                      .filter((entry) => entry !== ''),
                  } as Partial<PolicyDraft>)
                }
                className={cn(CONTROL, 'w-full font-mono')}
                placeholder={t('sla.commaSeparated', 'séparés par des virgules')}
              />
            </label>
          ))}
        </div>
        <p className="text-[11px] text-text-muted">
          {t(
            'sla.bindingsHelp',
            'Ces liens décident du NIVEAU auquel le contrat concourt : organisation, puis file, puis type, puis global. Sans lien, il est global.',
          )}
        </p>

        <div>
          <button
            type="button"
            onClick={() => setShowScope((current) => !current)}
            className="flex items-center gap-1.5 text-[12px] text-text-muted transition-colors hover:text-text-secondary"
          >
            <ChevronDown size={12} className={cn('transition-transform', !showScope && '-rotate-90')} />
            {t('sla.policyScope', 'Condition d’applicabilité')}
          </button>
          {showScope && (
            <div className="mt-1.5">
              <ConditionBuilder
                value={draft.appliesWhen}
                onChange={(appliesWhen) => patch({ appliesWhen })}
                catalogue={catalogue}
                disabled={readOnly}
                emptyMeaning={t('sla.policyScopeEmpty', 'tous les tickets que la portée ci-dessus désigne')}
              />
            </div>
          )}
        </div>
      </section>

      {/* ── targets ──────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-text-secondary">
            {t('sla.targets', 'Cibles')}
          </h3>
          <div className="ml-auto flex flex-wrap gap-1">
            {TARGET_PRESETS.filter(
              (preset) => !draft.targets.some((target) => target.slug === preset.slug),
            ).map((preset) => (
              <Button
                key={preset.slug}
                size="xs"
                variant="secondary"
                icon={<Plus size={12} />}
                disabled={readOnly}
                onClick={() => addPreset(preset)}
              >
                {t(preset.key, preset.fr)}
              </Button>
            ))}
            <Button
              size="xs"
              variant="ghost"
              icon={<Plus size={12} />}
              disabled={readOnly}
              onClick={() => patch({ targets: [...draft.targets, emptyTarget('')] })}
            >
              {t('sla.customTarget', 'Cible libre')}
            </Button>
          </div>
        </div>

        {draft.targets.length === 0 ? (
          <p className="rounded-lg bg-bg-secondary px-3 py-3 text-[12.5px] text-text-muted">
            {t('sla.noTargets', 'Un contrat sans cible ne démarre aucune horloge.')}
          </p>
        ) : (
          <ul className="space-y-2">
            {draft.targets.map((target, index) => (
              <TargetCard
                key={target.uid}
                target={target}
                policyCalendarSlug={draft.calendarSlug}
                calendars={calendars}
                priorities={priorities}
                issues={issuesByTarget.get(target.slug) ?? []}
                disabled={readOnly}
                onChange={(next) =>
                  patch({
                    targets: draft.targets.map((entry) => (entry.uid === target.uid ? next : entry)),
                  })
                }
                onRemove={() =>
                  patch({ targets: draft.targets.filter((entry) => entry.uid !== target.uid) })
                }
                onDuplicate={() => {
                  // A copy keeps everything that was configured and changes
                  // only what must be unique — its identity.
                  const copy: TargetDraft = {
                    ...target,
                    uid: newTargetUid(),
                    slug: `${target.slug}_copie`,
                    label: target.label ? `${target.label} (copie)` : '',
                    durationsByPriority: { ...target.durationsByPriority },
                    pauseOnCategories: [...target.pauseOnCategories],
                    pauseSources: [...target.pauseSources],
                    warnAtPercent: [...target.warnAtPercent],
                  };
                  const next = [...draft.targets];
                  next.splice(index + 1, 0, copy);
                  patch({ targets: next });
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default SlaPolicyEditor;
