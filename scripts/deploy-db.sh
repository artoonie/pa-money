#!/usr/bin/env bash
# Load data/pa.sqlite into the remote D1 database named in web/wrangler.jsonc.
#
# The dump is streamed in chunks: each is written, loaded with `wrangler d1 execute
# --remote --file`, then deleted. D1 imports a file as one transaction. Every INSERT is
# OR REPLACE and holds at most 400 rows, because D1 fails with SQLITE_NOMEM on larger
# VALUES lists.
#
#   scripts/deploy-db.sh                 full load of a new build (drops and recreates tables)
#   scripts/deploy-db.sh --resume        continue an interrupted load of the SAME build; re-plans
#                                        from the remote row counts after every failure, up to
#                                        MAX_ATTEMPTS times (default 40)
#   scripts/deploy-db.sh --tables expense  any other export_d1.py options pass through
#
# D1 bills rows written (50M/month included on the paid plan, then $1 per million), so prefer
# --resume over repeating a full load.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/web"
RUN="npx wrangler d1 execute pa-money --remote --yes --file {file}"
CHUNK="${CHUNK_MB:-50}"

resume=0
for a in "$@"; do [ "$a" = "--resume" ] && resume=1; done

if [ "$resume" = 1 ]; then
  attempt=0
  until python3 "$ROOT/pipeline/export_d1.py" --chunk-mb "$CHUNK" --retries 1 "$@" --run "$RUN"; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "${MAX_ATTEMPTS:-40}" ]; then echo "giving up after $attempt attempts"; exit 1; fi
    echo "== attempt $attempt failed; re-planning from the remote state in 20s"
    sleep 20
  done
else
  python3 "$ROOT/pipeline/export_d1.py" --chunk-mb "$CHUNK" "$@" --run "$RUN"
fi
echo "done"
