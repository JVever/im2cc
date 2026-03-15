/**
 * @input:    用户消息文本, Im2ccConfig, Binding
 * @output:   parseCommand(), handleCommand() — 命令解析与执行
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import path from 'node:path'
import type { Im2ccConfig } from './config.js'
import { validatePath, resolvePath, listProjects } from './security.js'
import { createBinding, getBinding, archiveBinding, updateBinding } from './session.js'
import { createSession, getClaudeVersion, killLocalSession } from './claude-driver.js'
import { handleStop, getQueueStatus } from './queue.js'
import { discoverSessions, findSession } from './discover.js'
import { register, lookup, search, listRegistered, touch } from './registry.js'
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
  // 用法: /bind <名称> <项目>  — 创建新对话并注册
  // 或:   /bind <名称>         — 如果名称就是项目目录名
  // 或:   /bind                — 列出可用项目
  if (!args) {
    const projects = listProjects(config)
    if (projects.length === 0) return `${config.pathWhitelist.join(', ')} 下没有找到项目目录`
    const list = projects.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
    return `📁 可用项目:\n${list}\n\n用法: /bind <对话名称> [项目名]\n例如: /bind auth-refactor im2cc`
  }

  const existing = getBinding(groupId)
  if (existing) {
    return `该群已连接到 "${path.basename(existing.cwd)}"\n先 /unbind 再操作`
  }

  const parts = args.split(/\s+/)
  const sessionName = parts[0]
  const projectHint = parts[1] || sessionName // 默认用对话名称作为项目名

  // 解析项目路径
  const resolved = resolvePath(projectHint, config)
  const validation = validatePath(resolved, config)
  if (!validation.valid) return `❌ ${validation.error}`

  log(`[${groupId}] 创建新对话 "${sessionName}" → ${validation.resolvedPath}`)

  try {
    const cliVersion = getClaudeVersion()
    const { sessionId } = await createSession(validation.resolvedPath, config.defaultPermissionMode, sessionName)

    // 注册到 registry
    register(sessionName, sessionId, validation.resolvedPath)

    const binding = createBinding(groupId, sessionId, validation.resolvedPath, config.defaultPermissionMode, cliVersion)

    return [
      `✅ 新对话 "${sessionName}"`,
      `📁 ${path.basename(validation.resolvedPath)}`,
      `⚙️ 模式: ${binding.permissionMode}`,
      '',
      `回到电脑: im2cc open ${sessionName}`,
    ].join('\n')
  } catch (err) {
    return `❌ 创建失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleAttach(args: string, groupId: string, config: Im2ccConfig): Promise<string> {
  const existing = getBinding(groupId)
  if (existing) {
    return `该群已连接，先 /unbind 再 /attach`
  }

  // 无参数：列出注册表 + 最近发现的对话
  if (!args) {
    const registered = listRegistered()
    const lines: string[] = []

    if (registered.length > 0) {
      lines.push('📋 已注册的对话:')
      for (const s of registered) {
        lines.push(`  ${s.name} (${path.basename(s.cwd)})`)
      }
      lines.push('')
    }

    // 补充：文件系统扫描发现未注册的对话
    const discovered = await discoverSessions(8)
    const registeredIds = new Set(registered.map(r => r.sessionId))
    const unregistered = discovered.filter(d => !registeredIds.has(d.sessionId))

    if (unregistered.length > 0) {
      lines.push('💡 电脑上最近的对话 (未注册):')
      for (const s of unregistered.slice(0, 5)) {
        const label = s.name || s.firstMessage?.slice(0, 30) || '未命名'
        lines.push(`  ${label} (${s.projectName}) [${s.sessionId.slice(0, 8)}]`)
      }
      lines.push('')
    }

    if (lines.length === 0) return '没有可用的对话'

    lines.push('发 /attach <名称> 接入')
    return lines.join('\n')
  }

  // 优先从注册表查找
  const reg = lookup(args)
  if (reg) {
    // 独占：关闭本地 tmux 中的 Claude Code
    const killed = killLocalSession(reg.name)
    const cliVersion = getClaudeVersion()
    touch(reg.name)
    const binding = createBinding(groupId, reg.sessionId, reg.cwd, config.defaultPermissionMode, cliVersion)
    log(`[${groupId}] attach → "${reg.name}" (${reg.sessionId})${killed ? ' [已关闭本地进程]' : ''}`)

    return [
      `✅ 已接入 "${reg.name}"`,
      killed ? '🔄 已关闭电脑端的对话' : '',
      `📁 ${path.basename(reg.cwd)}`,
      `⚙️ 模式: ${binding.permissionMode}`,
      '',
      `回到电脑: im2cc open ${reg.name}`,
    ].filter(Boolean).join('\n')
  }

  // 注册表没有，尝试模糊搜索注册表
  const regMatches = search(args)
  if (regMatches.length > 0) {
    const list = regMatches.map(s => `  ${s.name} (${path.basename(s.cwd)})`).join('\n')
    return `多个匹配:\n${list}\n\n请输入更精确的名称`
  }

  // 最后尝试文件系统扫描
  const discovered = await findSession(args)
  if (discovered.length === 1) {
    const s = discovered[0]
    const cliVersion = getClaudeVersion()
    const binding = createBinding(groupId, s.sessionId, s.projectPath, config.defaultPermissionMode, cliVersion)
    // 自动注册
    register(args, s.sessionId, s.projectPath)
    log(`[${groupId}] attach (discovered) → "${args}" (${s.sessionId})`)

    return [
      `✅ 已接入 "${s.name || args}"`,
      `📁 ${s.projectName}`,
      `⚙️ 模式: ${binding.permissionMode}`,
      '',
      `回到电脑: im2cc open ${args}`,
    ].join('\n')
  }

  if (discovered.length > 1) {
    const list = discovered.slice(0, 5).map(s =>
      `  ${s.name || s.firstMessage?.slice(0, 30) || '未命名'} (${s.projectName}) [${s.sessionId.slice(0, 8)}]`
    ).join('\n')
    return `多个对话匹配:\n${list}\n\n请用更精确的名称`
  }

  return `未找到 "${args}"\n发 /attach 查看所有可用对话`
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
  // /new <名称> [项目]
  if (!args) return '用法: /new <对话名称> [项目名]'

  const old = archiveBinding(groupId)
  const parts = args.split(/\s+/)
  const sessionName = parts[0]
  const projectHint = parts[1] || (old ? path.basename(old.cwd) : sessionName)

  const resolved = resolvePath(projectHint, config)
  const validation = validatePath(resolved, config)
  if (!validation.valid) return `❌ ${validation.error}`

  try {
    const cliVersion = getClaudeVersion()
    const { sessionId } = await createSession(validation.resolvedPath, config.defaultPermissionMode, sessionName)

    register(sessionName, sessionId, validation.resolvedPath)
    const binding = createBinding(groupId, sessionId, validation.resolvedPath, config.defaultPermissionMode, cliVersion)

    const lines = ['✅ 新对话已创建']
    if (old) lines.push(`旧对话仍可通过 /attach 恢复`)
    lines.push(
      `📛 ${sessionName}`,
      `📁 ${path.basename(validation.resolvedPath)}`,
      `⚙️ 模式: ${binding.permissionMode}`,
      '',
      `回到电脑: im2cc open ${sessionName}`,
    )
    return lines.join('\n')
  } catch (err) {
    return `❌ 创建失败: ${err instanceof Error ? err.message : String(err)}`
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
