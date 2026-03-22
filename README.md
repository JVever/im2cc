# im2cc

> 离开电脑，不离开 Claude Code

im2cc 让你在手机上通过飞书或微信，远程操控电脑上正在运行的 Claude Code。回到电脑后，对话无缝接续——就像你从未离开过。

## 它解决什么问题？

你在电脑上用 Claude Code 做事，做到一半要出门。你有两个选择：

1. **关掉对话**——回来后从头建立上下文，之前的思路全断了
2. **用 im2cc**——拿出手机继续和同一个 Claude 对话，它记得你们之前所有的内容

## 使用场景

**通勤路上启动任务**
> 地铁上用手机告诉 Claude："把昨天的 PR review 意见都改了"，到公司时打开电脑，所有改动已经在那里等你。

**会议间隙看进度**
> Claude 正在跑一个大重构，开会时掏出手机看一眼状态，还在执行中，放心继续开会。

**睡前安排第二天的活**
> 躺在床上给 Claude 发几个任务，第二天早上打开电脑直接 review 结果。

**在外面突然有想法**
> 出门遛弯时想到一个方案优化思路，掏出手机告诉 Claude 去调研、写方案，回家后打开电脑看结果。

**临时处理紧急问题**
> 周末在外面，线上出了问题。手机上接入对应项目，让 Claude 帮你排查定位。

## 核心优势

### 飞书、微信、电脑——三端无缝流转

在飞书群里给 Claude 布置任务，切到微信看进度，回到电脑接着改代码。无论你在哪个端操作，Claude 看到的都是**同一个对话**——它记得之前所有的上下文、读过的文件、做过的改动。不是消息同步，不是对话复制，是真正的同一个 Claude Code session。

### 手机上并行指挥多个项目

你的电脑上可以同时跑多个 Claude Code，各自负责不同的项目。im2cc 让你在手机上也能同时管理它们——飞书中开几个群，每个群接入不同的项目，后端群让 Claude 改 API，前端群让它调样式，运维群让它查日志。多条线并行推进，互不干扰。

### 切换时自动带上上下文

每次从一个端切到另一个端时，im2cc 会自动回顾最近的对话内容并展示给你。在手机上接入一个对话，立刻能看到刚才在电脑上和 Claude 聊了什么、做了什么；回到电脑，手机上的操作结果也都在。不需要翻记录、不需要手动同步——切过去就能直接继续。

## 快速开始

### 方式一：让 Claude Code 帮你安装（推荐）

如果你已经在用 Claude Code，把下面这段话直接发给它：

> 请帮我安装 im2cc（一个让我在手机上通过飞书/微信远程操控你的工具）。先执行 `git clone https://github.com/JVever/im2cc.git ~/im2cc`，然后阅读 `~/im2cc/INSTALL.md` 并按其中的步骤完成全部安装和配置。

Claude Code 会自动处理所有事情——包括安装缺失的依赖、编译项目、配置环境，遇到问题也会自己解决。你只需要在它需要你操作的时候配合一下（比如去飞书后台创建 App、或者用微信扫码）。

### 方式二：手动安装

如果你更习惯自己动手，确保电脑上已有 [Node.js](https://nodejs.org/)（>= 20）、[tmux](https://github.com/tmux/tmux) 和 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)，然后：

```bash
git clone https://github.com/JVever/im2cc.git ~/im2cc
cd ~/im2cc
bash install.sh
```

安装脚本会自动完成：依赖安装、编译、注册全局命令、配置终端快捷命令、安装 session 同步 hook。如有缺失的依赖，会告诉你如何安装。

### 连接飞书或微信

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

**微信**（需要微信已开启 ClawBot 插件：设置 → 插件 → ClawBot）：

```bash
im2cc wechat login    # 终端显示 QR 码，用微信扫码绑定
im2cc start           # 启动守护进程（如已在运行则 im2cc stop 后再 start）
```

微信目前支持纯文本对话。文件和图片传输功能正在开发中，当前仅飞书可用。

### 开始使用

在电脑上创建一个 Claude Code 对话（如果你已有对话可以跳过这步）：

```bash
fn myproject ~/Code/my-project
```

离开电脑后，在飞书群或微信中接入这个对话：

```
/fc myproject
```

回到电脑，把对话接回来：

```bash
fc myproject
```

遇到问题？运行 `im2cc doctor` 检查环境状态。

## 命令速查

所有命令在电脑终端和 IM 中通用。命名规则：`f` 代表"流转"，后面一个字母表示操作——`n`ew 创建、`c`onnect 接入、`l`ist 列出、`k`ill 终止、`d`isconnect 断开、`s`tatus 状态。

| 命令 | 作用 | 电脑 | 飞书/微信 |
|------|------|------|-----------|
| **fn** `<名称> [路径]` | 创建新对话 | `fn auth ~/Code/auth` | `/fn auth auth-service` |
| **fc** `<名称>` | 接入已有对话 | `fc auth` | `/fc auth` |
| **fl** | 列出所有对话 | `fl` | `/fl` |
| **fk** `<名称>` | 终止对话 | `fk auth` | `/fk auth` |
| **fd** | 断开当前对话 | `fd` | `/fd` |
| **fs** `[名称]` | 查看对话状态 | `fs auth` | `/fs` |
| `/mode` | 切换权限模式 | — | `/mode default` |
| `/stop` | 中断执行中的任务 | — | `/stop` |

## 安全与隐私

im2cc 完全在你自己的电脑上运行，你的代码和对话内容不会经过任何第三方服务器。飞书和微信仅用于传递消息文本。

你可以进一步控制访问权限：

- **用户白名单**：指定只有哪些飞书/微信用户可以发送消息给你的 Claude Code
- **项目白名单**：限制 Claude Code 只能操作哪些目录下的项目（默认 `~/Code/`）
- **权限模式**：随时通过 `/mode default` 切换为「每步操作都需要确认」的安全模式

## 常见问题

**飞书群里有多个人，消息会冲突吗？**
> 不会。你可以通过用户白名单控制谁能发送消息。未授权的用户发的消息会被忽略。

**在手机上操作时，电脑上的 Claude Code 会怎样？**
> im2cc 保证同一时刻只有一个端在操控 Claude。当你在手机上接入对话时，电脑端会自动断开；反过来在电脑上接回时，手机端会收到通知。不会出现两边同时操作导致冲突的情况。

**守护进程崩溃了怎么办？**
> 运行 `im2cc start` 重启即可。im2cc 会自动恢复之前正在执行的任务，如果任务因重启中断，会在飞书/微信中通知你。

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
│ 飞书群聊  │◄── REST 轮询 ──────►│              │ ──────────► │             │
│          │                    │ im2cc 守护进程 │             │ Claude Code │
│ 微信     │◄── iLink 长轮询 ──►│  (本地运行)    │             │ CLI         │
│ ClawBot  │                    │              │             │             │
└──────────┘                    └──────────────┘             └─────────────┘
```

im2cc 在你的电脑上运行一个轻量守护进程，它同时连接飞书和微信，把你的消息转发给本地的 Claude Code CLI，再把 Claude 的回复发回手机。直接操控 CLI 而非使用 Agent SDK，所以 Claude Code 的所有能力——读写文件、执行命令、使用 MCP 工具——在手机上一样可用。

## 许可证

[GPLv3](LICENSE) — 使用本项目的衍生作品必须同样以 GPLv3 开源。
