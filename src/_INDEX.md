# src
> **重要** 本目录结构或子文件职责变化时，必须更新此文件。

## 职责
im2cc 核心业务逻辑：IM 消息接收 → 命令路由 → 本地 AI coding tool CLI 调用 → 输出格式化 → IM 回复

## 文件清单
- index.ts：主入口，初始化各模块、启动飞书连接、消息路由、崩溃恢复，并判定 /fc 是否允许发送最近一轮 recap；普通消息入口会触发反茄钟 waiting→work，并拦截无活跃绑定的旧出站消息
- daemon-process.ts：守护进程进程识别与 PID/锁元数据校验，供 CLI 和 daemon 共享
- config.ts：配置加载 (~/.im2cc/config.json, ~/.im2cc/wechat-account.json)
- support-policy.ts：正式支持 / best-effort 支持矩阵常量与公共文案
- security.ts：用户白名单检查、路径验证与白名单（新建/接入路径共享）
- mode-policy.ts：模式注册表 — 每个工具的可用模式、中文描述、CLI 参数映射、默认模式、旧名迁移
- claude-launcher.ts：Claude 本地启动器覆盖（可选 launcher 解析、profile 选择、环境变量透传）
- tool-cli-args.ts：各工具交互式 CLI 参数映射（tmux create/resume + resume hint）
- tool-compat.ts：工具 CLI 可选能力探测（例如 Claude 是否支持 `--name`）
- upgrade.ts：升级辅助逻辑（定位安装根目录、公开源码包升级辅助）
- session.ts：Session 绑定 CRUD、原子写、消息去重
- anti-pomodoro.ts：反茄钟状态机（waiting/work/rest 三态、休息期单次后台指令额度、延迟结果队列、daemon 同步与失败重试）
- message-format.ts：统一结构化出站消息抽象（系统回复识别、飞书 post 渲染、微信纯文本降级）
- claude-driver.ts：Claude Code CLI 驱动（spawn、stream-json 解析、中断）
- codex-driver.ts：Codex CLI 驱动（thread_id 创建、resume、输出解析）
- gemini-driver.ts：Gemini CLI 驱动（best-effort，session_id 创建、resume、输出解析）
- queue.ts：消息队列（per-group FIFO）、Job 三态管理、超时、控制面分离；绑定切换后的旧结果丢弃、startup recovery 送达校验、本地接回电脑时的 inflight 中断，以及 handoff 保护态所需的 inflight / completed snapshot 查询
- commands.ts：命令解析与各命令处理函数（含 /fc 双参数注册模式、共享对话列表渲染、接入前路径复检）
- status.ts：会话状态面板构建（/fs 和 /fc 共用），含 context token、git 分支、Anthropic 配额
- output.ts：stream-json 事件 → 飞书消息文本格式化
- registry.ts：命名 session 注册表（register/lookup/list/remove，永久寻址）
- discover.ts：扫描本地 Claude Code 对话，并处理 Claude/Codex 的 session 漂移同步（Codex 会尝试匹配 tmux pane 可见内容到真实 thread）
- recap.ts：上下文回顾（过滤 init 消息、格式化最近一轮对话、/fc 时按最多 3 条消息发送）
- feishu.ts：飞书 REST 轮询适配器（定时拉取群消息、文本/富文本发送、资源下载）
- wechat.ts：微信 ClawBot iLink 适配器（文本长轮询、结构化消息文本降级发送、绑定）
- poll-cursor.ts：轮询游标持久化（per-group 游标读写，原子文件操作）
- file-staging.ts：文件暂存管理（inbox 目录、格式校验、TTL 清理、暂存队列）
