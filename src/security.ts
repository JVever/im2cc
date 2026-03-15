/**
 * @input:    Im2ccConfig (白名单列表、路径白名单)
 * @output:   isUserAllowed(), validatePath() — 身份验证和路径安全验证
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Im2ccConfig } from './config.js'

export function isUserAllowed(userId: string, config: Im2ccConfig): boolean {
  if (config.allowedUserIds.length === 0) return true
  return config.allowedUserIds.includes(userId)
}

/** 展开 ~ 并解析为绝对路径 */
export function expandPath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1))
  }
  return path.resolve(p)
}

export interface PathValidationResult {
  valid: boolean
  resolvedPath: string
  error?: string
}

/** 验证路径：展开、绝对化、存在性、白名单 */
export function validatePath(rawPath: string, config: Im2ccConfig): PathValidationResult {
  const expanded = expandPath(rawPath)

  // resolve symlinks
  let resolved: string
  try {
    resolved = fs.realpathSync(expanded)
  } catch {
    return { valid: false, resolvedPath: expanded, error: `路径不存在: ${expanded}` }
  }

  // 必须是目录
  try {
    const stat = fs.statSync(resolved)
    if (!stat.isDirectory()) {
      return { valid: false, resolvedPath: resolved, error: `不是目录: ${resolved}` }
    }
  } catch {
    return { valid: false, resolvedPath: resolved, error: `无法访问: ${resolved}` }
  }

  // 白名单检查
  const whitelistResolved = config.pathWhitelist.map(p => {
    const exp = expandPath(p)
    try { return fs.realpathSync(exp) } catch { return exp }
  })

  const allowed = whitelistResolved.some(prefix =>
    resolved === prefix || resolved.startsWith(prefix + path.sep)
  )

  if (!allowed) {
    return {
      valid: false,
      resolvedPath: resolved,
      error: `路径不在白名单内。允许的路径: ${config.pathWhitelist.join(', ')}`,
    }
  }

  return { valid: true, resolvedPath: resolved }
}
