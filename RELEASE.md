# RELEASE — 发布流程 SOP

面向 maintainer / AI 助手的发布操作手册。任何 AI（Claude Code / Codex / Cursor / Aider 等）或人类在被要求"push 并发布"时，**严格按本文件执行**。

## 前置事实（不要每次再问）

- **分发方式**：npm 全局包（`npm i -g im2cc`）。GitHub 只是源码仓，**不是**分发渠道。
- **源码仓**：`https://github.com/JVever/im2cc.git`（branch：`master`）
- **npm 包名**：`im2cc`
- **语言偏好**：commit message 用中文（参考 `git log --oneline` 风格）
- **不自动重启 daemon**：日常开发 commit 后不要 `im2cc stop/start`；用户执行 `im2cc update` 时代码已自动处理重启（见 `bin/im2cc.ts:cmdUpdate`），所以发布者也无需本地重启。

## 决策表：版本号怎么 bump

按 [semver](https://semver.org/) 判断，**默认 patch**：

| 改动性质 | bump | 示例 |
|---------|------|------|
| bug 修复、性能优化、小改进 | **patch**（0.3.0 → 0.3.1） | 修文案、补边界条件、修错误处理 |
| 新增功能、非破坏性改动 | **minor**（0.3.0 → 0.4.0） | 新命令、新超时策略、新 IM 通道 |
| 破坏 API / 配置向后不兼容 | **major**（0.3.0 → 1.0.0） | 删除命令、字段重命名且不做迁移、协议变更 |

**判断原则**：如果老用户不做任何修改、直接 `im2cc update` 就应该继续工作 → patch / minor；如果需要用户看 changelog 主动调整 → major。

配置字段迁移（如本次 `defaultTimeoutSeconds` → `defaultIdleTimeoutSeconds`）算 **patch** — 因为 `loadConfig` 里做了自动迁移，用户配置继续生效。

## 发布前 checklist

**按顺序检查，任何一步不过就停下来问 maintainer：**

1. `git status --short` — 工作区应该干净（或只有预期 commit 的改动）
2. `git log --oneline origin/master..HEAD` — 确认本地有待推送的 commit
3. `npm run build` — 编译必须通过
4. 按需跑关键测试：`node scripts/queue.test.mjs && node scripts/mode-policy.test.mjs && node scripts/feishu.test.mjs`（改哪个模块就跑对应测试，不必全跑）
5. `npm whoami` — 确认已登录（应是 `jvever`），否则 `npm login`

## 完整发布流程

以下每一步都必须真正执行，**不要跳过**。本地已有改动时从 Step 1 开始；改动已 commit 时从 Step 3 开始。

### Step 1 — 分组 commit（如有未提交改动）

按关切分组，**不要一次提交多个不相关改动**。每个 commit 独立、可回滚。

```bash
git add <相关文件>
git commit -m "$(cat <<'EOF'
<type>(<scope>): <简短中文描述>

<可选：一两句解释 why，不描述 what>

Co-Authored-By: <AI 名称> <noreply@anthropic.com>
EOF
)"
```

type 用 conventional commits 风格：`feat` / `fix` / `chore` / `docs` / `refactor` / `test`。

### Step 2 — push 源码到 GitHub

```bash
git push origin master
```

如果被拒（远端有新 commit）：`git pull --rebase origin master`，解决冲突后再 push。**不要 force push**。

### Step 3 — bump 版本号

```bash
npm version patch   # 或 minor / major，按决策表判断
```

这条命令会：
- 修改 `package.json` 版本号
- 创建一个 `chore: v0.3.x` 风格的 commit
- 打一个 `v0.3.x` 的 git tag

要求工作区干净，所以必须先完成 Step 1-2。

### Step 4 — push tag 到 GitHub

```bash
git push --follow-tags
```

`--follow-tags` 会同时 push commit 和 tag。这一步失败就不要继续 publish——保持 tag 和 npm 版本一致很重要。

### Step 5 — 发布到 npm

```bash
npm publish
```

**认证方式（本账号 `jvever`）**：浏览器 web auth，**不是** authenticator OTP。

流程是：
1. maintainer 在**自己的交互式终端**跑 `npm publish`
2. npm 打印 `Open this URL in your browser to authenticate: https://www.npmjs.com/auth/cli/<uuid>` 并打开浏览器
3. maintainer 在浏览器登录 npmjs.com，点 "Authorize"
4. 本地 npm 进程自动收到 token，继续完成 publish

**AI 助手不要代跑 `npm publish`，也不要建议用 `! npm publish` 前缀**。

实测原因（npm 11.12.1 + auth-type=web）：
- npm 检测 stdout.isTTY。非 TTY → 打印脱敏 URL（UUID 替换成 `***`），直接 `EOTP` 退出，不阻塞等待授权
- debug log（`~/.npm/_logs/*.log`）也脱敏，**拿不到真实 URL**
- Claude Code 的 `!` 前缀 / 后台 Bash / 任何 AI 代跑的子进程**都不是真 TTY**

**唯一可行的做法**：maintainer 手动打开 iTerm / Terminal / 任意独立终端窗口，`cd` 到项目目录后跑 `npm publish`。npm 会：
1. 自动打开浏览器到 `https://www.npmjs.com/auth/cli/<真实 uuid>`
2. **阻塞**等待授权
3. maintainer 在浏览器点 "Authorize" 后，命令自动继续完成 publish

如果 maintainer 没有交互式终端（远程 CI 等场景），改用 `npm token create` 提前生成长期 token，通过 `NPM_TOKEN` 环境变量 + `.npmrc` 的 `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` 发布。本仓库目前不走 CI 发布路径。

如遇网络/registry 问题：
- 检查 `npm config get registry`（应是 `https://registry.npmjs.org/`）
- 避免在发布时挂代理指向非官方镜像

### Step 6 — 验证

```bash
npm view im2cc version   # 应显示刚发布的新版本
```

此时老用户跑 `im2cc update` 就能拿到新版，并自动重启 daemon。

## 常见失败处理

| 现象 | 处置 |
|-----|-----|
| `npm version` 报工作区不干净 | 先 commit / stash，再重试 |
| `npm publish` 报 403 / E402 | 检查 `npm whoami` 和包权限 |
| `npm publish` 报 EOTP / 要求 OTP 或 "Open this URL in your browser" | 见 Step 5 认证方式 — 本账号用浏览器 web auth |
| `git push` 被拒（non-fast-forward） | `git pull --rebase`，**不要** `--force` |
| 发现已 publish 但代码有 bug | **不要** `npm unpublish`（24h 后不可撤）；发 patch 版本修复 |
| `npm view im2cc version` 滞后 | 正常，CDN 有 1-2 分钟延迟 |

## 对 AI 助手的要求

- **不要擅自 `npm publish`**。每次发布都必须得到 maintainer 在当次对话中的明确授权（"发布"、"publish"、"走完流程"等明确意图）。
- **严格按本文件顺序执行**，每步 echo 输出给 maintainer 看，别合并 & 静默执行。
- **commit message 写中文**，和 `git log` 风格保持一致。
- 如果本文件步骤与当前状况有冲突（比如要跳步、要 force push、要 unpublish），**停下来问 maintainer**，不要自作主张。
