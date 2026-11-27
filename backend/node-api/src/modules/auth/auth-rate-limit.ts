export type AuthAttempt = { count: number; resetAt: number };
export type AuthAttemptStore = Map<string, AuthAttempt>;

export const AUTH_ATTEMPT_LIMIT = 5;
export const AUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_ATTEMPT_MAX_KEYS = 10_000;

/**
 * Expire stale entries on writes and bound the map. This avoids retaining an
 * unbounded number of one-off source IPs when running the single API process.
 */
function pruneStore(store: AuthAttemptStore, now: number): void {
  for (const [key, value] of store) {
    if (value.resetAt <= now) store.delete(key);
  }
  while (store.size >= AUTH_ATTEMPT_MAX_KEYS) {
    const oldestKey = store.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}

/**
 * Check whether a source has exhausted its failed-attempt budget.
 * Expired entries are removed lazily when that source is checked again.
 */
export function isRateLimited(
  store: AuthAttemptStore,
  key: string,
  now = Date.now(),
): boolean {
  const current = store.get(key);
  if (!current) return false;

  if (current.resetAt <= now) {
    store.delete(key);
    return false;
  }

  return current.count >= AUTH_ATTEMPT_LIMIT;
}

export function recordFailedAttempt(
  store: AuthAttemptStore,
  key: string,
  now = Date.now(),
): void {
  const current = store.get(key);

  if (!current || current.resetAt <= now) {
    if (!current) pruneStore(store, now);
    store.set(key, { count: 1, resetAt: now + AUTH_ATTEMPT_WINDOW_MS });
    return;
  }

  current.count += 1;
}

export function clearFailedAttempts(store: AuthAttemptStore, key: string): void {
  store.delete(key);
}
