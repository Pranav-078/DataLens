import { vi } from "vitest";
import type { ProfilingDb } from "../src/repo/types.js";

/**
 * An in-memory stand-in for ProfilingDb, used across persistence AND query
 * tests. This is explicitly NOT a test of real PostgreSQL/Prisma behavior
 * — it's a fake that lets orchestration logic (repo functions, the service
 * layer, controllers) be tested in isolation from a real database. See
 * each test file's own comments for which specific behaviors this can and
 * cannot prove; the real-Postgres verification this cannot provide is
 * called out explicitly in each slice's final report.
 */
export function createFakeDb() {
  let nextId = 1;
  const genId = (prefix: string) => `${prefix}-${nextId++}`;

  const projects = new Map<string, { id: string; name: string; createdAt: Date }>();
  const versions = new Map<
    string,
    { id: string; projectId: string; versionNumber: number; status: string; createdAt: Date }
  >();
  const jobs = new Map<string, Record<string, unknown> & { id: string }>();
  const tables = new Map<string, Record<string, unknown> & { id: string }>();
  const columns = new Map<string, Record<string, unknown> & { id: string }>();
  const statistics: (Record<string, unknown>)[] = [];
  const issues: (Record<string, unknown> & { id: string })[] = [];
  const relationships: (Record<string, unknown> & { id: string })[] = [];
  const qualityScores: (Record<string, unknown> & { id: string })[] = [];

  const state = {
    projects,
    versions,
    jobs,
    tables,
    columns,
    statistics,
    issues,
    relationships,
    qualityScores,
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
      relationships.length = 0;
      qualityScores.length = 0;
    },
  };

  const db: ProfilingDb & { _fake: typeof state } = Object.assign(
    {
      project: {
        create: vi.fn(async ({ data }: any) => {
          const row = { id: genId("project"), name: data.name, createdAt: new Date() };
          projects.set(row.id, row);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: any) => projects.get(where.id) ?? null),
      },
      datasetVersion: {
        create: vi.fn(async ({ data }: any) => {
          const row = {
            id: genId("version"),
            projectId: data.projectId,
            versionNumber: data.versionNumber,
            status: data.status,
            createdAt: new Date(),
          };
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
        findUnique: vi.fn(async ({ where }: any) => versions.get(where.id) ?? null),
        findMany: vi.fn(async ({ where }: any) => {
          return [...versions.values()]
            .filter((v) => v.projectId === where.projectId)
            .sort((a, b) => b.versionNumber - a.versionNumber);
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
          const row = { id: genId("table"), ...data, createdAt: new Date() };
          tables.set(row.id, row);
          return row;
        }),
        findMany: vi.fn(async ({ where }: any) => {
          return [...tables.values()].filter((t) => t.versionId === where.versionId);
        }),
      },
      datasetColumn: {
        create: vi.fn(async ({ data }: any) => {
          const row = { id: genId("column"), ...data };
          columns.set(row.id, row);
          return row;
        }),
        findMany: vi.fn(async ({ where }: any) => {
          const ids: string[] = where.tableId.in;
          return [...columns.values()].filter((c) => ids.includes(c.tableId as string));
        }),
      },
      columnStatistics: {
        create: vi.fn(async ({ data }: any) => {
          statistics.push(data);
          return { id: genId("stat") };
        }),
        findMany: vi.fn(async ({ where }: any) => {
          const ids: string[] = where.columnId.in;
          return statistics.filter((s) => ids.includes(s.columnId as string));
        }),
      },
      qualityIssue: {
        // FIXED: previously returned a throwaway {id} while storing the
        // row WITHOUT one — any read of a persisted issue would have come
        // back with no id at all. Now the stored row and the returned row
        // are the same object, both carrying the real id.
        create: vi.fn(async ({ data }: any) => {
          const row = { id: genId("issue"), ...data, createdAt: new Date() };
          issues.push(row);
          return row;
        }),
        findMany: vi.fn(async ({ where, skip, take, orderBy }: any) => {
          let matches = issues.filter((i) => i.versionId === where.versionId);
          if (orderBy?.createdAt === "desc") {
            matches = [...matches].sort(
              (a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()
            );
          }
          return matches.slice(skip, skip + take);
        }),
        count: vi.fn(async ({ where }: any) => issues.filter((i) => i.versionId === where.versionId).length),
      },
      inferredRelationship: {
        // Same fix as qualityIssue.create above: stored row now carries
        // its own real id instead of a throwaway one that was never saved.
        create: vi.fn(async ({ data }: any) => {
          const row = { id: genId("relationship"), ...data, createdAt: new Date() };
          relationships.push(row);
          return row;
        }),
        findMany: vi.fn(async ({ where }: any) => {
          return relationships.filter((r) => r.versionId === where.versionId);
        }),
      },
      qualityScore: {
        create: vi.fn(async ({ data }: any) => {
          const row = { id: genId("score"), ...data, createdAt: new Date() };
          qualityScores.push(row);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          return qualityScores.find((s) => s.versionId === where.versionId) ?? null;
        }),
      },
      $transaction: vi.fn(async (fn: (tx: ProfilingDb) => Promise<unknown>) => fn(db)),
    } as unknown as ProfilingDb,
    { _fake: state }
  );

  return db;
}
