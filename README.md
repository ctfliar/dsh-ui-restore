# dsh-ui-restore

把「前端 UI 还原」做成 DeepSeek Harness 里的可复用多智能体闭环：一个 agent 按设计源实现页面，
另一个 agent 用截图 + 像素差异 + 样式探针做量化验收，产出一份能交给人的报告。支持 **Paper 直读 /
设计图 / 线上参考页 / 无素材 / 设计模式（无参考自主设计）** 五种设计源，适用于本仓库所有前端页面。

- 文档导航：[安装](docs/INSTALL.md) · [使用](docs/USAGE.md) · [插件详情](docs/DETAIL.md) · [Paper MCP](docs/paper-mcp.md) · [设计源](docs/design-sources.md) · [知识库](docs/knowledge/README.md) · [E2E/CI](docs/e2e.md)
- 包内技能：`skills/ui-restore/SKILL.md`（安装后自动注册，无需手工拷贝）

## 能力表

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 截图 | `ui_capture` | Playwright Chromium / 系统 Chrome / Edge；整页/元素；返回 PNG 路径与真实像素尺寸 |
| 像素差异 | `ui_diff` | 等比对齐到设计画布后逐像素比较；score、差异率、连通域、热力图、左右对照；纯 Node 无 native 依赖 |
| 风格指标 | `ui_diff` / `ui_report` | 参考 vs 产出的色板、明度、饱和、边缘密度、填充率与风格分；写进 `diff.json` / `meta.json`，报告新增「风格指标」段；**只作证据，不改 `pass` 判定** |
| 样式探针 | `ui_probe` | 契约模式逐属性对比 `getComputedStyle`（`expected/actual/delta/severity`）；审计模式查溢出/硬编码色/字号间距/缺 alt/焦点/空态 |
| 验收报告 | `ui_report` | Markdown + 单文件 HTML（无 JS、无外链、可打印），含三图、风格指标、差异表、属性表、修复清单、夹具声明 |
| 编排 | 5 个 Agent 预设 | 队长（编排）/ 设计师（无参考时自主设计并产出设计包）/ 画师（实现）/ 接线者（接真实接口）/ 验收者（只读 + shell 跑 rules 门禁） |
| 方法 | SKILL 自动注册 | 安装后新会话的 skill 目录直接出现 `ui-restore` |

## 安装

```bash
# 方式 A：命令行
dsh plugin --profile <profile> add dsh-ui-restore

# 方式 B：Plugins GUI / 本地目录
plugin_manager { "action": "install_bundle", "target": "<包目录绝对路径>" }
```

源码 link 安装、依赖解析、升级卸载与故障排查见 **[docs/INSTALL.md](docs/INSTALL.md)**。

## 快速开始

1. 新会话预设选 **「UI 还原-队长」**（`ui-restore`）；
2. 在项目里写档案 `ui-restore-profiles/<id>.json`（设备档 / 合格线 / 规则命令 / 设计源 / 基准页；
   要接真实接口时补 `api` 段：来源、环境、允许的 host、凭据环境变量名；要**无参考自主设计**时
   把 `design.mode` 写成 `"from-scratch"` 并补 `brief` / `styleRefs` / `outputs`，默认 `reference`）；
3. 告诉队长要还原的页面、档案 id、允许改动的目录；有接口需求时说明测试环境与登录方式；
4. 验收者产出 `<run>/report.html`，按报告判定；有接口任务时 `run/api-map.json` 一并交付。

完整示例、五种设计源用法、一轮闭环动作序列与阈值说明见 **[docs/USAGE.md](docs/USAGE.md)**。

## 技能自动注册

插件加载时 `lib/skill.js` 读取包内 `skills/ui-restore/SKILL.md`，通过 `ctx.skills.register()`
注册为 runtime skill（rank 250，`provider: runtime`）。技能目录由 `import.meta.url` 推导，
源码不含本机绝对路径；注册走 `ctx.inject(['skills'])` 可选依赖，缺 skills service 的精简组合
只是不注册技能，四个工具照常挂载。验证：`node scripts/selftest.mjs` 的「技能自动注册」三条
用例；或在 DSH 会话里查看 skill catalog 是否出现 `ui-restore`。

## 五个预设

| 预设 | order | 挂载 | 职责 |
| --- | --- | --- | --- |
| `ui-restore`（队长） | 40 | persona + `tool-fs` + `tool-subagent` | 建档案、探能力、定设计模式、派活、收敛判定、交付报告 |
| `ui-restore-painter`（画师） | 41 | persona + `tool-fs`（读写） + shell | 在 inScope 内实现页面、跑 rules、自看截图、声明 selector 映射 |
| `ui-restore-verifier`（验收） | 42 | persona + `tool-fs`（只读） + shell | 跑 rules 门禁（只跑不改）、**from-scratch 时先做设计评审**、截图、探针、差异、判定、报告 |
| `ui-restore-integrator`（接线） | 43 | persona + `tool-fs`（读写） + shell | 把页面数据层接到真实接口、产出 `api-map.json`、覆盖 loading/empty/error/分页/重试 |
| `ui-restore-designer`（设计） | 44 | persona + `tool-fs`（读写，限定 `<run>/design/`） + shell | 无参考时自主设计：读项目风格 → 产出设计包（`design.json` / `ui-spec.json` / `mock.html` / `mock.png` / `design.md`，Paper 出图可选）；设计包需过验收者的设计评审才能进入实现 |

验收者 fs 保持只读（`write`/`edit`/`applyPatch` 全关）；shell 只用于跑 rules 命令。
接线者只有 fs（读写）+ shell，不装浏览器，不判 UI。
设计师 fs 可写，但 persona 限定只写 `<run>/design/`（项目页面、样式、组件只读），shell 用于起本地静态 mock 并自截，不跑项目规则、不判 pass/fail。
预设只引用 DSH 基线包，四个 `ui_*` 工具是 Host 行、预设不重复声明。详见
[docs/USAGE.md](docs/USAGE.md) 与 `cordis.patch.yml`。

## 设计源

| 设计源 | `designSource.kind` | 主判据 | 文档 |
| --- | --- | --- | --- |
| Paper 直读（主路径，不需要截图） | `mcp` | `ui_probe` 契约模式 | [docs/paper-mcp.md](docs/paper-mcp.md) |
| 设计图 | `image` | `ui_diff` 像素比对 | [docs/design-sources.md](docs/design-sources.md) |
| 线上 / 参考页（当基准） | `none` + `baseline.pages` | `ui_diff` 对齐基准图 | [docs/USAGE.md](docs/USAGE.md) §3.3 |
| 无素材 | `none` | rules + 审计探针 + 三同基准页 | [docs/USAGE.md](docs/USAGE.md) §3.4 |
| 设计模式（无参考，自主设计） | `design.mode = "from-scratch"` | 先过设计评审，再用 `ui_probe` 契约 + `ui_diff` 对自产 `mock.png` | [docs/USAGE.md](docs/USAGE.md) §3.5 |

**设计评审门**：`from-scratch` 时，设计师交付后先由验收者只读评审设计包本身（齐全性、契约可执行、
三态、可访问性、品牌色、数据自洽、mock 渲染），结论写 `<run>/review/design-review.json`；
`verdict = pass` 才派画师，`needs_revision` 回设计师改一版，`blocked` 找用户确认。评审不过不得开始实现。

插件本身**不连接任何 MCP**：设计源由使用者挂载（例如 Paper MCP），插件只读本地生成的 ui-spec / PNG。

## 兼容性

| 项 | 说明 |
| --- | --- |
| DeepSeek Harness | **已在 `@deepseek-ai/dsh@0.2.2-rc.5` 实测**；`engines.dsh` 为 `>=0.2.2-rc.5 \|\| >=0.3.0-rc.1`。只有新的 DSH minor 预发布经过实测，才追加对应 clause；不使用 `*`。 |
| Node.js | `>=20.10.0`（`engines.node`） |
| 浏览器 | Playwright `chromium` 通道，或系统 Chrome / Edge；`executablePath` 可指定任意 Chromium 内核 |
| Playwright | `playwright-core ^1.49.0`（本机实测 1.65.1） |

`engines.dsh` 维护规则：每出现一个新的 DSH minor 预发布（例如 `0.3.0-rc.1`），只有在本插件
于该版本上跑通 `node scripts/selftest.mjs --browser` 之后，才在范围里追加 `|| >=<该版本>`；
不提前放行未实测的版本，也不写 `*`。因此 `0.4.0-rc.1` 等未实测的新 minor 预发布默认不满足；
需要时先实测再追加 clause。补丁版本（`0.2.x`）直接落在已有 clause 内，无需改动。

## 自测

```bash
node scripts/selftest.mjs            # 核心集（无需浏览器）
node scripts/selftest.mjs --browser  # 追加真实浏览器链路
node scripts/e2e.mjs                 # 黄金 E2E：file:// 夹具 + 一次 launch 多视口 + 报告硬约束
node scripts/paper-to-ui-spec.mjs --file <fileId> --artboard <nodeId> --dry-run  # Paper 脚本 dry-run
```

核心集覆盖 PNG 编解码、差异定位、ui-spec 校验、档案默认值、报告硬约束、技能注册与 Paper
离线夹具；新增的 Paper 直读脚本用 `examples/paper/` 下的脱敏样本单测，不需要网络。
黄金 E2E 需要本机有 Chromium / Chrome / Edge 任一，跑法与 CI 说明见 **[docs/e2e.md](docs/e2e.md)**。

## 目录结构

```
dsh-ui-restore/
  package.json            bundle 元数据（dsh.bundle.patch / exports / engines / release scripts）
  package-lock.json       依赖锁文件（CI 与本地统一用 npm ci）
  cordis.patch.yml        Host 行 + 队长/设计/画师/接线/验收五个预设
  lib/                    四个工具、PNG 差异、风格指标、探针、ui-spec、档案、报告、技能注册
  schemas/                ui-spec JSON Schema
  profiles/               内置示例档案 + _schema.md
  skills/ui-restore/      闭环操作手册（安装后自动注册）
  docs/                   INSTALL / USAGE / DETAIL / paper-mcp / design-sources / teams-integration / knowledge
  examples/               static-demo 夹具 + paper 脱敏样本
  scripts/                selftest / release / paper-to-ui-spec
  locale/                 报告文案 zh / en
```

## 发布与版本约定

- **版本**：语义化版本。改工具参数/输出 schema、改档案字段语义、改预设 id 或角色边界都算不兼容变更，
  升 minor 以上并在 `CHANGELOG.md` 写清迁移方式。
- **发布物**：`package.json` 的 `files` 是白名单，发布前跑 `npm pack --dry-run` 核对文件数与体积。
  `docs/` 只发 Markdown（`docs/*.md`、`docs/knowledge/**/*.md`）与 `docs/knowledge/patterns/` 的模板，
  知识库案例的证据图片只留在仓库；`scripts/fixtures` 必须保留（核心自测依赖）。
- **可复现安装**：仓库提交 `package-lock.json`，CI 与本地统一用 `npm ci`。
- **元数据**：`repository` / `homepage` / `bugs` 指向 GitHub 仓库；`exports` 除运行入口外还导出
  `./cordis.patch.yml`、`./schemas/ui-spec.schema.json`、`./locale/*.json` 与 `./icon`（插件面板图标）。
- **兼容性声明**：`engines.dsh` 与 `engines.node` 是安装期硬门槛；提高下限属于不兼容变更。
  维护规则见上文「兼容性」。
- **发布流程**（本地 git + npm，不 push 远端）：

  ```bash
  npm login
  npm run release:dry     # 默认 dry-run：工作区 / 版本 / npm 登录态 / 将执行的命令
  npm run release:patch   # 或 release:minor；bump + npm publish --tag latest
  ```

  `scripts/release.mjs` 在 `--apply` 前会拒绝：脏工作区、目标版本未变、engines 与当前运行时冲突、
  npm 未登录；不会 push 任何 git 远端。
- **预设变更**：预设行 id（`preset-ui-restore*`）一旦发布就当作公开 id；改名会打断已选该预设的会话。
- **报告契约**：`report.md` / `report.html` 的章节与 `diff.json` / `probe.json` 的字段是下游可依赖的
  稳定面，新增字段可以，删除/改名要按不兼容变更处理。

## License

MIT
