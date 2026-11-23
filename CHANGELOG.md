# Changelog

## 0.1.0

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

- `package.json`：声明 `engines.dsh >=0.2.2-rc.5`（本机实测运行时）与
  `engines.node >=20.10.0`；`exports` 的 `.` 指向 `./lib/index.js`（与 `main` 一致），
  并暴露 `cordis.patch.yml`、`schemas/ui-spec.schema.json`、`package.json`；
  `files` 覆盖 lib/schemas/profiles/skills/docs/examples/scripts/locale 与
  cordis.patch.yml、README、CHANGELOG、LICENSE、icon.svg。
- README 增加「兼容性」一节：DSH 0.2.2-rc.5 实测、engines 下限、浏览器依赖，
  并把「`--browser` 自测需可启动浏览器的环境」列为已知限制。
- README 增加「依赖矩阵」（必需基线 / 可选团队任务板 / 可选设计 MCP）、
  「三个预设」、「发布与版本约定」三节。

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
