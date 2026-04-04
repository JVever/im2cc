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
    setTimeout(() => { opts?.onTurnText?.('stream reply') }, 20)
    await wait(60)
    return 'final reply'
  }
}

tools.registerDriver(new FakeClaudeDriver())

test('queue drops streamed and final replies after remote binding is archived', { concurrency: false }, async () => {
  resetState()

  session.createBinding('conv-queue-drop', 'session-1', '/tmp', 'YOLO', 'test-cli', 'feishu', 'claude')

  const sent = []
  queue.enqueue('conv-queue-drop', 'hello', async (text) => {
    sent.push(text)
  }, 30)

  session.archiveBinding('conv-queue-drop')
  await wait(120)

  assert.deepEqual(sent, [])
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
    30,
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
