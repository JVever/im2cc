import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-wechat-'))
process.env.HOME = testHome

const { WeChatAdapter } = await import(path.join(rootDir, 'dist', 'src', 'wechat.js'))

after(() => fs.rmSync(testHome, { recursive: true, force: true }))

function makeAdapter() {
  return new WeChatAdapter({
    botToken: 'bot-token',
    baseUrl: 'https://example.invalid',
    ilinkBotId: 'bot-id',
    ilinkUserId: 'user-id',
    savedAt: new Date().toISOString(),
    lastOkAt: '',
    syncBuf: '',
  })
}

function makeRawMessage(overrides = {}) {
  return {
    message_id: 101,
    from_user_id: 'wx-user',
    message_type: 1,
    context_token: 'fresh-context-token',
    item_list: [],
    ...overrides,
  }
}

test('微信原生 voice_item.text 转写进入现有文字消息链路', async () => {
  const adapter = makeAdapter()
  const received = []

  await adapter.handleRawMessage(makeRawMessage({
    item_list: [{ type: 3, voice_item: { text: '  请检查这个项目的测试  ' } }],
  }), async msg => { received.push(msg) })

  assert.equal(received.length, 1)
  assert.deepEqual(received[0], {
    messageId: '101',
    conversationId: 'wechat:wx-user',
    transport: 'wechat',
    senderId: 'wx-user',
    kind: 'text',
    text: '请检查这个项目的测试',
  })
})

test('语音转写为空时回复明确提示，不静默丢弃或进入 AI 链路', async () => {
  const adapter = makeAdapter()
  const received = []
  const replies = []
  adapter.sendRawText = async (conversationId, text) => { replies.push({ conversationId, text }) }

  await adapter.handleRawMessage(makeRawMessage({
    item_list: [{ type: 3, voice_item: {} }],
  }), async msg => { received.push(msg) })

  assert.equal(received.length, 0)
  assert.equal(replies.length, 1)
  assert.equal(replies[0].conversationId, 'wechat:wx-user')
  assert.match(replies[0].text, /没有识别出文字/)
  assert.equal(adapter.contextTokens.get('wx-user')?.token, 'fresh-context-token')
})

test('普通微信文字消息保持原有行为', async () => {
  const adapter = makeAdapter()
  const received = []

  await adapter.handleRawMessage(makeRawMessage({
    item_list: [{ type: 1, text_item: { text: '/fs' } }],
  }), async msg => { received.push(msg) })

  assert.equal(received.length, 1)
  assert.equal(received[0].text, '/fs')
})

test('真正不支持的非文本消息提示不再把语音列为不支持', async () => {
  const adapter = makeAdapter()
  const replies = []
  adapter.sendRawText = async (_conversationId, text) => { replies.push(text) }

  await adapter.handleRawMessage(makeRawMessage({ message_type: 3 }), async () => {})

  assert.equal(replies.length, 1)
  assert.match(replies[0], /文件、图片或视频/)
  assert.doesNotMatch(replies[0], /语音/)
})
