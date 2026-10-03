#!/usr/bin/env python3
"""Dump data/pa.sqlite into SQL files that `wrangler d1 execute --file` can load.

Virtual (FTS) tables are not dumped; the last chunk rebuilds them from their source tables.
Chunks stay under --chunk-mb so each stays below D1's 5 GB per-file import limit.

Usage: python3 pipeline/export_d1.py [--db data/pa.sqlite] [--out data/d1] [--chunk-mb 900]
       python3 pipeline/export_d1.py --run "npx wrangler d1 execute pa-money --remote --yes --file {file}"

With --run, each chunk is handed to that command as soon as it is complete and
deleted afterwards, so only one chunk is ever on disk. A failing command stops
the export with a non-zero exit.
"""
import argparse
import os
import shlex
import sqlite3
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(ROOT, "data", "pa.sqlite"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "d1"))
    ap.add_argument("--chunk-mb", type=int, default=50, help="D1 imports a chunk as one transaction; keep it modest so a failure loses little")
    ap.add_argument("--run", help="command to run on each finished chunk; {file} is replaced by its path")
    ap.add_argument("--start-part", type=int, default=1, help="with --run: skip chunks before this number (resume after a failure)")
    ap.add_argument("--statement-kb", type=int, default=90, help="max bytes per INSERT; D1 rejects statements over 100 KB")
    ap.add_argument("--statement-rows", type=int, default=400,
                    help="max rows per INSERT; SQLite compiles a VALUES list as a compound and D1 fails with SQLITE_NOMEM past ~500 rows")
    ap.add_argument("--tables", help="comma-separated tables to dump (default: all)")
    ap.add_argument("--skip-tables", help="comma-separated tables to leave out")
    ap.add_argument("--keep", action="store_true", help="do not DROP tables first; CREATE IF NOT EXISTS and INSERT OR REPLACE into what is there")
    ap.add_argument("--from-id", type=int, help="with a single --tables entry: only rows with id > this (resume a partial load)")
    ap.add_argument("--retries", type=int, default=3, help="with --run: attempts per chunk before giving up")
    ap.add_argument("--fts", action="store_true", help="rebuild the full-text indexes even if donor/filer_name are not dumped")
    ap.add_argument("--resume", action="store_true",
                    help="ask the remote database what it already has (via --query-cmd) and load only what is missing; "
                         "for continuing an interrupted load of the SAME build, never for a new build")
    ap.add_argument("--query-cmd", default="npx wrangler d1 execute pa-money --remote --json --command {sql}",
                    help="with --resume: command that runs {sql} against the target and prints JSON rows")
    args = ap.parse_args()
    if args.from_id is not None and not (args.tables and "," not in args.tables):
        sys.exit("--from-id needs exactly one table in --tables")

    os.makedirs(args.out, exist_ok=True)
    for old in os.listdir(args.out):
        if old.endswith(".sql"):
            os.remove(os.path.join(args.out, old))

    db = sqlite3.connect(args.db)
    limit = args.chunk_mb * 1_000_000
    part = 0
    size = 0
    out = None
    path = None

    def finish_part():
        nonlocal out
        if not out:
            return
        out.close()
        out = None
        print(f"chunk {path}: {os.path.getsize(path) / 1e6:.0f} MB")
        if args.run and part < args.start_part:
            print(f"  skipped (resuming from chunk {args.start_part})")
            os.remove(path)
        elif args.run:
            cmd = args.run.replace("{file}", shlex.quote(path))
            for attempt in range(1, args.retries + 1):
                print(f"  running (attempt {attempt}): {cmd}", flush=True)
                res = subprocess.run(cmd, shell=True)
                if res.returncode == 0:
                    break
                if attempt < args.retries:
                    wait = 30 * attempt
                    print(f"  failed with exit {res.returncode}; retrying in {wait}s (inserts are OR REPLACE, so a partial chunk is safe to repeat)", flush=True)
                    time.sleep(wait)
            else:
                sys.exit(f"command failed on {path} after {args.retries} attempts; resume with --start-part {part}")
            os.remove(path)

    def open_part():
        nonlocal part, size, out, path
        finish_part()
        part += 1
        size = 0
        path = os.path.join(args.out, f"{part:03d}.sql")
        out = open(path, "w", encoding="utf-8")
        out.write("PRAGMA defer_foreign_keys = TRUE;\n")

    def write(line):
        nonlocal size
        out.write(line)
        size += len(line)
        if size >= limit:
            open_part()

    open_part()
    # Real tables only; FTS virtual tables are rebuilt at the end. Small tables go first and
    # `contribution` last, so a failure deep in the big table leaves a usable site.
    schema = db.execute(
        "SELECT name, type, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
        "AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND name NOT LIKE '%_fts%'").fetchall()
    table_sql = {n: sql for n, t, _, sql in schema if t == "table"}
    index_sql = {}
    for n, t, tbl, sql in schema:
        if t == "index":
            index_sql.setdefault(tbl, []).append(sql)
    sizes = {n: db.execute(f"SELECT COUNT(*) FROM {n}").fetchone()[0] for n in table_sql}
    tables = sorted(table_sql, key=lambda n: (n == "contribution", sizes[n]))
    if args.tables:
        wanted = [t.strip() for t in args.tables.split(",") if t.strip()]
        unknown = [t for t in wanted if t not in table_sql]
        if unknown:
            sys.exit(f"unknown tables: {unknown}")
        tables = [t for t in tables if t in wanted]
    if args.skip_tables:
        skip = {t.strip() for t in args.skip_tables.split(",")}
        tables = [t for t in tables if t not in skip]

    # --resume: compare with the target and plan per table.
    from_id = {}
    offset = {}
    keep = {}
    rebuild_fts = args.fts or ("filer_name" in tables) or ("donor" in tables)
    if args.resume:
        if args.from_id is not None or args.keep:
            sys.exit("--resume decides --keep and --from-id itself")
        planned = []
        for table in tables:
            has_id = any(r[1] == "id" and r[5] == 1 for r in db.execute(f"PRAGMA table_info({table})"))
            remote = remote_query(args.query_cmd, f"SELECT COUNT(*) n{', MAX(id) m' if has_id else ''} FROM {table}")
            n = remote["n"] if remote else 0
            if n == sizes[table]:
                print(f"{table}: complete on target ({n:,} rows), skipping")
                continue
            if has_id and remote and n and n == remote.get("m"):
                print(f"{table}: target has {n:,} of {sizes[table]:,} rows, contiguous; resuming after id {n}")
                from_id[table] = n
                keep[table] = True
            elif not has_id and 0 < n < sizes[table]:
                # Rows were loaded in local rowid order and every INSERT is atomic, so the first n local rows are what is there.
                print(f"{table}: target has {n:,} of {sizes[table]:,} rows; resuming after row {n}")
                offset[table] = n
                keep[table] = True
            else:
                print(f"{table}: target has {n:,} of {sizes[table]:,} rows; reloading whole table with OR REPLACE")
                keep[table] = True
            planned.append(table)
        tables = planned
        fts_ok = remote_query(args.query_cmd, "SELECT COUNT(*) n FROM donor_fts")
        rebuild_fts = args.fts or not fts_ok or fts_ok.get("n") != sizes["donor"]
        print(f"full-text indexes: {'rebuilding' if rebuild_fts else 'complete on target, skipping'}")
        if not tables and not rebuild_fts:
            print("nothing to do")
            return
    else:
        for table in tables:
            keep[table] = args.keep
            if args.from_id is not None:
                from_id[table] = args.from_id

    for table in tables:
        if keep.get(table):
            write(table_sql[table].replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1) + ";\n")
            for isql in index_sql.get(table, []):
                write(isql.replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ", 1) + ";\n")
        else:
            write(f"DROP TABLE IF EXISTS {table};\n")
            write(table_sql[table] + ";\n")
            for isql in index_sql.get(table, []):
                write(isql + ";\n")
        cols = [r[1] for r in db.execute(f"PRAGMA table_info({table})")]
        collist = ", ".join(cols)
        where = f" WHERE id > {int(from_id[table])}" if table in from_id else ""
        tail = f" LIMIT -1 OFFSET {int(offset[table])}" if table in offset else ""
        rows = db.execute(f"SELECT {collist} FROM {table}{where} ORDER BY rowid{tail}")
        head = f"INSERT OR REPLACE INTO {table} ({collist}) VALUES\n"
        max_bytes = args.statement_kb * 1000 - len(head) - 16
        buf = []
        buf_bytes = 0
        for row in rows:
            tup = "(" + ",".join(literal(v) for v in row) + ")"
            n = len(tup.encode("utf-8")) + 2
            if buf and (buf_bytes + n > max_bytes or len(buf) >= args.statement_rows):
                write(head + ",\n".join(buf) + ";\n")
                buf = []
                buf_bytes = 0
            buf.append(tup)
            buf_bytes += n
        if buf:
            write(head + ",\n".join(buf) + ";\n")
        print(f"{table}: dumped ({sizes[table]:,} rows)")

    if rebuild_fts:
        # Populate in id ranges: one INSERT ... SELECT over millions of rows exhausts D1's import memory.
        write("DROP TABLE IF EXISTS filer_fts;\n")
        write("CREATE VIRTUAL TABLE filer_fts USING fts5 (name, filer_id UNINDEXED, tokenize = 'unicode61');\n")
        write("INSERT INTO filer_fts (name, filer_id) SELECT name, filer_id FROM filer_name;\n")
        write("DROP TABLE IF EXISTS donor_fts;\n")
        write("CREATE VIRTUAL TABLE donor_fts USING fts5 (name, city, employer, donor_id UNINDEXED, tokenize = 'unicode61');\n")
        max_donor = db.execute("SELECT COALESCE(MAX(donor_id), 0) FROM donor").fetchone()[0]
        step = 100_000
        for lo in range(1, max_donor + 1, step):
            write(f"INSERT INTO donor_fts (name, city, employer, donor_id) SELECT name, city, employer, donor_id FROM donor "
                  f"WHERE donor_id BETWEEN {lo} AND {lo + step - 1};\n")
    finish_part()
    print(f"{'loaded' if args.run else 'wrote'} {part} chunk(s)" + ("" if args.run else f" in {args.out}"))


def remote_query(cmd_template, sql):
    """Run one SELECT against the target through the --query-cmd and return the first row as a dict (None if the table is missing)."""
    import json
    cmd = cmd_template.replace("{sql}", shlex.quote(sql))
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if res.returncode != 0:
        if "no such table" in (res.stdout + res.stderr):
            return None
        sys.exit(f"query failed: {cmd}\n{res.stderr[-2000:]}")
    text = res.stdout.strip()
    start = text.find("[")
    if start < 0:
        return None
    data = json.loads(text[start:])
    if data and isinstance(data[0], dict) and "results" in data[0]:   # wrangler wraps results
        data = data[0]["results"]
    return data[0] if data else None


def literal(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


if __name__ == "__main__":
    main()
