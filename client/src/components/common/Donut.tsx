import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export interface DonutSlice {
  /** Already-translated name. */
  name: string;
  value: number;
  /** Any CSS colour — `rgb(var(--c-status-open))` keeps it theme-aware. */
  color: string;
  /** Wrap the legend row in this when the slice is clickable. */
  render?: (children: ReactNode) => ReactNode;
}

interface DonutProps {
  slices: DonutSlice[];
  /** Number printed in the hole. Defaults to the sum of the slices. */
  total?: number;
  /** Small translated caption under the total, e.g. "tickets". */
  totalLabel?: string;
  /** Diameter of the ring in px. */
  size?: number;
  showLegend?: boolean;
  className?: string;
}

/**
 * Donut per design system §14.3 — viewBox 42x42, r = 15.915, strokeWidth 3.5.
 *
 * r = 15.915 is the point of the whole trick: circumference = 2*pi*15.915 = 100,
 * so a slice's `strokeDasharray` is literally its percentage and no arc maths is
 * needed. Keep that radius when editing.
 *
 * Hand-rolled rather than recharts (design system §14.2) — this ships in the
 * dashboard's right column and in queue cards, where a chart runtime is not
 * worth its weight.
 */
export function Donut({
  slices,
  total,
  totalLabel,
  size = 112,
  showLegend = true,
  className,
}: DonutProps) {
  const sum = total ?? slices.reduce((acc, slice) => acc + slice.value, 0);

  let cumulative = 0;
  const arcs = slices.map((slice) => {
    const length = sum > 0 ? (slice.value / sum) * 100 : 0;
    // 25 shifts the start to 12 o'clock; the running negative offset chains the
    // slices so each one begins where the previous one ended.
    const offset = -cumulative + 25;
    cumulative += length;
    return { ...slice, length, offset };
  });

  return (
    <div className={cn('flex items-center gap-5', className)}>
      <svg viewBox="0 0 42 42" className="shrink-0" style={{ width: size, height: size }}>
        <circle
          cx="21"
          cy="21"
          r="15.915"
          fill="none"
          stroke="rgb(var(--c-bg-tertiary))"
          strokeWidth="3.5"
        />
        {arcs.map((arc) => (
          <circle
            key={arc.name}
            cx="21"
            cy="21"
            r="15.915"
            fill="none"
            stroke={arc.color}
            strokeWidth="3.5"
            strokeDasharray={`${arc.length} ${100 - arc.length}`}
            strokeDashoffset={arc.offset}
            transform="rotate(-90 21 21)"
          />
        ))}
        <text
          x="21"
          y={totalLabel ? 20 : 21.5}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="rgb(var(--c-text-primary))"
          fontSize="6.5"
          fontWeight="600"
          fontFamily="Rajdhani, Inter, sans-serif"
        >
          {sum}
        </text>
        {totalLabel && (
          <text
            x="21"
            y="26"
            textAnchor="middle"
            dominantBaseline="middle"
            fill="rgb(var(--c-text-muted))"
            fontSize="2.6"
            fontFamily="JetBrains Mono, monospace"
          >
            {totalLabel}
          </text>
        )}
      </svg>

      {showLegend && (
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {slices.map((slice) => {
            const pct = sum > 0 ? Math.round((slice.value / sum) * 100) : 0;
            const row = (
              <>
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: slice.color }}
                />
                <span className="min-w-0 flex-1 truncate font-medium text-text-primary">
                  {slice.name}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-text-muted">
                  {slice.value} · {pct}%
                </span>
              </>
            );
            return slice.render ? (
              <div key={slice.name} className="contents">
                {slice.render(row)}
              </div>
            ) : (
              <div key={slice.name} className="flex items-center gap-3 text-[13px]">
                {row}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
