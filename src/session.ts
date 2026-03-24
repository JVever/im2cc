/**
 * @input:    ~/.im2cc/data/bindings.json, Binding 数据结构
 * @output:   createBinding(), getBinding(), updateBinding(), archiveBinding(), listActiveBindings(), isDuplicate() — 会话绑定与跨进程消息去重
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getDataDir, getMessageDedupDir } from './config.js'
import type { TransportType } from './transport.js'
import type { ToolId } from './tool-driver.js'

export interface Binding {
  id: string
  transport: TransportType  // 'feishu' | 'wechat'
  conversationId: string    // 飞书群 ID / 微信用户标识
  tool: ToolId              // 'claude' | 'codex' | 'kimi' | ...
  sessionId: string
  cwd: string
  permissionMode: string
  cliVersion: string
  turnCount: number
  createdAt: string
  lastActiveAt: string
  archived: boolean
}

function bindingsFile(): string {
  return path.join(getDataDir(), 'bindings.json')
}

/** 读取 bindings，兼容旧格式（自动迁移 feishuGroupId → conversationId） */
function readBindings(): Binding[] {
  const f = bindingsFile()
  if (!fs.existsSync(f)) return []
  const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as Array<Record<string, unknown>>
  return raw.map(b => {
    // 兼容旧格式
    if ('feishuGroupId' in b && !('conversationId' in b)) {
      b.conversationId = b.feishuGroupId
      delete b.feishuGroupId
    }
    if (!b.transport) b.transport = 'feishu'
    // cli: 'claude' → tool: 'claude'
    if ('cli' in b && !('tool' in b)) {
      b.tool = (b.cli as string) || 'claude'
      delete b.cli
    }
    if (!b.tool) b.tool = 'claude'
    return b as unknown as Binding
  })
}

/** 原子写：临时文件 + rename */
function writeBindings(bindings: Binding[]): void {
  const f = bindingsFile()
  const tmp = f + '.tmp.' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(bindings, null, 2))
  fs.renameSync(tmp, f)
}

export function createBinding(
  conversationId: string,
  sessionId: string,
  cwd: string,
  permissionMode: string,
  cliVersion: string,
  transport: TransportType = 'feishu',
  tool: ToolId = 'claude',
): Binding {
  const bindings = readBindings()

  // 如果该会话已有活跃 binding，先归档
  for (const b of bindings) {
    if (b.conversationId === conversationId && !b.archived) {
      b.archived = true
    }
  }

  const binding: Binding = {
    id: crypto.randomUUID(),
    transport,
    conversationId,
    tool,
    sessionId,
    cwd,
    permissionMode,
    cliVersion,
    turnCount: 0,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    archived: false,
  }

  bindings.push(binding)
  writeBindings(bindings)
  return binding
}

export function getBinding(conversationId: string): Binding | null {
  return readBindings().find(b => b.conversationId === conversationId && !b.archived) ?? null
}

export function updateBinding(conversationId: string, partial: Partial<Binding>): void {
  const bindings = readBindings()
  const idx = bindings.findIndex(b => b.conversationId === conversationId && !b.archived)
  if (idx === -1) return
  Object.assign(bindings[idx], partial, { lastActiveAt: new Date().toISOString() })
  writeBindings(bindings)
}

export function archiveBinding(conversationId: string): Binding | null {
  const bindings = readBindings()
  const idx = bindings.findIndex(b => b.conversationId === conversationId && !b.archived)
  if (idx === -1) return null
  bindings[idx].archived = true
  writeBindings(bindings)
  return bindings[idx]
}

/** 归档所有使用指定 sessionId 的活跃绑定（跨 transport 独占） */
export function archiveBindingsBySession(sessionId: string, excludeConversation?: string): number {
  const bindings = readBindings()
  let count = 0
  for (const b of bindings) {
    if (b.sessionId === sessionId && !b.archived && b.conversationId !== excludeConversation) {
      b.archived = true
      count++
    }
  }
  if (count > 0) writeBindings(bindings)
  return count
}

export function listActiveBindings(): Binding[] {
  return readBindings().filter(b => !b.archived)
}

// --- 消息去重（跨进程） ---

const DUPLICATE_TTL_MS = 24 * 60 * 60 * 1000
const DUPLICATE_SWEEP_INTERVAL = 100
const recentDuplicateKeys = new Map<string, number>()
let duplicateCheckCount = 0

function dedupFileForKey(messageKey: string): string {
  const hashed = crypto.createHash('sha1').update(messageKey).digest('hex')
  return path.join(getMessageDedupDir(), `${hashed}.json`)
}

function touchRecentDuplicateKey(messageKey: string, timestamp: number): void {
  recentDuplicateKeys.set(messageKey, timestamp)

  if (recentDuplicateKeys.size <= 2048) return

  const cutoff = Date.now() - DUPLICATE_TTL_MS
  for (const [key, seenAt] of recentDuplicateKeys) {
    if (seenAt < cutoff) recentDuplicateKeys.delete(key)
  }
}

function isFreshTimestamp(timestamp: unknown): timestamp is number {
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && (Date.now() - timestamp) < DUPLICATE_TTL_MS
}

function readDedupTimestamp(filePath: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>
    return isFreshTimestamp(raw.timestamp) ? raw.timestamp : null
  } catch {
    return null
  }
}

function unlinkDedupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {}
}

function tryCreateDedupMarker(filePath: string, messageKey: string, timestamp: number): 'created' | 'duplicate' | 'retry' {
  let fd: number | null = null

  try {
    fd = fs.openSync(filePath, 'wx')
    fs.writeFileSync(fd, JSON.stringify({ key: messageKey, timestamp }))
    touchRecentDuplicateKey(messageKey, timestamp)
    return 'created'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err

    const existingTs = readDedupTimestamp(filePath)
    if (existingTs !== null) {
      touchRecentDuplicateKey(messageKey, existingTs)
      return 'duplicate'
    }

    unlinkDedupFile(filePath)
    return 'retry'
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

function cleanupDedupFiles(): void {
  const dir = getMessageDedupDir()
  const cutoff = Date.now() - DUPLICATE_TTL_MS

  try {
    for (const entry of fs.readdirSync(dir)) {
      const filePath = path.join(dir, entry)
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>
        if (!isFreshTimestamp(raw.timestamp) || (raw.timestamp as number) < cutoff) {
          fs.unlinkSync(filePath)
        }
      } catch {
        try { fs.unlinkSync(filePath) } catch {}
      }
    }
  } catch {
    // ignore best-effort cleanup failures
  }
}

export function isDuplicate(messageKey: string): boolean {
  const now = Date.now()
  const recentTs = recentDuplicateKeys.get(messageKey)
  if (recentTs && (now - recentTs) < DUPLICATE_TTL_MS) return true

  const filePath = dedupFileForKey(messageKey)
  const existingTs = fs.existsSync(filePath) ? readDedupTimestamp(filePath) : null
  if (existingTs !== null) {
    touchRecentDuplicateKey(messageKey, existingTs)
    return true
  }

  unlinkDedupFile(filePath)

  let created = false
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = tryCreateDedupMarker(filePath, messageKey, now)
    if (result === 'created') {
      created = true
      break
    }
    if (result === 'duplicate') {
      return true
    }
  }

  if (!created) throw new Error(`无法创建消息去重标记: ${messageKey}`)

  duplicateCheckCount++
  if (duplicateCheckCount % DUPLICATE_SWEEP_INTERVAL === 0) {
    cleanupDedupFiles()
  }

  return false
}
