# src
> **重要** 本目录结构或子文件职责变化时，必须更新此文件。

## 职责
im2cc 核心业务逻辑：IM 消息接收 → 命令路由 → 本地 AI coding tool CLI 调用 → 输出格式化 → IM 回复

## 文件清单
- index.ts：主入口，初始化各模块、启动飞书连接、消息路由、崩溃恢复
- config.ts：配置加载 (~/.im2cc/config.json)
- security.ts：用户白名单检查、路径验证与白名单
- session.ts：Session 绑定 CRUD、原子写、消息去重
- claude-driver.ts：Claude Code CLI 驱动（spawn、stream-json 解析、中断）
- codex-driver.ts：Codex CLI 驱动（thread_id 创建、resume、输出解析）
- kimi-driver.ts：Kimi Code CLI 驱动（真实 session 目录发现、resume、输出解析）
- gemini-driver.ts：Gemini CLI 驱动（session_id 创建、resume、输出解析）
- queue.ts：消息队列（per-group FIFO）、Job 三态管理、超时、控制面分离
- commands.ts：命令解析与各命令处理函数（含 /fc 双参数注册模式，支持分叉对话流转）
- output.ts：stream-json 事件 → 飞书消息文本格式化
- registry.ts：命名 session 注册表（register/lookup/list/remove，永久寻址）
- discover.ts：扫描本地 Claude Code 对话（session 发现、slug→路径反推，作为注册表的补充）
- recap.ts：上下文回顾（读取 session JSONL 提取最近对话，/fc 时自动发送）
- feishu.ts：飞书 REST 轮询适配器（定时拉取群消息、发消息、资源下载）
- poll-cursor.ts：轮询游标持久化（per-group 游标读写，原子文件操作）
- file-staging.ts：文件暂存管理（inbox 目录、格式校验、TTL 清理、暂存队列）
