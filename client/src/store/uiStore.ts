/**
 * uiStore.ts — chrome state: the sidebar, the density, the overlays.
 *
 * Everything here is a per-viewer convenience, so it is persisted in
 * localStorage under the keys in STORAGE_KEYS and never sent to the server —
 * except density and sidebar collapse, which ALSO live on the user's account so
 * the choice follows them to another machine. The auth store pushes those down
 * on sign-in; writes from here are local and the profile page is what persists
 * them upstream. Two writers, one direction each, is the only arrangement that
 * does not fight itself.
 */

import { create } from 'zustand';
import { STORAGE_KEYS } from '@oblidesk/shared';

export type Density = 'comfortable' | 'compact';

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;
const DEFAULT_SIDEBAR_WIDTH = 280;

function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked — the choice holds for this page load and no longer.
  }
}

function readBool(key: string, fallback = false): boolean {
  const raw = readString(key);
  return raw === null ? fallback : raw === 'true';
}

function readWidth(): number {
  const raw = readString(STORAGE_KEYS.sidebarWidth);
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, parsed));
}

function readDensity(): Density {
  return readString(STORAGE_KEYS.queueDensity) === 'compact' ? 'compact' : 'comfortable';
}

interface UiState {
  // ── Sidebar ─────────────────────────────────────────────────────────────
  sidebarOpen: boolean;
  /** Icon-only 64 px rail rather than hidden entirely (design system §6). */
  sidebarCollapsed: boolean;
  sidebarFloating: boolean;
  sidebarWidth: number;

  // ── Ticket chrome ───────────────────────────────────────────────────────
  density: Density;
  /** The context rail on the ticket detail (CI, SLA, related). */
  contextRailOpen: boolean;
  /** The "Why?" drawer — the decision log for the open ticket. */
  whyDrawerTicketId: number | null;

  // ── Overlays ────────────────────────────────────────────────────────────
  commandPaletteOpen: boolean;
  keyboardHelpOpen: boolean;
  /** Slug of the config object being edited in the side sheet, if any. */
  configSheetSlug: string | null;

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarFloating: () => void;
  setSidebarWidth: (width: number) => void;

  setDensity: (density: Density) => void;
  toggleDensity: () => void;
  setContextRailOpen: (open: boolean) => void;
  toggleContextRail: () => void;
  openWhyDrawer: (ticketId: number) => void;
  closeWhyDrawer: () => void;

  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  setKeyboardHelpOpen: (open: boolean) => void;
  toggleKeyboardHelp: () => void;
  openConfigSheet: (slug: string) => void;
  closeConfigSheet: () => void;
  /** Escape closes exactly one layer, outermost first. Returns true if it did. */
  dismissTopLayer: () => boolean;
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarOpen: true,
  sidebarCollapsed: readBool(STORAGE_KEYS.sidebarCollapsed),
  sidebarFloating: readBool(STORAGE_KEYS.sidebarFloating),
  sidebarWidth: readWidth(),

  density: readDensity(),
  contextRailOpen: true,
  whyDrawerTicketId: null,

  commandPaletteOpen: false,
  keyboardHelpOpen: false,
  configSheetSlug: null,

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),

  // Collapsed and floating are mutually exclusive: turning one on turns the
  // other off, and both are persisted so the layout survives a reload.
  toggleSidebarCollapsed: () => {
    const next = !get().sidebarCollapsed;
    writeString(STORAGE_KEYS.sidebarCollapsed, String(next));
    if (next) writeString(STORAGE_KEYS.sidebarFloating, 'false');
    set((state) => ({ sidebarCollapsed: next, sidebarFloating: next ? false : state.sidebarFloating }));
  },

  setSidebarCollapsed: (collapsed) => {
    writeString(STORAGE_KEYS.sidebarCollapsed, String(collapsed));
    set({ sidebarCollapsed: collapsed });
  },

  toggleSidebarFloating: () => {
    const next = !get().sidebarFloating;
    writeString(STORAGE_KEYS.sidebarFloating, String(next));
    if (next) writeString(STORAGE_KEYS.sidebarCollapsed, 'false');
    set((state) => ({ sidebarFloating: next, sidebarCollapsed: next ? false : state.sidebarCollapsed }));
  },

  setSidebarWidth: (width) => {
    const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(width)));
    writeString(STORAGE_KEYS.sidebarWidth, String(clamped));
    set({ sidebarWidth: clamped });
  },

  setDensity: (density) => {
    writeString(STORAGE_KEYS.queueDensity, density);
    set({ density });
  },

  toggleDensity: () => {
    const next: Density = get().density === 'compact' ? 'comfortable' : 'compact';
    writeString(STORAGE_KEYS.queueDensity, next);
    set({ density: next });
  },

  setContextRailOpen: (contextRailOpen) => set({ contextRailOpen }),
  toggleContextRail: () => set((state) => ({ contextRailOpen: !state.contextRailOpen })),

  openWhyDrawer: (whyDrawerTicketId) => set({ whyDrawerTicketId }),
  closeWhyDrawer: () => set({ whyDrawerTicketId: null }),

  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  toggleCommandPalette: () => set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),

  setKeyboardHelpOpen: (keyboardHelpOpen) => set({ keyboardHelpOpen }),
  toggleKeyboardHelp: () => set((state) => ({ keyboardHelpOpen: !state.keyboardHelpOpen })),

  openConfigSheet: (configSheetSlug) => set({ configSheetSlug }),
  closeConfigSheet: () => set({ configSheetSlug: null }),

  dismissTopLayer: () => {
    const state = get();
    if (state.commandPaletteOpen) {
      set({ commandPaletteOpen: false });
      return true;
    }
    if (state.keyboardHelpOpen) {
      set({ keyboardHelpOpen: false });
      return true;
    }
    if (state.configSheetSlug !== null) {
      set({ configSheetSlug: null });
      return true;
    }
    if (state.whyDrawerTicketId !== null) {
      set({ whyDrawerTicketId: null });
      return true;
    }
    return false;
  },
}));

export const SIDEBAR_BOUNDS = { min: MIN_SIDEBAR_WIDTH, max: MAX_SIDEBAR_WIDTH } as const;
