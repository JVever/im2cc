import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const cliPath = path.join(rootDir, 'dist', 'bin', 'im2cc.js')

test('cli help reflects focused support matrix', () => {
  const stdout = execFileSync('node', [cliPath], {
    cwd: rootDir,
    encoding: 'utf-8',
  })

  assert.match(stdout, /正式支持:/)
  assert.match(stdout, /IM: 飞书 \/ 微信/)
  assert.match(stdout, /Tool: Claude Code \/ Codex/)
  assert.match(stdout, /Best-effort: Gemini/)
  assert.doesNotMatch(stdout, /Telegram/)
  assert.doesNotMatch(stdout, /钉钉/)
  assert.doesNotMatch(stdout, /Kimi/)
})
