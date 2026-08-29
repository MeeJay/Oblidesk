/**
 * AssetIdentityCard.tsx — what the desk owns about a machine, and only that.
 *
 * ── The whole product decision, in one card ─────────────────────────────────
 * Oblidesk is not a CMDB. It stores ONE identity key (`cis.hardware_uuid`) and
 * three desk-owned fields (owner, criticality, support group), plus whatever
 * arbitrary pairs the desk adds as overlays. Everything else about this machine
 * — its disk, its patch level, its uptime, its bans — is read through to the
 * owning app at render time and shown with a visible "last read" stamp.
 *
 * So this card is split in two, visibly:
 *
 *   • IDENTITY, read only. The hardware UUID is the join key the whole suite
 *     agrees on; it is displayed, never edited. There is no uuid -> mac -> fqdn
 *     -> hostname fallback anywhere in this module, because identity
 *     reconciliation is what produces collisions, split identities and a merge
 *     queue, and refusing to inherit that disease is the point.
 *   • DESK FIELDS, editable. These three are the ONLY attributes of a machine
 *     Oblidesk claims to be the source of truth for. A technician who needs the
 *     hostname or the RAM changed is asking the wrong application: that fix is
 *     in Obliance, and a local copy here would be a second answer nobody could
 *     tell from the first.
 *
 * ── Why owner and support group are numeric ids on screen ───────────────────
 * `owner_contact_id` and `support_group_id` are foreign keys, and this server
 * exposes no contact directory and no assignment-group list endpoint yet, so
 * there is nothing to resolve a name from. The card says that in plain words
 * rather than showing an empty picker that looks broken, or worse, guessing.
 *
 * HARD RULE 11 — no border. Depth is the background step plus the card shadow.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import { Fingerprint, Server, ShieldAlert, Users } from 'lucide-react';
import type { Ci, CiCriticality } from '@oblidesk/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import {
  CI_CRITICALITIES,
  CI_CRITICALITY_LABELS,
  CI_KIND_LABELS,
  CiCriticalityBadge,
} from '@/components/assets/AssetTable';
import { formatAbsolute, formatRelative } from '@/components/tickets/SlaChip';

interface DeskFields {
  criticality: CiCriticality | null;
  ownerContactId: number | null;
  supportGroupId: number | null;
}

function fieldsOf(ci: Ci): DeskFields {
  return {
    criticality: ci.criticality ?? null,
    ownerContactId: ci.ownerContactId ?? null,
    supportGroupId: ci.supportGroupId ?? null,
  };
}

/** An empty box is "no owner"; anything unparseable keeps the previous value. */
function toIdOrNull(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function serverError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

export interface AssetIdentityCardProps {
  ci: Ci;
  /** CI_RW. Without it the fields render as facts, not inputs. */
  canEdit: boolean;
  /**
   * Handed the CI the server echoed back, so the page stays in step without a
   * second round trip. It is the BARE `cis` row: the PATCH does not re-join the
   * source links, the overlays or the ticket count, so the caller merges rather
   * than replaces.
   */
  onSaved: (ci: Ci) => void;
  className?: string;
}

export function AssetIdentityCard({
  ci,
  canEdit,
  onSaved,
  className,
}: AssetIdentityCardProps): JSX.Element {
  const { t } = useTranslation();

  const [draft, setDraft] = useState<DeskFields>(() => fieldsOf(ci));
  const [saving, setSaving] = useState(false);

  // A refresh of the CI (a save elsewhere, a retry) replaces the draft. The
  // dependency is the id AND the three values, so re-reading the same CI does
  // not silently discard an edit in progress on a different one.
  useEffect(() => {
    setDraft(fieldsOf(ci));
  }, [ci.id, ci.criticality, ci.ownerContactId, ci.supportGroupId]);

  const saved = fieldsOf(ci);
  const dirty =
    draft.criticality !== saved.criticality ||
    draft.ownerContactId !== saved.ownerContactId ||
    draft.supportGroupId !== saved.supportGroupId;

  const kindLabel = CI_KIND_LABELS[ci.kind] ?? { key: 'assets.kinds.other', fallback: 'Autre' };

  async function save(): Promise<void> {
    // Send only what moved: PATCH must be able to say "leave the owner alone",
    // and the server refuses a body with no keys at all.
    const patch: Record<string, unknown> = {};
    if (draft.criticality !== saved.criticality) patch.criticality = draft.criticality;
    if (draft.ownerContactId !== saved.ownerContactId) patch.ownerContactId = draft.ownerContactId;
    if (draft.supportGroupId !== saved.supportGroupId) patch.supportGroupId = draft.supportGroupId;
    if (Object.keys(patch).length === 0) return;

    setSaving(true);
    try {
      const res = await apiClient.patch<{ success: true; data: Ci }>(`/ci/${ci.id}`, patch);
      onSaved(res.data.data);
      toast.success(t('assets.deskFieldsSaved', 'Champs Oblidesk enregistrés.'));
    } catch (err) {
      toast.error(
        serverError(err, t('assets.deskFieldsFailed', 'L’enregistrement a échoué.')),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={clsx('rounded-card bg-bg-secondary p-5 shadow-card', className)}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-wide text-text-primary">
            <Server size={18} className="shrink-0 text-accent" aria-hidden />
            <span className="truncate">{ci.displayName}</span>
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
            <span className="rounded-pill bg-bg-tertiary px-2 py-0.5 text-text-secondary">
              {t(kindLabel.key, kindLabel.fallback)}
            </span>
            <CiCriticalityBadge criticality={ci.criticality ?? null} />
            {ci.deletedAt && (
              <span className="rounded-pill bg-status-cancelled-bg px-2 py-0.5 text-status-cancelled">
                {t('assets.retiredOn', 'Retiré le {{date}}', {
                  date: formatAbsolute(ci.deletedAt),
                })}
              </span>
            )}
          </p>
        </div>
      </header>

      {/* ── Identity: read only, on purpose ──────────────────────────────── */}
      <div className="mt-4 rounded-card bg-bg-tertiary p-3">
        <h3 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
          <Fingerprint size={12} aria-hidden />
          {t('assets.identity', 'Identité')}
        </h3>

        <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <Fact label={t('assets.hardwareUuid', 'UUID matériel')}>
            <span className="break-all font-mono text-[12px] text-text-primary">
              {ci.hardwareUuid ?? t('assets.noUuid', 'sans UUID matériel')}
            </span>
          </Fact>
          <Fact label={t('assets.ciId', 'Identifiant Oblidesk')}>
            <span className="font-mono text-[12px] text-text-secondary">#{ci.id}</span>
          </Fact>
          <Fact label={t('assets.firstSeen', 'Vu pour la première fois')}>
            <span className="text-[12px] text-text-secondary" title={formatAbsolute(ci.firstSeenAt)}>
              {formatRelative(ci.firstSeenAt, t)}
            </span>
          </Fact>
          <Fact label={t('assets.lastSeen', 'Vu pour la dernière fois')}>
            <span className="text-[12px] text-text-secondary" title={formatAbsolute(ci.lastSeenAt)}>
              {formatRelative(ci.lastSeenAt, t)}
            </span>
          </Fact>
        </dl>

        <p className="mt-2.5 text-[11px] leading-snug text-text-muted">
          {t(
            'assets.identityNote',
            'L’UUID matériel est la seule clé de rapprochement de la suite. Oblidesk ne rapproche jamais une machine par adresse MAC, par nom DNS ou par nom d’hôte.',
          )}
        </p>
      </div>

      {/* ── Desk-owned fields ────────────────────────────────────────────── */}
      <div className="mt-4">
        <h3 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
          <ShieldAlert size={12} aria-hidden />
          {t('assets.deskFields', 'Champs détenus par Oblidesk')}
        </h3>
        <p className="mt-1.5 text-[11px] leading-snug text-text-muted">
          {t(
            'assets.deskFieldsNote',
            'Ces champs sont les seuls dont Oblidesk est la source. Tout le reste (matériel, logiciels, correctifs) appartient à l’application qui le produit : la correction se fait là-bas, jamais ici.',
          )}
        </p>

        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <label className="space-y-1">
            <span className="block text-[12px] font-medium text-text-secondary">
              {t('assets.criticality', 'Criticité')}
            </span>
            {canEdit ? (
              <select
                value={draft.criticality ?? ''}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    criticality: (event.target.value || null) as CiCriticality | null,
                  }))
                }
                className="w-full rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">{t('assets.criticalityUnset', 'non définie')}</option>
                {CI_CRITICALITIES.map((level) => (
                  <option key={level} value={level}>
                    {t(CI_CRITICALITY_LABELS[level].key, CI_CRITICALITY_LABELS[level].fallback)}
                  </option>
                ))}
              </select>
            ) : (
              <div className="pt-1">
                <CiCriticalityBadge criticality={ci.criticality ?? null} />
              </div>
            )}
          </label>

          <IdField
            label={t('assets.ownerContact', 'Contact propriétaire')}
            value={draft.ownerContactId}
            saved={saved.ownerContactId}
            canEdit={canEdit}
            onChange={(next) => setDraft((current) => ({ ...current, ownerContactId: next }))}
          />

          <IdField
            label={t('assets.supportGroup', 'Groupe d’assistance')}
            value={draft.supportGroupId}
            saved={saved.supportGroupId}
            canEdit={canEdit}
            onChange={(next) => setDraft((current) => ({ ...current, supportGroupId: next }))}
          />
        </div>

        {canEdit && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-text-muted">
            <Users size={11} className="shrink-0" aria-hidden />
            {t(
              'assets.idFieldHint',
              'Ces deux champs se saisissent par identifiant numérique : ce serveur n’expose pas encore d’annuaire des contacts ni des groupes. Laisser vide pour effacer.',
            )}
          </p>
        )}

        {canEdit && dirty && (
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDraft(fieldsOf(ci))}>
              {t('common.cancel', 'Annuler')}
            </Button>
            <Button size="sm" loading={saving} onClick={() => void save()}>
              {t('common.save', 'Enregistrer')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="mt-0.5 min-w-0">{children}</dd>
    </div>
  );
}

function IdField({
  label,
  value,
  saved,
  canEdit,
  onChange,
}: {
  label: string;
  value: number | null;
  saved: number | null;
  canEdit: boolean;
  onChange: (next: number | null) => void;
}): JSX.Element {
  const { t } = useTranslation();

  if (!canEdit) {
    return (
      <div className="space-y-1">
        <span className="block text-[12px] font-medium text-text-secondary">{label}</span>
        <span className="font-mono text-[12px] text-text-primary">
          {saved === null ? t('assets.unassigned', 'non renseigné') : `#${saved}`}
        </span>
      </div>
    );
  }

  return (
    <label className="space-y-1">
      <span className="block text-[12px] font-medium text-text-secondary">{label}</span>
      <input
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        value={value === null ? '' : String(value)}
        onChange={(event) => {
          const next = toIdOrNull(event.target.value);
          // `undefined` means the box holds something that is not an id yet
          // (a lone minus sign, a zero). Keep the previous value rather than
          // writing a nonsense one.
          if (next !== undefined) onChange(next);
        }}
        placeholder={t('assets.unassigned', 'non renseigné')}
        className="w-full rounded-md bg-bg-tertiary px-3 py-2 font-mono text-sm text-text-primary placeholder:font-sans placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
      />
    </label>
  );
}

export default AssetIdentityCard;
