# im2cc Agent Instructions

> 本文件是 im2cc 跨工具项目规则的唯一真相源；`CLAUDE.md` 是指向本文件的软链。Claude Code、Codex 及其他 coding agent 应读取同一份项目事实。

## Shared rules

Before working in this repository, read `~/.ai-rules/software-project.md` in full and follow it together with this file. Repository-specific rules in this file take precedence when they are more specific.

## Project development context

im2cc remotely controls local AI coding tools (Claude Code, Codex, and Gemini) through Feishu or WeChat. It is a TypeScript + Node.js project with a macOS LaunchAgent daemon.

### Required reading

- Read `PROJECT.md` at the start of every task for the current architecture, design decisions, command system, and stack.
- Before changing a directory, read its `_INDEX.md` when present.
- Before changing a source file, read its `@input` / `@output` header when present.
- For release, push, or publish work, follow `RELEASE.md` as described below.

### Architecture invariants

- **Single daemon instance**: startup cleanup, runtime self-check, and the lock file jointly enforce that only one daemon is active.
- **Registry ownership**: `registry.json` is the authoritative source of session identity; tmux names are process-management labels only.
- **Exclusive access**: a session can be controlled from only one endpoint at a time.
- **Mode ownership**: `src/mode-policy.ts` is the single source of truth for tool permission modes.
- **Non-interactive execution**: the daemon invokes tool CLIs with non-interactive flags; Claude Plan mode is unavailable on this path, and other interactive-only modes must not be assumed available.

### Key files

| Change | Read first |
|---|---|
| Commands such as `/fn`, `/fc`, `/mode` | `src/commands.ts` |
| Permission modes | `src/mode-policy.ts` |
| Claude / Codex / Gemini invocation | `src/*-driver.ts` |
| Message queue | `src/queue.ts` |
| IM receive path | `src/feishu.ts` or `src/wechat.ts` |
| CLI entrypoint | `bin/im2cc.ts` |
| Shell commands | `shell/im2cc-shell-functions.zsh` |
| Session binding | `src/session.ts` and `src/registry.ts` |
| Configuration | `src/config.ts`; runtime data is under `~/.im2cc/` |
| Daemon lifecycle | `src/index.ts` and `src/daemon-process.ts` |

### Verification

Run the checks relevant to the change; TypeScript changes must at least compile:

```bash
npm run build
node scripts/mode-policy.test.mjs
node scripts/tool-cli-args.test.mjs
node scripts/support-policy.test.mjs
```

## Onboarding and release workflows

This repository includes:
- a full onboarding workflow for installing, configuring, validating, and hardening im2cc on a user's machine (below);
- a maintainer release SOP at [`RELEASE.md`](./RELEASE.md) — **any AI assistant asked to "push" / "release" / "publish" im2cc must follow RELEASE.md step-by-step**, not improvise. Do not run `npm publish` without explicit maintainer authorization in the current conversation.

## When to use the onboarding workflow

Use the repo-local `im2cc-onboarding` skill when the user wants any of the following:

- install im2cc from scratch
- continue or repair an interrupted im2cc installation
- connect Feishu or WeChat to im2cc
- validate whether im2cc is truly usable on mobile
- enable im2cc auto-start on login

## Preferred execution model

Treat onboarding as a stateful workflow, not as a one-shot shell script.

Install im2cc via npm global:

```bash
npm i -g im2cc
im2cc onboard
```

- If `npm i -g im2cc` reports permission issues, help the user configure `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `$PATH`, then retry.
- If `npm i -g im2cc` returns 404 (package not yet published), fall back to source bootstrap:
  ```bash
  git clone https://github.com/JVever/im2cc.git && cd im2cc && bash install.sh
  im2cc install-shell && im2cc install-hook && im2cc onboard
  ```
- Do not rely on `gh auth login` or authenticated GitHub APIs.

You should:

1. detect the current install state (run `im2cc doctor` if already installed)
2. complete missing base installation steps
3. ask which IM channel the user wants to set up first: Feishu or WeChat
4. prefer completing one IM end-to-end before offering the second
5. if Feishu is chosen and no working bot exists, call `$create-feishu-bot`
6. write the returned credentials into `~/.im2cc/config.json`
7. start and validate the daemon
8. help the user create one real session and attach to it from mobile
9. after first success, continue with auto-start and basic security hardening (`im2cc secure`)

## Validation standard

Do not stop after `im2cc start`.

A successful onboarding requires:

- `im2cc doctor` passes basic checks
- the IM side responds to `/fhelp` or `/fl`
- the user creates one real session via `fn <name>` when already inside the project directory, or `fn <name> <path>` when not
- terminal convenience aliases `fn-codex` and `fn-gemini` are acceptable shortcuts on the computer side
- the user can see that session from IM and attach with `/fc <name>`

Only after this flow succeeds should onboarding move into post-success hardening.

Do not stop at first success if the user asked you to complete the setup. Continue until:

- auto-start is enabled or explicitly skipped by the user
- basic security hardening is completed or explicitly skipped by the user

## Feishu branch

If the user selects Feishu:

- first check whether `~/.im2cc/config.json` already has valid `appId` and `appSecret`
- if not, ask whether the user already has a reusable Feishu bot
- if not, use `$create-feishu-bot`
- prefer project inference using this repository to derive required permissions

## WeChat branch

If the user selects WeChat:

- verify the user has ClawBot enabled
- run `im2cc wechat login`
- wait for QR-based login completion

## User interruption policy

Minimize user interruptions. Only stop for:

- channel selection
- Feishu browser takeover permission
- Feishu login when no usable session exists
- WeChat QR scan
- final mobile-side validation commands
- auto-start opt-in
- security hardening confirmation
