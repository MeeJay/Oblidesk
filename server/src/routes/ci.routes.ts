/**
 * ci.routes.ts — `/api/ci`, the desk-owned half of a configuration item.
 *
 * MOUNT POINT: `/api/ci`, inside the TENANT tier of `routes/index.ts`, so
 * `requireAuth` + `requireTenant` have already run by the time any handler
 * here executes and `req.tenantId` is resolved. Each route additionally names
 * the capability it needs, so the guard is readable next to the route rather
 * than inherited from a mount three files away.
 *
 * ── Route table ─────────────────────────────────────────────────────────────
 *   GET    /                            list, keyset paginated       ci_read
 *   GET    /:id                         one CI, everything desk-owned ci_read
 *   PATCH  /:id                         owner / criticality / group   ci_rw
 *   PUT    /:id/overlay                 set (or unset) one key        ci_rw
 *   DELETE /:id                         retire, never hard delete     ci_rw
 *   POST   /:id/tickets/:ticketId       link                          ci_rw
 *   DELETE /:id/tickets/:ticketId       unlink                        ci_rw
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * `GET /:id/live/:app` — the cross-app read that fills the context rail's
 * sibling sections — lives in its own module, mounted at this same prefix. It
 * is a privileged, audited, SSRF-sensitive operation and it does not belong
 * next to CRUD. Do not add a second one here: two proxies means two places to
 * get the authorisation rules right, and one of them will drift.
 *
 * The seam it consumes is exported from `ci.service.ts`: `requireCi` proves the
 * CI is the caller's, `sourceLinkFor` resolves WHERE to read from out of the
 * database (never out of the request), and `cacheSourcePayload` writes the
 * answer back as a cache with its `last_fetched_at`.
 *
 * ── Response envelope ───────────────────────────────────────────────────────
 * `{ success: true, data }` / `{ success: false, error }`, exactly as the rest
 * of the API. The list adds `nextCursor` and `hasMore` beside `data` the way
 * the ticket list does, because the client's keyset reader expects them there.
 */
import { Router, type Request } from 'express';
import { CAPABILITIES, type CiCriticality, type CiKind, type TicketCiRole } from '@oblidesk/shared';

import { requireAuth, currentUserId } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireCapability } from '../middleware/rbac';
import { notFound } from '../middleware/errorHandler';
import { asyncHandler } from '../utils/asyncHandler';
import * as ciService from '../services/ci.service';
import type { CiActor } from '../services/ci.service';
import {
  ciIdParamSchema,
  ciTicketParamsSchema,
  deskFieldsSchema,
  linkTicketSchema,
  listCisQuerySchema,
  parseOrBadRequest,
  setOverlaySchema,
} from '../validators/ci.validators';

const router = Router();

// Belt and braces. The tenant tier already applies both, and a router that is
// ever mounted somewhere else must not silently become anonymous.
router.use(requireAuth);
router.use(requireTenant);

const read = requireCapability(CAPABILITIES.CI_READ);
const write = requireCapability(CAPABILITIES.CI_RW);

/**
 * Who is acting, for the audit row every mutation in `ci.service` writes.
 *
 * `currentUserId` throws rather than yielding a null actor, so a route that
 * lost its auth middleware fails loudly instead of appending "somebody" to a
 * hash-chained ledger.
 */
function actorOf(req: Request): CiActor {
  return {
    actorId: currentUserId(req),
    actorType: 'user',
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Reads
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/ci
 *
 * Keyset, not offset: an asset list is virtualised, and a machine seen again
 * mid-scroll would shift an OFFSET window and drop or repeat a row.
 */
router.get(
  '/',
  read,
  asyncHandler(async (req, res) => {
    const query = parseOrBadRequest(listCisQuerySchema, req.query);

    const page = await ciService.list({
      tenantId: req.tenantId,
      search: query.search ?? null,
      kind: (query.kind as CiKind[] | undefined) ?? null,
      criticality: (query.criticality as CiCriticality[] | undefined) ?? null,
      hasOpenTickets: query.hasOpenTickets ?? null,
      cursor: query.cursor ?? null,
      limit: query.limit,
      sortBy: query.sortBy,
      sortDir: query.sortDir,
    });

    res.json({
      success: true,
      data: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    });
  }),
);

/**
 * GET /api/ci/:id
 *
 * The CI record, its source links, its overlays, its cached state row and its
 * open-ticket count. Desk-owned data only: nothing here crosses the network, so
 * a sibling app being down cannot make a ticket's own CI look missing.
 *
 * A retired CI is returned WITH its `deletedAt`, not 404'd. Tickets and frozen
 * evidence still reference it, and "retired on 3 March" beats a blank space.
 */
router.get(
  '/:id',
  read,
  asyncHandler(async (req, res) => {
    const { id } = parseOrBadRequest(ciIdParamSchema, req.params);

    const ci = await ciService.get(req.tenantId, id);
    if (!ci) throw notFound('Configuration item not found');

    res.json({ success: true, data: ci });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Desk-owned writes
// ═════════════════════════════════════════════════════════════════════════════

/**
 * PATCH /api/ci/:id — owner, criticality, support group.
 *
 * These three plus the overlays are everything Oblidesk owns about a machine.
 * A technician who needs the hostname or the disk size changed is asking the
 * wrong application: that fix is in Obliance, and a local copy here would be a
 * second answer nobody could tell from the first.
 */
router.patch(
  '/:id',
  write,
  asyncHandler(async (req, res) => {
    const { id } = parseOrBadRequest(ciIdParamSchema, req.params);
    const patch = parseOrBadRequest(deskFieldsSchema, req.body ?? {});

    const ci = await ciService.setDeskFields(req.tenantId, id, patch, actorOf(req));
    res.json({ success: true, data: ci });
  }),
);

/**
 * PUT /api/ci/:id/overlay — one desk-owned key/value.
 *
 * `{ "key": "asset_tag", "value": "PC-0412" }` sets it. `{ "key": "asset_tag" }`
 * with NO `value` key removes it, because a pair with no value is not a pair.
 * An explicit `"value": null` is a stored null and stays stored, which is why
 * the presence of the property is tested rather than its truthiness.
 */
router.put(
  '/:id/overlay',
  write,
  asyncHandler(async (req, res) => {
    const { id } = parseOrBadRequest(ciIdParamSchema, req.params);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { key, value } = parseOrBadRequest(setOverlaySchema, body);

    const actor = actorOf(req);
    const overlays = Object.prototype.hasOwnProperty.call(body, 'value')
      ? await ciService.setOverlay(req.tenantId, id, key, value, actor)
      : await ciService.removeOverlay(req.tenantId, id, key, actor);

    res.json({ success: true, data: overlays });
  }),
);

/**
 * DELETE /api/ci/:id — retire.
 *
 * A soft delete, always. Tickets, `ticket_cis` rows and frozen evidence point
 * at this id; removing the row would either cascade them away or orphan them,
 * and either way the ticket about the laptop loses the laptop.
 */
router.delete(
  '/:id',
  write,
  asyncHandler(async (req, res) => {
    const { id } = parseOrBadRequest(ciIdParamSchema, req.params);

    const ci = await ciService.softDelete(req.tenantId, id, actorOf(req));
    res.json({ success: true, data: ci });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Ticket links
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/ci/:id/tickets/:ticketId — attach this CI to that ticket.
 *
 * Body may carry `{ "role": "primary" | "affected" | "cause" }`. It defaults to
 * `affected`: linking is how a technician says "this machine is involved", and
 * promoting that to a claim about cause is a separate judgement they should
 * have to make on purpose.
 */
router.post(
  '/:id/tickets/:ticketId',
  write,
  asyncHandler(async (req, res) => {
    const { id, ticketId } = parseOrBadRequest(ciTicketParamsSchema, req.params);
    const { role } = parseOrBadRequest(linkTicketSchema, req.body ?? {});

    const links = await ciService.linkTicket(
      req.tenantId,
      ticketId,
      id,
      (role ?? 'affected') as TicketCiRole,
      actorOf(req),
    );

    res.status(201).json({ success: true, data: links });
  }),
);

/** DELETE /api/ci/:id/tickets/:ticketId — detach. Already detached is a no-op. */
router.delete(
  '/:id/tickets/:ticketId',
  write,
  asyncHandler(async (req, res) => {
    const { id, ticketId } = parseOrBadRequest(ciTicketParamsSchema, req.params);

    const links = await ciService.unlinkTicket(req.tenantId, ticketId, id, actorOf(req));
    res.json({ success: true, data: links });
  }),
);

export default router;
