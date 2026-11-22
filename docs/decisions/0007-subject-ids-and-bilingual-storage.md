# 0007 人物编号和双语存储

- 日期：2026-11-22
- 状态：已定（创始人 2026-11-22 08:31 在看板事项 `design-brief` 里回复）
- 谁定的：设计 agent 提出问题，创始人决定，总协调整理成记录格式 5 的要求

## 背景

设计 agent 在 `design/ia.md` 的“异议与风险”里提出，记录格式缺几样网站需要的东西。最重要的三个，创始人的回复原文：

> 人物内部有编号，可以参考维基百科的做法。
> 2英语法语是我们的存储语言，如果不是，翻译之后再加入
> 3目前还没有使用场景，到时候再加

## 决定

1. **人物用内部编号识别，不用名字。** 现有的 `subjects.id` 就是这个编号，只增不改、不复用。
   发布快照里带上它，网址用编号（名字只作为可读的后缀，改名不影响网址）。
   参考维基百科的做法：另存一个可选的 Wikidata 编号（形如 `Q123`），用来区分同名的人、和外部资料对上。
   不要求填，填了就不能和别人重复。
2. **法语和英语是存储语言。** 我们自己写的每一段文字（结论摘要、还缺什么、判定标准、发言身份）
   都要有法语和英语两个版本；承诺原话和证据原文保留原语言，另存法语和英语译文。
   政策领域改成固定清单，用英文代号存储，网站上显示两种语言的名称。
   缺任何一种语言的条目不能确认发布。其他语言的材料翻译后再录入，原文保留。
3. **当事人答辩：现在不做。** 有了实际使用场景再加。判定标准里“3 天内刊登答辩”的承诺暂时不对外宣布，
   以免说了做不到。

## 为什么现有的不够（原则 5）

- 编号：`subjects.id` 已经有，只是没进快照。这一项几乎不加东西；Wikidata 编号是唯一新增的一列。
- 双语：网站分法语和英语两个站点，单语字段在另一个站点上就是空白。没有更简单的办法。

## 异议与风险

- 双语字段让每条记录的必填项变多，翻译工作量翻倍。翻译由运行组的翻译角色自动做，人只抽查（原则 7）。
- 政策领域固定清单会限制以后的分类。清单可以加项，但已发布的条目改领域要重新确认。
- 改记录格式属于“什么能公开”的改动，按 `team/README.md` 要请 Fable 5.2 做一次只查改动的审查。
  这次和 `db-scope` 定下边界后的收尾检查合在一起做，省一轮。

## 依据哪条原则

- 原则 2（无源不录）：原文保留原语言，译文另存，不替换。
- 原则 3（一把尺子）：两个站点给出同样完整的信息。
- 原则 5（最简方案）：用已有的编号；答辩等到需要时再做。

## Addendum 2026-11-22 (founder): full language switch on the site

The site has a language switch; whichever language the reader picks (English or French), **everything** is shown in that language.
For quotes and evidence excerpts whose original is in the other language: the translation is shown as the main text,
and the original wording sits directly under it, labelled "Original (French)" / "Original (anglais)" — the original is never hidden (principle 2).
The review desk is different: the founder reads English and French, so originals in either language are shown without translation.
