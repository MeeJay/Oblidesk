/**
 * ObligateSsoTab — the Obligate SSO gateway.
 *
 * The API key is write-only. `GET /admin/config/obligate` returns
 * `apiKeySet: boolean` and never the secret, so this form leaves the field
 * blank on load, and an EMPTY field means "keep the stored key". Clearing a
 * key is therefore an explicit act (the "Effacer la clé" button sends
 * `apiKey: null`) rather than the accidental result of correcting the URL.
 *
 * Reachability is a probe, not a stored fact: `POST /obligate/test` asks the
 * gateway's `/health` right now. It is offered next to the switch because
 * enabling SSO against an unreachable gateway is exactly the mistake that
 * locks an operator out of their own desk — and the login page only shows the
 * SSO button when the same probe comes back reachable.
 *
 * Tenant mapping between the two apps is BY SLUG (hard rule 13); nothing on
 * this screen exposes a numeric tenant id, on purpose.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { CheckCircle2, Eye, EyeOff, KeyRound, Link2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import type { ObligateConfig } from '@oblidesk/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Toggle } from '@/components/common/Toggle';
import { cn } from '@/utils/cn';

interface SsoProbe {
  obligateUrl: string | null;
  obligateReachable: boolean;
  obligateEnabled: boolean;
}

function serverError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

export function ObligateSsoTab() {
  const { t } = useTranslation();

  const [config, setConfig] = useState<ObligateConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  const [probe, setProbe] = useState<SsoProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ success: true; data: ObligateConfig }>('/admin/config/obligate');
      setConfig(res.data.data);
      setUrl(res.data.data.url ?? '');
      setApiKey('');
    } catch (err) {
      toast.error(serverError(err, t('sso.loadFailed', 'Impossible de charger la configuration SSO.')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await apiClient.put<{ success: true; data: ObligateConfig }>('/admin/config/obligate', body);
      setConfig(res.data.data);
      setUrl(res.data.data.url ?? '');
      setApiKey('');
      toast.success(t('sso.saved', 'Configuration enregistrée.'));
    } catch (err) {
      toast.error(serverError(err, t('sso.saveFailed', "L'enregistrement a échoué.")));
    } finally {
      setSaving(false);
    }
  }

  function save() {
    const trimmed = url.trim();
    void patch({
      url: trimmed || null,
      // Omitted when blank: see the header.
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
  }

  async function runProbe() {
    setProbing(true);
    try {
      const res = await apiClient.post<{ success: true; data: SsoProbe }>('/admin/config/obligate/test');
      setProbe(res.data.data);
      if (res.data.data.obligateReachable) {
        toast.success(t('sso.probeOk', 'Obligate répond.'));
      } else {
        toast.error(t('sso.probeDown', 'Obligate ne répond pas.'));
      }
    } catch (err) {
      toast.error(serverError(err, t('sso.probeFailed', 'La vérification a échoué.')));
    } finally {
      setProbing(false);
    }
  }

  async function syncCapabilities() {
    setSyncing(true);
    try {
      await apiClient.post('/admin/config/obligate/sync-capabilities');
      toast.success(t('sso.synced', 'Catalogue de permissions publié vers Obligate.'));
    } catch (err) {
      toast.error(serverError(err, t('sso.syncFailed', 'La publication a échoué.')));
    } finally {
      setSyncing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  const enabled = config?.enabled ?? false;
  const usable = Boolean(config?.url && config?.apiKeySet);

  return (
    <div className="space-y-5">
      {/* ── Gateway ──────────────────────────────────────────────────────── */}
      <section className="space-y-4 rounded-card bg-bg-secondary p-5 shadow-card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
              <ShieldCheck size={15} className="text-accent" />
              {t('sso.title', 'Passerelle Obligate')}
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">
              {t(
                'sso.desc',
                "L'authentification centralisée de la suite Obli. Une fois active, le bouton « Se connecter avec Obligate » apparaît sur la page de connexion.",
              )}
            </p>
          </div>

          <Toggle
            checked={enabled}
            onChange={(next) => void patch({ enabled: next })}
            disabled={saving || (!enabled && !usable)}
            disabledReason={
              !enabled && !usable
                ? t('sso.cannotEnable', "Renseignez l'URL et la clé d'API avant d'activer.")
                : t('common.saving', 'Enregistrement…')
            }
            aria-label={t('sso.enable', 'Activer la connexion via Obligate')}
            className="mt-1 shrink-0"
          />
        </div>

        <Input
          label={t('sso.url', 'URL Obligate')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://obligate.exemple.fr"
          className="font-mono"
        />

        <div className="space-y-1">
          <span className="flex items-center gap-1.5 text-sm font-medium text-text-secondary">
            <KeyRound size={13} />
            {t('sso.apiKey', "Clé d'API de l'application")}
          </span>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                config?.apiKeySet
                  ? t('sso.apiKeyStored', 'Une clé est enregistrée : laisser vide pour la conserver')
                  : t('sso.apiKeyNone', 'Aucune clé enregistrée')
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
          <p className="text-xs text-text-muted">
            {t('sso.apiKeyHint', "La clé est chiffrée au repos et n'est jamais renvoyée au navigateur.")}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <Button size="sm" loading={saving} onClick={save}>
              {t('common.save', 'Enregistrer')}
            </Button>
            <Button size="sm" variant="secondary" loading={probing} onClick={() => void runProbe()}>
              <RefreshCw size={13} className="mr-1" />
              {t('sso.probe', 'Vérifier la connexion')}
            </Button>
          </div>

          {config?.apiKeySet && (
            <button
              type="button"
              onClick={() => {
                if (confirm(t('sso.confirmClearKey', "Effacer la clé d'API enregistrée ?"))) {
                  void patch({ apiKey: null, enabled: false });
                }
              }}
              className="text-xs text-text-muted transition-colors hover:text-status-cancelled"
            >
              {t('sso.clearKey', "Effacer la clé")}
            </button>
          )}
        </div>

        {probe && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-card px-3 py-2.5 text-xs',
              probe.obligateReachable
                ? 'bg-status-resolved-bg text-status-resolved'
                : 'bg-status-cancelled-bg text-status-cancelled',
            )}
          >
            {probe.obligateReachable ? (
              <CheckCircle2 size={14} className="mt-px shrink-0" />
            ) : (
              <XCircle size={14} className="mt-px shrink-0" />
            )}
            <span>
              {probe.obligateReachable
                ? t('sso.probeOkDetail', 'Obligate répond à {{url}}.', { url: probe.obligateUrl ?? '—' })
                : t(
                    'sso.probeDownDetail',
                    "Obligate est injoignable à {{url}}. La connexion locale reste disponible.",
                    { url: probe.obligateUrl ?? '—' },
                  )}
            </span>
          </div>
        )}
      </section>

      {/* ── Capability catalogue ─────────────────────────────────────────── */}
      <section className="space-y-3 rounded-card bg-bg-secondary p-5 shadow-card">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            <Link2 size={15} className="text-accent" />
            {t('sso.catalogTitle', 'Catalogue de permissions')}
          </h2>
          <p className="mt-0.5 text-xs text-text-muted">
            {t(
              'sso.catalogDesc',
              "Publie la liste des permissions d'Oblidesk vers Obligate, pour que les droits se mappent depuis le portail central. La publication est automatique au démarrage ; ce bouton la relance.",
            )}
          </p>
        </div>
        <Button size="sm" variant="secondary" loading={syncing} disabled={!usable} onClick={() => void syncCapabilities()}>
          <RefreshCw size={13} className="mr-1" />
          {t('sso.sync', 'Republier le catalogue')}
        </Button>
        {!usable && (
          <p className="text-xs text-text-muted">
            {t('sso.catalogNeedsConfig', "Renseignez l'URL et la clé d'API pour publier.")}
          </p>
        )}
      </section>
    </div>
  );
}

export default ObligateSsoTab;
