"""Detector extension contract.

Every issue-producing detector implements ``detect``.  The engine supplies
the table name, raw dataframe, already-computed column profiles, and config,
so future detectors can be added without changing the orchestration API.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Protocol

import pandas as pd

from .config import ProfilerConfig
from .models import ColumnProfile, Issue


@dataclass(frozen=True)
class DetectorContext:
    table: str
    frame: pd.DataFrame
    columns: List[ColumnProfile]
    config: ProfilerConfig


class Detector(Protocol):
    name: str

    def detect(self, context: DetectorContext) -> List[Issue]:
        """Return deterministic, issue-shaped findings for one table."""