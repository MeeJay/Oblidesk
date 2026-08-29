/**
 * errorHandler.ts — the one place an error becomes a response.
 *
 * The API envelope is fixed by the contract:
 *   success  { success: true,  data: T }
 *   failure  { success: false, error: string, code?, fieldErrors? }
 *
 * Anything that throws inside a route ends up here. Two kinds of error arrive:
 *
 *   • `AppError` and its subclasses — deliberate, carrying a status, a machine
 *     readable `code` the client branches on, and sometimes a payload (the
 *     current row on a 409, the missing fields on a blocked transition).
 *     These are logged at `warn` and their message is sent verbatim.
 *
 *   • Everything else — a bug, a dropped database connection, a null deref.
 *     Logged at `error` WITH the stack, and answered with a generic
 *     "Internal server error". The message of an unexpected error is never
 *     echoed to the client: a pg error text happily quotes the failing SQL,
 *     including column names and sometimes values.
 */
import type { NextFunction, Request, Response } from 'express';
import type { ApiErrorCode } from '@oblidesk/shared';
import { logger } from '../utils/logger';
import { config } from '../config';

/** Deliberate, client-visible failure. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code?: ApiErrorCode;
  readonly fieldErrors?: Record<string, string>;
  /** Extra body merged into the failure envelope (e.g. `current` on a 409). */
  readonly payload?: Record<string, unknown>;

  constructor(
    statusCode: number,
    message: string,
    options?: {
      code?: ApiErrorCode;
      fieldErrors?: Record<string, string>;
      payload?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = options?.code;
    this.fieldErrors = options?.fieldErrors;
    this.payload = options?.payload;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    Error.captureStackTrace?.(this, AppError);
  }
}

// ── Named constructors, so call sites read as intent, not as numbers ─────────

export const badRequest = (message: string, fieldErrors?: Record<string, string>): AppError =>
  new AppError(400, message, { code: 'validation_failed', fieldErrors });

export const unauthorized = (message = 'Authentication required'): AppError =>
  new AppError(401, message, { code: 'unauthenticated' });

export const forbidden = (message = 'Insufficient permissions'): AppError =>
  new AppError(403, message, { code: 'forbidden' });

export const notFound = (message = 'Not found'): AppError =>
  new AppError(404, message, { code: 'not_found' });

export const conflict = (message: string, payload?: Record<string, unknown>): AppError =>
  new AppError(409, message, { code: 'conflict', payload });

/**
 * HARD RULE 7 — a mutation carrying a stale `baseRowVersion` gets a 409 with
 * the CURRENT row in the body, so the client can show a diff instead of
 * clobbering somebody else's edit. The `code` is what the client branches on;
 * it must stay `version_conflict`.
 */
export function versionConflict(
  current: unknown,
  conflictingFields: string[] = [],
  message = 'This ticket changed while you were editing it',
): AppError {
  return new AppError(409, message, {
    code: 'version_conflict',
    payload: { current, conflictingFields },
  });
}

/** A state transition the state machine refuses (HARD RULE 12). */
export function transitionBlocked(
  message: string,
  payload?: Record<string, unknown>,
): AppError {
  return new AppError(422, message, { code: 'transition_blocked', payload });
}

/** A transition blocked specifically because required fields are empty. */
export function requiredFieldsMissing(
  missing: string[],
  message = 'Required fields must be filled before this transition',
): AppError {
  return new AppError(422, message, {
    code: 'required_fields_missing',
    payload: { missingFields: missing },
    fieldErrors: Object.fromEntries(missing.map((field) => [field, 'required'])),
  });
}

// ── 404 for unmatched API routes ─────────────────────────────────────────────

/**
 * Mounted at the end of the `/api` router. Without it an unknown API path falls
 * through to the SPA catch-all and answers `index.html` with a 200 — which the
 * client's axios layer then fails to parse, producing a mystifying "Unexpected
 * token <" instead of a clean 404.
 */
export function apiNotFound(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, `No API route for ${req.method} ${req.originalUrl}`, { code: 'not_found' }));
}

// ── The handler ──────────────────────────────────────────────────────────────

interface FailureBody {
  success: false;
  error: string;
  code?: ApiErrorCode;
  fieldErrors?: Record<string, string>;
  [key: string]: unknown;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Express requires the 4-arity signature; if the response has already begun
  // streaming (a file download that failed mid-flight) the only correct move is
  // to hand it back so Express destroys the socket.
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    const body: FailureBody = { success: false, error: err.message };
    if (err.code) body.code = err.code;
    if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
    if (err.payload) Object.assign(body, err.payload);

    logger.warn(
      {
        status: err.statusCode,
        code: err.code,
        method: req.method,
        path: req.originalUrl,
        userId: req.session?.userId ?? null,
        tenantId: req.tenantId ?? null,
      },
      err.message,
    );

    res.status(err.statusCode).json(body);
    return;
  }

  // Body-parser rejections arrive as a plain Error with a `type` and `status`.
  const maybeParser = err as { type?: string; status?: number; statusCode?: number; message?: string };
  if (maybeParser?.type === 'entity.too.large') {
    res.status(413).json({ success: false, error: 'Request body is too large' });
    return;
  }
  if (maybeParser?.type === 'entity.parse.failed') {
    res.status(400).json({ success: false, error: 'Malformed JSON body', code: 'validation_failed' });
    return;
  }

  // Postgres unique-violation — a race that beat a pre-flight existence check.
  const pg = err as { code?: string; constraint?: string };
  if (pg?.code === '23505') {
    logger.warn({ constraint: pg.constraint, path: req.originalUrl }, 'Unique violation');
    res.status(409).json({
      success: false,
      error: 'That value is already taken',
      code: 'conflict',
    });
    return;
  }
  if (pg?.code === '23503') {
    res.status(400).json({
      success: false,
      error: 'Referenced record does not exist',
      code: 'validation_failed',
    });
    return;
  }

  logger.error(
    {
      err,
      method: req.method,
      path: req.originalUrl,
      userId: req.session?.userId ?? null,
      tenantId: req.tenantId ?? null,
    },
    'Unhandled error',
  );

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: 'internal_error',
    // The real message only in development — a pg error text quotes the failing
    // SQL, column names included.
    ...(config.isDev && maybeParser?.message ? { detail: maybeParser.message } : {}),
  });
}
