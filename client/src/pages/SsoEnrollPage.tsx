/**
 * SsoEnrollPage — `/sso-enroll`
 *
 * The landing after Obligate provisions a brand-new account here. Everything
 * on it is OPTIONAL and everything writes immediately, because the only thing
 * this screen exists to prevent is an agent appearing in the assignment picker
 * as a bare username.
 *
 * Deliberately absent: a "set a local password" field. Oblidesk has no endpoint
 * that mints a first password for an SSO account — `PUT /api/profile/password`
 * verifies the CURRENT one, and `userService.setPassword` is admin-only. A
 * field that silently no-ops is worse than no field, so the screen says where
 * the password actually lives instead.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExternalLink, UserCircle } from 'lucide-react';
import { SEEDED_LOCALES, type SupportedLocale } from '@oblidesk/shared';
import type { User } from '@oblidesk/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { applyTheme, currentTheme, THEME_OPTIONS, type AppTheme } from '@/utils/theme';
import { cn } from '@/utils/cn';

const LOCALE_LABELS: Record<string, string> = {
  fr: 'Français',
  en: 'English',
};

export function SsoEnrollPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirectTo = searchParams.get('redirect') ?? '/';

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [locale, setLocale] = useState<SupportedLocale>('fr');
  const [theme, setTheme] = useState<AppTheme>(currentTheme);
  const [obligateUrl, setObligateUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiClient
      .get<{ success: true; data: { user: User } }>('/profile')
      .then((res) => {
        const user = res.data.data.user;
        setUsername(user.username);
        setDisplayName(user.displayName ?? '');
        if ((SEEDED_LOCALES as readonly string[]).includes(user.preferredLanguage)) {
          setLocale(user.preferredLanguage as SupportedLocale);
        }
      })
      .catch(() => {
        /* The page still works with empty defaults. */
      });

    fetch('/api/auth/sso-config', { credentials: 'include' })
      .then((r) => r.json())
      .then((body: { data?: { obligateUrl: string | null } }) => setObligateUrl(body?.data?.obligateUrl ?? null))
      .catch(() => {});
  }, []);

  function pickTheme(next: AppTheme) {
    setTheme(next);
    applyTheme(next); // Immediate, so the choice is visible while making it.
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');

    try {
      await apiClient.put('/profile', {
        displayName: displayName.trim() || null,
        preferredLanguage: locale,
      });
      await apiClient.put('/profile/preferences', { preferredTheme: theme });
      await i18n.changeLanguage(locale);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(message ?? t('ssoEnroll.failed', "Impossible d'enregistrer ces informations."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-accent/10">
            <UserCircle size={32} className="text-accent" />
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
            {t('ssoEnroll.title', 'Bienvenue sur Oblidesk')}
          </h1>
          <p className="text-sm text-text-secondary">
            {t(
              'ssoEnroll.description',
              'Votre compte a été créé via Obligate. Ces réglages sont optionnels et modifiables plus tard depuis votre profil.',
            )}
          </p>
        </div>

        <form
          onSubmit={(e) => void handleSave(e)}
          className="space-y-5 rounded-card bg-bg-secondary p-6 shadow-card"
        >
          <Input
            label={t('ssoEnroll.displayName', 'Nom affiché')}
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={username || t('ssoEnroll.displayNamePlaceholder', 'Votre nom…')}
            autoFocus
          />

          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-text-secondary">
              {t('ssoEnroll.language', 'Langue')}
            </span>
            <div className="flex gap-2">
              {SEEDED_LOCALES.map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setLocale(code)}
                  className={cn(
                    'flex-1 rounded-pill px-3 py-1.5 text-sm transition-colors',
                    locale === code
                      ? 'bg-accent text-white'
                      : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                  )}
                >
                  {LOCALE_LABELS[code] ?? code}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-text-secondary">
              {t('ssoEnroll.theme', 'Thème')}
            </span>
            <div className="grid grid-cols-2 gap-2">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => pickTheme(option.id as AppTheme)}
                  className={cn(
                    'rounded-card px-3 py-2 text-left text-sm transition-colors',
                    theme === option.id
                      ? 'bg-accent/15 text-accent shadow-card'
                      : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                  )}
                >
                  {option.name}
                </button>
              ))}
            </div>
          </div>

          {obligateUrl && (
            <p className="flex items-start gap-1.5 rounded-card bg-bg-tertiary px-3 py-2 text-xs text-text-muted">
              <ExternalLink size={12} className="mt-0.5 shrink-0" />
              <span>
                {t(
                  'ssoEnroll.passwordManagedByObligate',
                  'Votre mot de passe est géré par Obligate — modifiez-le depuis le portail Obligate.',
                )}
              </span>
            </p>
          )}

          {error && (
            <p className="rounded-card bg-status-cancelled-bg px-3 py-2 text-sm text-status-cancelled">
              {error}
            </p>
          )}

          <div className="flex gap-3">
            <Button type="submit" className="flex-1" loading={saving}>
              {t('common.save', 'Enregistrer')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={() => navigate(redirectTo, { replace: true })}
            >
              {t('common.skip', 'Ignorer')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default SsoEnrollPage;
