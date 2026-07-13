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

test('buildAskUserText renders five-element layout for AI question', () => {
  const out = messageFormat.buildAskUserText({
    kind: 'interactive_card',
    cardId: 'c1',
    question: '用 React 还是 Vue？',
    options: [
      { id: '1', label: 'React' },
      { id: '2', label: 'Vue' },
    ],
    allowFreeText: true,
    timeoutHint: '8 分钟',
  })
  // 五要素全要在
  assert.match(out, /^🤔 Claude 想问你/, '首行标识')
  assert.match(out, /用 React 还是 Vue？/, '问题主体')
  assert.match(out, /1\) React/, '编号选项 1')
  assert.match(out, /2\) Vue/, '编号选项 2')
  assert.match(out, /✏️ 直接回复编号或你的自定义答案/, 'Other 入口')
  assert.match(out, /⏱ 8 分钟内未回复将自动继续/, '超时提示')
})

test('buildAskUserText omits Other hint when allowFreeText=false', () => {
  const out = messageFormat.buildAskUserText({
    kind: 'interactive_card',
    cardId: 'c2',
    question: 'Q',
    options: [{ id: '1', label: 'A' }],
    allowFreeText: false,
    timeoutHint: '5 分钟',
  })
  assert.doesNotMatch(out, /✏️/)
  assert.match(out, /⏱ 5 分钟/)
})

test('buildAskUserText prefixes degraded note when degradedNote=true', () => {
  const out = messageFormat.buildAskUserText({
    kind: 'interactive_card',
    cardId: 'c3',
    question: 'Q',
    options: [{ id: '1', label: 'A' }],
    allowFreeText: true,
    degradedNote: true,
  })
  assert.match(out, /^🤔 Claude 想问你（卡片渲染失败，已降级）/)
})

test('renderOutgoingMessageAsText routes interactive_card through buildAskUserText', () => {
  const direct = messageFormat.buildAskUserText({
    kind: 'interactive_card',
    cardId: 'c4',
    question: 'Q',
    options: [{ id: '1', label: 'A' }],
    allowFreeText: true,
  })
  const viaRender = messageFormat.renderOutgoingMessageAsText({
    kind: 'interactive_card',
    cardId: 'c4',
    question: 'Q',
    options: [{ id: '1', label: 'A' }],
    allowFreeText: true,
  })
  assert.equal(viaRender, direct)
})

// --- AI Markdown 回复渲染（飞书 post+md tag / 微信纯文本降级） ---

const MARKDOWN_SAMPLE = [
  '# 一级标题',
  '## 二级标题',
  '',
  '正文带 **粗体** 和 `inline code`，还有普通纯文本。',
  '',
  '- 列表项 1',
  '- 列表项 2',
  '',
  '```js',
  'const x = 1',
  'console.log(x)',
  '```',
].join('\n')

test('markdownTextMessage 标记 markdown=true 的 text 消息', () => {
  const msg = messageFormat.markdownTextMessage('**bold**')
  assert.equal(msg.kind, 'text')
  assert.equal(msg.text, '**bold**')
  assert.equal(msg.markdown, true)
})

test('buildFeishuMessage 把 markdown text 渲染为 post + md tag（原文直送，不 escape/不转列表）', () => {
  const payload = messageFormat.buildFeishuMessage(messageFormat.markdownTextMessage(MARKDOWN_SAMPLE))
  assert.equal(payload.msgType, 'post')

  const parsed = JSON.parse(payload.content)
  // AI 回复无标题：不带 title 字段（避免飞书空标题行）
  assert.equal(parsed.zh_cn.title, undefined)
  // 单段单元素，整段 markdown 塞进一个 md tag
  assert.equal(parsed.zh_cn.content.length, 1)
  assert.equal(parsed.zh_cn.content[0].length, 1)
  assert.equal(parsed.zh_cn.content[0][0].tag, 'md')

  // 关键：md text 与原文完全一致 —— 证明标题/列表/粗体/inline code/code block 均未被转义或改写
  const mdText = parsed.zh_cn.content[0][0].text
  assert.equal(mdText, MARKDOWN_SAMPLE)

  // 逐项确认 markdown 符号原样保留（过度 escape 会让飞书 md tag 也不渲染）
  assert.match(mdText, /^# 一级标题/m, '标题 # 保留')
  assert.match(mdText, /^## 二级标题/m, '二级标题保留')
  assert.match(mdText, /\*\*粗体\*\*/, '粗体 ** 保留')
  assert.match(mdText, /`inline code`/, 'inline code 反引号保留')
  assert.match(mdText, /^- 列表项 1/m, '列表 - 保留')
  assert.match(mdText, /```js\nconst x = 1/, 'fenced code block 保留')

  // 不能出现反斜杠转义（如 \# \* \- \` \[ 等）
  assert.doesNotMatch(mdText, /\\[#*`\-[\]()]/, '不应有反斜杠转义')
})

test('buildFeishuMessage 普通 text（无 markdown 标记）仍走 text msg_type，符号原样不渲染', () => {
  const payload = messageFormat.buildFeishuMessage(messageFormat.textMessage('**bold** 与 # 号'))
  assert.equal(payload.msgType, 'text')
  const parsed = JSON.parse(payload.content)
  assert.equal(parsed.text, '**bold** 与 # 号')
})

test('buildFeishuMessage 空 markdown text 退回 text msg_type，避免空 post 卡片', () => {
  for (const empty of ['', '   ', '\n\n']) {
    const payload = messageFormat.buildFeishuMessage(messageFormat.markdownTextMessage(empty))
    assert.equal(payload.msgType, 'text', `空文本 ${JSON.stringify(empty)} 应退回 text`)
  }
})

test('renderOutgoingMessageAsText 对 markdown text 返回原文（微信纯文本降级，不破坏微信通道）', () => {
  const rendered = messageFormat.renderOutgoingMessageAsText(messageFormat.markdownTextMessage(MARKDOWN_SAMPLE))
  assert.equal(rendered, MARKDOWN_SAMPLE)
})
