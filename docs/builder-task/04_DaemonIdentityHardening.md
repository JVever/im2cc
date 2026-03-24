# DaemonIdentityHardening - Builder任务工单

## 基本信息
- PRD文档：无（线上缺陷修复）
- 开始时间：2026-03-24 20:43:36 +0800
- 状态：已完成

## 技术分析
当前 daemon 生命周期管理已经能扫到重复实例，但“PID 是否真的是 im2cc daemon”的判定仍然过于宽松，且 CLI 与 daemon 侧实现分叉，容易再次出现误判。
- 涉及模块：`src/index.ts`、`bin/im2cc.ts`、`scripts/smoke.sh`
- 数据结构：复用 `daemon.pid` / `daemon.lock/owner.json`，新增共享 daemon 进程识别模块
- 技术方案：提取统一的 daemon 识别逻辑，要求 PID 必须为正整数且对应进程命令行/进程名能证明自己是 im2cc daemon；同时为新 daemon 增加跨安装路径可识别的 marker/title，并补充回归测试覆盖 stale pid 与异路径重复实例

## 任务清单
### 准备阶段
- [x] 阅读现有守护进程启动逻辑与 CLI 生命周期命令
- [x] 确认上轮修复的边界与本轮遗留缺口
- [x] 技术分析，确定实现路径

### 实现阶段
- [x] 抽取共享 daemon 进程识别模块
- [x] 收紧 PID 回退逻辑，避免误伤非 im2cc 进程
- [x] 为新 daemon 增加跨安装路径的统一身份标记
- [x] 让 CLI 与 daemon 复用同一套生命周期判断

### 测试阶段
- [x] 增加 daemon 生命周期回归测试
- [x] 运行 `npm run smoke`

## 决策记录
| 决策点 | 选择 | 理由 |
|--------|------|------|
| daemon 身份标识 | 同时使用进程标题 + 命令行 marker + 旧路径兼容匹配 | 新版本跨安装路径可识别，同时不丢失对旧 daemon 的识别能力 |
| 回归测试形式 | 使用 Node 内置 `node:test` 跑 smoke 级脚本 | 项目当前没有专门测试框架，适合最小增量补上关键边界 |

## 注意事项
- 项目内没有 `ARCHITECTURE.md`；本次属于局部缺陷修复，继续按现有代码结构实施。

## 完成总结
- 实现了什么：新增共享的 daemon 进程识别模块；CLI 与 daemon 现在都会先验证 PID 是否为正整数、对应进程是否仍然是 `im2cc` daemon，再决定 `running/stale/stop`；新启动的 daemon 会带上统一 marker/title，降低跨安装路径漏检的概率；`smoke` 新增 daemon 生命周期回归测试
- 修改了哪些文件：`src/daemon-process.ts`、`src/index.ts`、`bin/im2cc.ts`、`scripts/smoke.sh`、`scripts/daemon-lifecycle.test.mjs`、`src/_INDEX.md`、`docs/builder-task/04_DaemonIdentityHardening.md`
- 需要用户关注的点：如果你机器上现在还跑着旧版 daemon，仍建议执行一次 `im2cc stop` 后再 `im2cc start`，让新 marker/title 和更严格的锁元数据接管运行态
