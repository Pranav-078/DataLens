"""
Integration test against the authoritative datasage-fixtures repository
(v1_clean, v2_dirty). Strictly read-only — this test only ever opens files
under FIXTURES_ROOT for reading; it never writes into that directory.

FIXTURES_ROOT defaults to the sibling-of-the-monorepo location used
throughout this integration effort (.../datasage-fixtures, next to
.../datasage), overridable via the DATASAGE_FIXTURES_PATH env var. If
neither location exists, every test here is skipped rather than failed —
the authoritative fixtures are an external dependency, not something this
repository vendors or generates.
"""

import os
from pathlib import Path

import pandas as pd
import pytest

from app.adapters.phase1_adapter import adapt_profile_result
from app.contracts import validate_finding, ContractViolation
from datasage_profiler.engine import DataProfiler

_DEFAULT_FIXTURES_ROOT = Path(__file__).resolve().parents[3] / "datasage-fixtures"
FIXTURES_ROOT = Path(os.environ.get("DATASAGE_FIXTURES_PATH", _DEFAULT_FIXTURES_ROOT))

pytestmark = pytest.mark.skipif(
    not (FIXTURES_ROOT / "data" / "v1_clean").exists(),
    reason=(
        f"authoritative datasage-fixtures not found at {FIXTURES_ROOT} "
        f"(set DATASAGE_FIXTURES_PATH to override) — skipping, not failing, "
        f"since this is an external dependency"
    ),
)


def _load_version(version: str) -> dict[str, pd.DataFrame]:
    version_dir = FIXTURES_ROOT / "data" / version
    tables = {}
    for csv_path in sorted(version_dir.glob("*.csv")):
        tables[csv_path.stem] = pd.read_csv(
            csv_path, dtype=str, keep_default_na=False, na_filter=False
        )
    return tables


def test_v1_clean_produces_zero_findings_through_the_full_adapter_pipeline():
    tables = _load_version("v1_clean")
    result = DataProfiler().profile(tables)
    findings = adapt_profile_result(result, tables)
    assert findings == []


def test_v2_dirty_findings_all_satisfy_the_phase0_contract():
    """Every single finding the adapter produces from real dirty data must
    pass validate_finding — this is the actual point of the adapter, not
    just that SOME findings come out."""
    tables = _load_version("v2_dirty")
    result = DataProfiler().profile(tables)
    findings = adapt_profile_result(result, tables)

    assert len(findings) > 0
    for f in findings:
        validate_finding(f)  # raises ContractViolation on any violation


def test_v2_dirty_row_uids_are_all_well_formed_and_traceable():
    tables = _load_version("v2_dirty")
    result = DataProfiler().profile(tables)
    findings = adapt_profile_result(result, tables)

    for f in findings:
        assert f.row_uid, "row_uid must never be empty"
        assert f.row_uid.startswith(f"{f.table}:"), (
            f"row_uid {f.row_uid!r} does not start with its own table name {f.table!r}"
        )


def test_adapter_does_not_write_anything_into_the_fixtures_directory():
    """Explicit guard for the 'keep datasage-fixtures read-only' rule:
    snapshot the directory's file list before and after running the full
    pipeline against it, and assert nothing changed."""
    before = sorted(p.relative_to(FIXTURES_ROOT) for p in FIXTURES_ROOT.rglob("*"))

    tables = _load_version("v2_dirty")
    result = DataProfiler().profile(tables)
    adapt_profile_result(result, tables)

    after = sorted(p.relative_to(FIXTURES_ROOT) for p in FIXTURES_ROOT.rglob("*"))
    assert before == after
