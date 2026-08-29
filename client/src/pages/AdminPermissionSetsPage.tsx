/**
 * AdminPermissionSetsPage — `/admin/permission-sets`
 *
 * A permission set is a named bundle of capabilities, assigned to people in
 * one tenant. The editor's whole job is to make the `implies` graph VISIBLE
 * before the save: granting `config_admin` also grants queue, SLA, automation,
 * catalog, alert and portal administration plus `ticket_read`, and an admin
 * who discovers that from a support ticket has been failed by this screen.
 * Held capabilities are solid; capabilities arriving only by implication are
 * tinted, unclickable-looking and listed underneath.
 *
 * System sets are editable but not deletable — other objects reference a set
 * by name. "Duplicate" is the honest answer to "I want to delete this one".
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Check, Copy, Lock, Pencil, Plus, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import {
  CAPABILITY_CATALOG,
  CAPABILITY_GROUPS,
  CAPABILITY_GROUP_LABELS,
  CAPABILITY_PRESETS,
  expandCapabilities,
  type Capability,
  type PermissionSet,
} from '@oblidesk/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/utils/cn';

interface PermissionSetWithUsage extends PermissionSet {
  assigneeCount: number;
  effectiveCapabilities: Capability[];
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
  wide,
}: {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          'w-full overflow-hidden rounded-modal bg-bg-secondary shadow-card',
          wide ? 'max-w-2xl' : 'max-w-md',
        )}
      >
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

export function AdminPermissionSetsPage() {
  const { t } = useTranslation();

  const [sets, setSets] = useState<PermissionSetWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PermissionSetWithUsage | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [saving, setSaving] = useState(false);

  const [cloning, setCloning] = useState<PermissionSetWithUsage | null>(null);
  const [cloneName, setCloneName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ success: true; data: PermissionSetWithUsage[] }>('/permission-sets');
      setSets(res.data.data);
      setDenied(false);
    } catch (err) {
      if ((err as { response?: { status?: number } })?.response?.status === 403) setDenied(true);
      else toast.error(serverError(err, t('adminSets.loadFailed', 'Impossible de charger les jeux de permissions.')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setName('');
    setDescription('');
    setCapabilities([]);
    setEditorOpen(true);
  }

  function openEdit(set: PermissionSetWithUsage) {
    setEditing(set);
    setName(set.name);
    setDescription(set.description ?? '');
    setCapabilities([...set.capabilities]);
    setEditorOpen(true);
  }

  function applyPreset(preset: readonly Capability[]) {
    setCapabilities([...preset]);
  }

  async function save() {
    if (!name.trim()) {
      toast.error(t('adminSets.nameRequired', 'Le nom est obligatoire.'));
      return;
    }
    setSaving(true);
    try {
      const payload = { name: name.trim(), description: description.trim() || null, capabilities };
      if (editing) {
        await apiClient.put(`/permission-sets/${editing.id}`, payload);
        toast.success(t('adminSets.updated', 'Jeu de permissions mis à jour.'));
      } else {
        await apiClient.post('/permission-sets', payload);
        toast.success(t('adminSets.created', 'Jeu de permissions créé.'));
      }
      setEditorOpen(false);
      await load();
    } catch (err) {
      toast.error(serverError(err, t('adminSets.saveFailed', "L'enregistrement a échoué.")));
    } finally {
      setSaving(false);
    }
  }

  async function clone() {
    if (!cloning || !cloneName.trim()) return;
    try {
      await apiClient.post(`/permission-sets/${cloning.id}/clone`, { name: cloneName.trim() });
      toast.success(t('adminSets.cloned', 'Copie créée.'));
      setCloning(null);
      setCloneName('');
      await load();
    } catch (err) {
      toast.error(serverError(err, t('adminSets.cloneFailed', 'La duplication a échoué.')));
    }
  }

  async function remove(set: PermissionSetWithUsage) {
    if (
      !confirm(
        t('adminSets.confirmDelete', 'Supprimer le jeu « {{name}} » ? {{count}} compte(s) le perdront.', {
          name: set.name,
          count: set.assigneeCount,
        }),
      )
    ) {
      return;
    }
    try {
      await apiClient.delete(`/permission-sets/${set.id}`);
      toast.success(t('adminSets.deleted', 'Jeu supprimé.'));
      await load();
    } catch (err) {
      toast.error(serverError(err, t('adminSets.deleteFailed', 'La suppression a échoué.')));
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

  const effective = expandCapabilities(capabilities);
  const implied = effective.filter((capability) => !capabilities.includes(capability));
  const sensitiveHeld = CAPABILITY_CATALOG.filter(
    (entry) => entry.sensitive && effective.includes(entry.key),
  );

  return (
    <div className="space-y-5 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-wide text-text-primary">
            <ShieldCheck size={22} className="text-accent" />
            {t('adminSets.pageTitle', 'Jeux de permissions')}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {t('adminSets.pageDesc', 'Des ensembles nommés de permissions, attribués aux comptes.')}
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus size={14} className="mr-1" />
          {t('adminSets.create', 'Nouveau jeu')}
        </Button>
      </header>

      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : sets.length === 0 ? (
        <p className="rounded-card bg-bg-secondary px-5 py-12 text-center text-sm text-text-muted shadow-card">
          {t('adminSets.empty', 'Aucun jeu de permissions.')}
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {sets.map((set) => {
            const inherited = set.effectiveCapabilities.filter(
              (capability) => !set.capabilities.includes(capability),
            );
            return (
              <article key={set.id} className="space-y-3 rounded-card bg-bg-secondary p-4 shadow-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2 font-display text-base font-semibold text-text-primary">
                      {set.name}
                      {set.isSystem && (
                        <span
                          title={t('adminSets.systemHint', 'Jeu fourni : modifiable, non supprimable.')}
                          className="flex items-center gap-1 rounded-pill bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-muted"
                        >
                          <Lock size={10} />
                          {t('adminSets.system', 'Fourni')}
                        </span>
                      )}
                    </h2>
                    {set.description && <p className="mt-0.5 text-xs text-text-muted">{set.description}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span
                      title={t('adminSets.assignees', 'Comptes concernés')}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted"
                    >
                      <Users size={13} />
                      {set.assigneeCount}
                    </span>
                    <button
                      type="button"
                      title={t('common.edit', 'Modifier')}
                      onClick={() => openEdit(set)}
                      className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      title={t('adminSets.clone', 'Dupliquer')}
                      onClick={() => {
                        setCloning(set);
                        setCloneName(`${set.name} (copie)`);
                      }}
                      className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                    >
                      <Copy size={13} />
                    </button>
                    {!set.isSystem && (
                      <button
                        type="button"
                        title={t('common.delete', 'Supprimer')}
                        onClick={() => void remove(set)}
                        className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-status-cancelled"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-1">
                  {set.capabilities.map((capability) => (
                    <span
                      key={capability}
                      className="rounded-pill bg-accent/15 px-2 py-0.5 font-mono text-[11px] text-accent"
                    >
                      {capability}
                    </span>
                  ))}
                  {inherited.map((capability) => (
                    <span
                      key={capability}
                      title={t('adminSets.byImplication', 'Accordée par implication')}
                      className="rounded-pill bg-bg-tertiary px-2 py-0.5 font-mono text-[11px] text-text-muted"
                    >
                      {capability}
                    </span>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* ── Editor ───────────────────────────────────────────────────────── */}
      {editorOpen && (
        <Panel
          wide
          title={editing ? t('adminSets.editTitle', 'Modifier le jeu') : t('adminSets.createTitle', 'Nouveau jeu')}
          icon={<ShieldCheck size={16} className="text-accent" />}
          onClose={() => setEditorOpen(false)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setEditorOpen(false)}>
                {t('common.cancel', 'Annuler')}
              </Button>
              <Button size="sm" loading={saving} onClick={() => void save()}>
                {t('common.save', 'Enregistrer')}
              </Button>
            </>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={t('adminSets.name', 'Nom')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
            <Input
              label={t('adminSets.description', 'Description')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <span className="block text-xs uppercase tracking-wide text-text-muted">
              {t('adminSets.presets', "Partir d'un modèle")}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {CAPABILITY_PRESETS.map((preset) => (
                <button
                  key={preset.slug}
                  type="button"
                  title={preset.description}
                  onClick={() => applyPreset(preset.capabilities)}
                  className="rounded-pill bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                >
                  {t(preset.nameKey, preset.name)}
                </button>
              ))}
            </div>
          </div>

          {CAPABILITY_GROUPS.map((group) => {
            const entries = CAPABILITY_CATALOG.filter((entry) => entry.group === group).slice().sort(
              (a, b) => a.sortOrder - b.sortOrder,
            );
            if (entries.length === 0) return null;
            const groupLabel = CAPABILITY_GROUP_LABELS[group];
            return (
              <div key={group} className="space-y-1.5">
                <p className="text-[11px] uppercase tracking-wide text-text-muted">
                  {t(groupLabel.key, groupLabel.fallback)}
                </p>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {entries.map((entry) => {
                    const held = capabilities.includes(entry.key);
                    const inherited = !held && implied.includes(entry.key);
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        onClick={() =>
                          setCapabilities((prev) =>
                            held ? prev.filter((c) => c !== entry.key) : [...prev, entry.key],
                          )
                        }
                        className={cn(
                          'flex items-start gap-2 rounded-card px-3 py-2 text-left transition-colors',
                          held && 'bg-accent/15',
                          inherited && 'bg-bg-tertiary/60',
                          !held && !inherited && 'bg-bg-tertiary hover:bg-bg-hover',
                        )}
                      >
                        <span
                          className={cn(
                            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded',
                            held ? 'bg-accent text-white' : inherited ? 'bg-accent/25 text-accent' : 'bg-bg-active',
                          )}
                        >
                          {(held || inherited) && <Check size={11} />}
                        </span>
                        <span className="min-w-0">
                          <span
                            className={cn(
                              'flex items-center gap-1 text-sm',
                              held ? 'text-accent' : inherited ? 'text-text-secondary' : 'text-text-primary',
                            )}
                          >
                            {t(entry.labelKey, entry.label)}
                            {entry.sensitive && <AlertTriangle size={11} className="text-priority-p2" />}
                          </span>
                          <span className="mt-0.5 block text-[11px] text-text-muted">
                            {inherited
                              ? t('adminSets.impliedBy', 'Accordée par implication')
                              : entry.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {implied.length > 0 && (
            <p className="rounded-card bg-bg-tertiary px-3 py-2 text-xs text-text-muted">
              {t('adminSets.impliedSummary', 'Ce jeu accorde aussi, par implication : {{list}}', {
                list: implied.join(', '),
              })}
            </p>
          )}

          {sensitiveHeld.length > 0 && (
            <p className="flex items-start gap-2 rounded-card bg-status-pending-bg px-3 py-2 text-xs text-status-pending">
              <AlertTriangle size={13} className="mt-px shrink-0" />
              <span>
                {t('adminSets.sensitiveWarning', 'Permissions sensibles accordées : {{list}}', {
                  list: sensitiveHeld.map((entry) => t(entry.labelKey, entry.label)).join(', '),
                })}
              </span>
            </p>
          )}
        </Panel>
      )}

      {/* ── Clone ────────────────────────────────────────────────────────── */}
      {cloning && (
        <Panel
          title={t('adminSets.cloneTitle', 'Dupliquer le jeu')}
          icon={<Copy size={16} className="text-accent" />}
          onClose={() => setCloning(null)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setCloning(null)}>
                {t('common.cancel', 'Annuler')}
              </Button>
              <Button size="sm" disabled={!cloneName.trim()} onClick={() => void clone()}>
                {t('adminSets.clone', 'Dupliquer')}
              </Button>
            </>
          }
        >
          <Input
            label={t('adminSets.cloneName', 'Nom de la copie')}
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
            autoFocus
          />
        </Panel>
      )}
    </div>
  );
}

export default AdminPermissionSetsPage;
