import json
from pathlib import Path

import jsonschema

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCHEMA_PATH = REPO_ROOT / "evaluation" / "ground_truth.schema.json"
MANIFEST_PATH = REPO_ROOT / "data" / "corrupted" / "ground_truth.json"


def test_schema_file_itself_is_valid_json_schema():
    schema = json.loads(SCHEMA_PATH.read_text())
    jsonschema.Draft7Validator.check_schema(schema)


def test_generated_manifest_conforms_to_schema():
    if not MANIFEST_PATH.exists():
        import pytest

        pytest.skip(
            "data/corrupted/ground_truth.json does not exist yet — run "
            "data/generators/make_clean_data.py then corrupt_data.py first."
        )
    schema = json.loads(SCHEMA_PATH.read_text())
    manifest = json.loads(MANIFEST_PATH.read_text())
    jsonschema.validate(instance=manifest, schema=schema)


def test_every_manifest_row_uid_exists_in_the_corresponding_clean_table():
    """The property the whole harness depends on: a ground-truth row_uid
    must be traceable back to a real row in data/clean/, not just present
    somewhere in the corrupted output."""
    import csv

    if not MANIFEST_PATH.exists():
        import pytest

        pytest.skip("ground_truth.json does not exist yet")

    manifest = json.loads(MANIFEST_PATH.read_text())
    clean_dir = REPO_ROOT / "data" / "clean"

    uids_by_table: dict[str, set[str]] = {}
    for defect in manifest["defects"]:
        table = defect["table"]
        if table not in uids_by_table:
            with open(clean_dir / f"{table}.csv", newline="", encoding="utf-8") as f:
                uids_by_table[table] = {row["row_uid"] for row in csv.DictReader(f)}
        assert defect["row_uid"] in uids_by_table[table], (
            f"defect references row_uid {defect['row_uid']!r} in table {table!r}, "
            f"which does not exist in data/clean/{table}.csv"
        )
