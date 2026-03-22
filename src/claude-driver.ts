/**
 * @input:    Claude Code CLI (`claude` 命令), session ID, 用户消息
 * @output:   createSession(), sendMessage(), interrupt(), checkSessionFile() — Claude Code 生命周期管理
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import { log } from './logger.js'
import { pathToSlug } from './discover.js'

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

export interface SendMessageOptions {
  onSpawn?: (child: ChildProcess) => void
  outputFile?: string
  /** 每轮 assistant 文字就绪时立即回调（流式输出） */
  onTurnText?: (text: string) => void
}

/** 向已有 session 发送消息 */
export function sendMessage(
  sessionId: string,
  message: string,
  cwd: string,
  permissionMode: string,
  opts?: SendMessageOptions,
): Promise<string> {
  const status = checkSessionFile(sessionId, cwd)

  if (status === 'elsewhere') {
    const slug = pathToSlug(cwd)
    return Promise.reject(new Error(
      `session ${sessionId.slice(0, 8)} 存在于错误的项目目录下（期望 slug: ${slug}）。` +
      `registry 中的 cwd 与 session 文件位置不匹配，请用 fk 清除后重新 fn。`
    ))
  }

  if (status === 'missing') {
    log(`[claude-driver] session ${sessionId} 文件不存在，使用 --session-id 创建`)
  }

  return runClaude({
    message,
    sessionFlag: status === 'here' ? ['--resume', sessionId] : ['--session-id', sessionId],
    cwd,
    permissionMode,
    onSpawn: opts?.onSpawn,
    outputFile: opts?.outputFile,
    onTurnText: opts?.onTurnText,
  })
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

/** session 文件位置状态 */
export type SessionFileStatus = 'here' | 'elsewhere' | 'missing'

/** 检查 session 文件位置：here=正确 slug 下, elsewhere=其他 slug 下, missing=不存在 */
export function checkSessionFile(sessionId: string, cwd: string): SessionFileStatus {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  const expectedSlug = pathToSlug(cwd)
  const expectedPath = path.join(projectsDir, expectedSlug, `${sessionId}.jsonl`)

  if (fs.existsSync(expectedPath)) return 'here'

  try {
    for (const slug of fs.readdirSync(projectsDir)) {
      if (slug === expectedSlug) continue
      if (fs.existsSync(path.join(projectsDir, slug, `${sessionId}.jsonl`))) return 'elsewhere'
    }
  } catch { /* projects 目录不存在 */ }

  return 'missing'
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
  outputFile?: string
  onTurnText?: (text: string) => void
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
    const turnTexts: string[] = []   // 所有轮次的文字（用于 inflight 落盘）
    const resultParts: string[] = [] // result 事件（单轮 fallback）

    /** 从 assistant 事件提取文字内容 */
    function extractAssistantText(event: Record<string, unknown>): string {
      const msg = event.message as Record<string, unknown> | undefined
      if (!msg || !Array.isArray(msg.content)) return ''
      const texts: string[] = []
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      }
      return texts.join('')
    }

    function handleEvent(event: Record<string, unknown>): void {
      if (event.type === 'assistant') {
        const turnOutput = extractAssistantText(event)
        if (turnOutput) {
          turnTexts.push(turnOutput)
          opts.onTurnText?.(turnOutput)  // 流式回调：立即发到飞书
        }
      }

      if (event.type === 'result' && typeof event.result === 'string') {
        resultParts.push(event.result)
      }

      // 输出落盘
      const allText = turnTexts.length > 0 ? turnTexts.join('\n\n---\n\n') : resultParts.join('\n\n---\n\n')
      if (opts.outputFile && allText) {
        try { fs.writeFileSync(opts.outputFile, allText) } catch {}
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try { handleEvent(JSON.parse(line) as Record<string, unknown>) } catch {}
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)

    child.on('close', (code) => {
      if (stdout.trim()) {
        try { handleEvent(JSON.parse(stdout) as Record<string, unknown>) } catch {}
      }

      // 多轮用所有轮次文字，单轮用 result
      const resultText = turnTexts.length > 1
        ? turnTexts.join('\n\n---\n\n')
        : resultParts.join('\n\n---\n\n')
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
