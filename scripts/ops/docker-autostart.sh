#!/bin/bash
# Ensures Docker Desktop is running at login/boot, then kicks NanoClaw so it
# doesn't sit in its crash-loop backoff waiting for the daemon.
# Installed as launchd agent com.nanoclaw.docker-autostart (RunAtLoad).
# Added 2026-07-10 after a power-loss reboot left Docker Desktop's own
# login-item auto-start disabled ("operation not permitted when registering
# app service"), which cascaded into a NanoClaw crash loop.

set -u
LABEL="com.nanoclaw-v2-9772a425"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "docker-autostart: launching Docker Desktop"
open -a Docker

# Wait up to ~12 min for the daemon socket to come alive. A macOS software
# update can make Docker Desktop's first launch run its own migration, which
# has been observed to take well over 3 min (2026-07-13 reboot missed the old
# 3-min window and NanoClaw never got kickstarted).
for i in $(seq 1 240); do
  if /usr/local/bin/docker info >/dev/null 2>&1 || docker info >/dev/null 2>&1; then
    log "docker-autostart: daemon ready after $((i*3))s"
    # Skip NanoClaw's backoff by restarting the service now that Docker is up.
    launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null \
      && log "docker-autostart: kickstarted ${LABEL}" \
      || log "docker-autostart: ${LABEL} not loaded (skipped kickstart)"
    exit 0
  fi
  sleep 3
done

log "docker-autostart: daemon did NOT come up within 12 min"
exit 1
