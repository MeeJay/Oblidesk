/**
 * sla.validators.ts — the HTTP boundary for `/api/sla`.
 *
 * Same three jobs as `config.validators.ts`, and it deliberately REUSES that
 * file's actor assembly and envelope rather than growing a second copy:
 * `resolveActor`, `requireCapability`, `sendOk`, `sendList` and
 * `handleServiceError` are imported, not reimplemented. Two actor resolvers
 * would eventually disagree about what a capability means, and the disagreement
 * would be a privilege bug rather than a style problem.
 *
 * What IS here:
 *   • the zod schemas for this router's five requests;
 *   • `handleSlaError`, which adds this slice's one error class to the shared
 *     translation and then delegates;
 *   • `describeTargetIssues`, the one place a runtime SLA validation finding is
 *     turned into the `{ key, fallback }` pair HARD RULE 10 asks for.
 *
 * ── On query parameters and why there are so few ─────────────────────────────
 * `/api/sla/at-risk` is a board query, and a board query is exactly the shape
 * that tempts an API into accepting a filter object. It does not: it accepts a
 * horizon in minutes, an optional queue slug, an optional assignee, a limit and
 * a boolean. Everything else the Shift Board needs, it gets by asking for the
 * ticket. A reporting endpoint that accepts a filter tree accepts SQL by a
 * slower route (see `metrics.routes.ts` for the same argument at length).
 *
 * ── On the double-pause rule, and where it is enforced ───────────────────────
 * "A target may not declare BOTH a business calendar and `outside_hours`" is
 * enforced in TWO places, on purpose, and neither is redundant:
 *
 *   1. `configLinter.service.ts` → `lintSla()` refuses the PUBLISH, with
 *      severity `error` and code `sla_double_pause`. That is the primary gate
 *      and it is where an admin meets the rule.
 *   2. `sla.service.ts` → `validateTarget()` refuses to START A CLOCK on such a
 *      target at runtime.
 *
 * The second exists because the first can be bypassed: a config bundle imported
 * from another tenant, a row written before the linter learned the rule, or a
 * body edited directly in the database all reach the engine without passing the
 * publish gate. A validation that only runs at publish time is a validation
 * that protects the careful path and leaves the careless one wrong — and the
 * failure mode here is a deadline roughly twice as generous as the contract,
 * which nobody notices until it is quoted back at them.
 *
 * This file surfaces finding (2) through the API so the admin screen can show
 * "this target is not running, and here is why" instead of an empty list.
 */

import { z } from 'zod';
import type { Request, Response } from 'express';

import { handleServiceError, sendFail } from './config.validators';
import { SlaNotFoundError, type TargetValidationIssue } from '../services/sla.service';

// The router wants these from one place; re-exporting keeps `sla.routes.ts`
// importing a single validators module, which is the convention every other
// router in this directory follows.
export {
  resolveActor,
  requireCapability,
  sendOk,
  sendList,
  sendFail,
  parseOrThrow,
} from './config.validators';

// ═════════════════════════════════════════════════════════════════════════════
// Primitives
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A slug is the identity every cross-reference uses (HARD RULE 3), so its
 * grammar is checked at the boundary rather than left to `citext` to accept
 * anything with a case-insensitive comparison.
 */
export const slaSlugSchema = z
  .string()
  .trim()
  .min(1, 'A slug is required.')
  .max(128, 'A slug may not exceed 128 characters.')
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'A slug may contain letters, digits, hyphens and underscores only.');

export const idParamSchema = z.coerce
  .number()
  .int('An id must be a whole number.')
  .positive('An id must be positive.');

/** `?ticketId=42`. Required: an instance list with no ticket is a table scan. */
export const instancesQuerySchema = z.object({
  ticketId: z.coerce.number().int().positive({
    message: 'ticketId is required — SLA instances are always read for one ticket.',
  }),
});

export const instanceParamSchema = z.object({
  id: idParamSchema,
});

/**
 * The manual pause / resume body.
 *
 * `note` is optional in the schema and effectively mandatory in practice: the
 * ledger row carries it, and a manual pause with no explanation is the kind of
 * evidence that loses an argument rather than winning one. It is not enforced
 * here because HARD RULE 12 puts required-ness at a state transition, not at an
 * inline action — and because refusing the pause would leave the clock running
 * while the agent hunts for wording.
 */
export const pauseResumeSchema = z.object({
  note: z.string().trim().max(2000, 'A note may not exceed 2000 characters.').optional(),
});

export const atRiskQuerySchema = z.object({
  /**
   * Horizon in WALL-CLOCK minutes. Capped at a week: past that the question is
   * not "who is about to be late", it is a report, and reports go through
   * `/api/metrics` where the aggregation is registered.
   */
  withinMinutes: z.coerce.number().int().min(1).max(10_080).optional().default(120),
  includeBreached: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((value) => (value === undefined ? true : value === true || value === 'true' || value === '1')),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  queueSlug: slaSlugSchema.optional(),
  assigneeId: z.coerce.number().int().positive().optional(),
});

export const policiesQuerySchema = z.object({
  /** Include policies whose body the parser could not fully read. */
  includeProblems: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((value) => value === true || value === 'true' || value === '1'),
});

export type InstancesQuery = z.infer<typeof instancesQuerySchema>;
export type AtRiskQuery = z.infer<typeof atRiskQuerySchema>;
export type PauseResumeBody = z.infer<typeof pauseResumeSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// Errors
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One translation from this slice's errors to HTTP, delegating everything it
 * does not own.
 *
 * `SlaNotFoundError` is answered as a plain 404 rather than a 403: the query
 * that produced it was already tenant-scoped, so a miss means the instance does
 * not exist in THIS tenant, and there is nothing to leak by saying so.
 */
export function handleSlaError(res: Response, error: unknown): void {
  if (error instanceof SlaNotFoundError) {
    sendFail(res, error.status, error.message, { code: error.code });
    return;
  }
  handleServiceError(res, error);
}

/** Wrap an async handler so a rejected promise becomes an envelope, not a hang. */
export function wrapSla(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((error: unknown) => handleSlaError(res, error));
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// i18n-ready findings (HARD RULE 10)
// ═════════════════════════════════════════════════════════════════════════════

export interface ApiValidationIssue {
  targetSlug: string;
  code: TargetValidationIssue['code'];
  severity: TargetValidationIssue['severity'];
  /** i18n key the client looks up. */
  messageKey: string;
  /** French copy the client falls back to — `t(key, fallback)`. */
  message: string;
  /** English, for logs and for an operator reading the raw response. */
  messageEn: string;
}

/**
 * Turn engine findings into the `{ key, fallback }` shape the client's `t()`
 * expects. The FRENCH string is the fallback, not the English one: the desk
 * ships `fr` and `en`, French is the default locale, and a missing key must
 * degrade to the language most of its users read.
 */
export function describeTargetIssues(issues: readonly TargetValidationIssue[]): ApiValidationIssue[] {
  return issues.map((issue) => ({
    targetSlug: issue.targetSlug,
    code: issue.code,
    severity: issue.severity,
    messageKey: issue.messageKey,
    message: issue.messageFr,
    messageEn: issue.message,
  }));
}
