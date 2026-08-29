/**
 * EnrollmentPage — `/enroll`
 *
 * The PERSONAL onboarding wizard, run once per account. Not to be confused
 * with `SetupPage` (`/setup`), which configures the INSTALLATION.
 *
 * Every step writes as it is left, so abandoning the wizard halfway keeps what
 * was already chosen — a wizard that only commits on the last screen punishes
 * the person who got interrupted.
 *
 * Steps are skippable with one exception: when the operator has forced 2FA
 * (`force2fa`) and the account carries no factor, the security step has no
 * skip. That is the one place where "later" is not a real option, because the
 * next sign-in would refuse to complete anyway.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronLeft, ChevronRight, KeyRound, Mail, Palette, ShieldCheck, User as UserIcon } from 'lucide-react';
import { SEEDED_LOCALES, type SupportedLocale } from '@oblidesk/shared';
import type { User } from '@oblidesk/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Logo } from '@/components/common/Logo';
import { applyTheme, currentTheme, THEME_OPTIONS, type AppTheme } from '@/utils/theme';
import { cn } from '@/utils/cn';

type Step = 'language' | 'profile' | 'appearance' | 'password' | 'security';

const LOCALE_LABELS: Record<string, string> = { fr: 'Français', en: 'English' };

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

// ── Stepper ──────────────────────────────────────────────────────────────────

function Stepper({ steps, current }: { steps: Step[]; current: Step }) {
  const { t } = useTranslation();
  const labels: Record<Step, string> = {
    language: t('enrollment.stepLanguage', 'Langue'),
    profile: t('enrollment.stepProfile', 'Profil'),
    appearance: t('enrollment.stepAppearance', 'Apparence'),
    password: t('enrollment.stepPassword', 'Mot de passe'),
    security: t('enrollment.stepSecurity', 'Sécurité'),
  };
  const currentIndex = steps.indexOf(current);

  return (
    <ol className="flex items-center justify-center gap-1">
      {steps.map((step, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        return (
          <li key={step} className="flex items-center gap-1">
            <div className="flex flex-col items-center gap-1">
              <span
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full font-mono text-xs transition-colors',
                  active && 'bg-accent text-white',
                  done && 'bg-accent/20 text-accent',
                  !active && !done && 'bg-bg-tertiary text-text-muted',
                )}
              >
                {done ? <Check size={13} /> : index + 1}
              </span>
              <span
                className={cn(
                  'hidden text-[10px] uppercase tracking-wide sm:block',
                  active ? 'text-text-primary' : 'text-text-muted',
                )}
              >
                {labels[step]}
              </span>
            </div>
            {index < steps.length - 1 && <span className="mb-4 h-px w-6 bg-border sm:w-10" />}
          </li>
        );
      })}
    </ol>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function EnrollmentPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [tfa, setTfa] = useState<TwoFactorStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [locale, setLocale] = useState<SupportedLocale>('fr');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [theme, setTheme] = useState<AppTheme>(currentTheme);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [totp, setTotp] = useState<TotpEnrolment | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [otpEmail, setOtpEmail] = useState('');
  const [otpStage, setOtpStage] = useState<'idle' | 'sent'>('idle');
  const [otpCode, setOtpCode] = useState('');

  const [step, setStep] = useState<Step>('language');

  // ── Boot ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      apiClient.get<{ success: true; data: { user: User } }>('/profile'),
      apiClient.get<{ success: true; data: TwoFactorStatus }>('/profile/2fa/status'),
    ])
      .then(([profileRes, tfaRes]) => {
        if (cancelled) return;
        const loaded = profileRes.data.data.user;
        setUser(loaded);
        setDisplayName(loaded.displayName ?? '');
        setEmail(loaded.email ?? '');
        setOtpEmail(loaded.email ?? '');
        if ((SEEDED_LOCALES as readonly string[]).includes(loaded.preferredLanguage)) {
          setLocale(loaded.preferredLanguage as SupportedLocale);
        }
        setTfa(tfaRes.data.data);
      })
      .catch(() => {
        if (!cancelled) setError(t('enrollment.loadFailed', 'Impossible de charger votre profil.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [t]);

  // A password step makes no sense for an account whose credential lives in
  // Obligate, and the 2FA step makes none when the operator disabled 2FA.
  const steps: Step[] = (['language', 'profile', 'appearance', 'password', 'security'] as Step[]).filter(
    (candidate) => {
      if (candidate === 'password') return user?.authSource === 'local';
      if (candidate === 'security') return tfa?.allowed ?? false;
      return true;
    },
  );

  const hasFactor = Boolean(tfa?.totpEnabled || tfa?.emailOtpEnabled);
  const securityMandatory = Boolean(tfa?.forced && !hasFactor);

  const currentIndex = Math.max(0, steps.indexOf(step));
  const isLast = currentIndex === steps.length - 1;

  const finish = useCallback(() => {
    // Full navigation: the session store, the socket and the theme all
    // re-hydrate from `/api/auth/me` on boot, which is exactly what the
    // choices made here should be read back from.
    window.location.assign('/');
  }, []);

  function goBack() {
    setError('');
    const previous = steps[currentIndex - 1];
    if (previous) setStep(previous);
  }

  function goNext() {
    setError('');
    const next = steps[currentIndex + 1];
    if (next) setStep(next);
    else finish();
  }

  /** Persist the current step, then move on. A failed write keeps the step. */
  async function commitAndAdvance() {
    setBusy(true);
    setError('');
    try {
      if (step === 'language') {
        await apiClient.put('/profile', { preferredLanguage: locale });
        await i18n.changeLanguage(locale);
      } else if (step === 'profile') {
        await apiClient.put('/profile', {
          displayName: displayName.trim() || null,
          email: email.trim() || null,
        });
      } else if (step === 'appearance') {
        await apiClient.put('/profile/preferences', { preferredTheme: theme });
      } else if (step === 'password') {
        if (newPassword) {
          if (newPassword !== confirmPassword) {
            setError(t('enrollment.passwordMismatch', 'Les deux mots de passe ne correspondent pas.'));
            return;
          }
          if (newPassword.length < 8) {
            setError(t('enrollment.passwordTooShort', 'Le mot de passe doit contenir au moins 8 caractères.'));
            return;
          }
          await apiClient.put('/profile/password', { currentPassword, newPassword });
          setCurrentPassword('');
          setNewPassword('');
          setConfirmPassword('');
        }
      }
      goNext();
    } catch (err) {
      setError(serverError(err, t('common.saveFailed', "L'enregistrement a échoué.")));
    } finally {
      setBusy(false);
    }
  }

  // ── 2FA actions ───────────────────────────────────────────────────────────

  async function startTotp() {
    setBusy(true);
    setError('');
    try {
      const res = await apiClient.post<{ success: true; data: TotpEnrolment }>('/profile/2fa/totp/setup');
      setTotp(res.data.data);
      setTotpCode('');
    } catch (err) {
      setError(serverError(err, t('enrollment.totpStartFailed', "Impossible de démarrer l'enrôlement.")));
    } finally {
      setBusy(false);
    }
  }

  async function confirmTotp() {
    setBusy(true);
    setError('');
    try {
      await apiClient.post('/profile/2fa/totp/enable', { code: totpCode });
      setTfa((prev) => (prev ? { ...prev, totpEnabled: true } : prev));
      setTotp(null);
      setTotpCode('');
    } catch (err) {
      setError(serverError(err, t('enrollment.totpInvalid', 'Ce code est invalide — vérifiez l’horloge du téléphone.')));
    } finally {
      setBusy(false);
    }
  }

  async function sendOtp() {
    setBusy(true);
    setError('');
    try {
      await apiClient.post('/profile/2fa/email/setup', { email: otpEmail.trim() });
      setOtpStage('sent');
      setOtpCode('');
    } catch (err) {
      setError(serverError(err, t('enrollment.otpSendFailed', "Le code n'a pas pu être envoyé.")));
    } finally {
      setBusy(false);
    }
  }

  async function confirmOtp() {
    setBusy(true);
    setError('');
    try {
      await apiClient.post('/profile/2fa/email/enable', { email: otpEmail.trim(), code: otpCode });
      setTfa((prev) => (prev ? { ...prev, emailOtpEnabled: true, email: otpEmail.trim() } : prev));
      setOtpStage('idle');
      setOtpCode('');
    } catch (err) {
      setError(serverError(err, t('enrollment.otpInvalid', 'Ce code est invalide ou a expiré.')));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-bg-primary p-4 pt-10">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center">
          <Logo className="mx-auto h-16 w-16" />
          <h1 className="mt-3 font-display text-2xl font-semibold tracking-wide text-text-primary">
            {t('enrollment.title', 'Configurons votre compte')}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t('enrollment.subtitle', 'Cinq réglages rapides. Tout reste modifiable depuis votre profil.')}
          </p>
        </div>

        <Stepper steps={steps} current={step} />

        <div className="space-y-5 rounded-card bg-bg-secondary p-6 shadow-card">
          {/* ── Langue ───────────────────────────────────────────────────── */}
          {step === 'language' && (
            <section className="space-y-3">
              <h2 className="font-display text-lg font-semibold text-text-primary">
                {t('enrollment.languageTitle', 'Dans quelle langue travaillez-vous ?')}
              </h2>
              <div className="grid grid-cols-2 gap-2">
                {SEEDED_LOCALES.map((code) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => setLocale(code)}
                    className={cn(
                      'rounded-card px-4 py-3 text-sm transition-colors',
                      locale === code
                        ? 'bg-accent/15 text-accent shadow-card'
                        : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                    )}
                  >
                    {LOCALE_LABELS[code] ?? code}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* ── Profil ───────────────────────────────────────────────────── */}
          {step === 'profile' && (
            <section className="space-y-4">
              <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-text-primary">
                <UserIcon size={17} className="text-accent" />
                {t('enrollment.profileTitle', 'Comment doit-on vous nommer ?')}
              </h2>
              <Input
                label={t('enrollment.displayName', 'Nom affiché')}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={user?.username ?? ''}
                autoFocus
              />
              <Input
                label={t('enrollment.email', 'Adresse e-mail')}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="prenom.nom@exemple.fr"
              />
              <p className="text-xs text-text-muted">
                {t(
                  'enrollment.emailHint',
                  "L'adresse sert aux notifications et, si vous l'activez, aux codes de connexion.",
                )}
              </p>
            </section>
          )}

          {/* ── Apparence ────────────────────────────────────────────────── */}
          {step === 'appearance' && (
            <section className="space-y-3">
              <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-text-primary">
                <Palette size={17} className="text-accent" />
                {t('enrollment.appearanceTitle', 'Choisissez un thème')}
              </h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setTheme(option.id as AppTheme);
                      applyTheme(option.id);
                    }}
                    className={cn(
                      'rounded-card px-4 py-3 text-left transition-colors',
                      theme === option.id
                        ? 'bg-accent/15 shadow-card'
                        : 'bg-bg-tertiary hover:bg-bg-hover',
                    )}
                  >
                    <span
                      className={cn(
                        'block text-sm font-medium',
                        theme === option.id ? 'text-accent' : 'text-text-primary',
                      )}
                    >
                      {option.name}
                    </span>
                    <span className="mt-0.5 block text-xs text-text-muted">{option.description}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* ── Mot de passe ─────────────────────────────────────────────── */}
          {step === 'password' && (
            <section className="space-y-4">
              <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-text-primary">
                <KeyRound size={17} className="text-accent" />
                {t('enrollment.passwordTitle', 'Changer votre mot de passe')}
              </h2>
              <p className="text-xs text-text-muted">
                {t(
                  'enrollment.passwordHint',
                  'Optionnel. Changer le mot de passe déconnecte vos autres appareils.',
                )}
              </p>
              <Input
                label={t('enrollment.currentPassword', 'Mot de passe actuel')}
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
              <Input
                label={t('enrollment.newPassword', 'Nouveau mot de passe')}
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
              <Input
                label={t('enrollment.confirmPassword', 'Confirmer le mot de passe')}
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
            </section>
          )}

          {/* ── Sécurité (2FA) ───────────────────────────────────────────── */}
          {step === 'security' && (
            <section className="space-y-4">
              <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-text-primary">
                <ShieldCheck size={17} className="text-accent" />
                {t('enrollment.securityTitle', 'Double authentification')}
              </h2>

              {securityMandatory && (
                <p className="rounded-card bg-status-pending-bg px-3 py-2 text-xs text-status-pending">
                  {t(
                    'enrollment.securityForced',
                    "Votre administrateur exige un second facteur : activez-en un pour continuer.",
                  )}
                </p>
              )}

              {/* TOTP */}
              <div className="space-y-3 rounded-card bg-bg-tertiary p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                      {t('enrollment.totp', "Application d'authentification")}
                      {tfa?.totpEnabled && <Check size={14} className="text-status-resolved" />}
                    </p>
                    <p className="text-xs text-text-muted">
                      {t('enrollment.totpHint', 'Google Authenticator, 1Password, Bitwarden…')}
                    </p>
                  </div>
                  {!tfa?.totpEnabled && !totp && (
                    <Button size="sm" onClick={() => void startTotp()} disabled={busy}>
                      {t('enrollment.configure', 'Configurer')}
                    </Button>
                  )}
                </div>

                {totp && !tfa?.totpEnabled && (
                  <div className="space-y-3">
                    <img
                      src={totp.qrDataUrl}
                      alt={t('enrollment.totpQrAlt', 'QR code de configuration')}
                      className="h-40 w-40 rounded-card bg-white p-1"
                    />
                    <p className="break-all font-mono text-[11px] text-text-muted">{totp.secret}</p>
                    <div className="flex items-end gap-2">
                      <Input
                        label={t('enrollment.totpCode', 'Code à six chiffres')}
                        inputMode="numeric"
                        value={totpCode}
                        onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        className="font-mono tracking-widest"
                      />
                      <Button
                        size="sm"
                        onClick={() => void confirmTotp()}
                        disabled={totpCode.length !== 6 || busy}
                      >
                        {t('enrollment.activate', 'Activer')}
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
                      {t('enrollment.emailOtp', 'Code par e-mail')}
                      {tfa?.emailOtpEnabled && <Check size={14} className="text-status-resolved" />}
                    </p>
                    <p className="text-xs text-text-muted">
                      {t('enrollment.emailOtpHint', 'Un code à usage unique envoyé à votre adresse.')}
                    </p>
                  </div>
                </div>

                {!tfa?.emailOtpEnabled && (
                  <div className="space-y-2">
                    {otpStage === 'idle' ? (
                      <div className="flex items-end gap-2">
                        <Input
                          label={t('enrollment.email', 'Adresse e-mail')}
                          type="email"
                          value={otpEmail}
                          onChange={(e) => setOtpEmail(e.target.value)}
                        />
                        <Button size="sm" onClick={() => void sendOtp()} disabled={!otpEmail.trim() || busy}>
                          {t('enrollment.sendCode', 'Envoyer')}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-end gap-2">
                        <Input
                          label={t('enrollment.emailCode', 'Code reçu')}
                          inputMode="numeric"
                          value={otpCode}
                          onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                          className="font-mono tracking-widest"
                        />
                        <Button
                          size="sm"
                          onClick={() => void confirmOtp()}
                          disabled={otpCode.length !== 6 || busy}
                        >
                          {t('enrollment.activate', 'Activer')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {error && (
            <p className="rounded-card bg-status-cancelled-bg px-3 py-2 text-sm text-status-cancelled">
              {error}
            </p>
          )}

          {/* ── Navigation ───────────────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={goBack}
              disabled={currentIndex === 0 || busy}
              className={cn(currentIndex === 0 && 'invisible')}
            >
              <ChevronLeft size={14} />
              {t('common.back', 'Retour')}
            </Button>

            <div className="flex items-center gap-2">
              {!(step === 'security' && securityMandatory) && (
                <button
                  type="button"
                  onClick={isLast ? finish : goNext}
                  className="text-xs text-text-muted transition-colors hover:text-text-primary"
                >
                  {isLast ? t('common.finish', 'Terminer') : t('common.skip', 'Ignorer')}
                </button>
              )}
              <Button
                size="sm"
                loading={busy}
                disabled={step === 'security' && securityMandatory && !hasFactor}
                onClick={() => {
                  if (step === 'security') {
                    finish();
                    return;
                  }
                  void commitAndAdvance();
                }}
              >
                {isLast ? t('common.finish', 'Terminer') : t('common.continue', 'Continuer')}
                {!isLast && <ChevronRight size={14} className="ml-1" />}
              </Button>
            </div>
          </div>
        </div>

        {/* Hidden while a factor is mandatory: offering an exit the next sign-in
            would refuse is a lie the wizard should not tell. */}
        {!securityMandatory && (
          <button
            type="button"
            onClick={() => navigate('/')}
            className="mx-auto block text-xs text-text-muted transition-colors hover:text-text-primary"
          >
            {t('enrollment.later', 'Plus tard — aller au bureau')}
          </button>
        )}
      </div>
    </div>
  );
}

export default EnrollmentPage;
