/**
 * @input:    无（接口定义 + driver 注册表）
 * @output:   ToolDriver 接口, registerDriver(), getDriver(), getDefaultDriver() — 创建与发送均可透传 Session 精确模型
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import type { ChildProcess } from 'node:child_process'
import type { RecapTurn } from './recap.js'

/** 支持的 AI 编程工具 ID */
export type ToolId = 'claude' | 'codex' | 'gemini'

/** 工具能力声明 */
export interface ToolCapabilities {
  supportsResume: boolean       // 是否支持恢复历史对话
  supportsDiscovery: boolean    // 是否支持发现未注册的本地对话
  supportsInterrupt: boolean    // 是否支持中断执行中的任务
  supportsBtw?: boolean         // 是否支持 /btw side fork（@20260513-im-btw-side-fork）；缺省 = false
  /**
   * office 文档（pdf/docx/xlsx/pptx）处理策略：
   *  'native'           = 工具自带 skill/能力（Claude + Anthropic document-skills plugin）
   *  'prompt-template'  = 靠 prompt 引导工具自行 spawn pandoc/python 等（Codex/Gemini）
   * 详见 ARCHITECTURE.md §5.1。
   */
  officeDocStrategy: 'native' | 'prompt-template'
}

export interface CreateSessionResult {
  sessionId: string
  output: string
}

export interface CreateSessionOptions {
  claudeProfile?: string
  /** 创建新底层 session 时沿用命名 Session 当前锁定的完整模型 ID（/clear）。 */
  selectedModelId?: string
  /** 关联的 IM 会话 — 用于 Claude AskUserQuestion PreToolUse hook 把问题路由回正确的 IM 通道 */
  conversationId?: string
}

export interface SendMessageOptions {
  onSpawn?: (child: ChildProcess) => void
  outputFile?: string
  /** @deprecated 优先用 onTurnEvent;onTurnText 保留向后兼容 */
  onTurnText?: (text: string) => void
  /** 细粒度 turn 事件流（@20260512-im-tool-call-progress, 仅 Claude V1 支持） */
  onTurnEvent?: (event: import('./base-driver.js').TurnEvent) => void
  /** 关联的 IM 会话 — 用于 Claude AskUserQuestion PreToolUse hook 把问题路由回正确的 IM 通道 */
  conversationId?: string
  /** 本 turn 使用的 Session 精确模型 ID；字段名保留 modelOverride 以兼容现有 driver */
  modelOverride?: string
  /**
   * 本次调用的工具黑名单（@20260513-im-btw-side-fork REVISION）。
   * 透传到 driver CLI 的 `--disallowed-tools` 参数；undefined / 空数组 = 不加该参数。
   * /btw fork turn 用此约束 AI 不能修改文件系统 / 跑 shell / 派 sub-agent / 反向提问。
   */
  disallowedTools?: string[]
}

/** session 文件位置状态 */
export type SessionFileStatus = 'here' | 'elsewhere' | 'missing'

/** AI 编程工具驱动接口 */
export interface ToolDriver {
  readonly id: ToolId
  readonly capabilities: ToolCapabilities

  /** 获取工具版本 */
  getVersion(): string

  /** 检查工具是否已安装 */
  isAvailable(): boolean

  /** 创建新 session */
  createSession(cwd: string, permissionMode: string, name?: string, opts?: CreateSessionOptions): Promise<CreateSessionResult>

  /** 向已有 session 发送消息 */
  sendMessage(sessionId: string, message: string, cwd: string, permissionMode: string, opts?: SendMessageOptions): Promise<string>

  /** 检查 session 文件位置 */
  checkSessionFile(sessionId: string, cwd: string): SessionFileStatus

  /** 杀掉本地占用某个 session 的进程 */
  killLocalSession(sessionName: string, tool?: ToolId): boolean

  /** 中断正在运行的进程 */
  interrupt(child: ChildProcess): Promise<void>

  /** 获取最近一轮上下文回顾（/fc 切换时展示）。返回最近一轮对话，无内容则返回 null */
  buildRecapTurn?(sessionId: string, cwd: string, budget: number): RecapTurn | null
}

// --- 全局 driver 注册表 ---

const drivers = new Map<ToolId, ToolDriver>()

/** 注册一个工具 driver */
export function registerDriver(driver: ToolDriver): void {
  drivers.set(driver.id, driver)
}

/** 获取指定工具的 driver，不存在则抛错 */
export function getDriver(id: ToolId): ToolDriver {
  const driver = drivers.get(id)
  if (!driver) {
    throw new Error(`工具 "${id}" 未注册。可用工具: ${[...drivers.keys()].join(', ') || '(无)'}`)
  }
  return driver
}

/** 获取默认 driver (claude) */
export function getDefaultDriver(): ToolDriver {
  return getDriver('claude')
}

/** 列出所有已注册且可用的 driver */
export function listAvailableDrivers(): ToolDriver[] {
  return [...drivers.values()].filter(d => d.isAvailable())
}

/** 检查指定工具是否已注册 */
export function hasDriver(id: ToolId): boolean {
  return drivers.has(id)
}
