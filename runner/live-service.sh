#!/bin/bash
# Tudumm live feed as an always-on macOS service (launchd agent: in.tudumm.live).
# launchd starts this at login and restarts it whenever it exits (KeepAlive). caffeinate keeps the
# Mac from idle-sleeping while the feed runs (-s also blocks system sleep on AC power; a closed lid
# still sleeps a MacBook unless it's in clamshell mode with power + an external display).
# Install / remove: bash scripts/install-live-service.sh [--uninstall]
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${HOME}/Library/Logs/Tudumm"
LOG="${LOG_DIR}/live.log"
NODE_BIN="${TUDUMM_NODE:-__NODE__}"

mkdir -p "$LOG_DIR"
# keep the log bounded: rotate at ~20 MB, keep one old copy
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 20000000 ]; then mv -f "$LOG" "$LOG.1"; fi

notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Tudumm live feed\"" >/dev/null 2>&1 || true; }

cd "$ROOT" || { notify "Repo not found at $ROOT"; sleep 60; exit 1; }
echo "$(date '+%Y-%m-%d %H:%M:%S') [service] starting (node $("$NODE_BIN" -v 2>/dev/null))" >>"$LOG"
/usr/bin/caffeinate -i -s "$NODE_BIN" --env-file-if-exists=runner/live.env --experimental-strip-types --disable-warning=ExperimentalWarning runner/live.ts >>"$LOG" 2>&1
rc=$?
echo "$(date '+%Y-%m-%d %H:%M:%S') [service] feed exited with code $rc; launchd restarts it in ~30 s" >>"$LOG"
notify "Feed stopped (code $rc). Restarting in 30 s. Log: ~/Library/Logs/Tudumm/live.log"
exit "$rc"
