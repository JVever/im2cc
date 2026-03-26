import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mp = await import(path.join(rootDir, 'dist', 'src', 'mode-policy.js'))

test('each tool has at least one mode with valid cliArgs', () => {
  for (const tool of ['claude', 'codex', 'gemini']) {
    const modes = mp.getToolModes(tool)
    assert.ok(modes.length > 0, `${tool} should have modes`)
    for (const m of modes) {
      assert.ok(m.id, `mode id required for ${tool}`)
      assert.ok(m.label, `mode label required for ${tool}/${m.id}`)
      assert.ok(Array.isArray(m.cliArgs), `cliArgs must be array for ${tool}/${m.id}`)
    }
  }
})

test('builtin defaults are valid modes for each tool', () => {
  for (const tool of ['claude', 'codex', 'gemini']) {
    const def = mp.getBuiltinDefault(tool)
    assert.ok(mp.isValidMode(tool, def), `builtin default "${def}" should be valid for ${tool}`)
  }
})

test('Codex builtin default is bypass', () => {
  assert.equal(mp.getBuiltinDefault('codex'), 'bypass')
})

test('Claude builtin default is auto', () => {
  assert.equal(mp.getBuiltinDefault('claude'), 'auto')
})

test('legacy YOLO migrates to each tool builtin default', () => {
  assert.equal(mp.migrateLegacyMode('YOLO', 'claude'), 'bypassPermissions')
  assert.equal(mp.migrateLegacyMode('YOLO', 'codex'), 'bypass')
  assert.equal(mp.migrateLegacyMode('YOLO', 'gemini'), 'yolo')
})

test('legacy auto-edit migrates correctly per tool', () => {
  assert.equal(mp.migrateLegacyMode('auto-edit', 'claude'), 'acceptEdits')
  assert.equal(mp.migrateLegacyMode('auto-edit', 'gemini'), 'auto_edit')
  // Codex has no auto-edit equivalent, falls back to default
  assert.equal(mp.migrateLegacyMode('auto-edit', 'codex'), 'bypass')
})

test('already-native mode names pass through unchanged', () => {
  assert.equal(mp.migrateLegacyMode('bypassPermissions', 'claude'), 'bypassPermissions')
  assert.equal(mp.migrateLegacyMode('full-auto', 'codex'), 'full-auto')
  assert.equal(mp.migrateLegacyMode('yolo', 'gemini'), 'yolo')
  assert.equal(mp.migrateLegacyMode('read-only', 'codex'), 'read-only')
})

test('Claude auto mode is valid and has correct cliArgs', () => {
  assert.ok(mp.isValidMode('claude', 'auto'))
  assert.deepEqual(mp.getModeCliArgs('claude', 'auto'), ['--permission-mode', 'auto'])
  const mode = mp.getMode('claude', 'auto')
  assert.ok(mode)
  assert.equal(mode.label, '智能自动')
})

test('getModeCliArgs returns correct args', () => {
  assert.deepEqual(mp.getModeCliArgs('claude', 'bypassPermissions'), ['--dangerously-skip-permissions'])
  assert.deepEqual(mp.getModeCliArgs('codex', 'full-auto'), ['--full-auto'])
  assert.deepEqual(mp.getModeCliArgs('codex', 'bypass'), ['--dangerously-bypass-approvals-and-sandbox'])
  assert.deepEqual(mp.getModeCliArgs('codex', 'read-only'), ['-s', 'read-only'])
  assert.deepEqual(mp.getModeCliArgs('gemini', 'yolo'), ['--approval-mode', 'yolo'])
})

test('unknown tool returns empty modes and falls back gracefully', () => {
  assert.deepEqual(mp.getToolModes('unknown'), [])
  assert.equal(mp.getBuiltinDefault('unknown'), 'default')
  assert.deepEqual(mp.getModeCliArgs('unknown', 'anything'), [])
})

// ── alias tests ──────────────────────────────────────────────────

test('all modes have a 2-char alias', () => {
  for (const tool of ['claude', 'codex', 'gemini']) {
    for (const m of mp.getToolModes(tool)) {
      assert.ok(m.alias, `alias required for ${tool}/${m.id}`)
      assert.equal(m.alias.length, 2, `alias should be 2 chars for ${tool}/${m.id}`)
    }
  }
})

test('each tool has unique aliases', () => {
  for (const tool of ['claude', 'codex', 'gemini']) {
    const aliases = mp.getToolModes(tool).map(m => m.alias)
    assert.equal(aliases.length, new Set(aliases).size, `${tool} has duplicate aliases`)
  }
})

test('resolveMode resolves full names', () => {
  assert.equal(mp.resolveMode('claude', 'auto'), 'auto')
  assert.equal(mp.resolveMode('codex', 'full-auto'), 'full-auto')
  assert.equal(mp.resolveMode('gemini', 'yolo'), 'yolo')
})

test('resolveMode resolves 2-letter aliases', () => {
  assert.equal(mp.resolveMode('claude', 'au'), 'auto')
  assert.equal(mp.resolveMode('claude', 'bp'), 'bypassPermissions')
  assert.equal(mp.resolveMode('claude', 'ae'), 'acceptEdits')
  assert.equal(mp.resolveMode('claude', 'df'), 'default')
  assert.equal(mp.resolveMode('codex', 'bp'), 'bypass')
  assert.equal(mp.resolveMode('codex', 'fa'), 'full-auto')
  assert.equal(mp.resolveMode('codex', 'ro'), 'read-only')
  assert.equal(mp.resolveMode('gemini', 'yo'), 'yolo')
  assert.equal(mp.resolveMode('gemini', 'ae'), 'auto_edit')
  assert.equal(mp.resolveMode('gemini', 'df'), 'default')
})

test('resolveMode is case-insensitive for aliases', () => {
  assert.equal(mp.resolveMode('claude', 'AU'), 'auto')
  assert.equal(mp.resolveMode('codex', 'RO'), 'read-only')
})

test('resolveMode returns undefined for invalid input', () => {
  assert.equal(mp.resolveMode('claude', 'xx'), undefined)
  assert.equal(mp.resolveMode('codex', 'yolo'), undefined)
})
