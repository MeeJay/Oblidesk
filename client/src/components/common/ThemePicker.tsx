import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { APP_THEMES, type AppTheme } from '@oblidesk/shared';
import { applyTheme } from '@/utils/theme';
import { cn } from '@/utils/cn';

interface ThemePickerProps {
  value: AppTheme;
  onChange: (theme: AppTheme) => void;
  className?: string;
}

interface ThemePreview {
  bg: string;
  card: string;
  raised: string;
  accent: string;
  textPrimary: string;
  textMuted: string;
  /** The "resolved" green — the dot in the preview's ticket row. */
  ok: string;
  /** The "breach" red — the pill on the preview's second row. */
  breach: string;
}

interface ThemeOption {
  id: AppTheme;
  /** i18n key + inline French fallback (HARD RULE 10). */
  labelKey: string;
  label: string;
  descriptionKey: string;
  description: string;
  preview: ThemePreview;
}

/**
 * Swatches mirror `client/src/index.css` exactly. They are literals rather than
 * reads of the live CSS variables on purpose: all four cards must render their
 * OWN palette side by side, and a `var(--c-bg-primary)` would paint every card
 * in the currently active theme.
 */
const THEMES: ThemeOption[] = [
  {
    id: 'obli-operator',
    labelKey: 'theme.obliOperator',
    label: 'Obli Operator',
    descriptionKey: 'theme.obliOperatorDesc',
    description: 'Sombre bleu nuit, accent cyan Oblidesk',
    preview: {
      bg: '#0b0d1a',
      card: '#131728',
      raised: '#181c30',
      accent: '#22b8f5',
      textPrimary: '#f0f4fc',
      textMuted: '#828caf',
      ok: '#1edd8a',
      breach: '#ef4444',
    },
  },
  {
    id: 'obli-daylight',
    labelKey: 'theme.obliDaylight',
    label: 'Obli Daylight',
    descriptionKey: 'theme.obliDaylightDesc',
    description: 'Clair Nordic Mist, cyan approfondi',
    preview: {
      bg: '#e5e9f0',
      card: '#eceff4',
      raised: '#d8dee9',
      accent: '#0284c7',
      textPrimary: '#2e3440',
      textMuted: '#818da1',
      ok: '#10844f',
      breach: '#be1818',
    },
  },
  {
    id: 'modern',
    labelKey: 'theme.modern',
    label: 'Modern UI',
    descriptionKey: 'theme.modernDesc',
    description: 'Sombre neutre, accent cyan',
    preview: {
      bg: '#0d0d0c',
      card: '#151513',
      raised: '#1d1c1b',
      accent: '#22b8f5',
      textPrimary: '#e5e3e0',
      textMuted: '#6b6864',
      ok: '#2ea043',
      breach: '#f85149',
    },
  },
  {
    id: 'neon',
    labelKey: 'theme.neon',
    label: 'Neon UI',
    descriptionKey: 'theme.neonDesc',
    description: 'Tres sombre, halo cyan lumineux',
    preview: {
      bg: '#07080a',
      card: '#0d0e11',
      raised: '#131418',
      accent: '#22b8f5',
      textPrimary: '#eaf2f8',
      textMuted: '#5c6a78',
      ok: '#00c35f',
      breach: '#ff3860',
    },
  },
];

/** A miniature Oblidesk: topbar, sidebar, two ticket rows, an SLA pill. */
function MiniPreview({ preview: p }: { preview: ThemePreview }) {
  return (
    <svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" className="h-full w-full">
      <rect width="120" height="80" fill={p.bg} />

      {/* Topbar — full width, sidebar below it (design system §12) */}
      <rect x="0" y="0" width="120" height="10" fill={p.card} />
      <rect x="4" y="3.5" width="3" height="3" rx="1" fill={p.accent} />
      <rect x="9" y="4" width="13" height="2.5" rx="1.25" fill={p.textPrimary} opacity="0.75" />
      <rect x="27" y="3.5" width="14" height="3.5" rx="1.75" fill={p.raised} />
      <rect x="44" y="3.5" width="10" height="3.5" rx="1.75" fill={p.accent} opacity="0.18" />
      <circle cx="112" cy="5.2" r="2.4" fill={p.accent} opacity="0.55" />

      {/* Sidebar */}
      <rect x="0" y="10" width="26" height="70" fill={p.card} />
      <rect x="3" y="13" width="20" height="5" rx="2.5" fill={p.accent} opacity="0.16" />
      <rect x="3" y="21" width="16" height="3" rx="1.5" fill={p.raised} />
      <rect x="3" y="27" width="18" height="3" rx="1.5" fill={p.raised} />
      <rect x="0" y="33" width="26" height="5" rx="0" fill={p.accent} opacity="0.12" />
      <rect x="3" y="34.5" width="14" height="2.5" rx="1.25" fill={p.accent} />
      <rect x="3" y="42" width="15" height="3" rx="1.5" fill={p.raised} />
      <rect x="3" y="48" width="17" height="3" rx="1.5" fill={p.raised} />

      {/* Ticket rows */}
      <rect x="30" y="14" width="86" height="18" rx="3" fill={p.card} />
      <circle cx="35" cy="20" r="2" fill={p.ok} />
      <rect x="40" y="18" width="34" height="3" rx="1.5" fill={p.textPrimary} opacity="0.8" />
      <rect x="40" y="24" width="22" height="2.5" rx="1.25" fill={p.textMuted} opacity="0.65" />
      <rect x="94" y="17.5" width="18" height="5" rx="2.5" fill={p.ok} opacity="0.18" />

      <rect x="30" y="36" width="86" height="18" rx="3" fill={p.card} />
      <circle cx="35" cy="42" r="2" fill={p.breach} />
      <rect x="40" y="40" width="28" height="3" rx="1.5" fill={p.textPrimary} opacity="0.8" />
      <rect x="40" y="46" width="30" height="2.5" rx="1.25" fill={p.textMuted} opacity="0.65" />
      <rect x="94" y="39.5" width="18" height="5" rx="2.5" fill={p.breach} opacity="0.22" />

      {/* Footer action row */}
      <rect x="30" y="58" width="86" height="18" rx="3" fill={p.card} />
      <rect x="34" y="63" width="40" height="3" rx="1.5" fill={p.textMuted} opacity="0.5" />
      <rect x="34" y="69" width="28" height="2.5" rx="1.25" fill={p.raised} />
      <rect x="94" y="63" width="18" height="7" rx="3" fill={p.accent} />
    </svg>
  );
}

/**
 * Theme selector. The choice is written straight to `localStorage['og-theme']`
 * by `applyTheme()` — the key is shared suite-wide, so picking a theme here
 * carries into Obliguard, Obliance and the rest on the next hop.
 *
 * HARD RULE 11 — the selected card is marked by an accent wash and a check
 * chip, not by a border ring around the card.
 */
export function ThemePicker({ value, onChange, className }: ThemePickerProps) {
  const { t } = useTranslation();

  // Never render a card for a theme the shared catalog has dropped.
  const options = THEMES.filter((theme) => (APP_THEMES as readonly string[]).includes(theme.id));

  const handleSelect = (theme: AppTheme) => {
    applyTheme(theme);
    onChange(theme);
  };

  return (
    <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2', className)}>
      {options.map((theme) => {
        const selected = value === theme.id;
        return (
          <button
            key={theme.id}
            type="button"
            onClick={() => handleSelect(theme.id)}
            aria-pressed={selected}
            className={cn(
              'group flex flex-col overflow-hidden rounded-card text-left transition-colors',
              selected ? 'bg-accent/12 shadow-glow' : 'bg-bg-secondary shadow-card hover:bg-bg-hover',
            )}
          >
            <div className="aspect-[3/2] w-full overflow-hidden">
              <MiniPreview preview={theme.preview} />
            </div>

            <div className="flex items-center gap-2.5 px-3 py-2.5">
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors',
                  selected ? 'bg-accent text-bg-primary' : 'bg-bg-tertiary text-transparent',
                )}
              >
                <Check size={10} strokeWidth={3} />
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    'block truncate text-[13px] font-semibold leading-tight',
                    selected ? 'text-accent' : 'text-text-primary',
                  )}
                >
                  {t(theme.labelKey, theme.label)}
                </span>
                <span className="mt-0.5 block truncate text-[11px] leading-tight text-text-muted">
                  {t(theme.descriptionKey, theme.description)}
                </span>
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
