# src
> **重要** 本目录结构或子文件职责变化时，必须更新此文件。

## 职责
im2cc 核心业务逻辑：飞书消息接收 → 命令路由 → Claude Code CLI 调用 → 输出格式化 → 飞书回复

## 文件清单
- index.ts：主入口，初始化各模块、启动飞书连接、消息路由、崩溃恢复
- config.ts：配置加载 (~/.im2cc/config.json)
- security.ts：用户白名单检查、路径验证与白名单
- session.ts：Session 绑定 CRUD、原子写、消息去重
- claude-driver.ts：Claude Code CLI 驱动（spawn、stream-json 解析、中断）
- queue.ts：消息队列（per-group FIFO）、Job 三态管理、超时、控制面分离
- commands.ts：命令解析与各命令处理函数
- output.ts：stream-json 事件 → 飞书消息文本格式化
- feishu.ts：飞书 WebSocket 适配器（连接、收消息、发消息）
