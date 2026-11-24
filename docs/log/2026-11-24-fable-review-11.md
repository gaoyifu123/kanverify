# Fable 5.2 review 11: record format 13 and the in-place upgrade runner (2026-11-24)

Saved by the coordinator, condensed, every finding kept. npm test 435/435; ~30 crafted migrations through
upgradeDatabase on scratch copies with a non-empty ledger; the live database checked on a scratch copy.

## Result

- **Format 13 and the live migration: PASS.** Lookup tables with foreign keys; `format: 1` counts the snapshot shape;
  the site refuses an unknown shape; schema-13.sql byte-identical; .gitattributes pins LF. Live: user_version 13,
  24 objects text-identical to a fresh schema, integrity ok, rows identical to the format-12 backup, counters 43/2,
  backup sha256 ed2abf1f… as logged.
- **Runner: SEND BACK, narrow** — fix before the first db/migrations/ file runs (a wrong column is permanent).

1. **Medium.** Two different schemas normalise alike: quoted names with spaces ("id INTEGER PRIMARY KEY" as a column
   name), a no-break space or U+2028 before a name (JS `\s` vs SQLite), Unicode case folding (straße/strasse). Fix:
   SQLite's whitespace set only; quoted names stay distinguishable unless plain identifiers; ASCII-only case folding;
   simplest guard: a migration file is ASCII outside comments and strings.
2. **Medium-low.** A NUL cuts a statement for SQLite but not for the whitelist/reader (an UPDATE's WHERE vanished).
   Refuse NUL and control characters other than tab, LF, CR.
3. **Low.** `CREATE TABLE IF NOT EXISTS <existing>` enters the "made in this upgrade" set (later caught by row checks);
   a single-quoted 'publications' escapes the forbidden-name scan for reads; lookup-table CHECK lacks the NUL guard;
   nothing stops runtime code inserting lookup codes (needs a reviewer rule); enableDefensive skipped silently when
   missing (should throw); WITHOUT ROWID tables should be refused; the migration log has two "Live run" sections.

What held: no whitelisted statement reached publications; digests independent of the parser; existing rows and
counters protected; schema equality caught extra trigger/index/out-of-order column; parser divergences found all split
too early (fail closed); runner mechanics.

Reviewer rules: apply the developer's diff with: retire the copy exemption entirely; migration files ASCII outside
comments/strings, no control characters; no code writes claim_domains/source_kinds except db/schema.sql and a
migration (a new source kind needs its class decided); narrow test exemption; keep explicit-id, sqlite_sequence and
today rules.

Objections: the equality check is where a parser mistake becomes permanent — any future change to tokenize/normalize
gets its own Fable review; upgrades can never correct data (right default); lists frozen at the first confirmation;
no backup off this machine — urgent from the first confirmation.

## Coordinator's decision

Format 13 stays. Runner fixes 1–3 → the same developer, then this reviewer re-checks. The first confirmation does not
wait for the runner fixes (confirmations don't use it; no migration file exists yet). Reviewer rules applied now.

# Re-check (same day): runner PASS

Findings 1, 2 and the low items fixed; 26 crafted migrations re-run, nothing got through. Residual (low): a quoted
name spelled like a keyword normalises to the bare keyword ("DEFAULT" "NULL" becomes part of a type name on a non-STRICT
table) — closed by rule: tables created in a migration must be STRICT. Reviewer-rules text matches; added a test
carve-out for the lookup-table write rule. Tag: fable-format13-runner-2026-11-24.
