#!/usr/bin/env node
/**
 * Cross-platform test runner.
 *
 * `node --test test/` behaves differently across Node versions and shells
 * (and `node --test` with no argument also discovers files outside `test/`),
 * so we resolve the file list ourselves and pass it explicitly.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const testDir = path.resolve(import.meta.dirname, '..', 'test')
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join('test', name))

if (!files.length) {
  console.error('no test files found in test/')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)
