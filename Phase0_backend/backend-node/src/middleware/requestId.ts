import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Must be the first middleware registered. Every subsequent middleware,
 * route handler, and the error handler all rely on `req.id` existing.
 *
 * Uses a client-supplied `x-request-id` if present (useful when a caller
 * wants to correlate their own logs with ours), otherwise generates one.
 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header("x-request-id");
  req.id = incoming && incoming.length > 0 ? incoming : randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
}
