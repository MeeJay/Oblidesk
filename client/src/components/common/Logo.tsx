import { cn } from '@/utils/cn';

interface LogoProps {
  className?: string;
  /** Mark edge length in px. The wordmark scales off it. */
  size?: number;
  /** Hide the "Oblidesk" wordmark and render the mark alone (collapsed chrome). */
  markOnly?: boolean;
  /** Accessible label — the topbar wraps this in a link to "/". */
  title?: string;
}

/**
 * Oblidesk logo — the mark is drawn INLINE (not an <img>) so it inherits the
 * live accent from `--c-accent`. That matters because the accent moves between
 * themes: #22b8f5 on the dark themes, the deeper #0284c7 on Obli Daylight where
 * the bright cyan would vanish against a white card. An <img> would need a
 * second file per theme and would still lag a runtime theme swap.
 *
 * The mark is a service-desk speech bubble with a resolved check — flat and
 * geometric, matching the rest of the suite. `public/logo.svg` carries the same
 * artwork for the manifest / og:image, where a static file is required.
 */
export function Logo({ className, size = 26, markOnly = false, title = 'Oblidesk' }: LogoProps) {
  const gradientId = `od-logo-${size}`;

  return (
    <span className={cn('flex items-center gap-2', className)} title={title}>
      <svg
        viewBox="0 0 32 32"
        width={size}
        height={size}
        className="shrink-0"
        role="img"
        aria-label={title}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="rgb(var(--c-accent-hover))" />
            <stop offset="100%" stopColor="rgb(var(--c-accent-dark))" />
          </linearGradient>
        </defs>
        <path
          d="M9 6.5h14a3.5 3.5 0 0 1 3.5 3.5v8a3.5 3.5 0 0 1-3.5 3.5h-6.9l-4.6 4.1A1 1 0 0 1 9.8 25v-3.5H9A3.5 3.5 0 0 1 5.5 18v-8A3.5 3.5 0 0 1 9 6.5Z"
          fill={`url(#${gradientId})`}
        />
        <path
          d="m11.6 14.2 3.1 3.1 6.1-6.4"
          fill="none"
          stroke="rgb(var(--c-bg-primary))"
          strokeWidth="2.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      {!markOnly && (
        <span
          className="font-display font-semibold leading-none tracking-[0.01em] text-text-primary"
          style={{ fontSize: Math.round(size * 0.73) }}
        >
          Obli<span className="text-accent">desk</span>
        </span>
      )}
    </span>
  );
}
