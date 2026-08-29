/**
 * ExecutionLog.tsx — the record of what the engine actually did, and did not do.
 *
 * ── The question `decision_log` structurally cannot answer ──────────────────
 * `decision_log` explains why something HAPPENED. It cannot explain why nothing
 * happened, because a rule that was evaluated and did not match took no action
 * to record. `rule_executions` is the other half: one row per rule per event,
 * matched or not, with the condition trace, every action's outcome, the errors
 * and the duration. This component is that table, filterable the two ways
 * people actually arrive — "this rule" and "this ticket".
 *
 * ── Simulations are excluded by default ─────────────────────────────────────
 * A dry run is what WOULD have happened. Mixing it into the record of what DID
 * would make the log useless as evidence, which is the one job it has. The
 * filter exists, it is off, and it says what it does when it is on.
 *
 * ── Every row leads somewhere ───────────────────────────────────────────────
 * A log row that cannot be followed is a receipt for an argument nobody can
 * finish. Each one opens its ticket, and opens the Why drawer on that ticket —
 * the same drawer the agent uses — so the person auditing a rule and the person
 * defending a ticket are reading the same evidence.
 *
 * HARD RULE 11 — rows are background steps; the expanded panel is a deeper one.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  ExternalLink,
  HelpCircle,
  RefreshCw,
  ShieldAlert,
  Zap,
} from 'lucide-react';
import { describeTrace } from '@oblidesk/shared';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import WhyDrawer from '@/components/tickets/WhyDrawer';
import { formatDateTime, formatRelative } from '@/utils/format';
import { cn } from '@/utils/cn';
import { errorMessage } from '@/api/client';
import {
  rulesApi,
  type ExecutionEntry,
  type ExecutionRow,
  type RuleSummary,
} from '@/api/rules.api';
import { useFieldCatalogue } from './ConditionBuilder';

const CONTROL =
  'h-8 rounded-md bg-bg-tertiary px-2 text-[12.5px] text-text-primary outline-none '
  + 'focus-visible:ring-2 focus-visible:ring-accent/60';

const PAGE_SIZE = 50;

/**
 * Why the evaluator could not answer a clause, in French.
 *
 * `no_previous_snapshot` is the one that matters most: a `changed` condition
 * evaluated without a "before" is not false because the value stayed the same,
 * it is false because there was nothing to compare — and those are different
 * bugs to go and fix.
 */
const ISSUE_REASONS: Readonly<Record<string, { key: string; fr: string }>> = {
  unknown_field: { key: 'conditions.issue.unknownField', fr: 'champ inconnu du serveur' },
  no_previous_snapshot: { key: 'conditions.issue.noPrevious', fr: 'pas d’état précédent à comparer' },
  missing_value: { key: 'conditions.issue.missingValue', fr: 'valeur de comparaison absente' },
  bad_value: { key: 'conditions.issue.badValue', fr: 'valeur de comparaison invalide' },
  bad_duration: { key: 'conditions.issue.badDuration', fr: 'durée illisible' },
  bad_regex: { key: 'conditions.issue.badRegex', fr: 'expression régulière invalide' },
  not_comparable: { key: 'conditions.issue.notComparable', fr: 'valeurs non comparables' },
  unknown_operator: { key: 'conditions.issue.unknownOperator', fr: 'opérateur inconnu' },
  malformed_node: { key: 'conditions.issue.malformed', fr: 'nœud de condition malformé' },
};

// ═════════════════════════════════════════════════════════════════════════════
// One expanded row
// ═════════════════════════════════════════════════════════════════════════════

function EntryDetail({
  entry,
  fieldLabel,
}: {
  entry: ExecutionEntry;
  fieldLabel: (field: string) => string;
}): JSX.Element {
  const { t } = useTranslation();

  if (entry.entry === 'evaluation') {
    const lines = entry.trace ? describeTrace(entry.trace, { fieldLabel }) : [];
    return (
      <div className="space-y-1">
        <p
          className={cn(
            'text-[12px] font-medium',
            entry.matched ? 'text-sla-ok' : 'text-text-secondary',
          )}
        >
          {entry.matched
            ? t('rules.log.matched', 'La condition a correspondu')
            : t('rules.log.notMatched', 'La condition n’a pas correspondu')}
        </p>
        {entry.summary && <p className="text-[12px] text-text-secondary">{entry.summary}</p>}
        {lines.length > 0 && (
          <pre className="overflow-x-auto rounded-md bg-bg-primary/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-text-secondary">
            {lines.join('\n')}
          </pre>
        )}
        {entry.issues.length > 0 && (
          <ul className="space-y-0.5">
            {entry.issues.map((issue, index) => (
              <li key={index} className="text-[11.5px] text-sla-warn">
                {issue.field ? `${fieldLabel(issue.field)} : ` : ''}
                {t(ISSUE_REASONS[issue.reason]?.key ?? issue.reason, ISSUE_REASONS[issue.reason]?.fr ?? issue.reason)}
                {issue.detail ? ` (${issue.detail})` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (entry.entry === 'action') {
    const tone = entry.error
      ? 'text-sla-breach'
      : entry.performed
        ? 'text-sla-ok'
        : 'text-text-muted';
    return (
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[11.5px] text-text-muted">#{entry.index + 1}</span>
        <span className="font-mono text-[12px] text-text-secondary">{entry.kind}</span>
        <span className={cn('text-[12px]', tone)}>
          {entry.error
            ? entry.error
            : entry.performed
              ? t('rules.log.performed', 'effectuée')
              : entry.skipped ?? t('rules.log.skipped', 'ignorée')}
        </span>
        <span className="ml-auto font-mono text-[11px] text-text-muted">{entry.durationMs} ms</span>
      </div>
    );
  }

  if (entry.entry === 'guardrail') {
    return (
      <div className="flex items-start gap-1.5 text-[12px] text-sla-warn">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <span>
          <span className="font-mono">{entry.code}</span> : {entry.message}
        </span>
      </div>
    );
  }

  return (
    <ul className="space-y-0.5">
      {entry.issues.map((issue, index) => (
        <li key={index} className="text-[12px] text-sla-warn">
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

function LogRow({
  row,
  fieldLabel,
  onOpenTicket,
  onOpenWhy,
}: {
  row: ExecutionRow;
  fieldLabel: (field: string) => string;
  onOpenTicket?: (ticketId: number) => void;
  onOpenWhy: (ticketId: number) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const actions = row.entries.filter((entry) => entry.entry === 'action');
  const performed = actions.filter((entry) => entry.entry === 'action' && entry.performed).length;

  return (
    <li className="rounded-lg bg-bg-secondary">
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown size={13} className="shrink-0 text-text-muted" />
          ) : (
            <ChevronRight size={13} className="shrink-0 text-text-muted" />
          )}

          <span
            className={cn(
              'inline-flex h-5 shrink-0 items-center gap-1 rounded-pill px-2 text-[10.5px] font-medium',
              row.error
                ? 'bg-sla-breach-bg text-sla-breach'
                : row.matched
                  ? 'bg-sla-ok-bg text-sla-ok'
                  : 'bg-bg-tertiary text-text-muted',
            )}
          >
            {row.error ? (
              <ShieldAlert size={9} />
            ) : row.matched ? (
              <Zap size={9} />
            ) : (
              <CircleSlash size={9} />
            )}
            {row.error
              ? t('rules.log.error', 'erreur')
              : row.matched
                ? t('rules.log.match', 'correspond')
                : t('rules.log.noMatch', 'sans effet')}
          </span>

          <span className="truncate font-mono text-[12.5px] text-text-primary">{row.ruleSlug}</span>
          <span className="shrink-0 font-mono text-[11px] text-text-muted">v{row.ruleVersion}</span>

          {row.dryRun && (
            <span className="shrink-0 rounded-pill bg-status-scheduled-bg px-2 py-0.5 text-[10px] text-status-scheduled">
              {t('rules.log.dryRun', 'simulation')}
            </span>
          )}

          {actions.length > 0 && (
            <span className="shrink-0 text-[11.5px] text-text-muted">
              {t('rules.log.actionSummary', '{{performed}}/{{total}} actions', {
                performed,
                total: actions.length,
              })}
            </span>
          )}
        </button>

        <span
          className="shrink-0 font-mono text-[11px] text-text-muted"
          title={formatDateTime(row.at)}
        >
          {formatRelative(row.at)}
        </span>
        {row.durationMs !== null && (
          <span className="shrink-0 font-mono text-[11px] text-text-muted">{row.durationMs} ms</span>
        )}

        {row.ticketId !== null && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => onOpenWhy(row.ticketId as number)}
              title={t('rules.log.openWhy', 'Ouvrir « pourquoi ce ticket est-il comme ça ? »')}
              aria-label={t('rules.log.openWhy', 'Ouvrir « pourquoi ce ticket est-il comme ça ? »')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-accent"
            >
              <HelpCircle size={13} />
            </button>
            {onOpenTicket && (
              <button
                type="button"
                onClick={() => onOpenTicket(row.ticketId as number)}
                title={t('rules.log.openTicket', 'Ouvrir le ticket')}
                aria-label={t('rules.log.openTicket', 'Ouvrir le ticket')}
                className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-accent"
              >
                <ExternalLink size={13} />
              </button>
            )}
          </div>
        )}
      </div>

      {open && (
        <div className="space-y-2 rounded-b-lg bg-bg-tertiary/50 px-3 py-2.5">
          {row.error && (
            <p className="rounded-md bg-sla-breach-bg px-2 py-1.5 text-[12px] text-sla-breach">{row.error}</p>
          )}
          {row.entries.length === 0 ? (
            <p className="text-[12px] text-text-muted">
              {t('rules.log.noEntries', 'Aucun détail enregistré pour cette exécution.')}
            </p>
          ) : (
            row.entries.map((entry, index) => (
              <EntryDetail key={index} entry={entry} fieldLabel={fieldLabel} />
            ))
          )}
        </div>
      )}
    </li>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The log
// ═════════════════════════════════════════════════════════════════════════════

export interface ExecutionLogProps {
  /** Feeds the rule filter. Pass the same list the ordered screen shows. */
  rules?: RuleSummary[];
  initialRuleSlug?: string | null;
  initialTicketId?: number | null;
  onOpenTicket?: (ticketId: number) => void;
  className?: string;
}

export function ExecutionLog({
  rules = [],
  initialRuleSlug = null,
  initialTicketId = null,
  onOpenTicket,
  className,
}: ExecutionLogProps): JSX.Element {
  const { t } = useTranslation();
  const { catalogue } = useFieldCatalogue();

  const [ruleSlug, setRuleSlug] = useState<string>(initialRuleSlug ?? '');
  const [ticketInput, setTicketInput] = useState<string>(initialTicketId ? String(initialTicketId) : '');
  const [matched, setMatched] = useState<'all' | 'yes' | 'no'>('all');
  const [errorsOnly, setErrorsOnly] = useState(false);
  /**
   * Real runs or simulations — never both.
   *
   * The route substitutes `dryRun: false` whenever the parameter is absent, so
   * "both at once" is not a question this endpoint can answer. Offering a
   * control for it would be offering a lie.
   */
  const [showDryRun, setShowDryRun] = useState(false);
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<ExecutionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [whyTicketId, setWhyTicketId] = useState<number | null>(null);

  useEffect(() => setRuleSlug(initialRuleSlug ?? ''), [initialRuleSlug]);

  const ticketId = useMemo(() => {
    const parsed = Number(ticketInput.trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }, [ticketInput]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await rulesApi.executions({
        ruleSlug: ruleSlug || undefined,
        ticketId,
        matched: matched === 'all' ? undefined : matched === 'yes',
        errorsOnly: errorsOnly || undefined,
        dryRun: showDryRun,
        page,
        limit: PAGE_SIZE,
      });
      setRows(result.rows);
      setTotal(result.total);
    } catch (err) {
      setError(errorMessage(err));
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [ruleSlug, ticketId, matched, errorsOnly, showDryRun, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any filter change puts the reader back on page one; staying on page 7 of a
  // list that now has two pages shows an empty screen that looks like a bug.
  useEffect(() => {
    setPage(1);
  }, [ruleSlug, ticketId, matched, errorsOnly, showDryRun]);

  const fieldLabel = useCallback(
    (field: string) => catalogue?.byPath.get(field)?.label ?? field,
    [catalogue],
  );

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className={cn('space-y-2.5', className)}>
      {/* ── filters ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={ruleSlug}
          onChange={(event) => setRuleSlug(event.target.value)}
          className={cn(CONTROL, 'min-w-[190px] appearance-none pr-6')}
          aria-label={t('rules.log.filterRule', 'Filtrer par règle')}
        >
          <option value="">{t('rules.log.allRules', 'Toutes les règles')}</option>
          {rules.map((rule) => (
            <option key={rule.slug} value={rule.slug}>
              {rule.name || rule.slug}
            </option>
          ))}
        </select>

        <input
          type="text"
          inputMode="numeric"
          value={ticketInput}
          onChange={(event) => setTicketInput(event.target.value)}
          placeholder={t('rules.log.filterTicket', 'N° interne du ticket')}
          className={cn(CONTROL, 'w-[170px] font-mono')}
          aria-label={t('rules.log.filterTicket', 'N° interne du ticket')}
        />

        <div className="flex overflow-hidden rounded-md bg-bg-tertiary" role="group">
          {(
            [
              ['all', t('rules.log.any', 'Tout')],
              ['yes', t('rules.log.match', 'Correspond')],
              ['no', t('rules.log.noMatch', 'Sans effet')],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={matched === value}
              onClick={() => setMatched(value)}
              className={cn(
                'h-8 px-2.5 text-[12px] transition-colors',
                matched === value ? 'bg-accent text-bg-primary' : 'text-text-secondary hover:bg-bg-hover',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          aria-pressed={errorsOnly}
          onClick={() => setErrorsOnly((current) => !current)}
          className={cn(
            'h-8 rounded-md px-2.5 text-[12px] transition-colors',
            errorsOnly ? 'bg-sla-breach-bg text-sla-breach' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
          )}
        >
          {t('rules.log.errorsOnly', 'Erreurs seulement')}
        </button>

        {/* Real runs and simulations are two different records, and the log is
            evidence of the first. They are shown one at a time, deliberately. */}
        <div
          className="flex overflow-hidden rounded-md bg-bg-tertiary"
          role="group"
          title={t(
            'rules.log.dryRunHelp',
            'Les simulations décrivent ce qui SERAIT arrivé. Ce journal est la preuve de ce que le bureau a fait : les deux ne se mélangent pas.',
          )}
        >
          {(
            [
              [false, t('rules.log.realRuns', 'Exécutions réelles')],
              [true, t('rules.log.simulations', 'Simulations')],
            ] as const
          ).map(([value, label]) => (
            <button
              key={String(value)}
              type="button"
              aria-pressed={showDryRun === value}
              onClick={() => setShowDryRun(value)}
              className={cn(
                'h-8 px-2.5 text-[12px] transition-colors',
                showDryRun === value
                  ? value
                    ? 'bg-status-scheduled text-bg-primary'
                    : 'bg-accent text-bg-primary'
                  : 'text-text-secondary hover:bg-bg-hover',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={13} />}
          onClick={() => void load()}
          className="ml-auto"
        >
          {t('common.refresh', 'Actualiser')}
        </Button>
      </div>

      {/* ── the rows ─────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex min-h-[160px] items-center justify-center">
          <LoadingSpinner size="md" />
        </div>
      ) : error ? (
        <div className="rounded-lg bg-sla-breach-bg px-3 py-2.5 text-[12.5px] text-sla-breach">{error}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          icon={<CircleSlash size={20} />}
          title={t('rules.log.emptyTitle', 'Aucune exécution enregistrée')}
          description={t(
            'rules.log.emptyDesc',
            'Le moteur écrit une ligne par règle et par événement, qu’elle corresponde ou non. Rien ici signifie qu’aucun événement n’a encore atteint ces règles avec ces filtres.',
          )}
        />
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => (
            <LogRow
              key={row.id}
              row={row}
              fieldLabel={fieldLabel}
              onOpenTicket={onOpenTicket}
              onOpenWhy={setWhyTicketId}
            />
          ))}
        </ul>
      )}

      {/* ── pagination ───────────────────────────────────────────────────── */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-[12px] text-text-muted">
          <span>
            {t('rules.log.pageOf', 'Page {{page}} sur {{pages}} ({{total}} exécutions)', {
              page,
              pages: pageCount,
              total,
            })}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="secondary"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              {t('common.previous', 'Précédent')}
            </Button>
            <Button
              size="xs"
              variant="secondary"
              disabled={page >= pageCount}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
            >
              {t('common.next', 'Suivant')}
            </Button>
          </div>
        </div>
      )}

      {/* The agent's drawer, not a second rendering of the same evidence. */}
      {whyTicketId !== null && (
        <WhyDrawer ticketId={whyTicketId} open onClose={() => setWhyTicketId(null)} />
      )}
    </div>
  );
}

export default ExecutionLog;
