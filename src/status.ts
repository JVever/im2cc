/**
 * @input:    Binding, RegisteredSession, Claude/Codex session files, macOS Keychain (OAuth), git
 * @output:   buildSessionStatus() — 构建会话状态面板（/fs 和 /fc 共用）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Binding } from './session.js'
import { listRegistered } from './registry.js'
import { getQueueStatus } from './queue.js'
import { pathToSlug } from './discover.js'
import { log } from './logger.js'

// ── Formatting helpers ─────────────────────────────────────────

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return (n / 1000).toFixed(1) + 'K'
  if (n < 1_000_000) return Math.round(n / 1000) + 'K'
  if (n < 10_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  return Math.round(n / 1_000_000) + 'M'
}

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

function queueStateCN(state: string): string {
  switch (state) {
    case 'idle': return '空闲'
    case 'busy': return '执行中'
    case 'cancelling': return '中断中'
    default: return state
  }
}

function toolLabel(tool: string): string {
  switch (tool) {
    case 'claude': return 'Claude Code'
    case 'codex': return 'Codex'
    case 'gemini': return 'Gemini'
    default: return tool
  }
}

function shortModelName(model: string): string {
  return model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')  // strip date suffix
}

/** 格式化重置时间：始终精确到小时分钟 */
function formatResetTime(resetTime: Date | string | number): string {
  try {
    const reset = typeof resetTime === 'number'
      ? new Date(resetTime * 1000)  // Unix seconds
      : new Date(resetTime)
    const now = new Date()
    const diffMs = reset.getTime() - now.getTime()
    if (diffMs <= 0) return '即将重置'
    const totalMin = Math.floor(diffMs / 60000)
    const hours = Math.floor(totalMin / 60)
    const mins = totalMin % 60
    if (hours === 0) return `${mins}分钟后重置`
    if (mins === 0) return `${hours}小时后重置`
    return `${hours}小时${mins}分钟后重置`
  } catch {
    return ''
  }
}

function progressBar(percent: number, width: number = 10): string {
  const filled = Math.round((percent / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// ── Git branch ─────────────────────────────────────────────────

function getGitBranch(cwd: string): string | null {
  try {
    return execFileSync('git', ['-C', cwd, 'branch', '--show-current'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000,
    }).trim() || null
  } catch { return null }
}

// ── 统一的上下文 + 配额数据结构 ──────────────────────────────

interface ContextInfo {
  inputTokens: number
  outputTokens: number
  cacheTokens: number  // cacheRead + cacheCreation (Claude) or cached_input (Codex)
  model: string
}

interface QuotaInfo {
  fiveHourPercent: number
  fiveHourResetAt: Date | string | number
  weeklyPercent: number
  weeklyResetAt: Date | string | number
}

// ── Claude: context from session JSONL ────────────────────────

function getClaudeContextInfo(sessionId: string, cwd: string): ContextInfo | null {
  try {
    const slug = pathToSlug(cwd)
    const jsonlPath = path.join(os.homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`)
    if (!fs.existsSync(jsonlPath)) return null

    const stat = fs.statSync(jsonlPath)
    const TAIL_SIZE = 200 * 1024
    const start = Math.max(0, stat.size - TAIL_SIZE)
    const fd = fs.openSync(jsonlPath, 'r')
    const buf = Buffer.alloc(Math.min(TAIL_SIZE, stat.size))
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)

    const lines = buf.toString('utf-8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line || !line.includes('"usage"')) continue
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        if (obj.type !== 'assistant') continue
        const msg = obj.message as Record<string, unknown> | undefined
        if (!msg?.usage) continue
        const u = msg.usage as Record<string, number>
        return {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheTokens: (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          model: (msg.model ?? '') as string,
        }
      } catch { /* skip */ }
    }
  } catch (err) { log(`[status] Claude context 读取失败: ${err}`) }
  return null
}

// ── Claude: quota from HUD cache → API fallback ──────────────

function readOAuthToken(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const raw = execFileSync('/usr/bin/security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-w',
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }).trim()
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>
      const token = parsed.claudeAiOauth?.accessToken as string | undefined
      if (token) return token
    } catch { /* not JSON */ }
    return raw
  } catch { return null }
}

function readHudCache(): QuotaInfo | null {
  try {
    const cachePath = path.join(os.homedir(), '.claude', 'plugins', 'claude-hud', '.usage-cache.json')
    if (!fs.existsSync(cachePath)) return null
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as {
      data: { fiveHour?: number; sevenDay?: number; fiveHourResetAt?: string; sevenDayResetAt?: string }
      timestamp: number
    }
    if (Date.now() - raw.timestamp > 120_000) return null
    const d = raw.data
    return {
      fiveHourPercent: d.fiveHour ?? 0,
      fiveHourResetAt: d.fiveHourResetAt ?? '',
      weeklyPercent: d.sevenDay ?? 0,
      weeklyResetAt: d.sevenDayResetAt ?? '',
    }
  } catch { return null }
}

async function fetchClaudeQuota(): Promise<QuotaInfo | null> {
  const cached = readHudCache()
  if (cached) return cached

  const token = readOAuthToken()
  if (!token) return null
  try {
    const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { 'Authorization': `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'im2cc/1.0' },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return null
    const data = await resp.json() as Record<string, Record<string, unknown>>
    const fh = data.five_hour, wk = data.seven_day
    return {
      fiveHourPercent: Math.round(Number(fh?.utilization ?? 0)),
      fiveHourResetAt: String(fh?.resets_at ?? ''),
      weeklyPercent: Math.round(Number(wk?.utilization ?? 0)),
      weeklyResetAt: String(wk?.resets_at ?? ''),
    }
  } catch (err) { log(`[status] Claude quota API 失败: ${err}`); return null }
}

// ── Codex: context + quota from session JSONL ────────────────

function findCodexSessionFile(threadId: string): string | null {
  const sessDir = path.join(os.homedir(), '.codex', 'sessions')
  if (!fs.existsSync(sessDir)) return null
  try {
    // 递归搜索包含 threadId 的文件
    const result = execFileSync('find', [sessDir, '-name', `*${threadId}*`, '-type', 'f'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 }).trim()
    const files = result.split('\n').filter(Boolean)
    // 多个 rollout 文件时取最新的
    return files.length > 0 ? files.sort().pop()! : null
  } catch { return null }
}

interface CodexSessionData {
  context: ContextInfo | null
  quota: QuotaInfo | null
}

function getCodexSessionData(threadId: string): CodexSessionData {
  const result: CodexSessionData = { context: null, quota: null }
  const file = findCodexSessionFile(threadId)
  if (!file) return result

  try {
    const stat = fs.statSync(file)
    const TAIL_SIZE = 100 * 1024
    const start = Math.max(0, stat.size - TAIL_SIZE)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(TAIL_SIZE, stat.size))
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)

    const lines = buf.toString('utf-8').split('\n')

    // 从末尾找最后一条 token_count 事件
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line || !line.includes('token_count')) continue
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        const payload = obj.payload as Record<string, unknown> | undefined
        if (!payload || payload.type !== 'token_count') continue

        // 提取 token 使用量
        const info = payload.info as Record<string, Record<string, number>> | null
        if (info?.total_token_usage && !result.context) {
          const u = info.total_token_usage
          result.context = {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheTokens: u.cached_input_tokens ?? 0,
            model: getCodexModel(),
          }
        }

        // 提取配额（rate_limits）
        const rl = payload.rate_limits as Record<string, Record<string, unknown>> | undefined
        if (rl && !result.quota) {
          const pri = rl.primary, sec = rl.secondary
          result.quota = {
            fiveHourPercent: Math.round(Number(pri?.used_percent ?? 0)),
            fiveHourResetAt: Number(pri?.resets_at ?? 0),
            weeklyPercent: Math.round(Number(sec?.used_percent ?? 0)),
            weeklyResetAt: Number(sec?.resets_at ?? 0),
          }
        }

        if (result.context && result.quota) break
      } catch { /* skip */ }
    }
  } catch (err) { log(`[status] Codex session 读取失败: ${err}`) }
  return result
}

function getCodexModel(): string {
  try {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml')
    if (!fs.existsSync(configPath)) return ''
    const content = fs.readFileSync(configPath, 'utf-8')
    const match = content.match(/^model\s*=\s*"(.+?)"/m)
    return match?.[1] ?? ''
  } catch { return '' }
}

// ── Main status builder ────────────────────────────────────────

export interface StatusOptions {
  includeQuota?: boolean
}

export async function buildSessionStatus(
  binding: Binding,
  opts: StatusOptions = {},
): Promise<string> {
  const { includeQuota = true } = opts

  const regEntry = listRegistered().find(r => r.sessionId === binding.sessionId)
  const sessionName = regEntry?.name ?? '(未注册)'
  const tool = regEntry?.tool ?? binding.tool ?? 'claude'
  const qs = getQueueStatus(binding.conversationId)
  const gitBranch = getGitBranch(binding.cwd)

  // 根据工具类型获取上下文和配额数据
  let contextInfo: ContextInfo | null = null
  let quota: QuotaInfo | null = null

  if (tool === 'claude') {
    contextInfo = getClaudeContextInfo(binding.sessionId, binding.cwd)
    if (includeQuota) quota = await fetchClaudeQuota()
  } else if (tool === 'codex') {
    const codexData = getCodexSessionData(binding.sessionId)
    contextInfo = codexData.context
    quota = codexData.quota
  }

  // ── Build card ──

  const SEP = '─────────────────────────────'
  const lines: string[] = []

  // ❶ 标题
  lines.push(sessionName)
  lines.push(SEP)

  // ❷ 身份行
  const identity = [toolLabel(tool), path.basename(binding.cwd)]
  if (gitBranch) identity.push(gitBranch)
  lines.push(identity.join('  ·  '))

  // ❸ 路径
  lines.push(binding.cwd)

  // ❹ 运行时
  const stateStr = queueStateCN(qs.state)
  const queueSuffix = qs.queueLength > 0 ? `(队列 ${qs.queueLength})` : ''
  lines.push(`${binding.permissionMode}  ·  ${binding.turnCount}轮  ·  ${stateStr}${queueSuffix}`)

  // ❺ 上下文 & 模型
  if (contextInfo) {
    lines.push(SEP)
    const totalInput = contextInfo.inputTokens + contextInfo.cacheTokens
    const model = contextInfo.model ? shortModelName(contextInfo.model) : ''
    lines.push(`上下文 ${formatTokens(totalInput)}${model ? `  ·  ${model}` : ''}`)

    const details: string[] = []
    if (contextInfo.cacheTokens > 0) details.push(`缓存 ${formatTokens(contextInfo.cacheTokens)}`)
    if (contextInfo.inputTokens > 0) details.push(`新增 ${formatTokens(contextInfo.inputTokens)}`)
    details.push(`输出 ${formatTokens(contextInfo.outputTokens)}`)
    lines.push(details.join('  ·  '))
  }

  // ❻ 配额
  if (quota) {
    lines.push(SEP)
    const fhReset = quota.fiveHourResetAt ? formatResetTime(quota.fiveHourResetAt) : ''
    const wkReset = quota.weeklyResetAt ? formatResetTime(quota.weeklyResetAt) : ''
    lines.push(`5h ${progressBar(quota.fiveHourPercent)} ${quota.fiveHourPercent}%${fhReset ? `  ${fhReset}` : ''}`)
    lines.push(`周  ${progressBar(quota.weeklyPercent)} ${quota.weeklyPercent}%${wkReset ? `  ${wkReset}` : ''}`)
  }

  // ❼ 底部
  lines.push(SEP)
  const active = relativeTime(binding.lastActiveAt)
  const hint = regEntry ? `fc ${regEntry.name}` : 'fc <名称>'
  lines.push(`${active}  ·  回到电脑: ${hint}`)

  return lines.join('\n')
}
