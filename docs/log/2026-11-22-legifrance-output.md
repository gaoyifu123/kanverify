# 产出：接入 Légifrance 官方法律文本（PISTE API）

- 角色：开发
- 模型和提示词版本：Opus 5.5（建造组，不涉及运行组提示词）
- 日期：2026-11-22

## 做了什么

动工前想清的事（原则 4）：法律文本的官方来源是 DILA 的 Légifrance API；网页版有 Cloudflare 挑战，
现有的 `src/archive.js` 下载不到。所以需要一个专门的取数模块，但存证和登记必须和 `archive.js` 同一套规则，
不另写一份。

- **新增 `src/legifrance.js`**（零依赖，内置 fetch）：
  - PISTE OAuth（client_credentials）取令牌，内存缓存，到期前 60 秒换新；API 回 401 时丢掉缓存的令牌。
  - `searchJorf(query)`：按标题词搜 JORF，返回 cid、标题（去掉 `<mark>` 高亮）、性质、公报日期。
  - `fetchText(cid)`：`POST /consult/jorf {textCid}`，返回解析后的 JSON、原始字节、端点和请求体。
    只收 `JORFTEXT` + 12 位数字，并核对响应里的 `cid` 与请求一致。
  - `archiveLegifranceText(db, cid, {kind, lang})`：kind 只能是 `law` 或 `gazette`；把 API 的解码后响应正文（fetch 解开传输压缩之后交出的内容）存为
    存证文件；`sources` 一行：url 为公开页面 `https://www.legifrance.gouv.fr/jorf/id/<cid>`，标题取响应的 `title`
    （原样，不改写），发布者 `Légifrance (DILA)`，`published_on` 取 `dateParution`（UTC 日期），media_type
    `application/json`。返回值里带 `fetched: {method, endpoint, body}`，命令行把它打印出来。
  - 安全：每个请求 30 秒超时，`redirect: 'error'`（令牌不跟随跳转），响应限 50 MB（声明长度和实际读取都查），
    只收 `application/json`；错误信息里的响应片段会把 client id、secret、access token 全部替换为 `[redacted]`
    （截断处切到一半的也会遮），原始错误不挂在 `cause` 上。**（第一次退回后已改，见下节。）**凭据只从 `.env` 读，不打印、不写盘。
  - 命令行：`node src/legifrance.js search "<标题词>"`、`node src/legifrance.js archive <cid> --kind law`。
- **`src/archive.js`**：把“按哈希原子写入”和“插入 sources 行、失败时清理无主文件”抽成两个导出函数
  `storeEvidenceBytes`、`registerSource`；`archive()` 改用 `registerSource`，行为不变（原有 22 个测试全过）。
- **新增 `test/legifrance.test.js`**，11 个测试，全部注入假的 fetch，不联网：令牌表单与 Bearer 头、令牌缓存与到期换新、
  401 后丢弃令牌、三类错误都不含凭据和令牌、截断处遮蔽、存证文件与解码后的响应正文相同且 sources 行字段正确、
  拒绝非 JSON 和坏 JSON、拒绝超大响应（声明的和流式的）、拒绝错误 cid / kind / 不对应的响应、搜索结果去高亮、缺凭据拒绝建客户端。
- **`npm test`：166 个测试，166 通过**（原 155 + 新 11）。

### 实际运行（真实 API）

1. `search "financement rectificative de la sécurité sociale pour 2023"`：9 条结果，第一条
   `JORFTEXT000047445077 2023-04-15 LOI n° 2023-270 du 14 avril 2023 …`，其余 8 条是它的实施法令。
2. `archive JORFTEXT000047445077 --kind law`：
   - 新 source id：**38**（库里 sources 从 32 行变为 33 行，没有改动或删除其他行）
   - url：`https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000047445077`
   - 字节来源：`POST https://api.piste.gouv.fr/dila/legifrance/lf-engine-app/consult/jorf`，请求体 `{"textCid":"JORFTEXT000047445077"}`
   - sha256：`5e443ce5caf13dcb4e55a01738722264af6636f4c61dc9c9b970577a74f66ff4`（已用 sha256sum 对文件复核）
   - 大小：302 449 字节，`application/json`
   - 标题：`LOI n° 2023-270 du 14 avril 2023 de financement rectificative de la sécurité sociale pour 2023 (1)`；published_on `2023-04-15`（JORF n°0089）

### 怎么核实的字段和地址

- `/consult/jorf` 的请求字段 `textCid`：来自 Légifrance API 的 OpenAPI 描述（GitHub 上 `v3rmine/legifrance-api-swagger`
  的 specs.yaml，是 DILA 测试环境文档的转存，不是 DILA 官方仓库），再用一次小请求对生产环境实测确认。
- 响应字段 `cid`、`title`、`dateParution`（毫秒时间戳）：实测响应里看到的。
- 公开地址 `/jorf/id/<cid>`：legifrance.gouv.fr 对脚本返回 403（Cloudflare 挑战），无法直接验证；
  经 Internet Archive 查到该地址 2025-02-07 的快照状态为 200。`/loda/id/<同一 cid>` 也存在，那是合并后的版本，
  而我们存的是公报原文，所以用 `/jorf/`。

## 第一次退回后的修改（安全审查，2026-11-22）

1. **写盘前先算好并检查 sources 行的每个字段。** 标题：非空、不超过 2000 字、不含控制字符和方向覆盖字符。
   发布日期（`publicationDate`）三重检查：`dateParution` 必须是整数且正好是 UTC 零点；在 1869-01-01（JO 创刊）到今天之间；
   和期号行 `jorfText`（如 “JORF n°0089 du 15 avril 2023”）里的日期一致。任何一项不过就是 `LegifranceError`，不写文件。
   写文件或登记失败也统一包成 `LegifranceError`（code `store`），并删掉刚写的文件（只在没有任何行用这个哈希时）。
   这同时解决了上一版异议 6（时区）：日期不是 UTC 整日就拒收，不再静默取错一天。
2. **`registerSource` 不再相信调用方给的路径。** 现在的参数是 `evidenceDir`，路径由 `evidencePath(evidenceDir, sha256)` 自己拼；
   检查文件存在、是普通文件、重新算哈希一致；自己做 `parseHttpUrl`（只收 http/https、不带用户名密码）和 `MEDIA_TYPE_RE`。
   只在插入失败、且没有其他行用这个哈希时，删除它自己定位并验证过的那个文件；哈希对不上的文件不删。`archive()` 跟着改为传目录。
3. **错误信息里不再放任何响应正文。** 只有“哪个请求 + HTTP 状态码 + 短代码”，如 `Légifrance /consult/jorf: HTTP 500 (http)`。
   `mask` 不再需要，已删除。`LegifranceError` 带 `code`（bad_input、missing_credentials、network、timeout、http、too_large、
   not_json、bad_response、credential_in_response、store）。
4. **响应里出现凭据就拒收。** 每个 API 响应在返回、写盘或打印之前，查原始正文和“解析后再序列化”的文本（后者能抓到 JSON 转义过的
   写法）里是否含 client id、secret 或 access token，有就拒收。命令行打印搜索结果时去掉控制字符和方向覆盖字符，不合格式的 cid
   和日期不原样打印。文档里的说法改为“解码后的响应正文”，不再说“逐字节”。
5. **改存 JO 签名 PDF：做不到，退回给总协调。** 详见下面“异议与风险”第 1 条。没有新增 source，第 38 行保持不变。

新增测试 6 个（`test/legifrance.test.js` 共 15 个，`test/archive.test.js` 加 2 个）：错误信息只有状态码和代码、响应含凭据（含 JSON 转义形式）
即拒收且不留文件、`printable`、日期三重检查（UTC 非整日、与期号不符、缺期号、未来、早于 1869）、坏日期或坏标题不写文件、
插入被拒时是 `LegifranceError` 且不留文件；`registerSource` 拒绝坏 URL / 带用户名的 URL / 坏 media type / 不存在的文件 /
哈希不符（且不删那个文件），插入失败时只在无人使用该哈希时删文件。

**`npm test`：172 个测试，172 通过。**

真实接口复核（不写库）：`search` 正常；对 JORFTEXT000047445077 调 `fetchText` + `publicationDate` 得到 2023-04-15，
与 “JORF n°0089 du 15 avril 2023” 一致。

## 依据哪条原则

- 原则 2（无源不录）：存的是官方机构接口给出的原始字节，按哈希命名；来源行指向同一文本的公开页面。
- 原则 5（最简方案）：复用 `archive.js` 的写入和登记，不另写一套；只做 JORF 一种文本，不做合并版本。
- 原则 8（不受制于人）：零依赖；凭据只在本机 `.env`；数据和存证留在本机。不涉及 AI。
- 原则 6：下面的异议写明了这个方案在原则 2 上的张力。

## 异议与风险

1. **改存 JO 签名 PDF（总协调的决定）目前做不到，需要创始人或总协调另作决定。** 我查了：
   - 生产环境 API 的 OpenAPI 描述（2.4.2，68 个端点，取自 pylegifrance 仓库）没有任何下载文件的端点；
     `jorfFileMetadata` 只给文件名和 `pathToFile`（如 `/JOEA/2023/0415/joe_20230415_0089_0001.pdf.sig`），没有地址。
   - 网站的下载入口是 `https://www.legifrance.gouv.fr/download/url?id=joe_…pdfsig`（Internet Archive 里有记录，部分带 `captcha=` 参数），
     实际下载地址是加密令牌（`/download/file/<令牌>/JOE_TEXTE`）。对脚本一律返回 403（Cloudflare 挑战），还有验证码。
     绕过验证码我不做。
   - DILA 的开放数据站 `echanges.dila.gouv.fr/OPENDATA/JORF/` 只有 XML 打包，没有 PDF。
   - API 自己的使用条款（CGU v1.0，2022-12-15，VI.1）写明：API 数据**不具法律效力**，只有 JO 发布的签名 PDF 才有。
     这支持总协调的方向，也说明第 38 行是“官方数据”而不是“法定原件”。
   可选的路（请总协调或创始人选）：
   (a) 人工一步（原则 7：机器做不了的那一步交给人）：创始人在浏览器里下载签名 PDF，程序登记这个本地文件，url 记公开页面、
       另记 PDF 的下载页。这需要一个“登记本地文件”的小命令，是新功能，要先定；
   (b) 写信给 DILA（retours-legifrance-modernise@dila.gouv.fr）问有没有程序可用的 PDF 下载方式——这是对外联系，要创始人同意；
   (c) 维持 JSON 存证，接受它不具法律效力，并把这一点写进来源规则（属创始人的方法论）。
2. **第 38 行（API JSON）的老问题仍在：** url 是公开网页、存证是 API JSON，哈希永远对不上公开下载的东西；端点和请求体只在命令行输出
   和本文件里，不在库里；每次取到的正文含 `executionTime`，重取哈希会变；评审团（`jury.js`）不读 `application/json`。
   这几条要等第 1 条定下来再处理。第 38 行没有删，等总协调决定。
3. **公开地址规律没有在线直接验证**，只靠 Internet Archive 2025-02-07 的 200 快照。
4. **凭据处理仍需安全审查（第二轮，只看改动）。** 重点：`refuseCredentials` 的检查范围（只查 API 响应，不查令牌接口的响应——
   那份响应本来就含令牌，也从不存盘或打印）；`registerSource` 的新签名和删除条件；`archiveLegifranceText` 的失败清理。
5. **日期检查更严之后可能误拒。** 若 DILA 某些老文本的 `dateParution` 不是 UTC 零点，或 `jorfText` 写法不同（如缩写月份），
   会被拒收而不是存进去。我选择拒收（原则 2：拿不准就不录），被拒时需要人看一眼。
6. 参考的 OpenAPI 文件都不是 DILA 官方仓库（一份是第三方转存的测试环境文档，一份是 pylegifrance 生成模型用的副本）；
   用到的字段已用生产环境实测确认。

## 没做的和没验证的

- 没有完成第 5 项（签名 PDF），见异议 1；没有新增 source。
- 没做合并版本（LEGITEXT、`/loda/`、`/consult/legiPart`）和按 NOR 查（`/consult/getJoWithNor`）。
- 没把端点和请求体写进数据库（见异议 2）。
- 没让评审团能读 JSON 存证（见异议 2）。
- 搜索只按标题、只搜 JORF、只取第一页。
- 没有自审代码；需要代码审查（涉及密钥，属安全类）。
- 没有更新看板，没有部署或对外发布任何东西。

## 第二轮：创始人选 C 之后的两项跟进（2026-11-22）

创始人定：法国法律以 Légifrance 接口 JSON 为凭据（`source-rule.md` 最后一节），第 38 行保留不动。

### 做了什么

1. **评审团能读 Légifrance JSON。**
   - `src/legifrance.js` 新增 `legifranceToUnits(json)`：输出标题、期号行（含日期），然后按原文顺序（每层按 `intOrdre` 排）
     列出每条条文，一段一个单元，标上条号（`art. 10`、`art. liminaire`；没有条号的用所在章节名，如 `Annexe`）。
     去掉 HTML 标签、解开实体，不改写文字。复用 `extract.js` 的 `htmlToParagraphs`。
   - `isLegifranceSource(row)`：`media_type` 为 `application/json` 且 url 以 `https://www.legifrance.gouv.fr/jorf/id/` 开头。
   - `src/jury.js`：`loadEvidenceDoc` 遇到这类来源就转成上述单元（坏 JSON、无正文、超过 20 万字都排除并写明原因）；
     给评审的文本每行以 `[art. 10]` 开头，并加一句“用方括号里的条号作 locator”；逐字核对照旧用 `checkVerbatim`，
     **另加一条程序检查**：摘录所在的条号必须和 `locator` 一致（`art. 10`、`Article 10`、`ART 10` 视为相同），不一致就退回该票。
   - 对第 38 行实测（只读）：可载入，1291 个单元，178 738 字。
2. **来源记录（provenance）。** `node src/legifrance.js archive` 成功后，往 `data/candidates/legifrance-provenance.jsonl` 追加一行
   JSON：source_id、sha256、public_url、method、endpoint、request_body、retrieved_at（取数时刻，ISO UTC）。只追加，不改写；
   `data/candidates/` 已在 `.gitignore` 里，只留本机。
   第 38 行是在这个功能之前存的，我按第一次运行的命令行输出**补记了一行**，`retrieved_at` 为 null、带 `retrieved_on` 和说明“事后补记，
   确切时刻未记录”，没有编造时间。
3. 测试：新增 `test/legifrance-jury.test.js`（5 个，用小样本）：转换的顺序、条号、去标签；`loadEvidenceDoc` 载入 / 非 Légifrance 的 JSON
   仍“不处理” / 坏 JSON 排除；逐字核对 + 条号一致检查；评审输入里是 `[art. 10]` 行和 locator 说明；provenance 逐行追加、旧行保留。
   `test/legifrance.test.js` 的存档测试加了 `fetched.at` 检查。**`npm test`：177 个测试，177 通过。**

### 异议与风险（第二轮）

1. **这一轮改了评审团的输入和检查规则。** 给评审的文本格式（`[art. N]` 行和一句说明）和“条号必须一致”的检查，都属于 `team/README.md`
   里该由 Fable（额度用完时由 Opus 代审）审查的两类：评审团提示词（第 4 类）和判定执行逻辑（第 1 类）。我没改 `team/run/judge-prompt.md`，
   它原本就允许 `art. 3` 这种 locator。
2. **条号检查可能误退。** 摘录跨两条时，以开头所在的条为准；评审若写 `art. 10, I` 或 `article L. 161-17-2`（被修改的法典条文，而不是本法条号），
   会被判为不一致。我选择严格（原则 2），被退回时要人看一眼。
3. **第 38 行接近长度上限。** 178 738 字，上限 20 万；每次评审要送约 18 万字，费用不低。更长的法律会被整份排除，而不是截断。
   以后可能要按条文只送相关部分，这是另一项决定。
4. **`src/legifrance.js` 现在通过 `extract.js` 间接加载了 AI 接口层模块**（只是加载，不调用）。为了复用 `htmlToParagraphs`，没有另写一份。
5. **provenance 文件和数据库不在同一个事务里。** 库里插入成功、追加文件失败时，命令会报错，但那一行已在库里；要按报错手动补记。
6. **网站标注**“Légifrance (base officielle)” / “Légifrance (official database)” 我没做，交给网站生成器的负责人。
7. 仍需安全审查第二轮（上一轮的改动）；这一轮的改动也请一并看。
