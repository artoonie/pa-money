#!/usr/bin/env python3
"""One-off repair for a database built before the date_in_amount flag existed.

Emits SQL that adds the flag columns, flags the affected rows, and recomputes only
the aggregate rows those rows touched. Run the SQL against the local database and
against remote D1; then rebuild donor_rank (pipeline/ranks.py) and reload it.

  python3 pipeline/fix_date_amounts.py --db data/pa.sqlite > data/fix.sql
"""
import argparse
import os
import sqlite3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COND = ("amount BETWEEN 19900101 AND 20301231 AND amount = CAST(amount AS INTEGER) AND date IS NULL "
        "AND (CAST(amount AS INTEGER) / 100) % 100 BETWEEN 1 AND 12 AND CAST(amount AS INTEGER) % 100 BETWEEN 1 AND 31")


def q(v):
    return "NULL" if v is None else str(v) if isinstance(v, (int, float)) else "'" + str(v).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(ROOT, "data", "pa.sqlite"))
    args = ap.parse_args()
    db = sqlite3.connect(args.db)
    has_flag = any(r[1] == "flag" for r in db.execute("PRAGMA table_info(contribution)"))
    out = []
    if not has_flag:
        out.append("ALTER TABLE contribution ADD COLUMN flag TEXT;")
        out.append("ALTER TABLE expense ADD COLUMN flag TEXT;")
    crows = db.execute(f"SELECT id, filer_id, eyear, donor_id FROM contribution WHERE {COND}").fetchall()
    erows = db.execute(f"SELECT id, filer_id, eyear FROM expense WHERE {COND}").fetchall()
    if crows:
        out.append(f"UPDATE contribution SET flag = 'date_in_amount' WHERE id IN ({','.join(str(r[0]) for r in crows)});")
    if erows:
        out.append(f"UPDATE expense SET flag = 'date_in_amount' WHERE id IN ({','.join(str(r[0]) for r in erows)});")

    fy = sorted({(f, y) for _, f, y, _ in crows} | {(f, y) for _, f, y in erows})
    fdy = sorted({(f, y, d) for _, f, y, d in crows})
    dy = sorted({(d, y) for _, _, y, d in crows})
    filers = sorted({f for f, _ in fy})
    donors = sorted({d for d, _ in dy})

    for f, y, d in fdy:
        out.append(f"DELETE FROM filer_donor_year WHERE filer_id = {q(f)} AND eyear = {y} AND donor_id = {d};")
        out.append(f"""INSERT INTO filer_donor_year (filer_id, eyear, donor_id, total, inkind, n)
  SELECT filer_id, eyear, donor_id, SUM(amount), SUM(CASE WHEN section IN ('IIF','IIG') THEN amount ELSE 0 END), COUNT(*)
  FROM contribution WHERE filer_id = {q(f)} AND eyear = {y} AND donor_id = {d} AND is_current = 1 AND flag IS NULL GROUP BY filer_id, eyear, donor_id;""")
    for f, y in fy:
        out.append(f"DELETE FROM filer_year WHERE filer_id = {q(f)} AND eyear = {y};")
        out.append(f"""INSERT INTO filer_year (filer_id, eyear, total, cash_committee, cash_other, inkind, n_contrib, n_donors, n_small, expenses)
  SELECT {q(f)}, {y},
    COALESCE((SELECT SUM(amount) FROM contribution WHERE filer_id = {q(f)} AND eyear = {y} AND is_current = 1 AND flag IS NULL), 0),
    COALESCE((SELECT SUM(amount) FROM contribution WHERE filer_id = {q(f)} AND eyear = {y} AND is_current = 1 AND flag IS NULL AND section IN ('IA','IC')), 0),
    COALESCE((SELECT SUM(amount) FROM contribution WHERE filer_id = {q(f)} AND eyear = {y} AND is_current = 1 AND flag IS NULL AND (section IS NULL OR section NOT IN ('IA','IC','IIF','IIG'))), 0),
    COALESCE((SELECT SUM(amount) FROM contribution WHERE filer_id = {q(f)} AND eyear = {y} AND is_current = 1 AND flag IS NULL AND section IN ('IIF','IIG')), 0),
    (SELECT COUNT(*) FROM contribution WHERE filer_id = {q(f)} AND eyear = {y} AND is_current = 1 AND flag IS NULL),
    (SELECT COUNT(DISTINCT donor_id) FROM contribution WHERE filer_id = {q(f)} AND eyear = {y} AND is_current = 1 AND flag IS NULL),
    (SELECT COUNT(*) FROM filer_donor_year WHERE filer_id = {q(f)} AND eyear = {y} AND total <= 250),
    COALESCE((SELECT SUM(amount) FROM expense WHERE filer_id = {q(f)} AND eyear = {y} AND is_current = 1 AND flag IS NULL), 0);""")
        out.append(f"DELETE FROM filer_month WHERE filer_id = {q(f)} AND eyear = {y};")
        out.append(f"""INSERT INTO filer_month (filer_id, eyear, month, total)
  SELECT filer_id, eyear, substr(date, 1, 7), SUM(amount) FROM contribution
  WHERE filer_id = {q(f)} AND eyear = {y} AND is_current = 1 AND flag IS NULL AND date IS NOT NULL GROUP BY substr(date, 1, 7);""")
    for d, y in dy:
        out.append(f"DELETE FROM donor_year WHERE donor_id = {d} AND eyear = {y};")
        out.append(f"""INSERT INTO donor_year (donor_id, eyear, total, n, n_recipients)
  SELECT donor_id, eyear, SUM(total), SUM(n), COUNT(DISTINCT filer_id) FROM filer_donor_year WHERE donor_id = {d} AND eyear = {y} GROUP BY donor_id, eyear;""")
    for f in filers:
        out.append(f"UPDATE filer SET total_all = COALESCE((SELECT SUM(total) FROM filer_year WHERE filer_id = {q(f)}), 0) WHERE filer_id = {q(f)};")
    for d in donors:
        out.append(f"""UPDATE donor SET total_all = COALESCE((SELECT SUM(total) FROM donor_year WHERE donor_id = {d}), 0),
  n_contrib = COALESCE((SELECT SUM(n) FROM donor_year WHERE donor_id = {d}), 0),
  first_year = (SELECT MIN(eyear) FROM donor_year WHERE donor_id = {d}), last_year = (SELECT MAX(eyear) FROM donor_year WHERE donor_id = {d}) WHERE donor_id = {d};""")
    print("\n".join(out))
    import sys
    print(f"-- {len(crows)} contributions, {len(erows)} expenses flagged; {len(fy)} filer-years, {len(dy)} donor-years recomputed", file=sys.stderr)


if __name__ == "__main__":
    main()
