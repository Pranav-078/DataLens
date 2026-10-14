"""Command-line entry point for profiling tables."""

from __future__ import annotations

import argparse
from pathlib import Path

from .config import ProfilerConfig
from .engine import DataProfiler
from .io import load_tables
from .utils import deterministic_json


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the independent DataSage Phase 1 profiler.")
    parser.add_argument("source", help="CSV/JSON/parquet table or directory of tables")
    parser.add_argument("-o", "--output", type=Path, help="write deterministic JSON to this path")
    parser.add_argument(
        "--outlier-iqr-multiplier",
        type=float,
        default=1.5,
        help="Tukey IQR multiplier (default: 1.5)",
    )
    parser.add_argument(
        "--outlier-min-non-null",
        type=int,
        default=8,
        help="minimum numeric observations before outlier detection (default: 8)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    tables = load_tables(args.source)
    profiler = DataProfiler(
        ProfilerConfig(
            outlier_iqr_multiplier=args.outlier_iqr_multiplier,
            outlier_min_non_null=args.outlier_min_non_null,
        )
    )
    output = deterministic_json(profiler.profile(tables).to_dict())
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output, end="")
    return 0