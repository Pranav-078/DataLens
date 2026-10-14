import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { createFakeDb } from "./fakeProfilingDb.js";

// The mock factory calls createFakeDb() fresh each time it's invoked. Vitest
// re-invokes it after vi.resetModules() + a fresh dynamic import, which is
// exactly what loadAppPointedAtProfiler() below does per test — so each
// test gets its own isolated fake database with no cross-test state leakage.
vi.mock("../src/db/prisma.js", () => ({
  prisma: createFakeDb(),
  disconnectPrisma: vi.fn(),
}));

let profilerServer: http.Server;
let profilerUrl: string;
let profilerHandler: http.RequestListener = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "profiled", tableCount: 1, findingCount: 0, tables: [], findings: [] }));
};

beforeAll(async () => {
  profilerServer = http.createServer((req, res) => profilerHandler(req, res));
  await new Promise<void>((resolve) => profilerServer.listen(0, resolve));
  const { port } = profilerServer.address() as AddressInfo;
  profilerUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => profilerServer.close());
afterEach(() => vi.resetModules());

beforeEach(async () => {
  (await currentFakeDb())._fake.reset();
});

async function loadAppPointedAtProfiler() {
  process.env.PROFILER_BASE_URL = profilerUrl;
  vi.resetModules();
  const { createApp } = await import("../src/app.js");
  return createApp();
}

async function currentFakeDb() {
  const { prisma } = await import("../src/db/prisma.js");
  return prisma as unknown as ReturnType<typeof createFakeDb>;
}

const VALID_CSV = "id,name\n1,Alice\n2,Bob\n";

describe("POST /uploads/validate — integration (mocked Prisma, real HTTP + real validation)", () => {
  it("accepts a valid CSV upload end-to-end: validates, persists, and returns real IDs", async () => {
    profilerHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "profiled",
          tableCount: 1,
          findingCount: 1,
          tables: [
            {
              tableName: "people",
              rowCount: 2,
              columnCount: 2,
              columns: [
                { columnName: "id", inferredType: "integer", nullCount: 0, nullPercentage: 0, distinctCount: 2, uniquenessRatio: 1 },
                { columnName: "name", inferredType: "string", nullCount: 1, nullPercentage: 50, distinctCount: 1, uniquenessRatio: 1 },
              ],
            },
          ],
          findings: [
            {
              issue_type: "required_field_missing",
              dimension: "completeness",
              table: "people",
              row_uid: "people:2",
              column: "name",
              severity: "medium",
              evidence: {},
            },
          ],
        })
      );
    };
    const app = await loadAppPointedAtProfiler();

    const res = await request(app)
      .post("/uploads/validate")
      .attach("files", Buffer.from(VALID_CSV), "people.csv");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("profiled");
    expect(res.body.projectId).toBeTruthy();
    expect(res.body.versionId).toBeTruthy();
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.versionNumber).toBe(1);
    expect(res.body.fileCount).toBe(1);
    expect(res.body.files[0]).toMatchObject({ tableName: "people", rowCount: 2 });
    expect(res.body.profiling).toEqual({ findingCount: 1, issueCount: 1 });

    // The real point of this step: assert what actually got persisted,
    // not just what the HTTP response claims.
    const db = await currentFakeDb();
    expect(db._fake.versions.get(res.body.versionId)?.status).toBe("ready");
    expect([...db._fake.jobs.values()][0]?.status).toBe("succeeded");
    expect(db._fake.tables.size).toBe(1);
    expect(db._fake.columns.size).toBe(2);
    expect(db._fake.issues).toHaveLength(1);
    expect(db._fake.issues[0]).toMatchObject({ issueType: "required_field_missing", affectedRows: 1, totalRows: 2 });
  });

  it("auto-creates a project when no projectId is supplied", async () => {
    const app = await loadAppPointedAtProfiler();
    const res = await request(app)
      .post("/uploads/validate")
      .attach("files", Buffer.from(VALID_CSV), "people.csv");

    expect(res.status).toBe(200);
    const db = await currentFakeDb();
    expect(db._fake.projects.has(res.body.projectId)).toBe(true);
  });

  it("uses a supplied projectId instead of creating a new one", async () => {
    const app = await loadAppPointedAtProfiler();
    const db = await currentFakeDb();
    const existing = await db.project.create({ data: { name: "Existing Project" } });

    const res = await request(app)
      .post("/uploads/validate")
      .field("projectId", existing.id)
      .attach("files", Buffer.from(VALID_CSV), "people.csv");

    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe(existing.id);
    expect(db._fake.projects.size).toBe(1); // no second project created
  });

  it("returns 404 PROJECT_NOT_FOUND for a projectId that doesn't exist, rather than silently creating one", async () => {
    const app = await loadAppPointedAtProfiler();

    const res = await request(app)
      .post("/uploads/validate")
      .field("projectId", "does-not-exist")
      .attach("files", Buffer.from(VALID_CSV), "people.csv");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("returns the structured envelope (not a hang or a crash) for an invalid file, via the real HTTP path", async () => {
    const app = await loadAppPointedAtProfiler();

    const res = await request(app)
      .post("/uploads/validate")
      .attach("files", Buffer.alloc(0), "empty.csv");

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("EMPTY_FILE");
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("rejects two colliding table names via the real HTTP path", async () => {
    const app = await loadAppPointedAtProfiler();

    const res = await request(app)
      .post("/uploads/validate")
      .attach("files", Buffer.from(VALID_CSV), "Orders.csv")
      .attach("files", Buffer.from(VALID_CSV), "orders!!.csv");

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TABLE_NAME_COLLISION");
  });

  it("surfaces a profiler-unavailable failure as 503, and marks the version/job failed rather than leaving them stuck", async () => {
    process.env.PROFILER_BASE_URL = "http://127.0.0.1:1"; // nothing listens here
    vi.resetModules();
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const res = await request(app)
      .post("/uploads/validate")
      .attach("files", Buffer.from(VALID_CSV), "people.csv");

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PROFILER_UNAVAILABLE");

    const db = await currentFakeDb();
    const [version] = [...db._fake.versions.values()];
    const [job] = [...db._fake.jobs.values()];
    expect(version?.status).toBe("failed");
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toBeTruthy();
  });

  it("does not call the profiler at all if validation already failed (fail-fast ordering)", async () => {
    let profilerWasCalled = false;
    profilerHandler = (_req, res) => {
      profilerWasCalled = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "profiled", tableCount: 1, findingCount: 0, tables: [], findings: [] }));
    };
    const app = await loadAppPointedAtProfiler();

    await request(app).post("/uploads/validate").attach("files", Buffer.alloc(0), "empty.csv");

    expect(profilerWasCalled).toBe(false);

    // Also confirms no version/job was ever created for a request that
    // never passed validation — there's nothing to mark failed because
    // nothing was created in the first place.
    const db = await currentFakeDb();
    expect(db._fake.versions.size).toBe(0);
  });
});
