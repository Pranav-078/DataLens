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
    });
    expect(db._fake.issues).toHaveLength(1);
    const issue = db._fake.issues[0]!;
    expect(issue.fingerprint).toBe("deadbeef");
    expect(issue.tableId).toBe(tableIdByName["customers"]);
    expect(issue.columnId).toBeTruthy();
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
