/**
 * @input:    ~/.im2cc/data/bindings.json, Binding 数据结构
 * @output:   createBinding(), getBinding(), updateBinding(), archiveBinding(), listActiveBindings(), isDuplicate()
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getDataDir } from './config.js'
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

// --- 消息去重 ---
const seenMessages = new Map<string, number>()
const MAX_SEEN = 1000

export function isDuplicate(messageId: string): boolean {
  if (seenMessages.has(messageId)) return true
  seenMessages.set(messageId, Date.now())
  // LRU 清理
  if (seenMessages.size > MAX_SEEN) {
    const oldest = [...seenMessages.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, MAX_SEEN / 2)
    for (const [key] of oldest) seenMessages.delete(key)
  }
  return false
}
