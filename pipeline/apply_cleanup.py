#!/usr/bin/env python3
"""Re-apply the cleanup layer to an existing data/pa.sqlite without rebuilding it from the exports.

  python3 pipeline/apply_cleanup.py [--db data/pa.sqlite] [--delta data/cleanup-delta.sql]

Rebuilds the cleanup tables (entity, donor_entity, filer_group, filer_link, filer_flow, lookup, donor_rank) from
cleanup/ and updates the affected donor and filer rows. It also writes a small SQL file of UPDATE
statements for the donor and filer columns that cleanup sets, so the remote database can be patched
without re-sending the multi-million-row donor table (see scripts/deploy-cleanup.sh).

Reclassification rules are applied additively: a rule that was removed from reclassify.csv keeps its
effect until the next full build, because the heuristic label it replaced is not stored.
"""
import argparse
import csv
import os
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(HERE)
CLEANUP = os.path.join(ROOT, "cleanup")
LOOKUP_FILES = {"cycle": "cycles.csv", "section": "sections.csv", "filer_type": "filer_types.csv", "office": "offices.csv", "party": "parties.csv"}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def read_csv(name):
    path = os.path.join(CLEANUP, name)
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8", newline="") as fh:
        return [{k.strip(): (v or "").strip() for k, v in row.items() if k} for row in csv.DictReader(fh)
                if any((v or "").strip() for v in row.values())]


def lit(v):
    return "NULL" if v is None else repr(v) if isinstance(v, (int, float)) else "'" + str(v).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=os.path.join(ROOT, "data", "pa.sqlite"))
    ap.add_argument("--delta", default=os.path.join(ROOT, "data", "cleanup-delta.sql"))
    args = ap.parse_args()
    db = sqlite3.connect(args.db)
    db.execute("PRAGMA cache_size = -400000")
    schema = open(os.path.join(HERE, "schema.sql"), encoding="utf-8").read()
    for table in ("filer_link", "filer_flow", "donor_rank"):
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (table,)).fetchone():
            start = schema.index(f"CREATE TABLE {table}")
            end = schema.index(";", schema.index(")", start))
            db.executescript(schema[start:end + 1])
            idx = f"CREATE INDEX {table}_"
            if idx in schema:
                i = schema.index(idx)
                db.executescript(schema[i:schema.index(";", i) + 1])
            log(f"created {table}")

    db.execute("DELETE FROM lookup")
    for kind, fname in LOOKUP_FILES.items():
        for row in read_csv(os.path.join("lookups", fname)):
            db.execute("INSERT OR REPLACE INTO lookup (kind, code, label, note) VALUES (?,?,?,?)", (kind, row["code"], row["label"], row.get("note") or None))

    db.execute("DELETE FROM entity")
    for row in read_csv("entities.csv"):
        db.execute("INSERT INTO entity (entity_id, name, kind, note) VALUES (?,?,?,?)", (row["entity_id"], row["name"], row.get("kind") or None, row.get("note") or None))
    db.execute("DELETE FROM donor_entity")
    db.execute("UPDATE donor SET entity_id = NULL WHERE entity_id IS NOT NULL")
    applied = 0
    warnings = []
    for row in read_csv("donor_merges.csv"):
        hit = db.execute("SELECT donor_id FROM donor WHERE donor_key = ?", (row["donor_key"],)).fetchone()
        if not hit:
            warnings.append(f"donor_merges: key not in data: {row['donor_key']}")
            continue
        db.execute("INSERT INTO donor_entity (donor_id, entity_id, donor_key, reason, evidence, submitted_by) VALUES (?,?,?,?,?,?)",
                   (hit[0], row["entity_id"], row["donor_key"], row["reason"], row.get("evidence") or None, row.get("submitted_by") or None))
        db.execute("UPDATE donor SET entity_id = ? WHERE donor_id = ?", (row["entity_id"], hit[0]))
        applied += 1
    log(f"{applied} donor merges applied")

    db.execute("DELETE FROM filer_group")
    db.execute("UPDATE filer SET group_id = NULL WHERE group_id IS NOT NULL")
    groups = read_csv("filer_groups.csv")
    for row in groups:
        db.execute("INSERT INTO filer_group (filer_id, group_id, group_name, reason) VALUES (?,?,?,?)", (row["filer_id"], row["group_id"], row["group_name"], row.get("reason") or None))
        db.execute("UPDATE filer SET group_id = ? WHERE filer_id = ?", (row["group_id"], row["filer_id"]))
    log(f"{len(groups)} filer group rows")

    rules = read_csv("reclassify.csv")
    for row in rules:
        db.execute("UPDATE donor SET kind = ?, kind_source = 'rule' WHERE donor_key LIKE ? || '|%' AND NOT (kind = ? AND kind_source = 'rule')",
                   (row["kind"], row["name_normalized"], row["kind"]))
    log(f"{len(rules)} reclassification rules")
    db.commit()

    from links import build_filer_links
    warnings.extend(build_filer_links(db, log))
    from ranks import build_donor_ranks
    build_donor_ranks(db, log)

    # Delta: idempotent UPDATEs that bring any copy of this build's donor and filer tables to the cleanup state
    # above, whatever cleanup state it had before. A few hundred rows at most, so it is independent of history.
    ents = db.execute("SELECT donor_id, entity_id FROM donor WHERE entity_id IS NOT NULL ORDER BY donor_id").fetchall()
    ruled = db.execute("SELECT donor_id, kind FROM donor WHERE kind_source = 'rule' ORDER BY donor_id").fetchall()
    grouped = db.execute("SELECT filer_id, group_id FROM filer WHERE group_id IS NOT NULL ORDER BY filer_id").fetchall()
    lines = ["-- Written by pipeline/apply_cleanup.py: the donor and filer columns that cleanup rules set.", "PRAGMA defer_foreign_keys = TRUE;"]
    lines.append(f"UPDATE donor SET entity_id = NULL WHERE entity_id IS NOT NULL{' AND donor_id NOT IN (' + ','.join(str(d) for d, _ in ents) + ')' if ents else ''};")
    lines += [f"UPDATE donor SET entity_id = {lit(e)} WHERE donor_id = {d};" for d, e in ents]
    lines += [f"UPDATE donor SET kind = {lit(k)}, kind_source = 'rule' WHERE donor_id = {d};" for d, k in ruled]
    lines.append(f"UPDATE filer SET group_id = NULL WHERE group_id IS NOT NULL{' AND filer_id NOT IN (' + ','.join(lit(f) for f, _ in grouped) + ')' if grouped else ''};")
    lines += [f"UPDATE filer SET group_id = {lit(g)} WHERE filer_id = {lit(f)};" for f, g in grouped]
    with open(args.delta, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    log(f"{len(lines) - 2} statements written to {args.delta}")
    for w in warnings:
        log("warning: " + w)
    db.commit()
    db.close()


if __name__ == "__main__":
    main()
