from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
import requests
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app as dashboard
from backend import DEFAULT_SERVER_URL, HTTPBackend, YantrikDBHTTPError, make_backend


class FakeResponse:
    def __init__(self, status_code: int = 200, body: Any = None, text: str = "") -> None:
        self.status_code = status_code
        self._body = body
        self.text = text or (str(body) if body is not None else "")
        self.reason_phrase = "upstream error"
        self.content = b"" if status_code == 204 else (b"{}" if body is None else b"body")

    def json(self) -> Any:
        if self._body is _NO_JSON:
            raise ValueError("not json")
        return self._body


_NO_JSON = object()


def install_response(backend: HTTPBackend, response: FakeResponse) -> MagicMock:
    request = MagicMock(return_value=response)
    backend._session.request = request
    return request


def test_make_backend_uses_http_default_and_server_side_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("YANTRIKDB_SERVER_URL", raising=False)
    monkeypatch.setenv("YANTRIKDB_TOKEN", "server-secret")
    backend = make_backend()
    assert isinstance(backend, HTTPBackend)
    assert backend.base_url == DEFAULT_SERVER_URL == "http://127.0.0.1:7438"
    assert backend._session.headers["Authorization"] == "Bearer server-secret"


def test_make_backend_uses_configured_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("YANTRIKDB_SERVER_URL", "https://db.example.test:7438/")
    monkeypatch.delenv("YANTRIKDB_TOKEN", raising=False)
    backend = make_backend()
    assert backend.base_url == "https://db.example.test:7438"
    assert "Authorization" not in backend._session.headers


@pytest.mark.parametrize("url", [
    "file:///tmp/data", "http://user:pass@example.test", "http://example.test/path?query=1",
    "http://example.test/#fragment", "not a url", "//example.test:7438",
])
def test_backend_rejects_unsafe_or_invalid_base_urls(url: str) -> None:
    with pytest.raises(ValueError, match="YANTRIKDB_SERVER_URL"):
        HTTPBackend(url)


def test_request_uses_bearer_session_and_disables_redirects(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438", "token-123")
    request = install_response(backend, FakeResponse(body={"status": "ok"}))
    assert backend.health(default_namespace="default")["ok"] is True
    args, kwargs = request.call_args
    assert args[:2] == ("GET", "http://server:7438/v1/health")
    assert kwargs["allow_redirects"] is False
    assert kwargs["timeout"] == (3.0, 15.0)
    assert backend._session.headers["Authorization"] == "Bearer token-123"


def test_upstream_json_error_status_and_body_are_preserved(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    payload = {"error": {"code": "INVALID_QUERY_PARAMETER", "message": "source filter unsupported"}}
    install_response(backend, FakeResponse(400, payload))
    with pytest.raises(YantrikDBHTTPError) as exc:
        backend.list_memories(namespace="default", source="user")
    assert exc.value.status_code == 400
    assert exc.value.payload == payload


def test_upstream_non_json_error_is_retained_as_detail(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    install_response(backend, FakeResponse(502, _NO_JSON, "bad gateway"))
    with pytest.raises(YantrikDBHTTPError) as exc:
        backend.health(default_namespace="default")
    assert exc.value.status_code == 502
    assert exc.value.payload == {"detail": "bad gateway"}


def test_redirect_is_rejected_without_following(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438", "secret")
    request = install_response(backend, FakeResponse(302, {"location": "http://evil.test"}))
    with pytest.raises(HTTPException) as exc:
        backend.health(default_namespace="default")
    assert exc.value.status_code == 502
    assert "unexpected redirect" in exc.value.detail
    assert request.call_args.kwargs["allow_redirects"] is False


def test_connection_failure_is_a_502_and_redacts_token(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438", "secret-token")
    request = MagicMock(side_effect=requests.ConnectionError("failed secret-token"))
    backend._session.request = request
    with pytest.raises(HTTPException) as exc:
        backend.health(default_namespace="default")
    assert exc.value.status_code == 502
    assert "unreachable" in exc.value.detail
    assert "secret-token" not in exc.value.detail


def test_response_token_echo_is_redacted(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438", "secret-token")
    install_response(backend, FakeResponse(401, {"detail": "echo secret-token", "nested": ["secret-token"]}))
    with pytest.raises(YantrikDBHTTPError) as exc:
        backend.list_memories(namespace="default")
    assert exc.value.payload == {"detail": "echo [redacted]", "nested": ["[redacted]"]}


def test_successful_response_must_be_json(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    install_response(backend, FakeResponse(200, _NO_JSON, "plain text"))
    with pytest.raises(HTTPException) as exc:
        backend.health(default_namespace="default")
    assert exc.value.status_code == 502
    assert "non-JSON response" in exc.value.detail


def test_health_adapts_only_fields_present_in_server_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    install_response(backend, FakeResponse(body={
        "status": "ok", "engines_loaded": 3, "capabilities": ["idempotency_key"],
        "cluster": {"healthy": True, "leader": 4, "role": "Leader"},
    }))
    result = backend.health(default_namespace="my-default")
    assert result["ok"] is True
    assert result["mode"] == "http"
    assert result["default_namespace"] == "my-default"
    assert result["server_url"] == "http://server:7438"
    assert result["cluster"]["role"] == "Leader"
    assert result["engines_loaded"] == 3
    assert result["capabilities"] == ["idempotency_key"]
    assert result["namespaces"] == []  # health does not claim a row-tag inventory


def test_stats_is_database_wide_and_does_not_send_namespace(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    request = install_response(backend, FakeResponse(body={"active_memories": 13, "open_conflicts": 2, "entities": 4, "edges": 5}))
    result = backend.stats()
    assert result["namespace_filter_supported"] is False
    assert result["engine"]["active_memories"] == 13
    assert result["open_conflicts"] == 2
    assert request.call_args.args[0:2] == ("GET", "http://server:7438/v1/stats")
    assert request.call_args.kwargs["params"] is None


def test_identity_scope_is_passed_through_read_only(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    payload = {"effective_scope": {"namespaces": ["tenant-a"]}, "namespace_inventory": [{"namespace": "tenant-a", "count": None, "mapped": False}]}
    request = install_response(backend, FakeResponse(body=payload))
    assert backend.identity_scope() == payload
    assert request.call_args.args[0:2] == ("GET", "http://server:7438/v1/identity-scope")


def test_namespace_filter_uses_opaque_row_tags_and_only_omits_dashboard_sentinel(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    for tag in ("project-alpha", "all", "*", "", "__ALL__"):
        request = install_response(backend, FakeResponse(body={"items": [], "total": 0, "limit": 50, "offset": 0}))
        backend.list_memories(namespace=tag)
        assert request.call_args.kwargs["params"]["namespace"] == tag

    for sentinel in ("__all__", None):
        request = install_response(backend, FakeResponse(body={"items": [], "total": 0, "limit": 50, "offset": 0}))
        backend.list_memories(namespace=sentinel)
        assert "namespace" not in request.call_args.kwargs["params"]


def test_memory_list_uses_supported_v020_query_parameters(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    request = install_response(backend, FakeResponse(body={"items": [], "total": 0, "limit": 25, "offset": 5}))
    backend.list_memories(namespace="project-alpha", domain="work", memory_type="semantic", limit=25, offset=5, sort="importance")
    params = request.call_args.kwargs["params"]
    assert params == {"status": "active", "limit": 25, "offset": 5, "sort": "importance", "namespace": "project-alpha", "domain": "work", "memory_type": "semantic"}
    assert "q" not in params and "source" not in params


def test_memory_list_does_not_hide_server_400_for_unsupported_filters(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    request = install_response(backend, FakeResponse(400, {"error": "source filter is not implemented"}))
    with pytest.raises(YantrikDBHTTPError) as exc:
        backend.list_memories(namespace="default", source="user")
    assert exc.value.status_code == 400
    assert "source filter" in exc.value.payload["error"]
    assert request.call_args.kwargs["params"]["source"] == "user"


def test_memory_detail_quotes_rid_and_keeps_generic_namespace(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    request = install_response(backend, FakeResponse(body={"rid": "a/b?c", "namespace": "project-alpha"}))
    result = backend.get_memory("a/b?c", namespace="project-alpha")
    assert result["rid"] == "a/b?c"
    assert request.call_args.args[1] == "http://server:7438/v1/memory/a%2Fb%3Fc"
    assert request.call_args.kwargs["params"] == {"namespace": "project-alpha"}


def test_recall_payload_uses_supported_v020_fields_and_skips_reinforcement(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    request = install_response(backend, FakeResponse(body={"results": []}))
    backend.recall(
        query="dashboard", top_k=12, namespace="project-alpha", domain="ops", source="user",
        include_consolidated=True, expand_entities=True,
    )
    assert request.call_args.args[0:2] == ("POST", "http://server:7438/v1/recall")
    assert request.call_args.kwargs["json"] == {
        "query": "dashboard", "top_k": 12, "include_consolidated": True,
        "expand_entities": True, "skip_reinforce": True,
        "namespace": "project-alpha", "domain": "ops", "source": "user",
    }


def test_conflict_list_and_resolve_follow_v020_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    list_request = install_response(backend, FakeResponse(body={"conflicts": [{"conflict_id": "c1"}], "count": 1}))
    result = backend.conflicts(namespace="project-alpha", status="open", limit=15)
    assert result["items"] == [{"conflict_id": "c1"}]
    assert list_request.call_args.args[1] == "http://server:7438/v1/conflicts"
    assert list_request.call_args.kwargs["params"] == {"limit": 15, "namespace": "project-alpha", "status": "open"}

    resolve_request = install_response(backend, FakeResponse(body={"status": "resolved"}))
    backend.resolve_conflict("c/1", payload={"strategy": "dismiss", "resolution_note": "reviewed"})
    assert resolve_request.call_args.args[1] == "http://server:7438/v1/conflicts/c%2F1/resolve"
    assert resolve_request.call_args.kwargs["json"] == {"strategy": "dismiss", "resolution_note": "reviewed"}


def test_think_is_server_wide_and_refuses_specific_row_namespace(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    request = install_response(backend, FakeResponse(body={"ok": True}))
    result = backend.think(payload={"run_consolidation": True}, namespace="__all__")
    assert result["ok"] is True
    assert request.call_args.args[0:2] == ("POST", "http://server:7438/v1/think")
    assert request.call_args.kwargs["json"] == {"run_consolidation": True}
    for namespace in ("project-alpha", "all", "*", ""):
        with pytest.raises(HTTPException) as exc:
            backend.think(payload={}, namespace=namespace)
        assert exc.value.status_code == 501
        assert "does not accept a namespace" in exc.value.detail
    assert request.call_count == 1


def test_forget_posts_rid_and_row_namespace_to_v020_route(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    request = install_response(backend, FakeResponse(body={"rid": "r1", "found": True}))
    backend.forget("r1", namespace="project-alpha")
    assert request.call_args.args[0:2] == ("POST", "http://server:7438/v1/forget")
    assert request.call_args.kwargs["json"] == {"rid": "r1", "namespace": "project-alpha"}


def test_temporal_routes_normalize_memories_list(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    request = install_response(backend, FakeResponse(body={"memories": [{"rid": "r1"}], "count": 1}))
    result = backend.temporal("stale", namespace="personal", days=30, limit=20)
    assert result["items"] == [{"rid": "r1"}]
    assert request.call_args.args[1] == "http://server:7438/v1/temporal/stale"
    assert request.call_args.kwargs["params"] == {"days": 30, "limit": 20, "namespace": "personal"}


def test_trigger_routes_and_action_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    request = install_response(backend, FakeResponse(body={"triggers": [{"id": "t1"}]}))
    assert backend.triggers(limit=12)["items"] == [{"id": "t1"}]
    assert request.call_args.args[1] == "http://server:7438/v1/triggers"
    assert request.call_args.kwargs["params"] == {"limit": 12}
    history_request = install_response(backend, FakeResponse(body={"triggers": [{"id": "t2"}]}))
    assert backend.trigger_history(limit=14, trigger_type="reminder")["items"] == [{"id": "t2"}]
    assert history_request.call_args.args[1] == "http://server:7438/v1/triggers/history"
    assert history_request.call_args.kwargs["params"] == {"limit": 14, "trigger_type": "reminder"}
    action_request = install_response(backend, FakeResponse(body={"ok": True}))
    backend.trigger_action("t/1", "acknowledge")
    assert action_request.call_args.args[1] == "http://server:7438/v1/triggers/t%2F1/acknowledge"
    with pytest.raises(HTTPException) as exc:
        backend.trigger_action("t1", "invented")
    assert exc.value.status_code == 400


def test_skill_search_detail_and_outcome_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    search_request = install_response(backend, FakeResponse(body={"results": []}))
    backend.skill_search(query="review", top_k=8, applies_to="python")
    assert search_request.call_args.args[1] == "http://server:7438/v1/skills/search"
    assert search_request.call_args.kwargs["json"] == {"query": "review", "top_k": 8, "applies_to": ["python"]}
    detail_request = install_response(backend, FakeResponse(body={"skill_id": "review-contract", "body": "text"}))
    backend.get_skill("review/contract")
    assert detail_request.call_args.args[1] == "http://server:7438/v1/skills/review%2Fcontract"
    outcome_request = install_response(backend, FakeResponse(body={"ok": True}))
    backend.record_skill_outcome("review-contract", success=False, context="fixture")
    assert outcome_request.call_args.args[1] == "http://server:7438/v1/skills/review-contract/outcome"
    assert outcome_request.call_args.kwargs["json"] == {"success": False, "context": "fixture"}


def test_app_error_handler_preserves_upstream_status_and_error_envelope(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = HTTPBackend("http://server:7438")
    install_response(backend, FakeResponse(404, {"error": {"code": "NOT_FOUND", "message": "missing skill"}}))
    monkeypatch.setattr(dashboard, "HTTP_BACKEND", backend)
    client = TestClient(dashboard.app)
    response = client.get("/api/health")
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "NOT_FOUND", "message": "missing skill"}}
