import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = path.join(rootDir, 'dist', 'bin', 'im2cc.js')
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-security-'))
process.env.HOME = testHome

const security = await import(path.join(rootDir, 'dist', 'src', 'security.js'))
const discover = await import(path.join(rootDir, 'dist', 'src', 'discover.js'))
const commands = await import(path.join(rootDir, 'dist', 'src', 'commands.js'))
const configMod = await import(path.join(rootDir, 'dist', 'src', 'config.js'))
const registry = await import(path.join(rootDir, 'dist', 'src', 'registry.js'))

function resetState() {
  fs.rmSync(path.join(testHome, '.im2cc'), { recursive: true, force: true })
  fs.rmSync(path.join(testHome, '.claude'), { recursive: true, force: true })
  fs.rmSync(path.join(testHome, 'Code'), { recursive: true, force: true })
  fs.rmSync(path.join(testHome, 'Elsewhere'), { recursive: true, force: true })
  fs.rmSync(path.join(testHome, 'CodeX'), { recursive: true, force: true })
}

function configForTests() {
  return {
    ...configMod.loadConfig(),
    allowedUserIds: [],
    pathWhitelist: [path.join(testHome, 'Code')],
    defaultModes: {},
  }
}

function writeDiscoveredClaudeSession(projectPath, sessionId, firstMessage = 'hello') {
  const slug = discover.pathToSlug(projectPath)
  const sessionDir = path.join(testHome, '.claude', 'projects', slug)
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), `${JSON.stringify({
    type: 'user',
    message: { content: firstMessage },
  })}\n`)
}

test('isUserAllowed respects allow-all and explicit whitelist', () => {
  resetState()
  const config = configForTests()

  assert.equal(security.isUserAllowed('user-a', config), true)

  config.allowedUserIds = ['user-a', 'user-b']
  assert.equal(security.isUserAllowed('user-a', config), true)
  assert.equal(security.isUserAllowed('user-c', config), false)
})

test('validatePath allows whitelisted directories and rejects escapes', () => {
  resetState()
  const config = configForTests()
  const root = path.join(testHome, 'Code')
  const child = path.join(root, 'project-a')
  const sibling = path.join(testHome, 'CodeX')
  const outside = path.join(testHome, 'Elsewhere', 'secret')
  const filePath = path.join(root, 'README.md')
  const symlinkPath = path.join(root, 'escape-link')

  fs.mkdirSync(child, { recursive: true })
  fs.mkdirSync(sibling, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(filePath, 'hello')
  fs.symlinkSync(outside, symlinkPath)

  assert.equal(security.validatePath(root, config).valid, true)
  assert.equal(security.validatePath(child, config).valid, true)
  assert.equal(security.validatePath(sibling, config).valid, false)
  assert.match(security.validatePath(sibling, config).error ?? '', /路径不在白名单内/)
  assert.equal(security.validatePath(filePath, config).valid, false)
  assert.match(security.validatePath(filePath, config).error ?? '', /不是目录/)
  assert.equal(security.validatePath(path.join(root, 'missing-dir'), config).valid, false)
  assert.match(security.validatePath(path.join(root, 'missing-dir'), config).error ?? '', /路径不存在/)
  assert.equal(security.validatePath(symlinkPath, config).valid, false)
  assert.match(security.validatePath(symlinkPath, config).error ?? '', /路径不在白名单内/)
})

test('/fc rejects registered sessions outside path whitelist', async () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)

  const outside = path.join(testHome, 'Elsewhere', 'secret')
  fs.mkdirSync(outside, { recursive: true })
  registry.register('bad', 'bad-session', outside, 'claude')

  const cmd = commands.parseCommand('/fc bad')
  assert.ok(cmd)
  const output = await commands.handleCommand(cmd, 'conv-bad', config)

  assert.match(output, /路径不在白名单内/)
  assert.match(output, /调整工作区（路径白名单）/)
  assert.doesNotMatch(output, /已接入/)
})

test('/fc <newName> <ID前缀> rejects discovered sessions outside path whitelist', async () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)

  const outside = path.join(testHome, 'Elsewhere', 'secret')
  fs.mkdirSync(outside, { recursive: true })
  writeDiscoveredClaudeSession(outside, '12345678-aaaa-bbbb-cccc-1234567890ab')

  const cmd = commands.parseCommand('/fc imported 12345678')
  assert.ok(cmd)
  const output = await commands.handleCommand(cmd, 'conv-discovered', config)

  assert.match(output, /路径不在白名单内/)
  assert.match(output, /调整工作区（路径白名单）/)
})

test('im2cc connect rejects registered sessions outside path whitelist', () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)

  const outside = path.join(testHome, 'Elsewhere', 'secret')
  fs.mkdirSync(outside, { recursive: true })
  registry.register('bad-local', 'bad-local-session', outside, 'claude')

  const stdout = execFileSync('node', [cliPath, 'connect', 'bad-local'], {
    cwd: rootDir,
    env: { ...process.env, HOME: testHome },
    encoding: 'utf-8',
  })

  assert.match(stdout, /路径不在白名单内/)
  assert.match(stdout, /调整工作区（路径白名单）/)
})

test('im2cc connect <newName> <ID前缀> rejects discovered sessions outside path whitelist', () => {
  resetState()
  const config = configForTests()
  configMod.saveConfig(config)

  const outside = path.join(testHome, 'Elsewhere', 'secret')
  fs.mkdirSync(outside, { recursive: true })
  writeDiscoveredClaudeSession(outside, '87654321-aaaa-bbbb-cccc-1234567890ab')

  const stdout = execFileSync('node', [cliPath, 'connect', 'imported-local', '87654321'], {
    cwd: rootDir,
    env: { ...process.env, HOME: testHome },
    encoding: 'utf-8',
  })

  assert.match(stdout, /路径不在白名单内/)
  assert.match(stdout, /调整工作区（路径白名单）/)
})
