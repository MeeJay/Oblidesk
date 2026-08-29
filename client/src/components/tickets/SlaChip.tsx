/**
 * SlaChip.tsx — the clock.
 *
 * ── Why the chip does not own a timer ────────────────────────────────────────
 * A ticket queue is a virtualised list of up to 100 000 rows, of which ~40 are
 * mounted at any moment. If every chip ran its own `setInterval(1000)`, moving
 * the scrollbar would mount and unmount forty timers per frame and the list
 * would stutter exactly where it must not. So the chip takes `now` as a PROP:
 * one ticker at the top of the queue drives every visible row, and React does
 * one render pass per second instead of forty.
 *
 * `now` is optional. On the ticket header, where there is exactly one chip,
 * omitting it lets the component run its own second-resolution ticker.
 *
 * ── Paused is not "ok" ───────────────────────────────────────────────────────
 * A paused clock gets its own token (`sla-paused`), never the green. A clock
 * that reads "2h 14m left" in green while the ticket sits in
 * `pending_requester` is a lie with a colour on it: the remaining time is not
 * running down, and the agent needs to know that at a glance rather than
 * discovering it when the customer replies and the clock jumps.
 */
import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { Pause, TimerOff, Timer, CheckCircle2 } from 'lucide-react';
import type { SlaInstance } from '@oblidesk/shared';

export type SlaTone = 'ok' | 'warn' | 'breach' | 'paused' | 'met';

const TONE_CLASSES: Readonly<Record<SlaTone, string>> = {
  ok: 'bg-sla-ok-bg text-sla-ok',
  warn: 'bg-sla-warn-bg text-sla-warn',
  breach: 'bg-sla-breach-bg text-sla-breach',
  paused: 'bg-sla-paused-bg text-sla-paused',
  met: 'bg-sla-ok-bg text-sla-ok',
};

/** Inside this fraction of the target, the chip goes amber. */
const AT_RISK_FRACTION = 0.15;
/** …but never later than this many minutes out, however long the target is. */
const AT_RISK_FLOOR_MINUTES = 15;

// ═════════════════════════════════════════════════════════════════════════════
// Time formatting — exported, because the journal and the rail need the same
// vocabulary. Two spellings of "il y a 3 min" in one screen is a bug people
// notice and cannot name.
// ═════════════════════════════════════════════════════════════════════════════

/** `-2j 04h`, `3h 12m`, `47m`, `18s`. Compact enough for a dense queue row. */
export function formatDurationShort(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const total = Math.floor(Math.abs(ms) / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;

  if (days > 0) return `${sign}${days}j ${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${sign}${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${sign}${minutes}m`;
  return `${sign}${seconds}s`;
}

/** "il y a 4 min" / "dans 2 h" — the vocabulary used everywhere on the desk. */
export function formatRelative(
  iso: string | null | undefined,
  t: (key: string, fallback: string, opts?: Record<string, unknown>) => string,
  now: number = Date.now(),
): string {
  if (!iso) return t('time.never', 'jamais');
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return t('time.unknown', 'date inconnue');

  const delta = now - at;
  const abs = Math.abs(delta);
  const value = formatDurationShort(abs);

  return delta >= 0
    ? t('time.ago', 'il y a {{value}}', { value })
    : t('time.in', 'dans {{value}}', { value });
}

/** Absolute timestamp for a `title=` — the relative form always needs a floor. */
export function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Tone
// ═════════════════════════════════════════════════════════════════════════════

export function slaTone(instance: SlaInstance, now: number = Date.now()): SlaTone {
  if (instance.status === 'breached' || instance.breachedAt) return 'breach';
  if (instance.status === 'met' || instance.metAt) return 'met';
  if (instance.status === 'cancelled') return 'paused';
  if (!instance.running || instance.status === 'paused') return 'paused';

  const due = Date.parse(instance.dueAt);
  if (Number.isNaN(due)) return 'ok';
  const remaining = due - now;
  if (remaining <= 0) return 'breach';

  const started = Date.parse(instance.startedAt);
  const window = Number.isNaN(started) ? 0 : due - started;
  const threshold = Math.max(window * AT_RISK_FRACTION, AT_RISK_FLOOR_MINUTES * 60_000);
  return remaining <= threshold ? 'warn' : 'ok';
}

/**
 * The instance the header counts down: the nearest LIVE clock, and only if
 * there is one. A resolved ticket whose resolution clock was met shows the met
 * chip rather than nothing — "no SLA" and "SLA satisfied" are different facts.
 */
export function nearestInstance(instances: readonly SlaInstance[] | undefined): SlaInstance | null {
  if (!instances || instances.length === 0) return null;

  const live = instances.filter((i) => i.status === 'running' || i.status === 'paused');
  const pool = live.length > 0 ? live : instances;

  return [...pool].sort((a, b) => {
    // A breached clock outranks everything: it is the thing to look at.
    const aBreached = a.status === 'breached' ? 0 : 1;
    const bBreached = b.status === 'breached' ? 0 : 1;
    if (aBreached !== bBreached) return aBreached - bBreached;
    return Date.parse(a.dueAt) - Date.parse(b.dueAt);
  })[0];
}

// ═════════════════════════════════════════════════════════════════════════════
// Component
// ═════════════════════════════════════════════════════════════════════════════

export interface SlaChipProps {
  instance: SlaInstance;
  /** Supplied by the queue's single ticker. Omit for a self-ticking chip. */
  now?: number;
  size?: 'sm' | 'md';
  /** Show the target slug next to the countdown (ticket header does). */
  showTarget?: boolean;
  className?: string;
}

const TONE_ICON: Readonly<Record<SlaTone, typeof Timer>> = {
  ok: Timer,
  warn: Timer,
  breach: TimerOff,
  paused: Pause,
  met: CheckCircle2,
};

export default function SlaChip({
  instance,
  now,
  size = 'md',
  showTarget = false,
  className,
}: SlaChipProps): JSX.Element {
  const { t } = useTranslation();
  const [selfNow, setSelfNow] = useState(() => Date.now());

  // Only tick when nobody upstream is ticking for us.
  useEffect(() => {
    if (now !== undefined) return undefined;
    const handle = window.setInterval(() => setSelfNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [now]);

  const clock = now ?? selfNow;
  const tone = useMemo(() => slaTone(instance, clock), [instance, clock]);
  const Icon = TONE_ICON[tone];

  const due = Date.parse(instance.dueAt);
  const remaining = Number.isNaN(due) ? 0 : due - clock;

  const body = ((): string => {
    if (tone === 'met') return t('sla.met', 'tenu');
    if (tone === 'breach') {
      return instance.breachedAt
        ? `+${formatDurationShort(clock - Date.parse(instance.breachedAt))}`
        : `+${formatDurationShort(-remaining)}`;
    }
    if (tone === 'paused') {
      return instance.status === 'cancelled'
        ? t('sla.cancelled', 'annulé')
        : t('sla.pausedShort', 'en pause');
    }
    return formatDurationShort(remaining);
  })();

  const title = [
    `${t('sla.target', 'Cible SLA')}: ${instance.targetSlug}`,
    `${t('sla.policy', 'Politique')}: ${instance.policySlug} v${instance.policyVersion}`,
    `${t('sla.calendar', 'Calendrier')}: ${instance.calendarSlug}`,
    `${t('sla.due', 'Échéance')}: ${formatAbsolute(instance.dueAt)}`,
    tone === 'paused'
      ? t('sla.pausedExplain', 'Le compteur est arrêté : la catégorie du statut met le SLA en pause.')
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span
      title={title}
      aria-label={title}
      className={clsx(
        'inline-flex items-center gap-1 rounded-pill font-mono font-medium tabular-nums',
        size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]',
        TONE_CLASSES[tone],
        className,
      )}
    >
      <Icon size={size === 'sm' ? 10 : 12} aria-hidden />
      {showTarget && (
        <span className="uppercase tracking-[0.06em] opacity-70">{instance.targetSlug}</span>
      )}
      <span>{body}</span>
    </span>
  );
}

/** The header's row of clocks — every target, nearest first. */
export function SlaChipRow({
  instances,
  now,
  size = 'sm',
  max = 3,
}: {
  instances: readonly SlaInstance[] | undefined;
  now?: number;
  size?: 'sm' | 'md';
  max?: number;
}): JSX.Element | null {
  const ordered = useMemo(() => {
    if (!instances || instances.length === 0) return [];
    return [...instances].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)).slice(0, max);
  }, [instances, max]);

  if (ordered.length === 0) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {ordered.map((instance) => (
        <SlaChip key={instance.id} instance={instance} now={now} size={size} showTarget />
      ))}
    </span>
  );
}
