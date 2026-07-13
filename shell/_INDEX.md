# shell
> **重要** 本目录结构或子文件职责变化时，必须更新此文件。

## 职责
Claude Code SessionStart 与精确模型同步脚本。用户侧 fn/fc/fl 等 shell 函数现在直接由 `im2cc install-shell` 子命令写入 `~/.zshrc` / `~/.bashrc`，不再依赖文件分发。

## 文件清单
- im2cc-session-sync.sh：Claude Code SessionStart hook，覆盖 /clear、compact、resume 场景的 session 漂移同步，带结构化日志并与 daemon/observer 共用 registry 写锁。Plan 模式在当前 Claude 版本已不再漂移（2026-04-17 实测验证）。由 `im2cc install-hook` 注册到 `~/.claude/settings.json`
- im2cc-model-statusline.sh：Claude Code statusline 旁路观察器；捕获 `model.id`、拒绝已知家族 alias 并在共享写锁内更新 Session registry，安全转发 HUD / Vibe Island 链；第三方 leaf 回指时用安全 fallback 与再入上限保证有限终止。由 `im2cc install-hook` 注册
