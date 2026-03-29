# im2cc

> 离开电脑，不离开你的 AI coding tool

im2cc 让你在手机上通过飞书或微信，继续操控电脑上正在运行的 `Claude Code`、`Codex` 或 `Gemini CLI`。不是远程桌面，不是复制一份聊天记录，而是接着同一个本地 session 往下做。

## 30 秒看懂

- **同一个会话继续做**：出门后在手机上接入，回到电脑再接回，不丢上下文。
- **多个项目并行推进**：电脑上可以同时跑多个 AI 会话；在手机上可以快速接入不同 session，飞书里还可以给不同项目建不同群，各自绑定一个 session。
- **切换时自动带上最近上下文**：接入会话后，会优先看到最近一轮完整对话；如果太长，最多拆成 3 条消息发回手机。
- **完全本地运行**：代码、对话和执行都留在你自己的电脑上，飞书和微信只负责消息传递。

## 快速开始

最快的闭环只有三步：

1. 安装 `im2cc`
2. 运行 `im2cc onboard`
3. 按提示选飞书或微信，并完成一次真实对话流转

### 方式一：让 AI coding tool 帮你安装（推荐）

如果你已经在用 `Claude Code`、`Codex` 或 `Gemini CLI`，把下面这段话原样发给它：

```text
请帮我安装并配置 im2cc，让我可以通过飞书或微信在手机上远程操控这台电脑上的 AI coding tool。这个仓库是公开仓库，请优先使用普通 git HTTPS clone，不要依赖 gh CLI 登录，也不要依赖需要 GitHub 认证的 API / MCP / 集成。请先执行：

git clone https://github.com/JVever/im2cc.git ~/im2cc

如果 git 不可用，先安装 git；如果 git clone 失败，但普通 HTTPS 下载 GitHub 内容仍可用，就改用源码包 fallback：

mkdir -p ~/im2cc
curl -L https://codeload.github.com/JVever/im2cc/tar.gz/refs/heads/master | tar -xz -C ~/im2cc --strip-components=1

如果这两种方式都失败，再排查 github.com 网络连通性、代理、文件系统权限或公司网络策略，不要默认要求我登录 gh。然后进入 ~/im2cc，阅读 INSTALL.md、README.md 和仓库内的 agent/onboarding instructions，继续完成全部安装、IM 接入、首次验证、开机自启动和基础安全加固配置。只有在必须由我操作时再问我。
```

AI coding tool 应该自动处理：依赖安装、编译项目、配置环境、接入飞书/微信、启动守护进程、完成首次验证，并在成功后继续完成开机自启动和基础安全加固。你只需要在必须的人机交互节点配合一下，比如登录飞书、允许浏览器接管、微信扫码，或在手机端发几条验证命令。

### 方式二：手动安装

如果你更习惯自己动手，确保电脑上已有 [Node.js](https://nodejs.org/)（>= 20）、[tmux](https://github.com/tmux/tmux)，并至少安装一个受支持的 CLI：[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、`codex`、`gemini`。对应 CLI 也需要先完成各自的登录/鉴权，然后执行：

```bash
git clone https://github.com/JVever/im2cc.git ~/im2cc
cd ~/im2cc
bash install.sh
im2cc onboard
```

安装脚本会自动完成：依赖安装、编译、注册全局命令、配置终端快捷命令、安装 Claude Code 的 session 同步 hook。之后继续运行 `im2cc onboard`，完成 IM 接入、首次验证，以及成功后的开机自启动和安全加固。

安装完成后，后续升级优先直接运行 `im2cc upgrade`。

## 升级已有安装

以后升级，优先直接运行：

```bash
im2cc upgrade
```

这个命令会自动完成：

- 拉取最新代码
- 重新执行安装脚本
- 刷新终端快捷命令和 Claude hook
- 如果升级前 daemon 正在运行，自动重启让新版本生效

你的运行时配置保存在 `~/.im2cc/`，正常升级不会覆盖这部分内容。

## 连接飞书或微信

### 飞书

需要先在 [飞书开放平台](https://open.feishu.cn/) 创建一个自建应用 Bot，然后：

```bash
im2cc setup
im2cc onboard
```

`im2cc setup` 现在只负责保存飞书凭证。把 Bot 加入飞书群后，直接按 `im2cc onboard` 的提示继续完成启动、真实会话接入，以及成功后的稳定化配置。

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

### 微信

需要微信已开启 ClawBot 插件：`设置 → 插件 → ClawBot`，然后：

```bash
im2cc wechat login
im2cc onboard
```

微信接通后，同样直接按 `im2cc onboard` 的提示继续完成启动、真实会话接入，以及成功后的稳定化配置。

## Onboarding 流程

`im2cc onboard` 会把首用流程拆成三段：先完成第一次成功，再做稳定化，最后再去学进阶能力。

### Phase 1: First Success

完成安装和 IM 接入后，先做一次真实验证。

如果你已经在项目目录里，按你正在使用的工具任选一种方式创建对话：

```bash
fn myproject
# 或
fn-codex myproject
# 或
fn-gemini myproject
```

如果你当前不在项目目录里，再用带路径的写法。下面的 `<你的项目路径>` 需要换成你自己的实际目录，不要直接照抄：

```bash
fn myproject <你的项目路径>
fn --tool codex myproject <你的项目路径>
fn --tool gemini myproject <你的项目路径>
```

然后在飞书群或微信中接入这个对话：

```text
/fc myproject
```

接入后，im2cc 会自动把最近一轮对话回顾发到手机端；默认优先保留最近一轮完整问答，并使用 `【你】` / `【AI】` 标签区分双方内容。若最近一轮过长，会在不超过 3 条消息的前提下自动拆分。

如果你忘了对话名，或者想先看看当前有哪些对话，再执行：

```text
/fl
```

回到电脑后，再把对话接回来：

```bash
fc myproject
```

做到这里，才算第一次成功。

### Phase 2: Make It Stick

第一次成功之后，建议立刻完成下面两步，避免重启后失效或多人误用。

先配置开机自启动：

```bash
im2cc install-service
launchctl load ~/Library/LaunchAgents/com.im2cc.daemon.plist
```

再做基础安全加固：

```bash
im2cc secure
```

`im2cc secure` 会让你补齐两类配置：

- **用户白名单**：哪些 IM 用户可以给 bot 发控制命令
- **路径白名单**：哪些项目目录允许被绑定和操作

### Phase 3: Learn More

遇到问题时，先运行：

```bash
im2cc doctor
```

`doctor` 会检查当前状态并给出下一步建议；高频命令速查用 `im2cc help`。

## 支持矩阵

### Tool

| Tool | 状态 | 说明 |
|------|------|------|
| `Claude Code` | 正式支持 | 创建、恢复、接入、本地历史会话发现 |
| `Codex` | 正式支持 | 通过 `im2cc` 创建并注册的会话可完整流转 |
| `Gemini CLI` | Best-effort | 通过 `im2cc` 创建并注册的会话可完整流转 |

### IM 渠道

| 渠道 | 状态 | 说明 |
|------|------|------|
| 飞书 | 正式支持 | 文本、文件、图片 |
| 微信 | 正式支持 | 当前以纯文本对话为主，文件和图片链路以飞书为主 |

### 其他能力

| 能力 | 当前状态 | 说明 |
|------|----------|------|
| 未注册本地历史会话自动发现 | `Claude Code` | 通过 `/fc <新名称> <ID前缀>` 注册并接入 |
| `fn-codex` / `fn-gemini` 终端快捷命令 | 可用 | 仅电脑终端可用，IM 里不提供 `/fn-codex` 这类命令 |
| Claude 会话漂移同步 hook | 可用 | 仅对 `Claude Code` 安装 |

## 命令速查

核心流转命令在电脑终端和 IM 中基本对应；少数命令只在某一端可用。

| 命令 | 作用 | 电脑 | 飞书/微信 |
|------|------|------|-----------|
| **fn** `[--tool 工具] <名称> [路径]` | 创建新对话 | `fn auth` 或 `fn --tool codex auth` | `/fn auth auth-service` 或 `/fn auth auth-service --tool codex` |
| **fc** `<名称>` | 接入已有对话 | `fc auth` | `/fc auth` |
| **fl** | 列出所有对话 | `fl` | `/fl` |
| **fk** `<名称>` | 终止对话 | `fk auth` | `/fk auth` |
| **fd** | 断开当前对话 | `fd` | `/fd` |
| **fs** | 查看当前对话状态 | `fs auth` | `/fs` |
| `im2cc onboard` | 查看首次安装引导 | `im2cc onboard` | — |
| `im2cc secure` | 配置白名单 | `im2cc secure` | — |
| `/mode` | 查看可用模式 | — | `/mode` |
| `/mode <模式别名>` | 切换权限模式 | — | `/mode au` |
| `/stop` | 中断执行中的任务 | — | `/stop` |
| `im2cc help` / `fhelp` | 查看帮助 | `im2cc help` 或 `fhelp` | `/fhelp` |

说明：

- 首次使用建议先在电脑终端创建第一个对话；IM 里的 `/fn` 更适合已经知道项目名后的高级用法。
- 在电脑终端里，`fn` 的 `[路径]` 是可选的；如果你已经在项目目录里，直接 `fn <名称>` 就行。
- 在飞书/微信里，建议显式写项目名：`/fn <名称> <项目名> [--tool ...]`。
- 终端里提供两个便捷别名：`fn-codex <名称> [路径]`、`fn-gemini <名称> [路径]`。
- 标准写法仍然是 `fn --tool codex|gemini <名称> [路径]`；在 IM 中请继续使用 `/fn ... --tool codex|gemini`，不要写 `/fn-codex`。
- 查看帮助时，电脑终端优先用 `im2cc help`；`fhelp` 只是快捷命令。飞书/微信里用 `/fhelp`。旧的 `/help` 仍兼容，但不再作为主要入口。

## 安全与隐私

im2cc 完全在你自己的电脑上运行，你的代码和对话内容不会经过任何第三方服务器。飞书和微信仅用于传递消息文本。

你可以进一步控制访问权限：

- **用户白名单**：限制哪些 IM 用户可以发控制命令
- **项目白名单**：限制 AI coding tool 只能操作哪些目录下的项目（默认 `~/Code/`）
- **权限模式**：默认是 `default`，需要确认才执行；你可以在 IM 中用 `/mode` 临时切换

建议在完成第一次真实会话流转后，立刻运行一次 `im2cc secure`。

首次使用更建议先用只有你自己的飞书群或微信会话验证完整链路。

## 常见问题

**飞书群里有多个人，消息会冲突吗？**
> 首次使用不建议直接放进多人群。更稳妥的方式是先用只有你自己的飞书群或微信会话跑通完整链路，再决定是否扩展到多人场景。

**在手机上操作时，电脑上的工具会怎样？**
> im2cc 保证同一时刻只有一个端在操控当前对话。当你在手机上接入对话时，电脑端会自动断开。回到电脑端接回时，飞书会收到通知；微信受平台限制，不保证总能主动推送提醒。不会出现两边同时操作导致冲突的情况。

**守护进程崩溃了怎么办？**
> 运行 `im2cc start` 即可（会自动清理残留状态）。im2cc 会自动恢复之前正在执行的任务，如果任务因重启中断，会在飞书/微信中通知你。

**微信 token 过期了怎么办？**
> 运行 `im2cc wechat login` 重新扫码绑定，然后 `im2cc stop && im2cc start` 重启守护进程。

**如何查看环境是否配置正确？**
> 运行 `im2cc doctor`，它会检查当前状态并给出下一步建议；如果你想看完整首用引导，运行 `im2cc onboard`。

## 守护进程管理

```bash
im2cc start              # 启动
im2cc stop               # 停止
im2cc status             # 查看状态
im2cc logs               # 查看日志
im2cc onboard            # 首次安装引导
im2cc secure             # 配置白名单
im2cc doctor             # 环境检查
im2cc install-service    # 安装 macOS 开机自启
im2cc wechat login       # 绑定微信
im2cc wechat status      # 查看微信状态
im2cc wechat logout      # 解绑微信
```

## 工作原理

```text
┌──────────┐                    ┌──────────────┐    spawn     ┌─────────────┐
│ 飞书群聊  │◄── REST 轮询 ──────►│              │ ──────────► │ AI Coding   │
│          │                    │ im2cc 守护进程 │             │ Tool CLI    │
│ 微信     │◄── iLink 长轮询 ──►│  (本地运行)    │             │             │
│ ClawBot  │                    │              │             │             │
└──────────┘                    └──────────────┘             └─────────────┘
```

im2cc 在你的电脑上运行一个轻量守护进程，它同时连接飞书和微信，把你的消息转发给本地 CLI，再把回复发回手机。当前正式支持 `Claude Code`、`Codex`，并提供 `Gemini CLI` 的 best-effort 支持。它直接操控 CLI，而不是走 Agent SDK 中转，所以工具原生的读写文件、执行命令、调用 MCP 等能力可以直接复用。

补充说明：当前“扫描并导入未注册的本地历史会话”主要面向 `Claude Code`；`Codex/Gemini` 的完整支持路径是通过 `im2cc new --tool ...` 或 IM 里的 `/fn --tool ...` 创建并注册后再流转。

## 许可证

[GPLv3](LICENSE) — 使用本项目的衍生作品必须同样以 GPLv3 开源。
