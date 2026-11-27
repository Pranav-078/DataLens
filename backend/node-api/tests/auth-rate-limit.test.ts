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


describe("bounded authentication attempt store", () => {
  it("expires stale keys and evicts the oldest entry when the store reaches its cap", async () => {
    const { recordFailedAttempt, AUTH_ATTEMPT_MAX_KEYS } = await import("../src/modules/auth/auth-rate-limit.js");
    const store = new Map();
    const now = 1_000_000;
    store.set("expired", { count: 1, resetAt: now - 1 });
    for (let index = 0; index < AUTH_ATTEMPT_MAX_KEYS - 1; index += 1) {
      store.set("ip-" + index, { count: 1, resetAt: now + 60_000 });
    }

    recordFailedAttempt(store, "new-ip", now);

    expect(store.size).toBe(AUTH_ATTEMPT_MAX_KEYS);
    expect(store.has("expired")).toBe(false);
    // Expiring one stale key frees capacity, so no active key is evicted.
    expect(store.has("ip-0")).toBe(true);
    expect(store.has("new-ip")).toBe(true);

    const fullStore = new Map();
    for (let index = 0; index < AUTH_ATTEMPT_MAX_KEYS; index += 1) {
      fullStore.set("active-" + index, { count: 1, resetAt: now + 60_000 });
    }
    recordFailedAttempt(fullStore, "next-ip", now);
    expect(fullStore.size).toBe(AUTH_ATTEMPT_MAX_KEYS);
    expect(fullStore.has("active-0")).toBe(false);
    expect(fullStore.has("next-ip")).toBe(true);
  });
});
