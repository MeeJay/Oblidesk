/**
 * AiTab — the AI provider, its budget and which features may use it.
 *
 * Three things this screen is careful about:
 *
 *  • The API key is write-only. The server returns `apiKeySet` and never the
 *    secret, so a blank field means "keep the stored key"; clearing one is an
 *    explicit button that sends `apiKey: null`.
 *
 *  • The budget is a HARD ceiling in USD, not a warning — the engine refuses
 *    past it. The copy says so, because an operator who reads "budget" as
 *    "alert threshold" will set it far too high.
 *
 *  • The feature switches are listed individually rather than hidden behind
 *    the master switch, so turning AI on does not silently enable draft
 *    replies on a desk that never asked for them. Every one of them is off
 *    until someone says otherwise.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Bot, Eye, EyeOff, KeyRound, Wallet } from 'lucide-react';
import type { AiConfig } from '@oblidesk/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Toggle } from '@/components/common/Toggle';
import { cn } from '@/utils/cn';

type Provider = AiConfig['provider'];
type FeatureKey = keyof AiConfig['features'];

const PROVIDERS: Provider[] = ['none', 'anthropic', 'openai', 'azure', 'local'];

const FEATURES: Array<{ key: FeatureKey; labelKey: string; label: string; descKey: string; desc: string }> = [
  {
    key: 'summarize',
    labelKey: 'ai.featureSummarize',
    label: 'Résumer un ticket',
    descKey: 'ai.featureSummarizeDesc',
    desc: 'Condense un long fil de journal pour la prise en main.',
  },
  {
    key: 'draftReply',
    labelKey: 'ai.featureDraftReply',
    label: 'Proposer une réponse',
    descKey: 'ai.featureDraftReplyDesc',
    desc: "Rédige un brouillon de réponse publique, jamais envoyé sans relecture.",
  },
  {
    key: 'suggestKb',
    labelKey: 'ai.featureSuggestKb',
    label: 'Suggérer des articles',
    descKey: 'ai.featureSuggestKbDesc',
    desc: 'Rapproche le ticket des articles de la base de connaissances.',
  },
  {
    key: 'triage',
    labelKey: 'ai.featureTriage',
    label: 'Aider au tri',
    descKey: 'ai.featureTriageDesc',
    desc: 'Propose une file, une catégorie et une priorité à la création.',
  },
  {
    key: 'dedupe',
    labelKey: 'ai.featureDedupe',
    label: 'Détecter les doublons',
    descKey: 'ai.featureDedupeDesc',
    desc: 'Signale les tickets ouverts qui décrivent le même incident.',
  },
];

function serverError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

export function AiTab() {
  const { t } = useTranslation();

  const [config, setConfig] = useState<AiConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [model, setModel] = useState('');
  const [budget, setBudget] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ success: true; data: AiConfig }>('/admin/config/ai');
      setConfig(res.data.data);
      setModel(res.data.data.model ?? '');
      setBudget(res.data.data.monthlyBudgetUsd === null ? '' : String(res.data.data.monthlyBudgetUsd));
      setApiKey('');
    } catch (err) {
      toast.error(serverError(err, t('ai.loadFailed', "Impossible de charger la configuration IA.")));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>, quiet = false) {
    setSaving(true);
    try {
      const res = await apiClient.put<{ success: true; data: AiConfig }>('/admin/config/ai', body);
      setConfig(res.data.data);
      setModel(res.data.data.model ?? '');
      setBudget(res.data.data.monthlyBudgetUsd === null ? '' : String(res.data.data.monthlyBudgetUsd));
      setApiKey('');
      if (!quiet) toast.success(t('ai.saved', 'Configuration IA enregistrée.'));
    } catch (err) {
      toast.error(serverError(err, t('ai.saveFailed', "L'enregistrement a échoué.")));
    } finally {
      setSaving(false);
    }
  }

  function save() {
    const trimmedBudget = budget.trim();
    const parsedBudget = trimmedBudget === '' ? null : Number(trimmedBudget);
    if (parsedBudget !== null && (!Number.isFinite(parsedBudget) || parsedBudget < 0)) {
      toast.error(t('ai.invalidBudget', 'Le budget doit être un nombre positif, ou vide.'));
      return;
    }

    void patch({
      model: model.trim() || null,
      monthlyBudgetUsd: parsedBudget,
      // Omitted when blank: an empty field means "keep the stored key".
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  if (!config) return null;

  const usable = config.provider !== 'none' && config.apiKeySet;

  return (
    <div className="space-y-5">
      {/* ── Provider ─────────────────────────────────────────────────────── */}
      <section className="space-y-4 rounded-card bg-bg-secondary p-5 shadow-card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
              <Bot size={15} className="text-accent" />
              {t('ai.title', 'Assistance par IA')}
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">
              {t(
                'ai.desc',
                "Aucune suggestion n'est envoyée à un demandeur sans relecture d'un agent : l'IA propose, elle ne décide pas.",
              )}
            </p>
          </div>

          <Toggle
            checked={config.enabled}
            onChange={(next) => void patch({ enabled: next }, true)}
            disabled={saving || (!config.enabled && !usable)}
            disabledReason={
              !config.enabled && !usable
                ? t('ai.cannotEnable', "Choisissez un fournisseur et enregistrez une clé avant d'activer.")
                : t('common.saving', 'Enregistrement…')
            }
            aria-label={t('ai.enable', "Activer l'assistance par IA")}
            className="mt-1 shrink-0"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="block text-sm font-medium text-text-secondary">
              {t('ai.provider', 'Fournisseur')}
            </span>
            <select
              value={config.provider}
              onChange={(event) => void patch({ provider: event.target.value as Provider }, true)}
              className="w-full rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {provider === 'none' ? t('ai.providerNone', 'Aucun') : provider}
                </option>
              ))}
            </select>
          </label>

          <Input
            label={t('ai.model', 'Modèle')}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={t('ai.modelPlaceholder', 'Identifiant du modèle chez le fournisseur')}
            className="font-mono"
          />
        </div>

        <div className="space-y-1">
          <span className="flex items-center gap-1.5 text-sm font-medium text-text-secondary">
            <KeyRound size={13} />
            {t('ai.apiKey', "Clé d'API")}
          </span>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                config.apiKeySet
                  ? t('ai.apiKeyStored', 'Une clé est enregistrée : laisser vide pour la conserver')
                  : t('ai.apiKeyNone', 'Aucune clé enregistrée')
              }
              autoComplete="off"
              className="w-full rounded-md bg-bg-tertiary px-3 py-2 pr-9 font-mono text-sm text-text-primary placeholder:font-sans placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              type="button"
              onClick={() => setShowKey((prev) => !prev)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <span className="flex items-center gap-1.5 text-sm font-medium text-text-secondary">
            <Wallet size={13} />
            {t('ai.budget', 'Plafond mensuel (USD)')}
          </span>
          <input
            type="number"
            min={0}
            step="1"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder={t('ai.budgetNone', 'Sans plafond')}
            className="w-40 rounded-md bg-bg-tertiary px-3 py-2 text-right font-mono text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <p className="text-xs text-text-muted">
            {t(
              'ai.budgetHint',
              "Plafond ferme : le moteur refuse les appels au-delà. Ce n'est pas un simple seuil d'alerte.",
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button size="sm" loading={saving} onClick={save}>
            {t('common.save', 'Enregistrer')}
          </Button>
          {config.apiKeySet && (
            <button
              type="button"
              onClick={() => {
                if (confirm(t('ai.confirmClearKey', "Effacer la clé d'API enregistrée ?"))) {
                  void patch({ apiKey: null, enabled: false });
                }
              }}
              className="text-xs text-text-muted transition-colors hover:text-status-cancelled"
            >
              {t('ai.clearKey', 'Effacer la clé')}
            </button>
          )}
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <section className="space-y-2 rounded-card bg-bg-secondary p-5 shadow-card">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
            {t('ai.features', 'Fonctions activées')}
          </h2>
          <p className="mt-0.5 text-xs text-text-muted">
            {t('ai.featuresDesc', "Chaque fonction s'active séparément, même quand l'IA est disponible.")}
          </p>
        </div>

        {FEATURES.map((feature) => {
          const checked = config.features[feature.key] === true;
          return (
            <Toggle
              key={feature.key}
              checked={checked}
              onChange={(next) => void patch({ features: { [feature.key]: next } }, true)}
              disabled={!config.enabled || saving}
              disabledReason={
                !config.enabled
                  ? t('ai.featureNeedsEnabled', "Activez l'assistance par IA pour utiliser cette fonction.")
                  : t('common.saving', 'Enregistrement…')
              }
              labelFirst
              label={t(feature.labelKey, feature.label)}
              description={t(feature.descKey, feature.desc)}
              className={cn(
                'w-full gap-4 rounded-card bg-bg-tertiary px-3 py-2.5 transition-colors',
                config.enabled ? 'hover:bg-bg-hover' : 'opacity-50',
              )}
            />
          );
        })}
      </section>
    </div>
  );
}

export default AiTab;
