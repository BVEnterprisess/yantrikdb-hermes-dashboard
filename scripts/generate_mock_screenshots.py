#!/usr/bin/env python3
"""Generate public screenshots from synthetic HTTP fixtures (no database).

The fixture server implements only dashboard HTTP responses needed by the
screenshots. It does not start YantrikDB, open a local store, or read user data.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    import websocket
except ImportError as exc:  # pragma: no cover - optional local utility
    raise SystemExit("Install requirements-dev.txt to generate screenshots (websocket-client)") from exc

ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = ROOT / "static"
OUT_DIR = ROOT / "docs" / "screenshots"
TMP_DIR = Path("/tmp/yantrikdb-dashboard-screenshots")
CHROME = os.environ.get("CHROME_BIN") or shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")
DEFAULT_NAMESPACE = "default"

SAMPLES = [
    ("dashboard", "A clear dashboard should distinguish server-reported facts from derived visual groupings.", ["Dashboard", "YantrikDB"]),
    ("privacy", "The YantrikDB access token stays on the server and never enters browser storage.", ["YantrikDB", "Security"]),
    ("operations", "Health checks should report an unavailable metric instead of displaying a fabricated zero.", ["Health", "Operations"]),
    ("search", "Recall previews use skip_reinforce so a diagnostic query does not change access counters.", ["Recall", "YantrikDB"]),
    ("namespace", "A namespace filter is a memory-row tag; tenant database names are a different scope.", ["Namespace", "Memory"]),
    ("auth", "Supabase Auth validates the access token server-side and uses an HttpOnly session cookie.", ["Supabase", "Security"]),
    ("maintenance", "Database-wide maintenance should require Admin Mode and an explicit confirmation.", ["Maintenance", "YantrikDB"]),
    ("metadata", "Entity links are displayed only when the server returns explicit entity metadata.", ["Entities", "Visualiser"]),
    ("lifecycle", "Temporal reminders and stale-memory candidates come directly from YantrikDB HTTP routes.", ["Lifecycle", "YantrikDB"]),
    ("skills", "Skill search can read records and append outcomes; history reads are not exposed by this API.", ["Skills", "YantrikDB"]),
    ("conflicts", "Conflict details shown in the dashboard come from the server list response.", ["Conflicts", "Operations"]),
    ("export", "Exports contain only memory pages returned by the configured YantrikDB server.", ["Export", "Memory"]),
]


def memory_rows() -> list[dict[str, Any]]:
    now = int(time.time())
    namespaces = ["default", "personal", "team"]
    rows: list[dict[str, Any]] = []
    for index in range(48):
        domain, text, entities = SAMPLES[index % len(SAMPLES)]
        created = now - index * 3600
        rows.append({
            "rid": f"mock-{index + 1:03d}",
            "type": "semantic" if index % 4 else "episodic",
            "text": f"{text} Example {index + 1}: review the source and namespace before taking action.",
            "created_at": created,
            "created_at_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created)),
            "updated_at": None,
            "updated_at_iso": None,
            "importance": round(.55 + (index % 8) * .05, 2),
            "half_life": 604800,
            "last_access": created + 240,
            "access_count": index % 12,
            "valence": 0,
            "consolidated_into": None,
            "consolidation_status": "active",
            "storage_tier": "hot",
            "metadata_json": {"screenshot_fixture": True, "entities": entities},
            "namespace": namespaces[index % len(namespaces)],
            "certainty": round(.72 + (index % 5) * .05, 2),
            "domain": domain,
            "source": ["user", "dashboard", "system"][index % 3],
            "emotional_state": None,
            "session_id": f"mock-session-{index % 5}",
            "due_at": None,
            "temporal_kind": None,
            "tombstone_reason": None,
            "embedding_model": None,
            "embedding_bytes": None,
        })
    return rows


MEMORIES = memory_rows()
IDENTITY_SCOPE = {
    "schema_version": 1,
    "principal": {"kind": "token", "id": "screenshot-fixture", "is_admin": True},
    "effective_scope": {"namespaces": ["default"], "owners": [], "permissions": ["memory:read"], "admin": True},
    "identity_scope": {"identities": [], "actors": [], "spaces": [], "conversations": []},
    "namespace_inventory": [{
        "namespace": "default", "count": None, "mapped": False,
        "mapped_scope": None, "mapped_to": None, "mapping_type": None,
        "mapping_source": None, "derived_by_config": False,
    }],
    "summary": {"identities": 0, "actors": 0, "spaces": 0, "conversations": 0, "unmapped_namespaces": 1},
}


def filtered_memories(params: dict[str, list[str]]) -> list[dict[str, Any]]:
    namespace = params.get("namespace", [DEFAULT_NAMESPACE])[0]
    domain = params.get("domain", [""])[0]
    rows = MEMORIES
    if namespace not in {"", "__all__", "all", "*"}:
        rows = [row for row in rows if row["namespace"] == namespace]
    if domain:
        rows = [row for row in rows if row["domain"] == domain]
    sort = params.get("sort", ["created_at"])[0]
    rows = sorted(rows, key=lambda row: row.get(sort) or 0, reverse=True)
    return rows


def constellation(params: dict[str, list[str]]) -> dict[str, Any]:
    rows = filtered_memories(params)[:120]
    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    for row in rows:
        memory_id = f"memory:{row['rid']}"
        domain = row["domain"]
        nodes[memory_id] = {
            "id": memory_id, "memory_id": row["rid"], "label": row["text"][:56],
            "kind": "memory", "category": domain, "weight": row["importance"],
            "count": 1, "namespace": row["namespace"], "preview": row["text"][:200],
        }
        domain_id = f"domain:{domain}"
        nodes.setdefault(domain_id, {"id": domain_id, "label": domain, "kind": "domain", "category": domain, "weight": 1, "count": 1})
        edges.append({"id": f"derived:{row['rid']}", "source": memory_id, "target": domain_id, "kind": "derived_tag", "derived_from": "domain"})
        for entity in row["metadata_json"]["entities"]:
            entity_id = f"entity:{entity}"
            nodes.setdefault(entity_id, {"id": entity_id, "label": entity, "kind": "entity", "category": "Entity", "weight": 1, "count": 1})
            edges.append({"id": f"entity:{row['rid']}:{entity}", "source": memory_id, "target": entity_id, "kind": "explicit_metadata"})
    return {
        "read_only": True,
        "all_namespaces": params.get("namespace", [DEFAULT_NAMESPACE])[0] in {"__all__", "all", "*", ""},
        "nodes": list(nodes.values()), "edges": edges,
        "clusters": [{"label": label, "count": sum(node.get("category") == label for node in nodes.values())} for label in sorted({node.get("category", "Other") for node in nodes.values()})],
        "derivation_notice": "Synthetic screenshot fixture; links represent explicit fixture metadata or derived domain grouping.",
    }


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


class FixtureHandler(BaseHTTPRequestHandler):
    server_version = "YantrikDBDashboardScreenshotFixture/1.0"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)
        if path == "/":
            html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
            auth_tag = '<script type="module" src="/static/auth.js?v=supabase-auth-1"></script>'
            shim = '<script>window.yantrikdbAuthReady=Promise.resolve();window.yantrikdbAuth={signOut:async()=>{}};</script>'
            body = html.replace(auth_tag, shim).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            return
        if path == "/healthz":
            json_response(self, 200, {"ok": True, "service": "yantrikdb-dashboard-screenshot-fixture"}); return
        if path.startswith("/static/"):
            relative = urllib.parse.unquote(path.removeprefix("/static/"))
            file_path = (STATIC_DIR / relative).resolve()
            if STATIC_DIR.resolve() not in file_path.parents or not file_path.is_file():
                json_response(self, 404, {"detail": "static file not found"}); return
            body = file_path.read_bytes(); content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
            self.send_response(200); self.send_header("Content-Type", content_type); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        if path == "/api/health":
            json_response(self, 200, {"ok": True, "status": "ok", "mode": "http", "server_url": "http://127.0.0.1:7438", "default_namespace": DEFAULT_NAMESPACE, "namespaces": [], "cluster": {}, "engines_loaded": 1, "capabilities": ["screenshot-fixture"]}); return
        if path == "/api/settings":
            json_response(self, 200, {"admin_mode": True, "backend_mode": "http", "server_url": "http://127.0.0.1:7438", "default_namespace": DEFAULT_NAMESPACE, "supabase_auth_enabled": True, "supabase_auth_configured": True, "authenticated": True}); return
        if path == "/api/identity-scope":
            json_response(self, 200, {**IDENTITY_SCOPE, "default_namespace": DEFAULT_NAMESPACE, "read_only": True, "write_supported": False}); return
        if path == "/api/stats":
            stats = {"active_memories": len(MEMORIES), "consolidated_memories": 0, "tombstoned_memories": 0, "open_conflicts": 1, "entities": 4, "edges": 3}
            json_response(self, 200, {"namespace": None, "namespace_filter_supported": False, "memory_status": None, "by_domain": None, "by_source": None, "by_type": None, "recent_by_day": None, "open_conflicts": 1, "entities": 4, "edges": 3, "engine": stats, "requested_namespace": params.get("namespace", [DEFAULT_NAMESPACE])[0]}); return
        if path == "/api/memories":
            rows = filtered_memories(params)
            limit = min(200, int(params.get("limit", [50])[0])); offset = int(params.get("offset", [0])[0])
            json_response(self, 200, {"items": rows[offset:offset + limit], "total": len(rows), "limit": limit, "offset": offset}); return
        if path.startswith("/api/memory/"):
            rid = urllib.parse.unquote(path.rsplit("/", 1)[-1])
            row = next((row for row in MEMORIES if row["rid"] == rid), None)
            json_response(self, 200 if row else 404, row if row else {"detail": "not found"}); return
        if path == "/api/constellation":
            json_response(self, 200, constellation(params)); return
        if path == "/api/conflicts":
            json_response(self, 200, {"items": [{"conflict_id": "mock-conflict-001", "conflict_type": "preference", "priority": "medium", "status": "open", "entity": "Dashboard", "description": "Two synthetic display preferences need operator review.", "claim_a": {"rid": "mock-001", "text": "Use compact cards"}, "claim_b": {"rid": "mock-002", "text": "Use spacious cards"}}], "total": 1}); return
        if path == "/api/stale":
            json_response(self, 200, {"items": MEMORIES[3:7], "total": 4}); return
        if path == "/api/upcoming":
            json_response(self, 200, {"items": [], "total": 0}); return
        if path == "/api/patterns":
            json_response(self, 501, {"detail": "YantrikDB HTTP does not expose a patterns read route."}); return
        if path == "/api/triggers":
            json_response(self, 200, {"items": [], "total": 0}); return
        if path == "/api/hygiene":
            json_response(self, 200, {"namespace_filter_supported": False, "summary": {"active_memories": len(MEMORIES), "consolidated_memories": 0, "tombstoned_memories": 0, "open_conflicts": 1, "low_usefulness": None}, "open_conflicts": [], "low_usefulness_candidates": None, "feedback": {"available": False}}); return
        if path == "/api/skill-recall/status":
            json_response(self, 200, {"backend_mode": "http", "search_endpoint": "POST /v1/skills/search", "outcome_history_read_supported": False, "recent_surfacing_history_supported": False}); return
        if path == "/api/skill-recall/search":
            json_response(self, 200, {"items": [{"rid": "mock-skill-001", "skill_id": "review-http-contract", "skill_type": "procedural", "applies_to": ["python"], "score": 0.91, "body": "Verify every dashboard operation against the server HTTP contract."}], "total": 1}); return
        if path.startswith("/api/skill-recall/"):
            skill_id = urllib.parse.unquote(path.rsplit("/", 1)[-1])
            json_response(self, 200, {"skill_id": skill_id, "body": "Verify every dashboard operation against the server HTTP contract.", "applies_to": ["python"], "skill_type": "procedural"}); return
        if path == "/api/recent-skills":
            json_response(self, 501, {"detail": "Recent skill surfacing history is not exposed by YantrikDB HTTP."}); return
        json_response(self, 404, {"detail": f"No screenshot fixture for {path}"})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        try: payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError: payload = {}
        if parsed.path == "/api/recall":
            query = str(payload.get("query", "")).lower()
            rows = [row for row in filtered_memories({"namespace": [str(payload.get("namespace", "__all__"))]}) if query in row["text"].lower()]
            results = [{**row, "score": .91 - index * .04, "why_retrieved": ["semantic_similarity"]} for index, row in enumerate(rows[:10])]
            json_response(self, 200, {"results": results, "fallback": None}); return
        if parsed.path == "/api/settings":
            json_response(self, 200, {"admin_mode": bool(payload.get("admin_mode")), "backend_mode": "http", "server_url": "http://127.0.0.1:7438", "default_namespace": DEFAULT_NAMESPACE, "supabase_auth_enabled": True, "supabase_auth_configured": True}); return
        if parsed.path.endswith("/resolve"):
            json_response(self, 200, {"ok": True, "status": "resolved", "strategy": payload.get("strategy")}); return
        if parsed.path.startswith("/api/skill-recall/") and parsed.path.endswith("/outcome"):
            json_response(self, 200, {"ok": True, "recorded": True}); return
        if parsed.path == "/api/think":
            json_response(self, 200, {"ok": True, "message": "Synthetic server-wide maintenance response"}); return
        json_response(self, 501, {"detail": f"No screenshot fixture for {parsed.path}"})


class ChromeSession:
    def __init__(self, port: int, url: str, width: int, height: int, mobile: bool) -> None:
        self.port, self.url, self.width, self.height, self.mobile = port, url, width, height, mobile
        self.proc = None
        self.ws = None
        self.counter = 0
        self.profile = TMP_DIR / f"chrome-profile-{port}"

    def __enter__(self) -> "ChromeSession":
        if not CHROME:
            raise SystemExit("Chrome/Chromium not found; set CHROME_BIN to its executable path")
        self.profile.mkdir(parents=True, exist_ok=True)
        self.proc = subprocess.Popen([
            CHROME, "--headless=new", "--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
            "--no-first-run", "--no-default-browser-check", f"--user-data-dir={self.profile}",
            f"--remote-debugging-port={self.port}", "--remote-allow-origins=*", f"--window-size={self.width},{self.height}", self.url,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 20
        tabs: list[dict[str, Any]] = []
        while time.time() < deadline:
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json", timeout=1))
                if tabs: break
            except Exception: time.sleep(.2)
        tab = next((tab for tab in tabs if tab.get("type") == "page"), None)
        if not tab: raise RuntimeError("Chrome did not expose a page target")
        self.ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=15)
        self.call("Page.enable"); self.call("Runtime.enable")
        self.call("Emulation.setDeviceMetricsOverride", {"width": self.width, "height": self.height, "deviceScaleFactor": 2 if self.mobile else 1, "mobile": self.mobile})
        return self

    def __exit__(self, *_exc: object) -> None:
        if self.ws: self.ws.close()
        if self.proc:
            self.proc.terminate()
            try: self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired: self.proc.kill()

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.counter += 1
        self.ws.send(json.dumps({"id": self.counter, "method": method, "params": params or {}}))
        while True:
            message = json.loads(self.ws.recv())
            if message.get("id") == self.counter:
                if "error" in message: raise RuntimeError(message["error"].get("message", method))
                return message

    def evaluate(self, expression: str) -> Any:
        result = self.call("Runtime.evaluate", {"expression": expression, "awaitPromise": True, "returnByValue": True})
        value = result.get("result", {}).get("result", {})
        if value.get("subtype") == "error": raise RuntimeError(value.get("description", "browser evaluation failed"))
        return value.get("value")

    def prepare(self, view: str) -> dict[str, Any]:
        self.call("Page.navigate", {"url": f"{self.url}?view={view}"})
        self.evaluate("new Promise(resolve => { if (document.readyState === 'complete') resolve(true); else addEventListener('load', () => resolve(true), {once:true}); })")
        result = self.evaluate(f"""(async()=>{{
          for(let i=0;i<100 && typeof setView!=='function';i++) await new Promise(r=>setTimeout(r,100));
          if(typeof setView!=='function') throw new Error('dashboard JS did not initialise');
          await new Promise(r=>setTimeout(r,1200));
          setView({json.dumps(view)},{{replace:true}});
          if({json.dumps(view)}==='memories'){{ document.querySelector('#memorySearch').value='dashboard'; await loadMemories(); }}
          if({json.dumps(view)}==='recall'){{ document.querySelector('#recallQuery').value='memory scope'; await runRecall(); }}
          if({json.dumps(view)}==='visualiser') await new Promise(r=>setTimeout(r,2400));
          if({json.dumps(view)}==='identity-scope') await loadIdentityScope();
          if({json.dumps(view)}==='settings') await loadSettings();
          await new Promise(r=>setTimeout(r,500)); window.scrollTo(0,0);
          const doc=document.documentElement; return {{scrollWidth:doc.scrollWidth,clientWidth:doc.clientWidth,title:document.title}};
        }})()""")
        return result or {}

    def screenshot(self, path: Path) -> None:
        image = self.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})["result"]["data"]
        path.write_bytes(base64.b64decode(image))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def run() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    port = free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), FixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{port}/"
    shots = [
        ("desktop-overview.png", 1440, 1000, False, "overview"),
        ("desktop-visualiser.png", 1440, 1000, False, "visualiser"),
        ("desktop-memories.png", 1440, 1000, False, "memories"),
        ("desktop-identity-scope.png", 1440, 1000, False, "identity-scope"),
        ("desktop-settings.png", 1440, 1000, False, "settings"),
        ("mobile-overview.png", 390, 844, True, "overview"),
        ("mobile-memories.png", 390, 844, True, "memories"),
        ("mobile-settings.png", 390, 844, True, "settings"),
    ]
    try:
        manifest: list[dict[str, Any]] = []
        for index, (name, width, height, mobile, view) in enumerate(shots):
            with ChromeSession(9530 + index, base_url, width, height, mobile) as chrome:
                metrics = chrome.prepare(view)
                output = OUT_DIR / name
                chrome.screenshot(output)
                manifest.append({"file": name, "view": view, "viewport": f"{width}x{height}", **metrics})
                print(f"wrote {output.relative_to(ROOT)}")
        (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    run()
