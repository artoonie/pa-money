-- PA Money database schema. Built by pipeline/build.py; loaded into Cloudflare D1.
-- Raw filings are stored as filed. Cleanup rules add columns and tables; they never edit rows.

CREATE TABLE filer (
  filer_id    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,      -- name on the most recent report
  filer_type  TEXT,               -- see lookup kind='filer_type'
  office      TEXT,
  district    TEXT,
  party       TEXT,
  city        TEXT,
  state       TEXT,
  zip         TEXT,
  county      TEXT,
  first_year  INTEGER,
  last_year   INTEGER,
  total_all   REAL NOT NULL DEFAULT 0,   -- contributions across all years, current reports only
  group_id    TEXT                        -- cleanup/filer_groups.csv
);

CREATE TABLE filer_name (        -- every distinct name a filer has used, for search
  filer_id TEXT NOT NULL,
  name     TEXT NOT NULL,
  eyear    INTEGER NOT NULL,
  PRIMARY KEY (filer_id, name)
);

CREATE TABLE report (
  cf_id      INTEGER PRIMARY KEY,   -- CampaignFinanceID in the export
  filer_id   TEXT NOT NULL,
  eyear      INTEGER NOT NULL,
  cycle      INTEGER,
  submitted  TEXT,                  -- YYYY-MM-DD
  amend      INTEGER NOT NULL DEFAULT 0,
  terminate  INTEGER NOT NULL DEFAULT 0,
  beginning  REAL,
  monetary   REAL,
  inkind     REAL,
  is_current INTEGER NOT NULL DEFAULT 1   -- 0 when a later report for the same filer/year/cycle exists
);
CREATE INDEX report_filer ON report (filer_id, eyear);

CREATE TABLE donor (
  donor_id    INTEGER PRIMARY KEY,
  donor_key   TEXT NOT NULL UNIQUE,  -- NAME|CITY|ST, normalized
  name        TEXT NOT NULL,         -- as filed, first occurrence
  city        TEXT,
  state       TEXT,
  employer    TEXT,
  occupation  TEXT,
  kind        TEXT,                  -- committee | organization | individual | aggregate | junk
  kind_source TEXT,                  -- schedule | rule | heuristic
  entity_id   TEXT,                  -- cleanup/donor_merges.csv
  total_all   REAL NOT NULL DEFAULT 0,
  n_contrib   INTEGER NOT NULL DEFAULT 0,
  first_year  INTEGER,
  last_year   INTEGER
);
CREATE INDEX donor_entity_idx ON donor (entity_id);

CREATE TABLE contribution (
  id          INTEGER PRIMARY KEY,
  cf_id       INTEGER NOT NULL,
  filer_id    TEXT NOT NULL,
  eyear       INTEGER NOT NULL,
  cycle       INTEGER,
  section     TEXT,                 -- schedule part, see lookup kind='section'
  donor_id    INTEGER NOT NULL,
  contributor TEXT,
  city        TEXT,
  state       TEXT,
  zip         TEXT,
  occupation  TEXT,
  employer    TEXT,
  date        TEXT,                 -- YYYY-MM-DD or NULL
  amount      REAL NOT NULL,
  description TEXT,
  is_current  INTEGER NOT NULL DEFAULT 1,
  flag        TEXT                      -- 'date_in_amount': the amount field holds a YYYYMMDD date; excluded from totals
);
CREATE INDEX contribution_filer ON contribution (filer_id, eyear, is_current, amount);
CREATE INDEX contribution_donor ON contribution (donor_id, eyear, is_current);

CREATE TABLE expense (
  id          INTEGER PRIMARY KEY,
  cf_id       INTEGER NOT NULL,
  filer_id    TEXT NOT NULL,
  eyear       INTEGER NOT NULL,
  cycle       INTEGER,
  payee       TEXT,
  city        TEXT,
  state       TEXT,
  zip         TEXT,
  date        TEXT,
  amount      REAL NOT NULL,
  description TEXT,
  is_current  INTEGER NOT NULL DEFAULT 1,
  flag        TEXT
);
CREATE INDEX expense_filer ON expense (filer_id, eyear, is_current, amount);

CREATE TABLE debt (
  id INTEGER PRIMARY KEY, cf_id INTEGER NOT NULL, filer_id TEXT NOT NULL, eyear INTEGER NOT NULL, cycle INTEGER,
  creditor TEXT, city TEXT, state TEXT, zip TEXT, date TEXT, amount REAL NOT NULL, description TEXT,
  is_current INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX debt_filer ON debt (filer_id, eyear);

CREATE TABLE receipt (
  id INTEGER PRIMARY KEY, cf_id INTEGER NOT NULL, filer_id TEXT NOT NULL, eyear INTEGER NOT NULL, cycle INTEGER,
  source TEXT, city TEXT, state TEXT, zip TEXT, date TEXT, amount REAL NOT NULL, description TEXT,
  is_current INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX receipt_filer ON receipt (filer_id, eyear);

-- Aggregates over current reports only.
CREATE TABLE filer_year (
  filer_id       TEXT NOT NULL,
  eyear          INTEGER NOT NULL,
  total          REAL NOT NULL,
  cash_committee REAL NOT NULL,   -- Schedule I parts A and C
  cash_other     REAL NOT NULL,   -- Schedule I parts B and D, and unlabeled
  inkind         REAL NOT NULL,   -- Schedule II
  n_contrib      INTEGER NOT NULL,
  n_donors       INTEGER NOT NULL,
  n_small        INTEGER NOT NULL, -- donors whose year total to this filer is $250 or less
  expenses       REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (filer_id, eyear)
);
CREATE INDEX filer_year_total ON filer_year (eyear, total);

CREATE TABLE filer_month (
  filer_id TEXT NOT NULL, eyear INTEGER NOT NULL, month TEXT NOT NULL, total REAL NOT NULL,
  PRIMARY KEY (filer_id, eyear, month)
);

CREATE TABLE filer_donor_year (
  filer_id TEXT NOT NULL, eyear INTEGER NOT NULL, donor_id INTEGER NOT NULL,
  total REAL NOT NULL, inkind REAL NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (filer_id, eyear, donor_id)
);
CREATE INDEX filer_donor_year_donor ON filer_donor_year (donor_id, eyear);

CREATE TABLE donor_year (
  donor_id INTEGER NOT NULL, eyear INTEGER NOT NULL,
  total REAL NOT NULL, n INTEGER NOT NULL, n_recipients INTEGER NOT NULL,
  PRIMARY KEY (donor_id, eyear)
);
CREATE INDEX donor_year_total ON donor_year (eyear, total);

-- Cleanup layer (from cleanup/).
CREATE TABLE lookup (
  kind  TEXT NOT NULL,   -- cycle | section | filer_type | office | party
  code  TEXT NOT NULL,
  label TEXT NOT NULL,
  note  TEXT,
  PRIMARY KEY (kind, code)
);

CREATE TABLE entity (
  entity_id TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  kind      TEXT,
  note      TEXT
);

CREATE TABLE donor_entity (
  donor_id     INTEGER PRIMARY KEY,
  entity_id    TEXT NOT NULL,
  donor_key    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  evidence     TEXT,
  submitted_by TEXT
);

CREATE TABLE filer_group (
  filer_id   TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL,
  group_name TEXT NOT NULL,
  reason     TEXT
);
CREATE INDEX filer_group_group ON filer_group (group_id);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

-- Full-text search. Prefix queries (tok*) on unicode61 tokens.
CREATE VIRTUAL TABLE filer_fts USING fts5 (name, filer_id UNINDEXED, tokenize = 'unicode61');
CREATE VIRTUAL TABLE donor_fts USING fts5 (name, city, employer, donor_id UNINDEXED, tokenize = 'unicode61');

-- Precomputed donor rankings (merged entities collapsed), so ranking pages never scan donor_year live.
-- eyear 0 = all years; kind is 'all', 'individual', 'organization' or 'committee'. Top 1000 per pair.
CREATE TABLE donor_rank (
  eyear        INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  rank         INTEGER NOT NULL,
  donor_id     INTEGER NOT NULL,
  entity_id    TEXT,
  name         TEXT NOT NULL,
  city         TEXT,
  state        TEXT,
  employer     TEXT,
  donor_kind   TEXT,
  n_keys       INTEGER NOT NULL,
  total        REAL NOT NULL,
  n            INTEGER NOT NULL,
  n_recipients INTEGER NOT NULL,
  PRIMARY KEY (eyear, kind, rank)
);

-- A committee that files its own reports also appears, by name, as a contributor on other committees' reports.
-- filer_link ties such a donor key to the filer record so money can be followed from donor to committee to onward recipients.
-- source 'name': the normalized donor name equals a name exactly one committee filer (not a candidate or lobbyist record) has used, and the states agree.
-- source 'rule': a reviewed row in cleanup/filer_links.csv.
CREATE TABLE filer_link (
  donor_id     INTEGER PRIMARY KEY,
  filer_id     TEXT NOT NULL,
  source       TEXT NOT NULL,
  reason       TEXT,
  evidence     TEXT,
  submitted_by TEXT
);
CREATE INDEX filer_link_filer ON filer_link (filer_id);
