#!/usr/bin/env bash
# Load data/pa.sqlite into the remote D1 database named in web/wrangler.jsonc.
# Dumps SQL in chunks, then runs each through `wrangler d1 execute --remote --file`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$ROOT/pipeline/export_d1.py"
cd "$ROOT/web"
for f in "$ROOT"/data/d1/*.sql; do
  echo "== $f"
  npx wrangler d1 execute pa-money --remote --yes --file "$f"
done
echo "done"
