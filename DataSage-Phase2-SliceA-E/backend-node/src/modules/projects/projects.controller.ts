import type { Request, Response } from "express";
import { prisma } from "../../db/prisma.js";
import type { ProfilingDb } from "../../repo/types.js";
import {
  getProjectOrThrow,
  getVersionScopedToProject,
  listVersionsForProject,
  getTablesWithColumns,
  getQualityIssuesPaged,
  getRelationships,
  getQualityScore,
  DEFAULT_PAGE_SIZE,
} from "../../repo/queryRepo.js";

/**
 * All seven handlers below are read-only: no writes, no CSV loads, no
 * profiler calls, no score/relationship recalculation — every one of them
 * reads already-persisted data via repo/queryRepo.ts. The `prisma as
 * unknown as ProfilingDb` cast matches upload.controller.ts's own pattern
 * exactly; see repo/types.ts's module docstring for why it's needed.
 */
const db = prisma as unknown as ProfilingDb;

// GET /projects/:projectId
export async function getProjectSummary(req: Request, res: Response) {
  const { projectId } = req.params as { projectId: string };
  const project = await getProjectOrThrow(db, projectId);
  const versions = await listVersionsForProject(db, projectId);

  res.status(200).json({
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    versionCount: versions.length,
    latestVersionNumber: versions[0]?.versionNumber ?? null,
  });
}

// GET /projects/:projectId/versions
export async function listVersions(req: Request, res: Response) {
  const { projectId } = req.params as { projectId: string };
  const versions = await listVersionsForProject(db, projectId);

  res.status(200).json({
    projectId,
    versions: versions.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      status: v.status,
      createdAt: v.createdAt,
    })),
  });
}

// GET /projects/:projectId/versions/:versionId
export async function getVersionDetails(req: Request, res: Response) {
  const { projectId, versionId } = req.params as { projectId: string; versionId: string };
  const version = await getVersionScopedToProject(db, projectId, versionId);

  res.status(200).json({
    id: version.id,
    projectId: version.projectId,
    versionNumber: version.versionNumber,
    status: version.status,
    createdAt: version.createdAt,
  });
}

// GET /projects/:projectId/versions/:versionId/tables
export async function getTables(req: Request, res: Response) {
  const { projectId, versionId } = req.params as { projectId: string; versionId: string };
  const tables = await getTablesWithColumns(db, projectId, versionId);

  res.status(200).json({
    versionId,
    tables: tables.map((t) => ({
      id: t.id,
      tableName: t.tableName,
      originalFilename: t.originalFilename,
      rowCount: t.rowCount,
      columnCount: t.columnCount,
      columns: t.columns.map((c) => ({
        id: c.id,
        columnName: c.columnName,
        ordinalPosition: c.ordinalPosition,
        inferredType: c.inferredType,
        statistics: c.statistics
          ? {
              nullCount: c.statistics.nullCount,
              nullPercentage: c.statistics.nullPercentage,
              distinctCount: c.statistics.distinctCount,
              uniquenessRatio: c.statistics.uniquenessRatio,
            }
          : null,
      })),
    })),
  });
}

/** Parses a pagination query param to a positive integer, falling back to
 * `fallback` for anything missing, non-numeric, or non-positive — never
 * throws, since a malformed page param should just use the default
 * rather than 400 a read-only listing endpoint. */
function parsePositiveIntOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// GET /projects/:projectId/versions/:versionId/issues?page=&pageSize=
export async function getIssues(req: Request, res: Response) {
  const { projectId, versionId } = req.params as { projectId: string; versionId: string };
  const page = parsePositiveIntOr(req.query.page, 1);
  const pageSize = parsePositiveIntOr(req.query.pageSize, DEFAULT_PAGE_SIZE);

  const result = await getQualityIssuesPaged(db, projectId, versionId, page, pageSize);

  res.status(200).json({
    versionId,
    page: result.page,
    pageSize: result.pageSize,
    totalCount: result.totalCount,
    totalPages: result.totalPages,
    issues: result.items.map((i) => ({
      id: i.id,
      tableId: i.tableId,
      tableName: i.tableName,
      columnId: i.columnId,
      columnName: i.columnName,
      issueType: i.issueType,
      dimension: i.dimension,
      severity: i.severity,
      title: i.title,
      description: i.description,
      affectedRows: i.affectedRows,
      totalRows: i.totalRows,
      affectedPercentage: i.affectedPercentage,
      examples: i.examples,
      evidence: i.evidence,
    })),
  });
}

// GET /projects/:projectId/versions/:versionId/relationships
export async function getVersionRelationships(req: Request, res: Response) {
  const { projectId, versionId } = req.params as { projectId: string; versionId: string };
  const relationships = await getRelationships(db, projectId, versionId);

  res.status(200).json({
    versionId,
    relationships: relationships.map((r) => ({
      id: r.id,
      parentTable: r.parentTableName,
      parentColumn: r.parentColumnName,
      childTable: r.childTableName,
      childColumn: r.childColumnName,
      confidence: r.confidence,
      confidenceBand: r.confidenceBand,
      status: r.status,
      valueOverlap: r.valueOverlap,
      orphanCount: r.orphanCount,
      orphanPercentage: r.orphanPercentage,
      orphanExamples: r.orphanExamples,
      evidence: r.evidence,
    })),
  });
}

// GET /projects/:projectId/versions/:versionId/quality-score
export async function getVersionQualityScore(req: Request, res: Response) {
  const { projectId, versionId } = req.params as { projectId: string; versionId: string };
  const score = await getQualityScore(db, projectId, versionId);

  if (!score) {
    res.status(200).json({ versionId, status: "not_computed", score: null });
    return;
  }

  res.status(200).json({
    versionId,
    status: "computed",
    score: {
      overallScore: score.overallScore,
      completeness: score.completeness,
      uniqueness: score.uniqueness,
      validity: score.validity,
      consistency: score.consistency,
      referentialIntegrity: score.referentialIntegrity, // null means N/A — never coerced to 0
      applicableDimensions: score.applicableDimensions,
      weightsUsed: score.weightsUsed,
      capApplied: score.capApplied,
      capReason: score.capReason,
      calculationBreakdown: score.calculationBreakdown,
      severityCounts: {
        critical: score.criticalCount,
        high: score.highCount,
        medium: score.mediumCount,
        low: score.lowCount,
      },
    },
  });
}
