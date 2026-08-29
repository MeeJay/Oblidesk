/**
 * AdminTenantsPage — `/admin/tenants`
 *
 * Platform-admin only. One card per tenant, with the identity settings that
 * every engine reads: the ticket prefix (what a human ticket number looks
 * like), the timezone (what "business hours" means), and the default
 * calendar / queue / SLA slugs.
 *
 * Two things this screen refuses to make easy, deliberately:
 *
 *  • The SLUG is not editable after creation. Every sibling app in the suite
 *    stores this tenant BY SLUG (hard rule 13); renaming it here would orphan
 *    their CI projections, alert bindings and SSO mappings without any of them
 *    noticing. The field is shown, read-only, so the value is visible.
 *
 *  • Deleting asks for the slug back. Every tenant-scoped foreign key cascades,
 *    so a delete takes the tickets, journal, mail, SLA history, audit chain and
 *    decision log with it. There is no undo.
 *
 * Cross-references in `settings` are by SLUG, never by id — the same rule the
 * configuration store follows, for the same reason.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Building2, Crown, Pencil, Plus, Trash2, Users, X } from 'lucide-react';
import type { Tenant, TenantSettings, UserRole } from '@oblidesk/shared';
import { DEFAULT_TICKET_PREFIX } from '@oblidesk/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/utils/cn';

interface TenantStats {
  users: number;
  tickets: number;
  openTickets: number;
  configObjects: number;
}

interface TenantMemberRow {
  userId: number;
  username: string;
  displayName: string | null;
  email: string | null;
  role: UserRole;
  isActive: boolean;
}

interface TenantForm {
  name: string;
  slug: string;
  ticketPrefix: string;
  timezone: string;
  locale: string;
  defaultQueueSlug: string;
  defaultCalendarSlug: string;
  defaultSlaPolicySlug: string;
}

const emptyForm = (): TenantForm => ({
  name: '',
  slug: '',
  ticketPrefix: DEFAULT_TICKET_PREFIX,
  timezone: 'Europe/Paris',
  locale: 'fr',
  defaultQueueSlug: '',
  defaultCalendarSlug: '',
  defaultSlaPolicySlug: '',
});

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    // Strip the combining marks NFD just split off, so "Créé" becomes "cree".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function serverError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

function Panel({
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

export function AdminTenantsPage() {
  const { t } = useTranslation();

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [stats, setStats] = useState<Record<number, TenantStats>>({});
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [form, setForm] = useState<TenantForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  const [membersFor, setMembersFor] = useState<Tenant | null>(null);
  const [members, setMembers] = useState<TenantMemberRow[]>([]);

  const [deleting, setDeleting] = useState<Tenant | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ success: true; data: Tenant[] }>('/tenants');
      setTenants(res.data.data);
      setDenied(false);

      // Counts are per-tenant queries; fetched alongside rather than inline so
      // one slow tenant does not hold the whole list back.
      const entries = await Promise.all(
        res.data.data.map(async (tenant) => {
          try {
            const statsRes = await apiClient.get<{ success: true; data: TenantStats }>(
              `/tenants/${tenant.id}/stats`,
            );
            return [tenant.id, statsRes.data.data] as const;
          } catch {
            return null;
          }
        }),
      );
      setStats(Object.fromEntries(entries.filter((entry): entry is readonly [number, TenantStats] => entry !== null)));
    } catch (err) {
      if ((err as { response?: { status?: number } })?.response?.status === 403) setDenied(true);
      else toast.error(serverError(err, t('adminTenants.loadFailed', 'Impossible de charger les organisations.')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setFormOpen(true);
  }

  function openEdit(tenant: Tenant) {
    const settings = tenant.settings ?? {};
    setEditing(tenant);
    setForm({
      name: tenant.name,
      slug: tenant.slug,
      ticketPrefix: settings.ticketPrefix ?? DEFAULT_TICKET_PREFIX,
      timezone: settings.timezone ?? 'Europe/Paris',
      locale: settings.locale ?? 'fr',
      defaultQueueSlug: settings.defaultQueueSlug ?? '',
      defaultCalendarSlug: settings.defaultCalendarSlug ?? '',
      defaultSlaPolicySlug: settings.defaultSlaPolicySlug ?? '',
    });
    setFormOpen(true);
  }

  async function save() {
    if (!form.name.trim()) {
      toast.error(t('adminTenants.nameRequired', 'Le nom est obligatoire.'));
      return;
    }

    // Empty strings are dropped, never written: an empty `defaultQueueSlug`
    // stored as '' would look like a reference to a queue named '' to the
    // config linter, which is a dangling reference nobody asked for.
    const settings: TenantSettings = {
      ticketPrefix: form.ticketPrefix.trim().toUpperCase() || undefined,
      timezone: form.timezone.trim() || undefined,
      locale: form.locale.trim() || undefined,
      defaultQueueSlug: form.defaultQueueSlug.trim() || undefined,
      defaultCalendarSlug: form.defaultCalendarSlug.trim() || undefined,
      defaultSlaPolicySlug: form.defaultSlaPolicySlug.trim() || undefined,
    };

    setSaving(true);
    try {
      if (editing) {
        await apiClient.put(`/tenants/${editing.id}`, { name: form.name.trim(), settings });
        toast.success(t('adminTenants.updated', 'Organisation mise à jour.'));
      } else {
        await apiClient.post('/tenants', {
          name: form.name.trim(),
          slug: toSlug(form.slug || form.name),
          settings,
        });
        toast.success(t('adminTenants.created', 'Organisation créée.'));
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      toast.error(serverError(err, t('adminTenants.saveFailed', "L'enregistrement a échoué.")));
    } finally {
      setSaving(false);
    }
  }

  async function openMembers(tenant: Tenant) {
    setMembersFor(tenant);
    setMembers([]);
    try {
      const res = await apiClient.get<{ success: true; data: TenantMemberRow[] }>(
        `/tenants/${tenant.id}/members`,
      );
      setMembers(res.data.data);
    } catch (err) {
      toast.error(serverError(err, t('adminTenants.membersFailed', 'Impossible de charger les membres.')));
    }
  }

  async function confirmDelete() {
    if (!deleting || deleteConfirm !== deleting.slug) return;
    try {
      await apiClient.delete(`/tenants/${deleting.id}`, { params: { confirmSlug: deleting.slug } });
      toast.success(t('adminTenants.deleted', 'Organisation supprimée.'));
      setDeleting(null);
      setDeleteConfirm('');
      await load();
    } catch (err) {
      toast.error(serverError(err, t('adminTenants.deleteFailed', 'La suppression a échoué.')));
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

  return (
    <div className="space-y-5 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-wide text-text-primary">
            <Building2 size={22} className="text-accent" />
            {t('adminTenants.pageTitle', 'Organisations')}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {t('adminTenants.pageDesc', 'Chaque organisation a ses tickets, sa configuration et son journal.')}
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus size={14} className="mr-1" />
          {t('adminTenants.create', 'Nouvelle organisation')}
        </Button>
      </header>

      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : tenants.length === 0 ? (
        <p className="rounded-card bg-bg-secondary px-5 py-12 text-center text-sm text-text-muted shadow-card">
          {t('adminTenants.empty', 'Aucune organisation.')}
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {tenants.map((tenant) => {
            const counts = stats[tenant.id];
            return (
              <article key={tenant.id} className="space-y-3 rounded-card bg-bg-secondary p-4 shadow-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2 font-display text-base font-semibold text-text-primary">
                      {tenant.name}
                      {tenant.isMaster && (
                        <span
                          title={t('adminTenants.masterHint', "L'organisation maîtresse voit toutes les autres.")}
                          className="flex items-center gap-1 rounded-pill bg-accent/15 px-2 py-0.5 text-[11px] text-accent"
                        >
                          <Crown size={11} />
                          {t('adminTenants.master', 'Maîtresse')}
                        </span>
                      )}
                    </h2>
                    <p className="mt-0.5 font-mono text-xs text-text-muted">
                      /{tenant.slug}
                      {tenant.settings?.ticketPrefix && ` · ${tenant.settings.ticketPrefix}-1042`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      title={t('adminTenants.members', 'Membres')}
                      onClick={() => void openMembers(tenant)}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                    >
                      <Users size={13} />
                      {counts?.users ?? '—'}
                    </button>
                    <button
                      type="button"
                      title={t('common.edit', 'Modifier')}
                      onClick={() => openEdit(tenant)}
                      className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                    >
                      <Pencil size={13} />
                    </button>
                    {!tenant.isMaster && (
                      <button
                        type="button"
                        title={t('common.delete', 'Supprimer')}
                        onClick={() => {
                          setDeleting(tenant);
                          setDeleteConfirm('');
                        }}
                        className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-status-cancelled"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>

                <dl className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: t('adminTenants.tickets', 'Tickets'), value: counts?.tickets },
                    { label: t('adminTenants.openTickets', 'Ouverts'), value: counts?.openTickets },
                    { label: t('adminTenants.configObjects', 'Objets de config.'), value: counts?.configObjects },
                  ].map((entry) => (
                    <div key={entry.label} className="rounded-card bg-bg-tertiary px-2 py-2">
                      <dd className="font-mono text-lg text-text-primary">{entry.value ?? '—'}</dd>
                      <dt className="text-[10px] uppercase tracking-wide text-text-muted">{entry.label}</dt>
                    </div>
                  ))}
                </dl>

                {tenant.settings?.timezone && (
                  <p className="text-xs text-text-muted">
                    {t('adminTenants.timezoneLabel', 'Fuseau : {{tz}}', { tz: tenant.settings.timezone })}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}

      {/* ── Create / edit ────────────────────────────────────────────────── */}
      {formOpen && (
        <Panel
          title={
            editing
              ? t('adminTenants.editTitle', "Modifier l'organisation")
              : t('adminTenants.createTitle', 'Nouvelle organisation')
          }
          icon={<Building2 size={16} className="text-accent" />}
          onClose={() => setFormOpen(false)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setFormOpen(false)}>
                {t('common.cancel', 'Annuler')}
              </Button>
              <Button size="sm" loading={saving} onClick={() => void save()}>
                {t('common.save', 'Enregistrer')}
              </Button>
            </>
          }
        >
          <Input
            label={t('adminTenants.name', 'Nom')}
            value={form.name}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                name: e.target.value,
                slug: editing ? prev.slug : toSlug(e.target.value),
              }))
            }
            autoFocus
            required
          />
          <div className="space-y-1">
            <Input
              label={t('adminTenants.slug', 'Identifiant inter-applications')}
              value={form.slug}
              onChange={(e) => setForm((prev) => ({ ...prev, slug: toSlug(e.target.value) }))}
              disabled={Boolean(editing)}
              className="font-mono"
            />
            <p className="text-xs text-text-muted">
              {editing
                ? t(
                    'adminTenants.slugLocked',
                    "Non modifiable : les autres applications de la suite référencent cette organisation par cet identifiant.",
                  )
                : t('adminTenants.slugHint', 'Minuscules, chiffres et tirets. Définitif après création.')}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={t('adminTenants.ticketPrefix', 'Préfixe des tickets')}
              value={form.ticketPrefix}
              onChange={(e) => setForm((prev) => ({ ...prev, ticketPrefix: e.target.value.toUpperCase() }))}
              placeholder={DEFAULT_TICKET_PREFIX}
              className="font-mono"
            />
            <Input
              label={t('adminTenants.timezone', 'Fuseau horaire')}
              value={form.timezone}
              onChange={(e) => setForm((prev) => ({ ...prev, timezone: e.target.value }))}
              placeholder="Europe/Paris"
              className="font-mono"
            />
          </div>

          <div className="space-y-3 rounded-card bg-bg-tertiary p-3">
            <p className="text-xs text-text-muted">
              {t(
                'adminTenants.defaultsHint',
                'Références par slug vers les objets de configuration publiés. Laissez vide pour utiliser la valeur de base.',
              )}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                label={t('adminTenants.defaultQueue', 'File par défaut')}
                value={form.defaultQueueSlug}
                onChange={(e) => setForm((prev) => ({ ...prev, defaultQueueSlug: e.target.value }))}
                className="font-mono"
              />
              <Input
                label={t('adminTenants.defaultCalendar', 'Calendrier')}
                value={form.defaultCalendarSlug}
                onChange={(e) => setForm((prev) => ({ ...prev, defaultCalendarSlug: e.target.value }))}
                className="font-mono"
              />
              <Input
                label={t('adminTenants.defaultSla', 'Politique SLA')}
                value={form.defaultSlaPolicySlug}
                onChange={(e) => setForm((prev) => ({ ...prev, defaultSlaPolicySlug: e.target.value }))}
                className="font-mono"
              />
            </div>
          </div>
        </Panel>
      )}

      {/* ── Members ──────────────────────────────────────────────────────── */}
      {membersFor && (
        <Panel
          title={t('adminTenants.membersTitle', 'Membres de {{name}}', { name: membersFor.name })}
          icon={<Users size={16} className="text-accent" />}
          onClose={() => setMembersFor(null)}
        >
          {members.length === 0 ? (
            <p className="text-sm text-text-muted">{t('adminTenants.noMembers', 'Aucun membre.')}</p>
          ) : (
            <ul className="space-y-1">
              {members.map((member) => (
                <li
                  key={member.userId}
                  className="flex items-center justify-between gap-3 rounded-card bg-bg-tertiary px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text-primary">
                      {member.displayName || member.username}
                    </span>
                    <span className="block truncate font-mono text-xs text-text-muted">{member.username}</span>
                  </span>
                  <span
                    className={cn(
                      'shrink-0 rounded-pill px-2 py-0.5 text-[11px]',
                      member.isActive ? 'bg-accent/10 text-accent' : 'bg-bg-active text-text-muted',
                    )}
                  >
                    {member.role}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-text-muted">
            {t(
              'adminTenants.membersManagedElsewhere',
              "L'appartenance se gère depuis la page Comptes, dans l'organisation concernée.",
            )}
          </p>
        </Panel>
      )}

      {/* ── Delete ───────────────────────────────────────────────────────── */}
      {deleting && (
        <Panel
          title={t('adminTenants.deleteTitle', "Supprimer l'organisation")}
          icon={<Trash2 size={16} className="text-status-cancelled" />}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
                {t('common.cancel', 'Annuler')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={deleteConfirm !== deleting.slug}
                onClick={() => void confirmDelete()}
              >
                {t('common.delete', 'Supprimer')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">
            {t(
              'adminTenants.deleteDesc',
              'Les tickets, le journal, les pièces jointes, les SLA, le journal d’audit et le journal de décision seront supprimés. Il n’y a pas de retour en arrière. Saisissez « {{slug}} » pour confirmer.',
              { slug: deleting.slug },
            )}
          </p>
          <Input
            label={t('adminTenants.slug', 'Identifiant inter-applications')}
            value={deleteConfirm}
            onChange={(e) => setDeleteConfirm(e.target.value)}
            className="font-mono"
            autoFocus
          />
        </Panel>
      )}
    </div>
  );
}

export default AdminTenantsPage;
