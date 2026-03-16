/**
 * @input:    ~/.im2cc/registry.json
 * @output:   register(), lookup(), list(), remove() — 命名 session 注册表
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'

export interface RegisteredSession {
  name: string
  sessionId: string
  cwd: string
  permissionMode?: string
  createdAt: string
  lastUsedAt: string
}

type Registry = Record<string, Omit<RegisteredSession, 'name'>>

function registryFile(): string {
  return path.join(getDataDir(), 'registry.json')
}

function readRegistry(): Registry {
  const f = registryFile()
  if (!fs.existsSync(f)) return {}
  return JSON.parse(fs.readFileSync(f, 'utf-8')) as Registry
}

function writeRegistry(reg: Registry): void {
  const f = registryFile()
  const tmp = f + '.tmp.' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2))
  fs.renameSync(tmp, f)
}

/** 注册一个命名 session */
export function register(name: string, sessionId: string, cwd: string): RegisteredSession {
  const reg = readRegistry()
  const now = new Date().toISOString()
  reg[name] = { sessionId, cwd, createdAt: reg[name]?.createdAt ?? now, lastUsedAt: now }
  writeRegistry(reg)
  return { name, ...reg[name] }
}

/** 按名称查找（支持模糊匹配） */
export function lookup(query: string): RegisteredSession | null {
  const reg = readRegistry()

  // 精确匹配
  if (reg[query]) {
    return { name: query, ...reg[query] }
  }

  // 不区分大小写匹配
  const lower = query.toLowerCase()
  for (const [name, data] of Object.entries(reg)) {
    if (name.toLowerCase() === lower) return { name, ...data }
  }

  // 前缀匹配（唯一时）
  const prefixMatches = Object.entries(reg).filter(([n]) => n.toLowerCase().startsWith(lower))
  if (prefixMatches.length === 1) {
    const [name, data] = prefixMatches[0]
    return { name, ...data }
  }

  return null
}

/** 模糊搜索（返回所有匹配） */
export function search(query: string): RegisteredSession[] {
  const reg = readRegistry()
  const lower = query.toLowerCase()
  return Object.entries(reg)
    .filter(([name]) => name.toLowerCase().includes(lower))
    .map(([name, data]) => ({ name, ...data }))
}

/** 列出所有已注册 session */
export function listRegistered(): RegisteredSession[] {
  const reg = readRegistry()
  return Object.entries(reg)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime())
}

/** 更新 lastUsedAt */
export function touch(name: string): void {
  const reg = readRegistry()
  if (reg[name]) {
    reg[name].lastUsedAt = new Date().toISOString()
    writeRegistry(reg)
  }
}

/** 更新 registry 中某个 session 的字段 */
export function updateRegistry(name: string, updates: Partial<Pick<RegisteredSession, 'permissionMode'>>): void {
  const reg = readRegistry()
  if (!reg[name]) return
  Object.assign(reg[name], updates)
  writeRegistry(reg)
}

/** 删除 */
export function remove(name: string): boolean {
  const reg = readRegistry()
  if (!reg[name]) return false
  delete reg[name]
  writeRegistry(reg)
  return true
}
