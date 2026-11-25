from __future__ import annotations

import json

import pandas as pd

from datasage_profiler.config import ProfilerConfig
from datasage_profiler.engine import DataProfiler


def issue_types(result):
    return [issue.issue_type for issue in result.issues]


def test_dataset_profile_counts_and_types():
    frame = pd.DataFrame(
        {
            "customer_id": ["1", "2", ""],
            "name": ["Ana", "Bob", "Cara"],
            "amount": ["10.5", "20", "30"],
        }
    )
    result = DataProfiler().profile({"customers": frame})
    profile = result.tables[0]

    assert profile.row_count == 3
    assert profile.column_count == 3
    assert profile.column_names == ["customer_id", "name", "amount"]
    amount = next(column for column in profile.columns if column.name == "amount")
    assert amount.inferred_type == "float"
    assert amount.null_count == 0
    customer_id = next(column for column in profile.columns if column.name == "customer_id")
    assert customer_id.null_count == 0
    assert customer_id.non_null_count == 2
    assert customer_id.empty_string_count == 1
    assert customer_id.null_percentage == 0.0


def test_clean_data_has_no_quality_findings():
    frame = pd.DataFrame(
        {
            "customer_id": ["c-1", "c-2", "c-3"],
            "name": ["Ana", "Bob", "Cara"],
            "status": ["active", "inactive", "active"],
            "created_date": ["2024-01-01", "2024-01-02", "2024-01-03"],
            "amount": ["10", "12", "11"],
        }
    )
    assert DataProfiler().profile({"customers": frame}).issues == []


def test_duplicate_full_records_and_candidate_keys():
    frame = pd.DataFrame(
        {
            "customer_id": ["1", "2", "2"],
            "name": ["Ana", "Bob", "Bob"],
        }
    )
    result = DataProfiler().profile({"customers": frame})
    duplicate_types = issue_types(result)
    assert "duplicate_full_record" in duplicate_types
    assert "duplicate_candidate_key" in duplicate_types
    candidate = next(issue for issue in result.issues if issue.issue_type == "duplicate_candidate_key")
    assert candidate.row_reference == {"row_indices": [1, 2]}


def test_type_quality_detects_invalid_numeric_dates_and_format_drift():
    frame = pd.DataFrame(
        {
            "amount": ["10", "12", "bad", "14"],
            "event_date": ["2024-01-01", "2024/01/02", "2024-01-03", "not-a-date"],
            "mixed": ["1", "two", "3", "four"],
        }
    )
    result = DataProfiler().profile({"events": frame})
    types = issue_types(result)
    assert "invalid_numeric" in types
    assert "invalid_date" in types
    assert "inconsistent_date_format" in types
    assert "mixed_type" in types


def test_string_quality_detects_whitespace_case_empty_and_encoding():
    frame = pd.DataFrame(
        {
            "label": [" North", "north", "South ", "", "bad\ufffd"],
        }
    )
    result = DataProfiler().profile({"labels": frame})
    types = issue_types(result)
    assert "leading_trailing_whitespace" in types
    assert "casing_inconsistency" in types
    assert "empty_string" in types
    assert "encoding_edge_case" in types


def test_required_field_heuristic_and_explicit_configuration():
    frame = pd.DataFrame({"customer_id": ["1", ""], "region": ["east", None]})
    result = DataProfiler(
        ProfilerConfig(required_columns=("region",))
    ).profile({"customers": frame})
    required = [issue for issue in result.issues if issue.issue_type == "required_field_missing"]
    assert {issue.column for issue in required} == {"customer_id", "region"}
    assert all("heuristic" in issue.details for issue in required)


def test_outlier_uses_configurable_iqr_threshold():
    frame = pd.DataFrame({"amount": ["10", "11", "12", "13", "14", "15", "16", "100"]})
    result = DataProfiler(
        ProfilerConfig(outlier_min_non_null=8, outlier_iqr_multiplier=1.5)
    ).profile({"sales": frame})
    outliers = [issue for issue in result.issues if issue.issue_type == "numeric_outlier"]
    assert len(outliers) == 1
    assert outliers[0].row_reference == {"row_index": 7}
    assert outliers[0].details["algorithm"] == "Tukey IQR"


def test_value_consistency_requires_repeated_dominant_value():
    frame = pd.DataFrame(
        {"status": ["active", "active", "active", "active", "inactive", "inactive", "actve"]}
    )
    result = DataProfiler().profile({"accounts": frame})
    consistency = [issue for issue in result.issues if issue.issue_type == "inconsistent_categorical_value"]
    assert len(consistency) == 1
    assert consistency[0].observed_value == "actve"


def test_deterministic_json_output():
    frame = pd.DataFrame({"id": ["1", "1"], "value": ["a", "a"]})
    profiler = DataProfiler()
    first = profiler.profile({"table": frame}).to_dict()
    second = profiler.profile({"table": frame}).to_dict()
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    assert first["issues"][0]["issue_id"].startswith("ds1_")


def test_detector_contract_allows_additional_detector():
    class CustomDetector:
        name = "custom_detector"

        def detect(self, context):
            from datasage_profiler.detectors import _issue

            return [
                _issue(
                    issue_type="custom_finding",
                    severity="info",
                    table=context.table,
                    column=None,
                    description="contract smoke test",
                    detector=self.name,
                )
            ]

    result = DataProfiler(detectors=(CustomDetector(),)).profile({"t": pd.DataFrame({"x": [1]})})
    assert issue_types(result) == ["custom_finding"]