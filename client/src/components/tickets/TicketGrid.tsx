/**
 * TicketGrid — the saved view rendered as a dense table.
 *
 * ── Why this exists as its own component ────────────────────────────────────
 * The queue (`TicketQueue` + `TicketRow`) is a reading surface: a fixed
 * nine-column layout tuned so an agent can scan a conversation list. A grid is
 * a different job — comparing many tickets across the columns THIS view cares
 * about — so it is driven by `view.columns`, which is already part of every
 * view definition (`layout: 'table'` has been in the type since the config
 * store was written). Bending TicketRow's frozen template into a configurable
 * one would have made the scan layout worse to give the grid a home.
 *
 * ── What it is not ──────────────────────────────────────────────────────────
 * `/grid` used to be an ALIAS onto `/tickets`, so the sidebar's "Grid view"
 * silently delivered the ticket list instead. An alias is right when two paths
 * name the same page; it is wrong when it makes a distinct feature disappear
 * without saying so, which is what this replaces.
 *
 * Virtualised like the queue: a tenant's "all open" view is tens of thousands
 * of rows, and a table that renders them all locks the tab.
 */
import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { clsx } from 'clsx';
import type { TicketWithRelations } from '@oblidesk/shared';

import type { ViewColumn } from '@/api/views.api';
import StatusPill from '@/components/tickets/StatusPill';
import PriorityBadge from '@/components/tickets/PriorityBadge';
import SlaChip, { nearestInstance, formatAbsolute, formatRelative } from '@/components/tickets/SlaChip';
import { UserAvatar } from '@/components/common/UserAvatar';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

const ROW_HEIGHT = 40;
const HEADER_HEIGHT = 34;

/** Columns whose width the view did not set. Chosen to fit their content. */
const DEFAULT_WIDTH: Readonly<Record<string, number>> = {
  number: 116,
  subject: 420,
  status_slug: 148,
  priority_slug: 104,
  assignee_id: 176,
  queue_slug: 148,
  organization_id: 176,
  requester_contact_id: 200,
  due_at: 140,
  occurred_at: 150,
  created_at: 150,
  updated_at: 150,
  record_type: 116,
  source: 110,
};

/**
 * Header labels. Every one goes through `t()` with an inline English fallback
 * (HARD RULE 10) — a column whose key is missing must read as a word, never as
 * `grid.column.due_at`.
 */
const COLUMN_LABELS: Readonly<Record<string, { key: string; fallback: string }>> = {
  number: { key: 'grid.column.number', fallback: 'Key' },
  subject: { key: 'grid.column.subject', fallback: 'Subject' },
  status_slug: { key: 'grid.column.status', fallback: 'Status' },
  priority_slug: { key: 'grid.column.priority', fallback: 'Priority' },
  assignee_id: { key: 'grid.column.assignee', fallback: 'Assignee' },
  queue_slug: { key: 'grid.column.queue', fallback: 'Queue' },
  organization_id: { key: 'grid.column.organization', fallback: 'Organisation' },
  requester_contact_id: { key: 'grid.column.requester', fallback: 'Requester' },
  due_at: { key: 'grid.column.dueAt', fallback: 'Due' },
  occurred_at: { key: 'grid.column.occurredAt', fallback: 'Happened' },
  created_at: { key: 'grid.column.createdAt', fallback: 'Created' },
  updated_at: { key: 'grid.column.updatedAt', fallback: 'Updated' },
  record_type: { key: 'grid.column.recordType', fallback: 'Type' },
  source: { key: 'grid.column.source', fallback: 'Source' },
};

export interface TicketGridProps {
  tickets: TicketWithRelations[];
  columns: ViewColumn[];
  isLoading: boolean;
  hasMore: boolean;
  onOpen: (ticketId: number) => void;
  onReachEnd: () => void;
  selectedId: number | null;
}

export default function TicketGrid({
  tickets,
  columns,
  isLoading,
  hasMore,
  onOpen,
  onReachEnd,
  selectedId,
}: TicketGridProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  // A view with no configured columns still has to render something useful,
  // and the queue's own default set is the answer the rest of the app already
  // agreed on.
  // The view's own order is the order: `columns` arrives already sequenced by
  // the config store, so re-sorting here would silently override what the
  // person who built the view arranged.
  const cols = useMemo<ViewColumn[]>(() => {
    if (columns.length > 0) return columns;
    return ['number', 'subject', 'status_slug', 'priority_slug', 'assignee_id', 'updated_at'].map(
      (key) => ({ key }),
    );
  }, [columns]);

  const template = useMemo(
    () => cols.map((c) => `${c.width ?? DEFAULT_WIDTH[c.key] ?? 140}px`).join(' '),
    [cols],
  );

  const virtualizer = useVirtualizer({
    count: tickets.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1];

  // Paginate off the viewport rather than a scroll listener: the virtualiser
  // already knows which row is last, and a listener would fire on every pixel.
  if (last && hasMore && !isLoading && last.index >= tickets.length - 5) {
    onReachEnd();
  }

  const cell = useCallback(
    (ticket: TicketWithRelations, field: string) => {
      switch (field) {
        case 'number':
          return <span className="font-mono text-[11px] text-text-secondary">{ticket.number}</span>;
        case 'subject':
          return (
            <span className="truncate text-text-primary" title={ticket.subject}>
              {ticket.subject}
            </span>
          );
        case 'status_slug':
          return (
            <StatusPill
              statusSlug={ticket.statusSlug}
              category={ticket.statusCategory}
              label={ticket.status?.label ?? ticket.statusSlug}
              size="sm"
            />
          );
        case 'priority_slug':
          return (
            <PriorityBadge
              prioritySlug={ticket.prioritySlug}
              label={ticket.priority?.label ?? ticket.prioritySlug}
              size="sm"
            />
          );
        case 'assignee_id':
          return ticket.assignee ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <UserAvatar
                avatar={ticket.assignee.avatar}
                username={ticket.assignee.username}
                size={18}
              />
              <span className="truncate text-text-secondary">
                {ticket.assignee.displayName ?? ticket.assignee.username}
              </span>
            </span>
          ) : (
            <span className="text-text-muted">{t('grid.unassigned', 'Unassigned')}</span>
          );
        case 'queue_slug':
          return (
            <span className="truncate text-text-secondary">
              {ticket.queue?.name ?? ticket.queueSlug ?? '—'}
            </span>
          );
        case 'organization_id':
          return <span className="truncate text-text-secondary">{ticket.organization?.name ?? '—'}</span>;
        case 'requester_contact_id':
          return (
            <span className="truncate text-text-secondary">
              {ticket.requesterContact?.displayName ?? ticket.requesterContact?.email ?? '—'}
            </span>
          );
        case 'due_at': {
          const instance = nearestInstance(ticket.slaInstances ?? []);
          return instance ? <SlaChip instance={instance} size="sm" /> : <span className="text-text-muted">—</span>;
        }
        case 'occurred_at':
          return (
            <span className="font-mono text-[11px] text-text-secondary" title={formatAbsolute(ticket.occurredAt)}>
              {formatRelative(ticket.occurredAt, t)}
            </span>
          );
        case 'created_at':
          return (
            <span className="font-mono text-[11px] text-text-secondary" title={formatAbsolute(ticket.createdAt)}>
              {formatRelative(ticket.createdAt, t)}
            </span>
          );
        case 'updated_at':
          return (
            <span className="font-mono text-[11px] text-text-secondary" title={formatAbsolute(ticket.updatedAt)}>
              {formatRelative(ticket.updatedAt, t)}
            </span>
          );
        case 'record_type':
          return <span className="text-text-secondary">{ticket.recordType}</span>;
        case 'source':
          return <span className="text-text-secondary">{ticket.source}</span>;
        default:
          // A column the view names and this grid cannot draw: show the field
          // rather than an empty cell, so the gap is visible and fixable.
          return <span className="text-text-muted">{field}</span>;
      }
    },
    [t],
  );

  if (!isLoading && tickets.length === 0) {
    return (
      <EmptyState
        title={t('grid.emptyTitle', 'Nothing in this view')}
        description={t('grid.emptyBody', 'Pick another view, or widen the filter.')}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One horizontal scroller for the header and the body, so the columns
          cannot drift apart. HARD RULE 11 — the header is a background step,
          never a border. */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ minWidth: 'max-content' }}>
          <div
            className="sticky top-0 z-10 grid items-center gap-3 bg-bg-tertiary px-3 text-[10px] uppercase tracking-[0.08em] text-text-muted"
            style={{ gridTemplateColumns: template, height: HEADER_HEIGHT }}
          >
            {cols.map((column) => {
              // A label the view carries wins: it is what its author chose to
              // call the column, and translating over it would be second-guessing.
              const known = COLUMN_LABELS[column.key];
              return (
                <span key={column.key} className="truncate">
                  {column.label ?? (known ? t(known.key, known.fallback) : column.key)}
                </span>
              );
            })}
          </div>

          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((row) => {
              const ticket = tickets[row.index];
              if (!ticket) return null;
              return (
                <button
                  key={ticket.id}
                  type="button"
                  onClick={() => onOpen(ticket.id)}
                  className={clsx(
                    'absolute left-0 grid w-full items-center gap-3 px-3 text-left text-xs transition-colors',
                    ticket.id === selectedId ? 'bg-bg-active' : 'bg-bg-primary hover:bg-bg-hover',
                  )}
                  style={{
                    gridTemplateColumns: template,
                    height: row.size,
                    transform: `translateY(${row.start}px)`,
                  }}
                >
                  {cols.map((column) => (
                    <span key={column.key} className="flex min-w-0 items-center">
                      {cell(ticket, column.key)}
                    </span>
                  ))}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {isLoading && (
        <div className="flex justify-center py-3">
          <LoadingSpinner />
        </div>
      )}
    </div>
  );
}
