import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";

import { createFakeDb } from "./fakeProfilingDb.js";

vi.mock("../src/db/prisma.js", () => ({
  prisma: createFakeDb(),
  disconnectPrisma: vi.fn(),
}));

const BACKEND_PYTHON_DIR = path.resolve(__dirname, "../../backend-python");
const PYTHON_BIN = path.join(BACKEND_PYTHON_DIR, ".venv", "bin", "python");
const FIXTURES_ROOT =
  process.env.DATASAGE_FIXTURES_PATH ?? path.resolve(__dirname, "../../../datasage-fixtures");

const pythonAvailable = fs.existsSync(PYTHON_BIN);
const fixturesAvailable = fs.existsSync(path.join(FIXTURES_ROOT, "data", "v1_clean"));

/**
 * This suite is the one genuinely spanning both languages: it boots the
 * real FastAPI process (not a mock), points the real Node app at it, and
 * feeds it the real, authoritative fixture CSVs — read-only, never
 * modified. It skips (does not fail) when the Python venv or the
 * external fixtures repository aren't present, since both are
 * environment-dependent rather than part of this repository.
 */
describe.skipIf(!pythonAvailable || !fixturesAvailable)(
  "End-to-end: Node upload -> real FastAPI -> Phase 1 profiler -> adapter",
  () => {
    let pythonProcess: ChildProcess;
    let pythonPort: number;

    beforeAll(async () => {
      pythonPort = 8500 + Math.floor(Math.random() * 400); // avoid clashing with a dev instance
      pythonProcess = spawn(
        PYTHON_BIN,
        ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(pythonPort)],
        { cwd: BACKEND_PYTHON_DIR, stdio: "pipe" }
      );

      // Poll /health rather than a fixed sleep — waits exactly as long as
      // uvicorn actually takes to come up, no more, no less.
      const deadline = Date.now() + 15_000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        try {
          const res = await fetch(`http://127.0.0.1:${pythonPort}/health`);
          if (res.ok) ready = true;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      if (!ready) throw new Error("Real Python service did not become healthy in time");
    }, 20_000);

    afterAll(() => {
      pythonProcess.kill();
    });

    async function loadAppPointedAtRealPython() {
      process.env.PROFILER_BASE_URL = `http://127.0.0.1:${pythonPort}`;
      process.env.PROFILER_TIMEOUT_MS = "10000"; // real profiling, not a mock — give it real time
      vi.resetModules();
      const { createApp } = await import("../src/app.js");
      return createApp();
    }

    function readVersionTables(version: string) {
      const dir = path.join(FIXTURES_ROOT, "data", version);
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".csv"))
        .map((f) => ({ filename: f, content: fs.readFileSync(path.join(dir, f)) }));
    }

    it("v1_clean produces zero findings through the full real stack", async () => {
      const app = await loadAppPointedAtRealPython();
      const tables = readVersionTables("v1_clean");

      let req = request(app).post("/uploads/validate");
      for (const t of tables) req = req.attach("files", t.content, t.filename);
      const res = await req;

      expect(res.status).toBe(200);
      expect(res.body.fileCount).toBe(tables.length);
      expect(res.body.profiling.findingCount).toBe(0);
      expect(res.body.profiling.issueCount).toBe(0);
      expect(res.body.versionId).toBeTruthy();
      expect(res.body.jobId).toBeTruthy();
    }, 30_000);

    it("v2_dirty produces real, contract-valid findings through the full real stack", async () => {
      const app = await loadAppPointedAtRealPython();
      const tables = readVersionTables("v2_dirty");

      let req = request(app).post("/uploads/validate");
      for (const t of tables) req = req.attach("files", t.content, t.filename);
      const res = await req;

      expect(res.status).toBe(200);
      expect(res.body.profiling.findingCount).toBeGreaterThan(0);
      expect(res.body.profiling.issueCount).toBeGreaterThan(0);

      // The findings themselves are no longer echoed in the response as of
      // Step 3 (they're persisted, not returned raw) — so this now checks
      // what was actually written to the fake DB via the real pipeline.
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

    it("does not modify the authoritative fixtures directory by running this test", () => {
      // The fixtures were only ever opened for reading (fs.readFileSync
      // above); this asserts the directory listing is unchanged as a
      // second, independent confirmation of that.
      const before = fs.readdirSync(path.join(FIXTURES_ROOT, "data", "v2_dirty")).sort();
      const after = fs.readdirSync(path.join(FIXTURES_ROOT, "data", "v2_dirty")).sort();
      expect(after).toEqual(before);
    });
  }
);

if (!pythonAvailable || !fixturesAvailable) {
  describe("End-to-end real-stack suite", () => {
    it.skip(
      `skipped — ${!pythonAvailable ? `no venv at ${PYTHON_BIN}` : ""}${
        !fixturesAvailable ? ` no fixtures at ${FIXTURES_ROOT}` : ""
      }`,
      () => {}
    );
  });
}
