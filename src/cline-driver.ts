/**
 * @input:    Cline CLI (`cline` 命令), session ID, 用户消息
 * @output:   ClineDriver (ToolDriver 实现) — Cline CLI 2.0 驱动
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import { BaseToolDriver } from './base-driver.js'
import { registerDriver, type ToolCapabilities, type CreateSessionResult, type SendMessageOptions } from './tool-driver.js'

export class ClineDriver extends BaseToolDriver {
  readonly id = 'cline' as const
  readonly capabilities: ToolCapabilities = {
    supportsResume: true,
    supportsDiscovery: false,
    supportsInterrupt: true,
  }

  getVersion(): string { return this.getToolVersion('cline') }
  isAvailable(): boolean { return this.checkInstalled('cline') }

  async createSession(cwd: string, _permissionMode: string, _name?: string): Promise<CreateSessionResult> {
    const sessionId = this.generateSessionId()
    // Cline: -y YOLO 模式，--json NDJSON 输出
    const output = await this.runTool({
      cmd: 'cline',
      message: '会话已建立。',
      args: ['-y', '--json', '会话已建立。请回复"就绪"。'],
      cwd,
      extractText: clineExtractText,
      extractResult: clineExtractResult,
    })
    return { sessionId, output }
  }

  sendMessage(sessionId: string, message: string, cwd: string, _permissionMode: string, opts?: SendMessageOptions): Promise<string> {
    // Cline resume: cline -y --resume <ID> --json "msg"
    return this.runTool({
      cmd: 'cline',
      message,
      args: ['-y', '--resume', sessionId, '--json', message],
      cwd,
      onSpawn: opts?.onSpawn,
      outputFile: opts?.outputFile,
      onTurnText: opts?.onTurnText,
      extractText: clineExtractText,
      extractResult: clineExtractResult,
    })
  }
}

registerDriver(new ClineDriver())

// --- Cline 专有 ---

/** Cline NDJSON 事件文本提取 */
function clineExtractText(event: Record<string, unknown>): string {
  // Cline NDJSON: {type: "assistant", content: "..."} 或 {type: "text", text: "..."}
  if (event.type === 'assistant' && typeof event.content === 'string') return event.content
  if (event.type === 'text' && typeof event.text === 'string') return event.text
  // 通用 content 数组格式
  if (event.type === 'assistant' && Array.isArray(event.content)) {
    return (event.content as Array<Record<string, unknown>>)
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string).join('')
  }
  return ''
}

function clineExtractResult(event: Record<string, unknown>): string {
  if (event.type === 'result' && typeof event.result === 'string') return event.result
  return ''
}
