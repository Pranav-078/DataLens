import { createRequire } from "node:module";
import { parse } from "csv-parse/sync";
import { fileTypeFromBuffer } from "file-type";
import { config } from "../../config.js";
import { Errors } from "../../errors/AppError.js";
import { normalizeTableName } from "./tableName.js";

// jschardet is CJS-only with no clean ESM interop; used purely to add a
// human-readable "detected encoding" hint to an error message that is
// already correctly triggered by the strict UTF-8 check below, so it's
// loaded via createRequire rather than a top-level import.
const require = createRequire(import.meta.url);

export interface UploadFileInput {
  originalFilename: string;
  buffer: Buffer;
}

export interface ValidatedFile {
  originalFilename: string;
  tableName: string;
  normalizedName: string;
  sizeBytes: number;
  checksumSha256: string;
  columnNames: string[];
  rowCount: number;
}

// ── individual checks, each pure and independently testable ────────────────

/**
 * Rejects any filename that could escape the intended storage directory:
 * `..` segments, path separators, a leading `/` or drive letter, or a null
 * byte. This runs on the ORIGINAL filename as supplied by the client —
 * we never trust it for an actual path; storage/paths.ts always builds
 * paths from our own generated IDs. This check exists so a malicious
 * filename is rejected with a clear reason rather than silently sanitized.
 */
export function checkPathSafety(filename: string): void {
  const hasTraversal = filename.includes("..");
  const hasSeparator = filename.includes("/") || filename.includes("\\");
  const hasNullByte = filename.includes("\0");
  const isAbsoluteLike = /^([a-zA-Z]:)?[/\\]/.test(filename);

  if (hasTraversal || hasSeparator || hasNullByte || isAbsoluteLike) {
    throw Errors.unsafeFilePath(filename);
  }
}

export function checkFileCount(fileCount: number): void {
  if (fileCount > config.MAX_FILES_PER_UPLOAD) {
    throw Errors.tooManyFiles(fileCount, config.MAX_FILES_PER_UPLOAD);
  }
}

export function checkFileSize(filename: string, sizeBytes: number): void {
  if (sizeBytes === 0) {
    throw Errors.emptyFile(filename);
  }
  if (sizeBytes > config.MAX_FILE_SIZE_BYTES) {
    throw Errors.fileTooLarge(filename, sizeBytes, config.MAX_FILE_SIZE_BYTES);
  }
}

/**
 * CSV has no magic bytes of its own, so we can't positively confirm "this
 * is a CSV" from content alone. What we CAN do is confirm it is NOT some
 * other known binary format wearing a .csv extension (a renamed .xlsx or
 * .png, for instance) — `file-type` sniffs magic bytes and returns a
 * result only when it recognizes a binary signature. A CSV/plain-text file
 * correctly produces no match, which is the expected "safe" outcome here.
 */
export async function checkFileType(filename: string, buffer: Buffer): Promise<void> {
  if (!filename.toLowerCase().endsWith(".csv")) {
    throw Errors.unsupportedFileType(filename, "unknown (missing .csv extension)");
  }

  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try {
    detected = await fileTypeFromBuffer(buffer);
  } catch {
    // fileTypeFromBuffer can THROW (not just return undefined) when the
    // buffer's leading bytes match a known binary format's magic signature
    // but the buffer is too short/truncated for it to fully parse that
    // format's structure (e.g. a PNG header with no actual image data
    // after it). That is itself a strong signal this is a disguised or
    // corrupt binary file, not plain-text CSV — so it's treated as a
    // detected, rejected type rather than allowed to crash the request.
    throw Errors.unsupportedFileType(filename, "unknown binary format (truncated signature)");
  }

  if (detected) {
    throw Errors.unsupportedFileType(filename, detected.mime);
  }
}

/**
 * Strict UTF-8 validation via TextDecoder's fatal mode — this is a direct
 * check of byte-sequence validity, not a heuristic. jschardet is used only
 * to produce a friendlier "detected: windows-1252"-style message; it is
 * never the thing deciding pass/fail.
 */
export function checkEncoding(filename: string, buffer: Buffer): void {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    let guess: string | null = null;
    try {
      const jschardet = require("jschardet") as { detect: (b: Buffer) => { encoding: string } };
      guess = jschardet.detect(buffer)?.encoding ?? null;
    } catch {
      guess = null;
    }
    throw Errors.invalidEncoding(filename, guess);
  }
}

interface ParsedCsv {
  columnNames: string[];
  rowCount: number;
}

/**
 * Parses with csv-parse in strict mode (`relax_column_count: false`), which
 * is what turns a ragged row into a catchable error rather than silently
 * padding/truncating it. Also enforces: at least one data row, and no two
 * columns sharing a name.
 */
export function parseAndValidateCsv(filename: string, buffer: Buffer): ParsedCsv {
  let records: string[][];
  try {
    records = parse(buffer, {
      bom: true,
      relax_column_count: false,
      skip_empty_lines: true,
    }) as string[][];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lineMatch = message.match(/line (\d+)/i);
    throw Errors.malformedCsv(filename, message, lineMatch ? Number(lineMatch[1]) : undefined);
  }

  if (records.length === 0) {
    // The file has bytes (checkFileSize already ruled out zero-byte files)
    // but csv-parse found no rows at all — e.g. a file of only blank
    // lines. Closer to "no usable data" than "header with no rows", but
    // there's no header either, so EMPTY_DATASET is the closer fit of the
    // two codes we have.
    throw Errors.emptyDataset(filename);
  }

  const header = records[0] ?? [];
  const seen = new Set<string>();
  for (const rawName of header) {
    const columnName = rawName.trim();
    if (seen.has(columnName)) {
      throw Errors.duplicateColumnName(filename, columnName);
    }
    seen.add(columnName);
  }

  const dataRows = records.slice(1);
  if (dataRows.length === 0) {
    throw Errors.emptyDataset(filename);
  }

  return { columnNames: header.map((h) => h.trim()), rowCount: dataRows.length };
}

// ── batch-level checks, across all files in one upload ─────────────────────

export function checkDuplicateFilenames(files: UploadFileInput[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.originalFilename)) {
      throw Errors.duplicateFilename(file.originalFilename);
    }
    seen.add(file.originalFilename);
  }
}

/**
 * Two files that normalize to the same table name would silently collide
 * once written to the same version — "Orders.csv" and "orders (1).csv"
 * both become "orders". This has to be checked across the whole batch,
 * not per-file, which is why it lives here rather than in tableName.ts.
 */
export function checkTableNameCollisions(
  files: { originalFilename: string; normalizedName: string }[]
): void {
  const seenBy = new Map<string, string>(); // normalizedName -> first filename that used it
  for (const file of files) {
    const existing = seenBy.get(file.normalizedName);
    if (existing) {
      throw Errors.tableNameCollision(existing, file.originalFilename, file.normalizedName);
    }
    seenBy.set(file.normalizedName, file.originalFilename);
  }
}

// ── orchestrator ─────────────────────────────────────────────────────────

export async function validateUploadBatch(files: UploadFileInput[]): Promise<ValidatedFile[]> {
  checkFileCount(files.length);
  checkDuplicateFilenames(files);

  const validated: ValidatedFile[] = [];

  for (const file of files) {
    checkPathSafety(file.originalFilename);
    checkFileSize(file.originalFilename, file.buffer.byteLength);
    await checkFileType(file.originalFilename, file.buffer);
    checkEncoding(file.originalFilename, file.buffer);

    const { columnNames, rowCount } = parseAndValidateCsv(file.originalFilename, file.buffer);
    const normalizedName = normalizeTableName(file.originalFilename);

    validated.push({
      originalFilename: file.originalFilename,
      tableName: normalizedName,
      normalizedName,
      sizeBytes: file.buffer.byteLength,
      checksumSha256: await sha256(file.buffer),
      columnNames,
      rowCount,
    });
  }

  checkTableNameCollisions(validated);

  return validated;
}

async function sha256(buffer: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(buffer).digest("hex");
}
