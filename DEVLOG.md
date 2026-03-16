# im2cc 开发日志

## 2026-03-16 — 项目启动 + MVP 完成

### 背景
用户需要在手机上（iPhone + 鸿蒙6）通过飞书远程控制家里电脑上的 Claude Code。
现有方案的痛点：
- Happy Code: 上下文同步失败、结构化输出卡死
- Tailscale + Terminus + Tmux: 频繁断连、鸿蒙显示异常

### 设计过程
1. 分析了 claude-to-im 开源项目（op7418/Claude-to-IM-skill），发现其核心问题：使用 Agent SDK 创建独立 session，无法回到电脑后接续
2. 提出核心创新：用 CLI spawn（`claude -p --resume`）替代 Agent SDK，复用 CLI 原生 session
3. 经过 4 轮多模型评审（Claude + Codex），大幅精简方案：
   - 砍掉了自动摘要/轮换、单写锁、多 CLI 抽象等过度设计
   - 定位为"轻量级远程转发层"
4. 评审记录保存在 `~/Code/16-远程工作方案/cross-review-records/`

### 前置验证结果
| 验证项 | 结果 |
|--------|------|
| 飞书个人版 Bot | ✅ 用户已有多个 Bot |
| 20 轮 resume 稳定性 | ✅ 精确回忆第 1 轮密码 |
| session 等价性 | ✅ -p 创建的 session 可被完整 resume |
| stream-json 完整性 | ✅ 需要 --verbose 标志 |

### 关键技术发现
1. `stream-json` 必须配合 `--verbose` 使用
2. `--session-id` 用于首次创建，`--resume` 用于后续（不能混用）
3. session 文件存储在 `~/.claude/projects/<hash>/<session-id>.jsonl`
4. Claude Code Memory 跨 session 共享
5. session ID 必须是合法 UUID（全十六进制）
6. `claude --resume <id>` 必须在正确的项目 cwd 下运行
7. 交互式 Claude Code 进程不暴露 session ID，无法通过 pgrep/lsof 定位 → 改用 tmux 管理

### 项目命名
feishu-cc → im2cc (IM to Claude Code)

### 开发里程碑
1. MVP 核心代码完成（飞书收发 + Claude 驱动 + 命令系统）
2. UX 优化：智能路径解析、YOLO 模式、简化 resume
3. /attach → 接入电脑上已有对话（文件系统扫描 + slug 反推）
4. 命名注册表：永久寻址，不受时间限制
5. tmux 集成：可靠的进程生命周期控制
6. 独占访问：同一 session 永远只在一个地方活跃
7. 统一命令：fn/fc/fl/fk/fd/fs，电脑和飞书完全一致
8. daemon 端防线：每条消息前检查 tmux 独占
9. 端到端测试通过

### 遗留风险
| 风险 | 等级 | 应对 |
|------|------|------|
| CLI 升级可能破坏 session 兼容 | 高 | im2cc doctor 检测 + 手动 fn 新建 |
| 长 session 质量退化 | 中 | 用户手动 fn 新建 |
| 飞书消息被飞书服务器存储 | 中 | 个人使用可接受 |
| 超长输出截断 | 低 | 提示回电脑查看 |

### 代码统计
- 总计 ~2336 行（13 个 TypeScript 文件 + 1 个 Shell 脚本）
- 直接依赖：@larksuiteoapi/node-sdk
- 13 个 git commits

---
