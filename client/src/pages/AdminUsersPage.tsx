/**
 * AdminUsersPage — `/admin/users`
 *
 * Tenant-scoped account administration: the members of the CURRENT tenant,
 * their role here, their teams and their permission sets.
 *
 * Two deletes, and the difference matters enough to be visible in the UI:
 *   • "Retirer"   → `DELETE /api/users/:id`            removes the membership
 *   • "Supprimer" → `DELETE /api/users/:id?purge=true` deletes the account
 * The safe one is the default and the destructive one asks for the username
 * back, because an id is easy to fat-finger and impossible to recognise.
 *
 * Roles here are the TENANT role (`PUT /:id/tenant-role`), which is a different
 * column from the platform role on the account — a person can be an agent in
 * one tenant and a manager in another, and conflating the two would silently
 * promote them everywhere.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  KeyRound,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UserMinus,
  Users as UsersIcon,
  X,
} from 'lucide-react';
import type { PermissionSet, User, UserRole } from '@oblidesk/shared';
import { SEEDED_LOCALES } from '@oblidesk/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/utils/cn';

const TENANT_ROLES: UserRole[] = ['admin', 'manager', 'agent', 'user'];
const PAGE_SIZE = 25;

interface TenantMember extends User {
  tenantRole: UserRole;
  teams: Array<{ id: number; name: string }>;
}

interface UserForm {
  username: string;
  password: string;
  displayName: string;
  email: string;
  tenantRole: UserRole;
  isActive: boolean;
  preferredLanguage: string;
}

const emptyForm = (): UserForm => ({
  username: '',
  password: '',
  displayName: '',
  email: '',
  tenantRole: 'agent',
  isActive: true,
  preferredLanguage: 'fr',
});

function serverError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

// ── Modal shell ──────────────────────────────────────────────────────────────
// No border on the panel (hard rule 11): depth is the background step plus the
// card shadow, over a dimmed backdrop.

function Modal({
  title,
  icon,
  onClose,
  children,
  footer,
}: {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-modal bg-bg-secondary shadow-card">
        <header className="flex items-center justify-between gap-3 px-5 py-4">
          <h3 className="flex items-center gap-2 font-display text-base font-semibold text-text-primary">
            {icon}
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </header>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto px-5 pb-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 bg-bg-tertiary px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

function RolePill({ role }: { role: UserRole }) {
  const tone: Record<UserRole, string> = {
    admin: 'bg-priority-p1-bg text-priority-p1',
    manager: 'bg-priority-p2-bg text-priority-p2',
    agent: 'bg-accent/10 text-accent',
    user: 'bg-bg-tertiary text-text-muted',
  };
  return <span className={cn('rounded-pill px-2 py-0.5 text-[11px] font-medium', tone[role])}>{role}</span>;
}

export function AdminUsersPage() {
  const { t } = useTranslation();

  const [members, setMembers] = useState<TenantMember[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  const [permissionSets, setPermissionSets] = useState<PermissionSet[]>([]);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TenantMember | null>(null);
  const [form, setForm] = useState<UserForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  const [passwordFor, setPasswordFor] = useState<TenantMember | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const [setsFor, setSetsFor] = useState<TenantMember | null>(null);
  const [selectedSets, setSelectedSets] = useState<number[]>([]);

  const [purging, setPurging] = useState<TenantMember | null>(null);
  const [purgeConfirm, setPurgeConfirm] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ success: true; data: TenantMember[]; total: number }>('/users', {
        params: { q: query || undefined, page, limit: PAGE_SIZE },
      });
      setMembers(res.data.data);
      setTotal(res.data.total ?? res.data.data.length);
      setDenied(false);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 403) setDenied(true);
      else toast.error(serverError(err, t('adminUsers.loadFailed', 'Impossible de charger les comptes.')));
    } finally {
      setLoading(false);
    }
  }, [page, query, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    apiClient
      .get<{ success: true; data: PermissionSet[] }>('/permission-sets')
      .then((res) => setPermissionSets(res.data.data))
      .catch(() => {
        /* A manager may not read the sets — the column simply stays empty. */
      });
  }, []);

  // ── Create / edit ─────────────────────────────────────────────────────────

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setFormOpen(true);
  }

  function openEdit(member: TenantMember) {
    setEditing(member);
    setForm({
      username: member.username,
      password: '',
      displayName: member.displayName ?? '',
      email: member.email ?? '',
      tenantRole: member.tenantRole,
      isActive: member.isActive,
      preferredLanguage: member.preferredLanguage,
    });
    setFormOpen(true);
  }

  async function submitForm(event?: FormEvent) {
    event?.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        await apiClient.put(`/users/${editing.id}`, {
          displayName: form.displayName.trim() || null,
          email: form.email.trim() || null,
          isActive: form.isActive,
          preferredLanguage: form.preferredLanguage,
        });
        // The tenant role lives on `user_tenants`, not on the account.
        if (form.tenantRole !== editing.tenantRole) {
          await apiClient.put(`/users/${editing.id}/tenant-role`, { role: form.tenantRole });
        }
        toast.success(t('adminUsers.updated', 'Compte mis à jour.'));
      } else {
        await apiClient.post('/users', {
          username: form.username.trim(),
          password: form.password || undefined,
          displayName: form.displayName.trim() || null,
          email: form.email.trim() || null,
          tenantRole: form.tenantRole,
          isActive: form.isActive,
          preferredLanguage: form.preferredLanguage,
        });
        toast.success(t('adminUsers.created', 'Compte créé.'));
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      toast.error(serverError(err, t('adminUsers.saveFailed', "L'enregistrement a échoué.")));
    } finally {
      setSaving(false);
    }
  }

  // ── Password reset ────────────────────────────────────────────────────────

  async function submitPassword() {
    if (!passwordFor) return;
    if (newPassword.length < 8) {
      toast.error(t('adminUsers.passwordTooShort', 'Le mot de passe doit contenir au moins 8 caractères.'));
      return;
    }
    try {
      await apiClient.put(`/users/${passwordFor.id}/password`, { password: newPassword });
      toast.success(
        t('adminUsers.passwordReset', 'Mot de passe réinitialisé. Toutes les sessions sont fermées.'),
      );
      setPasswordFor(null);
      setNewPassword('');
    } catch (err) {
      toast.error(serverError(err, t('adminUsers.passwordFailed', 'La réinitialisation a échoué.')));
    }
  }

  // ── Permission sets ───────────────────────────────────────────────────────

  async function openSets(member: TenantMember) {
    setSetsFor(member);
    setSelectedSets([]);
    try {
      const res = await apiClient.get<{ success: true; data: PermissionSet[] }>(
        `/users/${member.id}/permission-sets`,
      );
      setSelectedSets(res.data.data.map((set) => set.id));
    } catch {
      toast.error(t('adminUsers.setsLoadFailed', 'Impossible de charger les jeux de permissions.'));
    }
  }

  async function submitSets() {
    if (!setsFor) return;
    try {
      await apiClient.put(`/users/${setsFor.id}/permission-sets`, { permissionSetIds: selectedSets });
      toast.success(t('adminUsers.setsSaved', 'Jeux de permissions enregistrés.'));
      setSetsFor(null);
    } catch (err) {
      toast.error(serverError(err, t('adminUsers.setsFailed', "L'affectation a échoué.")));
    }
  }

  // ── Removal ───────────────────────────────────────────────────────────────

  async function removeFromTenant(member: TenantMember) {
    if (!confirm(t('adminUsers.confirmRemove', 'Retirer {{name}} de cette organisation ?', { name: member.username }))) {
      return;
    }
    try {
      await apiClient.delete(`/users/${member.id}`);
      toast.success(t('adminUsers.removed', 'Compte retiré de cette organisation.'));
      await load();
    } catch (err) {
      toast.error(serverError(err, t('adminUsers.removeFailed', 'Le retrait a échoué.')));
    }
  }

  async function purgeAccount() {
    if (!purging || purgeConfirm !== purging.username) return;
    try {
      await apiClient.delete(`/users/${purging.id}`, { params: { purge: 'true' } });
      toast.success(t('adminUsers.purged', 'Compte supprimé définitivement.'));
      setPurging(null);
      setPurgeConfirm('');
      await load();
    } catch (err) {
      toast.error(serverError(err, t('adminUsers.purgeFailed', 'La suppression a échoué.')));
    }
  }

  if (denied) {
    return (
      <div className="p-6">
        <p className="rounded-card bg-bg-secondary p-6 text-sm text-text-muted shadow-card">
          {t('common.forbidden', "Vous n'avez pas les droits nécessaires pour cette page.")}
        </p>
      </div>
    );
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-wide text-text-primary">
            <UsersIcon size={22} className="text-accent" />
            {t('adminUsers.pageTitle', 'Comptes')}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {t('adminUsers.pageDesc', 'Les membres de cette organisation, leur rôle et leurs permissions.')}
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus size={14} className="mr-1" />
          {t('adminUsers.create', 'Nouveau compte')}
        </Button>
      </header>

      <div className="relative max-w-sm">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          placeholder={t('adminUsers.search', 'Rechercher un identifiant, un nom, un e-mail…')}
          className="w-full rounded-md bg-bg-tertiary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="overflow-hidden rounded-card bg-bg-secondary shadow-card">
        {loading ? (
          <div className="flex justify-center py-12">
            <LoadingSpinner />
          </div>
        ) : members.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-text-muted">
            {t('adminUsers.empty', 'Aucun compte ne correspond.')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                  <th className="px-5 py-3 font-medium">{t('adminUsers.colUser', 'Compte')}</th>
                  <th className="px-3 py-3 font-medium">{t('adminUsers.colRole', 'Rôle ici')}</th>
                  <th className="px-3 py-3 font-medium">{t('adminUsers.colTeams', 'Équipes')}</th>
                  <th className="px-3 py-3 font-medium">{t('adminUsers.colStatus', 'État')}</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id} className="border-b border-border/40 last:border-0 hover:bg-bg-hover/50">
                    <td className="px-5 py-3">
                      <div className="font-medium text-text-primary">
                        {member.displayName || member.username}
                      </div>
                      <div className="font-mono text-xs text-text-muted">
                        {member.username}
                        {member.email && ` · ${member.email}`}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <RolePill role={member.tenantRole} />
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {member.teams.length === 0 ? (
                          <span className="text-xs text-text-muted">—</span>
                        ) : (
                          member.teams.map((team) => (
                            <span
                              key={team.id}
                              className="rounded-pill bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary"
                            >
                              {team.name}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={cn(
                          'rounded-pill px-2 py-0.5 text-[11px]',
                          member.isActive
                            ? 'bg-status-resolved-bg text-status-resolved'
                            : 'bg-status-cancelled-bg text-status-cancelled',
                        )}
                      >
                        {member.isActive
                          ? t('adminUsers.active', 'Actif')
                          : t('adminUsers.inactive', 'Désactivé')}
                      </span>
                      {member.authSource !== 'local' && (
                        <span className="ml-1.5 rounded-pill bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                          {member.authSource}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <IconButton
                          title={t('common.edit', 'Modifier')}
                          onClick={() => openEdit(member)}
                          icon={<Pencil size={13} />}
                        />
                        <IconButton
                          title={t('adminUsers.permissionSets', 'Jeux de permissions')}
                          onClick={() => void openSets(member)}
                          icon={<ShieldCheck size={13} />}
                        />
                        {member.authSource === 'local' && (
                          <IconButton
                            title={t('adminUsers.resetPassword', 'Réinitialiser le mot de passe')}
                            onClick={() => {
                              setPasswordFor(member);
                              setNewPassword('');
                            }}
                            icon={<KeyRound size={13} />}
                          />
                        )}
                        <IconButton
                          title={t('adminUsers.removeFromTenant', "Retirer de l'organisation")}
                          onClick={() => void removeFromTenant(member)}
                          icon={<UserMinus size={13} />}
                        />
                        <IconButton
                          danger
                          title={t('adminUsers.purge', "Supprimer le compte de l'installation")}
                          onClick={() => {
                            setPurging(member);
                            setPurgeConfirm('');
                          }}
                          icon={<Trash2 size={13} />}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span>
            {t('common.pageOf', 'Page {{page}} sur {{pages}} · {{total}} comptes', {
              page,
              pages: pageCount,
              total,
            })}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              {t('common.previous', 'Précédent')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => p + 1)}
            >
              {t('common.next', 'Suivant')}
            </Button>
          </div>
        </div>
      )}

      {/* ── Create / edit ────────────────────────────────────────────────── */}
      {formOpen && (
        <Modal
          title={editing ? t('adminUsers.editTitle', 'Modifier le compte') : t('adminUsers.createTitle', 'Nouveau compte')}
          icon={<UsersIcon size={16} className="text-accent" />}
          onClose={() => setFormOpen(false)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setFormOpen(false)}>
                {t('common.cancel', 'Annuler')}
              </Button>
              <Button size="sm" loading={saving} onClick={() => void submitForm()}>
                {t('common.save', 'Enregistrer')}
              </Button>
            </>
          }
        >
          <form onSubmit={(e) => void submitForm(e)} className="space-y-4">
            <Input
              label={t('adminUsers.username', 'Identifiant')}
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              disabled={Boolean(editing)}
              required
              autoFocus={!editing}
            />
            {!editing && (
              <Input
                label={t('adminUsers.password', 'Mot de passe initial')}
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={t('adminUsers.passwordSsoHint', 'Laisser vide pour un compte SSO uniquement')}
                autoComplete="new-password"
              />
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={t('adminUsers.displayName', 'Nom affiché')}
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              />
              <Input
                label={t('adminUsers.email', 'Adresse e-mail')}
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="block text-sm font-medium text-text-secondary">
                  {t('adminUsers.tenantRole', "Rôle dans l'organisation")}
                </span>
                <select
                  value={form.tenantRole}
                  onChange={(e) => setForm({ ...form, tenantRole: e.target.value as UserRole })}
                  className="w-full rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  {TENANT_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="block text-sm font-medium text-text-secondary">
                  {t('adminUsers.language', 'Langue')}
                </span>
                <select
                  value={form.preferredLanguage}
                  onChange={(e) => setForm({ ...form, preferredLanguage: e.target.value })}
                  className="w-full rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  {SEEDED_LOCALES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                className="h-4 w-4 accent-accent"
              />
              {t('adminUsers.isActive', 'Compte actif')}
            </label>
          </form>
        </Modal>
      )}

      {/* ── Password reset ───────────────────────────────────────────────── */}
      {passwordFor && (
        <Modal
          title={t('adminUsers.resetPasswordTitle', 'Réinitialiser le mot de passe')}
          icon={<KeyRound size={16} className="text-accent" />}
          onClose={() => setPasswordFor(null)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setPasswordFor(null)}>
                {t('common.cancel', 'Annuler')}
              </Button>
              <Button size="sm" onClick={() => void submitPassword()}>
                {t('common.confirm', 'Confirmer')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">
            {t(
              'adminUsers.resetPasswordDesc',
              'Toutes les sessions de {{name}} seront fermées immédiatement.',
              { name: passwordFor.username },
            )}
          </p>
          <Input
            label={t('adminUsers.newPassword', 'Nouveau mot de passe')}
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            autoFocus
          />
        </Modal>
      )}

      {/* ── Permission sets ──────────────────────────────────────────────── */}
      {setsFor && (
        <Modal
          title={t('adminUsers.permissionSetsTitle', 'Jeux de permissions')}
          icon={<ShieldCheck size={16} className="text-accent" />}
          onClose={() => setSetsFor(null)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setSetsFor(null)}>
                {t('common.cancel', 'Annuler')}
              </Button>
              <Button size="sm" onClick={() => void submitSets()}>
                {t('common.save', 'Enregistrer')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">
            {t('adminUsers.permissionSetsDesc', 'Permissions accordées à {{name}} dans cette organisation.', {
              name: setsFor.username,
            })}
          </p>
          {permissionSets.length === 0 ? (
            <p className="text-sm text-text-muted">
              {t('adminUsers.noPermissionSets', 'Aucun jeu de permissions défini.')}
            </p>
          ) : (
            <div className="space-y-1.5">
              {permissionSets.map((set) => {
                const checked = selectedSets.includes(set.id);
                return (
                  <button
                    key={set.id}
                    type="button"
                    onClick={() =>
                      setSelectedSets((prev) =>
                        checked ? prev.filter((id) => id !== set.id) : [...prev, set.id],
                      )
                    }
                    className={cn(
                      'flex w-full items-start gap-3 rounded-card px-3 py-2.5 text-left transition-colors',
                      checked ? 'bg-accent/10' : 'bg-bg-tertiary hover:bg-bg-hover',
                    )}
                  >
                    <input type="checkbox" checked={checked} readOnly className="mt-0.5 h-4 w-4 accent-accent" />
                    <span>
                      <span className="block text-sm text-text-primary">{set.name}</span>
                      {set.description && (
                        <span className="mt-0.5 block text-xs text-text-muted">{set.description}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Modal>
      )}

      {/* ── Purge ────────────────────────────────────────────────────────── */}
      {purging && (
        <Modal
          title={t('adminUsers.purgeTitle', 'Supprimer définitivement')}
          icon={<Trash2 size={16} className="text-status-cancelled" />}
          onClose={() => setPurging(null)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setPurging(null)}>
                {t('common.cancel', 'Annuler')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={purgeConfirm !== purging.username}
                onClick={() => void purgeAccount()}
              >
                {t('adminUsers.purgeConfirm', 'Supprimer')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">
            {t(
              'adminUsers.purgeDesc',
              "Le compte disparaît de TOUTE l'installation. Saisissez « {{name}} » pour confirmer.",
              { name: purging.username },
            )}
          </p>
          <Input
            label={t('adminUsers.purgeField', 'Identifiant')}
            value={purgeConfirm}
            onChange={(e) => setPurgeConfirm(e.target.value)}
            autoFocus
          />
        </Modal>
      )}
    </div>
  );
}

// ── Small helpers ────────────────────────────────────────────────────────────

function IconButton({
  icon,
  title,
  onClick,
  danger,
}: {
  icon: ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover',
        danger ? 'hover:text-status-cancelled' : 'hover:text-text-primary',
      )}
    >
      {icon}
    </button>
  );
}

export default AdminUsersPage;
