import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const launcherModuleUrl = pathToFileURL(path.join(rootDir, 'dist', 'src', 'claude-launcher.js')).href

function writeLauncherScript(scriptPath, profile = 'glm') {
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
if (process.argv[2] === '--im2cc-select-profile') {
  process.stdout.write('${profile}\\n')
  process.exit(0)
}
if (process.argv[2] === '--help') {
  process.stdout.write('--name\\n')
  process.exit(0)
}
if (process.argv[2] === '--version') {
  process.stdout.write('mock-claude 1.0.0\\n')
  process.exit(0)
}
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n')
`, { mode: 0o755 })
}

test('claude launcher defaults to bare claude when no local override is configured', async () => {
  const launcher = await import(`${launcherModuleUrl}?case=default`)
  const config = { feishu: { appId: '', appSecret: '' }, claudeLauncher: '' }
  assert.equal(launcher.getClaudeLauncher(config), 'claude')
  assert.equal(launcher.hasCustomClaudeLauncher(config), false)
  assert.equal(launcher.buildClaudeLauncherEnv({ phase: 'send', sessionId: 'sid' }, config), undefined)
})

test('claude launcher resolves configured local launcher and can select a profile', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-launcher-custom-'))
  const launcherPath = path.join(tempHome, 'mock-claude-launcher')
  writeLauncherScript(launcherPath, 'kimi')

  try {
    const launcher = await import(`${launcherModuleUrl}?case=custom`)
    const config = { feishu: { appId: '', appSecret: '' }, claudeLauncher: launcherPath }
    assert.equal(launcher.hasCustomClaudeLauncher(config), true)
    assert.equal(launcher.getClaudeLauncher(config), launcherPath)
    assert.equal(launcher.selectClaudeProfile(tempHome, 'demo', config), 'kimi')
    assert.deepEqual(
      launcher.buildClaudeInteractiveCommand(
        ['--resume', 'sid-9'],
        { phase: 'resume', sessionId: 'sid-9', sessionName: 'demo', profile: 'kimi' },
        config,
      ),
      [
        'env',
        'IM2CC_CLAUDE_PHASE=resume',
        'IM2CC_CLAUDE_SESSION_ID=sid-9',
        'IM2CC_CLAUDE_SESSION_NAME=demo',
        'IM2CC_CLAUDE_PROFILE=kimi',
        launcherPath,
        '--resume',
        'sid-9',
      ],
    )
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})
