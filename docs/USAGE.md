# 使用 dsh-ui-restore

目标：把「前端 UI 还原」跑成一个可复现的闭环——画师按设计源实现，验收者用截图、像素差异、
样式探针量化判定，最后产出一份能交给人的报告。

## 1. 快速开始

1. 按 `docs/INSTALL.md` 安装，重开会话；
2. 新会话的预设选 **「UI 还原-队长」**（`ui-restore`）；没有预设列表时用默认预设，直接按
   `skills/ui-restore/SKILL.md` 开工；
3. 在项目里建一份档案：`<工作区>/ui-restore-profiles/<id>.json`（示例见第 2 节）；
4. 告诉队长：要还原的页面/路由、项目档案 id、允许改动的目录。剩下按闭环推进。

最小验证（不需要浏览器）：

```bash
node scripts/selftest.mjs
```

## 2. 项目档案怎么写

档案是零依赖 JSON，只描述验收夹具；插件只读它，**不执行** rules 命令，也不连接任何服务。
完整字段见 `profiles/_schema.md`，下面是一份可直接改的完整示例：

```json
{
  "id": "orders-list",
  "label": "订单列表页",
  "baseUrl": "http://localhost:5173",
  "devices": [
    { "id": "desktop", "width": 1440, "height": 900, "dpr": 1 },
    { "id": "mobile", "width": 375, "height": 812, "dpr": 2 }
  ],
  "thresholds": { "score": 0.97, "maxRounds": 3 },
  "rules": [
    { "cwd": ".", "command": "npm run validate", "required": true },
    { "cwd": ".", "command": "npm run lint:styles", "required": false }
  ],
  "tokens": { "files": ["src/styles/tokens.css"], "prefix": "--" },
  "baseline": { "pages": ["src/views/orders/index.vue"] },
  "designSource": {
    "kind": "mcp",
    "mcpServer": "paper",
    "artboard": "订单列表 / 桌面档",
    "note": "从 Paper 直读生成 ui-spec；截图只做渲染兜底"
  },
  "knownIssues": ["窄屏下分页器换行（产品已确认，不记缺陷）"],
  "notes": "dev server：npm run dev；页面地址：/orders"
}
```

要点：

- `devices[0]` 是截图/探针的缺省视口；移动端页面把手机档放第一位。
- `thresholds.score` 是还原度合格线；`ui_diff` 的默认允许差异率 = `1 - score`。
- `rules[].required = true` 的命令由画师/验收者在各自会话里跑；规则不过不进截图环节。
- `designSource.kind` 只能是 `none` / `image` / `mcp`；非法值直接报错。
- 未知字段只告警、不报错，方便先跑通再补。

## 3. 四种设计源

### 3.1 Paper 直读（主路径，不需要截图）

会话里能调用 Paper MCP 的只读工具时优先用它：

1. 按 `docs/paper-mcp.md` 挂好 Paper MCP；
2. `get_basic_info` 选 artboard（记 id/width/height）→ `get_children` 从 artboard 逐层 BFS
   采集节点（默认 `--max-depth 3`、`--max-nodes 200`）→ `get_computed_styles` 分批
   （每批 ≤ 50 个 nodeIds）取样式。`get_tree_summary` 只返回文本概览，**不用于取节点**；
3. 生成 `ui-spec.json`（可手工，或跑
   `node scripts/paper-to-ui-spec.mjs --file <fileId> --artboard <nodeId> --out ui-spec.json --max-depth 3 --url "$PAPER_MCP_URL"`）；
4. 验收用 `ui_probe({ profile, expected: "ui-spec.json", url, run })`。

注意：`get_tokens` 可能返回空数组（设计稿没用 token），不要假设有 token；除 `get_basic_info` 外，
其余 `get_*` 必须显式传 `fileId`（`get_basic_info` 可以空参调用）；写类工具在验收流程里禁用。详细步骤见
`skills/ui-restore/SKILL.md` 第 3A 节。

### 3.2 设计图

档案写 `designSource.kind = "image"`、`designSource.path = "design/orders.png"`。
验收用 `ui_diff({ design, shot, profile, run })` 做像素比对；`ui_probe` 审计模式补规范问题。
截图与设计图比例不一致时 `ui_diff` 会等比缩放，并在结果里标 `sizeMismatch`。

### 3.3 线上 URL（把线上/参考页当基准）

没有设计图、但有可访问的线上页面或已验收的参考页时：

1. 用 `ui_capture` 截线上页/参考页，产物作为基准图；
2. 再截本地实现，`ui_diff` 对比基准图与实现图；
3. 档案用 `designSource.kind = "none"`，把参考 URL 写进 `baseline.pages`，并在报告里注明
   「本次以线上页为基准」。

注意：基准页与实现页要用**同一设备档、同一数据量、同一交互状态**（三同），否则差异里会混入
数据与状态噪声。

### 3.4 无素材

只有项目规范和现有页面时走无素材模式：

1. 规则门禁：跑档案 `rules` 里 `required` 的命令；
2. 基准页：挑「三同」基准页截一张，作为参照；
3. 审计探针：`ui_probe` 审计模式检查溢出、硬编码色、字号/间距分布、缺 alt、焦点、空态；
4. 规范契约：把设计规范写成 ui-spec（字号、主色、控件高度、圆角等），走契约模式。

## 4. 一轮闭环的动作序列

| 步骤 | 谁 | 动作 | 产物 |
| --- | --- | --- | --- |
| 0 | 画师 | 跑档案 `rules` 的 `required` 命令 | 命令输出 / 退出码 |
| 1 | 画师 | `ui_capture` 截当前实现 | `<run>/shot.png` |
| 2 | 验收者 | `ui_probe`：有 ui-spec 走契约，否则审计 | `<run>/probe.json` |
| 3 | 验收者 | 有设计源时 `ui_diff`（Paper 直读可省略） | `<run>/diff.json` + 热力图 |
| 4 | 验收者 | 按门槛判定：`pass` / `needs_revision` / `blocked` | findings |
| 5 | 画师 | 只修 inScope，不改期望值/阈值 | 新截图 |
| 6 | 验收者 | `ui_report` 生成报告 | `<run>/report.md` + `report.html` |

同一页面的所有轮次复用**同一个 run 目录**，分数历史会自动累积。

## 5. 阈值与轮次

- `score`：还原度（1 - 差异率）合格线，默认 0.95；`ui_diff` 的 `threshold = 1 - score`。
- `maxRounds`：允许的最大轮次，默认 3；由队长执行，插件只透出。
- 判定硬门槛：合格线达标 + 探针 high 归零 + selector miss 已补齐/说明 + 高严重度差异区域逐项对照。
- 收敛即停；连续两轮提升很小或超过 `maxRounds` 视为停滞，剩余差异分「必改 / 可接受 / 需产品确认」
  交人决策。

## 6. 怎么读 report.html

`report.html` 是单文件、无 JavaScript、无外链，可直接双击打开：

| 区块 | 看什么 |
| --- | --- |
| 概览卡片 | 还原度、合格线、模式、轮次、问题计数 |
| 分数曲线 | 每轮 score 的变化，是否在收敛 |
| 三图对照 | 设计图 / 截图 / 差异热力图（无设计源时显示占位说明） |
| 差异区域 | 按 severity → 面积排序的连通域，含坐标、尺寸、像素占比 |
| 属性差异 | 契约模式的逐属性 `expected / actual / delta / severity` 表 |
| 探测发现 | 审计问题与字号/间距/颜色分布 |
| 修复清单 | 按优先级收敛到关键项 |
| 夹具声明 | 本次视口 / 档案设备档 / 差异画布、设计源、已知问题 |

审计运行没有 expected 时，报告会显式写「本次未做设计比对（审计运行）」，不要把它当成比过设计稿。

## 7. 常见问题

| 问题 | 处理 |
| --- | --- |
| 截图尺寸和设计图不一样 | 正常；`ui_diff` 等比缩放并标 `sizeMismatch`。仍建议同设备档截图 |
| 差异区域很碎 | 页面有整体位移（padding 改动等）时会出现多条细区域；按面积与 severity 排序看 |
| `selectorMisses` 不为 0 | 让画师更新 selector 或给映射说明，不要留给验收者猜 |
| 有 Paper 但不知道选哪个 artboard | `get_basic_info` 列出 `artboards`；按名称/宽高选，记录 id |
| Paper 的 `get_tokens` 返回 `[]` | 正常；只写节点级样式，不要因此改走截图 |
| 浏览器起不来（`spawn EPERM`） | 受限沙箱禁止起子进程；换非受限会话，或只跑核心集自测 |
| 报告图片打不开 | 报告与三张图必须在同一目录；`ui_report` 默认会把外部图片复制进报告目录 |

更多：安装与排错见 `docs/INSTALL.md`；设计源细节见 `docs/paper-mcp.md`、`docs/design-sources.md`。
