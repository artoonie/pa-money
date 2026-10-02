#!/usr/bin/env bash
# Load data/pa.sqlite into the remote D1 database named in web/wrangler.jsonc.
# The dump is streamed one chunk at a time: each chunk is written, loaded with
# `wrangler d1 execute --remote --file`, then deleted, so disk use stays at one chunk.
# Tables are dropped and recreated, so the site serves partial data while this runs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/web"
# Resume after a failed chunk with: START_PART=3 scripts/deploy-db.sh
python3 "$ROOT/pipeline/export_d1.py" --chunk-mb "${CHUNK_MB:-900}" --start-part "${START_PART:-1}" \
  --run "npx wrangler d1 execute pa-money --remote --yes --file {file}"
echo "done"
