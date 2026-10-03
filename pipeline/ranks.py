#!/usr/bin/env python3
"""(Re)build the donor_rank table in an existing database.

build.py calls build_donor_ranks() at the end of a build; run this directly to refresh the
rankings in a database you already have (for example after editing cleanup rules only):

  python3 pipeline/ranks.py [--db data/pa.sqlite]
"""
import argparse
import os
import sqlite3
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KINDS = ("all", "individual", "organization", "committee")
TOP_N = 1000


def build_donor_ranks(db, log=print):
    db.execute("DELETE FROM donor_rank")
    years = [r[0] for r in db.execute("SELECT DISTINCT eyear FROM donor_year ORDER BY eyear")]
    t0 = time.time()
    for eyear in [0] + years:
        for kind in KINDS:
            kind_clause = "d.kind != 'aggregate'" if kind == "all" else "d.kind = ?"
            params = [eyear, kind] + ([] if kind == "all" else [kind])
            year_clause = "" if eyear == 0 else " AND y.eyear = ?"
            if eyear:
                params.append(eyear)
            db.execute(f"""
                INSERT INTO donor_rank (eyear, kind, rank, donor_id, entity_id, name, city, state, employer, donor_kind,
                                        n_keys, total, n, n_recipients)
                SELECT ?, ?, ROW_NUMBER() OVER (ORDER BY total DESC, name), donor_id, entity_id, name, city, state, employer,
                       donor_kind, n_keys, total, n, n_recipients
                FROM (
                  SELECT MIN(d.donor_id) donor_id, d.entity_id, COALESCE(MAX(e.name), MIN(d.name)) name,
                         MIN(d.city) city, MIN(d.state) state, MIN(d.employer) employer,
                         COALESCE(MAX(e.kind), MIN(d.kind)) donor_kind, COUNT(DISTINCT d.donor_id) n_keys,
                         SUM(y.total) total, SUM(y.n) n, SUM(y.n_recipients) n_recipients
                  FROM donor_year y JOIN donor d ON d.donor_id = y.donor_id LEFT JOIN entity e ON e.entity_id = d.entity_id
                  WHERE {kind_clause}{year_clause}
                  GROUP BY COALESCE(d.entity_id, 'd' || d.donor_id)
                  ORDER BY total DESC LIMIT {TOP_N})""", params)
        log(f"donor_rank: {'all years' if eyear == 0 else eyear} done ({time.time() - t0:.0f}s)")
    db.commit()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(ROOT, "data", "pa.sqlite"))
    args = ap.parse_args()
    db = sqlite3.connect(args.db)
    db.execute("PRAGMA cache_size = -400000")
    exists = db.execute("SELECT 1 FROM sqlite_master WHERE name = 'donor_rank'").fetchone()
    if not exists:
        schema = open(os.path.join(ROOT, "pipeline", "schema.sql"), encoding="utf-8").read()
        start = schema.index("CREATE TABLE donor_rank")
        db.executescript(schema[start:schema.index(";", start) + 1])
    build_donor_ranks(db)
    n = db.execute("SELECT COUNT(*) FROM donor_rank").fetchone()[0]
    print(f"donor_rank has {n:,} rows")


if __name__ == "__main__":
    main()
