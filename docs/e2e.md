# 黄金 E2E 与 CI

`scripts/e2e.mjs` 是 0.5.0 起的黄金链路测试：用**真实浏览器**、**file:// 静态夹具**、**无外网**
跑完「截图 → 自比差异 → 契约探针 → 报告」，并断言产物与报告硬约束。它和另外两层测试的分工：

| 层 | 命令 | 依赖浏览器 | 作用 |
| --- | --- | --- | --- |
| 核心自测 | `node scripts/selftest.mjs` | 否 | PNG/差异/契约/档案/报告纯逻辑回归 |
| 浏览器自测 | `node scripts/selftest.mjs --browser` | 是 | 本机真实浏览器链路，产物写系统临时目录 |
| 黄金 E2E | `node scripts/e2e.mjs` | 是 | CI 门禁：file:// 夹具 + 一次 launch 多视口 + 报告硬约束 |

## 1. 它断言什么

夹具固定为 `examples/static-demo/index.html`，契约固定为 `examples/static-demo/ui-spec.json`：

1. **前置**：Node.js `>=20.10.0`；夹具必须解析成 `file://` URL；契约文件存在。
2. **基线截图**：单独 `capturePage()` 启动一次浏览器截 1440×900，记录耗时，同时验证现有
   `withPage` / `capturePage` 行为没有回归。
3. **一次 launch 多任务**：`withBrowserSession(config, tasks)` 只启动一次浏览器，顺序执行：
   - 1440×900 @1x 桌面截图；
   - 1440×900 @1x 再截一次（给自比用）；
   - 390×844 @2x 移动端截图（PNG 780×1688）；
   - 契约探针（复用同一个浏览器的 launcher 跑 `runProbe`）。
   脚本用一个计数 launcher 断言**只 launch 一次**。
4. **自比 diff**：同一页面同一视口两次截图，`score` 必须严格等于 `1`，差异率为 0、无差异区域。
5. **契约探针**：`ui-spec.json` 的 19 项属性全部通过，`selectorMisses = 0`，元素数 6。
6. **产物**：`design.png` / `shot-desktop.png` / `shot-desktop-self.png` / `shot-mobile.png` /
   `solo-launch.png` / `diff.png` / `side-by-side.png` / `diff.json` / `probe.json` 全部存在且非空。
7. **报告**：`report.md` 与 `report.html` 存在，报告 `score = 1`、`pass = true`、探针失败数 0；
   HTML 至少 3 张图、没有 `<script>`、没有任何 `http(s)` 或协议相对外链、没有外链 `@import`。
8. **耗时对比**：打印「单独启动一次截图」与「一次 launch 跑 4 个任务」的耗时，并估算
   4 个任务各自启动的总耗时。只打印、不作断言，避免 CI 机器抖动导致误红。

任一断言失败，脚本以非 0 退出码结束，并打印堆栈与已写入的产物目录。

## 2. 本地跑

### 2.1 前置

```bash
cd dsh-ui-restore
npm install                    # 确保 playwright-core 可解析
```

浏览器按以下顺序自动尝试（`lib/browser.js` 的 `launchBrowser`）：

1. `config.executablePath`（如设置）；
2. `chromium` → `chrome` → `msedge`，可用环境变量覆盖顺序：

```bash
# 只尝试系统 Chrome 与 Edge（例如不想下载 Playwright Chromium）
DSH_UI_RESTORE_CHANNELS=chrome,msedge node scripts/e2e.mjs

# 或用任意 Chromium 内核二进制（优先于 channel）
DSH_UI_RESTORE_EXECUTABLE="/path/to/chrome" node scripts/e2e.mjs
```

各平台通常情况：

- **Windows / macOS**：装有 Chrome 或 Edge 即可，channel 会自动回退；
- **Linux**：建议安装 Playwright 自带 Chromium：

```bash
npx playwright-core install --with-deps chromium
```

`--with-deps` 会用系统包管理器补齐 Chromium 运行库（GitHub Actions 的 Ubuntu runner 有 sudo）。
没有 `--with-deps` 时若报缺 `.so`，改用带 `--with-deps` 的命令。
`DSH_UI_RESTORE_PLAYWRIGHT` 仍可用于指定 `playwright-core` 包目录（源码 link 安装时排查依赖用）。

### 2.2 命令

```bash
node scripts/e2e.mjs
```

默认产物目录是 `output/e2e/<时间戳>/`（每次唯一，不删除历史，`output/` 已在 `.gitignore` 中）。
自定义目录或 channel：

```bash
node scripts/e2e.mjs --out output/e2e-local
node scripts/e2e.mjs --channels chrome,msedge
```

退出码：`0` 全过；非 0 表示任一断言/浏览器启动失败。

### 2.3 预期输出（示例，耗时视机器而定）

```text
dsh-ui-restore 黄金 E2E
仓库：<repo>
夹具：file:///<repo>/examples/static-demo/index.html
契约：<repo>/examples/static-demo/ui-spec.json
产物：<repo>/output/e2e/20261128-104242
浏览器 channel 顺序：chromium → chrome → msedge

PASS  前置检查（Node 24.18.0 · file:// 夹具 · ui-spec 存在）
PASS  capturePage（单独启动，行为不变）（1440×900 @1x · 2562ms · channel=msedge）
PASS  withBrowserSession 一次 launch（4 个任务 · channel=msedge · 5514ms）
PASS  多视口截图（1440×900 @1x · 390×844 @2x）
PASS  自比 diff（score=1 · diffRatio=0 · regions=0）
PASS  契约探针（19/19 项通过 · selectorMisses=0）
PASS  产物落盘（design.png · diff.png · side-by-side.png · diff.json · probe.json）
PASS  report（score=1 · pass=true · report.md/html）
PASS  报告硬约束（3 张图 · 无 <script> · 无外链 · report.md/20782B）
PASS  产物清单（9 个文件全部存在）

耗时对比（同一台机器、同一夹具）：
- 单独启动截图：2562ms / 次（launch + 页面加载 + 截图，channel=msedge）
- session 任务 capture-desktop-1440x900：1308ms · 1440×900 @1x
- session 任务 capture-desktop-again：1206ms · 1440×900 @1x
- session 任务 capture-mobile-390x844：1330ms · 780×1688 @2x
- session 任务 probe-contract：1297ms · 19/19 项通过
- withBrowserSession：1 次 launch + 4 个任务 = 5514ms
- 若每个任务各自启动 ≈ 10248ms；本次节省 ≈ 4734ms（46%）

结果：10 PASS / 0 FAIL
产物：<repo>/output/e2e/20261128-104242
```

产物目录里可直接打开 `report.html` 检查三图对照与属性差异表。

## 3. CI

工作流：`.github/workflows/ci.yml`。触发条件：push 到 `main`/`master`、Pull Request、手动
`workflow_dispatch`；同一 ref 的旧运行会被取消。

| job | 内容 |
| --- | --- |
| `check` | `npm ci`（见下方 lockfile 说明）→ `npm run check` + `node --check scripts/e2e.mjs` → `node scripts/selftest.mjs`（核心集，无浏览器） |
| `e2e` | `npm ci` → `npx playwright-core install --with-deps chromium` → `node scripts/e2e.mjs` → 无论成败上传 `output/e2e` 为 `e2e-artifacts`（保留 7 天） |

`e2e` 依赖 `check` 通过后才会跑，失败时先看 `check` 的报错更省时间。

> **lockfile 说明**：`npm ci` 要求仓库里有 `package-lock.json`。工作流写成「有 lockfile 走
> `npm ci`，否则打印 warning 并退回 `npm install --no-audit --no-fund`」：仓库提供 lockfile
> （当前已生成）时自动走 `npm ci`，不会因为 lockfile 尚未提交而让 CI 直接失败。

CI 上浏览器选择：先 `npx playwright-core install --with-deps chromium` 安装 Playwright
Chromium（命中 `channel=chromium`）；GitHub 的 `ubuntu-latest` 通常也预装 Google Chrome，
所以即使 Chromium channel 不可用也会回退到 `channel=chrome`。若两个都失败，日志会列出
每个 channel 的错误和修复建议。

## 4. 浏览器 channel 回退与排错

`lib/browser.js` 的启动顺序是 `executablePath → channels 列表`，每个候选失败都会累积错误，
全部失败时抛出包含「已尝试」清单的错误。常见情况：

| 现象 | 处理 |
| --- | --- |
| `缺少 playwright-core` | 在包目录 `npm install`，或设置 `DSH_UI_RESTORE_PLAYWRIGHT` 指向已安装的 `playwright-core` 目录 |
| `channel=chromium` 找不到可执行文件 | `npx playwright-core install chromium`；或改用系统 `chrome` / `msedge` |
| Linux 报缺共享库 | `npx playwright-core install --with-deps chromium` |
| 想固定浏览器 | `DSH_UI_RESTORE_EXECUTABLE=/abs/path/chrome node scripts/e2e.mjs` |
| 想固定 channel 顺序 | `DSH_UI_RESTORE_CHANNELS=chrome,msedge node scripts/e2e.mjs` |

CI 失败时优先下载 `e2e-artifacts`：里面保留了截图、`diff.json`、`probe.json` 与
`report.html`，能直接判断是渲染差异、探针失败还是报告约束被破坏。

## 5. 与 `withBrowserSession` 的关系

`lib/browser.js` 新增的是**加法式** API，现有 `withPage` / `capturePage` / `runProbe` 行为不变：

```js
import { withBrowserSession } from '../lib/browser.js';

const session = await withBrowserSession(config, [
  { name: 'desktop', run: (s) => s.capture({ cwd, url, width: 1440, height: 900, path: 'shot.png' }) },
  { name: 'probe', run: (s) => runProbe({ config, cwd, url, expected: 'ui-spec.json', launcher: s.launcher }) },
]);
```

- 一次 launch，顺序执行 `tasks`；任务可以返回任意值，汇总在 `session.results[].value`；
- 每个任务结束时自动关闭它打开的浏览器上下文；任务抛错也会清理并关闭浏览器；
- `session.launcher` 可传给任何接受 `deps.launcher` 的 helper（`capturePage` / `runProbe`），
  让它们复用同一个浏览器进程；
- `session.capture(options)` 等价 `capturePage`，`session.withPage(viewport, cb)` 用于自定义页面操作。
