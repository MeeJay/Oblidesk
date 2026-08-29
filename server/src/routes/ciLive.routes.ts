/**
 * ciLive.routes.ts — `GET /api/ci/:id/live/:app`
 *
 * The read-through endpoint behind the context rail: one sibling app's live
 * view of one configuration item, proxied by the desk.
 *
 * ── Why the browser does not call Obliview itself ───────────────────────────
 * Different origin, different session, and the tenant mapping is by SLUG
 * (HARD RULE 13) which only the server can resolve. The desk proxies, which
 * means the desk is the one holding a privileged key, which is why this file
 * is short and the rules below are not negotiable.
 *
 * ── The four conditions, enforced here and in the service ───────────────────
 *  1. AUTHORISE IN OUR OWN MODEL FIRST. requireAuth + requireTenant (below) +
 *     requireCapability(CI_READ) per route, and `ciLiveService.read` loads the
 *     CI through `scoped('cis', tenantId)` so a CI in another tenant is a 404.
 *     No "master tenant sees all" shortcut on this path.
 *  2. THE CLIENT NAMES A CI AND AN APP SLUG, NOTHING ELSE. `:app` is checked
 *     against the CLOSED list `CI_SOURCE_APPS`; a value outside it is a 400 and
 *     never reaches a fetch. No path, URL, host or external id is accepted from
 *     the caller, because the key on the wire is privileged and that would be a
 *     server-side request forgery with credentials attached.
 *  3. EVERY CROSS-APP READ IS AUDITED, in `ciLiveService.read`.
 *  4. IT IS WRITTEN DOWN: the read is made with OBLIDESK's authority, not the
 *     caller's, because the suite has no delegated user-scoped token yet. See
 *     the header of `services/ciLive.service.ts` for the full statement. This
 *     is provisional and goes away when Obligate ships delegation.
 *
 * ── The response contract (client/src/api/ci.api.ts) ────────────────────────
 * The client unwraps `{ success, data }` and renders `data`, so everything the
 * rail needs is INSIDE that record: the flat fields, `url` (the deep link),
 * `lastFetchedAt`, `stale` and `reason`. Three answers are possible:
 *
 *   200 + a populated record   the source answered, or the cache answered and
 *                              says so with `stale: true` and its real age
 *   200 + `{}`                 this app does not hold this machine, which is
 *                              "aucune donnee", not a failure
 *   4xx/5xx + `{ error }`      the source could not be read, and the sentence
 *                              says why
 *
 * A section that cannot load returns a REASON, never an empty success: a rail
 * that silently hides a dead source teaches technicians to distrust all of it.
 * Nothing here throws to the client for a source failure, so `next(err)` is
 * reached only by a genuine defect in the desk itself.
 */

import { Router, type Request, type Response } from 'express';
import { CAPABILITIES } from '@oblidesk/shared';
import { currentUserId, requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireCapability } from '../middleware/rbac';
import { asyncHandler } from '../utils/asyncHandler';
import { ciLiveService, isCiSourceApp } from '../services/ciLive.service';

const router = Router();

// Applied here as well as at the mount point: this router must be impossible to
// mount in the global tier by accident, where `req.tenantId` would be undefined
// and the CI lookup would read nothing (or, worse, everything).
router.use(requireAuth);
router.use(requireTenant);

function parseId(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * GET /api/ci/:id/live/:app — one sibling app's live view of this CI.
 */
router.get(
  '/:id/live/:app',
  requireCapability(CAPABILITIES.CI_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const ciId = parseId(req.params.id);
    if (ciId === null) {
      res.status(400).json({ success: false, error: "Identifiant d'equipement invalide." });
      return;
    }

    // THE closed list. Everything else about the target (host, path, object id)
    // is resolved server-side from `ci_source_links` and Obligate's registries.
    const app = req.params.app;
    if (!isCiSourceApp(app)) {
      res.status(400).json({ success: false, error: `Source inconnue : ${String(app)}.` });
      return;
    }

    const result = await ciLiveService.read({
      tenantId: req.tenantId,
      tenantSlug: req.tenantSlug,
      ciId,
      app,
      actorId: currentUserId(req),
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });

    if (result.httpStatus !== 200) {
      // The reason is the payload. The client turns it into the sentence under
      // the section heading, which is the only thing standing between a
      // technician and "the rail is broken again".
      res.status(result.httpStatus).json({
        success: false,
        error: result.reasonText,
        reason: result.reason,
        app: result.app,
      });
      return;
    }

    res.json({
      success: true,
      data: result.data ?? {},
      // Repeated outside the record for anything reading this endpoint directly
      // (curl, a probe, a future rail). The rail itself reads them from `data`.
      app: result.app,
      status: result.status,
      stale: result.stale,
      lastFetchedAt: result.lastFetchedAt,
    });
  }),
);

export default router;
