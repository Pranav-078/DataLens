"""Fixture evaluation helper for DataSage's own Phase 0 fixtures.

There is no separate "datasage-fixtures" repository; the fixtures this
evaluator reads are the ones already produced by DataSage Phase 0 under
``DataSage/data/``:

.. code-block:: text

    data/
      clean/               plain, defect-free tables
      corrupted/            tables with injected defects
        ground_truth.json   defect list for the tables in this directory

Point ``fixture_root`` at that ``data/`` directory (or an equivalent
directory containing ``clean`` and/or ``corrupted`` subfolders). Each
fixture's ``ground_truth.json``, if present, lives inside that fixture's own
directory alongside its tables -- not in a shared top-level folder.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Set

from .engine import DataProfiler
from .io import load_tables
from .utils import deterministic_json


FIXTURE_NAMES = ("clean", "corrupted")


def _strings_for_keys(value: Any, wanted: Set[str]) -> Set[str]:
    found: Set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key.casefold() in wanted:
                if isinstance(child, str):
                    found.add(child)
                elif isinstance(child, list):
                    found.update(str(item) for item in child if isinstance(item, (str, int, float)))
            found.update(_strings_for_keys(child, wanted))
    elif isinstance(value, list):
        for child in value:
            found.update(_strings_for_keys(child, wanted))
    return found


def _load_ground_truth(fixture_path: Path) -> Dict[str, Any]:
    """Load ``ground_truth.json`` from inside one fixture directory, if present.

    DataSage Phase 0 keeps the defect list next to the fixture's own tables
    (e.g. ``data/corrupted/ground_truth.json``), so this looks in the fixture
    directory itself rather than a shared root-level ``ground_truth/`` folder.
    """

    path = fixture_path / "ground_truth.json"
    if not path.exists():
        return {"available": False, "reason": f"No ground_truth.json in {fixture_path}"}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {
        "available": True,
        "expected_labels": sorted(
            _strings_for_keys(
                payload,
                {"issue_type", "defect_type", "detector", "category", "type"},
            )
        ),
    }


def evaluate(root: str | Path) -> Dict[str, Any]:
    source = Path(root)
    profiler = DataProfiler()
    fixtures: Dict[str, Any] = {}
    for name in FIXTURE_NAMES:
        fixture_path = source / name
        if not fixture_path.exists():
            fixtures[name] = {"available": False, "reason": f"Missing fixture directory: {fixture_path}"}
            continue
        result = profiler.profile(load_tables(fixture_path)).to_dict()
        fixtures[name] = {
            "available": True,
            "table_count": len(result["tables"]),
            "issue_count": result["summary"]["issue_count"],
            "issues_by_type": result["summary"]["by_type"],
            "issues": result["issues"],
            "ground_truth": _load_ground_truth(fixture_path),
        }
    return {
        "profiler_version": profiler.VERSION,
        "fixture_root": str(source),
        "fixtures": fixtures,
        "scope_note": (
            "This evaluator reports observed findings and available ground-truth labels "
            "from DataSage's own Phase 0 fixtures (data/clean, data/corrupted). It does not "
            "infer Phase 2 relationship defects or Phase 3 scores, and it does not assume the "
            "existence of a separate datasage-fixtures repository."
        ),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Evaluate DataSage Phase 1 against DataSage Phase 0's clean/corrupted data fixtures."
    )
    parser.add_argument(
        "fixture_root",
        help="directory containing 'clean' and/or 'corrupted' fixture subdirectories (e.g. DataSage/data)",
    )
    parser.add_argument("-o", "--output", type=Path, help="write evaluation JSON to this path")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    output = deterministic_json(evaluate(args.fixture_root))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output, end="")
    return 0