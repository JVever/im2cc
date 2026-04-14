#!/bin/bash
# im2cc 一键安装脚本
# 用法: git clone https://github.com/JVever/im2cc.git ~/.im2cc-app && cd ~/.im2cc-app && bash install.sh

set -euo pipefail

echo "========================================="
echo "  im2cc 安装程序"
echo "  远程操控 AI coding tools"
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

AVAILABLE_TOOLS=0

if command -v claude &>/dev/null; then
  CLAUDE_VER=$(claude --version 2>/dev/null || echo "未知版本")
  ok "Claude Code CLI ($CLAUDE_VER)"
  AVAILABLE_TOOLS=$((AVAILABLE_TOOLS + 1))
else
  warn "Claude Code CLI 未安装"
  echo "   安装: https://docs.anthropic.com/en/docs/claude-code"
fi

for tool in codex gemini; do
  if command -v "$tool" &>/dev/null; then
    TOOL_VER=$("$tool" --version 2>/dev/null || echo "未知版本")
    ok "$tool CLI ($TOOL_VER)"
    AVAILABLE_TOOLS=$((AVAILABLE_TOOLS + 1))
  else
    warn "$tool CLI 未安装"
  fi
done

echo ""

if [ "$AVAILABLE_TOOLS" -eq 0 ]; then
  fail "至少需要安装一个受支持的 AI coding tool CLI（claude / codex / gemini）"
  exit 1
fi

if [ "$MISSING" -eq 1 ]; then
  fail "请先安装以上缺失的依赖，然后重新运行 bash install.sh"
  exit 1
fi

# --- 2. 安装项目 ---
echo "📦 安装依赖并编译..."
npm install --silent
npm run build
ok "项目编译完成"

# npm link（注册全局命令）
npm link --silent 2>/dev/null || sudo npm link --silent 2>/dev/null || warn "npm link 失败，可手动运行: sudo npm link"
if command -v im2cc &>/dev/null; then
  ok "im2cc 命令已注册"
else
  warn "im2cc 命令未生效，可能需要重新打开终端"
fi

# --- 3. 配置 shell 命令 ---
# shell 函数是薄包装（<20 行），所有逻辑在 im2cc CLI 中。
# 为兼容历史安装，既刷新 ~/.local/bin/im2cc-shell-functions.zsh，
# 也保留向 .zshrc/.bashrc 写入薄包装函数的能力。
SHELL_RC=""
CURRENT_SHELL="${SHELL:-}"
CURRENT_ZSH_VERSION="${ZSH_VERSION:-}"
ZSH_BIN="$(command -v zsh 2>/dev/null || true)"

if [ -n "$CURRENT_ZSH_VERSION" ] || { [ -n "$ZSH_BIN" ] && [ "$CURRENT_SHELL" = "$ZSH_BIN" ]; } || [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
fi

SHELL_FUNCS='fn()       { im2cc new "$@"; }
fn-codex() { im2cc new --tool codex "$@"; }
fn-gemini(){ im2cc new --tool gemini "$@"; }
fhelp()    { im2cc help; }
fc()       { im2cc connect "$@"; }
fl()       { im2cc list; }
fk()       { im2cc delete "$@"; }
fd()       { im2cc detach; }
fs()       { im2cc show "$@"; }
fqon()     { im2cc fqon "$@"; }
fqoff()    { im2cc fqoff "$@"; }
fqs()      { im2cc fqs "$@"; }'

mkdir -p "$HOME/.local/bin"
cp "$(cd "$(dirname "$0")" && pwd)/shell/im2cc-shell-functions.zsh" "$HOME/.local/bin/im2cc-shell-functions.zsh"
ok "已刷新 ~/.local/bin/im2cc-shell-functions.zsh"

if [ -n "$SHELL_RC" ]; then
  if grep -q "im2cc new" "$SHELL_RC" 2>/dev/null \
    && grep -q "fn-codex" "$SHELL_RC" 2>/dev/null \
    && grep -q "fn-gemini" "$SHELL_RC" 2>/dev/null \
    && grep -q "fhelp" "$SHELL_RC" 2>/dev/null \
    && grep -q "fqon" "$SHELL_RC" 2>/dev/null \
    && grep -q "fqoff" "$SHELL_RC" 2>/dev/null \
    && grep -q "fqs" "$SHELL_RC" 2>/dev/null; then
    # 新格式已存在（薄包装）
    ok "终端命令已配置 (fhelp/fn/fn-codex/fn-gemini/fc/fl/fk/fd/fs/fqon/fqoff/fqs)"
  else
    # 清理旧格式（source 外部文件的方式）
    if grep -q "im2cc" "$SHELL_RC" 2>/dev/null; then
      # Cross-platform sed in-place
      if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' '/im2cc.*shell-functions/d; /# im2cc/d; /im2cc new/d; /im2cc help/d; /im2cc connect/d; /im2cc list/d; /im2cc delete/d; /im2cc detach/d; /im2cc show/d; /im2cc fqon/d; /im2cc fqoff/d; /im2cc fqs/d; /fn-codex/d; /fn-kimi/d; /fn-gemini/d; /fhelp/d; /fqon/d; /fqoff/d; /fqs/d' "$SHELL_RC"
      else
        sed -i '/im2cc.*shell-functions/d; /# im2cc/d; /im2cc new/d; /im2cc help/d; /im2cc connect/d; /im2cc list/d; /im2cc delete/d; /im2cc detach/d; /im2cc show/d; /im2cc fqon/d; /im2cc fqoff/d; /im2cc fqs/d; /fn-codex/d; /fn-kimi/d; /fn-gemini/d; /fhelp/d; /fqon/d; /fqoff/d; /fqs/d' "$SHELL_RC"
      fi
    fi
    echo "" >> "$SHELL_RC"
    echo "# im2cc — 终端命令（薄包装，逻辑在 im2cc CLI 中）" >> "$SHELL_RC"
    echo "$SHELL_FUNCS" >> "$SHELL_RC"
    ok "终端命令已写入 $SHELL_RC"
    warn "请重新打开终端或运行: source $SHELL_RC"
  fi
else
  warn "未检测到 .zshrc 或 .bashrc，请手动添加以下内容到你的 shell 配置文件:"
  echo "$SHELL_FUNCS"
fi

# --- 4. 安装 Session 漂移同步 hook ---
HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/shell/im2cc-session-sync.sh"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

install_hook() {
  # 确保目录存在
  mkdir -p "$HOME/.claude"

  # 用 python 检查并安装/修复 hook
  # Claude Code hook 格式: {"matcher": "", "hooks": [{"type": "command", "command": "..."}]}
  python3 -c "
import json, os, sys

settings_path = '$CLAUDE_SETTINGS'
hook_cmd = '$HOOK_SCRIPT'

if os.path.exists(settings_path):
    with open(settings_path) as f:
        settings = json.load(f)
else:
    settings = {}

hooks = settings.setdefault('hooks', {})
session_hooks = hooks.get('SessionStart', [])

# 查找已有的 im2cc hook（任何格式）并清理
cleaned = []
found = False
for entry in session_hooks:
    inner = entry.get('hooks', [])
    if isinstance(inner, list) and any('im2cc-session-sync' in h.get('command', '') for h in inner):
        # 已有 im2cc hook，更新路径
        entry['hooks'] = [{'type': 'command', 'command': hook_cmd}]
        entry.setdefault('matcher', '')
        cleaned.append(entry)
        found = True
    elif entry.get('type') == 'command' and 'im2cc-session-sync' in entry.get('command', ''):
        # 旧的扁平格式，转为正确格式
        cleaned.append({'matcher': '', 'hooks': [{'type': 'command', 'command': hook_cmd}]})
        found = True
    else:
        cleaned.append(entry)

if not found:
    cleaned.append({'matcher': '', 'hooks': [{'type': 'command', 'command': hook_cmd}]})

hooks['SessionStart'] = cleaned
with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
" 2>/dev/null
  local result=$?
  if [ $result -eq 0 ]; then
    ok "Session 同步 hook 已配置"
  else
    warn "Session 同步 hook 安装失败，请手动配置"
  fi
}

install_hook

# --- 5. 完成 ---
echo ""
echo "========================================="
echo -e "${GREEN}  安装完成！${NC}"
echo "========================================="
echo ""
echo "下一步只需要从这里继续:"
echo ""
echo "  im2cc onboard"
echo ""
echo "onboard 会根据你当前的状态，继续引导你："
echo "  1. 选择并接通飞书或微信"
echo "  2. 启动守护进程"
echo "  3. 创建一个真实对话并在手机上 /fc 接入"
echo "  4. 完成开机自启动和安全加固"
echo ""
