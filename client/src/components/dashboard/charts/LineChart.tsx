/**
 * LineChart.tsx — the time series, with an optional filled area.
 *
 * ── One chart, two shapes ────────────────────────────────────────────────────
 * `line_chart` and `area_chart` differ by a gradient, not by a component. The
 * axes, the tooltip, the target line and the drill-through are identical, and
 * two files would drift apart on the third of those within a month.
 *
 * ── The honest empty state for a snapshot metric ─────────────────────────────
 * "Open tickets over 30 days" cannot be recovered from today's rows: once a
 * ticket closes, nothing remembers it was open last Tuesday. Its history exists
 * only because `rollup.service` wrote a row each night, so before the first run
 * there is genuinely nothing to draw. That case renders as "history starts the
 * day the rollup first ran", NOT as a flat line at zero — a flat zero is a
 * claim that the desk had no open tickets, which is a lie the chart is not
 * entitled to tell.
 *
 * The chart kit (palette, tooltip, axis scale, empty state) lives in
 * `./BarChart` — see the note at the top of that file.
 */

import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/utils/cn';
import { AXIS_TICK, ChartEmpty, ChartTooltip, GRID_STROKE, seriesColor } from './BarChart';

/** One row of the wide table recharts wants: a bucket plus a column per series. */
export interface SeriesRow {
  /** The raw bucket, 'YYYY-MM-DD'. Kept so a click can name the day. */
  bucket: string;
  /** Already-formatted axis label. */
  label: string;
  [series: string]: string | number | null;
}

export interface SeriesSpec {
  /** The column key in `rows` — the raw group value, or 'value' when ungrouped. */
  dataKey: string;
  /** Already-translated legend label. */
  label: string;
  /** The untranslated group value, for the drill. Null for the ungrouped series. */
  raw: string | null;
  color: string;
}

interface LineChartProps {
  rows: SeriesRow[];
  series: SeriesSpec[];
  format: (value: number) => string;
  /** Fill under the line. `area_chart` sets this; `line_chart` does not. */
  area?: boolean;
  target?: number | null;
  targetLabel?: string;
  /** Clicking the plot drills through to the records behind the whole series. */
  onSelect?: (series: SeriesSpec | null) => void;
  drillHint?: string;
  /** Rendered instead of the generic blank slate — see the header. */
  emptyTitle?: string;
  emptyDetail?: string;
  className?: string;
}

export function LineChart({
  rows,
  series,
  format,
  area = false,
  target = null,
  targetLabel,
  onSelect,
  drillHint,
  emptyTitle,
  emptyDetail,
  className,
}: LineChartProps) {
  const { t } = useTranslation();
  const gradientBase = useId().replace(/:/g, '');

  const showLegend = series.length > 1;

  const legendPayload = useMemo(
    () => series.map((entry) => ({ value: entry.label, type: 'line' as const, color: entry.color, id: entry.dataKey })),
    [series],
  );

  // A single point is not a trend. Drawing one dot and calling it a line is how
  // a dashboard implies a direction it has no evidence for.
  if (rows.length === 0 || series.length === 0) {
    return (
      <ChartEmpty
        title={emptyTitle ?? t('dashboard.chart.empty', 'Aucune donnée sur cette période.')}
        detail={emptyDetail}
      />
    );
  }

  return (
    <div className={cn('h-full w-full', className)}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ top: 8, right: 14, bottom: 2, left: 0 }}
          onClick={() => {
            if (onSelect) onSelect(series.length === 1 ? series[0] : null);
          }}
          className={onSelect ? 'cursor-pointer' : undefined}
        >
          <defs>
            {series.map((entry, index) => (
              <linearGradient
                key={entry.dataKey}
                id={`${gradientBase}-${index}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={entry.color} stopOpacity={0.34} />
                <stop offset="100%" stopColor={entry.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>

          <CartesianGrid stroke={GRID_STROKE} strokeOpacity={0.5} vertical={false} />
          <XAxis
            dataKey="label"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(value: number) => format(value)}
          />

          <Tooltip
            cursor={{ stroke: GRID_STROKE, strokeWidth: 1 }}
            content={
              <ChartTooltip
                format={format}
                hint={onSelect ? (drillHint ?? t('dashboard.drillHint', 'Cliquer pour voir les tickets')) : undefined}
              />
            }
          />

          {showLegend && (
            <Legend
              payload={legendPayload}
              iconType="line"
              iconSize={10}
              wrapperStyle={{ fontSize: 11, color: 'rgb(var(--c-text-muted))', paddingTop: 4 }}
            />
          )}

          {target !== null && Number.isFinite(target) && (
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

          {area &&
            series.map((entry, index) => (
              <Area
                key={`area-${entry.dataKey}`}
                type="monotone"
                dataKey={entry.dataKey}
                stroke="none"
                fill={`url(#${gradientBase}-${index})`}
                isAnimationActive={false}
                // A gap in a rollup series is a night the job did not run. Do
                // not bridge it: a straight line across a missing week is an
                // invention.
                connectNulls={false}
              />
            ))}

          {series.map((entry) => (
            <Line
              key={`line-${entry.dataKey}`}
              type="monotone"
              dataKey={entry.dataKey}
              name={entry.label}
              stroke={entry.color}
              strokeWidth={1.8}
              dot={false}
              activeDot={{ r: 3.5, strokeWidth: 0 }}
              isAnimationActive={false}
              connectNulls={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Fold the server's long-format points into the wide rows recharts wants, and
 * name the series.
 *
 * The server returns `{ bucket, group, value }` — one row per bucket per group.
 * Recharts wants one row per bucket with a column per group. Doing that fold
 * here, once, is what keeps every caller from inventing its own pivot.
 *
 * `labelFor` translates a raw group value; `bucketLabel` formats the date.
 */
export function toSeriesRows(
  points: Array<{ bucket: string | null; group: string | null; value: number | null }>,
  options: {
    labelFor: (raw: string | null) => string;
    bucketLabel: (bucket: string) => string;
    ungroupedLabel: string;
    /** Cap the number of plotted lines; the rest are dropped, loudly. */
    maxSeries?: number;
  },
): { rows: SeriesRow[]; series: SeriesSpec[]; dropped: number } {
  const maxSeries = options.maxSeries ?? 6;

  // Series ordered by total size, so the legend's first entry is the one the
  // reader cares about and the cap drops the smallest rather than the newest.
  const totals = new Map<string, number>();
  for (const point of points) {
    const raw = point.group ?? ' null';
    totals.set(raw, (totals.get(raw) ?? 0) + (point.value ?? 0));
  }

  const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const kept = ordered.slice(0, maxSeries);
  const keptKeys = new Set(kept.map(([key]) => key));

  const series: SeriesSpec[] = kept.map(([key], index) => {
    const raw = key === ' null' ? null : key;
    return {
      dataKey: key === ' null' ? '__null__' : key,
      label: raw === null && ordered.length === 1 ? options.ungroupedLabel : options.labelFor(raw),
      raw,
      color: seriesColor(raw, index),
    };
  });

  const byBucket = new Map<string, SeriesRow>();
  for (const point of points) {
    const bucket = point.bucket;
    if (bucket === null) continue;
    const key = point.group ?? ' null';
    if (!keptKeys.has(key)) continue;

    let row = byBucket.get(bucket);
    if (!row) {
      row = { bucket, label: options.bucketLabel(bucket) };
      // Every series gets an explicit null so a missing bucket reads as a gap
      // rather than as the previous value carried forward.
      for (const entry of series) row[entry.dataKey] = null;
      byBucket.set(bucket, row);
    }
    row[key === ' null' ? '__null__' : key] = point.value;
  }

  const rows = [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  return { rows, series, dropped: Math.max(ordered.length - kept.length, 0) };
}

export default LineChart;
