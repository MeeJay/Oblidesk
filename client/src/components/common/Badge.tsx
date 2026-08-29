import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { STATUS_CATEGORY_META, type StatusCategory } from '@oblidesk/shared';
import { cn } from '@/utils/cn';

export type BadgeTone =
  | 'accent'
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'muted';

export type BadgeSize = 'xs' | 'sm' | 'md';

/**
 * Tailwind can only see class names that appear LITERALLY in the source, so
 * every one of these maps is written out rather than composed from a template
 * string. `bg-status-${category}` would compile to nothing and the pill would
 * paint transparent.
 */
const TONES: Record<BadgeTone, string> = {
  accent: 'bg-accent/12 text-accent',
  neutral: 'bg-bg-tertiary text-text-secondary',
  info: 'bg-status-new-bg text-status-new',
  success: 'bg-sla-ok-bg text-sla-ok',
  warning: 'bg-sla-warn-bg text-sla-warn',
  danger: 'bg-sla-breach-bg text-sla-breach',
  muted: 'bg-bg-tertiary text-text-muted',
};

const SIZES: Record<BadgeSize, string> = {
  xs: 'h-[18px] gap-1 px-1.5 text-[10px]',
  sm: 'h-[22px] gap-1.5 px-2 text-[11px]',
  md: 'h-[26px] gap-1.5 px-2.5 text-[12px]',
};

interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  size?: BadgeSize;
  /** Small filled dot on the left, in the badge's own colour. */
  dot?: boolean;
  /** Render the label in JetBrains Mono — for counts, keys and clocks. */
  mono?: boolean;
  icon?: ReactNode;
  title?: string;
  className?: string;
}

/**
 * Pill. HARD RULE 11 — no border: the pill is a tinted background plus a
 * saturated foreground, both from the same token pair.
 */
export function Badge({
  children,
  tone = 'neutral',
  size = 'sm',
  dot = false,
  mono = false,
  icon,
  title,
  className,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center rounded-pill font-medium leading-none',
        mono && 'font-mono tracking-[0.02em]',
        TONES[tone],
        SIZES[size],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />}
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

// ── Status ───────────────────────────────────────────────────────────────────

/**
 * HARD RULE 5 — the colour comes from the hard-coded CATEGORY, never from the
 * tenant's status slug. A tenant renaming "Pending" to "En attente client"
 * changes the LABEL only; the pill stays amber because the category is still
 * `pending_requester`.
 */
const STATUS_CLASSES: Record<StatusCategory, string> = {
  new: 'bg-status-new-bg text-status-new',
  open: 'bg-status-open-bg text-status-open',
  pending_requester: 'bg-status-pending-requester-bg text-status-pending-requester',
  pending_third_party: 'bg-status-pending-third-party-bg text-status-pending-third-party',
  scheduled: 'bg-status-scheduled-bg text-status-scheduled',
  resolved: 'bg-status-resolved-bg text-status-resolved',
  closed: 'bg-status-closed-bg text-status-closed',
  cancelled: 'bg-status-cancelled-bg text-status-cancelled',
};

interface StatusBadgeProps {
  category: StatusCategory;
  /** The tenant's own status name. Falls back to the category label. */
  label?: string | null;
  size?: BadgeSize;
  dot?: boolean;
  className?: string;
}

export function StatusBadge({
  category,
  label,
  size = 'sm',
  dot = true,
  className,
}: StatusBadgeProps) {
  const { t } = useTranslation();
  const meta = STATUS_CATEGORY_META[category];
  const text = label ?? t(meta.labelKey, meta.label);

  return (
    <span
      // The SLA clock stopping is invisible in the label; say so in the tooltip.
      title={
        meta.pausesSla
          ? t('status.tooltipSlaPaused', 'Le compteur SLA est en pause dans cet etat')
          : text
      }
      className={cn(
        'inline-flex shrink-0 items-center rounded-pill font-medium leading-none',
        STATUS_CLASSES[category],
        SIZES[size],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />}
      <span className="truncate">{text}</span>
    </span>
  );
}

// ── Priority ─────────────────────────────────────────────────────────────────

export type PriorityRank = 1 | 2 | 3 | 4;

const PRIORITY_CLASSES: Record<PriorityRank, string> = {
  1: 'bg-priority-p1-bg text-priority-p1',
  2: 'bg-priority-p2-bg text-priority-p2',
  3: 'bg-priority-p3-bg text-priority-p3',
  4: 'bg-priority-p4-bg text-priority-p4',
};

interface PriorityBadgeProps {
  /** 1 = critical … 4 = low. Out-of-range values clamp to the nearest end. */
  rank: number;
  /** The tenant's own priority name; defaults to "P<rank>". */
  label?: string | null;
  size?: BadgeSize;
  className?: string;
}

export function PriorityBadge({ rank, label, size = 'sm', className }: PriorityBadgeProps) {
  const clamped = (Math.min(4, Math.max(1, Math.round(rank))) || 3) as PriorityRank;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-pill font-mono font-medium leading-none tracking-[0.04em]',
        PRIORITY_CLASSES[clamped],
        SIZES[size],
        className,
      )}
    >
      {label ?? `P${clamped}`}
    </span>
  );
}

// ── SLA clock ────────────────────────────────────────────────────────────────

export type SlaState = 'ok' | 'warn' | 'breach' | 'paused';

const SLA_CLASSES: Record<SlaState, string> = {
  ok: 'bg-sla-ok-bg text-sla-ok',
  warn: 'bg-sla-warn-bg text-sla-warn',
  breach: 'bg-sla-breach-bg text-sla-breach',
  paused: 'bg-sla-paused-bg text-sla-paused',
};

interface SlaBadgeProps {
  state: SlaState;
  /** Pre-formatted remaining / overdue time, e.g. "1h 12m" or "-24m". */
  children: ReactNode;
  size?: BadgeSize;
  icon?: ReactNode;
  title?: string;
  className?: string;
}

export function SlaBadge({ state, children, size = 'sm', icon, title, className }: SlaBadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center rounded-pill font-mono font-medium leading-none',
        SLA_CLASSES[state],
        SIZES[size],
        // A breach is the one thing in the list that should catch the eye.
        state === 'breach' && 'animate-sla-pulse',
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}
