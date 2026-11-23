# 判定标准

版本 0.4（2026-11-23）。0.4：期限时的状态、放弃只结束等待、提前成真只限一次性结果、含糊承诺放弃后仍无法验证（决策 0013）。0.3：结论为六种，可提前判成真（决策 0008 修订）。仍是草稿：还没有用真实条目检验过。
计划在第 8 至 10 天用第一个国家的全部条目检验，并和现有追踪器对照后升为 1.0。

## 1. 什么会被收录

收录的是**承诺**：对一项可验证的行动或结果的前瞻性陈述。

- 收录：“在任期内把法定退休年龄提高到 65 岁。”
- 不收录：口号和价值表态（“让国家更公平”）、对现状的描述、对别人的批评。

第一层的收录规则是机械的：一份纲领里所有符合上述定义的陈述都收录，不挑选。
是否重要、是否好核对，都不是略过的理由。

## 2. 可验证性分三类

| 类别 | 含义 | 怎么处理 |
| --- | --- | --- |
| `measurable` | 有可测量的结果，并且有期限 | 写定判定标准，到期判定 |
| `vague` | 方向明确，但没有可测量的结果 | 收录，结论为“无法验证” |
| `hedged` | 带“争取”“力求”这类保留措辞 | 收录，结论为“无法验证” |

`vague` 和 `hedged` 不计入对错，只计入一个人的言论里有多少是可验证的。

## 3. 期限

- 原文写了期限的，用原文的（`stated`）。
- 竞选纲领里没写期限的，推定为所竞选的那一届任期结束之日（`inferred`），并在页面上标明是推定的。
- 推定的期限不能用来提前判“未成真”。任期未满时，除非当事人已明确放弃，结论是“待定”。
- **Which moment counts (decision 0013):** the verdict judges the state at the deadline. What happened after it goes in the summary and does not change the verdict.
- **A renunciation ends the wait (decision 0013):** after a public, explicit renunciation of a promise, the claim is judged as if the deadline had passed on the renunciation's date, on what was actually done: a partial result shown by evidence is “partly came true”; no result is “did not come true” (the renunciation is enough evidence for that); criteria fully met is “came true”.

- 写法的统一读法（创始人 2026-11-22 定）：“d’ici 2027 / 2027 年前”按 2027-12-31 算，照字面；“fin de la décennie / 本十年末”按 2030-12-31 算。

## 4. 判定标准在录入时写定

每条 `measurable` 的承诺在录入时就写明：什么结果算成真，用哪一类凭据核对。
结果出来之后不改标准。确实写错了需要改的，改动留痕并公开。

## 5. 六种结论（决策 0008 及其修订）

承诺和预测共用同一套结论。

| 值 | 中文 | Français | English | 什么时候用 |
| --- | --- | --- | --- | --- |
| `unverifiable` | 无法验证 | Invérifiable | Unverifiable | 话说得含糊或留了太多退路，怎样都算对；或所附的条件没有出现 |
| `pending` | 待定 | En attente | Pending | 还没到期 |
| `to_evaluate` | 待评估 | À évaluer | To be assessed | 已到期，凭据还不够判断 |
| `came_true` | 成真 | Réalisée | Came true | 完全达到录入时写定的判定标准（可以在期限前） |
| `partly_came_true` | 部分成真 | Partiellement réalisée | Partly came true | 做到了一部分；可量化的要在说明里写明数据（到期后才判） |
| `not_came_true` | 未成真 | Non réalisée | Did not come true | 到期，没做到；或期限前本人已明确放弃 |

- 可验证性为 `vague` 或 `hedged` 的，结论自动是“无法验证”。
- 评判结果，不评判努力。提交了法案但没有通过，不算成真。
- 部分做到的判“部分成真”；可量化的条目，说明里必须写明数据。
- 一句话打包了几项措施的，全部做到才算成真，做到一部分算部分成真（创始人 2026-11-22 定）。
- **Early “came true” only for one-off results (decision 0013):** a law passed, a facility built. If the criteria name a level at a date, or the measure can be repealed or undone, wait for the deadline.
- A vague or hedged promise stays “unverifiable” even after an explicit renunciation; the summary mentions the renunciation (decision 0013).
- 期限前只能提前判“成真”（已完全达到判定标准）；“部分成真”要等到期再判，因为部分做到的状态还会变，期限前判“待定”，说明里写明目前做到了多少；“未成真”要等到期，或本人公开明确放弃（创始人 2026-11-22 定；放弃后按实际做到的判，见第 3 节）。
- “待评估”不是失败。它必须写明卡在哪里，还缺什么资料（原则 1）。
- 除“待定”外，每种结论都必须附一句说明，法语和英语各一句，否则不能发布。说明讲的是凭据显示了什么，不是评价。
- “无法验证”和“待评估”不是负面评价。

## 6. 措辞

发布的文字只描述结果，不评价动机，不用带情绪的词。
不写“撒谎”“欺骗”“背弃”，写“期限已过，官方公报中没有相应的法律”。
对成真和未成真用同样平实的语气。

## 7. 谁来判

1. 评审团：至少两个不同的模型各自独立初判，互相看不到对方的结论。
2. 中立性审查：检查选材、措辞和证据。
3. 创始人逐条确认后发布。

目标是自动审核：四家模型组成评审团，全体一致的自动通过，不一致的交给人审。
放开的条件是创始人定的：先 10 条，再 30 条，最后 100 条，评审团一致的结论和人的确认对得上的比例达到 99%。
详见 `docs/decisions/0003-ai-jury.md`。

## 8. 更正

任何人可以提出更正。被记录的人的答辩怎么刊登，等有了实际使用场景再定（决策 0007），在那之前不对外承诺时限。
已发布的结论有改动的，改动前后的结论和时间公开留痕。

## 还没定的

- 预测类条目（区别于承诺）怎么判：基准线和最小样本数都没有定。第一层不涉及。
- “部分做到”算到什么程度才写成“成真”，说明怎么写，需要用真实条目来校准。
- 一个人的条目满多少条才显示比例。在定下来之前，人物页只显示各结论的条数。
