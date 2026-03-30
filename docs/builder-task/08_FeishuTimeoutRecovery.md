# FeishuTimeoutRecovery - Builder任务工单

## 基本信息
- PRD文档：无，本工单基于当前对话中的稳定性收尾需求
- 开始时间：2026-03-30 02:06:00 CST
- 状态：已完成

## 技术分析
- 涉及模块：`src/feishu.ts`、`package.json`、`package-lock.json`、`scripts/*.test.mjs`
- 数据结构：沿用 `FeishuAdapter` 与 `Im2ccConfig`，补充网络层 timeout 恢复验证
- 技术方案：
  - 将 `axios` 声明为 direct dependency，消除对传递依赖的偶然依赖
  - 为 `FeishuAdapter` 补充最小回归测试，覆盖 timeout 后 client 重建与非 timeout 不重建
  - 保持现有飞书请求包装逻辑不扩散，只验证当前新增稳定性行为

## 任务清单
### 准备阶段
- [x] 审查 `src/feishu.ts` 未提交改动的真实意图与风险
- [x] 确认当前 `axios` 仅存在于传递依赖中，尚未在 root 依赖声明
- [x] 确认仓库缺少飞书 timeout 恢复相关测试

### 实现阶段
- [x] 将 `axios` 补为 root direct dependency
- [x] 新增 `FeishuAdapter` timeout 恢复最小测试
- [x] 校验必要文档记录

### 测试阶段
- [x] 运行 `npm run lint`
- [x] 运行 `npm run build`
- [x] 运行 `node --test scripts/*.mjs`
- [x] 运行 `npm run smoke`

## 决策记录
| 决策点 | 选择 | 理由 |
|--------|------|------|
| 依赖处理 | 将 `axios` 升格为 root direct dependency | 当前代码显式 import 了 `axios`，不能依赖 SDK 的传递依赖稳定存在 |
| 测试粒度 | 增加最小行为测试而非完整飞书集成测试 | 当前目标是验证 timeout 自愈逻辑，避免引入过重的测试基建 |

## 注意事项
- 当前分支为 `codex/fc-recap-chunks`
- 本轮要处理的未提交改动集中在 `src/feishu.ts`

## 完成总结
- 实现了什么：
  - 将 `axios` 补充为仓库的 direct dependency，避免 `src/feishu.ts` 对传递依赖的隐式耦合
  - 为 `FeishuAdapter` 新增 timeout 自愈最小回归测试，覆盖“timeout 后重建 client”与“非 timeout 不重建”两条关键路径
  - 保留现有飞书请求包装逻辑，只做依赖与验证层面的收尾
- 修改了哪些文件：
  - `src/feishu.ts`
  - `package.json`
  - `package-lock.json`
  - `scripts/feishu.test.mjs`
  - `docs/builder-task/08_FeishuTimeoutRecovery.md`
- 需要用户关注的点：
  - 全量测试中 `smoke` 首次运行出现过一次守护进程生命周期用例抖动；单独重跑后通过，当前代码未发现与飞书 timeout 修复直接相关的问题
  - 重启 `im2cc` 后才能让当前机器使用这组最新飞书网络层改动
