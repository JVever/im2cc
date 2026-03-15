/**
 * @input:    飞书 App 凭证, im.message.receive_v1 事件
 * @output:   startFeishu(), sendTextMessage() — 飞书 WebSocket 连接和消息收发
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import * as lark from '@larksuiteoapi/node-sdk'
import type { Im2ccConfig } from './config.js'
import { log, error } from './logger.js'

export interface IncomingMessage {
  messageId: string
  chatId: string     // 群 ID
  senderId: string   // 用户 ID
  text: string       // 纯文本内容
  chatType: string   // p2p | group
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>

let client: lark.Client | null = null

export async function startFeishu(
  config: Im2ccConfig,
  onMessage: MessageHandler,
): Promise<void> {
  const { appId, appSecret } = config.feishu

  if (!appId || !appSecret) {
    throw new Error('飞书 App ID 或 App Secret 未配置。请运行 im2cc setup')
  }

  client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild })

  // 获取 Bot 信息
  try {
    const resp = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info/' })
    const botData = resp?.data as Record<string, unknown> | undefined
    const botInfo = botData?.bot as Record<string, string> | undefined
    log(`飞书 Bot 已连接: ${botInfo?.app_name ?? 'unknown'} (${botInfo?.open_id ?? ''})`)
  } catch (err) {
    error(`获取 Bot 信息失败: ${err}`)
  }

  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        const event = data as Record<string, unknown>
        const sender = event.sender as Record<string, unknown> | undefined
        const message = event.message as Record<string, unknown> | undefined

        if (!sender || !message) return

        // 过滤 Bot 自己的消息
        const senderType = (sender.sender_type as string) ?? ''
        if (senderType === 'bot') return

        const senderId = (sender.sender_id as Record<string, string>)?.open_id ?? ''
        const chatId = (message.chat_id as string) ?? ''
        const messageId = (message.message_id as string) ?? ''
        const msgType = (message.message_type as string) ?? ''
        const chatType = (message.chat_type as string) ?? ''

        // 只处理文本消息
        if (msgType !== 'text') return

        // 解析消息内容
        let text = ''
        try {
          const content = JSON.parse((message.content as string) ?? '{}') as Record<string, string>
          text = content.text ?? ''
        } catch {
          return
        }

        if (!text.trim()) return

        await onMessage({ messageId, chatId, senderId, text: text.trim(), chatType })
      } catch (err) {
        error(`处理飞书消息出错: ${err}`)
      }
    },
  })

  const wsClient = new lark.WSClient({
    appId,
    appSecret,
  })

  log('正在连接飞书 WebSocket...')
  await wsClient.start({ eventDispatcher: dispatcher })
  log('飞书 WebSocket 已连接')
}

export async function sendTextMessage(chatId: string, text: string): Promise<void> {
  if (!client) throw new Error('飞书客户端未初始化')

  try {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
  } catch (err) {
    error(`发送飞书消息失败 [${chatId}]: ${err}`)
    throw err
  }
}
