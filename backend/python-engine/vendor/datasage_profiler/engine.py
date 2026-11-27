"""Orchestration for independent Phase 1 profiling."""

from __future__ import annotations

from typing import Iterable, List, Mapping
import logging
from time import perf_counter

import pandas as pd

from .config import ProfilerConfig
from .contracts import Detector, DetectorContext
from .detectors import DEFAULT_DETECTORS
from .models import DatasetProfile, Issue, ProfileResult
from .profiling import build_dataset_profile

_LOGGER = logging.getLogger("datasage-profiler")


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
        table_started = perf_counter()
        _LOGGER.info(
            "table profiling started table=%s rows=%d columns=%d",
            table, len(frame), len(frame.columns),
        )

        profile = build_dataset_profile(table, frame, self.config)
        profiled_at = perf_counter()
        _LOGGER.info(
            "table statistics complete table=%s elapsed_ms=%.1f",
            table, (profiled_at - table_started) * 1000,
        )
        context = DetectorContext(
            table=table,
            frame=frame,
            columns=profile.columns,
            config=self.config,
        )
        issues: List[Issue] = []
        for detector in self.detectors:
            detector_started = perf_counter()
            _LOGGER.info(
                "quality detector started table=%s detector=%s",
                table, detector.name,
            )
            detector_issues = detector.detect(context)
            detector_elapsed = (perf_counter() - detector_started) * 1000
            issues.extend(detector_issues)
            _LOGGER.info(
                "quality detector complete table=%s detector=%s issues=%d elapsed_ms=%.1f",
                table, detector.name, len(detector_issues), detector_elapsed,
            )
        _LOGGER.info(
            "table profiling complete table=%s issues=%d elapsed_ms=%.1f",
            table, len(issues), (perf_counter() - table_started) * 1000,
        )
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