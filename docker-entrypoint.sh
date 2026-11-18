#!/bin/sh
# Startet Kassensturz als unprivilegierter Benutzer.
# PUID/PGID sollten dem Synology-Benutzer entsprechen, dem der Datenordner gehört
# (per SSH: `id <benutzername>`, typischerweise 1026 / 100).
set -e
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
mkdir -p "$DATA_DIR"
if [ "$(id -u)" = "0" ]; then
  chown -R "$PUID:$PGID" "$DATA_DIR"
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
