/**
 * @input:    ToolId
 * @output:   模式注册表 — 每个工具的可用模式、描述、CLI 参数映射、默认模式
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import type { ToolId } from './tool-driver.js'

export interface ModeInfo {
  /** 工具原生模式名（用户输入和存储用） */
  id: string
  /** 2 字母快捷别名（手机端快速输入） */
  alias: string
  /** 中文名称 */
  label: string
  /** 一句话说明 */
  description: string
  /** 补充说明（等同什么 CLI 参数 + 适用场景） */
  detail: string
  /** 传给 CLI 的参数数组 */
  cliArgs: string[]
}

// ── Claude Code ────────────────────────────────────────────────

const claudeModes: ModeInfo[] = [
  {
    id: 'auto',
    alias: 'au',
    label: '智能自动',
    description: '安全操作自动执行，危险操作由分类器拦截',
    detail: '等同 --permission-mode auto，无需确认且有安全护栏',
    cliArgs: ['--permission-mode', 'auto'],
  },
  {
    id: 'bypassPermissions',
    alias: 'bp',
    label: '全自动',
    description: '跳过所有权限检查，自动执行所有操作',
    detail: '等同 --dangerously-skip-permissions，无任何安全检查',
    cliArgs: ['--dangerously-skip-permissions'],
  },
  {
    id: 'acceptEdits',
    alias: 'ae',
    label: '自动编辑',
    description: '自动批准文件编辑，其他操作（命令执行等）被拒绝',
    detail: '等同 --permission-mode acceptEdits，适合只需代码修改的场景',
    cliArgs: ['--permission-mode', 'acceptEdits'],
  },
  {
    id: 'default',
    alias: 'df',
    label: '确认模式',
    description: '所有需要确认的操作直接拒绝（IM 下无法交互确认）',
    detail: '等同 --permission-mode default，仅用于纯分析/问答',
    cliArgs: ['--permission-mode', 'default'],
  },
]

// ── Codex ──────────────────────────────────────────────────────

const codexModes: ModeInfo[] = [
  {
    id: 'bypass',
    alias: 'bp',
    label: '无限制',
    description: '跳过所有审批和沙箱，完全不受限',
    detail: '等同 --dangerously-bypass-approvals-and-sandbox',
    cliArgs: ['--dangerously-bypass-approvals-and-sandbox'],
  },
  {
    id: 'full-auto',
    alias: 'fa',
    label: '全自动',
    description: '自动执行命令，工作区可写入（沙箱保护）',
    detail: '等同 --full-auto，沙箱内自动执行',
    cliArgs: ['--full-auto'],
  },
  {
    id: 'read-only',
    alias: 'ro',
    label: '只读',
    description: '只能读取文件，不能修改或执行写入命令',
    detail: '等同 -s read-only，适合纯分析/代码审查',
    cliArgs: ['-s', 'read-only'],
  },
]

// ── Gemini ─────────────────────────────────────────────────────

const geminiModes: ModeInfo[] = [
  {
    id: 'yolo',
    alias: 'yo',
    label: '全自动',
    description: '自动批准所有操作',
    detail: '等同 --approval-mode yolo',
    cliArgs: ['--approval-mode', 'yolo'],
  },
  {
    id: 'auto_edit',
    alias: 'ae',
    label: '自动编辑',
    description: '自动批准编辑操作，其他需确认（IM 下被拒绝）',
    detail: '等同 --approval-mode auto_edit',
    cliArgs: ['--approval-mode', 'auto_edit'],
  },
  {
    id: 'default',
    alias: 'df',
    label: '确认模式',
    description: '所有操作需确认（IM 下被拒绝）',
    detail: '等同 --approval-mode default',
    cliArgs: ['--approval-mode', 'default'],
  },
]

// ── Registry ───────────────────────────────────────────────────

const registry: Record<string, ModeInfo[]> = {
  claude: claudeModes,
  codex: codexModes,
  gemini: geminiModes,
}

/** 内置默认模式（IM 远程控制场景，需要全自动） */
const builtinDefaults: Record<string, string> = {
  claude: 'auto',
  codex: 'bypass',
  gemini: 'yolo',
}

// ── Public API ─────────────────────────────────────────────────

/** 获取工具的所有可用模式 */
export function getToolModes(tool: ToolId): ModeInfo[] {
  return registry[tool] ?? []
}

/** 获取工具的指定模式信息 */
export function getMode(tool: ToolId, modeId: string): ModeInfo | undefined {
  return getToolModes(tool).find(m => m.id === modeId)
}

/** 检查模式是否对该工具有效 */
export function isValidMode(tool: ToolId, modeId: string): boolean {
  return getToolModes(tool).some(m => m.id === modeId)
}

/** 获取模式对应的 CLI 参数 */
export function getModeCliArgs(tool: ToolId, modeId: string): string[] {
  return getMode(tool, modeId)?.cliArgs ?? []
}

/** 将别名或完整名解析为 canonical mode id */
export function resolveMode(tool: ToolId, input: string): string | undefined {
  const modes = getToolModes(tool)
  const byId = modes.find(m => m.id === input)
  if (byId) return byId.id
  const lower = input.toLowerCase()
  const byAlias = modes.find(m => m.alias === lower)
  return byAlias?.id
}

/** 获取工具的内置默认模式 */
export function getBuiltinDefault(tool: ToolId): string {
  return builtinDefaults[tool] ?? 'default'
}

/** 旧模式名 → 工具原生模式名映射 */
export function migrateLegacyMode(legacyMode: string, tool: ToolId): string {
  // 已经是有效的原生模式名，直接返回
  if (isValidMode(tool, legacyMode)) return legacyMode

  switch (legacyMode) {
    case 'YOLO':
    case 'dangerouslySkipPermissions': {
      // YOLO 语义是"跳过所有检查"，映射到各工具的最高权限模式（非默认模式）
      const maxPerms: Record<string, string> = { claude: 'bypassPermissions', codex: 'bypass', gemini: 'yolo' }
      return maxPerms[tool] ?? getBuiltinDefault(tool)
    }
    case 'auto-edit':
      switch (tool) {
        case 'claude': return 'acceptEdits'
        case 'gemini': return 'auto_edit'
        default: return getBuiltinDefault(tool)  // Codex 无对应，降级到默认
      }
    case 'default':
      switch (tool) {
        case 'claude': return 'default'
        case 'gemini': return 'default'
        default: return getBuiltinDefault(tool)
      }
    default:
      return getBuiltinDefault(tool)
  }
}
