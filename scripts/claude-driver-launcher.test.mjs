import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function writeMockClaudeLauncher(scriptPath, logPath) {
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--im2cc-select-profile') {
  process.stdout.write('glm\\n')
  process.exit(0)
}
if (args[0] === '--help') {
  process.stdout.write('--name\\n')
  process.exit(0)
}
if (args[0] === '--version') {
  process.stdout.write('mock-claude 1.0.0\\n')
  process.exit(0)
}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  phase: process.env.IM2CC_CLAUDE_PHASE || '',
  sessionId: process.env.IM2CC_CLAUDE_SESSION_ID || '',
  sessionName: process.env.IM2CC_CLAUDE_SESSION_NAME || '',
  profile: process.env.IM2CC_CLAUDE_PROFILE || '',
  args,
}) + '\\n')
process.stdout.write(JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'mock ok' }] }
}) + '\\n')
`, { mode: 0o755 })
}

test('ClaudeDriver uses configured launcher and reuses stored profile for follow-up sends', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-claude-driver-'))
  const launcherPath = path.join(tempHome, 'mock-claude-launcher')
  const logPath = path.join(tempHome, 'launcher.log')
  writeMockClaudeLauncher(launcherPath, logPath)
  fs.mkdirSync(path.join(tempHome, '.im2cc'), { recursive: true })
  fs.writeFileSync(path.join(tempHome, '.im2cc', 'config.json'), JSON.stringify({
    feishu: { appId: '', appSecret: '' },
    claudeLauncher: '',
  }))

  try {
    const script = `
      const { pathToFileURL } = require('node:url')
      const path = require('node:path')
      const rootDir = ${JSON.stringify(rootDir)}
      const driverModuleUrl = pathToFileURL(path.join(rootDir, 'dist', 'src', 'claude-driver.js')).href
      const registryModuleUrl = pathToFileURL(path.join(rootDir, 'dist', 'src', 'registry.js')).href
      const run = async () => {
        const driverModule = await import(driverModuleUrl + '?case=launcher-subprocess')
        const registry = await import(registryModuleUrl + '?case=launcher-subprocess')
        const cwd = ${JSON.stringify(tempHome)}
        const result = await driverModule.createSession(cwd, 'default', 'demo', { claudeProfile: 'glm' })
        registry.registerWithMeta('demo', result.sessionId, cwd, 'claude', { claudeProfile: 'glm' })
        const reply = await driverModule.sendMessage(result.sessionId, '继续', cwd, 'default')
        process.stdout.write(JSON.stringify({ sessionId: result.sessionId, output: result.output, reply }))
      }
      run().catch((err) => {
        console.error(err)
        process.exit(1)
      })
    `
    const stdout = execFileSync('node', ['--input-type=commonjs', '-e', script], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: tempHome,
        IM2CC_CLAUDE_LAUNCHER: launcherPath,
        IM2CC_CLAUDE_SUPPORTS_NAME: '1',
      },
    }).trim()

    const result = JSON.parse(stdout)
    assert.match(result.output, /mock ok/)
    assert.match(result.reply, /mock ok/)

    const logs = fs.readFileSync(logPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(logs.length, 2)
    assert.equal(logs[0].phase, 'create')
    assert.equal(logs[0].profile, 'glm')
    assert.ok(logs[0].args.includes('--session-id'))
    assert.equal(logs[1].phase, 'send')
    assert.equal(logs[1].profile, 'glm')
    assert.ok(logs[1].args.includes('--session-id'))
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})
