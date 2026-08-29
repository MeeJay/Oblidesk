/**
 * ci.validators.ts — the HTTP boundary for `/api/ci`.
 *
 * Two of the schemas here are load-bearing for more than shape:
 *
 *   {@link ciSourceAppSchema} is THE CLOSED LIST the cross-app proxy is allowed
 *   to name. The browser sends a `ci_id` and one of these five slugs, and
 *   nothing else: no host, no path, no URL, no external id. Those come out of
 *   `ci_source_links` on the server. A proxy holding a privileged app key that
 *   accepted a target from the client would be an SSRF with credentials, so the
 *   vocabulary is enumerated rather than sanitised.
 *
 *   {@link deskFieldsSchema} enumerates the ONLY attributes Oblidesk owns.
 *   Everything else about a machine belongs to the app that owns it and is read
 *   through at render time. A field added here is a claim that the desk is the
 *   source of truth for it, so add one only when that is true.
 *
 * Query parameters arrive as strings, so the list filters go through `csv()`
 * and the boolean preprocessor below; this is the only place that conversion
 * happens.
 */
import { z } from 'zod';
import { CI_SOURCE_APPS, PAGINATION } from '@oblidesk/shared';

import { badRequest } from '../middleware/errorHandler';

// ═════════════════════════════════════════════════════════════════════════════
// Primitives
// ═════════════════════════════════════════════════════════════════════════════

export const idSchema = z.coerce.number().int().positive();

export const ciIdParamSchema = z.object({ id: idSchema });
export const ciTicketParamsSchema = z.object({ id: idSchema, ticketId: idSchema });

/**
 * Mirrors the `cis_kind_ck` / `cis_criticality_ck` CHECK constraints in
 * migration 002. Kept as literal tuples rather than derived from the TS type so
 * a mismatch is a compile error in one file instead of a 23514 at runtime.
 */
export const CI_KINDS = [
  'device',
  'monitor',
  'host',
  'network',
  'service',
  'identity',
  'other',
] as const;

export const CI_CRITICALITIES = ['critical', 'high', 'medium', 'low'] as const;

export const ciKindSchema = z.enum(CI_KINDS);
export const ciCriticalitySchema = z.enum(CI_CRITICALITIES);
export const ticketCiRoleSchema = z.enum(['primary', 'affected', 'cause']);

/** The five apps a CI's live sections may come from. Closed on purpose. */
export const ciSourceAppSchema = z.enum(CI_SOURCE_APPS as unknown as [string, ...string[]]);

/** Query arrays arrive as `a,b,c`, as repeated params, or not at all. */
function csv<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (Array.isArray(value)) return value;
    return String(value)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
  }, z.array(item).optional());
}

/**
 * `z.coerce.boolean()` is a trap for query strings: `Boolean('false')` is
 * `true`, so `?hasOpenTickets=false` would ask for the opposite of what it says.
 * Parse the words people actually type instead.
 */
const boolParam = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  }
  return undefined;
}, z.boolean().optional());

// ═════════════════════════════════════════════════════════════════════════════
// Requests
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `GET /api/ci`.
 *
 * `sortBy` is checked again against the service's whitelist, which is the one
 * that decides. Listing the values here as well keeps an obvious typo a 400
 * with a field error rather than a silent fall back to the default sort.
 */
export const listCisQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  kind: csv(ciKindSchema),
  criticality: csv(ciCriticalitySchema),
  hasOpenTickets: boolParam,
  cursor: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(PAGINATION.maxLimit).optional(),
  sortBy: z
    .enum(['display_name', 'last_seen_at', 'first_seen_at', 'kind', 'criticality', 'id'])
    .optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

/**
 * `PATCH /api/ci/:id` — the desk-owned fields, and only those.
 *
 * `null` clears a field and an absent key leaves it alone, which is why the
 * three are `.nullable().optional()` rather than merely optional: "no owner" and
 * "do not touch the owner" are different requests and a PATCH has to be able to
 * express both.
 */
export const deskFieldsSchema = z
  .object({
    ownerContactId: idSchema.nullable().optional(),
    criticality: ciCriticalitySchema.nullable().optional(),
    supportGroupId: idSchema.nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Send at least one of ownerContactId, criticality or supportGroupId',
  });

/**
 * `PUT /api/ci/:id/overlay` — one desk-owned key/value.
 *
 * The `value` key is OPTIONAL, and its absence is the delete: PUT sets the pair,
 * and a pair with no value is no pair. An explicit `"value": null` is a stored
 * null, which is a different thing and stays stored. The route reads
 * `'value' in body` to tell the two apart, so the distinction survives JSON.
 */
export const setOverlaySchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/,
      'An overlay key is letters, digits, dot, colon, dash and underscore',
    ),
  value: z.unknown().optional(),
});

/** `POST /api/ci/:id/tickets/:ticketId`. Defaults to the honest weak claim. */
export const linkTicketSchema = z.object({
  role: ticketCiRoleSchema.optional(),
});

// ═════════════════════════════════════════════════════════════════════════════
// Parsing
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Parse with a schema, turning a `ZodError` into the 400 the API envelope
 * describes.
 *
 * The shared `errorHandler` does not know `ZodError`, so a bare `.parse()` in a
 * route would surface a validation problem as a 500 with a generic message, and
 * the client would have nothing to point the user at.
 */
export function parseOrBadRequest<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.errors) {
    fieldErrors[issue.path.join('.') || '_'] = issue.message;
  }
  throw badRequest('The request is not valid', fieldErrors);
}
