/**
 * @input:    Im2ccConfig.claudeLauncher, Claude session/profile 上下文
 * @output:   Claude 启动器解析与 profile 选择辅助（默认直连 claude，本地可选 launcher 覆盖）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadConfig, type Im2ccConfig } from './config.js'

export interface ClaudeLauncherContext {
  phase: 'select' | 'create' | 'send' | 'resume' | 'compat' | 'version'
  sessionId?: string
  sessionName?: string
  profile?: string
}

function resolveConfig(config?: Im2ccConfig): Im2ccConfig {
  return config ?? loadConfig()
}

function envLauncherOverride(): string | null {
  const raw = process.env.IM2CC_CLAUDE_LAUNCHER?.trim()
  return raw ? raw : null
}

function expandHome(rawPath: string): string {
  if (!rawPath.startsWith('~')) return rawPath
  if (rawPath === '~') return os.homedir()
  if (rawPath.startsWith('~/')) return path.join(os.homedir(), rawPath.slice(2))
  return rawPath
}

export function getClaudeLauncher(config?: Im2ccConfig): string {
  const custom = envLauncherOverride() ?? resolveConfig(config).claudeLauncher?.trim()
  if (!custom || custom === 'claude') return 'claude'
  return path.resolve(expandHome(custom))
}

export function hasCustomClaudeLauncher(config?: Im2ccConfig): boolean {
  return getClaudeLauncher(config) !== 'claude'
}

export function assertClaudeLauncherAvailable(config?: Im2ccConfig): void {
  if (!hasCustomClaudeLauncher(config)) return
  const launcher = getClaudeLauncher(config)
  if (!fs.existsSync(launcher)) {
    throw new Error(`Claude launcher 不存在: ${launcher}`)
  }
  fs.accessSync(launcher, fs.constants.X_OK)
}

export function buildClaudeLauncherEnv(
  context: ClaudeLauncherContext,
  config?: Im2ccConfig,
): NodeJS.ProcessEnv | undefined {
  if (!hasCustomClaudeLauncher(config)) return undefined

  const env: NodeJS.ProcessEnv = { ...process.env }
  env.IM2CC_CLAUDE_PHASE = context.phase
  if (context.sessionId) env.IM2CC_CLAUDE_SESSION_ID = context.sessionId
  if (context.sessionName) env.IM2CC_CLAUDE_SESSION_NAME = context.sessionName
  if (context.profile) env.IM2CC_CLAUDE_PROFILE = context.profile
  return env
}

export function buildClaudeInteractiveCommand(
  args: string[],
  context: ClaudeLauncherContext,
  config?: Im2ccConfig,
): string[] {
  const launcher = getClaudeLauncher(config)
  if (!hasCustomClaudeLauncher(config)) return [launcher, ...args]

  const launcherEnv = buildClaudeLauncherEnv(context, config) ?? {}
  const envPairs = [
    launcherEnv.IM2CC_CLAUDE_PHASE,
    launcherEnv.IM2CC_CLAUDE_SESSION_ID && `IM2CC_CLAUDE_SESSION_ID=${launcherEnv.IM2CC_CLAUDE_SESSION_ID}`,
    launcherEnv.IM2CC_CLAUDE_SESSION_NAME && `IM2CC_CLAUDE_SESSION_NAME=${launcherEnv.IM2CC_CLAUDE_SESSION_NAME}`,
    launcherEnv.IM2CC_CLAUDE_PROFILE && `IM2CC_CLAUDE_PROFILE=${launcherEnv.IM2CC_CLAUDE_PROFILE}`,
  ].filter((value): value is string => Boolean(value))

  envPairs[0] = `IM2CC_CLAUDE_PHASE=${launcherEnv.IM2CC_CLAUDE_PHASE}`

  return ['env', ...envPairs, launcher, ...args]
}

export function selectClaudeProfile(
  cwd: string,
  sessionName: string,
  config?: Im2ccConfig,
): string | undefined {
  if (!hasCustomClaudeLauncher(config)) return undefined

  assertClaudeLauncherAvailable(config)
  const launcher = getClaudeLauncher(config)

  const stdout = execFileSync(launcher, ['--im2cc-select-profile'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['inherit', 'pipe', 'inherit'],
    env: buildClaudeLauncherEnv({ phase: 'select', sessionName }, config),
  }).trim()

  const profile = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).at(-1)
  if (!profile) {
    throw new Error('Claude launcher 未返回有效 profile')
  }
  return profile
}
