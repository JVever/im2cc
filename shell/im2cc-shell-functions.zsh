# im2cc shell functions — 飞书远程对话管理
# source this file in .zshrc
#
# fn <name> [path]  — 创建新对话
# fc [name]         — 接入已有对话
# fl                — 列出所有对话
# fk <name>         — 终止对话
# fd                — 从当前对话中断开（detach）
# fs [name]         — 查看对话状态

_IM2CC_REGISTRY="$HOME/.im2cc/data/registry.json"
_IM2CC_TMUX_PREFIX="im2cc-"

# --- 内部工具 ---

_im2cc_ensure_registry() {
  mkdir -p "$(dirname "$_IM2CC_REGISTRY")"
  [[ -f "$_IM2CC_REGISTRY" ]] || echo '{}' > "$_IM2CC_REGISTRY"
}

_im2cc_read_session() {
  _im2cc_ensure_registry
  python3 -c "
import json, sys
reg = json.load(open('$_IM2CC_REGISTRY'))
name = '$1'
if name in reg:
    s = reg[name]
    print(f\"{s['sessionId']}|{s['cwd']}\")
else:
    sys.exit(1)
" 2>/dev/null
}

_im2cc_register() {
  local name="$1" session_id="$2" cwd="$3"
  _im2cc_ensure_registry
  python3 -c "
import json
from datetime import datetime
reg = json.load(open('$_IM2CC_REGISTRY'))
reg['$name'] = {
    'sessionId': '$session_id',
    'cwd': '$cwd',
    'createdAt': datetime.now().isoformat(),
    'lastUsedAt': datetime.now().isoformat()
}
json.dump(reg, open('$_IM2CC_REGISTRY', 'w'), indent=2)
"
}

_im2cc_remove() {
  local name="$1"
  _im2cc_ensure_registry
  python3 -c "
import json
reg = json.load(open('$_IM2CC_REGISTRY'))
reg.pop('$name', None)
json.dump(reg, open('$_IM2CC_REGISTRY', 'w'), indent=2)
"
}

_im2cc_connect() {
  local target="$1"
  if [[ -n "$TMUX" ]]; then
    tmux switch-client -t "$target"
  else
    tmux attach -dt "$target"
  fi
}

# --- 用户命令 ---

# fn <name> [path] — 创建新对话
fn() {
  local name="${1:?用法: fn <名称> [路径]}"
  local dir="${2:-$(pwd)}"

  # 展开 ~
  dir="${dir/#\~/$HOME}"
  # 解析为绝对路径
  dir="$(cd "$dir" 2>/dev/null && pwd)" || { echo "❌ 路径不存在: $2"; return 1; }

  # 检查名称是否已存在
  if _im2cc_read_session "$name" >/dev/null 2>&1; then
    echo "\"$name\" 已存在。用 fc $name 接入，或 fk $name 先删除。"
    return 1
  fi

  # 同名 tmux session 冲突处理
  local tmux_name="${_IM2CC_TMUX_PREFIX}${name}"
  if tmux has-session -t "$tmux_name" 2>/dev/null; then
    echo "tmux 会话 $tmux_name 已存在，先终止..."
    tmux kill-session -t "$tmux_name"
  fi

  # 生成 UUID
  local session_id
  session_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"

  # 注册
  _im2cc_register "$name" "$session_id" "$dir"

  # 在 tmux 中启动 Claude Code（首次用 --session-id 创建 session）
  tmux new-session -d -s "$tmux_name" -c "$dir" \
    "claude --session-id $session_id --dangerously-skip-permissions --name 'im2cc:${name}'"

  echo "✅ 创建对话 \"$name\" → $(basename "$dir")"
  echo "   飞书: /attach $name"

  _im2cc_connect "$tmux_name"
}

# fc [name] — 接入已有对话
fc() {
  if [[ -z "$1" ]]; then
    # 无参数：列出对话或自动接入唯一对话
    _im2cc_ensure_registry
    local names
    names=($(python3 -c "
import json
reg = json.load(open('$_IM2CC_REGISTRY'))
for name in sorted(reg.keys()):
    print(name)
" 2>/dev/null))

    if [[ ${#names[@]} -eq 0 ]]; then
      echo "没有已注册的对话。用 fn <名称> 创建。"
      return 1
    elif [[ ${#names[@]} -eq 1 ]]; then
      echo "接入: ${names[1]}"
      fc "${names[1]}"
      return
    else
      echo "已注册的对话："
      echo "────────────────────────────"
      fl
      echo "────────────────────────────"
      echo -n "输入名称: "
      read -r chosen
      [[ -n "$chosen" ]] && fc "$chosen"
      return
    fi
  fi

  local name="$1"
  local info
  info="$(_im2cc_read_session "$name")" || { echo "❌ 未找到 \"$name\"。用 fl 查看列表。"; return 1; }

  local session_id="${info%%|*}"
  local cwd="${info##*|}"
  local tmux_name="${_IM2CC_TMUX_PREFIX}${name}"

  # 如果 tmux session 已存在，直接 attach
  if tmux has-session -t "$tmux_name" 2>/dev/null; then
    echo "接入 \"$name\" (活跃)"
    _im2cc_connect "$tmux_name"
    return
  fi

  # tmux session 不存在，用 --resume 重新打开
  echo "恢复 \"$name\" → $(basename "$cwd")"
  tmux new-session -d -s "$tmux_name" -c "$cwd" \
    "claude --resume $session_id --dangerously-skip-permissions --name 'im2cc:${name}'"

  _im2cc_connect "$tmux_name"
}

# fl — 列出所有已注册对话
fl() {
  _im2cc_ensure_registry
  python3 -c "
import json, os
reg = json.load(open('$_IM2CC_REGISTRY'))
if not reg:
    print('没有已注册的对话。用 fn <名称> 创建。')
else:
    for name, data in sorted(reg.items()):
        cwd = data.get('cwd', '')
        proj = os.path.basename(cwd)
        sid = data.get('sessionId', '')[:8]
        # 检查 tmux 状态
        import subprocess
        tmux_name = '${_IM2CC_TMUX_PREFIX}' + name
        alive = subprocess.run(['tmux', 'has-session', '-t', tmux_name],
                               capture_output=True).returncode == 0
        status = '🟢 活跃' if alive else '⬤ 休眠'
        print(f'  {status}  {name}  ({proj})  [{sid}]')
" 2>/dev/null
}

# fk <name> — 终止对话
fk() {
  local name="${1:?用法: fk <名称>}"

  # 终止 tmux session
  local tmux_name="${_IM2CC_TMUX_PREFIX}${name}"
  if tmux has-session -t "$tmux_name" 2>/dev/null; then
    tmux kill-session -t "$tmux_name"
    echo "✅ 已终止 tmux 会话"
  fi

  # 从注册表删除
  if _im2cc_read_session "$name" >/dev/null 2>&1; then
    local info="$(_im2cc_read_session "$name")"
    local session_id="${info%%|*}"
    _im2cc_remove "$name"
    echo "✅ 已删除 \"$name\""
    echo "   如需恢复: claude --resume $session_id"
  else
    echo "注册表中未找到 \"$name\""
  fi
}

# fd — 从当前 tmux 会话断开
fd() {
  tmux detach 2>/dev/null || echo "不在 tmux 会话中"
}

# fs [name] — 查看对话状态
fs() {
  if [[ -z "$1" ]]; then
    fl
    return
  fi

  local name="$1"
  local info
  info="$(_im2cc_read_session "$name")" || { echo "未找到 \"$name\""; return 1; }

  local session_id="${info%%|*}"
  local cwd="${info##*|}"
  local tmux_name="${_IM2CC_TMUX_PREFIX}${name}"

  echo "📊 $name"
  echo "  📁 $(basename "$cwd") ($cwd)"
  echo "  🔑 $session_id"

  if tmux has-session -t "$tmux_name" 2>/dev/null; then
    echo "  🟢 tmux: 活跃"
  else
    echo "  ⬤ tmux: 休眠"
  fi

  echo ""
  echo "  打开: fc $name"
  echo "  飞书: /attach $name"
  echo "  终止: fk $name"
}
