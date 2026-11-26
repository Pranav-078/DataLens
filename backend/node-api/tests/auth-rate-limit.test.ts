import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_ATTEMPT_LIMIT,
  AUTH_ATTEMPT_WINDOW_MS,
  clearFailedAttempts,
  isRateLimited,
  recordFailedAttempt,
  type AuthAttemptStore,
} from "../src/modules/auth/auth-rate-limit.js";

describe("authentication attempt limiter", () => {
  let attempts: AuthAttemptStore;

  beforeEach(() => {
    attempts = new Map();
  });

  it("allows attempts until the configured limit is reached", () => {
    const key = "register:127.0.0.1";

    for (let attempt = 0; attempt < AUTH_ATTEMPT_LIMIT - 1; attempt += 1) {
      expect(isRateLimited(attempts, key, 1_000)).toBe(false);
      recordFailedAttempt(attempts, key, 1_000);
    }

    expect(isRateLimited(attempts, key, 1_000)).toBe(false);
    recordFailedAttempt(attempts, key, 1_000);

    expect(isRateLimited(attempts, key, 1_000)).toBe(true);
  });

  it("starts a fresh window after the fifteen-minute window expires", () => {
    const key = "register:127.0.0.1";
    const startedAt = 10_000;

    for (let attempt = 0; attempt < AUTH_ATTEMPT_LIMIT; attempt += 1) {
      recordFailedAttempt(attempts, key, startedAt);
    }

    expect(isRateLimited(attempts, key, startedAt + AUTH_ATTEMPT_WINDOW_MS - 1)).toBe(true);
    expect(isRateLimited(attempts, key, startedAt + AUTH_ATTEMPT_WINDOW_MS)).toBe(false);
    expect(attempts.has(key)).toBe(false);
  });

  it("clears attempts after a successful authentication", () => {
    const key = "login:127.0.0.1";
    recordFailedAttempt(attempts, key, 5_000);
    recordFailedAttempt(attempts, key, 5_000);

    clearFailedAttempts(attempts, key);

    expect(isRateLimited(attempts, key, 5_000)).toBe(false);
    expect(attempts.has(key)).toBe(false);
  });
});
