import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/utils/cn';

export type ButtonVariant =
  /** Solid accent — one per screen, the thing the page is FOR. */
  | 'primary'
  /** Accent wash — the sidebar's "Nouveau ticket", secondary CTAs. */
  | 'accent'
  /** Raised neutral surface — the default for toolbar actions. */
  | 'secondary'
  /** No surface until hover — icon rails, table row actions. */
  | 'ghost'
  /** Destructive: delete, purge, force-close. Uses the P1 red. */
  | 'danger';

export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Rendered left of the label; hidden while `loading` so the box never jumps. */
  icon?: ReactNode;
  /** Rendered right of the label — a chevron, a count, a shortcut hint. */
  trailing?: ReactNode;
  fullWidth?: boolean;
  children?: ReactNode;
}

/**
 * HARD RULE 11 — no `border:` on a button, ever. Depth is the background step
 * plus, for the solid variants, the accent itself. Hover is a background swap.
 *
 * `primary` paints dark ink (`text-bg-primary`) on the accent rather than white:
 * white on #22b8f5 is roughly 1.9:1, which fails at 13px. Because the ink is a
 * token it inverts correctly on Obli Daylight, where the accent is the darker
 * #0284c7 and the page background is near-white.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-bg-primary hover:bg-accent-hover font-semibold',
  accent: 'bg-accent/12 text-accent hover:bg-accent/20',
  secondary: 'bg-bg-tertiary text-text-primary hover:bg-bg-hover',
  ghost: 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
  danger: 'bg-priority-p1/15 text-priority-p1 hover:bg-priority-p1/25',
};

/** Every interactive element is >= 32px tall on desktop (design system §8). */
const SIZES: Record<ButtonSize, string> = {
  xs: 'h-7 gap-1.5 px-2 text-[12px]',
  sm: 'h-8 gap-1.5 px-3 text-[13px]',
  md: 'h-9 gap-2 px-4 text-[13px]',
  lg: 'h-[38px] gap-2 px-5 text-[14px]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    trailing,
    fullWidth = false,
    className,
    disabled,
    children,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-pill font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <svg className="h-3.5 w-3.5 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24">
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
      ) : (
        icon && <span className="flex shrink-0 items-center">{icon}</span>
      )}
      {children}
      {trailing && <span className="flex shrink-0 items-center opacity-70">{trailing}</span>}
    </button>
  );
});
