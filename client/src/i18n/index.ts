/**
 * i18n/index.ts — translation bootstrap.
 *
 * Oblidesk seeds `fr` and `en` only. The suite declares eighteen locales, and
 * the other sixteen resolve to English until the sweep script fills them in —
 * that is deliberate: shipping a half-translated bundle reads as a bug to the
 * user, while a clean fallback reads as "not translated yet".
 *
 * French is the PRIMARY language. Every `t()` call in the app carries an inline
 * French fallback (HARD RULE 10), so a missing key degrades to a readable
 * French sentence rather than to a raw dotted key on screen.
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  RTL_LOCALES,
  SEEDED_LOCALES,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@oblidesk/shared';

import fr from './locales/fr/translation.json';
import en from './locales/en/translation.json';

/** Storage key shared with the sibling apps, so a choice carries across. */
const LANGUAGE_KEY = 'i18n_language';

export interface LanguageOption {
  code: SupportedLocale;
  name: string;
  nativeName: string;
  /** False until the bundle exists — the picker greys these. */
  seeded: boolean;
  dir: 'ltr' | 'rtl';
}

const NATIVE_NAMES: Record<SupportedLocale, { name: string; nativeName: string }> = {
  fr: { name: 'French', nativeName: 'Français' },
  en: { name: 'English', nativeName: 'English' },
  de: { name: 'German', nativeName: 'Deutsch' },
  es: { name: 'Spanish', nativeName: 'Español' },
  it: { name: 'Italian', nativeName: 'Italiano' },
  nl: { name: 'Dutch', nativeName: 'Nederlands' },
  'pt-BR': { name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)' },
  pl: { name: 'Polish', nativeName: 'Polski' },
  cs: { name: 'Czech', nativeName: 'Čeština' },
  da: { name: 'Danish', nativeName: 'Dansk' },
  sv: { name: 'Swedish', nativeName: 'Svenska' },
  tr: { name: 'Turkish', nativeName: 'Türkçe' },
  ru: { name: 'Russian', nativeName: 'Русский' },
  uk: { name: 'Ukrainian', nativeName: 'Українська' },
  ar: { name: 'Arabic', nativeName: 'العربية' },
  ja: { name: 'Japanese', nativeName: '日本語' },
  ko: { name: 'Korean', nativeName: '한국어' },
  'zh-CN': { name: 'Chinese (Simplified)', nativeName: '简体中文' },
};

export const SUPPORTED_LANGUAGES: readonly LanguageOption[] = SUPPORTED_LOCALES.map((code) => ({
  code,
  name: NATIVE_NAMES[code].name,
  nativeName: NATIVE_NAMES[code].nativeName,
  seeded: (SEEDED_LOCALES as readonly string[]).includes(code),
  dir: (RTL_LOCALES as readonly string[]).includes(code) ? 'rtl' : 'ltr',
}));

function isSupported(value: string | null | undefined): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * The language to start in: the explicit choice, then the browser's, then the
 * app default. The browser tag is matched loosely ('fr-CA' → 'fr') because a
 * regional variant we do not ship is still a strong signal of what to show.
 */
function initialLanguage(): SupportedLocale {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (isSupported(saved)) return saved;
  } catch {
    // Storage blocked — fall through to the browser's preference.
  }

  const browser = typeof navigator !== 'undefined' ? navigator.language : '';
  if (isSupported(browser)) return browser;
  const base = browser.split('-')[0];
  if (isSupported(base)) return base;

  return DEFAULT_LOCALE;
}

const startingLanguage = initialLanguage();

void i18n.use(initReactI18next).init({
  resources: {
    fr: { translation: fr },
    en: { translation: en },
  },
  lng: startingLanguage,
  fallbackLng: FALLBACK_LOCALE,
  // React escapes for us; escaping again turns an apostrophe into &#39;.
  interpolation: { escapeValue: false },
  // A key that is present but empty is a translator's "not yet", not a value.
  returnEmptyString: false,
});

/**
 * Switch language, persist it, and update `<html lang>` / `<html dir>`.
 *
 * `lang` is not cosmetic: `utils/format.ts` reads it to pick the Intl locale,
 * so a language change re-formats every date and number without a reload.
 */
export function setLanguage(code: string): void {
  const safe: SupportedLocale = isSupported(code) ? code : FALLBACK_LOCALE;
  void i18n.changeLanguage(safe);

  try {
    localStorage.setItem(LANGUAGE_KEY, safe);
  } catch {
    // ignore
  }

  const option = SUPPORTED_LANGUAGES.find((language) => language.code === safe);
  document.documentElement.setAttribute('lang', safe);
  document.documentElement.setAttribute('dir', option?.dir ?? 'ltr');
}

// Apply on boot so `<html lang>` is right before the first render reads it.
setLanguage(startingLanguage);

export default i18n;
