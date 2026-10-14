#!/usr/bin/env python3
"""Validate that ground_truth.json describes real generated fixture data."""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path
from typing import Any

from generate_data import PRIMARY_KEYS, TABLE_ORDER


ROOT = Path(__file__).resolve().parents[1]
VERSIONS = ("v1_clean", "v2_dirty", "v3_schema_drift")
ALLOWED_ISSUE_TYPES = {
    "null_value",
    "empty_string",
    "duplicate_record",
    "duplicate_primary_key",
    "duplicate_candidate_key",
    "invalid_numeric",
    "mixed_type",
    "invalid_date",
    "inconsistent_date_format",
    "whitespace_inconsistency",
    "casing_inconsistency",
    "foreign_key_violation",
    "orphan_record",
    "outlier",
    "missing_required_value",
    "value_consistency_violation",
    "encoding_edge_case",
    "schema_added_column",
    "schema_removed_column",
    "schema_renamed_column",
    "schema_type_change",
    "category_drift",
}
SCHEMA_ISSUES = {
    "schema_added_column",
    "schema_removed_column",
    "schema_renamed_column",
    "schema_type_change",
    "category_drift",
    "inconsistent_date_format",
}


class GroundTruthError(Exception):
    """Raised for a stale, malformed, or impossible ground-truth entry."""


def load_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None:
                raise GroundTruthError(f"{path}: missing header")
            return list(reader.fieldnames), list(reader)
    except UnicodeDecodeError as exc:
        raise GroundTruthError(f"{path}: invalid UTF-8: {exc}") from exc


def load_data() -> tuple[
    dict[str, dict[str, list[dict[str, str]]]],
    dict[str, dict[str, list[str]]],
]:
    tables: dict[str, dict[str, list[dict[str, str]]]] = {}
    columns: dict[str, dict[str, list[str]]] = {}
    for version in VERSIONS:
        tables[version] = {}
        columns[version] = {}
        for table in TABLE_ORDER:
            columns[version][table], tables[version][table] = load_csv(
                ROOT / "data" / version / f"{table}.csv"
            )
    return tables, columns


def require(condition: bool, message: str) -> None:
    if not condition:
        raise GroundTruthError(message)


def validate_top_level(
    ground_truth: dict[str, Any],
    tables: dict[str, dict[str, list[dict[str, str]]]],
    columns: dict[str, dict[str, list[str]]],
) -> None:
    required = {
        "dataset_version",
        "tables",
        "primary_keys",
        "foreign_keys",
        "candidate_keys",
        "expected_row_counts",
        "expected_column_counts",
        "defects",
    }
    require(
        required <= set(ground_truth),
        f"Missing top-level fields: {sorted(required - set(ground_truth))}",
    )
    require(ground_truth["tables"] == TABLE_ORDER, "Ground-truth table order is stale")
    require(
        set(ground_truth["primary_keys"]) == set(TABLE_ORDER),
        "Primary-key table coverage is incomplete",
    )
    for version in VERSIONS:
        require(version in ground_truth["expected_row_counts"], f"Missing row counts for {version}")
        require(version in ground_truth["expected_column_counts"], f"Missing column counts for {version}")
        for table in TABLE_ORDER:
            actual_rows = len(tables[version][table])
            actual_columns = len(columns[version][table])
            require(
                ground_truth["expected_row_counts"][version][table] == actual_rows,
                f"{version}/{table}: ground-truth row count is {ground_truth['expected_row_counts'][version][table]}, actual is {actual_rows}",
            )
            require(
                ground_truth["expected_column_counts"][version][table] == actual_columns,
                f"{version}/{table}: ground-truth column count is {ground_truth['expected_column_counts'][version][table]}, actual is {actual_columns}",
            )
            require(
                ground_truth["columns"][version][table] == columns[version][table],
                f"{version}/{table}: ground-truth columns do not match actual header",
            )


def validate_relationship_metadata(
    ground_truth: dict[str, Any],
    columns: dict[str, dict[str, list[str]]],
) -> None:
    for table, key in ground_truth["primary_keys"].items():
        require(table in TABLE_ORDER, f"Unknown primary-key table: {table}")
        require(key in columns["v1_clean"][table], f"Unknown primary-key column: {table}.{key}")
    for relation in ground_truth["foreign_keys"]:
        for field in ("from_table", "from_column", "to_table", "to_column"):
            require(field in relation, f"Foreign key lacks {field}: {relation}")
        require(relation["from_table"] in TABLE_ORDER, f"Unknown FK source table: {relation}")
        require(relation["to_table"] in TABLE_ORDER, f"Unknown FK target table: {relation}")
        require(
            relation["from_column"] in columns["v1_clean"][relation["from_table"]],
            f"Unknown FK source column: {relation}",
        )
        require(
            relation["to_column"] in columns["v1_clean"][relation["to_table"]],
            f"Unknown FK target column: {relation}",
        )
    for table, keys in ground_truth["candidate_keys"].items():
        require(table in TABLE_ORDER, f"Unknown candidate-key table: {table}")
        for key in keys:
            require(key in columns["v1_clean"][table], f"Unknown candidate key: {table}.{key}")


def validate_defect(
    defect: dict[str, Any],
    tables: dict[str, dict[str, list[dict[str, str]]]],
    columns: dict[str, dict[str, list[str]]],
) -> None:
    required = {
        "defect_id",
        "version",
        "table",
        "issue_type",
        "column",
        "row_ids",
        "severity",
        "description",
        "expected_detection",
    }
    require(
        required <= set(defect),
        f"{defect.get('defect_id', '<unknown>')}: missing {sorted(required - set(defect))}",
    )
    defect_id = defect["defect_id"]
    version = defect["version"]
    table = defect["table"]
    issue = defect["issue_type"]
    require(version in VERSIONS, f"{defect_id}: unknown version {version}")
    require(table in TABLE_ORDER, f"{defect_id}: unknown table {table}")
    require(issue in ALLOWED_ISSUE_TYPES, f"{defect_id}: unsupported issue type {issue}")
    require(isinstance(defect["row_ids"], list), f"{defect_id}: row_ids must be a list")
    require(isinstance(defect["expected_detection"], bool), f"{defect_id}: expected_detection must be boolean")

    if issue in SCHEMA_ISSUES and version == "v3_schema_drift":
        require(version == "v3_schema_drift", f"{defect_id}: schema issue must target v3_schema_drift")
        require(
            defect["column"] in columns["v1_clean"][table]
            or defect["column"] in columns[version][table],
            f"{defect_id}: schema column is absent from both source and target",
        )
        require(
            defect["row_ids"] == [],
            f"{defect_id}: schema changes must not claim data row IDs",
        )
        if "row_numbers" in defect:
            require(defect["row_numbers"] == [], f"{defect_id}: schema row_numbers must be empty")
        if issue == "schema_renamed_column":
            new_column = defect.get("new_column")
            require(isinstance(new_column, str), f"{defect_id}: renamed column lacks new_column")
            require(new_column in columns[version][table], f"{defect_id}: renamed target column is absent")
        if issue == "category_drift":
            require(defect.get("old_values"), f"{defect_id}: category drift lacks old_values")
            require(defect.get("new_values"), f"{defect_id}: category drift lacks new_values")
        return

    require(version in tables, f"{defect_id}: version has no loaded data")
    require(defect["column"] in columns[version][table], f"{defect_id}: column is absent")
    row_numbers = defect.get("row_numbers")
    require(isinstance(row_numbers, list) and row_numbers, f"{defect_id}: row_numbers are required")
    require(
        all(isinstance(number, int) and number >= 1 for number in row_numbers),
        f"{defect_id}: row_numbers must be positive integers",
    )
    rows = tables[version][table]
    require(
        all(number <= len(rows) for number in row_numbers),
        f"{defect_id}: row number exceeds {version}/{table} row count",
    )
    primary_key = PRIMARY_KEYS[table]
    actual_ids = [rows[number - 1].get(primary_key, "") for number in row_numbers]
    for row_id in defect["row_ids"]:
        require(
            row_id in actual_ids or row_id in {row.get(primary_key, "") for row in rows},
            f"{defect_id}: row ID {row_id!r} does not exist in {version}/{table}.{primary_key}",
        )
    require(
        len(defect["row_ids"]) <= len(row_numbers),
        f"{defect_id}: row_ids cannot exceed referenced physical rows",
    )
    # Every referenced physical row must carry one of the documented row IDs.
    require(
        all(value in defect["row_ids"] for value in actual_ids),
        f"{defect_id}: row_numbers point to undocumented values {actual_ids}",
    )


def main() -> int:
    try:
        gt_path = ROOT / "ground_truth" / "ground_truth.json"
        schema_path = ROOT / "ground_truth" / "ground_truth_schema.json"
        require(gt_path.exists(), "ground_truth.json is missing")
        require(schema_path.exists(), "ground_truth_schema.json is missing")
        ground_truth = json.loads(gt_path.read_text(encoding="utf-8"))
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        require(
            set(schema["allowed_issue_types"]) == ALLOWED_ISSUE_TYPES,
            "ground_truth_schema.json allowed issue types differ from validator",
        )
        tables, columns = load_data()
        validate_top_level(ground_truth, tables, columns)
        validate_relationship_metadata(ground_truth, columns)
        defect_ids: set[str] = set()
        for defect in ground_truth["defects"]:
            require(defect["defect_id"] not in defect_ids, f"Duplicate defect ID: {defect['defect_id']}")
            defect_ids.add(defect["defect_id"])
            validate_defect(defect, tables, columns)
        print(
            f"PASS: ground truth validated ({len(defect_ids)} defects, "
            f"{len(ground_truth['tables'])} tables, {len(VERSIONS)} versions)."
        )
        return 0
    except (GroundTruthError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())