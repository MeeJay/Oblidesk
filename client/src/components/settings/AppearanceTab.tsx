/**
 * AppearanceTab — this person's own display preferences.
 *
 * Nothing here is shared: every write goes to `PUT /api/profile/preferences`,
 * which the server deliberately does NOT audit — a hundred rows a day saying
 * "they collapsed the sidebar" would bury the events the ledger exists for.
 *
 * The theme is applied to `<html>` the instant it is picked and only THEN
 * persisted, so the choice is visible while it is being made. The storage key
 * is shared across the whole Obli suite (`STORAGE_KEYS.theme`), which is why a
 * theme picked here is already applied when the same person opens Obliguard.
 */

import { useEffect, useState } from 'react';
import { setLanguage } from '@/i18n';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Check, Languages, Palette } from 'lucide-react';
import { SEEDED_LOCALES, type SupportedLocale } from '@oblidesk/shared';
import type { User, UserPreferences } from '@oblidesk/shared';
import apiClient from '@/api/client';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Toggle } from '@/components/common/Toggle';
import { applyTheme, currentTheme, THEME_OPTIONS, type AppTheme } from '@/utils/theme';
import { cn } from '@/utils/cn';

const LOCALE_LABELS: Record<string, string> = { fr: 'Français', en: 'English' };

function serverError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

export function AppearanceTab() {
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [preferences, setPreferences] = useState<UserPreferences>({});
  const [theme, setTheme] = useState<AppTheme>(currentTheme);
  const [locale, setLocale] = useState<SupportedLocale>('fr');

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ success: true; data: { user: User } }>('/profile')
      .then((res) => {
        if (cancelled) return;
        const user = res.data.data.user;
        setPreferences(user.preferences ?? {});
        if ((SEEDED_LOCALES as readonly string[]).includes(user.preferredLanguage)) {
          setLocale(user.preferredLanguage as SupportedLocale);
        }
      })
      .catch(() => {
        if (!cancelled) toast.error(t('settings.loadFailed', 'Impossible de charger les préférences.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function patch(next: Partial<UserPreferences>) {
    const merged = { ...preferences, ...next };
    setPreferences(merged); // Optimistic — a toggle must not wait on the network.
    try {
      await apiClient.put('/profile/preferences', merged);
    } catch (err) {
      toast.error(serverError(err, t('settings.prefsFailed', "La préférence n'a pas pu être enregistrée.")));
    }
  }

  function pickTheme(next: AppTheme) {
    setTheme(next);
    applyTheme(next);
    void patch({ preferredTheme: next });
  }

  async function pickLocale(next: SupportedLocale) {
    setLocale(next);
    setLanguage(next);
    try {
      await apiClient.put('/profile', { preferredLanguage: next });
    } catch (err) {
      toast.error(serverError(err, t('settings.localeFailed', "La langue n'a pas pu être enregistrée.")));
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Theme ────────────────────────────────────────────────────────── */}
      <section className="space-y-3 rounded-card bg-bg-secondary p-5 shadow-card">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            <Palette size={15} className="text-accent" />
            {t('settings.theme', 'Thème')}
          </h2>
          <p className="mt-0.5 text-xs text-text-muted">
            {t('settings.themeDesc', 'Partagé avec les autres applications Obli de ce navigateur.')}
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => pickTheme(option.id as AppTheme)}
              className={cn(
                'rounded-card px-4 py-3 text-left transition-colors',
                theme === option.id ? 'bg-accent/15 shadow-card' : 'bg-bg-tertiary hover:bg-bg-hover',
              )}
            >
              <span
                className={cn(
                  'flex items-center gap-1.5 text-sm font-medium',
                  theme === option.id ? 'text-accent' : 'text-text-primary',
                )}
              >
                {option.name}
                {theme === option.id && <Check size={13} />}
              </span>
              <span className="mt-0.5 block text-xs text-text-muted">{option.description}</span>
            </button>
          ))}
        </div>
      </section>

      {/* ── Language ─────────────────────────────────────────────────────── */}
      <section className="space-y-3 rounded-card bg-bg-secondary p-5 shadow-card">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            <Languages size={15} className="text-accent" />
            {t('settings.language', 'Langue')}
          </h2>
          <p className="mt-0.5 text-xs text-text-muted">
            {t('settings.languageDesc', "L'interface et les modèles de notification qui vous sont adressés.")}
          </p>
        </div>

        <div className="flex gap-2">
          {SEEDED_LOCALES.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => void pickLocale(code)}
              className={cn(
                'rounded-pill px-4 py-1.5 text-sm transition-colors',
                locale === code
                  ? 'bg-accent text-white'
                  : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              {LOCALE_LABELS[code] ?? code}
            </button>
          ))}
        </div>
      </section>

      {/* ── Density and comfort ──────────────────────────────────────────── */}
      <section className="space-y-2 rounded-card bg-bg-secondary p-5 shadow-card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
          {t('settings.comfort', 'Confort de lecture')}
        </h2>

        <PreferenceSwitch
          label={t('settings.densityCompact', 'Affichage compact')}
          description={t('settings.densityCompactDesc', 'Des lignes plus serrées dans la liste des tickets.')}
          checked={preferences.density === 'compact'}
          onChange={(next) => void patch({ density: next ? 'compact' : 'comfortable' })}
        />
        <PreferenceSwitch
          label={t('settings.expandWorkNotes', 'Déplier les notes internes')}
          description={t('settings.expandWorkNotesDesc', 'Ouvre les notes de travail par défaut dans le journal.')}
          checked={preferences.expandWorkNotes === true}
          onChange={(next) => void patch({ expandWorkNotes: next })}
        />
        <PreferenceSwitch
          label={t('settings.sidebarCollapsed', 'Barre latérale repliée')}
          description={t('settings.sidebarCollapsedDesc', "Démarre avec le panneau des files replié.")}
          checked={preferences.sidebarCollapsed === true}
          onChange={(next) => void patch({ sidebarCollapsed: next })}
        />
        <PreferenceSwitch
          label={t('settings.anonymousMode', 'Mode anonyme')}
          description={t(
            'settings.anonymousModeDesc',
            "Masque les noms des demandeurs. Pratique pour une démonstration ou un partage d'écran.",
          )}
          checked={preferences.anonymousMode === true}
          onChange={(next) => void patch({ anonymousMode: next })}
        />
      </section>

      {/* ── Notifications ────────────────────────────────────────────────── */}
      <section className="space-y-2 rounded-card bg-bg-secondary p-5 shadow-card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
          {t('settings.notifications', "Notifications à l'écran")}
        </h2>

        <PreferenceSwitch
          label={t('settings.toastEnabled', 'Alertes en direct')}
          description={t('settings.toastEnabledDesc', 'Affiche les alertes entrantes en superposition.')}
          checked={preferences.toastEnabled !== false}
          onChange={(next) => void patch({ toastEnabled: next })}
        />
        <PreferenceSwitch
          label={t('settings.soundOnAssignment', "Son à l'affectation")}
          description={t('settings.soundOnAssignmentDesc', 'Un signal sonore quand un ticket vous est affecté.')}
          checked={preferences.soundOnAssignment === true}
          onChange={(next) => void patch({ soundOnAssignment: next })}
        />
        <PreferenceSwitch
          label={t('settings.multiTenant', 'Alertes multi-organisations')}
          description={t(
            'settings.multiTenantDesc',
            "Recevoir les alertes de toutes vos organisations, pas seulement celle active.",
          )}
          checked={preferences.multiTenantNotificationsEnabled === true}
          onChange={(next) => void patch({ multiTenantNotificationsEnabled: next })}
        />

        <div className="flex items-center justify-between gap-4 rounded-card bg-bg-tertiary px-3 py-2.5">
          <div>
            <p className="text-sm text-text-primary">{t('settings.toastPosition', 'Position des alertes')}</p>
            <p className="mt-0.5 text-xs text-text-muted">
              {t('settings.toastPositionDesc', "Où les alertes apparaissent à l'écran.")}
            </p>
          </div>
          <div className="flex gap-1">
            {(['bottom-right', 'top-center'] as const).map((position) => (
              <button
                key={position}
                type="button"
                onClick={() => void patch({ toastPosition: position })}
                className={cn(
                  'rounded-pill px-3 py-1 text-xs transition-colors',
                  (preferences.toastPosition ?? 'bottom-right') === position
                    ? 'bg-accent text-white'
                    : 'bg-bg-active text-text-secondary hover:text-text-primary',
                )}
              >
                {position === 'bottom-right'
                  ? t('settings.positionBottomRight', 'En bas à droite')
                  : t('settings.positionTopCenter', 'En haut au centre')}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

/** One preference row: the shared switch, on the row's own background step. */
function PreferenceSwitch({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Toggle
      checked={checked}
      onChange={onChange}
      labelFirst
      label={label}
      description={description}
      className="w-full gap-4 rounded-card bg-bg-tertiary px-3 py-2.5 transition-colors hover:bg-bg-hover"
    />
  );
}

export default AppearanceTab;
