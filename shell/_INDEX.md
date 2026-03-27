# shell
> **重要** 本目录结构或子文件职责变化时，必须更新此文件。

## 职责
Shell 层用户命令和 Claude Code hooks，安装到 `~/.local/bin/`

## 文件清单
- im2cc-shell-functions.zsh：fhelp/fn/fn-codex/fn-gemini/fc/fl/fk/fd/fs 命令实现，source 到 .zshrc
- im2cc-session-sync.sh：Claude Code SessionStart hook，覆盖 /clear、compact 场景的 session 漂移同步，带结构化日志（Plan 模式漂移由 fc "断开前同步"覆盖）
