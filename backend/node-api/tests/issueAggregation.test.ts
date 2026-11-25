import { describe, it, expect } from "vitest";
import {
  groupFindingsIntoQualityIssues,
  computeFingerprint,
} from "../src/modules/uploads/issueAggregation.js";
import type { ProfileFinding } from "../src/modules/uploads/profilerClient.js";

function finding(overrides: Partial<ProfileFinding> = {}): ProfileFinding {
  return {
    issue_type: "empty_string",
    dimension: "completeness",
    table: "customers",
    row_uid: "customers:1",
    column: "phone",
    severity: "medium",
    evidence: {},
    ...overrides,
  };
}

describe("computeFingerprint", () => {
  it("is deterministic for the same inputs", () => {
    expect(computeFingerprint("empty_string", "customers", "phone")).toBe(
      computeFingerprint("empty_string", "customers", "phone")
    );
  });

  it("excludes row-level information by construction — same issue/table/column always fingerprints the same regardless of which rows are affected", () => {
    // This is the property the schema comment requires for version diffing
    // to work as a set operation: the fingerprint must not depend on counts.
    const fp1 = computeFingerprint("empty_string", "customers", "phone");
    const fp2 = computeFingerprint("empty_string", "customers", "phone");
    expect(fp1).toBe(fp2);
  });

  it("differs when table, column, or issue_type differs", () => {
    const base = computeFingerprint("empty_string", "customers", "phone");
    expect(computeFingerprint("empty_string", "orders", "phone")).not.toBe(base);
    expect(computeFingerprint("empty_string", "customers", "email")).not.toBe(base);
    expect(computeFingerprint("invalid_date", "customers", "phone")).not.toBe(base);
  });
});

describe("groupFindingsIntoQualityIssues", () => {
  it("groups multiple row-level findings of the same issue/table/column into one aggregated issue", () => {
    const findings = [
      finding({ row_uid: "customers:1" }),
      finding({ row_uid: "customers:5" }),
      finding({ row_uid: "customers:9" }),
    ];
    const [issue] = groupFindingsIntoQualityIssues(findings, { customers: 10 });
    expect(issue!.affectedRows).toBe(3);
    expect(issue!.totalRows).toBe(10);
    expect(issue!.affectedPercentage).toBe(30);
    expect(issue!.examples).toEqual(["customers:1", "customers:5", "customers:9"]);
  });

  it("keeps different issue types, tables, or columns in separate groups", () => {
    const findings = [
      finding({ issue_type: "empty_string", column: "phone" }),
      finding({ issue_type: "invalid_date", column: "phone" }),
      finding({ issue_type: "empty_string", column: "email" }),
      finding({ issue_type: "empty_string", column: "phone", table: "orders" }),
    ];
    const issues = groupFindingsIntoQualityIssues(findings, { customers: 10, orders: 5 });
    expect(issues).toHaveLength(4);
  });

  it("deduplicates a repeated row_uid within the same group rather than double-counting it", () => {
    const findings = [
      finding({ row_uid: "customers:1" }),
      finding({ row_uid: "customers:1" }), // same row, same issue — must not count twice
    ];
    const [issue] = groupFindingsIntoQualityIssues(findings, { customers: 10 });
    expect(issue!.affectedRows).toBe(1);
  });

  it("caps examples at 10 even when many more rows are affected", () => {
    const findings = Array.from({ length: 25 }, (_, i) => finding({ row_uid: `customers:${i + 1}` }));
    const [issue] = groupFindingsIntoQualityIssues(findings, { customers: 30 });
    expect(issue!.affectedRows).toBe(25);
    expect(issue!.examples).toHaveLength(10);
  });

  it("treats a group of only table-level marker findings as affecting the whole table", () => {
    const findings = [finding({ row_uid: "customers:*", column: null, issue_type: "mixed_type" })];
    const [issue] = groupFindingsIntoQualityIssues(findings, { customers: 40 });
    expect(issue!.affectedRows).toBe(40);
    expect(issue!.examples).toEqual([]);
  });

  it("escalates to the highest severity present in a group", () => {
    const findings = [
      finding({ row_uid: "customers:1", severity: "medium" }),
      finding({ row_uid: "customers:2", severity: "high" }),
      finding({ row_uid: "customers:3", severity: "low" }),
    ];
    const [issue] = groupFindingsIntoQualityIssues(findings, { customers: 10 });
    expect(issue!.severity).toBe("high");
  });

  it("computes affectedPercentage as 0, not NaN, when totalRows is unknown (0)", () => {
    const [issue] = groupFindingsIntoQualityIssues([finding()], {});
    expect(issue!.affectedPercentage).toBe(0);
    expect(Number.isNaN(issue!.affectedPercentage)).toBe(false);
  });

  it("returns an empty array for an empty findings input", () => {
    expect(groupFindingsIntoQualityIssues([], {})).toEqual([]);
  });

  it("every aggregated issue's fingerprint matches computeFingerprint for its own fields", () => {
    const findings = [finding({ issue_type: "invalid_date", table: "orders", column: "ship_date" })];
    const [issue] = groupFindingsIntoQualityIssues(findings, { orders: 5 });
    expect(issue!.fingerprint).toBe(computeFingerprint("invalid_date", "orders", "ship_date"));
  });
});
