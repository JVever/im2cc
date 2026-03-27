import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const upgrade = await import(path.join(rootDir, 'dist', 'src', 'upgrade.js'))

test('detectInstallRoot walks up from dist/bin to repo root markers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-upgrade-root-'))
  const nested = path.join(tmp, 'dist', 'bin')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(tmp, 'package.json'), '{}')
  fs.writeFileSync(path.join(tmp, 'install.sh'), '#!/bin/bash\n')
  fs.mkdirSync(path.join(tmp, '.git'))

  const info = upgrade.detectInstallRoot(nested)
  assert.ok(info)
  assert.equal(info.root, tmp)
  assert.equal(info.isGitCheckout, true)
})

test('detectInstallRoot returns null when required markers are missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-upgrade-missing-'))
  const nested = path.join(tmp, 'dist', 'bin')
  fs.mkdirSync(nested, { recursive: true })

  const info = upgrade.detectInstallRoot(nested)
  assert.equal(info, null)
})

test('listReplaceableInstallEntries preserves node_modules and .git', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-upgrade-entries-'))
  fs.mkdirSync(path.join(tmp, '.git'))
  fs.mkdirSync(path.join(tmp, 'node_modules'))
  fs.mkdirSync(path.join(tmp, 'dist'))
  fs.writeFileSync(path.join(tmp, 'README.md'), '# test\n')

  const entries = upgrade.listReplaceableInstallEntries(tmp).sort()
  assert.deepEqual(entries, ['README.md', 'dist'])
})

test('PUBLIC_ARCHIVE_URL points to the public GitHub source archive', () => {
  assert.match(upgrade.PUBLIC_ARCHIVE_URL, /codeload\.github\.com\/JVever\/im2cc\/tar\.gz\/refs\/heads\/master/)
})
