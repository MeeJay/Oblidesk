/**
 * ResetPasswordPage — `/reset-password?token=…`
 *
 * The link is validated BEFORE the form is drawn (`POST
 * /api/auth/reset-password/validate`), so an expired link says so instead of
 * letting someone type a new password twice and only then be refused.
 *
 * The body field is `password` — the server's `resetPasswordSchema` names it
 * that, and it enforces the 8-character floor. The floor is mirrored here only
 * to catch it before the round trip; the server remains the authority.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle } from 'lucide-react';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Logo } from '@/components/common/Logo';

const MIN_PASSWORD_LENGTH = 8;

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [validating, setValidating] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      setValidating(false);
      setTokenValid(false);
      return;
    }

    let cancelled = false;
    apiClient
      .post<{ success: true; data: { valid: boolean } }>('/auth/reset-password/validate', { token })
      .then((res) => {
        if (!cancelled) setTokenValid(res.data.data.valid === true);
      })
      .catch(() => {
        if (!cancelled) setTokenValid(false);
      })
      .finally(() => {
        if (!cancelled) setValidating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');

    if (password !== confirm) {
      setError(t('resetPassword.mismatch', 'Les deux mots de passe ne correspondent pas.'));
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(
        t('resetPassword.tooShort', 'Le mot de passe doit contenir au moins {{count}} caractères.', {
          count: MIN_PASSWORD_LENGTH,
        }),
      );
      return;
    }

    setSubmitting(true);
    try {
      await apiClient.post('/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(message ?? t('resetPassword.failed', 'Ce lien est invalide ou a expiré.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Logo className="mx-auto h-20 w-20" />
        </div>

        <div className="space-y-5 rounded-card bg-bg-secondary p-6 shadow-card">
          {validating ? (
            <div className="flex justify-center py-6">
              <LoadingSpinner size="md" />
            </div>
          ) : !tokenValid ? (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-status-cancelled-bg">
                <XCircle size={22} className="text-status-cancelled" />
              </div>
              <div>
                <h2 className="font-display text-lg font-semibold text-text-primary">
                  {t('resetPassword.title', 'Nouveau mot de passe')}
                </h2>
                <p className="mt-1 text-sm text-status-cancelled">
                  {t('resetPassword.invalidToken', 'Ce lien de réinitialisation est invalide ou a expiré.')}
                </p>
              </div>
              <Link to="/forgot-password" className="block text-sm text-accent hover:underline">
                {t('resetPassword.requestNew', 'Demander un nouveau lien')}
              </Link>
              <Link
                to="/login"
                className="block text-sm text-text-muted transition-colors hover:text-text-primary"
              >
                {t('resetPassword.backToLogin', 'Retour à la connexion')}
              </Link>
            </div>
          ) : done ? (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-status-resolved-bg">
                <CheckCircle2 size={22} className="text-status-resolved" />
              </div>
              <div>
                <h2 className="font-display text-lg font-semibold text-text-primary">
                  {t('resetPassword.successTitle', 'Mot de passe modifié')}
                </h2>
                <p className="mt-1 text-sm text-text-muted">
                  {t(
                    'resetPassword.successMessage',
                    'Vos autres sessions ont été déconnectées. Vous pouvez vous connecter.',
                  )}
                </p>
              </div>
              <Link to="/login" className="block text-sm text-accent hover:underline">
                {t('resetPassword.backToLogin', 'Retour à la connexion')}
              </Link>
            </div>
          ) : (
            <>
              <h2 className="font-display text-lg font-semibold text-text-primary">
                {t('resetPassword.title', 'Nouveau mot de passe')}
              </h2>

              <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
                <Input
                  label={t('resetPassword.newPassword', 'Nouveau mot de passe')}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  autoFocus
                  required
                />
                <Input
                  label={t('resetPassword.confirmPassword', 'Confirmer le mot de passe')}
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  required
                />

                {error && (
                  <p className="rounded-card bg-status-cancelled-bg px-3 py-2 text-sm text-status-cancelled">
                    {error}
                  </p>
                )}

                <Button type="submit" className="w-full" loading={submitting}>
                  {t('resetPassword.submit', 'Enregistrer le mot de passe')}
                </Button>
              </form>

              <Link
                to="/login"
                className="block text-center text-sm text-text-muted transition-colors hover:text-text-primary"
              >
                {t('resetPassword.backToLogin', 'Retour à la connexion')}
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ResetPasswordPage;
