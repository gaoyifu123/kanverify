# 团队分工与协作

Agent 分成两组。建造组把系统搭出来，运行组每天产出内容。
两组守同一条规矩：做事的不检查自己，检查的不动手改。

## 建造组（编码助手里的子 agent）

| 角色 | 定义文件 | 负责什么 | 交出什么 | 不能做什么 |
| --- | --- | --- | --- | --- |
| 总协调 | `CLAUDE.md`（主会话） | 拆任务、派活、汇总进度、守住原则 | 每日任务单、进度摘要、看板更新 | 不改设计稿 |
| 设计 | `.claude/agents/designer.md` | 信息架构、视觉稿、组件规范、文案语气 | `design/` 下的设计稿和规范 | 不改记录格式，不写业务代码 |
| 开发 | `.claude/agents/developer.md` | 按设计稿和记录格式实现流水线、审核台、网站 | 可运行的代码和测试 | 不自行改界面，不改判定规则 |
| 代码审查 | `.claude/agents/code-reviewer.md` | 独立检查开发的产出 | 问题清单 | 只退回，不自己改 |

## 运行组（流水线里的程序，经 AI 接口层调用模型）

| 角色 | 说明文件 | 负责什么 | 交出什么 | 不能做什么 |
| --- | --- | --- | --- | --- |
| 获取 | `team/run/fetch.md` | 找并下载原始凭据，维护各国凭据来源清单 | 原件、快照、哈希 | 不把任何人的说法当证据 |
| 抽取 | `team/run/extract.md` | 从纲领原件逐条抽出承诺 | 带原文和页码的候选条目 | 不改写原话 |
| 评审团 | `team/run/judge.md` | 多个不同的模型各自独立初判 | 结论、凭据段落、理由 | 互相看不到对方的结论 |
| 中立性审查 | `team/run/neutrality.md` | 检查选材、措辞、证据 | 通过或退回，附理由 | 只退回，不改结论 |
| 翻译 | `team/run/translate.md` | 法语和英语译文 | 译文 | 原话保留原文，不增不删 |

创始人是最终负责人：确认结论、处理分歧、修改原则和路线。

## 用哪个模型

额度有限，所以默认用 Opus 5.5，只在想错一次代价最高的地方用 Fable 5.2。

| 谁 | 模型 | 为什么 |
| --- | --- | --- |
| 总协调（主会话） | Opus 5.5 | 拆任务、派活、更新看板。由创始人在应用的模型菜单里选 |
| 设计 | Opus 5.5 | 按设计简报出稿 |
| 开发 | Opus 5.5 | 按写好的设计和记录格式实现 |
| 代码审查，日常 | Opus 5.5 | 普通代码改动 |
| 代码审查，关键改动 | **Fable 5.2** | 见下 |
| 回头看、路线决定 | **Fable 5.2** | 见下 |
| 查资料、核实文档 | Sonnet 5.5 或 Haiku 5.5 | 读得多，判断少 |

**什么时候请 Fable 5.2**（总协调在派活时指定，只用这一次）：

1. 审查任何会影响“什么能公开”的改动：`db/schema.sql`、`src/ledger.js`、来源规则和判定标准的执行逻辑。
2. 审查涉及安全的改动：处理下载的文件、密钥、对外发布。
3. 熔断之后的回头看，以及改记录格式、换技术路线这类决定。
4. 评审团的提示词：它写错了，错的是之后每一条结论。

审查用 Fable 5.2 时把范围说窄：只查这次改了什么，不重新审查已经守住的部分。前四轮审查每轮都很贵，
其中后两轮是只查改动的。

**Fable 5.2 额度用完时：** 创始人 2026-11-22 定，当天改用 Opus 5.5 做本该由 Fable 做的审查，额度恢复后切回。
用 Opus 代审的项目在进度摘要里写明。

运行组（获取、抽取、评审团、中立性审查、翻译）用的是另外四家的模型，在 AI 接口层里配置，和上表无关。

## 评审团怎么工作

- **现在：** 至少两个不同的模型各判一次，创始人逐条确认后才发布。
- **目标：** 四到五个主流模型组成评审团。全体一致的自动通过；不一致的交给人审。
- **从现在到目标的条件：** 从第一天起记录每个模型的每一票。等“全体一致”的结论和
  创始人的确认结果在足够多的条目上对得上，再放开自动通过。放开之后仍然抽查。
- 详见 `docs/decisions/0003-ai-jury.md`。

## 协作机制

1. **同一份原则。** 所有 agent 开工先读 `PRINCIPLES.md`。运行组的提示词由程序在运行时拼接它，不手工复制。
2. **交接靠文件和数据库，不靠对话记忆。** 每个角色的输入和产出有固定格式，换一个模型或换一次会话都能接着做。
3. **做事和检查分开。** 开发不审自己的代码，模型不审自己的结论。
4. **检查方只退回。** 退回时说明理由，由原来的角色修改。
5. **设计先于开发。** 设计稿定稿后开发才动工；开发认为做不了的，退回设计，不自行改动。
6. **分歧上报给创始人。** 评审团不一致、同一条被退回两次、agent 之间对规则理解不同，都进入创始人的待处理队列。
7. **产出可追溯。** 每份产出记下是哪个角色、哪个模型、哪个版本的提示词做的。

## 模板

| 用途 | 文件 |
| --- | --- |
| 派一个任务 | `team/templates/task-card.md` |
| 交一份产出 | `team/templates/output.md` |
| 熔断后的回头看 | `team/templates/step-back.md` |
| 记一个决定 | `team/templates/decision.md` |
| 每日进度摘要 | `team/templates/daily-log.md` |

## How Fable 5.2 fits the workflow (2026-11-22)

- **No agent switches models.** Every agent keeps one model for its whole life. The coordinator and builders run on Opus 5.5;
  Fable 5.2 is only ever a separate, fresh reviewer agent. A fresh reviewer is also what independence requires (rule 3).
- **One Fable reviewer per area, reused for its re-checks.** When a Fable review sends work back, the fix is re-checked by
  messaging the *same* reviewer (it keeps its context), not by starting a new one. This is cheaper and it remembers its own findings.
- **Opus first, Fable last.** Opus reviews each step as it is built and catches the ordinary problems; Fable reviews the
  combined result once, at the end of an area, for the items in `team/README.md` "When to use Fable 5.2".
- **Give Fable the change, not the conclusions.** Brief it with the list of changes and the git range to read
  (`git diff <last-fable-tag>..HEAD -- <files>`), never with the Opus reviewers' verdicts, so it is not anchored.
- **Mark what Fable has passed.** After an area passes, tag the commit `fable-<area>-<date>`; the next Fable review of that
  area reads only the diff since that tag.
- **Queue, not ad hoc.** Pending Fable work lives in `docs/review-queue-fable.md`, ordered by risk; when the quota runs out,
  the queue stops and resumes after the reset. Never fall back to another model silently.
