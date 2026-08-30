/**
 * PortalStatus.tsx — how a ticket's state is worded for the person who filed it.
 *
 * ── Keyed on the CATEGORY, never on the slug (HARD RULE 5) ──────────────────
 * Statuses are tenant configuration: one desk calls it "Pending", the next
 * renames it "Waiting on customer", a third ships it in Dutch. Every one of
 * them carries the same mandatory hard-coded category, and that is the only
 * thing this module reads. A tenant renaming a status changes nothing here, and
 * a new tenant status with a known category is worded correctly on the day it
 * is created without anyone touching this file.
 *
 * ── Why the desk's own labels are not reused ────────────────────────────────
 * `STATUS_CATEGORY_META` gives "Pending requester" and "Pending third party",
 * which are exactly right for an agent scanning a queue and exactly wrong for
 * the requester: "pending requester" is the desk describing the customer in the
 * third person, and the customer reading it has to work out that they are the
 * requester and that the ticket is waiting on THEM. The single most useful
 * sentence this portal can put on a row is "waiting for you", so that is what
 * it says.
 *
 * The COLOURS still come from the category tokens, so the two surfaces agree
 * visually even where the wording deliberately differs.
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { StatusCategory } from '@oblidesk/shared';

import { StatusBadge, type BadgeSize } from '@/components/common/Badge';

/**
 * True when the desk is explicitly waiting on the customer to say something.
 *
 * The single most useful bit on the whole list, so it gets a named predicate
 * rather than an inline comparison repeated on the row and in the header.
 */
export function needsRequesterReply(category: StatusCategory): boolean {
  return category === 'pending_requester';
}

/**
 * Customer-facing wording for a category.
 *
 * A hook rather than a constant map because every string goes through `t()`
 * with an inline fallback (HARD RULE 10) and `t` is only available inside a
 * component. The `switch` is exhaustive over the eight categories, so adding a
 * ninth upstream fails the build here rather than rendering a blank pill.
 */
export function usePortalStatusLabel(): (category: StatusCategory) => string {
  const { t } = useTranslation();

  return useCallback(
    (category: StatusCategory): string => {
      switch (category) {
        case 'new':
          return t('portal.status.new', 'Received');
        case 'open':
          return t('portal.status.open', 'In progress');
        case 'pending_requester':
          return t('portal.status.pendingRequester', 'Waiting for you');
        case 'pending_third_party':
          return t('portal.status.pendingThirdParty', 'Waiting on a third party');
        case 'scheduled':
          return t('portal.status.scheduled', 'Scheduled');
        case 'resolved':
          return t('portal.status.resolved', 'Resolved');
        case 'closed':
          return t('portal.status.closed', 'Closed');
        case 'cancelled':
          return t('portal.status.cancelled', 'Cancelled');
        default: {
          // Exhaustiveness guard: `never` here means the union grew and this
          // switch did not. A `default` that returns the raw value would ship a
          // slug-looking string to a customer instead of failing the build.
          const exhaustive: never = category;
          return exhaustive;
        }
      }
    },
    [t],
  );
}

/**
 * The pill. Same colours as the desk, customer wording, no border
 * (HARD RULE 11 — `StatusBadge` is a tinted background plus a saturated
 * foreground from the same token pair).
 */
export function PortalStatusBadge({
  category,
  size = 'sm',
}: {
  category: StatusCategory;
  size?: BadgeSize;
}) {
  const label = usePortalStatusLabel();
  return <StatusBadge category={category} label={label(category)} size={size} />;
}
