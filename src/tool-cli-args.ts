/**
 * @input:    ToolId, sessionId, session name
 * @output:   各工具交互式 CLI 命令参数（create/resume/resume hint）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import type { ToolId } from './tool-driver.js'

export function resumeCommand(tool: ToolId, sessionId: string): string {
  switch (tool) {
    case 'claude': return `claude --resume ${sessionId}`
    case 'codex': return `codex resume ${sessionId}`
    case 'gemini': return `gemini --resume ${sessionId}`
    default: return `${tool} --resume ${sessionId}`
  }
}

/**
 * 工具创建 session 的交互式 CLI 参数（用于 tmux，保持打开等用户输入）。
 * 注意：与 driver 的 createSession（headless 非交互模式）不同。
 */
export function toolCreateArgs(tool: ToolId, sessionId: string, name: string): string[] {
  switch (tool) {
    case 'claude': return ['claude', '--session-id', sessionId, '--dangerously-skip-permissions', '--name', `im2cc:${name}`]
    case 'codex': return ['codex']
    case 'gemini': return ['gemini']
    default: return [tool]
  }
}

/**
 * 工具恢复 session 的交互式 CLI 参数（用于 tmux）。
 */
export function toolResumeArgs(tool: ToolId, sessionId: string, name: string): string[] {
  switch (tool) {
    case 'claude': return ['claude', '--resume', sessionId, '--dangerously-skip-permissions', '--name', `im2cc:${name}`]
    case 'codex': return ['codex', 'resume', sessionId]
    case 'gemini': return ['gemini', '--resume', sessionId]
    default: return [tool, '--resume', sessionId]
  }
}
