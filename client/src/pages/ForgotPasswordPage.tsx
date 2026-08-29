/**
 * ForgotPasswordPage — `/forgot-password`
 *
 * `POST /api/auth/forgot-password` always answers 200, whether or not the
 * address exists: a different answer for a known address would turn this form
 * into a user directory. The screen mirrors that exactly — one confirmation,
 * regardless of outcome, INCLUDING when the request itself fails. Showing
 * "unknown address" here would undo the server's care.
 */

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MailCheck } from 'lucide-react';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Logo } from '@/components/common/Logo';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');

    if (!EMAIL_RE.test(email.trim())) {
      setError(t('forgotPassword.invalidEmail', 'Saisissez une adresse e-mail valide.'));
      return;
    }

    setSending(true);
    try {
      await apiClient.post('/auth/forgot-password', { email: email.trim() });
    } catch {
      // Deliberately swallowed — see the header. The confirmation is the same
      // whether the address exists, the mail failed, or the server hiccuped.
    } finally {
      setSending(false);
      setSent(true);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Logo className="mx-auto h-20 w-20" />
        </div>

        <div className="space-y-5 rounded-card bg-bg-secondary p-6 shadow-card">
          {sent ? (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-status-resolved-bg">
                <MailCheck size={22} className="text-status-resolved" />
              </div>
              <div>
                <h2 className="font-display text-lg font-semibold text-text-primary">
                  {t('forgotPassword.successTitle', 'Vérifiez votre boîte de réception')}
                </h2>
                <p className="mt-1 text-sm text-text-muted">
                  {t(
                    'forgotPassword.successMessage',
                    "Si un compte correspond à cette adresse, un lien de réinitialisation vient d'être envoyé.",
                  )}
                </p>
              </div>
              <Link to="/login" className="block text-sm text-accent hover:underline">
                {t('forgotPassword.backToLogin', 'Retour à la connexion')}
              </Link>
            </div>
          ) : (
            <>
              <div>
                <h2 className="font-display text-lg font-semibold text-text-primary">
                  {t('forgotPassword.title', 'Mot de passe oublié')}
                </h2>
                <p className="mt-1 text-sm text-text-muted">
                  {t(
                    'forgotPassword.description',
                    'Saisissez votre adresse e-mail : nous vous enverrons un lien de réinitialisation.',
                  )}
                </p>
              </div>

              <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
                <Input
                  label={t('forgotPassword.emailLabel', 'Adresse e-mail')}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="prenom.nom@exemple.fr"
                  autoComplete="email"
                  autoFocus
                  required
                />

                {error && (
                  <p className="rounded-card bg-status-cancelled-bg px-3 py-2 text-sm text-status-cancelled">
                    {error}
                  </p>
                )}

                <Button type="submit" className="w-full" loading={sending}>
                  {t('forgotPassword.submit', 'Envoyer le lien')}
                </Button>
              </form>

              <Link
                to="/login"
                className="block text-center text-sm text-text-muted transition-colors hover:text-text-primary"
              >
                {t('forgotPassword.backToLogin', 'Retour à la connexion')}
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ForgotPasswordPage;
