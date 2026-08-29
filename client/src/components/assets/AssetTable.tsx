/**
 * AssetTable.tsx — the asset list, rendered as a plain sortable table.
 *
 * ── What this table shows, and why it is only this ──────────────────────────
 * `GET /api/ci` returns the desk-owned columns plus one grouped open-ticket
 * count. It deliberately does NOT join `ci_source_links` or `ci_state_cache`,
 * and this table does not go looking for them: a list that printed a sibling
 * app's attribute in a column would be presenting read-through data with no
 * room to say where it came from or how old it is. The live view of a machine
 * belongs on the detail page, where every value is attributed and timed.
 *
 * So the columns are exactly what Oblidesk is the source of truth for, plus a
 * count it computes itself: name, hardware UUID, kind, criticality, open
 * tickets, last seen. Nothing on this screen needs a footnote.
 *
 * HARD RULE 11 — no border on the card. The head rule and the row rules are
 * hairline separators, which is the one thing the `border` token exists for.
 */

import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, Fingerprint } from 'lucide-react';
import type { Ci, CiCriticality, CiKind } from '@oblidesk/shared';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { formatAbsolute, formatRelative } from '@/components/tickets/SlaChip';

// ═════════════════════════════════════════════════════════════════════════════
// Vocabulary
//
// Mirrors `server/src/validators/ci.validators.ts`, which itself mirrors the
// `cis_kind_ck` / `cis_criticality_ck` CHECK constraints from migration 002.
// Kept as literal tuples so the filter chips, the table and the identity card
// all offer the same values in the same order.
// ═════════════════════════════════════════════════════════════════════════════

export const CI_KINDS = [
  'device',
  'monitor',
  'host',
  'network',
  'service',
  'identity',
  'other',
] as const satisfies readonly CiKind[];

export const CI_CRITICALITIES = [
  'critical',
  'high',
  'medium',
  'low',
] as const satisfies readonly CiCriticality[];

/** i18n key + inline French fallback, ready for `t(key, fallback)`. */
export const CI_KIND_LABELS: Readonly<Record<CiKind, { key: string; fallback: string }>> = {
  device: { key: 'assets.kinds.device', fallback: 'Équipement' },
  monitor: { key: 'assets.kinds.monitor', fallback: 'Sonde' },
  host: { key: 'assets.kinds.host', fallback: 'Hôte' },
  network: { key: 'assets.kinds.network', fallback: 'Réseau' },
  service: { key: 'assets.kinds.service', fallback: 'Service' },
  identity: { key: 'assets.kinds.identity', fallback: 'Identité' },
  other: { key: 'assets.kinds.other', fallback: 'Autre' },
};

export const CI_CRITICALITY_LABELS: Readonly<
  Record<CiCriticality, { key: string; fallback: string }>
> = {
  critical: { key: 'assets.criticalities.critical', fallback: 'Critique' },
  high: { key: 'assets.criticalities.high', fallback: 'Élevée' },
  medium: { key: 'assets.criticalities.medium', fallback: 'Moyenne' },
  low: { key: 'assets.criticalities.low', fallback: 'Faible' },
};

/**
 * Criticality paints itself with the priority ramp (p1 critical … p4 low).
 * Reusing the ticket ramp is deliberate: an agent reads "red means this one
 * first" once, and it means the same thing on a ticket and on a machine.
 */
export const CI_CRITICALITY_TONE: Readonly<Record<CiCriticality, string>> = {
  critical: 'bg-priority-p1-bg text-priority-p1',
  high: 'bg-priority-p2-bg text-priority-p2',
  medium: 'bg-priority-p3-bg text-priority-p3',
  low: 'bg-priority-p4-bg text-priority-p4',
};

/** The subset of the server's sort whitelist this table exposes. */
export const ASSET_SORT_FIELDS = [
  'display_name',
  'kind',
  'criticality',
  'last_seen_at',
] as const;

export type AssetSortField = (typeof ASSET_SORT_FIELDS)[number];

export interface AssetSort {
  by: AssetSortField;
  dir: 'asc' | 'desc';
}

// ═════════════════════════════════════════════════════════════════════════════
// Cells
// ═════════════════════════════════════════════════════════════════════════════

export function CiKindBadge({ kind }: { kind: CiKind }): JSX.Element {
  const { t } = useTranslation();
  const label = CI_KIND_LABELS[kind] ?? { key: 'assets.kinds.other', fallback: 'Autre' };
  return (
    <span className="rounded-pill bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">
      {t(label.key, label.fallback)}
    </span>
  );
}

export function CiCriticalityBadge({
  criticality,
}: {
  criticality: CiCriticality | null;
}): JSX.Element {
  const { t } = useTranslation();

  // A CI with no criticality is a CI nobody has triaged yet. Saying so is more
  // useful than defaulting it to "moyenne" and pretending someone decided.
  if (!criticality) {
    return (
      <span className="rounded-pill bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-muted">
        {t('assets.criticalityUnset', 'non définie')}
      </span>
    );
  }

  const label = CI_CRITICALITY_LABELS[criticality];
  return (
    <span
      className={clsx(
        'rounded-pill px-2 py-0.5 text-[11px] font-medium',
        CI_CRITICALITY_TONE[criticality],
      )}
    >
      {t(label.key, label.fallback)}
    </span>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Table
// ═════════════════════════════════════════════════════════════════════════════

export interface AssetTableProps {
  items: Ci[];
  /** First load only. A "load more" in flight leaves the rows on screen. */
  loading: boolean;
  /** Highlighted row, when the table sits next to an open asset. */
  selectedId?: number | null;
  onOpen: (ci: Ci) => void;
  sort: AssetSort;
  onSort: (field: AssetSortField) => void;
  className?: string;
}

export function AssetTable({
  items,
  loading,
  selectedId = null,
  onOpen,
  sort,
  onSort,
  className,
}: AssetTableProps): JSX.Element {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className={clsx('rounded-card bg-bg-secondary py-16 shadow-card', className)}>
        <div className="flex justify-center">
          <LoadingSpinner label={t('common.loading', 'Chargement…')} />
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={clsx('rounded-card bg-bg-secondary px-5 py-14 shadow-card', className)}>
        <p className="text-center text-sm text-text-muted">
          {t('assets.none', 'Aucun actif.')}
        </p>
      </div>
    );
  }

  return (
    <div className={clsx('overflow-hidden rounded-card bg-bg-secondary shadow-card', className)}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
              <SortableHead
                field="display_name"
                label={t('assets.ci', 'Actif')}
                sort={sort}
                onSort={onSort}
                className="px-5 py-3"
              />
              <SortableHead
                field="kind"
                label={t('assets.kind', 'Type')}
                sort={sort}
                onSort={onSort}
                className="px-3 py-3"
              />
              <SortableHead
                field="criticality"
                label={t('assets.criticality', 'Criticité')}
                sort={sort}
                onSort={onSort}
                className="px-3 py-3"
              />
              <th className="px-3 py-3 font-medium">
                {t('assets.openTickets', 'Tickets ouverts')}
              </th>
              <SortableHead
                field="last_seen_at"
                label={t('assets.lastSeen', 'Vu pour la dernière fois')}
                sort={sort}
                onSort={onSort}
                className="px-5 py-3"
              />
            </tr>
          </thead>
          <tbody>
            {items.map((ci) => {
              const open = ci.openTicketCount ?? 0;
              return (
                <tr
                  key={ci.id}
                  tabIndex={0}
                  role="button"
                  aria-label={ci.displayName}
                  onClick={() => onOpen(ci)}
                  onKeyDown={(event: KeyboardEvent<HTMLTableRowElement>) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onOpen(ci);
                    }
                  }}
                  className={clsx(
                    'cursor-pointer border-b border-border/40 outline-none transition-colors last:border-0',
                    'hover:bg-bg-hover/50 focus-visible:bg-bg-hover',
                    selectedId === ci.id && 'bg-bg-active/60',
                  )}
                >
                  <td className="px-5 py-3">
                    <div className="truncate font-medium text-text-primary">{ci.displayName}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-text-muted">
                      <Fingerprint size={11} className="shrink-0" aria-hidden />
                      <span className="truncate" title={ci.hardwareUuid ?? undefined}>
                        {ci.hardwareUuid ?? t('assets.noUuid', 'sans UUID matériel')}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <CiKindBadge kind={ci.kind} />
                  </td>
                  <td className="px-3 py-3">
                    <CiCriticalityBadge criticality={ci.criticality ?? null} />
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={clsx(
                        'rounded-pill px-2 py-0.5 font-mono text-[11px]',
                        open > 0 ? 'bg-accent/12 text-accent' : 'bg-bg-tertiary text-text-muted',
                      )}
                    >
                      {open}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-text-secondary" title={formatAbsolute(ci.lastSeenAt)}>
                    {formatRelative(ci.lastSeenAt, t)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortableHead({
  field,
  label,
  sort,
  onSort,
  className,
}: {
  field: AssetSortField;
  label: string;
  sort: AssetSort;
  onSort: (field: AssetSortField) => void;
  className?: string;
}): JSX.Element {
  const active = sort.by === field;
  const Arrow = sort.dir === 'desc' ? ArrowDown : ArrowUp;

  return (
    <th className={clsx('font-medium', className)} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className={clsx(
          'inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-text-secondary',
          active && 'text-text-secondary',
        )}
      >
        {label}
        {active && <Arrow size={11} aria-hidden />}
      </button>
    </th>
  );
}

export default AssetTable;
