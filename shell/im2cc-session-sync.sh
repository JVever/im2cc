#!/bin/bash
# im2cc-session-sync.sh — Claude Code SessionStart hook
# 当 /clear、compact 等操作创建新 session 时，自动同步 im2cc registry
# 注意：Plan 模式切换不触发 SessionStart hook，由"断开前同步"机制覆盖
#
# @input:    Claude Code hook JSON (stdin): session_id, cwd, transcript_path, source
# @output:   更新 ~/.im2cc/data/registry.json（如 session ID 发生变化）+ 日志
# @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md

LOG="$HOME/.im2cc/logs/session-sync.log"
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG" 2>/dev/null; }

# 快速路径：不在 tmux 中则直接退出
if [[ -z "$TMUX" ]]; then
  log "SKIP: not in tmux (TMUX not set)"
  exit 0
fi

# 获取 tmux session 名称，不是 im2cc 管理的则退出
tmux_name=$(tmux display-message -p '#{session_name}' 2>/dev/null)
if [[ "$tmux_name" != im2cc-* ]]; then
  log "SKIP: tmux_name='$tmux_name' not im2cc-managed"
  exit 0
fi

# 读取 stdin 中的 hook JSON
input=$(cat)

# 提取 im2cc session 名称（兼容新格式 im2cc-{tool}-{name}）
im2cc_name="${tmux_name#im2cc-}"
# 新格式 im2cc-{tool}-{name}: 去掉 tool 前缀
case "$im2cc_name" in
  claude-*|codex-*|kimi-*|gemini-*) im2cc_name="${im2cc_name#*-}" ;;
esac
registry="$HOME/.im2cc/data/registry.json"
if [[ ! -f "$registry" ]]; then
  log "SKIP: registry not found at $registry"
  exit 0
fi

log "HOOK FIRED: tmux=$tmux_name name=$im2cc_name payload_len=${#input}"

# 用 python3 解析 JSON 并更新 registry（原子写）
python3 -c "
import json, os, re, sys
from datetime import datetime

LOG_PATH = os.path.expanduser('$LOG')
def log(msg):
    try:
        with open(LOG_PATH, 'a') as f:
            f.write(f'[{datetime.utcnow().isoformat()}Z] {msg}\n')
    except: pass

raw = sys.stdin.read()
try:
    inp = json.loads(raw)
except Exception as e:
    log(f'ERROR: failed to parse stdin JSON: {e}, raw={raw[:200]}')
    sys.exit(0)

new_sid = inp.get('session_id', '')
hook_cwd = inp.get('cwd', '')
source = inp.get('source', '')
transcript = inp.get('transcript_path', '')

log(f'PAYLOAD: session_id={new_sid[:8] if new_sid else \"(empty)\"} cwd={hook_cwd} source={source} transcript={transcript[-40:] if transcript else \"(empty)\"}')

if not new_sid:
    log('SKIP: empty session_id in payload')
    sys.exit(0)

registry_path = '$registry'
name = '$im2cc_name'

reg = json.load(open(registry_path))
if name not in reg:
    log(f'SKIP: name \"{name}\" not in registry')
    sys.exit(0)

current_sid = reg[name].get('sessionId', '')
if current_sid == new_sid:
    log(f'SKIP: session unchanged ({new_sid[:8]})')
    sys.exit(0)

# 守卫 0: 工具检查 — 本 hook 是 Claude Code 专属
tool = reg[name].get('tool', 'claude')
if tool != 'claude':
    log(f'SKIP: \"{name}\" is a {tool} session, not claude')
    sys.exit(0)

# 守卫 1: 唯一性 — 新 session ID 不能已被其他 name 持有
for other_name, other_data in reg.items():
    if other_name != name and other_data.get('sessionId') == new_sid:
        log(f'SKIP: session {new_sid[:8]} already owned by \"{other_name}\"')
        sys.exit(0)

# 守卫 2: cwd 校验 — 用 hook payload 中的 cwd 与 registry 的 cwd 比对
# 如果 hook payload 没有 cwd，fallback 到 transcript_path 验证
reg_cwd = reg[name].get('cwd', '')

if hook_cwd:
    # 规范化比对：realpath + 去尾斜杠
    norm_hook = os.path.realpath(hook_cwd).rstrip('/')
    norm_reg = os.path.realpath(reg_cwd).rstrip('/')
    if norm_hook != norm_reg:
        log(f'SKIP: cwd mismatch hook={norm_hook} reg={norm_reg}')
        sys.exit(0)
    log(f'GUARD2: cwd match OK ({norm_hook})')
elif transcript:
    # fallback: 从 transcript_path 提取 slug，与 registry cwd 的 slug 比对
    slug = re.sub(r'[^a-zA-Z0-9]', '-', reg_cwd)
    if f'/{slug}/' not in transcript:
        log(f'SKIP: transcript slug mismatch, expected {slug} in {transcript}')
        sys.exit(0)
    log(f'GUARD2: transcript slug match OK')
else:
    # 没有 cwd 也没有 transcript_path — 用旧的文件存在性检查
    slug = re.sub(r'[^a-zA-Z0-9]', '-', reg_cwd)
    projects_dir = os.path.expanduser('~/.claude/projects')
    expected_path = os.path.join(projects_dir, slug, new_sid + '.jsonl')
    if not os.path.exists(expected_path):
        log(f'SKIP: no cwd/transcript in payload, file {new_sid[:8]}.jsonl not found at {slug}')
        sys.exit(0)
    log(f'GUARD2: file existence fallback OK')

# 通过所有守卫，更新 registry
old_short = current_sid[:8]
new_short = new_sid[:8]
reg[name]['sessionId'] = new_sid
reg[name]['lastUsedAt'] = datetime.utcnow().isoformat() + 'Z'

tmp = registry_path + '.tmp.' + str(os.getpid())
json.dump(reg, open(tmp, 'w'), indent=2)
os.rename(tmp, registry_path)

log(f'SUCCESS: {name} {old_short} -> {new_short} (source={source})')
" <<< "$input"

exit 0
