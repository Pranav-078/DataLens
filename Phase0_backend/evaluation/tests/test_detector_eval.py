import pandas as pd
import pytest

from evaluation.detector_contract import Finding, ContractViolation
from evaluation import detector_eval
from evaluation import registry


@pytest.fixture(autouse=True)
def clean_registry():
    """Every test gets an empty registry and the original is restored after,
    so tests never leak detectors into each other or into a real run."""
    original = list(registry.DETECTOR_REGISTRY)
    registry.DETECTOR_REGISTRY.clear()
    yield
    registry.DETECTOR_REGISTRY.clear()
    registry.DETECTOR_REGISTRY.extend(original)


def synthetic_ground_truth() -> dict:
    return {
        "seed": 42,
        "defects": [
            {"table": "customers", "row_uid": "r1", "column": "email", "defect_type": "missing_value",
             "original_value": "a@b.com", "corrupted_value": ""},
            {"table": "customers", "row_uid": "r2", "column": "email", "defect_type": "missing_value",
             "original_value": "c@d.com", "corrupted_value": ""},
            {"table": "customers", "row_uid": "r3", "column": "email", "defect_type": "missing_value",
             "original_value": "e@f.com", "corrupted_value": ""},
        ],
    }


class TestComputeMetrics:
    """compute_metrics is pure and synchronous, so it's tested directly
    without going through run_detectors or any file I/O."""

    def test_perfect_detector_scores_100_percent_precision_and_recall(self, monkeypatch):
        monkeypatch.setitem(
            detector_eval.ISSUE_TYPE_TO_DEFECT_TYPE, "null_check", "missing_value"
        )
        findings = [
            Finding("null_check", "completeness", "customers", "r1", "email", "low"),
            Finding("null_check", "completeness", "customers", "r2", "email", "low"),
            Finding("null_check", "completeness", "customers", "r3", "email", "low"),
        ]
        metrics = detector_eval.compute_metrics(synthetic_ground_truth(), findings)
        m = next(x for x in metrics if x.defect_type == "missing_value")
        assert m.true_positives == 3
        assert m.false_positives == 0
        assert m.false_negatives == 0
        assert m.precision == 1.0
        assert m.recall == 1.0

    def test_partial_recall_when_detector_misses_some_defects(self, monkeypatch):
        monkeypatch.setitem(
            detector_eval.ISSUE_TYPE_TO_DEFECT_TYPE, "null_check", "missing_value"
        )
        findings = [Finding("null_check", "completeness", "customers", "r1", "email", "low")]
        metrics = detector_eval.compute_metrics(synthetic_ground_truth(), findings)
        m = next(x for x in metrics if x.defect_type == "missing_value")
        assert m.true_positives == 1
        assert m.false_negatives == 2
        assert m.recall == pytest.approx(1 / 3, rel=1e-3)
        assert m.precision == 1.0  # everything it DID flag was correct

    def test_false_positives_reduce_precision_but_not_recall(self, monkeypatch):
        monkeypatch.setitem(
            detector_eval.ISSUE_TYPE_TO_DEFECT_TYPE, "null_check", "missing_value"
        )
        findings = [
            Finding("null_check", "completeness", "customers", "r1", "email", "low"),
            Finding("null_check", "completeness", "customers", "r2", "email", "low"),
            Finding("null_check", "completeness", "customers", "r3", "email", "low"),
            # r99 does not exist in ground truth at all — a false positive.
            Finding("null_check", "completeness", "customers", "r99", "email", "low"),
        ]
        metrics = detector_eval.compute_metrics(synthetic_ground_truth(), findings)
        m = next(x for x in metrics if x.defect_type == "missing_value")
        assert m.true_positives == 3
        assert m.false_positives == 1
        assert m.recall == 1.0
        assert m.precision == pytest.approx(0.75, rel=1e-3)

    def test_uncovered_defect_type_reports_zero_tp_and_none_precision_not_a_crash(self):
        # No mapping registered at all for "missing_value" -> nothing can match.
        metrics = detector_eval.compute_metrics(synthetic_ground_truth(), findings=[])
        m = next(x for x in metrics if x.defect_type == "missing_value")
        assert m.covered is False
        assert m.true_positives == 0
        assert m.precision is None  # not 0.0, not a ZeroDivisionError
        assert m.recall == 0.0  # denominator (tp+fn) is > 0 here, so this IS computable


class TestRunDetectors:
    def test_zero_registered_detectors_produces_zero_findings(self):
        tables = {"customers": pd.DataFrame({"row_uid": ["r1"], "email": [""]})}
        findings = detector_eval.run_detectors(tables)
        assert findings == []

    def test_a_registered_detector_actually_runs_and_its_findings_are_collected(self):
        @registry.register
        def fake_detector(table_name, df):
            for _, row in df.iterrows():
                if row["email"] == "":
                    yield {
                        "issue_type": "missing_value",
                        "dimension": "completeness",
                        "table": table_name,
                        "row_uid": row["row_uid"],
                        "column": "email",
                        "severity": "low",
                    }

        tables = {
            "customers": pd.DataFrame(
                {"row_uid": ["r1", "r2"], "email": ["", "present@example.com"]}
            )
        }
        findings = detector_eval.run_detectors(tables)
        assert len(findings) == 1
        assert findings[0].row_uid == "r1"

    def test_a_detector_producing_a_contract_violating_finding_aborts_the_run(self):
        @registry.register
        def broken_detector(table_name, df):
            yield {"issue_type": "x"}  # missing every other required field

        tables = {"customers": pd.DataFrame({"row_uid": ["r1"], "email": [""]})}
        with pytest.raises(ContractViolation, match="broken_detector"):
            detector_eval.run_detectors(tables)
