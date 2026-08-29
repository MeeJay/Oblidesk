/**
 * SimulationResult.tsx — what the rule WOULD have done, as a diff.
 *
 * ── Why this screen matters more than the editor above it ───────────────────
 * "Highly configurable" is only a benefit if changing configuration is safe,
 * and it is only safe if the preview is the real thing. The server replays the
 * tenant's own recent tickets through the SAME `runRules()` production calls,
 * with `dryRun` forced on, inside transactions that are always rolled back. So
 * what this table shows is not an estimate: it is the production executor's own
 * answer, with its writes thrown away.
 *
 * The table is therefore the point of the whole slice, and it is laid out as
 * one: ticket, field, before, after, and which action did it. Four columns and
 * an attribution — the shape somebody can actually read down before they press
 * publish.
 *
 * ── The caveats are shown, never tucked away ────────────────────────────────
 * A snapshot replay cannot answer a condition written with `changed` /
 * `changed_to` / `changed_from`: there is no "before" to compare against, so it
 * evaluates false and reports `no_previous_snapshot`. The server says so, and
 * this component prints it at the top rather than in a tooltip. A simulation
 * that quietly guesses is worse than one that admits its limits, because the
 * whole reason to run it is to be told what you do not know.
 *
 * ── "Nothing would happen" is a result ──────────────────────────────────────
 * Zero affected tickets renders as an explicit statement with the per-rule skip
 * reasons underneath, not as an empty table. "Why did it not fire on those 180?"
 * is the question people actually arrive with.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Info,
  ShieldAlert,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { SimulationResultData, SimulatedTicket } from '@/api/rules.api';

/** Skip reasons the engine emits, in French. Anything else prints raw. */
const SKIP_REASONS: Readonly<Record<string, { key: string; fr: string }>> = {
  circuit_open: { key: 'rules.skip.circuitOpen', fr: 'Coupe-circuit ouvert' },
  disabled: { key: 'rules.skip.disabled', fr: 'Règle désactivée' },
  wrong_trigger: { key: 'rules.skip.wrongTrigger', fr: 'Déclencheur différent' },
  no_watched_field_changed: { key: 'rules.skip.noWatchedField', fr: 'Aucun champ surveillé n’a changé' },
  already_ran_once: { key: 'rules.skip.alreadyRan', fr: 'Déjà exécutée une fois sur ce ticket' },
  cooldown: { key: 'rules.skip.cooldown', fr: 'Période de refroidissement' },
  no_match: { key: 'rules.skip.noMatch', fr: 'La condition n’a pas correspondu' },
  no_previous_snapshot: { key: 'rules.skip.noPrevious', fr: 'Pas d’état précédent à comparer' },
  budget_exhausted: { key: 'rules.skip.budget', fr: 'Budget d’actions épuisé' },
  loop_depth: { key: 'rules.skip.loopDepth', fr: 'Profondeur de ré-entrée atteinte' },
};

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (value === '') return '(vide)';
  if (typeof value === 'boolean') return value ? 'vrai' : 'faux';
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry)).join(', ');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[objet]';
    }
  }
  return String(value);
}

// ═════════════════════════════════════════════════════════════════════════════
// Stat tile
// ═════════════════════════════════════════════════════════════════════════════

function Stat({
  value,
  label,
  tone = 'neutral',
}: {
  value: string | number;
  label: string;
  tone?: 'neutral' | 'accent' | 'warn' | 'breach';
}): JSX.Element {
  const toneClass =
    tone === 'accent'
      ? 'text-accent'
      : tone === 'warn'
        ? 'text-sla-warn'
        : tone === 'breach'
          ? 'text-sla-breach'
          : 'text-text-primary';
  return (
    <div className="rounded-lg bg-bg-secondary px-3 py-2">
      <div className={cn('font-display text-[22px] font-semibold leading-none', toneClass)}>{value}</div>
      <div className="mt-1 text-[11px] leading-tight text-text-muted">{label}</div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The component
// ═════════════════════════════════════════════════════════════════════════════

export interface SimulationResultProps {
  result: SimulationResultData | null;
  loading?: boolean;
  error?: string | null;
  /** Deep-link a row to the ticket it would have changed. */
  onOpenTicket?: (ticketId: number) => void;
  className?: string;
}

export function SimulationResult({
  result,
  loading = false,
  error = null,
  onOpenTicket,
  className,
}: SimulationResultProps): JSX.Element {
  const { t } = useTranslation();
  const [ruleFilter, setRuleFilter] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!result) return [];
    const flat: Array<{ ticket: SimulatedTicket; change: SimulatedTicket['changes'][number] }> = [];
    for (const ticket of result.changes) {
      for (const change of ticket.changes) {
        if (ruleFilter && change.byRule !== ruleFilter) continue;
        flat.push({ ticket, change });
      }
    }
    return flat;
  }, [result, ruleFilter]);

  const failures = useMemo(
    () => (result?.changes ?? []).filter((ticket) => ticket.errors.length > 0),
    [result],
  );

  if (loading) {
    return (
      <div className={cn('flex min-h-[220px] flex-col items-center justify-center gap-3', className)}>
        <LoadingSpinner size="lg" />
        <p className="max-w-sm text-center text-[12.5px] text-text-muted">
          {t(
            'rules.simulating',
            'Rejeu des tickets réels à travers le moteur de production, une transaction annulée par ticket. Cela prend quelques secondes.',
          )}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('flex items-start gap-2 rounded-lg bg-sla-breach-bg px-3 py-3', className)}>
        <ShieldAlert size={16} className="mt-0.5 shrink-0 text-sla-breach" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-sla-breach">
            {t('rules.simulationFailed', 'La simulation n’a pas abouti')}
          </p>
          <p className="mt-0.5 text-[12px] text-text-secondary">{error}</p>
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className={cn('rounded-lg bg-bg-secondary px-3 py-6 text-center', className)}>
        <p className="text-[13px] text-text-secondary">
          {t('rules.notSimulatedYet', 'Aucune simulation lancée.')}
        </p>
        <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-text-muted">
          {t(
            'rules.simulateWhy',
            'La simulation rejoue vos derniers tickets réels à travers le moteur de production, sans rien écrire. C’est la seule façon honnête de savoir ce qu’une règle fera avant qu’elle ne le fasse.',
          )}
        </p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {/* ── the counts ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          value={result.ticketsExamined}
          label={t('rules.ticketsExamined', 'tickets rejoués')}
        />
        <Stat
          value={result.ticketsAffected}
          label={t('rules.ticketsAffected', 'tickets qui auraient changé')}
          tone={result.ticketsAffected > 0 ? 'accent' : 'neutral'}
        />
        <Stat
          value={rows.length}
          label={t('rules.changeCount', 'modifications de champ')}
        />
        <Stat
          value={failures.length}
          label={t('rules.ticketsWithErrors', 'tickets en erreur')}
          tone={failures.length > 0 ? 'breach' : 'neutral'}
        />
      </div>

      <p className="text-[11.5px] text-text-muted">
        {t(
          'rules.simulationFooter',
          'Déclencheur « {{trigger}} », échantillon de {{sample}} tickets, {{ms}} ms. Aucune écriture : chaque rejeu tourne dans une transaction annulée.',
          { trigger: result.trigger, sample: result.sampleSize, ms: result.durationMs },
        )}
      </p>

      {/* ── the honest limits ────────────────────────────────────────────── */}
      {result.caveats.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg bg-status-scheduled-bg px-3 py-2">
          <Info size={14} className="mt-0.5 shrink-0 text-status-scheduled" />
          <div className="min-w-0 space-y-0.5">
            <p className="text-[12px] font-medium text-status-scheduled">
              {t('rules.caveats', 'Ce qu’un rejeu instantané ne peut pas savoir')}
            </p>
            <ul className="space-y-0.5">
              {result.caveats.map((caveat) => (
                <li key={caveat} className="text-[12px] leading-snug text-text-secondary">
                  {caveat}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {result.guardrails.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg bg-sla-warn-bg px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-sla-warn" />
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-sla-warn">
              {t('rules.guardrailsHit', 'Garde-fous déclenchés pendant le rejeu')}
            </p>
            <ul className="mt-0.5 space-y-0.5">
              {result.guardrails.map((entry) => (
                <li key={entry} className="text-[12px] text-text-secondary">
                  {entry}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ── per rule ─────────────────────────────────────────────────────── */}
      <div className="overflow-x-auto rounded-lg bg-bg-secondary">
        <table className="w-full min-w-[640px] text-left text-[12.5px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-text-muted">
              <th className="px-3 py-2 font-medium">{t('rules.rule', 'Règle')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('rules.evaluated', 'Évaluée')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('rules.matched', 'Correspond')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('rules.performed', 'Actions')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('rules.errors', 'Erreurs')}</th>
              <th className="px-3 py-2 font-medium">{t('rules.whyNot', 'Pourquoi pas')}</th>
            </tr>
          </thead>
          <tbody>
            {result.byRule.map((summary) => {
              const active = ruleFilter === summary.slug;
              return (
                <tr
                  key={summary.slug}
                  onClick={() => setRuleFilter(active ? null : summary.slug)}
                  className={cn(
                    'cursor-pointer align-top transition-colors',
                    active ? 'bg-accent/10' : 'hover:bg-bg-hover',
                  )}
                >
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-text-primary">{summary.name || summary.slug}</span>
                      {summary.candidate && (
                        <span className="rounded-pill bg-accent/15 px-2 py-0.5 text-[10.5px] text-accent">
                          {t('rules.candidate', 'brouillon testé')}
                        </span>
                      )}
                      {!summary.enabled && (
                        <span className="rounded-pill bg-bg-tertiary px-2 py-0.5 text-[10.5px] text-text-muted">
                          {t('rules.disabled', 'désactivée')}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[11px] text-text-muted">{summary.slug}</span>
                    {summary.configIssues.length > 0 && (
                      <p className="mt-0.5 text-[11.5px] text-sla-warn">
                        {summary.configIssues[0].message}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-text-secondary">
                    {summary.evaluated}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right font-mono tabular-nums',
                      summary.matched > 0 ? 'text-accent' : 'text-text-muted',
                    )}
                  >
                    {summary.matched}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-text-secondary">
                    {summary.actionsPerformed}
                    {summary.actionsSkipped > 0 && (
                      <span className="text-text-muted"> (+{summary.actionsSkipped})</span>
                    )}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right font-mono tabular-nums',
                      summary.errors > 0 ? 'text-sla-breach' : 'text-text-muted',
                    )}
                  >
                    {summary.errors}
                  </td>
                  <td className="px-3 py-2 text-text-secondary">
                    {Object.entries(summary.skipReasons).length === 0 ? (
                      <span className="text-text-muted">—</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {Object.entries(summary.skipReasons)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 3)
                          .map(([reason, count]) => (
                            <li key={reason} className="text-[11.5px]">
                              {t(SKIP_REASONS[reason]?.key ?? reason, SKIP_REASONS[reason]?.fr ?? reason)}
                              <span className="ml-1 font-mono text-text-muted">×{count}</span>
                            </li>
                          ))}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── THE diff ─────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-[12px] font-medium uppercase tracking-wide text-text-muted">
            {t('rules.diffTitle', 'Ce qui aurait changé')}
          </h4>
          {ruleFilter && (
            <button
              type="button"
              onClick={() => setRuleFilter(null)}
              className="text-[12px] text-accent hover:underline"
            >
              {t('rules.clearRuleFilter', 'Voir toutes les règles')}
            </button>
          )}
        </div>

        {rows.length === 0 ? (
          <div className="flex items-start gap-2 rounded-lg bg-bg-secondary px-3 py-3">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-sla-ok" />
            <div>
              <p className="text-[13px] text-text-primary">
                {t('rules.noChanges', 'Aucun ticket n’aurait été modifié.')}
              </p>
              <p className="mt-0.5 text-[12px] text-text-muted">
                {t(
                  'rules.noChangesHelp',
                  'C’est un résultat, pas une erreur : la colonne « Pourquoi pas » ci-dessus dit pour quelle raison chaque règle est restée silencieuse.',
                )}
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg bg-bg-secondary">
            <table className="w-full min-w-[760px] text-left text-[12.5px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-text-muted">
                  <th className="px-3 py-2 font-medium">{t('rules.ticket', 'Ticket')}</th>
                  <th className="px-3 py-2 font-medium">{t('rules.field', 'Champ')}</th>
                  <th className="px-3 py-2 font-medium">{t('rules.before', 'Avant')}</th>
                  <th className="px-3 py-2 font-medium">{t('rules.after', 'Après')}</th>
                  <th className="px-3 py-2 font-medium">{t('rules.byWhat', 'Par')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ ticket, change }, index) => (
                  <tr
                    key={`${ticket.ticketId}-${change.field}-${change.byRule}-${index}`}
                    className="align-top transition-colors hover:bg-bg-hover"
                  >
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        disabled={!onOpenTicket}
                        onClick={() => onOpenTicket?.(ticket.ticketId)}
                        className="flex items-center gap-1 font-mono text-[12px] text-accent hover:underline disabled:text-text-secondary disabled:no-underline"
                      >
                        {ticket.number}
                        {onOpenTicket && <ExternalLink size={11} />}
                      </button>
                      <span className="mt-0.5 block max-w-[240px] truncate text-[11.5px] text-text-muted">
                        {ticket.subject}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[12px] text-text-secondary">{change.field}</td>
                    <td className="px-3 py-2 text-text-muted">
                      <span className="line-through decoration-text-muted/50">{formatValue(change.from)}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1 text-text-primary">
                        <ArrowRight size={11} className="text-accent" />
                        {formatValue(change.to)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="block font-mono text-[11.5px] text-text-secondary">{change.byRule}</span>
                      <span className="block text-[11px] text-text-muted">{change.byAction}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── failures, in full ────────────────────────────────────────────── */}
      {failures.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-[12px] font-medium uppercase tracking-wide text-sla-breach">
            {t('rules.simulationErrors', 'Erreurs rencontrées pendant le rejeu')}
          </h4>
          <ul className="space-y-1">
            {failures.map((ticket) => (
              <li key={ticket.ticketId} className="rounded-lg bg-sla-breach-bg px-3 py-2">
                <span className="font-mono text-[12px] text-sla-breach">{ticket.number}</span>
                <ul className="mt-0.5 space-y-0.5">
                  {ticket.errors.map((message, index) => (
                    <li key={index} className="text-[12px] text-text-secondary">
                      {message}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.executionsRecorded > 0 && (
        <p className="text-[11px] text-text-muted">
          {t(
            'rules.executionsRecorded',
            '{{count}} lignes de simulation écrites dans le journal d’exécution : une décision qu’il faut défendre plus tard est une décision qu’on peut montrer.',
            { count: result.executionsRecorded },
          )}
        </p>
      )}
    </div>
  );
}

export default SimulationResult;
