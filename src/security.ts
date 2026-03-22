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

/** session 名称合法性校验（防注入：只允许字母、数字、连字符、下划线） */
const SAFE_SESSION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export function isValidSessionName(name: string): boolean {
  return SAFE_SESSION_NAME.test(name)
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

/** 智能路径解析：短名称 → 在白名单目录下查找匹配的子目录 */
export function resolvePath(rawPath: string, config: Im2ccConfig): string {
  // 已经是绝对路径或 ~ 开头，直接返回
  if (rawPath.startsWith('/') || rawPath.startsWith('~')) return rawPath

  // 短名称模式：在白名单目录下查找
  for (const prefix of config.pathWhitelist) {
    const expanded = expandPath(prefix)
    const candidate = path.join(expanded, rawPath)
    if (fs.existsSync(candidate)) return candidate
  }

  // 找不到，原样返回让 validatePath 报错
  return rawPath
}

/** 列出白名单目录下的所有项目目录 */
export function listProjects(config: Im2ccConfig): string[] {
  const projects: string[] = []
  for (const prefix of config.pathWhitelist) {
    const expanded = expandPath(prefix)
    try {
      const entries = fs.readdirSync(expanded, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          projects.push(entry.name)
        }
      }
    } catch { /* 目录不存在 */ }
  }
  return projects.sort()
}
