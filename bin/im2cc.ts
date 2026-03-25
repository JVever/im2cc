#!/usr/bin/env node
/**
 * @input:    CLI 参数 (start/stop/status/logs/sessions/new/connect/list/delete/detach/show/setup/install-service/doctor/wechat)
 * @output:   守护进程管理 + 完整 session 管理命令（new/connect/list/delete/detach/show）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync, execFileSync, fork } from 'node:child_process'
import { loadConfig, saveConfig, configExists, getPidFile, getDaemonLockDir, getLogDir, getConfigDir, loadWeChatAccount, saveWeChatAccount, getWeChatAccountFile, type Im2ccConfig } from '../src/config.js'
import { listActiveBindings, archiveBinding } from '../src/session.js'
import { getClaudeVersion } from '../src/claude-driver.js'
import { register, lookup, listRegistered, remove } from '../src/registry.js'
import { expandPath, validatePath, isValidSessionName } from '../src/security.js'
import { getDriver, hasDriver, type ToolId } from '../src/tool-driver.js'
import { resumeCommand, toolCreateArgs, toolResumeArgs } from '../src/tool-cli-args.js'
import { findSession, syncDriftedSession } from '../src/discover.js'
import { DAEMON_LOCK_STARTUP_GRACE_MS, daemonMainModulePath, isIm2ccDaemonProcess, killAllDaemonProcesses, listDaemonProcessPids, readDaemonPidRecord } from '../src/daemon-process.js'
import readline from 'node:readline'

// 触发各 driver 自注册（模块级副作用）
import '../src/claude-driver.js'
import '../src/codex-driver.js'
import '../src/gemini-driver.js'

const command = process.argv[2]

type DaemonState =
  | { kind: 'running', pids: number[] }
  | { kind: 'starting' }
  | { kind: 'stale', pid: number | null }
  | { kind: 'stopped' }

function inspectDaemonState(): DaemonState {
  const livePids = listDaemonProcessPids(daemonMainModulePath())
  if (livePids.length > 0) {
    return { kind: 'running', pids: livePids }
  }

  const daemonPidRecord = readDaemonPidRecord()
  if (daemonPidRecord.pid !== null) {
    return isIm2ccDaemonProcess(daemonPidRecord.pid, daemonMainModulePath())
      ? { kind: 'running', pids: [daemonPidRecord.pid] }
      : { kind: 'stale', pid: daemonPidRecord.pid }
  }

  if (daemonPidRecord.present) {
    return { kind: 'stale', pid: null }
  }

  const lockDir = getDaemonLockDir()
  if (fs.existsSync(lockDir)) {
    try {
      const stat = fs.statSync(lockDir)
      if ((Date.now() - stat.mtimeMs) < DAEMON_LOCK_STARTUP_GRACE_MS) {
        return { kind: 'starting' }
      }
    } catch {}
    return { kind: 'stale', pid: null }
  }

  return { kind: 'stopped' }
}

function cleanupStaleDaemonState(): void {
  try { fs.unlinkSync(getPidFile()) } catch {}
  try { fs.rmSync(getDaemonLockDir(), { recursive: true, force: true }) } catch {}
}

switch (command) {
  case 'start': await cmdStart(); break
  case 'stop': cmdStop(); break
  case 'status': cmdStatus(); break
  case 'logs': cmdLogs(); break
  case 'sessions': cmdSessions(); break
  case 'new': await cmdNew(); break
  case 'connect': await cmdConnect(); break
  case 'open': await cmdConnect(); break  // backward compat
  case 'list': cmdList(); break
  case 'delete': cmdDelete(); break
  case 'detach': cmdDetach(); break
  case 'show': cmdShow(); break
  case 'setup': await cmdSetup(); break
  case 'install-service': cmdInstallService(); break
  case 'doctor': cmdDoctor(); break
  case 'wechat': await cmdWeChat(); break
  default:
    console.log(`im2cc — IM to AI coding tools

用法: im2cc <command>

对话管理:
  new [--tool <工具>] <名称> [路径]  创建新对话
  connect [名称] [ID前缀]           接入已有对话（别名: open）
  list                              列出所有已注册对话
  show [名称]                       查看对话详情
  delete <名称>                     终止并删除对话
  detach                            从当前 tmux 会话断开

守护进程:
  setup              配置飞书 App 凭证
  start              启动守护进程
  stop               停止守护进程
  status             查看运行状态
  logs               查看日志

微信:
  wechat login       扫码绑定微信 ClawBot
  wechat status      查看微信连接状态
  wechat logout      解除微信绑定

运维:
  sessions           列出活跃绑定
  install-service    安装 macOS 开机自启
  doctor             检查环境
`)
}

// ─── tmux 辅助 ───────────────────────────────────────

/** 检查 tmux session 是否存在 */
function tmuxSessionExists(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' })
    return true
  } catch { return false }
}

/** 检测 tmux session 中实际运行的工具（通过进程名匹配） */
function tmuxPaneTool(tmuxSession: string): ToolId | null {
  try {
    const pid = execFileSync('tmux', ['list-panes', '-t', tmuxSession, '-F', '#{pane_pid}'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split('\n')[0]
    if (!pid) return null
    const cmd = execFileSync('ps', ['-p', pid, '-o', 'command='],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    for (const t of ['claude', 'codex', 'gemini'] as const) {
      if (cmd === t || cmd.startsWith(`${t} `) || cmd.endsWith(`/${t}`)) return t
    }
    return null
  } catch { return null }
}

/** 连接到 tmux session（在 tmux 内用 switch-client，否则用 attach） */
function tmuxConnect(tmuxSession: string): void {
  try {
    if (process.env.TMUX) {
      execFileSync('tmux', ['switch-client', '-t', tmuxSession], { stdio: 'inherit' })
    } else {
      execFileSync('tmux', ['attach', '-dt', tmuxSession], { stdio: 'inherit' })
    }
  } catch {
    console.log(`tmux 操作失败。手动运行: tmux attach -t ${tmuxSession}`)
  }
}

/**
 * 查找属于指定 name + tool 的 tmux session。
 * Registry 是工具身份的唯一权威来源，tmux 命名只是进程管理标签。
 * 旧格式 session 需验证实际运行的工具是否匹配，不匹配则不接入。
 */
function findTmuxSession(name: string, tool: string = 'claude'): string | null {
  // 新格式：名称已编码工具身份，直接匹配
  const newName = `im2cc-${tool}-${name}`
  if (tmuxSessionExists(newName)) return newName

  // 旧格式：名称不含工具信息，需验证进程
  const oldName = `im2cc-${name}`
  if (!tmuxSessionExists(oldName)) return null

  const actualTool = tmuxPaneTool(oldName)
  if (actualTool === tool) {
    // 工具匹配 → 升级命名，无损迁移
    try {
      execFileSync('tmux', ['rename-session', '-t', oldName, newName], { stdio: 'ignore' })
      return newName
    } catch {
      return oldName
    }
  }

  // 工具不匹配或无法检测 → 不接入，让调用方重新创建正确的 session
  return null
}

// ─── 远程绑定解除 ───────────────────────────────────

/** 解除远程端绑定并通知 IM */
async function releaseRemoteBinding(sessionId: string, sessionName: string): Promise<void> {
  const bindings = listActiveBindings()
  const remoteBinding = bindings.find(b => b.sessionId === sessionId)
  if (!remoteBinding) return

  archiveBinding(remoteBinding.conversationId)

  // 飞书端尝试通知
  if (remoteBinding.transport === 'feishu' || !remoteBinding.transport) {
    try {
      const config = loadConfig()
      const lark = await import('@larksuiteoapi/node-sdk')
      const client = new lark.Client({ appId: config.feishu.appId, appSecret: config.feishu.appSecret })
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: remoteBinding.conversationId,
          msg_type: 'text',
          content: JSON.stringify({ text: `🔄 "${sessionName}" 已转到电脑端` }),
        },
      })
    } catch { /* 通知失败不影响主流程 */ }
  }

  console.log(`🔄 已从${remoteBinding.transport ?? '远程'}端断开`)
}

// ─── 守护进程命令 ────────────────────────────────────

async function cmdStart(): Promise<void> {
  if (!configExists()) {
    console.log('❌ 未配置。请先运行: im2cc setup')
    process.exit(1)
  }

  const state = inspectDaemonState()
  if (state.kind === 'running') {
    const suffix = state.pids.length > 1 ? '，检测到重复实例' : ''
    console.log(`守护进程已在运行 (PID: ${state.pids.join(', ')})${suffix}`)
    return
  }
  if (state.kind === 'starting') {
    console.log('守护进程正在启动中，请稍后再试')
    return
  }
  if (state.kind === 'stale') {
    cleanupStaleDaemonState()
  }

  console.log('启动 im2cc 守护进程...')

  const mainModule = daemonMainModulePath()
  const child = fork(mainModule, [], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })

  child.unref()

  let runningPids: number[] = []
  for (let i = 0; i < 20; i++) {
    const current = inspectDaemonState()
    if (current.kind === 'running') {
      runningPids = current.pids
      break
    }
    if (current.kind === 'stale') {
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  child.disconnect()

  if (runningPids.length > 0) {
    const suffix = runningPids.length > 1 ? '，但检测到重复实例，请先执行 im2cc stop 清理旧进程' : ''
    console.log(`✅ 守护进程已启动 (PID: ${runningPids.join(', ')})${suffix}`)
    console.log(`   日志: im2cc logs`)
    return
  }

  console.log('⚠️ 启动命令已发出，但尚未确认守护进程就绪')
  console.log('   请运行: im2cc status')
}

function cmdStop(): void {
  // 使用 killAllDaemonProcesses 确保杀死所有守护进程（包括 pgrep 发现的僵尸进程）
  const killedPids = killAllDaemonProcesses(daemonMainModulePath(), process.pid)

  if (killedPids.length > 0) {
    // 提示活跃绑定状态
    const bindings = listActiveBindings()
    if (bindings.length > 0) {
      console.log(`⚠️ 当前有 ${bindings.length} 个活跃绑定，执行中的任务结果将在下次启动时恢复`)
    }
    console.log(`✅ 已停止守护进程 (PID: ${killedPids.join(', ')})`)
  } else {
    console.log('守护进程未运行')
  }

  // 清理残留状态文件
  cleanupStaleDaemonState()
}

function cmdStatus(): void {
  const state = inspectDaemonState()
  if (state.kind === 'running') {
    const bindings = listActiveBindings()
    const duplicateNote = state.pids.length > 1 ? ' [检测到重复实例]' : ''
    console.log(`🟢 守护进程运行中 (PID: ${state.pids.join(', ')})${duplicateNote}`)
    console.log(`   活跃绑定: ${bindings.length}`)
    return
  }
  if (state.kind === 'starting') {
    console.log('🟡 守护进程启动中')
    return
  }
  if (state.kind === 'stale') {
    cleanupStaleDaemonState()
    console.log('⬤ 守护进程未运行 (已清理残留状态)')
    return
  }
  console.log('⬤ 守护进程未运行')
}

function cmdLogs(): void {
  const logFile = path.join(getLogDir(), 'daemon.log')
  if (!fs.existsSync(logFile)) {
    console.log('暂无日志')
    return
  }
  execSync(`tail -f "${logFile}"`, { stdio: 'inherit' })
}

function cmdSessions(): void {
  const bindings = listActiveBindings()
  if (bindings.length === 0) {
    console.log('没有活跃绑定')
    return
  }

  console.log('活跃绑定:')
  for (const b of bindings) {
    const transportTag = b.transport && b.transport !== 'feishu' ? ` [${b.transport}]` : ''
    console.log(`  ${path.basename(b.cwd)} → ${b.sessionId.slice(0, 8)}...${transportTag}`)
  }
}

// ─── 对话管理命令 ────────────────────────────────────

/** im2cc new [--tool <工具>] <名称> [路径] — 创建新对话并在 tmux 中打开 */
async function cmdNew(): Promise<void> {
  // 解析 --tool 参数
  let tool: ToolId = 'claude'
  const args = process.argv.slice(3)
  const toolIdx = args.indexOf('--tool')
  if (toolIdx !== -1 && args[toolIdx + 1]) {
    tool = args[toolIdx + 1] as ToolId
    args.splice(toolIdx, 2)
  }

  const name = args[0]
  const pathArg = args[1]

  if (!name) {
    console.log('用法: im2cc new [--tool claude|codex|gemini] <对话名称> [项目路径]')
    console.log('例如: im2cc new auth-refactor ~/Code/im2cc')
    console.log('      im2cc new --tool codex auth-refactor ~/Code/im2cc')
    console.log('      im2cc new bugfix       (使用当前目录)')
    return
  }

  // 名称安全校验
  if (!isValidSessionName(name)) {
    console.log('❌ 名称不合法，只允许字母、数字、连字符和下划线（1-64 字符）')
    return
  }

  // 检查工具是否已注册
  if (!hasDriver(tool)) {
    console.log(`❌ 工具 "${tool}" 未注册。可用工具: claude, codex, gemini`)
    return
  }

  // 检查名称是否已存在
  const existing = lookup(name)
  if (existing) {
    console.log(`"${name}" 已存在。用 im2cc connect ${name} 打开，或换个名称。`)
    return
  }

  const cwd = pathArg ? expandPath(pathArg) : process.cwd()

  const config = loadConfig()
  const validation = validatePath(cwd, config)
  if (!validation.valid) {
    console.log(`❌ ${validation.error}`)
    return
  }

  const toolLabel = tool !== 'claude' ? ` [${tool}]` : ''
  console.log(`创建新对话 "${name}"${toolLabel} → ${validation.resolvedPath}...`)

  try {
    const driver = getDriver(tool)
    const result = await driver.createSession(validation.resolvedPath, config.defaultPermissionMode ?? 'default', name)
    const sessionId = result.sessionId

    register(name, sessionId, validation.resolvedPath, tool)

    // 在 tmux 中启动交互式工具
    const tmuxSession = `im2cc-${tool}-${name}`
    // 清理可能残留的同名 tmux session
    if (tmuxSessionExists(tmuxSession)) {
      execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' })
    }
    const oldTmux = `im2cc-${name}`
    if (tmuxSessionExists(oldTmux)) {
      execFileSync('tmux', ['kill-session', '-t', oldTmux], { stdio: 'ignore' })
    }

    try {
      const tmuxArgs = toolResumeArgs(tool, sessionId, name)
      execFileSync('tmux', [
        'new-session', '-d', '-s', tmuxSession, '-c', validation.resolvedPath,
        ...tmuxArgs,
      ])

      console.log(`✅ 创建对话 "${name}"${toolLabel} → ${path.basename(validation.resolvedPath)}`)
      console.log(`   飞书/微信: /fc ${name}`)

      tmuxConnect(tmuxSession)
    } catch {
      // tmux 不可用，直接启动
      console.log(`✅ 已创建 "${name}"`)
      console.log(`   打开: im2cc connect ${name}`)
      const tmuxArgs = toolResumeArgs(tool, sessionId, name)
      execFileSync(tmuxArgs[0], tmuxArgs.slice(1), { stdio: 'inherit', cwd: validation.resolvedPath })
    }
  } catch (err) {
    console.error(`❌ 创建失败: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** im2cc connect [名称] [ID前缀] — 接入已有对话 */
async function cmdConnect(): Promise<void> {
  const target = process.argv[3]
  const idPrefix = process.argv[4]

  // 无参数：列出所有对话，唯一时自动接入
  if (!target) {
    const all = listRegistered()
    if (all.length === 0) {
      console.log('没有已注册的对话。用 im2cc new <名称> 创建。')
      return
    }
    if (all.length === 1) {
      console.log(`接入: ${all[0].name}`)
      // 递归调用：注入参数
      process.argv[3] = all[0].name
      await cmdConnect()
      return
    }
    console.log('已注册的对话:')
    console.log('─'.repeat(50))
    for (const s of all) {
      const tmux = findTmuxSession(s.name, s.tool)
      const status = tmux ? '🟢 活跃' : '⬤ 休眠'
      const toolTag = s.tool && s.tool !== 'claude' ? ` [${s.tool}]` : ''
      console.log(`  ${status}  ${s.name}  (${path.basename(s.cwd)})${toolTag}  [${s.sessionId.slice(0, 8)}]`)
    }
    console.log('─'.repeat(50))
    console.log('\nim2cc connect <名称> 接入')
    return
  }

  // 双参数模式: connect <新名称> <ID前缀>
  if (idPrefix) {
    await cmdConnectDoubleArg(target, idPrefix)
    return
  }

  // 单参数模式: connect <名称>
  let session = lookup(target)
  if (!session) {
    console.log(`未找到 "${target}"`)
    const all = listRegistered()
    if (all.length > 0) {
      console.log('可用对话:')
      for (const s of all) console.log(`  ${s.name}`)
    }
    return
  }

  let tool = session.tool ?? 'claude'

  // 断开前同步：检查 session 是否漂移（Plan 模式等）
  if (tool === 'claude') {
    const allNames = listRegistered()
    const synced = syncDriftedSession(session.name, session.sessionId, session.cwd, allNames)
    if (synced) {
      console.log(`🔄 检测到 session 漂移，已自动同步: ${session.sessionId.slice(0, 8)} → ${synced.slice(0, 8)}`)
      register(session.name, synced, session.cwd, 'claude')
      session = { ...session, sessionId: synced }
    }
  }

  // 独占：解绑远程端
  await releaseRemoteBinding(session.sessionId, session.name)

  // 查找已有 tmux session
  const tmux = findTmuxSession(session.name, tool)
  if (tmux) {
    console.log(`接入 "${session.name}" (活跃)`)
    tmuxConnect(tmux)
    return
  }

  // tmux session 不存在，重新创建
  const driver = getDriver(tool as ToolId)
  const status = tool === 'claude' ? driver.checkSessionFile(session.sessionId, session.cwd) : 'here'
  if (tool === 'claude' && status === 'elsewhere') {
    console.log(`❌ session ${session.sessionId.slice(0, 8)} 存在于错误的项目目录`)
    console.log(`   registry 中 cwd=${session.cwd} 与 session 文件位置不匹配`)
    console.log(`   请 im2cc delete ${session.name} 后重新 im2cc new`)
    return
  }

  const tmuxSession = `im2cc-${tool}-${session.name}`
  const cmdArgs = status === 'here'
    ? toolResumeArgs(tool as ToolId, session.sessionId, session.name)
    : toolCreateArgs(tool as ToolId, session.sessionId, session.name)

  console.log(`恢复 "${session.name}" → ${path.basename(session.cwd)}`)

  try {
    execFileSync('tmux', [
      'new-session', '-d', '-s', tmuxSession, '-c', session.cwd,
      ...cmdArgs,
    ])
    tmuxConnect(tmuxSession)
  } catch {
    // tmux 不可用，直接启动
    execFileSync(cmdArgs[0], cmdArgs.slice(1), { stdio: 'inherit', cwd: session.cwd })
  }
}

/** connect 双参数模式: 按 ID 前缀搜索未注册的 session，注册并接入 */
async function cmdConnectDoubleArg(newName: string, query: string): Promise<void> {
  // 名称安全校验
  if (!isValidSessionName(newName)) {
    console.log('❌ 名称不合法，只允许字母、数字、连字符和下划线（1-64 字符）')
    return
  }

  // 检查名称是否已注册
  const existing = lookup(newName)
  if (existing) {
    console.log(`"${newName}" 已注册。用 im2cc connect ${newName} 直接接入。`)
    return
  }

  // 搜索匹配的 session 文件
  const matches = await findSession(query)

  if (matches.length === 0) {
    console.log(`❌ 未找到匹配 "${query}" 的对话`)
    return
  }

  if (matches.length > 1) {
    console.log(`多个对话匹配:`)
    for (const m of matches.slice(0, 5)) {
      console.log(`  ${m.sessionId.slice(0, 8)} ${m.name} (${m.projectName})`)
    }
    console.log('请用更精确的 ID 前缀')
    return
  }

  const match = matches[0]
  const sessionId = match.sessionId
  const cwd = match.projectPath

  if (!cwd) {
    console.log('❌ 无法还原项目路径')
    return
  }

  // 验证 session 文件位置（使用 Claude driver，因为 discover 只支持 Claude）
  const driver = getDriver('claude')
  const fileStatus = driver.checkSessionFile(sessionId, cwd)

  if (fileStatus === 'elsewhere') {
    console.log(`❌ session ${sessionId.slice(0, 8)} 存在于错误的项目目录`)
    return
  }

  // 注册
  register(newName, sessionId, cwd, 'claude')
  console.log(`✅ 已注册 "${newName}" → ${path.basename(cwd)} [${sessionId.slice(0, 8)}]`)

  // 解绑远程端
  await releaseRemoteBinding(sessionId, newName)

  // 创建 tmux session
  const tmuxSession = `im2cc-claude-${newName}`
  const cmdArgs = fileStatus === 'here'
    ? toolResumeArgs('claude', sessionId, newName)
    : toolCreateArgs('claude', sessionId, newName)

  try {
    execFileSync('tmux', [
      'new-session', '-d', '-s', tmuxSession, '-c', cwd,
      ...cmdArgs,
    ])
    tmuxConnect(tmuxSession)
  } catch {
    execFileSync(cmdArgs[0], cmdArgs.slice(1), { stdio: 'inherit', cwd })
  }
}

/** im2cc list — 列出所有已注册对话（含 tmux 状态和工具标签） */
function cmdList(): void {
  const all = listRegistered()
  if (all.length === 0) {
    console.log('没有已注册的对话。用 im2cc new <名称> 创建。')
    return
  }

  console.log('已注册的对话:')
  console.log('─'.repeat(50))
  for (const s of all) {
    const tmux = findTmuxSession(s.name, s.tool)
    const status = tmux ? '🟢 活跃' : '⬤ 休眠'
    const toolTag = s.tool && s.tool !== 'claude' ? ` [${s.tool}]` : ''
    console.log(`  ${status}  ${s.name}  (${path.basename(s.cwd)})${toolTag}  [${s.sessionId.slice(0, 8)}]`)
  }
}

/** im2cc delete <名称> — 终止 tmux session 并从注册表删除 */
function cmdDelete(): void {
  const name = process.argv[3]
  if (!name) {
    console.log('用法: im2cc delete <名称>')
    return
  }

  const session = lookup(name)
  if (!session) {
    console.log(`未找到 "${name}"`)
    return
  }

  // Kill tmux — 显式删除时清理所有格式的 tmux session，不依赖工具验证
  for (const tmuxName of [`im2cc-${session.tool ?? 'claude'}-${session.name}`, `im2cc-${session.name}`]) {
    try {
      execFileSync('tmux', ['has-session', '-t', tmuxName], { stdio: 'ignore' })
      execFileSync('tmux', ['kill-session', '-t', tmuxName], { stdio: 'ignore' })
      console.log('✅ 已终止 tmux 会话')
    } catch { /* 不存在 */ }
  }

  remove(session.name)
  console.log(`✅ 已删除 "${session.name}"`)
  console.log(`   如需恢复: ${resumeCommand((session.tool ?? 'claude') as ToolId, session.sessionId)}`)
}

/** im2cc detach — 从当前 tmux 会话断开 */
function cmdDetach(): void {
  try {
    execFileSync('tmux', ['detach-client'], { stdio: 'inherit' })
  } catch {
    console.log('不在 tmux 会话中')
  }
}

/** im2cc show [名称] — 查看对话详情 */
function cmdShow(): void {
  const name = process.argv[3]
  if (!name) {
    cmdList()
    return
  }

  const session = lookup(name)
  if (!session) {
    console.log(`未找到 "${name}"`)
    return
  }

  const toolTag = session.tool && session.tool !== 'claude' ? ` [${session.tool}]` : ''
  const tmux = findTmuxSession(session.name, session.tool)

  console.log(`📊 ${session.name}${toolTag}`)
  console.log(`  📁 ${path.basename(session.cwd)} (${session.cwd})`)
  console.log(`  🔑 ${session.sessionId}`)
  console.log(`  ${tmux ? '🟢 tmux: 活跃' : '⬤ tmux: 休眠'}`)
  console.log('')
  console.log(`  打开: im2cc connect ${session.name}`)
  console.log(`  飞书/微信: /fc ${session.name}`)
  console.log(`  终止: im2cc delete ${session.name}`)
}

// ─── 配置/运维命令 ───────────────────────────────────

async function cmdSetup(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r))

  console.log('im2cc 配置向导')
  console.log('─'.repeat(40))
  console.log('请在飞书开放平台创建一个自建应用，获取 App ID 和 App Secret')
  console.log('开放平台: https://open.feishu.cn/app\n')

  const config = loadConfig()

  config.feishu.appId = (await ask(`飞书 App ID [${config.feishu.appId || '未设置'}]: `)) || config.feishu.appId
  config.feishu.appSecret = (await ask(`飞书 App Secret [${config.feishu.appSecret ? '****' + config.feishu.appSecret.slice(-4) : '未设置'}]: `)) || config.feishu.appSecret

  const userIds = await ask(`允许的用户 ID (逗号分隔，留空=所有人) [${config.allowedUserIds.join(',')}]: `)
  if (userIds) config.allowedUserIds = userIds.split(',').map(s => s.trim()).filter(Boolean)

  const pathWl = await ask(`路径白名单 (逗号分隔) [${config.pathWhitelist.join(',')}]: `)
  if (pathWl) config.pathWhitelist = pathWl.split(',').map(s => s.trim()).filter(Boolean)

  rl.close()

  saveConfig(config)
  console.log(`\n✅ 配置已保存到 ${getConfigDir()}/config.json`)
  console.log('\n下一步:')
  console.log('  1. 在飞书开放平台为应用添加 "机器人" 能力')
  console.log('  2. 添加权限: im:message, im:message:send_as_bot, im:message.group_msg:readonly, im:message.group_at_msg:readonly, im:chat:readonly, im:resource')
  console.log('  3. 发布应用')
  console.log('  4. 运行 im2cc start')
}

function cmdInstallService(): void {
  const plistDir = path.join(os.homedir(), 'Library/LaunchAgents')
  const plistFile = path.join(plistDir, 'com.im2cc.daemon.plist')

  // 直接运行 daemon 入口（避免 CLI start 的 double-fork）
  const mainModule = path.resolve(import.meta.dirname, '../src/index.js')

  // 优先使用 Homebrew symlink 路径，避免 Cellar 版本号硬编码（升级后失效）
  const stableNodePaths = ['/opt/homebrew/bin/node', '/usr/local/bin/node']
  const nodePath = stableNodePaths.find(p => {
    try { return fs.realpathSync(p) === fs.realpathSync(process.execPath) } catch { return false }
  }) ?? process.execPath

  const logDir = getLogDir()
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.im2cc.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${mainModule}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/launchd-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/launchd-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`

  if (!fs.existsSync(plistDir)) fs.mkdirSync(plistDir, { recursive: true })
  fs.writeFileSync(plistFile, plist)
  console.log(`✅ LaunchAgent 已安装: ${plistFile}`)
  console.log('   加载: launchctl load ' + plistFile)
  console.log('   卸载: launchctl unload ' + plistFile)
}

function cmdDoctor(): void {
  console.log('im2cc 环境检查')
  console.log('─'.repeat(40))

  // AI 编程工具
  const claudeVersion = getClaudeVersion()
  console.log(`claude: ${claudeVersion === 'unknown' ? '⬤ 未安装' : '✅ ' + claudeVersion}`)
  for (const tool of ['codex', 'gemini']) {
    try {
      execFileSync('which', [tool], { stdio: 'ignore' })
      try {
        const ver = execFileSync(tool, ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim()
        console.log(`${tool}: ✅ ${ver}`)
      } catch {
        console.log(`${tool}: ✅ 已安装（版本未知）`)
      }
    } catch {
      console.log(`${tool}: ⬤ 未安装`)
    }
  }

  // Node.js
  console.log(`Node.js: ✅ ${process.version}`)

  // 配置
  console.log(`配置文件: ${configExists() ? '✅ 已配置' : '❌ 未配置 (运行 im2cc setup)'}`)

  // 飞书凭证
  if (configExists()) {
    const config = loadConfig()
    console.log(`飞书 App ID: ${config.feishu.appId ? '✅ ****' + config.feishu.appId.slice(-4) : '❌ 未设置'}`)
    console.log(`用户白名单: ${config.allowedUserIds.length > 0 ? '✅ ' + config.allowedUserIds.length + ' 人' : '⚠️ 未设置 (所有人可用)'}`)
    console.log(`路径白名单: ${config.pathWhitelist.join(', ')}`)
  }

  // 活跃绑定
  const bindings = listActiveBindings()
  console.log(`活跃绑定: ${bindings.length}`)

  // PID 检查
  const daemonState = inspectDaemonState()
  if (daemonState.kind === 'running') {
    const duplicateNote = daemonState.pids.length > 1 ? ' [重复实例]' : ''
    console.log(`守护进程: 🟢 运行中 (PID: ${daemonState.pids.join(', ')})${duplicateNote}`)
  } else if (daemonState.kind === 'starting') {
    console.log('守护进程: 🟡 启动中')
  } else if (daemonState.kind === 'stale') {
    console.log(`守护进程: ⬤ 未运行（检测到残留${daemonState.pid ? ` PID: ${daemonState.pid}` : ' 锁'}）`)
  } else {
    console.log('守护进程: ⬤ 未运行')
  }

  // 微信
  const wechatAccount = loadWeChatAccount()
  console.log(`微信 ClawBot: ${wechatAccount?.botToken ? '✅ 已绑定' : '⬤ 未绑定 (im2cc wechat login)'}`)
}

async function cmdWeChat(): Promise<void> {
  const sub = process.argv[3]

  if (sub === 'login') {
    const { getQRCode, pollQRCodeStatus } = await import('../src/wechat.js')
    const qrcodeTerminal = (await import('qrcode-terminal')).default

    console.log('正在获取微信 ClawBot QR 码...')
    const { qrcode, qrcodeUrl } = await getQRCode()

    // 渲染 QR 码到终端
    const qrContent = qrcodeUrl || qrcode
    console.log('\n请用微信扫描以下 QR 码:\n')
    qrcodeTerminal.generate(qrContent, { small: true })

    console.log('\n等待扫码确认...')
    const maxAttempts = 30
    for (let i = 0; i < maxAttempts; i++) {
      const result = await pollQRCodeStatus(qrcode)
      if (result) {
        saveWeChatAccount({
          botToken: result.botToken,
          baseUrl: result.baseUrl,
          ilinkBotId: result.ilinkBotId,
          ilinkUserId: result.ilinkUserId,
          savedAt: new Date().toISOString(),
          lastOkAt: new Date().toISOString(),
          syncBuf: '',
        })
        console.log(`\n✅ 微信 ClawBot 已绑定`)
        console.log(`   Bot ID: ${result.ilinkBotId}`)
        console.log(`   重启守护进程生效: im2cc stop && im2cc start`)
        return
      }
      // pollQRCodeStatus 自身有超时，无需额外 sleep
    }
    console.log('\n❌ 扫码超时，请重试')
    return
  }

  if (sub === 'status') {
    const account = loadWeChatAccount()
    if (!account?.botToken) {
      console.log('微信 ClawBot: 未绑定')
      console.log('运行 im2cc wechat login 绑定')
      return
    }
    console.log('微信 ClawBot:')
    console.log(`  Bot ID: ${account.ilinkBotId || '(未知)'}`)
    console.log(`  Base URL: ${account.baseUrl}`)
    console.log(`  绑定时间: ${account.savedAt}`)
    console.log(`  最后活跃: ${account.lastOkAt}`)
    console.log(`  Token: ****${account.botToken.slice(-8)}`)
    return
  }

  if (sub === 'logout') {
    const accountFile = getWeChatAccountFile()
    if (fs.existsSync(accountFile)) {
      fs.unlinkSync(accountFile)
      console.log('✅ 已解除微信 ClawBot 绑定')
      console.log('   重启守护进程生效: im2cc stop && im2cc start')
    } else {
      console.log('微信 ClawBot 未绑定')
    }
    return
  }

  console.log(`微信 ClawBot 管理

用法: im2cc wechat <command>

  login    扫码绑定微信 ClawBot
  status   查看连接状态
  logout   解除绑定`)
}
