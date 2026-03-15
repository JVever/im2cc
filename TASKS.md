# im2cc 任务清单

> 基于 4 轮多模型评审后的最终方案，按依赖顺序排列。
> 状态标记：⬜ 未开始 | 🔄 进行中 | ✅ 已完成 | ⏸️ 阻塞

---

## Phase 0: 项目基础设施

- [x] P0-1: 创建项目目录、git init
- [x] P0-2: 创建 PROJECT.md、TASKS.md、DEVLOG.md
- [ ] P0-3: 初始化 package.json + TypeScript 配置
- [ ] P0-4: 创建目录结构 (src/, bin/)
- [ ] P0-5: 配置 tsconfig.json, .gitignore
- [ ] P0-6: 安装依赖 (@larksuiteoapi/node-sdk, uuid)
- [ ] P0-7: 首次 git commit

## Phase 1: 配置与安全层 (无外部依赖，可独立测试)

- [ ] P1-1: config.ts — 配置加载
  - ~/.im2cc/config.json 读写 (0600 权限)
  - 飞书 App ID / App Secret
  - 允许的用户 ID 列表
  - 路径白名单 (默认 ~/Code/)
  - 默认权限模式 (默认 plan)
  - 默认超时 (默认 600s)
- [ ] P1-2: security.ts — 安全验证
  - 用户 ID 白名单检查
  - 路径验证: ~ 展开、绝对路径化、存在性检查、白名单匹配
  - 路径规范化 (resolve symlinks)
- [ ] P1-3: 单元测试 — 路径验证逻辑
- [ ] P1-4: git commit "feat: config and security layer"

## Phase 2: Session 绑定管理

- [ ] P2-1: session.ts — Binding 数据模型
  ```typescript
  interface Binding {
    id: string;              // 自生成 UUID
    feishuGroupId: string;
    cli: 'claude';
    sessionId: string;       // Claude Code session UUID
    cwd: string;             // 绝对路径
    permissionMode: string;
    cliVersion: string;
    turnCount: number;
    createdAt: string;
    lastActiveAt: string;
    archived: boolean;
  }
  ```
- [ ] P2-2: session.ts — CRUD 操作
  - createBinding(groupId, cwd) → Binding
  - getBinding(groupId) → Binding | null
  - updateBinding(groupId, partial)
  - archiveBinding(groupId) → 旧 Binding (供 /new 使用)
  - listActiveBindings() → Binding[]
- [ ] P2-3: session.ts — 原子写 (写临时文件 + rename)
- [ ] P2-4: session.ts — 消息去重 (Map<messageId, timestamp> + LRU 清理)
- [ ] P2-5: git commit "feat: session binding management"

## Phase 3: Claude Code 驱动

- [ ] P3-1: claude-driver.ts — createSession(cwd, mode)
  - 生成 UUID
  - spawn `claude -p "session initialized" --session-id <uuid> --output-format stream-json --verbose --permission-mode <mode>`
  - cwd 设为绑定目录
  - 解析 stream-json 确认成功
  - 返回 { sessionId, output }
- [ ] P3-2: claude-driver.ts — sendMessage(sessionId, message, cwd, mode)
  - spawn `claude -p <message> --resume <sessionId> --output-format stream-json --verbose --permission-mode <mode>`
  - 返回 AsyncIterable<CLIEvent>
  - 事件类型: init, assistant, result, error
- [ ] P3-3: claude-driver.ts — interrupt(childProcess)
  - SIGINT → 5s → SIGTERM → 5s → SIGKILL
  - 进程组隔离 (detached + process.kill(-pid))
- [ ] P3-4: claude-driver.ts — stream-json 解析器
  - 逐行读取 stdout
  - JSON.parse 每行
  - 发射类型化事件
  - 处理半包/异常行
- [ ] P3-5: 集成测试 — 创建 session + 发消息 + resume + 中断
- [ ] P3-6: git commit "feat: claude code driver"

## Phase 4: 消息队列与 Job 管理

- [ ] P4-1: queue.ts — Job 三态 (idle/busy/cancelling)
- [ ] P4-2: queue.ts — 消息队列 (per-group FIFO)
  - enqueue(groupId, message) → queuePosition
  - 队列非空时返回位置信息
- [ ] P4-3: queue.ts — 控制面与数据面分离
  - 识别 / 开头的命令 → 直接处理，不入队列
  - 普通消息 → 入队列
- [ ] P4-4: queue.ts — 超时管理
  - 可配置超时 (默认 10 分钟)
  - 超时自动调用 interrupt()
- [ ] P4-5: git commit "feat: message queue and job management"

## Phase 5: 命令解析与路由

- [ ] P5-1: commands.ts — 命令解析
  - parseCommand(text) → { command, args } | null
  - 支持: /bind, /unbind, /mode, /stop, /new, /status, /help
- [ ] P5-2: commands.ts — 各命令实现
  - /bind <path>: 验证路径 → 创建 binding → 创建 session → 回复
  - /unbind: 归档 binding → 显示 session ID
  - /mode <mode>: 更新 binding.permissionMode → 确认
  - /stop: 如果 busy → interrupt() → 确认; 如果 idle → 提示无任务
  - /new [path]: 归档旧 binding → 创建新 binding → 回复旧/新 session ID
  - /status: 显示当前 binding 信息
  - /help: 命令列表
- [ ] P5-3: git commit "feat: command parser and handlers"

## Phase 6: 输出处理

- [ ] P6-1: output.ts — stream-json → 飞书消息
  - 等待 result 事件，提取 result 文本
  - 长度 ≤ 30KB → 直接发送
  - 长度 > 30KB → 截断 + 附加提示 "输出过长，请回电脑查看完整内容: claude --resume <id>"
- [ ] P6-2: output.ts — 错误格式化
  - CLI 退出码非 0 → 格式化错误消息
  - 超时 → "执行超时 (10分钟)，已中断"
  - 被 /stop → "已中断"
- [ ] P6-3: git commit "feat: output formatting"

## Phase 7: 飞书适配器

- [ ] P7-1: feishu.ts — WebSocket 连接
  - 使用 @larksuiteoapi/node-sdk 的 WSClient
  - 配置 appId, appSecret
  - 注册 im.message.receive_v1 事件
- [ ] P7-2: feishu.ts — 消息接收
  - 解析消息体 (text content)
  - 提取 groupId, userId, messageId, text
  - 安全检查 (用户白名单)
  - 消息去重检查
- [ ] P7-3: feishu.ts — 消息发送
  - sendTextMessage(groupId, text)
  - 处理发送失败重试 (最多 2 次)
- [ ] P7-4: feishu.ts — Bot 信息获取
  - 启动时获取 Bot ID (用于过滤自己的消息)
- [ ] P7-5: 集成测试 — 连接飞书 + 收发消息
- [ ] P7-6: git commit "feat: feishu websocket adapter"

## Phase 8: 主流程串联

- [ ] P8-1: index.ts — 主流程
  - 加载配置
  - 初始化各模块
  - 启动飞书 WebSocket
  - 消息路由: 飞书消息 → 命令/队列 → Claude 驱动 → 输出 → 飞书回复
  - 崩溃恢复: 启动时加载 bindings，通知活跃群"系统已重启"
- [ ] P8-2: 端到端测试 — 飞书发消息 → Claude 回复 → 飞书收到
- [ ] P8-3: git commit "feat: main flow integration"

## Phase 9: CLI 入口与守护进程

- [ ] P9-1: bin/im2cc.ts — CLI 命令
  - im2cc start: 后台启动 (fork + 写 PID 文件)
  - im2cc stop: 读 PID → 发 SIGTERM
  - im2cc status: 检查 PID 存活 + 显示绑定数
  - im2cc logs: tail -f ~/.im2cc/logs/daemon.log
  - im2cc sessions: 列出所有活跃绑定
  - im2cc setup: 交互式配置 (App ID, Secret, 用户 ID)
- [ ] P9-2: 日志系统
  - 写入 ~/.im2cc/logs/daemon.log
  - 简单轮转 (>10MB 时重命名为 .old)
- [ ] P9-3: LaunchAgent plist 生成
  - im2cc install-service: 生成 ~/Library/LaunchAgents/com.im2cc.daemon.plist
  - KeepAlive: true
  - StandardOutPath / StandardErrorPath → log 文件
- [ ] P9-4: package.json bin 配置 + npm link
- [ ] P9-5: 全流程测试 — setup → start → 飞书交互 → stop
- [ ] P9-6: git commit "feat: CLI and daemon management"

## Phase 10: 收尾

- [ ] P10-1: 更新 PROJECT.md (最终目录结构)
- [ ] P10-2: 编写 README.md (安装、配置、使用说明)
- [ ] P10-3: 清理测试 session 和临时文件
- [ ] P10-4: git tag v0.1.0
- [ ] P10-5: 实际部署测试 (手机端飞书 ↔ 本地 Claude Code)

---

## 依赖关系

```
P0 (基础设施)
 └→ P1 (配置/安全) ─→ P2 (Session)
                         └→ P3 (Claude 驱动)
                              └→ P4 (队列)
                                   └→ P5 (命令)
                                        └→ P6 (输出)
     P7 (飞书适配器) ──────────────────────┘
                                             └→ P8 (串联)
                                                  └→ P9 (CLI/守护进程)
                                                       └→ P10 (收尾)
```

P1 和 P7 可以并行开发（无互相依赖）。
P3 和 P7 也可以并行（P3 只依赖 P2，P7 独立）。
