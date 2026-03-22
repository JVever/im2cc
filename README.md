# im2cc

> 离开电脑，不离开 Claude Code

im2cc 让你在手机上通过飞书或微信，远程操控电脑上正在运行的 Claude Code。回到电脑后，对话无缝接续——就像你从未离开过。

## 它解决什么问题？

你在电脑上用 Claude Code 写代码，写到一半要出门。你有两个选择：

1. **关掉对话**——回来后从头建立上下文，之前的思路全断了
2. **用 im2cc**——拿出手机继续和同一个 Claude 对话，它记得你们刚才讨论的所有内容

im2cc 不是一个新的 AI 助手，它是你电脑上那个 Claude Code 的「遥控器」。

## 使用场景

**通勤路上启动任务**
> 地铁上用手机告诉 Claude："把昨天的 PR review 意见都改了"，到公司时打开电脑，所有改动已经在那里等你。

**会议间隙看进度**
> Claude 正在跑一个大重构，会议中掏出手机发一句 `/fs`，看到它还在执行，放心继续开会。

**睡前安排第二天的活**
> 躺在床上给 Claude 发几个任务，第二天早上打开电脑直接 review 结果。

**临时处理紧急问题**
> 周末在外面，线上出了 bug。手机上 `/fc production` 接入项目，让 Claude 帮你定位问题、写修复、跑测试。

## 核心优势

### 飞书、微信、电脑——三端无缝流转

在飞书群里给 Claude 布置任务，切到微信看进度，回到电脑接着改代码。无论你在哪个端操作，Claude 看到的都是**同一个对话**——它记得之前所有的上下文、读过的文件、做过的改动。不是消息同步，不是对话复制，是真正的同一个 Claude Code session。

### 手机上并行指挥多个项目

你的电脑上可以同时跑多个 Claude Code，各自负责不同的项目。im2cc 让你在手机上也能同时管理它们——飞书中开几个群，每个群接入不同的项目，后端群让 Claude 改 API，前端群让它调样式，运维群让它查日志。多条线并行推进，互不干扰。

### 切换时自动带上上下文

每次从一个端切到另一个端时，im2cc 会自动回顾最近的对话内容并展示给你。在手机上接入一个对话，立刻能看到刚才在电脑上和 Claude 聊了什么、做了什么；回到电脑，手机上的操作结果也都在。不需要翻记录、不需要手动同步——切过去就能直接继续。

## 快速开始

### 第 1 步：安装

确保电脑上已有 [Node.js](https://nodejs.org/)（>= 20）、[tmux](https://github.com/tmux/tmux) 和 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)，然后：

```bash
git clone https://github.com/JVever/im2cc.git
cd im2cc
bash install.sh
```

安装脚本会自动完成：依赖安装、编译、注册全局命令、配置终端快捷命令（fn/fc/fl 等）、安装 session 同步 hook。如有缺失的依赖，会提示你如何安装。

### 第 2 步：连接飞书或微信

**飞书**（需要先在[飞书开放平台](https://open.feishu.cn/)创建一个自建应用 Bot）：

```bash
im2cc setup    # 输入飞书 App ID 和 App Secret
im2cc start    # 启动守护进程
```

把 Bot 加入飞书群，在群里发 `/fl` 试试——你会看到电脑上所有已注册的 Claude Code 对话。

<details>
<summary>飞书 App 需要的权限（6 个）</summary>

| 权限 | 用途 |
|------|------|
| `im:message` | 获取与发送消息 |
| `im:message:send_as_bot` | 以 Bot 身份发消息 |
| `im:message.group_msg:readonly` | 读取群消息 |
| `im:message.group_at_msg:readonly` | 读取 @Bot 消息 |
| `im:chat:readonly` | 获取 Bot 所在的群列表 |
| `im:resource` | 下载消息中的文件/图片 |

</details>

**微信**（需要微信 iOS 8.0.70+，且已开启 ClawBot 插件：设置 → 插件 → ClawBot）：

```bash
im2cc wechat login    # 终端显示 QR 码，用微信扫码绑定
im2cc start           # 启动守护进程（如已在运行则 im2cc stop 后再 start）
```

> 微信目前支持纯文本对话。文件/图片传输功能仅飞书可用。

### 第 3 步：开始使用

```bash
# 电脑上创建一个 Claude Code 对话
fn myproject ~/Code/my-project

# 离开电脑后，在飞书群或微信中接入这个对话
/fc myproject

# 回到电脑，把对话接回来
fc myproject
```

遇到问题？运行 `im2cc doctor` 检查环境状态。

## 命令速查

| 命令 | 作用 | 电脑 | 飞书/微信 |
|------|------|------|-----------|
| **fn** `<名称> [路径]` | 创建新对话 | `fn auth ~/Code/auth` | `/fn auth auth-service` |
| **fc** `<名称>` | 接入已有对话 | `fc auth` | `/fc auth` |
| **fc** `<名称> <ID前缀>` | 注册并接入未管理的对话 | `fc my-fork 2961` | `/fc my-fork 2961` |
| **fl** | 列出所有对话 | `fl` | `/fl` |
| **fk** `<名称>` | 终止对话 | `fk auth` | `/fk auth` |
| **fd** | 断开当前对话 | `fd`（tmux detach） | `/fd` |
| **fs** `[名称]` | 查看对话状态 | `fs auth` | `/fs` |
| `/mode` | 切换权限模式 | — | `/mode default` |
| `/stop` | 中断执行中的任务 | — | `/stop` |

## 安全

- **用户白名单**：可配置只允许指定用户发送消息，默认关闭（允许所有人）
- **路径白名单**：Claude Code 只能操作指定目录下的项目（默认 `~/Code/`）
- **权限模式**：默认 YOLO（自动执行），可随时切换为 `default`（需确认）
- **本地运行**：所有数据留在你的电脑上，不经过任何第三方服务器（飞书/微信仅传递消息）

## 守护进程管理

```bash
im2cc start              # 启动
im2cc stop               # 停止
im2cc status             # 查看状态
im2cc logs               # 查看日志
im2cc doctor             # 环境检查
im2cc install-service    # 安装 macOS 开机自启
im2cc wechat login       # 绑定微信
im2cc wechat status      # 查看微信状态
im2cc wechat logout      # 解绑微信
```

## 工作原理

```
┌──────────┐                    ┌──────────────┐    spawn     ┌─────────────┐
│ 飞书群聊  │◄── REST 轮询 ──────►│              │ ──────────► │             │
│          │                    │ im2cc 守护进程 │             │ Claude Code │
│ 微信     │◄── iLink 长轮询 ──►│  (本地运行)    │             │ CLI         │
│ ClawBot  │                    │              │             │             │
└──────────┘                    └──────────────┘             └─────────────┘
```

im2cc 在你的电脑上运行一个轻量守护进程，它同时连接飞书和微信，把你的消息转发给本地的 Claude Code CLI（`claude -p --resume`），再把 Claude 的回复发回手机。不使用 Agent SDK，直接操控 CLI，所以 Claude Code 的所有能力——读文件、写代码、跑命令、用 MCP 工具——在手机上一样可用。

## 许可证

[GPLv3](LICENSE) — 使用本项目的衍生作品必须同样以 GPLv3 开源。
