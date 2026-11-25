import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";

vi.mock("../src/db/prisma.js", () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

let profilerServer: http.Server;
let profilerUrl: string;
let profilerHandler: http.RequestListener = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "stub_ok", receivedTables: 1 }));
};

beforeAll(async () => {
  profilerServer = http.createServer((req, res) => profilerHandler(req, res));
  await new Promise<void>((resolve) => profilerServer.listen(0, resolve));
  const { port } = profilerServer.address() as AddressInfo;
  profilerUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => profilerServer.close());
afterEach(() => vi.resetModules());

async function loadAppPointedAtProfiler() {
  process.env.PROFILER_BASE_URL = profilerUrl;
  vi.resetModules();
  const { createApp } = await import("../src/app.js");
  return createApp();
}

const VALID_CSV = "id,name\n1,Alice\n2,Bob\n";

describe("POST /uploads/validate — integration", () => {
  it("accepts a valid CSV upload end-to-end and includes the profiler's response", async () => {
    profilerHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "stub_ok", receivedTables: 1 }));
    };
    const app = await loadAppPointedAtProfiler();

    const res = await request(app)
      .post("/uploads/validate")
      .attach("files", Buffer.from(VALID_CSV), "people.csv");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("validated");
    expect(res.body.fileCount).toBe(1);
    expect(res.body.files[0]).toMatchObject({ tableName: "people", rowCount: 2 });
    expect(res.body.profiler).toEqual({ status: "stub_ok", receivedTables: 1 });
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

  it("surfaces a profiler-unavailable failure as 503 through the full HTTP path, not a hang", async () => {
    process.env.PROFILER_BASE_URL = "http://127.0.0.1:1"; // nothing listens here
    vi.resetModules();
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const res = await request(app)
      .post("/uploads/validate")
      .attach("files", Buffer.from(VALID_CSV), "people.csv");

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PROFILER_UNAVAILABLE");
  });

  it("does not call the profiler at all if validation already failed (fail-fast ordering)", async () => {
    let profilerWasCalled = false;
    profilerHandler = (_req, res) => {
      profilerWasCalled = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "stub_ok", receivedTables: 1 }));
    };
    const app = await loadAppPointedAtProfiler();

    await request(app).post("/uploads/validate").attach("files", Buffer.alloc(0), "empty.csv");

    expect(profilerWasCalled).toBe(false);
  });
});
