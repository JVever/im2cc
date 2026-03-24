/**
 * @input:    ToolId, TransportType
 * @output:   核心/Best-effort 支持矩阵常量与文案辅助
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import type { ToolId } from './tool-driver.js'
import type { TransportType } from './transport.js'

export const CORE_TRANSPORTS = ['feishu', 'wechat'] as const satisfies readonly TransportType[]

export const CORE_TOOLS = ['claude', 'codex'] as const satisfies readonly ToolId[]
export const BEST_EFFORT_TOOLS = ['gemini'] as const satisfies readonly ToolId[]
export const SUPPORTED_TOOLS = [...CORE_TOOLS, ...BEST_EFFORT_TOOLS] as const satisfies readonly ToolId[]

export function isBestEffortTool(tool: ToolId): boolean {
  return tool === 'gemini'
}

export function toolDisplayName(tool: ToolId): string {
  switch (tool) {
    case 'claude':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    case 'gemini':
      return 'Gemini'
  }
}

export function supportedToolChoices(): string {
  return SUPPORTED_TOOLS.join('|')
}

export function supportedToolList(): string {
  return SUPPORTED_TOOLS.join(', ')
}
