/**
 * @input:    用户消息文本, Im2ccConfig, Binding
 * @output:   parseCommand(), handleCommand() — 命令解析与执行
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import path from 'node:path'
import type { Im2ccConfig } from './config.js'
import { validatePath, resolvePath, listProjects } from './security.js'
import { createBinding, getBinding, archiveBinding, updateBinding } from './session.js'
import { createSession, getClaudeVersion } from './claude-driver.js'
import { handleStop, getQueueStatus } from './queue.js'
import { discoverSessions, findSession } from './discover.js'
import { log } from './logger.js'

export interface ParsedCommand {
  command: string
  args: string
}

const COMMANDS = new Set(['bind', 'unbind', 'mode', 'stop', 'new', 'attach', 'status', 'help'])

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/)
  if (!cmd || !COMMANDS.has(cmd.toLowerCase())) return null
  return { command: cmd.toLowerCase(), args: rest.join(' ').trim() }
}

export async function handleCommand(
  cmd: ParsedCommand,
  groupId: string,
  config: Im2ccConfig,
): Promise<string> {
  switch (cmd.command) {
    case 'bind': return handleBind(cmd.args, groupId, config)
    case 'attach': return handleAttach(cmd.args, groupId, config)
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
  // 无参数：列出可用项目
  if (!args) {
    const projects = listProjects(config)
    if (projects.length === 0) {
      return `${config.pathWhitelist.join(', ')} 下没有找到项目目录`
    }
    const list = projects.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
    return `📁 可用项目:\n${list}\n\n直接发 /bind <项目名> 绑定\n例如: /bind ${projects[0]}`
  }

  const existing = getBinding(groupId)
  if (existing) {
    return `该群已绑定到 ${path.basename(existing.cwd)}\n如需重新绑定，请先 /unbind 或使用 /new <项目名>`
  }

  // 智能路径解析：短名称 → 白名单目录下查找
  const resolved = resolvePath(args, config)
  const validation = validatePath(resolved, config)
  if (!validation.valid) return `❌ ${validation.error}`

  const projectName = path.basename(validation.resolvedPath)
  log(`[${groupId}] 绑定到 ${validation.resolvedPath}`)

  try {
    const cliVersion = getClaudeVersion()
    const { sessionId } = await createSession(
      validation.resolvedPath,
      config.defaultPermissionMode,
      projectName,  // session 命名
    )

    const binding = createBinding(
      groupId,
      sessionId,
      validation.resolvedPath,
      config.defaultPermissionMode,
      cliVersion,
    )

    return [
      `✅ 已绑定 Claude Code → ${projectName}`,
      `📁 ${binding.cwd}`,
      `⚙️ 模式: ${binding.permissionMode.toUpperCase()}`,
      '',
      `回到电脑: claude --resume "${projectName}"`,
    ].join('\n')
  } catch (err) {
    return `❌ 创建 session 失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleAttach(args: string, groupId: string, config: Im2ccConfig): Promise<string> {
  const existing = getBinding(groupId)
  if (existing) {
    return `该群已绑定到 ${path.basename(existing.cwd)} (${existing.sessionId.slice(0, 8)}...)\n先 /unbind 再 /attach`
  }

  // 无参数：列出最近对话
  if (!args) {
    const sessions = await discoverSessions(10)
    if (sessions.length === 0) return '未找到本地 Claude Code 对话'

    const timeAgo = (d: Date) => {
      const mins = Math.floor((Date.now() - d.getTime()) / 60000)
      if (mins < 1) return '刚刚'
      if (mins < 60) return `${mins}分钟前`
      const hrs = Math.floor(mins / 60)
      if (hrs < 24) return `${hrs}小时前`
      return `${Math.floor(hrs / 24)}天前`
    }

    const list = sessions.map((s, i) => {
      const label = s.name || s.firstMessage || '未命名'
      return `  ${i + 1}. ${label} (${s.projectName}) — ${timeAgo(s.lastModified)}`
    }).join('\n')

    return `📋 最近的 Claude Code 对话:\n${list}\n\n发 /attach <名称> 接入`
  }

  // 有参数：模糊匹配
  const matches = await findSession(args)

  if (matches.length === 0) {
    return `未找到匹配 "${args}" 的对话\n发 /attach 查看所有对话`
  }

  if (matches.length > 1) {
    const list = matches.slice(0, 5).map((s, i) => {
      const label = s.name || s.firstMessage || '未命名'
      return `  ${i + 1}. ${label} (${s.projectName}) [${s.sessionId.slice(0, 8)}]`
    }).join('\n')
    return `多个对话匹配 "${args}":\n${list}\n\n请用更精确的名称或 session ID 前缀`
  }

  // 唯一匹配，执行 attach
  const session = matches[0]
  const cliVersion = getClaudeVersion()

  const binding = createBinding(
    groupId,
    session.sessionId,
    session.projectPath,
    config.defaultPermissionMode,
    cliVersion,
  )

  log(`[${groupId}] attach 到 ${session.name} (${session.sessionId})`)

  return [
    `✅ 已接入: ${session.name || '未命名对话'}`,
    `📁 ${session.projectName} (${session.projectPath})`,
    `⚙️ 模式: ${binding.permissionMode}`,
    '',
    `回到电脑: cd ${session.projectPath} && claude --resume ${session.sessionId}`,
  ].join('\n')
}

function handleUnbind(groupId: string): string {
  const binding = archiveBinding(groupId)
  if (!binding) return '该群未绑定任何 session'

  const projectName = path.basename(binding.cwd)
  return [
    '✅ 已解绑',
    `回到电脑: claude --resume "${projectName}"`,
  ].join('\n')
}

const MODE_MAP: Record<string, string> = {
  'yolo': 'YOLO',
  'plan': 'plan',
  'default': 'default',
  'auto-edit': 'auto-edit',
}

// YOLO 模式映射到 Claude CLI 的实际参数
export const MODE_TO_CLI: Record<string, string> = {
  'YOLO': 'dangerouslySkipPermissions',
  'plan': 'plan',
  'default': 'default',
  'auto-edit': 'acceptEdits',
}

function handleMode(args: string, groupId: string): string {
  const normalized = MODE_MAP[args.toLowerCase()]
  if (!args || !normalized) {
    return '用法: /mode <模式>\n\n' +
      '  YOLO — 自动执行所有操作（默认）\n' +
      '  plan — 只分析不执行（最安全）\n' +
      '  default — 需要确认才执行\n' +
      '  auto-edit — 自动编辑，其他需确认'
  }

  const binding = getBinding(groupId)
  if (!binding) return '该群未绑定，请先 /bind'

  updateBinding(groupId, { permissionMode: normalized })
  return `⚙️ 模式已切换为 ${normalized}（下一条消息生效）`
}

async function handleNew(args: string, groupId: string, config: Im2ccConfig): Promise<string> {
  const old = archiveBinding(groupId)

  // 支持短名称
  const rawPath = args || (old ? path.basename(old.cwd) : '')
  if (!rawPath) return '请指定项目名: /new <项目名>'

  const resolved = resolvePath(rawPath, config)
  const validation = validatePath(resolved, config)
  if (!validation.valid) return `❌ ${validation.error}`

  const projectName = path.basename(validation.resolvedPath)

  try {
    const cliVersion = getClaudeVersion()
    const { sessionId } = await createSession(validation.resolvedPath, config.defaultPermissionMode, projectName)
    const binding = createBinding(groupId, sessionId, validation.resolvedPath, config.defaultPermissionMode, cliVersion)

    const lines = ['✅ 新会话已创建']
    if (old) lines.push(`旧会话: claude --resume "${path.basename(old.cwd)}"`)
    lines.push(
      `📁 ${binding.cwd}`,
      `⚙️ 模式: ${binding.permissionMode.toUpperCase()}`,
      '',
      `回到电脑: claude --resume "${projectName}"`,
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
  const projectName = path.basename(binding.cwd)

  return [
    `📊 ${projectName}`,
    `  目录: ${binding.cwd}`,
    `  模式: ${binding.permissionMode.toUpperCase()}`,
    `  轮次: ${binding.turnCount}`,
    `  状态: ${qs.state}${qs.queueLength > 0 ? ` (队列 ${qs.queueLength})` : ''}`,
    '',
    `  回到电脑: claude --resume "${projectName}"`,
  ].join('\n')
}

function handleHelp(): string {
  return [
    '📖 im2cc 命令',
    '',
    '/attach [名称]  — 接入电脑上已有的对话（核心功能）',
    '/bind [项目名]  — 新建对话并绑定项目',
    '/unbind         — 解绑',
    '/mode <模式>    — 切换模式 (YOLO|plan|default|auto-edit)',
    '/stop           — 中断执行',
    '/new [项目名]   — 新建会话',
    '/status         — 查看状态',
    '/help           — 帮助',
    '',
    '直接发消息即转给 Claude Code',
  ].join('\n')
}
