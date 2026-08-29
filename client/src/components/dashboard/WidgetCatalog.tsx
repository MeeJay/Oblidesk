/**
 * WidgetCatalog.tsx — "Ajouter un élément".
 *
 * ── The catalogue is derived, not hard-coded ─────────────────────────────────
 * Every visualisation here proposes a STARTING metric, and that metric is
 * chosen out of `GET /api/metrics/catalog` at pick time, never written into a
 * literal. If the registry drops `tickets_by_queue` tomorrow, the bar-chart
 * card falls back to another metric that declares a group-by rather than
 * creating a widget the server refuses to store. The rule that keeps
 * client-supplied SQL off the server — the client may only name things the
 * registry declares — has to hold for defaults too, or the first thing an
 * admin clicks is the exception to it.
 *
 * ── What is offered vs what is rendered ──────────────────────────────────────
 * Ten types are OFFERED here: the ones this build renders properly, with real
 * axes, a real legend and a working drill-through. The server's `WidgetType`
 * union is wider (`heatmap`, `queue_load`, `agent_leaderboard`, `csat`,
 * `time_summary`) and boards may already contain those, so `Widget.tsx` renders
 * every one of them through its nearest sibling renderer. Offering a type here
 * that draws as something else would be the lie; rendering an existing one with
 * the closest honest shape is not.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  BarChart3,
  Bell,
  Gauge as GaugeIcon,
  Hash,
  LineChart as LineChartIcon,
  ListChecks,
  PieChart,
  Type as TypeIcon,
  AreaChart,
  type LucideIcon,
} from 'lucide-react';
import { Modal } from '@/components/common/Modal';
import { cn } from '@/utils/cn';
import type { MetricCatalogEntry, MetricDimension } from '@/api/metrics.api';

// ═════════════════════════════════════════════════════════════════════════════
// The offered visualisations
// ═════════════════════════════════════════════════════════════════════════════

export type OfferedWidgetType =
  | 'kpi'
  | 'sla_gauge'
  | 'bar_chart'
  | 'donut'
  | 'line_chart'
  | 'area_chart'
  | 'ticket_list'
  | 'activity_feed'
  | 'alert_feed'
  | 'text';

export interface WidgetTypeSpec {
  type: OfferedWidgetType;
  labelKey: string;
  label: string;
  descKey: string;
  desc: string;
  icon: LucideIcon;
  group: 'measure' | 'chart' | 'list';
  /** Starting footprint on the 12-column grid. */
  size: { w: number; h: number };
  /** True when the type cannot exist without a published saved view. */
  needsView?: boolean;
}

export const WIDGET_TYPE_SPECS: readonly WidgetTypeSpec[] = [
  {
    type: 'kpi',
    labelKey: 'widgetType.kpi',
    label: 'Indicateur',
    descKey: 'widgetType.kpiDesc',
    desc: 'Un seul nombre, son écart par rapport à hier, et le détail des tickets derrière.',
    icon: Hash,
    group: 'measure',
    size: { w: 3, h: 2 },
  },
  {
    type: 'sla_gauge',
    labelKey: 'widgetType.slaGauge',
    label: 'Jauge',
    descKey: 'widgetType.slaGaugeDesc',
    desc: 'Un pourcentage sur un demi-cercle : respect du SLA, satisfaction, taux de réouverture.',
    icon: GaugeIcon,
    group: 'measure',
    size: { w: 3, h: 3 },
  },
  {
    type: 'bar_chart',
    labelKey: 'widgetType.barChart',
    label: 'Barres',
    descKey: 'widgetType.barChartDesc',
    desc: 'Une répartition classée : par file, par assigné, par organisation.',
    icon: BarChart3,
    group: 'chart',
    size: { w: 4, h: 4 },
  },
  {
    type: 'donut',
    labelKey: 'widgetType.donut',
    label: 'Anneau',
    descKey: 'widgetType.donutDesc',
    desc: 'Une composition : la part de chaque segment dans un total.',
    icon: PieChart,
    group: 'chart',
    size: { w: 4, h: 4 },
  },
  {
    type: 'line_chart',
    labelKey: 'widgetType.lineChart',
    label: 'Courbe',
    descKey: 'widgetType.lineChartDesc',
    desc: 'Une évolution dans le temps, un point par jour, semaine ou mois.',
    icon: LineChartIcon,
    group: 'chart',
    size: { w: 6, h: 4 },
  },
  {
    type: 'area_chart',
    labelKey: 'widgetType.areaChart',
    label: 'Aires',
    descKey: 'widgetType.areaChartDesc',
    desc: 'La même évolution, remplie (pour un volume plutôt qu’un taux).',
    icon: AreaChart,
    group: 'chart',
    size: { w: 6, h: 4 },
  },
  {
    type: 'ticket_list',
    labelKey: 'widgetType.ticketList',
    label: 'Liste de tickets',
    descKey: 'widgetType.ticketListDesc',
    desc: 'Les premières lignes d’une vue enregistrée, cliquables.',
    icon: ListChecks,
    group: 'list',
    size: { w: 6, h: 5 },
    needsView: true,
  },
  {
    type: 'activity_feed',
    labelKey: 'widgetType.activityFeed',
    label: 'Activité récente',
    descKey: 'widgetType.activityFeedDesc',
    desc: 'Les dernières entrées de journal, dans le respect des visibilités.',
    icon: Activity,
    group: 'list',
    size: { w: 4, h: 5 },
  },
  {
    type: 'alert_feed',
    labelKey: 'widgetType.alertFeed',
    label: 'Alertes de la suite',
    descKey: 'widgetType.alertFeedDesc',
    desc: 'Les alertes Obli* encore actives, avec leur application source.',
    icon: Bell,
    group: 'list',
    size: { w: 4, h: 5 },
  },
  {
    type: 'text',
    labelKey: 'widgetType.text',
    label: 'Texte',
    descKey: 'widgetType.textDesc',
    desc: 'Une note pour l’équipe : une consigne de garde, un lien de procédure.',
    icon: TypeIcon,
    group: 'list',
    size: { w: 4, h: 2 },
  },
];

export const WIDGET_TYPE_SPEC_BY_TYPE: Readonly<Record<string, WidgetTypeSpec>> =
  Object.fromEntries(WIDGET_TYPE_SPECS.map((spec) => [spec.type, spec]));

/**
 * The visualisations the config panel offers for an EXISTING widget.
 *
 * A widget of a type outside this list keeps its type — the panel shows it as
 * the current value — so opening the panel on a board's `heatmap` and clicking
 * nothing does not silently rewrite it.
 */
export const SWITCHABLE_TYPES: readonly OfferedWidgetType[] = WIDGET_TYPE_SPECS.map(
  (spec) => spec.type,
);

// ═════════════════════════════════════════════════════════════════════════════
// Defaults, chosen out of the registry
// ═════════════════════════════════════════════════════════════════════════════

/** First of `preferred` that exists and passes `accept`, else any that passes. */
function pickMetric(
  catalog: MetricCatalogEntry[],
  preferred: string[],
  accept: (entry: MetricCatalogEntry) => boolean,
): MetricCatalogEntry | null {
  for (const key of preferred) {
    const found = catalog.find((entry) => entry.key === key);
    if (found && accept(found)) return found;
  }
  return catalog.find(accept) ?? catalog[0] ?? null;
}

const hasGroupBy = (entry: MetricCatalogEntry): boolean =>
  entry.forcedGroupBy !== null || entry.dimensions.length > 0;

const isPercent = (entry: MetricCatalogEntry): boolean => entry.unit === 'percent';

/** A window this metric actually offers — never a range it would reject. */
function firstOffered(entry: MetricCatalogEntry, preferred: string[]): string | undefined {
  for (const range of preferred) {
    if ((entry.ranges as string[]).includes(range)) return range;
  }
  return entry.ranges[0];
}

export interface WidgetDraft {
  widgetType: OfferedWidgetType;
  title: string | null;
  config: Record<string, unknown>;
  w: number;
  h: number;
}

/**
 * Build the widget a pick should create.
 *
 * Everything it puts in `config` is a value the registry declared for the
 * metric it chose, so `assertWidgetConfig` on the server accepts it by
 * construction rather than by luck.
 */
export function draftForType(
  spec: WidgetTypeSpec,
  catalog: MetricCatalogEntry[],
  options: { firstViewSlug?: string | null } = {},
): WidgetDraft {
  const base = { widgetType: spec.type, title: null as string | null, w: spec.size.w, h: spec.size.h };

  switch (spec.type) {
    case 'kpi': {
      const metric = pickMetric(catalog, ['open_tickets', 'created'], () => true);
      return { ...base, config: metric ? { metric: metric.key } : {} };
    }

    case 'sla_gauge': {
      const metric = pickMetric(catalog, ['sla_attainment', 'reopen_rate'], isPercent);
      return {
        ...base,
        config: metric
          ? { metric: metric.key, window: firstOffered(metric, ['last_30_days', 'this_month']), target: 95 }
          : {},
      };
    }

    case 'bar_chart': {
      const metric = pickMetric(catalog, ['tickets_by_queue', 'tickets_by_assignee'], hasGroupBy);
      return { ...base, config: metric ? withGroupBy(metric) : {} };
    }

    case 'donut': {
      const metric = pickMetric(catalog, ['tickets_by_priority', 'tickets_by_category'], hasGroupBy);
      return { ...base, config: metric ? withGroupBy(metric) : {} };
    }

    case 'line_chart':
    case 'area_chart': {
      const metric = pickMetric(catalog, ['created', 'resolved', 'open_tickets'], () => true);
      return {
        ...base,
        config: metric
          ? {
              metric: metric.key,
              window: firstOffered(metric, ['last_30_days', 'last_7_days']),
              interval: 'day',
            }
          : {},
      };
    }

    case 'ticket_list':
      // `planWidget` REFUSES a ticket list without a view, so the catalogue
      // disables the card rather than creating something that cannot resolve.
      return { ...base, config: { view: options.firstViewSlug ?? '', limit: 10 } };

    case 'activity_feed':
      return { ...base, config: { limit: 20 } };

    case 'alert_feed':
      return { ...base, config: { limit: 15 } };

    case 'text':
    default:
      return { ...base, config: { text: '' } };
  }
}

function withGroupBy(metric: MetricCatalogEntry): Record<string, unknown> {
  const dimension: MetricDimension | undefined = metric.forcedGroupBy ?? metric.dimensions[0];
  const config: Record<string, unknown> = { metric: metric.key };
  // A forced axis is already pinned server-side; writing it again would just
  // earn a "the requested grouping was ignored" warning on every resolve.
  if (dimension && metric.forcedGroupBy === null) config.group_by = dimension;
  return config;
}

// ═════════════════════════════════════════════════════════════════════════════
// The picker
// ═════════════════════════════════════════════════════════════════════════════

interface WidgetCatalogProps {
  open: boolean;
  onClose: () => void;
  catalog: MetricCatalogEntry[];
  /** Published saved views — `ticket_list` cannot exist without one. */
  views: Array<{ slug: string; name: string }>;
  onPick: (draft: WidgetDraft) => void;
  /** True while the create request is in flight. */
  busy?: boolean;
}

const GROUP_ORDER: Array<{ group: WidgetTypeSpec['group']; key: string; label: string }> = [
  { group: 'measure', key: 'dashboard.catalog.groupMeasure', label: 'Mesures' },
  { group: 'chart', key: 'dashboard.catalog.groupChart', label: 'Graphiques' },
  { group: 'list', key: 'dashboard.catalog.groupList', label: 'Listes et notes' },
];

export function WidgetCatalog({ open, onClose, catalog, views, onPick, busy = false }: WidgetCatalogProps) {
  const { t } = useTranslation();

  const grouped = useMemo(
    () =>
      GROUP_ORDER.map((group) => ({
        ...group,
        specs: WIDGET_TYPE_SPECS.filter((spec) => spec.group === group.group),
      })),
    [],
  );

  const firstViewSlug = views.length > 0 ? views[0].slug : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={t('dashboard.catalog.title', 'Ajouter un élément')}
      subtitle={t(
        'dashboard.catalog.subtitle',
        'Chaque élément se branche sur une mesure du registre. Vous affinerez la mesure, l’axe et la période juste après.',
      )}
      closeLabel={t('common.close', 'Fermer')}
    >
      <div className="space-y-5">
        {grouped.map((group) => (
          <section key={group.group} className="space-y-2">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">
              {t(group.key, group.label)}
            </h3>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {group.specs.map((spec) => {
                const blocked = spec.needsView === true && firstViewSlug === null;
                const Icon = spec.icon;

                return (
                  <button
                    key={spec.type}
                    type="button"
                    disabled={blocked || busy}
                    onClick={() => onPick(draftForType(spec, catalog, { firstViewSlug }))}
                    title={
                      blocked
                        ? t(
                            'dashboard.catalog.needsView',
                            'Cet élément a besoin d’une vue enregistrée. Créez-en une depuis la file de tickets.',
                          )
                        : t(spec.descKey, spec.desc)
                    }
                    className={cn(
                      // HARD RULE 11 — no border. The card is a raised surface.
                      'flex h-full flex-col gap-1.5 rounded-card bg-bg-tertiary p-3 text-left transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                      blocked || busy
                        ? 'cursor-not-allowed opacity-45'
                        : 'hover:bg-bg-hover hover:shadow-card',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-bg-secondary text-accent">
                        <Icon size={15} />
                      </span>
                      <span className="min-w-0 truncate text-[13px] font-semibold text-text-primary">
                        {t(spec.labelKey, spec.label)}
                      </span>
                    </span>
                    <span className="text-[11px] leading-relaxed text-text-muted">
                      {blocked
                        ? t(
                            'dashboard.catalog.needsView',
                            'Cet élément a besoin d’une vue enregistrée. Créez-en une depuis la file de tickets.',
                          )
                        : t(spec.descKey, spec.desc)}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}

export default WidgetCatalog;
