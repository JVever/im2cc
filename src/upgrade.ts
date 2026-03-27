/**
 * @input:    当前 CLI 所在目录、安装根目录文件清单
 * @output:   detectInstallRoot(), listReplaceableInstallEntries(), PUBLIC_ARCHIVE_URL
 * @rule:     如本文件 @input 或 @output 发生变化，必须更新本注释并检查 _INDEX.md
 */

import fs from 'node:fs'
import path from 'node:path'

export const PUBLIC_ARCHIVE_URL = 'https://codeload.github.com/JVever/im2cc/tar.gz/refs/heads/master'

export interface InstallRootInfo {
  root: string
  packageJsonPath: string
  installScriptPath: string
  isGitCheckout: boolean
}

export function detectInstallRoot(startDir: string): InstallRootInfo | null {
  let current = path.resolve(startDir)

  while (true) {
    const packageJsonPath = path.join(current, 'package.json')
    const installScriptPath = path.join(current, 'install.sh')

    if (fs.existsSync(packageJsonPath) && fs.existsSync(installScriptPath)) {
      return {
        root: current,
        packageJsonPath,
        installScriptPath,
        isGitCheckout: fs.existsSync(path.join(current, '.git')),
      }
    }

    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function listReplaceableInstallEntries(root: string): string[] {
  return fs.readdirSync(root).filter(name => name !== '.git' && name !== 'node_modules')
}
