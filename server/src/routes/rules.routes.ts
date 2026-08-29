/**
 * rules.routes.ts — `/api/rules`.
 *
 * ── One list, one screen, one answer ────────────────────────────────────────
 * The entire premise of this slice is that "what will happen to this ticket,
 * and in what order?" has ONE answer, so this router serves ONE ordered list
 * and the evidence of what it has actually done:
 *
 *   GET    /                     the ordered list, exactly as the engine runs it
 *   POST   /                     rewrite that order
 *   GET    /actions              the closed action catalogue, with param schemas
 *   GET    /executions           the log — matched, not matched, failed
 *   POST   /simulate             dry-run over the tenant's real recent tickets
 *   GET    /:slug                one rule, its health, and its last runs
 *   POST   /:slug/enable         switch it on (and clear its breaker)
 *   POST   /:slug/disable        switch it off
 *   POST   /:slug/reset-breaker  "I fixed it, try again"
 *
 * Literal paths are declared BEFORE `/:slug` on purpose: Express matches in
 * declaration order, and `/executions` reaching a slug handler would be a 404
 * for a route that exists.
 *
 * ── Why GET / does not just list config objects ─────────────────────────────
 * `/api/config-objects?kind=rule` already returns the rows. This returns the
 * NORMALISED, ORDERED, engine-eye view — the same array `runRules()` iterates,
 * built by the same `normalizeRule()`. An admin screen that renders the raw
 * bodies would be a second interpretation of two dialects, and the day it
 * disagrees with the engine is the day the ordered list stops being an answer.
 *
 * MOUNTING: expects to sit behind `requireAuth` + `requireTenant`;
 * `resolveActor` fails closed with 401 if it does not.
 */

import { Router, type Request, type Response } from 'express';

import { CAPABILITIES } from '@oblidesk/shared';

import {
  guardrailSettings,
  listExecutions,
  loadRules,
  reorderRules,
  resetRuleBreaker,
  ruleBreakerState,
  ruleHealth,
  setRuleEnabled,
  type NormalizedRule,
} from '../services/rule.service';
import { actionCatalogue } from '../services/ruleActions';
import { simulateRules } from '../services/ruleSimulator.service';
import {
  executionsQuerySchema,
  handleServiceError,
  listRulesQuerySchema,
  reorderRulesSchema,
  requireCapability,
  resolveActor,
  ruleSlugSchema,
  sendFail,
  sendList,
  sendOk,
  simulateRulesSchema,
  toggleRuleSchema,
} from '../validators/rule.validators';

const router = Router();

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((error: unknown) => handleServiceError(res, error));
  };
}

/**
 * The wire shape of a rule.
 *
 * `actions` is flattened to `{ index, kind, params, disabled }` — the
 * NORMALISED form, not the authored one — because the form the UI edits must be
 * the form the engine runs. Round-tripping the raw body through the browser is
 * how one dialect quietly becomes two.
 */
function toWire(rule: NormalizedRule, tenantId: number) {
  return {
    slug: rule.slug,
    name: rule.name,
    version: rule.version,
    bodyFormatVersion: rule.bodyFormatVersion,
    order: rule.order,
    enabled: rule.enabled,
    dryRun: rule.dryRun,
    stopProcessing: rule.stopProcessing,
    runOnce: rule.runOnce,
    cooldownMinutes: rule.cooldownMinutes,
    triggers: rule.triggers,
    triggerFields: rule.triggerFields,
    when: rule.when,
    schedule: rule.schedule,
    shared: rule.shared,
    actions: rule.actions.map((action) => ({
      index: action.index,
      kind: action.kind,
      params: action.params,
      disabled: action.disabled,
    })),
    /**
     * Config problems travel WITH the rule, not in a separate lint call. A rule
     * whose condition is malformed or whose action names something outside the
     * catalogue is switched off in every way except the one the UI shows, and
     * the list is where somebody will actually see it.
     */
    issues: rule.issues,
    breaker: ruleBreakerState(tenantId, rule.slug),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// The ordered list
// ═════════════════════════════════════════════════════════════════════════════

router.get('/', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.AUTOMATION_ADMIN);

  const query = listRulesQuerySchema.parse(req.query);

  // `fresh` — an admin who just published a rule and immediately opens this
  // screen must see it. A five-second cache is right for the hot path and
  // exactly wrong for the screen where somebody is checking their own edit.
  let rules = await loadRules(actor.tenantId, undefined, { fresh: true });
  if (query.trigger) {
    rules = rules.filter((rule) => rule.triggers.includes(query.trigger as never));
  }
  if (query.includeDisabled === false) {
    rules = rules.filter((rule) => rule.enabled);
  }

  const health = query.withHealth
    ? await ruleHealth(actor.tenantId, rules.map((rule) => rule.slug), query.healthWindowDays ?? 30)
    : null;

  res.status(200).json({
    success: true,
    data: rules.map((rule) => ({
      ...toWire(rule, actor.tenantId),
      health: health?.get(rule.slug.toLowerCase()) ?? null,
    })),
    total: rules.length,
    page: 1,
    limit: rules.length,
    guardrails: guardrailSettings(),
  });
}));

/**
 * Rewrite the order.
 *
 * A whole-list write, published through the config store, so the change is
 * versioned and auditable like any other. The response is per-slug: a rule the
 * tenant may not edit (one shared down from the master tenant) reports why
 * instead of failing the whole drag.
 */
router.post('/', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.AUTOMATION_ADMIN);

  const { order } = reorderRulesSchema.parse(req.body);
  const result = await reorderRules(actor, order);

  sendOk(res, {
    outcomes: result.outcomes,
    rules: result.rules.map((rule) => toWire(rule, actor.tenantId)),
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// The catalogue
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every action the engine can perform, with its parameter schema.
 *
 * The UI renders its action form from THIS, never from a copy of the list kept
 * in the client. A closed catalogue is only closed if there is one copy of it;
 * two copies is an open catalogue with extra steps.
 */
router.get('/actions', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.AUTOMATION_ADMIN);
  sendOk(res, { actions: actionCatalogue(), guardrails: guardrailSettings() });
}));

// ═════════════════════════════════════════════════════════════════════════════
// The execution log
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `rule_executions`, filterable by rule and by ticket.
 *
 * This is the endpoint behind "why did nothing happen?" — the question
 * `decision_log` structurally cannot answer, because a rule that ran and did
 * not match took no action to record. Simulations are excluded unless asked
 * for: they are what WOULD have happened, and mixing them into the record of
 * what DID would make the log unusable as evidence.
 */
router.get('/executions', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.AUTOMATION_ADMIN);

  const query = executionsQuerySchema.parse(req.query);
  const page = await listExecutions(actor.tenantId, {
    ...query,
    dryRun: query.dryRun === undefined ? false : query.dryRun,
  });

  sendList(res, page.rows, { total: page.total, page: page.page, limit: page.limit });
}));

// ═════════════════════════════════════════════════════════════════════════════
// The simulator
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Dry-run over the tenant's own recent tickets.
 *
 * The body may carry a CANDIDATE rule that has not been published — that is the
 * point. Testing only what is already live answers the question after it has
 * stopped mattering.
 *
 * Runs through the production executor with `dryRun` forced on, inside
 * transactions that are always rolled back. It is a slow endpoint by nature
 * (real rules over real tickets), and it is capped at
 * `MAX_SAMPLE_SIZE` for that reason.
 */
router.post('/simulate', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.AUTOMATION_ADMIN);

  const input = simulateRulesSchema.parse(req.body ?? {});
  const result = await simulateRules(actor, {
    ruleSlugs: input.ruleSlugs,
    candidate: input.candidate
      ? {
        slug: input.candidate.slug,
        name: input.candidate.name,
        body: input.candidate.body as Record<string, unknown>,
      }
      : undefined,
    sampleSize: input.sampleSize,
    trigger: input.trigger as never,
    filter: (input.filter ?? null) as never,
    queueSlugs: input.queueSlugs,
    statusCategories: input.statusCategories as never,
    createdFrom: input.createdFrom,
    createdTo: input.createdTo,
    recordLog: input.recordLog,
  });

  sendOk(res, result);
}));

// ═════════════════════════════════════════════════════════════════════════════
// One rule
// ═════════════════════════════════════════════════════════════════════════════

router.get('/:slug', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.AUTOMATION_ADMIN);

  const slug = ruleSlugSchema.parse(req.params.slug);
  const rules = await loadRules(actor.tenantId, undefined, { fresh: true });
  const rule = rules.find((entry) => entry.slug.toLowerCase() === slug.toLowerCase());

  if (!rule) {
    sendFail(res, 404, `No published rule with the slug "${slug}".`, { code: 'not_found' });
    return;
  }

  const [health, recent] = await Promise.all([
    ruleHealth(actor.tenantId, [rule.slug]),
    listExecutions(actor.tenantId, { ruleSlug: rule.slug, limit: 25, dryRun: false }),
  ]);

  sendOk(res, {
    ...toWire(rule, actor.tenantId),
    health: health.get(rule.slug.toLowerCase()) ?? null,
    // "Is it safe to change this?" is answered by what it has actually done,
    // not by reading the body again.
    recentExecutions: recent.rows,
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// Switching a rule on and off
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Enable / disable go through the config store, so each one leaves a version
 * behind. A toggle nobody can account for three weeks later is the toggle
 * somebody will swear they never touched.
 */
router.post('/:slug/enable', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.AUTOMATION_ADMIN);

  const slug = ruleSlugSchema.parse(req.params.slug);
  toggleRuleSchema.parse(req.body ?? {});
  sendOk(res, await setRuleEnabled(actor, slug, true));
}));

router.post('/:slug/disable', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.AUTOMATION_ADMIN);

  const slug = ruleSlugSchema.parse(req.params.slug);
  toggleRuleSchema.parse(req.body ?? {});
  sendOk(res, await setRuleEnabled(actor, slug, false));
}));

/**
 * Close a tripped circuit breaker.
 *
 * A breaker that can only be cleared by restarting the process is a breaker
 * that gets worked around by restarting the process, which throws away every
 * other rule's state at the same time.
 */
router.post('/:slug/reset-breaker', wrap(async (req, res) => {
  const actor = await resolveActor(req);
  requireCapability(actor, CAPABILITIES.AUTOMATION_ADMIN);

  const slug = ruleSlugSchema.parse(req.params.slug);
  resetRuleBreaker(actor.tenantId, slug);
  sendOk(res, { slug, breaker: null, reset: true });
}));

export { router as rulesRouter };
export default router;
