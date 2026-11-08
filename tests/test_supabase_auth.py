from fastapi.testclient import TestClient

import app as dashboard


def test_supabase_auth_redirects_browser_and_rejects_api_without_session(monkeypatch):
    monkeypatch.setattr(dashboard, "SUPABASE_AUTH_ENABLED", True)
    monkeypatch.setattr(dashboard, "SUPABASE_AUTH_CONFIGURED", True)
    client = TestClient(dashboard.app, follow_redirects=False)

    page = client.get("/")
    assert page.status_code == 303
    assert page.headers["location"] == "/login"
    api_response = client.get("/api/health")
    assert api_response.status_code == 401
    assert api_response.headers["X-Dashboard-Auth"] == "required"

    config = client.get("/api/auth/config")
    assert config.status_code == 200
    assert config.json()["enabled"] is True


def test_missing_publishable_key_fails_closed_when_supabase_url_is_set(monkeypatch):
    monkeypatch.setattr(dashboard, "SUPABASE_AUTH_ENABLED", True)
    monkeypatch.setattr(dashboard, "SUPABASE_AUTH_CONFIGURED", False)
    monkeypatch.setattr(dashboard, "SUPABASE_PUBLISHABLE_KEY", "")
    client = TestClient(dashboard.app, follow_redirects=False)

    assert client.get("/").status_code == 303
    assert client.get("/api/health").status_code == 401
    config = client.get("/api/auth/config")
    assert config.status_code == 200
    assert config.json()["enabled"] is False


def test_supabase_session_endpoint_sets_httponly_cookie_and_unlocks_routes(monkeypatch):
    monkeypatch.setattr(dashboard, "SUPABASE_AUTH_ENABLED", True)
    monkeypatch.setattr(dashboard, "verify_supabase_access_token", lambda token: token == "valid-test-token")
    client = TestClient(dashboard.app)

    response = client.post(
        "/api/auth/session",
        json={"access_token": "valid-test-token", "expires_in": 900},
    )
    assert response.status_code == 200
    assert "httponly" in response.headers["set-cookie"].lower()
    assert dashboard.SUPABASE_SESSION_COOKIE in response.headers["set-cookie"]
    assert client.get("/").status_code == 200


def test_supabase_session_endpoint_rejects_invalid_access_token(monkeypatch):
    monkeypatch.setattr(dashboard, "SUPABASE_AUTH_ENABLED", True)
    monkeypatch.setattr(dashboard, "verify_supabase_access_token", lambda _token: False)
    client = TestClient(dashboard.app)

    response = client.post(
        "/api/auth/session",
        json={"access_token": "invalid-test-token"},
    )
    assert response.status_code == 401
    assert dashboard.SUPABASE_SESSION_COOKIE not in response.headers.get("set-cookie", "")
