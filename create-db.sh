#!/usr/bin/env bash
# Create a new SQLite database for the scoreboard.
#
#   ./create-db.sh                          -> ./data.sqlite (empty, new admin password)
#   ./create-db.sh /path/to/my.sqlite       -> that file instead
#   ./create-db.sh --import data.json       -> start from an old data.json
#   ./create-db.sh --password MySecret      -> choose the admin password
#   ./create-db.sh --force                  -> replace an existing database (the old one is kept as <name>.bak-<time>)
#
# Then start the server with DB_FILE=/path/to/my.sqlite node server.js  (or just node server.js for ./data.sqlite)
set -euo pipefail
cd "$(dirname "$0")"

DB="data.sqlite"; IMPORT=""; PASS=""; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --import)   IMPORT="${2:?--import needs a file}"; shift 2 ;;
    --password) PASS="${2:?--password needs a value}"; shift 2 ;;
    --force)    FORCE=1; shift ;;
    -h|--help)  sed -n '2,10p' "$0"; exit 0 ;;
    -*)         echo "Unknown option: $1" >&2; exit 2 ;;
    *)          DB="$1"; shift ;;
  esac
done

command -v node >/dev/null || { echo "Node is not installed. Get the current LTS from https://nodejs.org" >&2; exit 1; }

if [ -e "$DB" ]; then
  if [ "$FORCE" -eq 1 ]; then
    BAK="$DB.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$DB" "$BAK"; for s in -wal -shm; do [ -e "$DB$s" ] && mv "$DB$s" "$BAK$s"; done
    echo "Existing database kept as $BAK"
  else
    echo "$DB already exists. Use --force to replace it (the old one is kept as a backup), or pick another name." >&2
    exit 3
  fi
fi

ARGS=("$DB"); [ -n "$IMPORT" ] && ARGS+=(--import "$IMPORT"); [ -n "$PASS" ] && ARGS+=(--password "$PASS")
node tools/create-db.js "${ARGS[@]}"
