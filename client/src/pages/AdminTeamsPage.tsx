/**
 * AdminTeamsPage — `/admin/teams`
 *
 * Teams are about PEOPLE (who works together, who inherits which
 * capabilities). They are not assignment groups, which are about ROUTING and
 * live in the configuration store as their own objects — a distinction the
 * schema makes and this screen keeps, because merging them is how a desk ends
 * up unable to route to a rota that is not also a permission boundary.
 *
 * Membership is edited as a FULL REPLACE (`PUT /:id/members`). The server
 * refuses ids that are not already members of the tenant with a 400 rather
 * than silently dropping them, so the list on screen and the list in the
 * database never quietly disagree.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Check, Pencil, Plus, Trash2, Users, UsersRound, X } from 'lucide-react';
import {
  CAPABILITY_CATALOG,
  CAPABILITY_GROUPS,
  CAPABILITY_GROUP_LABELS,
  expandCapabilities,
  type Capability,
  type CapabilityGroup,
  type Team,
} from '@oblidesk/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/utils/cn';

interface TeamMember {
  userId: number;
  username: string;
  displayName: string | null;
  email: string | null;
  isActive: boolean;
}

interface TenantMember {
  id: number;
  username: string;
  displayName: string | null;
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

export function AdminTeamsPage() {
  const { t } = useTranslation();

  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  const [editing, setEditing] = useState<Team | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [saving, setSaving] = useState(false);

  const [membersFor, setMembersFor] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [tenantMembers, setTenantMembers] = useState<TenantMember[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<number[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ success: true; data: Team[] }>('/teams');
      setTeams(res.data.data);
      setDenied(false);
    } catch (err) {
      if ((err as { response?: { status?: number } })?.response?.status === 403) setDenied(true);
      else toast.error(serverError(err, t('adminTeams.loadFailed', 'Impossible de charger les équipes.')));
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
    setCreating(true);
  }

  function openEdit(team: Team) {
    setEditing(team);
    setName(team.name);
    setDescription(team.description ?? '');
    setCapabilities([...team.capabilities]);
    setCreating(true);
  }

  function toggleCapability(capability: Capability) {
    setCapabilities((prev) =>
      prev.includes(capability) ? prev.filter((c) => c !== capability) : [...prev, capability],
    );
  }

  async function save() {
    if (!name.trim()) {
      toast.error(t('adminTeams.nameRequired', 'Le nom est obligatoire.'));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        capabilities,
      };
      if (editing) {
        await apiClient.put(`/teams/${editing.id}`, payload);
        toast.success(t('adminTeams.updated', 'Équipe mise à jour.'));
      } else {
        await apiClient.post('/teams', payload);
        toast.success(t('adminTeams.created', 'Équipe créée.'));
      }
      setCreating(false);
      await load();
    } catch (err) {
      toast.error(serverError(err, t('adminTeams.saveFailed', "L'enregistrement a échoué.")));
    } finally {
      setSaving(false);
    }
  }

  async function remove(team: Team) {
    if (!confirm(t('adminTeams.confirmDelete', "Supprimer l'équipe « {{name}} » ?", { name: team.name }))) {
      return;
    }
    try {
      await apiClient.delete(`/teams/${team.id}`);
      toast.success(t('adminTeams.deleted', 'Équipe supprimée.'));
      await load();
    } catch (err) {
      toast.error(serverError(err, t('adminTeams.deleteFailed', 'La suppression a échoué.')));
    }
  }

  async function openMembers(team: Team) {
    setMembersFor(team);
    setMembers([]);
    setSelectedMembers([]);
    try {
      const [membersRes, tenantRes] = await Promise.all([
        apiClient.get<{ success: true; data: TeamMember[] }>(`/teams/${team.id}/members`),
        apiClient.get<{ success: true; data: TenantMember[] }>('/users', { params: { limit: 200 } }),
      ]);
      setMembers(membersRes.data.data);
      setSelectedMembers(membersRes.data.data.map((member) => member.userId));
      setTenantMembers(tenantRes.data.data);
    } catch (err) {
      toast.error(serverError(err, t('adminTeams.membersFailed', 'Impossible de charger les membres.')));
    }
  }

  async function saveMembers() {
    if (!membersFor) return;
    try {
      await apiClient.put(`/teams/${membersFor.id}/members`, { userIds: selectedMembers });
      toast.success(t('adminTeams.membersSaved', 'Membres enregistrés.'));
      setMembersFor(null);
      await load();
    } catch (err) {
      toast.error(serverError(err, t('adminTeams.membersSaveFailed', "L'enregistrement a échoué.")));
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

  // What the selection REALLY grants once `implies` is closed — shown live, so
  // the surprise happens before the save and not in a support ticket.
  const effective = expandCapabilities(capabilities);
  const implied = effective.filter((capability) => !capabilities.includes(capability));

  return (
    <div className="space-y-5 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-wide text-text-primary">
            <UsersRound size={22} className="text-accent" />
            {t('adminTeams.pageTitle', 'Équipes')}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {t('adminTeams.pageDesc', 'Regroupez les agents et accordez des permissions collectivement.')}
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus size={14} className="mr-1" />
          {t('adminTeams.create', 'Nouvelle équipe')}
        </Button>
      </header>

      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : teams.length === 0 ? (
        <p className="rounded-card bg-bg-secondary px-5 py-12 text-center text-sm text-text-muted shadow-card">
          {t('adminTeams.empty', 'Aucune équipe pour le moment.')}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {teams.map((team) => (
            <article key={team.id} className="space-y-3 rounded-card bg-bg-secondary p-4 shadow-card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-display text-base font-semibold text-text-primary">
                    {team.name}
                  </h2>
                  {team.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-text-muted">{team.description}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    title={t('adminTeams.members', 'Membres')}
                    onClick={() => void openMembers(team)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                  >
                    <Users size={13} />
                    {team.memberCount ?? 0}
                  </button>
                  <button
                    type="button"
                    title={t('common.edit', 'Modifier')}
                    onClick={() => openEdit(team)}
                    className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    title={t('common.delete', 'Supprimer')}
                    onClick={() => void remove(team)}
                    className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-status-cancelled"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-1">
                {team.capabilities.length === 0 ? (
                  <span className="text-xs text-text-muted">
                    {t('adminTeams.noCapabilities', 'Aucune permission accordée')}
                  </span>
                ) : (
                  team.capabilities.map((capability) => (
                    <span
                      key={capability}
                      className="rounded-pill bg-accent/10 px-2 py-0.5 font-mono text-[11px] text-accent"
                    >
                      {capability}
                    </span>
                  ))
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {/* ── Create / edit ────────────────────────────────────────────────── */}
      {creating && (
        <Panel
          title={editing ? t('adminTeams.editTitle', "Modifier l'équipe") : t('adminTeams.createTitle', 'Nouvelle équipe')}
          icon={<UsersRound size={16} className="text-accent" />}
          onClose={() => setCreating(false)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                {t('common.cancel', 'Annuler')}
              </Button>
              <Button size="sm" loading={saving} onClick={() => void save()}>
                {t('common.save', 'Enregistrer')}
              </Button>
            </>
          }
        >
          <Input
            label={t('adminTeams.name', 'Nom')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
          />
          <Input
            label={t('adminTeams.description', 'Description')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <div className="space-y-3">
            <span className="block text-sm font-medium text-text-secondary">
              {t('adminTeams.capabilities', 'Permissions accordées')}
            </span>

            {CAPABILITY_GROUPS.map((group: CapabilityGroup) => {
              const entries = CAPABILITY_CATALOG.filter((entry) => entry.group === group);
              if (entries.length === 0) return null;
              const groupLabel = CAPABILITY_GROUP_LABELS[group];
              return (
                <div key={group} className="space-y-1.5">
                  <p className="text-[11px] uppercase tracking-wide text-text-muted">
                    {t(groupLabel.key, groupLabel.fallback)}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {entries.map((entry) => {
                      const held = capabilities.includes(entry.key);
                      const inherited = !held && implied.includes(entry.key);
                      return (
                        <button
                          key={entry.key}
                          type="button"
                          title={entry.description}
                          onClick={() => toggleCapability(entry.key)}
                          className={cn(
                            'flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs transition-colors',
                            held && 'bg-accent text-white',
                            inherited && 'bg-accent/10 text-accent',
                            !held && !inherited && 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                            entry.sensitive && !held && !inherited && 'text-priority-p2',
                          )}
                        >
                          {held && <Check size={11} />}
                          {t(entry.labelKey, entry.label)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {implied.length > 0 && (
              <p className="rounded-card bg-bg-tertiary px-3 py-2 text-xs text-text-muted">
                {t(
                  'adminTeams.impliedHint',
                  'Ces permissions sont également accordées par implication : {{list}}',
                  { list: implied.join(', ') },
                )}
              </p>
            )}
          </div>
        </Panel>
      )}

      {/* ── Members ──────────────────────────────────────────────────────── */}
      {membersFor && (
        <Panel
          title={t('adminTeams.membersTitle', 'Membres de {{name}}', { name: membersFor.name })}
          icon={<Users size={16} className="text-accent" />}
          onClose={() => setMembersFor(null)}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setMembersFor(null)}>
                {t('common.cancel', 'Annuler')}
              </Button>
              <Button size="sm" onClick={() => void saveMembers()}>
                {t('common.save', 'Enregistrer')}
              </Button>
            </>
          }
        >
          {tenantMembers.length === 0 ? (
            <p className="text-sm text-text-muted">
              {t('adminTeams.noTenantMembers', "Aucun compte dans cette organisation.")}
            </p>
          ) : (
            <div className="space-y-1">
              {tenantMembers.map((member) => {
                const checked = selectedMembers.includes(member.id);
                return (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() =>
                      setSelectedMembers((prev) =>
                        checked ? prev.filter((id) => id !== member.id) : [...prev, member.id],
                      )
                    }
                    className={cn(
                      'flex w-full items-center gap-3 rounded-card px-3 py-2 text-left transition-colors',
                      checked ? 'bg-accent/10' : 'bg-bg-tertiary hover:bg-bg-hover',
                    )}
                  >
                    <input type="checkbox" checked={checked} readOnly className="h-4 w-4 accent-accent" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-text-primary">
                        {member.displayName || member.username}
                      </span>
                      <span className="block truncate font-mono text-xs text-text-muted">
                        {member.username}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {members.length > 0 && (
            <p className="text-xs text-text-muted">
              {t('adminTeams.currentCount', '{{count}} membre(s) actuellement.', { count: members.length })}
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}

export default AdminTeamsPage;
