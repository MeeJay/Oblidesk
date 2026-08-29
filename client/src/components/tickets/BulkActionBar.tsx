/**
 * BulkActionBar.tsx — preview → apply → report → undo.
 *
 * ── The preview is not optional ─────────────────────────────────────────────
 * A bulk edit is the only action on this desk that can be wrong 400 times in
 * one click. So the "Appliquer" button does not exist until the server has
 * answered `POST /tickets/bulk/preview` and the agent has read the DIFF TABLE:
 * one line per (field, before → after) pair, with the number of tickets each
 * line covers, plus every ticket the server refuses and why. Firing a bulk
 * action without that table on screen is a defect, not a shortcut — which is
 * why `apply` is reachable only from inside the preview dialog.
 *
 * ── Partial failure is a first-class outcome ────────────────────────────────
 * `bulkApply` returns three lists: `updated`, `conflicted` (somebody changed
 * the row between the preview and the apply — HARD RULE 7 caught it) and
 * `failed`. All three are reported. "312 tickets modifiés" when 41 of them
 * silently conflicted is the exact lie this report exists to prevent, and a
 * conflicted row is re-selectable so the agent can re-run it against the fresh
 * version rather than hunting for which ones missed.
 *
 * ── Undo is ten real minutes ────────────────────────────────────────────────
 * The server hands back an `undoToken` valid for `LIMITS.bulkUndoWindowMs`. The
 * toast lives exactly that long and its button calls `bulkUndo`. A three-second
 * toast on a 400-ticket edit is decoration; ten minutes is enough time to walk
 * to somebody's desk, be told it was wrong, and walk back.
 *
 * HARD RULE 11 — no border on the bar, the dialog or any control in it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  Check,
  Loader2,
  ShieldAlert,
  Undo2,
  X,
} from 'lucide-react';
import { LIMITS } from '@oblidesk/shared';
import type { BulkTicketResult, TicketImpact, TicketUrgency } from '@oblidesk/shared';
import { errorMessage } from '@/api/client';
import { configApi } from '@/api/config.api';
import { ticketsApi, type BulkPatch, type BulkPreview } from '@/api/tickets.api';
import { usersApi } from '@/api/users.api';
import { Modal } from '@/components/common/Modal';
import { useTenantStore } from '@/store/tenantStore';
import { useTicketStore } from '@/store/ticketStore';
import { formatNumber } from '@/utils/format';

// ═════════════════════════════════════════════════════════════════════════════
// The editable fields
// ═════════════════════════════════════════════════════════════════════════════

export interface Option {
  value: string;
  label: string;
}

/**
 * The three pickers a ticket edit needs, fetched once per tenant.
 *
 * Exported because the detail page's inline fields need exactly the same three
 * lists: two copies of this loader would mean two round-trips for the same data
 * every time an agent opens a ticket with a selection still on the queue.
 *
 * The cache is KEYED ON THE TENANT. A platform admin switching tenants must not
 * be offered tenant A's queues while writing to tenant B — a bulk edit that
 * lands on a queue slug that does not exist here is a 400 at best and a
 * misrouted backlog at worst.
 */
export interface TicketFieldOptions {
  queues: Option[];
  priorities: Option[];
  agents: Option[];
}

const EMPTY_OPTIONS: TicketFieldOptions = { queues: [], priorities: [], agents: [] };

let optionsCache: { tenantId: number | null; promise: Promise<TicketFieldOptions> } | null = null;

/** Localised config label: `{ fr, en }` in the body, or a bare string. */
function localized(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  const bag = value as { fr?: string; en?: string } | null | undefined;
  return bag?.fr?.trim() || bag?.en?.trim() || fallback;
}

export function loadTicketFieldOptions(): Promise<TicketFieldOptions> {
  const tenantId = useTenantStore.getState().currentTenantId;
  if (optionsCache && optionsCache.tenantId === tenantId) return optionsCache.promise;

  const promise = (async (): Promise<TicketFieldOptions> => {
    // Each list is independent: a tenant with no priority matrix must still get
    // the queue picker rather than an empty bar.
    const [queueList, matrixList, userPage] = await Promise.all([
      configApi.listKind('queue').catch(() => null),
      configApi.listKind('priority_matrix').catch(() => null),
      usersApi.list({ limit: 200 }).catch(() => null),
    ]);

    const priorities: Option[] = [];
    if (matrixList && matrixList.objects.length > 0) {
      const body = matrixList.objects[0].body as {
        priorities?: Array<{ slug: string; label?: unknown }>;
      };
      for (const spec of body.priorities ?? []) {
        priorities.push({ value: spec.slug, label: localized(spec.label, spec.slug) });
      }
    }

    return {
      queues: (queueList?.objects ?? []).map((object) => ({
        value: object.slug,
        label: object.name,
      })),
      priorities,
      agents: (userPage?.users ?? []).map((user) => ({
        value: String(user.id),
        label: user.displayName?.trim() || user.username,
      })),
    };
  })();

  optionsCache = { tenantId, promise };
  return promise;
}

/** Forget the cache — call after publishing a queue or a priority matrix. */
export function resetTicketFieldOptions(): void {
  optionsCache = null;
}

interface FieldState {
  queueSlug: string;
  prioritySlug: string;
  assigneeId: string;
  impact: string;
  urgency: string;
}

const EMPTY_FIELDS: FieldState = {
  queueSlug: '',
  prioritySlug: '',
  assigneeId: '',
  impact: '',
  urgency: '',
};

/** Impact and urgency share the same three hard-coded levels. */
const LEVELS: readonly TicketImpact[] = ['high', 'medium', 'low'];

const LEVEL_LABEL: Readonly<Record<TicketImpact, { key: string; fallback: string }>> = {
  high: { key: 'tickets.levels.high', fallback: 'Élevé' },
  medium: { key: 'tickets.levels.medium', fallback: 'Moyen' },
  low: { key: 'tickets.levels.low', fallback: 'Faible' },
};

/**
 * Only the fields the agent actually touched go into the patch. Sending
 * `{ assigneeId: null }` because a select happened to read "" is how a bulk
 * "change the queue" un-assigns four hundred tickets.
 */
function buildPatch(fields: FieldState): BulkPatch {
  const patch: BulkPatch = {};
  if (fields.queueSlug) patch.queueSlug = fields.queueSlug;
  if (fields.prioritySlug) patch.prioritySlug = fields.prioritySlug;
  if (fields.impact) patch.impact = fields.impact as TicketImpact;
  if (fields.urgency) patch.urgency = fields.urgency as TicketUrgency;
  if (fields.assigneeId === '__none__') patch.assigneeId = null;
  else if (fields.assigneeId) patch.assigneeId = Number(fields.assigneeId);
  return patch;
}

function patchIsEmpty(patch: BulkPatch): boolean {
  return Object.keys(patch).length === 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// Diff aggregation
// ═════════════════════════════════════════════════════════════════════════════

interface DiffLine {
  field: string;
  from: string;
  to: string;
  count: number;
  /** A sample of the ticket numbers this line covers, for the tooltip. */
  sample: string[];
}

function renderValue(value: unknown, none: string): string {
  if (value === null || value === undefined || value === '') return none;
  if (typeof value === 'boolean') return String(value);
  return String(value);
}

/**
 * Collapse the server's per-ticket diff into one line per distinct change.
 *
 * 400 identical rows are not information; "queue: support → réseau, 387
 * tickets / queue: escalade → réseau, 13 tickets" is. The two-line answer is
 * also where an agent notices they caught thirteen tickets they did not mean to.
 */
function aggregate(preview: BulkPreview, none: string): DiffLine[] {
  const lines = new Map<string, DiffLine>();

  for (const change of preview.changes) {
    const fields = new Set([...Object.keys(change.from), ...Object.keys(change.to)]);
    for (const field of fields) {
      const from = renderValue(change.from[field], none);
      const to = renderValue(change.to[field], none);
      if (from === to) continue;
      const key = `${field} ${from} ${to}`;
      const existing = lines.get(key);
      if (existing) {
        existing.count += 1;
        if (existing.sample.length < 6) existing.sample.push(change.number);
      } else {
        lines.set(key, { field, from, to, count: 1, sample: [change.number] });
      }
    }
  }

  return [...lines.values()].sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
}

// ═════════════════════════════════════════════════════════════════════════════
// Component
// ═════════════════════════════════════════════════════════════════════════════

export interface BulkActionBarProps {
  className?: string;
}

export default function BulkActionBar({ className }: BulkActionBarProps): JSX.Element | null {
  const { t } = useTranslation();

  const selectedIds = useTicketStore((state) => state.selectedIds);
  const clearSelection = useTicketStore((state) => state.clearSelection);
  const selectedRowVersions = useTicketStore((state) => state.selectedRowVersions);
  const refresh = useTicketStore((state) => state.refresh);

  const [fields, setFields] = useState<FieldState>(EMPTY_FIELDS);
  const [options, setOptions] = useState<TicketFieldOptions>(EMPTY_OPTIONS);

  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<BulkTicketResult | null>(null);

  const count = selectedIds.length;
  const patch = useMemo(() => buildPatch(fields), [fields]);
  const overLimit = count > LIMITS.bulkMaxTickets;

  const levelOptions = useMemo<Option[]>(
    () =>
      LEVELS.map((level) => ({
        value: level,
        label: t(LEVEL_LABEL[level].key, LEVEL_LABEL[level].fallback),
      })),
    [t],
  );

  // ── Option lists, loaded once the bar first appears ──────────────────────
  useEffect(() => {
    if (count === 0) return undefined;
    let cancelled = false;
    void loadTicketFieldOptions().then((loaded) => {
      if (!cancelled) setOptions(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [count]);

  // A change of selection invalidates a preview computed against the old one.
  useEffect(() => {
    setPreview(null);
    setError(null);
  }, [selectedIds]);

  const none = t('common.notSet', 'Non renseigné');

  const runPreview = useCallback(async () => {
    setPreviewing(true);
    setError(null);
    try {
      const result = await ticketsApi.bulkPreview(selectedIds, patch);
      setPreview(result);
    } catch (err) {
      setError(errorMessage(err, t('errors.generic', 'Une erreur est survenue.')));
    } finally {
      setPreviewing(false);
    }
  }, [selectedIds, patch, t]);

  const runApply = useCallback(async () => {
    if (!preview) return;
    setApplying(true);
    setError(null);
    try {
      // Per-ticket base versions — never one version for the batch (HARD RULE 7).
      const versions = selectedRowVersions();
      const result = await ticketsApi.bulkApply(preview.ticketIds, versions, patch);

      setReport(result);
      setPreview(null);
      await refresh();

      if (result.updated.length > 0) {
        showUndoToast(result, t);
      }
      if (result.conflicted.length === 0 && result.failed.length === 0) {
        // Nothing to review: drop the selection so the queue is clean again.
        clearSelection();
        setFields(EMPTY_FIELDS);
        setReport(null);
      }
    } catch (err) {
      setError(errorMessage(err, t('errors.generic', 'Une erreur est survenue.')));
    } finally {
      setApplying(false);
    }
  }, [preview, patch, selectedRowVersions, refresh, clearSelection, t]);

  /** Re-select only the rows that conflicted, so the retry is exactly them. */
  const reselectConflicted = useCallback(() => {
    if (!report) return;
    useTicketStore.setState({ selectedIds: report.conflicted.map((row) => row.ticketId) });
    setReport(null);
  }, [report]);

  if (count === 0) return null;

  const diffLines = preview ? aggregate(preview, none) : [];

  return (
    <>
      {/* ── The bar ───────────────────────────────────────────────────────── */}
      <div
        role="toolbar"
        aria-label={t('tickets.bulk.title', 'Action groupée')}
        className={clsx(
          'flex flex-wrap items-center gap-2 rounded-card bg-bg-tertiary px-3 py-2 shadow-card',
          className,
        )}
      >
        <span className="font-mono text-[12px] font-semibold tabular-nums text-accent">
          {t('tickets.bulk.selected', '{{count}} tickets sélectionnés', { count })}
        </span>

        <BulkSelect
          label={t('tickets.queue', 'File')}
          value={fields.queueSlug}
          options={options.queues}
          onChange={(value) => setFields((current) => ({ ...current, queueSlug: value }))}
          unchanged={t('tickets.bulk.unchanged', 'inchangé')}
        />

        <BulkSelect
          label={t('tickets.priority', 'Priorité')}
          value={fields.prioritySlug}
          options={options.priorities}
          onChange={(value) => setFields((current) => ({ ...current, prioritySlug: value }))}
          unchanged={t('tickets.bulk.unchanged', 'inchangé')}
        />

        <BulkSelect
          label={t('tickets.assignee', 'Assigné à')}
          value={fields.assigneeId}
          options={[
            { value: '__none__', label: t('tickets.unassign', 'Désassigner') },
            ...options.agents,
          ]}
          onChange={(value) => setFields((current) => ({ ...current, assigneeId: value }))}
          unchanged={t('tickets.bulk.unchanged', 'inchangé')}
        />

        <BulkSelect
          label={t('tickets.impact', 'Impact')}
          value={fields.impact}
          options={levelOptions}
          onChange={(value) => setFields((current) => ({ ...current, impact: value }))}
          unchanged={t('tickets.bulk.unchanged', 'inchangé')}
        />

        <BulkSelect
          label={t('tickets.urgency', 'Urgence')}
          value={fields.urgency}
          options={levelOptions}
          onChange={(value) => setFields((current) => ({ ...current, urgency: value }))}
          unchanged={t('tickets.bulk.unchanged', 'inchangé')}
        />

        <div className="ml-auto flex items-center gap-2">
          {overLimit && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-sla-warn">
              <AlertTriangle size={12} aria-hidden />
              {t('tickets.bulk.tooMany', 'Au-delà de {{count}} tickets, affinez d’abord le filtre.', {
                count: LIMITS.bulkMaxTickets,
              })}
            </span>
          )}

          {/* The ONLY path to `apply` starts here. */}
          <button
            type="button"
            disabled={previewing || patchIsEmpty(patch) || overLimit}
            onClick={() => void runPreview()}
            className="inline-flex items-center gap-1.5 rounded-pill bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg-primary transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {previewing && <Loader2 size={12} className="animate-spin" aria-hidden />}
            {t('tickets.bulk.preview', 'Prévisualiser')}
          </button>

          <button
            type="button"
            onClick={() => {
              clearSelection();
              setFields(EMPTY_FIELDS);
            }}
            aria-label={t('common.deselectAll', 'Tout désélectionner')}
            className="rounded-pill bg-bg-secondary p-1.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <X size={13} aria-hidden />
          </button>
        </div>

        {error && (
          <p className="w-full text-[11px] text-sla-breach" role="alert">
            {error}
          </p>
        )}
      </div>

      {/* ── The diff table ────────────────────────────────────────────────── */}
      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        size="xl"
        title={t('tickets.bulk.previewTitle', 'Ce qui va changer')}
        subtitle={t(
          'tickets.bulk.previewSubtitle',
          '{{count}} tickets concernés. Relisez avant d’appliquer.',
          { count: preview?.changes.length ?? 0 },
        )}
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-[11px] text-text-muted">
              {t(
                'tickets.bulk.undoWindow',
                'Annulable pendant {{minutes}} minutes après l’application.',
                { minutes: Math.round(LIMITS.bulkUndoWindowMs / 60_000) },
              )}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="rounded-pill bg-bg-tertiary px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover"
              >
                {t('common.cancel', 'Annuler')}
              </button>
              <button
                type="button"
                disabled={applying || (preview?.changes.length ?? 0) === 0}
                onClick={() => void runApply()}
                className="inline-flex items-center gap-1.5 rounded-pill bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg-primary transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {applying && <Loader2 size={12} className="animate-spin" aria-hidden />}
                {t('tickets.bulk.apply', 'Appliquer')}
              </button>
            </div>
          </div>
        }
      >
        {preview && (
          <div className="flex flex-col gap-4">
            {diffLines.length === 0 ? (
              <p className="rounded-card bg-bg-tertiary px-3 py-6 text-center text-[12px] text-text-muted">
                {t(
                  'tickets.bulk.noChange',
                  'Aucun de ces tickets ne changerait : ils portent déjà ces valeurs.',
                )}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.1em] text-text-muted">
                      <th className="px-2 py-1.5 font-medium">{t('tickets.conflict.field', 'Champ')}</th>
                      <th className="px-2 py-1.5 font-medium">
                        {t('tickets.bulk.columnBefore', 'Avant')}
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        {t('tickets.bulk.columnAfter', 'Après')}
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        {t('tickets.bulk.columnCount', 'Tickets')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffLines.map((line) => (
                      <tr
                        key={`${line.field}:${line.from}:${line.to}`}
                        className="odd:bg-bg-tertiary/40"
                        title={line.sample.join(', ')}
                      >
                        <td className="px-2 py-1.5 font-mono text-[11px] text-text-secondary">
                          {line.field}
                        </td>
                        <td className="px-2 py-1.5 text-text-muted line-through decoration-text-muted/50">
                          {line.from}
                        </td>
                        <td className="px-2 py-1.5 font-medium text-accent">{line.to}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-text-primary">
                          {formatNumber(line.count)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Tickets the server will not touch, and the reason for each. */}
            {preview.blocked.length > 0 && (
              <section className="rounded-card bg-sla-warn-bg p-3">
                <h4 className="flex items-center gap-1.5 text-[11px] font-semibold text-sla-warn">
                  <ShieldAlert size={13} aria-hidden />
                  {t('tickets.bulk.blockedCount', '{{count}} tickets ne seront pas modifiés', {
                    count: preview.blocked.length,
                  })}
                </h4>
                <ul className="mt-2 flex flex-col gap-1">
                  {preview.blocked.slice(0, 25).map((row) => (
                    <li key={row.ticketId} className="flex gap-2 text-[11px] text-text-secondary">
                      <span className="shrink-0 font-mono text-text-muted">#{row.ticketId}</span>
                      <span>{row.reason}</span>
                    </li>
                  ))}
                </ul>
                {preview.blocked.length > 25 && (
                  <p className="mt-1.5 text-[11px] text-text-muted">
                    {t('tickets.bulk.blockedMore', '… et {{count}} autres.', {
                      count: preview.blocked.length - 25,
                    })}
                  </p>
                )}
              </section>
            )}
          </div>
        )}
      </Modal>

      {/* ── The partial-failure report ────────────────────────────────────── */}
      <Modal
        open={report !== null}
        onClose={() => {
          setReport(null);
          clearSelection();
          setFields(EMPTY_FIELDS);
        }}
        size="lg"
        title={t('tickets.bulk.reportTitle', 'Résultat de l’action groupée')}
      >
        {report && (
          <div className="flex flex-col gap-3 text-[12px]">
            <p className="inline-flex items-center gap-2 text-sla-ok">
              <Check size={14} aria-hidden />
              {t('tickets.bulk.applied', '{{count}} tickets modifiés.', {
                count: report.updated.length,
              })}
            </p>

            {report.conflicted.length > 0 && (
              <section className="rounded-card bg-sla-warn-bg p-3">
                <h4 className="text-[11px] font-semibold text-sla-warn">
                  {t('tickets.bulk.conflictedCount', '{{count}} tickets ont changé entre-temps', {
                    count: report.conflicted.length,
                  })}
                </h4>
                <p className="mt-1 text-[11px] text-text-secondary">
                  {t(
                    'tickets.bulk.conflictedHelp',
                    'Quelqu’un les a modifiés après la prévisualisation, ils n’ont donc pas été touchés. Rien n’a été écrasé.',
                  )}
                </p>
                <button
                  type="button"
                  onClick={reselectConflicted}
                  className="mt-2 rounded-pill bg-accent px-2.5 py-1 text-[11px] font-semibold text-bg-primary hover:bg-accent-hover"
                >
                  {t('tickets.bulk.reselectConflicted', 'Ne sélectionner que ceux-là')}
                </button>
              </section>
            )}

            {report.failed.length > 0 && (
              <section className="rounded-card bg-sla-breach-bg p-3">
                <h4 className="text-[11px] font-semibold text-sla-breach">
                  {t('tickets.bulk.failedCount', '{{count}} tickets en échec', {
                    count: report.failed.length,
                  })}
                </h4>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {report.failed.slice(0, 25).map((row) => (
                    <li key={row.ticketId} className="flex gap-2 text-[11px] text-text-secondary">
                      <span className="shrink-0 font-mono text-text-muted">#{row.ticketId}</span>
                      <span>{row.error}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Pieces
// ═════════════════════════════════════════════════════════════════════════════

function BulkSelect({
  label,
  value,
  options,
  onChange,
  unchanged,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  unchanged: string;
}): JSX.Element {
  return (
    <label
      className={clsx(
        'flex items-center gap-1.5 rounded-pill py-1 pl-2.5 pr-1 text-[11px] transition-colors',
        value ? 'bg-accent/15 text-accent' : 'bg-bg-secondary text-text-muted',
      )}
    >
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={clsx(
          'cursor-pointer bg-transparent py-0.5 pr-1 text-[11px] outline-none',
          value ? 'text-accent' : 'text-text-secondary',
        )}
      >
        {/* "inchangé" is the default and is a real option, not a placeholder: a
            bulk edit must be able to leave a field alone on purpose. */}
        <option value="" className="bg-bg-secondary text-text-secondary">
          {unchanged}
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-bg-secondary text-text-primary">
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The ten-minute undo toast.
 *
 * `duration` is the real window, not a token gesture: the token is valid that
 * long server-side and the affordance should not expire before it does. On
 * success the toast replaces itself with a confirmation rather than vanishing,
 * so the agent knows the undo landed.
 */
function showUndoToast(
  result: { updated: number[]; undoToken: string | null },
  t: (key: string, fallback: string, options?: Record<string, unknown>) => string,
): void {
  const message = t('tickets.bulk.applied', '{{count}} tickets modifiés.', {
    count: result.updated.length,
  });

  if (!result.undoToken) {
    toast.success(message);
    return;
  }

  const token = result.undoToken;

  toast.custom(
    (instance) => (
      <div className="flex items-center gap-3 rounded-card bg-bg-secondary px-4 py-3 shadow-card">
        <span className="text-[13px] text-text-primary">{message}</span>
        <button
          type="button"
          onClick={() => {
            void (async () => {
              try {
                await ticketsApi.bulkUndo(token);
                toast.dismiss(instance.id);
                toast.success(t('tickets.bulk.undone', 'Action groupée annulée.', {}));
                await useTicketStore.getState().refresh();
              } catch (err) {
                toast.error(errorMessage(err, t('errors.generic', 'Une erreur est survenue.', {})));
              }
            })();
          }}
          className="inline-flex items-center gap-1.5 rounded-pill bg-accent px-2.5 py-1 text-[12px] font-semibold text-bg-primary hover:bg-accent-hover"
        >
          <Undo2 size={12} aria-hidden />
          {t('tickets.bulk.undo', 'Annuler', {})}
        </button>
        <button
          type="button"
          onClick={() => toast.dismiss(instance.id)}
          aria-label={t('common.close', 'Fermer', {})}
          className="rounded-full p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <X size={12} aria-hidden />
        </button>
      </div>
    ),
    { duration: LIMITS.bulkUndoWindowMs },
  );
}
