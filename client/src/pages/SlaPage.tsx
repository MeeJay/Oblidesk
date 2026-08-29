/**
 * SlaPage — `/sla`
 *
 * Three tabs, in the order somebody actually needs them:
 *
 *   Contrats     the policies, their targets, and the arithmetic they buy
 *   Calendriers  the business calendars every one of those numbers is measured on
 *   À risque     what is about to be late right now
 *
 * ── Why the calendars sit next to the policies ──────────────────────────────
 * A calendar is the denominator of every SLA number the desk will ever quote,
 * and the most common way to get a contract wrong is to attach it to the wrong
 * week. Keeping the two on one screen means the question "does this policy
 * really give them four business hours?" can be answered by looking, rather
 * than by remembering.
 *
 * ── The at-risk board reads the cache; the explainer reads the ledger ───────
 * `/api/sla/at-risk` is served off cached `due_at` values and refreshes every
 * few seconds for every agent on shift — that is what the cache is for. The
 * moment anybody wants to ARGUE about one of those rows, they open it, and the
 * explainer replays the ledger. Two different jobs, two different costs, and
 * the expensive one is only paid when it is worth paying.
 *
 * ── Capabilities ───────────────────────────────────────────────────────────
 * The router gates policy and calendar reads on `sla_admin`; publishing goes
 * through the configuration store, which needs `config_admin`. Somebody with
 * only the first sees everything and edits nothing, and is told so once rather
 * than by a 403 per button.
 *
 * HARD RULE 11 — panes and cards are background steps, never borders.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlarmClock,
  AlertTriangle,
  CalendarDays,
  ExternalLink,
  FileClock,
  Plus,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import {
  CAPABILITIES,
  createBusinessHoursCalendar,
  type BusinessCalendar,
  type ConfigLintIssue,
} from '@oblidesk/shared';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import SlaPolicyEditor from '@/components/sla/SlaPolicyEditor';
import CalendarEditor from '@/components/sla/CalendarEditor';
import SlaLedgerView from '@/components/sla/SlaLedgerView';
import { useFieldCatalogue } from '@/components/automation/ConditionBuilder';
import { useAuthStore } from '@/store/authStore';
import { errorMessage, toApiError } from '@/api/client';
import { formatDateTime, formatDuration } from '@/utils/format';
import { cn } from '@/utils/cn';
import type { FieldChoice } from '@/api/rules.api';
import {
  draftFromPolicy,
  emptyPolicyDraft,
  slaApi,
  type AtRiskRow,
  type CalendarSummary,
  type PolicyDraft,
  type SlaPolicySummary,
} from '@/api/sla.api';

type TabId = 'policies' | 'calendars' | 'atRisk';

interface CalendarDraft {
  slug: string;
  name: string;
  calendar: BusinessCalendar;
  isNew: boolean;
}

export function SlaPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const hasCapability = useAuthStore((state) => state.hasCapability);
  const { catalogue } = useFieldCatalogue();

  const canAuthor = hasCapability(CAPABILITIES.CONFIG_ADMIN);
  const canControlClocks = hasCapability(CAPABILITIES.SLA_ADMIN);

  const [policies, setPolicies] = useState<SlaPolicySummary[]>([]);
  const [calendars, setCalendars] = useState<CalendarSummary[]>([]);
  const [atRisk, setAtRisk] = useState<AtRiskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [policyDraft, setPolicyDraft] = useState<PolicyDraft | null>(null);
  const [policyIsNew, setPolicyIsNew] = useState(false);
  const [calendarDraft, setCalendarDraft] = useState<CalendarDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [lintIssues, setLintIssues] = useState<ConfigLintIssue[]>([]);
  const [ledgerInstanceId, setLedgerInstanceId] = useState<number | null>(null);

  const requested = searchParams.get('tab');
  const tab: TabId =
    requested === 'calendars' || requested === 'atRisk' ? requested : 'policies';

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (value === null) next.delete(key);
      else next.set(key, value);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  /** Priority slugs come from the shared field catalogue, not a second fetch. */
  const priorities: FieldChoice[] = useMemo(() => {
    const fromCatalogue = catalogue?.byPath.get('priority_slug')?.choices ?? [];
    if (fromCatalogue.length > 0) return [...fromCatalogue];
    // Fall back to whatever the policies already declare, so an editor still
    // shows the columns somebody configured before the matrix was published.
    const seen = new Set<string>();
    for (const policy of policies) {
      for (const target of policy.targets) {
        for (const slug of Object.keys(target.durationsByPriority)) seen.add(slug);
      }
    }
    return [...seen].map((slug) => ({ value: slug, label: slug }));
  }, [catalogue, policies]);

  // ── loading ───────────────────────────────────────────────────────────────

  const loadConfig = useCallback(async () => {
    setLoadError(null);
    try {
      const [policyRows, calendarRows] = await Promise.all([slaApi.policies(), slaApi.calendars()]);
      setPolicies(policyRows);
      setCalendars(calendarRows);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAtRisk = useCallback(async () => {
    try {
      setAtRisk(await slaApi.atRisk({ withinMinutes: 240, includeBreached: true, limit: 100 }));
    } catch (error) {
      // The board is a live view; losing it must not blank the configuration.
      setAtRisk([]);
      setLoadError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (tab !== 'atRisk') return;
    void loadAtRisk();
    const timer = window.setInterval(() => void loadAtRisk(), 60_000);
    return () => window.clearInterval(timer);
  }, [tab, loadAtRisk]);

  // ── policies ──────────────────────────────────────────────────────────────

  async function openPolicy(policy: SlaPolicySummary) {
    setLintIssues([]);
    setPolicyIsNew(false);
    setCalendarDraft(null);
    try {
      const object = await slaApi.policyObject(policy.slug);
      setPolicyDraft(
        draftFromPolicy(
          policy,
          // The stored body is a superset of the published `SlaBody` type (the
          // engine reads `stop`, `pauseOnCategories`, `onTargetSwitch`…), so the
          // draft builder takes it as a bag and picks the keys it knows.
          (object?.body ?? null) as unknown as Record<string, unknown> | null,
          object?.description ?? '',
        ),
      );
    } catch {
      // The stored body carries the conditions the read model does not. Without
      // it the editor still works; it simply cannot show those conditions, and
      // saying so beats refusing to open.
      setPolicyDraft(draftFromPolicy(policy, null));
      toast(t('sla.bodyUnavailable', 'Conditions non chargées : le corps stocké est inaccessible.'));
    }
  }

  async function savePolicy() {
    if (!policyDraft) return;
    setSaving(true);
    setLintIssues([]);
    try {
      await slaApi.savePolicy(policyDraft, { create: policyIsNew });
      toast.success(t('sla.policySaved', 'Contrat publié'));
      setPolicyIsNew(false);
      await loadConfig();
    } catch (error) {
      const apiError = toApiError(error);
      const issues = apiError.payload?.issues;
      if (Array.isArray(issues)) {
        setLintIssues(issues as ConfigLintIssue[]);
        toast.error(t('sla.lintBlocked', 'Publication refusée : voir les remarques ci-dessus.'));
      } else {
        toast.error(errorMessage(apiError));
      }
    } finally {
      setSaving(false);
    }
  }

  // ── calendars ─────────────────────────────────────────────────────────────

  async function openCalendar(summary: CalendarSummary) {
    setPolicyDraft(null);
    setLintIssues([]);
    try {
      const object = await slaApi.calendarObject(summary.slug);
      setCalendarDraft({
        slug: summary.slug,
        name: object?.name ?? summary.name,
        calendar: (object?.body ?? {
          timezone: summary.timezone,
          shifts: summary.shifts,
          is24x7: summary.is24x7,
        }) as BusinessCalendar,
        isNew: false,
      });
    } catch {
      // A calendar the engine resolved from the projection tables (or the
      // built-in fallback) has no config object yet. Editing it CREATES one,
      // seeded from what the engine is currently using — never from a blank.
      setCalendarDraft({
        slug: summary.slug,
        name: summary.name,
        calendar: {
          timezone: summary.timezone,
          shifts: summary.shifts,
          holidays: [],
          exceptions: [],
          is24x7: summary.is24x7,
        },
        isNew: true,
      });
    }
  }

  async function saveCalendar() {
    if (!calendarDraft) return;
    setSaving(true);
    try {
      await slaApi.saveCalendar(calendarDraft.slug, calendarDraft.name, calendarDraft.calendar, {
        create: calendarDraft.isNew,
      });
      toast.success(t('sla.calendarSaved', 'Calendrier publié'));
      setCalendarDraft((current) => (current ? { ...current, isNew: false } : null));
      await loadConfig();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const tabs: Array<{ id: TabId; label: string; icon: typeof AlarmClock }> = [
    { id: 'policies', label: t('sla.tabPolicies', 'Contrats'), icon: FileClock },
    { id: 'calendars', label: t('sla.tabCalendars', 'Calendriers'), icon: CalendarDays },
    { id: 'atRisk', label: t('sla.tabAtRisk', 'À risque'), icon: AlertTriangle },
  ];

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-5">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
            {t('sla.title', 'Engagements de service')}
          </h1>
          <p className="mt-0.5 max-w-2xl text-sm text-text-muted">
            {t(
              'sla.subtitle',
              'Ce que le bureau promet, sur quel calendrier il le mesure, et ce qui est sur le point d’être en retard. Chaque compteur est justifiable ligne à ligne.',
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={13} />}
            onClick={() => {
              void loadConfig();
              if (tab === 'atRisk') void loadAtRisk();
            }}
          >
            {t('common.refresh', 'Actualiser')}
          </Button>
        </div>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-border" role="tablist">
        {tabs.map((entry) => {
          const Icon = entry.icon;
          const active = entry.id === tab;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setParam('tab', entry.id)}
              className={cn(
                'relative flex items-center gap-1.5 px-3.5 py-2 text-sm transition-colors',
                active ? 'text-accent' : 'text-text-secondary hover:text-text-primary',
              )}
            >
              <Icon size={14} />
              {entry.label}
              {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
            </button>
          );
        })}
      </nav>

      {loadError && (
        <div className="rounded-lg bg-sla-breach-bg px-3 py-2.5 text-[12.5px] text-sla-breach">{loadError}</div>
      )}

      {!canAuthor && (
        <p className="rounded-md bg-bg-tertiary px-3 py-2 text-[12px] text-text-muted">
          {t(
            'sla.readOnlyNotice',
            'Lecture seule : la publication d’un contrat ou d’un calendrier demande la capacité « administration de la configuration ».',
          )}
        </p>
      )}

      {/* ── contrats ─────────────────────────────────────────────────────── */}
      {tab === 'policies' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(320px,380px)_1fr]">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-text-muted">
                {t('sla.policyCount', '{{count}} contrat(s) publié(s)', { count: policies.length })}
              </span>
              {canAuthor && (
                <Button
                  size="xs"
                  variant="secondary"
                  icon={<Plus size={12} />}
                  onClick={() => {
                    setCalendarDraft(null);
                    setLintIssues([]);
                    setPolicyIsNew(true);
                    setPolicyDraft({
                      ...emptyPolicyDraft(),
                      calendarSlug: calendars.find((entry) => entry.isDefault)?.slug ?? 'business',
                    });
                  }}
                >
                  {t('sla.newPolicy', 'Nouveau contrat')}
                </Button>
              )}
            </div>

            {policies.length === 0 ? (
              <EmptyState
                compact
                icon={<FileClock size={20} />}
                title={t('sla.noPolicies', 'Aucun contrat publié')}
                description={t(
                  'sla.noPoliciesDesc',
                  'Sans contrat, aucun compteur ne démarre et le bureau ne promet rien de mesurable.',
                )}
              />
            ) : (
              <ul className="space-y-1.5">
                {policies.map((policy) => {
                  const problems =
                    policy.problems.length
                    + policy.targets.reduce(
                      (count, target) => count + target.issues.filter((issue) => issue.severity === 'error').length,
                      0,
                    );
                  const selected = policyDraft?.slug === policy.slug && !policyIsNew;
                  return (
                    <li key={policy.slug}>
                      <button
                        type="button"
                        onClick={() => void openPolicy(policy)}
                        className={cn(
                          'w-full rounded-lg px-3 py-2 text-left transition-colors',
                          selected ? 'bg-accent/10' : 'bg-bg-secondary hover:bg-bg-hover',
                          !policy.enabled && 'opacity-70',
                        )}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text-primary">
                            {policy.name || policy.slug}
                          </span>
                          <span className="shrink-0 rounded-pill bg-bg-tertiary px-2 py-0.5 font-mono text-[10.5px] text-text-muted">
                            {policy.level}
                          </span>
                          {problems > 0 && (
                            <span className="shrink-0 rounded-pill bg-sla-breach-bg px-2 py-0.5 text-[10.5px] text-sla-breach">
                              {problems}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-text-muted">
                          <span className="font-mono">{policy.slug}</span>
                          <span aria-hidden>·</span>
                          <span>
                            {t('sla.targetCount', '{{count}} cible(s)', { count: policy.targets.length })}
                          </span>
                          <span aria-hidden>·</span>
                          <span>{policy.calendarSlug}</span>
                          {!policy.enabled && (
                            <>
                              <span aria-hidden>·</span>
                              <span>{t('sla.inactive', 'inactif')}</span>
                            </>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="min-w-0">
            {policyDraft ? (
              <SlaPolicyEditor
                draft={policyDraft}
                onChange={setPolicyDraft}
                calendars={calendars}
                priorities={priorities}
                isNew={policyIsNew}
                readOnly={!canAuthor}
                saving={saving}
                lintIssues={lintIssues}
                onSave={savePolicy}
                onCancel={() => {
                  setPolicyDraft(null);
                  setPolicyIsNew(false);
                  setLintIssues([]);
                }}
              />
            ) : (
              <div className="rounded-lg bg-bg-secondary/60 px-4 py-10 text-center">
                <AlarmClock size={26} className="mx-auto text-text-muted" />
                <p className="mt-2 text-[13.5px] text-text-primary">
                  {t('sla.pickPolicy', 'Choisissez un contrat')}
                </p>
                <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-text-muted">
                  {t(
                    'sla.pickPolicyHelp',
                    'Chaque contrat porte ses cibles, leurs durées par priorité et le calendrier sur lequel elles se comptent. Les contrats perdants restent inscrits sur le ticket, pour qu’on puisse expliquer lequel a gagné.',
                  )}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── calendriers ──────────────────────────────────────────────────── */}
      {tab === 'calendars' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(300px,340px)_1fr]">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-text-muted">
                {t('sla.calendarCount', '{{count}} calendrier(s)', { count: calendars.length })}
              </span>
              {canAuthor && (
                <Button
                  size="xs"
                  variant="secondary"
                  icon={<Plus size={12} />}
                  onClick={() => {
                    setPolicyDraft(null);
                    setCalendarDraft({
                      slug: '',
                      name: '',
                      calendar: createBusinessHoursCalendar('Europe/Paris'),
                      isNew: true,
                    });
                  }}
                >
                  {t('sla.newCalendar', 'Nouveau calendrier')}
                </Button>
              )}
            </div>

            <ul className="space-y-1.5">
              {calendars.map((entry) => (
                <li key={entry.slug}>
                  <button
                    type="button"
                    onClick={() => void openCalendar(entry)}
                    className={cn(
                      'w-full rounded-lg px-3 py-2 text-left transition-colors',
                      calendarDraft?.slug === entry.slug ? 'bg-accent/10' : 'bg-bg-secondary hover:bg-bg-hover',
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text-primary">
                        {entry.name || entry.slug}
                      </span>
                      {entry.isDefault && (
                        <span className="shrink-0 rounded-pill bg-accent/15 px-2 py-0.5 text-[10.5px] text-accent">
                          {t('sla.defaultCalendar', 'par défaut')}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-text-muted">
                      <span className="font-mono">{entry.timezone}</span>
                      <span aria-hidden>·</span>
                      <span>{entry.is24x7 ? '24×7' : `${entry.weeklyHours} h/sem.`}</span>
                      {entry.holidayCount > 0 && (
                        <>
                          <span aria-hidden>·</span>
                          <span>
                            {t('sla.holidayCount', '{{count}} fermeture(s)', { count: entry.holidayCount })}
                          </span>
                        </>
                      )}
                      {entry.source !== 'config_object' && (
                        <>
                          <span aria-hidden>·</span>
                          <span title={t('sla.notAConfigObject', 'Résolu hors du magasin de configuration')}>
                            {entry.source}
                          </span>
                        </>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="min-w-0">
            {calendarDraft ? (
              <CalendarEditor
                slug={calendarDraft.slug}
                name={calendarDraft.name}
                calendar={calendarDraft.calendar}
                isNew={calendarDraft.isNew}
                readOnly={!canAuthor}
                saving={saving}
                onChange={(next) => setCalendarDraft({ ...next, isNew: calendarDraft.isNew })}
                onSave={saveCalendar}
                onCancel={() => setCalendarDraft(null)}
              />
            ) : (
              <div className="rounded-lg bg-bg-secondary/60 px-4 py-10 text-center">
                <CalendarDays size={26} className="mx-auto text-text-muted" />
                <p className="mt-2 text-[13.5px] text-text-primary">
                  {t('sla.pickCalendar', 'Choisissez un calendrier')}
                </p>
                <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-text-muted">
                  {t(
                    'sla.pickCalendarHelp',
                    'Un calendrier décide de ce qui compte comme temps ouvré : c’est le dénominateur de chaque chiffre que vous citerez à un client.',
                  )}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── à risque ─────────────────────────────────────────────────────── */}
      {tab === 'atRisk' && (
        <div className="space-y-2">
          <p className="text-[12px] text-text-muted">
            {t(
              'sla.atRiskHelp',
              'Horloges dont l’échéance tombe dans les quatre prochaines heures, dépassements inclus. Le temps restant est en temps réel, pas en temps ouvré : à 17 h 55, cinq minutes sont cinq minutes.',
            )}
          </p>

          {atRisk.length === 0 ? (
            <EmptyState
              compact
              icon={<ShieldAlert size={20} />}
              title={t('sla.nothingAtRisk', 'Rien à risque')}
              description={t('sla.nothingAtRiskDesc', 'Aucune horloge n’arrive à échéance dans les quatre heures.')}
            />
          ) : (
            <div className="overflow-x-auto rounded-lg bg-bg-secondary">
              <table className="w-full min-w-[820px] text-left text-[12.5px]">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-text-muted">
                    <th className="px-3 py-2 font-medium">{t('sla.ticket', 'Ticket')}</th>
                    <th className="px-3 py-2 font-medium">{t('sla.target', 'Cible')}</th>
                    <th className="px-3 py-2 font-medium">{t('sla.queue', 'File')}</th>
                    <th className="px-3 py-2 font-medium">{t('sla.due', 'Échéance')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('sla.remaining', 'Restant')}</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {atRisk.map((row) => (
                    <tr key={row.instanceId} className="align-middle transition-colors hover:bg-bg-hover">
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => navigate(`/tickets/${row.ticketId}`)}
                          className="flex items-center gap-1 font-mono text-[12px] text-accent hover:underline"
                        >
                          {row.ticketNumber}
                          <ExternalLink size={11} />
                        </button>
                        <span className="mt-0.5 block max-w-[280px] truncate text-[11.5px] text-text-muted">
                          {row.subject}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-text-secondary">
                        <span className="block">{row.targetSlug}</span>
                        <span className="block font-mono text-[11px] text-text-muted">{row.policySlug}</span>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11.5px] text-text-secondary">{row.queueSlug}</td>
                      <td className="px-3 py-2 font-mono text-[11.5px] text-text-secondary">
                        {row.dueAt ? formatDateTime(row.dueAt) : '—'}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2 text-right font-mono tabular-nums',
                          row.breached
                            ? 'text-sla-breach'
                            : !row.running
                              ? 'text-sla-paused'
                              : (row.minutesRemaining ?? 0) < 30
                                ? 'text-sla-warn'
                                : 'text-text-secondary',
                        )}
                      >
                        {row.breached
                          ? t('sla.breachedBy', 'dépassé de {{duration}}', {
                            duration: formatDuration(Math.abs(row.minutesRemaining ?? 0)),
                          })
                          : !row.running
                            ? t('sla.paused', 'en pause')
                            : formatDuration(row.minutesRemaining)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setLedgerInstanceId(row.instanceId)}
                        >
                          {t('sla.explain', 'Expliquer')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* The explainer, as a dialog: it is a thing you SHOW somebody. */}
      <Modal
        open={ledgerInstanceId !== null}
        onClose={() => setLedgerInstanceId(null)}
        size="full"
        title={t('sla.explainerTitle', 'D’où vient ce chiffre')}
        subtitle={t(
          'sla.explainerSubtitle',
          'Bandes calculées à partir du registre et du calendrier — pas du compteur mis en cache.',
        )}
        closeLabel={t('common.close', 'Fermer')}
      >
        {ledgerInstanceId !== null && (
          <SlaLedgerView
            instanceId={ledgerInstanceId}
            canControl={canControlClocks}
            onChanged={() => void loadAtRisk()}
          />
        )}
      </Modal>
    </div>
  );
}

export default SlaPage;
