/**
 * PortalTicketsPage — `/portal`, the list of what the customer has asked for.
 *
 * ── The organisation toggle exists only when the right does ─────────────────
 * `?scope=organization` is honoured ONLY for a contact whose
 * `org_visibility` is `'organization'`; anybody else is silently narrowed back
 * to their own tickets, without being told, because refusing loudly would
 * advertise to whoever is probing that a wider view exists.
 *
 * The client half of that bargain is this: when the right is absent the toggle
 * IS NOT RENDERED. Not rendered disabled, not rendered with a tooltip — absent.
 * A disabled switch labelled "my whole organisation" tells a customer that a
 * feature exists, that they do not have it, and that somebody could give it to
 * them, which is precisely the fact the server is at pains not to disclose. And
 * an ENABLED switch would be worse: it would appear to work, change nothing,
 * and read as a broken portal.
 *
 * ── Who filed it, shown only where it can differ ────────────────────────────
 * In the organisation view a row can be a colleague's, so it carries the
 * requester's address. In the personal view every row is the reader's own and
 * repeating their own address on twenty rows is noise.
 *
 * ── Paging ─────────────────────────────────────────────────────────────────
 * Offset, not the keyset the agent queue uses, and appended rather than
 * replaced. A requester has tens of tickets, not a hundred thousand; `total`
 * is what lets the header say how many there are instead of only "there is
 * more", and appending means "show more" never loses the rows already read.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Building2, Inbox, MessageSquarePlus, Plus, RefreshCw, User } from 'lucide-react';

import {
  portalApi,
  type PortalScope,
  type PortalTicketState,
  type PortalTicketSummary,
} from '@/api/portal.api';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { formatRelative, formatSmartDate } from '@/utils/format';
import { cn } from '@/utils/cn';

import { usePortalSession } from './PortalSession';
import { PortalStatusBadge, needsRequesterReply } from './PortalStatus';

const PAGE_SIZE = 25;

// ═════════════════════════════════════════════════════════════════════════════
// Segmented control
// ═════════════════════════════════════════════════════════════════════════════

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/**
 * HARD RULE 11 — the group is a `bg-tertiary` trough, the active segment is the
 * accent, the inactive ones are a background swap on hover. No border anywhere,
 * and no ring: the surface step alone carries the depth.
 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    // `group` + `aria-pressed`, not `tablist` + `tab`: a tablist promises
    // tabpanels that a screen reader will then go looking for, and there are
    // none — these are toggle buttons that refetch a list in place.
    <div role="group" aria-label={ariaLabel} className="flex rounded-pill bg-bg-tertiary p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex items-center gap-1.5 rounded-pill px-3 py-1 text-[12px] font-medium transition-colors',
              active
                ? 'bg-accent text-bg-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// One row
// ═════════════════════════════════════════════════════════════════════════════

function TicketRow({ ticket, showRequester }: { ticket: PortalTicketSummary; showRequester: boolean }) {
  const { t } = useTranslation();
  const waiting = needsRequesterReply(ticket.statusCategory);

  return (
    <Link
      to={`/portal/tickets/${ticket.id}`}
      className="block rounded-card bg-bg-secondary p-4 shadow-card transition-colors hover:bg-bg-hover"
      // The accent rule marks the rows the customer has to act on. An inset
      // shadow, not a `border-left` (HARD RULE 11) — same three pixels, no
      // border, and it composes with the card shadow instead of replacing it.
      style={
        waiting
          ? { boxShadow: 'inset 3px 0 0 0 rgb(var(--c-accent)), var(--shadow-card)' }
          : undefined
      }
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-wide text-text-muted">
              {ticket.number}
            </span>
            <PortalStatusBadge category={ticket.statusCategory} size="xs" />
            {waiting && (
              <span className="rounded-pill bg-accent/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
                {t('portal.list.yourTurn', 'Your reply is needed')}
              </span>
            )}
          </div>

          <p className="mt-1.5 truncate text-[14px] font-medium text-text-primary">
            {ticket.subject}
          </p>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-muted">
            <span title={formatSmartDate(ticket.updatedAt)}>
              {t('portal.list.updated', 'Updated {{when}}', {
                when: formatRelative(ticket.updatedAt),
              })}
            </span>
            {showRequester && !ticket.mine && ticket.requesterEmail && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1 truncate">
                  <User size={11} className="shrink-0" />
                  {ticket.requesterEmail}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The page
// ═════════════════════════════════════════════════════════════════════════════

export function PortalTicketsPage() {
  const { t } = useTranslation();
  const { canReadOrganization } = usePortalSession();

  const [scope, setScope] = useState<PortalScope>('mine');
  const [state, setState] = useState<PortalTicketState>('open');

  const [items, setItems] = useState<PortalTicketSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);

  // Monotonic request id. Two filter clicks in quick succession can land out of
  // order, and the older answer overwriting the newer one is a list that
  // disagrees with the controls above it.
  const requestId = useRef(0);

  // A right that is revoked while the page is open must not leave the wider
  // view selected: the next fetch would come back narrowed with no explanation.
  useEffect(() => {
    if (!canReadOrganization && scope === 'organization') setScope('mine');
  }, [canReadOrganization, scope]);

  const load = useCallback(
    async (nextOffset: number) => {
      const id = ++requestId.current;
      if (nextOffset === 0) setStatus('loading');
      else setLoadingMore(true);

      try {
        const page = await portalApi.listTickets({
          scope,
          state,
          limit: PAGE_SIZE,
          offset: nextOffset,
        });
        if (id !== requestId.current) return;

        setItems((previous) => (nextOffset === 0 ? page.items : [...previous, ...page.items]));
        setTotal(page.total);
        setStatus('ready');
      } catch {
        if (id !== requestId.current) return;
        // The first page failing is an error state; a "show more" failing is
        // not, because what is already on screen is still true.
        if (nextOffset === 0) setStatus('error');
      } finally {
        if (id === requestId.current) setLoadingMore(false);
      }
    },
    [scope, state],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const hasMore = items.length < total;

  return (
    <div className="space-y-5">
      {/* ── Heading ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
            {scope === 'organization'
              ? t('portal.list.orgTitle', 'Our requests')
              : t('portal.myRequests', 'My requests')}
          </h1>
          {status === 'ready' && (
            <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
              {/* Two keys rather than i18next's plural machinery: the inline
                  fallback IS the string a customer sees until the bundle carries
                  the key (HARD RULE 10), and a `defaultValue` with a `count`
                  renders "1 requests" for the singular. */}
              {total === 1
                ? t('portal.list.countOne', '1 request')
                : t('portal.list.countMany', '{{count}} requests', { count: total })}
            </p>
          )}
        </div>

        <Link to="/portal/new" className="sm:hidden">
          <Button size="sm" variant="primary" icon={<Plus size={14} />}>
            {t('portal.newRequest', 'New request')}
          </Button>
        </Link>
      </div>

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          ariaLabel={t('portal.list.filterState', 'Filter requests by state')}
          value={state}
          onChange={setState}
          options={[
            { value: 'open', label: t('portal.list.stateOpen', 'Open') },
            { value: 'closed', label: t('portal.list.stateClosed', 'Closed') },
            { value: 'all', label: t('portal.list.stateAll', 'All') },
          ]}
        />

        {/* Rendered only when the right was actually granted. See the header. */}
        {canReadOrganization && (
          <Segmented
            ariaLabel={t('portal.list.filterScope', 'Choose whose requests to show')}
            value={scope}
            onChange={setScope}
            options={[
              {
                value: 'mine',
                label: t('portal.list.scopeMine', 'Mine'),
                icon: <User size={12} />,
              },
              {
                value: 'organization',
                label: t('portal.list.scopeOrganization', 'My organisation'),
                icon: <Building2 size={12} />,
              },
            ]}
          />
        )}
      </div>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {status === 'loading' ? (
        <div className="flex min-h-[30vh] items-center justify-center">
          <LoadingSpinner label={t('common.loading', 'Loading…')} />
        </div>
      ) : status === 'error' ? (
        <EmptyState
          icon={<AlertCircle size={20} />}
          title={t('portal.list.errorTitle', 'Your requests could not be loaded')}
          description={t(
            'portal.list.errorBody',
            'The support desk did not answer. This is usually temporary.',
          )}
          action={
            <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void load(0)}>
              {t('portal.list.retry', 'Try again')}
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Inbox size={20} />}
          title={
            state === 'open'
              ? t('portal.none', 'You have no open request.')
              : t('portal.list.emptyOther', 'Nothing to show here')
          }
          description={t(
            'portal.list.emptyBody',
            'When you file a request it appears here, with everything the support team writes back.',
          )}
          action={
            <Link to="/portal/new">
              <Button icon={<MessageSquarePlus size={14} />}>
                {t('portal.newRequest', 'New request')}
              </Button>
            </Link>
          }
        />
      ) : (
        <>
          <ul className="space-y-2">
            {items.map((ticket) => (
              <li key={ticket.id}>
                <TicketRow ticket={ticket} showRequester={scope === 'organization'} />
              </li>
            ))}
          </ul>

          {hasMore && (
            <div className="flex justify-center pt-1">
              <Button
                variant="secondary"
                size="sm"
                loading={loadingMore}
                onClick={() => void load(items.length)}
              >
                {t('portal.list.showMore', 'Show more')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default PortalTicketsPage;
