/**
 * portalAdmin.routes.ts — `/api/portal-admin`, the requesters themselves.
 *
 * MOUNT POINT: `/api/portal-admin`, inside the TENANT tier of `routes/index.ts`.
 * `requireAuth` + `requireTenant` have already run, so `req.tenantId` is
 * resolved and every handler below acts as an AGENT.
 *
 * ── This is the mirror image of `portal.routes.ts`, and they never meet ─────
 * `/api/portal` is the requester's door: no `users` row, no capabilities, a
 * session guarded by `requirePortalSession`. `/api/portal-admin` is the agent's
 * door onto the same records: `requireAuth` + `requireTenant` +
 * `portal_admin`. The name is one hyphen apart on purpose — they administer the
 * same table — but nothing is shared between them except the service module,
 * and the service functions used here take a `tenantId` and a
 * `PortalAdminActor`, never a `PortalPrincipal`. A portal session cannot reach
 * these handlers: `requireAuth` reads `req.session.userId`, which a portal
 * session never sets.
 *
 * ── Route table ─────────────────────────────────────────────────────────────
 *   GET    /contacts                  list, filtered and paged      portal_admin
 *   POST   /contacts                  create                        portal_admin
 *   GET    /contacts/:id              one                           portal_admin
 *   PATCH  /contacts/:id              partial update                portal_admin
 *   PUT    /contacts/:id/active       activate / deactivate         portal_admin
 *   PUT    /contacts/:id/visibility   GRANT or REVOKE org reading   portal_admin
 *
 * ── The one route that matters more than the others ─────────────────────────
 * `PUT /contacts/:id/visibility` is the reason this router exists. It is the
 * only way a contact's `org_visibility` becomes `'organization'`, and what that
 * grants is real: `visibleTickets()` then lets them read every ticket their
 * organisation ever filed, colleagues' included. It therefore has its own
 * route, its own body and its own audit verbs
 * (`portal_contact.visibility_grant` / `.visibility_revoke`) instead of being a
 * field on the PATCH — a permission change buried in a directory edit is a
 * permission change nobody reviews.
 *
 * Every OTHER write here can only LOWER that right, never raise it. Moving a
 * contact to a different organisation revokes it, because the right named the
 * organisation they are leaving.
 *
 * ── There is no DELETE ──────────────────────────────────────────────────────
 * Deactivation is the removal this module offers, and the omission is
 * deliberate: `tickets.requester_contact_id` and
 * `ticket_journal.author_contact_id` are both `ON DELETE SET NULL`, so deleting
 * a contact would anonymise every ticket they filed and every reply they wrote.
 * Deactivating takes effect on their very next request — the portal session
 * guard re-reads `is_active` rather than trusting the cookie — and leaves the
 * history intact.
 *
 * ── Response envelope ───────────────────────────────────────────────────────
 * `{ success: true, data }` / `{ success: false, error }`. The list endpoint
 * adds `total`, `page` and `limit` beside `data`. Errors carry the service's
 * own `code` (`contact_email_taken`, `organization_required`) and are rendered
 * by `errorHandler`; nothing is translated in this file.
 */
import { Router, type Request } from 'express';
import { CAPABILITIES } from '@oblidesk/shared';

import { requireAuth, currentUserId } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireCapability } from '../middleware/rbac';
import { asyncHandler } from '../utils/asyncHandler';
import { portalService, type PortalAdminActor } from '../services/portal.service';
import {
  createContactSchema,
  idParamSchema,
  listContactsQuerySchema,
  parseOrThrow,
  setContactActiveSchema,
  setContactVisibilitySchema,
  updateContactSchema,
} from '../validators/portalAdmin.validators';

const router = Router();

// Belt and braces. The tenant tier already applies both, and a router that is
// ever mounted somewhere else must not silently become anonymous.
router.use(requireAuth);
router.use(requireTenant);

const admin = requireCapability(CAPABILITIES.PORTAL_ADMIN);

/** See `organizations.routes.ts` — `currentUserId()` throws rather than yielding a null actor. */
function actorOf(req: Request): PortalAdminActor {
  return {
    actorId: currentUserId(req),
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

function contactIdOf(req: Request): number {
  return parseOrThrow(idParamSchema, req.params).id;
}

// ═════════════════════════════════════════════════════════════════════════════
// The roster
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/portal-admin/contacts
 *
 * `?organizationId=none` is the queue this screen exists for: contacts mail
 * intake created from an address whose domain matched no organisation. They can
 * sign in, they can file tickets, and until somebody files them under a
 * customer they belong to nobody — which is also why they can never be granted
 * organisation reading.
 *
 * `?orgVisibility=organization` is the audit view: everyone in this tenant who
 * can read a whole company's tickets, on one page.
 */
router.get(
  '/contacts',
  admin,
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listContactsQuerySchema, req.query);
    const page = await portalService.listContacts(req.tenantId, query);

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
 * POST /api/portal-admin/contacts
 *
 * The body carries no `orgVisibility` and the schema is `.strict()`, so sending
 * one is a 400 rather than a silently ignored field. A contact is born reading
 * their own tickets; widening is a separate act on the route below.
 */
router.post(
  '/contacts',
  admin,
  asyncHandler(async (req, res) => {
    const body = parseOrThrow(createContactSchema, req.body ?? {});

    const contact = await portalService.createContact(
      req.tenantId,
      {
        email: body.email,
        displayName: body.displayName ?? null,
        phone: body.phone ?? null,
        organizationId: body.organizationId ?? null,
        locale: body.locale,
        isActive: body.isActive,
      },
      actorOf(req),
    );

    res.status(201).json({ success: true, data: contact });
  }),
);

router.get(
  '/contacts/:id',
  admin,
  asyncHandler(async (req, res) => {
    const contact = await portalService.getContact(req.tenantId, contactIdOf(req));
    res.json({ success: true, data: contact });
  }),
);

/**
 * PATCH /api/portal-admin/contacts/:id — partial, autosave-friendly
 * (HARD RULE 12). An absent key changes nothing.
 *
 * Two things this route will NOT do. It will not change `email` — the schema
 * rejects it, because an address is the identity every ticket this person filed
 * is attributed to and where their sign-in links are sent. And it will not
 * carry a reading right across an organisation change: moving the contact
 * revokes `org_visibility`, and the response shows it revoked so the screen
 * never disagrees with the database.
 */
router.patch(
  '/contacts/:id',
  admin,
  asyncHandler(async (req, res) => {
    const body = parseOrThrow(updateContactSchema, req.body ?? {});

    const contact = await portalService.updateContact(
      req.tenantId,
      contactIdOf(req),
      {
        // `nullish()` means "absent" and "explicit null" are different answers,
        // and only the second one clears the field.
        ...(body.displayName !== undefined ? { displayName: body.displayName ?? null } : {}),
        ...(body.phone !== undefined ? { phone: body.phone ?? null } : {}),
        ...(body.organizationId !== undefined
          ? { organizationId: body.organizationId ?? null }
          : {}),
        ...(body.locale !== undefined ? { locale: body.locale } : {}),
      },
      actorOf(req),
    );

    res.json({ success: true, data: contact });
  }),
);

/**
 * PUT /api/portal-admin/contacts/:id/active
 *
 * One route rather than `/activate` and `/deactivate`, because a UI toggle
 * sends a boolean and a toggle that has to pick a URL is a toggle that will
 * eventually send the wrong one. The ledger still gets two distinct verbs —
 * the service chooses `portal_contact.activate` or `.deactivate` from the
 * value — so "who locked this customer out" stays a filter rather than a
 * payload search.
 */
router.put(
  '/contacts/:id/active',
  admin,
  asyncHandler(async (req, res) => {
    const { isActive } = parseOrThrow(setContactActiveSchema, req.body ?? {});

    const contact = await portalService.setContactActive(
      req.tenantId,
      contactIdOf(req),
      isActive,
      actorOf(req),
    );

    res.json({ success: true, data: contact });
  }),
);

/**
 * PUT /api/portal-admin/contacts/:id/visibility — THE grant.
 *
 * `{ orgVisibility: 'organization' }` hands this person every ticket their
 * organisation ever filed. `{ orgVisibility: 'own' }` takes it back, and both
 * take effect on the requester's very next request because the portal session
 * guard re-reads the column instead of trusting the cookie.
 *
 * `organizationId` may ride along, so "promote this person to read all of ACME"
 * is one request rather than a PATCH followed by a grant with a window in
 * between where the record is half-changed.
 *
 * Granting to a contact who belongs to no organisation is a 409 carrying
 * `code: 'organization_required'` — a right that names nothing cannot be
 * exercised, and migration 009's CHECK says so too, but a sentence with a field
 * on it beats a raw 23514.
 */
router.put(
  '/contacts/:id/visibility',
  admin,
  asyncHandler(async (req, res) => {
    const body = parseOrThrow(setContactVisibilitySchema, req.body ?? {});

    const contact = await portalService.setContactVisibility(
      req.tenantId,
      contactIdOf(req),
      {
        orgVisibility: body.orgVisibility,
        ...(body.organizationId !== undefined
          ? { organizationId: body.organizationId ?? null }
          : {}),
      },
      actorOf(req),
    );

    res.json({ success: true, data: contact });
  }),
);

export { router as portalAdminRouter };
export default router;
