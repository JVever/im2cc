/**
 * @input:    Claude Code CLI (`claude` 命令), session ID, 用户消息
 * @output:   createSession(), sendMessage(), interrupt() — Claude Code 生命周期管理
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'

export interface CLIEvent {
  type: 'init' | 'assistant' | 'result' | 'error' | 'unknown'
  subtype?: string
  result?: string
  sessionId?: string
  raw: Record<string, unknown>
}

export interface CreateSessionResult {
  sessionId: string
  output: string
}

/** 获取 Claude Code 版本 */
export function getClaudeVersion(): string {
  try {
    return execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

/** 创建新 session，name 用于标记方便回到电脑后查找 */
export async function createSession(
  cwd: string,
  permissionMode: string,
  name?: string,
): Promise<CreateSessionResult> {
  const sessionId = crypto.randomUUID()
  const extraFlags = name ? ['--name', `im2cc:${name}`] : []
  const output = await runClaude({
    message: '会话已建立。请回复"就绪"。',
    sessionFlag: ['--session-id', sessionId, ...extraFlags],
    cwd,
    permissionMode,
  })
  return { sessionId, output }
}

/** 向已有 session 发送消息 */
export async function sendMessage(
  sessionId: string,
  message: string,
  cwd: string,
  permissionMode: string,
): Promise<{ output: string; childProcess: ChildProcess }> {
  let resolveChild: (cp: ChildProcess) => void
  const childPromise = new Promise<ChildProcess>(r => { resolveChild = r })

  const outputPromise = runClaude({
    message,
    sessionFlag: ['--resume', sessionId],
    cwd,
    permissionMode,
    onSpawn: cp => resolveChild!(cp),
  })

  const child = await childPromise
  const output = await outputPromise
  return { output, childProcess: child }
}

/** 杀掉本地占用某个 session 的 Claude Code 进程 */
export function killLocalSession(sessionName: string): boolean {
  const tmuxSession = `im2cc-${sessionName}`
  try {
    // 方式 1：通过 tmux session 名称关闭（最可靠）
    execSync(`tmux has-session -t "${tmuxSession}" 2>/dev/null`)
    execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`)
    return true
  } catch { /* tmux session 不存在 */ }

  try {
    // 方式 2：fallback，通过进程参数匹配
    const result = execSync(
      `pgrep -f "claude.*${sessionName}" 2>/dev/null || true`,
      { encoding: 'utf-8' },
    ).trim()
    if (!result) return false

    const pids = result.split('\n').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n !== process.pid)
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ }
    }
    return pids.length > 0
  } catch {
    return false
  }
}

/** 中断正在运行的 CLI 进程：SIGINT → 5s → SIGTERM → 5s → SIGKILL */
export async function interrupt(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return

  const pid = child.pid

  // 尝试杀整个进程组
  const killGroup = (signal: NodeJS.Signals) => {
    try { process.kill(-pid, signal) } catch { /* 进程已退出 */ }
  }

  killGroup('SIGINT')
  await waitOrTimeout(child, 5000)
  if (child.exitCode !== null) return

  killGroup('SIGTERM')
  await waitOrTimeout(child, 5000)
  if (child.exitCode !== null) return

  killGroup('SIGKILL')
}

// --- 内部实现 ---

/** 权限模式 → CLI 参数 */
function permissionArgs(mode: string): string[] {
  if (mode === 'YOLO') return ['--dangerously-skip-permissions']
  return ['--permission-mode', mode]
}

interface RunClaudeOptions {
  message: string
  sessionFlag: string[]
  cwd: string
  permissionMode: string
  onSpawn?: (child: ChildProcess) => void
}

function runClaude(opts: RunClaudeOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', opts.message,
      ...opts.sessionFlag,
      '--output-format', 'stream-json',
      '--verbose',
      ...permissionArgs(opts.permissionMode),
    ]

    const child = spawn('claude', args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // 进程组隔离，方便 interrupt 时杀整个组
    })

    opts.onSpawn?.(child)

    let stdout = ''
    let stderr = ''
    const resultParts: string[] = []

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      // 逐行解析 stream-json
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? '' // 保留不完整的最后一行
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          if (event.type === 'result' && typeof event.result === 'string') {
            resultParts.push(event.result)
          }
        } catch {
          // 非 JSON 行，忽略
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)

    child.on('close', (code) => {
      // 处理 stdout 中残留的最后一行
      if (stdout.trim()) {
        try {
          const event = JSON.parse(stdout) as Record<string, unknown>
          if (event.type === 'result' && typeof event.result === 'string') {
            resultParts.push(event.result)
          }
        } catch { /* 忽略 */ }
      }

      const resultText = resultParts.join('\n\n---\n\n')
      if (code === 0 || resultText) {
        resolve(resultText || '(无输出)')
      } else {
        reject(new Error(`claude 退出码 ${code}: ${stderr.slice(0, 500)}`))
      }
    })
  })
}

function waitOrTimeout(child: ChildProcess, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    child.on('close', () => { clearTimeout(timer); resolve() })
  })
}
