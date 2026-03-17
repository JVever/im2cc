# im2cc

> IM to Claude Code — 通过飞书远程控制本地 Claude Code，电脑/手机无缝流转

## 项目状态
- **阶段**: MVP 已完成，端到端测试通过
- **版本**: 0.1.0
- **创建日期**: 2026-03-16

## 它是什么

一个轻量级桥接工具：在飞书群聊中远程操控本地电脑上的 Claude Code，回到电脑后无缝接续同一个对话。

**核心特性**：
- 电脑和飞书之间自由流转对话，上下文完全一致
- 同一个对话永远只在一个地方活跃（独占访问）
- 统一的命令系统（fn/fc/fl/fk/fd/fs），电脑和飞书完全一致
- 飞书发送文件/图片，自动暂存到项目 inbox，与下一条指令合并发送给 Claude

## 快速开始

### 安装

```bash
cd ~/Code/im2cc && npm install && npm run build && npm link
source ~/.local/bin/im2cc-shell-functions.zsh
```

### 配置飞书 Bot

```bash
im2cc setup    # 输入飞书 App ID 和 Secret
im2cc start    # 启动守护进程
```

### 日常使用

```bash
# 电脑上创建对话
fn myproject ~/Code/my-project

# 离开电脑后，在飞书群里接入
/fc myproject

# 回到电脑，接回对话
fc myproject

# 查看所有对话
fl

# 终止对话
fk myproject
```

## 命令速查

电脑终端和飞书群聊使用完全相同的命令：

| 命令 | 作用 | 电脑示例 | 飞书示例 |
|------|------|---------|---------|
| **fn** | 创建新对话 | `fn auth im2cc` | `/fn auth im2cc` |
| **fc** | 接入已有对话 | `fc auth` | `/fc auth` |
| **fl** | 列出所有对话 | `fl` | `/fl` |
| **fk** | 终止对话 | `fk auth` | `/fk auth` |
| **fd** | 断开当前对话 | `fd`（tmux detach） | `/fd` |
| **fs** | 查看状态 | `fs auth` | `/fs` |

飞书专用命令：

| 命令 | 作用 |
|------|------|
| `/mode <YOLO\|default\|auto-edit>` | 切换权限模式 |
| `/stop` | 中断正在执行的任务 |
| `/help` | 显示帮助 |

## 工作原理

```
┌──────────┐   REST 轮询    ┌──────────────┐    spawn     ┌─────────────┐
│ 飞书群聊  │ ◄────────────► │ im2cc 守护进程 │ ──────────► │ Claude Code  │
│ (手机/PC) │                │ (本地运行)     │             │ CLI          │
└──────────┘                └──────────────┘             └─────────────┘
                                    │
                                    ▼
                             ~/.im2cc/data/
                             ├── registry.json      (命名对话注册表)
                             ├── bindings.json      (飞书群↔session 绑定)
                             └── poll-cursors.json  (轮询游标)
```

**关键设计**：不使用 Agent SDK，直接调用 `claude -p --resume <session-id>`。
这意味着飞书和电脑操作的是同一个 Claude Code session 文件，上下文天然一致。

**独占访问**：
- 飞书 `/fc` 时 → 自动关闭电脑端的 tmux 会话
- 电脑 `fc` 时 → 自动解绑飞书端并通知群
- Daemon 守卫：每条消息处理前检查本地 tmux 是否活跃

## 技术栈

| 组件 | 选择 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Node.js >= 20 |
| 飞书连接 | @larksuiteoapi/node-sdk (REST 轮询) |
| CLI 调用 | child_process.spawn |
| 本地会话 | tmux |
| 存储 | JSON 文件 (原子写) |
| 守护进程 | macOS LaunchAgent |

## 目录结构

```
im2cc/
├── src/
│   ├── index.ts           # 主入口：飞书连接 + 消息路由 + 独占检查
│   ├── config.ts          # 配置加载 (~/.im2cc/config.json)
│   ├── security.ts        # 用户白名单 + 路径验证
│   ├── registry.ts        # 命名 session 注册表（永久寻址）
│   ├── session.ts         # 飞书群↔session 绑定 CRUD
│   ├── discover.ts        # 本地 Claude Code 对话发现（文件系统扫描）
│   ├── claude-driver.ts   # Claude Code CLI 驱动（spawn/resume/interrupt）
│   ├── queue.ts           # 消息队列 + Job 管理（串行/超时/中断）
│   ├── commands.ts        # 统一命令系统（fn/fc/fl/fk/fd/fs）
│   ├── output.ts          # CLI 输出 → 飞书消息格式化
│   ├── feishu.ts          # 飞书 REST 轮询适配器
│   ├── poll-cursor.ts     # 轮询游标持久化
│   ├── file-staging.ts    # 文件暂存管理（inbox/校验/TTL清理）
│   └── logger.ts          # 日志 + 轮转
├── bin/
│   └── im2cc.ts           # Node.js CLI (start/stop/setup/doctor/...)
├── shell/
│   └── im2cc-shell-functions.zsh  # Shell 命令 (fn/fc/fl/fk/fd/fs)
├── PROJECT.md
├── DEVLOG.md
├── TASKS.md
├── package.json
└── tsconfig.json
```

## 关键设计决策

1. **CLI spawn 而非 Agent SDK** — 复用 CLI 原生 session，两端共享同一个对话文件
2. **命名注册表** — `fn` 创建时注册名称，`fc` 通过名称永久寻址，不受时间限制
3. **tmux 管理** — 本地对话在 tmux 中运行，可靠地控制生命周期和独占切换
4. **独占访问** — 同一 session 永远只在一个地方活跃，daemon 端有防线兜底
5. **YOLO 模式** — 默认 `--dangerously-skip-permissions`，远程操控无需确认
6. **stream-json + --verbose** — 获取完整的流式事件输出

## 飞书 App 配置要求

| 权限 | 用途 |
|------|------|
| im:message | 获取与发送消息 |
| im:message:send_as_bot | 以 Bot 身份发消息 |
| im:message.group_msg:readonly | 读取群内所有消息（REST 轮询） |
| im:message.group_at_msg:readonly | 读取 @Bot 消息 |
| im:chat:readonly | 获取 Bot 所在的群列表（轮询发现） |
| im:resource | 下载消息中的文件/图片资源 |

消息获取方式：REST 轮询（`im.message.list` + `im.chat.list`），不依赖 WebSocket 事件订阅
