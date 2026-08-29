/**
 * approvals.routes.ts — `/api/approvals`.
 *
 * ── Route table ─────────────────────────────────────────────────────────────
 *   GET    /?ticketId=&state=     every approval on one ticket, with its steps
 *   GET    /inbox                 what is waiting on ME, pending, soonest first
 *   GET    /definitions           the published approval definitions
 *   POST   /definitions/validate  dry-run the save gate without saving
 *   GET    /blocks?ticketId=&to=  the transition inspector's answer
 *   POST   /start                 start a definition on a ticket
 *   GET    /:id                   one approval
 *   POST   /:id/decide            approve / reject / delegate
 *   POST   /:id/cancel            withdraw a pending approval
 *
 * `/inbox`, `/definitions` and `/blocks` are declared BEFORE `/:id`. Express
 * matches in order, so the other way round would make `/api/approvals/inbox`
 * resolve as an approval whose id is the string "inbox".
 *
 * ── Authorisation ───────────────────────────────────────────────────────────
 * Reading is `ticket_read`. Starting and withdrawing are `ticket_rw`.
 *
 * DECIDING is not a capability at all, and that is deliberate: the right to
 * answer an approval comes from BEING the approver the definition named, and
 * nothing else. An admin capability that could approve on someone's behalf
 * would make the approval trail a record of who had access rather than of who
 * agreed — so `decide()` authorises against the step rows, and this router
 * only proves who is asking.
 *
 * MOUNTING: expects the app's auth middleware in front; `resolveActor` fails
 * closed with 401 if it is not there.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { CAPABILITIES, toStatusCategory, type ApprovalState } from '@oblidesk/shared';

import {
  buildApprovalLintContext,
  cancelApproval,
  decide,
  getApproval,
  inbox,
  listDefinitions,
  listForTicket,
  startApproval,
  transitionBlocks,
  validateApprovalDefinition,
} from '../services/approval.service';
import { AppError } from '../middleware/errorHandler';
import {
  handleServiceError,
  idParamSchema,
  requireCapability,
  resolveActor,
  sendFail,
  sendOk,
} from '../validators/config.validators';

const router = Router();

/**
 * One error translation for this router.
 *
 * `handleServiceError` knows the configuration slice's error classes but not
 * `AppError`, which is what `ApprovalServiceError` extends — so an un-adapted
 * 403 "this approval is not addressed to you" would surface as a 500 "something
 * went wrong". `AppError.payload` carries the blocking approvers on a 409, and
 * the client cannot render the block without it, so it is merged into the
 * envelope rather than dropped.
 */
function fail(res: Response, error: unknown): void {
  if (error instanceof AppError) {
    sendFail(res, error.statusCode, error.message, {
      ...(error.code ? { code: error.code } : {}),
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      ...(error.payload ?? {}),
    });
    return;
  }
  handleServiceError(res, error);
}

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((error: unknown) => fail(res, error));
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Schemas
// ═════════════════════════════════════════════════════════════════════════════

const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const;

const listQuerySchema = z.object({
  ticketId: z.coerce.number().int().positive(),
  state: z.enum(APPROVAL_STATES).optional(),
});

const inboxQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const blocksQuerySchema = z.object({
  ticketId: z.coerce.number().int().positive(),
  /** The status the agent is trying to move to. */
  to: z.string().min(1).max(128).optional(),
  toCategory: z.string().min(1).max(24).optional(),
});

const startSchema = z.object({
  ticketId: z.number().int().positive(),
  /** HARD RULE 3 — the definition by slug, never by id. */
  definitionSlug: z.string().min(1).max(128),
  /** Skip `requiredWhen` — a human explicitly asking for an approval. */
  force: z.boolean().optional(),
});

/**
 * `decision` is required even when delegating, so the payload is never
 * ambiguous — the service treats a present `delegateToUserId` as a delegation
 * and ignores the decision, and the comment rides along either way.
 */
const decideSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().max(4000).optional(),
  delegateToUserId: z.number().int().positive().optional(),
});

const cancelSchema = z.object({
  reason: z.string().min(1).max(200).default('withdrawn'),
});

const validateSchema = z.object({
  body: z.record(z.unknown()),
});

// ═════════════════════════════════════════════════════════════════════════════
// Collection
// ═════════════════════════════════════════════════════════════════════════════

/** Every approval on one ticket, newest first, each with its step rows. */
router.get('/', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.TICKET_READ);

  const query = listQuerySchema.parse(req.query);
  const rows = await listForTicket(actor.tenantId, query.ticketId, {
    state: query.state as ApprovalState | undefined,
  });
  sendOk(res, rows);
}));

// ═════════════════════════════════════════════════════════════════════════════
// Fixed paths — declared before /:id so they are never read as an id
// ═════════════════════════════════════════════════════════════════════════════

/**
 * My inbox.
 *
 * Scoped to the session's own user id, never to a `userId` query parameter: an
 * inbox endpoint that accepts whose inbox to read is an endpoint that leaks
 * one person's pending decisions to another.
 */
router.get('/inbox', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.TICKET_READ);

  if (actor.userId === null) {
    sendFail(res, 401, 'Authentication required.', { code: 'unauthenticated' });
    return;
  }

  const query = inboxQuerySchema.parse(req.query);
  const page = await inbox(actor.tenantId, actor.userId, {
    page: query.page,
    limit: query.limit,
  });

  res.status(200).json({
    success: true,
    data: page.rows,
    total: page.total,
    page: page.page,
    limit: page.limit,
  });
}));

/** The published approval definitions, normalised — what the editor lists. */
router.get('/definitions', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.TICKET_READ);
  sendOk(res, await listDefinitions(actor.tenantId));
}));

/**
 * Dry-run the save gate.
 *
 * The editor calls this on every keystroke pause so an author sees "step 2
 * resolves to zero reachable approvers" while they are still looking at step 2,
 * rather than discovering it at publish time. Same function the publish gate
 * runs, so the two can never disagree.
 */
router.post('/definitions/validate', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.CONFIG_ADMIN);

  const input = validateSchema.parse(req.body);
  const ctx = await buildApprovalLintContext(actor.tenantId);
  const findings = validateApprovalDefinition(input.body, ctx);

  sendOk(res, {
    savable: findings.every((finding) => finding.severity !== 'error'),
    findings,
  });
}));

/**
 * The transition inspector's question: "may this ticket move to <to>, and if
 * not, who is it waiting on?"
 *
 * Returns an ARRAY, empty when nothing blocks. Each entry names the approvers,
 * because "Forbidden" is exactly what an agent cannot act on.
 */
router.get('/blocks', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.TICKET_READ);

  const query = blocksQuerySchema.parse(req.query);
  const blocks = await transitionBlocks(
    actor.tenantId,
    query.ticketId,
    query.to ?? null,
    query.toCategory ? toStatusCategory(query.toCategory, 'open') : null,
  );
  sendOk(res, blocks);
}));

/**
 * Start an approval on a ticket.
 *
 * Refuses with 422 when the definition's first stage resolves to nobody — see
 * `startApproval()`. That refusal is the point: a ticket blocked by an approval
 * nobody was asked to make is the failure the whole module exists to prevent,
 * and it is far cheaper to surface here than three weeks later.
 */
router.post('/start', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.TICKET_RW);

  const input = startSchema.parse(req.body);
  const result = await startApproval({
    tenantId: actor.tenantId,
    ticketId: input.ticketId,
    definitionSlug: input.definitionSlug,
    actorId: actor.userId,
    actorType: 'user',
    force: input.force,
  });

  if (!result.started && result.approval === null) {
    sendFail(res, 409, `L’approbation n’a pas démarré : ${result.reason}.`, {
      code: 'conflict',
      reason: result.reason,
    });
    return;
  }
  sendOk(res, result, result.started ? 201 : 200);
}));

// ═════════════════════════════════════════════════════════════════════════════
// One approval
// ═════════════════════════════════════════════════════════════════════════════

router.get('/:id', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.TICKET_READ);

  const id = idParamSchema.parse(req.params.id);
  const approval = await getApproval(actor.tenantId, id);
  if (!approval) {
    sendFail(res, 404, `Aucune approbation n° ${id}.`, { code: 'not_found' });
    return;
  }
  sendOk(res, approval);
}));

/**
 * Approve, reject, or delegate.
 *
 * No capability check. The service authorises against the step rows: you may
 * answer a step addressed to you, or one addressed to a group you belong to,
 * and only in the stage that is currently being asked. Anything else is a 403
 * that says which of the two it is — "you already answered" and "this is not
 * addressed to you" send the reader to different places.
 */
router.post('/:id/decide', wrap(async (req, res) => {
  const actor = await resolveActor(req);

  if (actor.userId === null) {
    sendFail(res, 401, 'Authentication required.', { code: 'unauthenticated' });
    return;
  }

  const id = idParamSchema.parse(req.params.id);
  const input = decideSchema.parse(req.body);

  const result = await decide({
    tenantId: actor.tenantId,
    approvalId: id,
    userId: actor.userId,
    decision: input.decision,
    comment: input.comment ?? null,
    delegateToUserId: input.delegateToUserId ?? null,
  });

  sendOk(res, result);
}));

/**
 * Withdraw a pending approval.
 *
 * `ticket_rw` rather than an admin capability: the person who raised the
 * request is usually the person who realises it is no longer needed, and making
 * them find an admin to withdraw it is how stale approvals accumulate. It is a
 * cancellation, never a decision — the step rows are cancelled, not approved,
 * so the trail says nobody agreed to anything.
 */
router.post('/:id/cancel', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.TICKET_RW);

  const id = idParamSchema.parse(req.params.id);
  const input = cancelSchema.parse(req.body ?? {});

  sendOk(res, await cancelApproval(actor.tenantId, id, input.reason, { actorId: actor.userId }));
}));

export { router as approvalsRouter };
export default router;

// TODO(routes/index.ts): mount in the TENANT tier, next to /tickets:
//     import approvalsRoutes from './approvals.routes';
//     tenantRouter.use('/approvals', approvalsRoutes);
