# 在 DSH 里挂 Paper MCP（只读设计源）

本插件**不连接任何 MCP**：Paper 由 DSH 的 MCP 客户端挂载，agent 在会话里调用只读工具，
把结果转成 ui-spec；插件只读本地文件。本文只写挂载方法，不写死任何地址——端点由使用者按自己的
Paper 安装配置。

> 已实测：Paper desktop 的 MCP server 以 `streamable-http` 暴露，`serverInfo` 形如
> `paper-desktop 0.5.19`；真实调用链是 `initialize` → `notifications/initialized` → `tools/call`。

## 1. 挂载方式

### 方式 A：配置-only bundle（推荐，可复用）

在任意目录建一个只含三件文件的 bundle：

`package.json`

```json
{
  "name": "@local/paper-mcp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "files": ["cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`

```yaml
- insert:
    - id: paper-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: paper
        transport: streamable-http
        url: <PAPER_MCP_URL> # 换成你自己的 Paper MCP 端点；不要提交真实地址/凭据
        failOnStartupError: true
```

安装（二选一）：

- DSH 内：`plugin_manager { action: "install_bundle", target: "<bundle 目录绝对路径>" }`
- 命令行：`dsh plugin --profile <profile> add <bundle 目录绝对路径>`

装好后重开一个会话，工具列表里应出现 `mcp__paper__get_basic_info` 等工具。

### 方式 B：Plugins 设置里直接加 MCP

在 DSH 的 **Plugins** 面板添加一个 MCP server：传输方式选 `streamable-http`，端点填你自己的
Paper MCP 地址，server 名建议用 `paper`（后面的工具前缀就是 `mcp__paper__`）。保存后重开会话。

两种方式都不需要把地址写进本插件；本插件也不会读取它。

## 2. 工具清单（只读）

| 工具 | 必填参数 | 返回 | 用途 |
| --- | --- | --- | --- |
| `get_basic_info` | — | `file` / `pageName` / `pageId` / `rootNodeId` / `nodeCount` / `artboardCount` / `artboards[{ id, name, width, height }]` | 选目标画板 |
| `get_tokens` | `fileId` | token 数组（**可能为空**） | 可选：设计 token；为空不代表失败 |
| `get_tree_summary` | `fileId`, `nodeId` | 文本树概览（`summary` 字符串） | 只用于概览；**不用于取节点** |
| `get_children` | `fileId`, `nodeId` | 子节点 | 建 ui-spec 的节点来源（逐层 BFS） |
| `get_computed_styles` | `fileId`, `nodeIds[]` | 每个节点的计算样式 | 生成 ui-spec 的主数据（每批 ≤ 50 个 nodeIds） |
| `get_jsx` | `fileId`, `nodeId` | JSX 文本 | 只读参考 |
| `get_screenshot` | `fileId`, `nodeId` | 截图/路径 | 只作对照，不作主判据 |
| `export` | `fileId`, 目标格式 | 导出结果 | 只读导出 |

要点：

- **除 `get_basic_info` 外，其余 `get_*` 都必须显式传 `fileId`**。工具描述可能写「可省略」，
  实际 schema 强制；不传会报 `expected string, received undefined`。`get_basic_info` 可以空参调用
  （传非法 `fileId` 反而会报错）。
- `get_tokens` 返回空数组是正常情况（设计稿没用 token）。流程不要依赖 token。
- 第一次用某个工具前先调 `get_guide` 读它的签名和示例；跳过它最容易漏 `fileId` / `nodeIds`。

### 2.1 调用序列（生成 ui-spec）

```text
initialize → get_basic_info → get_tokens → get_children（从 artboard 逐层 BFS，
默认 max-depth 3、max-nodes 200）→ get_computed_styles（每批 ≤ 50 个 nodeIds）→ 写 ui-spec
```

`get_tree_summary` 只用于 `--dry-run` 概览或人工查看：Paper 0.5.19 返回的是**文本树**
（`{"summary": "Frame ..."}`），不能用来取节点；节点层级一律用 `get_children`。

### 2.2 哪些值会被跳过（B8）

Paper 的 computed styles 会出现 `calc(50% + 0px)`、`var(--x)`、`auto`、百分比等
ui-spec 不接受的值。脚本在生成 ui-spec 前按属性类型归一化：

| 属性类型 | 接受 | 跳过（计入 skipped） |
| --- | --- | --- |
| 长度（width/height/left/top/margin/padding/gap/font-size/line-height/letter-spacing/border-radius…） | 有限数字，或 `12px` / `1rem` / `1.5em` 字面量 | `calc()`、`var()`、`env()`、`%`、`auto`、`fit-content`、`max-content`、`min-content`、`inherit`、`initial`、`unset`、`revert`、空串 |
| 颜色（color/background-color/border-color/outline-color…） | `#rgb` / `#rrggbb` / `#rrggbbaa`、`rgb()` / `rgba()` / `hsl()` / `hsla()` | `var()`、`currentColor`、`transparent`、其它 |
| 枚举/关键字（display/flex-direction/position/font-weight/white-space/text-align…） | 关键字字符串 | 值里含 `calc()` / `var()` / `env()` |
| 其它（box-shadow/font-family/vertical-align…） | 原样保留，避免过度过滤 | 空串 |

跳过的值不会让生成失败：CLI 的 `stats` 带 `{ collected, skipped, skippedByProp }`，
warning 里汇总一条（如「已跳过 10 个…（left×1、width×1…）」）；只有**所有**节点都没有
可用样式值时才会报「没有可生成的元素」。schema 不放宽，跳过值不参与契约比对。

## 3. 只读禁令

验收流程里**禁止调用**任何写类工具，包括但不限于：

`write_html`、`update_styles`、`create_artboard`、`delete_nodes`、`set_text_content`。

理由：验收者的职责是测量，不是改设计稿；写操作还会让本轮证据与设计源失去对应关系。
插件自带的 `scripts/paper-to-ui-spec.mjs` 只允许调用上表中的 `get_*` 工具（白名单硬编码在脚本里）。

## 4. 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `ECONNREFUSED` / 连接超时 | Paper 没启动，或端点写错 | 启动 Paper，确认端点可被当前机器访问；用 `--url` 或 `PAPER_MCP_URL` 指向它 |
| 初始化后马上失败 / 工具全不可用 | 会话过期或 Paper 重启过 | 断开重连 MCP（重开会话或重装该 MCP 行） |
| `expected string, received undefined` | 漏传 `fileId` | 除 `get_basic_info` 外，每个 `get_*` 调用都显式带 `fileId`；`get_computed_styles` 还要带 `nodeIds` |
| 工具参数老是缺 | 跳过了 `get_guide` | 先调 `get_guide` 看签名，再按签名传参 |
| `get_tokens` 返回 `[]` | 设计稿没有 token | 正常；只写节点级 computed styles，不要因此判定失败 |
| `get_tree_summary` 只有 `summary` 字符串 | Paper 0.5.19 返回文本树，不是节点数组 | 不要用它取节点；用 `get_children` 逐层 BFS |
| 拿不到 artboard | `get_basic_info` 的 `artboards` 为空 | 确认 Paper 当前文件已打开且包含画板；先打开目标文件再调用 |

## 5. 从 Paper 到 ui-spec 的两条路

- **全自动**：`node scripts/paper-to-ui-spec.mjs --file <fileId> --artboard <nodeId> --out ui-spec.json --max-depth 3 --url "$PAPER_MCP_URL"`
  （也可以只设环境变量 `PAPER_MCP_URL`）。脚本会依次调用 `get_basic_info` / `get_tokens` /
  `get_children`（BFS）/ `get_computed_styles`（分批），过滤到 ui-spec 白名单并做 schema 校验；
  `get_tree_summary` 只在带端点的 `--dry-run` 里用于打印概览。
- **手工**：按 `skills/ui-restore/SKILL.md` 第 3A 节的步骤逐步调用，把结果写进 ui-spec。

两条路生成的 `selector` 都只是 `[data-node-id="…"]` 占位；画师需要映射到真实页面选择器并写进交接。
