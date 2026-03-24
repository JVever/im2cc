/**
 * @input:    无（接口定义 + driver 注册表）
 * @output:   ToolDriver 接口, registerDriver(), getDriver(), getDefaultDriver() — 多工具抽象层
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import type { ChildProcess } from 'node:child_process'

/** 支持的 AI 编程工具 ID */
export type ToolId = 'claude' | 'codex' | 'gemini' | 'kimi'

/** 工具能力声明 */
export interface ToolCapabilities {
  supportsResume: boolean       // 是否支持恢复历史对话
  supportsDiscovery: boolean    // 是否支持发现未注册的本地对话
  supportsInterrupt: boolean    // 是否支持中断执行中的任务
}

export interface CreateSessionResult {
  sessionId: string
  output: string
}

export interface SendMessageOptions {
  onSpawn?: (child: ChildProcess) => void
  outputFile?: string
  onTurnText?: (text: string) => void
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
  createSession(cwd: string, permissionMode: string, name?: string): Promise<CreateSessionResult>

  /** 向已有 session 发送消息 */
  sendMessage(sessionId: string, message: string, cwd: string, permissionMode: string, opts?: SendMessageOptions): Promise<string>

  /** 检查 session 文件位置 */
  checkSessionFile(sessionId: string, cwd: string): SessionFileStatus

  /** 杀掉本地占用某个 session 的进程 */
  killLocalSession(sessionName: string, tool?: ToolId): boolean

  /** 中断正在运行的进程 */
  interrupt(child: ChildProcess): Promise<void>

  /** 构建上下文回顾（/fc 切换时展示最近对话）。返回格式化文本，无内容则返回 null */
  buildRecap?(sessionId: string, cwd: string, budget: number): string | null
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
