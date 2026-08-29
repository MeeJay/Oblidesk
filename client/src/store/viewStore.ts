/**
 * viewStore.ts — the saved views in the sidebar, their badges, and which one is
 * open.
 *
 * Counts are fetched in ONE call for every view, never one call per badge: a
 * dozen concurrent aggregate queries against a pool of ten connections is how
 * the sidebar starves the queue it decorates. The socket pushes `view:counters`
 * for the views this client is subscribed to, so the poll is a fallback for a
 * dead socket rather than the primary path.
 *
 * `warnings` on a count is not decoration. It means the server could not
 * compile part of the view's filter, so the number is smaller than the view's
 * author intended — the badge has to be able to say "this is not the whole
 * story" rather than quietly under-reporting a backlog.
 */

import { create } from 'zustand';
import { STORAGE_KEYS } from '@oblidesk/shared';
import { viewsApi, type ViewCount, type ViewDefinition } from '@/api/views.api';
import { subscribeViews } from '@/socket';

function readLastView(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.lastView);
  } catch {
    return null;
  }
}

function writeLastView(slug: string | null): void {
  try {
    if (slug) localStorage.setItem(STORAGE_KEYS.lastView, slug);
    else localStorage.removeItem(STORAGE_KEYS.lastView);
  } catch {
    // Storage blocked — the view choice simply will not survive a reload.
  }
}

interface ViewState {
  views: ViewDefinition[];
  counts: Record<string, ViewCount>;
  /** The view currently driving the queue. Null = the ad-hoc filter. */
  activeSlug: string | null;

  isLoading: boolean;
  isCounting: boolean;
  error: string | null;

  loadViews: () => Promise<void>;
  loadCounts: (force?: boolean) => Promise<void>;
  /** Apply one `view:counters` frame from the socket. */
  applyCounters: (counts: Array<{ viewSlug: string; count: number }>) => void;

  setActive: (slug: string | null) => void;
  /** The slug to open on landing: last used, else the first view offered. */
  initialSlug: () => string | null;

  create: (payload: Parameters<typeof viewsApi.create>[0]) => Promise<ViewDefinition>;
  update: (slug: string, payload: Parameters<typeof viewsApi.update>[1]) => Promise<ViewDefinition>;
  remove: (slug: string) => Promise<void>;

  bySlug: (slug: string) => ViewDefinition | undefined;
  countOf: (slug: string) => ViewCount | undefined;
  reset: () => void;
}

export const useViewStore = create<ViewState>((set, get) => ({
  views: [],
  counts: {},
  activeSlug: readLastView(),

  isLoading: false,
  isCounting: false,
  error: null,

  loadViews: async () => {
    set({ isLoading: true, error: null });
    try {
      const views = await viewsApi.list();
      set({ views, isLoading: false });

      // Subscribe to the counter rooms for the views that actually show a
      // badge. The server replaces the whole view subscription set on this
      // command, so sending the full list is correct, not wasteful.
      const badged = views.filter((view) => view.showCount).map((view) => view.slug);
      if (badged.length > 0) void subscribeViews(badged);

      // A remembered view that has since been archived must not leave the
      // sidebar pointing at nothing.
      const { activeSlug } = get();
      if (activeSlug && !views.some((view) => view.slug === activeSlug)) {
        set({ activeSlug: null });
        writeLastView(null);
      }
    } catch (error) {
      set({ isLoading: false, error: error instanceof Error ? error.message : 'Failed to load views' });
    }
  },

  loadCounts: async (force = false) => {
    set({ isCounting: true });
    try {
      const counts = await viewsApi.counts(force);
      set((state) => {
        const next = { ...state.counts };
        for (const count of counts) next[count.viewSlug] = count;
        return { counts: next, isCounting: false };
      });
    } catch {
      // Badges are decoration; losing them must never blank the sidebar.
      set({ isCounting: false });
    }
  },

  applyCounters: (counts) =>
    set((state) => {
      const next = { ...state.counts };
      for (const { viewSlug, count } of counts) {
        const existing = next[viewSlug];
        next[viewSlug] = existing
          ? { ...existing, count, computedAt: new Date().toISOString() }
          : {
              viewSlug,
              count,
              approximate: false,
              estimate: null,
              computedAt: new Date().toISOString(),
              warnings: [],
            };
      }
      return { counts: next };
    }),

  setActive: (slug) => {
    writeLastView(slug);
    set({ activeSlug: slug });
  },

  initialSlug: () => {
    const { activeSlug, views } = get();
    if (activeSlug && views.some((view) => view.slug === activeSlug)) return activeSlug;
    return views[0]?.slug ?? null;
  },

  create: async (payload) => {
    const view = await viewsApi.create(payload);
    set((state) => ({ views: [...state.views, view].sort((a, b) => a.sortOrder - b.sortOrder) }));
    return view;
  },

  update: async (slug, payload) => {
    const view = await viewsApi.update(slug, payload);
    set((state) => ({ views: state.views.map((existing) => (existing.slug === slug ? view : existing)) }));
    return view;
  },

  remove: async (slug) => {
    await viewsApi.remove(slug);
    set((state) => {
      const counts = { ...state.counts };
      delete counts[slug];
      return {
        views: state.views.filter((view) => view.slug !== slug),
        counts,
        activeSlug: state.activeSlug === slug ? null : state.activeSlug,
      };
    });
    if (get().activeSlug === null) writeLastView(null);
  },

  bySlug: (slug) => get().views.find((view) => view.slug === slug),
  countOf: (slug) => get().counts[slug],

  reset: () => set({ views: [], counts: {}, isLoading: false, isCounting: false, error: null }),
}));

/** Views the sidebar renders, in their authored order. */
export function selectSidebarViews(state: ViewState): ViewDefinition[] {
  return [...state.views].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}
