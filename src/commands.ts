/**
 * @input:    用户消息文本, Im2ccConfig, Binding
 * @output:   parseCommand(), handleCommand(), renderRegisteredSessionList(), renderLocalRegisteredSessionList() — 命令解析与执行、IM/本地列表渲染（含 /fc 双参数注册模式、/fqon /fqoff /fqs、/ls 工作区项目列表、/clear /compact /model 会话控制 alias 层、/btw side fork 旁路讨论；状态查看统一用 /fs）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import path from 'node:path'
import type { Im2ccConfig } from './config.js'
import type { OutgoingMessage, TransportType } from './transport.js'
import { textMessage } from './message-format.js'
import { validatePath, isValidSessionName } from './security.js'
import {
  listProjectIndex,
  resolveProjectHint,
  suggestProjectLabels,
  prettyPath,
} from './project-index.js'
import { createBinding, getBinding, archiveBinding, archiveBindingsBySession, updateBinding, type Binding } from './session.js'
import { getDriver, hasDriver, type ToolId } from './tool-driver.js'
import { handleStop, getQueueStatus, listInflightTasksForSession, enqueue } from './queue.js'
import { getModelCatalog, resolveModelInput, findShortNameByFullName, type ModelOption } from './model-catalog.js'
import { setPendingModelSelection, clearPendingModelSelection } from './model-pending.js'
import { discoverSessions, findSession, syncDriftedSession } from './discover.js'
import { register, registerWithMeta, lookup, lookupBySessionId, search, listRegistered, touch, remove, updateRegistry, updateSelectedModel } from './registry.js'
import { getModelSelectionSnapshotForBinding, getSelectedModelForBinding } from './session-model.js'
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
import { parseAt, parseIn, parseCron } from './schedule-parser.js'
import {
  addSchedule,
  cancelScheduleByName,
  getScheduleByName as getScheduledForSession,
  formatScheduleStatus,
  listAllSchedules,
  formatScheduleListLine,
} from './scheduler.js'
import type { Schedule } from './schedule-store.js'
import { MSG_LENGTH_LIMIT } from './transport.js'

export interface ParsedCommand {
  command: string
  args: string
}

function validateSessionProjectPath(rawPath: string): { ok: true, resolvedPath: string } | { ok: false, message: string } {
  const validation = validatePath(rawPath)
  if (!validation.valid) {
    return {
      ok: false,
      message: `❌ ${validation.error}\n项目目录可能已被移动或删除，请检查后重试。`,
    }
  }
  return { ok: true, resolvedPath: validation.resolvedPath }
}

// 统一命令名：电脑端和飞书端尽量保持一致；/help 仅作兼容别名保留
const COMMANDS = new Set(['fn', 'fc', 'fl', 'ls', 'fk', 'fs', 'fd', 'mode', 'stop', 'help', 'fhelp', 'fqon', 'fqoff', 'fqs', 'at', 'in', 'cron', 'clear', 'compact', 'model', 'btw'])

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
  sendReply?: (message: string | OutgoingMessage) => Promise<void>,
): Promise<string | OutgoingMessage> {
  switch (cmd.command) {
    case 'fn': return handleFn(cmd.args, conversationId, config, transport)
    case 'fc': return handleFc(cmd.args, conversationId, config, transport)
    case 'fl': return handleFl()
    case 'ls': return handleLs()
    case 'fk': return handleFk(cmd.args, conversationId)
    case 'fs': return handleFs(conversationId)
    case 'fd': return handleFd(conversationId)
    case 'mode': return handleMode(cmd.args, conversationId, config)
    case 'stop': return handleStop(conversationId)
    case 'clear': return handleClear(conversationId, config)
    case 'compact': return handleCompact(conversationId)
    case 'model': return handleModel(cmd.args, conversationId)
    case 'btw': return handleBtw(cmd.args, conversationId, sendReply)
    case 'fqon': return handleFqOn()
    case 'fqoff': return handleFqOff()
    case 'fqs': return handleFqStatus()
    case 'at': return handleScheduleSet('at', cmd.args, conversationId, transport)
    case 'in': return handleScheduleSet('in', cmd.args, conversationId, transport)
    case 'cron': return handleScheduleSet('cron', cmd.args, conversationId, transport)
    case 'fhelp':
    case 'help': return handleHelp()
    default: return `未知命令: /${cmd.command}`
  }
}

async function handleFn(args: string, conversationId: string, config: Im2ccConfig, transport: TransportType = 'feishu'): Promise<string | OutgoingMessage> {
  if (!args) {
    return renderFnUsage()
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
  if (!sessionName) return `用法: /fn <对话名> <项目目录> [--tool ${supportedToolChoices()}]`
  if (!isValidSessionName(sessionName)) {
    return `❌ 名称 "${sessionName}" 不合法\n只允许字母、数字、连字符和下划线`
  }
  const projectHint = argParts[1]
  if (!projectHint) {
    return renderFnMissingProject(sessionName)
  }

  // 先验证用户的输入（项目目录是否存在），再验证环境（driver 是否可用）。
  // 输入错误比环境问题更"浅"，优先反馈给用户更符合心智顺序。
  const outcome = resolveProjectHint(projectHint)
  if (outcome.kind === 'not_found') return renderFnProjectNotFound(projectHint)
  if (outcome.kind === 'ambiguous') return renderFnProjectAmbiguous(projectHint, outcome.matches ?? [])
  const validation = validatePath(outcome.cwd!)
  if (!validation.valid) return renderFnProjectNotFound(projectHint)

  // 检查 driver 是否注册
  if (!hasDriver(tool)) {
    return `❌ 工具 "${tool}" 未注册\n当前可用: ${supportedToolList()}`
  }

  // IM 端没有 TTY，无法弹渠道菜单。两种处理：
  //   - 配了 imDefaultClaudeProfile：用该 profile 非交互启动（launcher 读 IM2CC_CLAUDE_PROFILE 跳过选择）
  //   - 没配：保守拒绝，提示用户去电脑端创建或配置默认 profile
  // 这个检查放在 isAvailable 之前：launcher 存在本身说明用户期望用 claude，
  // 产品规则问题优先于环境问题反馈
  let claudeProfile: string | undefined
  if (tool === 'claude' && hasCustomClaudeLauncher(config)) {
    const imDefault = config.imDefaultClaudeProfile?.trim()
    if (!imDefault) {
      return [
        '❌ 当前机器已启用本地 Claude 渠道选择器，IM 端没有 TTY 无法弹菜单。',
        '',
        '两种解决方式：',
        '  ① 在电脑端配置一个 IM 默认渠道：打开 ~/.im2cc/config.json 加上',
        '       "imDefaultClaudeProfile": "official"',
        '     之后 IM 端 /fn 会用该 profile 非交互启动。',
        '  ② 回电脑终端运行 fn <名称>（可交互选渠道）。',
        '',
        '或在 IM 端改用 Codex / Gemini：',
        '  /fn <名称> <项目目录> --tool codex',
      ].join('\n')
    }
    claudeProfile = imDefault
  }

  const driver = getDriver(tool)
  if (!driver.isAvailable()) {
    return `❌ ${tool} 未安装或不可用\n请先安装 ${tool} CLI`
  }

  log(`[${conversationId}] 创建新对话 "${sessionName}" [${tool}] → ${validation.resolvedPath}${claudeProfile ? ` [profile=${claudeProfile}]` : ''}`)

  try {
    const cliVersion = driver.getVersion()
    const defaultMode = getDefaultMode(tool, config)
    const { sessionId } = await driver.createSession(validation.resolvedPath, defaultMode, sessionName, { claudeProfile })

    // 持久化 permissionMode + claudeProfile 到 registry（/fc 接入时 launcher 能复用）
    registerWithMeta(sessionName, sessionId, validation.resolvedPath, tool, { permissionMode: defaultMode, claudeProfile })

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

/** /fn 无参：教用户怎么用 */
function renderFnUsage(): OutgoingMessage {
  const lines = [
    '📝 创建新对话',
    '',
    '用法：/fn <对话名> <项目短名 | 完整路径>',
    '示例：/fn auth im2cc',
    '     /fn exp ~/Downloads/new-repo',
    '',
    '对话名　：给这次对话起的标签，以后用 /fc <对话名> 可以重连',
    '项目目录：短名=之前在电脑端用过的项目（/ls 可查看）；',
    '          全新项目请用完整路径（如 ~/Code/foo）',
    '',
    `已用过的项目：/ls`,
  ]
  return textMessage(lines.join('\n'))
}

/** /fn <对话名>：只给出创建新对话时最关键的缺项提示 */
function renderFnMissingProject(sessionName: string): OutgoingMessage {
  const lines = [
    '📝 缺少项目目录',
    '',
    '用法：/fn <对话名> <项目短名 | 完整路径>',
    `示例：/fn ${sessionName} im2cc`,
    `     /fn ${sessionName} ~/Downloads/new-repo`,
    '',
    '项目目录：短名=之前在电脑端用过的项目（/ls 可查看）；',
    '          全新项目请用完整路径',
    '',
    `已用过的项目：/ls`,
  ]
  return textMessage(lines.join('\n'))
}

/** /fn <对话名> <不存在的项目短名>：给出模糊匹配建议 */
function renderFnProjectNotFound(query: string): OutgoingMessage {
  const matches = suggestProjectLabels(query)
  const lines = [
    `❌ 没找到项目 "${query}"`,
    '',
    '如果是全新项目（之前没用 im2cc 创建过对话），请：',
    '  1. 在电脑端 fn <名称> 先创建一个对话（推荐），或',
    `  2. 在这里用完整路径，如 /fn <对话名> ~/Code/${query}`,
  ]
  if (matches.length > 0) {
    lines.push('', `或你是不是想找：${matches.join(', ')}`)
  }
  lines.push('', '已用过的项目列表：/ls')
  return textMessage(lines.join('\n'))
}

/** /fn <对话名> <歧义短名>：短名匹配多个项目 */
function renderFnProjectAmbiguous(
  query: string,
  matches: { label: string; cwd: string }[],
): OutgoingMessage {
  const lines = [
    `❓ "${query}" 匹配到多个项目：`,
    '',
    ...matches.map(m => `  ${m.label}  (${prettyPath(m.cwd)})`),
    '',
    '请用更完整的名称或直接传完整路径。',
  ]
  return textMessage(lines.join('\n'))
}

/** /ls：列出用过的项目（从 registry 派生），一行一个 */
function handleLs(): OutgoingMessage {
  const entries = listProjectIndex()

  if (entries.length === 0) {
    return textMessage([
      '📁 还没有用过任何项目',
      '',
      '请先在电脑端运行 fn <名称> 创建第一个对话。',
      '创建后这里就能看到对应的项目，可以用短名在 IM 端 /fn 新对话。',
    ].join('\n'))
  }

  const lines = [
    `📁 已用过的项目 (${entries.length})`,
    '',
    ...entries.map(e => `${e.label}  (${prettyPath(e.cwd)})`),
    '',
    '用法：/fn <对话名> <项目短名>',
    '全新项目请传完整路径，例：/fn auth ~/Code/foo',
  ]
  return textMessage(lines.join('\n'))
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
  const pathCheck = validateSessionProjectPath(reg.cwd)
  if (!pathCheck.ok) return pathCheck.message
  reg = { ...reg, cwd: pathCheck.resolvedPath }

  // 先计算出最终 mode，确保后续 register 调用能把它持久化到 registry
  const mode = reg.permissionMode
    ? migrateLegacyMode(reg.permissionMode, tool)
    : getDefaultMode(tool, config)

  // 断开前同步：仅对 Codex 生效（Claude 漂移由 SessionStart hook 负责）
  if (tool === 'claude' || tool === 'codex') {
    const allNames = listRegistered()
    const synced = syncDriftedSession(reg.name, reg.sessionId, reg.cwd, allNames, tool)
    if (synced) {
      log(`[${conversationId}] pre-disconnect sync: ${reg.name} ${reg.sessionId.slice(0, 8)} → ${synced.slice(0, 8)}`)
      registerWithMeta(reg.name, synced, reg.cwd, tool, { permissionMode: mode })
      reg = { ...reg, sessionId: synced }
    }
  }

  registerWithMeta(reg.name, reg.sessionId, reg.cwd, tool, { permissionMode: mode })

  const killed = getDriver(tool).killLocalSession(reg.name, tool)
  archiveBindingsBySession(reg.sessionId, conversationId)
  const driver = getDriver(tool)
  const cliVersion = driver.getVersion()
  touch(reg.name)
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
  const pathCheck = validateSessionProjectPath(session.projectPath)
  if (!pathCheck.ok) return pathCheck.message
  const driver = getDriver('claude')  // discovered sessions 目前只支持 claude
  const cliVersion = driver.getVersion()
  archiveBindingsBySession(session.sessionId, conversationId)
  const defaultMode = getDefaultMode('claude', config)
  const binding = createBinding(conversationId, session.sessionId, pathCheck.resolvedPath, defaultMode, cliVersion, transport, 'claude')
  registerWithMeta(name, session.sessionId, pathCheck.resolvedPath, 'claude', { permissionMode: defaultMode })
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
  // regEntry 正常应该有（上面已按 sessionId 查过）；null 时作为兜底再按 sessionId 反查一次
  const targetReg = regEntry ?? listRegistered().find(r => r.sessionId === binding.sessionId)
  if (targetReg) {
    updateRegistry(targetReg.name, { permissionMode: resolved })
  } else {
    log(`[mode] session ${binding.sessionId.slice(0, 8)} 未在 registry 中，模式仅保存到 binding`)
  }

  const modeInfo = modes.find(m => m.id === resolved)
  return `模式已切换为 ${resolved}（${modeInfo?.label}）\n下一条消息生效`
}

/**
 * /clear — 清空当前对话：调 driver 创建新 sessionId 替换 binding。
 * 对话名 / cwd / permissionMode / Session 已选模型不变；旧 sessionId 自动孤立但磁盘文件不删。
 */
async function handleClear(conversationId: string, config: Im2ccConfig): Promise<string> {
  const binding = getBinding(conversationId)
  if (!binding) return '❌ 当前会话未连接对话，请先 /fc 或 /fn'

  const { state, queueLength } = getQueueStatus(conversationId)
  if (state !== 'idle' || queueLength > 0) {
    return '❌ 当前对话有任务在执行中，请先 /stop'
  }
  if (listInflightTasksForSession(binding.sessionId, conversationId).length > 0) {
    return '❌ 当前对话有任务在执行中，请先 /stop'
  }

  const tool = (binding.tool ?? 'claude') as ToolId
  if (tool === 'gemini') return '❌ Gemini 暂不支持 /clear'

  const reg = lookupBySessionId(binding.sessionId)
  const sessionName = reg?.name
  if (!sessionName) {
    return '❌ 当前 session 未在 registry 注册，无法清空（请回电脑端处理）'
  }

  // Claude 渠道选择器场景：必须显式 claudeProfile（否则 launcher 会弹交互菜单，IM 端无 TTY）
  let claudeProfile: string | undefined
  if (tool === 'claude' && hasCustomClaudeLauncher(config)) {
    claudeProfile = reg?.claudeProfile?.trim() || config.imDefaultClaudeProfile?.trim()
    if (!claudeProfile) {
      return [
        '❌ 当前机器启用了本地 Claude 渠道选择器，IM 端无 TTY 无法弹菜单。',
        '请在 ~/.im2cc/config.json 加 "imDefaultClaudeProfile": "<渠道名>"，或回电脑端处理。',
      ].join('\n')
    }
  }

  try {
    const driver = getDriver(tool)
    const { sessionId: newSessionId } = await driver.createSession(
      binding.cwd,
      binding.permissionMode,
      sessionName,
      { claudeProfile, conversationId, selectedModelId: reg.selectedModelId },
    )

    // registry 同名替换 sessionId：register 会校验"同 sessionId 不能被多 name 持有"，
    // 但同 name 替换 sessionId 是合法路径（旧 sessionId 自动孤立）
    registerWithMeta(sessionName, newSessionId, binding.cwd, tool, {
      permissionMode: binding.permissionMode,
      claudeProfile,
    })

    updateBinding(conversationId, {
      sessionId: newSessionId,
      turnCount: 0,
    })

    log(`[${conversationId}] /clear: ${binding.sessionId.slice(0, 8)} → ${newSessionId.slice(0, 8)} ("${sessionName}")`)
    return `✅ 已清空对话 "${sessionName}"，开始新一轮`
  } catch (err) {
    return `❌ 清空失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * /compact — 压缩当前对话上下文（仅 Claude）。
 * Spike 验证 `claude -p "/compact" --resume <id>` 真实执行压缩；Claude 返回空 result。
 */
async function handleCompact(conversationId: string): Promise<string> {
  const binding = getBinding(conversationId)
  if (!binding) return '❌ 当前会话未连接对话，请先 /fc 或 /fn'

  const tool = (binding.tool ?? 'claude') as ToolId
  if (tool !== 'claude') return `❌ /compact 仅 Claude 支持，当前工具: ${toolDisplayName(tool)}`

  const { state, queueLength } = getQueueStatus(conversationId)
  if (state !== 'idle' || queueLength > 0) {
    return '❌ 当前对话有任务在执行中，请先 /stop'
  }
  if (listInflightTasksForSession(binding.sessionId, conversationId).length > 0) {
    return '❌ 当前对话有任务在执行中，请先 /stop'
  }

  try {
    const driver = getDriver(tool)
    const modelSnapshot = getModelSelectionSnapshotForBinding(binding)
    await driver.sendMessage(
      binding.sessionId,
      '/compact',
      binding.cwd,
      binding.permissionMode,
      { conversationId, modelOverride: modelSnapshot.selectedModelId },
    )
    // /compact 通常不追加 assistant 记录，没有属于本操作的新模型事实；不对账，
    // 避免把此前旧 turn 的 assistant 误当 compact 结果覆盖当前选择。
    log(`[${conversationId}] /compact 完成 (${binding.sessionId.slice(0, 8)})`)
    return '✅ 已压缩对话上下文'
  } catch (err) {
    return `❌ 压缩失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * /model — 切换命名 Session 的精确模型 ID；下条普通消息与下次 Terminal resume 生效。
 *
 * 三种调用形式：
 *  - 无参：展示候选模型短列表 + 当前选择 ★ 标记；同时设置 conversationId pending state（60s TTL）
 *  - /model <编号>：等价从当前生效清单选第 N 项（无需 pending state 依赖）
 *  - /model <短名 | 完整 ID>：仅接受当前清单登记项
 *  - /model default：清除显式选择，等待下一次成功响应锁定实际 ID
 */
function handleModel(args: string, conversationId: string): string {
  const binding = getBinding(conversationId)
  if (!binding) return '❌ 当前会话未连接对话，请先 /fc 或 /fn'

  const tool = (binding.tool ?? 'claude') as ToolId
  if (tool === 'gemini') return '❌ Gemini 暂不支持 /model'

  const trimmed = args.trim()

  // /model（无参）— 展示列表 + 设 pending
  if (!trimmed) {
    return renderModelList(conversationId, getSelectedModelForBinding(binding), tool)
  }

  // /model default — 重置为工具默认
  if (trimmed === 'default') {
    const reg = lookupBySessionId(binding.sessionId)
    if (!reg) return '❌ 当前 session 未在 registry 注册，无法切换模型'
    updateSelectedModel(reg.name, undefined)
    clearPendingModelSelection(conversationId)
    return '✅ 已重置为工具默认模型（未锁定）；下一次成功响应后将记录实际完整 ID'
  }

  // /model <编号 1-N>（N = 工具内置清单长度）
  if (/^[1-9]$/.test(trimmed)) {
    const catalog = getModelCatalog(tool)
    const idx = Number.parseInt(trimmed, 10) - 1
    if (idx < catalog.length) {
      return applyModelSelection(conversationId, catalog[idx])
    }
    clearPendingModelSelection(conversationId)
    return `❌ 未识别模型 "${trimmed}"；请用 /model 查看当前清单`
  }

  // /model <已登记短名 | 已登记完整 ID>
  clearPendingModelSelection(conversationId)
  const resolved = resolveModelInput(tool, trimmed)
  if (!resolved) {
    return `❌ 未识别模型 "${trimmed}"；请用 /model 查看清单，或先在 modelCatalogs.${tool} 登记`
  }
  return applyModelSelection(conversationId, resolved)
}

/**
 * 渲染候选模型列表文本 + 注册 pending state（60s TTL）。
 * 在 conversationId 上的下一条纯数字消息会被 model-pending 路由命中。
 */
function renderModelList(conversationId: string, currentModelId: string | undefined, tool: ToolId): string {
  const catalog = getModelCatalog(tool)
  if (catalog.length === 0) {
    // 不应该走到这里（已在 handleModel 拦截 gemini），兜底
    return '❌ 当前工具暂无可用模型清单'
  }

  setPendingModelSelection(conversationId, catalog)

  const currentShort = findShortNameByFullName(tool, currentModelId)
  const isInCatalog = !!currentShort && catalog.some(o => o.shortName === currentShort)
  // ★ 仅在当前选择真的命中清单时才在 headline 显示，与列表行的 ★ 标记保持一致
  const headline = `🤖 ${toolDisplayName(tool)} 可选模型（当前: ${currentModelId ?? '工具默认（未锁定）'}${isInCatalog ? ' ★' : ''}）`

  // 计算列宽，让短名右侧描述对齐
  const maxNameWidth = Math.max(...catalog.map(o => o.shortName.length))
  const optionLines = catalog.map((opt, i) => {
    const num = i + 1
    const namePad = opt.shortName.padEnd(maxNameWidth)
    const star = currentShort === opt.shortName ? ' ★ 当前' : ''
    return `  ${num}) ${namePad}  — ${opt.fullName} — ${opt.description}${star}`
  })

  return [
    headline,
    '',
    ...optionLines,
    '',
    `回复编号切换 (60s 内有效)，或 /model <名称>`,
    `/model default 重置为工具默认`,
  ].join('\n')
}

/**
 * 应用一次模型选择（命中清单或 pending 命中）。
 * 复用：handleModel 编号路径 + index.ts pending 路由命中。
 */
export function applyModelSelection(conversationId: string, option: ModelOption): string {
  const binding = getBinding(conversationId)
  if (!binding) return '❌ 当前会话未连接对话，请先 /fc 或 /fn'
  const reg = lookupBySessionId(binding.sessionId)
  if (!reg) return '❌ 当前 session 未在 registry 注册，无法切换模型'
  updateSelectedModel(reg.name, option.fullName)
  clearPendingModelSelection(conversationId)
  return `✅ 已选定模型 "${option.shortName}"（${option.fullName}），下一轮开始生效`
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

function handleScheduleSet(
  kind: 'at' | 'in' | 'cron',
  args: string,
  conversationId: string,
  transport: TransportType,
): string {
  const trimmed = args.trim()
  const tokens = trimmed ? trimmed.split(/\s+/) : []
  const head = tokens[0]?.toLowerCase()

  // 全局命令（无需绑定）：list / cancel <name>
  if (head === 'list') {
    return renderScheduleList(transport)
  }
  if (head === 'cancel' && tokens.length >= 2) {
    return handleScheduleCancelByName(tokens[1])
  }

  // 以下命令需要当前 chat 已绑定 session
  const binding = getBinding(conversationId)
  if (!binding) {
    if (head === 'cancel') {
      return '该群未接入对话。如需远程取消，用 /at cancel <对话名>；查看全部用 /at list。'
    }
    return '该群未接入对话，请先 /fc 或 /fn'
  }

  const reg = lookupBySessionId(binding.sessionId)
  if (!reg) return '当前 session 未在 registry 注册，无法设置定时消息'

  // 无参数：展示当前 session 的定时消息（任意类型）+ 用法
  if (!trimmed) {
    return renderScheduleStatus(reg.name, kind)
  }

  // /at cancel（取消当前绑定 session 的）
  if (head === 'cancel' && tokens.length === 1) {
    const removed = cancelScheduleByName(reg.name)
    if (!removed) return `${reg.name} 当前没有定时消息`
    return `✅ 已取消 ${reg.name} 的定时消息`
  }

  const parsed = kind === 'at' ? parseAt(trimmed)
    : kind === 'in' ? parseIn(trimmed)
    : parseCron(trimmed)

  if (!parsed.ok) return `❌ ${parsed.error}`

  const { schedule, replaced } = addSchedule({
    name: reg.name,
    transport,
    conversationId,
    kind,
    spec: parsed.spec,
    message: parsed.message,
    nextFireAt: parsed.nextFireAt,
  })

  const lines: string[] = []
  if (replaced) {
    lines.push(`⚠️ 已替换 ${reg.name} 原有的定时消息（每个 session 仅允许一条）`)
    lines.push('')
  }
  lines.push('✅ 定时消息已设置')
  lines.push(formatScheduleStatus(schedule))
  lines.push('')
  lines.push('管理：/at list 看全部，/at cancel 取消本对话，/at cancel <对话名> 远程取消')
  return lines.join('\n')
}

function handleScheduleCancelByName(name: string): string {
  const removed = cancelScheduleByName(name)
  if (!removed) {
    return [
      `未找到 "${name}" 的定时消息`,
      '',
      '查看全部：/at list',
    ].join('\n')
  }
  return [
    `✅ 已远程取消 "${name}" 的定时消息`,
    `原触发：${removed.kind} ${removed.spec}`,
    `原消息：${removed.message.length > 60 ? removed.message.slice(0, 60) + '…' : removed.message}`,
  ].join('\n')
}

function renderScheduleList(transport: TransportType): string {
  const all = listAllSchedules().slice().sort((a: Schedule, b: Schedule) => a.nextFireAt - b.nextFireAt)
  if (all.length === 0) {
    return [
      '🕐 当前没有任何定时消息',
      '',
      '设置：/at HH:MM <消息> | /in <时长> <消息> | /cron <表达式> <消息>',
    ].join('\n')
  }

  const header = `🕐 全部定时消息 (${all.length})`
  const limit = MSG_LENGTH_LIMIT[transport] ?? 4096
  const reservedTail = 200  // 给截断提示留余量

  const lines: string[] = [header, '']
  let bytes = header.length + 2
  let shown = 0
  let truncatedAt: number | null = null

  for (const s of all) {
    const block = formatScheduleListLine(s)
    const cost = block.length + 2  // 含分隔空行
    if (bytes + cost + reservedTail > limit) {
      truncatedAt = shown
      break
    }
    lines.push(block)
    lines.push('')
    bytes += cost
    shown += 1
  }

  if (truncatedAt !== null) {
    lines.push(`⚠️ 还有 ${all.length - truncatedAt} 条未显示（${transport === 'wechat' ? '微信单条上限较小' : 'IM 单条上限'}）。回电脑端查看完整列表。`)
  } else {
    lines.push('远程取消：/at cancel <对话名>')
  }
  return lines.join('\n')
}

function renderScheduleStatus(name: string, kind: 'at' | 'in' | 'cron'): string {
  const existing = getScheduledForSession(name)
  const lines: string[] = []
  if (existing) {
    lines.push(formatScheduleStatus(existing))
    lines.push('')
    lines.push('替换：再次 /at|/in|/cron 设置；取消：/at cancel')
  } else {
    lines.push(`${name} 当前没有定时消息`)
    lines.push('')
  }
  if (kind === 'at') {
    lines.push('用法：')
    lines.push('  /at HH:MM <消息>             — 今天该时刻（已过则推到明天）')
    lines.push('  /at YYYY-MM-DD HH:MM <消息>  — 指定日期时刻')
  } else if (kind === 'in') {
    lines.push('用法：/in <时长> <消息>')
    lines.push('  支持 30s / 5m / 2h / 1d，可组合 1h30m')
  } else {
    lines.push('用法：/cron <分> <时> <日> <月> <周> <消息>')
    lines.push('  例：/cron 0 9 * * * 早晨开工')
  }
  return lines.join('\n')
}

/**
 * /btw — 旁路 side 讨论（@20260513-im-btw-side-fork）。
 * 复用主对话上下文（fork session JSONL 文件），跑一次独立 turn，结果回 IM；主 session 不被污染。
 */
async function handleBtw(
  args: string,
  conversationId: string,
  sendReply?: (message: string | OutgoingMessage) => Promise<void>,
): Promise<string> {
  const question = args.trim()
  if (!question) return '❌ /btw 需要一个问题，用法：/btw <问题>'

  const binding = getBinding(conversationId)
  if (!binding) return '❌ 当前会话未连接对话，请先 /fc 或 /fn'

  const tool = (binding.tool ?? 'claude') as ToolId
  if (tool !== 'claude') {
    return `❌ ${tool} 暂不支持 /btw（V1 仅 Claude）`
  }

  if (!sendReply) {
    // 防御：index.ts 路径总是传 sendReply
    return '❌ /btw 内部错误：sendReply 未配置'
  }

  // 调 forkSession（Claude 专有；driver cast 到含可选方法的形状）
  let forkSessionId: string
  try {
    const driver = getDriver('claude') as unknown as {
      forkSession?: (sessionId: string, cwd: string) => string
    }
    if (!driver.forkSession) {
      return '❌ 当前 Claude driver 不支持 /btw'
    }
    forkSessionId = driver.forkSession(binding.sessionId, binding.cwd)
  } catch (err) {
    return `❌ /btw 失败：${err instanceof Error ? err.message : String(err)}`
  }

  // 走标准 enqueue 路径，用 fork sessionId 替代 binding.sessionId
  // AI 答案后续从 stream 流回 IM（aggregator / sendQueuedReplyIfAttached），handleBtw 不立即回复
  enqueue(conversationId, question, sendReply, { forkSessionId })

  // 返回空字符串：让 index.ts 跳过 sendSystem（不发"立即回执"，等 AI 答案）
  return ''
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
    'im2cc update             — 更新到最新版本',
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
    '/fn                      — 查看创建对话的用法',
    '/fn <对话名> <项目目录>  — 创建新对话',
    '/ls                      — 列出工作区下的项目目录',
    '/fc <名称>               — 接入已有对话',
    '/fl                      — 列出所有对话',
    '/fk <名称>               — 终止对话',
    '/fd                      — 断开当前对话',
    '/fs                      — 查看当前状态',
    '/mode                    — 查看可用模式',
    '/mode <模式别名>         — 切换模式（例如 /mode au）',
    '/stop                    — 中断当前执行',
    '/clear                   — 清空当前对话（保留对话名，开新一轮）',
    '/compact                 — 压缩当前对话上下文（仅 Claude）',
    '/btw <问题>              — 旁路 side 讨论：基于主对话上下文问答，不污染主 session（仅 Claude）',
    '/model                   — 查看当前模型覆盖',
    '/model <名称>            — 切换模型，下条消息生效（例如 /model claude-opus-4-7）',
    '/model default           — 重置为工具默认模型',
    '/at HH:MM <消息>          — 在指定时刻自动发该消息到当前对话',
    '/in <时长> <消息>          — 间隔后自动发（如 /in 2h 继续）',
    '/cron <5 段表达式> <消息>  — 周期触发（如 /cron 0 9 * * * 早晨开工）',
    '/at list                 — 列出全部定时消息（无需绑定）',
    '/at cancel               — 取消当前对话的定时消息',
    '/at cancel <对话名>      — 远程取消任意对话的定时消息',
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
