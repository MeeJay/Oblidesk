// ─────────────────────────────────────────────────────────────────────────────
// Theme catalog — mirrors D:\Obligate\shared\src\themes.ts shape EXACTLY.
//
// Obligate owns the catalog; every consumer app ships the same descriptors so
// it can render a theme picker offline and apply an SSO-pushed `preferredTheme`
// without a round trip. The ids MUST match Obligate's catalog and this app's
// `[data-theme="…"]` CSS selectors — `applyTheme()` only accepts known ids and
// silently falls back to the default otherwise (see the design system §10).
//
// Token values are SPACE-SEPARATED RGB TRIPLETS so Tailwind's opacity modifier
// works: `bg-accent/30` emits `rgb(var(--c-accent) / 0.3)`.
//
// CRITICAL — `--c-border`, `--c-bg-hover` and `--c-bg-active` must be plain
// triplets with NO embedded alpha. Tailwind always emits
// `rgb(var(--x) / <alpha-value>)`; a stored "R G B / A" produces invalid CSS,
// the rule is dropped, and the app falls back to thick black borders.
//
// HARD RULE 11 — no `border:` on cards / pills / buttons. Depth comes from the
// background step (--c-bg-primary → secondary → tertiary) plus --shadow-card.
// The border tokens exist only for scrollbars, separators and focus rings.
// ─────────────────────────────────────────────────────────────────────────────

/** Theme ids this app knows how to render. Keep in sync with `index.css`. */
export type AppTheme = 'obli-operator' | 'obli-daylight' | 'modern' | 'neon';

export const APP_THEMES: readonly AppTheme[] = ['obli-operator', 'obli-daylight', 'modern', 'neon'];

export type ThemeAppKey =
  | 'obliview'
  | 'obliguard'
  | 'oblimap'
  | 'obliance'
  | 'obliplan'
  | 'oblidesk'
  | 'oblihub';

export interface ThemeAppAccent {
  accent: string;
  hover: string;
  dark: string;
}

export interface ThemeFonts {
  sans: string[];
  mono: string[];
}

export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  layoutVersion: string | null;
  tokens: Record<string, string>;
  perApp: Record<ThemeAppKey, ThemeAppAccent> | null;
  fonts: ThemeFonts | null;
}

// ── Oblidesk identity ────────────────────────────────────────────────────────

/**
 * Oblidesk is the CYAN app of the suite — #22b8f5, highlight #5fd0ff.
 * These are the exact triplets Obligate carries under `perApp.oblidesk`, and
 * the values the client writes onto `--c-accent` / `--c-accent-hover` /
 * `--c-accent-dark` after applying a theme.
 */
export const OBLIDESK_ACCENT = {
  /** rgb triplet — '34 184 245' (#22b8f5) */
  accent: '34 184 245',
  /** rgb triplet — '95 208 255' (#5fd0ff) */
  hover: '95 208 255',
  /** rgb triplet — '23 137 187' (#1789bb) */
  dark: '23 137 187',
  hex: '#22b8f5',
  hexHover: '#5fd0ff',
  hexDark: '#1789bb',
} as const;

/** Deeper cyan for the light theme, so the accent reads on white. */
export const OBLIDESK_ACCENT_LIGHT = {
  accent: '2 132 199',
  hover: '14 165 233',
  dark: '7 89 133',
  hex: '#0284c7',
  hexHover: '#0ea5e9',
  hexDark: '#075985',
} as const;

export const APP_TYPE_KEY: ThemeAppKey = 'oblidesk';

// ── Obli Operator (default) ──────────────────────────────────────────────────

export const OBLI_OPERATOR_THEME: ThemeDefinition = {
  id: 'obli-operator',
  name: 'Obli Operator',
  description:
    'Default dark theme for the Obli suite — Rajdhani display + JetBrains Mono numerics, brighter type scale, depth via shadow (no borders), per-app accent.',
  isDefault: true,
  layoutVersion: 'v1',

  tokens: {
    '--c-bg-primary': '11 13 26',
    '--c-bg-secondary': '19 23 40',
    '--c-bg-tertiary': '24 28 48',
    '--c-bg-hover': '29 34 56',
    '--c-bg-active': '34 39 64',

    '--c-border': '42 48 72',
    '--c-border-light': '62 70 100',

    '--c-text-primary': '240 244 252',
    '--c-text-secondary': '180 188 215',
    '--c-text-muted': '130 140 175',

    '--c-status-up': '30 221 138',
    '--c-status-up-bg': '12 40 26',
    '--c-status-down': '107 115 153',
    '--c-status-down-bg': '24 28 48',
    '--c-status-pending': '79 123 255',
    '--c-status-pending-bg': '16 24 56',
    '--c-status-warning': '245 166 35',
    '--c-status-warning-bg': '46 33 17',
    '--c-status-critical': '224 58 58',
    '--c-status-critical-bg': '48 18 18',
    '--c-status-neutral': '107 115 153',
    '--c-status-neutral-bg': '19 23 40',

    // Oblidesk cyan
    '--c-accent': OBLIDESK_ACCENT.accent,
    '--c-accent-hover': OBLIDESK_ACCENT.hover,
    '--c-accent-dark': OBLIDESK_ACCENT.dark,
    '--c-primary': OBLIDESK_ACCENT.accent,
  },

  perApp: {
    obliview: { accent: '43 196 189', hover: '95 217 211', dark: '24 142 138' },
    obliguard: { accent: '245 166 35', hover: '255 184 74', dark: '184 124 24' },
    oblimap: { accent: '30 221 138', hover: '92 240 168', dark: '20 165 105' },
    obliance: { accent: '224 58 58', hover: '255 104 104', dark: '180 30 30' },
    obliplan: { accent: '124 108 255', hover: '157 140 255', dark: '86 70 200' },
    oblidesk: { accent: OBLIDESK_ACCENT.accent, hover: OBLIDESK_ACCENT.hover, dark: OBLIDESK_ACCENT.dark },
    oblihub: { accent: '45 78 201', hover: '90 120 232', dark: '30 56 158' },
  },

  fonts: {
    sans: ['Rajdhani', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
    mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
  },
};

// ── Obli Daylight (light companion) ──────────────────────────────────────────

export const OBLI_DAYLIGHT_THEME: ThemeDefinition = {
  id: 'obli-daylight',
  name: 'Obli Daylight',
  description:
    'Light companion to Obli Operator — Nordic Mist surfaces, Inter type, soft shadows, same per-app accents tuned for readability on white.',
  isDefault: false,
  layoutVersion: 'v1',

  tokens: {
    '--c-bg-primary': '229 233 240', // #e5e9f0  Snow Storm page bg
    '--c-bg-secondary': '236 239 244', // #eceff4  cards
    '--c-bg-tertiary': '216 222 233', // #d8dee9  inputs / pill container
    '--c-bg-hover': '222 227 236',
    '--c-bg-active': '210 217 229',

    '--c-border': '212 220 231',
    '--c-border-light': '224 230 240',

    '--c-text-primary': '46 52 64', // #2e3440  Polar Night
    '--c-text-secondary': '76 86 106', // #4c566a
    '--c-text-muted': '129 141 161', // #818da1

    '--c-status-up': '16 163 96',
    '--c-status-up-bg': '220 252 231',
    '--c-status-down': '148 163 184',
    '--c-status-down-bg': '216 222 233',
    '--c-status-pending': '37 99 235',
    '--c-status-pending-bg': '219 234 254',
    '--c-status-warning': '217 119 6',
    '--c-status-warning-bg': '254 243 199',
    '--c-status-critical': '220 38 38',
    '--c-status-critical-bg': '254 226 226',
    '--c-status-neutral': '100 116 139',
    '--c-status-neutral-bg': '216 222 233',

    // Deeper cyan so the accent survives a white surface.
    '--c-accent': OBLIDESK_ACCENT_LIGHT.accent,
    '--c-accent-hover': OBLIDESK_ACCENT_LIGHT.hover,
    '--c-accent-dark': OBLIDESK_ACCENT_LIGHT.dark,
    '--c-primary': OBLIDESK_ACCENT_LIGHT.accent,
  },

  perApp: {
    obliview: { accent: '13 148 136', hover: '20 184 166', dark: '15 118 110' },
    obliguard: { accent: '217 119 6', hover: '234 88 12', dark: '154 52 18' },
    oblimap: { accent: '22 163 74', hover: '34 197 94', dark: '21 128 61' },
    obliance: { accent: '220 38 38', hover: '239 68 68', dark: '153 27 27' },
    obliplan: { accent: '99 102 241', hover: '129 140 248', dark: '67 56 202' },
    oblidesk: {
      accent: OBLIDESK_ACCENT_LIGHT.accent,
      hover: OBLIDESK_ACCENT_LIGHT.hover,
      dark: OBLIDESK_ACCENT_LIGHT.dark,
    },
    oblihub: { accent: '37 99 235', hover: '59 130 246', dark: '30 64 175' },
  },

  fonts: {
    sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
    mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
  },
};

// ── Legacy themes ────────────────────────────────────────────────────────────
// Kept so users who chose them before Obli Operator existed keep their
// preference. Obligate ships them as descriptors with empty tokens; Oblidesk
// carries the real values because the client renders them from `index.css`
// AND from these maps when a theme is applied programmatically.

export const OBLI_CLASSIC_THEME: ThemeDefinition = {
  id: 'modern',
  name: 'Modern UI',
  description: 'Original GitHub-inspired dark theme, re-accented in Oblidesk cyan.',
  isDefault: false,
  layoutVersion: null,

  tokens: {
    '--c-bg-primary': '13 13 12',
    '--c-bg-secondary': '21 21 19',
    '--c-bg-tertiary': '29 28 27',
    '--c-bg-hover': '37 36 34',
    '--c-bg-active': '46 45 42',

    '--c-border': '55 54 51',
    '--c-border-light': '69 67 63',

    '--c-text-primary': '229 227 224',
    '--c-text-secondary': '140 137 133',
    '--c-text-muted': '107 104 100',

    '--c-status-up': '46 160 67',
    '--c-status-up-bg': '13 40 24',
    '--c-status-down': '248 81 73',
    '--c-status-down-bg': '61 20 24',
    '--c-status-pending': '88 166 255',
    '--c-status-pending-bg': '13 37 70',
    '--c-status-warning': '210 153 34',
    '--c-status-warning-bg': '46 33 17',
    '--c-status-critical': '248 81 73',
    '--c-status-critical-bg': '61 20 24',
    '--c-status-neutral': '140 137 133',
    '--c-status-neutral-bg': '29 28 27',

    '--c-accent': '34 170 224',
    '--c-accent-hover': '86 200 244',
    '--c-accent-dark': '20 118 158',
    '--c-primary': '34 170 224',
  },

  perApp: null,
  fonts: null,
};

export const OBLI_NEON_THEME: ThemeDefinition = {
  id: 'neon',
  name: 'Neon UI',
  description: 'High-contrast near-black variant with a glowing cyan accent.',
  isDefault: false,
  layoutVersion: null,

  tokens: {
    '--c-bg-primary': '7 8 10',
    '--c-bg-secondary': '13 14 17',
    '--c-bg-tertiary': '19 20 24',
    '--c-bg-hover': '27 27 32',
    '--c-bg-active': '36 36 42',

    '--c-border': '50 51 57',
    '--c-border-light': '65 66 73',

    '--c-text-primary': '234 242 248',
    '--c-text-secondary': '134 150 164',
    '--c-text-muted': '92 106 120',

    '--c-status-up': '0 195 95',
    '--c-status-up-bg': '0 28 14',
    '--c-status-down': '255 56 96',
    '--c-status-down-bg': '42 0 16',
    '--c-status-pending': '80 170 255',
    '--c-status-pending-bg': '0 25 52',
    '--c-status-warning': '255 190 0',
    '--c-status-warning-bg': '36 22 0',
    '--c-status-critical': '255 56 96',
    '--c-status-critical-bg': '42 0 16',
    '--c-status-neutral': '106 118 130',
    '--c-status-neutral-bg': '19 20 24',

    '--c-accent': '60 210 255',
    '--c-accent-hover': '130 230 255',
    '--c-accent-dark': '20 150 190',
    '--c-primary': '60 210 255',
  },

  perApp: null,
  fonts: null,
};

export const THEME_CATALOG: ThemeDefinition[] = [
  OBLI_OPERATOR_THEME,
  OBLI_DAYLIGHT_THEME,
  OBLI_CLASSIC_THEME,
  OBLI_NEON_THEME,
];

export const DEFAULT_THEME_ID: AppTheme = 'obli-operator';

/** Token maps keyed by theme id — what `applyThemeTokens()` writes to :root. */
export const THEME_TOKENS: Readonly<Record<AppTheme, Record<string, string>>> = {
  'obli-operator': OBLI_OPERATOR_THEME.tokens,
  'obli-daylight': OBLI_DAYLIGHT_THEME.tokens,
  modern: OBLI_CLASSIC_THEME.tokens,
  neon: OBLI_NEON_THEME.tokens,
};

/** Shadow recipes — depth without borders (HARD RULE 11). */
export const THEME_SHADOWS: Readonly<Record<AppTheme, { card: string; glow: string }>> = {
  'obli-operator': {
    card: '0 1px 0 0 rgba(255,255,255,0.03), 0 6px 24px -8px rgba(0,0,0,0.45)',
    glow: '0 0 0 1px rgb(var(--c-accent) / 0.18) inset, 0 6px 28px -10px rgb(var(--c-accent) / 0.25)',
  },
  'obli-daylight': {
    card: '0 1px 2px 0 rgba(46,52,64,0.03), 0 6px 24px -12px rgba(46,52,64,0.08)',
    glow: '0 0 0 1px rgb(var(--c-accent) / 0.18) inset, 0 8px 32px -12px rgb(var(--c-accent) / 0.22)',
  },
  modern: {
    card: '0 1px 0 0 rgba(255,255,255,0.03), 0 6px 24px -8px rgba(0,0,0,0.55)',
    glow: '0 0 0 1px rgb(var(--c-accent) / 0.18) inset, 0 6px 28px -10px rgb(var(--c-accent) / 0.25)',
  },
  neon: {
    card: '0 1px 0 0 rgba(255,255,255,0.04), 0 8px 30px -10px rgba(0,0,0,0.7)',
    glow: '0 0 0 1px rgb(var(--c-accent) / 0.35) inset, 0 0 28px -6px rgb(var(--c-accent) / 0.45)',
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && (APP_THEMES as readonly string[]).includes(value);
}

/**
 * Coerce an SSO-pushed / stored theme id to something this app can render.
 * A theme added upstream in Obligate can never brick the client.
 */
export function toAppTheme(value: unknown, fallback: AppTheme = DEFAULT_THEME_ID): AppTheme {
  return isAppTheme(value) ? value : fallback;
}

export function getThemeById(id: string): ThemeDefinition | undefined {
  return THEME_CATALOG.find((theme) => theme.id === id);
}

export function getPerAppAccent(themeId: string, app: ThemeAppKey): ThemeAppAccent | null {
  const theme = getThemeById(themeId);
  return theme?.perApp?.[app] ?? null;
}

/** Oblidesk's own accent for a theme, falling back to the cyan identity. */
export function getOblideskAccent(themeId: string): ThemeAppAccent {
  return getPerAppAccent(themeId, APP_TYPE_KEY) ?? {
    accent: OBLIDESK_ACCENT.accent,
    hover: OBLIDESK_ACCENT.hover,
    dark: OBLIDESK_ACCENT.dark,
  };
}

/** `'34 184 245'` → `'#22b8f5'`. Returns null on a malformed triplet. */
export function tripletToHex(triplet: string): string | null {
  const parts = triplet.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const channels: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const value = Number(parts[i]);
    if (!Number.isFinite(value) || value < 0 || value > 255) return null;
    channels.push(Math.round(value));
  }
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** `rgb(var(--c-accent) / 0.3)`-style helper for inline styles. */
export function tokenColor(token: string, alpha?: number): string {
  return alpha === undefined ? `rgb(var(${token}))` : `rgb(var(${token}) / ${alpha})`;
}
