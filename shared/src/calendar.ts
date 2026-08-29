// ─────────────────────────────────────────────────────────────────────────────
// Business calendar math — PURE functions, shared by client and server.
//
// Why this lives in `shared/`: the SLA countdown rendered in the ticket header
// and the `due_at` written into `sla_instances` MUST agree to the millisecond.
// Two implementations always drift; one implementation cannot.
//
// SEMANTICS
//   • Shifts are LOCAL WALL CLOCK in the calendar's IANA timezone. A
//     "09:00 → 18:00 Europe/Paris" shift is nine wall-clock hours, whatever the
//     UTC offset happens to be that day.
//   • Elapsed business time is REAL time between the UTC instants those wall
//     clock boundaries map to. That is what makes DST correct:
//       – spring forward: a 24×7 day is 23 h (1380 min), not 1440
//       – fall back:      a 24×7 day is 25 h (1500 min), not 1440
//     A 09:00–18:00 shift on a Europe/Paris DST day is still exactly 540 min,
//     because the transition happens at 02:00/03:00, outside the shift.
//   • `startMinute >= endMinute` means the shift SPANS MIDNIGHT and ends the
//     next local day (22:00 → 02:00 is stored as start 1320, end 120 — or
//     equivalently as end 1560; both are accepted). The shift belongs to its
//     START weekday, so a Friday night shift runs into Saturday morning and a
//     Saturday holiday does not truncate it.
//   • Holidays are LOCAL DATES ('YYYY-MM-DD') — the whole local day is closed.
//   • Exceptions OVERRIDE everything for that local date: an exception with
//     shifts opens a day the weekday pattern (or a holiday) would have closed;
//     an exception with an empty shift list closes a day the pattern opens.
//     Precedence: exception > holiday > weekday shifts.
//   • No external date library. Zone math is done with `Intl.DateTimeFormat`
//     (Node 24 / evergreen browsers ship full ICU).
//
// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN TEST VECTORS — these MUST be written as unit tests before this file is
// trusted by the SLA engine. Calendar `business` = Mon–Fri 09:00–18:00
// Europe/Paris (the seeded default); `x247` = is24x7 in Europe/Paris.
//
//  1. Inside one shift.
//     business, 2026-03-02T10:00:00+01:00 → 2026-03-02T12:00:00+01:00  = 120
//  2. Clipped at both ends (before open / after close).
//     business, 2026-03-02T07:00:00+01:00 → 2026-03-02T20:00:00+01:00  = 540
//  3. Overnight gap is skipped.
//     business, 2026-03-02T17:00:00+01:00 → 2026-03-03T10:00:00+01:00  = 120
//  4. Weekend is skipped entirely.
//     business, 2026-03-06T17:00:00+01:00 (Fri) → 2026-03-09T10:00:00+01:00 (Mon) = 120
//  5. Whole business week.
//     business, 2026-03-02T09:00:00+01:00 → 2026-03-06T18:00:00+01:00  = 2700 (5 × 540)
//  6. Zero-length and inverted ranges.
//     business, X → X = 0 ; business, later → earlier = 0 (never negative)
//  7. Both endpoints outside business hours, same closed span.
//     business, 2026-03-07T10:00 (Sat) → 2026-03-08T10:00 (Sun) = 0
//  8. DST spring forward — 2026-03-29 Europe/Paris (02:00 → 03:00, 23 h day).
//     x247, 2026-03-29T00:00:00+01:00 → 2026-03-30T00:00:00+02:00 = 1380
//     business, 2026-03-30T09:00 → 2026-03-30T18:00 (Mon after) = 540
//  9. DST fall back — 2026-10-25 Europe/Paris (03:00 → 02:00, 25 h day).
//     x247, 2026-10-25T00:00:00+02:00 → 2026-10-26T00:00:00+01:00 = 1500
// 10. Holiday closes the day.
//     business + holiday 2026-05-01, 2026-04-30T17:00 → 2026-05-04T10:00 = 120
// 11. Exception opens a Saturday.
//     business + exception {day:'2026-03-07', shifts:[{540,720}]},
//     2026-03-06T17:00 → 2026-03-07T12:00 = 60 (Fri) + 180 (Sat) = 240
// 12. Exception closes a working day (empty shifts) — beats the weekday pattern.
//     business + exception {day:'2026-03-03', shifts:[]},
//     2026-03-02T09:00 → 2026-03-04T09:00 = 540
// 13. Overnight shift, start > end.
//     night = {weekday:5, start:1320, end:120} (Fri 22:00 → Sat 02:00),
//     2026-03-06T21:00 → 2026-03-07T03:00 = 240
// 14. addBusinessMinutes basic.
//     addBusinessMinutes(business, '2026-03-02T17:00:00+01:00', 120)
//       → 2026-03-03T10:00:00+01:00
// 15. addBusinessMinutes from a closed instant starts at the next opening.
//     addBusinessMinutes(business, '2026-03-07T12:00:00+01:00', 60)  (Sat)
//       → 2026-03-09T10:00:00+01:00
// 16. addBusinessMinutes across a spring-forward 24×7 day.
//     addBusinessMinutes(x247, '2026-03-29T00:00:00+01:00', 1440)
//       → 2026-03-30T01:00:00+02:00   (24 h of real time, 25 h of wall clock)
// 17. Round trip: addBusinessMinutes then businessMinutesBetween returns the
//     same number, for every vector above (tolerance 0).
// 18. addBusinessMinutes(cal, from, 0) === from, normalised to ISO.
// 19. A calendar with no shifts at all: businessMinutesBetween = 0 and
//     addBusinessMinutesDetailed(...).exhausted === true (no infinite loop).
// 20. Invalid ISO input on either side → 0 / the input echoed back; never throws.
// ─────────────────────────────────────────────────────────────────────────────

/** A weekly recurring working window, in LOCAL minutes-from-midnight. */
export interface CalendarShift {
  /** 0 = Sunday … 6 = Saturday (matches `Date#getUTCDay`). */
  weekday: number;
  /** Inclusive start, 0 – 1439. */
  startMinute: number;
  /**
   * Exclusive end. `<= startMinute` (or `> 1440`) means the shift spans
   * midnight into the next local day.
   */
  endMinute: number;
}

/** A fully closed local date. */
export interface CalendarHoliday {
  /** Local date, 'YYYY-MM-DD'. */
  day: string;
  name?: string;
}

/** A local date whose shifts replace the weekday pattern AND any holiday. */
export interface CalendarExceptionDay {
  /** Local date, 'YYYY-MM-DD'. */
  day: string;
  name?: string;
  /** Empty array = the day is closed. */
  shifts: Array<{ startMinute: number; endMinute: number }>;
}

/**
 * The pure calendar shape. It is also the `config_objects` body for
 * `kind = 'calendar'` (see `configKinds.ts` → `CalendarBody`), and the
 * denormalised form of the `calendars` + `calendar_shifts` +
 * `calendar_holidays` tables.
 */
export interface BusinessCalendar {
  /** IANA zone, e.g. 'Europe/Paris'. Invalid zones fall back to UTC. */
  timezone: string;
  shifts: CalendarShift[];
  holidays?: CalendarHoliday[];
  exceptions?: CalendarExceptionDay[];
  /** Shortcut for the '24x7' calendar — shifts/holidays are then ignored. */
  is24x7?: boolean;
}

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/**
 * Upper bound on the day-by-day scan. Ten years is far beyond any real SLA and
 * guarantees the functions terminate on a pathological calendar.
 */
export const MAX_CALENDAR_SCAN_DAYS = 3660;

// ── Timezone plumbing ────────────────────────────────────────────────────────

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

function getZonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(new Date(ms));
  const bag: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      const numeric = Number(part.value);
      if (Number.isFinite(numeric)) bag[part.type] = numeric;
    }
  }
  return {
    year: bag.year ?? 1970,
    month: bag.month ?? 1,
    day: bag.day ?? 1,
    hour: bag.hour ?? 0,
    minute: bag.minute ?? 0,
    second: bag.second ?? 0,
  };
}

/** Offset of `timeZone` from UTC at instant `ms`, in milliseconds. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = getZonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // `ms` may carry sub-second precision the formatter dropped; ignore it.
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Convert a local wall-clock date + minutes-from-midnight to a UTC instant.
 * `day` and `minuteOfDay` may overflow (day 32, minute 1560) — they normalise.
 *
 * Ambiguous fall-back times resolve to the FIRST occurrence; non-existent
 * spring-forward times resolve to the instant just after the gap. Both are the
 * behaviour SLA math wants: the working window never gains or loses an hour it
 * did not actually have.
 */
function wallToUtcMs(timeZone: string, year: number, month: number, day: number, minuteOfDay: number): number {
  const naive = Date.UTC(year, month - 1, day) + minuteOfDay * MINUTE_MS;
  const firstOffset = zoneOffsetMs(naive, timeZone);
  let utc = naive - firstOffset;
  const secondOffset = zoneOffsetMs(utc, timeZone);
  if (secondOffset !== firstOffset) utc = naive - secondOffset;
  return utc;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Local calendar date of an instant, as 'YYYY-MM-DD'. */
export function localDateKey(ms: number, timeZone: string): string {
  const p = getZonedParts(ms, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Local minutes-from-midnight of an instant. */
export function localMinuteOfDay(ms: number, timeZone: string): number {
  const p = getZonedParts(ms, timeZone);
  return p.hour * 60 + p.minute;
}

/** Day of week (0 = Sunday) of a Y-M-D calendar date — timezone independent. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

function addCivilDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function civilKey(date: CivilDate): string {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}

// ── Interval construction ────────────────────────────────────────────────────

type Interval = [start: number, end: number];

function normalizeShiftWindow(startMinute: number, endMinute: number): Interval | null {
  if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute)) return null;
  const start = Math.max(0, Math.min(1440, Math.trunc(startMinute)));
  let end = Math.trunc(endMinute);
  if (!Number.isFinite(end)) return null;
  // `end <= start` means "spans midnight": push it into the next local day.
  if (end <= start) end += 1440;
  // Never let a single shift cover more than 24 h.
  if (end > start + 1440) end = start + 1440;
  if (end <= start) return null;
  return [start, end];
}

/**
 * Working intervals (UTC ms) that BEGIN on the given local date. May extend
 * past local midnight when a shift spans it.
 */
function intervalsForLocalDate(calendar: BusinessCalendar, date: CivilDate): Interval[] {
  const timeZone = calendar.timezone || 'UTC';

  if (calendar.is24x7 === true) {
    return [[wallToUtcMs(timeZone, date.year, date.month, date.day, 0), wallToUtcMs(timeZone, date.year, date.month, date.day, 1440)]];
  }

  const key = civilKey(date);

  const exception = calendar.exceptions?.find((entry) => entry.day === key);
  if (exception) {
    const out: Interval[] = [];
    for (const shift of exception.shifts ?? []) {
      const window = normalizeShiftWindow(shift.startMinute, shift.endMinute);
      if (!window) continue;
      out.push([
        wallToUtcMs(timeZone, date.year, date.month, date.day, window[0]),
        wallToUtcMs(timeZone, date.year, date.month, date.day, window[1]),
      ]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  if (calendar.holidays?.some((entry) => entry.day === key)) return [];

  const weekday = weekdayOf(date.year, date.month, date.day);
  const out: Interval[] = [];
  for (const shift of calendar.shifts ?? []) {
    if (shift.weekday !== weekday) continue;
    const window = normalizeShiftWindow(shift.startMinute, shift.endMinute);
    if (!window) continue;
    out.push([
      wallToUtcMs(timeZone, date.year, date.month, date.day, window[0]),
      wallToUtcMs(timeZone, date.year, date.month, date.day, window[1]),
    ]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Cheap check: a calendar with no reachable working time at all. */
function hasNoWorkingTime(calendar: BusinessCalendar): boolean {
  if (calendar.is24x7 === true) return false;
  const hasShift = (calendar.shifts ?? []).some((shift) => normalizeShiftWindow(shift.startMinute, shift.endMinute) !== null);
  const hasException = (calendar.exceptions ?? []).some((entry) =>
    (entry.shifts ?? []).some((shift) => normalizeShiftWindow(shift.startMinute, shift.endMinute) !== null),
  );
  return !hasShift && !hasException;
}

function parseInstant(value: string | number | Date): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Walk working intervals forward from `fromMs`, feeding each clipped interval
 * to `visit`. Stop when `visit` returns false or the scan cap is reached.
 * Starts one day early so a shift that began yesterday and spans midnight is
 * not missed.
 */
function scanForward(
  calendar: BusinessCalendar,
  fromMs: number,
  visit: (start: number, end: number) => boolean,
  maxDays: number,
): { scannedDays: number; capped: boolean } {
  const timeZone = calendar.timezone || 'UTC';
  const startParts = getZonedParts(fromMs, timeZone);
  let cursorDate = addCivilDays({ year: startParts.year, month: startParts.month, day: startParts.day }, -1);
  let watermark = fromMs;

  for (let dayIndex = 0; dayIndex < maxDays; dayIndex += 1) {
    const intervals = intervalsForLocalDate(calendar, cursorDate);
    for (const [rawStart, rawEnd] of intervals) {
      const start = Math.max(rawStart, watermark);
      if (rawEnd <= start) continue;
      watermark = rawEnd;
      if (!visit(start, rawEnd)) return { scannedDays: dayIndex + 1, capped: false };
    }
    cursorDate = addCivilDays(cursorDate, 1);
  }
  return { scannedDays: maxDays, capped: true };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Business time between two instants, in MILLISECONDS of real elapsed time.
 * Clamped at 0 — never negative, never NaN, never throws.
 *
 * Use this for `sla_instances.paused_ms` (bigint) and anywhere precision
 * matters; `businessMinutesBetween` is the same number ÷ 60000.
 */
export function businessMillisBetween(
  calendar: BusinessCalendar,
  fromISO: string | number | Date,
  toISO: string | number | Date,
): number {
  const fromMs = parseInstant(fromISO);
  const toMs = parseInstant(toISO);
  if (fromMs === null || toMs === null) return 0;
  if (toMs <= fromMs) return 0;

  // Fast path: a plain 24×7 calendar is just real elapsed time.
  if (calendar.is24x7 === true && !calendar.holidays?.length && !calendar.exceptions?.length) {
    return toMs - fromMs;
  }
  if (hasNoWorkingTime(calendar)) return 0;

  let total = 0;
  scanForward(
    calendar,
    fromMs,
    (start, end) => {
      if (start >= toMs) return false;
      total += Math.min(end, toMs) - start;
      return end < toMs;
    },
    MAX_CALENDAR_SCAN_DAYS,
  );
  return total;
}

/**
 * Business minutes between two instants. Fractional when the span does not
 * land on whole minutes. Clamped at 0 (never negative) — a caller that needs a
 * signed delta should compare the instants itself.
 *
 * PURE: same inputs → same output, no clock read, no mutation.
 */
export function businessMinutesBetween(
  calendar: BusinessCalendar,
  fromISO: string | number | Date,
  toISO: string | number | Date,
): number {
  return businessMillisBetween(calendar, fromISO, toISO) / MINUTE_MS;
}

export interface AddBusinessMinutesResult {
  /** The resulting instant, ISO-8601 UTC. */
  at: string;
  /** Same instant in epoch milliseconds. */
  atMs: number;
  /**
   * True when the scan cap was hit before the budget was spent (a calendar
   * with no — or vanishingly little — working time). `at` then falls back to
   * continuous time so a due date always exists, and the caller should log it.
   */
  exhausted: boolean;
  /** Local days walked. Useful for a "why is this due date so far out?" panel. */
  scannedDays: number;
}

/**
 * Add business minutes to an instant. Detailed variant — never throws.
 *
 * If `from` sits outside working hours the clock starts at the next opening.
 * Zero or negative `minutes` returns `from` unchanged.
 */
export function addBusinessMinutesDetailed(
  calendar: BusinessCalendar,
  fromISO: string | number | Date,
  minutes: number,
): AddBusinessMinutesResult {
  const fromMs = parseInstant(fromISO);
  if (fromMs === null) {
    const now = Date.now();
    return { at: new Date(now).toISOString(), atMs: now, exhausted: true, scannedDays: 0 };
  }
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { at: new Date(fromMs).toISOString(), atMs: fromMs, exhausted: false, scannedDays: 0 };
  }

  let remaining = minutes * MINUTE_MS;

  if (calendar.is24x7 === true && !calendar.holidays?.length && !calendar.exceptions?.length) {
    const atMs = fromMs + remaining;
    return { at: new Date(atMs).toISOString(), atMs, exhausted: false, scannedDays: 0 };
  }

  if (hasNoWorkingTime(calendar)) {
    const atMs = fromMs + remaining;
    return { at: new Date(atMs).toISOString(), atMs, exhausted: true, scannedDays: 0 };
  }

  let resultMs: number | null = null;
  const scan = scanForward(
    calendar,
    fromMs,
    (start, end) => {
      const span = end - start;
      if (span >= remaining) {
        resultMs = start + remaining;
        remaining = 0;
        return false;
      }
      remaining -= span;
      return true;
    },
    MAX_CALENDAR_SCAN_DAYS,
  );

  if (resultMs === null) {
    const fallback = fromMs + remaining;
    return { at: new Date(fallback).toISOString(), atMs: fallback, exhausted: true, scannedDays: scan.scannedDays };
  }
  const settled: number = resultMs;
  return { at: new Date(settled).toISOString(), atMs: settled, exhausted: false, scannedDays: scan.scannedDays };
}

/**
 * Add business minutes to an instant, returning an ISO-8601 UTC string.
 * PURE and total — see `addBusinessMinutesDetailed` for the diagnostics.
 */
export function addBusinessMinutes(
  calendar: BusinessCalendar,
  fromISO: string | number | Date,
  minutes: number,
): string {
  return addBusinessMinutesDetailed(calendar, fromISO, minutes).at;
}

/** True when the instant falls inside a working window. */
export function isWithinBusinessHours(calendar: BusinessCalendar, atISO: string | number | Date): boolean {
  const atMs = parseInstant(atISO);
  if (atMs === null) return false;
  if (calendar.is24x7 === true && !calendar.holidays?.length && !calendar.exceptions?.length) return true;
  if (hasNoWorkingTime(calendar)) return false;

  const timeZone = calendar.timezone || 'UTC';
  const parts = getZonedParts(atMs, timeZone);
  const today: CivilDate = { year: parts.year, month: parts.month, day: parts.day };
  for (const date of [addCivilDays(today, -1), today]) {
    for (const [start, end] of intervalsForLocalDate(calendar, date)) {
      if (atMs >= start && atMs < end) return true;
    }
  }
  return false;
}

/**
 * Next instant at which the calendar is open, at or after `atISO`.
 * Returns `atISO` (normalised) when already inside a window, or null when the
 * calendar never opens within the scan cap.
 */
export function nextBusinessStart(
  calendar: BusinessCalendar,
  atISO: string | number | Date,
): string | null {
  const atMs = parseInstant(atISO);
  if (atMs === null) return null;
  if (calendar.is24x7 === true && !calendar.holidays?.length && !calendar.exceptions?.length) {
    return new Date(atMs).toISOString();
  }
  if (hasNoWorkingTime(calendar)) return null;

  let found: number | null = null;
  scanForward(
    calendar,
    atMs,
    (start) => {
      found = start;
      return false;
    },
    MAX_CALENDAR_SCAN_DAYS,
  );
  return found === null ? null : new Date(found as number).toISOString();
}

/**
 * Total business minutes a calendar offers in one local week — the number the
 * calendar editor shows under "≈ N h / week". Holidays and exceptions are
 * ignored (they are date-specific, not weekly).
 */
export function weeklyBusinessMinutes(calendar: BusinessCalendar): number {
  if (calendar.is24x7 === true) return 7 * 24 * 60;
  let total = 0;
  for (const shift of calendar.shifts ?? []) {
    const window = normalizeShiftWindow(shift.startMinute, shift.endMinute);
    if (window) total += window[1] - window[0];
  }
  return total;
}

/**
 * Format minutes-from-midnight as 'HH:MM' for the calendar editor.
 * 1440 renders as '24:00' (end-of-day) rather than collapsing to '00:00'.
 */
export function formatShiftMinute(minute: number): string {
  const truncated = Math.trunc(minute);
  if (truncated === 1440) return '24:00';
  const normalized = ((truncated % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
}

/** Parse 'HH:MM' into minutes-from-midnight. Returns null on anything else. */
export function parseShiftMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours < 0 || hours > 24 || mins < 0 || mins > 59) return null;
  const total = hours * 60 + mins;
  return total > 1440 ? null : total;
}

/** The always-open calendar, seeded as slug '24x7'. */
export function createAlwaysOpenCalendar(timezone = 'Europe/Paris'): BusinessCalendar {
  return { timezone, shifts: [], holidays: [], exceptions: [], is24x7: true };
}

/** Mon–Fri 09:00–18:00 — the seeded 'business' calendar. */
export function createBusinessHoursCalendar(timezone = 'Europe/Paris'): BusinessCalendar {
  return {
    timezone,
    is24x7: false,
    holidays: [],
    exceptions: [],
    shifts: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1080 })),
  };
}
