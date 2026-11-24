-- KANVERIFY record format, version 13. (9: the snapshot carries the origin's source id and
-- each evidence item's source id. 10: Fable review 3 — source ids and files fixed, one
-- publisher normalisation, renunciation dated, measurable claims have a deadline, and the
-- review desk's round bookkeeping: jury_votes.pack_sha256, verdicts.based_on_round.
-- 11: the snapshot's verdict says which jury round it rests on. 12: every verdict records the
-- rules it was judged by, verdicts.rules_version and verdicts.rules_applied, in the snapshot
-- (decision 0014); a 'renunciation' source — the speaker's explicit public reversal of the same
-- claim (decision 0015, S1), on a promise — is cited only under not_came_true on a
-- measurable claim, dated on or after the day it was made and on or before its deadline (verdict-standard.md
-- 0.6, RN-1 row 5), which removes format 11's widening; a prediction never has an inferred
-- deadline (VG-3). 13: the two lists that grow, claim domains and source kinds, are rows of the
-- lookup tables claim_domains and source_kinds instead of CHECK lists, so an in-place upgrade
-- can add to them; the snapshot says which shape it has, in its key "format" (Fable review 10).)
--
-- Upgrades. From format 13 on, a format change is applied in place to the existing file by
-- upgradeDatabase in src/db.js (node src/db.js upgrade), from db/migrations/<format>.sql, without
-- touching the ledger: its rows, its table, its triggers and current_publications stay as they
-- are, and old snapshots keep the shape they were confirmed in. No table can be rebuilt (claims
-- is under the ledger), so a column definition or a table CHECK below cannot change again; a
-- new row rule becomes a workspace trigger or a publication check. Every released format is
-- kept byte for byte in db/formats/ (Fable review 10; docs/decisions/0005).
--
-- Verdict rules have ids (docs/methodology/verdict-standard.md, table "Rules"); the comments
-- below name the ones each check applies.
--
-- Verdicts (docs/decisions/0008-five-verdicts.md and its revision, verdict-standard.md
-- 0.6 section 6): six values shared by promises and predictions —
--   unverifiable      too vague or hedged to be checked, or its condition never arose
--   pending           not due yet
--   to_evaluate       due, but the evidence is not enough to decide; says what is missing
--   came_true         the criteria were fully met (may be given before the deadline)
--   partly_came_true  due, and the criteria were met in part; the summary gives the figures
--   not_came_true     due, and it did not happen; or the speaker explicitly gave up a promise
--                     or explicitly reversed a claim between the day it was made and its
--                     deadline (RN-1 row 5)
-- The deadline is not checked in this file: a view that depends on today's date would give
-- a different answer depending on when and where it is read. It is checked, with the same
-- function as the jury's vote checks (src/rules.js deadlineProblem, local date), in
-- confirm() in src/ledger.js — the one way into the ledger.
--
-- Two parts, kept apart on purpose:
--
--   The WORKSPACE (claim_domains, source_kinds, subjects, sources, claims, verdicts,
--   verdict_evidence, jury_votes)
--   is where work happens. Rows can be edited freely. Only facts about a single row
--   are checked here, with column types and plain CHECK constraints, plus one trigger
--   that keeps a subject's public id from changing and one that keeps a source's id, address
--   and archived file from changing.
--
--   The LEDGER (publications) is what the public sees. Each time someone confirms a
--   claim, the complete content at that moment is stored as one snapshot. The ledger
--   only grows: nothing in it is ever edited, overwritten or deleted, and entries are
--   numbered in order by the database. The website is built from the ledger alone.
--
-- What may enter the ledger is defined by the view publication_checks plus the deadline
-- rule in confirm() (src/ledger.js), and nowhere else. The view enforces the principles:
--   Principle 2 (nothing without a source): a claim's origin must be the speaker's own
--     words; a verdict that asserts an outcome needs one official document, or two
--     independent sources from different publishers; a statement is a lead, never
--     evidence.
--   Principle 1 (the question matters as much as the conclusion): "to_evaluate"
--     must say what is missing.
--   Every verdict except "pending" explains itself in a summary, and a claim that is
--     vague or hedged can only be "unverifiable" (verdict-standard.md section 2).
--   Both sites get the same record (principle 3): everything we write ourselves, and a
--     translation of everything quoted that is not already in that language, exists
--     in French and in English; an outcome verdict carries a summary
--     (docs/decisions/0007-subject-ids-and-bilingual-storage.md).
--
-- Because the public record is a snapshot, later edits in the workspace cannot change
-- it. To change what is public, confirm again; that adds a new entry and keeps the old.
--
-- Scope. This protects the public record against mistakes in our own code and in
-- AI-written code: any ordinary statement (INSERT, UPDATE, DELETE, REPLACE, upsert) on
-- any connection that leaves SQLite's own integrity settings alone.
-- It does not try to protect against:
--   - code that deliberately switches those settings off (PRAGMA foreign_keys = OFF,
--     PRAGMA ignore_check_constraints = ON) — the code reviewer rejects such code;
--   - someone who edits the database file with another tool or removes the triggers.
-- The workspace is not protected against loss at all: REPLACE on a workspace table
-- behaves like delete-and-insert and takes dependent rows with it. Do not use REPLACE
-- there. Whatever happens in the workspace, the ledger is unaffected.
--
-- "Not blank" means: not empty after removing every kind of space and invisible
-- separator, written everywhere with the same list,
--   length(trim(x, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194,
--     8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239,
--     8287, 8288, 12288, 65279))) > 0
-- that is: space, tab, line feed, vertical tab, form feed, carriage return, next line
-- (U+0085), no-break space (U+00A0), soft hyphen (U+00AD), Ogham space (U+1680), the
-- spaces U+2000 to U+200A, zero-width space, non-joiner and joiner (U+200B to U+200D),
-- line and paragraph separators (U+2028, U+2029), narrow no-break space (U+202F),
-- medium mathematical space (U+205F), word joiner (U+2060), ideographic space (U+3000)
-- and the byte order mark (U+FEFF). If the list changes, change every copy.
-- Dates are strict YYYY-MM-DD. Tables are STRICT: a text column holds text only.
--
-- Languages. French and English are the storage languages. Text we write ourselves has
-- a _fr and an _en column, and is published in both or in neither. Quoted text (a
-- claim's quote_original, an evidence excerpt) stays verbatim in its own language;
-- beside it are its translations into French and English, except into its own
-- language: a French quote has no quote_fr, the original is the French text. A
-- language is a lowercase ISO 639-1 code ('fr', 'en', 'de', ...).

-- ============================== WORKSPACE ==============================

-- The lists that may grow (format 13). A claim's domain and a source's kind are codes from
-- these tables; an upgrade adds a code with an INSERT, and the same INSERT goes here. A code in
-- use cannot be removed or renamed (the foreign keys refuse it). The website, the desk and the
-- extraction check label or list every code; a test keeps them equal to these rows. Which class
-- a source kind is in (own words, official, independent) is written in publication_checks below
-- and in source-rule.md, so a new kind also needs a decision on its class and a new view.
--
-- domain is one code from this list; the website shows its French and English name.
--   economy          growth, public finances in general, business, trade
--   tax              taxes and social contributions
--   employment       jobs, unemployment, wages, working conditions
--   health           health care, hospitals, medicines, public health
--   education        schools, universities, vocational training, research
--   environment      climate, pollution, nature, water, waste
--   energy           electricity, fuel, nuclear, renewables, energy prices
--   security         internal security: police, crime, terrorism, civil protection
--                    (the armed forces are 'defence')
--   defence          armed forces, military spending, military alliances
--   justice          courts, prisons, reform of the law
--   immigration      immigration, asylum, nationality, integration
--   foreign_affairs  diplomacy, European and international affairs, development aid
--   institutions     constitution, elections, how government is organised, public ethics
--   social           pensions, family, welfare, disability, poverty
--   housing          housing, rent, construction, urban planning
--   transport        roads, rail, public transport, aviation, shipping
--   agriculture      farming, fisheries, food production, rural affairs
--   digital          internet, telecoms, data protection, digital public services
--   culture          arts, heritage, media, sport
--   other           anything that fits none of the above
-- List approved by the founder on 2026-11-22. 'security' is internal security only.
-- Moving a published claim to another domain needs a new confirmation.
CREATE TABLE claim_domains (
  code TEXT NOT NULL PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*')
) STRICT;

INSERT INTO claim_domains (code) VALUES
  ('economy'), ('tax'), ('employment'), ('health'), ('education'), ('environment'),
  ('energy'), ('security'), ('defence'), ('justice'), ('immigration'),
  ('foreign_affairs'), ('institutions'), ('social'), ('housing'), ('transport'),
  ('agriculture'), ('digital'), ('culture'), ('other');

-- A source's kind; what each one means is written above the sources table.
CREATE TABLE source_kinds (
  code TEXT NOT NULL PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*')
) STRICT;

INSERT INTO source_kinds (code) VALUES
  ('platform'), ('statement'), ('renunciation'),
  ('law'), ('gazette'), ('statistic'), ('budget'), ('parliament'),
  ('court'), ('audit'), ('official'),
  ('media'), ('dataset_study');

-- A subject is identified by its id, never by its name: the id is public (it is in
-- every snapshot and in page addresses), is never changed and never reused.
-- AUTOINCREMENT keeps the database from handing out the number of a deleted subject
-- again; the trigger subjects_id_fixed refuses renumbering.
-- wikidata_id is optional: 'Q' and a number without a leading zero, e.g. 'Q42'. It tells
-- apart people with the same name and links to outside references. Two subjects cannot
-- share one.
CREATE TABLE subjects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('person', 'party', 'government', 'institution')),
  name        TEXT NOT NULL CHECK (length(trim(name, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0),
  country     TEXT NOT NULL CHECK (country GLOB '[A-Z][A-Z]'),  -- ISO 3166-1 alpha-2
  wikidata_id TEXT UNIQUE CHECK (wikidata_id IS NULL
                                 OR (wikidata_id GLOB 'Q[1-9]*'
                                     AND substr(wikidata_id, 2) NOT GLOB '*[^0-9]*'
                                     -- nothing hidden after a NUL character
                                     AND length(CAST(wikidata_id AS BLOB)) = length(wikidata_id)))
) STRICT;

-- The workspace has two triggers. This one: a subject's public id cannot be changed,
-- whether or not a claim refers to it yet.
-- It fires on every update, not only on updates naming id: id is the rowid, so it can
-- also be changed as rowid, oid or _rowid_, including in an upsert's DO UPDATE.
CREATE TRIGGER subjects_id_fixed BEFORE UPDATE ON subjects
WHEN NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'a subject id is permanent');
END;

-- Every archived document. The file itself is stored under data/evidence/ and named by
-- its sha256, so the hash is both the proof and the address.
-- Three classes of source (docs/methodology/source-rule.md):
--   someone's own words — 'platform', 'statement': the origin of a claim or a lead,
--     never evidence for a verdict. A public body's statement about its own performance
--     (a press release or progress report saying a promise is kept) is a 'statement',
--     not 'official': it assesses rather than records (source-rule.md v0.3, founder,
--     2026-11-22). Cite the law, budget or data it points to instead;
--   one exception — 'renunciation': the speaker's own later public statement that explicitly
--     and precisely reverses the same claim, verbatim (decision 0008; decision 0015 S1). A
--     postponement, a changed figure or a softer wording is not one: it is a separate claim
--     (RN-1 row 8). RN-1 (verdict-standard.md 0.6): on a measurable
--     claim of a type on RN-1's list (promises only), dated on or after the day the
--     claim was made and on or before its deadline, it makes the verdict "not_came_true" and
--     is enough evidence on its own (row 5). It is cited nowhere else: on a type not on the
--     list, on a vague or hedged claim, after the deadline, and under every other verdict it
--     is a lead like 'statement' (rows 1, 2, 4, 7). Never an origin;
--   official — issued by a public institution and recording something: 'law',
--     'gazette', 'statistic', 'budget', 'parliament', 'court', 'audit', and 'official'
--     for any other official document that records rather than assesses. One is enough;
--   independent, not official — 'media' (a news outlet's own reporting, not a quote of
--     someone's statement) and 'dataset_study' (research that publishes its raw data).
--     Two from different publishers are needed.
-- A source's id is public (it is in every snapshot), so it is never reused (AUTOINCREMENT)
-- and, with its address and its archived file, never changed (trigger sources_fixed). To
-- correct a source, register the corrected document as a new source.
CREATE TABLE sources (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL REFERENCES source_kinds(code),
  url          TEXT NOT NULL CHECK (length(trim(url, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0),
  title        TEXT NOT NULL CHECK (length(trim(title, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0),
  publisher    TEXT NOT NULL CHECK (length(trim(publisher, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0),
  published_on TEXT CHECK (published_on IS NULL OR published_on IS date(published_on)),
  retrieved_on TEXT NOT NULL CHECK (retrieved_on IS date(retrieved_on)),
  -- Exactly 64 lowercase hex characters, nothing after them.
  sha256       TEXT NOT NULL CHECK (length(CAST(sha256 AS BLOB)) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  media_type   TEXT NOT NULL CHECK (media_type GLOB '?*/?*'),
  -- ISO 639-1, lowercase, exactly two letters (nothing hidden after a NUL character).
  lang         TEXT NOT NULL CHECK (lang GLOB '[a-z][a-z]' AND length(CAST(lang AS BLOB)) = 2)
) STRICT;

-- A source's id, address and archived file are what a snapshot points to; they never
-- change. Fires on every update for the same reason as subjects_id_fixed (rowid aliases).
CREATE TRIGGER sources_fixed BEFORE UPDATE ON sources
WHEN NEW.id IS NOT OLD.id OR NEW.url IS NOT OLD.url OR NEW.sha256 IS NOT OLD.sha256
BEGIN
  SELECT RAISE(ABORT, 'a source id, url and sha256 are permanent; register a new source instead');
END;

-- One promise or prediction, quoted verbatim from its origin.
-- Its domain is a code of claim_domains (above).
CREATE TABLE claims (
  id              INTEGER PRIMARY KEY,
  subject_id      INTEGER NOT NULL REFERENCES subjects(id),
  -- The capacity in which they said it ("candidate for president, 2022"). It belongs to
  -- the claim, not the person: a role changes over time, what was said does not.
  speaker_role_fr TEXT,
  speaker_role_en TEXT,
  type            TEXT NOT NULL CHECK (type IN ('promise', 'prediction')),
  domain          TEXT NOT NULL REFERENCES claim_domains(code),
  quote_original TEXT NOT NULL CHECK (length(trim(quote_original, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0),
  -- ISO 639-1, lowercase, as for sources.
  lang           TEXT NOT NULL CHECK (lang GLOB '[a-z][a-z]' AND length(CAST(lang AS BLOB)) = 2),
  -- Translations of the quote. None into the quote's own language: the original is it.
  quote_fr       TEXT CHECK (lang <> 'fr' OR quote_fr IS NULL),
  quote_en       TEXT CHECK (lang <> 'en' OR quote_en IS NULL),
  said_on        TEXT NOT NULL CHECK (said_on IS date(said_on)),
  source_id      INTEGER NOT NULL REFERENCES sources(id),
  source_locator TEXT NOT NULL CHECK (length(trim(source_locator, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0),
  verifiability  TEXT NOT NULL CHECK (verifiability IN ('measurable', 'vague', 'hedged')),
  deadline       TEXT CHECK (deadline IS NULL OR deadline IS date(deadline)),
  deadline_basis TEXT CHECK (deadline_basis IN ('stated', 'inferred')),
  criteria_fr    TEXT,
  criteria_en    TEXT,
  -- A measurable claim must say, at recording time, what counts as came true — in at least
  -- one language. The translation may come later; both languages are required only to
  -- publish (rule "bilingual").
  CHECK (verifiability <> 'measurable'
         OR length(trim(coalesce(criteria_fr, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0
         OR length(trim(coalesce(criteria_en, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0),
  -- A deadline always says whether the speaker stated it or we inferred it.
  CHECK ((deadline IS NULL) = (deadline_basis IS NULL)),
  -- A measurable claim always has a deadline, stated or inferred (verdict-standard.md
  -- section 3); without one no verdict could ever be due.
  CHECK (verifiability <> 'measurable' OR deadline IS NOT NULL),
  -- VG-3 (verdict-standard.md 0.6, ST-2; format 12): a prediction is judged against the time range
  -- it states itself; it never gets an inferred deadline. Without a range it is recorded as vague.
  CHECK (type <> 'prediction' OR deadline_basis IS NOT 'inferred')
) STRICT;

-- The working verdict on a claim. One row per claim.
CREATE TABLE verdicts (
  id            INTEGER PRIMARY KEY,
  claim_id      INTEGER NOT NULL UNIQUE REFERENCES claims(id) ON DELETE CASCADE,
  verdict       TEXT NOT NULL CHECK (verdict IN (
                  'unverifiable', 'pending', 'to_evaluate', 'came_true', 'partly_came_true',
                   'not_came_true')),
  summary_fr       TEXT,
  summary_en       TEXT,
  open_question_fr TEXT,
  open_question_en TEXT,
  decided_by       TEXT NOT NULL CHECK (decided_by IN ('human', 'jury')),
  -- The jury round this working verdict was based on (review desk bookkeeping). It is in the
  -- snapshot, so the site counts the votes of that round only (format 11).
  based_on_round   INTEGER,
  -- The rules it was judged by (decision 0014, format 12): the version of
  -- docs/methodology/verdict-standard.md, and the ids of the rules that decided it, as a JSON list
  -- (["DL-2", "EV-1"]). Required for every verdict, so a rule change never silently rewrites the past.
  -- The form of each id is checked at publication (rules_recorded): a row CHECK cannot read a list.
  -- That the version is kept and the ids exist in it is checked by confirm(), the desk and the vote
  -- checks (src/standard.js; Fable review 8, finding 2).
  -- Digits, one dot, digits; nothing hidden after a NUL character (GLOB stops there), as for the ids.
  rules_version    TEXT NOT NULL CHECK (rules_version GLOB '[0-9]*.[0-9]*' AND rules_version NOT GLOB '*[^0-9.]*'
                                        AND rules_version NOT GLOB '*.*.*'
                                        AND length(CAST(rules_version AS BLOB)) = length(rules_version)),
  rules_applied    TEXT NOT NULL CHECK (json_valid(rules_applied) AND json_type(rules_applied) = 'array'
                                        AND json_array_length(rules_applied) > 0),
  -- Principle 1: "to_evaluate" says where it is stuck and what is missing — in at least
  -- one language. Both languages are required only to publish (rule "bilingual").
  CHECK (verdict <> 'to_evaluate'
         OR length(trim(coalesce(open_question_fr, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0
         OR length(trim(coalesce(open_question_en, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0)
) STRICT;

CREATE TABLE verdict_evidence (
  id         INTEGER PRIMARY KEY,
  verdict_id INTEGER NOT NULL REFERENCES verdicts(id) ON DELETE CASCADE,
  source_id  INTEGER NOT NULL REFERENCES sources(id),
  -- Verbatim, in the source's language (sources.lang). The translations may come later.
  -- There is none into the source's own language; that depends on another row, so it is
  -- checked at publication (rule "bilingual"), not here — a row CHECK cannot look at
  -- sources, and the workspace has no triggers (decision 0005).
  excerpt    TEXT NOT NULL CHECK (length(trim(excerpt, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0),
  excerpt_fr TEXT,
  excerpt_en TEXT,
  locator    TEXT NOT NULL CHECK (length(trim(locator, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0)
) STRICT;

-- Each model's independent first verdict, with the passages it relied on.
-- This is working data like the rest of the workspace. What counts as the record is the
-- set of votes that exists when a claim is confirmed: who voted what is frozen into
-- that ledger snapshot, and the jury's agreement with human confirmation is measured
-- from the ledger, not from this table. A vote's reasoning and open_question are the
-- model's working notes and are never published, so they are kept in one language.
CREATE TABLE jury_votes (
  id             INTEGER PRIMARY KEY,
  claim_id       INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  round          INTEGER NOT NULL DEFAULT 1,
  provider       TEXT NOT NULL CHECK (length(trim(provider, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0),
  model          TEXT NOT NULL CHECK (length(trim(model, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0),
  prompt_version TEXT NOT NULL CHECK (length(trim(prompt_version, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0),
  verdict        TEXT NOT NULL CHECK (verdict IN (
                   'unverifiable', 'pending', 'to_evaluate', 'came_true', 'partly_came_true',
                   'not_came_true')),
  reasoning      TEXT NOT NULL CHECK (length(trim(reasoning, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0),
  open_question  TEXT,
  -- The evidence pack the vote was cast on: exactly 64 lowercase hex characters.
  pack_sha256    TEXT NOT NULL CHECK (length(CAST(pack_sha256 AS BLOB)) = 64 AND pack_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- [{"source_id": 12, "excerpt": "...", "locator": "..."}]
  evidence_json  TEXT NOT NULL DEFAULT '[]'
                 CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
  UNIQUE (claim_id, round, provider, model),
  CHECK (verdict <> 'to_evaluate'
         OR (open_question IS NOT NULL
             AND length(trim(open_question, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0))
) STRICT;

CREATE INDEX claims_by_subject ON claims(subject_id);
CREATE INDEX evidence_by_verdict ON verdict_evidence(verdict_id);

-- ============================== WHAT MAY BE PUBLISHED ==============================

-- The whole publication policy, one row per claim, one column per rule (1 = satisfied).
-- The review desk reads this to say why a claim cannot be confirmed yet.
-- Together with the deadline rule in confirm() (src/ledger.js), this decides what is public.
-- Publisher names are compared with kv_publisher_key, the one normalisation shared with the
-- jury's checks (src/rules.js publisherKey; openDatabase registers it). A connection that
-- has not registered it cannot evaluate this view, so it cannot publish anything.
CREATE VIEW publication_checks AS
SELECT
  c.id AS claim_id,
  (sub.id IS NOT NULL) AS has_subject,
  -- The origin exists and is the speaker's own published words.
  (coalesce(o.kind, '') IN ('platform', 'statement')) AS origin_is_own_words,
  (v.id IS NOT NULL) AS has_verdict,
  -- A claim that is vague or hedged cannot be checked, so its only verdict is
  -- "unverifiable" (verdict-standard.md section 2). A measurable claim may take any
  -- verdict, "unverifiable" included (its condition never arose).
  (v.id IS NOT NULL
   AND (c.verifiability = 'measurable' OR v.verdict = 'unverifiable')) AS verdict_fits_verifiability,
  -- Principle 1 ("to_evaluate" says what is missing) needs no rule here: the verdicts row
  -- check already requires it in one language, and "bilingual" below requires both.
  -- Every verdict except "pending" explains itself in a summary (decision 0008). Here in
  -- at least one language; the summary pair in "bilingual" then requires both.
  (v.id IS NOT NULL
   AND (v.verdict = 'pending'
        OR length(trim(coalesce(v.summary_fr, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0
        OR length(trim(coalesce(v.summary_en, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0)) AS summary_stated,
  -- EV-1: a verdict that asserts something about the world rests on evidence: one existing
  -- official document, or two independent sources from different publishers. That is
  -- "came_true", "partly_came_true", "not_came_true", and "unverifiable" on a measurable
  -- claim (VG-2: the evidence shows its condition never arose; principle 2). "unverifiable"
  -- on a vague or hedged claim (VG-1) follows from the wording alone and needs none.
  -- RN-1 row 5: for "not_came_true" on a measurable claim, one public reversal by the
  -- speaker is also enough, if it was published on or after the day the claim was made and on
  -- or before its deadline (one after the deadline changes nothing, row 7). The type list is
  -- RN-1's switch, the same as REVERSAL_TYPES in src/rules.js (and in evidence_is_primary
  -- below); a test checks they agree. Two independent
  -- sources means two documents with different publishers (kv_publisher_key) and different
  -- archived files (sha256).
  (v.id IS NOT NULL
   AND (v.verdict IN ('pending', 'to_evaluate')
        OR (v.verdict = 'unverifiable' AND c.verifiability IS NOT 'measurable')
        OR (v.verdict = 'not_came_true' AND c.type IN ('promise') AND c.verifiability = 'measurable'
            AND EXISTS (SELECT 1 FROM verdict_evidence e JOIN sources s ON s.id = e.source_id
                        WHERE e.verdict_id = v.id AND s.kind = 'renunciation'
                          AND s.published_on >= c.said_on AND s.published_on <= c.deadline))
        OR EXISTS (SELECT 1 FROM verdict_evidence e JOIN sources s ON s.id = e.source_id
                   WHERE e.verdict_id = v.id
                     AND s.kind IN ('law', 'gazette', 'statistic', 'budget', 'parliament',
                                    'court', 'audit', 'official'))
        OR EXISTS (SELECT 1
                   FROM verdict_evidence e1 JOIN sources s1 ON s1.id = e1.source_id,
                        verdict_evidence e2 JOIN sources s2 ON s2.id = e2.source_id
                   WHERE e1.verdict_id = v.id AND e2.verdict_id = v.id
                     AND s1.kind IN ('media', 'dataset_study') AND s2.kind IN ('media', 'dataset_study')
                     AND kv_publisher_key(s1.publisher) IS NOT kv_publisher_key(s2.publisher)
                     AND s1.sha256 <> s2.sha256))) AS outcome_has_evidence,
  -- EV-2: a statement is a lead, never evidence — whoever made it. RN-1: a 'renunciation' (a
  -- public reversal by the speaker) may stand among the evidence only in row 5 — under
  -- "not_came_true", on a measurable claim of a type on RN-1's list, published on or after the
  -- day the claim was made and on or before its deadline (the same
  -- condition as outcome_has_evidence above, and src/rules.js renunciationAdmitted). Under
  -- every other verdict, on a type not on the list, on a vague or hedged claim, undated, or dated
  -- outside that window it is refused (rows 1-4, 7). That it is not dated after the day of
  -- confirmation is checked in confirm() (futureEvidence), as for every source.
  -- Evidence whose source is missing does not count.
  (NOT EXISTS (SELECT 1 FROM verdict_evidence e LEFT JOIN sources s ON s.id = e.source_id
               WHERE e.verdict_id = v.id
                 AND (s.id IS NULL
                      OR s.kind IN ('platform', 'statement')
                      OR (s.kind = 'renunciation'
                          AND NOT (c.type IN ('promise') AND c.verifiability = 'measurable'
                                   AND v.verdict = 'not_came_true'
                                   AND s.published_on IS NOT NULL AND c.deadline IS NOT NULL
                                   AND s.published_on >= c.said_on AND s.published_on <= c.deadline))))) AS evidence_is_primary,
  -- Decision 0014: the rules a verdict was judged by are recorded. The row checks require a
  -- version and a non-empty JSON list; here every item must be a distinct rule id of the form
  -- used in verdict-standard.md ('DL-2': two capital letters, a hyphen, a number without a
  -- leading zero, nothing hidden after a NUL). Whether the ids exist in that version is for
  -- the desk and the vote checks (src/standard.js).
  (v.id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM json_each(v.rules_applied) r
                   WHERE r.type IS NOT 'text'
                      OR r.value NOT GLOB '[A-Z][A-Z]-[1-9]*'
                      OR substr(r.value, 4) GLOB '*[^0-9]*'
                      OR length(CAST(r.value AS BLOB)) <> length(r.value))
   AND (SELECT count(DISTINCT r.value) FROM json_each(v.rules_applied) r) = json_array_length(v.rules_applied)) AS rules_recorded,
  -- Both sites show the same record (decision 0007). Blank counts as missing.
  --   Quoted text: the claim's quote, and every evidence excerpt, has a translation into
  --     French unless its own language is French, and into English unless it is English.
  --     An excerpt has no translation into its source's own language.
  --   Our own text: every FR/EN pair (speaker role, criteria, summary, open question) is
  --     in both languages or in neither. Where the text is required, that means in both:
  --     the criteria of a measurable claim (required by the claims row check), the open
  --     question of "to_evaluate" (the verdicts row check) and the summary (summary_stated).
  ((c.lang = 'fr' OR length(trim(coalesce(c.quote_fr, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0)
   AND (c.lang = 'en' OR length(trim(coalesce(c.quote_en, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0)
   AND ((length(trim(coalesce(c.speaker_role_fr, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0)
        = (length(trim(coalesce(c.speaker_role_en, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0))
   AND ((length(trim(coalesce(c.criteria_fr, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0)
        = (length(trim(coalesce(c.criteria_en, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0))
   AND ((length(trim(coalesce(v.summary_fr, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0)
        = (length(trim(coalesce(v.summary_en, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0))
   AND ((length(trim(coalesce(v.open_question_fr, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0)
        = (length(trim(coalesce(v.open_question_en, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0))
   AND NOT EXISTS (
     SELECT 1 FROM verdict_evidence e JOIN sources s ON s.id = e.source_id
     WHERE e.verdict_id = v.id
       AND (CASE WHEN s.lang = 'fr' THEN e.excerpt_fr IS NOT NULL
                 ELSE length(trim(coalesce(e.excerpt_fr, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) = 0 END
            OR CASE WHEN s.lang = 'en' THEN e.excerpt_en IS NOT NULL
                    ELSE length(trim(coalesce(e.excerpt_en, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) = 0 END))) AS bilingual
FROM claims c
LEFT JOIN subjects sub ON sub.id = c.subject_id
LEFT JOIN sources o ON o.id = c.source_id
LEFT JOIN verdicts v ON v.claim_id = c.id;

-- Claims that pass every rule, with the exact snapshot that would be made public.
-- "format" counts the snapshot's SHAPE (its keys and what they mean), not the record format:
-- it changes only when this json_object changes shape, so an upgrade that leaves the shape
-- alone leaves every published claim as it was. Shape 1 is the first with the key (record
-- format 13); no earlier shape is in any ledger. The site refuses a shape it does not know.
CREATE VIEW publishable AS
SELECT
  c.id AS claim_id,
  json_object(
    'format', 1,
    'claim', json_object(
      'id', c.id, 'type', c.type, 'domain', c.domain,
      'speaker_role_fr', c.speaker_role_fr, 'speaker_role_en', c.speaker_role_en,
      'quote_original', c.quote_original, 'lang', c.lang,
      'quote_fr', c.quote_fr, 'quote_en', c.quote_en,
      'said_on', c.said_on, 'source_locator', c.source_locator,
      'verifiability', c.verifiability,
      'deadline', c.deadline, 'deadline_basis', c.deadline_basis,
      'criteria_fr', c.criteria_fr, 'criteria_en', c.criteria_en),
    'subject', json_object(
      'id', sub.id, 'wikidata_id', sub.wikidata_id,
      'name', sub.name, 'kind', sub.kind, 'country', sub.country),
    'origin', json_object(
      'id', o.id, 'kind', o.kind, 'url', o.url, 'title', o.title, 'publisher', o.publisher,
      'published_on', o.published_on, 'retrieved_on', o.retrieved_on,
      'sha256', o.sha256, 'media_type', o.media_type, 'lang', o.lang),
    'verdict', json_object(
      'verdict', v.verdict, 'summary_fr', v.summary_fr, 'summary_en', v.summary_en,
      'open_question_fr', v.open_question_fr, 'open_question_en', v.open_question_en,
      'decided_by', v.decided_by, 'based_on_round', v.based_on_round,
      'rules_version', v.rules_version, 'rules_applied', json(v.rules_applied)),
    'evidence', json((
      SELECT json_group_array(json_object(
               'source_id', e.source_id,
               'excerpt', e.excerpt, 'excerpt_fr', e.excerpt_fr, 'excerpt_en', e.excerpt_en,
               'locator', e.locator,
               'kind', s.kind, 'url', s.url, 'title', s.title, 'publisher', s.publisher,
               'published_on', s.published_on, 'retrieved_on', s.retrieved_on,
               'sha256', s.sha256, 'media_type', s.media_type, 'lang', s.lang) ORDER BY e.id)
      FROM verdict_evidence e
      JOIN sources s ON s.id = e.source_id
      WHERE e.verdict_id = v.id)),
    -- Every recorded vote, of every round; verdict.based_on_round says which round counts.
    'jury', json((
      SELECT json_group_array(json_object(
               'round', j.round, 'provider', j.provider, 'model', j.model,
               'prompt_version', j.prompt_version, 'verdict', j.verdict) ORDER BY j.id)
      FROM jury_votes j
      WHERE j.claim_id = c.id))
  ) AS snapshot
FROM claims c
JOIN subjects sub ON sub.id = c.subject_id
JOIN sources o ON o.id = c.source_id
JOIN verdicts v ON v.claim_id = c.id
JOIN publication_checks k ON k.claim_id = c.id
WHERE k.has_subject AND k.origin_is_own_words AND k.has_verdict
  AND k.verdict_fits_verifiability AND k.summary_stated AND k.outcome_has_evidence AND k.evidence_is_primary
  AND k.rules_recorded AND k.bilingual;

-- ============================== LEDGER ==============================

-- The public record. Append-only. The newest entry for a claim is its current state.
--   'published' — the snapshot is what the public sees.
--   'withdrawn' — the claim is no longer shown as current; its page stays, with the note
--                 saying why, in French and English (decision 0007).
CREATE TABLE publications (
  id             INTEGER PRIMARY KEY,
  claim_id       INTEGER NOT NULL REFERENCES claims(id),
  status         TEXT NOT NULL CHECK (status IN ('published', 'withdrawn')),
  snapshot       TEXT NOT NULL CHECK (json_valid(snapshot)),
  note_fr        TEXT,
  note_en        TEXT,
  confirmed_by   TEXT NOT NULL CHECK (length(trim(confirmed_by, char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0),
  confirmed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- How long the human review took, for the weekly report on manual effort (principle 7).
  review_seconds INTEGER CHECK (review_seconds IS NULL OR review_seconds >= 0),
  -- A withdrawal always says why, in both languages.
  CHECK (status <> 'withdrawn'
         OR (length(trim(coalesce(note_fr, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0
             AND length(trim(coalesce(note_en, ''), char(32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279))) > 0))
) STRICT;

CREATE INDEX publications_by_claim ON publications(claim_id, id);

-- Confirming means storing exactly what is publishable right now. A snapshot cannot be
-- typed in, carried over from earlier, or taken from another claim. Everything that is
-- not a withdrawal is held to this.
CREATE TRIGGER ledger_exact BEFORE INSERT ON publications
WHEN NEW.status IS NOT 'withdrawn'
     AND NEW.snapshot IS NOT (SELECT snapshot FROM publishable WHERE claim_id = NEW.claim_id)
BEGIN
  SELECT RAISE(ABORT, 'a ledger entry must be exactly what is publishable right now');
END;

-- Only something currently public can be withdrawn, and the entry records what it was.
CREATE TRIGGER ledger_withdraw BEFORE INSERT ON publications
WHEN NEW.status = 'withdrawn'
     AND NOT EXISTS (
       SELECT 1 FROM publications p
       WHERE p.id = (SELECT max(id) FROM publications WHERE claim_id = NEW.claim_id)
         AND p.status = 'published'
         AND p.snapshot IS NEW.snapshot)
BEGIN
  SELECT RAISE(ABORT, 'only what is currently published can be withdrawn');
END;

-- The time of a confirmation is the time it is recorded, not a time someone supplies.
CREATE TRIGGER ledger_now BEFORE INSERT ON publications
WHEN NEW.confirmed_at IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', NEW.confirmed_at)
     OR abs(julianday(NEW.confirmed_at) - julianday('now')) * 86400 > 60
BEGIN
  SELECT RAISE(ABORT, 'a confirmation is timestamped when it is recorded');
END;

-- Append-only, on any connection. The insert guard also stops REPLACE, which would
-- otherwise remove an existing entry without firing the delete guard.
CREATE TRIGGER ledger_no_overwrite BEFORE INSERT ON publications
WHEN EXISTS (SELECT 1 FROM publications WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'the ledger is append-only');
END;

-- Entries are numbered 1, 2, 3, … by the database. Nothing is ever removed, so an
-- entry's number always equals the number of entries once it is in. This is what makes
-- "the newest entry" mean the same thing forever; a caller cannot pick a number.
CREATE TRIGGER ledger_in_order AFTER INSERT ON publications
WHEN NEW.id IS NOT (SELECT count(*) FROM publications)
BEGIN
  SELECT RAISE(ABORT, 'ledger entries are numbered in order by the database');
END;

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON publications
BEGIN
  SELECT RAISE(ABORT, 'the ledger is append-only');
END;

CREATE TRIGGER ledger_no_delete BEFORE DELETE ON publications
BEGIN
  SELECT RAISE(ABORT, 'the ledger is append-only');
END;

-- A claim with a public record cannot be deleted or renumbered: publications.claim_id
-- refers to it, and the foreign key refuses both.

-- What the website shows: the newest entry of each claim.
CREATE VIEW current_publications AS
SELECT p.*
FROM publications p
WHERE p.id = (SELECT max(id) FROM publications WHERE claim_id = p.claim_id);
