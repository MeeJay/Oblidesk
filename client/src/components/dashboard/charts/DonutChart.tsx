/**
 * DonutChart.tsx — the composition chart for a big widget.
 *
 * ── Why this exists next to `common/Donut` ───────────────────────────────────
 * They are not duplicates and neither should be deleted.
 *
 *   • `common/Donut` is 42×42 hand-rolled SVG (design system §14.3, r = 15.915
 *     so a dasharray IS a percentage). It ships in the hero row and in queue
 *     cards, where dragging a chart runtime in for a 112px ring is not worth
 *     its weight.
 *   • THIS one is the resizable dashboard widget: it needs hover, a tooltip, a
 *     scrollable legend, an active-slice lift and a click target per slice —
 *     all of which recharts already does correctly, including the keyboard and
 *     touch behaviour that a hand-rolled version quietly does not.
 *
 * ── The centre number is honest ──────────────────────────────────────────────
 * It prints the SUM OF THE PLOTTED SLICES, and when groups were dropped by the
 * top-N cap it says so with a "+N autres" slice rather than showing a total
 * that does not add up to the ring around it.
 *
 * The chart kit (palette, tooltip, empty state) lives in `./BarChart`.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cell, Pie, PieChart, ResponsiveContainer, Sector, Tooltip } from 'recharts';
import { cn } from '@/utils/cn';
import { ChartEmpty, ChartTooltip, seriesColor, type ChartDatum } from './BarChart';

interface DonutChartProps {
  data: ChartDatum[];
  format: (value: number) => string;
  /** Translated caption under the centre number, e.g. "tickets". */
  totalLabel?: string;
  /** Every slice drills through. */
  onSelect?: (datum: ChartDatum) => void;
  drillHint?: string;
  /** Hide the legend on a narrow widget — the tooltip still names every slice. */
  showLegend?: boolean;
  className?: string;
}

/** The lifted slice under the cursor. Depth by geometry, not by an outline. */
function ActiveSlice(props: unknown) {
  const sector = props as {
    cx: number; cy: number; innerRadius: number; outerRadius: number;
    startAngle: number; endAngle: number; fill: string;
  };
  return (
    <Sector
      cx={sector.cx}
      cy={sector.cy}
      innerRadius={sector.innerRadius}
      outerRadius={sector.outerRadius + 4}
      startAngle={sector.startAngle}
      endAngle={sector.endAngle}
      fill={sector.fill}
    />
  );
}

export function DonutChart({
  data,
  format,
  totalLabel,
  onSelect,
  drillHint,
  showLegend = true,
  className,
}: DonutChartProps) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const coloured = useMemo(
    () =>
      data
        // A zero slice draws nothing but still takes a legend row and a colour
        // out of the palette, which shifts every colour after it.
        .filter((datum) => Number.isFinite(datum.value) && datum.value > 0)
        .map((datum, index) => ({ ...datum, color: datum.color ?? seriesColor(datum.raw, index) })),
    [data],
  );

  const total = useMemo(() => coloured.reduce((sum, datum) => sum + datum.value, 0), [coloured]);

  if (coloured.length === 0) {
    return (
      <ChartEmpty
        title={t('dashboard.chart.empty', 'Aucune donnée sur cette période.')}
        detail={t(
          'dashboard.chart.emptyDonut',
          'Aucun segment n’a de valeur supérieure à zéro sur cette période.',
        )}
      />
    );
  }

  return (
    <div className={cn('flex h-full w-full items-center gap-4', className)}>
      <div className="relative h-full min-h-[120px] flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <Tooltip
              content={
                <ChartTooltip
                  format={format}
                  hint={onSelect ? (drillHint ?? t('dashboard.drillHint', 'Cliquer pour voir les tickets')) : undefined}
                />
              }
            />
            <Pie
              data={coloured}
              dataKey="value"
              nameKey="label"
              innerRadius="58%"
              outerRadius="86%"
              paddingAngle={1.5}
              stroke="none"
              startAngle={90}
              endAngle={-270}
              isAnimationActive={false}
              activeIndex={activeIndex ?? undefined}
              activeShape={ActiveSlice}
              onMouseEnter={(_: unknown, index: number) => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
              onClick={(payload: unknown) => {
                if (!onSelect) return;
                const datum = (payload as { payload?: ChartDatum })?.payload ?? (payload as ChartDatum);
                if (datum && typeof datum.value === 'number') onSelect(datum);
              }}
              className={onSelect ? 'cursor-pointer' : undefined}
            >
              {coloured.map((datum) => (
                <Cell key={`${datum.raw ?? '∅'}-${datum.label}`} fill={datum.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>

        {/* The hole. Absolutely positioned rather than a recharts <Label> so it
            uses the app's own type tokens instead of an SVG font stack. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-[26px] font-semibold leading-none text-text-primary">
            {format(total)}
          </span>
          {totalLabel && (
            <span className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
              {totalLabel}
            </span>
          )}
        </div>
      </div>

      {showLegend && (
        <ul className="flex max-h-full min-w-0 flex-[0_0_44%] flex-col gap-1.5 overflow-y-auto pr-1">
          {coloured.map((datum, index) => {
            const pct = total > 0 ? Math.round((datum.value / total) * 100) : 0;
            const interactive = Boolean(onSelect);
            return (
              <li key={`${datum.raw ?? '∅'}-${datum.label}`}>
                <button
                  type="button"
                  disabled={!interactive}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseLeave={() => setActiveIndex(null)}
                  onFocus={() => setActiveIndex(index)}
                  onBlur={() => setActiveIndex(null)}
                  onClick={() => onSelect?.(datum)}
                  title={interactive ? (drillHint ?? t('dashboard.drillHint', 'Cliquer pour voir les tickets')) : datum.label}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-pill px-1.5 py-1 text-left text-[12px] transition-colors',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    interactive ? 'cursor-pointer hover:bg-bg-hover' : 'cursor-default',
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ background: datum.color }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-text-primary">{datum.label}</span>
                  <span className="shrink-0 font-mono text-[11px] text-text-muted">
                    {format(datum.value)} · {pct}%
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default DonutChart;
