/**
 * @input:    RegisteredSession/Binding、Claude/Codex 原生 session JSONL
 * @output:   getModelSelectionSnapshotForBinding(), getSelectedModelForBinding(), getLatestObservedModel(), reconcileActualModel(), needsInteractiveModelRestart() — 带模型、selection watermark 与 observed baseline 的 Session 精确模型状态
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Binding } from './session.js'
import { pathToSlug } from './discover.js'
import { lookupBySessionId, reconcileSelectedModelBySessionId, updateSelectedModel, updateSelectedModelBySessionId, type RegisteredSession } from './registry.js'
import type { ToolId } from './tool-driver.js'
import { log } from './logger.js'
import { getDataDir } from './config.js'
import { normalizeExactModelId } from './model-id.js'
import { resolveModelInput } from './model-catalog.js'

export interface ObservedModel {
  id: string
  observedAt: string
}

export interface ModelSelectionSnapshot {
  selectedModelId?: string
  modelSelectionUpdatedAt?: string
  /** turn 启动前已存在的最近工具事实；完成时相同记录不得冒充本 turn 新事实。 */
  observedBaseline: ObservedModel | null
}

const TAIL_BYTES = 256 * 1024
const MAX_CODEX_REVERSE_SCAN_BYTES = 64 * 1024 * 1024

function readTail(filePath: string): string[] {
  let fd = -1
  try {
    fd = fs.openSync(filePath, 'r')
    const stat = fs.fstatSync(fd)
    const size = Math.min(stat.size, TAIL_BYTES)
    if (size === 0) return []
    const buf = Buffer.alloc(size)
    const start = stat.size - size
    fs.readSync(fd, buf, 0, size, start)
    let text = buf.toString('utf-8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1) : ''
    }
    return text.split('\n')
  } catch {
    return []
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

function getClaudeObservedModel(sessionId: string, cwd: string): ObservedModel | null {
  const filePath = path.join(os.homedir(), '.claude', 'projects', pathToSlug(cwd), `${sessionId}.jsonl`)
  if (!fs.existsSync(filePath)) return null

  const lines = readTail(filePath)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || !line.includes('"assistant"')) continue
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      if (obj.type !== 'assistant') continue
      const message = obj.message as Record<string, unknown> | undefined
      const modelId = normalizeExactModelId('claude', message?.model)
      if (!modelId) continue
      const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : fs.statSync(filePath).mtime.toISOString()
      return { id: modelId, observedAt: timestamp }
    } catch {}
  }
  return null
}

function findCodexSessionFile(sessionId: string): string | null {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  if (!fs.existsSync(root)) return null
  try {
    const output = execFileSync('find', [root, '-type', 'f', '-name', `*${sessionId}*.jsonl`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim()
    const files = output.split('\n').filter(Boolean)
    return files.sort().at(-1) ?? null
  } catch {
    return null
  }
}

/**
 * 从 JSONL 尾部逐块反向产出完整行。Codex 的 turn_context 位于 turn 开头，
 * 单个长 turn 可远超普通 tail 窗口，因此不能复用 readTail()。
 */
function* readLinesReverse(filePath: string, maxBytes: number): Generator<string> {
  let fd = -1
  try {
    fd = fs.openSync(filePath, 'r')
    const fileSize = fs.fstatSync(fd).size
    let position = fileSize
    let scanned = 0
    let carry = Buffer.alloc(0)
    const chunkSize = 256 * 1024

    while (position > 0 && scanned < maxBytes) {
      const size = Math.min(chunkSize, position, maxBytes - scanned)
      position -= size
      scanned += size
      const chunk = Buffer.alloc(size)
      fs.readSync(fd, chunk, 0, size, position)
      const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk

      let lineEnd = combined.length
      let newline = combined.lastIndexOf(0x0a, lineEnd - 1)
      while (newline >= 0) {
        const line = combined.subarray(newline + 1, lineEnd).toString('utf-8').trim()
        if (line) yield line
        lineEnd = newline
        newline = combined.lastIndexOf(0x0a, lineEnd - 1)
      }
      carry = combined.subarray(0, lineEnd)
    }

    if (position === 0 && carry.length > 0) {
      const line = carry.toString('utf-8').trim()
      if (line) yield line
    }
  } catch {
    return
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

/** Codex 仅暴露成功 turn 的有效请求上下文模型；不声称可观测 provider response rewrite。 */
function getCodexObservedModel(sessionId: string): ObservedModel | null {
  const filePath = findCodexSessionFile(sessionId)
  if (!filePath) return null

  // 从后往前先找到最近一次成功完成，再找它之前的 turn_context。
  // 未完成/失败 turn 没有 task_complete，不得冒充“最近成功响应模型”。
  let foundCompletedTurn = false
  for (const line of readLinesReverse(filePath, MAX_CODEX_REVERSE_SCAN_BYTES)) {
    if (!foundCompletedTurn) {
      if (!line.includes('"task_complete"')) continue
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        const payload = obj.payload as Record<string, unknown> | undefined
        foundCompletedTurn = obj.type === 'event_msg' && payload?.type === 'task_complete'
      } catch {}
      continue
    }

    if (!line.includes('"turn_context"')) continue
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      if (obj.type !== 'turn_context') continue
      const payload = obj.payload as Record<string, unknown> | undefined
      const modelId = normalizeExactModelId('codex', payload?.model)
      if (!modelId) continue
      const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : fs.statSync(filePath).mtime.toISOString()
      return { id: modelId, observedAt: timestamp }
    } catch {}
  }
  if (!foundCompletedTurn) log(`[model] Codex ${sessionId.slice(0, 8)} 尚无成功完成的 turn，不更新模型`)
  return null
}

export function getLatestObservedModel(tool: ToolId, sessionId: string, cwd: string): ObservedModel | null {
  if (tool === 'claude') return getClaudeObservedModel(sessionId, cwd)
  if (tool === 'codex') return getCodexObservedModel(sessionId)
  return null
}

/**
 * 返回命名 Session 的已选模型，并顺手完成两类兼容收敛：
 * 1) 新于当前选择的工具原生持久状态；2) 旧 binding.modelOverride 的一次性迁移。
 */
export function getModelSelectionSnapshotForBinding(binding: Binding): ModelSelectionSnapshot {
  const tool = (binding.tool ?? 'claude') as ToolId
  let session = lookupBySessionId(binding.sessionId)
  const observed = getLatestObservedModel(tool, binding.sessionId, binding.cwd)
  const legacyModelId = binding.modelOverride
    ? resolveModelInput(tool, binding.modelOverride)?.fullName
      ?? normalizeExactModelId(tool, binding.modelOverride)
      ?? undefined
    : undefined
  if (!session) return { selectedModelId: legacyModelId, observedBaseline: observed }

  // 迁移优先级：旧 override 是“目标选择”，先于更旧的历史响应；事件时间仍可让更新的实际响应校正它。
  // modelSelectionUpdatedAt 存在但 selectedModelId 为空，表示用户显式选择了 default，不回填旧值。
  if (!session.modelSelectionUpdatedAt && !session.selectedModelId && legacyModelId) {
    updateSelectedModel(session.name, legacyModelId, binding.lastActiveAt)
    session = lookupBySessionId(binding.sessionId)
  }

  if (tool === 'codex' && observed) {
    // Codex turn_context timestamp 是 turn 启动时间：外部 Terminal 成功 turn 可有序吸收，
    // 早于当前 selection watermark 的旧 turn 会被 registry 拒绝。
    updateSelectedModelBySessionId(binding.sessionId, observed.id, observed.observedAt)
    session = lookupBySessionId(binding.sessionId)
  } else if (!session?.modelSelectionUpdatedAt && !session?.selectedModelId && observed) {
    // Claude assistant timestamp 是完成时间，不能惰性覆盖已有显式选择；仅首次初始化可吸收。
    reconcileSelectedModelBySessionId(binding.sessionId, observed.id, observed.observedAt, undefined)
    session = lookupBySessionId(binding.sessionId)
  }
  return {
    selectedModelId: session?.selectedModelId,
    modelSelectionUpdatedAt: session?.modelSelectionUpdatedAt,
    observedBaseline: observed,
  }
}

export function getSelectedModelForBinding(binding: Binding): string | undefined {
  return getModelSelectionSnapshotForBinding(binding).selectedModelId
}

/** 当前交互式 Terminal 已实际加载的模型；Claude 来自 statusline 状态，Codex 来自最新 turn_context。 */
export function getInteractiveModelId(tool: ToolId, sessionId: string, cwd: string): string | null {
  if (tool === 'codex') return getCodexObservedModel(sessionId)?.id ?? null
  if (tool !== 'claude') return null
  try {
    const statePath = path.join(getDataDir(), 'statusline-model-state.json')
    if (!fs.existsSync(statePath)) return null
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>
    return normalizeExactModelId(tool, state[sessionId])
  } catch {
    return null
  }
}

/** 有明确 Session 选择且现存 TUI 未加载同一值时，fc 必须重启 TUI 后再 resume。 */
export function needsInteractiveModelRestart(session: RegisteredSession): boolean {
  if (!session.modelSelectionUpdatedAt) return false
  return getInteractiveModelId(session.tool, session.sessionId, session.cwd) !== session.selectedModelId
}

/** 成功 turn 后以工具实际持久化的完整 ID 校正 Session。 */
export function reconcileActualModel(
  binding: Binding,
  sessionId: string = binding.sessionId,
  expectedSelectionUpdatedAt?: string,
  observedBaseline: ObservedModel | null = null,
): string | null {
  const tool = (binding.tool ?? 'claude') as ToolId
  return reconcileActualModelForSession(
    tool,
    sessionId,
    binding.cwd,
    expectedSelectionUpdatedAt,
    observedBaseline,
  )
}

/** 无 Binding 的后台 turn（如 scheduler）成功后，按命名 Session 原生状态校正。 */
export function reconcileActualModelForSession(
  tool: ToolId,
  sessionId: string,
  cwd: string,
  expectedSelectionUpdatedAt?: string,
  observedBaseline: ObservedModel | null = null,
): string | null {
  const observed = getLatestObservedModel(tool, sessionId, cwd)
  if (!observed) return null
  if (observedBaseline
      && observedBaseline.id === observed.id
      && observedBaseline.observedAt === observed.observedAt) {
    log(`[model] Session ${sessionId.slice(0, 8)} 本 turn 未产生新的模型事实，跳过校正`)
    return observed.id
  }
  const updated = reconcileSelectedModelBySessionId(
    sessionId,
    observed.id,
    observed.observedAt,
    expectedSelectionUpdatedAt,
  )
  if (updated) log(`[model] Session ${sessionId.slice(0, 8)} 已按实际响应校正为 ${observed.id}`)
  else log(`[model] Session ${sessionId.slice(0, 8)} 在 turn 执行期间出现新选择，跳过旧 turn 模型校正`)
  return observed.id
}
