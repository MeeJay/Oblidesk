/**
 * AssetOverlayEditor.tsx — the desk's own attributes on a machine.
 *
 * ── What an overlay is for ──────────────────────────────────────────────────
 * `ci_overlays` is where Oblidesk stores facts that are genuinely ITS: the
 * asset tag stuck on the case, the purchase order, the room the desk agreed to
 * call it. Arbitrary key/value, deliberately, because the alternative is a
 * schema migration every time a customer has one more column than the last one.
 *
 * ── What an overlay is NOT for ──────────────────────────────────────────────
 * It is not a place to copy a sibling app's attribute. Writing `os_version`
 * here creates a second answer that drifts from Obliance's within a week, and
 * nobody downstream can tell which of the two is the real one. The warning
 * under the add row says exactly that, because this is the one control in the
 * module that makes it easy to do the wrong thing.
 *
 * ── Values, and why the JSON switch exists ──────────────────────────────────
 * The server accepts any JSON value. Typing `42` and getting the number 42 when
 * you meant the string "42" is the kind of surprise that costs an hour later,
 * so the default is: what you type is stored as text. The JSON switch is the
 * explicit way to store a number, a boolean, a list or an object, and a value
 * that arrives as one already opens in that mode.
 *
 * Deleting is `PUT` with no `value` key at all, which is what the route reads to
 * tell "set it to null" from "remove the pair".
 *
 * HARD RULE 11 — no border on the card or the rows.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import { AlertTriangle, Plus, Tags, Trash2 } from 'lucide-react';
import type { CiOverlay } from '@oblidesk/shared';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';

/** Mirrors `setOverlaySchema` in the server's validators. */
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/;

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value);
}

function isJsonValue(value: unknown): boolean {
  return typeof value !== 'string';
}

function serverError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

export interface AssetOverlayEditorProps {
  ciId: number;
  overlays: CiOverlay[];
  /** CI_RW. Without it the pairs are facts on screen, not fields. */
  canEdit: boolean;
  /** Handed the full overlay list the server echoed back. */
  onChanged: (overlays: CiOverlay[]) => void;
  className?: string;
}

export function AssetOverlayEditor({
  ciId,
  overlays,
  canEdit,
  onChanged,
  className,
}: AssetOverlayEditorProps): JSX.Element {
  const { t } = useTranslation();

  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newJson, setNewJson] = useState(false);
  const [adding, setAdding] = useState(false);

  async function put(key: string, value: unknown, remove = false): Promise<void> {
    const body = remove ? { key } : { key, value };
    const res = await apiClient.put<{ success: true; data: CiOverlay[] }>(
      `/ci/${ciId}/overlay`,
      body,
    );
    onChanged(res.data.data);
  }

  async function add(): Promise<void> {
    const key = newKey.trim();
    if (!KEY_PATTERN.test(key) || key.length > 128) {
      toast.error(
        t(
          'assets.overlayKeyInvalid',
          'Une clé se compose de lettres, de chiffres, de points, de deux-points, de tirets et de soulignés, et commence par une lettre ou un chiffre.',
        ),
      );
      return;
    }

    let value: unknown = newValue;
    if (newJson) {
      try {
        value = JSON.parse(newValue) as unknown;
      } catch {
        toast.error(t('assets.overlayJsonInvalid', 'Cette valeur JSON est illisible.'));
        return;
      }
    }

    setAdding(true);
    try {
      await put(key, value);
      setNewKey('');
      setNewValue('');
      setNewJson(false);
    } catch (err) {
      toast.error(serverError(err, t('assets.overlaySaveFailed', 'L’enregistrement a échoué.')));
    } finally {
      setAdding(false);
    }
  }

  return (
    <section className={clsx('rounded-card bg-bg-secondary p-5 shadow-card', className)}>
      <header>
        <h2 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
          <Tags size={12} aria-hidden />
          {t('assets.overlays', 'Attributs Oblidesk')}
        </h2>
        <p className="mt-1.5 text-[11px] leading-snug text-text-muted">
          {t(
            'assets.overlaysNote',
            'Des paires libres que le bureau possède réellement : numéro d’inventaire, bon de commande, emplacement convenu.',
          )}
        </p>
      </header>

      {overlays.length === 0 ? (
        <p className="mt-3 rounded-card bg-bg-tertiary p-3 text-[12px] text-text-muted">
          {t('assets.noOverlays', 'Aucun attribut Oblidesk sur cet actif.')}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {overlays.map((overlay) => (
            <OverlayRow
              key={overlay.key}
              overlay={overlay}
              canEdit={canEdit}
              onSave={(value) => put(overlay.key, value)}
              onRemove={() => put(overlay.key, undefined, true)}
            />
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="mt-3 rounded-card bg-bg-tertiary p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[10rem] flex-1 space-y-1">
              <span className="block text-[10px] uppercase tracking-wide text-text-muted">
                {t('assets.overlayKey', 'Clé')}
              </span>
              <input
                value={newKey}
                onChange={(event) => setNewKey(event.target.value)}
                placeholder="asset_tag"
                className="w-full rounded-md bg-bg-secondary px-3 py-2 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </label>

            <label className="min-w-[12rem] flex-[2] space-y-1">
              <span className="block text-[10px] uppercase tracking-wide text-text-muted">
                {t('assets.overlayValue', 'Valeur')}
              </span>
              <input
                value={newValue}
                onChange={(event) => setNewValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void add();
                  }
                }}
                placeholder={newJson ? '{"site": "Lyon"}' : 'PC-0412'}
                className="w-full rounded-md bg-bg-secondary px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </label>

            <JsonSwitch active={newJson} onToggle={() => setNewJson((value) => !value)} />

            <Button
              size="sm"
              loading={adding}
              disabled={newKey.trim() === ''}
              icon={<Plus size={14} />}
              onClick={() => void add()}
            >
              {t('assets.addOverlay', 'Ajouter un attribut')}
            </Button>
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-text-muted">
            <AlertTriangle size={12} className="mt-0.5 shrink-0 text-sla-warn" aria-hidden />
            {t(
              'assets.overlaysWarning',
              'N’y recopiez pas un attribut d’une application sœur (système, version, disque) : la copie divergera et personne ne saura laquelle des deux dit vrai.',
            )}
          </p>
        </div>
      )}
    </section>
  );
}

function OverlayRow({
  overlay,
  canEdit,
  onSave,
  onRemove,
}: {
  overlay: CiOverlay;
  canEdit: boolean;
  onSave: (value: unknown) => Promise<void>;
  onRemove: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();

  const [json, setJson] = useState(() => isJsonValue(overlay.value));
  const [draft, setDraft] = useState(() => toText(overlay.value));
  const [busy, setBusy] = useState(false);

  // A save elsewhere (or a reload of the CI) replaces the row's text.
  useEffect(() => {
    setDraft(toText(overlay.value));
    setJson(isJsonValue(overlay.value));
  }, [overlay.value]);

  const dirty = draft !== toText(overlay.value) || json !== isJsonValue(overlay.value);

  async function commit(): Promise<void> {
    if (!dirty) return;

    let value: unknown = draft;
    if (json) {
      try {
        value = JSON.parse(draft) as unknown;
      } catch {
        toast.error(t('assets.overlayJsonInvalid', 'Cette valeur JSON est illisible.'));
        return;
      }
    }

    setBusy(true);
    try {
      await onSave(value);
    } catch (err) {
      toast.error(serverError(err, t('assets.overlaySaveFailed', 'L’enregistrement a échoué.')));
      setDraft(toText(overlay.value));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    try {
      await onRemove();
    } catch (err) {
      toast.error(serverError(err, t('assets.overlayRemoveFailed', 'La suppression a échoué.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-card bg-bg-tertiary p-2.5">
      <span className="min-w-[8rem] shrink-0 truncate font-mono text-[12px] text-text-secondary" title={overlay.key}>
        {overlay.key}
      </span>

      {canEdit ? (
        <>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void commit();
              }
              if (event.key === 'Escape') setDraft(toText(overlay.value));
            }}
            disabled={busy}
            className={clsx(
              'min-w-[10rem] flex-1 rounded-md bg-bg-secondary px-2.5 py-1.5 text-[13px] text-text-primary focus:outline-none focus:ring-2 focus:ring-accent',
              json && 'font-mono',
            )}
          />
          <JsonSwitch active={json} onToggle={() => setJson((value) => !value)} />
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            title={t('assets.removeOverlay', 'Retirer cet attribut')}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-status-cancelled"
          >
            <Trash2 size={13} />
          </button>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary" title={toText(overlay.value)}>
          {toText(overlay.value)}
        </span>
      )}
    </li>
  );
}

function JsonSwitch({ active, onToggle }: { active: boolean; onToggle: () => void }): JSX.Element {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      title={t('assets.overlayJsonHint', 'Interpréter la valeur comme du JSON (nombre, booléen, liste, objet).')}
      className={clsx(
        'h-8 shrink-0 rounded-pill px-2.5 font-mono text-[11px] transition-colors',
        active ? 'bg-accent/12 text-accent' : 'bg-bg-secondary text-text-muted hover:text-text-secondary',
      )}
    >
      JSON
    </button>
  );
}

export default AssetOverlayEditor;
