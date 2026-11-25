/**
 * Augments Express's Request type with `id`, set by requestId middleware
 * (see middleware/requestId.ts) before any route or error handler runs.
 *
 * This file has no imports/exports of its own — it's a global augmentation,
 * picked up automatically by `tsconfig.json`'s `include: ["src"]`.
 */
declare namespace Express {
  export interface Request {
    /** Unique per-request ID, present on every request from requestId middleware onward. */
    id: string;
  }
}
