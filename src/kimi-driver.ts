/**
 * @input:    Kimi Code CLI (`kimi` 命令), session ID, 用户消息
 * @output:   KimiDriver (ToolDriver 实现) — Moonshot Kimi Code CLI 驱动
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import { BaseToolDriver } from './base-driver.js'
import { registerDriver, type ToolCapabilities, type CreateSessionResult, type SendMessageOptions } from './tool-driver.js'

export class KimiDriver extends BaseToolDriver {
  readonly id = 'kimi' as const
  readonly capabilities: ToolCapabilities = {
    supportsResume: true,
    supportsDiscovery: false,
    supportsInterrupt: true,
  }

  getVersion(): string { return this.getToolVersion('kimi') }
  isAvailable(): boolean { return this.checkInstalled('kimi') }

  async createSession(cwd: string, _permissionMode: string, _name?: string): Promise<CreateSessionResult> {
    const sessionId = this.generateSessionId()
    // Kimi: --print 自动批准所有操作，--output-format=stream-json 流式输出
    const output = await this.runTool({
      cmd: 'kimi',
      message: '会话已建立。',
      args: ['--print', '-p', '会话已建立。请回复"就绪"。', '--output-format=stream-json'],
      cwd,
      // Kimi stream-json 格式与 Claude 类似，使用默认 extractText/extractResult
    })
    return { sessionId, output }
  }

  sendMessage(sessionId: string, message: string, cwd: string, _permissionMode: string, opts?: SendMessageOptions): Promise<string> {
    // Kimi resume: kimi --session <ID> --print -p "msg" --output-format=stream-json
    return this.runTool({
      cmd: 'kimi',
      message,
      args: ['--session', sessionId, '--print', '-p', message, '--output-format=stream-json'],
      cwd,
      onSpawn: opts?.onSpawn,
      outputFile: opts?.outputFile,
      onTurnText: opts?.onTurnText,
    })
  }
}

registerDriver(new KimiDriver())
