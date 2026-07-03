#!/usr/bin/env bash
#
# gateway-watchdog.sh — lightweight always-on supervisor for the Ontofelia
# native gateway daemon.
#
# Ontofelia runs as a plain host Node process (`ontofelia gateway start`
# backgrounds itself with a PID file at ~/.ontofelia/gateway.pid and logs to
# ~/.ontofelia/logs/gateway.log) — no Docker. On boxes with a user systemd bus
# you may prefer a --user service (see docs/deployment.md, "Keeping the gateway
# running"); where that is unavailable, this script is the lightweight
# replacement for Docker's `--restart unless-stopped`: run it from cron every
# couple of minutes and it (re)starts the gateway whenever the health endpoint
# is down.
#
# It is intentionally conservative: it never touches PID 1, never starts a
# second instance while a live one is healthy, and kills a hung instance before
# restarting so two processes never share the embedded Oxigraph store.
#
# Install via scripts/install-daemon.sh (adds the cron entries).
set -uo pipefail

REPO="${ONTOFELIA_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PIDF="$HOME/.ontofelia/gateway.pid"
CONF="$HOME/.ontofelia/ontofelia.json5"

# Cron runs with a minimal PATH — make sure the `ontofelia` wrapper installed
# by install.sh (~/.local/bin) and node itself are reachable.
PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  # nvm-managed node lives outside any default cron PATH.
  for dir in "$HOME/.nvm/versions/node"/*/bin; do
    [ -d "$dir" ] && PATH="$dir:$PATH"
  done
fi
export PATH

# Port: env override → configured gateway port → default.
PORT="${ONTOFELIA_PORT:-}"
if [ -z "$PORT" ] && [ -f "$CONF" ]; then
  PORT=$(sed -n 's/^[[:space:]]*"\{0,1\}port"\{0,1\}[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CONF" | head -n 1)
fi
PORT="${PORT:-18780}"

log() { echo "$(date -Is) watchdog: $*"; }

# Start the gateway the same way install.sh does: prefer the `ontofelia`
# wrapper, fall back to the compiled CLI entry point in this repo.
start_gateway() {
  if command -v ontofelia >/dev/null 2>&1; then
    ontofelia gateway start
  elif command -v node >/dev/null 2>&1 && [ -f "$REPO/apps/cli/dist/index.js" ]; then
    node "$REPO/apps/cli/dist/index.js" gateway start
  else
    log "cannot start: neither 'ontofelia' on PATH nor node + $REPO/apps/cli/dist/index.js found"
    return 1
  fi
}

# Healthy → nothing to do.
code=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/health" 2>/dev/null) || true
code="${code:-000}"
[ "$code" = "200" ] && exit 0

log "health=$code → recovering gateway"

# If the PID file points at a live-but-unhealthy process, it is hung: terminate
# it first so the restart does not create a second writer on the triplestore.
if [ -f "$PIDF" ]; then
  pid=$(cat "$PIDF" 2>/dev/null || true)
  # Guard: only ever signal a real, non-init PID we own.
  if [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] && kill -0 "$pid" 2>/dev/null; then
    log "terminating hung gateway (PID $pid)"
    kill "$pid" 2>/dev/null || true
    sleep 3
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDF"
fi

start_gateway
rc=$?
log "restart issued (exit $rc)"
exit "$rc"
