/**
 * @input:    微信 iLink Bot API (ilinkai.weixin.qq.com), WeChatAccount 配置
 * @output:   WeChatAdapter (TransportAdapter) — 微信 ClawBot iLink 长轮询、消息收发
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import type { TransportAdapter, IncomingMessage, OutgoingMessage } from './transport.js'
import type { WeChatAccount } from './config.js'
import { saveWeChatAccount, getDataDir } from './config.js'
import { log, error } from './logger.js'
import { renderOutgoingMessageAsText } from './message-format.js'

// --- context_token 持久化（含有效期和使用计数追踪）---

const CTX_TOKEN_FILE = () => path.join(getDataDir(), 'wechat-ctx-tokens.json')

/** context_token 约 10 条消息后失效 */
const MAX_TOKEN_USES = 8  // 留 2 条余量
/** context_token 24 小时后可能被微信静默丢弃 */
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000  // 23 小时（留 1 小时余量）

interface TokenEntry {
  token: string
  receivedAt: number  // 收到用户消息的时间戳
  useCount: number    // 已用此 token 发送的消息数
}

function loadContextTokens(): Map<string, TokenEntry> {
  try {
    const data = JSON.parse(fs.readFileSync(CTX_TOKEN_FILE(), 'utf-8')) as Record<string, unknown>
    const map = new Map<string, TokenEntry>()
    for (const [key, val] of Object.entries(data)) {
      if (typeof val === 'string') {
        // 兼容旧格式（纯 string token）
        map.set(key, { token: val, receivedAt: Date.now(), useCount: 0 })
      } else if (val && typeof val === 'object') {
        map.set(key, val as TokenEntry)
      }
    }
    return map
  } catch { return new Map() }
}

function saveContextTokens(tokens: Map<string, TokenEntry>): void {
  const file = CTX_TOKEN_FILE()
  const tmp = file + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(tokens)))
    fs.renameSync(tmp, file)
  } catch { /* 非关键路径 */ }
}

/** 检查 token 是否仍然可用 */
function isTokenValid(entry: TokenEntry | undefined): boolean {
  if (!entry) return false
  if (entry.useCount >= MAX_TOKEN_USES) return false
  if (Date.now() - entry.receivedAt > TOKEN_TTL_MS) return false
  return true
}

/** iLink 请求头（每次请求需要新的 X-WECHAT-UIN） */
function makeHeaders(botToken: string): Record<string, string> {
  const uin = Buffer.from(String(Math.floor(Math.random() * 0xFFFFFFFF))).toString('base64')
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': uin,
    'Authorization': `Bearer ${botToken}`,
  }
}

/** iLink getupdates 响应中的消息 */
interface ILinkMessageItem {
  type: number
  text_item?: { text: string }
  voice_item?: { voice_text: string }
}

interface ILinkMessage {
  message_id: number
  from_user_id: string
  message_type: number
  context_token: string
  item_list?: ILinkMessageItem[]
}

export class WeChatAdapter implements TransportAdapter {
  readonly type = 'wechat' as const
  private account: WeChatAccount
  private syncBuf: string
  private contextTokens: Map<string, TokenEntry>
  private tokenValid = true

  constructor(account: WeChatAccount) {
    this.account = account
    this.syncBuf = account.syncBuf || ''
    this.contextTokens = loadContextTokens()
  }

  async start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    // 验证 token 有效性
    try {
      await this.getUpdates()
      log('[wechat] iLink 连接成功')
      this.account.lastOkAt = new Date().toISOString()
      saveWeChatAccount(this.account)
    } catch (err) {
      error(`[wechat] iLink 连接失败: ${err}`)
      this.tokenValid = false
      return
    }

    // 启动长轮询循环
    const pollBody = async (): Promise<void> => {
      if (!this.tokenValid) {
        error('[wechat] token 已失效，停止轮询。请运行 im2cc wechat login 重新认证')
        return
      }

      try {
        const messages = await this.getUpdates()

        if (messages.length > 0) {
          log(`[wechat] 收到 ${messages.length} 条原始消息`)
          for (const m of messages) {
            log(`[wechat] 消息 type=${m.message_type} from=${m.from_user_id}`)
          }
        }

        for (const rawMsg of messages) {
          // 只处理用户文本消息（message_type=1）
          if (rawMsg.message_type !== 1) continue

          // 从 item_list 中提取文本
          const firstItem = rawMsg.item_list?.[0]
          const text = firstItem?.text_item?.text || firstItem?.voice_item?.voice_text || ''
          if (!text.trim()) continue

          // 缓存 context_token（新消息 = 全新 token，重置计数和时间）
          if (rawMsg.context_token) {
            this.contextTokens.set(rawMsg.from_user_id, {
              token: rawMsg.context_token,
              receivedAt: Date.now(),
              useCount: 0,
            })
            saveContextTokens(this.contextTokens)
          }

          const msg: IncomingMessage = {
            messageId: String(rawMsg.message_id),
            conversationId: `wechat:${rawMsg.from_user_id}`,
            transport: 'wechat',
            senderId: rawMsg.from_user_id,
            kind: 'text',
            text: text.trim(),
          }

          try {
            await onMessage(msg)
          } catch (err) {
            error(`[wechat] 处理消息出错: ${err}`)
          }
        }
      } catch (err) {
        if (String(err).includes('401') || String(err).includes('403')) {
          this.tokenValid = false
          error('[wechat] token 已过期或无效，请运行 im2cc wechat login 重新认证')
          return
        }
        error(`[wechat] 轮询失败: ${err}`)
      }
    }

    let wPollCount = 0
    const pollLoop = (): void => {
      wPollCount++
      const n = wPollCount
      log(`[wechat] poll #${n} 开始`)
      pollBody()
        .then(() => log(`[wechat] poll #${n} 完成`))
        .catch(err => error(`[wechat] poll #${n} 错误: ${err}`))
        .finally(() => {
          log(`[wechat] poll #${n} finally`)
          if (this.tokenValid) setTimeout(pollLoop, 100)
        })
    }

    log('[wechat] 启动 iLink 长轮询')
    setTimeout(pollLoop, 100)
  }

  async sendText(conversationId: string, text: string): Promise<void> {
    return this.sendRawText(conversationId, text)
  }

  async sendMessage(conversationId: string, message: OutgoingMessage): Promise<void> {
    return this.sendRawText(conversationId, renderOutgoingMessageAsText(message))
  }

  private async sendRawText(conversationId: string, text: string): Promise<void> {
    if (!this.tokenValid) {
      throw new Error('微信 token 已失效，请运行 im2cc wechat login 重新认证')
    }

    // conversationId 格式: wechat:<userId>
    const userId = conversationId.replace('wechat:', '')
    const entry = this.contextTokens.get(userId)

    if (!isTokenValid(entry)) {
      log(`[wechat] context_token 不可用 (${!entry ? '无token' : entry.useCount >= MAX_TOKEN_USES ? '已用' + entry.useCount + '次' : '已过期'})`)
      throw new Error('微信 context_token 不可用。请在微信中给 ClawBot 发一条消息后重试。')
    }

    const contextToken = entry!.token

    const clientId = `im2cc:${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: userId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [
          {
            type: 1,
            text_item: { text },
          },
        ],
      },
      base_info: { channel_version: '1.0.2' },
    }

    log(`[wechat] sendText → ${userId.slice(0, 15)}... text=${text.slice(0, 50)}`)

    const resp = await fetch(`${this.account.baseUrl}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: makeHeaders(this.account.botToken),
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const respText = await resp.text()
      if (resp.status === 401 || resp.status === 403) {
        this.tokenValid = false
      }
      throw new Error(`iLink sendmessage 失败: ${resp.status} ${respText.slice(0, 200)}`)
    }

    // 发送成功，增加使用计数
    if (entry) {
      entry.useCount++
      saveContextTokens(this.contextTokens)
    }
  }

  // --- 内部方法 ---

  private async getUpdates(): Promise<ILinkMessage[]> {
    const body = {
      get_updates_buf: this.syncBuf,
      base_info: { channel_version: '1.0.2' },
    }

    const resp = await fetch(`${this.account.baseUrl}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: makeHeaders(this.account.botToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40000),  // 比 35s hold 略长
    })

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        this.tokenValid = false
      }
      throw new Error(`iLink getupdates 失败: ${resp.status}`)
    }

    const data = await resp.json() as {
      get_updates_buf?: string
      sync_buf?: string
      msgs?: ILinkMessage[]
    }

    // 更新 cursor（优先用 get_updates_buf，它包含完整的 bot 信息）
    const newBuf = data.get_updates_buf || data.sync_buf
    if (newBuf && newBuf !== this.syncBuf) {
      this.syncBuf = newBuf
      this.account.syncBuf = this.syncBuf
      this.account.lastOkAt = new Date().toISOString()
      saveWeChatAccount(this.account)
    }

    return data.msgs ?? []
  }
}

// --- QR 码认证流程（CLI 调用） ---

export interface QRAuthResult {
  botToken: string
  baseUrl: string
  ilinkBotId: string
  ilinkUserId: string
}

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** 获取 QR 码用于扫描认证 */
export async function getQRCode(): Promise<{ qrcode: string; qrcodeUrl: string }> {
  const resp = await fetch(`${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`)
  if (!resp.ok) throw new Error(`获取 QR 码失败: ${resp.status}`)
  const data = await resp.json() as Record<string, unknown>
  return {
    qrcode: data.qrcode as string,
    qrcodeUrl: (data.qrcode_img_content as string) ?? '',
  }
}

/** 轮询 QR 码扫描状态 */
export async function pollQRCodeStatus(qrcode: string): Promise<QRAuthResult | null> {
  const resp = await fetch(`${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
    signal: AbortSignal.timeout(60000),
  })
  if (!resp.ok) return null

  const data = await resp.json() as Record<string, unknown>
  const botToken = data.bot_token as string
  if (!botToken) return null

  return {
    botToken,
    baseUrl: (data.baseurl as string) || DEFAULT_BASE_URL,
    ilinkBotId: (data.ilink_bot_id as string) || '',
    ilinkUserId: (data.ilink_user_id as string) || '',
  }
}
