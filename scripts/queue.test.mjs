import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-queue-'))
process.env.HOME = testHome

const queue = await import(path.join(rootDir, 'dist', 'src', 'queue.js'))
const session = await import(path.join(rootDir, 'dist', 'src', 'session.js'))
const tools = await import(path.join(rootDir, 'dist', 'src', 'tool-driver.js'))
const registry = await import(path.join(rootDir, 'dist', 'src', 'registry.js'))
const discover = await import(path.join(rootDir, 'dist', 'src', 'discover.js'))

function resetState() {
  fs.rmSync(path.join(testHome, '.im2cc'), { recursive: true, force: true })
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class FakeClaudeDriver {
  constructor() {
    this.id = 'claude'
    this.capabilities = {
      supportsResume: true,
      supportsDiscovery: true,
      supportsInterrupt: true,
    }
  }

  getVersion() { return 'test' }
  isAvailable() { return true }
  async createSession() { throw new Error('unused') }
  checkSessionFile() { return 'here' }
  killLocalSession() { return false }
  async interrupt() {}

  async sendMessage(_sessionId, _message, _cwd, _permissionMode, opts) {
    this.lastModelOverride = opts?.modelOverride
    setTimeout(() => { opts?.onTurnText?.('stream reply') }, 20)
    await wait(60)
    if (this.beforeReturn) await this.beforeReturn({ sessionId: _sessionId, cwd: _cwd, opts })
    return 'final reply'
  }
}

const fakeDriver = new FakeClaudeDriver()
tools.registerDriver(fakeDriver)

test('queue snapshots the named Session exact model instead of binding.modelOverride', { concurrency: false }, async () => {
  resetState()
  registry.register('model-demo', 'session-model', '/tmp', 'claude')
  registry.updateSelectedModel('model-demo', 'claude-opus-5')
  session.createBinding('conv-model', 'session-model', '/tmp', 'YOLO', 'test-cli', 'wechat', 'claude')
  session.updateBinding('conv-model', { modelOverride: 'claude-sonnet-4-6' })

  queue.enqueue('conv-model', 'use selected model', async () => {})
  await wait(120)

  assert.equal(fakeDriver.lastModelOverride, 'claude-opus-5')
})

test('a completed old turn cannot overwrite a model selected while that turn was running', { concurrency: false }, async () => {
  resetState()
  const cwd = path.join(testHome, 'Code/model-race')
  fs.mkdirSync(cwd, { recursive: true })
  registry.register('model-race', 'session-model-race', cwd, 'claude')
  registry.updateSelectedModel('model-race', 'claude-opus-5', '2026-07-13T01:00:00.000Z')
  session.createBinding('conv-model-race', 'session-model-race', cwd, 'YOLO', 'test-cli', 'wechat', 'claude')

  fakeDriver.beforeReturn = async ({ sessionId }) => {
    // turn A 已经以 Opus 启动；执行中用户为下一 turn 选择 Sonnet。
    registry.updateSelectedModel('model-race', 'claude-sonnet-5', '2026-07-13T02:00:00.000Z')
    const transcriptDir = path.join(testHome, '.claude/projects', discover.pathToSlug(cwd))
    fs.mkdirSync(transcriptDir, { recursive: true })
    fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-13T03:00:00.000Z',
      message: { model: 'claude-opus-5', content: [] },
    }) + '\n')
  }

  try {
    queue.enqueue('conv-model-race', 'finish old turn', async () => {})
    await wait(140)
    assert.equal(fakeDriver.lastModelOverride, 'claude-opus-5')
    assert.equal(registry.lookup('model-race')?.selectedModelId, 'claude-sonnet-5')

    // 下一 turn 必须自动继承执行期间产生的新选择。
    fakeDriver.beforeReturn = undefined
    queue.enqueue('conv-model-race', 'start next turn', async () => {})
    await wait(120)
    assert.equal(fakeDriver.lastModelOverride, 'claude-sonnet-5')
  } finally {
    fakeDriver.beforeReturn = undefined
  }
})

test('a successful turn with no new model fact cannot reuse the observed baseline', { concurrency: false }, async () => {
  resetState()
  const cwd = path.join(testHome, 'Code/model-baseline')
  fs.mkdirSync(cwd, { recursive: true })
  registry.register('model-baseline', 'session-model-baseline', cwd, 'claude')
  registry.updateSelectedModel('model-baseline', 'claude-sonnet-new', '2026-07-13T02:00:00.000Z')
  session.createBinding('conv-model-baseline', 'session-model-baseline', cwd, 'YOLO', 'test-cli', 'wechat', 'claude')

  // 这条旧 Opus assistant 已在本 turn 启动前存在；fake driver 成功但不写新 assistant。
  const transcriptDir = path.join(testHome, '.claude/projects', discover.pathToSlug(cwd))
  fs.mkdirSync(transcriptDir, { recursive: true })
  fs.writeFileSync(path.join(transcriptDir, 'session-model-baseline.jsonl'), JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-13T03:00:00.000Z',
    message: { model: 'claude-opus-stale', content: [] },
  }) + '\n')

  queue.enqueue('conv-model-baseline', 'no new assistant fact', async () => {})
  await wait(120)
  assert.equal(fakeDriver.lastModelOverride, 'claude-sonnet-new')
  assert.equal(registry.lookup('model-baseline')?.selectedModelId, 'claude-sonnet-new')
})

test('queue drops streamed and final replies after remote binding is archived', { concurrency: false }, async () => {
  resetState()

  session.createBinding('conv-queue-drop', 'session-1', '/tmp', 'YOLO', 'test-cli', 'feishu', 'claude')

  const sent = []
  queue.enqueue('conv-queue-drop', 'hello', async (text) => {
    sent.push(text)
  })

  session.archiveBinding('conv-queue-drop')
  await wait(120)

  assert.deepEqual(sent, [])
})

test('queue records a recent completed snapshot for desktop handoff recall', { concurrency: false }, async () => {
  resetState()

  session.createBinding('conv-handoff-finished', 'session-finished', '/tmp', 'YOLO', 'test-cli', 'feishu', 'claude')

  queue.enqueue('conv-handoff-finished', 'finish this task', async () => {})
  await wait(120)

  const completed = queue.listCompletedInflightSnapshotsForSession('session-finished', 'conv-handoff-finished')
  assert.equal(completed.length, 1)
  assert.equal(completed[0].status, 'completed')
  assert.match(completed[0].outputPreview, /stream reply|final reply/)
})

test('recoverOnStartup drops inflight results for detached conversations', { concurrency: false }, async () => {
  resetState()

  const inflightDir = path.join(testHome, '.im2cc', 'data', 'inflight')
  fs.mkdirSync(inflightDir, { recursive: true })

  const meta = {
    id: 'job-1',
    conversationId: 'conv-recovery-drop',
    sessionId: 'session-1',
    text: 'pending work',
    pid: null,
    startedAt: new Date().toISOString(),
    outputFile: 'job-1.output',
  }

  fs.writeFileSync(path.join(inflightDir, 'job-1.meta.json'), JSON.stringify(meta))
  fs.writeFileSync(path.join(inflightDir, 'job-1.output'), 'stale result')

  const sent = []
  await queue.recoverOnStartup(
    async (conversationId, text) => { sent.push({ conversationId, text }) },
    (conversationId) => async (text) => { sent.push({ conversationId, text }) },
  )

  assert.deepEqual(sent, [])
  assert.equal(fs.existsSync(path.join(inflightDir, 'job-1.meta.json')), false)
  assert.equal(fs.existsSync(path.join(inflightDir, 'job-1.output')), false)
})

test('interruptInflightTasksForSession stops detached child processes by session', { concurrency: false }, async () => {
  resetState()

  const inflightDir = path.join(testHome, '.im2cc', 'data', 'inflight')
  fs.mkdirSync(inflightDir, { recursive: true })

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  const pid = child.pid
  assert.ok(pid)

  const meta = {
    id: 'job-2',
    conversationId: 'conv-interrupt',
    sessionId: 'session-2',
    text: 'running work',
    pid,
    startedAt: new Date().toISOString(),
    outputFile: 'job-2.output',
  }

  fs.writeFileSync(path.join(inflightDir, 'job-2.meta.json'), JSON.stringify(meta))

  const interrupted = await queue.interruptInflightTasksForSession('session-2', 'conv-interrupt')
  assert.equal(interrupted, 1)

  await wait(200)
  let alive = true
  try {
    process.kill(pid, 0)
  } catch {
    alive = false
  }
  assert.equal(alive, false)
})

test('listCompletedInflightSnapshotsForSession prunes expired snapshots', { concurrency: false }, async () => {
  resetState()

  const inflightDir = path.join(testHome, '.im2cc', 'data', 'inflight')
  fs.mkdirSync(inflightDir, { recursive: true })

  const staleSnapshot = {
    id: 'job-stale',
    conversationId: 'conv-stale',
    sessionId: 'session-prune',
    text: 'old task',
    startedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    finishedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    status: 'completed',
    outputPreview: 'old output',
  }
  const freshSnapshot = {
    id: 'job-fresh',
    conversationId: 'conv-fresh',
    sessionId: 'session-prune',
    text: 'fresh task',
    startedAt: new Date(Date.now() - 60 * 1000).toISOString(),
    finishedAt: new Date(Date.now() - 30 * 1000).toISOString(),
    status: 'completed',
    outputPreview: 'fresh output',
  }

  fs.writeFileSync(path.join(inflightDir, 'job-stale.completed.json'), JSON.stringify(staleSnapshot))
  fs.writeFileSync(path.join(inflightDir, 'job-fresh.completed.json'), JSON.stringify(freshSnapshot))

  const completed = queue.listCompletedInflightSnapshotsForSession('session-prune')
  assert.deepEqual(completed.map(item => item.id), ['job-fresh'])
  assert.equal(fs.existsSync(path.join(inflightDir, 'job-stale.completed.json')), false)
})
