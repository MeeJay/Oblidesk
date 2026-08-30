/**
 * problems.routes.ts — `/api/problems`, the problem record and everything
 * hanging off it: linked incidents, root-cause analyses, known errors, alert
 * signatures, the detector's candidate cards and the closure cascade.
 *
 * MOUNT POINT: `/api/problems`, inside the TENANT tier of `routes/index.ts`, so
 * `requireAuth` + `requireTenant` have already run by the time any handler here
 * executes and `req.tenantId` is resolved. Each route additionally names the
 * capability it needs, so the guard is readable next to the route rather than
 * inherited from a mount three files away.
 *
 * ── Route ordering is load-bearing ──────────────────────────────────────────
 * Express matches in declaration order, so every literal path
 * (`/promote`, `/known-errors/suggest`, `/candidates…`) is declared BEFORE
 * `/:ticketId`. The other way round, `GET /api/problems/candidates` resolves as
 * "the problem whose ticket id is the string 'candidates'" and fails as a 400
 * that reads like a client bug for as long as it takes somebody to read this
 * file.
 *
 * ── Route table ─────────────────────────────────────────────────────────────
 *   GET    /                                       the problem board       ticket_read
 *   POST   /promote                                incident -> problem     problem_rw
 *   GET    /known-errors/suggest                   the intake banner       ticket_read
 *   POST   /candidates/run                         one detection pass      automation_admin
 *   GET    /candidates                             the review board        ticket_read
 *   GET    /candidates/:candidateId                one card + its tickets  ticket_read
 *   POST   /candidates/:candidateId/accept         card -> problem         problem_rw
 *   POST   /candidates/:candidateId/reject         card -> headstone       problem_rw
 *   GET    /:ticketId                              one problem, hydrated   ticket_read
 *   PATCH  /:ticketId                              inline autosave         problem_rw
 *   GET    /:ticketId/incidents                    cascade-relevant facts  ticket_read
 *   POST   /:ticketId/incidents                    link                    problem_rw
 *   DELETE /:ticketId/incidents                    unlink                  problem_rw
 *   POST   /:ticketId/workaround/verify            stamp the replay        problem_rw
 *   POST   /:ticketId/known-error/publish          offer it at intake      problem_rw
 *   POST   /:ticketId/known-error/retire           stop offering it        problem_rw
 *   POST   /:ticketId/known-error/kb               seed a KB article       problem_rw + kb_publish
 *   GET    /:ticketId/signatures                   curated alert keys      ticket_read
 *   POST   /:ticketId/signatures                   bind a key              problem_rw
 *   DELETE /:ticketId/signatures/:signatureId      unbind                  problem_rw
 *   GET    /:ticketId/analyses                     newest first            ticket_read
 *   POST   /:ticketId/analyses                     supersede + start       problem_rw
 *   PATCH  /:ticketId/analyses/:analysisId         autosave                problem_rw
 *   POST   /:ticketId/analyses/:analysisId/state   THE completeness gate   problem_rw
 *   POST   /:ticketId/analyses/:analysisId/causes  add a why               problem_rw
 *   PATCH  /:ticketId/causes/:causeId              autosave                problem_rw
 *   DELETE /:ticketId/causes/:causeId              drop a subtree          problem_rw
 *   POST   /:ticketId/causes/:causeId/confirm      put a name to a claim   problem_rw
 *   POST   /:ticketId/causes/:causeId/evidence     attach proof            problem_rw
 *   DELETE /:ticketId/causes/:causeId/evidence/:evidenceId                 problem_rw
 *   GET    /:ticketId/cascade                      dry run, logs nothing   ticket_read
 *   POST   /:ticketId/cascade                      resolve the wave        problem_rw
 *
 * ── Capabilities ────────────────────────────────────────────────────────────
 * Reading rides on `ticket_read`, deliberately: an agent who can see a ticket
 * can see the problem behind it and the known error that explains it, and
 * inventing a `problem_read` would have silently switched the intake banner off
 * for every existing permission set on the day this shipped.
 *
 * Writing is `problem_rw`, which is NOT `ticket_rw`. Every agent holds
 * `ticket_rw`; the closure cascade resolves other people's tickets in bulk from
 * one click, and gating that on the same key as "add a work note" is not a
 * permission model. The desk already draws this line for `kb_rw` vs
 * `kb_publish`.
 *
 * Running the detector by hand is `automation_admin`, next to the other
 * automation definitions, and it does not imply `problem_rw` — kicking a pass
 * proposes cards, it never accepts one.
 *
 * ── Response envelope ───────────────────────────────────────────────────────
 * `{ success: true, data }` / `{ success: false, error }`, exactly as the rest
 * of the API. The two list endpoints that page add `total`, `page` and `limit`
 * beside `data`.
 *
 * ── Errors are not translated here ──────────────────────────────────────────
 * There is deliberately no 409 or 422 special case in this file. The services
 * throw `AppError` subclasses carrying their own `code` and `payload` — a
 * stale `problems.row_version` becomes `code: 'version_conflict'` with the
 * CURRENT problem in the body (HARD RULE 7), a refused analysis transition or a
 * refused known-error publication becomes `code: 'transition_blocked'` with the
 * `blockers` the UI lists — and `errorHandler` renders both. A handler cannot
 * lose the conflict body by forgetting one.
 */
import { Router, type Request } from 'express';
import { CAPABILITIES } from '@oblidesk/shared';

import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireAllCapabilities, requireCapability } from '../middleware/rbac';
import { notFound, versionConflict } from '../middleware/errorHandler';
import { asyncHandler } from '../utils/asyncHandler';
import * as problemService from '../services/problem.service';
import * as problemDetectionService from '../services/problemDetection.service';
// The one place a session becomes an `ActorContext`. Building a second one here
// would be a second implementation of RBAC, and the two would disagree on the
// day one of them was fixed — the gate evaluators read `actor.capabilities`, so
// a divergence would be a privilege bug rather than a style problem.
import { actorOf } from '../controllers/ticket.controller';
import {
  acceptProblemCandidateSchema,
  addAlertSignatureSchema,
  addProblemCauseEvidenceSchema,
  analysisParamsSchema,
  candidateParamsSchema,
  cascadePreviewQuerySchema,
  causeEvidenceParamsSchema,
  causeParamsSchema,
  changeProblemAnalysisStateSchema,
  confirmProblemCauseSchema,
  createProblemAnalysisSchema,
  createProblemCauseSchema,
  linkIncidentsSchema,
  listCandidatesQuerySchema,
  listLinkedIncidentsQuerySchema,
  listProblemsQuerySchema,
  parseOrThrow,
  problemCascadeSchema,
  problemParamsSchema,
  promoteIncidentSchema,
  publishKnownErrorSchema,
  publishKnownErrorToKbSchema,
  rejectProblemCandidateSchema,
  retireKnownErrorSchema,
  runDetectionSchema,
  signatureParamsSchema,
  suggestKnownErrorsQuerySchema,
  unlinkIncidentsSchema,
  updateProblemAnalysisSchema,
  updateProblemCauseSchema,
  updateProblemSchema,
  verifyWorkaroundSchema,
} from '../validators/problem.validators';

const router = Router();

// Belt and braces. The tenant tier already applies both, and a router that is
// ever mounted somewhere else must not silently become anonymous.
router.use(requireAuth);
router.use(requireTenant);

const read = requireCapability(CAPABILITIES.TICKET_READ);
const write = requireCapability(CAPABILITIES.PROBLEM_RW);
const runDetection = requireCapability(CAPABILITIES.AUTOMATION_ADMIN);
/** Seeding a public article is a publication, so it needs the publishing key too. */
const publishToKb = requireAllCapabilities(CAPABILITIES.PROBLEM_RW, CAPABILITIES.KB_PUBLISH);

/**
 * Prove the caller is acting on the problem they actually read (HARD RULE 7).
 *
 * Every other mutation in this router carries its `baseRowVersion` INTO the
 * service, which applies it as `WHERE row_version = :base` in the same UPDATE
 * that makes the change and throws the 409 itself. The cascade cannot: its
 * service entry point is also called from inside `ticket.service`'s transition
 * transaction by `onProblemResolved`, where there is no client-read version to
 * compare against, so the signature has nowhere to put one.
 *
 * The HTTP door is a different door. A human clicking "resolve every incident
 * under this problem" must not act on a record that changed under them — the
 * closure policy they are confirming is a field on that record. So the gate is
 * here, and it answers in exactly the shape `ProblemConflict` describes:
 * `code: 'version_conflict'` with the current problem in the body.
 */
async function requireProblemAt(req: Request, ticketId: number, baseRowVersion: number) {
  const current = await problemService.get(req.tenantId, ticketId);
  if (!current) throw notFound('Problem not found');
  if (current.rowVersion !== baseRowVersion) {
    throw versionConflict(current, ['rowVersion'], 'This problem changed while you were reading it');
  }
  return current;
}

// ═════════════════════════════════════════════════════════════════════════════
// The board, and the two ways a problem comes into existence
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/problems — the problem board.
 *
 * Offset paged rather than keyset, unlike the ticket queue: a problem board is
 * tens of rows a human reads top to bottom, not a virtualised list of a hundred
 * thousand, and paging it the same way would cost a cursor nobody scrolls.
 */
router.get(
  '/',
  read,
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listProblemsQuerySchema, req.query);

    const page = await problemService.list(req.tenantId, query);

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
 * POST /api/problems/promote — an incident becomes the first evidence of a
 * problem.
 *
 * Literal path, so it precedes `/:ticketId`. The service creates a NEW ticket
 * with `record_type = 'problem'` and links the incident `caused_by`; it never
 * flips the incident's record type, and the incident keeps its state, its
 * assignee and its SLA clock. Somebody is still waiting on that outage whether
 * or not the desk has decided to investigate the cause.
 */
router.post(
  '/promote',
  write,
  asyncHandler(async (req, res) => {
    const body = parseOrThrow(promoteIncidentSchema, req.body ?? {});
    const actor = await actorOf(req);

    const problem = await problemService.promote(req.tenantId, actor, body);
    res.status(201).json({ success: true, data: problem });
  }),
);

/**
 * GET /api/problems/known-errors/suggest — what intake asks before opening a
 * ticket nobody needed to open.
 *
 * Literal path, declared before `/:ticketId`. Read-only and cheap enough to sit
 * behind a keystroke: the three weapons are a CI match, an alert dedupe key and
 * free text, in decreasing certainty, and the caller renders them in that order.
 */
router.get(
  '/known-errors/suggest',
  read,
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(suggestKnownErrorsQuerySchema, req.query);

    const suggestions = await problemService.suggestKnownErrors(req.tenantId, query);
    res.json({ success: true, data: suggestions });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Detection candidates — literal paths, all before `/:ticketId`
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/problems/candidates/run — kick one detection pass by hand.
 *
 * Declared before `/candidates/:candidateId` so "run" is never read as an id.
 * `automation_admin`, not `problem_rw`: a pass PROPOSES cards and accepts none,
 * so the key that gates it is the one that gates the other automation
 * definitions, and the key that gates acting on a card is separate.
 */
router.post(
  '/candidates/run',
  runDetection,
  asyncHandler(async (req, res) => {
    const { dryRun } = parseOrThrow(runDetectionSchema, req.body ?? {});

    const outcome = await problemDetectionService.runForTenant(req.tenantId, { dryRun });
    res.json({ success: true, data: outcome });
  }),
);

/** GET /api/problems/candidates — the review board, highest score first. */
router.get(
  '/candidates',
  read,
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listCandidatesQuerySchema, req.query);

    const page = await problemDetectionService.listCandidates(req.tenantId, query);
    res.json({ success: true, data: page.items, total: page.total });
  }),
);

/** GET /api/problems/candidates/:candidateId — the card, its tickets, its ancestor. */
router.get(
  '/candidates/:candidateId',
  read,
  asyncHandler(async (req, res) => {
    const { candidateId } = parseOrThrow(candidateParamsSchema, req.params);

    const candidate = await problemDetectionService.getCandidate(req.tenantId, candidateId);
    if (!candidate) throw notFound('Problem candidate not found');

    res.json({ success: true, data: candidate });
  }),
);

/**
 * POST /api/problems/candidates/:candidateId/accept — the card becomes a
 * problem, and every incident the detector grouped is linked to it.
 */
router.post(
  '/candidates/:candidateId/accept',
  write,
  asyncHandler(async (req, res) => {
    const { candidateId } = parseOrThrow(candidateParamsSchema, req.params);
    const body = parseOrThrow(acceptProblemCandidateSchema, req.body ?? {});
    const actor = await actorOf(req);

    const problem = await problemDetectionService.acceptCandidate(
      req.tenantId,
      actor,
      candidateId,
      body,
    );
    res.status(201).json({ success: true, data: problem });
  }),
);

/**
 * POST /api/problems/candidates/:candidateId/reject — the card becomes a
 * headstone.
 *
 * The row is never deleted: it is what the detector consults before proposing
 * that signature again, and what the escalation banner quotes back when the
 * pattern returns worse than it was refused.
 */
router.post(
  '/candidates/:candidateId/reject',
  write,
  asyncHandler(async (req, res) => {
    const { candidateId } = parseOrThrow(candidateParamsSchema, req.params);
    const body = parseOrThrow(rejectProblemCandidateSchema, req.body ?? {});
    const actor = await actorOf(req);

    const candidate = await problemDetectionService.rejectCandidate(
      req.tenantId,
      actor,
      candidateId,
      body,
    );
    res.json({ success: true, data: candidate });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// One problem
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/problems/:ticketId — the record, its ticket header, its current analysis. */
router.get(
  '/:ticketId',
  read,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);

    const problem = await problemService.get(req.tenantId, ticketId);
    if (!problem) throw notFound('Problem not found');

    res.json({ success: true, data: problem });
  }),
);

/**
 * PATCH /api/problems/:ticketId — inline autosave, one field at a time.
 *
 * Validates nothing beyond shape (HARD RULE 12): a workaround with no risk
 * rating saves happily and simply cannot be published, and the refusal comes
 * from the shared evaluator at the publish gate, not from a half-written form.
 *
 * `baseRowVersion` is `problems.row_version`, NOT the ticket's. The two are
 * separate concurrency domains on purpose, so the RCA workshop does not 409 the
 * team lead editing the ticket header at the same moment.
 */
router.patch(
  '/:ticketId',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);
    const body = parseOrThrow(updateProblemSchema, req.body ?? {});
    const actor = await actorOf(req);

    const problem = await problemService.update(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: problem });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// The incidents under the problem
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/problems/:ticketId/incidents — the linked incidents WITH the facts
 * the cascade classifies on.
 *
 * Not a plain ticket list: what the panel has to show is why each incident will
 * or will not be resolved when the problem is, and that is first response,
 * who spoke last, open approvals and scheduling — the `CascadeIncidentSnapshot`
 * shape the shared planner reads.
 */
router.get(
  '/:ticketId/incidents',
  read,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);
    const query = parseOrThrow(listLinkedIncidentsQuerySchema, req.query);

    const incidents = await problemService.listLinkedIncidents(req.tenantId, ticketId, query);
    res.json({ success: true, data: incidents });
  }),
);

/**
 * POST /api/problems/:ticketId/incidents — link.
 *
 * The answer names what was linked AND what was skipped with a reason, because
 * a batch that silently drops six of forty ids is a batch nobody can trust.
 */
router.post(
  '/:ticketId/incidents',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);
    const body = parseOrThrow(linkIncidentsSchema, req.body ?? {});
    const actor = await actorOf(req);

    const result = await problemService.linkIncidents(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: result });
  }),
);

/**
 * DELETE /api/problems/:ticketId/incidents — unlink.
 *
 * The ids travel in the body rather than the path: unlinking is a batch, and a
 * batch of forty ids in a query string is a URL length limit waiting to be
 * discovered in production.
 */
router.delete(
  '/:ticketId/incidents',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);
    const body = parseOrThrow(unlinkIncidentsSchema, req.body ?? {});
    const actor = await actorOf(req);

    const result = await problemService.unlinkIncidents(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: result });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Workaround and known error
// ═════════════════════════════════════════════════════════════════════════════

/** POST /api/problems/:ticketId/workaround/verify — somebody replayed it and it worked. */
router.post(
  '/:ticketId/workaround/verify',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);
    const body = parseOrThrow(verifyWorkaroundSchema, req.body ?? {});
    const actor = await actorOf(req);

    const problem = await problemService.verifyWorkaround(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: problem });
  }),
);

/**
 * POST /api/problems/:ticketId/known-error/publish — start offering it at intake.
 *
 * 422 `transition_blocked` with the `blockers` when the shared evaluator says
 * no. The client runs the same evaluator to grey the button out and list what
 * is missing, so this refusal is the safety net rather than the first the user
 * hears of it.
 */
router.post(
  '/:ticketId/known-error/publish',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);
    const body = parseOrThrow(publishKnownErrorSchema, req.body ?? {});
    const actor = await actorOf(req);

    const problem = await problemService.publishKnownError(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: problem });
  }),
);

/**
 * POST /api/problems/:ticketId/known-error/retire — stop offering it.
 *
 * Retiring hides it from intake and from new alerts. It does NOT erase the
 * workaround: incidents closed months ago quote it in their timeline, and a
 * ticket whose explanation has gone blank is a ticket nobody can audit.
 */
router.post(
  '/:ticketId/known-error/retire',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);
    const body = parseOrThrow(retireKnownErrorSchema, req.body ?? {});
    const actor = await actorOf(req);

    const problem = await problemService.retireKnownError(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: problem });
  }),
);

/**
 * POST /api/problems/:ticketId/known-error/kb — seed a KB article from the
 * known error.
 *
 * `problem_rw` AND `kb_publish`, because this is two acts at once. The article
 * is CREATED from the problem and then lives independently: there is no
 * synchronisation afterwards, in either direction, ever. An internal workaround
 * naming a host and an admin console, kept in step with a public page, is a
 * data leak on a schedule.
 */
router.post(
  '/:ticketId/known-error/kb',
  publishToKb,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);
    const body = parseOrThrow(publishKnownErrorToKbSchema, req.body ?? {});
    const actor = await actorOf(req);

    const result = await problemService.publishToKb(req.tenantId, actor, ticketId, body);
    res.status(201).json({ success: true, data: result });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Alert signatures
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/problems/:ticketId/signatures — the keys an engineer declared equivalent. */
router.get(
  '/:ticketId/signatures',
  read,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);

    const signatures = await problemService.listAlertSignatures(req.tenantId, ticketId);
    res.json({ success: true, data: signatures });
  }),
);

/**
 * POST /api/problems/:ticketId/signatures — bind an alert key to this problem.
 *
 * This is the curated bond the alert ingest consults AFTER dedupe, so the next
 * outage arrives already carrying its workaround.
 */
router.post(
  '/:ticketId/signatures',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);
    const body = parseOrThrow(addAlertSignatureSchema, req.body ?? {});
    const actor = await actorOf(req);

    const signature = await problemService.addAlertSignature(req.tenantId, actor, ticketId, body);
    res.status(201).json({ success: true, data: signature });
  }),
);

/** DELETE /api/problems/:ticketId/signatures/:signatureId — unbind. */
router.delete(
  '/:ticketId/signatures/:signatureId',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId, signatureId } = parseOrThrow(signatureParamsSchema, req.params);
    // The path names a problem; the child id must actually hang under it.
    await problemService.assertChildOfProblem(req.tenantId, ticketId, { signatureId });
    const actor = await actorOf(req);

    const removed = await problemService.removeAlertSignature(req.tenantId, actor, signatureId);
    res.json({ success: true, data: { removed } });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Analyses
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/problems/:ticketId/analyses — newest first, superseded included.
 *
 * A superseded analysis is returned exactly as it was concluded. The second
 * investigation is not a correction of the first; it is a second investigation,
 * and the first is what the review meeting has to be able to read back.
 */
router.get(
  '/:ticketId/analyses',
  read,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);

    const analyses = await problemService.listAnalyses(req.tenantId, ticketId);
    res.json({ success: true, data: analyses });
  }),
);

/**
 * POST /api/problems/:ticketId/analyses — start one, superseding the current.
 *
 * There is at most one current analysis per problem and the partial unique
 * index enforces it; the previous one is flipped to `superseded` in the same
 * transaction rather than edited in place.
 */
router.post(
  '/:ticketId/analyses',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);
    const body = parseOrThrow(createProblemAnalysisSchema, req.body ?? {});
    const actor = await actorOf(req);

    const analysis = await problemService.createAnalysis(req.tenantId, actor, ticketId, body);
    res.status(201).json({ success: true, data: analysis });
  }),
);

/** PATCH /api/problems/:ticketId/analyses/:analysisId — autosave. Validates nothing. */
router.patch(
  '/:ticketId/analyses/:analysisId',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId, analysisId } = parseOrThrow(analysisParamsSchema, req.params);
    // The path names a problem; the child id must actually hang under it.
    await problemService.assertChildOfProblem(req.tenantId, ticketId, { analysisId });
    const body = parseOrThrow(updateProblemAnalysisSchema, req.body ?? {});
    const actor = await actorOf(req);

    const analysis = await problemService.updateAnalysis(req.tenantId, actor, analysisId, body);
    res.json({ success: true, data: analysis });
  }),
);

/**
 * POST /api/problems/:ticketId/analyses/:analysisId/state — THE completeness
 * gate of this module.
 *
 * Everything else in the RCA workshop saves whatever it is given. This is the
 * one door that asks whether the work is finished, and it asks
 * `evaluateAnalysisTransition` — the same function the client ran to decide
 * whether to enable the button. 422 with `blockers` when it says no, so the
 * dialog can name the three causes still lacking evidence instead of refusing
 * flatly.
 */
router.post(
  '/:ticketId/analyses/:analysisId/state',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId, analysisId } = parseOrThrow(analysisParamsSchema, req.params);
    // The path names a problem; the child id must actually hang under it.
    await problemService.assertChildOfProblem(req.tenantId, ticketId, { analysisId });
    const body = parseOrThrow(changeProblemAnalysisStateSchema, req.body ?? {});
    const actor = await actorOf(req);

    const analysis = await problemService.changeAnalysisState(req.tenantId, actor, analysisId, body);
    res.json({ success: true, data: analysis });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Causes
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/problems/:ticketId/analyses/:analysisId/causes — add a why.
 *
 * The depth is derived from the parent server-side; a client that could name
 * its own depth could build a tree whose depths disagree with its edges.
 */
router.post(
  '/:ticketId/analyses/:analysisId/causes',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId, analysisId } = parseOrThrow(analysisParamsSchema, req.params);
    // The path names a problem; the child id must actually hang under it.
    await problemService.assertChildOfProblem(req.tenantId, ticketId, { analysisId });
    const body = parseOrThrow(createProblemCauseSchema, req.body ?? {});
    const actor = await actorOf(req);

    const cause = await problemService.createCause(req.tenantId, actor, analysisId, body);
    res.status(201).json({ success: true, data: cause });
  }),
);

/** PATCH /api/problems/:ticketId/causes/:causeId — autosave, re-parenting included. */
router.patch(
  '/:ticketId/causes/:causeId',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId, causeId } = parseOrThrow(causeParamsSchema, req.params);
    // The path names a problem; the child id must actually hang under it.
    await problemService.assertChildOfProblem(req.tenantId, ticketId, { causeId });
    const body = parseOrThrow(updateProblemCauseSchema, req.body ?? {});
    const actor = await actorOf(req);

    const cause = await problemService.updateCause(req.tenantId, actor, causeId, body);
    res.json({ success: true, data: cause });
  }),
);

/**
 * DELETE /api/problems/:ticketId/causes/:causeId — drop the node and its subtree.
 *
 * Refused when the node is the elected root cause of a CONCLUDED analysis:
 * there is no foreign key doing that, on purpose, so the service says no in
 * words rather than the database saying no as a check violation.
 */
router.delete(
  '/:ticketId/causes/:causeId',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId, causeId } = parseOrThrow(causeParamsSchema, req.params);
    // The path names a problem; the child id must actually hang under it.
    await problemService.assertChildOfProblem(req.tenantId, ticketId, { causeId });
    const actor = await actorOf(req);

    const removed = await problemService.deleteCause(req.tenantId, actor, causeId);
    res.json({ success: true, data: { removed } });
  }),
);

/**
 * POST /api/problems/:ticketId/causes/:causeId/confirm — put a name to a claim.
 *
 * `confirmedBy` is the session's user and is never on the wire. 422 with
 * `blockers` when `evaluateCauseConfirmation` refuses, which it does for a
 * confirmation with no method or no evidence, and for an automation actor
 * always: a machine may raise a suspicion, it may not settle one.
 */
router.post(
  '/:ticketId/causes/:causeId/confirm',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId, causeId } = parseOrThrow(causeParamsSchema, req.params);
    // The path names a problem; the child id must actually hang under it.
    await problemService.assertChildOfProblem(req.tenantId, ticketId, { causeId });
    const body = parseOrThrow(confirmProblemCauseSchema, req.body ?? {});
    const actor = await actorOf(req);

    const cause = await problemService.confirmCause(req.tenantId, actor, causeId, body);
    res.json({ success: true, data: cause });
  }),
);

/**
 * POST /api/problems/:ticketId/causes/:causeId/evidence — attach proof.
 *
 * Exactly one target, and a screenshot is not one of them: an image is an
 * `attachment_links` row with `entity_type = 'problem_cause'` (HARD RULE 9), so
 * the blob stays refcounted and dies with its last link.
 */
router.post(
  '/:ticketId/causes/:causeId/evidence',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId, causeId } = parseOrThrow(causeParamsSchema, req.params);
    // The path names a problem; the child id must actually hang under it.
    await problemService.assertChildOfProblem(req.tenantId, ticketId, { causeId });
    const body = parseOrThrow(addProblemCauseEvidenceSchema, req.body ?? {});
    const actor = await actorOf(req);

    const evidence = await problemService.addCauseEvidence(req.tenantId, actor, causeId, body);
    res.status(201).json({ success: true, data: evidence });
  }),
);

/**
 * DELETE /api/problems/:ticketId/causes/:causeId/evidence/:evidenceId.
 *
 * Refused when it is the last evidence of a confirmed cause. Silently demoting
 * the confidence instead would rewrite a conclusion as a side effect of
 * tidying, so the service asks the caller to demote it first and mean it.
 *
 * The cause id in the path is there so the URL says what it acts on; the
 * evidence row is resolved by the service inside the tenant.
 */
router.delete(
  '/:ticketId/causes/:causeId/evidence/:evidenceId',
  write,
  asyncHandler(async (req, res) => {
    const { evidenceId } = parseOrThrow(causeEvidenceParamsSchema, req.params);

    const removed = await problemService.removeCauseEvidence(req.tenantId, evidenceId);
    res.json({ success: true, data: { removed } });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Closure cascade
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/problems/:ticketId/cascade — the plan, without acting on it.
 *
 * Writes nothing and logs nothing: a preview that left a `decision_log` row
 * would put "we resolved 41 incidents" in the evidence trail of a click that
 * resolved none. `ticket_read`, because looking at what would happen is
 * reading.
 */
router.get(
  '/:ticketId/cascade',
  read,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);
    const { policy } = parseOrThrow(cascadePreviewQuerySchema, req.query);

    const plan = await problemService.previewCascade(req.tenantId, ticketId, policy);
    res.json({ success: true, data: plan });
  }),
);

/**
 * POST /api/problems/:ticketId/cascade — resolve the wave.
 *
 * The cascade RESOLVES; it never closes. An automation is allowed to be wrong,
 * it is not allowed to be irreversible, and a resolved ticket a requester
 * disagrees with reopens on their next reply while a closed one does not.
 *
 * `dryRun` on the body re-plans with the policy the operator just picked in the
 * confirm dialog, immediately before they act on it, which is why the preview
 * exists on both verbs.
 */
router.post(
  '/:ticketId/cascade',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(problemParamsSchema, req.params);
    const body = parseOrThrow(problemCascadeSchema, req.body ?? {});

    await requireProblemAt(req, ticketId, body.baseRowVersion);

    if (body.dryRun === true) {
      const plan = await problemService.previewCascade(req.tenantId, ticketId, body.policy);
      res.json({ success: true, data: plan });
      return;
    }

    const actor = await actorOf(req);
    const result = await problemService.cascadeOnResolve(req.tenantId, actor, ticketId, {
      policy: body.policy,
    });
    res.json({ success: true, data: result });
  }),
);

export default router;
