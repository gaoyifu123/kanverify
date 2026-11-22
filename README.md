# KANVERIFY

记录公众人物和政府说过的承诺与预测，到期后用可查证的原始凭据核对结果。

- 原则：[PRINCIPLES.md](PRINCIPLES.md)
- 看板：[board/board.html](board/board.html)
- 团队：[team/README.md](team/README.md)
- 判定标准：[docs/methodology/verdict-standard.md](docs/methodology/verdict-standard.md)
- 来源规则：[docs/methodology/source-rule.md](docs/methodology/source-rule.md)
- 记录格式：[db/schema.sql](db/schema.sql)

## 运行

需要 Node.js 24 或更新版本，没有其他依赖。

```
npm test          # 运行测试
npm run db:init   # 在 data/kanverify.db 建立本地数据库
```

## 现状

第 1 天（2026-11-22）：项目骨架、原则、团队分工、记录格式和本地数据库已建。
AI 接口层、获取与抽取流水线、审核台、公开网站都还没有做。进度以看板为准。

## 许可证 / Licence

- 代码：见 [LICENSE](LICENSE)。
- 文档、方法和判定标准（`docs/`、`team/`、`PRINCIPLES.md`、`design/`）：CC BY 4.0，引用请注明出处 KANVERIFY。
- 数据库、存证原件和候选数据不在仓库里，只保存在维护者本机。
- 网站上发布的条目、结论和数据（含 `index.json`）：CC BY-NC-SA 4.0，可引用、转载、研究使用，须注明出处，不得商用，改编须同样许可。
