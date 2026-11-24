# 0010 哪些活用订阅（Claude Code），哪些活花 API 的钱

- 日期：2026-11-22
- 状态：总协调提议，等创始人确认（这是路线决定）
- 起因：创始人指出，今天的试跑花了约 16.5 美元 API 费用；以后运营靠订阅，不能让 API 承担大部分工作。

## 今天的钱花在哪里

| 环节 | 花费 | 为什么贵 |
| --- | --- | --- |
| 抽取 492 条候选 | 约 6.5 美元（加作废的约 8 美元） | 每次调用都把整份 PDF（约 4 万 token）重发一遍 |
| 逐页转写原件（为了核对原话） | 约 1.2 美元 | 同上 |
| 找凭据（联网搜索） | 评审试跑的大头 | 搜索结果很长，全部算输入 |
| 评审判定 | 较少 | 但也把整份凭据 PDF 发给每个评审 |

真正需要“几家不同公司的模型各自独立判断”的，只有最后一步判定。前面几步都是体力活。

## 提议：两层

**第一层：Claude Code 做体力活（用订阅，不花 API 的钱）**

由定时任务或总协调派出的 agent 完成，产出都是固定格式的文件：

1. 读专用邮箱，收链接（已经这样做）。
2. 下载、存证原件（程序做，不用模型）。
3. 读原件、抽出候选承诺、标页码（Claude Code 能直接读 PDF）。
4. 核对原话是否逐字出现（程序做）。
5. 找凭据、下载存证，并把每份凭据里**相关的那几段**剪出来，连同页码，做成一份“凭据包”。
6. 翻译。

**第二层：API 只做最后的判定**

- 每位评审只收到凭据包：承诺原话、判定标准、几段凭据原文和页码。不再发整份 PDF。
- 四家各判一次，互相看不到。评审可以要求“凭据不够”，那就判“待评估”，并写明缺什么。
- 估算：每票约 5 千 token 输入、1 千输出，四家合计每条约 0.1 至 0.2 美元；200 条约 20 至 40 美元。
  今天的模式下，同样 200 条要贵好几倍（主要是整份 PDF 反复发送）。

## 要守住的原则

- **原则 8（不受制于人）：** 第一层只依赖 Claude Code 一家，但它的产出是普通文件，换任何工具都能接着做；
  做结论的第二层仍然是四家。业务代码仍然只经过 AI 接口层调用模型；Claude Code 是“团队成员”，不是业务代码。
- **原则 2：** 凭据包只是剪辑，原件和哈希都在本地；每段摘录由程序核对确实出自原件。
  评审判定时如果觉得摘录不够，可以要求看更多，不能凭空判断。
- **做事和检查分开：** 第一层由 Claude 做，判定的四位评审里也有 Anthropic 的模型（经 API）。
  同一家公司既剪凭据又参与判定，可能带进同样的盲点；所以剪辑时要留下“看过但没选”的段落清单，抽查时能看到被略过的内容。

## 异议与风险

- **订阅额度有限。** 今天下午已经撞到一次 5 小时上限。第一层的大批量工作（读纲领、找凭据）放到夜里由定时任务跑；应用要开着。
- **剪辑本身是一种选择。** 剪掉的段落评审看不到。缓解办法见上（留下没选的段落清单；评审可要求更多）。
- **订阅条款。** 用 Claude Code 做这类整理工作属于正常用途；如果以后量很大，要再看一次条款。
- 今天试跑写的 `src/extract.js` 和 `src/jury.js` 的搜索部分会改成“第一层由 agent 做、程序只做核对和存证”，判定部分保留。

## 依据哪条原则

原则 5（把钱花在真正需要多家独立判断的地方）、原则 7（体力活自动化）、原则 8（判定仍然多家，产出是普通文件）。

## 创始人的修改（2026-11-22）

创始人认为每条 0.1 美元仍然偏高，提出：评审团改为三家——**Claude 用订阅（Claude Code）、OpenAI 用订阅（Codex）、只有 Gemini 走 API**。
总协调同意这个方向，补充：

- **花费：** 只剩 Gemini 一票走 API。凭据包约 5 千 token，用 Gemini 的便宜型号每票约 0.001 至 0.01 美元，
  每条承诺不到 1 美分；200 条约 1 至 2 美元。
- **三家仍是三家公司**，独立性够做第一阶段；比原定的四家少了 Mistral（唯一一家欧洲公司）。以后有余力再加回。
  决策 0006 的“四家”相应改为三家。
- **订阅评审要像 API 一样可追溯：** 每一票都由一个只看到凭据包的全新会话做出，记下模型、提示词版本、时间；
  不让做第一层整理的同一个会话来投票。
- **Codex 需要先核实**：用 ChatGPT 订阅能否让程序自动调用 Codex（非交互运行），条款是否允许；
  还要在这台电脑上装 Codex 命令行工具，这是第三方软件，要创始人同意后再装。
- **订阅额度是共享的**：评审和整理都吃订阅额度，夜里批量跑；额度用完时当天暂停，不自动改走 API。

## 进展（2026-11-22 傍晚）

- 创始人同意装 Codex 并已有 ChatGPT 订阅。Codex 命令行 0.171.0 已装（npm），沿用创始人已有的 ChatGPT 登录。
- 试跑成功：在空的临时文件夹里，只读、不留会话记录（`--ephemeral -s read-only`）、按 JSON 格式要求回答，默认模型 gpt-6.2-sol。
- 尚未核实：完整的使用条款；每周用量上限；能否完全关掉它的联网和命令执行（目前靠空文件夹加只读限制）。

## Progress (2026-11-23): the Claude judge runs isolated, like Codex

- The Claude subscription vote is now made by the program through the Claude Code command line (2.1.330, the
  founder's own login; terms in decision 0013): `src/ai/claude-cli.js`, provider `claude` in the AI interface layer,
  run by `node src/jury.js vote <name>.pack.json` next to Codex (`--claude-model`, default `claude-opus-5-5`).
- Each vote is a new `claude -p` process in an empty temporary folder, with no tools (`--tools ""`), no MCP, skills,
  hooks, plugins, CLAUDE.md or settings files (`--strict-mcp-config --disable-slash-commands --safe-mode
  --setting-sources ""`), nothing saved (`--no-session-persistence`), no permission prompts, the system text as
  `--system-prompt` (documented; 16,561 characters, refused above 24,000 for the Windows command-line limit), and an
  environment allowlist (no `.env` keys, no `ANTHROPIC_API_KEY`, so it never bills the API) plus
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1`. Same system text and prompt as Codex, so
  `system_sha256` is the same. A reply is refused unless the tool reports `subtype` success, one turn, no permission
  denials and the model that answered. The program writes the vote file with the tool's version, its session id and
  those run facts; before a re-vote it moves the member's earlier vote file aside.
- The subagent path (`team/run/judge-subscription.md`) is superseded; `team/run/judge.md` says what the isolation
  proves and what it does not (vote files are not signed).
- **Smoke test in the founder's terminal (coordinator, 2026-11-23), first version:** made-up claim, vote via
  `claude-cli`, model `claude-opus-5-5`, session named, verdict `partly_came_true` (4 of 10 pools: correct). No-tools
  probe: tools `[]`, working folder an empty `kv-claude-work-*` folder, one turn, no permission denials.
- **Smoke re-run with `--system-prompt` (2026-11-23):** vote and no-tools checks pass. Claude Code puts one fixed
  sentence before our system text ("You are a Claude agent, built on Anthropic's Claude Agent SDK."). Coordinator
  accepted it as a known prefix, like Codex's own instructions; every vote records it in `raw.system_prefix`, and the
  smoke check fails on any other prefix.
- **Still open:** one more smoke run to see the new prefix check pass; how many votes a day the plan allows next to
  layer-1 work; Fable review of the change (spawn, environment, reply checks).

## Addendum (2026-11-23 night, founder in chat): all four judges on subscriptions, if the terms allow it

The founder's direction: subscription prices are far below API prices, so all four judges (Anthropic, OpenAI,
Google, Mistral) should run on subscriptions where possible. Status, from a first look (not yet a terms check):

- Anthropic (Claude Code CLI) and OpenAI (Codex CLI): running on subscriptions, isolated; terms checked for Claude.
- Google (Gemini CLI): Google's docs point non-interactive use to API keys or Vertex AI; a Google forum reply says
  personal AI Pro is for individual, human-driven use; an unofficial post claims subscription sign-in for the CLI was
  withdrawn in June 2026. Unclear — check the official terms before any setup.
- Mistral (Vibe CLI, included in the Pro plan at $14.99/month): has a programmatic mode, but the install docs
  recommend an API key for automation. Unclear — check the terms.

Rule kept from this decision: a judge whose subscription terms do not allow our use runs on the API instead (or the
founder decides to leave it out). Our use is one person, a few hundred votes, run by hand — the terms are checked
against that, and again if readers can ever trigger a vote.

Founder, same night: "在机制设置的时候把订阅和 API 两个都保持可能" — every judge must be able to run on either channel.
The channel is a setting per judge, not code: switching one judge from subscription to API (or back) changes no
program logic, and every vote already records its `channel` and `via`.

**Progress (2026-11-23, developer):** built. Each member's `channel` (`subscription`, `api` or `off`) and model live in
`src/jury-members.json` (versioned; replaces `--codex-model`, `--claude-model`, `--gemini-model`, `--anthropic-api-model`);
`runPackVotes` picks the adapter from it. A member without its key or tool does not vote, with the reason, never on the
other channel, and its earlier vote is moved aside only right before a real call. A channel with no adapter (Gemini and
Mistral on subscription) is refused when the settings are read. Gemini and Mistral are `off` until switched on.
- **A round now needs a vote from every member that is on**, API members included (before, only the subscription judges
  were needed and Gemini's vote could come in a later round). A member set to `api` without its key keeps rounds open
  until the key is added or the member is set to `off`.
- **A round records the jury it was closed under** (`jury`: provider, channel, model of each member that was on; round
  line format 2). Only those members' votes go into it, and the desk counts no one else's. Format-1 lines (before
  this) count the jury of that time: openai, anthropic, gemini.
- One vote per company per round, and one test of what a vote is (`juryVoteProblems` in `src/jury.js`): the
  provider is one of the four companies exactly (no alias such as "codex" or "google"), its `via` is the route of
  its channel, the file is named for both. Tally, round closing and the desk use the same two functions. The superseded subagent votes (`via`
  "claude-code") are not accepted (coordinator, 2026-11-23): the 10 trial claims are re-cut and re-voted under rules 0.8.

Founder, 2026-11-24: Google and Mistral judges wait until production starts ("开始PROD之后再来，不然订阅要花钱").
Until then the jury is OpenAI (Codex) and Anthropic (Claude), both on existing subscriptions; Gemini and Mistral stay
`off` in `src/jury-members.json`. Their terms check is postponed to then.

Founder, 2026-11-24 (board, `judge-channel-safety`): "Subscriptions + guards until auto-approval". Both judges stay on
their subscriptions with the guards of Fable review 9 while every verdict is confirmed by the founder; before any
automatic approval the channel is decided again (Fable: OpenAI first to the API, since Codex is the weaker one and
does not confirm its answering model).

Founder, 2026-11-24 (board, `mistral-now`): "Add it now" — Mistral (Vibe CLI, installed by the founder) becomes the
third judge now, after its terms are checked and its adapter passes the same isolation tests as the other two.
