import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { FeishuAdapter } = await import(path.join(rootDir, 'dist', 'src', 'feishu.js'))

function makeConfig() {
  return {
    feishu: { appId: 'app-id', appSecret: 'app-secret' },
    allowedUserIds: [],
    pathWhitelist: ['/tmp'],
    defaultPermissionMode: 'default',
    defaultModes: {},
    defaultTimeoutSeconds: 600,
    recapBudget: 2000,
    maxFileSizeMB: 10,
    inboxTtlMinutes: 60,
    pollIntervalMs: 5000,
  }
}

test('FeishuAdapter recreates client after timeout errors', async () => {
  const adapter = new FeishuAdapter(makeConfig())
  const replacementClient = { marker: 'replacement' }
  let rebuilds = 0

  adapter.createClient = () => {
    rebuilds++
    return replacementClient
  }

  const timeoutError = Object.assign(new Error('timeout of 15000ms exceeded'), {
    code: 'ECONNABORTED',
  })

  await assert.rejects(
    adapter.runRequest('发送消息', async () => {
      throw timeoutError
    }),
    /timeout of 15000ms exceeded/,
  )

  assert.equal(rebuilds, 1)
  assert.equal(adapter.client, replacementClient)
})

test('FeishuAdapter falls back to Lark domain after Feishu DNS failure', async () => {
  const adapter = new FeishuAdapter(makeConfig())
  const replacementClient = { marker: 'lark-client' }
  let rebuilds = 0
  let calls = 0

  adapter.createClient = () => {
    rebuilds++
    return replacementClient
  }

  const result = await adapter.runRequest('拉取群列表', async () => {
    calls++
    if (calls === 1) {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND open.feishu.cn'), {
        code: 'ENOTFOUND',
      })
    }
    return { ok: true }
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(calls, 2)
  assert.equal(rebuilds, 1)
  assert.equal(adapter.client, replacementClient)
})

test('FeishuAdapter does not recreate client for non-timeout errors', async () => {
  const adapter = new FeishuAdapter(makeConfig())
  const originalClient = adapter.client
  let rebuilds = 0

  adapter.createClient = () => {
    rebuilds++
    return { marker: 'unexpected' }
  }

  await assert.rejects(
    adapter.runRequest('拉取群列表', async () => {
      throw new Error('unauthorized')
    }),
    /unauthorized/,
  )

  assert.equal(rebuilds, 0)
  assert.equal(adapter.client, originalClient)
})

test('parseRestMessage 对 post 类型返回 unsupported 并附带中文提示', () => {
  const adapter = new FeishuAdapter(makeConfig())
  const msg = adapter.parseRestMessage({
    message_id: 'om_post_001',
    chat_id: 'oc_abc',
    msg_type: 'post',
    sender: { id: 'ou_user', sender_type: 'user' },
    body: { content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: 'hi' }]] }) },
  })
  assert.ok(msg)
  assert.equal(msg.kind, 'unsupported')
  assert.match(msg.text ?? '', /图文混合|暂不支持/)
  // 保留原 messageId，方便 addReaction / 日志定位
  assert.equal(msg.messageId, 'om_post_001')
})

test('parseRestMessage 对未知类型仍返回 null（不抛错）', () => {
  const adapter = new FeishuAdapter(makeConfig())
  const msg = adapter.parseRestMessage({
    message_id: 'om_sticker_001',
    chat_id: 'oc_abc',
    msg_type: 'sticker',
    sender: { id: 'ou_user', sender_type: 'user' },
    body: { content: '{}' },
  })
  assert.equal(msg, null)
})

test('parseRestMessage 对 text 类型正常解析', () => {
  const adapter = new FeishuAdapter(makeConfig())
  const msg = adapter.parseRestMessage({
    message_id: 'om_text_001',
    chat_id: 'oc_abc',
    msg_type: 'text',
    sender: { id: 'ou_user', sender_type: 'user' },
    body: { content: JSON.stringify({ text: '/fc im2cc' }) },
  })
  assert.ok(msg)
  assert.equal(msg.kind, 'text')
  assert.equal(msg.text, '/fc im2cc')
})

test('FeishuAdapter sends structured panel messages as post payloads', async () => {
  const adapter = new FeishuAdapter(makeConfig())
  let captured = null

  adapter.client = {
    im: {
      message: {
        create: async (payload) => {
          captured = payload
          return {}
        },
      },
    },
  }

  await adapter.sendMessage('oc_test', {
    kind: 'panel',
    title: '反茄钟',
    sections: [{ lines: ['状态：进行中'] }],
  })

  assert.ok(captured)
  assert.equal(captured.data.msg_type, 'post')
  const content = JSON.parse(captured.data.content)
  assert.equal(content.zh_cn.title, '反茄钟')
  assert.match(content.zh_cn.content[0][0].text, /\*\*状态：\*\*/)
})
