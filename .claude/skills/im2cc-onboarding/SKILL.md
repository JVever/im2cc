---
name: im2cc-onboarding
description: "Complete the full im2cc onboarding journey after the repository is available locally: install dependencies, build and register im2cc, connect Feishu or WeChat, call $create-feishu-bot when needed, validate the mobile command path, create the first real session, and enable auto-start. Use when the user asks to install, configure, continue, repair, or validate im2cc."
---

# im2cc Onboarding

Use this skill after the `im2cc` repository is already present on disk. This skill is the repo-local onboarding orchestrator for zero-to-one setup and first-run success.

If the user only provides the GitHub URL before checkout:

- treat `https://github.com/JVever/im2cc.git` as a public repo
- prefer plain `git clone` over HTTPS
- do not depend on `gh auth login`
- do not assume any authenticated GitHub integration is required
- if `git clone` fails but ordinary HTTPS downloads still work, fall back to the public source archive:

  ```bash
  mkdir -p ~/im2cc
  curl -L https://codeload.github.com/JVever/im2cc/tar.gz/refs/heads/master | tar -xz -C ~/im2cc --strip-components=1
  ```

- if both checkout paths fail, first diagnose missing `git` or network/proxy issues

## Scope

This skill owns the full journey from repository checkout to real mobile usage:

- base installation
- IM channel selection
- Feishu or WeChat setup
- first command-path validation
- first real session creation and mobile attach
- auto-start setup

This skill must not re-implement generic Feishu bot creation. Use `$create-feishu-bot` for that branch.

## State machine

Always detect the current state before acting.

Possible states:

1. `bootstrap_pending`
2. `core_install_pending`
3. `channel_selection_pending`
4. `feishu_setup_pending`
5. `wechat_setup_pending`
6. `transport_validation_pending`
7. `first_session_pending`
8. `autostart_pending`
9. `ready`

Read `references/state-machine.md` for transitions and recovery behavior.

## Primary workflow

### 1. Detect current install status

Inspect:

- whether `im2cc` is available on PATH
- whether Node.js, tmux, and at least one supported AI CLI are available
- whether the repo has been built
- whether `~/.im2cc/config.json` exists
- whether WeChat is already bound
- whether Feishu credentials exist and appear valid

Read `references/install-flow.md` before making changes.

### 2. Complete base installation

If base installation is incomplete:

- install dependencies
- build the project
- register `im2cc`
- install shell helpers
- install the Claude session-sync hook

Do not stop after `bash install.sh` unless the user explicitly asked for a shallow install.

### 3. Select the channel

Ask the user only if the request did not already specify it:

- Feishu
- WeChat
- both

### 4. Run the selected branch

If Feishu is selected:

- inspect current Feishu config
- reuse existing credentials if valid
- otherwise ask whether the user already has a reusable Feishu bot
- if not, call `$create-feishu-bot`
- persist the returned `app_id` and `app_secret` into `~/.im2cc/config.json`

Read `references/feishu-branch.md`.

If WeChat is selected:

- verify ClawBot prerequisite
- run login
- wait for successful bind

Read `references/wechat-branch.md`.

### 5. Validate the transport path

After channel setup:

- run `im2cc start`
- run `im2cc doctor`
- ask the user to send `/fhelp` or `/fl` from IM

This validates message ingress and reply, but it does not yet prove real session flow.

### 6. Validate a real session flow

Before declaring success:

- prefer asking the user (or the agent itself) to `cd` into the target project first, then create one real session with `fn demo`
- only pass an explicit path when the current directory is not the target project
- ask the user to run `/fl`
- ask the user to run `/fc demo`

Only after this succeeds is onboarding considered complete.

Read `references/first-run-validation.md`.

### 7. Offer auto-start

Once the real session flow works:

- ask whether the user wants auto-start enabled
- if yes, install and load the macOS LaunchAgent
- verify with `im2cc status` or `im2cc doctor`

## Minimal user interruptions

Interrupt the user only for:

- channel choice
- Feishu browser takeover permission
- Feishu login if no usable session exists
- WeChat QR scan
- IM-side validation commands
- auto-start opt-in

## Completion standard

Do not mark onboarding complete until all applicable checks pass:

- `im2cc doctor`
- IM responds to `/fhelp` or `/fl`
- one real session exists
- `/fc <name>` works from IM
- user has made a choice about auto-start

## References

- Read `references/state-machine.md` for transitions.
- Read `references/install-flow.md` for base install steps.
- Read `references/feishu-branch.md` for Feishu logic and `$create-feishu-bot` handoff.
- Read `references/wechat-branch.md` for WeChat logic.
- Read `references/first-run-validation.md` for the final success criteria.
