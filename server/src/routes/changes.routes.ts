/**
 * changes.routes.ts — `/api/changes`, the change record and every act that can
 * be performed on one: the plan, the window, the risk band, the CAB, the
 * conflicts, the freezes, the implementation, the outcome and the review.
 *
 * MOUNT POINT: `/api/changes`, inside the TENANT tier of `routes/index.ts`, so
 * `requireAuth` + `requireTenant` have already run by the time any handler here
 * executes and `req.tenantId` is resolved. Each route additionally names the
 * capability it needs, so the guard is readable next to the route rather than
 * inherited from a mount three files away.
 *
 * ── Route ordering is load-bearing ──────────────────────────────────────────
 * Express matches in declaration order, so every literal path (`/schedule`,
 * `/models`, `/from-model`) is declared BEFORE `/:ticketId`. The other way
 * round, `GET /api/changes/schedule` resolves as "the change whose ticket id is
 * the string 'schedule'" and fails as a 400 that reads like a client bug for as
 * long as it takes somebody to read this file.
 *
 * ── Route table ─────────────────────────────────────────────────────────────
 *   GET    /schedule                        forward calendar        ticket_read
 *   GET    /models                          published templates     ticket_read
 *   POST   /from-model                      instantiate a template  change_rw
 *   GET    /                                the change board        ticket_read
 *   POST   /                                a THIN new record       change_rw
 *   GET    /:ticketId                       one change, hydrated    ticket_read
 *   PATCH  /:ticketId                       inline autosave         change_rw
 *   PUT    /:ticketId/window                plan it + scan          change_schedule
 *   POST   /:ticketId/risk/override         disagree with the matrix change_rw
 *   POST   /:ticketId/approvals/request     send it to the CAB      change_rw
 *   GET    /:ticketId/conflicts             the cached panel        ticket_read
 *   POST   /:ticketId/conflicts/acknowledge "I have seen these"     change_schedule
 *   GET    /:ticketId/freeze                the banner              ticket_read
 *   POST   /:ticketId/freeze/override       go through a freeze     change_freeze_override
 *   POST   /:ticketId/implementation/start  observed                change_rw
 *   POST   /:ticketId/implementation/finish observed                change_rw
 *   POST   /:ticketId/outcome               arms the PIR            change_rw
 *   POST   /:ticketId/review                completes the PIR       change_rw
 *
 * ── Capabilities, and why there are three of them ───────────────────────────
 * Reading rides on `ticket_read`, deliberately: an agent who can see a ticket
 * can see the change behind it, and inventing a `change_read` would have
 * silently blanked the schedule board for every existing permission set on the
 * day this shipped.
 *
 * `change_rw` is authoring: the plans, the risk override, the outcome, the
 * review, asking for approval. It is NOT `ticket_rw`, because every agent holds
 * `ticket_rw` and a change is a promise about production.
 *
 * `change_schedule` is committing the desk to a date, and it is a separate key
 * from authoring for a reason worth stating: the two routes it guards are the
 * two that can make a conflicting change legal. Setting a window creates the
 * overlap; acknowledging conflicts is what lets a change with a known overlap
 * proceed. The person who writes the runbook and the person who says "we are
 * doing this on Thursday at 22:00 anyway" need not be the same person.
 *
 * `change_freeze_override` guards exactly one route and is granted by NO
 * permission preset. A freeze is a business saying "not this week"; going
 * through it is meant to require somebody deliberately granting the key.
 *
 * ── Handlers are thin, and the four gates live in shared ─────────────────────
 * A business rule in a route is a defect. Nothing here decides whether a change
 * may be scheduled, whether a freeze may be overridden, whether a review is
 * complete or which approvals apply. Those are `evaluateChangeSchedule`,
 * `evaluateChangeFreezeOverride`, `evaluateChangeReview` and
 * `selectChangeApprovals` in `@oblidesk/shared`, called by the services, and
 * imported by the CLIENT to grey the same buttons out with the same blocker
 * codes. One implementation, two callers (HARD RULE 12). The one shared
 * function this file calls directly is `isChangeFrozen`, on the freeze read —
 * a predicate that paints a banner, never one that authorises anything.
 *
 * ── HARD RULE 7 is enforced in the UPDATE, not in a pre-flight read ──────────
 * Every mutation carries `baseRowVersion` (`changes.row_version`, NOT the
 * ticket's — they are separate concurrency domains) INTO the service, which
 * applies it as `WHERE row_version = :base` in the same statement that makes
 * the change and throws the 409 itself. This file deliberately does NOT read
 * the row first to compare versions: a check in the handler and a write in the
 * service are two statements with a gap between them, and that gap is exactly
 * the race optimistic concurrency exists to close.
 *
 * ── Errors are not translated here ──────────────────────────────────────────
 * There is deliberately no 409 or 422 special case in this file. The services
 * throw `AppError` subclasses carrying their own `code` and `payload` — a stale
 * `changes.row_version` becomes `code: 'version_conflict'` with the CURRENT
 * change in the body (HARD RULE 7), a stale acknowledgement digest becomes a
 * 409 of its own, a refused schedule or a refused review becomes
 * `code: 'transition_blocked'` with the `blockers` the UI lists — and
 * `errorHandler` renders all of them. A handler cannot lose the conflict body
 * by forgetting one.
 *
 * ── THE OTHER DOORS (trap 5) ────────────────────────────────────────────────
 * What this router guards is not all of what can write a change, and pretending
 * otherwise is how a gate becomes decorative. Three doors exist outside this
 * file and are recorded here so nobody has to rediscover them:
 *
 *   1. `POST /api/tickets` and the `create_child_ticket` rule action both
 *      accept `recordType: 'change'`, and neither creates a `changes` row. The
 *      result is a change ticket with no change record, which this module reads
 *      as "not a change" everywhere. `POST /api/changes { ticketId }` is the
 *      repair, and `ticket.service.create` is where the adoption belongs.
 *   2. `PATCH /api/tickets/:id` and `POST /api/tickets/bulk/apply` both write
 *      `tickets.impact`, which is an AXIS OF THE RISK MATRIX. Neither calls
 *      `changeService.recomputeRisk`, so a change's band can drift away from
 *      the matrix without a `change_risk_computed` row explaining it.
 *   3. The status transition itself is guarded in `ticket.service.transition`,
 *      not here. Every path that moves a change into `scheduled` or `closed` —
 *      this router, the rules engine, a bulk action, an alert recovery — goes
 *      through that one function, which is why the gate belongs there.
 *
 * Both (1) and (2) are outside this file's territory and are reported upward
 * rather than patched around. A guard that only holds when the user came in
 * through the front door is not a guard.
 */
import { Router } from 'express';
import { CAPABILITIES, isChangeFrozen } from '@oblidesk/shared';

import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireCapability } from '../middleware/rbac';
import { notFound } from '../middleware/errorHandler';
import { asyncHandler } from '../utils/asyncHandler';
import * as changeService from '../services/change.service';
import * as changeConflictService from '../services/changeConflict.service';
import * as changeFreezeService from '../services/changeFreeze.service';
// The one place a session becomes an `ActorContext`. Building a second one here
// would be a second implementation of RBAC, and the two would disagree on the
// day one of them was fixed — the shared gates read `actor.capabilities`, so a
// divergence would be a privilege bug rather than a style problem.
import { actorOf } from '../controllers/ticket.controller';
import {
  acknowledgeChangeConflictsSchema,
  changeImplementationSchema,
  changeParamsSchema,
  changeScheduleQuerySchema,
  completeChangeReviewSchema,
  createChangeFromModelSchema,
  createChangeSchema,
  listChangeConflictsQuerySchema,
  listChangeModelsQuerySchema,
  listChangesQuerySchema,
  overrideChangeFreezeSchema,
  overrideChangeRiskSchema,
  parseOrThrow,
  recordChangeOutcomeSchema,
  requestChangeApprovalsSchema,
  setChangeWindowSchema,
  updateChangeSchema,
} from '../validators/change.validators';

const router = Router();

// Belt and braces. The tenant tier already applies both, and a router that is
// ever mounted somewhere else must not silently become anonymous.
router.use(requireAuth);
router.use(requireTenant);

const read = requireCapability(CAPABILITIES.TICKET_READ);
const write = requireCapability(CAPABILITIES.CHANGE_RW);
/** Committing the desk to a date, and clearing the way for one. */
const schedule = requireCapability(CAPABILITIES.CHANGE_SCHEDULE);
/** The one key no permission preset grants. */
const freezeOverride = requireCapability(CAPABILITIES.CHANGE_FREEZE_OVERRIDE);

// ═════════════════════════════════════════════════════════════════════════════
// Literal collection paths — all of them before `/:ticketId`
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/changes/schedule — the forward calendar.
 *
 * Declared before `/:ticketId` so "schedule" is never read as an id. Both
 * bounds are required and they ARE the pagination: this reads `changes_board`
 * and the `planned_window` GiST index, and an unbounded forward schedule is a
 * full-table scan rendered as an infinite scroll.
 */
router.get(
  '/schedule',
  read,
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(changeScheduleQuerySchema, req.query);

    const rows = await changeService.schedule(req.tenantId, query);
    res.json({ success: true, data: rows });
  }),
);

/**
 * GET /api/changes/models — the published `change_model` templates.
 *
 * `ticket_read`, not `automation_admin`: reading which templates exist is what
 * the "start from a template" picker does, and every agent who can raise a
 * change needs it. AUTHORING a model stays under `automation_admin` with the
 * other configuration kinds, in `/api/config-objects`.
 */
router.get(
  '/models',
  read,
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listChangeModelsQuerySchema, req.query);

    const models = await changeService.listModels(req.tenantId, query);
    res.json({ success: true, data: models });
  }),
);

/**
 * POST /api/changes/from-model — a change built from a template.
 *
 * The plans are COPIED into the row and the model is stamped by slug and
 * version (HARD RULE 3 / 4). The row never references the template afterwards,
 * so an administrator editing the template tonight does not rewrite a runbook
 * somebody is executing at 22:00 — the drift is reported as a
 * `change_model_drifted` decision row with `outcome: noop`, not applied.
 *
 * `changeType` is deliberately absent from the body: the MODEL carries it.
 */
router.post(
  '/from-model',
  write,
  asyncHandler(async (req, res) => {
    const body = parseOrThrow(createChangeFromModelSchema, req.body ?? {});
    const actor = await actorOf(req);

    const change = await changeService.createFromModel(req.tenantId, actor, body);
    res.status(201).json({ success: true, data: change });
  }),
);

/**
 * GET /api/changes — the change board.
 *
 * Offset paged rather than keyset, like the problem board: a change calendar is
 * tens of rows a human reads top to bottom, not a virtualised list of a hundred
 * thousand, and paging it the other way would cost a cursor nobody scrolls.
 */
router.get(
  '/',
  read,
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listChangesQuerySchema, req.query);

    const page = await changeService.list(req.tenantId, query);

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
 * POST /api/changes — bring a change record into existence.
 *
 * A THIN record: the target ticket and, at most, a type and a template. No
 * plan, no window, no risk — a change is created as an intention and filled in
 * afterwards (HARD RULE 12). This is the trap the Problems module fell into: a
 * create form posting an empty field the schema refused answered 400 on every
 * click, and the fix was never to add the field to the form.
 *
 * The one structural exception lives in the service, not here: an emergency
 * MUST be inserted with `pir_required = true` in the same statement, because
 * `changes_emergency_pir_ck` refuses the column's `false` default. An emergency
 * that never gets reviewed is the thing that check exists to prevent.
 */
router.post(
  '/',
  write,
  asyncHandler(async (req, res) => {
    const body = parseOrThrow(createChangeSchema, req.body ?? {});
    const actor = await actorOf(req);

    const change = await changeService.create(req.tenantId, actor, body);
    res.status(201).json({ success: true, data: change });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// One change
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/changes/:ticketId — the record, hydrated.
 *
 * Carries the ticket header, the live conflicts, the linked CIs and their worst
 * criticality, the selected approvals with the reason for each, and BOTH gate
 * evaluations precomputed by the same evaluators the mutation routes run. The
 * client re-runs them locally as the operator types; shipping them with the
 * record is what makes the first paint agree with the second.
 */
router.get(
  '/:ticketId',
  read,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(changeParamsSchema, req.params);

    const change = await changeService.get(req.tenantId, ticketId);
    if (!change) throw notFound('Change not found');

    res.json({ success: true, data: change });
  }),
);

/**
 * PATCH /api/changes/:ticketId — inline autosave, one field at a time.
 *
 * Validates nothing beyond shape (HARD RULE 12): a backout plan that says
 * "TODO" saves happily and the change simply cannot be scheduled, and that
 * refusal comes from the shared gate at the transition, not from a half-written
 * form.
 *
 * `baseRowVersion` is `changes.row_version`, NOT the ticket's. The two are
 * separate concurrency domains on purpose, so the change manager rewriting an
 * implementation plan does not 409 the team lead reassigning the ticket.
 *
 * The schema is `.strict()` and every guarded field is absent from it — the
 * window, the risk band, the outcome, the PIR answers, the acknowledgement, the
 * freeze override, the implementation stamps. Each of those has a route below
 * that carries its own capability and writes its own decision row; accepting
 * them here would be a fifth door around four locked ones.
 */
router.patch(
  '/:ticketId',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(changeParamsSchema, req.params);
    const body = parseOrThrow(updateChangeSchema, req.body ?? {});
    const actor = await actorOf(req);

    const change = await changeService.update(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: change });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// The window — and the conflict scan that comes with it
// ═════════════════════════════════════════════════════════════════════════════

/**
 * PUT /api/changes/:ticketId/window — when the work is planned to happen.
 *
 * A PUT because the window is a PAIR (`changes_planned_pair_ck`): there is no
 * patching one half of it, and sending both ends as null unschedules the
 * change.
 *
 * THE CONFLICTS COME BACK IN THIS RESPONSE, SYNCHRONOUSLY, and that is the
 * point of the endpoint. A conflict discovered later — by a sweeper, at the
 * approval step, on the morning of the work — is a conflict discovered after
 * somebody has already promised a customer a date. The answer therefore carries
 * the change, the live conflicts and the schedule gate together, so the date
 * picker can say "that Thursday overlaps DB-CORE-01 with CHG-1042" while it is
 * still open.
 *
 * `change_schedule`, not `change_rw`: this is the act that CREATES the overlap.
 *
 * The service decides whether this is a first plan or a MOVE. That distinction
 * is not the route's to make: moving a window past the policy's tolerance
 * invalidates approvals already granted, because an approval is consent to a
 * specific window, and only the service can see the baseline that decides it.
 */
router.put(
  '/:ticketId/window',
  schedule,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(changeParamsSchema, req.params);
    const body = parseOrThrow(setChangeWindowSchema, req.body ?? {});
    const actor = await actorOf(req);

    const result = await changeService.setPlannedWindow(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: result });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Risk
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/changes/:ticketId/risk/override — a human disagrees with the matrix.
 *
 * Writes `changes.risk` and leaves `changes.risk_computed` untouched forever:
 * what the matrix said is evidence, and evidence is not edited. From then on a
 * recompute that lands elsewhere records a `change_risk_drifted` row with
 * `outcome: noop` rather than quietly taking the band back — the human stays in
 * charge until another human says otherwise.
 *
 * The reason is mandatory at the schema, so a blank one is a 400 naming the
 * field rather than the 23514 `changes_risk_override_ck` would raise.
 *
 * `change_rw` rather than `change_schedule`: overriding the band is an
 * authoring act, and it does not by itself let anything through — a lowered
 * band cannot unlock a backout waiver, because `canWaiveBackout` reads
 * `risk_computed`, not `risk`.
 */
router.post(
  '/:ticketId/risk/override',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(changeParamsSchema, req.params);
    const body = parseOrThrow(overrideChangeRiskSchema, req.body ?? {});
    const actor = await actorOf(req);

    const change = await changeService.overrideRisk(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: change });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Approvals — the CAB is a configuration object plus the existing engine
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/changes/:ticketId/approvals/request — send it to the CAB.
 *
 * There is no new approval engine here and there must never be one. The CAB is
 * an `approval` configuration object and `approval.service`'s existing
 * `startApproval`; what this module adds is `selectChangeApprovals`, which
 * reads the `change_policy` and answers WHICH definitions apply and WHY — by
 * type, by risk band, by worst CI criticality, by queue. That ordered list,
 * with the `because` on each entry, is the row that answers "why did this need
 * three approvals" six months later.
 *
 * The body carries only the row version: a caller naming its own approver list
 * would be a caller choosing its own reviewers.
 *
 * `evaluateChangeSchedule` runs FIRST, inside the service and inside the same
 * transaction, so an incomplete change cannot occupy an agenda slot. Note that
 * this is the same gate the `scheduled` transition runs, deliberately: asking
 * for approval and booking the date are two halves of one commitment, and a
 * change that cannot be scheduled has nothing to approve.
 */
router.post(
  '/:ticketId/approvals/request',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(changeParamsSchema, req.params);
    const body = parseOrThrow(requestChangeApprovalsSchema, req.body ?? {});
    const actor = await actorOf(req);

    const result = await changeService.requestApproval(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: result });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Conflicts
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/changes/:ticketId/conflicts — the cached panel.
 *
 * A READ of `change_conflicts`, which is a CACHE: safe to truncate, rebuilt by
 * the sweeper and by every window change. It is deliberately NOT what the
 * transition gate consults — the gate is handed freshly classified conflicts,
 * because a gate that trusts a cache is a gate that can be opened by letting
 * the cache go stale.
 *
 * `includeCleared` shows the history. Rows are cleared, never deleted, so that
 * "this overlapped CHG-1042 until they moved" survives as an answer.
 */
router.get(
  '/:ticketId/conflicts',
  read,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(changeParamsSchema, req.params);
    const query = parseOrThrow(listChangeConflictsQuerySchema, req.query);

    const conflicts = await changeConflictService.list(req.tenantId, ticketId, query);
    res.json({ success: true, data: conflicts });
  }),
);

/**
 * POST /api/changes/:ticketId/conflicts/acknowledge — "I have seen these".
 *
 * `change_schedule`, because acknowledging is what lets a change with a known
 * overlap proceed. It is the second half of the same authority that set the
 * date, and it is not authoring.
 *
 * The digest is the load-bearing part. Acknowledging is not a permanent state;
 * it is a statement about a specific SET of conflicts, stored as
 * `conflictDigest(acknowledgeableConflicts(live))`. The service recomputes that
 * digest at this instant and answers 409 when the client's disagrees, so a new
 * conflict raised between the operator reading the panel and clicking the
 * button re-closes the gate. Without it, one click at 09:00 buys immunity from
 * everything discovered at 16:00.
 *
 * `acknowledgeableConflicts` drops freezes: they are stored as conflict rows so
 * the operator reads one panel with one vocabulary, but a freeze is OVERRIDDEN
 * behind a different capability with its own columns and its own audit trail,
 * and is never acknowledged. Both sides compute the digest over the same
 * filtered set, or acknowledging an overlap would quietly also acknowledge a
 * freeze.
 */
router.post(
  '/:ticketId/conflicts/acknowledge',
  schedule,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(changeParamsSchema, req.params);
    const body = parseOrThrow(acknowledgeChangeConflictsSchema, req.body ?? {});
    const actor = await actorOf(req);

    const change = await changeService.acknowledgeConflicts(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: change });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Freeze
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/changes/:ticketId/freeze — which freezes this change runs into.
 *
 * `isChangeFrozen` is a READ PREDICATE. It paints a banner and greys a button;
 * it decides nothing. The split from `evaluateChangeFreezeOverride` below is
 * deliberate and is the sixth trap the Problems review named: a predicate
 * written for a read, reused to authorise a write, is how an override ends up
 * available to anybody who can see the banner.
 *
 * A freeze calendar is INVERTED — its OPEN bands are the hours the business is
 * SHUT FOR CHANGES — which is why the verdicts come from the service rather
 * than from reading a calendar here.
 */
router.get(
  '/:ticketId/freeze',
  read,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(changeParamsSchema, req.params);

    const verdicts = await changeFreezeService.evaluate(req.tenantId, ticketId);
    res.json({ success: true, data: { verdicts, frozen: isChangeFrozen(verdicts) } });
  }),
);

/**
 * POST /api/changes/:ticketId/freeze/override — go through a change freeze.
 *
 * The only route behind `change_freeze_override`, a capability no permission
 * preset grants: somebody has to be given it on purpose.
 *
 * `slugs` is required and non-empty. An override must NAME what it bypasses,
 * because `freeze_override_slugs` is the only answer to "which freeze did you
 * go through" (HARD RULE 3) — and because a freeze that comes into force after
 * the override then still blocks, which is what anybody reading the audit trail
 * would assume.
 *
 * The service leaves FOUR traces in one transaction, and all four are needed
 * for different questions: the columns on `changes` (what is true now), a
 * `decision_log` row (why), an `audit_log` row (and nobody edited that answer —
 * it is hash-chained), and a work note on the ticket (so it is visible without
 * opening the Why drawer). An override nobody can see is an override nobody
 * reviews.
 */
router.post(
  '/:ticketId/freeze/override',
  freezeOverride,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(changeParamsSchema, req.params);
    const body = parseOrThrow(overrideChangeFreezeSchema, req.body ?? {});
    const actor = await actorOf(req);

    const change = await changeService.overrideFreeze(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: change });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Implementation — explicit acts, never side effects
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/changes/:ticketId/implementation/start — the work has begun.
 *
 * An explicit act, not a side effect of a transition, and it records
 * `source: 'observed'` because somebody was there to press it.
 *
 * The open actual window IS the "implementing" state. There is no ninth status
 * category for it and there must never be one (HARD RULE 5): `actual_window` is
 * generated as `tstzrange(started, ended, '[)')` and is unbounded above while
 * the work runs, which is what `isImplementing` reads.
 */
router.post(
  '/:ticketId/implementation/start',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(changeParamsSchema, req.params);
    const body = parseOrThrow(changeImplementationSchema, req.body ?? {});
    const actor = await actorOf(req);

    const change = await changeService.startImplementation(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: change });
  }),
);

/**
 * POST /api/changes/:ticketId/implementation/finish — the work has stopped.
 *
 * Also `source: 'observed'`. The asymmetry worth knowing is what happens when
 * nobody presses it: resolving a change with the actual window still open
 * stamps the end from `onChangeResolved` and records it under a DIFFERENT
 * decision key, with `source: 'inferred'`, so the duration-accuracy report can
 * exclude it. A row claiming somebody watched the work finish, when all we saw
 * was a status change, is worse than no row at all.
 */
router.post(
  '/:ticketId/implementation/finish',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(changeParamsSchema, req.params);
    const body = parseOrThrow(changeImplementationSchema, req.body ?? {});
    const actor = await actorOf(req);

    const change = await changeService.finishImplementation(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: change });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Outcome and the post-implementation review
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/changes/:ticketId/outcome — how it actually went.
 *
 * Recording the outcome ARMS THE PIR on the same code path: `isPirOwed` reads
 * the outcome with the change type, `major` and the policy's `pirRequired`, and
 * `pir_due_at` is computed on the policy's calendar in the same transaction
 * that stores the outcome. Arming it from a later sweep would mean a failed
 * emergency change that nobody reviewed had no due date to be late against.
 */
router.post(
  '/:ticketId/outcome',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(changeParamsSchema, req.params);
    const body = parseOrThrow(recordChangeOutcomeSchema, req.body ?? {});
    const actor = await actorOf(req);

    const change = await changeService.recordOutcome(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: change });
  }),
);

/**
 * POST /api/changes/:ticketId/review — complete the post-implementation review.
 *
 * The schema accepts a review with blank findings on purpose. Refusing it is
 * `evaluateChangeReview`'s job, and it refuses "it went fine" specifically: no
 * outcome, blank findings, no explicit answer to "did this cause an incident?",
 * or a `true` answer with no incident linked. Those come back as 422 with
 * blocker codes the client already renders, because the client runs the same
 * evaluator to grey the button out and list what is missing. A zod schema
 * holding a second opinion here would answer `pirFindingsMd: Required` where
 * the shared evaluator answers in the operator's language, and the two would
 * disagree on the day one of them was fixed.
 *
 * `pirCompletedBy` is the session's user and is never on the wire —
 * `changes_pir_completed_ck` demands it alongside `pir_completed_at`.
 */
router.post(
  '/:ticketId/review',
  write,
  asyncHandler(async (req, res) => {
    const { ticketId } = parseOrThrow(changeParamsSchema, req.params);
    const body = parseOrThrow(completeChangeReviewSchema, req.body ?? {});
    const actor = await actorOf(req);

    const change = await changeService.completeReview(req.tenantId, actor, ticketId, body);
    res.json({ success: true, data: change });
  }),
);

export default router;
