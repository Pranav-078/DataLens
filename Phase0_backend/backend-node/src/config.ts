import { z } from "zod";

/**
 * All configuration the Node service needs, validated once at startup.
 *
 * Rule: nothing else in the codebase reads `process.env` directly. If a
 * variable is missing or malformed, we fail loudly here, before the server
 * starts accepting requests — a service that boots with bad config and
 * fails on the first request is much harder to debug than one that refuses
 * to boot at all.
 */
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
});

export type AppConfig = z.infer<typeof envSchema>;

function loadConfig(): AppConfig {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    // Deliberately bypass the structured logger: at this point we don't
    // know if the logger itself is configured correctly, and this message
    // needs to be readable in a raw container-startup log either way.
    console.error("\n✗ Invalid environment configuration:\n");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    console.error("\nCheck your .env file against .env.example.\n");
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
