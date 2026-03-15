/**
 * @input:    Claude CLI stream-json 文本输出
 * @output:   formatOutput(), formatError() — CLI 输出 → 飞书可发送的文本
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

const MAX_FEISHU_MSG_LENGTH = 28000 // 留 2KB 余量，飞书上限约 30KB

export function formatOutput(text: string, sessionId: string): string {
  if (!text || text === '(无输出)') {
    return '(Claude Code 无输出)'
  }

  if (text.length <= MAX_FEISHU_MSG_LENGTH) {
    return text
  }

  // 超长截断
  const truncated = text.slice(0, MAX_FEISHU_MSG_LENGTH)
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
