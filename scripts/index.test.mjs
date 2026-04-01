import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'im2cc-index-'))
process.env.HOME = testHome

const commands = await import(path.join(rootDir, 'dist', 'src', 'commands.js'))
const index = await import(path.join(rootDir, 'dist', 'src', 'index.js'))

test('shouldSendFcRecap only allows recap after a fresh successful /fc attach', () => {
  const fcCmd = commands.parseCommand('/fc spark')
  assert.ok(fcCmd)

  assert.equal(index.shouldSendFcRecap(fcCmd, false, true, 2000), true)
  assert.equal(index.shouldSendFcRecap(fcCmd, true, true, 2000), false)
  assert.equal(index.shouldSendFcRecap(fcCmd, false, false, 2000), false)
  assert.equal(index.shouldSendFcRecap(fcCmd, false, true, 0), false)

  const flCmd = commands.parseCommand('/fl')
  assert.ok(flCmd)
  assert.equal(index.shouldSendFcRecap(flCmd, false, true, 2000), false)
})
