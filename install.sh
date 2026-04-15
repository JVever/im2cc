#!/bin/bash
# im2cc — 开发者 bootstrap 脚本
#
# 普通用户请使用：npm i -g im2cc
#
# 这个脚本仅给从源码 clone 的贡献者用：
#   git clone https://github.com/JVever/im2cc.git
#   cd im2cc
#   bash install.sh
#
# 跑完之后 npm 全局 im2cc 命令会指向这份 checkout（而非 npm 分发版）。

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; }

echo "im2cc — 开发者 bootstrap"
echo ""

# --- 检查 Node.js ---
if ! command -v node &>/dev/null; then
  fail "Node.js 未安装（需要 >= 20）"
  echo "   安装: https://nodejs.org/ 或 brew install node"
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js $NODE_VER（需要 >= 20）"
  exit 1
fi
ok "Node.js $NODE_VER"

# --- 安装 + 编译 + 链接 ---
echo "📦 安装依赖..."
npm install --silent

echo "🔨 编译 TypeScript..."
npm run build

echo "🔗 链接全局命令..."
if npm link --silent 2>/dev/null; then
  :
elif sudo npm link --silent 2>/dev/null; then
  :
else
  warn "npm link 失败，请手动运行: sudo npm link"
fi

if command -v im2cc &>/dev/null; then
  ok "im2cc 命令已注册到 $(command -v im2cc)"
else
  warn "im2cc 命令未生效，可能需要重新打开终端"
fi

# --- 下一步 ---
echo ""
echo "下一步："
echo "  im2cc install-shell   # 写入 fn/fc/fl 等终端命令到 ~/.zshrc"
echo "  im2cc install-hook    # 写入 Claude Code SessionStart hook"
echo "  im2cc onboard         # 进入首次引导（选 IM、启动 daemon、首次会话）"
echo ""
echo "想撤销本地 link、回到 npm 分发版："
echo "  npm unlink -g im2cc && npm i -g im2cc"
