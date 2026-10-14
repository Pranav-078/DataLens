"""
The standard detector output contract.

This is a Phase 0 deliverable, not Phase 1: no real detectors exist yet.
What's defined here is the SHAPE every detector Phase 1 writes must
produce, and a validator that checks a candidate output against that
shape. detector_eval.py imports `validate_finding` and `Finding` from
here; it does not know or care how a Finding was produced.

Design note: `row_uid` is required on every finding. This is what lets
detector_eval.py compare a detector's output against
data/corrupted/ground_truth.json at the level of individual rows, rather
than only comparing aggregate counts (which can match by coincidence even
when a detector is flagging the wrong rows entirely).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

VALID_SEVERITIES = {"critical", "high", "medium", "low"}
VALID_DIMENSIONS = {
    "completeness",
    "uniqueness",
    "validity",
    "consistency",
    "referential_integrity",
}


@dataclass(frozen=True)
class Finding:
    """
    One detector's report of one problem, scoped to a single row where
    applicable. A table-level or column-level-but-multi-row problem
    (e.g. "12% of this column is null") is represented in this evaluation
    harness as one Finding per affected row_uid, NOT one aggregate Finding
    — that's what row-level precision/recall requires. Aggregation for
    display (Phase 1's actual quality_issues table) is a separate concern
    downstream of this contract.
    """

    issue_type: str
    dimension: str
    table: str
    row_uid: str
    column: Optional[str]
    severity: str
    evidence: dict[str, Any] = field(default_factory=dict)


class ContractViolation(ValueError):
    """Raised when a candidate detector output does not satisfy the contract."""


def validate_finding(candidate: Any) -> Finding:
    """
    Validates a candidate object against the Finding contract and returns
    a proper Finding if it passes. Raises ContractViolation with a specific
    reason if it doesn't. A detector that produces non-conforming output
    should fail the evaluation run loudly, not be silently skipped or
    coerced — a silently-dropped malformed finding would make a broken
    detector look like a detector with lower recall than it actually has.
    """
    if isinstance(candidate, Finding):
        _validate_fields(candidate)
        return candidate

    if not isinstance(candidate, dict):
        raise ContractViolation(
            f"Finding must be a Finding instance or a dict, got {type(candidate).__name__}"
        )

    required = {"issue_type", "dimension", "table", "row_uid", "column", "severity"}
    missing = required - candidate.keys()
    if missing:
        raise ContractViolation(f"Finding is missing required field(s): {sorted(missing)}")

    finding = Finding(
        issue_type=candidate["issue_type"],
        dimension=candidate["dimension"],
        table=candidate["table"],
        row_uid=candidate["row_uid"],
        column=candidate["column"],
        severity=candidate["severity"],
        evidence=candidate.get("evidence", {}),
    )
    _validate_fields(finding)
    return finding


def _validate_fields(finding: Finding) -> None:
    if not finding.issue_type or not isinstance(finding.issue_type, str):
        raise ContractViolation("issue_type must be a non-empty string")
    if finding.dimension not in VALID_DIMENSIONS:
        raise ContractViolation(
            f"dimension {finding.dimension!r} is not one of {sorted(VALID_DIMENSIONS)}"
        )
    if not finding.table or not isinstance(finding.table, str):
        raise ContractViolation("table must be a non-empty string")
    if not finding.row_uid or not isinstance(finding.row_uid, str):
        raise ContractViolation(
            "row_uid must be a non-empty string — a Finding with no row_uid cannot be "
            "graded against the ground-truth manifest at the row level"
        )
    if finding.severity not in VALID_SEVERITIES:
        raise ContractViolation(
            f"severity {finding.severity!r} is not one of {sorted(VALID_SEVERITIES)}"
        )
    if finding.column is not None and not isinstance(finding.column, str):
        raise ContractViolation("column must be a string or None")
