import { ErrorCode, ERROR_STATUS, type ErrorCodeType } from "./errorCodes.js";

/**
 * The only exception type that should be thrown deliberately anywhere in
 * this codebase. It always carries a closed `code` (see errorCodes.ts) and
 * an HTTP status derived from that code — you cannot construct an AppError
 * with a code/status pair that disagrees, which is what keeps the contract
 * enforceable instead of just documented.
 *
 * `details` is for machine-readable context (which filename, which byte
 * limit). It is safe to send to the client. Never put a raw exception,
 * a stack trace, or a database error message in `details` — those go to
 * the logger only (see errorHandler.ts).
 */
export class AppError extends Error {
  public readonly code: ErrorCodeType;
  public readonly status: number;
  public readonly details: Record<string, unknown>;
  /** The original error, if this AppError wraps one. Logged, never sent to the client. */
  public readonly cause?: unknown;

  constructor(
    code: ErrorCodeType,
    message: string,
    details: Record<string, unknown> = {},
    cause?: unknown
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
    this.cause = cause;
    Error.captureStackTrace?.(this, AppError);
  }
}

// A handful of constructors for the errors used across upload validation,
// so call sites read as intent rather than repeating `new AppError(...)`.

export const Errors = {
  unsupportedFileType: (filename: string, detected: string) =>
    new AppError(
      ErrorCode.UNSUPPORTED_FILE_TYPE,
      `"${filename}" is not a supported file type (detected: ${detected}). Only CSV files are accepted.`,
      { filename, detected }
    ),

  fileTooLarge: (filename: string, sizeBytes: number, limitBytes: number) =>
    new AppError(
      ErrorCode.FILE_TOO_LARGE,
      `"${filename}" is ${(sizeBytes / 1_000_000).toFixed(1)}MB, which exceeds the ${(
        limitBytes / 1_000_000
      ).toFixed(0)}MB limit.`,
      { filename, sizeBytes, limitBytes }
    ),

  tooManyFiles: (count: number, limit: number) =>
    new AppError(
      ErrorCode.TOO_MANY_FILES,
      `${count} files were uploaded; the limit per upload is ${limit}.`,
      { count, limit }
    ),

  emptyFile: (filename: string) =>
    new AppError(ErrorCode.EMPTY_FILE, `"${filename}" is a zero-byte file.`, { filename }),

  emptyDataset: (filename: string) =>
    new AppError(
      ErrorCode.EMPTY_DATASET,
      `"${filename}" has a header row but no data rows.`,
      { filename }
    ),

  malformedCsv: (filename: string, reason: string, line?: number) =>
    new AppError(
      ErrorCode.MALFORMED_CSV,
      `"${filename}" could not be parsed as CSV: ${reason}${line ? ` (line ${line})` : ""}.`,
      { filename, reason, line }
    ),

  invalidEncoding: (filename: string, detectedEncoding: string | null) =>
    new AppError(
      ErrorCode.INVALID_ENCODING,
      `"${filename}" is not valid UTF-8${
        detectedEncoding ? ` (detected: ${detectedEncoding})` : ""
      }. Please re-export it as UTF-8.`,
      { filename, detectedEncoding }
    ),

  duplicateFilename: (filename: string) =>
    new AppError(
      ErrorCode.DUPLICATE_FILENAME,
      `"${filename}" was included more than once in this upload.`,
      { filename }
    ),

  duplicateColumnName: (filename: string, columnName: string) =>
    new AppError(
      ErrorCode.DUPLICATE_COLUMN_NAME,
      `"${filename}" has more than one column named "${columnName}".`,
      { filename, columnName }
    ),

  tableNameCollision: (filenameA: string, filenameB: string, normalizedName: string) =>
    new AppError(
      ErrorCode.TABLE_NAME_COLLISION,
      `"${filenameA}" and "${filenameB}" both normalize to the table name "${normalizedName}". Rename one of the files.`,
      { filenameA, filenameB, normalizedName }
    ),

  unsafeFilePath: (filename: string) =>
    new AppError(
      ErrorCode.UNSAFE_FILE_PATH,
      `"${filename}" contains an unsafe path segment and was rejected.`,
      { filename }
    ),

  profilerUnavailable: (cause: unknown) =>
    new AppError(
      ErrorCode.PROFILER_UNAVAILABLE,
      "The profiling service is unreachable. Please try again shortly.",
      {},
      cause
    ),

  profilerTimeout: (timeoutMs: number, cause?: unknown) =>
    new AppError(
      ErrorCode.PROFILER_TIMEOUT,
      `The profiling service did not respond within ${timeoutMs}ms.`,
      { timeoutMs },
      cause
    ),

  profilerNotImplemented: () =>
    new AppError(
      ErrorCode.PROFILER_NOT_IMPLEMENTED,
      "The profiling service does not yet implement this operation.",
      {}
    ),

  profilerBadResponse: (reason: string, cause?: unknown) =>
    new AppError(
      ErrorCode.PROFILER_BAD_RESPONSE,
      `The profiling service returned a response that did not match the expected contract: ${reason}`,
      { reason },
      cause
    ),

  profilerError: (status: number, cause?: unknown) =>
    new AppError(
      ErrorCode.PROFILER_ERROR,
      `The profiling service returned an error (status ${status}).`,
      { upstreamStatus: status },
      cause
    ),

  databaseError: (cause: unknown) =>
    new AppError(
      ErrorCode.DATABASE_ERROR,
      "A database operation failed.",
      {},
      cause
    ),

  storageWriteFailed: (filename: string, cause: unknown) =>
    new AppError(
      ErrorCode.STORAGE_WRITE_FAILED,
      `Failed to save "${filename}" to disk.`,
      { filename },
      cause
    ),
};
