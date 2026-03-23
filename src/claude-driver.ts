/**
 * @input:    Claude Code CLI (`claude` 命令), session ID, 用户消息
 * @output:   ClaudeDriver (ToolDriver 实现) + 兼容导出 — Claude Code 生命周期管理
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execSync, execFileSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import { log } from './logger.js'
import { pathToSlug } from './discover.js'
import { registerDriver, type ToolDriver, type ToolCapabilities, type CreateSessionResult, type SendMessageOptions, type SessionFileStatus } from './tool-driver.js'

// --- ClaudeDriver 类 ---

export class ClaudeDriver implements ToolDriver {
  readonly id = 'claude' as const
  readonly capabilities: ToolCapabilities = {
    supportsResume: true,
    supportsDiscovery: true,
    supportsInterrupt: true,
  }

  getVersion(): string {
    try {
      return execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim()
    } catch {
      return 'unknown'
    }
  }

  isAvailable(): boolean {
    try {
      execSync('which claude 2>/dev/null', { encoding: 'utf-8' })
      return true
    } catch { return false }
  }

  async createSession(cwd: string, permissionMode: string, name?: string): Promise<CreateSessionResult> {
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

  sendMessage(sessionId: string, message: string, cwd: string, permissionMode: string, opts?: SendMessageOptions): Promise<string> {
    const status = this.checkSessionFile(sessionId, cwd)

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

  checkSessionFile(sessionId: string, cwd: string): SessionFileStatus {
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

  killLocalSession(sessionName: string, tool = 'claude' as const): boolean {
    // 先查新格式 im2cc-{tool}-{name}，再查旧格式 im2cc-{name}
    const tmuxNames = [`im2cc-${tool}-${sessionName}`, `im2cc-${sessionName}`]
    for (const tmuxSession of tmuxNames) {
      try {
        execFileSync('tmux', ['has-session', '-t', tmuxSession], { stdio: 'ignore' })
        execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' })
        return true
      } catch { /* 不存在，继续 */ }
    }

    try {
      const result = execFileSync('pgrep', ['-f', `claude.*${sessionName}`], { encoding: 'utf-8' }).trim()
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

  async interrupt(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null) return

    const pid = child.pid
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
}

// 自动注册
registerDriver(new ClaudeDriver())

// --- 兼容导出（供现有 import 使用）---

const _driver = new ClaudeDriver()

export function getClaudeVersion(): string { return _driver.getVersion() }

export async function createSession(cwd: string, permissionMode: string, name?: string): Promise<CreateSessionResult> {
  return _driver.createSession(cwd, permissionMode, name)
}

export function sendMessage(sessionId: string, message: string, cwd: string, permissionMode: string, opts?: SendMessageOptions): Promise<string> {
  return _driver.sendMessage(sessionId, message, cwd, permissionMode, opts)
}

export function killLocalSession(sessionName: string): boolean {
  return _driver.killLocalSession(sessionName)
}

export async function interrupt(child: ChildProcess): Promise<void> {
  return _driver.interrupt(child)
}

export function checkSessionFile(sessionId: string, cwd: string): SessionFileStatus {
  return _driver.checkSessionFile(sessionId, cwd)
}

// --- 内部实现（Claude 专有）---

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
      detached: true,
    })

    opts.onSpawn?.(child)

    let stdout = ''
    let stderr = ''
    const turnTexts: string[] = []
    const resultParts: string[] = []

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
          opts.onTurnText?.(turnOutput)
        }
      }
      if (event.type === 'result' && typeof event.result === 'string') {
        resultParts.push(event.result)
      }
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

    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)

    child.on('close', (code) => {
      if (stdout.trim()) {
        try { handleEvent(JSON.parse(stdout) as Record<string, unknown>) } catch {}
      }
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
