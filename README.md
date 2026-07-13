# im2cc

> 离开电脑，不离开你的 AI coding tool

im2cc 让你在手机上通过飞书或微信，继续操控电脑上正在运行的 `Claude Code`、`Codex` 或 `Gemini CLI`。不是远程桌面，不是复制一份聊天记录，而是接着同一个本地 session 往下做。

## 30 秒看懂

- **同一个会话继续做**：出门后在手机上接入，回到电脑再接回，不丢上下文。
- **多个项目并行推进**：电脑上可以同时跑多个 AI 会话；在手机上可以快速接入不同 session，飞书里还可以给不同项目建不同群，各自绑定一个 session。
- **切换时自动带上最近上下文**：接入会话后，会优先看到最近一轮完整对话；如果太长，最多拆成 3 条消息发回手机。
- **完全本地运行**：代码、对话和执行都留在你自己的电脑上，飞书和微信只负责消息传递。

## Recent updates

时间线倒序，仅高亮用户可见的能力。完整变更看 `git log` / [ROADMAP.md](ROADMAP.md)。

- **2026-07** **微信语音输入**：在微信中直接发送语音，im2cc 会读取微信原生转写并按普通文字指令交给当前 Claude Code / Codex / Gemini 会话；微信未生成转写时会明确提示重试，不再静默无响应。此链路不调用外部 ASR。
- **2026-06** **飞书 AI 回复 Markdown 渲染**：AI 的回复（标题、列表、粗体、`inline code`、代码块）现在以飞书富文本 `post` + `md` 标签发送，正常渲染而非显示原始符号。覆盖所有 AI 回复路径（流式回复、`/btw` 旁路、`/fc` 上下文回顾、定时消息触发、反茄钟延迟送达、崩溃恢复结果）。系统提示、命令回执保持纯文本；微信通道仍纯文本降级。
- **2026-05** **IM 端 `/btw` 旁路 side 讨论**：在飞书发 `/btw <问题>`，daemon 复制当前对话 session 文件做临时 fork，跑一次独立 turn 拿答复，主对话历史完全不被污染。继承主对话上下文但不计入主对话 turn 数。**fork turn 内 AI 只能用 Read/Grep/Glob/WebFetch/WebSearch 等只读工具，Edit/Write/Bash 等写工具被硬禁用**，工作目录文件系统无任何副作用。仅 Claude。
- **2026-05** **IM 端 AI 工具调用进度可视化**：daemon 合并 AI 的"过渡句 + Bash 调用"输出,消除"冒号收尾空白"误判;单工具调用 ≥10s 时弹 `⚙️ 正在执行 ...` 状态消息;整轮内最多 1 条状态消息;V1 仅 Claude。
- **2026-05** **IM 端透传 AI 内置斜杠命令**：飞书/微信里可直接调用 `/clear`（轮换 sessionId）、`/compact`（压缩上下文）、`/model`（列出可选模型回复编号切换）、`/fs`（查看会话状态）。
- **2026-05** **Claude `AskUserQuestion` 反向提问**：本地 AI 调用反向提问工具时，飞书弹交互卡片 / 微信用文本编号选项，用户回复即注入答案；8 分钟超时自动取消。仅 `Claude Code` 支持。
- **2026-05** **飞书轮询 per-chat 自适应退避**：活跃 5s / 闲 30s / 长闲 60s/120s 三档自动切换，API 月调用量下降 ~21 倍（实测从 ~48 万/11 天 降到 ~23k/月），不再触碰飞书开放平台用量上限。
- **2026-05** **IM 端 Office 文档传输与解析**：在飞书发 PDF/Word/Excel/PPT 文件，本地 AI 会直接读到文件内容；旧版 `.doc/.xls/.ppt` 自动经 LibreOffice 升格为新版后再传给 AI。微信文件链路暂不支持。
- **2026-04** **定时消息 `/at /in /cron`**：在 IM 里给当前对话设一条触达时间，到点自动把消息发给 AI 处理。常用于 Claude Code 配额窗口重置时自动开工。详见 [§定时消息](#定时消息at-in-cron)。

## 快速开始

前置要求：macOS，[Node.js](https://nodejs.org/) >= 20，[tmux](https://github.com/tmux/tmux)，至少装一个 AI CLI（[Claude Code](https://docs.anthropic.com/en/docs/claude-code) / `codex` / `gemini` 并完成登录）。

只需要两行：

```bash
npm i -g im2cc
im2cc onboard
```

`im2cc onboard` 会引导你接通飞书或微信、启动守护进程、创建首次会话、完成开机自启和安全加固。首次运行时 `onboard` 会自动把 `fn / fc / fl` 这类终端命令写入 `~/.zshrc`，并把 Claude Code session 同步 hook 写入 `~/.claude/settings.json`，这两步也可以单独执行（见下）。

### 让 AI coding tool 帮你装

把下面这句原样发给 `Claude Code` / `Codex` / `Gemini CLI`：

```text
请帮我安装并配置 im2cc：先跑 npm i -g im2cc，再跑 im2cc onboard，然后按照引导接通飞书或微信即可。如果 npm 全局目录权限不足，指导我配置 ~/.npmrc 的 prefix（比如 ~/.npm-global）。
```

## 更新已有安装

```bash
im2cc update
```

内部等价于 `npm i -g im2cc@latest`，再自动重启守护进程。你的运行时配置保存在 `~/.im2cc/`，更新不会覆盖这部分内容。

（如果你是从源码安装的贡献者，`im2cc update` 会给出 git 更新的引导；或者改用 npm 分发版。）

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

接入后，im2cc 会先发送一条接入状态，再把最近一轮对话回顾发到手机端；默认优先保留最近一轮完整问答，并使用 `【你】` / `【AI】` 标签区分双方内容。若最近一轮过长，会在总数不超过 3 条消息的前提下自动拆分。

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

`im2cc secure` 会让你配置：

- **IM 用户白名单**：哪些 IM 用户可以给 bot 发控制命令（这是 im2cc 真正的认证边界）

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
| 微信 | 正式支持 | 文字、微信原生语音转写；文件和图片链路以飞书为主 |

### 其他能力

| 能力 | 当前状态 | 说明 |
|------|----------|------|
| 未注册本地历史会话自动发现 | `Claude Code` | 通过 `/fc <新名称> <ID前缀>` 注册并接入 |
| `fn-codex` / `fn-gemini` 终端快捷命令 | 可用 | 仅电脑终端可用，IM 里不提供 `/fn-codex` 这类命令 |
| Claude 会话漂移同步 hook | 可用 | 仅对 `Claude Code` 安装 |
| Office 文档（PDF/Word/Excel/PPT）转发 | 可用 | 飞书直接发文件；旧版 `.doc/.xls/.ppt` 自动经 LibreOffice 升格；微信文件链路暂不支持 |
| Claude `AskUserQuestion` 反向提问桥接 | `Claude Code` | 飞书弹交互卡片 / 微信用文本编号选项；8 分钟超时；Codex / Gemini 不在此 feature 范围 |
| 飞书 per-chat 自适应轮询退避 | 可用 | 活跃 5s / 闲 30s-120s 三档自动切换，显著降低 API 调用量 |

## 命令速查

命令按**作用对象**分两类。第一类是 im2cc daemon 自己处理的命令（会话/调度/状态），跟你用哪个 AI 工具无关；第二类是会话控制命令，daemon 拦截后操作当前对话所用的 AI 工具，**不同工具支持情况有差异**。

### im2cc 自有命令（daemon 直接处理，所有工具一致）

| 命令 | 作用 | 电脑 | 飞书/微信 |
|------|------|------|-----------|
| **fn** `[--tool 工具] <名称> [路径]` | 创建新对话 | `fn auth` 或 `fn --tool codex auth` | `/fn auth auth-service` 或 `/fn auth auth-service --tool codex` |
| **fc** `<名称>` | 接入已有对话 | `fc auth` | `/fc auth` |
| **fl** | 列出所有对话 | `fl` | `/fl` |
| `/ls` | 列出曾用过的项目（从 registry 派生短名 + 路径） | — | `/ls` |
| **fk** `<名称>` | 终止对话 | `fk auth` | `/fk auth` |
| **fd** | 断开当前对话 | `fd` | `/fd` |
| **fs** | 查看当前对话状态 | `fs auth` | `/fs` |
| `im2cc onboard` | 查看首次安装引导 | `im2cc onboard` | — |
| `im2cc secure` | 配置 IM 用户白名单 | `im2cc secure` | — |
| `/mode` | 查看可用模式 | — | `/mode` |
| `/mode <模式别名>` | 切换权限模式 | — | `/mode au` |
| `/stop` | 中断执行中的任务 | — | `/stop` |
| `/at HH:MM <消息>` | 定时给当前对话发消息（今天该时刻；已过推明天） | — | `/at 14:30 继续` |
| `/at YYYY-MM-DD HH:MM <消息>` | 指定日期时刻 | — | `/at 2026-04-20 09:00 跑实验` |
| `/in <时长> <消息>` | 间隔后触发（30s/5m/2h/1d，可组合 1h30m） | — | `/in 2h 继续` |
| `/cron <分> <时> <日> <月> <周> <消息>` | 周期触发（5 段标准 cron） | — | `/cron 0 9 * * 1-5 站会汇总` |
| `/at list` | 列出全部定时消息（无需绑定） | — | `/at list` |
| `/at cancel` | 取消当前对话的定时消息 | — | `/at cancel` |
| `/at cancel <对话名>` | 远程取消任意对话的定时消息（无需绑定该对话） | — | `/at cancel auth` |
| `fqon` | 开启反茄钟 | `fqon` | `/fqon` |
| `fqoff` | 关闭反茄钟 | `fqoff` | 仅提示需回到电脑端关闭 |
| `fqs` | 查看反茄钟状态 | `fqs` | `/fqs` |
| `im2cc help` / `fhelp` | 查看帮助 | `im2cc help` 或 `fhelp` | `/fhelp` |

### AI 工具会话控制命令（daemon 拦截后操作工具自身）

这一类命令在不同 AI 工具下支持情况有差异。daemon 在飞书/微信收到后，做一层 alias 翻译再调对应工具的 CLI，**不是把字面命令丢给 AI 当 prompt**。

| 命令 | 作用 | Claude | Codex | Gemini | 用法示例 |
|------|------|:------:|:-----:|:------:|----------|
| `/clear` | 轮换 sessionId（开干净的新一轮），并保留 Session 已选模型 | ✅ | ✅ | ❌ | `/clear` |
| `/compact` | 压缩当前对话上下文（仅 Claude，daemon 真透传 `/compact`） | ✅ | ❌ | ❌ | `/compact` |
| `/model` | 列出可选模型，回复编号切换；下条消息生效 | ✅ | ✅ | ❌ | `/model` 然后回 `2` |
| `/btw <问题>` | 旁路 side 讨论：基于主对话上下文问答，不污染主 session，AI 只能读不能写 | ✅ | ❌ | ❌ | `/btw 刚才说的那个 SQL 怎么调优?` |

> ❌ 表示该工具下命令不可用，会推回错误提示；不会被当 prompt 误传给 AI。

### 说明

- 首次使用建议先在电脑终端创建第一个对话；IM 里的 `/fn` 更适合已经知道项目名后的高级用法。
- 在电脑终端里，`fn` 的 `[路径]` 是可选的；如果你已经在项目目录里，直接 `fn <名称>` 就行。
- 在飞书/微信里，建议显式写项目名：`/fn <名称> <项目名> [--tool ...]`。
- 终端里提供两个便捷别名：`fn-codex <名称> [路径]`、`fn-gemini <名称> [路径]`。
- 标准写法仍然是 `fn --tool codex|gemini <名称> [路径]`；在 IM 中请继续使用 `/fn ... --tool codex|gemini`，不要写 `/fn-codex`。
- 查看帮助时，电脑终端优先用 `im2cc help`；`fhelp` 只是快捷命令。飞书/微信里用 `/fhelp`。旧的 `/help` 仍兼容，但不再作为主要入口。
- AI 工具自身的其他 slash 命令（如 `/init` `/memory` `/hooks` `/mcp` `/agents`）**不被 im2cc 拦截**，会作为普通 prompt 传给 AI，绝大多数会被 AI 工具拒绝执行——属于已知限制。

## 旁路讨论（/btw）

`/btw <问题>` 让你在不打扰主对话的前提下基于当前对话上下文问 AI 一个 side question——答完就忘，不进主对话历史，也不会让 AI 改你的文件。

主要场景：

```
/btw 刚提到的那个库还有别的可选项吗?
/btw 检查下 src/index.ts 第 100 行用的是哪个 API
/btw 我们刚才用的 useEffect 在 React 19 有变化吗?
```

适合"问完即扔"的 follow-up、临时探索、查文档/规范——不希望这些占主对话的 token 预算和上下文。

**关键约束与行为**：

- **不污染主对话**：fork 一份 session 文件跑一次,跑完即删；主对话历史 / turn 数完全不变
- **只读不写**：AI 在 /btw 内只能用读类工具（Read / Grep / Glob / WebFetch / WebSearch）；试图调 Edit / Write / Bash 会被硬拒绝 → 想改文件请走主对话普通消息
- **不并发**：跟主对话和其他 /btw 顺序排队（daemon 同对话单线程）；急可以先 `/stop`
- **仅 Claude**：Codex / Gemini 暂不支持
- **daemon 重启会丢**：进行中的 /btw 会丢失（fork 文件留磁盘但不会自动恢复；文件 KB 级无害）

## 定时消息（/at /in /cron）

主要场景：Claude Code 的 5 小时配额窗口耗尽后，你想在窗口重置的瞬间自动开工，而不是设闹钟手动盯着。

```
/at 19:00 继续刚才的任务         # 今天 19:00；已过则推到明天
/at 2026-04-20 09:00 跑实验      # 指定日期时刻
/in 2h 继续                      # 2 小时后；可组合 1h30m
/cron 0 9 * * 1-5 站会汇总       # 工作日早 9 点（5 段标准 cron，不到秒）
```

**关键约束与行为**：

- 每个 session 同一时刻只允许一条定时消息；重设直接覆盖（不用先 cancel）
- 设置时要求当前 IM 群已绑定一个 session；触发时通过 registry 找 sessionId（自动跟随 Claude session 漂移）
- **重启零漂移**：触发时间是绝对时间戳，daemon 重启时按"剩余 ms"重新挂载 setTimeout
- **错过窗口**：一次性（at/in）daemon 恢复后立即触发并标延迟分钟；周期性（cron）跳过本次按下次正常算
- 触发回执发到原创建 chat（不论当前绑定状态）；AI 输出按当前活跃绑定路由（无绑定则只写日志）

**管理（无需绑定即可调用）**：

```
/at list                  # 列出全部定时消息
/at cancel <对话名>       # 远程取消任意对话的
/at cancel                # 取消当前绑定对话的
```

存储位置：`~/.im2cc/data/schedules.json`。

## 反茄钟

`反茄钟` 是一个为了“更专注地玩”而设计的全局节律模式：

- 开启后进入 `5 分钟工作 / 30 分钟休息` 的循环
- 休息期里，电脑上的 AI 会继续工作，但返回结果会被拦住，到下一个工作窗口再送达
- 休息期每轮只允许 1 条后台指令；这条指令会正常发给电脑，但结果同样会延迟
- 第 2 条及之后的休息期消息会被直接拒绝，不缓存
- 这个模式是全局共享的：飞书、微信、不同对话共用同一个开关和计时
- 手机端和电脑端都能开启，但只能在电脑端关闭；回到电脑端执行 `fc` / `fn` 这类本地接回动作时也会自动关闭

### 可选：本地 Claude 启动器覆盖

默认情况下，`im2cc` 会直接调用系统里的 `claude` 命令，这也是开源用户的默认路径。

如果你在自己电脑上有一个本地 Claude 启动脚本，想让 `fn` 创建 Claude 对话前先弹出“选择渠道 / profile”的菜单，可以在 `~/.im2cc/config.json` 里额外加一项：

```json
{
  "claudeLauncher": "~/claude-start.sh"
}
```

启用后：

- 仅你的本机会改为调用这个脚本；未配置该项的用户行为完全不变。
- 电脑终端里的 `fn <名称>` 会先让你选择 profile，再创建 Claude 对话。
- 同一个 session 后续的发送、恢复也会沿用这次选择的 profile。
- 飞书/微信里的 `/fn` 默认会被拒绝（IM 端没有 TTY 无法弹菜单）。如果希望 IM 端也能创建 Claude 对话，可以再加一项：

  ```json
  {
    "claudeLauncher": "~/claude-start.sh",
    "imDefaultClaudeProfile": "official"
  }
  ```

  `imDefaultClaudeProfile` 指定 IM 端非交互启动时使用的 profile（你的 launcher 会通过 `IM2CC_CLAUDE_PROFILE` 环境变量收到这个值，跳过菜单直接用）。电脑终端的交互行为不受影响。

## 安全与隐私

im2cc 完全在你自己的电脑上运行，你的代码和对话内容不会经过任何第三方服务器。飞书和微信仅用于传递消息文本。

### 安全模型

im2cc 把 IM 消息等效于本地终端命令，因此有两层保护：

1. **谁能用（认证层）**：`allowedUserIds`（IM 用户白名单）限制只有你自己能发指令给 Bot——这是 im2cc 真正的认证边界，`im2cc secure` 配置。
2. **AI 能做什么（授权层）**：由各 AI 工具自身的 permission mode 决定。YOLO/bypassPermissions 模式下 AI 对文件系统无限制；auto/acceptEdits 模式下工具层会弹确认。

**重要**：im2cc 不做"路径白名单"式的沙箱——AI 启动后可用绝对路径访问机器上任意文件，路径限制给不了真正的安全保护。如果你用的是 YOLO/bypass 模式，请务必设置 `allowedUserIds` 并把 Bot 放在只有你自己能访问的 IM 会话里。

首次使用建议先用只有你自己的飞书群或微信会话验证完整链路。

## 常见问题

**飞书群里有多个人，消息会冲突吗？**
> 首次使用不建议直接放进多人群。更稳妥的方式是先用只有你自己的飞书群或微信会话跑通完整链路，再决定是否扩展到多人场景。

**在手机上操作时，电脑上的工具会怎样？**
> im2cc 保证同一时刻只有一个端在操控当前对话。当你在手机上接入对话时，电脑端会自动断开。回到电脑端接回时，飞书会收到通知；微信受平台限制，不保证总能主动推送提醒。不会出现两边同时操作导致冲突的情况。
>
> 特殊情况：如果你切回电脑端 `fc` 时，IM 端还有一个任务正在执行，电脑端不会立即进 tmux 而是进入"接回保护态"——显示一个监控面板等任务结束（或按 Ctrl-C 主动取消该任务再进入）。这是为了避免你刚接回就被 IM 端任务的输出打断。

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
im2cc secure             # 配置 IM 用户白名单
im2cc doctor             # 环境检查
im2cc install-shell      # 写入 fn/fc/fl 终端命令
im2cc install-hook       # 写入 Claude Code session 同步 hook
im2cc install-service    # 安装 macOS 开机自启
im2cc update             # 更新到最新 (npm i -g im2cc@latest + 重启 daemon)
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

## 从源码开发（贡献者）

如果你想修改 im2cc 源码、提 PR，走 npm link 工作流：

```bash
git clone https://github.com/JVever/im2cc.git
cd im2cc
bash install.sh              # npm install + npm run build + npm link
im2cc install-shell          # 写入终端命令
im2cc install-hook           # 写入 Claude hook
im2cc onboard
```

之后改 `src/*.ts` → `npm run build` → 重启 daemon 即可。想回到 npm 分发版：`npm unlink -g im2cc && npm i -g im2cc`。

## 许可证

[GPLv3](LICENSE) — 使用本项目的衍生作品必须同样以 GPLv3 开源。
