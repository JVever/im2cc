/**
 * @input:    无（纯工具模块）
 * @output:   filterInitTurns() — 过滤 im2cc init 消息的通用工具函数，供各 driver 的 buildRecap 使用
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import type { RecapTurn } from './base-driver.js'

/**
 * 过滤掉 im2cc 创建 session 时的 init 消息（"会话已建立"等）。
 * 各 driver 的 buildRecap 在解析完 turns 后统一调用。
 */
export function filterInitTurns(turns: RecapTurn[]): RecapTurn[] {
  return turns.filter(t =>
    !t.user.includes('会话已建立') && !t.user.includes('请回复')
  )
}
