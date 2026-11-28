# 知识库索引

> 本文件由 `scripts/knowledge-index.mjs` 生成，请勿手工编辑。
> 重新生成：`node scripts/knowledge-index.mjs`；一致性校验：`node scripts/knowledge-index.mjs --check`。

共 **1** 个项目 · **3** 个案例（passed 1 / failed 2 / superseded 0）· **3** 个 patterns 资产。

## 项目案例

| 项目 | 案例 | 状态 | 日期 | 链接 |
| --- | --- | --- | --- | --- |
| [直通车官网（zhitongche）](projects/zhitongche/README.md) | 失败案例 v0：手绘 SVG 图标（误解风格） | ❌ failed | 2026-11-26 | [2026-11-26-icons-v0-svg-failed.md](projects/zhitongche/cases/2026-11-26-icons-v0-svg-failed.md) |
| [直通车官网（zhitongche）](projects/zhitongche/README.md) | 失败案例 v1：首次图像生成（有底座、灰棚底） | ❌ failed | 2026-11-26 | [2026-11-26-icons-v1-gen-failed.md](projects/zhitongche/cases/2026-11-26-icons-v1-gen-failed.md) |
| [直通车官网（zhitongche）](projects/zhitongche/README.md) | 案例：一级分类图标（参考风格复刻） | ✅ passed | 2026-11-26 | [2026-11-26-icons-v2-passed.md](projects/zhitongche/cases/2026-11-26-icons-v2-passed.md) |

## 跨项目复用（patterns/）

说明与使用方式见 [patterns/README.md](patterns/README.md)。

| 文件 | 用途 | 链接 |
| --- | --- | --- |
| icon-tile.html | Paper `write_html` 图块模板（图 + 标签） | [patterns/icon-tile.html](patterns/icon-tile.html) |
| prompts.json | 分类图标的 20 条提示词配方：`template` + 每品类的 `products` / `bg` | [patterns/prompts.json](patterns/prompts.json) |
| style-tokens.json | 参考图采样色板 + 生产规格（卡片/圆角/标签/版式/禁用项） | [patterns/style-tokens.json](patterns/style-tokens.json) |
