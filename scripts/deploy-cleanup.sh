#!/usr/bin/env bash
# Push a cleanup-only change to the remote D1 database without rebuilding or reloading the data.
#
# Run pipeline/apply_cleanup.py first (it updates data/pa.sqlite and writes data/cleanup-delta.sql).
# This script then reloads the small cleanup tables and applies the row-level delta.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DELTA="$ROOT/data/cleanup-delta.sql"
[ -f "$DELTA" ] || { echo "no $DELTA; run python3 pipeline/apply_cleanup.py first" >&2; exit 1; }
"$ROOT/scripts/deploy-db.sh" --tables lookup,entity,donor_entity,filer_group,filer_link,donor_rank
cd "$ROOT/web"
npx wrangler d1 execute pa-money --remote --yes --file "$DELTA"
echo "cleanup deployed; edge caches expire within an hour"
