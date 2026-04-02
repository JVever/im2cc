/**
 * @input:    用户消息文本, Im2ccConfig, Binding
 * @output:   parseCommand(), handleCommand(), renderRegisteredSessionList(), renderLocalRegisteredSessionList() — 命令解析与执行、IM/本地列表渲染（含 /fc 双参数注册模式、/fqon /fqoff /fqs）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import path from 'node:path'
import type { Im2ccConfig } from './config.js'
import type { TransportType } from './transport.js'
import { validatePath, resolvePath, listProjects, isValidSessionName } from './security.js'
import { createBinding, getBinding, archiveBinding, archiveBindingsBySession, updateBinding, type Binding } from './session.js'
import { getDriver, hasDriver, type ToolId } from './tool-driver.js'
import { handleStop, getQueueStatus } from './queue.js'
import { discoverSessions, findSession, syncDriftedSession } from './discover.js'
import { register, lookup, lookupBySessionId, search, listRegistered, touch, remove, updateRegistry } from './registry.js'
import { buildSessionStatus } from './status.js'
import { log } from './logger.js'
import { isBestEffortTool, supportedToolChoices, supportedToolList } from './support-policy.js'
import { resumeCommand } from './tool-cli-args.js'
import type { RegisteredSession } from './registry.js'
import { hasCustomClaudeLauncher } from './claude-launcher.js'
import {
  enableAntiPomodoro,
  formatAntiPomodoroRemoteOffDenied,
  formatAntiPomodoroStatus,
  getAntiPomodoroSnapshot,
} from './anti-pomodoro.js'

export interface ParsedCommand {
  command: string
  args: string
}

function validateSessionProjectPath(rawPath: string, config: Im2ccConfig): { ok: true, resolvedPath: string } | { ok: false, message: string } {
  const validation = validatePath(rawPath, config)
  if (!validation.valid) {
    return {
      ok: false,
      message: `❌ ${validation.error}\n如需继续，请先调整路径白名单后再接入这个对话。`,
    }
  }
  return { ok: true, resolvedPath: validation.resolvedPath }
}

// 统一命令名：电脑端和飞书端尽量保持一致；/help 仅作兼容别名保留
const COMMANDS = new Set(['fn', 'fc', 'fl', 'fk', 'fs', 'fd', 'mode', 'stop', 'help', 'fhelp', 'fqon', 'fqoff', 'fqs'])

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
    case 'mode': return handleMode(cmd.args, conversationId, config)
    case 'stop': return handleStop(conversationId)
    case 'fqon': return handleFqOn()
    case 'fqoff': return handleFqOff()
    case 'fqs': return handleFqStatus()
    case 'fhelp':
    case 'help': return handleHelp()
    default: return `未知命令: /${cmd.command}`
  }
}

async function handleFn(args: string, conversationId: string, config: Im2ccConfig, transport: TransportType = 'feishu'): Promise<string> {
  if (!args) {
    const projects = listProjects(config)
    if (projects.length === 0) {
      return [
        '❌ 当前没有可用项目',
        `请先确认项目位于这些目录下: ${config.pathWhitelist.join(', ')}`,
        '如果这是第一次使用，更推荐先在电脑终端运行 fn <名称> <项目路径> 创建第一个对话。',
      ].join('\n')
    }
    const list = projects.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
    return `📁 可用项目:\n${list}\n\nIM 端创建用法: /fn <对话名称> <项目名> [--tool ${supportedToolChoices()}]\n例如: /fn auth-refactor im2cc --tool codex\n\n首次使用更推荐先在电脑终端运行 fn <名称> 创建第一个对话。`
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
  if (!sessionName) return `用法: /fn <对话名称> [项目名] [--tool ${supportedToolChoices()}]`
  if (!isValidSessionName(sessionName)) {
    return `❌ 名称 "${sessionName}" 不合法\n只允许字母、数字、连字符和下划线`
  }
  const projectHint = argParts[1]
  if (!projectHint) {
    const projects = listProjects(config)
    if (projects.length === 0) {
      return [
        '❌ 缺少项目名',
        `当前白名单目录下没有可用项目: ${config.pathWhitelist.join(', ')}`,
        '如果这是第一次使用，请先在电脑终端运行 fn <名称> <项目路径> 创建第一个对话。',
      ].join('\n')
    }
    const list = projects.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
    return `请指定项目名。\n\n📁 可用项目:\n${list}\n\n用法: /fn <对话名称> <项目名> [--tool ${supportedToolChoices()}]\n例如: /fn ${sessionName} ${projects[0]}`
  }

  // 检查 driver 是否可用
  if (!hasDriver(tool)) {
    return `❌ 工具 "${tool}" 未注册\n当前可用: ${supportedToolList()}`
  }
  const driver = getDriver(tool)
  if (!driver.isAvailable()) {
    return `❌ ${tool} 未安装或不可用\n请先安装 ${tool} CLI`
  }

  if (tool === 'claude' && hasCustomClaudeLauncher(config)) {
    return [
      '❌ 当前机器已启用本地 Claude 渠道选择器，不能在 IM 端直接创建 Claude 对话。',
      '请回到电脑终端运行 fn <名称> 创建，这样才能先选择渠道。',
      '如果要在 IM 端创建，请改用 /fn <名称> <项目名> --tool codex 或 --tool gemini。',
    ].join('\n')
  }

  const resolved = resolvePath(projectHint, config)
  const validation = validatePath(resolved, config)
  if (!validation.valid) return `❌ ${validation.error}`

  log(`[${conversationId}] 创建新对话 "${sessionName}" [${tool}] → ${validation.resolvedPath}`)

  try {
    const cliVersion = driver.getVersion()
    const defaultMode = getDefaultMode(tool, config)
    const { sessionId } = await driver.createSession(validation.resolvedPath, defaultMode, sessionName)

    register(sessionName, sessionId, validation.resolvedPath, tool)

    const binding = createBinding(conversationId, sessionId, validation.resolvedPath, defaultMode, cliVersion, transport, tool)
    const supportNote = isBestEffortTool(tool) ? '\n⚠️ Gemini 为 best-effort 支持' : ''

    return [
      `✅ 新对话 "${sessionName}"${tool !== 'claude' ? ` [${tool}]` : ''}`,
      `📁 ${path.basename(validation.resolvedPath)}`,
      `⚙️ 模式: ${binding.permissionMode}`,
      supportNote,
      '',
      `回到电脑: im2cc open ${sessionName}`,
    ].filter(Boolean).join('\n')
  } catch (err) {
    return `❌ 创建失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

function describeBoundSession(binding: Binding): string {
  const registered = lookupBySessionId(binding.sessionId)
  const tool = toolDisplayName(registered?.tool ?? binding.tool ?? 'claude')
  const project = path.basename(binding.cwd)
  const sessionLabel = registered?.name ? `「${registered.name}」` : `session ${binding.sessionId.slice(0, 8)}`
  return `${tool} 对话${sessionLabel}${project ? ` (${project})` : ''}`
}

function formatFcAlreadyConnectedMessage(existing: Binding, requestedTarget: string): string {
  const current = describeBoundSession(existing)
  const retryCommand = requestedTarget ? `/fc ${requestedTarget}` : '/fc <名称>'
  const requestedLabel = requestedTarget ? `「${requestedTarget}」` : '新的对话'
  return [
    `当前聊天已连接到 ${current}。`,
    `如需切换到${requestedLabel}，请先发送 /fd 断开当前连接，再发送 ${retryCommand}。`,
  ].join('\n')
}

async function handleFc(args: string, conversationId: string, config: Im2ccConfig, transport: TransportType = 'feishu'): Promise<string> {
  const existing = getBinding(conversationId)
  if (existing) {
    const requestedTarget = args ? args.split(/\s+/)[0] ?? '' : ''
    return formatFcAlreadyConnectedMessage(existing, requestedTarget)
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
async function connectToRegistered(
  reg: { name: string; sessionId: string; cwd: string; permissionMode?: string; tool?: ToolId },
  conversationId: string,
  config: Im2ccConfig,
  transport: TransportType = 'feishu',
): Promise<string> {
  const tool = (reg.tool ?? 'claude') as ToolId
  const pathCheck = validateSessionProjectPath(reg.cwd, config)
  if (!pathCheck.ok) return pathCheck.message
  reg = { ...reg, cwd: pathCheck.resolvedPath }

  // 断开前同步：在 killLocalSession 之前检查 session 是否漂移
  if (tool === 'claude' || tool === 'codex') {
    const allNames = listRegistered()
    const synced = syncDriftedSession(reg.name, reg.sessionId, reg.cwd, allNames, tool)
    if (synced) {
      log(`[${conversationId}] pre-disconnect sync: ${reg.name} ${reg.sessionId.slice(0, 8)} → ${synced.slice(0, 8)}`)
      register(reg.name, synced, reg.cwd, tool)
      reg = { ...reg, sessionId: synced }
    }
  }

  register(reg.name, reg.sessionId, reg.cwd, tool)

  const killed = getDriver(tool).killLocalSession(reg.name, tool)
  archiveBindingsBySession(reg.sessionId, conversationId)
  const driver = getDriver(tool)
  const cliVersion = driver.getVersion()
  touch(reg.name)
  const mode = reg.permissionMode
    ? migrateLegacyMode(reg.permissionMode, tool)
    : getDefaultMode(tool, config)
  const binding = createBinding(conversationId, reg.sessionId, reg.cwd, mode, cliVersion, transport, tool)
  log(`[${conversationId}] attach → "${reg.name}" (${reg.sessionId})${killed ? ' [已关闭本地进程]' : ''}`)

  const header = killed ? '已接入（已关闭电脑端）' : '已接入'

  const status = await buildSessionStatus(binding)
  return `${header}\n${status}`
}

/** 接入通过文件系统发现的对话（自动注册） */
async function connectToDiscovered(
  name: string,
  session: { sessionId: string; name: string; projectPath: string; projectName: string },
  conversationId: string,
  config: Im2ccConfig,
  transport: TransportType = 'feishu',
): Promise<string> {
  const pathCheck = validateSessionProjectPath(session.projectPath, config)
  if (!pathCheck.ok) return pathCheck.message
  const driver = getDriver('claude')  // discovered sessions 目前只支持 claude
  const cliVersion = driver.getVersion()
  archiveBindingsBySession(session.sessionId, conversationId)
  const defaultMode = getDefaultMode('claude', config)
  const binding = createBinding(conversationId, session.sessionId, pathCheck.resolvedPath, defaultMode, cliVersion, transport, 'claude')
  register(name, session.sessionId, pathCheck.resolvedPath, 'claude')
  log(`[${conversationId}] attach (discovered) → "${name}" (${session.sessionId})`)

  const status = await buildSessionStatus(binding)
  return `已接入\n${status}`
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

import { getToolModes, migrateLegacyMode, resolveMode, type ModeInfo } from './mode-policy.js'
import { setDefaultMode, getDefaultMode } from './config.js'

/** 格式化模式列表（● 当前 / ○ 其他），显示别名 */
function formatModeList(modes: ModeInfo[], currentMode: string): string {
  return modes.map(m => {
    const marker = m.id === currentMode ? '●' : '○'
    return `${marker} ${m.alias} → ${m.id}\n  ${m.label} — ${m.description}\n  ${m.detail}`
  }).join('\n\n')
}

function handleMode(args: string, conversationId: string, config: Im2ccConfig): string {
  const binding = getBinding(conversationId)
  if (!binding) return '该群未绑定，请先 /fc 或 /fn'

  const regEntry = listRegistered().find(r => r.sessionId === binding.sessionId)
  const tool = (regEntry?.tool ?? binding.tool ?? 'claude') as ToolId
  const modes = getToolModes(tool)
  const toolName = tool === 'claude' ? 'Claude Code' : tool.charAt(0).toUpperCase() + tool.slice(1)
  const modeListUsage = '直接发送 /mode 查看可用模式'
  const modeSwitchUsage = '/mode <模式别名>（例如 /mode au）'
  const modeDefaultUsage = '/mode default <模式别名>'

  // 当前模式：迁移旧名到原生名
  const currentMode = migrateLegacyMode(binding.permissionMode, tool)

  // /mode — 展示当前模式 + 所有可用模式
  if (!args) {
    if (modes.length === 0) return `${toolName} 暂无可配置的模式`
    return [
      `当前模式: ${currentMode}`,
      '',
      `${toolName} 可用模式:`,
      '',
      formatModeList(modes, currentMode),
      '',
      `${modeListUsage} 查看可用模式`,
      modeSwitchUsage,
      `${modeDefaultUsage} 设为新建会话默认模式`,
    ].join('\n')
  }

  const parts = args.split(/\s+/)

  const availableHint = modes.map(m => `${m.alias}/${m.id}`).join(', ')

  // /mode default <name> — 设置默认模式
  if (parts[0] === 'default') {
    const modeInput = parts[1]
    if (!modeInput) {
      const current = getDefaultMode(tool, config)
      return `${toolName} 当前默认模式: ${current}\n\n用法: ${modeDefaultUsage}`
    }
    const resolved = resolveMode(tool, modeInput)
    if (!resolved) {
      return `"${modeInput}" 不是 ${toolName} 的有效模式\n可用: ${availableHint}`
    }
    setDefaultMode(tool, resolved)
    return `${toolName} 默认模式已设为 ${resolved}\n新建 ${toolName} 会话时将使用此模式`
  }

  // /mode <name> — 切换当前会话模式
  const resolved = resolveMode(tool, parts[0])
  if (!resolved) {
    return `"${parts[0]}" 不是 ${toolName} 的有效模式\n可用: ${availableHint}`
  }

  updateBinding(conversationId, { permissionMode: resolved })
  if (regEntry) {
    updateRegistry(regEntry.name, { permissionMode: resolved })
  }

  const modeInfo = modes.find(m => m.id === resolved)
  return `模式已切换为 ${resolved}（${modeInfo?.label}）\n下一条消息生效`
}

function toolDisplayName(tool: string): string {
  switch (tool) {
    case 'claude': return 'Claude'
    case 'codex': return 'Codex'
    case 'gemini': return 'Gemini'
    default: return tool
  }
}

function toolDisplayOrder(tool: string): number {
  switch (tool) {
    case 'claude': return 0
    case 'codex': return 1
    case 'gemini': return 2
    default: return 99
  }
}

function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += /[^\u0000-\u00ff]/.test(char) ? 2 : 1
  }
  return width
}

function padDisplay(text: string, targetWidth: number): string {
  const padding = Math.max(0, targetWidth - displayWidth(text))
  return text + ' '.repeat(padding)
}

export function renderRegisteredSessionList(registered: RegisteredSession[]): string {
  // 按工具分组，组内按字母序，并保留项目 basename 方便在手机端区分
  const byTool = new Map<string, Array<{ name: string, cwdBase: string }>>()
  for (const s of registered) {
    const tool = s.tool || 'claude'
    if (!byTool.has(tool)) byTool.set(tool, [])
    byTool.get(tool)!.push({ name: s.name, cwdBase: path.basename(s.cwd) })
  }
  for (const sessions of byTool.values()) {
    sessions.sort((a, b) => a.name.localeCompare(b.name))
  }

  const sections: string[] = []
  const orderedTools = [...byTool.keys()].sort((a, b) => {
    const orderDelta = toolDisplayOrder(a) - toolDisplayOrder(b)
    return orderDelta !== 0 ? orderDelta : a.localeCompare(b)
  })
  for (const tool of orderedTools) {
    const sessions = byTool.get(tool)!
    sections.push(`── ${toolDisplayName(tool)} ──\n${sessions.map(s => `  ${s.name} (${s.cwdBase})`).join('\n')}`)
  }
  return `📋 已注册的对话 (${registered.length}):\n${sections.join('\n')}`
}

interface RenderLocalRegisteredSessionListOptions {
  activeBindings?: Binding[]
  hasLocalWindow?: (session: RegisteredSession) => boolean
}

function transportStatusLabel(transport: string | undefined): string | null {
  switch (transport) {
    case 'feishu':
      return '飞书'
    case 'wechat':
      return '微信'
    default:
      return null
  }
}

export function renderLocalRegisteredSessionList(
  registered: RegisteredSession[],
  options: RenderLocalRegisteredSessionListOptions = {},
): string {
  const activeBindings = options.activeBindings ?? []
  const hasLocalWindow = options.hasLocalWindow ?? (() => false)
  const bindingsBySessionId = new Map<string, Binding[]>()

  for (const binding of activeBindings) {
    const list = bindingsBySessionId.get(binding.sessionId) ?? []
    list.push(binding)
    bindingsBySessionId.set(binding.sessionId, list)
  }

  const byTool = new Map<string, Array<{ name: string, cwdBase: string, status: string }>>()
  let nameWidth = 0
  let projectLabelWidth = 0

  for (const session of registered) {
    const tool = session.tool || 'claude'
    const cwdBase = path.basename(session.cwd)
    const labels: string[] = []
    const seenLabels = new Set<string>()
    const pushLabel = (label: string | null) => {
      if (!label || seenLabels.has(label)) return
      seenLabels.add(label)
      labels.push(label)
    }

    for (const binding of bindingsBySessionId.get(session.sessionId) ?? []) {
      pushLabel(transportStatusLabel(binding.transport))
    }
    if (hasLocalWindow(session)) pushLabel('电脑')

    nameWidth = Math.max(nameWidth, displayWidth(session.name))
    projectLabelWidth = Math.max(projectLabelWidth, displayWidth(`(${cwdBase})`))

    const rows = byTool.get(tool) ?? []
    rows.push({ name: session.name, cwdBase, status: labels.join(' ') })
    byTool.set(tool, rows)
  }

  for (const rows of byTool.values()) {
    rows.sort((a, b) => a.name.localeCompare(b.name))
  }

  const sections: string[] = []
  const orderedTools = [...byTool.keys()].sort((a, b) => {
    const orderDelta = toolDisplayOrder(a) - toolDisplayOrder(b)
    return orderDelta !== 0 ? orderDelta : a.localeCompare(b)
  })

  for (const tool of orderedTools) {
    const rows = byTool.get(tool) ?? []
    const lines = rows.map(row => {
      const projectLabel = `(${row.cwdBase})`
      const base = `  ${padDisplay(row.name, nameWidth)}  ${padDisplay(projectLabel, projectLabelWidth)}`
      return row.status ? `${base}  ${row.status}` : base.trimEnd()
    })
    sections.push(`── ${toolDisplayName(tool)} ──\n${lines.join('\n')}`)
  }

  return `已注册的对话 (${registered.length})\n\n${sections.join('\n')}`
}

function handleFl(): string {
  const registered = listRegistered()
  if (registered.length === 0) {
    return [
      '还没有已注册的对话。',
      '首次使用：请先在电脑终端运行 fn <名称> 创建第一个对话。',
      '如果你用的是 Codex 或 Gemini，也可以运行 fn-codex <名称> 或 fn-gemini <名称>。',
      '创建完成后，回到这里发送 /fc <名称> 接入。',
    ].join('\n')
  }

  return renderRegisteredSessionList(registered)
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
    : resumeCommand((session.tool ?? 'claude') as ToolId, session.sessionId)
  return [
    `✅ 已终止 "${args}"`,
    `如需恢复: ${toolHint}`,
  ].join('\n')
}


async function handleFs(conversationId: string): Promise<string> {
  const binding = getBinding(conversationId)
  if (!binding) return '该群未绑定任何 session'
  return buildSessionStatus(binding)
}

function handleFqOn(): string {
  return enableAntiPomodoro().message
}

function handleFqOff(): string {
  return formatAntiPomodoroRemoteOffDenied(getAntiPomodoroSnapshot())
}

function handleFqStatus(): string {
  return formatAntiPomodoroStatus(getAntiPomodoroSnapshot())
}

export function renderUnifiedHelp(): string {
  return [
    '📖 im2cc 帮助',
    '',
    '首次使用：先在电脑终端运行 fn <名称> 创建第一个对话，再回到飞书或微信发送 /fc <名称> 接入。',
    '',
    '电脑终端：',
    'fhelp                    — 查看帮助',
    'im2cc onboard            — 查看首次安装引导',
    'im2cc upgrade            — 升级到最新版本',
    'fn <名称>                — 用当前目录创建对话',
    'fn-codex <名称>          — 用当前目录创建 Codex 对话',
    'fn-gemini <名称>         — 用当前目录创建 Gemini 对话',
    'fc <名称>                — 把对话接回电脑',
    'fl                       — 查看所有对话',
    'fk <名称>                — 终止对话',
    'fd                       — 断开当前对话',
    'fs <名称>                — 查看对话状态',
    'fqon                     — 开启反茄钟',
    'fqoff                    — 关闭反茄钟',
    'fqs                      — 查看反茄钟状态',
    '',
    '飞书 / 微信：',
    '/fhelp                   — 查看帮助',
    '/fc <名称>               — 接入已有对话',
    '/fl                      — 列出所有对话',
    '/fk <名称>               — 终止对话',
    '/fd                      — 断开当前对话',
    '/fs                      — 查看当前状态',
    '/mode                    — 查看可用模式',
    '/mode <模式别名>         — 切换模式（例如 /mode au）',
    '/stop                    — 中断当前执行',
    '/fqon                    — 开启反茄钟',
    '/fqs                     — 查看反茄钟状态',
    '/fqoff                   — 仅提示需回到电脑端关闭',
    '',
    '直接发消息即转给当前接入的 AI 工具',
    '',
    '飞书支持发送图片或文件；发送后再补一条指令即可让当前接入的 AI 工具分析。',
    '微信当前以纯文本对话为主。',
  ].join('\n')
}

function handleHelp(): string {
  return renderUnifiedHelp()
}
