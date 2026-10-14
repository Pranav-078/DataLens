import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Mocked BEFORE importing app.js, since health.controller.ts imports
// db/prisma.ts at module load. This also sidesteps this sandbox's
// inability to generate a real Prisma client — but it's the correct way
// to test this regardless of environment: a unit/integration test of the
// route layer should not depend on a real database being up.
vi.mock("../src/db/prisma.js", () => ({
  prisma: { $queryRaw: vi.fn() },
  disconnectPrisma: vi.fn(),
}));

import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";

const app = createApp();
const mockQueryRaw = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockQueryRaw.mockReset();
});

describe("GET /health", () => {
  it("returns 200 with status ok, unconditionally", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body).toHaveProperty("version");
    expect(res.body).toHaveProperty("uptimeSeconds");
  });

  it("always includes an x-request-id header", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("echoes a client-supplied x-request-id rather than replacing it", async () => {
    const res = await request(app).get("/health").set("x-request-id", "test-fixed-id-123");
    expect(res.headers["x-request-id"]).toBe("test-fixed-id-123");
  });
});

describe("GET /health/ready", () => {
  it("returns 200 and status ready when both DB and pgvector checks pass", async () => {
    mockQueryRaw
      .mockResolvedValueOnce(undefined) // SELECT 1
      .mockResolvedValueOnce([{ installed: true }]); // pg_extension check

    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ready",
      checks: { database: "ok", pgvector: "ok" },
    });
  });

  it("returns 503 when the database is unreachable", async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error("connection refused"));

    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.database).toBe("fail");
  });

  it("returns 503 when the database is up but the vector extension is missing", async () => {
    mockQueryRaw
      .mockResolvedValueOnce(undefined) // SELECT 1 succeeds
      .mockResolvedValueOnce([{ installed: false }]); // extension missing

    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ database: "ok", pgvector: "fail" });
  });
});
