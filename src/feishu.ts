/**
 * @input:    飞书 App 凭证, im.message.receive_v1 事件
 * @output:   startFeishu(), sendTextMessage(), downloadResource() — 飞书 WebSocket 连接、消息收发、资源下载
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import * as lark from '@larksuiteoapi/node-sdk'
import type { Im2ccConfig } from './config.js'
import { log, error } from './logger.js'

interface BaseMessage {
  messageId: string
  chatId: string     // 群 ID
  senderId: string   // 用户 ID
  chatType: string   // p2p | group
}

export interface TextMessage extends BaseMessage {
  kind: 'text'
  text: string
}

export interface FileMessage extends BaseMessage {
  kind: 'file'
  fileKey: string
  fileName: string
  msgType: 'image' | 'file'
}

export type IncomingMessage = TextMessage | FileMessage

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

        // 按消息类型分发
        if (msgType === 'text') {
          let text = ''
          try {
            const content = JSON.parse((message.content as string) ?? '{}') as Record<string, string>
            text = content.text ?? ''
          } catch { return }

          // 剥离 @mention 前缀 (飞书格式: @_user_1 或 @_all)
          text = text.replace(/@_user_\d+\s*/g, '').trim()
          if (!text) return

          await onMessage({ kind: 'text', messageId, chatId, senderId, text, chatType })
        } else if (msgType === 'image') {
          try {
            const content = JSON.parse((message.content as string) ?? '{}') as Record<string, string>
            const imageKey = content.image_key
            if (!imageKey) return
            await onMessage({ kind: 'file', messageId, chatId, senderId, chatType, fileKey: imageKey, fileName: 'image.png', msgType: 'image' })
          } catch { return }
        } else if (msgType === 'file') {
          try {
            const content = JSON.parse((message.content as string) ?? '{}') as Record<string, string>
            const fileKey = content.file_key
            const fileName = content.file_name || 'unknown'
            if (!fileKey) return
            await onMessage({ kind: 'file', messageId, chatId, senderId, chatType, fileKey, fileName, msgType: 'file' })
          } catch { return }
        } else {
          // audio, video 等 — 不支持
          return
        }
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

/** 下载飞书消息中的文件/图片资源到本地 */
export async function downloadResource(
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
  destPath: string,
): Promise<void> {
  if (!client) throw new Error('飞书客户端未初始化')

  const tmpPath = destPath + '.tmp.' + process.pid
  try {
    const resp = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    })

    // SDK 返回值可能有 writeFile 方法，或者是 Buffer/Readable
    if (resp && typeof (resp as Record<string, unknown>).writeFile === 'function') {
      await (resp as unknown as { writeFile(p: string): Promise<void> }).writeFile(tmpPath)
    } else {
      // 回退：直接将响应数据写入文件
      const data = resp as unknown as Buffer
      fs.writeFileSync(tmpPath, data)
    }
    fs.chmodSync(tmpPath, 0o600)
    fs.renameSync(tmpPath, destPath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* ignore cleanup failure */ }
    throw err
  }
}
