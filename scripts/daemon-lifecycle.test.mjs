import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const cliPath = path.join(rootDir, 'dist', 'bin', 'im2cc.js')
const daemonProcessModulePath = path.join(rootDir, 'dist', 'src', 'daemon-process.js')

function createHomeDir() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-smoke-home-'))
  fs.mkdirSync(path.join(homeDir, '.im2cc'), { recursive: true })
  return homeDir
}

function pidFileFor(homeDir) {
  return path.join(homeDir, '.im2cc', 'daemon.pid')
}

function runCli(homeDir, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, HOME: homeDir },
    encoding: 'utf-8',
  })
}

function waitForProcessExit(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => clearTimeout(timer)

    child.once('exit', () => {
      cleanup()
      resolve()
    })
  })
}

function spawnIdleNode(args, options = {}) {
  return spawn(process.execPath, args, {
    stdio: 'ignore',
    ...options,
  })
}

function assertAlive(pid) {
  process.kill(pid, 0)
}

function terminateProcess(child) {
  if (!child.pid) return Promise.resolve()

  try {
    process.kill(child.pid, 'SIGTERM')
  } catch {
    return Promise.resolve()
  }

  return waitForProcessExit(child).catch(() => {
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch {}
  })
}

test('status/stop do not trust an unrelated live pid from daemon.pid', async () => {
  const homeDir = createHomeDir()
  const unrelated = spawnIdleNode(['-e', 'setInterval(() => {}, 1000)'])

  try {
    fs.writeFileSync(pidFileFor(homeDir), `${unrelated.pid}\n`)

    const status = runCli(homeDir, ['status'])
    assert.equal(status.status, 0, status.stderr)
    assert.match(status.stdout, /未运行/)
    assert.ok(!fs.existsSync(pidFileFor(homeDir)), 'status should clean the stale pid file')

    fs.writeFileSync(pidFileFor(homeDir), `${unrelated.pid}\n`)
    const stop = runCli(homeDir, ['stop'])
    assert.equal(stop.status, 0, stop.stderr)
    assert.match(stop.stdout, /已清理残留状态/)
    assertAlive(unrelated.pid)
  } finally {
    await terminateProcess(unrelated)
  }
})

test('killAllDaemonProcesses kills zombie processes on startup', async () => {
  const { killAllDaemonProcesses, DAEMON_PROCESS_TITLE } = await import(daemonProcessModulePath)

  // 创建两个模拟僵尸进程（设置 process.title = im2cc-daemon）
  const zombie1 = spawnIdleNode(['-e', `process.title='${DAEMON_PROCESS_TITLE}'; setInterval(()=>{},1000)`])
  const zombie2 = spawnIdleNode(['-e', `process.title='${DAEMON_PROCESS_TITLE}'; setInterval(()=>{},1000)`])

  // 等待进程启动并设置 title
  await new Promise(r => setTimeout(r, 500))

  try {
    // 验证两个僵尸都在运行
    assertAlive(zombie1.pid)
    assertAlive(zombie2.pid)

    // killAllDaemonProcesses 应该杀死两个僵尸（排除自身）
    const killed = killAllDaemonProcesses(undefined, process.pid)
    assert.ok(killed.length >= 2, `应至少杀死 2 个进程，实际杀了 ${killed.length} 个`)

    // 等待进程退出
    await Promise.all([
      waitForProcessExit(zombie1, 5000).catch(() => {}),
      waitForProcessExit(zombie2, 5000).catch(() => {}),
    ])

    // 验证僵尸都已死亡
    assert.throws(() => process.kill(zombie1.pid, 0), { code: 'ESRCH' }, 'zombie1 应已死亡')
    assert.throws(() => process.kill(zombie2.pid, 0), { code: 'ESRCH' }, 'zombie2 应已死亡')
  } finally {
    await terminateProcess(zombie1).catch(() => {})
    await terminateProcess(zombie2).catch(() => {})
  }
})

test('daemon identity matcher recognizes marker/title across install paths', async () => {
  const { commandLooksLikeIm2ccDaemon } = await import(daemonProcessModulePath)
  const currentEntryPath = '/Users/example/current/dist/src/index.js'

  assert.equal(
    commandLooksLikeIm2ccDaemon({
      comm: 'node',
      command: 'node /tmp/other-checkout/dist/src/index.js im2cc-daemon',
    }, currentEntryPath),
    true,
  )

  assert.equal(
    commandLooksLikeIm2ccDaemon({
      comm: 'im2cc-daemon',
      command: 'node /tmp/other-checkout/dist/src/index.js',
    }, currentEntryPath),
    true,
  )

  assert.equal(
    commandLooksLikeIm2ccDaemon({
      comm: 'node',
      command: 'node /tmp/other-checkout/dist/src/index.js',
    }, currentEntryPath),
    false,
  )
})
