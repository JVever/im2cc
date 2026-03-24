import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const supportPolicyModulePath = path.join(rootDir, 'dist', 'src', 'support-policy.js')

test('support policy exposes focused core matrix and gemini best-effort', async () => {
  const {
    CORE_TRANSPORTS,
    CORE_TOOLS,
    BEST_EFFORT_TOOLS,
    SUPPORTED_TOOLS,
    isBestEffortTool,
    supportedToolChoices,
    supportedToolList,
  } = await import(supportPolicyModulePath)

  assert.deepEqual(CORE_TRANSPORTS, ['feishu', 'wechat'])
  assert.deepEqual(CORE_TOOLS, ['claude', 'codex'])
  assert.deepEqual(BEST_EFFORT_TOOLS, ['gemini'])
  assert.deepEqual(SUPPORTED_TOOLS, ['claude', 'codex', 'gemini'])
  assert.equal(isBestEffortTool('gemini'), true)
  assert.equal(isBestEffortTool('claude'), false)
  assert.equal(supportedToolChoices(), 'claude|codex|gemini')
  assert.equal(supportedToolList(), 'claude, codex, gemini')
})
