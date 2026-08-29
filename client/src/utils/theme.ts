/**
 * theme.ts — the one place a theme id becomes a rendered theme.
 *
 * `index.css` owns the token values under `[data-theme="…"]`; this module only
 * decides WHICH id is on `<html>` and persists it. Nothing here writes inline
 * custom properties: an inline style would outrank the stylesheet and quietly
 * pin the app to whatever the last write happened to contain.
 *
 * The storage key is shared across the whole Obli* suite (STORAGE_KEYS.theme =
 * 'og-theme'), so a theme picked in Obligate is already applied when the user
 * lands here. `index.html` reads the same key before first paint to avoid a
 * flash; keep the two in step.
 */

import {
  APP_THEMES,
  DEFAULT_THEME_ID,
  STORAGE_KEYS,
  THEME_CATALOG,
  type AppTheme,
  type ThemeDefinition,
} from '@oblidesk/shared';

export type { AppTheme, ThemeDefinition };

const STORAGE_KEY = STORAGE_KEYS.theme;

/**
 * Ids this build can actually render. A theme added upstream in Obligate and
 * pushed down through SSO must never brick the client, so anything unknown
 * falls back to the default instead of being written to `<html>`.
 */
const KNOWN = new Set<AppTheme>(APP_THEMES);

/** The descriptors a theme picker renders — name, description, default flag. */
export const THEME_OPTIONS: readonly ThemeDefinition[] = THEME_CATALOG;

export function isKnownTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && KNOWN.has(value as AppTheme);
}

/** Apply a theme by setting `data-theme` on `<html>` and persisting it. */
export function applyTheme(theme: string): AppTheme {
  const safe = isKnownTheme(theme) ? theme : DEFAULT_THEME_ID;
  document.documentElement.dataset.theme = safe;
  try {
    localStorage.setItem(STORAGE_KEY, safe);
  } catch {
    // localStorage unavailable (private mode, blocked site data) — the theme
    // still applies for this page load, it just will not survive a reload.
  }
  return safe;
}

/** Read the persisted theme. Used before the session check, to avoid a flash. */
export function loadSavedTheme(): AppTheme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isKnownTheme(saved)) return saved;
  } catch {
    // ignore
  }
  return DEFAULT_THEME_ID;
}

/** The id currently on `<html>`, whatever put it there. */
export function currentTheme(): AppTheme {
  const attr = document.documentElement.dataset.theme;
  return isKnownTheme(attr) ? attr : DEFAULT_THEME_ID;
}

/** Apply the saved theme immediately on import — prevents FOUC. */
export function initTheme(): void {
  applyTheme(loadSavedTheme());
}

/** Cycle to the next theme in catalog order. Drives the topbar toggle. */
export function nextTheme(from: AppTheme = currentTheme()): AppTheme {
  const index = APP_THEMES.indexOf(from);
  return APP_THEMES[(index + 1) % APP_THEMES.length] ?? DEFAULT_THEME_ID;
}

/** True when the active theme is a light surface — for chart palettes, maps… */
export function isLightTheme(theme: AppTheme = currentTheme()): boolean {
  return theme === 'obli-daylight';
}
