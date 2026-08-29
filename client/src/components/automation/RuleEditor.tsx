/**
 * RuleEditor.tsx — authoring one rule.
 *
 * ── The primary button is "Simulate", not "Save" ────────────────────────────
 * That is a deliberate inversion of the usual form. Publishing a rule changes
 * what the desk does to real tickets from the next event onwards, and the only
 * honest way to know what that will be is to replay real tickets through the
 * real engine. So the loud button runs the dry run, and saving sits next to it
 * as a quieter, deliberate second act. A screen whose loudest control is the
 * irreversible one is a screen that teaches people to press it first.
 *
 * ── What is edited here is the engine's own view ────────────────────────────
 * The draft came from `normalizeRule()`'s output and goes back as the one
 * dialect that function reads (see `draftToBody`). Nothing in this file parses
 * a rule body: a second interpretation of the ordered list would eventually
 * disagree with the engine, and the disagreement would be invisible.
 *
 * ── Two kinds of complaint, kept apart ──────────────────────────────────────
 *   • LOCAL findings (`reviewDraft`) — the four things you can see are wrong
 *     without asking anybody: no slug, no trigger, no action, a schedule with
 *     no interval. Advisory, shown inline, never blocking.
 *   • The LINTER's findings, which arrive as a 422 on publish and ARE the
 *     answer. They are shown verbatim, with their path, and the draft stays on
 *     screen so the author can fix it where they are.
 *
 * Required-ness on this form follows HARD RULE 12's spirit: typing never fails.
 * The refusal happens at the transition that matters — here, the publish.
 *
 * HARD RULE 11 — sections are background steps, never outlined cards.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  FlaskConical,
  Play,
  Save,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import type { ConfigLintIssue } from '@oblidesk/shared';
import { Button } from '@/components/common/Button';
import { Toggle } from '@/components/common/Toggle';
import { errorMessage, toApiError } from '@/api/client';
import { cn } from '@/utils/cn';
import {
  DEFAULT_SAMPLE_SIZE,
  MAX_SAMPLE_SIZE,
  RULE_TRIGGERS,
  TRIGGER_LABELS,
  draftToBody,
  reviewDraft,
  rulesApi,
  type RuleActionDefinition,
  type RuleDraft,
  type RuleGuardrails,
  type RuleTriggerKind,
  type SimulationResultData,
} from '@/api/rules.api';
import ActionEditor from './ActionEditor';
import ConditionBuilder, { useFieldCatalogue } from './ConditionBuilder';
import SimulationResult from './SimulationResult';

const CONTROL =
  'h-9 w-full rounded-md bg-bg-tertiary px-2.5 text-[13px] text-text-primary outline-none '
  + 'focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50';

/** Columns worth watching on `ticket_updated`, in the engine's own spelling. */
const WATCHABLE_FIELDS = [
  { path: 'status_slug', fr: 'Statut' },
  { path: 'priority_slug', fr: 'Priorité' },
  { path: 'queue_slug', fr: 'File' },
  { path: 'assignee_id', fr: 'Responsable' },
  { path: 'assignment_group_id', fr: 'Groupe d’affectation' },
  { path: 'impact', fr: 'Impact' },
  { path: 'urgency', fr: 'Urgence' },
  { path: 'organization_id', fr: 'Organisation' },
  { path: 'primary_ci_id', fr: 'Élément de configuration' },
  { path: 'due_at', fr: 'Échéance' },
];

function Section({
  title,
  help,
  children,
}: {
  title: string;
  help?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="space-y-2 rounded-lg bg-bg-secondary/60 p-3">
      <div>
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-text-secondary">{title}</h3>
        {help && <p className="mt-0.5 text-[11.5px] leading-snug text-text-muted">{help}</p>}
      </div>
      {children}
    </section>
  );
}

export interface RuleEditorProps {
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
  actionCatalogue: RuleActionDefinition[];
  guardrails?: RuleGuardrails | null;
  /** A brand-new rule creates its config object instead of updating one. */
  isNew: boolean;
  /** A rule pushed down from the master tenant is read-only here. */
  readOnly?: boolean;
  saving?: boolean;
  /** Findings from a refused publish (422). Shown verbatim, with their path. */
  lintIssues?: ConfigLintIssue[];
  onSave: () => Promise<void> | void;
  onCancel: () => void;
  onDelete?: () => void;
  onOpenTicket?: (ticketId: number) => void;
}

export function RuleEditor({
  draft,
  onChange,
  actionCatalogue,
  guardrails,
  isNew,
  readOnly = false,
  saving = false,
  lintIssues = [],
  onSave,
  onCancel,
  onDelete,
  onOpenTicket,
}: RuleEditorProps): JSX.Element {
  const { t } = useTranslation();
  const { catalogue } = useFieldCatalogue();

  const [simulation, setSimulation] = useState<SimulationResultData | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [sampleSize, setSampleSize] = useState(DEFAULT_SAMPLE_SIZE);
  const [simulationTrigger, setSimulationTrigger] = useState<RuleTriggerKind>(
    draft.triggers[0] ?? 'ticket_created',
  );

  const findings = useMemo(() => reviewDraft(draft), [draft]);
  const blocking = findings.filter((finding) => finding.severity === 'error');

  const patch = useCallback(
    (partial: Partial<RuleDraft>) => onChange({ ...draft, ...partial }),
    [draft, onChange],
  );

  function toggleTrigger(trigger: RuleTriggerKind) {
    const next = draft.triggers.includes(trigger)
      ? draft.triggers.filter((entry) => entry !== trigger)
      : [...draft.triggers, trigger];
    patch({
      triggers: next,
      // A schedule with no interval is refused by the engine, so give it the
      // shape it needs the moment the trigger is chosen.
      schedule:
        next.includes('schedule') && !draft.schedule
          ? { everyMinutes: 60, cron: null, calendarSlug: null }
          : draft.schedule,
    });
  }

  async function simulate() {
    setSimulating(true);
    setSimulationError(null);
    try {
      const result = await rulesApi.simulate({
        // The CANDIDATE body, always — testing only what is already published
        // answers the question after it has stopped mattering.
        candidate: {
          slug: draft.slug || 'candidate',
          name: draft.name || draft.slug || 'candidate',
          body: draftToBody(draft),
        },
        sampleSize,
        trigger: simulationTrigger,
        recordLog: true,
      });
      setSimulation(result);
    } catch (error) {
      const apiError = toApiError(error);
      setSimulationError(errorMessage(apiError));
      setSimulation(null);
    } finally {
      setSimulating(false);
    }
  }

  const canSimulate = draft.actions.length > 0 && draft.triggers.length > 0 && !readOnly;
  const readOnlyReason = t('rules.sharedReadOnly', 'Règle partagée : à modifier depuis le locataire maître.');

  return (
    <div className="space-y-3">
      {/* ── header / actions ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-[19px] font-semibold tracking-wide text-text-primary">
            {draft.name || draft.slug || t('rules.newRule', 'Nouvelle règle')}
          </h2>
          <p className="text-[11.5px] text-text-muted">
            {isNew
              ? t('rules.newRuleHint', 'Elle sera créée, lintée puis publiée.')
              : t('rules.editingHint', 'L’enregistrement publie une nouvelle version, conservée dans l’historique.')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {onDelete && !isNew && !readOnly && (
            <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={onDelete}>
              {t('rules.archive', 'Archiver')}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={onCancel}>
            {t('common.cancel', 'Annuler')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Save size={13} />}
            loading={saving}
            disabled={readOnly || blocking.length > 0}
            onClick={() => void onSave()}
          >
            {isNew ? t('rules.createAndPublish', 'Créer et publier') : t('rules.saveAndPublish', 'Enregistrer et publier')}
          </Button>
          {/* THE primary action: know before you publish. */}
          <Button
            size="sm"
            variant="primary"
            icon={<Play size={13} />}
            loading={simulating}
            disabled={!canSimulate}
            onClick={() => void simulate()}
            title={t(
              'rules.simulateHelp',
              'Rejoue vos derniers tickets réels à travers le moteur de production, sans rien écrire.',
            )}
          >
            {t('rules.simulate', 'Simuler')}
          </Button>
        </div>
      </div>

      {readOnly && (
        <div className="flex items-start gap-2 rounded-lg bg-bg-tertiary px-3 py-2 text-[12.5px] text-text-secondary">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          {t(
            'rules.readOnlyShared',
            'Cette règle est poussée depuis le locataire maître. Elle se lit ici et se modifie là-bas.',
          )}
        </div>
      )}

      {/* ── the linter's answer ──────────────────────────────────────────── */}
      {lintIssues.length > 0 && (
        <div className="space-y-1 rounded-lg bg-sla-breach-bg px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-sla-breach">
            <ShieldAlert size={14} />
            {t('rules.lintRefused', 'La publication a été refusée par le contrôle de configuration')}
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

      {findings.length > 0 && (
        <ul className="space-y-1">
          {findings.map((finding) => (
            <li
              key={`${finding.path}-${finding.messageKey}`}
              className={cn(
                'flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-[12px]',
                finding.severity === 'error'
                  ? 'bg-sla-warn-bg text-sla-warn'
                  : 'bg-bg-tertiary text-text-secondary',
              )}
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              {t(finding.messageKey, finding.message)}
            </li>
          ))}
        </ul>
      )}

      {/* ── identity ─────────────────────────────────────────────────────── */}
      <Section
        title={t('rules.identity', 'Identité')}
        help={t(
          'rules.identityHelp',
          'Le slug est l’identifiant par lequel tout référence cette règle : journal d’exécution, décisions, exports. Il ne se renomme pas après publication.',
        )}
      >
        <div className="grid gap-2.5 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-[11.5px] font-medium text-text-secondary">
              {t('rules.name', 'Nom lisible')}
            </span>
            <input
              type="text"
              disabled={readOnly}
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
              className={CONTROL}
              placeholder={t('rules.namePlaceholder', 'Escalader les P1 non affectés')}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11.5px] font-medium text-text-secondary">
              {t('rules.slug', 'Identifiant (slug)')}
            </span>
            <input
              type="text"
              disabled={readOnly || !isNew}
              value={draft.slug}
              onChange={(event) =>
                patch({ slug: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '_') })
              }
              className={cn(CONTROL, 'font-mono')}
              placeholder="escalate_unassigned_p1"
            />
          </label>
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-[11.5px] font-medium text-text-secondary">
              {t('rules.description', 'Description')}
            </span>
            <textarea
              disabled={readOnly}
              rows={2}
              value={draft.description}
              onChange={(event) => patch({ description: event.target.value })}
              className={cn(CONTROL, 'h-auto resize-y py-2 leading-relaxed')}
              placeholder={t(
                'rules.descriptionPlaceholder',
                'À quoi elle sert, et pourquoi elle existe. La personne qui la lira dans six mois, c’est peut-être vous.',
              )}
            />
          </label>
        </div>
      </Section>

      {/* ── triggers ─────────────────────────────────────────────────────── */}
      <Section
        title={t('rules.triggers', 'Déclencheurs')}
        help={t('rules.triggersHelp', 'Les événements sur lesquels cette règle est évaluée.')}
      >
        <div className="flex flex-wrap gap-1.5">
          {RULE_TRIGGERS.map((trigger) => {
            const active = draft.triggers.includes(trigger);
            return (
              <button
                key={trigger}
                type="button"
                disabled={readOnly}
                aria-pressed={active}
                onClick={() => toggleTrigger(trigger)}
                className={cn(
                  'h-8 rounded-pill px-3 text-[12.5px] transition-colors disabled:opacity-50',
                  active ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                )}
              >
                {t(TRIGGER_LABELS[trigger].key, TRIGGER_LABELS[trigger].fr)}
              </button>
            );
          })}
        </div>

        {draft.triggers.includes('ticket_updated') && (
          <div className="space-y-1.5 rounded-md bg-bg-tertiary/60 p-2.5">
            <p className="text-[11.5px] text-text-muted">
              {t(
                'rules.watchedFieldsHelp',
                'Sur « à la modification », ne réagir que si l’un de ces champs a changé. Aucun choix = toute modification.',
              )}
            </p>
            <div className="flex flex-wrap gap-1">
              {WATCHABLE_FIELDS.map((field) => {
                const active = draft.triggerFields.includes(field.path);
                return (
                  <button
                    key={field.path}
                    type="button"
                    disabled={readOnly}
                    aria-pressed={active}
                    onClick={() =>
                      patch({
                        triggerFields: active
                          ? draft.triggerFields.filter((entry) => entry !== field.path)
                          : [...draft.triggerFields, field.path],
                      })
                    }
                    className={cn(
                      'h-7 rounded-pill px-2.5 text-[12px] transition-colors',
                      active ? 'bg-accent/15 text-accent' : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover',
                    )}
                  >
                    {catalogue?.byPath.get(field.path)?.label ?? field.fr}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {draft.triggers.includes('schedule') && (
          <div className="grid gap-2.5 rounded-md bg-bg-tertiary/60 p-2.5 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[11.5px] font-medium text-text-secondary">
                {t('rules.everyMinutes', 'Toutes les N minutes')}
              </span>
              <input
                type="number"
                min={1}
                disabled={readOnly}
                value={draft.schedule?.everyMinutes ?? ''}
                onChange={(event) =>
                  patch({
                    schedule: {
                      everyMinutes: event.target.value === '' ? null : Number(event.target.value),
                      cron: draft.schedule?.cron ?? null,
                      calendarSlug: draft.schedule?.calendarSlug ?? null,
                    },
                  })
                }
                className={cn(CONTROL, 'font-mono')}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11.5px] font-medium text-text-secondary">
                {t('rules.calendarSlug', 'Calendrier (facultatif)')}
              </span>
              <input
                type="text"
                disabled={readOnly}
                value={draft.schedule?.calendarSlug ?? ''}
                onChange={(event) =>
                  patch({
                    schedule: {
                      everyMinutes: draft.schedule?.everyMinutes ?? null,
                      cron: draft.schedule?.cron ?? null,
                      calendarSlug: event.target.value || null,
                    },
                  })
                }
                className={cn(CONTROL, 'font-mono')}
                placeholder="business"
              />
            </label>
          </div>
        )}
      </Section>

      {/* ── the condition ────────────────────────────────────────────────── */}
      <Section
        title={t('rules.when', 'Condition')}
        help={t(
          'rules.whenHelp',
          'Évaluée par le même moteur des deux côtés du fil. Une condition vide veut dire « toujours ».',
        )}
      >
        <ConditionBuilder
          value={draft.when}
          onChange={(next) => patch({ when: next })}
          catalogue={catalogue}
          disabled={readOnly}
          emptyMeaning={t('rules.whenAlways', 'toujours : la règle s’applique à chaque événement déclencheur')}
        />
      </Section>

      {/* ── actions ──────────────────────────────────────────────────────── */}
      <Section
        title={t('rules.actionsSection', 'Actions')}
        help={t('rules.actionsHelp', 'Effectuées dans l’ordre affiché, si la condition correspond.')}
      >
        <ActionEditor
          actions={draft.actions}
          catalogue={actionCatalogue}
          guardrails={guardrails}
          disabled={readOnly}
          onChange={(actions) => patch({ actions })}
        />
      </Section>

      {/* ── behaviour ────────────────────────────────────────────────────── */}
      <Section title={t('rules.behaviour', 'Comportement')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle
            checked={draft.enabled}
            disabled={readOnly}
            disabledReason={readOnlyReason}
            onChange={(enabled) => patch({ enabled })}
            label={t('rules.enabled', 'Active')}
            description={t('rules.enabledHelp', 'Une règle inactive reste dans la liste, à sa place, mais n’est pas évaluée.')}
          />
          <Toggle
            checked={draft.dryRun}
            disabled={readOnly}
            disabledReason={readOnlyReason}
            onChange={(dryRun) => patch({ dryRun })}
            label={t('rules.dryRunMode', 'Mode simulation')}
            description={t(
              'rules.dryRunModeHelp',
              'Évaluée et journalisée, mais n’effectue rien. La façon sûre d’introduire une règle sur un bureau en production.',
            )}
          />
          <Toggle
            checked={draft.stopProcessing}
            disabled={readOnly}
            disabledReason={readOnlyReason}
            onChange={(stopProcessing) => patch({ stopProcessing })}
            label={t('rules.stopProcessingLabel', 'Arrêter les règles suivantes')}
            description={t(
              'rules.stopProcessingLongHelp',
              'Si elle correspond, aucune règle plus bas dans la liste n’est évaluée pour cet événement.',
            )}
          />
          <Toggle
            checked={draft.runOnce}
            disabled={readOnly}
            disabledReason={readOnlyReason}
            onChange={(runOnce) => patch({ runOnce })}
            label={t('rules.runOnce', 'Une seule fois par ticket')}
            description={t('rules.runOnceHelp', 'Ne se déclenchera jamais deux fois sur le même ticket.')}
          />
          <label className="block space-y-1">
            <span className="text-[11.5px] font-medium text-text-secondary">
              {t('rules.cooldown', 'Refroidissement (minutes)')}
            </span>
            <input
              type="number"
              min={0}
              disabled={readOnly}
              value={draft.cooldownMinutes ?? ''}
              onChange={(event) =>
                patch({ cooldownMinutes: event.target.value === '' ? null : Number(event.target.value) })
              }
              className={cn(CONTROL, 'font-mono')}
              placeholder="0"
            />
            <span className="block text-[11.5px] text-text-muted">
              {t('rules.cooldownHelp', 'Délai minimal entre deux déclenchements sur le même ticket.')}
            </span>
          </label>
        </div>
      </Section>

      {/* ── the dry run ──────────────────────────────────────────────────── */}
      <section className="space-y-2.5 rounded-lg bg-bg-secondary/60 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-text-secondary">
            <FlaskConical size={13} />
            {t('rules.dryRunSection', 'Essai à blanc')}
          </h3>

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <label className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
              {t('rules.simulateTrigger', 'Déclencheur rejoué')}
              <select
                value={simulationTrigger}
                onChange={(event) => setSimulationTrigger(event.target.value as RuleTriggerKind)}
                className="h-8 appearance-none rounded-md bg-bg-tertiary px-2 pr-6 text-[12.5px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                {RULE_TRIGGERS.map((trigger) => (
                  <option key={trigger} value={trigger}>
                    {t(TRIGGER_LABELS[trigger].key, TRIGGER_LABELS[trigger].fr)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
              {t('rules.sampleSize', 'Tickets')}
              <input
                type="number"
                min={1}
                max={MAX_SAMPLE_SIZE}
                value={sampleSize}
                onChange={(event) =>
                  setSampleSize(Math.min(MAX_SAMPLE_SIZE, Math.max(1, Number(event.target.value) || 1)))
                }
                className="h-8 w-20 rounded-md bg-bg-tertiary px-2 font-mono text-[12.5px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              />
            </label>
            <Button
              size="sm"
              variant="primary"
              icon={<Play size={13} />}
              loading={simulating}
              disabled={!canSimulate}
              onClick={() => void simulate()}
            >
              {t('rules.runSimulation', 'Lancer')}
            </Button>
          </div>
        </div>

        <SimulationResult
          result={simulation}
          loading={simulating}
          error={simulationError}
          onOpenTicket={onOpenTicket}
        />
      </section>
    </div>
  );
}

export default RuleEditor;
