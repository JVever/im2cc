<!--
@input:    当前机器上的 im2cc 安装状态、配置状态、渠道接入状态
@output:   onboarding 状态机定义与恢复规则
@rule:     如本文件 @input 或 @output 发生变化，必须更新本注释
-->

# State machine

Use state detection before execution so the workflow can resume safely.

## States

- `bootstrap_pending`: repo exists but no install progress is visible
- `core_install_pending`: dependencies/build/link/hook/shell setup incomplete
- `channel_selection_pending`: core install complete, no IM channel selected
- `feishu_setup_pending`: Feishu requested but not usable yet
- `wechat_setup_pending`: WeChat requested but not usable yet
- `transport_validation_pending`: config exists, transport not validated from mobile
- `first_session_pending`: transport responds, but no real session attach has been validated
- `autostart_pending`: end-to-end works, auto-start not yet decided
- `ready`: onboarding complete

## Recovery rules

- Never restart from scratch if valid progress already exists.
- Prefer verifying an existing configuration over recreating it.
- If credentials exist but fail validation, branch into repair mode rather than wiping state.
