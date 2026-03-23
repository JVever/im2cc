# im2cc shell 命令 — 所有逻辑在 im2cc CLI 中，这里只是薄包装
# source this file in .zshrc，或由 install.sh 自动配置
#
# 命令通过 npm link 安装的 im2cc CLI 执行，
# 更新项目后 npm run build 即可生效，无需重新 source

fn()       { im2cc new "$@"; }
fc()       { im2cc connect "$@"; }
fl()       { im2cc list; }
fk()       { im2cc delete "$@"; }
fd()       { im2cc detach; }
fs()       { im2cc show "$@"; }

# 工具快捷别名
fn-codex() { im2cc new --tool codex "$@"; }
fn-kimi()  { im2cc new --tool kimi "$@"; }
fn-gemini(){ im2cc new --tool gemini "$@"; }
fn-cline() { im2cc new --tool cline "$@"; }
