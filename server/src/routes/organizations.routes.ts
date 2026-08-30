/**
 * organizations.routes.ts — `/api/organizations`, the customer directory.
 *
 * MOUNT POINT: `/api/organizations`, inside the TENANT tier of
 * `routes/index.ts`, so `requireAuth` + `requireTenant` have already run by the
 * time any handler here executes and `req.tenantId` is resolved. Each route
 * additionally names the capability it needs, so the guard is readable next to
 * the route rather than inherited from a mount three files away.
 *
 * ── Route table ─────────────────────────────────────────────────────────────
 *   GET    /                          list, searched and paged      portal_admin
 *   POST   /                          create                        portal_admin
 *   GET    /:id                       one, with its counters        portal_admin
 *   PATCH  /:id                       partial update                portal_admin
 *   DELETE /:id                       delete, only while empty      portal_admin
 *   GET    /:id/usage                 what blocks a delete          portal_admin
 *   GET    /:id/contacts              this customer's requesters    portal_admin
 *   POST   /:id/contacts/reassign     move them all out             portal_admin
 *
 * ── Capabilities ────────────────────────────────────────────────────────────
 * Everything is `portal_admin`, reads included, and that is a decision rather
 * than laziness. `PORTAL_ADMIN` implies `TICKET_READ`, so no existing agent
 * loses anything, and the reverse is what matters: this directory carries a
 * customer's mail domains, its contact roster and who among them can read the
 * whole company's tickets. That is account administration, not desk work.
 *
 * If the ticket composer later wants an organisation picker for ordinary
 * agents, the answer is a narrow `ticket_read` endpoint returning id, name and
 * slug — NOT loosening these, which would put the domain list and the counters
 * behind the same key as "open a ticket".
 *
 * ── Route ordering is load-bearing ──────────────────────────────────────────
 * `/:id/contacts/reassign` is declared before `/:id/contacts` would ever be
 * ambiguous, and both are literal suffixes under `/:id`, so Express matches
 * them in declaration order without ever reading "contacts" as an id.
 *
 * ── Response envelope ───────────────────────────────────────────────────────
 * `{ success: true, data }` / `{ success: false, error }`, exactly as the rest
 * of the API. The two list endpoints add `total`, `page` and `limit` beside
 * `data`.
 *
 * ── Errors are not translated here ──────────────────────────────────────────
 * The service throws `AppError`s carrying their own `code` and payload — a
 * refused delete becomes `code: 'organization_not_empty'` with the counts that
 * explain it, a taken slug becomes `code: 'slug_taken'` — and `errorHandler`
 * renders both. A handler cannot lose the payload by forgetting a branch.
 */
import { Router, type Request } from 'express';
import { CAPABILITIES } from '@oblidesk/shared';

import { requireAuth, currentUserId } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireCapability } from '../middleware/rbac';
import { asyncHandler } from '../utils/asyncHandler';
import { portalService, type PortalAdminActor } from '../services/portal.service';
import {
  createOrganizationSchema,
  idParamSchema,
  listContactsQuerySchema,
  listOrganizationsQuerySchema,
  parseOrThrow,
  reassignContactsSchema,
  updateOrganizationSchema,
} from '../validators/portalAdmin.validators';

const router = Router();

// Belt and braces. The tenant tier already applies both, and a router that is
// ever mounted somewhere else must not silently become anonymous.
router.use(requireAuth);
router.use(requireTenant);

const admin = requireCapability(CAPABILITIES.PORTAL_ADMIN);

/**
 * The agent behind a write.
 *
 * `currentUserId()` throws rather than yielding a null actor: an audit row with
 * no actor is a row that answers "what changed" and refuses to answer "who
 * changed it", which is the half nobody needs.
 */
function actorOf(req: Request): PortalAdminActor {
  return {
    actorId: currentUserId(req),
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

function organizationIdOf(req: Request): number {
  return parseOrThrow(idParamSchema, req.params).id;
}

// ═════════════════════════════════════════════════════════════════════════════
// The directory
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/organizations — searched, paged, with contact and open-ticket counts.
 *
 * Offset paged rather than keyset, unlike the ticket queue: a customer
 * directory is tens or hundreds of rows an administrator reads and filters, not
 * a virtualised list of a hundred thousand, and paging it the same way would
 * cost a cursor nobody scrolls.
 */
router.get(
  '/',
  admin,
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listOrganizationsQuerySchema, req.query);
    const page = await portalService.listOrganizations(req.tenantId, query);

    res.json({
      success: true,
      data: page.items,
      total: page.total,
      page: page.page,
      limit: page.limit,
    });
  }),
);

router.post(
  '/',
  admin,
  asyncHandler(async (req, res) => {
    const body = parseOrThrow(createOrganizationSchema, req.body ?? {});

    const organization = await portalService.createOrganization(
      req.tenantId,
      {
        name: body.name,
        slug: body.slug ?? null,
        domains: body.domains,
        externalRef: body.externalRef ?? null,
      },
      actorOf(req),
    );

    res.status(201).json({ success: true, data: organization });
  }),
);

router.get(
  '/:id',
  admin,
  asyncHandler(async (req, res) => {
    const organization = await portalService.getOrganization(req.tenantId, organizationIdOf(req));
    res.json({ success: true, data: organization });
  }),
);

/**
 * PATCH /api/organizations/:id — partial, so the inline editors can autosave
 * one field at a time (HARD RULE 12). An absent key is not a cleared field.
 *
 * Renaming `slug` is allowed and is the one edit here with reach beyond this
 * screen: it is the handle SLA policy conditions match on (HARD RULE 3). The
 * service records both values in the audit row for exactly that reason.
 */
router.patch(
  '/:id',
  admin,
  asyncHandler(async (req, res) => {
    const body = parseOrThrow(updateOrganizationSchema, req.body ?? {});

    const organization = await portalService.updateOrganization(
      req.tenantId,
      organizationIdOf(req),
      {
        name: body.name,
        slug: body.slug,
        domains: body.domains,
        // `nullish()` means "absent" and "explicit null" are different answers,
        // and only the second one clears the field.
        ...(body.externalRef !== undefined ? { externalRef: body.externalRef ?? null } : {}),
      },
      actorOf(req),
    );

    res.json({ success: true, data: organization });
  }),
);

/**
 * DELETE /api/organizations/:id — succeeds only on an EMPTY organisation.
 *
 * The refusal is a 409 carrying `code: 'organization_not_empty'` and the counts,
 * so the screen can name what is in the way instead of saying "could not
 * delete". The long argument for why this is not a cascade — contracts are
 * `ON DELETE CASCADE`, tickets and contacts are `SET NULL` — is in
 * `portal.service.deleteOrganization`.
 */
router.delete(
  '/:id',
  admin,
  asyncHandler(async (req, res) => {
    const result = await portalService.deleteOrganization(
      req.tenantId,
      organizationIdOf(req),
      actorOf(req),
    );
    res.json({ success: true, data: result });
  }),
);

/**
 * GET /api/organizations/:id/usage — the same counts the delete refusal
 * carries, readable before anyone clicks Delete.
 *
 * It exists so the button can be disabled with a reason attached rather than
 * offered and then refused: a destructive action that only tells you it is
 * impossible after you commit to it is a worse screen than one that never
 * offered it.
 */
router.get(
  '/:id/usage',
  admin,
  asyncHandler(async (req, res) => {
    const usage = await portalService.organizationUsage(req.tenantId, organizationIdOf(req));
    res.json({ success: true, data: usage });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// The contacts under one organisation
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/organizations/:id/contacts — the same list as
 * `/api/portal-admin/contacts?organizationId=<id>`, reached from the
 * organisation's own page.
 *
 * It delegates to the identical service call with the organisation FORCED from
 * the path, so a query string cannot widen it to another customer. One
 * implementation, two entry points — the alternative is a second filter that
 * eventually disagrees with the first about what "active" means.
 */
router.get(
  '/:id/contacts',
  admin,
  asyncHandler(async (req, res) => {
    const organizationId = organizationIdOf(req);
    const query = parseOrThrow(listContactsQuerySchema, req.query);

    const page = await portalService.listContacts(req.tenantId, {
      ...query,
      organizationId,
    });

    res.json({
      success: true,
      data: page.items,
      total: page.total,
      page: page.page,
      limit: page.limit,
    });
  }),
);

/**
 * POST /api/organizations/:id/contacts/reassign — move every contact out.
 *
 * The emptying step before a delete, and the honest answer to "this customer
 * was acquired". `targetOrganizationId: null` detaches them entirely.
 *
 * Whatever the target, the move REVOKES `org_visibility` on anyone who held it:
 * the right was granted against the organisation they are leaving. The response
 * reports how many were revoked so the screen can say so rather than leaving an
 * administrator to discover it on the contact list.
 */
router.post(
  '/:id/contacts/reassign',
  admin,
  asyncHandler(async (req, res) => {
    const body = parseOrThrow(reassignContactsSchema, req.body ?? {});

    const result = await portalService.reassignOrganizationContacts(
      req.tenantId,
      organizationIdOf(req),
      body.targetOrganizationId,
      actorOf(req),
    );

    res.json({ success: true, data: result });
  }),
);

export { router as organizationsRouter };
export default router;
