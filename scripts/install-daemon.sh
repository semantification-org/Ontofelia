#!/usr/bin/env bash
#
# install-daemon.sh — install Ontofelia as an always-on NATIVE daemon (no Docker).
#
# This is the lightweight deployment: Ontofelia runs as a plain host Node
# process (`ontofelia gateway start`, which backgrounds itself with a PID file
# at ~/.ontofelia/gateway.pid and logs to ~/.ontofelia/logs/gateway.log). No
# container, no image to build.
#
# Always-on supervision: where a user systemd bus is available you may prefer a
# --user service (see docs/deployment.md, "Keeping the gateway running"); this
# installer targets the lowest common denominator and uses cron — a watchdog
# every 2 minutes plus an @reboot start — as the lightweight replacement for
# Docker's `--restart unless-stopped`.
#
# Idempotent: safe to re-run. Run after install.sh has built the project.
set -uo pipefail

REPO="${ONTOFELIA_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CONF="$HOME/.ontofelia/ontofelia.json5"
PIDF="$HOME/.ontofelia/gateway.pid"
WATCHDOG="$REPO/scripts/gateway-watchdog.sh"
LOGDIR="$HOME/.ontofelia/logs"

chmod +x "$WATCHDOG" 2>/dev/null || true
mkdir -p "$LOGDIR"

# Port: env override → configured gateway port → default (same as watchdog).
PORT="${ONTOFELIA_PORT:-}"
if [ -z "$PORT" ] && [ -f "$CONF" ]; then
  PORT=$(sed -n 's/^[[:space:]]*"\{0,1\}port"\{0,1\}[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CONF" | head -n 1)
fi
PORT="${PORT:-18780}"

# 0. cron is the supervision mechanism here — bail out clearly where it is
#    missing (minimal containers, some NAS boxes, macOS without cron enabled).
if ! command -v crontab >/dev/null 2>&1; then
  echo "✗ crontab not found — cannot install cron supervision." >&2
  echo "  The gateway still runs, but will not auto-restart after a crash or reboot." >&2
  echo "  Set up a systemd --user service (or launchd on macOS) instead — see" >&2
  echo "  docs/deployment.md, section \"Keeping the gateway running\"." >&2
  exit 1
fi

# 1. Start the daemon now (only if it is neither healthy nor running). A live
#    process that is not yet healthy was most likely started by install.sh
#    moments ago — leave it alone; the cron watchdog recovers it if it hung.
code=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/health" 2>/dev/null) || true
code="${code:-000}"
pid=$(cat "$PIDF" 2>/dev/null || true)
if [ "$code" = "200" ]; then
  echo "✓ Gateway already healthy (HTTP 200) — leaving the running instance alone."
elif [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] && kill -0 "$pid" 2>/dev/null; then
  echo "• Gateway process alive (PID $pid) but not healthy yet (HTTP $code) — leaving it to the watchdog."
else
  echo "• Gateway not running (HTTP $code) — starting the native daemon…"
  if ! "$WATCHDOG"; then
    echo "✗ Could not start the gateway — check $LOGDIR/gateway.log" >&2
    exit 1
  fi
fi

# 2. Install cron supervision (idempotent): watchdog every 2 min + start on
#    reboot. The @reboot entry also runs the watchdog: with nothing up yet, its
#    health check fails and it starts the gateway.
MARK="# ontofelia-daemon (managed by scripts/install-daemon.sh)"
WD_LINE="*/2 * * * * $WATCHDOG >> $LOGDIR/watchdog.log 2>&1 $MARK"
RB_LINE="@reboot $WATCHDOG >> $LOGDIR/watchdog.log 2>&1 $MARK"

# Preserve every other crontab line; replace only our managed entries.
kept=$(crontab -l 2>/dev/null | grep -vF "$MARK" || true)
printf '%s\n%s\n%s\n' "$kept" "$WD_LINE" "$RB_LINE" | sed '/^$/d' | crontab -

echo "✓ Installed cron supervision (watchdog */2 min + @reboot start):"
crontab -l 2>/dev/null | grep -F "$MARK" | sed 's/^/    /'
echo
echo "Manage the daemon directly with:"
echo "    ontofelia gateway stop|restart   and   ontofelia status"
