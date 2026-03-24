#!/bin/bash
# im2cc-session-sync.sh — Claude Code SessionStart hook
# 当 Plan 模式等内部机制创建新 session 时，自动同步 im2cc registry
#
# @input:    Claude Code hook JSON (stdin): session_id, cwd, source
# @output:   更新 ~/.im2cc/data/registry.json（如 session ID 发生变化）
# @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md

# 快速路径：不在 tmux 中则直接退出
[[ -n "$TMUX" ]] || exit 0

# 获取 tmux session 名称，不是 im2cc 管理的则退出
tmux_name=$(tmux display-message -p '#{session_name}' 2>/dev/null)
[[ "$tmux_name" == im2cc-* ]] || exit 0

# 读取 stdin 中的 hook JSON
input=$(cat)

# 提取 im2cc session 名称（兼容新格式 im2cc-{tool}-{name}）
im2cc_name="${tmux_name#im2cc-}"
# 新格式 im2cc-{tool}-{name}: 去掉 tool 前缀
case "$im2cc_name" in
  claude-*|codex-*|kimi-*|gemini-*) im2cc_name="${im2cc_name#*-}" ;;
esac
registry="$HOME/.im2cc/data/registry.json"
[[ -f "$registry" ]] || exit 0

# 用 python3 解析 JSON 并更新 registry（原子写）
python3 -c "
import json, os, re, sys
from datetime import datetime

inp = json.loads(sys.stdin.read())
new_sid = inp.get('session_id', '')
if not new_sid:
    sys.exit(0)

registry_path = '$registry'
name = '$im2cc_name'

reg = json.load(open(registry_path))
if name not in reg:
    sys.exit(0)

current_sid = reg[name].get('sessionId', '')
if current_sid == new_sid:
    sys.exit(0)

# 守卫 0: 工具检查 — 本 hook 是 Claude Code 专属，不应覆写其他工具的 session
tool = reg[name].get('tool', 'claude')
if tool != 'claude':
    print(f'[im2cc] INFO: \"{name}\" is a {tool} session, skipping Claude session sync',
          file=sys.stderr)
    sys.exit(0)

# 守卫 1: 唯一性 — 新 session ID 不能已被其他 name 持有
for other_name, other_data in reg.items():
    if other_name != name and other_data.get('sessionId') == new_sid:
        print(f'[im2cc] WARN: session {new_sid[:8]} already owned by \"{other_name}\", '
              f'skipping sync for \"{name}\"', file=sys.stderr)
        sys.exit(0)

# 守卫 2: slug 验证 — session 文件必须在此 name 的 cwd 对应 slug 下
cwd = reg[name].get('cwd', '')
slug = re.sub(r'[^a-zA-Z0-9]', '-', cwd)
projects_dir = os.path.expanduser('~/.claude/projects')
expected_path = os.path.join(projects_dir, slug, new_sid + '.jsonl')
if not os.path.exists(expected_path):
    print(f'[im2cc] WARN: session file {new_sid[:8]} not at expected slug ({slug}), '
          f'skipping sync for \"{name}\"', file=sys.stderr)
    sys.exit(0)

# Session 已漂移且通过守卫，更新 registry
old_short = current_sid[:8]
new_short = new_sid[:8]
reg[name]['sessionId'] = new_sid
reg[name]['lastUsedAt'] = datetime.utcnow().isoformat() + 'Z'

tmp = registry_path + '.tmp'
json.dump(reg, open(tmp, 'w'), indent=2)
os.rename(tmp, registry_path)

print(f'[im2cc] session sync: {name} {old_short} → {new_short}', file=sys.stderr)
" <<< "$input" 2>/dev/null

exit 0
