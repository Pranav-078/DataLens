import { z } from "zod";

/**
 * All configuration the Node service needs, validated once at startup.
 * Secrets are read only by the backend process and are never exposed to the
 * browser. Production refuses to start without the admin session guard.
 */
const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(8000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  STORAGE_ROOT: z.string().min(1, "STORAGE_ROOT is required"),
  MAX_FILE_SIZE_BYTES: z.coerce.number().int().positive().default(52_428_800),
  MAX_FILES_PER_UPLOAD: z.coerce.number().int().positive().default(10),

  PROFILER_BASE_URL: z.string().url("PROFILER_BASE_URL must be a valid URL"),
  PROFILER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  GEMINI_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  // Retrieval tuning. All values have safe defaults for local development.
  RAG_RERANK_ENABLED: z.preprocess(
    value => value === undefined || value === "" ? "true" : value,
    z.enum(["true", "false"]).transform(value => value === "true")
  ),
  RAG_RETRIEVAL_CANDIDATES: z.coerce.number().int().min(5).max(100).default(25),
  RAG_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  RAG_MIN_SIMILARITY: z.coerce.number().min(-1).max(1).default(0.2),
  RAG_HISTORY_MESSAGES: z.coerce.number().int().min(0).max(20).default(8),

  AUTH_ENABLED: z.preprocess(
    value => value === undefined || value === "" ? "false" : value,
    z.enum(["true", "false"]).transform(value => value === "true")
  ),
  AUTH_ADMIN_EMAIL: z.preprocess(emptyToUndefined, z.string().email().optional().transform(value => value?.toLowerCase())),
  // Format: 32 hex chars of salt, colon, 128 hex chars of scrypt hash.
  AUTH_ADMIN_PASSWORD_HASH: z.preprocess(
    emptyToUndefined,
    z.string().regex(/^[a-fA-F0-9]{32}:[a-fA-F0-9]{128}$/).optional()
  ),
  AUTH_COOKIE_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
}).superRefine((value, context) => {
  if (value.NODE_ENV === "production" && !value.AUTH_ENABLED) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["AUTH_ENABLED"], message: "Set AUTH_ENABLED=true in production." });
  }
  if (value.AUTH_ENABLED) {
    // User registration is the primary authentication flow. Optional legacy
    // admin credentials remain supported for existing local installations.
    if (!value.AUTH_COOKIE_SECRET) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["AUTH_COOKIE_SECRET"], message: "A random cookie signing secret of at least 32 characters is required." });
    }
  }
});

export type AppConfig = z.infer<typeof envSchema>;

function loadConfig(): AppConfig {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("\n✗ Invalid environment configuration:\n");
    for (const issue of result.error.issues) {
      console.error("  - " + (issue.path.join(".") || "(root)") + ": " + issue.message);
    }
    console.error("\nCheck your .env file against .env.example.\n");
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
