import { Errors } from "../errors/AppError.js";
import type {
  ProfilingDb,
  CreateDatasetTableInput,
  CreateQualityIssueInput,
} from "./types.js";
import type { TableProfileSummary } from "../modules/uploads/profilerClient.js";
import type { AggregatedQualityIssue } from "../modules/uploads/issueAggregation.js";

/**
 * Finds a project by ID if one was supplied, or creates a new one.
 *
 * There is no Projects CRUD API in this codebase yet — building one is
 * out of scope for the profiling persistence pipeline this repo serves.
 * This is the agreed, documented behavior instead: an upload with no
 * projectId gets a fresh, auto-named project; an upload with a projectId
 * that doesn't exist is a real error (PROJECT_NOT_FOUND), not silently
 * auto-created, since silently creating a project under an ID the caller
 * explicitly specified would hide a real mistake on their end.
 */
export async function findOrCreateProject(db: ProfilingDb, projectId?: string) {
  if (!projectId) {
    return db.project.create({ data: { name: `Upload ${new Date().toISOString()}` } });
  }
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw Errors.projectNotFound(projectId);
  }
  return project;
}

export interface TableToCreate {
  tableName: string;
  normalizedName: string;
  originalFilename: string;
  filePath: string;
  rowCount: number;
  columnCount: number;
  fileSizeBytes: bigint;
  checksum: string;
}

/**
 * Creates the DatasetVersion and its Job in one transaction. Deliberately
 * NOT bundled with DatasetTable creation: a table's file_path (NOT NULL in
 * the schema) can only be computed once versionId exists (see
 * storage/paths.ts's rawFilePath, which takes versionId as an input) —
 * so the real sequence has to be version+job first, then write files to
 * disk, then create table rows with their real paths already known. See
 * createDatasetTables below for the second half.
 */
export async function createVersionAndJob(
  db: ProfilingDb,
  params: { projectId: string }
): Promise<{ versionId: string; jobId: string; versionNumber: number }> {
  return db.$transaction(async (tx) => {
    const latest = await tx.datasetVersion.findFirst({
      where: { projectId: params.projectId },
      orderBy: { versionNumber: "desc" },
    });
    const versionNumber = (latest?.versionNumber ?? 0) + 1;

    const version = await tx.datasetVersion.create({
      data: { projectId: params.projectId, versionNumber, status: "profiling" },
    });

    const job = await tx.job.create({
      data: {
        projectId: params.projectId,
        versionId: version.id,
        jobType: "profile_version",
        status: "running",
        startedAt: new Date(),
      },
    });

    return { versionId: version.id, jobId: job.id, versionNumber };
  });
}

/**
 * Creates one DatasetTable row per uploaded file, once real on-disk file
 * paths are known (see createVersionAndJob's docstring for why this can't
 * happen earlier). Still one transaction: either every table row for this
 * version commits, or none do.
 */
export async function createDatasetTables(
  db: ProfilingDb,
  params: { versionId: string; tables: TableToCreate[] }
): Promise<{ tableIdByName: Record<string, string> }> {
  return db.$transaction(async (tx) => {
    const tableIdByName: Record<string, string> = {};
    for (const table of params.tables) {
      const input: CreateDatasetTableInput = {
        versionId: params.versionId,
        tableName: table.tableName,
        normalizedName: table.normalizedName,
        originalFilename: table.originalFilename,
        filePath: table.filePath,
        rowCount: table.rowCount,
        columnCount: table.columnCount,
        fileSizeBytes: table.fileSizeBytes,
        checksum: table.checksum,
      };
      const created = await tx.datasetTable.create({ data: input });
      tableIdByName[table.tableName] = created.id;
    }
    return { tableIdByName };
  });
}

/**
 * Persists the real profiling outcome — columns, column statistics, and
 * aggregated quality issues — and marks the version/job as succeeded, all
 * in one transaction. Atomic for the same reason as above: a version
 * marked "ready" must actually have its columns/issues committed, not be
 * ready in name only because the process died partway through writing them.
 */
export async function persistProfilingOutcome(
  db: ProfilingDb,
  params: {
    versionId: string;
    jobId: string;
    tableIdByName: Record<string, string>;
    tableProfiles: TableProfileSummary[];
    aggregatedIssues: AggregatedQualityIssue[];
  }
): Promise<void> {
  await db.$transaction(async (tx) => {
    // Columns + statistics, from Phase 1's own computed per-column profile.
    const columnIdByTableAndName: Record<string, string> = {};
    for (const table of params.tableProfiles) {
      const tableId = params.tableIdByName[table.tableName];
      if (!tableId) continue; // defensive: a table Python profiled that Node didn't create a row for

      let ordinal = 0;
      for (const col of table.columns) {
        const column = await tx.datasetColumn.create({
          data: {
            tableId,
            columnName: col.columnName,
            ordinalPosition: ordinal++,
            inferredType: col.inferredType,
          },
        });
        columnIdByTableAndName[`${table.tableName}\u0000${col.columnName}`] = column.id;

        // uniquenessRatio can be null (Phase 1 reports this when a column
        // has zero non-null values — see profile_tables.py) — statistics
        // are only written when there's a real ratio to store, since
        // ColumnStatistics.uniquenessRatio is NOT NULL in the schema.
        if (col.uniquenessRatio !== null) {
          await tx.columnStatistics.create({
            data: {
              columnId: column.id,
              nullCount: col.nullCount,
              nullPercentage: col.nullPercentage,
              distinctCount: col.distinctCount,
              uniquenessRatio: col.uniquenessRatio,
            },
          });
        }
      }
    }

    // Aggregated quality issues.
    for (const issue of params.aggregatedIssues) {
      const tableId = params.tableIdByName[issue.tableName] ?? null;
      const columnId = issue.columnName
        ? columnIdByTableAndName[`${issue.tableName}\u0000${issue.columnName}`] ?? null
        : null;

      const input: CreateQualityIssueInput = {
        versionId: params.versionId,
        tableId,
        columnId,
        issueType: issue.issueType,
        dimension: issue.dimension,
        severity: issue.severity,
        title: issue.title,
        description: issue.description,
        affectedRows: issue.affectedRows,
        totalRows: issue.totalRows,
        affectedPercentage: issue.affectedPercentage,
        examples: issue.examples,
        evidence: issue.evidence,
        fingerprint: issue.fingerprint,
      };
      await tx.qualityIssue.create({ data: input });
    }

    await tx.datasetVersion.update({ where: { id: params.versionId }, data: { status: "ready" } });
    await tx.job.update({
      where: { id: params.jobId },
      data: { status: "succeeded", progressPercent: 100, finishedAt: new Date() },
    });
  });
}

/**
 * Marks a version/job as failed. Called from the service's catch block
 * after something in the pipeline threw — deliberately its own small
 * transaction (version + job move to failed together), separate from
 * whatever transaction was in flight when the failure happened, since
 * that one either already rolled back or never started.
 *
 * This function is explicitly the mechanism that prevents the "orphaned/
 * inconsistent Job or DatasetVersion state" this step's requirements
 * warn about: without it, a profiler failure would leave a version stuck
 * at status="profiling" and a job stuck at status="running" forever.
 */
export async function markVersionAndJobFailed(
  db: ProfilingDb,
  params: { versionId: string; jobId: string; errorMessage: string }
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.datasetVersion.update({ where: { id: params.versionId }, data: { status: "failed" } });
    await tx.job.update({
      where: { id: params.jobId },
      data: { status: "failed", errorMessage: params.errorMessage, finishedAt: new Date() },
    });
  });
}
