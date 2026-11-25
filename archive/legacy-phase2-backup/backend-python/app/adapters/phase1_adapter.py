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

from typing import Any, Iterable

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
    if "row_uid" in frame.columns:
        return str(frame.iloc[position]["row_uid"])
    return f"{table_name}:{position + 1}"


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
    base_evidence: dict[str, Any] = {
        "phase1_issue_id": issue.issue_id,
        "phase1_detector": issue.detector,
        "phase1_severity": issue.severity,
        "phase1_confidence": issue.confidence,
        "phase1_observed_value": issue.observed_value,
        "phase1_description": issue.description,
        "phase1_details": issue.details,
        "phase1_row_reference": issue.row_reference,
    }

    row_indices = _row_indices_from_reference(issue.row_reference)

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
            "evidence": base_evidence,
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
