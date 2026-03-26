<!--
@input:    已安装好的 im2cc、已接通的 IM 渠道、用户当前机器
@output:   第一次真实成功体验的验收标准
@rule:     如本文件 @input 或 @output 发生变化，必须更新本注释
-->

# First-run validation

`/fl` alone is not enough for final success.

## Why

- `/help` or `/fl` proves the IM command path works
- but without a real session, it does not prove session flow or device handoff

## Required final validation

1. Create one real session on the computer:
   - `fn demo <project-path>`
2. Ask the user to run `/fl` from IM.
3. Ask the user to run `/fc demo` from IM.

Only after this succeeds should the workflow move to the auto-start decision and completion summary.
