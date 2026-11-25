// Named import, not default: under this project's `module: NodeNext` /
// `moduleResolution: NodeNext` config, pino's default export does not
// resolve as callable even though its .d.ts declares one (verified by
// isolated repro). The named export is unaffected and is what pino's own
// docs use for ESM consumers, so this isn't a workaround, it's the
// correct import for this setup.
import { pino } from "pino";
import { config } from "./config.js";

/**
 * One logger instance for the whole service. Structured JSON, not text —
 * every log line is a parseable object. `pretty` printing is deliberately
 * NOT enabled even in development: what you see locally should be what you
 * see in production logs, so formatting problems get caught early.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: "datasage-api" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
