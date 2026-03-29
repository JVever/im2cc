# src
> **重要** 本目录结构或子文件职责变化时，必须更新此文件。

## 职责
im2cc 核心业务逻辑：IM 消息接收 → 命令路由 → 本地 AI coding tool CLI 调用 → 输出格式化 → IM 回复

## 文件清单
- index.ts：主入口，初始化各模块、启动飞书连接、消息路由、崩溃恢复
- daemon-process.ts：守护进程进程识别与 PID/锁元数据校验，供 CLI 和 daemon 共享
- config.ts：配置加载 (~/.im2cc/config.json, ~/.im2cc/wechat-account.json)
- support-policy.ts：正式支持 / best-effort 支持矩阵常量与公共文案
- security.ts：用户白名单检查、路径验证与白名单（新建/接入路径共享）
- mode-policy.ts：模式注册表 — 每个工具的可用模式、中文描述、CLI 参数映射、默认模式、旧名迁移
- tool-cli-args.ts：各工具交互式 CLI 参数映射（tmux create/resume + resume hint）
- tool-compat.ts：工具 CLI 可选能力探测（例如 Claude 是否支持 `--name`）
- upgrade.ts：升级辅助逻辑（定位安装根目录、公开源码包升级辅助）
- session.ts：Session 绑定 CRUD、原子写、消息去重
- claude-driver.ts：Claude Code CLI 驱动（spawn、stream-json 解析、中断）
- codex-driver.ts：Codex CLI 驱动（thread_id 创建、resume、输出解析）
- gemini-driver.ts：Gemini CLI 驱动（best-effort，session_id 创建、resume、输出解析）
- queue.ts：消息队列（per-group FIFO）、Job 三态管理、超时、控制面分离
- commands.ts：命令解析与各命令处理函数（含 /fc 双参数注册模式、共享对话列表渲染、接入前路径复检）
- status.ts：会话状态面板构建（/fs 和 /fc 共用），含 context token、git 分支、Anthropic 配额
- output.ts：stream-json 事件 → 飞书消息文本格式化
- registry.ts：命名 session 注册表（register/lookup/list/remove，永久寻址）
- discover.ts：扫描本地 Claude Code 对话（session 发现、slug→路径反推，作为注册表的补充）
- recap.ts：上下文回顾（读取 session JSONL 提取最近对话，/fc 时自动发送）
- feishu.ts：飞书 REST 轮询适配器（定时拉取群消息、发消息、资源下载）
- wechat.ts：微信 ClawBot iLink 适配器（文本长轮询、发送、绑定）
- poll-cursor.ts：轮询游标持久化（per-group 游标读写，原子文件操作）
- file-staging.ts：文件暂存管理（inbox 目录、格式校验、TTL 清理、暂存队列）
