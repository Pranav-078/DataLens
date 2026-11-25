import { describe, it, expect } from "vitest";
import {
  computeQualityScore,
  DIMENSION_WEIGHTS,
  SEVERITY_CAP,
} from "../src/modules/quality/qualityScore.js";
import type { AggregatedQualityIssue } from "../src/modules/uploads/issueAggregation.js";
import type { ProfileRelationship } from "../src/modules/uploads/profilerClient.js";

function issue(overrides: Partial<AggregatedQualityIssue> = {}): AggregatedQualityIssue {
  return {
    tableName: "customers",
    columnName: "email",
    issueType: "empty_string",
    dimension: "completeness",
    severity: "medium",
    title: "t",
    description: "d",
    affectedRows: 5,
    totalRows: 100,
    affectedPercentage: 5,
    examples: [],
    evidence: {},
    fingerprint: "fp",
    ...overrides,
  };
}

function relationship(overrides: Partial<ProfileRelationship> = {}): ProfileRelationship {
  return {
    parent_table: "customers",
    parent_column: "id",
    child_table: "orders",
    child_column: "customer_id",
    confidence: 0.95,
    confidence_band: "high",
    status: "inferred",
    value_overlap: 0.98,
    orphan_count: 2,
    orphan_percentage: 2.0,
    orphan_examples: [],
    evidence: {},
    ...overrides,
  };
}

describe("DIMENSION_WEIGHTS", () => {
  it("sums to exactly 1.0", () => {
    const total = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0, 10);
  });
});

describe("computeQualityScore — clean dataset", () => {
  it("a dataset with no issues and no relationships scores 100", () => {
    const result = computeQualityScore([], []);
    expect(result.overallScore).toBe(100);
    expect(result.completeness).toBe(100);
    expect(result.uniqueness).toBe(100);
    expect(result.validity).toBe(100);
    expect(result.consistency).toBe(100);
    expect(result.referentialIntegrity).toBeNull(); // N/A, not 0
    expect(result.capApplied).toBeNull();
  });
});

describe("computeQualityScore — per-dimension degradation", () => {
  it("a completeness issue lowers only the completeness dimension", () => {
    const result = computeQualityScore(
      [issue({ dimension: "completeness", affectedPercentage: 20, totalRows: 100 })],
      []
    );
    expect(result.completeness).toBeLessThan(100);
    expect(result.validity).toBe(100);
    expect(result.uniqueness).toBe(100);
    expect(result.consistency).toBe(100);
  });

  it("a validity issue lowers only the validity dimension", () => {
    const result = computeQualityScore(
      [issue({ dimension: "validity", issueType: "invalid_date", affectedPercentage: 15, totalRows: 100 })],
      []
    );
    expect(result.validity).toBeLessThan(100);
    expect(result.completeness).toBe(100);
    expect(result.uniqueness).toBe(100);
    expect(result.consistency).toBe(100);
  });

  it("a uniqueness issue lowers only the uniqueness dimension", () => {
    const result = computeQualityScore(
      [issue({ dimension: "uniqueness", issueType: "duplicate_full_record", affectedPercentage: 10, totalRows: 100 })],
      []
    );
    expect(result.uniqueness).toBeLessThan(100);
    expect(result.completeness).toBe(100);
    expect(result.validity).toBe(100);
    expect(result.consistency).toBe(100);
  });

  it("a consistency issue lowers only the consistency dimension", () => {
    const result = computeQualityScore(
      [issue({ dimension: "consistency", issueType: "casing_inconsistency", affectedPercentage: 8, totalRows: 100 })],
      []
    );
    expect(result.consistency).toBeLessThan(100);
    expect(result.completeness).toBe(100);
    expect(result.validity).toBe(100);
    expect(result.uniqueness).toBe(100);
  });

  it("scores exactly 100 - weighted affectedPercentage for a single issue", () => {
    const result = computeQualityScore(
      [issue({ dimension: "completeness", affectedPercentage: 12, totalRows: 50 })],
      []
    );
    expect(result.completeness).toBe(88); // 100 - 12, single issue, no averaging needed
  });

  it("weights multiple issues in the same dimension by their own totalRows", () => {
    const result = computeQualityScore(
      [
        issue({ dimension: "validity", affectedPercentage: 10, totalRows: 100 }), // weight 100
        issue({ dimension: "validity", affectedPercentage: 50, totalRows: 10 }),  // weight 10
      ],
      []
    );
    // weighted avg = (10*100 + 50*10) / 110 = (1000+500)/110 = 13.636...
    expect(result.validity).toBeCloseTo(100 - 1500 / 110, 1);
  });
});

describe("computeQualityScore — referential integrity", () => {
  it("orphaned relationships lower referentialIntegrity", () => {
    const result = computeQualityScore([], [relationship({ orphan_percentage: 20 })]);
    expect(result.referentialIntegrity).toBe(80); // 100 * (1 - 0.20)
    expect(result.applicableDimensions).toContain("referentialIntegrity");
  });

  it("averages orphan percentage across multiple relationships", () => {
    const result = computeQualityScore(
      [],
      [relationship({ orphan_percentage: 0 }), relationship({ orphan_percentage: 20 })]
    );
    expect(result.referentialIntegrity).toBe(90); // mean(100, 80) = 90
  });

  it("zero relationships -> referentialIntegrity is null (N/A), never 0", () => {
    const result = computeQualityScore([issue({ affectedPercentage: 50 })], []);
    expect(result.referentialIntegrity).toBeNull();
    expect(result.applicableDimensions).not.toContain("referentialIntegrity");
  });
});

describe("computeQualityScore — weight redistribution", () => {
  it("redistributes referentialIntegrity's weight proportionally when N/A", () => {
    const result = computeQualityScore([], []);
    const w = result.weightsUsed;
    // 0.25/0.8, 0.25/0.8, 0.20/0.8, 0.10/0.8
    expect(w.completeness).toBeCloseTo(0.3125, 6);
    expect(w.validity).toBeCloseTo(0.3125, 6);
    expect(w.uniqueness).toBeCloseTo(0.25, 6);
    expect(w.consistency).toBeCloseTo(0.125, 6);
    expect(w.referentialIntegrity).toBe(0);
  });

  it("adjusted weights still sum to 1.0 after redistribution", () => {
    const result = computeQualityScore([], []);
    const total = Object.values(result.weightsUsed).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0, 10);
  });

  it("uses the original base weights unchanged when relationships ARE present", () => {
    const result = computeQualityScore([], [relationship()]);
    expect(result.weightsUsed.completeness).toBe(DIMENSION_WEIGHTS.completeness);
    expect(result.weightsUsed.referentialIntegrity).toBe(DIMENSION_WEIGHTS.referentialIntegrity);
  });

  it("the redistribution is recorded in calculationBreakdown", () => {
    const result = computeQualityScore([], []);
    const breakdown = result.calculationBreakdown as any;
    expect(breakdown.weightRedistribution.occurred).toBe(true);
    expect(breakdown.weightRedistribution.redistributedFrom).toBe("referentialIntegrity");
    expect(breakdown.weightRedistribution.redistributedWeight).toBe(0.2);
  });

  it("records occurred: false when no redistribution was needed", () => {
    const result = computeQualityScore([], [relationship()]);
    const breakdown = result.calculationBreakdown as any;
    expect(breakdown.weightRedistribution.occurred).toBe(false);
  });
});

describe("computeQualityScore — severity caps", () => {
  it("any high-severity issue caps the overall score at 80, even if raw score is higher", () => {
    const result = computeQualityScore([issue({ severity: "high", affectedPercentage: 1 })], []);
    expect(result.capApplied).toBe(SEVERITY_CAP.high);
    expect(result.overallScore).toBeLessThanOrEqual(80);
    expect(result.capReason).toContain("high-severity");
  });

  it("any critical-severity issue caps the overall score at 60, even if raw score is higher", () => {
    const result = computeQualityScore([issue({ severity: "critical", affectedPercentage: 1 })], []);
    expect(result.capApplied).toBe(SEVERITY_CAP.critical);
    expect(result.overallScore).toBeLessThanOrEqual(60);
    expect(result.capReason).toContain("critical");
  });

  it("critical takes precedence over high when both are present", () => {
    const result = computeQualityScore(
      [issue({ severity: "critical" }), issue({ severity: "high" })],
      []
    );
    expect(result.capApplied).toBe(SEVERITY_CAP.critical);
  });

  it("no cap is applied when only medium/low issues exist", () => {
    const result = computeQualityScore(
      [issue({ severity: "medium", affectedPercentage: 1 }), issue({ severity: "low", affectedPercentage: 1 })],
      []
    );
    expect(result.capApplied).toBeNull();
    expect(result.capReason).toBeNull();
  });

  it("the cap never INCREASES a score that's already below the cap threshold", () => {
    const result = computeQualityScore(
      [issue({ severity: "high", dimension: "completeness", affectedPercentage: 90, totalRows: 100 })],
      []
    );
    expect(result.overallScore).toBeLessThan(80); // raw score already below 80, cap doesn't push it up
  });
});

describe("computeQualityScore — determinism", () => {
  it("identical input produces an identical result on repeated calls", () => {
    const issues = [issue({ dimension: "completeness" }), issue({ dimension: "validity", issueType: "invalid_date" })];
    const relationships = [relationship()];

    const first = computeQualityScore(issues, relationships);
    const second = computeQualityScore(issues, relationships);

    expect(second).toEqual(first);
  });

  it("is a pure function: does not mutate its inputs", () => {
    const issues = [issue()];
    const relationships = [relationship()];
    const issuesCopy = JSON.parse(JSON.stringify(issues));
    const relationshipsCopy = JSON.parse(JSON.stringify(relationships));

    computeQualityScore(issues, relationships);

    expect(issues).toEqual(issuesCopy);
    expect(relationships).toEqual(relationshipsCopy);
  });
});

describe("computeQualityScore — calculationBreakdown correctness", () => {
  it("includes a per-dimension entry with score, both weights, and weighted contribution", () => {
    const result = computeQualityScore([issue({ dimension: "completeness", affectedPercentage: 10 })], [relationship()]);
    const breakdown = result.calculationBreakdown as any;

    const completenessEntry = breakdown.dimensions.completeness;
    expect(completenessEntry.score).toBe(result.completeness);
    expect(completenessEntry.baseWeight).toBe(DIMENSION_WEIGHTS.completeness);
    expect(completenessEntry.adjustedWeight).toBe(result.weightsUsed.completeness);
    expect(completenessEntry.weightedContribution).toBeCloseTo(
      result.weightsUsed.completeness * (result.completeness as number),
      6
    );
    expect(Array.isArray(completenessEntry.contributingIssues)).toBe(true);
  });

  it("includes referentialIntegrity's contributing relationships when applicable", () => {
    const result = computeQualityScore([], [relationship({ orphan_percentage: 10 })]);
    const breakdown = result.calculationBreakdown as any;
    expect(breakdown.dimensions.referentialIntegrity.applicable).toBe(true);
    expect(breakdown.dimensions.referentialIntegrity.contributingRelationships).toHaveLength(1);
  });

  it("records rawScoreBeforeCap distinctly from the final (post-cap) score", () => {
    const result = computeQualityScore([issue({ severity: "critical", affectedPercentage: 1 })], []);
    const breakdown = result.calculationBreakdown as any;
    expect(breakdown.rawScoreBeforeCap).toBeGreaterThan(result.overallScore);
    expect(breakdown.finalScore).toBe(result.overallScore);
  });

  it("documents the known affectedPercentage-aggregation limitation", () => {
    const result = computeQualityScore([], []);
    const breakdown = result.calculationBreakdown as any;
    expect(typeof breakdown.knownLimitation).toBe("string");
    expect(breakdown.knownLimitation.length).toBeGreaterThan(20);
  });

  it("severityCounts in the breakdown match the top-level counts", () => {
    const result = computeQualityScore(
      [issue({ severity: "high" }), issue({ severity: "medium" }), issue({ severity: "medium" })],
      []
    );
    const breakdown = result.calculationBreakdown as any;
    expect(breakdown.severityCounts).toEqual({
      critical: result.criticalCount,
      high: result.highCount,
      medium: result.mediumCount,
      low: result.lowCount,
    });
    expect(result.highCount).toBe(1);
    expect(result.mediumCount).toBe(2);
  });
});
