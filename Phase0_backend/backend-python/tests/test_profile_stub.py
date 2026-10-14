from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_ok():
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "version" in body


def test_profile_happy_path_matches_node_client_contract():
    resp = client.post("/internal/profile", json={"tableCount": 3})
    assert resp.status_code == 200
    body = resp.json()
    # This exact shape is what backend-node's isProfileStubResponse checks.
    assert body == {"status": "stub_ok", "receivedTables": 3}


def test_profile_missing_table_count_is_422():
    resp = client.post("/internal/profile", json={})
    assert resp.status_code == 422


def test_profile_simulate_notimplemented_is_501():
    resp = client.post(
        "/internal/profile", json={"tableCount": 1, "simulateFailure": "notimplemented"}
    )
    assert resp.status_code == 501


def test_profile_simulate_error500_is_500():
    resp = client.post(
        "/internal/profile", json={"tableCount": 1, "simulateFailure": "error500"}
    )
    assert resp.status_code == 500


def test_profile_simulate_malformed_returns_200_with_wrong_shape():
    """
    Confirms the malformed-response branch actually produces a 200 with a
    body that does NOT match the contract — this is what forces the Node
    client's isProfileStubResponse() guard to reject it as
    PROFILER_BAD_RESPONSE rather than accepting a garbage payload.
    """
    resp = client.post(
        "/internal/profile", json={"tableCount": 1, "simulateFailure": "malformed"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "status" not in body or body.get("status") != "stub_ok"


def test_profile_rejects_wrong_type_for_table_count():
    resp = client.post("/internal/profile", json={"tableCount": "not-a-number"})
    assert resp.status_code == 422
