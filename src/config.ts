/**
 * @input:    ~/.im2cc/config.json (飞书凭证、白名单、默认参数), ~/.im2cc/wechat-account.json
 * @output:   loadConfig(), saveConfig(), getDataDir(), getDaemonLockDir(), getMessageDedupDir(), loadWeChatAccount(), saveWeChatAccount() — 配置读写和数据目录管理
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface Im2ccConfig {
  feishu: {
    appId: string
    appSecret: string
  }
  allowedUserIds: string[]    // 空数组 = 允许所有人（不推荐）
  pathWhitelist: string[]     // 允许绑定的目录前缀，默认 ['~/Code/']
  defaultPermissionMode: string // 旧字段，保留兼容：YOLO | default | auto-edit
  defaultModes: Record<string, string> // per-tool 默认模式 { claude: 'bypassPermissions', codex: 'bypass', ... }
  defaultTimeoutSeconds: number // 默认 600 (10分钟)
  recapBudget: number           // /fc 时上下文回顾的字符预算，0 = 禁用
  maxFileSizeMB: number         // 文件传输最大体积，默认 10
  inboxTtlMinutes: number       // inbox 文件过期时间，默认 60
  pollIntervalMs: number        // REST 轮询间隔（毫秒），默认 5000
}

const CONFIG_DIR = path.join(os.homedir(), '.im2cc')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const DATA_DIR = path.join(CONFIG_DIR, 'data')
const LOG_DIR = path.join(CONFIG_DIR, 'logs')
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid')
const DAEMON_LOCK_DIR = path.join(CONFIG_DIR, 'daemon.lock')
const INFLIGHT_DIR = path.join(DATA_DIR, 'inflight')
const PENDING_FILE = path.join(DATA_DIR, 'pending.json')
const MESSAGE_DEDUP_DIR = path.join(DATA_DIR, 'message-dedup')

const DEFAULT_CONFIG: Im2ccConfig = {
  feishu: { appId: '', appSecret: '' },
  allowedUserIds: [],
  pathWhitelist: [path.join(os.homedir(), 'Code')],
  defaultPermissionMode: 'default',
  defaultModes: {},  // 空 = 使用 mode-policy 内置默认
  defaultTimeoutSeconds: 600,
  recapBudget: 2000,
  maxFileSizeMB: 10,
  inboxTtlMinutes: 60,
  pollIntervalMs: 5000,
}

function ensureDirs(): void {
  for (const dir of [CONFIG_DIR, DATA_DIR, LOG_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
}

export function loadConfig(): Im2ccConfig {
  ensureDirs()
  if (!fs.existsSync(CONFIG_FILE)) {
    return { ...DEFAULT_CONFIG }
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<Im2ccConfig>
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    feishu: {
      ...DEFAULT_CONFIG.feishu,
      ...parsed.feishu,
    },
  }
}

export function saveConfig(config: Im2ccConfig): void {
  ensureDirs()
  const tmpFile = CONFIG_FILE + '.tmp'
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), { mode: 0o600 })
  fs.renameSync(tmpFile, CONFIG_FILE)
}

export function configExists(): boolean {
  const wa = loadWeChatAccount()
  if (wa !== null && wa.botToken !== '') return true
  if (!fs.existsSync(CONFIG_FILE)) return false
  const c = loadConfig()
  if (c.feishu.appId !== '') return true
  return false
}

export function getDataDir(): string { ensureDirs(); return DATA_DIR }
export function getLogDir(): string { ensureDirs(); return LOG_DIR }
export function getPidFile(): string { ensureDirs(); return PID_FILE }
export function getDaemonLockDir(): string { ensureDirs(); return DAEMON_LOCK_DIR }
export function getConfigDir(): string { ensureDirs(); return CONFIG_DIR }
export function getInflightDir(): string {
  if (!fs.existsSync(INFLIGHT_DIR)) fs.mkdirSync(INFLIGHT_DIR, { recursive: true })
  return INFLIGHT_DIR
}
export function getPendingFile(): string { ensureDirs(); return PENDING_FILE }
export function getMessageDedupDir(): string {
  ensureDirs()
  if (!fs.existsSync(MESSAGE_DEDUP_DIR)) fs.mkdirSync(MESSAGE_DEDUP_DIR, { recursive: true })
  return MESSAGE_DEDUP_DIR
}

// --- 默认模式 ---

import { getBuiltinDefault, migrateLegacyMode, isValidMode } from './mode-policy.js'
import type { ToolId } from './tool-driver.js'

/** 获取工具的默认模式（优先 per-tool 配置，否则迁移旧配置，最后用内置默认） */
export function getDefaultMode(tool: ToolId, config?: Im2ccConfig): string {
  const cfg = config ?? loadConfig()

  // 1. per-tool 配置
  if (cfg.defaultModes?.[tool] && isValidMode(tool, cfg.defaultModes[tool])) {
    return cfg.defaultModes[tool]
  }

  // 2. 旧 defaultPermissionMode 迁移
  if (cfg.defaultPermissionMode && cfg.defaultPermissionMode !== 'default') {
    return migrateLegacyMode(cfg.defaultPermissionMode, tool)
  }

  // 3. 内置默认
  return getBuiltinDefault(tool)
}

/** 设置工具的默认模式 */
export function setDefaultMode(tool: ToolId, modeId: string): void {
  const config = loadConfig()
  if (!config.defaultModes) config.defaultModes = {}
  config.defaultModes[tool] = modeId
  saveConfig(config)
}

// --- 微信账号配置 ---

const WECHAT_ACCOUNT_FILE = path.join(CONFIG_DIR, 'wechat-account.json')

export interface WeChatAccount {
  botToken: string
  baseUrl: string
  ilinkBotId: string
  ilinkUserId: string
  savedAt: string
  lastOkAt: string
  syncBuf: string  // getupdates cursor
}

export function getWeChatAccountFile(): string { return WECHAT_ACCOUNT_FILE }

export function loadWeChatAccount(): WeChatAccount | null {
  if (!fs.existsSync(WECHAT_ACCOUNT_FILE)) return null
  try {
    return JSON.parse(fs.readFileSync(WECHAT_ACCOUNT_FILE, 'utf-8')) as WeChatAccount
  } catch { return null }
}

export function saveWeChatAccount(account: WeChatAccount): void {
  ensureDirs()
  const tmp = WECHAT_ACCOUNT_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(account, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, WECHAT_ACCOUNT_FILE)
}
