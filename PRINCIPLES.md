# KANVERIFY principles

This is the only copy. Every decision, every piece of work and all collaboration follow these eight.
Only the founder may change this file. When a decision conflicts with a principle, the decision changes, not the principle.

1. **A good question matters as much as a conclusion.** If we cannot give the truth, we give a good question.
2. **No source, no record.** Without a source we neither record nor conclude.
3. **One ruler.** The same rules for everyone; report outcomes, never guess motives.
4. **Think, then code.** Write less code; when stuck, step back instead of forcing it.
5. **Keep it simple.** Look for the simplest solution and dare to cut.
6. **Have backbone.** Speak up, own your role, don't flatter.
7. **Automate what can be automated.** People only do the step machines cannot.
8. **Stay independent.** No lock-in to an AI vendor, data stays local, self-funded.

## 中文原文（创始人 2026-11-23 批准英文版，两者同义）

这是唯一的一份。所有决定、开发和协作都围绕这八条。
只有创始人可以修改本文件。某个决定和原则冲突时，改决定，不改原则。

1. **问题和结论一样重要。** 给不出真相，也要给出一个好问题。
2. **无源不录。** 没有来源，不收录，不下结论。
3. **一把尺子。** 对所有人用同一套规则；只说结果，不猜动机。
4. **想清再写。** Think, then code. 少写代码；卡住了先回头看，不硬改。
5. **寻找最简单的技术方案，敢于取舍。** Keep it simple.
6. **有话直说。** Have backbone. 敢提意见，守住职责，不迎合。
7. **能自动就不手动。** 人只做机器做不了的那一步。
8. **不受制于人。** 不绑定 AI 供应商，数据在本地，资金自筹。

## 每条原则落在哪里

| 原则 | 落地方式 | 现状 |
| --- | --- | --- |
| 1 问题和结论一样重要 | 结论为“无法判定”的条目必须写明卡在哪里、还缺什么，否则数据库拒绝保存 | 已做（`db/schema.sql`，有测试） |
| 2 无源不录 | 没有来源的条目存不进数据库；没有原始凭据的结论无法发布 | 前半已做；后半被独立审查找到绕过的办法，重做方案见 `docs/log/2026-11-22-step-back-database-rules.md`，等创始人确认 |
| 3 一把尺子 | 中立性审查每条必查；每周统计各国结论分布 | 审查角色已定义，统计未做 |
| 4 想清再写 | 熔断规则：同一问题改两次未解决就停手，先写回头看记录 | 规则和模板已写，靠执行 |
| 5 最简方案，敢于取舍 | 新增部件或依赖前，任务单里写一句为什么现有的不够 | 模板已写，靠审查 |
| 6 有话直说 | 每份产出固定有“异议与风险”一栏，不能空着 | 模板已写，靠执行 |
| 7 能自动就不手动 | 审核台记录每条人工用时，每周出报表 | 未做（审核台未建） |
| 8 不受制于人 | 业务代码只能经 AI 接口层调用模型；数据库只在本机 | 数据库已在本机；接口层未建 |
