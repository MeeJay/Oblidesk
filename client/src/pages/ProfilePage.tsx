/**
 * ProfilePage — `/profile`
 *
 * Everything the signed-in person may change about THEMSELVES. Every handler
 * on the server side reads `req.session.userId` and never an id from the body,
 * so there is nothing on this page that could act on another account.
 *
 * Three write shapes, deliberately kept apart:
 *   PUT /api/profile              identity — name, e-mail, language
 *   PUT /api/profile/preferences  UI state — theme, density, sounds (unaudited)
 *   PUT /api/profile/password     credential — verifies the current one first
 *
 * The preference block autosaves on change (rule 12: an inline edit saves
 * itself and never validates required-ness); identity and password are
 * explicit, because a half-typed e-mail should not be persisted keystroke by
 * keystroke.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  Building2,
  Check,
  KeyRound,
  Mail,
  Palette,
  ShieldCheck,
  Trash2,
  User as UserIcon,
  Users,
} from 'lucide-react';
import { SEEDED_LOCALES, capabilityLabel, type Capability, type SupportedLocale } from '@oblidesk/shared';
import type { Tenant, TenantMembership, User, UserPreferences, UserRole } from '@oblidesk/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { applyTheme, currentTheme, THEME_OPTIONS, type AppTheme } from '@/utils/theme';
import { cn } from '@/utils/cn';

const LOCALE_LABELS: Record<string, string> = { fr: 'Français', en: 'English' };

interface ProfilePayload {
  user: User;
  tenant: Tenant | null;
  tenants: TenantMembership[];
  role: UserRole;
  capabilities: Capability[];
  teams: Array<{ id: number; name: string }>;
  isAdmin: boolean;
  isMasterTenant: boolean;
}

interface TwoFactorStatus {
  totpEnabled: boolean;
  emailOtpEnabled: boolean;
  email: string | null;
  allowed: boolean;
  forced: boolean;
}

interface TotpEnrolment {
  secret: string;
  uri: string;
  qrDataUrl: string;
}

function serverError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

// ── Section shell — a card, no border (design system §2 / hard rule 11) ──────

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-card bg-bg-secondary p-5 shadow-card">
      <header className="flex items-start gap-2">
        <span className="mt-0.5 text-accent">{icon}</span>
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

function Toggle({
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
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 rounded-card bg-bg-tertiary px-3 py-2.5 text-left transition-colors hover:bg-bg-hover"
    >
      <span>
        <span className="block text-sm text-text-primary">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-text-muted">{description}</span>}
      </span>
      <span
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-pill transition-colors',
          checked ? 'bg-accent' : 'bg-bg-active',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all',
            checked ? 'left-[1.125rem]' : 'left-0.5',
          )}
        />
      </span>
    </button>
  );
}

export function ProfilePage() {
  const { t, i18n } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ProfilePayload | null>(null);
  const [tfa, setTfa] = useState<TwoFactorStatus | null>(null);

  // Identity
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [locale, setLocale] = useState<SupportedLocale>('fr');
  const [savingIdentity, setSavingIdentity] = useState(false);

  // Preferences
  const [preferences, setPreferences] = useState<UserPreferences>({});
  const [theme, setTheme] = useState<AppTheme>(currentTheme);

  // Password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // 2FA
  const [totp, setTotp] = useState<TotpEnrolment | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [otpEmail, setOtpEmail] = useState('');
  const [otpStage, setOtpStage] = useState<'idle' | 'sent'>('idle');
  const [otpCode, setOtpCode] = useState('');
  const [tfaBusy, setTfaBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    apiClient
      .get<{ success: true; data: ProfilePayload }>('/profile')
      .then((res) => {
        if (cancelled) return;
        const data = res.data.data;
        setProfile(data);
        setDisplayName(data.user.displayName ?? '');
        setEmail(data.user.email ?? '');
        setOtpEmail(data.user.email ?? '');
        setPreferences(data.user.preferences ?? {});
        if ((SEEDED_LOCALES as readonly string[]).includes(data.user.preferredLanguage)) {
          setLocale(data.user.preferredLanguage as SupportedLocale);
        }
      })
      .catch(() => {
        if (!cancelled) toast.error(t('profile.loadFailed', 'Impossible de charger le profil.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    apiClient
      .get<{ success: true; data: TwoFactorStatus }>('/profile/2fa/status')
      .then((res) => {
        if (!cancelled) setTfa(res.data.data);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [t]);

  // ── Identity ──────────────────────────────────────────────────────────────

  async function saveIdentity(event: FormEvent) {
    event.preventDefault();
    setSavingIdentity(true);
    try {
      const res = await apiClient.put<{ success: true; data: User }>('/profile', {
        displayName: displayName.trim() || null,
        email: email.trim() || null,
        preferredLanguage: locale,
      });
      setProfile((prev) => (prev ? { ...prev, user: res.data.data } : prev));
      await i18n.changeLanguage(locale);
      toast.success(t('profile.saved', 'Profil enregistré.'));
    } catch (err) {
      toast.error(serverError(err, t('profile.saveFailed', "L'enregistrement a échoué.")));
    } finally {
      setSavingIdentity(false);
    }
  }

  // ── Preferences — autosave, never blocking ────────────────────────────────

  async function patchPreferences(patch: Partial<UserPreferences>) {
    const next = { ...preferences, ...patch };
    setPreferences(next); // Optimistic: a toggle must not wait on the network.
    try {
      await apiClient.put('/profile/preferences', next);
    } catch {
      toast.error(t('profile.prefsFailed', "La préférence n'a pas pu être enregistrée."));
    }
  }

  function pickTheme(next: AppTheme) {
    setTheme(next);
    applyTheme(next);
    void patchPreferences({ preferredTheme: next });
  }

  // ── Password ──────────────────────────────────────────────────────────────

  async function savePassword(event: FormEvent) {
    event.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error(t('profile.passwordMismatch', 'Les deux mots de passe ne correspondent pas.'));
      return;
    }
    if (newPassword.length < 8) {
      toast.error(t('profile.passwordTooShort', 'Le mot de passe doit contenir au moins 8 caractères.'));
      return;
    }

    setSavingPassword(true);
    try {
      await apiClient.put('/profile/password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success(t('profile.passwordChanged', 'Mot de passe modifié — vos autres sessions sont fermées.'));
    } catch (err) {
      toast.error(serverError(err, t('profile.passwordFailed', 'Le mot de passe actuel est incorrect.')));
    } finally {
      setSavingPassword(false);
    }
  }

  // ── 2FA ───────────────────────────────────────────────────────────────────

  async function runTfa(action: () => Promise<void>, failure: string) {
    setTfaBusy(true);
    try {
      await action();
    } catch (err) {
      toast.error(serverError(err, failure));
    } finally {
      setTfaBusy(false);
    }
  }

  const startTotp = () =>
    runTfa(async () => {
      const res = await apiClient.post<{ success: true; data: TotpEnrolment }>('/profile/2fa/totp/setup');
      setTotp(res.data.data);
      setTotpCode('');
    }, t('profile.totpStartFailed', "Impossible de démarrer l'enrôlement."));

  const enableTotp = () =>
    runTfa(async () => {
      await apiClient.post('/profile/2fa/totp/enable', { code: totpCode });
      setTfa((prev) => (prev ? { ...prev, totpEnabled: true } : prev));
      setTotp(null);
      setTotpCode('');
      toast.success(t('profile.totpEnabled', 'Application authentifiée activée.'));
    }, t('profile.totpInvalid', 'Ce code est invalide.'));

  const disableTotp = () =>
    runTfa(async () => {
      await apiClient.delete('/profile/2fa/totp');
      setTfa((prev) => (prev ? { ...prev, totpEnabled: false } : prev));
      toast.success(t('profile.totpDisabled', 'Application authentifiée désactivée.'));
    }, t('profile.totpDisableFailed', 'La désactivation a échoué.'));

  const sendOtp = () =>
    runTfa(async () => {
      await apiClient.post('/profile/2fa/email/setup', { email: otpEmail.trim() });
      setOtpStage('sent');
      setOtpCode('');
      toast.success(t('profile.otpSent', 'Code envoyé.'));
    }, t('profile.otpSendFailed', "Le code n'a pas pu être envoyé."));

  const enableOtp = () =>
    runTfa(async () => {
      await apiClient.post('/profile/2fa/email/enable', { email: otpEmail.trim(), code: otpCode });
      setTfa((prev) => (prev ? { ...prev, emailOtpEnabled: true, email: otpEmail.trim() } : prev));
      setOtpStage('idle');
      setOtpCode('');
      toast.success(t('profile.otpEnabled', 'Code par e-mail activé.'));
    }, t('profile.otpInvalid', 'Ce code est invalide ou a expiré.'));

  const disableOtp = () =>
    runTfa(async () => {
      await apiClient.delete('/profile/2fa/email');
      setTfa((prev) => (prev ? { ...prev, emailOtpEnabled: false } : prev));
      toast.success(t('profile.otpDisabled', 'Code par e-mail désactivé.'));
    }, t('profile.otpDisableFailed', 'La désactivation a échoué.'));

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const user = profile?.user;
  const managedElsewhere = user?.authSource !== 'local';

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <header>
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-wide text-text-primary">
          <UserIcon size={22} className="text-accent" />
          {t('profile.pageTitle', 'Mon profil')}
        </h1>
        <p className="mt-0.5 text-sm text-text-muted">
          {t('profile.pageDesc', 'Vos informations, votre apparence et votre sécurité.')}
        </p>
      </header>

      {/* ── Identité ─────────────────────────────────────────────────────── */}
      <Section
        icon={<UserIcon size={16} />}
        title={t('profile.sectionIdentity', 'Identité')}
        description={
          managedElsewhere
            ? t('profile.managedByObligate', 'Ce compte est synchronisé depuis Obligate.')
            : undefined
        }
      >
        <form onSubmit={(e) => void saveIdentity(e)} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={t('profile.username', 'Identifiant')}
              value={user?.username ?? ''}
              disabled
              readOnly
            />
            <Input
              label={t('profile.displayName', 'Nom affiché')}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={user?.username ?? ''}
            />
          </div>
          <Input
            label={t('profile.email', 'Adresse e-mail')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="prenom.nom@exemple.fr"
          />

          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-text-secondary">
              {t('profile.language', 'Langue')}
            </span>
            <div className="flex gap-2">
              {SEEDED_LOCALES.map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setLocale(code)}
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
          </div>

          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={savingIdentity}>
              {t('common.save', 'Enregistrer')}
            </Button>
          </div>
        </form>
      </Section>

      {/* ── Apparence et confort ─────────────────────────────────────────── */}
      <Section
        icon={<Palette size={16} />}
        title={t('profile.sectionAppearance', 'Apparence')}
        description={t('profile.appearanceDesc', 'Enregistré immédiatement, pour vous seulement.')}
      >
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

        <div className="space-y-2">
          <Toggle
            label={t('profile.density', 'Affichage compact')}
            description={t('profile.densityDesc', 'Des lignes plus serrées dans la liste des tickets.')}
            checked={preferences.density === 'compact'}
            onChange={(next) => void patchPreferences({ density: next ? 'compact' : 'comfortable' })}
          />
          <Toggle
            label={t('profile.expandWorkNotes', 'Déplier les notes internes')}
            description={t('profile.expandWorkNotesDesc', 'Ouvre les notes de travail par défaut dans le journal.')}
            checked={preferences.expandWorkNotes === true}
            onChange={(next) => void patchPreferences({ expandWorkNotes: next })}
          />
          <Toggle
            label={t('profile.soundOnAssignment', "Son à l'affectation")}
            description={t('profile.soundOnAssignmentDesc', "Un signal sonore quand un ticket vous est affecté.")}
            checked={preferences.soundOnAssignment === true}
            onChange={(next) => void patchPreferences({ soundOnAssignment: next })}
          />
          <Toggle
            label={t('profile.toastEnabled', 'Alertes en direct')}
            description={t('profile.toastEnabledDesc', 'Affiche les alertes entrantes en superposition.')}
            checked={preferences.toastEnabled !== false}
            onChange={(next) => void patchPreferences({ toastEnabled: next })}
          />
          <Toggle
            label={t('profile.multiTenant', 'Alertes multi-organisations')}
            description={t(
              'profile.multiTenantDesc',
              'Recevoir les alertes de toutes vos organisations, pas seulement celle active.',
            )}
            checked={preferences.multiTenantNotificationsEnabled === true}
            onChange={(next) => void patchPreferences({ multiTenantNotificationsEnabled: next })}
          />
        </div>
      </Section>

      {/* ── Mot de passe ─────────────────────────────────────────────────── */}
      {!managedElsewhere && (
        <Section
          icon={<KeyRound size={16} />}
          title={t('profile.sectionPassword', 'Mot de passe')}
          description={t('profile.passwordDesc', 'Le changer ferme vos sessions sur les autres appareils.')}
        >
          <form onSubmit={(e) => void savePassword(e)} className="space-y-4">
            <Input
              label={t('profile.currentPassword', 'Mot de passe actuel')}
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={t('profile.newPassword', 'Nouveau mot de passe')}
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
              <Input
                label={t('profile.confirmPassword', 'Confirmer')}
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm" loading={savingPassword}>
                {t('profile.changePassword', 'Changer le mot de passe')}
              </Button>
            </div>
          </form>
        </Section>
      )}

      {/* ── Sécurité (2FA) ───────────────────────────────────────────────── */}
      {tfa?.allowed && (
        <Section
          icon={<ShieldCheck size={16} />}
          title={t('profile.sectionSecurity', 'Double authentification')}
          description={
            tfa.forced
              ? t('profile.securityForced', 'Votre administrateur exige un second facteur sur ce compte.')
              : t('profile.securityDesc', 'Un second facteur protège votre compte si le mot de passe fuite.')
          }
        >
          {/* TOTP */}
          <div className="space-y-3 rounded-card bg-bg-tertiary p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                  {t('profile.totp', "Application d'authentification")}
                  {tfa.totpEnabled && <Check size={14} className="text-status-resolved" />}
                </p>
                <p className="text-xs text-text-muted">
                  {t('profile.totpHint', 'Un code renouvelé toutes les 30 secondes.')}
                </p>
              </div>
              {tfa.totpEnabled ? (
                <Button size="sm" variant="danger" onClick={() => void disableTotp()} disabled={tfaBusy}>
                  <Trash2 size={13} />
                </Button>
              ) : (
                !totp && (
                  <Button size="sm" onClick={() => void startTotp()} disabled={tfaBusy}>
                    {t('profile.configure', 'Configurer')}
                  </Button>
                )
              )}
            </div>

            {totp && !tfa.totpEnabled && (
              <div className="space-y-3">
                <img
                  src={totp.qrDataUrl}
                  alt={t('profile.totpQrAlt', 'QR code de configuration')}
                  className="h-40 w-40 rounded-card bg-white p-1"
                />
                <p className="break-all font-mono text-[11px] text-text-muted">{totp.secret}</p>
                <div className="flex items-end gap-2">
                  <Input
                    label={t('profile.totpCode', 'Code à six chiffres')}
                    inputMode="numeric"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="font-mono tracking-widest"
                  />
                  <Button size="sm" onClick={() => void enableTotp()} disabled={totpCode.length !== 6 || tfaBusy}>
                    {t('profile.activate', 'Activer')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setTotp(null)}>
                    {t('common.cancel', 'Annuler')}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* E-mail OTP */}
          <div className="space-y-3 rounded-card bg-bg-tertiary p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                  <Mail size={13} />
                  {t('profile.emailOtp', 'Code par e-mail')}
                  {tfa.emailOtpEnabled && <Check size={14} className="text-status-resolved" />}
                </p>
                <p className="text-xs text-text-muted">
                  {tfa.emailOtpEnabled && tfa.email
                    ? tfa.email
                    : t('profile.emailOtpHint', 'Un code à usage unique envoyé à votre adresse.')}
                </p>
              </div>
              {tfa.emailOtpEnabled && (
                <Button size="sm" variant="danger" onClick={() => void disableOtp()} disabled={tfaBusy}>
                  <Trash2 size={13} />
                </Button>
              )}
            </div>

            {!tfa.emailOtpEnabled &&
              (otpStage === 'idle' ? (
                <div className="flex items-end gap-2">
                  <Input
                    label={t('profile.email', 'Adresse e-mail')}
                    type="email"
                    value={otpEmail}
                    onChange={(e) => setOtpEmail(e.target.value)}
                  />
                  <Button size="sm" onClick={() => void sendOtp()} disabled={!otpEmail.trim() || tfaBusy}>
                    {t('profile.sendCode', 'Envoyer')}
                  </Button>
                </div>
              ) : (
                <div className="flex items-end gap-2">
                  <Input
                    label={t('profile.emailCode', 'Code reçu')}
                    inputMode="numeric"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="font-mono tracking-widest"
                  />
                  <Button size="sm" onClick={() => void enableOtp()} disabled={otpCode.length !== 6 || tfaBusy}>
                    {t('profile.activate', 'Activer')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setOtpStage('idle')}>
                    {t('common.cancel', 'Annuler')}
                  </Button>
                </div>
              ))}
          </div>
        </Section>
      )}

      {/* ── Accès ────────────────────────────────────────────────────────── */}
      <Section
        icon={<Building2 size={16} />}
        title={t('profile.sectionAccess', 'Accès')}
        description={t('profile.accessDesc', 'Ce que ce compte peut atteindre. En lecture seule.')}
      >
        <dl className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-text-muted">{t('profile.currentTenant', 'Organisation active')}</dt>
            <dd className="text-text-primary">
              {profile?.tenant?.name ?? '—'}
              {profile?.tenant && (
                <span className="ml-1.5 font-mono text-xs text-text-muted">/{profile.tenant.slug}</span>
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-text-muted">{t('profile.role', 'Rôle')}</dt>
            <dd className="text-text-primary">{profile?.role ?? '—'}</dd>
          </div>

          {(profile?.tenants.length ?? 0) > 1 && (
            <div>
              <dt className="mb-1.5 text-text-muted">{t('profile.tenants', 'Organisations')}</dt>
              <dd className="flex flex-wrap gap-1.5">
                {profile?.tenants.map((membership) => (
                  <span
                    key={membership.tenantId}
                    className="rounded-pill bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary"
                  >
                    {membership.tenantName}
                    <span className="ml-1 font-mono text-text-muted">{membership.role}</span>
                  </span>
                ))}
              </dd>
            </div>
          )}

          {(profile?.teams.length ?? 0) > 0 && (
            <div>
              <dt className="mb-1.5 flex items-center gap-1.5 text-text-muted">
                <Users size={13} />
                {t('profile.teams', 'Équipes')}
              </dt>
              <dd className="flex flex-wrap gap-1.5">
                {profile?.teams.map((team) => (
                  <span
                    key={team.id}
                    className="rounded-pill bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary"
                  >
                    {team.name}
                  </span>
                ))}
              </dd>
            </div>
          )}

          <div>
            <dt className="mb-1.5 text-text-muted">{t('profile.capabilities', 'Permissions effectives')}</dt>
            <dd className="flex flex-wrap gap-1.5">
              {profile?.capabilities.length ? (
                profile.capabilities.map((capability) => {
                  const label = capabilityLabel(capability);
                  return (
                    <span
                      key={capability}
                      title={capability}
                      className="rounded-pill bg-accent/10 px-2.5 py-1 text-xs text-accent"
                    >
                      {t(label.key, label.fallback)}
                    </span>
                  );
                })
              ) : (
                <span className="text-xs text-text-muted">{t('profile.noCapabilities', 'Aucune')}</span>
              )}
            </dd>
          </div>
        </dl>
      </Section>
    </div>
  );
}

export default ProfilePage;
