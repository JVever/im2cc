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
  assert.match(helpOutput, /im2cc upgrade\s+— 升级到最新版本/)
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
  assert.match(onOutput, /反茄钟已开启/)
  assert.match(onOutput, /当前阶段: 工作时间/)

  const statusCmd = commands.parseCommand('/fqs')
  assert.ok(statusCmd)
  const statusOutput = await commands.handleCommand(statusCmd, 'conv-rest', config)
  assert.match(statusOutput, /反茄钟进行中/)
  assert.match(statusOutput, /关闭方式: 只能在电脑端 fqoff/)

  const offCmd = commands.parseCommand('/fqoff')
  assert.ok(offCmd)
  const offOutput = await commands.handleCommand(offCmd, 'conv-rest', config)
  assert.match(offOutput, /只能在电脑端关闭/)
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
  const fnOutput = await commands.handleCommand(fnCmd, 'conv-empty', config)
  assert.match(fnOutput, /请指定项目名/)
  assert.match(fnOutput, /📁 可用项目:/)
  assert.match(fnOutput, /im2cc/)
  assert.match(fnOutput, /portal/)
  assert.match(fnOutput, /\/fn <对话名称> <项目名>/)
})
