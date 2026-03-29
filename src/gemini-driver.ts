/**
 * @input:    Gemini CLI (`gemini` 命令), session ID, 用户消息
 * @output:   GeminiDriver (ToolDriver 实现) — Google Gemini CLI 驱动
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BaseToolDriver } from './base-driver.js'
import { filterInitTurns, type RecapTurn } from './recap.js'
import { registerDriver, type ToolCapabilities, type CreateSessionResult, type SendMessageOptions } from './tool-driver.js'
import { log } from './logger.js'

export class GeminiDriver extends BaseToolDriver {
  readonly id = 'gemini' as const
  readonly capabilities: ToolCapabilities = {
    supportsResume: true,
    supportsDiscovery: false,
    supportsInterrupt: true,
  }

  getVersion(): string { return this.getToolVersion('gemini') }
  isAvailable(): boolean { return this.checkInstalled('gemini') }

  async createSession(cwd: string, permissionMode: string, _name?: string): Promise<CreateSessionResult> {
    let sessionId: string | null = null
    const output = await this.runTool({
      cmd: 'gemini',
      message: '会话已建立。',
      args: ['-p', '会话已建立。请回复"就绪"。', '--output-format', 'stream-json', ...geminiPermArgs(permissionMode)],
      cwd,
      onEvent: (event) => {
        if (typeof event.session_id === 'string') {
          sessionId = event.session_id
        }
      },
      extractText: geminiExtractText,
      extractResult: geminiExtractResult,
    })
    if (!sessionId) {
      throw new Error('Gemini 未返回 session_id，无法创建可恢复会话')
    }
    return { sessionId, output }
  }

  sendMessage(sessionId: string, message: string, cwd: string, permissionMode: string, opts?: SendMessageOptions): Promise<string> {
    // Gemini resume: gemini --resume <UUID> -p "msg" --output-format stream-json
    return this.runTool({
      cmd: 'gemini',
      message,
      args: ['--resume', sessionId, '-p', message, '--output-format', 'stream-json', ...geminiPermArgs(permissionMode)],
      cwd,
      onSpawn: opts?.onSpawn,
      outputFile: opts?.outputFile,
      onTurnText: opts?.onTurnText,
      extractText: geminiExtractText,
      extractResult: geminiExtractResult,
    })
  }

  /** Gemini recap：从 ~/.gemini/tmp/{projectName}/chats/ 中找到 session JSON 并提取对话 */
  buildRecapTurn(sessionId: string, cwd: string, budget: number): RecapTurn | null {
    if (budget <= 0) return null

    // Find session file: ~/.gemini/tmp/{projectName}/chats/ where projectName is basename of cwd
    const projectName = path.basename(cwd)
    const chatsDir = path.join(os.homedir(), '.gemini', 'tmp', projectName, 'chats')
    if (!fs.existsSync(chatsDir)) return null

    // Find session file matching sessionId or most recent
    let targetFile: string | null = null
    try {
      const files = fs.readdirSync(chatsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(chatsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)

      // Try matching sessionId
      for (const f of files) {
        if (f.name.includes(sessionId.slice(0, 8))) { targetFile = path.join(chatsDir, f.name); break }
      }
      // Fallback: most recent
      if (!targetFile && files.length > 0) targetFile = path.join(chatsDir, files[0].name)
    } catch { return null }

    if (!targetFile) return null

    try {
      const data = JSON.parse(fs.readFileSync(targetFile, 'utf-8')) as Record<string, unknown>
      const messages = data.messages as Array<Record<string, unknown>> ?? []

      const turns: RecapTurn[] = []
      let currentUser = ''
      let currentAssistant: string[] = []

      for (const msg of messages) {
        const type = msg.type as string ?? msg.role as string ?? ''
        const content = msg.content as Array<Record<string, unknown>> | string ?? ''

        let text = ''
        if (typeof content === 'string') text = content
        else if (Array.isArray(content)) {
          text = content.filter(c => typeof c.text === 'string').map(c => c.text as string).join('')
        }
        if (!text.trim()) continue

        if (type === 'user') {
          if (currentUser) {
            const aText = currentAssistant.join('\n').trim()
            if (aText) turns.push({ user: currentUser, assistant: aText })
          }
          currentUser = text.trim()
          currentAssistant = []
        }
        if (type === 'gemini' || type === 'assistant' || type === 'model') {
          currentAssistant.push(text.trim())
        }
      }
      if (currentUser) {
        const aText = currentAssistant.join('\n').trim()
        if (aText) turns.push({ user: currentUser, assistant: aText })
      }
      const meaningful = filterInitTurns(turns)
      return meaningful.at(-1) ?? null
    } catch { return null }
  }
}

registerDriver(new GeminiDriver())

// --- Gemini 专有 ---

/** Gemini JSON 输出提取：{response: "...", ...} 或 NDJSON 事件 */
function geminiExtractText(event: Record<string, unknown>): string {
  if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
    return event.content
  }
  if (typeof event.response === 'string') return event.response
  if (event.type === 'assistant') {
    const msg = event.message as Record<string, unknown> | undefined
    if (msg && Array.isArray(msg.content)) {
      return (msg.content as Array<Record<string, unknown>>)
        .filter(b => b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text as string).join('')
    }
  }
  return ''
}

function geminiExtractResult(event: Record<string, unknown>): string {
  if (event.type === 'result') {
    if (typeof event.result === 'string') return event.result
    if (event.status === 'success') return ''
  }
  if (typeof event.response === 'string') return event.response
  return ''
}

import { getModeCliArgs, migrateLegacyMode } from './mode-policy.js'

function geminiPermArgs(mode: string): string[] {
  const native = migrateLegacyMode(mode, 'gemini')
  return getModeCliArgs('gemini', native)
}
