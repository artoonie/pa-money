#!/usr/bin/env python3
"""Dump data/pa.sqlite into SQL files that `wrangler d1 execute --file` can load.

Virtual (FTS) tables are not dumped; the last chunk rebuilds them from their source tables.
Chunks stay under --chunk-mb so each stays below D1's 5 GB per-file import limit.

Usage: python3 pipeline/export_d1.py [--db data/pa.sqlite] [--out data/d1] [--chunk-mb 900]
"""
import argparse
import os
import sqlite3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(ROOT, "data", "pa.sqlite"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "d1"))
    ap.add_argument("--chunk-mb", type=int, default=900)
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

    def open_part():
        nonlocal part, size, out
        if out:
            out.close()
        part += 1
        size = 0
        out = open(os.path.join(args.out, f"{part:03d}.sql"), "w", encoding="utf-8")
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
        buf = []
        for row in rows:
            buf.append("(" + ",".join(literal(v) for v in row) + ")")
            if len(buf) >= 500:
                write(f"INSERT INTO {table} ({collist}) VALUES\n" + ",\n".join(buf) + ";\n")
                buf = []
        if buf:
            write(f"INSERT INTO {table} ({collist}) VALUES\n" + ",\n".join(buf) + ";\n")
        print(f"{table}: dumped")

    write("DROP TABLE IF EXISTS filer_fts;\n")
    write("CREATE VIRTUAL TABLE filer_fts USING fts5 (name, filer_id UNINDEXED, tokenize = 'unicode61');\n")
    write("INSERT INTO filer_fts (name, filer_id) SELECT name, filer_id FROM filer_name;\n")
    write("DROP TABLE IF EXISTS donor_fts;\n")
    write("CREATE VIRTUAL TABLE donor_fts USING fts5 (name, city, employer, donor_id UNINDEXED, tokenize = 'unicode61');\n")
    write("INSERT INTO donor_fts (name, city, employer, donor_id) SELECT name, city, employer, donor_id FROM donor;\n")
    out.close()
    print(f"wrote {part} file(s) to {args.out}")


def literal(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


if __name__ == "__main__":
    main()
