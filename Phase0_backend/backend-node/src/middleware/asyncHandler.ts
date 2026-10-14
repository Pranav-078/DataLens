import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Express 4 does not forward a rejected promise from an async route
 * handler to the error-handling middleware — it needs `next(err)` called
 * explicitly, or the request just hangs. Every async handler in this app
 * must be wrapped with this.
 */
export function asyncHandler(handler: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
