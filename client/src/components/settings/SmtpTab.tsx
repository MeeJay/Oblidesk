/**
 * SmtpTab — the mail servers this installation sends through.
 *
 * The password is write-only by construction: the server returns `passwordSet`
 * and never the secret, so editing an existing server leaves the field blank
 * and an EMPTY field means "keep the stored password" rather than "clear it".
 * Sending an empty string here would silently erase a working credential the
 * next time somebody corrected a typo in the host name.
 *
 * ── Endpoint discovery ───────────────────────────────────────────────────────
 * The SMTP router is not mounted in `routes/index.ts` in the build this screen
 * was written against — `smtpServerService` exists, the HTTP surface does not
 * yet. Rather than hard-code a guess, the tab probes the two conventional
 * mounts once and remembers whichever answers; if neither does, it says so
 * plainly instead of rendering an empty list that looks like "no servers
 * configured". Delete the probe once the route lands.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Check, Eye, EyeOff, Mail, Pencil, Plus, Send, Server, Star, Trash2, X } from 'lucide-react';
import type { SmtpServer } from '@oblidesk/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/utils/cn';

/** Conventional mounts, most specific first. See the header. */
const CANDIDATE_BASES = ['/smtp-servers', '/admin/smtp-servers'] as const;

interface SmtpForm {
  name: string;
  host: string;
  port: string;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
  isDefault: boolean;
}

const emptyForm = (): SmtpForm => ({
  name: '',
  host: '',
  port: '587',
  secure: false,
  username: '',
  password: '',
  fromAddress: '',
  fromName: '',
  isDefault: false,
});

interface AppConfig {
  allow2fa: boolean;
  force2fa: boolean;
  otpSmtpServerId: number | null;
}

function serverError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

export function SmtpTab() {
  const { t } = useTranslation();

  const [base, setBase] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [servers, setServers] = useState<SmtpServer[]>([]);
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SmtpServer | null>(null);
  const [form, setForm] = useState<SmtpForm>(emptyForm);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);

  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    for (const candidate of CANDIDATE_BASES) {
      try {
        const res = await apiClient.get<{ success: true; data: SmtpServer[] }>(candidate);
        setBase(candidate);
        setServers(res.data.data);
        setUnavailable(false);
        setLoading(false);
        return;
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        // A 403 means the route EXISTS and refused us — that is an answer, and
        // trying the next mount would only turn it into a misleading 404.
        if (status === 403) {
          setBase(candidate);
          setUnavailable(false);
          setLoading(false);
          toast.error(t('common.forbidden', "Vous n'avez pas les droits nécessaires pour cette page."));
          return;
        }
      }
    }
    setUnavailable(true);
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    apiClient
      .get<{ success: true; data: AppConfig }>('/admin/config')
      .then((res) => setAppConfig(res.data.data))
      .catch(() => {});
  }, []);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setShowPassword(false);
    setFormOpen(true);
  }

  function openEdit(server: SmtpServer) {
    setEditing(server);
    setForm({
      name: server.name,
      host: server.host,
      port: String(server.port),
      secure: server.secure,
      username: server.username ?? '',
      password: '', // Never prefilled — the server does not return it.
      fromAddress: server.fromAddress,
      fromName: server.fromName ?? '',
      isDefault: server.isDefault,
    });
    setShowPassword(false);
    setFormOpen(true);
  }

  async function save() {
    if (!base) return;
    if (!form.name.trim() || !form.host.trim() || !form.fromAddress.trim()) {
      toast.error(t('smtp.requiredFields', 'Nom, hôte et adresse expéditrice sont obligatoires.'));
      return;
    }

    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error(t('smtp.invalidPort', 'Le port doit être un entier entre 1 et 65535.'));
      return;
    }

    const payload = {
      name: form.name.trim(),
      host: form.host.trim(),
      port,
      secure: form.secure,
      username: form.username.trim() || null,
      fromAddress: form.fromAddress.trim(),
      fromName: form.fromName.trim() || null,
      isDefault: form.isDefault,
      // Omitted when blank on an edit: see the header.
      ...(form.password ? { password: form.password } : {}),
    };

    setSaving(true);
    try {
      if (editing) {
        await apiClient.put(`${base}/${editing.id}`, payload);
        toast.success(t('smtp.updated', 'Serveur SMTP mis à jour.'));
      } else {
        await apiClient.post(base, payload);
        toast.success(t('smtp.created', 'Serveur SMTP créé.'));
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      toast.error(serverError(err, t('smtp.saveFailed', "L'enregistrement a échoué.")));
    } finally {
      setSaving(false);
    }
  }

  async function remove(server: SmtpServer) {
    if (!base) return;
    if (!confirm(t('smtp.confirmDelete', 'Supprimer le serveur « {{name}} » ?', { name: server.name }))) return;
    try {
      await apiClient.delete(`${base}/${server.id}`);
      toast.success(t('smtp.deleted', 'Serveur supprimé.'));
      await load();
    } catch (err) {
      toast.error(serverError(err, t('smtp.deleteFailed', 'La suppression a échoué.')));
    }
  }

  async function test(server: SmtpServer) {
    if (!base) return;
    setTestingId(server.id);
    try {
      await apiClient.post(`${base}/${server.id}/test`);
      toast.success(t('smtp.testOk', 'Connexion établie.'));
    } catch (err) {
      toast.error(serverError(err, t('smtp.testFailed', 'La connexion a échoué.')));
    } finally {
      setTestingId(null);
    }
  }

  async function setOtpServer(id: number | null) {
    setAppConfig((prev) => (prev ? { ...prev, otpSmtpServerId: id } : prev));
    try {
      await apiClient.put('/admin/config/security', { otpSmtpServerId: id });
      toast.success(t('smtp.otpServerSaved', 'Serveur des codes à usage unique enregistré.'));
    } catch (err) {
      toast.error(serverError(err, t('smtp.otpServerFailed', "L'enregistrement a échoué.")));
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className="space-y-2 rounded-card bg-bg-secondary p-6 shadow-card">
        <h2 className="flex items-center gap-2 font-display text-base font-semibold text-text-primary">
          <Server size={16} className="text-accent" />
          {t('smtp.unavailableTitle', 'Serveurs SMTP indisponibles')}
        </h2>
        <p className="text-sm text-text-muted">
          {t(
            'smtp.unavailableDesc',
            "Cette installation n'expose pas encore l'API des serveurs SMTP. Les codes par e-mail et les notifications sortantes resteront inactifs tant qu'aucun serveur n'est configuré.",
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-card bg-bg-secondary p-5 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
              <Server size={15} className="text-accent" />
              {t('smtp.title', 'Serveurs SMTP')}
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">
              {t('smtp.desc', 'Utilisés pour les réponses aux demandeurs, les notifications et les codes de connexion.')}
            </p>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus size={14} className="mr-1" />
            {t('smtp.add', 'Ajouter')}
          </Button>
        </div>

        {servers.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-muted">
            {t('smtp.empty', 'Aucun serveur SMTP configuré.')}
          </p>
        ) : (
          <ul className="space-y-2">
            {servers.map((server) => (
              <li
                key={server.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-bg-tertiary px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm text-text-primary">
                    {server.name}
                    {server.isDefault && (
                      <span className="flex items-center gap-1 rounded-pill bg-accent/15 px-2 py-0.5 text-[10px] text-accent">
                        <Star size={9} />
                        {t('smtp.default', 'Par défaut')}
                      </span>
                    )}
                    {!server.passwordSet && (
                      <span className="rounded-pill bg-bg-active px-2 py-0.5 text-[10px] text-text-muted">
                        {t('smtp.noPassword', 'Sans mot de passe')}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-text-muted">
                    {server.host}:{server.port}
                    {server.secure ? ' · TLS' : ''} · {server.fromAddress}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    title={t('smtp.test', 'Tester la connexion')}
                    onClick={() => void test(server)}
                    disabled={testingId === server.id}
                    className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
                  >
                    <Send size={13} />
                  </button>
                  <button
                    type="button"
                    title={t('common.edit', 'Modifier')}
                    onClick={() => openEdit(server)}
                    className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    title={t('common.delete', 'Supprimer')}
                    onClick={() => void remove(server)}
                    className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-status-cancelled"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── One-time-code sender ─────────────────────────────────────────── */}
      {appConfig && servers.length > 0 && (
        <section className="space-y-2 rounded-card bg-bg-secondary p-5 shadow-card">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            <Mail size={15} className="text-accent" />
            {t('smtp.otpTitle', 'Codes de connexion par e-mail')}
          </h2>
          <p className="text-xs text-text-muted">
            {t(
              'smtp.otpDesc',
              "Le serveur qui envoie les codes à usage unique. Sans lui, la double authentification par e-mail est inutilisable.",
            )}
          </p>
          <select
            value={appConfig.otpSmtpServerId ?? ''}
            onChange={(event) => void setOtpServer(event.target.value ? Number(event.target.value) : null)}
            className="w-full max-w-sm rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">{t('smtp.otpNone', 'Aucun (désactivé)')}</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name} ({server.host})
              </option>
            ))}
          </select>
        </section>
      )}

      {/* ── Form ─────────────────────────────────────────────────────────── */}
      {formOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setFormOpen(false);
          }}
        >
          <div className="w-full max-w-lg overflow-hidden rounded-modal bg-bg-secondary shadow-card">
            <header className="flex items-center justify-between gap-3 px-5 py-4">
              <h3 className="flex items-center gap-2 font-display text-base font-semibold text-text-primary">
                <Server size={16} className="text-accent" />
                {editing ? t('smtp.editTitle', 'Modifier le serveur') : t('smtp.createTitle', 'Nouveau serveur SMTP')}
              </h3>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                <X size={16} />
              </button>
            </header>

            <div className="max-h-[65vh] space-y-4 overflow-y-auto px-5 pb-5">
              <Input
                label={t('smtp.name', 'Nom')}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('smtp.namePlaceholder', 'Relais interne')}
                autoFocus
              />
              <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
                <Input
                  label={t('smtp.host', 'Hôte')}
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder="smtp.exemple.fr"
                  className="font-mono"
                />
                <Input
                  label={t('smtp.port', 'Port')}
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                  className="font-mono"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-text-primary">
                <input
                  type="checkbox"
                  checked={form.secure}
                  onChange={(e) => setForm({ ...form, secure: e.target.checked })}
                  className="h-4 w-4 accent-accent"
                />
                {t('smtp.secure', 'TLS implicite (port 465)')}
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={t('smtp.username', 'Identifiant')}
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  autoComplete="off"
                />
                <div className="space-y-1">
                  <span className="block text-sm font-medium text-text-secondary">
                    {t('smtp.password', 'Mot de passe')}
                  </span>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      placeholder={
                        editing && editing.passwordSet
                          ? t('smtp.passwordKeep', 'Inchangé')
                          : t('smtp.passwordNone', 'Aucun')
                      }
                      autoComplete="new-password"
                      className="w-full rounded-md bg-bg-tertiary px-3 py-2 pr-9 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                    >
                      {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={t('smtp.fromAddress', 'Adresse expéditrice')}
                  type="email"
                  value={form.fromAddress}
                  onChange={(e) => setForm({ ...form, fromAddress: e.target.value })}
                  placeholder="support@exemple.fr"
                />
                <Input
                  label={t('smtp.fromName', 'Nom expéditeur')}
                  value={form.fromName}
                  onChange={(e) => setForm({ ...form, fromName: e.target.value })}
                  placeholder="Support Oblidesk"
                />
              </div>

              <button
                type="button"
                onClick={() => setForm({ ...form, isDefault: !form.isDefault })}
                className={cn(
                  'flex w-full items-center gap-2 rounded-card px-3 py-2.5 text-left text-sm transition-colors',
                  form.isDefault ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                )}
              >
                <span
                  className={cn(
                    'flex h-4 w-4 items-center justify-center rounded',
                    form.isDefault ? 'bg-accent text-white' : 'bg-bg-active',
                  )}
                >
                  {form.isDefault && <Check size={11} />}
                </span>
                {t('smtp.setDefault', 'Serveur par défaut de cette installation')}
              </button>
            </div>

            <footer className="flex justify-end gap-2 bg-bg-tertiary px-5 py-3">
              <Button variant="ghost" size="sm" onClick={() => setFormOpen(false)}>
                {t('common.cancel', 'Annuler')}
              </Button>
              <Button size="sm" loading={saving} onClick={() => void save()}>
                {t('common.save', 'Enregistrer')}
              </Button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

export default SmtpTab;
