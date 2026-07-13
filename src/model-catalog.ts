/**
 * @input:    ToolId, Im2ccConfig.modelCatalogs（可选用户覆盖）
 * @output:   ModelOption[], BUILTIN_MODEL_CATALOG, getModelCatalog(), resolveModelInput(), findShortNameByFullName() — 只含精确 fullName 的 /model 候选清单 + 短名映射；双轨：内置默认 + ~/.im2cc/config.json 用户覆盖
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import type { ToolId } from './tool-driver.js'
import { loadConfig } from './config.js'
import { log } from './logger.js'
import { normalizeExactModelId } from './model-id.js'

export interface ModelOption {
  /** 用户在 IM 中输入的短名（如 opus-4.7）；展示在列表中 */
  shortName: string
  /** 传给工具 CLI 的完整模型名（如 claude-opus-4-7） */
  fullName: string
  /** 一句话描述 */
  description: string
}

/**
 * 内置默认清单 — 作为 config.modelCatalogs 缺失时的兜底。
 * 用户想用新模型 / 自定义偏好子集时，在 ~/.im2cc/config.json 加 modelCatalogs 完全替换。
 *
 * 不内置 Gemini —— Gemini 进入维护模式（ARCHITECTURE §4.8）。
 */
export const BUILTIN_MODEL_CATALOG: Record<'claude' | 'codex', ModelOption[]> = {
  claude: [
    { shortName: 'opus-4.7',   fullName: 'claude-opus-4-7',           description: 'Opus 4.7（1M 上下文，最强推理）' },
    { shortName: 'sonnet-4.6', fullName: 'claude-sonnet-4-6',         description: 'Sonnet 4.6（平衡）' },
    { shortName: 'haiku-4.5',  fullName: 'claude-haiku-4-5-20251001', description: 'Haiku 4.5（高速）' },
  ],
  codex: [
    { shortName: 'gpt-5.5',     fullName: 'gpt-5.5',     description: 'GPT-5.5（推理强，新一代默认）' },
    { shortName: 'gpt-5',       fullName: 'gpt-5',       description: 'GPT-5（稳定）' },
    { shortName: 'gpt-5-mini',  fullName: 'gpt-5-mini',  description: 'GPT-5 Mini（经济快速）' },
    { shortName: 'gpt-5-codex', fullName: 'gpt-5-codex', description: 'GPT-5 Codex（代码优化）' },
  ],
}

/** 单条目校验并归一：三字段 trim 后非空，fullName 必须是精确 ID。 */
function normalizeModelOption(tool: ToolId, x: unknown): ModelOption | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  const shortName = typeof o.shortName === 'string' ? o.shortName.trim() : ''
  const fullName = normalizeExactModelId(tool, o.fullName)
  const description = typeof o.description === 'string' ? o.description.trim() : ''
  if (!shortName || !fullName || !description) return null
  return { shortName, fullName, description }
}

/**
 * 取指定工具的模型清单。优先级：
 *   1. ~/.im2cc/config.json 的 modelCatalogs.<tool>（非空数组 + 校验通过的条目）
 *   2. BUILTIN_MODEL_CATALOG.<tool>
 *   3. 其他工具（gemini）→ 空数组
 *
 * 注意：完全替换，不 merge（避免顺序歧义）。
 * 性能：每次调用都读 config 文件（loadConfig 是同步 + 小文件）；/model 是低频操作可接受。
 */
export function getModelCatalog(tool: ToolId): ModelOption[] {
  if (tool !== 'claude' && tool !== 'codex') return []

  try {
    const config = loadConfig()
    const userCatalog = config.modelCatalogs?.[tool]
    if (Array.isArray(userCatalog) && userCatalog.length > 0) {
      const filtered = userCatalog
        .map(item => normalizeModelOption(tool, item))
        .filter((item): item is ModelOption => item !== null)
      if (filtered.length === 0) {
        log(`[model-catalog] config.modelCatalogs.${tool} 全部条目无效，fallback 到内置默认`)
      } else {
        if (filtered.length !== userCatalog.length) {
          log(`[model-catalog] config.modelCatalogs.${tool} 有 ${userCatalog.length - filtered.length} 条无效，已跳过`)
        }
        return filtered
      }
    }
  } catch (err) {
    log(`[model-catalog] 读 config 失败，fallback 到内置默认: ${err instanceof Error ? err.message : String(err)}`)
  }

  return BUILTIN_MODEL_CATALOG[tool]
}

/**
 * 把用户输入解析为清单中登记的模型：
 *   1. 短名命中（如 'opus-4.7'）→ 返回对应 fullName
 *   2. 完整名命中（如 'claude-opus-4-7'）→ 返回同一清单项
 *   3. 未登记输入 → null（避免先回成功、下一 turn 才失败）
 *
 * 未来 / 自定义模型先写入 config.modelCatalogs，再从这条确定性路径选择。
 */
export function resolveModelInput(tool: ToolId, raw: string): ModelOption | null {
  const catalog = getModelCatalog(tool)
  const trimmed = raw.trim()

  // 短名匹配
  for (const opt of catalog) {
    if (opt.shortName === trimmed) {
      return opt
    }
  }

  // 完整名匹配
  for (const opt of catalog) {
    if (opt.fullName === trimmed) {
      return opt
    }
  }

  return null
}

/**
 * 根据 Session 当前完整模型 ID 找到短名（用于回执显示）。
 * 不在清单中时返回完整 ID 原文；undefined 返回 undefined。
 */
export function findShortNameByFullName(tool: ToolId, fullName: string | undefined): string | undefined {
  if (!fullName) return undefined
  const catalog = getModelCatalog(tool)
  for (const opt of catalog) {
    if (opt.fullName === fullName) return opt.shortName
  }
  return fullName // 不在清单则原样回显
}
