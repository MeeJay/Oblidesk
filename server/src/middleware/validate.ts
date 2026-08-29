/**
 * validate.ts — zod at the edge.
 *
 * The schema modules are shared between client and server on purpose (see the
 * Hard Rules): the form that greys out a Save button and the route that refuses
 * the request must agree, and the only way to guarantee that is one schema
 * imported twice.
 *
 * On success the PARSED value replaces the raw one — so a handler downstream
 * sees numbers where the query string had strings, defaults filled in, and
 * unknown keys stripped by whatever `.strict()`/`.strip()` the schema chose.
 * That is the point: validation that does not narrow the value it validated
 * leaves every handler re-parsing.
 *
 * HARD RULE 12 lives at the call site, not here: an inline field edit validates
 * TYPE (a date is a date) and never REQUIRED-NESS. Required-ness belongs to the
 * transition evaluator, which runs on both sides.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodError, ZodTypeAny, z } from 'zod';

export type ValidationSource = 'body' | 'query' | 'params';

/** Flatten a zod error into the `fieldErrors` map the API envelope carries. */
export function toFieldErrors(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    // `path` is empty for a whole-object refinement — file it under '_'.
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    if (out[key] === undefined) out[key] = issue.message;
  }
  return out;
}

/**
 * Validate one part of the request.
 *
 *   router.post('/', validate(createTicketSchema), handler);
 *   router.get('/', validate(listQuerySchema, 'query'), handler);
 */
export function validate(schema: ZodTypeAny, source: ValidationSource = 'body'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        code: 'validation_failed',
        fieldErrors: toFieldErrors(result.error),
      });
      return;
    }

    // Express 4 exposes `query` as a settable own property on the request, so
    // the parsed value replaces the raw one for every source alike. (Express 5
    // makes `query` a getter — if this server is ever upgraded, that line is
    // the one that breaks, loudly, right here.)
    (req as unknown as Record<ValidationSource, unknown>)[source] = result.data;
    next();
  };
}

/** Sugar, for routes that read better without the second argument. */
export const validateBody = (schema: ZodTypeAny): RequestHandler => validate(schema, 'body');
export const validateQuery = (schema: ZodTypeAny): RequestHandler => validate(schema, 'query');
export const validateParams = (schema: ZodTypeAny): RequestHandler => validate(schema, 'params');

/**
 * Parse a value inside a handler, throwing the same 400 shape the middleware
 * would have produced. For the cases where the schema depends on something only
 * the handler knows — the form a ticket was filed on, say, which decides which
 * custom fields are legal.
 */
export function parseOrThrow<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Imported lazily to keep this module free of a cycle through errorHandler.
    const { AppError } = require('./errorHandler') as typeof import('./errorHandler');
    throw new AppError(400, 'Validation failed', {
      code: 'validation_failed',
      fieldErrors: toFieldErrors(result.error),
    });
  }
  return result.data;
}
