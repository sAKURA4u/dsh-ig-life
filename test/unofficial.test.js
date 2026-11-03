/**
 * The unofficial transport and its poller.
 *
 * No network, no Python: a fake `fetch` stands in for the sidecar and answers
 * by route. What is worth pinning down here is the shape of the contract — the
 * token header, the error codes that reach the model, the hard daily ceiling,
 * the pacing, and the fact that a polled message comes out looking exactly like
 * a webhook event.
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { describeConfig, resolveConfig } from '../lib/config.js'
import { createInboundPoll } from '../lib/poll.js'
import { TransportError } from '../lib/transport/index.js'
import { createUnofficialTransport } from '../lib/transport/unofficial.js'
import { makeConfig, makeStore } from './helpers.js'

// --------------------------------------------------------------------- helpers
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * A fetch that answers per route. An entry can be a payload, a Response, or a
 * function returning either; an Error instance is thrown instead.
 */
function fakeFetch(routes = {}) {
  const calls = []
  const impl = async (url, options = {}) => {
    const parsed = new URL(url)
    const key = `${options.method ?? 'GET'} ${parsed.pathname}`
    const call = {
      key,
      url: parsed,
      headers: options.headers ?? {},
      body: options.body ? JSON.parse(options.body) : null,
    }
    calls.push(call)
    const handler = routes[key] ?? routes[`ANY ${parsed.pathname}`]
    if (handler === undefined) return jsonResponse({ ok: false, code: 'IG_UNEXPECTED_ROUTE', error: `no fake for ${key}` }, 500)
    if (handler instanceof Error) throw handler
    const result = typeof handler === 'function' ? await handler(call) : handler
    if (result instanceof Response) return result
    return jsonResponse(result, result?.__status ?? 200)
  }
  impl.calls = calls
  impl.last = () => calls.at(-1)
  return impl
}

async function harness({ config = {}, routes = {}, fetchImpl = null, media = null, now = () => Date.now(), sleep = null } = {}) {
  const store = await makeStore()
  const resolved = makeConfig({
    transport: 'unofficial',
    unofficial: { sendGapSeconds: 0, sendPerDay: 99, postPerDay: 9, pollSeconds: 20, ...config },
  })
  const transport = createUnofficialTransport({
    config: resolved,
    store,
    logger: () => {},
    media,
    fetchImpl: fetchImpl ?? fakeFetch(routes),
    now,
    sleep: sleep ?? (async () => {}),
  })
  return { store, config: resolved, transport }
}

const message = (overrides = {}) => ({
  id: 'm-1',
  threadId: 't-1',
  senderId: '7',
  username: 'alice',
  text: '你好',
  at: '2026-11-03T04:00:00Z',
  attachments: [],
  ...overrides,
})

// ---------------------------------------------------------------------- config
test('unofficial is a transport the config accepts', () => {
  const { config, warnings } = resolveConfig({ transport: 'unofficial', ownerHandle: 'me', webhook: { enabled: false } })
  assert.equal(config.transport, 'unofficial')
  assert.deepEqual(warnings, [])
  assert.equal(config.unofficial.baseUrl, 'http://127.0.0.1:8737')
  assert.equal(config.unofficial.pollSeconds, 20)
})

test('the polling floor of ten seconds cannot be configured away', () => {
  const { config } = resolveConfig({ transport: 'unofficial', unofficial: { pollSeconds: 1, pollJitterSeconds: -5 } })
  assert.equal(config.unofficial.pollSeconds, 10)
  assert.equal(config.unofficial.pollJitterSeconds, 0)
})

test('unofficial settings can come from the environment', () => {
  const { config } = resolveConfig(
    { transport: 'unofficial', webhook: { enabled: false } },
    {
      IG_LIFE_UNOFFICIAL_URL: 'http://127.0.0.1:9000/',
      IG_LIFE_UNOFFICIAL_TOKEN: 'tok-abc',
      IG_LIFE_UNOFFICIAL_POLL_SECONDS: '45',
    },
  )
  assert.equal(config.unofficial.baseUrl, 'http://127.0.0.1:9000')
  assert.equal(config.unofficial.token, 'tok-abc')
  assert.equal(config.unofficial.pollSeconds, 45)
})

test('a remote sidecar URL is a warning, not a silent risk', () => {
  const { warnings } = resolveConfig({ transport: 'unofficial', unofficial: { baseUrl: 'http://10.0.0.5:8737' } })
  assert.ok(warnings.some((warning) => warning.includes('loopback')))
})

test('unofficial warns that the webhook does not deliver DMs', () => {
  const { warnings } = resolveConfig({ transport: 'unofficial' })
  assert.ok(warnings.some((warning) => warning.includes('webhook')))
})

test('describeConfig never prints the sidecar token', () => {
  const { config } = resolveConfig({ transport: 'unofficial', unofficial: { token: 'super-secret-token-value' } })
  const described = JSON.stringify(describeConfig(config))
  assert.ok(!described.includes('super-secret-token-value'))
  assert.ok(described.includes('supe***'))
})

// -------------------------------------------------------------------- outbound
test('sendDm posts the message with the shared token and records the outbox', async () => {
  const fetchImpl = fakeFetch({ 'POST /send': { ok: true, id: 'sent-9', threadId: 't-1' } })
  const { store, transport } = await harness({ fetchImpl, config: { token: 'tok-1' } })

  const result = await transport.sendDm({ text: '喂', threadId: 't-1', username: 'alice' })
  assert.equal(result.id, 'sent-9')
  assert.equal(fetchImpl.last().headers['x-ig-life-token'], 'tok-1')
  assert.equal(fetchImpl.last().body.text, '喂')
  assert.equal(fetchImpl.last().body.threadId, 't-1')

  const [entry] = await store.readLines('outbox.jsonl', 5)
  assert.equal(entry.transport, 'unofficial')
  assert.equal(entry.kind, 'dm')
  assert.equal(entry.text, '喂')
  assert.equal(entry.id, 'sent-9')
})

test('the sidecar token is read from the shared file when config has none', async () => {
  const fetchImpl = fakeFetch({ 'GET /health': { ok: true, loggedIn: true } })
  const { store, config } = await harness({ fetchImpl })
  await fsp.writeFile(path.join(store.dir, 'sidecar-token'), 'file-token\n', 'utf8')
  const transport = createUnofficialTransport({ config, store, fetchImpl })
  await transport.health()
  assert.equal(fetchImpl.last().headers['x-ig-life-token'], 'file-token')
})

test('an empty message never reaches the sidecar', async () => {
  const fetchImpl = fakeFetch({})
  const { transport } = await harness({ fetchImpl })
  await assert.rejects(() => transport.sendDm({ text: '   ', threadId: 't-1' }), (error) => error.code === 'IG_EMPTY_MESSAGE')
  assert.equal(fetchImpl.calls.length, 0)
})

test('the daily ceiling is enforced below the bridge and before the request', async () => {
  const fetchImpl = fakeFetch({ 'POST /send': { ok: true, id: 'sent-1' } })
  const { transport } = await harness({ fetchImpl, config: { sendPerDay: 1 } })

  await transport.sendDm({ text: '一', threadId: 't-1' })
  await assert.rejects(() => transport.sendDm({ text: '二', threadId: 't-1' }), (error) => {
    assert.equal(error.code, 'IG_UNOFFICIAL_CAP')
    assert.match(error.hint, /密集|sendPerDay/)
    return true
  })
  assert.equal(fetchImpl.calls.length, 1, 'the blocked message must not be sent')
})

test('the gap between two messages is actually waited out', async () => {
  const fetchImpl = fakeFetch({ 'POST /send': { ok: true, id: 'sent-1' } })
  const waits = []
  const frozen = Date.parse('2026-11-03T12:00:00Z')
  const { transport } = await harness({
    fetchImpl,
    config: { sendGapSeconds: 5 },
    now: () => frozen,
    sleep: async (ms) => {
      waits.push(ms)
    },
  })
  await transport.sendDm({ text: '一', threadId: 't-1' })
  await transport.sendDm({ text: '二', threadId: 't-1' })
  assert.deepEqual(waits, [5000])
})

test('a post needs a local image and passes its path, not a URL', async () => {
  const fetchImpl = fakeFetch({ 'POST /post': { ok: true, mediaId: '555', permalink: 'https://www.instagram.com/p/X/' } })
  const { store, transport } = await harness({ fetchImpl })
  const file = path.join(store.dir, 'photo.png')
  await fsp.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))

  const posted = await transport.postPhoto({ caption: '今日', imagePath: file })
  assert.equal(posted.mediaId, '555')
  assert.equal(fetchImpl.last().body.imagePath, path.resolve(file))
  assert.equal(fetchImpl.last().body.caption, '今日')
})

test('our own /ig-life/media/<file> URL maps back onto disk', async () => {
  const fetchImpl = fakeFetch({ 'POST /post': { ok: true, mediaId: '1' } })
  const store = await makeStore()
  const config = makeConfig({ transport: 'unofficial', graph: { publicBaseUrl: 'https://tunnel.example' } })
  const mediaDir = path.join(store.dir, 'media')
  await fsp.mkdir(mediaDir, { recursive: true })
  const file = path.join(mediaDir, 'diary.png')
  await fsp.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
  const transport = createUnofficialTransport({ config, store, fetchImpl })
  await transport.postPhoto({ caption: 'x', imageUrl: 'https://tunnel.example/ig-life/media/diary.png' })
  assert.equal(fetchImpl.last().body.imagePath, path.resolve(file))
})

test('a post with no image fails with a code, not a mystery', async () => {
  const { transport } = await harness({ fetchImpl: fakeFetch({}) })
  await assert.rejects(() => transport.postPhoto({ caption: 'x' }), (error) => error.code === 'IG_NO_IMAGE')
})

test('attachments are checked on disk before anything is uploaded', async () => {
  const fetchImpl = fakeFetch({})
  const { transport } = await harness({ fetchImpl })
  await assert.rejects(
    () => transport.sendImage({ file: path.join(process.cwd(), 'does-not-exist.png'), threadId: 't-1' }),
    (error) => error.code === 'IG_MEDIA_NOT_FOUND',
  )
  assert.equal(fetchImpl.calls.length, 0)
})

test('a real attachment is posted as a path with its kind', async () => {
  const fetchImpl = fakeFetch({ 'POST /send_media': { ok: true, id: 'media-1', mode: 'image' } })
  const { store, transport } = await harness({ fetchImpl })
  const file = path.join(store.dir, 'sticker.png')
  await fsp.writeFile(file, Buffer.from('png'))
  const sent = await transport.sendImage({ file, threadId: 't-1' })
  assert.equal(sent.id, 'media-1')
  assert.equal(fetchImpl.last().body.type, 'image')
  assert.equal(fetchImpl.last().body.path, path.resolve(file))
})

test('audio keeps its own type so the sidecar can pick a voice note', async () => {
  const fetchImpl = fakeFetch({ 'POST /send_media': { ok: true, id: 'a-1', mode: 'voice' } })
  const { store, transport } = await harness({ fetchImpl })
  const file = path.join(store.dir, 'voice.m4a')
  await fsp.writeFile(file, Buffer.from('m4a'))
  const sent = await transport.sendAudio({ file, threadId: 't-1', text: '' })
  assert.equal(sent.mode, 'voice')
  assert.equal(fetchImpl.last().body.type, 'audio')
})

// ----------------------------------------------------------------------- errors
test('a lost session becomes an actionable code and hint', async () => {
  const fetchImpl = fakeFetch({
    'POST /send': { __status: 401, ok: false, code: 'IG_LOGIN_REQUIRED', error: 'session dead', hint: 'relogin' },
  })
  const { transport } = await harness({ fetchImpl })
  await assert.rejects(() => transport.sendDm({ text: 'hi', threadId: 't-1' }), (error) => {
    assert.ok(error instanceof TransportError)
    assert.equal(error.code, 'IG_LOGIN_REQUIRED')
    assert.equal(error.hint, 'relogin')
    return true
  })
})

test('a 401 without a code still points at the login command', async () => {
  const fetchImpl = fakeFetch({ 'POST /send': { __status: 401, ok: false, error: 'nope' } })
  const { transport } = await harness({ fetchImpl })
  await assert.rejects(() => transport.sendDm({ text: 'hi', threadId: 't-1' }), (error) => {
    assert.match(error.hint, /ig_bridge\.py --login/)
    return true
  })
})

test('a refused connection explains how to start the sidecar', async () => {
  const refused = new TypeError('fetch failed')
  refused.cause = { code: 'ECONNREFUSED' }
  const { transport } = await harness({ fetchImpl: fakeFetch({ 'POST /send': refused }) })
  await assert.rejects(() => transport.sendDm({ text: 'hi', threadId: 't-1' }), (error) => {
    assert.equal(error.code, 'IG_SIDECAR_DOWN')
    assert.match(error.hint, /ig_bridge\.py --serve/)
    return true
  })
})

test('a hung sidecar times out instead of hanging the tool call', async () => {
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  const { transport } = await harness({ fetchImpl: fakeFetch({ 'POST /send': abort }) })
  await assert.rejects(() => transport.sendDm({ text: 'hi', threadId: 't-1' }), (error) => error.code === 'IG_SIDECAR_TIMEOUT')
})

test('replying to a comment without a media id is refused with the reason', async () => {
  const { transport } = await harness({ fetchImpl: fakeFetch({}) })
  await assert.rejects(
    () => transport.replyComment({ commentId: 'c-1', text: 'hi' }),
    (error) => error.code === 'IG_COMMENT_NEEDS_MEDIA',
  )
})

// ----------------------------------------------------------------------- polling
test('a polled message looks exactly like a webhook event', async () => {
  const fetchImpl = fakeFetch({
    'GET /messages': {
      ok: true,
      messages: [
        message({ id: 'a', text: '你好' }),
        message({
          id: 'b',
          text: '',
          at: 'not-a-date',
          attachments: [{ type: 'image', payload: { url: 'https://cdn.example/x.jpg', media_id: 'm1' } }],
        }),
        message({ id: 'c', isEcho: true, text: '我自己的回覆' }),
      ],
    },
  })
  const { transport } = await harness({ fetchImpl })
  const events = await transport.poll()

  assert.deepEqual(events.map((event) => event.externalId), ['a', 'b'], 'echoes are dropped')
  assert.equal(events[0].kind, 'dm')
  assert.equal(events[0].threadId, 't-1')
  assert.equal(events[0].senderId, '7')
  assert.equal(events[0].username, 'alice')
  assert.ok(events[0].at instanceof Date)
  assert.equal(events[1].attachments[0].isImage, true, 'the webhook normaliser is reused')
  assert.ok(!Number.isNaN(events[1].at.getTime()), 'a broken timestamp falls back to now')
})

test('a replayed id is never handed to the bridge twice', async () => {
  const fetchImpl = fakeFetch({ 'GET /messages': { ok: true, messages: [message({ id: 'dup' })] } })
  const { transport } = await harness({ fetchImpl })
  assert.equal((await transport.poll()).length, 1)
  assert.equal((await transport.poll()).length, 0)
})

test('poll drops messages with neither text nor attachment', async () => {
  const fetchImpl = fakeFetch({ 'GET /messages': { ok: true, messages: [message({ id: 'empty', text: '' })] } })
  const { transport } = await harness({ fetchImpl })
  assert.deepEqual(await transport.poll(), [])
})

test('poll tolerates a payload with no messages key', async () => {
  const fetchImpl = fakeFetch({ 'GET /messages': { ok: true } })
  const { transport } = await harness({ fetchImpl })
  assert.deepEqual(await transport.poll(), [])
})

test('health reports the sidecar session without pretending it is fine', async () => {
  const healthy = await harness({
    fetchImpl: fakeFetch({ 'GET /health': { ok: true, loggedIn: true, username: 'me', session: 'reused', sentToday: 3 } }),
  })
  const ok = await healthy.transport.health()
  assert.equal(ok.backend, 'unofficial')
  assert.equal(ok.ok, true)
  assert.equal(ok.session, 'reused')
  assert.equal(ok.sentToday, 3)

  const loggedOut = await harness({
    fetchImpl: fakeFetch({ 'GET /health': { ok: true, loggedIn: false, needsLogin: true, session: 'none' } }),
  })
  const notYet = await loggedOut.transport.health()
  assert.equal(notYet.ok, false, 'a sidecar that is up but logged out is not a working body')
  assert.equal(notYet.needsLogin, true)

  const down = await harness({ fetchImpl: fakeFetch({ 'GET /health': { __status: 503, ok: false, code: 'IG_SIDECAR_NO_DEPS', error: 'x' } }) })
  const bad = await down.transport.health()
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'IG_SIDECAR_NO_DEPS')
})

// ------------------------------------------------------------------------ poller
function fakeTimers() {
  const scheduled = []
  return {
    scheduled,
    setTimeout(fn, ms) {
      const handle = { fn, ms, cleared: false, unref() {} }
      scheduled.push(handle)
      return handle
    },
    clearTimeout(handle) {
      if (handle) handle.cleared = true
    },
    pending() {
      return scheduled.filter((handle) => !handle.cleared)
    },
    last() {
      return this.pending().at(-1)
    },
  }
}

test('the poller starts on the configured interval and hands events to the bridge', async () => {
  const timers = fakeTimers()
  const delivered = []
  const poller = createInboundPoll({
    poll: async () => [message({ id: 'p1' })],
    onEvents: async (events) => delivered.push(...events),
    intervalMs: 20_000,
    jitterMs: 0,
    timers,
  })

  poller.start()
  assert.equal(timers.last().ms, 20_000, 'first poll waits one interval')

  const result = await poller.tick()
  assert.equal(result.events, 1)
  assert.equal(delivered.length, 1)
  assert.equal(timers.last().ms, 20_000)
  poller.stop()
})

test('jitter stays inside the configured window', async () => {
  const timers = fakeTimers()
  const poller = createInboundPoll({
    poll: async () => [],
    onEvents: () => {},
    intervalMs: 20_000,
    jitterMs: 5_000,
    timers,
    random: () => 0.5,
  })
  poller.start()
  assert.equal(timers.last().ms, 20_000, 'the very first poll is on time, not random')
  await poller.tick()
  assert.equal(timers.last().ms, 22_500, 'afterwards every poll is jittered')
  poller.stop()
})

test('a slow poll never stacks up behind itself', async () => {
  const timers = fakeTimers()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let calls = 0
  const poller = createInboundPoll({
    poll: async () => {
      calls += 1
      await gate
      return []
    },
    onEvents: () => {},
    intervalMs: 10_000,
    timers,
  })
  poller.start()

  const inFlight = poller.tick()
  const second = await poller.tick()
  assert.equal(second.skipped, 'already running')
  assert.equal(calls, 1)
  release()
  await inFlight
  poller.stop()
})

test('failures back off exponentially, and the first one is logged loudly', async () => {
  const timers = fakeTimers()
  const levels = []
  const poller = createInboundPoll({
    poll: async () => {
      throw Object.assign(new Error('sidecar down'), { code: 'IG_SIDECAR_DOWN' })
    },
    onEvents: () => {},
    intervalMs: 10_000,
    jitterMs: 0,
    timers,
    logger: (level) => levels.push(level),
  })
  poller.start()

  await poller.tick()
  assert.equal(timers.last().ms, 20_000, 'first failure doubles the interval')
  await poller.tick()
  assert.equal(timers.last().ms, 40_000, 'second failure doubles again')
  assert.deepEqual(levels, ['warn', 'debug'], 'only the first failure is a warning')
  assert.equal(poller.stats().failed, 2)
  assert.equal(poller.stats().lastError.code, 'IG_SIDECAR_DOWN')
  poller.stop()
})

test('a successful poll clears the backoff and the error', async () => {
  const timers = fakeTimers()
  let fail = true
  const poller = createInboundPoll({
    poll: async () => {
      if (fail) throw new Error('temporary')
      return []
    },
    onEvents: () => {},
    intervalMs: 10_000,
    timers,
  })
  poller.start()
  await poller.tick()
  assert.equal(timers.last().ms, 20_000)
  fail = false
  await poller.tick()
  assert.equal(timers.last().ms, 10_000, 'back to the normal cadence')
  assert.equal(poller.stats().lastError, null)
  poller.stop()
})

test('stop() clears the timer and no further poll happens', async () => {
  const timers = fakeTimers()
  let calls = 0
  const poller = createInboundPoll({
    poll: async () => {
      calls += 1
      return []
    },
    onEvents: () => {},
    intervalMs: 10_000,
    timers,
  })
  poller.start()
  const handle = timers.last()
  poller.stop()
  assert.equal(handle.cleared, true)
  const result = await poller.tick()
  assert.equal(result.skipped, 'stopped')
  assert.equal(calls, 0)
  assert.equal(timers.pending().length, 0)
})
