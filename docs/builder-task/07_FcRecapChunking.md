# FcRecapChunking - Builder任务工单

## 基本信息
- PRD文档：无，本工单基于当前对话中的需求确认
- 开始时间：2026-03-30 01:17:03 CST
- 状态：已完成

## 技术分析
- 涉及模块：`src/index.ts`、`src/tool-driver.ts`、`src/base-driver.ts`、`src/claude-driver.ts`、`src/codex-driver.ts`、`src/gemini-driver.ts`、`src/recap.ts`、`scripts/*.test.mjs`、`README.md`
- 数据结构：沿用现有 session JSONL 解析结果，聚焦“最近一轮”对话 `RecapTurn`
- 技术方案：
  - 将 `/fc` 接入后的回顾从“单条文本”改为“最多 3 条消息”的结构化分片
  - 优先返回最近一轮完整对话；若单轮过长，优先保留最新回答尾部并在 3 条内完成切分
  - 将接入成功提示与最近一轮对话拆成独立消息气泡，提升手机端视觉分层
  - 统一使用 `【你】` / `【AI】` 标签和续传标签，提升手机端可读性

## 任务清单
### 准备阶段
- [x] 审查 `/fc` 接入后的 recap 生成与发送链路
- [x] 确认 transport 单条消息限制与现有截断行为
- [x] 确定本轮行为约束：最多 3 条、优先最近一轮、明确分隔样式

### 实现阶段
- [x] 调整 driver recap 接口，返回最近一轮结构化对话而不是单条字符串
- [x] 在 `src/recap.ts` 实现“最多 3 条”的 recap 分片与样式格式化
- [x] 修改 `/fc` 发送链路，将接入提示与 recap 拆成独立消息，同时保持总数不超过 3 条
- [x] 保持普通消息输出链路不变，限制回归范围

### 测试阶段
- [x] 新增 recap 分片单元测试：单条、双条、三条、超上限尾部保留
- [x] 运行 `npm run lint`
- [x] 运行 `npm run build`
- [x] 运行 `node --test scripts/*.mjs`
- [x] 运行 `npm run smoke`

## 决策记录
| 决策点 | 选择 | 理由 |
|--------|------|------|
| `/fc` 回顾范围 | 只保证最近一轮完整对话 | 与用户目标一致，避免旧上下文挤掉最终结论 |
| 消息条数 | 最多 3 条，接入提示单独占 1 条，recap 使用剩余额度 | 保持视觉分层，同时继续控制刷屏 |
| 超限策略 | 优先保留 AI 回复尾部 | 当前痛点是看不到最后结论，尾部优先更符合使用场景 |

## 注意事项
- 当前工作区已有未提交改动：`src/feishu.ts`
- 本轮实现不应覆盖或重写该文件中的现有变更
- 仓库未提供 `ARCHITECTURE.md`，本轮按当前代码结构直接推进

## 完成总结
- 实现了什么：
  - `/fc` 接入后的自动回顾现在固定优先返回最近一轮完整对话，而不是按单条字符串截断
  - 最近一轮过长时，会在不超过 3 条消息的前提下自动分片，并使用 `【你】` / `【AI】` / `【AI - 续】` 标签区分内容
  - 若最近一轮仍然超过 3 条消息容量，会优先保留 AI 回复尾部，避免丢失最后结论
  - 接入成功提示现在单独作为一条消息发送；最近一轮 recap 使用剩余 2 条额度，视觉上与状态信息分离
- 修改了哪些文件：
  - `src/index.ts`
  - `src/recap.ts`
  - `src/tool-driver.ts`
  - `src/base-driver.ts`
  - `src/claude-driver.ts`
  - `src/codex-driver.ts`
  - `src/gemini-driver.ts`
  - `scripts/recap.test.mjs`
  - `README.md`
  - `src/_INDEX.md`
  - `docs/builder-task/07_FcRecapChunking.md`
- 需要用户关注的点：
  - 本轮没有动普通消息输出的截断逻辑，只调整了 `/fc` 接入后的 recap 路径
  - 构建时检测到本机 daemon 正在运行旧代码；如需让当前机器立即使用新行为，需要后续手动重启 `im2cc`
