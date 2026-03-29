import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const cliPath = path.join(rootDir, 'dist', 'bin', 'im2cc.js')

test('cli help reflects focused support matrix', () => {
  const stdout = execFileSync('node', [cliPath], {
    cwd: rootDir,
    encoding: 'utf-8',
  })

  assert.match(stdout, /正式支持:/)
  assert.match(stdout, /IM: 飞书 \/ 微信/)
  assert.match(stdout, /Tool: Claude Code \/ Codex/)
  assert.match(stdout, /Best-effort: Gemini/)
  assert.match(stdout, /onboard\s+查看首次安装与 post-success 引导/)
  assert.match(stdout, /secure\s+配置用户白名单和路径白名单/)
  assert.match(stdout, /upgrade\s+升级到最新版本/)
  assert.doesNotMatch(stdout, /Telegram/)
  assert.doesNotMatch(stdout, /钉钉/)
  assert.doesNotMatch(stdout, /Kimi/)
})

test('explicit cli help exposes unified command guide', () => {
  const stdout = execFileSync('node', [cliPath, 'help'], {
    cwd: rootDir,
    encoding: 'utf-8',
  })

  assert.match(stdout, /📖 im2cc 帮助/)
  assert.match(stdout, /fhelp\s+— 查看帮助/)
  assert.match(stdout, /im2cc onboard\s+— 查看首次安装引导/)
  assert.match(stdout, /im2cc upgrade\s+— 升级到最新版本/)
  assert.match(stdout, /fn-codex <名称>/)
  assert.match(stdout, /\/fhelp\s+— 查看帮助/)
  assert.match(stdout, /飞书支持发送图片或文件/)
  assert.doesNotMatch(stdout, /Claude 分析/)
})

test('onboard prints phased guidance', () => {
  const stdout = execFileSync('node', [cliPath, 'onboard'], {
    cwd: rootDir,
    encoding: 'utf-8',
  })

  assert.match(stdout, /Phase 1: First Success/)
  assert.match(stdout, /Phase 2: Make It Stick/)
  assert.match(stdout, /im2cc doctor/)
  assert.match(stdout, /im2cc help/)
})
