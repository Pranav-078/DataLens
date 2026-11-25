import { vi } from "vitest";
import type { ProfilingDb } from "../src/repo/types.js";

/**
 * An in-memory stand-in for ProfilingDb, used across persistence tests.
 *
 * This is explicitly NOT a test of real PostgreSQL/Prisma behavior — it's
 * a fake that lets orchestration logic (repo functions, the service layer,
 * the controller) be tested in isolation from a real database. See each
 * test file's own comments for which specific behaviors this can and
 * cannot prove; the real-Postgres verification this cannot provide is
 * called out explicitly in this step's final report.
 */
export function createFakeDb() {
  let nextId = 1;
  const genId = (prefix: string) => `${prefix}-${nextId++}`;

  const projects = new Map<string, { id: string; name: string }>();
  const versions = new Map<string, { id: string; projectId: string; versionNumber: number; status: string }>();
  const jobs = new Map<string, Record<string, unknown> & { id: string }>();
  const tables = new Map<string, Record<string, unknown> & { id: string }>();
  const columns = new Map<string, Record<string, unknown> & { id: string }>();
  const statistics: (Record<string, unknown>)[] = [];
  const issues: (Record<string, unknown>)[] = [];

  const state = {
    projects,
    versions,
    jobs,
    tables,
    columns,
    statistics,
    issues,
    /** Clears all persisted rows. Tests call this in beforeEach — Vitest
     * caches a vi.mock factory's result across vi.resetModules(), so the
     * fake can't rely on being re-created per test. */
    reset() {
      projects.clear();
      versions.clear();
      jobs.clear();
      tables.clear();
      columns.clear();
      statistics.length = 0;
      issues.length = 0;
    },
  };

  const db: ProfilingDb & { _fake: typeof state } = Object.assign(
    {
      project: {
        create: vi.fn(async ({ data }: any) => {
          const row = { id: genId("project"), name: data.name };
          projects.set(row.id, row);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: any) => projects.get(where.id) ?? null),
      },
      datasetVersion: {
        create: vi.fn(async ({ data }: any) => {
          const row = { id: genId("version"), projectId: data.projectId, versionNumber: data.versionNumber, status: data.status };
          versions.set(row.id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = versions.get(where.id);
          if (!row) throw new Error(`fake db: no version ${where.id}`);
          Object.assign(row, data);
          return row;
        }),
        findFirst: vi.fn(async ({ where }: any) => {
          const matches = [...versions.values()]
            .filter((v) => v.projectId === where.projectId)
            .sort((a, b) => b.versionNumber - a.versionNumber);
          return matches[0] ?? null;
        }),
      },
      job: {
        create: vi.fn(async ({ data }: any) => {
          const row = { id: genId("job"), ...data };
          jobs.set(row.id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = jobs.get(where.id);
          if (!row) throw new Error(`fake db: no job ${where.id}`);
          Object.assign(row, data);
          return row;
        }),
      },
      datasetTable: {
        create: vi.fn(async ({ data }: any) => {
          const row = { id: genId("table"), ...data };
          tables.set(row.id, row);
          return row;
        }),
      },
      datasetColumn: {
        create: vi.fn(async ({ data }: any) => {
          const row = { id: genId("column"), ...data };
          columns.set(row.id, row);
          return row;
        }),
      },
      columnStatistics: {
        create: vi.fn(async ({ data }: any) => {
          statistics.push(data);
          return { id: genId("stat") };
        }),
      },
      qualityIssue: {
        create: vi.fn(async ({ data }: any) => {
          issues.push(data);
          return { id: genId("issue") };
        }),
      },
      $transaction: vi.fn(async (fn: (tx: ProfilingDb) => Promise<unknown>) => fn(db)),
    } as ProfilingDb,
    { _fake: state }
  );

  return db;
}
