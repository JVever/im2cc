/**
 * @input:    ~/.im2cc/daemon.pid, ~/.im2cc/daemon.lock/, pgrep/ps 系统命令
 * @output:   守护进程识别（listDaemonProcessPids, isIm2ccDaemonProcess）、清理（killAllDaemonProcesses）、PID/锁元数据读写
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getPidFile, getDaemonLockDir } from './config.js'

export const DAEMON_MARKER = 'im2cc-daemon'
export const DAEMON_PROCESS_TITLE = 'im2cc-daemon'
export const DAEMON_LOCK_STARTUP_GRACE_MS = 30_000

const LEGACY_DAEMON_ENTRY_SHORT_PATH = 'im2cc/dist/src/index.js'

export interface DaemonPidRecord {
  pid: number | null
  present: boolean
}

export interface DaemonProcessIdentity {
  command: string | null
  comm: string | null
}

export function daemonMainModulePath(): string {
  return path.resolve(import.meta.dirname, 'index.js')
}

export function daemonLockMetaFile(): string {
  return path.join(getDaemonLockDir(), 'owner.json')
}

function normalizeProcessCommand(command: string): string {
  return command.replace(/\\/g, '/')
}

function parsePositivePid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function listPidsFromPgrep(args: string[]): number[] {
  try {
    const output = execFileSync('pgrep', args, { encoding: 'utf-8' }).trim()
    if (!output) return []

    return output
      .split('\n')
      .map(line => parseInt(line.trim(), 10))
      .filter(pid => Number.isInteger(pid) && pid > 0)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException & { status?: number }).status
    if (code === 1 || (err as NodeJS.ErrnoException).code === 'ENOENT') return []
    return []
  }
}

function readProcessPsField(pid: number, field: 'command=' | 'comm='): string | null {
  if (inspectProcess(pid) !== 'running') return null

  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', field], { encoding: 'utf-8' }).trim()
    return output || null
  } catch {
    return null
  }
}

export function inspectProcess(pid: number): 'running' | 'missing' {
  if (!Number.isInteger(pid) || pid <= 0) return 'missing'

  try {
    process.kill(pid, 0)
    return 'running'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ESRCH' ? 'missing' : 'running'
  }
}

export function isIm2ccDaemonProcess(pid: number, entryPath: string = daemonMainModulePath()): boolean {
  if (inspectProcess(pid) !== 'running') return false

  const comm = readProcessPsField(pid, 'comm=')
  const command = readProcessPsField(pid, 'command=')
  return commandLooksLikeIm2ccDaemon({ command, comm }, entryPath)
}

export function commandLooksLikeIm2ccDaemon(identity: DaemonProcessIdentity, entryPath: string = daemonMainModulePath()): boolean {
  if (identity.comm === DAEMON_PROCESS_TITLE) return true
  if (!identity.command) return false

  const normalizedCommand = normalizeProcessCommand(identity.command)
  const normalizedEntryPath = normalizeProcessCommand(entryPath)

  return normalizedCommand.includes(DAEMON_MARKER)
    || normalizedCommand.includes(normalizedEntryPath)
    || normalizedCommand.includes(LEGACY_DAEMON_ENTRY_SHORT_PATH)
}

export function listDaemonProcessPids(entryPath: string = daemonMainModulePath(), excludePid: number = process.pid): number[] {
  const candidates = new Set<number>()
  const queries: Array<{ args: string[] }> = [
    { args: ['-x', DAEMON_PROCESS_TITLE] },
    { args: ['-f', DAEMON_MARKER] },
    { args: ['-f', entryPath] },
    { args: ['-f', LEGACY_DAEMON_ENTRY_SHORT_PATH] },
  ]

  for (const query of queries) {
    for (const pid of listPidsFromPgrep(query.args)) {
      if (pid !== excludePid) candidates.add(pid)
    }
  }

  // 补充：从 PID 文件和 lock 元数据中读取已知 PID（防止 pgrep 遗漏）
  const recordedPid = readDaemonPidRecord().pid
  if (recordedPid !== null && recordedPid !== excludePid) {
    candidates.add(recordedPid)
  }

  return [...candidates].filter(pid => isIm2ccDaemonProcess(pid, entryPath))
}

/**
 * 杀死所有检测到的 im2cc 守护进程（除 excludePid 外）。
 * 先 SIGTERM，等待 gracePeriodMs 后仍存活的用 SIGKILL。
 * 返回被杀死的 PID 列表。
 */
export function killAllDaemonProcesses(
  entryPath: string = daemonMainModulePath(),
  excludePid: number = process.pid,
  gracePeriodMs: number = 3000,
): number[] {
  const pids = listDaemonProcessPids(entryPath, excludePid)
  if (pids.length === 0) return []

  // Phase 1: SIGTERM
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }

  // Phase 2: wait and verify
  const deadline = Date.now() + gracePeriodMs
  const survivors: number[] = []
  while (Date.now() < deadline) {
    survivors.length = 0
    for (const pid of pids) {
      if (inspectProcess(pid) === 'running') survivors.push(pid)
    }
    if (survivors.length === 0) break
    // busy-wait with short sleep (synchronous, acceptable during startup)
    try { execFileSync('sleep', ['0.2'], { stdio: 'ignore' }) } catch {}
  }

  // Phase 3: SIGKILL for survivors
  for (const pid of survivors) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }

  return pids
}

export function readDaemonPidRecord(): DaemonPidRecord {
  let present = false

  const lockMetaFile = daemonLockMetaFile()
  if (fs.existsSync(lockMetaFile)) {
    present = true
    try {
      const raw = JSON.parse(fs.readFileSync(lockMetaFile, 'utf-8')) as Record<string, unknown>
      const pid = parsePositivePid(raw.pid)
      if (pid !== null) return { pid, present: true }
    } catch {}
  }

  const pidFile = getPidFile()
  if (fs.existsSync(pidFile)) {
    present = true
    const parsed = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
    if (Number.isInteger(parsed) && parsed > 0) {
      return { pid: parsed, present: true }
    }
  }

  return { pid: null, present }
}

export function prepareDaemonProcessIdentity(): void {
  try {
    process.title = DAEMON_PROCESS_TITLE
  } catch {}
}

export function isDaemonEntrypointInvocation(argv: string[], entryPath: string = daemonMainModulePath()): boolean {
  return argv[1] === entryPath || argv.includes(DAEMON_MARKER)
}
