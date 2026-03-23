/**
 * @input:    Telegram Bot API (api.telegram.org), Bot Token
 * @output:   TelegramAdapter (TransportAdapter) — Telegram 长轮询、消息收发、文件下载
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import type { TransportAdapter, IncomingMessage } from './transport.js'
import { log, error } from './logger.js'

const BASE = 'https://api.telegram.org'

export interface TelegramConfig {
  botToken: string
}

export class TelegramAdapter implements TransportAdapter {
  readonly type = 'telegram' as const
  private token: string
  private offset = 0

  constructor(config: TelegramConfig) {
    this.token = config.botToken
  }

  private url(method: string): string {
    return `${BASE}/bot${this.token}/${method}`
  }

  async start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    // 验证 token
    try {
      const resp = await fetch(this.url('getMe'))
      const data = await resp.json() as Record<string, unknown>
      if (!data.ok) throw new Error(JSON.stringify(data))
      const bot = data.result as Record<string, unknown>
      log(`[telegram] Bot 已连接: @${bot.username} (${bot.first_name})`)
    } catch (err) {
      error(`[telegram] 连接失败: ${err}`)
      return
    }

    // 长轮询循环
    const pollBody = async (): Promise<void> => {
      try {
        const resp = await fetch(this.url('getUpdates'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: this.offset,
            timeout: 30,
            allowed_updates: ['message'],
          }),
          signal: AbortSignal.timeout(35000),
        })

        const data = await resp.json() as { ok: boolean; result: TgUpdate[] }
        if (!data.ok || !data.result) return

        for (const update of data.result) {
          this.offset = update.update_id + 1
          if (!update.message) continue

          const tgMsg = update.message
          const chatId = String(tgMsg.chat.id)
          const senderId = String(tgMsg.from?.id ?? '')
          const messageId = String(tgMsg.message_id)

          // 文本消息
          if (tgMsg.text) {
            const msg: IncomingMessage = {
              messageId,
              conversationId: `telegram:${chatId}`,
              transport: 'telegram',
              senderId,
              kind: 'text',
              text: tgMsg.text,
            }
            try { await onMessage(msg) } catch (err) {
              error(`[telegram] 处理消息出错: ${err}`)
            }
            continue
          }

          // 图片消息
          if (tgMsg.photo && tgMsg.photo.length > 0) {
            const largest = tgMsg.photo[tgMsg.photo.length - 1]
            const msg: IncomingMessage = {
              messageId,
              conversationId: `telegram:${chatId}`,
              transport: 'telegram',
              senderId,
              kind: 'file',
              fileKey: largest.file_id,
              fileName: 'photo.jpg',
              msgType: 'image',
              text: tgMsg.caption,
            }
            try { await onMessage(msg) } catch (err) {
              error(`[telegram] 处理图片出错: ${err}`)
            }
            continue
          }

          // 文件消息
          if (tgMsg.document) {
            const msg: IncomingMessage = {
              messageId,
              conversationId: `telegram:${chatId}`,
              transport: 'telegram',
              senderId,
              kind: 'file',
              fileKey: tgMsg.document.file_id,
              fileName: tgMsg.document.file_name || 'file',
              msgType: 'file',
              text: tgMsg.caption,
            }
            try { await onMessage(msg) } catch (err) {
              error(`[telegram] 处理文件出错: ${err}`)
            }
          }
        }
      } catch (err) {
        if (!String(err).includes('abort')) {
          error(`[telegram] 轮询失败: ${err}`)
        }
      }
    }

    const pollLoop = (): void => {
      pollBody()
        .catch(err => error(`[telegram] pollLoop 错误: ${err}`))
        .finally(() => setTimeout(pollLoop, 100))
    }

    log('[telegram] 启动长轮询')
    setTimeout(pollLoop, 100)
  }

  async sendText(conversationId: string, text: string): Promise<void> {
    const chatId = conversationId.replace('telegram:', '')

    // Telegram 消息上限 4096 字符，超长分段发送
    const chunks = splitText(text, 4096)
    for (const chunk of chunks) {
      const resp = await fetch(this.url('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      })
      if (!resp.ok) {
        const body = await resp.text()
        throw new Error(`Telegram sendMessage 失败: ${resp.status} ${body.slice(0, 200)}`)
      }
    }
  }

  async downloadMedia(messageId: string, fileKey: string, _msgType: string, destPath: string): Promise<void> {
    // Step 1: getFile
    const fileResp = await fetch(this.url('getFile'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileKey }),
    })
    const fileData = await fileResp.json() as { ok: boolean; result: { file_path: string } }
    if (!fileData.ok || !fileData.result?.file_path) {
      throw new Error('Telegram getFile 失败')
    }

    // Step 2: 下载文件
    const downloadUrl = `${BASE}/file/bot${this.token}/${fileData.result.file_path}`
    const dlResp = await fetch(downloadUrl)
    if (!dlResp.ok) throw new Error(`Telegram 文件下载失败: ${dlResp.status}`)

    const buffer = Buffer.from(await dlResp.arrayBuffer())
    const tmpPath = destPath + '.tmp.' + process.pid
    fs.writeFileSync(tmpPath, buffer)
    fs.chmodSync(tmpPath, 0o600)
    fs.renameSync(tmpPath, destPath)
  }
}

// --- 类型定义 ---

interface TgUpdate {
  update_id: number
  message?: TgMessage
}

interface TgMessage {
  message_id: number
  from?: { id: number; first_name: string; is_bot: boolean }
  chat: { id: number; type: string }
  date: number
  text?: string
  caption?: string
  photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
}

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen))
  }
  return chunks
}
