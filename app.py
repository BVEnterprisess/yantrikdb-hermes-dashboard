#!/usr/bin/env python3
"""Standalone YantrikDB dashboard application.

FastAPI serves the existing static dashboard and proxies data operations to a
configured YantrikDB HTTP server. This process has no embedded database mode.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

import requests
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend import DEFAULT_SERVER_URL, HTTPBackend, YantrikDBHTTPError, make_backend

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DEFAULT_NAMESPACE = os.environ.get("YANTRIKDB_DASHBOARD_NAMESPACE", "default").strip() or "default"
DEFAULT_SETTINGS_PATH = Path.home() / ".config" / "yantrikdb-dashboard" / "settings.json"
SETTINGS_PATH = Path(
    os.environ.get("YANTRIKDB_DASHBOARD_SETTINGS_PATH") or DEFAULT_SETTINGS_PATH
).expanduser()


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on", "enabled"}


ADMIN_MODE_ENV = env_bool("YANTRIKDB_DASHBOARD_ADMIN_MODE", False)

# Supabase is enforced by default (fail-closed when its publishable key has
# not yet been configured). The publishable key is public by design; a service
# role key is never read or used by this application.
SUPABASE_URL = os.environ.get(
    "SUPABASE_URL", "https://uhujussjcnoacqhavsqg.supabase.co"
).strip().rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.environ.get(
    "SUPABASE_PUBLISHABLE_KEY",
    "sb_publishable_qCDzNwEnGkhfCkHJLbrAcQ_XRp43g_a",
).strip()
SUPABASE_AUTH_REDIRECT_URL = os.environ.get("SUPABASE_AUTH_REDIRECT_URL", "").strip()
SUPABASE_AUTH_ENABLED = bool(SUPABASE_URL)
SUPABASE_AUTH_CONFIGURED = bool(SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY)
SUPABASE_SESSION_COOKIE = "yantrikdb_supabase_access_token"
SUPABASE_AUTH_VERIFY_TIMEOUT = 8.0

# HTTP mode is mandatory. make_backend() uses http://127.0.0.1:7438 when the
# URL is unset or blank; no local SQLite fallback exists.
HTTP_BACKEND: HTTPBackend | None = make_backend()

logger = logging.getLogger("yantrikdb_dashboard")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    backend = HTTP_BACKEND
    target = backend.base_url if backend is not None else DEFAULT_SERVER_URL
    logger.info("YantrikDB Dashboard starting; configured YantrikDB server=%s", target)
    if backend is None:
        logger.error("YantrikDB connection status=unavailable; HTTP backend is not configured")
    else:
        try:
            health = backend.health(default_namespace=DEFAULT_NAMESPACE)
            if health.get("ok"):
                logger.info(
                    "YantrikDB connection status=connected server=%s upstream_status=%s",
                    target,
                    health.get("status"),
                )
            else:
                logger.warning(
                    "YantrikDB connection status=unhealthy server=%s upstream_status=%s",
                    target,
                    health.get("status"),
                )
        except YantrikDBHTTPError as exc:
            logger.error(
                "YantrikDB connection status=unavailable server=%s upstream_status=%s",
                target,
                exc.status_code,
            )
        except HTTPException as exc:
            logger.error(
                "YantrikDB connection status=unavailable server=%s detail=%s",
                target,
                exc.detail,
            )
        except Exception as exc:  # startup diagnostics must not prevent local UI access
            logger.error(
                "YantrikDB connection status=unavailable server=%s error=%s",
                target,
                exc,
            )
    yield


app = FastAPI(title="YantrikDB Dashboard", version="0.3.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


class RecallRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=10, ge=1, le=50)
    namespace: Optional[str] = None
    domain: Optional[str] = None
    source: Optional[str] = None
    include_consolidated: bool = False
    expand_entities: bool = True


class ResolveRequest(BaseModel):
    strategy: str = Field(min_length=1)
    winner_rid: Optional[str] = None
    new_text: Optional[str] = None
    resolution_note: Optional[str] = None


class ThinkRequest(BaseModel):
    run_consolidation: bool = True
    run_conflict_scan: bool = True
    run_pattern_mining: bool = False
    run_personality: bool = False
    consolidation_limit: Optional[int] = Field(default=None, ge=1, le=500)
    namespace: Optional[str] = None


class LoginRequest(BaseModel):
    password: str = Field(min_length=1)


class SupabaseSessionRequest(BaseModel):
    access_token: str = Field(min_length=1, max_length=8192)
    expires_in: int = Field(default=3600, ge=1, le=86400)


class SettingsRequest(BaseModel):
    admin_mode: Optional[bool] = None
    new_password: Optional[str] = None
    disable_password: bool = False


class SkillSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=5, ge=1, le=50)
    applies_to: Optional[str] = None
    min_score: Optional[float] = None


class SkillOutcomeRequest(BaseModel):
    success: bool
    context: str = ""


class HygieneApplyRequest(BaseModel):
    namespace: Optional[str] = None
    consolidate: bool = False
    forget_rids: list[str] = Field(default_factory=list)



def get_backend() -> HTTPBackend:
    """Return the mandatory HTTP backend; fail explicitly instead of falling back."""
    if HTTP_BACKEND is None:
        raise HTTPException(
            status_code=503,
            detail="YantrikDB HTTP backend is unavailable; standalone mode has no local database fallback.",
        )
    return HTTP_BACKEND


def now() -> float:
    return time.time()


def load_dashboard_settings() -> dict[str, Any]:
    if not SETTINGS_PATH.exists():
        return {}
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_dashboard_settings(data: dict[str, Any]) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def password_enabled(settings: dict[str, Any] | None = None) -> bool:
    settings = settings if settings is not None else load_dashboard_settings()
    return bool(settings.get("password_hash") and settings.get("password_salt") and settings.get("session_secret"))


def hash_password(password: str, salt_hex: str | None = None) -> tuple[str, str]:
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 210_000)
    return salt.hex(), digest.hex()


def verify_password(password: str, settings: dict[str, Any]) -> bool:
    if not password_enabled(settings):
        return False
    _salt, digest = hash_password(password, str(settings["password_salt"]))
    return hmac.compare_digest(digest, str(settings["password_hash"]))


def session_value(settings: dict[str, Any]) -> str:
    message = str(settings.get("password_hash", "")).encode("utf-8")
    secret = str(settings.get("session_secret", "")).encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def is_authenticated(request: Request, settings: dict[str, Any] | None = None) -> bool:
    settings = settings if settings is not None else load_dashboard_settings()
    if not password_enabled(settings):
        return True
    return hmac.compare_digest(request.cookies.get("yantrikdb_dashboard_session", ""), session_value(settings))


def admin_mode_enabled() -> bool:
    return bool(ADMIN_MODE_ENV or load_dashboard_settings().get("admin_mode"))


def require_admin(_request: Request | None = None) -> None:
    if not admin_mode_enabled():
        raise HTTPException(
            status_code=403,
            detail="Admin mode is disabled. Enable it in Settings or set YANTRIKDB_DASHBOARD_ADMIN_MODE=true.",
        )


def verify_supabase_access_token(access_token: str) -> bool | None:
    """Validate an access token against Supabase Auth.

    True/False means valid/invalid; None means the Auth service could not be
    reached. Missing local configuration is a rejection, not an auth bypass.
    """
    if not SUPABASE_AUTH_ENABLED or not access_token or not SUPABASE_AUTH_CONFIGURED:
        return False
    try:
        response = requests.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={
                "apikey": SUPABASE_PUBLISHABLE_KEY,
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
            },
            timeout=SUPABASE_AUTH_VERIFY_TIMEOUT,
        )
    except requests.RequestException:
        return None
    if response.status_code != 200:
        return False
    try:
        user = response.json()
    except ValueError:
        return False
    return isinstance(user, dict) and bool(user.get("id"))


@app.middleware("http")
async def password_gate(request: Request, call_next):
    path = request.url.path
    public_paths = {
        "/healthz",
        "/login",
        "/api/auth/config",
        "/api/auth/session",
    }
    is_public = path in public_paths or path.startswith("/static/")

    if SUPABASE_AUTH_ENABLED and not is_public:
        access_token = request.cookies.get(SUPABASE_SESSION_COOKIE, "")
        if not access_token:
            if path.startswith("/api/"):
                response = JSONResponse(status_code=401, content={"detail": "Supabase authentication required"})
                response.headers["X-Dashboard-Auth"] = "required"
                return response
            return RedirectResponse(url="/login", status_code=303)
        valid = verify_supabase_access_token(access_token)
        if valid is None:
            return JSONResponse(status_code=503, content={"detail": "Supabase Auth is temporarily unavailable"})
        if not valid:
            if path.startswith("/api/"):
                response = JSONResponse(status_code=401, content={"detail": "Supabase session expired; sign in again"})
                response.headers["X-Dashboard-Auth"] = "required"
                return response
            return RedirectResponse(url="/login", status_code=303)
        request.state.supabase_authenticated = True
    elif path.startswith("/api/") and not path.startswith("/api/auth/"):
        settings = load_dashboard_settings()
        if password_enabled(settings) and not is_authenticated(request, settings):
            return JSONResponse(status_code=401, content={"detail": "Dashboard password required"})
    return await call_next(request)


@app.exception_handler(YantrikDBHTTPError)
async def yantrikdb_error_handler(_request: Request, exc: YantrikDBHTTPError) -> JSONResponse:
    """Pass the YantrikDB status and JSON error envelope through unchanged."""
    payload = exc.payload
    if not isinstance(payload, (dict, list, str, int, float, bool)) and payload is not None:
        payload = {"detail": str(payload)}
    if payload is None:
        payload = {}
    return JSONResponse(status_code=exc.status_code, content=payload)


@app.get("/healthz")
def process_health() -> dict[str, Any]:
    """Unauthenticated process liveness check; backend health is `/api/health`."""
    backend = get_backend()
    return {"ok": True, "service": "yantrikdb-dashboard", "mode": "http", "server_url": backend.base_url}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/login")
def login_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "login.html")


@app.get("/api/auth/config")
def supabase_auth_config() -> dict[str, Any]:
    return {
        "enabled": SUPABASE_AUTH_ENABLED and SUPABASE_AUTH_CONFIGURED,
        "url": SUPABASE_URL if SUPABASE_AUTH_ENABLED else "",
        "publishable_key": SUPABASE_PUBLISHABLE_KEY if SUPABASE_AUTH_ENABLED else "",
        "redirect_url": SUPABASE_AUTH_REDIRECT_URL or None,
    }


@app.post("/api/auth/session")
def create_supabase_session(req: SupabaseSessionRequest, request: Request) -> Response:
    valid = verify_supabase_access_token(req.access_token)
    if valid is None:
        raise HTTPException(status_code=503, detail="Supabase Auth is temporarily unavailable")
    if not valid:
        raise HTTPException(status_code=401, detail="Supabase access token is invalid or expired")
    response = JSONResponse({"ok": True, "authenticated": True})
    response.set_cookie(
        SUPABASE_SESSION_COOKIE,
        req.access_token,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        max_age=min(req.expires_in, 3600),
        path="/",
    )
    return response


@app.delete("/api/auth/session")
def delete_supabase_session(request: Request) -> Response:
    response = JSONResponse({"ok": True})
    response.delete_cookie(
        SUPABASE_SESSION_COOKIE,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        path="/",
    )
    return response


@app.get("/api/auth/status")
def auth_status(request: Request) -> dict[str, Any]:
    settings = load_dashboard_settings()
    return {
        "password_required": password_enabled(settings),
        "authenticated": is_authenticated(request, settings),
        "supabase_auth_enabled": SUPABASE_AUTH_ENABLED,
        "supabase_auth_configured": SUPABASE_AUTH_CONFIGURED,
    }


@app.post("/api/auth/login")
def auth_login(req: LoginRequest) -> Response:
    if SUPABASE_AUTH_ENABLED:
        raise HTTPException(status_code=409, detail="Use Supabase Auth to sign in")
    settings = load_dashboard_settings()
    if not password_enabled(settings):
        return JSONResponse({"ok": True, "password_required": False})
    if not verify_password(req.password, settings):
        raise HTTPException(status_code=403, detail="Invalid dashboard password")
    response = JSONResponse({"ok": True, "password_required": True, "authenticated": True})
    response.set_cookie(
        "yantrikdb_dashboard_session",
        session_value(settings),
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
        path="/",
    )
    return response


@app.post("/api/auth/logout")
def auth_logout() -> Response:
    response = JSONResponse({"ok": True})
    response.delete_cookie("yantrikdb_dashboard_session", path="/")
    return response


@app.get("/api/health")
def health() -> dict[str, Any]:
    return get_backend().health(default_namespace=DEFAULT_NAMESPACE)


@app.get("/api/identity-scope")
def get_identity_scope() -> dict[str, Any]:
    payload = get_backend().identity_scope()
    return {
        **payload,
        "default_namespace": DEFAULT_NAMESPACE,
        "read_only": True,
        "write_supported": False,
    }


@app.post("/api/identity-scope")
def update_identity_scope(_body: dict[str, Any]) -> None:
    raise HTTPException(
        status_code=501,
        detail=(
            "Identity-scope editing is not available over YantrikDB HTTP: the server exposes "
            "GET /v1/identity-scope but no POST /v1/identity-scope operation."
        ),
    )


@app.get("/api/settings")
def get_settings(request: Request) -> dict[str, Any]:
    stored = load_dashboard_settings()
    backend = get_backend()
    return {
        "admin_mode": admin_mode_enabled(),
        "admin_mode_env": ADMIN_MODE_ENV,
        "admin_mode_stored": bool(stored.get("admin_mode")),
        "supabase_auth_enabled": SUPABASE_AUTH_ENABLED,
        "supabase_auth_configured": SUPABASE_AUTH_CONFIGURED,
        "password_enabled": password_enabled(stored),
        "authenticated": is_authenticated(request, stored),
        "backend_mode": "http",
        "server_url": backend.base_url,
        "default_namespace": DEFAULT_NAMESPACE,
    }


@app.post("/api/settings")
def update_settings(req: SettingsRequest, request: Request) -> Response:
    data = load_dashboard_settings()
    if req.admin_mode is not None:
        data["admin_mode"] = bool(req.admin_mode)
    clear_cookie = False
    if req.disable_password:
        data.pop("password_hash", None)
        data.pop("password_salt", None)
        data.pop("session_secret", None)
        clear_cookie = True
    elif req.new_password is not None and req.new_password.strip():
        salt, digest = hash_password(req.new_password.strip())
        data["password_salt"] = salt
        data["password_hash"] = digest
        data["session_secret"] = secrets.token_hex(32)
        clear_cookie = True
    data["updated_at"] = now()
    save_dashboard_settings(data)
    response = JSONResponse(get_settings(request))
    if clear_cookie:
        response.delete_cookie("yantrikdb_dashboard_session", path="/")
    return response


@app.get("/api/stats")
def stats(namespace: str | None = None) -> dict[str, Any]:
    # /v1/stats is database-wide. Retain the requested scope only as context;
    # do not claim that server-wide counts are filtered by a row namespace.
    payload = get_backend().stats()
    return {**payload, "requested_namespace": namespace}


@app.get("/api/memories")
def memories(
    namespace: str = Query(DEFAULT_NAMESPACE),
    status: str = "active",
    domain: str = "",
    source: str = "",
    memory_type: str = "",
    q: str = "",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    sort: str = "created_at",
) -> dict[str, Any]:
    return get_backend().list_memories(
        namespace=namespace,
        status=status,
        domain=domain,
        source=source,
        memory_type=memory_type,
        q=q,
        limit=limit,
        offset=offset,
        sort=sort,
    )


@app.get("/api/memory/{rid}")
def memory_detail(rid: str, namespace: str = Query(DEFAULT_NAMESPACE)) -> dict[str, Any]:
    return get_backend().get_memory(rid, namespace=namespace)


@app.post("/api/recall")
def recall(req: RecallRequest) -> dict[str, Any]:
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="query required")
    return get_backend().recall(
        query=req.query,
        top_k=max(1, min(req.top_k, 50)),
        namespace=req.namespace if req.namespace is not None else DEFAULT_NAMESPACE,
        domain=req.domain,
        source=req.source,
        include_consolidated=req.include_consolidated,
        expand_entities=req.expand_entities,
    )


@app.get("/api/conflicts")
def conflicts(
    namespace: str = Query(DEFAULT_NAMESPACE),
    status: str = "",
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    return get_backend().conflicts(namespace=namespace, status=status, limit=limit)


@app.get("/api/conflicts/{conflict_id}")
def conflict_detail(conflict_id: str) -> None:
    raise HTTPException(
        status_code=501,
        detail=(
            "YantrikDB exposes GET /v1/conflicts for listing but no GET /v1/conflicts/{id} "
            "detail route. Select a conflict from the list to review the returned record."
        ),
    )


@app.post("/api/conflicts/{conflict_id}/resolve")
def resolve_conflict(conflict_id: str, req: ResolveRequest, request: Request) -> dict[str, Any]:
    require_admin(request)
    return get_backend().resolve_conflict(conflict_id, payload=req.model_dump(exclude_none=True))


@app.post("/api/think")
def run_think(req: ThinkRequest, request: Request) -> dict[str, Any]:
    require_admin(request)
    payload = req.model_dump(exclude={"namespace"}, exclude_none=True)
    return get_backend().think(payload=payload, namespace=req.namespace)


@app.post("/api/memory/{rid}/forget")
def forget_memory(rid: str, request: Request, namespace: str = Query(DEFAULT_NAMESPACE)) -> dict[str, Any]:
    require_admin(request)
    return get_backend().forget(rid, namespace=namespace)


@app.get("/api/recall-feedback")
def recall_feedback(_limit: int = Query(50, ge=1, le=200)) -> None:
    raise HTTPException(
        status_code=501,
        detail=(
            "Recall-feedback history is not exposed by the YantrikDB HTTP API; "
            "the dashboard will not synthesize a local feedback ledger."
        ),
    )


@app.get("/api/hygiene")
def hygiene_scan(namespace: str = Query(DEFAULT_NAMESPACE)) -> dict[str, Any]:
    backend = get_backend()
    stats_payload = backend.stats()
    conflict_payload = backend.conflicts(namespace=namespace, status="open", limit=50)
    conflict_items = conflict_payload.get("items") if isinstance(conflict_payload.get("items"), list) else []
    engine_stats = stats_payload.get("engine") or {}
    count = conflict_payload.get("count")
    if count is None:
        count = len(conflict_items)
    return {
        "namespace": namespace,
        "namespace_filter_supported": False,
        "summary": {
            "active_memories": engine_stats.get("active_memories"),
            "consolidated_memories": engine_stats.get("consolidated_memories"),
            "tombstoned_memories": engine_stats.get("tombstoned_memories"),
            "open_conflicts": count,
            "low_usefulness": None,
        },
        "engine": engine_stats,
        "open_conflicts": conflict_items,
        "low_usefulness_candidates": None,
        "feedback": {
            "available": False,
            "reason": "YantrikDB HTTP does not expose read-only recall-feedback history.",
        },
        "recommended_actions": [
            "Review the conflict records returned by YantrikDB." if conflict_items else "No open conflicts were returned by YantrikDB.",
            "Low-usefulness recall analysis is unavailable because the server has no feedback-history endpoint.",
        ],
    }


@app.post("/api/hygiene")
def hygiene_apply(_req: HygieneApplyRequest, _request: Request) -> None:
    raise HTTPException(
        status_code=501,
        detail=(
            "Combined hygiene writes have no atomic YantrikDB server endpoint. Use the supported "
            "POST /v1/think and POST /v1/forget dashboard actions separately; each server result "
            "is returned directly."
        ),
    )


def _metadata_entities(memory: dict[str, Any]) -> list[str]:
    metadata = memory.get("metadata_json") or memory.get("metadata") or {}
    if not isinstance(metadata, dict):
        return []
    raw = metadata.get("entities") or []
    if not isinstance(raw, list):
        return []
    names: list[str] = []
    for item in raw:
        if isinstance(item, str) and item.strip():
            names.append(item.strip())
        elif isinstance(item, dict):
            name = item.get("name") or item.get("entity") or item.get("entity_name")
            if isinstance(name, str) and name.strip():
                names.append(name.strip())
    return list(dict.fromkeys(names))


def _visualiser_memories(namespace: str, limit: int) -> list[dict[str, Any]]:
    backend = get_backend()
    items: list[dict[str, Any]] = []
    offset = 0
    while len(items) < limit:
        page_limit = min(200, limit - len(items))
        response = backend.list_memories(
            namespace=namespace,
            status="active",
            limit=page_limit,
            offset=offset,
            sort="importance",
        )
        page = response.get("items")
        if not isinstance(page, list):
            raise HTTPException(502, detail="YantrikDB `/v1/memories` did not return an `items` array")
        items.extend(row for row in page if isinstance(row, dict))
        if len(page) < page_limit:
            break
        offset += len(page)
    return items[:limit]


@app.get("/api/constellation")
def constellation(
    namespace: str = Query(DEFAULT_NAMESPACE),
    limit: int = Query(240, ge=1, le=600),
) -> dict[str, Any]:
    """Build a read-only visual from returned memory fields, not a fake graph.

    Domain/namespace group edges are explicitly marked as derived. Only entity
    links present in each memory's returned metadata are shown as entity links.
    """
    memories_data = _visualiser_memories(namespace, limit)
    nodes_by_id: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    groups: dict[str, int] = {}

    def add_node(node: dict[str, Any]) -> None:
        nodes_by_id.setdefault(str(node["id"]), node)

    for memory in memories_data:
        rid = str(memory.get("rid") or "")
        if not rid:
            continue
        memory_id = f"memory:{rid}"
        domain = str(memory.get("domain") or "Unclassified")
        add_node({
            "id": memory_id,
            "label": str(memory.get("text") or rid).strip()[:70],
            "kind": "memory",
            "memory_id": rid,
            "preview": str(memory.get("text") or "")[:260],
            "category": domain,
            "weight": float(memory.get("importance") or 0),
            "count": 1,
            "namespace": memory.get("namespace"),
            "health": {"state": str(memory.get("consolidation_status") or "active")},
        })
        groups[domain] = groups.get(domain, 0) + 1
        domain_id = f"domain:{domain}"
        add_node({
            "id": domain_id,
            "label": domain,
            "kind": "domain",
            "category": domain,
            "weight": 1,
            "count": groups[domain],
            "derived_from": "domain",
        })
        edges.append({
            "id": f"domain-edge:{rid}",
            "source": memory_id,
            "target": domain_id,
            "kind": "derived_tag",
            "label": "domain",
            "derived_from": "domain",
        })

        actual_namespace = str(memory.get("namespace") or "")
        if namespace == "__all__" and actual_namespace:
            namespace_id = f"namespace:{actual_namespace}"
            add_node({
                "id": namespace_id,
                "label": actual_namespace,
                "kind": "namespace",
                "category": "Namespace",
                "weight": 1,
                "count": 1,
                "derived_from": "namespace",
            })
            edges.append({
                "id": f"namespace-edge:{rid}",
                "source": namespace_id,
                "target": memory_id,
                "kind": "derived_tag",
                "label": "namespace",
                "derived_from": "namespace",
            })

        for entity in _metadata_entities(memory):
            entity_id = f"entity:{entity}"
            add_node({
                "id": entity_id,
                "label": entity,
                "kind": "entity",
                "category": "Entity",
                "weight": 1,
                "count": 1,
                "source_field": "metadata_json.entities",
            })
            edges.append({
                "id": f"entity-edge:{rid}:{quote(entity, safe='')}",
                "source": memory_id,
                "target": entity_id,
                "kind": "explicit_metadata",
                "label": "metadata entity",
                "source_field": "metadata_json.entities",
            })

    nodes = list(nodes_by_id.values())
    clusters: dict[str, int] = {}
    for node in nodes:
        label = str(node.get("category") or "Other")
        clusters[label] = clusters.get(label, 0) + 1
    return {
        "read_only": True,
        "all_namespaces": namespace == "__all__",
        "nodes": nodes,
        "edges": edges,
        "clusters": [{"label": label, "count": count} for label, count in sorted(clusters.items())],
        "derivation_notice": (
            "Domain and namespace links are derived from YantrikDB memory fields. "
            "Entity links are included only when explicitly present in returned metadata; "
            "the dashboard does not infer graph edges from memory text."
        ),
    }


@app.get("/api/entities")
def entities(_q: str = "", _limit: int = Query(50, ge=1, le=200)) -> None:
    raise HTTPException(
        status_code=501,
        detail=(
            "The YantrikDB server does not expose GET /v1/entities. GET /v1/claims requires an "
            "entity query and cannot provide the dashboard's all-entities search index."
        ),
    )


@app.get("/api/graph/{entity}")
def graph(entity: str, _namespace: str = Query(DEFAULT_NAMESPACE)) -> None:
    raise HTTPException(
        status_code=501,
        detail=(
            f"The YantrikDB server does not expose GET /v1/graph/{quote(entity, safe='')} or a graph-edge "
            "read endpoint. The existing GET /v1/claims requires an entity and is not a graph endpoint."
        ),
    )


@app.get("/api/patterns")
def patterns(_limit: int = Query(50, ge=1, le=200)) -> None:
    raise HTTPException(
        status_code=501,
        detail="The YantrikDB server has no GET /v1/patterns endpoint; pattern data is not synthesized locally.",
    )


@app.get("/api/triggers")
def triggers(limit: int = Query(50, ge=1, le=200), status: str = "") -> dict[str, Any]:
    if status and status != "pending":
        raise HTTPException(
            status_code=501,
            detail="GET /v1/triggers/history filters by trigger_type, not status. Use /api/triggers/history?trigger_type=... for server-supported history reads; /api/triggers lists pending triggers only.",
        )
    return get_backend().triggers(limit=limit)


@app.get("/api/triggers/history")
def trigger_history(
    limit: int = Query(50, ge=1, le=200),
    trigger_type: str = "",
) -> dict[str, Any]:
    return get_backend().trigger_history(limit=limit, trigger_type=trigger_type)


@app.post("/api/triggers/{trigger_id}/{action}")
def trigger_action(trigger_id: str, action: str, request: Request) -> dict[str, Any]:
    require_admin(request)
    return get_backend().trigger_action(trigger_id, action)


@app.get("/api/recent-skills")
def recent_skills(_limit: int = Query(25, ge=1, le=100)) -> None:
    raise HTTPException(
        status_code=501,
        detail="The YantrikDB HTTP API has no endpoint for recent client-side skill-surfacing history.",
    )


@app.get("/api/skill-recall/status")
def skill_recall_status() -> dict[str, Any]:
    return {
        "backend_mode": "http",
        "search_endpoint": "POST /v1/skills/search",
        "detail_endpoint": "GET /v1/skills/{skill_id}",
        "outcome_write_endpoint": "POST /v1/skills/{skill_id}/outcome",
        "outcome_history_read_supported": False,
        "recent_surfacing_history_supported": False,
    }


def normalize_skill_hit(hit: dict[str, Any]) -> dict[str, Any]:
    metadata = hit.get("metadata") or hit.get("metadata_json") or {}
    if not isinstance(metadata, dict):
        metadata = {}
    body = (hit.get("body") or hit.get("text") or hit.get("content") or "").strip()
    return {
        "rid": hit.get("rid") or hit.get("id"),
        "skill_id": hit.get("skill_id") or metadata.get("skill_id"),
        "skill_type": hit.get("skill_type") or metadata.get("skill_type"),
        "applies_to": hit.get("applies_to") or metadata.get("applies_to") or [],
        "score": hit.get("score") or hit.get("similarity"),
        "body": body,
        "metadata": metadata,
        "raw": hit,
    }


@app.post("/api/skill-recall/search")
def skill_recall_search(req: SkillSearchRequest) -> dict[str, Any]:
    response = get_backend().skill_search(query=req.query, top_k=req.top_k, applies_to=req.applies_to)
    raw_items = response.get("skills") or response.get("items") or response.get("results") or []
    items = [normalize_skill_hit(item) for item in raw_items if isinstance(item, dict)]
    if req.min_score is not None:
        items = [
            item for item in items
            if item.get("score") is not None and float(item.get("score") or 0) >= req.min_score
        ]
    return {"items": items, "total": len(items), "raw_total": response.get("total")}


@app.get("/api/skill-recall/{skill_id}")
def get_skill(skill_id: str) -> dict[str, Any]:
    return get_backend().get_skill(skill_id)


@app.post("/api/skill-recall/{skill_id}/outcome")
def record_skill_outcome(skill_id: str, req: SkillOutcomeRequest, request: Request) -> dict[str, Any]:
    require_admin(request)
    return get_backend().record_skill_outcome(skill_id, success=req.success, context=req.context)


@app.get("/api/skill-recall/{skill_id}/outcomes")
def skill_recall_outcomes(skill_id: str, _limit: int = Query(25, ge=1, le=100)) -> None:
    raise HTTPException(
        status_code=501,
        detail=(
            f"YantrikDB exposes POST /v1/skills/{quote(skill_id, safe='')}/outcome to record a result, "
            "but no GET endpoint for reading a skill's outcome history."
        ),
    )


@app.get("/api/sessions")
def sessions(_namespace: str = Query(DEFAULT_NAMESPACE), _limit: int = Query(50, ge=1, le=200)) -> None:
    raise HTTPException(
        status_code=501,
        detail="YantrikDB exposes POST /v1/sessions and DELETE /v1/sessions/{id}, but no GET /v1/sessions list endpoint.",
    )


@app.get("/api/stale")
def stale(
    namespace: str = Query(DEFAULT_NAMESPACE),
    days: float = Query(30.0, ge=0, le=3650),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    return get_backend().temporal("stale", namespace=namespace, days=days, limit=limit)


@app.get("/api/upcoming")
def upcoming(
    namespace: str = Query(DEFAULT_NAMESPACE),
    days: float = Query(7.0, ge=0, le=3650),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    return get_backend().temporal("upcoming", namespace=namespace, days=days, limit=limit)


@app.get("/api/export/memories.jsonl")
def export_memories(
    namespace: str = Query(DEFAULT_NAMESPACE),
    status: str = "active",
) -> StreamingResponse:
    """Export real `/v1/memories` pages as JSONL; no local database/export copy."""
    backend = get_backend()
    page_size = 200
    page = backend.list_memories(namespace=namespace, status=status, limit=page_size, offset=0, sort="created_at")
    items = page.get("items")
    if not isinstance(items, list):
        raise HTTPException(502, detail="YantrikDB `/v1/memories` did not return an `items` array")
    all_items = list(items)
    offset = len(items)
    while len(items) == page_size:
        page = backend.list_memories(
            namespace=namespace,
            status=status,
            limit=page_size,
            offset=offset,
            sort="created_at",
        )
        items = page.get("items")
        if not isinstance(items, list):
            raise HTTPException(502, detail="YantrikDB `/v1/memories` did not return an `items` array")
        if not items:
            break
        all_items.extend(items)
        offset += len(items)
    lines = [json.dumps(item, ensure_ascii=False) + "\n" for item in all_items]
    return StreamingResponse(
        iter(lines),
        media_type="application/x-ndjson",
        headers={"Content-Disposition": "attachment; filename=yantrikdb-memories.jsonl"},
    )


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled dashboard error for %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal dashboard error"})


def main() -> None:
    import uvicorn

    host = os.environ.get("YANTRIKDB_DASHBOARD_HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.environ.get("YANTRIKDB_DASHBOARD_PORT", "8767"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
