/**
 * @input:    Im2ccConfig, 飞书 WebSocket 事件, Claude Code CLI, recap (session JSONL)
 * @output:   startDaemon() — 主入口：初始化各模块、启动飞书连接、消息路由、/fc 上下文回顾
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { loadConfig, getPidFile } from './config.js'
import { isUserAllowed } from './security.js'
import { isDuplicate, listActiveBindings, getBinding, archiveBinding } from './session.js'
import { parseCommand, handleCommand } from './commands.js'
import { enqueue, recoverOnStartup } from './queue.js'
import { startFeishu, sendTextMessage, type IncomingMessage } from './feishu.js'
import { listRegistered, lookup } from './registry.js'
import { buildRecap } from './recap.js'
import { log, error } from './logger.js'

/** 检查某个 session 是否正在被本地 tmux 使用 */
function isSessionLocallyActive(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t "im2cc-${sessionName}" 2>/dev/null`)
    return true
  } catch { return false }
}

/** 单实例保护：确保只有一个守护进程在运行 */
function acquireLock(): boolean {
  const pidFile = getPidFile()

  if (fs.existsSync(pidFile)) {
    const existingPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim())
    if (!isNaN(existingPid)) {
      try {
        process.kill(existingPid, 0) // 检查进程是否存活
        error(`另一个 im2cc 守护进程已在运行 (PID: ${existingPid})，本次启动终止`)
        return false
      } catch {
        log(`清理过期 PID 文件 (旧 PID: ${existingPid})`)
      }
    }
  }

  // 写入自己的 PID
  fs.writeFileSync(pidFile, String(process.pid))

  // 退出时清理 PID 文件
  const cleanup = () => {
    try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile) } catch {}
  }
  process.on('exit', cleanup)
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
  process.on('SIGINT', () => { cleanup(); process.exit(0) })

  return true
}

export async function startDaemon(): Promise<void> {
  if (!acquireLock()) {
    process.exit(1)
  }

  log('im2cc 启动中...')

  const config = loadConfig()

  // 启动通知（崩溃恢复）
  const activeBindings = listActiveBindings()
  if (activeBindings.length > 0) {
    log(`发现 ${activeBindings.length} 个活跃绑定，发送重启通知`)
  }

  // 消息处理
  async function handleMessage(msg: IncomingMessage): Promise<void> {
    const { messageId, chatId, senderId, text } = msg

    // 消息去重
    if (isDuplicate(messageId)) return

    // 用户白名单
    if (!isUserAllowed(senderId, config)) {
      log(`拒绝未授权用户: ${senderId}`)
      return
    }

    log(`收到消息 [${chatId}] ${senderId}: ${text.slice(0, 80)}`)

    // 命令解析
    const cmd = parseCommand(text)

    if (cmd) {
      // 控制面命令：直接处理，不入队列
      try {
        const reply = await handleCommand(cmd, chatId, config)
        await sendTextMessage(chatId, reply)

        // /fc 成功接入后，自动发送上下文回顾
        if (cmd.command === 'fc' && cmd.args && config.recapBudget > 0) {
          const binding = getBinding(chatId)
          if (binding) {
            try {
              const recap = buildRecap(binding.sessionId, binding.cwd, config.recapBudget)
              if (recap) await sendTextMessage(chatId, recap)
            } catch (err) {
              log(`[recap] 生成失败: ${err}`)
            }
          }
        }
      } catch (err) {
        error(`命令执行失败 [${chatId}] /${cmd.command}: ${err}`)
        await sendTextMessage(chatId, `❌ 命令执行失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      // 普通消息：入队列发给 Claude
      const binding = getBinding(chatId)
      if (!binding) {
        const registered = listRegistered()
        const lines = ['当前未接入任何对话。']
        if (registered.length > 0) {
          lines.push('', '📋 可用对话:')
          for (const s of registered.slice(0, 5)) {
            lines.push(`  ${s.name} (${path.basename(s.cwd)})`)
          }
        }
        lines.push('', '发 /fc <名称> 接入，或 /fn <名称> 新建')
        await sendTextMessage(chatId, lines.join('\n'))
        return
      }

      // 独占检查：如果 session 正在电脑端 tmux 中使用，自动解绑飞书端
      const regEntry = listRegistered().find(r => r.sessionId === binding.sessionId)
      if (regEntry && isSessionLocallyActive(regEntry.name)) {
        archiveBinding(chatId)
        log(`[${chatId}] 检测到 "${regEntry.name}" 在电脑端活跃，自动解绑飞书`)
        await sendTextMessage(chatId,
          `⚠️ "${regEntry.name}" 正在电脑端使用，已自动断开飞书端。\n\n等电脑端关闭后，发 /fc ${regEntry.name} 重新接入。`)
        return
      }

      enqueue(
        chatId,
        text,
        (reply) => sendTextMessage(chatId, reply),
        config.defaultTimeoutSeconds,
      )
    }
  }

  // 启动飞书连接
  await startFeishu(config, handleMessage)

  // 恢复上次中断的任务和排队消息
  await recoverOnStartup(
    (groupId, text) => sendTextMessage(groupId, text),
    (groupId) => (text: string) => sendTextMessage(groupId, text),
    config.defaultTimeoutSeconds,
  )

  // 发送重启通知
  for (const binding of activeBindings) {
    try {
      await sendTextMessage(binding.feishuGroupId,
        `🔄 im2cc 已重启\n📁 ${binding.cwd}\n🔑 Session: ${binding.sessionId}\n⚙️ 模式: ${binding.permissionMode}`)
    } catch {
      // 群可能已被删除，忽略
    }
  }

  log(`im2cc 已启动，${activeBindings.length} 个活跃绑定`)
}

// 被 fork() 或 node 直接执行时，自动启动 daemon
const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] === __filename) {
  startDaemon().catch(e => {
    error(`startDaemon 失败: ${e}`)
    process.exit(1)
  })
}
