import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const cliArgsModuleUrl = pathToFileURL(path.join(rootDir, 'dist', 'src', 'tool-cli-args.js')).href
const compatModuleUrl = pathToFileURL(path.join(rootDir, 'dist', 'src', 'tool-compat.js')).href

test('claude --name support is optional and can be disabled', async () => {
  process.env.IM2CC_CLAUDE_SUPPORTS_NAME = '0'
  process.env.IM2CC_CLAUDE_LAUNCHER = 'claude'
  const compat = await import(`${compatModuleUrl}?case=no-name`)
  const cliArgs = await import(`${cliArgsModuleUrl}?case=no-name`)

  assert.equal(compat.claudeSupportsSessionNameFlag(), false)
  assert.deepEqual(compat.claudeSessionNameArgs('demo'), [])
  assert.deepEqual(cliArgs.toolCreateArgs('claude', 'sid-0', 'demo'), ['claude', '--session-id', 'sid-0', '--dangerously-skip-permissions'])
  assert.deepEqual(cliArgs.toolResumeArgs('claude', 'sid-0', 'demo'), ['claude', '--resume', 'sid-0', '--dangerously-skip-permissions'])

  delete process.env.IM2CC_CLAUDE_SUPPORTS_NAME
  delete process.env.IM2CC_CLAUDE_LAUNCHER
})

test('claude --name support can be forced on when available', async () => {
  process.env.IM2CC_CLAUDE_SUPPORTS_NAME = '1'
  process.env.IM2CC_CLAUDE_LAUNCHER = 'claude'
  const compat = await import(`${compatModuleUrl}?case=with-name`)
  const cliArgs = await import(`${cliArgsModuleUrl}?case=with-name`)

  assert.equal(compat.claudeSupportsSessionNameFlag(), true)
  assert.deepEqual(compat.claudeSessionNameArgs('demo'), ['--name', 'im2cc:demo'])
  assert.deepEqual(cliArgs.toolCreateArgs('claude', 'sid-1', 'demo'), ['claude', '--session-id', 'sid-1', '--dangerously-skip-permissions', '--name', 'im2cc:demo'])
  assert.deepEqual(cliArgs.toolResumeArgs('claude', 'sid-1', 'demo'), ['claude', '--resume', 'sid-1', '--dangerously-skip-permissions', '--name', 'im2cc:demo'])

  delete process.env.IM2CC_CLAUDE_SUPPORTS_NAME
  delete process.env.IM2CC_CLAUDE_LAUNCHER
})

test('codex interactive args use top-level resume without exec-only flags', async () => {
  const { toolCreateArgs, toolResumeArgs, resumeCommand } = await import(`${cliArgsModuleUrl}?case=codex`)

  assert.deepEqual(toolCreateArgs('codex', 'sid-1', 'demo'), ['codex'])
  assert.deepEqual(toolResumeArgs('codex', 'sid-1', 'demo'), ['codex', 'resume', 'sid-1'])
  assert.equal(resumeCommand('codex', 'sid-1'), 'codex resume sid-1')
})

test('gemini interactive args still work as best-effort path', async () => {
  const { toolCreateArgs, toolResumeArgs, resumeCommand } = await import(`${cliArgsModuleUrl}?case=gemini`)

  assert.deepEqual(toolCreateArgs('gemini', 'sid-2', 'demo'), ['gemini'])
  assert.deepEqual(toolResumeArgs('gemini', 'sid-2', 'demo'), ['gemini', '--resume', 'sid-2'])
  assert.equal(resumeCommand('gemini', 'sid-2'), 'gemini --resume sid-2')
})

test('claude interactive args use configured launcher without affecting defaults', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-launcher-home-'))
  const launcherPath = path.join(tempDir, 'mock-claude-launcher')
  process.env.IM2CC_CLAUDE_SUPPORTS_NAME = '1'
  process.env.IM2CC_CLAUDE_LAUNCHER = launcherPath

  try {
    const cliArgs = await import(`${cliArgsModuleUrl}?case=launcher`)
    assert.deepEqual(
      cliArgs.toolCreateArgs('claude', 'sid-3', 'demo', { claudeProfile: 'glm' }),
      [
        'env',
        'IM2CC_CLAUDE_PHASE=create',
        'IM2CC_CLAUDE_SESSION_ID=sid-3',
        'IM2CC_CLAUDE_SESSION_NAME=demo',
        'IM2CC_CLAUDE_PROFILE=glm',
        launcherPath,
        '--session-id',
        'sid-3',
        '--dangerously-skip-permissions',
        '--name',
        'im2cc:demo',
      ],
    )
    assert.deepEqual(
      cliArgs.toolResumeArgs('claude', 'sid-3', 'demo', { claudeProfile: 'glm' }),
      [
        'env',
        'IM2CC_CLAUDE_PHASE=resume',
        'IM2CC_CLAUDE_SESSION_ID=sid-3',
        'IM2CC_CLAUDE_SESSION_NAME=demo',
        'IM2CC_CLAUDE_PROFILE=glm',
        launcherPath,
        '--resume',
        'sid-3',
        '--dangerously-skip-permissions',
        '--name',
        'im2cc:demo',
      ],
    )
  } finally {
    delete process.env.IM2CC_CLAUDE_SUPPORTS_NAME
    delete process.env.IM2CC_CLAUDE_LAUNCHER
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
