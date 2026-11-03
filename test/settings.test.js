/**
 * 使用者設定層 + 瀏覽器設定頁。
 *
 * 兩件事要釘住：
 *   1. 寫入的檔案只可以含白名單欄位（永遠冇 token／密碼），而且讀回來要蓋過 row config；
 *   2. `lib/client.js` 是手寫的 DSH client bundle —— 沒有 build step，所以測試就是它的
 *      「編譯器」：用 `new Function` 執行一次，確認 factory 真的登記了 settings.section。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { mergeConfigLayers, resolveConfig } from '../lib/config.js'
import { createConsole } from '../lib/console.js'
import { EDITABLE, pickEditable, readOverlay, saveOverlay, settingsFilePath, validatePatch } from '../lib/settings.js'
import { tempDir } from './helpers.js'

function dataDir() {
  return tempDir('ig-life-settings-')
}

// ---------------------------------------------------------------------- layers
test('the saved layer wins over the row config, array included', () => {
  const merged = mergeConfigLayers(
    { transport: 'dryrun', allowlist: ['a', 'b'], unofficial: { pollSeconds: 30 } },
    { transport: 'unofficial', allowlist: ['owner'], unofficial: { sendPerDay: 5 } },
  )
  const { config } = resolveConfig(merged)
  assert.equal(config.transport, 'unofficial')
  assert.deepEqual(config.allowlist, ['owner'], 'arrays are replaced, not appended')
  assert.equal(config.unofficial.pollSeconds, 30, 'untouched keys keep the base value')
  assert.equal(config.unofficial.sendPerDay, 5)
})

// -------------------------------------------------------------------- overlays
test('a missing settings file means no overrides', () => {
  assert.deepEqual(readOverlay(dataDir()), {})
})

test('saving writes only editable keys and reads back', () => {
  const dir = dataDir()
  const result = saveOverlay(dir, {
    transport: 'unofficial',
    ownerHandle: '@BigFish',
    allowlist: 'a, @B',
    unofficial: { pollSeconds: 1, sendPerDay: 7 },
    // not editable — must never reach the file
    graph: { accessToken: 'IGAAsecret' },
    unofficialToken: 'nope',
  })
  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(settingsFilePath(dir)), true)

  const raw = fs.readFileSync(settingsFilePath(dir), 'utf8')
  assert.ok(!raw.includes('IGAAsecret'), 'a token must never be written')
  assert.ok(!raw.includes('nope'))

  const saved = readOverlay(dir)
  assert.equal(saved.transport, 'unofficial')
  assert.equal(saved.ownerHandle, 'bigfish', 'handles are normalised')
  assert.deepEqual(saved.allowlist, ['a', 'b'])
  assert.equal(saved.unofficial.pollSeconds, 10, 'the 10s floor is enforced by resolveConfig')
  assert.equal(saved.unofficial.sendPerDay, 7)
  assert.equal(saved.graph, undefined)
})

test('a second save merges into the first instead of replacing it', () => {
  const dir = dataDir()
  saveOverlay(dir, { ownerHandle: 'owner', limits: { dmPerDay: 9 } })
  saveOverlay(dir, { life: { enabled: true } })
  const saved = readOverlay(dir)
  assert.equal(saved.ownerHandle, 'owner')
  assert.equal(saved.limits.dmPerDay, 9)
  assert.equal(saved.life.enabled, true)
})

test('an unknown transport is an error, not a silent downgrade', () => {
  const checked = validatePatch({ transport: 'carrier-pigeon' })
  assert.equal(checked.ok, false)
  assert.match(checked.errors[0], /transport/)
})

test('numbers are clamped, not trusted', () => {
  const checked = validatePatch({ limits: { dmPerDay: 9999 }, life: { tickSeconds: 1 } })
  assert.equal(checked.ok, true)
  assert.equal(checked.values.limits.dmPerDay, 500)
  assert.equal(checked.values.life.tickSeconds, 20)
})

test('the editable projection carries no secret-bearing key', () => {
  const { config } = resolveConfig({ transport: 'graph', graph: { accessToken: 'IGAAsecretvalue', verifyToken: 'v' } })
  const editable = pickEditable(config)
  const json = JSON.stringify(editable)
  assert.ok(!json.includes('IGAAsecretvalue'))
  assert.ok(!json.toLowerCase().includes('token'))
  assert.ok(!json.toLowerCase().includes('password'))
  assert.deepEqual(EDITABLE.includes('unofficial.token'), false)
})

// ------------------------------------------------------------------ console API
function fakeConsole(dir) {
  const routes = createConsole({
    bridge: { status: () => ({}) , recentInbox: () => [] },
    life: null,
    stickers: null,
    slang: null,
    people: null,
    voice: null,
    memory: { stats: () => ({}) },
    transport: { health: async () => ({ ok: true, backend: 'dryrun' }) },
    config: { ...resolveConfig({ transport: 'dryrun' }).config },
    dataDir: dir,
    logger: () => {},
  })
  const route = routes.find((entry) => entry.path === '/ig-life/console/api/settings')
  assert.ok(route, 'the settings route exists')
  return route.handler
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(payload) {
      this.body = payload ?? ''
    },
  }
}

const loopback = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } }

test('GET returns the effective config and the saved layer', async () => {
  const dir = dataDir()
  const handler = fakeConsole(dir)
  const res = fakeRes()
  await handler(loopback, res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.effective.transport, 'dryrun')
  assert.ok(payload.transports.includes('unofficial'))
  assert.ok(payload.settingsFile.endsWith('settings.json'))
})

test('POST saves, and says a restart is required', async () => {
  const dir = dataDir()
  const handler = fakeConsole(dir)
  const res = fakeRes()
  await handler(
    { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, body: Buffer.from(JSON.stringify({ transport: 'unofficial', ownerHandle: 'me' })) },
    res,
  )
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.restartRequired, true)
  assert.deepEqual(readOverlay(dir).transport, 'unofficial')
})

test('POST with a bad body is a 400 with a code', async () => {
  const handler = fakeConsole(dataDir())
  const res = fakeRes()
  await handler({ method: 'POST', socket: { remoteAddress: '127.0.0.1' }, body: Buffer.from('not json') }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).code, 'IG_BAD_JSON')
})

test('a non-loopback request is refused before anything is written', async () => {
  const dir = dataDir()
  const handler = fakeConsole(dir)
  const res = fakeRes()
  await handler({ method: 'POST', socket: { remoteAddress: '10.0.0.5' }, body: Buffer.from('{}') }, res)
  assert.equal(res.statusCode, 403)
  assert.equal(fs.existsSync(settingsFilePath(dir)), false)
})

// ------------------------------------------------------- browser client bundle
test('the hand-written client bundle registers a settings section', () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const events = []
  const fakeWindow = { __ModuleLoader__: { load: (entry) => events.push(entry) } }
  globalThis.window = fakeWindow
  try {
    // The bundle is a classic script: evaluate it with the globals it expects.
    new Function('window', 'console', source)(fakeWindow, { error: () => {}, log: () => {} })
    assert.equal(events.length, 1, 'the bundle must register exactly one module')
    const entry = events[0]
    assert.equal(entry.id, 'dsh-ig-life')

    const registered = []
    const fakeCtx = {
      slots: {
        inject: (slotName, run) => {
          assert.equal(slotName, 'settings.section')
          run()
        },
        register: (options, component) => {
          registered.push({ options, component })
          return () => {}
        },
      },
    }
    const react = {
      createElement: () => null,
      useState: () => [null, () => {}],
      useEffect: () => {},
      Component: class Component {},
    }
    const exported = entry.factory((name) => {
      assert.equal(name, 'react')
      return react
    })
    assert.equal(typeof exported.apply, 'function')
    assert.deepEqual(exported.inject, ['slots'])

    exported.apply(fakeCtx)
    assert.equal(registered.length, 1)
    assert.equal(registered[0].options.name, 'settings.section')
    assert.equal(registered[0].options.id, 'ig-life')
    assert.equal(typeof registered[0].options.label(), 'string')
    assert.equal(typeof registered[0].component, 'function')
  } finally {
    delete globalThis.window
    assert.ok(events)
  }
})
