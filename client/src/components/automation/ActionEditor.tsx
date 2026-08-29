/**
 * ActionEditor.tsx — the ordered list of things a rule does.
 *
 * ── The catalogue is fetched, never copied ──────────────────────────────────
 * Every control on this screen is rendered from `GET /api/rules/actions`: the
 * action kinds, their groups, their parameter names, types, enum values,
 * required-ness, help text and their cost against the per-ticket action budget.
 * There is no list of actions in this file. A closed catalogue is only closed
 * if there is exactly one copy of it; two copies is an open catalogue with
 * extra steps, and the day they disagree a rule reports success and does
 * nothing.
 *
 * ── Order matters here too ──────────────────────────────────────────────────
 * Actions run in the order shown. `set_priority` before `assign_to_group` is
 * not the same rule as the reverse when the group is chosen by priority. So the
 * list is explicitly ordered with move controls rather than being a bag.
 *
 * ── Disabled ≠ deleted ──────────────────────────────────────────────────────
 * An action can be switched off and kept. That is what somebody tuning a rule
 * actually wants — the alternative is deleting a carefully written template and
 * retyping it twenty minutes later.
 *
 * ── Two flags worth showing on a row ────────────────────────────────────────
 *   • `reentrant` — this action calls back into the engine, so it is the one
 *     the loop-depth guard exists for. Someone building a rule that assigns and
 *     transitions should be able to see which half can re-enter.
 *   • `budgetCost` — actions are charged against a per-ticket, per-event
 *     budget. A rule whose actions cost more than the budget will be cut off
 *     part-way through, and that is much better known before it happens.
 *
 * HARD RULE 11 — action cards are a background step, never an outline.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowUp,
  Ban,
  ChevronDown,
  CircleDot,
  Plus,
  Repeat,
  Trash2,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import {
  newActionUid,
  type ActionParamSpec,
  type DraftAction,
  type RuleActionDefinition,
  type RuleGuardrails,
} from '@/api/rules.api';

const CONTROL =
  'w-full rounded-md bg-bg-tertiary px-2 py-1.5 text-[13px] text-text-primary outline-none '
  + 'focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50';

const GROUP_LABELS: Readonly<Record<string, { key: string; fr: string }>> = {
  ticket: { key: 'rules.actionGroup.ticket', fr: 'Le ticket' },
  routing: { key: 'rules.actionGroup.routing', fr: 'Acheminement' },
  people: { key: 'rules.actionGroup.people', fr: 'Personnes et étiquettes' },
  timeline: { key: 'rules.actionGroup.timeline', fr: 'Journal' },
  engine: { key: 'rules.actionGroup.engine', fr: 'Autres moteurs' },
  relation: { key: 'rules.actionGroup.relation', fr: 'Autres tickets' },
  external: { key: 'rules.actionGroup.external', fr: 'Hors du bureau' },
};

// ═════════════════════════════════════════════════════════════════════════════
// One parameter
// ═════════════════════════════════════════════════════════════════════════════

interface ParamFieldProps {
  spec: ActionParamSpec;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}

function ParamField({ spec, value, disabled, onChange }: ParamFieldProps): JSX.Element {
  const { t } = useTranslation();
  const label = t(spec.labelKey, spec.label.fr);
  const help = spec.help.fr;

  const asText = typeof value === 'string' || typeof value === 'number' ? String(value) : '';

  let control: JSX.Element;

  switch (spec.type) {
    case 'boolean':
      control = (
        <select
          disabled={disabled}
          value={value === true ? 'true' : value === false ? 'false' : ''}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}
          className={cn(CONTROL, 'appearance-none')}
        >
          <option value="">{t('common.unset', 'Non défini')}</option>
          <option value="true">{t('common.yes', 'Oui')}</option>
          <option value="false">{t('common.no', 'Non')}</option>
        </select>
      );
      break;

    case 'enum':
      control = (
        <select
          disabled={disabled}
          value={asText}
          onChange={(event) => onChange(event.target.value || undefined)}
          className={cn(CONTROL, 'appearance-none')}
        >
          <option value="">{t('common.unset', 'Non défini')}</option>
          {(spec.enumValues ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
      break;

    case 'number':
    case 'minutes':
      control = (
        <input
          type="number"
          disabled={disabled}
          value={asText}
          onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
          className={cn(CONTROL, 'font-mono')}
        />
      );
      break;

    case 'text':
    case 'template':
      control = (
        <textarea
          disabled={disabled}
          rows={spec.type === 'template' ? 3 : 4}
          value={asText}
          onChange={(event) => onChange(event.target.value)}
          className={cn(CONTROL, 'resize-y leading-relaxed')}
          placeholder={
            spec.type === 'template'
              ? t('rules.templatePlaceholder', 'Texte, avec des variables comme {{ticket.number}}')
              : undefined
          }
        />
      );
      break;

    case 'string_list':
      control = (
        <input
          type="text"
          disabled={disabled}
          value={Array.isArray(value) ? value.map(String).join(', ') : asText}
          onChange={(event) =>
            onChange(
              event.target.value
                .split(',')
                .map((entry) => entry.trim())
                .filter((entry) => entry !== ''),
            )
          }
          placeholder={t('rules.listPlaceholder', 'valeur1, valeur2…')}
          className={CONTROL}
        />
      );
      break;

    case 'map':
    case 'json':
      control = (
        <textarea
          disabled={disabled}
          rows={4}
          defaultValue={value === undefined ? '' : JSON.stringify(value, null, 2)}
          onBlur={(event) => {
            const raw = event.target.value.trim();
            if (raw === '') {
              onChange(undefined);
              return;
            }
            try {
              onChange(JSON.parse(raw));
            } catch {
              // Keep what was typed rather than silently discarding it: the
              // linter will refuse the publish and say where.
              onChange(raw);
            }
          }}
          className={cn(CONTROL, 'resize-y font-mono text-[12px]')}
          placeholder={'{\n  "cle": "valeur"\n}'}
        />
      );
      break;

    default:
      control = (
        <input
          type="text"
          disabled={disabled}
          value={asText}
          onChange={(event) => onChange(event.target.value)}
          className={cn(CONTROL, spec.type === 'slug' || spec.type === 'username' ? 'font-mono' : undefined)}
          placeholder={
            spec.referenceKind
              ? t('rules.slugPlaceholder', 'identifiant (slug) de « {{kind}} »', { kind: spec.referenceKind })
              : undefined
          }
        />
      );
  }

  const missing = spec.required && (value === undefined || value === null || value === '');

  return (
    <label className="block space-y-1">
      <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-text-secondary">
        {label}
        {spec.required && (
          <span
            className={cn('text-[10px]', missing ? 'text-sla-warn' : 'text-text-muted')}
            title={t('rules.paramRequired', 'Paramètre obligatoire : la publication sera refusée sans lui.')}
          >
            ●
          </span>
        )}
      </span>
      {control}
      {help && <span className="block text-[11px] leading-snug text-text-muted">{help}</span>}
    </label>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// One action
// ═════════════════════════════════════════════════════════════════════════════

interface ActionCardProps {
  action: DraftAction;
  definition: RuleActionDefinition | undefined;
  index: number;
  total: number;
  disabled: boolean;
  onChange: (next: DraftAction) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}

function ActionCard({
  action,
  definition,
  index,
  total,
  disabled,
  onChange,
  onRemove,
  onMove,
}: ActionCardProps): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);

  return (
    <li
      className={cn(
        'rounded-lg bg-bg-secondary px-2.5 py-2',
        action.disabled && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="w-5 shrink-0 text-center font-mono text-[12px] text-text-muted">{index + 1}</span>

        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            size={13}
            className={cn('shrink-0 text-text-muted transition-transform', !open && '-rotate-90')}
          />
          <span className="truncate text-[13px] font-medium text-text-primary">
            {definition ? t(definition.labelKey, definition.label.fr) : action.kind}
          </span>
          {!definition && (
            <span className="rounded-pill bg-sla-breach-bg px-2 py-0.5 text-[10.5px] text-sla-breach">
              {t('rules.unknownAction', 'hors catalogue')}
            </span>
          )}
          {definition?.reentrant && (
            <span
              className="inline-flex items-center gap-1 rounded-pill bg-status-scheduled-bg px-1.5 py-0.5 text-[10px] text-status-scheduled"
              title={t(
                'rules.reentrantHelp',
                'Cette action peut relancer le moteur de règles : elle compte dans la garde de profondeur.',
              )}
            >
              <Repeat size={9} />
              {t('rules.reentrant', 're-entrante')}
            </span>
          )}
          {definition && definition.budgetCost > 1 && (
            <span
              className="rounded-pill bg-bg-tertiary px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
              title={t('rules.budgetHelp', 'Coût dans le budget d’actions par ticket.')}
            >
              ×{definition.budgetCost}
            </span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            disabled={disabled || index === 0}
            onClick={() => onMove(-1)}
            aria-label={t('rules.moveUp', 'Monter')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-30"
          >
            <ArrowUp size={13} />
          </button>
          <button
            type="button"
            disabled={disabled || index === total - 1}
            onClick={() => onMove(1)}
            aria-label={t('rules.moveDown', 'Descendre')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-30"
          >
            <ArrowDown size={13} />
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...action, disabled: !action.disabled })}
            aria-pressed={action.disabled}
            title={
              action.disabled
                ? t('rules.enableAction', 'Réactiver cette action')
                : t('rules.disableAction', 'Désactiver sans supprimer')
            }
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-bg-hover',
              action.disabled ? 'text-sla-warn' : 'text-text-muted hover:text-text-primary',
            )}
          >
            {action.disabled ? <Ban size={13} /> : <CircleDot size={13} />}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onRemove}
            aria-label={t('rules.removeAction', 'Supprimer cette action')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-priority-p1"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-2 space-y-2 pl-7">
          {definition?.summary.fr && (
            <p className="text-[11.5px] leading-snug text-text-muted">{definition.summary.fr}</p>
          )}
          {definition ? (
            definition.params.length === 0 ? (
              <p className="text-[12px] text-text-muted">
                {t('rules.noParams', 'Cette action ne prend aucun paramètre.')}
              </p>
            ) : (
              <div className="grid gap-2.5 sm:grid-cols-2">
                {definition.params.map((spec) => (
                  <ParamField
                    key={spec.name}
                    spec={spec}
                    value={action.params[spec.name]}
                    disabled={disabled}
                    onChange={(next) => {
                      const params = { ...action.params };
                      if (next === undefined) delete params[spec.name];
                      else params[spec.name] = next;
                      onChange({ ...action, params });
                    }}
                  />
                ))}
              </div>
            )
          ) : (
            <div className="space-y-1">
              <p className="text-[12px] text-sla-breach">
                {t(
                  'rules.unknownActionHelp',
                  'Le moteur ne connaît pas ce type d’action : la règle échouera à la publication. Le contenu est conservé tel quel.',
                )}
              </p>
              <pre className="overflow-x-auto rounded-md bg-bg-tertiary px-2 py-1.5 font-mono text-[11px] text-text-secondary">
                {JSON.stringify(action.params, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The editor
// ═════════════════════════════════════════════════════════════════════════════

export interface ActionEditorProps {
  actions: DraftAction[];
  catalogue: RuleActionDefinition[];
  guardrails?: RuleGuardrails | null;
  disabled?: boolean;
  onChange: (next: DraftAction[]) => void;
}

export function ActionEditor({
  actions,
  catalogue,
  guardrails,
  disabled = false,
  onChange,
}: ActionEditorProps): JSX.Element {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);

  const byKind = useMemo(
    () => new Map(catalogue.map((definition) => [definition.kind, definition])),
    [catalogue],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, RuleActionDefinition[]>();
    for (const definition of catalogue) {
      const list = groups.get(definition.group) ?? [];
      list.push(definition);
      groups.set(definition.group, list);
    }
    return [...groups.entries()];
  }, [catalogue]);

  const budgetSpend = useMemo(
    () =>
      actions
        .filter((action) => !action.disabled)
        .reduce((total, action) => total + (byKind.get(action.kind)?.budgetCost ?? 1), 0),
    [actions, byKind],
  );

  const overBudget = guardrails ? budgetSpend > guardrails.actionBudget : false;

  function add(kind: string) {
    const definition = byKind.get(kind);
    const params: Record<string, unknown> = {};
    for (const spec of definition?.params ?? []) {
      if (spec.defaultValue !== undefined) params[spec.name] = spec.defaultValue;
    }
    onChange([...actions, { uid: newActionUid(), kind, params, disabled: false }]);
    setPicking(false);
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= actions.length) return;
    const next = [...actions];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onChange(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] font-medium uppercase tracking-wide text-text-muted">
          {t('rules.actions', 'Actions, dans l’ordre')}
        </span>
        {guardrails && (
          <span className={cn('text-[11.5px]', overBudget ? 'text-sla-breach' : 'text-text-muted')}>
            {t('rules.budgetUsed', '{{spend}} / {{budget}} du budget d’actions', {
              spend: budgetSpend,
              budget: guardrails.actionBudget,
            })}
          </span>
        )}
      </div>

      {actions.length === 0 ? (
        <p className="rounded-lg bg-bg-secondary px-3 py-3 text-[12.5px] text-text-muted">
          {t(
            'rules.noActionsYet',
            'Aucune action : la règle peut correspondre, mais elle ne fera rien. Ajoutez au moins une action.',
          )}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {actions.map((action, index) => (
            <ActionCard
              key={action.uid}
              action={action}
              definition={byKind.get(action.kind)}
              index={index}
              total={actions.length}
              disabled={disabled}
              onChange={(next) => onChange(actions.map((entry) => (entry.uid === action.uid ? next : entry)))}
              onRemove={() => onChange(actions.filter((entry) => entry.uid !== action.uid))}
              onMove={(delta) => move(index, delta)}
            />
          ))}
        </ul>
      )}

      {overBudget && guardrails && (
        <p className="rounded-md bg-sla-breach-bg px-2.5 py-2 text-[12px] text-sla-breach">
          {t(
            'rules.overBudget',
            'Ces actions dépassent le budget par ticket ({{budget}}) : le moteur interrompra la règle en cours de route.',
            { budget: guardrails.actionBudget },
          )}
        </p>
      )}

      {picking ? (
        <div className="space-y-2 rounded-lg bg-bg-secondary p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-text-primary">
              {t('rules.pickAction', 'Choisir une action')}
            </span>
            <button
              type="button"
              onClick={() => setPicking(false)}
              className="text-[12px] text-text-muted hover:text-text-primary"
            >
              {t('common.cancel', 'Annuler')}
            </button>
          </div>
          {grouped.map(([group, definitions]) => (
            <div key={group} className="space-y-1">
              <span className="text-[11px] uppercase tracking-wide text-text-muted">
                {t(GROUP_LABELS[group]?.key ?? group, GROUP_LABELS[group]?.fr ?? group)}
              </span>
              <div className="flex flex-wrap gap-1">
                {definitions.map((definition) => (
                  <button
                    key={definition.kind}
                    type="button"
                    onClick={() => add(definition.kind)}
                    title={definition.summary.fr}
                    className="rounded-md bg-bg-tertiary px-2.5 py-1.5 text-left text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                  >
                    {t(definition.labelKey, definition.label.fr)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled || catalogue.length === 0}
          onClick={() => setPicking(true)}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-bg-secondary text-[13px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
        >
          <Plus size={14} />
          {t('rules.addAction', 'Ajouter une action')}
        </button>
      )}
    </div>
  );
}

export default ActionEditor;
