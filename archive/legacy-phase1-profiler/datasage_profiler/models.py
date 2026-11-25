"""Stable, JSON-friendly result models."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Issue:
    issue_id: str
    issue_type: str
    severity: str
    table: str
    column: Optional[str]
    row_reference: Optional[Dict[str, Any]]
    observed_value: Any
    description: str
    detector: str
    confidence: Optional[float] = None
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ColumnProfile:
    name: str
    inferred_type: str
    non_null_count: int
    unique_count: int
    null_count: int
    null_percentage: float
    empty_string_count: int

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class DatasetProfile:
    table: str
    row_count: int
    column_count: int
    column_names: List[str]
    columns: List[ColumnProfile]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ProfileResult:
    version: str
    tables: List[DatasetProfile]
    issues: List[Issue]
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        issue_dicts = [issue.to_dict() for issue in self.issues]
        severity_counts: Dict[str, int] = {}
        type_counts: Dict[str, int] = {}
        for issue in issue_dicts:
            severity_counts[issue["severity"]] = severity_counts.get(issue["severity"], 0) + 1
            type_counts[issue["issue_type"]] = type_counts.get(issue["issue_type"], 0) + 1
        return {
            "version": self.version,
            "tables": [table.to_dict() for table in self.tables],
            "issues": issue_dicts,
            "summary": {
                "issue_count": len(issue_dicts),
                "by_severity": dict(sorted(severity_counts.items())),
                "by_type": dict(sorted(type_counts.items())),
            },
            "metadata": self.metadata,
        }