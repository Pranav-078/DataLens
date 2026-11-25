import { describe, it, expect } from "vitest";
import { createFakeDb } from "./fakeProfilingDb.js";
import {
  findOrCreateProject,
  createVersionAndJob,
  createDatasetTables,
  persistProfilingOutcome,
  markVersionAndJobFailed,
} from "../src/repo/profilingRepo.js";
import { AppError } from "../src/errors/AppError.js";

/**
 * These tests exercise the repo layer directly against the in-memory fake
 * DB defined in fakeProfilingDb.ts — NOT a real PostgreSQL instance. They
 * verify orchestration/business logic (status strings, version numbering,
 * which fields get written) that doesn't depend on Postgres actually
 * existing. They cannot and do not prove real SQL/schema correctness —
 * see this step's final report for what that requires.
 */

describe("findOrCreateProject", () => {
  it("creates a new project when no projectId is given", async () => {
    const db = createFakeDb();
    const project = await findOrCreateProject(db);
    expect(db._fake.projects.has(project.id)).toBe(true);
  });

  it("returns the existing project when a valid projectId is given", async () => {
    const db = createFakeDb();
    const existing = await db.project.create({ data: { name: "Mine" } });
    const found = await findOrCreateProject(db, existing.id);
    expect(found.id).toBe(existing.id);
    expect(db._fake.projects.size).toBe(1);
  });

  it("throws PROJECT_NOT_FOUND for a nonexistent projectId rather than creating one", async () => {
    const db = createFakeDb();
    await expect(findOrCreateProject(db, "nope")).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    } satisfies Partial<AppError>);
    expect(db._fake.projects.size).toBe(0);
  });
});

describe("createVersionAndJob", () => {
  it("creates version 1 for a project's first upload, with status 'profiling'", async () => {
    const db = createFakeDb();
    const project = await db.project.create({ data: { name: "P" } });
    const { versionId, versionNumber } = await createVersionAndJob(db, { projectId: project.id });
    expect(versionNumber).toBe(1);
    expect(db._fake.versions.get(versionId)?.status).toBe("profiling");
  });

  it("increments versionNumber for a second upload to the same project", async () => {
    const db = createFakeDb();
    const project = await db.project.create({ data: { name: "P" } });
    await createVersionAndJob(db, { projectId: project.id });
    const second = await createVersionAndJob(db, { projectId: project.id });
    expect(second.versionNumber).toBe(2);
  });

  it("creates the job with status 'running' and jobType 'profile_version'", async () => {
    const db = createFakeDb();
    const project = await db.project.create({ data: { name: "P" } });
    const { jobId } = await createVersionAndJob(db, { projectId: project.id });
    const job = db._fake.jobs.get(jobId);
    expect(job).toMatchObject({ status: "running", jobType: "profile_version" });
  });

  it("two different projects each start their own versioning at 1", async () => {
    const db = createFakeDb();
    const a = await db.project.create({ data: { name: "A" } });
    const b = await db.project.create({ data: { name: "B" } });
    const va = await createVersionAndJob(db, { projectId: a.id });
    const vb = await createVersionAndJob(db, { projectId: b.id });
    expect(va.versionNumber).toBe(1);
    expect(vb.versionNumber).toBe(1);
  });
});

describe("createDatasetTables", () => {
  it("persists the real file_path supplied — never a placeholder", async () => {
    const db = createFakeDb();
    const project = await db.project.create({ data: { name: "P" } });
    const { versionId } = await createVersionAndJob(db, { projectId: project.id });

    const { tableIdByName } = await createDatasetTables(db, {
      versionId,
      tables: [
        {
          tableName: "customers",
          normalizedName: "customers",
          originalFilename: "customers.csv",
          filePath: "/data/storage/projects/p1/versions/v1/raw/customers.csv",
          rowCount: 10,
          columnCount: 3,
          fileSizeBytes: 1234n,
          checksum: "abc123",
        },
      ],
    });

    const table = db._fake.tables.get(tableIdByName["customers"]!);
    expect(table?.filePath).toBe("/data/storage/projects/p1/versions/v1/raw/customers.csv");
    expect(table?.filePath).not.toBe("");
  });
});

describe("persistProfilingOutcome", () => {
  async function setup() {
    const db = createFakeDb();
    const project = await db.project.create({ data: { name: "P" } });
    const { versionId, jobId } = await createVersionAndJob(db, { projectId: project.id });
    const { tableIdByName } = await createDatasetTables(db, {
      versionId,
      tables: [
        {
          tableName: "customers",
          normalizedName: "customers",
          originalFilename: "customers.csv",
          filePath: "/x/customers.csv",
          rowCount: 5,
          columnCount: 1,
          fileSizeBytes: 10n,
          checksum: "x",
        },
      ],
    });
    return { db, versionId, jobId, tableIdByName };
  }

  it("marks the version 'ready' and the job 'succeeded' on success", async () => {
    const { db, versionId, jobId, tableIdByName } = await setup();
    await persistProfilingOutcome(db, {
      versionId,
      jobId,
      tableIdByName,
      tableProfiles: [],
      aggregatedIssues: [],
      relationships: [],
    });
    expect(db._fake.versions.get(versionId)?.status).toBe("ready");
    expect(db._fake.jobs.get(jobId)?.status).toBe("succeeded");
    expect(db._fake.jobs.get(jobId)?.progressPercent).toBe(100);
  });

  it("creates a DatasetColumn per column and skips ColumnStatistics when uniquenessRatio is null", async () => {
    const { db, versionId, jobId, tableIdByName } = await setup();
    await persistProfilingOutcome(db, {
      versionId,
      jobId,
      tableIdByName,
      tableProfiles: [
        {
          tableName: "customers",
          rowCount: 5,
          columnCount: 1,
          columns: [
            { columnName: "email", inferredType: "string", nullCount: 5, nullPercentage: 100, distinctCount: 0, uniquenessRatio: null },
          ],
        },
      ],
      aggregatedIssues: [],
      relationships: [],
    });
    expect(db._fake.columns.size).toBe(1);
    expect(db._fake.statistics).toHaveLength(0); // null ratio -> no statistics row, per the NOT NULL schema constraint
  });

  it("persists an aggregated issue with the correct fingerprint and resolves its tableId/columnId", async () => {
    const { db, versionId, jobId, tableIdByName } = await setup();
    await persistProfilingOutcome(db, {
      versionId,
      jobId,
      tableIdByName,
      tableProfiles: [
        {
          tableName: "customers",
          rowCount: 5,
          columnCount: 1,
          columns: [
            { columnName: "email", inferredType: "string", nullCount: 1, nullPercentage: 20, distinctCount: 4, uniquenessRatio: 1 },
          ],
        },
      ],
      aggregatedIssues: [
        {
          tableName: "customers",
          columnName: "email",
          issueType: "empty_string",
          dimension: "completeness",
          severity: "medium",
          title: "empty string in customers.email",
          description: "1 of 5 row(s) affected.",
          affectedRows: 1,
          totalRows: 5,
          affectedPercentage: 20,
          examples: ["customers:3"],
          evidence: {},
          fingerprint: "deadbeef",
        },
      ],
      relationships: [],
    });
    expect(db._fake.issues).toHaveLength(1);
    const issue = db._fake.issues[0]!;
    expect(issue.fingerprint).toBe("deadbeef");
    expect(issue.tableId).toBe(tableIdByName["customers"]);
    expect(issue.columnId).toBeTruthy();
  });
});

describe("persistProfilingOutcome — relationship persistence (Slice C)", () => {
  async function setupTwoTables() {
    const db = createFakeDb();
    const project = await db.project.create({ data: { name: "P" } });
    const { versionId, jobId } = await createVersionAndJob(db, { projectId: project.id });
    const { tableIdByName } = await createDatasetTables(db, {
      versionId,
      tables: [
        {
          tableName: "customers",
          normalizedName: "customers",
          originalFilename: "customers.csv",
          filePath: "/x/customers.csv",
          rowCount: 30,
          columnCount: 1,
          fileSizeBytes: 10n,
          checksum: "x",
        },
        {
          tableName: "orders",
          normalizedName: "orders",
          originalFilename: "orders.csv",
          filePath: "/x/orders.csv",
          rowCount: 40,
          columnCount: 1,
          fileSizeBytes: 10n,
          checksum: "y",
        },
      ],
    });
    return { db, versionId, jobId, tableIdByName };
  }

  const baseTableProfiles = [
    {
      tableName: "customers",
      rowCount: 30,
      columnCount: 1,
      columns: [{ columnName: "id", inferredType: "string", nullCount: 0, nullPercentage: 0, distinctCount: 30, uniquenessRatio: 1 }],
    },
    {
      tableName: "orders",
      rowCount: 40,
      columnCount: 1,
      columns: [{ columnName: "customer_id", inferredType: "string", nullCount: 0, nullPercentage: 0, distinctCount: 30, uniquenessRatio: 0.75 }],
    },
  ];

  function makeRelationship(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      parent_table: "customers",
      parent_column: "id",
      child_table: "orders",
      child_column: "customer_id",
      confidence: 0.96,
      confidence_band: "high",
      status: "inferred",
      value_overlap: 0.98,
      orphan_count: 2,
      orphan_percentage: 5.0,
      orphan_examples: ["BAD1", "BAD2"],
      evidence: { containment: 0.98 },
      ...overrides,
    };
  }

  it("persists a relationship returned by Python, with every field resolved and preserved exactly", async () => {
    const { db, versionId, jobId, tableIdByName } = await setupTwoTables();

    const relationshipFromPython = makeRelationship({
      confidence: 0.962,
      confidence_band: "high",
      value_overlap: 0.984,
      orphan_count: 2,
      orphan_percentage: 5.0,
      orphan_examples: ["BAD1", "BAD2"],
      evidence: { containment: 0.984, name_similarity: 1.0, score_terms: { containment: 0.541 } },
    });

    await persistProfilingOutcome(db, {
      versionId,
      jobId,
      tableIdByName,
      tableProfiles: baseTableProfiles,
      aggregatedIssues: [],
      relationships: [relationshipFromPython],
    });

    // Independently derive the expected column IDs from what was actually
    // created (not assumed from generation order), so this is a real
    // equality check, not just a truthiness check.
    const parentColumn = [...db._fake.columns.values()].find(
      (c) => c.tableId === tableIdByName["customers"] && c.columnName === "id"
    );
    const childColumn = [...db._fake.columns.values()].find(
      (c) => c.tableId === tableIdByName["orders"] && c.columnName === "customer_id"
    );
    expect(parentColumn).toBeTruthy();
    expect(childColumn).toBeTruthy();

    expect(db._fake.relationships).toHaveLength(1);
    const rel = db._fake.relationships[0]!;

    // DatasetVersion scoping
    expect(rel.versionId).toBe(versionId);
    // Parent table/column resolved to the correct real IDs
    expect(rel.parentTableId).toBe(tableIdByName["customers"]);
    expect(rel.parentColumnId).toBe(parentColumn!.id);
    // Child table/column resolved to the correct real IDs
    expect(rel.childTableId).toBe(tableIdByName["orders"]);
    expect(rel.childColumnId).toBe(childColumn!.id);
    // Every scored/evidence field preserved exactly as Python produced it
    expect(rel.confidence).toBe(0.962);
    expect(rel.confidenceBand).toBe("high");
    expect(rel.status).toBe("inferred");
    expect(rel.valueOverlap).toBe(0.984);
    expect(rel.orphanCount).toBe(2);
    expect(rel.orphanPercentage).toBe(5.0);
    expect(rel.orphanExamples).toEqual(["BAD1", "BAD2"]);
    expect(rel.evidence).toEqual({
      containment: 0.984,
      name_similarity: 1.0,
      score_terms: { containment: 0.541 },
    });
  });

  it("scopes the persisted relationship to the correct versionId", async () => {
    const { db, versionId, jobId, tableIdByName } = await setupTwoTables();
    await persistProfilingOutcome(db, {
      versionId, jobId, tableIdByName,
      tableProfiles: baseTableProfiles,
      aggregatedIssues: [],
      relationships: [makeRelationship()],
    });
    expect(db._fake.relationships[0]!.versionId).toBe(versionId);
  });

  it("persists multiple relationships from a single profiling run", async () => {
    const { db, versionId, jobId, tableIdByName } = await setupTwoTables();
    await persistProfilingOutcome(db, {
      versionId, jobId, tableIdByName,
      tableProfiles: baseTableProfiles,
      aggregatedIssues: [],
      relationships: [
        makeRelationship({ confidence: 0.96 }),
        makeRelationship({ child_column: "customer_id", confidence: 0.7, confidence_band: "medium" }),
      ],
    });
    expect(db._fake.relationships).toHaveLength(2);
  });

  it("preserves orphan count, percentage, and bounded examples exactly", async () => {
    const { db, versionId, jobId, tableIdByName } = await setupTwoTables();
    await persistProfilingOutcome(db, {
      versionId, jobId, tableIdByName,
      tableProfiles: baseTableProfiles,
      aggregatedIssues: [],
      relationships: [makeRelationship({ orphan_count: 7, orphan_percentage: 17.5, orphan_examples: ["X1", "X2", "X3"] })],
    });
    const rel = db._fake.relationships[0]!;
    expect(rel.orphanCount).toBe(7);
    expect(rel.orphanPercentage).toBe(17.5);
    expect(rel.orphanExamples).toEqual(["X1", "X2", "X3"]);
  });

  it("skips (does not crash) a relationship referencing a table Node never created a row for", async () => {
    const { db, versionId, jobId, tableIdByName } = await setupTwoTables();
    await persistProfilingOutcome(db, {
      versionId, jobId, tableIdByName,
      tableProfiles: baseTableProfiles,
      aggregatedIssues: [],
      relationships: [makeRelationship({ parent_table: "nonexistent_table" })],
    });
    expect(db._fake.relationships).toHaveLength(0); // skipped, not persisted with a broken ID
    expect(db._fake.versions.get(versionId)?.status).toBe("ready"); // and the rest of the run still succeeds
  });

  it("existing Phase 0/1 persistence (columns, statistics, issues, status) still works alongside relationships", async () => {
    const { db, versionId, jobId, tableIdByName } = await setupTwoTables();
    await persistProfilingOutcome(db, {
      versionId, jobId, tableIdByName,
      tableProfiles: baseTableProfiles,
      aggregatedIssues: [
        {
          tableName: "orders",
          columnName: "customer_id",
          issueType: "orphan_like_issue",
          dimension: "validity",
          severity: "medium",
          title: "t",
          description: "d",
          affectedRows: 2,
          totalRows: 40,
          affectedPercentage: 5,
          examples: ["orders:3"],
          evidence: {},
          fingerprint: "fp1",
        },
      ],
      relationships: [makeRelationship()],
    });

    expect(db._fake.columns.size).toBe(2); // one per table in baseTableProfiles
    expect(db._fake.statistics).toHaveLength(2);
    expect(db._fake.issues).toHaveLength(1);
    expect(db._fake.relationships).toHaveLength(1);
    expect(db._fake.versions.get(versionId)?.status).toBe("ready");
    expect(db._fake.jobs.get(jobId)?.status).toBe("succeeded");
  });
});

describe("persistProfilingOutcome — quality score persistence (Slice D)", () => {
  async function setupOneTable() {
    const db = createFakeDb();
    const project = await db.project.create({ data: { name: "P" } });
    const { versionId, jobId } = await createVersionAndJob(db, { projectId: project.id });
    const { tableIdByName } = await createDatasetTables(db, {
      versionId,
      tables: [
        {
          tableName: "customers",
          normalizedName: "customers",
          originalFilename: "customers.csv",
          filePath: "/x/customers.csv",
          rowCount: 50,
          columnCount: 1,
          fileSizeBytes: 10n,
          checksum: "x",
        },
      ],
    });
    return { db, versionId, jobId, tableIdByName };
  }

  const oneTableProfiles = [
    {
      tableName: "customers",
      rowCount: 50,
      columnCount: 1,
      columns: [{ columnName: "email", inferredType: "string", nullCount: 0, nullPercentage: 0, distinctCount: 50, uniquenessRatio: 1 }],
    },
  ];

  it("persists exactly one QualityScore row for the correct versionId, with every field present", async () => {
    const { db, versionId, jobId, tableIdByName } = await setupOneTable();

    await persistProfilingOutcome(db, {
      versionId,
      jobId,
      tableIdByName,
      tableProfiles: oneTableProfiles,
      aggregatedIssues: [],
      relationships: [],
    });

    expect(db._fake.qualityScores).toHaveLength(1);
    const scoreRow = db._fake.qualityScores[0]!;

    expect(scoreRow.versionId).toBe(versionId);
    expect(scoreRow.overallScore).toBe(100);
    expect(scoreRow.completeness).toBe(100);
    expect(scoreRow.uniqueness).toBe(100);
    expect(scoreRow.validity).toBe(100);
    expect(scoreRow.consistency).toBe(100);
    expect(scoreRow.referentialIntegrity).toBeNull();
    expect(scoreRow.applicableDimensions).toEqual([
      "completeness", "validity", "uniqueness", "consistency",
    ]);
    expect(scoreRow.weightsUsed).toBeTruthy();
    expect(scoreRow.capApplied).toBeNull();
    expect(scoreRow.capReason).toBeNull();
    expect(scoreRow.calculationBreakdown).toBeTruthy();
    expect(scoreRow.criticalCount).toBe(0);
    expect(scoreRow.highCount).toBe(0);
    expect(scoreRow.mediumCount).toBe(0);
    expect(scoreRow.lowCount).toBe(0);
  });

  it("persists a degraded score reflecting the version's real aggregated issues", async () => {
    const { db, versionId, jobId, tableIdByName } = await setupOneTable();

    await persistProfilingOutcome(db, {
      versionId,
      jobId,
      tableIdByName,
      tableProfiles: oneTableProfiles,
      aggregatedIssues: [
        {
          tableName: "customers",
          columnName: "email",
          issueType: "empty_string",
          dimension: "completeness",
          severity: "high",
          title: "t",
          description: "d",
          affectedRows: 10,
          totalRows: 50,
          affectedPercentage: 20,
          examples: [],
          evidence: {},
          fingerprint: "fp1",
        },
      ],
      relationships: [],
    });

    const scoreRow = db._fake.qualityScores[0]!;
    expect(scoreRow.completeness).toBeLessThan(100);
    expect(scoreRow.capApplied).toBe(80); // high severity -> capped at 80
    expect(scoreRow.highCount).toBe(1);
  });

  it("persists referentialIntegrity as a real number (not null) when relationships exist for this version", async () => {
    const db = createFakeDb();
    const project = await db.project.create({ data: { name: "P" } });
    const { versionId, jobId } = await createVersionAndJob(db, { projectId: project.id });
    const { tableIdByName } = await createDatasetTables(db, {
      versionId,
      tables: [
        { tableName: "customers", normalizedName: "customers", originalFilename: "c.csv", filePath: "/x/c.csv", rowCount: 30, columnCount: 1, fileSizeBytes: 10n, checksum: "x" },
        { tableName: "orders", normalizedName: "orders", originalFilename: "o.csv", filePath: "/x/o.csv", rowCount: 40, columnCount: 1, fileSizeBytes: 10n, checksum: "y" },
      ],
    });
    const tableProfiles = [
      { tableName: "customers", rowCount: 30, columnCount: 1, columns: [{ columnName: "id", inferredType: "string", nullCount: 0, nullPercentage: 0, distinctCount: 30, uniquenessRatio: 1 }] },
      { tableName: "orders", rowCount: 40, columnCount: 1, columns: [{ columnName: "customer_id", inferredType: "string", nullCount: 0, nullPercentage: 0, distinctCount: 30, uniquenessRatio: 0.75 }] },
    ];

    await persistProfilingOutcome(db, {
      versionId,
      jobId,
      tableIdByName,
      tableProfiles,
      aggregatedIssues: [],
      relationships: [
        {
          parent_table: "customers", parent_column: "id", child_table: "orders", child_column: "customer_id",
          confidence: 0.96, confidence_band: "high", status: "inferred", value_overlap: 0.95,
          orphan_count: 2, orphan_percentage: 5, orphan_examples: [], evidence: {},
        },
      ],
    });

    const scoreRow = db._fake.qualityScores[0]!;
    expect(scoreRow.referentialIntegrity).toBe(95); // 100 * (1 - 0.05)
    expect(scoreRow.applicableDimensions).toContain("referentialIntegrity");
  });

  it("scopes quality scores correctly across two separate versions of the same project", async () => {
    const db = createFakeDb();
    const project = await db.project.create({ data: { name: "P" } });

    const v1 = await createVersionAndJob(db, { projectId: project.id });
    const { tableIdByName: t1 } = await createDatasetTables(db, {
      versionId: v1.versionId,
      tables: [{ tableName: "customers", normalizedName: "customers", originalFilename: "c.csv", filePath: "/x/c1.csv", rowCount: 50, columnCount: 1, fileSizeBytes: 10n, checksum: "x" }],
    });
    await persistProfilingOutcome(db, {
      versionId: v1.versionId, jobId: v1.jobId, tableIdByName: t1,
      tableProfiles: oneTableProfiles, aggregatedIssues: [], relationships: [],
    });

    const v2 = await createVersionAndJob(db, { projectId: project.id });
    const { tableIdByName: t2 } = await createDatasetTables(db, {
      versionId: v2.versionId,
      tables: [{ tableName: "customers", normalizedName: "customers", originalFilename: "c.csv", filePath: "/x/c2.csv", rowCount: 50, columnCount: 1, fileSizeBytes: 10n, checksum: "x" }],
    });
    await persistProfilingOutcome(db, {
      versionId: v2.versionId, jobId: v2.jobId, tableIdByName: t2,
      tableProfiles: oneTableProfiles,
      aggregatedIssues: [{
        tableName: "customers", columnName: "email", issueType: "empty_string", dimension: "completeness",
        severity: "medium", title: "t", description: "d", affectedRows: 5, totalRows: 50, affectedPercentage: 10,
        examples: [], evidence: {}, fingerprint: "fp2",
      }],
      relationships: [],
    });

    expect(db._fake.qualityScores).toHaveLength(2);
    const score1 = db._fake.qualityScores.find((s) => s.versionId === v1.versionId)!;
    const score2 = db._fake.qualityScores.find((s) => s.versionId === v2.versionId)!;
    expect(score1.overallScore).toBe(100); // v1 was clean
    expect(score2.overallScore).toBeLessThan(100); // v2 had an issue
  });
});

describe("markVersionAndJobFailed", () => {
  it("moves both version and job to 'failed' with an error message recorded", async () => {
    const db = createFakeDb();
    const project = await db.project.create({ data: { name: "P" } });
    const { versionId, jobId } = await createVersionAndJob(db, { projectId: project.id });

    await markVersionAndJobFailed(db, { versionId, jobId, errorMessage: "boom" });

    expect(db._fake.versions.get(versionId)?.status).toBe("failed");
    expect(db._fake.jobs.get(jobId)?.status).toBe("failed");
    expect(db._fake.jobs.get(jobId)?.errorMessage).toBe("boom");
  });

  it("never leaves a version stuck at 'profiling' after a marked failure", async () => {
    const db = createFakeDb();
    const project = await db.project.create({ data: { name: "P" } });
    const { versionId, jobId } = await createVersionAndJob(db, { projectId: project.id });
    expect(db._fake.versions.get(versionId)?.status).toBe("profiling"); // sanity check on the pre-failure state

    await markVersionAndJobFailed(db, { versionId, jobId, errorMessage: "network error" });

    expect(db._fake.versions.get(versionId)?.status).not.toBe("profiling");
  });
});
