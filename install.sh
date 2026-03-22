#!/bin/bash
# im2cc 一键安装脚本
# 用法: git clone ... && cd im2cc && bash install.sh

set -e

echo "========================================="
echo "  im2cc 安装程序"
echo "  IM to Claude Code 远程操控工具"
echo "========================================="
echo ""

# --- 颜色 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; }

# --- 1. 检查前置依赖 ---
echo "📋 检查前置依赖..."
echo ""

MISSING=0

# Node.js
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "Node.js $NODE_VER"
  else
    fail "Node.js $NODE_VER（需要 >= 20）"
    echo "   安装: https://nodejs.org/"
    MISSING=1
  fi
else
  fail "Node.js 未安装"
  echo "   安装: https://nodejs.org/ 或 brew install node"
  MISSING=1
fi

# tmux
if command -v tmux &>/dev/null; then
  ok "tmux $(tmux -V | awk '{print $2}')"
else
  fail "tmux 未安装"
  echo "   安装: brew install tmux (macOS) 或 apt install tmux (Linux)"
  MISSING=1
fi

# Claude Code CLI
if command -v claude &>/dev/null; then
  CLAUDE_VER=$(claude --version 2>/dev/null || echo "未知版本")
  ok "Claude Code CLI ($CLAUDE_VER)"
else
  fail "Claude Code CLI 未安装"
  echo "   安装: https://docs.anthropic.com/en/docs/claude-code"
  MISSING=1
fi

echo ""

if [ "$MISSING" -eq 1 ]; then
  fail "请先安装以上缺失的依赖，然后重新运行 bash install.sh"
  exit 1
fi

# --- 2. 安装项目 ---
echo "📦 安装依赖并编译..."
npm install --silent 2>&1 | tail -1
npm run build 2>&1 | tail -1
ok "项目编译完成"

# npm link（注册全局命令）
npm link --silent 2>/dev/null || sudo npm link --silent 2>/dev/null || warn "npm link 失败，可手动运行: sudo npm link"
if command -v im2cc &>/dev/null; then
  ok "im2cc 命令已注册"
else
  warn "im2cc 命令未生效，可能需要重新打开终端"
fi

# --- 3. 配置 shell 命令 ---
SHELL_SCRIPT="$(cd "$(dirname "$0")" && pwd)/shell/im2cc-shell-functions.zsh"
SHELL_RC=""

if [ -n "$ZSH_VERSION" ] || [ "$SHELL" = "$(which zsh)" ] || [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
fi

if [ -n "$SHELL_RC" ]; then
  if grep -q "im2cc-shell-functions" "$SHELL_RC" 2>/dev/null; then
    ok "终端命令已配置 (fn/fc/fl/fk/fd/fs)"
  else
    echo "" >> "$SHELL_RC"
    echo "# im2cc — 终端命令 (fn/fc/fl/fk/fd/fs)" >> "$SHELL_RC"
    echo "source \"$SHELL_SCRIPT\"" >> "$SHELL_RC"
    ok "终端命令已添加到 $SHELL_RC"
    warn "请重新打开终端或运行: source $SHELL_RC"
  fi
else
  warn "未检测到 .zshrc 或 .bashrc，请手动添加:"
  echo "   source \"$SHELL_SCRIPT\""
fi

# --- 4. 安装 Session 漂移同步 hook ---
HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/shell/im2cc-session-sync.sh"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

install_hook() {
  # 确保目录存在
  mkdir -p "$HOME/.claude"

  if [ -f "$CLAUDE_SETTINGS" ]; then
    # 检查是否已安装
    if grep -q "im2cc-session-sync" "$CLAUDE_SETTINGS" 2>/dev/null; then
      ok "Session 同步 hook 已配置"
      return
    fi

    # 已有 settings.json，用 python 安全地合并 hook
    python3 -c "
import json, sys

settings_path = '$CLAUDE_SETTINGS'
hook_cmd = '$HOOK_SCRIPT'

with open(settings_path) as f:
    settings = json.load(f)

hooks = settings.setdefault('hooks', {})
session_hooks = hooks.setdefault('SessionStart', [])

# 检查是否已存在
for h in session_hooks:
    if 'im2cc-session-sync' in h.get('command', ''):
        sys.exit(0)

session_hooks.append({
    'type': 'command',
    'command': hook_cmd
})

with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
" 2>/dev/null
    ok "Session 同步 hook 已安装"
  else
    # 没有 settings.json，创建一个
    python3 -c "
import json
settings = {
    'hooks': {
        'SessionStart': [{
            'type': 'command',
            'command': '$HOOK_SCRIPT'
        }]
    }
}
with open('$CLAUDE_SETTINGS', 'w') as f:
    json.dump(settings, f, indent=2)
" 2>/dev/null
    ok "Session 同步 hook 已安装（新建 settings.json）"
  fi
}

install_hook

# --- 5. 完成 ---
echo ""
echo "========================================="
echo -e "${GREEN}  安装完成！${NC}"
echo "========================================="
echo ""
echo "接下来，根据你要使用的 IM 进行配置:"
echo ""
echo "  📱 飞书:"
echo "     im2cc setup          # 输入飞书 App 凭证"
echo "     im2cc start          # 启动守护进程"
echo ""
echo "  💬 微信:"
echo "     im2cc wechat login   # 扫码绑定微信 ClawBot"
echo "     im2cc start          # 启动守护进程"
echo ""
echo "  🔍 环境检查:"
echo "     im2cc doctor         # 查看完整状态"
echo ""
