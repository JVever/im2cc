/**
 * @input:    结构化出站消息或系统回复文本
 * @output:   消息结构推断与 transport 渲染（飞书 post / 纯文本降级）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import type { MessageSection, OutgoingMessage, PanelMessage } from './transport.js'

const PANEL_MAX_CHARS = 12_000
const PANEL_MAX_LINES = 120
const SECTION_BREAK_RE = /^[─-]{3,}$/

export function textMessage(text: string): OutgoingMessage {
  return { kind: 'text', text }
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

export function renderOutgoingMessageAsText(message: OutgoingMessage): string {
  if (message.kind === 'text') return message.text

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
    return {
      msgType: 'text',
      content: JSON.stringify({ text: message.text }),
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
