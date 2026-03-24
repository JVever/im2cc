/**
 * @input:    Binding, RegisteredSession, Claude session JSONL, macOS Keychain (OAuth token), git
 * @output:   buildSessionStatus() — 构建富文本会话状态面板（/fs 和 /fc 共用）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Binding } from './session.js'
import type { RegisteredSession } from './registry.js'
import { listRegistered } from './registry.js'
import { getQueueStatus } from './queue.js'
import { pathToSlug } from './discover.js'
import { log } from './logger.js'
import { isBestEffortTool, toolDisplayName } from './support-policy.js'

// ── Formatting helpers ─────────────────────────────────────────

/** 格式化 token 数量: 1234 → "1.2K", 456789 → "457K", 1234567 → "1.2M" */
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return (n / 1000).toFixed(1) + 'K'
  if (n < 1_000_000) return Math.round(n / 1000) + 'K'
  if (n < 10_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  return Math.round(n / 1_000_000) + 'M'
}

/** 相对时间: "刚刚", "3分钟前", "2小时前", "昨天", "3天前" */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 0) return '刚刚'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 30) return `${days}天前`
  return `${Math.floor(days / 30)}个月前`
}

/** 队列状态中文 */
function queueStateCN(state: string): string {
  switch (state) {
    case 'idle': return '空闲'
    case 'busy': return '执行中'
    case 'cancelling': return '中断中'
    default: return state
  }
}

/** 工具 ID → 显示名 */
function toolLabel(tool: string): string {
  if (tool === 'claude' || tool === 'codex' || tool === 'gemini') {
    return toolDisplayName(tool) + (isBestEffortTool(tool) ? ' (best-effort)' : '')
  }
  if (tool === 'cline') return 'Cline'
  return tool
}

// ── Git branch ─────────────────────────────────────────────────

function getGitBranch(cwd: string): string | null {
  try {
    return execFileSync('git', ['-C', cwd, 'branch', '--show-current'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim() || null
  } catch {
    return null
  }
}

// ── Context tokens from Claude session JSONL ───────────────────

interface ContextInfo {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheCreation: number
  model: string
}

/**
 * 从 Claude session JSONL 末尾提取最近一条 assistant message 的 usage 和 model。
 * 只读文件尾部（最多 200KB），避免读取大文件。
 */
function getClaudeContextInfo(sessionId: string, cwd: string): ContextInfo | null {
  try {
    const slug = pathToSlug(cwd)
    const jsonlPath = path.join(os.homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`)
    if (!fs.existsSync(jsonlPath)) return null

    const stat = fs.statSync(jsonlPath)
    const TAIL_SIZE = 200 * 1024 // 200KB from end
    const start = Math.max(0, stat.size - TAIL_SIZE)

    const fd = fs.openSync(jsonlPath, 'r')
    const buf = Buffer.alloc(Math.min(TAIL_SIZE, stat.size))
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)

    const tail = buf.toString('utf-8')
    const lines = tail.split('\n')

    // Walk backwards to find the last assistant/message event with usage
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      // Quick string filter before parsing
      if (!line.includes('"usage"')) continue

      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        if (obj.type !== 'assistant') continue
        const msg = obj.message as Record<string, unknown> | undefined
        if (!msg?.usage) continue
        const usage = msg.usage as Record<string, number>
        const model = (msg.model ?? '') as string
        return {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheCreation: usage.cache_creation_input_tokens ?? 0,
          model,
        }
      } catch { /* skip malformed lines */ }
    }
  } catch (err) {
    log(`[status] 读取 context info 失败: ${err}`)
  }
  return null
}

// ── Anthropic OAuth quota ──────────────────────────────────────

interface QuotaInfo {
  fiveHourPercent: number
  fiveHourResetAt: string
  dailyPercent: number
  dailyResetAt: string
}

/** 从 macOS Keychain 读取 Claude Code OAuth token */
function readOAuthToken(): string | null {
  try {
    const raw = execFileSync('/usr/bin/security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-w',
    ], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim()
    if (!raw) return null
    // Token could be a JSON object containing access_token
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (typeof parsed.access_token === 'string') return parsed.access_token
    } catch { /* not JSON, might be the token itself */ }
    return raw
  } catch {
    return null
  }
}

/** 调用 Anthropic OAuth usage API 获取配额 */
async function fetchQuota(): Promise<QuotaInfo | null> {
  const token = readOAuthToken()
  if (!token) return null

  try {
    const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return null
    const data = await resp.json() as Record<string, unknown>

    // API 返回结构:
    // { daily: { limit, used, reset_at }, bonus: { limit, used, reset_at } }
    // 或 { five_hour: { ... }, weekly: { ... } }
    // 兼容两种格式
    const extract = (section: Record<string, unknown> | undefined): { percent: number; resetAt: string } | null => {
      if (!section) return null
      const limit = Number(section.limit ?? 0)
      const used = Number(section.used ?? 0)
      const resetAt = String(section.reset_at ?? section.resetAt ?? '')
      if (limit <= 0) return null
      return { percent: Math.round((used / limit) * 100), resetAt }
    }

    const d = data as Record<string, Record<string, unknown>>
    const fiveHour = extract(d.five_hour ?? d.fiveHour)
    const daily = extract(d.daily ?? d.weekly)

    if (!fiveHour && !daily) return null

    return {
      fiveHourPercent: fiveHour?.percent ?? 0,
      fiveHourResetAt: fiveHour?.resetAt ?? '',
      dailyPercent: daily?.percent ?? 0,
      dailyResetAt: daily?.resetAt ?? '',
    }
  } catch (err) {
    log(`[status] quota API 失败: ${err}`)
    return null
  }
}

// ── Main status builder ────────────────────────────────────────

export interface StatusOptions {
  /** 是否获取配额（异步 HTTP，/fs 时启用，/fc 时也启用） */
  includeQuota?: boolean
}

/**
 * 构建富文本会话状态面板。
 * 共用于 /fs 和 /fc 连接成功后。
 */
export async function buildSessionStatus(
  binding: Binding,
  opts: StatusOptions = {},
): Promise<string> {
  const { includeQuota = true } = opts

  // 基础信息
  const regEntry = listRegistered().find(r => r.sessionId === binding.sessionId)
  const sessionName = regEntry?.name ?? '(未注册)'
  const tool = regEntry?.tool ?? binding.tool ?? 'claude'
  const projectName = path.basename(binding.cwd)
  const qs = getQueueStatus(binding.conversationId)

  // 并行获取可选数据
  const gitBranch = getGitBranch(binding.cwd)
  const contextInfo = tool === 'claude'
    ? getClaudeContextInfo(binding.sessionId, binding.cwd)
    : null

  const quotaPromise = includeQuota ? fetchQuota() : Promise.resolve(null)
  const quota = await quotaPromise

  // ── Build output ──

  const lines: string[] = []

  // Header
  lines.push(`┌─ ${sessionName} ─────────────────────`)
  lines.push(`│`)

  // Session info
  lines.push(`│  工具      ${toolLabel(tool)}`)
  lines.push(`│  项目      ${projectName}`)
  lines.push(`│  目录      ${binding.cwd}`)
  if (gitBranch) {
    lines.push(`│  分支      ${gitBranch}`)
  }

  lines.push(`│`)

  // Runtime status
  lines.push(`│  模式      ${binding.permissionMode}`)
  lines.push(`│  轮次      ${binding.turnCount}`)

  const stateStr = queueStateCN(qs.state)
  const queueSuffix = qs.queueLength > 0 ? ` (队列 ${qs.queueLength})` : ''
  lines.push(`│  状态      ${stateStr}${queueSuffix}`)

  // Context tokens (Claude only)
  if (contextInfo) {
    const totalInput = contextInfo.inputTokens + contextInfo.cacheRead + contextInfo.cacheCreation
    const totalAll = totalInput + contextInfo.outputTokens
    lines.push(`│`)
    lines.push(`│  上下文    ${formatTokens(totalAll)} tokens`)
    if (contextInfo.cacheRead > 0) {
      lines.push(`│    输入    ${formatTokens(contextInfo.inputTokens)}  缓存 ${formatTokens(contextInfo.cacheRead)}`)
    }
    lines.push(`│    输出    ${formatTokens(contextInfo.outputTokens)}`)
    if (contextInfo.model) {
      lines.push(`│  模型      ${contextInfo.model}`)
    }
  }

  // Quota
  if (quota) {
    lines.push(`│`)
    const fiveHourReset = quota.fiveHourResetAt ? ` (${formatResetTime(quota.fiveHourResetAt)})` : ''
    const dailyReset = quota.dailyResetAt ? ` (${formatResetTime(quota.dailyResetAt)})` : ''
    lines.push(`│  5h 配额   ${quota.fiveHourPercent}%${fiveHourReset}`)
    lines.push(`│  日配额    ${quota.dailyPercent}%${dailyReset}`)
  }

  // Last active
  lines.push(`│`)
  lines.push(`│  活跃      ${relativeTime(binding.lastActiveAt)}`)

  // Footer
  const hint = regEntry ? `im2cc open ${regEntry.name}` : 'fc <名称>'
  lines.push(`│`)
  lines.push(`│  回到电脑  ${hint}`)
  lines.push(`└──────────────────────────────────`)

  return lines.join('\n')
}

/** 格式化配额重置时间为简洁中文 */
function formatResetTime(iso: string): string {
  if (!iso) return ''
  try {
    const reset = new Date(iso)
    const now = new Date()
    const diffMs = reset.getTime() - now.getTime()
    if (diffMs <= 0) return '即将重置'
    const minutes = Math.floor(diffMs / 60000)
    if (minutes < 60) return `${minutes}分后重置`
    const hours = Math.floor(minutes / 60)
    const remainMin = minutes % 60
    if (remainMin === 0) return `${hours}h后重置`
    return `${hours}h${remainMin}m后重置`
  } catch {
    return ''
  }
}
