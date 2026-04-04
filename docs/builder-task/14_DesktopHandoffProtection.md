# DesktopHandoffProtection - Builder任务工单

## 基本信息
- PRD文档：无独立 PRD，依据本轮已确认的对话方案
- 开始时间：2026-04-04
- 状态：已完成

## 技术分析
在电脑端 `fc/im2cc connect` 时，如果目标对话仍有远程 inflight 任务，不再直接中断并接回，而是先进入一个只读“接回保护态”：
- 复用 inflight meta / output / pid 判断当前后台任务是否仍在执行
- 立即归档远程 binding，阻止手机继续发送新消息
- 保护态中展示执行状态、已运行时间、最近一条远程指令摘要、最近输出尾部
- 默认等待后台任务完成后自动接回；支持 `Ctrl+C` 中断后台任务并立即接回
- 为避免任务刚完成就清理导致电脑端看不到结果，补一个短生命周期的 completed snapshot

- 涉及模块：
  - `src/queue.ts`
  - `bin/im2cc.ts`
  - `src/_INDEX.md`
  - `scripts/queue.test.mjs`
  - `scripts/cli-help.test.mjs` 或新增相关测试
- 数据结构：
  - inflight task snapshot
  - completed inflight snapshot（短期保留，用于 handoff 结果回显）
- 技术方案：
  - `queue.ts` 负责列举 inflight、写 completed snapshot、读取最近完成结果
  - `im2cc.ts` 负责在 `connect` 路径进入保护态、渲染状态、等待/取消并最终 attach

## 任务清单
### 准备阶段
- [x] 阅读现有 handoff / inflight 代码，确认问题边界
- [x] 技术分析，确定“接回保护态”实现路径

### 实现阶段
- [x] 为 inflight 增加查询与最近完成快照能力
- [x] 将 `releaseRemoteBinding` 拆成可配置的“仅断开 / 断开并中断”
- [x] 在本地 `connect` 路径接入保护态，支持等待完成和 `Ctrl+C` 立即接管
- [x] 优化本地提示文案，明确“不要重复发送相同指令”

### 测试阶段
- [x] 覆盖 inflight 最近完成快照读写与清理
- [x] 覆盖保护态依赖的队列/接回关键逻辑
- [x] 运行构建与相关测试验证

## 决策记录
| 决策点 | 选择 | 理由 |
|--------|------|------|
| 是否实现真正无缝 handoff | 不做 | 后台 headless 进程迁移到 tmux 风险高、收益不成比例 |
| 保护态是否允许继续输入 | 不允许 | 防止远程旧任务未结束时再次并发执行 |
| 完成结果如何保留 | 短生命周期 completed snapshot | 避免 inflight 立即清理后电脑端拿不到最终结果 |

## 注意事项
- 仓库当前无独立 PRD / ARCHITECTURE 文档，本轮按已确认对话方案落地
- `.agents/` 为未跟踪目录，不纳入提交

## 完成总结
- 实现了什么：
  - 电脑端 `im2cc connect` / `fc` 在检测到远程 inflight 任务时，先进入“接回保护态”，展示执行状态、最近输出和结果回显，避免用户误判后重复发送
  - 保护态支持默认等待完成后自动接回，也支持 `Ctrl+C` 中断旧任务并立即接回
  - 队列层新增 completed snapshot，保证任务刚结束时电脑端仍能读到结果摘要
- 修改了哪些文件：
  - `src/queue.ts`
  - `bin/im2cc.ts`
  - `src/_INDEX.md`
  - `scripts/queue.test.mjs`
  - `docs/builder-task/14_DesktopHandoffProtection.md`
- 需要用户关注的点：
  - daemon 仍在运行旧代码，实际体验新保护态前需要重启 `im2cc`
