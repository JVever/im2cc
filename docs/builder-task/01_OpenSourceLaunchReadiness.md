# OpenSourceLaunchReadiness - Builder任务工单

## 基本信息
- PRD文档：无，基于 2026-03-24 开源前深度 review 结论执行
- 开始时间：2026-03-24 04:18:34 +0800
- 状态：进行中

## 技术分析
本轮目标已从“收敛承诺”调整为“把公开承诺做实”：在开源前把 `Claude Code / Codex / Kimi Code / Gemini CLI` 的主创建流转链路补齐，同时移除 `Cline`。

- 涉及模块：`README.md`, `INSTALL.md`, `package.json`, `install.sh`, `bin/im2cc.ts`, `src/config.ts`, `src/session.ts`, `src/output.ts`, `src/commands.ts`, `src/index.ts`, `src/tool-driver.ts`, `src/codex-driver.ts`, `src/kimi-driver.ts`, `src/gemini-driver.ts`
- 数据结构：
  - 新增持久化的最近消息 ID 存储，用于重启后跨进程去重
  - 调整配置默认值，收紧默认权限模式
- 技术方案：
  - 修复真实阻塞 bug，而不是靠文档绕过
  - 删除 `Cline` 相关代码与文案，减少伪支持面
  - 对 `Codex/Gemini/Kimi` 使用真实 session id，而不是本地伪造 UUID
  - 让 CLI、README、安装脚本、运行时行为保持一致

## 任务清单
### 准备阶段
- [x] 复核 review 结论并归类优先级
- [x] 创建 Builder 任务工单
- [x] 明确明天开源的支持矩阵与产品承诺

### P0 阻塞问题
- [x] 修复 WeChat-only 用户无法 `im2cc start` 的启动阻塞
- [x] 修复 `install.sh` 中被管道吞掉的安装/构建失败
- [x] 修复消息去重只在内存中生效，导致重启后可能重复执行
- [x] 修复工具感知不足导致的错误恢复/截断提示

### P1 发布前应修
- [x] 收紧默认安全策略，避免开源默认即 `YOLO`
- [x] 统一 README / INSTALL / CLI 帮助 / package 描述的能力边界
- [x] 删除 `Cline` 并收敛对外支持矩阵
- [x] 修正文档中关于微信通知、`/fs [名称]` 等不一致承诺
- [ ] 补齐 `Codex / Kimi / Gemini` 的真实创建/恢复/验证闭环
  当前状态：`Codex` 已 smoke 通过，`Kimi` 已 smoke 通过，`Gemini` 原生命令 create/resume 已通过，但 Node driver 调用仍存在进程兼容性问题

### P2 迭代改进
- [x] 补充最小化 smoke test 入口
- [ ] 评估是否补齐多工具原生历史会话发现能力

## 决策记录
| 决策点 | 选择 | 理由 |
|--------|------|------|
| 明天开源的策略 | 直接做实四工具主链路 | 用户已明确要求多工具完整支持，不再做 Claude-only 收缩 |
| 多工具处理 | 保留 `Claude/Codex/Kimi/Gemini`，删除 `Cline` | `Cline` 用户已明确不使用，保留只会放大维护噪音 |
| 安全默认值 | 改为更保守的默认权限模式 | 降低多人群/误配置下的高风险行为 |

## 注意事项
- 当前默认假设：四工具的“完整支持”指通过 im2cc 创建并注册后的主链路完整可用。
- 本轮尽量避免引入新依赖；如需新增测试基础设施，再单独评估。

## 完成总结
- 实现了什么：
  - 修复 WeChat-only 启动阻塞、安装脚本失败掩盖、重启后消息重复执行、工具感知不足的恢复提示问题
  - 删除 `Cline` 全部运行时代码，并把对外支持矩阵收敛为 `Claude Code / Codex / Kimi Code / Gemini CLI`
  - `Codex` 改为真实 `thread_id`，`Kimi` 改为真实本地 session 目录识别，`Gemini` 改为真实 `session_id` 捕获
  - 统一了 CLI 帮助、README、INSTALL、doctor 输出和安装脚本的多工具口径
  - 新增 `npm run smoke` 最小化回归入口，覆盖 lint/build/CLI 帮助自检
- 修改了哪些文件：
  - `bin/im2cc.ts`, `src/base-driver.ts`, `src/tool-driver.ts`, `src/codex-driver.ts`, `src/kimi-driver.ts`, `src/gemini-driver.ts`
  - `src/config.ts`, `src/session.ts`, `src/output.ts`, `src/commands.ts`, `src/index.ts`
  - `README.md`, `INSTALL.md`, `install.sh`, `package.json`, `shell/im2cc-session-sync.sh`, `src/_INDEX.md`
- 需要用户关注的点：
  - `Gemini` CLI 已完成登录，原生命令 `create/resume` 已验证；但从 Node driver 调用时仍会卡住，开源前还需继续处理这一兼容性问题
  - 当前“扫描并导入未注册的本地历史会话”仍主要支持 Claude；多工具完整路径是通过 im2cc 创建并注册后再流转
