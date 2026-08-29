/**
 * StatTile.tsx — the KPI card, the delta arrow, and how a metric value is
 * written down.
 *
 * ── Every number on this tile can be clicked ─────────────────────────────────
 * The whole card is a `<button>`. A KPI an operator has to take on faith is a
 * KPI nobody ever fixes, so the rule the dashboard holds to is: if it cannot
 * drill through to the records behind it, it is not displayed. `onDrill` is
 * therefore required, not optional.
 *
 * ── The delta is allowed to say "I don't know" ───────────────────────────────
 * A point-in-time metric has no history except the one `rollup.service` wrote
 * down each night. Before the first run, "vs hier" has no answer. The server
 * says so with `direction: 'unknown'` and a null previous, and this tile prints
 * a muted em dash and the reason — never "0%", which is a claim that nothing
 * changed and is the single most common lie on a dashboard.
 *
 * ── Formatting lives here because everything needs it ────────────────────────
 * `useMetricFormatter` is exported for the charts too: the tooltip, the axis
 * and the tile must all render 94.2% and 2 h 15 identically, or the same metric
 * reads as two different numbers in two widgets of the same board.
 */

import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Sparkline } from '@/components/common/Sparkline';
import { cn } from '@/utils/cn';
import { EMPTY, currentLocale, formatDuration, formatNumber } from '@/utils/format';
import type { MetricDelta, MetricUnit } from '@/api/metrics.api';

// ═════════════════════════════════════════════════════════════════════════════
// Formatting
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Percentages, written straight.
 *
 * Deliberately NOT `utils/format.formatPercent`: that helper guesses whether it
 * was handed a fraction or a percentage with `value > 1.5 ? value / 100 : value`,
 * which is right for a ratio between 0 and 1 and catastrophically wrong here —
 * a genuine reopen rate of 1.2% would render as 120%. Every `unit: 'percent'`
 * metric in the registry returns 0-100, so the conversion is known, not guessed.
 */
function percentText(value: number, fractionDigits: number): string {
  try {
    return new Intl.NumberFormat(currentLocale(), {
      style: 'percent',
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value / 100);
  } catch {
    return `${formatNumber(value, fractionDigits)} %`;
  }
}

/**
 * How a metric's unit is written. Kept as one switch so a new unit in the
 * registry is one line here rather than a hunt through four widgets.
 */
export function formatMetricValue(
  value: number | null | undefined,
  unit: MetricUnit,
  dayShort: string,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;

  switch (unit) {
    case 'percent':
      // One decimal: 94.2% and 94.8% are a different conversation from "94%".
      return percentText(value, value === 0 || value >= 99.95 ? 0 : 1);
    case 'minutes':
      // "2 h 15", not "135" — nobody reads a response target in raw minutes.
      return formatDuration(value);
    case 'days':
      return `${formatNumber(value, 1)} ${dayShort}`;
    case 'score':
      return formatNumber(value, 1);
    case 'ratio':
      return formatNumber(value, 2);
    case 'count':
    default:
      return formatNumber(value, 0);
  }
}

/**
 * The formatter for one metric's unit, memoised.
 *
 * Charts take `(value: number) => string`; this is assignable to that, so the
 * axis, the tooltip, the bar label and the tile all share one implementation.
 */
export function useMetricFormatter(unit: MetricUnit): (value: number | null | undefined) => string {
  const { t } = useTranslation();
  const dayShort = t('common.dayShort', 'j');
  return useCallback(
    (value: number | null | undefined) => formatMetricValue(value, unit, dayShort),
    [unit, dayShort],
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Delta
// ═════════════════════════════════════════════════════════════════════════════

export type DeltaCompare = 'yesterday' | 'last_week';

interface DeltaArrowProps {
  delta: MetricDelta | null | undefined;
  compareTo: DeltaCompare;
  /** Renders the absolute change in the metric's own unit. */
  format: (value: number | null | undefined) => string;
  /** True when this metric's history comes from the nightly rollup. */
  fromRollup?: boolean;
  className?: string;
}

/**
 * Design system §14.1: positive → green ↑, negative → red ↓, zero or unknown →
 * muted —.
 *
 * "Positive" is the metric's OWN direction, not the sign of the number:
 * `improved` comes from the registry's `higherIsBetter`, so a falling backlog
 * is green and a falling CSAT is red. A metric with no good direction (a raw
 * volume like "created") gets the neutral treatment in both directions — it
 * would be dishonest to paint more tickets green or red.
 */
export function DeltaArrow({ delta, compareTo, format, fromRollup = false, className }: DeltaArrowProps) {
  const { t } = useTranslation();

  const compareLabel =
    compareTo === 'last_week'
      ? t('dashboard.vsLastWeek', 'vs semaine dernière')
      : t('dashboard.vsYesterday', 'vs hier');

  // No snapshot to compare against. Say that, rather than inventing a 0%.
  if (!delta || delta.direction === 'unknown' || delta.change === null) {
    return (
      <p
        className={cn('flex items-center gap-1.5 font-mono text-[11px] text-text-muted', className)}
        title={
          fromRollup
            ? t(
                'dashboard.deltaNoRollup',
                'Aucun instantané pour la période précédente. L’historique d’une mesure ponctuelle commence le jour où l’agrégat nocturne a tourné pour la première fois.',
              )
            : t('dashboard.deltaUnknown', 'Pas de valeur de référence pour cette période.')
        }
      >
        <Minus size={12} className="shrink-0" aria-hidden />
        <span>{t('dashboard.deltaNone', 'pas d’historique')}</span>
        <span className="opacity-70">{compareLabel}</span>
      </p>
    );
  }

  const rising = delta.change > 0;
  const flat = delta.change === 0;

  // `improved === null` means the registry declares no good direction, so the
  // arrow stays neutral instead of guessing.
  const tone =
    flat || delta.improved === null
      ? 'text-text-muted'
      : delta.improved
        ? 'text-sla-ok'
        : 'text-sla-breach';

  const Icon = flat ? Minus : rising ? ArrowUpRight : ArrowDownRight;

  const magnitude = format(Math.abs(delta.change));
  const percent =
    delta.changePercent === null
      ? null
      : `${delta.changePercent > 0 ? '+' : ''}${formatNumber(delta.changePercent, 1)} %`;

  return (
    <p
      className={cn('flex items-center gap-1.5 font-mono text-[11px]', tone, className)}
      title={t('dashboard.deltaTitle', 'Précédent : {{previous}}', {
        previous: format(delta.previous),
      })}
    >
      <Icon size={12} className="shrink-0" aria-hidden />
      <span>
        {flat ? '' : rising ? '+' : '−'}
        {magnitude}
      </span>
      {percent && <span className="opacity-70">({percent})</span>}
      <span className="text-text-muted opacity-80">{compareLabel}</span>
    </p>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// StatTile
// ═════════════════════════════════════════════════════════════════════════════

export type StatTone = 'default' | 'accent' | 'ok' | 'warn' | 'danger';

const TONE_TEXT: Record<StatTone, string> = {
  default: 'text-text-primary',
  accent: 'text-accent',
  ok: 'text-sla-ok',
  warn: 'text-sla-warn',
  danger: 'text-sla-breach',
};

interface StatTileProps {
  /** Already-translated. */
  label: string;
  value: number | null;
  /** The formatter from `useMetricFormatter`, so tile and chart agree. */
  format: (value: number | null | undefined) => string;
  delta?: MetricDelta | null;
  compareTo?: DeltaCompare;
  fromRollup?: boolean;
  /** Values over the widget's `tone_when_above` threshold paint themselves. */
  tone?: StatTone;
  /** Sparkline series, oldest first. Fewer than two points renders nothing. */
  series?: number[];
  /** Accent gradient + glow — the one "featured" tile of a hero row (§14.1). */
  featured?: boolean;
  /** Quiet caption under the value: the window, the saved view, the unit. */
  caption?: string;
  /** Small pictogram top-right. */
  badge?: ReactNode;
  /**
   * REQUIRED. Every displayed number drills through to its records — a tile
   * that cannot be clicked has no business being on the board.
   */
  onDrill: () => void;
  /** Translated tooltip for the click target. */
  drillLabel: string;
  className?: string;
}

export function StatTile({
  label,
  value,
  format,
  delta,
  compareTo = 'yesterday',
  fromRollup = false,
  tone = 'default',
  series,
  featured = false,
  caption,
  badge,
  onDrill,
  drillLabel,
  className,
}: StatTileProps) {
  const { t } = useTranslation();

  const valueTone = tone === 'default' && featured ? 'accent' : tone;

  return (
    <button
      type="button"
      onClick={onDrill}
      title={drillLabel}
      className={cn(
        // HARD RULE 11 — depth is a background step plus a shadow. No border,
        // not even on the featured tile: its ring is an inset accent SHADOW.
        'group flex h-full w-full flex-col rounded-card p-4 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        featured
          ? 'bg-gradient-to-br from-accent/10 via-bg-secondary to-bg-secondary shadow-[0_0_0_1px_rgb(var(--c-accent)/0.18)_inset,_0_6px_28px_-10px_rgb(var(--c-accent)/0.25)] hover:from-accent/[0.16]'
          : 'bg-bg-secondary shadow-card hover:bg-bg-hover',
        className,
      )}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
          {label}
        </span>
        {badge && <span className="shrink-0 text-text-muted">{badge}</span>}
      </div>

      <div
        className={cn(
          'font-display font-semibold leading-none',
          featured ? 'text-[40px]' : 'text-[30px]',
          TONE_TEXT[valueTone],
        )}
      >
        {format(value)}
      </div>

      {value === null && (
        <p className="mt-1.5 text-[11px] leading-snug text-text-muted">
          {t(
            'dashboard.noSingleTotal',
            'Pas de total unique pour cette mesure : voir la répartition.',
          )}
        </p>
      )}

      {caption && <p className="mt-1.5 truncate text-[11px] text-text-muted">{caption}</p>}

      {series && series.length >= 2 && (
        <div className="mt-3">
          <Sparkline
            data={series}
            height={featured ? 40 : 30}
            color={featured ? 'rgb(var(--c-accent))' : 'rgb(var(--c-text-muted))'}
          />
        </div>
      )}

      <div className="mt-auto pt-3">
        <DeltaArrow delta={delta} compareTo={compareTo} format={format} fromRollup={fromRollup} />
      </div>
    </button>
  );
}

export default StatTile;
