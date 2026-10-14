import type { Request, Response } from "express";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../logger.js";

// Read once at module load rather than per-request.
const SERVICE_VERSION = "0.1.0";
const startedAt = Date.now();

/**
 * Liveness only: "is the process up and responding." Deliberately does NOT
 * check the database — that's /health/ready, added once db/prisma.ts and
 * the Prisma connection exist. Keeping the two separate means a DB outage
 * shows up as a readiness failure, not a liveness failure, which is the
 * distinction that lets an orchestrator restart the right thing.
 */
export function getHealth(_req: Request, res: Response) {
  res.status(200).json({
    status: "ok",
    version: SERVICE_VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  });
}

/**
 * Readiness: "can this instance actually serve requests." Checks the
 * database is reachable AND that the `vector` extension is installed —
 * a health check that returns 200 unconditionally is decorative, so this
 * one earns its status code.
 *
 * Deliberately does NOT throw into the error-handler pipeline: a failed
 * dependency here is an expected, first-class outcome (503), not an
 * exceptional one, and the response body needs to say specifically which
 * dependency failed rather than a generic error envelope.
 */
export async function getReadiness(_req: Request, res: Response) {
  const checks = { database: "unknown", pgvector: "unknown" } as Record<
    "database" | "pgvector",
    "ok" | "fail" | "unknown"
  >;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch (err) {
    checks.database = "fail";
    logger.error({ err: err instanceof Error ? err.message : err }, "Readiness check: database unreachable");
    return res.status(503).json({ status: "not_ready", checks });
  }

  try {
    const rows = await prisma.$queryRaw<
      { installed: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed`;
    checks.pgvector = rows[0]?.installed ? "ok" : "fail";
  } catch (err) {
    checks.pgvector = "fail";
    logger.error({ err: err instanceof Error ? err.message : err }, "Readiness check: pgvector query failed");
  }

  const allOk = checks.database === "ok" && checks.pgvector === "ok";
  res.status(allOk ? 200 : 503).json({ status: allOk ? "ready" : "not_ready", checks });
}
