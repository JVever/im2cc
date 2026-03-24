import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const cliArgsModulePath = path.join(rootDir, 'dist', 'src', 'tool-cli-args.js')

test('codex interactive args use top-level resume without exec-only flags', async () => {
  const { toolCreateArgs, toolResumeArgs, resumeCommand } = await import(cliArgsModulePath)

  assert.deepEqual(toolCreateArgs('codex', 'sid-1', 'demo'), ['codex'])
  assert.deepEqual(toolResumeArgs('codex', 'sid-1', 'demo'), ['codex', 'resume', 'sid-1'])
  assert.equal(resumeCommand('codex', 'sid-1'), 'codex resume sid-1')
})

test('gemini interactive args still work as best-effort path', async () => {
  const { toolCreateArgs, toolResumeArgs, resumeCommand } = await import(cliArgsModulePath)

  assert.deepEqual(toolCreateArgs('gemini', 'sid-2', 'demo'), ['gemini'])
  assert.deepEqual(toolResumeArgs('gemini', 'sid-2', 'demo'), ['gemini', '--resume', 'sid-2'])
  assert.equal(resumeCommand('gemini', 'sid-2'), 'gemini --resume sid-2')
})
