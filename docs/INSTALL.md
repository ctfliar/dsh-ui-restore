# 安装 dsh-ui-restore

本插件是一个 DeepSeek Harness（DSH）bundle：装好后提供 4 个 Host 工具、1 个自动注册的技能
（`ui-restore`）和 5 个 Agent 预设（队长 / 设计 / 画师 / 接线 / 验收）。本文按「前置条件 → 安装 → 自检 → 升级/卸载 → 排错」走。

## 1. 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DeepSeek Harness | `engines.dsh`：`>=0.2.2-rc.5 \|\| >=0.3.0-rc.1` | 更低版本会在安装前被 `plugin_manager` 拒绝，避免装出半坏状态 |
| Node.js | `>=20.10.0` | 插件用 ESM、内置 `fetch` 与 `node:zlib` |
| 浏览器 | Playwright Chromium / 系统 Chrome / Edge 任一 | 用于 `ui_capture` / `ui_probe`；也可用 `executablePath` 指定任意 Chromium 内核 |
| pnpm（可选） | 仅「源码 link 安装」需要 | 直接 `dsh plugin add` 或 Plugins GUI 安装不需要 |
| Git（可选） | 仅从源码安装/升级需要 | 从 npm 安装不需要 |

## 2. 三条安装路径

### 路径 A：Plugins GUI

在 DSH 的 **Plugins** 面板搜索/安装 `dsh-ui-restore`（或从本地目录安装 bundle）。安装后按提示
重开一个会话，让 Host 行、技能注册与预设生效。

### 路径 B：命令行（npm）

```bash
dsh plugin --profile <profile> add dsh-ui-restore
```

`<profile>` 是你要装进的 profile（例如 `web`）。安装完成后重开会话。
需要升级时重复同一命令并带 `@latest`；卸载用 `dsh plugin --profile <profile> remove dsh-ui-restore`。

### 路径 C：源码 / link 安装

适合本地改代码联调：

```bash
# 1) 准备源码目录（本仓库构建区或已发布仓库均可）
git clone <dsh-ui-restore 仓库> dsh-ui-restore

# 2) 让插件自己的依赖（playwright-core）可解析
cd dsh-ui-restore
npm install

# 3) 装进 profile（本地目录安装；也可用 DSH 内的 plugin_manager install_bundle）
dsh plugin --profile <profile> add <dsh-ui-restore 的绝对路径>
```

**为什么第 2 步不能省**：插件通过 `playwright-core` 起浏览器，它按以下顺序解析：
包内 `node_modules` → `DSH_UI_RESTORE_PLAYWRIGHT` → `DSH_PROFILE_DIR/node_modules`
→ `DSH_INSTALL_DIR/node_modules`。源码 link 时包内可能没有 `node_modules`，先 `npm install`
（或把 `DSH_UI_RESTORE_PLAYWRIGHT` 指向一个已安装的 playwright-core）再装。

## 3. 安装后自检

重开一个会话，逐项确认：

1. **工具列表**：能看到 `ui_capture`、`ui_diff`、`ui_probe`、`ui_report` 四个工具；
2. **技能目录**：能发现 `ui-restore`（插件加载时把包内 `skills/ui-restore/SKILL.md` 注册成
   runtime skill，不需要手工拷贝）；
3. **预设**：会话预设列表里有「UI 还原-队长」（`ui-restore`）、「UI 还原-设计」
   （`ui-restore-designer`）、「UI 还原-画师」（`ui-restore-painter`）、「UI 还原-接线」
   （`ui-restore-integrator`）、「UI 还原-验收」（`ui-restore-verifier`）五个。

本机快速验证（不依赖 DSH 会话，也不需要浏览器）：

```bash
cd dsh-ui-restore
node scripts/selftest.mjs        # 核心集，0 FAIL 即安装包完整
node --check lib/index.js        # 语法自检
```

## 4. 升级与卸载

```bash
# 升级到最新 npm 版本
dsh plugin --profile <profile> add dsh-ui-restore@latest

# 卸载
dsh plugin --profile <profile> remove dsh-ui-restore
```

卸载只移除 bundle 行与技能注册；已经生成的 run 目录、报告、项目档案不会被删除，需要时手工清理。

## 5. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 安装被拒，提示 `engines` / DSH 版本不满足 | 当前 DSH 不在 `>=0.2.2-rc.5 \|\| >=0.3.0-rc.1` 内 | 升级 DSH，或在本插件发布说明里确认已实测的新 minor 预发布后追加 clause |
| `无法启动浏览器` / `spawn EPERM` | 没有 Chromium 内核，或沙箱禁止起子进程 | 装 Chrome/Edge，或 `npx playwright install chromium`；受限沙箱里只能跑核心集自测 |
| `缺少 playwright-core` | 源码 link 安装时没装依赖 | 在插件目录 `npm install`，或设 `DSH_UI_RESTORE_PLAYWRIGHT` 指向已安装的 playwright-core |
| 已经装好 `playwright-core`，`ui_capture` / `ui_probe` 仍报「缺少 playwright-core」 | 正在运行的 DSH 宿主进程不会重新加载依赖（进程内模块解析已缓存失败），新装的包不会对当前进程生效 | 重启 DSH 后再验证；重启前可在非受限 shell 的全新 node 进程里跑 `npm run selftest:browser` 确认依赖与浏览器本身可用 |
| 源码安装时 `pnpm` 缺失 | 部分 DSH 安装流程用 pnpm | 安装 pnpm（`npm i -g pnpm`），或改用路径 A/B（npm/`dsh plugin add`） |
| 技能目录没有 `ui-restore` | 组合里没有 skills service，或没重开会话 | 先重开会话；精简组合若没有 `@deepseek-ai/dsh-skill`，把 `skills/ui-restore/SKILL.md` 放进项目 `.dsh/skills` 手工兜底 |
| 预设列表不全 | patch 没生效 / 被更高优先级层覆盖 | 用 `plugin_manager` 查看该 bundle 行的 `fiberPhase`，确认没有被 override；重装 bundle |
| 工具在，但队长预设里没有 subagent | 当前组合没有 `spawn` 提供方 | 换用带 subagent 的基线/Web 组合，或直接用默认预设按 SKILL 串行跑 |
