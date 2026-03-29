/**
 * @input:    RecapTurn, TransportType
 * @output:   recap 工具函数（过滤 init 消息、/fc 最近一轮分片格式化）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import { MSG_LENGTH_LIMIT, type TransportType } from './transport.js'

export interface RecapTurn {
  user: string
  assistant: string
}

/**
 * 过滤掉 im2cc 创建 session 时的 init 消息（"会话已建立"等）。
 * 各 driver 的 buildRecapTurn 在解析完 turns 后统一调用。
 */
export function filterInitTurns(turns: RecapTurn[]): RecapTurn[] {
  return turns.filter(t =>
    !t.user.includes('会话已建立') && !t.user.includes('请回复')
  )
}

interface BuildRecapMessagesOptions {
  intro?: string
  transport?: TransportType
  maxMessages?: number
}

/**
 * 将最近一轮对话格式化为 1 到 3 条 IM 消息。
 * 规则：
 * - 总是优先返回最近一轮完整对话
 * - 最多返回 maxMessages 条
 * - 超出上限时，优先保留 AI 回复尾部，避免丢失最终结论
 */
export function buildRecapMessages(
  turn: RecapTurn,
  options: BuildRecapMessagesOptions = {},
): string[] {
  const transport = options.transport ?? 'feishu'
  const maxMessages = options.maxMessages ?? 3
  const intro = options.intro?.trim() ?? ''

  if (maxMessages <= 0) return []

  const messageLimit = MSG_LENGTH_LIMIT[transport] ?? 28000
  const firstLimit = Math.max(400, messageLimit - intro.length - 96)
  const otherLimit = Math.max(400, messageLimit - 56)
  const limits = [firstLimit, ...Array.from({ length: maxMessages - 1 }, () => otherLimit)]

  const userText = normalizeRecapText(turn.user)
  const assistantText = normalizeRecapText(turn.assistant)
  const bodies = packTurnBodies(userText, assistantText, limits)
    ?? packTruncatedAssistantBodies(userText, assistantText, limits)

  if (!bodies || bodies.length === 0) return []

  return bodies.map((body, index) => {
    const title = `📋 最近一轮对话 ${index + 1}/${bodies.length}`
    if (index === 0 && intro) {
      return `${intro}\n\n${title}\n\n${body}`
    }
    return `${title}\n\n${body}`
  })
}

function packTruncatedAssistantBodies(userText: string, assistantText: string, limits: number[]): string[] | null {
  const omission = '…(前文已省略)\n'
  let lo = 0
  let hi = assistantText.length
  let best: string[] | null = null

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const tail = omission + assistantText.slice(assistantText.length - mid)
    const packed = packTurnBodies(userText, tail, limits)
    if (packed) {
      best = packed
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return best
}

function packTurnBodies(userText: string, assistantText: string, limits: number[]): string[] | null {
  const sections = [
    { label: '【你】', continuation: '【你 - 续】', content: userText || '(空)' },
    { label: '【AI】', continuation: '【AI - 续】', content: assistantText || '(空)' },
  ]

  const chunks: string[] = []
  let current = ''

  const currentLimit = () => limits[chunks.length] ?? 0
  const flush = () => {
    chunks.push(current.trimEnd())
    current = ''
  }

  for (const section of sections) {
    let remaining = section.content
    let label = section.label

    while (remaining.length > 0) {
      if (chunks.length >= limits.length) return null

      const prefix = current ? `\n\n${label}\n` : `${label}\n`
      const available = currentLimit() - current.length

      if (available <= prefix.length + 1) {
        if (!current) return null
        flush()
        continue
      }

      const room = available - prefix.length
      const piece = takeRecapSlice(remaining, room)
      current += prefix + piece
      remaining = remaining.slice(piece.length)
      label = section.continuation

      if (remaining.length > 0) {
        flush()
      }
    }
  }

  if (current) flush()
  return chunks
}

function takeRecapSlice(text: string, room: number): string {
  if (text.length <= room) return text

  const hardLimit = Math.max(1, room)
  const candidate = text.slice(0, hardLimit)

  const newline = candidate.lastIndexOf('\n')
  if (newline >= Math.floor(hardLimit * 0.5)) return text.slice(0, newline)

  const punctuationMatches = [...candidate.matchAll(/[。！？!?；;\n]/g)]
  if (punctuationMatches.length > 0) {
    const last = punctuationMatches[punctuationMatches.length - 1]
    const end = (last.index ?? 0) + last[0].length
    if (end >= Math.floor(hardLimit * 0.5)) return text.slice(0, end)
  }

  return candidate
}

function normalizeRecapText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  return normalized || '(空)'
}
