import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createFakeDb } from "./fakeProfilingDb.js";

// Mocked BEFORE importing app.js, since the projects controller imports
// db/prisma.ts at module load — same pattern as the existing, working
// tests/health.test.ts. Static imports below (not a dynamic import in
// beforeEach) since this file needs no per-test env var changes.
vi.mock("../src/db/prisma.js", () => ({
  prisma: createFakeDb(),
  disconnectPrisma: vi.fn(),
}));

import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";

const app = createApp();
const db = prisma as unknown as ReturnType<typeof createFakeDb>;

beforeEach(() => {
  db._fake.reset();
});

/** Seeds one project with one version, two tables (with columns + stats),
 * one issue, one relationship, and a computed score. Returns every id a
 * test might need, so individual tests stay short. */
async function seedFullVersion() {
  const project = await db.project.create({ data: { name: "Acme" } });
  const version = await db.datasetVersion.create({
    data: { projectId: project.id, versionNumber: 1, status: "ready" },
  });

  const customersTable = await db.datasetTable.create({
    data: {
      versionId: version.id, tableName: "customers", normalizedName: "customers",
      originalFilename: "customers.csv", filePath: "/x/customers.csv",
      rowCount: 30, columnCount: 1, fileSizeBytes: 10n, checksum: "a",
    },
  });
  const ordersTable = await db.datasetTable.create({
    data: {
      versionId: version.id, tableName: "orders", normalizedName: "orders",
      originalFilename: "orders.csv", filePath: "/x/orders.csv",
      rowCount: 40, columnCount: 1, fileSizeBytes: 10n, checksum: "b",
    },
  });

  const idColumn = await db.datasetColumn.create({
    data: { tableId: customersTable.id, columnName: "id", ordinalPosition: 0, inferredType: "string" },
  });
  await db.datasetColumn.create({
    data: { tableId: ordersTable.id, columnName: "customer_id", ordinalPosition: 0, inferredType: "string" },
  });
  await db.columnStatistics.create({
    data: { columnId: idColumn.id, nullCount: 0, nullPercentage: 0, distinctCount: 30, uniquenessRatio: 1 },
  });

  const issue = await db.qualityIssue.create({
    data: {
      versionId: version.id, tableId: customersTable.id, columnId: idColumn.id,
      issueType: "empty_string", dimension: "completeness", severity: "medium",
      title: "t", description: "d", affectedRows: 3, totalRows: 30, affectedPercentage: 10,
      examples: ["customers:1"], evidence: {}, fingerprint: "fp1",
    },
  });

  const relationship = await db.inferredRelationship.create({
    data: {
      versionId: version.id,
      parentTableId: customersTable.id, parentColumnId: idColumn.id,
      childTableId: ordersTable.id, childColumnId: (await db.datasetColumn.findMany({ where: { tableId: { in: [ordersTable.id] } } }))[0]!.id,
      confidence: 0.96, confidenceBand: "high", status: "inferred",
      valueOverlap: 0.98, orphanCount: 2, orphanPercentage: 5, orphanExamples: ["BAD1"], evidence: {},
    },
  });

  const score = await db.qualityScore.create({
    data: {
      versionId: version.id, overallScore: 95, completeness: 90, uniqueness: 100, validity: 100,
      consistency: 100, referentialIntegrity: 95, applicableDimensions: ["completeness", "validity", "uniqueness", "consistency", "referentialIntegrity"],
      weightsUsed: { completeness: 0.25 }, capApplied: null, capReason: null,
      calculationBreakdown: { note: "test" }, criticalCount: 0, highCount: 0, mediumCount: 1, lowCount: 0,
    },
  });

  return { project, version, customersTable, ordersTable, idColumn, issue, relationship, score };
}

describe("GET /projects/:projectId", () => {
  it("returns project summary with version count", async () => {
    const { project } = await seedFullVersion();
    const res = await request(app).get(`/projects/${project.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: project.id, name: "Acme", versionCount: 1, latestVersionNumber: 1 });
  });

  it("404s with PROJECT_NOT_FOUND for a nonexistent project", async () => {
    const res = await request(app).get("/projects/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("GET /projects/:projectId/versions", () => {
  it("lists versions newest-first (deterministic ordering)", async () => {
    const { project } = await seedFullVersion();
    await db.datasetVersion.create({ data: { projectId: project.id, versionNumber: 2, status: "ready" } });

    const res = await request(app).get(`/projects/${project.id}/versions`);
    expect(res.status).toBe(200);
    expect(res.body.versions.map((v: any) => v.versionNumber)).toEqual([2, 1]);
  });

  it("returns an empty array for a project with no versions", async () => {
    const project = await db.project.create({ data: { name: "Empty" } });
    const res = await request(app).get(`/projects/${project.id}/versions`);
    expect(res.status).toBe(200);
    expect(res.body.versions).toEqual([]);
  });
});

describe("GET /projects/:projectId/versions/:versionId", () => {
  it("returns version details", async () => {
    const { project, version } = await seedFullVersion();
    const res = await request(app).get(`/projects/${project.id}/versions/${version.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: version.id, versionNumber: 1, status: "ready" });
  });

  it("404s for a version that belongs to a DIFFERENT project (scoping)", async () => {
    const { version } = await seedFullVersion();
    const otherProject = await db.project.create({ data: { name: "Other" } });

    const res = await request(app).get(`/projects/${otherProject.id}/versions/${version.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("VERSION_NOT_FOUND");
  });

  it("404s for a nonexistent versionId under a real project", async () => {
    const { project } = await seedFullVersion();
    const res = await request(app).get(`/projects/${project.id}/versions/nope`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("VERSION_NOT_FOUND");
  });
});

describe("GET /projects/:projectId/versions/:versionId/tables", () => {
  it("returns tables with nested columns and statistics", async () => {
    const { project, version, customersTable } = await seedFullVersion();
    const res = await request(app).get(`/projects/${project.id}/versions/${version.id}/tables`);

    expect(res.status).toBe(200);
    expect(res.body.tables).toHaveLength(2);
    const customers = res.body.tables.find((t: any) => t.id === customersTable.id);
    expect(customers.tableName).toBe("customers");
    expect(customers.columns).toHaveLength(1);
    expect(customers.columns[0].statistics).toMatchObject({ distinctCount: 30, uniquenessRatio: 1 });
  });

  it("returns an empty tables array for a version with none, not an error", async () => {
    const project = await db.project.create({ data: { name: "P" } });
    const version = await db.datasetVersion.create({ data: { projectId: project.id, versionNumber: 1, status: "ready" } });
    const res = await request(app).get(`/projects/${project.id}/versions/${version.id}/tables`);
    expect(res.status).toBe(200);
    expect(res.body.tables).toEqual([]);
  });

  it("is scoped: cannot read another project's tables", async () => {
    const { version } = await seedFullVersion();
    const otherProject = await db.project.create({ data: { name: "Other" } });
    const res = await request(app).get(`/projects/${otherProject.id}/versions/${version.id}/tables`);
    expect(res.status).toBe(404);
  });
});

describe("GET /projects/:projectId/versions/:versionId/issues", () => {
  it("returns issues with resolved table/column names", async () => {
    const { project, version, issue } = await seedFullVersion();
    const res = await request(app).get(`/projects/${project.id}/versions/${version.id}/issues`);

    expect(res.status).toBe(200);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0]).toMatchObject({
      id: issue.id, tableName: "customers", columnName: "id", issueType: "empty_string",
    });
  });

  it("returns an empty issues array for a clean version", async () => {
    const project = await db.project.create({ data: { name: "P" } });
    const version = await db.datasetVersion.create({ data: { projectId: project.id, versionNumber: 1, status: "ready" } });
    const res = await request(app).get(`/projects/${project.id}/versions/${version.id}/issues`);
    expect(res.status).toBe(200);
    expect(res.body.issues).toEqual([]);
    expect(res.body.totalCount).toBe(0);
  });

  it("paginates correctly: page size, total count, total pages", async () => {
    const project = await db.project.create({ data: { name: "P" } });
    const version = await db.datasetVersion.create({ data: { projectId: project.id, versionNumber: 1, status: "ready" } });
    for (let i = 0; i < 5; i++) {
      await db.qualityIssue.create({
        data: {
          versionId: version.id, tableId: null, columnId: null, issueType: `type_${i}`,
          dimension: "completeness", severity: "low", title: "t", description: "d",
          affectedRows: 1, totalRows: 10, affectedPercentage: 10, examples: [], evidence: {}, fingerprint: `fp_${i}`,
        },
      });
    }

    const page1 = await request(app).get(`/projects/${project.id}/versions/${version.id}/issues?page=1&pageSize=2`);
    expect(page1.body.issues).toHaveLength(2);
    expect(page1.body.totalCount).toBe(5);
    expect(page1.body.totalPages).toBe(3);
    expect(page1.body.page).toBe(1);

    const page3 = await request(app).get(`/projects/${project.id}/versions/${version.id}/issues?page=3&pageSize=2`);
    expect(page3.body.issues).toHaveLength(1); // last page, partial
  });

  it("falls back to default pagination for a malformed page param rather than erroring", async () => {
    const { project, version } = await seedFullVersion();
    const res = await request(app).get(`/projects/${project.id}/versions/${version.id}/issues?page=not-a-number`);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
  });

  it("is scoped: cannot read another project's issues", async () => {
    const { version } = await seedFullVersion();
    const otherProject = await db.project.create({ data: { name: "Other" } });
    const res = await request(app).get(`/projects/${otherProject.id}/versions/${version.id}/issues`);
    expect(res.status).toBe(404);
  });
});

describe("GET /projects/:projectId/versions/:versionId/relationships", () => {
  it("returns relationships with resolved parent/child table and column names", async () => {
    const { project, version, relationship } = await seedFullVersion();
    const res = await request(app).get(`/projects/${project.id}/versions/${version.id}/relationships`);

    expect(res.status).toBe(200);
    expect(res.body.relationships).toHaveLength(1);
    expect(res.body.relationships[0]).toMatchObject({
      id: relationship.id,
      parentTable: "customers", parentColumn: "id",
      childTable: "orders", childColumn: "customer_id",
      confidence: 0.96, orphanCount: 2, orphanPercentage: 5,
    });
  });

  it("returns an empty relationships array for a single-table version", async () => {
    const project = await db.project.create({ data: { name: "P" } });
    const version = await db.datasetVersion.create({ data: { projectId: project.id, versionNumber: 1, status: "ready" } });
    const res = await request(app).get(`/projects/${project.id}/versions/${version.id}/relationships`);
    expect(res.status).toBe(200);
    expect(res.body.relationships).toEqual([]);
  });

  it("is scoped: cannot read another project's relationships", async () => {
    const { version } = await seedFullVersion();
    const otherProject = await db.project.create({ data: { name: "Other" } });
    const res = await request(app).get(`/projects/${otherProject.id}/versions/${version.id}/relationships`);
    expect(res.status).toBe(404);
  });
});

describe("GET /projects/:projectId/versions/:versionId/quality-score", () => {
  it("returns the computed score with referentialIntegrity preserved", async () => {
    const { project, version } = await seedFullVersion();
    const res = await request(app).get(`/projects/${project.id}/versions/${version.id}/quality-score`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("computed");
    expect(res.body.score.overallScore).toBe(95);
    expect(res.body.score.referentialIntegrity).toBe(95);
    expect(res.body.score.severityCounts).toEqual({ critical: 0, high: 0, medium: 1, low: 0 });
  });

  it("returns status not_computed with score null when no score exists yet (not a 404)", async () => {
    const project = await db.project.create({ data: { name: "P" } });
    const version = await db.datasetVersion.create({ data: { projectId: project.id, versionNumber: 1, status: "profiling" } });
    const res = await request(app).get(`/projects/${project.id}/versions/${version.id}/quality-score`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("not_computed");
    expect(res.body.score).toBeNull();
  });

  it("preserves a null (N/A) referentialIntegrity exactly — never coerced to 0", async () => {
    const project = await db.project.create({ data: { name: "P" } });
    const version = await db.datasetVersion.create({ data: { projectId: project.id, versionNumber: 1, status: "ready" } });
    await db.qualityScore.create({
      data: {
        versionId: version.id, overallScore: 100, completeness: 100, uniqueness: 100, validity: 100,
        consistency: 100, referentialIntegrity: null, applicableDimensions: ["completeness", "validity", "uniqueness", "consistency"],
        weightsUsed: {}, capApplied: null, capReason: null, calculationBreakdown: {},
        criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      },
    });

    const res = await request(app).get(`/projects/${project.id}/versions/${version.id}/quality-score`);
    expect(res.body.score.referentialIntegrity).toBeNull();
    expect(res.body.score.applicableDimensions).not.toContain("referentialIntegrity");
  });

  it("404s for a version scoped to a different project, not the score endpoint leaking data", async () => {
    const { version } = await seedFullVersion();
    const otherProject = await db.project.create({ data: { name: "Other" } });
    const res = await request(app).get(`/projects/${otherProject.id}/versions/${version.id}/quality-score`);
    expect(res.status).toBe(404);
  });
});
