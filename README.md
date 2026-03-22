# im2cc

> IM to Claude Code — 通过飞书/微信远程操控本地 Claude Code，电脑/手机无缝流转

在手机上通过飞书群聊或微信 ClawBot 远程操控电脑上的 Claude Code CLI，回到电脑后无缝接续同一个对话。

## 核心特性

- **多通道支持**：飞书群聊 + 微信 ClawBot，同时连接
- **无缝流转**：电脑和手机之间自由切换，上下文完全一致
- **独占访问**：同一对话永远只在一个地方活跃
- **统一命令**：fn/fc/fl/fk/fd/fs，终端和 IM 完全一致
- **文件传输**：飞书发送文件/图片，自动暂存到项目 inbox

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

## 快速开始

### 安装

```bash
git clone https://github.com/jvever/im2cc.git
cd im2cc
npm install
npm run build
npm link
```

### 配置飞书 Bot

```bash
im2cc setup    # 输入飞书 App ID 和 App Secret
im2cc start    # 启动守护进程
```

飞书 App 需要以下权限：`im:message`、`im:message:send_as_bot`、`im:message.group_msg:readonly`、`im:message.group_at_msg:readonly`、`im:chat:readonly`、`im:resource`

### 配置微信 ClawBot（可选）

```bash
im2cc wechat login    # 扫码绑定微信 ClawBot
im2cc stop && im2cc start  # 重启守护进程
```

需要微信 iOS 8.0.70+，并已开启 ClawBot 插件。

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
| **fl** | 列出所有对话 | `fl` |
| **fk** | 终止对话 | `fk auth` |
| **fd** | 断开当前对话 | `fd` |
| **fs** | 查看状态 | `fs auth` |

IM 专用命令：

| 命令 | 作用 |
|------|------|
| `/mode <YOLO\|default\|auto-edit>` | 切换权限模式 |
| `/stop` | 中断正在执行的任务 |

## 技术栈

| 组件 | 选择 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Node.js >= 20 |
| 飞书连接 | @larksuiteoapi/node-sdk (REST 轮询) |
| 微信连接 | iLink Bot API (HTTP 长轮询) |
| CLI 调用 | child_process.spawn |
| 本地会话 | tmux |
| 守护进程 | macOS LaunchAgent |

## 目录结构

```
im2cc/
├── src/
│   ├── index.ts           # 主入口：多 transport 消息路由
│   ├── transport.ts       # Transport 抽象接口
│   ├── feishu.ts          # 飞书 REST 轮询适配器
│   ├── wechat.ts          # 微信 iLink 长轮询适配器
│   ├── config.ts          # 配置加载
│   ├── security.ts        # 用户白名单 + 路径验证
│   ├── registry.ts        # 命名 session 注册表
│   ├── session.ts         # IM ↔ session 绑定
│   ├── claude-driver.ts   # Claude Code CLI 驱动
│   ├── commands.ts        # 统一命令系统
│   ├── queue.ts           # 消息队列 + Job 管理
│   ├── output.ts          # CLI 输出格式化
│   └── ...
├── bin/
│   └── im2cc.ts           # CLI (start/stop/setup/wechat/...)
├── shell/
│   └── im2cc-shell-functions.zsh  # Shell 命令 (fn/fc/fl/fk/fd/fs)
└── package.json
```

## 守护进程管理

```bash
im2cc start              # 启动
im2cc stop               # 停止
im2cc status             # 查看状态
im2cc logs               # 查看日志
im2cc doctor             # 环境检查
im2cc install-service    # 安装 macOS 开机自启
```

## 许可证

[GPLv3](LICENSE) — 使用本项目的衍生作品必须同样开源。
