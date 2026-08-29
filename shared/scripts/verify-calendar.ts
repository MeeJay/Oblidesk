/**
 * Executable form of the GOLDEN TEST VECTORS documented at the top of
 * `shared/src/calendar.ts`.
 *
 * That header says the vectors "MUST be written as unit tests before this file
 * is trusted by the SLA engine". The suite ships no test runner, so rather than
 * impose one, this is a self-contained script:
 *
 *     cd shared && npx tsx scripts/verify-calendar.ts
 *
 * It exits 0 when every vector passes and 1 on the first failure, so it can be
 * dropped into CI or an npm script later without changing anything here.
 *
 * Why this matters more than most tests: the SLA clock, escalation ladders,
 * rate cards and on-call rotations all ask this one module what "after hours"
 * means. If it disagrees with itself across a DST boundary, every one of them
 * is wrong in the same direction on the same two days a year — and the failure
 * is invisible, because nobody audits an SLA number that looks plausible.
 */

import {
  businessMinutesBetween,
  addBusinessMinutes,
  addBusinessMinutesDetailed,
  createAlwaysOpenCalendar,
  createBusinessHoursCalendar,
  type BusinessCalendar,
} from '../src/calendar';

const TZ = 'Europe/Paris';

const business = createBusinessHoursCalendar(TZ);
const x247 = createAlwaysOpenCalendar(TZ);

/** business + a holiday on the given local dates. */
function withHolidays(days: string[]): BusinessCalendar {
  return { ...business, holidays: days.map((day) => ({ day })) };
}

/** business + a single exception day. */
function withException(day: string, shifts: Array<{ startMinute: number; endMinute: number }>): BusinessCalendar {
  return { ...business, exceptions: [{ day, shifts }] };
}

let passed = 0;
const failures: string[] = [];

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failures.push(`${label}\n          attendu ${e}\n          obtenu  ${a}`);
    console.log(`  FAIL  ${label}   attendu ${e}, obtenu ${a}`);
  }
}

/** Compare two instants rather than two strings — ISO formatting may differ. */
function sameInstant(label: string, actualISO: string, expectedISO: string): void {
  const a = new Date(actualISO).getTime();
  const e = new Date(expectedISO).getTime();
  if (a === e) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failures.push(`${label}\n          attendu ${expectedISO}\n          obtenu  ${actualISO}`);
    console.log(`  FAIL  ${label}   attendu ${expectedISO}, obtenu ${actualISO}`);
  }
}

console.log('\nVecteurs dores — shared/src/calendar.ts\n');

// ── 1-7: the ordinary cases ─────────────────────────────────────────────────
eq('01 dans un creneau',
  businessMinutesBetween(business, '2026-03-02T10:00:00+01:00', '2026-03-02T12:00:00+01:00'), 120);

eq('02 rogne aux deux bouts',
  businessMinutesBetween(business, '2026-03-02T07:00:00+01:00', '2026-03-02T20:00:00+01:00'), 540);

eq('03 la nuit est sautee',
  businessMinutesBetween(business, '2026-03-02T17:00:00+01:00', '2026-03-03T10:00:00+01:00'), 120);

eq('06a intervalle nul',
  businessMinutesBetween(business, '2026-03-02T10:00:00+01:00', '2026-03-02T10:00:00+01:00'), 0);

eq('06b jamais negatif (to < from)',
  businessMinutesBetween(business, '2026-03-02T12:00:00+01:00', '2026-03-02T10:00:00+01:00'), 0);

eq('07 week-end entier ferme',
  businessMinutesBetween(business, '2026-03-07T10:00:00+01:00', '2026-03-08T10:00:00+01:00'), 0);

// ── 8-9: the two days a year that break naive implementations ───────────────
// Spring forward 2026-03-29: 02:00 -> 03:00, so the local day is 23 h.
eq('08a DST printemps — 24x7 vaut 1380 min (23 h), pas 1440',
  businessMinutesBetween(x247, '2026-03-29T00:00:00+01:00', '2026-03-30T00:00:00+02:00'), 1380);

eq('08b DST printemps — le creneau 09-18 reste 540 min',
  businessMinutesBetween(business, '2026-03-30T09:00:00+02:00', '2026-03-30T18:00:00+02:00'), 540);

// Fall back 2026-10-25: 03:00 -> 02:00, so the local day is 25 h.
eq('09 DST automne — 24x7 vaut 1500 min (25 h), pas 1440',
  businessMinutesBetween(x247, '2026-10-25T00:00:00+02:00', '2026-10-26T00:00:00+01:00'), 1500);

// ── 10-13: holidays, exceptions, overnight shifts ───────────────────────────
eq('10 un jour ferie ferme la journee',
  businessMinutesBetween(withHolidays(['2026-05-01']), '2026-04-30T17:00:00+02:00', '2026-05-04T10:00:00+02:00'), 120);

eq('11 une exception ouvre un samedi',
  businessMinutesBetween(
    withException('2026-03-07', [{ startMinute: 540, endMinute: 720 }]),
    '2026-03-06T17:00:00+01:00', '2026-03-07T12:00:00+01:00'), 240);

eq('12 une exception vide ferme un jour ouvre',
  businessMinutesBetween(
    withException('2026-03-03', []),
    '2026-03-02T09:00:00+01:00', '2026-03-04T09:00:00+01:00'), 540);

eq('13 creneau a cheval sur minuit (ven 22:00 -> sam 02:00)',
  businessMinutesBetween(
    { timezone: TZ, is24x7: false, holidays: [], exceptions: [],
      shifts: [{ weekday: 5, startMinute: 1320, endMinute: 120 }] },
    '2026-03-06T21:00:00+01:00', '2026-03-07T03:00:00+01:00'), 240);

// ── 14-16: addBusinessMinutes ───────────────────────────────────────────────
sameInstant('14 addBusinessMinutes franchit la nuit',
  addBusinessMinutes(business, '2026-03-02T17:00:00+01:00', 120), '2026-03-03T10:00:00+01:00');

sameInstant('15 addBusinessMinutes depuis un instant ferme (samedi)',
  addBusinessMinutes(business, '2026-03-07T12:00:00+01:00', 60), '2026-03-09T10:00:00+01:00');

sameInstant('16 addBusinessMinutes traverse le passage a l heure d ete',
  addBusinessMinutes(x247, '2026-03-29T00:00:00+01:00', 1440), '2026-03-30T01:00:00+02:00');

// ── 17: round trip — the property that must hold for every vector ───────────
{
  const roundTrips: Array<[string, BusinessCalendar, string, number]> = [
    ['17a interne', business, '2026-03-02T10:00:00+01:00', 120],
    ['17b par-dessus la nuit', business, '2026-03-02T17:00:00+01:00', 120],
    ['17c par-dessus le week-end', business, '2026-03-06T17:00:00+01:00', 60],
    ['17d 24x7 au printemps', x247, '2026-03-29T00:00:00+01:00', 1440],
    ['17e 24x7 en automne', x247, '2026-10-25T00:00:00+02:00', 1440],
  ];
  for (const [label, cal, from, minutes] of roundTrips) {
    const to = addBusinessMinutes(cal, from, minutes);
    eq(`${label} — aller-retour rend ${minutes}`, businessMinutesBetween(cal, from, to), minutes);
  }
}

// ── 18-20: degenerate inputs must degrade, never throw or hang ──────────────
sameInstant('18 ajouter 0 minute rend le meme instant',
  addBusinessMinutes(business, '2026-03-02T10:00:00+01:00', 0), '2026-03-02T10:00:00+01:00');

{
  const empty: BusinessCalendar = { timezone: TZ, is24x7: false, holidays: [], exceptions: [], shifts: [] };
  eq('19a calendrier sans creneau — 0 minute ouvree',
    businessMinutesBetween(empty, '2026-03-02T00:00:00+01:00', '2026-03-09T00:00:00+01:00'), 0);
  // The real risk here is an infinite loop looking for an opening that never comes.
  const detailed = addBusinessMinutesDetailed(empty, '2026-03-02T10:00:00+01:00', 60);
  eq('19b calendrier sans creneau — exhausted=true, pas de boucle infinie', detailed.exhausted, true);
}

{
  let threw = false;
  let value = -1;
  try {
    value = businessMinutesBetween(business, 'pas-une-date', '2026-03-02T12:00:00+01:00');
  } catch {
    threw = true;
  }
  eq('20a entree ISO invalide — ne leve pas', threw, false);
  eq('20b entree ISO invalide — rend 0', value, 0);
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log('');
if (failures.length === 0) {
  console.log(`${passed} vecteurs passes, 0 echec.\n`);
  process.exit(0);
}
console.log(`${passed} passes, ${failures.length} ECHEC(S) :\n`);
for (const f of failures) console.log(`  - ${f}\n`);
process.exit(1);
