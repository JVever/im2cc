<!--
@input:    im2cc 仓库、本机依赖、PATH、配置文件
@output:   基础安装与首次启动的执行规则
@rule:     如本文件 @input 或 @output 发生变化，必须更新本注释
-->

# Install flow

## Base checks

Verify:

- Node.js >= 20
- tmux
- at least one supported AI CLI
- repo checkout present

## Base install

Run:

- `npm install`
- `npm run build`
- `npm link`

Then ensure:

- shell helpers are installed
- Claude session-sync hook is installed
- `im2cc doctor` runs successfully

## Important rule

Do not stop at "install script succeeded". The workflow must continue into channel setup and real validation.
