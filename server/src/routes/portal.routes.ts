/**
 * portal.routes.ts — the requester-facing API.
 *
 * MOUNT POINT: `/api/portal`, in the GLOBAL tier of `routes/index.ts`.
 *
 * It sits OUTSIDE `requireAuth` + `requireTenant` on purpose, and that is the
 * whole design rather than a convenience:
 *
 *   • `requireAuth` reads `req.session.userId`, which a portal session never
 *     sets. Mounting these routes in the tenant tier would 401 every one of
 *     them, and "fixing" that by giving a requester a `userId` is exactly the
 *     SSO bypass `portal.service.ts` exists to refuse.
 *   • `requireTenant` resolves the tenant from a MEMBERSHIP row. A requester
 *     has no membership; their tenant comes from the burned magic-link token
 *     and is pinned in the session, where the browser cannot change it.
 *
 * So the guard here is `requirePortalSession`, which resolves the tenant from
 * the session, re-reads the contact on every request (a contact deactivated at
 * 09:00 loses access at 09:00, not at session expiry), and attaches
 * `req.portal` — a principal with NO capabilities field, so no capability
 * middleware can be pointed at it even by accident.
 *
 *   POST   /api/portal/request-link            send a sign-in link
 *   POST   /api/portal/verify                  burn a link, open a session
 *   POST   /api/portal/logout                  end it
 *   GET    /api/portal/me                      who am I
 *   GET    /api/portal/tickets                 my tickets (?scope=organization)
 *   POST   /api/portal/tickets                 file one
 *   GET    /api/portal/tickets/:id             one ticket + its PUBLIC timeline
 *   POST   /api/portal/tickets/:id/reply       reply (reopens if resolved)
 *   POST   /api/portal/tickets/:id/attachments upload
 *   GET    /api/portal/attachments/:id         download one I may see
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { LIMITS } from '@oblidesk/shared';

import { logger } from '../utils/logger';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { portalLimiter, createLimiter } from '../middleware/rateLimiter';
import { portalService } from '../services/portal.service';
import * as attachmentService from '../services/attachment.service';

const router = Router();

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Sign-in
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A tighter bucket than the general portal limiter, because this endpoint SENDS
 * MAIL. The service also rate-limits per ADDRESS (which is the resource being
 * protected — somebody's inbox); this one bounds a single client hammering it
 * with a thousand different addresses, which the per-address counter cannot see.
 */
const linkLimiter = createLimiter({ windowMs: 15 * 60_000, max: 20 });

router.post(
  '/request-link',
  linkLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const result = await portalService.requestMagicLink({
      tenantSlug: String(body.tenantSlug ?? ''),
      email: String(body.email ?? ''),
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      redirectPath: typeof body.next === 'string' ? body.next : null,
    });

    // ALWAYS the same answer. See `requestMagicLink` — anything else turns this
    // into a customer-list oracle.
    res.json({ success: true, data: result });
  }),
);

/**
 * POST /api/portal/verify
 *
 * `regenerate()` before anything is written to the session: a fresh session id
 * on every privilege change is what stops session fixation, where an attacker
 * plants a known id in the victim's browser and inherits whatever it becomes.
 * It also guarantees a portal session can never inherit the contents of an
 * agent session that happened to be in the same cookie jar.
 */
router.post(
  '/verify',
  portalLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const token = String((req.body as Record<string, unknown> | undefined)?.token ?? '');
    const verified = await portalService.verifyMagicLink(token);

    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });

    req.session.portal = {
      tenantId: verified.principal.tenantId,
      tenantSlug: verified.principal.tenantSlug,
      contactId: verified.principal.contactId,
      email: verified.principal.email,
      issuedAt: Date.now(),
      expiresAt: Date.now() + portalService.PORTAL_SESSION_TTL_MS,
    };
    // A portal session is shorter-lived than an agent's. Setting it on the
    // cookie as well as in the payload means a closed laptop expires too.
    req.session.cookie.maxAge = portalService.PORTAL_SESSION_TTL_MS;

    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    logger.info(
      { tenantId: verified.principal.tenantId, contactId: verified.principal.contactId },
      'portal: contact signed in',
    );

    res.json({
      success: true,
      data: {
        contact: {
          email: verified.principal.email,
          displayName: verified.principal.displayName,
          organizationId: verified.principal.organizationId,
          locale: verified.principal.locale,
        },
        tenantSlug: verified.principal.tenantSlug,
        expiresAt: verified.expiresAt,
        // The ObliTools WebView2 shell cannot keep a cross-site cookie; it
        // returns this as `X-Auth-Token` and `authTokenBridge` folds it back
        // into the cookie the session middleware already understands.
        token: req.sessionID,
      },
    });
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req: Request, res: Response) => {
    await new Promise<void>((resolve) => {
      req.session.destroy(() => resolve());
    });
    res.json({ success: true, data: { signedOut: true } });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Everything below needs a portal session
// ═════════════════════════════════════════════════════════════════════════════

const guard = (req: Request, res: Response, next: NextFunction): void => {
  void portalService.requirePortalSession(req, res, next);
};

router.get(
  '/me',
  guard,
  asyncHandler(async (req: Request, res: Response) => {
    const principal = portalService.currentPrincipal(req);
    res.json({
      success: true,
      data: {
        email: principal.email,
        displayName: principal.displayName,
        organizationId: principal.organizationId,
        locale: principal.locale,
        tenantSlug: principal.tenantSlug,
        canAttach: await portalService.attachmentsAllowed(principal.tenantId),
      },
    });
  }),
);

function ticketIdOf(req: Request): number {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, 'Invalid ticket id');
  return id;
}

router.get(
  '/tickets',
  guard,
  portalLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const principal = portalService.currentPrincipal(req);
    const page = await portalService.listTickets(principal, {
      scope: req.query.scope === 'organization' ? 'organization' : 'mine',
      state:
        req.query.state === 'all' || req.query.state === 'closed'
          ? (req.query.state as 'all' | 'closed')
          : 'open',
      limit: Number.parseInt(String(req.query.limit ?? '25'), 10) || 25,
      offset: Number.parseInt(String(req.query.offset ?? '0'), 10) || 0,
    });

    res.json({ success: true, data: page.items, total: page.total });
  }),
);

router.post(
  '/tickets',
  guard,
  portalLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const principal = portalService.currentPrincipal(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const ticket = await portalService.createTicket(principal, {
      subject: String(body.subject ?? ''),
      bodyMd: String(body.bodyMd ?? body.description ?? ''),
      // HARD RULE 6 — the portal form asks WHEN IT HAPPENED. If it was not
      // asked for at intake it is gone for ever; it can never be backfilled.
      occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : null,
      attachmentIds: Array.isArray(body.attachmentIds)
        ? body.attachmentIds.map((id) => Number(id))
        : [],
    });

    res.status(201).json({ success: true, data: ticket });
  }),
);

router.get(
  '/tickets/:id',
  guard,
  asyncHandler(async (req: Request, res: Response) => {
    const principal = portalService.currentPrincipal(req);
    const ticket = await portalService.getTicket(principal, ticketIdOf(req));
    res.json({ success: true, data: ticket });
  }),
);

router.post(
  '/tickets/:id/reply',
  guard,
  portalLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const principal = portalService.currentPrincipal(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const result = await portalService.reply(principal, ticketIdOf(req), {
      bodyMd: String(body.bodyMd ?? body.body ?? ''),
      attachmentIds: Array.isArray(body.attachmentIds)
        ? body.attachmentIds.map((id) => Number(id))
        : [],
    });

    res.status(201).json({ success: true, data: result });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Attachments
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Memory storage with an explicit `fileSize`, exactly as the agent-side
 * uploader does: the service has to hash and magic-byte sniff the whole buffer
 * before deciding whether to keep it, and the limit is what makes holding it in
 * memory safe.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.attachmentMaxBytes, files: 5, fields: 8, fieldSize: 16 * 1024 },
});

function receiveFile(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    const code = (error as { code?: string }).code;
    if (code === 'LIMIT_FILE_SIZE') {
      next(
        new AppError(
          413,
          `Each file must be under ${Math.floor(LIMITS.attachmentMaxBytes / (1024 * 1024))} MB`,
        ),
      );
      return;
    }
    if (code === 'LIMIT_UNEXPECTED_FILE') {
      next(new AppError(400, 'Unexpected file field — use "file"'));
      return;
    }
    next(error);
  });
}

router.post(
  '/tickets/:id/attachments',
  guard,
  createLimiter({ windowMs: 15 * 60_000, max: 30 }),
  receiveFile,
  asyncHandler(async (req: Request, res: Response) => {
    const principal = portalService.currentPrincipal(req);
    const file = req.file;
    if (!file) throw new AppError(400, 'No file was uploaded');

    const stored = await portalService.uploadAttachment(principal, ticketIdOf(req), {
      originalname: file.originalname,
      buffer: file.buffer,
      mimetype: file.mimetype,
    });

    res.status(201).json({ success: true, data: stored });
  }),
);

/**
 * GET /api/portal/attachments/:id
 *
 * A separate route rather than opening the agent one to portal sessions. The
 * agent route's guard is `TICKET_READ` across the tenant; a requester must only
 * reach blobs hanging off a ticket they can see AND — for journal attachments —
 * off a PUBLIC entry, because a file on a work note is not visible just because
 * the ticket is. `assertAttachmentVisible` is that predicate, and the headers
 * below are copied verbatim from `openDownload` because they are the stored-XSS
 * defence, not decoration.
 */
router.get(
  '/attachments/:id',
  guard,
  asyncHandler(async (req: Request, res: Response) => {
    const principal = portalService.currentPrincipal(req);
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, 'Invalid attachment id');

    await portalService.assertAttachmentVisible(principal, id);

    const download = await attachmentService.openDownload(principal.tenantId, id);
    for (const [header, value] of Object.entries(download.headers)) res.setHeader(header, value);
    download.stream.pipe(res);
  }),
);

export default router;
