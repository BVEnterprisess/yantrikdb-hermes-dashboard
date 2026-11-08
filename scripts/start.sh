#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PY="${YANTRIKDB_DASHBOARD_PYTHON:-${PYTHON:-python3}}"
ENV_FILE="${YANTRIKDB_DASHBOARD_ENV_FILE:-$APP_DIR/.env}"

# The optional dotenv file is a shell-style KEY=value file. Keep it out of Git
# and restrict its permissions because it may contain YANTRIKDB_TOKEN.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

exec "$PY" "$APP_DIR/app.py"
