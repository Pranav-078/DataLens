"""Orchestration for independent Phase 1 profiling."""

from __future__ import annotations

from typing import Iterable, List, Mapping

import pandas as pd

from .config import ProfilerConfig
from .contracts import Detector, DetectorContext
from .detectors import DEFAULT_DETECTORS
from .models import DatasetProfile, Issue, ProfileResult
from .profiling import build_dataset_profile


class DataProfiler:
    """Run profiling and quality detectors against one or more tables."""

    VERSION = "phase1.0"

    def __init__(
        self,
        config: ProfilerConfig | None = None,
        detectors: Iterable[Detector] = DEFAULT_DETECTORS,
    ) -> None:
        self.config = config or ProfilerConfig()
        self.detectors = tuple(detectors)

    def profile_table(self, table: str, frame: pd.DataFrame) -> tuple[DatasetProfile, List[Issue]]:
        profile = build_dataset_profile(table, frame, self.config)
        context = DetectorContext(
            table=table,
            frame=frame,
            columns=profile.columns,
            config=self.config,
        )
        issues: List[Issue] = []
        for detector in self.detectors:
            issues.extend(detector.detect(context))
        return profile, issues

    def profile(self, tables: Mapping[str, pd.DataFrame]) -> ProfileResult:
        profiles: List[DatasetProfile] = []
        issues: List[Issue] = []
        for table in sorted(tables):
            profile, table_issues = self.profile_table(table, tables[table])
            profiles.append(profile)
            issues.extend(table_issues)
        issues = sorted(
            issues,
            key=lambda issue: (
                issue.table,
                issue.issue_type,
                issue.column or "",
                str(issue.row_reference or {}),
                issue.issue_id,
            ),
        )
        return ProfileResult(
            version=self.VERSION,
            tables=profiles,
            issues=issues,
            metadata={
                "detectors": [detector.name for detector in self.detectors],
                "phase_scope": [
                    "dataset profiling",
                    "duplicate detection",
                    "type quality",
                    "string quality",
                    "required fields",
                    "numeric outliers",
                    "categorical value consistency",
                ],
                "intentionally_excluded": [
                    "foreign-key/relationship/orphan detection (Phase 2)",
                    "quality scoring (Phase 3)",
                    "FastAPI or Node integration",
                ],
            },
        )