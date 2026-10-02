# PA Money

A searchable database of Pennsylvania campaign finance filings, built from the
Department of State's public full export. Search by who gave and who received,
follow money between committees, and audit every data cleanup in the open.

- **Source data:** the PA Department of State full export, one ZIP per year
  from 2000 to the present. The pipeline downloads them directly and never
  touches the state's search site.
- **Cleanup is a public layer.** The raw filings are never edited. Every merge,
  reclassification, grouping, and code label lives in `cleanup/` as a CSV with a
  reason, and the site links each one back to this repo. Nothing is merged
  automatically. See `cleanup/README.md` to propose a change.
- **Hosting:** one Cloudflare Worker serving a static front end and a JSON API
  backed by a D1 (SQLite) database.

## Layout

```
pipeline/   download the exports, build data/pa.sqlite, dump SQL for D1
cleanup/    human-reviewed rules (merges, groupings, reclassifications, code labels)
web/        the Cloudflare Worker: API in src/, static site in public/
scripts/    load the database into local or remote D1
```

## Quick start

Requirements: Python 3.11+, Node 20+, an existing Cloudflare account only for
deploying.

```bash
# 1. Download the exports you want (all years is ~590 MB)
python3 pipeline/download.py --years 2024

# 2. Build the SQLite database with cleanup rules applied
python3 pipeline/build.py --years 2024

# 3. Run the site locally against that database
cd web && npm install && cd ..
scripts/local-db.sh
cd web && npx wrangler dev
```

Then open http://localhost:8787.

### Full history

`python3 pipeline/download.py` with no arguments fetches every year. The full
build holds a few million donor keys in memory and takes a while; expect
roughly 4 GB of RAM and a database of several gigabytes. Cloudflare D1 allows
10 GB per database on the paid Workers plan and 500 MB on the free plan.

## Deploying

One-time setup, from your machine:

```bash
cd web
npx wrangler login                       # if you have not already
npx wrangler d1 create pa-money          # prints a database_id; paste it into wrangler.jsonc
cd ..
scripts/deploy-db.sh                     # dumps SQL and loads it into remote D1
cd web && npx wrangler deploy            # prints the live URL
```

The site's address is `https://pa-money.<your-subdomain>.workers.dev`, where
the subdomain is shown on the Workers & Pages overview page of the Cloudflare
dashboard. To use your own domain instead, add a `routes` entry to
`web/wrangler.jsonc` or attach the domain in the dashboard after the first
deploy.

Loading a large database into D1 goes through `wrangler d1 execute --file`,
which has a 5 GB per-file limit. The dump script splits the SQL into chunks
under that limit and rebuilds the full-text indexes afterwards.

### Continuous deployment from GitHub

Two workflows in `.github/workflows/` automate this once the one-time setup is
done:

- **deploy.yml** redeploys the Worker on every push to `main` that touches
  `web/`.
- **refresh-data.yml** downloads the exports, rebuilds the database, and loads
  it into D1 monthly, on demand, and whenever cleanup rules change. Trigger it
  by hand first with a short year range to measure how long the D1 load takes.

Both need two repository secrets, set under Settings → Secrets and variables →
Actions:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template, then add the permission Account › D1 › Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages overview page, right-hand column |

Nothing else in the repository is sensitive. The D1 database id and account id
in `wrangler.jsonc` are identifiers, not credentials. Built databases and
wrangler's local state are ignored by git.

## How the data is interpreted

- **Reports.** The export lists one row per filed report. When a filer amends a
  report, the amendment is a new row for the same filer, year and cycle. The
  site counts only the latest version of each report and keeps the superseded
  rows flagged, not deleted.
- **Donor keys.** A donor is identified by the contributor name, city and state
  as filed, after uppercasing and stripping punctuation. Different spellings are
  different donors until a reviewed rule in `cleanup/donor_merges.csv` says
  otherwise.
- **Donor kind.** Contributions on Schedule I parts A and C come from political
  committees by definition of the form. Everything else is labeled by a small
  keyword heuristic (PAC, Fund, LLC, Union, and so on) or by an explicit rule in
  `cleanup/reclassify.csv`. The source of each label is stored.
- **Schedules and cycles.** The export does not document its codes. The labels
  in `cleanup/lookups/` were derived from form DSEB-502 and from filing dates in
  the data, and each one notes how confident we are.

## License

Code is MIT. The underlying filings are public records of the Commonwealth of
Pennsylvania.
