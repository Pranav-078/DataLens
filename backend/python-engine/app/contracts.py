"""
Phase 0's Finding contract — MIRRORED from evaluation/detector_contract.py
at the repository root, not imported from it.

Why a copy and not an import: backend-python is built as an independent
Docker image with build context `./backend-python` (see docker-compose.yml).
The root-level `evaluation/` folder is dev tooling for the evaluation
harness and is never part of that build context, so it cannot be imported
here at runtime or in a container. Given the two-service architecture
established in Phase 0 (Node owns state, Python is stateless and
independently deployable), duplicating this small, stable contract is the
correct tradeoff for Step 1 rather than restructuring either service's
build context.

KEEP THIS IN SYNC with evaluation/detector_contract.py — same field names,
same two enums, same validation rules. If one changes, the other must.
A future step should probably extract both into a small shared package;
that is out of scope here.
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
    """One detector's report of one problem, scoped to a single row where
    applicable. Identical shape to evaluation.detector_contract.Finding."""

    issue_type: str
    dimension: str
    table: str
    row_uid: str
    column: Optional[str]
    severity: str
    evidence: dict[str, Any] = field(default_factory=dict)


class ContractViolation(ValueError):
    """Raised when a candidate Finding does not satisfy the contract."""


def validate_finding(candidate: Any) -> Finding:
    """Validates a candidate against the Finding contract, returning a
    proper Finding if it passes. Raises ContractViolation with a specific
    reason otherwise — the adapter must never silently drop or coerce a
    malformed finding, for the same reason detector_eval.py doesn't."""
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
            "traced back to a specific row"
        )
    if finding.severity not in VALID_SEVERITIES:
        raise ContractViolation(
            f"severity {finding.severity!r} is not one of {sorted(VALID_SEVERITIES)}"
        )
    if finding.column is not None and not isinstance(finding.column, str):
        raise ContractViolation("column must be a string or None")
