/**
 * @input:    结构化出站消息或系统回复文本
 * @output:   消息结构推断与 transport 渲染（系统回复识别、AI Markdown 回复飞书 post+md 渲染、微信纯文本降级）；markdownTextMessage() 给 AI 回复打 markdown 标记
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import type { InteractiveCardMessage, MessageSection, OutgoingMessage, PanelMessage, TextMessage, ToolStatusMessage } from './transport.js'

const PANEL_MAX_CHARS = 12_000
const PANEL_MAX_LINES = 120
const SECTION_BREAK_RE = /^[─-]{3,}$/

export function textMessage(text: string): OutgoingMessage {
  return { kind: 'text', text }
}

/**
 * AI 工具回复的 Markdown 文本消息：飞书渲染为 post + `tag:md`，微信纯文本降级。
 * 与 textMessage 的区别仅在 markdown 标记 —— 用于在 AI 回复出口处打标，
 * 系统提示 / 命令回执继续用 textMessage（原样纯文本）。
 */
export function markdownTextMessage(text: string): TextMessage {
  return { kind: 'text', text, markdown: true }
}

export function panelMessage(title: string, sections: MessageSection[]): PanelMessage {
  return {
    kind: 'panel',
    title: title.trim(),
    sections: sections
      .map(section => ({
        title: section.title?.trim() || undefined,
        lines: section.lines.map(line => line.trimEnd()).filter(Boolean),
      }))
      .filter(section => section.lines.length > 0),
  }
}

function splitSections(lines: string[]): string[][] {
  const sections: string[][] = []
  let current: string[] = []

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (!line.trim() || SECTION_BREAK_RE.test(line.trim())) {
      if (current.length > 0) {
        sections.push(current)
        current = []
      }
      continue
    }
    current.push(line)
  }

  if (current.length > 0) sections.push(current)
  return sections
}

export function structureSystemReply(text: string): OutgoingMessage {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return textMessage('')
  if (normalized.length > PANEL_MAX_CHARS) return textMessage(normalized)

  const lines = normalized.split('\n')
  if (lines.length < 2 || lines.length > PANEL_MAX_LINES) return textMessage(normalized)

  const title = lines[0].trim()
  if (!title) return textMessage(normalized)

  const sections = splitSections(lines.slice(1)).map(section => {
    const [first, ...rest] = section
    if (rest.length > 0 && first.trim().endsWith('：')) {
      return { title: first.trim().slice(0, -1), lines: rest }
    }
    return { lines: section }
  })

  if (sections.length === 0) return textMessage(normalized)
  return panelMessage(title, sections)
}

/**
 * 渲染 AI 反向提问为文本（飞书 + 微信共用 — 跨 transport 信息架构一致）。
 *
 * 五要素：
 *   1) 标识：首行 🤔 Claude 想问你（可选 ❌ 卡片渲染失败标识）
 *   2) 问题：question 主体
 *   3) 选项：1) 2) 3) 编号列表
 *   4) Other 入口：✏️ 直接回复编号或你的自定义答案（仅 allowFreeText=true）
 *   5) 超时提示：⏱ N 分钟内未回复将自动继续
 *
 * 设计依据见 DESIGN_SYSTEM.md §2 跨 transport 一致性规范、ARCHITECTURE.md §5.3。
 */
export function buildAskUserText(message: InteractiveCardMessage): string {
  const headerSuffix = message.degradedNote ? '（卡片渲染失败，已降级）' : ''
  const lines: string[] = [`🤔 Claude 想问你${headerSuffix}`, '', message.question]

  if (message.options.length > 0) {
    lines.push('')
    message.options.forEach((o, i) => lines.push(`  ${i + 1}) ${o.label}`))
  }

  const tail: string[] = []
  if (message.allowFreeText) tail.push('✏️ 直接回复编号或你的自定义答案')
  if (message.timeoutHint) tail.push(`⏱ ${message.timeoutHint}内未回复将自动继续`)
  if (tail.length > 0) {
    lines.push('')
    lines.push(...tail)
  }

  return lines.join('\n').trim()
}

/**
 * AI 工具调用状态消息文案（飞书 + 微信完全一致，跨 transport 信息架构原则）。
 *
 * 4 档模板（按优先级）:
 *   1. names=1 且 count=1: ⚙️ 正在执行 <name>
 *   2. names=1 且 count>1: ⚙️ 正在执行 <name> (共 N 次)
 *   3. names∈[2,3]:        ⚙️ 正在执行 <n1>, <n2>, ...
 *   4. names>3:            ⚙️ 正在执行 <n1>, <n2>, <n3> 等 N 项 (N=count)
 *
 * 引入: @20260512-im-tool-call-progress (DESIGN_SYSTEM §2.1 ⚙️)
 */
export function buildToolStatusText(message: ToolStatusMessage): string {
  const names = message.toolNames
  const count = message.toolCount

  if (names.length === 1 && count === 1) {
    return `⚙️ 正在执行 ${names[0]}`
  }
  if (names.length === 1 && count > 1) {
    return `⚙️ 正在执行 ${names[0]} (共 ${count} 次)`
  }
  if (names.length >= 2 && names.length <= 3) {
    return `⚙️ 正在执行 ${names.join(', ')}`
  }
  // names.length > 3
  const head = names.slice(0, 3).join(', ')
  return `⚙️ 正在执行 ${head} 等 ${count} 项`
}

export function renderOutgoingMessageAsText(message: OutgoingMessage): string {
  if (message.kind === 'text') return message.text
  if (message.kind === 'interactive_card') return buildAskUserText(message)
  if (message.kind === 'tool_status') return buildToolStatusText(message)

  const lines = [message.title]
  for (const section of message.sections) {
    if (section.title || section.lines.length > 0) lines.push('')
    if (section.title) lines.push(`${section.title}：`)
    lines.push(...section.lines)
  }
  return lines.join('\n').trim()
}

// 注：原实现字符类 `[*_~`\\[\\]()>#+|]` 中 `\\]` 被解析为「转义反斜杠 + `]` 关闭类」，
// 导致 `( ) > # + |` 实际落在类外，不会被转义。用正确的 `\[` `\]` 转义 + 单次 replace。
function escapeFeishuMd(text: string): string {
  return text.replace(/[\\*_~`\[\]()>#+|]/g, '\\$&')
}

function escapeInlineCode(text: string): string {
  return text.replace(/`/g, '\\`')
}

function formatLineForFeishuMd(line: string): string {
  const trimmed = line.trim()
  if (!trimmed) return ''

  const commandMatch = trimmed.match(/^(.+?)\s+—\s+(.+)$/)
  if (commandMatch) {
    return `- \`${escapeInlineCode(commandMatch[1].trim())}\` — ${escapeFeishuMd(commandMatch[2].trim())}`
  }

  const keyValueMatch = trimmed.match(/^([^：]{1,24})：\s*(.+)$/)
  if (keyValueMatch) {
    return `- **${escapeFeishuMd(keyValueMatch[1].trim())}：** ${escapeFeishuMd(keyValueMatch[2].trim())}`
  }

  return `- ${escapeFeishuMd(trimmed)}`
}

export function buildFeishuMessage(message: OutgoingMessage): { msgType: 'text' | 'post', content: string } {
  if (message.kind === 'text') {
    // AI Markdown 回复：post + 单个 md 元素，原文直送（不 escape、不转列表），飞书才会渲染
    // 标题/列表/粗体/inline code/fenced code。空文本不构造 post，退回 text 避免空卡片。
    if (message.markdown && message.text.trim()) {
      // AI 回复无标题：飞书 post 的 title 可选，省略避免空标题行（panel 才带 title）
      return {
        msgType: 'post',
        content: JSON.stringify({
          zh_cn: {
            content: [[{ tag: 'md', text: message.text }]],
          },
        }),
      }
    }
    return {
      msgType: 'text',
      content: JSON.stringify({ text: message.text }),
    }
  }

  // interactive_card 不在此函数处理范围 — Phase 2 中由 feishu.ts 直接走 msg_type=interactive 路径。
  // 调用方应在 sendMessage 入口分流；走到这里说明发生了未预期的降级，给出可见 fallback 文本。
  if (message.kind === 'interactive_card') {
    return {
      msgType: 'text',
      content: JSON.stringify({ text: renderOutgoingMessageAsText(message) }),
    }
  }

  // tool_status 跨 transport 完全一致,直接走 text msg_type（@20260512-im-tool-call-progress）
  if (message.kind === 'tool_status') {
    return {
      msgType: 'text',
      content: JSON.stringify({ text: buildToolStatusText(message) }),
    }
  }

  const content = message.sections.map(section => {
    const lines: string[] = []
    if (section.title) lines.push(`**${escapeFeishuMd(section.title)}**`)
    lines.push(...section.lines.map(formatLineForFeishuMd).filter(Boolean))
    return [{ tag: 'md', text: lines.join('\n') }]
  })

  return {
    msgType: 'post',
    content: JSON.stringify({
      zh_cn: {
        title: message.title,
        content,
      },
    }),
  }
}
