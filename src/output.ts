/**
 * @input:    Claude CLI stream-json 文本输出, TransportType
 * @output:   formatOutput(), formatError() — CLI 输出 → IM 可发送的文本
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import { MSG_LENGTH_LIMIT, type TransportType } from './transport.js'

export function formatOutput(text: string, sessionId: string, transport: TransportType = 'feishu'): string {
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
    `回到电脑查看完整内容: claude --resume ${sessionId}`,
  ].join('\n')

  return truncated + suffix
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return `❌ ${err.message}`
  }
  return `❌ ${String(err)}`
}
