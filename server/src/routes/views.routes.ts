/**
 * views.routes.ts — `/api/views`.
 *
 * Saved views: the sidebar list, one view's definition, its page of tickets,
 * its count badge, and its group counts for a board.
 *
 * The count endpoints are the hot ones — they are what a socket tick and a
 * sidebar repaint both land on — so they are deliberately separate from the
 * ticket page. Fetching 50 rows to learn a number is the mistake this split
 * exists to prevent.
 *
 * MOUNTING: expects to sit behind the app's auth middleware; `resolveActor`
 * fails closed with 401 if it does not.
 */

import { Router, type Request, type Response } from 'express';

import { CAPABILITIES } from '@oblidesk/shared';

import {
  archiveView,
  countAllViews,
  countView,
  countViewByGroup,
  createView,
  getView,
  listViewTickets,
  listViews,
  updateView,
} from '../services/view.service';
import {
  handleServiceError,
  requireCapability,
  resolveActor,
  saveViewSchema,
  sendFail,
  sendOk,
  slugParamSchema,
  updateViewSchema,
  viewCountQuerySchema,
  viewGroupQuerySchema,
  viewListQuerySchema,
} from '../validators/config.validators';

const router = Router();

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((error: unknown) => handleServiceError(res, error));
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// The sidebar
// ═════════════════════════════════════════════════════════════════════════════

router.get('/', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const views = await listViews(actor.tenantId, actor);
  sendOk(res, views);
}));

/**
 * Every badge in one call.
 *
 * One request rather than one per view: a dozen concurrent counts against a
 * pool of ten connections is how the sidebar starves the page it decorates.
 * The service computes them sequentially and serves cached values inside the
 * debounce window.
 */
router.get('/counts', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const query = viewCountQuerySchema.parse(req.query);
  sendOk(res, await countAllViews(actor.tenantId, actor, { force: query.force }));
}));

// ═════════════════════════════════════════════════════════════════════════════
// One view
// ═════════════════════════════════════════════════════════════════════════════

router.get('/:slug', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const slug = slugParamSchema.parse(req.params.slug);

  const view = await getView(actor.tenantId, slug);
  if (!view) {
    sendFail(res, 404, `No published view with the slug "${slug}".`, { code: 'not_found' });
    return;
  }
  sendOk(res, view);
}));

/**
 * A page of the view.
 *
 * `warnings` rides along with the rows on purpose: when a predicate could not
 * be compiled the list is narrower than the author intended, and the UI has to
 * be able to say so. A silently narrowed list is the failure that gets noticed
 * only when something has already been missed.
 */
router.get('/:slug/tickets', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const slug = slugParamSchema.parse(req.params.slug);
  const query = viewListQuerySchema.parse(req.query);

  const page = await listViewTickets(actor.tenantId, actor, slug, {
    page: query.page,
    limit: query.limit,
  });

  // The count is deliberately NOT computed here: it is a separate, debounced,
  // approximate-above-a-threshold call. Pinning an exact total onto every page
  // fetch is what makes page 40 of a large view slower than page 1.
  res.status(200).json({
    success: true,
    data: page.rows,
    page: page.page,
    limit: page.limit,
    total: page.rows.length,
    warnings: page.warnings,
  });
}));

router.get('/:slug/count', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const slug = slugParamSchema.parse(req.params.slug);
  const query = viewCountQuerySchema.parse(req.query);
  sendOk(res, await countView(actor.tenantId, actor, slug, { force: query.force }));
}));

/** Column headers for a board, or the bars of an "open by …" chart. */
router.get('/:slug/groups', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const slug = slugParamSchema.parse(req.params.slug);
  const query = viewGroupQuerySchema.parse(req.query);

  sendOk(res, await countViewByGroup(actor.tenantId, actor, slug, query.groupBy, query.limit));
}));

// ═════════════════════════════════════════════════════════════════════════════
// Authoring
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Creating a view goes through the config store, so it is checksummed,
 * versioned and linted like every other config object. A saved view is not a
 * lightweight exception to that — a view with a filter naming a field nobody
 * declares is permanently empty, and the linter is what says so.
 */
router.post('/', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const input = saveViewSchema.parse(req.body);
  const view = await createView(actor, {
    ...input,
    filter: (input.filter ?? null) as never,
    columns: input.columns as never,
    sort: input.sort as never,
    visibleToCapabilities: input.visibleToCapabilities as never,
  });
  sendOk(res, view, 201);
}));

router.patch('/:slug', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const slug = slugParamSchema.parse(req.params.slug);
  const input = updateViewSchema.parse(req.body);

  const view = await updateView(actor, slug, {
    name: input.name,
    description: input.description ?? null,
    filter: (input.filter ?? null) as never,
    columns: input.columns as never,
    sort: input.sort as never,
    groupBy: input.groupBy ?? null,
    pageSize: input.pageSize,
    showCount: input.showCount,
    icon: input.icon ?? null,
    layout: input.layout,
    scope: input.scope,
    visibleToCapabilities: input.visibleToCapabilities as never,
    sortOrder: input.sortOrder,
    publish: input.publish,
  }, input.baseVersion);

  sendOk(res, view);
}));

/**
 * Archive rather than delete. A view slug appears in dashboard widgets and in
 * `saved_view_counts`; deleting the row would leave those pointing at nothing,
 * while archiving takes it out of the sidebar and leaves the reference
 * resolvable — and the linter reports the widget that still names it.
 */
router.delete('/:slug', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const slug = slugParamSchema.parse(req.params.slug);
  await archiveView(actor, slug);
  sendOk(res, { archived: true, slug });
}));

export { router as viewsRouter };
export default router;
