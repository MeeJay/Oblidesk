/**
 * ticketStore.ts — the windowed store behind the virtualised queue.
 *
 * Four things here are load-bearing and none of them are obvious:
 *
 *  1. KEYSET PAGING, NOT OFFSETS. The queue is a live table: rows are inserted
 *     and reordered while an agent scrolls. `LIMIT 50 OFFSET 400` against a
 *     moving table shows duplicates and, worse, skips rows — a skipped row in a
 *     ticket queue is a ticket nobody works. The cursor is opaque; we hand back
 *     exactly what the server gave us.
 *
 *  2. ARRIVALS DO NOT MOVE THE ANCHOR. A ticket that arrives while the agent is
 *     reading row 40 goes into `pendingIds` and surfaces as a "3 nouveaux"
 *     pill. Prepending it directly would shift every row under the cursor by
 *     one — which is how an agent clicks the wrong ticket. The list only grows
 *     at the top when the human asks it to.
 *
 *  3. OPTIMISTIC EDITS ROLL BACK. An inline edit paints immediately and keeps
 *     the pre-edit row. On failure it restores it. There is no "eventually
 *     consistent" middle state where the screen shows a value the server
 *     rejected.
 *
 *  4. ROW VERSIONS ARE HONEST (HARD RULE 7). Every mutation sends the version it
 *     read. A 409 comes back with the CURRENT row, and that lands in `conflict`
 *     for the UI to show — the local edit is discarded, never silently replayed
 *     over somebody else's work.
 */

import { create } from 'zustand';
import { PAGINATION } from '@oblidesk/shared';
import type {
  StatusCategory,
  TicketConflict,
  TicketWithRelations,
  UpdateTicketRequest,
} from '@oblidesk/shared';
import { ApiError } from '@/api/client';
import { conflictOf, ticketsApi, type TicketListParams } from '@/api/tickets.api';

/**
 * Loaded-row ceiling. Past this we stop fetching and say so, rather than
 * quietly holding 100k rows in memory and blaming the browser. The answer to a
 * queue this long is a narrower filter, and the UI has to be able to say that.
 */
const MAX_LOADED_ROWS = PAGINATION.exactCountThreshold;

export interface TicketQueryState extends TicketListParams {
  limit: number;
  sortBy: NonNullable<TicketListParams['sortBy']>;
  sortDir: NonNullable<TicketListParams['sortDir']>;
}

const DEFAULT_QUERY: TicketQueryState = {
  limit: PAGINATION.defaultLimit,
  sortBy: 'updated_at',
  sortDir: 'desc',
};

interface TicketState {
  // ── The window ──────────────────────────────────────────────────────────
  /** Display order. The virtualiser indexes this, never `byId`. */
  ids: number[];
  byId: Record<number, TicketWithRelations>;
  /** Pre-edit copies, keyed by id, held for the length of one optimistic write. */
  rollback: Record<number, TicketWithRelations>;

  query: TicketQueryState;
  cursor: string | null;
  hasMore: boolean;
  /** True once the window hit MAX_LOADED_ROWS — the filter needs narrowing. */
  capReached: boolean;

  total: number | null;
  totalIsApproximate: boolean;
  /**
   * Predicates the server could not compile. Non-empty means the list is
   * NARROWER than asked for, and the UI must say so — a silently narrowed
   * queue is a ticket that goes unseen.
   */
  unsupportedFilters: string[];

  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;

  // ── Arrivals held behind the pill ───────────────────────────────────────
  pendingIds: number[];
  pendingById: Record<number, TicketWithRelations>;

  // ── Interaction ─────────────────────────────────────────────────────────
  focusedIndex: number;
  selectedIds: number[];
  /** The 409 body, waiting for the conflict dialog. */
  conflict: TicketConflict | null;

  // ── Actions ─────────────────────────────────────────────────────────────
  setQuery: (patch: Partial<TicketQueryState>) => Promise<void>;
  fetch: (options?: { silent?: boolean }) => Promise<void>;
  fetchMore: () => Promise<void>;
  refresh: () => Promise<void>;
  reset: () => void;

  /** A realtime create / update. Patches in place, or queues behind the pill. */
  noteArrival: (ticket: TicketWithRelations, kind: 'created' | 'updated') => void;
  noteRemoval: (ticketId: number) => void;
  /** Move the queued arrivals into the list. The only thing that shifts rows. */
  flushPending: () => void;

  /** Autosave one field. Never validates required-ness (HARD RULE 12). */
  patchTicket: (ticketId: number, patch: Omit<UpdateTicketRequest, 'baseRowVersion'>) => Promise<void>;
  /** Put a server row into the window without a fetch. */
  upsert: (ticket: TicketWithRelations) => void;

  dismissConflict: () => void;
  /** Take the server's row and drop the local edit. */
  acceptRemote: () => void;

  focusIndex: (index: number) => void;
  focusNext: () => void;
  focusPrevious: () => void;
  focusedTicket: () => TicketWithRelations | null;

  toggleSelected: (ticketId: number) => void;
  selectAllLoaded: () => void;
  clearSelection: () => void;
  /** `{ id: rowVersion }` for a bulk apply — every row checked against its own. */
  selectedRowVersions: () => Record<number, number>;
}

function indexById(tickets: TicketWithRelations[]): Record<number, TicketWithRelations> {
  const out: Record<number, TicketWithRelations> = {};
  for (const ticket of tickets) out[ticket.id] = ticket;
  return out;
}

export const useTicketStore = create<TicketState>((set, get) => ({
  ids: [],
  byId: {},
  rollback: {},

  query: { ...DEFAULT_QUERY },
  cursor: null,
  hasMore: false,
  capReached: false,

  total: null,
  totalIsApproximate: false,
  unsupportedFilters: [],

  isLoading: false,
  isLoadingMore: false,
  error: null,

  pendingIds: [],
  pendingById: {},

  focusedIndex: -1,
  selectedIds: [],
  conflict: null,

  setQuery: async (patch) => {
    set((state) => ({ query: { ...state.query, ...patch } }));
    await get().fetch();
  },

  /**
   * First page. `silent` keeps the current rows on screen while it refreshes —
   * a background refresh that blanks the queue an agent is reading is worse
   * than one that is a second stale.
   */
  fetch: async (options = {}) => {
    set({
      isLoading: !options.silent,
      error: null,
      // Anything queued belonged to the previous result set.
      pendingIds: [],
      pendingById: {},
    });

    try {
      const page = await ticketsApi.list({ ...get().query, cursor: null });
      set({
        ids: page.items.map((ticket) => ticket.id),
        byId: indexById(page.items),
        rollback: {},
        cursor: page.nextCursor,
        hasMore: page.hasMore,
        capReached: false,
        total: page.total ?? null,
        totalIsApproximate: page.totalIsApproximate ?? false,
        unsupportedFilters: page.unsupportedFilters ?? [],
        isLoading: false,
        // Selection is per result set: keeping it across a filter change is how
        // a bulk action lands on rows the agent can no longer see.
        selectedIds: [],
        focusedIndex: page.items.length > 0 ? 0 : -1,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load tickets',
      });
    }
  },

  fetchMore: async () => {
    const { cursor, hasMore, isLoading, isLoadingMore, ids, query } = get();
    if (!hasMore || cursor === null || isLoading || isLoadingMore) return;

    if (ids.length >= MAX_LOADED_ROWS) {
      set({ capReached: true, hasMore: false });
      return;
    }

    set({ isLoadingMore: true });
    try {
      const page = await ticketsApi.list({ ...query, cursor });
      set((state) => {
        // Guard against a duplicate the server may legitimately re-emit at a
        // page boundary when a row was updated between requests.
        const seen = new Set(state.ids);
        const fresh = page.items.filter((ticket) => !seen.has(ticket.id));
        return {
          ids: [...state.ids, ...fresh.map((ticket) => ticket.id)],
          byId: { ...state.byId, ...indexById(page.items) },
          cursor: page.nextCursor,
          hasMore: page.hasMore,
          isLoadingMore: false,
        };
      });
    } catch (error) {
      set({
        isLoadingMore: false,
        error: error instanceof Error ? error.message : 'Failed to load more tickets',
      });
    }
  },

  refresh: async () => {
    await get().fetch({ silent: true });
  },

  reset: () =>
    set({
      ids: [],
      byId: {},
      rollback: {},
      query: { ...DEFAULT_QUERY },
      cursor: null,
      hasMore: false,
      capReached: false,
      total: null,
      totalIsApproximate: false,
      unsupportedFilters: [],
      isLoading: false,
      isLoadingMore: false,
      error: null,
      pendingIds: [],
      pendingById: {},
      focusedIndex: -1,
      selectedIds: [],
      conflict: null,
    }),

  // ── Realtime ──────────────────────────────────────────────────────────────

  /**
   * A row already in the window is patched IN PLACE: it keeps its index, so the
   * scroll position and the focused row do not move, and only the cells that
   * changed re-render.
   *
   * A row that is NOT in the window is an arrival. We cannot evaluate the saved
   * view's filter here — the server compiles it — so we only queue arrivals
   * when the list is sorted newest-first, which is the only ordering where the
   * new row provably belongs at the top. Under any other sort the pill would be
   * guessing, and a pill that inserts a row in the wrong place is worse than no
   * pill; the agent refreshes instead.
   */
  noteArrival: (ticket, kind) => {
    const state = get();

    if (state.byId[ticket.id]) {
      set({ byId: { ...state.byId, [ticket.id]: ticket } });
      return;
    }

    const newestFirst = state.query.sortDir === 'desc' &&
      (state.query.sortBy === 'updated_at' || state.query.sortBy === 'created_at' || state.query.sortBy === 'id');
    if (!newestFirst && kind === 'updated') return;

    if (state.pendingById[ticket.id]) {
      set({ pendingById: { ...state.pendingById, [ticket.id]: ticket } });
      return;
    }

    set({
      pendingIds: [ticket.id, ...state.pendingIds],
      pendingById: { ...state.pendingById, [ticket.id]: ticket },
    });
  },

  noteRemoval: (ticketId) => {
    set((state) => {
      const index = state.ids.indexOf(ticketId);
      const nextById = { ...state.byId };
      delete nextById[ticketId];
      const nextPending = { ...state.pendingById };
      delete nextPending[ticketId];

      return {
        ids: state.ids.filter((id) => id !== ticketId),
        byId: nextById,
        pendingIds: state.pendingIds.filter((id) => id !== ticketId),
        pendingById: nextPending,
        selectedIds: state.selectedIds.filter((id) => id !== ticketId),
        // Keep the focus where the eye is: on the row that took the gap.
        focusedIndex:
          index === -1 || state.focusedIndex < index
            ? state.focusedIndex
            : Math.max(0, state.focusedIndex - 1),
        total: state.total === null ? null : Math.max(0, state.total - 1),
      };
    });
  },

  flushPending: () => {
    const { pendingIds, pendingById, ids, byId, focusedIndex, total } = get();
    if (pendingIds.length === 0) return;

    const fresh = pendingIds.filter((id) => !byId[id]);
    set({
      ids: [...fresh, ...ids],
      byId: { ...byId, ...pendingById },
      pendingIds: [],
      pendingById: {},
      // The rows moved down by exactly `fresh.length`; move the focus with them
      // so the highlighted ticket is still the same ticket.
      focusedIndex: focusedIndex < 0 ? focusedIndex : focusedIndex + fresh.length,
      total: total === null ? null : total + fresh.length,
    });
  },

  // ── Writes ────────────────────────────────────────────────────────────────

  upsert: (ticket) =>
    set((state) => ({
      byId: { ...state.byId, [ticket.id]: ticket },
      ids: state.byId[ticket.id] ? state.ids : [ticket.id, ...state.ids],
    })),

  patchTicket: async (ticketId, patch) => {
    const before = get().byId[ticketId];
    if (!before) return;

    // Paint first. `data` is a merge patch server-side, so merge it here too —
    // replacing the bag would blank every custom field the agent did not touch.
    const optimistic: TicketWithRelations = {
      ...before,
      ...patch,
      data: patch.data ? { ...before.data, ...patch.data } : before.data,
    };

    set((state) => ({
      byId: { ...state.byId, [ticketId]: optimistic },
      rollback: { ...state.rollback, [ticketId]: before },
    }));

    try {
      const saved = await ticketsApi.update(ticketId, { baseRowVersion: before.rowVersion, ...patch });
      set((state) => {
        const nextRollback = { ...state.rollback };
        delete nextRollback[ticketId];
        return { byId: { ...state.byId, [ticketId]: saved }, rollback: nextRollback };
      });
    } catch (error) {
      // Restore the pre-edit row in every failure case. The screen must never
      // keep showing a value the server refused.
      set((state) => {
        const nextRollback = { ...state.rollback };
        delete nextRollback[ticketId];
        return { byId: { ...state.byId, [ticketId]: before }, rollback: nextRollback };
      });

      if (error instanceof ApiError && error.isConflict) {
        const conflict = conflictOf(error);
        if (conflict) {
          // Adopt the server's row immediately — it is newer than ours — and
          // hand the conflict to the UI so the human decides what to redo.
          set((state) => ({
            byId: { ...state.byId, [ticketId]: conflict.current },
            conflict,
          }));
        }
      }
      throw error;
    }
  },

  dismissConflict: () => set({ conflict: null }),

  acceptRemote: () => {
    const conflict = get().conflict;
    if (!conflict) return;
    set((state) => ({
      byId: { ...state.byId, [conflict.current.id]: conflict.current },
      conflict: null,
    }));
  },

  // ── Navigation ────────────────────────────────────────────────────────────

  focusIndex: (index) => {
    const { ids } = get();
    if (ids.length === 0) {
      set({ focusedIndex: -1 });
      return;
    }
    set({ focusedIndex: Math.max(0, Math.min(ids.length - 1, index)) });
  },

  focusNext: () => {
    const { focusedIndex, ids, hasMore, isLoadingMore } = get();
    const next = focusedIndex + 1;
    if (next >= ids.length) {
      // Walking off the end is the honest moment to fetch the next page.
      if (hasMore && !isLoadingMore) void get().fetchMore();
      return;
    }
    set({ focusedIndex: next });
  },

  focusPrevious: () => {
    const { focusedIndex } = get();
    set({ focusedIndex: Math.max(0, focusedIndex - 1) });
  },

  focusedTicket: () => {
    const { focusedIndex, ids, byId } = get();
    if (focusedIndex < 0 || focusedIndex >= ids.length) return null;
    return byId[ids[focusedIndex]] ?? null;
  },

  // ── Selection ─────────────────────────────────────────────────────────────

  toggleSelected: (ticketId) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(ticketId)
        ? state.selectedIds.filter((id) => id !== ticketId)
        : [...state.selectedIds, ticketId],
    })),

  selectAllLoaded: () => set((state) => ({ selectedIds: [...state.ids] })),

  clearSelection: () => set({ selectedIds: [] }),

  selectedRowVersions: () => {
    const { selectedIds, byId } = get();
    const out: Record<number, number> = {};
    for (const id of selectedIds) {
      const ticket = byId[id];
      if (ticket) out[id] = ticket.rowVersion;
    }
    return out;
  },
}));

/** Rows in display order — what the virtualiser maps over. */
export function selectRows(state: TicketState): TicketWithRelations[] {
  return state.ids.map((id) => state.byId[id]).filter(Boolean);
}

/** How many arrivals the pill should announce. */
export function selectPendingCount(state: TicketState): number {
  return state.pendingIds.length;
}

/** Loaded rows grouped by status category — the board columns. */
export function selectByCategory(state: TicketState): Record<StatusCategory, TicketWithRelations[]> {
  const out = {} as Record<StatusCategory, TicketWithRelations[]>;
  for (const id of state.ids) {
    const ticket = state.byId[id];
    if (!ticket) continue;
    (out[ticket.statusCategory] ??= []).push(ticket);
  }
  return out;
}
