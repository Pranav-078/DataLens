import { config } from "../../config.js";
import { Errors } from "../../errors/AppError.js";
import { logger } from "../../logger.js";

/**
 * The contract this client expects back from the Python service's stub
 * endpoint. Phase 0/Step 1's Python side still serves this at
 * /internal/profile, unchanged — see profileTables() below for the real
 * endpoint added in Step 2.
 */
export interface ProfileStubResponse {
  status: "stub_ok";
  receivedTables: number;
}

function isProfileStubResponse(value: unknown): value is ProfileStubResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).status === "stub_ok" &&
    typeof (value as Record<string, unknown>).receivedTables === "number"
  );
}

/**
 * The contract returned by the real profiling endpoint
 * (POST /internal/profile/tables), matching backend-python's
 * ProfileTablesResponse / FindingPayload exactly (app/api/profile_tables.py).
 */
export interface ProfileFinding {
  issue_type: string;
  dimension: string;
  table: string;
  row_uid: string;
  column: string | null;
  severity: string;
  evidence: Record<string, unknown>;
}

export interface ColumnProfileSummary {
  columnName: string;
  inferredType: string;
  nullCount: number;
  nullPercentage: number;
  distinctCount: number;
  uniquenessRatio: number | null;
}

export interface TableProfileSummary {
  tableName: string;
  rowCount: number;
  columnCount: number;
  columns: ColumnProfileSummary[];
}

export interface ProfileTablesResponse {
  status: "profiled";
  tableCount: number;
  findingCount: number;
  tables: TableProfileSummary[];
  findings: ProfileFinding[];
}

function isProfileFinding(value: unknown): value is ProfileFinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.issue_type === "string" &&
    typeof v.dimension === "string" &&
    typeof v.table === "string" &&
    typeof v.row_uid === "string" &&
    (v.column === null || typeof v.column === "string") &&
    typeof v.severity === "string" &&
    typeof v.evidence === "object" &&
    v.evidence !== null
  );
}

function isColumnProfileSummary(value: unknown): value is ColumnProfileSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.columnName === "string" &&
    typeof v.inferredType === "string" &&
    typeof v.nullCount === "number" &&
    typeof v.nullPercentage === "number" &&
    typeof v.distinctCount === "number" &&
    (v.uniquenessRatio === null || typeof v.uniquenessRatio === "number")
  );
}

function isTableProfileSummary(value: unknown): value is TableProfileSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.tableName === "string" &&
    typeof v.rowCount === "number" &&
    typeof v.columnCount === "number" &&
    Array.isArray(v.columns) &&
    v.columns.every(isColumnProfileSummary)
  );
}

function isProfileTablesResponse(value: unknown): value is ProfileTablesResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.status === "profiled" &&
    typeof v.tableCount === "number" &&
    typeof v.findingCount === "number" &&
    Array.isArray(v.tables) &&
    v.tables.every(isTableProfileSummary) &&
    Array.isArray(v.findings) &&
    v.findings.every(isProfileFinding)
  );
}

/**
 * Shared request/error-mapping logic for every call into the profiling
 * service. Every distinct failure mode gets its own AppError code (see
 * errorCodes.ts) rather than a single generic "profiler failed" — this is
 * what lets the UI (and the failure-path test suite) distinguish "retry
 * later" (unavailable/timeout) from "this is a bug" (bad response/500)
 * from "not built yet" (501). Extracted here so callProfilerStub and
 * profileTables share identical error behavior rather than two
 * hand-maintained copies of it.
 */
async function postToProfiler<T>(path: string, requestBody: unknown, isValidResponse: (value: unknown) => value is T): Promise<T> {
  const url = `${config.PROFILER_BASE_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.PROFILER_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw Errors.profilerTimeout(config.PROFILER_TIMEOUT_MS, err);
    }
    // Connection refused, DNS failure, ECONNRESET, etc. — the service is
    // simply not reachable, distinct from it being reachable but slow.
    throw Errors.profilerUnavailable(err);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 501) {
    throw Errors.profilerNotImplemented();
  }

  if (response.status >= 500) {
    throw Errors.profilerError(response.status);
  }

  if (!response.ok) {
    // A 4xx from our own Python service means WE sent it something it
    // rejected — a bug on our side, but still not something to blame on
    // "the profiler is down". Treated as a bad-response case rather than
    // inventing a sixth category for it.
    throw Errors.profilerBadResponse(`upstream returned ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw Errors.profilerBadResponse("response body was not valid JSON", err);
  }

  if (!isValidResponse(body)) {
    logger.warn({ body, path }, "Profiler returned a 2xx with an unexpected shape");
    throw Errors.profilerBadResponse("response did not match the expected contract");
  }

  return body;
}

/**
 * Calls the Python service's stub profiling endpoint (/internal/profile).
 * Unchanged in behavior from Step 1 — still used only where a real table
 * payload isn't being sent. Kept for backward compatibility; not called
 * from the upload flow anymore as of Step 2 (see upload.controller.ts).
 */
export async function callProfilerStub(tableCount: number): Promise<ProfileStubResponse> {
  return postToProfiler("/internal/profile", { tableCount }, isProfileStubResponse);
}

/**
 * Calls the real profiling endpoint (/internal/profile/tables) added in
 * backend-python Step 1, sending each validated table's actual CSV
 * content and returning the Phase 0-contract-shaped findings it produces.
 */
export async function profileTables(
  tables: { tableName: string; csvContent: string }[]
): Promise<ProfileTablesResponse> {
  return postToProfiler("/internal/profile/tables", { tables }, isProfileTablesResponse);
}
