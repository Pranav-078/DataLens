import pandas as pd
import pytest

from app.contracts import VALID_DIMENSIONS, VALID_SEVERITIES
from app.adapters.phase1_adapter import (
    adapt_issue,
    adapt_profile_result,
    derive_row_uid,
    AdapterMappingError,
)
from datasage_profiler.models import Issue, ProfileResult, DatasetProfile


def make_issue(**overrides) -> Issue:
    base = dict(
        issue_id="ds1_test",
        issue_type="empty_string",
        severity="warning",
        table="customers",
        column="phone",
        row_reference={"row_index": 2},
        observed_value="",
        description="test",
        detector="StringQualityDetector",
        confidence=None,
        details={},
    )
    base.update(overrides)
    return Issue(**base)


class TestDeriveRowUid:
    def test_synthesizes_table_and_1_based_row_number_when_no_row_uid_column(self):
        frame = pd.DataFrame({"email": ["a@x.com", "b@x.com", "c@x.com"]})
        assert derive_row_uid("customers", frame, 0) == "customers:1"
        assert derive_row_uid("customers", frame, 2) == "customers:3"

    def test_uses_existing_row_uid_column_when_present(self):
        frame = pd.DataFrame({"row_uid": ["uuid-aaa", "uuid-bbb"], "email": ["a@x.com", "b@x.com"]})
        assert derive_row_uid("customers", frame, 1) == "uuid-bbb"

    def test_is_deterministic_across_repeated_calls(self):
        frame = pd.DataFrame({"email": ["a@x.com"]})
        first = derive_row_uid("orders", frame, 0)
        second = derive_row_uid("orders", frame, 0)
        assert first == second == "orders:1"


class TestAdaptIssue:
    def test_maps_dimension_and_severity_explicitly(self):
        issue = make_issue(issue_type="required_field_missing", severity="error")
        frame = pd.DataFrame({"phone": ["", "555-1234"]})
        [finding] = adapt_issue(issue, frame)
        assert finding.dimension == "completeness"
        assert finding.severity == "high"
        assert finding.dimension in VALID_DIMENSIONS
        assert finding.severity in VALID_SEVERITIES

    def test_single_row_reference_produces_one_finding_with_correct_row_uid(self):
        issue = make_issue(row_reference={"row_index": 4})
        frame = pd.DataFrame({"phone": [""] * 6})
        [finding] = adapt_issue(issue, frame)
        assert finding.row_uid == "customers:5"  # 0-indexed 4 -> 1-based 5

    def test_multi_row_reference_fans_out_into_multiple_findings(self):
        issue = make_issue(issue_type="duplicate_full_record", row_reference={"row_indices": [1, 3]})
        frame = pd.DataFrame({"phone": [""] * 5})
        findings = adapt_issue(issue, frame)
        assert len(findings) == 2
        assert {f.row_uid for f in findings} == {"customers:2", "customers:4"}
        assert all(f.issue_type == "duplicate_full_record" for f in findings)

    def test_no_row_reference_produces_one_table_level_finding_with_marker_row_uid(self):
        issue = make_issue(row_reference=None)
        frame = pd.DataFrame({"phone": [""] * 3})
        [finding] = adapt_issue(issue, frame)
        assert finding.row_uid == "customers:*"

    def test_preserves_original_phase1_information_in_evidence(self):
        issue = make_issue(
            issue_id="ds1_abc123",
            detector="StringQualityDetector",
            confidence=0.87,
            observed_value="",
            description="Phone is empty",
            details={"pattern": "empty_string"},
        )
        frame = pd.DataFrame({"phone": [""] * 3})
        [finding] = adapt_issue(issue, frame)
        assert finding.evidence["phase1_issue_id"] == "ds1_abc123"
        assert finding.evidence["phase1_detector"] == "StringQualityDetector"
        assert finding.evidence["phase1_confidence"] == 0.87
        assert finding.evidence["phase1_description"] == "Phone is empty"
        assert finding.evidence["phase1_details"] == {"pattern": "empty_string"}
        assert finding.evidence["phase1_severity"] == "warning"  # original, pre-remap

    def test_unmapped_issue_type_raises_explicitly_rather_than_guessing(self):
        issue = make_issue(issue_type="some_future_detector_type")
        frame = pd.DataFrame({"phone": [""] * 3})
        with pytest.raises(AdapterMappingError, match="some_future_detector_type"):
            adapt_issue(issue, frame)

    def test_every_known_phase1_issue_type_has_a_dimension_mapping(self):
        """Guards against the map silently going stale if Phase 1's detector
        set changes — grep the vendored source directly rather than trust
        a hardcoded list here."""
        import re
        from pathlib import Path

        detectors_source = (
            Path(__file__).resolve().parent.parent / "vendor" / "datasage_profiler" / "detectors.py"
        ).read_text()
        actual_issue_types = set(re.findall(r'issue_type="([a-z_]+)"', detectors_source))

        from app.adapters.phase1_adapter import _DIMENSION_BY_ISSUE_TYPE

        unmapped = actual_issue_types - _DIMENSION_BY_ISSUE_TYPE.keys()
        assert not unmapped, f"Vendored Phase 1 can produce unmapped issue_type(s): {unmapped}"


class TestAdaptProfileResult:
    def test_converts_every_issue_across_multiple_tables(self):
        customers = pd.DataFrame({"phone": ["", "555-1234"]})
        orders = pd.DataFrame({"status": ["shipped", "shipped"]})
        result = ProfileResult(
            version="test",
            tables=[
                DatasetProfile("customers", 2, 1, ["phone"], []),
                DatasetProfile("orders", 2, 1, ["status"], []),
            ],
            issues=[
                make_issue(table="customers", row_reference={"row_index": 0}),
                make_issue(
                    table="orders",
                    column="status",
                    issue_type="casing_inconsistency",
                    row_reference={"row_index": 1},
                ),
            ],
        )
        findings = adapt_profile_result(result, {"customers": customers, "orders": orders})
        assert len(findings) == 2
        assert {f.table for f in findings} == {"customers", "orders"}
