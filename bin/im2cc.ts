#!/usr/bin/env node
/**
 * @input:    CLI 参数 (start/stop/status/logs/sessions/setup/install-service/doctor)
 * @output:   守护进程管理和运维命令
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync, fork } from 'node:child_process'
import { loadConfig, saveConfig, configExists, getPidFile, getLogDir, getConfigDir, type Im2ccConfig } from '../src/config.js'
import { listActiveBindings } from '../src/session.js'
import { getClaudeVersion, createSession } from '../src/claude-driver.js'
import { register, lookup, listRegistered } from '../src/registry.js'
import { expandPath, validatePath } from '../src/security.js'
import readline from 'node:readline'

const command = process.argv[2]

switch (command) {
  case 'start': await cmdStart(); break
  case 'stop': cmdStop(); break
  case 'status': cmdStatus(); break
  case 'logs': cmdLogs(); break
  case 'sessions': cmdSessions(); break
  case 'new': await cmdNew(); break
  case 'open': cmdOpen(); break
  case 'list': cmdList(); break
  case 'setup': await cmdSetup(); break
  case 'install-service': cmdInstallService(); break
  case 'doctor': cmdDoctor(); break
  default:
    console.log(`im2cc — IM to Claude Code

用法: im2cc <command>

对话管理:
  new <名称> [路径]  创建新对话（类似 tnh）
  open <名称>        打开已有对话（类似 tc）
  list               列出所有已注册对话

守护进程:
  setup              配置飞书 App 凭证
  start              启动守护进程
  stop               停止守护进程
  status             查看运行状态
  logs               查看日志

运维:
  sessions           列出飞书活跃绑定
  install-service    安装 macOS 开机自启
  doctor             检查环境
`)
}

async function cmdStart(): Promise<void> {
  if (!configExists()) {
    console.log('❌ 未配置。请先运行: im2cc setup')
    process.exit(1)
  }

  const pidFile = getPidFile()
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim())
    try { process.kill(pid, 0); console.log(`守护进程已在运行 (PID: ${pid})`); return } catch { /* 旧 PID，继续 */ }
  }

  console.log('启动 im2cc 守护进程...')

  const mainModule = path.resolve(import.meta.dirname, '../src/index.js')
  const child = fork(mainModule, [], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })

  child.unref()

  if (child.pid) {
    fs.writeFileSync(pidFile, String(child.pid))
    console.log(`✅ 守护进程已启动 (PID: ${child.pid})`)
    console.log(`   日志: im2cc logs`)
  }

  child.disconnect()
}

function cmdStop(): void {
  const pidFile = getPidFile()
  if (!fs.existsSync(pidFile)) {
    console.log('守护进程未运行')
    return
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim())
  try {
    process.kill(pid, 'SIGTERM')
    fs.unlinkSync(pidFile)
    console.log(`✅ 守护进程已停止 (PID: ${pid})`)
  } catch {
    fs.unlinkSync(pidFile)
    console.log('守护进程已不存在，已清理 PID 文件')
  }
}

function cmdStatus(): void {
  const pidFile = getPidFile()
  if (!fs.existsSync(pidFile)) {
    console.log('⬤ 守护进程未运行')
    return
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim())
  try {
    process.kill(pid, 0)
    const bindings = listActiveBindings()
    console.log(`🟢 守护进程运行中 (PID: ${pid})`)
    console.log(`   活跃绑定: ${bindings.length}`)
  } catch {
    console.log('⬤ 守护进程未运行 (PID 文件残留)')
    fs.unlinkSync(pidFile)
  }
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
    console.log('没有飞书活跃绑定')
    return
  }

  console.log('飞书活跃绑定:')
  for (const b of bindings) {
    console.log(`  ${path.basename(b.cwd)} → ${b.sessionId.slice(0, 8)}...`)
  }
}

/** im2cc new <名称> [路径] — 创建新对话并注册（类似 tnh） */
async function cmdNew(): Promise<void> {
  const name = process.argv[3]
  const pathArg = process.argv[4]

  if (!name) {
    console.log('用法: im2cc new <对话名称> [项目路径]')
    console.log('例如: im2cc new auth-refactor ~/Code/im2cc')
    console.log('      im2cc new bugfix       (使用当前目录)')
    return
  }

  // 检查名称是否已存在
  const existing = lookup(name)
  if (existing) {
    console.log(`"${name}" 已存在。用 im2cc open ${name} 打开，或换个名称。`)
    return
  }

  const cwd = pathArg ? expandPath(pathArg) : process.cwd()

  const config = loadConfig()
  const validation = validatePath(cwd, config)
  if (!validation.valid) {
    console.log(`❌ ${validation.error}`)
    return
  }

  console.log(`创建新对话 "${name}" → ${validation.resolvedPath}...`)

  try {
    const { sessionId } = await createSession(validation.resolvedPath, config.defaultPermissionMode, name)
    register(name, sessionId, validation.resolvedPath)
    console.log(`✅ 已创建 "${name}"`)
    console.log(`   打开: im2cc open ${name}`)
    console.log(`   飞书: /attach ${name}`)
  } catch (err) {
    console.error(`❌ 创建失败: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** im2cc open <名称> — 打开已有对话（类似 tc） */
function cmdOpen(): void {
  const target = process.argv[3]

  if (!target) {
    // 列出所有对话供选择
    const all = listRegistered()
    if (all.length === 0) {
      console.log('没有已注册的对话。用 im2cc new <名称> 创建。')
      return
    }
    console.log('已注册的对话:')
    for (const s of all) {
      console.log(`  ${s.name} (${path.basename(s.cwd)})`)
    }
    console.log(`\nim2cc open <名称> 打开`)
    return
  }

  const session = lookup(target)
  if (!session) {
    console.log(`未找到 "${target}"`)
    const all = listRegistered()
    if (all.length > 0) {
      console.log('可用对话:')
      for (const s of all) console.log(`  ${s.name}`)
    }
    return
  }

  console.log(`打开 "${session.name}" (${path.basename(session.cwd)})...`)
  execSync(`claude --resume ${session.sessionId}`, { stdio: 'inherit', cwd: session.cwd })
}

/** im2cc list — 列出所有已注册对话 */
function cmdList(): void {
  const all = listRegistered()
  if (all.length === 0) {
    console.log('没有已注册的对话。用 im2cc new <名称> 创建。')
    return
  }

  console.log('已注册的对话:')
  console.log('─'.repeat(50))
  for (const s of all) {
    console.log(`  📛 ${s.name}`)
    console.log(`     📁 ${path.basename(s.cwd)} (${s.cwd})`)
    console.log(`     打开: im2cc open ${s.name}`)
    console.log(`     飞书: /attach ${s.name}`)
    console.log('─'.repeat(50))
  }
}

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
  console.log('  2. 添加权限: im:message:send_as_bot, im:message, im:message.group_at_msg:readonly')
  console.log('  3. 启用 WebSocket 模式 (事件与回调 → 长连接)')
  console.log('  4. 发布应用')
  console.log('  5. 运行 im2cc start')
}

function cmdInstallService(): void {
  const plistDir = path.join(os.homedir(), 'Library/LaunchAgents')
  const plistFile = path.join(plistDir, 'com.im2cc.daemon.plist')

  // 找到 im2cc 的安装路径
  let binPath: string
  try {
    binPath = execSync('which im2cc', { encoding: 'utf-8' }).trim()
  } catch {
    binPath = path.resolve(import.meta.dirname, '../../dist/bin/im2cc.js')
  }

  const logDir = getLogDir()
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.im2cc.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${binPath}</string>
    <string>start</string>
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

  // Claude Code
  const claudeVersion = getClaudeVersion()
  console.log(`Claude Code: ${claudeVersion === 'unknown' ? '❌ 未找到' : '✅ ' + claudeVersion}`)

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
  const pidFile = getPidFile()
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim())
    try { process.kill(pid, 0); console.log(`守护进程: 🟢 运行中 (PID: ${pid})`) }
    catch { console.log('守护进程: ⬤ 未运行 (PID 文件残留)') }
  } else {
    console.log('守护进程: ⬤ 未运行')
  }
}
