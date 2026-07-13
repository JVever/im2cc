---
project_profile: cli-tool
decision_source: autonomous-inference
ai_inferred_fields:
  - 我们在做什么
  - 为谁
  - 解决什么问题
  - 怎么解决
  - 非目标
---

# Vision

## 我们在做什么

让用户通过飞书或微信，在手机上继续操作电脑中正在运行的 AI coding session。

## 为谁

使用 Claude Code、Codex 或 Gemini CLI，并需要离开电脑后继续推进工作的开发者。

## 解决什么问题

用户离开电脑后，无法继续使用原有 AI coding session；传统远程桌面操作笨重，而另开对话会丢失上下文和运行状态。

## 怎么解决

im2cc 在本机维护 session、执行与状态，通过飞书或微信传递消息，让电脑端与移动端接入同一个真实 session，并保持关键会话状态一致。

## 非目标

- 不做远程桌面。
- 不在云端复制或重新运行本地 AI session。
- 不取代 Claude Code、Codex 或 Gemini CLI。
- 不把电脑端和移动端维护成两份相互独立的会话状态。

---

> 本文档是项目的 North Star。重大转向时才更新，由 /go 在用户授权下维护。
