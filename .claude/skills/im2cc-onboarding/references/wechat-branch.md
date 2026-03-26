<!--
@input:    用户是否选择微信、ClawBot 可用性、扫码状态
@output:   微信接入分支的处理规则
@rule:     如本文件 @input 或 @output 发生变化，必须更新本注释
-->

# WeChat branch

## Prerequisite

Confirm the user has ClawBot enabled in WeChat.

## Flow

- run `im2cc wechat login`
- wait for QR-based bind success
- verify with `im2cc doctor`
- ask the user to send `/help` or `/fl`

Then continue into first real session validation.
