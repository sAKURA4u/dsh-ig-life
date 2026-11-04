/**
 * The plugin's own log file: rotation, redaction, and the promise that logging
 * can never take a turn down.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createFileLogger, redact } from '../lib/filelog.js'
import { tempDir } from './helpers.js'

test('a line is appended with a timestamp and level', async () => {
  const dir = tempDir('ig-life-log-')
  const log = createFileLogger({ dir })
  log('info', '[ig-life] did not answer @friend: quiet hours')
  await log.flush()

  const text = fs.readFileSync(path.join(dir, 'bridge.log'), 'utf8')
  assert.match(text, /^\[\d{4}-\d{2}-\d{2}T/)
  assert.match(text, / INFO /)
  assert.match(text, /did not answer @friend/)
})

test('secrets are redacted before they reach the disk', async () => {
  const dir = tempDir('ig-life-log-')
  const log = createFileLogger({ dir })
  log('warn', 'login failed sessionid=abc123%3A%3Azzz&password=hunter2 api_key=sk-live')
  await log.flush()

  const text = fs.readFileSync(path.join(dir, 'bridge.log'), 'utf8')
  assert.ok(!text.includes('abc123'), text)
  assert.ok(!text.includes('hunter2'), text)
  assert.ok(!text.includes('sk-live'), text)
  assert.match(text, /\[redacted\]/)
})

test('redact keeps the key name so the line still reads', () => {
  assert.equal(redact('token=abc'), 'token=[redacted]')
})

test('the log rotates at the size cap and keeps one old file', async () => {
  const dir = tempDir('ig-life-log-')
  const log = createFileLogger({ dir, maxBytes: 200, keep: 1 })
  for (let i = 0; i < 20; i += 1) log('info', `line ${i} ${'x'.repeat(40)}`)
  await log.flush()

  const current = fs.statSync(path.join(dir, 'bridge.log')).size
  const rotated = fs.statSync(path.join(dir, 'bridge.log.1'))
  assert.ok(current <= 260, `current was ${current}`)
  assert.ok(rotated.size > 0)
})

test('a broken log path never throws into the caller', async () => {
  const dir = tempDir('ig-life-log-')
  // A file where the directory should be: appendFile/mkdir both fail.
  const blocked = path.join(dir, 'not-a-dir')
  fs.writeFileSync(blocked, 'x')
  const log = createFileLogger({ dir: path.join(blocked, 'nested') })
  assert.doesNotThrow(() => log('info', 'this must not explode'))
  await log.flush()
})

test('the host logger still receives every line', async () => {
  const dir = tempDir('ig-life-log-')
  const seen = []
  const log = createFileLogger({ dir, host: (level, message) => seen.push(`${level}:${message}`) })
  log('warn', 'boom')
  await log.flush()
  assert.deepEqual(seen, ['warn:boom'])
})
