/**
 * ticket.controller.ts — HTTP in, HTTP out.
 *
 * The controller's whole job is to turn a request into an `ActorContext` plus a
 * validated payload, call a service, and shape the answer into the envelope:
 *
 *     success  { success: true, data: T }
 *     failure  { success: false, error: string }
 *
 * Two failures get a richer body, because the client can only do something
 * useful with the extra:
 *
 *   409 version_conflict   carries the CURRENT ticket, so the UI can show the
 *                          diff instead of "something went wrong" (HARD RULE 7);
 *   422 transition_refused carries the whole `TransitionEvaluation`, so the UI
 *                          can list what is missing rather than saying "no"
 *                          (HARD RULE 12).
 *
 * ── Why the request is read defensively ──────────────────────────────────────
 * `req.tenantId`, `req.session.capabilities` and friends are set by middleware
 * this module does not own. Reading them through narrow local casts, with a DB
 * fallback for capabilities, means the desk keeps working if that middleware
 * evolves — and fails with a clear 400 rather than a `TypeError` if it does not
 * run at all.
 */
import type { NextFunction, Request, Response } from 'express';
import { ROW_VERSION_HEADER } from '@oblidesk/shared';

import { db, scoped } from '../db';
import { AppError } from '../middleware/errorHandler';
import { resolveRequestCapabilities } from '../middleware/rbac';
import * as ticketService from '../services/ticket.service';
import * as journalService from '../services/journal.service';
import * as attachmentService from '../services/attachment.service';
import * as searchService from '../services/search.service';
import { type ActorContext } from '../services/ticket.service';
import {
  bulkApplySchema,
  bulkPreviewSchema,
  bulkUndoSchema,
  createJournalEntrySchema,
  createTicketLinkSchema,
  createTicketSchema,
  deleteTicketSchema,
  linkAttachmentSchema,
  listAttachmentsQuerySchema,
  listJournalQuerySchema,
  listTicketsQuerySchema,
  mergeTicketsSchema,
  reopenTicketSchema,
  revertMergeSchema,
  searchQuerySchema,
  splitTicketSchema,
  suggestQuerySchema,
  transitionSchema,
  updateTicketSchema,
  uploadAttachmentSchema,
  watcherSchema,
} from '../validators/ticket.validators';

// ═════════════════════════════════════════════════════════════════════════════
// Request context
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The tenant every query in this request will be scoped to (HARD RULE 1).
 *
 * `requireTenant` sets `req.tenantId`; a route that forgot it gets a clean 400
 * here rather than an `undefined` that `scoped()` would (correctly, but much
 * later) throw on.
 */
export function tenantOf(req: Request): number {
  const tenantId = req.tenantId;
  if (!tenantId || !Number.isInteger(tenantId) || tenantId <= 0) {
    throw new AppError(400, 'No tenant selected', { code: 'tenant_mismatch' });
  }
  return tenantId;
}

const GROUP_CACHE_TTL_MS = 30_000;
const groupCache = new Map<string, { ids: number[]; expiresAt: number }>();

/** Drop cached group membership — call when an assignment group changes. */
export function invalidateActorGroupCache(tenantId?: number, userId?: number): void {
  if (tenantId === undefined) {
    groupCache.clear();
    return;
  }
  if (userId !== undefined) {
    groupCache.delete(`${tenantId}:${userId}`);
    return;
  }
  for (const key of [...groupCache.keys()]) {
    if (key.startsWith(`${tenantId}:`)) groupCache.delete(key);
  }
}

/**
 * Which assignment groups the actor belongs to.
 *
 * Guards ask about this (`actor.group_ids`, the `@my_groups` token), so it has
 * to be on every transition evaluation — and a `member_user_ids @> …` lookup on
 * every keystroke of a queue filter would be absurd. Short TTL, because the
 * cost of a stale answer is a button that stays greyed for half a minute.
 */
async function assignmentGroupIdsFor(tenantId: number, userId: number): Promise<number[]> {
  const key = `${tenantId}:${userId}`;
  const hit = groupCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.ids;

  const ids = (await scoped('assignment_groups', tenantId, db)
    .whereRaw('? = ANY(assignment_groups.member_user_ids)', [userId])
    .pluck('assignment_groups.id')) as unknown as number[];

  groupCache.set(key, { ids, expiresAt: Date.now() + GROUP_CACHE_TTL_MS });
  return ids;
}

/**
 * Build the `ActorContext` the services and the transition evaluator take.
 *
 * Capabilities come from `resolveRequestCapabilities`, which memoises on the
 * request and already applies the transitive closure — deriving them again here
 * would be a second implementation of RBAC, and the two would disagree on the
 * day one of them was fixed.
 */
export async function actorOf(req: Request): Promise<ActorContext> {
  const tenantId = tenantOf(req);
  const userId = req.session?.userId;
  if (!userId) throw new AppError(401, 'Authentication required', { code: 'unauthenticated' });

  const capabilities = await resolveRequestCapabilities(req);

  return {
    userId,
    username: req.session.username ?? null,
    // The role INSIDE this tenant — an agent in tenant A must not inherit their
    // manager role from tenant B.
    role: req.tenantRole ?? req.session.role ?? 'agent',
    actorType: 'user',
    capabilities,
    assignmentGroupIds: await assignmentGroupIdsFor(tenantId, userId),
    isAdmin: req.isPlatformAdmin === true || req.isMasterAdmin === true || req.tenantRole === 'admin',
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Envelope helpers
// ═════════════════════════════════════════════════════════════════════════════

function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

/**
 * Forward every rejection to the error handler.
 *
 * The two failures that carry a body the client actually needs —
 * `TicketVersionConflictError` (409, `code: 'version_conflict'`, the CURRENT
 * row) and `TransitionRefusedError` (422, the whole evaluation) — are
 * `AppError` subclasses carrying their own `code` and `payload`, so the shared
 * `errorHandler` renders them. There is deliberately no special case here:
 * a handler cannot lose the conflict body by forgetting one.
 */
function handle(
  _res: Response,
  next: NextFunction,
  run: () => Promise<void>,
): Promise<void> {
  return run().catch((error: unknown) => {
    next(error);
  });
}

function intParam(req: Request, name: string): number {
  const value = Number(req.params[name]);
  if (!Number.isInteger(value) || value <= 0) throw new AppError(400, `Invalid ${name}`);
  return value;
}

// ═════════════════════════════════════════════════════════════════════════════
// Tickets
// ═════════════════════════════════════════════════════════════════════════════

export function listTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const query = listTicketsQuerySchema.parse(req.query);

    const page = await ticketService.list(tenantId, actor, query);

    res.json({
      success: true,
      data: page.items,
      // Keyset, not offset: the queue is a virtualised list of ~100k rows.
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      ...(page.total === undefined
        ? {}
        : { total: page.total, totalIsApproximate: page.totalIsApproximate }),
      // Clauses the compiler could not honour are reported, never swallowed.
      ...(page.unsupported.length > 0 ? { unsupportedFilters: page.unsupported } : {}),
      limit: query.limit ?? undefined,
    });
  });
}

export function searchTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const { q, limit } = searchQuerySchema.parse(req.query);
    ok(res, await ticketService.search(tenantId, actor, q, { limit }));
  });
}

export function suggestTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const { q, limit } = suggestQuerySchema.parse(req.query);
    ok(res, await searchService.suggestTickets(tenantId, q, limit));
  });
}

export function createTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const payload = createTicketSchema.parse(req.body);
    ok(res, await ticketService.create(tenantId, actor, payload), 201);
  });
}

export function getTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const ticketId = intParam(req, 'id');
    const ticket = await ticketService.getDetail(tenantId, ticketId);
    if (!ticket) throw new AppError(404, 'Ticket not found');
    ok(res, ticket);
  });
}

export function updateTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const ticketId = intParam(req, 'id');
    const payload = updateTicketSchema.parse(req.body);
    ok(res, await ticketService.update(tenantId, actor, ticketId, payload));
  });
}

export function deleteTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const ticketId = intParam(req, 'id');
    // The base version lives in the body or the X-Row-Version header; a delete
    // is a mutation like any other and races like one (HARD RULE 7).
    const raw =
      (req.body as { baseRowVersion?: unknown })?.baseRowVersion ??
      req.get(ROW_VERSION_HEADER) ??
      undefined;
    const { baseRowVersion } = deleteTicketSchema.parse({ baseRowVersion: raw });
    ok(res, await ticketService.softDelete(tenantId, actor, ticketId, baseRowVersion));
  });
}

export function restoreTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    ok(res, await ticketService.restore(tenantId, actor, intParam(req, 'id')));
  });
}

// ── Transitions ──────────────────────────────────────────────────────────────

export function getTransitions(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    ok(res, await ticketService.getAvailableTransitions(tenantId, actor, intParam(req, 'id')));
  });
}

export function transitionTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const ticketId = intParam(req, 'id');
    const payload = transitionSchema.parse(req.body);
    const result = await ticketService.transition(tenantId, actor, ticketId, payload);
    ok(res, { ticket: result.ticket, transition: result.decision });
  });
}

// ── Merge / split / reopen ───────────────────────────────────────────────────

export function mergeTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const payload = mergeTicketsSchema.parse(req.body);
    const result = await ticketService.merge(tenantId, actor, payload);
    ok(res, result);
  });
}

export function revertMerge(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const { manifestJournalId } = revertMergeSchema.parse(req.body);
    ok(res, await ticketService.revertMerge(tenantId, actor, manifestJournalId));
  });
}

export function splitTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const payload = splitTicketSchema.parse(req.body);
    ok(res, await ticketService.split(tenantId, actor, intParam(req, 'id'), payload), 201);
  });
}

export function reopenTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const payload = reopenTicketSchema.parse(req.body ?? {});
    ok(res, await ticketService.reopen(tenantId, actor, intParam(req, 'id'), payload));
  });
}

// ── Bulk ─────────────────────────────────────────────────────────────────────

export function bulkPreview(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    await actorOf(req);
    const { ticketIds, set } = bulkPreviewSchema.parse(req.body);
    ok(res, await ticketService.bulkPreview(tenantId, ticketIds, set));
  });
}

export function bulkApply(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const { ticketIds, baseRowVersions, set } = bulkApplySchema.parse(req.body);

    // Object keys are strings on the wire; the service keys by ticket id.
    const versions: Record<number, number> = {};
    for (const [key, value] of Object.entries(baseRowVersions)) versions[Number(key)] = value;

    ok(res, await ticketService.bulkApply(tenantId, actor, ticketIds, versions, set));
  });
}

export function bulkUndo(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const { undoToken } = bulkUndoSchema.parse(req.body);
    ok(res, await ticketService.bulkUndo(tenantId, actor, undoToken));
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Journal
// ═════════════════════════════════════════════════════════════════════════════

export function listJournal(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const ticketId = intParam(req, 'ticketId');
    const query = listJournalQuerySchema.parse(req.query);

    const page = await journalService.list(tenantId, ticketId, {
      limit: query.limit,
      afterSeq: query.afterSeq,
      beforeSeq: query.beforeSeq,
      direction: query.direction,
      visibility: query.visibility,
      kinds: query.kinds,
    });

    res.json({
      success: true,
      data: page.entries,
      hasMore: page.hasMore,
      nextSeq: page.nextSeq,
    });
  });
}

export function createJournalEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const ticketId = intParam(req, 'ticketId');
    const payload = createJournalEntrySchema.parse(req.body);
    ok(res, await ticketService.addJournalEntry(tenantId, actor, ticketId, payload), 201);
  });
}

export function getJournalEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const entry = await journalService.getById(tenantId, intParam(req, 'entryId'));
    if (!entry) throw new AppError(404, 'Journal entry not found');
    ok(res, entry);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Links and watchers
// ═════════════════════════════════════════════════════════════════════════════

export function listLinks(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    ok(res, await ticketService.listLinks(tenantOf(req), intParam(req, 'id')));
  });
}

export function createLink(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const payload = createTicketLinkSchema.parse(req.body);
    await ticketService.addLink(tenantId, actor, intParam(req, 'id'), payload);
    ok(res, await ticketService.listLinks(tenantId, intParam(req, 'id')), 201);
  });
}

export function deleteLink(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const removed = await ticketService.removeLink(tenantId, intParam(req, 'linkId'));
    if (removed === 0) throw new AppError(404, 'Link not found');
    ok(res, { removed });
  });
}

export function listWatchers(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    ok(res, await ticketService.listWatchers(tenantOf(req), intParam(req, 'id')));
  });
}

export function addWatcher(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const ticketId = intParam(req, 'id');
    const payload = watcherSchema.parse(req.body);
    await ticketService.addWatcher(tenantId, ticketId, payload);
    ok(res, await ticketService.listWatchers(tenantId, ticketId), 201);
  });
}

export function removeWatcher(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const ticketId = intParam(req, 'id');
    const payload = watcherSchema.parse(req.body ?? req.query);
    ok(res, { removed: await ticketService.removeWatcher(tenantId, ticketId, payload) });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Attachments
// ═════════════════════════════════════════════════════════════════════════════

/** What the service needs off a multer file — a subset of `Express.Multer.File`. */
interface UploadedFilePart {
  originalname: string;
  buffer: Buffer;
  size: number;
  mimetype: string;
}

/**
 * multer's typings put `files` on the request as a union (array or fieldname
 * map, depending on which middleware ran). `upload.array()` always produces the
 * array form, so narrow once here rather than at three call sites.
 */
function uploadedFiles(req: Request): UploadedFilePart[] {
  const carrier = req as unknown as {
    files?: UploadedFilePart[] | Record<string, UploadedFilePart[]>;
    file?: UploadedFilePart;
  };
  if (Array.isArray(carrier.files)) return carrier.files;
  if (carrier.files && typeof carrier.files === 'object') {
    return Object.values(carrier.files).flat();
  }
  return carrier.file ? [carrier.file] : [];
}

export function uploadAttachments(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const actor = await actorOf(req);
    const meta = uploadAttachmentSchema.parse(req.body ?? {});

    const files = uploadedFiles(req);
    if (files.length === 0) throw new AppError(400, 'No file uploaded');

    const link =
      meta.entityType && meta.entityId
        ? { entityType: meta.entityType, entityId: meta.entityId, inlineCid: meta.inlineCid }
        : null;

    const results = [];
    for (const file of files) {
      results.push(
        await attachmentService.uploadAttachment({
          tenantId,
          uploadedBy: actor.userId,
          file,
          link,
        }),
      );
    }
    ok(res, results, 201);
  });
}

export function listAttachments(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const target = listAttachmentsQuerySchema.parse(req.query);
    ok(res, await attachmentService.listForEntity(tenantId, target));
  });
}

export function linkAttachment(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const payload = linkAttachmentSchema.parse(req.body);
    await attachmentService.linkAttachment(tenantId, intParam(req, 'id'), payload);
    ok(res, { linked: true });
  });
}

export function unlinkAttachment(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const target = listAttachmentsQuerySchema.parse({ ...req.query, ...(req.body ?? {}) });
    ok(res, await attachmentService.unlinkAttachment(tenantId, intParam(req, 'id'), target));
  });
}

export function getAttachmentMeta(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const attachment = await attachmentService.getAttachment(tenantOf(req), intParam(req, 'id'));
    if (!attachment) throw new AppError(404, 'Attachment not found');
    ok(res, attachment);
  });
}

/**
 * Stream a blob to the browser.
 *
 * The headers come from the service and are set verbatim: every download is
 * `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff`, and
 * the `NEVER_INLINE_MIME` types have their Content-Type downgraded. There is no
 * `?inline=1` escape hatch, because the one session that must never render a
 * tenant-supplied SVG is the agent console (HARD RULE 9).
 */
export function downloadAttachment(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    const tenantId = tenantOf(req);
    const download = await attachmentService.openDownload(tenantId, intParam(req, 'id'));

    for (const [header, value] of Object.entries(download.headers)) res.setHeader(header, value);

    download.stream.on('error', (error: Error) => {
      if (!res.headersSent) next(error);
      else res.destroy(error);
    });
    download.stream.pipe(res);
  });
}

export function storageUsage(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(res, next, async () => {
    ok(res, await attachmentService.tenantUsage(tenantOf(req)));
  });
}
