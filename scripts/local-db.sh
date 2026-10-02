#!/usr/bin/env bash
# Copy data/pa.sqlite into wrangler's local D1 storage so `wrangler dev` serves it.
# Re-run after every pipeline build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$ROOT/data/pa.sqlite"
[ -f "$DB" ] || { echo "no $DB; run pipeline/build.py first" >&2; exit 1; }

cd "$ROOT/web"
# Make sure the local database file exists, then find it.
npx wrangler d1 execute pa-money --local --command "SELECT 1" >/dev/null
STATE=".wrangler/state/v3/d1/miniflare-D1DatabaseObject"
TARGET="$(ls "$STATE"/*.sqlite | head -1)"
[ -n "$TARGET" ] || { echo "could not find the local D1 file under $STATE" >&2; exit 1; }
rm -f "$TARGET-wal" "$TARGET-shm"
cp "$DB" "$TARGET"
echo "loaded $(du -h "$DB" | cut -f1) into $TARGET"
