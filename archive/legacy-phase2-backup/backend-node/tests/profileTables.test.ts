import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ErrorCode } from "../src/errors/errorCodes.js";

let server: http.Server;
let baseUrl: string;
let nextHandler: http.RequestListener = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "profiled", tableCount: 1, findingCount: 0, tables: [], findings: [] }));
};

beforeAll(async () => {
  server = http.createServer((req, res) => nextHandler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => server.close());
afterEach(() => vi.resetModules());

async function loadClientPointedAt(url: string, timeoutMs = 500) {
  process.env.PROFILER_BASE_URL = url;
  process.env.PROFILER_TIMEOUT_MS = String(timeoutMs);
  vi.resetModules();
  const mod = await import("../src/modules/uploads/profilerClient.js");
  return mod.profileTables;
}

const sampleTables = [{ tableName: "customers", csvContent: "id,email\n1,a@x.com\n" }];

describe("profileTables — success", () => {
  it("returns the parsed findings array on a valid 200 response", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "profiled",
          tableCount: 1,
          findingCount: 1,
          tables: [],
          findings: [
            {
              issue_type: "empty_string",
              dimension: "completeness",
              table: "customers",
              row_uid: "customers:1",
              column: "email",
              severity: "medium",
              evidence: {},
            },
          ],
        })
      );
    };
    const profileTables = await loadClientPointedAt(baseUrl);
    const result = await profileTables(sampleTables);
    expect(result.findingCount).toBe(1);
    expect(result.findings[0]).toMatchObject({ table: "customers", row_uid: "customers:1" });
  });

  it("accepts an empty findings array as a valid, non-error result", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "profiled", tableCount: 1, findingCount: 0, tables: [], findings: [] }));
    };
    const profileTables = await loadClientPointedAt(baseUrl);
    await expect(profileTables(sampleTables)).resolves.toMatchObject({ findingCount: 0 });
  });
});

describe("profileTables — distinct failure mappings (parity with callProfilerStub)", () => {
  it("maps connection-refused to PROFILER_UNAVAILABLE", async () => {
    const profileTables = await loadClientPointedAt("http://127.0.0.1:1");
    await expect(profileTables(sampleTables)).rejects.toMatchObject({
      code: ErrorCode.PROFILER_UNAVAILABLE,
    });
  });

  it("maps a slow response past the timeout to PROFILER_TIMEOUT", async () => {
    nextHandler = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "profiled", tableCount: 1, findingCount: 0, tables: [], findings: [] }));
      }, 2000);
    };
    const profileTables = await loadClientPointedAt(baseUrl, 300);
    await expect(profileTables(sampleTables)).rejects.toMatchObject({
      code: ErrorCode.PROFILER_TIMEOUT,
    });
  });

  it("maps upstream 501 to PROFILER_NOT_IMPLEMENTED", async () => {
    nextHandler = (_req, res) => res.writeHead(501).end();
    const profileTables = await loadClientPointedAt(baseUrl);
    await expect(profileTables(sampleTables)).rejects.toMatchObject({
      code: ErrorCode.PROFILER_NOT_IMPLEMENTED,
    });
  });

  it("maps upstream 500 to PROFILER_ERROR", async () => {
    nextHandler = (_req, res) => res.writeHead(500).end();
    const profileTables = await loadClientPointedAt(baseUrl);
    await expect(profileTables(sampleTables)).rejects.toMatchObject({ code: ErrorCode.PROFILER_ERROR });
  });

  it("maps a 2xx response with a finding missing a required field to PROFILER_BAD_RESPONSE", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "profiled",
          tableCount: 1,
          findingCount: 1,
          tables: [],
          findings: [{ issue_type: "x" }], // missing every other required field
        })
      );
    };
    const profileTables = await loadClientPointedAt(baseUrl);
    await expect(profileTables(sampleTables)).rejects.toMatchObject({
      code: ErrorCode.PROFILER_BAD_RESPONSE,
    });
  });

  it("maps a 2xx response with unparseable JSON to PROFILER_BAD_RESPONSE", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not valid json");
    };
    const profileTables = await loadClientPointedAt(baseUrl);
    await expect(profileTables(sampleTables)).rejects.toMatchObject({
      code: ErrorCode.PROFILER_BAD_RESPONSE,
    });
  });
});
