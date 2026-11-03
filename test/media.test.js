import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createMedia } from '../lib/media.js'
import { makeConfig, makeStore, tempDir } from './helpers.js'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0x00)])
const PUBLIC = 'https://tunnel.example'

/** A scripted `fetch` stand-in; returns a plain object, never the global Response. */
function fakeFetch(handler) {
  const calls = []
  const fn = async (url, options = {}) => {
    calls.push({ url, options })
    return handler({ url, options })
  }
  fn.calls = calls
  return fn
}

function response({ ok = true, status = 200, body = Buffer.alloc(0), headers = {} } = {}) {
  return {
    ok,
    status,
    json: async () => ({}),
    text: async () => String(body),
    arrayBuffer: async () => body,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  }
}

async function makeMedia(overrides = {}, fetchImpl = async () => response({ body: PNG_1X1 })) {
  const store = await makeStore()
  const config = makeConfig(overrides)
  const media = createMedia({ store, config, fetchImpl })
  return { store, config, media }
}

test('hosting is off without graph.publicBaseUrl and stage says so', async () => {
  const { media } = await makeMedia()
  assert.equal(media.hostingAvailable(), false)
  assert.equal(media.publicUrlFor('a.png'), null)

  const localFile = path.join(tempDir(), 'photo.png')
  fs.writeFileSync(localFile, PNG_1X1)

  const result = await media.stage(localFile)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_NO_PUBLIC_BASE_URL')
  assert.match(result.hint, /publicBaseUrl/)
  // nothing was copied into the public folder
  assert.equal(fs.existsSync(path.join(media.publicDir, 'photo.png')), false)
})

test('stage copies the file into <store.dir>/media and returns a public URL', async () => {
  const { store, media } = await makeMedia({ graph: { publicBaseUrl: `${PUBLIC}/` } })
  assert.equal(media.hostingAvailable(), true)

  const sourceDir = tempDir()
  const localFile = path.join(sourceDir, 'photo.png')
  fs.writeFileSync(localFile, PNG_1X1)

  const result = await media.stage(localFile)
  assert.equal(result.ok, true)
  assert.equal(result.name, 'photo.png')
  assert.equal(result.url, `${PUBLIC}/ig-life/media/photo.png`)
  assert.equal(result.path, path.join(store.dir, 'media', 'photo.png'))
  assert.ok(fs.existsSync(result.path))
  assert.deepEqual(fs.readFileSync(result.path), PNG_1X1)
  assert.equal(media.publicUrlFor('photo.png'), `${PUBLIC}/ig-life/media/photo.png`)
})

test('download returns the bytes of a healthy response', async () => {
  const fetchImpl = fakeFetch(() => response({ body: PNG_1X1, headers: { 'content-type': 'image/png' } }))
  const { media } = await makeMedia({}, fetchImpl)

  const result = await media.download('https://cdn.example/1.png')
  assert.equal(result.ok, true)
  assert.ok(Buffer.isBuffer(result.buffer))
  assert.deepEqual(result.buffer, PNG_1X1)
  assert.equal(result.contentType, 'image/png')
  assert.equal(fetchImpl.calls[0].url, 'https://cdn.example/1.png')
  assert.equal(fetchImpl.calls[0].options.redirect, 'follow')
})

test('download refuses anything over maxBytes', async () => {
  // a declared content-length is enough to refuse before the body is read
  const declared = fakeFetch(() => response({ body: Buffer.alloc(0), headers: { 'content-length': '9000' } }))
  const big = await (await makeMedia({}, declared)).media.download('https://cdn.example/huge', { maxBytes: 1000 })
  assert.equal(big.ok, false)
  assert.equal(big.code, 'IG_DOWNLOAD_TOO_BIG')

  // and an undeclared but oversized body is refused after reading
  const undeclared = fakeFetch(() => response({ body: Buffer.alloc(5000) }))
  const tooBig = await (await makeMedia({}, undeclared)).media.download('https://cdn.example/huge', { maxBytes: 1000 })
  assert.equal(tooBig.ok, false)
  assert.equal(tooBig.code, 'IG_DOWNLOAD_TOO_BIG')
})

test('download maps a non-ok status to IG_DOWNLOAD_STATUS', async () => {
  const fetchImpl = fakeFetch(() => response({ ok: false, status: 403 }))
  const { media } = await makeMedia({}, fetchImpl)
  const result = await media.download('https://cdn.example/secret.png')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_DOWNLOAD_STATUS')
  assert.match(result.error, /403/)
})

test('download maps a thrown fetch to IG_DOWNLOAD_FAILED', async () => {
  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND')
  }
  const { media } = await makeMedia({}, fetchImpl)
  const result = await media.download('https://cdn.example/gone.png')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_DOWNLOAD_FAILED')
  assert.match(result.error, /ENOTFOUND/)
})

test('saveRemoteImage rejects a payload that is not an image', async () => {
  const fetchImpl = fakeFetch(() => response({ body: Buffer.from('<html>not an image</html>') }))
  const { media } = await makeMedia({}, fetchImpl)
  const result = await media.saveRemoteImage('https://cdn.example/expired.jpg')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_NOT_AN_IMAGE')
})

test('saveRemoteImage keeps a real image in the requested folder', async () => {
  const fetchImpl = fakeFetch(() => response({ body: JPG }))
  const { media } = await makeMedia({}, fetchImpl)

  const targetDir = tempDir()
  const result = await media.saveRemoteImage('https://cdn.example/cat.jpg', { dir: targetDir, prefix: 'cat' })
  assert.equal(result.ok, true)
  assert.equal(result.format, 'jpg')
  assert.equal(path.dirname(result.path), targetDir)
  assert.match(path.basename(result.path), /^cat-[a-z0-9]+\.jpg$/)
  assert.ok(fs.existsSync(result.path))
  assert.deepEqual(fs.readFileSync(result.path), JPG)
})

test('stats reports the media folder and the hosting flag', async () => {
  const { store, media } = await makeMedia({ graph: { publicBaseUrl: PUBLIC } })
  assert.deepEqual(media.stats(), {
    publicDir: path.join(store.dir, 'media'),
    hostingAvailable: true,
    publicBaseUrl: PUBLIC,
  })
})
