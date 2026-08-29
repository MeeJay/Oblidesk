/**
 * main.tsx — the browser entry point.
 *
 * Three things happen before React is allowed to paint, and the order matters:
 *
 *   1. `@/i18n` — the i18next instance must be initialised BEFORE the first
 *      `useTranslation()` runs, or the tree renders once with raw keys and then
 *      flips to French a tick later. ES module imports are evaluated before this
 *      module's body, so importing it here is enough.
 *   2. `./index.css` — Tailwind's layers plus the four theme token blocks.
 *   3. `initTheme()` — re-applies the persisted theme id onto `<html>`.
 *
 * `index.html` already sets `data-theme` from `localStorage['og-theme']` in a
 * blocking inline script, so there is no flash even on a cold load. This call is
 * not redundant with it: the inline script only knows the four ids hard-coded in
 * the HTML, while `initTheme()` validates against `APP_THEMES` in the shared
 * package and rewrites a stale or unknown id back to the default. The two agree
 * today; if a theme is ever added upstream, this is the one that stays right.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/i18n';
import App from './App';
import { initTheme } from './utils/theme';
import './index.css';

initTheme();

const container = document.getElementById('root');

// A missing #root means the shell HTML was replaced by something else (a proxy
// error page, a stale service worker). Failing loudly beats a blank screen with
// a silent null-assertion crash deeper in React.
if (!container) {
  throw new Error('Oblidesk: #root introuvable dans index.html — le shell HTML est incorrect.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
