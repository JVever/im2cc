/**
 * @input:    ToolId, 工具/配置/旧数据提供的候选模型 ID
 * @output:   normalizeExactModelId() — trim 后的精确模型 ID，或 null（已知家族 alias / default / synthetic / 空值）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import type { ToolId } from './tool-driver.js'

const CLAUDE_FAMILY_ALIAS = /^(opus|sonnet|haiku)(?:$|[-._])/i

/**
 * 不强绑 provider 前缀：Fable 等自定义 provider 的原生完整 ID 可以通过。
 * 只拒绝已知并非精确版本的占位/家族 alias；Codex 的 gpt-5.5 等短名本身就是官方完整 ID。
 */
export function normalizeExactModelId(tool: ToolId, value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized === '<synthetic>' || normalized.toLowerCase() === 'default') return null
  if (tool === 'claude' && CLAUDE_FAMILY_ALIAS.test(normalized)) return null
  return normalized
}
