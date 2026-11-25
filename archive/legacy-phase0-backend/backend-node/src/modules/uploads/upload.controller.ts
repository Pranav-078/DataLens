import type { Request, Response } from "express";
import multer from "multer";
import { config } from "../../config.js";
import { validateUploadBatch } from "./upload.validator.js";
import { callProfilerStub } from "./profilerClient.js";

/**
 * Buffers files in memory rather than to disk — appropriate at this file
 * size cap (50MB default), and means a rejected upload leaves nothing on
 * disk to clean up. `limits.fileSize` is a second, independent cap enforced
 * by multer itself before our validator even sees the file, so a
 * deliberately huge upload is rejected before it's fully buffered.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_SIZE_BYTES, files: config.MAX_FILES_PER_UPLOAD },
});

export const uploadMiddleware = upload.array("files");

/**
 * Validation-only handler for this phase: runs every check in
 * upload.validator.ts and returns what WOULD be created, without writing
 * to disk or the database. Phase 1 adds persistence and the call into the
 * profiling service on top of this same validation step.
 */
export async function postUploadValidate(req: Request, res: Response) {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];

  const validated = await validateUploadBatch(
    files.map((f) => ({ originalFilename: f.originalname, buffer: f.buffer }))
  );

  // Calls the Python service's stub endpoint so the profiler's failure
  // modes (unavailable/timeout/501/bad response/5xx) are exercised through
  // the real upload flow, not just in isolation. If this throws, it's an
  // AppError with one of the PROFILER_* codes — asyncHandler forwards it
  // to errorHandler, and the client's files are NOT lost: validation
  // already succeeded and nothing has been persisted to disk/DB yet in
  // this phase, so there is nothing to roll back.
  const profilerResult = await callProfilerStub(validated.length);

  res.status(200).json({
    status: "validated",
    profiler: profilerResult,
    fileCount: validated.length,
    files: validated.map((f) => ({
      originalFilename: f.originalFilename,
      tableName: f.tableName,
      sizeBytes: f.sizeBytes,
      rowCount: f.rowCount,
      columnCount: f.columnNames.length,
      columnNames: f.columnNames,
      checksumSha256: f.checksumSha256,
    })),
  });
}
