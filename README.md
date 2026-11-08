# YantrikDB Dashboard

A standalone FastAPI dashboard for a separately running YantrikDB HTTP server. The dashboard has one data provider: HTTP. It does not open a local database, install or run another agent, or depend on an external gateway/service.

The application serves a static browser UI and proxies supported requests to YantrikDB. The YantrikDB bearer token remains in the server process. Supabase Auth protects the dashboard and API routes; mutating actions also require Admin Mode and the YantrikDB server's own write permissions.

## Requirements

- Python 3.11 or newer
- A reachable YantrikDB HTTP server (default: `http://127.0.0.1:7438`)
- A Supabase project with Email sign-in enabled

The API mappings are checked against the YantrikDB server `v0.20.0` contract. If the server rejects a request, its status and JSON error envelope are passed through. A capability that does not exist in that HTTP contract returns an explicit `501` from the dashboard; it is not simulated with local state.

## Install and run

```bash
git clone https://github.com/BVEnterprisess/yantrikdb-hermes-dashboard.git
cd yantrikdb-hermes-dashboard
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
cp .env.example .env
chmod 600 .env
```

Review `.env`, especially `YANTRIKDB_SERVER_URL`, `YANTRIKDB_TOKEN`, and the Supabase values, then start the dashboard:

```bash
scripts/start.sh
```

Open **http://127.0.0.1:8767**. The dashboard binds to `127.0.0.1:8767` by default. `scripts/start.sh` reads the shell-style `.env` file; keep it outside version control and restrict its permissions. The YantrikDB server must be started and managed separately.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `YANTRIKDB_SERVER_URL` | `http://127.0.0.1:7438` | YantrikDB HTTP API base URL; supports `http` or `https` |
| `YANTRIKDB_TOKEN` | empty | Optional YantrikDB bearer token, read only by the FastAPI process |
| `YANTRIKDB_DASHBOARD_HOST` | `127.0.0.1` | Dashboard bind address; use a trusted HTTPS reverse proxy for remote access |
| `YANTRIKDB_DASHBOARD_PORT` | `8767` | Dashboard bind port |
| `YANTRIKDB_DASHBOARD_NAMESPACE` | `default` | Initial memory-row namespace tag filter; it is not a tenant/database name |
| `YANTRIKDB_DASHBOARD_ADMIN_MODE` | `false` | Enables supported writes at startup when truthy; the setting can also be changed in the dashboard |
| `YANTRIKDB_DASHBOARD_SETTINGS_PATH` | `~/.config/yantrikdb-dashboard/settings.json` | Dashboard-local settings file, including Admin Mode and optional legacy password settings |
| `YANTRIKDB_DASHBOARD_ENV_FILE` | `<repository>/.env` | Environment file read by `scripts/start.sh` |
| `YANTRIKDB_DASHBOARD_PYTHON` | `python3` | Python executable used by the start and LaunchAgent scripts |
| `YANTRIKDB_DASHBOARD_LAUNCHD_LABEL` | `io.yantrikdb.dashboard` | macOS LaunchAgent label |
| `YANTRIKDB_DASHBOARD_LOG_DIR` | `<repository>/.run` | LaunchAgent stdout/stderr directory |
| `SUPABASE_URL` | configured project URL | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | configured publishable key | Browser-safe Supabase key; never use a service-role or secret key |
| `SUPABASE_AUTH_REDIRECT_URL` | dashboard origin plus `/login` | Optional canonical email-confirmation callback URL |

`YANTRIKDB_SERVER_URL` may not contain URL credentials, a query, or a fragment. Redirects from the configured YantrikDB host are rejected so the bearer token cannot be forwarded to an unexpected host.

### Supabase Auth

The existing Supabase email/password sign-in flow is retained. FastAPI validates the Supabase access token server-side and sets an `HttpOnly`, `SameSite=Lax` cookie. Browser JavaScript receives only the Supabase publishable key; it never receives `YANTRIKDB_TOKEN`. The Auth bootstrap/session endpoints and static assets are public; the dashboard document and application API routes require a valid Supabase session.

Configure the deployed dashboard's origin and `/login` callback in Supabase **Authentication → URL Configuration**. If the publishable key is missing while a Supabase URL is configured, protected routes remain fail-closed and the login page reports the incomplete setup. See [docs/supabase-auth.md](docs/supabase-auth.md) for the full setup and route behavior. Do not place a Supabase service-role key or secret key in `.env`, the browser, or the dashboard process.

## Namespace and statistics semantics

YantrikDB `v0.20.0` distinguishes the caller's visible tenant/database scopes from the `namespace` field attached to individual memory rows:

- `GET /v1/identity-scope` returns a visible tenant/database inventory. In the current phase its `count` fields are `null` and identity-mapping arrays are empty. These values are displayed as returned, not inferred.
- The dashboard's row-namespace selector filters memory records by their returned `namespace` tag. `All namespaces` omits that row-tag filter. Namespace labels are treated as opaque strings: values such as `all`, `*`, and an empty tag are passed as tags, not interpreted as aliases. The UI can also accept an arbitrary row tag; it does not assume a fixed product-specific namespace.
- `GET /v1/stats` returns database-wide totals and takes no namespace query. The dashboard labels these totals as database-wide; it does not claim they are filtered by the selected row tag.

## YantrikDB HTTP capabilities

The dashboard currently maps these operations to the v0.20.0 HTTP API:

| Dashboard operation | YantrikDB operation | Notes |
| --- | --- | --- |
| Process liveness | `GET /v1/health` | Dashboard's `/healthz` only reports local process liveness |
| Statistics | `GET /v1/stats` | Database-wide, not row-namespace filtered |
| Visible server scope | `GET /v1/identity-scope` | Read-only; counts may be `null` |
| Memory list and detail | `GET /v1/memories`, `GET /v1/memory/{rid}` | Generic row namespace, domain, type, pagination, and supported sorts |
| Recall | `POST /v1/recall` | Sends `skip_reinforce: true` so a diagnostic search does not mutate access counters |
| Conflict list and resolution | `GET /v1/conflicts`, `POST /v1/conflicts/{id}/resolve` | The selected list record is shown directly; there is no separate conflict-detail GET route |
| Forget and maintenance | `POST /v1/forget`, `POST /v1/think` | Dashboard Admin Mode plus server-side write permission required; think is server-wide |
| Temporal reads | `GET /v1/temporal/stale`, `GET /v1/temporal/upcoming` | Accept row namespace, days, and limit |
| Trigger actions | `GET /v1/triggers`, `GET /v1/triggers/history`, `POST /v1/triggers/{id}/{action}` | Trigger data/actions are node-local in the server contract |
| Skill operations | `POST /v1/skills/search`, `GET /v1/skills/{skill_id}`, `POST /v1/skills/{skill_id}/outcome` | Outcome writes are supported; outcome-history reads are not |

The JSONL export downloads memory pages from `/v1/memories`; it does not write a local database or export copy.

### Contract limitations shown in the UI

- `/v1/memories` supports the `active` status and `created_at`, `importance`, and `last_access` sort values. Its Phase 1 contract rejects non-active status filters, `q` text search, and `source` filters. Use Recall for server-side semantic search; the memory-list text box filters only the page already returned.
- The overview composition breakdown and recent-write history are not exposed by `/v1/stats`; those panels show “not exposed” instead of fabricated values.
- Identity-scope editing is read-only because the server has no `POST /v1/identity-scope` route.
- The server exposes `GET /v1/claims` for a known entity, but not an all-entities index or a graph-edge read route. The Entity Graph view reports this; the Visualiser only groups returned records by explicit fields and only includes entity links present in returned metadata. It does not infer relationships from memory text.
- Pattern mining results, recall-feedback history, low-usefulness candidates, recent client-side skill surfacing history, skill outcome-history reads, and a combined atomic hygiene write are not available through the current dashboard HTTP contract. The UI marks these capabilities unavailable rather than displaying invented results.
- `POST /v1/think` is server-wide and has no row-namespace parameter. The dashboard requires **All namespaces** before running it.
- Trigger actions and trigger history are node-local in the current server contract; use them with that operational scope in mind.

## Persistent service

### macOS LaunchAgent

After creating the protected `.env` file, install the per-user LaunchAgent:

```bash
YANTRIKDB_DASHBOARD_PYTHON="$PWD/.venv/bin/python" scripts/install-launchd.sh
```

The installer uses the standalone dashboard label `io.yantrikdb.dashboard`, writes its plist under `~/Library/LaunchAgents`, and logs under `.run/` by default. Override the label, environment-file path, bind address, or log directory with the corresponding `YANTRIKDB_DASHBOARD_*` variables. To uninstall:

```bash
scripts/uninstall-launchd.sh
```

### Linux systemd

`deploy/yantrikdb-dashboard.service.example` is a hardened example unit. Adapt its install paths and create `/etc/yantrikdb-dashboard.env` with the required environment variables and protected file permissions before enabling it. The example expects an unprivileged `yantrikdb-dashboard` user and a virtual environment with this repository installed in editable mode.

## Screenshots

Public screenshots, when regenerated, use a local synthetic HTTP fixture server. The generator does not open a YantrikDB database, connect to a real service, or read private memory data. Install `requirements-dev.txt` and make Chrome/Chromium available (`CHROME_BIN` can point to its executable), then run:

```bash
python scripts/generate_mock_screenshots.py
```

The generator writes PNGs and a manifest under `docs/screenshots/`. The screenshot fixture bypasses Supabase Auth locally; it is not an authentication example and is not used by the dashboard runtime.

## Development and tests

```bash
python -m py_compile app.py backend.py
node --check static/app.js
python -m pytest -q
npm ci
npm run build:css
```

The test suite uses mocked HTTP responses and route fixtures; it does not require a live YantrikDB server or Supabase project. Tests cover the upstream wire contract, status/error passthrough, token redaction, Supabase session protections, generic namespaces, unsupported-capability responses, and the no-local-database-fallback guarantee.

## Safety

- Keep `YANTRIKDB_DASHBOARD_HOST=127.0.0.1` unless a trusted HTTPS reverse proxy and network controls are in place.
- Keep `.env` readable only by the dashboard operator; never commit it or include it in bug reports.
- Use a YantrikDB token with only the permissions needed by the dashboard. The dashboard never displays or sends it to browser code.
- Keep Admin Mode off unless you intentionally need supported write operations. Admin Mode does not override YantrikDB authorization or write-safety checks.
- Do not expose an unauthenticated or write-enabled dashboard on a public network.

## Credits and license

YantrikDB Dashboard is built by [wysie](https://github.com/wysie). [YantrikDB](https://github.com/yantrikos/yantrikdb-server) is created by [spranab](https://github.com/spranab).

MIT License. See [LICENSE](LICENSE).
