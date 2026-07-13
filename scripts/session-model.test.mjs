import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-session-model-'))
process.env.HOME = tempHome

const registry = await import(pathToFileURL(path.join(rootDir, 'dist/src/registry.js')).href)
const session = await import(pathToFileURL(path.join(rootDir, 'dist/src/session.js')).href)
const sessionModel = await import(pathToFileURL(path.join(rootDir, 'dist/src/session-model.js')).href)
const discover = await import(pathToFileURL(path.join(rootDir, 'dist/src/discover.js')).href)
const status = await import(pathToFileURL(path.join(rootDir, 'dist/src/status.js')).href)

function resetState() {
  fs.rmSync(path.join(tempHome, '.im2cc'), { recursive: true, force: true })
  fs.rmSync(path.join(tempHome, '.claude'), { recursive: true, force: true })
  fs.rmSync(path.join(tempHome, '.codex'), { recursive: true, force: true })
}

function createRegisteredBinding(name, tool, cwd, conversationId) {
  const sessionId = `${name}-session-id`
  fs.mkdirSync(cwd, { recursive: true })
  registry.register(name, sessionId, cwd, tool)
  return session.createBinding(conversationId, sessionId, cwd, 'default', 'test-cli', 'wechat', tool)
}

function writeClaudeAssistant(cwd, sessionId, modelId, timestamp) {
  const dir = path.join(tempHome, '.claude/projects', discover.pathToSlug(cwd))
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { model: modelId, content: [] },
  }) + '\n')
}

function writeCodexTurn(sessionId, modelId, timestamp, { complete = true, paddingBytes = 0 } = {}) {
  const dir = path.join(tempHome, '.codex/sessions/2026/07/13')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-${sessionId}.jsonl`)
  fs.appendFileSync(file, JSON.stringify({
    type: 'turn_context',
    timestamp,
    payload: { model: modelId },
  }) + '\n')
  if (paddingBytes > 0) {
    fs.appendFileSync(file, JSON.stringify({
      type: 'response_item',
      timestamp,
      payload: { type: 'reasoning', encrypted_content: 'x'.repeat(paddingBytes) },
    }) + '\n')
  }
  if (complete) {
    fs.appendFileSync(file, JSON.stringify({
      type: 'event_msg',
      timestamp: new Date(new Date(timestamp).getTime() + 1000).toISOString(),
      payload: { type: 'task_complete' },
    }) + '\n')
  }
}

test('Claude actual response locks the exact model ID and /fs distinguishes current selection from recent actual use', async () => {
  resetState()
  const cwd = path.join(tempHome, 'Code/claude-project')
  const binding = createRegisteredBinding('claude-demo', 'claude', cwd, 'wechat-claude')
  writeClaudeAssistant(cwd, binding.sessionId, 'claude-sonnet-5', '2026-07-13T01:00:00.000Z')

  assert.equal(sessionModel.getSelectedModelForBinding(binding), 'claude-sonnet-5')
  assert.equal(registry.lookup('claude-demo')?.selectedModelId, 'claude-sonnet-5')

  registry.updateSelectedModel('claude-demo', 'claude-opus-5', '2026-07-13T02:00:00.000Z')
  assert.equal(sessionModel.getSelectedModelForBinding(binding), 'claude-opus-5')
  assert.equal(registry.lookup('claude-demo')?.selectedModelId, 'claude-opus-5')

  const card = await status.buildSessionStatus(binding, { includeQuota: false })
  assert.match(card, /当前选择的模型：claude-opus-5/)
  assert.match(card, /最近实际使用的模型：claude-sonnet-5/)
})

test('explicit default is not backfilled by an older response, then next successful response relocks', async () => {
  resetState()
  const cwd = path.join(tempHome, 'Code/default-project')
  const binding = createRegisteredBinding('default-demo', 'claude', cwd, 'wechat-default')
  writeClaudeAssistant(cwd, binding.sessionId, 'claude-sonnet-5', '2026-07-13T01:00:00.000Z')
  registry.updateSelectedModel('default-demo', undefined, '2026-07-13T02:00:00.000Z')

  assert.equal(sessionModel.getSelectedModelForBinding(binding), undefined)
  const defaultCard = await status.buildSessionStatus(binding, { includeQuota: false })
  assert.match(defaultCard, /当前选择的模型：工具默认模型/)
  assert.match(defaultCard, /最近实际使用的模型：claude-sonnet-5/)
  const snapshot = sessionModel.getModelSelectionSnapshotForBinding(binding)

  writeClaudeAssistant(cwd, binding.sessionId, 'claude-opus-5', '2026-07-13T03:00:00.000Z')
  assert.equal(
    sessionModel.reconcileActualModel(
      binding,
      binding.sessionId,
      snapshot.modelSelectionUpdatedAt,
      snapshot.observedBaseline,
    ),
    'claude-opus-5',
  )
  assert.equal(registry.lookup('default-demo')?.selectedModelId, 'claude-opus-5')
})

test('Claude successful assistant model corrects an explicit target when the selection watermark is unchanged', () => {
  resetState()
  const cwd = path.join(tempHome, 'Code/claude-rewrite-project')
  const binding = createRegisteredBinding('claude-rewrite', 'claude', cwd, 'wechat-rewrite')
  registry.updateSelectedModel('claude-rewrite', 'claude-opus-requested', '2026-07-13T01:00:00.000Z')
  const snapshot = sessionModel.getModelSelectionSnapshotForBinding(binding)

  writeClaudeAssistant(cwd, binding.sessionId, 'claude-sonnet-actual', '2026-07-13T02:00:00.000Z')
  assert.equal(
    sessionModel.reconcileActualModel(
      binding,
      binding.sessionId,
      snapshot.modelSelectionUpdatedAt,
      snapshot.observedBaseline,
    ),
    'claude-sonnet-actual',
  )
  assert.equal(registry.lookup('claude-rewrite')?.selectedModelId, 'claude-sonnet-actual')
})

test('legacy binding.modelOverride migrates once when no Session model state exists', () => {
  resetState()
  const cwd = path.join(tempHome, 'Code/legacy-project')
  const binding = createRegisteredBinding('legacy-demo', 'claude', cwd, 'wechat-legacy')
  writeClaudeAssistant(cwd, binding.sessionId, 'claude-sonnet-4-6', '2026-07-13T01:00:00.000Z')
  session.updateBinding('wechat-legacy', { modelOverride: 'opus-4.7' })
  const legacyBinding = session.getBinding('wechat-legacy')

  assert.equal(sessionModel.getSelectedModelForBinding(legacyBinding), 'claude-opus-4-7')
  assert.equal(registry.lookup('legacy-demo')?.selectedModelId, 'claude-opus-4-7')
})

test('unknown legacy Claude alias cannot enter Session truth and falls back to observed exact ID', () => {
  resetState()
  const cwd = path.join(tempHome, 'Code/legacy-alias-project')
  const binding = createRegisteredBinding('legacy-alias', 'claude', cwd, 'wechat-legacy-alias')
  writeClaudeAssistant(cwd, binding.sessionId, 'claude-sonnet-4-6', '2026-07-13T01:00:00.000Z')
  session.updateBinding('wechat-legacy-alias', { modelOverride: 'opus-4.8' })
  const legacyBinding = session.getBinding('wechat-legacy-alias')

  assert.equal(sessionModel.getSelectedModelForBinding(legacyBinding), 'claude-sonnet-4-6')
  assert.equal(registry.lookup('legacy-alias')?.selectedModelId, 'claude-sonnet-4-6')
})

test('fc restarts an existing TUI only when its actual model differs from an explicit Session choice', () => {
  resetState()
  const cwd = path.join(tempHome, 'Code/restart-project')
  const binding = createRegisteredBinding('restart-demo', 'claude', cwd, 'wechat-restart')
  registry.updateSelectedModel('restart-demo', 'claude-opus-5')
  let registered = registry.lookup('restart-demo')

  assert.equal(sessionModel.needsInteractiveModelRestart(registered), true)

  const statePath = path.join(tempHome, '.im2cc/data/statusline-model-state.json')
  fs.writeFileSync(statePath, JSON.stringify({ [binding.sessionId]: 'claude-opus-5' }))
  registered = registry.lookup('restart-demo')
  assert.equal(sessionModel.needsInteractiveModelRestart(registered), false)

  registry.updateSelectedModel('restart-demo', 'claude-sonnet-5')
  registered = registry.lookup('restart-demo')
  assert.equal(sessionModel.needsInteractiveModelRestart(registered), true)

  registry.updateSelectedModel('restart-demo', undefined)
  registered = registry.lookup('restart-demo')
  assert.equal(sessionModel.needsInteractiveModelRestart(registered), true)
})

test('Codex external Terminal completed turn advances an existing selection by turn-start time', () => {
  resetState()
  const cwd = path.join(tempHome, 'Code/codex-external-project')
  const binding = createRegisteredBinding('codex-external', 'codex', cwd, 'wechat-codex-external')
  registry.updateSelectedModel('codex-external', 'gpt-5.6-a', '2026-07-13T01:00:00.000Z')
  writeCodexTurn(binding.sessionId, 'gpt-5.7-b', '2026-07-13T02:00:00.000Z')

  assert.equal(sessionModel.getSelectedModelForBinding(binding), 'gpt-5.7-b')
  assert.equal(sessionModel.getModelSelectionSnapshotForBinding(binding).selectedModelId, 'gpt-5.7-b')
})

test('Codex old completed turn cannot override a selection made after that turn started', () => {
  resetState()
  const cwd = path.join(tempHome, 'Code/codex-old-turn-project')
  const binding = createRegisteredBinding('codex-old-turn', 'codex', cwd, 'wechat-codex-old')
  writeCodexTurn(binding.sessionId, 'gpt-5.6-old', '2026-07-13T01:00:00.000Z')
  registry.updateSelectedModel('codex-old-turn', 'gpt-5.7-new', '2026-07-13T02:00:00.000Z')

  assert.equal(sessionModel.getSelectedModelForBinding(binding), 'gpt-5.7-new')
})

test('Codex reports recent actual use from the latest successful turn without claiming response metadata', async () => {
  resetState()
  const cwd = path.join(tempHome, 'Code/codex-project')
  const binding = createRegisteredBinding('codex-demo', 'codex', cwd, 'wechat-codex')
  writeCodexTurn(binding.sessionId, 'gpt-5.6-sol', '2026-07-13T04:00:00.000Z', { paddingBytes: 400 * 1024 })
  // 新 turn 只有 turn_context、尚未完成：不能覆盖最近成功响应模型。
  writeCodexTurn(binding.sessionId, 'gpt-5.7-failed', '2026-07-13T05:00:00.000Z', { complete: false })

  const observed = sessionModel.getLatestObservedModel('codex', binding.sessionId, cwd)
  assert.deepEqual(observed, { id: 'gpt-5.6-sol', observedAt: '2026-07-13T04:00:00.000Z' })
  assert.equal(sessionModel.getSelectedModelForBinding(binding), 'gpt-5.6-sol')
  const card = await status.buildSessionStatus(binding, { includeQuota: false })
  assert.match(card, /最近实际使用的模型：gpt-5\.6-sol/)
  assert.doesNotMatch(card, /接下来使用的模型|上次回复使用的模型|上次成功执行的模型/)

  // Codex 的条件校正只声称成功 turn context；仍需遵守 selection watermark CAS。
  registry.updateSelectedModel('codex-demo', 'gpt-5.7-target', '2026-07-13T06:00:00.000Z')
  const snapshot = sessionModel.getModelSelectionSnapshotForBinding(binding)
  writeCodexTurn(binding.sessionId, 'gpt-5.7-context', '2026-07-13T07:00:00.000Z')
  assert.equal(
    sessionModel.reconcileActualModel(
      binding,
      binding.sessionId,
      snapshot.modelSelectionUpdatedAt,
      snapshot.observedBaseline,
    ),
    'gpt-5.7-context',
  )
  assert.equal(registry.lookup('codex-demo')?.selectedModelId, 'gpt-5.7-context')
})
