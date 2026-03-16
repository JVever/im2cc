/**
 * @input:    用户消息, Claude 驱动, Session 绑定
 * @output:   enqueue(), handleStop(), getQueueStatus(), recoverOnStartup() — 消息队列、Job 管理、持久化恢复
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { sendMessage, interrupt } from './claude-driver.js'
import { getBinding, updateBinding } from './session.js'
import { getInflightDir, getPendingFile } from './config.js'
import { formatOutput, formatError } from './output.js'
import { log } from './logger.js'

type JobState = 'idle' | 'busy' | 'cancelling'

interface QueuedMessage {
  groupId: string
  text: string
  resolve: (result: string) => void
  reject: (err: Error) => void
}

interface GroupState {
  state: JobState
  currentChild: ChildProcess | null
  queue: QueuedMessage[]
  timeoutTimer: NodeJS.Timeout | null
}

// --- 持久化：pending 队列 ---

interface PendingEntry {
  groupId: string
  text: string
}

function savePending(): void {
  const entries: PendingEntry[] = []
  for (const [, group] of groups) {
    for (const msg of group.queue) {
      entries.push({ groupId: msg.groupId, text: msg.text })
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
  groupId: string
  sessionId: string
  text: string
  pid: number | null
  startedAt: string
  outputFile: string
}

function createInflight(groupId: string, sessionId: string, text: string): InflightMeta {
  const id = crypto.randomUUID()
  const dir = getInflightDir()
  const meta: InflightMeta = {
    id, groupId, sessionId, text,
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

// --- 内存队列 ---

const groups = new Map<string, GroupState>()

function getGroup(groupId: string): GroupState {
  let g = groups.get(groupId)
  if (!g) {
    g = { state: 'idle', currentChild: null, queue: [], timeoutTimer: null }
    groups.set(groupId, g)
  }
  return g
}

/** 将普通消息入队 */
export function enqueue(
  groupId: string,
  text: string,
  sendReply: (text: string) => Promise<void>,
  timeoutSeconds: number,
): void {
  const group = getGroup(groupId)

  const promise = new Promise<string>((resolve, reject) => {
    group.queue.push({ groupId, text, resolve, reject })
    savePending()
  })

  // 通知用户排队状态
  if (group.state === 'busy') {
    sendReply(`⏳ 已收到，当前有任务执行中，排在第 ${group.queue.length} 位`).catch(() => {})
  }

  // 如果空闲，立即处理
  if (group.state === 'idle') {
    processNext(groupId, sendReply, timeoutSeconds)
  }

  // 结果回传飞书
  promise.then(result => sendReply(result)).catch(err => sendReply(formatError(err)))
}

/** 处理队列中的下一条消息 */
async function processNext(
  groupId: string,
  sendReply: (text: string) => Promise<void>,
  timeoutSeconds: number,
): Promise<void> {
  const group = getGroup(groupId)
  const msg = group.queue.shift()
  savePending()

  if (!msg) {
    group.state = 'idle'
    return
  }

  const binding = getBinding(groupId)
  if (!binding) {
    msg.reject(new Error('该群未接入对话，请先 /fc <名称> 或 /fn <名称>'))
    processNext(groupId, sendReply, timeoutSeconds)
    return
  }

  group.state = 'busy'
  log(`[${groupId}] 开始执行: ${msg.text.slice(0, 50)}...`)

  // 创建 inflight 记录
  const inflight = createInflight(groupId, binding.sessionId, msg.text)
  const outputFile = path.join(getInflightDir(), inflight.outputFile)

  // 超时计时
  group.timeoutTimer = setTimeout(() => {
    if (group.state === 'busy' && group.currentChild) {
      log(`[${groupId}] 执行超时 (${timeoutSeconds}s)，中断`)
      handleStop(groupId)
      msg.reject(new Error(`执行超时 (${Math.floor(timeoutSeconds / 60)}分钟)，已中断`))
    }
  }, timeoutSeconds * 1000)

  try {
    const output = await sendMessage(
      binding.sessionId,
      msg.text,
      binding.cwd,
      binding.permissionMode,
      (child) => {
        group.currentChild = child
        if (child.pid) updateInflightPid(inflight.id, child.pid)
      },
      outputFile,
    )

    updateBinding(groupId, { turnCount: binding.turnCount + 1 })
    msg.resolve(formatOutput(output, binding.sessionId))
  } catch (err) {
    msg.reject(err instanceof Error ? err : new Error(String(err)))
  } finally {
    cleanupInflight(inflight.id)
    clearTimeout(group.timeoutTimer!)
    group.timeoutTimer = null
    group.currentChild = null
    group.state = 'idle'
    // 继续处理队列
    if (group.queue.length > 0) {
      processNext(groupId, sendReply, timeoutSeconds)
    }
  }
}

/** /stop — 中断当前任务（控制面，不入队列） */
export async function handleStop(groupId: string): Promise<string> {
  const group = getGroup(groupId)
  if (group.state !== 'busy' || !group.currentChild) {
    return '当前没有执行中的任务'
  }
  group.state = 'cancelling'
  await interrupt(group.currentChild)
  group.state = 'idle'
  return '✅ 已中断当前任务'
}

/** 获取群的当前状态 */
export function getQueueStatus(groupId: string): { state: JobState; queueLength: number } {
  const group = getGroup(groupId)
  return { state: group.state, queueLength: group.queue.length }
}

/** 启动时恢复：发送上次未完成的 inflight 结果 + 重新入队 pending 消息 */
export async function recoverOnStartup(
  sendToGroup: (groupId: string, text: string) => Promise<void>,
  makeSendReply: (groupId: string) => (text: string) => Promise<void>,
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

      if (resultText) {
        await sendToGroup(meta.groupId, formatOutput(resultText, meta.sessionId))
        log(`[recovery] 已发送 "${meta.text.slice(0, 30)}..." 的结果`)
      } else {
        await sendToGroup(meta.groupId,
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
      enqueue(entry.groupId, entry.text, makeSendReply(entry.groupId), timeoutSeconds)
    }
  }
}
