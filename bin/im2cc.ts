#!/usr/bin/env node
/**
 * @input:    CLI 参数 (start/stop/status/logs/sessions/new/connect/list/delete/detach/show/setup/secure/onboard/install-service/doctor/help/update/wechat/fqon/fqoff/fqs)
 * @output:   守护进程管理 + 完整 session 管理命令（new/connect/list/delete/detach/show；connect 含桌面接回保护态，list 输出按对话位置聚合）
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync, execFileSync, spawn } from 'node:child_process'
import { loadConfig, saveConfig, configExists, getPidFile, getDaemonLockDir, getLogDir, getConfigDir, loadWeChatAccount, saveWeChatAccount, getWeChatAccountFile, type Im2ccConfig } from '../src/config.js'
import { listActiveBindings, archiveBinding } from '../src/session.js'
import { getClaudeVersion } from '../src/claude-driver.js'
import { register, registerWithMeta, lookup, listRegistered, remove } from '../src/registry.js'
import { expandPath, validatePath, isValidSessionName } from '../src/security.js'
import { getDriver, hasDriver, type ToolId } from '../src/tool-driver.js'
import { resumeCommand, toolCreateArgs, toolResumeArgs } from '../src/tool-cli-args.js'
import { findSession, syncDriftedSession } from '../src/discover.js'
import { DAEMON_LOCK_STARTUP_GRACE_MS, DAEMON_MARKER, daemonMainModulePath, isIm2ccDaemonProcess, killAllDaemonProcesses, listDaemonProcessPids, readDaemonPidRecord } from '../src/daemon-process.js'
import { claudeSupportsSessionNameFlag } from '../src/tool-compat.js'
import { renderLocalRegisteredSessionList, renderRegisteredSessionList, renderUnifiedHelp } from '../src/commands.js'
import { detectInstallRoot, listReplaceableInstallEntries, PUBLIC_ARCHIVE_URL } from '../src/upgrade.js'
import { hasCustomClaudeLauncher, selectClaudeProfile } from '../src/claude-launcher.js'
import { disableAntiPomodoro, enableAntiPomodoro, formatAntiPomodoroStatus, getAntiPomodoroSnapshot } from '../src/anti-pomodoro.js'
import { interruptInflightTasksForSession, listCompletedInflightSnapshotsForSession, listInflightTasksForSession, type CompletedInflightSnapshot, type InflightTaskSnapshot } from '../src/queue.js'
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

function inspectLocalDaemonState(): DaemonState {
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

function cmdHelp(): void {
  console.log(renderUnifiedHelp())
}

function validateSessionPathForAttach(cwd: string, config: Im2ccConfig): { ok: true, resolvedPath: string } | { ok: false, message: string } {
  const validation = validatePath(cwd, config)
  if (!validation.valid) {
    return {
      ok: false,
      message: `❌ ${validation.error}\n如需继续，请先调整路径白名单后再接入这个对话。`,
    }
  }
  return { ok: true, resolvedPath: validation.resolvedPath }
}

function commandExists(commandName: string): boolean {
  try {
    execFileSync('which', [commandName], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function currentInstallRoot() {
  return detectInstallRoot(import.meta.dirname)
}

function ensureCleanGitCheckout(root: string): void {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

  if (status) {
    console.log('❌ 当前安装目录有未提交改动，已停止自动更新。')
    console.log('请先提交、暂存或清理这些改动后再运行 im2cc update。')
    process.exit(1)
  }
}

function upgradeFromPublicArchive(root: string): void {
  if (!commandExists('curl') || !commandExists('tar')) {
    console.log('❌ 当前安装不含 .git，需要用公开源码包更新，但本机缺少 curl 或 tar。')
    console.log('请先安装 curl 与 tar，或重新用 git clone 安装后再更新。')
    process.exit(1)
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-upgrade-'))
  const archivePath = path.join(tmpDir, 'im2cc.tar.gz')
  const extractDir = path.join(tmpDir, 'extract')
  fs.mkdirSync(extractDir, { recursive: true })

  try {
    console.log('当前安装目录不含 .git，改用公开源码包更新...')
    execFileSync('curl', ['-L', PUBLIC_ARCHIVE_URL, '-o', archivePath], { stdio: 'inherit' })
    execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'inherit' })

    const entries = fs.readdirSync(extractDir)
    if (entries.length === 0) throw new Error('公开源码包解压后为空')
    const extractedRoot = path.join(extractDir, entries[0])

    for (const entry of listReplaceableInstallEntries(root)) {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true })
    }
    for (const entry of fs.readdirSync(extractedRoot)) {
      fs.cpSync(path.join(extractedRoot, entry), path.join(root, entry), { recursive: true, force: true })
    }
  } catch (err) {
    console.log(`❌ 公开源码包更新失败: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function cmdUpdate(): Promise<void> {
  const installRoot = currentInstallRoot()
  if (!installRoot) {
    console.log('❌ 无法定位 im2cc 安装目录。请进入仓库目录后重试。')
    process.exit(1)
  }

  const daemonStateBefore = inspectLocalDaemonState()
  const shouldRestartDaemon = daemonStateBefore.kind === 'running' || daemonStateBefore.kind === 'starting'

  console.log(`开始更新 im2cc (${installRoot.root})`)

  try {
    if (installRoot.isGitCheckout) {
      if (!commandExists('git')) {
        console.log('❌ 当前安装目录包含 .git，但本机未安装 git。请先安装 git 后再更新。')
        process.exit(1)
      }
      ensureCleanGitCheckout(installRoot.root)
      console.log('正在拉取最新代码...')
      execFileSync('git', ['pull', '--ff-only'], { cwd: installRoot.root, stdio: 'inherit' })
    } else {
      upgradeFromPublicArchive(installRoot.root)
    }

    console.log('正在重新执行安装脚本...')
    execFileSync('bash', ['install.sh'], { cwd: installRoot.root, stdio: 'inherit' })

    if (shouldRestartDaemon) {
      console.log('检测到守护进程原本正在运行，正在重启...')
      cmdStop()
      await cmdStart()
    } else {
      console.log('守护进程当前未运行，本次不自动启动。')
    }
  } catch (err) {
    console.log(`❌ 更新失败: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  console.log('✅ 更新完成')
  console.log('终端帮助: im2cc help（或重新打开终端后使用 fhelp）')
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
  case 'secure': await cmdSecure(); break
  case 'onboard': cmdOnboard(); break
  case 'install-service': cmdInstallService(); break
  case 'doctor': cmdDoctor(); break
  case 'help': cmdHelp(); break
  case 'fhelp': cmdHelp(); break
  case 'update': await cmdUpdate(); break
  case 'upgrade': await cmdUpdate(); break
  case 'wechat': await cmdWeChat(); break
  case 'fqon': cmdFqOn(); break
  case 'fqoff': cmdFqOff(); break
  case 'fqs': cmdFqStatus(); break
  default:
    console.log(`im2cc — IM to AI coding tools

用法: im2cc <command>

正式支持:
  IM: 飞书 / 微信
  Tool: Claude Code / Codex
  Best-effort: Gemini

对话管理:
  new [--tool <工具>] <名称> [路径]  创建新对话
  connect [名称] [ID前缀]           接入已有对话（别名: open）
  list                              列出所有已注册对话
  show [名称]                       查看对话详情
  delete <名称>                     终止并删除对话
  detach                            从当前 tmux 会话断开

守护进程:
  setup              配置飞书 App 凭证
  secure             配置用户白名单和路径白名单
  onboard            查看首次安装与 post-success 引导
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
  fqon               开启反茄钟
  fqoff              关闭反茄钟
  fqs                查看反茄钟状态
  help               查看统一帮助
  fhelp              查看统一帮助（help 的别名）
  update             更新到最新版本
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

interface ReleaseRemoteBindingOptions {
  interruptInflight?: boolean
}

interface ReleaseRemoteBindingResult {
  conversationId: string | null
  transport: string | null
  interrupted: number
}

/** 解除远程端绑定并通知 IM */
async function releaseRemoteBinding(
  sessionId: string,
  sessionName: string,
  options: ReleaseRemoteBindingOptions = {},
): Promise<ReleaseRemoteBindingResult> {
  const bindings = listActiveBindings()
  const remoteBinding = bindings.find(b => b.sessionId === sessionId)
  if (!remoteBinding) {
    return { conversationId: null, transport: null, interrupted: 0 }
  }

  archiveBinding(remoteBinding.conversationId)
  const shouldInterrupt = options.interruptInflight ?? true
  const interrupted = shouldInterrupt
    ? await interruptInflightTasksForSession(sessionId, remoteBinding.conversationId)
    : 0
  const handoffText = shouldInterrupt
    ? (interrupted > 0
        ? `🔄 "${sessionName}" 已转到电脑端，远程正在执行的任务已停止`
        : `🔄 "${sessionName}" 已转到电脑端`)
    : `🔄 "${sessionName}" 已转到电脑端，当前任务会在电脑端继续处理`

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
          content: JSON.stringify({ text: handoffText }),
        },
      })
    } catch { /* 通知失败不影响主流程 */ }
  }

  const suffix = shouldInterrupt
    ? (interrupted > 0 ? `，并中断了 ${interrupted} 个远程执行任务` : '')
    : '，远程中的当前任务将继续完成'
  console.log(`🔄 已从${remoteBinding.transport ?? '远程'}端断开${suffix}`)
  return {
    conversationId: remoteBinding.conversationId,
    transport: remoteBinding.transport ?? null,
    interrupted,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds} 秒`
  return `${minutes} 分 ${seconds} 秒`
}

function tailLines(text: string, count: number): string[] {
  return text
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .slice(-count)
}

function truncateText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function renderDesktopHandoffProtection(params: {
  sessionName: string
  transportLabel: string
  activeTasks: InflightTaskSnapshot[]
  latestOutput: string
  latestCompletion: CompletedInflightSnapshot | null
  cancelRequested: boolean
}): string {
  const { sessionName, transportLabel, activeTasks, latestOutput, latestCompletion, cancelRequested } = params
  const lines = [`接回保护态 · ${sessionName}`, '']

  if (activeTasks.length > 0) {
    const latestTask = activeTasks.at(-1)!
    lines.push(`状态：${cancelRequested ? '正在中断旧任务' : '执行中'}`)
    lines.push(`来源：${transportLabel}远程指令`)
    lines.push(`已运行：${formatElapsed(Date.now() - Date.parse(latestTask.startedAt))}`)
    if (activeTasks.length > 1) lines.push(`后台任务：${activeTasks.length} 个`)
    lines.push(`指令：${truncateText(latestTask.text, 80)}`)
    lines.push('')
    lines.push('最近输出：')
    const outputLines = tailLines(latestOutput, 8)
    if (outputLines.length > 0) {
      for (const line of outputLines) lines.push(`  ${line}`)
    } else {
      lines.push('  （还没有可展示的输出）')
    }
    lines.push('')
    lines.push(cancelRequested
      ? '提示：正在取消远程旧任务，完成后会立即接回电脑端'
      : '提示：当前任务仍在执行，请不要重复发送相同指令')
    lines.push('操作：等待完成后自动接回 ｜ Ctrl+C 取消旧任务并立即接回')
    return `${lines.join('\n')}\n`
  }

  lines.push(`状态：${latestCompletion?.status === 'interrupted' ? '已中断' : '刚完成'}`)
  if (latestCompletion) {
    lines.push(`来源：${transportLabel}远程指令`)
    lines.push(`指令：${truncateText(latestCompletion.text, 80)}`)
    lines.push('')
    lines.push('结果回显：')
    const outputLines = tailLines(latestCompletion.outputPreview, 8)
    if (outputLines.length > 0) {
      for (const line of outputLines) lines.push(`  ${line}`)
    } else {
      lines.push(`  （${latestCompletion.status === 'interrupted' ? '旧任务已中断，未保留更多输出' : '任务结束，但没有可展示的输出'}）`)
    }
  } else {
    lines.push('结果回显：')
    lines.push('  （任务刚结束，但未读到可展示的结果摘要）')
  }
  lines.push('')
  lines.push('提示：正在切回电脑端对话…')
  return `${lines.join('\n')}\n`
}

async function runDesktopHandoffProtection(
  sessionName: string,
  sessionId: string,
  conversationId?: string | null,
  transport?: string | null,
): Promise<void> {
  const initialTasks = listInflightTasksForSession(sessionId, conversationId ?? undefined)
  if (initialTasks.length === 0) return

  const watchedIds = new Set(initialTasks.map(task => task.id))
  const transportLabel = transport === 'wechat' ? '微信' : '飞书'
  let cancelRequested = false
  let cancelIssued = false
  let latestOutput = initialTasks.at(-1)?.outputText ?? ''
  let lastRendered = ''

  const render = (activeTasks: InflightTaskSnapshot[], latestCompletion: CompletedInflightSnapshot | null) => {
    const panel = renderDesktopHandoffProtection({
      sessionName,
      transportLabel,
      activeTasks,
      latestOutput,
      latestCompletion,
      cancelRequested,
    })
    if (process.stdout.isTTY) {
      console.clear()
      process.stdout.write(panel)
    } else if (panel !== lastRendered) {
      console.log(panel)
    }
    lastRendered = panel
  }

  const onSigint = () => {
    cancelRequested = true
  }
  process.on('SIGINT', onSigint)

  try {
    while (true) {
      let activeTasks = listInflightTasksForSession(sessionId, conversationId ?? undefined)
        .filter(task => watchedIds.has(task.id))
      if (activeTasks.length > 0) {
        latestOutput = activeTasks.at(-1)?.outputText || latestOutput
      }

      if (cancelRequested && activeTasks.length > 0 && !cancelIssued) {
        render(activeTasks, null)
        await interruptInflightTasksForSession(sessionId, conversationId ?? undefined)
        cancelIssued = true
      }

      if (cancelRequested) {
        activeTasks = listInflightTasksForSession(sessionId, conversationId ?? undefined)
          .filter(task => watchedIds.has(task.id))
        if (activeTasks.length > 0) {
          render(activeTasks, null)
          await sleep(300)
          continue
        }
      }

      const latestCompletion = listCompletedInflightSnapshotsForSession(sessionId, conversationId ?? undefined)
        .filter(snapshot => watchedIds.has(snapshot.id))
        .at(-1) ?? null
      render(activeTasks, latestCompletion)
      if (activeTasks.length === 0) break
      await sleep(700)
    }
  } finally {
    process.off('SIGINT', onSigint)
    if (process.stdout.isTTY) process.stdout.write('\n')
  }
}

// ─── 守护进程命令 ────────────────────────────────────

async function cmdStart(): Promise<void> {
  if (!configExists()) {
    console.log('❌ 未配置。请先运行: im2cc setup')
    process.exit(1)
  }

  const state = inspectLocalDaemonState()
  if (state.kind === 'running') {
    console.log(`守护进程已在运行 (PID: ${state.pids.join(', ')})`)
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
  const child = spawn(process.execPath, [mainModule, DAEMON_MARKER], {
    detached: true,
    stdio: 'ignore',
  })
  let childErrorMessage: string | null = null
  let childExited = false
  let childExitCode: number | null = null
  let childExitSignal: NodeJS.Signals | null = null

  child.once('error', err => {
    childErrorMessage = err instanceof Error ? err.message : String(err)
  })
  child.once('exit', (code, signal) => {
    childExited = true
    childExitCode = code
    childExitSignal = signal
  })

  child.unref()

  let runningPids: number[] = []
  for (let i = 0; i < 20; i++) {
    const current = inspectLocalDaemonState()
    if (current.kind === 'running') {
      runningPids = current.pids
      break
    }
    if (current.kind === 'stale') {
      break
    }
    if (childErrorMessage !== null) {
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  if (runningPids.length === 0) {
    const current = inspectLocalDaemonState()
    if (current.kind === 'running') {
      runningPids = current.pids
    }
  }

  if (runningPids.length > 0) {
    console.log(`✅ 守护进程已启动 (PID: ${runningPids.join(', ')})`)
    console.log(`   日志: im2cc logs`)
    return
  }

  if (childErrorMessage !== null) {
    console.log(`❌ 守护进程启动失败: ${childErrorMessage}`)
    process.exit(1)
  }

  if (childExited) {
    const detail = childExitSignal
      ? `signal ${childExitSignal}`
      : `exit code ${childExitCode ?? 0}`
    console.log(`❌ 守护进程启动失败 (${detail})`)
    console.log('   请运行: im2cc logs')
    process.exit(1)
  }

  console.log('⚠️ 启动命令已发出，但尚未确认守护进程就绪')
  console.log('   请运行: im2cc status')
}

function cmdStop(): void {
  const state = inspectLocalDaemonState()
  if (state.kind === 'running') {
    const killedPids: number[] = []
    for (const pid of state.pids) {
      try {
        process.kill(pid, 'SIGTERM')
        killedPids.push(pid)
      } catch {}
    }

    const bindings = listActiveBindings()
    if (bindings.length > 0) {
      console.log(`⚠️ 当前有 ${bindings.length} 个活跃绑定，执行中的任务结果将在下次启动时恢复`)
    }

    cleanupStaleDaemonState()

    if (killedPids.length > 0) {
      console.log(`✅ 已停止守护进程 (PID: ${killedPids.join(', ')})`)
      return
    }
  }

  if (state.kind === 'starting' || state.kind === 'stale') {
    cleanupStaleDaemonState()
    console.log('⬤ 守护进程未运行 (已清理残留状态)')
    return
  }

  console.log('守护进程未运行')
}

function cmdStatus(): void {
  const state = inspectLocalDaemonState()
  const antiPomodoro = getAntiPomodoroSnapshot()
  if (state.kind === 'running') {
    const bindings = listActiveBindings()
    console.log(`🟢 守护进程运行中 (PID: ${state.pids.join(', ')})`)
    console.log(`   活跃绑定: ${bindings.length}`)
    console.log(`   反茄钟: ${antiPomodoro.enabled ? '进行中' : '未开启'}`)
    return
  }
  if (state.kind === 'starting') {
    console.log('🟡 守护进程启动中')
    console.log(`   反茄钟: ${antiPomodoro.enabled ? '进行中' : '未开启'}`)
    return
  }
  if (state.kind === 'stale') {
    cleanupStaleDaemonState()
    console.log('⬤ 守护进程未运行 (已清理残留状态)')
    console.log(`   反茄钟: ${antiPomodoro.enabled ? '进行中' : '未开启'}`)
    return
  }
  console.log('⬤ 守护进程未运行')
  console.log(`   反茄钟: ${antiPomodoro.enabled ? '进行中' : '未开启'}`)
}

function cmdFqOn(): void {
  console.log(enableAntiPomodoro().message)
}

function cmdFqOff(reason?: string): void {
  console.log(disableAntiPomodoro(reason).message)
}

function cmdFqStatus(): void {
  console.log(formatAntiPomodoroStatus(getAntiPomodoroSnapshot()))
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

  let claudeProfile: string | undefined
  if (tool === 'claude' && hasCustomClaudeLauncher(config)) {
    try {
      claudeProfile = selectClaudeProfile(validation.resolvedPath, name, config)
    } catch (err) {
      console.log(`❌ Claude 渠道选择失败: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
  }

  const toolLabel = tool !== 'claude' ? ` [${tool}]` : ''
  console.log(`创建新对话 "${name}"${toolLabel} → ${validation.resolvedPath}...`)
  const autoDisable = disableAntiPomodoro('已回到电脑端工作，反茄钟自动关闭。')
  if (autoDisable.changed) {
    console.log(autoDisable.message)
    console.log('')
  }

  try {
    const driver = getDriver(tool)
    const result = await driver.createSession(validation.resolvedPath, config.defaultPermissionMode ?? 'default', name, { claudeProfile })
    const sessionId = result.sessionId

    registerWithMeta(name, sessionId, validation.resolvedPath, tool, { claudeProfile })

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
      const tmuxArgs = toolResumeArgs(tool, sessionId, name, { claudeProfile })
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
      const tmuxArgs = toolResumeArgs(tool, sessionId, name, { claudeProfile })
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

  const config = loadConfig()
  const pathCheck = validateSessionPathForAttach(session.cwd, config)
  if (!pathCheck.ok) {
    console.log(pathCheck.message)
    return
  }
  session = { ...session, cwd: pathCheck.resolvedPath }
  registerWithMeta(session.name, session.sessionId, session.cwd, session.tool ?? 'claude', { claudeProfile: session.claudeProfile })

  let tool = session.tool ?? 'claude'

  const autoDisable = disableAntiPomodoro('已回到电脑端工作，反茄钟自动关闭。')
  if (autoDisable.changed) {
    console.log(autoDisable.message)
    console.log('')
  }

  // 断开前同步：检查 session 是否漂移（Plan 模式等）
  if (tool === 'claude' || tool === 'codex') {
    const allNames = listRegistered()
    const synced = syncDriftedSession(session.name, session.sessionId, session.cwd, allNames, tool as ToolId)
    if (synced) {
      console.log(`🔄 检测到 session 漂移，已自动同步: ${session.sessionId.slice(0, 8)} → ${synced.slice(0, 8)}`)
      registerWithMeta(session.name, synced, session.cwd, tool as ToolId, { claudeProfile: session.claudeProfile })
      session = { ...session, sessionId: synced }
    }
  }

  const inflightTasks = listInflightTasksForSession(session.sessionId)
  const hasInflight = inflightTasks.length > 0

  // 独占：解绑远程端；如果旧任务仍在执行，则进入保护态而不是直接中断
  const handoff = await releaseRemoteBinding(session.sessionId, session.name, {
    interruptInflight: !hasInflight,
  })
  if (hasInflight) {
    await runDesktopHandoffProtection(
      session.name,
      session.sessionId,
      handoff.conversationId,
      handoff.transport,
    )
  }

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
    ? toolResumeArgs(tool as ToolId, session.sessionId, session.name, { claudeProfile: session.claudeProfile })
    : toolCreateArgs(tool as ToolId, session.sessionId, session.name, { claudeProfile: session.claudeProfile })

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
  const config = loadConfig()
  const pathCheck = validateSessionPathForAttach(match.projectPath, config)

  if (!pathCheck.ok) {
    console.log(pathCheck.message)
    return
  }
  const cwd = pathCheck.resolvedPath

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

  const autoDisable = disableAntiPomodoro('已回到电脑端工作，反茄钟自动关闭。')
  if (autoDisable.changed) {
    console.log(autoDisable.message)
    console.log('')
  }

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

/** im2cc list — 列出所有已注册对话（按飞书/微信/电脑位置聚合） */
function cmdList(): void {
  const all = listRegistered()
  if (all.length === 0) {
    console.log('没有已注册的对话。用 im2cc new <名称> 创建。')
    return
  }

  console.log(renderLocalRegisteredSessionList(all, {
    activeBindings: listActiveBindings(),
    hasLocalWindow: (session) => Boolean(findTmuxSession(session.name, session.tool)),
  }))
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

type LaunchAgentState = 'missing' | 'installed' | 'loaded' | 'unsupported'

interface RuntimeSnapshot {
  config: Im2ccConfig
  wechatBound: boolean
  claudeInstalled: boolean
  codexInstalled: boolean
  geminiInstalled: boolean
  daemonState: DaemonState
  launchAgentState: LaunchAgentState
  registeredCount: number
  bindingCount: number
  firstSessionName: string | null
}

function createPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return {
    ask(question: string): Promise<string> {
      return new Promise(resolve => rl.question(question, resolve))
    },
    close(): void {
      rl.close()
    },
  }
}

function splitCsvList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function detectLaunchAgentState(): LaunchAgentState {
  if (process.platform !== 'darwin') return 'unsupported'

  const plistFile = path.join(os.homedir(), 'Library/LaunchAgents', 'com.im2cc.daemon.plist')
  if (!fs.existsSync(plistFile)) return 'missing'

  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null) {
    try {
      execFileSync('launchctl', ['print', `gui/${uid}/com.im2cc.daemon`], { stdio: 'ignore' })
      return 'loaded'
    } catch {}
  }
  return 'installed'
}

function collectRuntimeSnapshot(): RuntimeSnapshot {
  const config = loadConfig()
  const registered = listRegistered()
  const bindings = listActiveBindings()
  return {
    config,
    wechatBound: Boolean(loadWeChatAccount()?.botToken),
    claudeInstalled: getClaudeVersion() !== 'unknown',
    codexInstalled: commandExists('codex'),
    geminiInstalled: commandExists('gemini'),
    daemonState: inspectLocalDaemonState(),
    launchAgentState: detectLaunchAgentState(),
    registeredCount: registered.length,
    bindingCount: bindings.length,
    firstSessionName: registered[0]?.name ?? null,
  }
}

function preferredFirstSessionCommand(snapshot: RuntimeSnapshot): string {
  if (snapshot.claudeInstalled) return 'fn demo'
  if (snapshot.codexInstalled) return 'fn --tool codex demo'
  return 'fn --tool gemini demo'
}

function needsSecurityReview(config: Im2ccConfig): boolean {
  if (config.allowedUserIds.length === 0) return true
  if (config.pathWhitelist.length !== 1) return true
  return expandPath(config.pathWhitelist[0]) === path.join(os.homedir(), 'Code')
}

function nextActionLines(snapshot: RuntimeSnapshot): string[] {
  const hasCoreTool = snapshot.claudeInstalled || snapshot.codexInstalled
  const hasIm = Boolean(snapshot.config.feishu.appId) || snapshot.wechatBound
  const daemonRunning = snapshot.daemonState.kind === 'running'

  if (!hasCoreTool) {
    return ['先安装并登录 Claude Code 或 Codex，然后重新运行 im2cc onboard']
  }
  if (!hasIm) {
    return ['先选一个 IM：飞书运行 im2cc setup；微信运行 im2cc wechat login']
  }
  if (!daemonRunning) {
    return ['运行 im2cc start']
  }
  if (snapshot.registeredCount === 0) {
    return [`先进入你的项目目录后运行 ${preferredFirstSessionCommand(snapshot)}`]
  }
  if (snapshot.bindingCount === 0 && snapshot.firstSessionName) {
    return [`在飞书或微信里发送 /fc ${snapshot.firstSessionName}`]
  }

  const actions: string[] = []
  if (snapshot.launchAgentState === 'missing' || snapshot.launchAgentState === 'installed') {
    actions.push('运行 im2cc install-service，并按提示加载 LaunchAgent')
  }
  if (needsSecurityReview(snapshot.config)) {
    actions.push('运行 im2cc secure，配置用户白名单和项目路径白名单')
  }
  if (actions.length > 0) return actions
  return ['已经完成首次成功并做过基础加固；后续高频命令见 im2cc help']
}

function cmdOnboard(): void {
  const snapshot = collectRuntimeSnapshot()
  const hasCoreTool = snapshot.claudeInstalled || snapshot.codexInstalled
  const hasIm = Boolean(snapshot.config.feishu.appId) || snapshot.wechatBound
  const daemonRunning = snapshot.daemonState.kind === 'running'
  const hasMobileAttach = daemonRunning && snapshot.bindingCount > 0
  const firstSuccessDone = hasCoreTool && hasIm && daemonRunning && snapshot.registeredCount > 0 && hasMobileAttach

  console.log('im2cc onboarding')
  console.log('─'.repeat(40))
  console.log('Phase 1: First Success')
  console.log(`  ${hasCoreTool ? '✅' : '⬤'} 正式支持工具: Claude Code / Codex`)
  console.log(`  ${hasIm ? '✅' : '⬤'} 至少一个 IM 已配置（飞书或微信）`)
  console.log(`  ${daemonRunning ? '✅' : '⬤'} 守护进程已启动`)
  console.log(`  ${snapshot.registeredCount > 0 ? '✅' : '⬤'} 已创建真实对话`)
  console.log(`  ${hasMobileAttach ? '✅' : '⬤'} 已在手机端接入一次真实对话`)
  console.log('')
  console.log('Phase 2: Make It Stick')
  if (snapshot.launchAgentState === 'unsupported') {
    console.log('  - 当前平台未提供内置开机自启引导')
  } else {
    console.log(`  ${snapshot.launchAgentState === 'loaded' ? '✅' : '⬤'} 开机自启`)
  }
  console.log(`  ${needsSecurityReview(snapshot.config) ? '⬤' : '✅'} 安全加固（用户白名单 / 路径白名单）`)
  console.log('')
  console.log(firstSuccessDone ? '你已经完成第一次成功。' : '先完成一次真实对话流转，再做稳定化配置。')
  console.log('')
  console.log('下一步:')
  for (const line of nextActionLines(snapshot)) {
    console.log(`  - ${line}`)
  }
  console.log('')
  console.log('更多命令:')
  console.log('  - im2cc doctor  # 检查状态并获取下一步建议')
  console.log('  - im2cc help    # 查看高频命令')
}

async function cmdSetup(): Promise<void> {
  const prompt = createPrompt()

  console.log('im2cc 配置向导')
  console.log('─'.repeat(40))
  console.log('请在飞书开放平台创建一个自建应用，获取 App ID 和 App Secret')
  console.log('开放平台: https://open.feishu.cn/app\n')

  const config = loadConfig()

  config.feishu.appId = (await prompt.ask(`飞书 App ID [${config.feishu.appId || '未设置'}]: `)) || config.feishu.appId
  config.feishu.appSecret = (await prompt.ask(`飞书 App Secret [${config.feishu.appSecret ? '****' + config.feishu.appSecret.slice(-4) : '未设置'}]: `)) || config.feishu.appSecret

  prompt.close()

  saveConfig(config)
  console.log(`\n✅ 配置已保存到 ${getConfigDir()}/config.json`)
  console.log('\n下一步:')
  console.log('  1. 把飞书 Bot 加入一个群，并确保权限已发布')
  console.log('  2. 运行 im2cc onboard')
  console.log('  3. 按 onboard 提示完成首次成功、开机自启和安全加固')
}

async function cmdSecure(): Promise<void> {
  const prompt = createPrompt()
  const config = loadConfig()

  console.log('im2cc 安全加固')
  console.log('─'.repeat(40))
  console.log('建议在完成第一次真实对话流转后立刻做这一步。')
  console.log('')

  const currentUsers = config.allowedUserIds.join(',')
  const userIds = await prompt.ask(`允许的用户 ID（逗号分隔；输入 * 表示允许所有人，留空保持不变）[${currentUsers || '所有人'}]: `)
  if (userIds.trim() === '*') {
    config.allowedUserIds = []
  } else if (userIds.trim()) {
    config.allowedUserIds = splitCsvList(userIds)
  }

  const currentPaths = config.pathWhitelist.join(', ')
  const pathWl = await prompt.ask(`路径白名单（逗号分隔；输入 default 恢复 ~/Code，留空保持不变）[${currentPaths}]: `)
  if (pathWl.trim().toLowerCase() === 'default') {
    config.pathWhitelist = [path.join(os.homedir(), 'Code')]
  } else if (pathWl.trim()) {
    config.pathWhitelist = splitCsvList(pathWl)
  }

  prompt.close()

  saveConfig(config)
  console.log('\n✅ 安全配置已保存')
  console.log(`用户白名单: ${config.allowedUserIds.length > 0 ? config.allowedUserIds.join(', ') : '所有人可用'}`)
  console.log(`路径白名单: ${config.pathWhitelist.join(', ')}`)
  console.log('建议再运行一次 im2cc doctor 确认当前状态。')
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
  const snapshot = collectRuntimeSnapshot()
  const config = snapshot.config

  console.log('im2cc 环境检查')
  console.log('─'.repeat(40))

  // AI 编程工具
  const claudeVersion = getClaudeVersion()
  console.log(`claude: ${claudeVersion === 'unknown' ? '⬤ 未安装' : '✅ ' + claudeVersion}`)
  if (claudeVersion !== 'unknown') {
    console.log(`Claude 会话显示名: ${claudeSupportsSessionNameFlag() ? '✅ 支持 --name' : '⚠️ 当前版本不支持 --name，已自动降级'}`)
  }
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
  console.log(`飞书 App ID: ${config.feishu.appId ? '✅ ****' + config.feishu.appId.slice(-4) : '⬤ 未设置'}`)
  console.log(`用户白名单: ${config.allowedUserIds.length > 0 ? '✅ ' + config.allowedUserIds.length + ' 人' : '⚠️ 未设置 (所有人可用)'}`)
  console.log(`路径白名单: ${config.pathWhitelist.join(', ')}`)

  // 注册表 / 活跃绑定
  console.log(`已注册对话: ${snapshot.registeredCount}${snapshot.registeredCount === 0 ? ' (先进入项目目录后用 fn <名称> 创建)' : ''}`)
  console.log(`活跃绑定: ${snapshot.bindingCount}`)
  console.log(`反茄钟: ${getAntiPomodoroSnapshot().enabled ? '✅ 进行中' : '⬤ 未开启'}`)

  // PID 检查
  const daemonState = snapshot.daemonState
  if (daemonState.kind === 'running') {
    console.log(`守护进程: 🟢 运行中 (PID: ${daemonState.pids.join(', ')})`)
  } else if (daemonState.kind === 'starting') {
    console.log('守护进程: 🟡 启动中')
  } else if (daemonState.kind === 'stale') {
    console.log(`守护进程: ⬤ 未运行（检测到当前配置目录残留${daemonState.pid ? ` PID: ${daemonState.pid}` : ' 锁'}）`)
  } else {
    console.log('守护进程: ⬤ 未运行')
  }
  const otherDaemonPids = listDaemonProcessPids(daemonMainModulePath()).filter(pid => daemonState.kind !== 'running' || !daemonState.pids.includes(pid))
  if (otherDaemonPids.length > 0) {
    console.log(`其他 im2cc 守护进程: ⚠️ ${otherDaemonPids.join(', ')} (系统内其他实例)`)
  }

  // 开机自启动（macOS）
  if (snapshot.launchAgentState === 'missing') {
    console.log('开机自启动: ⬤ 未安装 (运行 im2cc install-service)')
  } else if (snapshot.launchAgentState === 'installed') {
    console.log('开机自启动: ⚠️ 已安装但未加载')
  } else if (snapshot.launchAgentState === 'loaded') {
    console.log('开机自启动: ✅ 已安装并加载')
  }

  // 微信
  console.log(`微信 ClawBot: ${snapshot.wechatBound ? '✅ 已绑定' : '⬤ 未绑定 (im2cc wechat login)'}`)

  console.log('\n下一步建议:')
  for (const line of nextActionLines(snapshot)) {
    console.log(`  - ${line}`)
  }
  console.log('  - 需要完整引导时运行 im2cc onboard')
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
