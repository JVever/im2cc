# ClaudeLauncherOverride - Builder任务工单

## 基本信息
- PRD文档：无，本工单基于当前对话中的本地 Claude 渠道选择需求
- 开始时间：2026-03-30 16:10:00 CST
- 状态：已完成

## 技术分析
- 涉及模块：`bin/im2cc.ts`、`src/claude-driver.ts`、`src/tool-cli-args.ts`、`src/tool-compat.ts`、`src/config.ts`、`src/registry.ts`、测试脚本与本地 launcher
- 数据结构：在本地 config 中新增可选 `claudeLauncher`，在 registry 中为 Claude session 持久化可选 `claudeProfile`
- 技术方案：
  - 默认继续直接调用 `claude`，仅在本机显式配置 `claudeLauncher` 时启用自定义启动器
  - 电脑端 `fn` 创建 Claude 对话前先调用 launcher 选择 profile，再把所选 profile 写入 registry
  - 后续 `create/send/resume` 统一由 im2cc 把 profile 传回 launcher，保证同一 session 走同一渠道
  - IM 端 `/fn` 在启用本地 launcher 时禁止创建 Claude 对话，避免后台无 TTY 卡死

## 任务清单
### 准备阶段
- [x] 复盘 `fn -> im2cc new -> claude` 的真实调用链
- [x] 确认创建 session 的 headless 流程无法直接弹出渠道选择
- [x] 确定采用“本地 launcher 覆盖 + registry 记住 profile”的最小方案

### 实现阶段
- [x] 新增 Claude launcher 解析与 profile 选择模块
- [x] 在 CLI 本地创建链路中接入 profile 选择
- [x] 在 Claude driver / tmux resume 参数中透传 launcher 与 profile
- [x] 在 registry 中持久化可选 `claudeProfile`
- [x] 为本机生成 launcher 脚本并写入本地配置

### 测试阶段
- [x] 新增 launcher 单元 / 集成测试
- [x] 运行 `npm run lint`
- [x] 运行 `npm run build`
- [x] 运行 `node --test scripts/*.mjs`
- [x] 运行 `npm run smoke`

## 决策记录
| 决策点 | 选择 | 理由 |
|--------|------|------|
| 启动器扩展方式 | 仅对 Claude 增加可选本地 launcher | 满足你的需求，同时避免把开源项目抽象成过重的 Hook 系统 |
| profile 持久化位置 | 写入本地 registry | 后续 send/resume 可复用，且不会污染公开仓库 |
| IM 端 Claude 创建 | 启用 launcher 时直接拒绝 | 手机侧没有 TTY，硬做会造成无提示卡死 |

## 注意事项
- 该功能必须保持默认关闭；未配置 `claudeLauncher` 的用户行为不能变化
- 本地 launcher 脚本位于用户家目录，不进入 git

## 完成总结
- 实现了什么：
  - 新增可选 `claudeLauncher` 配置，默认仍直接调用 `claude`
  - 电脑端 `fn` 在启用本地 launcher 时会先选择 Claude profile，再创建会话
  - Claude 的 `create/send/resume/compat/version` 全链路都支持 launcher 覆盖
  - registry 现在会为 Claude session 持久化 `claudeProfile`，保证后续消息沿用同一路径
  - IM 端 `/fn` 在启用本地 launcher 时会拒绝直接创建 Claude 会话，避免后台无 TTY 卡住
  - README 已补充“本地 Claude 启动器覆盖”的使用说明
- 修改了哪些文件：
  - `src/claude-launcher.ts`
  - `src/config.ts`
  - `src/registry.ts`
  - `src/claude-driver.ts`
  - `src/tool-cli-args.ts`
  - `src/tool-compat.ts`
  - `src/tool-driver.ts`
  - `src/base-driver.ts`
  - `src/commands.ts`
  - `bin/im2cc.ts`
  - `README.md`
  - `scripts/claude-launcher.test.mjs`
  - `scripts/claude-driver-launcher.test.mjs`
  - `scripts/tool-cli-args.test.mjs`
- 需要用户关注的点：
  - 这项能力默认关闭，不会影响未配置 `claudeLauncher` 的开源用户
  - 本机 launcher 脚本和本地 `~/.im2cc/config.json` 变更不进入 git
  - 本次验证包含真实 launcher live check：使用 `glm` profile 完成 `createSession + sendMessage`，返回结果分别为 `就绪。` 和 `OK`
