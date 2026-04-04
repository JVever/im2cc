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
  kind: 'text' | 'file'
  text?: string
  fileKey?: string
  fileName?: string
  msgType?: 'image' | 'file'
}

export interface MessageSection {
  title?: string
  lines: string[]
}

export interface TextMessage {
  kind: 'text'
  text: string
}

export interface PanelMessage {
  kind: 'panel'
  title: string
  sections: MessageSection[]
}

export type OutgoingMessage = TextMessage | PanelMessage

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
