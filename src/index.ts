/**
 * @input:    Im2ccConfig, 飞书 WebSocket 事件, Claude Code CLI
 * @output:   startDaemon() — 主入口：初始化各模块、启动飞书连接、消息路由
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import path from 'node:path'
import { loadConfig } from './config.js'
import { isUserAllowed } from './security.js'
import { isDuplicate, listActiveBindings, getBinding } from './session.js'
import { parseCommand, handleCommand } from './commands.js'
import { enqueue } from './queue.js'
import { startFeishu, sendTextMessage, type IncomingMessage } from './feishu.js'
import { listRegistered } from './registry.js'
import { log, error } from './logger.js'

export async function startDaemon(): Promise<void> {
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
        lines.push('', '发 /fc <名称> 接入已有对话，或 /fn <名称> 新建')
        await sendTextMessage(chatId, lines.join('\n'))
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
