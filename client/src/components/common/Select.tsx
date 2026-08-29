import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { SaveState } from './Input';

export interface SelectOption {
  value: string;
  /** Already-translated label. */
  label: string;
  disabled?: boolean;
  /** Optional group heading — options sharing one are wrapped in an <optgroup>. */
  group?: string;
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'children'> {
  label?: string;
  error?: string;
  hint?: string;
  icon?: ReactNode;
  size?: 'sm' | 'md';
  options: SelectOption[];
  /** Rendered as a disabled first entry when the value is empty. Translated. */
  placeholder?: string;
  /** See Input — a transition may require this field; typing never does. */
  requiredForTransition?: boolean;
  requiredForTransitionHint?: string;
  saveState?: SaveState;
  saveLabels?: Partial<Record<Exclude<SaveState, 'idle'>, string>>;
  wrapperClassName?: string;
}

const SIZES = {
  sm: 'h-8 text-[13px]',
  md: 'h-9 text-[13px]',
} as const;

/**
 * Native <select> under an Obli skin: the browser keeps the keyboard behaviour
 * and the mobile sheet, we keep the token surface and drop the border
 * (HARD RULE 11). `appearance-none` plus our own chevron so the control looks
 * the same on every platform.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    label,
    error,
    hint,
    icon,
    size = 'md',
    options,
    placeholder,
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
  const selectId = id ?? autoId;

  // Preserve declaration order while collecting groups.
  const groups: Array<{ name: string | null; items: SelectOption[] }> = [];
  for (const option of options) {
    const name = option.group ?? null;
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push(option);
    else groups.push({ name, items: [option] });
  }

  return (
    <div className={cn('flex flex-col gap-1', wrapperClassName)}>
      {(label || saveState !== 'idle') && (
        <div className="flex items-baseline justify-between gap-2">
          {label && (
            <label
              htmlFor={selectId}
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
          'relative flex items-center gap-2 rounded-pill bg-bg-tertiary px-3 transition-shadow',
          'focus-within:ring-1 focus-within:ring-accent',
          error && 'ring-1 ring-sla-breach/70',
          props.disabled && 'opacity-50',
          SIZES[size],
        )}
      >
        {icon && <span className="flex shrink-0 items-center text-text-muted">{icon}</span>}
        <select
          ref={ref}
          id={selectId}
          className={cn(
            'min-w-0 flex-1 appearance-none bg-transparent pr-5 text-text-primary outline-none',
            'disabled:cursor-not-allowed',
            // The popup list is painted by the OS: give it a readable surface
            // instead of inheriting `transparent` and rendering white-on-white.
            '[&>option]:bg-bg-secondary [&>option]:text-text-primary',
            '[&>optgroup]:bg-bg-secondary [&>optgroup]:text-text-muted',
            className,
          )}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {groups.map((group, index) =>
            group.name === null ? (
              group.items.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))
            ) : (
              <optgroup key={`${group.name}-${index}`} label={group.name}>
                {group.items.map((option) => (
                  <option key={option.value} value={option.value} disabled={option.disabled}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ),
          )}
        </select>
        <ChevronDown
          size={13}
          className="pointer-events-none absolute right-2.5 shrink-0 text-text-muted"
        />
      </div>

      {error ? (
        <p className="text-[11px] text-sla-breach">{error}</p>
      ) : (
        hint && <p className="text-[11px] text-text-muted">{hint}</p>
      )}
    </div>
  );
});
