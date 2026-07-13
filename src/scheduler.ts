/**
 * @input:    schedule-store 持久化数据, registry Session 模型 ID + selection watermark, 原生模型 observed baseline, session/queue/driver/transport
 * @output:   initScheduler(), addSchedule(), cancelScheduleByName(), getScheduleByName(), formatScheduleStatus() — 在线走 queue，离线 turn 也只用本次新增模型事实条件校正
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import { lookup, type RegisteredSession } from './registry.js'
import { listActiveBindings, type Binding } from './session.js'
import { getDriver } from './tool-driver.js'
import { enqueue } from './queue.js'
import { queueDelayedReply } from './anti-pomodoro.js'
import { log, error } from './logger.js'
import { nextCronFire } from './schedule-parser.js'
import {
  type Schedule,
  type ScheduleKind,
  type UpsertInput,
  listSchedules,
  getScheduleByName as storeGetByName,
  upsertSchedule,
  removeScheduleByName,
  removeScheduleById,
  updateAfterFire,
} from './schedule-store.js'
import type { OutgoingMessage, TransportType } from './transport.js'
import { markdownTextMessage } from './message-format.js'
import { getLatestObservedModel, reconcileActualModelForSession } from './session-model.js'

type SendToChat = (transport: TransportType, conversationId: string, message: string | OutgoingMessage) => Promise<void>

interface SchedulerDeps {
  sendToChat: SendToChat
}

const timers = new Map<string, NodeJS.Timeout>()
let deps: SchedulerDeps | null = null

/** setTimeout 不能跨 24.8 天的 ms 上限，超出时分段挂载 */
const MAX_TIMEOUT_MS = 2_147_483_000

function scheduleTimer(s: Schedule): void {
  clearScheduledTimer(s.id)
  const delay = Math.max(0, s.nextFireAt - Date.now())
  if (delay > MAX_TIMEOUT_MS) {
    const t = setTimeout(() => scheduleTimer(s), MAX_TIMEOUT_MS)
    t.unref?.()
    timers.set(s.id, t)
    return
  }
  const t = setTimeout(() => {
    timers.delete(s.id)
    void fireSchedule(s.id)
  }, delay)
  // 不 unref —— 定时消息必须保持事件循环
  timers.set(s.id, t)
}

function clearScheduledTimer(id: string): void {
  const t = timers.get(id)
  if (t) {
    clearTimeout(t)
    timers.delete(id)
  }
}

async function fireSchedule(id: string): Promise<void> {
  // 触发瞬间复读持久化数据，防止取消/替换的并发与触发竞争
  const fresh = listSchedules().find(x => x.id === id)
  if (!fresh) return  // 已被取消

  const reg = lookup(fresh.name)
  if (!reg) {
    await safeSend(fresh.transport, fresh.conversationId,
      `⚠️ 定时消息触发失败：对话 "${fresh.name}" 已不存在或已被删除。\n原消息：${fresh.message}`)
    removeScheduleById(fresh.id)
    return
  }

  // 1. 投递消息到目标 session
  const targetBinding = listActiveBindings().find(b => b.sessionId === reg.sessionId)
  const deliveryNote = await deliverMessage(fresh, reg, targetBinding)

  // 2. 发回执到原 chat（无论有没有 binding）
  await safeSend(fresh.transport, fresh.conversationId, formatReceipt(fresh, deliveryNote))

  // 3. one-shot 删除；cron 重算下一次
  if (fresh.kind === 'cron') {
    const next = nextCronFire(fresh.spec, new Date())
    if (next === null) {
      await safeSend(fresh.transport, fresh.conversationId,
        `⚠️ cron "${fresh.spec}" 已无后续触发，已删除`)
      removeScheduleById(fresh.id)
      return
    }
    updateAfterFire(fresh.id, next.getTime())
    const updated = storeGetByName(fresh.name)
    if (updated) scheduleTimer(updated)
  } else {
    removeScheduleById(fresh.id)
  }
}

async function deliverMessage(
  s: Schedule,
  reg: RegisteredSession,
  targetBinding: Binding | undefined,
): Promise<string> {
  if (targetBinding) {
    // 有活跃绑定：走 queue，输出回到当前绑定的 chat；
    // 反茄钟休息期：queueDelayedReply 会拦下输出延迟到工作期再送达，与人发的消息一视同仁
    enqueue(targetBinding.conversationId, s.message, async (reply) => {
      if (typeof reply === 'string') {
        // 触发的 AI 文本回复：飞书按 Markdown 渲染；反茄钟休息期延迟到工作期再送达（带 markdown 标记）
        if (queueDelayedReply(targetBinding.conversationId, reply, Date.now(), { markdown: true })) return
        await safeSend(targetBinding.transport, targetBinding.conversationId, markdownTextMessage(reply))
      } else {
        // OutgoingMessage（含 tool_status）：交给 sendToConversation 分发（飞书对应 msg_type / 微信纯文本降级）
        await safeSend(targetBinding.transport, targetBinding.conversationId, reply)
      }
    })
    const sameChat = targetBinding.conversationId === s.conversationId
    return sameChat ? '已投递到当前对话队列' : `已投递（结果回到当前接入端：${transportLabel(targetBinding.transport)}）`
  }

  // 无任何活跃绑定：直接 driver 调用，输出落日志
  const tool = (reg.tool ?? 'claude') as Parameters<typeof getDriver>[0]
  const driver = getDriver(tool)
  const permissionMode = reg.permissionMode ?? ''
  const observedBaseline = getLatestObservedModel(tool, reg.sessionId, reg.cwd)
  driver.sendMessage(reg.sessionId, s.message, reg.cwd, permissionMode, {
    modelOverride: reg.selectedModelId,
  }).then(output => {
    reconcileActualModelForSession(
      tool,
      reg.sessionId,
      reg.cwd,
      reg.modelSelectionUpdatedAt,
      observedBaseline,
    )
    log(`[scheduler] "${reg.name}" 离线触发完成（${output.length} 字符），输出已写入日志`)
  }).catch(err => {
    error(`[scheduler] "${reg.name}" 离线触发失败: ${err}`)
  })
  return '已投递到本地（当前无 IM 端接入，输出仅写入日志）'
}

function formatReceipt(s: Schedule, deliveryNote: string): string {
  const trigger = describeTrigger(s)
  const lines = [`⏰ 定时消息已触发（${trigger}）`, '']
  const delayMs = Date.now() - s.nextFireAt
  if (delayMs > 60_000) {
    lines.push(`⚠️ 实际延迟 ${Math.round(delayMs / 60_000)} 分钟（守护进程曾停机）`)
  } else if (delayMs > 5000) {
    lines.push(`（延迟 ${Math.round(delayMs / 1000)} 秒触发）`)
  }
  lines.push(`目标：${s.name}`)
  lines.push(`消息：${truncate(s.message, 200)}`)
  lines.push(deliveryNote)
  return lines.join('\n')
}

function transportLabel(t: TransportType): string {
  return t === 'feishu' ? '飞书' : t === 'wechat' ? '微信' : t
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

async function safeSend(transport: TransportType, conversationId: string, message: string | OutgoingMessage): Promise<void> {
  if (!deps) {
    error(`[scheduler] 未初始化，无法发送回执`)
    return
  }
  try {
    await deps.sendToChat(transport, conversationId, message)
  } catch (err) {
    error(`[scheduler] 回执发送失败 [${conversationId}]: ${err}`)
  }
}

/** 启动时调用：清空 timer、按持久化数据重建、对错过窗口的 schedule 立即处理 */
export async function initScheduler(injected: SchedulerDeps): Promise<void> {
  deps = injected
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()

  const all = listSchedules()
  const now = Date.now()
  for (const s of all) {
    if (s.nextFireAt <= now) {
      // 错过窗口处理：at/in 仍触发，cron 跳过这一次重算下次
      if (s.kind === 'cron') {
        const next = nextCronFire(s.spec, new Date())
        if (next === null) {
          log(`[scheduler] cron "${s.spec}" 已无后续触发，删除 ${s.name}`)
          await safeSend(s.transport, s.conversationId,
            `⚠️ cron "${s.spec}"（${s.name}）已无后续触发，已删除`)
          removeScheduleById(s.id)
          continue
        }
        const missedMin = Math.round((now - s.nextFireAt) / 60_000)
        await safeSend(s.transport, s.conversationId,
          `⚠️ 错过 cron 触发（${s.name}，${missedMin} 分钟前），已跳过本次，下次：${formatTime(next)}`)
        updateAfterFire(s.id, next.getTime())
        const updated = storeGetByName(s.name)
        if (updated) scheduleTimer(updated)
      } else {
        // at/in 错过 → 立即触发
        log(`[scheduler] 立即触发错过的 ${s.kind} "${s.name}"（错过 ${Math.round((now - s.nextFireAt) / 60_000)} 分钟）`)
        void fireSchedule(s.id)
      }
    } else {
      scheduleTimer(s)
    }
  }
  log(`[scheduler] 已加载 ${all.length} 条定时消息`)
}

export interface AddScheduleInput {
  name: string
  transport: TransportType
  conversationId: string
  kind: ScheduleKind
  spec: string
  message: string
  nextFireAt: number
}

export function addSchedule(input: AddScheduleInput): { schedule: Schedule; replaced: Schedule | null } {
  const upsertInput: UpsertInput = input
  const result = upsertSchedule(upsertInput)
  if (result.replaced) clearScheduledTimer(result.replaced.id)
  scheduleTimer(result.schedule)
  return result
}

export function cancelScheduleByName(name: string): Schedule | null {
  const removed = removeScheduleByName(name)
  if (removed) clearScheduledTimer(removed.id)
  return removed
}

export function getScheduleByName(name: string): Schedule | null {
  return storeGetByName(name)
}

export function listAllSchedules(): Schedule[] {
  return listSchedules()
}

export function formatScheduleStatus(s: Schedule): string {
  return [
    `🕐 当前定时消息（${s.name}）`,
    `类型：${describeTrigger(s)}`,
    `下次触发：${formatTime(new Date(s.nextFireAt))}（${describeRelative(s.nextFireAt)}）`,
    `消息：${truncate(s.message, 200)}`,
  ].join('\n')
}

/** 单行格式（用于 /at list）：name | kind spec | 时间 | 消息预览 */
export function formatScheduleListLine(s: Schedule): string {
  const time = `${formatTime(new Date(s.nextFireAt))} (${describeRelative(s.nextFireAt)})`
  return `${s.name}  [${describeTrigger(s)}]\n  → ${time}\n  ${truncate(s.message, 60)}`
}

function describeTrigger(s: Schedule): string {
  switch (s.kind) {
    case 'at': return `at ${s.spec}`
    case 'in': return `in ${s.spec}`
    case 'cron': return `cron \`${s.spec}\``
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function describeRelative(targetMs: number): string {
  const diff = targetMs - Date.now()
  if (diff < 0) return '已过期'
  const sec = Math.round(diff / 1000)
  if (sec < 60) return `${sec} 秒后`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} 分钟后`
  const hour = Math.round(min / 60)
  if (hour < 48) return `${hour} 小时后`
  const day = Math.round(hour / 24)
  return `${day} 天后`
}
