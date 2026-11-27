import path from "node:path";
import { config } from "../config.js";

/**
 * Every on-disk path the service writes to is computed here. Nothing else
 * should build a path with string concatenation — that's how path
 * traversal bugs happen. IDs passed in are always our own generated UUIDs
 * or already-validated table names, never raw user input.
 */

export function projectDir(projectId: string): string {
  return path.join(config.STORAGE_ROOT, "projects", projectId);
}

export function versionDir(projectId: string, versionId: string): string {
  return path.join(projectDir(projectId), "versions", versionId);
}

export function rawFilePath(projectId: string, versionId: string, storedFilename: string): string {
  return path.join(versionDir(projectId, versionId), "raw", storedFilename);
}

export function duckdbPath(projectId: string, versionId: string): string {
  return path.join(versionDir(projectId, versionId), "data.duckdb");
}
