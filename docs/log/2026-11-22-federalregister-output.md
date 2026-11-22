# 产出：美国联邦公报（Federal Register）官方接口取证

- 角色：开发（建造组）
- 模型和提示词版本：Opus 5.5；不涉及运行组提示词
- 日期：2026-11-22

## 做了什么

**先查了文档，没有猜字段。** 文档网页（federalregister.gov/developers/…）对程序同样跳转到验证页
`unblock.federalregister.gov`，所以字段和参数取自同一份文档的机器可读版：联邦公报办公室在 GitHub 上公开的
`usnationalarchives/federalregister-api-core` 仓库里的 `data/open_api_v3.yml`，再用真实接口返回逐项核对。
用到的：`GET /api/v1/documents.json`（`conditions[term]`、`conditions[type][]` 取 RULE/PRORULE/NOTICE/PRESDOCU、
`conditions[publication_date][gte]`、`fields[]`、`per_page`、`order`），`GET /api/v1/documents/{document_number}.json`
（`document_number`、`title`、`publication_date`、`executive_order_number`、`citation`、`pdf_url` 等）。接口不需要密钥。

**改动的文件：**

- `src/federalregister.js`（新）：
  - 搜索、按文件号取元数据。接口地址写死；不跟随跳转（`redirect: 'manual'`），超时 30 秒，响应上限 5 MB，只收 `application/json`。
  - 识别验证页：跳到 `unblock.*` 记为 `bot_check`；该是 JSON 却收到 HTML（不论状态码、不论标的类型）也记为 `bot_check`，一律拒收。
  - 存证：只认 `https://www.govinfo.gov/content/pkg/FR-<发布日期>/pdf/<文件号>.pdf` 这一种地址，对不上的报告 `pdf_refused`，不另找地址。
    下载交给 `archive()`，地址检查、大小、超时、哈希规则照旧；另外不允许跳转（`maxRedirects: 0`），并要求是 PDF（见下）。
    登记为 `gazette`，发布者 “Federal Register (Office of the Federal Register, NARA)”，`published_on` = `publication_date`，`lang` = `en`。
    标题写成 “Executive Order 14186: The Iron Dome for America (90 FR 8767)” 这种形式（行政令编号和公报引用号来自接口，格式不对的就不加）。
  - 同一个 PDF 地址已经登记过的，不再下载、不再插入，核对已有文件的哈希后返回已有的来源编号。
  - 每次都向 `data/candidates/federalregister-provenance.jsonl` 追加一行：接口地址、文件号、`pdf_url`、取元数据的时间、取 PDF 的时间（没下载为 null）、`downloaded`、来源编号、哈希、大小。
  - 命令行：`node src/federalregister.js search "<terms>" [--type PRESDOCU|RULE|PRORULE|NOTICE] [--since YYYY-MM-DD]`，`node src/federalregister.js archive <document_number>`。
- `src/archive.js`：`archive()` 加一个可选项 `expectMediaType`。设了以后，服务器给的类型不同就拒收；
  要求 `application/pdf` 时还要求文件以 `%PDF-` 开头。两项检查都在登记之前，拒收时不留文件、不留记录。不设时行为不变。
  为什么要改这里而不是在外面检查：验证页一旦进了 `archive()` 就会被登记，事后再删记录不允许，所以只能在下载过程中拒收。
- `team/run/fetch.md`：升到 0.3，“不能做”里加了验证页的教训。
- 测试：`test/federalregister.test.js`（10 项，全部注入假的 fetch，不联网）、`test/archive.test.js` 加 3 项。
  `npm test`：**208 项全部通过**（原 195 项）。把 `archive.js` 里两项新检查改成不生效后，有 3 项失败，说明测试守得住。

**真实运行（一次搜索、一次存档）：**

- 搜索 “Iron Dome for America”、类型 PRESDOCU、2025-01-01 之后：2 条。第一条是 2025-02182，Executive Order 14186，2025-02-03 发布。
- `archive 2025-02182` 对真实数据库：**已存在，来源 33**，没有下载也没有插入（数据库仍是 33 行，最大编号 38）。
  - 文件号：2025-02182（EO 14186，90 FR 8767，2025-01-27 签署，2025-02-03 刊登）
  - 来源编号：33
  - SHA-256：`20140b2cd9cfcafe685290256527536e5b86cf7d1a95663c3a33e5c416af48b7`
  - 大小：180,467 字节，`application/pdf`，以 `%PDF-1.7` 开头
  - 出处记录已追加一行（`downloaded: false`）。
- 为了确认真实下载这条路走得通，又把同一份文件下载到一个临时数据库和临时目录（不碰真实数据，事后可删）：
  经 `archive()` 的真实网络路径，得到的哈希与来源 33 完全相同。也就是说，govinfo.gov 今天给的文件和之前存的是同一份。

## 依据哪条原则

- 原则 2（无源不录）：原件是 govinfo.gov 上的官方 PDF，按哈希存证；接口只用来找到它，接口地址记在出处文件里。验证页不能当凭据。
- 原则 4（想清再写）：先查官方文档，再写代码；发现来源 33 已有这份文件，就不重复登记。
- 原则 5（最简方案）：不加依赖、不加表；PDF 下载复用 `archive()`，只给它加一个可选项。
- 原则 7（能自动就不手动）：以后找美国行政令和规章，不必再手工找 PDF 地址。
- 原则 8（不受制于人）：公开接口，不需要密钥，也不涉及 AI。

## 异议与风险

- **改了 `src/archive.js`。** 这是处理下载文件的代码，按 `team/README.md` 属于“涉及安全的改动”，应请 Fable 5.2 审查（额度用完时按创始人的规定用 Opus 代审并写明）。
  改动很小：一个可选项，默认不生效。审查范围可以只看 `expectMediaType` 的两处检查和 `head` 的拼接。
- **同一份文件已有的来源用的发布者名称不统一。** 来源 31、33、36、37 是之前手工登记的，发布者分别写成 “Office of the Federal Register / U.S. Government Publishing Office”等四种写法，
  和这次定的 “Federal Register (Office of the Federal Register, NARA)” 不同。我没有改它们（不能改旧记录）。网站上同一类来源会出现不同写法，是否统一、怎么统一，需要创始人定。
- **来源 37 是联邦公报网站上的纯文本（`.txt`），不是 PDF。** 按这次的规则它不会被收录。它不是验证页（类型是 `text/plain`），但它是网站生成的文本，不是官方原件。建议创始人决定是否用 PDF 补一份。
- **“已登记就不重复”是按完全相同的地址判断的。** 同一份 PDF 换了地址（比如带查询参数）仍会被再登记一次；按哈希判断更稳，但那会改变 `archive()` 对其他来源的行为，这次没做。
- **PDF 地址格式写死了。** 1994–2000 年前后的老文件，或者联邦公报以后改了 PDF 存放方式，都会被拒收（`pdf_refused`），需要人看一眼再决定。这是有意的：宁可报告，也不换地址顶替。
- **PDF 开头必须正好是 `%PDF-`。** PDF 标准允许前面有少量别的字节；govinfo 的文件没有，如果遇到会被拒收并报告。
- **出处文件不是存证。** `federalregister-provenance.jsonl` 只追加不改，但它不进数据库、没有哈希保护，和 Légifrance 的出处文件一样。
- 评审程序读 PDF 证据走的是已有的 PDF 路径（`src/jury.js` 直接附 PDF，`src/pack.js` 用转写的逐页文本），这次没有改它们，也没有用这份文件跑评审。

## 没做的和没验证的

- 没有提交（由总协调提交），没有动 `db/schema.sql`、`src/site.js`、`design/`、`board/`。
- 临时数据库和临时下载在本次会话的临时目录里，没有进 `data/`。
- 没有测公报接口在大量请求下会不会限流；文档里没写额度。
- **congress.gov / GovInfo 接入（只列清单，没做）：**
  - 都需要 api.data.gov 的免费密钥（注册要填邮箱，属于“注册”，需要创始人同意）。放进 `.env`，和 PISTE 一样不打印、不记录、响应里出现密钥就拒收。
    本次只用文档公开的 `DEMO_KEY`（限额很低）试了三次请求确认接口形状，没有注册。
  - 已生效法律的正式文本：GovInfo 的 PLAW 集合（Public and Private Laws），`GET https://api.govinfo.gov/packages/PLAW-<届>publ<号>/summary` 给出标题、签署日期、在《美国法律大全》（STATUTE）里的卷页，以及 `pdfLink`、`txtLink`、`uslmLink`（USLM 是官方 XML）。
    原件本身在 `https://www.govinfo.gov/content/pkg/PLAW-<届>publ<号>/pdf/PLAW-<届>publ<号>.pdf`，下载不需要密钥（已试，200，`application/pdf`），可以照这次的做法交给 `archive()`。
    需要定登记类型：`law`。
  - 其他有用的 GovInfo 集合：STATUTE（法律大全，最终引用版本）、USCODE（美国法典）、BILLS（各版本法案文本，`enr` 后缀是通过并送总统签署的版本）、CREC（国会记录，登记为 `parliament`）、FR（联邦公报本身，可与这次的接口互相印证）。
  - congress.gov：`GET https://api.congress.gov/v3/law/<届>/pub/<号>` 由法律号查到对应法案和进程；`/v3/bill/<届>/<类型>/<号>/text` 列出各版本文本的 PDF/XML 地址（在 www.congress.gov 上）；`/actions` 给出签署、生效等进程。
    congress.gov 的数据更适合“找到是哪部法律、走到哪一步”，原件建议统一从 govinfo.gov 取。
  - 风险：www.congress.gov 网站本身有反爬措施；这次对一份法案 PDF 的 HEAD 请求返回了 200 和 `application/pdf`，但没有完整下载过，不能保证稳定。
