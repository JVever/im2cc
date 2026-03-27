# im2cc Agent Instructions

This repository includes a full onboarding workflow for installing, configuring, validating, and hardening im2cc on a user's machine.

## When to use the onboarding workflow

Use the repo-local `im2cc-onboarding` skill when the user wants any of the following:

- install im2cc from scratch
- continue or repair an interrupted im2cc installation
- connect Feishu or WeChat to im2cc
- validate whether im2cc is truly usable on mobile
- enable im2cc auto-start on login

## Preferred execution model

Treat onboarding as a stateful workflow, not as a one-shot shell script.

When the repository is not yet present locally:

- treat `https://github.com/JVever/im2cc.git` as a public repository
- prefer plain `git clone` over HTTPS
- do not require `gh auth login`
- do not route through authenticated GitHub APIs or integrations unless the user explicitly asks for that path
- if `git clone` fails but ordinary HTTPS downloads still work, fall back to downloading the public source archive:

  ```bash
  mkdir -p ~/im2cc
  curl -L https://codeload.github.com/JVever/im2cc/tar.gz/refs/heads/master | tar -xz -C ~/im2cc --strip-components=1
  ```

- if both checkout paths fail, diagnose `git` availability and network access before asking the user to log in anywhere

You should:

1. detect the current install state
2. complete missing base installation steps
3. ask which IM channel the user wants: Feishu, WeChat, or both
4. if Feishu is chosen and no working bot exists, call `$create-feishu-bot`
5. write the returned credentials into `~/.im2cc/config.json`
6. start and validate the daemon
7. help the user create one real session and attach to it from mobile
8. offer to enable auto-start

## Validation standard

Do not stop after `im2cc start`.

A successful onboarding requires:

- `im2cc doctor` passes basic checks
- the IM side responds to `/help` or `/fl`
- the user creates one real session via `fn <name>` when already inside the project directory, or `fn <name> <path>` when not
- terminal convenience aliases `fn-codex` and `fn-gemini` are acceptable shortcuts on the computer side
- the user can see that session from IM and attach with `/fc <name>`

Only after this flow succeeds should onboarding be considered complete.

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
