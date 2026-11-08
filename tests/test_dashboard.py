from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

import app as dashboard
from backend import HTTPBackend


class StubBackend:
    base_url = "http://127.0.0.1:7438"

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    def health(self, *, default_namespace: str) -> dict[str, Any]:
        self.calls.append(("health", default_namespace))
        return {"ok": True, "status": "ok", "mode": "http", "server_url": self.base_url, "default_namespace": default_namespace, "namespaces": []}

    def stats(self) -> dict[str, Any]:
        self.calls.append(("stats", None))
        return {"namespace_filter_supported": False, "engine": {"active_memories": 8}, "open_conflicts": 2}

    def identity_scope(self) -> dict[str, Any]:
        self.calls.append(("identity_scope", None))
        return {"namespace_inventory": [{"namespace": "tenant-a", "count": None, "mapped": False}], "identity_scope": {"identities": [], "actors": [], "spaces": [], "conversations": []}}

    def list_memories(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("list_memories", kwargs))
        return {"items": [], "total": 0, "limit": kwargs["limit"], "offset": kwargs["offset"]}

    def get_memory(self, rid: str, *, namespace: str | None = None) -> dict[str, Any]:
        self.calls.append(("get_memory", {"rid": rid, "namespace": namespace}))
        return {"rid": rid, "namespace": "row-tag"}

    def recall(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("recall", kwargs))
        return {"results": [], "fallback": None}

    def conflicts(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("conflicts", kwargs))
        return {"items": [], "count": 0}

    def triggers(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("triggers", kwargs))
        return {"items": []}

    def temporal(self, kind: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("temporal", {"kind": kind, **kwargs}))
        return {"items": []}

    def trigger_history(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("trigger_history", kwargs))
        return {"items": []}

    def think(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("think", kwargs))
        return {"ok": True}

    def forget(self, rid: str, *, namespace: str | None) -> dict[str, Any]:
        self.calls.append(("forget", {"rid": rid, "namespace": namespace}))
        return {"rid": rid, "found": True}

    def resolve_conflict(self, conflict_id: str, *, payload: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("resolve_conflict", {"id": conflict_id, "payload": payload}))
        return {"conflict_id": conflict_id, "status": "resolved"}

    def skill_search(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("skill_search", kwargs))
        return {"skills": []}

    def get_skill(self, skill_id: str) -> dict[str, Any]:
        self.calls.append(("get_skill", skill_id))
        return {"skill_id": skill_id, "body": "synthetic"}

    def record_skill_outcome(self, skill_id: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("record_skill_outcome", {"id": skill_id, **kwargs}))
        return {"ok": True}

    def trigger_action(self, trigger_id: str, action: str) -> dict[str, Any]:
        self.calls.append(("trigger_action", {"id": trigger_id, "action": action}))
        return {"ok": True}


@pytest.fixture
def stub_backend(monkeypatch: pytest.MonkeyPatch) -> StubBackend:
    backend = StubBackend()
    monkeypatch.setattr(dashboard, "HTTP_BACKEND", backend)
    monkeypatch.setattr(dashboard, "load_dashboard_settings", lambda: {})
    return backend


def test_dashboard_is_standalone_http_only_and_branded(stub_backend: StubBackend) -> None:
    client = TestClient(dashboard.app)
    response = client.get("/")
    assert response.status_code == 200
    assert "YantrikDB Dashboard" in response.text
    assert "for Hermes" not in response.text
    assert "YANTRIKDB_SERVER_URL" not in response.text
    assert 'id="brandHome"' in response.text
    assert isinstance(dashboard.HTTP_BACKEND, StubBackend)
    assert not hasattr(dashboard, "DB_PATH")
    assert not hasattr(dashboard, "connect")


def test_static_assets_and_vendor_three_module_exist() -> None:
    static = Path(dashboard.STATIC_DIR)
    for name in ("index.html", "app.js", "auth.js", "login.html", "styles.css", "vendor/three.module.min.js"):
        assert (static / name).is_file()


def test_auth_and_server_token_are_not_in_frontend_sources() -> None:
    static = Path(dashboard.STATIC_DIR)
    combined = "\n".join((static / name).read_text() for name in ("index.html", "app.js", "auth.js", "login.html"))
    assert "YANTRIKDB_TOKEN" not in combined
    assert "Authorization: Bearer" not in combined
    assert "localStorage" not in (static / "auth.js").read_text()
    assert "HttpOnly" not in combined  # cookie is set by FastAPI, not browser JavaScript
    assert "SUPABASE_PUBLISHABLE_KEY" not in (static / "app.js").read_text()


def test_default_server_and_dashboard_bind_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("YANTRIKDB_SERVER_URL", raising=False)
    monkeypatch.delenv("YANTRIKDB_TOKEN", raising=False)
    from backend import make_backend

    backend = make_backend()
    assert backend.base_url == "http://127.0.0.1:7438"
    assert backend._session.headers.get("Authorization") is None

    captured: dict[str, Any] = {}
    monkeypatch.delenv("YANTRIKDB_DASHBOARD_HOST", raising=False)
    monkeypatch.delenv("YANTRIKDB_DASHBOARD_PORT", raising=False)
    monkeypatch.setattr("uvicorn.run", lambda _app, **kwargs: captured.update(kwargs))
    dashboard.main()
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 8767


def test_dashboard_bind_environment_overrides_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}
    monkeypatch.setenv("YANTRIKDB_DASHBOARD_HOST", "0.0.0.0")
    monkeypatch.setenv("YANTRIKDB_DASHBOARD_PORT", "9000")
    monkeypatch.setattr("uvicorn.run", lambda _app, **kwargs: captured.update(kwargs))
    dashboard.main()
    assert (captured["host"], captured["port"]) == ("0.0.0.0", 9000)


def test_health_settings_and_stats_use_http_contract(stub_backend: StubBackend) -> None:
    client = TestClient(dashboard.app)
    health = client.get("/api/health").json()
    settings = client.get("/api/settings").json()
    stats = client.get("/api/stats?namespace=project-alpha").json()
    assert health["mode"] == "http"
    assert health["default_namespace"] == "default"
    assert settings["backend_mode"] == "http"
    assert settings["server_url"] == "http://127.0.0.1:7438"
    assert stats["namespace_filter_supported"] is False
    assert stats["requested_namespace"] == "project-alpha"
    assert ("stats", None) in stub_backend.calls


def test_memories_forward_generic_row_namespace_and_supported_filters(stub_backend: StubBackend) -> None:
    client = TestClient(dashboard.app)
    response = client.get("/api/memories?namespace=project-alpha&status=active&domain=research&sort=importance&limit=25&offset=5")
    assert response.status_code == 200
    call = next(args for name, args in stub_backend.calls if name == "list_memories")
    assert call == {
        "namespace": "project-alpha", "status": "active", "domain": "research", "source": "",
        "memory_type": "", "q": "", "limit": 25, "offset": 5, "sort": "importance",
    }


@pytest.mark.parametrize("namespace", ["all", "*", ""])
def test_namespace_labels_are_not_treated_as_all_aliases(namespace: str, stub_backend: StubBackend) -> None:
    client = TestClient(dashboard.app)
    response = client.get("/api/memories", params={"namespace": namespace})
    assert response.status_code == 200
    call = next(args for name, args in stub_backend.calls if name == "list_memories")
    assert call["namespace"] == namespace


def test_identity_scope_is_read_only_and_writes_are_explicitly_unsupported(stub_backend: StubBackend) -> None:
    client = TestClient(dashboard.app)
    response = client.get("/api/identity-scope")
    assert response.status_code == 200
    assert response.json()["read_only"] is True
    assert response.json()["namespace_inventory"][0]["namespace"] == "tenant-a"
    write = client.post("/api/identity-scope", json={"identity_scope": {}})
    assert write.status_code == 501
    assert "no POST /v1/identity-scope" in write.json()["detail"]


def test_unsupported_http_capabilities_are_reported_without_local_success(stub_backend: StubBackend) -> None:
    client = TestClient(dashboard.app)
    routes = (
        ("GET", "/api/conflicts/c-1"),
        ("GET", "/api/recall-feedback"),
        ("GET", "/api/entities"),
        ("GET", "/api/graph/SomeEntity"),
        ("GET", "/api/patterns"),
        ("GET", "/api/recent-skills"),
        ("GET", "/api/skill-recall/skill-1/outcomes"),
        ("GET", "/api/sessions"),
        ("POST", "/api/hygiene"),
    )
    for method, route in routes:
        response = client.request(method, route, json={} if method == "POST" else None)
        assert response.status_code == 501, (route, response.text)
        assert response.json().get("detail")


def test_trigger_history_uses_supported_trigger_type_filter(stub_backend: StubBackend) -> None:
    client = TestClient(dashboard.app)
    response = client.get("/api/triggers/history?limit=12&trigger_type=reminder")
    assert response.status_code == 200
    assert next(args for name, args in stub_backend.calls if name == "trigger_history") == {"limit": 12, "trigger_type": "reminder"}


def test_hygiene_marks_unavailable_feedback_as_unknown(stub_backend: StubBackend) -> None:
    client = TestClient(dashboard.app)
    response = client.get("/api/hygiene?namespace=project-alpha")
    assert response.status_code == 200
    payload = response.json()
    assert payload["namespace_filter_supported"] is False
    assert payload["summary"]["low_usefulness"] is None
    assert payload["low_usefulness_candidates"] is None
    assert payload["feedback"]["available"] is False


def test_namespace_scoped_think_is_not_reported_as_supported(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dashboard, "ADMIN_MODE_ENV", True)
    backend = HTTPBackend("http://server:7438")
    monkeypatch.setattr(dashboard, "HTTP_BACKEND", backend)
    client = TestClient(dashboard.app)
    response = client.post("/api/think", json={"namespace": "project-alpha"})
    assert response.status_code == 501
    assert "does not accept a namespace" in response.json()["detail"]


def test_all_namespace_think_requires_admin_and_proxies_server_result(stub_backend: StubBackend, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dashboard, "ADMIN_MODE_ENV", True)
    client = TestClient(dashboard.app)
    response = client.post("/api/think", json={"namespace": "__all__", "run_consolidation": True})
    assert response.status_code == 200
    assert response.json()["ok"] is True
    call = next(args for name, args in stub_backend.calls if name == "think")
    assert call["namespace"] == "__all__"
    assert "namespace" not in call["payload"]


def test_admin_mode_is_required_for_memory_writes(stub_backend: StubBackend, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dashboard, "ADMIN_MODE_ENV", False)
    monkeypatch.setattr(dashboard, "load_dashboard_settings", lambda: {})
    client = TestClient(dashboard.app)
    response = client.post("/api/memory/r-1/forget?namespace=project-alpha")
    assert response.status_code == 403
    assert not any(name == "forget" for name, _ in stub_backend.calls)


def test_no_local_database_fallback_when_http_backend_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dashboard, "HTTP_BACKEND", None)
    client = TestClient(dashboard.app)
    response = client.get("/api/health")
    assert response.status_code == 503
    assert "no local database fallback" in response.json()["detail"]


def test_historical_database_and_plugin_coupling_is_absent_from_runtime() -> None:
    backend_source = Path("backend.py").read_text()
    app_source = Path("app.py").read_text()
    assert "sqlite3" not in backend_source.lower()
    assert "sqlite3" not in app_source.lower()
    assert "YANTRIKDB_DB_PATH" not in app_source
    assert "HERMES_" not in app_source
    assert "import hermes" not in app_source.lower()
    assert not Path("plugin.yaml").exists()
    assert not Path("__init__.py").exists()


def test_frontend_reports_unsupported_server_capabilities() -> None:
    html = Path("static/index.html").read_text()
    js = Path("static/app.js").read_text()
    assert "not expose an all-entities index" in html
    assert "Outcome history" in js and "Not exposed" in js
    assert "history is not exposed by the YantrikDB HTTP API" in js
    assert "All namespaces" in js and "row tag, not a tenant/database name" in js


def test_screenshot_generator_uses_only_synthetic_http_fixtures() -> None:
    script = Path("scripts/generate_mock_screenshots.py").read_text().lower()
    assert "sqlite" not in script
    assert "synthetic" in script
    assert "threadinghttpserver" in script
    assert "mock-" in script
    assert "hermes" not in script


def test_package_metadata_and_environment_example_are_standalone() -> None:
    project = Path("pyproject.toml").read_text()
    env_example = Path(".env.example").read_text()
    assert 'name = "yantrikdb-dashboard"' in project
    assert "YantrikDB Dashboard" in project
    assert "YANTRIKDB_SERVER_URL=http://127.0.0.1:7438" in env_example
    assert "YANTRIKDB_DASHBOARD_HOST=127.0.0.1" in env_example
    assert "YANTRIKDB_DASHBOARD_PORT=8767" in env_example
    assert "YANTRIKDB_TOKEN=" in env_example
    assert "SUPABASE_PUBLISHABLE_KEY=" in env_example
    assert "service-role" in env_example and "secret key" in env_example


def test_launch_scripts_do_not_start_or_manage_hermes() -> None:
    scripts = "\n".join(Path(path).read_text() for path in ("scripts/start.sh", "scripts/install-launchd.sh", "scripts/uninstall-launchd.sh"))
    assert "hermes" not in scripts.lower()
    assert "app.py" in scripts
    assert "io.yantrikdb.dashboard" in scripts


def test_supabase_auth_config_is_enabled_with_public_publishable_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dashboard, "SUPABASE_AUTH_ENABLED", True)
    monkeypatch.setattr(dashboard, "SUPABASE_AUTH_CONFIGURED", True)
    client = TestClient(dashboard.app)
    response = client.get("/api/auth/config")
    assert response.status_code == 200
    assert response.json()["enabled"] is True
    assert response.json()["publishable_key"].startswith("sb_publishable_")
    assert "service_role" not in response.json()["publishable_key"]
