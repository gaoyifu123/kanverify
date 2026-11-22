# 产出：抽取步骤（第一批真实数据）

- 角色：开发（建造组）
- 模型和提示词版本：建造组 Opus 5.5；运行组抽取用 `claude-sonnet-5-5`，提示词 `extract-0.1`、`transcribe-0.1`
- 日期：2026-11-22

## 做了什么

动手前的想法：PDF 没有解析器，就把 PDF 原样交给模型读（AI 接口层加一个可选的 `document` 输入）。逐字核对需要一份“原文的文字”，PDF 由另一次独立调用逐页转写，网页由代码直接剥出可见文字。候选条目只写进 `data/candidates/` 下的文件，不写数据库，人看过才可能入库（原则 2）。

**AI 接口层（`src/ai/`）**

- `ask()` 增加可选的 `document: { mediaType, data: Buffer }`。anthropic 发 base64 `document` 块，gemini 发 `inline_data`，两者都放在提示词之前。openai、mistral 以及未声明的媒体类型，在发请求前抛 `AiError`，code 为新增的 `unsupported`。`document` 只能有 `mediaType` 和 `data` 两个字段，多一个也拒绝。原有的保证不变：严格的请求字段、密钥遮盖、stop reason 检查、JSON 重试一次。
- 新增 5 个测试（注入 fetch）：两家的请求形状；openai 和 mistral 被拒且不发请求；格式错误的 document 被拒且错误里没有密钥；带 document 时 stop reason 和 JSON 规则照样生效。

**抽取（`src/extract.js`，CLI：`node src/extract.js <sourceId> --model <id> [--term-end YYYY-MM-DD] [--pages-per-call N] [--transcribe-model <id>]`）**

- `extractCandidates(db, sourceId, { provider, model, promptVersion, termEnd, ... })`：读 `sources`，按 `evidencePath` 读存证文件。
  - PDF：从页树读页数。每次调用都带上整份 PDF，但只处理 N 页（默认 3）。这样单次回答不超过输出上限，也不超过 Node fetch 等响应头的 5 分钟。
  - HTML：代码剥出可见文字，每段编号 §N 放进提示词，不发 document。
- 文字存在 `data/candidates/source-<id>-text.json`，只做一次，之后复用，按 sha256 校验是否是同一个文件。PDF 用 `transcribe-prompt.md` 逐页转写；HTML 用代码剥取，不调用模型。
- 逐字核对：先归一化（NFKC；去掉所有空白、软连字符、零宽字符，去掉所有连字符和破折号，以兼容行尾断词；弯引号和法语书名号统一成直引号；省略号统一），再在全文里查找，可以跨页。大小写、重音、数字和其他标点必须一致。每条候选标出 `verbatim` 和 `verbatim_unit`（在哪一页或哪一段找到），页码和模型给的不一致时记进 `problems`。
- 每条候选按记录格式 7 和 extract.md 检查（领域在固定清单内、ISO 语言码、日期合法、期限和依据成对、measurable 有标准和期限、vague 和 hedged 没有标准、原语言那一栏译文为 null、另一种语言有译文、双语字段成对），违规的写进 `problems`。不删候选，只标记。原文完全相同的标 `duplicate_of`。
- 运行记录写到 `data/candidates/source-<id>-<model>-<时间>.json`，内容包括：提示词版本、模型实际版本、每次调用的 token 数、估算费用（Anthropic 2026-11-22 官网标价，标明是估算）、各项计数和候选条目。函数返回这份记录，`candidates` 就是候选数组（任务单写的是直接返回数组，我改成返回整份记录，因为 CLI 要用到文件路径和计数）。
- 提示词：`team/run/extract-prompt.md`（extract-0.1，规则取自 extract.md 0.2 和 verdict-standard §1–4，要求 JSON）和 `team/run/transcribe-prompt.md`（transcribe-0.1）。运行时把 `PRINCIPLES.md` 拼在前面作为 system；两份文件里给人看的 HTML 注释在发送前去掉。提示词版本号从文件里读，调用方传了不一致的版本号就拒绝。
- `.gitignore` 加了 `data/candidates/`。原来只排除了 `data/*.db` 和 `data/evidence/`，任务单说的“data/ 不进版本库”并不成立。
- 新增 `test/extract.test.js`（11 个）：归一化；跨页和非逐字的查找；HTML 剥取（script、style、head、注释、实体、源码里的换行）；页数；`DOMAINS` 和 schema 里的清单逐项相同；费用估算；提示词有版本、要求 JSON、列全 20 个领域；问题检查；PDF 全流程（只转写一次，第二次复用，按页范围抽取，PRINCIPLES 在 system 开头，文件写出，claims 表仍为 0 行）；HTML 全流程；拒绝错误的版本号和模型名。

`npm test`：139 个全部通过（原有 123 + 新增 16）。

**真实运行（claude-sonnet-5-5，任期结束日：Macron 2027-05-13，Trump 2029-01-20）**

| 来源 | 候选数 | 逐字核对通过 | 有问题 | 估算费用 |
| --- | --- | --- | --- | --- |
| 1 Macron《Avec vous》PDF（13 个 PDF 页，即 24 个印刷页的对开） | 196 | 196 | 0 | 转写 $0.62 + 抽取 $2.30 |
| 2 2024 GOP Platform PDF（16 页） | 264 | 264 | 0 | 转写 $0.62 + 抽取 $2.82 |
| 3 Trump “20 Core Promises” 网页 | 32 | 32 | 0 | 抽取 $0.16 |

- 有记录的费用合计约 **$6.5**。另外第一次跑两个 PDF 时，抽取在某个 3 页的批次撞到 32k 输出上限（stop reason `max_tokens`），整次运行作废。那两次抽取调用的 token 没有记进任何文件，按耗时估计浪费 $1–2。转写已经存盘，后来复用了。改用 `--pages-per-call 1` 重跑后成功（代码没改）。粗算今天的花费约 $8–9，以 Anthropic 账单为准。
- 没有跑 Opus：Sonnet 的质量可以接受（页面全覆盖；没有把“自 2017 年以来已做到”这类回顾当成承诺；拆分和分类大体合理），剩下的问题是规则一致性，换模型解决不了，见下。
- 逐字率 100% 不能当成独立证明（同一个模型既转写又抽取）。所以另做了一次独立抽查（临时脚本，不进代码库）：用内置 zlib 解开 Macron PDF 自带的文字层，196 条里 154 条能直接找到。看过的几条没找到的，原因都是 PDF 把 “fi” 连字编码成了控制字符（`d’in\u001frmiers`），是临时解析器的问题，不是引文的错。GOP PDF 用的是 CID 字体，没有能直接读的文字层，这个办法查不了。

## 依据哪条原则

- 2 无源不录：候选不进数据库；每条带原文、页码或段号、逐字核对结果；对不上的照样保留但标记，由人决定。
- 8 不受制于人：模型只经 `ask()` 调用；PDF 输入同时实现了 anthropic 和 gemini 两家；原则 8 的守门测试照样通过。
- 5 最简方案：没有 PDF 解析器，没有依赖，没有新表。转写文件只做一次，之后复用。
- 7 能自动就不手动：页码不符、格式不合规、重复都由程序标出来，人只看判断题。
- 3 一把尺子：同一份提示词、同一套检查用在三份来源上；但实际结果有不一致，见下。

## 异议与风险

- **任务单和 `team/run/extract.md` 冲突。** extract.md 0.2 写明抽取“不产出 quote_fr、quote_en，那是翻译角色的事”，产出格式里也没有 `type`、`speaker_role_*`。任务单要求这些字段，我按任务单做了，所以现在抽取角色的提示词和角色说明不一致。需要总协调或创始人二选一：改 extract.md，或把译文从抽取里拿掉、交给翻译角色。我倾向后者：做事和检查分开，而且译文由同一个模型顺手写出来，更容易被当成定稿。
- **逐字核对的底子是模型做的转写（已知局限）。** 同一个模型（Sonnet）既转写又引用，它要是把原文“读错”，两边可能错成一样，核对照样通过。交叉核对的办法：(1) 用另一家的模型（如 Gemini，`ask()` 已支持 PDF）再转写一次，逐页比较归一化后的文字，不一致的页标出来，只有两份转写都能找到的引文才算 verbatim；(2) PDF 自带文字层的，用 zlib 解出来再核对一次（今天的抽查表明 Macron 这份可行，但正式做要处理连字和 ToUnicode 映射，相当于写一个小解析器，要先说理由）。建议先做 (1)，成本约每份来源 $0.6。
- **同一把尺子没有完全守住（原则 3）。** 同一条 “Keep men out of women's sports”，网页那次判 `vague`，PDF 那次判 `measurable`。网页和 PDF 第 4–5 页是同一份 20 条清单，大写和小写版本各抽了一遍，按原文去重认不出来。另外，一句话里拆不拆的尺度也不稳定：“Secure our elections, including …”没拆，“Seal the border / stop the migrant invasion”却拆了。这些要靠审核台把同一人的候选并排比，或者在提示词里给更硬的拆分规则；建议用真实条目校准判定标准时一起定。
- **有些候选可疑**，例如 Macron #22 “avec l’organisation en 2024 des Jeux Olympiques et Paralympiques”（更像背景，不像承诺），以及 GOP 平台里大量全大写的章节标题。规则是“不挑选”，所以提示词偏向多抽，人工审核量会比较大（三份一共 492 条）。
- **来源 2 是共和党全国委员会的党纲**，只是发布在 Trump 竞选网站上。来源规则要求“当事人自己发布的材料”。党纲算不算 Trump 本人的话，应当由创始人定，不该在抽取环节默认。
- **网页原文的大小写。** 网页源码里是 “make america affordable again”，显示时由 CSS 转成大写。引文按源码存。剥取时不执行 CSS，被样式隐藏的文字也会保留（这次只多出了导航和捐款弹窗的文字，模型没有从中抽东西）。
- **失败的运行会丢掉已付费的结果。** 任何一次调用失败，整次运行就作废，前面批次的结果不存盘，用量也不记录。今天因此浪费了约 $1–2。改进办法是每个批次一完成就写临时文件，这次没做，等决定要不要做。
- **费用：每次调用都重发整份 PDF**（每次约 4 万输入 token），按页调用时输入费用约占一半。Anthropic 的提示缓存可以把重复部分降到 1/20，但要给适配器加厂商特有的参数，这次没加。
- **归一化去掉了所有空白和连字符**，理论上 “re-form” 和 “reform” 会被当成相同，误判的可能性极小。大小写要求严格一致，所以模型改了大小写的引文会判为不逐字，这是有意的。
- 本次改了 AI 接口层（处理密钥的那条路径），按 `team/README.md` 属于涉及安全的改动，建议审查用 Fable 5.2，额度不够时按当天规定由 Opus 代审。

## 没做的和没验证的

- 没有写 claims 或 verdicts，没有发布任何东西，没有碰 `db/schema.sql`、`design/`、`board/`。
- Gemini 的 PDF 输入只有注入 fetch 的测试，没有真实调用过（没有 Gemini 密钥）。`inline_data` 的写法是按文档写的，没有实测。
- 没有用第二个模型交叉转写，没有跑 Opus 对照。
- 候选的质量只抽查了几十条，没有逐条看。
- 页数是从 PDF 页树读的，没有页树或压缩了对象流的 PDF 会直接报错（今天三份都能读到）。
