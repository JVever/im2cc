/**
 * @input:    当前 CLI 所在目录、安装根目录 package.json / .git / install.sh 文件
 * @output:   detectInstallRoot(), InstallMode, PUBLIC_REPO_URL
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'

export const PUBLIC_REPO_URL = 'https://github.com/JVever/im2cc'
export const NPM_PACKAGE_NAME = 'im2cc'

export type InstallMode = 'npm-global' | 'git-checkout' | 'tarball' | 'unknown'

export interface InstallRootInfo {
  root: string
  packageJsonPath: string
  mode: InstallMode
}

function detectInstallMode(root: string): InstallMode {
  if (fs.existsSync(path.join(root, '.git'))) return 'git-checkout'
  // npm 全局安装：路径里带 node_modules/im2cc（macOS/Linux 均如此；Windows 会是反斜杠）
  const normalized = root.replace(/\\/g, '/')
  if (/\/node_modules\/im2cc(\/|$)/.test(normalized)) return 'npm-global'
  // 有 install.sh 但没 .git → 历史 tarball 安装（已弃用）
  if (fs.existsSync(path.join(root, 'install.sh'))) return 'tarball'
  return 'unknown'
}

export function detectInstallRoot(startDir: string): InstallRootInfo | null {
  let current = path.resolve(startDir)

  while (true) {
    const packageJsonPath = path.join(current, 'package.json')
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { name?: string }
        if (pkg.name === NPM_PACKAGE_NAME) {
          return {
            root: current,
            packageJsonPath,
            mode: detectInstallMode(current),
          }
        }
      } catch {
        // package.json 损坏，往上继续找
      }
    }

    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}
