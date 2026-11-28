# SKILL · UI 还原闭环（dsh-ui-restore）

> 适用：任意前端页面（PC 后台、H5、静态页、组件预览）。
> 目标：把「像不像设计稿」变成可复现的分数、差异区域和属性差异，而不是口头感觉。
> 依赖：DeepSeek Harness 基线 + 本插件（Host 平面四个工具）。团队任务板、设计工具 MCP
> 都是可选项，缺了就降级，不能停工（见第 3 节）。

## 1. 名词

| 名词 | 含义 | 落在哪 |
| --- | --- | --- |
| 项目档案 | 一次接入的夹具声明：设备档、合格线、规则、设计源、设计模式、基准页、已知问题 | `<工作区>/<档案目录>/<id>.json`（默认 `ui-restore-profiles/<id>.json`） |
| run 目录 | 一次还原验收的全部产物：截图、设计图、热力图、探针 JSON、报告 | `<runRoot>/<run>`（默认 `output/ui-restore/<run>`） |
| api-map | 接线者产出的接口映射：UI 元素/动作 → method+path → 入参 → 响应字段 → 状态 | `<run>/api-map.json` |
| ui-spec | 机器可读的样式契约：selector + 属性期望值 | 任意 JSON 文件，schema 见插件 `schemas/ui-spec.schema.json` |
| design 段 | 档案里的设计模式声明：`mode`（`reference` / `from-scratch`）、`brief`、`styleRefs`、`outputs` | 档案 JSON 的 `design` 字段 |
| 设计包 | 无参考时设计师产出的设计依据：`design.json` / `ui-spec.json` / `mock.html` / `mock.png` / `design.md`（可选 `paper.png`） | `<run>/design/` |
| 判定 | 有资格的结论：`pass` / `needs_revision` / `blocked` + findings | run 目录里的 `report.md` / `probe.json` / `diff.json` |

最小调用形状（`ui_capture` / `ui_probe`）：

```json
{ "url": "<页面地址>", "profile": "<档案 id>", "run": "<runRoot>/<页面>-r1" }
```

## 2. 开工第一步：读档案，没有就建

**顺序固定：先档案，后截图。** 没有档案时不要直接截图，否则阈值、设备档、设计源都没有落点。

1. 找档案：工具参数 `profile` 传档案 id。查找顺序是
   `工作区/<档案目录>/<id>.json` → 插件内置 `profiles/<id>.json`；也可以直接传 JSON 路径。
2. 建档案：复制插件内置的 `profiles/example-static.json`，按项目补齐下面这些取值
   （字段与校验规则见 `profiles/_schema.md`）：
   - `devices[0]`：真实主档。PC 用桌面宽度（如 1440×900 @1x），移动端用手机宽度（如 375×812 @2x）。
   - `thresholds.score`：产品/仓库约定的还原度合格线，没有约定就用 0.95。
   - `thresholds.maxRounds`：最多允许几轮，默认 3。
   - `rules`：项目自己的校验命令（`cwd` + `command` + `required`）。插件**不执行**，只写进报告夹具声明，
     由画师和验收者在各自会话里跑。
   - `tokens.files`：设计 token 来源文件（供人和模型查证，插件只做文字引用）。
   - `baseline.pages`：无设计源时用的「三同」基准页（同类型 → 同宽度 → 同数据量）。
   - `designSource.kind`：`none`（无设计源）/ `image`（设计图）/ `mcp`（外部设计工具产出的结构化文件）。
   - `styleBaseline`（可选）：风格基线图片路径（PNG/JPEG，相对工作区）。`ui_diff` 未传 `design` 时用它
     只算风格指标（style-only），不做像素判定；路径非法会告警并忽略。
   - `design`：设计模式声明（见 3B）。`mode` 取 `reference`（默认：有设计源、或无素材模式）或
     `from-scratch`（无参考、且用户明确要求自主设计）；`from-scratch` 时还要写 `brief`（设计目标）、
     `styleRefs`（可读的风格参考路径/URL）、`outputs`（`spec` / `mock`，可选 `paper`）。
     默认值即旧行为，不写这段等于 `reference`。
   - `api`：页面要连真实接口时的接线约定——`source`（`project` / `openapi` / `capture` / `none`）、
     `env`（`test` / `prod-readonly`）、`enabled`、`allow`（允许访问的 host/path 前缀）、`authEnv`
     （凭据所在环境变量名）。只做视觉还原、不接后端时留默认值即可。
   - `knownIssues`：**产品确认过**、不计入缺陷的项。不要自己往里加。
3. 有设计源：
   - 图像模式：把设计图导出成 PNG 或 JPEG，白底、单画板、与 `devices[0]` 同比例，放到版本库能引用的位置。
   - 结构化模式：把设计工具 MCP 导出的 ui-spec 存成 JSON 文件（见 `docs/design-sources.md`）。
4. 无设计源：先记下「三同」基准页，再准备一份**关键锚点** ui-spec（8~15 条即可）：
   主操作按钮、页面标题、卡片、表头、状态标签、弹窗、空态。不要给整页每个元素写期望值。
5. 固定数据：同数据量、同排序、关闭随机与动画。插件截图时会冻结 CSS 动画与过渡，
   但业务数据仍需自己固定。

## 2B. 项目知识库（开工先查）

建好档案后、动手前，先查项目知识库。它是**按需读取**的案例经验，不是第二个设计源，也不要求读完整库。

- 位置：`docs/knowledge/`。
- 按项目 slug 找本项目的 `docs/knowledge/projects/<slug>/README.md`；没有这个目录就**跳过本节**，
  按通用流程做，做完按 `docs/knowledge/README.md` 的约定补案例。
- 只读与本次任务相关的部分，**不要整库加载**：
  1. 项目 README：输入清单与设计系统（色板、字阶、间距、图块/卡片规格）；
  2. 案例索引里**最近 1 个 passed 案例**：看清这次为什么过、哪些做法可复用；
  3. 同类任务**最近 1 个 failed 案例**：只记教训（不要怎么做），不拿它当基准；
  4. `patterns/` 里与任务相关的配方/模板：提示词配方、style tokens、图块模板、双层验收清单。

### 五角色读取分工

| 角色 | 开工先读 | 用来做什么 |
| --- | --- | --- |
| 队长 | 项目 README + 案例索引 + 失败案例 | 判断案例能否复用；派活时在交接里带「参考案例」路径 |
| 设计师 | `patterns/` + 失败案例 + 项目设计系统 | 定风格与刻度时对齐项目现有取值，避开已知失败做法 |
| 画师 | 项目设计系统 + 图块/风格模板 | 实现前对齐色板、尺寸与标签规格 |
| 验收者 | 项目设计系统 + 失败案例 + 双层验收清单 | 结构层与风格层分别有据可依，并能指到具体项 |
| 接线者 | 项目 README 的 api 约定 + 相关案例 | 接口路径、入参与状态处理以项目为准 |

原则：

- **不照搬别的项目**：色板、尺寸、图块规格只从本项目 README / token / 现有页面取；
  别的项目的案例只能借方法，不能借数值。
- **失败案例只作教训**：写清「不要怎么做」，既不是合格基准，也不能当设计源拿来做像素比对。
- **案例不足就按通用流程做**：不要为了凑案例停工；本次做完补一条案例
  （期望 / 实际 / 证据 / 根因 / 教训，格式见 `docs/knowledge/README.md`）。

### 品类名推导（用户只给品类名时）

- **不要反问**商品组合或底色；按 `patterns/prompts.json` 的 `derivation` 规则，自行推导 2~3 个
  代表性商品与色族，写进设计包的 assumptions。
- 色族只能从项目已采样的色板里选；新品类没有直接映射时选最接近的色族，并写明理由；
  不得新增品牌色或高饱和色。
- 验收者风格层额外检查两项：**品类可辨识性**（商品是否对应品类）与**色板合规**（无新增品牌色/高饱和）；
  推断不合理给 `needs_revision`，而不是只看结构指标。

## 2C. 安全边界与判定可信（代码强制）

下面几条由插件代码强制，不是提示词约定；验收结论必须能对上这些证据。

1. **路径只允许在工作区内**：`ui_capture` 的 `path` / `run`，`ui_diff` 的 `design` / `shot` / `out` / `run`，
   `ui_probe` 的 `out` / `run`，`ui_report` 的 `run` / `design` / `shot` / `diffPath` / `diffJson` / `probePath` / `out`
   都会先解析成工作区内的绝对路径。绝对路径指向工作区外、或用 `../` 跳出工作区，会直接报错并说明原因，
   **不会静默读取，也不会写盘**。设计图/截图请先放进 `<工作区>/<runRoot>/<run>/`。
2. **阈值锁死**：`ui_diff` 的判定阈值只取档案 `thresholds.score`（`threshold = 1 - score`），
   像素容差只取插件配置 `tolerance`；`ui_report` 的合格线同样只取档案。调用参数里的
   `threshold` / `tolerance` 会被忽略并返回 warning；`declared`（声明值）与 `effective`（生效值）
   同时写进 `diff.json` 与 `meta.json`。`pass` 语义不变，仍只按档案阈值判定。
3. **证据身份**：`diff.json` / `meta.json` / 报告夹具区记录本次会话 cwd、会话 id（exec 可取时）、
   工具调用 id 与时间、设计稿与截图的 SHA-256。判定必须引用这些字段；图被换过、或不是同一会话验的，
   哈希/时间对不上就能被发现。
4. **已知限制（必须人工兜底）**：`design.mode = from-scratch` 的**设计评审门仍是流程约束，不是代码强制**——
   插件不会阻止画师在 `<run>/review/design-review.json` 出现 `verdict = pass` 之前改代码，
   也不会校验评审文件本身。队长必须在派实现前确认评审 `pass`，验收者在报告里写明评审结论；
   不要把它当成「工具已经保证了」的门禁。

## 3. 能力探测（先探测，再定形态）

开工时逐项确认下面这些能力。**探测结果只决定形态，不决定是否继续。**

| 能力 | 怎么探测 | 用来做什么 | 缺失时 |
| --- | --- | --- | --- |
| 本插件四个工具 | 工具列表里能看到 `ui_capture` / `ui_diff` / `ui_probe` / `ui_report` | 整个闭环 | 装好插件再开工；这是唯一硬依赖 |
| 浏览器 | 用 `ui_capture` 截一张最小页面，看是否返回 PNG 路径 | 截图与探针 | 换系统 Chrome/Edge，或给插件配置 `executablePath`；沙箱禁起进程时改到非受限会话 |
| 项目校验命令 | 档案 `rules` 里是否有 `required: true` 的项，命令能否跑通 | 规则门禁（第 0 层） | 没有机械门禁就在报告里写明「本项目无机械门禁」，不要假装跑过 |
| 设计工具 MCP（结构化，含 Paper 直读） | 会话里能否调用 `get_basic_info` / `get_computed_styles` 等只读工具（见第 3A 节） | 生成 ui-spec，走契约模式 | 用设计图（图像模式） |
| 设计图 | 档案 `designSource.kind = image` 且 PNG/JPEG 可读 | `ui_diff` 像素比对 | 走无素材模式（第 8 节） |
| 设计能力（无参考自主设计） | 用户明确说「没有设计稿，你来设计」，且档案 `design.mode = from-scratch`；会话能只读项目样式/页面 | 先产出设计包（3B），再让画师照着实现 | `design.mode` 保持 `reference`：走 3A / 设计图 / 第 8 节，**不要自行「自己设计一个」来补设计源** |
| 团队任务板 | 会话里是否出现团队/任务板相关工具 | 并行多页面、任务状态可审计 | 用基线的 subagent 串行闭环，产物仍然落 run 目录 |
| 后端接口 | 项目里有没有 api 目录 / request 封装，OpenAPI 是否存在，参考页能否抓到请求 | 接线者把页面数据层接到真实接口 | 没有接口来源时接线者给 blocked，列缺失清单，不编造 |

四种形态：

1. **结构化模式**（Paper 直读 / 有设计工具产物 / 有手写 ui-spec）：`ui_probe` 契约模式是主判据，
   `ui_diff` 只在同时有设计图时补充。Paper 直读的完整步骤见第 3A 节。
2. **图像模式**（只有设计图）：`ui_diff` 是主判据，`ui_probe` 审计模式补规范问题。
3. **无素材模式**（都没有）：规则门禁 + 审计探针 + 同类型基准页自比（第 8 节）。
4. **设计模式**（无参考、用户明确要求自主设计，`design.mode = from-scratch`）：先由设计师产出设计包，
   之后按设计包走「结构化 + 图像」双判据（第 3B 节）。

> 探测不到团队任务板、设计工具 MCP 都是正常情况。基线形态必须能把闭环跑完，
> 并在报告里写清「本次模式 / 设计源」。

## 3A. 设计源 A：Paper 直读（主路径，不需要截图）

有 Paper MCP、且能拿到结构化节点样式时，优先走这条：直接读设计值生成 ui-spec，交给
`ui_probe(expected)` 做契约验收；**设计图 / 截图不再是主判据**。

**先核对文档**：`get_basic_info` 的 `file.id` 必须是目标 fileId；当前是 `Scratchpad`、同名草稿或 copy 时，
先 `open_file({ fileId, pageId })` 尝试打开，失败就请用户手动打开目标文件——不要对着错误的文档读样式。

前提：
- 会话里能调用 Paper MCP 的只读工具；端点由使用者配置（见 `docs/paper-mcp.md`）。本插件不连接
  任何 MCP、不读凭据。
- 只需要 fileId 与 artboard nodeId。`get_tokens` / `get_tree_summary` / `get_children` /
  `get_computed_styles` **都必须显式传 fileId**（描述可省略，实际 schema 强制）。
- 写类工具（`write_html` / `update_styles` / `create_artboard` / `delete_nodes` /
  `set_text_content`）在验收流程里一律禁用。

可执行步骤：
1. `get_basic_info` → 选目标 artboard，记录 `id` / `width` / `height`；视口取这个画板，不按桌面默认值猜。
2. `get_tokens({ fileId })` → 可能返回 `[]`：设计稿没用 token 是正常情况，**不要假设有 token**，
   也不要因此改走截图模式。
3. `get_children({ fileId, nodeId })` 从 artboard 开始**逐层 BFS** 采集节点（默认 `--max-depth 3`、
   `--max-nodes 200`）：记录 `{ id, name, component, childCount, depth, parentId }`，只保留需要验收的节点
   （容器 / 文本 / 按钮 / 卡片）。**不要用 `get_tree_summary` 取节点**——Paper 0.5.19 的
   `get_tree_summary` 只返回文本树（`{ summary: "Frame ..." }`），仅用于概览。
4. 对采集到的 `nodeIds` **分批**（每批 ≤ 50）调用 `get_computed_styles({ fileId, nodeIds: [ ... ] })`，
   合并结果；某一批失败只跳过该批并记 warning。再按 ui-spec 白名单过滤
   （`schemas/ui-spec.schema.json`，或 `lib/spec.js` 的 `PROPERTY_RULES`）。
5. 生成 `ui-spec.json`：`version: 1`，`viewport` 取 artboard 宽高，`elements[]` 每项
   `{ selector, label?, note?, properties }`；tokens 为空时只写 nodes，不写 token 段。
6. 交给验收：`ui_probe({ profile, expected: "<ui-spec.json>", url, run })`。
7. 可选自动完成 1–5：`node scripts/paper-to-ui-spec.mjs --file <fileId> --artboard <nodeId>
   --out ui-spec.json --max-depth 3 --url "$PAPER_MCP_URL"`（端点也可只走环境变量 `PAPER_MCP_URL`）。

字段映射：

| Paper | ui-spec | 说明 |
| --- | --- | --- |
| `node.id` | `elements[].selector` | 由画师声明 Paper node → 页面 selector 的映射并写进交接；脚本先输出 `[data-node-id="…"]` 占位，不能直接当最终 selector |
| `node.name` | `elements[].label` | 人类可读名，进报告 |
| `get_computed_styles` 的键（kebab-case，如 `font-size`） | `properties.fontSize` | 映射到 ui-spec 白名单键；白名单外属性丢弃 |
| 数值（`12` / `"12"`） | 长度属性 → `"12px"`；数值属性 → `12` | 长度统一 px，数值保持 number |
| 颜色（`#C72926` / `rgb(...)`） | `"#c72926"` / `"rgb(...)"` | 统一 #rrggbb 或 rgb() |
| `artboard.width/height` | `viewport.width/height` | dpr 默认 1；要 2x 截图时在档案设备档声明 |

截图还什么时候用：只用于渲染类兜底——字体回退 / 字形差、图片裁切、阴影、溢出、遮挡、动效终态；
这些无法从 computed styles 判定。有 Paper 时不再用「设计图」模式（不要同一轮既拿设计图做像素
比对、又把 Paper 值当契约主判据）；没有 Paper 才退回设计图或无素材模式。Paper 的 `get_screenshot`
可以当对照图，但不是主判据。

## 3B. 设计模式（无参考、明确要求自主设计）

**只有用户明确说「没有设计稿，你来设计」时才走这里。** 档案 `design.mode` 必须是 `from-scratch`
（`brief` / `styleRefs` / `outputs` 一并写清）；默认值是 `reference`，谁都不许自行改成
`from-scratch` 来「补一个设计源」——自己画一张再自己比，等于既当选手又当裁判。

什么时候用：
- 新页面/新模块没有设计稿，产品需要一个能讨论、能验收的视觉方案；
- 用户接受「先定风格 → 再按风格实现」，并接受设计包是**自产的、新的**依据（不是客户设计稿）。

先读项目风格（缺了就问，不要猜）：
1. `tokens.files` 里的 token 文件、全局样式、主题变量；
2. 现有页面里的同类组件与骨架（按钮、表格、卡片、空态、弹窗、表头）；
3. 品牌资产（logo、品牌色、字体）——**只能引用现成的，不得编造品牌色**；
4. `design.styleRefs`：用户给的参考站/截图/竞品链接，只引用可读路径或 URL。

产出物清单（全部落在 `<run>/design/`，**不写进项目源码目录**）：

| 产物 | 作用 | 谁用 |
| --- | --- | --- |
| `design.json` | 风格档案：色彩、字号阶梯、间距刻度、圆角/阴影、组件清单、`assumptions` 与取舍 | 画师、验收者 |
| `ui-spec.json` | 机器可读样式契约（selector + 属性期望值），schema 同 `schemas/ui-spec.schema.json` | 验收者 `ui_probe(expected)` |
| `mock.html` | 可截图的自包含静态 mock（单文件、内联样式、无外链、无脚本） | 画师对照实现、验收兜底 |
| `mock.png` | mock 的整屏截图，视口与 DPR 与档案 `devices[0]` 一致 | 验收者 `ui_diff` 的「设计图」 |
| `design.md` | 人读版设计说明：页面结构、状态、交互、假设与未定项 | 人、画师 |
| `paper.png`（可选） | 用 Paper 出图时的画板截图 | 验收者对照、留档 |

页面要连真实接口时，设计师另给一份**数据契约**（写进 `design.md`，或单独的 `api-requirements.json`）：
需要的字段、动作、状态（loading / empty / error / 分页 / 重试）。只写需求，**不编造接口路径与响应**；
接线者按它接接口，源头仍以档案 `api` 段为准。

Paper 可选出图，**同时满足**两条才做，否则只出 `mock.html` + `ui-spec.json` + `mock.png`：
- 用户明确同意把设计写进 Paper（写操作会产生真实文件，属于外部副作用）；
- 会话里确实有 Paper MCP 的写工具（`create_artboard` / `write_html` / `update_styles` 等）。

没同意、或写工具不可用：**不要假装出图**，也不要拿 `mock.png` 冒充「Paper 设计稿」；
在 `design.md` 与报告的「设计源」里写清「设计包（自产 mock）」。

### 3B 与 3A 的边界（写类工具）

- **3A 的禁令不变**：验收流程里，Paper 写类工具一律禁用——验收者只读，不得改设计稿、改样式、删节点。
- **3B 允许写，但只写新产物**：只在「新建设计包」这件事上写（`<run>/design/`，或用户同意的 Paper 文件），
  且必须先拿到用户同意；不改项目代码、不改已有 artboard、不删任何节点。
- 两者都不改变判定顺序：结构化契约优先，像素比对其次，渲染兜底最后。

硬边界（设计模式也不放宽）：

- **不得改项目代码**：设计师的写权限只用于 `<run>/design/`，项目页面/样式/组件/配置一律只读；
  页面改动由画师在自己的 inScope 里做。
- **不得编造品牌色/字体/字号**：取值只能来自 token、现有页面或用户给的材料；确实需要新增时，
  写进 `design.json` 的 `assumptions`，并在 `design.md` 标「待确认」，不要当成既定品牌规范。

## 4. 每轮闭环（唯一流程）

每轮固定六步，顺序不要换：**截图 → 探针 → 差异 → 判定 → 修复 → 报告**。

### Step 0 · 规则门禁（画师，必做）

先跑档案 `rules` 里 `required: true` 的命令。规则不过，不进入截图环节。
这一步是项目自己的机械检查，插件不代跑、也不替代。

### Step 1 · 截图（画师）

```json
{ "url": "<页面地址>", "profile": "<档案 id>", "run": "<runRoot>/<页面>-r1" }
```

`ui_capture` 返回 PNG 路径与像素尺寸。需要整页时加 `"fullPage": true`；
需要看单个组件时加 `"selector": "<CSS 选择器>"`。截完先自己用 `read_image` 看一眼，
明显问题自己先修一轮，减少无效验收。

### Step 2 · 探针（验收者）

- 有 ui-spec：契约模式，逐属性比对 `getComputedStyle`。

  ```json
  { "url": "<页面地址>", "expected": "<ui-spec 路径>", "profile": "<档案 id>", "run": "<runRoot>/<页面>-r1" }
  ```

  输出 `summary`（total / passed / failed / high / medium / low / selectorMisses）、
  每条 `{ property, expected, actual, delta, deltaText, severity, pass }` 与 `selectorMisses`。
- 没有 ui-spec：审计模式（省略 `expected`），检查横向溢出、硬编码颜色、字号/间距分布、
  图片缺 alt、缺可见焦点、可疑空态。

探针先跑的好处：属性级问题（颜色错、字号错、间距错）能被精确定位，
不会淹没在整屏像素差异里。

### Step 3 · 差异（验收者，有设计源才做）

```json
{ "design": "<设计图 PNG/JPEG>", "shot": "<run>/shot.png", "profile": "<档案 id>", "run": "<runRoot>/<页面>-r1" }
```

得到 `score`、`diffRatio`、`regions[]`（x/y/宽高/像素数/占比/severity）、
`sizeMismatch`、热力图 `diff.png`、左右对照 `side-by-side.png`。
同一 run 目录多次 `ui_diff` 会累积成分数曲线。
判定阈值不能由调用参数覆盖：传 `threshold` / `tolerance` 只会得到 warning，实际生效值看
`diff.json.thresholds.effective` 与 `meta.json` 的 `thresholds`；`pass` 仍按档案阈值计算。

没有 `design`、但档案配了 `styleBaseline`（PNG/JPEG）时，可只传 `{ shot, profile, run }` 做 **style-only**：
只输出 `style` 证据（`diff.json.styleOnly = true`），没有像素 `score`/`pass`。style-only 不能替代达标判定，
要判定仍须有设计源；`styleBaseline` 非法时工具会 warning 并忽略。

### Step 4 · 判定（验收者）

判定门槛见第 5 节。结论写成 `verdict` + `findings[]`，落进 report 与交接消息。

### Step 5 · 修复（画师）

只改 findings 与区域表指向的位置。修完回到 Step 1，**复用同一个 run 目录**，
这样分数曲线和多轮产物是连续的。

### Step 6 · 报告（验收者）

```json
{ "run": "<runRoot>/<页面>-r1", "profile": "<档案 id>" }
```

`ui_report` 产出 `report.md`（引用结论）与 `report.html`（交付/留档）。
合格线只从档案取；传 `threshold` 会被忽略并告警，报告的「声明阈值（已忽略）」与「阈值来源」行会写明。
`pass` 为 false 时，只退回 1~3 条最关键项，不要贴一屏。

## 4A. 接口接线阶段（接线者，仅当页面要连真实接口）

静态还原收敛后再接数据，避免数据变化干扰像素判定。顺序：

1. 队长派接线者：交接档案 `api` 段、页面入口、inScope（页面数据层目录）、测试环境与登录方式。
2. 接线者反推数据需求 → 找真实接口 → 在 inScope 内实现数据层与状态 → 产出 `<run>/api-map.json`。
3. 接口缺失、没有测试环境、登录态不可用：接线者给 `blocked` 并列缺失清单，**不要用 mock 冒充已接**。
4. 接线改动了布局时，回到 Step 1 重新截图；没改布局直接进验收。
5. 验收者按第 5 节「接口层」判定，并跑档案 `rules` 里的契约命令（如有）。

api-map 最小形状：

```json
{
  "page": "/orders",
  "env": "test",
  "entries": [
    {
      "ui": "列表分页器 · 下一页",
      "action": "click",
      "request": { "method": "GET", "path": "/api/orders", "query": ["page", "size"] },
      "response": { "list": "data.records", "total": "data.total" },
      "states": ["loading", "empty", "error", "retry"],
      "evidence": "src/api/order.js:42"
    }
  ],
  "inferred": ["status 字段取值映射待产品确认"]
}
```

## 4B. 设计阶段（设计师，仅当 `design.mode = from-scratch`）

顺序固定：**队长派设计师 → 设计师出设计包 → 用户/队长确认 → 验收者独立设计评审 → 画师按设计包实现 → 验收者按同一套设计包判定。**
设计阶段只在页面实现之前跑一次；设计评审通过后设计冻结，不要每轮重画。

1. **队长派设计师**：交接 `design` 段、页面范围、真实数据形态（条数/字段）、风格参考与 run 目录。
   没写 `from-scratch` 就不要派设计师。
2. **设计师产出设计包**（清单见 3B）：先写 `design.json` 定风格与刻度，再写 `mock.html`，
   用档案 `devices[0]` 的视口与 DPR 截 `mock.png`，最后把 mock 的实测值抽成 `ui-spec.json`，
   `design.md` 写清结构、状态与假设。
3. **用户/队长确认设计包**：一轮确认即可，不要反复改风格。确认后设计冻结——后面只改实现，不改设计包；
   要改风格必须显式回到这一步并说明原因。
4. **验收者独立设计评审（必做门）**：画师动工之前，验收者只读评审**设计包本身**，结论写成
   `<run>/review/design-review.json`（人读版 `<run>/review/design-review.md`）：
   - 清单齐全：`design.json` / `ui-spec.json` / `mock.html` / `mock.png` / `design.md`；
   - 契约可执行：`ui_probe(expected=ui-spec)` 对 `mock.html` 跑通，`selectorMisses = 0`，
     且 ui-spec 覆盖到主结构（标题、筛选、主列表/卡片、分页、状态区）；
   - 状态覆盖：loading / empty / error 有明确触发条件与视觉表现；
   - 可访问性：文本对比度、焦点可见、表单有标签、图片有 alt；
   - 品牌一致性：颜色/字号/间距来自 token 或现有页面；新增值必须在 `assumptions` 里说明，
     不得出现未声明的品牌色；
   - 数据自洽：示意数据（条数/分页/统计）前后一致，数据契约字段/动作/状态齐全；
   - 渲染兜底：`mock.png` 与 `devices[0]` 同视口、非空白、无横向溢出（`ui_probe` 审计模式或结构化校验）。
   评审 verdict 只允许 `pass` / `needs_revision` / `blocked`：`needs_revision` 回设计师改一版设计包
   （findings 只给 1~3 条关键项，改完重新评审）；`blocked` 找用户确认取舍。
   **评审不通过不得派画师**——不许边实现边改设计；评审者不得改设计包，只写评审产物。
   模型没有图像输入时，评审用结构化证据（契约/审计/像素结构），并在结论里写明
   「图像未人眼复核」；有图像输入时再看 `mock.png`。
5. **画师按设计包实现**：`mock.png` 是像素基准、`ui-spec.json` 是属性契约；selector 映射由画师声明
   （见第 7 节）。设计包是参照物，**不要把它搬进项目源码**，也不要为对上 mock 写死像素。
6. **验收者按同一套设计包判定**：
   `ui_diff({ design: "<run>/design/mock.png", shot: "<run>/shot.png" })` +
   `ui_probe({ expected: "<run>/design/ui-spec.json" })`；报告「设计源」写
   「设计包（自产 mock，见 `design.md`）」，不要写成外部设计稿或 Paper 产物。
7. **视口必须一致**：mock 与实现同设备档（同宽高、同 DPR）；不一致时 `sizeMismatch` 会让差异全是
   缩放噪声，先对齐视口再谈分数。

交接消息模板见第 7 节（队长 → 设计师、队长 → 验收者〔设计评审〕、设计师 → 画师/验收者）。

## 5. 判定口径（verdict 与 findings）

判定是最容易放水的地方，按下面的硬门槛逐条过：

| 门槛 | 要求 |
| --- | --- |
| 还原度 | `report.summary.score` ≥ 档案 `thresholds.score`；有设计源时才适用。判定阈值由代码锁死，调用参数改不了 |
| 属性层 | `probe.summary.high === 0`；`medium` 项要么修，要么逐条写「不改的理由」 |
| 选择器 | `selectorMisses` 清零；确属废弃锚点的，写明由谁、在哪一轮更新 |
| 区域层 | `regions` 里 `high` 区域逐个对照设计源：是真差异，还是字体渲染/整体位移噪音 |
| 规则层 | 档案里 `required: true` 的命令全部通过 |
| 接口层 | 页面要连真实接口时：`<run>/api-map.json` 存在、页面没有 mock 假数据冒充、loading/empty/error/分页/重试覆盖、请求入参与 api-map 一致；`api.env = prod-readonly` 时只允许 GET |
| 设计层 | `design.mode = from-scratch` 时：设计包齐全（`<run>/design/design.json`、`ui-spec.json`、`mock.png`、`design.md`，`design.md` 写清假设与未定项）；画师实现与 `mock.png` 的 `score` ≥ 档案合格线；mock 与实现同设备档（`sizeMismatch.mismatch = false`）；报告如实写「设计源 = 设计包（自产 mock）」 |
| 设计评审层 | `design.mode = from-scratch` 时：`<run>/review/design-review.json` 存在且 `verdict = pass`，评审 findings 已闭环（`needs_revision` 项有修复或写明理由）；画师不得在评审通过前动工；报告写清评审结论与「图像是否人眼复核」 |
| 模式一致性 | 报告写清「本次模式 / 设计源」；无设计源时不得声称「与设计稿一致」；设计模式下不得把自产 mock 说成客户设计稿或 Paper 出图 |

> **已知限制**：设计评审门（`<run>/review/design-review.json` 的 `verdict = pass`）是流程约束，不是代码强制。
> 插件不会阻止画师在评审通过前动工，也不会校验评审文件；队长必须在派实现前人工确认，验收者在报告里写明评审结论。

`findings[]` 每条至少包含：

```json
{
  "id": "F1",
  "severity": "high",
  "selector": ".toolbar .primary-action",
  "property": "backgroundColor",
  "expected": "#2563eb",
  "actual": "#3b82f6",
  "evidence": "probe.json → checks[2]"
}
```

- `severity`：`high` 必须修；`medium` 修或给出理由；`low` 记录即可。
- 每条 findings 必须能指向 run 目录里的具体文件与条目，不能只有一句描述。

不误报清单（出现这些先怀疑判定口径，不要直接记缺陷）：

- 不同机器字形宽度有 1px 级差异；`tolerance` 默认已吸收大部分。
- 页面整体位移（如 8px padding 变化）会产生几十条细区域——按面积合并同类项再报。
- 动画未收尾、随机数据、时间/数量变化导致的差异。
- 档案 `knownIssues` 里登记过、且产品确认过的项。
- 设计图与截图纵横比不同：`sizeMismatch.mismatch = true` 说明设备档对不上，
  先确认设计源，不要按缺陷处理。

## 6. 收敛与停滞

- **达标即停**：第 5 节门槛全过就结束，不要为了「再好看一点」继续加轮次。
- **停滞判定**：连续两轮 `score` 提升小于 0.002，或差异区域数量不降，视为停滞。
- **轮次上限**：档案 `thresholds.maxRounds`（默认 3）。到上限仍未达标就停。
- **停滞处理**：把剩余差异分成三档交人决策，不要继续盲改：
  - 必改：影响主流程或明显违反规范；
  - 可接受：字体/抗锯齿/已知渲染差异；
  - 需产品确认：设计源本身含糊、或实现与设计稿冲突。
- **每轮消息只带 1~3 条最关键项**，附文件与证据；一屏 30 条等于没提。

## 7. 角色提示词与边界

五个角色对应插件的五个预设；没有预设时，也可以由一个人按顺序扮演，但**不要自己验自己**。

### 队长（编排）

- 负责：建档案、定模式（含是否 `design.mode = from-scratch`）、派活、收敛判定、交付报告。
- 设计先行：`from-scratch` 时设计师交付后**先派验收者做设计评审**，`verdict = pass` 才派画师；
  `needs_revision` 回设计师改一版，`blocked` 找用户确认——评审通过前不派实现。
- 不负责：写页面代码、改验收口径、替设计师编风格。
- 提示词要点：明确「你的交付物是证据与结论，不是代码」；要求每轮只给 1~3 条修复项。
- 知识库：开工先读项目 README、案例索引与最近失败案例；派活时在交接里带「参考案例」路径，
  不把别的项目案例直接套用。

### 设计师（设计，仅无参考时）

- 负责：`design.mode = from-scratch` 时产出设计包（`<run>/design/` 下 `design.json` / `ui-spec.json` /
  `mock.html` / `mock.png` / `design.md`，Paper 出图时另加 `paper.png`）；先读项目风格再定稿；把假设写清；
  页面要接接口时给出数据契约（字段/动作/状态），只写需求不编造接口。
- 交回后等验收者的设计评审：`needs_revision` 时只改设计包、按 findings 改 1~3 条关键项后交回复审；
  不自行宣称设计通过，不越过评审进入实现。
- 不负责：改项目代码、改已有设计稿/artboard、判定、改阈值；要 Paper 出图得先拿用户同意。
- 提示词要点：写清「只写 `<run>/design/`」「颜色字号只能引用 token/现有页面，不得编造品牌色」
  「mock 视口与档案 `devices[0]` 一致」。
- 知识库：设计/生成前先读 `patterns/` 里相关配方与失败案例（只取教训），再读项目设计系统；
  生成后逐张对照项目设计系统做风格自检（底、占比、材质、标签字号）。

### 画师（实现）

- 负责：inScope 内的页面代码、跑项目规则、自看截图、声明 selector 映射。
- 不负责：判定、改阈值、改 knownIssues、改验收产物。
- 提示词要点：写清「只改 inScope 内的文件」「不要为对上截图写死像素」。
- 知识库：实现前读项目 README 的设计系统与 `patterns/` 里的图块/风格模板；
  偏离参考风格的取舍写进交接。

### 验收者（只读）

- 负责：跑档案 `rules` 命令做独立门禁（只跑不改）、截图、探针、差异、判定、报告。
- 设计评审（仅 `from-scratch`）：画师动工前先评设计包本身——齐全性、ui-spec 契约可执行、
  loading/empty/error、可访问性、品牌色与 assumptions、数据自洽、mock 渲染结构；
  结论写 `<run>/review/design-review.json`（`verdict` + `findings[]`），只读设计包、不改设计值。
- 不负责：改代码、改 ui-spec、改阈值、把失败项标成「已知问题」。
- 提示词要点：写清「没有证据不下结论」「不改任何项目文件」；无图像输入时用结构化证据并声明
  「图像未人眼复核」。
- 知识库：开工先读项目设计系统、失败案例与双层验收清单（结构层 + 风格层）；风格层对照
  项目 README 与失败案例，不通过要指到具体项。

### 接线者（接口对接）

- 负责：inScope 内的数据层与页面绑定、`api-map.json`、loading/empty/error/分页/重试覆盖。
- 不负责：像素、判定、后端实现、凭据落库；找不到接口就 blocked，不编造。
- 提示词要点：写清「只按档案 api 段找接口」「凭据只从环境变量读」「生产只读」。
- 知识库：开工先读项目 README 的 api 段与相关案例；接口约定以项目为准，不按别的项目套用。

### selector 映射由画师声明

ui-spec 的 selector 是**实现侧契约**。页面结构变化时：

1. 画师更新 ui-spec 里的 selector，或在交接消息里给出「selector → 实际结构」的映射说明；
2. 验收者只报 `selectorMisses`，不擅自改 selector 去凑通过；
3. 映射变更要写进本轮交接与报告备注，方便下一轮追溯。

### 交接消息模板

派活（队长 → 设计师，仅 `design.mode = from-scratch`）：

```text
页面：<页面名 / 路由>
档案：<档案 id>（design：mode=from-scratch，outputs=[spec, mock] 或含 paper）
run：<runRoot>/<页面>-r1
设计包位置：<run>/design/
风格来源：<tokens 文件 / 现有页面 / styleRefs / 品牌资产>
页面范围：<要覆盖的区块、状态（loading/empty/error）、交互>
约束：<设备档 / 不得改项目代码 / 不得编造品牌色 / 是否允许 Paper 出图>
完成判据：design.json + ui-spec.json + mock.html + mock.png + design.md 齐全
```

交回（设计师 → 画师 / 验收者）：

```text
run：<runRoot>/<页面>-r1
设计包：<run>/design/（design.json / ui-spec.json / mock.html / mock.png / design.md）
视口：<宽>×<高> @<DPR>（与档案 devices[0] 一致）
设计要点：<风格关键词；主色、字号阶梯、间距、圆角的关键取值>
假设与未定项：<design.json → assumptions；需要谁确认>
画师提示：<页面结构、组件清单、必须实现的交互与状态>
验收提示：ui_diff 用 mock.png，ui_probe 用 ui-spec.json；报告设计源写「设计包（自产 mock）」
```

派活（队长 → 验收者，设计评审门，仅 `from-scratch`）：

```text
页面：<页面名 / 路由>
档案：<档案 id>（design：mode=from-scratch）
run：<runRoot>/<页面>-r1
评审对象：<run>/design/ 设计包（design.json / ui-spec.json / mock.html / mock.png / design.md）
评审重点：齐全性 / ui-spec 对 mock.html 可执行且 selectorMisses=0 / loading-empty-error /
          可访问性 / 品牌色与 assumptions / 数据自洽 / mock 视口与无横向溢出
产物：<run>/review/design-review.json（verdict + findings，最多 3 条关键项）+ design-review.md
约束：只读设计包，不改设计值、不改 ui-spec、不进入实现
完成判据：verdict = pass | needs_revision | blocked；能指向具体文件与数值
```

交回（验收者 → 设计师 / 队长，设计评审结论）：

```text
run：<runRoot>/<页面>-r1
verdict：pass | needs_revision | blocked
findings：<id / severity / 项 / expected / actual / evidence（文件:行 或 json 路径）>
图像复核：<有图像输入：已看 mock.png | 无图像输入：未人眼复核，采用结构化证据>
下一步：<pass → 冻结设计、派画师 | needs_revision → 设计师改一版后复审 | blocked → 用户确认取舍>
```

派活（队长 → 画师 / 验收者）：

```text
页面：<页面名 / 路由>
档案：<档案 id 或 JSON 路径>
run：<runRoot>/<页面>-r1
设计源：image → <设计图路径> | mcp → <ui-spec 路径> | design → <run>/design/（mock.png + ui-spec.json） | none
范围：<允许改动的目录/文件清单；验收者写「只读」>
完成判据：<合格线 / high 清零 / 规则命令通过>
```

交回（画师 → 验收者）：

```text
轮次：r2
run：<runRoot>/<页面>-r2
设计源：image → <设计图路径>（或 mcp → <ui-spec 路径> / design → <run>/design/ / none）
本轮变更：<文件 1>（原因）、<文件 2>（原因）
已知取舍：<如果有，写清为什么>
```

「范围」必须写具体文件或目录：画师预设只带读写与 shell，不保证有文件搜索工具，
靠猜路径会白跑一轮。

派活（队长 → 接线者）：

```text
页面：<页面名 / 路由>
档案：<档案 id>（api 段：source / env / allow / authEnv）
run：<runRoot>/<页面>-r1
inScope：<数据层与页面文件清单>
接口来源：<api 目录 / OpenAPI 路径 / 抓包文件>
测试环境：<baseUrl / 登录方式 / 测试账号来源>
完成判据：api-map 生成、状态覆盖、契约命令通过（如有）
```

交回（接线者 → 验收者）：

```text
run：<runRoot>/<页面>-r1
api-map：<run>/api-map.json
本轮变更：<文件 1>（原因）、<文件 2>（原因）
复现：<起服务 / 登录 / 测试数据>
推断与缺口：<字段推断、待确认项、blocked 原因>
```

## 8. 无素材模式（没有设计图、也没有结构化设计值）

三层基线，顺序固定，不能跳层：

1. **规则层**：档案 `rules` 的 `required` 命令必须先过。
2. **基准页层**：挑「三同」基准页（同类型 → 同宽度 → 同数据量）截一张，作为参照图，
   再用 `ui_diff` 与新页面比。基准页要写进档案 `baseline.pages`。
3. **规范契约层**：用 ui-spec 写「规范硬指标」——主色、基础字号、控件高度、卡片圆角、
   间距刻度、表格密度、状态色。这些是机械可查的，比人眼可靠。

无素材模式仍然要出 `report.md` / `report.html`，并在「本次模式」写 `none`、
「设计源」写「无（规则 + 基准页 + 规范契约）」。审计探针的结论按 kind 归类，
不要把所有 `low` 都当缺陷堵在交付前。

用户要的是「你自己设计」时，走 3B 设计模式（先出设计包），不要在本节基线上加戏：
自产的样式不能既当设计源、又当实现，那等于自己送分给自己。

## 9. 报告模板

报告必须让没参与的人看懂「这次到底比了什么」。最小骨架：

```markdown
# <页面名> UI 还原验收报告

- 本次模式：有设计源（图像）/ 有设计源（结构化）/ 无素材 / 设计模式（from-scratch，自产设计包）
- 设计源：image → <设计图路径>；mcp → <ui-spec 路径>；design → <run>/design/mock.png + ui-spec.json（设计包，自产 mock）；none → 无（规则 + 基准页 + 规范契约）
- 设备档：<宽>×<高> @<DPR>
- 档案：<id>（合格线 <score>，轮次上限 <maxRounds>）
- 轮次：r<当前>（分数曲线：0.91 → 0.95 → 0.97）

## 结论

verdict：pass / needs_revision / blocked
理由：<一句话 + 关键门槛数据>

## 差异

| 区域 | 位置 | 尺寸 | severity | 说明 |
| --- | --- | --- | --- | --- |

## 属性差异

| selector | 属性 | 期望 | 实际 | 偏差 | severity |
| --- | --- | --- | --- | --- | --- |

## 必修项

1. <findings id>：<问题> → <建议修法>

## 未修 / 待确认

- <项>：<为什么可以不修 / 需要谁确认>

## 夹具声明

档案、设计源、阈值（声明值/生效值/来源）、工具版本、Node 版本、产物清单、
证据身份（会话 id / cwd / 调用时间 / design SHA-256 / shot SHA-256）
```

`report.html` 是同一份结论的单文件静态页（无脚本、无外链），用于交接与人审；
不要把 HTML 当唯一证据，`report.md` + `diff.json` + `probe.json` 才是可复核的原始数据。

## 10. 常见坑

| 坑 | 处理 |
| --- | --- |
| 设计图与截图比例不同 | `ui_diff` 会等比缩放并标 `sizeMismatch`；先确认设计图纵横比是否对应同一设备档 |
| 设计图有透明底 | 会合成白底比较；设计稿尽量导出白底 |
| DPR 2 截图与 1x 设计图混用 | 用同一设备档截图；缩放比对会处理，但别混用两套基准 |
| 页面有长连接，加载事件不触发 | 工具在 load 后等 `settleMs`；不够就传 `waitMs` |
| 选择器写错 | 契约模式会报 `selectorMisses`；审计模式可用 `selector` 限定范围 |
| 报告打不开 / 图裂 | 报告与三张图必须同目录；`ui_report` 会把外部图片复制进报告目录 |
| 沙箱里浏览器起不来 | 只跑不需要浏览器的自测；截图验收放到非受限会话 |
| 验收者只跑 rules 命令、不改代码 | 只读 fs 关闭写/改/补丁；规则不过给 `needs_revision` + 命令输出摘要（命令、退出码、关键报错） |
| 页面服务不可用 | 由画师/队长提前起好；服务不可用时给 `blocked`，不要自行改环境 |
| 为了通过把期望值改小 | 禁止。改阈值、改 ui-spec、改 knownIssues 都等于伪造结论 |
| 工具报「超出工作区」 | 设计图/截图/输出目录必须放在工作区内（建议 `<run>` 目录）；工作区外的绝对路径会被拒绝，不会写盘 |
| 想用 `threshold` / `tolerance` 参数放宽判定 | 无效：参数被忽略并告警，`pass` 仍按档案阈值算；要改合格线只能改档案 `thresholds.score` 并写明谁批准 |
| 报告里出现「声明阈值（已忽略）」 | 有人试图用调用参数覆盖阈值；以「阈值来源」和生效值为准，不要引用声明值下结论 |
| 设计评审还没 pass 就开始实现 | 工具拦不住（已知限制）；队长必须在派画师前人工确认评审 `verdict = pass` |
| 证据哈希/会话对不上 | 图被换过或不是同一会话验的；重新截图/重跑 `ui_diff`，不要把旧报告当本轮证据 |

## 11. 一句话原则

**设计师对「设计依据」负责，画师对「实现」负责，接线者对「数据来源」负责，验收者对「证据」负责；所有结论必须能落到 run 目录里的文件。**
