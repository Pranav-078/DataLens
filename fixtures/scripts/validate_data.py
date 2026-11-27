#!/usr/bin/env python3
"""Validate generated fixture files and their documented defect catalog."""

from __future__ import annotations

import csv
import json
import sys
from collections import Counter
from decimal import Decimal, InvalidOperation
from datetime import datetime
from pathlib import Path
from typing import Any

from generate_data import (
    CLEAN_COLUMNS,
    CANDIDATE_KEYS,
    FOREIGN_KEYS,
    NULL_TOKEN,
    PRIMARY_KEYS,
    TABLE_ORDER,
)


ROOT = Path(__file__).resolve().parents[1]
VERSIONS = ("v1_clean", "v2_dirty", "v3_schema_drift")
NUMERIC_COLUMNS = {
    "base_price",
    "price_adjustment",
    "stock_quantity",
    "subtotal",
    "shipping_fee",
    "tax_amount",
    "total_amount",
    "quantity",
    "unit_price",
    "line_total",
}
DATE_COLUMNS = {"signup_date", "created_date", "order_date", "shipping_date"}
TIMESTAMP_COLUMNS = {"opened_at", "event_time"}


class ValidationError(Exception):
    """Raised for a fixture validation failure."""


def load_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None:
                raise ValidationError(f"{path}: missing header")
            rows = list(reader)
            if any(None in row for row in rows):
                raise ValidationError(f"{path}: row has more fields than its header")
            return list(reader.fieldnames), rows
    except UnicodeDecodeError as exc:
        raise ValidationError(f"{path}: not valid UTF-8: {exc}") from exc
    except csv.Error as exc:
        raise ValidationError(f"{path}: invalid CSV: {exc}") from exc


def load_all() -> tuple[
    dict[str, dict[str, list[dict[str, str]]]],
    dict[str, dict[str, list[str]]],
]:
    tables: dict[str, dict[str, list[dict[str, str]]]] = {}
    columns: dict[str, dict[str, list[str]]] = {}
    expected_files = {f"{table}.csv" for table in TABLE_ORDER}
    for version in VERSIONS:
        version_root = ROOT / "data" / version
        if not version_root.is_dir():
            raise ValidationError(f"Missing version directory: {version_root}")
        actual_files = {path.name for path in version_root.iterdir() if path.is_file()}
        if actual_files != expected_files:
            raise ValidationError(
                f"{version}: expected exactly {sorted(expected_files)}, "
                f"found {sorted(actual_files)}"
            )
        tables[version] = {}
        columns[version] = {}
        for table in TABLE_ORDER:
            fieldnames, rows = load_csv(version_root / f"{table}.csv")
            tables[version][table] = rows
            columns[version][table] = fieldnames
    return tables, columns


def duplicate_values(rows: list[dict[str, str]], column: str) -> dict[str, int]:
    counts = Counter(row.get(column, "") for row in rows)
    return {value: count for value, count in counts.items() if count > 1}


def is_null(value: str | None) -> bool:
    return value == NULL_TOKEN


def parse_decimal(value: str) -> Decimal:
    if value in ("", NULL_TOKEN):
        raise InvalidOperation("empty or null")
    return Decimal(value)


def parse_temporal(value: str, column: str) -> datetime:
    if value in ("", NULL_TOKEN):
        raise ValueError("empty or null")
    if column in DATE_COLUMNS:
        return datetime.strptime(value, "%Y-%m-%d")
    return datetime.fromisoformat(value)


def validate_clean(
    tables: dict[str, dict[str, list[dict[str, str]]]],
    columns: dict[str, dict[str, list[str]]],
    expected_counts: dict[str, Any],
) -> None:
    clean = tables["v1_clean"]
    for table in TABLE_ORDER:
        if columns["v1_clean"][table] != CLEAN_COLUMNS[table]:
            raise ValidationError(
                f"v1_clean/{table}: header differs from documented clean schema"
            )
        rows = clean[table]
        if len(rows) != expected_counts["v1_clean"][table]:
            raise ValidationError(f"v1_clean/{table}: unexpected row count")
        key = PRIMARY_KEYS[table]
        values = [row.get(key, "") for row in rows]
        if any(value in ("", NULL_TOKEN) for value in values):
            raise ValidationError(f"v1_clean/{table}: primary key contains null/empty")
        if len(values) != len(set(values)):
            raise ValidationError(f"v1_clean/{table}: duplicate primary key")
        for row in rows:
            for column in CLEAN_COLUMNS[table]:
                if row.get(column, "") in ("", NULL_TOKEN):
                    raise ValidationError(
                        f"v1_clean/{table}: unexpected null/empty {column}"
                    )
            for column in NUMERIC_COLUMNS.intersection(row):
                try:
                    parse_decimal(row[column])
                except InvalidOperation as exc:
                    raise ValidationError(
                        f"v1_clean/{table}: non-numeric {column}={row[column]!r}"
                    ) from exc
            for column in DATE_COLUMNS.intersection(row) | TIMESTAMP_COLUMNS.intersection(row):
                try:
                    parse_temporal(row[column], column)
                except ValueError as exc:
                    raise ValidationError(
                        f"v1_clean/{table}: invalid ISO {column}={row[column]!r}"
                    ) from exc
        for candidate in CANDIDATE_KEYS.get(table, []):
            duplicates = duplicate_values(rows, candidate)
            if duplicates:
                raise ValidationError(
                    f"v1_clean/{table}: duplicate candidate key {candidate}: {duplicates}"
                )

    validate_foreign_keys(clean, "v1_clean", allow_violations=False)


def validate_foreign_keys(
    tables: dict[str, list[dict[str, str]]],
    version: str,
    allow_violations: bool,
) -> list[str]:
    errors: list[str] = []
    for relation in FOREIGN_KEYS:
        parent_values = {
            row.get(relation["to_column"], "")
            for row in tables[relation["to_table"]]
        }
        for row_number, row in enumerate(tables[relation["from_table"]], start=1):
            value = row.get(relation["from_column"], "")
            if value not in parent_values:
                errors.append(
                    f"{version}/{relation['from_table']} row {row_number}: "
                    f"{relation['from_column']}={value!r} does not reference "
                    f"{relation['to_table']}.{relation['to_column']}"
                )
    if errors and not allow_violations:
        raise ValidationError("Foreign-key violations:\n  " + "\n  ".join(errors))
    return errors


def rows_for_defect(
    defect: dict[str, Any], tables: dict[str, dict[str, list[dict[str, str]]]]
) -> list[tuple[int, dict[str, str]]]:
    version = defect["version"]
    table = defect["table"]
    rows = tables[version][table]
    return [(number, rows[number - 1]) for number in defect.get("row_numbers", [])]


def observe_defect(
    defect: dict[str, Any],
    tables: dict[str, dict[str, list[dict[str, str]]]],
) -> bool:
    issue = defect["issue_type"]
    table = defect["table"]
    column = defect.get("column", "")
    targeted = rows_for_defect(defect, tables)
    values = [row.get(column, "") for _, row in targeted]

    if issue == "null_value":
        return bool(values) and all(is_null(value) for value in values)
    if issue == "empty_string":
        return bool(values) and all(value == "" for value in values)
    if issue == "missing_required_value":
        return bool(values) and all(value in ("", NULL_TOKEN) for value in values)
    if issue == "duplicate_record":
        return len(targeted) >= 2 and all(
            targeted[0][1] == row for _, row in targeted[1:]
        )
    if issue == "duplicate_primary_key":
        return len(duplicate_values(tables[defect["version"]][table], column)) > 0
    if issue == "duplicate_candidate_key":
        return len(duplicate_values(tables[defect["version"]][table], column)) > 0
    if issue in {"invalid_numeric", "mixed_type"}:
        if column == "is_active":
            return bool(values) and any(value not in {"true", "false", "0", "1"} for value in values)
        try:
            for value in values:
                parse_decimal(value)
        except InvalidOperation:
            return True
        return issue == "invalid_numeric" and any(
            parse_decimal(value) < 0 for value in values
        )
    if issue == "invalid_date":
        try:
            for value in values:
                parse_temporal(value, column)
        except ValueError:
            return True
        return False
    if issue == "inconsistent_date_format":
        return bool(values) and any("/" in value for value in values)
    if issue == "whitespace_inconsistency":
        return bool(values) and any(value != value.strip() for value in values)
    if issue == "casing_inconsistency":
        canonical = defect.get("canonical_value")
        return bool(values) and any(
            value != canonical for value in values
        ) if canonical else False
    if issue in {"foreign_key_violation", "orphan_record"}:
        relations = [
            relation
            for relation in FOREIGN_KEYS
            if relation["from_table"] == table and relation["from_column"] == column
        ]
        if not relations:
            return False
        parent_values = {
            row[relations[0]["to_column"]]
            for row in tables[defect["version"]][relations[0]["to_table"]]
        }
        return bool(values) and any(value not in parent_values for value in values)
    if issue == "outlier":
        return bool(values) and any(
            (len(value) > 500)
            or (value not in ("", NULL_TOKEN) and abs(parse_decimal(value)) > Decimal("100000"))
            or (column == "quantity" and value not in ("", NULL_TOKEN) and int(value) > 100)
            for value in values
            if value not in ("", NULL_TOKEN)
        )
    if issue == "value_consistency_violation":
        row = targeted[0][1]
        try:
            expected = (
                Decimal(row["subtotal"])
                + Decimal(row["shipping_fee"])
                + Decimal(row["tax_amount"])
            ).quantize(Decimal("0.01"))
            return Decimal(row["total_amount"]) != expected
        except (InvalidOperation, KeyError):
            return False
    if issue == "encoding_edge_case":
        return bool(values) and any(any(ord(char) > 127 for char in value) for value in values)
    return False


def validate_dirty_defects(
    tables: dict[str, dict[str, list[dict[str, str]]]],
    ground_truth: dict[str, Any],
) -> None:
    dirty_defects = [
        defect for defect in ground_truth["defects"] if defect["version"] == "v2_dirty"
    ]
    if not dirty_defects:
        raise ValidationError("No v2_dirty defects are documented")
    for defect in dirty_defects:
        if not observe_defect(defect, tables):
            raise ValidationError(
                f"{defect['defect_id']} was not observed: {defect['description']}"
            )
    fk_errors = validate_foreign_keys(tables["v2_dirty"], "v2_dirty", True)
    if not fk_errors:
        raise ValidationError("v2_dirty contains no relationship violations")


def validate_schema_drift(
    tables: dict[str, dict[str, list[dict[str, str]]]],
    columns: dict[str, dict[str, list[str]]],
    ground_truth: dict[str, Any],
) -> None:
    for version in VERSIONS:
        for table in TABLE_ORDER:
            expected = ground_truth["columns"][version][table]
            if columns[version][table] != expected:
                raise ValidationError(
                    f"{version}/{table}: actual headers do not match ground truth"
                )
    clean_categories = {row["category"] for row in tables["v1_clean"]["products"]}
    drift_categories = {row["category"] for row in tables["v3_schema_drift"]["products"]}
    if "Home & Kitchen" not in clean_categories or "Home & Kitchen" in drift_categories:
        raise ValidationError("Schema category drift is not represented exactly")
    if "Home & Living" not in drift_categories:
        raise ValidationError("Schema category drift new value is missing")
    for row in tables["v3_schema_drift"]["customers"]:
        if row["is_active"] not in {"0", "1"}:
            raise ValidationError("v3 customers.is_active is not integer text")
    for row in tables["v3_schema_drift"]["orders"]:
        for column in ("order_date", "shipping_date"):
            try:
                datetime.strptime(row[column], "%m/%d/%Y")
            except ValueError as exc:
                raise ValidationError(
                    f"v3 orders/{column}: unexpected date representation"
                ) from exc
    schema_defects = [
        defect
        for defect in ground_truth["defects"]
        if defect["version"] == "v3_schema_drift"
    ]
    for defect in schema_defects:
        if not observe_schema_defect(defect, columns, tables):
            raise ValidationError(
                f"{defect['defect_id']} schema change was not observed"
            )
    validate_foreign_keys(tables["v3_schema_drift"], "v3_schema_drift", False)


def observe_schema_defect(
    defect: dict[str, Any],
    columns: dict[str, dict[str, list[str]]],
    tables: dict[str, dict[str, list[dict[str, str]]]],
) -> bool:
    table = defect["table"]
    actual = columns["v3_schema_drift"][table]
    issue = defect["issue_type"]
    if issue == "schema_added_column":
        return defect["column"] in actual and defect["column"] not in columns["v1_clean"][table]
    if issue == "schema_removed_column":
        return defect["column"] not in actual and defect["column"] in columns["v1_clean"][table]
    if issue == "schema_renamed_column":
        return (
            defect["column"] not in actual
            and defect.get("new_column") in actual
            and defect["column"] in columns["v1_clean"][table]
        )
    if issue == "schema_type_change":
        values = {row[defect["column"]] for row in tables["v3_schema_drift"][table]}
        return values <= {"0", "1"}
    if issue == "category_drift":
        return (
            any(row[defect["column"]] in defect["new_values"] for row in tables["v3_schema_drift"][table])
            and not any(row[defect["column"]] in defect["old_values"] for row in tables["v3_schema_drift"][table])
        )
    if issue == "inconsistent_date_format":
        return all(
            "/" in row[defect["column"]]
            for row in tables["v3_schema_drift"][table]
        )
    return False


def report_inventory(
    tables: dict[str, dict[str, list[dict[str, str]]]],
    columns: dict[str, dict[str, list[str]]],
) -> None:
    print("CSV inventory:")
    for version in VERSIONS:
        print(f"  {version}:")
        for table in TABLE_ORDER:
            rows = tables[version][table]
            null_counts = {
                column: sum(is_null(row.get(column)) for row in rows)
                for column in columns[version][table]
                if any(is_null(row.get(column)) for row in rows)
            }
            duplicate_pk = duplicate_values(rows, PRIMARY_KEYS[table])
            inspected_types = {
                column: type(next(iter(rows), {}).get(column, "")).__name__
                for column in columns[version][table]
            }
            print(
                f"    {table}: rows={len(rows)}, columns={len(columns[version][table])}, "
                f"duplicate_pk={duplicate_pk or 'none'}, "
                f"nulls={null_counts or 'none'}, types={inspected_types}"
            )


def main() -> int:
    try:
        gt_path = ROOT / "ground_truth" / "ground_truth.json"
        if not gt_path.exists():
            raise ValidationError("ground_truth/ground_truth.json is missing")
        ground_truth = json.loads(gt_path.read_text(encoding="utf-8"))
        tables, columns = load_all()
        expected_counts = ground_truth["expected_row_counts"]
        report_inventory(tables, columns)
        validate_clean(tables, columns, expected_counts)
        validate_dirty_defects(tables, ground_truth)
        validate_schema_drift(tables, columns, ground_truth)
        print("PASS: data files, clean relationships, dirty defects, and schema drift validated.")
        return 0
    except (ValidationError, KeyError, json.JSONDecodeError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())