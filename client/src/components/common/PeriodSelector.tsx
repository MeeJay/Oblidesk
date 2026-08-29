import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';

/** The dashboard's activity-chart windows (design system §14.2). */
export const DEFAULT_PERIODS = ['24h', '7j', '14j', '30j'] as const;
export type Period = string;

interface PeriodSelectorProps {
  value: Period;
  onChange: (period: Period) => void;
  /** Override the window list — reports use 90j / 12m, the dashboard does not. */
  periods?: readonly Period[];
  size?: 'sm' | 'md';
  /** Translated label announced to screen readers. */
  ariaLabel?: string;
  className?: string;
}

/**
 * Segmented range picker. HARD RULE 11 — the group is a recessed
 * `bg-bg-tertiary` trough and the active segment is a raised `bg-bg-active`
 * tile; there is no border and no outline anywhere.
 *
 * Labels go through `t()` because "7j"/"30j" are French day abbreviations that
 * become "7d"/"30d" in English.
 */
export function PeriodSelector({
  value,
  onChange,
  periods = DEFAULT_PERIODS,
  size = 'sm',
  ariaLabel,
  className,
}: PeriodSelectorProps) {
  const { t } = useTranslation();

  return (
    <div
      role="tablist"
      aria-label={ariaLabel ?? t('common.period', 'Periode')}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-pill bg-bg-tertiary p-0.5',
        className,
      )}
    >
      {periods.map((period) => {
        const active = value === period;
        return (
          <button
            key={period}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(period)}
            className={cn(
              'rounded-[5px] font-mono font-medium uppercase tracking-[0.06em] transition-colors',
              size === 'sm' ? 'h-6 px-2.5 text-[11px]' : 'h-7 px-3 text-[12px]',
              active
                ? 'bg-bg-active text-text-primary'
                : 'text-text-muted hover:bg-bg-hover hover:text-text-secondary',
            )}
          >
            {t(`period.${period}`, period)}
          </button>
        );
      })}
    </div>
  );
}
