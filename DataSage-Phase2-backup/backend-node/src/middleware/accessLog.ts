import type { NextFunction, Request, Response } from "express";
import { logger } from "../logger.js";

/**
 * Logs one structured line per completed request. Registered after
 * requestId so req.id is always available.
 */
export function accessLog(req: Request, res: Response, next: NextFunction) {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.info(
      {
        requestId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      },
      `${req.method} ${req.path} ${res.statusCode}`
    );
  });

  next();
}
