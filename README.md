# im2cc

> IM to Claude Code — 通过飞书/微信远程操控本地 Claude Code，电脑/手机无缝流转

在手机上通过飞书群聊或微信 ClawBot 远程操控电脑上的 Claude Code CLI，回到电脑后无缝接续同一个对话。

## 核心特性

- **多通道支持**：飞书群聊 + 微信 ClawBot，可同时连接
- **无缝流转**：电脑和手机之间自由切换，上下文完全一致
- **独占访问**：同一对话永远只在一个地方活跃（飞书/微信/电脑互斥）
- **统一命令**：fn/fc/fl/fk/fd/fs，终端和 IM 完全一致
- **文件传输**：飞书发送文件/图片，自动暂存到项目 inbox（微信暂不支持）

## 工作原理

```
┌──────────┐                    ┌──────────────┐    spawn     ┌─────────────┐
│ 飞书群聊  │◄── REST 轮询 ──────►│              │ ──────────► │             │
│          │                    │ im2cc 守护进程 │             │ Claude Code │
│ 微信     │◄── iLink 长轮询 ──►│  (本地运行)    │             │ CLI         │
│ ClawBot  │                    │              │             │             │
└──────────┘                    └──────────────┘             └─────────────┘
```

不使用 Agent SDK，直接调用 `claude -p --resume <session-id>`。飞书/微信和电脑操作的是同一个 Claude Code session 文件，上下文天然一致。

## 前置要求

- **Node.js** >= 20
- **tmux**（本地会话管理）
- **Claude Code CLI**（`claude` 命令可用）
- 飞书自建应用（配置 Bot）和/或 微信 ClawBot 权限

## 快速开始

### 安装

```bash
git clone <本仓库地址>
cd im2cc
npm install
npm run build
npm link
```

### 加载终端命令

将以下行添加到 `~/.zshrc`：

```bash
source /path/to/im2cc/shell/im2cc-shell-functions.zsh
```

重新打开终端或 `source ~/.zshrc` 使其生效。这会注册 `fn`/`fc`/`fl`/`fk`/`fd`/`fs` 命令。

### 配置飞书 Bot

```bash
im2cc setup    # 输入飞书 App ID 和 App Secret
im2cc start    # 启动守护进程
```

飞书 App 需要以下权限：

| 权限 | 用途 |
|------|------|
| `im:message` | 获取与发送消息 |
| `im:message:send_as_bot` | 以 Bot 身份发消息 |
| `im:message.group_msg:readonly` | 读取群消息（REST 轮询） |
| `im:message.group_at_msg:readonly` | 读取 @Bot 消息 |
| `im:chat:readonly` | 获取 Bot 所在的群列表 |
| `im:resource` | 下载消息中的文件/图片 |

消息获取方式：REST 轮询（`im.message.list` + `im.chat.list`），不依赖 WebSocket。

### 配置微信 ClawBot（可选）

```bash
im2cc wechat login    # 终端显示 QR 码，用微信扫码绑定
im2cc stop && im2cc start  # 重启守护进程使微信生效
```

要求：微信 iOS 8.0.70+，已开启 ClawBot 插件（设置 → 插件）。

> **微信当前限制**：仅支持文本消息（不支持文件/图片）；无主动推送（长任务结果在下次发消息时补推）；1:1 对话（无群聊）。

### 配置 Session 漂移同步（推荐）

Claude Code 的 Plan 模式会静默创建新 session，导致 registry 中的 session ID 过期。添加 SessionStart hook 自动同步：

在 `~/.claude/settings.json` 中添加：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "/path/to/im2cc/shell/im2cc-session-sync.sh"
      }
    ]
  }
}
```

### 日常使用

```bash
# 电脑上创建对话
fn myproject ~/Code/my-project

# 离开电脑后，在飞书群/微信中接入
/fc myproject

# 回到电脑，接回对话
fc myproject
```

## 命令速查

电脑终端和 IM 使用完全相同的命令：

| 命令 | 作用 | 示例 |
|------|------|------|
| **fn** | 创建新对话 | `fn auth ~/Code/auth-service` |
| **fc** | 接入已有对话 | `fc auth` |
| **fc** | 注册并接入分叉对话 | `fc my-fork 2961` |
| **fl** | 列出所有对话 | `fl` |
| **fk** | 终止对话 | `fk auth` |
| **fd** | 断开当前对话 | `fd` |
| **fs** | 查看状态 | `fs auth` |

IM 专用命令：

| 命令 | 作用 |
|------|------|
| `/mode <YOLO\|default\|auto-edit>` | 切换权限模式 |
| `/stop` | 中断正在执行的任务 |
| `/help` | 显示帮助 |

## 安全说明

- **用户白名单**：默认允许所有人（`allowedUserIds: []`）。生产环境务必在 `~/.im2cc/config.json` 中配置白名单
- **权限模式**：默认 `YOLO`（自动执行所有操作）。可通过 `/mode default` 切换为需确认模式
- **路径白名单**：只允许操作 `pathWhitelist` 配置的目录（默认 `~/Code/`）
- **session 名称**：限制为字母、数字、连字符和下划线（防注入）
- **文件传输**：强制 `maxFileSizeMB` 限制（默认 10MB）

## 守护进程管理

```bash
im2cc start              # 启动
im2cc stop               # 停止
im2cc status             # 查看状态
im2cc logs               # 查看日志
im2cc doctor             # 环境检查
im2cc install-service    # 安装 macOS 开机自启
im2cc wechat login       # 绑定微信 ClawBot
im2cc wechat status      # 查看微信连接状态
im2cc wechat logout      # 解除微信绑定
```

## 技术栈

| 组件 | 选择 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Node.js >= 20 |
| 飞书连接 | @larksuiteoapi/node-sdk (REST 轮询) |
| 微信连接 | iLink Bot API (HTTP 长轮询) |
| CLI 调用 | child_process.spawn |
| 本地会话 | tmux |
| 存储 | JSON 文件（原子写） |
| 守护进程 | macOS LaunchAgent |

## 目录结构

```
im2cc/
├── src/
│   ├── index.ts           # 主入口：多 transport 消息路由
│   ├── transport.ts       # Transport 抽象接口
│   ├── feishu.ts          # 飞书 REST 轮询适配器
│   ├── wechat.ts          # 微信 iLink 长轮询适配器
│   ├── config.ts          # 配置加载（飞书凭证 + 微信账号）
│   ├── security.ts        # 用户白名单 + 路径验证 + 名称校验
│   ├── registry.ts        # 命名 session 注册表（唯一性约束）
│   ├── session.ts         # IM ↔ session 绑定（多 transport）
│   ├── claude-driver.ts   # Claude Code CLI 驱动 + session 文件三态检查
│   ├── commands.ts        # 统一命令系统（fn/fc/fl/fk/fd/fs/mode/stop）
│   ├── queue.ts           # 消息队列 + Job 管理（超时/中断/恢复）
│   ├── output.ts          # CLI 输出格式化（transport 感知长度限制）
│   ├── discover.ts        # 本地 Claude Code 对话发现
│   ├── recap.ts           # /fc 时的上下文回顾
│   ├── file-staging.ts    # 文件暂存管理（inbox/校验/TTL 清理）
│   ├── poll-cursor.ts     # 轮询游标持久化
│   └── logger.ts          # 日志 + 轮转
├── bin/
│   └── im2cc.ts           # CLI (start/stop/setup/wechat/...)
├── shell/
│   ├── im2cc-shell-functions.zsh  # 终端命令 (fn/fc/fl/fk/fd/fs)
│   └── im2cc-session-sync.sh     # SessionStart hook（session 漂移同步）
└── package.json
```

## 数据存储

所有数据存储在 `~/.im2cc/` 下：

| 文件 | 用途 |
|------|------|
| `config.json` | 飞书凭证、白名单、默认参数 |
| `wechat-account.json` | 微信 bot token（0600 权限） |
| `data/registry.json` | 命名 session 注册表 |
| `data/bindings.json` | IM ↔ session 绑定 |
| `data/poll-cursors.json` | 轮询游标 |
| `logs/daemon.log` | 守护进程日志（10MB 轮转） |

## 许可证

[GPLv3](LICENSE) — 使用本项目的衍生作品必须同样以 GPLv3 开源。
