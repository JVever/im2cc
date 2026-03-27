# im2cc 安装指南（AI coding tool 执行用）

> 本文件供 Claude Code / Codex / Gemini CLI 读取并自动执行安装。用户不需要手动操作本文件中的步骤。完成仓库 checkout 后，也应继续读取仓库根目录的 `AGENTS.md` 和 repo-local onboarding instructions。

## 安装步骤

请按顺序执行以下步骤。每一步如果遇到问题，请自行诊断并解决后继续。

## 0. 获取仓库

`im2cc` 是公开仓库。获取代码时：

- 优先使用普通 HTTPS clone：`git clone https://github.com/JVever/im2cc.git ~/im2cc`
- 不要优先使用 `gh repo clone`
- 不要依赖需要 GitHub 登录态的 API / MCP / 集成
- 如果 clone 失败，但普通 HTTPS 下载仍可用，使用源码包 fallback：

  ```bash
  mkdir -p ~/im2cc
  curl -L https://codeload.github.com/JVever/im2cc/tar.gz/refs/heads/master | tar -xz -C ~/im2cc --strip-components=1
  ```

- 如果 clone 和源码包下载都失败，先检查 `git` 是否安装、网络是否可达 `github.com`
- 只有在网络受限、代理缺失或本机 Git 不可用时，才向用户求助

不要因为 `gh` 未登录就判断“无法安装”。

### 1. 检查并安装前置依赖

检查以下工具是否可用，不可用的请安装：

- **git**：运行 `git --version` 检查。如果未安装，macOS 可用 Xcode Command Line Tools 或 Homebrew，Linux 用系统包管理器安装。
- **Node.js >= 20**：运行 `node -v` 检查。如果未安装或版本过低，macOS 用 `brew install node`，Linux 用 `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`，或使用 nvm。
- **tmux**：运行 `tmux -V` 检查。如果未安装，macOS 用 `brew install tmux`，Linux 用 `sudo apt install tmux`。
- **至少一个 AI coding tool CLI**：`claude` / `codex` / `gemini` 至少安装一个；如果用户计划完整使用多工具流转，则三者都建议检查。安装后确认对应 CLI 已登录或完成鉴权。

如果 macOS 上 `brew` 不可用，先安装 Homebrew：`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`

### 2. 编译和注册

```bash
cd ~/im2cc       # 或用户指定的安装目录
npm install
npm run build
npm link          # 如果权限不够，用 sudo npm link
```

验证：运行 `im2cc doctor`，确认能正常输出。

### 3. 配置终端命令

在用户的 shell 配置文件（~/.zshrc 或 ~/.bashrc）中添加以下内容：

```bash
# im2cc 命令
fn()       { im2cc new "$@"; }
fn-codex() { im2cc new --tool codex "$@"; }
fn-gemini(){ im2cc new --tool gemini "$@"; }
fc()       { im2cc connect "$@"; }
fl()       { im2cc list; }
fk()       { im2cc delete "$@"; }
fd()       { im2cc detach; }
fs()       { im2cc show "$@"; }
```

**注意**：添加前先检查是否已经存在 `im2cc new` 的行，避免重复。如果存在旧格式（`source` 外部文件），先删除旧行再添加新格式。
其中：
- `fn-codex <名称> [路径]` 等价于 `fn --tool codex <名称> [路径]`
- `fn-gemini <名称> [路径]` 等价于 `fn --tool gemini <名称> [路径]`
- 这些只是终端快捷别名，IM 中仍然要用 `/fn ... --tool codex|gemini`

### 4. 安装 Session 同步 Hook

将 session 漂移同步 hook 安装到 `~/.claude/settings.json` 中。

读取现有的 `~/.claude/settings.json`（如果存在），在 `hooks.SessionStart` 数组中添加一个条目。注意 Claude Code hook 的格式是 `matcher` + `hooks` 数组结构：

```json
{
  "matcher": "",
  "hooks": [
    {
      "type": "command",
      "command": "<im2cc安装目录的绝对路径>/shell/im2cc-session-sync.sh"
    }
  ]
}
```

`matcher` 为空字符串表示匹配所有情况。

如果文件不存在，创建它。如果已有 `im2cc-session-sync` 相关条目，跳过。

### 5. 连接 IM

**询问用户**想用飞书还是微信（或两者都用）。

**飞书设置**：
1. 先检查用户是否已经有可复用的飞书 Bot 与凭证
2. 如果没有，且环境里可用 `$create-feishu-bot`，优先调用它自动完成创建、权限和验证
3. 如果没有该 skill，则回退到手动流程：在 [飞书开放平台](https://open.feishu.cn/) 创建自建应用，添加「机器人」能力，并申请以下权限：`im:message`、`im:message:send_as_bot`、`im:message.group_msg:readonly`、`im:message.group_at_msg:readonly`、`im:chat:readonly`、`im:resource`
4. 获取 App ID 和 App Secret 后，运行 `im2cc setup` 输入凭证
5. 把 Bot 添加到一个飞书群中

**微信设置**：
1. 确认用户的微信已开启 ClawBot 插件（设置 → 插件 → ClawBot）
2. 运行 `im2cc wechat login`，会在终端显示 QR 码
3. 让用户用微信扫码

### 6. 启动并验证消息链路

```bash
im2cc start
im2cc doctor
```

告知用户在飞书群或微信中先发送 `/help` 或 `/fl` 测试。这一步只验证消息链路，不代表完整安装已经结束。

### 7. 验证一次真实对话流转

在电脑端创建一个真实对话。优先让用户先 `cd` 到目标项目目录，再执行：

```bash
fn demo
```

如果当前目录不是目标项目目录，再显式传路径：

```bash
fn demo <项目路径>
fn-codex demo <项目路径>
```

然后让用户在飞书群或微信中执行：

```text
/fl
/fc demo
```

只有当用户能看到对话并成功接入后，才算完成第一次成功验证。

### 8. 配置开机自启动（推荐）

如果用户同意开启开机自启动，在 macOS 上执行：

```bash
im2cc install-service
launchctl load ~/Library/LaunchAgents/com.im2cc.daemon.plist
```

然后再次运行 `im2cc status` 或 `im2cc doctor` 验证。

### 9. 教用户基本操作

安装完成后，简要告诉用户：
- 在电脑上优先进入项目目录后运行 `fn <名称>`；只有不在项目目录时才写 `fn <名称> <项目路径>`
- 如果要指定工具，可以用标准写法 `fn --tool codex|gemini <名称> [项目路径]`，也可以在终端里用 `fn-codex` / `fn-gemini`
- 离开电脑后在飞书/微信中用 `/fc <名称>` 接入
- 回到电脑后用 `fc <名称>` 接回
- 用 `/help` 查看 IM 端命令说明
- 用 `fl` 查看所有对话
