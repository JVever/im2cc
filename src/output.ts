/**
 * @input:    AI coding tool CLI 输出文本, TransportType
 * @output:   formatOutput(), formatError() — CLI 输出 → IM 可发送的文本
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import { MSG_LENGTH_LIMIT, type TransportType } from './transport.js'
import type { ToolId } from './tool-driver.js'

function resumeHint(sessionId: string, tool: ToolId): string {
  switch (tool) {
    case 'claude':
      return `回到电脑查看完整内容: claude --resume ${sessionId}`
    case 'codex':
      return `回到电脑查看完整内容: codex resume ${sessionId}`
    case 'gemini':
      return `回到电脑查看完整内容: gemini --resume ${sessionId}`
    default:
      return '回到电脑查看完整内容: im2cc connect <会话名>'
  }
}

export function formatOutput(
  text: string,
  sessionId: string,
  transport: TransportType = 'feishu',
  tool: ToolId = 'claude',
): string {
  if (!text || text === '(无输出)') {
    return '(无输出)'
  }

  const maxLen = MSG_LENGTH_LIMIT[transport] ?? 28000

  if (text.length <= maxLen) {
    return text
  }

  // 超长截断
  const truncated = text.slice(0, maxLen)
  const suffix = [
    '',
    '---',
    `⚠️ 输出过长 (${text.length} 字符)，已截断。`,
    resumeHint(sessionId, tool),
  ].join('\n')

  return truncated + suffix
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return `❌ ${err.message}`
  }
  return `❌ ${String(err)}`
}
