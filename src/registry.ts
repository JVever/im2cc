/**
 * @input:    ~/.im2cc/data/registry.json, 精确模型 ID 门禁
 * @output:   register(), lookup(), list(), remove(), updateSelectedModel(), reconcileSelectedModelBySessionId() — 拒绝家族 alias、带写锁与 watermark CAS 的 Session 注册表
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'
import type { ToolId } from './tool-driver.js'
import { normalizeExactModelId } from './model-id.js'

export interface RegisteredSession {
  name: string
  sessionId: string
  cwd: string
  tool: ToolId
  claudeProfile?: string
  permissionMode?: string
  /** Terminal / IM 共用的精确模型 ID；不保存 opus 等家族 alias */
  selectedModelId?: string
  /** 模型选择事件时间，用于拒绝晚到的旧事件 */
  modelSelectionUpdatedAt?: string
  createdAt: string
  lastUsedAt: string
}

type Registry = Record<string, Omit<RegisteredSession, 'name'>>

function registryFile(): string {
  return path.join(getDataDir(), 'registry.json')
}

const REGISTRY_LOCK_STALE_MS = 10_000
const REGISTRY_LOCK_WAIT_MS = 10
const REGISTRY_LOCK_TIMEOUT_MS = 2_000
const registryLockWaiter = new Int32Array(new SharedArrayBuffer(4))

/** daemon、SessionStart hook、statusline observer 共用的跨进程写锁。 */
function withRegistryLock<T>(action: () => T): T {
  const lockDir = path.join(getDataDir(), 'registry.lock')
  const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS

  while (true) {
    try {
      fs.mkdirSync(lockDir)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > REGISTRY_LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true })
          continue
        }
      } catch {}
      if (Date.now() >= deadline) throw new Error('registry 写锁等待超时')
      Atomics.wait(registryLockWaiter, 0, 0, REGISTRY_LOCK_WAIT_MS)
    }
  }

  try {
    return action()
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true })
  }
}

function readRegistry(): Registry {
  const f = registryFile()
  if (!fs.existsSync(f)) return {}
  const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as Registry
  // 兼容旧数据：没有 tool 字段的默认 'claude'
  for (const data of Object.values(raw)) {
    if (!data.tool) (data as Record<string, unknown>).tool = 'claude'
    if (data.selectedModelId !== undefined) {
      const normalized = normalizeExactModelId(data.tool, data.selectedModelId)
      if (normalized) {
        data.selectedModelId = normalized
      } else {
        delete data.selectedModelId
        delete data.modelSelectionUpdatedAt
      }
    }
  }
  return raw
}

// 调用方已统一持有 registry.lock；temp + rename 负责保证读者只看到完整 JSON。
function writeRegistry(reg: Registry): void {
  const f = registryFile()
  const tmp = f + '.tmp.' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2))
  fs.renameSync(tmp, f)
}

/** 查找哪个 name 持有指定 sessionId，不存在则返回 null */
function findBySessionId(reg: Registry, sessionId: string): string | null {
  for (const [name, data] of Object.entries(reg)) {
    if (data.sessionId === sessionId) return name
  }
  return null
}

/** 注册一个命名 session（唯一性约束：同一 sessionId 不能被多个 name 持有） */
export function register(name: string, sessionId: string, cwd: string, tool: ToolId = 'claude'): RegisteredSession {
  return withRegistryLock(() => {
    const reg = readRegistry()

    const existingOwner = findBySessionId(reg, sessionId)
    if (existingOwner && existingOwner !== name) {
      throw new Error(
        `session ${sessionId.slice(0, 8)} 已被 "${existingOwner}" 注册，不能同时注册为 "${name}"。` +
        `如果要改名，请先 fk ${existingOwner}。`
      )
    }

    const now = new Date().toISOString()
    reg[name] = {
      sessionId,
      cwd,
      tool,
      createdAt: reg[name]?.createdAt ?? now,
      lastUsedAt: now,
      claudeProfile: reg[name]?.claudeProfile,
      permissionMode: reg[name]?.permissionMode,
      selectedModelId: reg[name]?.selectedModelId,
      modelSelectionUpdatedAt: reg[name]?.modelSelectionUpdatedAt,
    }
    writeRegistry(reg)
    return { name, ...reg[name] }
  })
}

export function registerWithMeta(
  name: string,
  sessionId: string,
  cwd: string,
  tool: ToolId = 'claude',
  updates: Partial<Pick<RegisteredSession, 'claudeProfile' | 'permissionMode'>> = {},
): RegisteredSession {
  return withRegistryLock(() => {
    const reg = readRegistry()

    const existingOwner = findBySessionId(reg, sessionId)
    if (existingOwner && existingOwner !== name) {
      throw new Error(
        `session ${sessionId.slice(0, 8)} 已被 "${existingOwner}" 注册，不能同时注册为 "${name}"。` +
        `如果要改名，请先 fk ${existingOwner}。`
      )
    }

    const now = new Date().toISOString()
    reg[name] = {
      sessionId,
      cwd,
      tool,
      createdAt: reg[name]?.createdAt ?? now,
      lastUsedAt: now,
      claudeProfile: updates.claudeProfile ?? reg[name]?.claudeProfile,
      permissionMode: updates.permissionMode ?? reg[name]?.permissionMode,
      selectedModelId: reg[name]?.selectedModelId,
      modelSelectionUpdatedAt: reg[name]?.modelSelectionUpdatedAt,
    }
    writeRegistry(reg)
    return { name, ...reg[name] }
  })
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

export function lookupBySessionId(sessionId: string): RegisteredSession | null {
  const reg = readRegistry()
  for (const [name, data] of Object.entries(reg)) {
    if (data.sessionId === sessionId) return { name, ...data }
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
  withRegistryLock(() => {
    const reg = readRegistry()
    if (reg[name]) {
      reg[name].lastUsedAt = new Date().toISOString()
      writeRegistry(reg)
    }
  })
}

/** 更新 registry 中某个 session 的字段 */
export function updateRegistry(
  name: string,
  updates: Partial<Pick<RegisteredSession, 'permissionMode' | 'claudeProfile'>>,
): void {
  withRegistryLock(() => {
    const reg = readRegistry()
    if (!reg[name]) return
    Object.assign(reg[name], updates)
    writeRegistry(reg)
  })
}

/**
 * 更新命名 Session 的模型选择。事件时间早于现值时拒绝，避免晚到的旧端事件覆盖新选择。
 * modelId=undefined 表示恢复工具默认（未锁定）。
 */
export function updateSelectedModel(name: string, modelId: string | undefined, eventAt: string = new Date().toISOString()): boolean {
  return withRegistryLock(() => {
    const reg = readRegistry()
    const current = reg[name]
    if (!current) return false
    const normalizedModelId = modelId === undefined
      ? undefined
      : normalizeExactModelId(current.tool, modelId) ?? undefined
    if (modelId !== undefined && !normalizedModelId) return false

    const currentAt = current.modelSelectionUpdatedAt
    const currentTime = currentAt ? new Date(currentAt).getTime() : Number.NEGATIVE_INFINITY
    const eventTime = new Date(eventAt).getTime()
    if (currentAt && eventTime < currentTime) return false
    // 同值的新事件仍需推进 watermark，才能阻止夹在两者之间的晚到旧事件。
    if (current.selectedModelId === normalizedModelId && currentAt && eventTime <= currentTime) return false

    current.selectedModelId = normalizedModelId
    current.modelSelectionUpdatedAt = eventAt
    writeRegistry(reg)
    return true
  })
}

/** 按底层 sessionId 更新模型；供 Claude statusline observer 与 turn 完成校正使用。 */
export function updateSelectedModelBySessionId(
  sessionId: string,
  modelId: string | undefined,
  eventAt: string = new Date().toISOString(),
): boolean {
  return withRegistryLock(() => {
    const reg = readRegistry()
    const name = findBySessionId(reg, sessionId)
    if (!name) return false

    const current = reg[name]
    const normalizedModelId = modelId === undefined
      ? undefined
      : normalizeExactModelId(current.tool, modelId) ?? undefined
    if (modelId !== undefined && !normalizedModelId) return false
    const currentAt = current.modelSelectionUpdatedAt
    const currentTime = currentAt ? new Date(currentAt).getTime() : Number.NEGATIVE_INFINITY
    const eventTime = new Date(eventAt).getTime()
    if (currentAt && eventTime < currentTime) return false
    if (current.selectedModelId === normalizedModelId && currentAt && eventTime <= currentTime) return false

    current.selectedModelId = normalizedModelId
    current.modelSelectionUpdatedAt = eventAt
    writeRegistry(reg)
    return true
  })
}

/**
 * 成功 turn 的条件校正：只有当前 selection watermark 仍等于 turn 启动快照时才写入。
 * 这是一条持锁 compare-and-set，避免 turn 执行期间产生的新选择被旧 turn 完成覆盖。
 */
export function reconcileSelectedModelBySessionId(
  sessionId: string,
  modelId: string,
  eventAt: string,
  expectedSelectionUpdatedAt: string | undefined,
): boolean {
  return withRegistryLock(() => {
    const reg = readRegistry()
    const name = findBySessionId(reg, sessionId)
    if (!name) return false

    const current = reg[name]
    const normalizedModelId = normalizeExactModelId(current.tool, modelId)
    if (!normalizedModelId) return false
    if (current.modelSelectionUpdatedAt !== expectedSelectionUpdatedAt) return false

    const currentTime = current.modelSelectionUpdatedAt
      ? new Date(current.modelSelectionUpdatedAt).getTime()
      : Number.NEGATIVE_INFINITY
    const eventTime = new Date(eventAt).getTime()
    if (eventTime < currentTime) return false

    current.selectedModelId = normalizedModelId
    current.modelSelectionUpdatedAt = eventAt
    writeRegistry(reg)
    return true
  })
}

/** 删除 */
export function remove(name: string): boolean {
  return withRegistryLock(() => {
    const reg = readRegistry()
    if (!reg[name]) return false
    delete reg[name]
    writeRegistry(reg)
    return true
  })
}
