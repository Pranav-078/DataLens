import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import request from "supertest";

import { createFakeDb } from "./fakeProfilingDb.js";

vi.mock("../src/db/prisma.js", () => ({
  prisma: createFakeDb(),
  disconnectPrisma: vi.fn(),
}));

const BACKEND_PYTHON_DIR = path.resolve(__dirname, "../../python-engine");
const PYTHON_BIN = process.env.PYTHON_BIN || process.env.PYTHON || "python";
const pythonAvailable = spawnSync(
  PYTHON_BIN,
  ["-c", "import fastapi, pandas, uvicorn"],
  { cwd: BACKEND_PYTHON_DIR, stdio: "ignore" }
).status === 0;

function customersCsv(): string {
  const rows = Array.from(
    { length: 25 },
    (_, index) => `C${String(index).padStart(3, "0")},Customer ${index}`
  );
  return "id,name\n" + rows.join("\n") + "\n";
}

function ordersCsv(): string {
  const rows = Array.from(
    { length: 40 },
    (_, index) => `O${String(index).padStart(3, "0")},C${String(index % 25).padStart(3, "0")},delivered`
  );
  return "order_id,customer_id,status\n" + rows.join("\n") + "\n";
}

function readVersionTables(version: "v1_clean" | "v2_dirty") {
  const contents = version === "v1_clean"
    ? {
        "customers.csv": customersCsv(),
        "orders.csv": ordersCsv(),
      }
    : {
        "customers.csv": [
          "id,email",
          "C001,one@example.com",
          "C002,",
          "C003,three@example.com",
          "C004,four@example.com",
        ].join("\n") + "\n",
        "orders.csv": [
          "order_id,customer_id,status",
          "O001,C001,delivered",
          "O002,C002,",
          "O003,C003,shipped",
          "O004,C004,delivered",
        ].join("\n") + "\n",
      };

  return Object.entries(contents).map(([filename, csv]) => ({
    filename,
    content: Buffer.from(csv, "utf8"),
  }));
}

/**
 * This suite boots the real FastAPI process and routes Node upload requests
 * through the real profiler, then verifies the API adapter and persistence
 * orchestration. Fixtures are small, deterministic CSVs stored in this test
 * file so CI never depends on a separate private fixture repository.
 */
describe.skipIf(!pythonAvailable)(
  "End-to-end: Node upload -> real FastAPI -> profiler -> adapter -> persistence",
  () => {
    let pythonProcess: ChildProcess | undefined;
    let pythonPort: number;

    beforeAll(async () => {
      pythonPort = 8500 + Math.floor(Math.random() * 400);
      pythonProcess = spawn(
        PYTHON_BIN,
        ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(pythonPort)],
        { cwd: BACKEND_PYTHON_DIR, stdio: "ignore" }
      );

      const deadline = Date.now() + 20_000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        try {
          const response = await fetch(`http://127.0.0.1:${pythonPort}/health`);
          if (response.ok) ready = true;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      if (!ready) {
        pythonProcess.kill();
        throw new Error("Real Python profiler did not become healthy within 20 seconds");
      }
    }, 25_000);

    afterAll(() => {
      if (pythonProcess && pythonProcess.exitCode === null) pythonProcess.kill();
    });

    async function loadAppPointedAtRealPython() {
      process.env.PROFILER_BASE_URL = `http://127.0.0.1:${pythonPort}`;
      process.env.PROFILER_TIMEOUT_MS = "30000";
      vi.resetModules();
      const { createApp } = await import("../src/app.js");
      return createApp();
    }

    async function uploadVersion(version: "v1_clean" | "v2_dirty", profileMode?: "fast") {
      const app = await loadAppPointedAtRealPython();
      const tables = readVersionTables(version);
      let upload = request(app).post("/uploads/validate");
      if (profileMode) upload = upload.field("profileMode", profileMode);
      for (const table of tables) {
        upload = upload.attach("files", table.content, table.filename);
      }
      return { response: await upload, fileCount: tables.length };
    }

    it("clean related tables produce zero quality findings and a real FK relationship", async () => {
      const { response, fileCount } = await uploadVersion("v1_clean");

      expect(response.status).toBe(200);
      expect(response.body.fileCount).toBe(fileCount);
      expect(response.body.profiling.profileMode).toBe("full");
      expect(response.body.profiling.findingCount).toBe(0);
      expect(response.body.profiling.issueCount).toBe(0);
      expect(response.body.profiling.relationshipCount).toBeGreaterThan(0);
      expect(response.body.versionId).toBeTruthy();
      expect(response.body.jobId).toBeTruthy();

      const { prisma } = await import("../src/db/prisma.js");
      const db = prisma as unknown as ReturnType<typeof createFakeDb>;
      expect(db._fake.relationships.length).toBeGreaterThan(0);
    }, 30_000);

    it("dirty CSVs produce real, contract-valid quality issues through the full Node API", async () => {
      const { response } = await uploadVersion("v2_dirty");

      expect(response.status).toBe(200);
      expect(response.body.profiling.findingCount).toBeGreaterThan(0);
      expect(response.body.profiling.issueCount).toBeGreaterThan(0);

      const { prisma } = await import("../src/db/prisma.js");
      const db = prisma as unknown as ReturnType<typeof createFakeDb>;
      expect(db._fake.issues.length).toBeGreaterThan(0);

      const validDimensions = new Set([
        "completeness", "uniqueness", "validity", "consistency", "referential_integrity",
      ]);
      const validSeverities = new Set(["critical", "high", "medium", "low"]);
      for (const issue of db._fake.issues) {
        expect(validDimensions.has(issue.dimension as string)).toBe(true);
        expect(validSeverities.has(issue.severity as string)).toBe(true);
        expect(issue.fingerprint).toBeTruthy();
      }
    }, 30_000);

    it("Fast Preview mode reaches the real profiler and retains relationship inference", async () => {
      const { response } = await uploadVersion("v1_clean", "fast");

      expect(response.status).toBe(200);
      expect(response.body.profiling.profileMode).toBe("fast");
      expect(response.body.profiling.sampleSizePerTable).toBe(5_000);
      expect(response.body.profiling.relationshipCount).toBeGreaterThan(0);
    }, 30_000);
  }
);

if (!pythonAvailable) {
  describe("End-to-end real-profiler suite", () => {
    it.skip(
      `Python dependencies are not available in ${BACKEND_PYTHON_DIR}; CI installs them before this suite.`,
      () => {}
    );
  });
}
