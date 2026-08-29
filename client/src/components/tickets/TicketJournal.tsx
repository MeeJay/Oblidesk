/**
 * TicketJournal.tsx — the one spine.
 *
 * ── One timeline, not four tabs ──────────────────────────────────────────────
 * Public replies, work notes, state changes, automation and alerts all live in
 * the SAME ordered column. Splitting them into tabs is the mistake that makes a
 * desk unusable: the question an agent actually has is "what happened, in what
 * order?", and four tabs is four partial answers none of which is that.
 *
 * ── Noise collapses, signal does not ─────────────────────────────────────────
 * Consecutive entries whose kind is in `COLLAPSIBLE_JOURNAL_KINDS` fold into
 * one expandable row: "6 événements automatiques". A single one stays inline —
 * collapsing one row behind a disclosure costs a click and saves nothing.
 * Replies and notes never collapse.
 *
 * ── Ordering is `seq`, never `created_at` ────────────────────────────────────
 * `(ticket_id, seq)` is unique and monotonic server-side. Two entries written in
 * the same millisecond by an engine and a human sort deterministically by seq
 * and non-deterministically by timestamp; a timeline that reorders itself on
 * refresh is a timeline nobody trusts.
 *
 * ── Loading is keyset, upward ────────────────────────────────────────────────
 * The newest page loads first (that is what an agent opens a ticket to read),
 * and "charger les échanges précédents" walks backwards with `beforeSeq`. There
 * is no page number and no total: a ticket with 900 entries must not pay for a
 * COUNT to render its last twenty.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Loader2, MessagesSquare, RefreshCw } from 'lucide-react';
import { COLLAPSIBLE_JOURNAL_KINDS, PAGINATION, SOCKET_EVENTS } from '@oblidesk/shared';
import type { JournalAppendedEvent, TicketJournalEntry } from '@oblidesk/shared';
import apiClient from '@/api/client';
import JournalEntry, { isNoiseKind } from './JournalEntry';
import { useDeskEvent } from './PresenceBar';

type Filter = 'all' | 'conversation' | 'internal' | 'events';

const FILTERS: ReadonlyArray<{ id: Filter; key: string; fallback: string }> = [
  { id: 'all', key: 'journal.filter.all', fallback: 'Tout' },
  { id: 'conversation', key: 'journal.filter.conversation', fallback: 'Échanges' },
  { id: 'internal', key: 'journal.filter.internal', fallback: 'Notes internes' },
  { id: 'events', key: 'journal.filter.events', fallback: 'Événements' },
];

interface JournalPage {
  success: boolean;
  data: TicketJournalEntry[];
  hasMore: boolean;
  nextSeq: number | null;
}

/** Consecutive noise entries fold; anything else stands alone. */
type Block =
  | { kind: 'entry'; entry: TicketJournalEntry }
  | { kind: 'noise'; id: string; entries: TicketJournalEntry[] };

function buildBlocks(entries: readonly TicketJournalEntry[]): Block[] {
  const blocks: Block[] = [];
  let run: TicketJournalEntry[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) blocks.push({ kind: 'entry', entry: run[0] });
    else blocks.push({ kind: 'noise', id: `noise-${run[0].seq}-${run[run.length - 1].seq}`, entries: run });
    run = [];
  };

  for (const entry of entries) {
    if (isNoiseKind(entry.kind)) {
      run.push(entry);
      continue;
    }
    flush();
    blocks.push({ kind: 'entry', entry });
  }
  flush();
  return blocks;
}

export interface TicketJournalProps {
  ticketId: number;
  /** An entry this client just created — merged optimistically, deduped by id. */
  injected?: TicketJournalEntry | null;
  onQuote?: (entry: TicketJournalEntry) => void;
  onOpenWhy?: (decisionLogId: number) => void;
  /** Seq to scroll to and highlight, from a deep link. */
  focusSeq?: number | null;
  className?: string;
}

export default function TicketJournal({
  ticketId,
  injected,
  onQuote,
  onOpenWhy,
  focusSeq,
  className,
}: TicketJournalProps): JSX.Element {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<TicketJournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [expandedNoise, setExpandedNoise] = useState<Set<string>>(() => new Set());
  const [unseen, setUnseen] = useState(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** True while the agent is reading the newest entries — the only time we auto-scroll. */
  const pinnedToBottom = useRef(true);

  // ── Merge helper: seq is the identity, id is the dedupe key ─────────────
  const merge = useCallback((incoming: readonly TicketJournalEntry[]) => {
    setEntries((current) => {
      const byId = new Map<number, TicketJournalEntry>();
      for (const entry of current) byId.set(entry.id, entry);
      for (const entry of incoming) byId.set(entry.id, entry);
      return [...byId.values()].sort((a, b) => a.seq - b.seq);
    });
  }, []);

  // ── First page: the newest, because that is what people open a ticket for ─
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setEntries([]);
    setUnseen(0);
    pinnedToBottom.current = true;

    apiClient
      .get<JournalPage>(`/tickets/${ticketId}/journal`, {
        params: { limit: PAGINATION.defaultLimit, direction: 'desc' },
      })
      .then((response) => {
        if (!alive) return;
        const page = response.data;
        setEntries([...(page.data ?? [])].sort((a, b) => a.seq - b.seq));
        setHasOlder(Boolean(page.hasMore));
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(
          cause instanceof Error ? cause.message : t('journal.loadFailed', 'Journal illisible.'),
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [ticketId, t]);

  // ── Older pages, walking backwards from the oldest seq we hold ──────────
  const loadOlder = useCallback(async () => {
    const oldest = entries[0]?.seq;
    if (oldest === undefined || loadingOlder) return;

    setLoadingOlder(true);
    const container = scrollRef.current;
    const anchorHeight = container?.scrollHeight ?? 0;

    try {
      const response = await apiClient.get<JournalPage>(`/tickets/${ticketId}/journal`, {
        params: { limit: PAGINATION.defaultLimit, beforeSeq: oldest, direction: 'desc' },
      });
      merge(response.data.data ?? []);
      setHasOlder(Boolean(response.data.hasMore));

      // Keep the reading position: prepending content must not teleport the
      // paragraph somebody is halfway through.
      requestAnimationFrame(() => {
        if (!container) return;
        container.scrollTop += container.scrollHeight - anchorHeight;
      });
    } catch {
      setHasOlder(false);
    } finally {
      setLoadingOlder(false);
    }
  }, [entries, loadingOlder, merge, ticketId]);

  // ── Live append ──────────────────────────────────────────────────────────
  useDeskEvent<JournalAppendedEvent>(SOCKET_EVENTS.journalAppended, (payload) => {
    if (payload.ticketId !== ticketId || !payload.entry) return;
    merge([payload.entry]);
    if (!pinnedToBottom.current) setUnseen((count) => count + 1);
  });

  // ── The entry this client just posted ────────────────────────────────────
  useEffect(() => {
    if (injected) {
      merge([injected]);
      pinnedToBottom.current = true;
    }
  }, [injected, merge]);

  // ── Scroll bookkeeping ───────────────────────────────────────────────────
  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    pinnedToBottom.current = distanceFromBottom < 80;
    if (pinnedToBottom.current && unseen > 0) setUnseen(0);
  }, [unseen]);

  const jumpToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    pinnedToBottom.current = true;
    setUnseen(0);
  }, []);

  useEffect(() => {
    if (pinnedToBottom.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length]);

  // Deep link: scroll to the referenced entry once it is in the DOM.
  useEffect(() => {
    if (!focusSeq) return;
    const node = document.getElementById(`journal-${focusSeq}`);
    if (node) {
      node.scrollIntoView({ block: 'center' });
      pinnedToBottom.current = false;
    }
  }, [focusSeq, entries.length]);

  // ── Filtering, then grouping ─────────────────────────────────────────────
  const visible = useMemo(() => {
    if (filter === 'all') return entries;
    if (filter === 'conversation') {
      return entries.filter((e) => e.kind === 'public_reply' || e.kind === 'work_note');
    }
    if (filter === 'internal') return entries.filter((e) => e.visibility === 'internal');
    return entries.filter((e) => (COLLAPSIBLE_JOURNAL_KINDS as readonly string[]).includes(e.kind));
  }, [entries, filter]);

  const blocks = useMemo(() => buildBlocks(visible), [visible]);

  const toggleNoise = useCallback((id: string) => {
    setExpandedNoise((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <section className={clsx('relative flex min-h-0 flex-1 flex-col', className)}>
      {/* ── Filter row ──────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
        <MessagesSquare size={13} className="text-text-muted" aria-hidden />
        {FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setFilter(option.id)}
            aria-pressed={filter === option.id}
            className={clsx(
              'rounded-pill px-2.5 py-1 text-[12px] transition-colors',
              filter === option.id
                ? 'bg-accent/15 text-accent'
                : 'text-text-muted hover:bg-bg-hover hover:text-text-secondary',
            )}
          >
            {t(option.key, option.fallback)}
          </button>
        ))}
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-text-muted">
          {t('journal.count', '{{count}} entrées', { count: entries.length })}
        </span>
      </div>

      {/* ── The spine ───────────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-4"
      >
        {hasOlder && (
          <button
            type="button"
            onClick={() => void loadOlder()}
            disabled={loadingOlder}
            className="mx-auto mt-2 inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-60"
          >
            {loadingOlder ? (
              <Loader2 size={12} className="animate-spin" aria-hidden />
            ) : (
              <ChevronUp size={12} aria-hidden />
            )}
            {t('journal.loadOlder', 'Charger les échanges précédents')}
          </button>
        )}

        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-text-muted">
            <Loader2 size={14} className="animate-spin" aria-hidden />
            {t('journal.loading', 'Chargement du journal…')}
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col items-center gap-2 rounded-card bg-bg-secondary p-6 text-center">
            <p className="text-[13px] text-sla-breach">{error}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover"
            >
              <RefreshCw size={12} aria-hidden />
              {t('common.retry', 'Réessayer')}
            </button>
          </div>
        )}

        {!loading && !error && blocks.length === 0 && (
          <p className="py-8 text-center text-[13px] text-text-muted">
            {t('journal.empty', 'Aucune entrée pour ce filtre.')}
          </p>
        )}

        {blocks.map((block) =>
          block.kind === 'entry' ? (
            <JournalEntry
              key={block.entry.id}
              entry={block.entry}
              onQuote={onQuote}
              onOpenWhy={onOpenWhy}
              highlighted={focusSeq === block.entry.seq}
            />
          ) : (
            <div key={block.id} className="rounded-card bg-bg-secondary/60">
              <button
                type="button"
                onClick={() => toggleNoise(block.id)}
                aria-expanded={expandedNoise.has(block.id)}
                className="flex w-full items-center gap-2 rounded-card px-3 py-1.5 text-left text-[12px] text-text-muted hover:bg-bg-hover"
              >
                {expandedNoise.has(block.id) ? (
                  <ChevronDown size={12} aria-hidden />
                ) : (
                  <ChevronUp size={12} className="rotate-90" aria-hidden />
                )}
                {t('journal.noiseGroup', '{{count}} événements automatiques', {
                  count: block.entries.length,
                })}
              </button>
              {expandedNoise.has(block.id) && (
                <div className="flex flex-col divide-y divide-border/40 pb-1">
                  {block.entries.map((entry) => (
                    <JournalEntry key={entry.id} entry={entry} dense onOpenWhy={onOpenWhy} />
                  ))}
                </div>
              )}
            </div>
          ),
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── "N nouveaux" — never a scroll jump ──────────────────────────── */}
      {unseen > 0 && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-pill bg-accent px-3 py-1.5 text-[12px] font-medium text-bg-primary shadow-card"
        >
          {t('journal.newEntries', '{{count}} nouveaux', { count: unseen })}
        </button>
      )}
    </section>
  );
}
