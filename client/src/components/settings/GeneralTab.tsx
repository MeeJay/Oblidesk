/**
 * GeneralTab — the tenant's behaviour, resolved through the settings ladder.
 *
 * `GET /api/settings` returns every key with the value held at EACH level
 * (default → platform → tenant) plus which level actually supplied it. That is
 * what makes "hérité" a real badge and not decoration: the reader can see that
 * a value came from the installation default, and reverting is a DELETE of the
 * tenant row rather than a write of the inherited value. Writing it would PIN
 * the current default, so a later change to installation policy would never
 * reach this tenant again — a bug that only shows up months later.
 *
 * Each field autosaves on its own (hard rule 12). Nothing here validates
 * required-ness: these are settings, not a state transition.
 *
 * The security block at the bottom is INSTALLATION policy, not tenant policy,
 * and is shown only to a platform admin — `PUT /api/admin/config/security`.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Lock, RotateCcw, ShieldCheck } from 'lucide-react';
import apiClient from '@/api/client';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/utils/cn';

type SettingValueType = 'number' | 'boolean' | 'string' | 'json';
type SettingSource = 'default' | 'global' | 'tenant';

interface SettingDefinition {
  key: string;
  type: SettingValueType;
  default: unknown;
  label: string;
  description: string;
  group: string;
  min?: number;
  max?: number;
  platformOnly?: boolean;
  choices?: string[];
}

interface ResolvedSetting {
  key: string;
  value: unknown;
  source: SettingSource;
  defaultValue: unknown;
  globalValue?: unknown;
  tenantValue?: unknown;
  definition: SettingDefinition;
}

interface AppConfig {
  allow2fa: boolean;
  force2fa: boolean;
  otpSmtpServerId: number | null;
}

const GROUP_LABELS: Record<string, { key: string; fallback: string }> = {
  desk: { key: 'settings.group.desk', fallback: 'Comportement du bureau' },
  sla: { key: 'settings.group.sla', fallback: 'SLA' },
  mail: { key: 'settings.group.mail', fallback: 'Courrier entrant et sortant' },
  notifications: { key: 'settings.group.notifications', fallback: 'Notifications' },
  portal: { key: 'settings.group.portal', fallback: 'Portail demandeur' },
  security: { key: 'settings.group.security', fallback: 'Sécurité' },
  ai: { key: 'settings.group.ai', fallback: 'IA' },
  retention: { key: 'settings.group.retention', fallback: 'Rétention' },
};

const GROUP_ORDER = ['desk', 'sla', 'mail', 'notifications', 'portal', 'security', 'ai', 'retention'];

function serverError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

export function GeneralTab({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();

  const [settings, setSettings] = useState<Record<string, ResolvedSetting>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ success: true; data: Record<string, ResolvedSetting> }>('/settings');
      setSettings(res.data.data);
    } catch (err) {
      toast.error(serverError(err, t('settings.loadFailed', 'Impossible de charger les paramètres.')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isAdmin) return;
    apiClient
      .get<{ success: true; data: AppConfig }>('/admin/config')
      .then((res) => setAppConfig(res.data.data))
      .catch(() => {});
  }, [isAdmin]);

  /** One key, one write. A failed write reloads so the screen never lies. */
  async function writeSetting(key: string, value: unknown) {
    setSavingKey(key);
    try {
      const res = await apiClient.put<{ success: true; data: ResolvedSetting }>(
        `/settings/${encodeURIComponent(key)}`,
        { value },
      );
      setSettings((prev) => ({ ...prev, [key]: res.data.data }));
    } catch (err) {
      toast.error(serverError(err, t('settings.saveFailed', "L'enregistrement a échoué.")));
      await load();
    } finally {
      setSavingKey(null);
    }
  }

  /** Revert = delete the tenant row, restoring inheritance. See the header. */
  async function revertSetting(key: string) {
    setSavingKey(key);
    try {
      const res = await apiClient.delete<{ success: true; data: ResolvedSetting }>(
        `/settings/${encodeURIComponent(key)}`,
      );
      setSettings((prev) => ({ ...prev, [key]: res.data.data }));
      toast.success(t('settings.reverted', 'Valeur héritée rétablie.'));
    } catch (err) {
      toast.error(serverError(err, t('settings.revertFailed', 'Le rétablissement a échoué.')));
    } finally {
      setSavingKey(null);
    }
  }

  async function patchSecurity(patch: Partial<AppConfig>) {
    const next = { ...(appConfig ?? { allow2fa: false, force2fa: false, otpSmtpServerId: null }), ...patch };
    setAppConfig(next);
    try {
      await apiClient.put('/admin/config/security', patch);
    } catch (err) {
      toast.error(serverError(err, t('settings.securityFailed', "La politique n'a pas pu être enregistrée.")));
      const res = await apiClient.get<{ success: true; data: AppConfig }>('/admin/config');
      setAppConfig(res.data.data);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  const entries = Object.values(settings);
  const groups = GROUP_ORDER.filter((group) => entries.some((entry) => entry.definition.group === group));

  return (
    <div className="space-y-5">
      {groups.map((group) => {
        const label = GROUP_LABELS[group] ?? { key: `settings.group.${group}`, fallback: group };
        const rows = entries.filter((entry) => entry.definition.group === group);

        return (
          <section key={group} className="space-y-3 rounded-card bg-bg-secondary p-5 shadow-card">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
              {t(label.key, label.fallback)}
            </h2>

            <div className="space-y-2">
              {rows.map((entry) => (
                <SettingRow
                  key={entry.key}
                  entry={entry}
                  isAdmin={isAdmin}
                  saving={savingKey === entry.key}
                  onWrite={(value) => void writeSetting(entry.key, value)}
                  onRevert={() => void revertSetting(entry.key)}
                />
              ))}
            </div>
          </section>
        );
      })}

      {/* ── Installation security policy ─────────────────────────────────── */}
      {isAdmin && appConfig && (
        <section className="space-y-3 rounded-card bg-bg-secondary p-5 shadow-card">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
              <ShieldCheck size={15} className="text-accent" />
              {t('settings.securityTitle', "Politique d'authentification")}
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">
              {t(
                'settings.securityDesc',
                "S'applique à toute l'installation, pas seulement à cette organisation.",
              )}
            </p>
          </div>

          <SwitchRow
            label={t('settings.allow2fa', 'Autoriser la double authentification')}
            description={t(
              'settings.allow2faDesc',
              "Lorsqu'elle est désactivée, personne ne peut enrôler de second facteur.",
            )}
            checked={appConfig.allow2fa}
            onChange={(next) =>
              void patchSecurity(next ? { allow2fa: true } : { allow2fa: false, force2fa: false })
            }
          />
          <SwitchRow
            label={t('settings.force2fa', 'Exiger la double authentification')}
            description={t(
              'settings.force2faDesc',
              "Les comptes sans second facteur sont dirigés vers l'assistant d'enrôlement à la connexion.",
            )}
            checked={appConfig.force2fa}
            disabled={!appConfig.allow2fa}
            onChange={(next) => void patchSecurity({ force2fa: next })}
          />
        </section>
      )}
    </div>
  );
}

// ── One setting ──────────────────────────────────────────────────────────────

function SettingRow({
  entry,
  isAdmin,
  saving,
  onWrite,
  onRevert,
}: {
  entry: ResolvedSetting;
  isAdmin: boolean;
  saving: boolean;
  onWrite: (value: unknown) => void;
  onRevert: () => void;
}) {
  const { t } = useTranslation();
  const definition = entry.definition;
  const locked = Boolean(definition.platformOnly) && !isAdmin;
  const overridden = entry.tenantValue !== undefined && entry.tenantValue !== null;

  // Local draft for the free-text and numeric controls, so a half-typed value
  // is not written on every keystroke; committed on blur or Enter.
  const [draft, setDraft] = useState(() => String(entry.value ?? ''));
  useEffect(() => {
    setDraft(String(entry.value ?? ''));
  }, [entry.value]);

  const inputClass =
    'w-40 rounded-md bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50';

  function commit() {
    if (definition.type === 'number') {
      const parsed = Number(draft);
      if (!Number.isFinite(parsed)) {
        setDraft(String(entry.value ?? ''));
        return;
      }
      if (parsed !== entry.value) onWrite(parsed);
    } else if (draft !== entry.value) {
      onWrite(draft);
    }
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded-card bg-bg-tertiary px-3 py-2.5">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-text-primary">
          {t(`setting.${definition.key}`, definition.label)}
          {entry.source !== 'tenant' && (
            <span
              title={t('settings.inheritedFrom', 'Valeur héritée de {{source}}', { source: entry.source })}
              className="rounded-pill bg-bg-active px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted"
            >
              {entry.source === 'default'
                ? t('settings.sourceDefault', 'défaut')
                : t('settings.sourceGlobal', 'plateforme')}
            </span>
          )}
          {locked && (
            <span
              title={t('settings.platformOnly', "Réservé à l'administrateur de la plateforme")}
              className="text-text-muted"
            >
              <Lock size={11} />
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-text-muted">
          {t(`setting.${definition.key}.desc`, definition.description)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {definition.type === 'boolean' ? (
          <Switch
            checked={entry.value === true}
            disabled={locked || saving}
            onChange={(next) => onWrite(next)}
          />
        ) : definition.choices && definition.choices.length > 0 ? (
          <select
            value={String(entry.value ?? '')}
            disabled={locked || saving}
            onChange={(event) => onWrite(event.target.value)}
            className={inputClass}
          >
            {definition.choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        ) : (
          <input
            type={definition.type === 'number' ? 'number' : 'text'}
            value={draft}
            min={definition.min}
            max={definition.max}
            disabled={locked || saving}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            className={cn(inputClass, 'font-mono text-right')}
          />
        )}

        <button
          type="button"
          title={t('settings.revert', 'Rétablir la valeur héritée')}
          onClick={onRevert}
          disabled={!overridden || locked || saving}
          className={cn(
            'rounded-md p-1.5 transition-colors',
            overridden && !locked
              ? 'text-text-muted hover:bg-bg-hover hover:text-text-primary'
              : 'invisible',
          )}
        >
          <RotateCcw size={13} />
        </button>
      </div>
    </div>
  );
}

// ── Switch primitives ────────────────────────────────────────────────────────

function Switch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-pill transition-colors disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-bg-active',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all',
          checked ? 'left-[1.125rem]' : 'left-0.5',
        )}
      />
    </button>
  );
}

function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-card bg-bg-tertiary px-3 py-2.5">
      <div>
        <p className="text-sm text-text-primary">{label}</p>
        {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
      </div>
      <Switch checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );
}

export default GeneralTab;
