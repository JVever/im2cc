# SupportMatrixFocus - Builder任务工单

## 基本信息
- PRD文档：缺失（本次直接依据用户确认的产品收缩决策执行）
- 开始时间：2026-03-25
- 状态：已完成

## 技术分析
本次改造的目标是把项目的正式支持面收敛到“飞书/微信 + Claude Code/Codex”，同时保留 Gemini 的 best-effort 能力但不再作为主支持面宣传。需要同时收缩代码接线、CLI 帮助、环境检查、安装脚本和文档，避免出现“代码已删但文档仍宣传”或“文档已改但代码仍暴露入口”的不一致。

- 涉及模块：`src/transport.ts`、`src/index.ts`、`src/config.ts`、`src/commands.ts`、`src/tool-driver.ts`、`src/tool-cli-args.ts`、`src/status.ts`、`src/output.ts`、`bin/im2cc.ts`、`install.sh`、`package.json`、`README.md`、`INSTALL.md`、`src/_INDEX.md`
- 数据结构：`TransportType` 收敛为 `feishu | wechat`；`ToolId` 收敛为 `claude | codex | gemini`；Gemini 作为 best-effort 保留运行路径，但不再进入正式支持叙事
- 技术方案：删除 Telegram / 钉钉 / Kimi 的代码和配置入口；保留 Gemini driver 与 CLI 参数路径；新增集中支持矩阵常量，统一输出帮助文案和测试断言

## 任务清单
### 准备阶段
- [x] 阅读现有实现，确认 transport / tool 注册点、启动链路和文档入口
- [x] 确认本仓库缺失 PRD / ARCHITECTURE 文档，本次按用户明确决策执行
- [x] 技术分析，确定“正式支持 vs best-effort”的落地范围

### 实现阶段
- [x] 收敛支持矩阵类型与常量
- [x] 移除 Telegram / 钉钉 transport 及其配置、依赖、启动逻辑
- [x] 移除 Kimi driver 及相关命令、文案、映射
- [x] 保留 Gemini driver，但调整帮助和文档为 best-effort
- [x] 更新 CLI、doctor、install、帮助信息
- [x] 更新 README / INSTALL / 索引文档

### 测试阶段
- [x] 补充支持矩阵与参数映射测试
- [x] 运行 `npm run lint`
- [x] 运行 `npm run build`
- [x] 运行 `node --test scripts/*.mjs`
- [x] 全仓扫描残留引用，确认没有过期正式支持声明

## 决策记录
| 决策点 | 选择 | 理由 |
|--------|------|------|
| Gemini 的处理 | 保留代码，降级为 best-effort | 降低维护承诺，同时不强行破坏已有用户路径 |
| Telegram / 钉钉 的处理 | 直接移除代码与入口 | 用户明确不再维护，且不属于核心口碑路径 |
| Kimi 的处理 | 直接移除代码与入口 | 使用面小，维护价值低，能明显缩小支持面 |
| 支持矩阵表达方式 | 统一为中心化常量 + 文案同步 | 避免 CLI / 文档 /测试各自硬编码后再次漂移 |

## 注意事项
- 本次没有独立 PRD，所有取舍以用户在本轮对话中确认的产品方向为准
- 要避免把 Gemini 误删；它不是核心支持，但仍要保留可用路径
- 删除 transport / tool 后，要同步清理安装脚本、doctor、README、INSTALL 和 `_INDEX.md`

## 完成总结
- 实现了什么：正式支持面收敛为飞书/微信 + Claude Code/Codex；删除 Telegram / 钉钉 / Kimi 的代码与入口；保留 Gemini 为 best-effort；同步更新 CLI、doctor、安装脚本、README、INSTALL 和测试
- 修改了哪些文件：`src/transport.ts`、`src/tool-driver.ts`、`src/support-policy.ts`、`src/index.ts`、`src/config.ts`、`src/commands.ts`、`src/output.ts`、`src/status.ts`、`src/tool-cli-args.ts`、`bin/im2cc.ts`、`install.sh`、`package.json`、`package-lock.json`、`README.md`、`INSTALL.md`、`src/_INDEX.md`、`scripts/*.mjs`，并删除 `src/telegram.ts`、`src/dingtalk.ts`、`src/kimi-driver.ts`
- 需要用户关注的点：Gemini 仍可通过 `--tool gemini` 使用，但已明确降级为 best-effort；daemon 生命周期测试中有一条用例会在当前环境不支持 `pgrep/ps` 识别伪 daemon 时自动跳过
