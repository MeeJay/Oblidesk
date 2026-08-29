/**
 * SetupPage — `/setup`
 *
 * The INSTALLATION wizard, as opposed to `EnrollmentPage` (`/enroll`) which
 * configures one person's account. Six steps, every one of them skippable, and
 * two rules that make it different from the usual first-launch flow:
 *
 *   1. Each step WRITES IMMEDIATELY. Discrete choices (a theme, a weekday, a
 *      toggle) persist the moment they are made; typed fields persist when they
 *      lose focus and again on "Enregistrer et continuer". Nothing is held back
 *      for a final "Apply" button, so an admin who closes the tab after step
 *      three keeps steps one to three.
 *
 *   2. Each step NAMES the admin page it corresponds to, and links to it. A
 *      wizard that hides where a setting lives feels friendly on day one and
 *      makes month two worse: the admin learned a flow instead of a map, and
 *      the flow is gone the second time they need it. So every step carries a
 *      "Ce réglage vit dans <page>" chip that is a real link.
 *
 * ── Adjusting, not building ─────────────────────────────────────────────────
 * The shipped baseline already gives this tenant four queues, two calendars, a
 * standard SLA policy, five saved views and a default state machine. That is
 * shown at the top, with live counts read from the config store rather than
 * hard-coded, because "you are editing a working desk" is the single most
 * useful thing a new admin can be told — and a wizard that presents six empty
 * forms says the opposite.
 *
 * ── Bodies are patched in place ─────────────────────────────────────────────
 * `config_objects.body` is free-form JSON (`z.record(z.unknown())` at the
 * boundary) and the SHIPPED bodies are snake_case (`by_priority`, `start_minute`,
 * `default_calendar`) while the TypeScript interfaces in @oblidesk/shared are
 * camelCase. The linter reads both dialects. So this screen never rebuilds a
 * body from scratch: it loads the stored one, patches the keys it owns using
 * whichever alias is already present, and writes it back. That keeps a hand-
 * edited desk intact and keeps this file out of the business of guessing which
 * dialect the engines will read tomorrow.
 *
 * A `PATCH` returns the object to `draft`, so every write here is followed by a
 * `publish`, which lints. A blocking finding comes back as a 422 with `issues[]`
 * — that is the answer, and it is rendered, not retried.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  Building2,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  ExternalLink,
  Inbox,
  Layers,
  Mail,
  Palette,
  Timer,
  Trash2,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  CAPABILITIES,
  SEEDED_LOCALES,
  type ConfigBodyFor,
  type ConfigKind,
  type ConfigObject,
  type SessionContext,
  type SupportedLocale,
  type TenantSettings,
} from '@oblidesk/shared';
import apiClient, { setTenantOverride, toApiError } from '@/api/client';
import { configApi } from '@/api/config.api';
import { profileApi } from '@/api/profile.api';
import { tenantsApi } from '@/api/tenants.api';
import { ticketsApi } from '@/api/tickets.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select, type SelectOption } from '@/components/common/Select';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ThemePicker } from '@/components/common/ThemePicker';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { setLanguage } from '@/i18n';
import { applyTheme, currentTheme, type AppTheme } from '@/utils/theme';
import { Toggle } from '@/components/common/Toggle';
import { cn } from '@/utils/cn';

// ═════════════════════════════════════════════════════════════════════════════
// Shape of the wizard
// ═════════════════════════════════════════════════════════════════════════════

type Step = 'appearance' | 'identity' | 'queue' | 'sla' | 'mail' | 'demo';

const STEPS: Step[] = ['appearance', 'identity', 'queue', 'sla', 'mail', 'demo'];

/**
 * Where the setting REALLY lives once the wizard is closed. This map is the
 * point of the screen — see the header.
 */
const STEP_HOME: Record<Step, { path: string; key: string; label: string }> = {
  appearance: { path: '/settings?tab=appearance', key: 'setup.homeAppearance', label: 'Paramètres › Apparence' },
  identity: { path: '/settings?tab=general', key: 'setup.homeGeneral', label: 'Paramètres › Général' },
  queue: { path: '/admin/config', key: 'setup.homeConfig', label: 'Administration › Configuration' },
  sla: { path: '/admin/sla', key: 'setup.homeSla', label: 'SLA et équipes' },
  mail: { path: '/admin/channels', key: 'setup.homeChannels', label: 'Administration › Canaux' },
  demo: { path: '/admin/tenants', key: 'setup.homeTenants', label: 'Administration › Tenants' },
};

/** Cosmetic only — nothing gates on it; the wizard is re-enterable regardless. */
const SETUP_MARK_KEY = 'oblidesk:setupCompletedAt';

/** The demonstration tenant this step creates and this step deletes. */
const DEMO_TENANT_SLUG = 'demo';

const LOCALE_LABELS: Record<string, string> = { fr: 'Français', en: 'English' };

/** Probed, in order, the same way `SmtpTab` probes them. */
const SMTP_CANDIDATE_BASES = ['/smtp-servers', '/admin/smtp-servers'] as const;

type LooseBody = Record<string, unknown>;

// ═════════════════════════════════════════════════════════════════════════════
// Small helpers
// ═════════════════════════════════════════════════════════════════════════════

function isPlainObject(value: unknown): value is LooseBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The message to show for a failed write. A publish rejected by the linter
 * answers 422 with `issues[]`; those messages are the whole point of the
 * refusal, so they are joined in rather than swallowed behind "publish failed".
 */
function describeError(error: unknown, fallback: string): string {
  const apiError = toApiError(error);
  const issues = apiError.payload?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const lines = issues
      .map((issue) => (isPlainObject(issue) ? String(issue.message ?? '') : String(issue)))
      .filter(Boolean)
      .slice(0, 3);
    if (lines.length > 0) return `${apiError.message} : ${lines.join(' · ')}`;
  }
  return apiError.message || fallback;
}

/** The first of `keys` already present on `body`, or null. */
function presentKey(body: LooseBody, keys: string[]): string | null {
  for (const key of keys) if (key in body) return key;
  return null;
}

/**
 * Write `value` under whichever alias the stored body already uses, falling
 * back to the first (which is always the shipped snake_case spelling).
 */
function patchAlias(body: LooseBody, keys: string[], value: unknown): void {
  body[presentKey(body, keys) ?? keys[0]] = value;
}

function readAlias(body: LooseBody, keys: string[]): unknown {
  const key = presentKey(body, keys);
  return key ? body[key] : undefined;
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    // Drop the combining marks NFD just split off, so 'Réseau' becomes 'reseau'
    // rather than 'r_seau' when the next rule eats every non-alphanumeric.
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

/** '09:30' → 570. Anything unparseable → null, never a silent 0. */
function minuteOfTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function timeOfMinute(minute: number): string {
  const safe = Math.max(0, Math.min(1440, Math.round(minute)));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

/** 00:00 … 23:30 in half-hour steps, plus 24:00 so a shift can close the day. */
const TIME_OPTIONS: SelectOption[] = (() => {
  const out: SelectOption[] = [];
  for (let minute = 0; minute < 1440; minute += 30) {
    out.push({ value: timeOfMinute(minute), label: timeOfMinute(minute) });
  }
  out.push({ value: '24:00', label: '24:00' });
  return out;
})();

const TIMEZONE_CHOICES = [
  'Europe/Paris',
  'Europe/Brussels',
  'Europe/Zurich',
  'Europe/Luxembourg',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Lisbon',
  'America/Montreal',
  'Indian/Reunion',
  'UTC',
];

/** A human duration for the SLA target label, in both seeded locales. */
function durationLabels(minutes: number): { en: string; fr: string } {
  if (minutes < 60) return { en: `${minutes}m`, fr: `${minutes} min` };
  if (minutes % 60 === 0 && minutes < 1440) {
    const hours = minutes / 60;
    return { en: `${hours}h`, fr: `${hours} h` };
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return {
    en: rest ? `${hours}h ${rest}m` : `${hours}h`,
    fr: rest ? `${hours} h ${rest} min` : `${hours} h`,
  };
}

/** Priorities first in rank order, then whatever else the policy declares. */
function orderPriorities(keys: string[]): string[] {
  const known = ['p1', 'p2', 'p3', 'p4'];
  const rest = keys.filter((key) => !known.includes(key)).sort();
  return [...known.filter((key) => keys.includes(key)), ...rest];
}

/**
 * Signatures for the "did anything actually change?" guard. A PATCH followed by
 * a publish appends an immutable version row, so an admin who re-enters the
 * wizard and clicks straight through must not stamp a new version on every
 * shipped object they merely looked at.
 */
function queueSignature(
  slug: string,
  name: string,
  description: string,
  group: string,
  calendar: string,
  policy: string,
  isDefault: boolean,
): string {
  return JSON.stringify([slug, name.trim(), description.trim(), group.trim(), calendar, policy, isDefault]);
}

function calendarSignature(
  slug: string,
  days: number[],
  start: string,
  end: string,
  timezone: string,
): string {
  return JSON.stringify([slug, [...days].sort((a, b) => a - b), start, end, timezone]);
}

function policySignature(slug: string, minutes: Record<string, Record<string, string>>): string {
  return JSON.stringify([slug, minutes]);
}

function localizedLabel(value: unknown, locale: string, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (isPlainObject(value)) {
    const chosen = value[locale] ?? value.fr ?? value.en;
    if (typeof chosen === 'string' && chosen.trim()) return chosen;
  }
  return fallback;
}

// ═════════════════════════════════════════════════════════════════════════════
// Chrome
// ═════════════════════════════════════════════════════════════════════════════

function Stepper({
  current,
  saved,
  onSelect,
}: {
  current: Step;
  saved: Partial<Record<Step, boolean>>;
  onSelect: (step: Step) => void;
}) {
  const { t } = useTranslation();
  const labels: Record<Step, string> = {
    appearance: t('setup.stepAppearance', 'Langue et thème'),
    identity: t('setup.stepIdentity', 'Organisation'),
    queue: t('setup.stepQueue', 'File'),
    sla: t('setup.stepSla', 'Heures et SLA'),
    mail: t('setup.stepMail', 'E-mail'),
    demo: t('setup.stepDemo', 'Démonstration'),
  };
  const currentIndex = STEPS.indexOf(current);

  return (
    <ol className="flex items-start justify-center gap-1">
      {STEPS.map((step, index) => {
        const done = Boolean(saved[step]);
        const active = index === currentIndex;
        return (
          <li key={step} className="flex items-center gap-1">
            {/* Clickable on purpose: the wizard is a map, not a corridor. */}
            <button
              type="button"
              onClick={() => onSelect(step)}
              className="flex w-14 flex-col items-center gap-1 sm:w-20"
              aria-current={active ? 'step' : undefined}
            >
              <span
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full font-mono text-[11px] transition-colors',
                  active && 'bg-accent text-bg-primary',
                  !active && done && 'bg-accent/20 text-accent',
                  !active && !done && 'bg-bg-tertiary text-text-muted',
                )}
              >
                {done && !active ? <Check size={13} /> : index + 1}
              </span>
              <span
                className={cn(
                  'hidden text-center text-[10px] leading-tight sm:block',
                  active ? 'text-text-primary' : 'text-text-muted',
                )}
              >
                {labels[step]}
              </span>
            </button>
            {index < STEPS.length - 1 && <span className="mt-3.5 h-px w-3 bg-border sm:w-5" />}
          </li>
        );
      })}
    </ol>
  );
}

/** "Ce réglage vit dans <page>" — the whole reason this wizard exists. */
function HomeLink({ step }: { step: Step }) {
  const { t } = useTranslation();
  const home = STEP_HOME[step];
  return (
    <Link
      to={home.path}
      className="inline-flex max-w-full items-center gap-1.5 rounded-pill bg-bg-tertiary px-2.5 py-1 text-[11px] transition-colors hover:bg-bg-hover"
    >
      <span className="text-text-muted">{t('setup.livesIn', 'Ce réglage vit dans')}</span>
      <span className="truncate font-medium text-accent">{t(home.key, home.label)}</span>
      <ExternalLink size={11} className="shrink-0 text-text-muted" />
    </Link>
  );
}

/** The baseline strip: what the tenant already has before anyone touches it. */
function BaselineStrip({ counts }: { counts: Partial<Record<ConfigKind, number>> }) {
  const { t } = useTranslation();

  const rows: Array<{ kind: ConfigKind; icon: LucideIcon; label: string; shipped: number }> = [
    { kind: 'queue', icon: Inbox, label: t('setup.baselineQueues', 'files'), shipped: 4 },
    { kind: 'calendar', icon: Calendar, label: t('setup.baselineCalendars', 'calendriers'), shipped: 2 },
    { kind: 'sla', icon: Timer, label: t('setup.baselineSla', 'politique SLA'), shipped: 1 },
    { kind: 'view', icon: Layers, label: t('setup.baselineViews', 'vues enregistrées'), shipped: 5 },
    { kind: 'state_machine', icon: Layers, label: t('setup.baselineMachine', "machine d'états"), shipped: 1 },
  ];

  return (
    <section className="rounded-card bg-bg-secondary p-4 shadow-card">
      <p className="text-[13px] text-text-secondary">
        {t(
          'setup.baselineLead',
          'Votre bureau fonctionne déjà. Cet assistant ajuste une configuration livrée, il ne la construit pas.',
        )}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {rows.map((row) => {
          const Icon = row.icon;
          const count = counts[row.kind] ?? row.shipped;
          return (
            <span
              key={row.kind}
              className="inline-flex items-center gap-1.5 rounded-pill bg-bg-tertiary px-2.5 py-1 text-[11px] text-text-secondary"
            >
              <Icon size={12} className="text-accent" />
              <span className="font-mono text-text-primary">{count}</span>
              {row.label}
            </span>
          );
        })}
      </div>
      <p className="mt-2.5 text-[11px] leading-relaxed text-text-muted">
        {t(
          'setup.baselineDetail',
          'Livré : les files Général, Réseau, Sécurité et Intégration ; les calendriers Heures ouvrées et 24×7 ; la politique SLA Standard ; cinq vues dans la barre latérale ; le cycle de vie par défaut.',
        )}
      </p>
    </section>
  );
}

function StepShell({
  step,
  icon,
  title,
  lead,
  children,
}: {
  step: Step;
  icon: ReactNode;
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <header className="space-y-2">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-text-primary">
          <span className="text-accent">{icon}</span>
          {title}
        </h2>
        <p className="text-[13px] leading-relaxed text-text-secondary">{lead}</p>
        <HomeLink step={step} />
      </header>
      {children}
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Demo data
// ═════════════════════════════════════════════════════════════════════════════

interface DemoPhase {
  id: string;
  label: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
}

/** Subjects that read like a real week on a service desk, not like lorem. */
const DEMO_SUBJECTS: string[] = [
  'Impossible de se connecter au VPN depuis ce matin',
  'Imprimante du 2e étage hors ligne',
  'Demande de création de compte pour une nouvelle arrivée',
  'Outlook se ferme tout seul après la mise à jour',
  'Accès refusé au partage Comptabilité',
  'Le Wi-Fi invité ne distribue plus d’adresse',
  'Téléphone IP muet en réception',
  'Mot de passe expiré, compte verrouillé',
  'Lenteur générale sur l’application de paie',
  'Écran secondaire non détecté sur la station 14',
  'Message de phishing reçu par trois collègues',
  'Sauvegarde du serveur de fichiers en échec cette nuit',
  'Demande de licence supplémentaire pour la CAO',
  'Badge d’accès désactivé après le déménagement',
  'Erreur 500 sur le portail fournisseurs',
  'Micro inaudible en visioconférence',
  'Départ de collaborateur : clôture des accès',
  'Certificat expiré sur intranet.exemple.fr',
  'Le scanner ne renvoie plus les PDF par e-mail',
  'Demande de restauration d’un dossier supprimé',
];

const DEMO_LEVELS: Array<{ impact: 'high' | 'medium' | 'low'; urgency: 'high' | 'medium' | 'low' }> = [
  { impact: 'high', urgency: 'high' },
  { impact: 'high', urgency: 'medium' },
  { impact: 'medium', urgency: 'high' },
  { impact: 'medium', urgency: 'medium' },
  { impact: 'medium', urgency: 'low' },
  { impact: 'low', urgency: 'medium' },
  { impact: 'low', urgency: 'low' },
];

const DEMO_SOURCES = ['email', 'portal', 'phone', 'web', 'chat'] as const;
const DEMO_RECORD_TYPES = ['incident', 'incident', 'incident', 'request', 'request', 'task'] as const;

// ═════════════════════════════════════════════════════════════════════════════
// Page
// ═════════════════════════════════════════════════════════════════════════════

export function SetupPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionContext | null>(null);
  const [step, setStep] = useState<Step>('appearance');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<Partial<Record<Step, boolean>>>({});
  const [completedAt, setCompletedAt] = useState<string | null>(null);

  // ── Step 1 ────────────────────────────────────────────────────────────────
  const [locale, setLocale] = useState<SupportedLocale>('fr');
  const [theme, setTheme] = useState<AppTheme>(currentTheme);

  // ── Step 2 ────────────────────────────────────────────────────────────────
  const [orgName, setOrgName] = useState('');
  const [ticketPrefix, setTicketPrefix] = useState('');
  const [orgTimezone, setOrgTimezone] = useState('Europe/Paris');
  const [portalTitle, setPortalTitle] = useState('');
  const [portalEnabled, setPortalEnabled] = useState(false);

  // ── Config store ──────────────────────────────────────────────────────────
  const [counts, setCounts] = useState<Partial<Record<ConfigKind, number>>>({});
  const [queues, setQueues] = useState<ConfigObject[]>([]);
  const [calendars, setCalendars] = useState<ConfigObject[]>([]);
  const [policies, setPolicies] = useState<ConfigObject[]>([]);

  // ── Step 3 ────────────────────────────────────────────────────────────────
  const [queueMode, setQueueMode] = useState<'edit' | 'create'>('edit');
  const [queueTarget, setQueueTarget] = useState('');
  const [queueName, setQueueName] = useState('');
  const [queueSlug, setQueueSlug] = useState('');
  const [queueDescription, setQueueDescription] = useState('');
  const [queueGroup, setQueueGroup] = useState('service-desk');
  const [queueCalendar, setQueueCalendar] = useState('business');
  const [queuePolicy, setQueuePolicy] = useState('standard');
  const [queueIsDefault, setQueueIsDefault] = useState(false);
  const [queueSnapshot, setQueueSnapshot] = useState('');

  // ── Step 4 ────────────────────────────────────────────────────────────────
  const [calendarTarget, setCalendarTarget] = useState('business');
  const [calendarDays, setCalendarDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [calendarStart, setCalendarStart] = useState('09:00');
  const [calendarEnd, setCalendarEnd] = useState('18:00');
  const [calendarTimezone, setCalendarTimezone] = useState('Europe/Paris');
  const [policyTarget, setPolicyTarget] = useState('standard');
  const [slaTargets, setSlaTargets] = useState<Array<{ slug: string; label: string }>>([]);
  const [slaPriorities, setSlaPriorities] = useState<string[]>([]);
  const [slaMinutes, setSlaMinutes] = useState<Record<string, Record<string, string>>>({});
  const [calendarSnapshot, setCalendarSnapshot] = useState('');
  const [policySnapshot, setPolicySnapshot] = useState('');

  // ── Step 5 ────────────────────────────────────────────────────────────────
  const [fromName, setFromName] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [stripQuoted, setStripQuoted] = useState(true);
  const [pollSeconds, setPollSeconds] = useState('60');
  const [smtpBase, setSmtpBase] = useState<string | null>(null);
  const [smtpCount, setSmtpCount] = useState<number | null>(null);

  // ── Step 6 ────────────────────────────────────────────────────────────────
  const [demoTenantId, setDemoTenantId] = useState<number | null>(null);
  const [demoVolume, setDemoVolume] = useState('60');
  const [demoPhases, setDemoPhases] = useState<DemoPhase[]>([]);
  const [demoRunning, setDemoRunning] = useState(false);
  const [purging, setPurging] = useState(false);

  const isAdmin = session?.isAdmin === true;
  const canConfig = Boolean(
    session?.capabilities?.includes(CAPABILITIES.CONFIG_ADMIN) || session?.isAdmin,
  );

  const currentIndex = STEPS.indexOf(step);
  const isLast = currentIndex === STEPS.length - 1;

  // ── Boot ──────────────────────────────────────────────────────────────────

  const loadConfig = useCallback(async () => {
    const kinds: ConfigKind[] = ['queue', 'calendar', 'sla', 'view', 'state_machine'];
    const results = await Promise.allSettled(kinds.map((kind) => configApi.listKind(kind)));

    const nextCounts: Partial<Record<ConfigKind, number>> = {};
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') nextCounts[kinds[index]] = result.value.total;
    });
    setCounts(nextCounts);

    const [queueRes, calendarRes, slaRes] = results;
    if (queueRes.status === 'fulfilled') setQueues(queueRes.value.objects);
    if (calendarRes.status === 'fulfilled') setCalendars(calendarRes.value.objects);
    if (slaRes.status === 'fulfilled') setPolicies(slaRes.value.objects);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const context = await profileApi.get();
        if (cancelled) return;

        setSession(context);
        setOrgName(context.tenant.name ?? '');
        const settings = (context.tenant.settings ?? {}) as TenantSettings;
        setTicketPrefix(String(settings.ticketPrefix ?? 'TKT'));
        setOrgTimezone(String(settings.timezone ?? 'Europe/Paris'));
        setPortalTitle(String(settings.portalTitle ?? ''));
        setPortalEnabled(settings.portalEnabled === true);
        setFromName(String(settings.fromName ?? ''));
        setFromAddress(String(settings.fromAddress ?? ''));

        const preferred = context.user.preferredLanguage;
        if ((SEEDED_LOCALES as readonly string[]).includes(preferred)) {
          setLocale(preferred as SupportedLocale);
        }
      } catch (err) {
        if (!cancelled) setError(describeError(err, t('setup.loadFailed', 'Impossible de charger la configuration.')));
      }

      await loadConfig();

      // Resolved settings — the mail step edits two of them.
      try {
        const res = await apiClient.get<{
          success: true;
          data: Record<string, { value: unknown }>;
        }>('/settings');
        if (!cancelled) {
          const resolved = res.data.data ?? {};
          const strip = resolved['mail.stripQuotedReplies']?.value;
          if (typeof strip === 'boolean') setStripQuoted(strip);
          const poll = resolved['mail.pollIntervalSeconds']?.value;
          if (typeof poll === 'number') setPollSeconds(String(poll));
        }
      } catch {
        // Settings unreadable is survivable — the step shows its defaults.
      }

      // Does an SMTP HTTP surface exist on this build? See SmtpTab's header:
      // the service exists, the route may not be mounted.
      for (const candidate of SMTP_CANDIDATE_BASES) {
        try {
          const res = await apiClient.get<{ success: true; data: unknown[] }>(candidate);
          if (cancelled) return;
          setSmtpBase(candidate);
          setSmtpCount(Array.isArray(res.data.data) ? res.data.data.length : 0);
          break;
        } catch (err) {
          const status = toApiError(err).status;
          // 403 means the route EXISTS and refused us — an answer, not a miss.
          if (status === 403) {
            setSmtpBase(candidate);
            setSmtpCount(null);
            break;
          }
        }
      }

      try {
        const tenants = await tenantsApi.list();
        if (!cancelled) {
          const demo = tenants.find((tenant) => tenant.slug === DEMO_TENANT_SLUG);
          setDemoTenantId(demo?.id ?? null);
        }
      } catch {
        // Not a platform admin. The demo step says so rather than guessing.
      }

      if (!cancelled) {
        try {
          setCompletedAt(localStorage.getItem(SETUP_MARK_KEY));
        } catch {
          // Storage blocked — the "already run" note simply does not appear.
        }
        setLoading(false);
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [loadConfig, t]);

  // ── Derived: queue form follows the selected queue ────────────────────────

  const uiLocale = i18n.language?.slice(0, 2) ?? 'fr';

  const loadQueueForm = useCallback(
    (slug: string) => {
      const object = queues.find((queue) => queue.slug === slug);
      if (!object) return;
      const body = object.body as unknown as LooseBody;

      const name = localizedLabel(body.label, uiLocale, object.name);
      const description = localizedLabel(body.description, uiLocale, object.description ?? '');
      const group = String(readAlias(body, ['default_assignment_group', 'assignmentGroupSlug']) ?? '');
      const calendar = String(readAlias(body, ['default_calendar', 'calendarSlug']) ?? 'business');
      const policy = String(readAlias(body, ['default_sla_policy', 'slaPolicySlug']) ?? 'standard');
      const isDefault = readAlias(body, ['is_default', 'isDefault']) === true;

      setQueueTarget(slug);
      setQueueSlug(slug);
      setQueueName(name);
      setQueueDescription(description);
      setQueueGroup(group);
      setQueueCalendar(calendar);
      setQueuePolicy(policy);
      setQueueIsDefault(isDefault);
      setQueueSnapshot(queueSignature(slug, name, description, group, calendar, policy, isDefault));
    },
    [queues, uiLocale],
  );

  useEffect(() => {
    if (queueMode !== 'edit' || queueTarget || queues.length === 0) return;
    const preferred =
      queues.find((queue) => (queue.body as unknown as LooseBody).is_default === true) ?? queues[0];
    loadQueueForm(preferred.slug);
  }, [queueMode, queueTarget, queues, loadQueueForm]);

  // ── Derived: calendar + SLA forms follow their selected object ────────────

  const loadCalendarForm = useCallback((object: ConfigObject) => {
    const body = object.body as unknown as LooseBody;
    const timezone = String(body.timezone ?? 'Europe/Paris');

    const shifts = Array.isArray(body.shifts) ? (body.shifts as LooseBody[]) : [];
    let days = [1, 2, 3, 4, 5];
    let start = '09:00';
    let end = '18:00';

    if (shifts.length > 0) {
      days = [...new Set(shifts.map((shift) => Number(shift.weekday)))].sort((a, b) => a - b);
      const first = shifts[0];
      const startMinute = readAlias(first, ['start_minute', 'startMinute']);
      const endMinute = readAlias(first, ['end_minute', 'endMinute']);
      start = typeof first.start === 'string' ? first.start : timeOfMinute(Number(startMinute ?? 540));
      end = typeof first.end === 'string' ? first.end : timeOfMinute(Number(endMinute ?? 1080));
    }

    setCalendarTarget(object.slug);
    setCalendarTimezone(timezone);
    setCalendarDays(days);
    setCalendarStart(start);
    setCalendarEnd(end);
    setCalendarSnapshot(calendarSignature(object.slug, days, start, end, timezone));
  }, []);

  const loadPolicyForm = useCallback((object: ConfigObject) => {
    const body = object.body as unknown as LooseBody;
    setPolicyTarget(object.slug);

    const targets = Array.isArray(body.targets) ? (body.targets as LooseBody[]) : [];
    const rows: Array<{ slug: string; label: string }> = [];
    const minutes: Record<string, Record<string, string>> = {};
    const priorities = new Set<string>();

    for (const target of targets) {
      const slug = String(target.slug ?? '');
      if (!slug) continue;
      rows.push({ slug, label: localizedLabel(target.label, 'fr', slug) });
      const durations = readAlias(target, ['by_priority', 'durationsByPriority', 'durations']);
      const bucket: Record<string, string> = {};
      if (isPlainObject(durations)) {
        for (const [priority, spec] of Object.entries(durations)) {
          priorities.add(priority);
          const value = isPlainObject(spec) ? Number(spec.minutes) : Number(spec);
          bucket[priority] = Number.isFinite(value) ? String(value) : '';
        }
      }
      minutes[slug] = bucket;
    }

    setSlaTargets(rows);
    setSlaPriorities(orderPriorities([...priorities]));
    setSlaMinutes(minutes);
    setPolicySnapshot(policySignature(object.slug, minutes));
  }, []);

  useEffect(() => {
    if (calendars.length === 0) return;
    const chosen = calendars.find((item) => item.slug === calendarTarget) ?? calendars[0];
    if (chosen.slug !== calendarTarget || calendarDays.length === 0) loadCalendarForm(chosen);
    // Deliberately keyed on the list, not on the form fields: re-running this on
    // every keystroke would overwrite what the admin is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendars]);

  useEffect(() => {
    if (policies.length === 0) return;
    const chosen = policies.find((item) => item.slug === policyTarget) ?? policies[0];
    if (slaTargets.length === 0 || chosen.slug !== policyTarget) loadPolicyForm(chosen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policies]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Writes — one per step, each callable on change, on blur and on Continuer
  // ═══════════════════════════════════════════════════════════════════════════

  const markSaved = useCallback((which: Step) => {
    setSaved((prev) => ({ ...prev, [which]: true }));
  }, []);

  async function saveAppearance(): Promise<void> {
    await profileApi.update({ preferredLanguage: locale });
    setLanguage(locale);
    await profileApi.setPreferences({ preferredTheme: theme });
    markSaved('appearance');
  }

  async function saveIdentity(): Promise<void> {
    if (!session) return;
    if (!isAdmin) return; // The form is disabled; this is the belt to that brace.

    const settings: TenantSettings = {
      ...(session.tenant.settings ?? {}),
      ticketPrefix: ticketPrefix.trim().toUpperCase() || undefined,
      timezone: orgTimezone,
      portalTitle: portalTitle.trim() || undefined,
      portalEnabled,
    };
    const tenant = await tenantsApi.update(session.tenant.id, {
      name: orgName.trim() || session.tenant.name,
      settings,
    });
    setSession({ ...session, tenant });
    markSaved('identity');
  }

  /**
   * Step 3. Editing patches the stored body in place; creating clones the
   * default queue's body so every cross-reference in it is one the linter will
   * accept, then overrides the handful of keys this form owns.
   */
  async function saveQueue(): Promise<void> {
    const slug = slugify(queueMode === 'create' ? queueSlug || queueName : queueTarget);
    if (!slug) return;

    // Untouched: nothing to write, and a publish would append a version row
    // recording that somebody walked past.
    const signature = queueSignature(
      slug,
      queueName,
      queueDescription,
      queueGroup,
      queueCalendar,
      queuePolicy,
      queueIsDefault,
    );
    if (queueMode === 'edit' && signature === queueSnapshot) {
      markSaved('queue');
      return;
    }

    const label = { fr: queueName.trim() || slug, en: queueName.trim() || slug };
    const description = { fr: queueDescription.trim(), en: queueDescription.trim() };

    if (queueMode === 'create') {
      const template = queues.find((queue) => (queue.body as unknown as LooseBody).is_default === true) ?? queues[0];
      const body: LooseBody = template ? { ...(template.body as unknown as LooseBody) } : {};
      body.label = label;
      body.description = description;
      patchAlias(body, ['order', 'sortOrder'], (queues.length + 1) * 10);
      patchAlias(body, ['is_default', 'isDefault'], queueIsDefault);
      patchAlias(body, ['default_assignment_group', 'assignmentGroupSlug'], queueGroup.trim() || null);
      patchAlias(body, ['default_calendar', 'calendarSlug'], queueCalendar);
      patchAlias(body, ['default_sla_policy', 'slaPolicySlug'], queuePolicy);
      patchAlias(body, ['visible_to_groups', 'visibleToGroups'], queueGroup.trim() ? [queueGroup.trim()] : []);

      await configApi.create({
        kind: 'queue',
        slug,
        name: queueName.trim() || slug,
        description: queueDescription.trim() || null,
        body: body as unknown as ConfigBodyFor<'queue'>,
      });
    } else {
      const existing = await configApi.get('queue', slug);
      const body: LooseBody = { ...(existing.body as unknown as LooseBody) };
      body.label = label;
      body.description = description;
      patchAlias(body, ['is_default', 'isDefault'], queueIsDefault);
      patchAlias(body, ['default_assignment_group', 'assignmentGroupSlug'], queueGroup.trim() || null);
      patchAlias(body, ['default_calendar', 'calendarSlug'], queueCalendar);
      patchAlias(body, ['default_sla_policy', 'slaPolicySlug'], queuePolicy);

      await configApi.update('queue', slug, {
        name: queueName.trim() || existing.name,
        description: queueDescription.trim() || null,
        body: body as unknown as ConfigBodyFor<'queue'>,
        baseVersion: existing.version,
        note: 'setup wizard',
      });
    }

    await configApi.publish('queue', slug, 'setup wizard');

    // Two default queues is an ambiguity nobody can see in a list, so demote the
    // previous one. A failure here is reported and does not undo the main write.
    if (queueIsDefault) {
      const previous = queues.find(
        (queue) => queue.slug !== slug && (queue.body as unknown as LooseBody).is_default === true,
      );
      if (previous) {
        try {
          const object = await configApi.get('queue', previous.slug);
          const body: LooseBody = { ...(object.body as unknown as LooseBody) };
          patchAlias(body, ['is_default', 'isDefault'], false);
          await configApi.update('queue', previous.slug, {
            body: body as unknown as ConfigBodyFor<'queue'>,
            baseVersion: object.version,
            note: 'setup wizard — single default queue',
          });
          await configApi.publish('queue', previous.slug, 'setup wizard');
        } catch (err) {
          toast.error(
            describeError(
              err,
              t('setup.queueDemoteFailed', "L'ancienne file par défaut n'a pas pu être rétrogradée."),
            ),
          );
        }
      }
    }

    await loadConfig();
    setQueueMode('edit');
    setQueueTarget(slug);
    setQueueSnapshot(signature);
    markSaved('queue');
  }

  /**
   * Step 4. The calendar's weekday dialect is preserved: the shipped bodies are
   * ISO-8601 (1 = Monday … 7 = Sunday) and carry `weekday_convention` saying so,
   * while `CalendarShift` in @oblidesk/shared is 0 = Sunday. Rewriting one into
   * the other silently would move Monday to Sunday on a live desk.
   */
  async function saveSla(): Promise<void> {
    const calendarDirty =
      calendars.length > 0 &&
      calendarSignature(calendarTarget, calendarDays, calendarStart, calendarEnd, calendarTimezone) !==
        calendarSnapshot;

    if (calendarDirty) {
      const calendarObject = await configApi.get('calendar', calendarTarget);
      const calendarBody: LooseBody = { ...(calendarObject.body as unknown as LooseBody) };
      const oldShifts = Array.isArray(calendarBody.shifts) ? (calendarBody.shifts as LooseBody[]) : [];
      const sample = oldShifts[0] ?? {};
      const usesSnake = 'start_minute' in sample || !('startMinute' in sample);

      const startMinute = minuteOfTime(calendarStart);
      const endMinute = minuteOfTime(calendarEnd);

      // A calendar with no open day would make every SLA unreachable, so an
      // empty selection leaves the shipped shifts alone rather than writing it.
      if (startMinute !== null && endMinute !== null && calendarDays.length > 0) {
        calendarBody.shifts = calendarDays.map((weekday) =>
          usesSnake
            ? {
                weekday,
                start: calendarStart,
                end: calendarEnd,
                start_minute: startMinute,
                end_minute: endMinute,
              }
            : { weekday, startMinute, endMinute },
        );
      }
      calendarBody.timezone = calendarTimezone;

      await configApi.update('calendar', calendarTarget, {
        body: calendarBody as unknown as ConfigBodyFor<'calendar'>,
        baseVersion: calendarObject.version,
        note: 'setup wizard',
      });
      await configApi.publish('calendar', calendarTarget, 'setup wizard');
    }

    const policyDirty =
      policies.length > 0 && policySignature(policyTarget, slaMinutes) !== policySnapshot;

    if (!policyDirty) {
      if (calendarDirty) {
        await loadConfig();
        setCalendarSnapshot(
          calendarSignature(calendarTarget, calendarDays, calendarStart, calendarEnd, calendarTimezone),
        );
      }
      markSaved('sla');
      return;
    }

    const policyObject = await configApi.get('sla', policyTarget);
    const policyBody: LooseBody = { ...(policyObject.body as unknown as LooseBody) };
    const targets = Array.isArray(policyBody.targets) ? (policyBody.targets as LooseBody[]) : [];

    policyBody.targets = targets.map((target) => {
      const slug = String(target.slug ?? '');
      const edits = slaMinutes[slug];
      if (!edits) return target;

      const key = presentKey(target, ['by_priority', 'durationsByPriority', 'durations']) ?? 'by_priority';
      const durations: LooseBody = { ...(isPlainObject(target[key]) ? (target[key] as LooseBody) : {}) };

      for (const [priority, raw] of Object.entries(edits)) {
        const minutes = Number(raw);
        // HARD RULE 12's sibling: an unusable value is skipped, never turned
        // into a validation error that blocks the whole step.
        if (!Number.isFinite(minutes) || minutes <= 0) continue;
        const spec = durations[priority];
        if (isPlainObject(spec)) {
          const labels = durationLabels(minutes);
          const nextLabel = isPlainObject(spec.label)
            ? labels
            : typeof spec.label === 'string'
              ? labels.fr
              : labels;
          durations[priority] = { ...spec, minutes, label: nextLabel };
        } else {
          durations[priority] = minutes;
        }
      }

      return { ...target, [key]: durations };
    });

    await configApi.update('sla', policyTarget, {
      body: policyBody as unknown as ConfigBodyFor<'sla'>,
      baseVersion: policyObject.version,
      note: 'setup wizard',
    });
    await configApi.publish('sla', policyTarget, 'setup wizard');

    await loadConfig();
    setCalendarSnapshot(
      calendarSignature(calendarTarget, calendarDays, calendarStart, calendarEnd, calendarTimezone),
    );
    setPolicySnapshot(policySignature(policyTarget, slaMinutes));
    markSaved('sla');
  }

  async function saveMail(): Promise<void> {
    if (session && isAdmin) {
      const settings: TenantSettings = {
        ...(session.tenant.settings ?? {}),
        fromName: fromName.trim() || undefined,
        fromAddress: fromAddress.trim() || undefined,
      };
      const tenant = await tenantsApi.update(session.tenant.id, { settings });
      setSession({ ...session, tenant });
    }

    // A tenant override needs CONFIG_ADMIN. The toggle is disabled without it;
    // this keeps a stale click from turning the whole step into a 403.
    if (canConfig) {
      await apiClient.put('/settings/mail.stripQuotedReplies', { value: stripQuoted });
    }

    // `mail.pollIntervalSeconds` is platformOnly — a tenant override is refused
    // by the service, so it goes to the installation-wide row instead.
    if (isAdmin) {
      const seconds = Number(pollSeconds);
      if (Number.isFinite(seconds) && seconds > 0) {
        await apiClient.put('/settings/global/mail.pollIntervalSeconds', { value: Math.round(seconds) });
      }
    }

    markSaved('mail');
  }

  /** Runs the write for `which`, holding the busy flag and surfacing failures. */
  async function runSave(which: Step, options: { silent?: boolean } = {}): Promise<boolean> {
    if (which === 'demo') return true;
    setBusy(true);
    setError('');
    try {
      if (which === 'appearance') await saveAppearance();
      else if (which === 'identity') await saveIdentity();
      else if (which === 'queue') await saveQueue();
      else if (which === 'sla') await saveSla();
      else if (which === 'mail') await saveMail();
      if (!options.silent) toast.success(t('setup.stepSaved', 'Enregistré.'));
      return true;
    } catch (err) {
      const message = describeError(err, t('common.saveFailed', "L'enregistrement a échoué."));
      setError(message);
      if (!options.silent) toast.error(message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 6 — the demonstration tenant
  // ═══════════════════════════════════════════════════════════════════════════

  function setPhase(id: string, patch: Partial<DemoPhase>) {
    setDemoPhases((prev) => prev.map((phase) => (phase.id === id ? { ...phase, ...patch } : phase)));
  }

  /**
   * Creates a SEPARATE tenant, copies this tenant's published configuration into
   * it and fills it with tickets. Separate because purging then becomes one
   * cascading delete instead of a hunt through real data for rows that "look
   * like" demo rows.
   *
   * `setTenantOverride` retargets EVERY request from this tab for the duration,
   * so the window is kept as short as possible and always closed in `finally`.
   */
  async function seedDemo(): Promise<void> {
    const volume = Math.max(1, Math.min(400, Number(demoVolume) || 60));

    setDemoRunning(true);
    setError('');
    setDemoPhases([
      { id: 'tenant', label: t('setup.demoPhaseTenant', 'Créer le tenant « Démonstration »'), state: 'running' },
      { id: 'config', label: t('setup.demoPhaseConfig', 'Copier la configuration publiée'), state: 'pending' },
      {
        id: 'tickets',
        // `n`, not `count`: `count` switches i18next into plural resolution and
        // would look for `…_one` / `…_other` keys the bundle does not carry.
        label: t('setup.demoPhaseTickets', 'Créer {{n}} tickets', { n: volume }),
        state: 'pending',
      },
    ]);

    let createdTenantId: number | null = null;

    try {
      const tenant = await tenantsApi.create({
        slug: DEMO_TENANT_SLUG,
        name: 'Démonstration',
        settings: { ticketPrefix: 'DEMO' },
      });
      createdTenantId = tenant.id;
      setDemoTenantId(tenant.id);
      setPhase('tenant', { state: 'done', detail: `#${tenant.id} · ${tenant.slug}` });

      setPhase('config', { state: 'running' });
      const bundle = await configApi.exportBundle();

      setTenantOverride(tenant.id);
      try {
        const applied = await configApi.applyImport(bundle, { overwrite: true });
        setPhase('config', {
          state: 'done',
          detail: t('setup.demoConfigApplied', '{{created}} objets créés', { created: applied.created }),
        });

        setPhase('tickets', { state: 'running' });
        let done = 0;
        let failed = 0;
        const queueSlugs = queues.length > 0 ? queues.map((queue) => queue.slug) : ['general'];
        const now = Date.now();

        // Five at a time. `apiLimiter` skips signed-in traffic, so this is not
        // about 429s — it is about not queueing 150 ticket creations, each of
        // which runs the rules engine and starts an SLA clock, behind one lane.
        const lanes = 5;
        const failedLabel = t('setup.demoFailedCount', 'échecs');
        const indices = [...Array(volume).keys()];
        await Promise.all(
          Array.from({ length: lanes }, async (_unused, lane) => {
            for (const index of indices.filter((value) => value % lanes === lane)) {
              const levels = DEMO_LEVELS[index % DEMO_LEVELS.length];
              // Occurrence spread over 30 days — HARD RULE 6's field is what the
              // queue sorts and the SLA clock starts from, so it must vary.
              const ageMinutes = Math.round((index / volume) * 30 * 24 * 60);
              try {
                await ticketsApi.create({
                  recordType: DEMO_RECORD_TYPES[index % DEMO_RECORD_TYPES.length],
                  subject: `${DEMO_SUBJECTS[index % DEMO_SUBJECTS.length]} (${index + 1})`,
                  descriptionMd: t(
                    'setup.demoTicketBody',
                    'Ticket de démonstration créé par l’assistant de mise en route. Supprimez le tenant « Démonstration » pour tout effacer.',
                  ),
                  occurredAt: new Date(now - ageMinutes * 60_000).toISOString(),
                  queueSlug: queueSlugs[index % queueSlugs.length],
                  impact: levels.impact,
                  urgency: levels.urgency,
                  source: DEMO_SOURCES[index % DEMO_SOURCES.length],
                });
                done += 1;
              } catch {
                failed += 1;
              }
              setPhase('tickets', {
                state: 'running',
                detail: `${done}/${volume}${failed ? ` · ${failed} ${failedLabel}` : ''}`,
              });
            }
          }),
        );

        setPhase('tickets', {
          state: failed >= volume ? 'failed' : 'done',
          detail: `${done}/${volume}${failed ? ` · ${failed} ${failedLabel}` : ''}`,
        });
      } finally {
        setTenantOverride(null);
      }

      await useTenantStore.getState().fetchMemberships();
      markSaved('demo');
      toast.success(t('setup.demoReady', 'Jeu de démonstration prêt.'));
    } catch (err) {
      const message = describeError(err, t('setup.demoFailed', 'La création du jeu de démonstration a échoué.'));
      setError(message);
      setDemoPhases((prev) =>
        prev.map((phase) => (phase.state === 'running' ? { ...phase, state: 'failed', detail: message } : phase)),
      );
      if (createdTenantId === null) setDemoTenantId(null);
    } finally {
      setTenantOverride(null);
      setDemoRunning(false);
    }
  }

  /** One button, one cascading delete. `confirmSlug` is the server's guard. */
  async function purgeDemo(): Promise<void> {
    if (demoTenantId === null) return;
    setPurging(true);
    setError('');
    try {
      await apiClient.delete(`/tenants/${demoTenantId}`, { params: { confirmSlug: DEMO_TENANT_SLUG } });
      setDemoTenantId(null);
      setDemoPhases([]);
      await useTenantStore.getState().fetchMemberships();
      toast.success(t('setup.demoPurged', 'Tenant de démonstration supprimé.'));
    } catch (err) {
      const message = describeError(err, t('setup.demoPurgeFailed', 'La purge a échoué.'));
      setError(message);
      toast.error(message);
    } finally {
      setPurging(false);
    }
  }

  async function openDemo(): Promise<void> {
    if (demoTenantId === null) return;
    try {
      await useTenantStore.getState().fetchMemberships();
      await useTenantStore.getState().switchTenant(demoTenantId);
      await useAuthStore.getState().refresh();
      navigate('/tickets');
    } catch (err) {
      toast.error(describeError(err, t('setup.demoSwitchFailed', 'Le changement de tenant a échoué.')));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════════════════════════════════════

  function goTo(next: Step) {
    setError('');
    setStep(next);
  }

  function skip() {
    setError('');
    if (isLast) finish();
    else goTo(STEPS[currentIndex + 1]);
  }

  async function saveAndAdvance() {
    const ok = await runSave(step);
    if (!ok) return;
    if (isLast) finish();
    else goTo(STEPS[currentIndex + 1]);
  }

  function finish() {
    try {
      localStorage.setItem(SETUP_MARK_KEY, new Date().toISOString());
    } catch {
      // Nothing depends on the mark; losing it only loses a reassurance line.
    }
    navigate('/');
  }

  // ── Options ───────────────────────────────────────────────────────────────

  const calendarOptions = useMemo<SelectOption[]>(
    () =>
      calendars.map((calendar) => ({
        value: calendar.slug,
        label: `${localizedLabel((calendar.body as unknown as LooseBody).label, uiLocale, calendar.name)} · ${calendar.slug}`,
      })),
    [calendars, uiLocale],
  );

  const policyOptions = useMemo<SelectOption[]>(
    () =>
      policies.map((policy) => ({
        value: policy.slug,
        label: `${localizedLabel((policy.body as unknown as LooseBody).label, uiLocale, policy.name)} · ${policy.slug}`,
      })),
    [policies, uiLocale],
  );

  const queueOptions = useMemo<SelectOption[]>(
    () =>
      queues.map((queue) => ({
        value: queue.slug,
        label: `${localizedLabel((queue.body as unknown as LooseBody).label, uiLocale, queue.name)} · ${queue.slug}`,
      })),
    [queues, uiLocale],
  );

  const timezoneOptions = useMemo<SelectOption[]>(() => {
    const values = [...new Set([...TIMEZONE_CHOICES, orgTimezone, calendarTimezone].filter(Boolean))];
    return values.map((zone) => ({ value: zone, label: zone }));
  }, [orgTimezone, calendarTimezone]);

  const weekdayLabels = [
    t('setup.mon', 'Lun'),
    t('setup.tue', 'Mar'),
    t('setup.wed', 'Mer'),
    t('setup.thu', 'Jeu'),
    t('setup.fri', 'Ven'),
    t('setup.sat', 'Sam'),
    t('setup.sun', 'Dim'),
  ];

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <LoadingSpinner size="lg" label={t('setup.loading', 'Lecture de la configuration…')} />
      </div>
    );
  }

  // Routed inside <AppLayout /> (see App.tsx), so this is a page in the shell,
  // not a full-screen takeover: the topbar stays reachable and an admin can
  // leave mid-wizard through the normal navigation.
  return (
    <div className="p-6 pb-16">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <header className="text-center">
          {/* No logo here: the topbar already carries the mark, and a second one
              40px below it reads as a mistake rather than as ceremony. */}
          <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
            {t('setup.title', 'Mise en route du bureau')}
          </h1>
          <p className="mx-auto mt-1 max-w-xl text-sm leading-relaxed text-text-secondary">
            {t(
              'setup.subtitle',
              'Six réglages, tous facultatifs. Chaque étape est écrite immédiatement et vous dit où le réglage vit ensuite.',
            )}
          </p>
          {completedAt && (
            <p className="mt-2 text-[11px] text-text-muted">
              {t('setup.alreadyRun', 'Vous avez déjà parcouru cet assistant. Vous pouvez y revenir à tout moment via /setup.')}
            </p>
          )}
        </header>

        <BaselineStrip counts={counts} />

        <Stepper current={step} saved={saved} onSelect={goTo} />

        {/* ── The step ────────────────────────────────────────────────────── */}
        <div className="space-y-5 rounded-card bg-bg-secondary p-6 shadow-card">
          {/* ── 1. Langue et thème ──────────────────────────────────────── */}
          {step === 'appearance' && (
            <StepShell
              step="appearance"
              icon={<Palette size={17} />}
              title={t('setup.appearanceTitle', 'Langue et thème')}
              lead={t(
                'setup.appearanceLead',
                'Ce choix est le vôtre, pas celui du tenant : chaque agent garde le sien. Le thème est partagé avec les autres applications de la suite.',
              )}
            >
              <div className="grid grid-cols-2 gap-2">
                {SEEDED_LOCALES.map((code) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => {
                      setLocale(code);
                      setLanguage(code);
                    }}
                    className={cn(
                      'rounded-card px-4 py-2.5 text-[13px] transition-colors',
                      locale === code
                        ? 'bg-accent/15 text-accent shadow-card'
                        : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                    )}
                  >
                    {LOCALE_LABELS[code] ?? code}
                  </button>
                ))}
              </div>

              <ThemePicker
                value={theme}
                onChange={(next) => {
                  setTheme(next);
                  applyTheme(next);
                  // Discrete choice: written straight away, not on Continuer.
                  void profileApi.setPreferences({ preferredTheme: next }).catch(() => undefined);
                }}
              />

              <p className="text-[11px] leading-relaxed text-text-muted">
                {t(
                  'setup.appearanceNote',
                  'Français et anglais sont livrés. Les autres langues de la suite existent mais ne sont pas encore traduites pour ce bureau.',
                )}
              </p>
            </StepShell>
          )}

          {/* ── 2. Identité de l'organisation ───────────────────────────── */}
          {step === 'identity' && (
            <StepShell
              step="identity"
              icon={<Building2 size={17} />}
              title={t('setup.identityTitle', "Identité de l'organisation")}
              lead={t(
                'setup.identityLead',
                'Le nom affiché partout, le préfixe des numéros de ticket et le fuseau de référence du tenant.',
              )}
            >
              {!isAdmin && (
                <p className="rounded-card bg-status-pending-requester-bg px-3 py-2 text-[12px] text-status-pending-requester">
                  {t(
                    'setup.identityNeedsAdmin',
                    "Modifier le tenant demande un rôle administrateur. Vous pouvez passer cette étape ; un administrateur la reprendra depuis Paramètres › Général.",
                  )}
                </p>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label={t('setup.orgName', "Nom de l'organisation")}
                  value={orgName}
                  onChange={(event) => setOrgName(event.target.value)}
                  onBlur={() => void runSave('identity', { silent: true })}
                  disabled={!isAdmin}
                  autoFocus
                />
                <Input
                  label={t('setup.ticketPrefix', 'Préfixe des tickets')}
                  value={ticketPrefix}
                  onChange={(event) => setTicketPrefix(event.target.value.toUpperCase().slice(0, 8))}
                  onBlur={() => void runSave('identity', { silent: true })}
                  disabled={!isAdmin}
                  className="font-mono uppercase tracking-[0.08em]"
                  hint={t('setup.ticketPrefixHint', 'Les numéros déjà émis gardent leur ancien préfixe.')}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  label={t('setup.orgTimezone', 'Fuseau de référence')}
                  options={timezoneOptions}
                  value={orgTimezone}
                  onChange={(event) => {
                    setOrgTimezone(event.target.value);
                    void runSave('identity', { silent: true });
                  }}
                  disabled={!isAdmin}
                />
                <Input
                  label={t('setup.orgSlug', 'Identifiant inter-applications')}
                  value={session?.tenant.slug ?? ''}
                  readOnly
                  disabled
                  className="font-mono"
                  hint={t(
                    'setup.orgSlugHint',
                    'Non modifiable : chaque application de la suite vous connaît par ce slug.',
                  )}
                />
              </div>

              <Toggle
                labelFirst
                checked={portalEnabled}
                onChange={(next) => {
                  setPortalEnabled(next);
                  void runSave('identity', { silent: true });
                }}
                disabled={!isAdmin}
                label={t('setup.portalEnabled', 'Ouvrir le portail demandeur')}
                description={t(
                  'setup.portalEnabledHint',
                  'Les demandeurs voient leurs propres tickets et peuvent répondre, sans accès au bureau.',
                )}
              />

              {portalEnabled && (
                <Input
                  label={t('setup.portalTitle', 'Titre du portail')}
                  value={portalTitle}
                  onChange={(event) => setPortalTitle(event.target.value)}
                  onBlur={() => void runSave('identity', { silent: true })}
                  disabled={!isAdmin}
                  placeholder={orgName}
                />
              )}
            </StepShell>
          )}

          {/* ── 3. Première file + groupe d'assignation ─────────────────── */}
          {step === 'queue' && (
            <StepShell
              step="queue"
              icon={<Inbox size={17} />}
              title={t('setup.queueTitle', "Première file et groupe d'assignation")}
              lead={t(
                'setup.queueLead',
                'Quatre files sont déjà en service. Renommez-en une pour coller à votre vocabulaire, ou ajoutez la vôtre.',
              )}
            >
              <div className="flex flex-wrap gap-1.5">
                {queues.map((queue) => (
                  <button
                    key={queue.slug}
                    type="button"
                    onClick={() => {
                      setQueueMode('edit');
                      loadQueueForm(queue.slug);
                    }}
                    className={cn(
                      'rounded-pill px-2.5 py-1 text-[11px] transition-colors',
                      queueMode === 'edit' && queueTarget === queue.slug
                        ? 'bg-accent/15 text-accent'
                        : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                    )}
                  >
                    {localizedLabel((queue.body as unknown as LooseBody).label, uiLocale, queue.name)}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setQueueMode('create');
                    setQueueTarget('');
                    setQueueName('');
                    setQueueSlug('');
                    setQueueDescription('');
                    setQueueIsDefault(false);
                  }}
                  className={cn(
                    'rounded-pill px-2.5 py-1 text-[11px] transition-colors',
                    queueMode === 'create'
                      ? 'bg-accent/15 text-accent'
                      : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                  )}
                >
                  {t('setup.queueNew', '+ Nouvelle file')}
                </button>
              </div>

              {queueMode === 'edit' && queues.length > 0 && (
                <Select
                  label={t('setup.queuePick', 'File à ajuster')}
                  options={queueOptions}
                  value={queueTarget}
                  onChange={(event) => loadQueueForm(event.target.value)}
                />
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label={t('setup.queueName', 'Nom de la file')}
                  value={queueName}
                  onChange={(event) => {
                    setQueueName(event.target.value);
                    if (queueMode === 'create') setQueueSlug(slugify(event.target.value));
                  }}
                  placeholder={t('setup.queueNamePlaceholder', 'Poste de travail')}
                />
                <Input
                  label={t('setup.queueSlug', 'Slug')}
                  value={queueMode === 'create' ? queueSlug : queueTarget}
                  onChange={(event) => setQueueSlug(slugify(event.target.value))}
                  disabled={queueMode === 'edit'}
                  className="font-mono"
                  hint={
                    queueMode === 'edit'
                      ? t('setup.queueSlugLocked', 'Le slug est l’identité de la file : il ne se renomme pas.')
                      : t('setup.queueSlugHint', 'Minuscules, chiffres, tiret et souligné.')
                  }
                />
              </div>

              <Input
                label={t('setup.queueDescription', 'Ce qui atterrit ici')}
                value={queueDescription}
                onChange={(event) => setQueueDescription(event.target.value)}
                placeholder={t('setup.queueDescriptionPlaceholder', 'Postes, périphériques, logiciels du poste.')}
              />

              <div className="space-y-3 rounded-card bg-bg-tertiary p-4">
                <p className="flex items-center gap-1.5 text-[12px] font-medium text-text-primary">
                  <Users size={13} className="text-accent" />
                  {t('setup.queueGroupTitle', "Groupe d'assignation")}
                </p>
                <Input
                  label={t('setup.queueGroupSlug', 'Slug du groupe qui reçoit ces tickets')}
                  value={queueGroup}
                  onChange={(event) => setQueueGroup(event.target.value.trim())}
                  className="font-mono"
                  hint={t(
                    'setup.queueGroupHint',
                    'Le groupe livré est « service-desk » et contient l’administrateur. Les groupes eux-mêmes se gèrent dans Administration › Configuration.',
                  )}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  label={t('setup.queueCalendar', 'Calendrier de la file')}
                  options={calendarOptions}
                  value={queueCalendar}
                  onChange={(event) => setQueueCalendar(event.target.value)}
                />
                <Select
                  label={t('setup.queuePolicy', 'Politique SLA')}
                  options={policyOptions}
                  value={queuePolicy}
                  onChange={(event) => setQueuePolicy(event.target.value)}
                />
              </div>

              <Toggle
                labelFirst
                checked={queueIsDefault}
                onChange={setQueueIsDefault}
                label={t('setup.queueDefault', 'File par défaut')}
                description={t(
                  'setup.queueDefaultHint',
                  'Tout ticket sans file explicite arrive ici. L’ancienne file par défaut est rétrogradée dans la foulée.',
                )}
              />

              <p className="text-[11px] leading-relaxed text-text-muted">
                {t(
                  'setup.queuePublishNote',
                  'La publication passe par le linter : une référence qui ne pointe sur rien est refusée avec le détail, pas silencieusement acceptée.',
                )}
              </p>
            </StepShell>
          )}

          {/* ── 4. Calendrier ouvré + politique SLA ─────────────────────── */}
          {step === 'sla' && (
            <StepShell
              step="sla"
              icon={<Timer size={17} />}
              title={t('setup.slaTitle', 'Heures ouvrées et politique SLA')}
              lead={t(
                'setup.slaLead',
                'Les durées SLA se comptent en minutes ouvrées sur le calendrier choisi : « 1 jour » vaut 540 minutes de 09:00 à 18:00, pas 1440.',
              )}
            >
              <div className="space-y-3 rounded-card bg-bg-tertiary p-4">
                <div className="flex items-center gap-2">
                  <Calendar size={14} className="text-accent" />
                  <p className="text-[12px] font-medium text-text-primary">
                    {t('setup.slaCalendar', 'Calendrier')}
                  </p>
                </div>

                <Select
                  options={calendarOptions}
                  value={calendarTarget}
                  onChange={(event) => {
                    const chosen = calendars.find((item) => item.slug === event.target.value);
                    if (chosen) loadCalendarForm(chosen);
                  }}
                  size="sm"
                />

                <div className="flex flex-wrap gap-1.5">
                  {weekdayLabels.map((label, index) => {
                    // Shipped bodies are ISO-8601, so 1 = Monday.
                    const weekday = index + 1;
                    const on = calendarDays.includes(weekday);
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() =>
                          setCalendarDays((prev) =>
                            prev.includes(weekday)
                              ? prev.filter((value) => value !== weekday)
                              : [...prev, weekday].sort((a, b) => a - b),
                          )
                        }
                        className={cn(
                          'rounded-pill px-3 py-1 text-[11px] transition-colors',
                          on
                            ? 'bg-accent/15 text-accent'
                            : 'bg-bg-primary text-text-muted hover:bg-bg-hover hover:text-text-primary',
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <Select
                    label={t('setup.slaStart', 'Ouverture')}
                    options={TIME_OPTIONS}
                    value={calendarStart}
                    onChange={(event) => setCalendarStart(event.target.value)}
                    size="sm"
                  />
                  <Select
                    label={t('setup.slaEnd', 'Fermeture')}
                    options={TIME_OPTIONS}
                    value={calendarEnd}
                    onChange={(event) => setCalendarEnd(event.target.value)}
                    size="sm"
                  />
                  <Select
                    label={t('setup.slaTimezone', 'Fuseau')}
                    options={timezoneOptions}
                    value={calendarTimezone}
                    onChange={(event) => setCalendarTimezone(event.target.value)}
                    size="sm"
                  />
                </div>

                <p className="text-[11px] leading-relaxed text-text-muted">
                  {t(
                    'setup.slaHolidays',
                    'Les jours fériés français à date fixe sont déjà posés. Les fériés mobiles (lundi de Pâques, Ascension, lundi de Pentecôte) sont volontairement absents plutôt que faux : ajoutez-les dans SLA et équipes.',
                  )}
                </p>
              </div>

              <div className="space-y-3 rounded-card bg-bg-tertiary p-4">
                <div className="flex items-center gap-2">
                  <Timer size={14} className="text-accent" />
                  <p className="text-[12px] font-medium text-text-primary">
                    {t('setup.slaPolicy', 'Politique SLA')}
                  </p>
                </div>

                <Select
                  options={policyOptions}
                  value={policyTarget}
                  onChange={(event) => {
                    const chosen = policies.find((item) => item.slug === event.target.value);
                    if (chosen) loadPolicyForm(chosen);
                  }}
                  size="sm"
                />

                {slaTargets.length === 0 ? (
                  <p className="text-[12px] text-text-muted">
                    {t('setup.slaNoTargets', 'Cette politique ne déclare aucune cible.')}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[380px] text-left text-[12px]">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-[0.12em] text-text-muted">
                          <th className="pb-2 pr-3 font-medium">{t('setup.slaPriority', 'Priorité')}</th>
                          {slaTargets.map((target) => (
                            <th key={target.slug} className="pb-2 pr-3 font-medium">
                              {target.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {slaPriorities.map((priority) => (
                          <tr key={priority}>
                            <td className="py-1 pr-3 font-mono text-text-primary">{priority.toUpperCase()}</td>
                            {slaTargets.map((target) => (
                              <td key={target.slug} className="py-1 pr-3">
                                <Input
                                  size="sm"
                                  inputMode="numeric"
                                  value={slaMinutes[target.slug]?.[priority] ?? ''}
                                  onChange={(event) =>
                                    setSlaMinutes((prev) => ({
                                      ...prev,
                                      [target.slug]: {
                                        ...(prev[target.slug] ?? {}),
                                        [priority]: event.target.value.replace(/\D/g, '').slice(0, 6),
                                      },
                                    }))
                                  }
                                  className="font-mono"
                                  wrapperClassName="w-24"
                                  aria-label={`${target.label}, ${priority}`}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <p className="text-[11px] leading-relaxed text-text-muted">
                  {t(
                    'setup.slaMinutesNote',
                    'Valeurs en minutes ouvrées. Un champ vide ou nul est ignoré : la cible livrée reste en place plutôt que de devenir impossible à tenir.',
                  )}
                </p>
              </div>
            </StepShell>
          )}

          {/* ── 5. Canal e-mail ─────────────────────────────────────────── */}
          {step === 'mail' && (
            <StepShell
              step="mail"
              icon={<Mail size={17} />}
              title={t('setup.mailTitle', 'Canal e-mail')}
              lead={t(
                'setup.mailLead',
                'Facultatif. Le bureau fonctionne sans e-mail : les tickets arrivent alors par le portail, l’API ou la saisie directe.',
              )}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label={t('setup.fromName', 'Nom expéditeur')}
                  value={fromName}
                  onChange={(event) => setFromName(event.target.value)}
                  onBlur={() => void runSave('mail', { silent: true })}
                  disabled={!isAdmin}
                  placeholder={orgName || 'Service Desk'}
                />
                <Input
                  label={t('setup.fromAddress', 'Adresse expéditrice')}
                  type="email"
                  value={fromAddress}
                  onChange={(event) => setFromAddress(event.target.value)}
                  onBlur={() => void runSave('mail', { silent: true })}
                  disabled={!isAdmin}
                  placeholder="support@exemple.fr"
                />
              </div>

              <Toggle
                labelFirst
                checked={stripQuoted}
                onChange={(next) => {
                  setStripQuoted(next);
                  void runSave('mail', { silent: true });
                }}
                disabled={!canConfig}
                label={t('setup.stripQuoted', "Couper l'historique cité des réponses")}
                description={t(
                  'setup.stripQuotedHint',
                  'Sans cela, chaque réponse recopie tout le fil dans le journal et le rend illisible au bout de trois échanges.',
                )}
              />

              <Input
                label={t('setup.pollSeconds', 'Relève des boîtes (secondes)')}
                inputMode="numeric"
                value={pollSeconds}
                onChange={(event) => setPollSeconds(event.target.value.replace(/\D/g, '').slice(0, 4))}
                onBlur={() => void runSave('mail', { silent: true })}
                disabled={!isAdmin}
                className="font-mono"
                hint={t(
                  'setup.pollSecondsHint',
                  "Réglage de l'installation, pas du tenant : il vaut pour toutes les organisations hébergées. Entre 15 et 3600.",
                )}
              />

              <div className="space-y-2 rounded-card bg-bg-tertiary p-4">
                <p className="text-[12px] font-medium text-text-primary">
                  {t('setup.smtpTitle', "Serveur d'envoi")}
                </p>
                {smtpBase ? (
                  <p className="text-[12px] leading-relaxed text-text-secondary">
                    {smtpCount === null
                      ? t(
                          'setup.smtpForbidden',
                          "La gestion des serveurs SMTP existe sur ce serveur mais votre compte n'y a pas accès.",
                        )
                      : t('setup.smtpFound', '{{n}} serveur(s) SMTP déclaré(s).', { n: smtpCount })}
                  </p>
                ) : (
                  <p className="text-[12px] leading-relaxed text-text-secondary">
                    {t(
                      'setup.smtpMissing',
                      "La surface HTTP des serveurs SMTP n'est pas montée sur cette version : le service existe, la route n'est pas encore exposée. Rien à configurer ici pour l'instant.",
                    )}
                  </p>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Link
                    to="/settings?tab=smtp"
                    className="inline-flex items-center gap-1.5 rounded-pill bg-bg-primary px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                  >
                    {t('setup.smtpLink', 'Paramètres › SMTP')}
                    <ExternalLink size={11} />
                  </Link>
                  <Link
                    to="/admin/channels"
                    className="inline-flex items-center gap-1.5 rounded-pill bg-bg-primary px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                  >
                    {t('setup.channelsLink', 'Administration › Canaux')}
                    <ExternalLink size={11} />
                  </Link>
                </div>
              </div>
            </StepShell>
          )}

          {/* ── 6. Jeu de démonstration ─────────────────────────────────── */}
          {step === 'demo' && (
            <StepShell
              step="demo"
              icon={<Database size={17} />}
              title={t('setup.demoTitle', 'Jeu de démonstration')}
              lead={t(
                'setup.demoLead',
                'On ne juge pas une file, une virtualisation, une pastille SLA ni une détection de collision avec zéro ticket. Cette étape en crée, dans un tenant séparé, et sait tout effacer.',
              )}
            >
              {!isAdmin && (
                <p className="rounded-card bg-status-pending-requester-bg px-3 py-2 text-[12px] text-status-pending-requester">
                  {t(
                    'setup.demoNeedsAdmin',
                    'Créer ou supprimer un tenant demande un rôle administrateur de plateforme.',
                  )}
                </p>
              )}

              {demoTenantId === null ? (
                <>
                  <div className="space-y-2 rounded-card bg-bg-tertiary p-4">
                    <p className="text-[12px] font-medium text-text-primary">
                      {t('setup.demoManifest', 'Ce que ce bouton crée, exactement')}
                    </p>
                    <ul className="space-y-1.5 text-[12px] leading-relaxed text-text-secondary">
                      <li>
                        {t('setup.demoItemTenant', 'Un tenant « Démonstration » (slug « demo », préfixe DEMO).')}
                      </li>
                      <li>
                        {t(
                          'setup.demoItemConfig',
                          'Une copie de la configuration publiée de ce tenant : files, SLA, calendriers, vues, cycle de vie.',
                        )}
                      </li>
                      <li>
                        {t(
                          'setup.demoItemTickets',
                          'Des tickets répartis sur les files, avec impact et urgence variés (la priorité est calculée par la vraie matrice), et des dates de survenue étalées sur 30 jours.',
                        )}
                      </li>
                      <li className="text-text-muted">
                        {t('setup.demoItemSafe', 'Rien n’est écrit dans votre tenant courant.')}
                      </li>
                    </ul>
                  </div>

                  <div className="flex flex-wrap items-end gap-3">
                    <Select
                      label={t('setup.demoVolume', 'Nombre de tickets')}
                      options={[
                        { value: '25', label: t('setup.demoVolumeSmall', '25 (juste de quoi regarder)') },
                        { value: '60', label: t('setup.demoVolumeMedium', '60 (une file crédible)') },
                        { value: '150', label: t('setup.demoVolumeLarge', '150 (pour éprouver la virtualisation)') },
                      ]}
                      value={demoVolume}
                      onChange={(event) => setDemoVolume(event.target.value)}
                      wrapperClassName="w-64"
                      size="sm"
                    />
                    <Button
                      variant="primary"
                      onClick={() => void seedDemo()}
                      loading={demoRunning}
                      disabled={!isAdmin || demoRunning}
                      icon={<Database size={14} />}
                    >
                      {t('setup.demoSeed', 'Semer le jeu de démonstration')}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 rounded-card bg-bg-tertiary px-3 py-2.5">
                    <Check size={14} className="text-status-resolved" />
                    <span className="text-[12px] text-text-primary">
                      {t('setup.demoPresent', 'Le tenant « Démonstration » existe.')}
                    </span>
                    <span className="font-mono text-[11px] text-text-muted">
                      #{demoTenantId} · {DEMO_TENANT_SLUG}
                    </span>
                    <Button size="xs" variant="accent" onClick={() => void openDemo()} className="ml-auto">
                      {t('setup.demoOpen', 'Ouvrir ce tenant')}
                    </Button>
                  </div>

                  <div className="space-y-2 rounded-card bg-bg-tertiary p-4">
                    <p className="flex items-center gap-1.5 text-[12px] font-medium text-text-primary">
                      <AlertTriangle size={13} className="text-sla-breach" />
                      {t('setup.demoPurgeTitle', 'Purger')}
                    </p>
                    <p className="text-[12px] leading-relaxed text-text-secondary">
                      {t(
                        'setup.demoPurgeExplain',
                        'La purge supprime le tenant et tout ce qu’il contient : tickets, journal, SLA, courrier, journal d’audit. Sans retour arrière. Votre tenant de travail n’est pas touché.',
                      )}
                    </p>
                    <Button
                      variant="danger"
                      onClick={() => void purgeDemo()}
                      loading={purging}
                      disabled={!isAdmin || purging}
                      icon={<Trash2 size={14} />}
                      fullWidth
                    >
                      {t('setup.demoPurge', 'Supprimer le tenant de démonstration')}
                    </Button>
                  </div>
                </div>
              )}

              {demoPhases.length > 0 && (
                <ol className="space-y-1.5">
                  {demoPhases.map((phase) => (
                    <li
                      key={phase.id}
                      className="flex items-center gap-2 rounded-card bg-bg-tertiary px-3 py-2 text-[12px]"
                    >
                      <span
                        className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                          phase.state === 'done' && 'bg-sla-ok-bg text-sla-ok',
                          phase.state === 'failed' && 'bg-sla-breach-bg text-sla-breach',
                          phase.state === 'running' && 'bg-accent/20 text-accent',
                          phase.state === 'pending' && 'bg-bg-primary text-text-muted',
                        )}
                      >
                        {phase.state === 'done' ? <Check size={10} strokeWidth={3} /> : null}
                        {phase.state === 'failed' ? <AlertTriangle size={10} /> : null}
                      </span>
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate',
                          phase.state === 'pending' ? 'text-text-muted' : 'text-text-primary',
                        )}
                      >
                        {phase.label}
                      </span>
                      {phase.detail && (
                        <span className="shrink-0 font-mono text-[11px] text-text-muted">{phase.detail}</span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </StepShell>
          )}

          {error && (
            <p className="rounded-card bg-sla-breach-bg px-3 py-2 text-[12px] leading-relaxed text-sla-breach">
              {error}
            </p>
          )}

          {/* ── Navigation ──────────────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => goTo(STEPS[currentIndex - 1])}
              disabled={currentIndex === 0 || busy}
              className={cn(currentIndex === 0 && 'invisible')}
              icon={<ChevronLeft size={14} />}
            >
              {t('common.back', 'Retour')}
            </Button>

            <div className="flex items-center gap-3">
              {/* Every step is skippable. No exceptions — nothing here breaks a
                  later sign-in the way a missing second factor would. On the
                  last step "Terminer" IS the skip, so a second link saying the
                  same thing is dropped rather than duplicated. */}
              {!isLast && (
                <button
                  type="button"
                  onClick={skip}
                  className="text-[12px] text-text-muted transition-colors hover:text-text-primary"
                >
                  {t('common.skip', 'Ignorer')}
                </button>
              )}
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                onClick={() => {
                  if (step === 'demo') {
                    finish();
                    return;
                  }
                  void saveAndAdvance();
                }}
                trailing={!isLast ? <ChevronRight size={14} /> : undefined}
              >
                {isLast
                  ? t('common.finish', 'Terminer')
                  : t('setup.saveAndContinue', 'Enregistrer et continuer')}
              </Button>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => navigate('/')}
          className="mx-auto block text-[11px] text-text-muted transition-colors hover:text-text-primary"
        >
          {t('setup.leave', 'Quitter (tout ce qui est enregistré le reste)')}
        </button>
      </div>
    </div>
  );
}

export default SetupPage;
