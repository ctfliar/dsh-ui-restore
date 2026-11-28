# dsh-ui-restore 插件详情

把「前端 UI 还原」做成 DeepSeek Harness 里的可复用多智能体闭环：一个角色按设计源实现页面，
另一个角色**只读**验收——截图、像素差异、计算样式探针取证，最后产出一份能交给人的静态报告。

本页是给人读的插件详情：能力边界、上手步骤、限制与截图位置。逐条命令与参数见
[USAGE.md](USAGE.md)，安装与升级卸载见 [INSTALL.md](INSTALL.md)。

> DSH 插件详情页（Plugin Manager）按规范优先读取包 README 作为长描述；本文件是 README 之外的
> 补充文档，从 README 的文档导航进入。若以后声明 `meta.detail`，按 dsh-doc 的 plugin-details
> 规范应改为「一行特性图」文档，功能与用法写回 `meta.description`。

## 功能

### 四个 Host 工具

| 工具 | 做什么 | 关键输入 | 产物 |
| --- | --- | --- | --- |
| `ui_capture` | 起浏览器（`chromium` → `chrome` → `msedge`，或指定 `executablePath`）截整页/元素 | `url`、视口、`selector`、`waitMs` | PNG 截图 + `meta.json`（视口、真实像素尺寸、产物清单） |
| `ui_diff` | 设计稿 vs 截图：等比对齐到设计画布后逐像素比较 | `design`、`shot`、`tolerance`、`profile` | `diff.png` 热力图、左右对照图、`diff.json`（score / 差异率 / 连通域 / 画布 / 风格指标） |
| `ui_probe` | 样式探针：无 `expected` 做样式体检；给 `expected` 按 ui-spec 逐属性对比 `getComputedStyle` | `url`、`expected`、`selector`、视口 | `probe.json`（`checks` 或 `issues`） |
| `ui_report` | 汇总一轮运行，生成可打印报告 | `run` 目录或显式路径、`locale` | `report.md` + 单文件 `report.html`（无 JS、无外链） |

工具只返回**本地文件路径**与结构化结果；图片由模型用 `read_image` 自行查看，插件不上传任何内容。

### 五个 Agent 预设

| 预设 | 职责 | 关键约束 |
| --- | --- | --- |
| `ui-restore`（队长） | 建档案、探能力、定设计模式、派活、收敛判定、交付报告 | 编排，不亲自改页面 |
| `ui-restore-designer`（设计） | 无参考时自主设计：产出设计包（`design.json` / `ui-spec.json` / `mock.html` / `mock.png` / `design.md`） | 只写 `<run>/design/` |
| `ui-restore-painter`（画师） | 在允许改动的目录内实现页面、跑 rules、自看截图 | 只改 inScope |
| `ui-restore-integrator`（接线） | 把页面数据层接到真实接口，产出 `api-map.json`，覆盖 loading / empty / error / 分页 / 重试 | 不判 UI |
| `ui-restore-verifier`（验收） | 跑 rules 门禁（只跑不改）、截图、探针、差异、判定、报告；`from-scratch` 时先做设计评审 | 文件系统只读 |

### 其他内建能力

- **方法随包注册**：`skills/ui-restore/SKILL.md` 在插件加载时注册为 runtime skill（`provider: runtime`），
  新会话的技能目录直接出现 `ui-restore`；缺少 skills service 的精简组合只是不注册技能，工具照常可用。
- **五种设计源**：Paper 直读（`mcp`）、设计图（`image`）、线上/参考页（`none` + `baseline.pages`）、
  无素材（`none`）、无参考自主设计（`design.mode = "from-scratch"`）。
- **统一证据面**：一轮运行目录里固定为 `meta.json`、`probe.json`、`diff.json`、`report.md`、`report.html`
  加三张图（设计稿 / 截图 / 差异热力图），下游脚本可以只依赖这些文件。
- **风格指标**：参考图与产出图的色板距离、明度、饱和、边缘密度、填充率写进 `diff.json` / `meta.json`，
  报告新增「风格指标」段；**只作证据，不参与 `pass` 判定**。
- **报告契约**：`report.md` / `report.html` 的章节与 `diff.json` / `probe.json` 的字段是稳定面，
  新增字段可以，删除或改名按不兼容变更处理。

## 用法

1. **安装**：`dsh plugin --profile <profile> add dsh-ui-restore`，或在 Plugins 面板/`plugin_manager`
   用 `install_bundle` 指向本地包目录。源码 link 安装与依赖解析见 [INSTALL.md](INSTALL.md)。
2. **写档案**：在项目里建 `ui-restore-profiles/<id>.json`，至少给设备档、合格线、设计源、
   rules 命令；要接真实接口时补 `api` 段（来源、环境、允许的 host、凭据环境变量名）。
3. **开工**：新会话预设选「UI 还原-队长」（`ui-restore`），说明要还原的页面、档案 id、
   允许改动的目录；有接口需求时说明测试环境与登录方式。
4. **一轮闭环**：队长派活 → 画师实现并自看截图 → 验收者跑 rules + `ui_capture` + `ui_probe` +
   `ui_diff` + `ui_report` → 队长按报告收敛或派下一轮。
5. **验收产物**：`<run>/report.html`（打印/分享）与 `<run>/report.md`；有接口任务时附带 `run/api-map.json`。

完整示例、五种设计源用法、阈值说明见 [USAGE.md](USAGE.md)；Paper 直读见 [paper-mcp.md](paper-mcp.md)；
团队协作接线见 [teams-integration.md](teams-integration.md)。自测：

```bash
node scripts/selftest.mjs            # 核心集（无需浏览器、无需网络）
node scripts/selftest.mjs --browser  # 追加真实浏览器链路
```

## 限制

- **不连接任何 MCP、不访问外部服务**：Paper 等设计源由使用者自行挂载；插件只读本地生成的
  ui-spec / 设计图 / 截图，报告与产物全部留在工作区。
- **不替用户做接口联调**：接线者只把页面数据层接到既有接口并产出 `api-map.json`，不判 UI 好坏。
- **需要可用的 Chromium 内核**：Playwright `chromium` 通道、系统 Chrome 或 Edge 之一，或用
  `executablePath` 指定；没有可用浏览器时截图/探针链路不可用（核心自测不依赖浏览器）。
- **像素判定以可比对为前提**：设计稿与截图尺寸、DPR 不一致时按设计画布等比对齐，缩放会带来
  额外像素差；动态交互态需要在截图阶段显式覆盖，静态报告本身不执行 JavaScript。
- **风格分不是合格线**：同风格不同内容、跨页比较都可能落在 0.85 附近，风格指标只用于风格层证据与
  回归基线，判定仍看结构层与 rules 门禁。
- **角色边界是硬约束**：验收者文件系统只读、shell 只用于跑 rules 命令；设计师只写 `<run>/design/`；
  越界由队长在交接单里限定，不靠模型自觉。
- **包内知识库只发文本**：npm 包只包含 Markdown（`docs/*.md`、`docs/knowledge/**/*.md`）与
  `docs/knowledge/patterns/` 的模板，案例证据图片保留在仓库、不随包发布，因此包内链接指向的
  图片需要在仓库里查看。
- **运行环境**：Node.js `>=20.10.0`；DSH 需满足 `engines.dsh`（见 README「兼容性」）。
- **发布物按白名单打包**：`package.json` 的 `files` 决定包内容，`scripts/fixtures` 必须保留
  （核心自测依赖），发布前用 `npm pack --dry-run` 核对文件数与体积。

## 截图占位

截图发布前用真实运行产物替换（建议放在 `docs/` 下的图片目录，随包发布与否按需决定）：

| 位置 | 想展示什么 | 状态 |
| --- | --- | --- |
| 报告总览 | `report.html` 顶部：还原度、轮次分数曲线、三图对照 | 待补 |
| 属性差异 | 契约模式下 `ui_probe` 的 `expected / actual / delta / severity` 表格 | 待补 |
| 设计评审 | `from-scratch` 时 `<run>/review/design-review.json` 与设计包五件套 | 待补 |

## 相关文档

| 文档 | 内容 |
| --- | --- |
| [README](../README.md) | 能力表、安装、快速开始、预设与设计源总览 |
| [INSTALL.md](INSTALL.md) | 命令行/面板安装、源码 link、升级卸载与排障 |
| [USAGE.md](USAGE.md) | 档案字段、五种设计源用法、一轮闭环动作序列、阈值说明 |
| [paper-mcp.md](paper-mcp.md) | Paper 直读：从设计稿生成 ui-spec |
| [design-sources.md](design-sources.md) | 设计图、参考页、无素材、自主设计四种来源的取舍 |
| [teams-integration.md](teams-integration.md) | 与 AgentTeams / 多智能体编排的接线方式 |
| [knowledge/README.md](knowledge/README.md) | 项目知识库：案例索引、patterns 配方与约定 |
