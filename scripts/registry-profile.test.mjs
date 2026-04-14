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
