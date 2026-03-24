/**
 * @input:    Codex CLI (`codex` 命令), session ID, 用户消息
 * @output:   CodexDriver (ToolDriver 实现) — OpenAI Codex CLI 驱动
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BaseToolDriver, selectTurns, formatRecap, type RecapTurn } from './base-driver.js'
import { filterInitTurns } from './recap.js'
import { registerDriver, type ToolCapabilities, type CreateSessionResult, type SendMessageOptions } from './tool-driver.js'
import { log } from './logger.js'

export class CodexDriver extends BaseToolDriver {
  readonly id = 'codex' as const
  readonly capabilities: ToolCapabilities = {
    supportsResume: true,
    supportsDiscovery: false,
    supportsInterrupt: true,
  }

  getVersion(): string { return this.getToolVersion('codex') }
  isAvailable(): boolean { return this.checkInstalled('codex') }

  async createSession(cwd: string, permissionMode: string, _name?: string): Promise<CreateSessionResult> {
    let sessionId: string | null = null
    const output = await this.runTool({
      cmd: 'codex',
      message: '会话已建立。',
      args: ['exec', '--json', '--skip-git-repo-check', ...codexPermArgs(permissionMode), '会话已建立。请回复"就绪"。'],
      cwd,
      onEvent: (event) => {
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          sessionId = event.thread_id
        }
      },
      extractText: codexExtractText,
      extractResult: codexExtractResult,
    })
    if (!sessionId) {
      throw new Error('Codex 未返回 thread_id，无法创建可恢复会话')
    }
    return { sessionId, output }
  }

  sendMessage(sessionId: string, message: string, cwd: string, permissionMode: string, opts?: SendMessageOptions): Promise<string> {
    // Codex resume: codex exec resume <ID> "msg"
    const args = ['exec', 'resume', sessionId, '--json', '--skip-git-repo-check', ...codexPermArgs(permissionMode), message]

    return this.runTool({
      cmd: 'codex',
      message,
      args,
      cwd,
      onSpawn: opts?.onSpawn,
      outputFile: opts?.outputFile,
      onTurnText: opts?.onTurnText,
      extractText: codexExtractText,
      extractResult: codexExtractResult,
    })
  }

  /** Codex recap：从 ~/.codex/sessions/ 中按 thread_id 或最近文件查找 */
  override buildRecap(sessionId: string, cwd: string, budget: number): string | null {
    if (budget <= 0) return null
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions')
    if (!fs.existsSync(sessionsDir)) return null

    // 策略 1：按 sessionId（thread_id）在文件名中匹配
    let targetFile = findCodexSessionFile(sessionsDir, sessionId)
    // 策略 2：按 cwd 匹配最近的 session_meta 中 cwd 相同的文件
    if (!targetFile) targetFile = findMostRecentCodexSessionByCwd(sessionsDir, cwd)
    if (!targetFile) {
      log(`[codex-driver] recap: 未找到 session 文件 (threadId=${sessionId.slice(0, 8)})`)
      return null
    }

    try {
      const content = fs.readFileSync(targetFile, 'utf-8')
      const turns = extractCodexTurns(content)
      const meaningful = filterInitTurns(turns)
      if (meaningful.length === 0) return null
      const selected = selectTurns(meaningful, budget)
      return selected.length > 0 ? formatRecap(selected, budget) : null
    } catch (err) {
      log(`[codex-driver] recap: 读取失败: ${err}`)
      return null
    }
  }
}

registerDriver(new CodexDriver())

// --- Codex 专有 ---

function codexPermArgs(mode: string): string[] {
  if (mode === 'YOLO') return ['--full-auto']
  return []
}

/** Codex NDJSON 事件文本提取 */
function codexExtractText(event: Record<string, unknown>): string {
  // Codex 的 NDJSON 格式：{type: "message", content: "..."}
  if (event.type === 'message' && typeof event.content === 'string') return event.content
  // 或者 content 是数组
  if (event.type === 'message' && Array.isArray(event.content)) {
    return (event.content as Array<Record<string, unknown>>)
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join('')
  }
  if (event.type === 'item.completed') {
    const item = event.item as Record<string, unknown> | undefined
    if (item?.type === 'agent_message' && typeof item.text === 'string') {
      return item.text
    }
  }
  return ''
}

function codexExtractResult(event: Record<string, unknown>): string {
  if (event.type === 'result' && typeof event.result === 'string') return event.result
  return ''
}

/** 从 Codex JSONL 内容中提取对话轮次 */
function extractCodexTurns(content: string): RecapTurn[] {
  const turns: RecapTurn[] = []
  let currentUser = ''
  let currentAssistant: string[] = []

  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(line) } catch { continue }

    // event_msg with payload.type='user_message' → 用户文本
    if (d.type === 'event_msg') {
      const payload = d.payload as Record<string, unknown> | undefined
      if (payload?.type === 'user_message' && typeof payload.message === 'string') {
        const text = (payload.message as string).trim()
        if (text) {
          if (currentUser) {
            const aText = currentAssistant.join('\n').trim()
            if (aText) turns.push({ user: currentUser, assistant: aText })
          }
          currentUser = text
          currentAssistant = []
        }
      }
      continue
    }

    // response_item → 用户或 assistant 的内容
    const payload = d.payload as Record<string, unknown> | undefined
    if (!payload) continue

    if (payload.role === 'user') {
      const c = payload.content
      if (!Array.isArray(c)) continue
      const text = (c as Array<Record<string, unknown>>)
        .filter(b => b?.type === 'input_text' && typeof b.text === 'string')
        .map(b => b.text as string)
        .join('')
        .trim()
      // 跳过 environment_context / instructions 等系统注入
      if (!text || text.includes('<environment_context') || text.includes('<instructions')) continue
      if (currentUser) {
        const aText = currentAssistant.join('\n').trim()
        if (aText) turns.push({ user: currentUser, assistant: aText })
      }
      currentUser = text
      currentAssistant = []
    }
    if (payload.role === 'assistant') {
      const c = payload.content
      if (Array.isArray(c)) {
        for (const b of c as Array<Record<string, unknown>>) {
          if (b?.type === 'output_text' && typeof b.text === 'string') {
            currentAssistant.push(b.text as string)
          }
        }
      }
    }
  }
  if (currentUser) {
    const aText = currentAssistant.join('\n').trim()
    if (aText) turns.push({ user: currentUser, assistant: aText })
  }
  return turns
}

/** 在 Codex sessions 目录中按 thread_id 匹配文件 */
function findCodexSessionFile(sessionsDir: string, threadId: string): string | null {
  try {
    // 递归搜索包含 threadId 的文件名
    const search = (dir: string): string | null => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          const found = search(full)
          if (found) return found
        } else if (entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
          return full
        }
      }
      return null
    }
    return search(sessionsDir)
  } catch { return null }
}

/** 在 Codex sessions 中找到最近一个匹配 cwd 的 session 文件 */
function findMostRecentCodexSessionByCwd(sessionsDir: string, cwd: string): string | null {
  try {
    const allFiles: { path: string; mtime: number }[] = []
    const collect = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) collect(full)
        else if (entry.name.endsWith('.jsonl')) {
          allFiles.push({ path: full, mtime: fs.statSync(full).mtimeMs })
        }
      }
    }
    collect(sessionsDir)

    // 按修改时间倒序，找第一个 cwd 匹配的
    allFiles.sort((a, b) => b.mtime - a.mtime)
    const resolvedCwd = path.resolve(cwd)

    for (const f of allFiles.slice(0, 20)) { // 只查最近 20 个
      try {
        const firstLine = fs.readFileSync(f.path, 'utf-8').split('\n')[0]
        const d = JSON.parse(firstLine)
        if (d.type === 'session_meta' && d.payload?.cwd === resolvedCwd) return f.path
      } catch { continue }
    }
    return null
  } catch { return null }
}
