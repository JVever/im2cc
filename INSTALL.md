# im2cc 安装指南（AI coding tool 执行用）

> 本文件供 Claude Code / Codex / Kimi Code / Gemini CLI 读取并自动执行安装。用户不需要手动操作本文件中的步骤。

## 安装步骤

请按顺序执行以下步骤。每一步如果遇到问题，请自行诊断并解决后继续。

### 1. 检查并安装前置依赖

检查以下工具是否可用，不可用的请安装：

- **Node.js >= 20**：运行 `node -v` 检查。如果未安装或版本过低，macOS 用 `brew install node`，Linux 用 `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`，或使用 nvm。
- **tmux**：运行 `tmux -V` 检查。如果未安装，macOS 用 `brew install tmux`，Linux 用 `sudo apt install tmux`。
- **至少一个 AI coding tool CLI**：`claude` / `codex` / `kimi` / `gemini` 至少安装一个；如果用户计划完整使用多工具流转，则四个都建议检查。安装后确认对应 CLI 已登录或完成鉴权。

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
fc()       { im2cc connect "$@"; }
fl()       { im2cc list; }
fk()       { im2cc delete "$@"; }
fd()       { im2cc detach; }
fs()       { im2cc show "$@"; }
fn-codex() { im2cc new --tool codex "$@"; }
fn-kimi()  { im2cc new --tool kimi "$@"; }
fn-gemini(){ im2cc new --tool gemini "$@"; }
```

**注意**：添加前先检查是否已经存在 `im2cc new` 的行，避免重复。如果存在旧格式（`source` 外部文件），先删除旧行再添加新格式。

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
1. 告知用户需要在 [飞书开放平台](https://open.feishu.cn/) 创建一个自建应用
2. 应用需要添加「机器人」能力
3. 需要申请以下权限：`im:message`、`im:message:send_as_bot`、`im:message.group_msg:readonly`、`im:message.group_at_msg:readonly`、`im:chat:readonly`、`im:resource`
4. 获取 App ID 和 App Secret 后，运行 `im2cc setup` 输入凭证
5. 把 Bot 添加到一个飞书群中

**微信设置**：
1. 确认用户的微信已开启 ClawBot 插件（设置 → 插件 → ClawBot）
2. 运行 `im2cc wechat login`，会在终端显示 QR 码
3. 让用户用微信扫码

### 6. 启动并验证

```bash
im2cc start
im2cc doctor
```

告知用户在飞书群或微信中发送 `/fl` 测试。如果能看到对话列表，说明安装成功。

### 7. 教用户基本操作

安装完成后，简要告诉用户：
- 在电脑上用 `fn <名称> <项目路径>` 创建对话
- 如果要指定工具，用 `fn --tool codex|kimi|gemini <名称> <项目路径>`
- 离开电脑后在飞书/微信中用 `/fc <名称>` 接入
- 回到电脑后用 `fc <名称>` 接回
- 用 `fl` 查看所有对话
