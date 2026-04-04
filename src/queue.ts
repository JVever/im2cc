/**
 * @input:    用户消息, Claude 驱动, Session 绑定
 * @output:   enqueue(), handleStop(), getQueueStatus(), recoverOnStartup(), listInflightTasksForSession() — 消息队列、Job 管理、持久化恢复、桌面接回保护态快照
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { getDriver, getDefaultDriver } from './tool-driver.js'
import { getBinding, updateBinding } from './session.js'
import { getInflightDir, getPendingFile } from './config.js'
import { formatOutput, formatError } from './output.js'
import { log } from './logger.js'

type JobState = 'idle' | 'busy' | 'cancelling'

interface QueuedMessage {
  conversationId: string
  text: string
  resolve: (result: string) => void
  reject: (err: Error) => void
  sendReply: (text: string) => Promise<void>
  expectedSessionId: string | null
}

interface GroupState {
  state: JobState
  currentChild: ChildProcess | null
  queue: QueuedMessage[]
  timeoutTimer: NodeJS.Timeout | null
}

// --- 持久化：pending 队列 ---

interface PendingEntry {
  conversationId: string
  text: string
}

function savePending(): void {
  const entries: PendingEntry[] = []
  for (const [, group] of groups) {
    for (const msg of group.queue) {
      entries.push({ conversationId: msg.conversationId, text: msg.text })
    }
  }
  const file = getPendingFile()
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify(entries))
    fs.renameSync(file + '.tmp', file)
  } catch { /* 非关键路径 */ }
}

function loadPending(): PendingEntry[] {
  const file = getPendingFile()
  if (!fs.existsSync(file)) return []
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

function clearPending(): void {
  const file = getPendingFile()
  try { fs.writeFileSync(file, '[]') } catch {}
}

// --- 持久化：inflight 任务 ---

interface InflightMeta {
  id: string
  conversationId: string
  sessionId: string
  text: string
  pid: number | null
  startedAt: string
  outputFile: string
}

export interface InflightTaskSnapshot {
  id: string
  conversationId: string
  sessionId: string
  text: string
  pid: number | null
  startedAt: string
  outputPath: string
  outputText: string
  running: boolean
}

export type CompletedInflightStatus = 'completed' | 'failed' | 'interrupted'

export interface CompletedInflightSnapshot {
  id: string
  conversationId: string
  sessionId: string
  text: string
  startedAt: string
  finishedAt: string
  status: CompletedInflightStatus
  outputPreview: string
}

const COMPLETED_SUFFIX = '.completed.json'
const COMPLETED_TTL_MS = 10 * 60 * 1000

function createInflight(conversationId: string, sessionId: string, text: string): InflightMeta {
  const id = crypto.randomUUID()
  const dir = getInflightDir()
  const meta: InflightMeta = {
    id, conversationId, sessionId, text,
    pid: null,
    startedAt: new Date().toISOString(),
    outputFile: `${id}.output`,
  }
  fs.writeFileSync(path.join(dir, `${id}.meta.json`), JSON.stringify(meta))
  return meta
}

function updateInflightPid(id: string, pid: number): void {
  const dir = getInflightDir()
  const metaPath = path.join(dir, `${id}.meta.json`)
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    meta.pid = pid
    fs.writeFileSync(metaPath, JSON.stringify(meta))
  } catch {}
}

function cleanupInflight(id: string): void {
  const dir = getInflightDir()
  try { fs.unlinkSync(path.join(dir, `${id}.meta.json`)) } catch {}
  try { fs.unlinkSync(path.join(dir, `${id}.output`)) } catch {}
}

function readOutputText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim()
  } catch {
    return ''
  }
}

function trimOutputPreview(text: string): string {
  const normalized = text.trim()
  if (!normalized) return ''
  const lines = normalized.split('\n')
  const tail = lines.slice(-20).join('\n').trim()
  return tail.length > 4000 ? tail.slice(-4000).trim() : tail
}

function completedSnapshotPath(id: string): string {
  return path.join(getInflightDir(), `${id}${COMPLETED_SUFFIX}`)
}

function pruneCompletedSnapshots(dir: string = getInflightDir()): void {
  const cutoff = Date.now() - COMPLETED_TTL_MS
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(COMPLETED_SUFFIX)) continue
    const filePath = path.join(dir, entry)
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<CompletedInflightSnapshot>
      const finishedAt = raw.finishedAt ? Date.parse(raw.finishedAt) : NaN
      if (!Number.isFinite(finishedAt) || finishedAt < cutoff) {
        fs.unlinkSync(filePath)
      }
    } catch {
      try { fs.unlinkSync(filePath) } catch {}
    }
  }
}

function saveCompletedInflightSnapshot(
  meta: InflightMeta,
  status: CompletedInflightStatus,
  outputPreview: string,
): void {
  const dir = getInflightDir()
  pruneCompletedSnapshots(dir)
  const snapshot: CompletedInflightSnapshot = {
    id: meta.id,
    conversationId: meta.conversationId,
    sessionId: meta.sessionId,
    text: meta.text,
    startedAt: meta.startedAt,
    finishedAt: new Date().toISOString(),
    status,
    outputPreview: trimOutputPreview(outputPreview),
  }
  const filePath = completedSnapshotPath(meta.id)
  const tmpPath = `${filePath}.tmp.${process.pid}`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot))
    fs.renameSync(tmpPath, filePath)
  } catch {
    try { fs.unlinkSync(tmpPath) } catch {}
  }
}

function sendSignalToPidGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
    return
  } catch {}
  try {
    process.kill(pid, signal)
  } catch {}
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function listInflightTasksForSession(sessionId: string, conversationId?: string): InflightTaskSnapshot[] {
  const dir = getInflightDir()
  const metaFiles = fs.readdirSync(dir).filter(f => f.endsWith('.meta.json'))
  const tasks: InflightTaskSnapshot[] = []

  for (const metaFile of metaFiles) {
    try {
      const meta: InflightMeta = JSON.parse(fs.readFileSync(path.join(dir, metaFile), 'utf-8'))
      if (meta.sessionId !== sessionId) continue
      if (conversationId && meta.conversationId !== conversationId) continue
      const outputPath = path.join(dir, meta.outputFile)
      tasks.push({
        id: meta.id,
        conversationId: meta.conversationId,
        sessionId: meta.sessionId,
        text: meta.text,
        pid: meta.pid,
        startedAt: meta.startedAt,
        outputPath,
        outputText: readOutputText(outputPath),
        running: meta.pid ? isAlive(meta.pid) : true,
      })
    } catch {}
  }

  return tasks.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
}

export function listCompletedInflightSnapshotsForSession(sessionId: string, conversationId?: string): CompletedInflightSnapshot[] {
  const dir = getInflightDir()
  pruneCompletedSnapshots(dir)
  const entries = fs.readdirSync(dir).filter(f => f.endsWith(COMPLETED_SUFFIX))
  const snapshots: CompletedInflightSnapshot[] = []

  for (const entry of entries) {
    try {
      const snapshot: CompletedInflightSnapshot = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf-8'))
      if (snapshot.sessionId !== sessionId) continue
      if (conversationId && snapshot.conversationId !== conversationId) continue
      snapshots.push(snapshot)
    } catch {}
  }

  return snapshots.sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt))
}

// --- 内存队列 ---

const groups = new Map<string, GroupState>()

function getGroup(conversationId: string): GroupState {
  let g = groups.get(conversationId)
  if (!g) {
    g = { state: 'idle', currentChild: null, queue: [], timeoutTimer: null }
    groups.set(conversationId, g)
  }
  return g
}

function isQueuedMessageStillAttached(msg: QueuedMessage): boolean {
  const current = getBinding(msg.conversationId)
  if (!current) return false
  if (msg.expectedSessionId && current.sessionId !== msg.expectedSessionId) return false
  return true
}

async function sendQueuedReplyIfAttached(msg: QueuedMessage, text: string): Promise<void> {
  if (!isQueuedMessageStillAttached(msg)) {
    log(`[${msg.conversationId}] 结果已丢弃：远程连接已断开或已切换到其他对话`)
    return
  }
  await msg.sendReply(text)
}

/** 将普通消息入队 */
export function enqueue(
  conversationId: string,
  text: string,
  sendReply: (text: string) => Promise<void>,
  timeoutSeconds: number,
): void {
  const group = getGroup(conversationId)
  const binding = getBinding(conversationId)
  let entry!: QueuedMessage

  const promise = new Promise<string>((resolve, reject) => {
    entry = {
      conversationId,
      text,
      resolve,
      reject,
      sendReply,
      expectedSessionId: binding?.sessionId ?? null,
    }
    group.queue.push(entry)
    savePending()
  })

  // 通知用户排队状态
  if (group.state === 'busy') {
    sendQueuedReplyIfAttached(entry, `⏳ 已收到，当前有任务执行中，排在第 ${group.queue.length} 位`).catch(() => {})
  }

  // 如果空闲，立即处理
  if (group.state === 'idle') {
    processNext(conversationId, sendReply, timeoutSeconds)
  }

  // 结果回传飞书（如果已经流式发送过了，result 为空，跳过）
  promise.then(result => {
    if (result) sendQueuedReplyIfAttached(entry, result).catch(() => {})
  }).catch(err => sendQueuedReplyIfAttached(entry, formatError(err)).catch(() => {}))
}

/** 处理队列中的下一条消息 */
async function processNext(
  conversationId: string,
  sendReply: (text: string) => Promise<void>,
  timeoutSeconds: number,
): Promise<void> {
  const group = getGroup(conversationId)
  const msg = group.queue.shift()
  savePending()

  if (!msg) {
    group.state = 'idle'
    return
  }

  const binding = getBinding(conversationId)
  if (!binding) {
    msg.reject(new Error('该群未接入对话，请先 /fc <名称> 或 /fn <名称>'))
    processNext(conversationId, sendReply, timeoutSeconds)
    return
  }
  msg.expectedSessionId = binding.sessionId

  group.state = 'busy'
  log(`[${conversationId}] 开始执行: ${msg.text.slice(0, 30)}...`)

  // 创建 inflight 记录
  const inflight = createInflight(conversationId, binding.sessionId, msg.text)
  const outputFile = path.join(getInflightDir(), inflight.outputFile)

  // 超时计时
  group.timeoutTimer = setTimeout(() => {
    if (group.state === 'busy' && group.currentChild) {
      log(`[${conversationId}] 执行超时 (${timeoutSeconds}s)，中断`)
      handleStop(conversationId)
      msg.reject(new Error(`执行超时 (${Math.floor(timeoutSeconds / 60)}分钟)，已中断`))
    }
  }, timeoutSeconds * 1000)

  let streamed = false
  let completionStatus: CompletedInflightStatus = 'completed'
  let completionPreview = ''
  try {
    const driver = getDriver(binding.tool ?? 'claude')
    const output = await driver.sendMessage(
      binding.sessionId,
      msg.text,
      binding.cwd,
      binding.permissionMode,
      {
        onSpawn: (child) => {
          group.currentChild = child
          if (child.pid) updateInflightPid(inflight.id, child.pid)
        },
        outputFile,
        onTurnText: (text) => {
          // 每轮 assistant 文字就绪后立即发到 IM
          streamed = true
          sendQueuedReplyIfAttached(msg, formatOutput(text, binding.sessionId, binding.transport, binding.tool)).catch(() => {})
        },
      },
    )

    updateBinding(conversationId, { turnCount: binding.turnCount + 1 })
    completionPreview = output
    // 如果已经流式发送过，不再重复发最终累积文本
    msg.resolve(streamed ? '' : formatOutput(output, binding.sessionId, binding.transport, binding.tool))
  } catch (err) {
    const queueState = group.state as JobState
    completionStatus = queueState === 'cancelling' ? 'interrupted' : 'failed'
    completionPreview = err instanceof Error ? err.message : String(err)
    msg.reject(err instanceof Error ? err : new Error(String(err)))
  } finally {
    const outputText = readOutputText(outputFile)
    saveCompletedInflightSnapshot(inflight, completionStatus, outputText || completionPreview)
    cleanupInflight(inflight.id)
    clearTimeout(group.timeoutTimer!)
    group.timeoutTimer = null
    group.currentChild = null
    group.state = 'idle'
    // 继续处理队列
    if (group.queue.length > 0) {
      processNext(conversationId, sendReply, timeoutSeconds)
    }
  }
}

/** /stop — 中断当前任务（控制面，不入队列） */
export async function handleStop(conversationId: string): Promise<string> {
  const group = getGroup(conversationId)
  if (group.state !== 'busy' || !group.currentChild) {
    return '当前没有执行中的任务'
  }
  group.state = 'cancelling'
  const binding = getBinding(conversationId)
  const driver = binding ? getDriver(binding.tool ?? 'claude') : getDefaultDriver()
  await driver.interrupt(group.currentChild)
  // 不在此处设置 idle — processNext 的 finally 块会负责状态转换
  return '✅ 已中断当前任务'
}

/** 获取群的当前状态 */
export function getQueueStatus(conversationId: string): { state: JobState; queueLength: number } {
  const group = getGroup(conversationId)
  return { state: group.state, queueLength: group.queue.length }
}

/** 启动时恢复：发送上次未完成的 inflight 结果 + 重新入队 pending 消息 */
export async function recoverOnStartup(
  sendToGroup: (conversationId: string, text: string) => Promise<void>,
  makeSendReply: (conversationId: string) => (text: string) => Promise<void>,
  timeoutSeconds: number,
): Promise<void> {
  // 1. 恢复 inflight 任务的结果
  const dir = getInflightDir()
  const metaFiles = fs.readdirSync(dir).filter(f => f.endsWith('.meta.json'))

  for (const metaFile of metaFiles) {
    try {
      const meta: InflightMeta = JSON.parse(fs.readFileSync(path.join(dir, metaFile), 'utf-8'))
      const outputPath = path.join(dir, meta.outputFile)

      // 杀掉可能还在跑的孤儿进程
      if (meta.pid) {
        try { process.kill(meta.pid, 'SIGTERM') } catch {}
      }

      let resultText = ''
      if (fs.existsSync(outputPath)) {
        resultText = fs.readFileSync(outputPath, 'utf-8').trim()
      }

      // 获取 transport 类型用于格式化
      const recoveryBinding = getBinding(meta.conversationId)
      if (!recoveryBinding || recoveryBinding.sessionId !== meta.sessionId) {
        log(`[recovery] 已丢弃 "${meta.text.slice(0, 30)}..." 的结果：远程连接已断开或已切换`)
        try { fs.unlinkSync(path.join(dir, metaFile)) } catch {}
        try { fs.unlinkSync(outputPath) } catch {}
        continue
      }
      const recoveryTransport = recoveryBinding.transport ?? 'feishu' as const
      const recoveryTool = recoveryBinding.tool ?? 'claude'

      if (resultText) {
        await sendToGroup(meta.conversationId, formatOutput(resultText, meta.sessionId, recoveryTransport, recoveryTool))
        log(`[recovery] 已发送 "${meta.text.slice(0, 30)}..." 的结果`)
      } else {
        await sendToGroup(meta.conversationId,
          `⚠️ 上次任务因守护进程重启被中断，未能获取结果。\n原始消息: "${meta.text.slice(0, 80)}"\n请重新发送。`)
        log(`[recovery] 任务 "${meta.text.slice(0, 30)}..." 无结果，已通知`)
      }

      // 清理
      try { fs.unlinkSync(path.join(dir, metaFile)) } catch {}
      try { fs.unlinkSync(outputPath) } catch {}
    } catch (err) {
      log(`[recovery] 处理 ${metaFile} 失败: ${err}`)
    }
  }

  // 2. 恢复 pending 队列
  const pending = loadPending()
  if (pending.length > 0) {
    log(`[recovery] 恢复 ${pending.length} 条待处理消息`)
    clearPending()
    for (const entry of pending) {
      enqueue(entry.conversationId, entry.text, makeSendReply(entry.conversationId), timeoutSeconds)
    }
  }
}

/** 本地接回电脑时，中断仍在为旧远程连接执行的 inflight 任务。 */
export async function interruptInflightTasksForSession(sessionId: string, conversationId?: string): Promise<number> {
  const dir = getInflightDir()
  const metaFiles = fs.readdirSync(dir).filter(f => f.endsWith('.meta.json'))
  let interrupted = 0

  for (const metaFile of metaFiles) {
    try {
      const meta: InflightMeta = JSON.parse(fs.readFileSync(path.join(dir, metaFile), 'utf-8'))
      if (meta.sessionId !== sessionId) continue
      if (conversationId && meta.conversationId !== conversationId) continue
      if (!meta.pid || !isAlive(meta.pid)) continue

      sendSignalToPidGroup(meta.pid, 'SIGINT')
      await new Promise(resolve => setTimeout(resolve, 300))
      if (isAlive(meta.pid)) {
        sendSignalToPidGroup(meta.pid, 'SIGTERM')
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      if (isAlive(meta.pid)) {
        sendSignalToPidGroup(meta.pid, 'SIGKILL')
      }
      interrupted += 1
    } catch {}
  }

  return interrupted
}
