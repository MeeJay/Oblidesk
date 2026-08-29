import { useId } from 'react';
import { cn } from '@/utils/cn';

interface SparklineProps {
  /** One value per bucket, oldest first. Fewer than 2 points renders a spacer. */
  data: number[];
  /** Any CSS colour. Pass `rgb(var(--c-accent))` to track the theme. */
  color?: string;
  height?: number;
  /** Fill the area under the line with a fading gradient. */
  area?: boolean;
  strokeWidth?: number;
  className?: string;
}

/**
 * Hand-rolled inline SVG per design system §14.2 — deliberately NOT recharts.
 * Recharts is reserved for the big configurable dashboard widgets; a 36px
 * sparkline inside a KPI card must not drag a chart runtime into the hero row.
 *
 * `preserveAspectRatio="none"` lets the 200-unit viewBox stretch to whatever
 * width the card gives it while the height stays exactly `height` px.
 */
export function Sparkline({
  data,
  color = 'rgb(var(--c-accent))',
  height = 36,
  area = true,
  strokeWidth = 1.6,
  className,
}: SparklineProps) {
  const gradientId = useId().replace(/[:]/g, '');

  if (data.length < 2) return <div style={{ height }} className={className} />;

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const w = 200;
  const h = height;

  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * w;
    const y = h - ((value - min) / range) * (h - 4) - 2;
    return [x, y] as const;
  });

  const linePath = points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height }}
      className={cn('block', className)}
      aria-hidden
    >
      {area && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.4" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      {area && <path d={areaPath} fill={`url(#${gradientId})`} />}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        // The viewBox is stretched horizontally; without this the stroke would
        // be stretched with it and the line would thicken on wide cards.
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
