# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。
`package.json` 的版本号是唯一版本源；发布用 `npm run release:*`（见 README「发布与版本约定」）。

## [Unreleased]

## [0.4.0] - 2026-11-27

### Added

- **风格指标**（`lib/style.js`）：纯 Node 的 `analyzeStyle(pngBuffer)` 输出背景色（`background`）、
  全图前 8 主色（`palette`）、内容色板（`contentPalette`，剔除背景后的前 16 色）、颜色数、平均明度/饱和度、
  主色覆盖率、边缘密度、填充率与内容包围盒；`compareStyles(ref, out)` 输出风格分、
  `paletteDistance` / `luma` / `sat` / `edgeDensity` / `fillRatio` 差异与可读 `notes`。
  分数 = 1 − 加权归一 penalty（色板 0.55 / 明度 0.10 / 饱和 0.15 / 边缘密度 0.10 / 填充率 0.10）；
  色板距离 = 背景色距离（0.35）+ 内容色板 CIELAB EMD（0.65，含未匹配色质量），分项差异为相对差；
  阈值与权重集中在 `STYLE_CONSTANTS`；复用 `lib/diff.js` 的 PNG 解码。
- `ui_diff` 新增 `style` 字段（`score` / `deltas` / `notes` / `reference` / `output`），
  同时写入 `diff.json` 与 `meta.json`；`ui_report` 的 Markdown 与单文件 HTML 新增「风格指标」段
  （参考 vs 产出、色板色块与说明）。**风格指标只作证据，`pass`/`threshold` 语义不变**；
  没有 style 数据时报告整段省略。`docs/USAGE.md` / README 能力表同步，selftest 增加
  `analyzeStyle` / `compareStyles`、`ui_diff` 写盘与报告段落（0 script / 0 外链 / 0 base64）用例。
- **Paper 开工自检**：SKILL 3A 与 `docs/paper-mcp.md` 增加「核对 fileId → 尝试 `open_file` → 失败请用户打开」的约定，
  避免对着 Scratchpad / 同名草稿做设计或验收。
- **品类名推导规则**：用户只给品类名时，设计师按 `patterns.derivation` 自行推导 2–3 个代表商品与色族（不反问），
  推导理由写入 assumptions；验收者风格层增加「品类可辨识性 + 色板合规」两项；SKILL 2B 与两个 persona 同步，
  selftest 守卫加入「推导 / 可辨识」标记。
- **第 3 页单品类扩展规格**：1200×700、标题 24/700 + 副标 12、单图块水平居中；知识库补 `v3-page3.jpg`
  （宠物用品）与图块模板的居中片段。
- **知识库**：新增 `docs/knowledge/`，按**项目平行结构**组织（`projects/<slug>/cases|assets` + 跨项目 `patterns/`）。
  首个项目「直通车官网」收录三个版本：v0 手绘 SVG（失败）、v1 首次图像生成（失败）、v2 参考风格复刻（通过），
  含输入清单、风格规格、Paper `paper-gen://` 提示词配方、验收清单、失败根因与复盘；失败版本成图一并入库。
- **设计评审门**（`design.mode = from-scratch`）：设计师交付设计包后、画师动工前，验收者只读评审
  **设计包本身**——齐全性、`ui-spec` 对 `mock.html` 可执行且 `selectorMisses = 0`、loading/empty/error、
  可访问性（对比度/焦点/标签/alt）、品牌色与 `assumptions`、示意数据自洽、`mock.png` 与 `devices[0]`
  同视口且无横向溢出；结论写 `<run>/review/design-review.json`（`verdict` + `findings[]`，≤3 条关键项）。
  `pass` 才派画师，`needs_revision` 回设计师改一版后复审，`blocked` 找用户确认；
  **评审不过不得开始实现**。无图像输入时用结构化证据并声明「图像未人眼复核」。
- SKILL 4B 新增「设计评审」步骤、第 5 节新增「设计评审层」门槛、第 7 节角色与交接模板同步；
  队长 / 设计 / 验收三个预设 persona 同步（队长先派验收者评审，通过后才派画师；设计师按 findings 改包）；
  README / USAGE / teams-integration 同步；selftest 增加「设计评审门」一致性用例。

### Changed

- **风格指标区分度校准**（t2 验收修复）：修复 top-8 主色被白底占满、最近色匹配稀释色相的问题——
  背景色单独比较，内容色板用 CIELAB（ΔL 权重 0.2）双向 EMD 并计入未匹配色质量；明度/饱和/边缘密度/
  填充率改为相对差。真实资产回归（600px PNG 夹具 `scripts/fixtures/style/`）：v2 自比 1.0、
  v1 vs v2 **0.791**（同版本跨页 0.854）、v2 灰度化 **0.701**、v2 红蓝互换 **0.851**、v0 vs v2 0.600；
  selftest 新增阈值守卫，`docs/USAGE.md` 补风格分档与「不是 pass 判据」说明。
- **性能：审计探针 selector 惰性化**：`pageAudit` 的 `cssPath` 改为仅在记录问题时计算（惰性 getter）。
  5000 元素页面审计从 6.3–6.8s 降到 85ms（中位），selector 成本 12.2ms；契约模式不受影响。
- **性能：PNG 编码 deflate 级别 9 → 6**：真实 diff 图（1440×900）编码 108.1ms → 27.1ms（−75%），
  体积 65,618 → 69,281 字节（+5.6%）；差异图属排查中间产物，用体积换时间更划算。

## [0.3.0] - 2026-11-25

### Added

- **第 5 个预设「UI 还原-设计」**（`ui-restore-designer`，order 44）：没有 Paper 画板、设计图或参考页，
  而用户明确要求「自主设计」时，先由设计师读项目设计体系（token 文件、同类页面、共享组件、品牌资产），
  产出设计包 `<run>/design/`：`design.json`（色板 / 字阶 / 间距 / 圆角 / 阴影 / 组件规范 / 假设与出处）、
  `ui-spec.json`（供 `ui_probe` 契约模式的可执行契约）、`mock.html` + `mock.png`（离线可开、可截图）、
  `design.md`（结构、状态、响应式、可访问性、取舍）；页面要接接口时另给数据契约（字段 / 动作 / 状态）。
  边界：只写 `<run>/design/`，不改项目页面与样式，不引入新品牌色或外部 CDN，不判 pass/fail；
  Paper 出图（`paper.png`）仅在用户明确同意且会话里有 Paper MCP 写工具时可选，默认只出 spec + mock。
- **档案 `design` 段**：`mode`（`reference` / `from-scratch`，默认 `reference`）、`brief`（设计简报）、
  `styleRefs`（项目内可查的风格参照）、`outputs`（`spec` / `mock` / `paper`，默认 `spec` + `mock`）。
  非法 `mode` 只告警并退回 `reference`；`styleRefs` 非数组告警并忽略；`outputs` 过滤非法值、空则退回默认。
- **SKILL 第 3B 节「设计模式」**与**第 4B 节「设计阶段」**：写明什么时候才走 `from-scratch`、先读项目风格、
  设计包清单、Paper 可选出图的两条前提、设计模式与 3A「验收流程禁用 Paper 写类工具」的边界，
  并补齐队长 → 设计师、设计师 → 画师/验收者的交接模板；第 7 节角色说明扩为五个（新增设计师）。
- **判定口径新增「设计层」门槛**：`from-scratch` 时设计包齐全（`design.json` / `ui-spec.json` /
  `mock.png` / `design.md`）、画师实现与 `mock.png` 达标、mock 与实现同设备档，且报告如实写
  「设计源 = 设计包（自产 mock）」，不得说成客户设计稿或 Paper 出图。
- 文档与自测同步：README（能力表 / 预设表 / 设计源表）、`docs/USAGE.md`（§3.5 无参考自主设计、设计阶段
  D1~D4 动作序列、档案示例）、`docs/INSTALL.md`（五个预设）、`docs/teams-integration.md`（子角色与设计任务链）；
  selftest 增加 `design` 段默认值与非法值告警用例。

### Changed

- 队长预设：职责增加「`design.mode = from-scratch` 时先派设计师、设计包确认后再派画师」，
  `allowedAgentPresets` 增加 `ui-restore-designer`；子角色固定为「设计 / 画师 / 接线者 / 验收者」。
- 插件内「四个 Agent 预设」的统一表述改为五个；设计源表述从四种改为五种（新增设计模式）。

### Compatibility

- **旧用法不受影响**：既有预设 id（`ui-restore` / `-painter` / `-verifier` / `-integrator`）与档案字段不变；
  档案不写 `design` 段时 `design.mode = reference`，Paper 直读 / 设计图 / 线上参考页 / 无素材四条既有路径行为不变。
- 设计模式是**新增形态**，只有显式 `from-scratch` 才启用：无设计源但用户没要求自主设计时，仍走第 8 节无素材模式，
  不会自动变成「先自己设计再验自己」。

## [0.2.0] - 2026-11-23

### Added

- **第 4 个预设「UI 还原-接线」**（`ui-restore-integrator`，order 43）：把还原页面的数据层接到真实接口。
  产出 `<run>/api-map.json`（UI 元素/动作 → method + path → 入参 → 响应字段 → 状态 → 证据）。
  边界：只改 inScope 内的数据层与绑定；不判 UI、不改后端；找不到接口给 `blocked`，不编造；
  凭据只从环境变量读；`prod-readonly` 时只允许 GET。
- **档案 `api` 段**：`source`（`project` / `openapi` / `capture` / `none`）、`env`（`test` / `prod-readonly`）、
  `enabled`（默认 `false`）、`allow`（host/path 白名单）、`authEnv`（凭据环境变量名）。
  插件仍不联网、不执行命令、不读凭据，只把这段约定透给接线者与验收者。
- **SKILL 第 4A 节「接口接线阶段」**与判定口径新增「接口层」门槛：`api-map` 存在、页面无 mock 冒充、
  loading/empty/error/分页/重试覆盖、请求入参一致。
- USAGE / `profiles/_schema.md` / README 同步更新；selftest 增加 api 段默认值与非法值告警用例。

### Changed

- 队长预设：`allowedAgentPresets` 增加 `ui-restore-integrator`；职责增加「静态还原后派接线者」；
  边界增加「不自行编造接口或数据契约」。
- 插件内「三个 Agent 预设」的统一表述改为四个。

### Compatibility

- 新增预设 id `ui-restore-integrator` 属于增量，既有预设 id 不变；只做视觉还原的旧用法不受影响
  （档案不写 `api` 段时 `api.source = none`、`api.enabled = false`，接线阶段自动跳过）。

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
