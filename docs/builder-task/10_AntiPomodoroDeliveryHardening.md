# AntiPomodoroDeliveryHardening - Builder任务工单

## 基本信息
- PRD文档：无，本工单基于 2026-04-04 当前对话中确认的稳定性修复需求
- 开始时间：2026-04-04 16:24:47 CST
- 状态：已完成

## 技术分析
- 涉及模块：`src/anti-pomodoro.ts`、`scripts/anti-pomodoro.test.mjs`、`src/_INDEX.md`
- 数据结构：沿用 `AntiPomodoroState.delayedReplies`，重点保证发送失败时不错误丢弃队列
- 技术方案：
  - 修正 `AntiPomodoroDaemonController.sync()` 的送达循环，使单条消息发送失败不会导致未捕获异常退出 daemon
  - 明确失败时的保留/重试语义，避免“送达失败但已从状态中删除”
  - 为反茄钟 daemon 同步流程补最小回归测试，覆盖失败保留与后续重试

## 任务清单
### 准备阶段
- [x] 确认 daemon 重启并非手动触发，而是 `launchd` 在崩溃后自动拉起
- [x] 定位崩溃入口为反茄钟 `sync()` 内部发送失败未兜底
- [x] 确认现有测试仅覆盖配额与延迟送达，不覆盖 daemon 送达失败

### 实现阶段
- [x] 设计并实现反茄钟延迟送达失败的保留/重试策略
- [x] 加固 `AntiPomodoroDaemonController.sync()`，避免发送失败导致 daemon 退出
- [x] 更新必要索引文档与工单记录

### 测试阶段
- [x] 新增/补充反茄钟稳定性回归测试
- [x] 运行 `npm run build`
- [x] 运行 `node --test scripts/anti-pomodoro.test.mjs`
- [x] 运行 `node --test scripts/commands.test.mjs scripts/anti-pomodoro.test.mjs`

## 决策记录
| 决策点 | 选择 | 理由 |
|--------|------|------|
| 失败处理语义 | 发送失败时保留待送达消息，等待后续 `sync()` 重试 | 反茄钟的核心承诺是“延迟送达而非丢失送达”，失败不应等于消费完成 |
| 修复边界 | 先修 daemon 稳定性，不与消息格式重构混在同一提交 | 便于验证、回滚和独立观察运行时效果 |

## 注意事项
- 仓库当前没有正式 `docs/PRD` 与 `ARCHITECTURE.md`，本工单以本轮对话中已确认范围为准
- 本轮修复完成后，再单独开下一张工单处理飞书/微信消息格式重构

## 完成总结
- 实现了什么：
  - 加固了反茄钟 `AntiPomodoroDaemonController.sync()`，延迟结果发送失败时不再抛出未捕获异常打崩 daemon
  - 将延迟结果送达改为“成功后再出队”，失败时保留消息并在当前工作窗口内短间隔重试
  - 新增反茄钟 daemon 送达失败回归测试，覆盖“首次失败保留、后续重试成功再移除”关键路径
- 修改了哪些文件：
  - `src/anti-pomodoro.ts`
  - `scripts/anti-pomodoro.test.mjs`
  - `src/_INDEX.md`
  - `docs/builder-task/10_AntiPomodoroDeliveryHardening.md`
- 需要用户关注的点：
  - 当前修复的是“延迟送达失败导致 daemon 崩溃”这一条链路；消息格式重构仍在下一段工单中单独处理
  - 测试日志里会看到一条预期的 `[anti-pomodoro] 延迟结果送达失败`，这是新回归测试故意注入的失败样本
