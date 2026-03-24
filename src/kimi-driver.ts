/**
 * @input:    Kimi Code CLI (`kimi` 命令), session ID, 用户消息
 * @output:   KimiDriver (ToolDriver 实现) — Moonshot Kimi Code CLI 驱动
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import { BaseToolDriver, selectTurns, formatRecap, type RecapTurn } from './base-driver.js'
import { filterInitTurns } from './recap.js'
import { registerDriver, type ToolCapabilities, type CreateSessionResult, type SendMessageOptions } from './tool-driver.js'
import { log } from './logger.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export class KimiDriver extends BaseToolDriver {
  readonly id = 'kimi' as const
  readonly capabilities: ToolCapabilities = {
    supportsResume: true,
    supportsDiscovery: false,
    supportsInterrupt: true,
  }

  getVersion(): string { return this.getToolVersion('kimi') }
  isAvailable(): boolean { return this.checkInstalled('kimi') }

  async createSession(cwd: string, permissionMode: string, _name?: string): Promise<CreateSessionResult> {
    const before = listKimiSessionIds(cwd)
    const output = await this.runTool({
      cmd: 'kimi',
      message: '会话已建立。',
      args: ['--print', '-p', '会话已建立。请回复"就绪"。', '--output-format=stream-json', ...kimiPermArgs(permissionMode)],
      cwd,
      extractText: kimiExtractText,
      extractResult: kimiExtractResult,
    })
    const sessionId = detectCreatedKimiSessionId(cwd, before)
    if (!sessionId) {
      throw new Error('Kimi 未能识别新 session_id，无法创建可恢复会话')
    }
    return { sessionId, output }
  }

  sendMessage(sessionId: string, message: string, cwd: string, permissionMode: string, opts?: SendMessageOptions): Promise<string> {
    // Kimi resume: kimi --session <ID> --print -p "msg" --output-format=stream-json
    return this.runTool({
      cmd: 'kimi',
      message,
      args: ['--session', sessionId, '--print', '-p', message, '--output-format=stream-json', ...kimiPermArgs(permissionMode)],
      cwd,
      onSpawn: opts?.onSpawn,
      outputFile: opts?.outputFile,
      onTurnText: opts?.onTurnText,
      extractText: kimiExtractText,
      extractResult: kimiExtractResult,
    })
  }

  /** Kimi recap：从 ~/.kimi/sessions/{md5(cwd)}/{sessionId}/context.jsonl 提取最近对话 */
  override buildRecap(sessionId: string, cwd: string, budget: number): string | null {
    if (budget <= 0) return null
    const dir = kimiSessionsDir(cwd)
    const contextFile = path.join(dir, sessionId, 'context.jsonl')
    if (!fs.existsSync(contextFile)) {
      log(`[kimi-driver] recap: context.jsonl 不存在: ${contextFile}`)
      return null
    }

    try {
      const content = fs.readFileSync(contextFile, 'utf-8')
      const turns: RecapTurn[] = []
      let currentUser = ''
      let currentAssistant: string[] = []

      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        let d: Record<string, unknown>
        try { d = JSON.parse(line) } catch { continue }

        const role = d.role as string ?? ''
        // 跳过 _checkpoint / _usage / tool 等非对话行
        if (role.startsWith('_') || role === 'tool') continue

        if (role === 'user' || role === 'human') {
          let text = extractTextContent(d)
          if (!text) continue
          // 跳过 Kimi 的系统注入 <system> 前缀
          text = text.replace(/^<system>[^<]*<\/system>\s*/s, '').trim()
          if (!text) continue
          if (currentUser) {
            const aText = currentAssistant.join('\n').trim()
            if (aText) turns.push({ user: currentUser, assistant: aText })
          }
          currentUser = text
          currentAssistant = []
        }
        if (role === 'assistant' || role === 'model') {
          const text = extractTextContent(d)
          if (text) currentAssistant.push(text)
        }
      }
      if (currentUser) {
        const aText = currentAssistant.join('\n').trim()
        if (aText) turns.push({ user: currentUser, assistant: aText })
      }

      const meaningful = filterInitTurns(turns)
      if (meaningful.length === 0) return null
      const selected = selectTurns(meaningful, budget)
      return selected.length > 0 ? formatRecap(selected, budget) : null
    } catch (err) {
      log(`[kimi-driver] recap: 读取失败: ${err}`)
      return null
    }
  }
}

registerDriver(new KimiDriver())

/** 从 JSONL 行中提取文本内容（兼容 string 和 content-block 数组格式） */
function extractTextContent(d: Record<string, unknown>): string {
  const content = d.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => typeof b === 'object' && b !== null)
      .map((b: any) => b.text ?? '')
      .filter(Boolean)
      .join('')
      .trim()
  }
  return ''
}

function kimiPermArgs(mode: string): string[] {
  switch (mode) {
    case 'YOLO':
      return ['--yolo']
    case 'auto-edit':
    case 'default':
    default:
      return []
  }
}

function kimiExtractText(event: Record<string, unknown>): string {
  if (event.role === 'assistant') {
    const content = event.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter((part): part is Record<string, unknown> => !!part && typeof part === 'object')
        .map(part => {
          if (typeof part.text === 'string') return part.text
          if (part.type === 'text' && typeof part.text === 'string') return part.text
          return ''
        })
        .join('')
    }
  }
  if (event.type === 'result' && typeof event.result === 'string') return event.result
  return ''
}

function kimiExtractResult(event: Record<string, unknown>): string {
  if (event.role === 'assistant') return kimiExtractText(event)
  if (event.type === 'result' && typeof event.result === 'string') return event.result
  return ''
}

function kimiSessionsDir(cwd: string): string {
  const hash = crypto.createHash('md5').update(path.resolve(cwd)).digest('hex')
  return path.join(os.homedir(), '.kimi', 'sessions', hash)
}

function listKimiSessionIds(cwd: string): Set<string> {
  const dir = kimiSessionsDir(cwd)
  try {
    return new Set(
      fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name),
    )
  } catch {
    return new Set()
  }
}

function detectCreatedKimiSessionId(cwd: string, before: Set<string>): string | null {
  const dir = kimiSessionsDir(cwd)
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !before.has(entry.name))
      .map(entry => {
        const sessionDir = path.join(dir, entry.name)
        const stat = fs.statSync(sessionDir)
        return { sessionId: entry.name, mtimeMs: stat.mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return entries[0]?.sessionId ?? null
  } catch {
    return null
  }
}
