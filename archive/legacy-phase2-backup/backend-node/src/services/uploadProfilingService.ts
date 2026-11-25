import { logger } from "../logger.js";
import type { ProfilingDb } from "../repo/types.js";
import {
  findOrCreateProject,
  createVersionAndJob,
  createDatasetTables,
  persistProfilingOutcome,
  markVersionAndJobFailed,
} from "../repo/profilingRepo.js";
import { writeUploadedFiles } from "../storage/writeUploadedFiles.js";
import { profileTables } from "../modules/uploads/profilerClient.js";
import { groupFindingsIntoQualityIssues } from "../modules/uploads/issueAggregation.js";
import type { ValidatedFile } from "../modules/uploads/upload.validator.js";

export interface ProcessUploadInput {
  projectId?: string;
  validatedFiles: ValidatedFile[];
  /** Same order as validatedFiles — the caller (upload.controller.ts)
   * already relies on this exact guarantee when calling profileTables
   * directly; this service depends on the same invariant. */
  buffers: Buffer[];
}

export interface ProcessUploadResult {
  projectId: string;
  versionId: string;
  jobId: string;
  versionNumber: number;
  fileCount: number;
  files: ValidatedFile[];
  findingCount: number;
  issueCount: number;
}

/**
 * The full pipeline this step implements:
 *
 *   validated files (already validated by the caller)
 *   -> find-or-create project
 *   -> create version + job                          (transaction 1)
 *   -> write raw files to disk (real file paths now exist)
 *   -> create table rows with those real paths        (transaction 2)
 *   -> call the real profiler over HTTP                (no transaction — external I/O)
 *   -> aggregate row-level findings into issue-level records
 *   -> persist columns/statistics/issues + mark succeeded (transaction 3)
 *
 * On any failure from directly after version/job creation onward, they are
 * marked failed (best-effort — see the catch block) and the original error
 * is re-thrown unchanged, so asyncHandler -> errorHandler still produces
 * the correct envelope/status code. A failure to RECORD the failure is
 * logged, never swallowed in place of the real error.
 */
export async function processUpload(
  db: ProfilingDb,
  input: ProcessUploadInput
): Promise<ProcessUploadResult> {
  const project = await findOrCreateProject(db, input.projectId);
  const { versionId, jobId, versionNumber } = await createVersionAndJob(db, { projectId: project.id });

  try {
    const written = await writeUploadedFiles(
      project.id,
      versionId,
      input.validatedFiles.map((f, i) => ({ tableName: f.tableName, buffer: input.buffers[i]! }))
    );
    const filePathByTable = Object.fromEntries(written.map((w) => [w.tableName, w.filePath]));
    logger.info({ versionId, fileCount: written.length }, "Uploaded files written to disk");

    const { tableIdByName } = await createDatasetTables(db, {
      versionId,
      tables: input.validatedFiles.map((f) => ({
        tableName: f.tableName,
        normalizedName: f.normalizedName,
        originalFilename: f.originalFilename,
        filePath: filePathByTable[f.tableName]!,
        rowCount: f.rowCount,
        columnCount: f.columnNames.length,
        fileSizeBytes: BigInt(f.sizeBytes),
        checksum: f.checksumSha256,
      })),
    });

    const tablePayloads = input.validatedFiles.map((f, i) => ({
      tableName: f.tableName,
      csvContent: input.buffers[i]!.toString("utf8"),
    }));
    const profilingResult = await profileTables(tablePayloads);

    const tableRowCounts = Object.fromEntries(input.validatedFiles.map((f) => [f.tableName, f.rowCount]));
    const aggregatedIssues = groupFindingsIntoQualityIssues(profilingResult.findings, tableRowCounts);

    await persistProfilingOutcome(db, {
      versionId,
      jobId,
      tableIdByName,
      tableProfiles: profilingResult.tables,
      aggregatedIssues,
    });

    return {
      projectId: project.id,
      versionId,
      jobId,
      versionNumber,
      fileCount: input.validatedFiles.length,
      files: input.validatedFiles,
      findingCount: profilingResult.findingCount,
      issueCount: aggregatedIssues.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await markVersionAndJobFailed(db, { versionId, jobId, errorMessage: message });
    } catch (markFailedErr) {
      logger.error(
        { versionId, jobId, markFailedErr },
        "Failed to mark version/job as failed after a pipeline error — the original error is still being re-thrown"
      );
    }
    throw err;
  }
}
