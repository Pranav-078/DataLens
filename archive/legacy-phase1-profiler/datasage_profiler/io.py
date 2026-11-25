"""Table loading and deterministic result writing.

The loader is deliberately generic and does not recreate the official
datasage-fixtures repository.  Point it at that repository when it is
available.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict

import pandas as pd


SUPPORTED_EXTENSIONS = {".csv", ".json", ".parquet"}
EXCLUDED_PARTS = {"ground_truth", "__pycache__"}


def _read_table(path: Path) -> pd.DataFrame:
    suffix = path.suffix.casefold()
    if suffix == ".csv":
        return pd.read_csv(path, dtype=object, keep_default_na=False, na_filter=False)
    if suffix == ".json":
        return pd.read_json(path, dtype=False)
    if suffix == ".parquet":
        return pd.read_parquet(path)
    raise ValueError(f"Unsupported table extension: {path.suffix}")


def load_tables(path: str | Path) -> Dict[str, pd.DataFrame]:
    """Load one table file or all supported tables under a directory."""

    source = Path(path)
    if source.is_file():
        return {source.stem: _read_table(source)}
    if not source.is_dir():
        raise FileNotFoundError(f"Table source does not exist: {source}")
    files = [
        candidate for candidate in source.rglob("*")
        if candidate.is_file()
        and candidate.suffix.casefold() in SUPPORTED_EXTENSIONS
        and not any(part in EXCLUDED_PARTS for part in candidate.relative_to(source).parts)
        and not candidate.name.casefold().startswith("ground_truth")
    ]
    if not files:
        raise FileNotFoundError(f"No CSV, JSON, or parquet tables found under {source}")
    tables: Dict[str, pd.DataFrame] = {}
    for file_path in sorted(files):
        table_name = file_path.relative_to(source).with_suffix("").as_posix().replace("/", "__")
        if table_name in tables:
            raise ValueError(f"Duplicate table name after normalization: {table_name}")
        tables[table_name] = _read_table(file_path)
    return tables