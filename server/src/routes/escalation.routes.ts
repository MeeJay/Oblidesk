/**
 * escalation.routes.ts — `/api/escalations`.
 *
 * ── Route table ─────────────────────────────────────────────────────────────
 *   GET    /                      the published escalation ladders, normalised
 *   POST   /                      create or update a ladder, optionally publish
 *   POST   /validate              dry-run the save gate without saving
 *   GET    /runs?ticketId=        armed (and, with includeClosed, past) runs
 *   GET    /runs/:id              one run, its ladder and every step it fired
 *   POST   /runs/:id/cancel       stop a ladder that is chasing a fixed ticket
 *   POST   /arm                   arm a ladder on a ticket by hand
 *   POST   /sweep                 run one tick now (ops / a test desk)
 *   GET    /:slug                 one ladder
 *
 * `/runs`, `/arm`, `/sweep` and `/validate` are declared BEFORE `/:slug`.
 * Express matches in order, so the other way round would make `/runs` resolve
 * as a ladder whose slug is "runs".
 *
 * ── A ladder is a config object ─────────────────────────────────────────────
 * There is no `escalations` table for the DEFINITIONS: a ladder is a
 * `config_objects` row of `kind = 'escalation'`, so it versions, lints,
 * exports, imports and diffs exactly like every other piece of configuration,
 * and `SlaTargetSpec.escalationSlug` points at it by slug (HARD RULE 3). This
 * router is a convenience surface over that store, not a second one — POST here
 * and POST to `/api/config-objects/escalation` land in the same place.
 *
 * `escalation_runs` / `escalation_fires` (migration 003) are the RUNTIME, and
 * they are what `/runs` reads.
 *
 * MOUNTING: expects the app's auth middleware in front; `resolveActor` fails
 * closed with 401 if it is not there.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { CAPABILITIES, type EscalationTrigger } from '@oblidesk/shared';

import {
  arm,
  assertEscalationDefinitionSavable,
  buildEscalationLintContext,
  cancelRun,
  explainForTicket,
  firesForRun,
  getRun,
  listLadders,
  loadLadder,
  runsForTicket,
  sweepDueSteps,
  sweepStateLadders,
  validateEscalationDefinition,
  EscalationServiceError,
} from '../services/escalation.service';
import {
  createConfigObject,
  getConfigObject,
  publishConfigObject,
  updateConfigObject,
} from '../services/configObject.service';
import { AppError } from '../middleware/errorHandler';
import {
  handleServiceError,
  idParamSchema,
  requireCapability,
  resolveActor,
  sendFail,
  sendOk,
  slugParamSchema,
} from '../validators/config.validators';

const router = Router();

/**
 * `EscalationServiceError` carries a status and its findings; `AppError` (which
 * other services throw) carries a status and a payload. Neither is one of the
 * classes `handleServiceError` knows, so both would otherwise surface as a 500
 * — and a 422 whose findings never reach the editor is a dead end for whoever
 * is trying to fix the ladder.
 */
function fail(res: Response, error: unknown): void {
  if (error instanceof EscalationServiceError) {
    sendFail(res, error.status, error.message, {
      code: error.code,
      ...(error.details === undefined ? {} : { issues: error.details }),
    });
    return;
  }
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

const ESCALATION_TRIGGERS = [
  'sla_warning',
  'sla_breach',
  'no_update',
  'unassigned',
  'reopened',
  'priority',
] as const;

const saveSchema = z.object({
  /** HARD RULE 3 — the identity everything else references. */
  slug: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  /** An `EscalationBody`. Validated by the save gate, not by zod. */
  body: z.record(z.unknown()),
  /**
   * Publish immediately. Off by default: a ladder that goes live the instant it
   * is saved gives its author no chance to read the linter's findings, and the
   * linter is the whole safety net.
   */
  publish: z.boolean().optional(),
  note: z.string().max(500).optional(),
  /** Optimistic concurrency against `config_objects.version`. */
  baseVersion: z.number().int().positive().optional(),
});

const validateBodySchema = z.object({ body: z.record(z.unknown()) });

/**
 * A query-string flag.
 *
 * NOT `z.coerce.boolean()`: that is `Boolean(value)`, and `Boolean('false')` is
 * `true` — so `?includeClosed=false` would turn the flag ON. Query parameters
 * arrive as strings, and the only honest reading is an explicit one.
 */
const flag = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) =>
    typeof value === 'boolean' ? value : value === 'true' || value === '1' || value === 'yes',
  );

const runsQuerySchema = z.object({
  ticketId: z.coerce.number().int().positive(),
  includeClosed: flag.optional(),
  /** Fold in the ladder and every fired step — the "why is this escalating" panel. */
  explain: flag.optional(),
});

const armSchema = z.object({
  ticketId: z.number().int().positive(),
  ladderSlug: z.string().min(1).max(128),
  trigger: z.enum(ESCALATION_TRIGGERS),
  occurrenceKey: z.string().min(1).max(160).optional(),
  anchorAt: z.string().datetime().optional(),
  context: z.record(z.unknown()).optional(),
});

const cancelSchema = z.object({
  reason: z.string().min(1).max(32).default('cancelled'),
});

const sweepSchema = z.object({
  limit: z.number().int().positive().max(1000).optional(),
  /** Skip the arming half and only fire what is already due. */
  fireOnly: z.boolean().optional(),
});

// ═════════════════════════════════════════════════════════════════════════════
// Ladders
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every published ladder, normalised.
 *
 * `ticket_read` rather than an admin capability: the Why drawer shows an agent
 * which ladder is chasing their ticket and what its next rung does, and that is
 * not privileged information — it is the explanation for a page they just got.
 */
router.get('/', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.TICKET_READ);
  sendOk(res, await listLadders(actor.tenantId));
}));

/**
 * Create or update a ladder.
 *
 * The save gate runs BEFORE the write, so a ladder that would arm, wait and
 * tell nobody never reaches the store — the same check the config linter runs
 * at publish, called from one place so the two can never drift.
 *
 * Creating and updating share this route because the client's editor does not
 * know which it is doing: it holds a slug and a body, and whether that slug
 * already exists is a question about the server's state, not about the user's
 * intent.
 */
router.post('/', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.AUTOMATION_ADMIN);

  const input = saveSchema.parse(req.body);
  const ctx = await buildEscalationLintContext(actor.tenantId);
  assertEscalationDefinitionSavable(input.body, ctx);

  const existing = await getConfigObject(actor, 'escalation', input.slug);

  const saved = existing
    ? await updateConfigObject(actor, 'escalation', input.slug, {
      name: input.name,
      description: input.description ?? null,
      body: input.body,
      note: input.note,
      baseVersion: input.baseVersion,
    })
    : await createConfigObject(actor, {
      kind: 'escalation',
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      body: input.body,
      note: input.note,
    });

  // Publish is a SECOND step even when asked for in one call, because
  // `publishConfigObject` is what runs the cross-reference lint and appends the
  // immutable version row. Short-circuiting it would skip both.
  const result = input.publish
    ? await publishConfigObject(actor, 'escalation', input.slug, input.note)
    : saved;

  sendOk(res, result, existing ? 200 : 201);
}));

/**
 * Dry-run the save gate.
 *
 * The editor calls this while the author is still typing, so "step 2 escalates
 * to a group with no members" appears next to step 2 rather than at publish
 * time when the context is gone.
 */
router.post('/validate', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.AUTOMATION_ADMIN);

  const input = validateBodySchema.parse(req.body);
  const ctx = await buildEscalationLintContext(actor.tenantId);
  const findings = validateEscalationDefinition(input.body, ctx);

  sendOk(res, {
    savable: findings.every((finding) => finding.severity !== 'error'),
    findings,
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// Runtime — declared before /:slug so "runs" is never read as a ladder slug
// ═════════════════════════════════════════════════════════════════════════════

router.get('/runs', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.TICKET_READ);

  const query = runsQuerySchema.parse(req.query);
  if (query.explain) {
    sendOk(res, await explainForTicket(actor.tenantId, query.ticketId));
    return;
  }
  sendOk(res, await runsForTicket(actor.tenantId, query.ticketId, {
    includeClosed: query.includeClosed === true,
  }));
}));

/** One run, its ladder, and every rung it has fired — with the recipients. */
router.get('/runs/:id', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.TICKET_READ);

  const id = idParamSchema.parse(req.params.id);
  const run = await getRun(actor.tenantId, id);
  if (!run) {
    sendFail(res, 404, `Aucune escalade n° ${id}.`, { code: 'not_found' });
    return;
  }

  sendOk(res, {
    run,
    ladder: await loadLadder(actor.tenantId, run.ladderSlug),
    fires: await firesForRun(actor.tenantId, id),
  });
}));

/**
 * Stop a ladder.
 *
 * `ticket_rw`, not an admin capability: the person who just fixed the ticket is
 * the person who knows the ladder should stop chasing it, and making them find
 * an admin is how a pager keeps going off after the incident is over.
 */
router.post('/runs/:id/cancel', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.TICKET_RW);

  const id = idParamSchema.parse(req.params.id);
  const input = cancelSchema.parse(req.body ?? {});
  const cancelled = await cancelRun(actor.tenantId, id, input.reason, { actorId: actor.userId });

  sendOk(res, { cancelled, runId: id, reason: input.reason });
}));

/**
 * Arm a ladder by hand.
 *
 * Idempotent like every other arming: send the same `occurrenceKey` twice and
 * the second call reports `already_armed` rather than starting a second ladder.
 * Omit it and the trigger plus the anchor instant become the key, which makes
 * a double-clicked button a no-op.
 */
router.post('/arm', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.AUTOMATION_ADMIN);

  const input = armSchema.parse(req.body);
  const result = await arm({
    tenantId: actor.tenantId,
    ticketId: input.ticketId,
    ladderSlug: input.ladderSlug,
    trigger: input.trigger as EscalationTrigger,
    occurrenceKey: input.occurrenceKey,
    anchorAt: input.anchorAt,
    context: input.context,
    actorId: actor.userId,
    actorType: 'user',
  });

  sendOk(res, result, result.armed ? 201 : 200);
}));

/**
 * Run one tick now, for this tenant only.
 *
 * The ticker already sweeps every tenant on its own interval; this exists for a
 * test desk with no worker running and for an operator who has just fixed a
 * ladder and does not want to wait out the interval to see it work. Scoped to
 * the caller's tenant — a route that could sweep the installation would be a
 * cross-tenant action reachable from one tenant's session.
 */
router.post('/sweep', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.AUTOMATION_ADMIN);

  const input = sweepSchema.parse(req.body ?? {});
  const now = new Date();

  const armed = input.fireOnly
    ? { armed: 0, superseded: 0, errors: 0 }
    : await sweepStateLadders({ tenantId: actor.tenantId, now, limit: input.limit });
  const fired = await sweepDueSteps({ tenantId: actor.tenantId, now, limit: input.limit });

  sendOk(res, {
    armed: armed.armed,
    superseded: armed.superseded,
    fired: fired.fired,
    skipped: fired.skipped,
    errors: armed.errors + fired.errors,
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// One ladder
// ═════════════════════════════════════════════════════════════════════════════

router.get('/:slug', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.TICKET_READ);

  const slug = slugParamSchema.parse(req.params.slug);
  const ladder = await loadLadder(actor.tenantId, slug);
  if (!ladder) {
    sendFail(res, 404, `Aucune escalade publiée avec le slug « ${slug} ».`, { code: 'not_found' });
    return;
  }
  sendOk(res, ladder);
}));

export { router as escalationRouter };
export default router;

// TODO(routes/index.ts): mount in the TENANT tier, next to /config-objects:
//     import escalationRoutes from './escalation.routes';
//     tenantRouter.use('/escalations', escalationRoutes);
