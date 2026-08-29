/**
 * DashboardsPage — boards, tabs, and the editor.
 *
 * ── The shape of the screen ──────────────────────────────────────────────────
 *   [ header ]  board picker · comparison · Modifier / Terminer · Actualiser
 *   [ tabs   ]  named tabs, renamable, "+ Ajouter un onglet"
 *   [ grid   ]  12-column drag/resize board     [ configuration panel ]
 *
 * ── Reading and editing are two modes, deliberately ──────────────────────────
 * A dashboard is read every morning by people who are not going to edit it. So
 * the grid is completely inert — no drag sensors mounted, no handles, no
 * selection — until someone presses "Modifier". Pressing "Terminer" puts it
 * back. That boundary is also what makes the click unambiguous: reading, a
 * click on a number opens the records behind it; editing, the same click
 * selects the widget. One gesture, one meaning, decided by a mode the user
 * chose.
 *
 * ── The live preview does not lie about what saving will do ──────────────────
 * While the panel is open the selected widget is re-resolved from the UNSAVED
 * draft through `GET /api/metrics/:key`, using a request built the same way
 * `planWidget` builds one. So the preview asks the server exactly what the save
 * would ask it, and a combination the registry refuses fails in the preview
 * rather than after "Enregistrer".
 *
 * ── Drill-through: two honest targets, never a third ─────────────────────────
 * Clicking a number goes to the tickets behind it, and there are exactly two
 * ways to get there:
 *
 *   • the ticket QUEUE with the matching saved view, when the widget is built
 *     on one (`view` / `drill_to_view`) — a real, shareable, filterable URL;
 *   • the records drawer, built from the SERVER's own drill descriptor, for
 *     everything else.
 *
 * There is no third path where the client reconstructs an equivalent queue
 * filter, because for most metrics there is no equivalent: the queue cannot
 * express "median first response, last 30 days, grouped by priority". A list
 * that disagrees with the number above it is worse than no list.
 *
 * ── What this page does NOT invent ───────────────────────────────────────────
 * No metric is computed here. No delta is computed here. Every number, every
 * comparison and every drill comes from the registry on the server, which is
 * the only way the tile and its drill-through can be guaranteed to agree.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  Check,
  ExternalLink,
  LayoutGrid,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { CAPABILITIES } from '@oblidesk/shared';
import { errorMessage } from '@/api/client';
import { configApi } from '@/api/config.api';
import {
  dashboardsApi,
  drillToQuery,
  metricsApi,
  type DashboardRecord,
  type DashboardTicketRow,
  type DashboardWidgetRecord,
  type MetricCatalogEntry,
  type MetricDelta,
  type MetricResolution,
  type ResolvedWidget,
} from '@/api/metrics.api';
import { Badge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { Select } from '@/components/common/Select';
import { Widget, TicketLine, type DrillRequest } from '@/components/dashboard/Widget';
import {
  WidgetGrid,
  nextFreeSlot,
  normalizeLayout,
  type GridItem,
} from '@/components/dashboard/WidgetGrid';
import {
  WidgetCatalog,
  type WidgetDraft,
} from '@/components/dashboard/WidgetCatalog';
import {
  WidgetConfigPanel,
  toPreviewQuery,
  type WidgetConfigDraft,
} from '@/components/dashboard/WidgetConfigPanel';
import { useAuthStore } from '@/store/authStore';
import { useViewStore } from '@/store/viewStore';
import { formatNumber } from '@/utils/format';
import { cn } from '@/utils/cn';

// ═════════════════════════════════════════════════════════════════════════════
// Tabs
// ═════════════════════════════════════════════════════════════════════════════

interface BoardTab {
  key: string;
  label: string;
  order: number;
  /** The stored entry, so a rename preserves a `{ en, fr }` label map. */
  raw: Record<string, unknown> | null;
}

function currentLang(): string {
  if (typeof document === 'undefined') return 'fr';
  return (document.documentElement.getAttribute('lang') ?? 'fr').split('-')[0];
}

function labelOf(raw: unknown, fallback: string): string {
  if (typeof raw === 'string' && raw.trim() !== '') return raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const map = raw as Record<string, unknown>;
    const lang = currentLang();
    for (const key of [lang, 'fr', 'en']) {
      const value = map[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
    for (const value of Object.values(map)) {
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  }
  return fallback;
}

/**
 * The tab strip, from `dashboards.layout.tabs` PLUS every `tab_key` a widget
 * actually uses.
 *
 * The union matters: a widget whose tab is missing from the layout would
 * otherwise be invisible AND still counted by every "how many widgets" number
 * on the screen. A widget that exists is a widget you can reach.
 */
function readTabs(
  layout: Record<string, unknown> | null | undefined,
  widgets: DashboardWidgetRecord[],
  untitled: string,
): BoardTab[] {
  const tabs: BoardTab[] = [];
  const seen = new Set<string>();

  const stored = layout && Array.isArray(layout.tabs) ? (layout.tabs as unknown[]) : [];
  stored.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const raw = entry as Record<string, unknown>;
    const key = typeof raw.key === 'string' && raw.key.trim() !== '' ? raw.key.trim() : null;
    if (!key || seen.has(key)) return;
    seen.add(key);
    const order = Number(raw.order ?? raw.sortOrder ?? (index + 1) * 10);
    tabs.push({
      key,
      label: labelOf(raw.label, key),
      order: Number.isFinite(order) ? order : (index + 1) * 10,
      raw,
    });
  });

  for (const widget of widgets) {
    if (seen.has(widget.tabKey)) continue;
    seen.add(widget.tabKey);
    tabs.push({ key: widget.tabKey, label: widget.tabKey, order: 1000 + tabs.length, raw: null });
  }

  if (tabs.length === 0) tabs.push({ key: 'overview', label: untitled, order: 10, raw: null });
  return tabs.sort((a, b) => a.order - b.order);
}

/** Turn the strip back into what `layout.tabs` stores, preserving label maps. */
function writeTabs(tabs: BoardTab[]): Array<Record<string, unknown>> {
  return tabs.map((tab, index) => ({
    ...(tab.raw ?? {}),
    key: tab.key,
    label:
      tab.raw && tab.raw.label && typeof tab.raw.label === 'object' && !Array.isArray(tab.raw.label)
        ? { ...(tab.raw.label as Record<string, unknown>), [currentLang()]: tab.label }
        : tab.label,
    order: (index + 1) * 10,
  }));
}

function slugifyTab(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFD')
      // The combining-diacritic block, written as escapes: a literal range of
      // combining marks in source is invisible and does not survive a careless
      // editor. NFD + this is what turns "Qualité" into "qualite".
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'tab';
  let candidate = base;
  let counter = 2;
  while (taken.has(candidate)) candidate = `${base}-${counter++}`;
  return candidate;
}

// ═════════════════════════════════════════════════════════════════════════════
// Page
// ═════════════════════════════════════════════════════════════════════════════

const KPI_TYPES = new Set(['kpi', 'stat', 'number', 'csat', 'time_summary', 'sla_gauge']);

export function DashboardsPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const hasCapability = useAuthStore((state) => state.hasCapability);
  const canEdit = hasCapability(CAPABILITIES.REPORT_ADMIN);

  const views = useViewStore((state) => state.views);
  const loadViews = useViewStore((state) => state.loadViews);

  // ── board state ───────────────────────────────────────────────────────────
  const [boards, setBoards] = useState<DashboardRecord[]>([]);
  const [slug, setSlug] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<DashboardRecord | null>(null);
  const [widgets, setWidgets] = useState<DashboardWidgetRecord[]>([]);
  const [resolvedById, setResolvedById] = useState<Record<number, ResolvedWidget>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<MetricCatalogEntry[]>([]);
  const [rollupRunning, setRollupRunning] = useState<boolean | null>(null);
  const [queues, setQueues] = useState<Array<{ slug: string; name: string }>>([]);
  const [priorities, setPriorities] = useState<Array<{ slug: string; label: string }>>([]);
  const [templates, setTemplates] = useState<Array<{ slug: string; name: string }>>([]);

  // ── editor state ──────────────────────────────────────────────────────────
  const [tabKey, setTabKey] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<WidgetConfigDraft | null>(null);
  const [savingWidget, setSavingWidget] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingTab, setRenamingTab] = useState<string | null>(null);

  const [compare, setCompare] = useState<'yesterday' | 'last_week'>('yesterday');
  const [weekDeltas, setWeekDeltas] = useState<Record<number, MetricDelta>>({});
  /**
   * The tiles only switch to "vs semaine dernière" once those deltas exist.
   * Relabelling first would put last week's caption over yesterday's number
   * for as long as the fetch takes — a small lie, but exactly the kind a
   * dashboard is not allowed to tell.
   */
  const [weekDeltasReady, setWeekDeltasReady] = useState(false);

  const [preview, setPreview] = useState<{
    metric: MetricResolution | null;
    loading: boolean;
    error: string | null;
  } | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const [drill, setDrill] = useState<{
    request: DrillRequest;
    rows: DashboardTicketRow[];
    total: number;
    loading: boolean;
    error: string | null;
    warnings: string[];
  } | null>(null);

  // ═══════════════════════════════════════════════════════════════════════
  // Loading
  // ═══════════════════════════════════════════════════════════════════════

  const applyPayload = useCallback((record: DashboardRecord, resolved: ResolvedWidget[]) => {
    setDashboard(record);
    setWidgets(resolved.map((entry) => entry.widget));
    const map: Record<number, ResolvedWidget> = {};
    for (const entry of resolved) map[entry.widget.id] = entry;
    setResolvedById(map);
  }, []);

  const loadBoard = useCallback(
    async (targetSlug: string, options: { quiet?: boolean } = {}) => {
      if (!options.quiet) setLoading(true);
      setLoadError(null);
      try {
        const payload = await dashboardsApi.resolve(targetSlug);
        applyPayload(payload.dashboard, payload.widgets);
      } catch (error) {
        setLoadError(errorMessage(error));
      } finally {
        setLoading(false);
      }
    },
    [applyPayload],
  );

  // First paint: the catalogue and the board list, then the board itself.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await metricsApi.catalog();
        if (!cancelled) {
          setCatalog(response.metrics);
          setRollupRunning(response.rollupRunning);
        }
      } catch {
        // A missing catalogue disables the editor's pickers; the boards still
        // render, because their numbers come from the server either way.
        if (!cancelled) setCatalog([]);
      }

      try {
        const list = await dashboardsApi.list();
        if (cancelled) return;
        setBoards(list);
        const preferred = list.find((board) => board.isDefault) ?? list[0] ?? null;
        if (preferred) setSlug(preferred.slug);
        else setLoading(false);
      } catch (error) {
        if (!cancelled) {
          setLoadError(errorMessage(error));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (slug) void loadBoard(slug);
  }, [slug, loadBoard]);

  useEffect(() => {
    if (views.length === 0) void loadViews();
  }, [views.length, loadViews]);

  // Names for the slug-shaped axes. Purely cosmetic: a chart still works
  // without them, it just says `support-n1` instead of "Support niveau 1".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await configApi.listKind('queue', { limit: 200 });
        if (cancelled) return;
        setQueues(list.objects.map((object) => ({ slug: object.slug, name: object.name })));
      } catch {
        if (!cancelled) setQueues([]);
      }

      try {
        const list = await configApi.listKind('priority_matrix', { limit: 20 });
        if (cancelled) return;
        const published = list.objects.find((object) => object.status === 'published') ?? list.objects[0];
        const body = published?.body as { priorities?: Array<{ slug?: unknown; label?: unknown }> } | undefined;
        const specs = Array.isArray(body?.priorities) ? body.priorities : [];
        setPriorities(
          specs
            .filter((spec) => typeof spec.slug === 'string')
            .map((spec) => ({
              slug: String(spec.slug),
              label: typeof spec.label === 'string' && spec.label ? spec.label : String(spec.slug),
            })),
        );
      } catch {
        if (!cancelled) setPriorities([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Shipped boards an admin can instantiate, offered only when there are none.
  useEffect(() => {
    if (boards.length > 0 || !canEdit) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await configApi.listKind('dashboard', { limit: 50 });
        if (!cancelled) {
          setTemplates(list.objects.map((object) => ({ slug: object.slug, name: object.name })));
        }
      } catch {
        if (!cancelled) setTemplates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boards.length, canEdit]);

  // ── auto-refresh, only while reading ─────────────────────────────────────
  const refreshSeconds = useMemo(() => {
    const raw = Number((dashboard?.layout as { refresh_seconds?: unknown; refreshSeconds?: unknown } | undefined)?.refresh_seconds
      ?? (dashboard?.layout as { refreshSeconds?: unknown } | undefined)?.refreshSeconds);
    // Floor at 30s: a board that re-aggregates every five seconds is a board
    // that makes the ticket queue behind it feel broken.
    return Number.isFinite(raw) && raw >= 30 ? raw : 0;
  }, [dashboard]);

  useEffect(() => {
    if (!slug || editing || refreshSeconds <= 0) return;
    const timer = window.setInterval(() => {
      void loadBoard(slug, { quiet: true });
    }, refreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [slug, editing, refreshSeconds, loadBoard]);

  // ═══════════════════════════════════════════════════════════════════════
  // Tabs
  // ═══════════════════════════════════════════════════════════════════════

  const tabs = useMemo(
    () => readTabs(dashboard?.layout, widgets, t('dashboard.tab.overview', 'Vue d’ensemble')),
    [dashboard, widgets, t],
  );

  const activeTab = useMemo(() => {
    if (tabKey && tabs.some((tab) => tab.key === tabKey)) return tabKey;
    return tabs[0]?.key ?? 'overview';
  }, [tabKey, tabs]);

  const persistTabs = useCallback(
    async (next: BoardTab[]) => {
      if (!dashboard) return;
      const layout = { ...(dashboard.layout ?? {}), tabs: writeTabs(next) };
      // Optimistic: the strip is the one thing on this page that must feel
      // instant, and the write is a single jsonb column.
      setDashboard({ ...dashboard, layout });
      try {
        await dashboardsApi.update(dashboard.slug, { layout });
      } catch (error) {
        toast.error(errorMessage(error));
        void loadBoard(dashboard.slug, { quiet: true });
      }
    },
    [dashboard, loadBoard],
  );

  const addTab = useCallback(() => {
    const label = t('dashboard.tab.newName', 'Nouvel onglet');
    const key = slugifyTab(label, new Set(tabs.map((tab) => tab.key)));
    const next = [...tabs, { key, label, order: (tabs.length + 1) * 10, raw: null }];
    void persistTabs(next);
    setTabKey(key);
    setRenamingTab(key);
  }, [tabs, persistTabs, t]);

  const renameTab = useCallback(
    (key: string, label: string) => {
      const trimmed = label.trim();
      setRenamingTab(null);
      if (trimmed === '') return;
      void persistTabs(tabs.map((tab) => (tab.key === key ? { ...tab, label: trimmed } : tab)));
    },
    [tabs, persistTabs],
  );

  const removeTab = useCallback(
    (key: string) => {
      // Only an EMPTY tab can go. Deleting a populated one would leave its
      // widgets in the database, invisible and unreachable — the worst of both.
      if (widgets.some((widget) => widget.tabKey === key)) {
        toast.error(
          t('dashboard.tab.notEmpty', 'Cet onglet contient encore des éléments : videz-le d’abord.'),
        );
        return;
      }
      const next = tabs.filter((tab) => tab.key !== key);
      void persistTabs(next.length > 0 ? next : tabs);
      if (activeTab === key) setTabKey(next[0]?.key ?? null);
    },
    [widgets, tabs, persistTabs, activeTab, t],
  );

  // ═══════════════════════════════════════════════════════════════════════
  // Grid
  // ═══════════════════════════════════════════════════════════════════════

  const tabWidgets = useMemo(
    () => widgets.filter((widget) => widget.tabKey === activeTab),
    [widgets, activeTab],
  );

  const gridItems: GridItem[] = useMemo(
    () => tabWidgets.map((widget) => ({ id: widget.id, x: widget.x, y: widget.y, w: widget.w, h: widget.h })),
    [tabWidgets],
  );

  const handleLayoutChange = useCallback(
    (next: GridItem[]) => {
      if (!dashboard) return;
      const byId = new Map(next.map((item) => [item.id, item]));
      setWidgets((current) =>
        current.map((widget) => {
          const item = byId.get(widget.id);
          return item ? { ...widget, x: item.x, y: item.y, w: item.w, h: item.h } : widget;
        }),
      );

      void dashboardsApi
        .saveLayout(
          dashboard.slug,
          next.map((item) => ({ ...item, tabKey: activeTab })),
        )
        .catch((error: unknown) => {
          toast.error(errorMessage(error));
          void loadBoard(dashboard.slug, { quiet: true });
        });
    },
    [dashboard, activeTab, loadBoard],
  );

  // ═══════════════════════════════════════════════════════════════════════
  // Draft, preview, save
  // ═══════════════════════════════════════════════════════════════════════

  const selectedWidget = useMemo(
    () => widgets.find((widget) => widget.id === selectedId) ?? null,
    [widgets, selectedId],
  );

  const openPanel = useCallback((widget: DashboardWidgetRecord) => {
    setDraft({
      id: widget.id,
      widgetType: widget.widgetType,
      title: widget.title,
      config: { ...widget.config },
    });
    setPanelError(null);
    setPreview(null);
  }, []);

  useEffect(() => {
    if (!editing) {
      setDraft(null);
      setPreview(null);
      setSelectedId(null);
      return;
    }
    if (selectedWidget && (!draft || draft.id !== selectedWidget.id)) openPanel(selectedWidget);
    if (!selectedWidget) setDraft(null);
    // `draft` is intentionally not a dependency: it is what this effect writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, selectedWidget, openPanel]);

  const dirty = useMemo(() => {
    if (!draft || !selectedWidget) return false;
    return (
      draft.widgetType !== selectedWidget.widgetType ||
      (draft.title ?? '') !== (selectedWidget.title ?? '') ||
      JSON.stringify(draft.config) !== JSON.stringify(selectedWidget.config)
    );
  }, [draft, selectedWidget]);

  /**
   * The live preview.
   *
   * Debounced, because every keystroke in the title field would otherwise fire
   * an aggregate. Only metric widgets preview: a list or a feed has no
   * `/metrics` endpoint to ask, so the card keeps showing its saved data with
   * the draft's title and type applied, and the panel says so.
   */
  const previewQueryKey = useMemo(() => {
    if (!draft) return null;
    const entry = catalog.find((item) => item.key === readMetricKey(draft.config)) ?? null;
    const query = toPreviewQuery(draft, entry);
    return query ? JSON.stringify(query) : null;
  }, [draft, catalog]);

  const previewRun = useRef(0);

  useEffect(() => {
    if (!previewQueryKey) {
      setPreview(null);
      return;
    }
    const query = JSON.parse(previewQueryKey) as Parameters<typeof metricsApi.resolve>[0];
    const run = ++previewRun.current;
    setPreview((current) => ({ metric: current?.metric ?? null, loading: true, error: null }));

    const timer = window.setTimeout(() => {
      void metricsApi
        .resolve(query)
        .then((metric) => {
          if (previewRun.current === run) setPreview({ metric, loading: false, error: null });
        })
        .catch((error: unknown) => {
          // The registry's refusal, verbatim. It names the metric, the
          // dimension or the range that is wrong — which is the fix.
          if (previewRun.current === run) {
            setPreview({ metric: null, loading: false, error: errorMessage(error) });
          }
        });
    }, 300);

    return () => window.clearTimeout(timer);
  }, [previewQueryKey]);

  const saveWidget = useCallback(async () => {
    if (!draft || !dashboard) return;
    setSavingWidget(true);
    setPanelError(null);
    try {
      await dashboardsApi.updateWidget(draft.id, {
        widgetType: draft.widgetType,
        title: draft.title,
        config: draft.config,
      });
      await loadBoard(dashboard.slug, { quiet: true });
      toast.success(t('dashboard.widgetSaved', 'Élément enregistré.'));
    } catch (error) {
      // `assertWidgetConfig` refused it. Show the reason next to the controls
      // that caused it rather than in a toast that vanishes.
      setPanelError(errorMessage(error));
    } finally {
      setSavingWidget(false);
    }
  }, [draft, dashboard, loadBoard, t]);

  const revertDraft = useCallback(() => {
    if (selectedWidget) openPanel(selectedWidget);
  }, [selectedWidget, openPanel]);

  const addWidget = useCallback(
    async (spec: WidgetDraft) => {
      if (!dashboard) return;
      setCreating(true);
      try {
        const slot = nextFreeSlot(gridItems, { w: spec.w, h: spec.h });
        const created = await dashboardsApi.createWidget(dashboard.slug, {
          tabKey: activeTab,
          widgetType: spec.widgetType,
          title: spec.title,
          x: slot.x,
          y: slot.y,
          w: spec.w,
          h: spec.h,
          config: spec.config,
          sortOrder: (gridItems.length + 1) * 10,
        });
        setCatalogOpen(false);
        await loadBoard(dashboard.slug, { quiet: true });
        // Created, then selected, then previewed — so the very first thing the
        // user does with a new element is refine it.
        setSelectedId(created.id);
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setCreating(false);
      }
    },
    [dashboard, activeTab, gridItems, loadBoard],
  );

  const removeWidget = useCallback(
    async (id: number) => {
      if (!dashboard) return;
      const previous = widgets;
      setWidgets((current) => current.filter((widget) => widget.id !== id));
      if (selectedId === id) setSelectedId(null);
      try {
        await dashboardsApi.deleteWidget(id);
        // Compact what is left so deleting never leaves a hole in the grid.
        const remaining = normalizeLayout(
          previous
            .filter((widget) => widget.id !== id && widget.tabKey === activeTab)
            .map((widget) => ({ id: widget.id, x: widget.x, y: widget.y, w: widget.w, h: widget.h })),
        );
        handleLayoutChange(remaining);
      } catch (error) {
        toast.error(errorMessage(error));
        setWidgets(previous);
      }
    },
    [dashboard, widgets, selectedId, activeTab, handleLayoutChange],
  );

  // ═══════════════════════════════════════════════════════════════════════
  // "vs last week" — one extra call per KPI, on demand only
  // ═══════════════════════════════════════════════════════════════════════

  useEffect(() => {
    if (compare !== 'last_week') {
      setWeekDeltasReady(false);
      return;
    }
    let cancelled = false;

    void (async () => {
      const targets = Object.values(resolvedById).filter(
        (entry) => entry.kind === 'metric' && entry.metric && KPI_TYPES.has(entry.widgetType),
      );
      const next: Record<number, MetricDelta> = {};
      // Sequential: a KPI row firing six concurrent aggregates at a pool of ten
      // starves every request behind it, and the row is no faster for it.
      for (const entry of targets) {
        if (cancelled) return;
        try {
          next[entry.widget.id] = await metricsApi.delta({
            ...drillToQuery(entry.metric!.drill),
            compareTo: 'last_week',
          });
        } catch {
          // A comparison that cannot be computed simply is not shown; the tile
          // falls back to "pas d'historique" rather than to a fabricated 0%.
        }
      }
      if (!cancelled) {
        setWeekDeltas(next);
        setWeekDeltasReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [compare, resolvedById]);

  // ═══════════════════════════════════════════════════════════════════════
  // Drill-through
  // ═══════════════════════════════════════════════════════════════════════

  const openDrill = useCallback(
    (request: DrillRequest) => {
      // The queue with the matching saved filter — a real, shareable URL.
      if (request.viewSlug) {
        navigate(`/tickets?view=${encodeURIComponent(request.viewSlug)}`);
        return;
      }
      if (!request.drill) return;

      setDrill({ request, rows: [], total: 0, loading: true, error: null, warnings: [] });

      void metricsApi
        .records({
          ...drillToQuery(request.drill),
          // The NULL group is not addressable over HTTP (see DrillRequest), so
          // it is deliberately NOT sent as a sentinel string — that would
          // filter on the literal text 'null' and return nothing at all.
          group: request.unnarrowable ? undefined : request.group,
          limit: 50,
        })
        .then((page) => {
          setDrill((current) =>
            current && current.request === request
              ? { ...current, rows: page.rows, total: page.total, loading: false, warnings: page.warnings }
              : current,
          );
        })
        .catch((error: unknown) => {
          setDrill((current) =>
            current && current.request === request
              ? { ...current, loading: false, error: errorMessage(error) }
              : current,
          );
        });
    },
    [navigate],
  );

  // ═══════════════════════════════════════════════════════════════════════
  // Derived render helpers
  // ═══════════════════════════════════════════════════════════════════════

  const queueNames = useMemo(
    () => new Map(queues.map((queue) => [queue.slug, queue.name])),
    [queues],
  );
  const priorityLabels = useMemo(
    () => new Map(priorities.map((priority) => [priority.slug, priority.label])),
    [priorities],
  );

  const resolveGroupLabel = useCallback(
    (dimension: string, raw: string): string | null => {
      if (dimension === 'queue_slug') return queueNames.get(raw) ?? null;
      if (dimension === 'priority_slug') return priorityLabels.get(raw) ?? null;
      return null;
    },
    [queueNames, priorityLabels],
  );

  /**
   * Which tile gets the featured treatment (design system §14.1: one XL card
   * plus standard ones). An explicit `featured: true` in a widget's config
   * always wins; otherwise the first KPI in reading order takes it, so a board
   * reads as an Obli* dashboard out of the box without anything being written
   * into the data to make it so.
   */
  const featuredId = useMemo(() => {
    const explicit = tabWidgets.find((widget) => widget.config.featured === true);
    if (explicit) return explicit.id;
    const kpis = tabWidgets
      .filter((widget) => widget.widgetType === 'kpi' || widget.widgetType === 'stat')
      .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
    return kpis[0]?.id ?? null;
  }, [tabWidgets]);

  const renderWidget = useCallback(
    (id: number) => {
      const stored = widgets.find((widget) => widget.id === id);
      if (!stored) return null;

      const showWeek = compare === 'last_week' && weekDeltasReady;
      const isDrafted = draft?.id === id;
      const widget = isDrafted
        ? { ...stored, widgetType: draft.widgetType, title: draft.title, config: draft.config }
        : stored;

      return (
        <Widget
          widget={widget}
          resolved={resolvedById[id] ?? null}
          preview={isDrafted && preview ? preview : null}
          deltaOverride={showWeek ? (weekDeltas[id] ?? null) : undefined}
          compareTo={showWeek ? 'last_week' : 'yesterday'}
          featured={featuredId === id}
          editing={editing}
          onDrill={openDrill}
          onOpenTicket={(ticketId) => navigate(`/tickets/${ticketId}`)}
          resolveGroupLabel={resolveGroupLabel}
        />
      );
    },
    [
      widgets,
      draft,
      resolvedById,
      preview,
      compare,
      weekDeltas,
      weekDeltasReady,
      featuredId,
      editing,
      openDrill,
      navigate,
      resolveGroupLabel,
    ],
  );

  // ═══════════════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════════════

  if (loading && !dashboard) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <LoadingSpinner size="lg" label={t('common.loading', 'Chargement…')} />
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<LayoutGrid size={22} />}
          title={
            loadError
              ? t('dashboard.loadFailed', 'Le tableau de bord n’a pas pu être chargé.')
              : t('dashboard.none', 'Aucun tableau de bord pour ce tenant.')
          }
          description={
            loadError ??
            t(
              'dashboard.noneDetail',
              'Instanciez un tableau livré avec le produit, ou créez le vôtre.',
            )
          }
          action={
            canEdit && templates.length > 0 ? (
              <div className="flex flex-wrap items-center justify-center gap-2">
                {templates.map((template) => (
                  <Button
                    key={template.slug}
                    variant="primary"
                    size="sm"
                    icon={<Sparkles size={14} />}
                    onClick={() => {
                      void (async () => {
                        try {
                          const created = await dashboardsApi.materialize(template.slug);
                          setBoards(await dashboardsApi.list());
                          setSlug(created.slug);
                        } catch (error) {
                          toast.error(errorMessage(error));
                        }
                      })();
                    }}
                  >
                    {t('dashboard.materializeOne', 'Instancier « {{name}} »', { name: template.name })}
                  </Button>
                ))}
              </div>
            ) : undefined
          }
        />
        {canEdit && templates.length > 0 && (
          <p className="mx-auto mt-3 max-w-md text-center text-[11px] leading-relaxed text-text-muted">
            {t(
              'dashboard.materializeWarning',
              'Les widgets existants de ce tableau seront remplacés.',
            )}
          </p>
        )}
      </div>
    );
  }

  const panelOpen = editing && draft !== null && selectedWidget !== null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-wide text-text-primary">
            <LayoutGrid size={22} className="text-accent" />
            {dashboard.name}
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-text-muted">
            <span>
              {t('dashboard.widgetCount', '{{count}} élément(s)', { count: tabWidgets.length })}
            </span>
            {rollupRunning === false && (
              <Badge tone="warning" size="xs" mono>
                {t('dashboard.rollupStopped', 'agrégat nocturne à l’arrêt')}
              </Badge>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {boards.length > 1 && (
            <Select
              aria-label={t('dashboard.choose', 'Choisir un tableau')}
              value={dashboard.slug}
              size="sm"
              wrapperClassName="w-[190px]"
              options={boards.map((board) => ({ value: board.slug, label: board.name }))}
              onChange={(event) => {
                setEditing(false);
                setSelectedId(null);
                setTabKey(null);
                setSlug(event.target.value);
              }}
            />
          )}

          {/* Deltas: "vs hier" is what the board already resolved; "vs semaine
              dernière" costs one extra call per KPI and is opt-in for that
              reason. */}
          <div
            role="tablist"
            aria-label={t('dashboard.compare', 'Comparaison')}
            className="inline-flex items-center gap-0.5 rounded-pill bg-bg-tertiary p-0.5"
          >
            {(['yesterday', 'last_week'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={compare === option}
                onClick={() => setCompare(option)}
                className={cn(
                  'h-6 rounded-[5px] px-2.5 font-mono text-[11px] uppercase tracking-[0.06em] transition-colors',
                  compare === option
                    ? 'bg-bg-active text-text-primary'
                    : 'text-text-muted hover:bg-bg-hover hover:text-text-secondary',
                )}
              >
                {option === 'yesterday'
                  ? t('dashboard.vsYesterday', 'vs hier')
                  : t('dashboard.vsLastWeek', 'vs semaine dernière')}
              </button>
            ))}
          </div>

          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={() => void loadBoard(dashboard.slug, { quiet: true })}
            title={t('common.refresh', 'Actualiser')}
            aria-label={t('common.refresh', 'Actualiser')}
          />

          {canEdit && editing && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={14} />}
              onClick={() => setCatalogOpen(true)}
            >
              {t('dashboard.addWidget', 'Ajouter un élément')}
            </Button>
          )}

          {canEdit && (
            <Button
              variant={editing ? 'primary' : 'secondary'}
              size="sm"
              icon={editing ? <Check size={14} /> : <Pencil size={14} />}
              onClick={() => setEditing((current) => !current)}
            >
              {editing ? t('common.done', 'Terminer') : t('common.edit', 'Modifier')}
            </Button>
          )}
        </div>
      </header>

      {/* ── Tabs ───────────────────────────────────────────────────────── */}
      <nav
        role="tablist"
        aria-label={t('dashboard.tabs', 'Onglets')}
        className="flex flex-wrap items-center gap-1 rounded-pill bg-bg-tertiary p-1"
      >
        {tabs.map((tab) => {
          const active = tab.key === activeTab;
          const count = widgets.filter((widget) => widget.tabKey === tab.key).length;

          if (renamingTab === tab.key) {
            return (
              <input
                key={tab.key}
                autoFocus
                defaultValue={tab.label}
                aria-label={t('dashboard.tab.rename', 'Renommer l’onglet')}
                onBlur={(event) => renameTab(tab.key, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') renameTab(tab.key, event.currentTarget.value);
                  if (event.key === 'Escape') setRenamingTab(null);
                }}
                className="h-7 w-[150px] rounded-[5px] bg-bg-active px-2.5 text-[13px] text-text-primary outline-none ring-1 ring-accent"
              />
            );
          }

          return (
            <div key={tab.key} className="flex items-center">
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setTabKey(tab.key);
                  setSelectedId(null);
                }}
                onDoubleClick={() => {
                  if (editing) setRenamingTab(tab.key);
                }}
                title={
                  editing
                    ? t('dashboard.tab.renameHint', 'Double-cliquer pour renommer')
                    : undefined
                }
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-[5px] px-3 text-[13px] transition-colors',
                  active
                    ? 'bg-bg-active font-medium text-text-primary'
                    : 'text-text-muted hover:bg-bg-hover hover:text-text-secondary',
                )}
              >
                {tab.label}
                <span className="font-mono text-[10px] opacity-60">{formatNumber(count)}</span>
              </button>

              {/* Double-click renames, but a discoverable affordance beats a
                  gesture nobody is told about — so the active tab also gets a
                  pencil while the board is being edited. */}
              {editing && active && (
                <button
                  type="button"
                  onClick={() => setRenamingTab(tab.key)}
                  aria-label={t('dashboard.tab.rename', 'Renommer l’onglet')}
                  title={t('dashboard.tab.rename', 'Renommer l’onglet')}
                  className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-[5px] text-text-muted transition-colors hover:bg-bg-hover hover:text-accent"
                >
                  <Pencil size={10} />
                </button>
              )}

              {editing && count === 0 && tabs.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeTab(tab.key)}
                  aria-label={t('dashboard.tab.remove', 'Supprimer l’onglet')}
                  title={t('dashboard.tab.remove', 'Supprimer l’onglet')}
                  className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-[5px] text-text-muted transition-colors hover:bg-priority-p1/20 hover:text-priority-p1"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          );
        })}

        {canEdit && editing && (
          <button
            type="button"
            onClick={addTab}
            className="flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[13px] text-text-muted transition-colors hover:bg-bg-hover hover:text-accent"
          >
            <Plus size={13} />
            {t('dashboard.tab.add', 'Ajouter un onglet')}
          </button>
        )}
      </nav>

      {loadError && (
        <p className="rounded-card bg-sla-breach-bg px-3 py-2 text-[12px] text-sla-breach">{loadError}</p>
      )}

      {/* ── Board + panel ──────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <main className="min-w-0 flex-1 overflow-y-auto pb-4 pr-0.5">
          <WidgetGrid
            items={gridItems}
            editing={editing}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onLayoutChange={handleLayoutChange}
            onRemove={(id) => setConfirmDelete(id)}
            renderItem={renderWidget}
            empty={
              <EmptyState
                icon={<LayoutGrid size={22} />}
                title={t('dashboard.tab.empty', 'Cet onglet est vide.')}
                description={
                  canEdit
                    ? t(
                        'dashboard.tab.emptyDetail',
                        'Passez en mode « Modifier », puis ajoutez un élément.',
                      )
                    : t(
                        'dashboard.tab.emptyReadOnly',
                        'Aucun élément n’a encore été placé sur cet onglet.',
                      )
                }
                action={
                  canEdit ? (
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Plus size={14} />}
                      onClick={() => {
                        setEditing(true);
                        setCatalogOpen(true);
                      }}
                    >
                      {t('dashboard.addWidget', 'Ajouter un élément')}
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        </main>

        {panelOpen && draft && (
          <div className="w-full shrink-0 lg:w-[330px]">
            <WidgetConfigPanel
              draft={draft}
              catalog={catalog}
              views={views.map((view) => ({ slug: view.slug, name: view.name }))}
              queues={queues}
              priorities={priorities}
              dirty={dirty}
              saving={savingWidget}
              error={panelError}
              onChange={setDraft}
              onSave={() => void saveWidget()}
              onRevert={revertDraft}
              onClose={() => setSelectedId(null)}
              onDelete={() => setConfirmDelete(draft.id)}
            />
          </div>
        )}
      </div>

      {/* ── Add an element ─────────────────────────────────────────────── */}
      <WidgetCatalog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        catalog={catalog}
        views={views.map((view) => ({ slug: view.slug, name: view.name }))}
        onPick={(spec) => void addWidget(spec)}
        busy={creating}
      />

      {/* ── Deleting an element is confirmed, once ─────────────────────── */}
      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        size="sm"
        closeOnBackdrop={false}
        title={t('dashboard.deleteWidget', 'Retirer cet élément ?')}
        closeLabel={t('common.close', 'Fermer')}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
              {t('common.cancel', 'Annuler')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                const id = confirmDelete;
                setConfirmDelete(null);
                if (id !== null) void removeWidget(id);
              }}
            >
              {t('common.delete', 'Supprimer')}
            </Button>
          </div>
        }
      >
        <p className="text-[13px] leading-relaxed text-text-secondary">
          {t(
            'dashboard.deleteWidgetDetail',
            'Sa configuration (mesure, axe, période, filtres) est supprimée avec lui. Les autres éléments remontent pour combler le trou.',
          )}
        </p>
      </Modal>

      {/* ── Drill-through ──────────────────────────────────────────────── */}
      <Modal
        open={drill !== null}
        onClose={() => setDrill(null)}
        size="xl"
        title={drill?.request.title ?? ''}
        subtitle={
          drill
            ? drill.request.segmentLabel
              ? t('dashboard.drill.segment', 'Segment : {{segment}}', {
                  segment: drill.request.segmentLabel,
                })
              : t('dashboard.drill.all', 'Tous les enregistrements derrière ce nombre')
            : undefined
        }
        closeLabel={t('common.close', 'Fermer')}
      >
        {drill && (
          <div className="space-y-3">
            {/* The one case the reporting API cannot express. Saying it is the
                only honest option: the list below is the whole metric, not the
                segment that was clicked. */}
            {drill.request.unnarrowable && (
              <p className="rounded-card bg-sla-warn-bg px-3 py-2 text-[11px] leading-relaxed text-sla-warn">
                {t(
                  'dashboard.drill.unnarrowable',
                  'Ce segment regroupe les enregistrements sans valeur sur cet axe. L’API de forage ne sait pas encore exprimer un groupe vide : la liste ci-dessous couvre donc l’ensemble de la mesure, pas seulement ce segment.',
                )}
              </p>
            )}

            {drill.warnings.map((warning) => (
              <p
                key={warning}
                className="rounded-card bg-bg-tertiary px-3 py-2 text-[11px] leading-relaxed text-text-muted"
              >
                {warning}
              </p>
            ))}

            {drill.loading && (
              <div className="flex items-center justify-center py-10">
                <LoadingSpinner label={t('common.loading', 'Chargement…')} />
              </div>
            )}

            {drill.error && (
              <p className="rounded-card bg-sla-breach-bg px-3 py-2 text-[12px] text-sla-breach">
                {drill.error}
              </p>
            )}

            {!drill.loading && !drill.error && drill.rows.length === 0 && (
              <EmptyState
                compact
                title={t('dashboard.drill.empty', 'Aucun enregistrement.')}
                description={t(
                  'dashboard.drill.emptyDetail',
                  'Le nombre affiché vaut zéro sur cette période, ou tous ses enregistrements ont été supprimés depuis.',
                )}
              />
            )}

            {!drill.loading && drill.rows.length > 0 && (
              <>
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
                  {t('dashboard.drill.count', '{{count}} enregistrement(s)', {
                    count: drill.total,
                  })}
                </p>
                <ul className="max-h-[55vh] space-y-0.5 overflow-y-auto">
                  {drill.rows.map((row) => (
                    <TicketLine
                      key={row.id}
                      row={row}
                      onOpen={() => {
                        setDrill(null);
                        navigate(`/tickets/${row.id}`);
                      }}
                    />
                  ))}
                </ul>
                {/* The metric was narrowed by a saved view, so the queue CAN
                    show that view — but only the view, never the clicked
                    segment, which the queue has no way to express. The label
                    names the view so nobody expects the segment. */}
                {drill.request.drill?.viewSlug && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<ExternalLink size={14} />}
                    onClick={() => {
                      const view = drill.request.drill?.viewSlug;
                      setDrill(null);
                      if (view) navigate(`/tickets?view=${encodeURIComponent(view)}`);
                    }}
                  >
                    {t('dashboard.drill.openView', 'Ouvrir la vue « {{view}} » dans la file', {
                      view: drill.request.drill.viewSlug,
                    })}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

/** The metric key a stored config names, whichever alias it used. */
function readMetricKey(config: Record<string, unknown>): string {
  const value = config.metric ?? config.metricKey;
  return typeof value === 'string' ? value : '';
}

export default DashboardsPage;
