import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AppError } from "../src/errors/AppError.js";
import { ErrorCode } from "../src/errors/errorCodes.js";

// config.PROFILER_BASE_URL is read once at module import time (by design —
// see config.ts). To point the client at a per-test local server instead
// of a fixed URL, we set the env var before importing config/profilerClient
// dynamically inside each test via vi.resetModules(), rather than trying
// to mutate the frozen config object after the fact.
import { vi } from "vitest";

let server: http.Server;
let baseUrl: string;

/** Swaps the running handler for the next request only. */
let nextHandler: http.RequestListener = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "stub_ok", receivedTables: 1 }));
};

beforeAll(async () => {
  server = http.createServer((req, res) => nextHandler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  vi.resetModules();
});

async function loadClientPointedAt(url: string, timeoutMs = 500) {
  process.env.PROFILER_BASE_URL = url;
  process.env.PROFILER_TIMEOUT_MS = String(timeoutMs);
  vi.resetModules();
  const mod = await import("../src/modules/uploads/profilerClient.js");
  return mod.callProfilerStub;
}

describe("profilerClient — success", () => {
  it("returns the parsed body on a valid 200 response", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "stub_ok", receivedTables: 4 }));
    };
    const callProfilerStub = await loadClientPointedAt(baseUrl);
    await expect(callProfilerStub(4)).resolves.toEqual({ status: "stub_ok", receivedTables: 4 });
  });
});

describe("profilerClient — distinct failure mappings", () => {
  it("maps connection-refused to PROFILER_UNAVAILABLE", async () => {
    // Port 1 is a real port nothing will ever be listening on in a test env.
    const callProfilerStub = await loadClientPointedAt("http://127.0.0.1:1");
    await expect(callProfilerStub(1)).rejects.toMatchObject({
      code: ErrorCode.PROFILER_UNAVAILABLE,
    } satisfies Partial<AppError>);
  });

  it("maps a slow response past the timeout to PROFILER_TIMEOUT, distinct from UNAVAILABLE", async () => {
    nextHandler = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "stub_ok", receivedTables: 1 }));
      }, 2000); // well beyond the 300ms timeout configured below
    };
    const callProfilerStub = await loadClientPointedAt(baseUrl, 300);
    await expect(callProfilerStub(1)).rejects.toMatchObject({ code: ErrorCode.PROFILER_TIMEOUT });
  });

  it("maps upstream 501 to PROFILER_NOT_IMPLEMENTED, distinct from other 5xx", async () => {
    nextHandler = (_req, res) => res.writeHead(501).end();
    const callProfilerStub = await loadClientPointedAt(baseUrl);
    await expect(callProfilerStub(1)).rejects.toMatchObject({
      code: ErrorCode.PROFILER_NOT_IMPLEMENTED,
    });
  });

  it("maps upstream 500 to PROFILER_ERROR, distinct from 501", async () => {
    nextHandler = (_req, res) => res.writeHead(500).end();
    const callProfilerStub = await loadClientPointedAt(baseUrl);
    await expect(callProfilerStub(1)).rejects.toMatchObject({ code: ErrorCode.PROFILER_ERROR });
  });

  it("maps a 2xx response with the wrong shape to PROFILER_BAD_RESPONSE", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ unexpected_shape: true }));
    };
    const callProfilerStub = await loadClientPointedAt(baseUrl);
    await expect(callProfilerStub(1)).rejects.toMatchObject({
      code: ErrorCode.PROFILER_BAD_RESPONSE,
    });
  });

  it("maps a 2xx response with unparseable JSON to PROFILER_BAD_RESPONSE", async () => {
    nextHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not valid json");
    };
    const callProfilerStub = await loadClientPointedAt(baseUrl);
    await expect(callProfilerStub(1)).rejects.toMatchObject({
      code: ErrorCode.PROFILER_BAD_RESPONSE,
    });
  });

  it("all five failure codes are pairwise distinct (the actual requirement being tested)", () => {
    const codes = new Set([
      ErrorCode.PROFILER_UNAVAILABLE,
      ErrorCode.PROFILER_TIMEOUT,
      ErrorCode.PROFILER_NOT_IMPLEMENTED,
      ErrorCode.PROFILER_ERROR,
      ErrorCode.PROFILER_BAD_RESPONSE,
    ]);
    expect(codes.size).toBe(5);
  });
});
