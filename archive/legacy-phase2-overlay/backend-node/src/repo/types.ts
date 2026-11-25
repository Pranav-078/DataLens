/**
 * The exact subset of Prisma Client's surface the profiling persistence
 * layer depends on, as a hand-written interface rather than an import of
 * @prisma/client's generated types.
 *
 * Why: this sandbox has never successfully run `prisma generate` against
 * the real schema (see docs/architecture.md's "Known gap" section from
 * Phase 0 — Prisma's engine-binary host is unreachable here), so the
 * generated client's TypeScript types are still a stale placeholder with
 * none of our real models on it. Depending on that generated type directly
 * would make this file fail to type-check here for reasons that have
 * nothing to do with whether the code is correct.
 *
 * This is also just better design independent of that constraint: the
 * repo layer declaring exactly what it needs, rather than depending on
 * the entire generated client, is what makes it mockable with a plain
 * object in tests instead of needing to mock a whole Prisma module.
 *
 * A real, correctly-generated PrismaClient (and its $transaction callback
 * argument, Prisma.TransactionClient) will structurally satisfy this
 * interface once `prisma generate` runs for real — every field name and
 * shape below was checked directly against prisma/schema.prisma, not
 * assumed. If a future schema change renames a field, this file and
 * schema.prisma must be kept in sync (the same tradeoff already accepted
 * for backend-python/app/contracts.py mirroring evaluation/detector_contract.py).
 */

export interface IdRow {
  id: string;
}

export interface ProjectRow extends IdRow {
  name: string;
  createdAt?: Date;
}

export interface DatasetVersionRow extends IdRow {
  projectId?: string;
  versionNumber: number;
  status: string;
  label?: string | null;
  createdAt?: Date;
}

export interface DatasetTableRow extends IdRow {
  versionId: string;
  tableName: string;
  normalizedName: string;
  originalFilename: string;
  filePath: string;
  rowCount: number | null;
  columnCount: number | null;
  fileSizeBytes: bigint;
  checksum: string;
  createdAt?: Date;
}

export interface DatasetColumnRow extends IdRow {
  tableId: string;
  columnName: string;
  ordinalPosition: number;
  inferredType: string | null;
}

export interface ColumnStatisticsRow {
  columnId: string;
  nullCount: number;
  nullPercentage: number;
  distinctCount: number;
  uniquenessRatio: number;
}

export interface QualityIssueRow extends IdRow {
  versionId: string;
  tableId: string | null;
  columnId: string | null;
  issueType: string;
  dimension: string;
  severity: string;
  title: string;
  description: string;
  affectedRows: number;
  totalRows: number;
  affectedPercentage: number;
  examples: string[];
  evidence: Record<string, unknown>;
  fingerprint: string;
  createdAt?: Date;
}

export interface InferredRelationshipRow extends IdRow {
  versionId: string;
  parentTableId: string;
  parentColumnId: string;
  childTableId: string;
  childColumnId: string;
  confidence: number;
  confidenceBand: string;
  status: string;
  valueOverlap: number;
  orphanCount: number;
  orphanPercentage: number;
  orphanExamples: string[];
  evidence: Record<string, unknown>;
  createdAt?: Date;
}

export interface QualityScoreRow extends IdRow {
  versionId: string;
  overallScore: number | null;
  completeness: number | null;
  uniqueness: number | null;
  validity: number | null;
  consistency: number | null;
  referentialIntegrity: number | null;
  applicableDimensions: string[];
  weightsUsed: Record<string, unknown>;
  capApplied: number | null;
  capReason: string | null;
  calculationBreakdown: Record<string, unknown>;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

// ── inputs, one per write operation, field names matching schema.prisma exactly ──

export interface CreateProjectInput {
  name: string;
}

export interface CreateVersionInput {
  projectId: string;
  versionNumber: number;
  label?: string | null;
  status: string;
}

export interface CreateJobInput {
  projectId: string;
  versionId: string;
  jobType: string;
  status: string;
  startedAt?: Date;
}

export interface UpdateJobInput {
  id: string;
  status: string;
  progressPercent?: number;
  currentStep?: string | null;
  errorMessage?: string | null;
  finishedAt?: Date;
}

export interface CreateDatasetTableInput {
  versionId: string;
  tableName: string;
  normalizedName: string;
  originalFilename: string;
  filePath: string;
  rowCount: number;
  columnCount: number;
  fileSizeBytes: bigint;
  checksum: string;
}

export interface CreateDatasetColumnInput {
  tableId: string;
  columnName: string;
  ordinalPosition: number;
  inferredType: string | null;
}

export interface CreateColumnStatisticsInput {
  columnId: string;
  nullCount: number;
  nullPercentage: number;
  distinctCount: number;
  uniquenessRatio: number;
}

export interface CreateQualityIssueInput {
  versionId: string;
  tableId: string | null;
  columnId: string | null;
  issueType: string;
  dimension: string;
  severity: string;
  title: string;
  description: string;
  affectedRows: number;
  totalRows: number;
  affectedPercentage: number;
  examples: string[];
  evidence: Record<string, unknown>;
  fingerprint: string;
}

export interface CreateInferredRelationshipInput {
  versionId: string;
  parentTableId: string;
  parentColumnId: string;
  childTableId: string;
  childColumnId: string;
  confidence: number;
  confidenceBand: string;
  status: string;
  valueOverlap: number;
  orphanCount: number;
  orphanPercentage: number;
  orphanExamples: string[];
  evidence: Record<string, unknown>;
}

export interface CreateQualityScoreInput {
  versionId: string;
  overallScore: number | null;
  completeness: number | null;
  uniqueness: number | null;
  validity: number | null;
  consistency: number | null;
  referentialIntegrity: number | null;
  applicableDimensions: string[];
  weightsUsed: Record<string, unknown>;
  capApplied: number | null;
  capReason: string | null;
  calculationBreakdown: Record<string, unknown>;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

/**
 * The narrow slice of PrismaClient / Prisma.TransactionClient that the
 * profiling persistence layer uses. Both the real client and the object
 * passed to a `$transaction(async (tx) => ...)` callback satisfy this
 * shape structurally in real Prisma — nothing here is invented API surface.
 */
export interface ProfilingDb {
  project: {
    create(args: { data: CreateProjectInput }): Promise<ProjectRow>;
    findUnique(args: { where: { id: string } }): Promise<ProjectRow | null>;
  };
  datasetVersion: {
    create(args: { data: CreateVersionInput }): Promise<DatasetVersionRow>;
    update(args: { where: { id: string }; data: { status: string } }): Promise<DatasetVersionRow>;
    findFirst(args: {
      where: { projectId: string };
      orderBy: { versionNumber: "desc" };
    }): Promise<DatasetVersionRow | null>;
    /** Slice E: single version by id, for version-details and as the
     * project-ownership check every nested version-scoped read uses. */
    findUnique(args: { where: { id: string } }): Promise<DatasetVersionRow | null>;
    /** Slice E: all versions of a project, newest first. */
    findMany(args: {
      where: { projectId: string };
      orderBy: { versionNumber: "desc" };
    }): Promise<DatasetVersionRow[]>;
  };
  job: {
    create(args: { data: CreateJobInput }): Promise<IdRow>;
    update(args: { where: { id: string }; data: Partial<UpdateJobInput> }): Promise<IdRow>;
  };
  datasetTable: {
    create(args: { data: CreateDatasetTableInput }): Promise<IdRow>;
    findMany(args: { where: { versionId: string } }): Promise<DatasetTableRow[]>;
  };
  datasetColumn: {
    create(args: { data: CreateDatasetColumnInput }): Promise<IdRow>;
    findMany(args: { where: { tableId: { in: string[] } } }): Promise<DatasetColumnRow[]>;
  };
  columnStatistics: {
    create(args: { data: CreateColumnStatisticsInput }): Promise<IdRow>;
    findMany(args: { where: { columnId: { in: string[] } } }): Promise<ColumnStatisticsRow[]>;
  };
  qualityIssue: {
    create(args: { data: CreateQualityIssueInput }): Promise<IdRow>;
    findMany(args: {
      where: { versionId: string };
      skip: number;
      take: number;
      orderBy: { createdAt: "desc" };
    }): Promise<QualityIssueRow[]>;
    count(args: { where: { versionId: string } }): Promise<number>;
  };
  inferredRelationship: {
    create(args: { data: CreateInferredRelationshipInput }): Promise<IdRow>;
    findMany(args: { where: { versionId: string } }): Promise<InferredRelationshipRow[]>;
  };
  qualityScore: {
    create(args: { data: CreateQualityScoreInput }): Promise<IdRow>;
    findUnique(args: { where: { versionId: string } }): Promise<QualityScoreRow | null>;
  };
  $transaction<T>(fn: (tx: ProfilingDb) => Promise<T>): Promise<T>;
}
