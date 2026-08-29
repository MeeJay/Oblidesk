/**
 * rule.validators.ts — the HTTP boundary for `/api/rules`.
 *
 * Three deliberate boundaries, and the third is the interesting one:
 *
 *  1. SHAPE. zod, one schema per request, so a malformed body is a 400 with
 *     field errors rather than a 500 from somewhere deep in the engine.
 *
 *  2. SIZE. Every list has a cap and every sample has a ceiling. A simulation
 *     is a loop over real tickets running real rules; "replay 100 000 tickets"
 *     is not a request, it is an outage with a friendly URL.
 *
 *  3. NOT SEMANTICS. What is deliberately absent here: any check that a slug
 *     resolves, that an action's parameters make sense, or that a condition can
 *     ever match. Those belong to `configLinter.service.ts` (at publish time)
 *     and to `ruleActions.ts` (at run time), and duplicating them here would
 *     produce two answers to one question — which, the first time they
 *     disagree, is worse than having no check at all. The candidate body a
 *     simulation carries is checked for STRUCTURE only, because the whole point
 *     of simulating a draft is to find out what is wrong with it.
 *
 * The actor, the envelope and the service-error translation are shared with the
 * rest of the configuration slice — see `config.validators.ts`. They are
 * re-exported at the bottom so a route file imports one module, not two.
 */

import { z } from 'zod';

import { RULE_TRIGGERS } from '../services/rule.service';
import { DEFAULT_SAMPLE_SIZE, MAX_SAMPLE_SIZE } from '../services/ruleSimulator.service';

// ═════════════════════════════════════════════════════════════════════════════
// Primitives
// ═════════════════════════════════════════════════════════════════════════════

/**
 * HARD RULE 3 — a slug is the identity every cross-reference uses, so its
 * grammar is enforced at the edge rather than left to `citext` to accept
 * anything that compares case-insensitively.
 */
export const ruleSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    'A rule slug is lowercase letters, digits, hyphen and underscore, starting with a letter or digit.',
  );

const triggerSchema = z.enum(RULE_TRIGGERS as unknown as [string, ...string[]]);

const statusCategorySchema = z.enum([
  'new',
  'open',
  'pending_requester',
  'pending_third_party',
  'scheduled',
  'resolved',
  'closed',
  'cancelled',
]);

/**
 * A condition tree arrives as opaque JSON and is validated structurally by
 * `isConditionNode` inside the engine. A zod schema here would have to encode
 * the recursion twice and would STILL not catch an unknown operator, so it
 * would add maintenance without adding safety.
 */
const conditionSchema = z.unknown().nullable().optional();

const isoDate = z.string().datetime({ offset: true }).or(z.string().min(8));

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/rules
// ═════════════════════════════════════════════════════════════════════════════

export const listRulesQuerySchema = z.object({
  /** Only rules that answer this trigger. */
  trigger: triggerSchema.optional(),
  /** Include the ones that are switched off. Default true — the list is the list. */
  includeDisabled: z.coerce.boolean().optional(),
  /** Attach run/match/error counts from `rule_executions`. Costs one query. */
  withHealth: z.coerce.boolean().optional(),
  /** Days of history the health counters cover. */
  healthWindowDays: z.coerce.number().int().min(1).max(365).optional(),
});

export type ListRulesQuery = z.infer<typeof listRulesQuerySchema>;

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/rules  (reorder)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The order arrives as a complete, ordered list of slugs — not as a set of
 * `{slug, position}` pairs.
 *
 * That is the difference between "here is the list" and "here are some edits to
 * the list", and only the first is race-free: two admins dragging rows at the
 * same time with pairwise positions produce an order neither of them chose,
 * while a whole-list write means the second one simply wins and can see that it
 * did.
 */
export const reorderRulesSchema = z
  .union([
    z.object({ order: z.array(ruleSlugSchema).min(1).max(500) }),
    z.array(ruleSlugSchema).min(1).max(500),
  ])
  .transform((value) => (Array.isArray(value) ? { order: value } : value));

export type ReorderRulesInput = z.infer<typeof reorderRulesSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/rules/:slug/enable | /disable
// ═════════════════════════════════════════════════════════════════════════════

export const toggleRuleSchema = z
  .object({
    /** Written into the config version note, so the toggle is accountable. */
    reason: z.string().trim().max(500).optional(),
  })
  .optional()
  .default({});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/rules/simulate
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The candidate body: STRUCTURE only.
 *
 * `.passthrough()` is load-bearing. The engine reads two dialects (the shared
 * `RuleBody` and the snake_case one the shipped baseline is written in), and a
 * strict schema here would strip the keys of whichever dialect it did not
 * happen to enumerate — producing a simulation of a rule the author did not
 * write, which is the single most dangerous thing this endpoint could do.
 */
export const candidateRuleBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    triggers: z.array(z.string()).max(32).optional(),
    trigger: z.unknown().optional(),
    when: conditionSchema,
    condition: conditionSchema,
    actions: z.array(z.unknown()).max(100).optional(),
    order: z.number().optional(),
    priority: z.number().optional(),
    stopProcessing: z.boolean().optional(),
    stop_processing: z.boolean().optional(),
    runOnce: z.boolean().optional(),
    once_per_ticket: z.boolean().optional(),
    cooldownMinutes: z.number().optional(),
    cooldown_minutes: z.number().optional(),
    dryRun: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    schedule: z.unknown().optional(),
  })
  .passthrough();

export const simulateRulesSchema = z
  .object({
    ruleSlugs: z.array(ruleSlugSchema).max(100).optional(),
    candidate: z
      .object({
        slug: ruleSlugSchema,
        name: z.string().trim().min(1).max(191).optional(),
        body: candidateRuleBodySchema,
      })
      .optional(),
    sampleSize: z.coerce.number().int().min(1).max(MAX_SAMPLE_SIZE).optional()
      .default(DEFAULT_SAMPLE_SIZE),
    trigger: triggerSchema.optional().default('ticket_created'),
    filter: conditionSchema,
    queueSlugs: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
    statusCategories: z.array(statusCategorySchema).max(16).optional(),
    createdFrom: isoDate.optional(),
    createdTo: isoDate.optional(),
    /**
     * Write the dry-run rows to `rule_executions`. On by default: the log ships
     * with the engine, and a simulation somebody has to defend a decision with
     * is one they can point at afterwards.
     */
    recordLog: z.boolean().optional().default(true),
  })
  .refine(
    (value) => (value.ruleSlugs?.length ?? 0) > 0 || value.candidate !== undefined,
    {
      message:
        'Name the rules to simulate, or supply a candidate body. Simulating the entire list against every '
        + 'ticket is a report, not a question, and it is slow enough that nobody waits for the answer.',
      path: ['ruleSlugs'],
    },
  );

export type SimulateRulesInput = z.infer<typeof simulateRulesSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/rules/executions
// ═════════════════════════════════════════════════════════════════════════════

export const executionsQuerySchema = z.object({
  /** Filter by rule (HARD RULE 3 — by slug). */
  ruleSlug: ruleSlugSchema.optional(),
  ticketId: z.coerce.number().int().positive().optional(),
  /** true = only the rules that fired; false = only the ones that did not. */
  matched: z.coerce.boolean().optional(),
  /** Simulations are excluded by default — they are not what the desk did. */
  dryRun: z.coerce.boolean().optional(),
  /** The "what is broken" filter. */
  errorsOnly: z.coerce.boolean().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type ExecutionsQuery = z.infer<typeof executionsQuerySchema>;

// ═════════════════════════════════════════════════════════════════════════════
// Shared boundary helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Re-exported from the configuration slice rather than reimplemented: one
 * actor assembly, one envelope, one error translation. A second `resolveActor`
 * is a second answer to "who is this?", and the two would diverge on the day
 * somebody adds a capability source to only one of them.
 */
export {
  handleServiceError,
  parseOrThrow,
  requireCapability,
  resolveActor,
  sendFail,
  sendList,
  sendOk,
} from './config.validators';
