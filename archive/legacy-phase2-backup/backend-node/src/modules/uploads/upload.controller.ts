import type { Request, Response } from "express";
import multer from "multer";
import { config } from "../../config.js";
import { validateUploadBatch } from "./upload.validator.js";
import { processUpload } from "../../services/uploadProfilingService.js";
import { prisma } from "../../db/prisma.js";
import type { ProfilingDb } from "../../repo/types.js";

/**
 * Buffers files in memory rather than to disk — appropriate at this file
 * size cap (50MB default). The real, permanent on-disk copy is written by
 * uploadProfilingService.ts once a version/job exist to write it under.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_SIZE_BYTES, files: config.MAX_FILES_PER_UPLOAD },
});

export const uploadMiddleware = upload.array("files");

/**
 * Validates the upload, then runs the full persistence pipeline: project
 * resolution, version/job creation, real profiling, and persisting the
 * outcome — see services/uploadProfilingService.ts for the exact sequence
 * and its transaction boundaries.
 *
 * `projectId` is an optional multipart text field. See
 * repo/profilingRepo.ts's findOrCreateProject for the documented behavior
 * when it's omitted (a new project is created) versus supplied but
 * nonexistent (a real 404, not silently created).
 *
 * The `prisma as unknown as ProfilingDb` cast below is explained in
 * repo/types.ts's module docstring: this codebase's sandbox has never
 * generated a real Prisma client (the engine binary host is unreachable
 * here), so the generated client's TYPES are a stale placeholder missing
 * our real models — this cast exists to satisfy that CI environment's
 * type-checker, not because the real, correctly-generated PrismaClient
 * needs it. A real generated client structurally satisfies ProfilingDb on
 * its own.
 */
export async function postUploadValidate(req: Request, res: Response) {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : undefined;

  const validated = await validateUploadBatch(
    files.map((f) => ({ originalFilename: f.originalname, buffer: f.buffer }))
  );

  const result = await processUpload(prisma as unknown as ProfilingDb, {
    projectId,
    validatedFiles: validated,
    buffers: files.map((f) => f.buffer),
  });

  res.status(200).json({
    status: "profiled",
    projectId: result.projectId,
    versionId: result.versionId,
    jobId: result.jobId,
    versionNumber: result.versionNumber,
    fileCount: result.fileCount,
    files: result.files.map((f) => ({
      originalFilename: f.originalFilename,
      tableName: f.tableName,
      sizeBytes: f.sizeBytes,
      rowCount: f.rowCount,
      columnCount: f.columnNames.length,
      columnNames: f.columnNames,
      checksumSha256: f.checksumSha256,
    })),
    profiling: {
      findingCount: result.findingCount,
      issueCount: result.issueCount,
    },
  });
}
