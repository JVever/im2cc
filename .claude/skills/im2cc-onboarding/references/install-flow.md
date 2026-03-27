<!--
@input:    im2cc 仓库、本机依赖、PATH、配置文件
@output:   基础安装与首次启动的执行规则
@rule:     如本文件 @input 或 @output 发生变化，必须更新本注释
-->

# Install flow

## Base checks

Verify:

- `git` is available
- Node.js >= 20
- tmux
- at least one supported AI CLI
- repo checkout present

## Checkout rule

Before checkout:

- prefer `git clone https://github.com/JVever/im2cc.git`
- treat the repo as public
- do not require `gh auth login`
- if `git clone` fails but ordinary HTTPS downloads still work, fall back to the public source archive:

  ```bash
  mkdir -p ~/im2cc
  curl -L https://codeload.github.com/JVever/im2cc/tar.gz/refs/heads/master | tar -xz -C ~/im2cc --strip-components=1
  ```

- if both checkout paths fail, diagnose missing `git`, network, proxy, or filesystem permission issues before asking the user to authenticate anywhere

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
