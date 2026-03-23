/**
 * @input:    用户消息文本, Im2ccConfig, Binding
 * @output:   parseCommand(), handleCommand() — 命令解析与执行（含 /fc 双参数注册模式）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import path from 'node:path'
import type { Im2ccConfig } from './config.js'
import type { TransportType } from './transport.js'
import { validatePath, resolvePath, listProjects, isValidSessionName } from './security.js'
import { createBinding, getBinding, archiveBinding, archiveBindingsBySession, updateBinding } from './session.js'
import { getDriver, hasDriver, type ToolId } from './tool-driver.js'
import { handleStop, getQueueStatus } from './queue.js'
import { discoverSessions, findSession } from './discover.js'
import { register, lookup, search, listRegistered, touch, remove, updateRegistry } from './registry.js'
import { log } from './logger.js'

export interface ParsedCommand {
  command: string
  args: string
}

// 统一命令名：电脑端和飞书端完全一致
const COMMANDS = new Set(['fn', 'fc', 'fl', 'fk', 'fs', 'fd', 'mode', 'stop', 'help'])

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/)
  if (!cmd || !COMMANDS.has(cmd.toLowerCase())) return null
  return { command: cmd.toLowerCase(), args: rest.join(' ').trim() }
}

export async function handleCommand(
  cmd: ParsedCommand,
  conversationId: string,
  config: Im2ccConfig,
  transport: TransportType = 'feishu',
): Promise<string> {
  switch (cmd.command) {
    case 'fn': return handleFn(cmd.args, conversationId, config, transport)
    case 'fc': return handleFc(cmd.args, conversationId, config, transport)
    case 'fl': return handleFl()
    case 'fk': return handleFk(cmd.args, conversationId)
    case 'fs': return handleFs(conversationId)
    case 'fd': return handleFd(conversationId)
    case 'mode': return handleMode(cmd.args, conversationId)
    case 'stop': return handleStop(conversationId)
    case 'help': return handleHelp()
    default: return `未知命令: /${cmd.command}`
  }
}

async function handleFn(args: string, conversationId: string, config: Im2ccConfig, transport: TransportType = 'feishu'): Promise<string> {
  if (!args) {
    const projects = listProjects(config)
    if (projects.length === 0) return `${config.pathWhitelist.join(', ')} 下没有找到项目目录`
    const list = projects.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
    return `📁 可用项目:\n${list}\n\n用法: /fn <对话名称> [项目名] [--tool codex]\n例如: /fn auth-refactor im2cc`
  }

  const existing = getBinding(conversationId)
  if (existing) {
    return `该群已连接到 "${path.basename(existing.cwd)}"\n先 /fd 再操作`
  }

  // 解析 --tool 参数
  let tool: ToolId = 'claude'
  const argParts = args.split(/\s+/)
  const toolIdx = argParts.indexOf('--tool')
  if (toolIdx !== -1 && argParts[toolIdx + 1]) {
    tool = argParts[toolIdx + 1] as ToolId
    argParts.splice(toolIdx, 2)
  }

  const sessionName = argParts[0]
  if (!sessionName) return '用法: /fn <对话名称> [项目名] [--tool codex]'
  if (!isValidSessionName(sessionName)) {
    return `❌ 名称 "${sessionName}" 不合法\n只允许字母、数字、连字符和下划线`
  }
  const projectHint = argParts[1] || sessionName

  // 检查 driver 是否可用
  if (!hasDriver(tool)) {
    return `❌ 工具 "${tool}" 未注册\n当前可用: claude`
  }
  const driver = getDriver(tool)
  if (!driver.isAvailable()) {
    return `❌ ${tool} 未安装或不可用\n请先安装 ${tool} CLI`
  }

  const resolved = resolvePath(projectHint, config)
  const validation = validatePath(resolved, config)
  if (!validation.valid) return `❌ ${validation.error}`

  log(`[${conversationId}] 创建新对话 "${sessionName}" [${tool}] → ${validation.resolvedPath}`)

  try {
    const cliVersion = driver.getVersion()
    const { sessionId } = await driver.createSession(validation.resolvedPath, config.defaultPermissionMode, sessionName)

    register(sessionName, sessionId, validation.resolvedPath, tool)

    const binding = createBinding(conversationId, sessionId, validation.resolvedPath, config.defaultPermissionMode, cliVersion, transport, tool)

    return [
      `✅ 新对话 "${sessionName}"${tool !== 'claude' ? ` [${tool}]` : ''}`,
      `📁 ${path.basename(validation.resolvedPath)}`,
      `⚙️ 模式: ${binding.permissionMode}`,
      '',
      `回到电脑: im2cc open ${sessionName}`,
    ].join('\n')
  } catch (err) {
    return `❌ 创建失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleFc(args: string, conversationId: string, config: Im2ccConfig, transport: TransportType = 'feishu'): Promise<string> {
  const existing = getBinding(conversationId)
  if (existing) {
    return `该群已连接，先 /fd 再 /fc`
  }

  const parts = args ? args.split(/\s+/) : []

  // 无参数：列出注册表 + 最近发现的对话
  if (parts.length === 0) {
    return listAvailableSessions()
  }

  // 双参数模式: /fc <新名称> <session-query>
  // 注册一个未注册的对话并接入
  if (parts.length >= 2) {
    return handleFcRegisterAndConnect(parts[0], parts.slice(1).join(' '), conversationId, config, transport)
  }

  // 单参数模式: /fc <名称>
  const query = parts[0]

  // 优先从注册表查找
  const reg = lookup(query)
  if (reg) {
    return connectToRegistered(reg, conversationId, config, transport)
  }

  // 注册表没有，尝试模糊搜索注册表
  const regMatches = search(query)
  if (regMatches.length > 0) {
    const list = regMatches.map(s => `  ${s.name} (${path.basename(s.cwd)})`).join('\n')
    return `多个匹配:\n${list}\n\n请输入更精确的名称`
  }

  // 最后尝试文件系统扫描（单参数时用 query 作为注册名）
  const discovered = await findSession(query)
  if (discovered.length === 1) {
    return connectToDiscovered(query, discovered[0], conversationId, config, transport)
  }

  if (discovered.length > 1) {
    const list = discovered.slice(0, 5).map(s =>
      `  ${s.name || s.firstMessage?.slice(0, 30) || '未命名'} (${s.projectName}) [${s.sessionId.slice(0, 8)}]`
    ).join('\n')
    return `多个对话匹配:\n${list}\n\n请用更精确的名称，或 /fc <新名称> <ID前缀> 指定`
  }

  return `未找到 "${query}"\n发 /fc 查看所有可用对话`
}

/** /fc 无参数：列出已注册 + 未注册对话 */
async function listAvailableSessions(): Promise<string> {
  const registered = listRegistered()
  const lines: string[] = []

  if (registered.length > 0) {
    lines.push('📋 已注册的对话:')
    for (const s of registered) {
      lines.push(`  ${s.name} (${path.basename(s.cwd)})`)
    }
    lines.push('')
  }

  // 文件系统扫描发现未注册的对话
  const discovered = await discoverSessions(12)
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

  lines.push('/fc <名称> 接入已注册对话')
  if (unregistered.length > 0) {
    lines.push('/fc <新名称> <ID前缀> 注册并接入')
  }
  return lines.join('\n')
}

/** 接入已注册对话 */
function connectToRegistered(
  reg: { name: string; sessionId: string; cwd: string; permissionMode?: string; tool?: ToolId },
  conversationId: string,
  config: Im2ccConfig,
  transport: TransportType = 'feishu',
): string {
  const tool = (reg.tool ?? 'claude') as ToolId
  const killed = getDriver(tool).killLocalSession(reg.name, tool)
  archiveBindingsBySession(reg.sessionId, conversationId)
  const driver = getDriver(tool)
  const cliVersion = driver.getVersion()
  touch(reg.name)
  const mode = reg.permissionMode ?? config.defaultPermissionMode
  const binding = createBinding(conversationId, reg.sessionId, reg.cwd, mode, cliVersion, transport, tool)
  log(`[${conversationId}] attach → "${reg.name}" (${reg.sessionId})${killed ? ' [已关闭本地进程]' : ''}`)

  const modeWarning = binding.permissionMode === 'YOLO'
    ? '⚠️ 当前为 YOLO 模式（自动执行所有操作）\n   切换: /mode default'
    : `⚙️ 模式: ${binding.permissionMode}`

  return [
    `✅ 已接入 "${reg.name}"`,
    killed ? '🔄 已关闭电脑端的对话' : '',
    `📁 ${path.basename(reg.cwd)}`,
    modeWarning,
    '',
    `回到电脑: im2cc open ${reg.name}`,
  ].filter(Boolean).join('\n')
}

/** 接入通过文件系统发现的对话（自动注册） */
function connectToDiscovered(
  name: string,
  session: { sessionId: string; name: string; projectPath: string; projectName: string },
  conversationId: string,
  config: Im2ccConfig,
  transport: TransportType = 'feishu',
): string {
  const driver = getDriver('claude')  // discovered sessions 目前只支持 claude
  const cliVersion = driver.getVersion()
  archiveBindingsBySession(session.sessionId, conversationId)
  const binding = createBinding(conversationId, session.sessionId, session.projectPath, config.defaultPermissionMode, cliVersion, transport, 'claude')
  register(name, session.sessionId, session.projectPath, 'claude')
  log(`[${conversationId}] attach (discovered) → "${name}" (${session.sessionId})`)

  const modeWarning = binding.permissionMode === 'YOLO'
    ? '⚠️ 当前为 YOLO 模式（自动执行所有操作）\n   切换: /mode default'
    : `⚙️ 模式: ${binding.permissionMode}`

  return [
    `✅ 已接入 "${session.name || name}"`,
    `📁 ${session.projectName}`,
    modeWarning,
    '',
    `回到电脑: im2cc open ${name}`,
  ].join('\n')
}

/** /fc <新名称> <session-query> — 注册未注册对话并接入 */
async function handleFcRegisterAndConnect(
  name: string,
  sessionQuery: string,
  conversationId: string,
  config: Im2ccConfig,
  transport: TransportType = 'feishu',
): Promise<string> {
  if (!isValidSessionName(name)) {
    return `❌ 名称 "${name}" 不合法\n只允许字母、数字、连字符和下划线`
  }

  // 检查名称是否已被占用
  const existingReg = lookup(name)
  if (existingReg) {
    return `"${name}" 已注册，请用其他名称\n或直接 /fc ${name} 接入已有对话`
  }

  // 搜索对话
  const discovered = await findSession(sessionQuery)
  if (discovered.length === 0) {
    return `未找到匹配 "${sessionQuery}" 的对话\n发 /fc 查看所有可用对话`
  }
  if (discovered.length > 1) {
    const list = discovered.slice(0, 5).map(s =>
      `  ${s.name || s.firstMessage?.slice(0, 30) || '未命名'} (${s.projectName}) [${s.sessionId.slice(0, 8)}]`
    ).join('\n')
    return `"${sessionQuery}" 匹配到多个对话:\n${list}\n\n请用更精确的 ID 前缀`
  }

  // 检查该 session 是否已被其他名称注册
  const allRegistered = listRegistered()
  const alreadyRegistered = allRegistered.find(r => r.sessionId === discovered[0].sessionId)
  if (alreadyRegistered) {
    return `该对话已注册为 "${alreadyRegistered.name}"\n直接 /fc ${alreadyRegistered.name} 接入`
  }

  return connectToDiscovered(name, discovered[0], conversationId, config, transport)
}

function handleFd(conversationId: string): string {
  const binding = archiveBinding(conversationId)
  if (!binding) return '该群未绑定任何 session'

  // 查找注册名称，给出正确的 fc 提示
  const regEntry = listRegistered().find(r => r.sessionId === binding.sessionId)
  const hint = regEntry ? `回到电脑: fc ${regEntry.name}` : '回到电脑后用 fc <名称> 接回'
  return [
    '✅ 已解绑',
    hint,
  ].join('\n')
}

// plan 模式不适合飞书端：-p 非交互模式下 Claude 无法提问/获取反馈，
// 需要规划时用自然语言让 Claude "先计划后执行" 更可靠
const MODE_MAP: Record<string, string> = {
  'yolo': 'YOLO',
  'default': 'default',
  'auto-edit': 'auto-edit',
}

// YOLO 模式映射到 Claude CLI 的实际参数
export const MODE_TO_CLI: Record<string, string> = {
  'YOLO': 'dangerouslySkipPermissions',
  'default': 'default',
  'auto-edit': 'acceptEdits',
}

function handleMode(args: string, conversationId: string): string {
  const normalized = MODE_MAP[args.toLowerCase()]
  if (!args || !normalized) {
    return '用法: /mode <模式>\n\n' +
      '  YOLO — 自动执行所有操作（默认）\n' +
      '  default — 需要确认才执行\n' +
      '  auto-edit — 自动编辑，其他需确认\n\n' +
      '💡 需要 Claude 先规划再执行？直接说"先给我计划，确认后再做"'
  }

  const binding = getBinding(conversationId)
  if (!binding) return '该群未绑定，请先 /fc 或 /fn'

  updateBinding(conversationId, { permissionMode: normalized })

  // 同步更新 registry，下次 /fc 接入时记住此模式
  const regEntry = listRegistered().find(r => r.sessionId === binding.sessionId)
  if (regEntry) {
    updateRegistry(regEntry.name, { permissionMode: normalized })
  }

  return `⚙️ 模式已切换为 ${normalized}（下一条消息生效）`
}

function handleFl(): string {
  const registered = listRegistered()
  if (registered.length === 0) return '没有已注册的对话。用 /fn <名称> 创建。'

  const lines = registered.map(s => {
    const toolTag = s.tool && s.tool !== 'claude' ? ` [${s.tool}]` : ''
    return `  ${s.name} (${path.basename(s.cwd)})${toolTag}`
  })
  return `📋 已注册的对话:\n${lines.join('\n')}`
}

function handleFk(args: string, conversationId: string): string {
  if (!args) return '用法: /fk <名称>'

  const session = lookup(args)
  if (!session) return `未找到 "${args}"`

  // 关闭本地 tmux
  getDriver((session.tool ?? 'claude') as ToolId).killLocalSession(session.name, session.tool)

  // 归档所有绑定了这个 session 的端（跨 transport）
  archiveBindingsBySession(session.sessionId)

  remove(session.name)

  const toolHint = session.tool === 'claude'
    ? `claude --resume ${session.sessionId}`
    : `${session.tool} (session 已由 im2cc 管理)`
  return [
    `✅ 已终止 "${args}"`,
    `如需恢复: ${toolHint}`,
  ].join('\n')
}


function handleFs(conversationId: string): string {
  const binding = getBinding(conversationId)
  if (!binding) return '该群未绑定任何 session'

  const qs = getQueueStatus(conversationId)
  const projectName = path.basename(binding.cwd)

  // 查找注册名称，给出正确的 fc 提示
  const regEntry = listRegistered().find(r => r.sessionId === binding.sessionId)
  const sessionName = regEntry?.name ?? '(未注册)'
  const toolTag = regEntry?.tool && regEntry.tool !== 'claude' ? ` [${regEntry.tool}]` : ''
  const hint = regEntry ? `fc ${regEntry.name}` : `fc <名称>`

  return [
    `📊 ${sessionName}${toolTag} — ${projectName}`,
    `  目录: ${binding.cwd}`,
    `  模式: ${binding.permissionMode.toUpperCase()}`,
    `  轮次: ${binding.turnCount}`,
    `  状态: ${qs.state}${qs.queueLength > 0 ? ` (队列 ${qs.queueLength})` : ''}`,
    '',
    `  回到电脑: ${hint}`,
  ].join('\n')
}

function handleHelp(): string {
  return [
    '📖 im2cc 命令（电脑/飞书通用）',
    '',
    '/fn <名称> [项目]        — 创建新对话',
    '/fc [名称]               — 接入已有对话',
    '/fc <名称> <ID前缀>      — 注册并接入未注册对话',
    '/fl                      — 列出所有对话',
    '/fk <名称>               — 终止对话',
    '/fd                      — 断开当前对话',
    '/fs                      — 查看当前状态',
    '',
    '/mode <模式>             — 切换模式 (YOLO|default|auto-edit)',
    '/stop                    — 中断当前执行',
    '',
    '直接发消息即转给 Claude Code',
    '',
    '发送图片或文件，再发指令即可让 Claude 分析',
  ].join('\n')
}
