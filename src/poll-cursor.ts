/**
 * @input:    ~/.im2cc/data/poll-cursors.json
 * @output:   getCursor(), setCursor(), initCursorIfMissing() — 轮询游标持久化
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'

function cursorsFile(): string {
  return path.join(getDataDir(), 'poll-cursors.json')
}

function readCursors(): Record<string, string> {
  const f = cursorsFile()
  if (!fs.existsSync(f)) return {}
  return JSON.parse(fs.readFileSync(f, 'utf-8')) as Record<string, string>
}

/** 原子写：临时文件 + rename（复用 session.ts 模式） */
function writeCursors(cursors: Record<string, string>): void {
  const f = cursorsFile()
  const tmp = f + '.tmp.' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(cursors, null, 2))
  fs.renameSync(tmp, f)
}

/** 获取某个群的轮询游标（Unix 秒字符串） */
export function getCursor(chatId: string): string | null {
  return readCursors()[chatId] ?? null
}

/** 更新某个群的轮询游标 */
export function setCursor(chatId: string, timestamp: string): void {
  const cursors = readCursors()
  cursors[chatId] = timestamp
  writeCursors(cursors)
}

/** 首次遇到的群，初始化游标为当前时间（不回放历史） */
export function initCursorIfMissing(chatId: string): string {
  const existing = getCursor(chatId)
  if (existing) return existing
  const now = Math.floor(Date.now() / 1000).toString()
  setCursor(chatId, now)
  return now
}
