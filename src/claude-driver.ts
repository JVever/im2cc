/**
 * @input:    Claude Code CLI (`claude` 命令), session ID, 用户消息
 * @output:   ClaudeDriver (ToolDriver 实现) + 兼容导出 — Claude Code 生命周期管理
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { log } from './logger.js'
import { pathToSlug } from './discover.js'
import { BaseToolDriver, selectTurns, formatRecap, type RecapTurn } from './base-driver.js'
import { filterInitTurns } from './recap.js'
import { registerDriver, type ToolCapabilities, type CreateSessionResult, type SendMessageOptions, type SessionFileStatus } from './tool-driver.js'
import { claudeSessionNameArgs } from './tool-compat.js'

export class ClaudeDriver extends BaseToolDriver {
  readonly id = 'claude' as const
  readonly capabilities: ToolCapabilities = {
    supportsResume: true,
    supportsDiscovery: true,
    supportsInterrupt: true,
  }

  getVersion(): string {
    return this.getToolVersion('claude')
  }

  isAvailable(): boolean {
    return this.checkInstalled('claude')
  }

  async createSession(cwd: string, permissionMode: string, name?: string): Promise<CreateSessionResult> {
    const sessionId = this.generateSessionId()
    const output = await this.runTool({
      cmd: 'claude',
      message: '会话已建立。请回复"就绪"。',
      args: ['-p', '会话已建立。请回复"就绪"。', '--session-id', sessionId, ...claudeSessionNameArgs(name), '--output-format', 'stream-json', '--verbose', ...permissionArgs(permissionMode)],
      cwd,
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

    const sessionFlag = status === 'here' ? ['--resume', sessionId] : ['--session-id', sessionId]

    return this.runTool({
      cmd: 'claude',
      message,
      args: ['-p', message, ...sessionFlag, '--output-format', 'stream-json', '--verbose', ...permissionArgs(permissionMode)],
      cwd,
      onSpawn: opts?.onSpawn,
      outputFile: opts?.outputFile,
      onTurnText: opts?.onTurnText,
    })
  }

  /** Claude 专有：session 文件三态检查 */
  override checkSessionFile(sessionId: string, cwd: string): SessionFileStatus {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects')
    const expectedSlug = pathToSlug(cwd)
    const expectedPath = path.join(projectsDir, expectedSlug, `${sessionId}.jsonl`)

    if (fs.existsSync(expectedPath)) return 'here'

    try {
      for (const slug of fs.readdirSync(projectsDir)) {
        if (slug === expectedSlug) continue
        if (fs.existsSync(path.join(projectsDir, slug, `${sessionId}.jsonl`))) return 'elsewhere'
      }
    } catch {}

    return 'missing'
  }

  /** Claude 专有 recap：从 ~/.claude/projects/{slug}/{sessionId}.jsonl 提取最近对话 */
  override buildRecap(sessionId: string, cwd: string, budget: number): string | null {
    if (budget <= 0) return null
    const filePath = path.join(os.homedir(), '.claude', 'projects', pathToSlug(cwd), `${sessionId}.jsonl`)
    if (!fs.existsSync(filePath)) {
      log(`[claude-driver] recap: session 文件不存在: ${filePath}`)
      return null
    }
    let content: string
    try { content = fs.readFileSync(filePath, 'utf-8') } catch { return null }

    const turns: RecapTurn[] = []
    let currentUserText = ''
    let currentAssistantTexts: string[] = []

    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try { obj = JSON.parse(line) } catch { continue }
      if (obj.type !== 'user' && obj.type !== 'assistant') continue
      const msg = obj.message as Record<string, unknown> | undefined
      if (!msg) continue

      if (obj.type === 'user') {
        const c = msg.content
        if (typeof c !== 'string') continue
        // 跳过系统注入的 local-command 消息
        if (c.includes('<local-command-')) continue
        if (currentUserText) {
          const aText = currentAssistantTexts.join('\n').trim()
          if (aText) turns.push({ user: currentUserText, assistant: aText })
        }
        currentUserText = c.trim()
        currentAssistantTexts = []
      }
      if (obj.type === 'assistant') {
        const c = msg.content
        if (Array.isArray(c)) {
          for (const b of c as Array<Record<string, unknown>>) {
            if (b.type === 'text' && typeof b.text === 'string') currentAssistantTexts.push(b.text)
          }
        } else if (typeof c === 'string' && c) {
          currentAssistantTexts.push(c)
        }
      }
    }
    if (currentUserText) {
      const aText = currentAssistantTexts.join('\n').trim()
      if (aText) turns.push({ user: currentUserText, assistant: aText })
    }

    const meaningful = filterInitTurns(turns)
    if (meaningful.length === 0) return null
    const selected = selectTurns(meaningful, budget)
    return selected.length > 0 ? formatRecap(selected, budget) : null
  }
}

// 自动注册（单实例，兼容导出复用同一个）
const _driver = new ClaudeDriver()
registerDriver(_driver)

export function getClaudeVersion(): string { return _driver.getVersion() }
export async function createSession(cwd: string, permissionMode: string, name?: string): Promise<CreateSessionResult> {
  return _driver.createSession(cwd, permissionMode, name)
}
export function sendMessage(sessionId: string, message: string, cwd: string, permissionMode: string, opts?: SendMessageOptions): Promise<string> {
  return _driver.sendMessage(sessionId, message, cwd, permissionMode, opts)
}
export function killLocalSession(sessionName: string): boolean { return _driver.killLocalSession(sessionName) }
export function checkSessionFile(sessionId: string, cwd: string): SessionFileStatus { return _driver.checkSessionFile(sessionId, cwd) }

// --- Claude 专有辅助 ---

import { getModeCliArgs, migrateLegacyMode } from './mode-policy.js'

function permissionArgs(mode: string): string[] {
  const native = migrateLegacyMode(mode, 'claude')
  return getModeCliArgs('claude', native)
}
