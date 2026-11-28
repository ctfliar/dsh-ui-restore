# 项目档案（profile）字段说明

项目档案是一份**零依赖 JSON**：它只描述「这次还原验收的夹具」——设备档、合格线、
规则命令、设计源、设计模式与设计简报、基准页、已知问题。插件只读它，不执行里面的任何命令，也不连接任何服务。

放置位置与查找顺序：

1. 工具参数 `profile` 像路径（含 `/`、`\`，或以 `.json` 结尾）→ 直接按该路径读；
2. `<工作区>/<profileDir>/<id>.json`，默认 `profileDir = ui-restore-profiles`
   （项目本地档案，优先）；
3. `<插件目录>/profiles/<id>.json`（插件内置档案，作为兜底与示例）。

约定：用 id 查找时，**文件名必须等于 id**（`<id>.json`）。

## 1. 最小档案

```json
{ "id": "minimal" }
```

其余字段全部取默认值。适合先跑通链路，再逐项补齐。

## 2. 完整字段

```json
{
  "id": "example-app",
  "label": "示例应用",
  "baseUrl": "http://localhost:<port>",
  "devices": [
    { "id": "desktop", "width": 1440, "height": 900, "dpr": 1 },
    { "id": "mobile", "width": 375, "height": 812, "dpr": 2 }
  ],
  "thresholds": { "score": 0.95, "maxRounds": 3 },
  "rules": [
    { "cwd": ".", "command": "<项目自己的校验命令>", "required": true }
  ],
  "tokens": { "files": ["src/styles/tokens.css"], "prefix": "--" },
  "baseline": { "pages": ["src/views/list/index.vue"] },
  "designSource": {
    "kind": "image",
    "artboard": "列表页 / 桌面档",
    "path": "design/list.png",
    "note": "自由备注"
  },
  "design": {
    "mode": "reference",
    "brief": "订单列表页：运营按状态筛选并批量发货",
    "styleRefs": ["src/views/order/list.vue", "src/components/ui/Table.vue"],
    "outputs": ["spec", "mock"]
  },
  "styleBaseline": "design/style-baseline.png",
  "api": {
    "source": "project",
    "env": "test",
    "enabled": true,
    "allow": ["http://127.0.0.1:8080"],
    "authEnv": "APP_TOKEN"
  },
  "knownIssues": ["低分辨率下分页器换行（产品已确认，不记缺陷）"],
  "notes": "自由文本"
}
```

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 文件名（或 `default`） | 档案标识；用 id 查找时须与文件名一致 |
| `label` | string | 等于 `id` | 展示名，进报告夹具声明 |
| `baseUrl` | string | `""` | 页面地址前缀，供人和模型拼 URL；插件不访问它 |
| `devices` | array | `[{ id: "desktop", width: 1440, height: 900, dpr: 1 }]` | 设备档列表；**`devices[0]` 是截图/探针的缺省视口** |
| `devices[].id` | string | `device-<序号>` | 设备档名字 |
| `devices[].width` / `height` | number | 1440 / 900 | CSS 像素视口 |
| `devices[].dpr` | number | `1` | 设备像素比；移动端常用 2 |
| `thresholds.score` | number ∈ (0,1] | `0.95` | 还原度合格线；`ui_diff` 默认阈值 = `1 - score` |
| `thresholds.maxRounds` | integer ≥ 1 | `3` | 允许的最大轮次（由编排者执行，插件只透出） |
| `rules` | array | `[]` | 项目自己的校验命令；插件**不执行**，只进报告夹具声明 |
| `rules[].cwd` | string | `"."` | 相对工作区的执行目录 |
| `rules[].command` | string | — | 命令文本；空字符串会被丢弃 |
| `rules[].required` | boolean | `false` | 是否必过门禁（由画师执行） |
| `tokens.files` | string[] | `[]` | 设计 token 来源文件（文字引用） |
| `tokens.prefix` | string | `"--"` | token 前缀，如 `--` 或 `$` |
| `baseline.pages` | string[] | `[]` | 无设计源时的「三同」基准页（文件路径或 URL） |
| `designSource.kind` | enum | `"none"` | `none` / `image` / `mcp`；**非法值直接报错** |
| `designSource.mcpServer` | string | — | 设计工具名称，仅文字引用 |
| `designSource.artboard` | string | — | 画板名，仅文字引用 |
| `designSource.path` | string | — | 设计图或 ui-spec 的相对路径，仅文字引用 |
| `designSource.note` | string | — | 自由备注 |
| `design.mode` | enum | `"reference"` | `reference` / `from-scratch`；`from-scratch` = 无参考、由设计师自主设计页面。**非法值告警并退回 `reference`** |
| `design.brief` | string | `""` | 设计简报：目标用户、页面要解决的问题、必须包含的模块 |
| `design.styleRefs` | string[] | `[]` | 项目里可查的风格参照（同类页面路径、组件、截图文件名）；非数组告警并忽略 |
| `design.outputs` | enum[] | `["spec","mock"]` | `spec` / `mock` / `paper`；非法值被过滤，空数组或非数组退回 `spec` + `mock`；`paper` 需用户同意 |
| `styleBaseline` | string | `""` | 风格基线图片路径（相对工作区；PNG/JPEG）。`ui_diff` **未传 `design`** 时用它算风格指标（style-only），不做像素 pass 判定；路径非法/不存在时告警并忽略 |
| `api.source` | enum | `"none"` | `none` / `project` / `openapi` / `capture`；非法值告警并退回 `none` |
| `api.env` | enum | `"test"` | `test` / `prod-readonly`；`prod-readonly` 时接线者只允许 GET |
| `api.enabled` | boolean | `false` | 是否允许接线者访问真实接口；默认关，避免误连生产 |
| `api.allow` | string[] | `[]` | 允许访问的 host / path 前缀白名单（如 `http://127.0.0.1:8080`） |
| `api.authEnv` | string | `""` | 凭据所在的环境变量名；**只写名字，不写值** |
| `knownIssues` | string[] | `[]` | 产品确认过、不计入缺陷的项；不要自己加 |
| `notes` | string | `""` | 自由文本，进报告 |

## 3. 校验与容错

- 未知顶层字段：只**告警**（写进工具返回的警告里），不报错——方便先试后改。
- 类型不对的子对象（如 `tokens` 写成数组）：告警并按默认值处理。
- `designSource.kind` 写错：**直接报错**并列出允许值——设计源决定验收形态，不能猜。
- `design.mode` 写错：只**告警**并退回 `reference`（先按有参考处理，不阻断开工）；`design.styleRefs`
  非数组时告警并忽略；`design.outputs` 非数组或过滤后为空时告警并退回默认 `spec` + `mock`。
- `api.source` / `api.env` 写错：只**告警**并退回安全缺省（`none` / `test`）；`api.allow` 非数组时告警并忽略。
- `styleBaseline` 非字符串、过长或指向工作区外/不存在的文件：只**告警**并忽略；没有 `design` 且
  `styleBaseline` 不可用时，`ui_diff` 报清晰错误，不会静默产出结论。
- 数值兜底：非正数、非数字的宽高/DPR/合格线会退回默认值。
- `knownIssues` 支持字符串数组；对象元素会尝试取 `text` / `issue` / `id`。
- 档案解析结果会写进 run 的 `meta.json` 与报告「夹具声明」，便于复核当时用的是哪份档案。

## 4. 取值怎么定

- **设备档**：取项目的真实主档，不要为了「看起来更好」调窄视口。PC 桌面档 + 移动端主档
  各一份通常够用；低分回检档可以放进 `devices[1]`，截图时显式传 `width` / `height`。
- **合格线**：有产品约定就按约定；没有就用 0.95。设计源质量差（截图压缩、字体不同）时，
  宁可调高插件配置里的 `tolerance`（不是工具参数，工具参数会被忽略），也不要压低合格线。
- **规则命令**：只写真正会阻断交付的检查。会把工作区改脏的命令（自动修复、格式化）
  不要写成 `required: true`。
- **基准页**：三同原则——同类型 → 同宽度 → 同数据量。不同数据量的页面不能互比。
- **knownIssues**：只写产品确认过的。写进去等于放行，别拿来凑合格。
- **design 段**：只有用户明确要求「自主设计一个页面」且确实没有 Paper 画板 / 设计图 / 参考页时才用
  `from-scratch`；此时队长先派设计师（ui-restore-designer）产出设计包（design.json / ui-spec /
  mock.png / design.md），画师再按包实现。`brief` 写清目标用户与页面目标；`styleRefs` 只写项目里
  可查的风格参照，不要写外部链接；`outputs` 默认 `spec` + `mock`，`paper` 需要用户明确同意且会话里
  有 Paper 写工具才加。
- **api 段**：只填真实存在的来源与环境。`enabled` 默认关；打开前先确认测试环境、登录方式和
  凭据环境变量，`allow` 尽量收窄到具体 host。生产只允许 `prod-readonly`（接线者只发 GET）。
  接口找不到就让它 `blocked`，不要用 mock 冒充已接。

## 5. 内置示例

| 文件 | 用途 |
| --- | --- |
| `minimal.json` | 只填 `id`，用来看默认值 |
| `example-static.json` | 通用模板：静态页面、图像设计源，复制后按项目补齐 |
| `static-demo.json` | 与插件自带静态夹具配套的完整示例（可跑通截图 + 差异 + 报告） |
| `lilishop-admin.json` | 真实 PC 管理后台取值素材（路径、命令、设备档、已知冲突） |
| `lilishop-h5.json` | 真实移动端 H5 取值素材（rpx、DPR 2、构建门禁、已知冲突） |

> 带项目名的示例是**取值素材**，不是通用约定：复制成 `<你的 id>.json` 后按当前代码复核。
