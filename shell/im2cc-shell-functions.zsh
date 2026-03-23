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
    tool = s.get('tool', 'claude')
    print(f\"{s['sessionId']}|{s['cwd']}|{tool}\")
else:
    sys.exit(1)
" 2>/dev/null
}

_im2cc_register() {
  local name="$1" session_id="$2" cwd="$3" tool="${4:-claude}"
  _im2cc_ensure_registry
  python3 -c "
import json, os, sys
from datetime import datetime
reg = json.load(open('$_IM2CC_REGISTRY'))

# 唯一性检查：同一 sessionId 不能被多个 name 持有
for n, data in reg.items():
    if data.get('sessionId') == '$session_id' and n != '$name':
        print(f'❌ session 已被 \"{n}\" 注册，不能同时注册为 \"$name\"', file=sys.stderr)
        sys.exit(1)

reg['$name'] = {
    'sessionId': '$session_id',
    'cwd': '$cwd',
    'tool': '$tool',
    'createdAt': reg.get('$name', {}).get('createdAt', datetime.now().isoformat()),
    'lastUsedAt': datetime.now().isoformat()
}
tmp = '$_IM2CC_REGISTRY' + '.tmp'
json.dump(reg, open(tmp, 'w'), indent=2)
os.rename(tmp, '$_IM2CC_REGISTRY')
" || { echo "❌ 注册失败"; return 1; }
}

_im2cc_remove() {
  local name="$1"
  _im2cc_ensure_registry
  python3 -c "
import json, os
reg = json.load(open('$_IM2CC_REGISTRY'))
reg.pop('$name', None)
tmp = '$_IM2CC_REGISTRY' + '.tmp'
json.dump(reg, open(tmp, 'w'), indent=2)
os.rename(tmp, '$_IM2CC_REGISTRY')
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

# 根据工具类型生成创建 session 的 tmux 命令
_im2cc_tool_create_cmd() {
  local tool="$1" session_id="$2" name="$3"
  case "$tool" in
    claude) echo "claude --session-id $session_id --dangerously-skip-permissions --name 'im2cc:${name}'" ;;
    codex)  echo "codex exec --json --full-auto '会话已建立。请回复就绪。'" ;;
    kimi)   echo "kimi --print -p '会话已建立。请回复就绪。' --output-format=stream-json" ;;
    gemini) echo "gemini -p '会话已建立。请回复就绪。' --output-format json -y" ;;
    cline)  echo "cline -y --json '会话已建立。请回复就绪。'" ;;
    *)      echo "$tool --session-id $session_id" ;;
  esac
}

# 根据工具类型生成恢复 session 的 tmux 命令
_im2cc_tool_resume_cmd() {
  local tool="$1" session_id="$2" name="$3"
  case "$tool" in
    claude) echo "claude --resume $session_id --dangerously-skip-permissions --name 'im2cc:${name}'" ;;
    codex)  echo "codex exec resume $session_id --json --full-auto" ;;
    kimi)   echo "kimi --session $session_id --print --output-format=stream-json" ;;
    gemini) echo "gemini --resume $session_id -y --output-format json" ;;
    cline)  echo "cline -y --resume $session_id --json" ;;
    *)      echo "$tool --resume $session_id" ;;
  esac
}

# session 文件位置检查: exit 0=here(正确位置), 1=elsewhere(错误位置), 2=missing(不存在)
_im2cc_check_session_file() {
  local sid="$1" cwd="$2"
  python3 -c "
import os, re, sys
sid = '$sid'
cwd = '$cwd'
projects = os.path.expanduser('~/.claude/projects')
slug = re.sub(r'[^a-zA-Z0-9]', '-', cwd)
expected = os.path.join(projects, slug, sid + '.jsonl')
if os.path.exists(expected):
    sys.exit(0)  # here
for s in os.listdir(projects):
    if s == slug: continue
    if os.path.exists(os.path.join(projects, s, sid + '.jsonl')):
        sys.exit(1)  # elsewhere
sys.exit(2)  # missing
" 2>/dev/null
}

# 解绑远程端：归档绑定 + 通知对应 IM
_im2cc_release_remote() {
  local session_id="$1" session_name="$2"
  local bindings_file="$HOME/.im2cc/data/bindings.json"
  [[ -f "$bindings_file" ]] || return

  python3 -c "
import json, os, sys

bindings = json.load(open('$bindings_file'))
config_file = os.path.expanduser('~/.im2cc/config.json')
changed = False
feishu_groups = []

for b in bindings:
    # 兼容旧格式
    sid = b.get('sessionId', '')
    conv = b.get('conversationId', b.get('feishuGroupId', ''))
    transport = b.get('transport', 'feishu')
    if sid == '$session_id' and not b.get('archived'):
        b['archived'] = True
        changed = True
        if transport == 'feishu' and conv:
            feishu_groups.append(conv)
        print(f'已解绑 {transport} ({conv})')

if changed:
    tmp = '$bindings_file' + '.tmp'
    json.dump(bindings, open(tmp, 'w'), indent=2)
    os.rename(tmp, '$bindings_file')

    # 通知飞书群（微信不支持主动推送，跳过）
    for group_id in feishu_groups:
        if os.path.exists(config_file):
            try:
                config = json.load(open(config_file))
                app_id = config.get('feishu', {}).get('appId', '')
                app_secret = config.get('feishu', {}).get('appSecret', '')
                if app_id and app_secret:
                    import urllib.request
                    token_req = urllib.request.Request(
                        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
                        data=json.dumps({'app_id': app_id, 'app_secret': app_secret}).encode(),
                        headers={'Content-Type': 'application/json'},
                    )
                    token_resp = json.loads(urllib.request.urlopen(token_req, timeout=5).read())
                    token = token_resp.get('tenant_access_token', '')

                    if token:
                        msg_req = urllib.request.Request(
                            'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
                            data=json.dumps({
                                'receive_id': group_id,
                                'msg_type': 'text',
                                'content': json.dumps({'text': f'🔄 \"{session_name}\" 已转到电脑端'})
                            }).encode(),
                            headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'},
                        )
                        urllib.request.urlopen(msg_req, timeout=5)
            except Exception:
                pass  # 通知失败不影响主流程
" 2>/dev/null
}

# --- 用户命令 ---

# fn [--tool <tool>] <name> [path] — 创建新对话
fn() {
  local tool="claude"
  # 解析 --tool 参数
  if [[ "$1" == "--tool" ]]; then
    tool="$2"
    shift 2
  fi

  local name="${1:?用法: fn [--tool <工具>] <名称> [路径]}"
  local dir="${2:-$(pwd)}"

  # 名称安全校验（防注入）
  if [[ ! "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ ]]; then
    echo "❌ 名称不合法，只允许字母、数字、连字符和下划线"
    return 1
  fi

  # 检查工具是否可用
  if ! command -v "$tool" &>/dev/null && [[ "$tool" != "claude" ]]; then
    echo "❌ 工具 \"$tool\" 未安装"
    return 1
  fi

  # 展开 ~
  dir="${dir/#\~/$HOME}"
  # 解析为绝对路径
  dir="$(cd "$dir" 2>/dev/null && pwd)" || { echo "❌ 路径不存在: $2"; return 1; }

  # 检查名称是否已存在
  if _im2cc_read_session "$name" >/dev/null 2>&1; then
    echo "\"$name\" 已存在。用 fc $name 接入，或 fk $name 先删除。"
    return 1
  fi

  # tmux 命名：im2cc-{tool}-{name}
  local tmux_name="${_IM2CC_TMUX_PREFIX}${tool}-${name}"
  if tmux has-session -t "$tmux_name" 2>/dev/null; then
    echo "tmux 会话 $tmux_name 已存在，先终止..."
    tmux kill-session -t "$tmux_name"
  fi
  # 兼容旧格式 tmux session
  local old_tmux="${_IM2CC_TMUX_PREFIX}${name}"
  if tmux has-session -t "$old_tmux" 2>/dev/null; then
    tmux kill-session -t "$old_tmux"
  fi

  # 生成 UUID
  local session_id
  session_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"

  # 注册（带 tool）
  _im2cc_register "$name" "$session_id" "$dir" "$tool"

  # 在 tmux 中启动工具（通过映射函数获取正确的 CLI 命令）
  local tool_label=""
  if [[ "$tool" != "claude" ]]; then tool_label=" [$tool]"; fi
  local create_cmd
  create_cmd="$(_im2cc_tool_create_cmd "$tool" "$session_id" "$name")"
  tmux new-session -d -s "$tmux_name" -c "$dir" "$create_cmd"

  echo "✅ 创建对话 \"$name\"${tool_label} → $(basename "$dir")"
  echo "   飞书/微信: /fc $name"

  _im2cc_connect "$tmux_name"
}

# --- fn-xxx 别名 ---
fn-codex() { fn --tool codex "$@"; }
fn-kimi()  { fn --tool kimi "$@"; }
fn-gemini(){ fn --tool gemini "$@"; }
fn-cline() { fn --tool cline "$@"; }

# fc [name] [session-query] — 接入已有对话 / 注册并接入未注册对话
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

  # 双参数模式: fc <新名称> <session-query>
  if [[ -n "$2" ]]; then
    local new_name="$1"
    local query="$2"

    # 检查名称是否已注册
    if _im2cc_read_session "$new_name" >/dev/null 2>&1; then
      echo "\"$new_name\" 已注册。用 fc $new_name 直接接入。"
      return 1
    fi

    # 搜索匹配的 session 文件
    local match
    match=$(python3 -c "
import os, json, glob

projects_dir = os.path.expanduser('~/.claude/projects')
query = '$query'.lower()
matches = []

for slug in os.listdir(projects_dir):
    slug_dir = os.path.join(projects_dir, slug)
    if not os.path.isdir(slug_dir): continue
    for f in os.listdir(slug_dir):
        if not f.endswith('.jsonl'): continue
        sid = f[:-6]
        if sid.lower().startswith(query):
            fp = os.path.join(slug_dir, f)
            mtime = os.path.getmtime(fp)
            # 尝试还原项目路径
            direct = '/' + slug[1:].replace('-', '/')
            cwd = direct if os.path.isdir(direct) else ''
            matches.append((sid, cwd, mtime))

if len(matches) == 1:
    sid, cwd, _ = matches[0]
    print(f'{sid}|{cwd}')
elif len(matches) == 0:
    pass  # no output = not found
else:
    for sid, cwd, _ in sorted(matches, key=lambda x: -x[2])[:5]:
        print(f'MULTI|{sid[:8]}', end=' ')
" 2>/dev/null)

    if [[ -z "$match" ]]; then
      echo "❌ 未找到匹配 \"$query\" 的对话"
      return 1
    fi

    if [[ "$match" == MULTI* ]]; then
      echo "多个对话匹配: ${match#MULTI|}"
      echo "请用更精确的 ID 前缀"
      return 1
    fi

    local session_id="${match%%|*}"
    local cwd="${match##*|}"

    if [[ -z "$cwd" ]]; then
      echo "❌ 无法还原项目路径"
      return 1
    fi

    # 验证 session 文件位置
    _im2cc_check_session_file "$session_id" "$cwd"
    local check_result=$?

    if [[ $check_result -eq 1 ]]; then
      echo "❌ session ${session_id:0:8} 存在于错误的项目目录"
      return 1
    fi

    local session_flag="--resume"
    if [[ $check_result -eq 2 ]]; then
      session_flag="--session-id"
    fi

    # 注册并打开
    _im2cc_register "$new_name" "$session_id" "$cwd" || return 1
    echo "✅ 已注册 \"$new_name\" → $(basename "$cwd") [$session_id]"

    local tmux_name="${_IM2CC_TMUX_PREFIX}${new_name}"
    _im2cc_release_remote "$session_id" "$new_name"

    tmux new-session -d -s "$tmux_name" -c "$cwd" \
      "claude $session_flag $session_id --dangerously-skip-permissions --name 'im2cc:${new_name}'"

    _im2cc_connect "$tmux_name"
    return
  fi

  # 单参数模式: fc <name>
  local name="$1"
  local info
  info="$(_im2cc_read_session "$name")" || { echo "❌ 未找到 \"$name\"。用 fl 查看列表。"; return 1; }

  # 解析 sessionId|cwd|tool
  local session_id cwd tool
  session_id="$(echo "$info" | cut -d'|' -f1)"
  cwd="$(echo "$info" | cut -d'|' -f2)"
  tool="$(echo "$info" | cut -d'|' -f3)"
  [[ -z "$tool" ]] && tool="claude"

  local tmux_name="${_IM2CC_TMUX_PREFIX}${tool}-${name}"

  # 独占：解绑远程端
  _im2cc_release_remote "$session_id" "$name"

  # 如果 tmux session 已存在（新格式或旧格式），直接 attach
  if tmux has-session -t "$tmux_name" 2>/dev/null; then
    echo "接入 \"$name\" (活跃)"
    _im2cc_connect "$tmux_name"
    return
  fi
  # 兼容旧格式
  local old_tmux="${_IM2CC_TMUX_PREFIX}${name}"
  if tmux has-session -t "$old_tmux" 2>/dev/null; then
    echo "接入 \"$name\" (活跃)"
    _im2cc_connect "$old_tmux"
    return
  fi

  # tmux session 不存在，重新打开
  _im2cc_check_session_file "$session_id" "$cwd"
  local check_result=$?

  if [[ $check_result -eq 1 ]]; then
    echo "❌ session ${session_id:0:8} 存在于错误的项目目录"
    echo "   请 fk $name 后重新 fn"
    return 1
  fi

  local session_flag="--resume"
  if [[ $check_result -eq 2 ]]; then
    session_flag="--session-id"
  fi

  echo "恢复 \"$name\" → $(basename "$cwd")"
  local resume_cmd
  if [[ "$session_flag" == "--session-id" ]]; then
    resume_cmd="$(_im2cc_tool_create_cmd "$tool" "$session_id" "$name")"
  else
    resume_cmd="$(_im2cc_tool_resume_cmd "$tool" "$session_id" "$name")"
  fi
  tmux new-session -d -s "$tmux_name" -c "$cwd" "$resume_cmd"

  _im2cc_connect "$tmux_name"
}

# fl — 列出所有已注册对话
fl() {
  _im2cc_ensure_registry
  python3 -c "
import json, os, subprocess
reg = json.load(open('$_IM2CC_REGISTRY'))
if not reg:
    print('没有已注册的对话。用 fn <名称> 创建。')
else:
    for name, data in sorted(reg.items()):
        cwd = data.get('cwd', '')
        proj = os.path.basename(cwd)
        sid = data.get('sessionId', '')[:8]
        tool = data.get('tool', 'claude')
        # 检查 tmux 状态（新格式 + 旧格式兼容）
        tmux_new = '${_IM2CC_TMUX_PREFIX}' + tool + '-' + name
        tmux_old = '${_IM2CC_TMUX_PREFIX}' + name
        alive = (subprocess.run(['tmux', 'has-session', '-t', tmux_new],
                                capture_output=True).returncode == 0 or
                 subprocess.run(['tmux', 'has-session', '-t', tmux_old],
                                capture_output=True).returncode == 0)
        status = '🟢 活跃' if alive else '⬤ 休眠'
        tool_tag = f'  [{tool}]' if tool != 'claude' else ''
        print(f'  {status}  {name}  ({proj}){tool_tag}  [{sid}]')
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

  local session_id cwd tool
  session_id="$(echo "$info" | cut -d'|' -f1)"
  cwd="$(echo "$info" | cut -d'|' -f2)"
  tool="$(echo "$info" | cut -d'|' -f3)"
  [[ -z "$tool" ]] && tool="claude"

  local tmux_name="${_IM2CC_TMUX_PREFIX}${tool}-${name}"
  local old_tmux="${_IM2CC_TMUX_PREFIX}${name}"
  local tool_label=""
  [[ "$tool" != "claude" ]] && tool_label=" [$tool]"

  echo "📊 $name${tool_label}"
  echo "  📁 $(basename "$cwd") ($cwd)"
  echo "  🔑 $session_id"

  if tmux has-session -t "$tmux_name" 2>/dev/null || tmux has-session -t "$old_tmux" 2>/dev/null; then
    echo "  🟢 tmux: 活跃"
  else
    echo "  ⬤ tmux: 休眠"
  fi

  echo ""
  echo "  打开: fc $name"
  echo "  飞书/微信: /fc $name"
  echo "  终止: fk $name"
}
