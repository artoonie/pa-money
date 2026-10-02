#!/usr/bin/env python3
"""Validate the cleanup rule files. Runs in CI on every pull request.

Checks format, referential integrity, duplicates and that every data-changing
row has a reason. If data/pa.sqlite exists, also checks that merged donor keys
and grouped filer IDs exist in the data.

Exit code 1 on any error.
"""
import csv
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB = os.path.join(ROOT, "data", "pa.sqlite")
KEY_RE = re.compile(r"^[A-Z0-9 ]*\|[A-Z0-9 ]*\|[A-Z0-9 ]*$")
ENTITY_RE = re.compile(r"^E\d{4,}$")
GROUP_RE = re.compile(r"^G\d{4,}$")
DONOR_KINDS = {"individual", "organization", "committee", "aggregate", "junk"}
ENTITY_KINDS = {"individual", "organization", "committee"}
LOOKUP_FILES = {"cycle": "cycles.csv", "section": "sections.csv", "filer_type": "filer_types.csv", "office": "offices.csv", "party": "parties.csv"}

errors = []


def err(file, line, msg):
    errors.append(f"{file}:{line}: {msg}")


def read(name, required):
    path = os.path.join(HERE, name)
    if not os.path.exists(path):
        err(name, 0, "file missing")
        return []
    with open(path, encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        missing = [c for c in required if c not in (reader.fieldnames or [])]
        if missing:
            err(name, 1, f"missing columns {missing}; header is {reader.fieldnames}")
            return []
        out = []
        for i, row in enumerate(reader, start=2):
            row = {k: (v or "").strip() for k, v in row.items() if k is not None}
            if not any(row.values()):
                continue
            row["_line"] = i
            out.append(row)
        return out


def main():
    entities = read("entities.csv", ["entity_id", "name", "kind", "note"])
    merges = read("donor_merges.csv", ["donor_key", "entity_id", "reason", "evidence", "submitted_by"])
    groups = read("filer_groups.csv", ["filer_id", "group_id", "group_name", "reason"])
    rules = read("reclassify.csv", ["name_normalized", "kind", "reason"])
    lookups = {k: read(os.path.join("lookups", f), ["code", "label", "note"]) for k, f in LOOKUP_FILES.items()}

    ids = set()
    for e in entities:
        if not ENTITY_RE.match(e["entity_id"]):
            err("entities.csv", e["_line"], f"bad entity_id {e['entity_id']!r} (want E0001 style)")
        if e["entity_id"] in ids:
            err("entities.csv", e["_line"], f"duplicate entity_id {e['entity_id']}")
        ids.add(e["entity_id"])
        if not e["name"]:
            err("entities.csv", e["_line"], "empty name")
        if e["kind"] and e["kind"] not in ENTITY_KINDS:
            err("entities.csv", e["_line"], f"kind must be one of {sorted(ENTITY_KINDS)}")

    seen_keys = {}
    by_entity = {}
    for m in merges:
        k = m["donor_key"]
        if not KEY_RE.match(k):
            err("donor_merges.csv", m["_line"], f"bad donor_key {k!r}: must be NAME|CITY|ST, uppercase, no punctuation")
        if k in seen_keys:
            err("donor_merges.csv", m["_line"], f"donor_key already merged on line {seen_keys[k]}")
        seen_keys[k] = m["_line"]
        if m["entity_id"] not in ids:
            err("donor_merges.csv", m["_line"], f"unknown entity_id {m['entity_id']}")
        if len(m["reason"]) < 10:
            err("donor_merges.csv", m["_line"], "reason is required (at least 10 characters)")
        by_entity.setdefault(m["entity_id"], []).append(k)
    for eid, keys in by_entity.items():
        states = {k.rsplit("|", 1)[1] for k in keys}
        if len(states) > 1:
            err("donor_merges.csv", 0, f"entity {eid} merges keys in different states {sorted(states)}; add a note in entities.csv if intended")

    seen_filers = {}
    names = {}
    for g in groups:
        if not GROUP_RE.match(g["group_id"]):
            err("filer_groups.csv", g["_line"], f"bad group_id {g['group_id']!r} (want G0001 style)")
        if g["filer_id"] in seen_filers:
            err("filer_groups.csv", g["_line"], f"filer {g['filer_id']} already grouped on line {seen_filers[g['filer_id']]}")
        seen_filers[g["filer_id"]] = g["_line"]
        names.setdefault(g["group_id"], set()).add(g["group_name"])
        if not g["reason"]:
            err("filer_groups.csv", g["_line"], "reason is required")
    for gid, n in names.items():
        if len(n) > 1:
            err("filer_groups.csv", 0, f"group {gid} has conflicting names {sorted(n)}")

    seen_rules = set()
    for r in rules:
        n = r["name_normalized"]
        if n != re.sub(r"[^A-Z0-9]+", " ", n.upper()).strip():
            err("reclassify.csv", r["_line"], f"name_normalized must be uppercase with punctuation stripped: {n!r}")
        if n in seen_rules:
            err("reclassify.csv", r["_line"], f"duplicate rule for {n}")
        seen_rules.add(n)
        if r["kind"] not in DONOR_KINDS:
            err("reclassify.csv", r["_line"], f"kind must be one of {sorted(DONOR_KINDS)}")
        if not r["reason"]:
            err("reclassify.csv", r["_line"], "reason is required")

    for kind, rows in lookups.items():
        codes = set()
        for row in rows:
            if row["code"] in codes:
                err(f"lookups/{LOOKUP_FILES[kind]}", row["_line"], f"duplicate code {row['code']!r}")
            codes.add(row["code"])
            if not row["label"]:
                err(f"lookups/{LOOKUP_FILES[kind]}", row["_line"], "empty label")

    if os.path.exists(DB):
        db = sqlite3.connect(DB)
        for m in merges:
            if not db.execute("SELECT 1 FROM donor WHERE donor_key = ?", (m["donor_key"],)).fetchone():
                print(f"note: donor_merges.csv:{m['_line']}: key not in the built database (may be a year not loaded): {m['donor_key']}")
        for g in groups:
            if not db.execute("SELECT 1 FROM filer WHERE filer_id = ?", (g["filer_id"],)).fetchone():
                print(f"note: filer_groups.csv:{g['_line']}: filer not in the built database: {g['filer_id']}")
        print("checked keys against data/pa.sqlite")

    if errors:
        print("\n".join(errors))
        print(f"\n{len(errors)} error(s)")
        sys.exit(1)
    print(f"ok: {len(entities)} entities, {len(merges)} merges, {len(groups)} group rows, {len(rules)} rules, "
          + ", ".join(f"{len(v)} {LOOKUP_FILES[k][:-4]}" for k, v in lookups.items()))


if __name__ == "__main__":
    main()
