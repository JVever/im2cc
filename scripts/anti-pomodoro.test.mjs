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

test('anti-pomodoro rest quota is single-use and delayed replies flush on next work window', () => {
  resetState()

  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
  const workStart = antiPomodoro.enableAntiPomodoro(t0)
  assert.equal(workStart.changed, true)
  assert.match(workStart.message, /反茄钟已开启/)
  assert.equal(workStart.snapshot.phase, 'work')

  const restAt = t0 + antiPomodoro.ANTI_POMODORO_WORK_MS + 1000
  const firstClaim = antiPomodoro.claimRestQuota(restAt)
  assert.equal(firstClaim.allowed, true)
  assert.match(firstClaim.notice, /唯一后台指令额度已经用完/)
  assert.equal(firstClaim.snapshot.phase, 'rest')
  assert.equal(firstClaim.snapshot.restQuotaUsed, true)

  const secondClaim = antiPomodoro.claimRestQuota(restAt + 1000)
  assert.equal(secondClaim.allowed, false)
  assert.match(secondClaim.rejection, /不会发给电脑，也不会缓存/)

  const queued = antiPomodoro.queueDelayedReply('conv-a', 'done', restAt + 2000)
  assert.equal(queued, true)

  const restStatus = antiPomodoro.formatAntiPomodoroStatus(antiPomodoro.getAntiPomodoroSnapshot(restAt + 3000))
  assert.match(restStatus, /当前阶段: 休息时间/)
  assert.doesNotMatch(restStatus, /待送达/)

  const nextWorkAt = restAt + antiPomodoro.ANTI_POMODORO_REST_MS + 1000
  const drained = antiPomodoro.drainDeliverableReplies(nextWorkAt)
  assert.deepEqual(drained, [{ conversationId: 'conv-a', text: 'done' }])

  const drainedAgain = antiPomodoro.drainDeliverableReplies(nextWorkAt + 1000)
  assert.deepEqual(drainedAgain, [])
})

test('disable clears anti-pomodoro state back to normal', () => {
  resetState()

  const t0 = Date.UTC(2026, 0, 1, 8, 0, 0)
  antiPomodoro.enableAntiPomodoro(t0)
  antiPomodoro.queueDelayedReply('conv-a', 'done', t0 + antiPomodoro.ANTI_POMODORO_WORK_MS + 1000)

  const disabled = antiPomodoro.disableAntiPomodoro('已回到电脑端工作。', t0 + 2000)
  assert.equal(disabled.changed, true)
  assert.match(disabled.message, /反茄钟已关闭/)

  const snapshot = antiPomodoro.getAntiPomodoroSnapshot(t0 + 3000)
  assert.equal(snapshot.enabled, false)
  assert.equal(snapshot.phase, null)
})
