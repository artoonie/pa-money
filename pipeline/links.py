#!/usr/bin/env python3
"""(Re)build filer_link (which donor keys are committees that file their own reports) and filer_flow (what each
filer passed on through those keys).

build.py calls build_filer_links() during the cleanup step; run this directly to refresh the links in a
database you already have (for example after editing cleanup/filer_links.csv):

  python3 pipeline/links.py [--db data/pa.sqlite]

Two sources, rules first:
  rule  A row in cleanup/filer_links.csv. A row with an empty filer_id blocks the name match for that key.
  name  The donor's normalized name equals a name that exactly one committee filer has ever used (any filer
        that is not a candidate or lobbyist record; a few committees have no type in the export), the donor is labeled a committee or organization, and the donor's state is blank or equal to
        the filer's. Exact match only; no fuzzy matching.
"""
import argparse
import csv
import os
import re
import sqlite3
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLEANUP = os.path.join(ROOT, "cleanup")


def norm(s):
    return re.sub(r"[^A-Z0-9]+", " ", (s or "").upper()).strip()


def read_rules():
    path = os.path.join(CLEANUP, "filer_links.csv")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8", newline="") as fh:
        return [{k.strip(): (v or "").strip() for k, v in row.items() if k} for row in csv.DictReader(fh)
                if any((v or "").strip() for v in row.values())]


def build_filer_links(db, log=print):
    db.execute("DELETE FROM filer_link")
    rules = read_rules()
    ruled = {}        # donor_key -> rule row (filer_id may be empty = block)
    for r in rules:
        ruled[r["donor_key"]] = r

    names = defaultdict(set)
    state = {}
    for fid, name, st in db.execute(
            "SELECT n.filer_id, n.name, f.state FROM filer_name n JOIN filer f ON f.filer_id = n.filer_id "
            "WHERE COALESCE(f.filer_type, '') NOT IN ('1', '3')"):
        names[norm(name)].add(fid)
        state[fid] = norm(st)

    rows = []
    n_rule = n_name = n_blocked = 0
    # Reviewed rules first, whatever the donor's kind.
    for key, rule in list(ruled.items()):
        hit = db.execute("SELECT donor_id FROM donor WHERE donor_key = ?", (key,)).fetchone()
        if not hit:
            continue
        ruled.pop(key)
        if rule["filer_id"]:
            rows.append((hit[0], rule["filer_id"], "rule", rule["reason"], rule.get("evidence") or None, rule.get("submitted_by") or None))
            n_rule += 1
        else:
            n_blocked += 1
    done = {r[0] for r in rows}
    for did, key in db.execute("SELECT donor_id, donor_key FROM donor WHERE kind IN ('committee','organization')"):
        if did in done or key in ruled:
            continue
        name, _, st = key.split("|")
        fids = names.get(name)
        if not fids or len(fids) != 1:
            continue
        fid = next(iter(fids))
        if st and state.get(fid) and st != state[fid]:
            continue
        rows.append((did, fid, "name", None, None, None))
        n_name += 1
    n_missing = len(ruled)
    db.executemany("INSERT INTO filer_link (donor_id, filer_id, source, reason, evidence, submitted_by) VALUES (?,?,?,?,?,?)", rows)
    db.execute("DELETE FROM filer_flow")
    db.execute("""
        INSERT INTO filer_flow (filer_id, eyear, passed_on, n_recipients)
        SELECT l.filer_id, fd.eyear, SUM(fd.total), COUNT(DISTINCT fd.filer_id)
        FROM filer_link l JOIN filer_donor_year fd ON fd.donor_id = l.donor_id GROUP BY l.filer_id, fd.eyear""")
    db.execute("""
        INSERT INTO filer_flow (filer_id, eyear, passed_on, n_recipients)
        SELECT l.filer_id, 0, SUM(fd.total), COUNT(DISTINCT fd.filer_id)
        FROM filer_link l JOIN filer_donor_year fd ON fd.donor_id = l.donor_id GROUP BY l.filer_id""")
    db.commit()
    log(f"filer_link: {n_name:,} by exact name, {n_rule} by rule, {n_blocked} blocked by rule"
        + (f", {n_missing} rule keys not in the data" if n_missing else ""))
    return [f"filer_links: key not in data (fine if the year is not loaded): {k}" for k in ruled]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(ROOT, "data", "pa.sqlite"))
    args = ap.parse_args()
    db = sqlite3.connect(args.db)
    schema = open(os.path.join(ROOT, "pipeline", "schema.sql"), encoding="utf-8").read()
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name = 'filer_link'").fetchone():
        start = schema.index("CREATE TABLE filer_link")
        end = schema.index("CREATE INDEX filer_link_filer")
        db.executescript(schema[start:schema.index(";", end) + 1])
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name = 'filer_flow'").fetchone():
        start = schema.index("CREATE TABLE filer_flow")
        db.executescript(schema[start:schema.index(";", start) + 1])
    for w in build_filer_links(db):
        print("warning:", w)
    n = db.execute("SELECT COUNT(*) FROM filer_link").fetchone()[0]
    print(f"filer_link has {n:,} rows")


if __name__ == "__main__":
    main()
