import { cn } from '@/utils/cn';

interface LoadingSpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  /** Optional caption under the spinner — pass an already-translated string. */
  label?: string;
}

const SIZES = {
  xs: 'h-3 w-3',
  sm: 'h-4 w-4',
  md: 'h-8 w-8',
  lg: 'h-12 w-12',
} as const;

export function LoadingSpinner({ size = 'md', className, label }: LoadingSpinnerProps) {
  const spinner = (
    <svg
      className={cn('animate-spin text-accent', SIZES[size], className)}
      fill="none"
      viewBox="0 0 24 24"
      role="status"
      aria-label={label ?? 'loading'}
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );

  if (!label) return spinner;

  return (
    <div className="flex flex-col items-center gap-2">
      {spinner}
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
        {label}
      </span>
    </div>
  );
}
