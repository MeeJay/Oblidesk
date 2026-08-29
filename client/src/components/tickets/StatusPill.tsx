/**
 * StatusPill.tsx — the status chip.
 *
 * ── The one thing this component gets right ──────────────────────────────────
 * It paints from the CATEGORY, never from the slug (HARD RULE 5). A tenant may
 * rename "Pending" to "En attente du client" and give it the slug
 * `waiting-customer`; the chip still paints `pending_requester` amber because
 * the category is hard-coded on the status config and is what every engine —
 * and every pixel — keys off.
 *
 * The LABEL comes from the configured status (`ticket.status.label`, the slug
 * as a last resort). The COLOUR comes from the category. Mixing those two up is
 * how a desk ends up with a beautiful chip that lies about the SLA clock.
 *
 * ── No border (HARD RULE 11) ─────────────────────────────────────────────────
 * Depth is the background step plus the text tone. There is no ring, no
 * outline, no 1px anything.
 */
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  STATUS_CATEGORY_META,
  pausesSla,
  statusCategoryLabel,
  toStatusCategory,
} from '@oblidesk/shared';
import type { StatusCategory } from '@oblidesk/shared';

/**
 * Tailwind cannot see a class it has to concatenate at runtime, so the mapping
 * is a literal table. `status-${category.replace(/_/g,'-')}` is the documented
 * convention (tailwind.config.ts) — this table is that convention written out
 * so the JIT actually emits the eight pairs.
 */
const CATEGORY_CLASSES: Readonly<Record<StatusCategory, string>> = {
  new: 'bg-status-new-bg text-status-new',
  open: 'bg-status-open-bg text-status-open',
  pending_requester: 'bg-status-pending-requester-bg text-status-pending-requester',
  pending_third_party: 'bg-status-pending-third-party-bg text-status-pending-third-party',
  scheduled: 'bg-status-scheduled-bg text-status-scheduled',
  resolved: 'bg-status-resolved-bg text-status-resolved',
  closed: 'bg-status-closed-bg text-status-closed',
  cancelled: 'bg-status-cancelled-bg text-status-cancelled',
};

/** Just the dot colour — for dense rows where a full pill is too much ink. */
const CATEGORY_DOT: Readonly<Record<StatusCategory, string>> = {
  new: 'bg-status-new',
  open: 'bg-status-open',
  pending_requester: 'bg-status-pending-requester',
  pending_third_party: 'bg-status-pending-third-party',
  scheduled: 'bg-status-scheduled',
  resolved: 'bg-status-resolved',
  closed: 'bg-status-closed',
  cancelled: 'bg-status-cancelled',
};

export function statusCategoryClasses(category: StatusCategory): string {
  return CATEGORY_CLASSES[category];
}

export function statusCategoryDot(category: StatusCategory): string {
  return CATEGORY_DOT[category];
}

export interface StatusPillProps {
  /** The tenant's slug — shown only when there is no configured label. */
  statusSlug: string;
  /** HARD RULE 5 — mandatory. Everything visual is decided by this. */
  category: StatusCategory | string;
  /** The configured `StatusSpec.label`, when the caller joined it. */
  label?: string | null;
  size?: 'sm' | 'md';
  /** Render the category name under the label — used in the transition menu. */
  showCategory?: boolean;
  className?: string;
}

export default function StatusPill({
  statusSlug,
  category,
  label,
  size = 'md',
  showCategory = false,
  className,
}: StatusPillProps): JSX.Element {
  const { t } = useTranslation();
  const cat = toStatusCategory(category);
  const meta = STATUS_CATEGORY_META[cat];
  const categoryText = statusCategoryLabel(cat);

  // The configured label wins; the slug is the honest fallback. Never invent a
  // pretty name for a status the tenant has not named.
  const text = label?.trim() || statusSlug;

  // The tooltip is where the category becomes visible without cluttering the
  // row: "Statut « Attente client » — catégorie pending_requester (SLA en pause)".
  const title = [
    t('ticket.status.tooltip', 'Statut'),
    ` « ${text} », `,
    t('ticket.status.categoryIs', 'catégorie'),
    ` ${cat}`,
    pausesSla(cat) ? ` · ${t('sla.paused', 'SLA en pause')}` : '',
    meta.terminal ? ` · ${t('ticket.status.terminal', 'état terminal')}` : '',
  ].join('');

  return (
    <span
      title={title}
      aria-label={title}
      className={clsx(
        'inline-flex max-w-full items-center gap-1.5 rounded-pill font-medium',
        size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[12px]',
        CATEGORY_CLASSES[cat],
        className,
      )}
    >
      <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', CATEGORY_DOT[cat])} aria-hidden />
      <span className="truncate">{text}</span>
      {showCategory && (
        <span className="ml-0.5 shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] opacity-70">
          {t(categoryText.key, categoryText.fallback)}
        </span>
      )}
    </span>
  );
}
