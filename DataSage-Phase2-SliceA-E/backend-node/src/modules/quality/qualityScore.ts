import type { AggregatedQualityIssue } from "../uploads/issueAggregation.js";
import type { ProfileRelationship } from "../uploads/profilerClient.js";

/**
 * Deterministic DataSage quality score.
 *
 * Pure function: no database access, no HTTP calls, no I/O of any kind.
 * Everything it needs is already in memory by the time it's called —
 * the same AggregatedQualityIssue[] that issueAggregation.ts already
 * produced for persistence (Step 3), and the same ProfileRelationship[]
 * that profilerClient.ts already typed for persistence (Slice C). This
 * module does not re-derive, re-fetch, or duplicate either of those —
 * it only reads them.
 *
 * ──────────────────────────────────────────────────────────────────
 * KNOWN LIMITATION (documented, not hidden)
 * ──────────────────────────────────────────────────────────────────
 * Each non-referential dimension's score is computed from a WEIGHTED
 * AVERAGE of affectedPercentage across that dimension's already-aggregated
 * QualityIssue-shaped records (weighted by each issue's own totalRows).
 * This is NOT the same as an exact, deduplicated row-level applicability
 * count — if two different issue types in the same dimension both flag
 * overlapping rows in the same table, those rows are effectively counted
 * twice toward that dimension's degradation, because each issue's
 * affectedPercentage is computed independently and the average doesn't
 * know the two issues share rows. This was a known, accepted simplification
 * from the original Phase 0 architecture review (full row-level dedup
 * would require tracking which exact rows each issue touches across issue
 * types, which the current QualityIssue schema does not retain — it keeps
 * capped example row_uids, not the full set). It's unlikely to swing a
 * score by more than a few points in practice, but it is a real,
 * documented approximation, not an oversight.
 */

// ── Phase 2 design weights — see docs/phase2.md for the full writeup.
// These five MUST sum to 1.0; see the test asserting exactly that.
export const DIMENSION_WEIGHTS = {
  completeness: 0.25,
  validity: 0.25,
  referentialIntegrity: 0.2,
  uniqueness: 0.2,
  consistency: 0.1,
} as const;

export type ScorableDimension = keyof typeof DIMENSION_WEIGHTS;

// A dimension name as it appears on AggregatedQualityIssue.dimension
// (snake_case, matching the Finding contract) vs. the Prisma/JS field name
// (camelCase). Both the Phase 0 architecture review and schema.prisma use
// "referential_integrity" on issues/evidence but "referentialIntegrity" as
// the column name — this map is the single place that reconciles them.
const ISSUE_DIMENSION_KEY: Record<ScorableDimension, string> = {
  completeness: "completeness",
  validity: "validity",
  uniqueness: "uniqueness",
  consistency: "consistency",
  referentialIntegrity: "referential_integrity",
};

// Severity caps — a single critical issue anywhere caps the overall score
// at 60; absent that, a single high issue caps it at 80. Independent of
// which dimension the issue belongs to: a critical problem anywhere means
// the dataset as a whole cannot be called "mostly fine".
export const SEVERITY_CAP = { critical: 60, high: 80 } as const;

export interface QualityScoreResult {
  overallScore: number;
  completeness: number;
  uniqueness: number;
  validity: number;
  consistency: number;
  referentialIntegrity: number | null; // null means N/A, never 0
  applicableDimensions: string[];
  weightsUsed: Record<ScorableDimension, number>;
  capApplied: number | null;
  capReason: string | null;
  calculationBreakdown: Record<string, unknown>;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface DimensionComputation {
  score: number; // always a real number for the 4 non-referential dims (100 when no issues)
  issueCount: number;
  contributingIssues: Array<{
    issueType: string;
    table: string;
    column: string | null;
    severity: string;
    affectedPercentage: number;
    totalRows: number;
  }>;
}

/**
 * Score for one of the four non-referential dimensions: 100 when nothing
 * was found wrong (a clean dimension is a real 100, not N/A — every table
 * always has columns that COULD have completeness/uniqueness/validity/
 * consistency problems, so "nothing found" is a genuine, applicable
 * result, unlike referential integrity which is only computable when at
 * least one relationship was actually inferred).
 */
function computeIssueDimension(
  issues: AggregatedQualityIssue[],
  dimensionKey: string
): DimensionComputation {
  const relevant = issues.filter((i) => i.dimension === dimensionKey);

  if (relevant.length === 0) {
    return { score: 100, issueCount: 0, contributingIssues: [] };
  }

  let weightedSum = 0;
  let totalWeight = 0;
  for (const issue of relevant) {
    const weight = Math.max(issue.totalRows, 1); // defensive: never divide by a zero-weight issue
    weightedSum += issue.affectedPercentage * weight;
    totalWeight += weight;
  }
  const weightedAffectedPercentage = totalWeight > 0 ? weightedSum / totalWeight : 0;

  return {
    score: round2(Math.max(0, 100 - weightedAffectedPercentage)),
    issueCount: relevant.length,
    contributingIssues: relevant.map((i) => ({
      issueType: i.issueType,
      table: i.tableName,
      column: i.columnName,
      severity: i.severity,
      affectedPercentage: i.affectedPercentage,
      totalRows: i.totalRows,
    })),
  };
}

interface ReferentialComputation {
  score: number | null; // null = N/A
  applicable: boolean;
  relationshipCount: number;
  contributingRelationships: Array<{
    parentTable: string;
    parentColumn: string;
    childTable: string;
    childColumn: string;
    orphanPercentage: number;
  }>;
  reason: string | null; // only set when N/A
}

/** referentialIntegrity = mean(1 - orphanPercentage/100) over every
 * inferred relationship for this version. N/A (not zero) when there are
 * no relationships at all — a dataset with no detectable relationships
 * hasn't been shown to have a referential problem, it simply has nothing
 * to check, which is a different thing from "this dimension scored 0". */
function computeReferentialIntegrity(relationships: ProfileRelationship[]): ReferentialComputation {
  if (relationships.length === 0) {
    return {
      score: null,
      applicable: false,
      relationshipCount: 0,
      contributingRelationships: [],
      reason: "no relationships were inferred for this version",
    };
  }

  const sum = relationships.reduce((acc, r) => acc + (1 - r.orphan_percentage / 100), 0);
  const score = round2(Math.max(0, (sum / relationships.length) * 100));

  return {
    score,
    applicable: true,
    relationshipCount: relationships.length,
    contributingRelationships: relationships.map((r) => ({
      parentTable: r.parent_table,
      parentColumn: r.parent_column,
      childTable: r.child_table,
      childColumn: r.child_column,
      orphanPercentage: r.orphan_percentage,
    })),
    reason: null,
  };
}

/**
 * Proportionally redistributes an inapplicable dimension's base weight
 * across the applicable dimensions, in proportion to their own base
 * weights. With referentialIntegrity (0.20) redistributed, the remaining
 * four (0.25 + 0.25 + 0.20 + 0.10 = 0.80) each get divided by 0.80:
 * completeness/validity -> 0.3125, uniqueness -> 0.25, consistency -> 0.125.
 * These sum back to exactly 1.0 — see the test asserting that.
 */
function redistributeWeights(applicableDimensions: ScorableDimension[]): Record<ScorableDimension, number> {
  const applicableBaseSum = applicableDimensions.reduce((sum, d) => sum + DIMENSION_WEIGHTS[d], 0);
  const adjusted: Partial<Record<ScorableDimension, number>> = {};
  for (const dim of Object.keys(DIMENSION_WEIGHTS) as ScorableDimension[]) {
    adjusted[dim] = applicableDimensions.includes(dim)
      ? DIMENSION_WEIGHTS[dim] / applicableBaseSum
      : 0;
  }
  return adjusted as Record<ScorableDimension, number>;
}

export function computeQualityScore(
  issues: AggregatedQualityIssue[],
  relationships: ProfileRelationship[]
): QualityScoreResult {
  const completeness = computeIssueDimension(issues, ISSUE_DIMENSION_KEY.completeness);
  const validity = computeIssueDimension(issues, ISSUE_DIMENSION_KEY.validity);
  const uniqueness = computeIssueDimension(issues, ISSUE_DIMENSION_KEY.uniqueness);
  const consistency = computeIssueDimension(issues, ISSUE_DIMENSION_KEY.consistency);
  const referential = computeReferentialIntegrity(relationships);

  const applicableDimensions: ScorableDimension[] = [
    "completeness",
    "validity",
    "uniqueness",
    "consistency",
    ...(referential.applicable ? (["referentialIntegrity"] as const) : []),
  ];

  const weightsUsed = redistributeWeights(applicableDimensions);
  const weightRedistributed = !referential.applicable;

  const dimensionScores: Record<ScorableDimension, number | null> = {
    completeness: completeness.score,
    validity: validity.score,
    uniqueness: uniqueness.score,
    consistency: consistency.score,
    referentialIntegrity: referential.score,
  };

  let rawScoreBeforeCap = 0;
  for (const dim of applicableDimensions) {
    rawScoreBeforeCap += weightsUsed[dim] * (dimensionScores[dim] as number);
  }
  rawScoreBeforeCap = round2(rawScoreBeforeCap);

  const criticalCount = issues.filter((i) => i.severity === "critical").length;
  const highCount = issues.filter((i) => i.severity === "high").length;
  const mediumCount = issues.filter((i) => i.severity === "medium").length;
  const lowCount = issues.filter((i) => i.severity === "low").length;

  let capApplied: number | null = null;
  let capReason: string | null = null;
  if (criticalCount > 0) {
    capApplied = SEVERITY_CAP.critical;
    capReason = `${criticalCount} critical issue(s) present — overall score capped at ${SEVERITY_CAP.critical}`;
  } else if (highCount > 0) {
    capApplied = SEVERITY_CAP.high;
    capReason = `${highCount} high-severity issue(s) present — overall score capped at ${SEVERITY_CAP.high}`;
  }

  const overallScore = capApplied !== null ? Math.min(rawScoreBeforeCap, capApplied) : rawScoreBeforeCap;

  const calculationBreakdown = {
    dimensions: {
      completeness: {
        score: completeness.score,
        baseWeight: DIMENSION_WEIGHTS.completeness,
        adjustedWeight: weightsUsed.completeness,
        weightedContribution: round2(weightsUsed.completeness * completeness.score),
        applicable: true,
        issueCount: completeness.issueCount,
        contributingIssues: completeness.contributingIssues,
      },
      validity: {
        score: validity.score,
        baseWeight: DIMENSION_WEIGHTS.validity,
        adjustedWeight: weightsUsed.validity,
        weightedContribution: round2(weightsUsed.validity * validity.score),
        applicable: true,
        issueCount: validity.issueCount,
        contributingIssues: validity.contributingIssues,
      },
      uniqueness: {
        score: uniqueness.score,
        baseWeight: DIMENSION_WEIGHTS.uniqueness,
        adjustedWeight: weightsUsed.uniqueness,
        weightedContribution: round2(weightsUsed.uniqueness * uniqueness.score),
        applicable: true,
        issueCount: uniqueness.issueCount,
        contributingIssues: uniqueness.contributingIssues,
      },
      consistency: {
        score: consistency.score,
        baseWeight: DIMENSION_WEIGHTS.consistency,
        adjustedWeight: weightsUsed.consistency,
        weightedContribution: round2(weightsUsed.consistency * consistency.score),
        applicable: true,
        issueCount: consistency.issueCount,
        contributingIssues: consistency.contributingIssues,
      },
      referentialIntegrity: referential.applicable
        ? {
            score: referential.score,
            baseWeight: DIMENSION_WEIGHTS.referentialIntegrity,
            adjustedWeight: weightsUsed.referentialIntegrity,
            weightedContribution: round2(weightsUsed.referentialIntegrity * (referential.score as number)),
            applicable: true,
            relationshipCount: referential.relationshipCount,
            contributingRelationships: referential.contributingRelationships,
          }
        : {
            score: null,
            baseWeight: DIMENSION_WEIGHTS.referentialIntegrity,
            adjustedWeight: 0,
            weightedContribution: 0,
            applicable: false,
            reason: referential.reason,
            relationshipCount: 0,
          },
    },
    weightRedistribution: weightRedistributed
      ? {
          occurred: true,
          redistributedFrom: "referentialIntegrity",
          redistributedWeight: DIMENSION_WEIGHTS.referentialIntegrity,
          reason: referential.reason,
        }
      : { occurred: false },
    rawScoreBeforeCap,
    severityCounts: { critical: criticalCount, high: highCount, medium: mediumCount, low: lowCount },
    capApplied,
    capReason,
    finalScore: overallScore,
    knownLimitation:
      "Dimension scores (completeness/validity/uniqueness/consistency) are a " +
      "totalRows-weighted average of each contributing issue's affectedPercentage, " +
      "not an exact deduplicated row-level applicability count. Two issues in the " +
      "same dimension flagging overlapping rows are not de-duplicated against each " +
      "other. See qualityScore.ts's module docstring for the full explanation.",
  };

  return {
    overallScore,
    completeness: completeness.score,
    uniqueness: uniqueness.score,
    validity: validity.score,
    consistency: consistency.score,
    referentialIntegrity: referential.score,
    applicableDimensions,
    weightsUsed,
    capApplied,
    capReason,
    calculationBreakdown,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
  };
}
