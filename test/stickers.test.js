import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { StickerLibrary, sniffImage } from '../lib/stickers.js'
import { makeConfig, makeStore } from './helpers.js'

/** A real 1x1 PNG — the library sniffs magic bytes, so it must be a genuine image. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
/** Same image, one extra trailing byte: different hash, still a PNG. */
const PNG_ALT = Buffer.concat([PNG_1X1, Buffer.from([0x00])])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 0x00)])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10, 0x00)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('WEBP')])
const JUNK = Buffer.from('<!doctype html><html><body>404</body></html>', 'utf8')

async function makeLibrary(overrides = {}) {
  const store = await makeStore()
  const config = makeConfig(overrides)
  const library = await new StickerLibrary({ store, config }).load()
  return { store, config, library }
}

test('sniffImage recognises the four formats it accepts', () => {
  assert.equal(sniffImage(PNG_1X1), 'png')
  assert.equal(sniffImage(JPG), 'jpg')
  assert.equal(sniffImage(GIF), 'gif')
  assert.equal(sniffImage(WEBP), 'webp')
})

test('sniffImage returns null for junk, HTML and short buffers', () => {
  assert.equal(sniffImage(JUNK), null)
  assert.equal(sniffImage(Buffer.from('not an image at all')), null)
  assert.equal(sniffImage(Buffer.alloc(0)), null)
  // anything shorter than 12 bytes cannot be inspected safely
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), null)
  assert.equal(sniffImage(null), null)
})

test('collect rejects a payload that is not an image', async () => {
  const { store, library } = await makeLibrary()
  const result = await library.collect({ buffer: JUNK, emotion: '開心' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_NOT_AN_IMAGE')
  assert.match(result.hint, /jpg/)
  assert.equal(library.size, 0)
  // nothing was written to the stickers folder either
  assert.equal(fs.existsSync(path.join(store.dir, 'stickers')), false)
})

test('collect rejects a payload larger than stickers.maxBytes', async () => {
  const { library } = await makeLibrary({ stickers: { maxBytes: 1024 } })
  const big = Buffer.concat([PNG_1X1, Buffer.alloc(1200, 0x00)])
  assert.ok(big.length > 1024)
  const result = await library.collect({ buffer: big })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_STICKER_TOO_BIG')
  assert.equal(library.size, 0)
})

test('collect stores a real image on disk under <store.dir>/stickers', async () => {
  const { store, library } = await makeLibrary()
  const result = await library.collect({
    buffer: PNG_1X1,
    emotion: '委屈',
    content: '被人鬧到喊',
    keywords: ['喊', '委屈'],
    from: 'owner',
  })
  assert.equal(result.ok, true)
  assert.equal(result.duplicate, false)
  assert.match(result.id, /^s\d+$/)
  assert.equal(library.size, 1)

  const onDisk = path.join(store.dir, 'stickers', `${result.id}.png`)
  assert.equal(result.file, onDisk)
  assert.ok(fs.existsSync(onDisk))
  assert.deepEqual(fs.readFileSync(onDisk), PNG_1X1)
  assert.equal(library.pathOf(result.id), onDisk)

  // and the metadata survives a reload from the store
  const reloaded = await new StickerLibrary({ store, config: library.config }).load()
  assert.equal(reloaded.size, 1)
  assert.equal(reloaded.items[0].emotion, '委屈')
  assert.deepEqual(reloaded.items[0].keywords, ['喊', '委屈'])
})

test('collecting identical bytes twice does not grow the library', async () => {
  const { library } = await makeLibrary()
  const first = await library.collect({ buffer: PNG_1X1, emotion: '開心' })
  const second = await library.collect({ buffer: PNG_1X1, emotion: '委屈' })
  assert.equal(second.ok, true)
  assert.equal(second.duplicate, true)
  assert.equal(second.id, first.id)
  assert.equal(library.size, 1)
  // the first annotation wins; a duplicate never overwrites it
  assert.equal(library.items[0].emotion, '開心')
})

test('collect respects stickers.maxItems', async () => {
  const { library } = await makeLibrary({ stickers: { maxItems: 1 } })
  assert.equal((await library.collect({ buffer: PNG_1X1 })).ok, true)
  const full = await library.collect({ buffer: PNG_ALT })
  assert.equal(full.ok, false)
  assert.equal(full.code, 'IG_STICKER_LIBRARY_FULL')
  assert.equal(library.size, 1)
})

test('annotate fills in emotion, content and keywords', async () => {
  const { library } = await makeLibrary()
  const { id } = await library.collect({ buffer: PNG_1X1 })
  assert.equal(library.items[0].emotion, '')

  const result = await library.annotate(id, { emotion: '委屈', content: '喊到眼腫', keywords: '喊, 委屈' })
  assert.equal(result.ok, true)
  assert.equal(result.item.emotion, '委屈')
  assert.equal(result.item.content, '喊到眼腫')
  assert.deepEqual(result.item.keywords, ['喊', '委屈'])

  // an emotion outside the known list is ignored rather than stored
  await library.annotate(id, { emotion: '亂寫嘅情緒' })
  assert.equal(library.items[0].emotion, '委屈')
})

test('annotate on an unknown id reports IG_STICKER_NOT_FOUND', async () => {
  const { library } = await makeLibrary()
  const result = await library.annotate('s99', { emotion: '開心' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_STICKER_NOT_FOUND')
})

test('search ranks by meaning and scores a number', async () => {
  const { library } = await makeLibrary()
  const sad = await library.collect({ buffer: PNG_1X1, emotion: '委屈', content: '被人鬧到喊，好委屈', keywords: ['喊', '委屈'] })
  const funny = await library.collect({ buffer: PNG_ALT, emotion: '開心', content: '笑到肚痛', keywords: ['笑', '開心'] })

  const hits = library.search('委屈')
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].id, sad.id)
  assert.equal(typeof hits[0].score, 'number')
  assert.ok(hits[0].score > 0)
  assert.ok(fs.existsSync(hits[0].path))
  // the 笑 sticker has nothing to do with 委屈
  assert.ok(!hits.some((hit) => hit.id === funny.id))
})

test('search pushes down a sticker used within the last three hours', async () => {
  const { library } = await makeLibrary()
  const older = await library.collect({ buffer: PNG_1X1, emotion: '委屈', content: '被人鬧到喊', keywords: ['喊'] })
  const justUsed = await library.collect({ buffer: PNG_ALT, emotion: '委屈', content: '我唔想講嘢，好委屈', keywords: ['唔想講'] })

  // before any use, both 委屈 stickers are candidates
  const before = library.search('委屈', { excludeRecent: false })
  assert.equal(before.length, 2)
  const scoreOf = (hits, id) => hits.find((hit) => hit.id === id)?.score

  await library.markUsed(justUsed.id)
  const after = library.search('委屈')
  assert.equal(after[0].id, older.id, 'the freshly used sticker must not come first again')
  // the penalty is large enough to drop it below the 0.02 cut-off entirely
  assert.equal(scoreOf(after, justUsed.id), undefined)
  assert.ok(scoreOf(before, justUsed.id) > 0.02)

  // ...but it is only a *recency* penalty: four hours later it is back
  library.items.find((item) => item.id === justUsed.id).lastUsedAt = new Date(Date.now() - 4 * 3_600_000).toISOString()
  const later = library.search('委屈', { excludeRecent: false })
  assert.ok(later.some((hit) => hit.id === justUsed.id))
})

test('search respects limit', async () => {
  const { library } = await makeLibrary()
  await library.collect({ buffer: PNG_1X1, emotion: '委屈', content: '被人鬧到喊' })
  await library.collect({ buffer: PNG_ALT, emotion: '委屈', content: '我唔想講嘢，好委屈' })
  assert.equal(library.search('委屈').length, 2)
  assert.equal(library.search('委屈', { limit: 1 }).length, 1)
  assert.deepEqual(library.search('委屈', { limit: 0 }), [])
  assert.deepEqual(library.search('完全無關嘅字'), [])
})

test('markUsed counts uses and stamps lastUsedAt', async () => {
  const { library } = await makeLibrary()
  const { id } = await library.collect({ buffer: PNG_1X1, emotion: '開心' })
  assert.equal(library.items[0].uses, 0)
  assert.equal(library.items[0].lastUsedAt, null)

  await library.markUsed(id)
  await library.markUsed(id)
  assert.equal(library.items[0].uses, 2)
  assert.ok(!Number.isNaN(Date.parse(library.items[0].lastUsedAt)))
  assert.equal(library.listing()[0].uses, 2)

  // unknown id is a no-op, not a throw
  await library.markUsed('s99')
})

test('remove deletes the file from disk', async () => {
  const { library } = await makeLibrary()
  const { id, file } = await library.collect({ buffer: PNG_1X1 })
  assert.ok(fs.existsSync(file))

  assert.equal(await library.remove(id), true)
  assert.equal(fs.existsSync(file), false)
  assert.equal(library.size, 0)
  assert.equal(library.pathOf(id), null)
  assert.equal(await library.remove(id), false)
})

test('stats counts by emotion with 未分類 for unannotated stickers', async () => {
  const { store, library } = await makeLibrary()
  await library.collect({ buffer: PNG_1X1, emotion: '開心' })
  await library.collect({ buffer: PNG_ALT, emotion: '開心' })
  await library.collect({ buffer: JPG })
  // '亂寫' is not a known emotion, so it lands in 未分類 as well
  await library.collect({ buffer: GIF, emotion: '亂寫' })

  const stats = library.stats()
  assert.equal(stats.total, 4)
  assert.equal(stats.byEmotion['開心'], 2)
  assert.equal(stats.byEmotion['未分類'], 2)
  assert.equal(stats.dir, path.join(store.dir, 'stickers'))
})
