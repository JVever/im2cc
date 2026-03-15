/**
 * @input:    用户消息文本, Im2ccConfig, Binding
 * @output:   parseCommand(), handleCommand() — 命令解析与执行
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import type { Im2ccConfig } from './config.js'
import { validatePath } from './security.js'
import { createBinding, getBinding, archiveBinding, updateBinding, listActiveBindings } from './session.js'
import { createSession, getClaudeVersion } from './claude-driver.js'
import { handleStop, getQueueStatus } from './queue.js'
import { log } from './logger.js'

export interface ParsedCommand {
  command: string
  args: string
}

const COMMANDS = new Set(['bind', 'unbind', 'mode', 'stop', 'new', 'status', 'help'])

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/)
  if (!cmd || !COMMANDS.has(cmd)) return null
  return { command: cmd, args: rest.join(' ').trim() }
}

export async function handleCommand(
  cmd: ParsedCommand,
  groupId: string,
  config: Im2ccConfig,
): Promise<string> {
  switch (cmd.command) {
    case 'bind': return handleBind(cmd.args, groupId, config)
    case 'unbind': return handleUnbind(groupId)
    case 'mode': return handleMode(cmd.args, groupId)
    case 'stop': return handleStop(groupId)
    case 'new': return handleNew(cmd.args, groupId, config)
    case 'status': return handleStatus(groupId)
    case 'help': return handleHelp()
    default: return `未知命令: /${cmd.command}`
  }
}

async function handleBind(args: string, groupId: string, config: Im2ccConfig): Promise<string> {
  if (!args) return '用法: /bind <项目路径>\n例如: /bind ~/Code/my-project'

  const existing = getBinding(groupId)
  if (existing) {
    return `该群已绑定到 ${existing.cwd}\n如需重新绑定，请先 /unbind 或使用 /new <路径>`
  }

  const validation = validatePath(args, config)
  if (!validation.valid) return `❌ ${validation.error}`

  log(`[${groupId}] 绑定到 ${validation.resolvedPath}`)

  try {
    const cliVersion = getClaudeVersion()
    const { sessionId, output } = await createSession(
      validation.resolvedPath,
      config.defaultPermissionMode,
    )

    const binding = createBinding(
      groupId,
      sessionId,
      validation.resolvedPath,
      config.defaultPermissionMode,
      cliVersion,
    )

    return [
      '✅ 已绑定 Claude Code',
      `📁 工作目录: ${binding.cwd}`,
      `🔑 Session ID: ${binding.sessionId}`,
      `⚙️ 权限模式: ${binding.permissionMode}`,
      '',
      '回到电脑后执行:',
      `  claude --resume ${binding.sessionId}`,
      '',
      '输入 /help 查看所有命令',
    ].join('\n')
  } catch (err) {
    return `❌ 创建 session 失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

function handleUnbind(groupId: string): string {
  const binding = archiveBinding(groupId)
  if (!binding) return '该群未绑定任何 session'

  return [
    '✅ 已解绑',
    `旧 Session ID: ${binding.sessionId}`,
    `回到电脑后可执行: claude --resume ${binding.sessionId}`,
  ].join('\n')
}

const VALID_MODES = ['plan', 'auto', 'default', 'auto-edit']

function handleMode(args: string, groupId: string): string {
  if (!args || !VALID_MODES.includes(args)) {
    return `用法: /mode <${VALID_MODES.join('|')}>\n当前支持的模式:\n` +
      '  plan — 只分析不执行（默认，最安全）\n' +
      '  default — 需要确认的操作会请求批准\n' +
      '  auto-edit — 自动批准编辑，其他需确认\n' +
      '  auto — 自动执行所有操作（⚠️ 危险）'
  }

  const binding = getBinding(groupId)
  if (!binding) return '该群未绑定，请先 /bind'

  updateBinding(groupId, { permissionMode: args })

  const warning = args === 'auto'
    ? '\n⚠️ auto 模式已开启，Claude 将自动执行所有操作，请谨慎使用'
    : ''

  return `⚙️ 权限模式已切换为 ${args}（下一条消息生效）${warning}`
}

async function handleNew(args: string, groupId: string, config: Im2ccConfig): Promise<string> {
  const old = archiveBinding(groupId)

  const cwdToUse = args
    ? (() => {
        const v = validatePath(args, config)
        return v.valid ? v.resolvedPath : null
      })()
    : old?.cwd

  if (!cwdToUse) {
    if (args) return `❌ 路径无效: ${args}`
    return '没有可用的工作目录，请使用 /new <路径>'
  }

  try {
    const cliVersion = getClaudeVersion()
    const { sessionId } = await createSession(cwdToUse, config.defaultPermissionMode)

    const binding = createBinding(groupId, sessionId, cwdToUse, config.defaultPermissionMode, cliVersion)

    const lines = ['✅ 新会话已创建']
    if (old) lines.push(`旧 Session: ${old.sessionId}`)
    lines.push(
      `新 Session: ${binding.sessionId}`,
      `📁 工作目录: ${binding.cwd}`,
      '',
      `回到电脑恢复旧会话: claude --resume ${old?.sessionId ?? 'N/A'}`,
    )
    return lines.join('\n')
  } catch (err) {
    return `❌ 创建新 session 失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

function handleStatus(groupId: string): string {
  const binding = getBinding(groupId)
  if (!binding) return '该群未绑定任何 session'

  const qs = getQueueStatus(groupId)

  return [
    '📊 当前会话状态',
    `  CLI: Claude Code (${binding.cliVersion})`,
    `  Session: ${binding.sessionId}`,
    `  目录: ${binding.cwd}`,
    `  模式: ${binding.permissionMode}`,
    `  对话轮次: ${binding.turnCount}`,
    `  状态: ${qs.state}${qs.queueLength > 0 ? ` (队列中 ${qs.queueLength} 条)` : ''}`,
    '',
    '⚠️ 如已在电脑端打开同一 session，请勿同时远程操作',
  ].join('\n')
}

function handleHelp(): string {
  return [
    '📖 im2cc 命令帮助',
    '',
    '/bind <路径>  — 绑定群到 Claude Code session',
    '/unbind       — 解绑，显示 session ID',
    '/mode <模式>  — 切换权限模式 (plan|default|auto-edit|auto)',
    '/stop         — 中断当前执行',
    '/new [路径]   — 新建 session（可选新路径）',
    '/status       — 查看当前状态',
    '/help         — 显示本帮助',
    '',
    '其他所有消息会直接发送给 Claude Code。',
  ].join('\n')
}
