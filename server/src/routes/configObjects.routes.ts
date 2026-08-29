/**
 * configObjects.routes.ts — `/api/config`.
 *
 * The HTTP surface of the configuration store: list, read, draft, publish,
 * archive, revert, version history, lint, and the bundle export/import.
 *
 * Every handler is the same four lines — resolve the actor, check the
 * capability, call the service, send the envelope — because all the judgement
 * lives in the services. A route that starts making decisions is a route that
 * has to be re-audited every time somebody adds a second caller.
 *
 * MOUNTING: this router expects to sit behind the app's auth middleware, but
 * it does not depend on it. `resolveActor` reads the session itself and throws
 * 401 when there is not one, so a mounting mistake fails closed rather than
 * exposing the configuration of every tenant.
 */

import { Router, type Request, type Response } from 'express';

import {
  CAPABILITIES,
  CONFIG_BODY_FORMAT_VERSIONS,
  CONFIG_KINDS,
  CONFIG_KIND_LABELS,
  CONFIG_KIND_REFERENCES,
} from '@oblidesk/shared';

import {
  archiveConfigObject,
  createConfigObject,
  deleteConfigObject,
  driftFromShipped,
  getConfigObject,
  getVersion,
  listConfigObjects,
  listVersions,
  publishConfigObject,
  restoreConfigObject,
  revertToVersion,
  updateConfigObject,
} from '../services/configObject.service';
import { lintOne, lintTenant } from '../services/configLinter.service';
import {
  applyImport,
  exportBundle,
  planImport,
  planResetToDefaults,
  resetToDefaults,
} from '../services/configBundle.service';
import {
  asArray,
  createConfigObjectSchema,
  exportBundleQuerySchema,
  handleServiceError,
  importBundleSchema,
  kindParamSchema,
  listConfigQuerySchema,
  publishConfigObjectSchema,
  requireCapability,
  resetDefaultsSchema,
  resolveActor,
  revertConfigObjectSchema,
  sendFail,
  sendList,
  sendOk,
  slugParamSchema,
  updateConfigObjectSchema,
} from '../validators/config.validators';

const router = Router();

/** Express 4 does not catch a rejected promise from a handler. This does. */
function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((error: unknown) => handleServiceError(res, error));
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Catalogue — what the config editor builds its navigation from
// ═════════════════════════════════════════════════════════════════════════════

router.get('/catalog', wrap(async (req, res) => {
  await resolveActor(req);
  sendOk(res, {
    kinds: CONFIG_KINDS.map((kind) => ({
      kind,
      label: CONFIG_KIND_LABELS[kind],
      bodyFormatVersion: CONFIG_BODY_FORMAT_VERSIONS[kind],
      references: CONFIG_KIND_REFERENCES[kind],
    })),
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// Lint — the configuration health screen
// ═════════════════════════════════════════════════════════════════════════════

router.get('/lint', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const findings = await lintTenant(actor.tenantId);
  sendOk(res, {
    findings,
    summary: {
      error: findings.filter((finding) => finding.severity === 'error').length,
      warning: findings.filter((finding) => finding.severity === 'warning').length,
      info: findings.filter((finding) => finding.severity === 'info').length,
    },
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// Bundle — export / import / reset
// ═════════════════════════════════════════════════════════════════════════════

router.get('/bundle', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const query = exportBundleQuerySchema.parse(req.query);
  const bundle = await exportBundle(actor, {
    kinds: asArray(query.kinds) as never,
    includeDrafts: query.includeDrafts,
    includeArchived: query.includeArchived,
  });
  sendOk(res, bundle);
}));

/** PASS 1 — resolves and reports; writes nothing. */
router.post('/bundle/plan', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const input = importBundleSchema.parse(req.body);
  sendOk(res, await planImport(actor, input.bundle));
}));

/** PASS 2 — applies, in one transaction, skipping conflicts unless chosen. */
router.post('/bundle/apply', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const input = importBundleSchema.parse(req.body);
  sendOk(res, await applyImport(actor, input.bundle, {
    decisions: input.decisions,
    applyConflicts: input.applyConflicts,
    note: input.note,
  }));
}));

router.get('/bundle/reset/plan', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);
  sendOk(res, await planResetToDefaults(actor));
}));

/**
 * Reset to the shipped baseline. It is the ordinary import over the ordinary
 * baseline bundle — there is no separate restore path to rot.
 */
router.post('/bundle/reset', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const input = resetDefaultsSchema.parse(req.body ?? {});
  sendOk(res, await resetToDefaults(actor, input.overwriteLocalEdits === true));
}));

// ═════════════════════════════════════════════════════════════════════════════
// Objects
// ═════════════════════════════════════════════════════════════════════════════

router.get('/', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const query = listConfigQuerySchema.parse(req.query);

  const result = await listConfigObjects(actor, {
    kind: asArray(query.kind) as never,
    status: asArray(query.status) as never,
    q: query.q,
    isSystem: query.isSystem,
    includeShared: query.includeShared,
    page: query.page,
    limit: query.limit,
  });

  sendList(res, result.objects, { total: result.total, page: result.page, limit: result.limit });
}));

router.post('/', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const input = createConfigObjectSchema.parse(req.body);
  const created = await createConfigObject(actor, {
    kind: input.kind as never,
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    body: input.body,
    status: input.status,
    targetTenantIds: input.targetTenantIds,
    note: input.note,
  });
  sendOk(res, created, 201);
}));

router.get('/:kind', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const kind = kindParamSchema.parse(req.params.kind);
  const query = listConfigQuerySchema.parse(req.query);

  const result = await listConfigObjects(actor, {
    kind: kind as never,
    status: asArray(query.status) as never,
    q: query.q,
    page: query.page,
    limit: query.limit,
  });
  sendList(res, result.objects, { total: result.total, page: result.page, limit: result.limit });
}));

router.get('/:kind/:slug', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const kind = kindParamSchema.parse(req.params.kind);
  const slug = slugParamSchema.parse(req.params.slug);

  const object = await getConfigObject(actor, kind as never, slug);
  if (!object) {
    sendFail(res, 404, `No ${kind} object with the slug "${slug}".`, { code: 'not_found' });
    return;
  }
  sendOk(res, object);
}));

router.patch('/:kind/:slug', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const kind = kindParamSchema.parse(req.params.kind);
  const slug = slugParamSchema.parse(req.params.slug);
  const input = updateConfigObjectSchema.parse(req.body);

  sendOk(res, await updateConfigObject(actor, kind as never, slug, input));
}));

router.delete('/:kind/:slug', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const kind = kindParamSchema.parse(req.params.kind);
  const slug = slugParamSchema.parse(req.params.slug);

  await deleteConfigObject(actor, kind as never, slug);
  sendOk(res, { deleted: true });
}));

/**
 * Publish. Returns 422 with the linter's findings when the body would break a
 * cross-reference — the findings ARE the response, because "publish failed"
 * with nothing to act on is how an admin ends up editing the database.
 */
router.post('/:kind/:slug/publish', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const kind = kindParamSchema.parse(req.params.kind);
  const slug = slugParamSchema.parse(req.params.slug);
  const input = publishConfigObjectSchema.parse(req.body ?? {});

  sendOk(res, await publishConfigObject(actor, kind as never, slug, input.note));
}));

router.post('/:kind/:slug/archive', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const kind = kindParamSchema.parse(req.params.kind);
  const slug = slugParamSchema.parse(req.params.slug);
  sendOk(res, await archiveConfigObject(actor, kind as never, slug));
}));

router.post('/:kind/:slug/restore', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const kind = kindParamSchema.parse(req.params.kind);
  const slug = slugParamSchema.parse(req.params.slug);
  sendOk(res, await restoreConfigObject(actor, kind as never, slug));
}));

router.post('/:kind/:slug/revert', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const kind = kindParamSchema.parse(req.params.kind);
  const slug = slugParamSchema.parse(req.params.slug);
  const input = revertConfigObjectSchema.parse(req.body);

  sendOk(res, await revertToVersion(actor, kind as never, slug, input.version));
}));

// ── history ─────────────────────────────────────────────────────────────────

router.get('/:kind/:slug/versions', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const kind = kindParamSchema.parse(req.params.kind);
  const slug = slugParamSchema.parse(req.params.slug);
  sendOk(res, await listVersions(actor, kind as never, slug));
}));

router.get('/:kind/:slug/versions/:version', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const kind = kindParamSchema.parse(req.params.kind);
  const slug = slugParamSchema.parse(req.params.slug);
  const version = Number(req.params.version);

  const found = await getVersion(actor, kind as never, slug, version);
  if (!found) {
    sendFail(res, 404, `Version ${version} of ${kind}:${slug} does not exist.`, { code: 'not_found' });
    return;
  }
  sendOk(res, found);
}));

// ── per-object lint and drift ───────────────────────────────────────────────

/** Lint one object without publishing it — the editor's live feedback. */
router.get('/:kind/:slug/lint', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const kind = kindParamSchema.parse(req.params.kind);
  const slug = slugParamSchema.parse(req.params.slug);

  const object = await getConfigObject(actor, kind as never, slug);
  if (!object) {
    sendFail(res, 404, `No ${kind} object with the slug "${slug}".`, { code: 'not_found' });
    return;
  }

  sendOk(res, await lintOne(actor.tenantId, {
    kind: object.kind,
    slug: object.slug,
    name: object.name,
    body: object.body,
    bodyFormatVersion: object.bodyFormatVersion,
    status: object.status,
  }));
}));

/** "Modified from the shipped baseline?" — drives the badge on system objects. */
router.get('/:kind/:slug/drift', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  const kind = kindParamSchema.parse(req.params.kind);
  const slug = slugParamSchema.parse(req.params.slug);
  sendOk(res, await driftFromShipped(actor, kind as never, slug));
}));

export { router as configObjectsRouter };
export default router;
