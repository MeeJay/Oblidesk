/**
 * PriorityBadge.tsx — the P1…P4 chip.
 *
 * Priorities are configurable per tenant (`priority_matrix` config kind), so
 * the SLUG and the LABEL are whatever the tenant chose. What is NOT
 * configurable is `PrioritySpec.rank` (1 = most urgent), and the rank is what
 * selects the colour token — the same discipline as the status category.
 * A tenant that names its top priority `urgence-absolue` still gets the P1 red.
 *
 * ── Overrides are visible, always ────────────────────────────────────────────
 * A priority the impact × urgency matrix did not produce carries a
 * `priorityOverrideReason`. That is not a footnote: somebody deliberately
 * disagreed with the matrix, and the next person to look at the ticket has to
 * be able to see that at a glance and read why. The chip grows a small caret
 * and the reason rides in the tooltip.
 */
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';

type Rank = 1 | 2 | 3 | 4;

const RANK_CLASSES: Readonly<Record<Rank, string>> = {
  1: 'bg-priority-p1-bg text-priority-p1',
  2: 'bg-priority-p2-bg text-priority-p2',
  3: 'bg-priority-p3-bg text-priority-p3',
  4: 'bg-priority-p4-bg text-priority-p4',
};

/**
 * Best-effort rank from a slug, used when the caller could not join the
 * priority config (the list endpoint does not, on purpose — 100 000 rows must
 * not cost 100 000 joins).
 *
 * The baseline bundle ships `p1`…`p4`; anything else falls back to rank 3,
 * which is the neutral middle. Guessing "1" for an unknown slug would paint a
 * tenant's custom "documentation" priority blood red.
 */
export function priorityRankFromSlug(slug: string | null | undefined, rank?: number | null): Rank {
  if (typeof rank === 'number' && rank >= 1 && rank <= 4) return rank as Rank;
  const match = /^p([1-4])$/i.exec((slug ?? '').trim());
  if (match) return Number(match[1]) as Rank;
  return 3;
}

export function priorityClasses(rank: number): string {
  return RANK_CLASSES[priorityRankFromSlug(null, rank)];
}

export interface PriorityBadgeProps {
  prioritySlug: string;
  /** `PrioritySpec.rank` when the caller joined the priority config. */
  rank?: number | null;
  /** `PrioritySpec.label` when joined; the slug otherwise. */
  label?: string | null;
  /** Set when the value disagrees with the impact × urgency matrix. */
  overrideReason?: string | null;
  size?: 'sm' | 'md';
  className?: string;
}

export default function PriorityBadge({
  prioritySlug,
  rank,
  label,
  overrideReason,
  size = 'md',
  className,
}: PriorityBadgeProps): JSX.Element {
  const { t } = useTranslation();
  const resolved = priorityRankFromSlug(prioritySlug, rank);
  const text = label?.trim() || prioritySlug.toUpperCase();

  const title = overrideReason
    ? `${t('ticket.priority.overridden', 'Priorité forcée à la main')} : ${overrideReason}`
    : `${t('ticket.priority.label', 'Priorité')} ${text} (P${resolved})`;

  return (
    <span
      title={title}
      aria-label={title}
      className={clsx(
        'inline-flex items-center gap-1 rounded-pill font-mono font-medium uppercase tracking-[0.06em]',
        size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]',
        RANK_CLASSES[resolved],
        className,
      )}
    >
      {text}
      {overrideReason ? (
        <span aria-hidden className="text-[10px] leading-none opacity-80">
          &#9650;
        </span>
      ) : null}
    </span>
  );
}
