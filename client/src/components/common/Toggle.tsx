import { clsx } from 'clsx';
import { useId } from 'react';

/**
 * The ONE switch in Oblidesk.
 *
 * Ten files were hand-rolling their own before this existed, and they drifted:
 * different track sizes, different knob travel, different disabled treatment,
 * some with an accessible name and some without. On one screen you could see a
 * large accent pill next to two small dark ones and reasonably wonder whether
 * they meant different things. They did not.
 *
 * Design system rules that apply here (D:\Mockup\obli-design-system.md §2, §8):
 *   - no `border` on the track; the OFF state reads as a background step
 *     (`bg-bg-tertiary`) against the surface behind it
 *   - ON is the app accent, flat, no gradient
 *   - the hit area is at least 32px tall even though the track is 20px, because
 *     a 20px tap target is a miss on a laptop trackpad
 *
 * Accessibility: this is a real `<button role="switch">` with `aria-checked`,
 * so a screen reader announces the state and the space bar toggles it. It takes
 * either a `label` (rendered) or an `aria-label` (not) — a switch with neither
 * announces as "button", which tells the user nothing.
 */

export type ToggleSize = 'sm' | 'md';

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Visible label, placed after the switch. */
  label?: React.ReactNode;
  /** Second line under the label, for the "what does this actually do" sentence. */
  description?: React.ReactNode;
  /** Required when there is no visible `label`. */
  'aria-label'?: string;
  disabled?: boolean;
  /** Why it is disabled. Shown as a title so the reason is discoverable. */
  disabledReason?: string;
  size?: ToggleSize;
  /** Put the switch after the label instead of before it (settings rows). */
  labelFirst?: boolean;
  className?: string;
  name?: string;
}

const TRACK: Record<ToggleSize, string> = {
  sm: 'h-4 w-7',
  md: 'h-5 w-9',
};

const KNOB: Record<ToggleSize, string> = {
  sm: 'h-3 w-3',
  md: 'h-4 w-4',
};

/** Knob travel = track width − knob width − (2 × inset). */
const TRAVEL: Record<ToggleSize, string> = {
  sm: 'translate-x-3',
  md: 'translate-x-4',
};

export function Toggle({
  checked,
  onChange,
  label,
  description,
  'aria-label': ariaLabel,
  disabled = false,
  disabledReason,
  size = 'md',
  labelFirst = false,
  className,
  name,
}: ToggleProps) {
  const labelId = useId();

  const control = (
    <button
      type="button"
      role="switch"
      name={name}
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      aria-labelledby={label ? labelId : undefined}
      aria-disabled={disabled || undefined}
      title={disabled ? disabledReason : undefined}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={clsx(
        'relative inline-flex shrink-0 items-center rounded-pill transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary',
        TRACK[size],
        checked ? 'bg-accent' : 'bg-bg-tertiary',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'pointer-events-none inline-block transform rounded-full bg-white shadow-sm transition-transform duration-150',
          KNOB[size],
          checked ? TRAVEL[size] : 'translate-x-0.5',
        )}
      />
    </button>
  );

  if (!label && !description) {
    return <span className={className}>{control}</span>;
  }

  const text = (
    <span className="flex min-w-0 flex-col">
      {label && (
        <span
          id={labelId}
          className={clsx('text-[13px]', disabled ? 'text-text-muted' : 'text-text-primary')}
        >
          {label}
        </span>
      )}
      {description && (
        <span className="mt-0.5 text-[12px] leading-snug text-text-muted">{description}</span>
      )}
    </span>
  );

  return (
    <label
      className={clsx(
        'flex items-start gap-3 py-1',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        labelFirst && 'justify-between',
        className,
      )}
    >
      {labelFirst ? (
        <>
          {text}
          {control}
        </>
      ) : (
        <>
          <span className="pt-px">{control}</span>
          {text}
        </>
      )}
    </label>
  );
}

export default Toggle;
