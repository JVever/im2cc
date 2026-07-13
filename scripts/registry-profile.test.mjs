import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function setupTempHome() {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-registry-profile-'))
  const originalHome = process.env.HOME
  process.env.HOME = tempHome
  return { tempHome, restore: () => { process.env.HOME = originalHome } }
}

async function loadRegistry(cacheKey) {
  const moduleUrl = pathToFileURL(path.join(rootDir, 'dist', 'src', 'registry.js')).href
  return await import(`${moduleUrl}?case=${cacheKey}`)
}

test('updateRegistry accepts claudeProfile updates and preserves other fields', async () => {
  const { tempHome, restore } = setupTempHome()
  try {
    const registry = await loadRegistry('update-profile')
    registry.register('demo', 'session-abc', '/tmp/demo', 'claude')
    // 初始无 profile
    let current = registry.lookup('demo')
    assert.equal(current?.claudeProfile, undefined)
    assert.equal(current?.sessionId, 'session-abc')

    // 先设置 permissionMode，profile 仍应为空
    registry.updateRegistry('demo', { permissionMode: 'auto' })
    current = registry.lookup('demo')
    assert.equal(current?.permissionMode, 'auto')
    assert.equal(current?.claudeProfile, undefined)

    // 补录 claudeProfile，permissionMode 不应被擦
    registry.updateRegistry('demo', { claudeProfile: 'kimi' })
    current = registry.lookup('demo')
    assert.equal(current?.claudeProfile, 'kimi')
    assert.equal(current?.permissionMode, 'auto')
    assert.equal(current?.sessionId, 'session-abc')
    assert.equal(current?.cwd, '/tmp/demo')
  } finally {
    restore()
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})

test('updateRegistry on non-existent name is a no-op', async () => {
  const { tempHome, restore } = setupTempHome()
  try {
    const registry = await loadRegistry('noop')
    registry.updateRegistry('ghost', { claudeProfile: 'kimi' })
    assert.equal(registry.lookup('ghost'), null)
  } finally {
    restore()
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})

test('registerWithMeta preserves Session exact model state across sessionId drift', async () => {
  const { tempHome, restore } = setupTempHome()
  try {
    const registry = await loadRegistry('preserve-model')
    registry.registerWithMeta('demo', 'session-old', '/tmp/demo', 'claude', { permissionMode: 'default' })
    registry.updateSelectedModel('demo', 'claude-opus-4-7', '2026-07-13T01:00:00.000Z')
    registry.registerWithMeta('demo', 'session-new', '/tmp/demo', 'claude', { permissionMode: 'plan' })

    const current = registry.lookup('demo')
    assert.equal(current?.sessionId, 'session-new')
    assert.equal(current?.selectedModelId, 'claude-opus-4-7')
    assert.equal(current?.modelSelectionUpdatedAt, '2026-07-13T01:00:00.000Z')
    assert.equal(current?.permissionMode, 'plan')
  } finally {
    restore()
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})

test('model selection rejects older events and explicit default remains timestamped', async () => {
  const { tempHome, restore } = setupTempHome()
  try {
    const registry = await loadRegistry('model-ordering')
    registry.register('demo', 'session-abc', '/tmp/demo', 'claude')

    assert.equal(registry.updateSelectedModel('demo', 'claude-sonnet-4-6', '2026-07-13T02:00:00.000Z'), true)
    assert.equal(registry.updateSelectedModelBySessionId('session-abc', 'claude-opus-4-7', '2026-07-13T01:59:59.000Z'), false)
    assert.equal(registry.lookup('demo')?.selectedModelId, 'claude-sonnet-4-6')

    // 同值的新事实要推进 watermark，夹在旧/新事件之间的晚到事件仍应被拒绝。
    assert.equal(registry.updateSelectedModelBySessionId('session-abc', 'claude-sonnet-4-6', '2026-07-13T02:30:00.000Z'), true)
    assert.equal(registry.updateSelectedModelBySessionId('session-abc', 'claude-opus-4-7', '2026-07-13T02:15:00.000Z'), false)
    assert.equal(registry.lookup('demo')?.modelSelectionUpdatedAt, '2026-07-13T02:30:00.000Z')

    assert.equal(registry.updateSelectedModel('demo', undefined, '2026-07-13T03:00:00.000Z'), true)
    const reset = registry.lookup('demo')
    assert.equal(reset?.selectedModelId, undefined)
    assert.equal(reset?.modelSelectionUpdatedAt, '2026-07-13T03:00:00.000Z')
  } finally {
    restore()
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})

test('registry rejects Claude family aliases but accepts custom provider exact IDs', async () => {
  const { tempHome, restore } = setupTempHome()
  try {
    const registry = await loadRegistry('model-exact-id')
    registry.register('exact-demo', 'session-exact', '/tmp/exact-demo', 'claude')

    assert.equal(registry.updateSelectedModel('exact-demo', 'opus', '2026-07-13T01:00:00.000Z'), false)
    assert.equal(registry.updateSelectedModel('exact-demo', 'sonnet-4.6', '2026-07-13T01:01:00.000Z'), false)
    assert.equal(registry.lookup('exact-demo')?.selectedModelId, undefined)

    assert.equal(registry.updateSelectedModel('exact-demo', '  fable-2026-07-13  ', '2026-07-13T01:02:00.000Z'), true)
    assert.equal(registry.lookup('exact-demo')?.selectedModelId, 'fable-2026-07-13')
  } finally {
    restore()
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})
