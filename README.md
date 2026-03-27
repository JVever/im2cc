# im2cc

> 离开电脑，不离开你的 AI coding tool

im2cc 让你在手机上通过飞书或微信，远程操控电脑上正在运行的 AI coding tool。回到电脑后，对话无缝接续，就像你从未离开过。

> 当前支持：`Claude Code` / `Codex`
>
> Best-effort：`Gemini CLI`
>
> 微信支持纯文本对话；文件和图片目前仍以飞书链路为主。`/fc <新名称> <ID前缀>` 自动发现未注册本地会话目前仅支持 Claude Code，会话一旦通过 im2cc 创建并注册，四种工具都支持完整流转。

## 它解决什么问题？

你在电脑上用 Claude、Codex 或 Gemini 做事，做到一半要出门。你有两个选择：

1. **关掉对话**——回来后从头建立上下文，之前的思路全断了
2. **用 im2cc**——拿出手机继续和同一个 AI 对话，它记得你们之前所有的内容

## 使用场景

**通勤路上启动任务**
> 地铁上用手机告诉 AI："把昨天的 PR review 意见都改了"，到公司时打开电脑，所有改动已经在那里等你。

**会议间隙看进度**
> AI 正在跑一个大重构，开会时掏出手机看一眼状态，还在执行中，放心继续开会。

**睡前安排第二天的活**
> 躺在床上给 AI 发几个任务，第二天早上打开电脑直接 review 结果。

**在外面突然有想法**
> 出门遛弯时想到一个方案优化思路，掏出手机告诉 AI 去调研、写方案，回家后打开电脑看结果。

**临时处理紧急问题**
> 周末在外面，线上出了问题。手机上接入对应项目，让 AI 帮你排查定位。

## 核心优势

### 飞书、微信、电脑——三端无缝流转

在飞书群里给 AI 布置任务，切到微信看进度，回到电脑接着改代码。无论你在哪个端操作，工具看到的都是**同一个对话**，它记得之前所有的上下文、读过的文件、做过的改动。不是消息同步，不是对话复制，是真正的同一个 session。

### 手机上并行指挥多个项目

你的电脑上可以同时跑多个 AI coding tool 对话，各自负责不同的项目。im2cc 让你在手机上也能同时管理它们，后端群让 Claude 改 API，前端群让 Codex 调样式，另一个会话让 Gemini 查资料。多条线并行推进，互不干扰。

### 切换时自动带上上下文

每次从一个端切到另一个端时，im2cc 会自动回顾最近的对话内容并展示给你。在手机上接入一个对话，立刻能看到刚才在电脑上和 AI 聊了什么、做了什么；回到电脑，手机上的操作结果也都在。不需要翻记录、不需要手动同步，切过去就能直接继续。

## 快速开始

### 方式一：让 AI coding tool 帮你安装（推荐）

如果你已经在用 Claude Code、Codex 或 Gemini CLI，把下面这段话原样发给它：

```text
请帮我安装并配置 im2cc，让我可以通过飞书或微信在手机上远程操控这台电脑上的 AI coding tool。这个仓库是公开仓库，请优先使用普通 git HTTPS clone，不要依赖 gh CLI 登录，也不要依赖需要 GitHub 认证的 API / MCP / 集成。请先执行：

git clone https://github.com/JVever/im2cc.git ~/im2cc

如果 git 不可用，先安装 git；如果 git clone 失败，但普通 HTTPS 下载 GitHub 内容仍可用，就改用源码包 fallback：

mkdir -p ~/im2cc
curl -L https://codeload.github.com/JVever/im2cc/tar.gz/refs/heads/master | tar -xz -C ~/im2cc --strip-components=1

如果这两种方式都失败，再排查 github.com 网络连通性、代理、文件系统权限或公司网络策略，不要默认要求我登录 gh。然后进入 ~/im2cc，阅读 INSTALL.md、README.md 和仓库内的 agent/onboarding instructions，继续完成全部安装、IM 接入、首次验证和开机自启动配置。只有在必须由我操作时再问我。
```

AI coding tool 应该自动处理：依赖安装、编译项目、配置环境、接入飞书/微信、启动守护进程、完成首次验证。你只需要在必须的人机交互节点配合一下，比如登录飞书、允许浏览器接管、微信扫码、或在手机端发几条验证命令。

### 方式二：手动安装

如果你更习惯自己动手，确保电脑上已有 [Node.js](https://nodejs.org/)（>= 20）、[tmux](https://github.com/tmux/tmux)，并至少安装一个受支持的 CLI： [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、`codex`、`gemini`。对应 CLI 也需要先完成各自的登录/鉴权，然后：

```bash
git clone https://github.com/JVever/im2cc.git ~/im2cc
cd ~/im2cc
bash install.sh
```

安装脚本会自动完成：依赖安装、编译、注册全局命令、配置终端快捷命令、安装 session 同步 hook。如有缺失的依赖，会告诉你如何安装。之后仍需要继续做 IM 接入、首次验证和可选的开机自启动。

### 连接飞书或微信

**飞书**（需要先在[飞书开放平台](https://open.feishu.cn/)创建一个自建应用 Bot）：

```bash
im2cc setup    # 输入飞书 App ID 和 App Secret
im2cc start    # 启动守护进程
```

把 Bot 加入飞书群后，先在群里发 `/help` 或 `/fl` 验证消息链路；再在电脑上创建一个真实对话，用 `/fc <名称>` 验证完整流转。

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

**微信**（需要微信已开启 ClawBot 插件：设置 → 插件 → ClawBot）：

```bash
im2cc wechat login    # 终端显示 QR 码，用微信扫码绑定
im2cc start           # 启动守护进程（如已在运行则 im2cc stop 后再 start）
```

微信目前支持纯文本对话。文件和图片传输功能正在开发中，当前仅飞书可用。接通后同样建议先发 `/help` 或 `/fl`，再完成一次真实对话接入。

### 第一次验证与开始使用

完成安装和 IM 接入后，先做一次真实验证。

先进入你正在处理的项目目录，再创建一个对话：

```bash
cd ~/Code/my-project
fn myproject
fn-codex myproject
```

如果你不在项目目录里，也可以显式传路径：

```bash
fn myproject ~/Code/my-project
fn-codex myproject ~/Code/my-project
```

然后在飞书群或微信中先看对话列表，再接入这个对话：

```
/fl
/fc myproject
```

回到电脑，把对话接回来：

```bash
fc myproject
```

如果你希望重启后也能自动在线，再执行：

```bash
im2cc install-service
launchctl load ~/Library/LaunchAgents/com.im2cc.daemon.plist
```

遇到问题？运行 `im2cc doctor` 检查环境状态。

## 命令速查

所有命令在电脑终端和 IM 中通用。命名规则：`f` 代表"流转"，后面一个字母表示操作——`n`ew 创建、`c`onnect 接入、`l`ist 列出、`k`ill 终止、`d`isconnect 断开、`s`tatus 状态。

| 命令 | 作用 | 电脑 | 飞书/微信 |
|------|------|------|-----------|
| **fn** `[--tool 工具] <名称> [路径]` | 创建新对话（省略路径时默认当前目录） | `fn auth` 或 `fn --tool codex auth` | `/fn auth` 或 `/fn auth auth-service --tool codex` |
| **fc** `<名称>` | 接入已有对话 | `fc auth` | `/fc auth` |
| **fl** | 列出所有对话 | `fl` | `/fl` |
| **fk** `<名称>` | 终止对话 | `fk auth` | `/fk auth` |
| **fd** | 断开当前对话 | `fd` | `/fd` |
| **fs** | 查看当前对话状态 | `fs auth` | `/fs` |
| `/mode` | 查看可用模式 | — | `/mode` |
| `/mode <模式别名>` | 切换权限模式 | — | `/mode au` |
| `/stop` | 中断执行中的任务 | — | `/stop` |

说明：
- `fn` 的 `[路径]` 是可选的；如果你已经在项目目录里，直接 `fn <名称>` 就行。
- 终端里提供两个便捷别名：`fn-codex <名称> [路径]`、`fn-gemini <名称> [路径]`。
- 标准写法仍然是 `fn --tool codex|gemini <名称> [路径]`；在 IM 中请继续使用 `/fn ... --tool codex|gemini`，不要写 `/fn-codex`。

## 安全与隐私

im2cc 完全在你自己的电脑上运行，你的代码和对话内容不会经过任何第三方服务器。飞书和微信仅用于传递消息文本。

你可以进一步控制访问权限：

- **用户白名单**：指定只有哪些飞书/微信用户可以发送消息给你的 AI coding tool
- **项目白名单**：限制 AI coding tool 只能操作哪些目录下的项目（默认 `~/Code/`）
- **权限模式**：默认是 `default`，需要确认才执行；你可以在 IM 中用 `/mode` 临时切换

在你配置好用户白名单之前，不要把 Bot 放进多人群。首次使用更建议先用只有你自己的飞书群或微信会话验证完整链路。

## 常见问题

**飞书群里有多个人，消息会冲突吗？**
> 不会。你可以通过用户白名单控制谁能发送消息。未授权的用户发的消息会被忽略。

**在手机上操作时，电脑上的工具会怎样？**
> im2cc 保证同一时刻只有一个端在操控当前对话。当你在手机上接入对话时，电脑端会自动断开。回到电脑端接回时，飞书会收到通知；微信受平台限制，不保证总能主动推送提醒。不会出现两边同时操作导致冲突的情况。

**守护进程崩溃了怎么办？**
> 运行 `im2cc start` 即可（会自动清理残留状态）。im2cc 会自动恢复之前正在执行的任务，如果任务因重启中断，会在飞书/微信中通知你。

**微信 token 过期了怎么办？**
> 运行 `im2cc wechat login` 重新扫码绑定，然后 `im2cc stop && im2cc start` 重启守护进程。

**如何查看环境是否配置正确？**
> 运行 `im2cc doctor`，它会检查所有依赖和配置状态。

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
│ 飞书群聊  │◄── REST 轮询 ──────►│              │ ──────────► │ AI Coding   │
│          │                    │ im2cc 守护进程 │             │ Tool CLI    │
│ 微信     │◄── iLink 长轮询 ──►│  (本地运行)    │             │             │
│ ClawBot  │                    │              │             │             │
└──────────┘                    └──────────────┘             └─────────────┘
```

im2cc 在你的电脑上运行一个轻量守护进程，它同时连接飞书和微信，把你的消息转发给本地 CLI，再把回复发回手机。当前正式支持 `Claude Code`、`Codex`，并提供 `Gemini CLI` 的 best-effort 支持。它直接操控 CLI，而不是走 Agent SDK 中转，所以工具原生的读写文件、执行命令、调用 MCP 等能力可以直接复用。

补充说明：当前“扫描并导入未注册的本地历史会话”仍主要面向 Claude Code；`Codex/Gemini` 的完整支持路径是通过 `im2cc new --tool ...` 或 IM 里的 `/fn --tool ...` 创建并注册后再流转。

## 许可证

[GPLv3](LICENSE) — 使用本项目的衍生作品必须同样以 GPLv3 开源。
