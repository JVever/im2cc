/**
 * @input:    Claude Code CLI (`claude` 命令), session ID, Session 精确模型, 用户消息
 * @output:   ClaudeDriver (ToolDriver 实现) + 兼容导出 — Claude Code 生命周期管理（创建/发送显式继承模型）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { log } from './logger.js'
import { pathToSlug } from './discover.js'
import { BaseToolDriver } from './base-driver.js'
import { filterInitTurns, type RecapTurn } from './recap.js'
import { registerDriver, type ToolCapabilities, type CreateSessionOptions, type CreateSessionResult, type SendMessageOptions, type SessionFileStatus } from './tool-driver.js'
import { claudeSessionNameArgs } from './tool-compat.js'
import { buildClaudeLauncherEnv, getClaudeLauncher, injectAskUserHookSettings } from './claude-launcher.js'
import { lookupBySessionId } from './registry.js'

export class ClaudeDriver extends BaseToolDriver {
  readonly id = 'claude' as const
  readonly capabilities: ToolCapabilities = {
    supportsResume: true,
    supportsDiscovery: true,
    supportsInterrupt: true,
    supportsBtw: true,
    officeDocStrategy: 'native',
  }

  getVersion(): string {
    try {
      const result = spawnSync(getClaudeLauncher(), ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildClaudeLauncherEnv({ phase: 'version' }),
      })
      return result.status === 0 ? String(result.stdout ?? '').trim() || 'unknown' : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  isAvailable(): boolean {
    try {
      const result = spawnSync(getClaudeLauncher(), ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildClaudeLauncherEnv({ phase: 'version' }),
      })
      return result.status === 0
    } catch {
      return false
    }
  }

  async createSession(cwd: string, permissionMode: string, name?: string, opts?: CreateSessionOptions): Promise<CreateSessionResult> {
    const sessionId = this.generateSessionId()
    const askUser = opts?.conversationId
      ? injectAskUserHookSettings({ sessionId, conversationId: opts.conversationId })
      : null
    const settingsArgs = askUser ? ['--settings', askUser.settingsPath] : []
    const env = mergeAskUserEnv(
      buildClaudeLauncherEnv({ phase: 'create', sessionId, sessionName: name, profile: opts?.claudeProfile }),
      askUser?.env,
    )
    const modelArgs = opts?.selectedModelId ? ['--model', opts.selectedModelId] : []
    const output = await this.runTool({
      cmd: getClaudeLauncher(),
      message: '会话已建立。请回复"就绪"。',
      args: ['-p', '会话已建立。请回复"就绪"。', '--session-id', sessionId, ...claudeSessionNameArgs(name), ...settingsArgs, ...modelArgs, '--output-format', 'stream-json', '--verbose', ...permissionArgs(permissionMode)],
      cwd,
      env,
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

    const reg = lookupBySessionId(sessionId)

    const askUser = opts?.conversationId
      ? injectAskUserHookSettings({ sessionId, conversationId: opts.conversationId })
      : null
    const settingsArgs = askUser ? ['--settings', askUser.settingsPath] : []
    const env = mergeAskUserEnv(
      buildClaudeLauncherEnv({ phase: 'send', sessionId, sessionName: reg?.name, profile: reg?.claudeProfile }),
      askUser?.env,
    )

    const modelArgs = opts?.modelOverride ? ['--model', opts.modelOverride] : []
    // @20260513-im-btw-side-fork REVISION: /btw fork turn 注入工具黑名单
    const disallowedArgs = opts?.disallowedTools && opts.disallowedTools.length > 0
      ? ['--disallowed-tools', opts.disallowedTools.join(' ')]
      : []

    return this.runTool({
      cmd: getClaudeLauncher(),
      message,
      args: ['-p', message, ...sessionFlag, ...settingsArgs, ...modelArgs, ...disallowedArgs, '--output-format', 'stream-json', '--verbose', ...permissionArgs(permissionMode)],
      cwd,
      env,
      onSpawn: opts?.onSpawn,
      outputFile: opts?.outputFile,
      onTurnText: opts?.onTurnText,
      onTurnEvent: opts?.onTurnEvent,
    })
  }

  /**
   * Claude 专有：fork 当前 session 为一个临时 session（@20260513-im-btw-side-fork）。
   * 纯 OS 层 cp，无需修改文件内 sessionId 字段（spike 实证 Claude --resume 接受文件名/字段不一致）。
   * 返回新生成的 fork sessionId（UUID v4）。
   */
  forkSession(sessionId: string, cwd: string): string {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects')
    const slug = pathToSlug(cwd)
    const baseline = path.join(projectsDir, slug, `${sessionId}.jsonl`)
    if (!fs.existsSync(baseline)) {
      throw new Error(`Claude session 文件不存在: ${baseline}`)
    }
    const forkId = crypto.randomUUID()
    const forkPath = path.join(projectsDir, slug, `${forkId}.jsonl`)
    fs.copyFileSync(baseline, forkPath)
    return forkId
  }

  /**
   * 清理 fork session 文件。turn finally 路径调用，幂等：文件不存在视为已清理。
   */
  deleteForkSession(forkId: string, cwd: string): void {
    const forkPath = path.join(os.homedir(), '.claude', 'projects', pathToSlug(cwd), `${forkId}.jsonl`)
    try {
      fs.unlinkSync(forkPath)
    } catch {
      // 文件已不存在或权限问题：忽略（fork 文件极小，孤儿不致命）
    }
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
  override buildRecapTurn(sessionId: string, cwd: string, budget: number): RecapTurn | null {
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
    return meaningful.at(-1) ?? null
  }
}

// 自动注册（单实例，兼容导出复用同一个）
const _driver = new ClaudeDriver()
registerDriver(_driver)

export function getClaudeVersion(): string { return _driver.getVersion() }
export async function createSession(cwd: string, permissionMode: string, name?: string, opts?: CreateSessionOptions): Promise<CreateSessionResult> {
  return _driver.createSession(cwd, permissionMode, name, opts)
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

/**
 * 合并 launcher env 与 askuser hook env。
 * - launcher 已含 process.env 完整副本，askuser env 只是少量 IM2CC_* 变量，覆盖叠加即可
 * - 无 launcher 时 launcherEnv 为 undefined，则以 process.env 为基底叠加 askuser env
 * - 无 askuser env 时直接返回 launcherEnv（保持旧行为）
 */
function mergeAskUserEnv(
  launcherEnv: NodeJS.ProcessEnv | undefined,
  askUserEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!askUserEnv) return launcherEnv
  if (!launcherEnv) return { ...process.env, ...askUserEnv }
  return { ...launcherEnv, ...askUserEnv }
}
