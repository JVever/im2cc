import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
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

function testEnv(homeDir) {
  const env = { ...process.env, HOME: homeDir }
  delete env.NODE_USE_ENV_PROXY
  delete env.NODE_OPTIONS
  delete env.HTTP_PROXY
  delete env.HTTPS_PROXY
  delete env.http_proxy
  delete env.https_proxy
  delete env.ALL_PROXY
  delete env.all_proxy
  delete env.NO_PROXY
  delete env.no_proxy
  return env
}

function runCli(homeDir, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env: testEnv(homeDir),
    encoding: 'utf-8',
  })
}

function writeWeChatAccount(homeDir, baseUrl) {
  fs.writeFileSync(path.join(homeDir, '.im2cc', 'wechat-account.json'), JSON.stringify({
    botToken: 'test-token',
    baseUrl,
    ilinkBotId: 'bot-id',
    ilinkUserId: 'user-id',
    savedAt: new Date().toISOString(),
    lastOkAt: '',
    syncBuf: '',
  }, null, 2))
}

async function startWechatStubServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/ilink/bot/getupdates') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ get_updates_buf: 'cursor-1', msgs: [] }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('failed to bind stub server')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
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

async function waitForAlive(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      assertAlive(pid)
      return
    } catch (err) {
      if (err?.code !== 'ESRCH') throw err
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  assertAlive(pid)
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

  try {
    // 等待进程启动并设置 title
    await waitForAlive(zombie1.pid)
    await waitForAlive(zombie2.pid)

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

test('start launches daemon without false IPC disconnect failure', async () => {
  const homeDir = createHomeDir()
  const wechatStub = await startWechatStubServer()
  writeWeChatAccount(homeDir, wechatStub.baseUrl)

  try {
    const start = runCli(homeDir, ['start'])
    assert.equal(start.status, 0, start.stderr)
    assert.match(start.stdout, /守护进程已启动/)
    assert.doesNotMatch(`${start.stdout}\n${start.stderr}`, /ERR_IPC_DISCONNECTED|IPC channel is already disconnected/)

    const status = runCli(homeDir, ['status'])
    assert.equal(status.status, 0, status.stderr)
    assert.match(status.stdout, /守护进程运行中/)

    const stop = runCli(homeDir, ['stop'])
    assert.equal(stop.status, 0, stop.stderr)
    assert.match(stop.stdout, /已停止守护进程/)
  } finally {
    runCli(homeDir, ['stop'])
    await wechatStub.close()
  }
})
