/**
 * @input:    ~/.im2cc/config.json (飞书凭证、白名单、默认参数)
 * @output:   loadConfig(), saveConfig(), getDataDir() — 配置读写和数据目录管理
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
  defaultPermissionMode: string // plan | auto | default | auto-edit
  defaultTimeoutSeconds: number // 默认 600 (10分钟)
  recapBudget: number           // /fc 时上下文回顾的字符预算，0 = 禁用
}

const CONFIG_DIR = path.join(os.homedir(), '.im2cc')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const DATA_DIR = path.join(CONFIG_DIR, 'data')
const LOG_DIR = path.join(CONFIG_DIR, 'logs')
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid')

const DEFAULT_CONFIG: Im2ccConfig = {
  feishu: { appId: '', appSecret: '' },
  allowedUserIds: [],
  pathWhitelist: [path.join(os.homedir(), 'Code')],
  defaultPermissionMode: 'YOLO',
  defaultTimeoutSeconds: 600,
  recapBudget: 2000,
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
  return { ...DEFAULT_CONFIG, ...parsed }
}

export function saveConfig(config: Im2ccConfig): void {
  ensureDirs()
  const tmpFile = CONFIG_FILE + '.tmp'
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), { mode: 0o600 })
  fs.renameSync(tmpFile, CONFIG_FILE)
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE) &&
    (() => { const c = loadConfig(); return c.feishu.appId !== '' })()
}

export function getDataDir(): string { ensureDirs(); return DATA_DIR }
export function getLogDir(): string { ensureDirs(); return LOG_DIR }
export function getPidFile(): string { ensureDirs(); return PID_FILE }
export function getConfigDir(): string { ensureDirs(); return CONFIG_DIR }
