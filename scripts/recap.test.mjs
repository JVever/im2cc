import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const recap = await import(path.join(rootDir, 'dist', 'src', 'recap.js'))

test('buildRecapMessages keeps short recent turn in a single message', () => {
  const messages = recap.buildRecapMessages({
    user: '最近这个功能修好了吗？',
    assistant: '修好了，已经补了测试并验证通过。',
  }, {
    intro: '✅ 已接入 "demo" [codex]\n📁 im2cc',
    transport: 'feishu',
  })

  assert.equal(messages.length, 1)
  assert.match(messages[0], /✅ 已接入 "demo" \[codex\]/)
  assert.match(messages[0], /📋 最近一轮对话 1\/1/)
  assert.match(messages[0], /【你】\n最近这个功能修好了吗？/)
  assert.match(messages[0], /【AI】\n修好了，已经补了测试并验证通过。/)
})

test('buildRecapMessages splits long assistant replies and keeps labels explicit', () => {
  const assistant = Array.from({ length: 900 }, (_, i) => `第${i + 1}段说明。`).join('\n')
  const messages = recap.buildRecapMessages({
    user: '把最近一轮完整发给我。',
    assistant,
  }, {
    transport: 'wechat',
  })

  assert.ok(messages.length >= 2)
  assert.ok(messages.length <= 3)
  assert.match(messages[0], /【你】\n把最近一轮完整发给我。/)
  assert.match(messages[0], /【AI】\n/)
  assert.match(messages[1], /📋 最近一轮对话 2\//)
  assert.match(messages[1], /【AI - 续】\n/)
})

test('buildRecapMessages never exceeds three messages', () => {
  const assistant = '内容'.repeat(15000)
  const messages = recap.buildRecapMessages({
    user: '请继续。',
    assistant,
  }, {
    transport: 'wechat',
  })

  assert.equal(messages.length, 3)
})

test('buildRecapMessages truncates from the front when the latest AI reply still exceeds three messages', () => {
  const assistant = `START-MARKER ${'前文'.repeat(7000)} FINAL-ANSWER`
  const messages = recap.buildRecapMessages({
    user: '最后结论是什么？',
    assistant,
  }, {
    transport: 'wechat',
  })

  const combined = messages.join('\n')
  assert.equal(messages.length, 3)
  assert.match(combined, /…\(前文已省略\)/)
  assert.doesNotMatch(combined, /START-MARKER/)
  assert.match(combined, /FINAL-ANSWER/)
})
