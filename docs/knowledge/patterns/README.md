# 跨项目模式（patterns）

这里放**与项目无关、可复用**的配方与模板；具体项目的取值放 `projects/<slug>/README.md`。

| 文件 | 用途 |
| --- | --- |
| [prompts.json](prompts.json) | 分类图标的 20 条提示词配方：`template` + 每品类的 `products` / `bg` |
| [style-tokens.json](style-tokens.json) | 参考图采样色板 + 生产规格（卡片/圆角/标签/版式/禁用项） |
| [icon-tile.html](icon-tile.html) | Paper `write_html` 图块模板（图 + 标签） |

## 使用方式

1. 复制 `prompts.json` 的 `template`，把 `{products}` / `{bg}` 换成新项目的内容；
2. 从 `style-tokens.json` 取卡片尺寸、圆角、标签、版式；新项目可整体缩放，但保持比例；
3. 用 `icon-tile.html` 生成图块，`{{GEN_URL}}` 替换为 `paper-gen://...`；
4. 生成后按「结构 + 风格」两层验收（清单见各项目案例 §5）。

## 提示词模板（要点）

```text
Realistic 3D e-commerce category icon, square composition: {products}
standing directly on a flat {bg} pastel background.
The pastel color fills the entire square edge-to-edge.
No pedestal, no platform, no studio floor, no backdrop, no table.
Products fill most of the frame, soft contact shadows, soft studio lighting,
no text, no logo, clean minimal, high detail
```

- 单次工具调用 ≤10 张图；按 5 列一行分批；
- 生成是异步的，用 `get_node_info` 轮询 `imageGeneration.status`；
- 不合格的单张重生成，不整页重来。
