/**
 * sla.routes.ts — everything under `/api/sla`.
 *
 * MOUNT POINT: `/api/sla`, inside the TENANT tier of `routes/index.ts` (behind
 * `requireAuth` + `requireTenant`), exactly like `/api/tickets`. It defines
 * `/policies`, `/instances`, `/at-risk` — never `/sla/policies` — per the
 * contract in `routes/index.ts`'s header.
 *
 *   import slaRoutes from './sla.routes';
 *   tenantRouter.use('/sla', slaRoutes);
 *
 * ── Route ordering is load-bearing ───────────────────────────────────────────
 * Express matches in declaration order. `/instances` (the collection) is
 * declared before `/instances/:id/...`, and there is deliberately no bare
 * `GET /instances/:id` ahead of the literal segments, so `/instances/at-risk`
 * could never be read as "the instance whose id is 'at-risk'".
 *
 * ── Capabilities, and the one that will look strict ──────────────────────────
 *   TICKET_READ  reading instances, the ledger explainer, and the at-risk board
 *   SLA_ADMIN    listing policies, listing calendars, and MANUAL PAUSE/RESUME
 *
 * Manual pause is gated on `SLA_ADMIN` rather than `TICKET_RW`, and that is a
 * considered choice rather than an oversight. Pausing a clock by hand changes a
 * contractual number: it can turn a breach into a met target, and it is the one
 * action on this router whose effect a customer might later dispute. Everything
 * else an agent does to an SLA — resolving the ticket, replying, moving it to
 * pending — pauses or stops clocks as a SIDE EFFECT of work, through
 * `ticket.service`, with no capability of its own. Reaching in and stopping the
 * clock without doing the work is a different act, and it should need a
 * different grant.
 *
 * A desk that disagrees changes one constant below; every such pause is written
 * to `sla_ledger` with the actor and to `decision_log` on the same code path
 * either way, so the audit trail does not depend on the choice.
 *
 * ── What is NOT here ─────────────────────────────────────────────────────────
 * No endpoint recomputes a clock. `GET /instances/:id/ledger` REPLAYS the
 * ledger to draw its bands, which is the opposite: it is the ledger's own
 * arithmetic, shown. Nothing in this router writes `due_at` or `paused_ms`
 * except through the engine, and the engine writes them only alongside a ledger
 * row (HARD RULE 2).
 */

import { Router, type Request, type Response } from 'express';

import { CAPABILITIES } from '@oblidesk/shared';

import {
  atRisk,
  explainInstance,
  instanceById,
  instancesForTicket,
  listPolicies,
  pauseManually,
  resumeManually,
  SlaNotFoundError,
} from '../services/sla.service';
import { listCalendars } from '../services/calendar.service';
import {
  atRiskQuerySchema,
  describeTargetIssues,
  instanceParamSchema,
  instancesQuerySchema,
  pauseResumeSchema,
  policiesQuerySchema,
  requireCapability,
  resolveActor,
  sendList,
  sendOk,
  wrapSla,
} from '../validators/sla.validators';

const router = Router();

/** See the header: the capability a hand-driven clock change costs. */
const MANUAL_CLOCK_CAPABILITY = CAPABILITIES.SLA_ADMIN;

// ═════════════════════════════════════════════════════════════════════════════
// Policies — the configuration side
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `GET /api/sla/policies`
 *
 * Every published policy, parsed, with its bindings, the resolution LEVEL it
 * would compete at, and — the part that matters on an admin screen — the
 * runtime validation findings per target.
 *
 * A policy whose target is refused by the engine (a business calendar plus an
 * `outside_hours` pause) still appears here, with the finding attached, because
 * the alternative is an admin staring at a ticket with no clock and no
 * explanation. The finding carries an i18n key and French copy
 * (HARD RULE 10) so the screen can say why without inventing wording.
 */
router.get(
  '/policies',
  wrapSla(async (req: Request, res: Response) => {
    const actor = await resolveActor(req);
    requireCapability(actor, CAPABILITIES.SLA_ADMIN);

    const query = policiesQuerySchema.parse(req.query);
    const policies = await listPolicies(actor.tenantId);

    const data = policies
      .filter((policy) => query.includeProblems || policy.problems.length === 0 || policy.targets.length > 0)
      .map((policy) => ({
        ...policy,
        targets: policy.targets.map((target) => ({
          ...target,
          issues: describeTargetIssues(target.issues),
        })),
      }));

    sendList(res, data, { total: data.length, page: 1, limit: data.length });
  }),
);

/**
 * `GET /api/sla/calendars`
 *
 * The business calendars as `calendar.service` resolves them — config object
 * merged with its projection rows, recurring holidays already expanded, the
 * 24×7 flag already decided.
 *
 * It is on THIS router rather than under `/config` on purpose: everything
 * downstream (SLA, escalation, rate cards, on-call) must ask one service what
 * "after hours" means, and an admin comparing a policy against its calendar
 * should be reading the same answer the engine read, not a second rendering of
 * the raw body.
 */
router.get(
  '/calendars',
  wrapSla(async (req: Request, res: Response) => {
    const actor = await resolveActor(req);
    requireCapability(actor, CAPABILITIES.SLA_ADMIN);

    const calendars = await listCalendars(actor.tenantId);
    sendList(
      res,
      calendars.map((calendar) => ({
        slug: calendar.slug,
        name: calendar.name,
        timezone: calendar.timezone,
        isDefault: calendar.isDefault,
        is24x7: calendar.is24x7,
        source: calendar.source,
        version: calendar.version,
        weeklyMinutes: calendar.weeklyMinutes,
        weeklyHours: Math.round((calendar.weeklyMinutes / 60) * 10) / 10,
        holidayCount: calendar.holidayCount,
        shifts: calendar.calendar.shifts,
      })),
      { total: calendars.length, page: 1, limit: calendars.length },
    );
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// The at-risk board — literal path, declared before `/instances/:id`
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `GET /api/sla/at-risk?withinMinutes=120&queueSlug=network`
 *
 * The Shift Board's "who is about to be late". Served off the cached `due_at`
 * and ordered by it, deliberately WITHOUT replaying a ledger per row: this
 * refreshes every few seconds for every agent on shift, and the cache exists
 * for exactly this. The moment anyone wants to argue about one of these rows,
 * they open the explainer below, and that one reads the ledger.
 *
 * `minutesRemaining` is wall-clock, not business time, because an agent looking
 * at the board at 17:55 needs the honest five minutes rather than the four
 * business hours the calendar would report.
 */
router.get(
  '/at-risk',
  wrapSla(async (req: Request, res: Response) => {
    const actor = await resolveActor(req);
    requireCapability(actor, CAPABILITIES.TICKET_READ);

    const query = atRiskQuerySchema.parse(req.query);
    const rows = await atRisk(actor.tenantId, {
      withinMinutes: query.withinMinutes,
      includeBreached: query.includeBreached,
      limit: query.limit,
      queueSlug: query.queueSlug,
      assigneeId: query.assigneeId,
    });

    sendList(res, rows, { total: rows.length, page: 1, limit: query.limit });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Instances
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `GET /api/sla/instances?ticketId=42`
 *
 * Every clock on one ticket, live and finished, each carrying the persisted
 * policy RESOLUTION — winner and losers — so the ticket header can render
 * "Gold contract won; here is what lost" without asking the engine to resolve
 * anything a second time against configuration that has since moved on.
 *
 * `ticketId` is required. An instance list with no ticket is a table scan
 * wearing an API.
 */
router.get(
  '/instances',
  wrapSla(async (req: Request, res: Response) => {
    const actor = await resolveActor(req);
    requireCapability(actor, CAPABILITIES.TICKET_READ);

    const query = instancesQuerySchema.parse(req.query);
    const instances = await instancesForTicket(actor.tenantId, query.ticketId);

    sendOk(res, {
      ticketId: query.ticketId,
      instances,
      // The header countdown wants one number, and picking it here means the
      // client cannot pick a different one on a different screen.
      nearest:
        instances
          .filter((instance) => instance.status === 'running' || instance.status === 'paused')
          .filter((instance) => instance.dueAt !== null)
          .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)))[0] ?? null,
    });
  }),
);

/**
 * `GET /api/sla/instances/:id/ledger`
 *
 * THE customer-showable explainer.
 *
 * Returns the raw ledger AND the derived strip: worked / paused / out-of-hours
 * bands with their millisecond widths, plus the totals, plus the calendar the
 * arithmetic ran on. The bands are built by walking the ledger's pause and
 * resume edges and splitting each running span on the calendar's own open and
 * shut edges — so the picture is "you were not charged for the weekend, and
 * here is the weekend", drawn from the ledger rather than from `paused_ms`.
 *
 * If the cache and the ledger ever disagree, this endpoint shows the LEDGER.
 * That is the whole point of having one.
 */
router.get(
  '/instances/:id/ledger',
  wrapSla(async (req: Request, res: Response) => {
    const actor = await resolveActor(req);
    requireCapability(actor, CAPABILITIES.TICKET_READ);

    const { id } = instanceParamSchema.parse(req.params);
    const explainer = await explainInstance(actor.tenantId, id);
    if (!explainer) throw new SlaNotFoundError(id);

    sendOk(res, explainer);
  }),
);

/** `GET /api/sla/instances/:id` — one clock, without the ledger replay strip. */
router.get(
  '/instances/:id',
  wrapSla(async (req: Request, res: Response) => {
    const actor = await resolveActor(req);
    requireCapability(actor, CAPABILITIES.TICKET_READ);

    const { id } = instanceParamSchema.parse(req.params);
    const instance = await instanceById(actor.tenantId, id);
    if (!instance) throw new SlaNotFoundError(id);

    sendOk(res, instance);
  }),
);

/**
 * `POST /api/sla/instances/:id/pause`
 *
 * A manual, audited pause. It adds `manual` to the instance's pause SET — it
 * does not replace whatever else is holding the clock, so lifting it later
 * cannot accidentally restart a clock that is still pending on the requester.
 *
 * The response reports `activePauses` for exactly that reason: an agent who
 * pauses a clock that was already paused needs to see that nothing changed,
 * rather than a cheerful 200 that implies it did.
 */
router.post(
  '/instances/:id/pause',
  wrapSla(async (req: Request, res: Response) => {
    const actor = await resolveActor(req);
    requireCapability(actor, MANUAL_CLOCK_CAPABILITY);

    const { id } = instanceParamSchema.parse(req.params);
    const body = pauseResumeSchema.parse(req.body ?? {});

    const result = await pauseManually(actor.tenantId, id, actor.userId, body.note ?? null);
    sendOk(res, result);
  }),
);

/**
 * `POST /api/sla/instances/:id/resume`
 *
 * Lifts the MANUAL pause only. If the ticket is still sitting in a pausing
 * category, or the device is still offline, the clock stays paused and the
 * response says so through `running: false` and a non-empty `activePauses` —
 * because the alternative is a UI that claims a clock is ticking when the
 * ledger says otherwise, and the ledger is the one that will be quoted.
 */
router.post(
  '/instances/:id/resume',
  wrapSla(async (req: Request, res: Response) => {
    const actor = await resolveActor(req);
    requireCapability(actor, MANUAL_CLOCK_CAPABILITY);

    const { id } = instanceParamSchema.parse(req.params);
    const body = pauseResumeSchema.parse(req.body ?? {});

    const result = await resumeManually(actor.tenantId, id, actor.userId, body.note ?? null);
    sendOk(res, result);
  }),
);

export default router;
