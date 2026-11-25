import { Errors } from "../errors/AppError.js";
import type {
  ProfilingDb,
  ProjectRow,
  DatasetVersionRow,
  DatasetTableRow,
  DatasetColumnRow,
  ColumnStatisticsRow,
  QualityIssueRow,
  InferredRelationshipRow,
  QualityScoreRow,
} from "./types.js";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/**
 * Fetches a project by id, or throws PROJECT_NOT_FOUND. Every other read
 * function in this file that needs a project/version pair calls this (or
 * getVersionScopedToProject below) rather than re-implementing the check,
 * so "never expose data belonging to another project/version" is enforced
 * in exactly one place.
 */
export async function getProjectOrThrow(db: ProfilingDb, projectId: string): Promise<ProjectRow> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) throw Errors.projectNotFound(projectId);
  return project;
}

/**
 * Fetches a version by id AND verifies it belongs to the given project.
 * A version that exists but belongs to a different project throws the
 * exact same VERSION_NOT_FOUND as a version that doesn't exist at all —
 * see Errors.versionNotFound's own comment for why that's deliberate.
 */
export async function getVersionScopedToProject(
  db: ProfilingDb,
  projectId: string,
  versionId: string
): Promise<DatasetVersionRow> {
  const version = await db.datasetVersion.findUnique({ where: { id: versionId } });
  if (!version || version.projectId !== projectId) {
    throw Errors.versionNotFound(versionId);
  }
  return version;
}

export async function listVersionsForProject(
  db: ProfilingDb,
  projectId: string
): Promise<DatasetVersionRow[]> {
  await getProjectOrThrow(db, projectId);
  return db.datasetVersion.findMany({ where: { projectId }, orderBy: { versionNumber: "desc" } });
}

export interface TableWithColumns extends DatasetTableRow {
  columns: (DatasetColumnRow & { statistics: ColumnStatisticsRow | null })[];
}

/**
 * Tables + columns + statistics for one version, assembled from three
 * flat findMany calls joined in memory — the same style already used by
 * profilingRepo.ts's columnIdByTableAndName map, not a new pattern.
 */
export async function getTablesWithColumns(
  db: ProfilingDb,
  projectId: string,
  versionId: string
): Promise<TableWithColumns[]> {
  await getVersionScopedToProject(db, projectId, versionId);

  const tables = await db.datasetTable.findMany({ where: { versionId } });
  if (tables.length === 0) return [];

  const tableIds = tables.map((t) => t.id);
  const columns = await db.datasetColumn.findMany({ where: { tableId: { in: tableIds } } });
  const columnIds = columns.map((c) => c.id);
  const statistics =
    columnIds.length > 0
      ? await db.columnStatistics.findMany({ where: { columnId: { in: columnIds } } })
      : [];

  const statsByColumnId = new Map(statistics.map((s) => [s.columnId, s]));
  const columnsByTableId = new Map<string, (DatasetColumnRow & { statistics: ColumnStatisticsRow | null })[]>();
  for (const col of columns) {
    const enriched = { ...col, statistics: statsByColumnId.get(col.id) ?? null };
    const bucket = columnsByTableId.get(col.tableId);
    if (bucket) bucket.push(enriched);
    else columnsByTableId.set(col.tableId, [enriched]);
  }

  return tables.map((t) => ({ ...t, columns: columnsByTableId.get(t.id) ?? [] }));
}

/** Resolves table/column IDs to human-readable names for one version, so
 * issues/relationships responses can include both the raw ID (stable,
 * for a React key) and a display name (useful without a second request). */
async function buildNameLookup(db: ProfilingDb, versionId: string) {
  const tables = await db.datasetTable.findMany({ where: { versionId } });
  const tableNameById = new Map(tables.map((t) => [t.id, t.tableName]));

  const tableIds = tables.map((t) => t.id);
  const columns =
    tableIds.length > 0 ? await db.datasetColumn.findMany({ where: { tableId: { in: tableIds } } }) : [];
  const columnById = new Map(columns.map((c) => [c.id, { name: c.columnName, tableId: c.tableId }]));

  return { tableNameById, columnById };
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface QualityIssueWithNames extends QualityIssueRow {
  tableName: string | null;
  columnName: string | null;
}

export async function getQualityIssuesPaged(
  db: ProfilingDb,
  projectId: string,
  versionId: string,
  page: number,
  pageSize: number
): Promise<PagedResult<QualityIssueWithNames>> {
  await getVersionScopedToProject(db, projectId, versionId);

  const safePage = Math.max(1, page);
  const safePageSize = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);

  const [totalCount, rows, { tableNameById, columnById }] = await Promise.all([
    db.qualityIssue.count({ where: { versionId } }),
    db.qualityIssue.findMany({
      where: { versionId },
      skip: (safePage - 1) * safePageSize,
      take: safePageSize,
      orderBy: { createdAt: "desc" },
    }),
    buildNameLookup(db, versionId),
  ]);

  const items = rows.map((issue) => ({
    ...issue,
    tableName: issue.tableId ? tableNameById.get(issue.tableId) ?? null : null,
    columnName: issue.columnId ? columnById.get(issue.columnId)?.name ?? null : null,
  }));

  return {
    items,
    page: safePage,
    pageSize: safePageSize,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / safePageSize)),
  };
}

export interface RelationshipWithNames extends InferredRelationshipRow {
  parentTableName: string | null;
  parentColumnName: string | null;
  childTableName: string | null;
  childColumnName: string | null;
}

export async function getRelationships(
  db: ProfilingDb,
  projectId: string,
  versionId: string
): Promise<RelationshipWithNames[]> {
  await getVersionScopedToProject(db, projectId, versionId);

  const [relationships, { tableNameById, columnById }] = await Promise.all([
    db.inferredRelationship.findMany({ where: { versionId } }),
    buildNameLookup(db, versionId),
  ]);

  return relationships.map((rel) => ({
    ...rel,
    parentTableName: tableNameById.get(rel.parentTableId) ?? null,
    parentColumnName: columnById.get(rel.parentColumnId)?.name ?? null,
    childTableName: tableNameById.get(rel.childTableId) ?? null,
    childColumnName: columnById.get(rel.childColumnId)?.name ?? null,
  }));
}

/**
 * Returns null (not a 404) when no score has been computed for this
 * version yet — QualityScore is 1:1-or-nothing with a version (it's only
 * written once profiling completes), so "no score row" is a legitimate,
 * distinct state from "version doesn't exist", which IS a 404 (thrown by
 * getVersionScopedToProject below).
 */
export async function getQualityScore(
  db: ProfilingDb,
  projectId: string,
  versionId: string
): Promise<QualityScoreRow | null> {
  await getVersionScopedToProject(db, projectId, versionId);
  return db.qualityScore.findUnique({ where: { versionId } });
}
