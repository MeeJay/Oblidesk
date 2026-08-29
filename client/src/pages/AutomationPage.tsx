/**
 * AutomationPage — `/automation`
 *
 * ── One screen, because there is one question ───────────────────────────────
 * "What will happen to this ticket, and in what order?" is answered by an
 * ordered list, and by the evidence of what that list has actually done. So the
 * page has two tabs and no more:
 *
 *   Règles     the ordered list, and the editor for the one you picked
 *   Journal    `rule_executions` — matched, not matched, errors, durations
 *
 * A third tab for "conditions" or "actions" would imply they are separable
 * things an admin manages on their own. They are not: a condition without its
 * rule is not a unit of anything.
 *
 * ── Two capabilities, and the difference matters ────────────────────────────
 * `automation_admin` reads the list, reorders it, switches rules on and off and
 * runs simulations. AUTHORING goes through the configuration store, which is
 * gated on `config_admin`, because publishing a rule is publishing a versioned,
 * linted, exportable config object. Somebody with only the first grant gets a
 * fully working screen with the editor in read-only — not a hidden tab and not
 * a button that answers 403.
 *
 * ── The state that survives a reload ────────────────────────────────────────
 * The tab and the selected rule live in the query string, so "look at
 * `escalate_p1`" is a real link and the back button behaves.
 *
 * HARD RULE 11 — panes are separated by background steps, never borders.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { History, Plus, RefreshCw, Workflow } from 'lucide-react';
import { CAPABILITIES } from '@oblidesk/shared';
import type { ConfigLintIssue } from '@oblidesk/shared';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import RuleList from '@/components/automation/RuleList';
import RuleEditor from '@/components/automation/RuleEditor';
import ExecutionLog from '@/components/automation/ExecutionLog';
import { invalidateFieldCatalogue } from '@/components/automation/ConditionBuilder';
import { useAuthStore } from '@/store/authStore';
import { errorMessage, toApiError } from '@/api/client';
import { cn } from '@/utils/cn';
import {
  draftFromRule,
  emptyDraft,
  rulesApi,
  type RuleActionDefinition,
  type RuleDraft,
  type RuleGuardrails,
  type RuleSummary,
} from '@/api/rules.api';

type TabId = 'rules' | 'log';

export function AutomationPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const hasCapability = useAuthStore((state) => state.hasCapability);

  const canAuthor = hasCapability(CAPABILITIES.CONFIG_ADMIN);

  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [guardrails, setGuardrails] = useState<RuleGuardrails | null>(null);
  const [catalogue, setCatalogue] = useState<RuleActionDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lintIssues, setLintIssues] = useState<ConfigLintIssue[]>([]);

  const tab: TabId = searchParams.get('tab') === 'log' ? 'log' : 'rules';
  const selectedSlug = searchParams.get('rule');

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (value === null) next.delete(key);
      else next.set(key, value);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // ── loading ───────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [listResult, catalogueResult] = await Promise.all([
        rulesApi.list({ withHealth: true, healthWindowDays: 30 }),
        rulesApi.actions(),
      ]);
      setRules(listResult.rules);
      setGuardrails(listResult.guardrails ?? catalogueResult.guardrails);
      setCatalogue(catalogueResult.actions);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => rules.find((rule) => rule.slug === selectedSlug) ?? null,
    [rules, selectedSlug],
  );

  // Opening a rule loads its stored description — the read model does not carry
  // it, and an editor that silently blanks a description on save would be a
  // quiet way to lose the only prose anybody wrote about the rule.
  useEffect(() => {
    if (!selected) {
      if (!isNew) setDraft(null);
      return;
    }
    let alive = true;
    setIsNew(false);
    setLintIssues([]);
    setDraft(draftFromRule(selected));
    rulesApi
      .configObject(selected.slug)
      .then((object) => {
        if (alive && object?.description) {
          setDraft((current) =>
            current && current.slug === selected.slug
              ? { ...current, description: object.description ?? '' }
              : current,
          );
        }
      })
      .catch(() => {
        // Read-only enrichment. Its absence must not block editing.
      });
    return () => {
      alive = false;
    };
    // `isNew` is intentionally excluded: creating a rule must not be undone by
    // this effect the moment the list refreshes underneath it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // ── mutations ─────────────────────────────────────────────────────────────

  async function handleReorder(order: string[]) {
    setBusy(true);
    try {
      const result = await rulesApi.reorder(order);
      setRules(result.rules);
      const refused = result.outcomes.filter((outcome) => !outcome.applied);
      if (refused.length > 0) {
        toast.error(
          t('rules.reorderPartial', '{{count}} règle(s) n’ont pas pu être déplacées : {{slugs}}', {
            count: refused.length,
            slugs: refused.map((outcome) => outcome.slug).join(', '),
          }),
        );
      } else {
        toast.success(t('rules.reorderDone', 'Nouvel ordre appliqué'));
      }
    } catch (error) {
      toast.error(errorMessage(error));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(slug: string, enabled: boolean) {
    setBusy(true);
    try {
      await rulesApi.setEnabled(slug, enabled);
      toast.success(
        enabled
          ? t('rules.enabledToast', 'Règle activée')
          : t('rules.disabledToast', 'Règle désactivée'),
      );
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleResetBreaker(slug: string) {
    try {
      await rulesApi.resetBreaker(slug);
      toast.success(t('rules.breakerReset', 'Coupe-circuit réarmé'));
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  function handleCreate() {
    setIsNew(true);
    setLintIssues([]);
    setDraft({ ...emptyDraft(), order: (rules.length + 1) * 10 });
    setParam('rule', null);
  }

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setLintIssues([]);
    try {
      await rulesApi.save(draft, { create: isNew, note: t('rules.savedFromUi', 'Modifiée depuis l’écran Automatisation') });
      toast.success(
        isNew ? t('rules.createdToast', 'Règle créée et publiée') : t('rules.savedToast', 'Règle publiée'),
      );
      // A new field or queue referenced by the rule may have arrived with it.
      invalidateFieldCatalogue();
      setIsNew(false);
      await load();
      setParam('rule', draft.slug);
    } catch (error) {
      const apiError = toApiError(error);
      const issues = apiError.payload?.issues;
      if (Array.isArray(issues)) {
        // The findings ARE the answer, so they stay on screen next to the draft
        // rather than flashing past in a toast.
        setLintIssues(issues as ConfigLintIssue[]);
        toast.error(t('rules.lintBlocked', 'Publication refusée : voir les remarques ci-dessus.'));
      } else {
        toast.error(errorMessage(apiError));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive() {
    if (!draft || isNew) return;
    setSaving(true);
    try {
      await rulesApi.archive(draft.slug);
      toast.success(t('rules.archivedToast', 'Règle archivée : son historique est conservé.'));
      setDraft(null);
      setParam('rule', null);
      await load();
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

  const tabs: Array<{ id: TabId; label: string; icon: typeof Workflow }> = [
    { id: 'rules', label: t('automation.tabRules', 'Règles'), icon: Workflow },
    { id: 'log', label: t('automation.tabLog', 'Journal d’exécution'), icon: History },
  ];

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-5">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
            {t('automation.title', 'Automatisation')}
          </h1>
          <p className="mt-0.5 max-w-2xl text-sm text-text-muted">
            {t(
              'automation.subtitle',
              'Une seule liste ordonnée : les règles s’appliquent de haut en bas à chaque événement. L’ordre est la logique, et le journal en dessous dit ce qui s’est réellement passé.',
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={13} />}
            onClick={() => void load()}
            disabled={busy}
          >
            {t('common.refresh', 'Actualiser')}
          </Button>
          {canAuthor && tab === 'rules' && (
            <Button size="sm" variant="secondary" icon={<Plus size={13} />} onClick={handleCreate}>
              {t('rules.create', 'Nouvelle règle')}
            </Button>
          )}
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

      {tab === 'rules' ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(380px,440px)_1fr]">
          <div>
            <RuleList
              rules={rules}
              guardrails={guardrails}
              selectedSlug={selectedSlug}
              busy={busy}
              onSelect={(slug) => {
                setIsNew(false);
                setParam('rule', slug);
              }}
              onReorder={handleReorder}
              onToggle={handleToggle}
              onResetBreaker={handleResetBreaker}
              onCreate={canAuthor ? handleCreate : undefined}
            />
          </div>

          <div className="min-w-0">
            {draft ? (
              <RuleEditor
                draft={draft}
                onChange={setDraft}
                actionCatalogue={catalogue}
                guardrails={guardrails}
                isNew={isNew}
                readOnly={!canAuthor || (selected?.shared ?? false)}
                saving={saving}
                lintIssues={lintIssues}
                onSave={handleSave}
                onCancel={() => {
                  setDraft(null);
                  setIsNew(false);
                  setLintIssues([]);
                  setParam('rule', null);
                }}
                onDelete={canAuthor ? handleArchive : undefined}
                onOpenTicket={(ticketId) => navigate(`/tickets/${ticketId}`)}
              />
            ) : (
              <div className="rounded-lg bg-bg-secondary/60 px-4 py-10 text-center">
                <Workflow size={26} className="mx-auto text-text-muted" />
                <p className="mt-2 text-[13.5px] text-text-primary">
                  {t('automation.pickRule', 'Choisissez une règle dans la liste')}
                </p>
                <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-text-muted">
                  {t(
                    'automation.pickRuleHelp',
                    'La position dans la liste décide de l’ordre d’exécution. Ouvrez une règle pour voir sa condition, ses actions, et pour la simuler sur vos vrais tickets avant de la publier.',
                  )}
                </p>
                {!canAuthor && (
                  <p className="mx-auto mt-2 max-w-md text-[12px] text-text-muted">
                    {t(
                      'automation.readOnlyNotice',
                      'Vous pouvez lire, réordonner et activer les règles. La publication demande la capacité « administration de la configuration ».',
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <ExecutionLog
          rules={rules}
          initialRuleSlug={selectedSlug}
          onOpenTicket={(ticketId) => navigate(`/tickets/${ticketId}`)}
        />
      )}
    </div>
  );
}

export default AutomationPage;
