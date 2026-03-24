# DaemonDuplicateStartGuard - Builder任务工单

## 基本信息
- PRD文档：无（线上缺陷修复）
- 开始时间：2026-03-24 13:27:49 +0800
- 状态：已完成

## 技术分析
问题不是会话绑定错投，而是同一台机器上存在多个 `im2cc` daemon 同时轮询同一个飞书 Bot，导致同一条消息被重复消费。
- 涉及模块：`src/index.ts`、`bin/im2cc.ts`
- 数据结构：复用现有 `daemon.pid` / `daemon.lock`，新增基于 daemon 入口路径的真实进程发现
- 技术方案：启动前和状态检查时，补充 `pgrep -f <daemon-entry>` 进程扫描；对老版本 daemon 即使丢失 pid/lock 也能识别，避免新实例继续启动

## 任务清单
### 准备阶段
- [x] 阅读现有守护进程启动逻辑与消息路由实现
- [x] 确认问题根因是重复 daemon 而非 binding/tool 路由
- [x] 技术分析，确定实现路径

### 实现阶段
- [x] 在 daemon 启动入口增加真实进程扫描兜底
- [x] 在 CLI 的 start/status/stop/doctor 中增加重复实例识别
- [x] 核对文案与运行态提示

### 测试阶段
- [x] 运行 `npm run smoke`
- [x] 检查 TypeScript 编译输出

## 决策记录
| 决策点 | 选择 | 理由 |
|--------|------|------|
| 重复实例检测方式 | `pid/lock` 之外再扫真实进程列表 | 兼容旧版本 daemon 丢失 pid/lock 的情况 |
| 修复范围 | 先修 daemon 生命周期，不动消息协议 | 当前根因已明确，不需要扩大修改面 |

## 注意事项
- 当前机器上很可能仍有旧 daemon 在跑；代码修复后仍需要执行一次停机/重启，才能把旧实例清掉。

## 完成总结
- 实现了什么：为 daemon 生命周期补了“真实进程扫描”兜底，避免旧版本 daemon 丢失 pid/lock 后仍与新实例并存；CLI 现在也会识别并提示重复实例
- 修改了哪些文件：`src/index.ts`、`bin/im2cc.ts`、`docs/builder-task/03_DaemonDuplicateStartGuard.md`
- 需要用户关注的点：当前机器上已经存在的旧 daemon 不会被代码自动抹掉，需要你本机执行一次 `im2cc stop` 或手工清理后再 `im2cc start`
