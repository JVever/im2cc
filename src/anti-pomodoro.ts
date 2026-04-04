/**
 * @input:    ~/.im2cc/data/anti-pomodoro.json, 当前时间, 会话消息
 * @output:   反茄钟状态读写、周期推进、休息期单次后台指令额度、延迟结果队列、daemon 同步控制器
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import { getAntiPomodoroFile } from './config.js'
import { error } from './logger.js'

export const ANTI_POMODORO_WORK_MS = 5 * 60 * 1000
export const ANTI_POMODORO_REST_MS = 30 * 60 * 1000
export const ANTI_POMODORO_IM_COMMANDS = new Set(['fqon', 'fqoff', 'fqs'])
const ANTI_POMODORO_RETRY_MS = 15 * 1000

export type AntiPomodoroPhase = 'waiting' | 'work' | 'rest'

interface DelayedReply {
  conversationId: string
  text: string
  queuedAt: string
}

export interface AntiPomodoroState {
  version: 1
  enabled: boolean
  phase: AntiPomodoroPhase
  phaseStartedAt: string
  phaseEndsAt: string
  workMs: number
  restMs: number
  restQuotaUsed: boolean
  delayedReplies: DelayedReply[]
  updatedAt: string
}

export interface AntiPomodoroSnapshot {
  enabled: boolean
  phase: AntiPomodoroPhase | null
  remainingMs: number
  workMs: number
  restMs: number
  restQuotaUsed: boolean
}

export interface ToggleResult {
  changed: boolean
  message: string
  snapshot: AntiPomodoroSnapshot
}

export interface RestQuotaDecision {
  allowed: boolean
  notice?: string
  rejection?: string
  snapshot: AntiPomodoroSnapshot
}

function nowIso(now: number = Date.now()): string {
  return new Date(now).toISOString()
}

function createDisabledState(now: number = Date.now()): AntiPomodoroState {
  const iso = nowIso(now)
  return {
    version: 1,
    enabled: false,
    phase: 'waiting',
    phaseStartedAt: iso,
    phaseEndsAt: iso,
    workMs: ANTI_POMODORO_WORK_MS,
    restMs: ANTI_POMODORO_REST_MS,
    restQuotaUsed: false,
    delayedReplies: [],
    updatedAt: iso,
  }
}

function sanitizeState(raw: Partial<AntiPomodoroState> | null | undefined, now: number = Date.now()): AntiPomodoroState {
  const base = createDisabledState(now)
  if (!raw || typeof raw !== 'object') return base

  return {
    version: 1,
    enabled: raw.enabled === true,
    phase: raw.phase === 'rest' || raw.phase === 'work' ? raw.phase : 'waiting',
    phaseStartedAt: typeof raw.phaseStartedAt === 'string' ? raw.phaseStartedAt : base.phaseStartedAt,
    phaseEndsAt: typeof raw.phaseEndsAt === 'string' ? raw.phaseEndsAt : base.phaseEndsAt,
    workMs: typeof raw.workMs === 'number' && raw.workMs > 0 ? raw.workMs : base.workMs,
    restMs: typeof raw.restMs === 'number' && raw.restMs > 0 ? raw.restMs : base.restMs,
    restQuotaUsed: raw.restQuotaUsed === true,
    delayedReplies: Array.isArray(raw.delayedReplies)
      ? raw.delayedReplies
        .filter((item): item is DelayedReply =>
          Boolean(item)
          && typeof item === 'object'
          && typeof item.conversationId === 'string'
          && typeof item.text === 'string'
          && typeof item.queuedAt === 'string',
        )
      : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
  }
}

function readState(now: number = Date.now()): AntiPomodoroState {
  const file = getAntiPomodoroFile()
  if (!fs.existsSync(file)) return createDisabledState(now)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<AntiPomodoroState>
    return sanitizeState(raw, now)
  } catch {
    return createDisabledState(now)
  }
}

function writeState(state: AntiPomodoroState): void {
  const file = getAntiPomodoroFile()
  const tmp = `${file}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, file)
}

function phaseEndMs(state: AntiPomodoroState): number {
  return Date.parse(state.phaseEndsAt)
}

function phaseStartMs(state: AntiPomodoroState): number {
  return Date.parse(state.phaseStartedAt)
}

function normalizePhaseTimestamps(state: AntiPomodoroState, now: number): boolean {
  const startMs = phaseStartMs(state)
  const endMs = phaseEndMs(state)
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) return false

  const startAt = now
  const duration = state.phase === 'rest' ? state.restMs : state.phase === 'work' ? state.workMs : 0
  state.phaseStartedAt = nowIso(startAt)
  state.phaseEndsAt = nowIso(startAt + duration)
  state.updatedAt = nowIso(now)
  return true
}

function setPhase(
  state: AntiPomodoroState,
  phase: AntiPomodoroPhase,
  phaseStartAtMs: number,
  updatedAtMs: number = phaseStartAtMs,
): void {
  state.phase = phase
  state.phaseStartedAt = nowIso(phaseStartAtMs)
  state.phaseEndsAt = nowIso(
    phase === 'work'
      ? phaseStartAtMs + state.workMs
      : phase === 'rest'
        ? phaseStartAtMs + state.restMs
        : phaseStartAtMs,
  )
  state.restQuotaUsed = false
  state.updatedAt = nowIso(updatedAtMs)
}

function reconcileState(state: AntiPomodoroState, now: number = Date.now()): { state: AntiPomodoroState, changed: boolean } {
  let changed = normalizePhaseTimestamps(state, now)

  if (!state.enabled) {
    if (state.delayedReplies.length > 0 || state.restQuotaUsed) {
      state.delayedReplies = []
      state.restQuotaUsed = false
      state.updatedAt = nowIso(now)
      changed = true
    }
    return { state, changed }
  }

  if (state.phase === 'waiting') {
    return { state, changed }
  }

  while (phaseEndMs(state) <= now) {
    const cursor = phaseEndMs(state)
    if (state.phase === 'work') {
      setPhase(state, 'rest', cursor, now)
      changed = true
      continue
    } else {
      setPhase(state, 'waiting', cursor, now)
      changed = true
      break
    }
  }

  return { state, changed }
}

function toSnapshot(state: AntiPomodoroState, now: number = Date.now()): AntiPomodoroSnapshot {
  if (!state.enabled) {
    return {
      enabled: false,
      phase: null,
      remainingMs: 0,
      workMs: state.workMs,
      restMs: state.restMs,
      restQuotaUsed: false,
    }
  }

  return {
    enabled: true,
    phase: state.phase,
    remainingMs: state.phase === 'waiting' ? 0 : Math.max(0, phaseEndMs(state) - now),
    workMs: state.workMs,
    restMs: state.restMs,
    restQuotaUsed: state.restQuotaUsed,
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds} 秒`
  if (seconds === 0) return `${minutes} 分钟`
  return `${minutes} 分 ${seconds} 秒`
}

export function formatAntiPomodoroRemaining(ms: number): string {
  return formatDuration(ms)
}

function renderCard(title: string, lines: string[]): string {
  return [title, '', ...lines].join('\n')
}

function statusLines(snapshot: AntiPomodoroSnapshot): string[] {
  if (!snapshot.enabled) {
    return [
      '状态：未开启',
      '当前：正常收发',
      '开启：电脑端 fqon 或手机端 /fqon',
    ]
  }

  const phaseLabel = snapshot.phase === 'rest'
    ? '休息时间'
    : snapshot.phase === 'work'
      ? '工作时间'
      : '等待开始'
  const lines = [
    '状态：进行中',
    `阶段：${phaseLabel}`,
    `节奏：${Math.floor(snapshot.workMs / 60000)} 分钟工作 / ${Math.floor(snapshot.restMs / 60000)} 分钟休息`,
    '范围：飞书、微信、不同对话全局共享',
  ]

  if (snapshot.phase === 'waiting') {
    lines.splice(2, 0, '触发：发送下一条工作消息后开始 5 分钟工作时间')
  } else {
    lines.splice(2, 0, `剩余：${formatDuration(snapshot.remainingMs)}`)
  }

  if (snapshot.phase === 'rest') {
    lines.push(`休息期后台指令：${snapshot.restQuotaUsed ? '已用完' : '可用 1 次'}`)
  }

  lines.push('关闭：电脑端 fqoff')
  return lines
}

export function formatAntiPomodoroStatus(snapshot: AntiPomodoroSnapshot): string {
  return renderCard('反茄钟', statusLines(snapshot))
}

export function formatAntiPomodoroRemoteOffDenied(snapshot: AntiPomodoroSnapshot): string {
  return renderCard('⛔ 不能在手机端关闭反茄钟', [
    '关闭：请回到电脑端执行 fqoff',
    ...statusLines(snapshot),
  ])
}

export function formatAntiPomodoroRestCommandBlocked(snapshot: AntiPomodoroSnapshot): string {
  return renderCard('⛔ 现在是休息时间', [
    '限制：当前不接受这个命令',
    `继续：请等 ${formatDuration(snapshot.remainingMs)} 后结束休息`,
    '之后：电脑端结果会恢复推送；新的工作时间仍由你下一条工作消息开启',
    '查看：发送 /fqs 可查看当前状态',
  ])
}

export function formatAntiPomodoroRestFileBlocked(snapshot: AntiPomodoroSnapshot): string {
  return renderCard('⛔ 现在是休息时间', [
    '限制：当前不接受文件或图片',
    `继续：请等 ${formatDuration(snapshot.remainingMs)} 后结束休息`,
    '之后：电脑端结果会恢复推送；新的工作时间仍由你下一条工作消息开启',
    '查看：发送 /fqs 可查看当前状态',
  ])
}

export function formatAntiPomodoroWorkStarted(snapshot: AntiPomodoroSnapshot): string {
  return renderCard('▶️ 已开始本轮工作时间', [
    `剩余：${formatDuration(snapshot.remainingMs)}`,
    `结束：到时自动进入 ${Math.floor(snapshot.restMs / 60000)} 分钟休息`,
  ])
}

function buildEnableMessage(snapshot: AntiPomodoroSnapshot, changed: boolean): string {
  const title = changed ? '✅ 已开启反茄钟' : 'ℹ️ 反茄钟已在运行'
  return renderCard(title, statusLines(snapshot))
}

function buildDisableMessage(reason?: string): string {
  const lines = ['状态：已关闭', '当前：恢复正常收发', '开启：电脑端 fqon 或手机端 /fqon']
  if (reason) lines.splice(1, 0, `原因：${reason}`)
  return renderCard('✅ 已关闭反茄钟', lines)
}

export function getAntiPomodoroSnapshot(now: number = Date.now()): AntiPomodoroSnapshot {
  const state = readState(now)
  const reconciled = reconcileState(state, now)
  if (reconciled.changed) writeState(reconciled.state)
  return toSnapshot(reconciled.state, now)
}

export function enableAntiPomodoro(now: number = Date.now()): ToggleResult {
  const state = readState(now)
  if (!state.enabled) {
    state.enabled = true
    setPhase(state, 'waiting', now, now)
    state.delayedReplies = []
    writeState(state)
    const snapshot = toSnapshot(state, now)
    return { changed: true, message: buildEnableMessage(snapshot, true), snapshot }
  }

  const reconciled = reconcileState(state, now)
  if (reconciled.changed) writeState(reconciled.state)
  const snapshot = toSnapshot(reconciled.state, now)
  return { changed: false, message: buildEnableMessage(snapshot, false), snapshot }
}

export function disableAntiPomodoro(reason?: string, now: number = Date.now()): ToggleResult {
  const state = readState(now)
  if (!state.enabled) {
    const snapshot = toSnapshot(state, now)
    return {
      changed: false,
      message: renderCard('反茄钟', [
        '状态：未开启',
        '当前：正常收发',
        '开启：电脑端 fqon 或手机端 /fqon',
      ]),
      snapshot,
    }
  }

  const disabled = createDisabledState(now)
  writeState(disabled)
  const snapshot = toSnapshot(disabled, now)
  return {
    changed: true,
    message: buildDisableMessage(reason),
    snapshot,
  }
}

export function claimRestQuota(now: number = Date.now()): RestQuotaDecision {
  const state = readState(now)
  const reconciled = reconcileState(state, now)
  if (reconciled.changed) writeState(reconciled.state)

  const current = reconciled.state
  const snapshot = toSnapshot(current, now)
  if (!current.enabled || current.phase !== 'rest') {
    return { allowed: true, snapshot }
  }

  if (!current.restQuotaUsed) {
    current.restQuotaUsed = true
    current.updatedAt = nowIso(now)
    writeState(current)
    return {
      allowed: true,
      notice: renderCard('⏳ 已使用本轮休息期后台指令', [
        '处理：这 1 条消息已发给电脑继续工作',
        '送达：结果会在本轮休息结束后恢复推送',
        `额度：本轮休息期已用完，请等 ${formatDuration(snapshot.remainingMs)} 后再继续`,
      ]),
      snapshot: toSnapshot(current, now),
    }
  }

  return {
    allowed: false,
    rejection: renderCard('⛔ 现在是休息时间', [
      '限制：本轮休息期的 1 条后台指令额度已用完',
      '处理：这条消息不会发给电脑，也不会缓存',
      `继续：请等 ${formatDuration(snapshot.remainingMs)} 后结束休息`,
    ]),
    snapshot,
  }
}

export function queueDelayedReply(conversationId: string, text: string, now: number = Date.now()): boolean {
  const state = readState(now)
  const reconciled = reconcileState(state, now)
  const current = reconciled.state

  if (!current.enabled || current.phase !== 'rest') {
    if (reconciled.changed) writeState(current)
    return false
  }

  current.delayedReplies.push({
    conversationId,
    text,
    queuedAt: nowIso(now),
  })
  current.updatedAt = nowIso(now)
  writeState(current)
  return true
}

export function startWorkPhaseIfWaiting(now: number = Date.now()): { started: boolean, snapshot: AntiPomodoroSnapshot } {
  const state = readState(now)
  const reconciled = reconcileState(state, now)
  const current = reconciled.state

  if (!current.enabled) {
    if (reconciled.changed) writeState(current)
    return { started: false, snapshot: toSnapshot(current, now) }
  }

  if (current.phase === 'waiting') {
    setPhase(current, 'work', now, now)
    writeState(current)
    return { started: true, snapshot: toSnapshot(current, now) }
  }

  if (reconciled.changed) writeState(current)
  return { started: false, snapshot: toSnapshot(current, now) }
}

export function drainDeliverableReplies(now: number = Date.now()): Array<{ conversationId: string, text: string }> {
  const state = readState(now)
  const reconciled = reconcileState(state, now)
  const current = reconciled.state

  if (!current.enabled || current.phase === 'rest' || current.delayedReplies.length === 0) {
    if (reconciled.changed) writeState(current)
    return []
  }

  const replies = current.delayedReplies.map(item => ({ conversationId: item.conversationId, text: item.text }))
  current.delayedReplies = []
  current.updatedAt = nowIso(now)
  writeState(current)
  return replies
}

function getNextDeliverableReply(now: number = Date.now()): DelayedReply | null {
  const state = readState(now)
  const reconciled = reconcileState(state, now)
  const current = reconciled.state

  if (reconciled.changed) writeState(current)
  if (!current.enabled || current.phase === 'rest' || current.delayedReplies.length === 0) {
    return null
  }

  return current.delayedReplies[0]
}

function isSameDelayedReply(left: DelayedReply, right: DelayedReply): boolean {
  return left.conversationId === right.conversationId
    && left.text === right.text
    && left.queuedAt === right.queuedAt
}

function markDelayedReplyDelivered(reply: DelayedReply, now: number = Date.now()): boolean {
  const state = readState(now)
  const reconciled = reconcileState(state, now)
  const current = reconciled.state
  const index = current.delayedReplies.findIndex(item => isSameDelayedReply(item, reply))

  if (index >= 0) {
    current.delayedReplies.splice(index, 1)
    current.updatedAt = nowIso(now)
  }

  if (reconciled.changed || index >= 0) {
    writeState(current)
  }

  return index >= 0
}

export class AntiPomodoroDaemonController {
  private timer: NodeJS.Timeout | null = null
  private syncing = false
  private pendingSync = false
  private watching = false

  constructor(
    private readonly sendByConversationId: (conversationId: string, text: string) => Promise<void>,
  ) {}

  start(): void {
    if (!this.watching) {
      fs.watchFile(getAntiPomodoroFile(), { interval: 1000 }, () => {
        void this.sync()
      })
      this.watching = true
    }
    void this.sync()
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.watching) {
      fs.unwatchFile(getAntiPomodoroFile())
      this.watching = false
    }
  }

  async sync(): Promise<void> {
    if (this.syncing) {
      this.pendingSync = true
      return
    }

    this.syncing = true
    try {
      do {
        this.pendingSync = false
        const now = Date.now()
        const state = readState(now)
        const reconciled = reconcileState(state, now)
        if (reconciled.changed) writeState(reconciled.state)
        this.schedule(reconciled.state, now)

        while (true) {
          const item = getNextDeliverableReply(Date.now())
          if (!item) break

          try {
            await this.sendByConversationId(item.conversationId, item.text)
          } catch (err) {
            error(`[anti-pomodoro] 延迟结果送达失败 [${item.conversationId}]: ${err instanceof Error ? err.message : String(err)}`)
            this.schedule(reconciled.state, Date.now(), ANTI_POMODORO_RETRY_MS)
            break
          }

          markDelayedReplyDelivered(item, Date.now())
        }
      } while (this.pendingSync)
    } finally {
      this.syncing = false
    }
  }

  private schedule(state: AntiPomodoroState, now: number, overrideDelayMs?: number): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if ((!state.enabled || state.phase === 'waiting') && overrideDelayMs == null) return

    const delayMs = Math.max(250, overrideDelayMs ?? (phaseEndMs(state) - now + 50))
    this.timer = setTimeout(() => {
      void this.sync()
    }, delayMs)
  }
}
