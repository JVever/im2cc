# im2cc

> IM to Claude Code — 通过飞书群聊远程操控本地 Claude Code CLI

## 项目状态
- **阶段**: MVP 开发中
- **版本**: 0.1.0 (未发布)
- **创建日期**: 2026-03-16

## 产品定位
轻量级远程转发层：把飞书消息转发给本地 Claude Code CLI，把结果发回飞书。
回到电脑后可通过 `claude --resume <session-id>` 无缝接续。

## 技术栈
| 组件 | 选择 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Node.js >= 20 |
| 飞书连接 | @larksuiteoapi/node-sdk (WebSocket) |
| CLI 调用 | child_process.spawn |
| 存储 | JSON 文件 (原子写) |
| 守护进程 | macOS LaunchAgent |

## 目录结构
```
im2cc/
├── src/
│   ├── index.ts          # 入口 + 守护进程管理
│   ├── feishu.ts         # 飞书 WebSocket 适配器
│   ├── claude-driver.ts  # Claude Code CLI 驱动
│   ├── session.ts        # Session 绑定管理
│   ├── queue.ts          # 消息队列 + Job 管理
│   ├── commands.ts       # 命令解析与路由
│   ├── output.ts         # CLI 输出 → 飞书消息格式化
│   ├── security.ts       # 白名单 + 路径验证
│   └── config.ts         # 配置加载
├── bin/
│   └── im2cc.ts          # CLI 入口 (start/stop/status/logs/sessions/doctor)
├── package.json
├── tsconfig.json
├── PROJECT.md
├── TASKS.md              # 任务清单
└── DEVLOG.md             # 开发日志
```

## 关键设计决策
1. **CLI spawn 而非 Agent SDK** — 复用 CLI 原生 session，支持回到电脑后 --resume
2. **Claude-only** — 95% 使用场景只用 Claude Code，不做多 CLI 抽象
3. **一群一 Session** — 飞书群和 Claude Code session 一一对应
4. **不做 session 编排** — 不自动摘要/轮换，保持对 CLI session 的"透明转发"
5. **stream-json 需要 --verbose** — 验证发现的关键约束

## 关键参数
- Claude CLI 调用: `claude -p <msg> --session-id/--resume <uuid> --output-format stream-json --verbose --permission-mode <mode>`
- 飞书消息上限: ~30KB
- 默认超时: 10 分钟
- 默认权限模式: plan
