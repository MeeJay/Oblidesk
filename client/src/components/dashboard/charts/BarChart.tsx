/**
 * BarChart.tsx — the grouped bar chart, and the chart kit its siblings share.
 *
 * ── Why the shared kit lives here ────────────────────────────────────────────
 * `LineChart`, `DonutChart` and the widget frame all need the SAME categorical
 * palette, the same tooltip and the same axis treatment; three copies of a
 * ten-colour array is three chances for the queue that is teal on the bar chart
 * to be amber on the donut. The kit therefore has exactly one home, and this
 * file is it — the bar chart is the one every other chart is read against.
 * Importing `{ CHART_PALETTE, ChartTooltip } from './BarChart'` is deliberate,
 * not an accident of refactoring.
 *
 * ── Colours are CSS variables, not hex ───────────────────────────────────────
 * Recharts hands `fill` / `stroke` straight to the SVG attribute, so
 * `rgb(var(--c-accent))` resolves at paint time and follows the four themes
 * without a single JS re-render. Never hard-code a hex here: the same chart
 * ships on Obli Operator (near-black) and Obli Daylight (near-white).
 *
 * ── recharts here, hand-rolled SVG in the KPI cards ──────────────────────────
 * Design system §14.2: `Sparkline` / `Donut` / `Gauge` stay hand-rolled because
 * a 36px spark inside a KPI card must not drag a chart runtime into the hero
 * row. recharts is reserved for the big configurable widgets — the ones that
 * need axes, a legend, a reference line and a tooltip. That split is why the
 * dashboard chunk is the only one that pays for it.
 */

import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/utils/cn';

// ═════════════════════════════════════════════════════════════════════════════
// The kit
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The categorical series palette.
 *
 * Ordered for maximum separation between NEIGHBOURS, because adjacent bars and
 * adjacent donut slices are the pairs a reader actually has to tell apart. All
 * ten are theme tokens, so the ramp inverts correctly on the light theme.
 */
export const CHART_PALETTE: readonly string[] = [
  'rgb(var(--c-accent))',
  'rgb(var(--c-status-resolved))',
  'rgb(var(--c-status-pending-requester))',
  'rgb(var(--c-status-pending-third-party))',
  'rgb(var(--c-status-scheduled))',
  'rgb(var(--c-priority-p1))',
  'rgb(var(--c-status-new))',
  'rgb(var(--c-sla-warn))',
  'rgb(var(--c-priority-p3))',
  'rgb(var(--c-text-muted))',
];

/** Stable colour for series `index`, wrapping past the end of the palette. */
export function chartColor(index: number): string {
  if (!Number.isFinite(index) || index < 0) return CHART_PALETTE[0];
  return CHART_PALETTE[index % CHART_PALETTE.length];
}

/**
 * A named colour for a value that the design system already paints — a status
 * category, a priority rank, an SLA outcome. Falls back to the positional
 * palette so a chart grouped by something arbitrary still reads.
 *
 * This is what stops "open by priority" from painting P1 green.
 */
const SEMANTIC_COLORS: Readonly<Record<string, string>> = {
  // status categories (HARD RULE 5 — keyed by category, never by slug)
  new: 'rgb(var(--c-status-new))',
  open: 'rgb(var(--c-status-open))',
  pending_requester: 'rgb(var(--c-status-pending-requester))',
  pending_third_party: 'rgb(var(--c-status-pending-third-party))',
  scheduled: 'rgb(var(--c-status-scheduled))',
  resolved: 'rgb(var(--c-status-resolved))',
  closed: 'rgb(var(--c-status-closed))',
  cancelled: 'rgb(var(--c-status-cancelled))',
  // priority ranks, by the slugs the baseline ships
  p1: 'rgb(var(--c-priority-p1))',
  p2: 'rgb(var(--c-priority-p2))',
  p3: 'rgb(var(--c-priority-p3))',
  p4: 'rgb(var(--c-priority-p4))',
  critical: 'rgb(var(--c-priority-p1))',
  high: 'rgb(var(--c-priority-p2))',
  medium: 'rgb(var(--c-priority-p3))',
  low: 'rgb(var(--c-priority-p4))',
  // SLA outcomes
  met: 'rgb(var(--c-sla-ok))',
  breached: 'rgb(var(--c-sla-breach))',
  paused: 'rgb(var(--c-sla-paused))',
};

export function seriesColor(rawValue: string | null, index: number): string {
  if (rawValue === null) return 'rgb(var(--c-text-muted))';
  const semantic = SEMANTIC_COLORS[rawValue.toLowerCase()];
  return semantic ?? chartColor(index);
}

/** One plotted datum. `raw` is the untranslated group value the drill needs. */
export interface ChartDatum {
  /** Already-translated axis label. */
  label: string;
  value: number;
  /** The group value exactly as the server returned it. `null` IS a group. */
  raw: string | null;
  color?: string;
}

/**
 * Display order for a grouped chart.
 *
 * DISPLAY only, and that distinction is the whole point. The server always
 * SELECTS the top N groups by value — that is a `LIMIT` on an ordered
 * aggregate and it is not negotiable from the client, because an `orderBy` on
 * the wire is a column name on the wire. What the reader picks here is how
 * those N are arranged once they have arrived. So "trier par libellé" never
 * changes WHICH bars you see, only the order they sit in, and the widget says
 * so next to the control.
 */
export const CHART_SORTS = ['value_desc', 'value_asc', 'label_asc', 'label_desc'] as const;
export type ChartSort = (typeof CHART_SORTS)[number];

export function sortChartData(data: ChartDatum[], sort: ChartSort | null | undefined): ChartDatum[] {
  const rows = [...data];
  switch (sort) {
    case 'value_asc':
      return rows.sort((a, b) => a.value - b.value);
    case 'label_asc':
      return rows.sort((a, b) => a.label.localeCompare(b.label));
    case 'label_desc':
      return rows.sort((a, b) => b.label.localeCompare(a.label));
    case 'value_desc':
    default:
      return rows.sort((a, b) => b.value - a.value);
  }
}

/** Axis chrome, in one place so every chart agrees on the type scale. */
export const AXIS_TICK = {
  fill: 'rgb(var(--c-text-muted))',
  fontSize: 10,
  fontFamily: 'JetBrains Mono, monospace',
} as const;

export const GRID_STROKE = 'rgb(var(--c-border))';

interface TooltipPayloadEntry {
  payload?: ChartDatum;
  value?: number | string;
  name?: string | number;
  color?: string;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
  /** Renders the number — units differ per metric, so the caller owns it. */
  format: (value: number) => string;
  /** Quiet second line, e.g. "cliquer pour voir les tickets". */
  hint?: string;
}

/**
 * HARD RULE 11 — no border. The tooltip is a raised `bg-bg-active` tile with
 * the card shadow; depth comes from the background step, never from an outline.
 */
export function ChartTooltip({ active, payload, label, format, hint }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const first = payload[0];
  const value = typeof first.value === 'number' ? first.value : Number(first.value ?? NaN);

  return (
    <div className="pointer-events-none rounded-card bg-bg-active px-3 py-2 shadow-card">
      <p className="max-w-[220px] truncate text-[12px] font-medium text-text-primary">
        {first.payload?.label ?? String(label ?? '')}
      </p>
      <p className="font-mono text-[13px] font-semibold text-accent">
        {Number.isFinite(value) ? format(value) : '—'}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-text-muted">{hint}</p>}
    </div>
  );
}

/**
 * The blank slate INSIDE a chart.
 *
 * Deliberately never an empty axis pair: an empty chart is indistinguishable
 * from a quiet week, and that is the failure mode that gets a dashboard quietly
 * ignored for six months. It says which of the two it is.
 */
export function ChartEmpty({ title, detail, icon }: { title: string; detail?: string; icon?: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-4 text-center">
      {icon && <div className="text-text-muted opacity-70">{icon}</div>}
      <p className="text-[12px] font-medium text-text-secondary">{title}</p>
      {detail && <p className="max-w-[240px] text-[11px] leading-relaxed text-text-muted">{detail}</p>}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// BarChart
// ═════════════════════════════════════════════════════════════════════════════

interface BarChartProps {
  data: ChartDatum[];
  /** Units differ per metric; the widget owns the formatter. */
  format: (value: number) => string;
  /** Reference line, e.g. an SLA target of 95. */
  target?: number | null;
  targetLabel?: string;
  /**
   * Horizontal bars. The right default for a category axis: queue and assignee
   * names are words, and words do not fit under a vertical bar without being
   * rotated 45° and becoming unreadable.
   */
  horizontal?: boolean;
  /** Every bar drills through. Omitted only when the caller has no records. */
  onSelect?: (datum: ChartDatum) => void;
  /** Translated hint shown in the tooltip when the bar is clickable. */
  drillHint?: string;
  className?: string;
}

export function BarChart({
  data,
  format,
  target = null,
  targetLabel,
  horizontal = true,
  onSelect,
  drillHint,
  className,
}: BarChartProps) {
  const { t } = useTranslation();

  const coloured = useMemo(
    () => data.map((datum, index) => ({ ...datum, color: datum.color ?? seriesColor(datum.raw, index) })),
    [data],
  );

  if (coloured.length === 0) {
    return (
      <ChartEmpty
        title={t('dashboard.chart.empty', 'Aucune donnée sur cette période.')}
        detail={t(
          'dashboard.chart.emptyDetail',
          'Le calcul a abouti, il n’a simplement rien trouvé à compter.',
        )}
      />
    );
  }

  const cursorFill = 'rgb(var(--c-bg-hover))';

  return (
    <div className={cn('h-full w-full', className)}>
      <ResponsiveContainer width="100%" height="100%">
        <RechartsBarChart
          data={coloured}
          layout={horizontal ? 'vertical' : 'horizontal'}
          margin={{ top: 6, right: 18, bottom: 4, left: 4 }}
          barCategoryGap={horizontal ? '22%' : '28%'}
        >
          <CartesianGrid
            stroke={GRID_STROKE}
            strokeOpacity={0.5}
            horizontal={!horizontal}
            vertical={horizontal}
          />

          {horizontal ? (
            <>
              <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} />
              <YAxis
                type="category"
                dataKey="label"
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                width={92}
                // Long queue names get an ellipsis rather than eating the plot.
                tickFormatter={(value: string) => (value.length > 14 ? `${value.slice(0, 13)}…` : value)}
              />
            </>
          ) : (
            <>
              <XAxis
                type="category"
                dataKey="label"
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} width={40} />
            </>
          )}

          <Tooltip
            cursor={{ fill: cursorFill, fillOpacity: 0.5 }}
            content={
              <ChartTooltip
                format={format}
                hint={onSelect ? (drillHint ?? t('dashboard.drillHint', 'Cliquer pour voir les tickets')) : undefined}
              />
            }
          />

          {/* The target line is the difference between "94%" and "94%, and we
              promised 95". Two elements rather than a spread so the axis it
              pins to is obvious at a glance. */}
          {target !== null && Number.isFinite(target) && horizontal && (
            <ReferenceLine
              x={target}
              stroke="rgb(var(--c-sla-warn))"
              strokeDasharray="4 3"
              label={{
                value: targetLabel ?? format(target),
                position: 'top',
                fill: 'rgb(var(--c-sla-warn))',
                fontSize: 10,
                fontFamily: 'JetBrains Mono, monospace',
              }}
            />
          )}
          {target !== null && Number.isFinite(target) && !horizontal && (
            <ReferenceLine
              y={target}
              stroke="rgb(var(--c-sla-warn))"
              strokeDasharray="4 3"
              label={{
                value: targetLabel ?? format(target),
                position: 'right',
                fill: 'rgb(var(--c-sla-warn))',
                fontSize: 10,
                fontFamily: 'JetBrains Mono, monospace',
              }}
            />
          )}

          <Bar
            dataKey="value"
            radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
            isAnimationActive={false}
            onClick={(payload: unknown) => {
              if (!onSelect) return;
              const datum = (payload as { payload?: ChartDatum })?.payload;
              if (datum) onSelect(datum);
            }}
            className={onSelect ? 'cursor-pointer' : undefined}
          >
            {coloured.map((datum) => (
              <Cell key={`${datum.raw ?? '∅'}-${datum.label}`} fill={datum.color} />
            ))}
            <LabelList
              dataKey="value"
              position={horizontal ? 'right' : 'top'}
              fill="rgb(var(--c-text-muted))"
              fontSize={10}
              fontFamily="JetBrains Mono, monospace"
              formatter={(value: unknown) => (typeof value === 'number' ? format(value) : '')}
            />
          </Bar>
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default BarChart;
