import fs from "node:fs/promises";
import path from "node:path";
import { rawFilePath } from "./paths.js";
import { Errors } from "../errors/AppError.js";

export interface WrittenFile {
  tableName: string;
  filePath: string;
}

/**
 * Writes one validated file's buffer to disk, at the path storage/paths.ts
 * computes from the project/version IDs — the one place that decides where
 * files live. Stored under the sanitized table name (e.g. "customers.csv"),
 * not the original filename: the table name is already validated safe by
 * upload.validator.ts, giving a predictable, browsable on-disk layout
 * independent of whatever the original filename happened to be.
 */
export async function writeUploadedFiles(
  projectId: string,
  versionId: string,
  files: { tableName: string; buffer: Buffer }[]
): Promise<WrittenFile[]> {
  const written: WrittenFile[] = [];

  for (const file of files) {
    const storedFilename = `${file.tableName}.csv`;
    const filePath = rawFilePath(projectId, versionId, storedFilename);

    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, file.buffer);
    } catch (err) {
      throw Errors.storageWriteFailed(file.tableName, err);
    }

    written.push({ tableName: file.tableName, filePath });
  }

  return written;
}
