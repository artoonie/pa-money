#!/usr/bin/env python3
"""Build data/pa.sqlite from the Department of State export ZIPs plus cleanup rules.

Usage:
  python3 pipeline/build.py --years 2024
  python3 pipeline/build.py                  # every zip present in data/raw

Steps:
  1. Load every report row (filer_YYYY.txt) and decide which reports are current.
     A report is superseded when a later report exists for the same filer, year and cycle.
  2. Load contributions, expenses, debts and receipts, tagging each with is_current.
  3. Apply cleanup/: lookups, entity merges, filer groups, reclassifications, committee-to-filer links.
  4. Build aggregates and full-text indexes.
"""
import argparse
import csv
import sys as _sys
_sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import datetime
import glob
import html
import io
import json
import os
import re
import sqlite3
import sys
import time
import zipfile
from collections import defaultdict

csv.field_size_limit(1 << 30)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, "data", "raw")
CLEANUP = os.path.join(ROOT, "cleanup")
OUT = os.path.join(ROOT, "data", "pa.sqlite")
ENCODING = "cp1252"
BATCH = 50_000
LOOKUP_FILES = {"cycle": "cycles.csv", "section": "sections.csv", "filer_type": "filer_types.csv", "office": "offices.csv", "party": "parties.csv"}

COMMITTEE_SECTIONS = ("IA", "IC")
INKIND_SECTIONS = ("IIF", "IIG")
# Placeholder names filers use for lump sums; these are not donors and are kept out of rankings.
AGG_WORDS = re.compile(
    r"\b(AGGREGATE|UNITEMIZED|NON PA|NON PENNSYLVANIA|OUT OF STATE|SEE PAPER FILING|SEE FEC FILING|FEC REPORT|"
    r"TOTAL OTHER|MISCELLANEOUS|VARIOUS|NUMEROUS|MULTIPLE DONORS|SMALL CONTRIBUTIONS|LESS THAN|UNDER 50|UNDER 250|"
    r"CONTRIBUTIONS OF|CONTRIBUTIONS FROM|ANONYMOUS)\b"
)
ORG_WORDS = re.compile(
    r"\b(PAC|COMMITT+E+|COMM|COM|FUND|HDCC|HRCC|SDCC|SRCC|DLCC|RSLC|DGA|RGA|RAGA|DAGA|ACTBLUE|WINRED|EMILY S LIST|ASSOC|ASSOCIATION|ASSN|UNION|LOCAL \d+|LLC|L L C|INC|CORP|"
    r"CORPORATION|LLP|LP|L P|COUNCIL|PARTNERS|PARTNERSHIP|GROUP|CO|COMPANY|CAUCUS|PARTY|DEMOCRATS|"
    r"REPUBLICANS|FEDERATION|BROTHERHOOD|ALLIANCE|LEAGUE|TRUST|FOUNDATION|BANK|HOLDINGS|ENTERPRISES|"
    r"INDUSTRIES|SERVICES|SYSTEMS|REALTY|PROPERTIES|DBA|D B A|AFL CIO|IBEW|SEIU|AFSCME|UFCW|PSEA|ASSOCIATES|VENTURES|"
    r"CAPITAL|MANAGEMENT|INVESTMENTS|CONSULTING|CONSULTANTS|LTD|PLLC|P C|DEVELOPMENT|CONSTRUCTION|CONTRACTORS|BUILDERS|"
    r"DISTRIBUTORS|CLUB|CENTER|CHURCH|SCHOOL|ESTATE|ESTATES|AGENCY|INSURANCE|HOSPITAL|HEALTH|MEDICAL|DENTAL|PHARMACY|"
    r"RESTAURANT|FARMS|FARM|MARKET|STORES|SUPPLY|LOGISTICS|TRUCKING|ENERGY|GAS|OIL|STEEL|MINING|MOTORS|AUTO|TOWNSHIP|"
    r"BOROUGH|COUNTY|CITY OF|FRIENDS OF|CITIZENS FOR|COMMITTEE TO|PEOPLE FOR|VOTERS|COALITION|ORGANIZING|ORGANIZATION|"
    r"ACTION|VICTORY|LEADERSHIP|MAJORITY|PROJECT|INSTITUTE|SOCIETY|ASSEMBLY|CONFERENCE|CHAMBER|BUREAU|GUILD|LODGE|POST \d+)\b"
)


def log(msg):
    sys.stdout.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    sys.stdout.flush()


def norm(s):
    return re.sub(r"[^A-Z0-9]+", " ", (s or "").upper()).strip()


def donor_key(name, city, state):
    return f"{norm(name)}|{norm(city)}|{norm(state)}"


def amt(s):
    try:
        return float((s or "0").replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def ymd(s):
    s = (s or "").strip()
    if len(s) == 8 and s.isdigit() and s[:4] != "0000":
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    if len(s) == 10 and s[4] == "-":
        return s
    return None


def date_in_amount(amount, date):
    """True when the amount field holds a YYYYMMDD date and the date field is empty (a column shift in some filings)."""
    if date is not None or amount != int(amount) or not (19900101 <= amount <= 20301231):
        return False
    a = int(amount)
    return 1 <= (a // 100) % 100 <= 12 and 1 <= a % 100 <= 31


def intval(s):
    try:
        return int((s or "").strip())
    except ValueError:
        return None


def yn(s):
    return 1 if (s or "").strip().upper() == "Y" else 0


def clean(s):
    # The export contains HTML entities such as &amp; inside names.
    return html.unescape((s or "").strip()) or None


def parse_years(spec):
    if not spec:
        return sorted(int(os.path.basename(p)[:4]) for p in glob.glob(os.path.join(RAW, "[0-9][0-9][0-9][0-9].zip")))
    years = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            years.update(range(int(a), int(b) + 1))
        elif part:
            years.add(int(part))
    return sorted(years)


def open_member(zf, suffix):
    for info in zf.infolist():
        if info.filename.lower().endswith(suffix.lower()):
            return io.TextIOWrapper(zf.open(info), encoding=ENCODING, errors="replace", newline="")
    return None


def rows(zf, suffix):
    fh = open_member(zf, suffix)
    if fh is None:
        return
    reader = csv.reader(fh)
    header = [h.strip().upper() for h in next(reader)]
    idx = {h: i for i, h in enumerate(header)}
    for raw in reader:
        if not raw:
            continue
        if len(raw) < len(header):
            raw = raw + [""] * (len(header) - len(raw))
        yield {h: raw[i] for h, i in idx.items()}


class Builder:
    def __init__(self, out, years):
        self.years = years
        if os.path.exists(out):
            os.remove(out)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        self.db = sqlite3.connect(out)
        self.db.execute("PRAGMA journal_mode = OFF")
        self.db.execute("PRAGMA synchronous = OFF")
        self.db.execute("PRAGMA cache_size = -400000")
        self.db.execute("PRAGMA temp_store = MEMORY")
        with open(os.path.join(HERE, "schema.sql"), encoding="utf-8") as fh:
            self.db.executescript(fh.read())
        self.current = set()          # cf_ids of current reports
        self.donors = {}              # donor_key -> donor_id
        self.next_donor = 1
        self.pending_donors = []
        self.warnings = []

    # ---- step 1: reports -------------------------------------------------
    def load_reports(self):
        best = {}        # (filer_id, eyear, cycle) -> (submitted, cf_id)
        filer_attrs = {}  # filer_id -> (sortkey, attrs)
        names = {}
        batch = []
        for year in self.years:
            path = os.path.join(RAW, f"{year}.zip")
            with zipfile.ZipFile(path) as zf:
                n = 0
                for r in rows(zf, f"filer_{year}.txt"):
                    cf_id = intval(r.get("CAMPAIGNFINANCEID"))
                    filer_id = clean(r.get("FILERID"))
                    if cf_id is None or not filer_id:
                        continue
                    eyear = intval(r.get("EYEAR")) or year
                    cycle = intval(r.get("CYCLE"))
                    submitted = ymd(r.get("SUBMITTEDDATE")) or ""
                    key = (filer_id, eyear, cycle)
                    cand = (submitted, cf_id)
                    if key not in best or cand > best[key]:
                        best[key] = cand
                    batch.append((cf_id, filer_id, eyear, cycle, submitted or None, yn(r.get("AMMEND")),
                                  yn(r.get("TERMINATE")), amt(r.get("BEGINNING")), amt(r.get("MONETARY")),
                                  amt(r.get("INKIND"))))
                    name = clean(r.get("FILERNAME")) or filer_id
                    sortkey = (eyear, submitted, cf_id)
                    if filer_id not in filer_attrs or sortkey > filer_attrs[filer_id][0]:
                        filer_attrs[filer_id] = (sortkey, {
                            "name": name, "filer_type": clean(r.get("FILERTYPE")), "office": clean(r.get("OFFICE")),
                            "district": clean(r.get("DISTRICT")), "party": clean(r.get("PARTY")),
                            "city": clean(r.get("CITY")), "state": clean(r.get("STATE")), "zip": clean(r.get("ZIPCODE")),
                            "county": clean(r.get("COUNTY")),
                        })
                    nk = (filer_id, name)
                    if nk not in names or eyear > names[nk]:
                        names[nk] = eyear
                    n += 1
                log(f"{year}: {n:,} report rows")
        self.db.executemany(
            "INSERT OR REPLACE INTO report (cf_id, filer_id, eyear, cycle, submitted, amend, terminate, beginning, monetary, inkind) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)", batch)
        self.current = {cf for (_, cf) in best.values()}
        self.db.execute("UPDATE report SET is_current = 0")
        self.db.executemany("UPDATE report SET is_current = 1 WHERE cf_id = ?", [(cf,) for cf in self.current])
        self.db.executemany(
            "INSERT INTO filer (filer_id, name, filer_type, office, district, party, city, state, zip, county) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            [(fid, a["name"], a["filer_type"], a["office"], a["district"], a["party"], a["city"], a["state"], a["zip"], a["county"])
             for fid, (_, a) in filer_attrs.items()])
        self.db.executemany("INSERT OR REPLACE INTO filer_name (filer_id, name, eyear) VALUES (?,?,?)",
                            [(fid, name, ey) for (fid, name), ey in names.items()])
        self.db.execute("UPDATE filer SET first_year = (SELECT MIN(eyear) FROM report r WHERE r.filer_id = filer.filer_id), "
                        "last_year = (SELECT MAX(eyear) FROM report r WHERE r.filer_id = filer.filer_id)")
        self.db.commit()
        log(f"{len(batch):,} reports, {len(self.current):,} current, {len(filer_attrs):,} filers")

    # ---- step 2: transactions -------------------------------------------
    def donor_id_for(self, name, city, state, employer, occupation):
        key = donor_key(name, city, state)
        did = self.donors.get(key)
        if did is None:
            did = self.next_donor
            self.next_donor += 1
            self.donors[key] = did
            self.pending_donors.append((did, key, (name or "").strip() or "(blank)", clean(city), clean(state),
                                        clean(employer), clean(occupation)))
        return did

    def flush_donors(self):
        if self.pending_donors:
            self.db.executemany(
                "INSERT INTO donor (donor_id, donor_key, name, city, state, employer, occupation) VALUES (?,?,?,?,?,?,?)",
                self.pending_donors)
            self.pending_donors = []

    def load_transactions(self):
        for year in self.years:
            path = os.path.join(RAW, f"{year}.zip")
            with zipfile.ZipFile(path) as zf:
                self._load_contributions(zf, year)
                self._load_simple(zf, year, f"expense_{year}.txt", "expense", "payee", "EXPNAME", "EXPDATE", "EXPAMT", "EXPDESC")
                self._load_simple(zf, year, f"debt_{year}.txt", "debt", "creditor", "DBTNAME", "DBTDATE", "DBTAMT", "DBTDESC")
                self._load_simple(zf, year, f"receipt_{year}.txt", "receipt", "source", "RECNAME", "RECDATE", "RECAMT", "RECDESC")
            self.db.commit()

    def _load_contributions(self, zf, year):
        batch = []
        n = 0
        sql = ("INSERT INTO contribution (cf_id, filer_id, eyear, cycle, section, donor_id, contributor, city, state, zip, "
               "occupation, employer, date, amount, description, is_current, flag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        for r in rows(zf, f"contrib_{year}.txt"):
            cf_id = intval(r.get("CAMPAIGNFINANCEID"))
            filer_id = clean(r.get("FILERID"))
            if cf_id is None or not filer_id:
                continue
            eyear = intval(r.get("EYEAR")) or year
            cycle = intval(r.get("CYCLE"))
            section = (r.get("SECTION") or "").strip().upper() or None
            name = html.unescape(r.get("CONTRIBUTOR") or "")
            city, state = r.get("CITY"), r.get("STATE")
            did = self.donor_id_for(name, city, state, r.get("ENAME"), r.get("OCCUPATION"))
            is_current = 1 if (cf_id in self.current or not self._known_report(cf_id)) else 0
            base = (cf_id, filer_id, eyear, cycle, section, did, clean(name), clean(city), clean(state), clean(r.get("ZIPCODE")),
                    clean(r.get("OCCUPATION")), clean(r.get("ENAME")))
            desc = clean(r.get("CONTDESC"))
            for dcol, acol in (("CONTDATE1", "CONTAMT1"), ("CONTDATE2", "CONTAMT2"), ("CONTDATE3", "CONTAMT3")):
                a = amt(r.get(acol))
                d = ymd(r.get(dcol))
                if a == 0 and dcol != "CONTDATE1":
                    continue
                batch.append(base + (d, a, desc, is_current, "date_in_amount" if date_in_amount(a, d) else None))
                n += 1
            if len(batch) >= BATCH:
                self.flush_donors()
                self.db.executemany(sql, batch)
                batch = []
        self.flush_donors()
        if batch:
            self.db.executemany(sql, batch)
        log(f"{year}: {n:,} contributions, {len(self.donors):,} donors so far")

    def _known_report(self, cf_id):
        # Reports missing from the filer file (a handful per year) are treated as current.
        if not hasattr(self, "_report_ids"):
            self._report_ids = {row[0] for row in self.db.execute("SELECT cf_id FROM report")}
        return cf_id in self._report_ids

    def _load_simple(self, zf, year, suffix, table, namecol, NAME, DATE, AMT, DESC):
        batch = []
        n = 0
        flagged = table == "expense"
        sql = (f"INSERT INTO {table} (cf_id, filer_id, eyear, cycle, {namecol}, city, state, zip, date, amount, description, is_current"
               f"{', flag' if flagged else ''}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?{',?' if flagged else ''})")
        for r in rows(zf, suffix):
            cf_id = intval(r.get("CAMPAIGNFINANCEID"))
            filer_id = clean(r.get("FILERID"))
            if cf_id is None or not filer_id:
                continue
            is_current = 1 if cf_id in self.current or not self._known_report(cf_id) else 0
            d, a = ymd(r.get(DATE)), amt(r.get(AMT))
            row = (cf_id, filer_id, intval(r.get("EYEAR")) or year, intval(r.get("CYCLE")), clean(r.get(NAME)),
                   clean(r.get("CITY")), clean(r.get("STATE")), clean(r.get("ZIPCODE")), d, a, clean(r.get(DESC)), is_current)
            batch.append(row + (("date_in_amount" if date_in_amount(a, d) else None),) if flagged else row)
            n += 1
            if len(batch) >= BATCH:
                self.db.executemany(sql, batch)
                batch = []
        if batch:
            self.db.executemany(sql, batch)
        log(f"{year}: {n:,} {table} rows")

    # ---- step 3: cleanup --------------------------------------------------
    def read_csv(self, name):
        path = os.path.join(CLEANUP, name)
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8", newline="") as fh:
            return [{k.strip(): (v or "").strip() for k, v in row.items()} for row in csv.DictReader(fh)
                    if any((v or "").strip() for v in row.values())]

    def apply_cleanup(self):
        db = self.db
        for kind, fname in LOOKUP_FILES.items():
            for row in self.read_csv(os.path.join("lookups", fname)):
                db.execute("INSERT OR REPLACE INTO lookup (kind, code, label, note) VALUES (?,?,?,?)",
                           (kind, row["code"], row["label"], row.get("note") or None))

        for row in self.read_csv("entities.csv"):
            db.execute("INSERT OR REPLACE INTO entity (entity_id, name, kind, note) VALUES (?,?,?,?)",
                       (row["entity_id"], row["name"], row.get("kind") or None, row.get("note") or None))

        merges = self.read_csv("donor_merges.csv")
        applied = 0
        for row in merges:
            did = self.donors.get(row["donor_key"])
            if did is None:
                self.warnings.append(f"donor_merges: key not in data (fine if the year is not loaded): {row['donor_key']}")
                continue
            db.execute("INSERT OR REPLACE INTO donor_entity (donor_id, entity_id, donor_key, reason, evidence, submitted_by) VALUES (?,?,?,?,?,?)",
                       (did, row["entity_id"], row["donor_key"], row["reason"], row.get("evidence") or None, row.get("submitted_by") or None))
            db.execute("UPDATE donor SET entity_id = ? WHERE donor_id = ?", (row["entity_id"], did))
            applied += 1
        log(f"cleanup: {applied} of {len(merges)} donor merges applied")

        groups = self.read_csv("filer_groups.csv")
        for row in groups:
            db.execute("INSERT OR REPLACE INTO filer_group (filer_id, group_id, group_name, reason) VALUES (?,?,?,?)",
                       (row["filer_id"], row["group_id"], row["group_name"], row.get("reason") or None))
            db.execute("UPDATE filer SET group_id = ? WHERE filer_id = ?", (row["group_id"], row["filer_id"]))
        log(f"cleanup: {len(groups)} filer group rows")

        # Donor kind: schedule first, then explicit rules, then the keyword heuristic.
        db.execute("""
            UPDATE donor SET kind = 'committee', kind_source = 'schedule'
            WHERE donor_id IN (SELECT DISTINCT donor_id FROM contribution WHERE section IN ('IA','IC'))""")
        rules = self.read_csv("reclassify.csv")
        for row in rules:
            db.execute("UPDATE donor SET kind = ?, kind_source = 'rule' WHERE donor_key LIKE ? || '|%'",
                       (row["kind"], row["name_normalized"]))
        log(f"cleanup: {len(rules)} reclassification rules")
        todo = db.execute("SELECT donor_id, donor_key FROM donor WHERE kind IS NULL").fetchall()
        upd = []
        for did, key in todo:
            name = key.split("|", 1)[0]
            kind = "aggregate" if AGG_WORDS.search(name) else "organization" if ORG_WORDS.search(name) else "individual"
            upd.append((kind, did))
        db.executemany("UPDATE donor SET kind = ?, kind_source = 'heuristic' WHERE donor_id = ?", upd)
        db.commit()
        # Which committee donors are filers themselves (needs the kinds above).
        from links import build_filer_links
        self.warnings.extend(build_filer_links(db, log))

    # ---- step 4: aggregates ------------------------------------------------
    def aggregate(self):
        db = self.db
        log("aggregates: filer_donor_year")
        db.execute("""
            INSERT INTO filer_donor_year (filer_id, eyear, donor_id, total, inkind, n)
            SELECT filer_id, eyear, donor_id, SUM(amount),
                   SUM(CASE WHEN section IN ('IIF','IIG') THEN amount ELSE 0 END), COUNT(*)
            FROM contribution WHERE is_current = 1 AND flag IS NULL GROUP BY filer_id, eyear, donor_id""")
        log("aggregates: filer_year")
        db.execute("""
            INSERT INTO filer_year (filer_id, eyear, total, cash_committee, cash_other, inkind, n_contrib, n_donors, n_small)
            SELECT c.filer_id, c.eyear, SUM(c.amount),
                   SUM(CASE WHEN c.section IN ('IA','IC') THEN c.amount ELSE 0 END),
                   SUM(CASE WHEN c.section IN ('IIF','IIG') OR c.section IN ('IA','IC') THEN 0 ELSE c.amount END),
                   SUM(CASE WHEN c.section IN ('IIF','IIG') THEN c.amount ELSE 0 END),
                   COUNT(*), COUNT(DISTINCT c.donor_id), 0
            FROM contribution c WHERE c.is_current = 1 AND c.flag IS NULL GROUP BY c.filer_id, c.eyear""")
        db.execute("""
            UPDATE filer_year SET n_small = (
                SELECT COUNT(*) FROM filer_donor_year d
                WHERE d.filer_id = filer_year.filer_id AND d.eyear = filer_year.eyear AND d.total <= 250)""")
        db.execute("""
            UPDATE filer_year SET expenses = COALESCE((
                SELECT SUM(amount) FROM expense e
                WHERE e.filer_id = filer_year.filer_id AND e.eyear = filer_year.eyear AND e.is_current = 1 AND e.flag IS NULL), 0)""")
        # Filers with expenses but no contributions still need a row so the year shows up.
        db.execute("""
            INSERT OR IGNORE INTO filer_year (filer_id, eyear, total, cash_committee, cash_other, inkind, n_contrib, n_donors, n_small, expenses)
            SELECT filer_id, eyear, 0, 0, 0, 0, 0, 0, 0, SUM(amount) FROM expense WHERE is_current = 1 AND flag IS NULL GROUP BY filer_id, eyear""")
        log("aggregates: filer_month")
        db.execute("""
            INSERT INTO filer_month (filer_id, eyear, month, total)
            SELECT filer_id, eyear, substr(date, 1, 7), SUM(amount)
            FROM contribution WHERE is_current = 1 AND flag IS NULL AND date IS NOT NULL GROUP BY filer_id, eyear, substr(date, 1, 7)""")
        log("aggregates: donor_year")
        db.execute("""
            INSERT INTO donor_year (donor_id, eyear, total, n, n_recipients)
            SELECT donor_id, eyear, SUM(total), SUM(n), COUNT(DISTINCT filer_id)
            FROM filer_donor_year GROUP BY donor_id, eyear""")
        log("aggregates: totals on filer and donor")
        db.execute("""
            UPDATE filer SET total_all = COALESCE((SELECT SUM(total) FROM filer_year y WHERE y.filer_id = filer.filer_id), 0)""")
        db.execute("""
            UPDATE donor SET
              total_all = COALESCE((SELECT SUM(total) FROM donor_year y WHERE y.donor_id = donor.donor_id), 0),
              n_contrib = COALESCE((SELECT SUM(n) FROM donor_year y WHERE y.donor_id = donor.donor_id), 0),
              first_year = (SELECT MIN(eyear) FROM donor_year y WHERE y.donor_id = donor.donor_id),
              last_year = (SELECT MAX(eyear) FROM donor_year y WHERE y.donor_id = donor.donor_id)""")
        from ranks import build_donor_ranks
        build_donor_ranks(db, log)
        log("full-text indexes")
        db.execute("INSERT INTO filer_fts (name, filer_id) SELECT name, filer_id FROM filer_name")
        db.execute("INSERT INTO donor_fts (name, city, employer, donor_id) SELECT name, city, employer, donor_id FROM donor")
        db.commit()

    def write_meta(self):
        db = self.db
        counts = {t: db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                  for t in ("filer", "report", "donor", "contribution", "expense")}
        # Default year for landing pages: the most recent year with at least a tenth of the biggest year's money,
        # so a freshly started year with a handful of reports does not become the default.
        totals = db.execute("SELECT eyear, SUM(total) FROM filer_year GROUP BY eyear ORDER BY eyear").fetchall()
        biggest = max((t for _, t in totals), default=0)
        candidates = [y for y, t in totals if t >= 0.1 * biggest]
        default_year = candidates[-1] if candidates else (self.years[-1] if self.years else None)
        meta = {
            "built_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "years": self.years,
            "default_year": default_year,
            "counts": counts,
            "source": "https://www.pa.gov/agencies/dos/resources/voting-and-elections-resources/campaign-finance-data.html",
            "warnings": self.warnings[:50],
        }
        for k, v in meta.items():
            db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (k, json.dumps(v)))
        db.commit()
        log("meta: " + json.dumps(counts))

    def finish(self):
        self.db.execute("PRAGMA journal_mode = DELETE")
        self.db.commit()
        log("vacuum")
        self.db.execute("VACUUM")
        self.db.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--years", help="e.g. 2024 or 2020-2024 (default: every zip in data/raw)")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()
    years = parse_years(args.years)
    missing = [y for y in years if not os.path.exists(os.path.join(RAW, f"{y}.zip"))]
    if missing:
        sys.exit(f"missing zips for {missing}; run pipeline/download.py first")
    if not years:
        sys.exit("no years to build")
    t0 = time.time()
    b = Builder(args.out, years)
    b.load_reports()
    b.load_transactions()
    b.apply_cleanup()
    b.aggregate()
    b.write_meta()
    b.finish()
    for w in b.warnings:
        log("warning: " + w)
    log(f"done in {time.time() - t0:.0f}s -> {args.out} ({os.path.getsize(args.out) / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
