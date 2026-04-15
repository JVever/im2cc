import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(path.join(rootDir, 'dist', 'src', 'shell-install.js'))
const {
  SHELL_MARKER_START,
  SHELL_MARKER_END,
  IM2CC_SHELL_FUNCTIONS,
  stripLegacyIm2ccLines,
  renderShellBlock,
  computeUpdatedRcContent,
  writeShellHelpersToRc,
} = mod

function tmpRcWith(content) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-sh-rc-'))
  const rc = path.join(tmp, '.zshrc')
  fs.writeFileSync(rc, content)
  return rc
}

test('renderShellBlock wraps functions with markers', () => {
  const block = renderShellBlock()
  assert.match(block, new RegExp(`^${SHELL_MARKER_START}`))
  assert.match(block, new RegExp(`${SHELL_MARKER_END}$`))
  assert.ok(block.includes(IM2CC_SHELL_FUNCTIONS))
})

test('stripLegacyIm2ccLines removes old fn / fhelp / source-file lines', () => {
  const legacy = [
    'export PATH=/usr/local/bin:$PATH',
    '# im2cc — 终端命令（旧格式）',
    'source ~/.local/bin/im2cc-shell-functions.zsh',
    'fn()       { im2cc new "$@"; }',
    'fn-codex() { im2cc new --tool codex "$@"; }',
    'fhelp()    { im2cc help; }',
    'fqon()     { im2cc fqon "$@"; }',
    'alias ll="ls -la"',
  ].join('\n')
  const cleaned = stripLegacyIm2ccLines(legacy)
  assert.ok(cleaned.includes('export PATH'))
  assert.ok(cleaned.includes('alias ll'))
  assert.ok(!cleaned.includes('im2cc-shell-functions'))
  assert.ok(!cleaned.includes('fn()'))
  assert.ok(!cleaned.includes('fn-codex'))
  assert.ok(!cleaned.includes('fhelp'))
  assert.ok(!cleaned.includes('fqon'))
})

test('computeUpdatedRcContent creates block when rc is empty', () => {
  const { content, action } = computeUpdatedRcContent('')
  assert.equal(action, 'created')
  assert.ok(content.includes(SHELL_MARKER_START))
  assert.ok(content.includes(IM2CC_SHELL_FUNCTIONS))
  assert.ok(content.includes(SHELL_MARKER_END))
})

test('computeUpdatedRcContent appends block to existing unrelated rc content', () => {
  const existing = 'export FOO=bar\n'
  const { content, action } = computeUpdatedRcContent(existing)
  assert.equal(action, 'updated')
  assert.ok(content.startsWith('export FOO=bar'))
  assert.ok(content.includes(SHELL_MARKER_START))
})

test('computeUpdatedRcContent is idempotent when block already matches', () => {
  const block = renderShellBlock() + '\n'
  const existing = 'export FOO=bar\n\n' + block
  const { content, action } = computeUpdatedRcContent(existing)
  assert.equal(action, 'unchanged')
  assert.equal(content, existing)
})

test('computeUpdatedRcContent replaces old block content but keeps user content', () => {
  const oldBlock = [SHELL_MARKER_START, 'fn()       { echo OLD_FN; }', SHELL_MARKER_END].join('\n') + '\n'
  const existing = 'export FOO=bar\n\n' + oldBlock + '\nexport BAR=baz\n'
  const { content, action } = computeUpdatedRcContent(existing)
  assert.equal(action, 'updated')
  assert.ok(content.includes('export FOO=bar'))
  assert.ok(content.includes('export BAR=baz'))
  assert.ok(content.includes(IM2CC_SHELL_FUNCTIONS))
  assert.ok(!content.includes('echo OLD_FN'))
})

test('computeUpdatedRcContent cleans legacy loose lines before appending block', () => {
  const existing = [
    'export FOO=bar',
    '# im2cc — 终端命令（薄包装）',
    'fn()       { im2cc new "$@"; }',
    'fn-codex() { im2cc new --tool codex "$@"; }',
    'fn-kimi()  { im2cc new --tool kimi "$@"; }',
    'fhelp()    { im2cc help; }',
    'export BAR=baz',
    '',
  ].join('\n')
  const { content, action } = computeUpdatedRcContent(existing)
  assert.equal(action, 'updated')
  // Legacy loose lines gone
  assert.ok(!content.includes('fn-kimi'))
  // User content preserved
  assert.ok(content.includes('export FOO=bar'))
  assert.ok(content.includes('export BAR=baz'))
  // Fresh block at end
  assert.ok(content.trimEnd().endsWith(SHELL_MARKER_END))
  // Exactly one block
  const occurrences = content.match(new RegExp(SHELL_MARKER_START, 'g')) ?? []
  assert.equal(occurrences.length, 1)
})

test('writeShellHelpersToRc applies the same logic to a real file', () => {
  const rc = tmpRcWith('export FOO=bar\n')
  const action1 = writeShellHelpersToRc(rc)
  assert.equal(action1, 'updated')
  const after1 = fs.readFileSync(rc, 'utf-8')
  assert.ok(after1.includes(SHELL_MARKER_START))

  // Second call is idempotent
  const action2 = writeShellHelpersToRc(rc)
  assert.equal(action2, 'unchanged')
  const after2 = fs.readFileSync(rc, 'utf-8')
  assert.equal(after2, after1)
})
