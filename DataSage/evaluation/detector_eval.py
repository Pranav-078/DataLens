"""
Runs every detector in registry.DETECTOR_REGISTRY against
data/corrupted/*.csv and grades its output against
data/corrupted/ground_truth.json, at row-level granularity (via row_uid).

Phase 0 has zero registered detectors. Running this script now is still
meaningful: it proves the plumbing — loading data, loading ground truth,
validating the (empty) set of findings against the contract, computing
metrics without dividing by zero, and writing a report — all work
correctly, so Phase 1 can add a detector and get a real number back
immediately rather than debugging the harness at the same time.

Usage:
    python evaluation/detector_eval.py
    python evaluation/detector_eval.py --corrupted-dir path/to/other/data
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # allow `evaluation.*` imports

from evaluation.detector_contract import Finding, ContractViolation, validate_finding
from evaluation.registry import DETECTOR_REGISTRY

DEFAULT_CORRUPTED_DIR = Path(__file__).resolve().parent.parent / "data" / "corrupted"
DEFAULT_RESULTS_DIR = Path(__file__).resolve().parent / "results"

# Maps a detector's issue_type to the ground-truth defect_type(s) it is
# expected to catch. Empty in Phase 0 because no detectors exist to map.
# A Phase 1 detector adds its mapping here so the harness can grade it;
# an unmapped defect_type is reported as "not yet covered", which is an
# honest statement about project progress, not an error.
ISSUE_TYPE_TO_DEFECT_TYPE: dict[str, str] = {}


@dataclass
class DefectTypeMetrics:
    defect_type: str
    total_ground_truth: int
    true_positives: int
    false_positives: int
    false_negatives: int
    covered: bool  # whether any registered detector claims to catch this defect_type

    @property
    def precision(self) -> float | None:
        denom = self.true_positives + self.false_positives
        return round(self.true_positives / denom, 4) if denom > 0 else None

    @property
    def recall(self) -> float | None:
        denom = self.true_positives + self.false_negatives
        return round(self.true_positives / denom, 4) if denom > 0 else None


def load_ground_truth(corrupted_dir: Path) -> dict:
    path = corrupted_dir / "ground_truth.json"
    if not path.exists():
        raise FileNotFoundError(
            f"No ground_truth.json found at {path}. Run "
            f"data/generators/make_clean_data.py then corrupt_data.py first."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def load_tables(corrupted_dir: Path) -> dict[str, pd.DataFrame]:
    tables = {}
    for csv_path in sorted(corrupted_dir.glob("*.csv")):
        tables[csv_path.stem] = pd.read_csv(csv_path, dtype=str, keep_default_na=False)
    return tables


def run_detectors(tables: dict[str, pd.DataFrame]) -> list[Finding]:
    """Runs every registered detector against every table, validating each
    finding against the contract before accepting it. A detector that
    produces a non-conforming Finding aborts the whole run with a clear
    error — see detector_contract.py's docstring for why this is
    deliberate rather than a silent skip."""
    findings: list[Finding] = []
    for detector_fn in DETECTOR_REGISTRY:
        for table_name, df in tables.items():
            for raw_finding in detector_fn(table_name, df):
                try:
                    findings.append(validate_finding(raw_finding))
                except ContractViolation as exc:
                    raise ContractViolation(
                        f"Detector {detector_fn.__name__!r} produced a finding that "
                        f"violates the contract: {exc}"
                    ) from exc
    return findings


def compute_metrics(ground_truth: dict, findings: list[Finding]) -> list[DefectTypeMetrics]:
    defects_by_type: dict[str, list[dict]] = {}
    for defect in ground_truth["defects"]:
        defects_by_type.setdefault(defect["defect_type"], []).append(defect)

    # Which defect_types a detector is even trying to catch, and the
    # (table, row_uid) pairs it actually flagged for that defect_type.
    covered_defect_types = set(ISSUE_TYPE_TO_DEFECT_TYPE.values())
    findings_by_defect_type: dict[str, set[tuple[str, str]]] = {}
    for f in findings:
        defect_type = ISSUE_TYPE_TO_DEFECT_TYPE.get(f.issue_type)
        if defect_type is None:
            continue  # a detector finding not mapped to any known defect_type is ignored for grading
        findings_by_defect_type.setdefault(defect_type, set()).add((f.table, f.row_uid))

    metrics: list[DefectTypeMetrics] = []
    for defect_type, defects in sorted(defects_by_type.items()):
        ground_truth_keys = {(d["table"], d["row_uid"]) for d in defects}
        flagged_keys = findings_by_defect_type.get(defect_type, set())

        true_positives = len(ground_truth_keys & flagged_keys)
        false_negatives = len(ground_truth_keys - flagged_keys)
        false_positives = len(flagged_keys - ground_truth_keys)

        metrics.append(
            DefectTypeMetrics(
                defect_type=defect_type,
                total_ground_truth=len(ground_truth_keys),
                true_positives=true_positives,
                false_positives=false_positives,
                false_negatives=false_negatives,
                covered=defect_type in covered_defect_types,
            )
        )
    return metrics


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corrupted-dir", type=Path, default=DEFAULT_CORRUPTED_DIR)
    parser.add_argument("--results-dir", type=Path, default=DEFAULT_RESULTS_DIR)
    args = parser.parse_args()

    ground_truth = load_ground_truth(args.corrupted_dir)
    tables = load_tables(args.corrupted_dir)
    findings = run_detectors(tables)
    metrics = compute_metrics(ground_truth, findings)

    args.results_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "seed": ground_truth["seed"],
        "detectors_registered": len(DETECTOR_REGISTRY),
        "total_findings": len(findings),
        "metrics": [
            {
                "defect_type": m.defect_type,
                "covered": m.covered,
                "total_ground_truth": m.total_ground_truth,
                "true_positives": m.true_positives,
                "false_positives": m.false_positives,
                "false_negatives": m.false_negatives,
                "precision": m.precision,
                "recall": m.recall,
            }
            for m in metrics
        ],
    }
    report_path = args.results_dir / "detector_eval_report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"Detectors registered: {len(DETECTOR_REGISTRY)}")
    print(f"Total findings produced: {len(findings)}")
    print(f"{'defect_type':<30} {'covered':<9} {'gt':>4} {'tp':>4} {'fp':>4} {'fn':>4} {'prec':>7} {'rec':>7}")
    for m in metrics:
        prec = f"{m.precision:.2%}" if m.precision is not None else "n/a"
        rec = f"{m.recall:.2%}" if m.recall is not None else "n/a"
        print(
            f"{m.defect_type:<30} {str(m.covered):<9} {m.total_ground_truth:>4} "
            f"{m.true_positives:>4} {m.false_positives:>4} {m.false_negatives:>4} {prec:>7} {rec:>7}"
        )
    print(f"\nFull report written to {report_path}")

    if len(DETECTOR_REGISTRY) == 0:
        print(
            "\nNote: 0 detectors are registered. This is expected in Phase 0 — "
            "the harness itself is what's being validated here. Every "
            "defect_type above correctly shows 0 true positives and "
            "n/a precision/recall rather than a division error, which is "
            "the behavior Phase 1's real detectors will be graded with."
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
