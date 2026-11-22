# 产出：AI 接口层（src/ai/）

- 角色：开发（建造组）
- 模型和提示词版本：Opus 5.5（建造组，不适用运行组提示词版本）
- 日期：2026-11-22

## 做了什么

动手前的想法：业务代码只认一个函数 `ask()`；每家供应商一个小文件，只负责“拼请求、读回答”；
网络、密钥、超时、JSON 校验放在一处。测试注入 `fetchImpl` 和 `env`，因此不联网、不读真实 `.env`。

新增文件（全部在 `src/ai/`，零依赖）：

- `index.js`：`ask(request, { fetchImpl, env, adapters })`。
  - 请求：`provider`、`model`、`promptVersion`、`prompt` 必填；`system`、`json`（默认 false）、`maxTokens`（默认 16000）、`timeoutMs`（默认 120 秒）可选。
  - 返回：`{ text, json?, provider, model, modelVersion?, promptVersion, usage?, raw }`。`provider`、`model`、`promptVersion` 对应 `jury_votes` 的三列；`modelVersion` 是供应商回报的实际版本（如别名解析后的日期版），便于追溯（team/README.md 协作机制 7）。
  - `json: true` 时：接口层不往提示词里加任何文字；system 和 prompt 都没出现 “JSON”（不分大小写）就在发请求前抛 `bad_request`，提示提示词必须要求 JSON。解析回答（允许外面包一层 Markdown 代码块）；失败重发一次，再失败抛 `bad_json`。没有别的重试。
  - 每次请求用 `AbortSignal.timeout`，超时抛 `timeout`。
  - 密钥：从 `env[KEY_VAR]` 读；用的是 `process.env` 时，第一次调用前读一次项目根目录的 `.env`。缺密钥抛 `missing_key`，消息只写变量名。任何错误的 message 和 stack 里如果出现密钥，替换成 `[redacted]`。
  - 登记表 `ADAPTERS = { anthropic, gemini, openai, mistral }`；测试或以后的本地模型通过 `adapters` 选项接入，不改业务代码。
- `errors.js`：唯一的错误类型 `AiError`，`code` 为 bad_request、unknown_provider、missing_key、network、timeout、http、bad_response、bad_json 之一，带 `provider`、`status`。
- `env.js`：`loadEnv(path, env)`，用 Node 内置 `util.parseEnv`，只填没设置的变量，返回设置了的**变量名**，不打印任何东西；文件不存在不报错。
- `http.js`：各家共用的 POST。网络错误不把原始错误挂在 `cause` 上（原始错误可能带着请求头）。HTTP 错误带状态码和回答正文前 500 字。
- `anthropic.js`、`openai.js`、`mistral.js`、`gemini.js`：各家的请求和解析。OpenAI 和 Mistral 共用 `chat-completions.js`。Gemini 的密钥放在 `x-goog-api-key` 请求头里，不放在 URL 里；模型名只允许 `[A-Za-z0-9._-]`，防止改写 URL 路径。
- `fake.js`：`createFakeAdapter(script)`，按脚本返回文字或抛错，记录每次调用，不需要密钥。

新增 `test/ai.test.js`，20 个测试：四家的请求形状（地址、请求头、正文）和回答解析；每次调用都返回 provider、model、promptVersion；必填项；缺密钥时报变量名且不发请求；HTTP 错误里密钥被遮盖（包括 stack）；网络错误不带原始错误；超时；空回答和格式不对的回答（含 Gemini 只有思考没有可见文字）；传 `temperature` 被拒、四家都不发 `temperature`；Gemini 用量含思考 token；JSON 重试一次成功、两次失败后不再调第三次；JSON 打开但提示词没提 JSON 时发请求前拒绝、且不往提示词里加文字；JSON 关闭时不改 system；`.env` 读取不覆盖已有变量；`src/` 下 `ai/` 以外的文件不得出现供应商地址或 `_API_KEY`（原则 8 的守门测试）。

`npm test`：98 个全部通过（原有 78 + 新增 20）。没有 `src/ai/` 时新测试无法导入，必然失败。

工作中没有发出任何真实网络请求，没有创建 `.env`，没有读到任何真实密钥。没有改 `db/`、`src/ledger.js`、`src/archive.js`、`design/`、`board/`。

## 依据哪条原则

- 8 不受制于人：业务代码只经 `ask()` 调模型；换掉或增加一家只动 `src/ai/`；有测试守住“别处不准直连供应商”。
- 5 最简方案：一个函数、每家一个小文件、零依赖；`.env` 用内置 `util.parseEnv`，不自己写解析器。不做缓存、流式、限速和额外重试。
- 2 无源不录 / 协作机制 7（产出可追溯）：`promptVersion` 必填，每次返回 provider、model、promptVersion，评审团每一票都能存齐这三列。
- 6 有话直说：见下。

## 异议与风险

- **接口字段已由另一个 agent 于 2026-11-22 对照官方文档核实**（总协调转来结果），据此做了这些改动：
  - **去掉 `temperature`**：`ask()` 和四个适配器都不再支持，传了就抛 `bad_request`。原因：Anthropic 5.5 型号和 OpenAI 的旗舰型号会拒绝它；四家一律不传，评审团条件一致（原则 3、5）。代价：无法再要求“尽量确定”的输出，同一条重跑可能得到不同结论。
  - **`maxTokens` 默认改为 16000**：Anthropic、OpenAI、Gemini 的思考 token 都计入这个上限，上限太小会只剩思考、没有可见文字。可见文字为空仍抛 `bad_response`，有测试（Anthropic 空白、OpenAI 空串、Gemini 只有 thought 部分）。代价：单次调用的费用上限变高。
  - **Gemini 输出用量** = `candidatesTokenCount` + `thoughtsTokenCount`（有才加）。
  - 保留：`anthropic-version: 2023-06-01`；OpenAI 和 Mistral 的 `json_object`、Gemini 的 `responseMimeType`（暂不用 json_schema，需要时再加）；Gemini 继续用 `v1beta`（可用；`v1` 没测过）；OpenAI 继续用 Chat Completions。
- **仍未核实**（真正调用前要确认）：Anthropic 回答的结构（`content[]`、`usage`、`model`）；Mistral 的用量字段名（`usage.prompt_tokens/completion_tokens`）；Gemini 的 `x-goog-api-key` 请求头在当前文档页面上的写法；OpenAI 的 JSON 模式是否接受小写的 “json”。
- **（已按总协调决定处理）** 原先 `json: true` 会在 system 末尾加一句固定指令（`JSON_INSTRUCTION`）。总协调 2026-11-22 决定删掉：提示词只来自审查过的 `team/run/` 文件，接口层不加模型可见的文字。现在改为提示词里没有 “JSON” 就拒绝发送。风险：评审团和抽取的提示词必须自己写明要 JSON（目前两份都在示例里写了 ```json，能通过检查）。
- **型号不写进代码。** 决策 0006 说型号写进配置。`model` 由调用方必传，没有默认值。核实过的型号 id，留给以后的评审团配置用：
  - Anthropic：`claude-opus-5-5`（升级用 `claude-fable-5-2`）
  - OpenAI：`gpt-6.2-astra`
  - Mistral：`mistral-large-latest`（id 未确认，以后用真实密钥调 List Models 确认）
  - Gemini：`gemini-4-carbon`（是正式版还是预览版不清楚）
- **JSON 只校验“是合法 JSON”，不校验字段。** 评审团回答里 `verdict` 是否五选一、`excerpt` 是否逐字出自凭据，应当由评审团流水线和数据库约束去查，不在接口层。
- **Anthropic 没有用原生的结构化输出**，只靠指令 + 解析 + 重试一次。可能比另外三家更常触发重试。
- **以后可能需要但这次没做：** 429/5xx 的退避重试、限速、费用统计、流式。评审团一次跑很多条时，429 会直接变成错误；到时候再加，并写理由。
- **HTTP 错误里带了回答正文前 500 字。** 方便排错；密钥会被遮盖，但正文里如果有别的敏感内容会进入错误消息。目前判断风险低。
- 本次涉及密钥处理，按 `team/README.md` 属于“涉及安全的改动”，建议代码审查用 Fable 5.2（额度用完时按创始人当天的规定用 Opus 代审，并在进度摘要里写明）。

## 没做的和没验证的

- 没有对任何一家发出真实请求；请求和回答的格式只用注入的假 fetch 测过，见上面的“未核实”清单。
- 真实 `.env` 的自动读取路径（`env` 用 `process.env` 时）没有在测试里跑，以免读到本机的密钥；`loadEnv` 本身用临时文件测过。
- 超时只测了“signal 触发后抛 `timeout`”，没有测真实网络下读正文时超时。
- 没有接入抽取和评审团流水线，没有写评审团的型号配置，没有更新看板。

---

## 补充：按独立审查第一次退回修改（2026-11-22，开发，Opus 5.5）

### 做了什么

1. **（高）密钥部分泄露**：`src/ai/http.js` 原来先截 500 字再遮盖，密钥正好跨在截断处时，前半段会漏出来。现在 `snippet(text, key)` 先遮盖整把密钥再截断；截断后末尾如果和密钥开头一致（任意长度），也遮盖掉。测试：密钥从第 495 字开始；只有密钥开头落在截断处。
2. **守门测试**：豁免条件从 `startsWith('ai')` 改为第一级目录 `=== 'ai'`（`src/aiport.js` 不再被豁免）。另外，`src/ai/` 以外的文件不得导入 `src/ai/{anthropic,openai,gemini,mistral,http,chat-completions,fake}.js`，只能经 `index.js` 的 `ask()`。另有一个测试证明这两条检查本身能抓到违规写法。
3. **被截断的回答不再当成功**：各适配器检查结束原因，只有正常结束才放行（Anthropic `end_turn`/`stop_sequence`，OpenAI 和 Mistral `stop`，Gemini `STOP`）。其他值或缺失一律抛 `bad_response`，消息只带原因代号（先用 `^[A-Za-z_]{1,40}$` 过滤），不带回答内容。四家各测三种异常原因和缺失。
4. **读正文出错**：`await response.text()` 和 fetch 放在同一个 try 里，读正文失败也变成 `AiError('network')`，不挂 cause。有测试。
5. **`createFakeAdapter` 不再从 `index.js` 导出**，测试从 `src/ai/fake.js` 导入。`ask()` 默认只认四家；只有显式传入 `adapters` 时才能用 fake。有测试。
6. **Mistral 分块回答**：`content` 可以是分块数组，只取 `type: 'text'` 的块，丢掉思考块（和 Anthropic、Gemini 一致；放在 OpenAI 和 Mistral 共用的 `chat-completions.js` 里）。`maxTokens` 超过 64000 拒绝；请求和选项里出现不认识的字段（如 `maxToken`、`temperature`、`fetch`）抛 `bad_request`，拼错的名字不会默默回退到默认值。都有测试。

`npm test`：105 个全部通过（原有 78 + AI 层 27）。

### 依据哪条原则

- 8 不受制于人：守门测试收紧，业务代码只能经 `ask()`。
- 2 无源不录：被截断或被过滤的回答不能当成一票。
- 5 最简方案：没有新增文件以外的部件。只新增了两个小函数 `snippet`、`requireNormalStop`，都放在已有的 `http.js` 里。

### 异议与风险

- **超时按每次尝试计算。** 开了 JSON 时最多重试一次，所以一次 `ask()` 最长约为 2 × `timeoutMs`（默认 2 × 120 秒）。
- **`env.js` 会把 `.env` 里的所有变量都读进 `process.env`，不只四个密钥。** 目前可以接受：本项目不启动子进程，不会把环境变量传出去。以后如果要启动子进程，需要重新考虑。
- **JSON 模式接受任何合法 JSON 值**（数组、数字、字符串都算）。回答的结构对不对（`verdict` 是否五选一、`evidence` 是否为数组等），必须由评审团流水线检查。
- **结束原因检查很严**：字段缺失也算失败。Anthropic 的回答结构还没有核实；如果真实回答里没有 `stop_reason`，每次调用都会报错。好处是错误一眼就能看出来，不会把截断的回答当成结论。
- **末尾部分遮盖有误伤**：截断处末尾只要有一个字符恰好等于密钥的第一个字符，也会被遮盖。这只影响错误消息里能看到多少内容，不影响安全。
- 这次修改涉及密钥处理，建议复查仍然用 Fable 5.2（额度用完时按规定由 Opus 代审，并写明），范围只限上面六项。

### 没做的和没验证的

- 仍然没有发出任何真实请求。各家结束原因的取值按核实结果和我已知的写法实现。Mistral 分块的格式（`type: 'thinking'` 和 `type: 'text'`）**没有核实**。

---

## 补充：按回头看记录收口（2026-11-22，开发，Opus 5.5）

依据 `docs/log/2026-11-22-step-back-ai-guard.md`，创始人已确认。

### 做了什么

- `src/ai/index.js` 只导出 `ask`、`AiError` 和 `PROVIDERS`。`PROVIDERS` 是冻结的列表，每项只有 `{ name, keyVar }` 两个字符串，也冻结。适配器登记表 `ADAPTERS` 改为文件内私有。另外，`loadEnv`、`parseJsonText` 和几个默认值常量也不再从入口导出。
- 测试改为遍历 `PROVIDERS`，经 `ask()` 加注入的 fetch 和 env 来测。`loadEnv` 从 `src/ai/env.js` 导入（测试可以这样做）。原来直接测 `parseJsonText` 的测试，改为经 `ask()` 加 fake 适配器测同样的行为。
- 新增守门测试：入口的导出名必须正好是 `AiError`、`PROVIDERS`、`ask`；`PROVIDERS` 和其中每项都是冻结的，每项只有两个字符串字段。
- `npm test`：106 个全部通过。

### 异议与风险

- **文字扫描的守门测试有挡不住的写法，这是接受的限制。** 例如用模板字符串做动态导入（`` import(`./ai/${name}.js`) ``），或者写成 `'./ai/./openai.js'` 这类绕弯的路径。真正的防线是入口不导出任何适配器；文字扫描只是第二道。这类写法要靠代码审查退回。
