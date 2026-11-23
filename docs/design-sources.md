# 设计源怎么接（通用）

本插件只读**本地文件**：设计图 PNG、ui-spec JSON、项目档案 JSON。它**不连接任何 MCP**、
不读凭据、不访问外部服务。所以「设计源」在这里的定义很窄：

> 设计源 = 验收时能被 `ui_diff` 或 `ui_probe` 直接读到的本地文件。

> 具体到 Paper：MCP 挂载与只读工具见 [paper-mcp.md](paper-mcp.md)，直读步骤见
> `skills/ui-restore/SKILL.md` 第 3A 节；本文只讲「拿到本地文件后怎么接」。

下面三种形态 + 一种缺失态，按你能拿到的素材选。选完只需要在项目档案里写 `designSource.kind`。

## 1. 四种形态对照

| 形态 | `designSource.kind` | 主判据 | 适合什么 |
| --- | --- | --- | --- |
| 结构化设计值（ui-spec） | `mcp` | `ui_probe` 契约模式 | 设计工具能导出元素级样式（如 Paper 直读）；关注颜色/字号/间距/圆角等硬指标 |
| 设计图 | `image` | `ui_diff` 像素比对 | 只有画板导出图；关注整体版式与留白 |
| 手写 ui-spec | `mcp`（或 `none` + 手写契约） | `ui_probe` 契约模式 | 没有设计工具，但有设计规范/同类页面可抄 |
| 无设计源 | `none` | 规则 + 审计探针 + 基准页 | 改老页面、补状态、内部工具页 |

两种主判据可以叠加：既有设计图又有 ui-spec 时，先探针后像素，能显著减少误报。

## 2. 结构化：任意设计工具 MCP → ui-spec.json

### 2.1 契约

ui-spec 是一个普通 JSON 文件，结构见插件自带的 `schemas/ui-spec.schema.json`：

```json
{
  "version": 1,
  "name": "<页面名> 基线",
  "viewport": { "width": 1440, "height": 900, "dpr": 1 },
  "elements": [
    {
      "selector": ".toolbar .primary-action",
      "label": "主操作",
      "properties": {
        "backgroundColor": "#2563eb",
        "fontSize": "14px",
        "paddingLeft": 16,
        "fontWeight": 600
      }
    }
  ]
}
```

- `selector` 是**实现侧的 CSS 选择器**，由画师声明与维护（见 SKILL 第 7 节）。
- `properties` 用 `getComputedStyle` 的驼峰属性名；完整白名单在 schema 里，非法字段会直接报错。
- 只要某个 MCP 能把「元素 → 期望样式」导出成这个结构，它就是合格的设计源。
  插件不关心你用的是哪个 MCP、哪个设计工具。

### 2.2 连接与凭据由使用者自理

- 插件**不配置、不调用、不探测**任何 MCP 服务器；连接方式、账号、token 都在你自己的
  Harness 配置或设计工具侧维护。
- **不要把 token、内网地址、账号写进项目档案或 ui-spec**。档案里的 `mcpServer` /
  `artboard` 只是给人看的**文字引用**，插件从不解析。
- 导出物是「一次性快照」：设计稿改了就重新导出，不要指望插件去追设计工具的实时状态。

### 2.3 一个可复制的落地方式

1. 用设计工具 MCP 导出目标画板的节点树（节点名、类型、尺寸、填充、字体、圆角、间距）。
2. 写一层**只做映射**的小脚本/小工具（可以放在项目自己的 `scripts/` 里）：
   节点名 → 页面里的稳定 selector；设计字段 → `getComputedStyle` 属性名。
3. 产出 ui-spec 文件，提交到版本库；验收时把路径传给 `ui_probe` 的 `expected`。
4. 设计更新时重跑映射，diff 出 ui-spec 的变化，再决定是否要改实现。

> **Paper 只是一个例子**：任何能导出结构化设计值的 MCP 都适用；没有 MCP 就跳到第 4 节。
> 本文不绑定任何具体设计产品，也不要求你必须装 MCP。

### 2.4 设计值 ≠ 浏览器计算值

MCP 给的是设计稿上的值，浏览器会再加工一次，映射时注意：

- 字体：设计字体未在验收机器安装时会回退，字号/字重/行高都可能变。
- 行高：设计稿里的行高可能是倍数或像素值，`getComputedStyle` 一律给像素。
- 颜色：设计工具可能输出带透明度的十六进制或 `oklch`；ui-spec 支持 `#hex` / `rgb()` /
  `rgba()` / `hsl()`，其它表示法请先转换。
- 间距：设计稿常按 4/8 栅格标注外边距；页面里可能是 flex/grid 的 `gap`，
  映射到 `padding`/`margin`/`gap` 之前先确认布局方式。
- 1px 边框：DPR 2 下可能渲染成 0.5px 或 2 物理像素，长度容差默认已吸收。

## 3. 图像：设计图 PNG

没有结构化能力时，设计图仍然能撑起整页级的验收。

导出规范：

- **白底**、无透明通道（透明底会合成到白底，半透明阴影会失真）。
- **单画板一张图**，不要拼多屏或带标注、参考线、切图标注。
- 与档案 `devices[0]` **同比例**（同宽高比；像素尺寸不一致没关系，`ui_diff` 会等比缩放并标
  `sizeMismatch`）。
- **状态分开**：hover / disabled / loading / 空态 / 错误态各导一张，不要指望一张图覆盖。
- 字体尽量嵌入或转曲，避免验收机器回退字体。

放置：放到版本库能引用的目录（例如 `design/<页面>/<状态>.png`），在交接消息里给路径。

## 4. 手写 ui-spec

没有设计工具、也没有设计图，但有设计规范或同类页面时，手写一份**关键锚点**契约：

- 只写 8~15 条：主操作按钮、页面标题、卡片容器、表头、状态标签、弹窗、空态、分页。
- 值从项目 token 文件、规范文档、或已上线的同类页面里抄，**不要凭感觉写**。
- `selector` 用稳定语义类/`data-*` 属性，别用 `div > div:nth-child(3)` 这类易碎选择器。
- 写完先跑一遍 `ui_probe`：如果实际页面大面积不匹配，先确认是页面错了还是契约写错了。

## 5. 无设计源

`designSource.kind = "none"`。此时验收靠三层：

1. 项目自己的机械校验（档案 `rules`）；
2. 同类型基准页（`baseline.pages`）截图后自比；
3. 规范契约（第 4 节的手写 ui-spec）与审计探针。

报告里必须写「本次模式：无素材」「设计源：无」，不能声称与设计稿一致。

## 6. 档案里的写法

```json
{ "designSource": { "kind": "image", "artboard": "订单列表 / 桌面档", "path": "design/orders/list.png" } }
{ "designSource": { "kind": "mcp", "mcpServer": "设计工具名字（文字引用）", "artboard": "订单列表" } }
{ "designSource": { "kind": "none" } }
```

- `kind` 只允许 `none` / `image` / `mcp`，写错会直接报错。
- `mcpServer` / `artboard` / `path` / `note` 都是可选文字引用，插件不解析、不连接。
- 内置示例：`profiles/example-static.json`（图像模式，可直接复制）、
  `profiles/minimal.json`（只填 `id`，用来看默认值）。`profiles/` 下另有两份真实项目
  示例档案（文件名即档案 id），含项目路径与命令，仅作取值参考，按需改名后使用。
