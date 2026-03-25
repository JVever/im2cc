/**
 * @input:    ~/.claude/projects/ 下的 session JSONL 文件
 * @output:   discoverSessions(), pathToSlug(), syncDriftedSession() — 扫描本地对话 + 路径转 slug + 断开前漂移同步
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { log } from './logger.js'

export interface DiscoveredSession {
  sessionId: string
  name: string          // custom-title, 无则用首条消息摘要
  projectPath: string   // 还原的绝对路径
  projectName: string   // 目录名
  lastModified: Date
  firstMessage: string  // 首条用户消息截断
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

/** 从 project slug 还原项目绝对路径 */
function slugToPath(slug: string): string | null {
  // slug 格式: -Users-jvever-Code-16-------
  // 策略: 构建正向映射表 (绝对路径 → slug)，然后反查

  // slug 的生成规则：绝对路径中 / 替换为 -，非 ASCII 字符替换为 -
  // 反推：遍历文件系统，对每个目录计算 slug，匹配

  const home = os.homedir()

  // 快速尝试：如果 slug 全是 ASCII 可直接还原
  const directPath = '/' + slug.slice(1).replace(/-/g, '/')
  if (fs.existsSync(directPath)) return directPath

  // 否则：从 home 目录向下搜索匹配
  return findMatchingPath(home, slug)
}

export function pathToSlug(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-')
}

function findMatchingPath(basePath: string, targetSlug: string): string | null {
  // 递归搜索，但限制深度避免太慢
  const baseSlug = pathToSlug(basePath)
  if (baseSlug === targetSlug) return basePath

  // 如果 targetSlug 不以 baseSlug 开头（去掉末尾），不在这个树下
  if (!targetSlug.startsWith(baseSlug)) return null

  try {
    const entries = fs.readdirSync(basePath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const childPath = path.join(basePath, entry.name)
      const childSlug = pathToSlug(childPath)

      if (childSlug === targetSlug) return childPath
      // 如果 target 可能在更深层，继续搜索
      if (targetSlug.startsWith(childSlug)) {
        const result = findMatchingPath(childPath, targetSlug)
        if (result) return result
      }
    }
  } catch { /* 权限不足等 */ }

  return null
}

/** 从 JSONL 头尾提取 session 元信息 */
async function parseSessionMeta(
  filePath: string,
): Promise<{ name: string; firstMessage: string }> {
  let name = ''
  let firstMessage = ''

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  let lineCount = 0
  const MAX_LINES = 100 // 头部读 100 行找 title 和首条消息

  for await (const line of rl) {
    lineCount++
    if (lineCount > MAX_LINES && firstMessage) break

    try {
      const obj = JSON.parse(line) as Record<string, unknown>

      // 找 custom-title（可能在任何位置，但先读 100 行）
      if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
        name = obj.customTitle
      }
      if (obj.type === 'agent-name' && typeof obj.agentName === 'string') {
        name = obj.agentName
      }

      // 找首条真实 user 消息（跳过 meta/系统消息）
      if (!firstMessage && obj.type === 'user' && !obj.isMeta) {
        const msg = obj.message as Record<string, unknown> | undefined
        if (msg) {
          const content = msg.content
          if (typeof content === 'string' && !content.startsWith('<')) {
            firstMessage = content.slice(0, 80)
          } else if (Array.isArray(content)) {
            for (const c of content) {
              if (typeof c === 'object' && c && (c as Record<string, unknown>).type === 'text') {
                firstMessage = ((c as Record<string, string>).text ?? '').slice(0, 80)
                break
              }
            }
          }
        }
      }
    } catch { /* 忽略解析错误（含残行） */ }
  }

  rl.close()
  stream.destroy()

  // 如果头部没找到 name，快速扫描全文件只找 title 行
  // custom-title/agent-name 包含特征字符串，可以用字符串搜索快速跳过无关行
  if (!name) {
    name = await scanForName(filePath)
  }

  return { name, firstMessage }
}

/** 快速扫描文件找最后一个 custom-title 或 agent-name */
async function scanForName(filePath: string): Promise<string> {
  let lastName = ''
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    // 只处理包含 custom-title 或 agent-name 的行
    const lines = content.split('\n')
    for (const line of lines) {
      if (line.includes('"custom-title"') || line.includes('"agent-name"')) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>
          if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') lastName = obj.customTitle
          if (obj.type === 'agent-name' && typeof obj.agentName === 'string') lastName = obj.agentName
        } catch { /* 忽略 */ }
      }
    }
  } catch { /* 读取失败 */ }
  return lastName
}

/** 发现本地所有 Claude Code 对话，按最近修改时间排序 */
export async function discoverSessions(limit: number = 15): Promise<DiscoveredSession[]> {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return []

  // 第一阶段：stat 所有 session 文件，按 mtime 排序
  interface FileEntry { filePath: string; slug: string; sessionId: string; mtime: Date }
  const allFiles: FileEntry[] = []

  const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, dir.name)
    try {
      const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))
      for (const file of files) {
        const filePath = path.join(projectDir, file)
        const stat = fs.statSync(filePath)
        allFiles.push({
          filePath,
          slug: dir.name,
          sessionId: file.replace('.jsonl', ''),
          mtime: stat.mtime,
        })
      }
    } catch { /* 权限 */ }
  }

  // 按 mtime 倒序，取 top-K
  allFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
  const topFiles = allFiles.slice(0, limit)

  // 第二阶段：解析 top-K 的元信息
  const sessions: DiscoveredSession[] = []

  for (const entry of topFiles) {
    const projectPath = slugToPath(entry.slug)
    if (!projectPath) continue // 无法还原路径，跳过

    const meta = await parseSessionMeta(entry.filePath)

    sessions.push({
      sessionId: entry.sessionId,
      name: meta.name || meta.firstMessage || '未命名对话',
      projectPath,
      projectName: path.basename(projectPath),
      lastModified: entry.mtime,
      firstMessage: meta.firstMessage,
    })
  }

  return sessions
}

/** 按名称模糊匹配 session */
export async function findSession(
  query: string,
  limit: number = 15,
): Promise<DiscoveredSession[]> {
  const all = await discoverSessions(limit)
  const q = query.toLowerCase()

  // 精确匹配 session ID 前缀（至少 6 位）
  if (/^[0-9a-f-]{6,}$/i.test(query)) {
    const exact = all.filter(s => s.sessionId.startsWith(q))
    if (exact.length > 0) return exact
  }

  // 名称模糊匹配
  return all.filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.projectName.toLowerCase().includes(q)
  )
}

/**
 * 断开前同步：检查 tmux 中实际运行的 session 是否与 registry 一致。
 * 如果发现漂移（Plan 模式等），自动更新 registry 并返回新 sessionId。
 * 返回 null 表示无漂移或无法确定归属。
 */
export function syncDriftedSession(
  name: string,
  registeredSessionId: string,
  cwd: string,
  activeNames: { name: string; sessionId: string; cwd: string; tool?: string }[],
): string | null {
  const slug = pathToSlug(cwd)
  const slugDir = path.join(os.homedir(), '.claude', 'projects', slug)

  if (!fs.existsSync(slugDir)) return null

  // 扫描 slug 目录下的 .jsonl 文件，按 mtime 排序
  let files: { sessionId: string; mtime: number }[]
  try {
    files = fs.readdirSync(slugDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const stat = fs.statSync(path.join(slugDir, f))
        return { sessionId: f.replace('.jsonl', ''), mtime: stat.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch { return null }

  if (files.length === 0) return null

  const newest = files[0]

  // 没有漂移
  if (newest.sessionId === registeredSessionId) return null

  // 检查最新文件是否有 im2cc:<name> 标题（强归属信号）
  const newestPath = path.join(slugDir, `${newest.sessionId}.jsonl`)
  const titleMatch = checkSessionTitle(newestPath, name)

  if (titleMatch) {
    log(`[sync-drift] strong match: ${name} ${registeredSessionId.slice(0, 8)} → ${newest.sessionId.slice(0, 8)} (title im2cc:${name})`)
    return newest.sessionId
  }

  // 无标题匹配——检查此项目是否只有一个活跃的 claude name
  const sameProjectClaudeNames = activeNames.filter(
    n => n.cwd === cwd && (n.tool ?? 'claude') === 'claude'
  )

  if (sameProjectClaudeNames.length === 1) {
    // 同项目只有一个 claude name，安全地自动更新
    log(`[sync-drift] single-name match: ${name} ${registeredSessionId.slice(0, 8)} → ${newest.sessionId.slice(0, 8)} (only claude name in project)`)
    return newest.sessionId
  }

  // 多 name 且无标题匹配——不自动更新，记录日志
  log(`[sync-drift] ambiguous: ${name} has ${sameProjectClaudeNames.length} claude names in same project, newest=${newest.sessionId.slice(0, 8)}, skipping auto-sync`)
  return null
}

/** 检查 session 文件头部是否包含 im2cc:<name> 标题 */
function checkSessionTitle(filePath: string, name: string): boolean {
  try {
    // 只读头部（前 50KB 足以覆盖 title 行）
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(50 * 1024)
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const head = buf.toString('utf-8', 0, bytesRead)
    const target = `im2cc:${name}`
    return head.includes(`"customTitle":"${target}"`) || head.includes(`"agentName":"${target}"`)
  } catch { return false }
}
