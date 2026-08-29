/**
 * WidgetConfigPanel.tsx — the right-hand Configuration panel.
 *
 * ── The panel IS the metric registry ─────────────────────────────────────────
 * Every control here is generated from `GET /api/metrics/catalog`. Pick
 * "Satisfaction" and the group-by list becomes exactly the five dimensions that
 * metric declares; pick "Ouverts par file" and the axis control goes read-only,
 * because the registry pins it. There is no free-text field anywhere that
 * reaches a query, no operator picker, no column list.
 *
 * That is not a UX nicety, it is the boundary. A reporting API that accepts a
 * query fragment accepts SQL by a slower route, and the reason the server can
 * refuse everything it does not declare is that the client never has to ask for
 * anything else. An invalid combination is not rejected here — it is
 * UNPICKABLE. If you find yourself adding an `<Input>` whose value ends up in a
 * `WHERE`, stop and add a metric to the registry instead.
 *
 * ── Two things are stored but never sent ─────────────────────────────────────
 * `sort` and `featured` live in the widget config and are read only by the
 * client. Display order is a reader's preference: the SERVER always selects the
 * top N groups by value (a `LIMIT` on an ordered aggregate), and letting the
 * client name an `ORDER BY` would be letting it name a column. The panel says
 * so next to the control rather than leaving the reader to assume the sort
 * changed which bars they are looking at.
 *
 * ── Autosave rules do not apply here ─────────────────────────────────────────
 * HARD RULE 12 governs INLINE field editing on a record. This is a
 * configuration form for a stored object with a live preview, so it is
 * explicitly draft → preview → save, with a visible dirty state and a revert.
 * Every keystroke re-resolves the preview; nothing is written until "Enregistrer".
 */

import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, Save, Trash2, X } from 'lucide-react';
import {
  STATUS_CATEGORIES,
  STATUS_CATEGORY_META,
  TICKET_RECORD_TYPES,
  TICKET_SOURCES,
} from '@oblidesk/shared';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select, type SelectOption } from '@/components/common/Select';
import { Toggle } from '@/components/common/Toggle';
import { cn } from '@/utils/cn';
import {
  METRIC_DIMENSION_LABELS,
  METRIC_GRANULARITIES,
  METRIC_GRANULARITY_LABELS,
  METRIC_RANGE_LABELS,
  SCOPE_KEY_FOR_DIMENSION,
  type MetricCatalogEntry,
  type MetricDimension,
  type MetricGranularity,
  type MetricQuery,
  type MetricRangeKey,
  type MetricScope,
} from '@/api/metrics.api';
import { CHART_SORTS, type ChartSort } from './charts/BarChart';
import { SWITCHABLE_TYPES, WIDGET_TYPE_SPEC_BY_TYPE } from './WidgetCatalog';

// ═════════════════════════════════════════════════════════════════════════════
// Draft
// ═════════════════════════════════════════════════════════════════════════════

export interface WidgetConfigDraft {
  id: number;
  widgetType: string;
  title: string | null;
  config: Record<string, unknown>;
}

/** The editable settings, read out of a stored config whatever alias it used. */
export interface WidgetSettings {
  metricKey: string;
  /** '' = let the metric choose its own default window. */
  range: string;
  from: string;
  to: string;
  groupBy: string;
  granularity: string;
  /** The saved view that NARROWS the metric. */
  viewSlug: string;
  /** The saved view a click opens in the ticket queue. */
  drillToView: string;
  limit: string;
  target: string;
  sort: ChartSort;
  featured: boolean;
  text: string;
  scope: MetricScope;
}

/**
 * Config keys and the aliases the server also accepts.
 *
 * `planWidget` reads `config.window ?? config.range ?? config.date_range ??
 * config.dateRange`, so writing `range` while a stale `window` sits next to it
 * would silently do nothing. Every write goes through {@link setKey}, which
 * sets the canonical name AND deletes the aliases — the only way to make an
 * edit mean what it looks like.
 */
const KEYS = {
  metric: { canonical: 'metric', aliases: ['metricKey'] },
  range: { canonical: 'window', aliases: ['range', 'date_range', 'dateRange'] },
  groupBy: { canonical: 'group_by', aliases: ['groupBy'] },
  granularity: { canonical: 'interval', aliases: ['granularity'] },
  view: { canonical: 'view', aliases: ['viewSlug'] },
  drillToView: { canonical: 'drill_to_view', aliases: ['drillToView'] },
  limit: { canonical: 'limit', aliases: [] as string[] },
  target: { canonical: 'target', aliases: [] as string[] },
  from: { canonical: 'from', aliases: [] as string[] },
  to: { canonical: 'to', aliases: [] as string[] },
  sort: { canonical: 'sort', aliases: [] as string[] },
  featured: { canonical: 'featured', aliases: [] as string[] },
  text: { canonical: 'text', aliases: [] as string[] },
} as const;

/** Root-level scope names the server's `readScope` understands. */
const SCOPE_ROOT_KEYS = [
  'queue_slug', 'queueSlug', 'priority_slug', 'prioritySlug',
  'record_type', 'recordType', 'ticket_source', 'source',
  'assignee_id', 'assigneeId', 'assignment_group_id', 'assignmentGroupId',
  'organization_id', 'organizationId', 'status_category', 'statusCategory',
];

function readString(config: Record<string, unknown>, spec: { canonical: string; aliases: readonly string[] }): string {
  for (const name of [spec.canonical, ...spec.aliases]) {
    const value = config[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function setKey(
  config: Record<string, unknown>,
  spec: { canonical: string; aliases: readonly string[] },
  value: unknown,
): Record<string, unknown> {
  const next = { ...config };
  for (const alias of spec.aliases) delete next[alias];
  if (value === null || value === undefined || value === '') delete next[spec.canonical];
  else next[spec.canonical] = value;
  return next;
}

/**
 * The effective scope, read the way the SERVER reads it: a `scope` object wins
 * outright, and only when there is none do root-level keys count.
 */
export function readScope(config: Record<string, unknown>): MetricScope {
  const raw =
    config.scope && typeof config.scope === 'object' && !Array.isArray(config.scope)
      ? (config.scope as Record<string, unknown>)
      : config;

  const str = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = raw[name];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return undefined;
  };
  const num = (...names: string[]): number | undefined => {
    for (const name of names) {
      const value = Number(raw[name]);
      if (Number.isInteger(value) && value > 0) return value;
    }
    return undefined;
  };

  const scope: MetricScope = {};
  const queueSlug = str('queue_slug', 'queueSlug');
  if (queueSlug) scope.queueSlug = queueSlug;
  const prioritySlug = str('priority_slug', 'prioritySlug');
  if (prioritySlug) scope.prioritySlug = prioritySlug;
  const recordType = str('record_type', 'recordType');
  if (recordType) scope.recordType = recordType as MetricScope['recordType'];
  const source = str('ticket_source', 'source');
  if (source) scope.source = source as MetricScope['source'];
  const statusCategory = str('status_category', 'statusCategory');
  if (statusCategory) scope.statusCategory = statusCategory as MetricScope['statusCategory'];
  const assigneeId = num('assignee_id', 'assigneeId');
  if (assigneeId) scope.assigneeId = assigneeId;
  const groupId = num('assignment_group_id', 'assignmentGroupId');
  if (groupId) scope.assignmentGroupId = groupId;
  const organizationId = num('organization_id', 'organizationId');
  if (organizationId) scope.organizationId = organizationId;
  return scope;
}

export function readWidgetSettings(config: Record<string, unknown>): WidgetSettings {
  const sort = readString(config, KEYS.sort);
  return {
    metricKey: readString(config, KEYS.metric),
    range: readString(config, KEYS.range),
    from: readString(config, KEYS.from),
    to: readString(config, KEYS.to),
    groupBy: readString(config, KEYS.groupBy),
    granularity: readString(config, KEYS.granularity),
    viewSlug: readString(config, KEYS.view),
    drillToView: readString(config, KEYS.drillToView),
    limit: readString(config, KEYS.limit),
    target: readString(config, KEYS.target),
    sort: (CHART_SORTS as readonly string[]).includes(sort) ? (sort as ChartSort) : 'value_desc',
    featured: config.featured === true,
    text: typeof config.text === 'string' ? config.text : '',
    scope: readScope(config),
  };
}

/**
 * Write one setting back.
 *
 * Scope is always normalised into a single `scope` object with the root-level
 * aliases removed, because the server reads one OR the other and a config
 * holding both is a config whose filters depend on which branch fired.
 */
export function writeSetting(
  config: Record<string, unknown>,
  patch: Partial<WidgetSettings>,
): Record<string, unknown> {
  let next = { ...config };

  if (patch.metricKey !== undefined) next = setKey(next, KEYS.metric, patch.metricKey);
  if (patch.range !== undefined) next = setKey(next, KEYS.range, patch.range);
  if (patch.from !== undefined) next = setKey(next, KEYS.from, patch.from);
  if (patch.to !== undefined) next = setKey(next, KEYS.to, patch.to);
  if (patch.groupBy !== undefined) next = setKey(next, KEYS.groupBy, patch.groupBy);
  if (patch.granularity !== undefined) next = setKey(next, KEYS.granularity, patch.granularity);
  if (patch.viewSlug !== undefined) next = setKey(next, KEYS.view, patch.viewSlug);
  if (patch.drillToView !== undefined) next = setKey(next, KEYS.drillToView, patch.drillToView);
  if (patch.sort !== undefined) next = setKey(next, KEYS.sort, patch.sort);
  if (patch.text !== undefined) next = setKey(next, KEYS.text, patch.text);

  if (patch.featured !== undefined) {
    if (patch.featured) next[KEYS.featured.canonical] = true;
    else delete next[KEYS.featured.canonical];
  }

  if (patch.limit !== undefined) {
    const parsed = Number(patch.limit);
    next = setKey(next, KEYS.limit, Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : '');
  }
  if (patch.target !== undefined) {
    const parsed = Number(patch.target);
    next = setKey(next, KEYS.target, patch.target.trim() !== '' && Number.isFinite(parsed) ? parsed : '');
  }

  if (patch.scope !== undefined) {
    for (const name of SCOPE_ROOT_KEYS) delete next[name];
    const scope: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch.scope)) {
      if (value !== undefined && value !== null && value !== '') scope[key] = value;
    }
    if (Object.keys(scope).length > 0) next.scope = scope;
    else delete next.scope;
  }

  return next;
}

/**
 * Turn a draft into the metric request that powers the LIVE PREVIEW.
 *
 * Deliberately mirrors `planWidget`: every value is checked against the
 * catalogue entry before it is included, so the preview asks for exactly what
 * the server would accept on save. A setting the metric does not declare is
 * dropped here rather than sent and rejected — the preview must show what
 * saving will actually produce.
 */
export function toPreviewQuery(
  draft: WidgetConfigDraft,
  entry: MetricCatalogEntry | null,
): MetricQuery | null {
  if (!entry) return null;
  const settings = readWidgetSettings(draft.config);

  const range =
    settings.range && (entry.ranges as string[]).includes(settings.range)
      ? (settings.range as MetricRangeKey)
      : undefined;

  const groupBy =
    entry.forcedGroupBy ??
    (settings.groupBy && (entry.dimensions as string[]).includes(settings.groupBy)
      ? (settings.groupBy as MetricDimension)
      : null);

  const wantsSeries = SERIES_TYPES.has(draft.widgetType);
  const granularity = (METRIC_GRANULARITIES as readonly string[]).includes(settings.granularity)
    ? (settings.granularity as MetricGranularity)
    : wantsSeries
      ? 'day'
      : null;

  // A scope key is only legal when the metric declares the matching dimension —
  // `applyScope` throws otherwise, and a preview that 400s teaches nothing.
  const scope: MetricScope = {};
  for (const [dimension, scopeKey] of Object.entries(SCOPE_KEY_FOR_DIMENSION)) {
    if (!scopeKey) continue;
    if (!(entry.dimensions as string[]).includes(dimension)) continue;
    const value = settings.scope[scopeKey];
    if (value !== undefined && value !== null && value !== '') {
      Object.assign(scope, { [scopeKey]: value });
    }
  }

  const limit = Number(settings.limit);

  return {
    key: entry.key,
    range,
    from: range === 'custom' ? settings.from || undefined : undefined,
    to: range === 'custom' ? settings.to || undefined : undefined,
    groupBy,
    granularity,
    viewSlug: settings.viewSlug || null,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.round(limit), 200) : undefined,
    ...scope,
  };
}

const SERIES_TYPES = new Set(['line_chart', 'area_chart', 'line', 'area', 'heatmap']);
const GROUPED_TYPES = new Set(['bar_chart', 'bar', 'donut', 'pie', 'queue_load', 'agent_leaderboard']);
const METRIC_TYPES = new Set([
  'kpi', 'stat', 'number', 'sla_gauge', 'csat', 'time_summary',
  ...SERIES_TYPES, ...GROUPED_TYPES,
]);

// ═════════════════════════════════════════════════════════════════════════════
// Panel
// ═════════════════════════════════════════════════════════════════════════════

interface WidgetConfigPanelProps {
  draft: WidgetConfigDraft;
  catalog: MetricCatalogEntry[];
  views: Array<{ slug: string; name: string }>;
  /** Queue slugs, for the queue filter. Empty ⇒ the row is not offered. */
  queues: Array<{ slug: string; name: string }>;
  /** Priority slugs from the tenant's `priority_matrix`. */
  priorities: Array<{ slug: string; label: string }>;
  dirty: boolean;
  saving: boolean;
  /** The server's refusal, verbatim — it names the offending setting. */
  error: string | null;
  onChange: (next: WidgetConfigDraft) => void;
  onSave: () => void;
  onRevert: () => void;
  onClose: () => void;
  onDelete: () => void;
  className?: string;
}

export function WidgetConfigPanel({
  draft,
  catalog,
  views,
  queues,
  priorities,
  dirty,
  saving,
  error,
  onChange,
  onSave,
  onRevert,
  onClose,
  onDelete,
  className,
}: WidgetConfigPanelProps) {
  const { t } = useTranslation();

  const settings = readWidgetSettings(draft.config);
  const entry = useMemo(
    () => catalog.find((item) => item.key === settings.metricKey) ?? null,
    [catalog, settings.metricKey],
  );

  const isMetric = METRIC_TYPES.has(draft.widgetType);
  const isSeries = SERIES_TYPES.has(draft.widgetType);
  const isGrouped = GROUPED_TYPES.has(draft.widgetType);
  const isText = draft.widgetType === 'text';
  const isList = draft.widgetType === 'ticket_list';
  const isFeed = draft.widgetType === 'activity_feed' || draft.widgetType === 'alert_feed';

  const patchConfig = (patch: Partial<WidgetSettings>): void => {
    onChange({ ...draft, config: writeSetting(draft.config, patch) });
  };

  /**
   * Changing the metric re-checks everything that hung off the old one.
   * Silently keeping a group-by the new metric does not declare would produce a
   * widget that previews fine and 400s on save.
   */
  const changeMetric = (key: string): void => {
    const next = catalog.find((item) => item.key === key) ?? null;
    const patch: Partial<WidgetSettings> = { metricKey: key };
    if (next) {
      if (settings.groupBy && !(next.dimensions as string[]).includes(settings.groupBy)) patch.groupBy = '';
      if (settings.range && !(next.ranges as string[]).includes(settings.range)) patch.range = '';
      const legal: MetricScope = {};
      for (const [dimension, scopeKey] of Object.entries(SCOPE_KEY_FOR_DIMENSION)) {
        if (!scopeKey) continue;
        if (!(next.dimensions as string[]).includes(dimension)) continue;
        const value = settings.scope[scopeKey];
        if (value !== undefined) Object.assign(legal, { [scopeKey]: value });
      }
      patch.scope = legal;
    }
    patchConfig(patch);
  };

  // ── option lists, all generated from the registry ────────────────────────
  const typeOptions: SelectOption[] = useMemo(() => {
    const options: SelectOption[] = SWITCHABLE_TYPES.map((type) => ({
      value: type,
      label: t(WIDGET_TYPE_SPEC_BY_TYPE[type].labelKey, WIDGET_TYPE_SPEC_BY_TYPE[type].label),
    }));
    // A board may already hold a type this build does not offer. Keeping it as
    // the current value means opening the panel cannot silently rewrite it.
    if (!(SWITCHABLE_TYPES as readonly string[]).includes(draft.widgetType)) {
      options.unshift({ value: draft.widgetType, label: draft.widgetType });
    }
    return options;
  }, [draft.widgetType, t]);

  const metricOptions: SelectOption[] = useMemo(
    () =>
      catalog.map((item) => ({
        value: item.key,
        label: t(item.labelKey, item.label),
        group:
          item.seriesSource === 'rollup'
            ? t('dashboard.config.snapshotMetrics', 'Mesures ponctuelles (agrégat nocturne)')
            : t('dashboard.config.liveMetrics', 'Mesures calculées en direct'),
      })),
    [catalog, t],
  );

  const dimensionOptions: SelectOption[] = useMemo(() => {
    if (!entry) return [];
    return entry.dimensions.map((dimension) => ({
      value: dimension,
      label: t(METRIC_DIMENSION_LABELS[dimension].key, METRIC_DIMENSION_LABELS[dimension].fallback),
    }));
  }, [entry, t]);

  const rangeOptions: SelectOption[] = useMemo(() => {
    if (!entry) return [];
    return entry.ranges.map((range) => ({
      value: range,
      label: t(METRIC_RANGE_LABELS[range].key, METRIC_RANGE_LABELS[range].fallback),
    }));
  }, [entry, t]);

  const viewOptions: SelectOption[] = useMemo(
    () => views.map((view) => ({ value: view.slug, label: view.name })),
    [views],
  );

  return (
    <aside
      className={cn(
        // HARD RULE 11 — the panel is a raised surface, not an outlined one.
        'flex h-full w-full flex-col rounded-card bg-bg-secondary shadow-card',
        className,
      )}
      aria-label={t('dashboard.config.title', 'Configuration')}
    >
      <header className="flex items-start justify-between gap-2 p-3 pb-2">
        <div className="min-w-0">
          <h2 className="font-display text-[15px] font-semibold tracking-wide text-text-primary">
            {t('dashboard.config.title', 'Configuration')}
          </h2>
          <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
            {draft.title?.trim() ||
              (entry ? t(entry.labelKey, entry.label) : t('dashboard.widget.untitled', 'Élément'))}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Fermer')}
          title={t('common.close', 'Fermer')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <X size={14} />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-3">
        {/* ── Apparence ─────────────────────────────────────────────────── */}
        <Section title={t('dashboard.config.appearance', 'Apparence')}>
          <Input
            label={t('dashboard.config.widgetTitle', 'Titre')}
            value={draft.title ?? ''}
            placeholder={entry ? t(entry.labelKey, entry.label) : t('dashboard.config.titlePlaceholder', 'Titre de l’élément')}
            hint={t('dashboard.config.titleHint', 'Vide : le nom de la mesure est utilisé.')}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
            size="sm"
          />

          <Select
            label={t('dashboard.config.visualization', 'Type de visualisation')}
            value={draft.widgetType}
            options={typeOptions}
            size="sm"
            onChange={(event) => onChange({ ...draft, widgetType: event.target.value })}
          />

          {(draft.widgetType === 'kpi' || draft.widgetType === 'stat') && (
            <Toggle
              label={t('dashboard.config.featured', 'Mettre en avant')}
              description={t(
                'dashboard.config.featuredHint',
                'Carte accentuée, valeur plus grande. Un seul élément par ligne d’indicateurs.',
              )}
              checked={settings.featured}
              onChange={(checked) => patchConfig({ featured: checked })}
            />
          )}
        </Section>

        {/* ── Source de données ─────────────────────────────────────────── */}
        <Section title={t('dashboard.config.source', 'Source de données')}>
          {isText && (
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-text-secondary">
                {t('dashboard.config.text', 'Contenu')}
              </span>
              <textarea
                value={settings.text}
                rows={6}
                onChange={(event) => patchConfig({ text: event.target.value })}
                placeholder={t('dashboard.config.textPlaceholder', 'Consigne de garde, lien de procédure…')}
                className="min-h-[96px] rounded-card bg-bg-tertiary px-3 py-2 text-[13px] text-text-primary outline-none focus:ring-1 focus:ring-accent"
              />
            </label>
          )}

          {isList && (
            <Select
              label={t('dashboard.config.savedView', 'Vue enregistrée')}
              value={settings.viewSlug}
              options={viewOptions}
              placeholder={t('dashboard.config.pickView', 'Choisir une vue')}
              hint={t(
                'dashboard.config.savedViewHint',
                'Une liste de tickets ne peut exister sans vue enregistrée : c’est la vue qui porte le filtre.',
              )}
              size="sm"
              onChange={(event) => patchConfig({ viewSlug: event.target.value })}
            />
          )}

          {isFeed && (
            <Input
              label={t('dashboard.config.limit', 'Nombre de lignes')}
              type="number"
              min={1}
              max={200}
              value={settings.limit}
              placeholder="20"
              size="sm"
              onChange={(event) => patchConfig({ limit: event.target.value })}
            />
          )}

          {isMetric && (
            <>
              <Select
                label={t('dashboard.config.metric', 'Mesure')}
                value={settings.metricKey}
                options={metricOptions}
                placeholder={t('dashboard.config.pickMetric', 'Choisir une mesure')}
                size="sm"
                onChange={(event) => changeMetric(event.target.value)}
              />

              {entry && (
                <p className="rounded-card bg-bg-tertiary px-2.5 py-2 text-[11px] leading-relaxed text-text-muted">
                  {entry.description}
                </p>
              )}

              {entry?.seriesSource === 'rollup' && (
                <p className="text-[11px] leading-relaxed text-sla-warn">
                  {t(
                    'dashboard.config.rollupWarning',
                    'Mesure ponctuelle : son historique vient de l’agrégat nocturne. Sur une fenêtre bornée, elle est vide tant que l’agrégat n’a pas tourné. C’est ce qu’affichera l’élément, plutôt qu’un zéro.',
                  )}
                </p>
              )}
            </>
          )}
        </Section>

        {/* ── Axes et période ───────────────────────────────────────────── */}
        {isMetric && entry && (
          <Section title={t('dashboard.config.axes', 'Axes et période')}>
            {entry.forcedGroupBy ? (
              <ReadOnlyRow
                label={t('dashboard.config.groupBy', 'Regrouper par')}
                value={t(
                  METRIC_DIMENSION_LABELS[entry.forcedGroupBy].key,
                  METRIC_DIMENSION_LABELS[entry.forcedGroupBy].fallback,
                )}
                hint={t(
                  'dashboard.config.forcedGroupBy',
                  'Cette mesure est toujours regroupée sur cet axe : il fait partie de sa définition.',
                )}
              />
            ) : (
              <Select
                label={t('dashboard.config.groupBy', 'Regrouper par')}
                value={settings.groupBy}
                options={[
                  { value: '', label: t('dashboard.config.noGrouping', 'Aucun regroupement') },
                  ...dimensionOptions,
                ]}
                hint={
                  dimensionOptions.length === 0
                    ? t('dashboard.config.noDimensions', 'Cette mesure ne déclare aucun axe.')
                    : undefined
                }
                disabled={dimensionOptions.length === 0}
                size="sm"
                onChange={(event) => patchConfig({ groupBy: event.target.value })}
              />
            )}

            <Select
              label={t('dashboard.config.range', 'Période')}
              value={settings.range}
              options={[
                { value: '', label: t('dashboard.config.metricDefault', 'Période par défaut de la mesure') },
                ...rangeOptions,
              ]}
              size="sm"
              onChange={(event) => patchConfig({ range: event.target.value })}
            />

            {settings.range === 'custom' && (
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label={t('dashboard.config.from', 'Du')}
                  type="datetime-local"
                  value={toLocalInput(settings.from)}
                  size="sm"
                  onChange={(event) => patchConfig({ from: fromLocalInput(event.target.value) })}
                />
                <Input
                  label={t('dashboard.config.to', 'Au')}
                  type="datetime-local"
                  value={toLocalInput(settings.to)}
                  size="sm"
                  onChange={(event) => patchConfig({ to: fromLocalInput(event.target.value) })}
                />
              </div>
            )}

            {isSeries && (
              <Select
                label={t('dashboard.config.interval', 'Intervalle')}
                value={settings.granularity || 'day'}
                options={METRIC_GRANULARITIES.map((granularity) => ({
                  value: granularity,
                  label: t(
                    METRIC_GRANULARITY_LABELS[granularity].key,
                    METRIC_GRANULARITY_LABELS[granularity].fallback,
                  ),
                }))}
                size="sm"
                onChange={(event) => patchConfig({ granularity: event.target.value })}
              />
            )}

            {isGrouped && (
              <>
                <Select
                  label={t('dashboard.config.sort', 'Tri')}
                  value={settings.sort}
                  options={[
                    { value: 'value_desc', label: t('dashboard.config.sortValueDesc', 'Valeur décroissante') },
                    { value: 'value_asc', label: t('dashboard.config.sortValueAsc', 'Valeur croissante') },
                    { value: 'label_asc', label: t('dashboard.config.sortLabelAsc', 'Libellé A → Z') },
                    { value: 'label_desc', label: t('dashboard.config.sortLabelDesc', 'Libellé Z → A') },
                  ]}
                  hint={t(
                    'dashboard.config.sortHint',
                    'Ordre d’affichage seulement : les segments retenus restent les N plus grands.',
                  )}
                  size="sm"
                  onChange={(event) => patchConfig({ sort: event.target.value as ChartSort })}
                />

                <Input
                  label={t('dashboard.config.segments', 'Nombre de segments')}
                  type="number"
                  min={1}
                  max={200}
                  value={settings.limit}
                  placeholder="20"
                  size="sm"
                  onChange={(event) => patchConfig({ limit: event.target.value })}
                />
              </>
            )}

            {(isSeries || draft.widgetType === 'sla_gauge' || isGrouped) && (
              <Input
                label={t('dashboard.config.target', 'Cible')}
                type="number"
                value={settings.target}
                placeholder={t('dashboard.config.targetPlaceholder', 'ex. 95')}
                hint={t('dashboard.config.targetHint', 'Trace une ligne de référence sur le graphique.')}
                size="sm"
                onChange={(event) => patchConfig({ target: event.target.value })}
              />
            )}
          </Section>
        )}

        {/* ── Filtres ───────────────────────────────────────────────────── */}
        {isMetric && entry && (
          <Section
            title={t('dashboard.config.filters', 'Filtres')}
            hint={t(
              'dashboard.config.filtersHint',
              'Seuls les axes déclarés par la mesure sont proposés : le serveur refuse les autres.',
            )}
          >
            <Select
              label={t('dashboard.config.narrowByView', 'Vue enregistrée')}
              value={settings.viewSlug}
              options={[
                { value: '', label: t('dashboard.config.noView', 'Aucune') },
                ...viewOptions,
              ]}
              hint={t(
                'dashboard.config.narrowByViewHint',
                'La seule façon d’aller au-delà des axes déclarés : une vue est une configuration publiée, versionnée et vérifiée.',
              )}
              size="sm"
              onChange={(event) => patchConfig({ viewSlug: event.target.value })}
            />

            {declares(entry, 'queue_slug') && (
              <ScopeSelect
                label={t('metricDimension.queueSlug', 'File')}
                value={settings.scope.queueSlug ?? ''}
                options={queues.map((queue) => ({ value: queue.slug, label: queue.name }))}
                emptyLabel={t('dashboard.config.allValues', 'Toutes')}
                onChange={(value) =>
                  patchConfig({ scope: { ...settings.scope, queueSlug: value || undefined } })
                }
              />
            )}

            {declares(entry, 'priority_slug') && (
              <ScopeSelect
                label={t('metricDimension.prioritySlug', 'Priorité')}
                value={settings.scope.prioritySlug ?? ''}
                options={priorities.map((priority) => ({ value: priority.slug, label: priority.label }))}
                emptyLabel={t('dashboard.config.allValues', 'Toutes')}
                onChange={(value) =>
                  patchConfig({ scope: { ...settings.scope, prioritySlug: value || undefined } })
                }
              />
            )}

            {declares(entry, 'record_type') && (
              <ScopeSelect
                label={t('metricDimension.recordType', 'Type d’enregistrement')}
                value={settings.scope.recordType ?? ''}
                options={TICKET_RECORD_TYPES.map((type) => ({
                  value: type,
                  label: t(`ticket.recordType.${type}`, type),
                }))}
                emptyLabel={t('dashboard.config.allValues', 'Tous')}
                onChange={(value) =>
                  patchConfig({
                    scope: { ...settings.scope, recordType: (value || undefined) as MetricScope['recordType'] },
                  })
                }
              />
            )}

            {declares(entry, 'source') && (
              <ScopeSelect
                label={t('metricDimension.source', 'Canal d’arrivée')}
                value={settings.scope.source ?? ''}
                options={TICKET_SOURCES.map((source) => ({
                  value: source,
                  label: t(`ticket.source.${source}`, source),
                }))}
                emptyLabel={t('dashboard.config.allValues', 'Tous')}
                onChange={(value) =>
                  patchConfig({
                    scope: { ...settings.scope, source: (value || undefined) as MetricScope['source'] },
                  })
                }
              />
            )}

            {declares(entry, 'status_category') && (
              <ScopeSelect
                label={t('metricDimension.statusCategory', 'Catégorie de statut')}
                value={settings.scope.statusCategory ?? ''}
                options={STATUS_CATEGORIES.map((category) => ({
                  value: category,
                  label: t(STATUS_CATEGORY_META[category].labelKey, STATUS_CATEGORY_META[category].label),
                }))}
                emptyLabel={t('dashboard.config.allValues', 'Toutes')}
                onChange={(value) =>
                  patchConfig({
                    scope: {
                      ...settings.scope,
                      statusCategory: (value || undefined) as MetricScope['statusCategory'],
                    },
                  })
                }
              />
            )}
          </Section>
        )}

        {/* ── Interaction ───────────────────────────────────────────────── */}
        {!isText && (
          <Section
            title={t('dashboard.config.interaction', 'Au clic')}
            hint={t(
              'dashboard.config.interactionHint',
              'Sans vue de forage, un clic ouvre la liste des enregistrements calculés par le serveur (les mêmes prédicats que le nombre affiché).',
            )}
          >
            <Select
              label={t('dashboard.config.drillToView', 'Ouvrir dans la file avec la vue')}
              value={settings.drillToView}
              options={[
                { value: '', label: t('dashboard.config.drillToRecords', 'Liste des enregistrements') },
                ...viewOptions,
              ]}
              size="sm"
              onChange={(event) => patchConfig({ drillToView: event.target.value })}
            />
          </Section>
        )}

        {error && (
          <p className="rounded-card bg-sla-breach-bg px-2.5 py-2 text-[11px] leading-relaxed text-sla-breach">
            {error}
          </p>
        )}
      </div>

      {/* ── Actions ──────────────────────────────────────────────────────── */}
      <footer className="flex items-center gap-2 bg-bg-tertiary p-3">
        <Button
          variant="primary"
          size="sm"
          icon={<Save size={14} />}
          disabled={!dirty}
          loading={saving}
          onClick={onSave}
        >
          {t('common.save', 'Enregistrer')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<RotateCcw size={14} />}
          disabled={!dirty || saving}
          onClick={onRevert}
        >
          {t('common.revert', 'Annuler')}
        </Button>
        <Button
          variant="danger"
          size="sm"
          className="ml-auto"
          icon={<Trash2 size={14} />}
          disabled={saving}
          onClick={onDelete}
          title={t('dashboard.grid.remove', 'Retirer cet élément')}
        >
          {t('common.delete', 'Supprimer')}
        </Button>
      </footer>
    </aside>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Pieces
// ═════════════════════════════════════════════════════════════════════════════

function declares(entry: MetricCatalogEntry, dimension: MetricDimension): boolean {
  return (entry.dimensions as string[]).includes(dimension);
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">{title}</h3>
        {hint && <p className="mt-1 text-[11px] leading-relaxed text-text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function ReadOnlyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-text-secondary">{label}</span>
      <div className="flex h-8 items-center rounded-pill bg-bg-tertiary px-3 text-[13px] text-text-muted">
        {value}
      </div>
      {hint && <p className="text-[11px] leading-relaxed text-text-muted">{hint}</p>}
    </div>
  );
}

function ScopeSelect({
  label,
  value,
  options,
  emptyLabel,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  emptyLabel: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      label={label}
      value={value}
      options={[{ value: '', label: emptyLabel }, ...options]}
      size="sm"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** ISO-8601 ⇄ the value an `<input type="datetime-local">` wants. */
function toLocalInput(iso: string): string {
  if (!iso) return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function fromLocalInput(local: string): string {
  if (!local) return '';
  const parsed = new Date(local);
  // `metricQuerySchema` demands `z.string().datetime({ offset: true })`, so an
  // offset-less local string would be rejected. toISOString() always carries Z.
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

export default WidgetConfigPanel;
