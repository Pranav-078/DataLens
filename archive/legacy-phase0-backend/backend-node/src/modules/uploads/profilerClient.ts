import { config } from "../../config.js";
import { Errors } from "../../errors/AppError.js";
import { logger } from "../../logger.js";

/**
 * The contract this client expects back from the Python service on success.
 * Phase 0's Python side is a stub that never really profiles anything, but
 * the shape here is what Phase 1's real endpoint will return, so the
 * response-shape validation below is exercising real, permanent logic.
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
 * Calls the Python service's stub profiling endpoint. Every failure mode
 * gets its OWN error code (see errorCodes.ts) rather than a single generic
 * "profiler failed" — this is what lets the UI (and the failure-path test
 * suite) distinguish "retry later" (unavailable/timeout) from "this is a
 * bug" (bad response/500) from "not built yet" (501).
 */
export async function callProfilerStub(tableCount: number): Promise<ProfileStubResponse> {
  const url = `${config.PROFILER_BASE_URL}/internal/profile`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.PROFILER_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tableCount }),
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

  if (!isProfileStubResponse(body)) {
    logger.warn({ body }, "Profiler stub returned a 2xx with an unexpected shape");
    throw Errors.profilerBadResponse("response did not match the expected contract");
  }

  return body;
}
