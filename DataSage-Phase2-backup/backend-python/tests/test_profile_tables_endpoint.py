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


def test_existing_stub_endpoint_is_unaffected_by_the_new_route():
    """The old /internal/profile stub must still behave exactly as before
    — this is what proves Step 1 didn't quietly change Node-facing behavior."""
    resp = client.post("/internal/profile", json={"tableCount": 3})
    assert resp.status_code == 200
    assert resp.json() == {"status": "stub_ok", "receivedTables": 3}
