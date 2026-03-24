# ClaudeRateLimitHandling - Builder任务工单

## 基本信息
- PRD文档：无（本轮为用户直接报 bug）
- 开始时间：2026-03-24 13:22:41 +0800
- 状态：已完成

## 技术分析
修复 Claude Code 限流提示被误当成正常 assistant 回复转发到 IM 的问题。
- 涉及模块：`src/base-driver.ts`
- 数据结构：无新增持久化结构，补充运行时错误识别逻辑
- 技术方案：在通用 NDJSON 事件解析层识别 `isApiErrorMessage` / `error` 等 API 错误信号，并把 rate limit/quota 类文本转为失败态，阻止流式转发

## 任务清单
### 准备阶段
- [x] 阅读用户报错现象，确认复现截图
- [x] 阅读相关驱动与队列代码，确认问题链路
- [x] 技术分析，确定实现路径

### 实现阶段
- [x] 在通用 driver 层补充 API 错误识别
- [x] 阻止 Claude rate limit 文案被当成普通 assistant 文本转发
- [x] 保持其他工具正常成功输出路径不变

### 测试阶段
- [x] 运行 TypeScript 构建检查
- [x] 运行 smoke 或等效验证
- [x] 记录剩余风险

## 决策记录
| 决策点 | 选择 | 理由 |
|--------|------|------|
| 修复层级 | 放在 `BaseToolDriver` | 问题出在通用 NDJSON 事件解析，放在 driver 基类可以统一拦截 API error，避免在 queue/transport 层做工具特判 |

## 注意事项
- 仓库当前有用户未提交修改：`bin/im2cc.ts`、`src/config.ts`、`src/index.ts`、`src/session.ts`
- 本次修复尽量避免触碰上述文件
- `dist/` 已重新构建，但当前守护进程重启被沙箱限制拦截，运行中的旧进程仍是 PID `91724`

## 完成总结
- 实现了什么：在通用 driver 事件解析层识别 Claude 的 `isApiErrorMessage` / `error=rate_limit` 及配额耗尽文本，改为失败态处理，不再作为普通 assistant 回复流式转发到 IM
- 修改了哪些文件：`src/base-driver.ts`、`docs/builder-task/02_ClaudeRateLimitHandling.md`
- 需要用户关注的点：`npm run build` 与 `npm run smoke` 已通过；但 `node dist/bin/im2cc.js stop` 在当前沙箱下返回 `EPERM`，因此还没把运行中的守护进程切到新版本
