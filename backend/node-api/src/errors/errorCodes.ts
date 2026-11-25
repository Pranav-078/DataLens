/**
 * Every error code the API can return, in one place.
 *
 * Rule: the frontend switches on `code`, never on `message`. Messages can
 * change wording; codes are a contract. If you add a new failure mode
 * anywhere in the app, add its code here first — that's what "no silent
 * failures" means in practice.
 */
export const ErrorCode = {
  // ── validation (client sent something wrong) ──────────────────────────
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNSUPPORTED_FILE_TYPE: "UNSUPPORTED_FILE_TYPE",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  TOO_MANY_FILES: "TOO_MANY_FILES",
  EMPTY_FILE: "EMPTY_FILE",
  EMPTY_DATASET: "EMPTY_DATASET",
  MALFORMED_CSV: "MALFORMED_CSV",
  INVALID_ENCODING: "INVALID_ENCODING",
  DUPLICATE_FILENAME: "DUPLICATE_FILENAME",
  DUPLICATE_COLUMN_NAME: "DUPLICATE_COLUMN_NAME",
  TABLE_NAME_COLLISION: "TABLE_NAME_COLLISION",
  UNSAFE_FILE_PATH: "UNSAFE_FILE_PATH",

  // ── not found ──────────────────────────────────────────────────────────
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  VERSION_NOT_FOUND: "VERSION_NOT_FOUND",
  ROUTE_NOT_FOUND: "ROUTE_NOT_FOUND",

  // ── downstream service failures ───────────────────────────────────────
  PROFILER_UNAVAILABLE: "PROFILER_UNAVAILABLE", // connection refused / DNS failure
  PROFILER_TIMEOUT: "PROFILER_TIMEOUT", // took longer than PROFILER_TIMEOUT_MS
  PROFILER_NOT_IMPLEMENTED: "PROFILER_NOT_IMPLEMENTED", // upstream returned 501
  PROFILER_BAD_RESPONSE: "PROFILER_BAD_RESPONSE", // 2xx but the body doesn't match the contract
  PROFILER_ERROR: "PROFILER_ERROR", // upstream returned 5xx (not 501)

  // ── infrastructure ─────────────────────────────────────────────────────
  DATABASE_UNAVAILABLE: "DATABASE_UNAVAILABLE",
  DATABASE_ERROR: "DATABASE_ERROR",
  STORAGE_WRITE_FAILED: "STORAGE_WRITE_FAILED",

  // ── fallback ───────────────────────────────────────────────────────────
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Maps each code to the HTTP status it should be returned with. */
export const ERROR_STATUS: Record<ErrorCodeType, number> = {
  VALIDATION_FAILED: 422,
  UNSUPPORTED_FILE_TYPE: 422,
  FILE_TOO_LARGE: 413,
  TOO_MANY_FILES: 422,
  EMPTY_FILE: 422,
  EMPTY_DATASET: 422,
  MALFORMED_CSV: 422,
  INVALID_ENCODING: 422,
  DUPLICATE_FILENAME: 409,
  DUPLICATE_COLUMN_NAME: 422,
  TABLE_NAME_COLLISION: 409,
  UNSAFE_FILE_PATH: 400,

  PROJECT_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,

  PROFILER_UNAVAILABLE: 503,
  PROFILER_TIMEOUT: 504,
  PROFILER_NOT_IMPLEMENTED: 502,
  PROFILER_BAD_RESPONSE: 502,
  PROFILER_ERROR: 502,

  DATABASE_UNAVAILABLE: 503,
  DATABASE_ERROR: 500,
  STORAGE_WRITE_FAILED: 500,

  INTERNAL_ERROR: 500,
};
