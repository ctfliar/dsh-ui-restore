# dsh-ui-restore 安全红线

本项目的全局安全规则见 `~/.dsh/AGENTS.md`，以下为项目内必须额外遵守的条款。

## 禁止事项

- **禁止使用 `$home` / `$HOME` 作为变量名**。PowerShell 变量名大小写不敏感，`$home` 是只读的用户目录变量；赋值失败不会终止脚本，后续命令会作用在真实用户目录上。
- **禁止对用户目录、真实 DSH home 执行任何删除/移动**：
  - `$env:USERPROFILE`、`~`、`C:\Users\*`
  - `~/.dsh`、`~/.ssh`、`~/.claude`、`~/.codex`、`~/.config`
- **禁止代理自动执行递归删除**：`Remove-Item -Recurse`、`rm -rf`、`rd /s`、`rmdir /s`、`del /s`。
  必须先打印目标绝对路径，校验在 `$env:TEMP\` 唯一目录或当前工作区内，并取得用户对本次操作的明确确认。

## 验证 DSH home 的正确做法

- 使用 `$env:TEMP\dsh-ui-restore-verify-<guid>` 作为 `$env:DSH_HOME`；
- 不得触碰真实 `~/.dsh`；
- 所有 PowerShell 脚本开头必须：

  ```powershell
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  ```

- 清理验证目录前，必须用 `[IO.Path]::GetFullPath` 解析并校验前缀；使用 `-LiteralPath`，不使用通配符。

## 角色约束

- `ui-restore-verifier`（qa）只做截图、像素差异、样式探针和验收判定，**不得做递归删除**；需要清理临时目录时，由队长向用户确认后执行。
- `ui-restore-designer` 只写 `<run>/design` 产物，不得删除项目或用户目录。
- 任何角色发现任务要求删除工作区/`$env:TEMP` 之外的路径，必须停止并报告。

## 事故参考

2026-11-25，qa 子代理执行 `$home = Join-Path $env:TEMP ...; Remove-Item -Recurse -Force $home`，因 `$home` 实际指向 `C:\Users\23051`，删除了 `~/.dsh` 的 sessions/profiles/settings/credentials，并波及 `.cache`、`.codex`、`.config`、`.herdr`。该事故的根因和修复见仓库上级目录的 `故障报告-DSH数据目录被误删-2026-11-25.md` 与 `dsh-delete-incident-2026-11-25-stderr.log`。
