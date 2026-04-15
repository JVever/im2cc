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
  }, { idleSeconds: 30, hardMaxSeconds: 0 })

  session.archiveBinding('conv-queue-drop')
  await wait(120)

  assert.deepEqual(sent, [])
})

test('queue records a recent completed snapshot for desktop handoff recall', { concurrency: false }, async () => {
  resetState()

  session.createBinding('conv-handoff-finished', 'session-finished', '/tmp', 'YOLO', 'test-cli', 'feishu', 'claude')

  queue.enqueue('conv-handoff-finished', 'finish this task', async () => {}, { idleSeconds: 30, hardMaxSeconds: 0 })
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
    { idleSeconds: 30, hardMaxSeconds: 0 },
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

class SlowDriver {
  constructor(opts = {}) {
    this.id = 'claude'
    this.capabilities = { supportsResume: true, supportsDiscovery: true, supportsInterrupt: true }
    this.totalMs = opts.totalMs ?? 300
    this.streamIntervalMs = opts.streamIntervalMs ?? 0  // 0 = 不流式，模拟卡死
  }
  getVersion() { return 'test' }
  isAvailable() { return true }
  async createSession() { throw new Error('unused') }
  checkSessionFile() { return 'here' }
  killLocalSession() { return false }
  async interrupt(child) {
    // 模拟真实 driver：收到 interrupt 后子进程退出
    if (child && typeof child.kill === 'function') child.kill('SIGTERM')
  }
  async sendMessage(_sessionId, _message, _cwd, _permissionMode, opts) {
    // 构造最小假子进程对象，让 queue 能挂接 onSpawn
    const fakeChild = { pid: null, killed: false, kill(_sig) { this.killed = true } }
    opts?.onSpawn?.(fakeChild)
    return new Promise((resolve, reject) => {
      let streamTimer = null
      let killWatcher = null
      const cleanup = () => {
        if (streamTimer) { clearInterval(streamTimer); streamTimer = null }
        if (killWatcher) { clearInterval(killWatcher); killWatcher = null }
      }
      if (this.streamIntervalMs > 0) {
        streamTimer = setInterval(() => {
          if (!fakeChild.killed) opts?.onTurnText?.('tick')
        }, this.streamIntervalMs)
      }
      const finishTimer = setTimeout(() => {
        cleanup()
        if (fakeChild.killed) reject(new Error('interrupted'))
        else resolve('done')
      }, this.totalMs)
      // 被中断时立即退出（不要等 totalMs）
      killWatcher = setInterval(() => {
        if (fakeChild.killed) {
          clearTimeout(finishTimer)
          cleanup()
          reject(new Error('interrupted'))
        }
      }, 20)
    })
  }
}

test('idle timeout fires when driver produces no output', { concurrency: false }, async () => {
  resetState()
  // driver 总时长 5s（远超 idle），idle=1s 应该在 ~1s 时就把它砍了
  tools.registerDriver(new SlowDriver({ totalMs: 5000, streamIntervalMs: 0 }))
  session.createBinding('conv-idle-timeout', 'session-idle', '/tmp', 'YOLO', 'test-cli', 'feishu', 'claude')

  const sent = []
  const arrivalTimes = []
  const start = Date.now()
  queue.enqueue('conv-idle-timeout', 'hang forever', async (text) => {
    arrivalTimes.push(Date.now() - start)
    sent.push(text)
  }, { idleSeconds: 1, hardMaxSeconds: 0 })

  await wait(1500)

  const errorMsg = sent.find(t => t.includes('长时间无输出'))
  assert.ok(errorMsg, `应发送 idle 超时提示，实际 sent = ${JSON.stringify(sent)}`)
  const errorIdx = sent.indexOf(errorMsg)
  const triggerAt = arrivalTimes[errorIdx]
  assert.ok(triggerAt >= 900 && triggerAt <= 1300, `idle 超时应在 ~1s 触发，实际 ${triggerAt}ms`)

  tools.registerDriver(new FakeClaudeDriver())
})

test('idle timeout is reset by streaming output (long task not killed)', { concurrency: false }, async () => {
  resetState()
  // 流式每 300ms 一次，idle = 1s，总时长 1500ms — 正常完成不应超时
  tools.registerDriver(new SlowDriver({ totalMs: 1500, streamIntervalMs: 300 }))
  session.createBinding('conv-streaming', 'session-streaming', '/tmp', 'YOLO', 'test-cli', 'feishu', 'claude')

  const sent = []
  queue.enqueue('conv-streaming', 'long task', async (text) => {
    sent.push(text)
  }, { idleSeconds: 1, hardMaxSeconds: 0 })

  await wait(1800)

  // 应该看到多条 "tick" 流式回复，且不应触发超时错误
  const timeoutMsg = sent.find(t => t.includes('长时间无输出') || t.includes('绝对执行上限'))
  assert.equal(timeoutMsg, undefined, `流式任务不应触发超时，实际: ${timeoutMsg}`)
  const tickCount = sent.filter(t => t.includes('tick')).length
  assert.ok(tickCount >= 3, `应收到多条流式消息，实际 ${tickCount} 条`)

  tools.registerDriver(new FakeClaudeDriver())
})

test('hardMax timeout fires even when output keeps streaming', { concurrency: false }, async () => {
  resetState()
  // 持续流式 — 单靠 idle 永远不会触发。hardMax = 1s 必须兜底
  tools.registerDriver(new SlowDriver({ totalMs: 5000, streamIntervalMs: 100 }))
  session.createBinding('conv-hardmax', 'session-hardmax', '/tmp', 'YOLO', 'test-cli', 'feishu', 'claude')

  const sent = []
  const arrivalTimes = []
  const start = Date.now()
  queue.enqueue('conv-hardmax', 'endless stream', async (text) => {
    arrivalTimes.push(Date.now() - start)
    sent.push(text)
  }, { idleSeconds: 10, hardMaxSeconds: 1 })

  await wait(1500)

  const errorMsg = sent.find(t => t.includes('绝对执行上限'))
  assert.ok(errorMsg, `应发送 hardMax 超时提示，实际 sent = ${JSON.stringify(sent)}`)
  const errorIdx = sent.indexOf(errorMsg)
  const triggerAt = arrivalTimes[errorIdx]
  assert.ok(triggerAt >= 900 && triggerAt <= 1300, `hardMax 应在 ~1s 触发，实际 ${triggerAt}ms`)

  tools.registerDriver(new FakeClaudeDriver())
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
