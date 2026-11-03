import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { JsonStore, pluginDataDir } from '../lib/store.js'
import { makeStore, tempDir } from './helpers.js'

test('write and read round-trip a document', async () => {
  const store = await makeStore()
  await store.write('a.json', { hello: '世界', list: [1, 2, 3] })
  const back = await store.read('a.json', null)
  assert.deepEqual(back, { hello: '世界', list: [1, 2, 3] })
  // no temp file left behind
  assert.deepEqual(fs.readdirSync(store.dir).filter((name) => name.includes('.tmp')), [])
  assert.ok(fs.existsSync(path.join(store.dir, 'a.json')))
})

test('read returns the fallback for a missing document', async () => {
  const store = await makeStore()
  assert.deepEqual(await store.read('nope.json', { ok: false }), { ok: false })
})

test('a corrupt document is quarantined, not silently destroyed', async () => {
  const dir = tempDir()
  const store = new JsonStore(dir)
  await store.init()
  fs.writeFileSync(path.join(dir, 'memory.json'), '{ this is not json', 'utf8')
  const value = await store.read('memory.json', { memories: [] })
  assert.deepEqual(value, { memories: [] })
  const quarantined = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'))
  assert.equal(quarantined.length, 1)
})

test('concurrent writes are serialised and the last one wins', async () => {
  const store = await makeStore()
  await Promise.all([store.write('race.json', { n: 1 }), store.write('race.json', { n: 2 }), store.write('race.json', { n: 3 })])
  store.forget('race.json')
  assert.deepEqual(await store.read('race.json', null), { n: 3 })
})

test('jsonl append and readLines keep the tail', async () => {
  const store = await makeStore()
  for (let i = 0; i < 5; i += 1) await store.append('outbox.jsonl', { i })
  const tail = await store.readLines('outbox.jsonl', 2)
  assert.deepEqual(tail, [{ i: 3 }, { i: 4 }])
  assert.ok((await store.size('outbox.jsonl')) > 0)
  assert.deepEqual(await store.readLines('missing.jsonl', 5), [])
})

test('pluginDataDir respects config, DSH_HOME and the home default', () => {
  const explicit = tempDir()
  assert.equal(pluginDataDir(explicit), path.resolve(explicit))

  const previous = process.env.DSH_HOME
  try {
    // platform-agnostic: a Windows-looking literal is NOT a valid path on POSIX
    const fakeHome = path.resolve(tempDir(), 'dsh-home')
    process.env.DSH_HOME = fakeHome
    assert.equal(pluginDataDir(''), path.join(fakeHome, 'ig-life'))
    delete process.env.DSH_HOME
    assert.match(pluginDataDir(''), /ig-life$/)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
