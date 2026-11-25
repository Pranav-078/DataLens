import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_profile_tables_happy_path_returns_phase0_shaped_findings():
    resp = client.post(
        "/internal/profile/tables",
        json={
            "tables": [
                {
                    "tableName": "customers",
                    "csvContent": "customer_id,email\n1,a@example.com\n2,\n3,c@example.com\n",
                }
            ]
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "profiled"
    assert body["tableCount"] == 1
    assert body["findingCount"] >= 1

    for finding in body["findings"]:
        assert finding["dimension"] in {
            "completeness", "uniqueness", "validity", "consistency", "referential_integrity",
        }
        assert finding["severity"] in {"critical", "high", "medium", "low"}
        assert finding["row_uid"]  # never empty
        assert finding["table"] == "customers"


def test_profile_tables_response_includes_table_and_column_profile_summaries():
    resp = client.post(
        "/internal/profile/tables",
        json={
            "tables": [
                {
                    "tableName": "customers",
                    "csvContent": "customer_id,email\n1,a@example.com\n2,\n3,c@example.com\n",
                }
            ]
        },
    )
    body = resp.json()
    assert len(body["tables"]) == 1
    table = body["tables"][0]
    assert table["tableName"] == "customers"
    assert table["rowCount"] == 3
    assert table["columnCount"] == 2

    columns_by_name = {c["columnName"]: c for c in table["columns"]}
    assert set(columns_by_name) == {"customer_id", "email"}
    email_col = columns_by_name["email"]
    assert email_col["nullCount"] == 0  # the blank email is empty-string, not null
    assert email_col["distinctCount"] == 2  # "" and two distinct real emails -> 2 non-empty distinct... see below
    assert 0.0 <= email_col["uniquenessRatio"] <= 1.0


def test_uniqueness_ratio_is_none_when_column_has_zero_non_null_values():
    """Both data rows are the NULL sentinel, so non_null_count is 0 for this
    column — this is exactly the case uniquenessRatio's None-guard exists
    for, checked directly rather than via a tautological condition."""
    resp = client.post(
        "/internal/profile/tables",
        json={"tables": [{"tableName": "empties", "csvContent": "a\nNULL\nNULL\n"}]},
    )
    body = resp.json()
    col = body["tables"][0]["columns"][0]
    assert col["nullCount"] == 2
    assert col["uniquenessRatio"] is None


def test_profile_tables_synthesizes_row_uid_as_table_colon_1_based_row_number():
    resp = client.post(
        "/internal/profile/tables",
        json={
            "tables": [
                {
                    "tableName": "orders",
                    # row 2 (1-indexed) has an empty status — required_field_missing
                    "csvContent": "order_id,status\n1,shipped\n2,\n3,shipped\n",
                }
            ]
        },
    )
    body = resp.json()
    row_uids = {f["row_uid"] for f in body["findings"]}
    assert "orders:2" in row_uids


def test_profile_tables_with_no_issues_returns_zero_findings_not_an_error():
    resp = client.post(
        "/internal/profile/tables",
        json={
            "tables": [
                {"tableName": "products", "csvContent": "product_id,name\n1,Widget\n2,Gadget\n"}
            ]
        },
    )
    assert resp.status_code == 200
    assert resp.json()["findingCount"] == 0


def _customers_csv(n: int) -> str:
    rows = "\n".join(f"C{i:03d},Customer {i}" for i in range(n))
    return f"id,name\n{rows}\n"


def test_relationships_field_is_present_and_is_a_list():
    resp = client.post(
        "/internal/profile/tables",
        json={"tables": [{"tableName": "solo", "csvContent": "a,b\n1,x\n2,y\n"}]},
    )
    body = resp.json()
    assert "relationships" in body
    assert isinstance(body["relationships"], list)
    assert body["relationships"] == []  # a single table can't have a cross-table relationship


def test_positive_relationship_is_returned_via_the_real_endpoint():
    customers_csv = _customers_csv(25)
    orders_rows = "\n".join(f"O{i:03d},C{i % 25:03d}" for i in range(40))
    orders_csv = f"order_id,customer_id\n{orders_rows}\n"

    resp = client.post(
        "/internal/profile/tables",
        json={
            "tables": [
                {"tableName": "customers", "csvContent": customers_csv},
                {"tableName": "orders", "csvContent": orders_csv},
            ]
        },
    )
    assert resp.status_code == 200
    body = resp.json()

    matches = [
        r for r in body["relationships"]
        if r["child_table"] == "orders" and r["child_column"] == "customer_id"
    ]
    assert len(matches) == 1
    rel = matches[0]
    assert rel["parent_table"] == "customers"
    assert rel["parent_column"] == "id"
    assert rel["status"] == "inferred"
    assert rel["confidence_band"] in {"high", "medium", "low"}
    assert rel["value_overlap"] == 1.0
    assert rel["orphan_count"] == 0
    assert "evidence" in rel and isinstance(rel["evidence"], dict)


def test_false_relationship_is_not_returned_for_similarly_named_but_unrelated_columns():
    customers_csv = _customers_csv(25)
    # "customer_id" name, but the values share nothing with customers.id.
    unrelated_rows = "\n".join(f"ZZZ-{i:05d},note{i}" for i in range(25))
    unrelated_csv = f"customer_id,notes\n{unrelated_rows}\n"

    resp = client.post(
        "/internal/profile/tables",
        json={
            "tables": [
                {"tableName": "customers", "csvContent": customers_csv},
                {"tableName": "unrelated_table", "csvContent": unrelated_csv},
            ]
        },
    )
    body = resp.json()
    matches = [r for r in body["relationships"] if r["child_table"] == "unrelated_table"]
    assert matches == [], "name similarity alone must never produce a relationship through the real endpoint"


def test_orphan_information_is_returned_via_the_real_endpoint():
    # A 100-customer parent, with only 30 distinct ones actually referenced,
    # leaves real headroom against the cardinality gate (child distinct <=
    # parent distinct * 1.05) once 6 distinct bad ids are added — unlike a
    # 30-customer parent fully referenced, where 30 valid + 6 bad = 36
    # distinct child values already exceeds 30 * 1.05 = 31.5.
    customers_csv = _customers_csv(100)
    valid_rows = "\n".join(f"O{i:03d},C{i % 30:03d}" for i in range(40))
    bad_rows = "\n".join(f"OBAD{i},BADID{i}" for i in range(6))
    orders_csv = f"order_id,customer_id\n{valid_rows}\n{bad_rows}\n"

    resp = client.post(
        "/internal/profile/tables",
        json={
            "tables": [
                {"tableName": "customers", "csvContent": customers_csv},
                {"tableName": "orders", "csvContent": orders_csv},
            ]
        },
    )
    body = resp.json()
    [rel] = [r for r in body["relationships"] if r["child_column"] == "customer_id"]
    assert rel["orphan_count"] == 6
    assert rel["orphan_percentage"] == pytest.approx(100 * 6 / 46, abs=0.01)
    assert 1 <= len(rel["orphan_examples"]) <= 5
    assert all(ex.startswith("BADID") for ex in rel["orphan_examples"])


def test_response_still_contains_correct_tables_and_findings_alongside_relationships():
    """Confirms Slice B is purely additive: the existing tables/findings
    behavior from Step 3 / Phase 1 is unchanged in a multi-table request."""
    customers_csv = _customers_csv(25)
    orders_rows = "\n".join(f"O{i:03d},C{i % 25:03d}" for i in range(30))
    orders_csv = f"order_id,customer_id\n{orders_rows}\n"

    resp = client.post(
        "/internal/profile/tables",
        json={
            "tables": [
                {"tableName": "customers", "csvContent": customers_csv},
                {"tableName": "orders", "csvContent": orders_csv},
            ]
        },
    )
    body = resp.json()
    assert body["tableCount"] == 2
    assert {t["tableName"] for t in body["tables"]} == {"customers", "orders"}
    assert isinstance(body["findingCount"], int)
    assert isinstance(body["findings"], list)
    assert isinstance(body["relationships"], list)


def test_relationship_output_is_deterministic_across_repeated_calls():
    customers_csv = _customers_csv(25)
    orders_rows = "\n".join(f"O{i:03d},C{i % 25:03d}" for i in range(35))
    orders_csv = f"order_id,customer_id\n{orders_rows}\n"
    payload = {
        "tables": [
            {"tableName": "customers", "csvContent": customers_csv},
            {"tableName": "orders", "csvContent": orders_csv},
        ]
    }

    first = client.post("/internal/profile/tables", json=payload).json()["relationships"]
    second = client.post("/internal/profile/tables", json=payload).json()["relationships"]
    assert first == second


def test_existing_stub_endpoint_is_unaffected_by_the_new_route():
    """The old /internal/profile stub must still behave exactly as before
    — this is what proves Step 1 didn't quietly change Node-facing behavior."""
    resp = client.post("/internal/profile", json={"tableCount": 3})
    assert resp.status_code == 200
    assert resp.json() == {"status": "stub_ok", "receivedTables": 3}
