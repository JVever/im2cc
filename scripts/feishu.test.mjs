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
