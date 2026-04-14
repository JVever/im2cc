import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-commands-'))
process.env.HOME = testHome

const commands = await import(path.join(rootDir, 'dist', 'src', 'commands.js'))
const configMod = await import(path.join(rootDir, 'dist', 'src', 'config.js'))
const registry = await import(path.join(rootDir, 'dist', 'src', 'registry.js'))
const session = await import(path.join(rootDir, 'dist', 'src', 'session.js'))

function resetState() {
  fs.rmSync(path.join(testHome, '.im2cc'), { recursive: true, force: true })
  fs.rmSync(path.join(testHome, 'Code'), { recursive: true, force: true })
}

function replyText(reply) {
  if (typeof reply === 'string') return reply
  if (reply && typeof reply === 'object' && reply.kind === 'text') return reply.text
  if (reply && typeof reply === 'object' && reply.kind === 'panel') {
    const lines = [reply.title]
    for (const section of reply.sections) {
      if (section.title) lines.push(section.title + '：')
      lines.push(...section.lines)
    }
    return lines.join('\n')
  }
  throw new Error(`Unexpected reply shape: ${JSON.stringify(reply)}`)
}

function configForTests() {
  return {
    ...configMod.loadConfig(),
    pathWhitelist: [path.join(testHome, 'Code')],
    defaultModes: {},
  }
}

function registerSession(name, cwdBase, tool, conversationId, permissionMode = 'default') {
  const cwd = path.join(testHome, 'Code', cwdBase)
  fs.mkdirSync(cwd, { recursive: true })
  registry.register(name, `${name}-session`, cwd, tool)
  session.createBinding(conversationId, `${name}-session`, cwd, permissionMode, 'test-cli', 'feishu', tool)
  return cwd
}

test('help and mode list surface aliases for mobile input', async () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)
  registerSession('alpha', 'im2cc', 'claude', 'conv-help', 'auto')

  const modeCmd = commands.parseCommand('/mode')
  assert.ok(modeCmd)
  const modeOutput = await commands.handleCommand(modeCmd, 'conv-help', config)
  assert.match(modeOutput, /au → auto/)
  assert.match(modeOutput, /bp → bypassPermissions/)
  assert.match(modeOutput, /直接发送 \/mode 查看可用模式/)
  assert.match(modeOutput, /\/mode <模式别名>/)

  const helpCmd = commands.parseCommand('/fhelp')
  assert.ok(helpCmd)
  const helpOutput = await commands.handleCommand(helpCmd, 'conv-help', config)
  assert.match(helpOutput, /首次使用：先在电脑终端运行 fn <名称>/)
  assert.match(helpOutput, /fhelp\s+— 查看帮助/)
  assert.match(helpOutput, /im2cc update\s+— 更新到最新版本/)
  assert.match(helpOutput, /fn <名称>\s+— 用当前目录创建对话/)
  assert.match(helpOutput, /fn-codex <名称>/)
  assert.match(helpOutput, /fn-gemini <名称>/)
  assert.match(helpOutput, /\/fhelp\s+— 查看帮助/)
  assert.match(helpOutput, /\/fc <名称>\s+— 接入已有对话/)
  assert.match(helpOutput, /\/mode\s+— 查看可用模式/)
  assert.match(helpOutput, /\/mode <模式别名>/)
  assert.match(helpOutput, /例如 \/mode au/)
  assert.match(helpOutput, /fqon\s+— 开启反茄钟/)
  assert.match(helpOutput, /fqoff\s+— 关闭反茄钟/)
  assert.match(helpOutput, /\/fqon\s+— 开启反茄钟/)
  assert.match(helpOutput, /\/fqs\s+— 查看反茄钟状态/)
  assert.match(helpOutput, /飞书支持发送图片或文件；发送后再补一条指令即可让当前接入的 AI 工具分析/)
  assert.match(helpOutput, /微信当前以纯文本对话为主/)
  assert.doesNotMatch(helpOutput, /\/fn <名称> <项目>/)
  assert.doesNotMatch(helpOutput, /\/fc <名称> <ID前缀>/)

  const legacyHelpCmd = commands.parseCommand('/help')
  assert.ok(legacyHelpCmd)
  const legacyHelpOutput = await commands.handleCommand(legacyHelpCmd, 'conv-help', config)
  assert.equal(legacyHelpOutput, helpOutput)
})

test('mode aliases switch current session mode and default mode', async () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)
  registerSession('alpha', 'im2cc', 'claude', 'conv-mode', 'default')

  const switchCmd = commands.parseCommand('/mode au')
  assert.ok(switchCmd)
  const switchOutput = await commands.handleCommand(switchCmd, 'conv-mode', config)
  assert.match(switchOutput, /模式已切换为 auto/)
  assert.equal(session.getBinding('conv-mode')?.permissionMode, 'auto')
  assert.equal(registry.lookup('alpha')?.permissionMode, 'auto')

  const defaultCmd = commands.parseCommand('/mode default ae')
  assert.ok(defaultCmd)
  const defaultOutput = await commands.handleCommand(defaultCmd, 'conv-mode', configMod.loadConfig())
  assert.match(defaultOutput, /默认模式已设为 acceptEdits/)
  assert.equal(configMod.getDefaultMode('claude', configMod.loadConfig()), 'acceptEdits')
})

test('anti-pomodoro IM commands expose on/status and block mobile off', async () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)

  const onCmd = commands.parseCommand('/fqon')
  assert.ok(onCmd)
  const onOutput = await commands.handleCommand(onCmd, 'conv-rest', config)
  assert.match(onOutput, /已开启反茄钟/)
  assert.match(onOutput, /阶段：等待开始/)
  assert.match(onOutput, /发送下一条工作消息后开始 5 分钟工作时间/)
  assert.match(onOutput, /范围：飞书、微信、不同对话全局共享/)

  const statusCmd = commands.parseCommand('/fqs')
  assert.ok(statusCmd)
  const statusOutput = await commands.handleCommand(statusCmd, 'conv-rest', config)
  assert.match(statusOutput, /^反茄钟/m)
  assert.match(statusOutput, /状态：进行中/)
  assert.match(statusOutput, /阶段：等待开始/)
  assert.match(statusOutput, /关闭：电脑端 fqoff/)

  const offCmd = commands.parseCommand('/fqoff')
  assert.ok(offCmd)
  const offOutput = await commands.handleCommand(offCmd, 'conv-rest', config)
  assert.match(offOutput, /不能在手机端关闭反茄钟/)
  assert.match(offOutput, /关闭：请回到电脑端执行 fqoff/)
})

test('/fl groups sessions by tool, sorts names, and keeps cwd basename', async () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)
  registerSession('zebra', 'website', 'codex', 'conv-zebra')
  registerSession('beta', 'portal', 'claude', 'conv-beta')
  registerSession('alpha', 'im2cc', 'claude', 'conv-alpha')

  const flCmd = commands.parseCommand('/fl')
  assert.ok(flCmd)
  const output = await commands.handleCommand(flCmd, 'conv-alpha', config)

  assert.match(output, /📋 已注册的对话 \(3\):/)
  assert.match(output, /── Claude ──/)
  assert.match(output, /── Codex ──/)
  assert.match(output, /alpha \(im2cc\)/)
  assert.match(output, /beta \(portal\)/)
  assert.match(output, /zebra \(website\)/)

  const claudeIndex = output.indexOf('── Claude ──')
  const codexIndex = output.indexOf('── Codex ──')
  const alphaIndex = output.indexOf('  alpha (im2cc)')
  const betaIndex = output.indexOf('  beta (portal)')
  assert.ok(claudeIndex >= 0 && codexIndex > claudeIndex, 'tool sections should follow stable display order')
  assert.ok(alphaIndex > claudeIndex && betaIndex > alphaIndex, 'Claude sessions should sort by name')
})

test('local registered session list renders concise placement labels only', () => {
  resetState()

  const registered = [
    {
      name: 'rew',
      sessionId: 'rew-session',
      cwd: path.join(testHome, 'Code', 'remote-work'),
      tool: 'claude',
    },
    {
      name: 'spark',
      sessionId: 'spark-session',
      cwd: path.join(testHome, 'Code', 'spark-chat'),
      tool: 'codex',
    },
    {
      name: 'myskill',
      sessionId: 'myskill-session',
      cwd: path.join(testHome, 'Code', 'writing-style'),
      tool: 'codex',
    },
  ]

  const output = commands.renderLocalRegisteredSessionList(registered, {
    activeBindings: [
      { sessionId: 'rew-session', transport: 'feishu' },
      { sessionId: 'myskill-session', transport: 'wechat' },
    ],
    hasLocalWindow: (sessionInfo) => sessionInfo.name === 'spark' || sessionInfo.name === 'rew',
  })

  assert.match(output, /^已注册的对话 \(3\)/)
  assert.match(output, /── Claude ──/)
  assert.match(output, /── Codex ──/)
  assert.match(output, /rew\s+\(remote-work\s*\)\s+飞书 电脑/)
  assert.match(output, /myskill\s+\(writing-style\s*\)\s+微信/)
  assert.match(output, /spark\s+\(spark-chat\s*\)\s+电脑/)
  assert.doesNotMatch(output, /本地状态/)
  assert.doesNotMatch(output, /活跃|休眠/)
  assert.doesNotMatch(output, /\[[0-9a-f]{8}\]/)
})

test('/fc on an already bound chat explains the current session and switch steps', async () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)
  registerSession('alpha', 'portal', 'codex', 'conv-switch')

  const fcCmd = commands.parseCommand('/fc spark')
  assert.ok(fcCmd)
  const output = await commands.handleCommand(fcCmd, 'conv-switch', config)

  assert.match(output, /当前聊天已连接到 Codex 对话「alpha」 \(portal\)。/)
  assert.match(output, /如需切换到「spark」，请先发送 \/fd 断开当前连接，再发送 \/fc spark。/)
  assert.doesNotMatch(output, /最近一轮对话/)
})

test('first-run guidance prefers computer-side creation and IM /fn requires explicit project', async () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)

  fs.mkdirSync(path.join(testHome, 'Code', 'im2cc'), { recursive: true })
  fs.mkdirSync(path.join(testHome, 'Code', 'portal'), { recursive: true })

  const flCmd = commands.parseCommand('/fl')
  assert.ok(flCmd)
  const flOutput = await commands.handleCommand(flCmd, 'conv-empty', config)
  assert.match(flOutput, /还没有已注册的对话/)
  assert.match(flOutput, /电脑终端运行 fn <名称> 创建第一个对话/)
  assert.match(flOutput, /\/fc <名称> 接入/)
  assert.doesNotMatch(flOutput, /用 \/fn <名称> 创建/)

  const fnCmd = commands.parseCommand('/fn demo')
  assert.ok(fnCmd)
  const fnReply = await commands.handleCommand(fnCmd, 'conv-empty', config)
  const fnOutput = replyText(fnReply)
  assert.match(fnOutput, /📝 缺少项目目录/)
  assert.match(fnOutput, /用法：\/fn <对话名> <项目目录>/)
  assert.match(fnOutput, /示例：\/fn demo im2cc/)
  assert.match(fnOutput, /项目目录：告诉 AI 去哪个目录工作/)
  assert.match(fnOutput, /查看全部项目目录：\/ls/)
  assert.match(fnOutput, /当前工作区：~\/Code/)
})

test('/fn with no args shows usage card, not project list', async () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)

  fs.mkdirSync(path.join(testHome, 'Code', 'im2cc'), { recursive: true })
  fs.mkdirSync(path.join(testHome, 'Code', 'portal'), { recursive: true })

  const fnCmd = commands.parseCommand('/fn')
  assert.ok(fnCmd)
  const reply = await commands.handleCommand(fnCmd, 'conv-usage', config)
  assert.equal(reply && reply.kind, 'text', '/fn 无参应返回纯文本消息绕过 panel markdown')
  const out = replyText(reply)
  assert.match(out, /📝 创建新对话/)
  assert.match(out, /用法：\/fn <对话名> <项目目录>/)
  assert.match(out, /示例：\/fn auth im2cc/)
  assert.match(out, /对话名.*给这次对话起的标签/)
  assert.match(out, /项目目录.*告诉 AI 去哪个目录工作/)
  assert.match(out, /查看全部项目目录：\/ls/)
  assert.match(out, /当前工作区：~\/Code/)
  // 教学卡片不应当场列出项目
  assert.doesNotMatch(out, /^im2cc$/m)
  assert.doesNotMatch(out, /^portal$/m)
})

test('/ls lists projects one per line as plain text', async () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)

  fs.mkdirSync(path.join(testHome, 'Code', 'im2cc'), { recursive: true })
  fs.mkdirSync(path.join(testHome, 'Code', 'portal'), { recursive: true })
  fs.mkdirSync(path.join(testHome, 'Code', 'aicam'), { recursive: true })

  const lsCmd = commands.parseCommand('/ls')
  assert.ok(lsCmd)
  const reply = await commands.handleCommand(lsCmd, 'conv-ls', config)
  assert.equal(reply && reply.kind, 'text', '/ls 必须返回纯文本，否则飞书会渲染成大间距列表')
  const out = replyText(reply)
  assert.match(out, /📁 可用项目目录 \(3\)/)
  assert.match(out, /工作区：~\/Code/)
  assert.match(out, /^aicam$/m)
  assert.match(out, /^im2cc$/m)
  assert.match(out, /^portal$/m)
  assert.match(out, /用法：\/fn <对话名> <项目目录>/)
})

test('/ls on empty workspace explains what to do', async () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)

  const lsCmd = commands.parseCommand('/ls')
  const reply = await commands.handleCommand(lsCmd, 'conv-ls-empty', config)
  const out = replyText(reply)
  assert.match(out, /📁 工作区下还没有项目目录/)
  assert.match(out, /工作区：~\/Code/)
})

test('/fn with unknown project suggests similar names', async () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)

  fs.mkdirSync(path.join(testHome, 'Code', 'im2cc'), { recursive: true })
  fs.mkdirSync(path.join(testHome, 'Code', 'aicam'), { recursive: true })

  const fnCmd = commands.parseCommand('/fn demo im2ccx')
  const reply = await commands.handleCommand(fnCmd, 'conv-typo', config)
  const out = replyText(reply)
  assert.match(out, /❌ 没找到项目目录 "im2ccx"/)
  assert.match(out, /相近的有：im2cc/)
  assert.match(out, /列出全部：\/ls/)
})
