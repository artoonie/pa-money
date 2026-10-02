#!/usr/bin/env python3
"""Download the PA Department of State campaign finance full-export ZIPs.

Usage:
  python3 pipeline/download.py                 # every year, 2000 to current
  python3 pipeline/download.py --years 2024    # one year
  python3 pipeline/download.py --years 2020-2024,2026

Files land in data/raw/<year>.zip. Existing files are skipped unless --force.
"""
import argparse
import datetime
import os
import sys
import urllib.request

BASE = ("https://www.pa.gov/content/dam/copapwp-pagov/en/dos/resources/"
        "voting-and-elections/campaign-finance/campaign-finance-data/")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
FIRST_YEAR = 2000


def parse_years(spec):
    if not spec:
        return list(range(FIRST_YEAR, datetime.date.today().year + 1))
    years = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            years.update(range(int(a), int(b) + 1))
        elif part:
            years.add(int(part))
    return sorted(years)


def fetch(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "pa-money-pipeline/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest + ".part", "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            if total:
                sys.stdout.write(f"\r  {done / 1e6:7.1f} / {total / 1e6:.1f} MB")
                sys.stdout.flush()
    os.replace(dest + ".part", dest)
    print()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--years", help="e.g. 2024 or 2020-2024,2026 (default: all)")
    ap.add_argument("--force", action="store_true", help="re-download existing files")
    args = ap.parse_args()

    os.makedirs(RAW, exist_ok=True)
    for year in parse_years(args.years):
        dest = os.path.join(RAW, f"{year}.zip")
        if os.path.exists(dest) and not args.force:
            print(f"{year}: already have {dest}")
            continue
        url = f"{BASE}{year}.zip"
        print(f"{year}: {url}")
        try:
            fetch(url, dest)
        except Exception as exc:  # noqa: BLE001
            print(f"  failed: {exc}")

    readme = os.path.join(RAW, "readme-cf-data.txt")
    if not os.path.exists(readme):
        try:
            fetch(BASE + "readme-cf-data.txt", readme)
        except Exception as exc:  # noqa: BLE001
            print(f"readme failed: {exc}")


if __name__ == "__main__":
    main()
