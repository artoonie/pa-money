# Cleanup rules

Everything in this folder is a human-reviewed correction layered on top of the
raw Department of State export. The raw data is never edited. The build applies
these files and records where each label came from, and the site links every
merged entity, grouped filer and code label back here.

**Nothing is merged automatically.** Two spellings of a name stay two donors
until a row in `donor_merges.csv` says they are the same, with a reason a
reviewer accepted.

## Files

| File | What a row does |
|---|---|
| `entities.csv` | Declares a real-world entity (a person or organization) that filings refer to under several keys. |
| `donor_merges.csv` | Says one donor key belongs to an entity. A donor key is `NAME|CITY|ST`, uppercased, punctuation stripped. |
| `filer_groups.csv` | Groups several filer IDs (a candidate and their committees) into one page. |
| `reclassify.csv` | Overrides the donor kind for every donor with a given normalized name, in any city. |
| `lookups/*.csv` | Labels for the undocumented codes in the export: cycles, schedule sections, filer types, offices, parties. |

Every row that changes data needs a `reason`. A merge should also cite
`evidence`: a filing, a news article, a corporate registry, anything a stranger
could check.

## Proposing a change

1. Open a pull request editing one of these CSVs. The "Suggest a correction"
   link on any donor or filer page prefills an issue with the exact keys.
2. CI runs `python3 cleanup/validate.py`, which checks the files for format
   errors, duplicate keys, missing entities and empty reasons. If a built
   database is present it also checks that every key exists in the data.
3. A maintainer reviews. Merges of people need a second look, because a wrong
   merge attributes someone else's money to a real person. Label and grouping
   fixes can be merged on CI alone.

## Finding a donor key

Open the donor's page on the site. The key is shown under the name and in the
page URL's "Suggest a correction" link. You can also compute it: uppercase the
contributor name, city and state as filed, replace every run of non-letters
and non-digits with one space, trim, and join with `|`.

```
"Jeffery Yass", "Haverford", "PA"  ->  JEFFERY YASS|HAVERFORD|PA
```

## What is deliberately not here

- No fuzzy matching. A future UI may *suggest* near-duplicates, but a person
  accepts every one by adding a row here.
- No edits to amounts, dates or names as filed. If a filing is wrong, the fix
  is an amended filing with the Department of State, not a row in this folder.
