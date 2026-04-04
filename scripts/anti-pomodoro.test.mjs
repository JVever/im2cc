import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-anti-pomodoro-'))
process.env.HOME = testHome

const antiPomodoro = await import(path.join(rootDir, 'dist', 'src', 'anti-pomodoro.js'))

function resetState() {
  fs.rmSync(path.join(testHome, '.im2cc'), { recursive: true, force: true })
}

function readPersistedState() {
  return JSON.parse(
    fs.readFileSync(path.join(testHome, '.im2cc', 'data', 'anti-pomodoro.json'), 'utf-8'),
  )
}

test('anti-pomodoro waits for first work message, then enters rest and returns to waiting', () => {
  resetState()

  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
  const enabled = antiPomodoro.enableAntiPomodoro(t0)
  assert.equal(enabled.changed, true)
  assert.match(enabled.message, /已开启反茄钟/)
  assert.equal(enabled.snapshot.phase, 'waiting')
  assert.match(enabled.message, /发送下一条工作消息后开始 5 分钟工作时间/)

  const firstWorkAt = t0 + 1000
  const workStart = antiPomodoro.startWorkPhaseIfWaiting(firstWorkAt)
  assert.equal(workStart.started, true)
  assert.equal(workStart.snapshot.phase, 'work')

  const restAt = firstWorkAt + antiPomodoro.ANTI_POMODORO_WORK_MS + 1000
  const firstClaim = antiPomodoro.claimRestQuota(restAt)
  assert.equal(firstClaim.allowed, true)
  assert.match(firstClaim.notice, /已使用本轮休息期后台指令/)
  assert.match(firstClaim.notice, /结果会在本轮休息结束后恢复推送/)
  assert.equal(firstClaim.snapshot.phase, 'rest')
  assert.equal(firstClaim.snapshot.restQuotaUsed, true)

  const secondClaim = antiPomodoro.claimRestQuota(restAt + 1000)
  assert.equal(secondClaim.allowed, false)
  assert.match(secondClaim.rejection, /不会发给电脑，也不会缓存/)

  const queued = antiPomodoro.queueDelayedReply('conv-a', 'done', restAt + 2000)
  assert.equal(queued, true)

  const restStatus = antiPomodoro.formatAntiPomodoroStatus(antiPomodoro.getAntiPomodoroSnapshot(restAt + 3000))
  assert.match(restStatus, /阶段：休息时间/)
  assert.match(restStatus, /范围：飞书、微信、不同对话全局共享/)
  assert.doesNotMatch(restStatus, /待送达/)

  const waitingAt = restAt + antiPomodoro.ANTI_POMODORO_REST_MS + 1000
  const waitingStatus = antiPomodoro.formatAntiPomodoroStatus(antiPomodoro.getAntiPomodoroSnapshot(waitingAt))
  assert.match(waitingStatus, /阶段：等待开始/)
  assert.match(waitingStatus, /发送下一条工作消息后开始 5 分钟工作时间/)

  const drained = antiPomodoro.drainDeliverableReplies(waitingAt)
  assert.deepEqual(drained, [{ conversationId: 'conv-a', text: 'done' }])

  const drainedAgain = antiPomodoro.drainDeliverableReplies(waitingAt + 1000)
  assert.deepEqual(drainedAgain, [])

  const lateQueue = antiPomodoro.queueDelayedReply('conv-a', 'late-result', waitingAt + 2000)
  assert.equal(lateQueue, false)

  const secondWork = antiPomodoro.startWorkPhaseIfWaiting(waitingAt + 3000)
  assert.equal(secondWork.started, true)
  assert.equal(secondWork.snapshot.phase, 'work')
})

test('disable clears anti-pomodoro state back to normal', () => {
  resetState()

  const t0 = Date.UTC(2026, 0, 1, 8, 0, 0)
  antiPomodoro.enableAntiPomodoro(t0)
  antiPomodoro.startWorkPhaseIfWaiting(t0 + 1000)
  antiPomodoro.queueDelayedReply('conv-a', 'done', t0 + 1000 + antiPomodoro.ANTI_POMODORO_WORK_MS + 1000)

  const disabled = antiPomodoro.disableAntiPomodoro('已回到电脑端工作。', t0 + 2000)
  assert.equal(disabled.changed, true)
  assert.match(disabled.message, /已关闭反茄钟/)
  assert.match(disabled.message, /原因：已回到电脑端工作。/)

  const snapshot = antiPomodoro.getAntiPomodoroSnapshot(t0 + 3000)
  assert.equal(snapshot.enabled, false)
  assert.equal(snapshot.phase, null)
})

test('anti-pomodoro daemon sync keeps delayed replies on send failure and retries later', async () => {
  resetState()

  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0)
  antiPomodoro.enableAntiPomodoro(t0)
  antiPomodoro.startWorkPhaseIfWaiting(t0 + 1000)

  const restAt = t0 + 1000 + antiPomodoro.ANTI_POMODORO_WORK_MS + 1000
  antiPomodoro.queueDelayedReply('conv-a', 'done', restAt)

  const waitingAt = restAt + antiPomodoro.ANTI_POMODORO_REST_MS + 1000
  const realDateNow = Date.now
  let attempts = 0
  const controller = new antiPomodoro.AntiPomodoroDaemonController(async () => {
    attempts += 1
    if (attempts === 1) throw new Error('network down')
  })

  Date.now = () => waitingAt

  try {
    await controller.sync()
    assert.equal(attempts, 1)
    assert.equal(readPersistedState().delayedReplies.length, 1)

    await controller.sync()
    assert.equal(attempts, 2)
    assert.equal(readPersistedState().delayedReplies.length, 0)
  } finally {
    Date.now = realDateNow
    controller.stop()
  }
})
