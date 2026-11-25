import type { NextFunction, Request, Response } from "express";
import { AppError } from "./AppError.js";
import { ErrorCode, ERROR_STATUS } from "./errorCodes.js";
import { logger } from "../logger.js";

/**
 * Single JSON shape for every error response in the API:
 *
 *   { "error": { "code": "...", "message": "...", "details": {...} } }
 *
 * The frontend contract is: switch on `error.code`. Never on `error.message`.
 */
interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    requestId?: string;
  };
}

export function notFoundHandler(req: Request, res: Response) {
  const body: ErrorEnvelope = {
    error: {
      code: ErrorCode.ROUTE_NOT_FOUND,
      message: `No route matches ${req.method} ${req.path}.`,
      details: { method: req.method, path: req.path },
      requestId: req.id,
    },
  };
  res.status(ERROR_STATUS.ROUTE_NOT_FOUND).json(body);
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    // Expected failure. Log at `warn` for 4xx (client's fault) and `error`
    // for 5xx (our fault) — this split is what makes log volume meaningful.
    const level = err.status >= 500 ? "error" : "warn";
    logger[level](
      {
        requestId: req.id,
        code: err.code,
        status: err.status,
        details: err.details,
        cause: err.cause instanceof Error ? err.cause.message : err.cause,
      },
      err.message
    );

    const body: ErrorEnvelope = {
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        requestId: req.id,
      },
    };
    return res.status(err.status).json(body);
  }

  // Unexpected failure: something we did not anticipate. Full detail goes
  // to the log only. The client gets a generic message and a request ID
  // they can hand back to us — this is the whole point of the request ID.
  logger.error({ requestId: req.id, err }, "Unhandled exception");

  const body: ErrorEnvelope = {
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: "An unexpected error occurred. Please try again.",
      details: {},
      requestId: req.id,
    },
  };
  res.status(500).json(body);
}
