# im2cc 任务清单

> 基于 4 轮多模型评审后的最终方案，按依赖顺序排列。
> 状态标记：⬜ 未开始 | 🔄 进行中 | ✅ 已完成 | ⏸️ 阻塞

---

## Phase 0: 项目基础设施 ✅

- [x] P0-1: 创建项目目录、git init
- [x] P0-2: 创建 PROJECT.md、TASKS.md、DEVLOG.md
- [x] P0-3: 初始化 package.json + TypeScript 配置
- [x] P0-4: 创建目录结构 (src/, bin/) + _INDEX.md
- [x] P0-5: 配置 tsconfig.json, .gitignore
- [x] P0-6: 安装依赖 (@larksuiteoapi/node-sdk, typescript, @types/node)
- [x] P0-7: 首次 git commit

## Phase 1: 配置与安全层 ✅

- [x] P1-1: config.ts — 配置加载 (0600 权限, 原子写)
- [x] P1-2: security.ts — 用户白名单 + 路径验证/白名单/symlink resolve
- [x] P1-3: logger.ts — 日志写入 + 轮转
- [x] P1-4: git commit

## Phase 2: Session 绑定管理 ✅

- [x] P2-1: session.ts — Binding 数据模型
- [x] P2-2: session.ts — CRUD 操作 (create/get/update/archive/list)
- [x] P2-3: session.ts — 原子写 (临时文件 + rename)
- [x] P2-4: session.ts — 消息去重 (Map + LRU)
- [x] P2-5: git commit

## Phase 3: Claude Code 驱动 ✅

- [x] P3-1: claude-driver.ts — createSession (生成 UUID, spawn, stream-json)
- [x] P3-2: claude-driver.ts — sendMessage (--resume, AsyncIterable)
- [x] P3-3: claude-driver.ts — interrupt (SIGINT → SIGTERM → SIGKILL, 进程组)
- [x] P3-4: claude-driver.ts — stream-json 逐行解析器
- [x] P3-5: git commit

## Phase 4: 消息队列与 Job 管理 ✅

- [x] P4-1: queue.ts — Job 三态 (idle/busy/cancelling)
- [x] P4-2: queue.ts — per-group FIFO 队列
- [x] P4-3: queue.ts — 控制面/数据面分离
- [x] P4-4: queue.ts — 超时管理 (可配置, 默认 10 分钟)
- [x] P4-5: git commit

## Phase 5: 命令解析与路由 ✅

- [x] P5-1: commands.ts — 命令解析 (/bind /unbind /mode /stop /new /status /help)
- [x] P5-2: commands.ts — 各命令实现
- [x] P5-3: git commit

## Phase 6: 输出处理 ✅

- [x] P6-1: output.ts — stream-json → 飞书文本 (≤30KB 直发, >30KB 截断+提示)
- [x] P6-2: output.ts — 错误格式化
- [x] P6-3: git commit

## Phase 7: 飞书适配器 ✅

- [x] P7-1: feishu.ts — WebSocket 连接 (WSClient)
- [x] P7-2: feishu.ts — 消息接收 (解析 text, 提取 chatId/userId/messageId)
- [x] P7-3: feishu.ts — 消息发送 (sendTextMessage)
- [x] P7-4: feishu.ts — Bot 信息获取
- [x] P7-5: git commit

## Phase 8: 主流程串联 ✅

- [x] P8-1: index.ts — 主流程 (加载配置 → 初始化 → 飞书连接 → 消息路由 → 崩溃恢复)
- [x] P8-2: git commit

## Phase 9: CLI 入口与守护进程 ✅

- [x] P9-1: bin/im2cc.ts — CLI 命令 (start/stop/status/logs/sessions/setup/install-service/doctor)
- [x] P9-2: 日志系统 (logger.ts, 10MB 轮转)
- [x] P9-3: LaunchAgent plist 生成 (KeepAlive)
- [x] P9-4: package.json bin 配置 + npm link
- [x] P9-5: im2cc doctor 验证通过
- [x] P9-6: git commit

## Phase 10: 收尾 🔄

- [ ] P10-1: 飞书 App 配置 (im2cc setup)
- [ ] P10-2: 端到端测试 (手机飞书 ↔ 本地 Claude Code)
- [ ] P10-3: 修复测试中发现的问题
- [ ] P10-4: 更新 PROJECT.md (最终状态)
- [ ] P10-5: git tag v0.1.0

---

## 代码统计

| 文件 | 行数 | 职责 |
|------|------|------|
| src/config.ts | 62 | 配置加载 |
| src/security.ts | 63 | 安全验证 |
| src/session.ts | 97 | Session 绑定 |
| src/claude-driver.ts | 138 | Claude CLI 驱动 |
| src/queue.ts | 110 | 消息队列 |
| src/commands.ts | 160 | 命令处理 |
| src/output.ts | 30 | 输出格式化 |
| src/feishu.ts | 95 | 飞书适配器 |
| src/index.ts | 75 | 主入口 |
| src/logger.ts | 35 | 日志 |
| bin/im2cc.ts | 220 | CLI 入口 |
| **合计** | **~1085** | |
