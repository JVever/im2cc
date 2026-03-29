# Onboarding Security Hardening - Builder任务工单

## 基本信息
- PRD文档：无，本工单基于当前对话中的产品讨论与风险审查
- 开始时间：2026-03-29
- 状态：已完成

## 技术分析
- 涉及模块：`src/security.ts`、`src/commands.ts`、`bin/im2cc.ts`、`scripts/*.test.mjs`、`README.md`、`INSTALL.md`、`install.sh`
- 数据结构：沿用现有 `Im2ccConfig`（`allowedUserIds`、`pathWhitelist`）和已注册 session / 绑定模型
- 技术方案：
  - 把路径白名单校验补到 attach/connect 主链路，避免只限制“创建新会话”而未限制“接入已有会话”
  - 为用户白名单和路径白名单增加专门的自动化测试，覆盖主路径和边界条件
  - 收敛首用信息架构：`onboard` 负责引导第一次成功与成功后的稳定化；`doctor` 负责诊断与 next action；`help` 保持短帮助
  - 将“开机自启”和“安全加固”放到 onboarding 成功后的收尾阶段，而不是前置阻塞

## 任务清单
### 准备阶段
- [x] 审查当前白名单实现与拦截链路
- [x] 审查当前帮助、doctor、安装文档与安装脚本
- [x] 确定本轮优化范围与验证策略

### 实现阶段
- [x] 修复 IM 端 `/fc` 接入已注册会话时缺少路径白名单复检的问题
- [x] 修复 IM 端 `/fc <新名称> <ID前缀>` 接入 discovered 会话时缺少路径白名单复检的问题
- [x] 修复本地 `im2cc connect` / `im2cc open` 缺少路径白名单复检的问题
- [x] 将飞书 `setup` 收敛为最小首用配置
- [x] 新增 post-success 安全加固入口，承接用户白名单和路径白名单配置
- [x] 新增或收敛 onboarding 入口，让首次成功、开机自启、安全加固形成清晰闭环
- [x] 调整 `doctor` 输出，使其更明确给出单一 next action
- [x] 同步更新 CLI 帮助、README、INSTALL、安装脚本输出

### 测试阶段
- [x] 为 `allowedUserIds` 增加自动化测试
- [x] 为 `validatePath()` 增加自动化测试（白名单内、白名单外、文件路径、软链、缺失路径）
- [x] 为 `/fc` 和 `connect` 的路径白名单复检增加自动化测试
- [x] 运行 `npm run lint`
- [x] 运行 `npm run build`
- [x] 运行 `node --test scripts/*.mjs`（40 通过，2 个既有 daemon 环境用例失败）
- [x] 运行 `npm run smoke`（复现同样 2 个 daemon 环境用例失败）
- [x] 运行 `bash -n install.sh`

## 决策记录
| 决策点 | 选择 | 理由 |
|--------|------|------|
| 白名单能力对外表述 | 先补主链路和测试，再决定文档承诺 | 当前实现不够完整，先修再宣称更稳妥 |
| onboarding 结构 | 首次成功 + 稳定化 + 学习扩展 | 兼顾最小成功链路和 post-success 保留 |
| 安全配置位置 | 放到首次成功后的收尾阶段 | 减少前置阻力，同时降低后续失效和误用风险 |

## 注意事项
- 当前工作区已有未提交改动：`bin/im2cc.ts`、`src/commands.ts`
- 这些改动与本轮目标相关，后续补丁必须在此基础上继续，不可覆盖
- 仓库未提供 `ARCHITECTURE.md`，本轮按现有代码结构与运行方式直接推进

## 完成总结
- 实现了什么：
  - 路径白名单现在会在 IM `/fc`、本地 `connect/open`、以及 discovered 会话接入链路上统一复检
  - 新增 `im2cc onboard` 与 `im2cc secure`，将首次成功、开机自启、安全加固拆成更清晰的主流程
  - `im2cc setup` 收敛为最小飞书凭证配置，`doctor` 改为更明确地给出下一步建议
  - README、INSTALL、install.sh、CLI 帮助已同步到新的 onboarding 信息架构
- 修改了哪些文件：
  - `src/commands.ts`
  - `bin/im2cc.ts`
  - `scripts/security.test.mjs`
  - `scripts/cli-help.test.mjs`
  - `README.md`
  - `INSTALL.md`
  - `install.sh`
  - `src/_INDEX.md`
  - `bin/_INDEX.md`
- 需要用户关注的点：
  - 全量测试仍有 2 个既有 daemon 生命周期用例受当前机器环境影响失败，和本轮白名单/onboarding 改动无直接关系
