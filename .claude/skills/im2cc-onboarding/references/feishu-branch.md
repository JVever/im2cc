<!--
@input:    用户是否选择飞书、现有凭证、项目中的飞书接入方式
@output:   飞书接入分支的处理规则
@rule:     如本文件 @input 或 @output 发生变化，必须更新本注释
-->

# Feishu branch

## Decision order

1. Check whether `~/.im2cc/config.json` already contains `appId` and `appSecret`.
2. If present, validate them before asking the user to create anything.
3. If missing or invalid, ask whether the user already has a reusable Feishu bot.
4. If not, call `$create-feishu-bot`.

## Handoff rule

Consume only the generic handoff result from `$create-feishu-bot`.

Persist into `~/.im2cc/config.json`:

- `feishu.appId`
- `feishu.appSecret`

Do not require a fixed `chat_id` because im2cc discovers joined chats dynamically.

## Validation

After writing config:

- `im2cc start`
- `im2cc doctor`
- user sends `/help` or `/fl`

Then continue into first real session validation.
