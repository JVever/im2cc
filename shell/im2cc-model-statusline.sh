#!/bin/sh
# im2cc-model-statusline.sh — Claude Code statusline 旁路观察器
# 只在 Terminal 实际模型发生变化时更新命名 Session，然后把原始输入交给既有 statusline 命令。
#
# @input:    Claude Code statusline JSON (stdin): session_id, cwd, transcript_path, model.id
# @output:   更新 ~/.im2cc/data/registry.json 的 selectedModelId；既有 statusline stdout 原样输出
# @rule:     不输出自己的状态文本；必须防递归、保留既有 statusline 链，并拒绝家族 alias / synthetic 模型

DATA_DIR="$HOME/.im2cc/data"
LOG_DIR="$HOME/.im2cc/logs"
REGISTRY="$DATA_DIR/registry.json"
STATE="$DATA_DIR/statusline-model-state.json"
NEXT_COMMAND_FILE="$DATA_DIR/statusline-next-command"
FALLBACK_COMMAND_FILE="$DATA_DIR/statusline-fallback-command"
LOG="$LOG_DIR/model-sync.log"

mkdir -p "$DATA_DIR" "$LOG_DIR" 2>/dev/null
INPUT_FILE=$(mktemp "$DATA_DIR/statusline-input.XXXXXX") || exit 0
trap 'rm -f "$INPUT_FILE"' EXIT HUP INT TERM
cat > "$INPUT_FILE"

run_saved_command() {
  command_file="$1"
  [ -f "$command_file" ] || return 0
  saved_command=$(cat "$command_file" 2>/dev/null)
  [ -n "$saved_command" ] || return 0
  IM2CC_MODEL_STATUSLINE_ACTIVE=1 /bin/sh -c "$saved_command" < "$INPUT_FILE"
}

# 如果既有 statusline 链意外再次调用 im2cc wrapper，直接落到叶子命令；
# fallback 若也绕回 observer，第二次再入硬退出，保证任何第三方闭环都有限终止。
if [ "${IM2CC_MODEL_STATUSLINE_ACTIVE:-}" = "1" ]; then
  if [ "${IM2CC_MODEL_STATUSLINE_FALLBACK_ACTIVE:-}" = "1" ]; then
    exit 0
  fi
  IM2CC_MODEL_STATUSLINE_FALLBACK_ACTIVE=1 run_saved_command "$FALLBACK_COMMAND_FILE"
  exit $?
fi

python3 - "$INPUT_FILE" "$REGISTRY" "$STATE" "$LOG" <<'PY'
import json
import os
import re
import sys
import atexit
import time
from datetime import datetime, timezone

input_path, registry_path, state_path, log_path = sys.argv[1:]

def now_iso():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

def log(message):
    try:
        with open(log_path, 'a', encoding='utf-8') as handle:
            handle.write(f'[{now_iso()}] {message}\n')
    except Exception:
        pass

def atomic_json_write(file_path, value):
    temp_path = f'{file_path}.tmp.{os.getpid()}'
    with open(temp_path, 'w', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
    os.replace(temp_path, file_path)

try:
    with open(input_path, encoding='utf-8') as handle:
        payload = json.load(handle)
except Exception as exc:
    log(f'SKIP invalid payload: {exc}')
    sys.exit(0)

session_id = payload.get('session_id') or ''
cwd = payload.get('cwd') or ''
transcript = payload.get('transcript_path') or ''
model = payload.get('model') if isinstance(payload.get('model'), dict) else {}
model_id = model.get('id') or ''
event_at = now_iso()  # 记录 payload 被 observer 接收的时间，而不是拿到写锁后的时间

# statusline 的 model.id 是工具/供应商报告的原生 ID，不强绑 `claude-` 前缀，以兼容
# Fable 等自定义 provider；只拒绝已知家族 alias 和 synthetic 占位符。
normalized_model_id = model_id.strip() if isinstance(model_id, str) else ''
claude_family_alias = re.match(r'^(opus|sonnet|haiku)(?:$|[-._])', normalized_model_id, re.IGNORECASE)
if (not session_id or not normalized_model_id or normalized_model_id.lower() == 'default'
        or claude_family_alias or normalized_model_id == '<synthetic>'):
    log(f'SKIP incomplete/non-exact model session={session_id[:8]} model={model_id!r}')
    sys.exit(0)
model_id = normalized_model_id
if not os.path.isfile(registry_path):
    sys.exit(0)

lock_path = os.path.join(os.path.dirname(registry_path), 'registry.lock')
lock_owned = False
deadline = time.monotonic() + 2.0
while not lock_owned:
    try:
        os.mkdir(lock_path)
        lock_owned = True
    except FileExistsError:
        try:
            if time.time() - os.stat(lock_path).st_mtime > 10.0:
                os.rmdir(lock_path)
                continue
        except OSError:
            pass
        if time.monotonic() >= deadline:
            log('SKIP registry lock timeout')
            sys.exit(0)
        time.sleep(0.01)

def release_lock():
    if lock_owned:
        try:
            os.rmdir(lock_path)
        except OSError:
            pass

atexit.register(release_lock)

try:
    with open(registry_path, encoding='utf-8') as handle:
        registry = json.load(handle)
except Exception as exc:
    log(f'SKIP invalid registry: {exc}')
    sys.exit(0)

name = None
for candidate, data in registry.items():
    if data.get('sessionId') == session_id:
        name = candidate
        break

# SessionStart hook 可能与 statusline 首次刷新并发；用 transcript 文件名做保守兜底。
if name is None and transcript:
    transcript_id = os.path.splitext(os.path.basename(transcript))[0]
    for candidate, data in registry.items():
        if data.get('sessionId') == transcript_id:
            name = candidate
            break
if name is None:
    log(f'SKIP unregistered session={session_id[:8]}')
    sys.exit(0)

entry = registry[name]
if entry.get('tool', 'claude') != 'claude':
    log(f'SKIP non-claude name={name}')
    sys.exit(0)

registered_cwd = entry.get('cwd') or ''
if cwd and registered_cwd and os.path.realpath(cwd) != os.path.realpath(registered_cwd):
    log(f'SKIP cwd mismatch name={name}')
    sys.exit(0)

def parse_iso(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except Exception:
        return float('-inf')

# payload 可能先到但因写锁排队；若锁内已出现更晚的 IM/Terminal 事件，旧 payload 不得覆盖。
if parse_iso(entry.get('modelSelectionUpdatedAt') or '') > parse_iso(event_at):
    try:
        with open(state_path, encoding='utf-8') as handle:
            stale_state = json.load(handle)
    except Exception:
        stale_state = {}
    stale_state[session_id] = model_id
    atomic_json_write(state_path, stale_state)
    log(f'SKIP stale payload name={name} model={model_id}')
    sys.exit(0)

try:
    with open(state_path, encoding='utf-8') as handle:
        state = json.load(handle)
except Exception:
    state = {}

# 核心去抖：IM 改 registry 后，Terminal 的周期性同值刷新不能把旧值抢回去；
# 只有 statusline 自身从一个模型变到另一个模型，才算 Terminal 新选择事件。
if state.get(session_id) == model_id:
    sys.exit(0)

entry['selectedModelId'] = model_id
entry['modelSelectionUpdatedAt'] = event_at
atomic_json_write(registry_path, registry)
state[session_id] = model_id
atomic_json_write(state_path, state)
log(f'SUCCESS name={name} session={session_id[:8]} model={model_id}')
PY

run_saved_command "$NEXT_COMMAND_FILE"
exit $?
