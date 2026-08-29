/**
 * TicketRow.tsx — one line of the queue.
 *
 * ── This component is drawn thousands of times ───────────────────────────────
 * The queue is a virtualised window over up to 100 000 rows. ~40 rows are
 * mounted at any moment, and the shared ticker re-renders all of them once a
 * second so the SLA countdowns stay honest. That budget is what dictates every
 * decision in this file:
 *
 *  1. NO CONTEXT SUBSCRIPTIONS OF ITS OWN. No `useTranslation`, no store hook,
 *     no `usePresence`. Every literal string arrives as a pre-translated
 *     `labels` object built ONCE by the queue. A row that subscribed to i18n
 *     and to the ticket store would re-render on events that cannot change a
 *     single pixel of it.
 *
 *  2. NO DATE LIBRARY CALLS IN RENDER. `Date.parse` runs inside a `useMemo`
 *     keyed on the ISO string, so it happens once per row per value change, not
 *     once per tick. `toLocaleString` — genuinely expensive — only ever runs for
 *     the `title=` tooltip, also memoised.
 *
 *  3. MEMOISED ON WHAT IT ACTUALLY SHOWS. The comparator lists the displayed
 *     fields by name rather than comparing the ticket by reference: the store
 *     hands back a NEW ticket object on every optimistic patch and every socket
 *     frame, and a reference compare would repaint the whole viewport when one
 *     invisible custom field changed on one row.
 *
 * ── One row, no layout thrash ───────────────────────────────────────────────
 * The line is a CSS grid with a FIXED column template per density. Nothing here
 * sizes itself from its content, so a 40-character subject and a 4-character
 * one produce byte-identical geometry and scrolling never reflows the columns.
 * The flexible cell carries `min-w-0` so a long subject truncates instead of
 * pushing the SLA chip off the right edge.
 *
 * HARD RULE 11 — no border anywhere. Selection, focus and "currently open" are
 * three different background steps plus an accent rail drawn as a background,
 * never an outline.
 */
import { memo, useMemo, type CSSProperties, type MouseEvent } from 'react';
import { clsx } from 'clsx';
import type { SlaInstance, TicketWithRelations } from '@oblidesk/shared';
import { UserAvatar } from '@/components/common/UserAvatar';
import type { Density } from '@/store/uiStore';
import PriorityBadge from './PriorityBadge';
import SlaChip, { formatAbsolute, formatDurationShort, nearestInstance } from './SlaChip';
import StatusPill from './StatusPill';

// ═════════════════════════════════════════════════════════════════════════════
// Geometry
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The virtualiser needs an exact height BEFORE the row exists, so these are the
 * contract between the two files. Change one and the other must follow, which
 * is why they live here next to the markup that has to honour them.
 */
export const TICKET_ROW_HEIGHT: Readonly<Record<Density, number>> = {
  comfortable: 58,
  compact: 34,
};

/**
 * Fixed track widths. `1fr` is the subject; everything else is rigid so the
 * columns of two adjacent rows line up whatever they contain.
 */
const GRID_TEMPLATE: Readonly<Record<Density, string>> = {
  comfortable: '26px 108px minmax(0,1fr) 132px 58px 92px 118px 26px 62px',
  compact: '26px 100px minmax(0,1fr) 118px 52px 84px 104px 24px 56px',
};

// ═════════════════════════════════════════════════════════════════════════════
// Strings — supplied, never resolved here
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every user-visible literal the row can draw (HARD RULE 10 — translated by the
 * queue, which calls `t()` once, instead of by 40 rows that each would).
 */
export interface TicketRowLabels {
  select: string;
  deselect: string;
  unassigned: string;
  noQueue: string;
  noSla: string;
  noRequester: string;
  age: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  requester: string;
  queue: string;
  reopened: string;
}

export interface TicketRowProps {
  ticket: TicketWithRelations;
  /** Position in the display order — the queue needs it back for shift-range. */
  index: number;
  density: Density;
  selected: boolean;
  /** The keyboard cursor. Exactly one row has it. */
  focused: boolean;
  /** Open in the centre pane. Distinct from focused: the cursor may have moved on. */
  active: boolean;
  /** Draw the selection column. On while any row is selected, or on hover. */
  selectable: boolean;
  /** Shared ticker from the queue — see the header of SlaChip. */
  now: number;
  labels: TicketRowLabels;
  onOpen: (ticketId: number, index: number) => void;
  /** `shift` asks the queue to extend the range from its anchor. */
  onToggleSelect: (ticketId: number, index: number, shift: boolean) => void;
  /** Absolute positioning from the virtualiser. */
  style?: CSSProperties;
}

// ═════════════════════════════════════════════════════════════════════════════
// Change detection
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The SLA state, flattened to a string.
 *
 * `slaInstances` is a fresh array on every fetch, so comparing it by reference
 * repaints every row on every refresh. What the row DRAWS is the nearest chip,
 * and this is exactly the data that chip renders from.
 */
function slaSignature(instances: readonly SlaInstance[] | undefined): string {
  const nearest = nearestInstance(instances);
  if (!nearest) return '';
  return `${nearest.id}|${nearest.status}|${nearest.dueAt}|${nearest.breachedAt ?? ''}|${nearest.running}`;
}

function requesterOf(ticket: TicketWithRelations): string | null {
  const contact = ticket.requesterContact;
  if (contact) return contact.displayName?.trim() || contact.email;
  return null;
}

function assigneeNameOf(ticket: TicketWithRelations): string | null {
  const assignee = ticket.assignee;
  if (!assignee) return null;
  return assignee.displayName?.trim() || assignee.username;
}

// ═════════════════════════════════════════════════════════════════════════════
// Component
// ═════════════════════════════════════════════════════════════════════════════

function TicketRowImpl({
  ticket,
  index,
  density,
  selected,
  focused,
  active,
  selectable,
  now,
  labels,
  onOpen,
  onToggleSelect,
  style,
}: TicketRowProps): JSX.Element {
  const compact = density === 'compact';

  // Parsed once per value change, never per tick.
  const occurredMs = useMemo(() => Date.parse(ticket.occurredAt), [ticket.occurredAt]);

  // `toLocaleString` is the expensive call in this file. It runs here, on mount
  // and on a timestamp change, and never during the one-second repaint.
  const timesTitle = useMemo(
    () =>
      [
        `${labels.occurredAt} ${formatAbsolute(ticket.occurredAt)}`,
        `${labels.createdAt} ${formatAbsolute(ticket.createdAt)}`,
        `${labels.updatedAt} ${formatAbsolute(ticket.updatedAt)}`,
      ].join('\n'),
    [ticket.occurredAt, ticket.createdAt, ticket.updatedAt, labels],
  );

  const nearestSla = useMemo(() => nearestInstance(ticket.slaInstances), [ticket.slaInstances]);
  const requester = requesterOf(ticket);
  const assigneeName = assigneeNameOf(ticket);

  // Age is measured from `occurredAt`, not `createdAt` (HARD RULE 6): an alert
  // that fired at 02:14 and was ticketed at 08:30 is six hours old, not five
  // minutes old, and the queue is where that has to be visible.
  const age = Number.isNaN(occurredMs) ? '—' : formatDurationShort(Math.max(0, now - occurredMs));

  const handleClick = (): void => onOpen(ticket.id, index);

  const handleSelect = (event: MouseEvent): void => {
    // The row underneath must not also open the ticket.
    event.stopPropagation();
    onToggleSelect(ticket.id, index, event.shiftKey);
  };

  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected}
      tabIndex={-1}
      onClick={handleClick}
      onDoubleClick={handleClick}
      style={{ ...style, gridTemplateColumns: GRID_TEMPLATE[density] }}
      className={clsx(
        'group absolute left-0 top-0 grid w-full cursor-pointer items-center gap-x-2 pl-1 pr-3 text-left transition-colors',
        // HARD RULE 11: depth by background step, never an outline. The accent
        // rail on the open row is an inset shadow, which is a paint, not a box
        // model change — so turning it on cannot shift a single pixel.
        active
          ? 'bg-bg-active shadow-[inset_3px_0_0_0_rgb(var(--c-accent))]'
          : selected
            ? 'bg-accent/10'
            : focused
              ? 'bg-bg-hover'
              : 'bg-transparent hover:bg-bg-hover',
      )}
    >
      {/* ── Selection ────────────────────────────────────────────────────── */}
      <div className="flex h-full items-center justify-center">
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? labels.deselect : labels.select}
          title={selected ? labels.deselect : labels.select}
          onClick={handleSelect}
          className={clsx(
            'h-[15px] w-[15px] shrink-0 rounded-[4px] transition-colors',
            selected
              ? 'bg-accent'
              : clsx(
                  'bg-bg-tertiary hover:bg-bg-active',
                  // The column keeps its width always — only the ink appears —
                  // so selecting a row never reflows the line.
                  selectable || focused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                ),
          )}
        >
          {selected && (
            <svg viewBox="0 0 14 14" className="h-full w-full text-bg-primary" aria-hidden>
              <path
                d="M3.5 7.2 6 9.7l4.6-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      </div>

      {/* ── Number ───────────────────────────────────────────────────────── */}
      <span
        className={clsx(
          'truncate font-mono tracking-[0.03em]',
          compact ? 'text-[11px]' : 'text-[12px]',
          active ? 'text-accent' : 'text-text-secondary',
        )}
      >
        {ticket.number}
      </span>

      {/* ── Subject (+ requester) ────────────────────────────────────────── */}
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={clsx(
              'truncate',
              compact ? 'text-[12px]' : 'text-[13px]',
              active ? 'font-medium text-text-primary' : 'text-text-primary',
            )}
            title={ticket.subject}
          >
            {ticket.subject}
          </span>
          {ticket.reopenCount > 0 && (
            <span
              className="shrink-0 rounded-pill bg-sla-warn-bg px-1.5 py-px font-mono text-[10px] text-sla-warn"
              title={labels.reopened}
            >
              ×{ticket.reopenCount}
            </span>
          )}
        </div>

        {/* The second line exists only at comfortable density; compact keeps a
            single 34px line so 100k rows stay scannable. */}
        {!compact && (
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-text-muted">
            <span className="truncate" title={requester ? `${labels.requester} · ${requester}` : undefined}>
              {requester ?? labels.noRequester}
            </span>
            {ticket.organization && (
              <>
                <span aria-hidden className="opacity-50">
                  ·
                </span>
                <span className="truncate">{ticket.organization.name}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Status ───────────────────────────────────────────────────────── */}
      <div className="min-w-0">
        <StatusPill
          statusSlug={ticket.statusSlug}
          category={ticket.statusCategory}
          label={ticket.status?.label ?? ticket.statusSlug}
          size="sm"
          className="max-w-full"
        />
      </div>

      {/* ── Priority ─────────────────────────────────────────────────────── */}
      <div className="min-w-0">
        <PriorityBadge
          prioritySlug={ticket.prioritySlug}
          rank={ticket.priority?.rank}
          label={ticket.priority?.label ?? ticket.prioritySlug}
          size="sm"
        />
      </div>

      {/* ── SLA ──────────────────────────────────────────────────────────── */}
      <div className="min-w-0">
        {nearestSla ? (
          <SlaChip instance={nearestSla} now={now} size="sm" />
        ) : (
          <span className="font-mono text-[10px] text-text-muted" title={labels.noSla}>
            {labels.noSla}
          </span>
        )}
      </div>

      {/* ── Queue ────────────────────────────────────────────────────────── */}
      <span
        className="truncate text-[11px] text-text-secondary"
        title={`${labels.queue} · ${ticket.queue?.name ?? ticket.queueSlug}`}
      >
        {ticket.queue?.name ?? ticket.queueSlug ?? labels.noQueue}
      </span>

      {/* ── Assignee ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-center">
        {ticket.assignee ? (
          <UserAvatar
            avatar={ticket.assignee.avatar}
            username={assigneeName ?? ticket.assignee.username}
            size={compact ? 18 : 20}
            title={assigneeName ?? undefined}
          />
        ) : (
          <span
            aria-label={labels.unassigned}
            title={labels.unassigned}
            className={clsx(
              'rounded-full bg-bg-tertiary',
              compact ? 'h-[18px] w-[18px]' : 'h-5 w-5',
            )}
          />
        )}
      </div>

      {/* ── Age ──────────────────────────────────────────────────────────── */}
      <span
        className="truncate text-right font-mono text-[11px] tabular-nums text-text-muted"
        title={timesTitle}
      >
        {age}
      </span>
    </div>
  );
}

/**
 * The comparator, field by field.
 *
 * Everything listed here is something the row paints. Anything NOT listed is
 * something a change to which must not cost a repaint — which is the whole
 * point of writing it out by hand instead of shallow-comparing the ticket.
 */
function areEqual(a: TicketRowProps, b: TicketRowProps): boolean {
  if (
    a.index !== b.index ||
    a.density !== b.density ||
    a.selected !== b.selected ||
    a.focused !== b.focused ||
    a.active !== b.active ||
    a.selectable !== b.selectable ||
    a.now !== b.now ||
    a.labels !== b.labels ||
    a.onOpen !== b.onOpen ||
    a.onToggleSelect !== b.onToggleSelect
  ) {
    return false;
  }

  // The virtualiser hands a fresh style object every measure pass; only the
  // offset inside it can actually move the row.
  if (a.style?.height !== b.style?.height || a.style?.transform !== b.style?.transform) return false;

  const x = a.ticket;
  const y = b.ticket;
  if (x === y) return true;

  return (
    x.id === y.id &&
    x.number === y.number &&
    x.subject === y.subject &&
    x.statusSlug === y.statusSlug &&
    x.statusCategory === y.statusCategory &&
    (x.status?.label ?? null) === (y.status?.label ?? null) &&
    x.prioritySlug === y.prioritySlug &&
    (x.priority?.rank ?? null) === (y.priority?.rank ?? null) &&
    (x.priority?.label ?? null) === (y.priority?.label ?? null) &&
    x.queueSlug === y.queueSlug &&
    (x.queue?.name ?? null) === (y.queue?.name ?? null) &&
    x.assigneeId === y.assigneeId &&
    (x.assignee?.avatar ?? null) === (y.assignee?.avatar ?? null) &&
    assigneeNameOf(x) === assigneeNameOf(y) &&
    requesterOf(x) === requesterOf(y) &&
    (x.organization?.name ?? null) === (y.organization?.name ?? null) &&
    x.reopenCount === y.reopenCount &&
    x.occurredAt === y.occurredAt &&
    x.createdAt === y.createdAt &&
    x.updatedAt === y.updatedAt &&
    slaSignature(x.slaInstances) === slaSignature(y.slaInstances)
  );
}

export const TicketRow = memo(TicketRowImpl, areEqual);

export default TicketRow;
