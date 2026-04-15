# im2cc 安装指南（AI coding tool 执行用）

> 本文件供 Claude Code / Codex / Gemini CLI 读取并自动执行安装。用户不需要手动操作本文件中的步骤。

## 核心流程

im2cc 通过 npm 全局包分发。主路径只有两行：

```bash
npm i -g im2cc
im2cc onboard
```

`im2cc onboard` 会把 `fn / fc / fl` 等终端命令自动写入 `~/.zshrc`，把 Claude Code session-sync hook 自动写入 `~/.claude/settings.json`，然后引导用户完成 IM 接入、首次会话、开机自启、安全加固。

## 前置依赖

执行前确认：

| 依赖 | 检查 | macOS 安装 |
|------|------|-----------|
| Node.js >= 20 | `node -v` | `brew install node` |
| tmux | `tmux -V` | `brew install tmux` |
| 至少一个 AI CLI | `which claude codex gemini` | Claude: https://docs.anthropic.com/en/docs/claude-code；codex / gemini 按各自官方文档 |
| npm 全局目录有写权限 | `npm config get prefix` | 若指向 `/usr/local` 且无权限，设置 `npm config set prefix ~/.npm-global` 并把 `~/.npm-global/bin` 加到 `$PATH` |

## 安装执行顺序

### 1. 装 im2cc

```bash
npm i -g im2cc
```

如果权限不足：

- 推荐：`npm config set prefix ~/.npm-global`，在 `~/.zshrc` 加 `export PATH="$HOME/.npm-global/bin:$PATH"`，重开终端，再 `npm i -g im2cc`
- 备选：`sudo npm i -g im2cc`

验证：`im2cc --version`（即 `im2cc help` 显示 Header）。

### 2. 进 onboard

```bash
im2cc onboard
```

onboard 内部会自动调用 `install-shell` 和 `install-hook`（幂等），然后进入 IM 接入引导。如果需要手动单独触发：

- `im2cc install-shell` —— 写入 fn/fc/fl 终端命令到 `~/.zshrc`
- `im2cc install-hook`  —— 写入 Claude Code SessionStart hook

### 3. 接通 IM

询问用户想用飞书还是微信。

**飞书**：
1. 先检查是否已有可复用的飞书 Bot 与凭证
2. 如果没有且环境里有 `$create-feishu-bot` skill，优先调用它
3. 否则手动流程：在 [飞书开放平台](https://open.feishu.cn/) 创建自建应用，申请权限 `im:message` / `im:message:send_as_bot` / `im:message.group_msg:readonly` / `im:message.group_at_msg:readonly` / `im:chat:readonly` / `im:resource`
4. 运行 `im2cc setup` 输入 App ID / Secret，把 Bot 加进群

**微信**：
1. 用户的微信已开启 ClawBot（设置 → 插件 → ClawBot）
2. `im2cc wechat login` → 扫码绑定

### 4. 启动 daemon + 真实会话验证

```bash
im2cc start
```

让用户先 `cd` 到目标项目再：

```bash
fn demo
```

然后在 IM 中 `/fl` + `/fc demo`。看到对话且能接入 = 第一次成功。

### 5. Post-success 稳定化

完成第一次真实流转后立刻做：

```bash
im2cc install-service
launchctl load ~/Library/LaunchAgents/com.im2cc.daemon.plist
im2cc secure
im2cc doctor
```

## 如果 npm 没有 im2cc（暂时还没发布的场景）

如果 `npm i -g im2cc` 报 404，代表 npm 上还没有发布，回退到源码 bootstrap：

```bash
git clone https://github.com/JVever/im2cc.git
cd im2cc
bash install.sh          # npm install + build + link
im2cc install-shell
im2cc install-hook
im2cc onboard
```

## 教用户基本操作（完成后）

- 在电脑上：`fn <名称>`（在项目目录下）创建对话；`fc <名称>` 接回
- 在飞书/微信上：`/fc <名称>` 接入
- 查状态：`im2cc doctor`；查帮助：`im2cc help` 或 `fhelp`；IM 里 `/fhelp`
- 更新：`im2cc update`（等价于 `npm i -g im2cc@latest` + 重启 daemon）
- 安全加固：`im2cc secure`
