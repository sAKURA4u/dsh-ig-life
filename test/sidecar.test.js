/**
 * Sidecar supervisor: the piece that makes "install it and it works" possible.
 *
 * Everything here is injected — spawn, health checks, the clock — so the tests
 * never start a Python process.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import test from 'node:test'

import { createSidecarSupervisor } from '../lib/sidecar.js'
import { makeConfig, tempDir } from './helpers.js'

function fakeChild(pid = 4242) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
    child.emit('exit', 0, null)
  }
  return child
}

function upOnly(up) {
  return async () => ({ ok: up })
}

function supervisor({ up = false, spawnImpl = null, fetchImpl = null, spawnSyncImpl = null, pluginRoot = null } = {}) {
  const store = { dir: tempDir('ig-life-sidecar-') }
  const config = makeConfig({ transport: 'unofficial', unofficial: { autoStart: true, startTimeoutSeconds: 5 } })
  const calls = []
  const supervisorInstance = createSidecarSupervisor({
    config,
    store,
    logger: () => {},
    spawnImpl:
      spawnImpl ??
      ((command, args, options) => {
        calls.push({ command, args, options })
        return fakeChild()
      }),
    spawnSyncImpl: spawnSyncImpl ?? (() => ({ status: 0 })),
    fetchImpl: fetchImpl ?? upOnly(up),
    sleep: async () => {},
    now: (() => {
      let t = 0
      return () => (t += 100)
    })(),
    platform: 'win32',
    pluginRoot: pluginRoot ?? path.resolve('D:/fake/plugin'),
  })
  return { supervisor: supervisorInstance, store, calls, config }
}

test('an already-running sidecar is adopted, not duplicated', async () => {
  let spawned = 0
  const { supervisor: sup } = supervisor({
    up: true,
    spawnImpl: () => {
      spawned += 1
      return fakeChild()
    },
  })
  const state = await sup.ensure()
  assert.equal(state.running, true)
  assert.equal(state.adopted, true)
  assert.equal(state.managed, false)
  assert.equal(spawned, 0, 'never start a second process on the same port')
})

test('a stopped sidecar is started from the plugin root', async () => {
  let up = false
  const child = fakeChild()
  const { supervisor: sup, calls } = supervisor({ spawnImpl: () => child })
  // First health check fails, the one after the spawn succeeds.
  const fetches = [false, false, true]
  const withFetch = createSidecarSupervisor({
    config: makeConfig({ transport: 'unofficial', unofficial: { autoStart: true, startTimeoutSeconds: 5 } }),
    store: { dir: tempDir() },
    logger: () => {},
    spawnImpl: (_command, args, options) => {
      calls.push({ args, options })
      return child
    },
    spawnSyncImpl: () => ({ status: 0 }),
    fetchImpl: async () => ({ ok: fetches.length ? fetches.shift() : true }),
    sleep: async () => {},
    platform: 'win32',
    pluginRoot: path.resolve('D:/fake/plugin'),
  })
  const state = await withFetch.ensure()
  assert.equal(state.running, true)
  assert.equal(state.managed, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].args[0], /ig_bridge\.py$/)
  assert.ok(calls[0].args.includes('--serve'))
  assert.ok(calls[0].args.includes('--data-dir'), 'the sidecar must share the plugin data dir (and its token)')
  assert.equal(calls[0].options.cwd, path.resolve('D:/fake/plugin'))
  assert.equal(sup.status !== undefined, true)
})

test('a missing python is reported instead of retried forever', async () => {
  const { supervisor: sup } = supervisor({
    spawnImpl: () => {
      const child = fakeChild()
      // Emit after the supervisor attaches its error handler (same tick).
      queueMicrotask(() => {
        const error = new Error('spawn python ENOENT')
        error.code = 'ENOENT'
        child.emit('error', error)
      })
      return child
    },
    fetchImpl: upOnly(false),
  })
  const state = await sup.ensure()
  assert.equal(state.running, false)
  assert.equal(state.pythonMissing, true)
  assert.match(state.lastError, /ENOENT|python/i)
})

test('stop() kills the child it started', async () => {
  const child = fakeChild()
  const { supervisor: sup } = supervisor({ spawnImpl: () => child, fetchImpl: upOnly(false) })
  // waitForHealth would loop for 5s of fake time; the fetch never comes up, so
  // make the timeout tiny instead by using the default (5s is already small).
  await sup.ensure()
  sup.stop()
  assert.equal(child.killed, true)
})

test('checkDeps reports whether instagrapi is importable', async () => {
  const { supervisor: ok } = supervisor({ spawnSyncImpl: () => ({ status: 0 }) })
  assert.equal(ok.checkDeps(), true)
  assert.equal((await ok.status()).deps, true)

  const { supervisor: missing } = supervisor({ spawnSyncImpl: () => ({ status: 1 }) })
  assert.equal(missing.checkDeps(), false)
  assert.equal((await missing.status()).deps, false)
})

test('status points at the log file inside the data dir', async () => {
  const { supervisor: sup, store } = supervisor({ up: true })
  const state = await sup.status()
  assert.equal(state.logFile, path.join(store.dir, 'sidecar.log'))
  assert.equal(state.port, '8737')
  assert.equal(state.script.endsWith('ig_bridge.py'), true)
})

test('installDeps runs pip against the shipped requirements file', async () => {
  const calls = []
  const { supervisor: sup } = supervisor({
    pluginRoot: path.resolve('.'),
    spawnImpl: (command, args) => {
      calls.push({ command, args })
      const child = fakeChild()
      queueMicrotask(() => {
        child.stdout.emit('data', 'Successfully installed instagrapi-2.1.2')
        child.emit('exit', 0)
      })
      return child
    },
  })
  const result = await sup.installDeps()
  assert.equal(result.ok, true)
  assert.match(result.output, /Successfully installed/)
  assert.deepEqual(calls[0].args.slice(0, 3), ['-m', 'pip', 'install'])
  assert.equal(calls[0].args[3], '-r')
  assert.match(calls[0].args[4], /requirements\.txt$/)
  assert.equal((await sup.status()).deps, true, 'a successful install marks the dependency present')
})

test('a failing pip is reported with its output', async () => {
  const { supervisor: sup } = supervisor({
    pluginRoot: path.resolve('.'),
    spawnImpl: () => {
      const child = fakeChild()
      queueMicrotask(() => {
        child.stderr.emit('data', 'ERROR: No matching distribution found for instagrapi')
        child.emit('exit', 1)
      })
      return child
    },
  })
  const result = await sup.installDeps()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_DEPS_FAILED')
  assert.match(result.output, /No matching distribution/)
})
