import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFakeDb } from "./fakeProfilingDb.js";
import { processUpload } from "../src/services/uploadProfilingService.js";
import type { ValidatedFile } from "../src/modules/uploads/upload.validator.js";

vi.mock("../src/modules/uploads/profilerClient.js", () => ({
  profileTables: vi.fn(),
}));

beforeEach(() => {
  process.env.STORAGE_ROOT = "/tmp/datasage-service-test-storage";
});
afterEach(() => vi.resetAllMocks());

function validatedFile(overrides: Partial<ValidatedFile> = {}): ValidatedFile {
  return {
    originalFilename: "customers.csv",
    tableName: "customers",
    normalizedName: "customers",
    sizeBytes: 20,
    checksumSha256: "abc",
    columnNames: ["id", "email"],
    rowCount: 3,
    ...overrides,
  };
}

describe("processUpload — success path", () => {
  it("persists a version/job and returns their real IDs", async () => {
    const { profileTables } = await import("../src/modules/uploads/profilerClient.js");
    vi.mocked(profileTables).mockResolvedValue({
      status: "profiled",
      tableCount: 1,
      findingCount: 0,
      tables: [{ tableName: "customers", rowCount: 3, columnCount: 2, columns: [] }],
      findings: [],
    });

    const db = createFakeDb();
    const result = await processUpload(db, {
      validatedFiles: [validatedFile()],
      buffers: [Buffer.from("id,email\n1,a@x.com\n2,b@x.com\n3,c@x.com\n")],
    });

    expect(db._fake.versions.get(result.versionId)?.status).toBe("ready");
    expect(db._fake.jobs.get(result.jobId)?.status).toBe("succeeded");
  });
});

describe("processUpload — failure path", () => {
  it("marks version/job failed and re-throws the original error when profiling fails", async () => {
    const { profileTables } = await import("../src/modules/uploads/profilerClient.js");
    const profilerError = new Error("profiler unreachable");
    vi.mocked(profileTables).mockRejectedValue(profilerError);

    const db = createFakeDb();
    await expect(
      processUpload(db, {
        validatedFiles: [validatedFile()],
        buffers: [Buffer.from("id,email\n1,a@x.com\n")],
      })
    ).rejects.toBe(profilerError); // the ORIGINAL error, not swallowed or replaced

    const [version] = [...db._fake.versions.values()];
    const [job] = [...db._fake.jobs.values()];
    expect(version?.status).toBe("failed");
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toContain("profiler unreachable");
  });

  it("re-throws the original error even when marking the failure ALSO fails", async () => {
    // The specific edge case the "do not swallow errors" requirement is
    // really about: two failures in a row must never produce a silent
    // success or a misleading error.
    const { profileTables } = await import("../src/modules/uploads/profilerClient.js");
    const profilerError = new Error("profiler unreachable");
    vi.mocked(profileTables).mockRejectedValue(profilerError);

    const db = createFakeDb();
    // Force the failure-marking transaction to itself throw.
    db.datasetVersion.update = vi.fn().mockRejectedValue(new Error("db connection dropped"));

    await expect(
      processUpload(db, {
        validatedFiles: [validatedFile()],
        buffers: [Buffer.from("id,email\n1,a@x.com\n")],
      })
    ).rejects.toBe(profilerError); // still the ORIGINAL error, not the mark-failed error
  });

  it("marks failed when the persistence step itself throws, even though profiling succeeded", async () => {
    const { profileTables } = await import("../src/modules/uploads/profilerClient.js");
    vi.mocked(profileTables).mockResolvedValue({
      status: "profiled",
      tableCount: 1,
      findingCount: 0,
      tables: [{ tableName: "customers", rowCount: 1, columnCount: 2, columns: [] }],
      findings: [],
    });

    const db = createFakeDb();
    const persistenceError = new Error("unique constraint violation");
    db.qualityIssue.create = vi.fn().mockRejectedValue(persistenceError);
    // Force at least one issue to exist so qualityIssue.create is actually called.
    vi.mocked(profileTables).mockResolvedValueOnce({
      status: "profiled",
      tableCount: 1,
      findingCount: 1,
      tables: [{ tableName: "customers", rowCount: 1, columnCount: 2, columns: [] }],
      findings: [
        {
          issue_type: "empty_string",
          dimension: "completeness",
          table: "customers",
          row_uid: "customers:1",
          column: "email",
          severity: "medium",
          evidence: {},
        },
      ],
    });

    await expect(
      processUpload(db, {
        validatedFiles: [validatedFile()],
        buffers: [Buffer.from("id,email\n1,\n")],
      })
    ).rejects.toBe(persistenceError);

    const [version] = [...db._fake.versions.values()];
    expect(version?.status).toBe("failed");
  });
});
