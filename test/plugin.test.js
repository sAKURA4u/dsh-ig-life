import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { mount as apply, inject, name } from '../lib/index.js'
import { tempDir } from './helpers.js'

/** A mock Cordis context: records every registration, invents no services. */
function mockCtx({ services = {}, logger = null } = {}) {
  const calls = { effects: [], intervals: [], routes: [], on: [], registered: [] }
  const ctx = {
    get: (key) => services[key],
    effect: (run, label) => {
      calls.effects.push(label ?? 'effect')
      const disposer = run()
      calls.disposers ??= []
      calls.disposers.push(disposer)
      return disposer
    },
    interval: (callback, ms) => {
      calls.intervals.push({ callback, ms })
      return () => {}
    },
    on: (event, handler) => {
      calls.on.push({ event, handler })
      return () => {}
    },
    logger: logger ?? (() => ({ info() {}, warn() {}, error() {}, debug() {}, log() {} })),
  }
  return { ctx, calls }
}

const pluginIdentity = () => ({
  name,
  inject: [...inject],
})

test('the plugin advertises the loader name and injects nothing', () => {
  const identity = pluginIdentity()
  assert.equal(identity.name, 'ig-life')
  assert.deepEqual(identity.inject, [], 'no injection may block activation')
})

test('apply mounts with nothing but a timer service', async () => {
  const dataDir = tempDir()
  const { ctx, calls } = mockCtx()
  const handle = await apply(ctx, { dataDir, transport: 'dryrun', life: { enabled: false } })

  assert.ok(handle, 'apply should return a handle')
  assert.equal(handle.name, 'ig-life')
  assert.equal(handle.transport.name, 'dryrun')
  assert.ok(fs.existsSync(dataDir), 'data dir should exist')
  assert.ok(handle.memory.size >= 5, 'the bundled persona seeds memories')
  assert.equal(handle.webhookPath, null, 'no webServer → no webhook route')
  assert.equal(calls.intervals.length, 0, 'life is off by default')
  assert.ok(calls.effects.length >= 1, 'teardown effect should be registered')
})

test('apply mounts the webhook and the tick when asked to', async () => {
  const dataDir = tempDir()
  const routes = []
  const { ctx, calls } = mockCtx({
    services: {
      webServer: {
        register: ({ kind, path }) => {
          routes.push({ kind, path })
          return () => {}
        },
      },
    },
  })
  const handle = await apply(ctx, {
    dataDir,
    transport: 'dryrun',
    webhook: { enabled: true, path: '/ig-life/webhook' },
    life: { enabled: true, tickSeconds: 30 },
  })

  assert.equal(handle.webhookPath, '/ig-life/webhook')
  const paths = routes.map((route) => route.path)
  assert.ok(paths.includes('/ig-life/webhook'), 'webhook route')
  assert.ok(paths.includes('/ig-life/media'), 'media route')
  assert.ok(paths.includes('/ig-life/console'), 'console page') // the rest of the routes are its JSON API
  assert.equal(calls.intervals.length, 1)
  assert.equal(calls.intervals[0].ms, 30_000)
})

test('the webhook route ingests DMs into the bridge inbox', async () => {
  const dataDir = tempDir()
  let webhookHandler = null
  const { ctx } = mockCtx({
    services: {
      webServer: {
        register: ({ path, handler }) => {
          if (path.endsWith('webhook')) webhookHandler = handler
          return () => {}
        },
      },
    },
  })
  const handle = await apply(ctx, {
    dataDir,
    transport: 'dryrun',
    webhook: { enabled: true, requireSignature: false },
  })
  assert.equal(typeof webhookHandler, 'function')

  const body = JSON.stringify({
    entry: [
      {
        messaging: [
          { sender: { id: 'igsid-1', username: 'owner' }, message: { mid: 'mid-1', text: '你好', thread_id: 't1' } },
        ],
      },
    ],
  })
  const req = {
    method: 'POST',
    url: '/ig-life/webhook',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8')
    },
  }
  const res = {
    statusCode: 0,
    setHeader() {},
    end(payload) {
      this.body = payload ?? ''
    },
  }
  await webhookHandler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(handle.bridge.recentInbox(5).length, 1)
  assert.equal(handle.bridge.recentInbox(5)[0].text, '你好')
})

test('apply survives a context that provides no optional services at all', async () => {
  const dataDir = tempDir()
  const { ctx } = mockCtx()
  const handle = await apply(ctx, { dataDir, transport: 'dryrun' })
  assert.ok(handle)
  assert.equal(handle.bridge.engine, 'none', 'no agents and no llm → no reply engine')
})

test('apply respects enabled: false', async () => {
  const { ctx, calls } = mockCtx()
  const handle = await apply(ctx, { enabled: false })
  assert.ok(!handle, 'disabled mount must not yield a handle')
  assert.equal(calls.effects.length, 0)
})

test('tools register when the host exposes a tools service and dsh-tools resolves', async (t) => {
  const dataDir = tempDir()
  const registered = []
  const { ctx } = mockCtx({
    services: {
      tools: {
        register: (definition) => {
          registered.push(definition.name)
          return () => {}
        },
      },
    },
  })
  const handle = await apply(ctx, { dataDir, transport: 'dryrun' })

  let defineToolAvailable = true
  try {
    await import('@deepseek-ai/dsh-tools')
  } catch {
    defineToolAvailable = false
  }
  if (!defineToolAvailable) {
    t.diagnostic('@deepseek-ai/dsh-tools is not installed here; asserting graceful skip')
    assert.equal(handle.tools.registered.length, 0)
    assert.match(handle.tools.reason, /dsh-tools|not mounted|nothing registered/)
    return
  }
  assert.ok(handle.tools.registered.includes('ig_send_dm'))
  assert.ok(handle.tools.registered.includes('memory_recall'))
  assert.deepEqual(handle.tools.registered, registered)
})
