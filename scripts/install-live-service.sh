#!/bin/bash
# Install (or remove) the Tudumm live feed as a macOS launchd agent: starts at login, restarts on
# exit, keeps the Mac awake while it runs. Logs: ~/Library/Logs/Tudumm/live.log
#
# macOS privacy protection (TCC) blocks background services from reading ~/Documents, so the feed
# runs from a copy in ~/Library/Application Support/Tudumm/live. This script refreshes that copy:
# RE-RUN IT AFTER PULLING CODE CHANGES OR EDITING runner/live.env.
#
#   bash scripts/install-live-service.sh              # install / update + (re)start
#   bash scripts/install-live-service.sh --uninstall  # stop + remove (copy, plist; logs are kept)
#   launchctl kickstart -k gui/$(id -u)/in.tudumm.live   # restart now
set -euo pipefail
umask 077
LABEL="in.tudumm.live"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${HOME}/Library/Application Support/Tudumm/live"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$APP"
  echo "removed $LABEL (logs kept in ~/Library/Logs/Tudumm)"
  exit 0
fi

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "node not found on PATH" >&2; exit 1; }
"$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || { echo "Node >= 22 required (found $("$NODE" -v))" >&2; exit 1; }
[[ -f "$ROOT/runner/live.env" ]] || { echo "runner/live.env missing (copy runner/live.env.example and fill it in)" >&2; exit 1; }

# --- refresh the runnable copy (code the feed imports + its config); keep its cache ---
mkdir -p "$APP/runner" "$APP/worker" "${HOME}/Library/Logs/Tudumm"
rsync -a --delete --exclude '*.test.ts' "$ROOT/worker/src/" "$APP/worker/src/"
rsync -a --delete --exclude '*.test.ts' "$ROOT/runner/live/" "$APP/runner/live/"
rsync -a --delete "$ROOT/runner/lib/" "$APP/runner/lib/"
cp -f "$ROOT/runner/live.ts" "$ROOT/runner/live-service.sh" "$APP/runner/"
cp -f "$ROOT/runner/live.env" "$APP/runner/live.env"
chmod 600 "$APP/runner/live.env"
chmod 700 "$APP/runner/live-service.sh"
printf '{ "type": "module" }\n' >"$APP/package.json"
git -C "$ROOT" rev-parse --short HEAD >"$APP/VERSION" 2>/dev/null || echo unknown >"$APP/VERSION"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${APP}/runner/live-service.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TUDUMM_NODE</key><string>${NODE}</string>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>${APP}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/Tudumm/launchd.out</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/Tudumm/launchd.err</string>
</dict>
</plist>
EOF
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"
echo "installed $LABEL from $(cat "$APP/VERSION") (node $("$NODE" -v)); log: ~/Library/Logs/Tudumm/live.log"
