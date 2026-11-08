#!/usr/bin/env bash
set -euo pipefail

LABEL="${YANTRIKDB_DASHBOARD_LAUNCHD_LABEL:-io.yantrikdb.dashboard}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON_BIN="${YANTRIKDB_DASHBOARD_PYTHON:-${PYTHON:-python3}}"
HOST="${YANTRIKDB_DASHBOARD_HOST:-127.0.0.1}"
PORT="${YANTRIKDB_DASHBOARD_PORT:-8767}"
ENV_FILE="${YANTRIKDB_DASHBOARD_ENV_FILE:-$APP_DIR/.env}"
LOG_DIR="${YANTRIKDB_DASHBOARD_LOG_DIR:-$APP_DIR/.run}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1 && [ ! -x "$PYTHON_BIN" ]; then
  echo "Python not found or not executable: $PYTHON_BIN" >&2
  echo "Set YANTRIKDB_DASHBOARD_PYTHON=/absolute/path/to/python" >&2
  exit 1
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_DIR/scripts/start.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>YANTRIKDB_DASHBOARD_PYTHON</key>
    <string>$PYTHON_BIN</string>
    <key>YANTRIKDB_DASHBOARD_ENV_FILE</key>
    <string>$ENV_FILE</string>
    <key>YANTRIKDB_DASHBOARD_HOST</key>
    <string>$HOST</string>
    <key>YANTRIKDB_DASHBOARD_PORT</key>
    <string>$PORT</string>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/launchd.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed standalone YantrikDB Dashboard service: $LABEL"
echo "Plist: $PLIST"
echo "Environment file: $ENV_FILE"
echo "Logs: $LOG_DIR/launchd.out.log $LOG_DIR/launchd.err.log"
echo "URL: http://$HOST:$PORT"
