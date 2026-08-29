/**
 * dashboard.routes.ts — `/api/dashboards`.
 *
 * Boards, widgets, layout, and the resolved data behind them.
 *
 * Two things worth noticing in the route table below:
 *
 *  • `/widgets/:id` is declared BEFORE `/:slug`. Express matches in order, so
 *    the other way round would make every widget request resolve as a
 *    dashboard called "widgets".
 *
 *  • `/:slug/resolve` returns every widget already resolved, in one call.
 *    A board that fetches its twelve widgets separately opens twelve
 *    connections against a pool of ten and is slower for it, not faster.
 *
 * MOUNTING: expects the app's auth middleware in front; `resolveActor` fails
 * closed with 401 if it is not there.
 */

import { Router, type Request, type Response } from 'express';

import { CAPABILITIES } from '@oblidesk/shared';

import {
  createDashboard,
  createWidget,
  defaultDashboard,
  deleteDashboard,
  deleteWidget,
  getDashboard,
  listDashboards,
  materializeFromConfig,
  resolveDashboard,
  saveLayout,
  updateDashboard,
  updateWidget,
  widgetRecords,
} from '../services/dashboard.service';
import {
  createDashboardSchema,
  handleServiceError,
  idParamSchema,
  layoutSchema,
  materializeSchema,
  requireCapability,
  resolveActor,
  sendFail,
  sendOk,
  slugParamSchema,
  updateDashboardSchema,
  updateWidgetSchema,
  widgetSchema,
} from '../validators/config.validators';

const router = Router();

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((error: unknown) => handleServiceError(res, error));
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Boards
// ═════════════════════════════════════════════════════════════════════════════

router.get('/', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  sendOk(res, await listDashboards(actor));
}));

/** The board a user lands on. */
router.get('/default', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const dashboard = await defaultDashboard(actor);
  if (!dashboard) {
    sendFail(res, 404, 'This tenant has no dashboards yet.', { code: 'not_found' });
    return;
  }
  sendOk(res, dashboard);
}));

router.post('/', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_ADMIN);

  const input = createDashboardSchema.parse(req.body);
  sendOk(res, await createDashboard(actor, input), 201);
}));

/**
 * Instantiate a shipped `config_objects` dashboard into the live tables.
 * Explicit rather than automatic: it replaces the widgets of the board it
 * creates, and an admin who has rearranged theirs should clone first.
 */
router.post('/materialize', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_ADMIN);

  const input = materializeSchema.parse(req.body);
  sendOk(res, await materializeFromConfig(actor, input.configSlug), 201);
}));

// ═════════════════════════════════════════════════════════════════════════════
// Widgets — declared before /:slug so "widgets" is never read as a board slug
// ═════════════════════════════════════════════════════════════════════════════

router.patch('/widgets/:id', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_ADMIN);

  const id = idParamSchema.parse(req.params.id);
  const input = updateWidgetSchema.parse(req.body);
  sendOk(res, await updateWidget(actor, id, input));
}));

router.delete('/widgets/:id', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_ADMIN);

  const id = idParamSchema.parse(req.params.id);
  await deleteWidget(actor, id);
  sendOk(res, { deleted: true });
}));

/**
 * The drill-through: the tickets behind a widget's number, built from the same
 * predicates as the number itself. `group` narrows it to the one bar that was
 * clicked.
 */
router.get('/widgets/:id/records', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const id = idParamSchema.parse(req.params.id);

  const group = typeof req.query.group === 'string' ? req.query.group : undefined;
  const page = req.query.page === undefined ? undefined : Number(req.query.page);
  const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);

  const records = await widgetRecords(actor, id, { group, page, limit });
  res.status(200).json({
    success: true,
    data: records.rows,
    page: records.page,
    limit: records.limit,
    total: records.rows.length,
    warnings: records.warnings,
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// One board
// ═════════════════════════════════════════════════════════════════════════════

router.get('/:slug', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const slug = slugParamSchema.parse(req.params.slug);

  const dashboard = await getDashboard(actor, slug);
  if (!dashboard) {
    sendFail(res, 404, `No dashboard with the slug "${slug}".`, { code: 'not_found' });
    return;
  }
  sendOk(res, dashboard);
}));

/**
 * The board plus its data. A widget that cannot resolve comes back with an
 * `error` string instead of taking the other eleven down with it — an empty
 * chart is indistinguishable from a quiet week, and that is the failure that
 * gets a dashboard quietly ignored.
 */
router.get('/:slug/resolve', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const slug = slugParamSchema.parse(req.params.slug);
  sendOk(res, await resolveDashboard(actor, slug));
}));

router.patch('/:slug', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_ADMIN);

  const slug = slugParamSchema.parse(req.params.slug);
  const input = updateDashboardSchema.parse(req.body);
  sendOk(res, await updateDashboard(actor, slug, input));
}));

router.delete('/:slug', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_ADMIN);

  const slug = slugParamSchema.parse(req.params.slug);
  await deleteDashboard(actor, slug);
  sendOk(res, { deleted: true });
}));

router.post('/:slug/widgets', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_ADMIN);

  const slug = slugParamSchema.parse(req.params.slug);
  const input = widgetSchema.parse(req.body);
  sendOk(res, await createWidget(actor, slug, input), 201);
}));

/**
 * Bulk layout save — one round trip for a whole drag session. Positions only:
 * a layout save must never be able to change what a widget queries.
 */
router.post('/:slug/layout', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.REPORT_ADMIN);

  const slug = slugParamSchema.parse(req.params.slug);
  const input = layoutSchema.parse(req.body);
  sendOk(res, await saveLayout(actor, slug, input.positions));
}));

export { router as dashboardRouter };
export default router;
