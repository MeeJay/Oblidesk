/**
 * LoginPage — `/login`
 *
 * Three states in one screen, because they are one decision for the person
 * standing in front of it:
 *
 *   credentials → the local username / password form
 *   2fa         → the six-digit step, when the account carries a factor
 *   sso         → a BUTTON, never an automatic bounce
 *
 * Oblidesk deliberately does NOT auto-redirect to Obligate the way Obliguard
 * does. A desk is where a locked-out agent lands, so the local form has to be
 * reachable without fighting a redirect loop; the SSO button appears only when
 * `/api/auth/sso-config` reports the gateway both ENABLED and REACHABLE, so it
 * is never offered when pressing it would dead-end.
 *
 * The server answers a completed sign-in with `{ session, authToken,
 * requires2faSetup }`. `authToken` is the session id, kept in sessionStorage
 * for the cookie-less ObliTools shell (STORAGE_KEYS.obliToolsToken — the same
 * key `api/client.ts` replays in `X-Auth-Token`). The page then performs a
 * FULL navigation rather than a client-side one: re-booting the SPA is what
 * hydrates the session store, the socket and the theme in one pass, and it
 * cannot leave a half-populated store behind.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, KeyRound, Mail, ShieldCheck } from 'lucide-react';
import { STORAGE_KEYS } from '@oblidesk/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Logo } from '@/components/common/Logo';
import { cn } from '@/utils/cn';

type Step = 'credentials' | '2fa';
type MfaTab = 'totp' | 'email';

interface SsoConfig {
  obligateUrl: string | null;
  obligateReachable: boolean;
  obligateEnabled: boolean;
}

interface CompletedLogin {
  session: unknown;
  authToken?: string;
  requires2faSetup?: boolean;
}

interface MfaChallenge {
  mfaRequired: 'totp' | 'email_otp';
  mfaToken?: string;
  methods: { totp: boolean; email: boolean };
  emailSent: boolean;
  expiresAt?: number;
}

type LoginPayload = CompletedLogin | MfaChallenge;

function isChallenge(payload: LoginPayload): payload is MfaChallenge {
  return typeof (payload as MfaChallenge).mfaRequired === 'string';
}

/** The server's own message when it sent one — it is always more useful than ours. */
function serverError(err: unknown, fallback: string): string {
  const axiosErr = err as { response?: { status?: number; data?: { error?: string } } };
  return axiosErr?.response?.data?.error ?? fallback;
}

function ssoOnlyRejected(err: unknown): boolean {
  const axiosErr = err as { response?: { data?: { payload?: { ssoOnly?: boolean } } } };
  return axiosErr?.response?.data?.payload?.ssoOnly === true;
}

/** Keep the session id for the WebView2 shell, where our cookie never survives. */
function rememberAuthToken(token: string | undefined): void {
  if (!token) return;
  try {
    sessionStorage.setItem(STORAGE_KEYS.obliToolsToken, token);
  } catch {
    // Storage blocked — the cookie path still works in a normal browser.
  }
}

export function LoginPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();

  // `?tenant=acme` — the cross-app handoff. Joined BY SLUG, never by id.
  const tenantSlug = searchParams.get('tenant') ?? '';
  const ssoErrorCode = searchParams.get('error');

  const [step, setStep] = useState<Step>('credentials');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [mfaMethods, setMfaMethods] = useState<{ totp: boolean; email: boolean }>({
    totp: false,
    email: false,
  });
  const [mfaTab, setMfaTab] = useState<MfaTab>('totp');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaSubmitting, setMfaSubmitting] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const [sso, setSso] = useState<SsoConfig | null>(null);
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  // ── Boot: the SSO probe and the version pill ──────────────────────────────
  useEffect(() => {
    let cancelled = false;

    fetch('/api/auth/sso-config', { credentials: 'include' })
      .then((r) => r.json())
      .then((body: { success?: boolean; data?: SsoConfig }) => {
        if (!cancelled && body?.success && body.data) setSso(body.data);
      })
      .catch(() => {
        /* No gateway, no button. Local sign-in still works. */
      });

    fetch('/health')
      .then((r) => r.json())
      .then((body: { version?: string }) => {
        if (!cancelled) setServerVersion(body?.version ?? null);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ssoErrorCode) return;
    setError(
      ssoErrorCode === 'sso_unreachable'
        ? t('login.ssoUnreachable', "Obligate est injoignable. Utilisez la connexion locale.")
        : ssoErrorCode === 'sso_misconfigured'
          ? t('login.ssoMisconfigured', 'La passerelle Obligate est mal configurée.')
          : t('login.ssoFailed', "La connexion Obligate a échoué. Essayez la connexion locale."),
    );
  }, [ssoErrorCode, t]);

  /** One landing decision, shared by the password path and the 2FA path. */
  const finishLogin = useCallback((payload: CompletedLogin) => {
    rememberAuthToken(payload.authToken);
    // A full navigation, not `navigate()` — see the note at the top of the file.
    window.location.assign(payload.requires2faSetup ? '/enroll' : '/');
  }, []);

  async function handleCredentials(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const res = await apiClient.post<{ success: true; data: LoginPayload }>('/auth/login', {
        username: username.trim(),
        password,
        ...(tenantSlug ? { tenantSlug } : {}),
      });
      const payload = res.data.data;

      if (isChallenge(payload)) {
        rememberAuthToken(payload.mfaToken);
        setMfaMethods(payload.methods);
        setMfaTab(payload.methods.totp ? 'totp' : 'email');
        setEmailSent(payload.emailSent);
        setMfaCode('');
        setStep('2fa');
        return;
      }

      finishLogin(payload);
    } catch (err) {
      setError(
        ssoOnlyRejected(err)
          ? t('login.ssoOnlyAccount', 'Ce compte se connecte via Obligate. Utilisez le bouton ci-dessous.')
          : serverError(err, t('login.failed', 'Identifiant ou mot de passe incorrect.')),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMfa(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMfaSubmitting(true);

    try {
      const res = await apiClient.post<{ success: true; data: CompletedLogin }>('/profile/2fa/verify', {
        method: mfaTab,
        code: mfaCode,
      });
      finishLogin(res.data.data);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401 || status === 400) {
        const message = serverError(err, '');
        // The pending session died (a restart, a timeout). Sending the person
        // back to the password form is the only honest recovery.
        if (/waiting|pending|attente/i.test(message)) {
          setStep('credentials');
          setError(t('login.sessionExpired', 'Session expirée. Reconnectez-vous.'));
        } else {
          setError(t('login.invalidCode', 'Ce code est invalide ou a expiré.'));
        }
      } else {
        setError(serverError(err, t('login.invalidCode', 'Ce code est invalide ou a expiré.')));
      }
    } finally {
      setMfaSubmitting(false);
    }
  }

  async function handleResend() {
    try {
      await apiClient.post('/profile/2fa/resend');
      setEmailSent(true);
      setError('');
    } catch (err) {
      setError(serverError(err, t('login.resendFailed', "Impossible de renvoyer le code.")));
    }
  }

  const ssoAvailable = Boolean(sso?.obligateEnabled && sso?.obligateReachable && sso?.obligateUrl);
  const ssoConfiguredButDown = Boolean(sso?.obligateEnabled && !sso?.obligateReachable);

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Logo className="mx-auto h-20 w-20" />
          <h1 className="mt-3 font-display text-2xl font-semibold tracking-wide text-text-primary">
            {t('login.title', 'Oblidesk')}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t('login.subtitle', 'Connectez-vous à votre centre de services.')}
          </p>
        </div>

        {ssoConfiguredButDown && (
          <div className="flex items-start gap-2 rounded-card bg-status-pending-bg px-3 py-2.5 text-xs text-status-pending shadow-card">
            <AlertTriangle size={14} className="mt-px shrink-0" />
            <span>
              {t(
                'login.ssoUnavailable',
                "La connexion centralisée (Obligate) est indisponible. Utilisez l'authentification locale.",
              )}
            </span>
          </div>
        )}

        {step === 'credentials' ? (
          <form
            onSubmit={(e) => void handleCredentials(e)}
            className="space-y-5 rounded-card bg-bg-secondary p-6 shadow-card"
          >
            <Input
              label={t('login.username', 'Identifiant')}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('login.usernamePlaceholder', 'prenom.nom')}
              autoComplete="username"
              autoFocus
              required
            />
            <Input
              label={t('login.password', 'Mot de passe')}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />

            {error && (
              <p className="rounded-card bg-status-cancelled-bg px-3 py-2 text-sm text-status-cancelled">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" loading={submitting}>
              {t('login.signIn', 'Se connecter')}
            </Button>

            {ssoAvailable && (
              <>
                <div className="flex items-center gap-3 text-[11px] uppercase tracking-widest text-text-muted">
                  <span className="h-px flex-1 bg-border" />
                  {t('login.or', 'ou')}
                  <span className="h-px flex-1 bg-border" />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const target = tenantSlug
                      ? `/auth/sso-redirect?tenant=${encodeURIComponent(tenantSlug)}`
                      : '/auth/sso-redirect';
                    window.location.href = target;
                  }}
                  className={cn(
                    'flex w-full items-center justify-center gap-2 rounded-md bg-bg-tertiary px-4 py-2',
                    'text-sm font-medium text-text-primary shadow-card transition-colors hover:bg-bg-hover',
                  )}
                >
                  <ShieldCheck size={15} className="text-accent" />
                  {t('login.ssoButton', 'Se connecter avec Obligate')}
                </button>
              </>
            )}

            <div className="text-center">
              <Link
                to="/forgot-password"
                className="text-xs text-text-muted transition-colors hover:text-text-primary"
              >
                {t('login.forgotPassword', 'Mot de passe oublié ?')}
              </Link>
            </div>
          </form>
        ) : (
          <form
            onSubmit={(e) => void handleMfa(e)}
            className="space-y-5 rounded-card bg-bg-secondary p-6 shadow-card"
          >
            <div className="flex items-start gap-2">
              <KeyRound size={16} className="mt-0.5 shrink-0 text-accent" />
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {t('login.twoFactor.title', 'Vérification en deux étapes')}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {t('login.twoFactor.description', 'Saisissez le code à six chiffres pour finaliser la connexion.')}
                </p>
              </div>
            </div>

            {mfaMethods.totp && mfaMethods.email && (
              <div className="flex overflow-hidden rounded-pill bg-bg-tertiary p-0.5 text-sm">
                {(['totp', 'email'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => {
                      setMfaTab(tab);
                      setMfaCode('');
                      setError('');
                    }}
                    className={cn(
                      'flex-1 rounded-pill py-1.5 transition-colors',
                      mfaTab === tab
                        ? 'bg-accent text-white'
                        : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                    )}
                  >
                    {tab === 'totp'
                      ? t('login.twoFactor.tabTotp', 'Application')
                      : t('login.twoFactor.tabEmail', 'E-mail')}
                  </button>
                ))}
              </div>
            )}

            {mfaTab === 'email' && (
              <p className="flex items-center gap-1.5 text-xs text-text-muted">
                <Mail size={12} />
                {emailSent
                  ? t('login.twoFactor.emailSent', 'Un code vient de vous être envoyé par e-mail.')
                  : t('login.twoFactor.emailNotSent', "Le code n'a pas pu être envoyé. Demandez-en un nouveau.")}
              </p>
            )}

            <Input
              label={
                mfaTab === 'totp'
                  ? t('login.twoFactor.totpLabel', "Code de l'application")
                  : t('login.twoFactor.emailLabel', 'Code reçu par e-mail')
              }
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              className="text-center font-mono text-lg tracking-[0.4em]"
              autoFocus
              required
            />

            {error && (
              <p className="rounded-card bg-status-cancelled-bg px-3 py-2 text-sm text-status-cancelled">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" loading={mfaSubmitting} disabled={mfaCode.length !== 6}>
              {t('login.twoFactor.verify', 'Vérifier')}
            </Button>

            <div className="flex flex-col gap-1.5 text-center text-xs">
              {mfaMethods.email && (
                <button
                  type="button"
                  onClick={() => void handleResend()}
                  className="text-text-muted transition-colors hover:text-text-primary"
                >
                  {t('login.twoFactor.resend', 'Renvoyer le code par e-mail')}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setStep('credentials');
                  setMfaCode('');
                  setError('');
                }}
                className="text-text-muted transition-colors hover:text-text-primary"
              >
                {t('login.twoFactor.backToLogin', 'Revenir à la connexion')}
              </button>
            </div>
          </form>
        )}
      </div>

      <p className="pointer-events-none fixed inset-x-0 bottom-3 select-none text-center font-mono text-[11px] text-text-muted/60">
        {t('login.clientVersion', 'Client {{version}}', { version: __APP_VERSION__ })}
        {serverVersion ? ` · ${t('login.serverVersion', 'Serveur {{version}}', { version: serverVersion })}` : ''}
      </p>
    </div>
  );
}

export default LoginPage;
