import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { AppError, Errors } from "../src/errors/AppError.js";
import { errorHandler, notFoundHandler } from "../src/errors/errorHandler.js";
import { ErrorCode } from "../src/errors/errorCodes.js";

vi.mock("../src/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { logger } from "../src/logger.js";

function fakeRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return { id: "req-123", method: "GET", path: "/test", header: vi.fn(), ...overrides } as unknown as Request;
}

/** `noUncheckedIndexedAccess` correctly flags mock.calls[0][0] as possibly
 * undefined at the type level (a mock could have zero calls) — this helper
 * asserts the call actually happened and gives back a properly narrowed value. */
function firstCallArg(mockFn: ReturnType<typeof vi.fn>): unknown {
  const call = mockFn.mock.calls[0];
  if (!call) throw new Error("Expected mock to have been called at least once");
  return call[0];
}

describe("errorHandler", () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it("maps a known AppError to its declared status and a matching envelope", () => {
    const req = fakeReq();
    const res = fakeRes();
    const err = Errors.fileTooLarge("big.csv", 999, 500);

    errorHandler(err, req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: ErrorCode.FILE_TOO_LARGE,
        message: err.message,
        details: { filename: "big.csv", sizeBytes: 999, limitBytes: 500 },
        requestId: "req-123",
      },
    });
  });

  it("logs 4xx AppErrors at warn, not error", () => {
    errorHandler(Errors.emptyFile("x.csv"), fakeReq(), fakeRes(), vi.fn());
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs 5xx AppErrors at error, not warn", () => {
    errorHandler(Errors.databaseError(new Error("boom")), fakeReq(), fakeRes(), vi.fn());
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("never leaks the underlying cause to the client response, only to the log", () => {
    const req = fakeReq();
    const res = fakeRes();
    const secret = new Error("password=hunter2 leaked in a stack trace");
    errorHandler(Errors.databaseError(secret), req, res, vi.fn());

    const responseBody = firstCallArg(res.json as ReturnType<typeof vi.fn>);
    expect(JSON.stringify(responseBody)).not.toContain("hunter2");

    // But the logger DID receive it — the cause isn't lost, just not exposed.
    const logCallArg = firstCallArg(logger.error as ReturnType<typeof vi.fn>) as { cause: string };
    expect(logCallArg.cause).toContain("hunter2");
  });

  it("maps an unrecognized (non-AppError) exception to a generic 500 with INTERNAL_ERROR", () => {
    const req = fakeReq();
    const res = fakeRes();
    errorHandler(new TypeError("something truly unexpected"), req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    const body = firstCallArg(res.json as ReturnType<typeof vi.fn>) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(body.error.message).not.toContain("something truly unexpected");
    expect(body.error.requestId).toBe("req-123");
  });

  it("AppError's status is always derived from its code, never independently settable", () => {
    // Constructing an AppError never takes a status parameter at all — this
    // test documents that guarantee rather than testing a bypass.
    const err = new AppError(ErrorCode.FILE_TOO_LARGE, "irrelevant message");
    expect(err.status).toBe(413);
  });
});

describe("notFoundHandler", () => {
  it("returns 404 with ROUTE_NOT_FOUND and the request path/method", () => {
    const req = fakeReq({ method: "POST", path: "/nope" });
    const res = fakeRes();

    notFoundHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    const body = firstCallArg(res.json as ReturnType<typeof vi.fn>) as {
      error: { code: string; details: unknown };
    };
    expect(body.error.code).toBe(ErrorCode.ROUTE_NOT_FOUND);
    expect(body.error.details).toEqual({ method: "POST", path: "/nope" });
  });
});
