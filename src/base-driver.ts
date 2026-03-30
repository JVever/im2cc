/**
 * @input:    ToolDriver 接口
 * @output:   BaseToolDriver — 所有工具 driver 的通用基类（tmux 管理、进程中断、流式输出解析）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import type { ToolDriver, ToolId, ToolCapabilities, CreateSessionOptions, CreateSessionResult, SendMessageOptions, SessionFileStatus } from './tool-driver.js'
import type { RecapTurn } from './recap.js'

/** runTool 的选项 */
export interface RunToolOptions {
  message: string
  args: string[]         // CLI 完整参数（不含命令名）
  cmd: string            // CLI 命令名
  cwd: string
  env?: NodeJS.ProcessEnv
  onSpawn?: (child: ChildProcess) => void
  outputFile?: string
  onTurnText?: (text: string) => void
  onEvent?: (event: Record<string, unknown>) => void
  /** 从 NDJSON 事件中提取 assistant 文本的函数 */
  extractText?: (event: Record<string, unknown>) => string
  /** 从 NDJSON 事件中提取 result 文本的函数 */
  extractResult?: (event: Record<string, unknown>) => string
}

interface ToolFailureInfo {
  userMessage: string
  rawMessage: string
}

/**
 * 所有工具 driver 的通用基类。
 * 提供 killLocalSession、interrupt、runTool 的通用实现。
 */
export abstract class BaseToolDriver implements ToolDriver {
  abstract readonly id: ToolId
  abstract readonly capabilities: ToolCapabilities

  abstract getVersion(): string
  abstract isAvailable(): boolean
  abstract createSession(cwd: string, permissionMode: string, name?: string, opts?: CreateSessionOptions): Promise<CreateSessionResult>
  abstract sendMessage(sessionId: string, message: string, cwd: string, permissionMode: string, opts?: SendMessageOptions): Promise<string>

  /** 默认：不支持 session 文件检查（子类可覆盖） */
  checkSessionFile(_sessionId: string, _cwd: string): SessionFileStatus {
    return 'missing'
  }

  /** 默认：不支持 recap（子类可覆盖） */
  buildRecapTurn(_sessionId: string, _cwd: string, _budget: number): RecapTurn | null {
    return null
  }

  /** 通用：杀掉 tmux 中的本地 session */
  killLocalSession(sessionName: string, tool?: ToolId): boolean {
    const t = tool ?? this.id
    const tmuxNames = [`im2cc-${t}-${sessionName}`, `im2cc-${sessionName}`]
    for (const tmuxSession of tmuxNames) {
      try {
        execFileSync('tmux', ['has-session', '-t', tmuxSession], { stdio: 'ignore' })
        execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' })
        return true
      } catch { /* 不存在 */ }
    }

    // fallback：通过进程名匹配
    try {
      const result = execFileSync('pgrep', ['-f', `${this.id}.*${sessionName}`], { encoding: 'utf-8' }).trim()
      if (!result) return false
      const pids = result.split('\n').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n !== process.pid)
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM') } catch {}
      }
      return pids.length > 0
    } catch { return false }
  }

  /** 通用：中断进程（SIGINT → SIGTERM → SIGKILL） */
  async interrupt(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null) return
    const pid = child.pid
    const killGroup = (signal: NodeJS.Signals) => {
      try { process.kill(-pid, signal) } catch {}
    }
    killGroup('SIGINT')
    await waitOrTimeout(child, 5000)
    if (child.exitCode !== null) return
    killGroup('SIGTERM')
    await waitOrTimeout(child, 5000)
    if (child.exitCode !== null) return
    killGroup('SIGKILL')
  }

  /** 通用：生成 session UUID */
  protected generateSessionId(): string {
    return crypto.randomUUID()
  }

  /** 通用：检查工具是否安装 */
  protected checkInstalled(cmd: string): boolean {
    try {
      execFileSync('which', [cmd], { stdio: 'ignore' })
      return true
    } catch { return false }
  }

  /** 通用：获取工具版本 */
  protected getToolVersion(cmd: string, args: string[] = ['--version']): string {
    try {
      return execFileSync(cmd, args, { encoding: 'utf-8', timeout: 5000 }).trim()
    } catch { return 'unknown' }
  }

  /**
   * 通用：spawn 工具并解析 NDJSON 流式输出。
   * 每个 driver 只需提供 CLI 命令/参数和事件解析函数。
   */
  protected runTool(opts: RunToolOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(opts.cmd, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })

      opts.onSpawn?.(child)

      let stdout = ''
      let stderr = ''
      const turnTexts: string[] = []
      const resultParts: string[] = []
      let detectedFailure: ToolFailureInfo | null = null

      // 默认文本提取：尝试常见的 NDJSON 格式
      const extractText = opts.extractText ?? defaultExtractText
      const extractResult = opts.extractResult ?? defaultExtractResult

      function handleEvent(event: Record<string, unknown>): void {
        opts.onEvent?.(event)
        const text = extractText(event).trim()
        const result = extractResult(event).trim()
        const failure = detectToolFailure(opts.cmd, event, [text, result].filter(Boolean))
        if (failure) {
          detectedFailure = failure
          return
        }

        if (text) {
          turnTexts.push(text)
          opts.onTurnText?.(text)
        }
        if (result) resultParts.push(result)

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

      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('error', reject)

      child.on('close', (code) => {
        // 处理残留 stdout
        if (stdout.trim()) {
          try { handleEvent(JSON.parse(stdout) as Record<string, unknown>) } catch {
            // 非 JSON 输出，作为纯文本结果
            if (stdout.trim() && resultParts.length === 0 && turnTexts.length === 0) {
              resultParts.push(stdout.trim())
            }
          }
        }

        const resultText = turnTexts.length > 0
          ? turnTexts.join('\n\n---\n\n')
          : resultParts.join('\n\n---\n\n')
        const stderrText = stderr.trim()
        const trailingFailure = detectedFailure
          ?? detectToolFailure(opts.cmd, null, [stderrText, resultText].filter(Boolean))

        if (trailingFailure) {
          reject(new Error(trailingFailure.userMessage))
        } else if (code === 0) {
          resolve(resultText || '(无输出)')
        } else {
          const detail = (stderrText || resultText).slice(0, 500)
          reject(new Error(detail ? `${opts.cmd} 退出码 ${code}: ${detail}` : `${opts.cmd} 退出码 ${code}`))
        }
      })
    })
  }
}

// --- 通用辅助函数 ---

function waitOrTimeout(child: ChildProcess, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    child.on('close', () => { clearTimeout(timer); resolve() })
  })
}

/** 默认文本提取：从 assistant 事件中提取 text */
function defaultExtractText(event: Record<string, unknown>): string {
  if (event.type === 'assistant') {
    const msg = event.message as Record<string, unknown> | undefined
    if (!msg || !Array.isArray(msg.content)) return ''
    const texts: string[] = []
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    }
    return texts.join('')
  }
  return ''
}

/** 默认 result 提取 */
function defaultExtractResult(event: Record<string, unknown>): string {
  if (event.type === 'result' && typeof event.result === 'string') return event.result
  return ''
}

function detectToolFailure(
  cmd: string,
  event: Record<string, unknown> | null,
  messages: string[],
): ToolFailureInfo | null {
  const rawMessage = messages.map(m => m.trim()).find(Boolean) ?? ''
  const eventError = typeof event?.error === 'string' ? event.error : ''
  const isApiError = event?.isApiErrorMessage === true || !!eventError

  if (isApiError && rawMessage) {
    return buildToolFailure(cmd, rawMessage, eventError)
  }

  if (rawMessage && looksLikeSyntheticToolError(rawMessage)) {
    return buildToolFailure(cmd, rawMessage, eventError)
  }

  return null
}

function looksLikeSyntheticToolError(message: string): boolean {
  return [
    /^you['’]ve hit your limit\b/i,
    /^api error:\s*rate limit reached\b/i,
    /\ballocationquota\./i,
    /\bfree tier\b.*\bexhausted\b/i,
  ].some(pattern => pattern.test(message))
}

function buildToolFailure(cmd: string, rawMessage: string, eventError: string): ToolFailureInfo {
  const toolName = cmd.toLowerCase() === 'claude' ? 'Claude Code' : cmd
  const normalized = rawMessage.replace(/\s+/g, ' ').trim()
  const resetMatch = normalized.match(/resets?\s+(.+)$/i)

  if (eventError === 'rate_limit' || /^you['’]ve hit your limit\b/i.test(normalized) || /\brate limit\b/i.test(normalized)) {
    const resetText = resetMatch ? `，${resetMatch[0]}` : ''
    return {
      userMessage: `${toolName} 已触发额度限制${resetText}。请稍后重试，或先切换到其他工具。`,
      rawMessage,
    }
  }

  if (/\ballocationquota\./i.test(normalized) || /\bfree tier\b.*\bexhausted\b/i.test(normalized)) {
    return {
      userMessage: `${toolName} 当前额度已耗尽。请补充额度或切换到其他工具后重试。`,
      rawMessage,
    }
  }

  return {
    userMessage: `${toolName} 执行失败: ${normalized}`,
    rawMessage,
  }
}
