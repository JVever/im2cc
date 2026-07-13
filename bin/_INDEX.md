# bin
> **重要** 本目录结构或子文件职责变化时，必须更新此文件。

## 职责
im2cc 命令行入口，提供守护进程管理和完整 session 管理命令

## 文件清单
- im2cc.ts：CLI 入口 (start/stop/status/logs/sessions/new/connect/list/delete/detach/show/setup/secure/onboard/install-service/install-hook/doctor/help/update/wechat/fqon/fqoff/fqs；connect 做模型精确交接，install-hook 防第三方 statusline 闭环；兼容旧别名 upgrade)
