import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createVision } from '../lib/vision.js'
import { makeConfig, makeStore, tempDir } from './helpers.js'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const BASE_URL = 'https://vision.example/v1'

/** A scripted `fetch` stand-in; returns a plain object, never the global Response. */
function fakeFetch(handler) {
  const calls = []
  const fn = async (url, options = {}) => {
    const call = { url, options, body: options.body ? JSON.parse(options.body) : null }
    calls.push(call)
    return handler(call)
  }
  fn.calls = calls
  return fn
}

function response({ ok = true, status = 200, json = {}, text = '', headers = {} } = {}) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => text,
    arrayBuffer: async () => Buffer.alloc(0),
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  }
}

/** An on-disk local image, because `describe` takes a path as well as a URL. */
function localPng() {
  const file = path.join(tempDir('ig-life-img-'), 'photo.png')
  fs.writeFileSync(file, PNG_1X1)
  return file
}

async function makeVision(overrides = {}, fetchImpl = async () => response({ json: { choices: [{ message: { content: '一隻貓' } }] } })) {
  const store = await makeStore()
  const config = makeConfig(overrides)
  const vision = createVision({ store, config, fetchImpl })
  return { store, config, vision }
}

test('vision is unavailable without vision.baseUrl', async () => {
  const { vision } = await makeVision()
  assert.equal(vision.available, false)

  const result = await vision.describe(localPng())
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_NO_VISION')
  assert.match(result.hint, /vision\.baseUrl/)
})

test('describe returns the model text and sends the image as a data URL', async () => {
  const fetchImpl = fakeFetch(() => response({ json: { choices: [{ message: { content: '一隻貓' } }] } }))
  const { vision } = await makeVision({ vision: { baseUrl: BASE_URL, model: 'gpt-4o-mini' } }, fetchImpl)
  assert.equal(vision.available, true)

  const result = await vision.describe(localPng())
  assert.deepEqual(result, { ok: true, text: '一隻貓' })

  const call = fetchImpl.calls[0]
  assert.equal(call.url, `${BASE_URL}/chat/completions`)
  assert.equal(call.options.method, 'POST')
  const parts = call.body.messages[0].content
  const imageUrl = parts.find((part) => part.type === 'image_url').image_url.url
  assert.ok(imageUrl.startsWith('data:image/png;base64,'))
  assert.equal(imageUrl, `data:image/png;base64,${PNG_1X1.toString('base64')}`)
})

test('describe refuses past vision.maxPerDay', async () => {
  const fetchImpl = fakeFetch(() => response({ json: { choices: [{ message: { content: '一隻貓' } }] } }))
  const { vision } = await makeVision({ vision: { baseUrl: BASE_URL, maxPerDay: 1 } }, fetchImpl)

  assert.equal((await vision.describe(localPng())).ok, true)
  const second = await vision.describe(localPng())
  assert.equal(second.ok, false)
  assert.equal(second.code, 'IG_VISION_QUOTA')
  // the quota is checked before the network call
  assert.equal(fetchImpl.calls.length, 1)
})

test('describe maps a non-ok response to IG_VISION_FAILED', async () => {
  const fetchImpl = fakeFetch(() => response({ ok: false, status: 400, text: 'bad model' }))
  const { vision } = await makeVision({ vision: { baseUrl: BASE_URL } }, fetchImpl)

  const result = await vision.describe(localPng())
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_VISION_FAILED')
  assert.match(result.error, /400/)
  assert.match(result.error, /bad model/)
})

test('describe maps empty content to IG_VISION_EMPTY', async () => {
  const fetchImpl = fakeFetch(() => response({ json: { choices: [{ message: { content: '   ' } }] } }))
  const { vision } = await makeVision({ vision: { baseUrl: BASE_URL } }, fetchImpl)

  const result = await vision.describe(localPng())
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_VISION_EMPTY')
})

test('describe maps a thrown fetch to IG_VISION_NETWORK', async () => {
  const fetchImpl = async () => {
    throw new Error('socket hang up')
  }
  const { vision } = await makeVision({ vision: { baseUrl: BASE_URL } }, fetchImpl)

  const result = await vision.describe(localPng())
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_VISION_NETWORK')
  assert.match(result.error, /socket hang up/)
})

test('describe reports an unreadable source instead of calling the endpoint', async () => {
  const fetchImpl = fakeFetch(() => response({ json: { choices: [{ message: { content: '一隻貓' } }] } }))
  const { vision } = await makeVision({ vision: { baseUrl: BASE_URL } }, fetchImpl)

  const result = await vision.describe(path.join(tempDir('ig-life-img-'), 'missing.png'))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_VISION_SOURCE')
  assert.equal(fetchImpl.calls.length, 0)
})

test('stats reports usedToday', async () => {
  const fetchImpl = fakeFetch(() => response({ json: { choices: [{ message: { content: '一隻貓' } }] } }))
  const { vision } = await makeVision({ vision: { baseUrl: BASE_URL, maxPerDay: 5 } }, fetchImpl)

  assert.deepEqual(vision.stats(), { available: true, usedToday: 0, maxPerDay: 5 })
  await vision.describe(localPng())
  await vision.describe(localPng())
  assert.deepEqual(vision.stats(), { available: true, usedToday: 2, maxPerDay: 5 })
})
