/**
 * @input:    ~/.claude/projects/{slug}/{sessionId}.jsonl — Claude Code 对话历史
 * @output:   buildRecap() — 从 session 文件提取最近几轮完整对话，用于 /fc 时的上下文回顾
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToSlug } from './discover.js'
import { log } from './logger.js'

interface Turn {
  user: string
  assistant: string
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

/** 构建 session JSONL 文件路径 */
function sessionFilePath(cwd: string, sessionId: string): string {
  return path.join(CLAUDE_PROJECTS_DIR, pathToSlug(cwd), `${sessionId}.jsonl`)
}

/** 从 JSONL 内容中提取所有对话轮次 */
function extractTurns(lines: string[]): Turn[] {
  const turns: Turn[] = []
  let currentUserText = ''
  let currentAssistantTexts: string[] = []

  for (const line of lines) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line)
    } catch { continue }

    if (obj.type !== 'user' && obj.type !== 'assistant') continue

    const msg = obj.message as Record<string, unknown> | undefined
    if (!msg) continue

    if (obj.type === 'user') {
      const content = msg.content
      // 真实用户输入：content 是 string
      // tool_result：content 是 array — 跳过
      if (typeof content !== 'string') continue

      // 跳过系统注入的 local-command 消息
      if (content.includes('<local-command-')) continue

      // 遇到新的用户消息，把之前积攒的轮次存下来
      if (currentUserText) {
        const assistantText = currentAssistantTexts.join('\n').trim()
        if (assistantText) {
          turns.push({ user: currentUserText, assistant: assistantText })
        }
      }
      currentUserText = content.trim()
      currentAssistantTexts = []
    }

    if (obj.type === 'assistant') {
      const content = msg.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null &&
              (block as Record<string, unknown>).type === 'text') {
            const text = (block as Record<string, string>).text
            if (text) currentAssistantTexts.push(text)
          }
        }
      } else if (typeof content === 'string' && content) {
        currentAssistantTexts.push(content)
      }
    }
  }

  // 最后一轮
  if (currentUserText) {
    const assistantText = currentAssistantTexts.join('\n').trim()
    if (assistantText) {
      turns.push({ user: currentUserText, assistant: assistantText })
    }
  }

  return turns
}

/** 根据字符预算从末尾选取完整轮次 */
function selectTurns(turns: Turn[], budget: number): Turn[] {
  if (turns.length === 0) return []

  const turnCost = (t: Turn) => t.user.length + t.assistant.length
  const selected: Turn[] = []
  let spent = 0

  // 从最后一轮往前累加
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = turnCost(turns[i])
    if (selected.length === 0) {
      // 至少保留最后一轮
      selected.unshift(turns[i])
      spent = cost
    } else if (spent + cost <= budget) {
      selected.unshift(turns[i])
      spent += cost
    } else {
      break
    }
  }

  return selected
}

/** 格式化轮次为飞书消息文本 */
function formatRecap(turns: Turn[], budget: number): string {
  const parts: string[] = ['📋 最近对话回顾:']

  for (const turn of turns) {
    parts.push('---')
    parts.push(`👤 ${turn.user}`)

    let assistantText = turn.assistant
    // 如果只有一轮且超预算，截断 assistant 尾部
    if (turns.length === 1 && turn.user.length + assistantText.length > budget) {
      const maxLen = Math.max(budget - turn.user.length - 50, 200) // 留余量给格式文字
      assistantText = assistantText.slice(0, maxLen) + '\n…(已截断)'
    }
    parts.push(`🤖 ${assistantText}`)
  }

  return parts.join('\n')
}

/**
 * 构建上下文回顾消息。
 * 返回格式化的文本，如果无可用内容则返回 null。
 */
export function buildRecap(
  sessionId: string,
  cwd: string,
  budget: number,
): string | null {
  if (budget <= 0) return null

  const filePath = sessionFilePath(cwd, sessionId)
  if (!fs.existsSync(filePath)) {
    log(`[recap] session 文件不存在: ${filePath}`)
    return null
  }

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    log(`[recap] 读取失败: ${err}`)
    return null
  }

  const lines = content.split('\n')
  const turns = extractTurns(lines)

  if (turns.length === 0) return null

  // 过滤掉 init 消息（im2cc 创建 session 时的"会话已建立"）
  const meaningful = turns.filter(t =>
    !t.user.includes('会话已建立') && !t.user.includes('请回复')
  )
  if (meaningful.length === 0) return null

  const selected = selectTurns(meaningful, budget)
  if (selected.length === 0) return null

  return formatRecap(selected, budget)
}
