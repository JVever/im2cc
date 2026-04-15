import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const upgrade = await import(path.join(rootDir, 'dist', 'src', 'upgrade.js'))

function makeTmpRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeIm2ccPackageJson(dir) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'im2cc', version: '0.0.0' }))
}

test('detectInstallRoot finds im2cc package.json walking up from nested dir', () => {
  const tmp = makeTmpRoot('im2cc-root-')
  const nested = path.join(tmp, 'dist', 'bin')
  fs.mkdirSync(nested, { recursive: true })
  writeIm2ccPackageJson(tmp)
  fs.mkdirSync(path.join(tmp, '.git'))

  const info = upgrade.detectInstallRoot(nested)
  assert.ok(info)
  assert.equal(info.root, tmp)
  assert.equal(info.mode, 'git-checkout')
})

test('detectInstallRoot returns null when no im2cc package.json exists', () => {
  const tmp = makeTmpRoot('im2cc-missing-')
  const nested = path.join(tmp, 'dist', 'bin')
  fs.mkdirSync(nested, { recursive: true })

  const info = upgrade.detectInstallRoot(nested)
  assert.equal(info, null)
})

test('detectInstallRoot skips package.json whose name is not "im2cc"', () => {
  const tmp = makeTmpRoot('im2cc-foreign-')
  const nested = path.join(tmp, 'inner')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'some-other-pkg' }))

  const info = upgrade.detectInstallRoot(nested)
  assert.equal(info, null)
})

test('detectInstallRoot classifies npm-global install by path pattern', () => {
  const tmp = makeTmpRoot('npmglobal-')
  // 模拟 npm global 安装路径
  const im2ccRoot = path.join(tmp, 'lib', 'node_modules', 'im2cc')
  const binDir = path.join(im2ccRoot, 'dist', 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  writeIm2ccPackageJson(im2ccRoot)

  const info = upgrade.detectInstallRoot(binDir)
  assert.ok(info)
  assert.equal(info.root, im2ccRoot)
  assert.equal(info.mode, 'npm-global')
})

test('detectInstallRoot classifies tarball install (install.sh but no .git)', () => {
  const tmp = makeTmpRoot('tarball-')
  writeIm2ccPackageJson(tmp)
  fs.writeFileSync(path.join(tmp, 'install.sh'), '#!/bin/bash\n')

  const info = upgrade.detectInstallRoot(tmp)
  assert.ok(info)
  assert.equal(info.mode, 'tarball')
})

test('detectInstallRoot classifies unknown install (no .git, no install.sh, not under node_modules/im2cc)', () => {
  const tmp = makeTmpRoot('unknown-')
  writeIm2ccPackageJson(tmp)

  const info = upgrade.detectInstallRoot(tmp)
  assert.ok(info)
  assert.equal(info.mode, 'unknown')
})

test('NPM_PACKAGE_NAME and PUBLIC_REPO_URL constants are exported', () => {
  assert.equal(upgrade.NPM_PACKAGE_NAME, 'im2cc')
  assert.equal(upgrade.PUBLIC_REPO_URL, 'https://github.com/JVever/im2cc')
})
