"""Dataset and column profiling, separate from quality issue detectors."""

from __future__ import annotations

from typing import List

import pandas as pd

from .config import ProfilerConfig
from .models import ColumnProfile, DatasetProfile
from .utils import infer_type, is_null_value, name_matches


def _is_empty_string(value: object) -> bool:
    return isinstance(value, str) and value.strip() == ""


def build_dataset_profile(table: str, frame: pd.DataFrame, config: ProfilerConfig) -> DatasetProfile:
    columns: List[ColumnProfile] = []
    for name in frame.columns:
        series = frame[name]
        null_count = sum(is_null_value(value, config.missing_tokens) for value in series.tolist())
        empty_count = sum(_is_empty_string(value) for value in series.tolist())
        non_null_values = [
            value for value in series.tolist()
            if not is_null_value(value, config.missing_tokens) and not _is_empty_string(value)
        ]
        unique_count = len({str(value) for value in non_null_values})
        columns.append(
            ColumnProfile(
                name=str(name),
                inferred_type=infer_type(
                    series,
                    config.missing_tokens,
                    numeric_name_hint=name_matches(str(name), config.numeric_name_patterns),
                    date_name_hint=name_matches(str(name), config.date_name_patterns),
                ),
                non_null_count=len(non_null_values),
                unique_count=unique_count,
                null_count=null_count,
                null_percentage=round((null_count / len(frame) * 100) if len(frame) else 0.0, 6),
                empty_string_count=empty_count,
            )
        )
    return DatasetProfile(
        table=table,
        row_count=int(len(frame)),
        column_count=int(len(frame.columns)),
        column_names=[str(name) for name in frame.columns],
        columns=columns,
    )