// Runs before every test file imports anything. config.ts validates
// process.env at module load time (by design — fail fast at real startup),
// which means tests need these present too, even though nothing here
// touches a real database or a real profiler service.
process.env.NODE_ENV ??= "test";
process.env.API_PORT ??= "8000";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5433/test";
process.env.STORAGE_ROOT ??= "/tmp/datasage-test-storage";
process.env.MAX_FILE_SIZE_BYTES ??= "52428800";
process.env.MAX_FILES_PER_UPLOAD ??= "10";
process.env.PROFILER_BASE_URL ??= "http://localhost:8001";
process.env.PROFILER_TIMEOUT_MS ??= "1000";
