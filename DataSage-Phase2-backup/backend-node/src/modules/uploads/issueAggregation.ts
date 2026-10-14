import { createHash } from "node:crypto";
import type { ProfileFinding } from "./profilerClient.js";

/**
 * The Python adapter (backend-python/app/adapters/phase1_adapter.py)
 * produces one Finding PER AFFECTED ROW — a Phase 1 issue spanning 32 rows
 * becomes 32 Findings. That's correct for the Finding contract (row-scoped
 * by design), but `quality_issues` in Postgres is one row PER DISTINCT
 * ISSUE (issueType + table + column), with affectedRows/totalRows/
 * affectedPercentage as aggregate fields — see schema.prisma's comment on
 * QualityIssue.fingerprint: "type+table+column, NOT counts", which only
 * makes sense if there's exactly one row per group.
 *
 * This module is that aggregation step. It belongs on the Node/persistence
 * side, not in the Python adapter — the adapter's job is producing
 * contract-correct Findings; grouping them into schema-shaped rows is a
 * distinct, separate transformation.
 */

export interface AggregatedQualityIssue {
  tableName: string;
  columnName: string | null;
  issueType: string;
  dimension: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  description: string;
  affectedRows: number;
  totalRows: number;
  affectedPercentage: number;
  examples: string[]; // row_uids, capped
  evidence: Record<string, unknown>;
  fingerprint: string;
}

const MAX_EXAMPLES = 10;
const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** A table-level/column-level finding with no specific row uses this
 * marker as its row_uid (see phase1_adapter.py's _table_level_row_uid) —
 * distinguished here from a real, countable row. */
function isTableLevelMarker(rowUid: string): boolean {
  return rowUid.endsWith(":*");
}

/** `column ?? ""` deliberately collapses a null column (table-level issue,
 * e.g. duplicate_full_record) and an empty-string column name into the
 * same fingerprint space. This is safe in practice: upload validation
 * (upload.validator.ts) never produces an empty-string column name, so
 * the two cases never actually collide. */
export function computeFingerprint(issueType: string, table: string, column: string | null): string {
  return createHash("sha256").update(`${issueType}|${table}|${column ?? ""}`).digest("hex");
}

function highestSeverity(findings: ProfileFinding[]): AggregatedQualityIssue["severity"] {
  let best = findings[0]!.severity;
  for (const f of findings) {
    if ((SEVERITY_RANK[f.severity] ?? 0) > (SEVERITY_RANK[best] ?? 0)) best = f.severity;
  }
  return best as AggregatedQualityIssue["severity"];
}

function humanizeIssueType(issueType: string): string {
  return issueType.replace(/_/g, " ");
}

/**
 * Groups findings by (issueType, table, column) and rolls each group into
 * one aggregated issue record ready to persist as one `quality_issues` row.
 *
 * `tableRowCounts` should be each table's actual row count from the
 * upload's own validated CSV parsing (upload.validator.ts already computes
 * this independently), not re-derived here.
 */
export function groupFindingsIntoQualityIssues(
  findings: ProfileFinding[],
  tableRowCounts: Record<string, number>
): AggregatedQualityIssue[] {
  const groups = new Map<string, ProfileFinding[]>();

  for (const finding of findings) {
    const key = `${finding.issue_type}\u0000${finding.table}\u0000${finding.column ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }

  const results: AggregatedQualityIssue[] = [];

  for (const groupFindings of groups.values()) {
    const first = groupFindings[0]!;
    const totalRows = tableRowCounts[first.table] ?? 0;

    const realRowUids = new Set(
      groupFindings.map((f) => f.row_uid).filter((uid) => !isTableLevelMarker(uid))
    );
    const allMarkerLevel = realRowUids.size === 0 && groupFindings.length > 0;

    // A group with only table/column-level marker findings (no specific
    // row identified) is treated as affecting the whole table, since
    // there's no narrower row-level count to report — documented here
    // rather than silently defaulting to 0, which would understate it.
    const affectedRows = allMarkerLevel ? totalRows : realRowUids.size;
    const affectedPercentage = totalRows > 0 ? Math.round((affectedRows / totalRows) * 100 * 1000) / 1000 : 0;

    const examples = allMarkerLevel
      ? []
      : Array.from(realRowUids).slice(0, MAX_EXAMPLES);

    results.push({
      tableName: first.table,
      columnName: first.column,
      issueType: first.issue_type,
      dimension: first.dimension,
      severity: highestSeverity(groupFindings),
      title: `${humanizeIssueType(first.issue_type)} in ${first.table}${first.column ? `.${first.column}` : ""}`,
      description: `${affectedRows} of ${totalRows} row(s) affected by ${humanizeIssueType(first.issue_type)}.`,
      affectedRows,
      totalRows,
      affectedPercentage,
      examples,
      evidence: {
        sampleFindingEvidence: first.evidence,
        findingCountInGroup: groupFindings.length,
      },
      fingerprint: computeFingerprint(first.issue_type, first.table, first.column),
    });
  }

  return results;
}
