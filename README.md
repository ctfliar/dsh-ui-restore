# dsh-ui-restore

把「前端 UI 还原」做成可复用的多智能体闭环：一个 agent 按设计源/项目规范实现页面，
另一个 agent 用**截图 + 像素差异 + 样式探针**做量化验收，最后产出一份可直接交付的
验收报告（Markdown + 单文件 HTML）。

插件是 DeepSeek Harness 的 Host 插件，注册四个工具：

| 工具 | 作用 | 产物 |
| --- | --- | --- |
| `ui_capture` | 起浏览器截图（chromium → chrome → msedge） | `shot.png` |
| `ui_diff` | 设计图 vs 截图：等比对齐 + 逐像素 + 差异区域 | `diff.png`、`side-by-side.png`、`diff.json` |
| `ui_probe` | 样式探针：无 expected 做体检；有 expected 按 ui-spec 比对 | `probe.json` |
| `ui_report` | 汇总成验收报告 | `report.md`、`report.html` |

- **不连接任何 MCP、不访问任何外部服务**；只读本地项目档案与 ui-spec。
- 工具**只返回文件路径**（图片由模型用 `read_image` 查看），不依赖附件与图片输入模态。
- 同时支持**有设计源**（设计图 / 结构化样式契约）与**无设计源**（规则 + 基准页 + 探针）两种模式。

## 安装

```bash
# 方式一：包管理器
dsh plugin --profile <profile> add dsh-ui-restore

# 方式二：本地目录（DeepSeek Harness 内）
plugin_manager { "action": "install_bundle", "target": "<本目录绝对路径>" }
```

安装后：

1. 四个工具成为 **Host 全局工具**，当前 profile 的所有 agent 都能用；
2. `cordis.patch.yml` 同时声明了三个 **Agent 预设**（队长 / 画师 / 验收者），
   在会话的预设列表里可以直接选中；
3. 项目档案放在工作区的 `ui-restore-profiles/<id>.json`（内置示例见 `profiles/`）。

浏览器依赖 `playwright-core`（已在 `dependencies` 声明）。它按以下顺序解析：
包内 `node_modules` → 环境变量 `DSH_UI_RESTORE_PLAYWRIGHT` → `DSH_PROFILE_DIR/node_modules`
→ `DSH_INSTALL_DIR/node_modules`。启动时依次尝试 `chromium`、`chrome`、`msedge`，
也可以用 `executablePath` 指定任意 Chromium 内核浏览器。

## 依赖矩阵

| 层级 | 需要什么 | 缺失时的表现 |
| --- | --- | --- |
| **必需：DSH 基线** | `@deepseek-ai/dsh`。Host 平面需要 fs 提供方、shell 环境、jobs、附件存储与 subagent 的 `spawn` 提供方（基线组合默认都有）；模型侧 `tool-fs` / `tool-pwsh` / `tool-subagent` 由本插件的预设自带 | 装不上（`engines` 拦截）；或预设里对应工具行激活失败 |
| **必需：运行环境** | Node ≥ 20.10；可启动的 Chromium 内核浏览器（Playwright chromium / 系统 Chrome / Edge，或 `executablePath`） | 截图与探针失败，工具会给出排错提示 |
| **必需：本插件 Host 行** | 四个 `ui_*` 工具 | 闭环无法开始 |
| **可选：团队任务板** | 任意团队/任务板插件 | 降级为基线串行：队长 + 两个子预设；产物仍落 run 目录（见 `docs/teams-integration.md`） |
| **可选：设计工具 MCP** | 能把「元素 + 期望样式」导出成 ui-spec JSON 的任意 MCP | 降级为设计图模式或无素材模式（见 `docs/design-sources.md`） |

说明：

- 插件**不挂任何第三方包**，预设只引用 DSH 自带基线包（`dsh-persona` / `dsh-tool-fs` /
  `dsh-tool-bash` / `dsh-tool-pwsh` / `dsh-tool-subagent`）；shell 行按平台用 `!!js` 二选一，
  与 DSH 自带预设同一写法。
- 预设里**不重复声明**本插件的工具：它们是 Host 行，预设自动继承。
- Web / Desktop 组合会把模型侧的 fs / shell 工具移进预设，所以画师与队长预设也挂了对应的
  基线工具行；在基线组合（Host 平面挂载这些工具）下，预设作用域的同名工具会遮蔽全局同名工具，
  不会重复出现。
- 极端精简的组合如果缺 fs 提供方、jobs、附件存储或 `spawn` 提供方，预设里的工具行会激活失败：
  这些都属于 DSH 基线服务，先在 Host 平面补齐再用。

## 三个预设

| 预设 | order | 挂载 | 职责 | 边界 |
| --- | --- | --- | --- | --- |
| `ui-restore`（队长） | 40 | persona + `tool-fs` + `tool-subagent`（`provider: spawn`，`agentPreset: ui-restore-painter`，`allowedAgentPresets: [ui-restore-painter, ui-restore-verifier]`） | 建档案、探能力、派活、收敛判定、交付报告 | 不写页面代码、不改验收口径 |
| `ui-restore-painter`（画师） | 41 | persona + `tool-fs`（读写）+ shell（Windows 用 `tool-pwsh`，其它平台用 `tool-bash`，按平台二选一） | 在 inScope 内实现页面、跑规则门禁、自看截图、声明 selector 映射 | 不判 pass/fail、不改 ui-spec/阈值/knownIssues |
| `ui-restore-verifier`（验收） | 42 | persona + `tool-fs`（`write: false`、`edit: false`、`applyPatch: false`） | 截图、探针、差异、判定、报告 | 只读：不改页面代码与验收口径 |

用法：

1. 会话预选用 `ui-restore`（队长），或直接用默认预设手动按 SKILL 推进；
2. 队长通过 `subagent` 派活时，`agent_preset` 选 `ui-restore-painter` 或 `ui-restore-verifier`；
3. **只读保证**：Web / Desktop 组合把 fs 工具放在预设平面，验收者预设的 `write/edit` 关闭就是硬约束。
   在以 Host 行挂载 `tool-fs` 的组合（如基线 TUI）里，同名工具仍对整个会话可见——
   此时「验收者不改代码」由 persona 约束；需要硬保证时，把 Host 的 `tool-fs` 行也改成只读，
   或改用 Web/Desktop 的预设平面。

## 快速开始（无设计源模式）

```json
{ "url": "http://localhost:<port>/orders", "profile": "example-static", "run": "output/ui-restore/orders-r1" }
```
→ `ui_capture`

```json
{ "url": "http://localhost:<port>/orders", "profile": "example-static", "run": "output/ui-restore/orders-r1" }
```
→ `ui_probe`（审计模式：溢出 / 硬编码色 / 字号间距分布 / 缺 alt / 缺焦点 / 可疑空态）

```json
{ "run": "output/ui-restore/orders-r1", "profile": "example-static" }
```
→ `ui_report`（`report.md` + `report.html`）

## 快速开始（有设计源模式）

```json
{ "url": "http://localhost:<port>/orders", "width": 1440, "height": 900, "run": "output/ui-restore/orders-r1" }
```
→ `ui_capture` 得到实现截图

```json
{ "design": "design/orders.png", "shot": "output/ui-restore/orders-r1/shot.png", "profile": "example-static", "run": "output/ui-restore/orders-r1" }
```
→ `ui_diff` 得到 `score`、差异区域、热力图、左右对照图；同一 run 的多次 `ui_diff`
会累积成分数曲线（多轮迭代）。

```json
{ "url": "http://localhost:<port>/orders", "expected": "spec/orders.ui.json", "profile": "example-static", "run": "output/ui-restore/orders-r1" }
```
→ `ui_probe` 契约模式

```json
{ "run": "output/ui-restore/orders-r1", "profile": "example-static" }
```
→ `ui_report`

## 闭环怎么跑

完整方法（开工先建档案、能力探测、每轮顺序、判定门槛、收敛与停滞、角色提示词、
无素材模式、报告模板）见 **[`skills/ui-restore/SKILL.md`](skills/ui-restore/SKILL.md)**。
一句话版本：

```
规则门禁 → 截图 → 探针 → 差异 → 判定 → 修复 → 报告
（同一页面所有轮次复用同一个 run 目录）
```

三个预设的 persona 已经各自写清职责与边界，**不依赖 Skill 目录被发现**；如果想让 agent
在会话里按需加载这份 SKILL，在 profile 补丁里把插件的 `skills/` 目录接进技能目录
（可选，不加也能跑）：

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - <插件安装目录>/skills
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
```

## 项目档案（零依赖 JSON）

`profiles/<id>.json`，或用工具参数 `profile` 指向任意 JSON 路径。查找顺序：

1. `profile` 参数像路径（含 `/`、`\` 或 `.json` 结尾）→ 直接按路径读
2. `<cwd>/<profileDir>/<id>.json`（默认 `ui-restore-profiles/<id>.json`，项目本地覆盖）
3. `<插件目录>/profiles/<id>.json`（内置档案）

字段、默认值与校验规则见 **[`profiles/_schema.md`](profiles/_schema.md)**。最小档案：

```json
{ "id": "my-page" }
```

常用字段（全文见 schema 文档）：

```json
{
  "id": "my-page",
  "label": "订单列表",
  "baseUrl": "http://localhost:<port>",
  "devices": [{ "id": "desktop", "width": 1440, "height": 900, "dpr": 1 }],
  "thresholds": { "score": 0.95, "maxRounds": 3 },
  "rules": [{ "cwd": ".", "command": "<项目自己的校验命令>", "required": true }],
  "tokens": { "files": ["src/styles/tokens.css"], "prefix": "--" },
  "baseline": { "pages": ["src/views/orders/index.vue"] },
  "designSource": { "kind": "image", "artboard": "订单列表 / 桌面档" },
  "knownIssues": ["低分辨率下工具栏换行（产品已确认，不记缺陷）"],
  "notes": "自由文本"
}
```

- `devices[0]` 是 `ui_capture` / `ui_probe` 的缺省视口（缺省 1440×900，DPR 1）。
- `thresholds.score` 是还原度合格线；`ui_diff` 未显式给 `threshold` 时用
  `1 - thresholds.score` 作为允许的差异率。
- `designSource.kind` 只允许 `none` / `image` / `mcp`。`mcpServer`、`artboard`、`path`
  只是给人和模型的**文字引用**，插件从不解析、也从不连接。
- `rules` 是项目自己的校验命令，插件**不执行**，只在报告夹具声明里展示（由 agent 自行跑）。

内置示例：

| 文件 | 用途 |
| --- | --- |
| `profiles/minimal.json` | 只填 `id`，用来看默认值 |
| `profiles/example-static.json` | 通用模板：静态页面 + 图像设计源，复制后按项目补齐 |
| `profiles/static-demo.json` | 与自带静态夹具配套的完整示例 |
| `profiles/` 下两份真实项目示例档案 | 路径、命令、设备档与已知冲突的取值素材（文件名即档案 id） |

## 设计源

设计源只有三种形态，选择与接入方式见 **[`docs/design-sources.md`](docs/design-sources.md)**：

- **结构化**：任意设计工具 MCP（或自写脚本）导出 ui-spec JSON，走 `ui_probe` 契约模式；
- **图像**：设计图 PNG，走 `ui_diff` 像素比对；
- **无**：规则命令 + 同类型基准页 + 手写规范契约。

插件不连接 MCP、不读凭据；连接方式与凭据由使用者自理。

## ui-spec 契约

`ui_probe` 的 `expected` 可以是 JSON 文件路径、内联 JSON 字符串或对象：

```json
{
  "version": 1,
  "name": "订单列表基线",
  "viewport": { "width": 1440, "height": 900, "dpr": 1 },
  "tolerance": { "length": 0.5, "number": 0.01, "color": 0 },
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

- 属性名是 `getComputedStyle` 的驼峰写法，完整白名单见
  [`schemas/ui-spec.schema.json`](schemas/ui-spec.schema.json)。
- 长度可以写数字（按 px）或 `12px` / `1rem` / `auto` / `normal` 等；
  颜色支持 `#hex` / `rgb()` / `rgba()` / `hsl()`；阴影与字体族按归一化字符串比较。
- **非法字段直接报错**（未知属性会给出最相近的候选，未知顶层字段、空 selector、
  非法颜色、非法容差都会一次列全），不会静默跳过。
- 每条比较输出 `{ property, expected, actual, delta, deltaText, severity, pass }`；
  severity 按差异幅度与属性类型分级（`high` / `medium` / `low` / `pass`）。

## 报告

`ui_report` 输入可以是 run 目录（自动发现约定产物），也可以是各工具的显式产物路径。

- `report.md`：给人和 agent 引用（分数、图、区域表、差异表、修复清单、夹具声明）。
- `report.html`：**单文件静态页**——没有 `<script>`、没有外链、没有 CDN、没有 base64 大图；
  三张图用同目录相对路径引用；窗口变窄时网格自适应；`Ctrl/Cmd + P` 可直接打印。
  包含：概览卡片（还原度/轮次/模式/设计源/区域/属性差异）、内联 SVG 分数曲线、
  设计图/截图/热力图三图并排、差异区域表、属性差异表（expected/actual/delta/severity）、
  探测发现、修复清单、夹具声明（档案、设计源、阈值、工具版本、Node 版本、产物清单）。
- 表格在**生成阶段**按 severity 与差异量预排序（`data-sort-key` 保留列信息），
  所以页面不需要 JavaScript 也有稳定顺序；这是「静态可排序」的取舍。
- 报告必须写清**本次模式**与**设计源**：无设计源时不能声称「与设计稿一致」。

## run 目录

```
output/ui-restore/<run>/
  meta.json          运行元数据（档案、视口、产物清单、分数历史）
  shot.png           实现截图
  design.png         设计图（ui_diff / ui_report 复制进同目录，便于相对引用）
  diff.png           差异热力图
  side-by-side.png   左右对照
  diff.json          差异摘要（score / regions / sizeMismatch / threshold）
  probe.json         探针结果（审计或契约）
  report.md
  report.html
```

## 兼容性

| 项 | 说明 |
| --- | --- |
| DeepSeek Harness | **已在 `@deepseek-ai/dsh@0.2.2-rc.5` 实测**；`package.json` 的 `engines.dsh` 下限即该版本（`>=0.2.2-rc.5`）。更低运行时会在安装前被 plugin_manager 拒绝，避免装出半坏状态。 |
| Node.js | `>=20.10.0`（`engines.node`）。 |
| 浏览器 | Playwright `chromium` 通道，或系统 Chrome / Edge；`executablePath` 可指定任意 Chromium 内核二进制。 |
| Playwright | `playwright-core ^1.49.0`（本机实测 1.65.1）。 |

已知限制：

- **`node scripts/selftest.mjs --browser` 需要能启动浏览器的环境**：受限沙箱可能禁止子进程创建命名管道（表现为 `spawn EPERM`），此时只能跑核心集 `node scripts/selftest.mjs`（不需要浏览器）。
- `ui_diff` 只解码 8 位、非隔行 PNG；16 位或隔行 PNG 会给出明确报错，需要先转换。
- 报告 HTML 不加载任何 JavaScript；差异表的排序在生成阶段按 severity → delta 完成。
- 验收者预设没有 shell：页面服务必须由队长或画师提前起好，验收期间保持可用。

## 自测

```bash
node scripts/selftest.mjs            # 核心集：PNG 编解码、差异定位、ui-spec、档案默认值、报告
node scripts/selftest.mjs --browser  # 追加真实浏览器链路：截图、自比、改一处定位、两种探针、报告开页
node scripts/selftest.mjs --out ./tmp/selftest   # 指定产物目录（默认系统临时目录）
```

核心集不需要浏览器，适合 CI 与沙箱环境；浏览器集需要本机可启动 Chromium/Chrome/Edge。
产物默认写到系统临时目录，不污染工作区。

核心集里包含**工具入口级**用例：直接调用 `apply()` 注册出来的 `execute`（用一个最小
`@deepseek-ai` 桩 + 注入假浏览器实现），覆盖 `ui_probe` 的 `expected` 传「文件路径」与
「对象」两种形态是否等价、档案缺省视口是否生效、非法 spec 是否在起浏览器前报错。
核心集还包含**浏览器层假注入**用例：`capturePage` / `withPage` / `runProbe` 都接受
`launcher`（默认走 playwright），用假 browser/page 覆盖 `channel`、`width/height/dpr`、
审计与契约两种探针结构，因此这类只有真实浏览器才暴露的缺陷在无浏览器环境也能测出来。

## 浏览器排错

| 现象 | 处理 |
| --- | --- |
| `无法启动浏览器` | 装 Chrome/Edge，或 `npx playwright install chromium`，或给 `executablePath` |
| `缺少 playwright-core` | 在插件安装目录 `npm install playwright-core`，或设 `DSH_UI_RESTORE_PLAYWRIGHT` |
| 截图与设计图尺寸不一致 | 正常：`ui_diff` 会等比缩放；`sizeMismatch.mismatch=true` 表示比例不同 |
| 差异区域很碎 | 页面有 8px 级整体位移（如 padding 改动）时会出现多条细区域；按区域面积与 severity 排序查看 |
| 沙箱内 `spawn EPERM` / 浏览器进程起不来 | 当前环境禁止创建命名管道，浏览器无法启动；在非受限会话里跑，或只跑核心集自测 |

## 设计取舍

- **自己起 Playwright**：DSH 没有可复用的浏览器 service，插件自带 `playwright-core`。
- **纯 Node PNG 编解码**：只用 `node:zlib`，不依赖 native 模块，差异算法可单测、可离线跑。
- **每次调用起停浏览器**：避免常驻进程与 HMR 生命周期问题；多轮迭代靠 run 目录串起来。
- **只回路径**：与 `browser_screenshot` 同范式，模型自己决定看不看图，避免图片模态限制。
- **不解析 mcpServer**：设计源引用只是文本，插件不与任何 MCP 交互。
- **ui-spec 只解析一次**：来源文件路径由工具层作为独立 `sourcePath` 元数据持有，
  绝不写回 spec 本体——spec 顶层字段白名单不接受 `path`，写回去会让二次校验把它当
  未知字段拒掉（曾导致 `expected: "<路径>"` 100% 失败）。工具入口级回归覆盖这一点。
- **报告声明以档案为准**：`designSource` 是项目级声明，报告模式按它取
  （`image`/`mcp` → 有设计稿，`none` → 无设计稿）；显式 `mode` 与其冲突时以档案为准，
  并在报告里提示冲突。因此「审计运行（只有截图 + 探针）」在 `image` 项目里也会记为
  有设计稿模式；需要无设计稿模式请使用 `designSource.kind = "none"` 的档案。
- **设备档分三行**：本次视口（截图/探针实际尺寸）、档案设备档（profile 声明的 id 与宽高）、
  差异画布（diff 对齐用的设计稿画布）。三者不再合并成一行，避免 1280 与 1440 混写。
- **浏览器层可注入 launcher**：`capturePage` / `withPage` / `runProbe` 默认用 playwright，
  但都接受 `launcher` 注入；核心集用假 browser/page 覆盖 `channel`、视口与探针返回结构，
  避免「只有真实浏览器才暴露」的 ReferenceError 逃过自测。
- **报告图片 eager 加载**：本地单文件报告不启用 `loading="lazy"`——图片与报告同目录、
  体积可控，eager 加载能让 `load` 事件后立刻读到已解码图片，自动化截图/打印不会读到
  半加载状态。
- **预设只做编排，不重复声明本插件的工具**：四个 `ui_*` 是 Host 行；预设只固化角色、
  必要的基线工具（fs / shell / subagent）与只读约束。

## 目录结构

```
dsh-ui-restore/
  package.json            bundle 元数据（dsh.bundle.patch / exports / engines）
  cordis.patch.yml        Host 行 + 队长/画师/验收三个预设
  lib/index.js            四个工具的注册与编排
  lib/browser.js          playwright-core 解析、启动、截图
  lib/diff.js             PNG 编解码、等比对齐、逐像素、区域、热力图
  lib/probe.js            页面采集（审计 / 契约）与结论转换
  lib/spec.js             ui-spec 校验、颜色归一化、属性比较与分级
  lib/profile.js          项目档案加载、默认值与查找
  lib/report.js           Markdown + 单文件 HTML 报告
  lib/paths.js            路径、run 目录、meta.json
  schemas/                ui-spec JSON Schema
  profiles/               内置示例档案 + _schema.md（字段说明）
  skills/ui-restore/      给 agent 的闭环操作手册（SKILL.md）
  docs/                   设计源接入、团队集成（可选能力）
  examples/static-demo/   无外网、无构建的夹具页（设计基准 / 缺陷实现 / 审计页）
  scripts/selftest.mjs    自测
  locale/                 报告文案 zh / en
```

## 发布与版本约定

- **版本**：语义化版本。改工具参数/输出 schema、改档案字段语义、改预设 id 或角色边界
  都算不兼容变更，升 minor 以上并在 `CHANGELOG.md` 写清迁移方式。
- **发布物**：`package.json` 的 `files` 决定打包内容（lib / schemas / profiles / skills /
  docs / examples / scripts / locale + 补丁、README、CHANGELOG、LICENSE、icon）。
  发布前跑一遍 `npm pack --dry-run` 确认没有多余文件。
- **兼容性声明**：`engines.dsh` 与 `engines.node` 是安装期硬门槛；提高下限属于不兼容变更。
- **预设变更**：预设行 id（`preset-ui-restore*`）一旦发布就当作公开 id；改名会打断已选该预设的会话。
- **报告契约**：`report.md` / `report.html` 的章节与 `diff.json` / `probe.json` 的字段
  是下游可依赖的稳定面，新增字段可以，删除/改名要按不兼容变更处理。
- **不发布**：`output/`、自测临时产物、真实项目档案里的凭据/内网地址。示例档案只保留
  路径与命令，不放 token。

## License

MIT
