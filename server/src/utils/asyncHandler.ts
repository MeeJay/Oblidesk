/**
 * asyncHandler.ts — the wrapper that stops a rejected promise from hanging a
 * request forever.
 *
 * Express 4 does not await a handler's return value. An `async` handler that
 * throws therefore produces an unhandled rejection and a request that never
 * responds — the client sits on a spinner until it times out, and the error
 * never reaches `errorHandler`. Wrapping is not a style preference; it is the
 * difference between a 500 with a logged stack and a silent hang.
 *
 *   router.get('/', asyncHandler(async (req, res) => { … }));
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Same wrapper for `(err, req, res, next)` error middleware. */
type AsyncErrorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

export function asyncErrorHandler(handler: AsyncErrorHandler) {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(err, req, res, next)).catch(next);
  };
}

export default asyncHandler;
