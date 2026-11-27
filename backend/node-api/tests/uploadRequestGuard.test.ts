import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { config } from "../src/config.js";
import {
  resetUploadRequestGuardForTests,
  uploadRequestGuard,
} from "../src/middleware/uploadRequestGuard.js";

function responseDouble() {
  const emitter = new EventEmitter();
  const response = Object.assign(emitter, {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  });
  return response as unknown as Response & {
    statusCode: number;
    body: { error?: { code?: string } } | undefined;
    headers: Record<string, string>;
  };
}

function request(contentLength?: string) {
  return {
    get(name: string) {
      return name.toLowerCase() === "content-length" ? contentLength : undefined;
    },
  } as Request;
}

afterEach(() => resetUploadRequestGuardForTests());

describe("uploadRequestGuard", () => {
  it("rejects a declared body over the aggregate upload cap before Multer runs", () => {
    const req = request(String(config.MAX_UPLOAD_BODY_BYTES + 1));
    const res = responseDouble();
    const next = vi.fn() as unknown as NextFunction;

    uploadRequestGuard(req, res, next);

    expect(res.statusCode).toBe(413);
    expect(res.body?.error?.code).toBe("UPLOAD_TOO_LARGE");
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects malformed and unsafe Content-Length headers", () => {
    for (const header of ["12.5", "-1", "1e9", "999999999999999999999999999999"]) {
      const res = responseDouble();
      const next = vi.fn() as unknown as NextFunction;
      uploadRequestGuard(request(header), res, next);
      expect([400, 413]).toContain(res.statusCode);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("allows one bounded upload and rejects a concurrent upload until the first response closes", () => {
    const first = responseDouble();
    const firstNext = vi.fn() as unknown as NextFunction;
    uploadRequestGuard(request("1024"), first, firstNext);
    expect(firstNext).toHaveBeenCalledOnce();

    const second = responseDouble();
    const secondNext = vi.fn() as unknown as NextFunction;
    uploadRequestGuard(request("1024"), second, secondNext);
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBe("30");
    expect(secondNext).not.toHaveBeenCalled();

    first.emit("close");

    const third = responseDouble();
    const thirdNext = vi.fn() as unknown as NextFunction;
    uploadRequestGuard(request("1024"), third, thirdNext);
    expect(thirdNext).toHaveBeenCalledOnce();
    third.emit("finish");
  });

  it("releases the upload slot on normal response completion", () => {
    const first = responseDouble();
    uploadRequestGuard(request(undefined), first, vi.fn() as unknown as NextFunction);
    first.emit("finish");

    const second = responseDouble();
    const next = vi.fn() as unknown as NextFunction;
    uploadRequestGuard(request(undefined), second, next);
    expect(next).toHaveBeenCalledOnce();
    second.emit("close");
  });
});
