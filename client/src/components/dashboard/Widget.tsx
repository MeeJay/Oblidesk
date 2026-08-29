/**
 * Widget.tsx — one card on the board: its chrome, its states, and its drill.
 *
 * ── One failing widget must not blank the page ───────────────────────────────
 * `resolveWidget` on the server never throws: it returns an `error` string per
 * widget so a board of twelve survives one broken config. This component is the
 * other half of that contract. Every widget renders exactly one of four things
 * — loading, error, empty, or data — and each is a card the same size as the
 * others, so a failure changes what a widget SAYS and never what the board
 * LOOKS like.
 *
 * An empty chart is not an acceptable error state, and it is not an acceptable
 * empty state either: it is indistinguishable from a quiet week, and that
 * ambiguity is what gets a dashboard quietly ignored for six months. "Empty"
 * says the calculation ran and found nothing; "error" says what is wrong with
 * THIS widget, in the server's own words; a snapshot metric with no rollup rows
 * yet says that, by name, instead of drawing a flat line at zero.
 *
 * ── Every number here can be clicked ─────────────────────────────────────────
 * `onDrill` is required. A KPI an operator has to take on faith is a KPI nobody
 * fixes, so a value that cannot reach the records behind it is not displayed.
 * The drill descriptor comes from the SERVER (`MetricResolution.drill`), never
 * from a client-side reconstruction of the query, which is why the list can
 * never disagree with the number it was reached from.
 *
 * ── Editing suspends the drill, not the rendering ────────────────────────────
 * While the board is in edit mode the card still draws its real data — that is
 * the live preview — but a click selects the widget instead of opening a ticket
 * list. Two different things on one click is how people lose work.
 */

import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertTriangle,
  Bell,
  ExternalLink,
  Inbox,
  Info,
  Loader2,
} from 'lucide-react';
import { STATUS_CATEGORY_META, isStatusCategory } from '@oblidesk/shared';
import { Gauge } from '@/components/common/Gauge';
import PriorityBadge from '@/components/tickets/PriorityBadge';
import StatusPill from '@/components/tickets/StatusPill';
import { cn } from '@/utils/cn';
import { formatNumber, formatRelative, ticketNumber, truncate } from '@/utils/format';
import {
  METRIC_DIMENSION_LABELS,
  METRIC_RANGE_LABELS,
  type DashboardTicketRow,
  type DashboardWidgetRecord,
  type MetricDelta,
  type MetricDimension,
  type MetricResolution,
  type MetricUnit,
  type ResolvedWidget,
} from '@/api/metrics.api';
import { BarChart, sortChartData, type ChartDatum, type ChartSort } from './charts/BarChart';
import { LineChart, toSeriesRows } from './charts/LineChart';
import { DonutChart } from './charts/DonutChart';
import { DeltaArrow, StatTile, useMetricFormatter, type DeltaCompare } from './charts/StatTile';

// ═════════════════════════════════════════════════════════════════════════════
// The drill request this card emits
// ═════════════════════════════════════════════════════════════════════════════

export interface DrillRequest {
  /** Card title, for the drawer header. */
  title: string;
  /** The segment that was clicked, already translated. Null = the whole card. */
  segmentLabel: string | null;
  /**
   * The SERVER's drill descriptor. Null for a card with no records path — a
   * text note, a feed.
   */
  drill: MetricResolution['drill'] | null;
  /** The raw group value. `undefined` means "the whole metric". */
  group?: string;
  /**
   * A saved-view slug to open in the ticket queue instead of the drawer.
   * `/tickets?view=…` is the honest target only when the widget IS a saved
   * view: the queue cannot express "median first response, 30 days, priority
   * p1", so pretending it can would put a list under a number that disagrees
   * with it.
   */
  viewSlug: string | null;
  /**
   * Set when the clicked segment is the NULL group (unassigned, no resolution
   * code). `metricRecordsQuerySchema` reads `group` off the query string, where
   * a real null cannot arrive, so `withGroupValue`'s `IS NULL` branch is
   * unreachable over HTTP. The drawer says the list covers the whole metric
   * rather than silently presenting it as that one segment.
   */
  unnarrowable: boolean;
}

export type GroupLabelResolver = (dimension: MetricDimension, raw: string) => string | null;

/** Dimensions whose values are numeric ids we have no name for on this screen. */
const ID_DIMENSIONS = new Set<MetricDimension>([
  'assignee_id',
  'assignment_group_id',
  'organization_id',
  'user_id',
]);

// ═════════════════════════════════════════════════════════════════════════════
// Card
// ═════════════════════════════════════════════════════════════════════════════

export interface WidgetProps {
  /** Position / type / title / config — with the edit draft already applied. */
  widget: DashboardWidgetRecord;
  /** Server-resolved data. Null while the board is still loading. */
  resolved: ResolvedWidget | null;
  /**
   * Live preview while the config panel is open on THIS widget: the metric
   * re-resolved from the unsaved draft. Wins over `resolved`.
   */
  preview?: { metric: MetricResolution | null; loading: boolean; error: string | null } | null;
  /** Replaces the board's delta when the header switches to "vs last week". */
  deltaOverride?: MetricDelta | null;
  compareTo?: DeltaCompare;
  /** Accent gradient + glow — the one XL tile of a hero row (design §14.1). */
  featured?: boolean;
  /** Edit mode: the card is a selection target, not a drill target. */
  editing?: boolean;
  onDrill: (request: DrillRequest) => void;
  onOpenTicket?: (ticketId: number) => void;
  /** Names for slug-shaped group values the page happens to know. */
  resolveGroupLabel?: GroupLabelResolver;
  className?: string;
}

export function Widget({
  widget,
  resolved,
  preview,
  deltaOverride,
  compareTo = 'yesterday',
  featured = false,
  editing = false,
  onDrill,
  onOpenTicket,
  resolveGroupLabel,
  className,
}: WidgetProps) {
  const { t } = useTranslation();

  const metric = preview ? preview.metric : (resolved?.metric ?? null);
  const unit: MetricUnit = metric?.unit ?? 'count';
  const format = useMetricFormatter(unit);

  // ── group value → readable label ────────────────────────────────────────
  const groupBy = metric?.groupBy ?? null;
  const labelFor = useMemo(() => {
    return (raw: string | null): string => {
      if (raw === null) {
        if (groupBy === 'assignee_id' || groupBy === 'assignment_group_id') {
          return t('dashboard.group.unassigned', 'Non assigné');
        }
        if (groupBy === 'resolution_code') return t('dashboard.group.noCode', 'Sans code');
        return t('dashboard.group.none', 'Non renseigné');
      }
      if (!groupBy) return raw;

      const supplied = resolveGroupLabel?.(groupBy, raw);
      if (supplied) return supplied;

      if (groupBy === 'status_category' && isStatusCategory(raw)) {
        const meta = STATUS_CATEGORY_META[raw];
        return t(meta.labelKey, meta.label);
      }
      if (groupBy === 'record_type') return t(`ticket.recordType.${raw}`, raw);
      if (groupBy === 'source') return t(`ticket.source.${raw}`, raw);
      // A bare integer is not a name. Make it obviously an id rather than let
      // "412" sit under a bar as though it were a queue called 412.
      if (ID_DIMENSIONS.has(groupBy)) return `#${raw}`;
      return raw;
    };
  }, [groupBy, resolveGroupLabel, t]);

  // ── subtitle: what this number actually covers ──────────────────────────
  const subtitle = useMemo(() => {
    if (!metric) return null;
    const parts: string[] = [];
    const range = METRIC_RANGE_LABELS[metric.range];
    if (range && metric.range !== 'all_time') parts.push(t(range.key, range.fallback));
    if (metric.groupBy) {
      const dimension = METRIC_DIMENSION_LABELS[metric.groupBy];
      parts.push(
        t('dashboard.byDimension', 'par {{axis}}', {
          axis: t(dimension.key, dimension.fallback).toLowerCase(),
        }),
      );
    }
    const viewName = resolved?.view?.name ?? resolved?.view?.slug ?? null;
    if (viewName) parts.push(viewName);
    return parts.length > 0 ? parts.join(' · ') : null;
  }, [metric, resolved, t]);

  // A re-resolving preview keeps the LAST value on screen. Blanking the card
  // on every keystroke makes the editor feel broken and hides the very
  // comparison the user is making between two settings.
  const loading = preview ? preview.loading && preview.metric === null : resolved === null;
  const error = preview ? preview.error : (resolved?.error ?? null);
  const warnings = (preview ? [] : (resolved?.warnings ?? [])).filter(Boolean);

  const kind = resolved?.kind ?? 'metric';
  const type = widget.widgetType;
  const target = resolved?.target ?? null;

  const title =
    widget.title?.trim() ||
    (metric ? t(metric.labelKey, metric.label) : t('dashboard.widget.untitled', 'Élément'));

  const emitDrill = (group: string | null | undefined, segmentLabel: string | null): void => {
    if (editing) return;
    onDrill({
      title,
      segmentLabel,
      drill: metric?.drill ?? null,
      group: group ?? undefined,
      viewSlug: resolved?.drillToView ?? (kind === 'tickets' ? (resolved?.view?.slug ?? null) : null),
      unnarrowable: group === null,
    });
  };

  const drillLabel = editing
    ? t('dashboard.selectWidget', 'Sélectionner cet élément')
    : t('dashboard.drillHint', 'Cliquer pour voir les tickets');

  // ═══════════════════════════════════════════════════════════════════════
  // States
  // ═══════════════════════════════════════════════════════════════════════

  if (loading) {
    return (
      <Frame title={title} subtitle={subtitle} editing={editing} className={className}>
        <div className="flex h-full items-center justify-center gap-2 text-text-muted">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-[12px]">{t('common.loading', 'Chargement…')}</span>
        </div>
      </Frame>
    );
  }

  if (error) {
    return (
      <Frame title={title} subtitle={null} tone="error" editing={editing} className={className}>
        <div className="flex h-full flex-col justify-center gap-1.5 text-left">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-sla-breach">
            <AlertTriangle size={13} className="shrink-0" />
            {t('dashboard.widgetError', 'Cet élément n’a pas pu être calculé.')}
          </p>
          {/* The server's own message, verbatim. It names the metric, the
              dimension or the range that is wrong, which is the only thing that
              turns a broken widget into a two-second fix. */}
          <p className="overflow-y-auto text-[11px] leading-relaxed text-text-muted">{error}</p>
        </div>
      </Frame>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Non-metric bodies
  // ═══════════════════════════════════════════════════════════════════════

  if (type === 'text' || kind === 'text') {
    const text = typeof widget.config.text === 'string' ? widget.config.text : '';
    return (
      <Frame title={title} subtitle={null} editing={editing} className={className}>
        {text.trim() === '' ? (
          <Blank
            title={t('dashboard.text.empty', 'Note vide')}
            detail={t(
              'dashboard.text.emptyDetail',
              'Ouvrez la configuration pour écrire quelque chose.',
            )}
          />
        ) : (
          <div className="h-full overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary">
            {text}
          </div>
        )}
      </Frame>
    );
  }

  if (kind === 'tickets') {
    const rows = resolved?.tickets ?? [];
    return (
      <Frame
        title={title}
        subtitle={resolved?.view?.name ?? null}
        warnings={warnings}
        editing={editing}
        action={
          resolved?.view?.slug ? (
            <IconAction
              label={t('dashboard.openInQueue', 'Ouvrir dans la file')}
              icon={<ExternalLink size={11} />}
              onClick={() => emitDrill(undefined, null)}
              disabled={editing}
            />
          ) : null
        }
        className={className}
      >
        {rows.length === 0 ? (
          <Blank
            icon={<Inbox size={18} />}
            title={t('dashboard.tickets.empty', 'Aucun ticket dans cette vue.')}
            detail={t(
              'dashboard.tickets.emptyDetail',
              'La vue a bien été évaluée — elle ne renvoie rien.',
            )}
          />
        ) : (
          <ul className="h-full space-y-0.5 overflow-y-auto pr-0.5">
            {rows.map((row) => (
              <TicketLine
                key={row.id}
                row={row}
                disabled={editing}
                onOpen={() => onOpenTicket?.(row.id)}
              />
            ))}
          </ul>
        )}
      </Frame>
    );
  }

  if (kind === 'activity') {
    const rows = resolved?.activity ?? [];
    return (
      <Frame title={title} subtitle={null} warnings={warnings} editing={editing} className={className}>
        {rows.length === 0 ? (
          <Blank
            icon={<Activity size={18} />}
            title={t('dashboard.activity.empty', 'Aucune activité récente.')}
          />
        ) : (
          <ul className="h-full space-y-1 overflow-y-auto pr-0.5">
            {rows.map((entry, index) => {
              const ticketId = Number(entry.ticket_id);
              const created = typeof entry.created_at === 'string' ? entry.created_at : null;
              return (
                <li key={String(entry.id ?? index)}>
                  <button
                    type="button"
                    disabled={editing || !Number.isInteger(ticketId)}
                    onClick={() => onOpenTicket?.(ticketId)}
                    className={cn(
                      'flex w-full items-baseline gap-2 rounded-pill px-1.5 py-1 text-left transition-colors',
                      !editing && 'hover:bg-bg-hover',
                    )}
                  >
                    <span className="shrink-0 font-mono text-[11px] text-accent">
                      {ticketNumber(typeof entry.number === 'string' ? entry.number : null)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">
                      {typeof entry.subject === 'string' ? entry.subject : ''}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-text-muted">
                      {formatRelative(created)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Frame>
    );
  }

  if (kind === 'alerts') {
    const rows = resolved?.alerts ?? [];
    return (
      <Frame title={title} subtitle={null} warnings={warnings} editing={editing} className={className}>
        {rows.length === 0 ? (
          <Blank
            icon={<Bell size={18} />}
            title={t('dashboard.alerts.empty', 'Aucune alerte active.')}
            detail={t(
              'dashboard.alerts.emptyDetail',
              'Aucune alerte Obli* non acquittée pour ce tenant en ce moment.',
            )}
          />
        ) : (
          <ul className="h-full space-y-1 overflow-y-auto pr-0.5">
            {rows.map((alert, index) => (
              <li
                key={String(alert.id ?? index)}
                className="flex items-center gap-2 rounded-pill bg-bg-tertiary px-2 py-1.5"
              >
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted">
                  {String(alert.source_app ?? '—')}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">
                  {String(alert.title ?? '')}
                </span>
                {Number(alert.occurrence_count) > 1 && (
                  <span className="shrink-0 font-mono text-[10px] text-text-muted">
                    ×{formatNumber(Number(alert.occurrence_count))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Frame>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Metric bodies
  // ═══════════════════════════════════════════════════════════════════════

  if (!metric) {
    return (
      <Frame title={title} subtitle={null} editing={editing} className={className}>
        <Blank title={t('dashboard.noData', 'Aucune donnée sur cette période.')} />
      </Frame>
    );
  }

  /**
   * True when this metric's history is the nightly rollup's rather than a live
   * timestamp. The resolution does not carry `seriesSource`, so the tell is the
   * warning the server attaches when the rollup table has nothing yet — which
   * is exactly the case the UI has to be honest about.
   */
  const fromRollup = metric.warnings.some((warning) => warning.toLowerCase().includes('rollup'));

  const seriesPoints = metric.points.filter((point) => point.bucket !== null);
  // A NULL group is a real group — "unassigned" is usually the bar that
  // matters — so it is NOT filtered out here.
  const grouped = metric.groupBy ? metric.points.filter((point) => point.bucket === null) : [];

  const emptyDetail =
    metric.warnings.length > 0
      ? metric.warnings[0]
      : t(
          'dashboard.chart.emptyDetail',
          'Le calcul a abouti, il n’a simplement rien trouvé à compter.',
        );

  const delta = deltaOverride ?? resolved?.delta ?? null;

  /** Display order only — see `sortChartData`. Never reaches a query. */
  const sort = (typeof widget.config.sort === 'string' ? widget.config.sort : 'value_desc') as ChartSort;

  const groupedData: ChartDatum[] = sortChartData(
    grouped.map((point) => ({
      label: labelFor(point.group),
      value: point.value ?? 0,
      raw: point.group,
    })),
    sort,
  );

  // ── KPI tile ─────────────────────────────────────────────────────────────
  if (type === 'kpi' || type === 'stat' || type === 'number' || type === 'csat' || type === 'time_summary') {
    const spark = seriesPoints
      .map((point) => point.value)
      .filter((value): value is number => value !== null);

    return (
      <StatTile
        label={title}
        value={metric.total}
        format={format}
        delta={delta}
        compareTo={compareTo}
        fromRollup={fromRollup}
        tone={toneFor(resolved, metric.total)}
        series={spark.length >= 2 ? spark : undefined}
        featured={featured}
        caption={subtitle ?? undefined}
        onDrill={() => emitDrill(undefined, null)}
        drillLabel={drillLabel}
        // Editing overlays a drag handle and a delete button on the top
        // corners; the tile's label has to step out of their way.
        className={cn(className, editing && 'pt-9')}
      />
    );
  }

  // ── gauge ────────────────────────────────────────────────────────────────
  if (type === 'sla_gauge') {
    return (
      <Frame title={title} subtitle={subtitle} warnings={warnings} editing={editing} className={className}>
        <button
          type="button"
          disabled={editing}
          onClick={() => emitDrill(undefined, null)}
          title={drillLabel}
          className={cn(
            'flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-card transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
            !editing && 'hover:bg-bg-hover',
          )}
        >
          <Gauge
            value={metric.total}
            lowerIsBetter={metric.higherIsBetter === false}
            label={
              target !== null
                ? t('dashboard.targetLabel', 'cible {{target}}', { target: format(target) })
                : undefined
            }
          />
          {/* Only KPI widgets are resolved with a delta server-side, so a
              gauge shows the arrow when there is one and stays quiet
              otherwise — rather than claiming it has no history. */}
          {delta && (
            <DeltaArrow delta={delta} compareTo={compareTo} format={format} fromRollup={fromRollup} />
          )}
        </button>
      </Frame>
    );
  }

  // ── donut ────────────────────────────────────────────────────────────────
  if (type === 'donut' || type === 'pie') {
    return (
      <Frame title={title} subtitle={subtitle} warnings={warnings} editing={editing} className={className}>
        {groupedData.length === 0 ? (
          <Blank title={t('dashboard.noData', 'Aucune donnée sur cette période.')} detail={emptyDetail} />
        ) : (
          <DonutChart
            data={groupedData}
            format={format}
            totalLabel={t('dashboard.total', 'total')}
            showLegend={widget.w >= 4}
            onSelect={editing ? undefined : (datum) => emitDrill(datum.raw, datum.label)}
          />
        )}
      </Frame>
    );
  }

  // ── time series ──────────────────────────────────────────────────────────
  if (
    type === 'line_chart' ||
    type === 'line' ||
    type === 'area_chart' ||
    type === 'area' ||
    type === 'heatmap'
  ) {
    const { rows, series, dropped } = toSeriesRows(seriesPoints, {
      labelFor,
      bucketLabel,
      ungroupedLabel: t(metric.labelKey, metric.label),
      maxSeries: 6,
    });

    const isArea = type === 'area_chart' || type === 'area';
    const seriesWarnings =
      dropped > 0
        ? [
            ...warnings,
            t('dashboard.seriesCapped', '{{count}} série(s) supplémentaires ne sont pas tracées.', {
              count: dropped,
            }),
          ]
        : warnings;

    return (
      <Frame title={title} subtitle={subtitle} warnings={seriesWarnings} editing={editing} className={className}>
        <LineChart
          rows={rows}
          series={series}
          format={format}
          area={isArea}
          target={target}
          onSelect={
            editing
              ? undefined
              : (entry) =>
                  emitDrill(
                    // An ungrouped series has one line whose `raw` is null for
                    // "no grouping", not for "the null group" — those must not
                    // be confused, or the drawer would claim it cannot narrow
                    // a chart that was never narrowed in the first place.
                    entry && metric.groupBy ? entry.raw : undefined,
                    entry?.label ?? null,
                  )
          }
          emptyTitle={
            rows.length === 0 && fromRollup
              ? t('dashboard.noHistoryYet', 'Pas encore d’historique.')
              : undefined
          }
          emptyDetail={emptyDetail}
        />
      </Frame>
    );
  }

  // ── bars: the default for anything grouped ───────────────────────────────
  return (
    <Frame title={title} subtitle={subtitle} warnings={warnings} editing={editing} className={className}>
      {groupedData.length === 0 ? (
        <Blank title={t('dashboard.noData', 'Aucune donnée sur cette période.')} detail={emptyDetail} />
      ) : (
        <BarChart
          data={groupedData}
          format={format}
          target={target}
          onSelect={editing ? undefined : (datum) => emitDrill(datum.raw, datum.label)}
        />
      )}
    </Frame>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Pieces
// ═════════════════════════════════════════════════════════════════════════════

/** 'YYYY-MM-DD' → '14 mars'. Short: an axis has no room for a year. */
function bucketLabel(bucket: string): string {
  const parsed = new Date(`${bucket}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return bucket;
  try {
    const locale =
      (typeof document !== 'undefined' && document.documentElement.getAttribute('lang')) || 'fr';
    return new Intl.DateTimeFormat(locale, {
      day: '2-digit',
      month: 'short',
      // The bucket is a LOCAL calendar day the server already computed in the
      // tenant's timezone. Re-interpreting it in the browser's zone would shift
      // half the labels by a day for anyone east of the tenant.
      timeZone: 'UTC',
    }).format(parsed);
  } catch {
    return bucket;
  }
}

/** `tone_when_above` from the widget config: paint the number when it crosses. */
function toneFor(
  resolved: ResolvedWidget | null,
  value: number | null,
): 'default' | 'warn' | 'danger' {
  const rule = resolved?.toneWhenAbove;
  if (!rule || value === null || value <= rule.value) return 'default';
  return rule.tone === 'danger' || rule.tone === 'breach' ? 'danger' : 'warn';
}

interface FrameProps {
  title: string;
  subtitle: string | null;
  warnings?: string[];
  tone?: 'default' | 'error';
  /** Reserves the corners the grid's drag / delete handles sit over. */
  editing?: boolean;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * The card. HARD RULE 11 — `bg-bg-secondary` + `shadow-card`, no border.
 *
 * `min-h-0` on the body is what lets a chart fill the remaining height inside a
 * flex column instead of overflowing its grid cell; without it recharts'
 * ResponsiveContainer measures the CONTENT and grows without bound.
 */
function Frame({
  title,
  subtitle,
  warnings = [],
  tone = 'default',
  editing = false,
  action,
  children,
  className,
}: FrameProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        'flex h-full min-h-0 w-full flex-col gap-2 rounded-card bg-bg-secondary p-3 shadow-card',
        tone === 'error' && 'bg-sla-breach-bg',
        className,
      )}
    >
      <header
        className={cn(
          'flex min-h-[20px] items-start justify-between gap-2',
          editing && 'pl-7 pr-14',
        )}
      >
        <div className="min-w-0">
          <h3
            className="truncate text-[13px] font-semibold leading-tight text-text-primary"
            title={title}
          >
            {title}
          </h3>
          {subtitle && (
            <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted">
              {subtitle}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {warnings.length > 0 && (
            <span
              className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-sla-warn-bg text-sla-warn"
              title={warnings.join('\n')}
              aria-label={t('dashboard.warnings', 'Avertissements sur ce calcul')}
            >
              <Info size={11} />
            </span>
          )}
          {action}
        </div>
      </header>

      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function Blank({ title, detail, icon }: { title: string; detail?: string; icon?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-3 text-center">
      {icon && <div className="text-text-muted opacity-60">{icon}</div>}
      <p className="text-[12px] font-medium text-text-secondary">{title}</p>
      {detail && <p className="max-w-[260px] text-[11px] leading-relaxed text-text-muted">{detail}</p>}
    </div>
  );
}

function IconAction({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded-[6px] text-text-muted transition-colors',
        'hover:bg-bg-hover hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {icon}
    </button>
  );
}

/**
 * One drill / view row.
 *
 * NOTE the snake_case: the reporting endpoints select raw columns and knex has
 * no `postProcessResponse`, so `status_slug` is `status_slug` here. Reading
 * `row.statusSlug` would compile and render nothing.
 */
function TicketLine({
  row,
  disabled,
  onOpen,
}: {
  row: DashboardTicketRow;
  disabled?: boolean;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onOpen}
        className={cn(
          'flex w-full items-center gap-2 rounded-pill px-1.5 py-1 text-left transition-colors',
          !disabled && 'hover:bg-bg-hover',
        )}
      >
        <span className="shrink-0 font-mono text-[11px] text-accent">{ticketNumber(row.number)}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">
          {truncate(row.subject, 80)}
        </span>
        <PriorityBadge prioritySlug={row.priority_slug} size="sm" className="shrink-0" />
        <StatusPill
          statusSlug={row.status_slug}
          category={row.status_category}
          size="sm"
          className="shrink-0"
        />
      </button>
    </li>
  );
}

export { TicketLine };
export default Widget;
