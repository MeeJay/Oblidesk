/**
 * SlaLedgerView.tsx — the explainer you put in front of a customer.
 *
 * ── Why this is worth more than a dashboard ─────────────────────────────────
 * A dashboard says a number. This says WHERE THE NUMBER CAME FROM, in bands
 * across a timeline, each labelled with its reason and its duration: worked,
 * paused, out of hours. When somebody argues that a P1 "took three days", this
 * is the picture that answers them — "you were not charged for the weekend, and
 * here is the weekend; you were not charged for the eighteen hours we waited on
 * your answer, and here is the message that ended the wait".
 *
 * ── It draws the LEDGER, never the cache ────────────────────────────────────
 * The bands come from `GET /api/sla/instances/:id/ledger`, which walks the
 * ledger's pause and resume edges and splits every running span on the
 * calendar's own open and shut edges. `paused_ms` on the instance row is a
 * cache; if the two ever disagree, the endpoint shows the ledger and so does
 * this component. Nothing here recomputes a clock — a third number in an
 * argument that already has two is the last thing anybody needs.
 *
 * ── The raw ledger is one click away ────────────────────────────────────────
 * The bands are the readable form; the ledger rows are the evidence. Both are
 * on the page, because the person defending the number and the person
 * disputing it need different depths of the same story.
 *
 * ── Manual pause is a different act from working ────────────────────────────
 * Everything an agent does to a clock — replying, resolving, moving to
 * pending — pauses it as a side effect of work. Reaching in and stopping it by
 * hand changes a contractual number, so it costs `sla_admin`, it is written to
 * the ledger with its actor, and the control only appears for someone who holds
 * that grant.
 *
 * HARD RULE 11 — bands and cards are background steps and fills, never borders.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlarmClock,
  CalendarClock,
  ChevronDown,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { formatDurationShort } from '@/components/tickets/SlaChip';
import { formatDateTime, formatTime } from '@/utils/format';
import { errorMessage } from '@/api/client';
import { cn } from '@/utils/cn';
import {
  PAUSE_REASON_LABELS,
  slaApi,
  type ExplainerBand,
  type LedgerRow,
  type SlaExplainer,
} from '@/api/sla.api';

// ═════════════════════════════════════════════════════════════════════════════
// Band vocabulary
// ═════════════════════════════════════════════════════════════════════════════

const BAND_FILL: Readonly<Record<ExplainerBand['kind'], string>> = {
  worked: 'bg-sla-ok',
  paused: 'bg-sla-paused',
  out_of_hours: 'bg-bg-tertiary',
};

const BAND_TEXT: Readonly<Record<ExplainerBand['kind'], string>> = {
  worked: 'text-sla-ok',
  paused: 'text-sla-paused',
  out_of_hours: 'text-text-muted',
};

const BAND_LABELS: Readonly<Record<ExplainerBand['kind'], { key: string; fr: string }>> = {
  worked: { key: 'sla.band.worked', fr: 'Temps décompté' },
  paused: { key: 'sla.band.paused', fr: 'En pause' },
  out_of_hours: { key: 'sla.band.outOfHours', fr: 'Hors horaires' },
};

const LEDGER_EVENTS: Readonly<Record<string, { key: string; fr: string }>> = {
  start: { key: 'sla.event.start', fr: 'Départ de l’horloge' },
  pause: { key: 'sla.event.pause', fr: 'Mise en pause' },
  resume: { key: 'sla.event.resume', fr: 'Reprise' },
  target_switch: { key: 'sla.event.targetSwitch', fr: 'Changement de cible' },
  breach: { key: 'sla.event.breach', fr: 'Dépassement' },
  met: { key: 'sla.event.met', fr: 'Objectif atteint' },
  cancel: { key: 'sla.event.cancel', fr: 'Annulation' },
  note: { key: 'sla.event.note', fr: 'Note' },
};

function reasonText(reason: string): string {
  return PAUSE_REASON_LABELS[reason]?.fr ?? reason;
}

// ═════════════════════════════════════════════════════════════════════════════
// One band, as a sentence
// ═════════════════════════════════════════════════════════════════════════════

/**
 * "En pause 14h 22m — attente client. Reprise le 12/03 à 09:02."
 *
 * Built from the band plus the ledger row that ENDED it, so the sentence names
 * the event that actually lifted the pause instead of implying the clock
 * restarted on its own.
 */
function BandSentence({
  band,
  endedBy,
}: {
  band: ExplainerBand;
  endedBy: LedgerRow | undefined;
}): JSX.Element {
  const { t } = useTranslation();
  const duration = formatDurationShort(band.ms);
  const head = t(BAND_LABELS[band.kind].key, BAND_LABELS[band.kind].fr);

  if (band.kind === 'worked') {
    return (
      <>
        {head} {duration} — {t('sla.band.workedSentence', 'l’horloge tournait.')}
      </>
    );
  }

  const reasons =
    band.reasons.length > 0
      ? band.reasons.map(reasonText).join(', ')
      : t('sla.band.noReason', 'raison non enregistrée');

  return (
    <>
      {head} {duration} — {reasons}.
      {endedBy && (
        <>
          {' '}
          {t('sla.band.resumedAt', 'Reprise le {{date}} à {{time}}.', {
            date: formatDateTime(endedBy.at),
            time: formatTime(endedBy.at),
          })}
        </>
      )}
      {endedBy?.note ? ` ${endedBy.note}` : null}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The strip
// ═════════════════════════════════════════════════════════════════════════════

function BandStrip({ bands }: { bands: ExplainerBand[] }): JSX.Element {
  const { t } = useTranslation();
  const total = bands.reduce((sum, band) => sum + Math.max(band.ms, 0), 0);

  if (total <= 0) {
    return (
      <div className="h-9 rounded-md bg-bg-tertiary" role="img" aria-label={t('sla.strip.empty', 'Aucune durée à afficher')} />
    );
  }

  return (
    <div
      className="flex h-9 w-full overflow-hidden rounded-md"
      role="img"
      aria-label={t('sla.strip.label', 'Répartition du temps : décompté, en pause, hors horaires')}
    >
      {bands.map((band, index) => {
        const share = Math.max(band.ms, 0) / total;
        return (
          <div
            key={`${band.from}-${index}`}
            style={{ width: `${Math.max(share * 100, 0.4)}%` }}
            title={`${t(BAND_LABELS[band.kind].key, BAND_LABELS[band.kind].fr)} · ${formatDurationShort(band.ms)}${
              band.reasons.length > 0 ? ` · ${band.reasons.map(reasonText).join(', ')}` : ''
            }`}
            className={cn(
              BAND_FILL[band.kind],
              band.kind === 'out_of_hours' && 'opacity-70',
              'h-full transition-opacity hover:opacity-90',
            )}
          />
        );
      })}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The view
// ═════════════════════════════════════════════════════════════════════════════

export interface SlaLedgerViewProps {
  /** Fetch by id… */
  instanceId?: number;
  /** …or hand it the explainer already loaded. */
  explainer?: SlaExplainer | null;
  /** Show the manual pause / resume controls (SLA_ADMIN). */
  canControl?: boolean;
  onChanged?: () => void;
  className?: string;
}

export function SlaLedgerView({
  instanceId,
  explainer: provided = null,
  canControl = false,
  onChanged,
  className,
}: SlaLedgerViewProps): JSX.Element {
  const { t } = useTranslation();
  const [explainer, setExplainer] = useState<SlaExplainer | null>(provided);
  const [loading, setLoading] = useState(provided === null && instanceId !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [showLedger, setShowLedger] = useState(false);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (instanceId === undefined) return;
    setLoading(true);
    setError(null);
    try {
      setExplainer(await slaApi.ledger(instanceId));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    if (provided) {
      setExplainer(provided);
      return;
    }
    void load();
  }, [provided, load]);

  /** Ledger row that ends each band, matched on the band's closing instant. */
  const enders = useMemo(() => {
    const map = new Map<string, LedgerRow>();
    for (const row of explainer?.ledger ?? []) map.set(row.at, row);
    return map;
  }, [explainer]);

  async function control(action: 'pause' | 'resume') {
    if (!explainer) return;
    setWorking(true);
    try {
      const result =
        action === 'pause'
          ? await slaApi.pause(explainer.instance.id)
          : await slaApi.resume(explainer.instance.id);

      // A resume that leaves the clock paused is not a failure — something else
      // is still holding it, and saying so is the whole point of reporting the
      // remaining pause set.
      if (action === 'resume' && !result.running && result.activePauses.length > 0) {
        toast(
          t(
            'sla.stillPaused',
            'La pause manuelle est levée, mais l’horloge reste arrêtée : {{reasons}}.',
            { reasons: result.activePauses.map(reasonText).join(', ') },
          ),
        );
      } else {
        toast.success(
          action === 'pause'
            ? t('sla.pausedToast', 'Horloge mise en pause — l’action est inscrite au registre.')
            : t('sla.resumedToast', 'Horloge relancée.'),
        );
      }
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  if (loading) {
    return (
      <div className={cn('flex min-h-[180px] items-center justify-center', className)}>
        <LoadingSpinner size="md" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('rounded-lg bg-sla-breach-bg px-3 py-2.5 text-[12.5px] text-sla-breach', className)}>
        {error}
      </div>
    );
  }

  if (!explainer) {
    return (
      <div className={cn('rounded-lg bg-bg-secondary px-3 py-4 text-center text-[12.5px] text-text-muted', className)}>
        {t('sla.noInstance', 'Aucune horloge à expliquer.')}
      </div>
    );
  }

  const { instance, totals, calendar, bands } = explainer;
  const paused = instance.activePauses.length > 0;

  return (
    <div className={cn('space-y-3', className)}>
      {/* ── who, what, against which calendar ────────────────────────────── */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1.5 text-[15px] font-semibold text-text-primary">
            <AlarmClock size={15} className="text-text-muted" />
            {instance.targetLabel || instance.targetSlug}
          </h3>
          <p className="mt-0.5 text-[11.5px] text-text-muted">
            {t('sla.policyLine', 'Contrat « {{policy}} » version {{version}}, calendrier « {{calendar}} » ({{tz}})', {
              policy: instance.policySlug,
              version: instance.policyVersion,
              calendar: calendar.name || calendar.slug,
              tz: calendar.timezone,
            })}
            {calendar.is24x7 && ` · ${t('sla.always', '24×7')}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'rounded-pill px-2.5 py-1 text-[11.5px] font-medium',
              instance.status === 'breached'
                ? 'bg-sla-breach-bg text-sla-breach'
                : instance.status === 'met'
                  ? 'bg-sla-ok-bg text-sla-ok'
                  : paused
                    ? 'bg-sla-paused-bg text-sla-paused'
                    : 'bg-sla-ok-bg text-sla-ok',
            )}
          >
            {instance.status === 'breached'
              ? t('sla.status.breached', 'Dépassé')
              : instance.status === 'met'
                ? t('sla.status.met', 'Respecté')
                : instance.status === 'cancelled'
                  ? t('sla.status.cancelled', 'Annulé')
                  : paused
                    ? t('sla.status.paused', 'En pause')
                    : t('sla.status.running', 'En cours')}
          </span>

          {instanceId !== undefined && (
            <Button
              size="xs"
              variant="ghost"
              icon={<RefreshCw size={12} />}
              onClick={() => void load()}
              aria-label={t('common.refresh', 'Actualiser')}
            />
          )}

          {canControl && (instance.status === 'running' || instance.status === 'paused') && (
            <Button
              size="xs"
              variant="secondary"
              loading={working}
              icon={instance.activePauses.includes('manual') ? <Play size={12} /> : <Pause size={12} />}
              onClick={() => void control(instance.activePauses.includes('manual') ? 'resume' : 'pause')}
            >
              {instance.activePauses.includes('manual')
                ? t('sla.resumeManually', 'Relancer')
                : t('sla.pauseManually', 'Mettre en pause')}
            </Button>
          )}
        </div>
      </div>

      {/* ── the strip ────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <BandStrip bands={bands} />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
          {(['worked', 'paused', 'out_of_hours'] as const).map((kind) => {
            const ms =
              kind === 'worked'
                ? totals.workedMs
                : kind === 'paused'
                  ? totals.pausedMs
                  : totals.outOfHoursMs;
            return (
              <span key={kind} className="flex items-center gap-1.5">
                <span className={cn('h-2.5 w-2.5 rounded-sm', BAND_FILL[kind], kind === 'out_of_hours' && 'opacity-70')} />
                <span className={BAND_TEXT[kind]}>{t(BAND_LABELS[kind].key, BAND_LABELS[kind].fr)}</span>
                <span className="font-mono text-text-secondary">{formatDurationShort(ms)}</span>
              </span>
            );
          })}
          <span className="ml-auto text-text-muted">
            {t('sla.countedOnly', 'Seul le temps décompté compte contre l’objectif.')}
          </span>
        </div>
      </div>

      {/* ── the numbers ──────────────────────────────────────────────────── */}
      <div className="grid gap-2 sm:grid-cols-4">
        <div className="rounded-lg bg-bg-secondary px-3 py-2">
          <span className="block text-[11px] text-text-muted">{t('sla.started', 'Départ')}</span>
          <span className="block font-mono text-[12.5px] text-text-primary">
            {formatDateTime(instance.startedAt)}
          </span>
        </div>
        <div className="rounded-lg bg-bg-secondary px-3 py-2">
          <span className="block text-[11px] text-text-muted">{t('sla.due', 'Échéance')}</span>
          <span className="block font-mono text-[12.5px] text-text-primary">
            {instance.dueAt ? formatDateTime(instance.dueAt) : '—'}
          </span>
        </div>
        <div className="rounded-lg bg-bg-secondary px-3 py-2">
          <span className="block text-[11px] text-text-muted">{t('sla.budget', 'Budget')}</span>
          <span className="block font-mono text-[12.5px] text-text-primary">
            {instance.budgetMs === null ? '—' : formatDurationShort(instance.budgetMs)}
          </span>
        </div>
        <div className="rounded-lg bg-bg-secondary px-3 py-2">
          <span className="block text-[11px] text-text-muted">{t('sla.consumed', 'Consommé')}</span>
          <span className="block font-mono text-[12.5px] text-text-primary">
            {formatDurationShort(instance.elapsedMs)}
            {instance.elapsedPercent !== null && (
              <span className="ml-1 text-text-muted">({instance.elapsedPercent}%)</span>
            )}
          </span>
        </div>
      </div>

      {paused && (
        <p className="rounded-md bg-sla-paused-bg px-3 py-2 text-[12.5px] text-sla-paused">
          {t('sla.currentlyPaused', 'Horloge actuellement arrêtée : {{reasons}}.', {
            reasons: instance.activePauses.map(reasonText).join(', '),
          })}
        </p>
      )}

      {/* ── the bands, as sentences ──────────────────────────────────────── */}
      <ol className="space-y-1">
        {bands.map((band, index) => (
          <li
            key={`${band.from}-${index}`}
            className="flex items-start gap-2 rounded-md bg-bg-secondary px-2.5 py-1.5"
          >
            <span className={cn('mt-1 h-2.5 w-2.5 shrink-0 rounded-sm', BAND_FILL[band.kind])} />
            <div className="min-w-0">
              <p className="text-[12.5px] leading-snug text-text-primary">
                <BandSentence band={band} endedBy={enders.get(band.to)} />
              </p>
              <p className="font-mono text-[11px] text-text-muted">
                {formatDateTime(band.from)} → {formatDateTime(band.to)}
              </p>
            </div>
          </li>
        ))}
      </ol>

      {/* ── the evidence ─────────────────────────────────────────────────── */}
      <div>
        <button
          type="button"
          onClick={() => setShowLedger((current) => !current)}
          className="flex items-center gap-1.5 text-[12px] text-text-muted transition-colors hover:text-text-secondary"
        >
          <ChevronDown size={12} className={cn('transition-transform', !showLedger && '-rotate-90')} />
          {t('sla.showLedger', 'Registre brut ({{count}} événements)', {
            count: explainer.ledger.length,
          })}
        </button>

        {showLedger && (
          <div className="mt-1.5 overflow-x-auto rounded-lg bg-bg-secondary">
            <table className="w-full min-w-[620px] text-left text-[12px]">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-wide text-text-muted">
                  <th className="px-3 py-1.5 font-medium">{t('sla.ledger.at', 'Instant')}</th>
                  <th className="px-3 py-1.5 font-medium">{t('sla.ledger.event', 'Événement')}</th>
                  <th className="px-3 py-1.5 font-medium">{t('sla.ledger.reason', 'Raison')}</th>
                  <th className="px-3 py-1.5 text-right font-medium">{t('sla.ledger.elapsed', 'Décompté avant')}</th>
                  <th className="px-3 py-1.5 font-medium">{t('sla.ledger.newDue', 'Nouvelle échéance')}</th>
                </tr>
              </thead>
              <tbody>
                {explainer.ledger.map((row) => (
                  <tr key={row.id} className="align-top">
                    <td className="px-3 py-1.5 font-mono text-text-secondary">{formatDateTime(row.at)}</td>
                    <td className="px-3 py-1.5 text-text-primary">
                      {t(LEDGER_EVENTS[row.event]?.key ?? row.event, LEDGER_EVENTS[row.event]?.fr ?? row.event)}
                      {row.note && <span className="block text-[11px] text-text-muted">{row.note}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-text-secondary">
                      {row.reasonCode ? reasonText(row.reasonCode) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-text-secondary">
                      {formatDurationShort(row.elapsedBusinessMsBefore)}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-text-secondary">
                      {row.newDueAt ? formatDateTime(row.newDueAt) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="flex items-start gap-1.5 text-[11px] leading-snug text-text-muted">
        <CalendarClock size={12} className="mt-0.5 shrink-0" />
        {t(
          'sla.ledgerFootnote',
          'Ces bandes sont calculées à partir du registre et du calendrier, jamais à partir du compteur mis en cache. Si les deux divergeaient, c’est le registre qui est montré — c’est lui qui fait foi.',
        )}
      </p>
    </div>
  );
}

export default SlaLedgerView;
