/**
 * calendar.service.ts — THE definition of "business hours" for the whole desk.
 *
 * ── Why this file exists at all ──────────────────────────────────────────────
 * `shared/src/calendar.ts` already contains the hard part: DST-correct,
 * timezone-aware, PURE business-time arithmetic. It knows nothing about the
 * database, and it must stay that way — the client runs the same functions to
 * render a countdown, and a pure function is the only kind two runtimes can
 * agree on.
 *
 * What is missing is the boring half: turning a published `calendar` config
 * object (plus its `calendars` / `calendar_shifts` / `calendar_holidays`
 * projection rows) into a `BusinessCalendar`, once, cheaply, per tenant.
 *
 * That job lives HERE and only here, because SLA, escalation, rate cards and
 * on-call must never be able to disagree about whether 18:05 on a Friday is
 * "after hours". Four services each doing their own `SELECT * FROM calendars`
 * is four opportunities to interpret `weekday` differently, and the symptom of
 * that bug is a customer arguing about an invoice.
 *
 * ── The three shapes this loader must accept ─────────────────────────────────
 * The `calendar` config bodies in the wild are NOT all the camelCase
 * `BusinessCalendar` shape that `configKinds.ts` declares:
 *
 *   1. `BusinessCalendar` itself — `{ timezone, shifts:[{weekday,startMinute,
 *      endMinute}], holidays:[{day:'YYYY-MM-DD'}], is24x7 }`.
 *   2. The SEEDED shape (`db/seeds/02_baseline_config.ts`) — snake_case
 *      `start_minute` / `end_minute`, `'HH:MM'` strings in `start` / `end`,
 *      ISO-8601 weekdays (1 = Monday … 7 = Sunday) and RECURRING holidays
 *      written as `'MM-DD'` with `recurring: true`.
 *   3. The projection rows in `calendars` + `calendar_shifts` +
 *      `calendar_holidays`, which are ISO weekdays and real dates.
 *
 * A loader that understood only (1) would silently return "never open" for the
 * two calendars every fresh install actually ships with, and every SLA on the
 * desk would inherit a due date computed against an empty week. So the parser
 * below is deliberately, boringly tolerant, and every tolerance is commented.
 *
 * WEEKDAY CONVENTIONS — the one that looks like a landmine and is not:
 * `BusinessCalendar` uses `Date#getUTCDay` (0 = Sunday … 6 = Saturday); the
 * database and the seeds use ISO-8601 (1 = Monday … 7 = Sunday). Those two
 * agree on 1–6 (Monday–Saturday) and differ only on Sunday (0 vs 7). So
 * `weekday % 7` converts BOTH conventions correctly with no sniffing, no
 * heuristics and no way to get Saturday's shifts on a Sunday.
 *
 * ── Caching ──────────────────────────────────────────────────────────────────
 * Cached per tenant. Invalidation is belt AND braces, because a stale calendar
 * is a wrong due date and a wrong due date is an argument:
 *   • `invalidateCalendarCache(tenantId)` — call it from the publish path.
 *   • A cheap signature probe (count + max(version) + max(updated_at) over the
 *     tenant's `calendar` config objects) revalidates a hit that is older than
 *     `REVALIDATE_AFTER_MS`, so a publish that forgot to call the invalidator
 *     is corrected within 30 seconds rather than never.
 *   • A hard TTL on top, so nothing can be cached across a year boundary and
 *     keep last year's expanded recurring holidays forever.
 */

import {
  MINUTE_MS,
  addBusinessMinutes,
  addBusinessMinutesDetailed,
  businessMillisBetween,
  createAlwaysOpenCalendar,
  createBusinessHoursCalendar,
  isWithinBusinessHours,
  nextBusinessStart,
  parseShiftMinute,
  weeklyBusinessMinutes,
  type AddBusinessMinutesResult,
  type BusinessCalendar,
  type CalendarExceptionDay,
  type CalendarHoliday,
  type CalendarShift,
} from '@oblidesk/shared';

import { db, scoped, type Executor } from '../db';
import { logger } from '../utils/logger';

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

/** Where a loaded calendar's definition actually came from. */
export type CalendarSource = 'config_object' | 'projection' | 'fallback';

export interface LoadedCalendar {
  slug: string;
  name: string;
  timezone: string;
  isDefault: boolean;
  /** True when the calendar is open every minute of every day. */
  is24x7: boolean;
  /** The pure shape every downstream function consumes. */
  calendar: BusinessCalendar;
  source: CalendarSource;
  /** Published version of the config object, or 0 when none backs this. */
  version: number;
  /** ≈ hours per week, for the "this policy buys you N h/week" hint. */
  weeklyMinutes: number;
  /** Holidays that came from a recurring `MM-DD` rule, already expanded. */
  holidayCount: number;
}

/** The next instant at which the calendar changes state. */
export interface CalendarBoundary {
  /** ISO-8601 UTC. */
  at: string;
  atMs: number;
  /** `close` = the desk shuts at this instant; `open` = it opens. */
  kind: 'open' | 'close';
}

/** One coloured band of the SLA explainer: was the desk open or shut? */
export interface CalendarBand {
  fromMs: number;
  toMs: number;
  open: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Tuning
// ═════════════════════════════════════════════════════════════════════════════

/** Hard cache lifetime. Nothing survives this, ever. */
const CACHE_TTL_MS = 5 * 60_000;

/** A hit older than this triggers the cheap signature probe before it is used. */
const REVALIDATE_AFTER_MS = 30_000;

/** Years either side of "now" that a recurring `MM-DD` holiday is expanded to. */
const RECURRING_HOLIDAY_YEARS_BACK = 2;
const RECURRING_HOLIDAY_YEARS_FORWARD = 3;

/**
 * How far `nextBoundary` will look for the end of the current open window.
 * Thirty days is far beyond any real shift; the binary search below is bounded
 * by it so a pathological calendar costs a fixed number of scans, not a hang.
 */
const BOUNDARY_SEARCH_WINDOW_MS = 30 * 86_400_000;

/** Millisecond precision the boundary binary search settles for. */
const BOUNDARY_PRECISION_MS = 1_000;

/** Slug used when a tenant has published no calendar at all. */
export const FALLBACK_CALENDAR_SLUG = 'business';

/** Slug the SLA engine treats as "always on" when validating pause rules. */
export const ALWAYS_ON_CALENDAR_SLUG = '24x7';

// ═════════════════════════════════════════════════════════════════════════════
// Tolerant body parsing
// ═════════════════════════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** First defined value among several candidate keys. */
function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Minutes-from-midnight from either a number (`start_minute: 540`) or an
 * `'HH:MM'` string (`start: '09:00'`). Returns null on anything else, and the
 * caller drops the shift rather than guessing — a shift with a made-up start
 * time silently moves every due date on the desk.
 */
function toMinuteOfDay(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const minute = Math.trunc(value);
    return minute >= 0 && minute <= 1440 ? minute : null;
  }
  if (typeof value === 'string') {
    const parsed = parseShiftMinute(value);
    if (parsed !== null) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const minute = Math.trunc(numeric);
      return minute >= 0 && minute <= 1440 ? minute : null;
    }
  }
  return null;
}

/**
 * ISO-8601 (1–7) and `getUTCDay` (0–6) agree on Monday–Saturday and differ only
 * on Sunday, so one modulo converts both. See the file header.
 */
function toJsWeekday(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    value = numeric;
  }
  const weekday = Math.trunc(value as number);
  if (weekday < 0 || weekday > 7) return null;
  return weekday % 7;
}

function parseShifts(raw: unknown): CalendarShift[] {
  const out: CalendarShift[] = [];
  for (const entry of asArray(raw)) {
    if (!isRecord(entry)) continue;
    const weekday = toJsWeekday(pick(entry, 'weekday', 'day_of_week', 'dayOfWeek', 'dow'));
    if (weekday === null) continue;
    const startMinute = toMinuteOfDay(pick(entry, 'startMinute', 'start_minute', 'start', 'from'));
    const endMinute = toMinuteOfDay(pick(entry, 'endMinute', 'end_minute', 'end', 'to'));
    if (startMinute === null || endMinute === null) continue;
    out.push({ weekday, startMinute, endMinute });
  }
  return out;
}

/** `'2026-03-02'`, `'03-02'` and `'2026-03-02T00:00:00Z'` all normalise here. */
function normalizeDayKey(value: unknown): { day: string; recurring: boolean } | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return { day: value.toISOString().slice(0, 10), recurring: false };
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return { day: trimmed.slice(0, 10), recurring: false };
  if (/^\d{2}-\d{2}$/.test(trimmed)) return { day: trimmed, recurring: true };
  return null;
}

function holidayName(entry: Record<string, unknown>): string | undefined {
  const name = pick(entry, 'name', 'label');
  if (typeof name === 'string') return name;
  // The seeds carry a `Localized` object — keep the French, per HARD RULE 10's
  // spirit: this is a fallback label, not a translation lookup.
  if (isRecord(name)) {
    const fr = name.fr ?? name.en;
    if (typeof fr === 'string') return fr;
  }
  return undefined;
}

/**
 * Expand holidays, turning every recurring `MM-DD` rule into concrete dates
 * across a window around today. The pure calendar matches holidays by exact
 * `'YYYY-MM-DD'` key, so an unexpanded `'01-01'` would simply never match and
 * New Year's Day would quietly become a working day.
 */
function parseHolidays(raw: unknown, nowMs: number): CalendarHoliday[] {
  const out: CalendarHoliday[] = [];
  const seen = new Set<string>();
  const thisYear = new Date(nowMs).getUTCFullYear();

  for (const entry of asArray(raw)) {
    const record = isRecord(entry) ? entry : { day: entry };
    const parsed = normalizeDayKey(pick(record, 'day', 'date'));
    if (!parsed) continue;
    const name = holidayName(record);
    const recurring = parsed.recurring || asBool(pick(record, 'recurring', 'every_year'), false);

    if (!recurring && !parsed.recurring) {
      if (seen.has(parsed.day)) continue;
      seen.add(parsed.day);
      out.push(name === undefined ? { day: parsed.day } : { day: parsed.day, name });
      continue;
    }

    // Recurring: `MM-DD`, or a full date whose year is only an example.
    const monthDay = parsed.day.length === 5 ? parsed.day : parsed.day.slice(5);
    for (
      let year = thisYear - RECURRING_HOLIDAY_YEARS_BACK;
      year <= thisYear + RECURRING_HOLIDAY_YEARS_FORWARD;
      year += 1
    ) {
      const day = `${year}-${monthDay}`;
      if (seen.has(day)) continue;
      seen.add(day);
      out.push(name === undefined ? { day } : { day, name });
    }
  }
  return out;
}

function parseExceptions(raw: unknown): CalendarExceptionDay[] {
  const out: CalendarExceptionDay[] = [];
  for (const entry of asArray(raw)) {
    if (!isRecord(entry)) continue;
    const parsed = normalizeDayKey(pick(entry, 'day', 'date'));
    if (!parsed || parsed.recurring) continue; // an exception is a specific date
    const shifts: Array<{ startMinute: number; endMinute: number }> = [];
    for (const shift of asArray(pick(entry, 'shifts', 'windows'))) {
      if (!isRecord(shift)) continue;
      const startMinute = toMinuteOfDay(pick(shift, 'startMinute', 'start_minute', 'start'));
      const endMinute = toMinuteOfDay(pick(shift, 'endMinute', 'end_minute', 'end'));
      if (startMinute === null || endMinute === null) continue;
      shifts.push({ startMinute, endMinute });
    }
    const name = holidayName(entry);
    out.push(name === undefined ? { day: parsed.day, shifts } : { day: parsed.day, name, shifts });
  }
  return out;
}

/**
 * True when the weekly pattern covers every minute of every day — the `24x7`
 * seed expresses itself as seven 00:00–24:00 shifts rather than the `is24x7`
 * flag, and detecting that unlocks the pure module's fast path (plain elapsed
 * time, no day-by-day scan) for the calendar the security queue lives on.
 */
function coversEveryMinute(shifts: readonly CalendarShift[]): boolean {
  if (shifts.length === 0) return false;
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const covers = shifts.some(
      (shift) => shift.weekday === weekday && shift.startMinute <= 0 && shift.endMinute >= 1440,
    );
    if (!covers) return false;
  }
  return true;
}

/**
 * Turn any accepted body shape into a `BusinessCalendar`.
 *
 * Exported because the config linter and the SLA validator both need to answer
 * "is this calendar 24×7?" from a body that has not been saved yet.
 */
export function toBusinessCalendar(
  body: unknown,
  options: { now?: number; timezone?: string } = {},
): BusinessCalendar {
  const nowMs = options.now ?? Date.now();
  const record = isRecord(body) ? body : {};

  const timezone = asString(
    pick(record, 'timezone', 'time_zone', 'tz'),
    options.timezone ?? 'Europe/Paris',
  );

  const shifts = parseShifts(pick(record, 'shifts', 'windows', 'hours'));
  const holidays = parseHolidays(pick(record, 'holidays'), nowMs);
  const exceptions = parseExceptions(pick(record, 'exceptions', 'overrides'));

  const declared24x7 = asBool(pick(record, 'is24x7', 'is_24x7', 'always_open', 'alwaysOpen'), false);
  // A 24×7 pattern with holidays on it is NOT 24×7 — the holidays would be
  // ignored by the fast path, which is exactly the kind of silent wrongness
  // this file exists to prevent.
  const is24x7 =
    declared24x7 || (coversEveryMinute(shifts) && holidays.length === 0 && exceptions.length === 0);

  return { timezone, shifts, holidays, exceptions, is24x7 };
}

// ═════════════════════════════════════════════════════════════════════════════
// Cache
// ═════════════════════════════════════════════════════════════════════════════

interface TenantCacheEntry {
  bySlug: Map<string, LoadedCalendar>;
  defaultSlug: string;
  loadedAt: number;
  checkedAt: number;
  /** Cheap fingerprint of the tenant's calendar configuration. */
  signature: string;
}

const cache = new Map<number, TenantCacheEntry>();

/** In-flight loads, so a burst of ticker work does not stampede the database. */
const inflight = new Map<number, Promise<TenantCacheEntry>>();

/**
 * Drop cached calendars. Call this on EVERY publish/archive/revert of a
 * `calendar` config object, and after `projectCalendarToTables`.
 *
 * With no argument it drops everything — the right move after a config-bundle
 * import, which can rewrite several tenants at once.
 */
export function invalidateCalendarCache(tenantId?: number): void {
  if (tenantId === undefined) {
    cache.clear();
    inflight.clear();
    return;
  }
  cache.delete(tenantId);
  inflight.delete(tenantId);
}

export function calendarCacheStats(): { tenants: number; calendars: number } {
  let calendars = 0;
  for (const entry of cache.values()) calendars += entry.bySlug.size;
  return { tenants: cache.size, calendars };
}

/**
 * One indexed row that changes whenever the tenant's calendar configuration
 * changes. Cheaper by an order of magnitude than reloading the bodies, which
 * is the whole point: revalidation must cost less than the thing it avoids.
 */
async function calendarSignature(tenantId: number, executor: Executor): Promise<string> {
  const [config] = (await scoped('config_objects', tenantId, executor)
    .where('config_objects.kind', 'calendar')
    .count<Array<{ n: string; v: string | null; u: Date | string | null }>>({ n: '*' })
    .max({ v: 'config_objects.version' })
    .max({ u: 'config_objects.updated_at' })) as Array<{
    n: string;
    v: string | number | null;
    u: Date | string | null;
  }>;

  const [rows] = (await scoped('calendars', tenantId, executor).count<
    Array<{ n: string; m: string | number | null }>
  >({ n: '*' }).max({ m: 'calendars.id' })) as Array<{ n: string; m: string | number | null }>;

  const updated = config?.u instanceof Date ? config.u.toISOString() : String(config?.u ?? '');
  return `${config?.n ?? 0}:${config?.v ?? 0}:${updated}:${rows?.n ?? 0}:${rows?.m ?? 0}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Loading
// ═════════════════════════════════════════════════════════════════════════════

interface CalendarRow {
  id: number;
  slug: string;
  name: string;
  timezone: string;
  is_default: boolean;
}

interface ShiftRow {
  calendar_id: number;
  weekday: number;
  start_minute: number;
  end_minute: number;
}

interface HolidayRow {
  calendar_id: number;
  day: Date | string;
  name: string | null;
}

interface ConfigRow {
  slug: string;
  name: string;
  body: unknown;
  version: number;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Load every calendar this tenant can see, from BOTH sources, and merge.
 *
 * The config object is the source of truth (`002`'s own comment says so), so
 * where both exist the body wins for the weekly pattern. The projection rows
 * are folded in for holidays and for calendars that exist only as rows — an
 * admin who added a one-off closure through the calendar screen must see it
 * honoured even if the publish that projects it has not run.
 */
async function loadTenantCalendars(tenantId: number, executor: Executor): Promise<TenantCacheEntry> {
  const nowMs = Date.now();

  const configRows = (await scoped('config_objects', tenantId, executor)
    .where('config_objects.kind', 'calendar')
    .where('config_objects.status', 'published')
    .select(
      'config_objects.slug',
      'config_objects.name',
      'config_objects.body',
      'config_objects.version',
    )) as ConfigRow[];

  const calendarRows = (await scoped('calendars', tenantId, executor).select(
    'calendars.id',
    'calendars.slug',
    'calendars.name',
    'calendars.timezone',
    'calendars.is_default',
  )) as CalendarRow[];

  const ids = calendarRows.map((row) => Number(row.id));

  // `calendar_shifts` / `calendar_holidays` carry no tenant_id of their own
  // (PARENT_SCOPED_TABLES): they are reached ONLY through the already-scoped
  // parent ids collected above, never by a bare id from a request.
  const shiftRows: ShiftRow[] =
    ids.length === 0
      ? []
      : ((await executor('calendar_shifts')
          .whereIn('calendar_shifts.calendar_id', ids)
          .select(
            'calendar_shifts.calendar_id',
            'calendar_shifts.weekday',
            'calendar_shifts.start_minute',
            'calendar_shifts.end_minute',
          )) as ShiftRow[]);

  const holidayRows: HolidayRow[] =
    ids.length === 0
      ? []
      : ((await executor('calendar_holidays')
          .whereIn('calendar_holidays.calendar_id', ids)
          .select(
            'calendar_holidays.calendar_id',
            'calendar_holidays.day',
            'calendar_holidays.name',
          )) as HolidayRow[]);

  const shiftsByCalendar = new Map<number, CalendarShift[]>();
  for (const row of shiftRows) {
    const weekday = toJsWeekday(row.weekday);
    if (weekday === null) continue;
    const list = shiftsByCalendar.get(Number(row.calendar_id)) ?? [];
    list.push({
      weekday,
      startMinute: Number(row.start_minute),
      endMinute: Number(row.end_minute),
    });
    shiftsByCalendar.set(Number(row.calendar_id), list);
  }

  const holidaysByCalendar = new Map<number, CalendarHoliday[]>();
  for (const row of holidayRows) {
    const parsed = normalizeDayKey(row.day);
    if (!parsed) continue;
    const list = holidaysByCalendar.get(Number(row.calendar_id)) ?? [];
    list.push(row.name ? { day: parsed.day, name: row.name } : { day: parsed.day });
    holidaysByCalendar.set(Number(row.calendar_id), list);
  }

  const bySlug = new Map<string, LoadedCalendar>();

  // ── Pass 1: the projection rows ────────────────────────────────────────────
  for (const row of calendarRows) {
    const key = String(row.slug).toLowerCase();
    const shifts = shiftsByCalendar.get(Number(row.id)) ?? [];
    const holidays = holidaysByCalendar.get(Number(row.id)) ?? [];
    const calendar: BusinessCalendar = {
      timezone: row.timezone || 'Europe/Paris',
      shifts,
      holidays,
      exceptions: [],
      is24x7: coversEveryMinute(shifts) && holidays.length === 0,
    };
    bySlug.set(key, {
      slug: String(row.slug),
      name: row.name,
      timezone: calendar.timezone,
      isDefault: row.is_default === true,
      is24x7: calendar.is24x7 === true,
      calendar,
      source: 'projection',
      version: 0,
      weeklyMinutes: weeklyBusinessMinutes(calendar),
      holidayCount: holidays.length,
    });
  }

  // ── Pass 2: the published bodies, which win ────────────────────────────────
  for (const row of configRows) {
    const key = String(row.slug).toLowerCase();
    const body = parseJson(row.body);
    const existing = bySlug.get(key);
    const calendar = toBusinessCalendar(body, {
      now: nowMs,
      timezone: existing?.timezone ?? 'Europe/Paris',
    });

    // Fold the projection's holidays in underneath the body's. An admin's
    // one-off closure lives in `calendar_holidays`; losing it because someone
    // republished the policy would close the desk on the wrong day.
    if (existing && existing.calendar.holidays && existing.calendar.holidays.length > 0) {
      const seen = new Set((calendar.holidays ?? []).map((h) => h.day));
      const merged = [...(calendar.holidays ?? [])];
      for (const holiday of existing.calendar.holidays) {
        if (seen.has(holiday.day)) continue;
        seen.add(holiday.day);
        merged.push(holiday);
      }
      calendar.holidays = merged;
      if (merged.length > 0) calendar.is24x7 = calendar.is24x7 === true && merged.length === 0;
    }

    // A body with no usable shifts and no 24×7 flag is a configuration
    // mistake, not an instruction to freeze every clock on the desk. Keep the
    // projection's pattern if there is one and say so in the log.
    const usable = calendar.is24x7 === true || calendar.shifts.length > 0;
    if (!usable && existing) {
      logger.warn(
        { tenantId, slug: row.slug },
        'calendar config object has no usable shifts — keeping the projected rows',
      );
      continue;
    }

    bySlug.set(key, {
      slug: String(row.slug),
      name: row.name,
      timezone: calendar.timezone,
      isDefault: existing?.isDefault ?? asBool(pick(body, 'is_default', 'isDefault'), false),
      is24x7: calendar.is24x7 === true,
      calendar,
      source: 'config_object',
      version: Number(row.version) || 1,
      weeklyMinutes: weeklyBusinessMinutes(calendar),
      holidayCount: calendar.holidays?.length ?? 0,
    });
  }

  // ── The default ────────────────────────────────────────────────────────────
  let defaultSlug =
    [...bySlug.values()].find((entry) => entry.isDefault)?.slug ??
    (bySlug.has(FALLBACK_CALENDAR_SLUG) ? FALLBACK_CALENDAR_SLUG : undefined) ??
    [...bySlug.keys()][0];

  if (defaultSlug === undefined) {
    // A tenant with no calendar at all still needs an answer. Mon–Fri 09:00–
    // 18:00 Europe/Paris is the seeded default, so falling back to it keeps a
    // half-provisioned tenant behaving like a provisioned one.
    const calendar = createBusinessHoursCalendar();
    bySlug.set(FALLBACK_CALENDAR_SLUG, {
      slug: FALLBACK_CALENDAR_SLUG,
      name: 'Business hours',
      timezone: calendar.timezone,
      isDefault: true,
      is24x7: false,
      calendar,
      source: 'fallback',
      version: 0,
      weeklyMinutes: weeklyBusinessMinutes(calendar),
      holidayCount: 0,
    });
    defaultSlug = FALLBACK_CALENDAR_SLUG;
    logger.warn({ tenantId }, 'No calendar configured — falling back to Mon–Fri 09:00–18:00');
  }

  // `24x7` must always resolve: the SLA validator uses it as the legitimate
  // partner of an `outside_hours` pause rule, and an alert queue that names it
  // cannot be told the calendar does not exist.
  if (!bySlug.has(ALWAYS_ON_CALENDAR_SLUG)) {
    const calendar = createAlwaysOpenCalendar(bySlug.get(defaultSlug)?.timezone ?? 'Europe/Paris');
    bySlug.set(ALWAYS_ON_CALENDAR_SLUG, {
      slug: ALWAYS_ON_CALENDAR_SLUG,
      name: '24×7',
      timezone: calendar.timezone,
      isDefault: false,
      is24x7: true,
      calendar,
      source: 'fallback',
      version: 0,
      weeklyMinutes: 7 * 24 * 60,
      holidayCount: 0,
    });
  }

  return {
    bySlug,
    defaultSlug,
    loadedAt: nowMs,
    checkedAt: nowMs,
    signature: await calendarSignature(tenantId, executor),
  };
}

async function tenantCalendars(tenantId: number, executor: Executor = db): Promise<TenantCacheEntry> {
  const now = Date.now();
  const hit = cache.get(tenantId);

  if (hit && now - hit.loadedAt < CACHE_TTL_MS) {
    if (now - hit.checkedAt < REVALIDATE_AFTER_MS) return hit;
    try {
      const signature = await calendarSignature(tenantId, executor);
      if (signature === hit.signature) {
        hit.checkedAt = now;
        return hit;
      }
    } catch (error) {
      // A failed probe is not a reason to serve nothing. Keep the cached
      // calendar and try again on the next call — a slightly stale calendar
      // beats an SLA engine that cannot compute a due date at all.
      logger.warn(
        { tenantId, err: (error as Error).message },
        'Calendar revalidation probe failed — serving the cached calendars',
      );
      hit.checkedAt = now;
      return hit;
    }
    cache.delete(tenantId);
  }

  const pending = inflight.get(tenantId);
  if (pending) return pending;

  const load = loadTenantCalendars(tenantId, executor)
    .then((entry) => {
      cache.set(tenantId, entry);
      return entry;
    })
    .finally(() => {
      inflight.delete(tenantId);
    });

  inflight.set(tenantId, load);
  return load;
}

// ═════════════════════════════════════════════════════════════════════════════
// Public API — resolution
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE resolver. `slug` may be null/undefined/unknown — you always get a usable
 * calendar back, because every caller of this function is in the middle of
 * computing a deadline and none of them can do anything sensible with `null`.
 * An unknown slug is logged once per load, never thrown.
 */
export async function resolveCalendar(
  tenantId: number,
  slug: string | null | undefined,
  executor: Executor = db,
): Promise<LoadedCalendar> {
  const entry = await tenantCalendars(tenantId, executor);
  const key = typeof slug === 'string' && slug.length > 0 ? slug.toLowerCase() : null;

  if (key !== null) {
    const found = entry.bySlug.get(key);
    if (found) return found;
    logger.warn(
      { tenantId, slug, fallback: entry.defaultSlug },
      'Unknown calendar slug — falling back to the tenant default',
    );
  }

  const fallback = entry.bySlug.get(entry.defaultSlug.toLowerCase()) ?? entry.bySlug.get(entry.defaultSlug);
  if (fallback) return fallback;

  // Unreachable in practice — `loadTenantCalendars` guarantees a default —
  // but a total function is worth the four lines.
  const calendar = createBusinessHoursCalendar();
  return {
    slug: FALLBACK_CALENDAR_SLUG,
    name: 'Business hours',
    timezone: calendar.timezone,
    isDefault: true,
    is24x7: false,
    calendar,
    source: 'fallback',
    version: 0,
    weeklyMinutes: weeklyBusinessMinutes(calendar),
    holidayCount: 0,
  };
}

/** Just the pure shape, for a caller that will do its own arithmetic. */
export async function getBusinessCalendar(
  tenantId: number,
  slug: string | null | undefined,
  executor: Executor = db,
): Promise<BusinessCalendar> {
  return (await resolveCalendar(tenantId, slug, executor)).calendar;
}

/** Every calendar this tenant can see, default first, then alphabetical. */
export async function listCalendars(
  tenantId: number,
  executor: Executor = db,
): Promise<LoadedCalendar[]> {
  const entry = await tenantCalendars(tenantId, executor);
  return [...entry.bySlug.values()].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });
}

export async function defaultCalendarSlug(tenantId: number, executor: Executor = db): Promise<string> {
  return (await tenantCalendars(tenantId, executor)).defaultSlug;
}

/** True when the named calendar is open every minute — the 24×7 test. */
export async function isAlwaysOpen(
  tenantId: number,
  slug: string | null | undefined,
  executor: Executor = db,
): Promise<boolean> {
  return (await resolveCalendar(tenantId, slug, executor)).is24x7;
}

// ═════════════════════════════════════════════════════════════════════════════
// Public API — business time (thin wrappers over the PURE functions)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Business milliseconds between two instants on a named calendar.
 * The arithmetic is `shared/src/calendar.ts`'s, unchanged — this only supplies
 * the calendar.
 */
export async function businessMsBetween(
  tenantId: number,
  slug: string | null | undefined,
  from: string | number | Date,
  to: string | number | Date,
  executor: Executor = db,
): Promise<number> {
  const loaded = await resolveCalendar(tenantId, slug, executor);
  return businessMillisBetween(loaded.calendar, from, to);
}

/** The due date `minutes` of business time after `from`. */
export async function dueAfterBusinessMinutes(
  tenantId: number,
  slug: string | null | undefined,
  from: string | number | Date,
  minutes: number,
  executor: Executor = db,
): Promise<AddBusinessMinutesResult> {
  const loaded = await resolveCalendar(tenantId, slug, executor);
  return addBusinessMinutesDetailed(loaded.calendar, from, minutes);
}

/** THE answer to "is the desk open right now?" — nobody else may decide this. */
export async function isOpenAt(
  tenantId: number,
  slug: string | null | undefined,
  at: string | number | Date,
  executor: Executor = db,
): Promise<boolean> {
  const loaded = await resolveCalendar(tenantId, slug, executor);
  return isWithinBusinessHours(loaded.calendar, at);
}

/** Next opening instant at or after `at`, or null if the calendar never opens. */
export async function nextOpenAt(
  tenantId: number,
  slug: string | null | undefined,
  at: string | number | Date,
  executor: Executor = db,
): Promise<string | null> {
  const loaded = await resolveCalendar(tenantId, slug, executor);
  return nextBusinessStart(loaded.calendar, at);
}

/**
 * End of the working window `at` falls inside — PURE, and derived only from
 * `businessMillisBetween`, never from a private copy of the interval builder.
 *
 * ── How, and why it is not a naive bisection ─────────────────────────────────
 * While `[at, t]` lies entirely inside one window, `businessMillisBetween(at,
 * t) === t - at`; the first `t` where that stops holding is the closing edge.
 * A plain binary search over a thirty-day range would find it — and would also
 * spend its first dozen probes scanning fifteen days of calendar per call,
 * which turns the SLA explainer's hundred-band strip into several seconds of
 * timezone formatting.
 *
 * So the search EXPANDS before it bisects: probe at 30 minutes, an hour, two,
 * four… until a probe lands outside the window. A nine-hour shift is bracketed
 * in six probes that never scan more than a day, and the bisection that follows
 * works inside that bracket. Same answer, roughly two orders of magnitude less
 * work, and the pure module still owns every DST decision.
 *
 * Returns null when `at` is not inside a window (ask `nextBusinessStart`
 * instead), or when the calendar simply never closes.
 */
export function businessWindowEnd(
  calendar: BusinessCalendar,
  at: string | number | Date,
): number | null {
  const atMs = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(String(at));
  if (!Number.isFinite(atMs)) return null;
  if (calendar.is24x7 === true && !calendar.holidays?.length && !calendar.exceptions?.length) {
    return null; // never closes
  }
  if (!isWithinBusinessHours(calendar, atMs)) return null;

  /** True while `[atMs, atMs + offset]` is entirely working time. */
  const contiguous = (offset: number): boolean =>
    businessMillisBetween(calendar, atMs, atMs + offset) >= offset;

  let low = 0; // known contiguous
  let high = -1; // first offset known to reach past the closing edge

  for (let step = 30 * 60_000; step <= BOUNDARY_SEARCH_WINDOW_MS; step *= 2) {
    if (contiguous(step)) {
      low = step;
      continue;
    }
    high = step;
    break;
  }

  // Open for the entire search window: no boundary worth reporting.
  if (high < 0) return null;

  while (high - low > BOUNDARY_PRECISION_MS) {
    const mid = low + Math.floor((high - low) / 2);
    if (contiguous(mid)) low = mid;
    else high = mid;
  }
  return atMs + low;
}

/**
 * The next instant at which this calendar changes state, in either direction.
 *
 * This is the timer the SLA ticker arms for an `outside_hours` pause: it is
 * how the engine stays event-driven instead of polling every open ticket to
 * ask "are we shut yet?".
 */
export async function nextBoundary(
  tenantId: number,
  slug: string | null | undefined,
  at: string | number | Date,
  executor: Executor = db,
): Promise<CalendarBoundary | null> {
  const loaded = await resolveCalendar(tenantId, slug, executor);
  const calendar = loaded.calendar;
  const atMs = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(String(at));
  if (!Number.isFinite(atMs)) return null;

  if (isWithinBusinessHours(calendar, atMs)) {
    const end = businessWindowEnd(calendar, atMs);
    if (end === null) return null; // 24×7, or open past the search horizon
    return { at: new Date(end).toISOString(), atMs: end, kind: 'close' };
  }

  const open = nextBusinessStart(calendar, atMs);
  if (open === null) return null;
  const openMs = Date.parse(open);
  if (!Number.isFinite(openMs)) return null;
  return { at: open, atMs: openMs, kind: 'open' };
}

/**
 * Split `[from, to]` into open / shut bands — the coloured strip the SLA
 * explainer renders under "worked / paused / out of hours".
 *
 * Capped at `maxBands` so a three-month-old ticket cannot ask the API for
 * sixty rectangles nobody can see; the tail is returned as one closing band.
 */
export function calendarBands(
  calendar: BusinessCalendar,
  from: string | number | Date,
  to: string | number | Date,
  maxBands = 120,
): CalendarBand[] {
  const fromMs = from instanceof Date ? from.getTime() : typeof from === 'number' ? from : Date.parse(String(from));
  const toMs = to instanceof Date ? to.getTime() : typeof to === 'number' ? to : Date.parse(String(to));
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];

  if (calendar.is24x7 === true && !calendar.holidays?.length && !calendar.exceptions?.length) {
    return [{ fromMs, toMs, open: true }];
  }

  const bands: CalendarBand[] = [];
  let cursor = fromMs;
  let guard = 0;

  while (cursor < toMs && guard < maxBands) {
    guard += 1;
    const open = isWithinBusinessHours(calendar, cursor);
    let edge: number | null;
    if (open) {
      edge = businessWindowEnd(calendar, cursor);
    } else {
      const next = nextBusinessStart(calendar, cursor);
      edge = next === null ? null : Date.parse(next);
    }
    const end = edge === null || !Number.isFinite(edge) || edge <= cursor ? toMs : Math.min(edge, toMs);
    bands.push({ fromMs: cursor, toMs: end, open });
    cursor = end;
  }

  if (cursor < toMs) {
    bands.push({ fromMs: cursor, toMs, open: isWithinBusinessHours(calendar, cursor) });
  }
  return bands;
}

/** `addBusinessMinutes` against a named calendar. ISO-8601 UTC out. */
export async function addBusinessMinutesOn(
  tenantId: number,
  slug: string | null | undefined,
  from: string | number | Date,
  minutes: number,
  executor: Executor = db,
): Promise<string> {
  const loaded = await resolveCalendar(tenantId, slug, executor);
  return addBusinessMinutes(loaded.calendar, from, minutes);
}

// ═════════════════════════════════════════════════════════════════════════════
// Projection — config object → calendars / calendar_shifts / calendar_holidays
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Write the runtime projection for one published calendar.
 *
 * `002`'s comment is explicit that the config object is the source of truth and
 * publishing writes these rows; this is that write, and it is idempotent so a
 * retried publish is a no-op rather than a duplicate-shift week.
 *
 * Only the recurring `MM-DD` holidays are collapsed back to the current year
 * here — `calendar_holidays.day` is a DATE column, so a rule cannot live in it.
 * The expanded set stays authoritative in the body; these rows exist for the
 * admin screen and for other apps reading the desk's database directly.
 */
export async function projectCalendarToTables(
  tenantId: number,
  slug: string,
  body: unknown,
  executor: Executor = db,
): Promise<{ calendarId: number; shifts: number; holidays: number }> {
  const calendar = toBusinessCalendar(body);
  const record = isRecord(body) ? body : {};
  const name = asString(pick(record, 'name'), slug);
  const isDefault = asBool(pick(record, 'is_default', 'isDefault'), false);

  const existing = (await scoped('calendars', tenantId, executor)
    .where('calendars.slug', slug)
    .first('calendars.id')) as { id: number } | undefined;

  let calendarId: number;
  if (existing) {
    calendarId = Number(existing.id);
    await scoped('calendars', tenantId, executor)
      .where('calendars.id', calendarId)
      .update({ name, timezone: calendar.timezone, is_default: isDefault });
  } else {
    const inserted = (await executor('calendars')
      .insert({ tenant_id: tenantId, slug, name, timezone: calendar.timezone, is_default: isDefault })
      .returning('id')) as Array<{ id: number }>;
    calendarId = Number(inserted[0]?.id);
  }

  if (!Number.isFinite(calendarId)) {
    throw new Error(`calendar projection: could not resolve a row id for "${slug}"`);
  }

  await executor('calendar_shifts').where('calendar_id', calendarId).del();
  await executor('calendar_holidays').where('calendar_id', calendarId).del();

  // ISO-8601 back out (1 = Monday … 7 = Sunday): the CHECK constraint on
  // `calendar_shifts.weekday` is `BETWEEN 1 AND 7`, so Sunday must be 7.
  const shiftRows = (calendar.is24x7 === true
    ? [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 }))
    : calendar.shifts
  )
    .map((shift) => ({
      calendar_id: calendarId,
      weekday: shift.weekday === 0 ? 7 : shift.weekday,
      start_minute: Math.max(0, Math.min(1440, Math.trunc(shift.startMinute))),
      end_minute: Math.max(0, Math.min(1440, Math.trunc(shift.endMinute))),
    }))
    // The CHECK also demands end > start, so an overnight shift (which the
    // pure model expresses as end <= start) cannot be projected. It stays
    // correct in the body; dropping it here is better than a failed publish.
    .filter((row) => row.end_minute > row.start_minute);

  if (shiftRows.length > 0) await executor('calendar_shifts').insert(shiftRows);

  const seen = new Set<string>();
  const holidayRows: Array<{ calendar_id: number; day: string; name: string | null }> = [];
  for (const holiday of calendar.holidays ?? []) {
    if (seen.has(holiday.day)) continue;
    seen.add(holiday.day);
    holidayRows.push({ calendar_id: calendarId, day: holiday.day, name: holiday.name ?? null });
  }
  if (holidayRows.length > 0) {
    await executor('calendar_holidays').insert(holidayRows).onConflict(['calendar_id', 'day']).ignore();
  }

  invalidateCalendarCache(tenantId);
  return { calendarId, shifts: shiftRows.length, holidays: holidayRows.length };
}

// ═════════════════════════════════════════════════════════════════════════════
// Barrel
// ═════════════════════════════════════════════════════════════════════════════

export const calendarService = {
  resolveCalendar,
  getBusinessCalendar,
  listCalendars,
  defaultCalendarSlug,
  isAlwaysOpen,
  businessMsBetween,
  dueAfterBusinessMinutes,
  addBusinessMinutesOn,
  isOpenAt,
  nextOpenAt,
  nextBoundary,
  businessWindowEnd,
  calendarBands,
  toBusinessCalendar,
  projectCalendarToTables,
  invalidateCalendarCache,
  calendarCacheStats,
  MINUTE_MS,
};

export default calendarService;
