/**
 * format.ts — every number, date and duration the desk renders.
 *
 * Two rules hold everything else together:
 *   • The wire carries ISO-8601 UTC strings, never Date objects and never epoch
 *     millis. Parsing happens here and nowhere else, so an invalid instant
 *     degrades to an em dash instead of "Invalid Date" in a table cell.
 *   • The locale is read from `<html lang>` at call time rather than captured
 *     at import time. `setLanguage()` writes that attribute, so switching
 *     language re-renders correctly without a reload and without this module
 *     importing i18next (which would make the dependency graph circular).
 */

import { DEFAULT_LOCALE, FALLBACK_LOCALE } from '@oblidesk/shared';

/** What an absent / unparseable value renders as. Never an empty cell. */
export const EMPTY = '—';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The active BCP-47 tag, from `<html lang>`, falling back to the app default. */
export function currentLocale(): string {
  if (typeof document !== 'undefined') {
    const lang = document.documentElement.getAttribute('lang');
    if (lang) return lang;
  }
  return DEFAULT_LOCALE;
}

/** Parse an ISO instant. Returns null rather than an Invalid Date. */
export function parseIso(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ═════════════════════════════════════════════════════════════════════════════
// Dates
// ═════════════════════════════════════════════════════════════════════════════

function dtf(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(currentLocale(), options);
  } catch {
    return new Intl.DateTimeFormat(FALLBACK_LOCALE, options);
  }
}

/** '14 mars 2026' / '14 Mar 2026'. */
export function formatDate(value: string | Date | null | undefined): string {
  const date = parseIso(value);
  if (!date) return EMPTY;
  return dtf({ day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

/** '14 mars 2026, 09:41'. The desk's default timestamp. */
export function formatDateTime(value: string | Date | null | undefined): string {
  const date = parseIso(value);
  if (!date) return EMPTY;
  return dtf({
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** '09:41' — for a same-day journal entry. */
export function formatTime(value: string | Date | null | undefined): string {
  const date = parseIso(value);
  if (!date) return EMPTY;
  return dtf({ hour: '2-digit', minute: '2-digit' }).format(date);
}

/** Full precision, for a tooltip over a relative timestamp. */
export function formatDateTimeLong(value: string | Date | null | undefined): string {
  const date = parseIso(value);
  if (!date) return EMPTY;
  return dtf({
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

/** 'YYYY-MM-DD' in local time — the shape metric rollups are keyed by. */
export function toLocalDay(value: string | Date | null | undefined): string {
  const date = parseIso(value);
  if (!date) return EMPTY;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isSameDay(a: string | Date | null | undefined, b: string | Date | null | undefined): boolean {
  const left = parseIso(a);
  const right = parseIso(b);
  if (!left || !right) return false;
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function isToday(value: string | Date | null | undefined): boolean {
  return isSameDay(value, new Date());
}

/**
 * Timestamp for a list row: the time alone when it happened today, the day and
 * month this year, the full date beyond that. Dense without being ambiguous.
 */
export function formatSmartDate(value: string | Date | null | undefined): string {
  const date = parseIso(value);
  if (!date) return EMPTY;
  const now = new Date();
  if (isSameDay(date, now)) return formatTime(date);
  if (date.getFullYear() === now.getFullYear()) {
    return dtf({ day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
  }
  return formatDate(date);
}

// ═════════════════════════════════════════════════════════════════════════════
// Relative time
// ═════════════════════════════════════════════════════════════════════════════

function rtf(): Intl.RelativeTimeFormat {
  try {
    return new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto', style: 'short' });
  } catch {
    return new Intl.RelativeTimeFormat(FALLBACK_LOCALE, { numeric: 'auto', style: 'short' });
  }
}

/** 'il y a 3 min' / 'in 2 h'. Signed — past is negative, future is positive. */
export function formatRelative(value: string | Date | null | undefined, from: Date = new Date()): string {
  const date = parseIso(value);
  if (!date) return EMPTY;

  const deltaMs = date.getTime() - from.getTime();
  const abs = Math.abs(deltaMs);
  const format = rtf();

  if (abs < 45_000) return format.format(Math.round(deltaMs / 1000), 'second');
  if (abs < 45 * MINUTE_MS) return format.format(Math.round(deltaMs / MINUTE_MS), 'minute');
  if (abs < 22 * HOUR_MS) return format.format(Math.round(deltaMs / HOUR_MS), 'hour');
  if (abs < 26 * DAY_MS) return format.format(Math.round(deltaMs / DAY_MS), 'day');
  if (abs < 320 * DAY_MS) return format.format(Math.round(deltaMs / (30 * DAY_MS)), 'month');
  return format.format(Math.round(deltaMs / (365 * DAY_MS)), 'year');
}

// ═════════════════════════════════════════════════════════════════════════════
// Durations
// ═════════════════════════════════════════════════════════════════════════════

/**
 * '2 h 15' / '3 j 4 h' / '45 min'. Two units at most: a queue row has no space
 * for seconds and nobody reads them.
 */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return EMPTY;

  const negative = minutes < 0;
  const total = Math.round(Math.abs(minutes));
  const unit = (key: 'd' | 'h' | 'm') => {
    const fr = currentLocale().startsWith('fr');
    if (key === 'd') return fr ? 'j' : 'd';
    if (key === 'h') return 'h';
    return fr ? 'min' : 'm';
  };

  let out: string;
  if (total < 60) {
    out = `${total} ${unit('m')}`;
  } else if (total < 24 * 60) {
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    out = mins === 0 ? `${hours} ${unit('h')}` : `${hours} ${unit('h')} ${mins}`;
  } else {
    const days = Math.floor(total / (24 * 60));
    const hours = Math.floor((total % (24 * 60)) / 60);
    out = hours === 0 ? `${days} ${unit('d')}` : `${days} ${unit('d')} ${hours} ${unit('h')}`;
  }
  return negative ? `-${out}` : out;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return EMPTY;
  if (Math.abs(ms) < MINUTE_MS) return `${Math.round(ms / 1000)} s`;
  return formatDuration(ms / MINUTE_MS);
}

/** Elapsed wall time since an instant — the running timer on a time entry. */
export function formatElapsed(since: string | Date | null | undefined, until: Date = new Date()): string {
  const start = parseIso(since);
  if (!start) return EMPTY;
  const seconds = Math.max(0, Math.floor((until.getTime() - start.getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// SLA
// ═════════════════════════════════════════════════════════════════════════════

export type SlaTone = 'ok' | 'warn' | 'breach' | 'paused' | 'met' | 'none';

/**
 * How the countdown chip should read. `paused` wins over everything: a paused
 * clock that renders red is a lie the agent will act on.
 */
export function slaTone(input: {
  status?: string | null;
  running?: boolean;
  dueAt?: string | null;
  remainingMinutes?: number | null;
}): SlaTone {
  const { status, running, dueAt } = input;
  if (status === 'met') return 'met';
  if (status === 'breached') return 'breach';
  if (status === 'cancelled') return 'none';
  if (status === 'paused' || running === false) return 'paused';
  if (!dueAt) return 'none';

  const remaining =
    input.remainingMinutes ?? minutesUntil(dueAt);
  if (remaining === null) return 'none';
  if (remaining <= 0) return 'breach';
  // Under an hour is the point an agent can still do something about it.
  return remaining <= 60 ? 'warn' : 'ok';
}

export function minutesUntil(value: string | Date | null | undefined, from: Date = new Date()): number | null {
  const date = parseIso(value);
  if (!date) return null;
  return Math.round((date.getTime() - from.getTime()) / MINUTE_MS);
}

/** 'reste 2 h 15' vs '-1 h 20' once breached. Sign is the whole message. */
export function formatCountdown(dueAt: string | Date | null | undefined, from: Date = new Date()): string {
  const minutes = minutesUntil(dueAt, from);
  if (minutes === null) return EMPTY;
  return formatDuration(minutes);
}

// ═════════════════════════════════════════════════════════════════════════════
// Numbers
// ═════════════════════════════════════════════════════════════════════════════

export function formatNumber(value: number | null | undefined, maximumFractionDigits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  try {
    return new Intl.NumberFormat(currentLocale(), { maximumFractionDigits }).format(value);
  } catch {
    return String(value);
  }
}

/** Counters above the exact-count threshold render as '5 000+', never a lie. */
export function formatCount(value: number | null | undefined, approximate = false): string {
  if (value === null || value === undefined) return EMPTY;
  const base = formatNumber(value);
  return approximate ? `${base}+` : base;
}

export function formatPercent(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  try {
    return new Intl.NumberFormat(currentLocale(), {
      style: 'percent',
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value > 1.5 ? value / 100 : value);
  } catch {
    return `${Math.round(value)}%`;
  }
}

export function formatCurrency(value: number | null | undefined, currency = 'EUR'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  try {
    return new Intl.NumberFormat(currentLocale(), { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

const BYTE_UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'] as const;
const BYTE_UNITS_EN = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return EMPTY;
  const units = currentLocale().startsWith('fr') ? BYTE_UNITS : BYTE_UNITS_EN;
  if (bytes < 1024) return `${Math.round(bytes)} ${units[0]}`;
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Text
// ═════════════════════════════════════════════════════════════════════════════

/** 'Marie Dupont' → 'MD'. Falls back to the username, then to '?'. */
export function initials(...candidates: Array<string | null | undefined>): string {
  const source = candidates.find((value) => typeof value === 'string' && value.trim() !== '');
  if (!source) return '?';
  const words = source.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function truncate(value: string | null | undefined, max = 80): string {
  if (!value) return EMPTY;
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** A person's best display string, in the order the desk prefers them. */
export function displayNameOf(
  person: { displayName?: string | null; username?: string | null; email?: string | null } | null | undefined,
): string {
  if (!person) return EMPTY;
  return person.displayName?.trim() || person.username?.trim() || person.email?.trim() || EMPTY;
}

/** Strip markdown to a single line, for a list preview. Never renders HTML. */
export function excerpt(markdown: string | null | undefined, max = 140): string {
  if (!markdown) return '';
  const flat = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat ? truncate(flat, max) : '';
}

/** 'ACME-1042' — already formatted by the server; normalised for safety. */
export function ticketNumber(value: string | null | undefined): string {
  return value ? value.toUpperCase() : EMPTY;
}
