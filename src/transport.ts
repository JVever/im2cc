/**
 * @input:    无（纯类型定义）
 * @output:   TransportType, IncomingMessage, TransportAdapter — 多 IM transport 抽象层
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

/** 支持的 IM transport 类型 */
export type TransportType = 'feishu' | 'wechat'

/** 统一的入站消息格式 */
export interface IncomingMessage {
  messageId: string
  conversationId: string   // 飞书群 ID / 微信用户 ID
  transport: TransportType
  senderId: string
  /** `unsupported` 表示 transport 能看到但本系统暂不处理的消息类型（如飞书富文本 post），需要由 handleMessage 回复提示 */
  kind: 'text' | 'file' | 'unsupported' | 'card_action'
  text?: string
  fileKey?: string
  fileName?: string
  msgType?: 'image' | 'file'
  /** 仅 kind='card_action' 时携带：用户在飞书 interactive 卡片上的回应 */
  cardAction?: CardAction
}

/** 用户在 IM 交互卡片上的回应（飞书原生；微信不支持） */
export interface CardAction {
  cardId: string                    // daemon 生成 uuid，关联 outgoing card
  selectedOptionId?: string         // 用户点了哪个 option（id）
  freeText?: string                 // 用户输的自由文本（"Other"路径）
}

export interface MessageSection {
  title?: string
  lines: string[]
}

export interface TextMessage {
  kind: 'text'
  text: string
  /**
   * true 表示 text 是 Markdown 源文（AI 工具回复）：飞书渲染为 post + `tag:md`，
   * 微信等纯文本端原样降级。缺省 / false 表示原样纯文本（系统提示、命令回执等）。
   * 由消息产生方（AI driver 输出 vs 系统代码）按 ownership 决定，transport 不猜测。
   */
  markdown?: boolean
}

export interface PanelMessage {
  kind: 'panel'
  title: string
  sections: MessageSection[]
}

/**
 * IM 交互卡片：用于 AI 反向提问场景。
 * - 飞书：渲染为 interactive msg_type 卡片（蓝色 header + 垂直 button 列表）
 * - 微信：transport 内部降级为编号文本（无可交互按钮）
 */
export interface InteractiveCardMessage {
  kind: 'interactive_card'
  cardId: string
  question: string
  options: Array<{ id: string; label: string }>
  allowFreeText: boolean
  timeoutHint?: string              // 显示文案，如 "8 分钟"
  /** 卡片渲染失败时降级文本是否需要标注降级提示（AC-10） */
  degradedNote?: boolean
}

/**
 * AI 工具调用进行中状态消息：daemon 主动 push 给 IM,告诉用户"AI 正在工作"。
 * 引入: @20260512-im-tool-call-progress (ARCHITECTURE §4.9, DESIGN_SYSTEM §2.1 ⚙️)
 *
 * - 飞书 + 微信均渲染为 text msg_type（V1 跨 transport 文案一致）
 * - 整 turn 内最多发 1 条;append-only 不撤销不编辑
 */
export interface ToolStatusMessage {
  kind: 'tool_status'
  toolNames: string[]   // 去重后的工具名列表（按 turn 内首次出现顺序）
  toolCount: number     // turn 内 tool_start 总数（含同名重复）
}

export type OutgoingMessage = TextMessage | PanelMessage | InteractiveCardMessage | ToolStatusMessage

/** Transport 适配器接口 */
export interface TransportAdapter {
  readonly type: TransportType
  start(onMessage: (msg: IncomingMessage) => Promise<void>): void
  sendMessage(conversationId: string, message: OutgoingMessage): Promise<void>
  sendText(conversationId: string, text: string): Promise<void>
  downloadMedia?(messageId: string, fileKey: string, msgType: string, destPath: string): Promise<void>
  /** 给消息添加表情回应（确认收到），可选 */
  addReaction?(messageId: string, emojiType?: string): Promise<void>
}

/** 各 transport 的消息长度限制 */
export const MSG_LENGTH_LIMIT: Record<TransportType, number> = {
  feishu: 28000,    // 飞书上限约 30KB，留余量
  wechat: 4096,     // 微信单条消息上限较小
}
