/**
 * @input:    飞书 App 凭证, REST API (im.message.list, im.chat.list)
 * @output:   startFeishu(), sendTextMessage(), downloadResource() — 飞书 REST 轮询、消息收发、资源下载
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import * as lark from '@larksuiteoapi/node-sdk'
import type { Im2ccConfig } from './config.js'
import { getCursor, setCursor, initCursorIfMissing } from './poll-cursor.js'
import { log, error } from './logger.js'

// --- 消息类型定义（与 WS 版本保持一致）---

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

// --- Bot 群列表缓存 ---

interface BotChat {
  chatId: string
}

let cachedChats: BotChat[] = []
let chatsCachedAt = 0
const CHAT_CACHE_TTL = 5 * 60 * 1000  // 5 分钟

/** 获取 Bot 所在的所有会话，缓存 5 分钟 */
async function refreshBotGroups(): Promise<BotChat[]> {
  if (Date.now() - chatsCachedAt < CHAT_CACHE_TTL && cachedChats.length > 0) {
    return cachedChats
  }

  const chats: BotChat[] = []
  let pageToken: string | undefined

  do {
    const resp = await client!.im.chat.list({
      params: {
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    })
    for (const item of resp?.data?.items ?? []) {
      if (item.chat_id) {
        chats.push({ chatId: item.chat_id })
      }
    }
    pageToken = resp?.data?.has_more ? resp?.data?.page_token : undefined
  } while (pageToken)

  cachedChats = chats
  chatsCachedAt = Date.now()
  log(`[poll] 刷新群列表: ${chats.length} 个会话`)
  return chats
}

/** 拉取某个群游标之后的新消息 */
async function fetchGroupMessages(chatId: string): Promise<Array<Record<string, unknown>>> {
  const cursor = initCursorIfMissing(chatId)
  const items: Array<Record<string, unknown>> = []
  let pageToken: string | undefined

  do {
    const resp = await client!.im.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        start_time: cursor,
        sort_type: 'ByCreateTimeAsc',
        page_size: 50,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    })
    for (const item of resp?.data?.items ?? []) {
      items.push(item as Record<string, unknown>)
    }
    pageToken = resp?.data?.has_more ? resp?.data?.page_token : undefined
  } while (pageToken)

  return items
}

/** REST 消息格式 → IncomingMessage 适配 */
function parseRestMessage(item: Record<string, unknown>): IncomingMessage | null {
  const sender = item.sender as Record<string, unknown> | undefined
  const body = item.body as Record<string, string> | undefined
  const messageId = (item.message_id as string) ?? ''
  const chatId = (item.chat_id as string) ?? ''
  const msgType = (item.msg_type as string) ?? ''
  const senderId = (sender?.id as string) ?? ''
  const senderType = (sender?.sender_type as string) ?? ''

  // 过滤 Bot 自己的消息（REST API 中 bot 的 sender_type 为 "app"）
  if (senderType === 'app') return null

  // im2cc 场景下全部视为 group
  const chatType = 'group'

  if (msgType === 'text') {
    let text = ''
    try {
      const content = JSON.parse(body?.content ?? '{}') as Record<string, string>
      text = content.text ?? ''
    } catch { return null }

    // 剥离 @mention 前缀 (飞书格式: @_user_1 或 @_all)
    text = text.replace(/@_user_\d+\s*/g, '').trim()
    if (!text) return null

    return { kind: 'text', messageId, chatId, senderId, chatType, text }
  }

  if (msgType === 'image') {
    try {
      const content = JSON.parse(body?.content ?? '{}') as Record<string, string>
      const imageKey = content.image_key
      if (!imageKey) return null
      return { kind: 'file', messageId, chatId, senderId, chatType, fileKey: imageKey, fileName: 'image.png', msgType: 'image' }
    } catch { return null }
  }

  if (msgType === 'file') {
    try {
      const content = JSON.parse(body?.content ?? '{}') as Record<string, string>
      const fileKey = content.file_key
      const fileName = content.file_name || 'unknown'
      if (!fileKey) return null
      return { kind: 'file', messageId, chatId, senderId, chatType, fileKey, fileName, msgType: 'file' }
    } catch { return null }
  }

  // audio, video 等 — 不支持
  return null
}

export async function startFeishu(
  config: Im2ccConfig,
  onMessage: MessageHandler,
): Promise<void> {
  const { appId, appSecret } = config.feishu

  if (!appId || !appSecret) {
    throw new Error('飞书 App ID 或 App Secret 未配置。请运行 im2cc setup')
  }

  client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild })

  // 获取 Bot 信息，验证凭证有效
  try {
    const resp = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info/' })
    const botData = resp?.data as Record<string, unknown> | undefined
    const botInfo = botData?.bot as Record<string, string> | undefined
    log(`飞书 Bot 已连接: ${botInfo?.app_name ?? 'unknown'} (${botInfo?.open_id ?? ''})`)
  } catch (err) {
    error(`获取 Bot 信息失败: ${err}`)
  }

  const pollIntervalMs = config.pollIntervalMs

  /** 单次轮询：刷新群列表 → 逐群拉消息 → 解析 → 调 onMessage → 更新游标 */
  async function pollOnce(): Promise<void> {
    try {
      const chats = await refreshBotGroups()

      for (const chat of chats) {
        try {
          const items = await fetchGroupMessages(chat.chatId)
          if (items.length === 0) continue

          let maxCreateTime = 0

          for (const item of items) {
            const msg = parseRestMessage(item)
            if (msg) {
              try {
                await onMessage(msg)
              } catch (err) {
                error(`[poll] 处理消息出错 [${chat.chatId}]: ${err}`)
              }
            }
            // 跟踪最大 create_time（毫秒）
            const ct = parseInt((item.create_time as string) ?? '0', 10)
            if (ct > maxCreateTime) maxCreateTime = ct
          }

          // 更新游标（create_time 为毫秒，转为秒）
          if (maxCreateTime > 0) {
            setCursor(chat.chatId, Math.floor(maxCreateTime / 1000).toString())
          }
        } catch (err) {
          // 每个群独立 try/catch，一个群失败不影响其他群
          error(`[poll] 拉取群 ${chat.chatId} 消息失败: ${err}`)
        }
      }
    } catch (err) {
      error(`[poll] 轮询失败: ${err}`)
    }
  }

  /** 递归 setTimeout 防止请求堆叠（pollOnce 完成后才安排下一次） */
  async function pollLoop(): Promise<void> {
    await pollOnce()
    setTimeout(pollLoop, pollIntervalMs)
  }

  // 启动轮询（延迟一个周期，给 recoverOnStartup 让路）
  log(`[poll] 启动 REST 轮询 (间隔 ${pollIntervalMs}ms)`)
  setTimeout(pollLoop, pollIntervalMs)
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
