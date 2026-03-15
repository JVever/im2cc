/**
 * @input:    日志消息
 * @output:   log(), error() — 写入 ~/.im2cc/logs/daemon.log
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import { getLogDir } from './config.js'

const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB

function getLogFile(): string {
  return path.join(getLogDir(), 'daemon.log')
}

function rotateIfNeeded(): void {
  const logFile = getLogFile()
  try {
    const stat = fs.statSync(logFile)
    if (stat.size > MAX_LOG_SIZE) {
      fs.renameSync(logFile, logFile + '.old')
    }
  } catch { /* 文件不存在，无需轮转 */ }
}

function write(level: string, msg: string): void {
  rotateIfNeeded()
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] [${level}] ${msg}\n`
  fs.appendFileSync(getLogFile(), line)
  if (level === 'ERROR') {
    process.stderr.write(line)
  }
}

export function log(msg: string): void { write('INFO', msg) }
export function error(msg: string): void { write('ERROR', msg) }
