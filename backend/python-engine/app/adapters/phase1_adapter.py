"""
Adapter: Phase 1 (datasage_profiler) Issue -> Phase 0 (contracts) Finding.

This is the ONLY place that knows about both shapes. Nothing else in this
service should import datasage_profiler.models.Issue directly and nothing
else should construct a contracts.Finding from a Phase 1 result — that
would spread this mapping across the codebase instead of keeping it in
one reviewable place.

Explicitly NOT touched here: Phase 1's detection logic. This module only
looks at what Phase 1 already produced.
"""

from __future__ import annotations

from typing import Any
import hashlib
import math

import pandas as pd

from app import _vendor_path  # noqa: F401  (must run before importing datasage_profiler)
from datasage_profiler.models import Issue, ProfileResult

from app.contracts import Finding, validate_finding


class AdapterMappingError(ValueError):
    """Raised when a Phase 1 Issue can't be mapped — e.g. an issue_type this
    adapter doesn't know about yet. Raised loudly rather than guessed at,
    for the same reason evaluation/detector_contract.py's ContractViolation
    is raised rather than silently skipped: a silent guess here would make
    a real detector look wrong, or a real problem invisible."""


# Every issue_type the vendored Phase 1 detectors can currently produce,
# confirmed by grepping datasage_profiler/detectors.py directly (not
# assumed) at integration time. If Phase 1 ever adds a detector producing
# a new issue_type, this map must be updated — see the ValueError below.
_DIMENSION_BY_ISSUE_TYPE: dict[str, str] = {
    "duplicate_full_record": "uniqueness",
    "duplicate_candidate_key": "uniqueness",
    "invalid_numeric": "validity",
    "invalid_date": "validity",
    "mixed_type": "validity",
    "encoding_edge_case": "validity",
    "numeric_outlier": "validity",
    "inconsistent_date_format": "consistency",
    "leading_trailing_whitespace": "consistency",
    "casing_inconsistency": "consistency",
    "inconsistent_categorical_value": "consistency",
    "empty_string": "completeness",
    "required_field_missing": "completeness",
}

# Phase 1 uses a 2-level severity scheme (warning/error); Phase 0's contract
# requires the 4-level scheme (critical/high/medium/low) used by the
# quality-score design in docs/architecture.md. This mapping is a real
# decision, not a rename: "error" and "warning" are not self-evidently
# "high" and "medium" — this is the one used for Step 1 and should be
# revisited once real scoring (a later phase) has an opinion on it.
_SEVERITY_MAP: dict[str, str] = {
    "error": "high",
    "warning": "medium",
}


def _row_indices_from_reference(row_reference: dict[str, Any] | None) -> list[int]:
    """Phase 1's row_reference is one of: None, {"row_index": int}, or
    {"row_indices": [int, ...]}. Normalizes all three into a list."""
    if not row_reference:
        return []
    if "row_indices" in row_reference:
        return list(row_reference["row_indices"])
    if "row_index" in row_reference:
        return [row_reference["row_index"]]
    return []


def derive_row_uid(table_name: str, frame: pd.DataFrame, position: int) -> str:
    """
    Deterministic row_uid for one row of one table.

    If the incoming data already has a dedicated stable identifier — a
    `row_uid` column, as produced by data/generators/make_clean_data.py for
    Phase 0's own evaluation fixtures — that value is used unchanged, so
    this adapter stays compatible with the existing evaluation harness.

    Otherwise (the general case: a real uploaded CSV has no such column),
    row_uid is synthesized deterministically from the table name and the
    1-based CSV data-row number: "customers:1" is always the first data
    row of the customers table, regardless of how many times this runs.
    """
    # Detector row references are DataFrame index labels, not necessarily
    # iloc offsets. Fast Preview samples preserve the original source index.
    if position not in frame.index:
        raise AdapterMappingError(
            f"Row index {position} is not present in table {table_name!r}."
        )
    if "row_uid" in frame.columns:
        return str(frame.at[position, "row_uid"])
    return f"{table_name}:{int(position) + 1}"


def _table_level_row_uid(table_name: str) -> str:
    """Used only for the rare Phase 1 issue with no row_reference at all
    (a column- or table-level finding). The contract requires a non-empty
    row_uid on every Finding, so this is an explicit, greppable marker
    rather than an empty string or a fabricated row number."""
    return f"{table_name}:*"


def adapt_issue(issue: Issue, frame: pd.DataFrame) -> list[Finding]:
    """
    Converts one Phase 1 Issue into one or more Phase 0 Findings.

    Fan-out, not truncation: a Phase 1 Issue can reference multiple rows
    (row_reference={"row_indices": [...]})  — e.g. one duplicate-record
    Issue naming both rows of a pair. Phase 0's Finding contract is
    row-scoped (exactly one row_uid per Finding), so such an Issue becomes
    multiple Findings, one per affected row, all sharing the same
    issue_type/dimension/evidence. This means len(findings) can exceed
    len(issues) for the same input — expected, and reported explicitly
    rather than silently, in Step 1's verification run below.
    """
    if issue.issue_type not in _DIMENSION_BY_ISSUE_TYPE:
        raise AdapterMappingError(
            f"No dimension mapping for Phase 1 issue_type {issue.issue_type!r} "
            f"(detector: {issue.detector!r}). Add it to _DIMENSION_BY_ISSUE_TYPE "
            f"in app/adapters/phase1_adapter.py before this can be converted."
        )
    if issue.severity not in _SEVERITY_MAP:
        raise AdapterMappingError(
            f"No severity mapping for Phase 1 severity {issue.severity!r} "
            f"(issue_type: {issue.issue_type!r}). Add it to _SEVERITY_MAP."
        )

    dimension = _DIMENSION_BY_ISSUE_TYPE[issue.issue_type]
    severity = _SEVERITY_MAP[issue.severity]

    # Preserves the original Phase 1 finding information, per Step 1's
    # requirement 5 — nothing Phase 1 computed is discarded, it's just not
    # part of the Phase 0 contract's required fields.
    row_indices = _row_indices_from_reference(issue.row_reference)
    row_reference_summary = {
        "kind": (
            "row_indices"
            if issue.row_reference and "row_indices" in issue.row_reference
            else "row_index"
            if issue.row_reference and "row_index" in issue.row_reference
            else "none"
        ),
        "referenced_row_count": len(row_indices),
    }
    base_evidence: dict[str, Any] = {
        "phase1_issue_id": issue.issue_id,
        "phase1_detector": issue.detector,
        "phase1_severity": issue.severity,
        "phase1_confidence": issue.confidence,
        "phase1_observed_value": issue.observed_value,
        "phase1_description": issue.description,
        "phase1_details": issue.details,
        "phase1_row_reference": row_reference_summary,
    }

    if not row_indices:
        candidate = {
            "issue_type": issue.issue_type,
            "dimension": dimension,
            "table": issue.table,
            "row_uid": _table_level_row_uid(issue.table),
            "column": issue.column,
            "severity": severity,
            "evidence": base_evidence,
        }
        return [validate_finding(candidate)]

    findings: list[Finding] = []
    for position in row_indices:
        candidate = {
            "issue_type": issue.issue_type,
            "dimension": dimension,
            "table": issue.table,
            "row_uid": derive_row_uid(issue.table, frame, position),
            "column": issue.column,
            "severity": severity,
            "evidence": {
                **base_evidence,
                "phase1_row_index": position,
            },
        }
        findings.append(validate_finding(candidate))
    return findings


def adapt_profile_result(
    result: ProfileResult, tables: dict[str, pd.DataFrame]
) -> list[Finding]:
    """Converts every Issue in a Phase 1 ProfileResult into Phase 0
    Findings. `tables` must be the same {table_name: DataFrame} mapping
    that was passed to DataProfiler.profile() to produce `result` — row
    positions are only meaningful relative to that exact data."""
    findings: list[Finding] = []
    for issue in result.issues:
        frame = tables[issue.table]
        findings.extend(adapt_issue(issue, frame))
    return findings



def aggregate_profile_result(
    result: ProfileResult,
    tables: dict[str, pd.DataFrame],
    max_examples: int = 10,
    source_row_counts: dict[str, int] | None = None,
    estimated: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    """
    Aggregate Phase 1 issues directly into persistence-ready quality issues.

    This deliberately avoids constructing one Python Finding object per
    affected row and avoids sending hundreds of thousands of row-level
    objects to Node. Counts are exact for the full input data; only the
    human-readable example row IDs are capped.

    Returns:
        (aggregated_issues, finding_count)

    finding_count matches the legacy adapter's fan-out count: one Finding
    for each referenced row, or one table-level Finding when no row is
    explicitly referenced.
    """
    severity_rank = {"low": 0, "medium": 1, "high": 2, "critical": 3}
    groups: dict[tuple[str, str, str | None], dict[str, Any]] = {}
    finding_count = 0

    for issue in result.issues:
        if issue.issue_type not in _DIMENSION_BY_ISSUE_TYPE:
            raise AdapterMappingError(
                f"No dimension mapping for Phase 1 issue_type {issue.issue_type!r} "
                f"(detector: {issue.detector!r}). Add it to _DIMENSION_BY_ISSUE_TYPE."
            )
        if issue.severity not in _SEVERITY_MAP:
            raise AdapterMappingError(
                f"No severity mapping for Phase 1 severity {issue.severity!r} "
                f"(issue_type: {issue.issue_type!r}). Add it to _SEVERITY_MAP."
            )
        if issue.table not in tables:
            raise AdapterMappingError(
                f"Phase 1 issue references unknown table {issue.table!r}."
            )

        frame = tables[issue.table]
        row_indices = _row_indices_from_reference(issue.row_reference)
        # The legacy fan-out created one marker Finding for table-level
        # issues with no explicit row references.
        finding_count += len(row_indices) if row_indices else 1

        key = (issue.issue_type, issue.table, issue.column)
        group = groups.get(key)
        mapped_severity = _SEVERITY_MAP[issue.severity]

        # This is the exact evidence shape the old Node aggregation received
        # from the first row-level Finding, except the full index array is
        # represented by a compact summary.
        first_position = row_indices[0] if row_indices else None
        row_reference_summary = {
            "kind": (
                "row_indices"
                if issue.row_reference and "row_indices" in issue.row_reference
                else "row_index"
                if issue.row_reference and "row_index" in issue.row_reference
                else "none"
            ),
            "referenced_row_count": len(row_indices),
        }
        sample_evidence: dict[str, Any] = {
            "phase1_issue_id": issue.issue_id,
            "phase1_detector": issue.detector,
            "phase1_severity": issue.severity,
            "phase1_confidence": issue.confidence,
            "phase1_observed_value": issue.observed_value,
            "phase1_description": issue.description,
            "phase1_details": issue.details,
            "phase1_row_reference": row_reference_summary,
        }
        if first_position is not None:
            sample_evidence["phase1_row_index"] = first_position

        if group is None:
            group = {
                "tableName": issue.table,
                "columnName": issue.column,
                "issueType": issue.issue_type,
                "dimension": _DIMENSION_BY_ISSUE_TYPE[issue.issue_type],
                "severity": mapped_severity,
                "totalRows": (source_row_counts or {}).get(issue.table, len(frame)),
                "profiledRows": len(frame),
                "rowUids": set(),
                "examples": [],
                "exampleSet": set(),
                "findingCountInGroup": 0,
                "sampleEvidence": sample_evidence,
            }
            groups[key] = group

        group["findingCountInGroup"] += len(row_indices) if row_indices else 1
        if severity_rank[mapped_severity] > severity_rank[group["severity"]]:
            group["severity"] = mapped_severity

        for position in row_indices:
            row_uid = derive_row_uid(issue.table, frame, position)
            if row_uid not in group["rowUids"]:
                group["rowUids"].add(row_uid)
                if len(group["examples"]) < max_examples and row_uid not in group["exampleSet"]:
                    group["examples"].append(row_uid)
                    group["exampleSet"].add(row_uid)

    aggregated: list[dict[str, Any]] = []
    for (issue_type, table_name, column_name), group in groups.items():
        unique_row_count = len(group["rowUids"])
        all_marker_level = unique_row_count == 0 and group["findingCountInGroup"] > 0
        total_rows = group["totalRows"]
        profiled_rows = group["profiledRows"]

        if all_marker_level:
            # Preserve legacy semantics for table/column-level signals.
            affected_rows = total_rows
            affected_percentage = 100.0 if total_rows > 0 else 0.0
        elif estimated and profiled_rows > 0:
            # Fast Preview reports a full-table estimate derived from the
            # sampled affected-row rate. It never presents sample counts as
            # exact full-data counts.
            affected_percentage = math.floor(
                (unique_row_count / profiled_rows) * 100 * 1000 + 0.5
            ) / 1000
            affected_rows = min(
                total_rows,
                math.floor((affected_percentage / 100) * total_rows + 0.5),
            )
            if unique_row_count > 0 and total_rows > 0:
                affected_rows = max(1, affected_rows)
        else:
            affected_rows = unique_row_count
            affected_percentage = (
                math.floor((affected_rows / total_rows) * 100 * 1000 + 0.5) / 1000
                if total_rows > 0 else 0
            )

        humanized_type = issue_type.replace("_", " ")
        title = f"{humanized_type} in {table_name}"
        if column_name:
            title += f".{column_name}"

        fingerprint_input = f"{issue_type}|{table_name}|{column_name or ''}"
        fingerprint = hashlib.sha256(fingerprint_input.encode("utf-8")).hexdigest()

        aggregated.append({
            "tableName": table_name,
            "columnName": column_name,
            "issueType": issue_type,
            "dimension": group["dimension"],
            "severity": group["severity"],
            "title": title,
            "description": (
                f"{affected_rows} of {total_rows} row(s) affected by {humanized_type}."
            ),
            "affectedRows": affected_rows,
            "totalRows": total_rows,
            "affectedPercentage": affected_percentage,
            "examples": [] if all_marker_level else group["examples"],
            "estimated": estimated,
            "evidence": {
                "sampleFindingEvidence": group["sampleEvidence"],
                "findingCountInGroup": group["findingCountInGroup"],
                "analysisMode": "fast" if estimated else "full",
                "estimated": estimated,
                "profiledRows": profiled_rows,
                "sourceRows": total_rows,
            },
            "fingerprint": fingerprint,
        })

    return aggregated, finding_count
