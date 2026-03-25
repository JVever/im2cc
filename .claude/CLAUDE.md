# im2cc — IM to Claude Code

通过飞书/微信远程操控本地 AI 编程工具（Claude Code、Codex、Gemini），电脑/手机无缝流转。

TypeScript + Node.js，~30 个源文件，macOS LaunchAgent 守护进程。

## 1. 文档阅读策略

### L0 — 必读（每次任务开始）
- **PROJECT.md** — 架构概览、设计决策、命令系统、技术栈
- **目标目录的 `_INDEX.md`** — 了解要修改的目录的文件清单和职责

### L1 — 按需读取
| 文档 | 何时阅读 |
|------|---------|
| `src/_INDEX.md` | 修改 src/ 下任何文件前 |
| `bin/_INDEX.md` | 修改 CLI 入口时 |
| `shell/_INDEX.md` | 修改 shell 命令或 hooks 时 |
| 目标文件的头注释 `@input/@output` | 修改该文件前 |

### L2 — 深入时
- 直接读源码。项目不大（~30 文件），核心逻辑集中在 `src/` 目录。

## 2. 架构核心（不需要读源码就能理解）

```
IM 层（TransportAdapter）     工具层（ToolDriver）
┌────────────────────┐    ┌────────────────────┐
│ 飞书  FeishuAdapter │───►│ Claude ClaudeDriver│
│ 微信  WeChatAdapter │    │ Codex  CodexDriver │
└────────────────────┘    │ Gemini GeminiDriver│
                          └────────────────────┘
```

- **TransportAdapter**（`transport.ts`）：IM 通道接口
- **ToolDriver**（`tool-driver.ts`）：AI 工具接口，BaseToolDriver 基类提供通用 tmux/中断/流式解析
- **消息流**：IM 消息 → `index.ts` 路由 → `commands.ts` 命令解析 → `queue.ts` 任务排队 → driver.sendMessage → CLI `-p` 非交互执行 → 输出回传 IM

## 3. 架构红线

- **daemon 单实例不变量** — 任何时刻只能有一个 daemon 进程，三层纵深防御（启动杀僵尸 + 运行时自检 + lock 文件）
- **registry 是 session 身份的唯一权威来源** — tmux session 命名只是进程管理标签，不是身份
- **独占访问** — 同一 session 同一时刻只能在一个端使用（电脑/飞书/微信互斥）
- **mode-policy.ts 是模式定义的唯一真相源** — 权限模式使用各工具 CLI 原生名称，不自定义
- **非交互模式** — daemon 通过 `-p` flag 调用工具 CLI，Plan 模式在此场景下不可用

## 4. 关键文件速查

| 要改什么 | 读什么文件 |
|---------|----------|
| 命令（/fn /fc /mode 等） | `src/commands.ts` |
| 权限模式 | `src/mode-policy.ts` |
| Claude/Codex/Gemini 调用 | `src/*-driver.ts` |
| 消息队列 | `src/queue.ts` |
| IM 消息接收 | `src/feishu.ts` 或 `src/wechat.ts` |
| CLI（终端命令） | `bin/im2cc.ts` |
| Shell 命令（fn/fc/fl） | `shell/im2cc-shell-functions.zsh` |
| Session 绑定 | `src/session.ts` + `src/registry.ts` |
| 配置 | `src/config.ts`，数据在 `~/.im2cc/` |
| 守护进程生命周期 | `src/index.ts` + `src/daemon-process.ts` |

## 5. 验证

```bash
npm run build        # TypeScript 编译
node scripts/mode-policy.test.mjs
node scripts/tool-cli-args.test.mjs
node scripts/support-policy.test.mjs
```
