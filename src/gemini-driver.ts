/**
 * @input:    Gemini CLI (`gemini` 命令), session ID, 用户消息
 * @output:   GeminiDriver (ToolDriver 实现) — Google Gemini CLI 驱动
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import { BaseToolDriver } from './base-driver.js'
import { registerDriver, type ToolCapabilities, type CreateSessionResult, type SendMessageOptions } from './tool-driver.js'

export class GeminiDriver extends BaseToolDriver {
  readonly id = 'gemini' as const
  readonly capabilities: ToolCapabilities = {
    supportsResume: true,
    supportsDiscovery: false,
    supportsInterrupt: true,
  }

  getVersion(): string { return this.getToolVersion('gemini') }
  isAvailable(): boolean { return this.checkInstalled('gemini') }

  async createSession(cwd: string, _permissionMode: string, _name?: string): Promise<CreateSessionResult> {
    const sessionId = this.generateSessionId()
    // Gemini: -p 非交互模式，--output-format json，-y 自动批准
    const output = await this.runTool({
      cmd: 'gemini',
      message: '会话已建立。',
      args: ['-p', '会话已建立。请回复"就绪"。', '--output-format', 'json', '-y'],
      cwd,
      extractText: geminiExtractText,
      extractResult: geminiExtractResult,
    })
    return { sessionId, output }
  }

  sendMessage(sessionId: string, message: string, cwd: string, _permissionMode: string, opts?: SendMessageOptions): Promise<string> {
    // Gemini resume: gemini --resume <UUID> -p "msg" --output-format json -y
    return this.runTool({
      cmd: 'gemini',
      message,
      args: ['--resume', sessionId, '-p', message, '--output-format', 'json', '-y'],
      cwd,
      onSpawn: opts?.onSpawn,
      outputFile: opts?.outputFile,
      onTurnText: opts?.onTurnText,
      extractText: geminiExtractText,
      extractResult: geminiExtractResult,
    })
  }
}

registerDriver(new GeminiDriver())

// --- Gemini 专有 ---

/** Gemini JSON 输出提取：{response: "...", ...} 或 NDJSON 事件 */
function geminiExtractText(event: Record<string, unknown>): string {
  // Gemini JSON 格式可能是 {type: "assistant", ...} 或 {response: "..."}
  if (typeof event.response === 'string') return event.response
  if (event.type === 'assistant') {
    const msg = event.message as Record<string, unknown> | undefined
    if (msg && Array.isArray(msg.content)) {
      return (msg.content as Array<Record<string, unknown>>)
        .filter(b => b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text as string).join('')
    }
  }
  return ''
}

function geminiExtractResult(event: Record<string, unknown>): string {
  if (event.type === 'result' && typeof event.result === 'string') return event.result
  if (typeof event.response === 'string') return event.response
  return ''
}
