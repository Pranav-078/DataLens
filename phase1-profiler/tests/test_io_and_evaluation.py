from __future__ import annotations

import json

import pandas as pd

from datasage_profiler.evaluate import evaluate
from datasage_profiler.io import load_tables


def test_load_tables_excludes_ground_truth(tmp_path):
    # Mirrors DataSage Phase 0's own layout: ground_truth.json sits directly
    # inside the fixture directory, alongside its table files.
    fixture = tmp_path / "corrupted"
    fixture.mkdir()
    (fixture / "customers.csv").write_text("id,name\n1,Ana\n", encoding="utf-8")
    (fixture / "ground_truth.json").write_text("{}", encoding="utf-8")

    tables = load_tables(fixture)
    assert list(tables) == ["customers"]


def test_evaluation_reports_missing_fixture_and_reads_its_ground_truth(tmp_path):
    fixture = tmp_path / "corrupted"
    fixture.mkdir()
    pd.DataFrame({"id": ["1", "2"], "name": ["Ana", "Bob"]}).to_csv(
        fixture / "customers.csv", index=False
    )
    (fixture / "ground_truth.json").write_text(
        json.dumps({"defects": [{"issue_type": "invalid_numeric"}]}),
        encoding="utf-8",
    )
    report = evaluate(tmp_path)
    assert report["fixtures"]["clean"]["available"] is False
    assert report["fixtures"]["corrupted"]["available"] is True
    assert report["fixtures"]["corrupted"]["ground_truth"]["expected_labels"] == ["invalid_numeric"]


def test_evaluation_runs_available_fixture_without_ground_truth(tmp_path):
    fixture = tmp_path / "clean"
    fixture.mkdir()
    pd.DataFrame({"id": ["1", "2"], "name": ["Ana", "Bob"]}).to_csv(
        fixture / "customers.csv", index=False
    )
    report = evaluate(tmp_path)
    assert report["fixtures"]["clean"]["available"] is True
    assert report["fixtures"]["clean"]["issue_count"] == 0
    assert report["fixtures"]["clean"]["ground_truth"]["available"] is False