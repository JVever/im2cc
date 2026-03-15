# im2cc 开发日志

## 2026-03-16 — 项目启动

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

### 项目命名
feishu-cc → im2cc (IM to Claude Code)

---
