import { cn } from '@/utils/cn';

interface GaugeProps {
  /** 0-100. `null` renders an em-dash and an empty track (no data yet). */
  value: number | null;
  /** Already-translated caption under the arc. */
  label?: string;
  /** Width of the half-circle in px. */
  size?: number;
  /**
   * Invert the colour ramp for metrics where LOW is good — a breach rate, a
   * reopen rate. Default assumes high is good (SLA attainment, CSAT).
   */
  lowerIsBetter?: boolean;
  /** Override the auto colour entirely (any CSS colour). */
  color?: string;
  className?: string;
}

/**
 * Half-circle gauge per design system §14.5 — green >= 90, amber >= 70,
 * red < 70. Hand-rolled SVG, not recharts.
 *
 * `pathLength="100"` normalises the arc so `strokeDasharray = "<pct> 100"` is
 * the percentage directly, exactly like the donut's r = 15.915 trick.
 */
export function Gauge({
  value,
  label,
  size = 128,
  lowerIsBetter = false,
  color,
  className,
}: GaugeProps) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));

  // The thresholds are read against the "good" direction, so a breach-rate
  // gauge at 5% is green rather than red.
  const scored = lowerIsBetter ? 100 - pct : pct;
  const autoColor =
    scored >= 90
      ? 'rgb(var(--c-sla-ok))'
      : scored >= 70
        ? 'rgb(var(--c-sla-warn))'
        : 'rgb(var(--c-sla-breach))';
  const stroke = value == null ? 'rgb(var(--c-text-muted))' : (color ?? autoColor);

  return (
    <div className={cn('flex flex-col items-center gap-1', className)}>
      <svg viewBox="0 0 42 28" style={{ width: size }} role="img" aria-label={label}>
        {/* Track */}
        <path
          d="M3 25 A18 18 0 0 1 39 25"
          fill="none"
          stroke="rgb(var(--c-bg-tertiary))"
          strokeWidth="3.5"
          strokeLinecap="round"
          pathLength="100"
        />
        {/* Value */}
        {value != null && pct > 0 && (
          <path
            d="M3 25 A18 18 0 0 1 39 25"
            fill="none"
            stroke={stroke}
            strokeWidth="3.5"
            strokeLinecap="round"
            pathLength="100"
            strokeDasharray={`${pct} 100`}
          />
        )}
        <text
          x="21"
          y="22"
          textAnchor="middle"
          fill="rgb(var(--c-text-primary))"
          fontSize="9"
          fontWeight="700"
          fontFamily="Rajdhani, Inter, sans-serif"
        >
          {value == null ? '—' : `${Math.round(pct)}%`}
        </text>
      </svg>

      {label && (
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
          {label}
        </span>
      )}
    </div>
  );
}
