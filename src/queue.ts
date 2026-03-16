/**
 * @input:    用户消息, Claude 驱动, Session 绑定
 * @output:   enqueue(), processNext(), handleControlCommand(), getStatus() — 消息队列和 Job 管理
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import type { ChildProcess } from 'node:child_process'
import { sendMessage, interrupt } from './claude-driver.js'
import { getBinding, updateBinding } from './session.js'
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
      (child) => { group.currentChild = child },
    )

    updateBinding(groupId, { turnCount: binding.turnCount + 1 })
    msg.resolve(formatOutput(output, binding.sessionId))
  } catch (err) {
    msg.reject(err instanceof Error ? err : new Error(String(err)))
  } finally {
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
