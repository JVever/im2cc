/**
 * @input:    本机安装的工具 CLI 及其 --help 输出
 * @output:   可选 CLI 能力探测（例如 Claude 是否支持 --name）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import { spawnSync } from 'node:child_process'

let claudeSupportsNameCache: boolean | null = null

function envOverride(name: string): boolean | null {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return null
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return null
}

export function claudeSupportsSessionNameFlag(): boolean {
  const override = envOverride('IM2CC_CLAUDE_SUPPORTS_NAME')
  if (override !== null) return override
  if (claudeSupportsNameCache !== null) return claudeSupportsNameCache

  try {
    const result = spawnSync('claude', ['--help'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const helpText = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    claudeSupportsNameCache = result.status === 0 && /\b--name\b/.test(helpText)
  } catch {
    claudeSupportsNameCache = false
  }

  return claudeSupportsNameCache
}

export function claudeSessionNameArgs(name?: string): string[] {
  if (!name) return []
  return claudeSupportsSessionNameFlag() ? ['--name', `im2cc:${name}`] : []
}
