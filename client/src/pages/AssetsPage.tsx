/**
 * AssetsPage — `/assets`
 *
 * The machines the suite has told Oblidesk about, searchable by name or by
 * hardware UUID, with the one desk-computed number that decides whether a
 * machine is somebody's problem right now: its open ticket count.
 *
 * ── Why this list is a plain table and the ticket queue is not ──────────────
 * `TicketQueue` is virtualised and keeps its window alive across navigations
 * because an agent lives in it all day, scrolls thousands of rows and must not
 * lose their place when they open a ticket. The asset list is a lookup surface:
 * you arrive with a hostname or a UUID out of an alert e-mail, you find one
 * machine, you leave. So it is a plain table with a "load more" button, which
 * is less code, less state and easier to read — and the two lists differing is
 * a decision, not an oversight.
 *
 * The pagination underneath is still KEYSET (`nextCursor`), like the queue's,
 * because the server offers nothing else and it is the right thing regardless:
 * an OFFSET window shifts when a machine is seen again mid-scroll and silently
 * drops or repeats a row.
 *
 * ── The columns are only what the desk owns ─────────────────────────────────
 * No disk, no OS, no patch level. Those belong to the sibling apps and are read
 * through on the detail page, where each one carries its source and the age of
 * the read. A column here would be an unattributed, undated copy.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import { HardDrive, Search, X } from 'lucide-react';
import type { Ci, CiCriticality, CiKind } from '@oblidesk/shared';
import apiClient, { toQuery } from '@/api/client';
import { Button } from '@/components/common/Button';
import {
  AssetTable,
  CI_CRITICALITIES,
  CI_CRITICALITY_LABELS,
  CI_KINDS,
  CI_KIND_LABELS,
  type AssetSort,
  type AssetSortField,
} from '@/components/assets/AssetTable';
import { useDebounce } from '@/hooks/useDebounce';

const PAGE_SIZE = 50;

interface CiPageResponse {
  success: true;
  data: Ci[];
  nextCursor: string | null;
  hasMore: boolean;
}

function serverError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

export function AssetsPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [kinds, setKinds] = useState<CiKind[]>([]);
  const [criticalities, setCriticalities] = useState<CiCriticality[]>([]);
  const [openOnly, setOpenOnly] = useState(false);
  const [sort, setSort] = useState<AssetSort>({ by: 'display_name', dir: 'asc' });

  const [items, setItems] = useState<Ci[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [denied, setDenied] = useState(false);

  // Search-as-you-type against a trigram index still costs a round trip per
  // keystroke without this, and a pasted UUID arrives as a burst of them.
  const debouncedSearch = useDebounce(search, 300);

  const params = useMemo(
    () =>
      toQuery({
        search: debouncedSearch.trim(),
        kind: kinds,
        criticality: criticalities,
        hasOpenTickets: openOnly ? 'true' : '',
        limit: PAGE_SIZE,
        sortBy: sort.by,
        sortDir: sort.dir,
      }),
    [debouncedSearch, kinds, criticalities, openOnly, sort],
  );

  const loadFirst = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<CiPageResponse>('/ci', { params });
      setItems(res.data.data);
      setCursor(res.data.nextCursor);
      setHasMore(res.data.hasMore);
      setDenied(false);
    } catch (err) {
      // Drop the cursor: it points into a page computed under the PREVIOUS
      // filters, and "load more" would append rows that do not belong to the
      // list on screen.
      setCursor(null);
      setHasMore(false);
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 403) setDenied(true);
      else toast.error(serverError(err, t('assets.loadFailed', 'Impossible de charger les actifs.')));
    } finally {
      setLoading(false);
    }
  }, [params, t]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  async function loadMore(): Promise<void> {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await apiClient.get<CiPageResponse>('/ci', {
        params: { ...params, cursor },
      });
      // Append: the cursor pins the page boundary to a column value, so a row
      // seen again while scrolling cannot shift the window under us.
      setItems((current) => [...current, ...res.data.data]);
      setCursor(res.data.nextCursor);
      setHasMore(res.data.hasMore);
    } catch (err) {
      toast.error(serverError(err, t('assets.loadFailed', 'Impossible de charger les actifs.')));
    } finally {
      setLoadingMore(false);
    }
  }

  function onSort(field: AssetSortField): void {
    setSort((current) =>
      current.by === field
        ? { by: field, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { by: field, dir: field === 'last_seen_at' ? 'desc' : 'asc' },
    );
  }

  const filtered = kinds.length > 0 || criticalities.length > 0 || openOnly || search.trim() !== '';

  function resetFilters(): void {
    setSearch('');
    setKinds([]);
    setCriticalities([]);
    setOpenOnly(false);
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
            <HardDrive size={22} className="text-accent" />
            {t('assets.title', 'Actifs')}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {t(
              'assets.subtitle',
              'Les éléments de configuration remontés par les autres applications Obli.',
            )}
          </p>
        </div>
      </header>

      {/* ── Search and filters ───────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="relative max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('assets.searchPlaceholder', 'Rechercher un actif, un nom, un UUID…')}
            className="w-full rounded-md bg-bg-tertiary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <FilterLabel>{t('assets.kind', 'Type')}</FilterLabel>
          {CI_KINDS.map((kind) => (
            <FilterChip
              key={kind}
              active={kinds.includes(kind)}
              onClick={() => setKinds((current) => toggle(current, kind))}
            >
              {t(CI_KIND_LABELS[kind].key, CI_KIND_LABELS[kind].fallback)}
            </FilterChip>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <FilterLabel>{t('assets.criticality', 'Criticité')}</FilterLabel>
          {CI_CRITICALITIES.map((level) => (
            <FilterChip
              key={level}
              active={criticalities.includes(level)}
              onClick={() => setCriticalities((current) => toggle(current, level))}
            >
              {t(CI_CRITICALITY_LABELS[level].key, CI_CRITICALITY_LABELS[level].fallback)}
            </FilterChip>
          ))}

          <span className="mx-1 h-4 w-px bg-border" aria-hidden />

          <FilterChip active={openOnly} onClick={() => setOpenOnly((value) => !value)}>
            {t('assets.withOpenTickets', 'Avec ticket ouvert')}
          </FilterChip>

          {filtered && (
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex items-center gap-1 rounded-pill px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
            >
              <X size={11} aria-hidden />
              {t('assets.clearFilters', 'Tout effacer')}
            </button>
          )}
        </div>
      </div>

      <AssetTable
        items={items}
        loading={loading}
        sort={sort}
        onSort={onSort}
        onOpen={(ci) => navigate(`/assets/${ci.id}`)}
      />

      {!loading && items.length > 0 && (
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span>
            {t('assets.loadedCount', '{{n}} actifs affichés', { n: items.length })}
            {hasMore ? ` · ${t('assets.moreAvailable', 'il en reste')}` : ''}
          </span>
          {hasMore && (
            <Button size="sm" variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
              {t('assets.loadMore', 'Charger la suite')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function FilterLabel({ children }: { children: string }): JSX.Element {
  return (
    <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
      {children}
    </span>
  );
}

/** HARD RULE 11 — a chip is a tinted background, never an outline. */
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'rounded-pill px-2.5 py-1 text-[11px] transition-colors',
        active
          ? 'bg-accent/12 text-accent'
          : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover hover:text-text-secondary',
      )}
    >
      {children}
    </button>
  );
}

export default AssetsPage;
