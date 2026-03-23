/**
 * @input:    钉钉 Stream Mode Bot API (dingtalk-stream SDK), ClientID/Secret
 * @output:   DingTalkAdapter (TransportAdapter) — 钉钉 Stream 模式消息收发
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import type { TransportAdapter, IncomingMessage } from './transport.js'
import { log, error } from './logger.js'

export interface DingTalkConfig {
  clientId: string
  clientSecret: string
}

/** sessionWebhook 缓存（用于回复消息） */
const webhookCache = new Map<string, { url: string; expireAt: number }>()

export class DingTalkAdapter implements TransportAdapter {
  readonly type = 'dingtalk' as const
  private config: DingTalkConfig

  constructor(config: DingTalkConfig) {
    this.config = config
  }

  async start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    // 动态导入钉钉 SDK（延迟加载，未安装时不影响其他 transport）
    let DWClient: any, TOPIC_ROBOT: string
    try {
      const sdk = await import('dingtalk-stream')
      DWClient = sdk.DWClient
      TOPIC_ROBOT = sdk.TOPIC_ROBOT
    } catch {
      error('[dingtalk] dingtalk-stream SDK 未安装，请运行: npm install dingtalk-stream')
      return
    }

    const client = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    })

    // 注册消息回调
    client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
      try {
        const data = JSON.parse(res.data) as DingTalkMessage
        const msgId = data.msgId || String(Date.now())
        const conversationId = `dingtalk:${data.conversationId}`
        const senderId = data.senderId || data.senderStaffId || ''

        // 缓存 sessionWebhook（用于回复）
        if (data.sessionWebhook) {
          webhookCache.set(conversationId, {
            url: data.sessionWebhook,
            expireAt: data.sessionWebhookExpiredTime || (Date.now() + 3600000),
          })
        }

        // 文本消息
        if (data.msgtype === 'text' && data.text?.content) {
          const msg: IncomingMessage = {
            messageId: msgId,
            conversationId,
            transport: 'dingtalk',
            senderId,
            kind: 'text',
            text: data.text.content.trim(),
          }
          await onMessage(msg)
        }

        // ACK 消息（防止重试）
        client.socketCallBackResponse(res.headers.messageId, JSON.stringify({ status: 'SUCCESS' }))
      } catch (err) {
        error(`[dingtalk] 处理消息出错: ${err}`)
        try { client.socketCallBackResponse(res.headers.messageId, JSON.stringify({ status: 'FAILURE' })) } catch {}
      }
    })

    // 注册全事件监听（心跳等）
    client.registerAllEventListener(() => ({ status: 'SUCCESS' }))

    // 连接
    try {
      await client.connect()
      log('[dingtalk] Stream 已连接')
    } catch (err) {
      error(`[dingtalk] 连接失败: ${err}`)
    }
  }

  async sendText(conversationId: string, text: string): Promise<void> {
    const cached = webhookCache.get(conversationId)
    if (!cached || Date.now() > cached.expireAt) {
      throw new Error('钉钉 sessionWebhook 已过期，请用户重新发送消息')
    }

    await fetch(cached.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    })
  }
}

// --- 钉钉消息类型 ---

interface DingTalkMessage {
  conversationId: string
  chatbotUserId: string
  msgId: string
  senderNick: string
  senderStaffId: string
  senderId: string
  sessionWebhook: string
  sessionWebhookExpiredTime: number
  conversationType: string  // "1" = private, "2" = group
  msgtype: string           // "text", "richText", "picture", etc.
  text?: { content: string }
  robotCode: string
}
