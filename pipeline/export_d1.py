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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(ROOT, "data", "pa.sqlite"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "d1"))
    ap.add_argument("--chunk-mb", type=int, default=900)
    ap.add_argument("--run", help="command to run on each finished chunk; {file} is replaced by its path")
    ap.add_argument("--start-part", type=int, default=1, help="with --run: skip chunks before this number (resume after a failure)")
    ap.add_argument("--statement-kb", type=int, default=90, help="max bytes per INSERT; D1 rejects statements over 100 KB")
    args = ap.parse_args()

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
            print(f"  running: {cmd}", flush=True)
            res = subprocess.run(cmd, shell=True)
            if res.returncode != 0:
                sys.exit(f"command failed on {path} with exit {res.returncode}")
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
    # Schema first: everything except virtual tables and their shadow tables.
    schema = db.execute(
        "SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
        "AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND name NOT LIKE '%_fts%' ORDER BY type DESC, name").fetchall()
    for name, typ, sql in schema:
        if typ == "table":
            write(f"DROP TABLE IF EXISTS {name};\n")
        write(sql + ";\n")

    tables = [n for n, t, _ in schema if t == "table"]
    for table in tables:
        cols = [r[1] for r in db.execute(f"PRAGMA table_info({table})")]
        collist = ", ".join(cols)
        rows = db.execute(f"SELECT {collist} FROM {table}")
        head = f"INSERT INTO {table} ({collist}) VALUES\n"
        max_bytes = args.statement_kb * 1000 - len(head) - 16
        buf = []
        buf_bytes = 0
        for row in rows:
            tup = "(" + ",".join(literal(v) for v in row) + ")"
            n = len(tup.encode("utf-8")) + 2
            if buf and buf_bytes + n > max_bytes:
                write(head + ",\n".join(buf) + ";\n")
                buf = []
                buf_bytes = 0
            buf.append(tup)
            buf_bytes += n
        if buf:
            write(head + ",\n".join(buf) + ";\n")
        print(f"{table}: dumped")

    write("DROP TABLE IF EXISTS filer_fts;\n")
    write("CREATE VIRTUAL TABLE filer_fts USING fts5 (name, filer_id UNINDEXED, tokenize = 'unicode61');\n")
    write("INSERT INTO filer_fts (name, filer_id) SELECT name, filer_id FROM filer_name;\n")
    write("DROP TABLE IF EXISTS donor_fts;\n")
    write("CREATE VIRTUAL TABLE donor_fts USING fts5 (name, city, employer, donor_id UNINDEXED, tokenize = 'unicode61');\n")
    write("INSERT INTO donor_fts (name, city, employer, donor_id) SELECT name, city, employer, donor_id FROM donor;\n")
    finish_part()
    print(f"{'loaded' if args.run else 'wrote'} {part} chunk(s)" + ("" if args.run else f" in {args.out}"))


def literal(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


if __name__ == "__main__":
    main()
