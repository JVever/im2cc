/**
 * @input:    Codex CLI (`codex` 命令), session ID, 用户消息
 * @output:   CodexDriver (ToolDriver 实现) — OpenAI Codex CLI 驱动
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import { BaseToolDriver } from './base-driver.js'
import { registerDriver, type ToolCapabilities, type CreateSessionResult, type SendMessageOptions } from './tool-driver.js'

export class CodexDriver extends BaseToolDriver {
  readonly id = 'codex' as const
  readonly capabilities: ToolCapabilities = {
    supportsResume: true,
    supportsDiscovery: false,
    supportsInterrupt: true,
  }

  getVersion(): string { return this.getToolVersion('codex') }
  isAvailable(): boolean { return this.checkInstalled('codex') }

  async createSession(cwd: string, permissionMode: string, _name?: string): Promise<CreateSessionResult> {
    const sessionId = this.generateSessionId()
    const output = await this.runTool({
      cmd: 'codex',
      message: '会话已建立。',
      args: ['exec', '--json', ...codexPermArgs(permissionMode), '会话已建立。请回复"就绪"。'],
      cwd,
      extractText: codexExtractText,
      extractResult: codexExtractResult,
    })
    return { sessionId, output }
  }

  sendMessage(sessionId: string, message: string, cwd: string, permissionMode: string, opts?: SendMessageOptions): Promise<string> {
    // Codex resume: codex exec resume <ID> "msg"
    const args = ['exec', 'resume', sessionId, '--json', ...codexPermArgs(permissionMode), message]

    return this.runTool({
      cmd: 'codex',
      message,
      args,
      cwd,
      onSpawn: opts?.onSpawn,
      outputFile: opts?.outputFile,
      onTurnText: opts?.onTurnText,
      extractText: codexExtractText,
      extractResult: codexExtractResult,
    })
  }
}

registerDriver(new CodexDriver())

// --- Codex 专有 ---

function codexPermArgs(mode: string): string[] {
  if (mode === 'YOLO') return ['--full-auto']
  return []
}

/** Codex NDJSON 事件文本提取 */
function codexExtractText(event: Record<string, unknown>): string {
  // Codex 的 NDJSON 格式：{type: "message", content: "..."}
  if (event.type === 'message' && typeof event.content === 'string') return event.content
  // 或者 content 是数组
  if (event.type === 'message' && Array.isArray(event.content)) {
    return (event.content as Array<Record<string, unknown>>)
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join('')
  }
  return ''
}

function codexExtractResult(event: Record<string, unknown>): string {
  if (event.type === 'result' && typeof event.result === 'string') return event.result
  return ''
}
