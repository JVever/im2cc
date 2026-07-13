# src
> **重要** 本目录结构或子文件职责变化时，必须更新此文件。

## 职责
im2cc 核心业务逻辑：IM 消息接收 → 命令路由 → 本地 AI coding tool CLI 调用 → 输出格式化 → IM 回复

## 文件清单
- index.ts：主入口，初始化各模块、启动飞书连接、消息路由、崩溃恢复，并判定 /fc 是否允许发送最近一轮 recap；普通消息入口会触发反茄钟 waiting→work，并拦截无活跃绑定的旧出站消息
- daemon-process.ts：守护进程进程识别与 PID/锁元数据校验，供 CLI 和 daemon 共享
- config.ts：配置加载 (~/.im2cc/config.json, ~/.im2cc/wechat-account.json)，含 imDefaultClaudeProfile（IM 端非交互启动 Claude 时传给 launcher 的 profile 名）
- support-policy.ts：正式支持 / best-effort 支持矩阵常量与公共文案
- security.ts：IM 用户白名单检查、session 名称合法性校验、路径展开与存在性校验（不再承担"安全边界"语义，访问范围由 AI 工具自身的 permission mode 决定）
- project-index.ts：从 registry.json 派生 IM 端项目索引（listProjectIndex/resolveProjectHint/suggestProjectLabels/prettyPath），用于 /ls 与 /fn 短名称解析
- mode-policy.ts：模式注册表 — 每个工具的可用模式、中文描述、CLI 参数映射、默认模式、旧名迁移
- model-id.ts：共享精确模型 ID 归一门禁；不绑定 provider 前缀，但拒绝 default / synthetic 与 Claude 已知家族 alias（含版本短名形态）
- model-catalog.ts：Claude/Codex `/model` 内置与用户配置清单；短名只作输入映射，进入 registry 的 fullName 必须通过精确 ID 门禁
- claude-launcher.ts：Claude 本地启动器覆盖（可选 launcher 解析、profile 选择、环境变量透传），并提供 injectAskUserHookSettings — 给当前 session 写入 PreToolUse AskUserQuestion hook 配置 + IM2CC_* 环境变量
- askuser-bridge.ts：Claude AskUserQuestion 反向提问桥接 — daemon 侧 unix socket IPC server（~/.im2cc/sockets/askuser.sock），与 hooks/askuser-hook.mjs 用 NDJSON 通信；维护 pending Q&A map、超时计时、cancel 传播；通过 EventEmitter 把 ask / answered / timeout / cancelled 事件透出给 daemon 主流程
- tool-cli-args.ts：各工具交互式 CLI 参数映射（tmux create/resume 显式恢复 Session 精确模型 + resume hint）
- tmux-util.ts：tmuxExactTarget(name) — 把 -t 包成 `=<name>` 强制精确匹配，避免 tmux 默认 prefix match 让前缀重合的 session 名互相干扰（ARCHITECTURE.md §4.2 红线，引入：@20260512-fc-tmux-client-preempt）
- tmux-watcher.ts：诊断仪表 B — daemon 内每 10s `tmux list-sessions` diff 出消失的 im2cc-* session，写 `~/.im2cc/logs/tmux-watch.log` 带 registry/binding/inflight 上下文；纯旁观无副作用，配合 bin/im2cc.ts:fcTraceLog 互补（fc-trace 拿调用现场、tmux-watch 拿 idle 销毁现场），引入：@20260512-fc-tmux-client-preempt v1.1（注:此模块代码已就绪，daemon 挂载点延后随其他 feature commit 一并上线）
- tool-compat.ts：工具 CLI 可选能力探测（例如 Claude 是否支持 `--name`）
- upgrade.ts：安装模式识别（detectInstallRoot + InstallMode: npm-global / git-checkout / tarball / unknown），供 `im2cc update` 路由
- shell-install.ts：shell rc 文件（.zshrc/.bashrc）的 im2cc 薄包装函数注入逻辑：marker 对、清理历史行、幂等替换；核心计算是纯函数，便于测试
- session.ts：IM Binding CRUD、原子写、消息去重；旧 modelOverride 仅保留作一次性迁移输入
- session-model.ts：Claude/Codex 原生 JSONL 模型观测与 Session 精确模型归一（模型 + watermark + observed baseline 快照、仅接受本 turn 新事实的完成 CAS、Codex 成功 turn context 按启动时间有序吸收与反向分块扫描、旧 binding 迁移、TUI 模型差异检测）
- anti-pomodoro.ts：反茄钟状态机（waiting/work/rest 三态、休息期单次后台指令额度、延迟结果队列、daemon 同步与失败重试）
- message-format.ts：统一结构化出站消息抽象（系统回复识别、飞书 post 渲染、微信纯文本降级）；AI 回复经 markdownTextMessage() 标记后飞书渲染为 post+`tag:md`（原文直送不 escape），系统提示/命令回执保持纯文本 text msg_type
- claude-driver.ts：Claude Code CLI 驱动（创建/发送显式继承 Session 精确模型、spawn、stream-json 解析、中断、forkSession/deleteForkSession 用于 /btw 旁路 fork @20260513-im-btw-side-fork）
- codex-driver.ts：Codex CLI 驱动（创建/发送显式继承 Session 精确模型、thread_id 创建、resume、输出解析）
- gemini-driver.ts：Gemini CLI 驱动（best-effort，session_id 创建、resume、输出解析）
- queue.ts：消息队列（per-group FIFO）、Job 三态管理、控制面分离（/stop 手动中断）；每个 turn 快照命名 Session 的精确模型 + watermark + observed baseline，成功后只用本 turn 新模型事实 CAS 对账，禁止旧 turn 或旧 observation 覆盖新选择；另含旧结果丢弃、startup recovery 与桌面接回保护态
- commands.ts：命令解析与各命令处理函数（含 /fc 双参数注册模式、共享对话列表渲染、接入前路径存在性复检、/fn 教学卡片、/ls 展示 registry 派生的已用项目、/fn 项目短名解析 + 模糊匹配建议 + 全新路径兜底；配 claudeLauncher 时 /fn 用 imDefaultClaudeProfile 非交互启动；/at /in /cron 设置每 session 一条定时消息；/clear 保留 Session 模型，/model 只接受清单内完整 ID/短名并写 registry，/compact /btw 维持会话控制 @20260510-im-slash-passthrough / @20260513-im-btw-side-fork）
- schedule-parser.ts：/at /in /cron 表达式解析（自实现 5 段 cron，无外部依赖）；返回绝对时间戳 nextFireAt 与剩余消息体
- schedule-store.ts：~/.im2cc/data/schedules.json 原子读写；name 主键 upsert 唯一约束
- scheduler.ts：定时消息调度核心 — 内存 timer + 持久化、daemon 重启零漂移、错过窗口处理；在线走 queue，无绑定时 driver 直调也按模型 + watermark + observed baseline 快照继承，并只用本次新增事实条件校正
- status.ts：会话状态面板构建（/fs 和 /fc 共用），用“当前选择的模型 / 最近实际使用的模型”分列 Session 持续生效的设置与工具可验证的成功事实，并展示 context token、git 分支、Anthropic 配额
- output.ts：stream-json 事件 → 飞书消息文本格式化
- registry.ts：命名 Session 注册表（永久寻址 + 精确模型 ID 门禁 + 跨进程写锁 + selectedModelId/modelSelectionUpdatedAt 跨端模型真值 + turn 完成 CAS）
- discover.ts：扫描本地 Claude Code / Codex 对话，并处理 Codex 的 session 漂移同步（匹配 tmux pane 可见内容到真实 thread）；Claude 漂移同步 2026-04-17 下线，由 SessionStart hook 全权负责
- recap.ts：上下文回顾（过滤 init 消息、格式化最近一轮对话、/fc 时按最多 3 条消息发送）
- feishu.ts：飞书 REST 轮询适配器（per-chat 自适应退避：活跃 5s / 闲 5min 30s / 闲 30min 60s / 闲 2h 120s；文本/富文本发送、资源下载，并在 `open.feishu.cn` DNS 失败时自动回退到 `open.larksuite.com`）
- wechat.ts：微信 ClawBot iLink 适配器（文本长轮询、结构化消息文本降级发送、绑定）；非文本消息（文件/图片/语音）当前不在支持范围，回复中性提示引导用户改用飞书
- poll-cursor.ts：轮询游标持久化（per-group 游标读写，原子文件操作）
- file-staging.ts：文件暂存管理（inbox 目录、格式校验、TTL 清理、暂存队列；含 office 文档分类与旧格式升格目标解析 needsLegacyUpgrade）
- office-upgrader.ts：旧格式 office 文档（doc/xls/ppt → docx/xlsx/pptx）经 LibreOffice headless 升格；mutex 串行 + 临时 user-profile 隔离 + 30s timeout
- attachment-prompt.ts：含附件的 prompt 拼装；按 driver.officeDocStrategy（'native' / 'prompt-template'）切换两种模板
