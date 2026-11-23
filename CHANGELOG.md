# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。
`package.json` 的版本号是唯一版本源；发布用 `npm run release:*`（见 README「发布与版本约定」）。

## [Unreleased]

## [0.1.2] - 2026-11-23

### Added

- **Paper 直读主流程（设计源 A）**：`skills/ui-restore/SKILL.md` 新增第 3A 节，把
  `get_basic_info → get_tokens → get_tree_summary → get_computed_styles → ui-spec → ui_probe(expected)`
  写成可执行步骤与字段映射；明确 `get_tokens` 可能为空、所有 `get_*` 必须显式传 `fileId`、
  写类工具禁用；截图只用于字体回退/图片裁切/阴影/溢出/遮挡等渲染兜底，有 Paper 时不再用设计图模式。
- **`docs/paper-mcp.md`**：在 DSH 里挂 Paper MCP 的两种方法（配置-only bundle / Plugins 设置）、
  只读工具清单与必填参数、只读禁令、常见错误（Paper 未启动、会话过期、漏传 `fileId`、漏调 `get_guide`）。
- **`scripts/paper-to-ui-spec.mjs`**：零依赖 CLI，用 node 内置 fetch 走 JSON-RPC over HTTP
  （initialize → notifications/initialized → tools/call），解析 SSE `data:` 行；
  `--url` / `PAPER_MCP_URL` 取端点（源码不写死地址），支持 `--max-nodes` 截断 warning 与
  `--dry-run`，输出经 `schemas/ui-spec.schema.json` 校验。附 `examples/paper/`
  脱敏样本与不依赖网络的 selftest 单测。
- **安装与使用文档**：新增 `docs/INSTALL.md`（前置条件、三条安装路径、安装后自检、升级卸载、故障排查）
  与 `docs/USAGE.md`（快速开始、完整档案示例、四种设计源、一轮闭环动作序列、阈值与轮次、报告阅读、FAQ）。
- **技能自动注册**：插件自带的 `skills/ui-restore/SKILL.md` 现在由 `lib/skill.js`
  通过 `ctx.skills.register()` 注册成 runtime skill（rank 250）。安装后新会话的 skill
  目录即可发现 `ui-restore`，不需要用户手工拷贝到 `.dsh/skills` 或 `customSkillDirs`。
  技能目录由 `import.meta.url` 推导，源码不出现本机绝对路径；注册走
  `ctx.inject(['skills'])` 可选依赖，缺 skills service 的精简组合只是不注册技能，
  不影响四个工具挂载。
- **发布工具**：新增 `scripts/release.mjs` 与 npm scripts `release:dry` / `release:patch` /
  `release:minor`。默认 dry-run 打印工作区状态、当前/目标版本、npm 登录态与将执行的
  `npm version` / `npm publish --tag`；只有 `--apply` 才执行。脏工作区、目标版本未变、
  `engines.dsh` 与当前运行时冲突、npm 未登录都会拒绝并说明；不 push 任何 git 远端。

### Changed

- **README 改为落地页**：一段话定位 + 能力表 + 文档导航（INSTALL / USAGE / paper-mcp /
  design-sources），保留兼容性表（含 engines 维护规则）与发布约定；细节拆到 `docs/`。
- **验收者获得 shell**：`ui-restore-verifier` 预设按平台二选一挂 `tool-bash` /
  `tool-pwsh`（`disabled: !!js process.platform === 'win32'` / `!== 'win32'`，与画师同一写法），
  fs 仍保持只读（`read`/`readImage` true，`write`/`edit`/`applyPatch` false）。
  persona 增加「跑档案 rules 命令但只跑不改」的职责：规则不过判 `needs_revision`，
  并在 findings 里给命令输出摘要（命令、退出码、关键报错或首尾行）。
- **engines 策略放宽**：`engines.dsh` 改为 `>=0.2.2-rc.5 || >=0.3.0-rc.1`。
  README 写明维护规则：只有新的 DSH minor 预发布经过实测，才在范围里追加对应 clause；
  不使用 `*`。因此 `0.4.0-rc.1` 等未实测的新 minor 预发布默认不满足；需要时先实测再追加 clause。

### Fixed

- **B8（Paper computed styles 归一化）**：Paper 的 computed styles 含 `calc()`、`var()`、
  `auto`、百分比等表达式，会让生成的 ui-spec 过不了 schema。`paper-to-ui-spec.mjs` 现在按
  属性类型归一化：长度只接受有限数字或 `px`/`rem`/`em`；颜色只接受 `#hex` / `rgb()` /
  `hsl()`；枚举/关键字保留字符串但跳过含 `calc()`/`var()` 的值；其它属性原样保留。
  跳过的值计入 `stats.skipped` / `skippedByProp` 并汇总成一条 warning，不再整体失败；
  CLI 末尾打印一行 `nodes/elements/childrenCalls/styleCalls/collected/skipped/truncated` 摘要。
  selftest 增加 calc/var/auto/百分比夹具；文档补充「哪些值会被跳过」。
- **B7（Paper 主路径）**：真实 Paper 0.5.19 的 `get_tree_summary` 只返回文本树
  （`{"summary": "Frame ..."}`），不再用它建 ui-spec。`scripts/paper-to-ui-spec.mjs` 改为
  `get_children` 从 artboard 逐层 BFS 采集节点（`--max-depth` 默认 3、`--max-nodes` 默认 200，
  记录 id/name/component/childCount/depth/parentId），`get_computed_styles` 按批调用
  （每批 ≤ 50 个 nodeIds，单批失败跳过并 warning），结果记录 `childrenCalls` / `styleCalls`；
  `get_tree_summary` 仅在带端点的 `--dry-run` 里打印概览。selftest 夹具改为真实形状
  （字符串 summary + 两层 get_children + 分批 styles），sample 元素顺序随 BFS 更新（内容不变）。
- **B6（Paper 多 content block 解析）**：真实 Paper 的 `tools/call` 返回两段 text block
  （block0 上下文头 `{file, contentHash}`，block1 业务载荷）。`scripts/paper-to-ui-spec.mjs`
  不再只取第一个块：解析所有 text block、跳过上下文头，按工具业务键选块
  （`get_basic_info`→artboards/fileName、`get_tokens`→tokens、`get_tree_summary`→summary、
  `get_children`→children、`get_computed_styles`→styles）；多业务块浅合并并写 warning；
  只有上下文头时报可读错误「返回里没有 artboards」，不再静默空结果。`--dry-run` 带端点时
  做只读探测并列出 artboards。selftest 夹具改为真实两段式并新增该回归用例。
- **T21-F1（文档 fileId 表述）**：`docs/paper-mcp.md` 与 `docs/USAGE.md` 改为
  「除 `get_basic_info` 外，其余 `get_*` 必须显式传 `fileId`」，与工具表/SKILL/脚本一致。
- **T6-L1**：审计运行（`ui_probe` 不带 `expected`）的报告在 HTML 与 Markdown 里显式写
  「本次未做设计比对（审计运行）」，避免读者误以为做过设计稿比对；selftest 增加 HTML/MD 断言。

## [0.1.1] - 2026-11-23

### Added

- **技能自动注册**：插件自带的 `skills/ui-restore/SKILL.md` 现在由 `lib/skill.js`
  通过 `ctx.skills.register()` 注册成 runtime skill（rank 250）。安装后新会话的 skill
  目录即可发现 `ui-restore`，不需要用户手工拷贝到 `.dsh/skills` 或 `customSkillDirs`。
  技能目录由 `import.meta.url` 推导，源码不出现本机绝对路径；注册走
  `ctx.inject(['skills'])` 可选依赖，缺 skills service 的精简组合只是不注册技能，
  不影响四个工具挂载。
- **发布工具**：新增 `scripts/release.mjs` 与 npm scripts `release:dry` / `release:patch` /
  `release:minor`。默认 dry-run 打印工作区状态、当前/目标版本、npm 登录态与将执行的
  `npm version` / `npm publish --tag`；只有 `--apply` 才执行。脏工作区、目标版本未变、
  `engines.dsh` 与当前运行时冲突、npm 未登录都会拒绝并说明；不 push 任何 git 远端。

### Changed

- **验收者获得 shell**：`ui-restore-verifier` 预设按平台二选一挂 `tool-bash` /
  `tool-pwsh`（`disabled: !!js process.platform === 'win32'` / `!== 'win32'`，与画师同一写法），
  fs 仍保持只读（`read`/`readImage` true，`write`/`edit`/`applyPatch` false）。
  persona 增加「跑档案 rules 命令但只跑不改」的职责：规则不过判 `needs_revision`，
  并在 findings 里给命令输出摘要（命令、退出码、关键报错或首尾行）。
- **engines 策略放宽**：`engines.dsh` 改为 `>=0.2.2-rc.5 || >=0.3.0-rc.1`。
  README 写明维护规则：只有新的 DSH minor 预发布经过实测，才在范围里追加对应 clause；
  不使用 `*`。因此 `0.4.0-rc.1` 等未实测的新 minor 预发布默认不满足；需要时先实测再追加 clause。

## [0.1.0] - 2026-11-23

首个可用版本。

### 工具

- `ui_capture`：playwright-core 起 Chromium/Chrome/Edge 截图；缺省视口取档案
  `devices[0]`（否则 1440×900）；支持整页、元素截图、run 目录、显式路径；
  返回 PNG 实际像素尺寸与 DPR。
- `ui_diff`：设计稿 vs 截图，等比缩放到设计稿画布后逐像素比较；输出还原度 `score`、
  差异率、8 邻接连通域差异区域（含 severity）、差异热力图、左右对照图；
  纯 Node（`node:zlib`）PNG 编解码，无 native 依赖；支持 2x DPR 等比缩放与
  `sizeMismatch` 标记；同一 run 的多次比较累积成分数历史。
- `ui_probe`：两种模式。审计模式检查横向溢出、硬编码颜色、字号/间距分布、
  图片缺 alt、缺可见焦点、可疑空态；契约模式按 ui-spec 逐属性对比
  `getComputedStyle`，输出 `{property, expected, actual, delta, severity}`，
  非法字段一次性列全并给出最相近候选。
- `ui_report`：产出 `report.md` 与单文件 `report.html`。HTML 无 `<script>`、无外链、
  无 CDN、无 base64 大图；含概览卡片、内联 SVG 分数曲线、设计图/截图/热力图三图并排、
  差异区域表、属性差异表、探测发现（含字号/间距/颜色分布）、修复清单（按严重度收敛到
  关键项）与夹具声明；窄屏自适应、可打印。

### 编排层（预设 / 方法 / 档案）

- `cordis.patch.yml` 增加三个 Agent 预设：`ui-restore`（队长，order 40）、
  `ui-restore-painter`（画师，41）、`ui-restore-verifier`（验收，42）。
  队长预设用 `dsh-tool-subagent` 固定子角色（`agentPreset` + `allowedAgentPresets`）；
  验收预设用 `dsh-tool-fs` 的 `write: false` / `edit: false` 做只读约束；
  画师的 shell 行按平台二选一（Windows `tool-pwsh` / 其它 `tool-bash`，与 DSH 自带预设同写法）。
  预设只引用 DSH 基线包，不挂任何第三方包；本插件的四个工具仍是 Host 行，预设不重复声明。
- `skills/ui-restore/SKILL.md` 重写为通用方法层：开工先建档案、能力探测（团队任务板 /
  设计工具 MCP / 都没有）、每轮「截图 → 探针 → 差异 → 判定 → 修复 → 报告」、
  判定门槛与 findings 结构、收敛与停滞阈值、三个角色的提示词与边界、
  selector 映射由画师声明、无素材模式三层基线、报告模板（含「本次模式 / 设计源」）。
  不出现任何具体仓库名、端口或项目校验命令。
- 新增 `docs/design-sources.md`：结构化（任意 MCP 产 ui-spec）/ 设计图 / 手写 spec /
  无设计源四种接入方式，明确连接与凭据由使用者自理，Paper 只作例子。
- 新增 `docs/teams-integration.md`：团队任务板集成的两种实现（串行基线 / 任务链）、
  何时值得用、能力探测与降级、以及为什么不做硬依赖。
- `profiles/_schema.md` 补全档案字段、默认值与校验规则；新增
  `profiles/example-static.json`（通用模板）与两份真实项目示例档案（仅作取值素材）。

### 发布元数据

- `package.json`：声明 `engines.dsh`（本机实测运行时）与 `engines.node >=20.10.0`；
  `exports` 的 `.` 指向 `./lib/index.js`（与 `main` 一致），并暴露 `cordis.patch.yml`、
  `schemas/ui-spec.schema.json`、`package.json`；`files` 覆盖 lib/schemas/profiles/
  skills/docs/examples/scripts/locale 与 cordis.patch.yml、README、CHANGELOG、LICENSE、icon.svg。
- README 增加「兼容性」「依赖矩阵」「三个预设」「发布与版本约定」等章节，并把
  「`--browser` 自测需可启动浏览器的环境」列为已知限制。

### 配套

- 项目档案：零依赖 JSON，缺字段补默认值，支持工作区覆盖与内置档案；设计源
  `mcpServer`/`artboard` 仅为文字引用，插件不做任何 MCP 连接。
- ui-spec：JSON Schema 白名单（`schemas/ui-spec.schema.json`），长度/颜色/数值/
  关键字/阴影/字体族六类校验与容差。
- 报告文案 zh/en；`skills/ui-restore/SKILL.md` 闭环操作手册；
  `examples/static-demo/` 夹具（设计基准 / 缺陷实现 / 审计页 / 两份 ui-spec）。
- `scripts/selftest.mjs`：核心集（无需浏览器）+ 可选浏览器集；覆盖 PNG 往返、
  自比≈1、改一处定位、尺寸不对齐、ui-spec 合法/非法、档案默认值、报告硬约束，
  以及真实浏览器里的截图/自比/定位/两种探针/报告开页（三图加载、零脚本、窄屏不溢出）。
