"""Server-side HTTP adapter for the YantrikDB dashboard.

The dashboard is a client of a separately managed YantrikDB HTTP server. It
never opens a local YantrikDB store and never sends the server token to the
browser. The endpoint mappings here follow the YantrikDB server v0.20.0 HTTP
surface; unsupported operations are reported by the FastAPI layer as explicit
501 responses rather than being simulated locally.
"""
from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote, urlsplit

import requests
from fastapi import HTTPException

DEFAULT_SERVER_URL = "http://127.0.0.1:7438"
DEFAULT_TIMEOUT = (3.0, 15.0)  # (connect, read)

# Internal dashboard sentinel for "All namespaces" in the UI. It never
# represents a YantrikDB row tag; the HTTP layer omits it from requests.
DASHBOARD_ALL_NAMESPACES = "__all__"


class YantrikDBHTTPError(Exception):
    """An upstream YantrikDB error whose status and JSON body must be kept."""

    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self.payload = payload
        super().__init__(str(payload))


class HTTPBackend:
    """Proxy supported dashboard operations to one YantrikDB HTTP server."""

    def __init__(self, base_url: str = DEFAULT_SERVER_URL, token: str = "") -> None:
        candidate = (base_url or DEFAULT_SERVER_URL).strip().rstrip("/")
        parsed = urlsplit(candidate)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("YANTRIKDB_SERVER_URL must be an http(s) URL without credentials, query, or fragment")

        self.base_url = candidate
        self._token = token.strip()
        self._session = requests.Session()
        self._session.headers["Accept"] = "application/json"
        if self._token:
            self._session.headers["Authorization"] = f"Bearer {self._token}"

    def _redact(self, value: Any) -> Any:
        """Defend against a misconfigured upstream echoing its Bearer token."""
        if not self._token:
            return value
        if isinstance(value, str):
            return value.replace(self._token, "[redacted]")
        if isinstance(value, dict):
            return {key: self._redact(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self._redact(item) for item in value]
        return value

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        try:
            # Do not follow redirects: a dashboard token must not be sent to
            # an unexpected redirect target.
            response = self._session.request(
                method,
                url,
                params=params,
                json=json,
                timeout=DEFAULT_TIMEOUT,
                allow_redirects=False,
            )
        except requests.RequestException as exc:
            message = str(exc)
            if self._token:
                message = message.replace(self._token, "[redacted]")
            raise HTTPException(
                status_code=502,
                detail=f"YantrikDB server at {self.base_url} is unreachable: {message}",
            ) from exc

        if 300 <= response.status_code < 400:
            raise HTTPException(
                status_code=502,
                detail=f"YantrikDB server at {self.base_url} returned an unexpected redirect for {path}",
            )

        if response.status_code >= 400:
            try:
                payload = response.json()
            except ValueError:
                payload = {"detail": response.text or response.reason_phrase}
            raise YantrikDBHTTPError(response.status_code, self._redact(payload))

        if response.status_code == 204 or not response.content:
            return {}
        try:
            return self._redact(response.json())
        except ValueError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"YantrikDB server at {self.base_url} returned a non-JSON response for {path}",
            ) from exc

    @staticmethod
    def _namespace_params(namespace: str | None) -> dict[str, str]:
        if namespace is None:
            return {}
        if namespace == DASHBOARD_ALL_NAMESPACES:
            # The dashboard's internal "All namespaces" sentinel; it is not a
            # row tag and must not be sent to the server.
            return {}
        # Namespace tags are opaque user data: no other string value is
        # reserved as an alias for the dashboard's All namespaces UI.
        return {"namespace": str(namespace)}

    def health(self, *, default_namespace: str) -> dict[str, Any]:
        """Proxy `/v1/health`, without inventing version or database details."""
        body = self._request("GET", "/v1/health")
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB `/v1/health` returned an invalid JSON shape")
        cluster = body.get("cluster") if isinstance(body.get("cluster"), dict) else {}
        status = body.get("status", "unknown")
        return {
            "ok": status == "ok" and cluster.get("healthy") is not False,
            "status": status,
            "mode": "http",
            "server_url": self.base_url,
            "default_namespace": default_namespace,
            "namespaces": [],
            "cluster": cluster,
            "engines_loaded": body.get("engines_loaded"),
            "capabilities": body.get("capabilities", []),
        }

    def stats(self) -> dict[str, Any]:
        """Proxy `/v1/stats`; the endpoint is database-wide, not tag-filtered."""
        body = self._request("GET", "/v1/stats")
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB `/v1/stats` returned an invalid JSON shape")
        return {
            "namespace": None,
            "namespace_filter_supported": False,
            "memory_status": None,
            "by_domain": None,
            "by_source": None,
            "by_type": None,
            "recent_by_day": None,
            "open_conflicts": body.get("open_conflicts"),
            "entities": body.get("entities"),
            "edges": body.get("edges"),
            "engine": body,
        }

    def identity_scope(self) -> dict[str, Any]:
        """Proxy the server's read-only namespace/identity-scope inventory."""
        body = self._request("GET", "/v1/identity-scope")
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB `/v1/identity-scope` returned an invalid JSON shape")
        return body

    def list_memories(
        self,
        *,
        namespace: str | None,
        status: str = "active",
        domain: str = "",
        source: str = "",
        memory_type: str = "",
        q: str = "",
        limit: int = 50,
        offset: int = 0,
        sort: str = "created_at",
    ) -> dict[str, Any]:
        """Proxy `/v1/memories` and pass server-side validation/errors through."""
        params: dict[str, Any] = {
            "status": status,
            "limit": limit,
            "offset": offset,
            "sort": sort,
        }
        params.update(self._namespace_params(namespace))
        for key, value in (
            ("domain", domain),
            ("source", source),
            ("memory_type", memory_type),
            ("q", q),
        ):
            if value:
                params[key] = value
        body = self._request("GET", "/v1/memories", params=params)
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB `/v1/memories` returned an invalid JSON shape")
        return body

    def get_memory(self, rid: str, *, namespace: str | None = None) -> dict[str, Any]:
        params = self._namespace_params(namespace)
        body = self._request("GET", f"/v1/memory/{quote(rid, safe='')}", params=params)
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB `/v1/memory/{rid}` returned an invalid JSON shape")
        return body

    def recall(
        self,
        *,
        query: str,
        top_k: int,
        namespace: str | None,
        domain: str | None,
        source: str | None,
        include_consolidated: bool,
        expand_entities: bool,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "query": query,
            "top_k": top_k,
            "include_consolidated": include_consolidated,
            "expand_entities": expand_entities,
            # The dashboard is a diagnostic tool; this avoids changing
            # last_access/access_count while previewing retrieval results.
            "skip_reinforce": True,
        }
        payload.update(self._namespace_params(namespace))
        if domain:
            payload["domain"] = domain
        if source:
            payload["source"] = source
        body = self._request("POST", "/v1/recall", json=payload)
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB `/v1/recall` returned an invalid JSON shape")
        return body

    def conflicts(
        self,
        *,
        namespace: str | None,
        status: str = "",
        limit: int = 50,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        params.update(self._namespace_params(namespace))
        if status:
            params["status"] = status
        body = self._request("GET", "/v1/conflicts", params=params)
        if isinstance(body, list):
            return {"items": body, "total": len(body)}
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB `/v1/conflicts` returned an invalid JSON shape")
        if "items" not in body and isinstance(body.get("conflicts"), list):
            return {**body, "items": body["conflicts"]}
        return body

    def resolve_conflict(self, conflict_id: str, *, payload: dict[str, Any]) -> dict[str, Any]:
        body = self._request(
            "POST",
            f"/v1/conflicts/{quote(conflict_id, safe='')}/resolve",
            json=payload,
        )
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB conflict resolution returned an invalid JSON shape")
        return body

    def think(self, *, payload: dict[str, Any], namespace: str | None) -> dict[str, Any]:
        if namespace is not None and namespace != DASHBOARD_ALL_NAMESPACES:
            raise HTTPException(
                status_code=501,
                detail=(
                    "Namespace-scoped maintenance is unavailable: YantrikDB `POST /v1/think` "
                    "does not accept a namespace parameter. Select All namespaces to run the "
                    "server-wide maintenance operation."
                ),
            )
        body = self._request("POST", "/v1/think", json=payload)
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB `/v1/think` returned an invalid JSON shape")
        return body

    def forget(self, rid: str, *, namespace: str | None) -> dict[str, Any]:
        payload: dict[str, Any] = {"rid": rid}
        payload.update(self._namespace_params(namespace))
        body = self._request("POST", "/v1/forget", json=payload)
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB `/v1/forget` returned an invalid JSON shape")
        return body

    def temporal(self, kind: str, *, namespace: str | None, days: float, limit: int) -> dict[str, Any]:
        if kind not in {"stale", "upcoming"}:
            raise ValueError("kind must be stale or upcoming")
        params: dict[str, Any] = {"days": days, "limit": limit}
        params.update(self._namespace_params(namespace))
        body = self._request("GET", f"/v1/temporal/{kind}", params=params)
        if not isinstance(body, dict):
            raise HTTPException(502, detail=f"YantrikDB `/v1/temporal/{kind}` returned an invalid JSON shape")
        items = body.get("memories")
        if isinstance(items, list) and "items" not in body:
            return {**body, "items": items}
        return body

    def triggers(self, *, limit: int = 50) -> dict[str, Any]:
        body = self._request("GET", "/v1/triggers", params={"limit": limit})
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB `/v1/triggers` returned an invalid JSON shape")
        triggers = body.get("triggers")
        if isinstance(triggers, list) and "items" not in body:
            return {**body, "items": triggers}
        return body

    def trigger_history(self, *, limit: int = 50, trigger_type: str = "") -> dict[str, Any]:
        """Proxy the server's node-local trigger history read route."""
        params: dict[str, Any] = {"limit": limit}
        if trigger_type:
            params["trigger_type"] = trigger_type
        body = self._request("GET", "/v1/triggers/history", params=params)
        if isinstance(body, list):
            return {"items": body, "count": len(body)}
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB `/v1/triggers/history` returned an invalid JSON shape")
        triggers = body.get("triggers")
        if isinstance(triggers, list) and "items" not in body:
            return {**body, "items": triggers}
        return body

    def trigger_action(self, trigger_id: str, action: str) -> dict[str, Any]:
        if action not in {"acknowledge", "deliver", "act", "dismiss"}:
            raise HTTPException(400, detail="action must be acknowledge, deliver, act, or dismiss")
        body = self._request(
            "POST",
            f"/v1/triggers/{quote(trigger_id, safe='')}/{action}",
            json={},
        )
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB trigger action returned an invalid JSON shape")
        return body

    def skill_search(self, *, query: str, top_k: int, applies_to: str | None) -> dict[str, Any]:
        payload: dict[str, Any] = {"query": query, "top_k": top_k}
        if applies_to:
            # The server contract accepts an array, while the dashboard input
            # is a single tag.
            payload["applies_to"] = [applies_to]
        body = self._request("POST", "/v1/skills/search", json=payload)
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB `/v1/skills/search` returned an invalid JSON shape")
        return body

    def get_skill(self, skill_id: str) -> dict[str, Any]:
        body = self._request("GET", f"/v1/skills/{quote(skill_id, safe='')}")
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB `/v1/skills/{skill_id}` returned an invalid JSON shape")
        return body

    def record_skill_outcome(self, skill_id: str, *, success: bool, context: str = "") -> dict[str, Any]:
        body = self._request(
            "POST",
            f"/v1/skills/{quote(skill_id, safe='')}/outcome",
            json={"success": success, "context": context},
        )
        if not isinstance(body, dict):
            raise HTTPException(502, detail="YantrikDB skill outcome write returned an invalid JSON shape")
        return body


def make_backend() -> HTTPBackend:
    """Build the required HTTP backend; blank/unset URL uses localhost:7438."""
    url = os.environ.get("YANTRIKDB_SERVER_URL", DEFAULT_SERVER_URL).strip() or DEFAULT_SERVER_URL
    token = os.environ.get("YANTRIKDB_TOKEN", "")
    return HTTPBackend(url, token)
