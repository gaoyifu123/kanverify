# 0005 工作区和账本分开

- 日期：2026-11-22
- 状态：已定
- 谁定的：总协调提议（回头看记录），创始人确认

## 背景

前两版数据库规则都被独立审查找出漏洞。原因在路线上：同一行数据既是草稿又是公开记录，
就要为“发布之后”的每一种改法各写一条规则。完整经过见
`docs/log/2026-11-22-step-back-database-rules.md`。

## 决定

- **工作区**：承诺、结论、证据、来源、评审团投票这些表可以随便改，只检查单行数据本身是否合格。
- **账本**（`publications` 表）：每确认一次，把这条承诺当时的完整内容存成一份快照。
  账本只能增加，不能修改、覆盖或删除。
- **网站只从账本生成**，读的是每条承诺最新的一条账本记录。
- **什么能进账本只在一个地方定义**：`db/schema.sql` 里的 `publication_checks`。
- **撤回**是往账本里加一条“已撤回”，必须写原因，原记录留在历史里。网站上页面保留并注明已撤回
  （创始人 2026-11-21 在看板上确认）。
- **确认的时间由数据库在记录时填写**，不能由调用方指定。
- **账本记录的编号由数据库按顺序给**，调用方不能自己挑编号。“最新的一条”因此永远有确定的含义。
- **人物的职务记在承诺上，不记在人物上**（`claims.speaker_role_fr` 和 `speaker_role_en`，格式 5 起分两种语言，见决策 0007）。职务会变，当时以什么身份说的不会变。
- **每次确认可以记下人工审核用了多少秒**（`publications.review_seconds`），供原则 7 的每周报表用。

## 这对日常工作意味着什么

- 改了工作区里的任何东西，公开的内容都不会变，直到再确认一次。
- 审核台要显示“有未确认的改动”，以及一条承诺为什么还不能确认。
  这两件事分别由 `src/ledger.js` 的 `hasUnconfirmedChanges` 和 `publicationBlockers` 提供。
- 改动历史不需要单独的日志：同一条承诺的前后两份快照一比就知道改了什么。
- 评审团当时的投票也在快照里，所以“评审团一致的结论和人的确认对不对得上”可以直接从账本统计。

## 依据哪条原则

- 原则 4（想清再写）：两轮审查没有收敛，停下来换路线，而不是继续补。
- 原则 5（最简方案）：触发器从 24 个降到 7 个，外加一个定义发布条件的视图。
  （刚改完时是 6 个；第三轮审查后加到 10 个；第四轮审查后划定了边界，去掉 3 个只在边界之外才有用的。）
- 原则 2（无源不录）和原则 1（问题和结论一样重要）：进账本的条件就是这两条原则。
- 原则 3（一把尺子）里“每一次更正都公开”：账本本身就是完整的更正历史。

## 保护到哪一步为止

- 状态：已定。创始人 2026-11-22 08:28 在看板事项 `db-scope` 里选了“接受这条边界”。
  收尾检查和记录格式 5 的审查合在一起做（决策 0007）。

四轮独立审查之后，账本的核心保护都守住了：伪造快照、修改或删除账本、挑编号、确认后改草稿，
在任何普通连接上都被拒绝。第四轮剩下的发现都要先做下面两件事之一才能触发：

- 故意关掉数据库自带的完整性设置（`PRAGMA foreign_keys = OFF`、`PRAGMA ignore_check_constraints = ON`）；
- 用另一个工具直接改数据库文件，或者删掉触发器。

提议把边界划在这里：

| 范围 | 靠什么保护 |
| --- | --- |
| 我们自己的代码和 AI 写的代码里的普通语句（增、改、删、覆盖） | 记录格式本身，有测试，经过四轮独立审查 |
| 故意关掉完整性设置的代码、在工作区表上用覆盖写入的代码 | 代码审查一律退回（已写进 `.claude/agents/code-reviewer.md`） |
| 有人直接改数据库文件 | 谁能碰这台电脑，以及每日备份 |

划在这里而不是继续加规则的理由：前两轮的教训就是规则越加越多而问题不收敛。
边界之外的情况不是“写错”，而是“故意”，对付故意的行为靠审查比靠更多触发器有效。

两件已知的、接受下来的事：

- **工作区不防丢失。** 在工作区的表上用覆盖写入，会把相关的结论、证据和投票一起删掉。账本不受影响。
- **评审团投票是工作数据，可以被改。** 作数的是确认那一刻冻结进快照的“谁投了什么”。
  快照里只留投票结果，不留各模型引用的凭据段落；那些留在工作区。

## 放弃了什么

- 在工作区里当场拒绝不合规的数据（比如把一份法律登记为承诺的出处）。现在它能存进工作区，
  但确认不了。换来的是工作区几乎没有触发器，正常的修改都不会被挡住。
  唯一的例外是格式 5 加的 `subjects_id_fixed`：人物编号是网址的一部分，不许改（决策 0007）。
  编号不复用靠 `AUTOINCREMENT`；故意指定一个用过的编号插入新人物，不加触发器去防，
  由代码审查退回：业务代码插入人物时一律不指定 `id`。
- 彻底删除一条已经公开过的记录。账本不能删。

## 什么情况下重新考虑

- 出现必须彻底抹掉某条公开记录的情况（例如法律上的强制要求）。那时需要一个有明确授权、
  留有记录的特别流程，而不是放开账本的删除。
- 快照使数据库大到影响使用。

## Addendum 2026-11-23: the deadline rule lives in confirm() (record format 10)

- Status: decided by the coordinator after Fable review 3 (finding 1; `docs/log/2026-11-23-fable-review-3.md`).
- What may enter the ledger is now **`publication_checks` plus the deadline rule in `confirm()`** (`src/ledger.js`),
  and nothing else. `confirm()` is the one way into the ledger the code uses.
- Why not in the view: a rule that depends on today's date would make the view give different answers depending on
  when and where it is read (UTC or local date). The view stays time-independent; the deadline rule is applied at the
  moment of confirming, on a local date passed in or today on this machine.
- One function for the rule (`deadlineProblem` in `src/rules.js`) is used both by `confirm()` and by the jury's vote
  checks (`src/pack.js`), so the two cannot drift apart. The review desk shows it through `publicationBlockers`.
- Known limit, accepted: a statement that inserts into `publications` directly (not through `confirm()`) is still held
  to `publication_checks` by the `ledger_exact` trigger, but not to the deadline rule. That is the same boundary as
  the scope section above: code that bypasses `confirm()` is rejected in review.
- `confirm()` also checks that exactly one entry was written before it reports success (finding 2).
- Principles: 2 (no conclusion before the evidence can exist), 4 (no time-dependent patch in the view, as the
  reviewer warned), 5 (one shared function, not two copies).

## Addendum 2026-11-23: Format 11 (after Fable review 2, second re-check)

- Status: decided by the coordinator after the second re-check of Fable review 2 (findings 1, 2 and the first
  Low item; `docs/log/2026-11-23-fable-review-2.md`). Reviewed by Fable in the record-format area before it counts.
- **A renunciation is seen by the ledger.** A `renunciation` source may now stand among a verdict's evidence on a
  promise (dated on or after the promise) under `partly_came_true`, `came_true`, `to_evaluate`, and `unverifiable`
  on a measurable promise (coordinator, after Fable review 7: "ends the wait whatever the verdict"), beside at least
  one other evidence row, never alone; under `not_came_true` it may still be alone. Vague and hedged promises are
  unchanged: `unverifiable` on the wording alone, with no renunciation cited. A cited renunciation dated after the
  day of confirmation is refused (a document cannot be cited before it exists). It counts as evidence of an
  outcome only under `not_came_true`, as before (`outcome_has_evidence` unchanged; `evidence_is_primary` widened).
  `confirm()` finds it there, so a renounced promise is past its deadline whatever the outcome verdict, and
  `pending` is refused. The ledger still never reads the pack file.
- Why this and not a link from the claim to its renunciation (one sentence, principle 5): a link would still need the
  evidence rule widened for a vote that cites law and renunciation, plus a new column, a desk write path and a new
  snapshot field, so the evidence row alone is the smaller change.
- The vote checks (`src/pack.js`) apply the same rule: the wait ends only when the vote cites the renunciation, and a
  stop names the cause (not cited, dated after today, dated before the promise), for every renunciation given, and
  never suggests citing one where that is refused. Two stricter checks stay on the pack side: `pending` is refused
  when any document of the pack is a renunciation that ends the wait, cited or not, or a renunciation with no date.
- **The snapshot's verdict carries `based_on_round`.** The site counts and lists only the votes of that round; a
  verdict resting on no round (written from the wording alone) shows no jury. Earlier rounds stay in the snapshot.
- **A closed round keeps its votes' text.** `tally` (closeRound) writes each vote file's exact text into the round's
  line of `<name>.rounds.jsonl` beside its sha256, so a re-vote overwriting a file cannot lose a closed round's votes
  (decision 0003: every vote is recorded). A vote file that is not UTF-8, so that its text would not hash back to
  its sha256, stops the round from closing; a round line whose text is missing or does not hash back is skipped.
  The desk still reads the vote files and stops if one changed.
- **A round overwritten before the desk saw it is kept on disk only** (coordinator's decision, Fable review 7): its
  votes are in the rounds file, but they are not written to `jury_votes` and do not appear in any snapshot. The desk
  reads only the newest closed round.
- Known limit, accepted: a `pending` verdict written by hand with no evidence on a renounced promise, confirmed by
  calling `confirm()` directly, is not caught: the ledger has no record of the renunciation then. The desk refuses it
  (pack-side check). Linking the claim to its renunciation would close this; not done (see above).
- Data: `data/kanverify.db` upgraded as for formats 8-10 (backup `data/kanverify-format10-backup-20261123.db`),
  then rebuilt once more with the final format-11 views after Fable review 7 (the first format-11 file is kept as
  `data/kanverify-format11-draft-backup-20261123.db`). Both scripts: `docs/log/2026-11-23-format11-migration.md`.
- The review desk no longer passes its own date to `confirm()`; the ledger uses this machine's date.
- Principles: 2 (the ledger decides from what is in the database, not a file), 3 (one rule for judges, desk and
  ledger), 5 (no new column or table), 1 (decision 0003's "record every vote").

## Addendum: migration exemption (2026-11-23, coordinator, after Fable review 7 re-check)

Format upgrades so far (8, 9, 10, 11) read the old file read-only with `DatabaseSync` and copy rows with their ids into a
fresh file made by `openDatabase`. Both acts are on the reviewer's always-send-back list; they are now a written,
narrow exemption (`.claude/agents/code-reviewer.md`, item 7): one-off migrations only, byte-identical backup first,
plain INSERTs in one transaction, no pragma / `writable_schema` / REPLACE, `sqlite_sequence` never written, every row,
the `sources` counter and every archived file verified before the swap, script text saved in `docs/log/`.

**Open before the first real confirmation:** this method only works while the ledger is empty (it copies `sources`
and refuses otherwise). Once `publications` holds entries, plain INSERTs cannot carry them (`ledger_now`,
`ledger_exact`). A migration route for a non-empty ledger must be designed and reviewed before the founder confirms
the first verdict (principle 4).

## Addendum 2026-11-23: Format 12 (rules recorded with each verdict; RN-1 from one truth table)

- Status: built by the developer from the founder's decisions (0013 amendment, 0014, 0015) in one brief
  (retrospective of 2026-11-23: data model, code, prompts and docs in one pass). Reviewed by Fable in the
  record-format area before it counts.
- **The rules a verdict was judged by are part of the record (decision 0014).** `verdicts.rules_version` (the version of
  `docs/methodology/verdict-standard.md`) and `verdicts.rules_applied` (a JSON list of rule ids) are required on every
  verdict row and go into the snapshot. `publication_checks.rules_recorded` checks that every item is a distinct id of
  the standard's form (`DL-2`). Whether the version is kept and the ids exist in it is checked outside the database,
  because the view cannot read the standard: by the vote checks, the desk, and (after Fable review 8, finding 2)
  `confirm()` itself (`src/standard.js`), so a made-up version or id can never enter the append-only ledger and stop
  the site build for good; after the re-check, `confirm()` accepts only the current version (R4). `confirm()` also
  requires RN-1 among the rules when a reversal is cited (finding 5), and EA-1 for a "came_true" confirmed on or
  before the deadline (R3). The
  version has the same NUL guard as the ids. Every version of the standard is kept byte for byte in
  `docs/methodology/versions/`, and a test checks that the live file equals the copy of its own version (finding 3),
  so the text a version number stands for never changes. Why columns and not a table (principle 5): a verdict has one
  list, read and written whole.
- **A renunciation is read from one truth table (verdict-standard.md 0.6, RN-1).** It may stand among a verdict's
  evidence only under `not_came_true`, on a measurable promise, dated on or after the day the promise was made and on
  or before its deadline (row 5); there it is enough on its own. Format 11's widening (a renunciation beside other
  evidence under `partly_came_true`, `came_true`, `to_evaluate`, `unverifiable`) is removed, and with it the
  "ends the wait" machinery in `src/rules.js`, `src/ledger.js`, `src/pack.js` and the site. A renunciation dated after
  the deadline is refused (Fable review 6 re-check, N2, closed). The claim types RN-1 applies to are one switch, written
  once in `src/rules.js` (`REVERSAL_TYPES`, promises only, founder 2026-11-23) and once in the schema (`c.type IN
  ('promise')`); a test checks they agree.
- **A prediction never has an inferred deadline (VG-3, decision 0015 S2):** a claims row check.
- The known limit of format 11 ("a `pending` verdict written by hand on a renounced promise, confirmed by calling
  `confirm()` directly, is not caught") stays: the ledger sees only cited evidence. The vote checks and the desk refuse
  every verdict but `came_true` or `not_came_true` once the pack holds a renunciation in its window.
- Data: `data/kanverify.db` migrated under the exemption above (ledger still empty); backup
  `data/kanverify-format11-backup-20261123.db`; rebuilt once more with the final schema after Fable review 8 (the first
  format-12 file kept as `data/kanverify-format12-draft-backup-20261123.db`). Scripts and checks:
  `docs/log/2026-11-23-format12-migration.md`.
- Principles: 3 (one ruler, and visibly which one: every verdict names its rules), 2 (a renunciation is evidence only
  where the table says), 4 (the rule written once, the code derived from it), 5 (two columns, no new table).
