/**
 * @input:    ~/.im2cc/data/bindings.json, Binding 数据结构
 * @output:   createBinding(), getBinding(), updateBinding(), archiveBinding(), listActiveBindings(), isDuplicate()
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getDataDir } from './config.js'

export interface Binding {
  id: string
  feishuGroupId: string
  cli: 'claude'
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

function readBindings(): Binding[] {
  const f = bindingsFile()
  if (!fs.existsSync(f)) return []
  return JSON.parse(fs.readFileSync(f, 'utf-8')) as Binding[]
}

/** 原子写：临时文件 + rename */
function writeBindings(bindings: Binding[]): void {
  const f = bindingsFile()
  const tmp = f + '.tmp.' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(bindings, null, 2))
  fs.renameSync(tmp, f)
}

export function createBinding(
  feishuGroupId: string,
  sessionId: string,
  cwd: string,
  permissionMode: string,
  cliVersion: string,
): Binding {
  const bindings = readBindings()

  // 如果该群已有活跃 binding，先归档
  for (const b of bindings) {
    if (b.feishuGroupId === feishuGroupId && !b.archived) {
      b.archived = true
    }
  }

  const binding: Binding = {
    id: crypto.randomUUID(),
    feishuGroupId,
    cli: 'claude',
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

export function getBinding(feishuGroupId: string): Binding | null {
  return readBindings().find(b => b.feishuGroupId === feishuGroupId && !b.archived) ?? null
}

export function updateBinding(feishuGroupId: string, partial: Partial<Binding>): void {
  const bindings = readBindings()
  const idx = bindings.findIndex(b => b.feishuGroupId === feishuGroupId && !b.archived)
  if (idx === -1) return
  Object.assign(bindings[idx], partial, { lastActiveAt: new Date().toISOString() })
  writeBindings(bindings)
}

export function archiveBinding(feishuGroupId: string): Binding | null {
  const bindings = readBindings()
  const idx = bindings.findIndex(b => b.feishuGroupId === feishuGroupId && !b.archived)
  if (idx === -1) return null
  bindings[idx].archived = true
  writeBindings(bindings)
  return bindings[idx]
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
