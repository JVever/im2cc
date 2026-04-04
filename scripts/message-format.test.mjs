import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const messageFormat = await import(path.join(rootDir, 'dist', 'src', 'message-format.js'))

test('structureSystemReply converts multi-section system text into panel message', () => {
  const reply = [
    '📖 im2cc 帮助',
    '',
    '首次使用：先在电脑终端运行 fn <名称> 创建第一个对话，再回到飞书发送 /fc <名称> 接入。',
    '',
    '电脑终端：',
    'fhelp                    — 查看帮助',
    'fqon                     — 开启反茄钟',
    '',
    '飞书 / 微信：',
    '/fhelp                   — 查看帮助',
  ].join('\n')

  const structured = messageFormat.structureSystemReply(reply)
  assert.equal(structured.kind, 'panel')
  assert.equal(structured.title, '📖 im2cc 帮助')
  assert.equal(structured.sections[0].title, undefined)
  assert.deepEqual(structured.sections[0].lines, [
    '首次使用：先在电脑终端运行 fn <名称> 创建第一个对话，再回到飞书发送 /fc <名称> 接入。',
  ])
  assert.deepEqual(structured.sections[1], {
    title: '电脑终端',
    lines: [
      'fhelp                    — 查看帮助',
      'fqon                     — 开启反茄钟',
    ],
  })
})

test('renderOutgoingMessageAsText keeps panel messages readable for text-only transports', () => {
  const panel = messageFormat.panelMessage('反茄钟', [
    { lines: ['状态：进行中', '阶段：休息时间'] },
    { title: '关闭', lines: ['电脑端 fqoff'] },
  ])

  const rendered = messageFormat.renderOutgoingMessageAsText(panel)
  assert.match(rendered, /^反茄钟/)
  assert.match(rendered, /状态：进行中/)
  assert.match(rendered, /关闭：\n电脑端 fqoff/)
})

test('buildFeishuMessage renders panel messages as post payloads', () => {
  const panel = messageFormat.panelMessage('反茄钟', [
    { lines: ['状态：进行中', '阶段：工作时间'] },
    { title: '关闭', lines: ['电脑端 fqoff'] },
  ])

  const payload = messageFormat.buildFeishuMessage(panel)
  assert.equal(payload.msgType, 'post')

  const parsed = JSON.parse(payload.content)
  assert.equal(parsed.zh_cn.title, '反茄钟')
  assert.equal(parsed.zh_cn.content.length, 2)
  assert.equal(parsed.zh_cn.content[0][0].tag, 'md')
  assert.match(parsed.zh_cn.content[0][0].text, /\*\*状态：\*\*/)
  assert.match(parsed.zh_cn.content[1][0].text, /\*\*关闭\*\*/)
})
