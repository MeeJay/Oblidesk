import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/utils/cn';

/** Autosave lifecycle for an inline ticket field (HARD RULE 12). */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Already-translated label. */
  label?: string;
  /** Server-side / format error. NEVER a required-ness complaint — see below. */
  error?: string;
  /** Quiet helper line under the field. */
  hint?: string;
  /** Leading adornment (an icon, a currency symbol). */
  icon?: ReactNode;
  /** Trailing adornment (a unit, a clear button). */
  trailing?: ReactNode;
  size?: 'sm' | 'md';
  /**
   * HARD RULE 12 — a field may be required *by a state transition* without
   * being required to type in. Setting this paints a quiet accent dot and an
   * explanatory tooltip; it never blocks the autosave and never renders a
   * validation error. Required-ness is enforced at the transition, by the
   * shared evaluator, on both sides.
   */
  requiredForTransition?: boolean;
  /** Tooltip for that dot — pass a translated string. */
  requiredForTransitionHint?: string;
  /** Inline autosave indicator shown on the label row. */
  saveState?: SaveState;
  /** Translated captions for `saveState`. */
  saveLabels?: Partial<Record<Exclude<SaveState, 'idle'>, string>>;
  wrapperClassName?: string;
}

const SIZES = {
  sm: 'h-8 text-[13px]',
  md: 'h-9 text-[13px]',
} as const;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    error,
    hint,
    icon,
    trailing,
    size = 'md',
    requiredForTransition = false,
    requiredForTransitionHint,
    saveState = 'idle',
    saveLabels,
    className,
    wrapperClassName,
    id,
    ...props
  },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;

  return (
    <div className={cn('flex flex-col gap-1', wrapperClassName)}>
      {(label || saveState !== 'idle') && (
        <div className="flex items-baseline justify-between gap-2">
          {label && (
            <label
              htmlFor={inputId}
              className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary"
            >
              {label}
              {requiredForTransition && (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-accent"
                  title={requiredForTransitionHint}
                  aria-hidden
                />
              )}
            </label>
          )}
          {saveState !== 'idle' && (
            <span
              className={cn(
                'font-mono text-[10px] uppercase tracking-[0.14em]',
                saveState === 'saving' && 'text-text-muted',
                saveState === 'saved' && 'text-status-resolved',
                saveState === 'error' && 'text-sla-breach',
              )}
            >
              {saveLabels?.[saveState] ?? saveState}
            </span>
          )}
        </div>
      )}

      <div
        className={cn(
          // No border (HARD RULE 11) — the raised tertiary surface is the field.
          'flex items-center gap-2 rounded-pill bg-bg-tertiary px-3 transition-shadow',
          'focus-within:ring-1 focus-within:ring-accent',
          error && 'ring-1 ring-sla-breach/70',
          props.disabled && 'opacity-50',
          SIZES[size],
        )}
      >
        {icon && <span className="flex shrink-0 items-center text-text-muted">{icon}</span>}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-text-primary outline-none',
            'placeholder:text-text-muted disabled:cursor-not-allowed',
            className,
          )}
          {...props}
        />
        {trailing && <span className="flex shrink-0 items-center text-text-muted">{trailing}</span>}
      </div>

      {error ? (
        <p className="text-[11px] text-sla-breach">{error}</p>
      ) : (
        hint && <p className="text-[11px] text-text-muted">{hint}</p>
      )}
    </div>
  );
});
