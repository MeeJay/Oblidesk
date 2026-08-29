/**
 * SettingsPage — `/settings`
 *
 * Five tabs, split along the line that actually matters — WHO the setting
 * belongs to:
 *
 *   Général    the tenant's behaviour (auto-close, SLA thresholds, retention…)
 *   Apparence  this person's own preferences — nobody else sees them
 *   SMTP       the installation's mail servers
 *   SSO        the Obligate gateway
 *   IA         the AI provider and its budget
 *
 * The last three are platform administration and are hidden — not merely
 * disabled — for a non-admin: a tab that opens onto a 403 is worse than a tab
 * that was never offered.
 *
 * The active tab lives in `?tab=`, so a link to "the SMTP settings" is a real
 * link and a reload does not dump the reader back on the first tab.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bot, Palette, Server, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import apiClient from '@/api/client';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { GeneralTab } from '@/components/settings/GeneralTab';
import { AppearanceTab } from '@/components/settings/AppearanceTab';
import { SmtpTab } from '@/components/settings/SmtpTab';
import { ObligateSsoTab } from '@/components/settings/ObligateSsoTab';
import { AiTab } from '@/components/settings/AiTab';
import { cn } from '@/utils/cn';

type TabId = 'general' | 'appearance' | 'smtp' | 'sso' | 'ai';

const PLATFORM_TABS: TabId[] = ['smtp', 'sso', 'ai'];

export function SettingsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<{ success: true; data: { isAdmin: boolean } }>('/profile')
      .then((res) => setIsAdmin(res.data.data.isAdmin === true))
      .catch(() => setIsAdmin(false))
      .finally(() => setLoading(false));
  }, []);

  const tabs = useMemo(
    () =>
      (
        [
          { id: 'general' as const, label: t('settings.tabGeneral', 'Général'), icon: SlidersHorizontal },
          { id: 'appearance' as const, label: t('settings.tabAppearance', 'Apparence'), icon: Palette },
          { id: 'smtp' as const, label: t('settings.tabSmtp', 'SMTP'), icon: Server },
          { id: 'sso' as const, label: t('settings.tabSso', 'SSO Obligate'), icon: ShieldCheck },
          { id: 'ai' as const, label: t('settings.tabAi', 'IA'), icon: Bot },
        ] as const
      ).filter((tab) => isAdmin || !PLATFORM_TABS.includes(tab.id)),
    [isAdmin, t],
  );

  const requested = searchParams.get('tab') as TabId | null;
  const active: TabId = tabs.some((tab) => tab.id === requested) ? (requested as TabId) : 'general';

  function selectTab(id: TabId) {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
          {t('settings.pageTitle', 'Paramètres')}
        </h1>
        <p className="mt-0.5 text-sm text-text-muted">
          {t('settings.pageDesc', "Le comportement du bureau, votre confort et les intégrations de l'installation.")}
        </p>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-border" role="tablist">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => selectTab(tab.id)}
              className={cn(
                'relative flex items-center gap-1.5 px-3.5 py-2 text-sm transition-colors',
                selected ? 'text-accent' : 'text-text-secondary hover:text-text-primary',
              )}
            >
              <Icon size={14} />
              {tab.label}
              {selected && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
            </button>
          );
        })}
      </nav>

      <div role="tabpanel">
        {active === 'general' && <GeneralTab isAdmin={isAdmin} />}
        {active === 'appearance' && <AppearanceTab />}
        {active === 'smtp' && <SmtpTab />}
        {active === 'sso' && <ObligateSsoTab />}
        {active === 'ai' && <AiTab />}
      </div>
    </div>
  );
}

export default SettingsPage;
