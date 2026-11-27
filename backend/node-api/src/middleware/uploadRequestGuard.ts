import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

// The API deliberately serializes large, in-memory CSV uploads. This keeps
// the memory ceiling predictable while the profiler is processing the batch.
// Move this to a shared lease/semaphore before running multiple API replicas.
let uploadInProgress = false;

function reject(res: Response, status: number, code: string, message: string, retryAfter?: number): void {
  if (retryAfter !== undefined) res.setHeader("Retry-After", String(retryAfter));
  res.status(status).json({
    error: {
      code,
      message,
      details: {},
    },
  });
}

export function uploadRequestGuard(req: Request, res: Response, next: NextFunction): void {
  const rawContentLength = req.get("content-length");
  if (rawContentLength !== undefined) {
    if (!/^\d+$/.test(rawContentLength)) {
      reject(res, 400, "INVALID_CONTENT_LENGTH", "The upload request has an invalid Content-Length header.");
      return;
    }
    const contentLength = Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength)) {
      reject(res, 413, "UPLOAD_TOO_LARGE", "The upload request exceeds the configured batch size limit.");
      return;
    }
    if (contentLength > config.MAX_UPLOAD_BODY_BYTES) {
      reject(
        res,
        413,
        "UPLOAD_TOO_LARGE",
        `The total upload batch cannot exceed ${Math.floor(config.MAX_UPLOAD_BODY_BYTES / (1024 * 1024))} MB.`
      );
      return;
    }
  }

  if (uploadInProgress) {
    reject(res, 429, "UPLOAD_IN_PROGRESS", "Another CSV upload is being processed. Retry after it completes.", 30);
    return;
  }

  uploadInProgress = true;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    uploadInProgress = false;
  };

  // finish handles normal completion; close handles clients disconnecting
  // while Multer, validation or profiling is still processing the request.
  res.once("finish", release);
  res.once("close", release);
  next();
}

/** Test-only hook so tests cannot leak a simulated upload lease between cases. */
export function resetUploadRequestGuardForTests(): void {
  uploadInProgress = false;
}
