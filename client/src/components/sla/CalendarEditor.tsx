/**
 * CalendarEditor.tsx — weekly shifts, holidays, timezone, and a picture of the
 * week you just described.
 *
 * ── Why the preview is not decoration ───────────────────────────────────────
 * A business calendar is the denominator of every SLA number the desk will ever
 * quote. "Mon–Fri 09:00–18:00" is easy to type and easy to get wrong by an
 * hour, a day, or a timezone, and the mistake only surfaces weeks later inside
 * an argument about a breach. So the editor draws the week THIS calendar
 * actually produces — sampled through the same `isWithinBusinessHours()` the
 * SLA engine calls, in the calendar's own timezone, with its holidays applied —
 * rather than re-describing the shifts back at the author in prose.
 *
 * The sampling is deliberate. Re-deriving open windows here from `shifts` would
 * be a second implementation of the one thing that must not have two: the
 * midnight-spanning shift, the DST weekend, the holiday that falls on a
 * Saturday. Ten-minute resolution over seven days is roughly a thousand calls
 * to a pure function, and it is exactly right instead of nearly right.
 *
 * ── What this editor does not touch, it keeps ───────────────────────────────
 * `exceptions` (a specific date whose shifts replace the weekly pattern) has no
 * form here yet. It is carried through every save untouched and reported in the
 * summary, because silently dropping a key on save is the kind of data loss
 * nobody notices until the day it mattered.
 *
 * HARD RULE 11 — the grid is background fills; no cell borders.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Copy, Plus, Trash2, X } from 'lucide-react';
import {
  DAY_MS,
  formatShiftMinute,
  isWithinBusinessHours,
  localDateKey,
  localMinuteOfDay,
  parseShiftMinute,
  weeklyBusinessMinutes,
  type BusinessCalendar,
  type CalendarHoliday,
  type CalendarShift,
} from '@oblidesk/shared';
import { Button } from '@/components/common/Button';
import { Toggle } from '@/components/common/Toggle';
import { cn } from '@/utils/cn';

const CONTROL =
  'h-8 rounded-md bg-bg-tertiary px-2 text-[13px] text-text-primary outline-none '
  + 'focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50';

/** Monday first — the week as a French desk reads it. */
const WEEKDAYS: Array<{ weekday: number; fr: string; key: string; short: string }> = [
  { weekday: 1, fr: 'Lundi', key: 'day.monday', short: 'Lun' },
  { weekday: 2, fr: 'Mardi', key: 'day.tuesday', short: 'Mar' },
  { weekday: 3, fr: 'Mercredi', key: 'day.wednesday', short: 'Mer' },
  { weekday: 4, fr: 'Jeudi', key: 'day.thursday', short: 'Jeu' },
  { weekday: 5, fr: 'Vendredi', key: 'day.friday', short: 'Ven' },
  { weekday: 6, fr: 'Samedi', key: 'day.saturday', short: 'Sam' },
  { weekday: 0, fr: 'Dimanche', key: 'day.sunday', short: 'Dim' },
];

const COMMON_ZONES = [
  'Europe/Paris',
  'Europe/Brussels',
  'Europe/Zurich',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Lisbon',
  'America/Montreal',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Africa/Casablanca',
  'Africa/Abidjan',
  'Indian/Reunion',
  'Asia/Dubai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
];

/** 10-minute buckets per day: fine enough to land a shift edge exactly. */
const SLOT_MINUTES = 10;
const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** One open window of a previewed day, as a percentage of the 24-hour track. */
interface PreviewBlock {
  leftPct: number;
  widthPct: number;
  label: string;
}

interface PreviewDay {
  key: string;
  isToday: boolean;
  holiday: CalendarHoliday | null;
  blocks: PreviewBlock[];
  openMinutes: number;
}

/**
 * The week, sampled through the engine's own predicate.
 *
 * Every sample is an INSTANT; its column and its position in the day are both
 * derived from that instant in the calendar's timezone. A 23- or 25-hour DST
 * day therefore lands correctly without this code knowing DST exists.
 */
function buildPreview(calendar: BusinessCalendar): PreviewDay[] {
  const timezone = isValidZone(calendar.timezone) ? calendar.timezone : 'UTC';
  const now = Date.now();
  const todayKey = localDateKey(now, timezone);
  const midnightToday = now - localMinuteOfDay(now, timezone) * 60_000;
  const weekdayToday = new Date(`${todayKey}T00:00:00Z`).getUTCDay();
  const daysSinceMonday = (weekdayToday + 6) % 7;
  const weekStart = midnightToday - daysSinceMonday * DAY_MS;

  // Noon-anchored so a DST day never resolves to its neighbour.
  const dayKeys = Array.from({ length: 7 }, (_, index) =>
    localDateKey(weekStart + index * DAY_MS + 12 * 3_600_000, timezone),
  );

  const slots: boolean[][] = dayKeys.map(() => new Array<boolean>(SLOTS_PER_DAY).fill(false));
  const columnByKey = new Map(dayKeys.map((key, index) => [key, index]));

  // Two extra hours of slack at each end covers a DST-lengthened day.
  const totalSamples = (7 * 24 * 60) / SLOT_MINUTES + 24;
  for (let sample = -12; sample < totalSamples; sample += 1) {
    const ms = weekStart + sample * SLOT_MINUTES * 60_000;
    const column = columnByKey.get(localDateKey(ms, timezone));
    if (column === undefined) continue;
    const slot = Math.floor(localMinuteOfDay(ms, timezone) / SLOT_MINUTES);
    if (slot < 0 || slot >= SLOTS_PER_DAY) continue;
    if (isWithinBusinessHours(calendar, ms)) slots[column][slot] = true;
  }

  // Contiguous open slots become ONE block, so the track is a handful of nodes
  // rather than a thousand, and so the label can read "09:00 → 18:00".
  return dayKeys.map((key, column) => {
    const blocks: PreviewBlock[] = [];
    let openMinutes = 0;
    let runStart: number | null = null;

    for (let slot = 0; slot <= SLOTS_PER_DAY; slot += 1) {
      const open = slot < SLOTS_PER_DAY && slots[column][slot];
      if (open && runStart === null) runStart = slot;
      if (!open && runStart !== null) {
        const startMinute = runStart * SLOT_MINUTES;
        const endMinute = slot * SLOT_MINUTES;
        openMinutes += endMinute - startMinute;
        blocks.push({
          leftPct: (startMinute / 1440) * 100,
          widthPct: ((endMinute - startMinute) / 1440) * 100,
          label: `${formatShiftMinute(startMinute)} → ${formatShiftMinute(endMinute)}`,
        });
        runStart = null;
      }
    }

    return {
      key,
      isToday: key === todayKey,
      holiday: (calendar.holidays ?? []).find((entry) => entry.day === key) ?? null,
      blocks,
      openMinutes,
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// One weekday's shifts
// ═════════════════════════════════════════════════════════════════════════════

function ShiftRow({
  shift,
  disabled,
  onChange,
  onRemove,
}: {
  shift: CalendarShift;
  disabled: boolean;
  onChange: (next: CalendarShift) => void;
  onRemove: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [start, setStart] = useState(formatShiftMinute(shift.startMinute));
  const [end, setEnd] = useState(formatShiftMinute(shift.endMinute));

  const spansMidnight = shift.endMinute <= shift.startMinute;

  function commit(which: 'start' | 'end', raw: string) {
    const parsed = parseShiftMinute(raw);
    if (parsed === null) {
      // Put the field back rather than writing a value the engine cannot read.
      if (which === 'start') setStart(formatShiftMinute(shift.startMinute));
      else setEnd(formatShiftMinute(shift.endMinute));
      return;
    }
    onChange(which === 'start' ? { ...shift, startMinute: parsed } : { ...shift, endMinute: parsed });
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        disabled={disabled}
        value={start}
        onChange={(event) => setStart(event.target.value)}
        onBlur={(event) => commit('start', event.target.value)}
        className={cn(CONTROL, 'w-[74px] text-center font-mono')}
        aria-label={t('calendar.shiftStart', 'Début')}
      />
      <span className="text-text-muted">→</span>
      <input
        type="text"
        disabled={disabled}
        value={end}
        onChange={(event) => setEnd(event.target.value)}
        onBlur={(event) => commit('end', event.target.value)}
        className={cn(CONTROL, 'w-[74px] text-center font-mono')}
        aria-label={t('calendar.shiftEnd', 'Fin')}
      />
      {spansMidnight && (
        <span
          className="rounded-pill bg-status-scheduled-bg px-2 py-0.5 text-[10.5px] text-status-scheduled"
          title={t('calendar.spansMidnightHelp', 'La plage se poursuit après minuit sur le jour suivant.')}
        >
          {t('calendar.spansMidnight', 'passe minuit')}
        </span>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        aria-label={t('calendar.removeShift', 'Supprimer cette plage')}
        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-priority-p1"
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The editor
// ═════════════════════════════════════════════════════════════════════════════

export interface CalendarEditorProps {
  slug: string;
  name: string;
  calendar: BusinessCalendar;
  isNew: boolean;
  readOnly?: boolean;
  saving?: boolean;
  onChange: (next: { slug: string; name: string; calendar: BusinessCalendar }) => void;
  onSave: () => Promise<void> | void;
  onCancel: () => void;
}

export function CalendarEditor({
  slug,
  name,
  calendar,
  isNew,
  readOnly = false,
  saving = false,
  onChange,
  onSave,
  onCancel,
}: CalendarEditorProps): JSX.Element {
  const { t } = useTranslation();
  const [newHoliday, setNewHoliday] = useState({ day: '', name: '' });

  const preview = useMemo(() => buildPreview(calendar), [calendar]);
  const weeklyMinutes = useMemo(() => weeklyBusinessMinutes(calendar), [calendar]);
  const zoneValid = isValidZone(calendar.timezone);

  function patchCalendar(partial: Partial<BusinessCalendar>) {
    onChange({ slug, name, calendar: { ...calendar, ...partial } });
  }

  function shiftsFor(weekday: number): CalendarShift[] {
    return (calendar.shifts ?? []).filter((shift) => shift.weekday === weekday);
  }

  function replaceShifts(weekday: number, next: CalendarShift[]) {
    const others = (calendar.shifts ?? []).filter((shift) => shift.weekday !== weekday);
    patchCalendar({ shifts: [...others, ...next].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute) });
  }

  function copyMondayToWeekdays() {
    const monday = shiftsFor(1);
    const weekend = (calendar.shifts ?? []).filter((shift) => shift.weekday === 0 || shift.weekday === 6);
    const spread = [2, 3, 4, 5].flatMap((weekday) => monday.map((shift) => ({ ...shift, weekday })));
    patchCalendar({
      shifts: [...monday, ...spread, ...weekend].sort(
        (a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute,
      ),
    });
  }

  const exceptionCount = calendar.exceptions?.length ?? 0;

  return (
    <div className="space-y-3">
      {/* ── header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-[19px] font-semibold tracking-wide text-text-primary">
            {name || slug || t('calendar.new', 'Nouveau calendrier')}
          </h2>
          <p className="text-[11.5px] text-text-muted">
            {calendar.is24x7
              ? t('calendar.alwaysOpen', 'Ouvert en permanence : les plages et jours fériés sont ignorés.')
              : t('calendar.weeklyHours', '{{hours}} h ouvrées par semaine', {
                hours: Math.round((weeklyMinutes / 60) * 10) / 10,
              })}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={onCancel}>
            {t('common.cancel', 'Annuler')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={saving}
            disabled={readOnly || !slug.trim() || !zoneValid}
            onClick={() => void onSave()}
          >
            {isNew ? t('calendar.createAndPublish', 'Créer et publier') : t('common.saveAndPublish', 'Enregistrer et publier')}
          </Button>
        </div>
      </div>

      {/* ── identity + timezone ──────────────────────────────────────────── */}
      <section className="grid gap-2.5 rounded-lg bg-bg-secondary/60 p-3 sm:grid-cols-3">
        <label className="block space-y-1">
          <span className="text-[11.5px] font-medium text-text-secondary">{t('calendar.name', 'Nom')}</span>
          <input
            type="text"
            disabled={readOnly}
            value={name}
            onChange={(event) => onChange({ slug, name: event.target.value, calendar })}
            className={cn(CONTROL, 'w-full')}
            placeholder={t('calendar.namePlaceholder', 'Heures ouvrées France')}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11.5px] font-medium text-text-secondary">{t('calendar.slug', 'Identifiant')}</span>
          <input
            type="text"
            disabled={readOnly || !isNew}
            value={slug}
            onChange={(event) =>
              onChange({
                slug: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '_'),
                name,
                calendar,
              })
            }
            className={cn(CONTROL, 'w-full font-mono')}
            placeholder="business"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11.5px] font-medium text-text-secondary">
            {t('calendar.timezone', 'Fuseau horaire')}
          </span>
          <input
            type="text"
            list="oblidesk-timezones"
            disabled={readOnly}
            value={calendar.timezone}
            onChange={(event) => patchCalendar({ timezone: event.target.value })}
            className={cn(CONTROL, 'w-full font-mono', !zoneValid && 'text-sla-breach')}
          />
          <datalist id="oblidesk-timezones">
            {COMMON_ZONES.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          {!zoneValid && (
            <span className="block text-[11px] text-sla-breach">
              {t('calendar.badTimezone', 'Fuseau inconnu : le moteur retomberait sur UTC.')}
            </span>
          )}
        </label>
      </section>

      {/* ── 24×7 ─────────────────────────────────────────────────────────── */}
      <section className="rounded-lg bg-bg-secondary/60 p-3">
        <Toggle
          checked={calendar.is24x7 === true}
          onChange={(is24x7) => patchCalendar({ is24x7 })}
          disabled={readOnly}
          disabledReason={t(
            'sla.readOnlyNotice',
            'Lecture seule : la publication d’un contrat ou d’un calendrier demande la capacité « administration de la configuration ».',
          )}
          label={t('calendar.is24x7', 'Ouvert 24×7')}
          description={t(
            'calendar.is24x7Help',
            'Un calendrier 24×7 n’a pas de bornes d’ouverture : c’est le seul sur lequel une cible SLA peut légitimement se mettre en pause « hors horaires », en prenant ses bornes ailleurs.',
          )}
        />
      </section>

      {/* ── the week you built ───────────────────────────────────────────── */}
      <section className="space-y-2 rounded-lg bg-bg-secondary/60 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-text-secondary">
            <CalendarDays size={13} />
            {t('calendar.thisWeek', 'Cette semaine, telle que le moteur la lira')}
          </h3>
          <span className="text-[11px] text-text-muted">
            {t('calendar.previewTz', 'Heures locales de {{tz}}', { tz: calendar.timezone })}
          </span>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[560px] space-y-1">
            {/* hour ruler */}
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0" />
              <div className="relative h-3 flex-1">
                {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => (
                  <span
                    key={hour}
                    style={{ left: `${(hour / 24) * 100}%` }}
                    className="absolute -translate-x-1/2 font-mono text-[10px] text-text-muted"
                  >
                    {hour}h
                  </span>
                ))}
              </div>
            </div>

            {preview.map((day, index) => (
              <div key={day.key} className="flex items-center gap-2">
                <span
                  className={cn(
                    'w-24 shrink-0 text-[12px]',
                    day.isToday ? 'font-semibold text-accent' : 'text-text-secondary',
                  )}
                  title={day.key}
                >
                  {t(WEEKDAYS[index].key, WEEKDAYS[index].fr)}
                </span>
                <div className="relative h-5 flex-1 overflow-hidden rounded-md bg-bg-tertiary">
                  {day.blocks.map((block) => (
                    <span
                      key={block.label}
                      title={block.label}
                      style={{ left: `${block.leftPct}%`, width: `${block.widthPct}%` }}
                      className="absolute inset-y-0 bg-sla-ok"
                    />
                  ))}
                </div>
                <span className="w-24 shrink-0 text-right font-mono text-[11px] text-text-muted">
                  {day.holiday ? (
                    <span className="text-status-scheduled" title={day.holiday.name ?? undefined}>
                      {day.holiday.name ?? t('calendar.holiday', 'Férié')}
                    </span>
                  ) : day.openMinutes === 0 ? (
                    t('calendar.closed', 'fermé')
                  ) : (
                    `${Math.round((day.openMinutes / 60) * 10) / 10} h`
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

        <p className="text-[11px] text-text-muted">
          {t(
            'calendar.previewHelp',
            'Échantillonné toutes les 10 minutes avec la même fonction que le moteur SLA : ce que vous voyez est ce qui sera décompté.',
          )}
        </p>
      </section>

      {/* ── shifts ───────────────────────────────────────────────────────── */}
      {!calendar.is24x7 && (
        <section className="space-y-2 rounded-lg bg-bg-secondary/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-text-secondary">
              {t('calendar.shifts', 'Plages hebdomadaires')}
            </h3>
            <Button
              size="xs"
              variant="ghost"
              icon={<Copy size={12} />}
              disabled={readOnly || shiftsFor(1).length === 0}
              onClick={copyMondayToWeekdays}
              className="ml-auto"
            >
              {t('calendar.copyMonday', 'Copier lundi sur mar–ven')}
            </Button>
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            {WEEKDAYS.map(({ weekday, fr, key }) => {
              const shifts = shiftsFor(weekday);
              return (
                <div key={weekday} className="space-y-1.5 rounded-md bg-bg-tertiary/50 p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12.5px] font-medium text-text-primary">{t(key, fr)}</span>
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() =>
                        replaceShifts(weekday, [
                          ...shifts,
                          { weekday, startMinute: 540, endMinute: 1080 },
                        ])
                      }
                      className="flex items-center gap-1 text-[11.5px] text-text-muted transition-colors hover:text-accent"
                    >
                      <Plus size={11} />
                      {t('calendar.addShift', 'Plage')}
                    </button>
                  </div>

                  {shifts.length === 0 ? (
                    <p className="text-[11.5px] text-text-muted">{t('calendar.closedDay', 'Fermé')}</p>
                  ) : (
                    shifts.map((shift, index) => (
                      <ShiftRow
                        key={`${weekday}-${index}-${shift.startMinute}`}
                        shift={shift}
                        disabled={readOnly}
                        onChange={(next) =>
                          replaceShifts(
                            weekday,
                            shifts.map((entry, position) => (position === index ? next : entry)),
                          )
                        }
                        onRemove={() =>
                          replaceShifts(
                            weekday,
                            shifts.filter((_, position) => position !== index),
                          )
                        }
                      />
                    ))
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── holidays ─────────────────────────────────────────────────────── */}
      {!calendar.is24x7 && (
        <section className="space-y-2 rounded-lg bg-bg-secondary/60 p-3">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-text-secondary">
            {t('calendar.holidays', 'Jours fériés et fermetures')}
          </h3>

          {(calendar.holidays ?? []).length === 0 ? (
            <p className="text-[12px] text-text-muted">
              {t('calendar.noHolidays', 'Aucune fermeture déclarée.')}
            </p>
          ) : (
            <ul className="grid gap-1 sm:grid-cols-2">
              {(calendar.holidays ?? [])
                .slice()
                .sort((a, b) => a.day.localeCompare(b.day))
                .map((holiday) => (
                  <li
                    key={`${holiday.day}-${holiday.name ?? ''}`}
                    className="flex items-center gap-2 rounded-md bg-bg-tertiary/50 px-2 py-1.5"
                  >
                    <span className="font-mono text-[12px] text-text-secondary">{holiday.day}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-primary">
                      {holiday.name ?? t('calendar.holiday', 'Férié')}
                    </span>
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() =>
                        patchCalendar({
                          holidays: (calendar.holidays ?? []).filter(
                            (entry) => !(entry.day === holiday.day && entry.name === holiday.name),
                          ),
                        })
                      }
                      aria-label={t('calendar.removeHoliday', 'Retirer')}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-priority-p1"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <input
              type="date"
              disabled={readOnly}
              value={newHoliday.day}
              onChange={(event) => setNewHoliday((current) => ({ ...current, day: event.target.value }))}
              className={cn(CONTROL, 'w-[160px] font-mono')}
              aria-label={t('calendar.holidayDate', 'Date')}
            />
            <input
              type="text"
              disabled={readOnly}
              value={newHoliday.name}
              onChange={(event) => setNewHoliday((current) => ({ ...current, name: event.target.value }))}
              placeholder={t('calendar.holidayName', 'Nom (facultatif)')}
              className={cn(CONTROL, 'min-w-[180px] flex-1')}
              aria-label={t('calendar.holidayName', 'Nom (facultatif)')}
            />
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus size={13} />}
              disabled={readOnly || !/^\d{4}-\d{2}-\d{2}$/.test(newHoliday.day)}
              onClick={() => {
                patchCalendar({
                  holidays: [
                    ...(calendar.holidays ?? []),
                    { day: newHoliday.day, name: newHoliday.name.trim() || undefined },
                  ],
                });
                setNewHoliday({ day: '', name: '' });
              }}
            >
              {t('calendar.addHoliday', 'Ajouter')}
            </Button>
          </div>
        </section>
      )}

      {exceptionCount > 0 && (
        <p className="rounded-md bg-bg-tertiary px-3 py-2 text-[11.5px] text-text-muted">
          {t(
            'calendar.exceptionsCarried',
            'Ce calendrier déclare {{count}} journée(s) d’exception (des horaires qui remplacent le motif hebdomadaire). Elles ne s’éditent pas encore ici et sont conservées telles quelles à l’enregistrement.',
            { count: exceptionCount },
          )}
        </p>
      )}
    </div>
  );
}

export default CalendarEditor;
