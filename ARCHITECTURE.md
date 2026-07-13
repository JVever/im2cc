# im2cc Architecture

> **维护者**：/cto。本文件由各 feature 的架构决策增量沉淀（见每个 feature 的 §Plan 段）。
> **首次创建**：2026-05-10，由 `@20260510-office-doc-relay` bootstrap。
> **不替代**：feature 级 §Plan（模块改动细节）、文件级头注释（@input/@output）、目录级 `_INDEX.md`（文件清单）。本文件只沉淀**全局约束 + 跨 feature 模式**。

---

## 1. 系统架构概览

```
┌─────────────────────┐         ┌─────────────────────┐
│  IM 层 (Transport)  │         │  工具层 (ToolDriver) │
├─────────────────────┤         ├─────────────────────┤
│ FeishuAdapter       │ ──────► │ ClaudeDriver        │
│ WeChatAdapter       │         │ CodexDriver         │
│ <未来>              │         │ GeminiDriver        │
└─────────────────────┘         └─────────────────────┘
       消息接收/回传                AI CLI 调用/会话管理
              │                              │
              └──────────► daemon ◄──────────┘
                          (单实例)
              │
              ▼
        ~/.im2cc/data/
        (registry / bindings / queue)
```

**两层抽象**（核心设计）：

| 抽象 | 接口 | 职责 |
|---|---|---|
| **TransportAdapter** | `src/transport.ts` | IM 通道：消息接收/发送/资源下载 |
| **ToolDriver** | `src/tool-driver.ts` | AI 工具：session 创建/恢复/消息发送/中断 |

**BaseToolDriver** (`src/base-driver.ts`) 提供通用 tmux 管理 / 进程中断 / 流式输出解析，三个 driver 继承复用。

新增 IM 通道或 AI 工具只需实现对应接口，核心代码零改动。

---

## 2. 核心技术栈

| 层 | 选型 | 选型理由 |
|---|---|---|
| 运行时 | Node.js >= 20 | TypeScript 原生支持；macOS 全局可用 |
| 语言 | TypeScript (ESM) | 与 Node 生态无缝 + 类型安全 |
| 守护 | macOS LaunchAgent | 系统级开机自启；用户态无需 root |
| 进程管理 | tmux | 用于 AI CLI 交互式 session 的容器（CLI 端用） |
| 飞书 SDK | `@larksuiteoapi/node-sdk` | 官方 SDK；已支持双域名 fallback (open.feishu.cn ↔ open.larksuite.com) |
| 微信 | ClawBot iLink (REST) | 第三方 bot 协议；无官方 IM 通道 |
| 配置 | JSON 文件 (~/.im2cc/) | 无 DB 依赖；原子写 + chmod 0600 |

**OS 限定**：仅 macOS（package.json `"os": ["darwin"]`）。

---

## 3. 数据存储

```
~/.im2cc/
├── config.json              # 飞书凭证、白名单、默认参数（chmod 0600）
├── wechat-account.json      # 微信 bot token (chmod 0600)
├── data/
│   ├── registry.json        # 命名 session 注册表（registry 是 session 身份的唯一权威）
│   ├── bindings.json        # IM ↔ session 绑定（transport + tool 感知）
│   ├── poll-cursors.json    # IM 消息轮询游标
│   ├── pending.json         # 待处理消息队列
│   ├── schedules.json       # 定时消息（at/in/cron）
│   └── inflight/            # 执行中任务的持久化 snapshot
└── logs/                    # daemon 日志

<project-cwd>/.im2cc-inbox/   # IM 上传文件的暂存目录（chmod 0600 + .gitignore + TTL 清理）
```

---

## 4. 架构红线（硬规则）

下列约束跨整个 daemon 生命周期生效，任何 feature 的 §Plan 不得违反。

### 4.1 daemon 单实例不变量
任何时刻只能有一个 daemon 进程。三层纵深防御：
- 启动时杀僵尸（`im2cc start` 内部）
- 运行时自检（每分钟一次 PID 校验）
- lock 文件（`~/.im2cc/daemon.pid`）
> 历史教训：2026-03-24 修复的最严重 bug 来自双 daemon 并发写 registry，导致 session 漂移。

### 4.2 registry 是 session 身份的唯一权威
- tmux session 命名只是进程管理标签，**不是身份**
- 所有 session lookup / 路由 / 绑定切换都必须通过 `registry.ts`
- /fc /fn /fk 等命令都依赖 registry 派生
- **tmux session 引用必须精确匹配**：所有 `tmux ... -t <name>` 调用必须用 `-t =<name>` 语法强制禁用 prefix match。否则当 session 名互为前缀时（如 `im2cc` / `im2cc01`），prefix match 会让前者命中后者，造成 has-session 误判、kill-session 误杀、attach 切到错的 session 等连锁问题。引入：`@20260512-fc-tmux-client-preempt` (2026-05-12)

### 4.3 独占访问
同一 session 同一时刻只能在一个端使用（电脑 tmux / 飞书 / 微信三端互斥），由 binding 机制保证。

### 4.4 mode-policy 是模式定义的唯一真相源
权限模式必须使用各工具 CLI 的原生名称（如 Claude `acceptEdits` / Codex `auto-edit`），**不自定义模式名**。所有映射在 `src/mode-policy.ts`。

### 4.5 非交互模式约束
daemon 通过 `claude -p` / `codex exec` 等非交互 flag 调用工具 CLI。**Plan 模式在此场景下不可用**——任何依赖 stdin 交互的 AI 能力都得换实现路径。

### 4.6 后台任务必须 CRUD 五件套
所有持久化的后台任务（schedule / cron / 订阅 / timer）必须提供 list / show / cancel / update / 触发回执，不只是创建入口。
> 历史教训：把存储约束误当交互模型，造成"任务建了找不回"。

### 4.7 远程交互的反向桥接强制（与 §4.5 互补）
**引入**：`@20260510-im-askuserquestion-bridge` (2026-05-10)

AI 工具在远程执行（IM 端经 daemon 调用）时若调用反向交互工具（典型代表：Claude 的 `AskUserQuestion`），不允许直接暴露非交互失败给用户——daemon 必须通过工具自身的 hook / 拦截机制接管，要么桥接到 IM 端，要么用注入答案优雅降级。

具体落实在该 feature §Plan：Claude PreToolUse hook + 本地 unix socket + 飞书 interactive 卡片 / 微信文本降级。

**约束**：
- 不允许"daemon 直接吞错让任务静默失败"
- 不允许"让 AI 看到工具不可用错误自行重试"导致循环
- 任何新增反向交互工具（未来若出现 AskUserPermission 等）必须按本红线套路接管

### 4.9 远程执行的工具调用进度反馈 (与 §4.7 互补)
**引入**: `@20260512-im-tool-call-progress` (2026-05-12)

远程执行 (IM 端经 daemon 调用) 的 AI 工具调用过程必须对 IM 用户有进度可见性,避免"冒号收尾空白" / "AI 卡壳" 误判:

- 短 turn 内 (单 tool 调用 < 10s) 的 tool_use 边界由 daemon **透明合并** AI 文本输出,用户感知不到工具调用
- 长 tool_use (≥ 10s 阈值,默认值,可在 config.toolCallStatus.statusThresholdMs 覆盖) 必须发**状态消息**给 IM,避免用户判 daemon 失联
- 整个 turn 内最多发 **1 条状态消息**,避免轰炸
- daemon 不允许直接转发工具 raw stdout (与 §4.5 互补)

具体落实在 `src/turn-aggregator.ts` 状态机:`buffering / tool_running / turn_end` 三态 + debounce 1.5s + threshold 10s。

**约束**:
- 与 §4.7 反向交互桥接 (AskUserQuestion) 共同构成 "im2cc 端到端工具调用透明度"
- AskUserQuestion 走 PreToolUse hook 绕过 base-driver,aggregator 显式跳过 name='AskUserQuestion' 的 tool_use,与 §4.7 互不冲突
- 任何新增 AI 工具 driver 必须接入 onTurnEvent 事件流,不能只发 raw text

### 4.10 远程执行的 side fork 旁路讨论
**引入**: `@20260513-im-btw-side-fork` (2026-05-13)

远程执行的 `/btw` 类 side fork 命令——基于主对话上下文做一次独立讨论但不污染主 session——必须遵守如下生命周期红线:

- **隔离**: fork session 文件用独立 UUID,与主 `binding.sessionId` **完全分离**（同 cwd 的 `~/.claude/projects/<slug>/` 目录,但文件名 UUID 不同）
- **只读主**: 主 `binding.sessionId.jsonl` 在整个 fork 过程中**只被 OS 层 cp 读取,任何 driver 不写入**
- **生命周期 = turn**: fork 文件创建于 `handleBtw` 入口,清理于 turn finally 路径（成功 / 失败 / cancel 都清）
- **驱动统一**: fork turn 必须走 `driver.sendMessage` 标准接口,不绕过 base-driver / queue / aggregator / askuser-bridge
- **不进 registry**: fork sessionId 不注册到 registry,不写入 binding,daemon 重启不恢复
- **V1 仅 Claude**: Codex thread 模型与 JSONL 文件 fork 不同构,V1.x+ 调研
- **工具限制硬约束** (2026-05-13 REVISION): fork turn driver 调用必须含 `--disallowed-tools` 参数,
  禁用 `Edit / Write / NotebookEdit / Bash / Task / TodoWrite / AskUserQuestion / SlashCommand`。
  保证 fork turn **不仅对话历史隔离,工作目录文件系统也无任何副作用**。具体列表定义在
  `src/queue.ts BTW_DISALLOWED_TOOLS` 常量。
  对齐 Claude REPL `/btw` 的"无损"承诺,但保留只读工具 (Read/Grep/Glob/WebFetch/WebSearch)
  以满足 IM 端"现场翻代码"的实用诉求 (Claude REPL 原生 /btw 完全无工具,我们略宽松)

具体落实在 `src/claude-driver.ts` 的 `forkSession()` + `deleteForkSession()` + `src/commands.ts handleBtw()`。

**约束**:
- 与 §4.2 "registry 是 session 身份唯一权威" 不冲突: fork session 不进 registry
- 与 §4.7 / §4.9 兼容: AskUserQuestion / tool 进度都按标准走 driver 流程,fork turn 自然继承
- daemon queue 同 conversation 仍单线程: /btw 与主对话 turn 排队执行,不引入真并发（与 Claude REPL 原生 /btw 的并发语义有差距,接受）

### 4.8 Gemini 进入维护模式
**引入**：2026-05-10（项目级决策，非单 feature）

Gemini 不再接受新功能开发，仅维持现有功能可用。原因：Gemini CLI 在远程交互场景下表现不稳定，长期投入 ROI 低。

**具体规则**：
- 新 feature 默认仅覆盖 Claude（+ Codex 视情况），Gemini 不在范围内
- 现有 Gemini 路径出现 bug 仍修，但不为 Gemini 增加新能力
- 相关 PR / spec 不再写"是否覆盖 Gemini"作为待确认项
- 若需彻底下线，单开 feature 走 abandonment 流程

### 4.11 Session 级可流转状态由 registry 所有

**引入**：`@20260510-im-slash-passthrough` 2026-07-13 REVISION

凡是用户期望随同一个命名 Session 在 Terminal、飞书、微信之间流转的状态，其 owner 必须是 `RegisteredSession` / registry；`Binding` 只拥有 transport conversation 与 Session 的临时连接关系。

模型选择的具体约束：

- registry 保存工具实际可执行的完整 `selectedModelId`，不以 `opus` 等会漂移的家族 alias 作为持久化真相
- registry 是最后一道精确 ID 门禁：Claude 已知家族 alias（含 `opus-4.8` 这类版本短名）必须先经 model catalog 映射为完整 ID，无法映射则拒绝；Fable 等自定义 provider 的原生完整 ID 不要求 `claude-` 前缀
- Terminal 与 IM 的模型切换都写同一个 Session 字段；queue 远程 turn 与 Terminal resume 都从该字段取值
- `/fs` 用状态角色而非“下一次 / 上一次”的伪时间轴区分两类事实：“当前选择的模型”来自 registry，表示 Session 持续生效的设置；“最近实际使用的模型”来自工具可验证的最近一次成功事实。Claude 以 assistant 响应模型为证据，Codex 仅以成功 turn 的有效 `turn_context.model` 为证据；不得把 Codex 上下文冒充 provider 响应 metadata
- binding 中历史 `modelOverride` 只允许作为迁移 fallback，不再接受新写入
- 底层 sessionId 因 `/clear` 等轮换时，命名 Session 的模型选择保留
- 已开始的 turn 同时快照模型 ID、`modelSelectionUpdatedAt` 与启动前的最近工具事实 identity；成功后仅当 watermark 未变且出现了不同于 baseline 的新事实时，才 compare-and-set 校正。后到切换只影响下一 turn，也不得被旧 turn 的较晚完成时间或后续无新事实操作覆盖
- daemon、SessionStart hook、statusline observer 对 registry 的 read-modify-write 必须持有同一个跨进程 `registry.lock`；仅用 temp + rename 不能阻止 stale snapshot 覆盖
- 模型事件时间必须在等待写锁前产生，并在锁内与 `modelSelectionUpdatedAt` 比较；同值的新事件也要推进 watermark，周期 statusline 去抖只能在 observer 私有状态层完成
- `fc` 遇到已存在但实际模型与 Session 目标不同的 TUI 时，不能直接 attach；必须结束该 TUI，再用同一 sessionId 和精确 `--model/-m` resume
- statusline wrapper 的 next/fallback 链必须防第三方重装闭环：若第三方 leaf 已回指 im2cc observer，重装时保留此前安全 leaf 或降级为空，并对递归 fallback 设置硬上限
- `/compact` 等成功但不产生 assistant/turn 模型事实的控制操作不得触发模型校正；不能复用启动前的旧 observation

Claude 可用 statusline 的 `model.id` 在回复前观测 Terminal 选择，并从 assistant 记录读取实际响应模型。Claude assistant timestamp 是完成时间，惰性 `/fs` 不得用它覆盖已有显式选择；仅 daemon 自己持有 turn-start watermark 时可在成功后 CAS 校正。Codex 只认最近 `task_complete` 对应 turn 的 `turn_context.model`，并需反向分块扫描以覆盖长 turn；`turn_context` timestamp 是 turn 启动时间，因此外部 Terminal 成功 turn 可按该时间有序吸收，旧 turn 会被更新的 selection watermark 拒绝。它证明的是成功 turn 的有效执行上下文，不证明 provider 内部 response fallback/rewrite。未完成/失败 turn 不得更新最近成功模型状态。新增工具若要实现即时 Terminal → IM 同步，必须提供同等级的可验证模型状态事件，不能解析 UI 文本猜测。

---

## 5. 跨 Feature 模式

### 5.1 ToolCapabilities-Driven 文件处理策略
**引入**：`@20260510-office-doc-relay` (2026-05-10)

**问题**：不同 AI 工具对二进制文档（pdf/docx/xlsx/pptx）的处理能力不对称——Claude 自带 Anthropic document-skills plugin；Codex/Gemini 只能靠 prompt 引导自行 spawn 外部工具（pandoc / python / pdftotext 等）。

**模式**：在 `ToolCapabilities` 接口上声明文件处理能力，daemon 按 capability 选择 prompt 模板。

```typescript
interface ToolCapabilities {
  // ... 已有字段
  officeDocStrategy: 'native' | 'prompt-template'
}
```

| 策略 | 含义 | 当前 driver |
|---|---|---|
| `'native'` | 工具自带 skill/能力 | Claude（依赖 document-skills plugin）|
| `'prompt-template'` | 靠 prompt 引导工具自行 spawn 外部命令 | Codex / Gemini |

**Daemon 职责边界**：
- ✅ 仅做"必需的归一化"（如旧格式 .doc/.xls/.ppt 用 soffice 升格为新格式）
- ✅ 按 driver capability 注入不同 prompt 模板（统一在 `src/attachment-prompt.ts`）
- ❌ 不做"读懂内容"的工作（这是 AI 端职责）
- ❌ 不做工具链自检 / 自动安装（依赖管控由 AI 闭环：缺工具时 AI 在 IM 端引导用户安装）

**扩展规则**：
- 新增文件类型（如 epub、odt） → 在 `src/file-staging.ts` 扩白名单 + 决定是否需要 daemon 归一化
- 新增 driver → 实现 ToolCapabilities 时必须显式声明 `officeDocStrategy`，不允许 default
- prompt 模板话术变更 → 集中改 `src/attachment-prompt.ts`，不允许在 `index.ts` 散落 hardcode

### 5.2 IM 端文件暂存机制
**引入**：早于 V4.0（2026-04 之前；本节为追溯文档化）

文件从 IM 落地到 AI 工具的统一路径：
1. `TransportAdapter.downloadMedia()` 下载到 `<binding.cwd>/.im2cc-inbox/<messageId>.<ext>`（chmod 0600 + 目录自带 `.gitignore`）
2. `stageFile()` 暂存到 per-chat 内存队列
3. 用户下一条文本指令到达时，`consumeStaged()` 取出文件路径拼入 prompt
4. `runInboxCleanup()` 按 `inboxTtlMinutes` 周期清理过期文件

新增 IM 通道时，**必须实现 `downloadMedia`**；不实现则该通道不支持文件传输。

### 5.3 IM 反向交互桥接（PreToolUse hook + IPC + 文本编号）
**引入**：`@20260510-im-askuserquestion-bridge` (2026-05-10)
**V1 spec 修订**：2026-05-11（飞书 interactive 卡片改走文本编号；详见 feature revision）

**问题**：AI 工具（典型 Claude）在远程模式下调用 `AskUserQuestion` 等反向交互工具时，stdin 不可达，daemon 默认场景下任务会卡住或 AI 无限重试。

**模式**：在工具自身的 PreToolUse hook 中拦截目标工具，通过本地 IPC（unix socket）与 daemon 沟通，daemon 渲染**统一文本格式**到 IM 端等待用户回复，回填 hook 让工具调用直接拿到"答案"。

```
AI 调用 AskUserQuestion
    │
    ▼
Claude PreToolUse hook (hooks/askuser-hook.mjs，由 daemon 注入临时 settings.json)
    │  ↕ unix socket (~/.im2cc/sockets/askuser.sock，权限 0700/0600)
    ▼
daemon askuser-bridge.ts
    │
    ▼ TransportAdapter.sendMessage(InteractiveCardMessage) → 内部降级 buildAskUserText 文本
    │
    ▼
IM 端用户（飞书 + 微信完全一致格式）
    │
    ▼ 用户回 "1" / "JavaScript" / 自由文本（普通 text 路径）
    │
    ▼
daemon handleMessage 检测当前 binding session 有 pending askuser → submitAnswerByToolUseId 注入
    │
    ▼ socket → hook → hookSpecificOutput.updatedInput.answers
    ▼
AI 收到"工具调用成功+答案"，继续推进
```

**关键约束**：
- hook 命令默认超时 600s（10 分钟）—— **远程交互超时不可超 9 分钟**（默认 8）
- 用 `permissionDecision: "allow" + updatedInput.answers` 回填，不用 `deny`（避免 AI 重试循环）
- 超时降级：`answers` 注入 `[已超时] 用户未回复，请基于当前信息做合理假设并标注`，不让 AI 误以为是用户真实回答
- daemon 重启 → Claude 进程随之死亡 → 复用 §inflight recovery 提示，不另造持久化
- V1 飞书与微信都不依赖事件订阅 push（项目现有 REST 轮询模式不变）

**扩展规则**：
- 飞书 + 微信：统一文本格式（信息架构五要素：🤔 标识 / 问题 / 1) 2) 3) 编号选项 / ✏️ Other 入口 / ⏱ 超时提示）
- transport 接收 `InteractiveCardMessage` 时内部降级 `buildAskUserText` 文本，调用方不感知
- 新增 IM 通道：若想支持真按钮，需自建事件订阅子系统并实现 `kind:'card_action'` 路由；否则文本降级即可
- 未来新增反向交互工具（如 AskUserPermission），复用本架构，仅在 hook matcher 上加目标工具名

**V1.x 升级方向（不在 V1 范围）**：
- 飞书 WSClient 长连接订阅 `card.action.trigger` 实现真"点按钮 + 卡片 update 已收到"体验
- 评估前提：心跳/重连/错过事件补偿成本可接受

---

## 6. 验证管线

```bash
npm run build                                      # TypeScript 编译
node scripts/mode-policy.test.mjs                  # 模式映射测试
node scripts/tool-cli-args.test.mjs                # CLI 参数构造测试
node scripts/support-policy.test.mjs               # 支持矩阵测试
node scripts/office-upgrader.test.mjs              # office 升格测试 (@20260510-office-doc-relay)
bash scripts/smoke.sh                              # 端到端冒烟（需活跃 daemon + IM 凭证）
```

任何 §Plan 引入的新模块都应在此追加对应单测脚本。

---

## 修订记录

| 日期 | feature | 变更 |
|---|---|---|
| 2026-05-10 | @20260510-office-doc-relay | bootstrap ARCHITECTURE.md；引入 §5.1 ToolCapabilities-driven 文件处理策略；追溯文档化 §5.2 IM 文件暂存机制 |
| 2026-05-10 | @20260510-im-askuserquestion-bridge | 引入 §4.7（远程交互反向桥接强制，与 §4.5 互补）；§4.8（Gemini 维护模式，项目级决策）；§5.3（IM 反向交互桥接架构：PreToolUse hook + IPC + transport 卡片） |
| 2026-05-11 | @20260510-im-slash-passthrough | 无新红线 / 跨 feature 模式；spike 实证 `-p` / `exec` 非交互模式下纯"工具内置斜杠命令透传"不可行（仅 Claude /compact 例外）；feature 在 commands.ts 实现"会话控制 alias 层"——/clear /compact /model /status 注册为 im2cc 命令；详见 docs/features/20260510-im-slash-passthrough.md §Plan |
| 2026-05-13 | @20260513-im-btw-side-fork | 引入 §4.10（远程执行 side fork 旁路讨论生命周期红线，与 §4.2 / §4.7 / §4.9 兼容）；spike 端到端实证：`claude -p --resume <fork_id>` 接受 cp 出的 fork session 文件 + 完整继承主对话上下文 + 只写 fork 文件不污染 baseline + 文件名/内部 sessionId 字段不一致仍 work；范式为"OS 层 cp + driver 标准调用 + finally 清理"；详见 docs/features/20260513-im-btw-side-fork.md §Plan |
| 2026-05-13 | @20260513-im-btw-side-fork REVISION | §4.10 加"工具限制硬约束"——fork turn 必须经 driver `--disallowed-tools` 禁用 Edit/Write/NotebookEdit/Bash/Task/TodoWrite/AskUserQuestion/SlashCommand，保证不污染工作目录文件系统；对齐 Claude REPL /btw 无损承诺，保留只读类工具以满足 IM 端实用诉求 |
| 2026-07-13 | @20260510-im-slash-passthrough REVISION | 引入并复审 §4.11：跨 Terminal / IM 状态归 registry；模型以完整 `selectedModelId` 共享，binding 仅作迁移；所有 registry 写方共用跨进程锁和事件 watermark；Codex 只从成功完成 turn 反向取模型；TUI 模型不一致时精确 resume |
