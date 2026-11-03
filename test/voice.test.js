import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { Voice, extractMarkers, prosodyFor } from '../lib/voice.js'
import { makeConfig, makeStore, tempDir } from './helpers.js'

/** A believable 2 KB mp3 header — enough for the size + magic-byte verification. */
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2000)])

/**
 * A scripted `fetch` stand-in. It records every request (with the JSON body
 * already parsed) and answers with a plain object of the documented shape — no
 * dependency on the global `Response` class.
 */
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

function response({ ok = true, status = 200, body = '', json = {}, headers = {} } = {}) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => body,
    arrayBuffer: async () => body,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  }
}

async function makeVoice(overrides = {}, fetchImpl = async () => response({ body: MP3 })) {
  const store = await makeStore()
  const config = makeConfig(overrides)
  const voice = new Voice({ store, config, fetchImpl })
  return { store, config, voice }
}

test('extractMarkers pulls known emotions out of the text', () => {
  const result = extractMarkers('[笑] 你好呀')
  assert.equal(result.text, '你好呀')
  assert.deepEqual(result.emotions, ['笑'])

  const two = extractMarkers('[笑]你好呀[嘆氣]')
  assert.equal(two.text, '你好呀')
  assert.deepEqual(two.emotions, ['笑', '嘆氣'])
  assert.deepEqual(extractMarkers('').emotions, [])
})

test('extractMarkers leaves unknown brackets in the text', () => {
  const result = extractMarkers('[圖片] 呢張係咩')
  assert.equal(result.text, '[圖片] 呢張係咩')
  assert.deepEqual(result.emotions, [])
})

test('prosodyFor nudges speed up or down but is neutral with no marker', () => {
  assert.ok(prosodyFor(['笑']) > 1)
  assert.ok(prosodyFor(['難過']) < 1)
  assert.equal(prosodyFor([]), 1)
  assert.equal(prosodyFor(), 1)
  // unknown markers contribute nothing
  assert.equal(prosodyFor(['唔存在']), 1)
})

test('gate is closed when voice is disabled', async () => {
  const { voice } = await makeVoice({ voice: { enabled: false } })
  assert.equal(voice.enabled, false)
  assert.equal(voice.gate().code, 'IG_VOICE_DISABLED')
})

test('gate reports IG_VOICE_UNAVAILABLE with neither endpoint nor pack', async () => {
  const { voice } = await makeVoice({ voice: { enabled: true } })
  assert.equal(voice.available, false)
  const gate = voice.gate()
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'IG_VOICE_UNAVAILABLE')
  assert.match(gate.hint, /baseUrl/)
})

test('gate enforces voice.perDay', async () => {
  const { voice } = await makeVoice({ voice: { enabled: true, baseUrl: 'https://tts.example/v1', perDay: 1 } })
  const now = new Date('2026-01-01T12:00:00Z')
  assert.equal(voice.gate(now).ok, true)

  voice.noteSent(now)
  const quota = voice.gate(now)
  assert.equal(quota.ok, false)
  assert.equal(quota.code, 'IG_VOICE_QUOTA')

  // a new day resets the counter
  assert.equal(voice.gate(new Date('2026-01-02T12:00:00Z')).ok, true)
})

test('gate enforces voice.cooldownMinutes', async () => {
  const { voice } = await makeVoice({ voice: { enabled: true, baseUrl: 'https://tts.example/v1', cooldownMinutes: 10 } })
  const sentAt = new Date('2026-01-01T12:00:00Z')
  voice.noteSent(sentAt)

  assert.equal(voice.gate(new Date('2026-01-01T12:05:00Z')).code, 'IG_VOICE_COOLDOWN')
  assert.equal(voice.gate(new Date('2026-01-01T12:10:00Z')).ok, true)
})

test('synthesize returns a verified file and strips the emotion marker', async () => {
  const fetchImpl = fakeFetch(() => response({ body: MP3 }))
  const { voice } = await makeVoice({ voice: { enabled: true, baseUrl: 'https://tts.example/v1', model: 'tts-1', voice: 'alloy' } }, fetchImpl)

  const result = await voice.synthesize('[笑] 你好呀，今日好嗎')
  assert.equal(result.ok, true)
  assert.equal(result.verified, true)
  assert.equal(result.format, 'mp3')
  assert.equal(result.bytes, MP3.length)
  assert.equal(result.text, '你好呀，今日好嗎')
  assert.ok(fs.existsSync(result.path))
  assert.deepEqual(fs.readFileSync(result.path), MP3)

  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].url, 'https://tts.example/v1/audio/speech')
  const body = fetchImpl.calls[0].body
  assert.equal(body.input, '你好呀，今日好嗎')
  assert.ok(!body.input.includes('[笑]'))
  assert.notEqual(body.speed, 1)
  assert.ok(body.speed > 1)
  assert.equal(body.voice, 'alloy')
})

test('synthesize reports an unverified file but still names it', async () => {
  const fetchImpl = fakeFetch(() => response({ body: Buffer.from('<html>oops</html>') }))
  const { voice } = await makeVoice({ voice: { enabled: true, baseUrl: 'https://tts.example/v1' } }, fetchImpl)

  const result = await voice.synthesize('你好呀')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_VOICE_UNVERIFIED')
  // the bytes are kept so a human can look at what the endpoint really returned
  assert.ok(result.path)
  assert.ok(fs.existsSync(result.path))
  assert.deepEqual(fs.readFileSync(result.path), Buffer.from('<html>oops</html>'))
})

test('synthesize maps a non-ok response to IG_VOICE_TTS_FAILED', async () => {
  const fetchImpl = fakeFetch(() => response({ ok: false, status: 500, body: 'upstream exploded' }))
  const { voice } = await makeVoice({ voice: { enabled: true, baseUrl: 'https://tts.example/v1' } }, fetchImpl)

  const result = await voice.synthesize('你好呀')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_VOICE_TTS_FAILED')
  assert.match(result.error, /500/)
  assert.match(result.error, /upstream exploded/)
})

test('synthesize maps a thrown fetch to IG_VOICE_NETWORK', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED')
  }
  const { voice } = await makeVoice({ voice: { enabled: true, baseUrl: 'https://tts.example/v1' } }, fetchImpl)

  const result = await voice.synthesize('你好呀')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_VOICE_NETWORK')
  assert.match(result.error, /ECONNREFUSED/)
})

test('synthesize truncates the spoken text to voice.maxChars', async () => {
  const fetchImpl = fakeFetch(() => response({ body: MP3 }))
  const { voice } = await makeVoice({ voice: { enabled: true, baseUrl: 'https://tts.example/v1', maxChars: 5 } }, fetchImpl)

  const result = await voice.synthesize('你好呀今日好嗎我好好')
  assert.equal(result.ok, true)
  assert.equal(fetchImpl.calls[0].body.input, '你好呀今日')
  assert.equal(fetchImpl.calls[0].body.input.length, 5)
  assert.equal(result.text, '你好呀今日')
})

test('synthesize refuses with no TTS endpoint', async () => {
  // A pack alone makes voice *available*, so `gate()` lets the call through and
  // the TTS-specific refusal is the one that fires: TTS needs voice.baseUrl.
  const packDir = tempDir('ig-life-pack-')
  fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify([{ id: 'c1', text: '喂', emotion: '開心', file: 'a.mp3' }]), 'utf8')
  fs.writeFileSync(path.join(packDir, 'a.mp3'), MP3)

  const { voice } = await makeVoice({ voice: { enabled: true, packDir } })
  await voice.loadPack()
  assert.equal(voice.hasTts, false)
  assert.equal(voice.available, true)

  const result = await voice.synthesize('你好呀')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_VOICE_NO_TTS')
  assert.match(result.hint, /語音包/)

  // with neither endpoint nor pack, the gate refuses first
  const bare = await makeVoice({ voice: { enabled: true } })
  assert.equal((await bare.voice.synthesize('你好呀')).code, 'IG_VOICE_UNAVAILABLE')
})

test('synthesize returns IG_VOICE_EMPTY for a text that is only a marker', async () => {
  const fetchImpl = fakeFetch(() => response({ body: MP3 }))
  const { voice } = await makeVoice({ voice: { enabled: true, baseUrl: 'https://tts.example/v1' } }, fetchImpl)
  const result = await voice.synthesize('[笑]')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_VOICE_EMPTY')
  assert.equal(fetchImpl.calls.length, 0)
})

test('pickPackClip returns the emotion match from a real pack folder', async () => {
  const packDir = tempDir('ig-life-pack-')
  fs.writeFileSync(
    path.join(packDir, 'manifest.json'),
    JSON.stringify({
      clips: [
        { id: 'c1', text: '早晨呀', emotion: '開心', file: 'happy.mp3' },
        { id: 'c2', text: '唔該晒', emotion: '認真', file: 'serious.mp3' },
      ],
    }),
    'utf8',
  )
  fs.writeFileSync(path.join(packDir, 'happy.mp3'), MP3)
  fs.writeFileSync(path.join(packDir, 'serious.mp3'), MP3)

  const { voice } = await makeVoice({ voice: { enabled: true, packDir } })
  // `hasPack` is only true after the manifest is read (index.js does this at boot),
  // so a pack alone must be loaded before `available` / `gate()` can say yes.
  await voice.loadPack()
  assert.equal(voice.available, true)

  const result = await voice.pickPackClip({ emotion: '開心' })
  assert.equal(result.ok, true)
  assert.equal(result.verified, true)
  assert.equal(result.text, '早晨呀')
  assert.equal(result.emotion, '開心')
  assert.equal(result.path, path.join(packDir, 'happy.mp3'))

  // matching on the text alone also works
  const byText = await voice.pickPackClip({ text: '唔該晒' })
  assert.equal(byText.ok, true)
  assert.equal(byText.emotion, '認真')
  assert.equal(voice.listPack().length, 2)
})

test('pickPackClip reports a clip whose file is missing', async () => {
  const packDir = tempDir('ig-life-pack-')
  fs.writeFileSync(
    path.join(packDir, 'manifest.json'),
    JSON.stringify([{ id: 'ghost', text: '喂', emotion: '驚訝', file: 'ghost.mp3' }]),
    'utf8',
  )
  const { voice } = await makeVoice({ voice: { enabled: true, packDir } })
  const result = await voice.pickPackClip({ emotion: '驚訝' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_VOICE_PACK_MISSING')
  assert.match(result.error, /ghost\.mp3/)
})

test('pickPackClip refuses a clip that is too small to be audio', async () => {
  const packDir = tempDir('ig-life-pack-')
  fs.writeFileSync(
    path.join(packDir, 'manifest.json'),
    JSON.stringify({ clips: [{ id: 'tiny', text: '喂', emotion: '撒嬌', file: 'tiny.mp3' }] }),
    'utf8',
  )
  fs.writeFileSync(path.join(packDir, 'tiny.mp3'), Buffer.alloc(100))
  const { voice } = await makeVoice({ voice: { enabled: true, packDir } })
  const result = await voice.pickPackClip({ emotion: '撒嬌' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_VOICE_UNVERIFIED')
})

test('pickPackClip reports IG_VOICE_NO_PACK with no manifest', async () => {
  const { voice } = await makeVoice({ voice: { enabled: true, packDir: tempDir('ig-life-pack-') } })
  const result = await voice.pickPackClip({ emotion: '開心' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_VOICE_NO_PACK')
})

test('stats reports the voice knobs and the daily counter', async () => {
  const { voice } = await makeVoice({ voice: { enabled: true, baseUrl: 'https://tts.example/v1', perDay: 3, maxChars: 40 } })
  voice.noteSent(new Date('2026-01-01T12:00:00Z'))
  const stats = voice.stats()
  assert.equal(stats.enabled, true)
  assert.equal(stats.hasTts, true)
  assert.equal(stats.sentToday, 1)
  assert.equal(stats.perDay, 3)
  assert.equal(stats.maxChars, 40)
  assert.equal(stats.packClips, 0)
})
