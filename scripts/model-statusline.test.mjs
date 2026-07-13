import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = path.join(rootDir, 'dist/bin/im2cc.js')
const observerPath = path.join(rootDir, 'shell/im2cc-model-statusline.sh')

function run(command, args, env, input = '') {
  return spawnSync(command, args, { env, input, encoding: 'utf-8', timeout: 3000 })
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

test('install-hook preserves the existing statusline chain and observer sync is exact + idempotent', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-model-statusline-'))
  const env = { ...process.env, HOME: home }
  const claudeDir = path.join(home, '.claude')
  const dataDir = path.join(home, '.im2cc/data')
  const settingsPath = path.join(claudeDir, 'settings.json')
  const registryPath = path.join(dataDir, 'registry.json')
  const hudCommand = `printf 'HUD OK\\n'`
  const cwd = path.join(home, 'Code/demo')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify({
    statusLine: { type: 'command', command: hudCommand },
    hooks: {},
  }))
  fs.writeFileSync(registryPath, JSON.stringify({
    chat: {
      sessionId: 'session-statusline',
      cwd,
      tool: 'claude',
      createdAt: '2026-07-13T00:00:00.000Z',
      lastUsedAt: '2026-07-13T00:00:00.000Z',
    },
  }))

  try {
    const firstInstall = run(process.execPath, [cliPath, 'install-hook'], env)
    assert.equal(firstInstall.status, 0, firstInstall.stderr)
    assert.match(firstInstall.stdout, /session \+ 精确模型同步已配置/)
    assert.equal(readJson(settingsPath).statusLine.command, observerPath)
    assert.equal(fs.readFileSync(path.join(dataDir, 'statusline-next-command'), 'utf-8'), hudCommand)

    const payload = JSON.stringify({
      session_id: 'session-statusline',
      cwd,
      transcript_path: path.join(home, '.claude/projects/demo/session-statusline.jsonl'),
      model: { id: 'claude-sonnet-5', display_name: 'Sonnet 5' },
    })
    const observed = run('/bin/sh', [observerPath], env, payload)
    assert.equal(observed.status, 0, observed.stderr)
    assert.equal(observed.stdout, 'HUD OK\n')
    assert.equal(readJson(registryPath).chat.selectedModelId, 'claude-sonnet-5')

    // 模拟微信随后选择 Opus；同一个旧 statusline 周期刷新不得抢回 Sonnet。
    const afterImSwitch = readJson(registryPath)
    afterImSwitch.chat.selectedModelId = 'claude-opus-5'
    afterImSwitch.chat.modelSelectionUpdatedAt = '2099-01-01T00:00:00.000Z'
    fs.writeFileSync(registryPath, JSON.stringify(afterImSwitch, null, 2))
    const repeated = run('/bin/sh', [observerPath], env, payload)
    assert.equal(repeated.stdout, 'HUD OK\n')
    assert.equal(readJson(registryPath).chat.selectedModelId, 'claude-opus-5')

    // 不同模型的旧 payload 即使排队到锁后执行，也不能覆盖更新的 IM 事件。
    const switchedPayload = JSON.stringify({ ...JSON.parse(payload), model: { id: 'claude-haiku-5' } })
    const lockDir = path.join(dataDir, 'registry.lock')
    fs.mkdirSync(lockDir)
    const waitingObserver = spawn('/bin/sh', [observerPath], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let waitingStdout = ''
    waitingObserver.stdout.setEncoding('utf-8')
    waitingObserver.stdout.on('data', chunk => { waitingStdout += chunk })
    waitingObserver.stdin.end(switchedPayload)
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(readJson(registryPath).chat.selectedModelId, 'claude-opus-5')
    fs.rmdirSync(lockDir)
    const waitingExit = await new Promise(resolve => waitingObserver.on('close', resolve))
    assert.equal(waitingExit, 0)
    assert.equal(waitingStdout, 'HUD OK\n')
    assert.equal(readJson(registryPath).chat.selectedModelId, 'claude-opus-5')
    assert.equal(readJson(path.join(dataDir, 'statusline-model-state.json'))['session-statusline'], 'claude-haiku-5')

    // 新到的真实 Terminal 切换事件仍然可以成为最终值。
    const beforeFreshTerminal = readJson(registryPath)
    beforeFreshTerminal.chat.modelSelectionUpdatedAt = '2000-01-01T00:00:00.000Z'
    fs.writeFileSync(registryPath, JSON.stringify(beforeFreshTerminal, null, 2))
    const freshTerminalPayload = JSON.stringify({ ...JSON.parse(payload), model: { id: 'claude-opus-terminal-5' } })
    run('/bin/sh', [observerPath], env, freshTerminalPayload)
    assert.equal(readJson(registryPath).chat.selectedModelId, 'claude-opus-terminal-5')

    // 自定义 provider 的完整 ID 不一定以 claude- 开头（例如 Fable），仍须精确同步。
    const customProviderPayload = JSON.stringify({ ...JSON.parse(payload), model: { id: 'fable-2026-07-13' } })
    run('/bin/sh', [observerPath], env, customProviderPayload)
    assert.equal(readJson(registryPath).chat.selectedModelId, 'fable-2026-07-13')

    // alias 不是精确 ID，不能进入 Session registry。
    const aliasPayload = JSON.stringify({ ...JSON.parse(payload), model: { id: 'opus' } })
    run('/bin/sh', [observerPath], env, aliasPayload)
    assert.equal(readJson(registryPath).chat.selectedModelId, 'fable-2026-07-13')
    const versionAliasPayload = JSON.stringify({ ...JSON.parse(payload), model: { id: 'sonnet-5' } })
    run('/bin/sh', [observerPath], env, versionAliasPayload)
    assert.equal(readJson(registryPath).chat.selectedModelId, 'fable-2026-07-13')

    // 重复安装不能把 observer 自己写成 next 造成递归。
    const secondInstall = run(process.execPath, [cliPath, 'install-hook'], env)
    assert.equal(secondInstall.status, 0, secondInstall.stderr)
    assert.equal(fs.readFileSync(path.join(dataDir, 'statusline-next-command'), 'utf-8'), hudCommand)

    // 第三方在两次安装之间夹装：Vibe leaf 回指 observer。再次 install-hook 必须保留
    // 先前安全 HUD leaf，observer → Vibe → observer(active) → HUD 有限终止。
    const vibeBinDir = path.join(home, '.vibe-island/bin')
    const vibeCacheDir = path.join(home, '.vibe-island/cache')
    const vibeScript = path.join(vibeBinDir, 'vibe-island-statusline-chain')
    const vibeLeaf = path.join(vibeCacheDir, 'statusline-chain-original-command')
    fs.mkdirSync(vibeBinDir, { recursive: true })
    fs.mkdirSync(vibeCacheDir, { recursive: true })
    fs.writeFileSync(vibeLeaf, observerPath)
    fs.writeFileSync(vibeScript, `#!/bin/sh\ninput=$(mktemp) || exit 0\ntrap 'rm -f "$input"' EXIT\ncat > "$input"\ncmd=$(cat "$HOME/.vibe-island/cache/statusline-chain-original-command")\n/bin/sh -c "$cmd" < "$input"\n`, { mode: 0o755 })
    const thirdPartySettings = readJson(settingsPath)
    thirdPartySettings.statusLine.command = vibeScript
    fs.writeFileSync(settingsPath, JSON.stringify(thirdPartySettings, null, 2))

    const thirdInstall = run(process.execPath, [cliPath, 'install-hook'], env)
    assert.equal(thirdInstall.status, 0, thirdInstall.stderr)
    assert.equal(fs.readFileSync(path.join(dataDir, 'statusline-next-command'), 'utf-8'), vibeScript)
    assert.equal(fs.readFileSync(path.join(dataDir, 'statusline-fallback-command'), 'utf-8'), hudCommand)

    const afterThirdParty = run('/bin/sh', [observerPath], env, payload)
    assert.equal(afterThirdParty.status, 0, afterThirdParty.stderr)
    assert.equal(afterThirdParty.signal, null)
    assert.equal(afterThirdParty.stdout, 'HUD OK\n')
    assert.equal(readJson(registryPath).chat.selectedModelId, 'claude-sonnet-5')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('third-party observer loop degrades to empty output when no safe statusline leaf exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-model-loop-empty-'))
  const env = { ...process.env, HOME: home }
  const claudeDir = path.join(home, '.claude')
  const dataDir = path.join(home, '.im2cc/data')
  const vibeBinDir = path.join(home, '.vibe-island/bin')
  const vibeCacheDir = path.join(home, '.vibe-island/cache')
  const vibeScript = path.join(vibeBinDir, 'vibe-island-statusline-chain')
  const cwd = path.join(home, 'Code/demo')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(vibeBinDir, { recursive: true })
  fs.mkdirSync(vibeCacheDir, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  fs.writeFileSync(path.join(vibeCacheDir, 'statusline-chain-original-command'), observerPath)
  fs.writeFileSync(vibeScript, `#!/bin/sh\ninput=$(mktemp) || exit 0\ntrap 'rm -f "$input"' EXIT\ncat > "$input"\ncmd=$(cat "$HOME/.vibe-island/cache/statusline-chain-original-command")\n/bin/sh -c "$cmd" < "$input"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: vibeScript },
    hooks: {},
  }))
  fs.writeFileSync(path.join(dataDir, 'registry.json'), JSON.stringify({
    chat: {
      sessionId: 'session-empty-loop', cwd, tool: 'claude',
      createdAt: '2026-07-13T00:00:00.000Z', lastUsedAt: '2026-07-13T00:00:00.000Z',
    },
  }))

  try {
    const install = run(process.execPath, [cliPath, 'install-hook'], env)
    assert.equal(install.status, 0, install.stderr)
    assert.equal(fs.readFileSync(path.join(dataDir, 'statusline-fallback-command'), 'utf-8'), '')

    const payload = JSON.stringify({
      session_id: 'session-empty-loop', cwd,
      transcript_path: path.join(home, '.claude/projects/demo/session-empty-loop.jsonl'),
      model: { id: 'claude-opus-4-8' },
    })
    const observed = run('/bin/sh', [observerPath], env, payload)
    assert.equal(observed.status, 0, observed.stderr)
    assert.equal(observed.signal, null)
    assert.equal(observed.stdout, '')
    assert.equal(readJson(path.join(dataDir, 'registry.json')).chat.selectedModelId, 'claude-opus-4-8')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
